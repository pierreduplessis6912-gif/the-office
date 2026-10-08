// Tests for linking an EXISTING order to a customer and moving the costs already recorded for it (decided with Pierre 2026-10-04).
module.exports = async function runLinkOrderTests({ check, bundleTo, srcDir, path, sameJson }) {
  const { getOrderForLinking, getUnlinkedOrdersForSupplier, describeOrderForLinking, linkPurchaseOrderAndMoveCosts, linkPurchaseOrderToCustomer, cancelPurchaseOrder } = bundleTo('finance.ts', 'rm-linkorder-finance.js');
  const { newDatabase, d1 } = require('./harness.js');
  const workerDir = path.join(srcDir, '..');
  const fresh = (extra = '') => {
    const db = newDatabase(workerDir);
    db.exec(`
      INSERT INTO people (name) VALUES ('Jenny Smith'), ('Thandi Mokoena');
      INSERT INTO customers (id, name, person_id) VALUES (1, 'Jenny Smith', 1), (2, 'Thandi Mokoena', 2);
      INSERT INTO characters (id, name, relationship) VALUES (1, 'Floornet', 'supplier'), (2, 'Belgotex', 'supplier');
      INSERT INTO purchase_orders (id, supplier_id, description, created_at) VALUES (1, 1, 'Vinyl', '2026-10-01 08:00:00'), (2, 1, 'Grout', '2026-10-02 08:00:00'), (3, 1, 'Adhesive', '2026-10-03 08:00:00'), (4, 2, 'Carpet', '2026-10-03 09:00:00');
      INSERT INTO po_line_items (id, purchase_order_id, description, quantity_ordered, unit) VALUES (1, 1, 'Vinyl', 50, 'sqm'), (2, 1, 'Underlay', 100, 'sqm'), (3, 2, 'Grout', 20, 'bag'), (4, 3, 'Adhesive', 5, 'tube'), (5, 4, 'Carpet', 30, 'sqm');
      ${extra}
    `);
    return { db, env: { OFFICE_DB: d1(db) } };
  };
  const expense = (id, supplier, amount, description, source, customer) => `INSERT INTO expenses (id, character_id, amount, description, source_transcript, category, customer_id) VALUES (${id}, ${supplier}, ${amount}, '${description}', '${source}', 'materials', ${customer});`;

  // ---- finding the order ------------------------------------------------------------------------------------------
  let { env } = fresh();
  let o = await getOrderForLinking(env, 1);
  check(o && o.supplier === 'Floornet' && o.cancelled === false && o.linkedTo === null && o.lines.length === 2, 'an order is found with its supplier, its lines, and whether it is cancelled or already linked');
  check((await getOrderForLinking(env, 999)) === null, 'an order that does not exist is not found');
  check(describeOrderForLinking(o) === '#1 Vinyl (50 sqm Vinyl, 100 sqm Underlay ordered)', 'it reads "#1 Vinyl (50 sqm Vinyl, 100 sqm Underlay ordered)"');
  await linkPurchaseOrderToCustomer(env, 2, 2);
  await cancelPurchaseOrder(env, 3, null);
  check((await getOrderForLinking(env, 2)).linkedTo === 'Thandi Mokoena' && (await getOrderForLinking(env, 3)).cancelled === true, 'who an order is linked to, and a cancellation, show');
  check(sameJson((await getUnlinkedOrdersForSupplier(env, 1)).map((x) => x.id), [1]), 'a supplier\'s unlinked orders leave out the linked and the cancelled ones');
  check(sameJson((await getUnlinkedOrdersForSupplier(env, 2)).map((x) => x.id), [4]) && (await getUnlinkedOrdersForSupplier(env, 999)).length === 0, 'another supplier\'s orders are theirs only, and an unknown supplier has none');

  // ---- moving the costs ----------------------------------------------------------------------------------------------
  ({ env } = fresh(`INSERT INTO supplier_invoices (id, purchase_order_id, supplier_id, supplier_reference, amount, source_transcript) VALUES (1, 1, 1, 'INV-1', 9250, 'Floornet invoice INV-1'); ` + expense(1, 1, 9250, 'Supplier invoice INV-1', 'Floornet invoice INV-1', 'NULL')));
  let r = await linkPurchaseOrderAndMoveCosts(env, 1, 1);
  check(r.moved === 1 && r.movedAmount === 9250 && r.unmatched === 0 && r.previousCustomerId === null, 'a cost already recorded for the order, found with certainty, moves onto the customer');
  check((await env.OFFICE_DB.prepare('SELECT customer_id FROM expenses WHERE id = 1').first()).customer_id === 1, 'and its expense now carries the customer');
  r = await linkPurchaseOrderAndMoveCosts(env, 1, 1);
  check(r.moved === 0 && r.unmatched === 0, 'linking the same order to the same customer again moves nothing');

  ({ env } = fresh(`INSERT INTO supplier_invoices (id, purchase_order_id, supplier_id, supplier_reference, amount, source_transcript) VALUES (1, 1, 1, 'INV-1', 9250, 'T'); ` + expense(1, 1, 9250, 'Supplier invoice INV-1', 'T', 'NULL') + expense(2, 1, 9250, 'Supplier invoice INV-1', 'T', 'NULL')));
  r = await linkPurchaseOrderAndMoveCosts(env, 1, 1);
  check(r.moved === 0 && r.unmatched === 1, 'TWO identical candidates cannot be told apart: neither is moved, and it is counted, never guessed');
  check((await env.OFFICE_DB.prepare('SELECT COUNT(*) AS n FROM expenses WHERE customer_id IS NULL').first()).n === 2, 'both costs are left exactly as they were');

  ({ env } = fresh(`INSERT INTO supplier_invoices (id, purchase_order_id, supplier_id, supplier_reference, amount, source_transcript) VALUES (1, 1, 1, 'INV-1', 9250, 'T'); ` + expense(1, 1, 9000, 'Supplier invoice INV-1', 'T', 'NULL')));
  r = await linkPurchaseOrderAndMoveCosts(env, 1, 1);
  check(r.moved === 0 && r.unmatched === 1, 'a cost with a different amount is not the invoice\'s cost: not moved, and counted');

  ({ env } = fresh(`INSERT INTO supplier_invoices (id, purchase_order_id, supplier_id, supplier_reference, amount, source_transcript) VALUES (1, 1, 1, 'INV-1', 9250, 'T'); ` + expense(1, 1, 9250, 'Supplier invoice INV-1', 'T', '2')));
  r = await linkPurchaseOrderAndMoveCosts(env, 1, 1);
  check(r.moved === 0 && r.unmatched === 1 && (await env.OFFICE_DB.prepare('SELECT customer_id FROM expenses WHERE id = 1').first()).customer_id === 2, 'a cost that belongs to ANOTHER customer, with no link saying why, is not taken');

  ({ env } = fresh(`INSERT INTO supplier_invoices (id, purchase_order_id, supplier_id, supplier_reference, amount, source_transcript) VALUES (1, 1, 1, 'INV-1', 9250, 'T'); ` + expense(1, 1, 9250, 'Supplier invoice INV-1', 'T', '2')));
  await linkPurchaseOrderToCustomer(env, 1, 2);
  r = await linkPurchaseOrderAndMoveCosts(env, 1, 1);
  check(r.previousCustomerId === 2 && r.moved === 1 && (await env.OFFICE_DB.prepare('SELECT customer_id FROM expenses WHERE id = 1').first()).customer_id === 1, 'an order moved from another customer takes its costs with it');

  ({ env } = fresh(`INSERT INTO goods_received_notes (id, purchase_order_id, supplier_id) VALUES (1, 1, 1); INSERT INTO grn_line_items (id, grn_id, po_line_item_id, description, quantity_received, quantity_ordered, variance) VALUES (1, 1, 2, 'Underlay', 50, 100, -50);
    INSERT INTO variance_dispositions (id, grn_line_item_id, reason, resolution, credit_amount, recorded_by) VALUES (7, 1, 'short', 'credit', 2000, 'owner@example.com'); ` + expense(1, 1, -2000, 'Credit for Underlay (short)', 'variance disposition #7', 'NULL')));
  r = await linkPurchaseOrderAndMoveCosts(env, 1, 1);
  check(r.moved === 1 && (await env.OFFICE_DB.prepare('SELECT customer_id FROM expenses WHERE id = 1').first()).customer_id === 1, 'a credit for a shortage on the order moves too (found by the disposition that made it)');
  check(r.movedAmount === 0, 'and credits are counted as moved but are not added to the supplier-invoice total');
  ({ env } = fresh());
  r = await linkPurchaseOrderAndMoveCosts(env, 1, 1);
  check(r.moved === 0 && r.unmatched === 0 && (await getOrderForLinking(env, 1)).linkedTo === 'Jenny Smith', 'an order with no costs yet is simply linked');
};
