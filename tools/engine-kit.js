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

function makeWorld({ businessId = 'eng-a', config } = {}) {
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
  const world = { businessId, db, env, puts, count, counts, changedTables, tables,
    writeCount: () => writes, resetWrites: () => { writes = 0; failAtWrite = null; }, failAt: (n) => { writes = 0; failAtWrite = n; },
    // the engine's own configuration for this business (currency, which capabilities are on), written the way the engine reads it
    configure: (cfg) => { for (const [k, v] of Object.entries(cfg || {})) db.prepare('INSERT INTO eng_config (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json').run(k, JSON.stringify(v)); },
  };
  return world;
}

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

module.exports = { makeWorld, loadEngine, guard, standalone, workerDir, bundle };
