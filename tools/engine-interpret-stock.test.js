// A MODEL AS ONE MORE INTERPRETER, extended to stock (docs/decisions/interpreter-stock.md; the REAL model run is held until Pierre says "run it"). TESTS FIRST. Expected state when first committed: RED.
// Like engine-interpret-stack.test.js this runs with a SCRIPTED model (the harness's stand-in for env.AI), so CI never calls a real model: it pins what the route does with whatever a model says. The rules that carry over: the model is shown only
// the capabilities this business has and this member may use; what it chooses goes through the SAME door as any client; a read is a read, a write is PROPOSED and HELD (it can never approve); anything outside the catalogue or malformed is NOT UNDERSTOOD,
// with only a capture and an observation. New here: the model supplies an item, a place and a job as WORDS and a quantity as a plain number; the engine resolves the names, turns the number into thousandths, works the date out (always today) and builds
// the payload; it never takes an id, a date or a reason from the model; and `stock.receive`, adjustments, write-downs, returns, reversals and prices are not offered to the model at all.
const kit = require('./engine-kit.js');

module.exports = kit.guard('engine interpret (stock)', async ({ check }) => {
  const ENV_A = { BUSINESS_ID: 'eng-a', ENGINE_REHEARSAL: '1' };
  const SEED = { admin: true, method: 'POST', path: '/admin/engine/provision-sample', body: { confirm: 'eng-a' } };
  const call = (capability, args) => JSON.stringify(capability === null ? { capability: null } : { capability, arguments: args });
  const say = (re, reply) => ({ match: re, reply: () => reply });
  const prop = (capability, payload) => ({ method: 'POST', path: '/engine/proposals', role: 'accountant', body: { capability, payload, transcript: 'seed' } });
  const confirm = (id) => ({ method: 'POST', path: `/actions/${id}/confirm`, role: 'accountant', body: {} });
  // the world: items 1 Plywood 18mm (sheet), 2 Plywood 12mm (sheet, none in stock), 3 Screws 50mm box; places 1 Main store and 2 Bakkie 1; 10 sheets of 18mm and 20 boxes in the main store, 4 sheets of 18mm in the van
  const WORLD = []; let n = 0; const seed = (capability, payload) => { WORLD.push(prop(capability, payload), confirm(++n)); };
  seed('item.create', { sku: 'PLY-18', name: 'Plywood 18mm', unit: 'sheet', reorderLevelMilli: 5000, reorderQtyMilli: 20000 });
  seed('item.create', { sku: 'PLY-12', name: 'Plywood 12mm', unit: 'sheet' });
  seed('item.create', { sku: 'SCR-50', name: 'Screws 50mm', unit: 'box' });
  seed('item.create', { sku: 'SCR-OLD', name: 'Retired screws', unit: 'box' });
  seed('item.revise', { itemId: 4, active: false });
  seed('location.create', { name: 'Main store', kind: 'warehouse' });
  seed('location.create', { name: 'Bakkie 1', kind: 'vehicle' });
  seed('stock.receive', { itemId: 1, locationId: 1, quantityMilli: 10000, receivedOn: '2026-11-06', unitCostMinor: 20000 });
  seed('stock.receive', { itemId: 3, locationId: 1, quantityMilli: 20000, receivedOn: '2026-11-06', unitCostMinor: 1000 });
  seed('stock.receive', { itemId: 1, locationId: 2, quantityMilli: 4000, receivedOn: '2026-11-06', unitCostMinor: 20000 });
  const SCRIPT = [
    say(/Used 3 sheets of Plywood 18mm on the Mokoena lounge from the main store/, call('stock.issue', { item: 'Plywood 18mm', quantity: 3, job: 'Mokoena lounge', location: 'Main store' })),
    say(/Used 2 boxes of screws/, call('stock.issue', { item: 'Screws 50mm', quantity: 2 })),
    say(/Used 2 sheets of plywood 18mm without saying where from/, call('stock.issue', { item: 'Plywood 18mm', quantity: 2 })),
    say(/Used 2.5 boxes of screws/, call('stock.issue', { item: 'Screws 50mm', quantity: 2.5 })),
    say(/Used 3 sheets of Plywood 18mm from the shed/, call('stock.issue', { item: 'Plywood 18mm', quantity: 3, location: 'the shed' })),
    say(/Used 0.0005 of screws/, call('stock.issue', { item: 'Screws 50mm', quantity: 0.0005 })),
    say(/Used no sheets of screws/, call('stock.issue', { item: 'Screws 50mm', quantity: 0 })),
    say(/Used minus two screws/, call('stock.issue', { item: 'Screws 50mm', quantity: -2 })),
    say(/Used some screws/, call('stock.issue', { item: 'Screws 50mm' })),
    say(/Used two screws written out/, call('stock.issue', { item: 'Screws 50mm', quantity: 'two' })),
    say(/Used a million and one screws/, call('stock.issue', { item: 'Screws 50mm', quantity: 1000001 })),
    say(/Used 2 of plywood/, call('stock.issue', { item: 'plywood', quantity: 2, location: 'Main store' })),
    say(/Used 2 of unobtainium/, call('stock.issue', { item: 'Unobtainium', quantity: 2 })),
    say(/Used 2 of PLY-18 by its code/, call('stock.issue', { item: 'ply-18', quantity: 2, location: 'Main store' })),
    say(/Used too many/, call('stock.issue', { item: 'Plywood 18mm', quantity: 99, location: 'Main store' })),
    say(/Used 1 with an item number/, JSON.stringify({ capability: 'stock.issue', arguments: { item: 'Screws 50mm', quantity: 1, itemId: 3 } })),
    say(/Used 1 with a date/, JSON.stringify({ capability: 'stock.issue', arguments: { item: 'Screws 50mm', quantity: 1, issuedOn: '2020-01-01' } })),
    say(/Used 1 with a reason/, JSON.stringify({ capability: 'stock.issue', arguments: { item: 'Screws 50mm', quantity: 1, reason: 'sale' } })),
    say(/Moved 2 sheets of Plywood 18mm from the main store to the van/, call('stock.transfer', { item: 'Plywood 18mm', quantity: 2, from: 'Main store', to: 'Bakkie 1' })),
    say(/Moved 2 sheets to the same place/, call('stock.transfer', { item: 'Plywood 18mm', quantity: 2, from: 'Main store', to: 'Main store' })),
    say(/Moved 2 sheets from nowhere/, call('stock.transfer', { item: 'Plywood 18mm', quantity: 2, to: 'Bakkie 1' })),
    say(/Moved 2 sheets to the moon/, call('stock.transfer', { item: 'Plywood 18mm', quantity: 2, from: 'Main store', to: 'The moon' })),
    say(/Counted 8 sheets of Plywood 18mm in the main store/, call('stock.count', { item: 'Plywood 18mm', counted: 8, location: 'Main store' })),
    say(/Counted none of the screws/, call('stock.count', { item: 'Screws 50mm', counted: 0 })),
    say(/Counted minus one of the screws/, call('stock.count', { item: 'Screws 50mm', counted: -1 })),
    say(/Counted the screws without a number/, call('stock.count', { item: 'Screws 50mm' })),
    say(/Set aside 3 sheets of Plywood 18mm for the Dlamini kitchen/, call('stock.reserve', { item: 'Plywood 18mm', quantity: 3, job: 'Dlamini kitchen' })),
    say(/Set aside 3 sheets with no job/, call('stock.reserve', { item: 'Plywood 18mm', quantity: 3 })),
    say(/Set aside far too many/, call('stock.reserve', { item: 'Plywood 18mm', quantity: 500, job: 'Big job' })),
    say(/How many sheets of Plywood 18mm do we have\?/, call('stock.on_hand', { item: 'Plywood 18mm' })),
    say(/What stock do we have\?/, call('stock.on_hand', {})),
    say(/How much plywood do we have\?/, call('stock.on_hand', { item: 'plywood' })),
    say(/How much unobtainium do we have\?/, call('stock.on_hand', { item: 'Unobtainium' })),
    say(/What do we need to order\?/, call('stock.reorder_suggestions', {})),
    say(/What do we charge for Plywood 18mm\?/, call('prices.find', { item: 'Plywood 18mm' })),
    say(/Bought 5 sheets of plywood at R200/, call('stock.receive', { item: 'Plywood 18mm', quantity: 5, costCents: 20000 })),
    say(/Write down the plywood/, call('stock.write_down', { item: 'Plywood 18mm', amountCents: 10000 })),
    say(/Damaged 2 sheets/, call('stock.adjust', { item: 'Plywood 18mm', quantity: 2, reason: 'damage' })),
    say(/Customer returned 1 sheet/, call('stock.return', { item: 'Plywood 18mm', quantity: 1 })),
    say(/Set the price of plywood/, call('item.price', { item: 'Plywood 18mm', priceCents: 35000 })),
    say(/Add a new item/, call('item.create', { name: 'Glue', unit: 'tube' })),
    say(/Release the reservation/, call('stock.release', { reservationId: 1 })),
    say(/Used 1 of the retired screws/, call('stock.issue', { item: 'Retired screws', quantity: 1, location: 'Main store' })),
    say(/Used 1 of plywood 12mm with no stock/, call('stock.issue', { item: 'Plywood 12mm', quantity: 1 })),
    say(/Approve the stock issue/, call('stock.confirm', { actionId: 1 })),
  ];
  const interpret = (text, opts = {}) => kit.route({ env: ENV_A, ai: opts.ai || SCRIPT, before: [SEED, ...(opts.before || WORLD)], method: 'POST', path: '/engine/interpret', role: opts.role || 'accountant', body: opts.body || { text } });
  const added = (res, t) => ((res.writes && res.writes[t] && res.writes[t].added) || []).length;
  const tables = (res) => Object.keys(res.writes || {}).filter((t) => added(res, t) > 0).sort();
  const body = (res) => (res.result && res.result.body) || {};
  const status = (res) => res.result && res.result.status;
  const noFacts = (res) => ['eng_party', 'eng_document', 'eng_document_line', 'eng_money_movement', 'eng_allocation', 'eng_reversal', 'eng_event', 'eng_item', 'eng_location', 'eng_stock_move'].every((t) => added(res, t) === 0);
  const HELD = JSON.stringify(['captures', 'eng_interpretation', 'pending_actions']);
  const NOT = (res) => status(res) === 422 && body(res).error === 'not_understood' && JSON.stringify(tables(res)) === JSON.stringify(['captures', 'eng_observation']) && noFacts(res);
  const heldPayload = async (text, role = 'accountant') => { const res = await kit.route({ env: ENV_A, ai: SCRIPT, before: [SEED, ...WORLD, { method: 'POST', path: '/engine/interpret', role, body: { text } }], method: 'GET', path: '/actions/pending', role: 'accountant' }); try { const p = body(res).pending || []; return JSON.parse(p[p.length - 1].payload); } catch (e) { return {}; } };
  const isHeld = (res, cap) => status(res) === 200 && body(res).status === 'held' && body(res).understood && body(res).understood.capability === cap && noFacts(res) && JSON.stringify(tables(res)) === HELD;
  const isRead = (res, cap) => status(res) === 200 && body(res).understood && body(res).understood.capability === cap && noFacts(res) && !tables(res).includes('pending_actions');
  const TODAY = /^\d{4}-\d{2}-\d{2}$/;

  // ---- 1. THE WORLD ITSELF IS SOUND (so a failure below is the interpreter's) ---------------------------------------------------------------------------------------------------------------------------------------------------
  let r = await kit.route({ env: ENV_A, before: [SEED, ...WORLD], method: 'GET', path: '/engine/stock', role: 'accountant' });
  const rows = ((body(r).result || {}).stock || []); check(rows.length === 4 && rows.find((x) => x.itemId === 1).quantityMilli === 14000 && rows.find((x) => x.itemId === 3).quantityMilli === 20000, 'the test world has 14 sheets of Plywood 18mm (10 in the store, 4 in the van), 20 boxes of screws in the store, and none of Plywood 12mm');

  // ---- 2. ISSUING STOCK ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  r = await interpret('Used 3 sheets of Plywood 18mm on the Mokoena lounge from the main store');
  check(isHeld(r, 'stock.issue'), 'issuing stock for a job is HELD and writes only the capture, the interpretation and the held action: no stock moves until a person approves');
  let h = await heldPayload('Used 3 sheets of Plywood 18mm on the Mokoena lounge from the main store');
  check(h.itemId === 1 && h.locationId === 1 && h.quantityMilli === 3000 && h.reason === 'job' && h.jobRef === 'Mokoena lounge' && TODAY.test(h.issuedOn) && h.valueMinor === 60000 && Object.keys(h).sort().join() === 'issuedOn,itemId,jobRef,locationId,quantityMilli,reason,valueMinor', 'the held payload is exactly what the engine builds: the item and place resolved to their numbers, 3 sheets as 3000 thousandths, reason job with the job as its reference, today\'s date from the engine, and the value the ENGINE worked out (R600.00) for the approver to see');
  h = await heldPayload('Used 2 boxes of screws');
  check(h.itemId === 3 && h.locationId === 1 && h.quantityMilli === 2000 && h.reason === 'use' && h.jobRef === undefined, 'with no place named, the only place that holds the item is used (screws are only in the store); with no job the reason is use and there is no reference');
  r = await interpret('Used 2 sheets of plywood 18mm without saying where from');
  check(status(r) === 422 && body(r).error === 'invalid_input' && /Which location/.test(body(r).message) && /Main store/.test(body(r).message) && /Bakkie 1/.test(body(r).message) && noFacts(r) && !tables(r).includes('pending_actions'), 'with the item in TWO places and none named, the engine asks which (listing them) and holds nothing');
  h = await heldPayload('Used 2.5 boxes of screws'); check(h.quantityMilli === 2500, 'a decimal quantity is turned into thousandths: 2.5 is 2500');
  r = await interpret('Used 3 sheets of Plywood 18mm from the shed'); check(status(r) === 404 && body(r).error === 'not_found' && /shed/.test(body(r).message) && noFacts(r) && !tables(r).includes('pending_actions'), 'a place that does not exist is not_found, naming it, and nothing is held');
  for (const [text, why] of [['Used 0.0005 of screws', 'a quantity finer than a thousandth'], ['Used no sheets of screws', 'a quantity of zero'], ['Used minus two screws', 'a negative quantity'], ['Used some screws', 'no quantity at all'], ['Used two screws written out', 'a quantity written as a word'], ['Used a million and one screws', 'a quantity above a million']]) { r = await interpret(text); check(NOT(r), `${why} is NOT UNDERSTOOD (a capture and an observation only)`); }
  h = await heldPayload('Used 2 of PLY-18 by its code'); check(h.itemId === 1, 'an item can be named by its code, in any case');
  r = await interpret('Used 2 of plywood');
  check(status(r) === 200 && body(r).understood.capability === 'stock.issue' && !tables(r).includes('pending_actions') && JSON.stringify(body(r)).includes('Plywood 18mm') && JSON.stringify(body(r)).includes('Plywood 12mm') && noFacts(r), 'two items match "plywood": the engine returns BOTH to choose from and holds nothing (never a guess)');
  r = await interpret('Used 2 of unobtainium'); check(status(r) === 404 && body(r).error === 'not_found' && /unobtainium/i.test(body(r).message) && noFacts(r) && !tables(r).includes('pending_actions'), 'an item that does not exist is not_found, naming it');
  r = await interpret('Used too many'); check(status(r) === 409 && body(r).error === 'invalid_state' && noFacts(r) && !tables(r).includes('pending_actions'), 'issuing more than is there is refused by the engine\'s own rules (nothing is held)');
  for (const text of ['Used 1 with an item number', 'Used 1 with a date', 'Used 1 with a reason']) { r = await interpret(text); check(NOT(r), `"${text}": an argument the model was not given (an id, a date, a reason) makes the whole reading NOT UNDERSTOOD, never silently trimmed`); }

  // the harness runs the worker on its own fixed clock, so "today" is what the ENGINE says it is (a date the model could not have named): every handler must agree with it
  const todayStr = (await heldPayload('Used 2 boxes of screws')).issuedOn;
  check(TODAY.test(todayStr) && todayStr !== '2020-01-01', 'an issue is dated by the engine\'s clock, in the form of a date');
  h = await heldPayload('Moved 2 sheets of Plywood 18mm from the main store to the van'); check(h.movedOn === todayStr, 'a transfer is dated the same day by the same clock');
  h = await heldPayload('Counted 8 sheets of Plywood 18mm in the main store'); check(h.countedOn === todayStr, 'and a count');
  h = await heldPayload('Set aside 3 sheets of Plywood 18mm for the Dlamini kitchen'); check(h.reservedOn === todayStr, 'and a reservation');
  r = await interpret('Used 1 of the retired screws'); check(status(r) === 404 && body(r).error === 'not_found' && /retired screws/i.test(body(r).message) && noFacts(r) && !tables(r).includes('pending_actions'), 'an item that has been made inactive is not offered: it is as if it did not exist');
  r = await interpret('Used 1 of plywood 12mm with no stock'); check(status(r) === 422 && body(r).error === 'invalid_input' && /Which location/.test(body(r).message), 'an item held nowhere, in a business with two places, asks which place (it does not guess one)');
  const ONE = [prop('item.create', { sku: 'PLY-12', name: 'Plywood 12mm', unit: 'sheet' }), confirm(1), prop('location.create', { name: 'Only store', kind: 'warehouse' }), confirm(2)];
  r = await interpret('Used 1 of plywood 12mm with no stock', { before: ONE }); check(status(r) === 409 && body(r).error === 'invalid_state' && noFacts(r) && !tables(r).includes('pending_actions'), 'a business with ONE place uses it without asking (the engine then refuses because nothing is there): it does not ask "which location"');
  // ---- 3. MOVING STOCK ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  r = await interpret('Moved 2 sheets of Plywood 18mm from the main store to the van'); check(isHeld(r, 'stock.transfer'), 'a transfer is HELD and moves nothing');
  h = await heldPayload('Moved 2 sheets of Plywood 18mm from the main store to the van'); check(h.itemId === 1 && h.fromLocationId === 1 && h.toLocationId === 2 && h.quantityMilli === 2000 && TODAY.test(h.movedOn) && Object.keys(h).sort().join() === 'fromLocationId,itemId,movedOn,quantityMilli,toLocationId', 'the held transfer: item and both places resolved, 2000 thousandths, today\'s date');
  r = await interpret('Moved 2 sheets to the same place'); check(status(r) >= 400 && noFacts(r) && !tables(r).includes('pending_actions'), 'moving stock to the place it is already in is refused by the engine and nothing is held');
  r = await interpret('Moved 2 sheets from nowhere'); check(NOT(r), 'a transfer that does not say where from is NOT UNDERSTOOD');
  r = await interpret('Moved 2 sheets to the moon'); check(status(r) === 404 && body(r).error === 'not_found' && /moon/i.test(body(r).message) && noFacts(r), 'a destination that does not exist is not_found');

  // ---- 4. COUNTING -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  r = await interpret('Counted 8 sheets of Plywood 18mm in the main store'); check(isHeld(r, 'stock.count'), 'a count is HELD: no adjustment is made until a person approves');
  h = await heldPayload('Counted 8 sheets of Plywood 18mm in the main store');
  check(h.locationId === 1 && TODAY.test(h.countedOn) && h.lines.length === 1 && h.lines[0].itemId === 1 && h.lines[0].countedMilli === 8000 && h.variances && h.variances[0].bookMilli === 10000 && h.variances[0].differenceMilli === -2000, 'the held count carries the variance the ENGINE worked out (book 10, counted 8, 2 short), shown to the person who approves');
  h = await heldPayload('Counted none of the screws'); check(h.lines[0].countedMilli === 0 && h.variances[0].differenceMilli === -20000, 'a count of none is allowed (everything of it written off at the approval)');
  for (const text of ['Counted minus one of the screws', 'Counted the screws without a number']) { r = await interpret(text); check(NOT(r), `"${text}" is NOT UNDERSTOOD`); }

  // ---- 5. SETTING STOCK ASIDE --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  r = await interpret('Set aside 3 sheets of Plywood 18mm for the Dlamini kitchen'); check(isHeld(r, 'stock.reserve'), 'a reservation is HELD');
  h = await heldPayload('Set aside 3 sheets of Plywood 18mm for the Dlamini kitchen'); check(h.itemId === 1 && h.quantityMilli === 3000 && h.forRef === 'Dlamini kitchen' && TODAY.test(h.reservedOn) && h.locationId === undefined && Object.keys(h).sort().join() === 'forRef,itemId,quantityMilli,reservedOn', 'the held reservation: the item, 3000 thousandths, the job as its reference, today, and no place (it is the item\'s stock that is set aside)');
  r = await interpret('Set aside 3 sheets with no job'); check(NOT(r), 'setting stock aside without saying what for is NOT UNDERSTOOD');
  r = await interpret('Set aside far too many'); check(status(r) === 409 && body(r).error === 'invalid_state' && noFacts(r) && !tables(r).includes('pending_actions'), 'setting aside more than is available is refused by the engine and nothing is held');

  // ---- 6. THE READS ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  r = await interpret('How many sheets of Plywood 18mm do we have?'); check(isRead(r, 'stock.on_hand') && JSON.stringify(body(r)).includes('14000'), 'how much of an item is in stock is a READ: the engine\'s answer (14 sheets), no write');
  r = await interpret('What stock do we have?'); check(isRead(r, 'stock.on_hand') && JSON.stringify(body(r)).includes('Screws 50mm') && JSON.stringify(body(r)).includes('Plywood 18mm'), 'with no item named, all the stock is read');
  r = await interpret('How much plywood do we have?'); check(status(r) === 200 && body(r).understood.capability === 'stock.on_hand' && noFacts(r) && !tables(r).includes('pending_actions') && JSON.stringify(body(r)).includes('Plywood 12mm'), 'a read that names an ambiguous item returns the matching items to choose from');
  r = await interpret('How much unobtainium do we have?'); check(status(r) === 404 && body(r).error === 'not_found' && noFacts(r), 'a read for an item that does not exist is not_found');
  r = await interpret('What do we need to order?'); check(isRead(r, 'stock.reorder_suggestions') && Array.isArray((body(r).result || {}).suggestions) && (body(r).result || {}).stock === undefined, 'what to reorder is a READ, and the answer is the reorder list (not the stock list)');
  r = await interpret('What do we charge for Plywood 18mm?'); check(isRead(r, 'prices.find') && Array.isArray((body(r).result || {}).prices) && (body(r).result || {}).stock === undefined, 'what an item sells for is a READ, and the answer is the price list\'s (not the stock\'s)');

  // ---- 7. WHAT THE MODEL IS NEVER OFFERED -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  for (const text of ['Bought 5 sheets of plywood at R200', 'Write down the plywood', 'Damaged 2 sheets', 'Customer returned 1 sheet', 'Set the price of plywood', 'Add a new item', 'Release the reservation', 'Approve the stock issue']) { r = await interpret(text); check(NOT(r), `"${text}": a capability the model is not offered (receive, write-down, adjust, return, price, create, release, approve) is NOT UNDERSTOOD even when the model asks for it`); }

  // ---- 8. WHO MAY ASK ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  // what each role may do is the ENGINE's answer (the same permission rules as every other client): ask it directly, then require the model route to agree
  const direct = async (role) => kit.route({ env: ENV_A, before: [SEED, ...WORLD], method: 'POST', path: '/engine/proposals', role, body: { capability: 'stock.issue', payload: { itemId: 3, locationId: 1, quantityMilli: 1000, issuedOn: '2026-11-12', reason: 'use' }, transcript: 'direct' } });
  for (const role of ['installer', 'sales']) {
    const may = status(await direct(role)) === 200; r = await interpret('Used 2 boxes of screws', { role });
    check(may ? isHeld(r, 'stock.issue') : (NOT(r) || status(r) === 403), `${role} ${may ? 'may' : 'may not'} issue stock directly, and through the model the answer is the same (${may ? 'held' : 'not understood or refused, never held'})`);
  }
  r = await interpret('What do we charge for Plywood 18mm?', { role: 'installer' }); check(NOT(r) || status(r) === 403 || isRead(r, 'prices.find'), 'prices are offered only to those who may read them');
  r = await interpret('Used 2 boxes of screws', { ai: [{ match: /./, reply: () => { throw new Error('boom'); } }] }); check(status(r) === 503 && body(r).error === 'model_unavailable' && noFacts(r) && tables(r).length === 0, 'a model that cannot be reached writes nothing at all');
  r = await kit.route({ env: ENV_A, ai: SCRIPT, before: [SEED, ...WORLD, { method: 'POST', path: '/engine/interpret', role: 'accountant', body: { text: 'Used 2 boxes of screws' } }], method: 'POST', path: `/actions/${n + 1}/confirm`, role: 'installer', body: {} });
  check(status(r) === 403 || status(r) === 404, 'whatever the model proposed, an installer cannot approve it');
});

if (require.main === module) kit.standalone(module.exports);
