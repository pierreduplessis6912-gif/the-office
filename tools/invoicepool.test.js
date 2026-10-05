// Tests for matching a supplier invoice across ALL the supplier's open orders (decided 2026-10-04): the allocation (pure), the pool
// of open order lines against a real database, and the notes.
module.exports = async function runInvoicePoolTests({ check, bundleTo, srcDir, path, sameJson }) {
  const { allocateInvoiceLines, getInvoiceMatchLines, invoiceCandidatesForReader, invoiceOrdersNote } = bundleTo('finance.ts', 'rm-pool-finance.js');
  const { newDatabase, d1 } = require('./harness.js');
  const workerDir = path.join(srcDir, '..');

  // ---- 1. The allocation, pure ------------------------------------------------------------------------------------
  const pool = [
    { poId: 1, poLineId: 10, description: 'Vinyl', ordered: 50, unbilled: 50, unit: 'sqm', unitPriceExpected: 180 },
    { poId: 1, poLineId: 11, description: 'Underlay', ordered: 100, unbilled: 100, unit: 'sqm', unitPriceExpected: 40 },
    { poId: 2, poLineId: 20, description: 'Vinyl', ordered: 30, unbilled: 30, unit: 'sqm', unitPriceExpected: 180 },
  ];
  const billed = (name, qty, price = 185) => ({ matched_description: name, quantity_billed: qty, unit_price_billed: price });
  let a = allocateInvoiceLines([billed('Vinyl', 70)], pool);
  check(sameJson(a.lines.map((l) => [l.quantity_billed, l.po_line_item_id]), [[50, 10], [20, 20]]), 'a bill for 70 fills the oldest order (50) and spills the rest (20) into the next, each line naming its own order line');
  check(sameJson(a.orderIds, [1, 2]) && a.primaryPoId === 1, 'the orders touched are listed oldest first, and the oldest is the invoice\'s own');
  const single = [billed('Vinyl', 30)];
  a = allocateInvoiceLines(single, pool);
  check(a.lines.length === 1 && a.lines[0] === single[0] && !('po_line_item_id' in a.lines[0]), 'a bill that fits in one order is returned as the very same line, with nothing added (a single-order invoice is exactly what it always was)');
  check(sameJson(a.orderIds, [1]) && a.primaryPoId === 1, 'and it goes to the OLDEST order that has the item, not the latest');
  a = allocateInvoiceLines([billed('Vinyl', 100)], pool);
  check(sameJson(a.lines.map((l) => [l.quantity_billed, l.po_line_item_id]), [[50, 10], [50, 20]]) && a.lines[0].quantity_billed + a.lines[1].quantity_billed === 100, 'billing more than everything ordered keeps the excess on the last order reached, so it still shows as a variance');
  a = allocateInvoiceLines([billed('Vinyl', 40), billed('Vinyl', 40)], pool);
  check(sameJson(a.lines.map((l) => [l.quantity_billed, l.po_line_item_id]), [[40, 10], [10, 10], [30, 20]]), 'two billed lines of one item share the capacity: the second takes what is left of the first order, then the next');
  a = allocateInvoiceLines([billed('Vinyl', 20), billed('Grout', 5, 90)], pool);
  check(a.lines.length === 2 && a.lines[1].matched_description === 'Grout' && !('po_line_item_id' in a.lines[1]) && sameJson(a.orderIds, [1]), 'a billed line that is on no open order stays unmatched and does not widen the invoice');
  a = allocateInvoiceLines([billed('VINYL', 70)], pool);
  check(sameJson(a.orderIds, [1, 2]), 'names are matched ignoring case');
  a = allocateInvoiceLines([billed('Grout', 5)], pool);
  check(a.orderIds.length === 0 && a.primaryPoId === null && a.lines.length === 1, 'an invoice with nothing on any open order touches no order');
  a = allocateInvoiceLines([{ matched_description: null, quantity_billed: 3, unit_price_billed: 10 }], pool);
  check(a.lines.length === 1 && a.primaryPoId === null, 'a line the reader could not name is left alone');
  a = allocateInvoiceLines([billed('Vinyl', 0)], pool);
  check(a.lines.length === 1 && a.lines[0].quantity_billed === 0 && sameJson(a.orderIds, [1]), 'a zero-quantity line is kept and placed against the oldest order');
  check(allocateInvoiceLines([], pool).lines.length === 0, 'no lines, no allocation');
  check(!('po_line_item_id' in single[0]), 'the caller\'s own lines are never modified');

  // ---- 2. The pool, against a real database -----------------------------------------------------------------------
  const seeded = () => {
    const db = newDatabase(workerDir);
    db.exec(`
      INSERT INTO people (name) VALUES ('Floornet'), ('Belgotex');
      INSERT INTO characters (name, relationship, person_id) VALUES ('Floornet', 'supplier', 1), ('Belgotex', 'supplier', 2);
      INSERT INTO purchase_orders (id, supplier_id, description, created_at) VALUES (1, 1, 'First', '2026-10-01 08:00:00'), (2, 1, 'Second', '2026-10-02 08:00:00'), (3, 2, 'Other supplier', '2026-10-01 09:00:00');
      INSERT INTO po_line_items (id, purchase_order_id, description, quantity_ordered, unit, unit_price_expected) VALUES (10, 1, 'Vinyl', 50, 'sqm', 180), (11, 1, 'Underlay', 100, 'sqm', 40), (20, 2, 'Vinyl', 30, 'sqm', 180), (30, 3, 'Grout', 9, 'bag', 90);
    `);
    return { db, env: { OFFICE_DB: d1(db) } };
  };
  let { db, env } = seeded();
  let rows = await getInvoiceMatchLines(env, 1, 2);
  check(sameJson(rows.map((r) => [r.poId, r.poLineId, r.unbilled]), [[1, 10, 50], [1, 11, 100], [2, 20, 30]]), 'the pool is every line of the supplier\'s orders with something unbilled, oldest order first, and no other supplier\'s');
  db.exec(`INSERT INTO supplier_invoices (id, purchase_order_id, supplier_id, amount) VALUES (1, 1, 1, 9250); INSERT INTO supplier_invoice_line_items (supplier_invoice_id, po_line_item_id, description, quantity_billed, line_total) VALUES (1, 10, 'Vinyl', 50, 9250);`);
  rows = await getInvoiceMatchLines(env, 1, 2);
  check(sameJson(rows.map((r) => r.poLineId), [11, 20]), 'a line already invoiced in full leaves the pool');
  db.exec(`INSERT INTO supplier_invoices (id, purchase_order_id, supplier_id, amount) VALUES (2, 2, 1, 1000); INSERT INTO supplier_invoice_line_items (supplier_invoice_id, po_line_item_id, description, quantity_billed, line_total) VALUES (2, 20, 'Vinyl', 12, 1000);`);
  rows = await getInvoiceMatchLines(env, 1, 2);
  check(rows.find((r) => r.poLineId === 20).unbilled === 18, 'a line partly invoiced stays in the pool with only what is left (30 ordered, 12 billed, 18 left)');
  db.exec(`CREATE TABLE IF NOT EXISTS purchase_order_cancellations (purchase_order_id INTEGER PRIMARY KEY, cancelled_by TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))); INSERT INTO purchase_order_cancellations (purchase_order_id) VALUES (2);`);
  ({ db, env } = (() => { const x = seeded(); x.db.exec(`CREATE TABLE IF NOT EXISTS purchase_order_cancellations (purchase_order_id INTEGER PRIMARY KEY, cancelled_by TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))); INSERT INTO purchase_order_cancellations (purchase_order_id) VALUES (1);`); return x; })());
  rows = await getInvoiceMatchLines(env, 1, 2);
  check(sameJson(rows.map((r) => r.poLineId), [20]), 'a cancelled order is not in the pool');
  ({ db, env } = seeded());
  db.exec(`INSERT INTO supplier_invoices (id, purchase_order_id, supplier_id, amount) VALUES (1, 1, 1, 1); INSERT INTO supplier_invoice_line_items (supplier_invoice_id, po_line_item_id, description, quantity_billed, line_total) VALUES (1, 10, 'Vinyl', 50, 1), (1, 11, 'Underlay', 100, 1), (1, 20, 'Vinyl', 30, 1);`);
  rows = await getInvoiceMatchLines(env, 1, 2);
  check(sameJson(rows.map((r) => [r.poId, r.poLineId, r.unbilled]), [[2, 20, 30]]), 'when every order is already invoiced in full, the LATEST order is used as before (with its whole quantity open), so nothing that worked is lost');

  // ---- 3. What the reader is shown and what the person is told -------------------------------------------------------
  const cand = invoiceCandidatesForReader(pool);
  check(cand.length === 2 && cand[0].description === 'Vinyl' && cand[1].description === 'Underlay', 'the reader is shown each item once, however many orders have it');
  check(invoiceOrdersNote([1]) === '' && invoiceOrdersNote([]) === '' && invoiceOrdersNote([1, 2]) === ' Matched across orders #1 and #2.' && invoiceOrdersNote([1, 3, 5]) === ' Matched across orders #1, #3 and #5.', 'the note is only added when an invoice spans orders, and reads naturally');
};
