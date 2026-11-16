// Closing a financial year, step P2 (docs/decisions/year-end-close.md): the closing journal, the lock, reopening, and reports that are not fooled by the closing entry.
//   close    one event + one closing journal dated the last day of the year (income, cost of sales and expenses brought to nothing, the profit to retained earnings) + the lock moved, all or nothing
//   order    only a year that has ended, in order, only when the books are sound; a year with nothing in it closes without a journal
//   reports  profit and loss for a closed year still shows what it earned; the balance sheet has it in retained earnings, "earned so far" is only what is still open
//   reopen   the latest closed year, with a reason: the closing journal is reversed by a contra entry (nothing deleted) and the lock moves back
//   verifier finds a closing entry that was changed, or a lock moved under a closed year
const kit = require('./engine-kit.js');

module.exports = kit.guard('engine year close (P2)', async ({ check }) => {
  const eng = kit.loadEngine();
  const { facts, capabilities, periods, ledgerReports, journal, verifyIntegrity } = eng;
  const CTX = { actorEmail: 'owner@example.com', contract: 'test', contractVersion: 1 };
  const codeOf = async (fn) => { try { await fn(); return null; } catch (e) { return e && e.code ? e.code : 'threw:' + String(e && e.message).slice(0, 80); } };
  const msgOf = async (fn) => { try { await fn(); return ''; } catch (e) { return String(e && e.message); } };
  const world = async () => {
    const w = kit.makeWorld(); w.configure({ currency: 'ZAR' });
    await facts.setBusinessProfile(w.env, { legalName: 'Test (Pty) Ltd', address: '5 Industrial Road', vatRegistered: true, vatNumber: '4123456789' }, CTX);
    const customer = (await facts.recordParty(w.env, { kind: 'person', name: 'Mokoena', roles: ['customer'] }, CTX)).id;
    const supplier = (await facts.recordParty(w.env, { kind: 'organisation', name: 'Vendor', roles: ['supplier'], contact: { vatNumber: '4222222222' } }, CTX)).id;
    return { w, customer, supplier };
  };
  const invoice = (x, issuedOn, price = 100000, currency = 'ZAR') => facts.recordDocument(x.w.env, { kind: 'invoice', direction: 'sell', partyId: x.customer, currency, issuedOn, lines: [{ description: 'Job', quantityMilli: 1000, unit: 'job', unitPriceMinor: price, taxBp: 1500 }] }, CTX);
  const expense = (x, on, amount = 23000) => facts.recordExpense(x.w.env, { supplierId: x.supplier, incurredOn: on, method: 'eft', category: 'materials', currency: 'ZAR', amountsIncludeTax: true, lines: [{ description: 'Item', amountMinor: amount, taxBp: 1500 }], amountPaidMinor: amount, taxInvoiceHeld: true }, CTX);
  const close = (x, yearEnd, reason) => facts.closeYear(x.w.env, { yearEnd, reason: reason || null }, CTX);
  const balOf = (x, role) => journal.balanceOfRole(x.w.env, role);
  const pl = (x, from, to) => ledgerReports.profitAndLoss(x.w.env, from, to);
  const lock = (x) => journal.booksLockDate(x.w.env);

  // two finished years of activity and one still open: 2024/25 (Mar 2024 to Feb 2025), 2025/26, and 2026/27
  let x = await world();
  await invoice(x, '2024-06-10'); await expense(x, '2024-07-01');
  await invoice(x, '2025-06-10', 50000); await expense(x, '2025-07-01', 11500);
  await invoice(x, '2026-04-10', 30000);
  const A = '2025-02-28', B = '2026-02-28';
  const v0 = await periods.yearsView(x.w.env, '2026-11-16');
  check(v0.closed.length === 0 && v0.nextToClose && v0.nextToClose.end === A && v0.nextToClose.ended === true, 'before anything is closed the next year to close is the one holding the earliest entry, and it has ended');

  // ---- what is refused ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const before = JSON.stringify(x.w.counts());
  const refused = [
    await codeOf(() => close(x, '2025-02-27')),                // not a year-end
    await codeOf(() => close(x, '2099-02-28')),                // not ended yet
    await codeOf(() => close(x, B)),                           // an earlier year has entries
  ];
  check(refused.join() === 'invalid_input,invalid_state,invalid_state' && JSON.stringify(x.w.counts()) === before, 'a date that is not a year-end, a year that has not ended, and a year while an earlier one is still open are all refused, writing nothing');
  check((await msgOf(() => close(x, B))).includes(A), 'and the refusal names the year to close first');

  // ---- closing the first year --------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const plBefore = await pl(x, '2024-03-01', A);
  const r = await close(x, A, 'year end');
  const ev = x.w.db.prepare('SELECT type, actor_email, reason FROM eng_event WHERE id = ?').get(r.eventId);
  const entry = x.w.db.prepare("SELECT * FROM eng_journal_entry WHERE source_kind = 'manual' AND source_id = ? AND reverses_entry_id IS NULL").get(r.eventId);
  check(ev.type === 'year.closed' && ev.actor_email === 'owner@example.com' && r.profitMinor === 80000 && entry && entry.entry_date === A, 'closing is one event (who, why) and one entry dated the last day of the year; the profit is R800.00');
  const nets = x.w.db.prepare("SELECT a.code, SUM(l.debit_minor - l.credit_minor) AS n FROM eng_journal_line l JOIN eng_journal_entry e ON e.id = l.entry_id JOIN eng_account a ON a.id = l.account_id WHERE a.type IN ('income','cost_of_sales','expense') AND e.entry_date >= '2024-03-01' AND e.entry_date <= ? GROUP BY a.id").all(A);
  check(nets.length > 0 && nets.every((n) => n.n === 0), 'every income, cost and expense account nets to nothing over the closed year');
  const re = x.w.db.prepare("SELECT l.credit_minor - l.debit_minor AS n FROM eng_journal_line l JOIN eng_account a ON a.id = l.account_id WHERE l.entry_id = ? AND a.code = '3100'").get(entry.id);
  check(re && re.n === 80000 && (await balOf(x, 'retained_earnings')) === -80000, 'the profit went to retained earnings');
  check(await lock(x) === A, 'the books are locked to the last day of the year, by an event of their own');
  const plAfter = await pl(x, '2024-03-01', A);
  check(plAfter.totals.profitMinor === 80000 && plAfter.totals.incomeMinor === plBefore.totals.incomeMinor && plAfter.totals.incomeMinor === 100000, 'profit and loss for the closed year still shows what it earned (the closing entry is left out)');
  const bsA = await ledgerReports.balanceSheet(x.w.env, A);
  check(bsA.balanced === true && bsA.earningsMinor === 0 && bsA.equity.some((e) => e.name === 'Retained earnings' && e.amountMinor === 80000), 'the balance sheet at the year-end has the profit in retained earnings and none "earned so far"');
  const bsNow = await ledgerReports.balanceSheet(x.w.env, '2026-11-16');
  check(bsNow.balanced === true && bsNow.earningsMinor === 50000 - 10000 + 30000 && bsNow.equity.some((e) => e.name === 'Retained earnings' && e.amountMinor === 80000), 'today it holds the closed year in retained earnings and "earned so far" is only what is still open');
  check((await ledgerReports.trialBalanceAsAt(x.w.env, null)).balanced === true && (await verifyIntegrity(x.w.env)).ok === true, 'the trial balance still balances and the verifier is content');
  const yv = await periods.yearsView(x.w.env, '2026-11-16');
  check(yv.closed.length === 1 && yv.closed[0].end === A && yv.closed[0].profitMinor === 80000 && yv.nextToClose.end === B, 'the years read lists the closed year and names the next one to close');

  // ---- what a closed year protects ---------------------------------------------------------------------------------------------------------------------------------------------------------------
  check(await codeOf(() => invoice(x, '2024-08-01')) === 'period_locked', 'nothing can be posted into a closed year');
  check(await codeOf(() => close(x, A)) === 'invalid_state' && await codeOf(() => facts.setYearEnd(x.w.env, { month: 6, reason: null }, CTX)) === 'invalid_state', 'it cannot be closed twice, and the year-end cannot move while a year is closed');
  check(await codeOf(() => capabilities.yearEndSet.check(x.w.env, { month: 6, reason: null })) === 'invalid_state', 'and the proposal is refused when it is made');

  // ---- the second year, in order -----------------------------------------------------------------------------------------------------------------------------------------------------------------
  const rb = await close(x, B);
  check(rb.profitMinor === 50000 - 10000 && (await balOf(x, 'retained_earnings')) === -(80000 + 40000) && await lock(x) === B, 'the next year closes: retained earnings now holds both, and the lock moves on');
  check(await codeOf(() => facts.reopenYear(x.w.env, { yearEnd: A, reason: 'a mistake was found' }, CTX)) === 'invalid_state', 'the earlier year cannot be reopened while a later one is closed');
  check(await codeOf(() => facts.reopenYear(x.w.env, { yearEnd: '2030-02-28', reason: 'not closed at all' }, CTX)) === 'invalid_state', 'a year that is not closed cannot be reopened');

  // ---- reopening ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  check(capabilities.yearReopen.validate({ yearEnd: B, reason: 'no' }).ok === false && capabilities.yearReopen.validate({ yearEnd: B }).ok === false && capabilities.yearReopen.validate({ yearEnd: B, reason: 'a late supplier bill arrived' }).ok === true, 'reopening needs a reason of at least five characters');
  const ro = await facts.reopenYear(x.w.env, { yearEnd: B, reason: 'a late supplier bill arrived' }, CTX);
  const contra = x.w.db.prepare("SELECT * FROM eng_journal_entry WHERE source_kind = 'manual' AND source_id = ? AND reverses_entry_id IS NOT NULL").get(rb.eventId);
  check(x.w.db.prepare('SELECT type, reason FROM eng_event WHERE id = ?').get(ro.eventId).type === 'year.reopened' && contra && contra.entry_date === B && x.w.db.prepare("SELECT COUNT(*) AS n FROM eng_journal_entry WHERE source_kind = 'manual' AND source_id = ?").get(rb.eventId).n === 2, 'reopening is an event and a contra entry: the closing entry is still there, turned round');
  check((await balOf(x, 'retained_earnings')) === -80000 && await lock(x) === A, 'retained earnings goes back to the first year only, and the lock moves back to the end of the year before');
  check((await pl(x, '2025-03-01', B)).totals.profitMinor === 40000, 'profit and loss for the reopened year is unchanged by the close and the reopen');
  check((await verifyIntegrity(x.w.env)).ok === true && (await periods.yearsView(x.w.env, '2026-11-16')).closed.length === 1, 'the verifier is content with a reopened year (its contra is recognised) and it is no longer listed as closed');
  await expense(x, '2025-08-01', 11500);
  const rb2 = await close(x, B);
  check(rb2.profitMinor === 30000 && (await balOf(x, 'retained_earnings')) === -(80000 + 30000) && await lock(x) === B && (await verifyIntegrity(x.w.env)).ok === true, 'the late bill went in while the year was open, and the year closes again at the corrected profit');

  // ---- a year with nothing in it, and a loss -----------------------------------------------------------------------------------------------------------------------------------------------------
  const e = await world(); const re0 = await close(e, '2026-02-28');
  check(re0.profitMinor === 0 && e.w.count('eng_journal_entry') === 0 && await lock(e) === '2026-02-28' && (await verifyIntegrity(e.w.env)).ok === true, 'a year with nothing in it closes without a journal and still locks');
  const l = await world(); await expense(l, '2025-05-01', 11500); await invoice(l, '2025-06-01', 5000);
  const rl = await close(l, B);
  check(rl.profitMinor === -5000 && (await balOf(l, 'retained_earnings')) === 5000 && (await verifyIntegrity(l.w.env)).ok === true, 'a loss goes to retained earnings as a debit');

  // ---- the books must be sound, and complete -----------------------------------------------------------------------------------------------------------------------------------------------------
  const s = await world(); await invoice(s, '2025-06-10');
  s.w.db.prepare("DELETE FROM eng_journal_line WHERE id = (SELECT MIN(id) FROM eng_journal_line)").run();
  check(await codeOf(() => close(s, B)) === 'invalid_state' && (await msgOf(() => close(s, B))).includes('integrity'), 'a year is not closed while the books have an integrity problem');
  const f = await world(); await invoice(f, '2025-06-10'); await invoice(f, '2025-07-10', 100000, 'USD');
  check(await codeOf(() => close(f, B)) === 'invalid_state' && (await msgOf(() => close(f, B))).includes('another currency'), 'nor while something in another currency is not in the books');

  // ---- the verifier ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const t = await world(); await invoice(t, '2025-06-10'); const rt = await close(t, B);
  const closing = t.w.db.prepare("SELECT id FROM eng_journal_entry WHERE source_kind = 'manual' AND source_id = ? AND reverses_entry_id IS NULL").get(rt.eventId);
  t.w.db.prepare('UPDATE eng_journal_line SET debit_minor = debit_minor + 1 WHERE entry_id = ? AND debit_minor > 0').run(closing.id);
  check((await verifyIntegrity(t.w.env)).problems.some((p) => p.code === 'year_close_inconsistent'), 'a closing entry changed afterwards is found');
  const u = await world(); await invoice(u, '2025-06-10'); await close(u, B);
  u.w.db.prepare("INSERT INTO eng_event (type, actor_email, contract, contract_version, payload_json) VALUES ('books_lock.set', 'x', 'test', 1, ?)").run(JSON.stringify({ lockDate: '2025-12-31' }));
  check((await verifyIntegrity(u.w.env)).problems.some((p) => p.code === 'year_close_inconsistent' && p.detail.includes('locked')), 'a lock moved back under a closed year is found');

  // ---- ended, and in order -------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const g = await world();
  check(await codeOf(() => close(g, '2099-02-28')) === 'invalid_state' && (await msgOf(() => close(g, '2099-02-28'))).includes('not ended'), 'a year that has not ended cannot be closed, even when nothing else stands in the way');
  const h = await world(); await invoice(h, '2023-06-10'); await invoice(h, '2024-06-10'); await invoice(h, '2025-06-10');
  await close(h, '2024-02-29');
  check(await codeOf(() => close(h, B)) === 'invalid_state' && (await msgOf(() => close(h, B))).includes(A), 'after a year is closed the next must follow it: a year cannot be skipped');

  // ---- the contracts -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const cc = capabilities.yearClose;
  check(cc.validate({ yearEnd: B }).ok && cc.validate({ yearEnd: B, reason: 'x' }).ok && cc.validate({}).ok === false && cc.validate({ yearEnd: 'soon' }).ok === false && cc.validate({ yearEnd: B, extra: 1 }).ok === false && cc.permissions.join() === 'business.manage' && capabilities.yearReopen.permissions.join() === 'business.manage' && cc.heldType === 'engine.year.close' && capabilities.yearReopen.heldType === 'engine.year.reopen', 'the contracts take a real year-end date (and a reason), nothing else, and are for the owner');
  check(await codeOf(() => capabilities.yearClose.check(x.w.env, { yearEnd: B, reason: null })) === 'invalid_state' && await codeOf(() => capabilities.yearReopen.check(x.w.env, { yearEnd: A, reason: 'later year closed' })) === 'invalid_state', 'a proposal is refused when it is made, not only when it is approved');
});

if (require.main === module) kit.standalone(module.exports);
