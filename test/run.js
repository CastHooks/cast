// Checks for CAST. Pure decoder tests first, then the live API if a node is running (BASE=http://localhost:8298).
import { generateKeyPairSync, sign } from 'node:crypto';
import { decodeMint, describe, POWERS, POWER_BITS, TOKEN_2022, TOKEN_PROGRAM, isMint, flagsFor } from '../lib/ext.js';
import { b58enc, b58dec, isKey, onCurve, ataOf, buildTx, ix, mintSpace, rentFor, SYSTEM, U64_MAX } from '../server/tx.js';
let pass = 0, fail = 0; const ok = (n, c, x = '') => { c ? (pass++, console.log('  ok  ' + n)) : (fail++, console.log('FAIL  ' + n + '  ' + x)); };
const mint = (info, owner = TOKEN_2022) => ({ owner, data: { parsed: { type: 'mint', info: { decimals: 6, supply: '1000000', mintAuthority: null, freezeAuthority: null, ...info } } } });
const A = 'AxJkHRY3puoofyj7Pn512M1SGBgWroXMkEdNPQypkzbu', NONE = '11111111111111111111111111111111';

console.log('\ndecoder (pure)');
let d = decodeMint('m', mint({}));
ok('a plain mint holds no powers and is low risk', d.flags === 0 && d.risk.level === 'low' && d.powers.length === 0 && d.program === 'token-2022');
d = decodeMint('m', mint({ mintAuthority: A, freezeAuthority: A }, TOKEN_PROGRAM));
ok('classic authorities are medium risk', d.powers.join() === 'freezeAuthority,mintAuthority' && d.risk.level === 'medium' && d.program === 'spl-token');
d = decodeMint('m', mint({ extensions: [{ extension: 'transferHook', state: { programId: A, authority: A } }] }));
ok('an active transfer hook is high risk and names its program', d.powers.includes('transferHook') && d.risk.level === 'high' && d.details.transferHook.programId === A);
d = decodeMint('m', mint({ extensions: [{ extension: 'transferHook', state: { programId: null, authority: A } }] }));
ok('an empty hook slot is reported but is not a power', !d.powers.includes('transferHook') && d.details.transferHookSlot.authority === A && d.risk.level === 'low');
d = decodeMint('m', mint({ extensions: [{ extension: 'transferFeeConfig', state: { transferFeeConfigAuthority: NONE, withdrawWithheldAuthority: A, newerTransferFee: { transferFeeBasisPoints: 250, maximumFee: 1000 }, olderTransferFee: { transferFeeBasisPoints: 100 } } }] }));
ok('a fixed 2.5% transfer fee', d.details.transferFee.bps === 250 && d.details.transferFee.canChange === false && /2\.5% of every transfer/.test(d.capabilities[0].note) && d.risk.level === 'medium');
d = decodeMint('m', mint({ extensions: [{ extension: 'transferFeeConfig', state: { transferFeeConfigAuthority: NONE, newerTransferFee: { transferFeeBasisPoints: 0 } } }] }));
ok('a 0% fee nobody can change is not a power', d.flags === 0);
d = decodeMint('m', mint({ extensions: [{ extension: 'permanentDelegate', state: { delegate: A } }, { extension: 'defaultAccountState', state: { accountState: 'frozen' } }, { extension: 'pausableConfig', state: { authority: A, paused: true } }, { extension: 'nonTransferable' }] }));
ok('delegate, frozen-by-default, pausable and non-transferable are all high', ['permanentDelegate', 'nonTransferable', 'frozenByDefault', 'pausable'].every((k) => d.powers.includes(k)) && d.risk.level === 'high' && d.risk.reasons.length === 4);
ok('a paused token says so', d.capabilities.find((c) => c.power === 'pausable').note.includes('paused right now'));
d = decodeMint('m', mint({ extensions: [{ extension: 'defaultAccountState', state: { accountState: 'initialized' } }, { extension: 'permanentDelegate', state: { delegate: NONE } }] }));
ok('unset extensions are not powers', d.flags === 0);
ok('missing and non-mint accounts', decodeMint('m', null).exists === false && decodeMint('m', { owner: A, data: ['', 'base64'] }).isMint === false);
ok('describe() rebuilds the same notes from the bitmask', describe(flagsFor(['transferHook', 'mintAuthority'])).risk.level === 'high' && describe(0).risk.level === 'low' && POWERS.length === 15 && POWER_BITS.permanentDelegate === 1);
ok('address shape check', isMint('So11111111111111111111111111111111111111112') && !isMint('0xabc') && !isMint(''));

