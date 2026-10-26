// A held action a CONNECTION proposed, decided through the app's own confirm and reject routes (worker/src/index.ts, worker/src/mcp-pending.ts). This is the gap Pierre found: the expense was held, he confirmed it in the app, and nothing appeared in the list of what assistants created, because the record was made later by a request the tagging never saw. Now (1) a held action linked to a key is tagged EXACTLY when it is confirmed, whoever confirms it; (2) an action no connection proposed is not touched; (3) a rejection tags nothing; (4) a decision made twice is tagged once; (5) a confirmation that FAILS tags nothing and leaves the link waiting.
const path = require('path');

module.exports = async function runPendingRouteTests({ check, srcDir }) {
  const harness = require('./harness.js'), workerDir = path.join(srcDir, '..'), fns = await harness.loadFunctions(workerDir);
  const ENV = { BUSINESS_ID: 'acme-co' };
  const route = (spec) => harness.runRouteCase(fns, workerDir, { env: ENV, ...spec });
  const DDL = [
    "CREATE TABLE IF NOT EXISTS mcp_created_records (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL DEFAULT (datetime('now')), create_id INTEGER NOT NULL, key_id TEXT NOT NULL, tbl TEXT NOT NULL, rec_id INTEGER NOT NULL, undone_at TEXT, undone_by TEXT, snapshot TEXT, UNIQUE (tbl, rec_id))",
    "CREATE TABLE IF NOT EXISTS mcp_pending_links (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL DEFAULT (datetime('now')), pending_id INTEGER NOT NULL UNIQUE, key_id TEXT NOT NULL, create_id INTEGER NOT NULL, type TEXT NOT NULL, summary TEXT, status TEXT NOT NULL DEFAULT 'waiting', resolved_at TEXT, resolved_by TEXT)",
  ];
  const expensePayload = JSON.stringify({ characterId: null, customerId: 1, customerName: 'Jenny', amount: 1, description: 'connector test' });
  const seed = (extra) => (db) => { db.exec('PRAGMA foreign_keys = OFF'); for (const d of DDL) db.exec(d);
    db.prepare("INSERT INTO customers (name) VALUES ('Jenny')").run();
    db.prepare("INSERT INTO pending_actions (type, payload, source_transcript, status) VALUES ('expense', ?, 'expense of R1 for Jenny', 'pending')").run(expensePayload);   // id 1: proposed by a connection
    db.prepare("INSERT INTO pending_actions (type, payload, source_transcript, status) VALUES ('expense', ?, 'typed in the app', 'pending')").run(expensePayload);   // id 2: the owner's own
    db.prepare("INSERT INTO mcp_pending_links (pending_id, key_id, create_id, type, summary) VALUES (1, 'k1', 7, 'expense', 'R1, connector test, for Jenny')").run();
    if (extra) extra(db); };
  const link = (r) => r.after && r.after.mcp_pending_links;
  const decide = (id, what, spec = {}) => route({ name: `${what} ${id}`, method: 'POST', path: `/actions/${id}/${what}`, role: 'owner', seed: seed(), ...spec });

  { const r = await decide(1, 'confirm'); const w = r.writes;
    check(r.result.status === 200 && r.result.body.status === 'confirmed' && w.expenses && w.expenses.added.length === 1 && w.mcp_created_records && w.mcp_created_records.added.length === 1 && w.mcp_created_records.added[0].tbl === 'expenses' && w.mcp_created_records.added[0].rec_id === w.expenses.added[0].id && w.mcp_created_records.added[0].key_id === 'k1' && w.mcp_created_records.added[0].create_id === 7, 'the owner confirms a held action a connection proposed, in the app: the expense it creates is TAGGED to that connection and to the call that proposed it (the gap Pierre found)');
    check(w.mcp_pending_links.changed.length === 1 && w.mcp_pending_links.changed[0].after.status === 'confirmed' && w.mcp_pending_links.changed[0].after.resolved_by === 'app' && w.mcp_pending_links.changed[0].after.resolved_at !== null, 'and the link records that it was confirmed, by the app, and when'); }
  { const r = await decide(2, 'confirm'); const w = r.writes;
    check(r.result.status === 200 && w.expenses.added.length === 1 && !w.mcp_created_records && !w.mcp_pending_links, 'a held action NO connection proposed (the owner\'s own) is confirmed exactly as before and nothing is tagged'); }
  { const r = await decide(1, 'reject'); const w = r.writes;
    check(r.result.status === 200 && !w.expenses && !w.mcp_created_records && w.mcp_pending_links.changed[0].after.status === 'rejected', 'rejecting a held action a connection proposed tags nothing, creates nothing and records that it was rejected'); }
  { const r = await decide(1, 'confirm', { seed: seed((db) => db.prepare("UPDATE pending_actions SET status = 'confirmed' WHERE id = 1").run()) }); const w = r.writes;
    check(r.result.status === 409 && !w.expenses && !w.mcp_created_records && !w.mcp_pending_links, 'a decision made twice (the action is no longer pending) is a 409 and tags nothing, and the link is left as it was'); }
  { const r = await decide(1, 'confirm', { seed: seed((db) => db.prepare("UPDATE pending_actions SET payload = 'not json' WHERE id = 1").run()) }); const w = r.writes;
    check(r.result.status >= 400 && !(w.mcp_created_records) && !(w.mcp_pending_links && w.mcp_pending_links.changed && w.mcp_pending_links.changed.some((c) => c.after.status !== 'waiting')), 'a confirmation that FAILS tags nothing and leaves the link waiting'); }
  { const refused = []; for (const role of ['installer', 'sales']) { const r = await decide(1, 'confirm', { role }); refused.push(r.result.status === 403 && !r.writes.mcp_created_records && !r.writes.expenses && !r.writes.mcp_pending_links); }
    const allowed = []; for (const role of ['accountant', 'admin']) { const r = await decide(1, 'confirm', { role }); allowed.push(r.result.status === 200 && r.writes.mcp_created_records.added.length === 1 && r.writes.mcp_created_records.added[0].key_id === 'k1'); }
    check(refused.every(Boolean) && allowed.every(Boolean), 'roles that may not confirm a money action (installer, sales) still cannot, and a refused confirm tags nothing; roles that may (accountant, admin) confirm as the app always allowed, and what they confirm is tagged the same'); }
  { const r = await route({ name: 'confirm by a stranger', method: 'POST', path: '/actions/1/confirm', noSession: true, seed: seed() }); check(r.result.status === 401 && Object.keys(r.writes).length === 0, 'and without signing in it is refused (401) before anything is looked up'); }
};
