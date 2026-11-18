// CAST node: the token-extension index, the REST API, the MCP endpoint and the site, in one process.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from './store.js';
import { makeApi } from './api.js';
import { makeLaunch } from './launch.js';
import { ApiError } from './sol.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
try { for (const l of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) { const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(l); if (m && process.env[m[1]] == null) process.env[m[1]] = m[2]; } } catch {}
const cfg = { name: process.env.BRAND_NAME || 'CAST', ticker: process.env.BRAND_TICKER || '$CAST', site: (process.env.SITE_URL || '').replace(/\/$/, ''), x: process.env.X_URL || '', github: process.env.GH_URL || '', token: process.env.TOKEN_MINT || '' };
const PORT = Number(process.env.PORT || 8298), store = openStore(process.env.DATA_PATH || path.join(ROOT, 'cast.db')), api = { ...makeApi(store, cfg), ...makeLaunch(store, cfg) };

// ---- MCP: JSON-RPC over POST, JSON responses, no sessions. Nothing here signs or sends: tools read the chain or hand back unsigned transactions. ----
const S = { type: 'string' }, N = { type: 'number' }, MINT = { type: 'string', description: 'Base58 address. SOL is So11111111111111111111111111111111111111112.' };
const tool = (name, op, description, properties = {}, required = []) => ({ name, op, description, inputSchema: { type: 'object', properties, required }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } });
const TOOLS = [
  tool('decode_token', 'decodeToken', 'What a Solana token is allowed to do to its holders: transfer hook, transfer fee, permanent delegate, freeze, pause and mint powers, read from the mint account.', { mint: MINT }, ['mint']),
  tool('check_token', 'checkToken', 'Risk level and plain-English reasons before buying a token. Pass amount (in SOL) to include a live quote.', { mint: MINT, amount: S }, ['mint']),
  tool('list_tokens', 'listTokens', 'Indexed tokens, filterable by power (e.g. transferHook, transferFee, permanentDelegate), hook program, program, or text.', { power: S, hook: MINT, program: { type: 'string', enum: ['token-2022', 'spl-token'] }, verified: { type: 'boolean' }, q: S, sort: { type: 'string', enum: ['mcap', 'liquidity', 'volume', 'holders', 'recent'] }, limit: N, offset: N }),
  tool('list_hook_programs', 'listHooks', 'Transfer-hook programs ranked by how many indexed tokens use them.', { limit: N, offset: N }),
  tool('inspect_hook_program', 'inspectHook', 'A transfer-hook program: is it deployed, who can upgrade it, and which tokens run it.', { program: MINT }, ['program']),
  tool('quote', 'quote', 'Quote a swap through Jupiter, with the extension warnings for both tokens. Amount is a decimal string in input-token units.', { inputMint: MINT, outputMint: MINT, amount: S, slippageBps: N }, ['inputMint', 'outputMint', 'amount']),
  tool('build_swap', 'buildSwap', 'Unsigned swap transaction (base64) for the user to sign. Returns calldata only.', { inputMint: MINT, outputMint: MINT, amount: S, user: MINT, slippageBps: N }, ['inputMint', 'outputMint', 'amount', 'user']),
  tool('list_powers', 'powers', 'The catalogue of token powers this index decodes, with their risk level.'),
  tool('get_stats', 'stats', 'Index totals and how many tokens carry each power.'),
  tool('build_launch', 'buildLaunch', 'Unsigned transaction that creates a Token-2022 token in one go: transfer fee, optional transfer hook, on-chain metadata and the whole supply minted to the creator. Returns the simulation result and the risk label the token will decode to. `mint` is a fresh public key the caller holds the secret for; it must co-sign.',
    { creator: MINT, mint: MINT, name: S, symbol: S, decimals: N, supply: { type: 'string', description: 'Whole tokens, default 1000000000.' }, feeBps: { type: 'number', description: 'Transfer fee in basis points, 0 to 1000.' }, lockFee: { type: 'boolean', description: 'Default true: the rate can never change.' }, maxFee: S, hookProgram: MINT, lockHook: { type: 'boolean' }, keepMintAuthority: { type: 'boolean' }, freezeAuthority: { type: 'boolean' }, lockMetadata: { type: 'boolean' }, uri: S, description: S, image: S, website: S, x: S }, ['creator', 'mint', 'name', 'symbol']),
  tool('list_launches', 'listLaunches', 'Tokens created through the launchpad and confirmed on chain, newest first.', { creator: MINT, limit: N, offset: N }),
  tool('get_token_fees', 'fees', 'Transfer fees withheld for a token\'s fee authority: on the mint and on its largest holder accounts.', { mint: MINT }, ['mint']),
  tool('build_fee_claim', 'buildClaim', 'Unsigned transaction that withdraws a token\'s withheld transfer fees to its withdraw authority.', { mint: MINT, authority: MINT }, ['mint', 'authority']),
];
const BY = new Map(TOOLS.map((t) => [t.name, t]));
const INSTRUCTIONS = 'Tools for Solana token extensions (Token-2022). Nothing here signs or sends: tools read the chain or return unsigned transactions.\nTo launch a token, call build_launch, relay the risk label and every warning, and hand the transaction to the user to sign with their wallet and the mint key.\n1. Before a user buys a token, call check_token with the size in SOL and relay the risk level and every reason.\n2. If the token has a transfer hook, call inspect_hook_program and say whether the program is upgradeable.\n3. Only after the user confirms, call build_swap with their wallet as user and hand the transaction back to sign.';
async function mcpOne(msg) { const id = msg && msg.id, err = (code, message) => ({ jsonrpc: '2.0', id: id === undefined ? null : id, error: { code, message } });
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return err(-32600, 'Invalid request'); if (id === undefined) return null; const ok = (result) => ({ jsonrpc: '2.0', id, result });
  if (msg.method === 'initialize') return ok({ protocolVersion: (msg.params && msg.params.protocolVersion) || '2025-03-26', capabilities: { tools: { listChanged: false } }, serverInfo: { name: cfg.name.toLowerCase(), version: '0.1.0' }, instructions: INSTRUCTIONS });
  if (msg.method === 'ping') return ok({}); if (msg.method === 'tools/list') return ok({ tools: TOOLS.map(({ op, ...t }) => t) });
  if (msg.method === 'tools/call') { const t = BY.get(msg.params && msg.params.name); if (!t) return err(-32602, 'Unknown tool: ' + (msg.params && msg.params.name));
    try { return ok({ content: [{ type: 'text', text: JSON.stringify(await api[t.op](msg.params.arguments || {}), null, 2) }] }); } catch (e) { return ok({ isError: true, content: [{ type: 'text', text: e instanceof ApiError ? e.code + ': ' + e.message : 'upstream_error: ' + (e.message || 'error') }] }); } }
  return err(-32601, 'Method not found: ' + msg.method); }
