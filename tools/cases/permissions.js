// Characterization cases for the permission grid's API (GET/PATCH /settings/permissions, POST .../reset, GET .../audit), run
// through the real request handler and the real auth gate. The point of the grid is that switching something changes what a
// role can do and see, so most cases are EFFECTS: the owner flips a switch, then the other role makes a request that the
// switch governs, with a control case for the default beside it. Hostile stored rows are cases too.
module.exports = function cases(caps) {
  const DEFAULTS = { customer_name: null, character_name: null, character_relationship: null, intent: 'other', amount: null, fact_key: null, fact_value: null, personal_note: null, query_scope: null, deposit_percent: null, scope_document_type: null, due_date_raw: null };
  const base = (db) => db.exec(`
    INSERT INTO people (name) VALUES ('Jenny Smith');
    INSERT INTO customers (name, person_id) VALUES ('Jenny Smith', 1);
    INSERT INTO stock_items (name, unit, quantity_on_hand) VALUES ('Screed', 'bags', 15);
    INSERT INTO invoices (id, customer_id, description, amount, created_at) VALUES (1, 1, 'Lounge laminate', 5000, '2026-08-01 08:00:00');
    INSERT INTO payments (customer_id, amount, source_transcript, invoice_id, created_at) VALUES (1, 2000, 'Jenny paid R2000', 1, '2026-08-15 08:00:00');
    INSERT INTO projects (id, customer_id, description, created_at) VALUES (1, 1, 'Kitchen refit', '2026-09-01 08:00:00');
  `);
  const TABLES = `
    CREATE TABLE IF NOT EXISTS role_capability_overrides (role TEXT NOT NULL, capability TEXT NOT NULL, granted INTEGER NOT NULL, updated_by TEXT, updated_at TEXT, PRIMARY KEY (role, capability));
    CREATE TABLE IF NOT EXISTS permission_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, changed_by TEXT, role TEXT NOT NULL, capability TEXT NOT NULL, old_granted INTEGER, new_granted INTEGER, created_at TEXT);
  `;
  // Rows nobody should be able to write through the screen, written by hand: they must change nothing.
  const tampered = (db) => {
    base(db);
    db.exec(TABLES + `
      INSERT INTO role_capability_overrides (role, capability, granted) VALUES
        ('installer', 'can_manage_settings', 1), ('installer', 'can_delete_data', 1), ('installer', 'can_know_measurements', 1), ('installer', 'can_do_anything', 1),
        ('accountant', 'can_manage_settings', 1), ('owner', 'can_manage_settings', 0), ('owner', 'can_manage_invoices', 0);
    `);
  };
  const SPLIT = (reply) => ({ match: /Find genuinely SEPARATE topics and split/, reply });
  const READ = (bySegment) => ({ match: /Extract structured facts from a tradesperson's message/, reply: (input) => {
    const seg = input.messages.find((m) => m.role === 'user').content;
    if (!(seg in bySegment)) throw new Error('no scripted reading for: ' + seg);
    return { ...DEFAULTS, ...bySegment[seg] };
  } });
  const DASH = (reply) => ({ match: /broad, whole-business question wanting a real, visual snapshot/, reply });
  const ANSWER = { match: /Answer the tradesperson's question using only the facts below/, reply: (input) => 'ANSWER FROM FACTS:\n' + ((input.messages.find((m) => m.role === 'system').content.split('Facts:\n')[1]) || '') };

  const patch = (role, capability, granted, who) => ({ route: true, method: 'PATCH', path: '/settings/permissions', role: who || 'owner', body: { role, capability, granted } });
  const say = (transcript, extraction) => ({ say: true, transcript, extraction });
  const r = (name, o) => ({ kind: 'route', name, seed: o.seed || base, method: o.method || 'GET', path: o.path, body: o.body, role: o.role || 'owner', before: o.before || [], ai: o.ai, ...(o.noSession ? { noSession: true } : {}) });
  const GRID = '/settings/permissions';
  const lookup = { text: 'how are we doing in rands' };
  const lookupAi = [SPLIT([lookup.text]), READ({ [lookup.text]: { intent: 'lookup', query_scope: 'business' } }), DASH('NONE'), ANSWER];
  const price = { text: 'what did we last pay for vinyl' };
  const priceAi = [SPLIT([price.text]), READ({ [price.text]: { intent: 'lookup', query_scope: 'material_price', fact_value: 'vinyl' } })];
  const payment = say('Jenny paid R500', { intent: 'payment', customer_name: 'Jenny Smith', amount: 500 });

  return [
    // ---------------- reading the grid ----------------
    r('grid: the owner reads both roles', { path: GRID }),
    r('grid: an accountant cannot read it', { path: GRID, role: 'accountant' }),
    r('grid: an installer cannot read it', { path: GRID, role: 'installer' }),
    r('grid: signed out', { path: GRID, noSession: true }),

    // ---------------- changing it ----------------
    r('grid: the owner takes materials away from the installer', { method: 'PATCH', path: GRID, body: { role: 'installer', capability: 'can_know_materials', granted: false } }),
    r('grid: the owner gives the installer money in and out', { method: 'PATCH', path: GRID, body: { role: 'installer', capability: 'can_manage_invoices', granted: true } }),
    r('grid: setting something to what it already is changes nothing', { method: 'PATCH', path: GRID, body: { role: 'installer', capability: 'can_know_materials', granted: false }, before: [patch('installer', 'can_know_materials', false)] }),
    r('grid: switching back to the default removes the override', { method: 'PATCH', path: GRID, body: { role: 'installer', capability: 'can_know_materials', granted: true }, before: [patch('installer', 'can_know_materials', false)] }),
    r('grid: an accountant cannot change it', { method: 'PATCH', path: GRID, role: 'accountant', body: { role: 'installer', capability: 'can_manage_invoices', granted: true } }),
    r('grid: an installer cannot give themselves money', { method: 'PATCH', path: GRID, role: 'installer', body: { role: 'installer', capability: 'can_manage_invoices', granted: true } }),

    // ---------------- what it refuses ----------------
    r('refused: the owner\'s own permissions', { method: 'PATCH', path: GRID, body: { role: 'owner', capability: 'can_know_profit', granted: false } }),
    r('refused: a role that does not exist', { method: 'PATCH', path: GRID, body: { role: 'plumber', capability: 'can_know_profit', granted: true } }),
    r('refused: a permission that does not exist', { method: 'PATCH', path: GRID, body: { role: 'installer', capability: 'can_do_anything', granted: true } }),
    r('refused: an owner-only permission cannot be given away', { method: 'PATCH', path: GRID, body: { role: 'installer', capability: 'can_manage_settings', granted: true } }),
    r('refused: a permission nothing uses yet cannot be switched', { method: 'PATCH', path: GRID, body: { role: 'accountant', capability: 'can_know_measurements', granted: false } }),
    r('refused: the answer must be true or false', { method: 'PATCH', path: GRID, body: { role: 'installer', capability: 'can_know_jobs', granted: 'yes' } }),
    r('refused: no request body', { method: 'PATCH', path: GRID }),

    // ---------------- the effects: a switch changes what a role can do and see ----------------
    r('control: by default an installer can open the stock room', { path: '/stock', role: 'installer' }),
    r('effect: taking materials away stops an installer opening the stock room', { path: '/stock', role: 'installer', before: [patch('installer', 'can_know_materials', false)] }),
    r('control: by default an accountant cannot open projects', { path: '/projects', role: 'accountant' }),
    r('effect: giving an accountant jobs lets them open projects', { path: '/projects', role: 'accountant', before: [patch('accountant', 'can_know_jobs', true)] }),
    r('control: by default an accountant can confirm a payment', { method: 'POST', path: '/actions/1/confirm', role: 'accountant', before: [payment] }),
    r('effect: taking money away stops an accountant confirming a payment', { method: 'POST', path: '/actions/1/confirm', role: 'accountant', before: [payment, patch('accountant', 'can_manage_invoices', false)] }),
    r('control: by default an installer cannot confirm a payment', { method: 'POST', path: '/actions/1/confirm', role: 'installer', before: [payment] }),
    r('effect: giving an installer money lets them confirm a payment', { method: 'POST', path: '/actions/1/confirm', role: 'installer', before: [payment, patch('installer', 'can_manage_invoices', true)] }),
    r('control: by default an accountant\'s business question shows the financial snapshot', { method: 'POST', path: '/messages/text', role: 'accountant', body: lookup, ai: lookupAi }),
    r('effect: taking profit away changes what an accountant\'s business question shows', { method: 'POST', path: '/messages/text', role: 'accountant', body: lookup, ai: lookupAi, before: [patch('accountant', 'can_know_profit', false)] }),
    r('control: by default an installer\'s business question hides expenses and balances', { method: 'POST', path: '/messages/text', role: 'installer', body: lookup, ai: lookupAi }),
    r('effect: giving an installer money shows them expenses and balances', { method: 'POST', path: '/messages/text', role: 'installer', body: lookup, ai: lookupAi, before: [patch('installer', 'can_manage_invoices', true)] }),

    // ---------------- the finer switches (decided 2026-10-04): expense totals, supplier balances, material prices ----------------
    r('effect: taking only expense totals away hides expenses but leaves the supplier balances', { method: 'POST', path: '/messages/text', role: 'accountant', body: lookup, ai: lookupAi, before: [patch('accountant', 'can_know_expense_totals', false)] }),
    r('effect: taking only supplier balances away hides what we owe suppliers but leaves expenses', { method: 'POST', path: '/messages/text', role: 'accountant', body: lookup, ai: lookupAi, before: [patch('accountant', 'can_know_supplier_balances', false)] }),
    r('effect: taking money away from an accountant also hides expenses and supplier balances (they follow it)', { method: 'POST', path: '/messages/text', role: 'accountant', body: lookup, ai: lookupAi, before: [patch('accountant', 'can_manage_invoices', false)] }),
    r('effect: money taken away but expense totals switched on shows expenses and still hides supplier balances', { method: 'POST', path: '/messages/text', role: 'accountant', body: lookup, ai: lookupAi, before: [patch('accountant', 'can_manage_invoices', false), patch('accountant', 'can_know_expense_totals', true)] }),
    r('effect: giving an installer only expense totals shows them expenses and still hides balances and quotations', { method: 'POST', path: '/messages/text', role: 'installer', body: lookup, ai: lookupAi, before: [patch('installer', 'can_know_expense_totals', true)] }),
    r('control: by default an accountant can open the suppliers screen', { path: '/embers/suppliers', role: 'accountant' }),
    r('effect: taking supplier balances away stops an accountant opening the suppliers screen', { path: '/embers/suppliers', role: 'accountant', before: [patch('accountant', 'can_know_supplier_balances', false)] }),
    r('effect: taking money away also stops an accountant opening the suppliers screen (supplier balances follow it)', { path: '/embers/suppliers', role: 'accountant', before: [patch('accountant', 'can_manage_invoices', false)] }),
    r('control: by default an installer cannot open the suppliers screen', { path: '/embers/suppliers', role: 'installer' }),
    r('effect: giving an installer supplier balances lets them open the suppliers screen without money in and out', { path: '/embers/suppliers', role: 'installer', before: [patch('installer', 'can_know_supplier_balances', true)] }),
    r('control: by default an accountant can open the expenses screen', { path: '/embers/expenses', role: 'accountant' }),
    r('effect: taking only expense totals away leaves the expenses screen open through profit access', { path: '/embers/expenses', role: 'accountant', before: [patch('accountant', 'can_know_expense_totals', false)] }),
    r('effect: taking expense totals AND profit away closes the expenses screen', { path: '/embers/expenses', role: 'accountant', before: [patch('accountant', 'can_know_expense_totals', false), patch('accountant', 'can_know_profit', false)] }),
    r('control: by default an installer cannot open the expenses screen', { path: '/embers/expenses', role: 'installer' }),
    r('effect: giving an installer expense totals opens the expenses screen', { path: '/embers/expenses', role: 'installer', before: [patch('installer', 'can_know_expense_totals', true)] }),
    r('control: by default an installer can ask the last price paid for a material', { method: 'POST', path: '/messages/text', role: 'installer', body: price, ai: priceAi }),
    r('effect: taking material prices away stops an installer asking the last price paid', { method: 'POST', path: '/messages/text', role: 'installer', body: price, ai: priceAi, before: [patch('installer', 'can_know_material_prices', false)] }),
    r('effect: taking material prices away from the accountant stops them asking too', { method: 'POST', path: '/messages/text', role: 'accountant', body: price, ai: priceAi, before: [patch('accountant', 'can_know_material_prices', false)] }),
    r('grid: with money taken away, switching expense totals on and then off again leaves no setting of its own', { method: 'PATCH', path: GRID, body: { role: 'accountant', capability: 'can_know_expense_totals', granted: false }, before: [patch('accountant', 'can_manage_invoices', false), patch('accountant', 'can_know_expense_totals', true)] }),
    r('grid: with money taken away, switching expense totals on stores a setting of its own', { method: 'PATCH', path: GRID, body: { role: 'accountant', capability: 'can_know_expense_totals', granted: true }, before: [patch('accountant', 'can_manage_invoices', false)] }),
    r('reset: undoes an explicit expense totals setting, which follows money again', { method: 'POST', path: GRID + '/reset', body: { role: 'accountant' }, before: [patch('accountant', 'can_manage_invoices', false), patch('accountant', 'can_know_expense_totals', true)] }),
    r('grid: the owner reads the new switches for both roles after taking money away', { path: GRID, before: [patch('accountant', 'can_manage_invoices', false)] }),

    // ---------------- stray rows can never widen access or lock the owner out ----------------
    r('tampered rows: the grid shows nothing changed', { path: GRID, seed: tampered }),
    r('tampered rows: an installer still cannot open the owner-only leads', { path: '/leads', role: 'installer', seed: tampered }),
    r('tampered rows: an accountant still cannot open the owner-only leads', { path: '/leads', role: 'accountant', seed: tampered }),
    r('tampered rows: the owner can still open the grid', { path: GRID, role: 'owner', seed: tampered }),
    r('tampered rows: the owner can still open leads', { path: '/leads', role: 'owner', seed: tampered }),

    // ---------------- the audit trail and reset ----------------
    r('audit: nothing has changed yet', { path: '/settings/permissions/audit' }),
    r('audit: the newest change is first', { path: '/settings/permissions/audit', before: [patch('installer', 'can_know_materials', false), patch('accountant', 'can_know_profit', false)] }),
    r('audit: the list can be limited', { path: '/settings/permissions/audit?limit=1', before: [patch('installer', 'can_know_materials', false), patch('accountant', 'can_know_profit', false)] }),
    r('audit: a change that did nothing is not logged', { path: '/settings/permissions/audit', before: [patch('installer', 'can_know_materials', true)] }),
    r('audit: an installer cannot read it', { path: '/settings/permissions/audit', role: 'installer' }),
    r('reset: an installer\'s changes are all undone', { method: 'POST', path: GRID + '/reset', body: { role: 'installer' }, before: [patch('installer', 'can_know_materials', false), patch('installer', 'can_manage_invoices', true), patch('accountant', 'can_know_profit', false)] }),
    r('reset: nothing to undo', { method: 'POST', path: GRID + '/reset', body: { role: 'installer' } }),
    r('reset: a role that does not exist', { method: 'POST', path: GRID + '/reset', body: { role: 'plumber' } }),
    r('reset: the owner cannot be reset', { method: 'POST', path: GRID + '/reset', body: { role: 'owner' } }),
    r('reset: an installer cannot reset anything', { method: 'POST', path: GRID + '/reset', role: 'installer', body: { role: 'installer' } }),
  ];
};
