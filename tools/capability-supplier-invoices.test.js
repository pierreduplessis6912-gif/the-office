// Supplier invoices, the three-way match, supplier payment and the bill's input tax (branch engine-phase1; second half of Procurement, docs/decisions/supplier-invoices.md). TESTS FIRST. Evidence label for every check: TEST of the engine on the route harness
// (NOT staging, NOT production). Expected state when first committed: RED. In short: a bill is a supplier_invoice document (a payable) recorded by a held write with the supplier's invoice number; with an order it is MATCHED against what was ordered and what was
// RECEIVED (price, tax rate, quantity billed beyond received, lines not on the order are variances; strict, no tolerance) and the result is shown on approval; a bill with an unaccepted variance is recorded but cannot be paid; payment is a money-out movement allocated
// in full to the supplier's payable bills (no overpayment); a bill can be voided only when nothing is allocated and its input tax is not in a locked period; and its input tax follows the expense rules and feeds fields 14 and 15 of the VAT summary.
const kit = require('./engine-kit.js');

module.exports = kit.guard('supplier invoices', async ({ check }) => {
  const eng = kit.loadEngine();
  check(Boolean(eng && eng.permissions && eng.capabilities && eng.facts && eng.bills && eng.purchasing), 'the engine exposes permissions, capabilities, facts and the bills and purchasing modules');
  if (!eng || !eng.permissions || !eng.bills) return;
  const auth = kit.bundle('auth.ts', 'auth');
  const member = (role) => ({ email: `${role}@example.com`, caps: auth.ROLE_CAPABILITIES[role] || [] });
  const AV = [...kit.ALL_CAPABILITIES, 'party.create', 'business.profile.set', 'tax_lock.set', 'purchase_order.create', 'goods.receive', 'purchase_orders.find', 'supplier_invoice.record', 'supplier_invoice.void', 'supplier_payment.record', 'supplier_invoices.find', 'vat.summary', 'allocation.remove', 'expense.record'];
  const ENV = { BUSINESS_ID: 'eng-a' };
  const run = (spec) => kit.route({ env: ENV, seed: kit.seedReceivables(AV), ...spec });
  const propose = (role, capability, payload, transcript = 'a sentence from the person') => ({ method: 'POST', path: '/engine/proposals', role, body: { capability, payload, transcript } });
  const confirm = (role, id = 1) => ({ method: 'POST', path: `/actions/${id}/confirm`, role, body: {} });
  const get = (role, path) => ({ method: 'GET', path, role });
  const added = (res, t) => ((res.writes && res.writes[t] && res.writes[t].added) || []).length;
  const body = (res) => (res.result && res.result.body) || {};
  const status = (res) => res.result && res.result.status;
  const FACTS = ['eng_party', 'eng_party_role', 'eng_document', 'eng_document_line', 'eng_document_number', 'eng_money_movement', 'eng_allocation', 'eng_reversal'];
  const touchesNoFact = (res) => FACTS.every((t) => added(res, t) === 0);
  const fieldOf = (v, k) => ((v.fields || []).find((f) => f.key === k) || {}).value;
  const seq = () => { let n = 0; const steps = []; const api = { steps,
    prop(cap, payload, role = 'accountant') { n += 1; steps.push(propose(role, cap, payload, `(${cap})`)); return n; },
    ok(id, role = 'accountant') { steps.push(confirm(role, id)); return api; },
    setN(k) { n = k; },
    do(cap, payload, role = 'accountant') { const id = api.prop(cap, payload, role); api.ok(id, role); return id; } }; return api; };
  const ext = (src) => { const q = seq(); q.steps.push(...src.steps); q.setN(src.steps.filter((x) => x.method === 'POST' && x.path === '/engine/proposals').length); return q; };
  const has = (role, p) => eng.permissions.permissionsFor(member(role).caps).has(p);
  const profile = { legalName: 'Zululand Flooring and Blinds (Pty) Ltd', address: '5 Industrial Road, Empangeni', vatRegistered: true, vatNumber: '4123456789' };
  const line = (description, quantityMilli, unitPriceMinor, taxBp = 1500) => ({ description, quantityMilli, unit: 'u', unitPriceMinor, taxBp });
  // the world: the business is VAT registered (1), Timber Supplies (party 2, a vendor) and Corner Spaza (party 3, not) are suppliers, an order for 10 sheets at R200.00 and 5 boxes at R10.00 is placed with Timber (4), and 4 sheets and all 5 boxes arrive (5)
  const world = seq();
  world.do('business.profile.set', profile, 'owner');
  world.do('party.create', { kind: 'organisation', name: 'Timber Supplies', roles: ['supplier'], contact: { vatNumber: '4111111111' } });
  world.do('party.create', { kind: 'person', name: 'Corner Spaza', roles: ['supplier'] });
  world.do('purchase_order.create', { supplierId: 2, orderedOn: '2026-11-01', currency: 'ZAR', lines: [line('Plywood sheets', 10000, 20000), line('Screws box', 5000, 1000)] });
  const ORDER = 4;   // the order is the document after the two sample invoices (1, 2)... resolved from the engine below
  const orderId = (((body(await run({ before: world.steps, ...get('accountant', '/engine/purchase-orders') })).result || {}).orders || [])[0] || {}).id;
  world.do('goods.receive', { orderId, receivedOn: '2026-11-05', lines: [{ lineNo: 1, quantityMilli: 4000 }, { lineNo: 2, quantityMilli: 5000 }] });
  const mline = (no, d, q, p, bp = 1500) => ({ orderLineNo: no, ...line(d, q, p, bp) });
  const bill = (extra = {}) => ({ supplierId: 2, invoicedOn: '2026-11-06', dueOn: '2026-12-06', currency: 'ZAR', supplierInvoiceNumber: 'INV-100', orderId, category: 'materials', taxInvoiceHeld: true, lines: [mline(1, 'Plywood sheets', 4000, 20000), mline(2, 'Screws box', 5000, 1000)], ...extra });   // net R850.00, tax R127.50, total R977.50
  const one = ext(world); one.do('supplier_invoice.record', bill());
  const bills = (role = 'accountant', q = '') => get(role, `/engine/supplier-invoices${q}`);
  const list = async (steps, q = '', role = 'accountant') => (body(await run({ before: steps, ...bills(role, q) })).result || {});
  const view = async (steps, id, role = 'accountant') => (body(await run({ before: steps, ...get(role, `/engine/records/document/${id}`) })).result || {});
  const B1 = ((await list(one.steps, '?status=any')).bills || [])[0] || {};

  // ---- 1. PERMISSIONS ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  check(['owner', 'accountant', 'admin'].every((r) => has(r, 'bill.manage') && has(r, 'bill.read') && has(r, 'supplier_payment.record')), 'owner, accountant and admin may record, void, read and pay bills');
  check(['sales', 'installer'].every((r) => !has(r, 'bill.manage') && !has(r, 'supplier_payment.record')), 'a salesperson and an installer may neither enter nor pay a bill');
  check(['supplier_invoice.record', 'supplier_invoice.void', 'supplier_payment.record', 'supplier_invoices.find'].every((c) => eng.capabilities.CAPABILITY_IDS.includes(c)), 'the four capabilities exist in the engine');

  // ---- 2. RECORD: held first, a payable, the match shown --------------------------------------------------------------------------------------------------------------------------------------------------------------
  let r = await run({ before: world.steps, ...propose('accountant', 'supplier_invoice.record', bill(), 'Timber Supplies invoice INV-100 for what we received') });
  check(status(r) === 200 && body(r).status === 'held' && touchesNoFact(r) && added(r, 'eng_event') === 0, `proposing a bill is HELD and records nothing (${status(r)} ${body(r).status})`);
  check(JSON.stringify(r.writes || {}).includes('97750') && JSON.stringify(r.writes || {}).includes('matched'), 'the approval is shown the exact total (R977.50) AND the match result (matched), worked out by the engine');
  const prop = ext(world); const pid = prop.prop('supplier_invoice.record', bill());
  r = await run({ before: prop.steps, ...confirm('accountant', pid) });
  check(status(r) === 200 && added(r, 'eng_document') === 1 && added(r, 'eng_document_line') === 2 && added(r, 'eng_document_number') === 1 && added(r, 'eng_money_movement') === 0 && added(r, 'eng_allocation') === 0 && added(r, 'eng_event') === 3, `approving it records ONE bill with its lines and number, no money and no allocation, and the supplier_invoice.recorded event (3 events with the execution; ${status(r)})`);
  check(B1.number === 1 && B1.supplierId === 2 && B1.supplierName === 'Timber Supplies' && B1.supplierInvoiceNumber === 'INV-100' && B1.status === 'unpaid' && B1.matchStatus === 'matched' && B1.payable === true && B1.netMinor === 85000 && B1.taxMinor === 12750 && B1.grossMinor === 97750 && B1.outstandingMinor === 97750 && B1.dueOn === '2026-12-06' && B1.orderId === orderId && B1.ref && B1.ref.kind === 'document', 'finding lists it: number 1, Timber Supplies, INV-100, unpaid, matched and payable, R977.50 owed, due 6 December, against the order');
  let v = await view(one.steps, B1.id);
  check(v.title === 'Supplier invoice #1' && fieldOf(v, 'status') === 'unpaid' && fieldOf(v, 'supplier') === 'Timber Supplies' && fieldOf(v, 'supplierInvoiceNumber') === 'INV-100' && fieldOf(v, 'matchStatus') === 'matched' && fieldOf(v, 'payable') === true && fieldOf(v, 'outstandingMinor') === 97750 && (v.relations || []).some((x) => x.role === 'bills_order' && x.ref.id === orderId), 'the record opens as Supplier invoice #1 with its status, match, payable flag, what is owed, and a link to its order');
  check(((v.collections || {}).match || []).length === 2 && v.collections.match.every((m) => (m.variances || []).length === 0), 'with the match shown line by line and no variance on any');
  const rec = (v.history || []).find((h) => h.type === 'supplier_invoice.recorded') || {};
  check(rec.contract === 'supplier_invoice.record' && rec.approvedBy === 'accountant@example.com' && Number.isInteger(rec.captureId) && Number.isInteger(rec.interpretationId) && Number.isInteger(rec.proposalId), 'it is EXPLAINED: what was said, what was understood, which proposal, who approved it and under which contract');
  r = await run({ before: one.steps, ...get('accountant', '/engine/receivables?party=Mokoena') });
  check((body(r).result || {}).totalMinor === 138000, 'a bill touches no customer\'s account');
  const noOrder = ext(world); noOrder.do('supplier_invoice.record', bill({ orderId: undefined, supplierInvoiceNumber: 'SVC-1', lines: [line('Delivery', 1000, 5000)] }));
  const nb = ((await list(noOrder.steps, '?status=any')).bills || [])[0] || {};
  check(nb.matchStatus === 'no_order' && nb.payable === true && nb.orderId === null, 'a bill with no order is allowed (services, ad-hoc purchases): no_order, payable');

  // ---- 3. THE MATCH: variances ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const variance = async (extra, label, kind) => {
    const w = ext(world); w.do('supplier_invoice.record', bill({ supplierInvoiceNumber: 'V-1', ...extra }));
    const b = ((await list(w.steps, '?status=any')).bills || [])[0] || {};
    const vv = await view(w.steps, b.id);
    check(b.matchStatus === 'variance' && b.payable === false && ((vv.collections || {}).match || []).some((m) => (m.variances || []).includes(kind)), `${label}: matchStatus variance, NOT payable, and the line says ${kind}`);
    return { w, b };
  };
  await variance({ lines: [mline(1, 'Plywood sheets', 4000, 20100), mline(2, 'Screws box', 5000, 1000)] }, 'a price different from the order\'s', 'price');
  await variance({ lines: [mline(1, 'Plywood sheets', 4001, 20000), mline(2, 'Screws box', 5000, 1000)] }, 'billing more than has been received', 'quantity');
  await variance({ lines: [mline(1, 'Plywood sheets', 4000, 20000), mline(2, 'Screws box', 5000, 1000), line('Freight', 1000, 5000)] }, 'a line that is not on the order', 'not_on_order');
  await variance({ lines: [mline(1, 'Plywood sheets', 4000, 20000, 0), mline(2, 'Screws box', 5000, 1000)] }, 'a different tax rate from the order\'s', 'tax_rate');
  const twice = ext(one); twice.do('supplier_invoice.record', bill({ supplierInvoiceNumber: 'INV-101', lines: [mline(1, 'Plywood sheets', 1000, 20000)] }));
  const tb = ((await list(twice.steps, '?status=any')).bills || []).find((x) => x.supplierInvoiceNumber === 'INV-101') || {};
  check(tb.matchStatus === 'variance' && tb.payable === false, 'a SECOND bill for plywood when the first already billed everything received is a quantity variance (received 4, already billed 4, billing 1 more)');
  const acc = ext(world); acc.do('supplier_invoice.record', bill({ supplierInvoiceNumber: 'V-2', varianceAccepted: true, lines: [mline(1, 'Plywood sheets', 4000, 20100), mline(2, 'Screws box', 5000, 1000)] }));
  const ab = ((await list(acc.steps, '?status=any')).bills || [])[0] || {};
  check(ab.matchStatus === 'variance' && ab.varianceAccepted === true && ab.payable === true, 'the same bill with varianceAccepted is still a variance, but it is accepted (a recorded, approved decision) and payable');
  r = await run({ before: world.steps, ...propose('accountant', 'supplier_invoice.record', bill({ lines: [mline(1, 'Plywood sheets', 4000, 20100), mline(2, 'Screws box', 5000, 1000)] })) });
  check(status(r) === 200 && body(r).status === 'held' && JSON.stringify(r.writes || {}).includes('variance'), 'a bill with a variance can still be PROPOSED: the approver is shown the variance');

  // ---- 4. RECORD refusals ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const bad = [
    [bill({ colour: 'blue' }), 'a field nobody declared'], [bill({ supplierInvoiceNumber: undefined }), 'no supplier invoice number'], [bill({ supplierInvoiceNumber: '  ' }), 'a blank invoice number'], [bill({ supplierInvoiceNumber: 'x'.repeat(61) }), 'an invoice number over 60 characters'],
    [bill({ category: 'groceries' }), 'a category that is not on the list'], [bill({ taxInvoiceHeld: 'yes' }), 'taxInvoiceHeld that is not true or false'], [bill({ varianceAccepted: 'yes' }), 'varianceAccepted that is not true or false'], [bill({ capital: 'yes' }), 'capital that is not true or false'],
    [bill({ lines: [] }), 'no lines'], [bill({ lines: [{ orderLineNo: 1, description: 'x', quantityMilli: 1000, unitPriceMinor: 100 }] }), 'a line with no tax rate (VAT is never assumed)'], [bill({ lines: [mline(1, 'x', 0, 100)] }), 'a quantity of zero'], [bill({ lines: [mline(0, 'x', 1000, 100)] }), 'an order line number of zero'],
    [bill({ invoicedOn: '2026-02-30' }), 'a date that does not exist'], [bill({ dueOn: '2026-11-01' }), 'a due date before the invoice date'], [bill({ currency: 'rand' }), 'a currency that is not a code'], [bill({ supplierId: 'two' }), 'a supplier number that is text'], [null, 'no payload at all'],
  ];
  for (const [payload, why] of bad) { r = await run({ before: world.steps, ...propose('accountant', 'supplier_invoice.record', payload) }); check(status(r) === 422 && body(r).error === 'invalid_payload' && touchesNoFact(r), `${why} is refused at the door as invalid_payload (${status(r)} ${body(r).error}) and records nothing`); }
  const rules = [
    [bill({ supplierId: 99 }), 'not_found', 'a supplier that does not exist'], [bill({ supplierId: 1 }), 'invalid_state', 'a party that is only a customer'], [bill({ orderId: 99999 }), 'not_found', 'an order that does not exist'], [bill({ orderId: 1 }), 'invalid_state', 'a document that is not an order (invoice 1)'],
    [bill({ supplierId: 3 }), 'invalid_state', 'an order that is with another supplier'], [bill({ lines: [mline(9, 'x', 1000, 100)] }), 'invalid_input', 'a line the order does not have'],
  ];
  for (const [payload, code, why] of rules) { r = await run({ before: world.steps, ...propose('accountant', 'supplier_invoice.record', payload) }); check(body(r).error === code && touchesNoFact(r) && added(r, 'eng_event') === 0, `${why} is refused at the door as ${code} (${status(r)} ${body(r).error}) and records nothing`); }
  r = await run({ before: one.steps, ...propose('accountant', 'supplier_invoice.record', bill({ invoicedOn: '2026-11-07' })) }); check(status(r) === 409 && body(r).error === 'duplicate' && touchesNoFact(r), 'the same supplier invoice number from the same supplier twice is refused as DUPLICATE');
  r = await run({ before: world.steps, ...propose('accountant', 'supplier_invoice.record', bill({ supplierId: 3, orderId: undefined, supplierInvoiceNumber: 'INV-100', lines: [line('Sweets', 1000, 500, 0)] })) }); check(status(r) === 200 && body(r).status === 'held', 'the same number from a DIFFERENT supplier is fine');
  for (const role of ['sales', 'installer']) { r = await run({ before: world.steps, ...propose(role, 'supplier_invoice.record', bill()) }); check(status(r) === 403 && touchesNoFact(r), `${role} may not propose a bill: refused 403`); }
  r = await kit.route({ env: ENV, seed: kit.seedReceivables(kit.ALL_CAPABILITIES), ...propose('accountant', 'supplier_invoice.record', bill()) }); check(status(r) === 409 && body(r).error === 'capability_unavailable' && touchesNoFact(r), 'a business without the capability is told so');
  r = await run({ before: [...prop.steps, confirm('accountant', pid)], ...confirm('accountant', pid) }); check(status(r) !== 200 && added(r, 'eng_document') === 0, 'approving the same proposal twice never records a second bill');
  const dupRace = ext(world); const d1 = dupRace.prop('supplier_invoice.record', bill()); const d2 = dupRace.prop('supplier_invoice.record', bill({ invoicedOn: '2026-11-07' })); dupRace.ok(d1);
  r = await run({ before: dupRace.steps, ...confirm('accountant', d2) }); check(status(r) === 409 && body(r).error === 'duplicate' && added(r, 'eng_document') === 0, 'a duplicate that slipped in between the proposal and the approval is caught AT the approval');
  const drift = ext(world); const g1 = drift.prop('supplier_invoice.record', bill({ supplierInvoiceNumber: 'A-1' })); const g2 = drift.prop('supplier_invoice.record', bill({ supplierInvoiceNumber: 'A-2' })); drift.ok(g1);
  r = await run({ before: drift.steps, ...confirm('accountant', g2) }); check(status(r) === 200 && added(r, 'eng_document') === 1, 'a second bill proposed as matched is re-matched at the approval: it is recorded, and now reads as a quantity variance (everything received was already billed)');
  const drifted = ext(drift); drifted.ok(g2); const dl = ((await list(drifted.steps, '?status=any')).bills || []).find((x) => x.supplierInvoiceNumber === 'A-2') || {};
  check(dl.matchStatus === 'variance' && dl.payable === false, 'and it is NOT payable: the match at the time of recording is what counts, never what the proposal said');

  // ---- 5. SUPPLIER PAYMENT --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const pay = (extra = {}) => ({ supplierId: 2, amountMinor: 50000, currency: 'ZAR', paidOn: '2026-11-10', method: 'eft', allocations: [{ billId: B1.id, amountMinor: 50000 }], ...extra });
  r = await run({ before: one.steps, ...propose('accountant', 'supplier_payment.record', pay(), 'Pay Timber Supplies R500 towards invoice INV-100') });
  check(status(r) === 200 && body(r).status === 'held' && touchesNoFact(r) && added(r, 'eng_event') === 0, 'proposing a supplier payment is HELD and records nothing');
  const pp = ext(one); const payId = pp.prop('supplier_payment.record', pay());
  r = await run({ before: pp.steps, ...confirm('accountant', payId) });
  check(status(r) === 200 && added(r, 'eng_money_movement') === 1 && added(r, 'eng_allocation') === 1 && added(r, 'eng_document') === 0, `approving it records ONE money-out movement and ONE allocation to the bill (${status(r)})`);
  pp.ok(payId);
  let b = ((await list(pp.steps, '?status=any')).bills || [])[0] || {};
  check(b.status === 'part_paid' && b.outstandingMinor === 47750, 'the bill is part_paid with R477.50 still owed');
  const full = ext(pp); full.do('supplier_payment.record', pay({ amountMinor: 47750, allocations: [{ billId: B1.id, amountMinor: 47750 }] }));
  b = ((await list(full.steps, '?status=any')).bills || [])[0] || {};
  check(b.status === 'paid' && b.outstandingMinor === 0, 'paying the rest makes it paid');
  check(((await list(full.steps)).bills || []).length === 0, 'and a paid bill leaves the default (unpaid) list');
  const oldest = ext(one); oldest.do('supplier_payment.record', { supplierId: 2, amountMinor: 97750, currency: 'ZAR', paidOn: '2026-11-10', method: 'eft', allocate: 'oldest_first' });
  check((((await list(oldest.steps, '?status=any')).bills || [])[0] || {}).status === 'paid', 'oldest_first pays the supplier\'s payable bills in order');
  const payRules = [
    [pay({ amountMinor: 97751, allocations: [{ billId: B1.id, amountMinor: 97751 }] }), 'invalid_state', 'more than the bill owes'], [pay({ amountMinor: 40000 }), 'invalid_input', 'allocations that do not add up to the amount paid'],
    [pay({ allocations: [{ billId: 99999, amountMinor: 50000 }] }), 'not_found', 'a bill that does not exist'], [pay({ allocations: [{ billId: 1, amountMinor: 50000 }] }), 'invalid_state', 'something that is not a bill (invoice 1)'],
    [pay({ supplierId: 3 }), 'invalid_state', 'a bill that belongs to another supplier'], [pay({ paidOn: '2026-11-05' }), 'invalid_input', 'a payment dated before the bill'], [pay({ supplierId: 1 }), 'invalid_state', 'a party that is only a customer'],
  ];
  for (const [payload, code, why] of payRules) { r = await run({ before: one.steps, ...propose('accountant', 'supplier_payment.record', payload) }); check(body(r).error === code && touchesNoFact(r) && added(r, 'eng_event') === 0, `${why} is refused at the door as ${code} (${status(r)} ${body(r).error}) and records nothing`); }
  for (const [payload, why] of [[pay({ amountMinor: 0 }), 'an amount of zero'], [pay({ method: 'barter' }), 'a method nobody declared'], [pay({ paidOn: 'soon' }), 'a date that is not a date'], [pay({ colour: 'x' }), 'a field nobody declared'], [pay({ allocations: [] }), 'no allocations and no oldest_first'], [pay({ allocate: 'oldest_first' }), 'both named allocations and oldest_first'], [pay({ allocations: [{ billId: B1.id, amountMinor: 0 }] }), 'an allocation of zero'], [pay({ allocations: [{ billId: B1.id, amountMinor: 25000 }, { billId: B1.id, amountMinor: 25000 }] }), 'the same bill twice']]) {
    r = await run({ before: one.steps, ...propose('accountant', 'supplier_payment.record', payload) }); check(status(r) === 422 && body(r).error === 'invalid_payload' && touchesNoFact(r), `${why} is refused as invalid_payload`); }
  const varBill = await variance({ lines: [mline(1, 'Plywood sheets', 4000, 20100), mline(2, 'Screws box', 5000, 1000)] }, 'set-up (payment): a price variance', 'price');
  r = await run({ before: varBill.w.steps, ...propose('accountant', 'supplier_payment.record', pay({ allocations: [{ billId: varBill.b.id, amountMinor: 10000 }], amountMinor: 10000 })) });
  check(status(r) === 409 && body(r).error === 'invalid_state' && /variance/i.test(String(body(r).message || '')) && touchesNoFact(r), 'a bill with an unaccepted variance cannot be paid: refused, and the message says why');
  const skip = ext(varBill.w); skip.do('supplier_invoice.record', bill({ orderId: undefined, supplierInvoiceNumber: 'P-1', lines: [line('Delivery', 1000, 5000)] }));
  skip.do('supplier_payment.record', { supplierId: 2, amountMinor: 5750, currency: 'ZAR', paidOn: '2026-11-10', method: 'eft', allocate: 'oldest_first' });
  const sk = (await list(skip.steps, '?status=any')).bills || []; const skPaid = sk.find((x) => x.supplierInvoiceNumber === 'P-1') || {}, skVar = sk.find((x) => x.supplierInvoiceNumber === 'V-1') || {};
  check(skPaid.status === 'paid' && skVar.status === 'unpaid', 'oldest_first SKIPS a bill with an unaccepted variance and pays the payable one: the older variance bill is untouched');
  r = await run({ before: acc.steps, ...propose('accountant', 'supplier_payment.record', pay({ allocations: [{ billId: ab.id, amountMinor: 10000 }], amountMinor: 10000 })) }); check(status(r) === 200 && body(r).status === 'held', 'but once the variance has been accepted it can be paid');
  r = await run({ before: noOrder.steps, ...propose('accountant', 'supplier_payment.record', pay({ allocations: [{ billId: nb.id, amountMinor: 5750 }], amountMinor: 5750 })) }); check(status(r) === 200 && body(r).status === 'held', 'and a bill with no order can be paid');
  for (const role of ['sales', 'installer']) { r = await run({ before: one.steps, ...propose(role, 'supplier_payment.record', pay()) }); check(status(r) === 403 && touchesNoFact(r), `${role} may not pay a supplier`); }
  r = await kit.route({ env: ENV, seed: kit.seedReceivables(kit.ALL_CAPABILITIES), ...propose('accountant', 'supplier_payment.record', pay()) }); check(status(r) === 409 && body(r).error === 'capability_unavailable', 'a business without the capability is told so');
  const over = ext(one); const o1 = over.prop('supplier_payment.record', pay({ amountMinor: 97750, allocations: [{ billId: B1.id, amountMinor: 97750 }] })); const o2 = over.prop('supplier_payment.record', pay({ amountMinor: 97750, allocations: [{ billId: B1.id, amountMinor: 97750 }] })); over.ok(o1);
  r = await run({ before: over.steps, ...confirm('accountant', o2) }); check(status(r) === 409 && added(r, 'eng_money_movement') === 0, 'the same bill cannot be paid twice: the second approval is refused once nothing is owed');
  const unalloc = ext(pp); unalloc.do('allocation.remove', { allocationId: 1, reason: 'paid the wrong bill' });
  b = ((await list(unalloc.steps, '?status=any')).bills || [])[0] || {};
  check(b.status === 'unpaid' && b.outstandingMinor === 97750, 'removing the allocation (the existing undo) puts the full amount owing back');

  // ---- 6. VOID ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const vd = (extra = {}) => ({ billId: B1.id, reason: 'Entered against the wrong supplier', voidedOn: '2026-11-12', ...extra });
  r = await run({ before: one.steps, ...propose('accountant', 'supplier_invoice.void', vd()) }); check(status(r) === 200 && body(r).status === 'held' && touchesNoFact(r), 'proposing a void is HELD and records nothing');
  const vo = ext(one); const vId = vo.prop('supplier_invoice.void', vd());
  r = await run({ before: vo.steps, ...confirm('accountant', vId) });
  check(status(r) === 200 && added(r, 'eng_reversal') === 1 && added(r, 'eng_document') === 0, `approving it records ONE reversal of the bill and adds no document (${status(r)})`);
  vo.ok(vId);
  check(((await list(vo.steps)).bills || []).length === 0 && ((await list(vo.steps, '?status=voided')).bills || []).length === 1, 'a voided bill leaves the default list and is found under status=voided');
  const vv = await view(vo.steps, B1.id); check(fieldOf(vv, 'status') === 'voided' && (vv.history || []).some((h) => h.type === 'supplier_invoice.voided' && h.contract === 'supplier_invoice.void' && h.approvedBy === 'accountant@example.com'), 'its record says voided and the void is explained');
  const again = ext(vo); again.do('supplier_invoice.record', bill({ supplierInvoiceNumber: 'INV-100' }));
  check(((await list(again.steps)).bills || []).length === 1, 'after a void the same invoice number can be recorded again');
  r = await run({ before: vo.steps, ...propose('accountant', 'supplier_invoice.void', vd()) }); check(status(r) === 409 && body(r).error === 'invalid_state' && touchesNoFact(r), 'voiding one that is already voided is refused');
  r = await run({ before: pp.steps, ...propose('accountant', 'supplier_invoice.void', vd()) }); check(status(r) === 409 && body(r).error === 'invalid_state' && /allocat|payment/i.test(String(body(r).message || '')) && touchesNoFact(r), 'a bill with a payment allocated cannot be voided: refused, and the message says why');
  r = await run({ before: unalloc.steps, ...propose('accountant', 'supplier_invoice.void', vd()) }); check(status(r) === 200 && body(r).status === 'held', 'but once the allocation has been removed it can be');
  for (const [payload, why] of [[vd({ reason: '' }), 'no reason'], [vd({ reason: 'x'.repeat(201) }), 'a reason over 200 characters'], [vd({ voidedOn: 'someday' }), 'a date that is not a date'], [vd({ colour: 'x' }), 'a field nobody declared'], [{}, 'nothing at all']]) { r = await run({ before: one.steps, ...propose('accountant', 'supplier_invoice.void', payload) }); check(status(r) === 422 && body(r).error === 'invalid_payload' && touchesNoFact(r), `${why} is refused as invalid_payload`); }
  r = await run({ before: one.steps, ...propose('accountant', 'supplier_invoice.void', vd({ billId: 99999 })) }); check(status(r) === 404, 'voiding one that does not exist is refused as not_found');
  r = await run({ before: one.steps, ...propose('accountant', 'supplier_invoice.void', vd({ billId: 1 })) }); check(status(r) === 409 && body(r).error === 'invalid_state', 'voiding something that is not a bill (invoice 1) is refused');
  for (const role of ['sales', 'installer']) { r = await run({ before: one.steps, ...propose(role, 'supplier_invoice.void', vd()) }); check(status(r) === 403, `${role} may not void a bill`); }
  const lk = ext(one); lk.do('tax_lock.set', { lockDate: '2026-11-30' }, 'owner');
  r = await run({ before: lk.steps, ...propose('accountant', 'supplier_invoice.void', vd({ voidedOn: '2026-12-02' })) }); check(status(r) === 409 && body(r).error === 'period_locked' && touchesNoFact(r), 'a bill whose claimed input tax is in a locked period cannot be voided');
  const nt = ext(world); nt.do('supplier_invoice.record', bill({ supplierId: 3, orderId: undefined, supplierInvoiceNumber: 'N-1', taxInvoiceHeld: false, lines: [line('Sweets', 1000, 500, 0)] })); nt.do('tax_lock.set', { lockDate: '2026-11-30' }, 'owner');
  const nbill = ((await list(nt.steps, '?status=any')).bills || [])[0] || {};
  r = await run({ before: nt.steps, ...propose('accountant', 'supplier_invoice.void', vd({ billId: nbill.id, voidedOn: '2026-12-02' })) }); check(status(r) === 200 && body(r).status === 'held', 'but a bill with no claimable input tax can be voided even in a locked period');

  // ---- 7. INPUT TAX AND THE VAT SUMMARY ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  check(B1.inputTaxClaimable === true && B1.inputTaxMinor === 12750 && B1.claimDate === '2026-11-06' && (B1.inputTaxReasons || []).length === 0, 'the bill\'s input tax is derived as claimable (R127.50, a vendor, a tax invoice, a VAT registered business), claimed on the invoice date');
  check(fieldOf(v, 'inputTaxClaimable') === true && fieldOf(v, 'inputTaxMinor') === 12750 && fieldOf(v, 'claimDate') === '2026-11-06', 'and its record says so');
  const vat = (q) => get('accountant', `/engine/vat${q}`);
  r = await run({ before: one.steps, ...vat('?from=2026-11-01&to=2026-11-30') }); let vs = body(r).result || {};
  check(vs.field15Minor === 12750 && vs.inputTaxMinor === 12750, 'the VAT summary for November now includes the bill: other goods R127.50 (field 15)');
  const cap = ext(world); cap.do('supplier_invoice.record', bill({ supplierInvoiceNumber: 'CAP-1', capital: true, category: 'tools', orderId: undefined, lines: [line('Table saw', 1000, 100000)] }));
  r = await run({ before: cap.steps, ...vat('?from=2026-11-01&to=2026-11-30') }); check((body(r).result || {}).field14Minor === 15000, 'a capital bill goes to field 14 (R150.00)');
  const claims = async (extra, why, regex) => { const w = ext(world); w.do('supplier_invoice.record', bill({ orderId: undefined, supplierInvoiceNumber: 'C-1', lines: [line('Thing', 1000, 10000)], ...extra })); const x = ((await list(w.steps, '?status=any')).bills || [])[0] || {}; check(x.inputTaxClaimable === false && regex.test((x.inputTaxReasons || []).join(' ')), `${why}: not claimable, and the reason says so`); const s = body(await run({ before: w.steps, ...vat('?from=2026-11-01&to=2026-11-30') })).result || {}; return s; };
  let sx = await claims({ category: 'entertainment' }, 'a denied category (entertainment)', /17\(2\)|denied/i); check(sx.inputTaxMinor === 0 && (sx.inputExcluded || []).length === 1 && sx.inputExcluded[0].taxMinor === 1500, 'and it is listed in the VAT summary among the bills whose tax was not claimed');
  await claims({ taxInvoiceHeld: false }, 'no tax invoice held (above R50)', /tax invoice/i);
  const spaza = ext(world); spaza.do('supplier_invoice.record', bill({ supplierId: 3, orderId: undefined, supplierInvoiceNumber: 'S-1', lines: [line('Thing', 1000, 10000)] }));
  const sp = ((await list(spaza.steps, '?status=any')).bills || [])[0] || {}; check(sp.inputTaxClaimable === false && /VAT number|vendor/i.test((sp.inputTaxReasons || []).join(' ')), 'a supplier with no VAT number on record: not claimable, and the reason says so');
  r = await run({ before: vo.steps, ...vat('?from=2026-11-01&to=2026-11-30') }); check((body(r).result || {}).inputTaxMinor === 0, 'a voided bill no longer counts');
  r = await run({ before: pp.steps, ...vat('?from=2026-11-01&to=2026-11-30') }); check((body(r).result || {}).inputTaxMinor === 12750, 'paying a bill does not move its input tax (the claim is fixed when it is recorded)');
  const late = ext(one); late.do('tax_lock.set', { lockDate: '2026-11-30' }, 'owner'); late.do('supplier_invoice.record', bill({ supplierInvoiceNumber: 'LATE-1', invoicedOn: '2026-11-20', orderId: undefined, lines: [line('Late', 1000, 10000)] }));
  r = await run({ before: late.steps, ...vat('?from=2026-12-01&to=2026-12-31') }); check((body(r).result || {}).field15Minor === 1500, 'a bill dated in a locked period is recorded and claimed in the first open one (1 December)');
  r = await run({ before: late.steps, ...vat('?from=2026-11-01&to=2026-11-30') }); check((body(r).result || {}).inputTaxMinor === 12750, 'and the locked month\'s figure does not move');
  const both = ext(one); both.do('expense.record', { supplierId: 2, incurredOn: '2026-11-08', method: 'eft', category: 'fuel', currency: 'ZAR', amountsIncludeTax: true, lines: [{ description: 'Diesel', amountMinor: 11500, taxBp: 1500 }], amountPaidMinor: 11500, taxInvoiceHeld: true });
  r = await run({ before: both.steps, ...vat('?from=2026-11-01&to=2026-11-30') }); check((body(r).result || {}).field15Minor === 14250, 'a paid expense and a bill both feed the same input side (R127.50 + R15.00)');
  check((body(r).result.notes || []).some((n) => /bill/i.test(n) && /expense/i.test(n)), 'and the summary\'s note now says input tax covers expenses AND bills');

  // ---- 8. THE FOUNDATIONS STILL HOLD ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const { facts, verifyIntegrity, EVENT_MODEL } = eng; const CTX = { actorEmail: 'accountant@example.com', contract: 'test', contractVersion: 1 };
  check(['supplier_invoice.recorded', 'supplier_invoice.voided', 'supplier_payment.recorded'].every((t) => EVENT_MODEL[t] && EVENT_MODEL[t].creates === null), 'the event model knows the three new events and says they create no fact row of their own');
  const mk = async () => { const w = kit.makeWorld(); w.configure({ mode: 'engine', available: AV }); await facts.setBusinessProfile(w.env, profile, CTX); const s = (await facts.recordParty(w.env, { kind: 'organisation', name: 'Timber', roles: ['supplier'], contact: { vatNumber: '4111111111' } }, CTX)).id; return { w, s }; };
  const input = (s) => ({ supplierId: s, invoicedOn: '2026-11-06', currency: 'ZAR', supplierInvoiceNumber: 'F-1', category: 'materials', taxInvoiceHeld: true, lines: [line('Boards', 1000, 100000)] });
  const x = await mk(); const br = await facts.recordSupplierInvoice(x.w.env, input(x.s), CTX);
  const pr = await facts.recordSupplierPayment(x.w.env, { supplierId: x.s, amountMinor: 40000, currency: 'ZAR', paidOn: '2026-11-10', method: 'eft', allocations: [{ billId: br.documentId, amountMinor: 40000 }] }, CTX);
  let integ = await verifyIntegrity(x.w.env);
  check(integ.ok === true && integ.problems.length === 0 && integ.warnings.length === 0, 'the integrity verifier is clean after a bill and a part payment, with no warning about an unmodelled event');
  x.w.db.prepare("INSERT INTO eng_event (type, payload_json) VALUES ('supplier_invoice.recorded', ?)").run(JSON.stringify({ documentId: 7777, supplierId: x.s, category: 'materials', taxInvoiceHeld: true, claimDate: '2026-11-06' }));
  integ = await verifyIntegrity(x.w.env); check(integ.ok === false && integ.problems.some((p) => p.code === 'orphan' && /7777/.test(p.detail) && /does not exist/.test(p.detail)), 'a bill event that points at a document that does not exist is REPORTED (orphan)');
  const y = await mk(); const yb = await facts.recordSupplierInvoice(y.w.env, input(y.s), CTX); const yp = await facts.recordSupplierPayment(y.w.env, { supplierId: y.s, amountMinor: 40000, currency: 'ZAR', paidOn: '2026-11-10', method: 'eft', allocations: [{ billId: yb.documentId, amountMinor: 40000 }] }, CTX);
  y.w.db.prepare("INSERT INTO eng_event (type, payload_json) VALUES ('supplier_payment.recorded', ?)").run(JSON.stringify({ movementId: yp.movementId, supplierId: y.s, paidOn: '2026-11-10', method: 'eft', allocations: [{ billId: yb.documentId, amountMinor: 1 }] }));
  integ = await verifyIntegrity(y.w.env); check(integ.problems.some((p) => /does not add up|do not add up|movement/i.test(p.detail)), 'a supplier payment whose allocations do not add up to its money-out movement is REPORTED');
  const z = await mk(); const zb = await facts.recordSupplierInvoice(z.w.env, input(z.s), CTX); await facts.voidSupplierInvoice(z.w.env, { billId: zb.documentId, reason: 'x', voidedOn: '2026-11-12' }, CTX);
  z.w.db.prepare("INSERT INTO eng_event (type, payload_json) VALUES ('supplier_invoice.voided', ?)").run(JSON.stringify({ documentId: zb.documentId + 1000, reason: 'x', voidedOn: '2026-11-12' }));
  integ = await verifyIntegrity(z.w.env); check(integ.problems.some((p) => /does not exist/.test(p.detail)), 'a void of a bill that does not exist is REPORTED');
  const rowOf = (db, id) => JSON.stringify([db.prepare('SELECT * FROM eng_document WHERE id = ?').get(id), db.prepare('SELECT * FROM eng_document_line WHERE document_id = ? ORDER BY id').all(id)]);
  const keep = await mk(); const kb = await facts.recordSupplierInvoice(keep.w.env, input(keep.s), CTX); const kbefore = rowOf(keep.w.db, kb.documentId);
  await facts.recordSupplierPayment(keep.w.env, { supplierId: keep.s, amountMinor: 1000, currency: 'ZAR', paidOn: '2026-11-10', method: 'eft', allocations: [{ billId: kb.documentId, amountMinor: 1000 }] }, CTX);
  check(rowOf(keep.w.db, kb.documentId) === kbefore, 'the bill and its lines are byte-for-byte what they were after a payment: nothing is ever edited');
  const atomic = async (label, prep, act) => { const p0 = await prep(); p0.w.resetWrites(); await act(p0); const writes = p0.w.writeCount(); const leaked = [];
    for (let n = 1; n <= writes; n++) { const q = await prep(); const was = JSON.stringify(q.w.counts()); q.w.failAt(n); let threw = false; try { await act(q); } catch { threw = true; } if (!threw || JSON.stringify(q.w.counts()) !== was) leaked.push(n); }
    check(writes >= 3 && leaked.length === 0, `${label} is atomic: a failure at each of its ${writes} writes leaves nothing behind` + (leaked.length ? ' (leaked at ' + leaked.join(',') + ')' : '')); };
  await atomic('recording a bill', mk, (q) => facts.recordSupplierInvoice(q.w.env, input(q.s), CTX));
  await atomic('paying a bill', async () => { const q = await mk(); q.b = await facts.recordSupplierInvoice(q.w.env, input(q.s), CTX); return q; }, (q) => facts.recordSupplierPayment(q.w.env, { supplierId: q.s, amountMinor: 40000, currency: 'ZAR', paidOn: '2026-11-10', method: 'eft', allocations: [{ billId: q.b.documentId, amountMinor: 40000 }] }, CTX));
  await atomic('voiding a bill', async () => { const q = await mk(); q.b = await facts.recordSupplierInvoice(q.w.env, input(q.s), CTX); return q; }, (q) => facts.voidSupplierInvoice(q.w.env, { billId: q.b.documentId, reason: 'x', voidedOn: '2026-11-12' }, CTX));
  const wn = await mk(); const was = JSON.stringify(wn.w.counts()); const codes = [];
  const wb = await facts.recordSupplierInvoice(wn.w.env, input(wn.s), CTX);
  for (const fn of [() => facts.recordSupplierInvoice(wn.w.env, { ...input(wn.s), supplierInvoiceNumber: 'F-1' }, CTX), () => facts.recordSupplierPayment(wn.w.env, { supplierId: wn.s, amountMinor: 999999999, currency: 'ZAR', paidOn: '2026-11-10', method: 'eft', allocations: [{ billId: wb.documentId, amountMinor: 999999999 }] }, CTX), () => facts.recordSupplierInvoice(wn.w.env, { ...input(99999), supplierInvoiceNumber: 'G-1' }, CTX)]) { const before = JSON.stringify(wn.w.counts()); try { await fn(); codes.push('none'); } catch (e) { codes.push(e && e.code); } if (JSON.stringify(wn.w.counts()) !== before) codes.push('LEAK'); }
  check(codes.every((c) => c && c !== 'none' && c !== 'LEAK'), `the fact layer itself refuses a duplicate invoice number, an overpayment and an unknown supplier, and writes nothing (${codes.join(', ')})`);
});

if (require.main === module) kit.standalone(module.exports);
