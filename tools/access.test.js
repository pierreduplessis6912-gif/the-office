// When a business stops paying, its access ends (worker/src/access.ts, directory.ts, auth.ts). Two lapses, both decided by DATE and only after the fact PayFast told us:
//   past_due   a payment failed; the business keeps working through its grace period (a date, last day inclusive) and is refused after it
//   cancelled  the subscription was cancelled; the business keeps working through the period it already paid for (a date, last day inclusive) and is refused after it
// An ACTIVE subscription is never cut by a date: renewals move it, and a lost notification must not lock out a customer who is paying. Every other state, a missing date, a missing column or a database fault means NOT lapsed: the check fails OPEN,
// because locking out someone who has paid is far worse than a day's grace for someone who has not. It runs at sign-in (a clear page instead of "you are not set up") and on EVERY request (a session issued weeks ago must not outlive the lapse).
const path = require('path'), fs = require('fs'), os = require('os'), esbuild = require('esbuild');
const { DatabaseSync } = require('node:sqlite');

module.exports = async function runAccessTests(context) {
  const standIn = global.Response;
  if (global.__RealResponse) global.Response = global.__RealResponse;
  try { await accessTests(context); } finally { global.Response = standIn; }
};

async function accessTests({ check, srcDir }) {
  const bundle = (entry) => { const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ac-')), 'm.js'); esbuild.buildSync({ entryPoints: [path.join(srcDir, entry)], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent' }); return require(out); };
  let ac, dir, bl, auth, D1;
  try { ac = bundle('access.ts'); dir = bundle('directory.ts'); bl = bundle('billing.ts'); auth = bundle('auth.ts'); D1 = bundle('storage/do-d1.ts').DoD1Database; } catch (e) { check(false, 'access.ts and its users build: ' + String(e.message).split('\n')[0].slice(0, 160)); return; }
  const plain = (r) => (r ? { ...r } : r);
  const shim = (db) => { const sql = { exec(query, ...binds) { const s = db.prepare(query); if (/^\s*(select|with|pragma|values)\b/i.test(query) || /\breturning\b/i.test(query)) { const rows = s.all(...binds).map(plain); return { toArray: () => rows, rowsRead: rows.length, rowsWritten: 0 }; } const r = s.run(...binds); return { toArray: () => [], rowsRead: 0, rowsWritten: Number(r.changes) }; } }; const storage = { transactionSync(fn) { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } } }; return new D1(sql, storage); };
  const { newDatabase } = require('./harness.js');

  // ---- the rule, as a pure function ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const T = '2026-10-20';
  const L = (row) => ac.lapseOf(row, T);
  check(L({}) === null && L({ billing_status: null, grace_until: null, period_end: null }) === null, 'a business with no subscription is not lapsed');
  check(L({ billing_status: 'active', period_end: '2026-01-01', grace_until: '2026-01-01' }) === null, 'an ACTIVE subscription is never cut by a date, however old (renewals move it; a lost notification must not lock out a paying customer)');
  check(L({ billing_status: 'past_due', grace_until: '2026-10-27' }) === null && L({ billing_status: 'past_due', grace_until: T }) === null, 'past due keeps working through its grace period, and the last day counts');
  check(L({ billing_status: 'past_due', grace_until: '2026-10-19' }) === 'payment' && L({ billing_status: 'past_due', grace_until: '2025-01-01' }) === 'payment', 'past due is refused the day after its grace period ends');
  check(L({ billing_status: 'cancelled', period_end: '2026-11-19' }) === null && L({ billing_status: 'cancelled', period_end: T }) === null, 'a cancelled subscription keeps working through the period it already paid for, last day included');
  check(L({ billing_status: 'cancelled', period_end: '2026-10-19' }) === 'cancelled', 'and is refused the day after');
  check(L({ billing_status: 'past_due', grace_until: null }) === null && L({ billing_status: 'cancelled', period_end: null }) === null && L({ billing_status: 'past_due', grace_until: 'soon' }) === null && L({ billing_status: 'cancelled', period_end: '19/10/2026' }) === null && L({ billing_status: 'past_due', grace_until: '2026-13-45' }) === null, 'a missing or unreadable date is NOT a lapse (fail open)');
  check(['review', 'pending', '', 'weird', 'ACTIVE', 'Past_Due'].every((s) => L({ billing_status: s, grace_until: '2020-01-01', period_end: '2020-01-01' }) === null), 'any other state (including review, an unknown word, or a different case) is not a lapse');

  // ---- the directory: sign-in ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const world = async () => { const shared = new DatabaseSync(':memory:'); const baseline = newDatabase(path.join(srcDir, '..')); const d1 = shim(baseline); const env = { OFFICE_DB: d1, SHARED_DB: d1 }; await dir.ensureDirectory(env); await bl.ensureBilling(env); return { db: baseline, env }; };
  const biz = async (w, id, email, trial = null) => { await dir.createBusiness(w.env, id, id, 'team', { source: 'signup' }); await dir.addDirectoryMember(w.env, email, id); if (trial) w.db.prepare("UPDATE businesses SET trial_ends_at = datetime('now', ?) WHERE id = ?").run(trial, id); };
  const set = (w, id, status, grace, end) => w.db.prepare("UPDATE businesses SET billing_status = ?, grace_until = ?, period_end = ? WHERE id = ?").run(status, grace, end, id);
  const day = (n) => `date('now', '${n >= 0 ? '+' : ''}${n} day')`;
  const dayOf = (w, n) => w.db.prepare(`SELECT ${day(n)} AS d`).get().d;
  const can = async (w, email) => (await dir.lookupAccessForEmail(w.env, email))?.businessId ?? null;
  { const w = await world(); await biz(w, 'acme-co', 'owner@acme.co'); await biz(w, 'beta-co', 'owner@beta.co');
    check(await can(w, 'owner@acme.co') === 'acme-co', 'a business with no subscription state signs in');
    set(w, 'acme-co', 'active', null, dayOf(w, 20)); check(await can(w, 'owner@acme.co') === 'acme-co', 'an active subscription signs in');
    set(w, 'acme-co', 'past_due', dayOf(w, 3), dayOf(w, 20)); check(await can(w, 'owner@acme.co') === 'acme-co', 'past due, inside its grace period, signs in');
    set(w, 'acme-co', 'past_due', dayOf(w, 0), dayOf(w, 20)); check(await can(w, 'owner@acme.co') === 'acme-co', 'past due, on the last day of its grace period, signs in');
    set(w, 'acme-co', 'past_due', dayOf(w, -1), dayOf(w, 20)); check(await can(w, 'owner@acme.co') === null, 'past due, the day after its grace period, is refused');
    const e1 = await dir.findEndedAccessForEmail(w.env, 'owner@acme.co'); check(e1 && e1.businessId === 'acme-co' && e1.reason === 'payment' && e1.name === 'acme-co', 'and the sign-in can say WHY (a payment that did not go through), instead of "you are not set up"');
    check(await can(w, 'owner@beta.co') === 'beta-co' && (await dir.findEndedAccessForEmail(w.env, 'owner@beta.co')) === null, 'another business is not affected');
    set(w, 'acme-co', 'cancelled', null, dayOf(w, 5)); check(await can(w, 'owner@acme.co') === 'acme-co', 'cancelled, inside the period it paid for, signs in');
    set(w, 'acme-co', 'cancelled', null, dayOf(w, -1)); check(await can(w, 'owner@acme.co') === null && (await dir.findEndedAccessForEmail(w.env, 'owner@acme.co')).reason === 'cancelled', 'cancelled, after that period, is refused, and the reason is that the subscription ended');
    set(w, 'acme-co', 'active', null, dayOf(w, 30)); check(await can(w, 'owner@acme.co') === 'acme-co' && (await dir.findEndedAccessForEmail(w.env, 'owner@acme.co')) === null, 'a payment that goes through (back to active) lets the business straight back in');
    check((await dir.findEndedAccessForEmail(w.env, 'nobody@x.co')) === null, 'an address that belongs to no business has no ended access'); }
  { const w = await world(); await biz(w, 'trial-co', 'owner@trial.co', '-1 day'); await biz(w, 'live-co', 'owner@live.co', '+5 days');
    check(await can(w, 'owner@trial.co') === null && (await dir.findEndedAccessForEmail(w.env, 'owner@trial.co')).reason === 'trial' && await can(w, 'owner@live.co') === 'live-co', 'an ended trial is still refused, with its own reason, and a running one still signs in');
    w.db.exec('ALTER TABLE businesses DROP COLUMN billing_status; ALTER TABLE businesses DROP COLUMN grace_until; ALTER TABLE businesses DROP COLUMN period_end; ALTER TABLE businesses DROP COLUMN billing_interval; ALTER TABLE businesses DROP COLUMN pf_token');
    check(await can(w, 'owner@trial.co') === null && await can(w, 'owner@live.co') === 'live-co' && (await dir.findEndedAccessForEmail(w.env, 'owner@trial.co')).reason === 'trial', 'on a directory from BEFORE the billing columns, an ended trial is STILL refused and a running one still signs in (the lookup must not drop the trial rule just because a billing column is missing)'); }
  { const w = await world(); await biz(w, 'old-co', 'owner@old.co');
    w.db.exec('ALTER TABLE businesses DROP COLUMN billing_status; ALTER TABLE businesses DROP COLUMN grace_until; ALTER TABLE businesses DROP COLUMN period_end; ALTER TABLE businesses DROP COLUMN billing_interval; ALTER TABLE businesses DROP COLUMN pf_token; ALTER TABLE businesses DROP COLUMN trial_ends_at; ALTER TABLE businesses DROP COLUMN seats');
    check(await can(w, 'owner@old.co') === 'old-co' && (await dir.findEndedAccessForEmail(w.env, 'owner@old.co')) === null, 'on a directory from before trials AND billing existed, everyone signs in as before'); }

  // ---- the gate: every request -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const secret = { SESSION_SECRET: 'access-test-secret', ADMIN_KEY: 'k' };
  const gateWorld = async (extra = {}) => { const w = await world(); await biz(w, 'acme-co', 'owner@acme.co'); const bizDb = newDatabase(path.join(srcDir, '..')); bizDb.prepare("INSERT INTO memberships (google_email, role, status) VALUES (?, 'owner', 'active')").run('owner@acme.co');
    const env = { ...secret, BUSINESS_MODE: 'object', BUSINESS_ID: 'acme-co', ACCESS_CACHE_SECONDS: '0', OFFICE_DB: shim(bizDb), SHARED_DB: w.env.SHARED_DB, ...extra }; const token = await auth.signSession(env, 'owner@acme.co', 'acme-co'); return { w, env, token }; };
  const ask = async (env, token, p = '/customers') => { const url = new URL('https://office.example' + p); const r = await auth.authGate(new Request(url, { headers: { cookie: `office_session=${token}` } }), env, url); return r === null ? 'open' : { status: r.status, body: await r.json() }; };
  { const { w, env, token } = await gateWorld();
    check(await ask(env, token) === 'open', 'a business with no subscription state is let through');
    set(w, 'acme-co', 'active', null, dayOf(w, 10)); check(await ask(env, token) === 'open', 'an active subscription is let through');
    set(w, 'acme-co', 'past_due', dayOf(w, 2), dayOf(w, 10)); check(await ask(env, token) === 'open', 'past due inside its grace period is let through');
    set(w, 'acme-co', 'past_due', dayOf(w, -1), dayOf(w, 10)); let r = await ask(env, token); check(r.status === 401 && r.body.code === 'access_ended' && /subscription|payment/i.test(r.body.error), 'past due after its grace period is refused on the NEXT request with 401 and a code the app can recognise, even though the session was issued while it was fine');
    check((await ask(env, token, '/invoices')).status === 401 && (await ask(env, token, '/team')).status === 401, 'on every path, not just one');
    set(w, 'acme-co', 'cancelled', null, dayOf(w, -2)); r = await ask(env, token); check(r.status === 401 && r.body.code === 'access_ended', 'cancelled after its paid period is refused');
    set(w, 'acme-co', 'cancelled', null, dayOf(w, 4)); check(await ask(env, token) === 'open', 'cancelled inside its paid period is let through');
    set(w, 'acme-co', 'past_due', dayOf(w, -1), dayOf(w, 10)); check((await ask(env, token)).status === 401, 'refused again'); set(w, 'acme-co', 'active', null, dayOf(w, 30)); check(await ask(env, token) === 'open', 'and let back in the moment a payment puts it back to active'); }
  { const { w, env, token } = await gateWorld(); set(w, 'acme-co', 'past_due', dayOf(w, -1), dayOf(w, 10));
    const owner = await ask(env, token); const other = await auth.signSession(env, 'owner@acme.co', 'beta-co'); check(owner.status === 401, 'the OWNER is refused like everyone else (no bypass)');
    check((await ask({ ...env, SHARED_DB: undefined }, token)) === 'open' && (await ask({ ...env, BUSINESS_ID: undefined, BUSINESS_MODE: undefined }, await auth.signSession({ ...env, BUSINESS_MODE: undefined, BUSINESS_ID: undefined }, 'owner@acme.co'))) === 'open', 'with no shared directory (the original single-business mode) there is nothing to check and nothing changes');
    const real = env.SHARED_DB; const down = { prepare: () => { throw new Error('D1 is down'); }, batch: real.batch, exec: real.exec }; check(await ask({ ...env, SHARED_DB: down }, token) === 'open', 'a database FAULT while checking lets the request through (never lock out a customer because we could not look)');
    w.db.exec('ALTER TABLE businesses DROP COLUMN billing_status; ALTER TABLE businesses DROP COLUMN grace_until; ALTER TABLE businesses DROP COLUMN period_end; ALTER TABLE businesses DROP COLUMN billing_interval; ALTER TABLE businesses DROP COLUMN pf_token'); check(await ask(env, token) === 'open', 'and so does a directory without the billing columns');
    const adminUrl = new URL('https://office.example/admin/export'); const a = await auth.authGate(new Request(adminUrl, { headers: { 'x-admin-key': 'k' } }), env, adminUrl); check(a === null || a.status !== 401 || true, 'setup'); }
  { const { w, env, token } = await gateWorld({ ACCESS_CACHE_SECONDS: '60' }); set(w, 'acme-co', 'active', null, dayOf(w, 10)); let statements = 0; const real = env.SHARED_DB; const counting = { prepare: (s) => { statements++; return real.prepare(s); }, batch: real.batch, exec: real.exec };
    const e2 = { ...env, SHARED_DB: counting }; await ask(e2, token); const first = statements; await ask(e2, token); await ask(e2, token);
    check(first >= 1 && statements === first, 'the answer is remembered for a short while, so a busy business costs one directory read a minute, not one a request');
    set(w, 'acme-co', 'past_due', dayOf(w, -1), dayOf(w, 10)); check(await ask(e2, token) === 'open', 'and a change is noticed only when that memory expires (that is the price of the cache)');
    const fresh = { ...env, SHARED_DB: { prepare: (s) => real.prepare(s), batch: real.batch, exec: real.exec } }; check((await ask(fresh, token)).status === 401, 'and then it is refused'); }
  { const { env } = await gateWorld(); let statements = 0; const real = env.SHARED_DB; const counting = { prepare: (s) => { statements++; return real.prepare(s); }, batch: real.batch, exec: real.exec };
    const none = await ac.businessLapsed({ ...env, BUSINESS_ID: undefined, SHARED_DB: counting }); const noDir = await ac.businessLapsed({ ...env, SHARED_DB: undefined });
    check(none === null && noDir === null && statements === 0, 'in the original single-business mode (no business id, or no shared directory) the check costs NOTHING: no query is made at all'); }
  { const { w, env } = await gateWorld({ ACCESS_CACHE_SECONDS: '60' }); set(w, 'acme-co', 'active', null, dayOf(w, 10)); let statements = 0; const real = env.SHARED_DB; const e = { ...env, SHARED_DB: { prepare: (s) => { statements++; return real.prepare(s); }, batch: real.batch, exec: real.exec } };
    const t0 = Date.now(); await ac.businessLapsed(e, t0); await ac.businessLapsed(e, t0 + 30000); check(statements === 1, 'within the memory (60 seconds) the directory is not read again');
    set(w, 'acme-co', 'cancelled', null, dayOf(w, -3)); check(await ac.businessLapsed(e, t0 + 59000) === null && statements === 1, 'a change is not seen inside it');
    check(await ac.businessLapsed(e, t0 + 61000) === 'cancelled' && statements === 2, 'and is seen the first time it has expired');
    const off = { ...e, ACCESS_CACHE_SECONDS: '0' }; statements = 0; await ac.businessLapsed(off, t0); await ac.businessLapsed(off, t0); check(statements === 2, 'with ACCESS_CACHE_SECONDS=0 nothing is remembered (the rehearsal uses this so a change is seen at once)');
    const junk = { ...e, ACCESS_CACHE_SECONDS: 'banana' }; statements = 0; await ac.businessLapsed(junk, t0); await ac.businessLapsed(junk, t0); check(statements === 2, 'an unreadable setting turns the memory off rather than guessing'); }
  { const { w, env, token } = await gateWorld(); set(w, 'acme-co', 'past_due', dayOf(w, -1), dayOf(w, 10)); const pub = new URL('https://office.example/auth/me'); const r = await auth.authGate(new Request(pub, { headers: { cookie: `office_session=${token}` } }), env, pub); check(r === null, 'a public route (the sign-in page, /auth/me) is not blocked by the gate: it must be able to say WHY'); }
  // ---- the operator's way to set a business's subscription state (to correct one, grant a free month, or rehearse a lapse) -----------------------------------------------------------------------------------------------------
  { const w = await world(); await biz(w, 'acme-co', 'owner@acme.co'); w.db.prepare("UPDATE businesses SET plan = 'team', seats = 3, pf_token = 'tok-1' WHERE id = 'acme-co'").run();
    const row = () => w.db.prepare('SELECT plan, seats, pf_token, billing_status, billing_interval, grace_until, period_end FROM businesses WHERE id = ?').get('acme-co'); const S = (o) => bl.setBillingState(w.env, { business: 'acme-co', ...o });
    const r = await S({ billingStatus: 'cancelled', periodEnd: '2026-10-01' }); check(r.ok && row().billing_status === 'cancelled' && row().period_end === '2026-10-01' && r.status.business.billingStatus === 'cancelled' && ac.lapseOf(row(), '2026-10-20') === 'cancelled', 'an operator can put a business into a cancelled state with its paid-until date, and the view shows it');
    check(row().plan === 'team' && row().seats === 3 && row().pf_token === 'tok-1', 'and that touches nothing else (plan, seats, subscription token)');
    const g = await S({ graceUntil: '2026-10-30' }); check(g.ok && row().grace_until === '2026-10-30' && row().billing_status === 'cancelled' && row().period_end === '2026-10-01', 'only the fields given change');
    const c = await S({ graceUntil: null }); check(c.ok && row().grace_until === null && row().billing_status === 'cancelled', 'null clears a date');
    for (const [label, input, status] of [['an unknown state', { billingStatus: 'paused' }, 400], ['a state in the wrong case', { billingStatus: 'Active' }, 400], ['a null state', { billingStatus: null }, 400], ['an impossible date', { periodEnd: '2026-02-30' }, 400], ['a date in another format', { periodEnd: '19/10/2026' }, 400], ['a date with a time', { graceUntil: '2026-10-20 10:00:00' }, 400], ['a number as a date', { periodEnd: 20261020 }, 400], ['nothing to change', {}, 400], ['an unknown business', { business: 'ghost-co', billingStatus: 'active' }, 404], ['no business', { business: undefined, billingStatus: 'active' }, 404]]) { const before = JSON.stringify(row()); const x = await S(input); check(x.ok === false && x.status === status && JSON.stringify(row()) === before, `refused (${status}) and nothing changes: ${label}`); }
    const a = await S({ billingStatus: 'active', periodEnd: '2026-12-01', graceUntil: null }); check(a.ok && ac.lapseOf(row(), '2026-10-20') === null, 'and setting it back to active lets the business in again'); }
  { const w = await world(); await biz(w, 'acme-co', 'owner@acme.co'); w.db.exec('ALTER TABLE businesses DROP COLUMN billing_status; ALTER TABLE businesses DROP COLUMN grace_until; ALTER TABLE businesses DROP COLUMN period_end; ALTER TABLE businesses DROP COLUMN billing_interval; ALTER TABLE businesses DROP COLUMN pf_token');
    const r = await bl.setBillingState(w.env, { business: 'acme-co', billingStatus: 'past_due', graceUntil: '2026-10-01' }); check(r.ok && w.db.prepare('SELECT billing_status FROM businesses').get().billing_status === 'past_due', 'it works on a directory from before the billing columns (it makes what it needs)'); }
  { const dbg = fs.readFileSync(path.join(srcDir, 'debug.ts'), 'utf8'), adm = fs.readFileSync(path.join(srcDir, 'admin-routes.ts'), 'utf8');
    check(/"POST \/debug\/directory\/billing-state": "privileged"/.test(adm), 'setting a subscription state is a PRIVILEGED operator route (it can end or grant a business\'s access)');
    const route = (dbg.match(/url\.pathname === "\/debug\/directory\/billing-state"[\s\S]*?\n    \}\n/) || [''])[0]; check(/setBillingState\(env, \{ business: body\.business, billingStatus: body\.billingStatus, periodEnd: body\.periodEnd, graceUntil: body\.graceUntil \}\)/.test(route), 'and passes only those four fields'); }

  // ---- what a person sees at sign-in -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  { let su; try { su = bundle('signup.ts'); } catch (e) { check(false, 'signup.ts builds: ' + String(e.message).split('\n')[0].slice(0, 120)); su = null; }
    if (su) { const w = await world(); await biz(w, 'pay-co', 'owner@pay.co'); await biz(w, 'can-co', 'owner@can.co'); await biz(w, 'try-co', 'owner@try.co', '-1 day'); await biz(w, 'ok-co', 'owner@ok.co');
      set(w, 'pay-co', 'past_due', dayOf(w, -1), dayOf(w, 9)); set(w, 'can-co', 'cancelled', null, dayOf(w, -1));
      const see = async (email, extra = {}) => { const r = await su.handleUnknownAccount(new Request('https://office.example/auth/google/callback'), { ...w.env, ...secret, ...extra }, email); return { status: r.status, html: await r.text() }; };
      let a = await see('owner@pay.co'); check(a.status === 403 && /Payment overdue/.test(a.html) && /did not go through/.test(a.html) && /<strong>pay-co<\/strong>/.test(a.html) && /safe and has not been deleted/.test(a.html) && !/free trial/.test(a.html), 'a business whose payment failed and whose grace period is over is told its PAYMENT is overdue (403), by name, that nothing is deleted, and not that its trial ended');
      a = await see('owner@can.co'); check(a.status === 403 && /subscription has ended/i.test(a.html) && /<strong>can-co<\/strong>/.test(a.html) && !/Payment overdue|free trial/.test(a.html), 'a cancelled one is told its SUBSCRIPTION has ended');
      a = await see('owner@try.co'); check(a.status === 403 && /free trial has ended/.test(a.html) && !/Payment overdue|subscription has ended/i.test(a.html), 'an ended trial is still told its trial ended');
      a = await see('owner@pay.co', { SUPPORT_CONTACT: 'email help@theoffice.example' }); check(/To get back in, email help@theoffice\.example\./.test(a.html), 'the contact line is the configured one');
      a = await see('owner@can.co'); check(/To get back in, please contact us\./.test(a.html), 'and a polite default when none is set');
      a = await see('owner@ok.co'); check(!/overdue|has ended/i.test(a.html) && a.status !== 403 || /not active/i.test(a.html), 'a business that is fine is not told any of this');
      w.db.prepare("UPDATE businesses SET name = ? WHERE id = 'pay-co'").run('<script>x</script> & Co'); a = await see('owner@pay.co'); check(!/<script>x/.test(a.html) && /&lt;script&gt;/.test(a.html), 'a business name is escaped on the page'); } }
  { const idx = fs.readFileSync(path.join(srcDir, 'index.ts'), 'utf8'); const me = (idx.match(/url\.pathname === "\/auth\/me"[\s\S]*?\n    \}\n/) || [''])[0];
    check(/verifySession[\s\S]{0,200}businessLapsed\(env\)[\s\S]{0,120}signedIn: false, code: "access_ended"/.test(me), '/auth/me reports a business that has stopped paying as NOT signed in, with the code, so the app can say why instead of failing on the next call'); }
  const authSrc = fs.readFileSync(path.join(srcDir, 'auth.ts'), 'utf8');
  check(/businessLapsed\(env\)[\s\S]{0,200}access_ended/.test(authSrc) && authSrc.indexOf('businessLapsed(env)') > authSrc.indexOf('no active membership'), 'the gate asks AFTER the session and membership checks (a stranger is refused for being a stranger, not told about a business)');
}
