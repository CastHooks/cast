// The launchpad: one transaction that creates a Token-2022 mint with its extensions, its on-chain metadata and its whole supply.
// Built unsigned, simulated against the chain, and labelled with exactly what the decoder will say about it once it exists.
import { ApiError, bad, rpc, decodeOne, programInfo, toRaw, fromRaw } from './sol.js';
import { ix, buildTx, isKey, ataOf, mintSpace, metadataSpace, rentFor, b58enc, U64_MAX, TOKEN_2022 } from './tx.js';
import { decodeMint } from '../lib/ext.js';
import { verify, createPublicKey } from 'node:crypto';
const SPKI = Buffer.from('302a300506032b6570032100', 'hex');   // the DER wrapper node wants around a raw ed25519 public key

const MAX_FEE_BPS = 1000, PRIORITY = Number(process.env.PRIORITY_MICROLAMPORTS || 50000);
export const PRESETS = [
  { key: 'clean', label: 'Clean', note: 'Fixed supply, no fee, no hook, nobody can freeze. Decodes as low risk.', config: { feeBps: 0, lockFee: true, keepMintAuthority: false, freezeAuthority: false } },
  { key: 'fee', label: 'Creator fee', note: '1% of every transfer is withheld for you, and the rate is locked so it can never be raised.', config: { feeBps: 100, lockFee: true, keepMintAuthority: false, freezeAuthority: false } },
  { key: 'hooked', label: 'Hooked', note: 'Your own transfer-hook program runs inside every transfer. Bring the program address.', config: { feeBps: 0, lockFee: true, lockHook: true, keepMintAuthority: false, freezeAuthority: false, needsHook: true } },
];
const addr = (v, name) => { if (typeof v !== 'string' || !isKey(v)) throw bad(name + ' must be a base58 address'); return v; };
const text = (v, name, max, need) => { const s = v == null ? '' : String(v).trim(); if (need && !s) throw bad(name + ' is required'); if (new TextEncoder().encode(s).length > max) throw bad(name + ' is longer than ' + max + ' bytes'); return s; };
const url = (v, name) => { const s = text(v, name, 200); if (s && !/^(https:\/\/|ipfs:\/\/|ar:\/\/)\S+$/.test(s)) throw bad(name + ' must start with https://, ipfs:// or ar://'); return s; };
const flag = (v, d) => (v == null || v === '' ? d : v === true || v === 'true' || v === 1 || v === '1');
const int = (v, d, lo, hi, name) => { if (v == null || v === '') return d; const n = Number(v); if (!Number.isInteger(n) || n < lo || n > hi) throw bad(name + ' must be ' + lo + ' to ' + hi); return n; };
const upstream = (e) => (e instanceof ApiError ? e : new ApiError(e.rpc ? 422 : 502, e.rpc ? 'rpc_rejected' : 'upstream_error', e.message || 'Solana RPC did not answer'));
const SIM_ERR = { AccountNotFound: 'The wallet has no SOL: it does not exist on chain yet.', InsufficientFundsForRent: 'The wallet does not hold enough SOL to pay the rent.', InsufficientFundsForFee: 'The wallet does not hold enough SOL for the network fee.' };

async function simulate(transaction, watch) {
  const res = await rpc('simulateTransaction', [transaction, { sigVerify: false, replaceRecentBlockhash: true, encoding: 'base64', commitment: 'confirmed', accounts: { encoding: 'jsonParsed', addresses: watch } }]), v = res.value;
  if (!v.err) return { ok: true, unitsConsumed: v.unitsConsumed, accounts: v.accounts };
  const logs = v.logs || [], custom = logs.find((l) => /insufficient lamports/.test(l)), name = typeof v.err === 'string' ? v.err : JSON.stringify(v.err);
  return { ok: false, error: custom ? 'The wallet does not hold enough SOL for this.' : SIM_ERR[name] || 'The chain rejected this transaction: ' + name, logs: logs.slice(-6) };
}

// token accounts of a mint that showed up in its latest transactions: where freshly withheld fees sit.
// Used when the endpoint will not list the largest holders.
async function recentAccounts(mint) { const sigs = (await rpc('getSignaturesForAddress', [mint, { limit: 12, commitment: 'confirmed' }])).filter((s) => !s.err).slice(0, 8), out = new Set();
  const txs = await Promise.all(sigs.map((s) => rpc('getTransaction', [s.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]).catch(() => null)));
  for (const t of txs) { if (!t || !t.meta) continue; const keys = t.transaction.message.accountKeys.map((k) => k.pubkey || k); for (const b of t.meta.postTokenBalances || []) if (b.mint === mint && keys[b.accountIndex]) out.add(keys[b.accountIndex]); }
  return [...out].slice(0, 20); }

