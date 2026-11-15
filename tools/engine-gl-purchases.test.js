// The general ledger, increment G2a (docs/decisions/general-ledger.md): the PURCHASING side that needs no stock: expenses, supplier bills, money paid out. Rules proven here:
//   expense        Dr the category's expense account (net, plus VAT that cannot be claimed), Dr VAT input (claimable VAT only), Cr payables control; its payment is its own movement: Dr payables control, Cr bank or cash
//   supplier bill  the same purchase entry; paying it is a movement entry; payables control equals what the bills still owe
//   reversal       a voided expense or bill (and its payment) is turned round by contra entries, never edited
//   verifier       a purchase fact whose entry is missing is reported (journal_missing)
const kit = require('./engine-kit.js');

module.exports = kit.guard('engine general ledger (G2a: purchases)', async ({ check }) => {
  const eng = kit.loadEngine();
  const { facts, journal, bills, verifyIntegrity } = eng;
  const CTX = { actorEmail: 'accountant@example.com', contract: 'test', contractVersion: 1 };
  const PROFILE = { legalName: 'Test (Pty) Ltd', address: '5 Industrial Road, Empangeni', vatRegistered: true, vatNumber: '4123456789' };
  const world = async (profile = PROFILE) => {
    const w = kit.makeWorld(); w.configure({ currency: 'ZAR' });
    if (profile) await facts.setBusinessProfile(w.env, profile, CTX);
    const vendor = (await facts.recordParty(w.env, { kind: 'organisation', name: 'Vendor Co', roles: ['supplier'], contact: { vatNumber: '4222222222' } }, CTX)).id;
    const noVat = (await facts.recordParty(w.env, { kind: 'organisation', name: 'Corner Shop', roles: ['supplier'] }, CTX)).id;
    const customer = (await facts.recordParty(w.env, { kind: 'person', name: 'Mokoena', roles: ['customer'] }, CTX)).id;
    return { w, vendor, noVat, customer };
  };
  const expense = (x, extra = {}, sup = 'vendor') => facts.recordExpense(x.w.env, { supplierId: x[sup], incurredOn: '2026-10-10', method: 'eft', category: 'materials', currency: 'ZAR', amountsIncludeTax: true, lines: [{ description: 'Item', amountMinor: 23000, taxBp: 1500 }], amountPaidMinor: 23000, taxInvoiceHeld: true, ...extra }, CTX);
  const bill = (x, extra = {}) => facts.recordSupplierInvoice(x.w.env, { supplierId: x.vendor, invoicedOn: '2026-11-06', currency: 'ZAR', supplierInvoiceNumber: 'F-1', category: 'materials', taxInvoiceHeld: true, lines: [{ description: 'Boards', quantityMilli: 1000, unit: 'u', unitPriceMinor: 100000, taxBp: 1500 }], ...extra }, CTX);   // net 100000, tax 15000, gross 115000
  const pay = (x, billId, amountMinor, method = 'eft') => facts.recordSupplierPayment(x.w.env, { supplierId: x.vendor, amountMinor, currency: 'ZAR', paidOn: '2026-11-10', method, allocations: [{ billId, amountMinor }] }, CTX);
  const shape = (e) => e.lines.map((l) => `${l.code} ${l.debitMinor > 0 ? 'D ' + l.debitMinor : 'C ' + l.creditMinor}`).sort();
  const entriesOf = (w, kind, id) => journal.entriesFor(w.env, kind, id);
  const codeOf = async (role, w) => (await journal.accountForRole(w.env, role)).code;
  const bal = (w, role) => journal.balanceOfRole(w.env, role);

  // ---- an expense: the document and its payment each post their own entry --------------------------------------------------------------------------------------------------------------------------
  let x = await world();
  const e1 = await expense(x);
  const [doc] = await entriesOf(x.w, 'document', e1.documentId), [mv] = await entriesOf(x.w, 'movement', e1.movementId);
  const [mat, vin, ap, bank] = [await codeOf('expense:materials', x.w), await codeOf('vat_input', x.w), await codeOf('payables_control', x.w), await codeOf('bank', x.w)];
  check(doc && JSON.stringify(shape(doc)) === JSON.stringify([`${mat} D 20000`, `${vin} D 3000`, `${ap} C 23000`].sort()), 'a claimable expense of R230 (R200 + R30 VAT): Dr materials 200.00, Dr VAT input 30.00, Cr payables 230.00');
  check(mv && JSON.stringify(shape(mv)) === JSON.stringify([`${ap} D 23000`, `${bank} C 23000`].sort()), 'its payment: Dr payables 230.00, Cr bank 230.00');
  check(await bal(x.w, 'payables_control') === 0 && await bal(x.w, 'bank') === -23000 && await bal(x.w, 'vat_input') === 3000, 'so an expense leaves nothing owing, the bank down by what was paid and the VAT claim up by the VAT');
  check(doc.entryDate === '2026-10-10' && doc.eventId === (x.w.db.prepare('SELECT event_id FROM eng_document WHERE id = ?').get(e1.documentId).event_id), 'the entry is dated the expense date and carried by the document\'s own event');

  // ---- VAT that cannot be claimed stays in the cost ------------------------------------------------------------------------------------------------------------------------------------------------
  const e2 = await expense(x, {}, 'noVat');
  const [d2] = await entriesOf(x.w, 'document', e2.documentId);
  check(JSON.stringify(shape(d2)) === JSON.stringify([`${mat} D 23000`, `${ap} C 23000`].sort()), 'an expense from a supplier with no VAT number: the VAT cannot be claimed, so all R230 is cost and nothing goes to VAT input');
  const e3 = await expense(x, { category: 'entertainment' });
  const [d3] = await entriesOf(x.w, 'document', e3.documentId);
  check(JSON.stringify(shape(d3)) === JSON.stringify([`${await codeOf('expense:entertainment', x.w)} D 23000`, `${ap} C 23000`].sort()), 'entertainment: input VAT is denied by law, so it is cost under its own category account');
  const y = await world({ ...PROFILE, vatRegistered: false });
  const [dy] = await entriesOf(y.w, 'document', (await expense(y)).documentId);
  const vinY = await codeOf('vat_input', y.w);
  check(!shape(dy).some((s) => s.startsWith(`${vinY} `)), 'a business that is not VAT registered never posts to VAT input');
  const cash = await expense(x, { method: 'cash' });
  const [mc] = await entriesOf(x.w, 'movement', cash.movementId);
  check(shape(mc).includes(`${await codeOf('cash', x.w)} C 23000`), 'an expense paid in cash credits the cash account, not the bank');

  // ---- a supplier bill and paying it ------------------------------------------------------------------------------------------------------------------------------------------------------------------
  x = await world();
  const b1 = await bill(x);
  const [bd] = await entriesOf(x.w, 'document', b1.documentId);
  check(JSON.stringify(shape(bd)) === JSON.stringify([`${mat} D 100000`, `${vin} D 15000`, `${ap} C 115000`].sort()), 'a bill of R1,150 (R1,000 + VAT): Dr materials 1,000.00, Dr VAT input 150.00, Cr payables 1,150.00');
  const owed = async (w) => (await bills.allBills(w.env)).reduce((s, r) => s + (r.status === 'voided' ? 0 : r.outstandingMinor), 0);
  check(await bal(x.w, 'payables_control') === -(await owed(x.w)) && await owed(x.w) === 115000, 'payables control equals what the supplier bills still owe (R1,150.00)');
  const p1 = await pay(x, b1.documentId, 40000);
  const [pm] = await entriesOf(x.w, 'movement', p1.movementId);
  check(JSON.stringify(shape(pm)) === JSON.stringify([`${ap} D 40000`, `${bank} C 40000`].sort()), 'a part payment of R400: Dr payables 400.00, Cr bank 400.00; the allocation to the bill adds no entry of its own');
  check(await bal(x.w, 'payables_control') === -(await owed(x.w)) && await owed(x.w) === 75000, 'payables control still equals what is owed (R750.00) after the part payment');
  await pay(x, b1.documentId, 75000, 'cash');
  check(await bal(x.w, 'payables_control') === 0 && await owed(x.w) === 0 && await bal(x.w, 'cash') === -75000, 'paid in full: payables control is nil, and the cash payment came out of the cash account');
  check((await verifyIntegrity(x.w.env)).ok === true, 'the integrity check passes on a business with purchases, bills and payments');

  // ---- reversal -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  x = await world();
  const ev = await expense(x);
  await facts.voidExpense(x.w.env, { expenseId: ev.documentId, reason: 'duplicate', voidedOn: '2026-10-12' }, CTX);
  const roles = ['payables_control', 'bank', 'vat_input', 'expense:materials'];
  const after = []; for (const r of roles) after.push(await bal(x.w, r));
  check(after.every((v) => v === 0) && x.w.count('eng_journal_entry') === 4, 'voiding an expense turns both its entries round (four entries: two originals, two contras) and every account is back to nil');
  check((await verifyIntegrity(x.w.env)).ok === true, 'and the integrity check passes');
  const vb = await bill(x); await facts.voidSupplierInvoice(x.w.env, { billId: vb.documentId, reason: 'wrong supplier', voidedOn: '2026-11-07' }, CTX);
  check(await bal(x.w, 'payables_control') === 0 && await bal(x.w, 'expense:materials') === 0, 'voiding a bill turns its entry round');
  const ref = await world(); const rb = await bill(ref); const rp = await pay(ref, rb.documentId, 115000);
  await facts.reverse(ref.w.env, { movementId: rp.movementId, reason: 'bounced' }, CTX);
  check(await bal(ref.w, 'payables_control') === -115000 && await bal(ref.w, 'bank') === 0, 'reversing a supplier payment puts the bill back to owing, and the bank back to where it was');

  // ---- a customer refund is money out too, but it must NOT be posted as a payment to a supplier ------------------------------------------------------------------------------------------------
  const r = await world();
  const inv = await facts.recordDocument(r.w.env, { kind: 'invoice', direction: 'sell', partyId: r.customer, currency: 'ZAR', issuedOn: '2026-10-01', lines: [{ description: 'Job', quantityMilli: 1000, unit: 'job', unitPriceMinor: 100000, taxBp: 1500 }] }, CTX);
  await facts.recordPayment(r.w.env, { direction: 'in', partyId: r.customer, amountMinor: 115000, currency: 'ZAR', occurredOn: '2026-10-02', method: 'eft', allocations: [{ documentId: inv.id, amountMinor: 115000 }] }, CTX);   // paid, so a credit note leaves money to refund
  const cn = await facts.issueCreditNote(r.w.env, { invoiceId: inv.id, reason: 'returned', issuedOn: '2026-10-05', lines: [{ invoiceLineNo: 1, quantityMilli: 1000, unitPriceMinor: 100000 }] }, CTX);
  const rf = await facts.refundCredit(r.w.env, { creditNoteId: cn.documentId, amountMinor: 115000, refundedOn: '2026-10-06', method: 'eft' }, CTX);
  const [re] = await entriesOf(r.w, 'movement', rf.movementId);
  check(r.w.count('eng_journal_entry') === 4 && re && re.memo === 'Refund to customer' && (await bal(r.w, 'payables_control')) === 0, 'a refund to a customer posts ONE entry against receivables and never touches payables');

  // ---- other currency, and the verifier -------------------------------------------------------------------------------------------------------------------------------------------------------------
  const f = await world(); await expense(f);
  const usd = await expense(f, { currency: 'USD' });
  const rep = await verifyIntegrity(f.w.env);
  check(f.w.db.prepare("SELECT COUNT(*) AS n FROM eng_journal_entry WHERE source_kind = 'document' AND source_id = ?").get(usd.documentId).n === 0 && rep.ok === true && rep.warnings.some((w) => w.code === 'unposted_foreign_currency'), 'an expense in another currency is not posted, and is reported as a warning, never hidden');
  const t1 = await world(); const te = await expense(t1);
  t1.w.db.prepare('DELETE FROM eng_journal_line WHERE entry_id IN (SELECT id FROM eng_journal_entry WHERE source_kind = ? AND source_id = ?)').run('document', te.documentId);
  t1.w.db.prepare('DELETE FROM eng_journal_entry WHERE source_kind = ? AND source_id = ?').run('document', te.documentId);
  check((await verifyIntegrity(t1.w.env)).problems.some((p) => p.code === 'journal_missing'), 'an expense whose entry has been removed behind the engine\'s back is reported (journal_missing)');
  const t2 = await world(); const tb = await bill(t2); const tp = await pay(t2, tb.documentId, 1000);
  t2.w.db.prepare('DELETE FROM eng_journal_line WHERE entry_id IN (SELECT id FROM eng_journal_entry WHERE source_kind = ? AND source_id = ?)').run('movement', tp.movementId);
  t2.w.db.prepare('DELETE FROM eng_journal_entry WHERE source_kind = ? AND source_id = ?').run('movement', tp.movementId);
  check((await verifyIntegrity(t2.w.env)).problems.some((p) => p.code === 'journal_missing'), 'a supplier payment whose entry has been removed is reported too');

  // ---- atomicity: the entries are written with the facts, or not at all ------------------------------------------------------------------------------------------------------------------------------
  for (const [name, run] of [['an expense', (z) => expense(z)], ['a bill', (z) => bill(z)], ['a supplier payment', null]]) {
    let atomic = true, tried = 0;
    for (let n = 1; n <= 60; n++) {
      const z = await world(); let billId = null;
      if (name === 'a supplier payment') billId = (await bill(z)).documentId; else await expense(z);   // the chart already exists, so only the new fact's own writes are counted
      const was = JSON.stringify(z.w.counts()); z.w.failAt(n);
      let failed = false; try { if (name === 'a supplier payment') await pay(z, billId, 5000); else await run(z); } catch { failed = true; }
      z.w.resetWrites(); tried += 1;
      if (failed && JSON.stringify(z.w.counts()) !== was) { atomic = false; break; }
      if (!failed) break;
    }
    check(atomic && tried > 5, `a failure injected at every write of ${name} (its entries included) leaves the business exactly as it was`);
  }
});

if (require.main === module) kit.standalone(module.exports);
