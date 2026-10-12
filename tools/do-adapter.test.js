// The Durable Object adapter (worker/src/storage/do-d1.ts) must behave like D1 for everything the application does. Its battery of 24 checks was run inside a REAL Durable
// Object (the local Cloudflare runtime) and the answers are in tools/golden/do-real-battery.json; here the same battery runs against a stand-in for the object's storage and must
// give the same answers. (Error TEXT is compared up to the engine's own suffix, e.g. ": SQLITE_ERROR", which the application's checks do not depend on.)
const path = require('path'), fs = require('fs'), os = require('os'), esbuild = require('esbuild');
module.exports = async function runDoAdapterTests({ check }) {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'do-battery-')), 'do-battery.js');
  esbuild.buildSync({ entryPoints: [path.join(__dirname, 'do-trial', 'battery.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent' });
  const { battery } = require(out);
  // Always built fresh from the source, to a file of its own: a cached build from an earlier run would let a broken adapter pass.
  const o2 = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'do-d1-')), 'do-d1.js');
  esbuild.buildSync({ entryPoints: [path.join(__dirname, '..', 'worker', 'src', 'storage', 'do-d1.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: o2, logLevel: 'silent' });
  const Do = require(o2).DoD1Database;
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(':memory:');
  const plain = (r) => (r ? { ...r } : r);
  const sql = { exec(query, ...binds) { const s = db.prepare(query); if (/^\s*(select|with|pragma|values)\b/i.test(query) || /\breturning\b/i.test(query)) { const rows = s.all(...binds).map(plain); return { toArray: () => rows, rowsRead: rows.length, rowsWritten: 0 }; } const r = s.run(...binds); return { toArray: () => [], rowsRead: 0, rowsWritten: Number(r.changes) }; } };
  const storage = { transactionSync(fn) { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } } };
  const got = await battery(new Do(sql, storage));
  const golden = JSON.parse(fs.readFileSync(path.join(__dirname, 'golden', 'do-real-battery.json'), 'utf8'));
  const norm = (v) => {
    if (v && typeof v === 'object' && !Array.isArray(v) && 'threw' in v) return { threw: String(v.threw).replace(/:\s*SQLITE_\w+.*$/, '').replace(/\s*\(extended.*$/, '') };
    if (v && typeof v === 'object' && !Array.isArray(v) && 'rows_written' in v) { const { rows_read, rows_written, ...rest } = v; return rest; }
    return v;
  };
  const keys = Object.keys(golden);
  check(keys.length === 24 && Object.keys(got).length === 24, 'the battery has 24 checks, and the stand-in answers every one');
  const different = keys.filter((k) => JSON.stringify(norm(got[k])) !== JSON.stringify(norm(golden[k])));
  check(different.length === 0, `the adapter gives the same answers as the REAL Durable Object runtime (different: ${different.join(', ')})`);
  check(golden['rows before and after the failed batch'][0] === golden['rows before and after the failed batch'][1] && JSON.stringify(got['rows before and after the failed batch']) === JSON.stringify(golden['rows before and after the failed batch']), 'a batch that fails halfway rolls back completely (the real runtime did, and so does the adapter)');
  check(golden['bind undefined'].threw && golden['bind boolean'].threw && got['bind undefined'].threw && got['bind boolean'].threw, 'binding undefined or a boolean is refused, as D1 refuses it');
  const toml = path.join(__dirname, '..', 'worker', 'wrangler.toml');
  if (fs.existsSync(toml)) {
    const cfg = fs.readFileSync(toml, 'utf8');
    check(/\[\[durable_objects\.bindings\]\]\s*\nname = "TRIAL"\s*\nclass_name = "TrialObject"/.test(cfg) && /new_sqlite_classes = \["TrialObject"\]/.test(cfg), 'the trial Durable Object must be registered in wrangler.toml with SQLite storage (an object class cannot be switched to SQLite later)');
  }
  check(got['insert'].changes === 1 && got['insert'].last_row_id === 1 && got['update changes'] === 2 && got['delete nothing'] === 0, 'change counts and the inserted id are reported');
};
