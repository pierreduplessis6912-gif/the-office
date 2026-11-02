// Shared kit for the engine suites (tools/engine-*.test.js, branch engine-phase1, decided with Pierre 2026-11-01). One WORLD is one business: the application's real schema (every migration, in order, so the
// engine tables exist once migration 0004 does), foreign keys ON, the Durable Object adapter with REAL transactions (so atomicity is tested on BOTH harness backends, not only the Durable Object step),
// a fake notes store that records what is written to it, and a write counter with failure injection: `failAt(n)` makes the n-th WRITE statement throw, the same device the route cases use.
// The engine itself is loaded by bundling worker/src/engine/index.ts; until it exists, loadEngine() returns null and each suite reports that as a failing check, so a missing engine is RED, never a crash.
const fs = require('fs'), os = require('os'), path = require('path');
const esbuild = require('esbuild');
const harness = require('./harness.js');

const workerDir = path.join(__dirname, '..', 'worker');
let counter = 0;
const bundle = (entry, tag) => {
  const out = path.join(os.tmpdir(), `engkit-${tag}-${process.pid}-${++counter}.js`);
  esbuild.buildSync({ entryPoints: [path.join(workerDir, 'src', entry)], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent' });
  return require(out);
};

let engineCache;
// The engine's public surface, or null when it does not exist yet (or does not build).
function loadEngine() {
  if (engineCache !== undefined) return engineCache;
  try { engineCache = bundle('engine/index.ts', 'engine'); } catch (e) { engineCache = null; }
  return engineCache;
}

// A fake object store with the methods the backup module uses (put, get, head, list, delete).
function fakeBucket() {
  const m = new Map();
  const bytes = (v) => (typeof v === 'string' ? new TextEncoder().encode(v) : v instanceof ArrayBuffer ? new Uint8Array(v) : new Uint8Array(v));
  const wrap = (key) => { const e = m.get(key); return e ? { key, size: e.b.length, httpMetadata: e.meta, uploaded: new Date(), arrayBuffer: async () => e.b.slice().buffer, text: async () => new TextDecoder().decode(e.b) } : null; };
  return { m, put: async (key, value, opts = {}) => { m.set(key, { b: bytes(value), meta: (opts && opts.httpMetadata) || {} }); }, get: async (k) => wrap(k), head: async (k) => wrap(k), delete: async (keys) => { for (const k of Array.isArray(keys) ? keys : [keys]) m.delete(k); },
    list: async ({ prefix = '', cursor, limit = 1000 } = {}) => { const keys = [...m.keys()].filter((k) => k.startsWith(prefix)).sort(); const start = cursor ? Number(cursor) : 0; const page = keys.slice(start, start + limit); return { objects: page.map((k) => ({ key: k, size: m.get(k).b.length, uploaded: new Date() })), truncated: start + limit < keys.length, cursor: start + limit < keys.length ? String(start + limit) : undefined }; } };
}

function makeWorld({ businessId = 'eng-a', config, backups = false } = {}) {
  const { DoD1Database } = bundle('storage/do-d1.ts', 'dod1');
  const db = harness.newDatabase(workerDir);
  const plain = (r) => (r ? { ...r } : r);
  let writes = 0, failAtWrite = null;
  const isWrite = (q) => /^\s*(insert|update|delete|replace)\b/i.test(q);
  const sql = {
    exec(q, ...b) {
      if (isWrite(q)) {
        writes++;
        if (failAtWrite !== null && writes === failAtWrite) throw new Error(`injected failure at write ${writes}`);
      }
      const s = db.prepare(q);
      if (/^\s*(select|with|pragma|values)\b/i.test(q) || /\breturning\b/i.test(q)) { const rows = s.all(...b).map(plain); return { toArray: () => rows, rowsRead: rows.length, rowsWritten: isWrite(q) ? rows.length : 0 }; }
      const r = s.run(...b);
      return { toArray: () => [], rowsRead: 0, rowsWritten: Number(r.changes) };
    },
  };
  const storage = {
    transactionSync(fn) { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } },
    async transaction(fn) { db.exec('BEGIN'); try { const r = await fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } },
  };
  const notes = new Map(), puts = [];
  const env = {
    BUSINESS_ID: businessId,
    OFFICE_DB: new DoD1Database(sql, storage),
    CUSTOMER_NOTES: { get: async (k) => notes.get(k) ?? null, put: async (k, v) => { puts.push(k); notes.set(k, v); }, delete: async (k) => { notes.delete(k); }, list: async () => ({ keys: [...notes.keys()].map((name) => ({ name })), list_complete: true }) },
  };
  const count = (t) => Number(db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get().n);
  const tables = () => db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
  const counts = () => Object.fromEntries(tables().map((t) => [t, count(t)]));
  const changedTables = (before) => { const after = counts(); return Object.keys(after).filter((t) => (after[t] || 0) !== (before[t] || 0)).sort(); };
  if (backups) { db.exec('CREATE TABLE IF NOT EXISTS object_meta (key TEXT PRIMARY KEY, value TEXT)'); env.BACKUPS = fakeBucket(); env.OFFICE_VAULT = fakeBucket(); }
  const world = { businessId, db, env, puts, count, counts, changedTables, tables,
    writeCount: () => writes, resetWrites: () => { writes = 0; failAtWrite = null; }, failAt: (n) => { writes = 0; failAtWrite = n; },
    // the engine's own configuration for this business (currency, which capabilities are on), written the way the engine reads it
    configure: (cfg) => { for (const [k, v] of Object.entries(cfg || {})) db.prepare('INSERT INTO eng_config (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json').run(k, JSON.stringify(v)); },
  };
  return world;
}

// The real request handler, bundled once: the same device the capability proof uses (the real authentication gate, the real routes, a real SQLite), plus the harness's route runner.
let handlerCache;
async function buildHandler() {
  if (handlerCache) return handlerCache;
  const expose = { name: 'expose-for-engine-suites', setup(b) { b.onLoad({ filter: /src[\\/]index\.ts$/ }, (a) => ({ contents: fs.readFileSync(a.path, 'utf8') + '\nexport { processOneExtraction as __poe, processTranscript as __pt, handleRequest as __hr, serveRequest as __sr };\n', loader: 'ts' })); } };
  const out = path.join(os.tmpdir(), `engkit-handler-${process.pid}.js`), authOut = path.join(os.tmpdir(), `engkit-auth-${process.pid}.js`);
  await esbuild.build({ entryPoints: [path.join(workerDir, 'src', 'index.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent', plugins: [expose] });
  await esbuild.build({ entryPoints: [path.join(workerDir, 'src', 'auth.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: authOut, logLevel: 'silent' });
  const mod = require(out);
  handlerCache = { processOne: mod.__poe, processTranscript: mod.__pt, handleRequest: mod.__hr, serveRequest: mod.__sr, auth: require(authOut), mod };   // mod: the whole bundle, so a suite can reach the Worker's default export (the real front door) and the real BusinessObject class
  return handlerCache;
}
// One request through the real handler against a fresh business: { result: {status, body}, writes: per-table diff }. spec: method, path, body, role, seed(db), env.
async function route(spec) { const fns = await buildHandler(); const full = { method: 'POST', body: {}, role: 'owner', ...spec }; if (full.method === 'GET') delete full.body; return harness.runRouteCase(fns, workerDir, full); }
const asEngineBusiness = (more) => (db) => { db.prepare("INSERT INTO eng_config (key, value_json) VALUES ('mode', '\"engine\"')").run(); if (more) more(db); };

// A receivables business seeded with raw SQL (the route runner's seed hook is synchronous): customer Mokoena (party 1) with invoice 1 (R1,150.00 incl. 15% tax) and invoice 2 (R230.00 incl. tax), the engine's configuration,
// and events whose snapshots match the rows so the integrity verifier is happy. Event order is the order the engine's own functions record them in, so event numbers (and therefore versions) agree with a world built through the API.
const ALL_CAPABILITIES = ['receivables.query', 'records.get', 'payment.record', 'payment.correct', 'invoice.issue'];
const seedReceivables = (available) => (db) => {
  const ev = (type, payload) => Number(db.prepare("INSERT INTO eng_event (type, actor_email, contract, contract_version, payload_json) VALUES (?, 'seed@example.com', 'seed', 1, ?) RETURNING id").get(type, JSON.stringify(payload)).id);
  db.prepare("INSERT INTO eng_config (key, value_json) VALUES ('mode', '\"engine\"')").run();
  db.prepare("INSERT INTO eng_config (key, value_json) VALUES ('available', ?)").run(JSON.stringify(available || ALL_CAPABILITIES));
  const e1 = ev('party.created', { kind: 'person', name: 'Mokoena', roles: ['customer'] });
  db.prepare("INSERT INTO eng_party (kind, name, event_id) VALUES ('person', 'Mokoena', ?)").run(e1);
  db.prepare("INSERT INTO eng_party_role (party_id, role, event_id) VALUES (1, 'customer', ?)").run(e1);
  const invoice = (partyId, issuedOn, lines, totals) => {
    const e = ev('document.issued', { kind: 'invoice', direction: 'sell', partyId, currency: 'ZAR', issuedOn, reference: null, lines, totals });
    const id = Number(db.prepare("INSERT INTO eng_document (kind, direction, party_id, currency, issued_on, event_id) VALUES ('invoice', 'sell', ?, 'ZAR', ?, ?) RETURNING id").get(partyId, issuedOn, e).id);
    lines.forEach((l, i) => db.prepare('INSERT INTO eng_document_line (document_id, line_no, description, quantity_milli, unit, unit_price_minor, tax_bp) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, i + 1, l.description, l.quantityMilli, l.unit, l.unitPriceMinor, l.taxBp));
    db.prepare("INSERT INTO eng_document_number (kind, number, document_id) VALUES ('invoice', ?, ?)").run(id, id);
  };
  invoice(1, '2026-10-01', [{ description: 'Vinyl plank', quantityMilli: 1000, unit: 'job', unitPriceMinor: 100000, taxBp: 1500 }], { netMinor: 100000, taxMinor: 15000, grossMinor: 115000 });
  invoice(1, '2026-10-15', [{ description: 'Skirting', quantityMilli: 1000, unit: 'job', unitPriceMinor: 20000, taxBp: 1500 }], { netMinor: 20000, taxMinor: 3000, grossMinor: 23000 });
};

// A suite wrapper: an exception becomes a failing check, never a crash (in the umbrella a throw would abort every suite after it), and the real Response is put back for anything that gzips.
function guard(name, body) {
  return async function run(context) {
    const standIn = global.Response;
    if (global.__RealResponse) global.Response = global.__RealResponse;
    try { await body(context); } catch (e) { context.check(false, `the ${name} suite threw instead of failing a check: ${String((e && e.message) || e).slice(0, 180)}`); } finally { global.Response = standIn; }
  };
}

// Run a suite on its own: node tools/<suite>.js (the umbrella requires it instead).
function standalone(suiteModule) {
  const srcDir = path.join(workerDir, 'src');
  let total = 0, fails = 0;
  const check = (c, m) => { total++; if (!c) { fails++; console.log('FAIL  ' + m); } };
  const bundleTo = (entry, name) => { const out = path.join(os.tmpdir(), name); esbuild.buildSync({ entryPoints: [path.join(srcDir, entry)], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent' }); return require(out); };
  global.__RealResponse = global.Response;
  suiteModule({ check, bundleTo, srcDir }).then(() => { console.log(`\n${total - fails}/${total} correct, ${fails} failing`); process.exit(fails ? 1 : 0); }).catch((e) => { console.log('SUITE CRASHED: ' + ((e && e.stack) || e)); process.exit(2); });
}


// ---- a FLEET: the Worker's REAL front door (the default export's fetch) in front of REAL business objects --------------------------------------------------------------------------------------------------
// Each object is the production class (makeBusinessObject wrapping the real serveRequest), woken over a stand-in for Durable Object storage on its own Node SQLite database, building its own schema from empty.
// WHAT THIS IS NOT: the namespace is a plain map from object name to object, and the storage is a stand-in. It is NOT real Cloudflare routing and NOT a real Durable Object (the staging rehearsal is where those are exercised).
const { DatabaseSync } = require('node:sqlite');
const plainRow = (r) => (r ? { ...r } : r);
// the storage stand-in, copied verbatim from tools/business-object.test.js (which is where the object's contract with its storage is tested)
const plain = plainRow;
  const makeDoState = (db) => {
    const waited = []; let alarmAt = null, alarmSets = 0;
    const sql = { exec(query, ...binds) { const s = db.prepare(query); if (/^\s*(select|with|pragma|values)\b/i.test(query) || /\breturning\b/i.test(query)) { const rows = s.all(...binds).map(plain); return { toArray: () => rows, rowsRead: rows.length, rowsWritten: 0 }; } const r = s.run(...binds); return { toArray: () => [], rowsRead: 0, rowsWritten: Number(r.changes) }; } };
    const storage = { sql, transactionSync(fn) { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } }, getAlarm: async () => alarmAt, setAlarm: async (t) => { alarmAt = t; alarmSets++; } };
    return { state: { storage, blockConcurrencyWhile: (fn) => fn(), waitUntil: (p) => waited.push(p) }, waited, alarm: () => alarmAt, alarmSets: () => alarmSets };
  };
async function makeFleet({ ids = ['alpha-co', 'beta-co'] } = {}) {
  const fns = await buildHandler(), mod = fns.mod;
  const env = { BUSINESS_MODE: 'object', SESSION_SECRET: 'fleet-secret', ADMIN_KEY: 'fleet-admin', METER_USAGE: '0' };
  const objects = {}, raws = {}; let misroute = null;
  // forwardToBusiness calls namespace.get(namespace.idFromName(name), { locationHint }).fetch(request); misroute(name) lets a test send a request to the WRONG object on purpose
  env.BUSINESS = { idFromName: (name) => ({ name }), get: (id) => ({ fetch: (req) => objects[misroute ? misroute(id.name) : id.name].fetch(req) }) };
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  const wake = async (b) => { const raw = new DatabaseSync(':memory:'); const st = makeDoState(raw); const o = new mod.BusinessObject(st.state, env); await o.ready; objects['business-' + b] = o; raws[b] = raw; return o; };
  for (const b of ids) await wake(b);
  const url = (p) => 'https://office.example' + p;
  return {
    env, mod, auth: fns.auth, objects, raws, wake, ctx,
    setMisroute: (fn) => { misroute = fn; },
    db: (b) => objects['business-' + b].db,   // the object's own database, in the D1 shape the engine uses
    token: (email, b) => fns.auth.signSession(env, email, b),
    front: (p, init) => mod.default.fetch(new Request(url(p), init), env, ctx),                       // the Worker's real front door
    direct: (b, p, init) => objects['business-' + b].fetch(new Request(url(p), init)),                // one object, with no router in front
  };
}

module.exports = { makeFleet, makeWorld, loadEngine, guard, standalone, workerDir, bundle, buildHandler, route, asEngineBusiness, seedReceivables, ALL_CAPABILITIES };
