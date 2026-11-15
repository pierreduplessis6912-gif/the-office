// The general ledger, increment G3 (docs/decisions/general-ledger.md): the BOOKS LOCK, MANUAL JOURNALS and OPENING BALANCES.
//   lock      one date, a recorded fact; nothing posts on or before it (the whole fact is refused, atomically); moving it back is unlocking and needs a reason
//   journals  balanced, with a reason, owner only; never edited, reversed by a contra; cannot touch the accounts the engine keeps from invoices, bills and stock
//   opening   one opening journal at a time
const kit = require('./engine-kit.js');

module.exports = kit.guard('engine general ledger (G3: lock, journals, opening balances)', async ({ check }) => {
  const eng = kit.loadEngine();
  const { facts, journal, permissions, capabilities, verifyIntegrity } = eng;
  const CTX = { actorEmail: 'owner@example.com', contract: 'test', contractVersion: 1 };
  const codeOf = async (fn) => { try { await fn(); return null; } catch (e) { return e && e.code ? e.code : 'threw:' + String(e && e.message).slice(0, 80); } };
  const msgOf = async (fn) => { try { await fn(); return ''; } catch (e) { return String(e && e.message); } };
  const world = async () => {
    const w = kit.makeWorld(); w.configure({ currency: 'ZAR' });
    await facts.setBusinessProfile(w.env, { legalName: 'Test (Pty) Ltd', address: '5 Industrial Road', vatRegistered: true, vatNumber: '4123456789' }, CTX);
    const customer = (await facts.recordParty(w.env, { kind: 'person', name: 'Mokoena', roles: ['customer'] }, CTX)).id;
    const supplier = (await facts.recordParty(w.env, { kind: 'organisation', name: 'Vendor', roles: ['supplier'], contact: { vatNumber: '4222222222' } }, CTX)).id;
    const item = (await facts.createItem(w.env, { sku: 'A-1', name: 'Alpha', unit: 'sheet' }, CTX)).itemId;
    const loc = (await facts.createLocation(w.env, { name: 'Store', kind: 'warehouse' }, CTX)).locationId;
    return { w, customer, supplier, item, loc };
  };
  const invoice = (x, issuedOn) => facts.recordDocument(x.w.env, { kind: 'invoice', direction: 'sell', partyId: x.customer, currency: 'ZAR', issuedOn, lines: [{ description: 'Job', quantityMilli: 1000, unit: 'job', unitPriceMinor: 100000, taxBp: 1500 }] }, CTX);
  const bal = (x, role) => journal.balanceOfRole(x.w.env, role);
  const codeFor = async (x, role) => (await journal.accountForRole(x.w.env, role)).code;

  // ---- the lock ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  let x = await world();
  await invoice(x, '2026-10-10');
  check(await journal.booksLockDate(x.w.env) === null, 'a business that has never locked its books has no lock');
  const lk = await facts.setBooksLock(x.w.env, { lockDate: '2026-10-31' }, CTX);
  check(await journal.booksLockDate(x.w.env) === '2026-10-31' && x.w.db.prepare('SELECT type FROM eng_event WHERE id = ?').get(lk.eventId).type === 'books_lock.set', 'locking the books is an event, and the lock is the latest one');
  const before = JSON.stringify(x.w.counts());
  const refusals = [
    await codeOf(() => invoice(x, '2026-10-15')),
    await codeOf(() => facts.recordExpense(x.w.env, { supplierId: x.supplier, incurredOn: '2026-10-20', method: 'eft', category: 'materials', currency: 'ZAR', amountsIncludeTax: true, lines: [{ description: 'Item', amountMinor: 23000, taxBp: 1500 }], amountPaidMinor: 23000, taxInvoiceHeld: true }, CTX)),
    await codeOf(() => facts.recordPayment(x.w.env, { direction: 'in', partyId: x.customer, amountMinor: 1000, currency: 'ZAR', occurredOn: '2026-10-31', method: 'eft', allocations: [] }, CTX)),
    await codeOf(() => facts.receiveStock(x.w.env, { itemId: x.item, locationId: x.loc, quantityMilli: 1000, receivedOn: '2026-10-05', unitCostMinor: 100 }, CTX)),
  ];
  check(refusals.every((c) => c === 'period_locked') && JSON.stringify(x.w.counts()) === before, 'an invoice, an expense, a payment and a stock receipt dated on or before the lock are all refused (period_locked), and nothing at all is written');
  check((await msgOf(() => invoice(x, '2026-10-15'))).includes('2026-10-31'), 'and the message names the lock date');
  check(await codeOf(() => invoice(x, '2026-11-01')) === null, 'the day after the lock is open');
  check(await codeOf(() => facts.recordDocument(x.w.env, { kind: 'quotation', direction: 'sell', partyId: x.customer, currency: 'ZAR', issuedOn: '2026-10-15', lines: [{ description: 'Job', quantityMilli: 1000, unit: 'job', unitPriceMinor: 100, taxBp: 1500 }] }, CTX)) === null, 'a quotation (not a financial event) can still be dated in a locked period');
  const old = x.w.db.prepare("SELECT id FROM eng_document WHERE issued_on = '2026-10-10'").get().id;
  await facts.reverse(x.w.env, { documentId: old, reason: 'duplicate' }, CTX);
  const contra = (await journal.entriesFor(x.w.env, 'document', old)).find((e) => e.reversesEntryId !== null);
  check(contra && contra.entryDate > '2026-10-31', 'reversing an invoice from a locked period is allowed, and the contra entry is dated TODAY (in the open period), so the locked books are never changed');
  const sm = await facts.receiveStock(x.w.env, { itemId: x.item, locationId: x.loc, quantityMilli: 1000, receivedOn: '2026-11-03', unitCostMinor: 100 }, CTX);
  await facts.setBooksLock(x.w.env, { lockDate: '2026-11-30' }, CTX);
  check(await codeOf(() => facts.reverseStockMove(x.w.env, { moveId: sm.moveId, reason: 'x', reversedOn: '2026-11-10' }, CTX)) === 'period_locked', 'a stock reversal DATED inside a locked period is refused, so a contra cannot be slipped into closed books');
  await facts.setBooksLock(x.w.env, { lockDate: '2026-10-31', reason: 'back to the earlier lock for this test' }, CTX);
  check(await codeOf(() => facts.setBooksLock(x.w.env, { lockDate: '2026-10-31' }, CTX)) === 'invalid_state', 'setting the lock to the date it already has is refused');
  check(await codeOf(() => facts.setBooksLock(x.w.env, { lockDate: '2026-09-30' }, CTX)) === 'invalid_input', 'moving the lock BACK without a reason is refused');
  await facts.setBooksLock(x.w.env, { lockDate: '2026-09-30', reason: 'late supplier bill to capture' }, CTX);
  check(await journal.booksLockDate(x.w.env) === '2026-09-30' && await codeOf(() => invoice(x, '2026-10-12')) === null, 'moving it back with a reason unlocks: the reason is on the event, and October is open again');
  await facts.setBooksLock(x.w.env, { lockDate: '2026-12-31' }, CTX);
  check(await journal.booksLockDate(x.w.env) === '2026-12-31', 'it can move forward again');
  check((await verifyIntegrity(x.w.env)).ok === true, 'the integrity check passes');

  // ---- manual journals --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  x = await world(); await invoice(x, '2026-10-10');
  const [rent, bank, equity] = [await codeFor(x, 'expense:rent'), await codeFor(x, 'bank'), '3000'];
  const accrual = { date: '2026-10-31', kind: 'manual', reason: 'October rent not yet billed', lines: [{ account: rent, debitMinor: 500000 }, { account: '2000', creditMinor: 500000 }] };
  check(permissions.permissionsFor(['can_manage_settings']).has('journal.post') && !permissions.permissionsFor(['can_manage_invoices', 'can_know_debtors', 'can_know_profit', 'can_make_quotes']).has('journal.post'), 'only the owner-only settings capability grants journal.post; the money roles do not');
  check(await codeOf(() => facts.postJournal(x.w.env, accrual, CTX)) === 'invalid_state', 'a journal into payables (an account the engine keeps from bills) is refused with a plain reason');
  const ok1 = { ...accrual, lines: [{ account: rent, debitMinor: 500000 }, { account: '2100', creditMinor: 0 + 500000 }] };
  check(await codeOf(() => facts.postJournal(x.w.env, ok1, CTX)) === 'invalid_state', 'so is one into VAT output');
  const prepay = { date: '2026-10-31', kind: 'manual', reason: 'depreciation of the van for October', lines: [{ account: rent, debitMinor: 150000 }, { account: equity, creditMinor: 150000 }] };
  const j = await facts.postJournal(x.w.env, prepay, CTX);
  const [je] = await journal.entriesFor(x.w.env, 'manual', j.eventId);
  check(je && je.entryDate === '2026-10-31' && je.eventId === j.eventId && je.lines.length === 2 && x.w.db.prepare('SELECT type FROM eng_event WHERE id = ?').get(j.eventId).type === 'journal.posted', 'a balanced journal writes ONE entry carried by its own journal.posted event (who, why, which lines)');
  check(JSON.parse(x.w.db.prepare('SELECT payload_json FROM eng_event WHERE id = ?').get(j.eventId).payload_json).reason === 'depreciation of the van for October', 'the reason is on the event');
  const tb = await journal.trialBalance(x.w.env);
  check(tb.totalDebitMinor === tb.totalCreditMinor, 'the trial balance still sums to zero (debits equal credits)');
  const checks = [
    ['an unbalanced journal', { ...prepay, lines: [{ account: rent, debitMinor: 100 }, { account: equity, creditMinor: 90 }] }],
    ['a journal with no reason', { ...prepay, reason: '' }],
    ['a one-line journal', { ...prepay, lines: [{ account: rent, debitMinor: 100 }] }],
    ['a line that is both a debit and a credit', { ...prepay, lines: [{ account: rent, debitMinor: 100, creditMinor: 100 }, { account: equity, creditMinor: 0 }] }],
    ['a fractional amount', { ...prepay, lines: [{ account: rent, debitMinor: 10.5 }, { account: equity, creditMinor: 10.5 }] }],
    ['a stray field', { ...prepay, extra: 1 }],
  ];
  const results = checks.map(([, v]) => capabilities.journalPost.validate(v).ok);
  check(results.every((r) => r === false) && capabilities.journalPost.validate(prepay).ok === true, 'the contract refuses an unbalanced journal, one with no reason, one line, a line that is both, a fraction and a stray field, and accepts a good one');
  check(await codeOf(() => facts.postJournal(x.w.env, { ...prepay, lines: [{ account: '9999', debitMinor: 100 }, { account: equity, creditMinor: 100 }] }, CTX)) === 'invalid_input', 'an account that is not in the chart is refused');
  await facts.setBooksLock(x.w.env, { lockDate: '2026-10-31' }, CTX);
  check(await codeOf(() => facts.postJournal(x.w.env, prepay, CTX)) === 'period_locked', 'a journal dated in a locked period is refused too');
  await facts.setBooksLock(x.w.env, { lockDate: '2026-09-30', reason: 'reopening to post a missed accrual' }, CTX);
  const rv = await facts.reverseJournal(x.w.env, { journalEventId: j.eventId, date: '2026-11-01', reason: 'posted to the wrong account' }, CTX);
  const both = await journal.entriesFor(x.w.env, 'manual', j.eventId);
  check(both.length === 2 && both[1].reversesEntryId === both[0].id && both[1].eventId === rv.eventId && both[1].lines.every((l, i) => l.debitMinor === both[0].lines[i].creditMinor && l.creditMinor === both[0].lines[i].debitMinor), 'reversing a journal adds a second entry that turns the first round; the original is untouched');
  check(await codeOf(() => facts.reverseJournal(x.w.env, { journalEventId: j.eventId, date: '2026-11-02', reason: 'again please' }, CTX)) === 'invalid_state', 'a journal can only be reversed once');
  check(await codeOf(() => facts.reverseJournal(x.w.env, { journalEventId: 999999, date: '2026-11-02', reason: 'no such one' }, CTX)) === 'not_found', 'and a journal that does not exist cannot be reversed');
  check((await verifyIntegrity(x.w.env)).ok === true, 'the integrity check passes with a reversed journal');

  // ---- opening balances -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const o = await world();
  const opening = { date: '2026-07-01', kind: 'opening', reason: 'opening balances when the business started on the engine', lines: [{ account: '1000', debitMinor: 2500000 }, { account: '1010', debitMinor: 50000 }, { account: '3000', creditMinor: 2550000 }] };
  check(capabilities.journalPost.validate(opening).ok === true, 'the opening balances validate before anything exists (a proposal can be checked on a business that has not posted yet)');
  const op = await facts.postJournal(o.w.env, opening, CTX);
  check(await bal(o, 'bank') === 2500000 && await bal(o, 'cash') === 50000 && (await journal.entriesFor(o.w.env, 'manual', op.eventId))[0].memo === 'Opening balances', 'the opening journal sets the bank and cash balances, and is labelled as the opening balances');
  check(await codeOf(() => facts.postJournal(o.w.env, opening, CTX)) === 'invalid_state', 'a second opening journal is refused while the first stands');
  check(await codeOf(() => capabilities.journalPost.check(o.w.env, opening)) === 'invalid_state', 'and the proposal is refused when it is made, not only when it is approved');
  await facts.reverseJournal(o.w.env, { journalEventId: op.eventId, date: '2026-07-02', reason: 'wrong bank balance typed in' }, CTX);
  check(await codeOf(() => facts.postJournal(o.w.env, opening, CTX)) === null && await bal(o, 'bank') === 2500000, 'after it is reversed the opening balances can be posted again');
  check(await codeOf(() => facts.postJournal(o.w.env, { ...opening, lines: [{ account: '1100', debitMinor: 100 }, { account: '3000', creditMinor: 100 }] }, CTX)) === 'invalid_state', 'opening money owed by customers cannot be journalled: it is entered as the real unpaid invoices');
  check((await verifyIntegrity(o.w.env)).ok === true, 'the integrity check passes');

  // ---- the verifier -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const v = await world(); const vj = await facts.postJournal(v.w.env, prepay, CTX);
  v.w.db.prepare("DELETE FROM eng_journal_line WHERE entry_id IN (SELECT id FROM eng_journal_entry WHERE source_kind = 'manual')").run();
  v.w.db.prepare("DELETE FROM eng_journal_entry WHERE source_kind = 'manual'").run();
  check((await verifyIntegrity(v.w.env)).problems.some((p) => p.code === 'journal_missing'), 'a journal event whose entry was removed behind the engine\'s back is reported (journal_missing)');
  const v2 = await world(); const v2j = await facts.postJournal(v2.w.env, prepay, CTX); await facts.reverseJournal(v2.w.env, { journalEventId: v2j.eventId, date: '2026-11-01', reason: 'because I said so' }, CTX);
  v2.w.db.prepare("DELETE FROM eng_journal_line WHERE entry_id IN (SELECT id FROM eng_journal_entry WHERE reverses_entry_id IS NOT NULL)").run();
  v2.w.db.prepare("DELETE FROM eng_journal_entry WHERE reverses_entry_id IS NOT NULL").run();
  check((await verifyIntegrity(v2.w.env)).problems.some((p) => p.code === 'journal_missing'), 'a reversal whose contra entry was removed is reported too');

  // ---- atomicity --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  let atomic = true, tried = 0;
  for (let n = 1; n <= 60; n++) {
    const z = await world(); await invoice(z, '2026-10-10');
    const was = JSON.stringify(z.w.counts()); z.w.failAt(n);
    let failed = false; try { await facts.postJournal(z.w.env, prepay, CTX); } catch { failed = true; }
    z.w.resetWrites(); tried += 1;
    if (failed && JSON.stringify(z.w.counts()) !== was) { atomic = false; break; }
    if (!failed) break;
  }
  check(atomic && tried > 3, 'a failure injected at every write of a journal (its event, entry and lines) leaves the business exactly as it was');
});

if (require.main === module) kit.standalone(module.exports);