export function makeLaunch(store, cfg) {
  const L = store.launches;
  const api = {
    launchOptions: async () => ({ program: 'token-2022', programId: TOKEN_2022, presets: PRESETS, limits: { feeBps: [0, MAX_FEE_BPS], decimals: [0, 9], nameBytes: 32, symbolBytes: 10, uriBytes: 200 },
      extensions: ['transferFeeConfig', 'transferHook', 'metadataPointer', 'tokenMetadata'], cost: { note: 'Rent for the mint and your token account, about 0.007 SOL, plus the network fee. ' + cfg.name + ' takes no launch fee.' } }),

    // inputs: creator, mint (a fresh public key the caller holds the secret for), name, symbol, and the rules
    buildLaunch: async (i) => {
      const creator = addr(i.creator, 'creator'), mint = addr(i.mint, 'mint'); if (creator === mint) throw bad('mint must be a fresh key, not the creator wallet');
      const name = text(i.name, 'name', 32, true), symbol = text(i.symbol, 'symbol', 10, true), decimals = int(i.decimals, 6, 0, 9, 'decimals');
      const supplyStr = String(i.supply == null || i.supply === '' ? '1000000000' : i.supply).replace(/[,_\s]/g, ''); if (!/^\d+$/.test(supplyStr) || /^0+$/.test(supplyStr)) throw bad('supply must be a whole number of tokens'); const raw = BigInt(supplyStr) * 10n ** BigInt(decimals); if (raw > U64_MAX) throw bad('supply times 10^decimals does not fit in 64 bits: lower the supply or the decimals');
      const feeBps = int(i.feeBps, 0, 0, MAX_FEE_BPS, 'feeBps'), lockFee = flag(i.lockFee, true), keepMint = flag(i.keepMintAuthority, false), freeze = flag(i.freezeAuthority, false), lockMeta = flag(i.lockMetadata, false), lockHook = flag(i.lockHook, true);
      const maxFee = i.maxFee == null || i.maxFee === '' ? U64_MAX : toRaw(i.maxFee, decimals), hook = i.hookProgram ? addr(i.hookProgram, 'hookProgram') : null, hasFee = feeBps > 0 || !lockFee;
      const warnings = []; let hookInfo = null;
      if (hook) { if (hook === TOKEN_2022) throw bad('hookProgram cannot be the token program'); hookInfo = await programInfo(hook).catch((e) => { throw upstream(e); });
        if (!hookInfo.deployed || !hookInfo.executable) throw new ApiError(422, 'bad_hook', 'No executable program at ' + hook + '. Deploy the hook program first.');
        if (hookInfo.upgradeable) warnings.push('The hook program is upgradeable by ' + hookInfo.upgradeAuthority + ': whoever holds that key can change the rules of every transfer.');
        warnings.push('The hook program must have its extra-account list initialised for this mint, or transfers will fail. Run its initialise instruction after launch.'); }
      // metadata: the caller's own link, or a JSON document served by this node
      const description = text(i.description, 'description', 600), image = url(i.image, 'image'), website = url(i.website, 'website'), x = url(i.x, 'x'); let uri = url(i.uri, 'uri'), metadata = null;
      if (!uri) { const origin = cfg.site || i._origin; if (!origin) throw bad('uri is required: a link to the token metadata JSON'); uri = origin + '/v1/launch/meta/' + mint; metadata = { name, symbol, description, image, external_url: website || undefined, extensions: x ? { twitter: x } : undefined };
        if (/\/\/(localhost|127\.|\[::1\])/.test(origin)) warnings.push('The metadata link points at this local node (' + origin + '). Set SITE_URL or pass your own uri before launching for real.'); }
      if (new TextEncoder().encode(uri).length > 200) throw bad('uri is longer than 200 bytes');
      if (keepMint) warnings.push('You keep the mint authority: the decoder will flag that supply can still grow.'); if (freeze) warnings.push('You keep a freeze authority: the decoder will flag that holders can be frozen.');
      if (hasFee && !lockFee) warnings.push('The fee rate stays changeable by your wallet, and the decoder will say so.');

      const exts = ['metadataPointer']; if (hasFee) exts.push('transferFee'); if (hook) exts.push('transferHook');
      const space = mintSpace(exts), lamports = rentFor(space + metadataSpace(name, symbol, uri)), ata = ataOf(creator, mint);
      const list = [ix.computeLimit(140000), ix.computePrice(PRIORITY), ix.createAccount(creator, mint, lamports, space, TOKEN_2022), ix.initMetadataPointer(mint, null, mint)];
      if (hasFee) list.push(ix.initTransferFee(mint, lockFee ? null : creator, creator, feeBps, maxFee));
      if (hook) list.push(ix.initTransferHook(mint, lockHook ? null : creator, hook));
      list.push(ix.initMint(mint, decimals, creator, freeze ? creator : null), ix.initMetadata(mint, creator, creator, name, symbol, uri)); if (lockMeta) list.push(ix.setMetadataAuthority(mint, creator, null));
      list.push(ix.createAta(creator, ata, creator, mint), ix.mintTo(mint, ata, creator, raw)); if (!keepMint) list.push(ix.setAuthority(mint, creator, 0, null));

      let blockhash; try { blockhash = (await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }])).value; } catch (e) { throw upstream(e); }
      const tx = buildTx(creator, blockhash.blockhash, list); if (tx.size > 1232) throw bad('This launch does not fit in one transaction: shorten the name, symbol or uri');
      // what the chain would do with it right now, and what the mint would look like afterwards
      let simulation, preview, cost = null;
      try { const before = (await rpc('getBalance', [creator, { commitment: 'confirmed' }])).value, s = await simulate(tx.transaction, [mint, creator]);
        if (s.ok) { simulation = { ok: true, unitsConsumed: s.unitsConsumed }; preview = decodeMint(mint, s.accounts[0]); const after = s.accounts[1] ? s.accounts[1].lamports : null; if (after != null && before > after) cost = fromRaw(before - after, 9); }
        else simulation = s; } catch (e) { simulation = { ok: false, error: 'Could not simulate: ' + (e.message || 'RPC error') }; }
      if (!preview) preview = decodeMint(mint, { owner: TOKEN_2022, data: { parsed: { type: 'mint', info: { decimals, supply: String(raw), mintAuthority: keepMint ? creator : null, freezeAuthority: freeze ? creator : null, extensions: [
        ...(hasFee ? [{ extension: 'transferFeeConfig', state: { transferFeeConfigAuthority: lockFee ? null : creator, withdrawWithheldAuthority: creator, newerTransferFee: { transferFeeBasisPoints: feeBps, maximumFee: String(maxFee) }, olderTransferFee: { transferFeeBasisPoints: feeBps } } }] : []),
        ...(hook ? [{ extension: 'transferHook', state: { programId: hook, authority: lockHook ? null : creator } }] : []), { extension: 'tokenMetadata', state: { name, symbol, uri, updateAuthority: lockMeta ? null : creator } }] } } } });
      const config = { feeBps, lockFee, maxFee: maxFee === U64_MAX ? null : fromRaw(maxFee, decimals), hookProgram: hook, lockHook: hook ? lockHook : undefined, keepMintAuthority: keepMint, freezeAuthority: freeze, lockMetadata: lockMeta, uri };
      L.save({ mint, creator, name, symbol, decimals, supply: supplyStr, config, metadata }); L.prune();
      return { mint, creator, tokenAccount: ata, name, symbol, decimals, supply: supplyStr, config, transaction: tx.transaction, encoding: 'base64', signers: tx.signers, bytes: tx.size, lastValidBlockHeight: blockhash.lastValidBlockHeight,
        rent: { mint: fromRaw(lamports, 9) + ' SOL', total: cost ? cost + ' SOL' : null }, simulation, preview: { powers: preview.powers, capabilities: preview.capabilities, risk: preview.risk, extensions: preview.extensions || exts }, hookProgram: hookInfo, warnings,
        note: 'Unsigned legacy transaction. Two signatures are needed: the creator wallet (fee payer) and the mint key. Have the wallet sign first, then the mint key, then POST it to /v1/launch/send. ' + cfg.name + ' never holds either key.' };
    },

    // relay a fully signed launch to the chain. Only transactions for a mint built here are accepted.
    sendLaunch: async (i) => { const mint = addr(i.mint, 'mint'), l = L.get(mint); if (!l) throw new ApiError(404, 'not_found', 'No launch was built for ' + mint); if (typeof i.transaction !== 'string' || !/^[A-Za-z0-9+/=]{200,2000}$/.test(i.transaction)) throw bad('transaction must be the signed transaction in base64');
      const raw = Buffer.from(i.transaction, 'base64'), n = raw[0]; if (n !== 2 || raw.length > 1232) throw bad('expected a launch transaction with two signatures');
      const body = raw.subarray(1 + 64 * n), k = body[0] & 128 ? 5 : 4;   // a versioned message carries one extra prefix byte before the header
      if (b58enc(body.subarray(k, k + 32)) !== l.creator || b58enc(body.subarray(k + 32, k + 64)) !== mint) throw bad('this transaction is not the launch built for ' + mint);
      if (raw.subarray(1, 65).every((b) => b === 0) || raw.subarray(65, 129).every((b) => b === 0)) throw bad('the transaction is missing a signature: the wallet and the mint key must both sign');
      const signedBy = (at, who) => verify(null, body, createPublicKey({ key: Buffer.concat([SPKI, body.subarray(who, who + 32)]), format: 'der', type: 'spki' }), raw.subarray(at, at + 64));
      if (!signedBy(1, k)) throw bad('the wallet signature does not match this transaction'); if (!signedBy(65, k + 32)) throw bad('the mint key signature does not match this transaction');
      let signature; try { signature = await rpc('sendTransaction', [i.transaction, { encoding: 'base64', preflightCommitment: 'confirmed', maxRetries: 5 }]); } catch (e) { throw upstream(e); }
      L.sent(mint, signature); return { mint, signature, explorer: 'https://solscan.io/tx/' + signature, next: '/v1/launch/' + mint }; },

    // one launch: read back from the chain. The first read that finds the mint marks it live and adds it to the index.
    getLaunch: async (i) => { const mint = addr(i.mint, 'mint'), l = L.get(mint); if (!l) throw new ApiError(404, 'not_found', mint + ' was not launched here');
      let d = null, status = l.signature ? 'sent' : 'built'; try { d = await decodeOne(mint); } catch (e) { throw upstream(e); }
      if (d.exists && d.isMint) { status = 'live'; if (!l.live) { L.live(mint); store.upsert([{ mint, symbol: l.symbol, name: l.name, icon: (l.metadata && l.metadata.image) || null, program: TOKEN_2022, decimals: l.decimals, mcap: 0, liquidity: 0, volume24h: 0, holders: 0, verified: 0, price: 0, created: new Date().toISOString(), launchpad: cfg.name.toLowerCase() }]); } store.saveDecoded(d); }
      // sent but not there yet: ask the chain what became of the signature
      if (status === 'sent') { const st = await rpc('getSignatureStatuses', [[l.signature], { searchTransactionHistory: true }]).then((r) => r.value[0], () => undefined); if (st && st.err) status = 'failed'; else if (st === null && Date.now() - l.builtAt > 150e3) status = 'expired'; }
      const { metadata, ...rest } = L.get(mint); return { ...rest, status, powers: d.exists ? d.powers : null, risk: d.exists && d.isMint ? d.risk : null, details: d.exists ? d.details : null, explorer: 'https://solscan.io/token/' + mint, explorerTx: l.signature ? 'https://solscan.io/tx/' + l.signature : null }; },
    listLaunches: async (i) => { const r = L.list({ creator: i.creator ? addr(i.creator, 'creator') : null, limit: int(i.limit, 25, 1, 100, 'limit'), offset: int(i.offset, 0, 0, 1e6, 'offset') });
      return { ...r, launches: r.launches.map(({ metadata, ...l }) => { const t = store.getToken(l.mint); return { ...l, icon: (metadata && metadata.image) || null, powers: t ? t.powers : [], risk: t ? t.risk : null }; }) }; },
    launchMeta: async (i) => { const l = L.get(addr(i.mint, 'mint')); if (!l || !l.metadata) throw new ApiError(404, 'not_found', 'No metadata is hosted for this mint'); return l.metadata; },

    // transfer fees withheld for the creator: what sits on the mint and on the largest holders' accounts
    fees: async (i) => { const mint = addr(i.mint, 'mint'); let acct; try { acct = (await rpc('getAccountInfo', [mint, { encoding: 'jsonParsed', commitment: 'confirmed' }])).value; } catch (e) { throw upstream(e); }
      const info = acct && acct.owner === TOKEN_2022 && acct.data.parsed && acct.data.parsed.type === 'mint' ? acct.data.parsed.info : null, fee = info && (info.extensions || []).find((e) => e.extension === 'transferFeeConfig');
      if (!fee) throw new ApiError(404, 'not_found', mint + ' has no transfer fee'); const st = fee.state, onMint = BigInt(st.withheldAmount || 0), sources = []; let scanned = 0, scanError = null;
      const given = (Array.isArray(i.accounts) ? i.accounts : String(i.accounts || '').split(',')).map((s) => String(s).trim()).filter(Boolean).slice(0, 20).map((a) => addr(a, 'accounts'));
      let how = given.length ? 'named' : 'largest';
      try { const top = given.length ? given : await rpc('getTokenLargestAccounts', [mint, { commitment: 'confirmed' }], true).then((r) => r.value.map((a) => a.address), () => { how = 'recent'; return recentAccounts(mint); }), got = top.length ? (await rpc('getMultipleAccounts', [top, { encoding: 'jsonParsed', commitment: 'confirmed' }])).value : []; scanned = top.length;
        got.forEach((a, k) => { const e = a && a.owner === TOKEN_2022 && a.data.parsed && a.data.parsed.type === 'account' && a.data.parsed.info.mint === mint && (a.data.parsed.info.extensions || []).find((x) => x.extension === 'transferFeeAmount'), amt = e ? BigInt(e.state.withheldAmount || 0) : 0n; if (amt > 0n) sources.push({ account: top[k], withheld: amt }); }); } catch (e) { scanError = e.message || 'RPC error'; }
      const total = sources.reduce((s, a) => s + a.withheld, onMint);
      return { mint, decimals: info.decimals, feeBps: Number(st.newerTransferFee.transferFeeBasisPoints), withdrawAuthority: st.withdrawWithheldAuthority || null, withheld: { total: fromRaw(total, info.decimals), onMint: fromRaw(onMint, info.decimals), onAccounts: sources.map((a) => ({ account: a.account, amount: fromRaw(a.withheld, info.decimals) })) },
        scanned: { accounts: scanned, note: scanError ? 'Holder accounts could not be scanned (' + scanError + '): only the mint was read. Pass `accounts` to name token accounts yourself, or set RPC_URL to a dedicated endpoint.' : how === 'named' ? 'The ' + scanned + ' token accounts you named were read.' : how === 'recent' ? 'The ' + scanned + ' token accounts that received this token in its latest transfers were read. Pass `accounts` to name others.' : 'The ' + scanned + ' largest token accounts were scanned. Fees on smaller accounts are moved to the mint when anyone harvests them.' }, _sources: sources.map((a) => a.account) }; },
    buildClaim: async (i) => { const f = await api.fees(i), authority = addr(i.authority, 'authority'); if (!f.withdrawAuthority) throw new ApiError(422, 'no_authority', 'Nobody can withdraw the fees of this token: its withdraw authority was removed.');
      if (f.withdrawAuthority !== authority) throw new ApiError(403, 'not_authority', 'Only ' + f.withdrawAuthority + ' can withdraw these fees'); if (Number(f.withheld.total) === 0) throw new ApiError(422, 'nothing_to_claim', 'No fees are withheld yet');
      const to = ataOf(authority, f.mint), src = f._sources.slice(0, 20), list = [ix.computeLimit(200000), ix.computePrice(PRIORITY), ix.createAta(authority, to, authority, f.mint)]; if (src.length) list.push(ix.withdrawWithheldFromAccounts(f.mint, to, authority, src)); if (Number(f.withheld.onMint) > 0) list.push(ix.withdrawWithheldFromMint(f.mint, to, authority));
      let blockhash, simulation; try { blockhash = (await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }])).value; } catch (e) { throw upstream(e); } const tx = buildTx(authority, blockhash.blockhash, list);
      try { const s = await simulate(tx.transaction, [to]); simulation = s.ok ? { ok: true, unitsConsumed: s.unitsConsumed } : s; } catch (e) { simulation = { ok: false, error: 'Could not simulate: ' + (e.message || 'RPC error') }; }
      const { _sources, ...rest } = f; return { ...rest, authority, tokenAccount: to, transaction: tx.transaction, encoding: 'base64', lastValidBlockHeight: blockhash.lastValidBlockHeight, simulation, note: 'Unsigned legacy transaction. Sign and send it from the withdraw authority; the fees land in its own token account.' }; },
  };
  return { ...api, fees: async (i) => { const { _sources, ...rest } = await api.fees(i); return rest; } };
}
