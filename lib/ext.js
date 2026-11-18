// Solana token extensions: what a token's mint is allowed to do to the people who hold it.
// Pure functions over the mint account as the RPC returns it (jsonParsed). The node and the browser import this file.

export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const NONE = new Set([null, undefined, '', '11111111111111111111111111111111']);
const set = (v) => !NONE.has(v);

// one bit per power, most significant first. `ext` is the extension's name in the RPC's parsed output (null for the two classic authorities)
export const POWERS = [
  { key: 'permanentDelegate', ext: 'permanentDelegate', level: 'warning', label: 'Permanent delegate', note: "One address can move or burn any holder's tokens at any time, without their signature." },
  { key: 'transferHook', ext: 'transferHook', level: 'warning', label: 'Transfer hook', note: 'A program runs inside every transfer and can reject it: allow-lists, royalties, trading rules.' },
  { key: 'nonTransferable', ext: 'nonTransferable', level: 'warning', label: 'Non-transferable', note: 'Holders cannot send this token to anyone. It can only be burned.' },
  { key: 'frozenByDefault', ext: 'defaultAccountState', level: 'warning', label: 'Frozen by default', note: 'Every new token account starts frozen. The issuer has to unfreeze you before you can move anything.' },
  { key: 'pausable', ext: 'pausableConfig', level: 'warning', label: 'Pausable', note: 'An authority can pause every transfer, mint and burn of this token at once.' },
  { key: 'transferFee', ext: 'transferFeeConfig', level: 'caution', label: 'Transfer fee', note: 'A share of every transfer is withheld for the fee authority.' },
  { key: 'freezeAuthority', ext: null, level: 'caution', label: 'Freeze authority', note: "An address can freeze any holder's account, which blocks selling." },
  { key: 'mintAuthority', ext: null, level: 'caution', label: 'Mint authority', note: 'An address can create more supply.' },
  { key: 'confidential', ext: 'confidentialTransferMint', level: 'info', label: 'Confidential transfers', note: 'Balances and amounts can be encrypted. An auditor key may be able to read them.' },
  { key: 'interestBearing', ext: 'interestBearingConfig', level: 'info', label: 'Interest-bearing', note: 'The displayed balance grows at a rate an authority sets. The raw amount does not change.' },
  { key: 'scaledUi', ext: 'scaledUiAmountConfig', level: 'info', label: 'Scaled balance', note: 'The displayed balance is the raw amount times a multiplier an authority can update.' },
  { key: 'closeAuthority', ext: 'mintCloseAuthority', level: 'info', label: 'Mint close authority', note: 'The mint account can be closed once supply is zero.' },
  { key: 'metadata', ext: 'tokenMetadata', level: 'info', label: 'On-chain metadata', note: 'Name, symbol and link are stored in the mint. An update authority may be able to change them.' },
  { key: 'group', ext: 'tokenGroup', level: 'info', label: 'Token group', note: 'This mint is a group that other mints can belong to.' },
  { key: 'groupMember', ext: 'tokenGroupMember', level: 'info', label: 'Group member', note: 'This mint belongs to a token group.' },
];
export const POWER_BITS = Object.fromEntries(POWERS.map((p, i) => [p.key, 1 << i]));
export const HIGH = ['permanentDelegate', 'transferHook', 'nonTransferable', 'frozenByDefault', 'pausable'];
export const MEDIUM = ['transferFee', 'freezeAuthority', 'mintAuthority'];

export const isMint = (s) => typeof s === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
export const short = (a, n = 4) => (a ? a.slice(0, n) + '…' + a.slice(-n) : '');

