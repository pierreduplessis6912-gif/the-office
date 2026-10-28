// Decisions an assistant may confirm that change stock or a customer's details, and the owner's undo of them (worker/src/mcp-effects.ts, mcp-pending.ts, mcp-undo.ts; routes in index.ts). SECURITY-SENSITIVE: an assistant may only confirm a kind because the owner can put it back, so every guard here is proven by a deliberate breakage (tools/mcp-effects-breakage.js). THE RULES: (1) a confirmation a connection proposed is tagged with exactly what it changed (a copy kept at that moment); one the owner made in the app is not; (2) an undo puts back exactly that and nothing else; (3) an undo is REFUSED, writing nothing, when the thing was used, counted or changed again since; (4) a rejected or failed decision tags nothing; (5) the owner's list shows these decisions and whether they can still be undone.
const path = require('path');

module.exports = async function runEffectsTests({ check, srcDir }) {
  const harness = require('./harness.js'), workerDir = path.join(srcDir, '..'), fns = await harness.loadFunctions(workerDir);
  const ENV = { BUSINESS_ID: 'acme-co' };
  const route = (spec) => harness.runRouteCase(fns, workerDir, { env: ENV, ...spec });
  const DDL = [
    "CREATE TABLE IF NOT EXISTS mcp_created_records (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL DEFAULT (datetime('now')), create_id INTEGER NOT NULL, key_id TEXT NOT NULL, tbl TEXT NOT NULL, rec_id INTEGER NOT NULL, undone_at TEXT, undone_by TEXT, snapshot TEXT, UNIQUE (tbl, rec_id))",
    "CREATE TABLE IF NOT EXISTS mcp_pending_links (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL DEFAULT (datetime('now')), pending_id INTEGER NOT NULL UNIQUE, key_id TEXT NOT NULL, create_id INTEGER NOT NULL, type TEXT NOT NULL, summary TEXT, status TEXT NOT NULL DEFAULT 'waiting', resolved_at TEXT, resolved_by TEXT)",
    "CREATE TABLE IF NOT EXISTS mcp_keys (id TEXT PRIMARY KEY, label TEXT NOT NULL, email TEXT NOT NULL, hash TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), created_by TEXT NOT NULL, last_used_at TEXT, revoked_at TEXT, uses INTEGER NOT NULL DEFAULT 0, scope TEXT)",
  ];
  const held = (db, type, payload, linked) => { const id = Number(db.prepare("INSERT INTO pending_actions (type, payload, source_transcript, status) VALUES (?, ?, 'said by a connector', 'pending')").run(type, JSON.stringify(payload)).lastInsertRowid); if (linked) db.prepare("INSERT INTO mcp_pending_links (pending_id, key_id, create_id, type, summary) VALUES (?, 'k1', 7, ?, 's')").run(id, type); return id; };
  // a business with stock, one customer, and held decisions: 1 stock add (linked), 2 stock add (the owner's own), 3 phone, 4 a loose fact
  const seed = (extra) => (db) => { db.exec('PRAGMA foreign_keys = OFF'); for (const d of DDL) db.exec(d);
    db.prepare("INSERT INTO mcp_keys (id, label, email, hash, created_by, scope) VALUES ('k1', 'Claude on my phone', 'owner@example.com', 'h', 'owner@example.com', 'mcp:write')").run();
    db.prepare("INSERT INTO customers (name) VALUES ('Jenny')").run();
    db.prepare("INSERT INTO stock_items (name, unit, quantity_on_hand) VALUES ('Vinyl planks', 'box', 4)").run();
    held(db, 'stock_add', { items: [{ name: 'Sample sets', unit: 'set', quantity: 2 }, { name: 'vinyl planks', unit: 'box', quantity: 3 }], supplierName: 'Hunter Douglas' }, true);
    held(db, 'stock_add', { items: [{ name: 'Glue', unit: 'tin', quantity: 1 }] }, false);
    held(db, 'customer_fact', { customerId: 1, key: 'phone_number', value: '079 012 8508' }, true);
    held(db, 'customer_fact', { customerId: 1, key: 'favourite colour', value: 'blue' }, true);
    if (extra) extra(db); };
  const decide = (id, what, spec = {}) => route({ name: `${what} ${id}`, method: 'POST', path: `/actions/${id}/${what}`, role: 'owner', seed: seed(), frontDoor: true, ...spec });
  const snap = (r, i = 0) => JSON.parse(r.writes.mcp_created_records.added[i].snapshot);

  // ---- confirming: tagged with exactly what changed ----
  { const r = await decide(1, 'confirm'), w = r.writes, s = w.mcp_created_records && w.mcp_created_records.added.length === 1 ? snap(r) : null;
    check(r.result.status === 200 && w.stock_items.added.length === 1 && w.stock_items.changed.length === 1 && s && w.mcp_created_records.added[0].tbl === 'stock_add' && w.mcp_created_records.added[0].rec_id === 1 && w.mcp_created_records.added[0].key_id === 'k1' && w.mcp_created_records.added[0].create_id === 7
      && s.effect === 'stock_add' && s.items.length === 2 && s.items.find((i) => i.name === 'Sample sets').created === true && s.items.find((i) => i.name === 'Sample sets').quantityAfter === 2 && s.items.find((i) => i.name === 'vinyl planks').created === false && s.items.find((i) => i.name === 'vinyl planks').quantityAfter === 7 && s.items.find((i) => i.name === 'vinyl planks').added === 3,
      'confirming a stock add a connection proposed adds the stock and tags it with what changed: a new item (created) and an existing one (not created) with the quantity after'); }
  { const r = await decide(2, 'confirm'); check(r.result.status === 200 && r.writes.stock_items.added.length === 1 && !r.writes.mcp_created_records && !r.writes.mcp_pending_links, 'a stock add NO connection proposed (the owner\'s own) is confirmed exactly as before and nothing is tagged'); }
  { const r = await decide(1, 'reject'); check(r.result.status === 200 && !r.writes.stock_items && !r.writes.mcp_created_records && r.writes.mcp_pending_links.changed[0].after.status === 'rejected', 'rejecting a stock add changes no stock and tags nothing'); }
  { const r = await decide(3, 'confirm'), w = r.writes, s = w.mcp_created_records ? snap(r) : null;
    check(r.result.status === 200 && s && w.mcp_created_records.added[0].tbl === 'customer_fact' && s.effect === 'customer_fact' && s.customerId === 1 && s.changes.length === 1 && s.changes[0].column === 'phone' && s.changes[0].before === null && /79 012 8508/.test(s.changes[0].after) && s.newFactIds.length === 1, 'confirming a phone number tags the customer detail: the phone column before (empty) and after, and the note it also saved'); }
  { const r = await decide(4, 'confirm'), s = r.writes.mcp_created_records ? snap(r) : null;
    check(r.result.status === 200 && s && s.changes.length === 0 && s.newFactIds.length === 1, 'confirming a loose fact (no column) tags only the saved note'); }
  { const r = await decide(3, 'confirm', { seed: seed((db) => db.prepare("UPDATE pending_actions SET payload = 'not json' WHERE id = 3").run()) });
    check(r.result.status >= 400 && !r.writes.mcp_created_records, 'a confirmation that FAILS tags nothing, so no undo claims to exist'); }

  { const r = await decide(5, 'confirm', { seed: seed((db) => held(db, 'stock_add', { items: [{ name: 'Nothing', unit: null, quantity: 0 }] }, true)) });
    check(r.result.status === 200 && !r.writes.stock_items && !r.writes.mcp_created_records, 'a stock add that adds nothing tags nothing, so no undo claims to exist for it'); }

  // ---- undoing ----
  const tag = (db, tbl, rec, snapshot) => db.prepare("INSERT INTO mcp_created_records (create_id, key_id, tbl, rec_id, snapshot) VALUES (7, 'k1', ?, ?, ?)").run(tbl, rec, JSON.stringify(snapshot));
  const stockWorld = (qtyVinyl = 7, qtySamples = 2, extra) => (db) => { seed()(db); db.prepare("UPDATE stock_items SET quantity_on_hand = ? WHERE id = 1").run(qtyVinyl); db.prepare("INSERT INTO stock_items (name, unit, quantity_on_hand) VALUES ('Sample sets', 'set', ?)").run(qtySamples);
    tag(db, 'stock_add', 1, { effect: 'stock_add', items: [{ stockItemId: 2, name: 'Sample sets', added: 2, created: true, quantityAfter: 2 }, { stockItemId: 1, name: 'vinyl planks', added: 3, created: false, quantityAfter: 7 }] }); if (extra) extra(db); };
  const undo = (id, seedFn, role = 'owner') => route({ name: `undo ${id}`, method: 'POST', path: '/mcp-created/undo', body: { id }, role, seed: seedFn });
  const unchanged = (r) => Object.keys(r.writes || {}).length === 0;
  { const r = await undo(1, stockWorld()), w = r.writes, b = r.result.body;
    check(r.result.status === 200 && b.ok === true && b.action === 'reversed' && b.kind === 'stock add' && w.stock_items.removed.length === 1 && w.stock_items.removed[0].name === 'Sample sets' && w.stock_items.changed.length === 1 && w.stock_items.changed[0].after.quantity_on_hand === 4 && w.mcp_created_records.changed[0].before.undone_by === null && w.mcp_created_records.changed[0].after.undone_by === 'owner@example.com',
      'undoing a stock add puts back exactly what it changed: the item it created is removed and the existing one goes back to its old quantity, and the tag is marked undone'); }
  { const r = await undo(1, stockWorld(5)); check(r.result.status === 409 && r.result.body.reason === 'blocked' && unchanged(r), 'a stock add is NOT undone when the stock has been used or counted since: a 409 and nothing is written (the other item is left alone too)'); }
  { const r = await undo(1, stockWorld(7, 2, (db) => db.prepare("INSERT INTO stock_usage_log (stock_item_id, quantity_used) VALUES (2, 0)").run())); check(r.result.status === 409 && unchanged(r), 'an item the add created is NOT removed once it has a usage record, even if its quantity looks the same'); }
  { const r = await undo(1, stockWorld(7, 2, (db) => db.prepare("DELETE FROM stock_items WHERE id = 2").run())); check(r.result.status === 409 && r.result.body.reason === 'gone' && unchanged(r), 'a stock item that no longer exists is refused as gone and nothing is written'); }
  { const r = await undo(1, stockWorld(7, 2, (db) => db.prepare("UPDATE mcp_created_records SET undone_at = datetime('now') WHERE id = 1").run())); check(r.result.status === 409 && r.result.body.reason === 'already_undone' && unchanged(r), 'a decision already undone cannot be undone twice: a 409 and nothing is written'); }
  { const bads = []; for (const role of ['accountant', 'installer', 'sales', 'admin']) { const r = await undo(1, stockWorld(), role); bads.push(r.result.status === 403 && unchanged(r)); } check(bads.every(Boolean), 'only the owner may undo: an accountant, installer, sales or admin is refused with 403 and nothing changes'); }
  const custWorld = (phone = '+27 79 012 8508', extra) => (db) => { seed()(db); db.prepare("UPDATE customers SET phone = ? WHERE id = 1").run(phone); db.prepare("INSERT INTO customer_facts (customer_id, key, value, source_transcript) VALUES (1, 'phone_number', '+27 79 012 8508', 't')").run(); db.prepare("INSERT INTO customer_facts (customer_id, key, value, source_transcript) VALUES (1, 'other', 'keep me', 't')").run();
    tag(db, 'customer_fact', 3, { effect: 'customer_fact', customerId: 1, changes: [{ column: 'phone', before: null, after: '+27 79 012 8508' }], newFactIds: [1] }); if (extra) extra(db); };
  { const r = await undo(1, custWorld()), w = r.writes, b = r.result.body;
    check(r.result.status === 200 && b.action === 'reversed' && b.kind === 'customer fact' && w.customers.changed[0].after.phone === null && w.customer_facts.removed.length === 1 && w.customer_facts.removed[0].value === '+27 79 012 8508' && !(w.customer_facts.changed && w.customer_facts.changed.length), 'undoing a customer detail restores the phone to what it was and removes only the note that decision saved (another note about the same customer stays)'); }
  { const r = await undo(1, custWorld('+27 82 000 0000')); check(r.result.status === 409 && r.result.body.reason === 'blocked' && unchanged(r), 'a customer detail changed again since is NOT put back: a 409 and nothing is written'); }
  { const evil = (db) => { seed()(db); db.prepare("UPDATE customers SET phone = '+27 79 012 8508' WHERE id = 1").run(); db.prepare("INSERT INTO mcp_created_records (create_id, key_id, tbl, rec_id, snapshot) VALUES (7, 'k1', 'customer_fact', 3, ?)").run(JSON.stringify({ effect: 'customer_fact', customerId: 1, changes: [{ column: 'phone', before: null, after: '+27 79 012 8508' }, { column: 'not_a_column', before: 'x', after: null }], newFactIds: [] })); };
    const r = await undo(1, evil); check(r.result.status >= 400 && unchanged(r), 'a snapshot that names something that is not a column of the customer is refused BEFORE anything is changed (the valid change in it is not applied either)'); }
  { const r = await undo(1, (db) => { seed()(db); db.prepare("INSERT INTO mcp_created_records (create_id, key_id, tbl, rec_id, snapshot) VALUES (7, 'k1', 'stock_add', 1, 'not json')").run(); }); check(r.result.status >= 400 && /no record of what this changed/.test(r.result.body.message) && unchanged(r), 'a decision with no readable record of what it changed is refused, with that reason, and writes nothing'); }

  // ---- the owner's list ----
  { const r = await route({ name: 'list', method: 'GET', path: '/mcp-created', role: 'owner', seed: stockWorld() }), item = (r.result.body.items || []).find((i) => i.kind === 'stock add');
    check(r.result.status === 200 && item && item.state === 'active' && item.recordId === 1 && /Added to stock: Sample sets \(2\), vinyl planks \(3\)/.test(item.summary.description) && item.connection === 'Claude on my phone', 'the owner\'s list shows a confirmed stock add as active with a short description and which connection decided it'); }
  { const r = await route({ name: 'list undone', method: 'GET', path: '/mcp-created', role: 'owner', seed: stockWorld(7, 2, (db) => db.prepare("UPDATE mcp_created_records SET undone_at = datetime('now') WHERE id = 1").run()) }), item = (r.result.body.items || []).find((i) => i.kind === 'stock add');
    check(item && item.state === 'undone', 'and once undone it is listed as undone'); }

  // ---- link order: links a purchase order to a customer's job and moves its supplier costs to that customer ----
  const PO_DDL = "CREATE TABLE IF NOT EXISTS purchase_order_customers (purchase_order_id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')))";
  const linkSeed = (db) => { seed()(db); db.exec(PO_DDL);
    db.prepare("INSERT INTO supplier_invoices (purchase_order_id, supplier_id, supplier_reference, amount, source_transcript) VALUES (5, NULL, 'INV9', 500, 'tr')").run();
    db.prepare("INSERT INTO expenses (amount, description, category, source_transcript) VALUES (500, 'Supplier invoice INV9', 'materials', 'tr')").run();
    held(db, 'link_order', { purchaseOrderId: 5, customerId: 1, customerName: 'Jenny', supplierName: 'Hunter Douglas' }, true); };
  { const r = await decide(5, 'confirm', { seed: linkSeed }), w = r.writes, s2 = w.mcp_created_records ? snap(r) : null;
    check(r.result.status === 200 && s2 && w.mcp_created_records.added[0].tbl === 'link_order' && s2.effect === 'link_order' && s2.purchaseOrderId === 5 && s2.previousCustomerId === null && s2.customerId === 1 && s2.moved.length === 1 && s2.moved[0].before === null && s2.moved[0].after === 1 && w.purchase_order_customers.added.length === 1 && w.expenses.changed.length === 1,
      'confirming a link order a connection proposed links the order and tags exactly what changed: which customer it was linked to before, and each cost that moved (from whom to whom)'); }
  const linkWorld = (previous = null, linkedNow = 1, expenseNow = 1, extra) => (db) => { seed()(db); db.exec(PO_DDL);
    db.prepare("INSERT INTO purchase_order_customers (purchase_order_id, customer_id) VALUES (5, ?)").run(linkedNow);
    const eid = Number(db.prepare("INSERT INTO expenses (amount, description, category, customer_id, source_transcript) VALUES (500, 'Supplier invoice INV9', 'materials', ?, 'tr')").run(expenseNow).lastInsertRowid);
    tag(db, 'link_order', 5, { effect: 'link_order', purchaseOrderId: 5, previousCustomerId: previous, customerId: 1, moved: [{ id: eid, before: null, after: 1 }] }); if (extra) extra(db, eid); };
  { const r = await undo(1, linkWorld()), w = r.writes, b = r.result.body;
    check(r.result.status === 200 && b.action === 'reversed' && b.kind === 'link order' && w.purchase_order_customers.removed.length === 1 && w.expenses.changed.length === 1 && w.expenses.changed[0].after.customer_id === null, 'undoing a link order that had no earlier link removes the link and moves the cost back to nobody'); }
  { const r = await undo(1, linkWorld(2)), w = r.writes; check(r.result.status === 200 && w.purchase_order_customers.added.length === 1 && w.purchase_order_customers.added[0].customer_id === 2 && w.purchase_order_customers.removed.length === 1 && w.purchase_order_customers.removed[0].customer_id === 1, 'undoing a link order that replaced an earlier link puts the earlier customer back'); }
  { const r = await undo(1, linkWorld(null, 3)); check(r.result.status === 409 && r.result.body.reason === 'blocked' && unchanged(r), 'a link order is NOT undone when the order has been linked to someone else since: a 409 and nothing is written'); }
  { const r = await undo(1, linkWorld(null, 1, 7)); check(r.result.status === 409 && r.result.body.reason === 'blocked' && unchanged(r), 'a link order is NOT undone when a cost it moved has been changed again since (and the link is left alone too)'); }
  { const r = await undo(1, linkWorld(null, 1, 1, (db, eid) => db.prepare('DELETE FROM expenses WHERE id = ?').run(eid))); check(r.result.status === 409 && r.result.body.reason === 'gone' && unchanged(r), 'a link order is refused as gone when a cost it moved no longer exists, and nothing is written'); }
  { const r = await decide(5, 'confirm', { seed: (db) => { linkSeed(db); db.exec("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 20001) INSERT INTO expenses (amount, description, category, source_transcript) SELECT 1, 'bulk', 'materials', 'b' FROM n"); } });
    check(r.result.status === 200 && r.writes.purchase_order_customers && !r.writes.mcp_created_records, 'a business with more costs than can be copied (20,000) tags NOTHING for a link order, so no undo claims to exist (and an assistant is refused such a decision before it is made)'); }
};
