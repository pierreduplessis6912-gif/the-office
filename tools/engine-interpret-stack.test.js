// A MODEL AS ONE MORE INTERPRETER, extended to the capabilities built since the first slice (docs/decisions/interpreter-stack.md; the REAL model run is held until Pierre says "run it"). TESTS FIRST. Expected state when first committed: RED.
// Like engine-interpret.test.js this runs with a SCRIPTED model (the harness's stand-in for env.AI), so CI never calls a real model: it pins what the route does with whatever a model says. The rules that carry over: the model is shown only the
// capabilities this business has and this member may use, and the sentence (no business data); what it chooses goes through the SAME door as any client; a read is a read, a write is PROPOSED and HELD (it can never approve); anything outside the
// catalogue or malformed is NOT UNDERSTOOD, answered honestly, with only a capture and an observation. New in this file: the model supplies WORDS (a name, an amount in cents, whether VAT was stated, a category), never an id, a tax rate or a date;
// the engine resolves the names, works the tax and the dates out, and VAT is never assumed: a sentence that does not say whether an amount includes VAT is not understood.
const kit = require('./engine-kit.js');

module.exports = kit.guard('engine interpret (stack)', async ({ check }) => {
  const ENV_A = { BUSINESS_ID: 'eng-a', ENGINE_REHEARSAL: '1' };
  const SEED = { admin: true, method: 'POST', path: '/admin/engine/provision-sample', body: { confirm: 'eng-a' } };
  const call = (capability, args) => JSON.stringify(capability === null ? { capability: null } : { capability, arguments: args });
  const say = (re, reply) => ({ match: re, reply: () => reply });
  const asSupplier = (name, vat) => [
    { method: 'POST', path: '/engine/proposals', role: 'accountant', body: { capability: 'party.create', payload: { kind: 'organisation', name, roles: ['supplier'], ...(vat ? { contact: { vatNumber: vat } } : {}) }, transcript: 'seed' } },
  ];
  const confirm = (id) => ({ method: 'POST', path: `/actions/${id}/confirm`, role: 'accountant', body: {} });
  const SUPPLIERS = [...asSupplier('Timber Supplies', '4111111111'), confirm(1), ...asSupplier('Tile Warehouse', '4222222222').map((s) => s), confirm(2), ...asSupplier('Tile Wholesalers'), confirm(3)];
  const SCRIPT = [
    say(/Who is Patel\?/, call('parties.find', { name: 'Patel' })),
    say(/List my suppliers/, call('parties.find', { role: 'supplier' })),
    say(/Who are my customers and suppliers\?/, call('parties.find', {})),
    say(/Add Dlamini Timber as a supplier/, call('party.create', { name: 'Dlamini Timber', role: 'supplier' })),
    say(/Add Sipho Ndlovu as a customer, phone 082 555 0101/, call('party.create', { name: 'Sipho Ndlovu', role: 'customer', kind: 'person', phone: '+27 82 555 0101' })),
    say(/Add Bad Email as a customer/, call('party.create', { name: 'Bad Email', role: 'customer', email: 'not an email' })),
    say(/Add Someone with no role/, call('party.create', { name: 'Someone' })),
    say(/Add Someone as a banana/, call('party.create', { name: 'Someone', role: 'banana' })),
    say(/Bought plywood from Timber Supplies for R230 including VAT, paid by EFT, I have the invoice/, call('expense.record', { supplier: 'Timber Supplies', amountCents: 23000, vat: 'incl_vat', description: 'Plywood', category: 'materials', method: 'eft', invoiceHeld: true })),
    say(/Bought plywood from Timber Supplies for R200 plus VAT, paid cash/, call('expense.record', { supplier: 'Timber Supplies', amountCents: 20000, vat: 'plus_vat', description: 'Plywood', category: 'materials', method: 'cash' })),
    say(/Bought screws from Timber Supplies for R50, no VAT, yesterday/, call('expense.record', { supplier: 'Timber Supplies', amountCents: 5000, vat: 'no_vat', description: 'Screws', category: 'materials', method: 'cash', when: 'yesterday' })),
    say(/Bought plywood from Timber Supplies for R230/, call('expense.record', { supplier: 'Timber Supplies', amountCents: 23000, description: 'Plywood', category: 'materials', method: 'eft' })),
    say(/Bought tiles from Tile for R1000 including VAT/, call('expense.record', { supplier: 'Tile', amountCents: 100000, vat: 'incl_vat', description: 'Tiles', category: 'materials', method: 'eft' })),
    say(/Bought glue from Nobody Ltd for R100 including VAT/, call('expense.record', { supplier: 'Nobody Ltd', amountCents: 10000, vat: 'incl_vat', description: 'Glue', category: 'materials', method: 'eft' })),
    say(/Bought glue from Patel Builders for R100 including VAT/, call('expense.record', { supplier: 'Patel Builders', amountCents: 10000, vat: 'incl_vat', description: 'Glue', category: 'materials', method: 'eft' })),
    say(/Client lunch R115 including VAT/, call('expense.record', { supplier: 'Timber Supplies', amountCents: 11500, vat: 'incl_vat', description: 'Client lunch', category: 'entertainment', method: 'card' })),
    say(/Bought groceries R115 including VAT/, call('expense.record', { supplier: 'Timber Supplies', amountCents: 11500, vat: 'incl_vat', description: 'Groceries', category: 'groceries', method: 'card' })),
    say(/negative expense/, call('expense.record', { supplier: 'Timber Supplies', amountCents: -100, vat: 'incl_vat', description: 'x', category: 'materials', method: 'eft' })),
    say(/enormous expense/, call('expense.record', { supplier: 'Timber Supplies', amountCents: 1000000000000000, vat: 'incl_vat', description: 'x', category: 'materials', method: 'eft' })),
    say(/expense with a tax rate/, JSON.stringify({ capability: 'expense.record', arguments: { supplier: 'Timber Supplies', amountCents: 100, vat: 'incl_vat', description: 'x', category: 'materials', method: 'eft', taxBp: 0 } })),
    say(/expense with a supplier id/, JSON.stringify({ capability: 'expense.record', arguments: { supplier: 'Timber Supplies', supplierId: 2, amountCents: 100, vat: 'incl_vat', description: 'x', category: 'materials', method: 'eft' } })),
    say(/What is my VAT this month\?/, call('vat.summary', { period: 'this_month' })),
    say(/What was my VAT last month\?/, call('vat.summary', { period: 'last_month' })),
    say(/What is my VAT\?/, call('vat.summary', {})),
    say(/VAT for next century/, call('vat.summary', { period: 'next_century' })),
    say(/What did I spend on fuel last month\?/, call('expenses.find', { category: 'fuel', period: 'last_month' })),
    say(/Show my expenses/, call('expenses.find', {})),
    say(/Show expenses for groceries/, call('expenses.find', { category: 'groceries' })),
    say(/Quotes for Mokoena/, call('quotations.find', { customer: 'Mokoena' })),
    say(/Quotes for Nobody/, call('quotations.find', { customer: 'Nobody' })),
    say(/Issue a credit note to Mokoena/, call('credit_note.issue', { customer: 'Mokoena' })),
    say(/Approve expense 1/, call('expense.confirm', { actionId: 1 })),
    say(/Pay Timber Supplies R500/, call(null)),
  ];
  const interpret = (text, opts = {}) => kit.route({ env: ENV_A, ai: opts.ai || SCRIPT, before: [SEED, ...(opts.before || [])], method: 'POST', path: '/engine/interpret', role: opts.role || 'accountant', body: opts.body || { text } });
  const added = (res, t) => ((res.writes && res.writes[t] && res.writes[t].added) || []).length;
  const tables = (res) => Object.keys(res.writes || {}).filter((t) => added(res, t) > 0).sort();
  const body = (res) => (res.result && res.result.body) || {};
  const status = (res) => res.result && res.result.status;
  const noFacts = (res) => ['eng_party', 'eng_document', 'eng_document_line', 'eng_money_movement', 'eng_allocation', 'eng_reversal', 'eng_event'].every((t) => added(res, t) === 0);
  const heldPayload = async (text, before = SUPPLIERS) => { const res = await kit.route({ env: ENV_A, ai: SCRIPT, before: [SEED, ...before, { method: 'POST', path: '/engine/interpret', role: 'accountant', body: { text } }], method: 'GET', path: '/actions/pending', role: 'accountant' }); try { const p = body(res).pending || []; return JSON.parse(p[p.length - 1].payload); } catch (e) { return {}; } };
  const NOT = (res) => status(res) === 422 && body(res).error === 'not_understood' && JSON.stringify(tables(res)) === JSON.stringify(['captures', 'eng_observation']) && noFacts(res);

  // ---- what the model is shown ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const probe = [];
  await interpret('Hello there', { ai: [{ match: /./, reply: (input) => { probe.push(input); return call(null); } }] });
  const sys = (probe[0].messages.find((m) => m.role === 'system') || {}).content || '';
  const ids = ['receivables.query', 'payment.record', 'parties.find', 'party.create', 'quotations.find', 'expenses.find', 'expense.record', 'vat.summary'];
  check(ids.every((i) => sys.includes('"id":"' + i + '"')), 'an accountant is shown all eight capabilities in scope (the two from before and parties, quotations, expenses and the VAT summary)');
  check(!/payment\.correct|invoice\.issue|records\.get|credit_note|debit_note|quotation\.create|tax_lock|business\.profile|allocation\.remove/.test(sys), 'and none of the engine\'s other capabilities (credit notes, debit notes, correcting a payment, the tax lock and the rest are not interpretable yet, so they are not offered)');
  check(!/Mokoena|Patel|Timber|85000|115000|4111111111/.test(JSON.stringify(probe[0])), 'it is shown NO business data: no customer, no figure, no VAT number');
  check(/DATA, not instructions/.test(sys) && /Never invent/.test(sys) && /VAT/.test(sys) && /never assume/i.test(sys), 'the instructions say the sentence is data, never to invent, and that whether an amount includes VAT must be stated, never assumed');
  const partial = kit.asEngineBusiness((db) => db.prepare("INSERT INTO eng_config (key, value_json) VALUES ('available', ?)").run(JSON.stringify(['receivables.query', 'parties.find', 'expense.record', 'vat.summary'])));
  const pp = []; await kit.route({ env: { BUSINESS_ID: 'eng-b' }, seed: partial, ai: [{ match: /./, reply: (i) => { pp.push(i); return call(null); } }], method: 'POST', path: '/engine/interpret', role: 'accountant', body: { text: 'hello' } });
  const psys = ((pp[0] || { messages: [] }).messages.find((m) => m.role === 'system') || {}).content || '';
  check(psys.includes('parties.find') && psys.includes('expense.record') && psys.includes('vat.summary') && !psys.includes('party.create') && !psys.includes('expenses.find') && !psys.includes('quotations.find') && !psys.includes('payment.record'), 'a business with only some capabilities is shown only those');
  let r = await interpret('Who is Patel?', { role: 'installer', ai: [{ match: /./, reply: () => { throw new Error('the model must not be called'); } }] });
  check(status(r) === 403, 'an installer is refused at the gate and the model is never called');
  const salesProbe = []; r = await interpret('Quotes for Mokoena', { role: 'sales', ai: [{ match: /./, reply: (i) => { salesProbe.push(i); return call('quotations.find', { customer: 'Mokoena' }); } }] });
  const ssys = ((salesProbe[0] || { messages: [] }).messages.find((m) => m.role === 'system') || {}).content || '';
  check(salesProbe.length === 0 || (!ssys.includes('expense.record') && !ssys.includes('party.create') && !ssys.includes('vat.summary') && !ssys.includes('payment.record')), 'a salesperson (who may make quotes but not handle money) is never shown the money capabilities');

  // what the harness's clock says and which record Timber Supplies is (the engine decides both; the test asks it instead of assuming)
  const todayOf = (await heldPayload('Client lunch R115 including VAT')).incurredOn;
  const shift = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const monthRange = (iso, back) => { const t = new Date(iso + 'T00:00:00Z'); const f = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() - back, 1)); const l = new Date(Date.UTC(f.getUTCFullYear(), f.getUTCMonth() + 1, 0)); return { from: f.toISOString().slice(0, 10), to: l.toISOString().slice(0, 10) }; };
  const listed = await interpret('List my suppliers', { before: SUPPLIERS });
  const TIMBER = ((body(listed).result.parties || []).find((p) => p.name === 'Timber Supplies') || {}).id;
  check(/^\d{4}-\d{2}-\d{2}$/.test(todayOf) && Number.isInteger(TIMBER), 'set-up: the clock and the supplier record are read from the engine');
  check(/person if the name is a person's name/.test(sys) && /JSON boolean true/.test(sys) && /never a date/.test(sys), 'the prompt tells the model how to give a kind (a person\'s name is a person), that invoiceHeld is a JSON boolean, and that "when" is a word and never a date (found necessary by the first real model run)');
  const dbgR = await interpret('garbled reply', { ai: [{ match: /./, reply: () => 'I think you probably mean something about money' }] });
  check(status(dbgR) === 422 && body(dbgR).debug && /something about money/.test(body(dbgR).debug.modelReply), 'in a REHEARSAL (staging) a sentence that is not understood also shows what the model replied, so a real run can be diagnosed');
  const prodNU = await kit.route({ env: { BUSINESS_ID: 'eng-b' }, seed: kit.asEngineBusiness((db) => db.prepare("INSERT INTO eng_config (key, value_json) VALUES ('available', ?)").run(JSON.stringify(['receivables.query', 'parties.find']))), ai: [{ match: /./, reply: () => 'nonsense from the model' }], method: 'POST', path: '/engine/interpret', role: 'accountant', body: { text: 'hello' } });
  check(status(prodNU) === 422 && body(prodNU).error === 'not_understood' && body(prodNU).debug === undefined && !/nonsense/.test(JSON.stringify(body(prodNU))), 'but outside a rehearsal (a real business) the model\'s reply is NEVER shown');
  // ---- reads ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  r = await interpret('Who is Patel?');
  check(status(r) === 200 && body(r).status === 'ok' && body(r).understood.capability === 'parties.find' && (body(r).result.parties || []).length === 1 && body(r).result.parties[0].name === 'Patel Builders' && tables(r).length === 0, '"Who is Patel?" is answered by the engine (Patel Builders), labelled as understood by a model, and writes nothing');
  r = await interpret('List my suppliers', { before: SUPPLIERS });
  check(status(r) === 200 && (body(r).result.parties || []).map((p) => p.name).sort().join('|') === 'Tile Warehouse|Tile Wholesalers|Timber Supplies', 'finding suppliers lists only suppliers');
  r = await interpret('Who are my customers and suppliers?');
  check(status(r) === 200 && (body(r).result.parties || []).length >= 2, 'an empty filter lists everyone');
  const direct = async (rng) => body(await kit.route({ env: ENV_A, before: [SEED], method: 'GET', path: `/engine/vat?from=${rng.from}&to=${rng.to}`, role: 'accountant' })).result;
  r = await interpret('What is my VAT this month?');
  const tm = monthRange(todayOf, 0), lm = monthRange(todayOf, 1);
  check(status(r) === 200 && body(r).understood.capability === 'vat.summary' && body(r).result.period.from === tm.from && body(r).result.period.to === tm.to && tables(r).length === 0, `"my VAT this month" is the engine's VAT summary for the calendar month the ENGINE worked out from today (${tm.from} to ${tm.to}), not dates the model made up; and it writes nothing`);
  const dtm = await direct(tm);
  check(body(r).result.field1Minor === dtm.field1Minor && body(r).result.field4Minor === dtm.field4Minor && body(r).result.netVatMinor === dtm.netVatMinor, 'and its figures are exactly what the engine returns when asked directly');
  r = await interpret('What was my VAT last month?');
  const dlm = await direct(lm);
  check(status(r) === 200 && body(r).result.period.from === lm.from && body(r).result.period.to === lm.to && body(r).result.field1Minor === dlm.field1Minor && body(r).result.field4Minor === dlm.field4Minor, `last month (${lm.from} to ${lm.to}) is the engine's own figure for that month`);
  r = await interpret('What is my VAT?'); check(NOT(r), 'a VAT question with no period is not understood (the person is asked, nothing is guessed)');
  r = await interpret('VAT for next century'); check(NOT(r), 'a period the catalogue does not have is not understood');
  r = await interpret('What did I spend on fuel last month?');
  check(status(r) === 200 && body(r).understood.capability === 'expenses.find' && Array.isArray(body(r).result.expenses) && tables(r).length === 0, 'an expenses question is answered by the engine and writes nothing');
  r = await interpret('Show my expenses'); check(status(r) === 200 && Array.isArray(body(r).result.expenses), 'expenses with no filter lists them all');
  r = await interpret('Show expenses for groceries'); check(NOT(r), 'a category that is not on the list is not understood');
  r = await interpret('Quotes for Mokoena');
  check(status(r) === 200 && body(r).understood.capability === 'quotations.find' && Array.isArray(body(r).result.quotations) && tables(r).length === 0, 'a quotations question resolves the customer by name and is answered by the engine');
  r = await interpret('Quotes for Nobody'); check(status(r) === 404 && !tables(r).includes('pending_actions'), 'a customer who does not exist is answered as unknown, and nothing is held');

  // ---- party.create: proposed and held ------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  r = await interpret('Add Dlamini Timber as a supplier');
  check(status(r) === 200 && body(r).status === 'held' && body(r).understood.capability === 'party.create' && noFacts(r) && JSON.stringify(tables(r)) === JSON.stringify(['captures', 'eng_interpretation', 'pending_actions']), 'adding a supplier is HELD and writes only the capture, the interpretation and the held action: no party is created');
  let h = await heldPayload('Add Dlamini Timber as a supplier');
  check(h.name === 'Dlamini Timber' && JSON.stringify(h.roles) === JSON.stringify(['supplier']) && h.kind === 'organisation', 'the held payload is exactly what the engine builds: the name, the role, and a kind of organisation by default (shown to the person who approves)');
  h = await heldPayload('Add Sipho Ndlovu as a customer, phone 082 555 0101');
  check(h.name === 'Sipho Ndlovu' && h.kind === 'person' && h.contact && h.contact.phone === '+27 82 555 0101', 'a person with a phone number is held with their contact detail');
  r = await interpret('Add Bad Email as a customer'); check(status(r) === 422 && body(r).error === 'invalid_payload' && !tables(r).includes('pending_actions') && noFacts(r), 'an invalid email is refused by the engine\'s own validation: nothing is held');
  r = await interpret('Add Someone with no role'); check(NOT(r), 'a new party with no role named is not understood');
  r = await interpret('Add Someone as a banana'); check(NOT(r), 'a role that is neither customer nor supplier is not understood');
  r = await interpret('Add Dlamini Timber as a supplier', { before: [...asSupplier('Dlamini Timber'), confirm(1)] }); check(status(r) === 409 && body(r).error === 'duplicate' && !tables(r).includes('pending_actions'), 'a name that already exists is refused as a duplicate (the engine\'s rule), nothing held');

  // ---- expense.record: the model supplies words, the engine works out the rest ------------------------------------------------------------------------------------------------------------------------------------
  r = await interpret('Bought plywood from Timber Supplies for R230 including VAT, paid by EFT, I have the invoice', { before: SUPPLIERS });
  check(status(r) === 200 && body(r).status === 'held' && body(r).understood.capability === 'expense.record' && noFacts(r) && JSON.stringify(tables(r)) === JSON.stringify(['captures', 'eng_interpretation', 'pending_actions']), 'an expense is HELD: no document, no money movement, no event until a person approves');
  h = await heldPayload('Bought plywood from Timber Supplies for R230 including VAT, paid by EFT, I have the invoice');
  check(h.supplierId === TIMBER && h.amountsIncludeTax === true && h.amountPaidMinor === 23000 && h.lines[0].amountMinor === 23000 && h.lines[0].taxBp === 1500 && h.category === 'materials' && h.method === 'eft' && h.taxInvoiceHeld === true && h.currency === 'ZAR' && h.incurredOn === todayOf && h.totals && h.totals.taxMinor === 3000, 'the held payload: the supplier RESOLVED to a record by the engine, R230.00 including 15% VAT (tax R30.00 worked out by the engine), the date from today, paid by EFT, tax invoice held');
  h = await heldPayload('Bought plywood from Timber Supplies for R200 plus VAT, paid cash');
  check(h.amountsIncludeTax === false && h.lines[0].amountMinor === 20000 && h.amountPaidMinor === 23000 && h.taxInvoiceHeld === false && h.method === 'cash', '"plus VAT" is net R200.00 with tax added: R230.00 paid; and a tax invoice is NOT assumed to be held (the safe default: it is not claimed until someone says so)');
  h = await heldPayload('Bought screws from Timber Supplies for R50, no VAT, yesterday');
  check(h.lines[0].taxBp === 0 && h.amountPaidMinor === 5000 && h.incurredOn === shift(todayOf, -1), '"no VAT" is a 0% line, and "yesterday" is the day before today, worked out by the engine');
  r = await interpret('Bought plywood from Timber Supplies for R230', { before: SUPPLIERS }); check(NOT(r), 'an amount with no statement of VAT is not understood: VAT is never assumed');
  r = await interpret('Bought tiles from Tile for R1000 including VAT', { before: SUPPLIERS });
  check(status(r) === 200 && body(r).status === 'ok' && (body(r).result.parties || []).length === 2 && !tables(r).includes('pending_actions') && noFacts(r), 'a supplier name that matches two suppliers (Tile Warehouse, Tile Wholesalers) answers with the engine\'s list to choose from; nothing is held or guessed');
  r = await interpret('Bought glue from Nobody Ltd for R100 including VAT', { before: SUPPLIERS }); check(status(r) === 404 && !tables(r).includes('pending_actions') && noFacts(r), 'a supplier who does not exist is answered as unknown (never created silently), and nothing is held');
  r = await interpret('Bought glue from Patel Builders for R100 including VAT', { before: SUPPLIERS }); check(status(r) === 404 && !tables(r).includes('pending_actions'), 'a customer who is not a supplier is not found as one');
  h = await heldPayload('Client lunch R115 including VAT');
  check(h.category === 'entertainment', 'a client lunch is held as entertainment (the engine will then say the input tax is not claimable: s17(2))');
  r = await interpret('Bought groceries R115 including VAT', { before: SUPPLIERS }); check(NOT(r), 'a category that is not on the list is not understood');
  for (const [text, why] of [['negative expense', 'a negative amount'], ['enormous expense', 'an absurd amount (above R10,000,000)'], ['expense with a tax rate', 'a tax rate the model was never given'], ['expense with a supplier id', 'an id the model was never given']]) { r = await interpret(text, { before: SUPPLIERS }); check(NOT(r), `${why} is not understood: nothing held`); }

  // ---- the rails that never move -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  r = await interpret('Issue a credit note to Mokoena'); check(NOT(r), 'a capability the interpreter does not offer yet (a credit note) is not understood even if a model names it');
  r = await interpret('Approve expense 1'); check(NOT(r), 'a model talked into an "approve" call is not understood: there is none to choose');
  r = await interpret('Pay Timber Supplies R500', { before: SUPPLIERS }); check(NOT(r), 'something outside the catalogue (paying a supplier) is not understood');
  const pend = await kit.route({ env: ENV_A, ai: SCRIPT, before: [SEED, ...SUPPLIERS, { method: 'POST', path: '/engine/interpret', role: 'accountant', body: { text: 'Bought plywood from Timber Supplies for R230 including VAT, paid by EFT, I have the invoice' } }], method: 'GET', path: '/engine/expenses', role: 'accountant' });
  check(status(pend) === 200 && (body(pend).result.expenses || []).length === 0, 'and after a model-proposed expense that nobody approved, there is still no expense in the books');
  const approved = await kit.route({ env: ENV_A, ai: SCRIPT, before: [SEED, ...SUPPLIERS, { method: 'POST', path: '/engine/interpret', role: 'accountant', body: { text: 'Bought plywood from Timber Supplies for R230 including VAT, paid by EFT, I have the invoice' } }, confirm(4)], method: 'GET', path: '/engine/expenses', role: 'accountant' });
  const ex = ((body(approved).result || {}).expenses || [])[0] || {};
  check(ex.grossMinor === 23000 && ex.taxMinor === 3000 && ex.inputTaxClaimable === false && /VAT registered/.test((ex.inputTaxReasons || []).join(' ')), 'once a person approves it, the expense is recorded exactly as held (R230.00, tax R30.00); and the engine, not the model, says the input tax is not yet claimable (the business profile has no VAT registration)');
});

if (require.main === module) kit.standalone(module.exports);
