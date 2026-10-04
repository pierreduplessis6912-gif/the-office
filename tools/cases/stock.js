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
  const REG = (reply) => ({ match: /registering a real, consumable material to track as running stock/, reply });
  const USE = (reply) => ({ match: /reporting real stock being used up on a job/, reply });
  const COUNT = (reply) => ({ match: /reporting a real, physical stock count/, reply });
  const boom = () => { throw new Error('model unavailable'); };
  const c = (name, role, seed, intent, transcript, ai, extraction) => ({ name, seed, transcript, extraction: { intent, ...(extraction || {}) }, capabilities: caps[role], ai });
  return [
    // ---------------- register_stock_item ----------------
    c('stock register: owner, a new item', 'owner', base, 'register_stock_item', 'start tracking screed in bags', [REG({ name: 'Screed', unit: 'bags' })]),
    c('stock register: owner, an item with no unit stated', 'owner', base, 'register_stock_item', 'start tracking grout', [REG({ name: 'Grout', unit: null })]),
    c('stock register: owner, an item that is already tracked', 'owner', tracked, 'register_stock_item', 'start tracking screed in bags', [REG({ name: 'Screed', unit: 'bags' })]),
    c('stock register: owner, the model finds no name', 'owner', base, 'register_stock_item', 'start tracking something', [REG({ name: null, unit: null })]),
    c('stock register: owner, the model fails', 'owner', base, 'register_stock_item', 'start tracking screed in bags', [REG(boom)]),
    c('stock register: installer', 'installer', base, 'register_stock_item', 'start tracking screed in bags', [REG({ name: 'Screed', unit: 'bags' })]),
    c('stock register: a role with no permissions is refused', 'stranger', base, 'register_stock_item', 'start tracking screed in bags', []),

    // ---------------- stock_usage ----------------
    c('stock usage: owner, an item and a job', 'owner', tracked, 'stock_usage', 'used 3 bags of screed on Jenny\'s job', [USE({ matched_item_name: 'Screed', quantity_used: 3, job_customer_name: 'Jenny Smith' })]),
    c('stock usage: owner, an item and no job', 'owner', tracked, 'stock_usage', 'used 2 litres of adhesive', [USE({ matched_item_name: 'Adhesive', quantity_used: 2, job_customer_name: null })]),
    c('stock usage: owner, more than is on hand', 'owner', tracked, 'stock_usage', 'used 20 bags of screed', [USE({ matched_item_name: 'Screed', quantity_used: 20, job_customer_name: null })]),
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
