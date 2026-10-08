// Tests for linking an order to the customer it is FOR (decided with Pierre 2026-10-04): who a cost is for, and what a job's costing shows.
module.exports = async function runOrderLinkTests({ check, bundleTo, srcDir, fs, path, sameJson }) {
  const { linkPurchaseOrderToCustomer, getCustomerForPurchaseOrders, getJobProfitability, cancelPurchaseOrder } = bundleTo('finance.ts', 'rm-links-finance.js');
  const { newDatabase, d1 } = require('./harness.js');
  const workerDir = path.join(srcDir, '..');
  const fresh = () => {
    const db = newDatabase(workerDir);
    db.exec(`
      INSERT INTO people (name) VALUES ('Jenny Smith'), ('Thandi Mokoena');
      INSERT INTO customers (id, name, person_id) VALUES (1, 'Jenny Smith', 1), (2, 'Thandi Mokoena', 2);
      INSERT INTO characters (id, name, relationship) VALUES (1, 'Floornet', 'supplier');
      INSERT INTO purchase_orders (id, supplier_id, description, created_at) VALUES (1, 1, 'Vinyl', '2026-10-01 08:00:00'), (2, 1, 'Grout', '2026-10-02 08:00:00'), (3, 1, 'Adhesive', '2026-10-03 08:00:00'), (4, 1, 'Tape', '2026-10-03 09:00:00');
      INSERT INTO po_line_items (id, purchase_order_id, description, quantity_ordered, unit, unit_price_expected) VALUES (1, 1, 'Vinyl', 10, 'sqm', 180), (2, 1, 'Underlay', 4, 'sqm', NULL), (3, 2, 'Grout', 20, 'bag', 90), (4, 3, 'Adhesive', 5, 'tube', 60), (5, 4, 'Tape', 9, 'roll', 10);
      INSERT INTO invoices (id, customer_id, description, amount, created_at) VALUES (1, 1, 'Lounge', 5000, '2026-10-01 08:00:00');
      INSERT INTO expenses (character_id, amount, description, source_transcript, category, customer_id) VALUES (1, 1200, 'adhesive', 'bought adhesive', 'materials', 1);
    `);
    return { db, env: { OFFICE_DB: d1(db) } };
  };

  // ---- who a cost is for ------------------------------------------------------------------------------------------
  let { env } = fresh();
  check((await getCustomerForPurchaseOrders(env, [1])) === null, 'an order with no link is for nobody (and the table is created on first look)');
  await linkPurchaseOrderToCustomer(env, 1, 1);
  check((await getCustomerForPurchaseOrders(env, [1])) === 1, 'a linked order is for its customer');
  await linkPurchaseOrderToCustomer(env, 2, 1);
  check((await getCustomerForPurchaseOrders(env, [1, 2])) === 1 && (await getCustomerForPurchaseOrders(env, [2, 1, 1])) === 1, 'two orders for the SAME customer are for that customer');
  await linkPurchaseOrderToCustomer(env, 3, 2);
  check((await getCustomerForPurchaseOrders(env, [1, 3])) === null, 'orders for DIFFERENT customers are for nobody (a guess would put a cost on the wrong job)');
  check((await getCustomerForPurchaseOrders(env, [1, 4])) === null, 'a linked order together with an unlinked one is for nobody');
  check((await getCustomerForPurchaseOrders(env, [])) === null && (await getCustomerForPurchaseOrders(env, [null, undefined])) === null && (await getCustomerForPurchaseOrders(env, [0])) === null, 'no orders, or none that are real, are for nobody');
  await linkPurchaseOrderToCustomer(env, 1, 2);
  check((await getCustomerForPurchaseOrders(env, [1])) === 2, 'linking an order again changes who it is for (one link per order)');
  const rowCount = (await env.OFFICE_DB.prepare('SELECT COUNT(*) AS n FROM purchase_order_customers').first()).n;
  check(rowCount === 3, 'and never leaves two links for one order');

  // ---- what a job's costing shows -----------------------------------------------------------------------------------
  ({ env } = fresh());
  let job = await getJobProfitability(env, 1);
  check(job.fact === 'Revenue R5000, costs linked to this job R1200, profit R3800.', 'with no order for the job the costing is exactly what it was');
  await linkPurchaseOrderToCustomer(env, 1, 1);
  job = await getJobProfitability(env, 1);
  check(job.fact === 'Revenue R5000, costs linked to this job R1200, profit R3800. Ordered for this job and not yet invoiced: R1800 plus 1 unpriced line (1 order).', 'an order placed for the job and not yet invoiced is a cost still to come: 10 sqm at R180, plus one line with no price');
  await linkPurchaseOrderToCustomer(env, 2, 1);
  job = await getJobProfitability(env, 1);
  check(/R3600 plus 1 unpriced line \(2 orders\)\.$/.test(job.fact), 'a second order adds to it (20 bags at R90 = R1800 more, two orders)');
  await linkPurchaseOrderToCustomer(env, 3, 2);
  check((await getJobProfitability(env, 1)).fact.includes('R3600'), 'an order placed for ANOTHER customer is not counted');
  await cancelPurchaseOrder(env, 2, null);
  job = await getJobProfitability(env, 1);
  check(/R1800 plus 1 unpriced line \(1 order\)\.$/.test(job.fact), 'a cancelled order is no longer a cost to come');
  await env.OFFICE_DB.prepare("INSERT INTO supplier_invoices (purchase_order_id, supplier_id, amount) VALUES (1, 1, 1900)").run();
  job = await getJobProfitability(env, 1);
  check(job.fact === 'Revenue R5000, costs linked to this job R1200, profit R3800.', 'an order that has been invoiced is no longer "not yet invoiced" (its cost arrives as an expense instead)');
  ({ env } = fresh());
  await linkPurchaseOrderToCustomer(env, 4, 2);
  job = await getJobProfitability(env, 2);
  check(job !== null && /Ordered for this job and not yet invoiced: R90 \(1 order\)\.$/.test(job.fact), 'a customer with only an order placed for them (no invoice or expense yet) still gets a costing');
  check((await getJobProfitability(env, 999)) === null, 'a customer with nothing at all gets none');

  // ---- the table the seeds create is the table the code creates ---------------------------------------------------
  const norm = (x) => x.replace(/\s+/g, ' ').trim();
  const code = fs.readFileSync(path.join(srcDir, 'finance.ts'), 'utf8').match(/"(CREATE TABLE IF NOT EXISTS purchase_order_customers [^"]*)"/);
  check(Boolean(code), 'the code creates the purchase_order_customers table');
  for (const f of ['actions', 'lookups']) {
    const seed = fs.readFileSync(path.join(__dirname, 'cases', f + '.js'), 'utf8').match(/"(CREATE TABLE IF NOT EXISTS purchase_order_customers [^"]*)"/);
    check(Boolean(seed) && Boolean(code) && norm(seed[1]) === norm(code[1]), `the table the ${f} cases create must be exactly the table the code creates`);
  }
};
