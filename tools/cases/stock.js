// Characterization cases for stock: register_stock_item, stock_usage and stocktake. Stock items are only ever created by
// registering one on purpose; usage and counts match what was said to an item already tracked. Each branch asks a model
// to read the sentence, so each case scripts it.
module.exports = function cases(caps) {
  const base = (db) => db.exec(`
    INSERT INTO people (name) VALUES ('Jenny Smith');
    INSERT INTO customers (name, person_id) VALUES ('Jenny Smith', 1);
  `);
  const tracked = (db) => {
    base(db);
    db.exec(`INSERT INTO stock_items (name, unit, quantity_on_hand) VALUES ('Screed', 'bags', 15), ('Adhesive', 'litres', 8);`);
  };
  // "a box of laminate is 2.2 square metres" (decided 2026-10-04). The table is created by the code the first time it is needed;
  // a seed that needs it already there creates it with the same statement (a test compares the two).
  const unitConversionDdl = "CREATE TABLE IF NOT EXISTS unit_conversions (item_key TEXT NOT NULL, from_unit TEXT NOT NULL, to_unit TEXT NOT NULL, factor REAL NOT NULL, set_by TEXT, updated_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (item_key, from_unit, to_unit))";
  const UCONV = (reply) => ({ match: /how a pack unit converts for a material/, reply });
  const laminateBox = (db) => { base(db); db.exec(unitConversionDdl + "; INSERT INTO unit_conversions (item_key, from_unit, to_unit, factor, set_by) VALUES ('laminate', 'box', 'sqm', 2.2, 'owner@example.com');"); };
  const laminateInverse = (db) => { base(db); db.exec(unitConversionDdl + "; INSERT INTO unit_conversions (item_key, from_unit, to_unit, factor, set_by) VALUES ('laminate', 'sqm', 'box', 0.4545, 'owner@example.com');"); };
  const REG = (reply) => ({ match: /registering a real, consumable material to track as running stock/, reply });
  const USE = (reply) => ({ match: /reporting real stock being used up on a job/, reply });
  const COUNT = (reply) => ({ match: /reporting a real, physical stock count/, reply });
  const boom = () => { throw new Error('model unavailable'); };
  const c = (name, role, seed, intent, transcript, ai, extraction) => ({ name, seed, transcript, extraction: { intent, ...(extraction || {}) }, capabilities: caps[role], ai });
  return [
    // ---------------- set_unit_conversion ----------------
    c('unit conversion: owner, a box of laminate is 2.2 square metres', 'owner', base, 'set_unit_conversion', 'a box of laminate is 2.2 square metres', [UCONV({ item_name: 'laminate', from_unit: 'box', to_unit: 'square metres', factor: 2.2 })]),
    c('unit conversion: said again with a new number, it replaces the old one', 'owner', laminateBox, 'set_unit_conversion', 'a box of laminate is 2.4 square metres', [UCONV({ item_name: 'laminate', from_unit: 'boxes', to_unit: 'sqm', factor: 2.4 })]),
    c('unit conversion: said the other way round, it replaces the opposite pair', 'owner', laminateInverse, 'set_unit_conversion', 'a box of laminate is 2.2 square metres', [UCONV({ item_name: 'laminate', from_unit: 'box', to_unit: 'square metres', factor: 2.2 })]),
    c('unit conversion: installer', 'installer', base, 'set_unit_conversion', 'underlay comes 15 square metres to a roll', [UCONV({ item_name: 'underlay', from_unit: 'roll', to_unit: 'square metres', factor: 15 })]),
    c('unit conversion: a role with no permissions is refused', 'stranger', base, 'set_unit_conversion', 'a box of laminate is 2.2 square metres', [UCONV({ item_name: 'laminate', from_unit: 'box', to_unit: 'square metres', factor: 2.2 })]),
    c('unit conversion: a unit that is not recognised', 'owner', base, 'set_unit_conversion', 'a bundle of laminate is 2.2 square metres', [UCONV({ item_name: 'laminate', from_unit: 'bundle', to_unit: 'square metres', factor: 2.2 })]),
    c('unit conversion: both units are the same', 'owner', base, 'set_unit_conversion', 'a box of laminate is 2 boxes', [UCONV({ item_name: 'laminate', from_unit: 'box', to_unit: 'boxes', factor: 2 })]),
    c('unit conversion: the number is not stated', 'owner', base, 'set_unit_conversion', 'a box of laminate is some square metres', [UCONV({ item_name: 'laminate', from_unit: 'box', to_unit: 'square metres', factor: null })]),
    c('unit conversion: a number that is not positive is not stored', 'owner', base, 'set_unit_conversion', 'a box of laminate is minus 2 square metres', [UCONV({ item_name: 'laminate', from_unit: 'box', to_unit: 'square metres', factor: -2 })]),
    c('unit conversion: the model finds nothing', 'owner', base, 'set_unit_conversion', 'laminate boxes', [UCONV({ item_name: null, from_unit: null, to_unit: null, factor: null })]),
    c('unit conversion: the model fails', 'owner', base, 'set_unit_conversion', 'a box of laminate is 2.2 square metres', [UCONV(boom)]),
    c('unit conversion: a material misread as a customer name creates nobody', 'owner', base, 'set_unit_conversion', 'a box of laminate is 2.2 square metres', [UCONV({ item_name: 'laminate', from_unit: 'box', to_unit: 'square metres', factor: 2.2 })], { customer_name: 'Laminate' }),

    // ---------------- register_stock_item ----------------
    c('stock register: owner, a new item', 'owner', base, 'register_stock_item', 'start tracking screed in bags', [REG({ name: 'Screed', unit: 'bags' })]),
    c('stock register: owner, an item with no unit stated', 'owner', base, 'register_stock_item', 'start tracking grout', [REG({ name: 'Grout', unit: null })]),
    c('stock register: owner, an item that is already tracked', 'owner', tracked, 'register_stock_item', 'start tracking screed in bags', [REG({ name: 'Screed', unit: 'bags' })]),
    c('stock register: owner, the same item in a different case', 'owner', tracked, 'register_stock_item', 'start tracking SCREED in bags', [REG({ name: 'SCREED', unit: 'bags' })]),
    c('stock register: owner, a different item whose name starts like a tracked one', 'owner', tracked, 'register_stock_item', 'start tracking screed plus in bags', [REG({ name: 'Screed Plus', unit: 'bags' })]),
    c('stock register: owner, the model finds no name', 'owner', base, 'register_stock_item', 'start tracking something', [REG({ name: null, unit: null })]),
    c('stock register: owner, the model fails', 'owner', base, 'register_stock_item', 'start tracking screed in bags', [REG(boom)]),
    c('stock register: installer', 'installer', base, 'register_stock_item', 'start tracking screed in bags', [REG({ name: 'Screed', unit: 'bags' })]),
    c('stock register: a role with no permissions is refused', 'stranger', base, 'register_stock_item', 'start tracking screed in bags', []),

    // ---------------- stock_usage ----------------
    c('stock usage: owner, an item and a job', 'owner', tracked, 'stock_usage', 'used 3 bags of screed on Jenny\'s job', [USE({ matched_item_name: 'Screed', quantity_used: 3, job_customer_name: 'Jenny Smith' })]),
    c('stock usage: owner, an item and no job', 'owner', tracked, 'stock_usage', 'used 2 litres of adhesive', [USE({ matched_item_name: 'Adhesive', quantity_used: 2, job_customer_name: null })]),
    c('stock usage: owner, more than is on hand', 'owner', tracked, 'stock_usage', 'used 20 bags of screed', [USE({ matched_item_name: 'Screed', quantity_used: 20, job_customer_name: null })]),
    c('stock usage: owner, exactly what is on hand leaves nothing and says nothing is off', 'owner', tracked, 'stock_usage', 'used 15 bags of screed', [USE({ matched_item_name: 'Screed', quantity_used: 15, job_customer_name: null })]),
    c('stock usage: owner, an item that is not tracked', 'owner', tracked, 'stock_usage', 'used 4 tubes of silicone', [USE({ matched_item_name: null, quantity_used: 4, job_customer_name: null })]),
    c('stock usage: owner, an item but no quantity', 'owner', tracked, 'stock_usage', 'used some screed', [USE({ matched_item_name: 'Screed', quantity_used: null, job_customer_name: null })]),
    c('stock usage: owner, nothing is tracked yet', 'owner', base, 'stock_usage', 'used 3 bags of screed', []),
    c('stock usage: owner, the model fails', 'owner', tracked, 'stock_usage', 'used 3 bags of screed', [USE(boom)]),
    c('stock usage: installer', 'installer', tracked, 'stock_usage', 'used 3 bags of screed on Jenny\'s job', [USE({ matched_item_name: 'Screed', quantity_used: 3, job_customer_name: 'Jenny Smith' })]),
    c('stock usage: a role with no permissions is refused', 'stranger', tracked, 'stock_usage', 'used 3 bags of screed', []),

    // ---------------- stocktake ----------------
    c('stocktake: owner, a count that matches', 'owner', tracked, 'stocktake', 'counted 15 bags of screed', [COUNT({ matched_item_name: 'Screed', quantity_counted: 15 })]),
    c('stocktake: owner, a count that is short', 'owner', tracked, 'stocktake', 'counted 12 bags of screed', [COUNT({ matched_item_name: 'Screed', quantity_counted: 12 })]),
    c('stocktake: owner, a count that is over', 'owner', tracked, 'stocktake', 'counted 18 bags of screed', [COUNT({ matched_item_name: 'Screed', quantity_counted: 18 })]),
    c('stocktake: owner, an item that is not tracked', 'owner', tracked, 'stocktake', 'counted 9 tubes of silicone', [COUNT({ matched_item_name: null, quantity_counted: 9 })]),
    c('stocktake: owner, an item but no number', 'owner', tracked, 'stocktake', 'counted the screed', [COUNT({ matched_item_name: 'Screed', quantity_counted: null })]),
    c('stocktake: owner, nothing is tracked yet', 'owner', base, 'stocktake', 'counted 15 bags of screed', []),
    c('stocktake: owner, the model fails', 'owner', tracked, 'stocktake', 'counted 15 bags of screed', [COUNT(boom)]),
    c('stocktake: installer', 'installer', tracked, 'stocktake', 'counted 12 bags of screed', [COUNT({ matched_item_name: 'Screed', quantity_counted: 12 })]),
    c('stocktake: a role with no permissions is refused', 'stranger', tracked, 'stocktake', 'counted 12 bags of screed', []),
  ];
};
