// The API. Each operation is a plain function; REST routes and MCP tools both call these.
import { ApiError, bad, SOL, decodeOne, decodeMany, programInfo, search, jupQuote, jupSwap, toRaw, fromRaw } from './sol.js';
import { POWERS, POWER_BITS, isMint } from '../lib/ext.js';

const int = (v, d, lo, hi, name) => { if (v == null || v === '') return d; const n = Number(v); if (!Number.isInteger(n) || n < lo || n > hi) throw bad(name + ' must be ' + lo + ' to ' + hi); return n; };
const mintOf = (v, name) => { if (!isMint(v)) throw bad(name + ' must be a base58 address'); return v; };
const NATIVE = { mint: SOL, symbol: 'SOL', name: 'Solana', decimals: 9 };

export function makeApi(store, cfg) {
  // market data for a mint: the index if it is there, otherwise Jupiter's search
  async function marketOf(mint) { if (mint === SOL) return NATIVE; const hit = store.getToken(mint); if (hit) return hit; const found = (await search(mint).catch(() => [])).find((t) => t.mint === mint); if (found) store.upsert([found]); return found ? { ...found, marketCap: found.mcap } : null; }
  async function token(mint) {
    const d = await decodeOne(mint); if (!d.exists) throw new ApiError(404, 'not_found', 'No account at ' + mint); if (!d.isMint) throw new ApiError(404, 'not_found', mint + ' is not a token mint');
    const m = await marketOf(mint).catch(() => null); if (store.getToken(mint)) store.saveDecoded(d);
    return { mint, symbol: (m && m.symbol) || (d.details.metadata && d.details.metadata.symbol) || null, name: (m && m.name) || (d.details.metadata && d.details.metadata.name) || null, icon: (m && m.icon) || null, program: d.program, decimals: d.decimals, supply: fromRaw(d.supply, d.decimals),
      marketCap: m ? m.marketCap || 0 : null, liquidity: m ? m.liquidity || 0 : null, holders: m ? m.holders || 0 : null, verified: m ? !!m.verified : false, createdAt: m ? m.createdAt || m.created || null : null,
      flags: d.flags, flagsHex: d.flagsHex, powers: d.powers, extensions: d.extensions, details: d.details, capabilities: d.capabilities, risk: d.risk, explorer: 'https://solscan.io/token/' + mint };
  }
  const api = {
    powers: async () => ({ powers: POWERS.map((p, i) => ({ key: p.key, bit: i, value: 1 << i, level: p.level, label: p.label, note: p.note, extension: p.ext })) }),
    stats: async () => ({ chain: 'Solana', index: store.census(), sync: { lists: store.sync.lists, decodeRounds: store.sync.decodes, error: store.sync.error } }),
    census: async () => store.census(),
    decodeToken: async (i) => token(mintOf(i.mint, 'mint')),
    listTokens: async (i) => { let power = null; if (i.power) { power = String(i.power).split(',').map((s) => s.trim()).filter(Boolean); for (const k of power) if (!(k in POWER_BITS)) throw bad('unknown power: ' + k + '. One of ' + Object.keys(POWER_BITS).join(', ')); }
      if (i.hook && !isMint(i.hook)) throw bad('hook must be a program address');
      return store.listTokens({ power, hook: i.hook, program: i.program, verified: i.verified === true || i.verified === 'true', q: i.q ? String(i.q).slice(0, 44) : null, sort: i.sort, limit: int(i.limit, 25, 1, 100, 'limit'), offset: int(i.offset, 0, 0, 1e7, 'offset') }); },
    listHooks: async (i) => store.hookPrograms({ limit: int(i.limit, 25, 1, 100, 'limit'), offset: int(i.offset, 0, 0, 1e6, 'offset') }),
    inspectHook: async (i) => { const program = mintOf(i.program, 'program'), info = await programInfo(program), using = store.listTokens({ hook: program, sort: 'mcap', limit: 25, offset: 0 }), warnings = [];
      if (!info.deployed) warnings.push('No program at this address'); else if (!info.executable) warnings.push('This account is not an executable program');
      if (info.upgradeable) warnings.push('Upgradeable: ' + info.upgradeAuthority + ' can replace this program, and with it the rules of every transfer');
      return { program, ...info, warnings, tokens: { total: using.total, top: using.tokens }, explorer: 'https://solscan.io/account/' + program }; },
    // one call before buying: what the token can do to you, who controls its hook, and what a real quote says
    checkToken: async (i) => { const t = await token(mintOf(i.mint, 'mint')), reasons = [...t.risk.reasons]; let level = t.risk.level, hook = null, quoteCheck = null;
      if (t.details.transferHook) { hook = await programInfo(t.details.transferHook.programId).catch(() => null); if (hook && hook.upgradeable) reasons.push('The transfer hook program is upgradeable: its rules can change after you buy'); if (hook && !hook.deployed) reasons.push('The transfer hook program does not exist: transfers will fail'); }
      if (i.amount != null && i.amount !== '') { try { const q = await api.quote({ inputMint: SOL, outputMint: t.mint, amount: i.amount }); quoteCheck = { amountIn: q.amountIn + ' SOL', amountOut: q.amountOut, priceImpactPct: q.priceImpactPct, route: q.route };
          if (q.priceImpactPct > 5) { reasons.push('Buying this size moves the price by ' + q.priceImpactPct + '%'); if (level === 'low') level = 'medium'; } }
        catch (e) { if (!(e instanceof ApiError)) throw e; quoteCheck = { error: e.message }; reasons.push('No route to buy this token right now'); if (level === 'low') level = 'medium'; } }
      return { mint: t.mint, symbol: t.symbol, name: t.name, program: t.program, powers: t.powers, details: t.details, hookProgram: hook, quoteCheck, risk: { level, reasons }, note: 'Read from the mint account, the hook program and a live quote. It describes what the token is able to do, not what its issuer will do.' }; },
    quote: async (i) => { const inputMint = mintOf(i.inputMint, 'inputMint'), outputMint = mintOf(i.outputMint, 'outputMint'); if (inputMint === outputMint) throw bad('inputMint and outputMint must differ'); if (i.amount == null) throw bad('amount is required');
      const need = [inputMint, outputMint].filter((m) => m !== SOL), dec = need.length ? await decodeMany(need) : new Map(), d = (m) => (m === SOL ? { decimals: 9, powers: [], capabilities: [] } : dec.get(m));
      for (const m of need) if (!d(m).isMint) throw new ApiError(404, 'not_found', m + ' is not a token mint');
      const raw = toRaw(i.amount, d(inputMint).decimals), slip = int(i.slippageBps, 50, 1, 5000, 'slippageBps'), q = await jupQuote(inputMint, outputMint, raw, slip);
      const warn = (m) => d(m).capabilities.filter((c) => c.level !== 'info').map((c) => c.label + ': ' + c.note);
      return { inputMint, outputMint, amountIn: fromRaw(q.inAmount, d(inputMint).decimals), amountOut: fromRaw(q.outAmount, d(outputMint).decimals), minimumOut: fromRaw(q.otherAmountThreshold, d(outputMint).decimals), slippageBps: slip, priceImpactPct: Number((Number(q.priceImpactPct) * 100).toFixed(4)),
        route: (q.routePlan || []).map((r) => r.swapInfo.label), warnings: { input: warn(inputMint), output: warn(outputMint) }, _quote: q }; },
    buildSwap: async (i) => { const user = mintOf(i.user, 'user'), q = await api.quote(i), s = await jupSwap(q._quote, user); if (!s.swapTransaction) throw new ApiError(422, 'no_route', s.error || 'Jupiter could not build this swap');
      const { _quote, ...rest } = q; return { ...rest, user, transaction: s.swapTransaction, encoding: 'base64', lastValidBlockHeight: s.lastValidBlockHeight, note: 'Unsigned versioned transaction, routed by Jupiter. Sign and send it from `user`; ' + cfg.name + ' never holds keys or funds.' }; },
  };
  const pub = { ...api, quote: async (i) => { const { _quote, ...rest } = await api.quote(i); return rest; } };
  return pub;
}
