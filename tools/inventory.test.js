// The read-only inventory (tools/inventory-lib.mjs) that sizes a deployment's data before a migration. It must be STRUCTURALLY read-only (only GET, never a fingerprint, no code that can write), count
// correctly, keep no personal data, and give an estimate that grows with the data.
const path = require('path'), fs = require('fs'), os = require('os'), esbuild = require('esbuild');
const { pathToFileURL } = require('url');
const { DatabaseSync } = require('node:sqlite');

module.exports = async function runInventoryTests(context) {
  const standIn = global.Response;
  if (global.__RealResponse) global.Response = global.__RealResponse;
  try { await inventoryTests(context); } finally { global.Response = standIn; }
};

async function inventoryTests({ check, srcDir }) {
  const bundle = (entry) => { const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'iv-')), 'm.js'); esbuild.buildSync({ entryPoints: [path.join(srcDir, entry)], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent' }); return require(out); };
  const routes = bundle('migration-routes.ts'), { DoD1Database } = bundle('storage/do-d1.ts');
  const lib = await import(pathToFileURL(path.join(__dirname, 'inventory-lib.mjs')).href);
  const baseline = fs.readFileSync(path.join(srcDir, '..', 'migrations', '0001_baseline.sql'), 'utf8');
  const plain = (r) => (r ? { ...r } : r);
  const db = new DatabaseSync(':memory:'); db.exec(baseline);
  db.exec("CREATE TABLE lazy_things (id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT)");
  for (let i = 1; i <= 7; i++) db.prepare('INSERT INTO customers (name) VALUES (?)').run(`Customer ${i}`);
  db.exec("INSERT INTO lazy_things (label) VALUES ('a'), ('b')");
  const member = db.prepare('INSERT INTO memberships (google_email, role, status) VALUES (?, ?, ?)');
  member.run('secret.owner@private-company.example', 'owner', 'active'); member.run('crew.one@private-company.example', 'installer', 'active'); member.run('crew.two@private-company.example', 'installer', 'active'); member.run('old.one@private-company.example', 'installer', 'suspended');
  const sql = { exec(query, ...binds) { const s = db.prepare(query); if (/^\s*(select|with|pragma|values)\b/i.test(query) || /\breturning\b/i.test(query)) { const rows = s.all(...binds).map(plain); return { toArray: () => rows, rowsRead: rows.length, rowsWritten: 0 }; } const r = s.run(...binds); return { toArray: () => [], rowsRead: 0, rowsWritten: Number(r.changes) }; } };
  const storage = { transactionSync(fn) { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } } };
  const kv = new Map(), r2 = new Map();
  for (let i = 1; i <= 130; i++) kv.set(`customer:${i}`, 'x'.repeat(10 + (i % 5)) + 'é');
  for (let i = 1; i <= 105; i++) r2.set(`${['voice-notes', 'documents', 'photos'][i % 3]}/${i}.bin`, new Uint8Array(100 + i));
  const page = (all, limit, cursor) => { const start = cursor ? Number(cursor) : 0; return { slice: all.slice(start, start + limit), more: start + limit < all.length, cursor: start + limit < all.length ? String(start + limit) : undefined }; };
  const env = {
    OFFICE_DB: new DoD1Database(sql, storage),
    CUSTOMER_NOTES: { get: async (k) => kv.get(k) ?? null, list: async ({ limit = 1000, cursor } = {}) => { const p = page([...kv.keys()].sort(), limit, cursor); return { keys: p.slice.map((name) => ({ name })), list_complete: !p.more, cursor: p.cursor }; } },
    OFFICE_VAULT: { list: async ({ limit = 1000, cursor } = {}) => { const p = page([...r2.keys()].sort(), limit, cursor); return { objects: p.slice.map((key) => ({ key, size: r2.get(key).length })), truncated: p.more, cursor: p.cursor }; } },
  };
  const calls = [];
  const fetchImpl = async (url, init = {}) => { const u = new URL(url); calls.push({ method: init.method ?? 'GET', path: u.pathname, headers: init.headers }); return (await routes.migrationRoute(new Request(url, { method: init.method ?? 'GET', headers: init.headers }), env, u)) ?? new Response('not found', { status: 404 }); };
  const rep = await lib.inventory({ source: { base: 'http://prod', adminKey: 'k', confirmKey: 'c' }, vectorCount: 45, pageSize: 3, fetchImpl });

  check(rep.ok === true && rep.readOnly === true && rep.database.tables >= 40 && rep.database.rows === 7 + 2 + 4 && rep.database.largestTables[0].name === 'customers' && rep.database.largestTables[0].rows === 7, 'the inventory counts the database: its tables (including one created on first use), its rows, and which tables are largest');
  check(rep.notes.count === 130 && rep.notes.bytes === [...kv.values()].reduce((n, v) => n + new TextEncoder().encode(v).length, 0), 'it counts the notes (130, across pages) and their size in bytes, counting a non-ASCII character as the two bytes it is');
  check(rep.files.count === 105 && rep.files.bytes === [...r2.values()].reduce((n, v) => n + v.length, 0) && rep.files.byFolder['voice-notes'].count === 35 && rep.files.byFolder.documents.count === 35 && rep.files.byFolder.photos.count === 35, 'it counts the files (105, across pages), their total size, and how they divide between folders');
  check(rep.team.activeTotal === 3 && rep.team.activeByRole.owner === 1 && rep.team.activeByRole.installer === 2 && rep.team.notActive === 1, 'it counts the team by role and status');
  check(!JSON.stringify(rep).includes('@') && !/secret\.owner|private-company/.test(JSON.stringify(rep)) && !/Customer \d/.test(JSON.stringify(rep)), 'the report contains NO personal data: no email address, no customer name, no note text (counts and sizes only)');
  check(calls.length > 0 && calls.every((c) => c.method === 'GET') && !calls.some((c) => /fingerprint|schema|sequences/.test(c.path)) && rep.requests >= calls.length, 'every request it made was a GET, and it never asked for a fingerprint (which reads and hashes everything in one request)');
  check(calls.every((c) => c.headers['X-Admin-Key'] === 'k' && c.headers['X-Admin-Confirm'] === 'c') && !JSON.stringify(rep).includes('"k"'), 'it authenticates every request with both keys and never records a key');
  check(rep.estimate.sequentialSecondsExpected > 0 && rep.estimate.sequentialSecondsLow < rep.estimate.sequentialSecondsExpected && rep.estimate.sequentialSecondsHigh > rep.estimate.sequentialSecondsExpected, 'it gives a time estimate with a low and a high');
  const small = lib.estimate({ rows: 100, tables: 40, notes: 10, files: 10, vectors: 0 }), big = lib.estimate({ rows: 100000, tables: 40, notes: 5000, files: 3000, vectors: 2000 });
  check(big.sequentialSecondsExpected > small.sequentialSecondsExpected * 10 && lib.estimate({ rows: 0, tables: 0, notes: 0, files: 0, vectors: 45 }).sequentialSecondsExpected > lib.estimate({ rows: 0, tables: 0, notes: 0, files: 0, vectors: 0 }).sequentialSecondsExpected, 'the estimate grows with the data, and with the memories (which add Cloudflare\'s processing wait)');
  calls.length = 0;
  await lib.inventory({ source: { base: 'http://prod', adminKey: 'k', confirmKey: 'c', business: 'zulu-co' }, pageSize: 50, fetchImpl });
  check(calls.length > 0 && calls.every((c) => c.headers['X-Target-Business'] === 'zulu-co') && !calls.some((c) => c.method !== 'GET'), 'after the cutover the inventory can NAME the business whose data it counts (every request carries it), and is still only GETs');
  calls.length = 0;
  await lib.inventory({ source: { base: 'http://prod', adminKey: 'k', confirmKey: 'c' }, pageSize: 50, fetchImpl });
  check(calls.every((c) => !('X-Target-Business' in c.headers)), 'and without one it sends none (the single-business deployment)');
  const denied = await lib.inventory({ source: { base: 'http://prod', adminKey: 'k', confirmKey: 'c' }, fetchImpl: async () => new Response('{"error":"forbidden"}', { status: 403 }) });
  check(denied.ok === false && /403/.test(denied.error) && denied.requests === 1 && denied.readOnly === true, 'a refusal (for instance the second key is not set) is REPORTED with its status and is not retried');
  const libSrc = fs.readFileSync(path.join(__dirname, 'inventory-lib.mjs'), 'utf8').replace(/\/\/.*$/gm, '');
  check(!/POST|PUT|DELETE|PATCH/.test(libSrc) && /method: 'GET'/.test(libSrc), 'the inventory module contains NO code that can write: no POST, PUT, DELETE or PATCH appears anywhere in it');
  const cli = fs.readFileSync(path.join(__dirname, 'inventory.mjs'), 'utf8');
  check(/process\.env/.test(cli) && !/--(source|admin|key)/.test(cli) && /process\.exit\(report\.ok \? 0 : 1\)/.test(cli), 'the command line takes its keys from the environment and exits non-zero unless the inventory succeeded');
}
