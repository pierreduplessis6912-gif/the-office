// The general ledger, increment G4 (docs/decisions/general-ledger.md): the READS. Trial balance, an account's ledger, profit and loss, balance sheet, suspense, and the control accounts against their records.
// One small business is built through the engine's own functions, and every figure is worked out by hand here, in cents.
const kit = require('./engine-kit.js');

module.exports = kit.guard('engine general ledger (G4: reads)', async ({ check }) => {
  const eng = kit.loadEngine();
  const { facts, journal, ledgerReports: rep, permissions, capabilities } = eng;
  const CTX = { actorEmail: 'owner@example.com', contract: 'test', contractVersion: 1 };
  const codeOf = async (fn) => { try { await fn(); return null; } catch (e) { return e && e.code ? e.code : 'threw:' + String(e && e.message).slice(0, 80); } };

  const w = kit.makeWorld(); w.configure({ currency: 'ZAR' });
  await facts.setBusinessProfile(w.env, { legalName: 'Test (Pty) Ltd', address: '5 Industrial Road', vatRegistered: true, vatNumber: '4123456789' }, CTX);
  const customer = (await facts.recordParty(w.env, { kind: 'person', name: 'Mokoena', roles: ['customer'] }, CTX)).id;
  const supplier = (await facts.recordParty(w.env, { kind: 'organisation', name: 'Vendor', roles: ['supplier'], contact: { vatNumber: '4222222222' } }, CTX)).id;
  const item = (await facts.createItem(w.env, { sku: 'A-1', name: 'Alpha', unit: 'sheet' }, CTX)).itemId;
  const loc = (await facts.createLocation(w.env, { name: 'Store', kind: 'warehouse' }, CTX)).locationId;
  await facts.postJournal(w.env, { date: '2026-10-01', kind: 'opening', reason: 'opening balances for the test', lines: [{ account: '1000', debitMinor: 1000000 }, { account: '3000', creditMinor: 1000000 }] }, CTX);
  const bank = (await journal.accountForRole(w.env, 'bank')).code;
  const inv = await facts.recordDocument(w.env, { kind: 'invoice', direction: 'sell', partyId: customer, currency: 'ZAR', issuedOn: '2026-10-10', lines: [{ description: 'Job', quantityMilli: 1000, unit: 'job', unitPriceMinor: 100000, taxBp: 1500 }] }, CTX);   // net 1,000.00 + VAT 150.00
  await facts.recordPayment(w.env, { direction: 'in', partyId: customer, amountMinor: 50000, currency: 'ZAR', occurredOn: '2026-10-12', method: 'eft', allocations: [{ documentId: inv.id, amountMinor: 50000 }] }, CTX);
  await facts.recordExpense(w.env, { supplierId: supplier, incurredOn: '2026-10-15', method: 'eft', category: 'materials', currency: 'ZAR', amountsIncludeTax: true, lines: [{ description: 'Item', amountMinor: 23000, taxBp: 1500 }], amountPaidMinor: 23000, taxInvoiceHeld: true }, CTX);   // net 200.00 + VAT 30.00
  await facts.receiveStock(w.env, { itemId: item, locationId: loc, quantityMilli: 10000, receivedOn: '2026-10-16', unitCostMinor: 5000 }, CTX);   // R500.00, no goods receipt: suspense
  await facts.issueStock(w.env, { itemId: item, locationId: loc, quantityMilli: 2000, issuedOn: '2026-10-20', reason: 'use' }, CTX);   // R100.00 cost of sales

  // ---- trial balance ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const tb = await rep.trialBalanceAsAt(w.env, null);
  const get = (code) => tb.rows.find((r) => r.code === code);
  check(tb.balanced === true && tb.totalDebitMinor === tb.totalCreditMinor && tb.rows.every((r) => r.debitMinor !== 0 || r.creditMinor !== 0), 'the trial balance balances, and lists only accounts that have been used');
  check(get(bank).balanceMinor === 1000000 + 50000 - 23000 && get('1100').balanceMinor === 65000 && get('1200').balanceMinor === 40000 && get('1300').balanceMinor === 3000 && get('1900').balanceMinor === -50000 && get('2100').balanceMinor === -15000, 'bank R10,270.00, receivables R650.00, inventory R400.00, VAT input R30.00, suspense R500.00 (credit), VAT output R150.00 (credit): each worked out by hand');
  const early = await rep.trialBalanceAsAt(w.env, '2026-10-05');
  check(early.rows.length === 2 && early.balanced && early.asOf === '2026-10-05', 'as at 5 October only the opening balances exist');
  const none = await rep.trialBalanceAsAt(w.env, '2026-09-30');
  check(none.rows.length === 0 && none.balanced, 'before anything happened there is nothing, and it still balances');

  // ---- profit and loss ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const pl = await rep.profitAndLoss(w.env, '2026-10-01', '2026-10-31');
  check(pl.totals.incomeMinor === 100000 && pl.totals.costOfSalesMinor === 10000 && pl.totals.grossProfitMinor === 90000 && pl.totals.expensesMinor === 20000 && pl.totals.profitMinor === 70000, 'profit and loss for October: sales R1,000.00, cost of sales R100.00, expenses R200.00, profit R700.00 (VAT is not income or cost)');
  check(pl.income.length === 1 && pl.income[0].name === 'Sales' && pl.expenses.length === 1 && pl.expenses[0].amountMinor === 20000, 'by account');
  const plNarrow = await rep.profitAndLoss(w.env, '2026-10-13', '2026-10-17');
  check(plNarrow.totals.incomeMinor === 0 && plNarrow.totals.expensesMinor === 20000 && plNarrow.totals.profitMinor === -20000, 'a narrower period counts only what was dated in it (the expense on the 15th, not the sale on the 10th)');

  // ---- balance sheet ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const bs = await rep.balanceSheet(w.env, '2026-10-31');
  check(bs.totals.assetsMinor === 1027000 + 65000 + 40000 + 3000 - 50000 && bs.totals.liabilitiesMinor === 15000 && bs.totals.equityMinor === 1000000 && bs.earningsMinor === 70000, 'balance sheet at 31 October: assets R10,850.00, liabilities R150.00, equity R10,000.00, profit to date R700.00');
  check(bs.balanced === true && bs.totals.liabilitiesAndEquityMinor === bs.totals.assetsMinor, 'and assets equal liabilities plus equity plus profit');
  const bsEarly = await rep.balanceSheet(w.env, '2026-10-05');
  check(bsEarly.balanced && bsEarly.earningsMinor === 0 && bsEarly.totals.assetsMinor === 1000000, 'at an early date only the opening balances show, and it balances');

  // ---- an account's ledger ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const al = await rep.accountLedger(w.env, bank, null, null);
  check(al.lines.length === 3 && al.openingMinor === 0 && al.closingMinor === 1027000 && al.lines.map((l) => l.runningMinor).join() === '1000000,1050000,1027000', 'the bank account lists its three entries in date order with a running balance');
  check(al.lines.every((l) => l.source.kind && l.source.id) && al.lines[0].memo === 'Opening balances', 'each line says which fact caused it');
  const alFrom = await rep.accountLedger(w.env, bank, '2026-10-13', null);
  check(alFrom.openingMinor === 1050000 && alFrom.lines.length === 1 && alFrom.closingMinor === 1027000, 'starting part way through, it carries the balance forward as the opening figure');
  check(await rep.accountLedger(w.env, '9999', null, null) === null, 'an account that does not exist is reported as not found');

  // ---- suspense, reconciliation -----------------------------------------------------------------------------------------------------------------------------------------------------------------
  const sp = await rep.suspenseReport(w.env);
  check(sp.balanceMinor === -50000 && sp.lines.length === 1, 'suspense shows the R500.00 of stock that had no document behind it, as a visible defect');
  const rc = await rep.reconciliation(w.env);
  check(rc.agrees === true && rc.lines.length === 3 && rc.lines.every((l) => l.differenceMinor === 0) && rc.lines[0].ledgerMinor === 65000 && rc.lines[2].ledgerMinor === 40000, 'receivables, payables and inventory agree with the customer, supplier and stock records');
  w.db.prepare("DELETE FROM eng_journal_line WHERE account_id = (SELECT account_id FROM eng_account_role WHERE role = 'inventory') AND credit_minor > 0").run();
  const bad = await rep.reconciliation(w.env);
  check(bad.agrees === false && bad.lines[2].differenceMinor === 10000 && bad.lines[0].differenceMinor === 0, 'if a line is removed behind the engine\'s back, the reconciliation names the account and the difference (R100.00 on inventory)');

  // ---- who may read, the contracts and the routes -------------------------------------------------------------------------------------------------------------------------------------------
  const can = (caps) => permissions.permissionsFor(caps).has('ledger.read');
  check(can(['can_manage_settings']) && can(['can_know_profit']) && !can(['can_manage_invoices']) && !can(['can_know_debtors', 'can_know_materials', 'can_make_quotes']), 'the books may be read by the owner and by whoever may know profit, and by nobody else');
  const ids = ['ledger.trial_balance', 'ledger.account', 'ledger.profit_and_loss', 'ledger.balance_sheet', 'ledger.suspense', 'ledger.reconciliation'];
  check(ids.every((i) => capabilities.CAPABILITY_IDS.includes(i)), 'all six reads exist as capabilities');
  const v = (c, p) => capabilities.READS.find((r) => r.id === c).validate(p).ok;
  check(v('ledger.profit_and_loss', { from: '2026-10-01', to: '2026-10-31' }) && !v('ledger.profit_and_loss', { from: '2026-10-31', to: '2026-10-01' }) && !v('ledger.profit_and_loss', { from: '2026-10-01' }) && !v('ledger.balance_sheet', {}) && !v('ledger.balance_sheet', { asOf: '31 Oct' }) && !v('ledger.account', { code: 'bank' }) && !v('ledger.trial_balance', { asOf: '2026-10-31', extra: 1 }) && v('ledger.trial_balance', {}) && v('ledger.suspense', {}), 'the reads check their parameters: dates, ordering, an account code, no stray fields');
  const AV = [...ids];
  const via = (role, path) => kit.route({ env: {}, seed: kit.seedReceivables(AV), method: 'GET', path, role });
  const a1 = await via('accountant', '/engine/ledger/trial-balance'), a2 = await via('owner', '/engine/ledger/profit-and-loss?from=2026-10-01&to=2026-10-31'), a3 = await via('sales', '/engine/ledger/trial-balance'), a4 = await via('admin', '/engine/ledger/balance-sheet?asOf=2026-10-31'), a5 = await via('accountant', '/engine/ledger/account?code=9999');
  check(a1.result.status === 200 && a1.result.body.result.balanced === true && a2.result.status === 200 && a2.result.body.result.totals && a3.result.status === 403 && a4.result.status === 403, 'through the real route the accountant and owner may read the books; a salesperson and an admin (who may not know profit) may not');
  const p1 = await via('accountant', '/engine/ledger/profit-and-loss?period=this_month'), p2 = await via('accountant', '/engine/ledger/profit-and-loss?period=next_year'), p3 = await via('accountant', '/engine/ledger/balance-sheet');
  check(p1.result.status === 200 && /^\d{4}-\d{2}-01$/.test(p1.result.body.result.from) && p2.result.status === 422 && p3.result.status === 200 && /^\d{4}-\d{2}-\d{2}$/.test(p3.result.body.result.asOf), 'the app can ask for "this_month" and leave the balance sheet date out: the engine works those dates out (a period it does not know is refused)');
  check(a5.result.status === 404 || a5.result.status === 400, 'an unknown account through the route is a plain refusal, not a crash');
  check(Object.keys(a1.writes).length === 0 && Object.keys(a2.writes).length === 0, 'reading the books writes nothing at all');
});

if (require.main === module) kit.standalone(module.exports);
