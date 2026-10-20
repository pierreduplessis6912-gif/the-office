// The read-only MCP endpoint (worker/src/mcp.ts, POST /mcp; gate and routing in auth.ts and routing.ts; design in MCP_ARCHITECTURE.md). SECURITY-SENSITIVE: it is the first place a key READS data, so every guard here is also proven by a deliberate breakage (tools/mcp-endpoint-breakage.js). THE RULES this pins: (1) a key is the only way in, and every way of being refused is the SAME 401 (no key, a malformed, wrong, unknown, revoked or another business's key, an inactive member, a session
// alone); (2) NOTHING is written but the audit and the key's use; (3) every tool is authorised as the gate authorises the route it mirrors (the owner always, any other role only through a rule: the report routes are owner only), against the member's role; a refused tool returns no data; (4) a rate limit per key; (5) every tool call is audited without its arguments or result; (6) the kill switch answers 503; (7) bounded: body size, batches, malformed JSON, arguments.
const path = require('path'), fs = require('fs'), os = require('os'), crypto = require('crypto'), esbuild = require('esbuild');

module.exports = async function runMcpEndpointTests(context) {
  const standIn = global.Response;
  if (global.__RealResponse) global.Response = global.__RealResponse;
  try { await endpointTests(context); } finally { global.Response = standIn; }
};

