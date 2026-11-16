// The bank reads, increment G5c (docs/decisions/bank-reconciliation.md): the bank account against the latest statement, and cash flow.
//   reconciliation  books vs statement, entries not yet on the statement, statement lines not yet in the books; the rest is UNEXPLAINED (a finding); "reconciled" only when nothing is left open
//   cash flow       what came into the bank and cash accounts and went out, by cause; opening + net = closing
//   reads           nothing is written; the app may say this_month and the engine dates it; whoever may read the books may read these
const kit = require('./engine-kit.js');

module.exports = kit.guard('engine bank reads (G5c)', async ({ check }) => {
  const eng = kit.loadEngine();
  const { facts, capabilities, bank, ledgerReports, journal } = eng;
  const CTX = { actorEmail: 'owner@example.com', contract: 'test', contractVersion: 1 };
  const L = (date, description, amountMinor) => ({ date, description, amountMinor });
  const world = async () => {
    const w = kit.makeWorld(); w.configure({ currency: 'ZAR' });
    await facts.setBusinessProfile(w.env, { legalName: 'Test (Pty) Ltd', address: '5 Industrial Road', vatRegistered: true, vatNumber: '4123456789' }, CTX);
    const customer = (await facts.recordParty(w.env, { kind: 'person', name: 'Mokoena', roles: ['customer'] }, CTX)).id;
    const supplier = (await facts.recordParty(w.env, { kind: 'organisation', name: 'Timber Supplies', roles: ['supplier'], contact: { vatNumber: '4222222222' } }, CTX)).id;
    return { w, customer, supplier };
  };
  const payIn = (x, amount, on = '2026-11-02', method = 'eft') => facts.recordPayment(x.w.env, { direction: 'in', partyId: x.customer, amountMinor: amount, currency: 'ZAR', occurredOn: on, method, allocations: [] }, CTX);
  const payOut = (x, amount, on = '2026-11-10') => facts.recordPayment(x.w.env, { direction: 'out', partyId: x.supplier, amountMinor: amount, currency: 'ZAR', occurredOn: on, method: 'eft', allocations: [] }, CTX);
  const fee = async (x, amount, on = '2026-11-03') => facts.postJournal(x.w.env, { date: on, kind: 'manual', reason: 'monthly bank fee', lines: [{ account: '6001', debitMinor: amount }, { account: (await journal.accountForRole(x.w.env, 'bank')).code, creditMinor: amount }] }, CTX);
  const bring = async (x, lines, opening = 0) => {
    const v = capabilities.bankStatementImport.validate({ periodFrom: '2026-11-01', periodTo: '2026-11-30', openingMinor: opening, closingMinor: opening + lines.reduce((s, l) => s + l.amountMinor, 0), lines });
    if (!v.ok) throw new Error(v.reason); return facts.importStatement(x.w.env, v.value, CTX);
  };
  const lineId = (x, t) => x.w.db.prepare('SELECT id FROM eng_bank_line WHERE description = ?').get(t).id;
  const entryOf = async (x, amount) => (await bank.openBankEntries(x.w.env)).find((e) => e.amountMinor === amount).journalLineId;
  const match = async (x, text, amount) => facts.confirmMatches(x.w.env, { matches: [{ bankLineId: lineId(x, text), journalLineIds: [await entryOf(x, amount)] }] }, CTX);

  // ---- no statement yet --------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  let x = await world(); await payIn(x, 1000);
  let r0 = await ledgerReports.bankReconciliation(x.w.env, null);
  check(r0.statement === null && r0.reconciled === false && r0.ledgerMinor === null, 'with no statement there is nothing to reconcile against, and it does not claim to be reconciled');

  // ---- books against the statement ---------------------------------------------------------------------------------------------------------------------------------------------------------------
  x = await world();
  await payIn(x, 250000); await payOut(x, 90000); await fee(x, 1500); await payIn(x, 40000, '2026-11-12');
  await bring(x, [L('2026-11-02', 'EFT Mokoena INV-12', 250000), L('2026-11-03', 'Bank fee', -1500), L('2026-11-10', 'EFT Timber Supplies', -90000), L('2026-11-14', 'Mystery deposit', 30000)]);
  const written = JSON.stringify(x.w.counts());
  await match(x, 'EFT Mokoena INV-12', 250000); await match(x, 'EFT Timber Supplies', -90000); await match(x, 'Bank fee', -1500);
  const rec = await ledgerReports.bankReconciliation(x.w.env, null);
  check(rec.ledgerMinor === 198500 && rec.statementMinor === 188500 && rec.outstandingMinor === 40000 && rec.unmatchedMinor === 30000 && rec.outstandingEntries.length === 1 && rec.unmatchedLines.length === 1, 'the books hold R1,985.00, the statement R1,885.00: the R400.00 payment not yet on the statement and the R300.00 deposit not yet in the books are listed');
  check(rec.unexplainedMinor === 0 && rec.agrees === true && rec.reconciled === false, 'and they account for the whole difference (nothing unexplained), but it is not reconciled while those two are open');
  check(rec.statement.periodTo === '2026-11-30' && rec.outstandingEntries[0].party === 'Mokoena' && rec.unmatchedLines[0].description === 'Mystery deposit', 'each open item says what it is');
  const open = await ledgerReports.bankReconciliation(x.w.env, '2026-10-31');
  check(open.statement === null, 'asking as at a date before any statement finds none');
  // the person says what the deposit is (a customer payment) and the payment clears: reconciled
  await payIn(x, 30000, '2026-11-14');
  await match(x, 'Mystery deposit', 30000);
  const done = await ledgerReports.bankReconciliation(x.w.env, null);
  check(done.unmatchedLines.length === 0 && done.outstandingEntries.length === 1 && done.unexplainedMinor === 0, 'once the deposit is recorded and matched only the uncleared payment remains');
  const y = await world(); await payIn(y, 250000);
  await bring(y, [L('2026-11-02', 'EFT Mokoena', 250000)]); await match(y, 'EFT Mokoena', 250000);
  const yr = await ledgerReports.bankReconciliation(y.w.env, null);
  check(yr.reconciled === true && yr.agrees === true && yr.outstandingEntries.length === 0 && yr.unmatchedLines.length === 0, 'when every line is matched and nothing is outstanding the bank is reconciled');
  const z = await world(); await payIn(z, 250000);
  await bring(z, [L('2026-11-02', 'EFT Mokoena', 250000)], 5000); await match(z, 'EFT Mokoena', 250000);
  const zr = await ledgerReports.bankReconciliation(z.w.env, null);
  check(zr.agrees === false && zr.unexplainedMinor === -5000 && zr.reconciled === false, 'a statement that opened with money the books never saw leaves a difference nothing explains: it is reported, never hidden');

  // ---- cash flow ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const c = await world();
  await payIn(c, 70000, '2026-10-15'); await payIn(c, 250000); await payIn(c, 10000, '2026-11-04', 'cash'); await payIn(c, 5000, '2026-11-01'); await payOut(c, 90000); await fee(c, 1500);
  const w0 = JSON.stringify(c.w.counts());
  const cf = await ledgerReports.cashFlow(c.w.env, '2026-11-01', '2026-11-30');
  const got = (list, name) => (list.find((i) => i.name === name) || {}).amountMinor;
  check(cf.openingMinor === 70000 && got(cf.inflows, 'Received from customers') === 265000 && got(cf.outflows, 'Paid to suppliers and for expenses') === 90000 && got(cf.outflows, 'Journals') === 1500 && cf.netMinor === 173500 && cf.closingMinor === 243500 && cf.balanced === true, 'cash flow: opening R700.00, R2,650.00 received (bank and cash together), R900.00 paid to suppliers, R15.00 of journals, closing R2,435.00, and opening + net = closing');
  const cfOct = await ledgerReports.cashFlow(c.w.env, '2026-10-01', '2026-10-31');
  check(cfOct.openingMinor === 0 && cfOct.closingMinor === 70000 && cfOct.outflows.length === 0 && cfOct.balanced === true, 'the month before shows only what came in then');
  const none = await ledgerReports.cashFlow((await world()).w.env, '2026-11-01', '2026-11-30');
  check(none.openingMinor === 0 && none.closingMinor === 0 && none.inflows.length === 0 && none.balanced === true, 'a business that has booked nothing has an empty cash flow');
  check(JSON.stringify(c.w.counts()) === w0 && JSON.stringify(x.w.counts()) !== written, 'reading the cash flow writes nothing');

  // ---- the contracts and the route ---------------------------------------------------------------------------------------------------------------------------------------------------------------
  const cc = capabilities.ledgerCashFlow, cr = capabilities.ledgerBankReconciliation;
  check(cc.permissions[0] === 'ledger.read' && cr.permissions[0] === 'ledger.read' && cc.validate({ from: '2026-11-01', to: '2026-11-30' }).ok === true && cc.validate({ from: '2026-11-30', to: '2026-11-01' }).ok === false && cc.validate({ from: '2026-11-01' }).ok === false && cc.validate({ from: '2026-11-01', to: '2026-11-30', x: 1 }).ok === false && cr.validate({}).ok === true && cr.validate({ asOf: 'tomorrow' }).ok === false, 'both reads are for whoever may read the books; cash flow needs a real period, in order, and no stray field');
  const AV = ['ledger.cash_flow', 'ledger.bank_reconciliation'];
  const via = (role, path) => kit.route({ env: {}, seed: kit.seedReceivables(AV), method: 'GET', path, role });
  const a = await via('accountant', '/engine/ledger/cash-flow?period=this_month'), b = await via('accountant', '/engine/ledger/cash-flow?period=next_year'), d = await via('accountant', '/engine/ledger/bank-reconciliation'), e = await via('sales', '/engine/ledger/cash-flow?period=this_month');
  check(a.result.status === 200 && /^\d{4}-\d{2}-01$/.test(a.result.body.result.from) && b.result.status === 422 && d.result.status === 200 && d.result.body.result.statement === null && e.result.status === 403, 'over HTTP: the engine dates "this_month", an unknown period is refused, the reconciliation answers, and a salesperson is refused');
});

if (require.main === module) kit.standalone(module.exports);
