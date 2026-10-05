// Tests for reopening a cancelled order (decided 2026-10-04): what comes back, and, as important, what does not.
module.exports = async function runReopenTests({ check, bundleTo, srcDir, path, sameJson }) {
  const { cancelPurchaseOrder, reopenPurchaseOrder, getCancelledOrdersForSupplier, describeCancelledOrder, getOutstandingOrderLines, getOpenOrdersForSupplier } = bundleTo('finance.ts', 'rm-reopen-finance.js');
  const { newDatabase, d1 } = require('./harness.js');
  const workerDir = path.join(srcDir, '..');
  const seeded = () => {
    const db = newDatabase(workerDir);
    db.exec(`
      INSERT INTO characters (id, name, relationship) VALUES (1, 'Floornet', 'supplier'), (2, 'Belgotex', 'supplier');
      INSERT INTO purchase_orders (id, supplier_id, description, created_at) VALUES (1, 1, 'Vinyl and underlay', '2026-10-01 08:00:00'), (2, 1, 'Grout', '2026-10-02 08:00:00'), (3, 2, 'Other supplier', '2026-10-01 09:00:00');
      INSERT INTO po_line_items (id, purchase_order_id, description, quantity_ordered, unit) VALUES (1, 1, 'Vinyl', 50, 'sqm'), (2, 1, 'Underlay', 100, 'sqm'), (3, 2, 'Grout', 20, 'bag'), (4, 3, 'Tape', 9, 'roll');
      INSERT INTO goods_received_notes (id, purchase_order_id, supplier_id, created_at) VALUES (1, 1, 1, '2026-10-02 09:00:00');
      INSERT INTO grn_line_items (id, grn_id, po_line_item_id, description, quantity_received, quantity_ordered, variance) VALUES (1, 1, 1, 'Vinyl', 40, 50, -10), (2, 1, 2, 'Underlay', 80, 100, -20), (3, 1, 2, 'Underlay', 100, 100, 0);
      INSERT INTO variance_dispositions (grn_line_item_id, reason, resolution, recorded_by) VALUES (2, 'supplier credited it', 'credit', 'owner@example.com');
    `);
    return { db, env: { OFFICE_DB: d1(db) } };
  };
  const count = async (env, sql) => (await env.OFFICE_DB.prepare(sql).first()).n;

  let { env } = seeded();
  check(sameJson(await getCancelledOrdersForSupplier(env, 1), []), 'with nothing cancelled there is nothing to reopen (and the table is created on first look)');
  const open = await getOpenOrdersForSupplier(env, 1);
  check(open.length === 2, 'both of the supplier\'s orders are open to begin with');
  const cancelled = await cancelPurchaseOrder(env, 1, 'owner@example.com');
  check(cancelled.closedShortages === 1, 'cancelling order 1 closes its ONE open shortage (the vinyl); the underlay shortage was already credited');
  check((await getOpenOrdersForSupplier(env, 1)).length === 1, 'and the order leaves the open list');
  const list = await getCancelledOrdersForSupplier(env, 1);
  check(list.length === 1 && list[0].id === 1 && list[0].lines.length === 2 && list[0].lines[0].ordered === 50, 'the cancelled list shows that order with its lines and what was ordered');
  check(/^#1 Vinyl and underlay \(50 sqm Vinyl, 100 sqm Underlay ordered, cancelled \d{4}-\d{2}-\d{2}\)$/.test(describeCancelledOrder(list[0])), 'and it reads "#1 Vinyl and underlay (50 sqm Vinyl, 100 sqm Underlay ordered, cancelled <date>)"');
  check((await getCancelledOrdersForSupplier(env, 2)).length === 0, 'another supplier\'s orders are never in the list');

  const back = await reopenPurchaseOrder(env, 1);
  check(back.alreadyOpen === false && back.reopenedShortages === 1, 'reopening brings back exactly the one shortage the cancellation closed');
  check((await count(env, "SELECT COUNT(*) AS n FROM variance_dispositions WHERE resolution = 'cancelled'")) === 0, 'no cancellation closure is left behind');
  check((await count(env, "SELECT COUNT(*) AS n FROM variance_dispositions WHERE resolution = 'credit'")) === 1, 'but the shortage that was CREDITED stays resolved: it was closed on its own account, not by the cancellation');
  check((await getOpenOrdersForSupplier(env, 1)).length === 2 && (await getOutstandingOrderLines(env, 1)).some((l) => l.poId === 1), 'the order is outstanding again, so a delivery matches it again');
  check((await getCancelledOrdersForSupplier(env, 1)).length === 0, 'and it is no longer in the cancelled list');
  const again = await reopenPurchaseOrder(env, 1);
  check(again.alreadyOpen === true && again.reopenedShortages === 0, 'reopening an order that is already open does nothing and says so');
  check((await reopenPurchaseOrder(env, 999)).alreadyOpen === true, 'an order that does not exist is "already open": nothing to bring back');

  // A shortage resolved by someone for a different reason AFTER cancelling must not be undone by reopening.
  ({ env } = seeded());
  await cancelPurchaseOrder(env, 1, null);
  await env.OFFICE_DB.prepare("INSERT INTO variance_dispositions (grn_line_item_id, reason, resolution, recorded_by) VALUES (3, 'written off by hand', 'accepted', 'owner@example.com')").run();
  const back2 = await reopenPurchaseOrder(env, 1);
  check(back2.reopenedShortages === 1 && (await count(env, "SELECT COUNT(*) AS n FROM variance_dispositions WHERE resolution = 'accepted'")) === 1, 'a closure recorded by hand is left alone, even on the same order');

  // Round trip: cancel, reopen, cancel again.
  ({ env } = seeded());
  await cancelPurchaseOrder(env, 1, null); await reopenPurchaseOrder(env, 1);
  const second = await cancelPurchaseOrder(env, 1, null);
  check(second.alreadyCancelled === false && second.closedShortages === 1, 'an order can be cancelled again after it was reopened, and closes its shortage again');
};
