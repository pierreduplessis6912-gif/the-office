// A refund of an overpayment may name the bank account the money is paid back from (docs/decisions/bank-accounts.md; create-from-screen.md, the refund form). None named is the default; cash and an account that is
// not a bank account are refused; the entry credits the named account only; the refund appears on that account's reconciliation side; the trial balance still balances.
const kit = require('./engine-kit.js');

module.exports = kit.guard('engine refund from a named bank account', async ({ check }) => {
  const eng = kit.loadEngine();
  const { facts, capabilities, verifyIntegrity } = eng;
  const CTX = { actorEmail: 'owner@example.com', contract: 'test', contractVersion: 1 };
  const codeOf = async (fn) => { try { await fn(); return null; } catch (e) { return e && e.code ? e.code : 'threw:' + String(e && e.message).slice(0, 80); } };
  const w = kit.makeWorld(); w.configure({ currency: 'ZAR' });
  await facts.setBusinessProfile(w.env, { legalName: 'Test (Pty) Ltd', address: '5 Industrial Road', vatRegistered: true, vatNumber: '4123456789' }, CTX);
  const customer = (await facts.recordParty(w.env, { kind: 'person', name: 'Mokoena', roles: ['customer'] }, CTX)).id;
  const savings = (await facts.addBankAccount(w.env, { name: 'Savings' }, CTX)).accountId;
  const accountOf = (movementId) => w.db.prepare("SELECT l.account_id AS a, l.debit_minor AS d, l.credit_minor AS c FROM eng_journal_line l JOIN eng_journal_entry e ON e.id = l.entry_id WHERE e.source_kind = 'movement' AND e.source_id = ? AND e.reverses_entry_id IS NULL ORDER BY l.id").all(movementId).map((r) => ({ a: Number(r.a), d: Number(r.d), c: Number(r.c) }));
  const paid = async (extra = {}) => (await facts.recordPayment(w.env, { direction: 'in', partyId: customer, amountMinor: 50000, currency: 'ZAR', occurredOn: '2026-11-02', method: 'eft', allocations: [], ...extra }, CTX)).movementId;
  const refund = (paymentId, extra = {}) => facts.refundPayment(w.env, { paymentId, amountMinor: 10000, refundedOn: '2026-11-10', method: 'eft', ...extra }, CTX);

  const p1 = await paid({ bankAccountId: savings });
  const def = (await eng.bankAccounts.bankAccounts(w.env)).find((a) => a.isDefault).id;
  const r1 = await refund(p1, { bankAccountId: savings });
  const l1 = accountOf(r1.movementId);
  check(l1.some((l) => l.a === savings && l.c === 10000) && !l1.some((l) => l.a === def), `a refund naming Savings credits Savings and not the default account (${JSON.stringify(l1)})`);
  const mv = w.db.prepare('SELECT bank_account_id AS b FROM eng_money_movement WHERE id = ?').get(r1.movementId);
  check(Number(mv.b) === savings, 'the refund movement records the account it was paid from');

  const r2 = await refund(p1);
  const l2 = accountOf(r2.movementId);
  check(l2.some((l) => l.a === def && l.c === 10000) && !l2.some((l) => l.a === savings) && w.db.prepare('SELECT bank_account_id AS b FROM eng_money_movement WHERE id = ?').get(r2.movementId).b === null, 'a refund naming no account credits the default account and stores none');

  check(await codeOf(() => refund(p1, { method: 'cash', bankAccountId: savings })) === 'invalid_input', 'cash naming a bank account is refused');
  check(await codeOf(() => refund(p1, { bankAccountId: 9999 })) === 'not_found', 'an account that is not one of the business\'s bank accounts is refused');
  const receivable = w.db.prepare("SELECT id FROM eng_account WHERE code = '1100' OR name LIKE '%eceivable%' LIMIT 1").get();
  if (receivable) check(await codeOf(() => refund(p1, { bankAccountId: Number(receivable.id) })) === 'not_found', 'an account that is not a bank account (receivables) is refused');

  const balance = (accountId) => Number(w.db.prepare('SELECT COALESCE(SUM(debit_minor - credit_minor), 0) AS b FROM eng_journal_line WHERE account_id = ?').get(accountId).b);
  check(balance(savings) === 40000 && balance(def) === -10000, `each account carries its own money in and out: Savings 50000 in less 10000 back, the default only the 10000 back (${balance(savings)}, ${balance(def)})`);
  const listed = await capabilities.READS.find((q) => q.id === 'ledger.bank_accounts').run(w.env, { caps: ['ledger.read'] }, {});
  const bal = (id) => ((listed.accounts || []).find((x) => x.id === id) || {}).balanceMinor;
  check(bal(savings) === 40000 && bal(def) === -10000, `the bank accounts list shows the same balances (${bal(savings)}, ${bal(def)})`);
  const tb = w.db.prepare('SELECT COALESCE(SUM(debit_minor), 0) AS d, COALESCE(SUM(credit_minor), 0) AS c FROM eng_journal_line').get();
  check(Number(tb.d) === Number(tb.c), 'the books still balance after refunds from two accounts');
  const v = await verifyIntegrity(w.env);
  check(v.ok === true, `the verifier is content (${JSON.stringify(v.problems || []).slice(0, 160)})`);

  // ---- a credit note's refund: a paid invoice credited leaves unapplied credit to pay back ------------------------------------------------------------------------------------------------
  const inv = await facts.recordDocument(w.env, { kind: 'invoice', direction: 'sell', partyId: customer, currency: 'ZAR', issuedOn: '2026-10-01', lines: [{ description: 'Floor', quantityMilli: 1000, unit: 'job', unitPriceMinor: 100000, taxBp: 1500 }] }, CTX);
  await facts.recordPayment(w.env, { direction: 'in', partyId: customer, amountMinor: 115000, currency: 'ZAR', occurredOn: '2026-10-05', method: 'eft', allocations: [{ documentId: inv.id, amountMinor: 115000 }] }, CTX);
  const cn = await facts.issueCreditNote(w.env, { invoiceId: inv.id, reason: 'Damaged', issuedOn: '2026-11-10', lines: [{ invoiceLineNo: 1, quantityMilli: 400, unitPriceMinor: 100000 }] }, CTX);
  check(cn.unappliedMinor === 46000, `the credit note on a paid invoice leaves its whole amount to pay back (${cn.unappliedMinor})`);
  const cr = (extra = {}) => facts.refundCredit(w.env, { creditNoteId: cn.documentId, amountMinor: 10000, refundedOn: '2026-11-12', method: 'eft', ...extra }, CTX);
  const before2 = balance(savings);
  const k1 = await cr({ bankAccountId: savings });
  const lk = accountOf(k1.movementId);
  check(lk.some((l) => l.a === savings && l.c === 10000) && balance(savings) === before2 - 10000 && Number(w.db.prepare('SELECT bank_account_id AS b FROM eng_money_movement WHERE id = ?').get(k1.movementId).b) === savings, `a credit refund naming Savings credits Savings and stores it (${JSON.stringify(lk)})`);
  const k2 = await cr();
  check(accountOf(k2.movementId).some((l) => l.a === def && l.c === 10000) && w.db.prepare('SELECT bank_account_id AS b FROM eng_money_movement WHERE id = ?').get(k2.movementId).b === null, 'a credit refund naming no account credits the default and stores none');
  check(await codeOf(() => cr({ method: 'cash', bankAccountId: savings })) === 'invalid_input', 'a credit refund in cash naming a bank account is refused');
  check(await codeOf(() => cr({ bankAccountId: 9999 })) === 'not_found', 'a credit refund naming an account that is not a bank account is refused');
  const v2 = await verifyIntegrity(w.env);
  check(v2.ok === true, `the verifier is still content (${JSON.stringify(v2.problems || []).slice(0, 160)})`);
  const rc = capabilities.ENGINE_CONTRACTS.find((k) => k.id === 'refund.record');
  check(rc.validate({ creditNoteId: 1, amountMinor: 100, refundedOn: '2026-11-10', method: 'eft', bankAccountId: 2 }).ok === true && rc.validate({ creditNoteId: 1, amountMinor: 100, refundedOn: '2026-11-10', method: 'eft', bankAccountId: 'x' }).ok === false, 'the credit refund contract takes a bank account that is a record number and refuses anything else');

  const c = capabilities.ENGINE_CONTRACTS.find((k) => k.id === 'payment.refund');
  check(c.validate({ paymentId: 1, amountMinor: 100, refundedOn: '2026-11-10', method: 'eft', bankAccountId: 2 }).ok === true && c.validate({ paymentId: 1, amountMinor: 100, refundedOn: '2026-11-10', method: 'eft', bankAccountId: 'x' }).ok === false, 'the contract takes a bank account that is a record number and refuses anything else');
});
if (require.main === module) kit.standalone(module.exports);
