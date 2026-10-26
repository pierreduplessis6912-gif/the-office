// The owner's list and undo of what connected assistants created (GET /mcp-created, POST /mcp-created/undo in worker/src/index.ts; rules in mcp-undo.ts and mcp-undo.test.js). SECURITY-SENSITIVE: it changes money records, so (1) only the OWNER may call it (every other role 403, nobody signed in 401); (2) it acts only on a record that was tagged, by its tag; (3) it answers with the reason when it refuses; (4) it works when MCP is switched off, so the owner can always clean up.
const path = require('path');

module.exports = async function runCreatedRouteTests({ check, srcDir }) {
  const harness = require('./harness.js'), workerDir = path.join(srcDir, '..'), fns = await harness.loadFunctions(workerDir);
  const ENV = { BUSINESS_ID: 'acme-co' };
  const route = (spec) => harness.runRouteCase(fns, workerDir, { env: ENV, ...spec });
  const DDL = [
    "CREATE TABLE IF NOT EXISTS mcp_created_records (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL DEFAULT (datetime('now')), create_id INTEGER NOT NULL, key_id TEXT NOT NULL, tbl TEXT NOT NULL, rec_id INTEGER NOT NULL, undone_at TEXT, undone_by TEXT, snapshot TEXT, UNIQUE (tbl, rec_id))",
    "CREATE TABLE IF NOT EXISTS mcp_keys (id TEXT PRIMARY KEY, label TEXT NOT NULL, email TEXT NOT NULL, hash TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), created_by TEXT NOT NULL, last_used_at TEXT, revoked_at TEXT, uses INTEGER NOT NULL DEFAULT 0, scope TEXT NOT NULL DEFAULT 'mcp:read')",
  ];
  const seed = (db) => { db.exec('PRAGMA foreign_keys = OFF'); for (const d of DDL) db.exec(d);
    db.prepare("INSERT INTO mcp_keys (id, label, email, hash, created_by, scope) VALUES ('k1', 'Claude on my phone', 'owner@example.com', 'h', 'owner@example.com', 'mcp:write')").run();
    db.prepare("INSERT INTO customers (name) VALUES ('Jenny')").run();
    db.prepare("INSERT INTO invoices (customer_id, description, amount, source_transcript) VALUES (1, 'Carpet repair', 3000, 't')").run();   // tagged: the connector made it
    db.prepare("INSERT INTO invoices (customer_id, description, amount, source_transcript) VALUES (1, 'Mine, typed in the app', 900, 't')").run();   // NOT tagged
    db.prepare("INSERT INTO expenses (amount, description, source_transcript, category) VALUES (50, 'fuel', 't', 'fuel')").run();
    db.prepare("INSERT INTO mcp_created_records (create_id, key_id, tbl, rec_id) VALUES (1, 'k1', 'invoices', 1)").run();
    db.prepare("INSERT INTO mcp_created_records (create_id, key_id, tbl, rec_id) VALUES (2, 'k1', 'expenses', 1)").run(); };
  const unchanged = (r) => Object.keys(r.writes || {}).length === 0;
  const calls = [['GET', '/mcp-created', undefined], ['POST', '/mcp-created/undo', { id: 1 }]];

  let refused = 0, total = 0;
  for (const [method, p, body] of calls) for (const role of ['accountant', 'installer', 'sales', 'admin']) { const r = await route({ name: `${method} ${p} as ${role}`, method, path: p, body, role, seed }); total++; if (r.result.status === 403 && unchanged(r)) refused++; }
  check(refused === total, `all ${total} (2 routes x 4 other roles) are refused with 403 and change nothing: only the owner may list or undo`);
  const noSession = []; for (const [method, p, body] of calls) noSession.push((await route({ name: `no session ${method} ${p}`, method, path: p, body, noSession: true, seed })).result.status);
  check(noSession.every((s) => s === 401), 'and to someone not signed in (401)');

  { const r = await route({ name: 'owner lists', method: 'GET', path: '/mcp-created', role: 'owner', seed }), b = r.result.body;
    check(r.result.status === 200 && b.items.length === 2 && b.items[0].kind === 'expense' && b.items[1].kind === 'invoice' && b.items[1].state === 'active' && b.items[1].connection === 'Claude on my phone' && !JSON.stringify(b).includes('"hash"'), 'the owner sees what the connection created, newest first, by the connection\'s name, never a key hash'); }
  { const r = await route({ name: 'owner undoes an invoice', method: 'POST', path: '/mcp-created/undo', body: { id: 1 }, role: 'owner', seed }), b = r.result.body;
    check(r.result.status === 200 && b.ok === true && b.action === 'voided' && b.kind === 'invoice' && b.recordId === 1 && r.writes.invoices.changed.length === 1 && r.writes.invoices.changed[0].after.status === 'void' && r.writes.invoices.changed[0].after.amount === 0 && !r.writes.invoices.removed && Object.keys(r.writes).sort().join() === 'invoices,mcp_created_records', 'the owner undoes a tagged invoice through the route: it is voided, never deleted'); }
  { const r = await route({ name: 'owner undoes by a record id that is not tagged', method: 'POST', path: '/mcp-created/undo', body: { id: 2 }, role: 'owner', seed: (db) => { seed(db); db.prepare("DELETE FROM mcp_created_records WHERE id = 2").run(); } }), b = r.result.body;
    check(r.result.status === 404 && b.ok === false && b.reason === 'not_found' && unchanged(r), 'a number that is not a tag is a 404 and changes nothing (the app\'s own, typed-in invoice can never be reached through this route)'); }
  { const bad = []; for (const body of [{}, { id: 'x' }, { id: null }, { id: 1.5 }, { id: -3 }, { id: [1] }, null, { call_id: 'x' }, { call_id: 0 }, { id: 1, call_id: 1 }]) { const r = await route({ name: 'junk ' + JSON.stringify(body), method: 'POST', path: '/mcp-created/undo', body, role: 'owner', seed }); bad.push(r.result.status >= 400 && r.result.status < 500 && unchanged(r) || (JSON.stringify(body) === JSON.stringify({ id: 1, call_id: 1 }) && r.result.status === 200)); }
    check(bad.every(Boolean), 'a missing, non-numeric, fractional, negative or list id, or an empty body, is refused with a 4xx and changes nothing'); }
  { const r = await route({ name: 'owner undoes a whole call', method: 'POST', path: '/mcp-created/undo', body: { call_id: 2 }, role: 'owner', seed }), b = r.result.body;
    check(r.result.status === 200 && b.results.length === 1 && b.results[0].kind === 'expense' && b.results[0].result.ok === true && r.writes.expenses.removed.length === 1 && !r.writes.invoices, 'a whole call can be undone by its call id'); }
  { const r = await route({ name: 'unknown call', method: 'POST', path: '/mcp-created/undo', body: { call_id: 999 }, role: 'owner', seed }); check(r.result.status === 404, 'an unknown call is a 404'); }
  { const r = await route({ name: 'works with MCP off', method: 'POST', path: '/mcp-created/undo', body: { id: 1 }, role: 'owner', seed, env: { ...ENV, MCP: 'off' } }); check(r.result.status === 200 && r.result.body.ok === true, 'the undo works when MCP is switched off, so the owner can always clean up'); }
};
