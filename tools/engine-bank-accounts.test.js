// Several bank accounts, step B1 (docs/decisions/bank-accounts.md): adding an account, and payments that name the account they went through.
//   add       an ordinary asset account in the chart, code picked by the engine from 1020, listed after the default, once per name; held and approved like everything else
//   payments  a customer payment, a supplier payment and an expense may name a bank account; none named is the default; cash and an account that is not a bank account are refused
//   books     the entry lands on the named account only; reversing or correcting a payment keeps it there; the trial balance still balances
//   verifier  finds a payment whose entry went to another account, and an account that is not a bank account
const kit = require('./engine-kit.js');

module.exports = kit.guard('engine bank accounts (B1)', async ({ check }) => {
  const eng = kit.loadEngine();
  const { facts, capabilities, journal, ledgerReports, verifyIntegrity } = eng;
  const bankAccounts = (env) => eng.bankAccounts.bankAccounts(env);
  const CTX = { actorEmail: 'owner@example.com', contract: 'test', contractVersion: 1 };
  const codeOf = async (fn) => { try { await fn(); return null; } catch (e) { return e && e.code ? e.code : 'threw:' + String(e && e.message).slice(0, 80); } };
  const world = async () => {
    const w = kit.makeWorld(); w.configure({ currency: 'ZAR' });
    await facts.setBusinessProfile(w.env, { legalName: 'Test (Pty) Ltd', address: '5 Industrial Road', vatRegistered: true, vatNumber: '4123456789' }, CTX);
    const customer = (await facts.recordParty(w.env, { kind: 'person', name: 'Mokoena', roles: ['customer'] }, CTX)).id;
    const supplier = (await facts.recordParty(w.env, { kind: 'organisation', name: 'Vendor', roles: ['supplier'], contact: { vatNumber: '4222222222' } }, CTX)).id;
    return { w, customer, supplier };
  };
  const invoice = (x, price = 100000) => facts.recordDocument(x.w.env, { kind: 'invoice', direction: 'sell', partyId: x.customer, currency: 'ZAR', issuedOn: '2026-10-01', lines: [{ description: 'Job', quantityMilli: 1000, unit: 'job', unitPriceMinor: price, taxBp: 0 }] }, CTX);
  const pay = (x, extra = {}) => facts.recordPayment(x.w.env, { direction: 'in', partyId: x.customer, amountMinor: 50000, currency: 'ZAR', occurredOn: '2026-11-02', method: 'eft', allocations: [], ...extra }, CTX);
  const lineAccounts = (x, movementId) => x.w.db.prepare("SELECT l.account_id, l.debit_minor, l.credit_minor FROM eng_journal_line l JOIN eng_journal_entry e ON e.id = l.entry_id WHERE e.source_kind = 'movement' AND e.source_id = ? AND e.reverses_entry_id IS NULL").all(movementId);
  const balance = (x, accountId) => Number(x.w.db.prepare('SELECT COALESCE(SUM(debit_minor - credit_minor), 0) AS b FROM eng_journal_line WHERE account_id = ?').get(accountId).b);

  // ---- adding an account -------------------------------------------------------------------------------------------------------------------------------------------------------------------
  let x = await world(); await invoice(x);
  const first = await pay(x);   // the chart exists once something has posted
  const def = (await bankAccounts(x.w.env))[0];
  check((await bankAccounts(x.w.env)).length === 1 && def.isDefault === true && def.code === '1000', 'before any is added there is one bank account: the default, 1000');
  const before = JSON.stringify(x.w.counts());
  const a1 = await facts.addBankAccount(x.w.env, { name: 'Savings' }, CTX);
  const list = await bankAccounts(x.w.env);
  check(a1.code === '1020' && list.length === 2 && list[0].isDefault && !list[1].isDefault && list[1].name === 'Savings' && list[1].id === a1.accountId, 'a savings account gets the next free code, 1020, and is listed after the default');
  check(JSON.stringify(x.w.changedTables(JSON.parse(before))) === JSON.stringify(['eng_account', 'eng_bank_account', 'eng_event']), `adding writes only the account, the listing and one event (${x.w.changedTables(JSON.parse(before))})`);
  const a2 = await facts.addBankAccount(x.w.env, { name: 'Credit card' }, CTX);
  check(a2.code === '1021', 'the next one is 1021');
  check(await codeOf(() => facts.addBankAccount(x.w.env, { name: 'savings' }, CTX)) === 'invalid_state', 'a name already used (any capital letters) is refused');
  check(await codeOf(() => facts.addBankAccount(x.w.env, { name: 'S' }, CTX)) === 'invalid_input', 'a name that is too short is refused');
  check(capabilities.CAPABILITY_IDS.includes('bank_account.add') && capabilities.CAPABILITY_IDS.includes('ledger.bank_accounts'), 'the capability and the read exist');
  const c = capabilities.ENGINE_CONTRACTS.find((k) => k.id === 'bank_account.add');
  check(c.validate({ name: 'Petty', extra: 1 }).ok === false && c.validate({ name: 'Petty' }).ok === true && c.permissions.includes('business.manage'), 'it takes only a name and needs permission to manage the business');
  const ev = x.w.db.prepare("SELECT type, actor_email FROM eng_event WHERE type = 'bank_account.added' ORDER BY id").all();
  check(ev.length === 2 && ev[0].actor_email === 'owner@example.com', 'each is one event saying who added it');

  // ---- payments that name an account -------------------------------------------------------------------------------------------------------------------------------------------------------
  const defId = def.id;
  check(lineAccounts(x, first.movementId).some((l) => l.account_id === defId && l.debit_minor === 50000), 'a payment that names no account goes to the default, as before');
  const p2 = await pay(x, { bankAccountId: a1.accountId });
  const la = lineAccounts(x, p2.movementId);
  check(la.some((l) => l.account_id === a1.accountId && l.debit_minor === 50000) && !la.some((l) => l.account_id === defId), 'a payment naming Savings debits Savings and not the default');
  check(balance(x, a1.accountId) === 50000 && balance(x, defId) === 50000, 'each account holds its own money');
  check(x.w.db.prepare('SELECT bank_account_id FROM eng_money_movement WHERE id = ?').get(p2.movementId).bank_account_id === a1.accountId, 'the payment records which account');
  check(x.w.db.prepare("SELECT payload_json FROM eng_event WHERE type = 'payment.recorded' ORDER BY id DESC LIMIT 1").get().payload_json.includes(`"bankAccountId":${a1.accountId}`), 'and so does its event');
  check(await codeOf(() => pay(x, { bankAccountId: 9999 })) === 'not_found', 'an account that is not a bank account is refused');
  check(await codeOf(() => pay(x, { bankAccountId: x.w.db.prepare("SELECT id FROM eng_account WHERE code = '1100'").get().id })) === 'not_found', 'so is any other account in the chart');
  check(await codeOf(() => pay(x, { method: 'cash', bankAccountId: a1.accountId })) === 'invalid_input', 'cash is not paid into a bank account');
  check(await codeOf(() => pay(x, { bankAccountId: 'one' })) === 'invalid_input', 'a bank account that is not a number is refused');
  const cash = await pay(x, { method: 'cash' });
  check(lineAccounts(x, cash.movementId).some((l) => l.debit_minor === 50000 && l.account_id !== defId && l.account_id !== a1.accountId), 'cash still goes to the cash account');

  // a supplier payment and an expense
  const bill = await facts.recordSupplierInvoice(x.w.env, { supplierId: x.supplier, invoicedOn: '2026-10-05', dueOn: '2026-11-05', currency: 'ZAR', supplierInvoiceNumber: 'F-1', category: 'materials', taxInvoiceHeld: true, lines: [{ description: 'Timber', quantityMilli: 1000, unit: 'lot', unitPriceMinor: 30000, taxBp: 0 }] }, CTX);
  const sp = await facts.recordSupplierPayment(x.w.env, { supplierId: x.supplier, amountMinor: 30000, currency: 'ZAR', paidOn: '2026-11-06', method: 'eft', bankAccountId: a2.accountId, allocate: 'oldest_first' }, CTX);
  const spl = lineAccounts(x, sp.movementId);
  check(spl.some((l) => l.account_id === a2.accountId && l.credit_minor === 30000), 'a supplier payment naming the card credits the card');
  const ex = await facts.recordExpense(x.w.env, { supplierId: x.supplier, incurredOn: '2026-11-07', method: 'card', category: 'materials', currency: 'ZAR', amountsIncludeTax: true, lines: [{ description: 'Item', amountMinor: 11500, taxBp: 1500 }], amountPaidMinor: 11500, taxInvoiceHeld: true, bankAccountId: a2.accountId }, CTX);
  check(lineAccounts(x, ex.movementId).some((l) => l.account_id === a2.accountId && l.credit_minor === 11500), 'an expense paid by card credits the card');
  check(balance(x, a2.accountId) === -41500, 'the card account is 41500 overdrawn');

  // ---- reversing and correcting keep the account -------------------------------------------------------------------------------------------------------------------------------------------
  await facts.correctMovement(x.w.env, { movementId: p2.movementId, reason: 'wrong amount', replacement: { partyId: x.customer, amountMinor: 40000 } }, CTX);
  check(balance(x, a1.accountId) === 40000 && balance(x, defId) === 50000, 'correcting a payment puts the replacement in the same account and the original is reversed there');
  check((await ledgerReports.trialBalanceAsAt(x.w.env, null)).balanced === true, 'the trial balance still balances');
  const v = await verifyIntegrity(x.w.env);
  check(v.ok === true, `the verifier is content (${JSON.stringify(v.problems || []).slice(0, 160)})`);

  // ---- the verifier -------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const y = await world(); await invoice(y);
  const ya = await facts.addBankAccount(y.w.env, { name: 'Savings' }, CTX);
  const yp = await pay(y, { bankAccountId: ya.accountId });
  y.w.db.prepare("UPDATE eng_journal_line SET account_id = (SELECT account_id FROM eng_account_role WHERE role = 'bank' ORDER BY id DESC LIMIT 1) WHERE account_id = ?").run(ya.accountId);
  const bad = await verifyIntegrity(y.w.env);
  check(bad.ok === false && JSON.stringify(bad).includes('bank_account_inconsistent') && JSON.stringify(bad).includes(`payment ${yp.movementId}`), 'a payment whose entry went to another account is found');
  const z = await world(); await invoice(z);
  const za = await facts.addBankAccount(z.w.env, { name: 'Savings' }, CTX);
  z.w.db.prepare("UPDATE eng_account SET type = 'expense' WHERE id = ?").run(za.accountId);
  check(JSON.stringify(await verifyIntegrity(z.w.env)).includes('bank_account_inconsistent'), 'a listed bank account that is no longer an asset account is found');
  const q = await world(); await invoice(q); await pay(q);
  const qa = await facts.addBankAccount(q.w.env, { name: 'Savings' }, CTX);
  q.w.db.prepare('UPDATE eng_money_movement SET bank_account_id = (SELECT id FROM eng_account WHERE code = \'1100\')').run();
  check(JSON.stringify(await verifyIntegrity(q.w.env)).includes('names an account that is not a bank account'), 'a payment that names a non-bank account is found');
});
if (require.main === module) kit.standalone(module.exports);
