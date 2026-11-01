// World builder and probe for tools/restore-memory.test.js: how much JavaScript heap does a RESTORE need once a business has grown? buildWorld makes a business shaped like staging-co (about 63%
// customers, the rest captures, invoices and payments: 26,000 customers is about 41.3k rows, the size at which the restore drill first failed on Cloudflare with "isolate exceeded its memory
// limit"). Run directly, it takes a snapshot, damages the business, restores it and checks it is back; the test runs it under a small `--max-old-space-size`, so a restore that holds more than
// it needs fails here, on any machine, instead of only on a Durable Object. A local heap is NOT a Durable Object's 128 MB (which also counts buffers and storage): this proves "does not grow
// with every table at once", not "will fit on Cloudflare". Only the staging drill proves that.
// usage: node [--max-old-space-size=MB] tools/restore-memory-probe.js <customers>
const path = require('path'), fs = require('fs'), os = require('os');
const esbuild = require('esbuild');
const { DatabaseSync } = require('node:sqlite');
const srcDir = path.join(__dirname, '..', 'worker', 'src');
const bundle = (entry, tag) => { const out = path.join(os.tmpdir(), `rmprobe-${tag}-${process.pid}.js`); esbuild.buildSync({ entryPoints: [path.join(srcDir, entry)], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent' }); return require(out); };
const plain = (r) => (r ? { ...r } : r);

function buildWorld(N, hooks = {}) {
  const bk = bundle('backup.ts', 'backup'), { DoD1Database } = bundle('storage/do-d1.ts', 'dod1');
  const baseline = fs.readFileSync(path.join(srcDir, '..', 'migrations', '0001_baseline.sql'), 'utf8');
  const fakeBucket = (name) => {
    const m = new Map();
    const toBytes = (v) => (typeof v === 'string' ? new TextEncoder().encode(v) : v instanceof ArrayBuffer ? new Uint8Array(v) : new Uint8Array(v));
    const wrap = (key) => { const e = m.get(key); return e ? { key, size: e.bytes.length, httpMetadata: e.meta, arrayBuffer: async () => e.bytes.slice().buffer, text: async () => new TextDecoder().decode(e.bytes) } : null; };
    return { m, put: async (key, value, opts = {}) => { if (hooks.onPut) hooks.onPut(name, key); m.set(key, { bytes: toBytes(value), meta: opts.httpMetadata ?? {} }); }, get: async (k) => { if (hooks.onGet) hooks.onGet(name, k); return wrap(k); }, head: async (k) => wrap(k), delete: async (keys) => { for (const k of Array.isArray(keys) ? keys : [keys]) m.delete(k); },
      list: async ({ prefix = '', cursor, limit = 1000 } = {}) => { const keys = [...m.keys()].filter((k) => k.startsWith(prefix)).sort(); const start = cursor ? Number(cursor) : 0; const page = keys.slice(start, start + limit).map((k) => ({ key: k, size: m.get(k).bytes.length })); return { objects: page, delimitedPrefixes: [], truncated: start + limit < keys.length, cursor: start + limit < keys.length ? String(start + limit) : undefined }; } };
  };
  const db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys = ON'); db.exec(baseline); db.exec('CREATE TABLE object_meta (key TEXT PRIMARY KEY, value TEXT)');
  const sql = { exec(q, ...b) { if (hooks.onSql) hooks.onSql(q); const s = db.prepare(q); if (/^\s*(select|with|pragma|values)\b/i.test(q) || /\breturning\b/i.test(q)) { const rows = s.all(...b).map(plain); return { toArray: () => rows, rowsRead: rows.length, rowsWritten: 0 }; } const r = s.run(...b); return { toArray: () => [], rowsRead: 0, rowsWritten: Number(r.changes) }; } };
  const storage = { transactionSync(fn) { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } }, async transaction(fn) { db.exec('BEGIN'); try { const r = await fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } } };
  const kv = new Map(), vault = fakeBucket('vault'), backups = fakeBucket('backups');
  const env = { BUSINESS_ID: 'zulu-co', OFFICE_DB: new DoD1Database(sql, storage), BACKUPS: backups, OFFICE_VAULT: vault,
    CUSTOMER_NOTES: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => { kv.set(k, v); }, delete: async (k) => { kv.delete(k); }, list: async ({ limit = 1000, cursor, prefix = '' } = {}) => { const all = [...kv.keys()].filter((k) => k.startsWith(prefix)).sort(); const start = cursor ? Number(cursor) : 0; const keys = all.slice(start, start + limit).map((name) => ({ name })); return { keys, list_complete: start + limit >= all.length, cursor: start + limit < all.length ? String(start + limit) : undefined }; } } };
  db.exec('BEGIN');
  for (let i = 1; i <= N; i++) db.prepare('INSERT INTO customers (name, address) VALUES (?, ?)').run(`Customer ${i} Load Test`, `${i} Test Street, Durban`);
  for (let i = 1; i <= Math.round(N * 0.31); i++) db.prepare("INSERT INTO captures (raw_text, source) VALUES (?, 'text')").run(`Invoice Customer ${i} R${i} for repairing the bathroom floor`);
  for (let i = 1; i <= Math.round(N * 0.15); i++) db.prepare('INSERT INTO invoices (customer_id, description, amount) VALUES (?, ?, ?)').run(i, `Invoice ${i}`, i);
  for (let i = 1; i <= Math.round(N * 0.13); i++) db.prepare('INSERT INTO payments (customer_id, amount, source_transcript) VALUES (?, ?, ?)').run(i, i, 'paid');
  db.exec('COMMIT');
  const count = (t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
  return { bk, env, db, backups, count, rows: () => count('customers') + count('captures') + count('invoices') + count('payments') };
}

// Snapshot, damage, restore, and report whether the business is back exactly (customers and payments back to their counts, none of the damage left).
async function snapshotDamageRestore(w) {
  const snap = await w.bk.takeSnapshot(w.env, new Date('2026-10-14T03:05:09Z'));
  const before = { customers: w.count('customers'), payments: w.count('payments') };
  for (let i = 1; i <= 3; i++) w.db.prepare('INSERT INTO customers (name, address) VALUES (?, ?)').run(`DAMAGE ${i}`, 'x');
  const report = await w.bk.restoreSnapshot(w.env, snap.name, 'zulu-co');
  const back = w.count('customers') === before.customers && w.count('payments') === before.payments && w.db.prepare("SELECT COUNT(*) AS n FROM customers WHERE name LIKE 'DAMAGE%'").get().n === 0;
  return { snap, report, back };
}

module.exports = { buildWorld, snapshotDamageRestore };

if (require.main === module) {
  (async () => {
    const w = buildWorld(Number(process.argv[2] || 1000));
    const rows = w.rows();
    const r = await snapshotDamageRestore(w);
    if (!r.report.ok || !r.back) throw new Error('restore did not return the business: ' + JSON.stringify(r.report).slice(0, 140));
    console.log(`OK rows=${rows} heapUsed=${Math.round(process.memoryUsage().heapUsed / 1048576)}MB`);
  })().catch((e) => { console.log('FAILED: ' + String((e && e.message) || e).slice(0, 160)); process.exit(1); });
}
