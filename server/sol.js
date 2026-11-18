// Everything that talks to the outside: the Solana RPC (mint accounts, programs) and Jupiter (token lists, quotes, swaps).
import { decodeMint, isMint } from '../lib/ext.js';

export class ApiError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }
export const bad = (m) => new ApiError(400, 'bad_request', m);
export const SOL = 'So11111111111111111111111111111111111111112';
const RPC_URL = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com', JUP = (process.env.JUPITER_URL || 'https://lite-api.jup.ag').replace(/\/$/, '');
const sleep = (ms) => new Promise((z) => setTimeout(z, ms));

// at most three calls in flight, a short pause between them, and a back-off when the endpoint says slow down
let active = 0, cool = 0, id = 0; const waiting = [];
const slot = () => new Promise((go) => { const run = () => { active++; go(); }; active < 3 ? run() : waiting.push(run); });
const done = () => { active--; const n = waiting.shift(); if (n) setTimeout(n, 60); };
// `once` is for methods the public endpoint rations per method (it answers 429 whatever the pace): one attempt, and no back-off for everyone else
export async function rpc(method, params = [], once = false) {
  await slot();
  try {
    for (let k = 0; ; k++) {
      if (cool > Date.now()) await sleep(cool - Date.now());
      try { const r = await fetch(RPC_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }), signal: AbortSignal.timeout(25000) });
        if (r.status === 429) { if (!once) cool = Date.now() + Math.min(10000, 800 * 2 ** k); throw new Error('the RPC endpoint is rate-limiting this method'); }
        const j = await r.json(); if (j.error) { const e = new Error(j.error.message || 'rpc error'); e.rpc = true; throw e; } return j.result; }
      catch (e) { if (e.rpc || once || k >= 5) throw e; await sleep(400 * (k + 1)); }
    }
  } finally { done(); }
}
// up to 100 mint accounts per call, parsed by the node; returns Map address -> decoded
export async function decodeMany(addresses) {
  const out = new Map();
  for (let i = 0; i < addresses.length; i += 100) { const part = addresses.slice(i, i + 100), res = await rpc('getMultipleAccounts', [part, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
    part.forEach((a, k) => out.set(a, decodeMint(a, res.value[k]))); }
  return out;
}
export async function decodeOne(address) { if (!isMint(address)) throw bad('mint must be a base58 address'); const r = await rpc('getAccountInfo', [address, { encoding: 'jsonParsed', commitment: 'confirmed' }]); return decodeMint(address, r.value); }

// a transfer-hook program: is it there, and can its code still be replaced?
const BPF_UPGRADEABLE = 'BPFLoaderUpgradeab1e11111111111111111111111', progCache = new Map();
export async function programInfo(programId) {
  if (!isMint(programId)) throw bad('program must be a base58 address');
  const hit = progCache.get(programId); if (hit && Date.now() - hit.at < 10 * 60e3) return hit.v;
  const a = (await rpc('getAccountInfo', [programId, { encoding: 'jsonParsed' }])).value; let v;
  if (!a) v = { address: programId, deployed: false, executable: false, upgradeable: false, upgradeAuthority: null };
  else { v = { address: programId, deployed: true, executable: !!a.executable, loader: a.owner, upgradeable: false, upgradeAuthority: null };
    const pd = a.owner === BPF_UPGRADEABLE && a.data && a.data.parsed && a.data.parsed.info ? a.data.parsed.info.programData : null;
    if (pd) { const d = (await rpc('getAccountInfo', [pd, { encoding: 'jsonParsed' }])).value, info = d && d.data && d.data.parsed ? d.data.parsed.info : null;
      if (info) { v.upgradeAuthority = info.authority || null; v.upgradeable = !!info.authority; v.lastDeployedSlot = info.slot; } } }
  progCache.set(programId, { at: Date.now(), v }); return v;
}

// ---- Jupiter (keyless) ----
async function jup(path, init) {
  for (let k = 0; ; k++) { const r = await fetch(JUP + path, { ...init, signal: AbortSignal.timeout(25000) });
    if (r.status === 429 && k < 4) { await sleep(1500 * (k + 1)); continue; }
    const t = await r.text(); let j; try { j = JSON.parse(t); } catch { throw new ApiError(502, 'upstream_error', 'Jupiter did not answer (' + r.status + ')'); }
    if (!r.ok) throw new ApiError(r.status === 400 ? 422 : 502, r.status === 400 ? 'no_route' : 'upstream_error', (j && (j.error || j.message)) || 'Jupiter refused the request'); return j; }
}
const market = (t) => ({ mint: t.id, symbol: t.symbol || null, name: t.name || null, icon: t.icon || null, decimals: t.decimals, program: t.tokenProgram, mcap: t.mcap || 0, liquidity: t.liquidity || 0, holders: t.holderCount || 0, verified: t.isVerified || (t.tags || []).includes('verified') ? 1 : 0, price: t.usdPrice || 0,
  volume24h: t.stats24h ? (t.stats24h.buyVolume || 0) + (t.stats24h.sellVolume || 0) : 0, created: t.createdAt || (t.firstPool && t.firstPool.createdAt) || null, launchpad: t.launchpad || null });
export const lists = { verified: async () => (await jup('/tokens/v2/tag?query=verified')).map(market), top: async () => (await jup('/tokens/v2/toptraded/24h?limit=100')).map(market), trending: async () => (await jup('/tokens/v2/toptrending/24h?limit=100')).map(market), recent: async () => (await jup('/tokens/v2/recent')).map(market) };
export const search = async (q) => (await jup('/tokens/v2/search?query=' + encodeURIComponent(q))).map(market);
export const jupQuote = (inputMint, outputMint, raw, slippageBps) => jup('/swap/v1/quote?' + new URLSearchParams({ inputMint, outputMint, amount: String(raw), slippageBps: String(slippageBps), restrictIntermediateTokens: 'true' }));
export const jupSwap = (quoteResponse, userPublicKey) => jup('/swap/v1/swap', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ quoteResponse, userPublicKey, dynamicComputeUnitLimit: true, wrapAndUnwrapSol: true }) });

export function toRaw(amount, decimals) { const s = String(amount).trim(); if (!/^\d+(\.\d+)?$/.test(s)) throw bad('amount must be a decimal string like "0.5"'); const [i, f = ''] = s.split('.'); if (f.length > decimals) throw bad('amount has more than ' + decimals + ' decimal places'); const v = BigInt(i) * 10n ** BigInt(decimals) + BigInt((f + '0'.repeat(decimals)).slice(0, decimals) || '0'); if (v <= 0n) throw bad('amount must be greater than zero'); return v; }
export function fromRaw(v, decimals) { const n = BigInt(v), b = 10n ** BigInt(decimals), f = (n % b).toString().padStart(decimals, '0').replace(/0+$/, ''); return (n / b) + (f ? '.' + f : ''); }
