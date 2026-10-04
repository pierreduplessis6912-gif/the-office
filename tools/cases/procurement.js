// Characterization cases for the procurement group: purchase_order, goods_received, supplier_invoice,
// variance_disposition, and a spoken supplier_statement. Each branch asks the model to read the sentence, so each case
// scripts the model's reply (and some script a model that fails or finds nothing, because that behaviour is part of
// what the rewritten handlers must reproduce).
module.exports = function cases(caps) {
  // Floornet (id 1) and Belgotex (id 2) are suppliers; Belgotex has never been ordered from.
  const base = (db) => db.exec(`
    INSERT INTO characters (name, relationship) VALUES ('Floornet', 'supplier'), ('Belgotex', 'supplier'), ('Jabulani', 'installer');
  `);
  // One open order with two lines, nothing delivered yet.
  const withOrder = (db) => {
    base(db);
    db.exec(`
      INSERT INTO purchase_orders (id, supplier_id, description, created_at) VALUES (1, 1, 'Vinyl and underlay', '2026-10-01 08:00:00');
      INSERT INTO po_line_items (id, purchase_order_id, description, quantity_ordered, unit, unit_price_expected) VALUES (1, 1, 'Vinyl', 50, 'sqm', 180), (2, 1, 'Underlay', 100, 'sqm', 40);
    `);
  };
  // The same order, delivered short on underlay: one open discrepancy.
  const withOneDiscrepancy = (db) => {
    withOrder(db);
    db.exec(`
      INSERT INTO goods_received_notes (id, purchase_order_id, supplier_id, created_at) VALUES (1, 1, 1, '2026-10-02 09:00:00');
      INSERT INTO grn_line_items (grn_id, po_line_item_id, description, quantity_received, quantity_ordered, variance) VALUES (1, 1, 'Vinyl', 50, 50, 0), (1, 2, 'Underlay', 50, 100, -50);
    `);
  };
  // Short on both lines: two open discrepancies.
  const withTwoDiscrepancies = (db) => {
    withOrder(db);
    db.exec(`
      INSERT INTO goods_received_notes (id, purchase_order_id, supplier_id, created_at) VALUES (1, 1, 1, '2026-10-02 09:00:00');
      INSERT INTO grn_line_items (grn_id, po_line_item_id, description, quantity_received, quantity_ordered, variance) VALUES (1, 1, 'Vinyl', 40, 50, -10), (1, 2, 'Underlay', 50, 100, -50);
    `);
  };

  // Cancelling an order (decided 2026-10-04). Orders have no status column, so a cancellation is its own row, in a table the
  // code creates the first time it is needed; a seed that needs one already there creates it the same way.
  const cancellationDdl = `CREATE TABLE IF NOT EXISTS purchase_order_cancellations (purchase_order_id INTEGER PRIMARY KEY, cancelled_by TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));`;
  const twoOrders = (db) => {
    withOrder(db);
    db.exec(`
      INSERT INTO purchase_orders (id, supplier_id, description, created_at) VALUES (2, 1, 'Grout', '2026-10-02 08:00:00');
      INSERT INTO po_line_items (id, purchase_order_id, description, quantity_ordered, unit) VALUES (3, 2, 'Grout', 20, 'bag');
    `);
  };
  const fullyDelivered = (db) => {
    withOrder(db);
    db.exec(`
      INSERT INTO goods_received_notes (id, purchase_order_id, supplier_id, created_at) VALUES (1, 1, 1, '2026-10-02 09:00:00');
      INSERT INTO grn_line_items (grn_id, po_line_item_id, description, quantity_received, quantity_ordered, variance) VALUES (1, 1, 'Vinyl', 50, 50, 0), (1, 2, 'Underlay', 100, 100, 0);
    `);
  };
  const alreadyCancelled = (db) => { withOrder(db); db.exec(cancellationDdl + ` INSERT INTO purchase_order_cancellations (purchase_order_id, cancelled_by) VALUES (1, 'owner@example.com');`); };
  // Per-item unit conversion (decided 2026-10-04): a delivery counted in boxes against an order placed in square metres.
  const unitConversionDdl = "CREATE TABLE IF NOT EXISTS unit_conversions (item_key TEXT NOT NULL, from_unit TEXT NOT NULL, to_unit TEXT NOT NULL, factor REAL NOT NULL, set_by TEXT, updated_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (item_key, from_unit, to_unit))";
  const withConversion = (rows) => (db) => { withOrder(db); db.exec(unitConversionDdl + '; ' + rows); };
  const vinylBoxes = withConversion("INSERT INTO unit_conversions (item_key, from_unit, to_unit, factor) VALUES ('vinyl', 'box', 'sqm', 2.5);");
  const vinylBoxesInverse = withConversion("INSERT INTO unit_conversions (item_key, from_unit, to_unit, factor) VALUES ('vinyl', 'sqm', 'box', 0.4);");
  const quickstep = (db) => {
    base(db);
    db.exec(unitConversionDdl + `;
      INSERT INTO unit_conversions (item_key, from_unit, to_unit, factor) VALUES ('laminate', 'box', 'sqm', 2.2);
      INSERT INTO purchase_orders (id, supplier_id, description, created_at) VALUES (1, 1, 'Quickstep laminate', '2026-10-01 08:00:00');
      INSERT INTO po_line_items (id, purchase_order_id, description, quantity_ordered, unit) VALUES (1, 1, 'Quickstep laminate', 22, 'sqm');
    `);
  };
  const delivery = (item, desc, unit, qty) => GRAI({ supplier_name: 'Floornet', line_items: [{ matched_description: item, item_description: desc, unit, quantity_received: qty }] });
  const POAI = (reply) => ({ match: /line_items is every distinct material/, reply });
  const GRAI = (reply) => ({ match: /quantity_received/, reply });
  const SIAI = (reply) => ({ match: /quantity_billed/, reply });
  const VDAI = (reply) => ({ match: /short_delivered/, reply });
  const boom = () => { throw new Error('model unavailable'); };
  const sup = (name = 'Floornet') => ({ character_name: name, character_relationship: 'supplier' });
  const c = (name, role, seed, intent, extraction, transcript, ai) => ({ name, seed, transcript, extraction: { intent, ...extraction }, capabilities: caps[role], ai });

  return [
    // ---------------- purchase_order ----------------
    c('purchase order: owner, existing supplier, three lines', 'owner', base, 'purchase_order', sup(), 'order 50 sqm vinyl, 100 sqm underlay and 10 lengths of skirting from Floornet',
      [POAI({ supplier_name: 'Floornet', description: 'Vinyl, underlay and skirting', line_items: [
        { description: 'Vinyl', quantity_ordered: 50, unit: 'sqm', unit_price_expected: null, product: 'vinyl' },
        { description: 'Underlay', quantity_ordered: 100, unit: 'sqm', unit_price_expected: 40, product: 'underlay' },
        { description: 'Skirting', quantity_ordered: 10, unit: 'length', unit_price_expected: null, product: 'skirting' }] })]),
    c('purchase order: owner, a supplier nobody has heard of', 'owner', base, 'purchase_order', sup('Newco Supplies'), 'order 20 bags of adhesive from Newco Supplies',
      [POAI({ supplier_name: 'Newco Supplies', description: 'Adhesive', line_items: [{ description: 'Adhesive', quantity_ordered: 20, unit: 'bag', unit_price_expected: null, product: 'adhesive' }] })]),
    c('purchase order: owner, no supplier named', 'owner', base, 'purchase_order', {}, 'order 20 bags of adhesive', []),
    c('purchase order: owner, the model finds no items', 'owner', base, 'purchase_order', sup(), 'order some stuff from Floornet',
      [POAI({ supplier_name: 'Floornet', description: 'some stuff', line_items: [] })]),
    c('purchase order: owner, the model fails', 'owner', base, 'purchase_order', sup(), 'order vinyl from Floornet', [POAI(boom)]),
    c('purchase order: accountant', 'accountant', base, 'purchase_order', sup(), 'order 20 bags of adhesive from Floornet',
      [POAI({ supplier_name: 'Floornet', description: 'Adhesive', line_items: [{ description: 'Adhesive', quantity_ordered: 20, unit: 'bag', unit_price_expected: null, product: 'adhesive' }] })]),
    c('purchase order: installer is refused', 'installer', base, 'purchase_order', sup(), 'order 20 bags of adhesive from Floornet', []),

    // ---------------- goods_received ----------------
    c('goods received: owner, matches the open order', 'owner', withOrder, 'goods_received', sup(), 'Floornet delivered the vinyl, 50 square metres',
      [GRAI({ supplier_name: 'Floornet', line_items: [{ matched_description: 'Vinyl', item_description: 'vinyl', unit: 'sqm', quantity_received: 50 }] })]),
    c('goods received: owner, a short delivery', 'owner', withOrder, 'goods_received', sup(), 'Floornet delivered 40 square metres of vinyl',
      [GRAI({ supplier_name: 'Floornet', line_items: [{ matched_description: 'Vinyl', item_description: 'vinyl', unit: 'sqm', quantity_received: 40 }] })]),
    c('goods received: owner, something that was never ordered', 'owner', withOrder, 'goods_received', sup(), 'Floornet delivered 5 bags of grout',
      [GRAI({ supplier_name: 'Floornet', line_items: [{ matched_description: null, item_description: 'grout', unit: 'bag', quantity_received: 5 }] })]),
    c('goods received: owner, ordered and unordered items together', 'owner', withOrder, 'goods_received', sup(), 'Floornet delivered the vinyl and 5 bags of grout',
      [GRAI({ supplier_name: 'Floornet', line_items: [{ matched_description: 'Vinyl', item_description: 'vinyl', unit: 'sqm', quantity_received: 50 }, { matched_description: null, item_description: 'grout', unit: 'bag', quantity_received: 5 }] })]),
    c('goods received: owner, the supplier has no open order at all', 'owner', base, 'goods_received', sup('Belgotex'), 'Belgotex delivered 3 rolls of carpet',
      [GRAI({ supplier_name: 'Belgotex', line_items: [{ matched_description: null, item_description: 'carpet', unit: 'roll', quantity_received: 3 }] })]),
    c('goods received: owner, the model finds no items', 'owner', withOrder, 'goods_received', sup(), 'Floornet delivered something', [GRAI({ supplier_name: 'Floornet', line_items: [] })]),
    c('goods received: owner, the model fails', 'owner', withOrder, 'goods_received', sup(), 'Floornet delivered the vinyl', [GRAI(boom)]),
    c('goods received: owner, no supplier named', 'owner', withOrder, 'goods_received', {}, 'the vinyl was delivered', []),
    c('goods received: accountant', 'accountant', withOrder, 'goods_received', sup(), 'Floornet delivered the vinyl, 50 square metres',
      [GRAI({ supplier_name: 'Floornet', line_items: [{ matched_description: 'Vinyl', item_description: 'vinyl', unit: 'sqm', quantity_received: 50 }] })]),
    c('goods received: installer takes the delivery (decided 2026-10-03)', 'installer', withOrder, 'goods_received', sup(), 'Floornet delivered the vinyl, 50 square metres',
      [GRAI({ supplier_name: 'Floornet', line_items: [{ matched_description: 'Vinyl', item_description: 'vinyl', unit: 'sqm', quantity_received: 50 }] })]),
    c('goods received: a role with no permissions is refused', 'stranger', withOrder, 'goods_received', sup(), 'Floornet delivered the vinyl', []),

    // ---------------- a delivery in a different unit from the order ----------------
    c('goods received: a delivery in boxes is converted with the conversion on file', 'owner', vinylBoxes, 'goods_received', sup(), 'Floornet delivered 20 boxes of vinyl', [delivery('Vinyl', 'vinyl', 'boxes', 20)]),
    c('goods received: boxes against square metres and no conversion known, so it asks and holds nothing', 'owner', withOrder, 'goods_received', sup(), 'Floornet delivered 20 boxes of vinyl', [delivery('Vinyl', 'vinyl', 'boxes', 20)]),
    c('goods received: a conversion stored the other way round is still used', 'owner', vinylBoxesInverse, 'goods_received', sup(), 'Floornet delivered 20 boxes of vinyl', [delivery('Vinyl', 'vinyl', 'boxes', 20)]),
    c('goods received: the same unit written differently is not a mismatch', 'owner', withOrder, 'goods_received', sup(), 'Floornet delivered 50 square metres of vinyl', [delivery('Vinyl', 'vinyl', 'square metres', 50)]),
    c('goods received: a unit that is not recognised is compared as before', 'owner', withOrder, 'goods_received', sup(), 'Floornet delivered 5 bundles of vinyl', [delivery('Vinyl', 'vinyl', 'bundles', 5)]),
    c('goods received: no unit stated is compared as before', 'owner', withOrder, 'goods_received', sup(), 'Floornet delivered 50 of vinyl', [delivery('Vinyl', 'vinyl', null, 50)]),
    c('goods received: one line converts and another cannot, so it asks and holds nothing', 'owner', vinylBoxes, 'goods_received', sup(), 'Floornet delivered 20 boxes of vinyl and 8 rolls of underlay',
      [GRAI({ supplier_name: 'Floornet', line_items: [{ matched_description: 'Vinyl', item_description: 'vinyl', unit: 'boxes', quantity_received: 20 }, { matched_description: 'Underlay', item_description: 'underlay', unit: 'rolls', quantity_received: 8 }] })]),
    c('goods received: a conversion for "laminate" applies to "Quickstep laminate"', 'owner', quickstep, 'goods_received', sup(), 'Floornet delivered 10 boxes of Quickstep laminate', [delivery('Quickstep laminate', 'quickstep laminate', 'boxes', 10)]),
    c('goods received: an item that is not on the order has no order unit to convert to', 'owner', vinylBoxes, 'goods_received', sup(), 'Floornet delivered 4 boxes of grout', [delivery(null, 'grout', 'boxes', 4)]),
    c('goods received: an installer takes a delivery in boxes with the conversion on file', 'installer', vinylBoxes, 'goods_received', sup(), 'Floornet delivered 20 boxes of vinyl', [delivery('Vinyl', 'vinyl', 'boxes', 20)]),

    // ---------------- supplier_invoice ----------------
    c('supplier invoice: owner, open order, matched and priced', 'owner', withOrder, 'supplier_invoice', sup(), 'Floornet invoice INV-7731: 50 sqm vinyl at 185 and 100 sqm underlay at 40',
      [SIAI({ supplier_name: 'Floornet', supplier_reference: 'INV-7731', line_items: [{ matched_description: 'Vinyl', quantity_billed: 50, unit_price_billed: 185 }, { matched_description: 'Underlay', quantity_billed: 100, unit_price_billed: 40 }] })]),
    c('supplier invoice: owner, billed for something not on the order', 'owner', withOrder, 'supplier_invoice', sup(), 'Floornet invoice: 5 bags grout at 90',
      [SIAI({ supplier_name: 'Floornet', supplier_reference: null, line_items: [{ matched_description: null, quantity_billed: 5, unit_price_billed: 90 }] })]),
    c('supplier invoice: owner, the supplier has no open order', 'owner', base, 'supplier_invoice', sup('Belgotex'), 'Belgotex invoice for 3 rolls of carpet at 900', []),
    c('supplier invoice: owner, no supplier named', 'owner', withOrder, 'supplier_invoice', {}, 'invoice for 50 sqm vinyl at 185', []),
    c('supplier invoice: owner, the model fails', 'owner', withOrder, 'supplier_invoice', sup(), 'Floornet invoice for the vinyl', [SIAI(boom)]),
    c('supplier invoice: accountant', 'accountant', withOrder, 'supplier_invoice', sup(), 'Floornet invoice: 50 sqm vinyl at 185',
      [SIAI({ supplier_name: 'Floornet', supplier_reference: null, line_items: [{ matched_description: 'Vinyl', quantity_billed: 50, unit_price_billed: 185 }] })]),
    c('supplier invoice: installer is refused', 'installer', withOrder, 'supplier_invoice', sup(), 'Floornet invoice: 50 sqm vinyl at 185', []),

    // ---------------- variance_disposition ----------------
    c('variance disposition: owner, a reason only', 'owner', withOneDiscrepancy, 'variance_disposition', sup(), 'the underlay shortage from Floornet was short delivered',
      [VDAI({ matched_description: 'Underlay', reason: 'short_delivered', resolution: null, credit_amount: null })]),
    c('variance disposition: owner, a back order', 'owner', withOneDiscrepancy, 'variance_disposition', sup(), 'Floornet will back order the 50 missing underlay',
      [VDAI({ matched_description: 'Underlay', reason: 'short_delivered', resolution: 'back_order', credit_amount: null })]),
    c('variance disposition: owner, a credit with an amount is held for confirmation', 'owner', withOneDiscrepancy, 'variance_disposition', sup(), 'Floornet is crediting us R2000 for the underlay shortage',
      [VDAI({ matched_description: 'Underlay', reason: 'short_delivered', resolution: 'credit', credit_amount: 2000 })]),
    c('variance disposition: owner, a credit with no amount stated', 'owner', withOneDiscrepancy, 'variance_disposition', sup(), 'Floornet will credit the underlay shortage',
      [VDAI({ matched_description: 'Underlay', reason: 'short_delivered', resolution: 'credit', credit_amount: null })]),
    c('variance disposition: owner, the model names nothing and there is one discrepancy', 'owner', withOneDiscrepancy, 'variance_disposition', sup(), 'that shortage was damaged stock',
      [VDAI({ matched_description: null, reason: 'damaged', resolution: null, credit_amount: null })]),
    c('variance disposition: owner, the model names nothing and there are two discrepancies', 'owner', withTwoDiscrepancies, 'variance_disposition', sup(), 'that shortage was damaged stock',
      [VDAI({ matched_description: null, reason: 'damaged', resolution: null, credit_amount: null })]),
    c('variance disposition: owner, the model names one of two', 'owner', withTwoDiscrepancies, 'variance_disposition', sup(), 'the vinyl shortage was short delivered',
      [VDAI({ matched_description: 'Vinyl', reason: 'short_delivered', resolution: null, credit_amount: null })]),
    c('variance disposition: owner, nothing is open for that supplier', 'owner', withOrder, 'variance_disposition', sup(), 'the shortage was damaged', []),
    c('variance disposition: owner, no supplier named', 'owner', withOneDiscrepancy, 'variance_disposition', {}, 'the shortage was damaged', []),
    c('variance disposition: owner, the model fails', 'owner', withOneDiscrepancy, 'variance_disposition', sup(), 'the underlay shortage was short delivered', [VDAI(boom)]),
    c('variance disposition: accountant', 'accountant', withOneDiscrepancy, 'variance_disposition', sup(), 'the underlay shortage was short delivered',
      [VDAI({ matched_description: 'Underlay', reason: 'short_delivered', resolution: null, credit_amount: null })]),
    c('variance disposition: installer is refused', 'installer', withOneDiscrepancy, 'variance_disposition', sup(), 'the underlay shortage was short delivered', []),

    // ---------------- cancel_order (a held action: it asks first, and never guesses which order) ----------------
    c('cancel order: owner, the supplier has one open order', 'owner', withOrder, 'cancel_order', sup(), 'cancel the Floornet order', []),
    c('cancel order: owner, several open orders and no number, so it asks which', 'owner', twoOrders, 'cancel_order', sup(), 'cancel the Floornet order', []),
    c('cancel order: owner, several open orders and a number picks one', 'owner', twoOrders, 'cancel_order', sup(), 'cancel order 2 with Floornet', []),
    c('cancel order: owner, a number that is not one of the open orders', 'owner', twoOrders, 'cancel_order', sup(), 'cancel order 9 with Floornet', []),
    c('cancel order: owner, a number that is really a quantity is not an order number', 'owner', withOrder, 'cancel_order', sup(), 'cancel the order of 50 sqm vinyl from Floornet', []),
    c('cancel order: owner, a number followed by a unit is a quantity, not an order number', 'owner', twoOrders, 'cancel_order', sup(), 'cancel the Floornet order 50 sqm of vinyl', []),
    c('cancel order: owner, the supplier has nothing outstanding', 'owner', fullyDelivered, 'cancel_order', sup(), 'cancel the Floornet order', []),
    c('cancel order: owner, an order already cancelled is not offered again', 'owner', alreadyCancelled, 'cancel_order', sup(), 'cancel the Floornet order', []),
    c('cancel order: owner, no supplier named', 'owner', withOrder, 'cancel_order', {}, 'cancel the order', []),
    c('cancel order: owner, a supplier nobody has heard of is not created', 'owner', withOrder, 'cancel_order', sup('Nobody Known'), 'cancel the Nobody Known order', []),
    c('cancel order: accountant', 'accountant', withOrder, 'cancel_order', sup(), 'cancel the Floornet order', []),
    c('cancel order: installer is refused', 'installer', withOrder, 'cancel_order', sup(), 'cancel the Floornet order', []),
    c('cancel order: a role with no permissions is refused', 'stranger', withOrder, 'cancel_order', sup(), 'cancel the Floornet order', []),
    // what a cancelled order stops doing
    c('goods received: a delivery after the order was cancelled has no open order to match', 'owner', alreadyCancelled, 'goods_received', sup(), 'Floornet delivered the vinyl, 50 square metres',
      [GRAI({ supplier_name: 'Floornet', line_items: [{ matched_description: 'Vinyl', item_description: 'vinyl', unit: 'sqm', quantity_received: 50 }] })]),
    c('supplier invoice: the only order was cancelled, so there is no open order', 'owner', alreadyCancelled, 'supplier_invoice', sup(), 'Floornet invoice for 50 sqm vinyl at 185', []),

    // ---------------- supplier_statement, spoken ----------------
    c('supplier statement, spoken: owner', 'owner', withOrder, 'supplier_statement', sup(), 'Floornet sent their statement, it says we owe R20000', []),
    c('supplier statement, spoken: installer is refused', 'installer', withOrder, 'supplier_statement', sup(), 'Floornet sent their statement, it says we owe R20000', []),
  ];
};
