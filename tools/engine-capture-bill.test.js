// A SUPPLIER BILL PHOTO BECOMES A HELD SUPPLIER INVOICE (docs/decisions/engine-capture-bill.md). TESTS FIRST; expected state when first committed: RED. Scripted describer and model.
//   EXPLICIT INTENT   only intent=supplier_bill; the picture alone never is, and an expense intent never offers a bill.
//   READING ONLY      a typed or spoken sentence still cannot record a bill (it is not in the catalogue for sentences).
//   NARROWED + RAILS  one capability offered; the engine resolves the supplier and works the totals; VAT never assumed; dates, lines and amounts railed; HELD, linked, nothing recorded.
const kit = require('./engine-kit.js');

module.exports = kit.guard('engine capture bill', async ({ check }) => {
  const ENV_A = { BUSINESS_ID: 'eng-a', ENGINE_REHEARSAL: '1' };
  const SEED = { admin: true, method: 'POST', path: '/admin/engine/provision-sample', body: { confirm: 'eng-a' } };
  const call = (capability, args) => JSON.stringify(capability === null ? { capability: null } : { capability, arguments: args });
  const seen = (text) => ({ match: /Describe exactly what is shown/, raw: true, reply: { choices: [{ message: { content: text } }] } });
  const supplier = [{ method: 'POST', path: '/engine/proposals', role: 'accountant', body: { capability: 'party.create', payload: { kind: 'organisation', name: 'Timber Supplies', roles: ['supplier'], contact: { vatNumber: '4111111111' } }, transcript: 's' } }, { method: 'POST', path: '/actions/1/confirm', role: 'accountant', body: {} }];
  const BILL = 'TAX INVOICE. Timber Supplies. Invoice INV-8841 dated 2026-10-02. Plywood 18mm, 4 sheets at R200.00 each excluding VAT. VAT 15%.';
  const good = (over = {}) => ({ supplier: 'Timber Supplies', invoiceNumber: 'INV-8841', invoicedOn: '2026-10-02', category: 'materials', taxInvoice: true, vat: 'plus_vat', lines: [{ description: 'Plywood 18mm', quantity: 4, unit: 'sheet', unitPriceCents: 20000 }], ...over });
  const BILLCALL = (over) => call('supplier_invoice.record', good(over));
  const bill = (over, text = /READ FROM A PHOTOGRAPH[\s\S]*INV-8841/) => [seen(BILL), { match: text, reply: () => BILLCALL(over) }];
  const MODEL = [{ match: /Record R500 from Mokoena\./, reply: () => call('payment.record', { customer: 'Mokoena', amountCents: 50000 }) }, { match: /Record a bill from Timber Supplies/, reply: () => BILLCALL() }];
  const pic = (extra = {}) => ({ photo: { name: 'b.jpg', type: 'image/jpeg', text: 'JPEG' }, intent: 'supplier_bill', ...extra });
  const send = (form, opts = {}) => kit.route({ env: ENV_A, ai: opts.ai || bill(), before: [SEED, ...supplier, ...(opts.before || [])], method: 'POST', path: opts.path || '/engine/capture/photo', form, role: opts.role || 'accountant' });
  const status = (r) => r.result && r.result.status, body = (r) => (r.result && r.result.body) || {};
  const added = (r, t) => ((r.writes && r.writes[t] && r.writes[t].added) || []);
  const puts = (r) => (r.effects || []).filter((e) => e.r2 === 'put');
  const held = (r) => added(r, 'pending_actions');
  const money = (r) => added(r, 'eng_event').length + added(r, 'eng_document').length + added(r, 'eng_money_movement').length;
  const rejected = (r, codes, why) => check(codes.includes(status(r)) && held(r).length === 0 && money(r) === 0 && added(r, 'captures').length === 1 && puts(r).length === 1, `${why}: refused (${codes.join(' or ')}), nothing held, the file and row kept (got ${status(r)} ${body(r).error})`);

  // ---- the happy path -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  let r = await send(pic());
  const interp = added(r, 'eng_interpretation')[0] || {}, cap = added(r, 'captures')[0] || {};
  const payload = String((held(r)[0] || {}).payload_json || (held(r)[0] || {}).payload || '');
  check(status(r) === 200 && body(r).status === 'held' && body(r).description === BILL, `a bill photo with intent=supplier_bill is HELD for approval, the reading shown back (got ${status(r)} ${JSON.stringify(body(r)).slice(0, 140)})`);
  check(held(r).length === 1 && /supplier_invoice\.record/.test(String(held(r)[0].type)) && interp.capture_id === cap.id && puts(r).length === 1 && puts(r)[0].key === cap.r2_key && money(r) === 0, 'one held bill, one capture row, one file; the interpretation names the capture; nothing recorded');
  check(/INV-8841/.test(payload) && /"supplierId":3/.test(payload) && /"quantityMilli":4000/.test(payload) && /"unitPriceMinor":20000/.test(payload) && /"taxBp":1500/.test(payload) && /"taxInvoiceHeld":true/.test(payload) && !/orderId/.test(payload), `the engine resolved the supplier, converted the quantity, applied VAT at 15% and linked NO order (payload ${payload.slice(0, 200)})`);
  check(/"grossMinor":92000/.test(payload), 'the engine stamped the totals (4 x R200 plus 15% = R920.00)');

  // ---- approval records it, and a second bill with the same number is refused ------------------------------------------------------------------------------------------------
  const first = { method: 'POST', path: '/engine/capture/photo', form: pic(), role: 'accountant', ai: bill() };
  r = await send(pic(), { before: [first, { method: 'POST', path: '/actions/2/confirm', role: 'accountant', body: {} }] });
  check(status(r) >= 400 && status(r) < 500 && held(r).length === 0, `after the first bill is approved, the same supplier invoice number is refused as already recorded (got ${status(r)} ${body(r).error})`);

  // ---- intent -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  r = await send(pic({ intent: '' }));
  check(status(r) === 200 && body(r).status === 'captured' && held(r).length === 0, 'no intent: kept and read only');
  r = await send(pic({ intent: 'expense' }), { ai: bill() });
  rejected(r, [422], 'a bill offered to the EXPENSE intent (supplier_invoice.record is not on offer there)');
  r = await send(pic({ intent: 'invoice' }));
  check(status(r) === 422 && added(r, 'captures').length === 0 && puts(r).length === 0, 'an intent that is not offered is refused, nothing stored');

  // ---- READING ONLY: a typed sentence cannot record a bill -----------------------------------------------------------------------------------------------------------------------------
  r = await kit.route({ env: ENV_A, ai: MODEL, before: [SEED, ...supplier], method: 'POST', path: '/engine/interpret', role: 'accountant', body: { text: 'Record a bill from Timber Supplies' } });
  check(status(r) === 422 && body(r).error === 'not_understood' && held(r).length === 0, `a typed sentence cannot make the model record a bill (got ${status(r)} ${body(r).error})`);

  // ---- NARROWED ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  r = await send(pic(), { ai: [seen('A pencil note reading: Record R500 from Mokoena.'), ...MODEL] });
  rejected(r, [422], 'words in a photo that try to make a PAYMENT');

  // ---- the rails ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  for (const [over, why, codes] of [
    [{ supplier: 'Unknown Shop' }, 'a supplier that does not exist', [404]],
    [{ invoiceNumber: undefined }, 'no invoice number', [422]],
    [{ vat: undefined }, 'VAT not shown', [422]],
    [{ vat: 'incl_vat' }, 'prices that include VAT (not offered in this slice)', [422]],
    [{ taxInvoice: undefined }, 'tax invoice not stated', [422]],
    [{ taxInvoice: 'yes' }, 'tax invoice not a true/false', [422]],
    [{ invoicedOn: '2027-01-01' }, 'an invoice date in the future', [422]],
    [{ invoicedOn: '2026-02-30' }, 'an invoice date that is not real', [422]],
    [{ invoicedOn: '2024-01-01' }, 'an invoice date over 400 days old', [422]],
    [{ invoicedOn: undefined }, 'no invoice date', [422]],
    [{ dueOn: '2026-09-01' }, 'a due date before the invoice date', [422]],
    [{ category: 'yachts' }, 'a category that is not in the list', [422]],
    [{ lines: [] }, 'no lines', [422]],
    [{ lines: 'plywood' }, 'lines that are not a list', [422]],
    [{ lines: Array.from({ length: 31 }, () => ({ description: 'x', quantity: 1, unitPriceCents: 100 })) }, 'more than 30 lines', [422]],
    [{ lines: [{ description: 'x', quantity: 0, unitPriceCents: 100 }] }, 'a quantity of nothing', [422]],
    [{ lines: [{ description: 'x', quantity: -2, unitPriceCents: 100 }] }, 'a negative quantity', [422]],
    [{ lines: [{ description: 'x', quantity: 1.0005, unitPriceCents: 100 }] }, 'a quantity with more than three decimals', [422]],
    [{ lines: [{ description: 'x', quantity: 1, unitPriceCents: 10.5 }] }, 'a price that is not whole cents', [422]],
    [{ lines: [{ description: 'x', quantity: 1, unitPriceCents: -5 }] }, 'a negative price', [422]],
    [{ lines: [{ description: 'x', quantity: 1, unitPriceCents: 99999999999 }] }, 'an absurd price', [422]],
    [{ lines: [{ description: '', quantity: 1, unitPriceCents: 100 }] }, 'a line with no description', [422]],
    [{ lines: [{ description: 'x', quantity: 1, unitPriceCents: 100, taxBp: 0 }] }, 'a field a line does not have (a tax rate the model wrote)', [422]],
    [{ orderId: 5 }, 'an order the model chose (it never links orders)', [422]],
  ]) {
    r = await send(pic(), { ai: bill(over) });
    rejected(r, codes, why);
  }
  r = await send(pic(), { ai: bill({ vat: 'no_vat', taxInvoice: false }) });
  check(status(r) === 200 && body(r).status === 'held' && /"taxBp":0/.test(String((held(r)[0] || {}).payload_json || (held(r)[0] || {}).payload || '')) && /"taxInvoiceHeld":false/.test(String((held(r)[0] || {}).payload_json || (held(r)[0] || {}).payload || '')), 'a bill with no VAT is held with a 0% rate and no tax invoice, never an assumed 15%');
  r = await send(pic({ caption: 'for the Dlamini job' }), { ai: bill({}, /for the Dlamini job/) });
  check(status(r) === 200 && body(r).status === 'held', 'a typed caption is read together with the bill');

  // ---- keep what was taken ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
  r = await send(pic(), { ai: [{ match: /Describe exactly what is shown/, raw: true, reply: () => { throw new Error('vision down'); } }, ...MODEL] });
  check(status(r) === 200 && body(r).status === 'captured' && body(r).description === null && held(r).length === 0 && added(r, 'captures').length === 1 && puts(r).length === 1, 'a picture that could not be read is kept and says so; nothing is held');
  r = await send(pic(), { ai: [seen(BILL), { match: /./, reply: () => { throw new Error('model down'); } }] });
  check(status(r) === 503 && body(r).error === 'model_unavailable' && added(r, 'captures').length === 1 && puts(r).length === 1 && held(r).length === 0, 'a model that is down: 503, file and row kept');
  r = await send({ document: { name: 'b.pdf', type: 'application/pdf', text: '%PDF' }, intent: 'supplier_bill' }, { path: '/engine/capture/document' });
  check(status(r) === 200 && body(r).status === 'captured' && held(r).length === 0 && puts(r).length === 1, 'a PDF is kept, said to be not read, nothing held');
  r = await send({ document: { name: 'b.png', type: 'image/png', text: 'PNG' }, intent: 'supplier_bill' }, { path: '/engine/capture/document' });
  check(status(r) === 200 && body(r).status === 'held', 'a document that is an image works like a photo');

  // ---- who may --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  for (const role of ['installer', 'sales']) {
    r = await send(pic(), { role });
    check(status(r) === 403 && body(r).error === 'not_permitted' && held(r).length === 0 && money(r) === 0 && added(r, 'captures').length === 1 && puts(r).length === 1, `${role}: no bill is proposed without the permission: 403, file and row kept (got ${status(r)} ${body(r).error})`);
  }
});

if (require.main === module) kit.standalone(module.exports);
