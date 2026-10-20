// A customer's receivables (worker/src/finance.ts allocatePayments and getCustomerReceivables, worker/src/reports-data.ts customerReceivablesData, route GET /reports/aged-debtors?customer=<id>): the drill-down from "who owes us" to THAT customer's outstanding invoices. THE RULES this pins:
// (1) ONE derivation: the aged debtors report and the customer's view use the same function, so the customer's buckets add up to the report's row for them; (2) payments are recorded per customer and applied to the OLDEST invoices first, so which invoice a payment settled is CALCULATED, never a record, and the response says so
// (fact fields and calculated fields are named, and `payment_to_invoice_match` is listed as not established); (3) ages count from the day the invoice was entered, with the report's own bucket edges (30, 60 and 90 days); (4) a payment that exceeds what is owed is shown as unapplied, not hidden; (5) bounded and defensive: a customer id must be a positive whole number, an unknown customer is null, and a long list is cut at 100 and says so.
const path = require('path'), fs = require('fs'), os = require('os'), esbuild = require('esbuild');

module.exports = async function runCustomerReceivablesTests({ check, srcDir }) {
  const bundle = (entry) => { const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cr-')), 'm.js'); esbuild.buildSync({ entryPoints: [path.join(srcDir, entry)], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent' }); return require(out); };
  let fin, rd;
  try { fin = bundle('finance.ts'); rd = bundle('reports-data.ts'); } catch (e) { check(false, 'the customer receivables build: ' + String(e.message).split('\n')[0].slice(0, 160)); return; }
  const NOW = Date.parse('2026-10-20T12:00:00Z');
  const ago = (days, now = NOW) => new Date(now - (days + 0.25) * 86400000).toISOString().slice(0, 19).replace('T', ' ');   // a quarter day past the whole-day mark, so the age is stable in any time zone
  const inv = (id, days, amount, description = 'Job ' + id) => ({ id, amount, description, created_at: ago(days) });

  // ---- the allocation: oldest first, buckets, and what is left over ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  { const a = fin.allocatePayments([inv(1, 100, 1000), inv(2, 45, 2000), inv(3, 10, 500)], 1500, NOW);
    check(a.invoices.map((i) => i.id).join() === '2,3' && a.invoices[0].applied === 500 && a.invoices[0].outstanding === 1500 && a.invoices[0].bucket === 'days30' && a.invoices[0].ageDays === 45 && a.invoices[1].applied === 0 && a.invoices[1].outstanding === 500 && a.invoices[1].bucket === 'current', 'R1,500 paid settles the oldest invoice first (R1,000) and R500 of the next: two invoices remain, with what was applied and what is left');
    check(a.current === 500 && a.days30 === 1500 && a.days60 === 0 && a.days90Plus === 0 && a.total === 2000 && a.unapplied === 0, 'and the buckets and total follow from them'); }
  { const edges = [[30, 'current'], [31, 'days30'], [60, 'days30'], [61, 'days60'], [90, 'days60'], [91, 'days90Plus']];
    const a = fin.allocatePayments(edges.map(([d], i) => inv(i + 1, d, 100)), 0, NOW);
    check(a.invoices.map((i) => i.ageDays).join() === '30,31,60,61,90,91' && a.invoices.map((i) => i.bucket).join() === edges.map((e) => e[1]).join() && a.current === 100 && a.days30 === 200 && a.days60 === 200 && a.days90Plus === 100 && a.total === 600, 'the age buckets have the report\'s own edges: up to 30 days is current, then 31 to 60, 61 to 90, and over 90'); }
  { const a = fin.allocatePayments([inv(1, 20, 1000)], 1500, NOW);
    check(a.invoices.length === 0 && a.total === 0 && a.unapplied === 500, 'a payment larger than what is owed leaves nothing outstanding and the extra R500 is shown as unapplied, not hidden');
    const none = fin.allocatePayments([], 0, NOW); check(none.invoices.length === 0 && none.total === 0 && none.unapplied === 0, 'no invoices and no payments is nothing owed'); }

  // ---- against real SQL: the customer's view adds up to the aged debtors report ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const { newDatabase } = require('./harness.js'); const D1 = bundle('storage/do-d1.ts').DoD1Database; const plain = (r) => (r ? { ...r } : r);
  const shim = (db) => { const sql = { exec(query, ...binds) { const s = db.prepare(query); if (/^\s*(select|with|pragma|values)\b/i.test(query) || /\breturning\b/i.test(query)) { const rows = s.all(...binds).map(plain); return { toArray: () => rows, rowsRead: rows.length, rowsWritten: 0 }; } const r = s.run(...binds); return { toArray: () => [], rowsRead: 0, rowsWritten: Number(r.changes) }; } }; const storage = { transactionSync(fn) { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } } }; return new D1(sql, storage); };
  const db = newDatabase(path.join(srcDir, '..')); const env = { OFFICE_DB: shim(db) };
  const cust = (name) => Number(db.prepare('INSERT INTO customers (name) VALUES (?)').run(name).lastInsertRowid);
  const addInv = db.prepare('INSERT INTO invoices (customer_id, description, amount, created_at) VALUES (?, ?, ?, ?)');
  const addPay = db.prepare("INSERT INTO payments (customer_id, amount, source_transcript, created_at) VALUES (?, ?, 't', ?)");
  const now = Date.now();
  const jenny = cust('Jenny'), ballz = cust('Ballz'), thandi = cust('Thandi'), paidup = cust('Paid Up');
  addInv.run(jenny, 'Old floor', 1000, ago(100, now)); addInv.run(jenny, 'Mid floor', 2000, ago(45, now)); addInv.run(jenny, 'New skirting', 500.5, ago(10, now)); addPay.run(jenny, 1500, ago(40, now));
  addInv.run(ballz, 'Blinds A', 700, ago(70, now)); addInv.run(ballz, 'Blinds B', 300, ago(70, now));   // two invoices entered at the same moment
  addInv.run(paidup, 'Settled job', 800, ago(50, now)); addPay.run(paidup, 800, ago(20, now));
  const report = await fin.getAgedDebtorsReport(env);
  for (const [id, name] of [[jenny, 'Jenny'], [ballz, 'Ballz']]) {
    const row = report.find((r) => r.customerId === id), mine = await fin.getCustomerReceivables(env, id, now);
    check(row && mine && mine.customer.name === name && mine.allocation.current === row.current && mine.allocation.days30 === row.days30 && mine.allocation.days60 === row.days60 && mine.allocation.days90Plus === row.days90Plus && mine.allocation.total === row.total, `${name}: the customer's buckets are EXACTLY the aged debtors report's row for them (one derivation)`);
  }
  check(!report.some((r) => r.customerId === paidup || r.customerId === thandi), 'a customer who has paid everything, and one with no invoices, are not in the report');
  { const mine = await fin.getCustomerReceivables(env, paidup, now), empty = await fin.getCustomerReceivables(env, thandi, now), nobody = await fin.getCustomerReceivables(env, 99999, now);
    check(mine && mine.allocation.invoices.length === 0 && mine.allocation.total === 0 && mine.invoiceCount === 1 && mine.payments.total === 800 && mine.payments.count === 1 && empty && empty.invoiceCount === 0 && empty.allocation.total === 0 && nobody === null, 'a paid-up customer shows nothing outstanding (but their one invoice and payment), a customer with no invoices shows nothing, and an unknown customer is null'); }

  // ---- the response: what is a fact, what is calculated, what is not established ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  { const d = await rd.customerReceivablesData(env, jenny, new Date(now)), row = (await rd.agedDebtorsData(env, new Date(now))).rows.find((r) => r.customerId === jenny);
    check(d.report === 'customer_receivables' && d.version === 1 && d.certainty === 'calculated' && d.currency === 'ZAR' && d.customer.id === jenny && d.customer.name === 'Jenny' && d.reconciles === true, 'the response is a calculated customer_receivables report that says it reconciles');
    check(d.invoices.map((i) => i.description).join('|') === 'Mid floor|New skirting' && d.invoices[0].amount === 2000 && d.invoices[0].applied === 500 && d.invoices[0].outstanding === 1500 && d.invoices[1].outstanding === 500.5 && d.outstandingCount === 2 && d.invoiceCount === 3 && d.truncated === false, 'it lists only the OUTSTANDING invoices, oldest first, with what was applied and what is outstanding, and counts the rest');
    check(d.buckets.total === row.total && d.buckets.current === row.current && d.buckets.days30 === row.days30 && d.payments.total === 1500 && d.payments.count === 1 && d.unappliedPayments === 0, 'its buckets equal the aged debtors row (rounded the same way) and it reports the payments');
    check(d.facts.join() === 'id,date,description,amount' && d.calculated.join() === 'applied,outstanding,ageDays,bucket' && d.notEstablished.includes('payment_to_invoice_match') && d.notEstablished.includes('business_date') && /not a record/.test(d.basis.allocation), 'it names which fields are FACTS and which are CALCULATED, says payments are not matched to invoices, and lists that as not established'); }
  { const big = cust('Big Debtor'); for (let i = 0; i < 120; i++) addInv.run(big, 'Invoice ' + i, 10, ago(5, now));
    const d = await rd.customerReceivablesData(env, big, new Date(now));
    check(d.invoiceCount === 120 && d.outstandingCount === 120 && d.invoices.length === 100 && d.truncated === true && d.buckets.total === 1200, 'a long list is cut at 100 invoices and says so (120 outstanding, 100 listed, truncated), while the totals still count all 120'); }
  check(await rd.customerReceivablesData(env, 99999, new Date(now)) === null, 'an unknown customer gives null (the route says 404)');

  // ---- the parameter ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  check(rd.parseCustomerParam('12').ok === true && rd.parseCustomerParam('12').id === 12 && ['0', '-1', '1.5', 'abc', '', '12abc', '012', '12345678901', ' 12', '1e3'].every((s) => rd.parseCustomerParam(s).ok === false) && rd.parseCustomerParam(null).ok === false && /positive whole number/.test(rd.parseCustomerParam('x').error), 'the customer parameter must be a positive whole number: anything else is refused with a reason');
};