// account: { owner, data: { parsed: { type: 'mint', info } } } from getAccountInfo / getMultipleAccounts with jsonParsed
export function decodeMint(address, account) {
  if (!account) return { address, exists: false, flags: 0, powers: [], capabilities: [], risk: { level: 'unknown', reasons: ['No account at this address'] } };
  const parsed = account.data && account.data.parsed, info = parsed && parsed.type === 'mint' ? parsed.info : null;
  if (!info || (account.owner !== TOKEN_PROGRAM && account.owner !== TOKEN_2022)) return { address, exists: true, isMint: false, program: account.owner, flags: 0, powers: [], capabilities: [], risk: { level: 'unknown', reasons: ['This account is not a token mint'] } };
  const ext = Object.fromEntries((info.extensions || []).map((e) => [e.extension, e.state || {}])), on = {}, detail = {};

  if (ext.permanentDelegate && set(ext.permanentDelegate.delegate)) { on.permanentDelegate = true; detail.permanentDelegate = { delegate: ext.permanentDelegate.delegate }; }
  if (ext.transferHook && set(ext.transferHook.programId)) { on.transferHook = true; detail.transferHook = { programId: ext.transferHook.programId, authority: set(ext.transferHook.authority) ? ext.transferHook.authority : null }; }
  else if (ext.transferHook && set(ext.transferHook.authority)) detail.transferHookSlot = { authority: ext.transferHook.authority, note: 'No hook program is set, but this authority can attach one later.' };
  if (ext.nonTransferable) on.nonTransferable = true;
  if (ext.defaultAccountState && ext.defaultAccountState.accountState === 'frozen') on.frozenByDefault = true;
  if (ext.pausableConfig && (set(ext.pausableConfig.authority) || ext.pausableConfig.paused)) { on.pausable = true; detail.pausable = { authority: ext.pausableConfig.authority || null, paused: !!ext.pausableConfig.paused }; }
  if (ext.transferFeeConfig) { const n = ext.transferFeeConfig.newerTransferFee || {}, o = ext.transferFeeConfig.olderTransferFee || {}, bps = Math.max(Number(n.transferFeeBasisPoints) || 0, 0), canChange = set(ext.transferFeeConfig.transferFeeConfigAuthority);
    if (bps > 0 || canChange) { on.transferFee = true; detail.transferFee = { bps, percent: bps / 100, maximumFee: n.maximumFee != null ? String(n.maximumFee) : null, previousBps: Number(o.transferFeeBasisPoints) || 0, canChange, authority: canChange ? ext.transferFeeConfig.transferFeeConfigAuthority : null, withdrawAuthority: set(ext.transferFeeConfig.withdrawWithheldAuthority) ? ext.transferFeeConfig.withdrawWithheldAuthority : null }; } }
  if (set(info.freezeAuthority)) { on.freezeAuthority = true; detail.freezeAuthority = { authority: info.freezeAuthority }; }
  if (set(info.mintAuthority)) { on.mintAuthority = true; detail.mintAuthority = { authority: info.mintAuthority }; }
  if (ext.confidentialTransferMint) { on.confidential = true; detail.confidential = { auditor: set(ext.confidentialTransferMint.auditorElgamalPubkey) }; }
  if (ext.interestBearingConfig) { on.interestBearing = true; detail.interestBearing = { rateBps: Number(ext.interestBearingConfig.currentRate) || 0 }; }
  if (ext.scaledUiAmountConfig) { on.scaledUi = true; detail.scaledUi = { multiplier: ext.scaledUiAmountConfig.multiplier, authority: set(ext.scaledUiAmountConfig.authority) ? ext.scaledUiAmountConfig.authority : null }; }
  if (ext.mintCloseAuthority && set(ext.mintCloseAuthority.closeAuthority)) on.closeAuthority = true;
  if (ext.tokenMetadata) { on.metadata = true; detail.metadata = { name: ext.tokenMetadata.name, symbol: ext.tokenMetadata.symbol, uri: ext.tokenMetadata.uri, updateAuthority: set(ext.tokenMetadata.updateAuthority) ? ext.tokenMetadata.updateAuthority : null }; }
  if (ext.tokenGroup) on.group = true;
  if (ext.tokenGroupMember) on.groupMember = true;

  const flags = POWERS.reduce((f, p) => f | (on[p.key] ? POWER_BITS[p.key] : 0), 0), d = describe(flags, detail);
  return { address, exists: true, isMint: true, program: account.owner === TOKEN_2022 ? 'token-2022' : 'spl-token', decimals: info.decimals, supply: String(info.supply), flags, flagsHex: '0x' + flags.toString(16).padStart(4, '0'),
    powers: d.powers, extensions: (info.extensions || []).map((e) => e.extension), details: detail, capabilities: d.capabilities, risk: d.risk };
}

// names, notes and a risk level from the bitmask alone (so a stored token can be described without the chain)
export function describe(flags, detail = {}) {
  const powers = POWERS.filter((p) => flags & POWER_BITS[p.key]).map((p) => p.key);
  const capabilities = POWERS.filter((p) => flags & POWER_BITS[p.key]).map((p) => { let note = p.note;
    if (p.key === 'transferFee' && detail.transferFee) note = detail.transferFee.bps > 0 ? detail.transferFee.percent + '% of every transfer is withheld.' + (detail.transferFee.canChange ? ' An authority can change the rate.' : ' The rate can no longer be changed.') : 'The transfer fee is 0% today, but an authority can raise it.';
    if (p.key === 'pausable' && detail.pausable && detail.pausable.paused) note = 'This token is paused right now: nothing can be transferred.';
    return { level: p.level, power: p.key, label: p.label, note }; });
  const high = powers.filter((k) => HIGH.includes(k)), medium = powers.filter((k) => MEDIUM.includes(k));
  const label = (k) => POWERS.find((p) => p.key === k).label;
  return { powers, capabilities, risk: { level: high.length ? 'high' : medium.length ? 'medium' : 'low', reasons: [...high, ...medium].map((k) => capabilities.find((c) => c.power === k).note.replace(/^/, label(k) + ': ')) } };
}
export const flagsFor = (keys) => keys.reduce((f, k) => { if (!(k in POWER_BITS)) throw new Error('unknown power: ' + k); return f | POWER_BITS[k]; }, 0);
