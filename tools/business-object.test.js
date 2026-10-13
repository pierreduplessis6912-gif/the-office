// A business's Durable Object (worker/src/business-object.ts), architecture stage 1. It runs the application's real request pipeline over its own SQLite. Here it is run against a
// stand-in for the object's storage: the schema exists before anything is served, a second wake does not redo it, tables created later get their indexes, two businesses cannot see each
// other, and there is exactly one copy of the pipeline (the Worker's own).
const path = require('path'), fs = require('fs'), os = require('os'), esbuild = require('esbuild');
const { DatabaseSync } = require('node:sqlite');

// The object answers a request that names no business, or the wrong one, with a real Response; the permission tests swap in a bare stand-in, so the real one is used for the duration.
module.exports = async function runBusinessObjectTests(context) {
  const standIn = global.Response;
  if (global.__RealResponse) global.Response = global.__RealResponse;
  try { await businessObjectTests(context); } finally { global.Response = standIn; }
};

async function businessObjectTests({ check, srcDir }) {
  const bundle = (entry) => { const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bo-')), 'm.js'); esbuild.buildSync({ entryPoints: [path.join(srcDir, entry)], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent' }); return require(out); };
  const bo = bundle('business-object.ts');
  const baseline = bundle('baseline-sql.ts');
  const { INDEXES } = bundle('indexes.ts');
  const plain = (r) => (r ? { ...r } : r);

  // a stand-in for what a Durable Object gives its code: ctx.storage.sql (one statement per exec), transactionSync, blockConcurrencyWhile and waitUntil
  const makeState = (db) => {
    const waited = []; let alarmAt = null, alarmSets = 0;
    const sql = { exec(query, ...binds) { const s = db.prepare(query); if (/^\s*(select|with|pragma|values)\b/i.test(query) || /\breturning\b/i.test(query)) { const rows = s.all(...binds).map(plain); return { toArray: () => rows, rowsRead: rows.length, rowsWritten: 0 }; } const r = s.run(...binds); return { toArray: () => [], rowsRead: 0, rowsWritten: Number(r.changes) }; } };
    const storage = { sql, transactionSync(fn) { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } }, getAlarm: async () => alarmAt, setAlarm: async (t) => { alarmAt = t; alarmSets++; } };
    return { state: { storage, blockConcurrencyWhile: (fn) => fn(), waitUntil: (p) => waited.push(p) }, waited, alarm: () => alarmAt, alarmSets: () => alarmSets };
  };
  const tableNames = (db) => db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
  const indexNames = (db) => new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map((r) => r.name));
  const seen = [];
  const serve = async (request, env, ctx) => { seen.push({ env, ctx, tablesAtServeTime: env.__peek ? env.__peek() : null }); return { status: 200, ok: true, request }; };
  const Business = bo.makeBusinessObject(serve);

  // ---- first wake: the schema exists before anything is served --------------------------------------------------------------------------
  const dbA = new DatabaseSync(':memory:'); const A = makeState(dbA);
  const workerEnv = { ADMIN_KEY: 'k', AI: 'the-ai-binding', OFFICE_DB: 'the-workers-own-d1', SESSION_SECRET: 's' };
  const objA = new Business(A.state, { ...workerEnv, __peek: () => tableNames(dbA).length });
  const named = (id) => ({ url: 'https://x/health', method: 'GET', headers: new Headers(id ? { 'X-Business-Id': id } : {}) });
  const reply = await objA.fetch(named('alpha-co'));
  check(reply.status === 200 && seen.length === 1, 'the object serves a request through the application\'s pipeline function');
  check(seen[0].tablesAtServeTime >= 42, `the tables already exist when the first request is served (tables: ${seen[0].tablesAtServeTime})`);
  check(tableNames(dbA).filter((t) => !t.startsWith('sqlite_')).length === 42 && dbA.prepare("SELECT value FROM object_meta WHERE key = 'schema_version'").get().value === '1', 'a new object creates the 41 baseline tables (and its own small meta table) and records its schema version');
  const idx = indexNames(dbA);
  check(idx.has('idx_customers_name') && idx.has('idx_job_scopes_customer') && idx.has('idx_tasks_open') && !idx.has('idx_po_customers_customer'), 'and the indexes for the tables that exist (an index for a table created later waits for it)');

  // ---- what the pipeline is handed ---------------------------------------------------------------------------------------------------------
  const env = seen[0].env;
  check(env.OFFICE_DB !== 'the-workers-own-d1' && typeof env.OFFICE_DB.prepare === 'function' && env.OFFICE_DB.constructor.name === 'DoStatement' === false, 'the pipeline gets THIS object\'s database in place of the Worker\'s');
  await env.OFFICE_DB.prepare("INSERT INTO customers (name) VALUES (?)").bind('Jenny Smith').run();
  check(dbA.prepare('SELECT COUNT(*) AS n FROM customers').get().n === 1 && (await env.OFFICE_DB.prepare('SELECT name FROM customers').first('name')) === 'Jenny Smith', 'a write through it lands in this object\'s own storage');
  check(env.ADMIN_KEY === 'k' && env.AI === 'the-ai-binding' && env.SESSION_SECRET === 's', 'every other binding and secret is passed through unchanged (the model, the notes store, the keys)');
  const marker = Promise.resolve(1); seen[0].ctx.waitUntil(marker);
  check(A.waited.includes(marker) && typeof seen[0].ctx.passThroughOnException === 'function', 'background work the pipeline starts (timing, the admin audit) is kept alive by the object');

  // ---- an object belongs to exactly one business ----------------------------------------------------------------------------------------------
  check(env.BUSINESS_ID === 'alpha-co', 'the pipeline is told which business it is serving (BUSINESS_ID), taken from the Worker\'s header and never from a client');
  const before = seen.length;
  const none = await objA.fetch(named(null)); const bad = await objA.fetch(named('NOT a valid id!'));
  check(none.status === 400 && bad.status === 400 && seen.length === before, 'a request that names no business, or an invalid one, is refused and never reaches the pipeline');
  check(dbA.prepare("SELECT value FROM object_meta WHERE key = 'business_id'").get().value === 'alpha-co', 'the first business an object is named for is remembered in its own storage');
  const wrong = await objA.fetch(named('beta-co'));
  check(wrong.status === 403 && (await wrong.json()).error === 'this object belongs to another business' && seen.length === before, 'a request naming ANY OTHER business is refused with a 403 and never reaches the pipeline (so a routing mistake in the Worker cannot make this object serve the wrong business)');
  check((await objA.fetch(named('alpha-co'))).status === 200 && seen.length === before + 1, 'and its own business is served as before');
  const woken = new Business(A.state, workerEnv);
  check((await woken.fetch(named('beta-co'))).status === 403 && (await woken.fetch(named('alpha-co'))).status === 200, 'a fresh wake over the same storage still remembers which business it is');

  // ---- a second wake ---------------------------------------------------------------------------------------------------------------------------
  const again = await bo.ensureObjectSchema(objA.db, workerEnv);
  check(again.appliedBaseline === false && again.indexes.created.length === 0 && dbA.prepare('SELECT COUNT(*) AS n FROM customers').get().n === 1, 'a second wake does not redo the baseline, creates no index twice, and keeps the data');
  dbA.exec('CREATE TABLE purchase_order_customers (purchase_order_id INTEGER, customer_id INTEGER, created_at TEXT)');
  const objA2 = new Business(A.state, workerEnv);
  await objA2.ready;
  check(indexNames(dbA).has('idx_po_customers_customer'), 'a table created on first use since the last wake gets its index on the next wake');

  // ---- two businesses -----------------------------------------------------------------------------------------------------------------------------
  const dbB = new DatabaseSync(':memory:'); const B = makeState(dbB);
  const objB = new Business(B.state, workerEnv);
  await objB.fetch(named('beta-co'));
  check(dbB.prepare('SELECT COUNT(*) AS n FROM customers').get().n === 0 && dbA.prepare('SELECT COUNT(*) AS n FROM customers').get().n === 1, 'two businesses are two separate databases: one cannot see the other\'s customer');

  // ---- the hourly job, inside the business's own object ---------------------------------------------------------------------------------------------------------------
  const ran = [];
  const upserts = [];
  const jobEnv = { ...workerEnv, MEMORY: { upsert: async (vs) => { upserts.push(...vs); return { mutationId: 'm1' }; } }, CUSTOMER_NOTES: { put: async () => {} } };
  const BusinessJ = bo.makeBusinessObject(serve, { consolidate: async (e) => { ran.push(e); await e.MEMORY.upsert([{ id: 'pmf-1', values: [1], metadata: {} }]); } });
  const dbJ = new DatabaseSync(':memory:'); const J = makeState(dbJ);
  const objJ = new BusinessJ(J.state, jobEnv);
  check(J.alarm() === null && J.alarmSets() === 0, 'an object nobody has used arms no alarm (nothing runs for a business that has no activity)');
  const t0 = Date.now(); await objJ.fetch(named('alpha-co')); await objJ.fetch(named('alpha-co')); await objJ.fetch(named('alpha-co'));
  check(J.alarmSets() === 1 && J.alarm() >= t0 + 60_000 && J.alarm() <= Date.now() + bo.jitterMs('alpha-co') + 61_000, 'once it is used and named, the object arms its OWN hourly alarm exactly once (not on every request), spread by its name');
  check(bo.jitterMs('alpha-co') === bo.jitterMs('alpha-co') && new Set(['a1', 'b2', 'zulu-co', 'alpha-co', 'beta-co', 'x9z'].map(bo.jitterMs)).size >= 4 && ['a1', 'zulu-co'].every((id) => bo.jitterMs(id) >= 0 && bo.jitterMs(id) < 3_000_000), 'the spread is deterministic per business and different between businesses (a thousand businesses do not wake in the same minute)');
  await objJ.alarm();
  check(ran.length === 1 && ran[0].BUSINESS_ID === 'alpha-co' && ran[0].OFFICE_DB.constructor.name !== 'String' && typeof ran[0].OFFICE_DB.prepare === 'function' && ran[0].OFFICE_DB !== workerEnv.OFFICE_DB, 'when the alarm fires the application\'s job runs with THIS business\'s database and its name');
  check(upserts.length === 1 && upserts[0].id === bundle('scoped-bindings.ts').vectorPrefix('alpha-co') + 'pmf-1' && upserts[0].namespace === 'alpha-co', 'and its memory writes are confined to the business (prefixed id, its own namespace): the job cannot touch another business\'s memories');
  check(J.alarmSets() === 2 && J.alarm() >= Date.now() + 3_599_000, 'afterwards the next hourly alarm is armed');
  const failing = bo.makeBusinessObject(serve, { consolidate: async () => { throw new Error('embedding failed'); } });
  const dbF = new DatabaseSync(':memory:'); const F = makeState(dbF); const objF = new failing(F.state, jobEnv);
  await objF.fetch(named('beta-co')); const alarmsBefore = F.alarmSets();
  const quiet = console.error; const logged = []; console.error = (m) => logged.push(m);
  try { await objF.alarm(); } finally { console.error = quiet; }
  check(F.alarmSets() === alarmsBefore + 1 && logged.length === 1 && /embedding failed/.test(logged[0]), 'if the job FAILS, the failure is logged and the next alarm is still armed (one bad hour cannot stop a business\'s memories for good, nor retry in a tight loop)');
  const dbU = new DatabaseSync(':memory:'); const U = makeState(dbU); const unnamed = new BusinessJ(U.state, jobEnv); const before2 = ran.length;
  await unnamed.alarm();
  check(ran.length === before2, 'an alarm in an object that was never named runs nothing');
  check(/async scheduled\([^)]*\)[^{]*\{\s*(\/\/[^\n]*\n\s*)*if \(env\.BUSINESS_MODE === "object"\) return;\s*ctx\.waitUntil\(runConsolidation\(env\)/.test(fs.readFileSync(path.join(srcDir, 'index.ts'), 'utf8')), 'the Worker\'s own hourly cron does nothing in object mode (each business\'s object runs its own), and runs exactly as before without objects');
  check(/makeBusinessObject\(serveRequest, \{ consolidate: runConsolidation, backup: \(env\) => takeSnapshot\(env\) \}\)/.test(fs.readFileSync(path.join(srcDir, 'index.ts'), 'utf8')), 'the entry module hands the object the application\'s own consolidation (the one the Worker\'s cron runs today)');

  // ---- the daily backup, run from the hourly alarm; and the restore lock ----------------------------------------------------------------------------------------------------------------
  const orderBk = [], backupEnvsBk = [];
  const BusinessBBk = bo.makeBusinessObject(serve, { consolidate: async () => { orderBk.push('consolidate'); }, backup: async (e) => { orderBk.push('backup'); backupEnvsBk.push(e); } });
  const bucketEnvBk = { ...jobEnv, BACKUPS: { marker: 'the-backup-bucket' } };
  const dbBBk = new DatabaseSync(':memory:'); const BsBk = makeState(dbBBk); const objBBk = new BusinessBBk(BsBk.state, bucketEnvBk);
  const bmetaBk = (k) => dbBBk.prepare('SELECT value FROM object_meta WHERE key = ?').get(k)?.value ?? null;
  await objBBk.fetch(named('alpha-co')); await objBBk.alarm();
  check(orderBk.join() === 'consolidate,backup' && backupEnvsBk[0].BUSINESS_ID === 'alpha-co' && backupEnvsBk[0].BACKUPS.marker === 'the-backup-bucket' && backupEnvsBk[0].OFFICE_DB !== workerEnv.OFFICE_DB, 'the first hourly alarm runs the hourly job and then the DAILY BACKUP, with this business\'s own database and the backup bucket');
  check(bmetaBk('last_backup_ok') === '1' && bmetaBk('last_backup_error') === '' && Number.isFinite(Date.parse(bmetaBk('last_backup_success_at'))), 'its success is recorded in the object, so it can be asked and an alert can see it');
  await objBBk.alarm();
  check(orderBk.join() === 'consolidate,backup,consolidate', 'the next hour it does NOT back up again (a backup is due only after about 20 hours)');
  dbBBk.prepare("UPDATE object_meta SET value = ? WHERE key = 'last_backup_success_at'").run(new Date(Date.now() - 21 * 3_600_000).toISOString());
  await objBBk.alarm();
  check(orderBk.join() === 'consolidate,backup,consolidate,consolidate,backup', 'and once 21 hours have passed it is due again');
  // a failing backup
  const failOrderBk = [];
  const BusinessCBk = bo.makeBusinessObject(serve, { consolidate: async () => { failOrderBk.push('consolidate'); }, backup: async () => { failOrderBk.push('backup'); throw new Error('the backup bucket is unreachable'); } });
  const dbCBk = new DatabaseSync(':memory:'); const CsBk = makeState(dbCBk); const objCBk = new BusinessCBk(CsBk.state, bucketEnvBk);
  await objCBk.fetch(named('beta-co')); const setsBeforeBk = CsBk.alarmSets();
  const quiet2Bk = console.error; const logged2Bk = []; console.error = (m) => logged2Bk.push(m);
  try { await objCBk.alarm(); await objCBk.alarm(); } finally { console.error = quiet2Bk; }
  const cmetaBk = (k) => dbCBk.prepare('SELECT value FROM object_meta WHERE key = ?').get(k)?.value ?? null;
  check(failOrderBk.join() === 'consolidate,backup,consolidate,backup' && cmetaBk('last_backup_ok') === '0' && /unreachable/.test(cmetaBk('last_backup_error')) && cmetaBk('last_backup_success_at') === null, 'a FAILED backup is recorded (that it failed, why, and that there has been no success) and is tried again the next hour');
  check(CsBk.alarmSets() === setsBeforeBk + 2 && logged2Bk.length === 2 && /daily backup failed/.test(logged2Bk[0]), 'a failed backup is logged, and the next alarm is still armed');
  const order2Bk = [];
  const BusinessDBk = bo.makeBusinessObject(serve, { consolidate: async () => { throw new Error('embedding failed'); }, backup: async () => { order2Bk.push('backup'); } });
  const dbDBk = new DatabaseSync(':memory:'); const DsBk = makeState(dbDBk); const objDBk = new BusinessDBk(DsBk.state, bucketEnvBk);
  await objDBk.fetch(named('gamma-co'));
  const quiet3Bk = console.error; console.error = () => {};
  try { await objDBk.alarm(); } finally { console.error = quiet3Bk; }
  check(order2Bk.join() === 'backup', 'a failing hourly job does NOT stop the daily backup (they cannot stop each other)');
  const order3Bk = [];
  const BusinessEBk = bo.makeBusinessObject(serve, { consolidate: async () => {}, backup: async () => { order3Bk.push('backup'); } });
  const dbEBk = new DatabaseSync(':memory:'); const EsBk = makeState(dbEBk); const objEBk = new BusinessEBk(EsBk.state, jobEnv);
  await objEBk.fetch(named('delta-co')); await objEBk.alarm();
  check(order3Bk.length === 0, 'with no backup bucket configured, no backup is attempted');
  // the restore lock
  dbBBk.prepare("INSERT INTO object_meta (key, value) VALUES ('restoring', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
  const adminReqBk = { url: 'https://x/admin/backup/status', method: 'GET', headers: new Headers({ 'X-Business-Id': 'alpha-co' }) };
  const seenBeforeLockBk = seen.length;
  const lockedBk = await objBBk.fetch(named('alpha-co')), lockedBodyBk = await lockedBk.json(), servedBeforeBk = seen.length;
  const adminGotBk = await objBBk.fetch(adminReqBk);
  check(lockedBk.status === 503 && lockedBk.headers.get('Retry-After') === '60' && lockedBodyBk.restoring === true && /being restored/.test(lockedBodyBk.error) && servedBeforeBk === seenBeforeLockBk, 'while a restore is running everyone but an administrator is turned away with a clear 503, and the request never reaches the application');
  check(adminGotBk.status === 200 && seen.length === servedBeforeBk + 1, 'an administrator is NOT lockedBk out (the restore itself, and unlock, are admin calls)');
  dbBBk.prepare("UPDATE object_meta SET value = '0' WHERE key = 'restoring'").run();
  check((await objBBk.fetch(named('alpha-co'))).status === 200, 'and once the restore finishes the business is served again');

  // ---- the hourly job's outcome is RECORDED in the object, so a job that fails or stops is visible ------------------------------------------------------------------------------------
  const BusinessHl = bo.makeBusinessObject(serve, { consolidate: async () => { await new Promise((r) => setTimeout(r, 5)); } });
  const dbHl = new DatabaseSync(':memory:'); const Hls = makeState(dbHl); const objHl = new BusinessHl(Hls.state, jobEnv);
  const hmeta = (k) => dbHl.prepare('SELECT value FROM object_meta WHERE key = ?').get(k)?.value ?? null;
  await objHl.fetch(named('alpha-co'));
  check(Date.parse(hmeta('next_alarm_at')) > Date.now() && hmeta('last_job_at') === null, 'when the object first arms its alarm it records WHEN it will run, and nothing has run yet');
  await objHl.alarm();
  check(hmeta('last_job_ok') === '1' && hmeta('last_job_error') === '' && Date.now() - Date.parse(hmeta('last_job_at')) < 5000 && Number(hmeta('last_job_ms')) >= 0, 'a successful hourly job records when it ran, that it succeeded, and how long it took');
  check(Date.parse(hmeta('next_alarm_at')) - Date.now() > 3_590_000 && Date.parse(hmeta('next_alarm_at')) - Date.now() <= 3_600_000, 'and when the next run is (an hour away)');
  const BusinessHf = bo.makeBusinessObject(serve, { consolidate: async () => { throw new Error('embedding failed: the model is unreachable'); } });
  const dbHf = new DatabaseSync(':memory:'); const Hfs = makeState(dbHf); const objHf = new BusinessHf(Hfs.state, jobEnv);
  const hfmeta = (k) => dbHf.prepare('SELECT value FROM object_meta WHERE key = ?').get(k)?.value ?? null;
  await objHf.fetch(named('beta-co'));
  const quietHl = console.error; console.error = () => {};
  try { await objHf.alarm(); } finally { console.error = quietHl; }
  check(hfmeta('last_job_ok') === '0' && /model is unreachable/.test(hfmeta('last_job_error')) && Number.isFinite(Date.parse(hfmeta('last_job_at'))), 'a FAILED hourly job is recorded as failed, with its error and when (so it is visible instead of silent)');
  check(Date.parse(hfmeta('next_alarm_at')) > Date.now() + 3_500_000 && Hfs.alarmSets() >= 2, 'and the next alarm is still armed and recorded');
  const dbHu = new DatabaseSync(':memory:'); const Hus = makeState(dbHu); const objHu = new BusinessHl(Hus.state, jobEnv);
  await objHu.alarm();
  check(dbHu.prepare("SELECT value FROM object_meta WHERE key = 'last_job_at'").get() === undefined, 'an object that was never named records no job (nothing ran)');

  // ---- the schema source -----------------------------------------------------------------------------------------------------------------------
  const migration = fs.readFileSync(path.join(srcDir, '..', 'migrations', '0001_baseline.sql'), 'utf8');
  check(baseline.BASELINE_SQL === migration, 'the baseline an object creates is exactly the migration file (regenerate with node tools/gen-baseline.js)');
  const statements = bo.splitStatements(migration);
  check(statements.length === 41 && statements.every((s) => /^CREATE TABLE IF NOT EXISTS/i.test(s) && !s.includes(';')), 'the baseline splits into 41 CREATE TABLE IF NOT EXISTS statements, so applying it is safe to repeat');
  check(!/create trigger/i.test(migration) && !/'[^'\n]*;[^'\n]*'/.test(migration), 'and it has no trigger and no semicolon inside a string, the two things that would make splitting on ";" unsafe');

  // ---- one copy of the pipeline ------------------------------------------------------------------------------------------------------------------
  const indexSrc = fs.readFileSync(path.join(srcDir, 'index.ts'), 'utf8');
  const objectSrc = fs.readFileSync(path.join(srcDir, 'business-object.ts'), 'utf8').replace(/\/\/.*$/gm, '');
  check((indexSrc.match(/export async function serveRequest\(/g) || []).length === 1 && (indexSrc.match(/\brunGuarded\(/g) || []).length === 1 && /export const BusinessObject = makeBusinessObject\(serveRequest, \{ consolidate: runConsolidation, backup: \(env\) => takeSnapshot\(env\) \}\);/.test(indexSrc), 'the Worker and the object run the SAME pipeline function (serveRequest), handed to the object by the entry module');
  check(!/runGuarded|handleRequest|corsHeadersFor|recordTiming|instrumentEnv/.test(objectSrc), 'the business object contains no copy of any part of the pipeline: it only supplies the database and the schema');
  const entry = indexSrc.slice(indexSrc.indexOf('export default {'), indexSrc.indexOf('async scheduled('));
  check(/if \(env\.BUSINESS_MODE === "object" && env\.BUSINESS\) \{[\s\S]*?if \(request\.method === "OPTIONS"\) return new Response\(null, \{ status: 204, headers: corsHeadersFor\(request\) \}\);[\s\S]*?const route = await routeRequest\(request, env\);[\s\S]*?if \(route\.kind === "business"\) return forwardToBusiness\(request, env, route\.businessId\);[\s\S]*?\}\s*return serveRequest\(request, env, ctx\);/.test(entry), 'the Worker routes ONLY when the mode is "object" and the object exists, answers a preflight itself, forwards to a business only on a business route, and otherwise serves as it always did');
  const routingSrc = fs.readFileSync(path.join(srcDir, 'routing.ts'), 'utf8').replace(/\/\/.*$/gm, '');
  check(/headers\.delete\("X-Target-Business"\)/.test(routingSrc) && /headers\.set\("X-Business-Id", businessId\)/.test(routingSrc) && /idFromName\(objectNameFor\(businessId\)\)/.test(routingSrc) && /locationHint: "weur"/.test(routingSrc), 'forwarding overwrites any client-supplied business header, removes the admin targeting header, names the object from the business id, and places it in Western Europe');
  const cfgFile = path.join(srcDir, '..', 'wrangler.toml');
  if (fs.existsSync(cfgFile)) {
    const cfg = fs.readFileSync(cfgFile, 'utf8');
    check(/\[\[durable_objects\.bindings\]\]\s*\nname = "BUSINESS"\s*\nclass_name = "BusinessObject"/.test(cfg) && /tag = "business-v1"\s*\nnew_sqlite_classes = \["BusinessObject"\]/.test(cfg) && cfg.indexOf('tag = "trial-v1"') < cfg.indexOf('tag = "business-v1"'), 'production registers the business object with SQLite storage (a class cannot be switched to SQLite later), after the trial\'s migration');
    const live = cfg.replace(/^\s*#.*$/gm, '');
    check(/\[\[r2_buckets\]\]\s*\nbinding = "BACKUPS"\s*\nbucket_name = "office-backups"/.test(live) && /binding = "OFFICE_VAULT"\s*\nbucket_name = "office-vault"/.test(live), 'production binds a SEPARATE backup bucket (office-backups) beside the files bucket (office-vault)');
    check(/\[\[r2_buckets\]\]\s*\nbinding = "BACKUPS"\s*\nbucket_name = "office-backups"/.test(live) && /binding = "OFFICE_VAULT"\s*\nbucket_name = "office-vault"/.test(live), 'production binds a SEPARATE backup bucket (office-backups) beside the files bucket (office-vault)');
    check(/^BUSINESS_MODE = "object"$/m.test(live) && /^LEGACY_LINK_BUSINESS = "zululand-flooring-and-blinds"$/m.test(live), 'production is CUT OVER (2026-10-13): it serves the business from its object, and that one business honours the links customers already hold');
  }
};
