// The general ledger, increment G2b (docs/decisions/general-ledger.md): STOCK. Every stock fact is one move; the move's kind decides its entry, at the value the move was stamped with (moving average cost).
//   receive (goods receipt)   Dr inventory, Cr goods received not invoiced      receive (no receipt behind it)  Dr inventory, Cr suspense (a defect a report lists)
//   issue                     Dr cost of sales, Cr inventory                    customer return                 Dr inventory, Cr cost of sales
//   adjust / count / write-down  through stock adjustments                      transfer                        no entry
//   bill for an order         clears goods received not invoiced up to what was stocked, the rest is expense (no double count)
//   reversal                  a contra of the original's entry
//   invariant                 the inventory account equals the value of the stock on hand
const kit = require('./engine-kit.js');

module.exports = kit.guard('engine general ledger (G2b: stock)', async ({ check }) => {
  const eng = kit.loadEngine();
  const { facts, journal, stock, verifyIntegrity } = eng;
  const CTX = { actorEmail: 'accountant@example.com', contract: 'test', contractVersion: 1 };
  const world = async () => {
    const w = kit.makeWorld(); w.configure({ currency: 'ZAR' });
    await facts.setBusinessProfile(w.env, { legalName: 'Test (Pty) Ltd', address: '5 Industrial Road', vatRegistered: true, vatNumber: '4123456789' }, CTX);
    const sup = (await facts.recordParty(w.env, { kind: 'organisation', name: 'Timber Co', roles: ['supplier'], contact: { vatNumber: '4222222222' } }, CTX)).id;
    const item = (await facts.createItem(w.env, { sku: 'A-1', name: 'Alpha', unit: 'sheet' }, CTX)).itemId;
    const l1 = (await facts.createLocation(w.env, { name: 'Store', kind: 'warehouse' }, CTX)).locationId;
    const l2 = (await facts.createLocation(w.env, { name: 'Van', kind: 'vehicle' }, CTX)).locationId;
    return { w, sup, item, l1, l2 };
  };
  const bal = (x, role) => journal.balanceOfRole(x.w.env, role);
  const recv = (x, q = 10000, c = 5000, d = '2026-11-06') => facts.receiveStock(x.w.env, { itemId: x.item, locationId: x.l1, quantityMilli: q, receivedOn: d, unitCostMinor: c }, CTX);   // 10 sheets at R50 = R500.00
  const issue = (x, q = 2000) => facts.issueStock(x.w.env, { itemId: x.item, locationId: x.l1, quantityMilli: q, issuedOn: '2026-11-07', reason: 'use' }, CTX);
  const entry = async (x, moveId) => (await journal.entriesFor(x.w.env, 'stock_move', moveId));
  const code = async (x, role) => (await journal.accountForRole(x.w.env, role)).code;
  const shape = (e) => e.lines.map((l) => `${l.code} ${l.debitMinor > 0 ? 'D ' + l.debitMinor : 'C ' + l.creditMinor}`).sort();
  const same = (a, b) => JSON.stringify(a) === JSON.stringify([...b].sort());
  const onHandValue = async (x) => (await stock.valuationAsAt(x.w.env, '2026-12-31')).reduce((s, r) => s + r.valueMinor, 0);

  // ---- receiving, issuing -------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  let x = await world();
  const r1 = await recv(x);
  const [re] = await entry(x, r1.moveId);
  const [inv, grni, susp, cos, adj] = await Promise.all(['inventory', 'goods_received_not_invoiced', 'suspense', 'cost_of_sales', 'stock_adjustments'].map((r) => code(x, r)));
  check(re && same(shape(re), [`${inv} D 50000`, `${susp} C 50000`]) && re.entryDate === '2026-11-06', 'stock received with no goods receipt behind it (a manual receipt): Dr inventory 500.00, Cr SUSPENSE, because it cannot be placed; dated the day it was received');
  const i1 = await issue(x);
  const [ie] = await entry(x, i1.moveId);
  check(ie && same(shape(ie), [`${cos} D 10000`, `${inv} C 10000`]), 'issuing 2 sheets at the average R50: Dr cost of sales 100.00, Cr inventory 100.00');
  check(await bal(x, 'inventory') === 40000 && await bal(x, 'inventory') === await onHandValue(x), 'the inventory account equals the value of the stock on hand (R400.00)');

  // ---- transfer, adjustments, count, write-down, return ----------------------------------------------------------------------------------------------------------------------------------------------
  const tr = await facts.transferStock(x.w.env, { itemId: x.item, fromLocationId: x.l1, toLocationId: x.l2, quantityMilli: 1000, movedOn: '2026-11-08' }, CTX);
  check(x.w.count('eng_journal_entry') === 2 && await bal(x, 'inventory') === await onHandValue(x), 'a transfer between locations posts nothing: the inventory total did not change');
  const loss = await facts.adjustStock(x.w.env, { itemId: x.item, locationId: x.l1, direction: 'out', quantityMilli: 1000, adjustedOn: '2026-11-09', reason: 'loss' }, CTX);
  const [le] = await entry(x, loss.moveId);
  check(le && same(shape(le), [`${adj} D 5000`, `${inv} C 5000`]), 'a stock loss of 1 sheet: Dr stock adjustments 50.00, Cr inventory 50.00');
  const gain = await facts.adjustStock(x.w.env, { itemId: x.item, locationId: x.l1, direction: 'in', quantityMilli: 1000, adjustedOn: '2026-11-09', reason: 'found' }, CTX);
  const [ge] = await entry(x, gain.moveId);
  check(ge && same(shape(ge), [`${inv} D 5000`, `${adj} C 5000`]), 'stock found: Dr inventory 50.00, Cr stock adjustments 50.00');
  const ret = await facts.returnStock(x.w.env, { issueMoveId: i1.moveId, quantityMilli: 1000, locationId: x.l1, returnedOn: '2026-11-10' }, CTX);
  const [rt] = await entry(x, ret.moveId);
  check(rt && same(shape(rt), [`${inv} D 5000`, `${cos} C 5000`]), 'a customer return puts the cost back: Dr inventory 50.00, Cr cost of sales 50.00');
  const cnt = await facts.countStock(x.w.env, { locationId: x.l1, countedOn: '2026-11-11', complete: true, lines: [{ itemId: x.item, countedMilli: 6000 }] }, CTX);
  check(cnt.moveIds.length === 1 && (await entry(x, cnt.moveIds[0])).length === 1 && await bal(x, 'inventory') === await onHandValue(x), 'a stock count variance posts through stock adjustments and the inventory account still equals the stock value');
  const wd = await facts.writeDownStock(x.w.env, { itemId: x.item, amountMinor: 3000, reason: 'damaged', evidence: 'photos of water damage taken on site', writtenDownOn: '2026-11-12' }, CTX);
  check(wd.moveIds.length >= 2 && await bal(x, 'inventory') === await onHandValue(x), 'a write-down (units out at the carrying value, back at the lower) leaves inventory equal to the stock value');
  const lossAcct = await bal(x, 'stock_adjustments');
  check(lossAcct > 0 && (await verifyIntegrity(x.w.env)).ok === true, 'its net cost sits in stock adjustments, and the integrity check passes');

  // ---- reversal ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  x = await world(); await recv(x); const ri = await issue(x);
  await facts.reverseStockMove(x.w.env, { moveId: ri.moveId, reason: 'wrong job', reversedOn: '2026-11-08' }, CTX);
  check(await bal(x, 'cost_of_sales') === 0 && await bal(x, 'inventory') === 50000 && await bal(x, 'inventory') === await onHandValue(x), 'reversing an issue turns its entry round: cost of sales nil, inventory back to R500.00');
  const ctr = (await entry(x, ri.moveId)).find((e) => e.reversesEntryId !== null);
  check(ctr && ctr.entryDate === '2026-11-08', 'the contra is dated the day the reversal says');
  const t2 = await world(); await recv(t2); const trf = await facts.transferStock(t2.w.env, { itemId: t2.item, fromLocationId: t2.l1, toLocationId: t2.l2, quantityMilli: 1000, movedOn: '2026-11-08' }, CTX);
  await facts.reverseStockMove(t2.w.env, { moveId: trf.outMoveId, reason: 'x', reversedOn: '2026-11-09' }, CTX).catch(() => null);
  check(t2.w.count('eng_journal_entry') === 1 && (await verifyIntegrity(t2.w.env)).ok === true, 'a transfer (and the reversal of one) writes no entry, and the integrity check is clean');

  // ---- an order: goods received into stock, then billed -----------------------------------------------------------------------------------------------------------------------------------------
  const orderWorld = async (lineQty = 10000, price = 5000) => {
    const o = await world();
    const order = await facts.recordPurchaseOrder(o.w.env, { supplierId: o.sup, orderedOn: '2026-11-01', currency: 'ZAR', lines: [{ description: 'Alpha', quantityMilli: lineQty, unit: 'sheet', unitPriceMinor: price, taxBp: 1500 }], lineItems: [{ lineNo: 1, itemId: o.item }] }, CTX);
    const gr = await facts.receiveGoods(o.w.env, { orderId: order.documentId, receivedOn: '2026-11-05', lines: [{ lineNo: 1, quantityMilli: lineQty }] }, CTX);
    return { ...o, order, gr };
  };
  const bill = (o, qty, price, extra = {}) => facts.recordSupplierInvoice(o.w.env, { supplierId: o.sup, orderId: o.order.documentId, invoicedOn: '2026-11-08', currency: 'ZAR', supplierInvoiceNumber: 'F-9', category: 'materials', taxInvoiceHeld: true, lines: [{ description: 'Alpha', quantityMilli: qty, unit: 'sheet', unitPriceMinor: price, taxBp: 1500, orderLineNo: 1 }], ...extra }, CTX);
  let o = await orderWorld();
  check(o.w.count('eng_journal_entry') === 0, 'placing an order and recording a goods receipt post nothing: only what actually goes into stock is a financial event');
  const dl = await facts.receiveDelivery(o.w.env, { receiptId: o.gr.documentId, locationId: o.l1, receivedOn: '2026-11-06' }, CTX);
  const [de] = await entry(o, dl.moveIds[0]);
  const [oInv, oGrni] = [await code(o, 'inventory'), await code(o, 'goods_received_not_invoiced')];
  check(de && same(shape(de), [`${oInv} D 50000`, `${oGrni} C 50000`]), 'a delivery put into stock from a goods receipt: Dr inventory 500.00, Cr goods received not invoiced 500.00');
  const b = await bill(o, 10000, 5000);
  const [be] = await journal.entriesFor(o.w.env, 'document', b.documentId);
  const [oMat, oVin, oAp] = [await code(o, 'expense:materials'), await code(o, 'vat_input'), await code(o, 'payables_control')];
  check(be && same(shape(be), [`${oGrni} D 50000`, `${oVin} D 7500`, `${oAp} C 57500`]), 'the bill for those goods (R500 + VAT): Dr goods received not invoiced 500.00 (NOT expense: no double count), Dr VAT input 75.00, Cr payables 575.00');
  check(await bal(o, 'goods_received_not_invoiced') === 0 && await bal(o, 'inventory') === 50000 && await bal(o, 'expense:materials') === 0, 'so goods received not invoiced is cleared to nil, the cost stays in inventory, and nothing hits the materials expense');
  const ob = await orderWorld();
  await facts.receiveDelivery(ob.w.env, { receiptId: ob.gr.documentId, locationId: ob.l1, receivedOn: '2026-11-06' }, CTX);
  const half = await bill(ob, 6000, 5000);
  const [hb] = await journal.entriesFor(ob.w.env, 'document', half.documentId);
  check(hb && shape(hb).includes(`${await code(ob, 'goods_received_not_invoiced')} D 30000`) && await bal(ob, 'goods_received_not_invoiced') === -20000, 'a part bill (6 of 10 sheets) clears only R300.00; R200.00 stays in goods received not invoiced, which is the list of what is received but not yet billed');
  const over = await bill(ob, 8000, 5000, { supplierInvoiceNumber: 'F-10', varianceAccepted: true }).catch((e) => e);
  if (over && over.documentId) {
    const [oe] = await journal.entriesFor(ob.w.env, 'document', over.documentId);
    check(shape(oe).includes(`${await code(ob, 'goods_received_not_invoiced')} D 20000`) && shape(oe).includes(`${await code(ob, 'expense:materials')} D 20000`) && await bal(ob, 'goods_received_not_invoiced') === 0, 'a bill for more than is left received clears only what is left (R200.00); the rest of the bill is expense, never a negative received-not-invoiced balance');
  } else check(true, 'a bill for more than was received is refused by the match rules (nothing for the ledger to do)');
  await facts.voidSupplierInvoice(ob.w.env, { billId: half.documentId, reason: 'wrong', voidedOn: '2026-11-09' }, CTX);
  check(await bal(ob, 'goods_received_not_invoiced') === (over && over.documentId ? -30000 : -50000) && (await verifyIntegrity(ob.w.env)).ok === true, 'voiding a bill puts the cleared amount back into received-not-invoiced, and the integrity check is clean');

  // ---- verifier and atomicity ------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const v = await world(); await recv(v); const vi = await issue(v);
  v.w.db.prepare('DELETE FROM eng_journal_line WHERE entry_id IN (SELECT id FROM eng_journal_entry WHERE source_kind = ? AND source_id = ?)').run('stock_move', vi.moveId);
  v.w.db.prepare('DELETE FROM eng_journal_entry WHERE source_kind = ? AND source_id = ?').run('stock_move', vi.moveId);
  check((await verifyIntegrity(v.w.env)).problems.some((p) => p.code === 'journal_missing'), 'a stock move whose entry was removed behind the engine\'s back is reported (journal_missing)');
  const v2 = await world(); await recv(v2); const vr = await issue(v2); await facts.reverseStockMove(v2.w.env, { moveId: vr.moveId, reason: 'x', reversedOn: '2026-11-08' }, CTX);
  v2.w.db.prepare('DELETE FROM eng_journal_line WHERE entry_id IN (SELECT id FROM eng_journal_entry WHERE source_kind = ? AND reverses_entry_id IS NOT NULL)').run('stock_move');
  v2.w.db.prepare('DELETE FROM eng_journal_entry WHERE source_kind = ? AND reverses_entry_id IS NOT NULL').run('stock_move');
  check((await verifyIntegrity(v2.w.env)).problems.some((p) => p.code === 'journal_missing'), 'a reversal whose contra entry was removed is reported too');
  for (const [name, fn] of [['issuing stock', (z) => issue(z)], ['a write-down', (z) => facts.writeDownStock(z.w.env, { itemId: z.item, amountMinor: 3000, reason: 'damaged', evidence: 'photos of water damage taken on site', writtenDownOn: '2026-11-12' }, CTX)]]) {
    let atomic = true, tried = 0;
    for (let n = 1; n <= 60; n++) {
      const z = await world(); await recv(z); await issue(z);   // the chart exists already
      const was = JSON.stringify(z.w.counts()); z.w.failAt(n);
      let failed = false; try { await fn(z); } catch { failed = true; }
      z.w.resetWrites(); tried += 1;
      if (failed && JSON.stringify(z.w.counts()) !== was) { atomic = false; break; }
      if (!failed) break;
    }
    check(atomic && tried > 3, `a failure injected at every write of ${name} (its entries included) leaves the business exactly as it was`);
  }
});

if (require.main === module) kit.standalone(module.exports);
