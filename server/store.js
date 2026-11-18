// The index: every token Jupiter lists (verified, most traded, trending, newest), with its extensions decoded from the chain.
import { DatabaseSync } from 'node:sqlite';
import { lists, decodeMany } from './sol.js';
import { POWERS, POWER_BITS, describe, TOKEN_2022 } from '../lib/ext.js';

export function openStore(file) {
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
    CREATE TABLE IF NOT EXISTS tokens (mint TEXT PRIMARY KEY, symbol TEXT, name TEXT, icon TEXT, program TEXT, decimals INTEGER, mcap REAL DEFAULT 0, liquidity REAL DEFAULT 0, volume REAL DEFAULT 0, holders INTEGER DEFAULT 0, verified INTEGER DEFAULT 0, price REAL DEFAULT 0,
      created TEXT, launchpad TEXT, seen INTEGER, flags INTEGER DEFAULT 0, hook TEXT, fee INTEGER DEFAULT 0, detail TEXT, decoded INTEGER DEFAULT 0) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS t_mcap ON tokens (mcap DESC); CREATE INDEX IF NOT EXISTS t_hook ON tokens (hook) WHERE hook IS NOT NULL; CREATE INDEX IF NOT EXISTS t_dec ON tokens (decoded);`);
  const S = new Map(), q = (sql) => { let s = S.get(sql); if (!s) { s = db.prepare(sql); S.set(sql, s); } return s; };
  const up = q(`INSERT INTO tokens (mint,symbol,name,icon,program,decimals,mcap,liquidity,volume,holders,verified,price,created,launchpad,seen) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(mint) DO UPDATE SET symbol=excluded.symbol,name=excluded.name,icon=excluded.icon,program=excluded.program,decimals=excluded.decimals,mcap=excluded.mcap,liquidity=excluded.liquidity,volume=excluded.volume,holders=excluded.holders,verified=MAX(verified,excluded.verified),price=excluded.price,created=COALESCE(excluded.created,created),launchpad=COALESCE(excluded.launchpad,launchpad),seen=excluded.seen`);
  const sync = { lists: 0, decodes: 0, error: null, lastList: 0 };

  function upsert(rows) { db.exec('BEGIN'); try { const now = Date.now(); for (const t of rows) if (t.mint) up.run(t.mint, t.symbol, t.name, t.icon, t.program, t.decimals ?? null, t.mcap, t.liquidity, t.volume24h, t.holders, t.verified, t.price, t.created, t.launchpad, now); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; } }
  const save = q('UPDATE tokens SET flags=?, hook=?, fee=?, detail=?, decoded=?, decimals=COALESCE(?,decimals) WHERE mint=?');
  function saveDecoded(d) { save.run(d.flags || 0, d.details && d.details.transferHook ? d.details.transferHook.programId : null, d.details && d.details.transferFee ? d.details.transferFee.bps : 0, JSON.stringify(d.details || {}), Date.now(), d.decimals ?? null, d.address); }

  // pull Jupiter's lists every few minutes; decode what has never been decoded, then refresh the oldest
  async function pull() { try { for (const [name, f] of Object.entries(lists)) { if (name === 'verified' && Date.now() - sync.lastList < 30 * 60e3) continue; upsert(await f()); if (name === 'verified') sync.lastList = Date.now(); } sync.lists++; sync.error = null; } catch (e) { sync.error = e.message; } }
  async function decodeStep() { try {
      let rows = q("SELECT mint FROM tokens WHERE decoded=0 ORDER BY (program=?) DESC, mcap DESC LIMIT 100").all(TOKEN_2022);
      if (!rows.length) rows = q('SELECT mint FROM tokens WHERE decoded<? ORDER BY decoded ASC LIMIT 100').all(Date.now() - 6 * 3600e3);
      if (!rows.length) return; const got = await decodeMany(rows.map((r) => r.mint)); db.exec('BEGIN'); for (const d of got.values()) saveDecoded(d.exists === false || d.isMint === false ? { address: d.address, flags: 0, details: {} } : d); db.exec('COMMIT'); sync.decodes++;
    } catch (e) { try { db.exec('ROLLBACK'); } catch {} sync.error = e.message; } }
  const start = () => { pull(); setInterval(pull, 90e3).unref(); setInterval(decodeStep, 2500).unref(); };

  // ---- reads ----
  const row = (r) => { const detail = r.detail ? JSON.parse(r.detail) : {}, d = describe(r.flags || 0, detail);
    return { mint: r.mint, symbol: r.symbol, name: r.name, icon: r.icon, program: r.program === TOKEN_2022 ? 'token-2022' : 'spl-token', decimals: r.decimals, marketCap: r.mcap, liquidity: r.liquidity, volume24h: r.volume, holders: r.holders, verified: !!r.verified, createdAt: r.created, launchpad: r.launchpad,
      decoded: r.decoded > 0, powers: d.powers, risk: d.risk.level, transferHook: r.hook || null, transferFeeBps: r.fee || 0 }; };
  const SORT = { mcap: 'mcap DESC', liquidity: 'liquidity DESC', volume: 'volume DESC', holders: 'holders DESC', recent: 'created DESC' };
  function listTokens({ power, hook, program, verified, q: text, sort, limit, offset }) {
    const wh = ['decoded>0'], args = [];
    if (power) { wh.push('(flags & ?) = ?'); const m = power.reduce((f, k) => f | POWER_BITS[k], 0); args.push(m, m); }
    if (hook) { wh.push('hook=?'); args.push(hook); }
    if (program === 'token-2022') { wh.push('program=?'); args.push(TOKEN_2022); } else if (program === 'spl-token') { wh.push('program<>?'); args.push(TOKEN_2022); }
    if (verified) wh.push('verified=1');
    if (text) { wh.push('(symbol LIKE ? OR name LIKE ? OR mint=?)'); args.push(text + '%', '%' + text + '%', text); }
    const W = ' WHERE ' + wh.join(' AND ');
    return { total: q('SELECT COUNT(*) n FROM tokens' + W).get(...args).n, limit, offset, tokens: q('SELECT * FROM tokens' + W + ' ORDER BY ' + (SORT[sort] || SORT.mcap) + ' LIMIT ? OFFSET ?').all(...args, limit, offset).map(row) };
  }
  const getToken = (mint) => { const r = q('SELECT * FROM tokens WHERE mint=?').get(mint); return r ? row(r) : null; };
  const hookPrograms = ({ limit, offset }) => ({ total: q('SELECT COUNT(DISTINCT hook) n FROM tokens WHERE hook IS NOT NULL').get().n, limit, offset,
    programs: q('SELECT hook, COUNT(*) tokens, SUM(mcap) mcap, SUM(liquidity) liq, MAX(mcap) top FROM tokens WHERE hook IS NOT NULL GROUP BY hook ORDER BY tokens DESC, mcap DESC LIMIT ? OFFSET ?').all(limit, offset)
      .map((r) => ({ program: r.hook, tokens: r.tokens, marketCap: r.mcap || 0, liquidity: r.liq || 0, example: (q('SELECT symbol FROM tokens WHERE hook=? ORDER BY mcap DESC LIMIT 1').get(r.hook) || {}).symbol || null })) });
  let cen = null;
  function census() { if (cen && Date.now() - cen.at < 30e3) return cen.v;
    const tot = q('SELECT COUNT(*) n, SUM(program=?) t22, SUM(decoded>0) dec FROM tokens').get(TOKEN_2022), by = {};
    for (const p of POWERS) { const r = q('SELECT COUNT(*) n, COALESCE(SUM(mcap),0) m FROM tokens WHERE decoded>0 AND (flags & ?) <> 0').get(POWER_BITS[p.key]); by[p.key] = { tokens: r.n, marketCap: r.m, level: p.level, label: p.label }; }
    const v = { tokens: tot.n || 0, token2022: tot.t22 || 0, decoded: tot.dec || 0, hookPrograms: q('SELECT COUNT(DISTINCT hook) n FROM tokens WHERE hook IS NOT NULL').get().n, byPower: by }; cen = { at: Date.now(), v }; return v; }

  // ---- launches: tokens created through the launchpad. `live` is set once the mint is read back from the chain ----
  db.exec('CREATE TABLE IF NOT EXISTS launches (mint TEXT PRIMARY KEY, creator TEXT, name TEXT, symbol TEXT, decimals INTEGER, supply TEXT, config TEXT, meta TEXT, sig TEXT, built INTEGER, live INTEGER DEFAULT 0) WITHOUT ROWID; CREATE INDEX IF NOT EXISTS l_live ON launches (live DESC);');
  const lrow = (r) => (r ? { mint: r.mint, creator: r.creator, name: r.name, symbol: r.symbol, decimals: r.decimals, supply: r.supply, config: JSON.parse(r.config || '{}'), metadata: JSON.parse(r.meta || 'null'), signature: r.sig || null, builtAt: r.built, live: r.live > 0, liveAt: r.live || null } : null);
  const launches = {
    save: (l) => q('INSERT INTO launches (mint,creator,name,symbol,decimals,supply,config,meta,built) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(mint) DO UPDATE SET creator=excluded.creator,name=excluded.name,symbol=excluded.symbol,decimals=excluded.decimals,supply=excluded.supply,config=excluded.config,meta=excluded.meta,built=excluded.built WHERE live=0').run(l.mint, l.creator, l.name, l.symbol, l.decimals, l.supply, JSON.stringify(l.config), JSON.stringify(l.metadata), Date.now()),
    get: (mint) => lrow(q('SELECT * FROM launches WHERE mint=?').get(mint)),
    sent: (mint, sig) => q('UPDATE launches SET sig=? WHERE mint=?').run(sig, mint),
    live: (mint) => q('UPDATE launches SET live=? WHERE mint=? AND live=0').run(Date.now(), mint),
    list: ({ creator, limit, offset }) => { const W = ' WHERE live>0' + (creator ? ' AND creator=?' : ''), a = creator ? [creator] : []; return { total: q('SELECT COUNT(*) n FROM launches' + W).get(...a).n, limit, offset, launches: q('SELECT * FROM launches' + W + ' ORDER BY live DESC LIMIT ? OFFSET ?').all(...a, limit, offset).map(lrow) }; },
    prune: () => q('DELETE FROM launches WHERE live=0 AND built<?').run(Date.now() - 24 * 3600e3),
  };
  return { start, sync, upsert, saveDecoded, listTokens, getToken, hookPrograms, census, launches };
}
