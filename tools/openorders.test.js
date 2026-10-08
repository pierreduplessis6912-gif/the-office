// Tests for "what open orders do we have?" (found by the second real phone test, 2026-10-04): which orders count as open, and how they read.
module.exports = async function runOpenOrderTests({ check, bundleTo, srcDir, path, sameJson }) {
  const { getOpenOrdersAcrossSuppliers, openOrdersAnswer, cancelPurchaseOrder, describeOpenOrder } = bundleTo('finance.ts', 'rm-open-finance.js');
  const { newDatabase, d1 } = require('./harness.js');
  const workerDir = path.join(srcDir, '..');
  const db = newDatabase(workerDir);
  db.exec(`
    INSERT INTO characters (id, name, relationship) VALUES (1, 'Floornet', 'supplier'), (2, 'Belgotex', 'supplier'), (3, 'Quiet Supplies', 'supplier');
    INSERT INTO purchase_orders (id, supplier_id, description, created_at) VALUES
      (1, 1, 'Vinyl and underlay', '2026-10-01 08:00:00'), (2, 1, 'Grout', '2026-10-02 08:00:00'), (3, 2, 'Carpet', '2026-10-02 09:00:00'),
      (4, 1, 'Adhesive', '2026-10-03 08:00:00'), (5, 3, 'Tape', '2026-10-03 09:00:00'), (6, NULL, 'An order with no supplier', '2026-10-03 10:00:00');
    INSERT INTO po_line_items (id, purchase_order_id, description, quantity_ordered, unit) VALUES
      (1, 1, 'Vinyl', 50, 'sqm'), (2, 1, 'Underlay', 100, 'sqm'), (3, 2, 'Grout', 20, 'bag'), (4, 3, 'Carpet', 30, 'sqm'), (5, 4, 'Adhesive', 5, 'tube'), (6, 5, 'Tape', 9, 'roll'), (7, 6, 'Mystery', 1, 'each');
    INSERT INTO goods_received_notes (id, purchase_order_id, supplier_id, created_at) VALUES (1, 2, 1, '2026-10-03 09:00:00'), (2, 3, 2, '2026-10-03 09:30:00'), (3, 5, 3, '2026-10-04 08:00:00');
    INSERT INTO grn_line_items (id, grn_id, po_line_item_id, description, quantity_received, quantity_ordered, variance) VALUES (1, 1, 3, 'Grout', 20, 20, 0), (2, 2, 4, 'Carpet', 10, 30, -20), (3, 3, 6, 'Tape', 9, 9, 0);
  `);
  const env = { OFFICE_DB: d1(db) };
  await cancelPurchaseOrder(env, 4, 'owner@example.com');

  let rows = await getOpenOrdersAcrossSuppliers(env, null);
  check(sameJson(rows.map((r) => [r.supplier, r.order.id]), [['Belgotex', 3], ['Floornet', 1]]), 'open orders are those with something not yet received, by supplier: Belgotex #3 (20 of 30 still due) and Floornet #1 (nothing received)');
  check(!rows.some((r) => r.order.id === 2), 'an order delivered in full is not open');
  check(!rows.some((r) => r.order.id === 4), 'a cancelled order is not open');
  check(!rows.some((r) => r.order.id === 6) && !rows.some((r) => r.order.id === 5), 'an order with no supplier is not listed, and a supplier whose only order was delivered has nothing open');
  const carpet = rows.find((r) => r.order.id === 3).order;
  check(carpet.lines.length === 1 && carpet.lines[0].outstanding === 20, 'a part-delivered order shows only what is still due (20 of the 30 sqm)');
  rows = await getOpenOrdersAcrossSuppliers(env, 1);
  check(sameJson(rows.map((r) => r.order.id), [1]) && rows[0].supplier === 'Floornet', 'asked about one supplier it lists theirs only');
  check((await getOpenOrdersAcrossSuppliers(env, 3)).length === 0, 'a supplier with nothing open lists nothing');
  check((await getOpenOrdersAcrossSuppliers(env, 999)).length === 0, 'an unknown supplier lists nothing');

  const all = await getOpenOrdersAcrossSuppliers(env, null);
  check(openOrdersAnswer(all, null) === 'Open orders (2): Belgotex #3 Carpet (20 sqm Carpet not yet received); Floornet #1 Vinyl and underlay (50 sqm Vinyl, 100 sqm Underlay not yet received).', 'the answer names each supplier and what is still due');
  check(openOrdersAnswer(await getOpenOrdersAcrossSuppliers(env, 1), 'Floornet') === 'Open orders with Floornet: #1 Vinyl and underlay (50 sqm Vinyl, 100 sqm Underlay not yet received).', 'asked about one supplier it does not repeat the name on each line');
  check(openOrdersAnswer([], null) === 'There are no open orders.' && openOrdersAnswer([], 'Floornet') === 'Floornet has no open orders.', 'and says so when there are none');
  const many = Array.from({ length: 11 }, (_, i) => ({ supplier: 'S', order: { id: i + 1, description: 'x', lines: [{ description: 'Item', outstanding: 1, unit: 'each' }] } }));
  const long = openOrdersAnswer(many, null);
  check(/^Open orders \(11\): /.test(long) && /; and 3 more\.$/.test(long) && (long.match(/#\d+ x/g) || []).length === 8, 'a long list shows eight and says how many more');
  check(describeOpenOrder(carpet) === '#3 Carpet (20 sqm Carpet not yet received)', 'an order reads "#3 Carpet (20 sqm Carpet not yet received)"');
};
