// Solana transactions by hand: base58, program-derived addresses, the legacy message format,
// and the handful of System / Token-2022 / Associated-Token instructions a launch needs. No dependencies.
import { createHash } from 'node:crypto';

export const SYSTEM = '11111111111111111111111111111111', TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';

// ---- base58 ----
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz', B58I = Object.fromEntries([...B58].map((c, i) => [c, BigInt(i)]));
export function b58enc(bytes) { let n = 0n; for (const b of bytes) n = (n << 8n) | BigInt(b); let s = ''; while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; } for (const b of bytes) { if (b === 0) s = '1' + s; else break; } return s; }
export function b58dec(str) { let n = 0n; for (const c of str) { const v = B58I[c]; if (v === undefined) throw new Error('not base58'); n = n * 58n + v; } const out = []; while (n > 0n) { out.unshift(Number(n & 255n)); n >>= 8n; } for (const c of str) { if (c === '1') out.unshift(0); else break; } return Uint8Array.from(out); }
// a 32-byte public key, or throw
export function key(address) { let b; try { b = b58dec(address); } catch { b = null; } if (!b || b.length !== 32) throw new Error('not a 32-byte address: ' + address); return b; }
export const isKey = (s) => { try { key(s); return true; } catch { return false; } };

// ---- is a 32-byte string a point on ed25519? (program-derived addresses must not be) ----
const P = 2n ** 255n - 19n, mod = (a) => ((a % P) + P) % P;
const pow = (b, e) => { let r = 1n; b = mod(b); while (e > 0n) { if (e & 1n) r = (r * b) % P; b = (b * b) % P; e >>= 1n; } return r; };
const D = mod(-121665n * pow(121666n, P - 2n));
export function onCurve(bytes) { let y = 0n; for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(i === 31 ? bytes[i] & 127 : bytes[i]); if (y >= P) return false;
  const y2 = (y * y) % P, u = mod(y2 - 1n), v = mod(D * y2 + 1n), x = (u * pow(v, 3n) % P) * pow(u * pow(v, 7n), (P - 5n) / 8n) % P, vx2 = (v * x % P) * x % P;
  return vx2 === u || vx2 === mod(-u); }
export function findPda(seeds, programId) { const pid = key(programId);
  for (let bump = 255; bump >= 0; bump--) { const h = createHash('sha256'); for (const s of seeds) h.update(s); h.update(Uint8Array.of(bump)); h.update(pid); h.update('ProgramDerivedAddress'); const d = h.digest(); if (!onCurve(d)) return { address: b58enc(d), bump }; }
  throw new Error('no program address'); }
export const ataOf = (owner, mint, tokenProgram = TOKEN_2022) => findPda([key(owner), key(tokenProgram), key(mint)], ATA_PROGRAM).address;

