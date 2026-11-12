// STOCK, increment 3: the procurement link (branch engine-phase1; docs/decisions/inventory-integration.md sections 2, 3 and 6). TESTS FIRST. Evidence label for every check: TEST of the engine on the route harness (NOT staging, NOT production).
// Expected state when first committed: RED. What this pins: a purchase order may name the item each line is for (`lineItems`, kept in the order's own terms: the foundation tables do not change shape and an order without it works exactly as before); goods
// received against such a line can only go into stock as THAT item; a whole delivery can be put into stock at once (stock.receive_delivery), each line at its own cost and never more than the goods receipt brought in; the order shows how much of each line has been
// stocked; stock already on order now counts towards a reorder (the suggestion no longer asks for what is already coming); and a goods-received-not-invoiced read reports the value of what has arrived and not yet been billed.
const kit = require('./engine-kit.js');

module.exports = kit.guard('stock procurement link', async ({ check }) => {
  const eng = kit.loadEngine();
  check(Boolean(eng && eng.permissions && eng.capabilities && eng.facts && eng.stock && eng.purchasing && eng.bills), 'the engine exposes permissions, capabilities, facts and the stock, purchasing and bills modules');
  if (!eng || !eng.permissions || !eng.stock) return;
  const auth = kit.bundle('auth.ts', 'auth');
  const member = (role) => ({ email: `${role}@example.com`, caps: auth.ROLE_CAPABILITIES[role] || [] });
  const AV = [...kit.ALL_CAPABILITIES, 'party.create', 'item.create', 'item.revise', 'location.create', 'purchase_order.create', 'purchase_order.cancel', 'goods.receive', 'purchase_orders.find', 'supplier_invoice.record', 'supplier_invoices.find', 'stock.receive', 'stock.receive_delivery', 'stock.issue', 'items.find', 'stock.on_hand', 'stock.ledger', 'stock.reorder_suggestions', 'goods.unbilled'];
  const ENV = { BUSINESS_ID: 'eng-a' };
  const run = (spec) => kit.route({ env: ENV, seed: kit.seedReceivables(AV), ...spec });
  const propose = (role, capability, payload, transcript = 'a sentence from the person') => ({ method: 'POST', path: '/engine/proposals', role, body: { capability, payload, transcript } });
  const confirm = (role, id = 1) => ({ method: 'POST', path: `/actions/${id}/confirm`, role, body: {} });
  const get = (role, path) => ({ method: 'GET', path, role });
  const added = (res, t) => ((res.writes && res.writes[t] && res.writes[t].added) || []).length;
  const body = (res) => (res.result && res.result.body) || {};
  const status = (res) => res.result && res.result.status;
  const FACTS = ['eng_party', 'eng_document', 'eng_document_line', 'eng_money_movement', 'eng_allocation', 'eng_reversal', 'eng_item', 'eng_location', 'eng_stock_move'];
  const touchesNoFact = (res) => FACTS.every((t) => added(res, t) === 0);
  const fieldOf = (v, k) => ((v.fields || []).find((f) => f.key === k) || {}).value;
  const seq = () => { let n = 0; const steps = []; const api = { steps,
    prop(cap, payload, role = 'accountant') { n += 1; steps.push(propose(role, cap, payload, `(${cap})`)); return n; },
    ok(id, role = 'accountant') { steps.push(confirm(role, id)); return api; },
    setN(k) { n = k; },
    do(cap, payload, role = 'accountant') { const id = api.prop(cap, payload, role); api.ok(id, role); return id; } }; return api; };
  const ext = (src) => { const q = seq(); q.steps.push(...src.steps); q.setN(src.steps.filter((x) => x.method === 'POST' && x.path === '/engine/proposals').length); return q; };
  const has = (role, p) => eng.permissions.permissionsFor(member(role).caps).has(p);
  const line = (description, quantityMilli, unitPriceMinor, unit) => ({ description, quantityMilli, unit, unitPriceMinor, taxBp: 1500 });
  // the world: Timber Supplies (party 2); items 1 plywood (sheet, reorder level 5, reorder quantity 20), 2 screws (box), 3 glue (tube), 4 chipboard (sheet); locations 1 Main store and 2 Bakkie 1;
  // an order for 10 sheets at R200.00 (item 1) and 5 boxes at R10.00 (item 2) of which 4 sheets and all 5 boxes have arrived (a goods receipt)
  const base = seq();
  base.do('party.create', { kind: 'organisation', name: 'Timber Supplies', roles: ['supplier'], contact: { vatNumber: '4111111111' } });
  base.do('item.create', { sku: 'PLY-18', name: 'Plywood 18mm sheet', unit: 'sheet', reorderLevelMilli: 5000, reorderQtyMilli: 20000, preferredSupplierId: 2 });
  base.do('item.create', { sku: 'SCR-50', name: 'Screws 50mm box', unit: 'box' });
  base.do('item.create', { sku: 'GLU-1', name: 'Glue tube', unit: 'tube' });
  base.do('item.create', { sku: 'CHP-16', name: 'Chipboard 16mm sheet', unit: 'sheet' });
  base.do('location.create', { name: 'Main store', kind: 'warehouse' });
  base.do('location.create', { name: 'Bakkie 1', kind: 'vehicle' });
  const po = (extra = {}) => ({ supplierId: 2, orderedOn: '2026-11-01', currency: 'ZAR', lines: [line('Plywood sheets', 10000, 20000, 'sheet'), line('Screws box', 5000, 1000, 'box')], lineItems: [{ lineNo: 1, itemId: 1 }, { lineNo: 2, itemId: 2 }], ...extra });
  const world = ext(base); world.do('purchase_order.create', po());
  const orders = async (steps, q = '?status=any') => (body(await run({ before: steps, ...get('accountant', `/engine/purchase-orders${q}`) })).result || {}).orders || [];
  const ORDER = (await orders(world.steps))[0] || {};
  world.do('goods.receive', { orderId: ORDER.id, receivedOn: '2026-11-05', lines: [{ lineNo: 1, quantityMilli: 4000 }, { lineNo: 2, quantityMilli: 5000 }] });
  const view = async (steps, id, role = 'accountant') => (body(await run({ before: steps, ...get(role, `/engine/records/document/${id}`) })).result || {});
  const GR = ((await view(world.steps, ORDER.id)).relations || []).find((x) => x.role === 'receipt');
  const RC = GR ? GR.ref.id : 0;
  const dlv = (extra = {}) => ({ receiptId: RC, locationId: 1, receivedOn: '2026-11-06', ...extra });
  const stockOf = async (steps, q = '', role = 'accountant') => (body(await run({ before: steps, ...get(role, `/engine/stock${q}`) })).result || {});
  const rowOf = (rep, itemId) => ((rep.stock || []).find((r) => r.itemId === itemId) || {});
  const reorderOf = async (steps) => (body(await run({ before: steps, ...get('accountant', '/engine/stock/reorder') })).result || {});
  const unbilled = async (steps, q = '', role = 'accountant') => (body(await run({ before: steps, ...get(role, `/engine/goods-unbilled${q}`) })).result || {});

  // ---- 1. PERMISSIONS ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  check(['owner', 'accountant', 'admin'].every((r) => has(r, 'stock.manage') && has(r, 'bill.read')), 'money roles may put a delivery into stock and read what has arrived but not been billed');
  check(['sales', 'installer'].every((r) => !has(r, 'stock.manage')), 'field staff may not put a delivery into stock (receiving into stock is a manager\'s act; they propose goods received and stock moves as before)');
  check(['stock.receive_delivery', 'goods.unbilled'].every((c) => eng.capabilities.CAPABILITY_IDS.includes(c)), 'the two new capabilities exist in the engine');

  // ---- 2. lineItems ON A PURCHASE ORDER ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  let r = await run({ before: base.steps, ...propose('accountant', 'purchase_order.create', po(), 'Order ten sheets of plywood and five boxes of screws from Timber Supplies') });
  check(status(r) === 200 && body(r).status === 'held' && touchesNoFact(r), 'an order that names the item on each line is HELD like any other');
  let v = await view(world.steps, ORDER.id);
  check(((v.collections || {}).progress || []).length === 2 && v.collections.progress[0].itemId === 1 && v.collections.progress[1].itemId === 2 && v.collections.progress[0].stockedMilli === 0, 'the order\'s record shows the item on each line and how much of it has been stocked (none yet)');
  const plain = ext(base); plain.do('purchase_order.create', po({ lineItems: undefined }));
  const pv = await view(plain.steps, ((await orders(plain.steps))[0] || {}).id); check(((pv.collections || {}).progress || []).every((l) => l.itemId === null), 'an order with no lineItems works exactly as before: each line names no item');
  const bad = [[po({ lineItems: [] }), 'an empty lineItems'], [po({ lineItems: [{ lineNo: 3, itemId: 1 }] }), 'a line number the order does not have'], [po({ lineItems: [{ lineNo: 1, itemId: 1 }, { lineNo: 1, itemId: 4 }] }), 'the same line named twice'], [po({ lineItems: [{ lineNo: 1, itemId: 1, colour: 'x' }] }), 'a field nobody declared on an entry'], [po({ lineItems: [{ lineNo: 1 }] }), 'an entry with no item'], [po({ lineItems: 'plywood' }), 'lineItems that is not a list'], [po({ lineItems: [{ lineNo: 0, itemId: 1 }] }), 'a line number of zero']];
  for (const [payload, why] of bad) { r = await run({ before: base.steps, ...propose('accountant', 'purchase_order.create', payload) }); check(status(r) === 422 && body(r).error === 'invalid_payload' && touchesNoFact(r), `${why} is refused at the door as invalid_payload`); }
  for (const [payload, code, why] of [[po({ lineItems: [{ lineNo: 1, itemId: 99 }] }), 'not_found', 'an item that does not exist'], [po({ lineItems: [{ lineNo: 1, itemId: 2 }] }), 'invalid_input', 'an item stocked in boxes on a line of sheets']]) { r = await run({ before: base.steps, ...propose('accountant', 'purchase_order.create', payload) }); check(body(r).error === code && touchesNoFact(r) && added(r, 'eng_event') === 0, `${why} is refused as ${code} (${status(r)} ${body(r).error})`); }
  const inactive = ext(base); inactive.do('item.revise', { itemId: 1, active: false }); r = await run({ before: inactive.steps, ...propose('accountant', 'purchase_order.create', po()) }); check(status(r) === 409 && body(r).error === 'invalid_state' && touchesNoFact(r), 'an inactive item cannot be named on a new order line');
  r = await run({ before: base.steps, ...propose('installer', 'purchase_order.create', po()) }); check(status(r) === 403, 'field staff still may not place an order');

  // ---- 3. RECEIVING INTO STOCK AS THE ITEM THE LINE IS FOR --------------------------------------------------------------------------------------------------------------------------------------------------------
  const one = (extra = {}) => ({ itemId: 1, locationId: 1, quantityMilli: 4000, receivedOn: '2026-11-06', receipt: { documentId: RC, lineNo: 1 }, ...extra });
  r = await run({ before: world.steps, ...propose('accountant', 'stock.receive', one()) }); check(status(r) === 200 && body(r).status === 'held', 'goods received on the plywood line can go into stock as plywood');
  r = await run({ before: world.steps, ...propose('accountant', 'stock.receive', one({ itemId: 4 })) }); check(status(r) === 422 || status(r) === 409, 'but not as chipboard, even though both are sold by the sheet: the line is for plywood');
  check(/plywood/i.test(String(body(r).message || '')) || body(r).error === 'invalid_input', 'and the refusal says which item the line is for');
  const noItems = ext(base); noItems.do('purchase_order.create', po({ lineItems: undefined })); const O2 = ((await orders(noItems.steps))[0] || {}).id; noItems.do('goods.receive', { orderId: O2, receivedOn: '2026-11-05', lines: [{ lineNo: 1, quantityMilli: 2000 }] });
  const RC2 = ((await view(noItems.steps, O2)).relations || []).find((x) => x.role === 'receipt').ref.id;
  r = await run({ before: noItems.steps, ...propose('accountant', 'stock.receive', one({ itemId: 4, quantityMilli: 2000, receipt: { documentId: RC2, lineNo: 1 } })) }); check(status(r) === 200 && body(r).status === 'held', 'a line that names no item can still be stocked as any item of the right unit (as before)');

  // ---- 4. A WHOLE DELIVERY AT ONCE ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  r = await run({ before: world.steps, ...propose('accountant', 'stock.receive_delivery', dlv(), 'The Timber Supplies delivery goes into the main store') });
  check(status(r) === 200 && body(r).status === 'held' && touchesNoFact(r) && added(r, 'eng_event') === 0, 'proposing a delivery into stock is HELD and records nothing');
  check(/105000|85000/.test(JSON.stringify(r.writes || {})) || /80000/.test(JSON.stringify(r.writes || {})), 'the approver is shown what each line is worth (plywood R800.00, screws R50.00)');
  const dp = ext(world); const did = dp.prop('stock.receive_delivery', dlv());
  r = await run({ before: dp.steps, ...confirm('accountant', did) });
  check(status(r) === 200 && added(r, 'eng_stock_move') === 2 && added(r, 'eng_event') === 3 && added(r, 'eng_money_movement') === 0 && added(r, 'eng_document') === 0, `approving it records TWO stock movements (one per line) with their events, and no money or document (${status(r)})`);
  dp.ok(did); const st = await stockOf(dp.steps);
  check(rowOf(st, 1).quantityMilli === 4000 && rowOf(st, 1).valueMinor === 80000 && rowOf(st, 2).quantityMilli === 5000 && rowOf(st, 2).valueMinor === 5000, 'the stock arrives at each line\'s cost: 4 sheets worth R800.00 and 5 boxes worth R50.00');
  const led = body(await run({ before: dp.steps, ...get('accountant', '/engine/stock/ledger?itemId=1') })).result || {};
  check(led.moves[0].sourceDocumentId === RC && led.moves[0].sourceLineNo === 1 && led.moves[0].explained && led.moves[0].explained.contract === 'stock.receive_delivery' && led.moves[0].explained.approvedBy === 'accountant@example.com', 'each movement points at the goods receipt line it came from and is explained under the delivery contract');
  v = await view(dp.steps, ORDER.id);
  check(v.collections.progress[0].stockedMilli === 4000 && v.collections.progress[1].stockedMilli === 5000, 'the order now shows how much of each line has been put into stock (4 of 10 sheets, 5 of 5 boxes)');
  r = await run({ before: dp.steps, ...propose('accountant', 'stock.receive_delivery', dlv()) }); check(status(r) === 409 && body(r).error === 'invalid_state' && /nothing|already/i.test(String(body(r).message || '')) && touchesNoFact(r), 'putting the same delivery into stock twice is refused: nothing is left to put in');
  const part = ext(world); part.do('stock.receive', one({ quantityMilli: 1000 })); part.do('stock.receive_delivery', dlv());
  check(rowOf(await stockOf(part.steps), 1).quantityMilli === 4000 && rowOf(await stockOf(part.steps), 2).quantityMilli === 5000, 'if one sheet was already stocked by hand, the delivery puts in the remaining 3 (never more than the receipt brought in): 4 in all');
  const sub = ext(world); sub.do('stock.receive_delivery', dlv({ lines: [{ lineNo: 2, quantityMilli: 2000 }] })); check(rowOf(await stockOf(sub.steps), 2).quantityMilli === 2000 && rowOf(await stockOf(sub.steps), 1).quantityMilli === 0, 'a delivery can name just some lines and quantities (2 of the 5 boxes only)');
  for (const [payload, code, why] of [[dlv({ lines: [{ lineNo: 1, quantityMilli: 4001 }] }), 'invalid_state', 'more than the line brought in'], [dlv({ lines: [{ lineNo: 9, quantityMilli: 1 }] }), 'invalid_input', 'a goods receipt line it does not have'], [dlv({ lines: [{ lineNo: 1, quantityMilli: 1 }, { lineNo: 1, quantityMilli: 2 }] }), 'invalid_payload', 'the same line twice'], [dlv({ locationId: 99 }), 'not_found', 'a location that does not exist'], [dlv({ receiptId: 99999 }), 'not_found', 'a goods receipt that does not exist'], [dlv({ receiptId: ORDER.id }), 'invalid_state', 'a document that is not a goods receipt (the order)'], [dlv({ receivedOn: '2026-11-04' }), 'invalid_input', 'stock put in before the goods arrived'], [dlv({ receivedOn: 'soon' }), 'invalid_payload', 'a date that is not a date'], [dlv({ colour: 'x' }), 'invalid_payload', 'a field nobody declared'], [{}, 'invalid_payload', 'nothing at all']]) { r = await run({ before: world.steps, ...propose('accountant', 'stock.receive_delivery', payload) }); check(body(r).error === code && touchesNoFact(r) && added(r, 'eng_event') === 0, `${why} is refused at the door as ${code} (${status(r)} ${body(r).error})`); }
  const RC3 = ((await view(noItems.steps, O2)).relations || []).find((x) => x.role === 'receipt').ref.id; r = await run({ before: noItems.steps, ...propose('accountant', 'stock.receive_delivery', dlv({ receiptId: RC3 })) }); check(status(r) === 409 && body(r).error === 'invalid_state' && /item/i.test(String(body(r).message || '')) && touchesNoFact(r), 'a delivery whose lines name no item cannot be put into stock this way (it says no line names an item)');
  r = await run({ before: noItems.steps, ...propose('accountant', 'stock.receive_delivery', dlv({ receiptId: RC3, lines: [{ lineNo: 1, quantityMilli: 1000 }] })) }); check(status(r) === 409 && body(r).error === 'invalid_state' && /Line 1 of that goods receipt names no item/.test(String(body(r).message || '')), 'naming a line whose order line has no item is refused for THAT line, and the message says so (not quietly skipped)');
  for (const role of ['sales', 'installer']) { r = await run({ before: world.steps, ...propose(role, 'stock.receive_delivery', dlv()) }); check(status(r) === 403 && touchesNoFact(r), `${role} may not put a delivery into stock`); }
  r = await kit.route({ env: ENV, seed: kit.seedReceivables(kit.ALL_CAPABILITIES), ...propose('accountant', 'stock.receive_delivery', dlv()) }); check(status(r) === 409 && body(r).error === 'capability_unavailable', 'a business without the capability is told so');
  r = await run({ before: [...dp.steps, confirm('accountant', did)], ...confirm('accountant', did) }); check(status(r) !== 200 && added(r, 'eng_stock_move') === 0, 'approving the same proposal twice never stocks twice');
  const race = ext(world); const a1 = race.prop('stock.receive_delivery', dlv()); const a2 = race.prop('stock.receive_delivery', dlv()); race.ok(a1);
  r = await run({ before: race.steps, ...confirm('accountant', a2) }); check(status(r) === 409 && added(r, 'eng_stock_move') === 0, 'two people putting the same delivery into stock: the second approval is refused, so a receipt line can never be over-stocked');

  // ---- 5. STOCK ON ORDER COUNTS TOWARDS A REORDER ---------------------------------------------------------------------------------------------------------------------------------------------------------------
  let ro = await reorderOf(dp.steps);
  check((ro.suggestions || []).length === 0 && (ro.notes || []).every((n) => !/not subtracted|NOT subtracted/.test(n)), 'plywood is at 4 sheets (level 5) but 6 more are still on order: it is NOT suggested, and the read no longer says that stock on order is ignored');
  const closed = ext(dp); closed.do('purchase_order.cancel', { orderId: ORDER.id, reason: 'The supplier cannot deliver the rest', cancelledOn: '2026-11-07' }); ro = await reorderOf(closed.steps); const s1 = (ro.suggestions || [])[0] || {};
  check(ro.count === 1 && s1.itemId === 1 && s1.availableMilli === 4000 && s1.onOrderMilli === 0 && s1.positionMilli === 4000 && s1.suggestedQtyMilli === 20000, 'once the rest of the order is cancelled nothing is on order, and plywood IS suggested (4 available, 0 on order, reorder 20)');
  const openOrder = await reorderOf(world.steps); check((openOrder.suggestions || []).length === 0 && (await stockOf(world.steps)).stock.length === 4, 'before any of the delivery is stocked, 0 are on hand but 10 are on order less the 4 received: 6 on order, so the position is 6 and plywood is still not suggested');
  const none = ext(base); ro = await reorderOf(none.steps); s1.x = 0; check(ro.suggestions.some((x) => x.itemId === 1 && x.onOrderMilli === 0 && x.positionMilli === 0), 'with nothing on hand and nothing on order plywood is suggested with its on-order and position shown (0 and 0)');
  const second = ext(world); second.do('purchase_order.create', po({ orderedOn: '2026-11-08', lineItems: [{ lineNo: 1, itemId: 1 }, { lineNo: 2, itemId: 2 }] })); ro = await reorderOf(second.steps);
  check(ro.suggestions.every((x) => x.itemId !== 1), 'a second open order for plywood adds to what is on order');

  // ---- 6. GOODS RECEIVED NOT INVOICED ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  let g = await unbilled(world.steps); const gl = g.lines || [];
  check(g.count === 2 && gl.length === 2 && g.totalValueMinor === 85000 && gl[0].orderId === ORDER.id && gl[0].supplierName === 'Timber Supplies' && gl[0].lineNo === 1 && gl[0].receivedMilli === 4000 && gl[0].billedMilli === 0 && gl[0].unbilledMilli === 4000 && gl[0].unitPriceMinor === 20000 && gl[0].valueMinor === 80000 && gl[1].valueMinor === 5000, 'what has arrived and not been billed: 4 sheets (R800.00) and 5 boxes (R50.00) from Timber Supplies, R850.00 in all');
  const billed = ext(world); billed.do('supplier_invoice.record', { supplierId: 2, invoicedOn: '2026-11-06', currency: 'ZAR', supplierInvoiceNumber: 'INV-1', orderId: ORDER.id, category: 'materials', taxInvoiceHeld: true, lines: [{ orderLineNo: 1, description: 'Plywood sheets', quantityMilli: 4000, unit: 'sheet', unitPriceMinor: 20000, taxBp: 1500 }] });
  g = await unbilled(billed.steps); check(g.count === 1 && g.lines[0].lineNo === 2 && g.totalValueMinor === 5000, 'once the plywood is billed only the screws are still unbilled (R50.00)');
  const allBilled = ext(billed); allBilled.do('supplier_invoice.record', { supplierId: 2, invoicedOn: '2026-11-06', currency: 'ZAR', supplierInvoiceNumber: 'INV-2', orderId: ORDER.id, category: 'materials', taxInvoiceHeld: true, lines: [{ orderLineNo: 2, description: 'Screws box', quantityMilli: 5000, unit: 'box', unitPriceMinor: 1000, taxBp: 1500 }] });
  g = await unbilled(allBilled.steps); check(g.count === 0 && g.totalValueMinor === 0, 'once everything that arrived has been billed, nothing is unbilled');
  const cx = ext(world); cx.do('purchase_order.cancel', { orderId: ORDER.id, reason: 'x', cancelledOn: '2026-11-07' }); g = await unbilled(cx.steps); check(g.count === 2, 'goods that arrived are still unbilled even if the rest of the order was cancelled (the supplier will still invoice them)');
  const none2 = await unbilled(base.steps); check(none2.count === 0 && none2.totalValueMinor === 0, 'with nothing received there is nothing unbilled');
  g = await unbilled(world.steps, '?supplierId=2'); check(g.count === 2, 'finding by supplier works'); g = await unbilled(world.steps, '?supplierId=1'); check(g.count === 0, 'and a supplier with nothing unbilled returns nothing');
  r = await run({ before: world.steps, ...get('accountant', '/engine/goods-unbilled?supplierId=abc') }); check(status(r) === 422, 'a supplier number that is not a number is refused as invalid');
  r = await run({ before: world.steps, ...get('installer', '/engine/goods-unbilled') }); check(has('installer', 'bill.read') ? status(r) === 200 : status(r) === 403, 'an installer reads it only with the supplier-balances capability');
  r = await kit.route({ env: ENV, seed: kit.seedReceivables(kit.ALL_CAPABILITIES), ...get('accountant', '/engine/goods-unbilled') }); check(status(r) === 409 && body(r).error === 'capability_unavailable', 'a business without the capability is told so');

  // ---- 7. THE FOUNDATIONS STILL HOLD -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const { facts, verifyIntegrity } = eng; const CTX = { actorEmail: 'accountant@example.com', contract: 'test', contractVersion: 1 };
  const mk = async () => { const w = kit.makeWorld(); w.configure({ mode: 'engine', available: AV }); const sup = (await facts.recordParty(w.env, { kind: 'organisation', name: 'T', roles: ['supplier'] }, CTX)).id; const item = (await facts.createItem(w.env, { sku: 'A-1', name: 'Alpha', unit: 'sheet' }, CTX)).itemId; const item2 = (await facts.createItem(w.env, { sku: 'A-2', name: 'Beta', unit: 'sheet' }, CTX)).itemId; const loc = (await facts.createLocation(w.env, { name: 'Store', kind: 'warehouse' }, CTX)).locationId;
    const order = await facts.recordPurchaseOrder(w.env, { supplierId: sup, orderedOn: '2026-11-01', currency: 'ZAR', lines: [{ description: 'Alpha', quantityMilli: 10000, unit: 'sheet', unitPriceMinor: 100, taxBp: 1500 }], lineItems: [{ lineNo: 1, itemId: item }] }, CTX); const gr = await facts.receiveGoods(w.env, { orderId: order.documentId, receivedOn: '2026-11-05', lines: [{ lineNo: 1, quantityMilli: 6000 }] }, CTX); return { w, sup, item, item2, loc, order, gr }; };
  const X = await mk(); const dl = await facts.receiveDelivery(X.w.env, { receiptId: X.gr.documentId, locationId: X.loc, receivedOn: '2026-11-06' }, CTX);
  check(dl.moveIds.length === 1, 'the fact layer puts a delivery into stock too (one movement for its one line)');
  let integ = await verifyIntegrity(X.w.env); check(integ.ok === true && integ.problems.length === 0 && integ.warnings.length === 0, 'the integrity verifier is clean after an order that names its items, a receipt and a delivery into stock');
  const Y = await mk(); const yd = await facts.receiveDelivery(Y.w.env, { receiptId: Y.gr.documentId, locationId: Y.loc, receivedOn: '2026-11-06' }, CTX);
  Y.w.db.prepare('UPDATE eng_stock_move SET item_id = ? WHERE id = ?').run(Y.item2, yd.moveIds[0]); Y.w.db.prepare("UPDATE eng_event SET payload_json = json_set(payload_json, '$.itemId', ?) WHERE id = (SELECT event_id FROM eng_stock_move WHERE id = ?)").run(Y.item2, yd.moveIds[0]);
  integ = await verifyIntegrity(Y.w.env); check(integ.ok === false && integ.problems.some((p) => p.code === 'stock_invariant' && /different item/.test(p.detail)), 'stock taken in from a goods receipt line as a DIFFERENT item than the order line names is REPORTED by the verifier (the row and its event both edited, so only the chain rule notices)');
  const rowOf2 = (db, id) => JSON.stringify([db.prepare('SELECT * FROM eng_document WHERE id = ?').get(id), db.prepare('SELECT * FROM eng_document_line WHERE document_id = ? ORDER BY id').all(id)]);
  const K = await mk(); const kb = rowOf2(K.w.db, K.order.documentId); await facts.receiveDelivery(K.w.env, { receiptId: K.gr.documentId, locationId: K.loc, receivedOn: '2026-11-06' }, CTX); check(rowOf2(K.w.db, K.order.documentId) === kb, 'the order and its lines are byte-for-byte what they were after the delivery went into stock: nothing is edited, the link is a new fact');
  const atomic = async (label, prep, act) => { const p0 = await prep(); p0.w.resetWrites(); await act(p0); const writes = p0.w.writeCount(); const leaked = [];
    for (let n = 1; n <= writes; n++) { const q = await prep(); const was = JSON.stringify(q.w.counts()); q.w.failAt(n); let threw = false; try { await act(q); } catch { threw = true; } if (!threw || JSON.stringify(q.w.counts()) !== was) leaked.push(n); }
    check(writes >= 2 && leaked.length === 0, `${label} is atomic: a failure at each of its ${writes} writes leaves nothing behind` + (leaked.length ? ' (leaked at ' + leaked.join(',') + ')' : '')); };
  await atomic('placing an order that names its items', async () => { const w = kit.makeWorld(); w.configure({ mode: 'engine', available: AV }); const sup = (await facts.recordParty(w.env, { kind: 'organisation', name: 'T', roles: ['supplier'] }, CTX)).id; const item = (await facts.createItem(w.env, { sku: 'A-1', name: 'Alpha', unit: 'sheet' }, CTX)).itemId; return { w, sup, item }; }, (q) => facts.recordPurchaseOrder(q.w.env, { supplierId: q.sup, orderedOn: '2026-11-01', currency: 'ZAR', lines: [{ description: 'Alpha', quantityMilli: 1000, unit: 'sheet', unitPriceMinor: 100, taxBp: 1500 }], lineItems: [{ lineNo: 1, itemId: q.item }] }, CTX));
  await atomic('putting a delivery into stock', async () => { const q = await mk(); return q; }, (q) => facts.receiveDelivery(q.w.env, { receiptId: q.gr.documentId, locationId: q.loc, receivedOn: '2026-11-06' }, CTX));
  const wn = await mk(); const was = JSON.stringify(wn.w.counts()); const codes = [];
  for (const fn of [() => facts.receiveDelivery(wn.w.env, { receiptId: wn.gr.documentId, locationId: 99, receivedOn: '2026-11-06' }, CTX), () => facts.receiveDelivery(wn.w.env, { receiptId: 424242, locationId: wn.loc, receivedOn: '2026-11-06' }, CTX), () => facts.recordPurchaseOrder(wn.w.env, { supplierId: wn.sup, orderedOn: '2026-11-01', currency: 'ZAR', lines: [{ description: 'x', quantityMilli: 1000, unit: 'sheet', unitPriceMinor: 100, taxBp: 1500 }], lineItems: [{ lineNo: 1, itemId: 99999 }] }, CTX)]) { try { await fn(); codes.push('none'); } catch (e) { codes.push(e && e.code); } }
  check(codes.every((c) => c && c !== 'none') && JSON.stringify(wn.w.counts()) === was, `the fact layer itself refuses a delivery to an unknown location, an unknown receipt and an order naming an unknown item, and writes nothing (${codes.join(', ')})`);
});

if (require.main === module) kit.standalone(module.exports);
