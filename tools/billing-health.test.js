// The billing health check (worker/src/billing.ts billingHealth, an operator route, and .github/workflows/prod-billing-health.yml). Its job: tell an operator, without anyone having to look, when MONEY MAY BE STUCK. Two lists: PROBLEMS (page-worthy: money may have been
// taken and not applied, or applying it failed) and WATCH (information: a grace period ending soon, a business now lapsed). It is read-only, never throws, never shows a token, an email or a secret, and a missing table or column means "nothing to report", not an error.
const path = require('path'), fs = require('fs'), os = require('os'), esbuild = require('esbuild');
const { DatabaseSync } = require('node:sqlite');

module.exports = async function runBillingHealthTests({ check, srcDir }) {
  const standIn = global.Response;
  if (global.__RealResponse) global.Response = global.__RealResponse;
  try { await healthTests({ check, srcDir }); } finally { global.Response = standIn; }
};

async function healthTests({ check, srcDir }) {
  const bundle = (entry) => { const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bh-')), 'm.js'); esbuild.buildSync({ entryPoints: [path.join(srcDir, entry)], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent' }); return require(out); };
  let bl, dir, lm, D1;
  try { bl = bundle('billing.ts'); dir = bundle('directory.ts'); lm = bundle('limits.ts'); D1 = bundle('storage/do-d1.ts').DoD1Database; } catch (e) { check(false, 'billing.ts builds: ' + String(e.message).split('\n')[0].slice(0, 160)); return; }
  const plain = (r) => (r ? { ...r } : r);
  const shim = (db) => { const sql = { exec(query, ...binds) { const s = db.prepare(query); if (/^\s*(select|with|pragma|values)\b/i.test(query) || /\breturning\b/i.test(query)) { const rows = s.all(...binds).map(plain); return { toArray: () => rows, rowsRead: rows.length, rowsWritten: 0 }; } const r = s.run(...binds); return { toArray: () => [], rowsRead: 0, rowsWritten: Number(r.changes) }; } }; const storage = { transactionSync(fn) { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } } }; return new D1(sql, storage); };
  const { newDatabase } = require('./harness.js');
  const NOW = new Date('2026-10-19T12:00:00Z');
  const CFG = { PAYFAST_MODE: 'sandbox', PAYFAST_SANDBOX_MERCHANT_ID: '10056211', PAYFAST_SANDBOX_MERCHANT_KEY: 'k', PAYFAST_SANDBOX_PASSPHRASE: 'p' };
  const world = async () => { const db = newDatabase(path.join(srcDir, '..')); const d1 = shim(db); const env = { OFFICE_DB: d1, SHARED_DB: d1, ...CFG }; await dir.ensureDirectory(env); await lm.listPlans(env); await bl.ensureBilling(env); await dir.createBusiness(env, 'acme-co', 'Acme Co', 'team', { source: 'signup' }); await dir.createBusiness(env, 'beta-co', 'Beta Co', 'team', { source: 'signup' }); return { db, env }; };
  const ts = (hoursAgo) => new Date(NOW.getTime() - hoursAgo * 3600000).toISOString().slice(0, 19).replace('T', ' ');
  let n = 0;
  const order = (w, { business = 'acme-co', status = 'pending', notices = [], created = 2 } = {}) => { const id = `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`; w.db.prepare("INSERT INTO billing_orders (id, business_id, plan, interval, seats, amount_cents, item_name, payer_email, status, created_at, last_notice) VALUES (?, 'x', 'team', 'monthly', 3, 89700, 'item', 'payer@secret.example', ?, ?, ?)").run(id, status, ts(created), notices.length ? notices.join('\n') : null); w.db.prepare('UPDATE billing_orders SET business_id = ? WHERE id = ?').run(business, id); return id; };
  const payment = (w, status, hoursAgo = 1, business = 'acme-co') => w.db.prepare("INSERT INTO billing_payments (pf_payment_id, order_id, business_id, token, status, amount_gross_cents, confirmed, ip_ok, created_at) VALUES (?, NULL, ?, 'tok-SECRET', ?, 89700, 1, 1, ?)").run(`pf-${++n}`, business, status, ts(hoursAgo));
  const health = (w, env) => bl.billingHealth(env ?? w.env, NOW);
  const codes = (h, list = 'problems') => h[list].map((p) => p.code);
  const snapshot = (w) => JSON.stringify(['billing_orders', 'billing_payments', 'businesses'].map((t) => w.db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()));

  // ---- healthy ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  { const w = await world(); const h = await health(w);
    check(h.ok === true && h.problems.length === 0 && h.watch.length === 0 && h.checkedAt === '2026-10-19T12:00:00.000Z' && typeof h.counts === 'object', 'with nothing wrong: ok, no problems, nothing to watch, and the time it was checked'); }
  { const w = await world(); order(w, { notices: [`${ts(1)} applied`, `${ts(30)} duplicate`] }); payment(w, 'complete'); payment(w, 'failed'); payment(w, 'cancelled'); const h = await health(w);
    check(h.ok === true && h.problems.length === 0, 'normal activity (applied, duplicate, a complete payment, a failed and a cancelled one) is NOT a problem: failed and cancelled are PayFast telling us, and are handled by the grace period'); }

  // ---- problems: money may be stuck -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  { const w = await world(); const id = order(w, { notices: [`${ts(2)} error: D1_ERROR: no such column: seats`] }); const h = await health(w);
    check(h.ok === false && codes(h).includes('notification_error') && h.problems[0].business === 'acme-co' && h.problems[0].order === id.slice(0, 8) && /no such column/.test(h.problems[0].detail), 'a payment notification that FAILED to apply in the last 24 hours is a problem, naming the business, the order (first 8 characters) and what went wrong'); }
  { const w = await world(); order(w, { notices: [`${ts(30)} error: old failure`] }); const h = await health(w); check(h.ok === true, 'a failure older than 24 hours is not reported again'); }
  { const w = await world(); order(w, { status: 'pending', notices: [`${ts(1)} bad_signature; fields: m_payment_id,pf_payment_id`] }); order(w, { business: 'beta-co', status: 'pending', notices: [`${ts(3)} not_confirmed: PayFast answered HTTP 200: INVALID`] }); const h = await health(w);
    check(h.ok === false && codes(h).filter((c) => c === 'notification_refused').length === 2 && h.problems.every((p) => p.code === 'notification_refused'), 'a notification REFUSED (bad signature, or not confirmed by PayFast) for an order that is still unpaid is a problem: a genuine payment may be stuck'); }
  { const w = await world(); order(w, { status: 'completed', notices: [`${ts(1)} bad_signature; fields: a,b`, `${ts(2)} applied`] }); const h = await health(w); check(h.ok === true, 'a refusal on an order that has since been applied is not a problem (the payment did go through)'); }
  { const w = await world(); payment(w, 'rejected', 5); payment(w, 'review', 60, 'beta-co'); payment(w, 'rejected', 24 * 8); const h = await health(w);
    check(h.ok === false && codes(h).filter((c) => c === 'payment_needs_review').length === 2 && h.problems.some((p) => p.business === 'beta-co'), 'money taken but not applied (a payment recorded as rejected, or as review because it was a second subscription) in the last 7 days is a problem; older ones are not'); }
  { const w = await world(); for (let i = 0; i < 80; i++) payment(w, 'rejected', 1); const h = await health(w); check(h.problems.length === 50 && h.ok === false && h.counts.problemsTotal === 80, 'at most 50 problems are listed, and the real total is still reported'); }

  // ---- watch: information, not an alarm ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  { const w = await world(); w.db.prepare("UPDATE businesses SET billing_status = 'past_due', grace_until = '2026-10-20', pf_token = 'tok-SECRET' WHERE id = 'acme-co'").run(); w.db.prepare("UPDATE businesses SET billing_status = 'past_due', grace_until = '2026-10-25' WHERE id = 'beta-co'").run(); const h = await health(w);
    check(h.ok === true && codes(h, 'watch').includes('grace_ending_soon') && h.watch.filter((p) => p.code === 'grace_ending_soon').length === 1 && h.watch[0].business === 'acme-co', 'a past-due business whose grace period ends within 2 days is WATCHED (not an alarm): it needs the owner to update their card'); }
  { const w = await world(); w.db.prepare("UPDATE businesses SET billing_status = 'past_due', grace_until = '2026-10-18' WHERE id = 'acme-co'").run(); w.db.prepare("UPDATE businesses SET billing_status = 'cancelled', period_end = '2026-10-01' WHERE id = 'beta-co'").run(); const h = await health(w);
    check(h.ok === true && codes(h, 'watch').filter((c) => c === 'lapsed_now').length === 2, 'businesses that have lapsed (grace over, or a cancelled subscription past its paid period) are WATCHED too'); }
  { const w = await world(); w.db.prepare("UPDATE businesses SET billing_status = 'active', period_end = '2020-01-01' WHERE id = 'acme-co'").run(); const h = await health(w); check(h.ok === true && h.watch.length === 0, 'an ACTIVE subscription is never reported by date (the same rule as the cutoff)'); }

  // ---- read-only, safe, and nothing secret -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  { const w = await world(); order(w, { notices: [`${ts(1)} error: boom`] }); payment(w, 'rejected', 1); w.db.prepare("UPDATE businesses SET billing_status = 'past_due', grace_until = '2026-10-20', pf_token = 'tok-SECRET' WHERE id = 'acme-co'").run(); const before = snapshot(w), h = await health(w), text = JSON.stringify(h);
    check(snapshot(w) === before, 'it changes NOTHING in the database');
    check(!/payer@secret|tok-SECRET|passphrase|merchant|signature=|@/i.test(text), 'and shows no payer address, subscription token, passphrase or merchant detail');
    check(h.problems.every((p) => typeof p.detail === 'string' && p.detail.length <= 120), 'every detail is at most 120 characters'); }
  { const w = await world(); order(w, { notices: [`${ts(1)} error: ${'x'.repeat(500)}`] }); const h = await health(w); check(h.problems[0].detail.length <= 120, 'a very long error is cut'); }
  { const w = await world(); w.db.exec('DROP TABLE billing_orders; DROP TABLE billing_payments'); const h = await health(w); check(h.ok === true && h.problems.length === 0 && (h.notes || []).length > 0, 'before any order exists (no billing tables) there is nothing to report: ok, with a note saying so'); }
  { const w = await world(); w.db.exec('ALTER TABLE billing_orders DROP COLUMN last_notice; ALTER TABLE businesses DROP COLUMN billing_status; ALTER TABLE businesses DROP COLUMN grace_until; ALTER TABLE businesses DROP COLUMN period_end'); payment(w, 'rejected', 1); const h = await health(w); check(h.problems.some((p) => p.code === 'payment_needs_review') && h.ok === false, 'on tables from before the notice trail and the billing columns existed it still reports what it can (the ledger) and does not throw'); }
  { const w = await world(); const down = { prepare: () => { throw new Error('D1 is down'); }, batch: () => { throw new Error('x'); }, exec: () => { throw new Error('x'); } }; let threw = false, h; try { h = await bl.billingHealth({ ...w.env, OFFICE_DB: down }, NOW); } catch { threw = true; }
    check(!threw && h.ok === false && h.problems.some((p) => p.code === 'health_check_failed'), 'if the database itself cannot be read it does NOT say "all well": it reports a health_check_failed problem (a silent monitor is worse than a noisy one)'); }

  // ---- the route and the scheduled workflow -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  { const dbg = fs.readFileSync(path.join(srcDir, 'debug.ts'), 'utf8'), adm = fs.readFileSync(path.join(srcDir, 'admin-routes.ts'), 'utf8');
    check(/"GET \/debug\/directory\/billing-health": "read"/.test(adm) && /url\.pathname === "\/debug\/directory\/billing-health" && request\.method === "GET"[\s\S]{0,200}billingHealth\(env\)/.test(dbg), 'the health check is a read-tier operator route'); }
  { const wf = fs.readFileSync([path.join(srcDir, '..', '..', '.github', 'workflows', 'prod-billing-health.yml'), path.join(process.cwd(), '.github', 'workflows', 'prod-billing-health.yml')].find((f) => fs.existsSync(f)), 'utf8');
    check(/schedule:\s*\n\s*- cron: "[^"]+"/.test(wf) && /workflow_dispatch:/.test(wf), 'a scheduled workflow runs it (and can be run by hand)');
    check(/PROD_ADMIN_KEY/.test(wf) && !/PROD_CONFIRM_KEY/.test(wf) && /billing-health/.test(wf) && /exit 1/.test(wf), 'it uses only the read key, calls the health route, and FAILS the run when there is a problem (GitHub then e-mails the owner)');
    check(!/git (add|commit|push)/.test(wf) && !/echo "\$\{?ADMIN/.test(wf) && /permissions:\s*\n\s*contents: read/.test(wf), 'it commits nothing (a check every half hour must not fill the history), prints no key, and has read-only repository permission');
    check(/fail the run when the check itself cannot be made/i.test(wf) || /could not be made/i.test(wf), 'and it also fails when the check itself cannot be made (a silent monitor is worse than a noisy one)'); }
};
