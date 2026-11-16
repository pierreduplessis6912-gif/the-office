// Several bank accounts, step B2 (docs/decisions/bank-accounts.md): a statement belongs to one account; matching and reconciliation work per account.
//   import    a statement may name its account; none named is the default; identical lines on two accounts are not duplicates of each other, the same file twice still is
//   matching  suggestions and open lines are per account; a match across accounts is refused; the verifier finds one that is not
//   reconcile each account against its own latest statement; one account's statement never answers for another
const kit = require('./engine-kit.js');

module.exports = kit.guard('engine bank accounts: statements (B2)', async ({ check }) => {
  const eng = kit.loadEngine();
  const { facts, capabilities, bank, ledgerReports, verifyIntegrity } = eng;
  const CTX = { actorEmail: 'owner@example.com', contract: 'test', contractVersion: 1 };
  const codeOf = async (fn) => { try { await fn(); return null; } catch (e) { return e && e.code ? e.code : 'threw:' + String(e && e.message).slice(0, 80); } };
  const L = (date, description, amountMinor) => ({ date, description, amountMinor });
  const world = async () => {
    const w = kit.makeWorld(); w.configure({ currency: 'ZAR' });
    await facts.setBusinessProfile(w.env, { legalName: 'Test (Pty) Ltd', address: '5 Industrial Road', vatRegistered: true, vatNumber: '4123456789' }, CTX);
    const customer = (await facts.recordParty(w.env, { kind: 'person', name: 'Mokoena', roles: ['customer'] }, CTX)).id;
    await facts.recordDocument(w.env, { kind: 'invoice', direction: 'sell', partyId: customer, currency: 'ZAR', issuedOn: '2026-10-01', lines: [{ description: 'Job', quantityMilli: 1000, unit: 'job', unitPriceMinor: 500000, taxBp: 0 }] }, CTX);
    const first = await facts.recordPayment(w.env, { direction: 'in', partyId: customer, amountMinor: 10000, currency: 'ZAR', occurredOn: '2026-11-01', method: 'eft', allocations: [] }, CTX);
    const savings = (await facts.addBankAccount(w.env, { name: 'Savings' }, CTX)).accountId;
    const card = (await facts.addBankAccount(w.env, { name: 'Credit card' }, CTX)).accountId;
    return { w, customer, savings, card, first };
  };
  const pay = (x, amount, extra = {}, on = '2026-11-02') => facts.recordPayment(x.w.env, { direction: 'in', partyId: x.customer, amountMinor: amount, currency: 'ZAR', occurredOn: on, method: 'eft', allocations: [], ...extra }, CTX);
  const bring = async (x, lines, over = {}) => {
    const total = lines.reduce((s, l) => s + l.amountMinor, 0);
    const v = capabilities.bankStatementImport.validate({ periodFrom: '2026-11-01', periodTo: '2026-11-30', openingMinor: 0, closingMinor: total, lines, ...over });
    if (!v.ok) throw new Error(v.reason);
    return facts.importStatement(x.w.env, v.value, CTX);
  };
  const lineId = (x, text, n = 0) => x.w.db.prepare('SELECT id FROM eng_bank_line WHERE description = ? ORDER BY id').all(text)[n].id;

  // ---- import ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const x = await world();
  const def = (await eng.bankAccounts.bankAccounts(x.w.env))[0].id;
  check(capabilities.bankStatementImport.validate({ bankAccountId: 'x', periodFrom: '2026-11-01', periodTo: '2026-11-30', openingMinor: 0, closingMinor: 1, lines: [L('2026-11-02', 'a', 1)] }).ok === false, 'a bank account that is not a number is refused when the statement is checked');
  check(await codeOf(() => bring(x, [L('2026-11-02', 'Deposit', 20000)], { bankAccountId: x.w.db.prepare("SELECT id FROM eng_account WHERE code = '1100'").get().id })) === 'not_found', 'a statement naming something that is not a bank account is refused');
  const sDef = await bring(x, [L('2026-11-02', 'Deposit', 10000), L('2026-11-03', 'Bank fee', -500)], { closingMinor: 9500 });
  const sSav = await bring(x, [L('2026-11-02', 'Deposit', 10000), L('2026-11-03', 'Bank fee', -500)], { closingMinor: 9500, bankAccountId: x.savings });
  check(sDef.added === 2 && sSav.added === 2 && sSav.skipped === 0, 'the same lines on another account are not duplicates of the default account\'s lines');
  check(x.w.db.prepare('SELECT bank_account_id FROM eng_bank_statement WHERE id = ?').get(sDef.statementId).bank_account_id === null && x.w.db.prepare('SELECT bank_account_id FROM eng_bank_statement WHERE id = ?').get(sSav.statementId).bank_account_id === x.savings, 'the default account\'s statement stays unnamed, the savings statement names its account');
  check(await codeOf(() => bring(x, [L('2026-11-02', 'Deposit', 10000), L('2026-11-03', 'Bank fee', -500)], { closingMinor: 9500, bankAccountId: x.savings })) === 'invalid_state', 'the same savings file twice is refused: nothing new');
  check(await codeOf(() => bring(x, [L('2026-11-02', 'Deposit', 10000), L('2026-11-03', 'Bank fee', -500)], { closingMinor: 9500, bankAccountId: def })) === 'invalid_state', 'naming the default account is the same as naming none: the same file is a duplicate');
  const ev = x.w.db.prepare("SELECT payload_json FROM eng_event WHERE type = 'bank_statement.imported' ORDER BY id").all().map((e) => JSON.parse(e.payload_json));
  check(ev[0].bankAccountId === undefined && ev[1].bankAccountId === x.savings, 'the event names the account only when it is not the default');

  // ---- matching ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const pSav = await pay(x, 10000, { bankAccountId: x.savings });
  const lines = await bank.openStatementLines(x.w.env);
  check(lines.length === 4 && lines.filter((l) => l.accountId === def).length === 2 && lines.filter((l) => l.accountId === x.savings).length === 2, 'the open lines carry the account of their statement');
  const entriesSav = await bank.openBankEntries(x.w.env, x.savings), entriesDef = await bank.openBankEntries(x.w.env, def);
  check(entriesSav.length === 1 && entriesSav[0].amountMinor === 10000 && entriesDef.length === 1 && entriesDef[0].amountMinor === 10000, 'each account has its own open entry');
  const sugSav = await bank.suggestMatches(x.w.env, x.savings), sugDef = await bank.suggestMatches(x.w.env);
  const sMatch = [...sugSav.strong, ...sugSav.weak][0];
  check(sMatch && sMatch.bankLineId === lineId(x, 'Deposit', 1) && sMatch.journalLineIds.length === 1 && sMatch.journalLineIds[0] === entriesSav[0].journalLineId, 'the savings deposit is suggested against the savings payment only');
  const dMatch = [...sugDef.strong, ...sugDef.weak][0];
  check(dMatch && dMatch.bankLineId === lineId(x, 'Deposit', 0) && dMatch.journalLineIds[0] === entriesDef[0].journalLineId, 'and the default deposit against the default payment');
  check(sugDef.unexplained.includes(lineId(x, 'Bank fee', 0)) && !sugDef.unexplained.includes(lineId(x, 'Bank fee', 1)), 'the suggestions of one account do not list the other account\'s lines');
  check(await codeOf(() => facts.confirmMatches(x.w.env, { matches: [{ bankLineId: lineId(x, 'Deposit', 1), journalLineIds: [entriesDef[0].journalLineId] }] }, CTX)) === 'invalid_state', 'a savings line cannot be matched to a default-account entry, even for the same amount');
  const before = x.w.count('eng_bank_match');
  check(before === 0, 'and nothing was written by the refusal');
  await facts.confirmMatches(x.w.env, { matches: [{ bankLineId: lineId(x, 'Deposit', 1), journalLineIds: [entriesSav[0].journalLineId] }, { bankLineId: lineId(x, 'Deposit', 0), journalLineIds: [entriesDef[0].journalLineId] }] }, CTX);
  check(x.w.count('eng_bank_match') === 2 && (await bank.openStatementLines(x.w.env, x.savings)).length === 1 && (await bank.openBankEntries(x.w.env, x.savings)).length === 0, 'matching in each account works and leaves only the fee open in savings');
  check((await verifyIntegrity(x.w.env)).ok === true, 'the verifier is content');

  // ---- reconciliation per account ----------------------------------------------------------------------------------------------------------------------------------------------------------
  const rDef = await ledgerReports.bankReconciliation(x.w.env, null), rSav = await ledgerReports.bankReconciliation(x.w.env, null, x.savings), rCard = await ledgerReports.bankReconciliation(x.w.env, null, x.card);
  check(rDef.statement && rDef.statement.id === sDef.statementId && rSav.statement && rSav.statement.id === sSav.statementId, 'each account is reconciled against its own statement');
  check(rDef.ledgerMinor === 10000 && rSav.ledgerMinor === 10000, 'and its own ledger balance (R100 in each)');
  check(rDef.unmatchedLines.length === 1 && rDef.unmatchedLines[0].amountMinor === -500 && rSav.unmatchedLines.length === 1, 'each shows its own unmatched fee');
  check(rCard.statement === null && rCard.reconciled === false, 'an account with no statement says so, and is not called reconciled');
  check(await codeOf(() => ledgerReports.bankReconciliation(x.w.env, null, 9999)) === 'not_found', 'an account that is not a bank account is refused');
  const solo = await world(); await bring(solo, [L('2026-11-02', 'Deposit', 10000)], { bankAccountId: solo.savings });
  const rSolo = await ledgerReports.bankReconciliation(solo.w.env, null);
  check(rSolo.statement === null, 'a statement for savings does not answer for the default account');

  // ---- the verifier --------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const y = await world();
  await bring(y, [L('2026-11-02', 'Deposit', 10000)], { bankAccountId: y.savings });
  const py = await pay(y, 10000, { bankAccountId: y.savings });
  const eY = (await bank.openBankEntries(y.w.env, y.savings))[0];
  await facts.confirmMatches(y.w.env, { matches: [{ bankLineId: lineId(y, 'Deposit'), journalLineIds: [eY.journalLineId] }] }, CTX);
  y.w.db.prepare('UPDATE eng_bank_statement SET bank_account_id = NULL').run();
  const bad = await verifyIntegrity(y.w.env);
  check(bad.ok === false && JSON.stringify(bad).includes('joins a statement line to an entry on a different bank account'), 'a match between a statement and an entry on another account is found');
});
if (require.main === module) kit.standalone(module.exports);
