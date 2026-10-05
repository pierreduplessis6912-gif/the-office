// Characterization cases for lookups (intent "lookup"): the business-wide questions, a customer, a supplier or installer,
// a material's last price, today's schedule, and the delivery exception question. A lookup is mostly code that gathers
// facts, gated by what the asking role may see, then hands them to a model that words the answer. The answer-writer is
// scripted to ECHO the facts it receives, so each recording shows exactly which facts each role's answer was built from:
// that is the part that matters, because it is where permissions are enforced (or not).
module.exports = function cases(caps) {
  const memberSelectionDdl = "CREATE TABLE IF NOT EXISTS member_selections (member TEXT NOT NULL, key TEXT NOT NULL, entity_id INTEGER NOT NULL, label TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (member, key))";
  const books = (db) => db.exec(`
    INSERT INTO people (name) VALUES ('Jenny Smith'), ('Thandi Mokoena');
    INSERT INTO customers (name, person_id) VALUES ('Jenny Smith', 1), ('Thandi Mokoena', 2);
    INSERT INTO characters (name, relationship) VALUES ('Floornet', 'supplier'), ('Jabulani', 'installer');
    INSERT INTO invoices (id, customer_id, description, amount, created_at) VALUES (1, 1, 'Lounge laminate', 5000, '2026-08-01 08:00:00'), (2, 2, 'Bedroom carpet', 8000, '2026-09-20 08:00:00');
    INSERT INTO payments (customer_id, amount, source_transcript, invoice_id, created_at) VALUES (1, 2000, 'Jenny paid R2000', 1, '2026-08-15 08:00:00');
    INSERT INTO quotations (customer_id, description, amount, status, created_at) VALUES (1, 'Kitchen vinyl', 12000, 'draft', '2026-09-25 08:00:00');
    INSERT INTO expenses (character_id, amount, description, source_transcript, category, customer_id, created_at) VALUES (1, 1200, 'adhesive', 'bought adhesive', 'materials', 1, '2026-08-05 08:00:00'), (NULL, 650, 'diesel', 'diesel', 'fuel', NULL, '2026-09-30 08:00:00');
    INSERT INTO job_scopes (id, customer_id, description, installer_id, scheduled_date, scheduled_date_raw, created_at) VALUES (1, 1, 'Lounge laminate', 2, '2026-10-03', 'today', '2026-09-01 08:00:00');
    INSERT INTO tasks (description, done, completed_at, created_at) VALUES ('order underlay', 1, '2026-10-03 09:00:00', '2026-10-02 08:00:00');
    INSERT INTO customer_facts (customer_id, key, value) VALUES (1, 'phone', '082 555 0101');
    INSERT INTO character_facts (character_id, key, value) VALUES (2, 'cell', '083 555 0202');
  `);
  // The same books, plus a purchase order that was delivered short and an unordered delivery: two open exceptions.
  const withExceptions = (db) => {
    books(db);
    db.exec(`
      INSERT INTO purchase_orders (id, supplier_id, description, created_at) VALUES (1, 1, 'Vinyl and underlay', '2026-10-01 08:00:00');
      INSERT INTO po_line_items (id, purchase_order_id, description, quantity_ordered, unit) VALUES (1, 1, 'Vinyl', 50, 'sqm'), (2, 1, 'Underlay', 100, 'sqm');
      INSERT INTO goods_received_notes (id, purchase_order_id, supplier_id, created_at) VALUES (1, 1, 1, '2026-10-02 09:00:00');
      INSERT INTO grn_line_items (grn_id, po_line_item_id, description, quantity_received, quantity_ordered, variance) VALUES (1, 1, 'Vinyl', 50, 50, 0), (1, 2, 'Underlay', 50, 100, -50), (1, NULL, 'Grout [bag]', 5, 0, 5);
    `);
  };
  const withPriceHistory = (db) => {
    books(db);
    db.exec(`
      INSERT INTO supplier_invoices (id, supplier_id, supplier_reference, amount, created_at) VALUES (1, 1, 'INV-1', 9250, '2026-09-10 08:00:00');
      INSERT INTO supplier_invoice_line_items (supplier_invoice_id, description, quantity_billed, unit_price_billed, line_total) VALUES (1, 'Vinyl', 50, 185, 9250);
    `);
  };
  // A supplier note written before the notes fix: it still contains the words of a supplier payment.
  const oldMoneyNote = JSON.stringify({ facts: [{ text: 'paid Floornet R10000', storedAt: '2026-09-01T10:00:00.000Z' }, { text: 'prefers morning deliveries', storedAt: '2026-09-02T10:00:00.000Z' }] });
  const customerNote = JSON.stringify({ facts: [{ text: 'has a dog, keep the gate closed', storedAt: '2026-09-01T10:00:00.000Z' }] });

  // The saved unit conversions can be asked for in words (decided 2026-10-04). The table is created by the code the first time it is needed.
  const unitConversionDdl = "CREATE TABLE IF NOT EXISTS unit_conversions (item_key TEXT NOT NULL, from_unit TEXT NOT NULL, to_unit TEXT NOT NULL, factor REAL NOT NULL, set_by TEXT, updated_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (item_key, from_unit, to_unit))";
  const someConversions = (db) => { books(db); db.exec(unitConversionDdl + "; INSERT INTO unit_conversions (item_key, from_unit, to_unit, factor) VALUES ('laminate', 'box', 'sqm', 2.2), ('quickstep laminate', 'box', 'sqm', 3), ('underlay', 'roll', 'sqm', 15);"); };
  // Recorded supplier statements can be asked for (decided 2026-10-04). The table is created by the code the first time it is needed.
  const supplierStatementDdl = "CREATE TABLE IF NOT EXISTS supplier_statements (id INTEGER PRIMARY KEY AUTOINCREMENT, supplier_id INTEGER NOT NULL, claimed_balance REAL NOT NULL, books_balance REAL NOT NULL, difference REAL NOT NULL, source TEXT NOT NULL, source_text TEXT, recorded_by TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))";
  const someStatements = (db) => {
    books(db);
    db.exec(`INSERT INTO characters (name, relationship) VALUES ('Belgotex', 'supplier'); ` + supplierStatementDdl + `; INSERT INTO supplier_statements (supplier_id, claimed_balance, books_balance, difference, source, source_text, recorded_by, created_at) VALUES
      (1, 12000, 11000, 1000, 'spoken', 'Floornet says we owe them R12000', 'owner@example.com', '2026-10-01 08:00:00'),
      (1, 11000, 11000, 0, 'document', NULL, NULL, '2026-10-02 08:00:00'),
      (1, 10500, 11000, -500, 'photo', NULL, NULL, '2026-10-03 08:00:00'),
      ((SELECT id FROM characters WHERE name = 'Belgotex'), 4000, 4000, 0, 'spoken', 'Belgotex says 4000', 'owner@example.com', '2026-10-02 09:00:00');`);
  };
  // Jabulani's details include a day rate and a bank account (decided 2026-10-04: payroll and banking details need their own permission).
  const sensitiveDetails = (db) => { books(db); db.exec("INSERT INTO character_facts (character_id, key, value, created_at) VALUES (2, 'day_rate', 'R600 a day', '2026-09-01 08:00:00'), (2, 'bank_account', 'FNB 62012345678', '2026-09-02 08:00:00');"); };
  const DASH = (reply) => ({ match: /broad, whole-business question wanting a real, visual snapshot/, reply });
  const TOPIC = (reply) => ({ match: /standing topic of the conversation below/, reply });
  const ANSWER = { match: /Answer the tradesperson's question using only the facts below/, reply: (input) => 'ANSWER FROM FACTS:\n' + ((input.messages.find((m) => m.role === 'system').content.split('Facts:\n')[1]) || '') };
  const boom = () => { throw new Error('model unavailable'); };
  const prior = [{ role: 'user', text: 'who owes me money' }, { role: 'office', text: 'Jenny owes R3000.' }];
  const c = (name, role, seed, extraction, transcript, ai, extra) => ({ name, seed, transcript, extraction: { intent: 'lookup', ...extraction }, capabilities: caps[role], ai, ...(extra || {}) });

  return [
    // ---------------- a material's last price ----------------
    c('lookup: owner, the last price paid for a material', 'owner', withPriceHistory, { query_scope: 'material_price', fact_value: 'vinyl' }, 'what did we last pay for vinyl', []),
    c('lookup: owner, a material nobody has been invoiced for', 'owner', withPriceHistory, { query_scope: 'material_price', fact_value: 'grout' }, 'what did we last pay for grout', []),
    c('lookup: installer, the last price paid for a material', 'installer', withPriceHistory, { query_scope: 'material_price', fact_value: 'vinyl' }, 'what did we last pay for vinyl', []),

    // ---------------- the recorded supplier statements ----------------
    c('lookup supplier statements: one supplier, newest first', 'owner', someStatements, { query_scope: 'supplier_statements', character_name: 'Floornet', character_relationship: 'supplier' }, 'what did Floornet claim we owe', []),
    c('lookup supplier statements: every supplier', 'owner', someStatements, { query_scope: 'supplier_statements' }, 'what have the suppliers claimed', []),
    c('lookup supplier statements: none recorded for that supplier', 'owner', (db) => { someStatements(db); db.exec("INSERT INTO characters (name, relationship) VALUES ('Quiet Supplies', 'supplier');"); }, { query_scope: 'supplier_statements', character_name: 'Quiet Supplies', character_relationship: 'supplier' }, 'what did Quiet Supplies claim', []),
    c('lookup supplier statements: none recorded at all', 'owner', books, { query_scope: 'supplier_statements' }, 'what have the suppliers claimed', []),
    c('lookup supplier statements: accountant', 'accountant', someStatements, { query_scope: 'supplier_statements', character_name: 'Floornet', character_relationship: 'supplier' }, 'what did Floornet claim we owe', []),
    c('lookup supplier statements: installer is told it is restricted', 'installer', someStatements, { query_scope: 'supplier_statements', character_name: 'Floornet', character_relationship: 'supplier' }, 'what did Floornet claim we owe', []),

    // ---------------- the saved unit conversions ----------------
    c('lookup unit conversions: owner, all of them', 'owner', someConversions, { query_scope: 'unit_conversions' }, 'what conversions do I have', []),
    c('lookup unit conversions: one material', 'owner', someConversions, { query_scope: 'unit_conversions', fact_value: 'laminate' }, 'how many square metres in a box of laminate', []),
    c('lookup unit conversions: a material with none saved', 'owner', someConversions, { query_scope: 'unit_conversions', fact_value: 'grout' }, 'how many square metres in a box of grout', []),
    c('lookup unit conversions: none saved at all', 'owner', books, { query_scope: 'unit_conversions' }, 'what conversions do I have', []),
    c('lookup unit conversions: installer', 'installer', someConversions, { query_scope: 'unit_conversions' }, 'what conversions do I have', []),
    c('lookup unit conversions: a role with no permissions is told it is restricted', 'stranger', someConversions, { query_scope: 'unit_conversions' }, 'what conversions do I have', []),
    c('lookup unit conversions: a customer on screen is not borrowed as the subject', 'owner', (db) => { someConversions(db); db.exec(memberSelectionDdl + "; INSERT INTO member_selections (member, key, entity_id, label, updated_at) VALUES ('owner@example.com', 'customer', 1, 'Jenny Smith', '2026-10-03 11:00:00');"); }, { query_scope: 'unit_conversions' }, 'and what conversions do I have', []),

    // ---------------- the delivery exception question ----------------
    c('lookup: owner, delivery exceptions are open', 'owner', withExceptions, {}, 'any delivery exceptions?', []),
    c('lookup: owner, no delivery exceptions', 'owner', books, {}, 'any delivery exceptions?', []),
    c('lookup: accountant asks about delivery exceptions', 'accountant', withExceptions, {}, 'any delivery exceptions?', []),
    c('lookup: installer asking about delivery exceptions is told it is restricted', 'installer', withExceptions, {}, 'any delivery exceptions?', []),

    // ---------------- business-wide questions: which screen, or which facts ----------------
    c('lookup business: owner, a broad question opens the snapshot screen', 'owner', books, { query_scope: 'business' }, 'how are we doing', [DASH('FINANCIAL_SNAPSHOT')]),
    c('lookup business: owner, who owes me opens the aged debtors screen', 'owner', books, { query_scope: 'business' }, 'who owes me', [DASH('AGED_DEBTORS')]),
    c('lookup business: owner, an unclear broad question is asked back', 'owner', books, { query_scope: 'business' }, 'what is the money situation', [DASH('UNSURE')]),
    c('lookup business: installer, a broad question is told the overview is restricted (not sent to an empty screen)', 'installer', books, { query_scope: 'business' }, 'how are we doing', [DASH('FINANCIAL_SNAPSHOT')]),
    c('lookup business: installer, an unclear broad question is told it is restricted, not asked which screen', 'installer', books, { query_scope: 'business' }, 'what is the money situation', [DASH('UNSURE')]),
    c('lookup business: a role with no permissions, a broad question is told it is restricted', 'stranger', books, { query_scope: 'business' }, 'how are we doing', [DASH('FINANCIAL_SNAPSHOT')]),
    c('lookup business: accountant, a broad question opens the snapshot screen', 'accountant', books, { query_scope: 'business' }, 'how are we doing', [DASH('FINANCIAL_SNAPSHOT')]),
    c('lookup business: accountant, who owes me opens the aged debtors screen', 'accountant', books, { query_scope: 'business' }, 'who owes me', [DASH('AGED_DEBTORS')]),
    c('lookup business: installer, who owes me is told it is restricted', 'installer', books, { query_scope: 'business' }, 'who owes me', [DASH('AGED_DEBTORS')]),
    c('lookup business: owner, a broad question with two quotations on file reads in the plural', 'owner', (db) => { books(db); db.exec("INSERT INTO quotations (customer_id, description, amount, status, created_at) VALUES (2, 'Bedroom carpet', 8000, 'draft', '2026-09-26 08:00:00');"); }, { query_scope: 'business' }, 'and the quotes', [DASH('NONE'), TOPIC('QUOTATIONS'), ANSWER], { history: prior }),
    c('lookup business: owner, expenses with one on file read in the singular', 'owner', (db) => { books(db); db.exec("DELETE FROM expenses WHERE id = 2;"); }, { query_scope: 'business' }, 'and what we spent', [DASH('NONE'), TOPIC('EXPENSES'), ANSWER], { history: prior }),
    c('lookup business: owner, a narrow question, no history', 'owner', books, { query_scope: 'business' }, 'what is outstanding on the Lounge job', [DASH('NONE'), ANSWER]),
    c('lookup business: accountant, a narrow question', 'accountant', books, { query_scope: 'business' }, 'what is outstanding on the Lounge job', [DASH('NONE'), ANSWER]),
    c('lookup business: installer, a narrow question', 'installer', books, { query_scope: 'business' }, 'what is outstanding on the Lounge job', [DASH('NONE'), ANSWER]),
    c('lookup business: a role with no permissions, a narrow question', 'stranger', books, { query_scope: 'business' }, 'what is outstanding on the Lounge job', [DASH('NONE'), ANSWER]),
    c('lookup business: owner, a follow-up about quotations', 'owner', books, { query_scope: 'business' }, 'and what about the quotes', [DASH('NONE'), TOPIC('QUOTATIONS'), ANSWER], { history: prior }),
    c('lookup business: owner, a follow-up about invoices', 'owner', books, { query_scope: 'business' }, 'and the invoices', [DASH('NONE'), TOPIC('INVOICES'), ANSWER], { history: prior }),
    c('lookup business: owner, a follow-up about expenses', 'owner', books, { query_scope: 'business' }, 'and what we spent', [DASH('NONE'), TOPIC('EXPENSES'), ANSWER], { history: prior }),
    c('lookup business: installer, a follow-up about invoices', 'installer', books, { query_scope: 'business' }, 'and the invoices', [DASH('NONE'), TOPIC('INVOICES'), ANSWER], { history: prior }),
    c('lookup business: installer, a follow-up about expenses', 'installer', books, { query_scope: 'business' }, 'and what we spent', [DASH('NONE'), TOPIC('EXPENSES'), ANSWER], { history: prior }),
    c('lookup business: accountant, a follow-up about expenses', 'accountant', books, { query_scope: 'business' }, 'and what we spent', [DASH('NONE'), TOPIC('EXPENSES'), ANSWER], { history: prior }),
    c('lookup business: owner, asked for the aged breakdown already, so no hint is added', 'owner', books, { query_scope: 'business' }, 'what is overdue on the Lounge job', [DASH('NONE'), ANSWER]),
    c('lookup business: owner, the classifier fails', 'owner', books, { query_scope: 'business' }, 'what is outstanding on the Lounge job', [DASH(boom), ANSWER]),
    c('lookup business: owner, the answer-writer fails', 'owner', books, { query_scope: 'business' }, 'what is outstanding on the Lounge job', [DASH('NONE'), { match: ANSWER.match, reply: boom }]),

    // ---------------- a supplier or installer ----------------
    c('lookup character: owner, a supplier with an old note that still holds a payment', 'owner', books, { character_name: 'Floornet', character_relationship: 'supplier' }, 'how is Floornet doing', [ANSWER], { kvSeed: { 'character:1': oldMoneyNote } }),
    c('lookup character: installer, the same supplier and the same old note', 'installer', books, { character_name: 'Floornet', character_relationship: 'supplier' }, 'how is Floornet doing', [ANSWER], { kvSeed: { 'character:1': oldMoneyNote } }),
    c('lookup character: owner, an installer with jobs and details', 'owner', books, { character_name: 'Jabulani', character_relationship: 'installer' }, 'how is Jabulani doing', [ANSWER]),
    c('lookup character: accountant, an installer (job activity is restricted)', 'accountant', books, { character_name: 'Jabulani', character_relationship: 'installer' }, 'how is Jabulani doing', [ANSWER]),
    c('lookup character details: owner sees the pay and bank details', 'owner', sensitiveDetails, { character_name: 'Jabulani', character_relationship: 'installer' }, 'how is Jabulani doing', [ANSWER]),
    c('lookup character details: accountant (payroll and banking access) sees them too', 'accountant', sensitiveDetails, { character_name: 'Jabulani', character_relationship: 'installer' }, 'how is Jabulani doing', [ANSWER]),
    c('lookup character details: installer sees only the ordinary details', 'installer', sensitiveDetails, { character_name: 'Jabulani', character_relationship: 'installer' }, 'how is Jabulani doing', [ANSWER]),
    c('lookup character details: a role with no permissions sees only the ordinary details', 'stranger', sensitiveDetails, { character_name: 'Jabulani', character_relationship: 'installer' }, 'how is Jabulani doing', [ANSWER]),
    c('lookup character: a role with no permissions', 'stranger', books, { character_name: 'Jabulani', character_relationship: 'installer' }, 'how is Jabulani doing', [ANSWER]),
    c('lookup character: owner, a name nobody has heard of', 'owner', books, { character_name: 'Nobody Known', character_relationship: 'supplier' }, 'how is Nobody Known doing', [ANSWER]),

    // ---------------- a customer ----------------
    c('lookup customer: owner', 'owner', books, { customer_name: 'Jenny Smith' }, 'how is Jenny doing', [ANSWER], { kvSeed: { 'customer:1': customerNote } }),
    c('lookup customer: accountant', 'accountant', books, { customer_name: 'Jenny Smith' }, 'how is Jenny doing', [ANSWER], { kvSeed: { 'customer:1': customerNote } }),
    c('lookup customer: installer', 'installer', books, { customer_name: 'Jenny Smith' }, 'how is Jenny doing', [ANSWER], { kvSeed: { 'customer:1': customerNote } }),
    c('lookup customer: a role with no permissions', 'stranger', books, { customer_name: 'Jenny Smith' }, 'how is Jenny doing', [ANSWER], { kvSeed: { 'customer:1': customerNote } }),
    c('lookup customer: owner, a customer with nothing on file', 'owner', books, { customer_name: 'Thandi Mokoena' }, 'how is Thandi doing', [ANSWER]),

    // ---------------- no one named: today ----------------
    c('lookup today: owner, what is on', 'owner', books, {}, 'what is on today', [ANSWER]),
    c('lookup today: installer, what is on', 'installer', books, {}, 'what is on today', [ANSWER]),
    c('lookup today: nothing at all on file', 'owner', (db) => db.exec("INSERT INTO characters (name, relationship) VALUES ('Floornet', 'supplier');"), {}, 'what is on today', [ANSWER]),
  ];
};
