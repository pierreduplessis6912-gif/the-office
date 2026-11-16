// The indirect cash flow and named periods, step P3 (docs/decisions/year-end-close.md): why cash changed, starting from profit, checked against the direct cash flow.
//   indirect  profit, adjusted by what customers owe, VAT, stock, what is owed to suppliers, then the owner's own money in and out; it must equal the direct cash flow, and a difference is reported
//   closing   a closed year's closing entry is left out, so the year's profit is not counted twice and the two cash flows still agree
//   periods   this_month, last_month, this_financial_year, last_financial_year are dated by the ENGINE; anything else is not a period
const kit = require('./engine-kit.js');

module.exports = kit.guard('engine indirect cash flow (P3)', async ({ check }) => {
  const eng = kit.loadEngine();
  const { facts, capabilities, periods, ledgerReports, journal } = eng;
  const CTX = { actorEmail: 'owner@example.com', contract: 'test', contractVersion: 1 };
  const world = async () => {
    const w = kit.makeWorld(); w.configure({ currency: 'ZAR' });
    await facts.setBusinessProfile(w.env, { legalName: 'Test (Pty) Ltd', address: '5 Industrial Road', vatRegistered: true, vatNumber: '4123456789' }, CTX);
    const customer = (await facts.recordParty(w.env, { kind: 'person', name: 'Mokoena', roles: ['customer'] }, CTX)).id;
    const supplier = (await facts.recordParty(w.env, { kind: 'organisation', name: 'Vendor', roles: ['supplier'], contact: { vatNumber: '4222222222' } }, CTX)).id;
    return { w, customer, supplier };
  };
  const invoice = (x, on, price = 100000) => facts.recordDocument(x.w.env, { kind: 'invoice', direction: 'sell', partyId: x.customer, currency: 'ZAR', issuedOn: on, lines: [{ description: 'Job', quantityMilli: 1000, unit: 'job', unitPriceMinor: price, taxBp: 1500 }] }, CTX);
  const payIn = (x, amount, on) => facts.recordPayment(x.w.env, { direction: 'in', partyId: x.customer, amountMinor: amount, currency: 'ZAR', occurredOn: on, method: 'eft', allocations: [] }, CTX);
  const expense = (x, on, amount = 23000) => facts.recordExpense(x.w.env, { supplierId: x.supplier, incurredOn: on, method: 'eft', category: 'materials', currency: 'ZAR', amountsIncludeTax: true, lines: [{ description: 'Item', amountMinor: amount, taxBp: 1500 }], amountPaidMinor: amount, taxInvoiceHeld: true }, CTX);
  const get = (list, name) => (list.find((i) => i.name === name) || {}).amountMinor;

  // ---- one month, by hand ------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const x = await world();
  await invoice(x, '2026-11-02'); await payIn(x, 50000, '2026-11-05'); await expense(x, '2026-11-06');
  const ic = await ledgerReports.indirectCashFlow(x.w.env, '2026-11-01', '2026-11-30'), dc = await ledgerReports.cashFlow(x.w.env, '2026-11-01', '2026-11-30');
  check(ic.profitMinor === 80000 && get(ic.adjustments, 'Money customers owe') === -65000 && get(ic.adjustments, 'VAT') === 12000, 'profit R800.00; R650.00 of the sale is still owed by the customer (less cash); VAT collected less VAT paid is R120.00 more cash');
  check(ic.operatingMinor === 27000 && ic.netMinor === 27000 && dc.netMinor === 27000 && ic.directNetMinor === 27000 && ic.agrees === true, 'adjusted profit is R270.00, the same change in cash as the direct cash flow, and it says they agree');
  check(ic.openingMinor === 0 && ic.closingMinor === 27000 && ic.financing.length === 0, 'opening and closing cash are given and there is no owner money in or out');

  // ---- the owner's own money ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const bankCode = (await journal.accountForRole(x.w.env, 'bank')).code;
  await facts.postJournal(x.w.env, { date: '2026-11-10', kind: 'manual', reason: 'owner put money in', lines: [{ account: bankCode, debitMinor: 100000 }, { account: '3000', creditMinor: 100000 }] }, CTX);
  const ic2 = await ledgerReports.indirectCashFlow(x.w.env, '2026-11-01', '2026-11-30');
  check(get(ic2.financing, "The owner's money in and out") === 100000 && ic2.netMinor === 127000 && ic2.agrees === true, 'money the owner puts in is shown apart from operations, and the two cash flows still agree');

  // ---- stock and suppliers -----------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const s = await world();
  const item = (await facts.createItem(s.w.env, { sku: 'A-1', name: 'Alpha', unit: 'sheet' }, CTX)).itemId, loc = (await facts.createLocation(s.w.env, { name: 'Store', kind: 'warehouse' }, CTX)).locationId;
  await facts.receiveStock(s.w.env, { itemId: item, locationId: loc, quantityMilli: 2000, receivedOn: '2026-11-03', unitCostMinor: 5000 }, CTX);
  await facts.recordPayment(s.w.env, { direction: 'out', partyId: s.supplier, amountMinor: 10000, currency: 'ZAR', occurredOn: '2026-11-04', method: 'eft', allocations: [] }, CTX);
  const is = await ledgerReports.indirectCashFlow(s.w.env, '2026-11-01', '2026-11-30');
  check(is.agrees === true && is.netMinor === -10000 && is.adjustments.length > 0, 'stock taken in and money paid out to a supplier: the causes are listed and the total is the change in cash');

  // ---- a closed year ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const c = await world();
  await invoice(c, '2024-06-10'); await payIn(c, 115000, '2024-06-20'); await expense(c, '2024-07-01');
  const before = await ledgerReports.indirectCashFlow(c.w.env, '2024-03-01', '2025-02-28');
  await facts.closeYear(c.w.env, { yearEnd: '2025-02-28', reason: null }, CTX);
  const after = await ledgerReports.indirectCashFlow(c.w.env, '2024-03-01', '2025-02-28');
  check(JSON.stringify(after) === JSON.stringify(before) && after.profitMinor === 80000 && after.agrees === true, 'closing the year changes nothing in its cash flow: the closing entry is left out, so the profit is not counted twice');
  const next = await ledgerReports.indirectCashFlow(c.w.env, '2025-03-01', '2026-02-28');
  check(next.profitMinor === 0 && next.netMinor === 0 && next.agrees === true && next.openingMinor === 92000, 'the year after starts with the cash the first year left and shows nothing moved');

  // ---- nothing booked ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const e = await world(); const ie = await ledgerReports.indirectCashFlow(e.w.env, '2026-11-01', '2026-11-30');
  check(ie.profitMinor === 0 && ie.adjustments.length === 0 && ie.financing.length === 0 && ie.netMinor === 0 && ie.agrees === true, 'a business that has booked nothing has an empty indirect cash flow');
  const written = JSON.stringify(x.w.counts()); await ledgerReports.indirectCashFlow(x.w.env, '2026-11-01', '2026-11-30');
  check(JSON.stringify(x.w.counts()) === written, 'reading it writes nothing');

  // ---- named periods -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const pr = (p, t = '2026-11-16') => periods.periodRange(x.w.env, p, t);
  check(JSON.stringify(await pr('this_month')) === JSON.stringify({ from: '2026-11-01', to: '2026-11-30' }) && JSON.stringify(await pr('last_month', '2026-01-15')) === JSON.stringify({ from: '2025-12-01', to: '2025-12-31' }), 'this month and last month, across a year boundary too');
  check(JSON.stringify(await pr('this_financial_year')) === JSON.stringify({ from: '2026-03-01', to: '2027-02-28' }) && JSON.stringify(await pr('last_financial_year')) === JSON.stringify({ from: '2025-03-01', to: '2026-02-28' }), 'this and last financial year follow the year-end (February until set)');
  await facts.setYearEnd(x.w.env, { month: 6, reason: null }, CTX);
  check(JSON.stringify(await pr('last_financial_year')) === JSON.stringify({ from: '2025-07-01', to: '2026-06-30' }), 'and move when the year-end is set');
  check(await pr('next_year') === null && await pr('') === null && await pr('THIS_MONTH') === null, 'anything else is not a period');

  // ---- the contract and the route ---------------------------------------------------------------------------------------------------------------------------------------------------------------
  const rd = capabilities.ledgerCashFlowIndirect;
  check(rd.permissions[0] === 'ledger.read' && rd.validate({ from: '2026-11-01', to: '2026-11-30' }).ok && !rd.validate({ from: '2026-11-30', to: '2026-11-01' }).ok && !rd.validate({ from: '2026-11-01' }).ok && !rd.validate({ from: '2026-11-01', to: '2026-11-30', x: 1 }).ok, 'the read is for whoever may read the books and needs a real period in order');
  const AV = ['ledger.cash_flow_indirect', 'ledger.profit_and_loss', 'ledger.cash_flow'];
  const via = (role, path) => kit.route({ env: {}, seed: kit.seedReceivables(AV), method: 'GET', path, role });
  const a = await via('accountant', '/engine/ledger/cash-flow-indirect?period=this_financial_year'), b = await via('accountant', '/engine/ledger/profit-and-loss?period=last_financial_year'), d = await via('accountant', '/engine/ledger/cash-flow?period=next_year'), f = await via('sales', '/engine/ledger/cash-flow-indirect?period=this_month');
  check(a.result.status === 200 && /^\d{4}-03-01$/.test(a.result.body.result.from) && a.result.body.result.agrees === true && b.result.status === 200 && /-02-2[89]$/.test(b.result.body.result.to) && d.result.status === 422 && f.result.status === 403, 'over HTTP: the engine dates a financial year, an unknown period is refused, and a salesperson is refused');
});

if (require.main === module) kit.standalone(module.exports);
