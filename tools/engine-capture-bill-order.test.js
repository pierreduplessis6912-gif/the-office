// A SUPPLIER BILL PHOTO IS LINKED TO ITS PURCHASE ORDER (docs/decisions/engine-capture-bill-order.md). TESTS FIRST; expected state when first committed: RED.
// The model supplies ONE more word: OUR purchase order number, as a plain whole number, only if the bill shows it. The ENGINE finds the order (that supplier's, not cancelled), matches each bill line to an order line by its
// description, and the match is worked out by the engine's own three-way match. Nothing is guessed: no number, or a number that is not that supplier's order, holds the bill WITHOUT an order and says so.
const kit = require('./engine-kit.js');

module.exports = kit.guard('engine capture bill order', async ({ check }) => {
  const ENV_A = { BUSINESS_ID: 'eng-a', ENGINE_REHEARSAL: '1' };
  const SEED = { admin: true, method: 'POST', path: '/admin/engine/provision-sample', body: { confirm: 'eng-a' } };
  const call = (capability, args) => JSON.stringify({ capability, arguments: args });
  const seen = (text) => ({ match: /Describe exactly what is shown/, raw: true, reply: { choices: [{ message: { content: text } }] } });
  const prop = (capability, payload) => ({ method: 'POST', path: '/engine/proposals', role: 'accountant', body: { capability, payload, transcript: 'seed' } });
  const confirm = (id) => ({ method: 'POST', path: `/actions/${id}/confirm`, role: 'accountant', body: {} });
  const WORLD = []; let n = 0; const seed = (c, p) => { WORLD.push(prop(c, p), confirm(++n)); };
  const line = (description, quantityMilli, unit, unitPriceMinor) => ({ description, quantityMilli, unit, unitPriceMinor, taxBp: 1500 });
  seed('party.create', { kind: 'organisation', name: 'Timber Supplies', roles: ['supplier'], contact: { vatNumber: '4111111111' } });   // party 3
  seed('party.create', { kind: 'organisation', name: 'Hardware Hub', roles: ['supplier'] });                                           // party 4
  seed('purchase_order.create', { supplierId: 3, orderedOn: '2026-10-02', currency: 'ZAR', lines: [line('Plywood 18mm', 10000, 'sheet', 20000), line('Screws 50mm', 5000, 'box', 1000)] });   // order number 1
  seed('purchase_order.create', { supplierId: 4, orderedOn: '2026-10-02', currency: 'ZAR', lines: [line('Plywood 18mm', 1000, 'sheet', 20000)] });                                          // order number 2 (Hardware Hub's)
  seed('purchase_order.create', { supplierId: 3, orderedOn: '2026-10-02', currency: 'ZAR', lines: [line('Hinges', 2000, 'each', 500), line('Hinges', 3000, 'each', 500)] });             // order number 3 (two lines with the same words)
  seed('purchase_order.create', { supplierId: 3, orderedOn: '2026-10-02', currency: 'ZAR', lines: [line('Plywood 18mm', 1000, 'sheet', 20000)] });   // order number 4 (document 6: cancelled in the last case; nothing received on it)
  const BILL = 'TAX INVOICE. Timber Supplies. Invoice INV-9001 dated 2026-10-02. Your order 1. Plywood 18mm 4 sheets at R200.00 excl VAT.';
  const good = (over = {}) => ({ supplier: 'Timber Supplies', invoiceNumber: 'INV-9001', invoicedOn: '2026-10-02', category: 'materials', taxInvoice: true, vat: 'plus_vat', orderNumber: 1, lines: [{ description: 'Plywood 18mm', quantity: 4, unit: 'sheet', unitPriceCents: 20000 }], ...over });
  const ai = (over) => [seen(BILL), { match: /READ FROM A PHOTOGRAPH[\s\S]*INV-9001/, reply: () => call('supplier_invoice.record', good(over)) }];
  const pic = (extra = {}) => ({ photo: { name: 'b.jpg', type: 'image/jpeg', text: 'JPEG' }, intent: 'supplier_bill', ...extra });
  const send = (over, opts = {}) => kit.route({ env: ENV_A, ai: ai(over), before: [SEED, ...WORLD, ...(opts.before || [])], method: 'POST', path: '/engine/capture/photo', form: pic(opts.form || {}), role: 'accountant' });
  const status = (r) => r.result && r.result.status, body = (r) => (r.result && r.result.body) || {};
  const added = (r, t) => ((r.writes && r.writes[t] && r.writes[t].added) || []);
  const held = (r) => added(r, 'pending_actions');
  const payload = (r) => String((held(r)[0] || {}).payload_json || (held(r)[0] || {}).payload || '');
  const money = (r) => added(r, 'eng_event').length + added(r, 'eng_document').length + added(r, 'eng_money_movement').length;

  // nothing received yet
  let r = await send({});
  const orderId = (payload(r).match(/"orderId":(\d+)/) || [])[1];
  check(status(r) === 200 && body(r).status === 'held' && !!orderId, `a bill that shows our order number is HELD and linked to that order (got ${status(r)} ${JSON.stringify(body(r)).slice(0, 120)} payload ${payload(r).slice(0, 160)})`);
  check(/"orderLineNo":1/.test(payload(r)) && money(r) === 0 && held(r).length === 1, 'the bill line is matched to the order line with the same description (line 1), and nothing is recorded as money');
  check(/"status":"variance"/.test(payload(r)) && /quantity/.test(payload(r)), 'the engine\'s own three-way match flags a bill for goods not yet received (quantity variance): the approver sees it');

  // goods received in full: matched
  WORLD.push(prop('goods.receive', { orderId: Number(orderId), receivedOn: '2026-10-03', lines: [{ lineNo: 1, quantityMilli: 10000 }, { lineNo: 2, quantityMilli: 5000 }] }), confirm(++n));
  r = await send({});
  check(status(r) === 200 && /"status":"matched"/.test(payload(r)) && /"orderLineNo":1/.test(payload(r)), `after the goods are received, the same bill matches (got ${status(r)} ${payload(r).slice(0, 200)})`);
  r = await send({ lines: [{ description: 'Plywood 18mm', quantity: 4, unit: 'sheet', unitPriceCents: 21000 }] });
  check(status(r) === 200 && /"status":"variance"/.test(payload(r)) && /price/.test(payload(r)), 'a bill price different from the order is a variance the approver sees');

  // lines that do not match an order line are not forced onto one
  r = await send({ lines: [{ description: 'Plywood 18mm', quantity: 4, unit: 'sheet', unitPriceCents: 20000 }, { description: 'Delivery fee', quantity: 1, unitPriceCents: 5000 }] });
  check(status(r) === 200 && /"orderLineNo":1/.test(payload(r)) && /not_on_order/.test(payload(r)), 'a line that is not on the order is left unlinked and shown as not on the order');
  r = await send({ lines: [{ description: 'plywood  18MM', quantity: 4, unit: 'sheet', unitPriceCents: 20000 }] });
  check(status(r) === 200 && /"orderLineNo":1/.test(payload(r)), 'description matching ignores case and extra spaces');
  r = await send({ orderNumber: 3, lines: [{ description: 'Hinges', quantity: 1, unit: 'each', unitPriceCents: 500 }] });
  check(status(r) === 200 && !/"orderLineNo":\d/.test(payload(r)), 'when two order lines have the same words, the bill line is NOT guessed onto either');

  // no link, honestly
  r = await send({ orderNumber: undefined });
  check(status(r) === 200 && body(r).status === 'held' && !/"orderId"/.test(payload(r)) && /"status":"no_order"/.test(payload(r)), 'a bill that shows no order number is held with no order, as before');
  r = await send({ orderNumber: 99 });
  check(status(r) === 200 && body(r).status === 'held' && !/"orderId"/.test(payload(r)) && /order/i.test(String(body(r).message)) && /99/.test(String(body(r).message)), `an order number that is not found: held WITHOUT an order, and the answer says so (got ${JSON.stringify(body(r)).slice(0, 200)})`);
  r = await send({ orderNumber: 2 });
  check(status(r) === 200 && !/"orderId"/.test(payload(r)) && /order/i.test(String(body(r).message)), 'another supplier\'s order number is never linked: held without an order, and the answer says so');

  // rails
  for (const [v, why] of [[0, 'zero'], [-1, 'a negative number'], [1.5, 'a fraction'], ['PO-1', 'text'], [1000000000000, 'an absurd number'], [null, 'null'], [true, 'a boolean']]) {
    r = await send({ orderNumber: v });
    check(status(r) === 422 && held(r).length === 0 && money(r) === 0 && added(r, 'captures').length === 1, `an order number that is ${why} is not understood, nothing held, the file kept (got ${status(r)})`);
  }
  // a cancelled order is not linked
  r = await send({ orderNumber: 4 }, { before: [{ ...prop('purchase_order.cancel', { orderId: 6, reason: 'test', cancelledOn: '2026-10-03' }), role: 'owner' }, { ...confirm(++n), role: 'owner' }] });
  check(status(r) === 200 && !/"orderId"/.test(payload(r)) && /order/i.test(String(body(r).message)), `a cancelled order is not linked: held without an order, and the answer says so (got ${status(r)} ${JSON.stringify(body(r)).slice(0, 160)})`);
  r = await send({ orderNumber: 4 });
  check(status(r) === 200 && /"orderId":6/.test(payload(r)), 'the same order, not cancelled, IS linked (the cancel is what changed it)');
});

if (require.main === module) kit.standalone(module.exports);
