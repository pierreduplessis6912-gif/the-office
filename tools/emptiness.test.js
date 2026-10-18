// "Is this business EMPTY?" (worker/src/emptiness.ts; SHIP_CHECKLIST.md item 15, the empty-business handover). An employee who signed up for their own trial by mistake can, if THEY agree, move into the business that invited them,
// but only if the one they leave is verifiably empty: nothing is ever merged or deleted, so "empty" must be strict. Measured: a business database has 42 tables and right after signup exactly TWO hold a row (memberships: the owner;
// business_profile: the name). The rule below is built on that, and its safety net is a test that puts one row in EVERY table and requires the answer to flip, so no table can ever be forgotten.
const path = require('path'), fs = require('fs'), os = require('os'), esbuild = require('esbuild');

module.exports = async function runEmptinessTests({ check, srcDir }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'empty-')), out = path.join(dir, 'e.js');
  try { esbuild.buildSync({ entryPoints: [path.join(srcDir, 'emptiness.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent' }); } catch (e) { check(false, 'emptiness.ts exists and builds: ' + String(e.message).split('\n')[0].slice(0, 140)); return; }
  const { businessIsEmpty } = require(out), { newDatabase, d1 } = require('./harness.js'), workerDir = path.join(srcDir, '..');
  const OWNER = 'owner@x.co';
  const fresh = (extra) => { const db = newDatabase(workerDir); db.exec('PRAGMA foreign_keys = OFF'); db.prepare("INSERT INTO memberships (google_email, role, status) VALUES (?, 'owner', 'active')").run(OWNER); db.prepare("INSERT INTO business_profile (id, name) VALUES (1, 'Acme Floors')").run(); if (extra) extra(db); return db; };
  const ask = async (db, who = OWNER) => businessIsEmpty({ OFFICE_DB: d1(db) }, who);

  check((await ask(fresh())).empty === true, 'a business exactly as signup leaves it (the owner\'s membership and the name in the profile) is EMPTY');
  const real = fresh((db) => { db.exec("CREATE TABLE IF NOT EXISTS object_meta (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE IF NOT EXISTS schema_steps (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL); INSERT INTO object_meta VALUES ('business_id', 'acme'); INSERT INTO schema_steps VALUES (1, 'baseline', 'now'), (2, 'onboarding_progress', 'now')"); });
  check((await ask(real)).empty === true, 'and so is a REAL object, which also carries two bookkeeping tables with rows (object_meta, schema_steps): those are ignored, nothing else is');
  // Found by the first real rehearsal: a real object ALSO has these two, written by the platform for every business (signup itself makes two audited calls; RECORD_TIMINGS is on in production). The local test database has neither, so
  // without this every real business looked non-empty and the handover would never have fired.
  const realer = fresh((db) => { db.exec("CREATE TABLE IF NOT EXISTS object_meta (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE IF NOT EXISTS schema_steps (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL); CREATE TABLE admin_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, what TEXT); CREATE TABLE request_timings (id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT); CREATE TABLE member_sign_ins (email TEXT PRIMARY KEY, first_at TEXT NOT NULL, last_at TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 1); INSERT INTO admin_audit (what) VALUES ('create-membership'), ('seed-business-name'); INSERT INTO request_timings (path) VALUES ('/debug/membership-check'), ('/debug/create-membership'); INSERT INTO member_sign_ins VALUES ('owner@x.co', 'now', 'now', 1)"); });
  check((await ask(realer)).empty === true, 'and a real object with the PLATFORM\'s own audit rows (admin_audit: signup makes two privileged calls), request timings (on in production) and the owner\'s own sign-in stamp (member_sign_ins: they signed in to start the business) is still EMPTY');

  // ---- the owner and the profile -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  check((await ask(fresh(), 'someone.else@x.co')).empty === false && (await ask(fresh(), '  OWNER@X.CO ')).empty === true, 'the single member must BE the person asked about (case and spaces do not matter)');
  check((await ask(fresh((db) => db.prepare("INSERT INTO memberships (google_email, role, status) VALUES ('second@x.co', 'installer', 'active')").run()))).empty === false, 'a second member (even an inactive one) means it is not empty');
  check((await ask(fresh((db) => db.prepare("UPDATE memberships SET status = 'inactive'").run()))).empty === false && (await ask(fresh((db) => db.prepare("UPDATE memberships SET role = 'installer'").run()))).empty === false, 'the one member must be an ACTIVE OWNER');
  { const db = newDatabase(workerDir); check((await ask(db)).empty === false, 'a business with NO members at all is not "empty": it is something else, and is left alone'); }
  for (const [label, sql] of [['an address', "address = '1 Main Road'"], ['a VAT number', "vat_no = '4123456789'"], ['a phone number', "phone = '082 000 0000'"], ['banking details', "banking_details = 'FNB 123'"], ['a trading name', "trading_as = 'Acme'"], ['an email', "email = 'a@b.co'"], ['a website', "website = 'x.co.za'"], ['a logo', "logo_r2_key = 'logo.png'"], ['VAT registered switched on', 'vat_registered = 1'], ['analytics switched on', 'analytics_opt_in = 1']]) check((await ask(fresh((db) => db.exec(`UPDATE business_profile SET ${sql} WHERE id = 1`)))).empty === false, `a profile that has been filled in (${label}) means the owner has started setting it up: not empty`);
  check((await ask(fresh((db) => db.exec("UPDATE business_profile SET name = 'A Different Name'")))).empty === true && (await ask(fresh((db) => db.exec('DELETE FROM business_profile')))).empty === true, 'but the NAME alone (whatever it is) or no profile row at all is still empty');

  // ---- every table: one row in it, and the answer must flip ---------------------------------------------------------------------------------------------------------------------------------------------------------------
  const tables = newDatabase(workerDir).prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name).filter((n) => !['memberships', 'business_profile'].includes(n));
  check(tables.length >= 38, `the business database has ${tables.length} other tables (the test covers all of them)`);
  // The two tables with CHECK constraints: the generic code fills every required column, and these override only the one the constraint cares about.
  const overrides = { line_items: { quotation_id: 1 }, onboarding_progress: { status: 'done' } };
  const populate = (db, t) => {
    const cols = db.prepare(`PRAGMA table_info("${t}")`).all(), over = overrides[t] || {};
    const need = cols.filter((c) => (c.notnull && c.dflt_value === null) || (c.pk && !/INTEGER/i.test(c.type)) || over[c.name] !== undefined);
    if (need.length === 0) { db.prepare(`INSERT INTO "${t}" DEFAULT VALUES`).run(); return; }
    const vals = need.map((c) => (over[c.name] !== undefined ? over[c.name] : /INT|REAL|NUM|BOOL/i.test(c.type) ? 1 : 'x'));
    db.prepare(`INSERT INTO "${t}" (${need.map((c) => `"${c.name}"`).join(',')}) VALUES (${vals.map(() => '?').join(',')})`).run(...vals);
  };
  const missed = [], unpopulatable = [];
  for (const t of tables) {
    const db = fresh(); try { populate(db, t); } catch (e) { unpopulatable.push(`${t}: ${String(e.message).slice(0, 60)}`); continue; }
    if ((await ask(db)).empty !== false) missed.push(t);
  }
  check(unpopulatable.length === 0, `every table could be given a row for this test (could not: ${unpopulatable.join('; ')})`);
  check(missed.length === 0, `a row in ANY table makes the business not empty (tables that do not: ${missed.join(', ')})`);
  const survivor = fresh((db) => db.exec('CREATE TABLE a_feature_added_next_year (x TEXT); INSERT INTO a_feature_added_next_year VALUES (1)')); check((await ask(survivor)).empty === false, 'and a table that does not exist yet, added by some future feature, counts too: an unknown table with rows is NOT empty (the rule can only err on the safe side)');
  check((await ask(fresh((db) => db.exec("CREATE TABLE a_future_table (x TEXT)")))).empty === true, 'while an unknown table with NO rows changes nothing');
  const src = fs.readFileSync(path.join(srcDir, 'emptiness.ts'), 'utf8');
  check(/new Set\(\["member_sign_ins", "object_meta", "schema_steps", "admin_audit", "request_timings"\]\)/.test(src) && !/DELETE|UPDATE|INSERT|DROP|ALTER/.test(src.replace(/\/\/[^\n]*/g, '')), 'the ONLY tables ignored are the five the platform writes for every business, and the module only READS (no write statement in it)');
  // Every table the source creates LAZILY (not in the baseline schema) inside a business object must be CLASSIFIED: either platform bookkeeping (ignored above) or something an owner's own activity writes (counts as data). A new one fails
  // this test, so nobody can add a table without deciding which, which is how a real object's tables caused the bug above.
  const baseline = fs.readFileSync(path.join(srcDir, 'baseline-sql.ts'), 'utf8'), inBaseline = new Set([...baseline.matchAll(/CREATE TABLE(?: IF NOT EXISTS)? \\?"?([a-z_]+)/g)].map((m) => m[1]));
  const sharedOrExperiment = new Set(['directory.ts', 'signup.ts', 'trial.ts']), lazy = new Set();
  for (const f of fs.readdirSync(srcDir).filter((x) => x.endsWith('.ts') && x !== 'baseline-sql.ts' && !sharedOrExperiment.has(x))) for (const m of fs.readFileSync(path.join(srcDir, f), 'utf8').matchAll(/CREATE TABLE IF NOT EXISTS ([a-z_]+) \(/g)) if (!inBaseline.has(m[1])) lazy.add(m[1]);
  const IGNORED = ['admin_audit', 'member_sign_ins', 'object_meta', 'request_timings', 'schema_steps'], COUNTS = ['member_selections', 'member_usage', 'model_usage', 'onboarding_progress', 'permission_audit', 'plans', 'purchase_order_cancellations', 'purchase_order_customers', 'role_capability_overrides', 'stock_item_merges', 'supplier_statements', 'team_audit', 'unit_conversions'];
  const expected = new Set([...IGNORED, ...COUNTS]), unclassified = [...lazy].filter((n) => !expected.has(n)), gone = [...expected].filter((n) => !lazy.has(n));
  check(unclassified.length === 0, `every lazily-created table is classified (bookkeeping the platform writes, or data the owner's activity writes). UNCLASSIFIED: ${unclassified.join(', ')}: decide which, then add it to emptiness.ts or to this list`);
  check(gone.length === 0, `and the classification lists no table that no longer exists (stale: ${gone.join(', ')})`);
  check(sorted2(IGNORED) === sorted2(src.match(/new Set\(\[([^\]]*)\]\)/)[1].match(/[a-z_]+/g)), 'and the ignored list in this test is exactly the list in the module');
  function sorted2(a) { return [...a].sort().join(); }
  const dbg = fs.readFileSync(path.join(srcDir, 'debug.ts'), 'utf8'), adm = fs.readFileSync(path.join(srcDir, 'admin-routes.ts'), 'utf8');
  check(/url\.pathname === "\/debug\/emptiness" && request\.method === "GET"/.test(dbg) && /"GET \/debug\/emptiness": "read"/.test(adm), 'the question is a READ-tier admin route inside the business object (the Worker asks it; it changes nothing)');
};