console.log('\ntransactions (pure)');
const RICH = '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9', USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', pair = () => { const k = generateKeyPairSync('ed25519'); return { secret: k.privateKey, address: b58enc(k.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)) }; };
ok('base58 round-trips, leading zeros included', b58enc(b58dec(SYSTEM)) === SYSTEM && b58dec(SYSTEM).length === 32 && b58enc(b58dec(RICH)) === RICH && isKey(RICH) && !isKey('abc') && !isKey('0OIl'));
ok('public keys are on the curve, program addresses are not', onCurve(b58dec(pair().address)) && !onCurve(b58dec(ataOf(RICH, USDC_MINT, TOKEN_PROGRAM))));
ok('associated token address matches the chain', ataOf(RICH, USDC_MINT, TOKEN_PROGRAM) === 'FzbcyEZ9m8xjtergWgWDq7mfPoHEbboBF791B6cTpzbq');
ok('mint size grows by each extension', mintSpace([]) === 166 && mintSpace(['metadataPointer']) === 234 && mintSpace(['metadataPointer', 'transferFee', 'transferHook']) === 414 && rentFor(515) === 4475280n);
{ const m = pair().address, t = buildTx(RICH, SYSTEM, [ix.createAccount(RICH, m, 1n, 82, TOKEN_2022), ix.initMint(m, 6, RICH, null)]), raw = Buffer.from(t.transaction, 'base64'), msg = raw.subarray(129);
  ok('a transaction lists the payer first, then the other signer, with empty signatures', raw[0] === 2 && raw.subarray(1, 129).every((b) => b === 0) && msg[0] === 2 && msg[1] === 0 && msg[2] === 2 && msg[3] === 4 && b58enc(msg.subarray(4, 36)) === RICH && b58enc(msg.subarray(36, 68)) === m && t.signers.join() === RICH + ',' + m && t.size === raw.length, JSON.stringify([...msg.subarray(0, 4)])); }
ok('instruction data is packed the way the token program reads it', ix.initTransferFee(RICH, null, RICH, 100, U64_MAX).data.length === 2 + 1 + 33 + 2 + 8 && ix.initMint(RICH, 9, RICH, null).data.length === 35 && ix.setAuthority(RICH, RICH, 0, null).data.join() === '6,0,0' && ix.mintTo(RICH, RICH, RICH, 258n).data.join() === '7,2,1,0,0,0,0,0,0');

