// Purchase orders and goods received (branch engine-phase1): create an order, receive goods against it, cancel the rest, find them. TESTS FIRST. Evidence label for every check: TEST of the engine on the route harness (NOT staging, NOT production).
// Expected state when first committed: RED. Decisions and research: docs/decisions/purchase-orders.md. In short: an order is a document of kind purchase_order (a commitment: no payable, no tax document, no money); a goods receipt is a document of kind
// goods_receipt tied to ONE order by a goods.received event; status (open, part_received, received, cancelled, closed) is DERIVED from the events, never stored; a line can never be received beyond what remains (strict); cancelling closes the remainder;
// field staff may PROPOSE a receipt but a money role approves it; and a proposal carries the version of the order it was made against, so two people cannot both receive the last of a line.
const kit = require('./engine-kit.js');

module.exports = kit.guard('purchase orders and goods received', async ({ check }) => {
  const eng = kit.loadEngine();
  check(Boolean(eng && eng.permissions && eng.capabilities && eng.facts && eng.purchasing), 'the engine exposes permissions, capabilities, facts and the purchasing module');
  if (!eng || !eng.permissions || !eng.purchasing) return;
  const auth = kit.bundle('auth.ts', 'auth');
  const member = (role) => ({ email: `${role}@example.com`, caps: auth.ROLE_CAPABILITIES[role] || [] });
  const AV = [...kit.ALL_CAPABILITIES, 'party.create', 'purchase_order.create', 'purchase_order.cancel', 'goods.receive', 'purchase_orders.find', 'vat.summary', 'expenses.find'];
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
  const line = (description, quantityMilli, unitPriceMinor, taxBp = 1500) => ({ description, quantityMilli, unit: 'sheet', unitPriceMinor, taxBp });
  const LINES = [line('Plywood sheets', 10000, 20000), line('Screws box', 5000, 1000)];   // 10 sheets at R200.00 = R2,000.00 and 5 boxes at R10.00 = R50.00: net R2,050.00, tax R307.50, gross R2,357.50
  const order = (extra = {}) => ({ supplierId: 2, orderedOn: '2026-11-01', currency: 'ZAR', expectedOn: '2026-11-10', reference: 'Quote Q-77', lines: LINES, ...extra });
  const world = seq(); world.do('party.create', { kind: 'organisation', name: 'Timber Supplies', roles: ['supplier'], contact: { vatNumber: '4111111111' } });   // party 2 (this world has one customer, Mokoena)
  world.do('party.create', { kind: 'person', name: 'Corner Spaza', roles: ['supplier'] });                                                                                 // party 3
  const one = ext(world); one.do('purchase_order.create', order());
  const find = (role, q = '') => get(role, `/engine/purchase-orders${q}`);
  const list = async (steps, q = '', role = 'accountant') => (body(await run({ before: steps, ...find(role, q) })).result || {});
  const view = async (steps, id, role = 'accountant') => (body(await run({ before: steps, ...get(role, `/engine/records/document/${id}`) })).result || {});
  const PO = ((await list(one.steps, '?status=any')).orders || [])[0] || {};
  const recv = (lines, extra = {}) => ({ orderId: PO.id, receivedOn: '2026-11-05', lines, ...extra });

  // ---- 1. PERMISSIONS ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  check(['owner', 'accountant', 'admin'].every((r) => has(r, 'purchase.manage') && has(r, 'purchase.read') && has(r, 'goods.receive')), 'owner, accountant and admin may create and cancel orders, read them and receive goods');
  check(['sales', 'installer'].every((r) => !has(r, 'purchase.manage')), 'a salesperson and an installer may not create or cancel an order');
  const materials = (r) => member(r).caps.includes('can_know_materials');
  check(['sales', 'installer'].every((r) => has(r, 'goods.receive') === materials(r) && has(r, 'purchase.read') === materials(r)), 'whoever holds the legacy materials capability (field staff) may read orders and propose a receipt, and nobody else does');
  check(['purchase_order.create', 'purchase_order.cancel', 'goods.receive', 'purchase_orders.find'].every((c) => eng.capabilities.CAPABILITY_IDS.includes(c)), 'the four capabilities exist in the engine');

  // ---- 2. CREATE: held first, a commitment and never money ------------------------------------------------------------------------------------------------------------------------------------------------
  let r = await run({ before: world.steps, ...propose('accountant', 'purchase_order.create', order(), 'Order ten sheets of plywood and five boxes of screws from Timber Supplies') });
  check(status(r) === 200 && body(r).status === 'held' && touchesNoFact(r) && added(r, 'eng_event') === 0, `proposing an order is HELD and records nothing (${status(r)} ${body(r).status})`);
  check(JSON.stringify(r.writes || {}).includes('235750'), 'the approval is shown the exact total the engine worked out (R2,357.50 with tax)');
  const prop = ext(world); const pid = prop.prop('purchase_order.create', order());
  r = await run({ before: prop.steps, ...confirm('accountant', pid) });
  check(status(r) === 200 && added(r, 'eng_document') === 1 && added(r, 'eng_document_line') === 2 && added(r, 'eng_document_number') === 1 && added(r, 'eng_money_movement') === 0 && added(r, 'eng_allocation') === 0, `approving it records ONE order with its two lines and its number, and no money (${status(r)})`);
  check(added(r, 'eng_event') === 2, 'with the document.issued event and the execution, nothing else');
  check(PO.number === 1 && PO.supplierId === 2 && PO.supplierName === 'Timber Supplies' && PO.status === 'open' && PO.netMinor === 205000 && PO.taxMinor === 30750 && PO.grossMinor === 235750 && PO.expectedOn === '2026-11-10' && PO.reference === 'Quote Q-77' && PO.receivedValueMinor === 0 && PO.outstandingValueMinor === 205000 && PO.ref && PO.ref.kind === 'document', 'finding lists it: number 1, Timber Supplies, open, net R2,050.00, tax R307.50, total R2,357.50, nothing received, with a reference to open it');
  let v = await view(one.steps, PO.id);
  check(v.title === 'Purchase order #1' && fieldOf(v, 'status') === 'open' && fieldOf(v, 'supplier') === 'Timber Supplies' && fieldOf(v, 'expectedOn') === '2026-11-10' && fieldOf(v, 'reference') === 'Quote Q-77' && fieldOf(v, 'grossMinor') === 235750, 'the record opens as Purchase order #1 with its status, supplier, expected date, reference and totals');
  check(((v.collections || {}).progress || []).length === 2 && v.collections.progress[0].orderedMilli === 10000 && v.collections.progress[0].receivedMilli === 0 && v.collections.progress[0].remainingMilli === 10000 && fieldOf(v, 'outstandingMinor') === null, 'with each line\'s progress (ordered, received, remaining) and nothing "owed": an order is not a debt');
  const issued = (v.history || []).find((h) => h.type === 'document.issued') || {};
  check(issued.contract === 'purchase_order.create' && issued.approvedBy === 'accountant@example.com' && Number.isInteger(issued.captureId) && Number.isInteger(issued.interpretationId) && Number.isInteger(issued.proposalId), 'it is EXPLAINED: what was said, what was understood, which proposal, who approved it and under which contract');
  r = await run({ before: one.steps, ...get('accountant', '/engine/receivables?party=Mokoena') });
  check((body(r).result || {}).totalMinor === 138000, 'an order touches no customer\'s account (Mokoena still owes R1,380.00)');
  r = await run({ before: one.steps, ...get('accountant', '/engine/vat?from=2026-10-01&to=2026-11-30') });
  check((body(r).result || {}).inputTaxMinor === 0, 'and no input tax: an order is not a tax document');
  const two = ext(one); two.do('purchase_order.create', order({ reference: 'Quote Q-78' }));
  check(((await list(two.steps, '?status=any')).orders || []).map((o) => o.number).sort().join() === '1,2', 'orders are numbered in their own sequence, 1 then 2');

  // ---- 3. CREATE refusals ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const bad = [
    [order({ colour: 'blue' }), 'a field nobody declared'], [order({ supplierId: 'three' }), 'a supplier number that is text'], [order({ lines: [] }), 'no lines'], [order({ lines: [{ description: 'x', quantityMilli: 1000, unitPriceMinor: 100 }] }), 'a line with no tax rate (VAT is never assumed)'],
    [order({ lines: [line('x', 0, 100)] }), 'a quantity of zero'], [order({ lines: [line('x', 1000.5, 100)] }), 'a fractional quantity'], [order({ lines: [line('x', 1000, -1)] }), 'a negative price'], [order({ orderedOn: '2026-02-30' }), 'a date that does not exist'],
    [order({ expectedOn: '2026-10-01' }), 'an expected date before the order date'], [order({ expectedOn: 'soon' }), 'an expected date that is not a date'], [order({ currency: 'rand' }), 'a currency that is not a code'], [order({ reference: 'x'.repeat(121) }), 'a reference over 120 characters'],
    [order({ lines: Array.from({ length: 101 }, (_, i) => line('L' + i, 1000, 100)) }), 'more than 100 lines'], [null, 'no payload at all'],
  ];
  for (const [payload, why] of bad) { r = await run({ before: world.steps, ...propose('accountant', 'purchase_order.create', payload) }); check(status(r) === 422 && body(r).error === 'invalid_payload' && touchesNoFact(r), `${why} is refused at the door as invalid_payload (${status(r)} ${body(r).error}) and records nothing`); }
  r = await run({ before: world.steps, ...propose('accountant', 'purchase_order.create', order({ supplierId: 99 })) }); check(status(r) === 404 && body(r).error === 'not_found' && touchesNoFact(r), 'a supplier that does not exist is refused as not_found');
  r = await run({ before: world.steps, ...propose('accountant', 'purchase_order.create', order({ supplierId: 1 })) }); check(status(r) === 409 && body(r).error === 'invalid_state' && touchesNoFact(r), 'a party that is only a customer (Mokoena) cannot be ordered from: invalid_state');
  for (const role of ['sales', 'installer']) { r = await run({ before: world.steps, ...propose(role, 'purchase_order.create', order()) }); check(status(r) === 403 && touchesNoFact(r), `${role} may not propose an order: refused 403, nothing recorded`); }
  r = await run({ before: [...world.steps, propose('accountant', 'purchase_order.create', order())], ...confirm('installer', 3) }); check(status(r) === 403 && added(r, 'eng_document') === 0, 'an installer cannot approve one either');
  r = await kit.route({ env: ENV, seed: kit.seedReceivables(kit.ALL_CAPABILITIES), ...propose('accountant', 'purchase_order.create', order()) }); check(status(r) === 409 && body(r).error === 'capability_unavailable' && touchesNoFact(r), 'a business without the capability is told so');
  r = await run({ before: [...prop.steps, confirm('accountant', pid)], ...confirm('accountant', pid) }); check(status(r) !== 200 && added(r, 'eng_document') === 0, `approving the same proposal twice never creates a second order (${status(r)})`);

  // ---- 4. RECEIVE: only what arrived, never more than ordered -----------------------------------------------------------------------------------------------------------------------------------------------------------
  r = await run({ before: one.steps, ...propose('accountant', 'goods.receive', recv([{ lineNo: 1, quantityMilli: 4000 }]), 'Four sheets of plywood arrived') });
  check(status(r) === 200 && body(r).status === 'held' && touchesNoFact(r) && added(r, 'eng_event') === 0, 'proposing a receipt is HELD and records nothing');
  const rc = ext(one); const rId = rc.prop('goods.receive', recv([{ lineNo: 1, quantityMilli: 4000 }], { deliveryNote: 'DN-5521' }));
  r = await run({ before: rc.steps, ...confirm('accountant', rId) });
  check(status(r) === 200 && added(r, 'eng_document') === 1 && added(r, 'eng_document_line') === 1 && added(r, 'eng_document_number') === 1 && added(r, 'eng_money_movement') === 0 && added(r, 'eng_event') === 3, `approving it records ONE goods receipt with its line and number, no money, and the goods.received event (3 events with the execution; ${status(r)})`);
  rc.ok(rId);
  let o = ((await list(rc.steps)).orders || [])[0] || {};
  check(o.status === 'part_received' && o.receivedValueMinor === 80000 && o.outstandingValueMinor === 125000, 'the order is now part_received: R800.00 received (4 sheets), R1,250.00 outstanding');
  v = await view(rc.steps, PO.id);
  check(fieldOf(v, 'status') === 'part_received' && v.collections.progress[0].receivedMilli === 4000 && v.collections.progress[0].remainingMilli === 6000 && v.collections.progress[1].receivedMilli === 0 && (v.relations || []).some((x) => x.role === 'receipt' && x.ref.kind === 'document'), 'its record shows the progress (4 of 10 received, 6 remaining) and links to the receipt');
  const rcpt = ((v.relations || []).find((x) => x.role === 'receipt') || { ref: { id: 0 } }).ref.id;
  const rv = await view(rc.steps, rcpt);
  check(rv.title === 'Goods receipt #1' && fieldOf(rv, 'deliveryNote') === 'DN-5521' && fieldOf(rv, 'receivedOn') === '2026-11-05' && (rv.relations || []).some((x) => x.role === 'receives' && x.ref.id === PO.id) && ((rv.collections || {}).lines || []).length === 1 && rv.collections.lines[0].quantityMilli === 4000, 'the receipt opens as Goods receipt #1 with its delivery note, its date, what it received, and a link back to its order');
  const hist = (rv.history || []).find((h) => h.type === 'goods.received') || {};
  check(hist.contract === 'goods.receive' && hist.approvedBy === 'accountant@example.com' && Number.isInteger(hist.captureId) && Number.isInteger(hist.interpretationId), 'the receipt is EXPLAINED too: what was said, what was understood, who approved, under which contract');
  const rest = ext(rc); rest.do('goods.receive', recv([{ lineNo: 1, quantityMilli: 6000 }, { lineNo: 2, quantityMilli: 5000 }], { receivedOn: '2026-11-08' }));
  o = ((await list(rest.steps, '?status=received')).orders || [])[0] || {};
  check(o.status === 'received' && o.receivedValueMinor === 205000 && o.outstandingValueMinor === 0, 'receiving the rest completes it: status received, all R2,050.00 received');
  check(((await list(rest.steps)).orders || []).length === 0, 'and a fully received order leaves the default (outstanding) list');
  const receiveRefusals = [
    [recv([{ lineNo: 1, quantityMilli: 10001 }]), 'invalid_state', 'more than was ordered on a line'], [recv([{ lineNo: 2, quantityMilli: 5001 }]), 'invalid_state', 'more than was ordered on another line'], [recv([{ lineNo: 7, quantityMilli: 1000 }]), 'invalid_input', 'a line the order does not have'],
    [recv([{ lineNo: 1, quantityMilli: 1000 }], { receivedOn: '2026-10-31' }), 'invalid_input', 'a receipt dated before the order'], [recv([{ lineNo: 1, quantityMilli: 1000 }], { orderId: 999 }), 'not_found', 'an order that does not exist'], [recv([{ lineNo: 1, quantityMilli: 1000 }], { orderId: 1 }), 'invalid_state', 'something that is not an order (invoice 1)'],
  ];
  for (const [payload, code, why] of receiveRefusals) { r = await run({ before: one.steps, ...propose('accountant', 'goods.receive', payload) }); check(body(r).error === code && touchesNoFact(r) && added(r, 'eng_event') === 0, `${why} is refused at the door as ${code} (${status(r)} ${body(r).error}) and records nothing`); }
  for (const [payload, why] of [[recv([]), 'no lines'], [recv([{ lineNo: 1, quantityMilli: 0 }]), 'a quantity of zero'], [recv([{ lineNo: 1, quantityMilli: 100.5 }]), 'a fractional quantity'], [recv([{ lineNo: 1, quantityMilli: 100 }, { lineNo: 1, quantityMilli: 200 }]), 'the same line twice'], [recv([{ lineNo: 1, quantityMilli: 100, price: 5 }]), 'a price (a receipt takes the order\'s price, never a new one)'], [recv([{ lineNo: 1, quantityMilli: 100 }], { colour: 'x' }), 'a field nobody declared'], [recv([{ lineNo: 1, quantityMilli: 100 }], { receivedOn: 'soon' }), 'a date that is not a date'], [recv([{ lineNo: 1, quantityMilli: 100 }], { deliveryNote: 'x'.repeat(61) }), 'a delivery note over 60 characters'], [recv([{ lineNo: 1, quantityMilli: 100 }], { note: 'x'.repeat(201) }), 'a note over 200 characters']]) {
    r = await run({ before: one.steps, ...propose('accountant', 'goods.receive', payload) }); check(status(r) === 422 && body(r).error === 'invalid_payload' && touchesNoFact(r), `${why} is refused as invalid_payload`); }
  r = await run({ before: rc.steps, ...propose('accountant', 'goods.receive', recv([{ lineNo: 1, quantityMilli: 6001 }])) });
  check(status(r) === 409 && body(r).error === 'invalid_state' && /6000|6\.000|remain/i.test(String(body(r).message || '')), 'after 4 of 10 arrived, receiving 6.001 is refused, and the message says what remains');
  r = await run({ before: rest.steps, ...propose('accountant', 'goods.receive', recv([{ lineNo: 2, quantityMilli: 1 }])) }); check(status(r) === 409 && body(r).error === 'invalid_state' && touchesNoFact(r) && /in full/.test(String(body(r).message || '')), 'a fully received order cannot be received on again, and the message says it was received in full');
  r = await run({ before: one.steps, ...propose('installer', 'goods.receive', recv([{ lineNo: 1, quantityMilli: 1000 }])) });
  check(has('installer', 'goods.receive') ? (status(r) === 200 && body(r).status === 'held') : status(r) === 403, `${has('installer', 'goods.receive') ? 'field staff (an installer) may PROPOSE a receipt' : 'an installer may not propose a receipt'}`);
  if (has('installer', 'goods.receive')) {
    const fieldRec = ext(one); const fid = fieldRec.prop('goods.receive', recv([{ lineNo: 1, quantityMilli: 1000 }]), 'installer');
    r = await run({ before: fieldRec.steps, ...confirm('installer', fid) }); check(status(r) === 403 && added(r, 'eng_document') === 0, 'but they cannot APPROVE it: a person with a money role does');
    r = await run({ before: fieldRec.steps, ...confirm('accountant', fid) }); check(status(r) === 200 && added(r, 'eng_document') === 1, 'and when an accountant approves it, it is recorded');
  }
  r = await run({ before: one.steps, ...propose('sales', 'goods.receive', recv([{ lineNo: 1, quantityMilli: 1000 }])) }); check(has('sales', 'goods.receive') ? status(r) === 200 : status(r) === 403, 'a salesperson follows the same rule (only with the materials capability)');
  r = await kit.route({ env: ENV, seed: kit.seedReceivables(kit.ALL_CAPABILITIES), ...propose('accountant', 'goods.receive', recv([{ lineNo: 1, quantityMilli: 1000 }])) }); check(status(r) === 409 && body(r).error === 'capability_unavailable', 'a business without the capability is told so');
  r = await run({ before: [...rc.steps, propose('accountant', 'goods.receive', recv([{ lineNo: 1, quantityMilli: 100 }])), confirm('accountant', 2)], ...confirm('accountant', 2) }); check(status(r) !== 200 && added(r, 'eng_document') === 0, 'approving the same receipt twice never receives twice');
  const race = ext(one); const a1 = race.prop('goods.receive', recv([{ lineNo: 1, quantityMilli: 3000 }])); const a2 = race.prop('goods.receive', recv([{ lineNo: 1, quantityMilli: 3000 }])); race.ok(a1);
  r = await run({ before: race.steps, ...confirm('accountant', a2) });
  check(status(r) === 409 && body(r).error === 'stale' && added(r, 'eng_document') === 0, `a receipt approved after the order changed (another receipt was approved first) is refused as STALE even though the quantity would still fit (${status(r)} ${body(r).error}): an approval is only for the order as it was shown`);
  const over = ext(one); const o1 = over.prop('goods.receive', recv([{ lineNo: 1, quantityMilli: 7000 }])); const o2 = over.prop('goods.receive', recv([{ lineNo: 1, quantityMilli: 7000 }])); over.ok(o1);
  r = await run({ before: over.steps, ...confirm('accountant', o2) });
  check(status(r) === 409 && added(r, 'eng_document') === 0, `two people receiving 7 of 10 sheets: the second approval is refused (${status(r)} ${body(r).error}), so the order can never be over-received`);
  r = await run({ before: one.steps, ...get('accountant', '/engine/receivables?party=Mokoena') }); check((body(r).result || {}).totalMinor === 138000, 'receiving goods never touches money');

  // ---- 5. CANCEL: the remainder only ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const cx = (extra = {}) => ({ orderId: PO.id, reason: 'The supplier cannot deliver', cancelledOn: '2026-11-06', ...extra });
  r = await run({ before: one.steps, ...propose('accountant', 'purchase_order.cancel', cx(), 'Cancel the Timber Supplies order, they cannot deliver') });
  check(status(r) === 200 && body(r).status === 'held' && touchesNoFact(r), 'proposing a cancellation is HELD and records nothing');
  const cc = ext(one); cc.do('purchase_order.cancel', cx());
  r = await run({ before: [...one.steps, propose('accountant', 'purchase_order.cancel', cx())], ...confirm('accountant', 4) });
  check(status(r) === 200 && added(r, 'eng_event') === 2 && FACTS.every((t) => added(r, t) === 0), 'approving it records the purchase_order.cancelled event and the execution, and NO fact row');
  o = ((await list(cc.steps, '?status=any')).orders || [])[0] || {};
  check(o.status === 'cancelled' && o.outstandingValueMinor === 0, 'an order with nothing received is now cancelled and nothing is outstanding');
  v = await view(cc.steps, PO.id); check(fieldOf(v, 'status') === 'cancelled' && (v.history || []).some((h) => h.type === 'purchase_order.cancelled' && h.contract === 'purchase_order.cancel' && h.approvedBy === 'accountant@example.com'), 'its record says cancelled, with the cancellation explained');
  const closed = ext(rc); closed.do('purchase_order.cancel', cx({ reason: 'We only needed four' }));
  o = ((await list(closed.steps, '?status=any')).orders || [])[0] || {};
  check(o.status === 'closed' && o.receivedValueMinor === 80000 && o.outstandingValueMinor === 0, 'cancelling after part was received CLOSES the order short: R800.00 received, nothing outstanding');
  for (const [steps, what] of [[cc.steps, 'a cancelled order'], [closed.steps, 'a closed order'], [rest.steps, 'a fully received order']]) { r = await run({ before: steps, ...propose('accountant', 'purchase_order.cancel', cx()) }); check(status(r) === 409 && body(r).error === 'invalid_state' && touchesNoFact(r), `cancelling ${what} is refused as invalid_state`); }
  r = await run({ before: cc.steps, ...propose('accountant', 'goods.receive', recv([{ lineNo: 1, quantityMilli: 1000 }])) }); check(status(r) === 409 && body(r).error === 'invalid_state' && touchesNoFact(r), 'goods cannot be received on a cancelled order');
  r = await run({ before: closed.steps, ...propose('accountant', 'goods.receive', recv([{ lineNo: 1, quantityMilli: 1000 }])) }); check(status(r) === 409 && body(r).error === 'invalid_state', 'nor on a closed one');
  for (const [payload, code, why] of [[cx({ orderId: 999 }), 'not_found', 'an order that does not exist'], [cx({ orderId: 1 }), 'invalid_state', 'something that is not an order (invoice 1)']]) { r = await run({ before: one.steps, ...propose('accountant', 'purchase_order.cancel', payload) }); check(body(r).error === code && touchesNoFact(r), `cancelling ${why} is refused as ${code}`); }
  for (const [payload, why] of [[cx({ reason: '' }), 'no reason'], [cx({ reason: 'x'.repeat(201) }), 'a reason over 200 characters'], [cx({ cancelledOn: 'soon' }), 'a date that is not a date'], [cx({ colour: 'x' }), 'a field nobody declared'], [{}, 'nothing at all']]) { r = await run({ before: one.steps, ...propose('accountant', 'purchase_order.cancel', payload) }); check(status(r) === 422 && body(r).error === 'invalid_payload' && touchesNoFact(r), `${why} is refused as invalid_payload`); }
  r = await run({ before: one.steps, ...propose('accountant', 'purchase_order.cancel', cx({ cancelledOn: '2026-10-31' })) }); check(status(r) === 422 || status(r) === 409, 'a cancellation dated before the order is refused');
  for (const role of ['sales', 'installer']) { r = await run({ before: one.steps, ...propose(role, 'purchase_order.cancel', cx()) }); check(status(r) === 403 && touchesNoFact(r), `${role} may not cancel an order`); }
  const stale = ext(one); const s1 = stale.prop('purchase_order.cancel', cx()); const s2 = stale.prop('goods.receive', recv([{ lineNo: 1, quantityMilli: 1000 }])); stale.ok(s2);
  r = await run({ before: stale.steps, ...confirm('accountant', s1) });
  check(status(r) === 409 && ['stale', 'invalid_state'].includes(body(r).error) && added(r, 'eng_event') === 0, `a cancellation approved after goods were received against the order is refused as stale, not silently applied (${status(r)} ${body(r).error})`);

  // ---- 6. FIND ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const mix = ext(world); mix.do('purchase_order.create', order()); mix.do('purchase_order.create', order({ supplierId: 3, reference: 'Spaza run', lines: [line('Sweets', 1000, 500, 0)] }));
  let L = await list(mix.steps); check((L.orders || []).length === 2 && L.count === 2 && L.truncated === false, 'finding with no filter lists the outstanding orders');
  check(((await list(mix.steps, '?supplierId=3')).orders || []).length === 1 && (await list(mix.steps, '?supplierId=3')).orders[0].supplierName === 'Corner Spaza', 'finding by supplier');
  check(((await list(mix.steps, '?status=open')).orders || []).length === 2 && ((await list(mix.steps, '?status=received')).orders || []).length === 0, 'finding by status');
  for (const [q, why] of [['?status=banana', 'a status nobody declared'], ['?supplierId=abc', 'a supplier number that is not a number']]) { r = await run({ before: mix.steps, ...find('accountant', q) }); check(status(r) === 422, `${why} is refused as invalid`); }
  r = await run({ before: mix.steps, ...find('sales') }); check(has('sales', 'purchase.read') ? status(r) === 200 : status(r) === 403, 'a salesperson reads orders only with the materials capability');
  r = await run({ before: mix.steps, ...find('installer') }); check(has('installer', 'purchase.read') ? status(r) === 200 : status(r) === 403, 'and an installer likewise');
  r = await kit.route({ env: ENV, seed: kit.seedReceivables(kit.ALL_CAPABILITIES), ...find('accountant') }); check(status(r) === 409 && body(r).error === 'capability_unavailable', 'a business without the capability is told so');

  // ---- 7. THE FOUNDATIONS STILL HOLD ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const { facts, verifyIntegrity, EVENT_MODEL } = eng; const CTX = { actorEmail: 'accountant@example.com', contract: 'test', contractVersion: 1 };
  check(['goods.received', 'purchase_order.cancelled'].every((t) => EVENT_MODEL[t] && EVENT_MODEL[t].creates === null), 'the event model knows both new events and says they create no fact row of their own');
  const mk = async () => { const w = kit.makeWorld(); w.configure({ mode: 'engine', available: AV }); const s = (await facts.recordParty(w.env, { kind: 'organisation', name: 'Timber', roles: ['supplier'] }, CTX)).id; const po = await facts.recordPurchaseOrder(w.env, { supplierId: s, orderedOn: '2026-11-01', currency: 'ZAR', lines: LINES }, CTX); return { w, s, po }; };
  const x = await mk(); const g = await facts.receiveGoods(x.w.env, { orderId: x.po.documentId, receivedOn: '2026-11-05', lines: [{ lineNo: 1, quantityMilli: 3000 }] }, CTX);
  const rowOf = (id) => JSON.stringify([x.w.db.prepare('SELECT * FROM eng_document WHERE id = ?').get(id), x.w.db.prepare('SELECT * FROM eng_document_line WHERE document_id = ? ORDER BY id').all(id)]);
  const before = rowOf(x.po.documentId); await facts.receiveGoods(x.w.env, { orderId: x.po.documentId, receivedOn: '2026-11-06', lines: [{ lineNo: 1, quantityMilli: 2000 }] }, CTX); await facts.cancelPurchaseOrder(x.w.env, { orderId: x.po.documentId, reason: 'enough', cancelledOn: '2026-11-07' }, CTX);
  check(rowOf(x.po.documentId) === before && g.number === 1, 'the order and its lines are byte-for-byte what they were after two receipts and a cancellation: nothing is ever edited');
  let integ = await verifyIntegrity(x.w.env);
  check(integ.ok === true && integ.problems.length === 0 && integ.warnings.length === 0, 'the integrity verifier is clean after an order, receipts and a cancellation, with no warning about an unmodelled event');
  x.w.db.prepare("INSERT INTO eng_event (type, payload_json) VALUES ('goods.received', ?)").run(JSON.stringify({ documentId: 9999, orderId: x.po.documentId, receivedOn: '2026-11-08', lines: [{ lineNo: 1, quantityMilli: 1 }] }));
  integ = await verifyIntegrity(x.w.env); check(integ.ok === false && integ.problems.some((p) => p.code === 'orphan' && /9999/.test(p.detail) && /does not exist/.test(p.detail)), 'a receipt event that points at a document that does not exist is REPORTED (orphan)');
  const y = await mk(); const yr = await facts.receiveGoods(y.w.env, { orderId: y.po.documentId, receivedOn: '2026-11-05', lines: [{ lineNo: 1, quantityMilli: 9000 }] }, CTX);
  y.w.db.prepare("INSERT INTO eng_event (type, payload_json) VALUES ('goods.received', ?)").run(JSON.stringify({ documentId: yr.documentId, orderId: y.po.documentId, receivedOn: '2026-11-06', lines: [{ lineNo: 1, quantityMilli: 9000 }] }));
  integ = await verifyIntegrity(y.w.env); check(integ.problems.some((p) => /more than|over/i.test(p.detail)), 'receipts that together exceed what was ordered on a line are REPORTED by the verifier');
  x.w.db.prepare("INSERT INTO eng_event (type, payload_json) VALUES ('goods.received', ?)").run(JSON.stringify({ documentId: g.documentId, orderId: 7777, receivedOn: '2026-11-08', lines: [{ lineNo: 1, quantityMilli: 1 }] }));
  integ = await verifyIntegrity(x.w.env); check(integ.problems.some((p) => /purchase order 7777/.test(p.detail) && /does not exist/.test(p.detail)), 'a receipt event that names an ORDER that does not exist is REPORTED');
  const z = await mk(); await facts.cancelPurchaseOrder(z.w.env, { orderId: z.po.documentId, reason: 'x', cancelledOn: '2026-11-02' }, CTX);
  z.w.db.prepare("INSERT INTO eng_event (type, payload_json) VALUES ('purchase_order.cancelled', ?)").run(JSON.stringify({ documentId: z.po.documentId, reason: 'again', cancelledOn: '2026-11-03' }));
  integ = await verifyIntegrity(z.w.env); check(integ.problems.some((p) => /more than once|twice|already/i.test(p.detail)), 'an order cancelled twice is REPORTED');
  const zr = await facts.recordDocument(z.w.env, { kind: 'goods_receipt', direction: 'buy', partyId: z.s, currency: 'ZAR', issuedOn: '2026-11-04', lines: [{ description: 'Plywood sheets', quantityMilli: 1000, unit: 'sheet', unitPriceMinor: 20000, taxBp: 1500 }] }, CTX);
  z.w.db.prepare("INSERT INTO eng_event (type, payload_json) VALUES ('goods.received', ?)").run(JSON.stringify({ documentId: zr.id, orderId: z.po.documentId, receivedOn: '2026-11-04', lines: [{ lineNo: 1, quantityMilli: 1000 }] }));
  integ = await verifyIntegrity(z.w.env); check(integ.problems.some((p) => /after it was cancelled/.test(p.detail)), 'goods received on an order AFTER it was cancelled are REPORTED');
  const atomic = async (label, prep, act) => { const pr = await prep(); pr.w.resetWrites(); await act(pr); const writes = pr.w.writeCount(); const leaked = [];
    for (let n = 1; n <= writes; n++) { const q = await prep(); const was = JSON.stringify(q.w.counts()); q.w.failAt(n); let threw = false; try { await act(q); } catch { threw = true; } if (!threw || JSON.stringify(q.w.counts()) !== was) leaked.push(n); }
    check(writes >= 4 && leaked.length === 0, `${label} is atomic: a failure at each of its ${writes} writes leaves nothing behind` + (leaked.length ? ' (leaked at ' + leaked.join(',') + ')' : '')); };
  await atomic('creating an order', async () => { const w = kit.makeWorld(); w.configure({ mode: 'engine', available: AV }); const s = (await facts.recordParty(w.env, { kind: 'organisation', name: 'T', roles: ['supplier'] }, CTX)).id; return { w, s }; }, (q) => facts.recordPurchaseOrder(q.w.env, { supplierId: q.s, orderedOn: '2026-11-01', currency: 'ZAR', lines: LINES }, CTX));
  await atomic('receiving goods', mk, (q) => facts.receiveGoods(q.w.env, { orderId: q.po.documentId, receivedOn: '2026-11-05', lines: [{ lineNo: 1, quantityMilli: 3000 }] }, CTX));
  const wn = await mk(); const was = JSON.stringify(wn.w.counts()); const codes = [];
  for (const fn of [() => facts.receiveGoods(wn.w.env, { orderId: wn.po.documentId, receivedOn: '2026-11-05', lines: [{ lineNo: 1, quantityMilli: 10001 }] }, CTX), () => facts.receiveGoods(wn.w.env, { orderId: 424242, receivedOn: '2026-11-05', lines: [{ lineNo: 1, quantityMilli: 1 }] }, CTX), () => facts.cancelPurchaseOrder(wn.w.env, { orderId: wn.po.documentId, reason: ' ', cancelledOn: '2026-11-05' }, CTX)]) { try { await fn(); codes.push('none'); } catch (e) { codes.push(e && e.code); } }
  check(codes.every((c) => c && c !== 'none') && JSON.stringify(wn.w.counts()) === was, `the fact layer itself refuses an over-receipt, an unknown order and a blank reason, and writes nothing (${codes.join(', ')})`);
});

if (require.main === module) kit.standalone(module.exports);