async function endpointTests({ check, srcDir }) {
  const bundle = (entry) => { const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'me-')), 'm.js'); esbuild.buildSync({ entryPoints: [path.join(srcDir, entry)], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent' }); return require(out); };
  let mcp, auth, D1;
  try { mcp = bundle('mcp.ts'); auth = bundle('auth.ts'); D1 = bundle('storage/do-d1.ts').DoD1Database; } catch (e) { check(false, 'mcp.ts builds: ' + String(e.message).split('\n')[0].slice(0, 160)); return; }
  const harness = require('./harness.js'), workerDir = path.join(srcDir, '..'), fns = await harness.loadFunctions(workerDir), { newDatabase } = harness;
  const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
  const secretOf = (n) => crypto.createHash('sha256').update('secret:' + n).digest('base64url'), idOf = (n) => sha('id:' + n).slice(0, 16);
  const keyOf = (n, biz = 'acme-co') => `omk.${biz}.${idOf(n)}.${secretOf(n)}`;
  const ENV = { BUSINESS_ID: 'acme-co', BUSINESS_MODE: 'object' };
  const DDL = "CREATE TABLE IF NOT EXISTS mcp_keys (id TEXT PRIMARY KEY, label TEXT NOT NULL, email TEXT NOT NULL, hash TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), created_by TEXT NOT NULL, last_used_at TEXT, revoked_at TEXT, uses INTEGER NOT NULL DEFAULT 0)";
  const HOLDERS = { owner: 'owner@example.com', accountant: 'accountant@example.com', installer: 'installer@example.com', sales: 'sales@example.com', admin: 'admin@example.com', ghost: 'ghost@example.com', revoked: 'owner@example.com', other: 'owner@example.com', twin: 'owner@example.com' };

  // a business with money in it, and one key per kind of holder
  const seed = (db) => {
    db.exec('PRAGMA foreign_keys = OFF'); db.exec(DDL);
    db.prepare("INSERT INTO memberships (google_email, role, status) VALUES ('ghost@example.com', 'installer', 'inactive')").run();
    for (const [name, email] of Object.entries(HOLDERS)) db.prepare('INSERT INTO mcp_keys (id, label, email, hash, created_by, revoked_at) VALUES (?, ?, ?, ?, ?, ?)').run(idOf(name), name, email, sha(secretOf(name)), 'owner@example.com', name === 'revoked' ? '2026-10-01 08:00:00' : null);
    const c = (n) => Number(db.prepare('INSERT INTO customers (name) VALUES (?)').run(n).lastInsertRowid), jenny = c('Jenny'), ballz = c('Ballz');
    const inv = db.prepare('INSERT INTO invoices (customer_id, description, amount, created_at) VALUES (?, ?, ?, ?)');
    inv.run(jenny, 'Sept floor', 5000, '2026-09-10 08:00:00'); inv.run(ballz, 'Sept blinds', 4000, '2026-09-12 08:00:00'); inv.run(jenny, 'Oct floor', 8000, '2026-10-14 10:00:00'); inv.run(ballz, 'Oct blinds', 3000, '2026-10-05 10:00:00');
    db.prepare("INSERT INTO payments (customer_id, amount, source_transcript, created_at) VALUES (?, 1500, 't', '2026-10-01 08:00:00')").run(jenny);
    const exp = db.prepare('INSERT INTO expenses (amount, description, source_transcript, created_at, category, customer_id) VALUES (?, ?, ?, ?, ?, ?)'); exp.run(800, 'Fuel Sept', 't', '2026-09-10 08:00:00', 'fuel', null); exp.run(1000, 'Fuel Oct', 't', '2026-10-04 08:00:00', 'fuel', null);
  };
  const rpc = (method, params, id = 1) => ({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
  const call = (name, tool, args = {}, id = 2) => rpc('tools/call', { name: tool, arguments: args }, id);
  const via = (spec) => harness.runRouteCase(fns, workerDir, { env: ENV, noSession: true, seed, method: 'POST', path: '/mcp', ...spec });
  const as = (name, body, over = {}) => via({ name: `${name} ${JSON.stringify(body).slice(0, 40)}`, headers: { Authorization: 'Bearer ' + keyOf(name) }, body, ...over });
  const data = (r) => JSON.parse(r.result.body.result.content[0].text);

  // ---- 1. every way of being refused is the SAME 401 ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  { const flip = (k) => k.slice(0, -1) + (k.slice(-1) === 'A' ? 'B' : 'A');
    const cases = [
      ['no key', { headers: {} }], ['a malformed key', { headers: { Authorization: 'Bearer junk' } }], ['a wrong secret', { headers: { Authorization: 'Bearer ' + flip(keyOf('owner')) } }],
      ['an unknown key id', { headers: { Authorization: `Bearer omk.acme-co.${'f'.repeat(16)}.${secretOf('owner')}` } }], ['a revoked key', { headers: { Authorization: 'Bearer ' + keyOf('revoked') } }], ['an inactive member', { headers: { Authorization: 'Bearer ' + keyOf('ghost') } }],
      ['another business\'s key', { headers: { Authorization: 'Bearer ' + keyOf('owner', 'other-co') } }], ['a signed-in session and no key', { noSession: false, headers: {} }], ['the wrong scheme', { headers: { Authorization: 'Basic ' + keyOf('owner') } }],
    ];
    const out = []; for (const [label, over] of cases) { const r = await via({ name: 'refuse ' + label, body: rpc('tools/list'), ...over }); out.push([label, r.result.status, JSON.stringify(r.result.body)]); }
    check(out.every(([, s, b]) => s === 401 && b === '{"error":"unauthorized"}'), `${cases.length} ways of being refused (${cases.map((c) => c[0]).join(', ')}) are ALL the same 401 with the same body: the caller learns nothing about why`);
    const off = await as('owner', rpc('tools/list'), { env: { ...ENV, MCP: 'off' } }), get = await via({ name: 'get', method: 'GET', headers: { Authorization: 'Bearer ' + keyOf('owner') } }), getNo = await via({ name: 'get no key', method: 'GET', headers: {} });
    check(off.result.status === 503 && /switched off/.test(off.result.body.error), 'with MCP switched off a valid key gets 503 before anything is read');
    check(get.result.status === 405 && getNo.result.status === 401, 'GET is 405 for a valid key (no stream is offered) and 401 without one'); }

  // ---- 2. the protocol ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  { const a = await as('owner', rpc('initialize', { protocolVersion: '2025-06-18' })), b = await as('owner', rpc('initialize', { protocolVersion: '2025-03-26' })), c = await as('owner', rpc('initialize', { protocolVersion: '1999-01-01' })), d = await as('owner', rpc('initialize', {}));
    check(a.result.body.result.protocolVersion === '2025-06-18' && b.result.body.result.protocolVersion === '2025-03-26' && c.result.body.result.protocolVersion === '2025-06-18' && d.result.body.result.protocolVersion === '2025-06-18' && a.result.body.id === 1 && a.result.body.jsonrpc === '2.0' && a.result.body.result.serverInfo.name === 'The Office' && JSON.stringify(a.result.body.result.capabilities) === '{"tools":{"listChanged":false}}', 'initialize negotiates a supported protocol version (an unknown one gets the newest), declares ONLY tools, and echoes the id');
    const note = await as('owner', { jsonrpc: '2.0', method: 'notifications/initialized' }), ping = await as('owner', rpc('ping')), none = await as('owner', rpc('resources/list')), unk = await as('owner', call('owner', 'delete_everything')), arr = await as('owner', call('owner', 'get_aged_debtors', [1]).constructor === Object ? { ...call('owner', 'x'), params: { name: 'get_aged_debtors', arguments: [1] } } : {});
    check(note.result.status === 202 && note.result.body === '' && JSON.stringify(ping.result.body.result) === '{}' && none.result.body.error.code === -32601 && unk.result.body.error.code === -32602 && arr.result.body.error.code === -32602, 'a notification is 202 with no body, ping answers, a method the server does not declare is -32601, an unknown tool and non-object arguments are -32602'); }
  { const l = await as('owner', rpc('tools/list')), tools = l.result.body.result.tools, names = tools.map((t) => t.name);
    check(names.join() === 'get_profit_and_loss,get_aged_debtors,get_customer_receivables,analyse,get_recent_history' && tools.every((t) => t.inputSchema.type === 'object' && t.inputSchema.additionalProperties === false && t.annotations.readOnlyHint === true && t.annotations.destructiveHint === false) && !names.some((n) => /create|update|delete|confirm|reject|write|send|issue|revoke|set_/.test(n)), 'the owner sees exactly the five read-only tools, each with a closed input schema and read-only annotations, and none is named like a write');
    const rules = auth.ROUTE_RULES, routes = bundle('mcp.ts').TOOL_ROUTES;
    check(routes.length === 5 && routes.filter((t) => t.route !== null).every((t) => t.route.method === 'GET' && !rules.some((r) => r.method === 'POST' && r.path.test(t.route.path)) && !/(pending|confirm|reject|team|mcp-keys|settings)/.test(t.route.path)), 'every tool mirrors a GET route (or none): nothing that writes, confirms, manages the team or the keys'); }

  // ---- 3. the tools return the report data, and refuse what they are not given ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  { const pl = await as('owner', call('owner', 'get_profit_and_loss', { from: '2026-10-01', to: '2026-10-31', compare_from: '2026-09-01', compare_to: '2026-09-30' })), d = data(pl);
    check(pl.result.body.result.isError === false && d.report === 'profit_and_loss' && d.figures.revenue === 11000 && d.compare.figures.revenue === 9000 && d.currency === 'ZAR', 'get_profit_and_loss returns the report as data for the period and its comparison (R11,000 against R9,000)'); }
  { const ad = data(await as('owner', call('owner', 'get_aged_debtors'))), jenny = ad.rows.find((r) => r.customerName === 'Jenny'), ballz = ad.rows.find((r) => r.customerName === 'Ballz');
    check(ad.report === 'aged_debtors' && jenny.total === 11500 && ballz.total === 7000, 'get_aged_debtors returns who owes what (Jenny R11,500 after her R1,500 payment, Ballz R7,000)');
    const rc = data(await as('owner', call('owner', 'get_customer_receivables', { customer_id: jenny.customerId })));
    check(rc.report === 'customer_receivables' && rc.certainty === 'calculated' && rc.customer.name === 'Jenny' && rc.outstandingCount === 2 && rc.reconciles === true && rc.notEstablished.includes('payment_to_invoice_match'), 'get_customer_receivables returns that customer\'s outstanding invoices, labelled calculated');
    const an = data(await as('owner', call('owner', 'analyse', { topic: 'revenue', from: '2026-10-01', to: '2026-10-31' })));
    check(an.analysis === 'revenue' && an.summary.current === 11000 && an.summary.previous === 9000 && an.summary.reconciles === true && an.contributors.length === 2, 'analyse (revenue) returns why revenue changed by customer, reconciled to the report');
    const h = data(await as('owner', call('owner', 'get_recent_history', { limit: 5 })));
    check(h.version === 1 && h.scope === 'own' && Array.isArray(h.items), 'get_recent_history returns the member\'s OWN turns'); }
  { const bads = [['get_profit_and_loss', { from: 'yesterday' }], ['get_profit_and_loss', { from: 5 }], ['get_profit_and_loss', { bogus: 1 }], ['get_aged_debtors', { x: 1 }], ['get_customer_receivables', {}], ['get_customer_receivables', { customer_id: 0 }], ['get_customer_receivables', { customer_id: '1' }], ['get_customer_receivables', { customer_id: 1.5 }], ['get_customer_receivables', { customer_id: 1, extra: 1 }], ['analyse', { topic: 'weather', from: '2026-10-01', to: '2026-10-31' }], ['analyse', { topic: 'revenue' }], ['analyse', { topic: 'revenue', from: '2026-10-01', to: '2026-10-31', bogus: 1 }], ['get_recent_history', { limit: 0 }], ['get_recent_history', { limit: 51 }], ['get_recent_history', { limit: '5' }], ['get_recent_history', { who: 'all' }]];
    const out = []; for (const [tool, args] of bads) { const r = await as('owner', call('owner', tool, args)); out.push(r.result.status === 200 && r.result.body.result.isError === true && typeof r.result.body.result.content[0].text === 'string'); }
    check(out.every(Boolean), `${bads.length} bad calls (a bad date, a number for text, an unknown argument, a missing or malformed customer, an unknown topic, a missing period, an out-of-range limit, asking for everyone's history) are each a tool error with a reason and no data`);
    const nf = await as('owner', call('owner', 'get_customer_receivables', { customer_id: 99999 }));
    check(nf.result.body.result.isError === true && /not found/.test(nf.result.body.result.content[0].text), 'an unknown customer is a tool error, not a failure'); }

  // ---- 4. authorization: as the gate authorises the route each tool mirrors -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  { const out = [];
    for (const role of ['accountant', 'installer', 'sales', 'admin']) {
      const l = await as(role, rpc('tools/list')), names = l.result.body.result.tools.map((t) => t.name);
      const p = await as(role, call(role, 'get_profit_and_loss', { from: '2026-10-01', to: '2026-10-31' })), a = await as(role, call(role, 'get_aged_debtors')), r = await as(role, call(role, 'get_customer_receivables', { customer_id: 1 })), s = await as(role, call(role, 'analyse', { topic: 'revenue', from: '2026-10-01', to: '2026-10-31' }));
      const text = [p, a, r, s].map((x) => x.result.body.result.content[0].text).join('|');
      out.push([role, names.join(), [p, a, r, s].every((x) => x.result.body.result.isError === true && /restricted/.test(x.result.body.result.content[0].text)), /R\d|revenue|Jenny|Ballz|11000|figures/.test(text)]);
    }
    check(out.every(([, names, refused, leaked]) => names === 'get_recent_history' && refused === true && leaked === false), 'a key held by any role other than the owner lists only the history tool, is refused every report tool with "restricted", and gets NO figures (the report routes are owner only)'); }
  // (the demotion check is below, with the direct tests, where the membership can be changed after the key exists)

  // ---- 5. direct: bounds, the limit, the audit, and that nothing is written ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const plain = (r) => (r ? { ...r } : r);
  const shim = (db) => { const sql = { exec(query, ...binds) { const s = db.prepare(query); if (/^\s*(select|with|pragma|values)\b/i.test(query) || /\breturning\b/i.test(query)) { const rows = s.all(...binds).map(plain); return { toArray: () => rows, rowsRead: rows.length, rowsWritten: 0 }; } const r = s.run(...binds); return { toArray: () => [], rowsRead: 0, rowsWritten: Number(r.changes) }; } }; const storage = { transactionSync(fn) { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } } }; return new D1(sql, storage); };
  const fresh = () => { const db = newDatabase(workerDir); db.prepare("INSERT INTO memberships (google_email, role, status) VALUES ('owner@example.com', 'owner', 'active')").run(); db.prepare("INSERT INTO memberships (google_email, role, status) VALUES ('sales@example.com', 'sales', 'active')").run(); seed(db); return { db, env: { OFFICE_DB: shim(db), ...ENV } }; };
  const send = (w, name, body, raw) => mcp.handleMcp(new Request('https://x.test/mcp', { method: 'POST', headers: { Authorization: 'Bearer ' + keyOf(name), 'Content-Type': 'application/json' }, body: raw !== undefined ? raw : JSON.stringify(body) }), w.env);
  { const w = fresh(); const r = [await send(w, 'owner', null, '{not json'), await send(w, 'owner', [rpc('ping'), rpc('ping')]), await send(w, 'owner', { jsonrpc: '1.0', id: 1, method: 'ping' }), await send(w, 'owner', { id: 1, method: 'ping' }), await send(w, 'owner', { jsonrpc: '2.0', id: 1 }), await send(w, 'owner', null, '"a string"'), await send(w, 'owner', null, 'null'), await send(w, 'owner', rpc('ping', { padding: 'x'.repeat(70000) }))];
    const j = await Promise.all(r.map(async (x) => ({ status: x.status, code: (await x.json().catch(() => ({}))).error?.code })));
    check(j[0].status === 400 && j[0].code === -32700 && j[1].status === 400 && j[1].code === -32600 && j.slice(2, 7).every((x) => x.status === 400 && x.code === -32600) && j[7].status === 413, 'malformed JSON is -32700 (400); a batch, a wrong jsonrpc version, a missing method, a bare string and null are -32600 (400); a body over 64 KB is 413'); }
  { const w = fresh(); const codes = []; for (let i = 0; i < 31; i++) codes.push((await send(w, 'owner', call('owner', 'get_aged_debtors', {}, i + 1))).status);
    const other = await send(w, 'sales', call('sales', 'get_recent_history', {}, 99)), lim = await send(w, 'owner', call('owner', 'get_aged_debtors', {}, 100)), n = w.db.prepare("SELECT COUNT(*) n FROM mcp_calls WHERE key_id = ?").get(idOf('owner')).n;
    check(codes.slice(0, 30).every((s) => s === 200) && codes[30] === 429 && lim.headers.get('Retry-After') === '60' && other.status === 200 && n === 30, 'a key may make 30 calls a minute: the 31st is 429 with Retry-After, another key is unaffected, and a refused call is not counted'); }
  { const w = fresh(); w.db.exec("CREATE TABLE IF NOT EXISTS mcp_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL DEFAULT (datetime('now')), key_id TEXT NOT NULL, email TEXT NOT NULL, tool TEXT NOT NULL, outcome TEXT NOT NULL, ms INTEGER NOT NULL DEFAULT 0)");
    const ins = w.db.prepare("INSERT INTO mcp_calls (created_at, key_id, email, tool, outcome) VALUES (datetime('now', '-3 hours'), ?, 'owner@example.com', 'get_aged_debtors', 'ok')"); for (let i = 0; i < 500; i++) ins.run(idOf('owner'));
    const day = await send(w, 'owner', call('owner', 'get_aged_debtors')), minuteOnly = await send(w, 'sales', call('sales', 'get_recent_history'));
    check(day.status === 429 && minuteOnly.status === 200, 'a key may also make 500 calls a day: beyond that it is 429, and the count is per key'); }
  { const w = fresh(); await send(w, 'owner', call('owner', 'get_customer_receivables', { customer_id: 1 })); await send(w, 'sales', call('sales', 'get_aged_debtors')); await send(w, 'owner', call('owner', 'get_customer_receivables', { customer_id: 0 })); await send(w, 'owner', rpc('tools/list')); await send(w, 'owner', rpc('initialize', {}));
    const rows = w.db.prepare('SELECT key_id, email, tool, outcome FROM mcp_calls ORDER BY id').all().map(plain), text = JSON.stringify(rows);
    check(rows.length === 3 && rows[0].key_id === idOf('owner') && rows[0].email === 'owner@example.com' && rows[0].tool === 'get_customer_receivables' && rows[0].outcome === 'ok' && rows[1].key_id === idOf('sales') && rows[1].outcome === 'denied' && rows[2].outcome === 'invalid', 'every TOOL call is audited with the key, the member, the tool and the outcome (ok, denied, invalid); listing and initialising are not');
    check(!/"customer_id"|Jenny|11500|Ballz|secret|omk\./.test(text) && !text.includes(secretOf('owner')), 'and the audit holds neither the arguments nor the result nor the key'); }
  { const { DatabaseSync } = require('node:sqlite'); const w = fresh(), lapsed = new DatabaseSync(':memory:'), paying = new DatabaseSync(':memory:');
    for (const [db, status, end] of [[lapsed, 'cancelled', '2020-01-01'], [paying, 'active', '2099-01-01']]) { db.exec('CREATE TABLE businesses (id TEXT PRIMARY KEY, billing_status TEXT, grace_until TEXT, period_end TEXT)'); db.prepare("INSERT INTO businesses (id, billing_status, period_end) VALUES ('acme-co', ?, ?)").run(status, end); }
    const a = await mcp.handleMcp(new Request('https://x.test/mcp', { method: 'POST', headers: { Authorization: 'Bearer ' + keyOf('owner'), 'Content-Type': 'application/json' }, body: JSON.stringify(rpc('ping')) }), { ...w.env, SHARED_DB: shim(lapsed), ACCESS_CACHE_SECONDS: '0' });
    const b = await mcp.handleMcp(new Request('https://x.test/mcp', { method: 'POST', headers: { Authorization: 'Bearer ' + keyOf('owner'), 'Content-Type': 'application/json' }, body: JSON.stringify(rpc('ping')) }), { ...w.env, SHARED_DB: shim(paying), ACCESS_CACHE_SECONDS: '0' });
    check(a.status === 401 && JSON.stringify(await a.json()) === '{"error":"unauthorized"}' && b.status === 200, 'a business whose subscription has ended is refused at /mcp like everywhere else (the same 401), and one that is paying is served'); }
  { const routing = bundle('routing.ts'), req = (headers) => new Request('https://x.test/mcp', { method: 'POST', headers });
    const hit = await routing.routeRequest(req({ Authorization: 'Bearer ' + keyOf('owner') }), {}), other = await routing.routeRequest(req({ Authorization: 'Bearer ' + keyOf('owner', 'other-co') }), {}), junk = await routing.routeRequest(req({ Authorization: 'Bearer junk' }), {}), none = await routing.routeRequest(req({}), {});
    check(hit.kind === 'business' && hit.businessId === 'acme-co' && other.kind === 'business' && other.businessId === 'other-co' && junk.kind === 'worker' && none.kind === 'worker', 'the Worker routes /mcp by the business named in the KEY (and a malformed or missing key wakes no object); the object then verifies it'); }
  { const w = fresh(); const before = await send(w, 'owner', call('owner', 'get_aged_debtors')); w.db.prepare("UPDATE memberships SET role = 'sales' WHERE google_email = 'owner@example.com'").run(); const after = await send(w, 'owner', call('owner', 'get_aged_debtors', {}, 2)), bj = await before.json(), aj = await after.json();
    w.db.prepare("UPDATE memberships SET role = 'owner', status = 'inactive' WHERE google_email = 'owner@example.com'").run(); const gone = await send(w, 'owner', call('owner', 'get_aged_debtors', {}, 3));
    check(bj.result.isError === false && aj.result.isError === true && /restricted/.test(aj.result.content[0].text) && gone.status === 401, 'the capabilities are the member\'s role NOW: an owner demoted after the key was issued is refused at once, and a deactivated member\'s key is a 401');
  }
  { const w = fresh(); const tables = ['customers', 'invoices', 'payments', 'expenses', 'captures', 'pending_actions', 'interaction_log', 'action_events', 'memberships', 'business_profile', 'tasks', 'projects'];
    const count = () => tables.map((t) => { try { return w.db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n; } catch { return -1; } }).join();
    const before = count();
    for (const tool of ['get_profit_and_loss', 'get_aged_debtors', 'get_customer_receivables', 'analyse', 'get_recent_history']) await send(w, 'owner', call('owner', tool, tool === 'analyse' ? { topic: 'profit', from: '2026-10-01', to: '2026-10-31' } : tool === 'get_customer_receivables' ? { customer_id: 1 } : {}));
    check(count() === before, 'calling every tool wrote NO business data (customers, invoices, payments, expenses, captures, held actions, history, team and the rest are all unchanged)');
    const k = w.db.prepare('SELECT uses, last_used_at FROM mcp_keys WHERE id = ?').get(idOf('owner')); check(k.uses === 5 && k.last_used_at !== null, 'only the key\'s own use is recorded'); }
}