const BASE = process.env.BASE;
if (BASE) {
  console.log('\nlive api');
  const get = async (p) => { const r = await fetch(BASE + p); return { status: r.status, j: await r.json() }; }, post = async (p, b) => { const r = await fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }); return { status: r.status, j: r.status === 202 ? null : await r.json() }; };
  const PYUSD = '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo', SOL = 'So11111111111111111111111111111111111111112', USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  let r = await get('/v1/tokens/' + PYUSD); ok('PYUSD decodes from the chain', r.status === 200 && r.j.program === 'token-2022' && r.j.powers.includes('permanentDelegate') && r.j.risk.level === 'high' && r.j.decimals === 6, JSON.stringify(r.j).slice(0, 200));
  r = await get('/v1/tokens/' + USDC); ok('USDC is a classic token with freeze and mint authorities', r.j.program === 'spl-token' && r.j.powers.join() === 'freezeAuthority,mintAuthority' && r.j.risk.level === 'medium', JSON.stringify(r.j.powers));
  r = await get('/v1/tokens/TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'); ok('a non-mint address is 404', r.status === 404, JSON.stringify(r.j).slice(0, 120));
  r = await get('/v1/census'); ok('census counts tokens per power', r.j.decoded > 100 && r.j.byPower.freezeAuthority.tokens > 0 && r.j.token2022 > 0, JSON.stringify(r.j).slice(0, 160));
  r = await get('/v1/tokens?power=permanentDelegate&limit=5'); ok('filter by power', r.j.tokens.length > 0 && r.j.tokens.every((t) => t.powers.includes('permanentDelegate') && t.risk === 'high'));
  r = await get('/v1/tokens?power=nope'); ok('unknown power is 400', r.status === 400);
  r = await get('/v1/hooks'); ok('hook programs are listed', Array.isArray(r.j.programs));
  if (r.j.programs[0]) { const p = r.j.programs[0].program; r = await get('/v1/hooks/' + p); ok('a hook program reports upgradeability and its tokens', r.j.deployed === true && typeof r.j.upgradeable === 'boolean' && r.j.tokens.total > 0, JSON.stringify(r.j).slice(0, 200)); }
  r = await get('/v1/quote?inputMint=' + SOL + '&outputMint=' + PYUSD + '&amount=0.1'); ok('quote carries the output token warnings', r.status === 200 && Number(r.j.amountOut) > 0 && r.j.warnings.output.length > 0 && !('_quote' in r.j), JSON.stringify(r.j).slice(0, 220));
  r = await post('/v1/swap/build', { inputMint: SOL, outputMint: USDC, amount: '0.01', user: 'AxJkHRY3puoofyj7Pn512M1SGBgWroXMkEdNPQypkzbu' }); ok('swap build returns an unsigned base64 transaction', r.status === 200 && typeof r.j.transaction === 'string' && r.j.transaction.length > 200 && r.j.encoding === 'base64', JSON.stringify(r.j).slice(0, 200));
  r = await get('/v1/tokens/' + PYUSD + '/check?amount=0.1'); ok('token check gives a level, reasons and a quote', r.j.risk.level === 'high' && r.j.risk.reasons.length > 0 && r.j.quoteCheck && r.j.quoteCheck.amountOut, JSON.stringify(r.j.risk));
  r = await post('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' }); ok('thirteen MCP tools, none of which signs or sends', r.j.result.tools.length === 13 && r.j.result.tools.every((t) => t.annotations.readOnlyHint) && r.j.result.tools.some((t) => t.name === 'build_launch'));

  console.log('\nlaunchpad');
  r = await get('/v1/launch/options'); ok('three presets and the limits', r.j.presets.length === 3 && r.j.limits.feeBps[1] === 1000 && r.j.programId === TOKEN_2022);
  const m1 = pair(); r = await post('/v1/launch/build', { creator: RICH, mint: m1.address, name: 'Cast Test', symbol: 'CTEST', feeBps: 100, description: 'a test', image: 'https://example.com/logo.png' });
  ok('a fee launch builds, passes the chain check and prices its rent', r.status === 200 && r.j.simulation.ok === true && r.j.signers.join() === RICH + ',' + m1.address && r.j.bytes <= 1232 && Number(r.j.rent.total.split(' ')[0]) > 0.004 && r.j.tokenAccount === ataOf(RICH, m1.address), JSON.stringify(r.j).slice(0, 300));
  ok('the label is read from the mint the chain would create', r.j.preview.risk.level === 'medium' && r.j.preview.powers.join() === 'transferFee,metadata' && /1% of every transfer/.test(r.j.preview.risk.reasons[0]) && r.j.preview.extensions.includes('transferFeeConfig'), JSON.stringify(r.j.preview));
  const feeTx = r.j.transaction; r = await get('/v1/launch/meta/' + m1.address); ok('metadata is hosted for the mint', r.j.name === 'Cast Test' && r.j.symbol === 'CTEST' && r.j.image === 'https://example.com/logo.png');
  r = await get('/v1/launch/' + m1.address); ok('a built launch is not live and is not listed', r.j.status === 'built' && r.j.live === false && (await get('/v1/launch/list')).j.launches.every((l) => l.mint !== m1.address));
  r = await post('/v1/launch/send', { mint: m1.address, transaction: feeTx }); ok('an unsigned launch is refused', r.status === 400 && /missing a signature/.test(r.j.error.message));
  r = await post('/v1/launch/build', { creator: RICH, mint: pair().address, name: 'Clean', symbol: 'CLN', lockMetadata: true }); ok('a clean launch decodes as low risk', r.j.simulation.ok && r.j.preview.risk.level === 'low' && !r.j.preview.powers.includes('transferFee'), JSON.stringify(r.j.preview || r.j));
  r = await post('/v1/launch/build', { creator: RICH, mint: pair().address, name: 'Loose', symbol: 'LSE', feeBps: 250, lockFee: false, keepMintAuthority: true, freezeAuthority: true }); ok('kept authorities show up in the label and the warnings', r.j.simulation.ok && ['transferFee', 'freezeAuthority', 'mintAuthority'].every((k) => r.j.preview.powers.includes(k)) && r.j.warnings.length >= 3 && /can change the rate/.test(r.j.preview.risk.reasons.join()), JSON.stringify(r.j.preview || r.j));
  const hk = (await get('/v1/hooks')).j.programs[0]; if (hk) { r = await post('/v1/launch/build', { creator: RICH, mint: pair().address, name: 'Hooked', symbol: 'HOOK', hookProgram: hk.program, uri: 'https://example.com/hook.json' }); ok('a hooked launch is high risk and names its program', r.j.simulation.ok && r.j.preview.risk.level === 'high' && r.j.hookProgram.address === hk.program && r.j.config.uri === 'https://example.com/hook.json', JSON.stringify(r.j.preview || r.j)); }
  r = await post('/v1/launch/build', { creator: RICH, mint: pair().address, name: 'A', symbol: 'A', hookProgram: RICH }); ok('a hook that is not a program is refused', r.status === 422 && r.j.error.code === 'bad_hook');
  for (const [name, b] of [['a fee above 10%', { feeBps: 1001 }], ['a missing name', { name: '' }], ['a supply that overflows', { supply: '99999999999999999999' }], ['a long symbol', { symbol: 'ABCDEFGHIJK' }], ['an http image', { image: 'http://x.io/a.png' }], ['the wallet as its own mint', { mint: RICH }]]) { r = await post('/v1/launch/build', { creator: RICH, mint: pair().address, name: 'A', symbol: 'A', ...b }); ok(name + ' is a 400', r.status === 400, JSON.stringify(r.j).slice(0, 120)); }
  // both signatures are checked here before anything reaches the chain
  const c = pair(), m2 = pair(); r = await post('/v1/launch/build', { creator: c.address, mint: m2.address, name: 'Signed', symbol: 'SGN' }); ok('an empty wallet builds but fails the chain check in plain words', r.status === 200 && r.j.simulation.ok === false && /no SOL/.test(r.j.simulation.error), JSON.stringify(r.j.simulation));
  const raw = Buffer.from(r.j.transaction, 'base64'), msg = raw.subarray(129); raw.set(sign(null, msg, c.secret), 1); raw.set(sign(null, msg, c.secret), 65);
  r = await post('/v1/launch/send', { mint: m2.address, transaction: raw.toString('base64') }); ok('a wrong mint-key signature is refused', r.status === 400 && /mint key signature/.test(r.j.error.message), JSON.stringify(r.j));
  raw.set(sign(null, msg, m2.secret), 65); r = await post('/v1/launch/send', { mint: m1.address, transaction: raw.toString('base64') }); ok('a transaction for another mint is refused', r.status === 400 && /not the launch built/.test(r.j.error.message), JSON.stringify(r.j));
  r = await post('/v1/launch/send', { mint: m2.address, transaction: raw.toString('base64') }); ok('a correctly signed launch reaches the chain, which turns down the unfunded wallet', r.status === 422 && r.j.error.code === 'rpc_rejected', JSON.stringify(r.j).slice(0, 240));
  const FEE = (await get('/v1/tokens?power=transferFee&limit=40&sort=volume')).j.tokens.filter((t) => t.transferFeeBps > 0); let claimed = false;
  r = await get('/v1/launch/fees/' + USDC); ok('fees of a token without a transfer fee is 404', r.status === 404);
  for (const t of FEE.slice(0, 6)) { r = await get('/v1/launch/fees/' + t.mint); if (r.status !== 200 || !r.j.withdrawAuthority || !(Number(r.j.withheld.total) > 0)) continue;
    ok('withheld fees are read for ' + t.symbol, r.j.feeBps === t.transferFeeBps && !('_sources' in r.j)); const auth = r.j.withdrawAuthority;
    r = await post('/v1/launch/claim', { mint: t.mint, authority: RICH }); ok('only the withdraw authority can claim', r.status === 403);
    r = await post('/v1/launch/claim', { mint: t.mint, authority: auth }); ok('the claim passes the chain check', r.status === 200 && r.j.simulation.ok === true && r.j.tokenAccount === ataOf(auth, t.mint), JSON.stringify(r.j.simulation || r.j)); claimed = true; break; }
  if (!claimed) console.log('  --  no indexed fee token holds withheld fees right now: claim check skipped');
  r = await post('/mcp', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'build_launch', arguments: { creator: RICH, mint: pair().address, name: 'Agent', symbol: 'AGT', uri: 'https://example.com/a.json' } } }); ok('an agent can build a launch over MCP', JSON.parse(r.j.result.content[0].text).simulation.ok === true, JSON.stringify(r.j).slice(0, 200));
  r = await post('/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'decode_token', arguments: { mint: USDC } } }); ok('MCP tool call returns JSON text', JSON.parse(r.j.result.content[0].text).program === 'spl-token');
}
console.log('\n' + pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
