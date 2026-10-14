// Atomic writes (worker/src/atomic.ts, the adapter's transaction(), and the 21 operations wrapped in it). An operation that writes to several places must all happen or none: until 2026-10-14 each statement ran
// after the last, so a failure part-way stranded a parent without its lines (SHIP_CHECKLIST.md item 9). The PROOF here is fault injection against the REAL functions and a real SQLite: each operation is run once to
// count its writes, then run again failing at EVERY write position in turn, and the database must end up IDENTICAL to before. The same is then done with transactions switched off, and the damage must show:
// a control, so the test cannot pass by being too gentle.
const path = require('path'), fs = require('fs'), os = require('os'), esbuild = require('esbuild');
const { DatabaseSync } = require('node:sqlite');

module.exports = async function runAtomicTests(context) {
  const standIn = global.Response;
  if (global.__RealResponse) global.Response = global.__RealResponse;
  try { await atomicTests(context); } finally { global.Response = standIn; }
};

async function atomicTests({ check, srcDir }) {
  const bundle = (entry) => { const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'at-')), 'm.js'); esbuild.buildSync({ entryPoints: [path.join(srcDir, entry)], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent' }); return require(out); };
  const at = bundle('atomic.ts'), fin = bundle('finance.ts'), idn = bundle('identity.ts'), { DoD1Database } = bundle('storage/do-d1.ts');
  const baseline = fs.readFileSync(path.join(srcDir, '..', 'migrations', '0001_baseline.sql'), 'utf8');
  const plain = (r) => (r ? { ...r } : r);

  // ---- a world: a real SQLite behind the adapter, a counter and an injector for write statements, transactions on or off --------------------------------------------------------------------------------
  const makeWorld = ({ transactions = true, schema = baseline } = {}) => {
    const db = new DatabaseSync(':memory:'); db.exec(schema);
    const state = { writes: 0, failAt: 0 };
    const isWrite = (q) => /^\s*(insert|update|delete)\b/i.test(q);
    const sql = {
      exec(q, ...b) {
        if (isWrite(q)) { state.writes++; if (state.failAt && state.writes === state.failAt) throw new Error('injected failure at write ' + state.writes); }
        const s = db.prepare(q);
        if (/^\s*(select|with|pragma|values)\b/i.test(q) || /\breturning\b/i.test(q)) { const rows = s.all(...b).map(plain); return { toArray: () => rows, rowsRead: rows.length, rowsWritten: 0 }; }
        const r = s.run(...b); return { toArray: () => [], rowsRead: 0, rowsWritten: Number(r.changes) };
      },
    };
    let depth = 0, sp = 0;
    const open = () => { if (depth === 0) { db.exec('BEGIN'); return null; } const n = 'sp' + (++sp); db.exec('SAVEPOINT ' + n); return n; };
    const close = (n) => (n === null ? db.exec('COMMIT') : db.exec('RELEASE ' + n));
    const undo = (n) => { if (n === null) db.exec('ROLLBACK'); else { db.exec('ROLLBACK TO ' + n); db.exec('RELEASE ' + n); } };
    const storage = { transactionSync(fn) { const n = open(); depth++; try { const r = fn(); depth--; close(n); return r; } catch (e) { depth--; undo(n); throw e; } } };
    if (transactions) storage.transaction = async (fn) => { const n = open(); depth++; try { const r = await fn(); depth--; close(n); return r; } catch (e) { depth--; undo(n); throw e; } };
    const env = { OFFICE_DB: new DoD1Database(sql, storage), AI: { run: async () => ({ response: 'OTHER' }) }, MEMORY: { upsert: async () => ({}) } };
    return { db, env, state, arm: (n) => { state.writes = 0; state.failAt = n; } };
  };
  const dump = (db) => JSON.stringify(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((t) => [t.name, db.prepare(`SELECT * FROM "${t.name}" ORDER BY rowid`).all().map(plain)]));

  // ---- the helper itself, on a tiny schema ------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const tiny = 'CREATE TABLE a (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT); CREATE TABLE b (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT);';
  const W = makeWorld({ schema: tiny });
  const put = (env, t, v) => env.OFFICE_DB.prepare(`INSERT INTO ${t} (v) VALUES (?)`).bind(v).run();
  const rows = (w, t) => w.db.prepare(`SELECT v FROM ${t} ORDER BY id`).all().map((r) => r.v);
  const answer = await at.atomically(W.env, async (e) => { await put(e, 'a', 'one'); await put(e, 'b', 'two'); return 'done'; });
  check(answer === 'done' && rows(W, 'a').join() === 'one' && rows(W, 'b').join() === 'two', 'atomically runs the body, commits what it wrote and returns what it returned');
  const boom = new Error('the second write fails');
  let caught = null; try { await at.atomically(W.env, async (e) => { await put(e, 'a', 'LOST'); await put(e, 'b', 'LOST'); throw boom; }); } catch (e) { caught = e; }
  check(caught === boom && rows(W, 'a').join() === 'one' && rows(W, 'b').join() === 'two', 'when the body throws EVERYTHING it wrote is undone, and the very same error reaches the caller');
  let inner = null; let outerFlag = null;
  try { await at.atomically(W.env, async (e) => { outerFlag = e.__atomic; await put(e, 'a', 'outer'); await at.atomically(e, async (e2) => { inner = e2.__atomic; await put(e2, 'b', 'inner'); }); throw new Error('outer fails after the inner finished'); }); } catch { /* expected */ }
  check(outerFlag === true && inner === true && rows(W, 'a').join() === 'one' && rows(W, 'b').join() === 'two', 'an operation inside another JOINS it: when the outer one later fails, what the inner one wrote is undone with the rest');
  await at.atomically(W.env, async (e) => { await put(e, 'a', 'after'); });
  check(rows(W, 'a').join() === 'one,after' && W.env.__atomic === undefined, 'after a failure the next transaction works (nothing is left open), and the caller\'s own environment is never flagged');
  const guarded = [];
  await at.atomically(W.env, async (e) => {
    for (const [name, fn] of [['AI', () => e.AI.run('m')], ['MEMORY', () => e.MEMORY.upsert([])]]) { try { fn(); guarded.push('NOT REFUSED ' + name); } catch (err) { guarded.push(err.message); } }
    await put(e, 'b', 'db still works');
  });
  check(guarded.length === 2 && guarded.every((m) => /was used inside a transaction: only the database may be touched/.test(m)) && /AI\.run/.test(guarded[0]) && /MEMORY\.upsert/.test(guarded[1]) && rows(W, 'b').includes('db still works'), 'inside a transaction the model and the memory index REFUSE to be used, with a message that says why; the database works; (outside, they are untouched)');
  check((await W.env.AI.run()).response === 'OTHER', 'outside a transaction the same bindings work normally');
  const bare = makeWorld({ transactions: false, schema: tiny });
  const noTx = []; try { await at.atomically(bare.env, async (e) => { noTx.push(e.__atomic); await put(e, 'a', 'kept'); throw new Error('x'); }); } catch { /* expected */ }
  check(noTx[0] === true && rows(bare, 'a').join() === 'kept', 'a database that cannot do transactions (the single-business D1 deployment, a test\'s fake) runs the body EXACTLY as before: flagged so it does not loop, and nothing is undone');
  const fakeEnv = { OFFICE_DB: { prepare: () => ({}) } };
  check((await at.atomically(fakeEnv, async (e) => e.OFFICE_DB === fakeEnv.OFFICE_DB && e.__atomic === true)) === true, 'a hand-made fake database works too (the existing finance tests rely on it)');

  // ---- the real operations: fail at EVERY write position -------------------------------------------------------------------------------------------------------------------------------------------------
  const L = (d, q, p) => ({ description: d, note: null, quantity: q, unit: 'sqm', unit_price: p, line_total: q * p, discount_percent: null, product_id: null, room: null });
  const PO = (d, q) => ({ description: d, quantity_ordered: q, unit: 'bag', unit_price_expected: 50, product_id: null });
  const person = (w) => w.db.exec("INSERT INTO customers (name) VALUES ('Test Customer'); INSERT INTO characters (name, relationship) VALUES ('Test Supplier', 'supplier'); INSERT INTO stock_items (name, unit, quantity_on_hand) VALUES ('Grout', 'bag', 10)");
  const cases = [
    ['recordInvoice (the invoice and its lines)', person, (e) => fin.recordInvoice(e, 1, 'Bathroom floor', 500, 'transcript', [L('Vinyl', 2, 100), L('Labour', 3, 100)], null)],
    ['recordQuotation (the quotation and its lines)', person, (e) => fin.recordQuotation(e, 1, 'Kitchen', 500, 'transcript', [L('Tiles', 2, 100), L('Labour', 3, 100)], null)],
    ['recordPurchaseOrder (the order and its lines)', person, (e) => fin.recordPurchaseOrder(e, 2, 'Order', 'transcript', [PO('Grout', 5), PO('Adhesive', 2)])],
    ['convertQuoteToInvoice (the invoice, its lines, the quotation)', async (w) => { person(w); await fin.recordQuotation(w.env, 1, 'Kitchen', 500, 'transcript', [L('Tiles', 2, 100), L('Labour', 3, 100)], null); }, (e) => fin.convertQuoteToInvoice(e, 1, 1, 'Kitchen', 300, 'transcript')],
    ['recordStockUsage (the stock and its usage log)', person, (e) => fin.recordStockUsage(e, 1, 3, 1, 'transcript')],
    ['recordStocktake (the stock and its stocktake)', person, (e) => fin.recordStocktake(e, 1, 8, 'transcript')],
    ['recordVarianceDisposition (the disposition and the credit expense it creates)', async (w) => { person(w); await fin.recordPurchaseOrder(w.env, 2, 'Order', 'transcript', [PO('Grout', 20)]); await fin.recordDelivery(w.env, 2, 'raw delivery', [{ matched_description: 'Grout', quantity_received: 5, item_description: 'Grout', unit: 'bag' }], 'p@x.com'); }, (e) => fin.recordVarianceDisposition(e, 1, 'short delivery', 'credit', 50, 'p@x.com')],
    ['recordDelivery (the delivery note, its lines and the stock updates)', async (w) => { person(w); await fin.recordPurchaseOrder(w.env, 2, 'Order', 'transcript', [PO('Grout', 20), PO('Adhesive', 6)]); }, (e) => fin.recordDelivery(e, 2, 'raw delivery', [{ matched_description: 'Grout', quantity_received: 5, item_description: 'Grout', unit: 'bag' }, { matched_description: 'Adhesive', quantity_received: 2, item_description: 'Adhesive', unit: 'bag' }], 'p@x.com')],
  ];
  let positions = 0; const verdicts = [];
  for (const [label, setup, op] of cases) {
    // the normal run: it must work, write in more than one statement, and change the database
    const ok = makeWorld(); await setup(ok); const before = dump(ok.db); ok.arm(0); let normalError = null;
    try { await op(ok.env); } catch (e) { normalError = e; }
    const total = ok.state.writes;
    if (normalError || total < 2 || dump(ok.db) === before) { verdicts.push({ label, ok: false, why: normalError ? `the normal run failed: ${String(normalError.message).slice(0, 120)}` : `the normal run did not write in several statements (${total})` }); continue; }
    // failing at every position, with transactions: nothing may be left behind, and the injected error must reach the caller
    let leaks = 0, wrongError = 0;
    for (let k = 1; k <= total; k++) {
      const w = makeWorld(); await setup(w); const pre = dump(w.db); w.arm(k);
      let err = null; try { await op(w.env); } catch (e) { err = e; }
      positions++;
      if (!err || err.message !== `injected failure at write ${k}`) wrongError++;
      if (dump(w.db) !== pre) leaks++;
    }
    // the CONTROL: the same faults without transactions must leave damage (otherwise this test proves nothing)
    let damaged = 0;
    for (let k = 2; k <= total; k++) { const w = makeWorld({ transactions: false }); await setup(w); const pre = dump(w.db); w.arm(k); try { await op(w.env); } catch { /* expected */ } if (dump(w.db) !== pre) damaged++; }
    verdicts.push({ label, ok: leaks === 0 && wrongError === 0 && damaged === total - 1, total, leaks, wrongError, damaged });
  }
  for (const v of verdicts) check(v.ok === true, `${v.label}: ${v.ok ? `failing at each of its ${v.total} writes leaves NOTHING behind (the same faults WITHOUT a transaction damaged the data ${v.damaged} of ${v.total - 1} times: the control bites)` : `FAULT INJECTION FAILED: ${v.why ?? `leaks ${v.leaks}, wrong error ${v.wrongError}, control damage ${v.damaged}/${v.total - 1}`}`}`);
  check(positions >= 22, `${positions} fault positions were tried across ${cases.length} real operations`);

  // ---- the wiring --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const wrapped = { 'finance.ts': ['recordInvoice', 'recordQuotation', 'recordPurchaseOrder', 'recordSupplierInvoice', 'convertQuoteToInvoice', 'recordDelivery', 'recordGoodsReceived', 'recordStocktake', 'recordStockUsage', 'cancelPurchaseOrder', 'reopenPurchaseOrder', 'linkPurchaseOrderAndMoveCosts', 'setUnitConversion', 'forgetUnitConversions', 'addDeliveredItemsToStock', 'resolveCrossCaptureAttachment', 'recordVarianceDisposition'], 'identity.ts': ['reconcileCustomer', 'reconcileCharacter'], 'permissions.ts': ['setPermission', 'resetRole'], 'scheduler.ts': ['recordWorkObservation', 'attachToSiblingJobScope'] };
  const missing = [];
  for (const [file, names] of Object.entries(wrapped)) { const src = fs.readFileSync(path.join(srcDir, file), 'utf8'); for (const n of names) { const i = src.indexOf(`function ${n}(`); const head = i < 0 ? '' : src.slice(i, i + 2200); if (!/if \(!env\.__atomic\)/.test(head) || !/atomically\(env/.test(head)) missing.push(`${file}:${n}`); } }
  check(missing.length === 0, `all ${Object.values(wrapped).flat().length} multi-write operations are wrapped in a transaction${missing.length ? ' (MISSING: ' + missing.join(', ') + ')' : ''}`);
  const mem = fs.readFileSync(path.join(srcDir, 'memory.ts'), 'utf8');
  check(!/atomically\(/.test(mem) && !/__atomic/.test(mem), 'the memory functions are NOT wrapped: runConsolidation calls the model and the memory index, and the others write their own failure log (memory_errors), which a rollback would erase along with the failure');
  const finSrc = fs.readFileSync(path.join(srcDir, 'finance.ts'), 'utf8');
  const rsi = finSrc.slice(finSrc.indexOf('export async function recordSupplierInvoice'));
  check(rsi.indexOf('classifyExpenseCategory(env') > 0 && rsi.indexOf('classifyExpenseCategory(env') < rsi.indexOf('return atomically(env') && /return atomically\(env, \(tx\) => recordSupplierInvoice\(tx,[^)]*lineItems, category\)\)/.test(rsi) && /costFor,\s*\n\s*knownCategory\s*\n\s*\);/.test(rsi), 'a supplier invoice asks the model what kind of cost it is BEFORE the transaction opens, and hands the answer in (the guard found this one: the model call was hidden two functions down)');
  const exp = finSrc.slice(finSrc.indexOf('export async function recordExpense'), finSrc.indexOf('export async function recordInvoice'));
  check(/knownCategory\?: Awaited<ReturnType<typeof classifyExpenseCategory>>/.test(exp) && /const category = knownCategory \?\? \(await classifyExpenseCategory\(env, description\)\);/.test(exp), 'and recordExpense does not ask the model again when it is given the category');
  const vd = finSrc.slice(finSrc.indexOf('export async function recordVarianceDisposition'), finSrc.indexOf('export interface InvoiceMatchLine'));
  check(vd.indexOf('classifyExpenseCategory(env') > 0 && vd.indexOf('classifyExpenseCategory(env') < vd.indexOf('return atomically(env') && /return atomically\(env, \(tx\) => recordVarianceDisposition\(tx, grnLineItemId, reason, resolution, creditAmount, recordedByEmail, category\)\)/.test(vd) && /getCustomerForPurchaseOrders\(env, \[chain\.purchase_order_id\]\),\s*\n\s*knownCategory\s*\n\s*\);/.test(vd), 'a variance disposition asks the model about its credit BEFORE the transaction opens (it used to ask between the two writes) and hands the answer in');
  const dbg = fs.readFileSync(path.join(srcDir, 'debug.ts'), 'utf8');
  const routeBlock = (name) => { const i = dbg.indexOf(`if (url.pathname === "${name}"`); let depth = 0, k = dbg.indexOf('{', i); const start = k; for (; k < dbg.length; k++) { if (dbg[k] === '{') depth++; else if (dbg[k] === '}' && --depth === 0) break; } return dbg.slice(i, k + 1); };
  const merges = ['/debug/merge-customers', '/debug/merge-characters', '/debug/merge-stock-items'].map(routeBlock);
  check(merges.every((b) => /return atomically\(env, async \(env\) => \{/.test(b)) && /atomically\(env, async \(env\) => \{\s*\n\s*const tablesToRepoint/.test(merges[0]) && /atomically\(env, async \(env\) => \{\s*\n\s*const tablesToRepoint/.test(merges[1]) && /atomically\(env, async \(env\) => \{\s*\n\s*if \(groups\.length > 0\)/.test(merges[2]), 'the customer merge, the character merge and the stock-item merge each run their writes as ONE transaction (after their validation and dry-run, so a refused request writes nothing)');
  const del = routeBlock('/debug/delete-customer');
  check(/await atomically\(env, async \(env\) => \{\s*\n\s*await env\.OFFICE_DB\.prepare\("DELETE FROM customers WHERE id = \?"\)[\s\S]*DELETE FROM pending_memory_flush[\s\S]*\}\);/.test(del) && del.indexOf('env.CUSTOMER_NOTES.delete') > del.indexOf('});'), 'deleting a customer removes the row and its pending memory TOGETHER, and the note in the notes store (a different store, which no transaction can cover) is deleted only AFTER that commits');
  const guard = fs.readFileSync(path.join(srcDir, 'atomic.ts'), 'utf8');
  check(/const OUTSIDE = \["AI", "MEMORY", "CUSTOMER_NOTES", "OFFICE_VAULT", "BACKUPS", "SHARED_DB"\] as const;/.test(guard), 'every binding other than the database is guarded inside a transaction (the model, the memory index, the notes store, the files, the backups, the shared database)');
  const adapter = fs.readFileSync(path.join(srcDir, 'storage', 'do-d1.ts'), 'utf8');
  check(/if \(this\.txDepth > 0 \|\| typeof this\.storage\.transaction !== "function"\) return body\(\);/.test(adapter) && /this\.storage\.transaction\(async \(\) => body\(\)\)/.test(adapter), 'the adapter joins an open transaction, runs inline where the storage cannot do one, and otherwise uses the storage\'s async transaction (measured on a real Durable Object)');
}
