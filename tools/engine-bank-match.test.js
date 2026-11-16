// Bank matching, increment G5b (docs/decisions/bank-reconciliation.md): a statement line is matched to what the books say went through the bank account.
//   suggest   strong (one fit, the party's name is in the description), weak (one fit, no name), ambiguous (several, or two lines want one entry), unexplained (nothing fits)
//   confirm   only what a person approves; checked against the facts as they are: the entries are on the bank account, unmatched, and add up to the line; a lump sum is several entries
//   undo      a second fact pointing at the first, a reason needed; the line is open again and can be matched again
//   guards    nothing is written to the ledger; the verifier finds a double match; owner-only
const kit = require('./engine-kit.js');

module.exports = kit.guard('engine bank matching (G5b)', async ({ check }) => {
  const eng = kit.loadEngine();
  const { facts, capabilities, bank, journal, verifyIntegrity } = eng;
  const CTX = { actorEmail: 'owner@example.com', contract: 'test', contractVersion: 1 };
  const codeOf = async (fn) => { try { await fn(); return null; } catch (e) { return e && e.code ? e.code : 'threw:' + String(e && e.message).slice(0, 80); } };
  const L = (date, description, amountMinor) => ({ date, description, amountMinor });
  const world = async () => {
    const w = kit.makeWorld(); w.configure({ currency: 'ZAR' });
    await facts.setBusinessProfile(w.env, { legalName: 'Test (Pty) Ltd', address: '5 Industrial Road', vatRegistered: true, vatNumber: '4123456789' }, CTX);
    const customer = (await facts.recordParty(w.env, { kind: 'person', name: 'Mokoena', roles: ['customer'] }, CTX)).id;
    const supplier = (await facts.recordParty(w.env, { kind: 'organisation', name: 'Timber Supplies', roles: ['supplier'], contact: { vatNumber: '4222222222' } }, CTX)).id;
    return { w, customer, supplier };
  };
  const payIn = (x, amount, on = '2026-11-02') => facts.recordPayment(x.w.env, { direction: 'in', partyId: x.customer, amountMinor: amount, currency: 'ZAR', occurredOn: on, method: 'eft', allocations: [] }, CTX);
  const payOut = (x, amount, on = '2026-11-10') => facts.recordPayment(x.w.env, { direction: 'out', partyId: x.supplier, amountMinor: amount, currency: 'ZAR', occurredOn: on, method: 'eft', allocations: [] }, CTX);
  const feeJournal = async (x, amount, on = '2026-11-03') => {
    const bankCode = (await journal.accountForRole(x.w.env, 'bank')).code, fees = '6001';
    return facts.postJournal(x.w.env, { date: on, kind: 'manual', reason: 'monthly bank fee', lines: [{ account: fees, debitMinor: amount }, { account: bankCode, creditMinor: amount }] }, CTX);
  };
  const bring = async (x, lines, over = {}) => {
    const total = lines.reduce((s, l) => s + l.amountMinor, 0);
    const v = capabilities.bankStatementImport.validate({ periodFrom: '2026-11-01', periodTo: '2026-11-30', openingMinor: 0, closingMinor: total, lines, ...over });
    if (!v.ok) throw new Error(v.reason);
    return facts.importStatement(x.w.env, v.value, CTX);
  };
  const lineId = (x, text) => x.w.db.prepare('SELECT id FROM eng_bank_line WHERE description = ?').get(text).id;
  const entryOf = async (x, amount) => (await bank.openBankEntries(x.w.env)).find((e) => e.amountMinor === amount).journalLineId;

  // ---- suggestions -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  let x = await world();
  await payIn(x, 250000); await payOut(x, 90000); await feeJournal(x, 1500);
  await bring(x, [L('2026-11-02', 'EFT Mokoena INV-12', 250000), L('2026-11-03', 'Bank fee', -1500), L('2026-11-10', 'EFT Timber Supplies', -90000), L('2026-11-12', 'Mystery deposit', 30000)]);
  const entriesBefore = x.w.count('eng_journal_entry');
  const sg = await bank.suggestMatches(x.w.env);
  check(sg.strong.length === 2 && sg.weak.length === 1 && sg.ambiguous.length === 0 && sg.unexplained.length === 1, 'a payment in and a payment out whose party names are in the description are STRONG; the bank fee (no party) is WEAK; the mystery deposit is UNEXPLAINED');
  check(sg.strong.some((m) => m.bankLineId === lineId(x, 'EFT Mokoena INV-12') && m.journalLineIds.length === 1) && sg.unexplained[0] === lineId(x, 'Mystery deposit'), 'and each names the right line');
  check(JSON.stringify(sg).length > 0 && x.w.count('eng_bank_match') === 0, 'a suggestion is only a suggestion: nothing is matched until a person approves');
  check(capabilities.ledgerBankSuggestions.validate({}).ok === true && capabilities.ledgerBankSuggestions.permissions[0] === 'ledger.read', 'the suggestions are a read, for whoever may read the books');

  // ---- confirm -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const inLine = lineId(x, 'EFT Mokoena INV-12'), inEntry = await entryOf(x, 250000), outLine = lineId(x, 'EFT Timber Supplies'), outEntry = await entryOf(x, -90000), feeLine = lineId(x, 'Bank fee'), feeEntry = await entryOf(x, -1500);
  const okInput = capabilities.bankMatchConfirm.validate({ matches: [{ bankLineId: inLine, journalLineIds: [inEntry] }, { bankLineId: outLine, journalLineIds: [outEntry] }] });
  check(okInput.ok === true, 'a batch of matches validates');
  await capabilities.bankMatchConfirm.check(x.w.env, okInput.value);
  const rc = await facts.confirmMatches(x.w.env, okInput.value, CTX);
  const ev = x.w.db.prepare('SELECT type, actor_email FROM eng_event WHERE id = ?').get(rc.eventId);
  check(rc.matched === 2 && x.w.count('eng_bank_match') === 2 && ev.type === 'bank_match.confirmed' && ev.actor_email === 'owner@example.com', 'confirming is one event and a match row for each entry, with who approved it');
  check(x.w.count('eng_journal_entry') === entriesBefore, 'matching writes nothing to the ledger');
  check((await bank.suggestMatches(x.w.env)).strong.length === 0 && (await bank.openStatementLines(x.w.env)).length === 2 && (await bank.openBankEntries(x.w.env)).length === 1, 'matched lines and entries drop out of what is still open');
  check((await verifyIntegrity(x.w.env)).ok === true, 'the integrity verifier is content');

  // ---- refusals ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const before = JSON.stringify(x.w.counts());
  const refusal = [
    await codeOf(() => facts.confirmMatches(x.w.env, okInput.value, CTX)),                                                                 // already matched
    await codeOf(() => facts.confirmMatches(x.w.env, { matches: [{ bankLineId: feeLine, journalLineIds: [inEntry] }] }, CTX)),             // entry already matched
    await codeOf(() => facts.confirmMatches(x.w.env, { matches: [{ bankLineId: lineId(x, 'Mystery deposit'), journalLineIds: [feeEntry] }] }, CTX)), // does not add up
    await codeOf(() => facts.confirmMatches(x.w.env, { matches: [{ bankLineId: 99999, journalLineIds: [feeEntry] }] }, CTX)),              // no such line
    await codeOf(() => facts.confirmMatches(x.w.env, { matches: [{ bankLineId: feeLine, journalLineIds: [99999] }] }, CTX)),               // no such entry
  ];
  const nonBank = x.w.db.prepare("SELECT jl.id FROM eng_journal_line jl WHERE jl.account_id <> (SELECT account_id FROM eng_account_role WHERE role = 'bank' ORDER BY id DESC LIMIT 1) LIMIT 1").get().id;
  refusal.push(await codeOf(() => facts.confirmMatches(x.w.env, { matches: [{ bankLineId: feeLine, journalLineIds: [nonBank] }] }, CTX)));  // not the bank account
  check(refusal.join() === 'invalid_state,invalid_state,invalid_input,invalid_state,invalid_state,invalid_state' && JSON.stringify(x.w.counts()) === before, 'a line or entry already matched, entries that do not add up to the line, a line or entry that does not exist, and an entry on another account are all refused, writing nothing');
  const bad = [capabilities.bankMatchConfirm.validate({ matches: [] }), capabilities.bankMatchConfirm.validate({ matches: [{ bankLineId: 1, journalLineIds: [] }] }), capabilities.bankMatchConfirm.validate({ matches: [{ bankLineId: 1, journalLineIds: [2] }, { bankLineId: 1, journalLineIds: [3] }] }), capabilities.bankMatchConfirm.validate({ matches: [{ bankLineId: 1, journalLineIds: [2] }, { bankLineId: 3, journalLineIds: [2] }] }), capabilities.bankMatchConfirm.validate({ matches: [{ bankLineId: 1.5, journalLineIds: [2] }] }), capabilities.bankMatchConfirm.validate({ matches: [{ bankLineId: 1, journalLineIds: [2], extra: 1 }] }), capabilities.bankMatchConfirm.validate({ matches: [{ bankLineId: 1, journalLineIds: [2] }], x: 1 })];
  check(bad.every((v) => v.ok === false), 'the contract refuses: no matches, no entries, one line twice, one entry twice, a fraction for an id, a stray field in a match and a stray field in the request');

  // ---- weak: confirmed by a person, then undone ----------------------------------------------------------------------------------------------------------------------------------------------------
  await facts.confirmMatches(x.w.env, { matches: [{ bankLineId: feeLine, journalLineIds: [feeEntry] }] }, CTX);
  check(await codeOf(() => capabilities.bankMatchUndo.check(x.w.env, { bankLineId: lineId(x, 'Mystery deposit'), reason: 'nothing there' })) === 'invalid_state', 'a line that is not matched cannot be unmatched');
  check(capabilities.bankMatchUndo.validate({ bankLineId: feeLine, reason: 'no' }).ok === false && capabilities.bankMatchUndo.validate({ bankLineId: feeLine, reason: 'wrong one, matched in error' }).ok === true, 'undoing needs a reason of at least five characters');
  const ru = await facts.undoMatch(x.w.env, { bankLineId: feeLine, reason: 'matched the wrong fee' }, CTX);
  const rev = x.w.db.prepare('SELECT * FROM eng_bank_match WHERE reverses_match_id IS NOT NULL').all();
  check(x.w.db.prepare('SELECT type, reason FROM eng_event WHERE id = ?').get(ru.eventId).type === 'bank_match.undone' && rev.length === 1 && x.w.count('eng_bank_match') === 4, 'unmatching is an event and a reversal row pointing at the original: nothing is deleted, the history stays');
  check((await bank.suggestMatches(x.w.env)).weak.length === 1 && (await verifyIntegrity(x.w.env)).ok === true, 'the line is open again, suggested again, and the verifier is content');
  await facts.confirmMatches(x.w.env, { matches: [{ bankLineId: feeLine, journalLineIds: [feeEntry] }] }, CTX);
  check((await bank.openBankEntries(x.w.env)).length === 0 && (await verifyIntegrity(x.w.env)).ok === true, 'and the same entry can be matched again after it was unmatched');

  // ---- a lump sum, ambiguity -----------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const y = await world();
  await payIn(y, 100000, '2026-11-15'); await payIn(y, 50000, '2026-11-15');
  await bring(y, [L('2026-11-15', 'EFT Mokoena lump sum', 150000)]);
  const sy = await bank.suggestMatches(y.w.env);
  check(sy.unexplained.length === 1 && sy.strong.length === 0, 'a lump sum paying two payments has no single fit, so it is not guessed');
  const both = (await bank.openBankEntries(y.w.env)).map((e) => e.journalLineId);
  check(await codeOf(() => facts.confirmMatches(y.w.env, { matches: [{ bankLineId: lineId(y, 'EFT Mokoena lump sum'), journalLineIds: [both[0]] }] }, CTX)) === 'invalid_input', 'one of the two does not add up to the line');
  await facts.confirmMatches(y.w.env, { matches: [{ bankLineId: lineId(y, 'EFT Mokoena lump sum'), journalLineIds: both }] }, CTX);
  check(y.w.count('eng_bank_match') === 2 && (await verifyIntegrity(y.w.env)).ok === true && (await facts.undoMatch(y.w.env, { bankLineId: lineId(y, 'EFT Mokoena lump sum'), reason: 'lump sum was something else' }, CTX)).eventId > 0 && (await bank.openBankEntries(y.w.env)).length === 2, 'a person can match the lump sum to both, and unmatching releases both entries together');
  const z = await world();
  await payIn(z, 40000, '2026-11-04'); await payIn(z, 40000, '2026-11-05');
  await bring(z, [L('2026-11-04', 'EFT Mokoena', 40000)]);
  check((await bank.suggestMatches(z.w.env)).ambiguous.length === 1, 'two payments of the same amount in the window make the line ambiguous: asked, never assumed');
  const z2 = await world();
  await payIn(z2, 40000, '2026-11-04');
  await bring(z2, [L('2026-11-04', 'EFT Mokoena', 40000), L('2026-11-05', 'EFT Mokoena again', 40000)]);
  check((await bank.suggestMatches(z2.w.env)).ambiguous.length === 2, 'two lines wanting the same entry are both ambiguous');
  const far = await world();
  await payIn(far, 40000, '2026-11-01');
  await bring(far, [L('2026-11-20', 'EFT Mokoena', 40000)]);
  check((await bank.suggestMatches(far.w.env)).unexplained.length === 1, 'an entry weeks away from the line is not a fit');

  // ---- who may and what the verifier finds ---------------------------------------------------------------------------------------------------------------------------------------------------
  check(capabilities.bankMatchConfirm.permissions.join() === 'business.manage' && capabilities.bankMatchUndo.permissions.join() === 'business.manage' && capabilities.bankMatchConfirm.heldType === 'engine.bank_match.confirm', 'matching and unmatching need the permission to manage the business');
  const t = await world(); await payIn(t, 1000);
  await bring(t, [L('2026-11-02', 'EFT Mokoena', 1000), L('2026-11-03', 'EFT Mokoena two', 1000)]);
  const tl = lineId(t, 'EFT Mokoena'), te = await entryOf(t, 1000);
  await facts.confirmMatches(t.w.env, { matches: [{ bankLineId: tl, journalLineIds: [te] }] }, CTX);
  t.w.db.prepare('INSERT INTO eng_bank_match (bank_line_id, journal_line_id, reverses_match_id, event_id) SELECT ?, journal_line_id, NULL, event_id FROM eng_bank_match LIMIT 1').run(lineId(t, 'EFT Mokoena two'));
  const rep = await verifyIntegrity(t.w.env);
  check(rep.ok === false && rep.problems.some((p) => p.code === 'bank_match_inconsistent'), 'an entry matched twice at once is found by the verifier');
  const t2 = await world(); await payIn(t2, 1000); await payIn(t2, 2500, '2026-11-03');
  await bring(t2, [L('2026-11-02', 'EFT Mokoena', 1000)]);
  await facts.confirmMatches(t2.w.env, { matches: [{ bankLineId: lineId(t2, 'EFT Mokoena'), journalLineIds: [await entryOf(t2, 1000)] }] }, CTX);
  t2.w.db.prepare("UPDATE eng_bank_match SET journal_line_id = (SELECT jl.id FROM eng_journal_line jl WHERE jl.debit_minor = 2500)").run();
  check((await verifyIntegrity(t2.w.env)).problems.some((p) => p.code === 'bank_match_inconsistent'), 'and so is a match whose entries no longer add up to the bank line');
});

if (require.main === module) kit.standalone(module.exports);