// ---- bytes ----
const cat = (...parts) => { const n = parts.reduce((s, p) => s + p.length, 0), out = new Uint8Array(n); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
const u8 = (...v) => Uint8Array.from(v), u16 = (v) => u8(v & 255, (v >> 8) & 255), u32 = (v) => u8(v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255);
const u64 = (v) => { let n = BigInt(v); const o = new Uint8Array(8); for (let i = 0; i < 8; i++) { o[i] = Number(n & 255n); n >>= 8n; } return o; };
const short = (n) => { const o = []; for (;;) { const b = n & 127; n >>= 7; if (n) o.push(b | 128); else { o.push(b); break; } } return Uint8Array.from(o); };
const opt = (address) => (address ? cat(u8(1), key(address)) : u8(0));            // COption<Pubkey> as the token program packs it
const orZero = (address) => (address ? key(address) : new Uint8Array(32));        // OptionalNonZeroPubkey
const str = (s) => { const b = new TextEncoder().encode(s); return cat(u32(b.length), b); };
const disc = (name) => createHash('sha256').update(name).digest().subarray(0, 8);
export const U64_MAX = (1n << 64n) - 1n;

// ---- instructions: { program, keys: [{ address, signer, writable }], data } ----
const w = (address, signer = false) => ({ address, signer, writable: true }), r = (address, signer = false) => ({ address, signer, writable: false });
const t22 = (keys, ...data) => ({ program: TOKEN_2022, keys, data: cat(...data) });
const BUDGET = 'ComputeBudget111111111111111111111111111111';
export const ix = {
  computeLimit: (units) => ({ program: BUDGET, keys: [], data: cat(u8(2), u32(units)) }),
  computePrice: (microLamports) => ({ program: BUDGET, keys: [], data: cat(u8(3), u64(microLamports)) }),
  createAccount: (payer, account, lamports, space, owner) => ({ program: SYSTEM, keys: [w(payer, true), w(account, true)], data: cat(u32(0), u64(lamports), u64(space), key(owner)) }),
  transferSol: (from, to, lamports) => ({ program: SYSTEM, keys: [w(from, true), w(to)], data: cat(u32(2), u64(lamports)) }),
  initTransferFee: (mint, configAuthority, withdrawAuthority, bps, maxFee) => t22([w(mint)], u8(26, 0), opt(configAuthority), opt(withdrawAuthority), u16(bps), u64(maxFee)),
  initTransferHook: (mint, authority, hookProgram) => t22([w(mint)], u8(36, 0), orZero(authority), orZero(hookProgram)),
  initMetadataPointer: (mint, authority, metadata) => t22([w(mint)], u8(39, 0), orZero(authority), orZero(metadata)),
  initMint: (mint, decimals, mintAuthority, freezeAuthority) => t22([w(mint)], u8(20, decimals), key(mintAuthority), opt(freezeAuthority)),
  // the metadata lives in the mint itself; handing the update authority to nobody makes it permanent
  initMetadata: (mint, updateAuthority, mintAuthority, name, symbol, uri) => t22([w(mint), r(updateAuthority), r(mint), r(mintAuthority, true)], disc('spl_token_metadata_interface:initialize_account'), str(name), str(symbol), str(uri)),
  setMetadataAuthority: (mint, current, next) => t22([w(mint), r(current, true)], disc('spl_token_metadata_interface:update_the_authority'), orZero(next)),
  createAta: (payer, ata, owner, mint) => ({ program: ATA_PROGRAM, keys: [w(payer, true), w(ata), r(owner), r(mint), r(SYSTEM), r(TOKEN_2022)], data: u8(1) }),
  mintTo: (mint, to, authority, amount) => t22([w(mint), w(to), r(authority, true)], u8(7), u64(amount)),
  // 0 mint tokens, 1 freeze, 4 transfer-fee config, 5 withheld withdraw
  setAuthority: (account, current, type, next) => t22([w(account), r(current, true)], u8(6, type), opt(next)),
  withdrawWithheldFromMint: (mint, to, authority) => t22([w(mint), w(to), r(authority, true)], u8(26, 2)),
  withdrawWithheldFromAccounts: (mint, to, authority, sources) => t22([r(mint), w(to), r(authority, true), ...sources.map((s) => w(s))], u8(26, 3, sources.length)),
};

// sizes inside a Token-2022 mint: 165 bytes of base + 1 account-type byte, then type(2) + length(2) + data per extension
export const EXT_LEN = { transferFee: 108, transferHook: 64, metadataPointer: 64 };
export const mintSpace = (exts) => 166 + exts.reduce((s, e) => s + 4 + EXT_LEN[e], 0);
export const metadataSpace = (name, symbol, uri) => { const n = (s) => new TextEncoder().encode(s).length; return 4 + 32 + 32 + 4 + n(name) + 4 + n(symbol) + 4 + n(uri) + 4; };
export const rentFor = (bytes) => BigInt(bytes + 128) * 6960n;                     // two years of rent at 3,480 lamports per byte-year

// ---- a legacy transaction with empty signatures: signers first (payer leads), writable before read-only ----
export function buildTx(payer, blockhash, instructions) {
  const m = new Map(), add = (address, signer, writable) => { const e = m.get(address) || { address, signer: false, writable: false }; e.signer ||= signer; e.writable ||= writable; m.set(address, e); };
  add(payer, true, true); for (const i of instructions) { for (const k of i.keys) add(k.address, k.signer, k.writable); add(i.program, false, false); }
  const rank = (e) => (e.address === payer ? -1 : (e.signer ? 0 : 2) + (e.writable ? 0 : 1)), accts = [...m.values()].sort((a, b) => rank(a) - rank(b)), idx = new Map(accts.map((e, i) => [e.address, i]));
  const signers = accts.filter((e) => e.signer), header = u8(signers.length, signers.filter((e) => !e.writable).length, accts.filter((e) => !e.signer && !e.writable).length);
  const message = cat(header, short(accts.length), ...accts.map((e) => key(e.address)), key(blockhash), short(instructions.length),
    ...instructions.map((i) => cat(u8(idx.get(i.program)), short(i.keys.length), Uint8Array.from(i.keys.map((k) => idx.get(k.address))), short(i.data.length), i.data)));
  const tx = cat(short(signers.length), new Uint8Array(64 * signers.length), message);
  return { transaction: Buffer.from(tx).toString('base64'), message: Buffer.from(message).toString('base64'), signers: signers.map((e) => e.address), size: tx.length };
}