const mcp = async (p) => { if (Array.isArray(p)) { const out = (await Promise.all(p.map(mcpOne))).filter((x) => x !== null); return out.length ? out : null; } return mcpOne(p); };

// ---- HTTP ----
const send = (res, status, body, type = 'application/json; charset=utf-8', extra = {}) => { const b = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body, null, 2);
  res.writeHead(status, { 'content-type': type, 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type, accept, mcp-protocol-version, mcp-session-id', 'access-control-allow-methods': 'GET, POST, OPTIONS', ...extra }); res.end(b); };
const fail = (res, e) => (e instanceof ApiError ? send(res, e.status, { error: { code: e.code, message: e.message } }) : (console.error(e), send(res, 502, { error: { code: 'upstream_error', message: 'Solana RPC did not answer: ' + (e.message || 'error') } })));
const body = (req) => new Promise((ok, no) => { let s = ''; req.on('data', (c) => { s += c; if (s.length > 2e6) { no(new ApiError(400, 'bad_request', 'body too large')); req.destroy(); } }); req.on('end', () => { if (!s) return ok({}); try { ok(JSON.parse(s)); } catch { no(new ApiError(400, 'bad_request', 'body must be JSON')); } }); });
const A = '([1-9A-HJ-NP-Za-km-z]{32,44})';
const R = [['GET', /^\/v1\/stats$/, 'stats'], ['GET', /^\/v1\/census$/, 'census'], ['GET', /^\/v1\/powers$/, 'powers'], ['GET', /^\/v1\/tokens$/, 'listTokens'],
  ['GET', new RegExp('^/v1/tokens/' + A + '/check$'), 'checkToken', 'mint'], ['GET', new RegExp('^/v1/tokens/' + A + '$'), 'decodeToken', 'mint'],
  ['GET', /^\/v1\/hooks$/, 'listHooks'], ['GET', new RegExp('^/v1/hooks/' + A + '$'), 'inspectHook', 'program'], ['GET', /^\/v1\/quote$/, 'quote'], ['POST', /^\/v1\/quote$/, 'quote'], ['POST', /^\/v1\/swap\/build$/, 'buildSwap'],
  ['GET', /^\/v1\/launch\/options$/, 'launchOptions'], ['POST', /^\/v1\/launch\/build$/, 'buildLaunch'], ['POST', /^\/v1\/launch\/send$/, 'sendLaunch'], ['GET', /^\/v1\/launch\/list$/, 'listLaunches'], ['POST', /^\/v1\/launch\/claim$/, 'buildClaim'],
  ['GET', new RegExp('^/v1/launch/meta/' + A + '$'), 'launchMeta', 'mint'], ['GET', new RegExp('^/v1/launch/fees/' + A + '$'), 'fees', 'mint'], ['GET', new RegExp('^/v1/launch/' + A + '$'), 'getLaunch', 'mint']];
const PAGES = { '/': 'index.html', '/tokens': 'tokens.html', '/launch': 'launch.html', '/docs': 'docs.html' };
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };
const fill = (html, origin) => html.replace(/\{\{NAME\}\}/g, cfg.name).replace(/\{\{TICKER\}\}/g, cfg.ticker).replace(/\{\{ORIGIN\}\}/g, cfg.site || origin).replace(/\{\{X_URL\}\}/g, cfg.x || '#').replace(/\{\{GH_URL\}\}/g, cfg.github || '#').replace(/\{\{TOKEN\}\}/g, cfg.token);
function file(res, f, origin) { fs.readFile(f, (err, buf) => { if (err) return send(res, 404, '<!doctype html><meta charset="utf-8"><title>Not found</title><body style="background:#0b0b12;color:#eee;font-family:sans-serif;padding:60px">Not found. <a style="color:#14f195" href="/">Home</a>', 'text/html; charset=utf-8');
  const ext = path.extname(f); send(res, 200, ext === '.html' || ext === '.js' ? fill(buf.toString('utf8'), origin) : buf, MIME[ext] || 'application/octet-stream', { 'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=300' }); }); }

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x'), p = u.pathname.replace(/\/+$/, '') || '/', origin = (req.headers['x-forwarded-proto'] || 'http') + '://' + req.headers.host;
  try {
    if (req.method === 'OPTIONS') return send(res, 204, '');
    if (p === '/mcp') { if (req.method !== 'POST') return send(res, 405, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Use POST.' } }, undefined, { allow: 'POST' }); const out = await mcp(await body(req)); return out === null ? send(res, 202, '') : send(res, 200, JSON.stringify(out)); }
    if (p === '/v1/config') return send(res, 200, { name: cfg.name, ticker: cfg.ticker, site: cfg.site || origin, x: cfg.x, github: cfg.github, token: cfg.token, tools: TOOLS.length });
    if (p.startsWith('/v1/')) { for (const [m, re, op, arg] of R) { const hit = re.exec(p); if (!hit || m !== req.method) continue; const input = req.method === 'POST' ? await body(req) : Object.fromEntries(u.searchParams); if (arg) input[arg] = hit[1]; delete input._origin; if (op === 'buildLaunch') input._origin = origin; return send(res, 200, await api[op](input)); }
      return send(res, 404, { error: { code: 'not_found', message: 'Unknown route ' + req.method + ' ' + p } }); }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed', 'text/plain');
    if (PAGES[p]) return file(res, path.join(ROOT, 'client', PAGES[p]), origin);
    if (p.startsWith('/lib/')) return file(res, path.join(ROOT, 'lib', path.basename(p)), origin);
    const f = path.normalize(path.join(ROOT, 'client', p)); if (!f.startsWith(path.join(ROOT, 'client'))) return send(res, 403, 'Forbidden', 'text/plain'); return file(res, f, origin);
  } catch (e) { fail(res, e); }
}).listen(PORT, function () { this.keepAliveTimeout = 65000; console.log(cfg.name + ' node · :' + PORT + ' · Solana'); if (process.env.NO_INDEX !== '1') store.start(); });
