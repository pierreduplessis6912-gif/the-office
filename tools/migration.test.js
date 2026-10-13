// Moving a business's data into an object and proving it arrived intact (worker/src/migration.ts). A business's data is in four places (database rows and their id counters, notes, files, memories) and
// all must move. Here the real functions are run against two stand-in databases (the real baseline schema), a notes store and a file bucket: the source has the awkward things real data has (quotes,
// emoji, newlines, NULLs, a 50 KB text, a deleted top id, a column added later, a table created on first use, binary files, more than one page of notes and files).
const path = require('path'), fs = require('fs'), os = require('os'), esbuild = require('esbuild');
const { DatabaseSync } = require('node:sqlite');

module.exports = async function runMigrationTests({ check, srcDir }) {
  const bundle = (entry) => { const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mg-')), 'm.js'); esbuild.buildSync({ entryPoints: [path.join(srcDir, entry)], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent' }); return require(out); };
  const mg = bundle('migration.ts'), { DoD1Database } = bundle('storage/do-d1.ts');
  const baseline = fs.readFileSync(path.join(srcDir, '..', 'migrations', '0001_baseline.sql'), 'utf8');
  const plain = (r) => (r ? { ...r } : r);

  const makeSide = (setup) => {
    const db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys = ON'); db.exec(baseline); if (setup) setup(db);
    const sql = { exec(query, ...binds) { const s = db.prepare(query); if (/^\s*(select|with|pragma|values)\b/i.test(query) || /\breturning\b/i.test(query)) { const rows = s.all(...binds).map(plain); return { toArray: () => rows, rowsRead: rows.length, rowsWritten: 0 }; } const r = s.run(...binds); return { toArray: () => [], rowsRead: 0, rowsWritten: Number(r.changes) }; } };
    const storage = { transactionSync(fn) { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } } };
    const kv = new Map(), r2 = new Map();
    const page = (all, limit, cursor) => { const start = cursor ? Number(cursor) : 0; const slice = all.slice(start, start + limit); const more = start + limit < all.length; return { slice, more, cursor: more ? String(start + limit) : undefined }; };
    const env = {
      OFFICE_DB: new DoD1Database(sql, storage),
      CUSTOMER_NOTES: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => { kv.set(k, v); }, list: async ({ limit = 1000, cursor } = {}) => { const p = page([...kv.keys()].sort(), limit, cursor); return { keys: p.slice.map((name) => ({ name })), list_complete: !p.more, cursor: p.cursor }; } },
      OFFICE_VAULT: { get: async (k) => (r2.has(k) ? { body: r2.get(k).bytes, httpMetadata: { contentType: r2.get(k).type }, arrayBuffer: async () => r2.get(k).bytes.buffer.slice(r2.get(k).bytes.byteOffset, r2.get(k).bytes.byteOffset + r2.get(k).bytes.byteLength) } : null), put: async (k, body, o) => { r2.set(k, { bytes: new Uint8Array(body), type: o?.httpMetadata?.contentType }); }, list: async ({ limit = 1000, cursor } = {}) => { const p = page([...r2.keys()].sort(), limit, cursor); return { objects: p.slice.map((key) => ({ key, size: r2.get(key).bytes.length })), truncated: p.more, cursor: p.cursor }; } },
    };
    return { db, env, kv, r2 };
  };

  // ---- the source: real data is awkward ----------------------------------------------------------------------------------------------------------------------
  const big = 'x'.repeat(50000);
  const S = makeSide((db) => {
    db.exec("ALTER TABLE tasks ADD COLUMN priority TEXT");                                               // a column a lazy ALTER added
    db.exec("CREATE TABLE lazy_things (id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT)");                // a table created on first use
    db.exec("CREATE TABLE admin_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, route TEXT)"); db.exec("INSERT INTO admin_audit (route) VALUES ('/debug/x')");   // telemetry: never moved
    const cust = db.prepare('INSERT INTO customers (name, address, retention_percent) VALUES (?, ?, ?)');
    cust.run("O'Brien \"Big\" Dlamini", '1 Main Rd', 7.5); cust.run('José 🙂 Ñandú', null, null); cust.run('multi\nline\ttab', big, 0.1); cust.run('Plain Name', '', 10); cust.run('Deleted Soon', 'x', null);
    db.exec("DELETE FROM customers WHERE name = 'Deleted Soon'");                                          // the highest id is gone: the counter must still say 5
    const task = db.prepare('INSERT INTO tasks (description, done, priority) VALUES (?, ?, ?)'); task.run('call Jenny', 0, 'high'); task.run('quote "carpet" ✓', 1, null);
    db.prepare('INSERT INTO expenses (description, source_transcript, amount) VALUES (?, ?, ?)').run('fuel', 'spent R850 on fuel', 850.25);
    db.prepare('INSERT INTO stock_items (name, unit, quantity_on_hand) VALUES (?, ?, ?)').run('Underlay', 'm2', 12.5);
    db.exec("INSERT INTO lazy_things (label) VALUES ('one'), ('two')");
  });
  for (let i = 1; i <= 250; i++) S.kv.set(`customer:${i}`, JSON.stringify({ id: i, note: `note ${i} 🙂 "quoted"`, n: i * 1.5 }));
  S.kv.set('life:2026-10-01', JSON.stringify([{ text: 'a\nb' }]));
  for (let i = 1; i <= 130; i++) { const bytes = new Uint8Array(200 + i); for (let j = 0; j < bytes.length; j++) bytes[j] = (i * 31 + j * 7) & 255; S.r2.set(`${['voice-notes', 'documents', 'photos', 'logos'][i % 4]}/file-${i}.bin`, { bytes, type: i % 2 ? 'audio/mp4' : 'image/png' }); }

  // ---- the manifest ---------------------------------------------------------------------------------------------------------------------------------------------------
  const m = await mg.manifest(S.env);
  const names = m.tables.map((t) => t.name);
  check(names.includes('customers') && names.includes('lazy_things') && !names.includes('admin_audit') && !names.includes('object_meta') && !names.some((n) => n.startsWith('sqlite_')), 'the manifest lists the business\'s tables (including one created on first use) and never the telemetry or the shared layer');
  check(m.tables.find((t) => t.name === 'customers').count === 4 && m.tables.find((t) => t.name === 'customers').rowidAlias === true && m.tables.find((t) => t.name === 'payments').parents.length === 1, 'it reports each table\'s row count, whether its id is the rowid, and which tables it references');
  check(m.sequences.find((s) => s.name === 'customers').seq === 5, 'it reports the id counters: customers is at 5 although the highest remaining id is 4');

  // ---- the copy (what the runner does, in-process) ---------------------------------------------------------------------------------------------------------------
  const T = makeSide();
  const schema = await mg.ensureSchema(T.env, m.tables.map((t) => ({ name: t.name, sql: t.sql, columns: t.columns })));
  check(schema.created.includes('lazy_things') && schema.columnsAdded.some((c) => c.table === 'tasks' && c.column === 'priority'), 'the target gets the table that was created on first use and the column that was added later');
  const order = []; const todo = new Set(names);
  while (todo.size) { const next = [...todo].find((n) => m.tables.find((t) => t.name === n).parents.every((p) => !todo.has(p) || p === n)); if (!next) throw new Error('cycle'); order.push(next); todo.delete(next); }
  const copy = async () => { for (const name of order) { let after = 0; for (;;) { const p = await mg.readRows(S.env, name, after, 2); if (!p.rows.length) break; await mg.writeRows(T.env, name, p.rows); after = p.last; } } await mg.writeSequences(T.env, m.sequences); let c = null; do { const pg = await mg.readNotes(S.env, c); await mg.writeNotes(T.env, pg.entries); c = pg.cursor; } while (c); let fc = null; do { const pg = await mg.listFiles(S.env, fc); for (const o of pg.objects) { const f = await S.env.OFFICE_VAULT.get(o.key); await T.env.OFFICE_VAULT.put(o.key, await f.arrayBuffer(), { httpMetadata: { contentType: f.httpMetadata.contentType } }); } fc = pg.cursor; } while (fc); };
  await copy();
  const fs1 = await mg.fingerprint(S.env), ft1 = await mg.fingerprint(T.env);
  const diff = mg.compareFingerprints(fs1, ft1);
  check(diff.length === 0, `after the copy the two sides have IDENTICAL fingerprints for every table, the notes and the files (differences: ${diff.join('; ') || 'none'})`);
  check(fs1.notes.count === 251 && fs1.files.count === 130 && fs1.tables.customers.count === 4 && ft1.notes.count === 251 && ft1.files.count === 130, 'including more than one page of notes (251) and files (130), copied page by page');
  check(!('admin_audit' in ft1.tables) && T.db.prepare("SELECT name FROM sqlite_master WHERE name = 'admin_audit'").all().length === 0, 'the telemetry table was not copied');

  // ---- the details that make a migration safe -----------------------------------------------------------------------------------------------------------------
  const row = T.db.prepare("SELECT * FROM customers WHERE name LIKE 'multi%'").get();
  check(row.address === big && T.db.prepare("SELECT address FROM customers WHERE name LIKE 'Jos%'").get().address === null && T.db.prepare("SELECT name FROM customers WHERE name LIKE 'O%'").get().name === 'O\'Brien "Big" Dlamini' && T.db.prepare('SELECT retention_percent AS r FROM customers WHERE id = 1').get().r === 7.5, 'quotes, emoji, newlines, NULLs, decimals and a 50 KB text arrive exactly');
  T.db.prepare('INSERT INTO customers (name) VALUES (?)').run('Brand New');
  check(T.db.prepare("SELECT id FROM customers WHERE name = 'Brand New'").get().id === 6, 'the id counter moved across: a new customer gets id 6, NOT the deleted customer\'s 5 (which would inherit that customer\'s old notes)');
  check(new Uint8Array(await (await T.env.OFFICE_VAULT.get('voice-notes/file-4.bin')).arrayBuffer()).every((b, j) => b === ((4 * 31 + j * 7) & 255)) && (await T.env.OFFICE_VAULT.get('documents/file-1.bin')).httpMetadata.contentType === 'audio/mp4', 'binary files arrive byte for byte with their content type');
  const before = JSON.stringify(ft1);
  await copy();
  check(JSON.stringify(await mg.fingerprint(T.env)).replace(/"sequences".*?\}/, '') === before.replace(/"sequences".*?\}/, '') || mg.compareFingerprints(fs1, await mg.fingerprint(T.env)).filter((d) => !/Brand New|customers/.test(d)).length === 0, 'running the whole copy a second time changes nothing (an interrupted run is simply run again)');

  // ---- the fingerprint notices a difference ---------------------------------------------------------------------------------------------------------------------
  const T2 = makeSide(); await mg.ensureSchema(T2.env, m.tables.map((t) => ({ name: t.name, sql: t.sql, columns: t.columns }))); T.db = T.db;
  const recopy = async (env) => { for (const name of order) { let after = 0; for (;;) { const p = await mg.readRows(S.env, name, after, 50); if (!p.rows.length) break; await mg.writeRows(env, name, p.rows); after = p.last; } } await mg.writeSequences(env, m.sequences); for (const [k, v] of S.kv) await env.CUSTOMER_NOTES.put(k, v); for (const [k, f] of S.r2) await env.OFFICE_VAULT.put(k, f.bytes.buffer.slice(f.bytes.byteOffset, f.bytes.byteOffset + f.bytes.byteLength), { httpMetadata: { contentType: f.type } }); };
  await recopy(T2.env);
  check(mg.compareFingerprints(fs1, await mg.fingerprint(T2.env)).length === 0, 'a fresh copy matches (the baseline for the next checks)');
  const broken = async (label, tamper, expect) => { const X = makeSide(); await mg.ensureSchema(X.env, m.tables.map((t) => ({ name: t.name, sql: t.sql, columns: t.columns }))); await recopy(X.env); await tamper(X); const d = mg.compareFingerprints(fs1, await mg.fingerprint(X.env)); check(d.length > 0 && expect.test(d.join(';')), `the fingerprint notices ${label}`); };
  await broken('ONE changed cell', (X) => X.db.prepare("UPDATE customers SET address = 'changed' WHERE id = 1").run(), /customers: same row count \(4\) but the contents differ/);
  await broken('a missing row', (X) => X.db.prepare('DELETE FROM tasks WHERE id = 2').run(), /tasks: 2 rows in the source, 1 in the target/);
  await broken('an extra row', (X) => X.db.prepare("INSERT INTO stock_items (name, quantity_on_hand) VALUES ('extra', 1)").run(), /stock_items: 1 rows in the source, 2 in the target/);
  await broken('one changed note', (X) => X.kv.set('customer:7', 'tampered'), /notes: same count \(251\) but the contents differ/);
  await broken('one changed byte in one file', (X) => { const f = X.r2.get('photos/file-2.bin'); f.bytes[5] ^= 1; }, /files: same count \(130\) but the contents differ/);
  await broken('a missing file', (X) => X.r2.delete('logos/file-3.bin'), /files: 130 in the source, 129 in the target/);
  await broken('an id counter that fell behind', (X) => X.db.prepare("UPDATE sqlite_sequence SET seq = 3 WHERE name = 'customers'").run(), /id counter customers: 5 in the source, 3 in the target/);

  // ---- nothing is taken on trust --------------------------------------------------------------------------------------------------------------------------------
  const rejects = async (fn) => { try { await fn(); return null; } catch (e) { return String(e.message); } };
  check(/no such table/.test(await rejects(() => mg.readRows(S.env, 'customers; DROP TABLE customers', 0, 10))) && /no such table/.test(await rejects(() => mg.readRows(S.env, 'sqlite_master', 0, 10))) && /no such table/.test(await rejects(() => mg.readRows(S.env, 'admin_audit', 0, 10))) && /no such table/.test(await rejects(() => mg.writeRows(T.env, 'customers" --', [{ id: 1 }]))), 'a table name is only used if it is found in the database: injection, the system tables and the telemetry are all refused');
  check(/has no column/.test(await rejects(() => mg.writeRows(T.env, 'customers', [{ id: 99, name: 'x', 'name") VALUES (1); DROP TABLE tasks; --': 1 }]))), 'a column name is only used if the table has it');
  const evil = (name, sql) => rejects(() => mg.ensureSchema(T.env, [{ name, sql, columns: [] }]));
  check(/refusing/.test(await evil('evil_t', 'CREATE TABLE evil_t (a INTEGER); DROP TABLE customers')) && /refusing/.test(await evil('evil_t', 'CREATE TABLE other_name (a INTEGER)')) && /refusing/.test(await evil('evil_t', 'DROP TABLE customers')) && /not a table a migration may create/.test(await evil('admin_audit', 'CREATE TABLE admin_audit (a INTEGER)')) && T.db.prepare("SELECT COUNT(*) AS n FROM customers").get().n === 5, 'the schema step runs only a plain CREATE TABLE for the table it names, one statement, never telemetry; the data survives every attempt');
  check((await mg.readRows(S.env, 'tasks', 0, 5000)).rows.length === 2 && (await mg.readRows(S.env, 'customers', 0, 2)).rows.length === 2 && (await mg.readRows(S.env, 'customers', 4, 10)).rows.length === 0, 'a page is bounded, and paging past the last row returns nothing');
  check(/not a table with a counter/.test(await rejects(() => mg.writeSequences(T.env, [{ name: 'nope', seq: 1 }]))) && /needs a key/.test(await rejects(() => mg.writeNotes(T.env, [{ key: '', value: 'x' }]))), 'counters and notes are validated too');

  // ---- the routes ----------------------------------------------------------------------------------------------------------------------------------------------------------
  const tiers = fs.readFileSync(path.join(srcDir, 'admin-routes.ts'), 'utf8');
  const migRoutes = [...tiers.matchAll(/"((?:GET|POST) \/admin\/migration\/[a-z-]+)": "(\w+)"/g)];
  check(migRoutes.length === 14 && migRoutes.every((r) => r[2] === 'privileged'), 'all 14 migration routes are PRIVILEGED (both admin keys): they read or write a whole business');
  const routesSrc = fs.readFileSync(path.join(srcDir, 'migration-routes.ts'), 'utf8');
  check(migRoutes.every((r) => routesSrc.includes(`case "${r[1].replace('/admin/migration', '')}"`)), 'and every one of them has a handler');
  check(/migrationRoute\(request, env, url\)/.test(fs.readFileSync(path.join(srcDir, 'debug.ts'), 'utf8')), 'the debug handler calls them');
};
