// Characterization cases for the confirm and reject routes: where a held action finally becomes a record. Each case is a
// real request through the real request handler and the real authentication gate (a signed session, a membership row, the
// real role table). The held action is created first by the real dictation, so its stored payload is exactly what the code
// writes. The recorded writes are those of the final request only. Several confirmations REPLAY the original dictation,
// and the replay runs with the permissions of whoever confirmed it, not whoever dictated it.
module.exports = function cases(caps) {
  const base = (db) => db.exec(`
    INSERT INTO people (name) VALUES ('Jenny Smith'), ('Thandi Mokoena'), ('Sipho Dlamini'), ('Jabulani'), ('Floornet');
    INSERT INTO customers (name, person_id) VALUES ('Jenny Smith', 1), ('Thandi Mokoena', 2), ('Sipho Dlamini', 3);
    INSERT INTO characters (name, relationship, person_id) VALUES ('Jabulani', 'installer', 4), ('Floornet', 'supplier', 5);
  `);
  const withOrder = (db) => {
    base(db);
    db.exec(`
      INSERT INTO purchase_orders (id, supplier_id, description, created_at) VALUES (1, 2, 'Vinyl and underlay', '2026-10-01 08:00:00');
      INSERT INTO po_line_items (id, purchase_order_id, description, quantity_ordered, unit, unit_price_expected) VALUES (1, 1, 'Vinyl', 50, 'sqm', 180), (2, 1, 'Underlay', 100, 'sqm', 40);
    `);
  };
  const withDiscrepancy = (db) => {
    withOrder(db);
    db.exec(`
      INSERT INTO goods_received_notes (id, purchase_order_id, supplier_id, created_at) VALUES (1, 1, 2, '2026-10-02 09:00:00');
      INSERT INTO grn_line_items (grn_id, po_line_item_id, description, quantity_received, quantity_ordered, variance) VALUES (1, 1, 'Vinyl', 50, 50, 0), (1, 2, 'Underlay', 50, 100, -50);
    `);
  };
  const withQuote = (db) => { base(db); db.exec(`INSERT INTO quotations (customer_id, description, amount, status, created_at) VALUES (1, 'Kitchen vinyl', 12000, 'draft', '2026-09-25 08:00:00');`); };
  const withScope = (db) => {
    base(db);
    db.exec(`
      INSERT INTO job_scopes (id, customer_id, description, scheduled_date_raw, scheduled_date, created_at) VALUES (1, 1, 'Lounge laminate', 'the 10th', '2026-10-10', '2026-10-01 08:00:00');
      INSERT INTO scope_components (id, job_scope_id, name, width_mm, length_mm, area_sqm) VALUES (1, 1, 'Lounge', 5000, 4000, 20);
    `);
  };
  const twoOpenProjects = (db) => {
    base(db);
    db.exec(`
      INSERT INTO projects (id, customer_id, description, created_at) VALUES (1, 1, 'Kitchen refit', '2026-09-01 08:00:00'), (2, 1, 'Lounge floor', '2026-09-10 08:00:00');
      INSERT INTO job_scopes (id, customer_id, description, created_at) VALUES (1, 1, 'Lounge laminate', '2026-10-01 08:00:00');
      INSERT INTO pending_actions (id, type, payload, source_transcript, status, created_at) VALUES (1, 'project_ambiguity', '{"jobScopeId":1,"candidates":[{"id":1,"description":"Kitchen refit"},{"id":2,"description":"Lounge floor"}]}', 'resolving project attachment for job scope #1', 'pending', '2026-10-03 10:00:00');
    `);
  };
  const twoSipos = (db) => {
    base(db);
    db.exec(`INSERT INTO people (name) VALUES ('Sipho Dube'), ('Sipho Dubula'); INSERT INTO customers (name, person_id) VALUES ('Sipho Dube', 6), ('Sipho Dubula', 7);`);
  };
  const seededRow = (type, payload) => (db) => { base(db); db.prepare("INSERT INTO pending_actions (id, type, payload, source_transcript, status, created_at) VALUES (1, ?, ?, 'a seeded action', 'pending', '2026-10-03 10:00:00')").run(type, payload); };

  const cancellationDdl = `CREATE TABLE IF NOT EXISTS purchase_order_cancellations (purchase_order_id INTEGER PRIMARY KEY, cancelled_by TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));`;
  const cancelledMeanwhile = (db) => {
    withOrder(db);
    db.exec(cancellationDdl + ` INSERT INTO purchase_order_cancellations (purchase_order_id, cancelled_by) VALUES (1, 'owner@example.com');
      INSERT INTO pending_actions (id, type, payload, source_transcript, status, created_at) VALUES (1, 'cancel_order', '{"purchaseOrderId":1,"supplierId":2,"supplierName":"Floornet"}', 'cancel the Floornet order', 'pending', '2026-10-03 10:00:00');`);
  };
  // An installer on file from before people were recorded: no person to link to yet.
  const unlinkedInstaller = (db) => { base(db); db.exec(`INSERT INTO characters (name, relationship) VALUES ('Mystery', 'installer');`); };
  // A delivery held in boxes, and what happens to it when it is confirmed (decided 2026-10-04). Floornet is supplier 2 here.
  const unitConversionDdl = "CREATE TABLE IF NOT EXISTS unit_conversions (item_key TEXT NOT NULL, from_unit TEXT NOT NULL, to_unit TEXT NOT NULL, factor REAL NOT NULL, set_by TEXT, updated_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (item_key, from_unit, to_unit))";
  const heldDelivery = (unit, quantity) => `INSERT INTO pending_actions (id, type, payload, source_transcript, status, created_at) VALUES (1, 'goods_received', '{"purchaseOrderId":1,"supplierId":2,"supplierName":"Floornet","allocate":true,"lineItems":[{"matched_description":"Vinyl","item_description":"vinyl","unit":"${unit}","quantity_received":${quantity}}]}', 'Floornet delivered the vinyl', 'pending', '2026-10-03 10:00:00');`;
  const boxHold = (withConversion) => (db) => { withOrder(db); db.exec((withConversion ? unitConversionDdl + "; INSERT INTO unit_conversions (item_key, from_unit, to_unit, factor) VALUES ('vinyl', 'box', 'sqm', 2.5); " : '') + heldDelivery('boxes', 20)); };
  const stockedHold = (stockUnit, onHand) => (db) => { withOrder(db); db.exec(unitConversionDdl + "; INSERT INTO unit_conversions (item_key, from_unit, to_unit, factor) VALUES ('vinyl', 'box', 'sqm', 2.5); INSERT INTO stock_items (name, unit, quantity_on_hand) VALUES ('Vinyl', '" + stockUnit + "', " + onHand + "); " + heldDelivery('sqm', 50)); };
  // Floornet is supplier 2 here, with Vinyl on two orders (50, then 30).
  const twoVinylOrders = (db) => {
    withOrder(db);
    db.exec(`
      INSERT INTO purchase_orders (id, supplier_id, description, created_at) VALUES (2, 2, 'More vinyl', '2026-10-02 08:00:00');
      INSERT INTO po_line_items (id, purchase_order_id, description, quantity_ordered, unit, unit_price_expected) VALUES (3, 2, 'Vinyl', 30, 'sqm', 180);
    `);
  };
  const SIAI2 = (qty) => ({ match: /quantity_billed/, reply: { supplier_name: 'Floornet', supplier_reference: 'INV-7731', line_items: [{ matched_description: 'Vinyl', quantity_billed: qty, unit_price_billed: 185 }] } });
  // Two copies of one invoice held before the duplicate check existed. Floornet is supplier 2 here.
  const twoCopiesOfOneInvoice = (db) => {
    withOrder(db);
    const row = (id) => `INSERT INTO pending_actions (id, type, payload, source_transcript, status, created_at) VALUES (${id}, 'supplier_invoice', '{"purchaseOrderId":1,"supplierId":2,"supplierName":"Floornet","supplierReference":"INV-7731","lineItems":[{"matched_description":"Vinyl","quantity_billed":50,"unit_price_billed":185}]}', 'Floornet invoice INV-7731', 'pending', '2026-10-03 09:0${id}:00');`;
    db.exec(row(1) + row(2));
  };
  // The same invoice already recorded, with an explicit date (the database's own clock is real, so a seeded date keeps the recording stable).
  const copyOfRecordedInvoice = (db) => {
    twoCopiesOfOneInvoice(db);
    db.exec(`INSERT INTO supplier_invoices (id, purchase_order_id, supplier_id, supplier_reference, amount, created_at) VALUES (1, 1, 2, 'INV-7731', 9250, '2026-10-03 08:00:00');`);
  };
  // A bill in boxes, converted when it was held (decided 2026-10-04). Floornet is supplier 2 here.
  const vinylBoxConversion = (db) => { withOrder(db); db.exec(unitConversionDdl + "; INSERT INTO unit_conversions (item_key, from_unit, to_unit, factor) VALUES ('vinyl', 'box', 'sqm', 2.5);"); };
  const SIAIbox = { match: /quantity_billed/, reply: { supplier_name: 'Floornet', supplier_reference: 'INV-7731', line_items: [{ matched_description: 'Vinyl', quantity_billed: 20, unit: 'boxes', unit_price_billed: 462.5 }] } };
  // Reopening a cancelled order (decided 2026-10-04). Floornet is supplier 2 here.
  const cancelledWithHold = (db) => {
    withOrder(db);
    db.exec(cancellationDdl + ` INSERT INTO purchase_order_cancellations (purchase_order_id, cancelled_by, created_at) VALUES (1, 'owner@example.com', '2026-10-03 08:00:00');
      INSERT INTO pending_actions (id, type, payload, source_transcript, status, created_at) VALUES (1, 'reopen_order', '{"purchaseOrderId":1,"supplierId":2,"supplierName":"Floornet"}', 'reopen the Floornet order', 'pending', '2026-10-03 10:00:00');`);
  };
  const cancelledAfterInvoice = (db) => {
    withOrder(db);
    db.exec(cancellationDdl + ` INSERT INTO purchase_order_cancellations (purchase_order_id, cancelled_by, created_at) VALUES (1, 'owner@example.com', '2026-10-03 08:00:00');
      INSERT INTO supplier_invoices (id, purchase_order_id, supplier_id, supplier_reference, amount, created_at) VALUES (1, 1, 2, 'INV-1', 9250, '2026-10-02 08:00:00');`);
  };
  const openWithHold = (db) => {
    withOrder(db);
    db.exec(`INSERT INTO pending_actions (id, type, payload, source_transcript, status, created_at) VALUES (1, 'reopen_order', '{"purchaseOrderId":1,"supplierId":2,"supplierName":"Floornet"}', 'reopen the Floornet order', 'pending', '2026-10-03 10:00:00');`);
  };
  // An order placed FOR a customer (decided with Pierre 2026-10-04): the cost of its supplier invoice, and a credit, is for that customer's job.
  const orderLinkDdl = "CREATE TABLE IF NOT EXISTS purchase_order_customers (purchase_order_id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')))";
  const withLinks = (base, links) => (db) => { base(db); db.exec(`INSERT INTO customers (name) SELECT 'Thandi Mokoena' WHERE NOT EXISTS (SELECT 1 FROM customers WHERE name = 'Thandi Mokoena'); ` + orderLinkDdl + '; ' + links); };
  const orderForJenny = withLinks(withOrder, "INSERT INTO purchase_order_customers (purchase_order_id, customer_id) VALUES (1, 1);");
  const bothForJenny = withLinks(twoVinylOrders, "INSERT INTO purchase_order_customers (purchase_order_id, customer_id) VALUES (1, 1), (2, 1);");
  const forDifferentCustomers = withLinks(twoVinylOrders, "INSERT INTO purchase_order_customers (purchase_order_id, customer_id) VALUES (1, 1), (2, (SELECT id FROM customers WHERE name = 'Thandi Mokoena'));");
  const oneLinkedOneNot = withLinks(twoVinylOrders, "INSERT INTO purchase_order_customers (purchase_order_id, customer_id) VALUES (1, 1);");
  const discrepancyForJenny = withLinks(withDiscrepancy, "INSERT INTO purchase_order_customers (purchase_order_id, customer_id) VALUES (1, 1);");
  const OBS = (reply) => ({ match: /Extract the structure of a tradesperson's job observation/, reply });
  const LINES = (reply) => ({ match: /Extract every distinct line item from a tradesperson's quotation or invoice description/, reply });
  const GRAI = (reply) => ({ match: /quantity_received/, reply });
  const SIAI = (reply) => ({ match: /quantity_billed/, reply });
  const VDAI = (reply) => ({ match: /short_delivered/, reply });
  const nothing = { job_description: 'observation', components: [], tasks: [], scheduled_date_raw: null, installer_name: null };
  const say = (transcript, extraction, role) => ({ say: true, transcript, extraction, ...(role ? { role } : {}) });
  const confirm = (id, role, body) => ({ route: true, method: 'POST', path: `/actions/${id}/confirm`, role: role || 'owner', ...(body ? { body } : {}) });
  const r = (name, seed, path, before, ai, extra) => ({ kind: 'route', name, seed, path, before: before || [], ai, ...(extra || {}) });

  const pay = { intent: 'payment', customer_name: 'Jenny Smith', amount: 500 };
  const vinylDelivery = GRAI({ supplier_name: 'Floornet', line_items: [{ matched_description: 'Vinyl', item_description: 'vinyl', unit: 'sqm', quantity_received: 50 }] });
  const floornet = { character_name: 'Floornet', character_relationship: 'supplier' };

  return [
    // ---------------- money, and the gate in front of it ----------------
    r('confirm payment: owner', base, '/actions/1/confirm', [say('Jenny paid R500', pay)], []),
    // A dictated payment with no amount is no longer held (it asks how much), but one held BEFORE that change can still be waiting.
    r('confirm payment: an amountless payment held before this change is still confirmable', (db) => { base(db); db.exec(`INSERT INTO pending_actions (id, type, payload, source_transcript, status, created_at) VALUES (1, 'payment', '{"customerId":1,"customerName":"Jenny Smith","amount":null}', 'Jenny paid', 'pending', '2026-10-03 10:00:00');`); }, '/actions/1/confirm', [], []),
    r('confirm payment: accountant', base, '/actions/1/confirm', [say('Jenny paid R500', pay)], [], { role: 'accountant' }),
    r('confirm payment: an installer is refused at the gate', base, '/actions/1/confirm', [say('Jenny paid R500', pay)], [], { role: 'installer' }),
    r('confirm payment: signed out', base, '/actions/1/confirm', [say('Jenny paid R500', pay)], [], { noSession: true }),
    r('confirm payment: signed in but not a member', base, '/actions/1/confirm', [say('Jenny paid R500', pay)], [], { role: 'nobody' }),
    r('confirm payment: confirmed twice', base, '/actions/1/confirm', [say('Jenny paid R500', pay), confirm(1)], []),
    r('confirm: no such action', base, '/actions/99/confirm', [], []),
    r('confirm expense: owner, a supplier named', base, '/actions/1/confirm', [say('bought adhesive from Floornet for R1200', { intent: 'expense', amount: 1200, ...floornet })], []),
    r('confirm supplier payment: owner', base, '/actions/1/confirm', [say('paid Floornet R10000', { intent: 'supplier_payment', amount: 10000, ...floornet })], []),
    r('confirm invoice: owner, with its document link', base, '/actions/1/confirm', [say('invoice Jenny R5000', { intent: 'invoice', customer_name: 'Jenny Smith', amount: 5000 })], [OBS(nothing)]),
    r('confirm invoice: accountant', base, '/actions/1/confirm', [say('invoice Jenny R5000', { intent: 'invoice', customer_name: 'Jenny Smith', amount: 5000 })], [OBS(nothing)], { role: 'accountant' }),
    r('confirm quotation: owner, with line items', base, '/actions/1/confirm', [say('quote Jenny 20 sqm carpet at R450', { intent: 'quotation', customer_name: 'Jenny Smith' })],
      [LINES({ line_items: [{ description: 'Carpet', note: null, quantity: 20, unit: 'sqm', unit_price: 450, discount_percent: null }] })]),
    r('confirm quote conversion: owner, with a deposit', withQuote, '/actions/1/confirm', [say('convert Jenny\'s quote, she paid 30 percent upfront', { intent: 'convert_quote', customer_name: 'Jenny Smith', deposit_percent: 30 })], []),

    // ---------------- procurement ----------------
    r('confirm delivery: owner, an item that is not yet stock raises the stock question', withOrder, '/actions/1/confirm', [say('Floornet delivered the vinyl', { intent: 'goods_received', ...floornet })], [vinylDelivery]),
    r('confirm delivery: an installer confirms it (receiving goods is open to them)', withOrder, '/actions/1/confirm', [say('Floornet delivered the vinyl', { intent: 'goods_received', ...floornet }, 'installer')], [vinylDelivery], { role: 'installer' }),
    r('confirm supplier invoice: owner', withOrder, '/actions/1/confirm', [say('Floornet invoice: 50 sqm vinyl at 185', { intent: 'supplier_invoice', ...floornet })],
      [SIAI({ supplier_name: 'Floornet', supplier_reference: 'INV-7731', line_items: [{ matched_description: 'Vinyl', quantity_billed: 50, unit_price_billed: 185 }] })]),
    r('confirm credit: owner, a credit with an amount', withDiscrepancy, '/actions/1/confirm', [say('Floornet is crediting us R2000 for the underlay shortage', { intent: 'variance_disposition', ...floornet })],
      [VDAI({ matched_description: 'Underlay', reason: 'short_delivered', resolution: 'credit', credit_amount: 2000 })]),
    r('confirm stock question: owner adds the delivered item to stock', withOrder, '/actions/2/confirm', [say('Floornet delivered the vinyl', { intent: 'goods_received', ...floornet }), confirm(1)], [vinylDelivery]),
    r('reject stock question: the item is declined', withOrder, '/actions/2/reject', [say('Floornet delivered the vinyl', { intent: 'goods_received', ...floornet }), confirm(1)], [vinylDelivery]),

    // ---------------- cancelling an order ----------------
    r('confirm order cancellation: owner', withOrder, '/actions/1/confirm', [say('cancel the Floornet order', { intent: 'cancel_order', ...floornet })], []),
    r('confirm order cancellation: it closes the open shortages of that order', withDiscrepancy, '/actions/1/confirm', [say('cancel the Floornet order', { intent: 'cancel_order', ...floornet })], []),
    r('confirm order cancellation: accountant', withOrder, '/actions/1/confirm', [say('cancel the Floornet order', { intent: 'cancel_order', ...floornet })], [], { role: 'accountant' }),
    r('confirm order cancellation: an installer is refused at the gate', withOrder, '/actions/1/confirm', [say('cancel the Floornet order', { intent: 'cancel_order', ...floornet })], [], { role: 'installer' }),
    r('confirm order cancellation: confirmed twice', withOrder, '/actions/1/confirm', [say('cancel the Floornet order', { intent: 'cancel_order', ...floornet }), confirm(1)], []),
    r('confirm order cancellation: the order was cancelled meanwhile', cancelledMeanwhile, '/actions/1/confirm', [], []),
    r('reject order cancellation: nothing is cancelled', withOrder, '/actions/1/reject', [say('cancel the Floornet order', { intent: 'cancel_order', ...floornet })], []),
    r('confirm a delivery that was held before its order was cancelled: it is received as an exception', withOrder, '/actions/1/confirm',
      [say('Floornet delivered the vinyl', { intent: 'goods_received', ...floornet }), say('cancel the Floornet order', { intent: 'cancel_order', ...floornet }), confirm(2)], [vinylDelivery]),

    // ---------------- a delivery in another unit, at confirmation ----------------
    r('confirm delivery: held in boxes, and the conversion was learned after the hold, so it is converted now', boxHold(true), '/actions/1/confirm', [], []),
    r('confirm delivery: held in boxes with no conversion known, so it goes back to waiting and the question is asked', boxHold(false), '/actions/1/confirm', [], []),
    r('confirm delivery: stock kept in boxes is added in boxes although the order was in square metres', stockedHold('box', 0), '/actions/1/confirm', [], []),
    r('confirm delivery: stock kept in the same unit as the order is added as before', stockedHold('sqm', 10), '/actions/1/confirm', [], []),

    // ---------------- an invoice that spans orders, at confirmation ----------------
    r('confirm supplier invoice: one invoice spanning two orders records a line against each', twoVinylOrders, '/actions/1/confirm', [say('Floornet invoice INV-7731, 70 sqm vinyl at 185', { intent: 'supplier_invoice', ...floornet })], [SIAI2(70)]),
    r('confirm supplier invoice: billing more than was ordered shows the over-billing against the last order', twoVinylOrders, '/actions/1/confirm', [say('Floornet invoice INV-7731, 100 sqm vinyl at 185', { intent: 'supplier_invoice', ...floornet })], [SIAI2(100)]),
    r('confirm supplier invoice: an invoice that fits one order is recorded against it exactly as before', twoVinylOrders, '/actions/1/confirm', [say('Floornet invoice INV-7731, 30 sqm vinyl at 185', { intent: 'supplier_invoice', ...floornet })], [SIAI2(30)]),

    r('confirm supplier invoice: a bill in boxes was converted when held, so it is recorded in the order\'s unit', vinylBoxConversion, '/actions/1/confirm', [say('Floornet invoice INV-7731, 20 boxes of vinyl at 462.50', { intent: 'supplier_invoice', ...floornet })], [SIAIbox]),

    // ---------------- the same invoice confirmed twice ----------------
    r('confirm supplier invoice: the first of two copies is recorded', twoCopiesOfOneInvoice, '/actions/1/confirm', [], []),
    r('confirm supplier invoice: a copy of an invoice that is already recorded is not recorded again and stays waiting', copyOfRecordedInvoice, '/actions/1/confirm', [], []),

    // ---------------- reopening a cancelled order ----------------
    r('confirm reopen: owner brings a cancelled order back', cancelledWithHold, '/actions/1/confirm', [], []),
    r('confirm reopen: the order was already open', openWithHold, '/actions/1/confirm', [], []),
    r('confirm reopen: an installer is refused at the gate', cancelledWithHold, '/actions/1/confirm', [], [], { role: 'installer' }),
    r('confirm reopen: confirmed twice', cancelledWithHold, '/actions/1/confirm', [confirm(1)], []),
    r('reject reopen: the order stays cancelled', cancelledWithHold, '/actions/1/reject', [], []),
    r('confirm reopen: the round trip, cancel then reopen, restores the shortage the cancellation closed', withDiscrepancy, '/actions/2/confirm',
      [say('cancel the Floornet order', { intent: 'cancel_order', ...floornet }), confirm(1), say('reopen the Floornet order', { intent: 'reopen_order', ...floornet })], []),

    // ---------------- the Suppliers screen knows about a cancelled order (found by the first real phone test, 2026-10-04) ----------------
    r('suppliers screen: an open order shows as ordered, awaiting delivery', withOrder, '/debug/suppliers-list', [], [], { method: 'GET', role: 'owner' }),
    r('suppliers screen: a cancelled order shows as cancelled, with the day', cancelledWithHold, '/debug/suppliers-list', [], [], { method: 'GET', role: 'owner' }),
    r('suppliers screen: an order cancelled through the app shows as cancelled', withOrder, '/debug/suppliers-list',
      [say('cancel the Floornet order', { intent: 'cancel_order', ...floornet }), confirm(1)], [], { method: 'GET', role: 'owner' }),
    r('suppliers screen: an order cancelled and then reopened shows as it was before', withOrder, '/debug/suppliers-list',
      [say('cancel the Floornet order', { intent: 'cancel_order', ...floornet }), confirm(1), say('reopen the Floornet order', { intent: 'reopen_order', ...floornet }), confirm(2)], [], { method: 'GET', role: 'owner' }),
    r('suppliers screen: a cancelled order that was partly invoiced still shows as cancelled', cancelledAfterInvoice, '/debug/suppliers-list', [], [], { method: 'GET', role: 'owner' }),
    r('purchase orders list (admin): a cancelled order shows as cancelled', cancelledWithHold, '/debug/purchase-orders', [], [], { method: 'GET', admin: true }),
    r('purchase orders list (admin): an open order is unchanged', withOrder, '/debug/purchase-orders', [], [], { method: 'GET', admin: true }),

    // ---------------- the cost of an order placed for a customer is for that customer's job ----------------
    r('confirm supplier invoice: an order placed for Jenny puts the cost on Jenny\'s job', orderForJenny, '/actions/1/confirm', [say('Floornet invoice INV-7731, 50 sqm vinyl at 185', { intent: 'supplier_invoice', ...floornet })], [SIAI2(50)]),
    r('confirm supplier invoice: an order with no link leaves the cost on no job, as before', withOrder, '/actions/1/confirm', [say('Floornet invoice INV-7731, 50 sqm vinyl at 185', { intent: 'supplier_invoice', ...floornet })], [SIAI2(50)]),
    r('confirm supplier invoice: one invoice spanning two orders for the SAME customer is for that customer', bothForJenny, '/actions/1/confirm', [say('Floornet invoice INV-7731, 70 sqm vinyl at 185', { intent: 'supplier_invoice', ...floornet })], [SIAI2(70)]),
    r('confirm supplier invoice: one invoice spanning orders for DIFFERENT customers is for no job', forDifferentCustomers, '/actions/1/confirm', [say('Floornet invoice INV-7731, 70 sqm vinyl at 185', { intent: 'supplier_invoice', ...floornet })], [SIAI2(70)]),
    r('confirm supplier invoice: one invoice spanning a linked and an unlinked order is for no job', oneLinkedOneNot, '/actions/1/confirm', [say('Floornet invoice INV-7731, 70 sqm vinyl at 185', { intent: 'supplier_invoice', ...floornet })], [SIAI2(70)]),
    r('confirm credit: a credit for a shortage on an order placed for Jenny reduces Jenny\'s job cost', discrepancyForJenny, '/actions/1/confirm', [say('Floornet is crediting us R2000 for the underlay shortage', { intent: 'variance_disposition', ...floornet })],
      [VDAI({ matched_description: 'Underlay', reason: 'short_delivered', resolution: 'credit', credit_amount: 2000 })]),

    // ---------------- who is this? ----------------
    r('confirm identity question: owner, the name belongs to an installer', base, '/actions/1/confirm', [say('Jabulani called about a job', { intent: 'note', customer_name: 'Jabulani' })], []),
    r('confirm identity question: an installer confirms a payment that the owner dictated (the replay runs as the confirmer)', base, '/actions/1/confirm', [say('Jabulani paid R500', { intent: 'payment', customer_name: 'Jabulani', amount: 500 })], [], { role: 'installer' }),
    r('confirm identity question: an accountant confirms a payment that the owner dictated', base, '/actions/1/confirm', [say('Jabulani paid R500', { intent: 'payment', customer_name: 'Jabulani', amount: 500 })], [], { role: 'accountant' }),
    r('confirm identity question: the existing record has no person yet, so one is created for both', unlinkedInstaller, '/actions/1/confirm', [say('Mystery called about a job', { intent: 'note', customer_name: 'Mystery' })], []),
    r('reject identity question: a long sentence is shortened in the reply', base, '/actions/1/reject', [say('Jabulani called about the job at the big house on the hill and he wants to talk about the quote and the schedule and the new carpet and the underlay and the date for the install', { intent: 'note', customer_name: 'Jabulani' })], []),
    r('reject identity question: owner, someone else was meant', base, '/actions/1/reject', [say('Jabulani called about a job', { intent: 'note', customer_name: 'Jabulani' })], []),
    r('confirm near-match question: one candidate, no choice needed', base, '/actions/1/confirm', [say('Sipo Dlamini called', { intent: 'note', customer_name: 'Sipo Dlamini' })], []),
    r('confirm near-match question: two candidates and no choice is refused', twoSipos, '/actions/1/confirm', [say('Sipho Dub called', { intent: 'note', customer_name: 'Sipho Dub' })], []),
    r('confirm near-match question: two candidates and a valid choice', twoSipos, '/actions/1/confirm', [say('Sipho Dub called', { intent: 'note', customer_name: 'Sipho Dub' })], [], { body: { personId: 7 } }),
    r('confirm near-match question: two candidates and a choice that is not one of them', twoSipos, '/actions/1/confirm', [say('Sipho Dub called', { intent: 'note', customer_name: 'Sipho Dub' })], [], { body: { personId: 1 } }),
    r('reject near-match question: a new person is created', base, '/actions/1/reject', [say('Sipo Dlamini called', { intent: 'note', customer_name: 'Sipo Dlamini' })], []),

    // ---------------- what a refused or mismatched answer leaves behind ----------------
    r('confirm near-match question: a valid choice after a refused attempt', twoSipos, '/actions/1/confirm', [say('Sipho Dub called', { intent: 'note', customer_name: 'Sipho Dub' }), confirm(1)], [], { body: { personId: 7 } }),
    r('confirm identity question: after an installer\'s attempt, the owner can still answer it', base, '/actions/1/confirm', [say('Jabulani paid R500', { intent: 'payment', customer_name: 'Jabulani', amount: 500 }), confirm(1, 'installer')], []),
    r('confirm near-match question: an installer confirms a payment the owner dictated', base, '/actions/1/confirm', [say('Sipo Dlamini paid R500', { intent: 'payment', customer_name: 'Sipo Dlamini', amount: 500 })], [], { role: 'installer' }),
    r('reject near-match question: an installer rejects a payment the owner dictated', base, '/actions/1/reject', [say('Sipo Dlamini paid R500', { intent: 'payment', customer_name: 'Sipo Dlamini', amount: 500 })], [], { role: 'installer' }),
    r('confirm identity question: a customer\'s name used for an installer is linked to the same person', base, '/actions/1/confirm', [say('Jenny Smith will install it', { intent: 'note', character_name: 'Jenny Smith', character_relationship: 'installer' })], []),

    // ---------------- jobs ----------------
    r('confirm amendment: owner', withScope, '/actions/1/confirm', [say('move Jenny\'s install to next Monday', { intent: 'work_observation', customer_name: 'Jenny Smith' })], [OBS({ ...nothing, scheduled_date_raw: 'next Monday' })]),
    r('confirm amendment: a new date said in words is scheduled', withScope, '/actions/1/confirm', [say('move Jenny\'s install to the seventeenth', { intent: 'work_observation', customer_name: 'Jenny Smith' })], [OBS({ ...nothing, scheduled_date_raw: 'the seventeenth' })]),
    r('reject amendment: a new job is recorded instead', withScope, '/actions/1/reject', [say('move Jenny\'s install to next Monday', { intent: 'work_observation', customer_name: 'Jenny Smith' })], [OBS({ ...nothing, scheduled_date_raw: 'next Monday' })]),
    r('confirm project question: a project is chosen', twoOpenProjects, '/actions/1/confirm', [], [], { body: { projectId: 2 } }),
    r('confirm project question: a valid choice after a refused attempt', twoOpenProjects, '/actions/1/confirm', [confirm(1)], [], { body: { projectId: 2 } }),
    r('confirm project question: no project is chosen', twoOpenProjects, '/actions/1/confirm', [], []),
    r('reject project question', twoOpenProjects, '/actions/1/reject', [], []),

    // ---------------- facts ----------------
    r('confirm customer fact: owner', base, '/actions/1/confirm', [say('Jenny\'s phone is 082 555 0101', { intent: 'note', customer_name: 'Jenny Smith', fact_key: 'phone', fact_value: '082 555 0101' })], []),
    r('confirm customer fact: accountant', base, '/actions/1/confirm', [say('Jenny\'s phone is 082 555 0101', { intent: 'note', customer_name: 'Jenny Smith', fact_key: 'phone', fact_value: '082 555 0101' })], [], { role: 'accountant' }),
    r('confirm supplier or installer fact: owner', base, '/actions/1/confirm', [say('Jabulani\'s cell is 083 555 0202', { intent: 'note', character_name: 'Jabulani', character_relationship: 'installer', fact_key: 'cell', fact_value: '083 555 0202' })], []),
    r('confirm supplier or installer fact: accountant is refused at the gate', base, '/actions/1/confirm', [say('Jabulani\'s cell is 083 555 0202', { intent: 'note', character_name: 'Jabulani', character_relationship: 'installer', fact_key: 'cell', fact_value: '083 555 0202' })], [], { role: 'accountant' }),

    // ---------------- reject ----------------
    r('reject payment: owner', base, '/actions/1/reject', [say('Jenny paid R500', pay)], []),
    r('reject payment: an installer is refused at the gate', base, '/actions/1/reject', [say('Jenny paid R500', pay)], [], { role: 'installer' }),
    r('reject payment: already confirmed', base, '/actions/1/reject', [say('Jenny paid R500', pay), confirm(1)], []),
    r('reject: no such action', base, '/actions/99/reject', [], []),

    // ---------------- a confirmation that cannot complete ----------------
    r('confirm: a payload that cannot be read puts the action back to pending', seededRow('payment', 'this is not json'), '/actions/1/confirm', [], []),
    r('confirm: an unknown action type is put back to pending', seededRow('some_future_type', '{}'), '/actions/1/confirm', [], []),
    r('confirm: a schema suggestion is only acknowledged', seededRow('schema_candidate', '{"table":"jobs","column":"colour"}'), '/actions/1/confirm', [], []),
  ];
};
