// A business's Durable Object (worker/src/business-object.ts), architecture stage 1. It runs the application's real request pipeline over its own SQLite. Here it is run against a
// stand-in for the object's storage: the schema exists before anything is served, a second wake does not redo it, tables created later get their indexes, two businesses cannot see each
// other, and there is exactly one copy of the pipeline (the Worker's own).
const path = require('path'), fs = require('fs'), os = require('os'), esbuild = require('esbuild');
const { DatabaseSync } = require('node:sqlite');

module.exports = async function runBusinessObjectTests({ check, srcDir }) {
  const bundle = (entry) => { const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bo-')), 'm.js'); esbuild.buildSync({ entryPoints: [path.join(srcDir, entry)], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent' }); return require(out); };
  const bo = bundle('business-object.ts');
  const baseline = bundle('baseline-sql.ts');
  const { INDEXES } = bundle('indexes.ts');
  const plain = (r) => (r ? { ...r } : r);

  // a stand-in for what a Durable Object gives its code: ctx.storage.sql (one statement per exec), transactionSync, blockConcurrencyWhile and waitUntil
  const makeState = (db) => {
    const waited = [];
    const sql = { exec(query, ...binds) { const s = db.prepare(query); if (/^\s*(select|with|pragma|values)\b/i.test(query) || /\breturning\b/i.test(query)) { const rows = s.all(...binds).map(plain); return { toArray: () => rows, rowsRead: rows.length, rowsWritten: 0 }; } const r = s.run(...binds); return { toArray: () => [], rowsRead: 0, rowsWritten: Number(r.changes) }; } };
    const storage = { sql, transactionSync(fn) { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } } };
    return { state: { storage, blockConcurrencyWhile: (fn) => fn(), waitUntil: (p) => waited.push(p) }, waited };
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
  const reply = await objA.fetch({ url: 'https://x/health', method: 'GET' });
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
  await objB.fetch({ url: 'https://x/health', method: 'GET' });
  check(dbB.prepare('SELECT COUNT(*) AS n FROM customers').get().n === 0 && dbA.prepare('SELECT COUNT(*) AS n FROM customers').get().n === 1, 'two businesses are two separate databases: one cannot see the other\'s customer');

  // ---- the schema source -----------------------------------------------------------------------------------------------------------------------
  const migration = fs.readFileSync(path.join(srcDir, '..', 'migrations', '0001_baseline.sql'), 'utf8');
  check(baseline.BASELINE_SQL === migration, 'the baseline an object creates is exactly the migration file (regenerate with node tools/gen-baseline.js)');
  const statements = bo.splitStatements(migration);
  check(statements.length === 41 && statements.every((s) => /^CREATE TABLE IF NOT EXISTS/i.test(s) && !s.includes(';')), 'the baseline splits into 41 CREATE TABLE IF NOT EXISTS statements, so applying it is safe to repeat');
  check(!/create trigger/i.test(migration) && !/'[^'\n]*;[^'\n]*'/.test(migration), 'and it has no trigger and no semicolon inside a string, the two things that would make splitting on ";" unsafe');

  // ---- one copy of the pipeline ------------------------------------------------------------------------------------------------------------------
  const indexSrc = fs.readFileSync(path.join(srcDir, 'index.ts'), 'utf8');
  const objectSrc = fs.readFileSync(path.join(srcDir, 'business-object.ts'), 'utf8').replace(/\/\/.*$/gm, '');
  check((indexSrc.match(/export async function serveRequest\(/g) || []).length === 1 && (indexSrc.match(/\brunGuarded\(/g) || []).length === 1 && /export const BusinessObject = makeBusinessObject\(serveRequest\);/.test(indexSrc), 'the Worker and the object run the SAME pipeline function (serveRequest), handed to the object by the entry module');
  check(!/runGuarded|handleRequest|corsHeadersFor|recordTiming|instrumentEnv/.test(objectSrc), 'the business object contains no copy of any part of the pipeline: it only supplies the database and the schema');
  const entry = indexSrc.slice(indexSrc.indexOf('export default {'), indexSrc.indexOf('async scheduled('));
  check(/if \(env\.BUSINESS_MODE === "object" && env\.BUSINESS\) \{\s*(\/\/[^\n]*\n\s*)*if \(request\.method === "OPTIONS"\) return new Response\(null, \{ status: 204, headers: corsHeadersFor\(request\) \}\);\s*return forwardToBusiness\(request, env\);\s*\}\s*return serveRequest\(request, env, ctx\);/.test(entry), 'the Worker forwards to the object ONLY when the mode is "object" and the object exists; otherwise it serves as it always did (and a preflight never goes to the object)');
  check(/idFromName\(env\.BUSINESS_OBJECT_NAME \?\? "business-default"\)/.test(indexSrc) && /locationHint: "weur"/.test(indexSrc), 'stage 1 uses one named object, placed in Western Europe');
  const cfgFile = path.join(srcDir, '..', 'wrangler.toml');
  if (fs.existsSync(cfgFile)) { const cfg = fs.readFileSync(cfgFile, 'utf8'); check(!/BUSINESS/.test(cfg), 'production\'s configuration has no business object and no BUSINESS_MODE: stage 1 is staging only, production is unchanged'); }
};
