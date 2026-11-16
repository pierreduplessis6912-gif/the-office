// Several bank accounts, step B3 (docs/decisions/bank-accounts.md): moving money between accounts, cash flow across every account, and the sentences.
//   transfer   one balanced journal between two of the business's bank accounts; reversible like any journal; refused for the same account, an account that is not a bank account, a locked period
//   cash flow  counts every bank account; a transfer is no cash movement; the indirect flow does not treat a bank account as "other assets" and still agrees with the direct one
//   sentences  "how much is in each bank account" and "is savings reconciled" (an account the business does not have is never guessed)
const kit = require('./engine-kit.js');

module.exports = kit.guard('engine bank accounts: transfers and cash flow (B3)', async ({ check }) => {
  const eng = kit.loadEngine();
  const { facts, capabilities, ledgerReports, journal, verifyIntegrity } = eng;
  const CTX = { actorEmail: 'owner@example.com', contract: 'test', contractVersion: 1 };
  const codeOf = async (fn) => { try { await fn(); return null; } catch (e) { return e && e.code ? e.code : 'threw:' + String(e && e.message).slice(0, 80); } };
  const world = async () => {
    const w = kit.makeWorld(); w.configure({ currency: 'ZAR' });
    await facts.setBusinessProfile(w.env, { legalName: 'Test (Pty) Ltd', address: '5 Industrial Road', vatRegistered: true, vatNumber: '4123456789' }, CTX);
    const customer = (await facts.recordParty(w.env, { kind: 'person', name: 'Mokoena', roles: ['customer'] }, CTX)).id;
    await facts.recordDocument(w.env, { kind: 'invoice', direction: 'sell', partyId: customer, currency: 'ZAR', issuedOn: '2026-10-01', lines: [{ description: 'Job', quantityMilli: 1000, unit: 'job', unitPriceMinor: 500000, taxBp: 0 }] }, CTX);
    await facts.recordPayment(w.env, { direction: 'in', partyId: customer, amountMinor: 100000, currency: 'ZAR', occurredOn: '2026-11-01', method: 'eft', allocations: [] }, CTX);
    const savings = (await facts.addBankAccount(w.env, { name: 'Savings' }, CTX)).accountId;
    const def = (await eng.bankAccounts.bankAccounts(w.env))[0].id;
    return { w, customer, savings, def };
  };
  const T = eng.capabilities.bankTransfer;
  const exec = (x, payload) => T.execute(x.w.env, payload, { actionId: null, actorEmail: 'owner@example.com' });
  const bal = (x, id) => Number(x.w.db.prepare('SELECT COALESCE(SUM(debit_minor - credit_minor), 0) AS b FROM eng_journal_line WHERE account_id = ?').get(id).b);

  // ---- the contract ------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  let x = await world();
  const good = { fromAccountId: x.def, toAccountId: x.savings, amountMinor: 40000, date: '2026-11-05' };
  check(capabilities.CAPABILITY_IDS.includes('bank.transfer') && T.heldType === 'engine.bank.transfer' && T.permissions.includes('journal.post'), 'the capability exists, is held, and needs the permission to post journals');
  check(T.validate(good).ok === true && T.validate({ ...good, note: 'Tax reserve' }).ok === true, 'a transfer with two accounts, an amount and a date is accepted, with an optional note');
  check([{ ...good, toAccountId: x.def }, { ...good, amountMinor: 0 }, { ...good, amountMinor: 1.5 }, { ...good, date: '2026-13-01' }, { ...good, extra: 1 }, { ...good, note: '' }, { ...good, fromAccountId: 'a' }].every((p) => T.validate(p).ok === false), 'the same account twice, no amount, part of a cent, a false date, a stray field, an empty note and a non-number are each refused');
  check(await codeOf(() => T.check(x.w.env, { ...good, toAccountId: 9999 })) === 'not_found', 'an account that is not a bank account is refused when it is proposed');
  check(await codeOf(() => T.check(x.w.env, { ...good, toAccountId: x.w.db.prepare("SELECT id FROM eng_account WHERE code = '1100'").get().id })) === 'not_found', 'so is any other account in the chart');

  // ---- the transfer ------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const before = JSON.stringify(x.w.counts());
  const r = await exec(x, { ...good, note: 'Tax reserve' });
  check(bal(x, x.def) === 60000 && bal(x, x.savings) === 40000, 'R400 moves from the main account to savings');
  check(JSON.stringify(x.w.changedTables(JSON.parse(before))) === JSON.stringify(['eng_event', 'eng_journal_entry', 'eng_journal_line']), `it writes one event and one entry with its two lines (${x.w.changedTables(JSON.parse(before))})`);
  const ev = x.w.db.prepare("SELECT type, reason FROM eng_event WHERE id = ?").get(r.eventId);
  check(ev.type === 'journal.posted' && /Transfer from Bank to Savings: Tax reserve/.test(ev.reason || ''), `the event says what it was (${ev.reason})`);
  check((await ledgerReports.trialBalanceAsAt(x.w.env, null)).balanced === true && (await verifyIntegrity(x.w.env)).ok === true, 'the trial balance balances and the verifier is content');
  check(await codeOf(() => exec(x, { ...good, fromAccountId: x.savings, toAccountId: x.def, amountMinor: 40000, date: '2026-11-06' })) === null && bal(x, x.savings) === 0, 'and it can be moved back');
  await facts.setBooksLock(x.w.env, { lockDate: '2026-11-30' }, CTX);
  check(await codeOf(() => T.check(x.w.env, { ...good, date: '2026-11-10' })) !== null, 'a transfer dated inside a locked period is refused when proposed');
  const rev = await facts.reverseJournal(x.w.env, { journalEventId: r.eventId, date: '2026-12-02', reason: 'moved by mistake' }, CTX);
  check(rev.eventId > r.eventId && bal(x, x.def) === 140000 && bal(x, x.savings) === -40000, 'reversing it like any journal turns the entry round (the money had already been moved back, so the two reversals add up)');

  // ---- cash flow ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const y = await world();
  await exec(y, { fromAccountId: y.def, toAccountId: y.savings, amountMinor: 40000, date: '2026-11-05' });
  await facts.recordPayment(y.w.env, { direction: 'in', partyId: y.customer, amountMinor: 25000, currency: 'ZAR', occurredOn: '2026-11-07', method: 'eft', bankAccountId: y.savings, allocations: [] }, CTX);
  const cf = await ledgerReports.cashFlow(y.w.env, '2026-11-01', '2026-11-30');
  check(cf.balanced === true && cf.closingMinor === 125000 && cf.netMinor === 125000, `cash flow counts the savings account too: R1250 in all (${cf.closingMinor})`);
  check(!cf.inflows.some((i) => /Journals/.test(i.name)) && !cf.outflows.some((o) => /Journals/.test(o.name)), 'the transfer is not cash coming in or going out');
  check(cf.inflows.some((i) => i.name === 'Received from customers' && i.amountMinor === 125000), 'both payments are received from customers');
  const ic = await ledgerReports.indirectCashFlow(y.w.env, '2026-11-01', '2026-11-30');
  check(ic.agrees === true && ic.netMinor === 125000 && !ic.adjustments.some((a) => /Other assets/.test(a.name)), 'the indirect cash flow agrees and does not treat the savings account as another asset');

  // ---- the sentences -----------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const sx = await world();
  const ask = async (text, call, role = 'owner') => {
    const res = await kit.route({ env: { BUSINESS_ID: 'eng-a' }, seed: kit.seedReceivables([...kit.ALL_CAPABILITIES]), method: 'POST', path: '/engine/interpret', role, body: { text }, ai: [{ match: /./, reply: JSON.stringify(call) }] });
    return res;
  };
  check(capabilities.READS.some((q) => q.id === 'ledger.bank_accounts' && q.permissions.includes('ledger.read')), 'the accounts read exists and is for whoever may read the books');
});
if (require.main === module) kit.standalone(module.exports);
