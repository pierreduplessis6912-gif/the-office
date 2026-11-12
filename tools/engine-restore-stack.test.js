// Recovery for EVERYTHING built since the first slice (branch engine-phase1; box 8 of "done", docs/CAPABILITY_MAP.md). engine-restore.test.js proves a restore brings the first slice's tables back exactly. Since then nothing was added to the schema, but a LOT was added
// to the events and to what is DERIVED from them: party revisions, the business profile and the tax lock, quotation revisions and acceptance, credit notes, their application, refund, undo and void, debit notes, overpayment allocation and refund, expenses and
// their void, and the VAT summary with its input side. A restore that brought the tables back but left any of those derived answers different would be a silent loss, so this builds a business with a history through ALL of them, takes a snapshot, damages it
// (deletes facts and events, edits a fact, adds junk), restores, and checks the tables are back EXACTLY and every derived answer is the same, the verifier is clean, and the business carries on. Evidence: TEST on the harness (NOT the real platform: the real
// rehearsal of a restore is a separate step that needs Pierre's word).
const crypto = require('crypto');
const kit = require('./engine-kit.js');

module.exports = kit.guard('engine restore (stack)', async ({ check }) => {
  const eng = kit.loadEngine();
  check(Boolean(eng && eng.facts && eng.expenses && eng.business && eng.credits && eng.quotations), 'the engine module builds with its expenses, business, credits and quotations modules');
  if (!eng || !eng.expenses) return;
  const { facts, ledger } = eng;
  const bk = kit.bundle('backup.ts', 'backup');
  const CTX = { actorEmail: 'accountant@example.com', contract: 'test', contractVersion: 1 };
  const ENG = ['eng_config', 'eng_event', 'eng_party', 'eng_party_role', 'eng_draft', 'eng_document', 'eng_document_line', 'eng_document_number', 'eng_money_movement', 'eng_allocation', 'eng_reversal', 'eng_interpretation', 'eng_observation', 'eng_item', 'eng_location', 'eng_stock_move'];
  const fingerprint = (db, tables) => crypto.createHash('sha256').update(tables.map((t) => t + JSON.stringify(db.prepare(`SELECT * FROM "${t}" ORDER BY rowid`).all())).join('|')).digest('hex');
  const L = (price, d, bp = 1500, qty = 1000) => [{ description: d, quantityMilli: qty, unit: 'u', unitPriceMinor: price, taxBp: bp }];

  // a business with a history through every capability since the first slice
  const populate = async (w) => {
    w.configure({ mode: 'engine', available: kit.ALL_CAPABILITIES });
    await facts.setBusinessProfile(w.env, { legalName: 'Zululand Flooring and Blinds (Pty) Ltd', address: '5 Industrial Road, Empangeni', vatRegistered: true, vatNumber: '4123456789' }, CTX);
    const cust = (await facts.recordParty(w.env, { kind: 'organisation', name: 'Mokoena', roles: ['customer'], contact: { vatNumber: '4999999999', address: '1 Main Road' } }, CTX)).id;
    const sup = (await facts.recordParty(w.env, { kind: 'organisation', name: 'Timber Supplies', roles: ['supplier'], contact: { vatNumber: '4111111111' } }, CTX)).id;
    await facts.reviseParty(w.env, { partyId: cust, name: 'Mokoena Flooring', addRoles: ['supplier'], contact: { phone: '+27 82 555 0101' } }, CTX);
    const inv1 = await facts.recordDocument(w.env, { kind: 'invoice', direction: 'sell', partyId: cust, currency: 'ZAR', issuedOn: '2026-10-01', lines: L(100000, 'Vinyl plank') }, CTX);
    const inv2 = await facts.recordDocument(w.env, { kind: 'invoice', direction: 'sell', partyId: cust, currency: 'ZAR', issuedOn: '2026-10-15', lines: L(20000, 'Skirting') }, CTX);
    const q1 = await facts.recordDocument(w.env, { kind: 'quotation', direction: 'sell', partyId: cust, currency: 'ZAR', issuedOn: '2026-10-20', lines: L(50000, 'Lounge floor') }, CTX);
    const q2 = await facts.reviseQuotation(w.env, { quotationId: q1.id, lines: L(60000, 'Lounge floor'), validUntil: '2026-12-01' }, CTX);
    await facts.acceptQuotation(w.env, { quotationId: q2.documentId }, CTX);
    const pay = await facts.recordPayment(w.env, { direction: 'in', partyId: cust, amountMinor: 115000, currency: 'ZAR', occurredOn: '2026-11-05', method: 'eft', allocations: [{ documentId: inv1.id, amountMinor: 115000 }] }, CTX);
    const cn1 = await facts.issueCreditNote(w.env, { invoiceId: inv1.id, reason: 'damaged boards', issuedOn: '2026-11-10', lines: [{ invoiceLineNo: 1, quantityMilli: 500, unitPriceMinor: 100000 }] }, CTX);   // invoice already paid: all unapplied
    const dn = await facts.issueDebitNote(w.env, { invoiceId: inv1.id, reason: 'extra underlay', issuedOn: '2026-11-10', lines: [{ invoiceLineNo: 1, quantityMilli: 1000, unitPriceMinor: 30000 }] }, CTX);
    const ap = await facts.applyCredit(w.env, { creditNoteId: cn1.documentId, invoiceId: dn.documentId, amountMinor: 20000, appliedOn: '2026-11-11' }, CTX);
    await facts.removeAllocation(w.env, { allocationId: ap.allocationId, reason: 'wrong target' }, CTX);
    await facts.applyCredit(w.env, { creditNoteId: cn1.documentId, invoiceId: dn.documentId, amountMinor: 15000, appliedOn: '2026-11-11' }, CTX);
    const rf = await facts.refundCredit(w.env, { creditNoteId: cn1.documentId, amountMinor: 5000, refundedOn: '2026-11-12', method: 'eft' }, CTX);
    await facts.voidRefund(w.env, { movementId: rf.movementId, reason: 'bank returned it' }, CTX);
    await facts.refundCredit(w.env, { creditNoteId: cn1.documentId, amountMinor: 7000, refundedOn: '2026-11-13', method: 'cash' }, CTX);
    const cn2 = await facts.issueCreditNote(w.env, { invoiceId: inv2.id, reason: 'wrong item', issuedOn: '2026-11-10', lines: [{ invoiceLineNo: 1, quantityMilli: 250, unitPriceMinor: 20000 }] }, CTX);
    await facts.voidCreditNote(w.env, { creditNoteId: cn2.documentId, reason: 'issued in error', voidedOn: '2026-11-14' }, CTX);
    const over = await facts.recordPayment(w.env, { direction: 'in', partyId: cust, amountMinor: 60000, currency: 'ZAR', occurredOn: '2026-11-06', method: 'eft', allocations: [{ documentId: inv2.id, amountMinor: 23000 }] }, CTX);   // R370.00 overpaid
    await facts.refundPayment(w.env, { paymentId: over.movementId, amountMinor: 10000, refundedOn: '2026-11-15', method: 'eft' }, CTX);
    const e1 = await facts.recordExpense(w.env, { supplierId: sup, incurredOn: '2026-10-10', method: 'eft', category: 'materials', currency: 'ZAR', amountsIncludeTax: true, lines: [{ description: 'Plywood', amountMinor: 23000, taxBp: 1500 }], amountPaidMinor: 23000, taxInvoiceHeld: true, supplierInvoiceNumber: 'INV-1' }, CTX);
    await facts.recordExpense(w.env, { supplierId: sup, incurredOn: '2026-10-12', method: 'card', category: 'tools', currency: 'ZAR', amountsIncludeTax: true, lines: [{ description: 'Table saw', amountMinor: 115000, taxBp: 1500 }], amountPaidMinor: 115000, taxInvoiceHeld: true, capital: true, supplierInvoiceNumber: 'INV-2' }, CTX);
    await facts.recordExpense(w.env, { supplierId: sup, incurredOn: '2026-10-14', method: 'card', category: 'entertainment', currency: 'ZAR', amountsIncludeTax: true, lines: [{ description: 'Client lunch', amountMinor: 11500, taxBp: 1500 }], amountPaidMinor: 11500, taxInvoiceHeld: true }, CTX);
    const e4 = await facts.recordExpense(w.env, { supplierId: sup, incurredOn: '2026-10-16', method: 'eft', category: 'fuel', currency: 'ZAR', amountsIncludeTax: true, lines: [{ description: 'Diesel', amountMinor: 5000, taxBp: 1500 }], amountPaidMinor: 5000, taxInvoiceHeld: true, supplierInvoiceNumber: 'INV-4' }, CTX);
    await facts.voidExpense(w.env, { expenseId: e4.documentId, reason: 'duplicate', voidedOn: '2026-10-17' }, CTX);
    await facts.setTaxLock(w.env, { lockDate: '2026-10-31' }, CTX);
    await facts.recordExpense(w.env, { supplierId: sup, incurredOn: '2026-10-20', method: 'eft', category: 'materials', currency: 'ZAR', amountsIncludeTax: true, lines: [{ description: 'Late invoice', amountMinor: 11500, taxBp: 1500 }], amountPaidMinor: 11500, taxInvoiceHeld: true, supplierInvoiceNumber: 'LATE-1' }, CTX);   // claimed in November
    // stock: items, locations and the movement ledger (migration 0005), through every kind of movement
    const item = (await facts.createItem(w.env, { sku: 'PLY-18', name: 'Plywood 18mm sheet', unit: 'sheet', reorderLevelMilli: 5000, preferredSupplierId: sup }, CTX)).itemId;
    await facts.reviseItem(w.env, { itemId: item, name: 'Plywood 18mm board', reorderLevelMilli: 3000 }, CTX);
    const main = (await facts.createLocation(w.env, { name: 'Main store', kind: 'warehouse' }, CTX)).locationId, van = (await facts.createLocation(w.env, { name: 'Bakkie 1', kind: 'vehicle' }, CTX)).locationId;
    await facts.receiveStock(w.env, { itemId: item, locationId: main, quantityMilli: 10000, receivedOn: '2026-10-06', unitCostMinor: 20000 }, CTX);
    await facts.receiveStock(w.env, { itemId: item, locationId: main, quantityMilli: 10000, receivedOn: '2026-10-07', unitCostMinor: 30000 }, CTX);
    const iss = await facts.issueStock(w.env, { itemId: item, locationId: main, quantityMilli: 5000, issuedOn: '2026-10-08', reason: 'job', jobRef: 'Mokoena lounge' }, CTX);
    await facts.transferStock(w.env, { itemId: item, fromLocationId: main, toLocationId: van, quantityMilli: 4000, movedOn: '2026-10-09' }, CTX);
    await facts.adjustStock(w.env, { itemId: item, locationId: van, direction: 'out', quantityMilli: 500, adjustedOn: '2026-10-10', reason: 'damage', note: 'dropped' }, CTX);
    await facts.reverseStockMove(w.env, { moveId: iss.moveId, reason: 'wrong job', reversedOn: '2026-10-11' }, CTX);
    const hold = await facts.reserveStock(w.env, { itemId: item, quantityMilli: 4000, reservedOn: '2026-10-12', forRef: 'Mokoena lounge' }, CTX);
    await facts.issueStock(w.env, { itemId: item, locationId: main, quantityMilli: 1000, issuedOn: '2026-10-13', reason: 'job', jobRef: 'Mokoena lounge', reservationId: hold.reservationId }, CTX);
    await facts.countStock(w.env, { locationId: main, countedOn: '2026-10-14', lines: [{ itemId: item, countedMilli: 14000 }] }, CTX);
    await facts.releaseReservation(w.env, { reservationId: hold.reservationId, reason: 'rest not needed', releasedOn: '2026-10-15' }, CTX);
    return { cust, sup, inv1, inv2, q1, q2, cn1, cn2, dn, over, e1, item };
  };

  // every answer the business derives from its facts and events, as the app and the assistants read them
  const derive = async (w, ids) => JSON.stringify({
    profile: await eng.business.businessProfile(w.env), lock: await eng.business.taxLockDate(w.env),
    parties: await eng.parties.allProfiles(w.env),
    quotations: await eng.quotations.allQuotations(w.env),
    vatOct: await eng.business.vatSummary(w.env, { from: '2026-10-01', to: '2026-10-31' }), vatNov: await eng.business.vatSummary(w.env, { from: '2026-11-01', to: '2026-11-30' }),
    expenses: await eng.expenses.allExpenses(w.env, { status: 'any' }),
    owes: await ledger.outstandingForParty(w.env, ids.cust), credit: await ledger.unappliedCreditForParty(w.env, ids.cust),
    cn1: await eng.credits.creditAvailable(w.env, ids.cn1.documentId), cn2: await eng.credits.creditAvailable(w.env, ids.cn2.documentId),
    particulars: [await eng.business.documentParticulars(w.env, ids.inv1.id), await eng.business.documentParticulars(w.env, ids.cn1.documentId)],
    stock: await eng.stock.stockReport(w.env), ledger: await eng.stock.stockLedger(w.env, ids.item), locations: await eng.stock.allLocations(w.env), profile1: await eng.stock.itemProfile(w.env, ids.item), reservations: await eng.stock.allReservations(w.env, { status: 'any' }), reorder: await eng.stock.reorderSuggestions(w.env),
  });

  const w = kit.makeWorld({ backups: true });
  const ids = await populate(w);
  const integ = await eng.verifyIntegrity(w.env);
  check(integ.ok === true && integ.problems.length === 0 && integ.warnings.length === 0, 'the business built through every capability since the first slice verifies clean before the snapshot (no problem, no unmodelled event)');
  const events = w.db.prepare('SELECT type, COUNT(*) AS n FROM eng_event GROUP BY type').all().map((r) => r.type);
  check(['business.profile_set', 'tax_lock.set', 'party.revised', 'quotation.revised', 'quotation.accepted', 'credit_note.issued', 'credit.allocated', 'credit.refunded', 'credit_note.voided', 'debit_note.issued', 'overpayment.refunded', 'expense.recorded', 'expense.voided', 'item.created', 'item.revised', 'location.created', 'stock.received', 'stock.issued', 'stock.transferred_out', 'stock.transferred_in', 'stock.adjusted', 'stock.move_reversed', 'stock.reserved', 'stock.released', 'stock.counted'].every((t) => events.includes(t)), 'its history really uses every one of the new event types, stock included');
  const before = await derive(w, ids), engineBefore = fingerprint(w.db, ENG);
  const seqBefore = JSON.stringify(w.db.prepare('SELECT name, seq FROM sqlite_sequence ORDER BY name').all());
  const D = JSON.parse(before);
  check(D.vatNov.field15Minor === 1500 && D.vatOct.field14Minor === 15000 && D.vatOct.field15Minor === 3000 && D.credit > 0 && D.cn1 >= 0, 'set-up sanity: the derived answers are the ones the history implies (the late October expense claimed in November, capital goods in field 14, credit still owed back)');
  check(D.stock.length === 1 && D.stock[0].quantityMilli === 17500 && D.reservations.length === 1 && D.reservations[0].status === 'released' && D.profile1.name === 'Plywood 18mm board', 'set-up sanity (stock): 20 sheets in, 5 issued then the issue reversed, 0.5 written off, then a reservation drawn on and released and a count at Main store down to 14 (so 17.5 on hand in all), under the revised name');
  const snap = await bk.takeSnapshot(w.env, new Date('2026-11-16T03:00:00Z'));
  check(snap && snap.complete === true && ENG.every((t) => snap.tables.some((x) => x.name === t)), 'a snapshot is taken, complete, and lists every engine table');

  // damage that a careless fix might do: remove facts and events, edit a fact, add junk
  w.db.exec('PRAGMA foreign_keys = OFF');
  for (const t of ['eng_reversal', 'eng_allocation', 'eng_money_movement', 'eng_stock_move']) w.db.exec(`DELETE FROM ${t}`);
  w.db.prepare("DELETE FROM eng_event WHERE type IN ('expense.recorded', 'credit_note.issued', 'tax_lock.set', 'business.profile_set')").run();
  w.db.prepare('UPDATE eng_document_line SET unit_price_minor = 1').run();
  w.db.prepare("INSERT INTO eng_event (type, payload_json) VALUES ('expense.recorded', '{\"documentId\":999}')").run();
  w.db.exec('PRAGMA foreign_keys = ON');
  const damaged = await eng.verifyIntegrity(w.env);
  check(damaged.ok === false && fingerprint(w.db, ENG) !== engineBefore && (await derive(w, ids)) !== before, 'after the damage the verifier reports it, the tables differ, and the derived answers differ too (so the check below means something)');
  const report = await bk.restoreSnapshot(w.env, snap.name, 'eng-a');
  check(report.ok === true && report.differences.length === 0, `the restore reports ok with no differences (${report.tablesRestored} tables, ${report.rowsRestored} rows)`);
  check(fingerprint(w.db, ENG) === engineBefore, 'every engine table is back EXACTLY: rows, ids, relationships, in order');
  check(JSON.stringify(w.db.prepare('SELECT name, seq FROM sqlite_sequence ORDER BY name').all()) === seqBefore, 'and the id sequences are back exactly (so no id a deleted row once held is ever reused)');
  check((await derive(w, ids)) === before, 'and EVERY derived answer is exactly what it was: the profile, the tax lock, the parties (with their revisions), the quotations and their states, the VAT summary for October and November (output and input sides), the expenses (recorded and voided), what the customer owes and is owed, the credit left on each credit note, and each document\'s tax particulars');
  const after = await eng.verifyIntegrity(w.env);
  check(after.ok === true && after.problems.length === 0 && after.warnings.length === 0, 'the restored business verifies clean');
  check(w.db.prepare('PRAGMA foreign_key_check').all().length === 0, 'and no relationship points at nothing');
  const next = await facts.recordExpense(w.env, { supplierId: ids.sup, incurredOn: '2026-11-17', method: 'eft', category: 'materials', currency: 'ZAR', amountsIncludeTax: true, lines: [{ description: 'After restore', amountMinor: 11500, taxBp: 1500 }], amountPaidMinor: 11500, taxInvoiceHeld: true, supplierInvoiceNumber: 'AFTER-1' }, CTX);
  check(next.number === 6 && next.documentId > ids.dn.documentId, 'the business carries on: the next expense is number 6 (five were recorded, one voided; numbering has no hole and no clash) and ids continue');
  let dup = null; try { await facts.recordExpense(w.env, { supplierId: ids.sup, incurredOn: '2026-11-18', method: 'eft', category: 'materials', currency: 'ZAR', amountsIncludeTax: true, lines: [{ description: 'Again', amountMinor: 11500, taxBp: 1500 }], amountPaidMinor: 11500, taxInvoiceHeld: true, supplierInvoiceNumber: 'INV-1' }, CTX); } catch (e) { dup = e && e.code; }
  check(dup === 'duplicate', 'a supplier invoice recorded before the restore is still refused as a duplicate after it');
  let lockCode = null; try { await facts.setTaxLock(w.env, { lockDate: '2026-10-01' }, CTX); } catch (e) { lockCode = e && e.code; }
  check(lockCode === 'invalid_state', 'the tax lock is still where it was, and still only moves forward');
  const credit = await ledger.unappliedCreditForParty(w.env, ids.cust);
  check(credit === D.credit, 'the credit owed back to the customer is unchanged by the restore and by the work after it');
});

if (require.main === module) kit.standalone(module.exports);
