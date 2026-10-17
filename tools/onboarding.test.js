// The owner's first-run journey (worker/src/onboarding.ts, migration 0002; SHIP_CHECKLIST.md item 15). The checklist asks for: resumable, persistent, safe to retry. Resumable and persistent: a step is "done" because the DATA
// says so (worked out when asked, so it cannot go stale) and only the owner's explicit choices are stored. Safe to retry: marking is an upsert or a delete, so the same call twice is the same as once. And it is the OWNER'S:
// every other role and a signed-out caller are refused by the gate.
const path = require('path'), fs = require('fs'), os = require('os'), esbuild = require('esbuild');
const { DatabaseSync } = require('node:sqlite');

module.exports = async function runOnboardingTests(context) {
  const standIn = global.Response;
  if (global.__RealResponse) global.Response = global.__RealResponse;
  try { await onboardingTests(context); } finally { global.Response = standIn; }
};

async function onboardingTests({ check, srcDir }) {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ob-')), 'm.js');
  esbuild.buildSync({ entryPoints: [path.join(srcDir, 'onboarding.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent' });
  const ob = require(out), harness = require('./harness.js'), workerDir = path.join(srcDir, '..');
  const world = () => { const db = harness.newDatabase(workerDir); return { db, env: () => ({ OFFICE_DB: harness.d1(db) }) }; };   // a fresh env each time = a new request, a new session
  const byId = (state) => Object.fromEntries(state.steps.map((s) => [s.id, s]));
  const IDS = ['profile', 'customers', 'invoices', 'team', 'suppliers', 'products', 'try_it'];

  // ---- a blank business ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const W = world();
  let st = await ob.onboardingState(W.env());
  check(st.steps.map((s) => s.id).join() === IDS.join() && st.steps.every((s) => s.status === 'pending' && s.source === null && s.title && s.detail && s.action) && st.complete === false && st.remaining === 7 && st.next === 'profile', 'a blank business has seven steps in order, all pending, each with a title, a detail and an action, and the next one is the first');
  check(JSON.stringify(ob.ONBOARDING_STEPS.map((s) => s.upload)) === JSON.stringify([null, '/files/customers-csv-import', '/files/invoices-csv-import', '/files/team-csv-import', '/files/suppliers-csv-import', '/files/products-csv-import', null]) && st.steps.every((s, i) => s.upload === ob.ONBOARDING_STEPS[i].upload), 'each import step names the route its spreadsheet goes to (five uploads; the profile and the first sentence are not uploads)');
  check(JSON.stringify(ob.ONBOARDING_STEPS.map((s) => s.action)) === JSON.stringify(['business_profile', 'import_customers', 'import_invoices', 'add_team', 'add_suppliers', 'add_products', 'try_saying']), 'the actions the app will offer are fixed names: business_profile, import_customers, import_invoices, add_team, add_suppliers, add_products, try_saying');

  // ---- "done" comes from the DATA, worked out each time it is asked ----------------------------------------------------------------------------------------------------------------------------------------------
  W.db.exec("INSERT INTO business_profile (id, name) VALUES (1, '   ')");
  check(byId(await ob.onboardingState(W.env())).profile.status === 'pending', 'a business profile with a blank name is NOT done');
  W.db.exec("UPDATE business_profile SET name = 'Zulu Floors' WHERE id = 1");
  check(byId(await ob.onboardingState(W.env())).profile.status === 'pending', 'a NAME alone is NOT done: the step is the business\'s details, and a signup seeds the name from the form, so the address that invoices carry must still be asked for');
  W.db.exec("UPDATE business_profile SET address = '   ' WHERE id = 1");
  check(byId(await ob.onboardingState(W.env())).profile.status === 'pending', 'a name with a BLANK address is not done either');
  W.db.exec("UPDATE business_profile SET address = '1 Main Road, Eshowe' WHERE id = 1");
  check(byId(await ob.onboardingState(W.env())).profile.status === 'done', 'a name AND an address is done');
  W.db.exec("INSERT INTO customers (name) VALUES ('Mrs Dlamini')");
  W.db.exec("INSERT INTO invoices (customer_id, description, amount) VALUES (1, 'Repairs', 500)");
  W.db.exec("INSERT INTO characters (name, relationship) VALUES ('Vinyl World', 'supplier')");
  W.db.exec("INSERT INTO products (name) VALUES ('vinyl')");
  W.db.exec("INSERT INTO captures (raw_text, source) VALUES ('quote Mrs Dlamini R500', 'text')");
  st = byId(await ob.onboardingState(W.env()));
  check(['profile', 'customers', 'invoices', 'suppliers', 'products', 'try_it'].every((k) => st[k].status === 'done' && st[k].source === 'data') && st.team.status === 'pending', 'steps whose data exists are done BECAUSE of the data (source "data"); the team step is not, with nobody added yet');
  W.db.exec("INSERT INTO memberships (google_email, role, status) VALUES ('owner@x.com', 'owner', 'active')");
  check(byId(await ob.onboardingState(W.env())).team.status === 'pending', 'the owner alone is not a team: one member is not enough');
  W.db.exec("INSERT INTO characters (name, relationship) VALUES ('Sipho', 'installer')");
  check(byId(await ob.onboardingState(W.env())).team.status === 'done', 'the owner plus an installer is a team');
  const W2 = world(); W2.db.exec("INSERT INTO memberships (google_email, role, status) VALUES ('a@x.com', 'owner', 'active'), ('b@x.com', 'accountant', 'active')");
  const W3 = world(); W3.db.exec("INSERT INTO memberships (google_email, role, status) VALUES ('a@x.com', 'owner', 'active'), ('b@x.com', 'installer', 'removed')");
  check(byId(await ob.onboardingState(W2.env())).team.status === 'done' && byId(await ob.onboardingState(W3.env())).team.status === 'pending', 'two active members are a team; a removed member does not count');
  st = await ob.onboardingState(W.env());
  check(st.complete === true && st.remaining === 0 && st.next === null, 'when every step is done the journey is complete and there is no next step');

  // ---- the owner's choices: skipped, done by hand, reset; the data wins ---------------------------------------------------------------------------------------------------------------------------------------
  const M = world();
  let r = await ob.setOnboardingStep(M.env(), 'customers', 'skipped', 'owner@x.com');
  check(r.ok && byId(r.state).customers.status === 'skipped' && byId(r.state).customers.source === 'marked' && r.state.remaining === 6 && r.state.next === 'profile', 'a skipped step shows as skipped (source "marked") and no longer counts as remaining');
  const row = M.db.prepare("SELECT * FROM onboarding_progress WHERE step = 'customers'").get();
  check(row.status === 'skipped' && row.updated_by === 'owner@x.com' && /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(row.updated_at), 'what was chosen, who chose it and when are stored');
  M.db.exec("INSERT INTO customers (name) VALUES ('Mrs Dlamini')");
  const after = byId(await ob.onboardingState(M.env())).customers;
  check(after.status === 'done' && after.source === 'data', 'a step skipped last week and done since is DONE: the data wins over the choice');
  r = await ob.setOnboardingStep(M.env(), 'team', 'done', null);
  check(r.ok && byId(r.state).team.status === 'done' && byId(r.state).team.source === 'marked', 'a step can be marked done by hand when the data cannot show it (source "marked")');
  r = await ob.setOnboardingStep(M.env(), 'team', 'pending', 'owner@x.com');
  check(r.ok && byId(r.state).team.status === 'pending' && M.db.prepare("SELECT COUNT(*) AS n FROM onboarding_progress WHERE step = 'team'").get().n === 0, 'resetting a step to pending removes the choice');
  // safe to retry
  const R = world();
  const a = await ob.setOnboardingStep(R.env(), 'invoices', 'skipped', 'o@x.com'), b = await ob.setOnboardingStep(R.env(), 'invoices', 'skipped', 'o@x.com'), c3 = await ob.setOnboardingStep(R.env(), 'invoices', 'skipped', 'o@x.com');
  check(JSON.stringify(a.state) === JSON.stringify(b.state) && JSON.stringify(b.state) === JSON.stringify(c3.state) && R.db.prepare("SELECT COUNT(*) AS n FROM onboarding_progress").get().n === 1, 'SAFE TO RETRY: marking the same step the same way three times leaves exactly one row and the same state');
  const flip = await ob.setOnboardingStep(R.env(), 'invoices', 'done', 'o@x.com');
  check(flip.ok && R.db.prepare("SELECT status FROM onboarding_progress WHERE step = 'invoices'").get().status === 'done' && R.db.prepare("SELECT COUNT(*) AS n FROM onboarding_progress").get().n === 1, 'changing a choice replaces it (still one row)');
  const resetTwice = [await ob.setOnboardingStep(R.env(), 'products', 'pending', null), await ob.setOnboardingStep(R.env(), 'products', 'pending', null)];
  check(resetTwice.every((x) => x.ok) && JSON.stringify(resetTwice[0].state) === JSON.stringify(resetTwice[1].state), 'resetting a step that was never marked is harmless, twice over');
  // resumable: a brand-new environment over the same database (a new session, a new device) sees exactly where the owner was
  const before = await ob.onboardingState(R.env()); const resumed = await ob.onboardingState({ OFFICE_DB: harness.d1(R.db) });
  check(JSON.stringify(before) === JSON.stringify(resumed) && byId(resumed).invoices.status === 'done', 'RESUMABLE: a new session over the same business sees the same journey');

  // ---- validation ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const bad = [['a step that does not exist', 'nonsense', 'done'], ['a missing step', undefined, 'done'], ['a step that is not text', 5, 'done'], ['SQL in the step', "customers'; DROP TABLE customers;--", 'done'], ['an unknown status', 'customers', 'finished'], ['a missing status', 'customers', undefined], ['a status that is not text', 'customers', 1]];
  for (const [label, s, status] of bad) {
    const x = await ob.setOnboardingStep(M.env(), s, status, 'o@x.com');
    check(x.ok === false && /step must be one of: profile, customers|status must be "done", "skipped" or "pending"/.test(x.error), `refused with a reason: ${label}`);
  }
  check(M.db.prepare("SELECT COUNT(*) AS n FROM customers").get().n === 1, 'and the injected SQL did nothing (the customers are still there)');

  // ---- it never breaks the app when the schema is behind ---------------------------------------------------------------------------------------------------------------------------------------------------------
  const old = new DatabaseSync(':memory:'); old.exec(fs.readFileSync(path.join(workerDir, 'migrations', '0001_baseline.sql'), 'utf8'));   // an object that has not applied step 2 yet
  const oldState = await ob.onboardingState({ OFFICE_DB: harness.d1(old) });
  check(oldState.steps.length === 7 && oldState.steps.every((s) => s.status === 'pending') && oldState.next === 'profile', 'an object that has not applied the migration yet answers with every step pending instead of an error');
  const noProducts = world(); noProducts.db.exec('DROP TABLE products');
  check(byId(await ob.onboardingState(noProducts.env())).products.status === 'pending', 'a data check that cannot run (its table is missing) means "not done", never an error');

  // ---- the REAL routes, through the real gate -------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const fns = await harness.loadFunctions(workerDir);
  const route = (spec) => harness.runRouteCase(fns, workerDir, { name: spec.name, kind: 'route', failAtWrite: undefined, ...spec });
  const g = await route({ name: 'owner reads', path: '/onboarding', method: 'GET' });
  check(g.result.status === 200 && g.result.body.steps.length === 7 && g.result.body.steps.find((s) => s.id === 'team').status === 'done' && g.result.body.next === 'profile', 'the OWNER reads the journey: 200, seven steps (the three test members make the team step done on data)');
  const s1 = await route({ name: 'owner skips', path: '/onboarding/step', method: 'POST', body: { step: 'customers', status: 'skipped' } });
  check(s1.result.status === 200 && s1.result.body.steps.find((s) => s.id === 'customers').status === 'skipped' && JSON.stringify(s1.writes).includes('onboarding_progress') && JSON.stringify(s1.writes).includes('owner@example.com'), 'the owner marks a step: 200, the new state comes back, and the choice is stored with who made it');
  const chain = await route({ name: 'skip then reset', path: '/onboarding', method: 'GET', before: [{ route: true, method: 'POST', path: '/onboarding/step', body: { step: 'invoices', status: 'skipped' } }, { route: true, method: 'POST', path: '/onboarding/step', body: { step: 'invoices', status: 'skipped' } }, { route: true, method: 'POST', path: '/onboarding/step', body: { step: 'products', status: 'done' } }, { route: true, method: 'POST', path: '/onboarding/step', body: { step: 'invoices', status: 'pending' } }] });
  const cs = Object.fromEntries(chain.result.body.steps.map((s) => [s.id, s]));
  check(chain.result.status === 200 && cs.invoices.status === 'pending' && cs.products.status === 'done' && cs.products.source === 'marked', 'over several real requests (skip twice, mark another, reset the first) the journey ends up exactly where the owner left it');
  for (const role of ['accountant', 'installer']) {
    const rg = await route({ name: role + ' reads', path: '/onboarding', method: 'GET', role }), rp = await route({ name: role + ' marks', path: '/onboarding/step', method: 'POST', role, body: { step: 'customers', status: 'done' } });
    check(rg.result.status === 403 && rp.result.status === 403 && (Array.isArray(rp.writes) ? rp.writes.length : Object.keys(rp.writes || {}).length) === 0, `an ${role} is REFUSED on both routes (403) and nothing is written: onboarding is the owner's`);
  }
  const anon = await route({ name: 'signed out reads', path: '/onboarding', method: 'GET', noSession: true }), anonP = await route({ name: 'signed out marks', path: '/onboarding/step', method: 'POST', noSession: true, body: { step: 'customers', status: 'done' } });
  check(anon.result.status === 401 && anonP.result.status === 401, 'a signed-out caller is refused (401) on both routes');
  const badBody = await route({ name: 'owner bad', path: '/onboarding/step', method: 'POST', body: { step: 'nonsense', status: 'done' } }), notJson = await harness.runRouteCase(fns, workerDir, { name: 'not json', kind: 'route', path: '/onboarding/step', method: 'POST', form: undefined, body: undefined });
  check(badBody.result.status === 400 && /step must be one of/.test(badBody.result.body.error) && notJson.result.status === 400 && /send JSON/.test(notJson.result.body.error), 'a bad step is a 400 that names the valid steps, and a body that is not JSON is a 400, not a crash');
  const wrongMethod = await route({ name: 'wrong method', path: '/onboarding', method: 'POST', body: {} });
  check(wrongMethod.result.status !== 200 && wrongMethod.result.status !== 500, 'a route that does not exist (POST /onboarding) is not served');

  // ---- the migration and the wiring ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const mig = fs.readFileSync(path.join(workerDir, 'migrations', '0002_onboarding_progress.sql'), 'utf8').replace(/^--.*$/gm, '');
  check(/^\s*CREATE TABLE IF NOT EXISTS onboarding_progress \(/.test(mig) && !/\b(DROP|DELETE|TRUNCATE|RENAME|ALTER)\b/i.test(mig) && mig.trim().split(';').filter(Boolean).length === 1, 'the migration is ONE additive CREATE TABLE IF NOT EXISTS: it changes and removes nothing');
  const steps = fs.readFileSync(path.join(srcDir, 'schema-steps.ts'), 'utf8');
  check(/name: "0001_baseline"/.test(steps) && /name: "0002_onboarding_progress"/.test(steps), 'the generated schema steps list both migrations, in order');
  const idx = fs.readFileSync(path.join(srcDir, 'index.ts'), 'utf8');
  check(/pathname === "\/onboarding" && request\.method === "GET"/.test(idx) && /pathname === "\/onboarding\/step" && request\.method === "POST"/.test(idx) && /import \{ onboardingRoute \} from "\.\/onboarding";/.test(idx), 'the two routes are wired in the conventional shape (so the route policy sees them)');
}
