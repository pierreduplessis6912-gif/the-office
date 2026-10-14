// Schema steps (worker/src/schema.ts, schema-steps.ts, migrations/*.sql). A business's object applies each migration file ONCE, in order, whenever it wakes. These tests pin: the runner (order, once-only,
// recognising an object from before it existed, atomic steps, a failed step reported and recoverable, a column that already exists skipped, never throwing), that the generated files equal the migrations
// folder, and the rule that makes a rollback of the code safe: steps are ADDITIVE (a lint refuses DROP, DELETE, TRUNCATE and RENAME).
const path = require('path'), fs = require('fs'), os = require('os'), esbuild = require('esbuild');
const { DatabaseSync } = require('node:sqlite');

module.exports = async function runSchemaTests(context) {
  const standIn = global.Response;
  if (global.__RealResponse) global.Response = global.__RealResponse;
  try { await schemaTests(context); } finally { global.Response = standIn; }
};

async function schemaTests({ check, srcDir }) {
  const bundle = (entry) => { const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sc-')), 'm.js'); esbuild.buildSync({ entryPoints: [path.join(srcDir, entry)], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent' }); return require(out); };
  const sc = bundle('schema.ts'), gen = bundle('schema-steps.ts'), base = bundle('baseline-sql.ts'), hl = bundle('health.ts'), { DoD1Database } = bundle('storage/do-d1.ts');
  const plain = (r) => (r ? { ...r } : r);
  const makeDb = () => {
    const db = new DatabaseSync(':memory:');
    const sql = { exec(query, ...binds) { const s = db.prepare(query); if (/^\s*(select|with|pragma|values)\b/i.test(query) || /\breturning\b/i.test(query)) { const rows = s.all(...binds).map(plain); return { toArray: () => rows, rowsRead: rows.length, rowsWritten: 0 }; } const r = s.run(...binds); return { toArray: () => [], rowsRead: 0, rowsWritten: Number(r.changes) }; } };
    const storage = { transactionSync(fn) { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } } };
    return { db, d1: new DoD1Database(sql, storage) };
  };
  const step = (version, sqlText) => ({ version, name: `${String(version).padStart(4, '0')}_${sqlText.includes('CREATE') ? 'create' : 'change'}`, sql: sqlText });
  const tables = (db) => db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name);
  const applied = (db) => db.prepare('SELECT version, name FROM schema_steps ORDER BY version').all().map((r) => `${r.version}:${r.name}`);

  // ---- the runner --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const A = makeDb();
  const steps = [step(3, 'ALTER TABLE things ADD COLUMN extra TEXT DEFAULT \'x\';'), step(1, 'CREATE TABLE IF NOT EXISTS things (id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT);'), step(2, 'CREATE INDEX IF NOT EXISTS things_label ON things (label);')];
  const r1 = await sc.migrateSchema(A.d1, steps);
  check(r1.error === null && r1.applied.join() === '0001_create,0002_create,0003_change' && applied(A.db).join() === '1:0001_create,2:0002_create,3:0003_change', 'on a fresh object every step is applied in VERSION order (whatever order they were listed in) and each is recorded');
  const r2 = await sc.migrateSchema(A.d1, steps);
  check(r2.applied.length === 0 && r2.error === null && r2.pending.length === 0, 'run again, nothing is applied: each step runs ONCE');
  A.db.exec("INSERT INTO things (label) VALUES ('a'), ('b')");
  const more = [...steps, step(4, 'ALTER TABLE things ADD COLUMN more TEXT DEFAULT \'y\';')];
  const r3 = await sc.migrateSchema(A.d1, more);
  const rowsNow = A.db.prepare('SELECT label, extra, more FROM things ORDER BY id').all().map(plain);
  check(r3.applied.join() === '0004_change' && rowsNow.length === 2 && rowsNow.every((r) => r.extra === 'x' && r.more === 'y'), 'a NEW step is applied alone to an object that already holds data: the rows are kept and the new column is there with its default (this is what the baseline could never do)');

  // ---- an object from before the runner ------------------------------------------------------------------------------------------------------------------------------------------------------------
  const L = makeDb();
  L.db.exec('CREATE TABLE things (id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT); CREATE TABLE object_meta (key TEXT PRIMARY KEY, value TEXT); INSERT INTO object_meta VALUES (\'schema_version\', \'1\'); INSERT INTO things (label) VALUES (\'keep\');');
  const legacySteps = [{ version: 1, name: '0001_baseline', sql: 'CREATE TABLE things (id INTEGER PRIMARY KEY);' }, step(2, 'ALTER TABLE things ADD COLUMN extra TEXT;')];   // step 1 would FAIL if it were run again
  const rl = await sc.migrateSchema(L.d1, legacySteps);
  check(rl.legacySeeded === true && rl.error === null && rl.applied.join() === '0002_change' && applied(L.db).join() === '1:0001_baseline,2:0002_change' && L.db.prepare('SELECT label FROM things').get().label === 'keep', 'an object from BEFORE the runner (it only knows "schema_version = 1") is recognised as already having the baseline, which is not run again, and the later steps are applied to it');

  // ---- a failed step ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const F = makeDb();
  const brokenSteps = [step(1, 'CREATE TABLE IF NOT EXISTS things (id INTEGER PRIMARY KEY);'), { version: 2, name: '0002_half_done', sql: 'CREATE TABLE IF NOT EXISTS leftover (id INTEGER PRIMARY KEY);\nTHIS IS NOT SQL;' }, step(3, 'CREATE TABLE IF NOT EXISTS after_it (id INTEGER PRIMARY KEY);')];
  const rf = await sc.migrateSchema(F.d1, brokenSteps);
  check(rf.error && rf.error.name === '0002_half_done' && /syntax error/i.test(rf.error.message) && rf.pending.join() === '0002_half_done,0003_create', 'a step that fails is REPORTED (its name and the database\'s own message) with the steps still pending: it is not thrown');
  check(!tables(F.db).includes('leftover') && !tables(F.db).includes('after_it') && applied(F.db).join() === '1:0001_create' && tables(F.db).includes('things'), 'and the step is ATOMIC: the statement before the broken one was undone (no half-applied step), the step is not recorded, and the later step was not attempted; the earlier step stays applied');
  const fixed = [brokenSteps[0], { version: 2, name: '0002_half_done', sql: 'CREATE TABLE IF NOT EXISTS leftover (id INTEGER PRIMARY KEY);' }, brokenSteps[2]];
  const rr = await sc.migrateSchema(F.d1, fixed);
  check(rr.error === null && rr.applied.join() === '0002_half_done,0003_create' && applied(F.db).length === 3, 'once the step is fixed the next run applies it and the rest: a failure is recoverable');

  // ---- tolerances --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const D = makeDb();
  D.db.exec('CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT, Probe_Note TEXT)');
  const rd = await sc.migrateSchema(D.d1, [{ version: 1, name: '0001_x', sql: 'ALTER TABLE customers ADD COLUMN "probe_note" TEXT;\nCREATE TABLE IF NOT EXISTS added_too (id INTEGER PRIMARY KEY);' }]);
  check(rd.error === null && tables(D.db).includes('added_too') && applied(D.db).join() === '1:0001_x', 'a column that ALREADY exists (the application used to add columns lazily) is skipped, whatever its letter case or quoting, and the rest of the step still runs');
  const M = makeDb();
  const rm = await sc.migrateSchema(M.d1, [{ version: 1, name: '0001_x', sql: 'ALTER TABLE no_such_table ADD COLUMN x TEXT;' }]);
  check(rm.error && /no such table/i.test(rm.error.message) && applied(M.db).length === 0, 'but a column added to a table that does not exist is an ERROR (only "already there" is forgiven)');
  const broken = { exec: async () => { throw new Error('the database is down'); }, prepare: () => { throw new Error('the database is down'); }, batch: async () => { throw new Error('the database is down'); } };
  let threw = false, rb = null; try { rb = await sc.migrateSchema(broken, steps); } catch { threw = true; }
  check(!threw && rb.error && rb.error.name === 'schema runner' && /database is down/.test(rb.error.message) && rb.pending.length === 3, 'the runner NEVER throws (an exception in the object\'s constructor would crash-loop it): a database that fails is reported as an error with every step pending');
  const U = makeDb(); await sc.migrateSchema(U.d1, steps); U.db.prepare("INSERT INTO schema_steps (version, name, applied_at) VALUES (99, '0099_from_newer_code', 'x')").run();
  const ru = await sc.migrateSchema(U.d1, steps);
  check(ru.error === null && ru.unknownApplied === 1 && ru.applied.length === 0, 'an object that has applied a step this code does not know (a deploy rolled back to older code) is served as it is and the unknown step is counted, not an error');
  check(sc.splitStatements('-- a comment\nCREATE TABLE a (x TEXT);\n\n  ;\n-- another\nCREATE TABLE b (y TEXT);').join('|') === 'CREATE TABLE a (x TEXT)|CREATE TABLE b (y TEXT)', 'statements are split on semicolons with comments and blanks dropped');

  // ---- the generated files equal the migrations folder -------------------------------------------------------------------------------------------------------------------------------------------
  const dir = path.join(srcDir, '..', 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  check(files.length >= 1 && files[0] === '0001_baseline.sql' && files.every((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f)) && files.every((f, i) => Number(f.slice(0, 4)) === i + 1), 'the migration files are named NNNN_words.sql, start at 0001_baseline and are numbered without gaps (a new one is the next number)');
  check(gen.SCHEMA_STEPS.length === files.length && gen.SCHEMA_STEPS.every((s, i) => s.name === files[i].replace(/\.sql$/, '') && s.version === i + 1 && s.sql === fs.readFileSync(path.join(dir, files[i]), 'utf8')) && base.BASELINE_SQL === fs.readFileSync(path.join(dir, '0001_baseline.sql'), 'utf8'), 'the generated steps are exactly the migrations folder, file for file (regenerate with node tools/gen-baseline.js after adding one)');

  // ---- steps must be ADDITIVE, so a rollback of the code is safe -----------------------------------------------------------------------------------------------------------------------------
  const lint = (sqlText) => {
    const bad = [];
    for (const st of sc.splitStatements(sqlText)) {
      const s = st.replace(/\s+/g, ' ').trim();
      if (/\b(DROP|DELETE|TRUNCATE|RENAME)\b/i.test(s)) bad.push(`destructive: ${s.slice(0, 60)}`);
      else if (/^CREATE (UNIQUE )?INDEX (?!IF NOT EXISTS)/i.test(s) || /^CREATE TABLE (?!IF NOT EXISTS)/i.test(s)) bad.push(`not idempotent: ${s.slice(0, 60)}`);
      else if (!/^(CREATE TABLE IF NOT EXISTS|CREATE (UNIQUE )?INDEX IF NOT EXISTS|ALTER TABLE \S+ ADD COLUMN|INSERT OR IGNORE|UPDATE) /i.test(s)) bad.push(`not an allowed statement: ${s.slice(0, 60)}`);
    }
    return bad;
  };
  check(lint('DROP TABLE x;').length === 1 && lint('DELETE FROM x;').length === 1 && lint('ALTER TABLE x RENAME TO y;').length === 1 && lint('ALTER TABLE x DROP COLUMN c;').length === 1 && lint('CREATE TABLE x (a INT);').length === 1 && lint('CREATE INDEX i ON x (a);').length === 1 && lint('SELECT 1;').length === 1 && lint('TRUNCATE x;').length === 1, 'the lint itself catches what it exists to catch: DROP, DELETE, TRUNCATE, RENAME, a column drop, a table or index that is not IF NOT EXISTS, anything else');
  check(lint('CREATE TABLE IF NOT EXISTS x (a INT);\nALTER TABLE x ADD COLUMN b TEXT DEFAULT \'q\';\nCREATE INDEX IF NOT EXISTS i ON x (a);\nINSERT OR IGNORE INTO x (a) VALUES (1);\nUPDATE x SET b = \'z\' WHERE b IS NULL;').length === 0, 'and passes the additive statements (create if not exists, add a column, add an index, insert or ignore, a backfill update)');
  const bad = files.slice(1).flatMap((f) => lint(fs.readFileSync(path.join(dir, f), 'utf8')).map((m) => `${f}: ${m}`));
  check(bad.length === 0, `every migration after the baseline is ADDITIVE, so the code can be rolled back while objects are on newer steps${bad.length ? ': ' + bad.join('; ') : ''}`);

  // ---- the health report -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const H = makeDb(); H.db.exec('CREATE TABLE object_meta (key TEXT PRIMARY KEY, value TEXT)');
  const before = (await hl.healthReport({ OFFICE_DB: H.d1, BUSINESS_ID: 'zulu-co' })).schema;
  await sc.migrateSchema(H.d1, gen.SCHEMA_STEPS);
  const after = (await hl.healthReport({ OFFICE_DB: H.d1, BUSINESS_ID: 'zulu-co' })).schema;
  H.db.prepare("INSERT INTO object_meta (key, value) VALUES ('schema_error', ?), ('last_schema_migration', ?)").run(JSON.stringify({ name: '0002_x', message: 'boom', pending: ['0002_x'] }), JSON.stringify({ at: 'now', applied: ['0001_baseline'] }));
  const failed = (await hl.healthReport({ OFFICE_DB: H.d1, BUSINESS_ID: 'zulu-co' })).schema;
  check(before.pending.length === gen.SCHEMA_STEPS.length && after.pending.length === 0 && after.appliedSteps === gen.SCHEMA_STEPS.length && after.latestKnownStep === gen.SCHEMA_STEPS[gen.SCHEMA_STEPS.length - 1].version && failed.error.name === '0002_x' && failed.lastMigration.applied[0] === '0001_baseline', 'the health report shows which steps are applied and pending, the newest step this code knows, the last migration, and a failure with its step and message');
}
