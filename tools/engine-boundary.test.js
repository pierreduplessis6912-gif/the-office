// The engine / legacy boundary (branch engine-phase1). TESTS FIRST. A business is EITHER an engine business or a legacy one, stored once (eng_config 'mode'), and the two must never write the same
// business's records. The protection is NOT one check at /messages/text: every way in is inventoried and each is tested against the real request handler.
//   INVENTORY  every write route in ROUTE_POLICY.md is classified: a legacy business write, the shared held-action lifecycle, or a platform route. An unclassified new write route FAILS here.
//   ENGINE MODE every legacy business-write route is refused 409 `engine_mode` BEFORE it runs: nothing is written. Platform routes still work.
//   LEGACY MODE  the engine's routes are refused 409 `not_engine_mode`; the legacy routes behave exactly as before.
//   HELD ACTIONS a held action of the other kind cannot be confirmed, rejected or edited: it is refused before it is claimed and stays pending.
// Expected state when first committed: RED (worker/src/engine/boundary.ts and the gate in index.ts do not exist).
const fs = require('fs'), path = require('path');
const kit = require('./engine-kit.js');

module.exports = kit.guard('engine boundary', async ({ check }) => {
  const eng = kit.loadEngine();
  check(Boolean(eng && eng.boundary), 'the engine exposes its boundary (worker/src/engine/boundary.ts: classify, the mode gate)');
  if (!eng || !eng.boundary) return;
  const { classify } = eng.boundary;

  // ---- INVENTORY: every write route in the policy has a class -------------------------------------------------------------------------------------------------------------------------------------
  const policy = fs.readFileSync(path.join(kit.workerDir, '..', 'ROUTE_POLICY.md'), 'utf8');
  const writes = [...policy.matchAll(/^\|\s*`?(POST|PUT|PATCH|DELETE)\s+([^`|\[]+?)(?:\s*\[[^\]]*\])?`?\s*\|/gm)].map((m) => [m[1], m[2].trim()]);
  const concrete = ([m, p]) => [m, p.replace(/:[a-z]+/g, '1').replace('*', 'photo')];
  check(writes.length >= 52, `the route policy lists ${writes.length} write routes (52 when this was written)`);
  const classes = writes.map((r) => [r, classify(...concrete(r))]);
  const unclassified = classes.filter(([, c]) => !['business_write', 'shared_lifecycle', 'platform_write', 'mcp', 'public', 'engine'].includes(c)).map(([r]) => r.join(' '));
  check(unclassified.length === 0, 'every write route in ROUTE_POLICY.md has a class (a new write route must be classified before it can be added)' + (unclassified.length ? ': ' + unclassified.join('; ') : ''));
  const count = (c) => classes.filter(([, x]) => x === c).length;
  check(count('business_write') >= 19 && count('shared_lifecycle') >= 3 && count('platform_write') >= 15, `the inventory splits ${count('business_write')} legacy business writes, ${count('shared_lifecycle')} shared lifecycle routes, ${count('platform_write')} platform routes, ${count('mcp')} MCP, ${count('public')} public`);
  check(classify('GET', '/invoices/1/pdf') === 'other' && classify('GET', '/engine/receivables') === 'engine' && classify('POST', '/engine/proposals') === 'engine', 'reads are not business writes, and /engine/* is the engine\'s own');
  check(classify('POST', '/files/team-csv-import') === 'platform_write', 'importing team members writes memberships (the platform), not business records');

  const businessWrites = writes.filter((r) => classify(...concrete(r)) === 'business_write').map(concrete);
  const dedup = [...new Map(businessWrites.map((r) => [r.join(' '), r])).values()];

  // ---- ENGINE MODE: refused before it runs -----------------------------------------------------------------------------------------------------------------------------------------------------------
  let refused = 0; const leaks = [], viaAuth = [];
  for (const [method, p] of dedup) {
    const r = await kit.route({ method, path: p, body: {}, role: 'owner', seed: kit.asEngineBusiness() });
    const wrote = r.writes && Object.keys(r.writes).length > 0;
    const earlier = r.result && r.result.status === 403 && !wrote;   // a signed-link route is refused by the authentication gate first, with nothing written: still refused
    if (r.result && r.result.status === 409 && r.result.body && r.result.body.error === 'engine_mode' && !wrote) refused++; else if (earlier) { refused++; viaAuth.push(method + ' ' + p); } else leaks.push(`${method} ${p} -> ${r.result ? r.result.status : 'none'}${wrote ? ' WROTE ' + Object.keys(r.writes).join(',') : ''}`);
  }
  check(leaks.length === 0 && refused === dedup.length, `in an engine business all ${dedup.length} legacy business-write routes are refused 409 engine_mode, and nothing is written` + (leaks.length ? ' (not refused: ' + leaks.join('; ') + ')' : ''));
  // the routes the auth gate answers first (a signed link without its signature) are checked at the gate itself: the engine gate must still refuse them when a valid link gets past authentication
  const gateOf = (engine) => { const w = kit.makeWorld(); if (engine) w.configure({ mode: 'engine' }); return w.env; };
  for (const p of viaAuth.map((x) => x.split(' ')[1])) {
    const refusedAtGate = await eng.boundary.engineModeGate(new Request('https://office.test' + p, { method: 'POST' }), gateOf(true), new URL('https://office.test' + p));
    const passes = await eng.boundary.engineModeGate(new Request('https://office.test' + p, { method: 'POST' }), gateOf(false), new URL('https://office.test' + p));
    check(refusedAtGate && refusedAtGate.status === 409 && passes === null, `the engine gate itself refuses POST ${p} in an engine business and lets it through in a legacy one`);
  }
  // platform routes behave IDENTICALLY in both modes: same status, same answer
  for (const [method, p, body] of [['POST', '/context/check', {}], ['POST', '/mcp-keys', { name: 'x', scope: 'read' }], ['PATCH', '/settings/permissions', {}]]) {
    const inEngine = await kit.route({ method, path: p, body, role: 'owner', seed: kit.asEngineBusiness() });
    const inLegacy = await kit.route({ method, path: p, body, role: 'owner' });
    check(inEngine.result && inLegacy.result && inEngine.result.status === inLegacy.result.status && JSON.stringify(inEngine.result.body) === JSON.stringify(inLegacy.result.body) && !(inEngine.result.body && inEngine.result.body.error === 'engine_mode'), `a platform route behaves identically in an engine and a legacy business: ${method} ${p} (${inEngine.result && inEngine.result.status} both)`);
  }

  // ---- LEGACY MODE: the engine's routes are refused, the legacy ones are reached ------------------------------------------------------------------------------------------------------------------
  let r = await kit.route({ method: 'GET', path: '/engine/receivables?party=1', role: 'owner' });
  check(r.result && r.result.status === 409 && r.result.body.error === 'not_engine_mode', `a legacy business is refused the engine's routes (got ${r.result && r.result.status} ${r.result && r.result.body && r.result.body.error})`);
  r = await kit.route({ method: 'POST', path: '/engine/proposals', body: { capability: 'payment.record', payload: {} }, role: 'owner' });
  check(r.result && r.result.status === 409 && r.result.body.error === 'not_engine_mode' && !(r.writes && Object.keys(r.writes).length), 'and a proposal to the engine from a legacy business writes nothing, not even a capture');
  r = await kit.route({ method: 'PATCH', path: '/invoices/1', body: { description: 'x' }, role: 'owner' });
  check(r.result && r.result.status !== 409 && !(r.result.body && /engine_mode/.test(String(r.result.body.error))), `a legacy business reaches its own route exactly as before (PATCH /invoices/1 -> ${r.result && r.result.status})`);

  // ---- HELD ACTIONS: the other kind's actions are refused before they are claimed --------------------------------------------------------------------------------------------------------------------
  const hold = (type) => (db) => db.prepare("INSERT INTO pending_actions (id, type, payload, source_transcript, status) VALUES (1, ?, '{}', 'x', 'pending')").run(type);
  const stays = (res) => !(res.writes && res.writes.pending_actions);
  for (const [what, seed, type, want] of [['a legacy action in an engine business', kit.asEngineBusiness(hold('stock_add')), 'stock_add', 'engine_mode'], ['an engine action in a legacy business', hold('engine.payment.record'), 'engine.payment.record', 'not_engine_mode']]) {
    for (const step of ['confirm', 'reject']) {
      const res = await kit.route({ method: 'POST', path: `/actions/1/${step}`, body: {}, role: 'owner', seed });
      check(res.result && res.result.status === 409 && res.result.body.error === want && stays(res), `${what} cannot be ${step}ed: refused 409 ${want}, still pending (${res.result && res.result.status} ${res.result && res.result.body && res.result.body.error})`);
    }
    const ed = await kit.route({ method: 'POST', path: '/actions/1/edit-field', body: { field: 'x', value: 'y' }, role: 'owner', seed });
    check(ed.result && ed.result.status === 409 && ed.result.body.error === want && stays(ed), `${what} cannot be edited: refused 409 ${want} (${ed.result && ed.result.status})`);
  }
  // ---- MCP: an engine business offers no legacy tool, a legacy business offers exactly what it did -------------------------------------------------------------------------------------------------
  const crypto = require('crypto');
  const sha = (x) => crypto.createHash('sha256').update(x).digest('hex'), secret = crypto.createHash('sha256').update('secret:engine').digest('base64url'), keyId = sha('id:engine').slice(0, 16);
  const KEY = `omk.acme-co.${keyId}.${secret}`;
  const DDL = "CREATE TABLE IF NOT EXISTS mcp_keys (id TEXT PRIMARY KEY, label TEXT NOT NULL, email TEXT NOT NULL, hash TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), created_by TEXT NOT NULL, last_used_at TEXT, revoked_at TEXT, uses INTEGER NOT NULL DEFAULT 0, scope TEXT)";
  const mcpSeed = (engine) => (db) => { db.exec(DDL); db.prepare('INSERT INTO mcp_keys (id, label, email, hash, created_by) VALUES (?, ?, ?, ?, ?)').run(keyId, 'engine', 'owner@example.com', sha(secret), 'owner@example.com'); if (engine) db.prepare("INSERT INTO eng_config (key, value_json) VALUES ('mode', '\"engine\"')").run(); };
  const rpc = (method, params, id = 1) => ({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
  const mcp = (engine, body) => kit.route({ method: 'POST', path: '/mcp', noSession: true, headers: { Authorization: 'Bearer ' + KEY }, env: { BUSINESS_ID: 'acme-co', BUSINESS_MODE: 'object', SESSION_SECRET: 'engine-boundary-secret' }, body, seed: mcpSeed(engine) });
  let m = await mcp(false, rpc('tools/list'));
  const legacyTools = ((m.result && m.result.body && m.result.body.result && m.result.body.result.tools) || []).map((t) => t.name);
  check(legacyTools.length >= 6 && legacyTools.includes('get_customer_receivables'), `a legacy business offers its tools exactly as before (${legacyTools.length} for this key)`);
  m = await mcp(true, rpc('tools/list'));
  const engineTools = ((m.result && m.result.body && m.result.body.result && m.result.body.result.tools) || null);
  check(Array.isArray(engineTools) && engineTools.length === 0, `an engine business offers NO legacy tool, reads included (${engineTools ? engineTools.length : 'no answer'})`);
  for (const tool of ['get_customer_receivables', 'tell_the_office', 'schedule_job', 'confirm_pending_action']) {
    m = await mcp(true, rpc('tools/call', { name: tool, arguments: {} }));
    const refusedTool = m.result && m.result.body && m.result.body.error && m.result.body.error.code === -32602;
    const wroteBeyondKeyUsage = Object.keys(m.writes || {}).filter((t) => t !== 'mcp_keys');   // the key's own use counter is bookkeeping, not a record
    check(refusedTool && wroteBeyondKeyUsage.length === 0, `calling ${tool} in an engine business is refused as an unknown tool, and no record is written (${wroteBeyondKeyUsage.join(',') || 'only the key\'s use counter'})`);
  }

  // ---- BACKGROUND WORK: the cron consolidation and the object's alarm write infrastructure, never the engine's or the business's records ------------------------------------------------------------
  const srcDir = path.join(kit.workerDir, 'src');
  const bodyOf = (text, startRe) => { const m = startRe.exec(text); if (!m) return null; let i = text.indexOf('{', m.index + m[0].length - 1), depth = 0; const from = i; for (; i < text.length; i++) { if (text[i] === '{') depth++; else if (text[i] === '}' && --depth === 0) break; } return text.slice(from, i + 1); };
  const writtenTables = (body) => [...new Set([...body.replace(/\/\/[^\n]*/g, '').matchAll(/\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM)\s+"?([a-z_]+)/gi)].map((x) => x[1].toLowerCase()))].sort();
  const memorySrc = fs.readFileSync(path.join(srcDir, 'memory.ts'), 'utf8');
  const cron = bodyOf(memorySrc, /export async function runConsolidation\([^)]*\)[^{]*\{/);
  check(Boolean(cron), 'the cron entry point runConsolidation is found (memory.ts)');
  if (cron) { const t = writtenTables(cron); check(t.every((x) => ['pending_memory_flush', 'memory_errors'].includes(x)), `the cron consolidation writes only the memory index's bookkeeping: ${t.join(', ')}`); }
  const alarm = bodyOf(fs.readFileSync(path.join(srcDir, 'business-object.ts'), 'utf8'), /async alarm\(\)[^{]*\{/);
  check(Boolean(alarm), 'the Durable Object alarm is found (business-object.ts)');
  if (alarm) { const t = writtenTables(alarm); check(t.every((x) => ['object_meta', 'schema_steps'].includes(x)), `the object's alarm writes only its own bookkeeping directly: ${t.join(', ') || 'nothing'}`); }


  // ---- a failure inside an engine route: generic everywhere, explained ONLY on a rehearsal (staging) deployment ----------------------------------------------------------------------------------------------------------
  // Found 2026-11-09: every member engine read on the real staging-two object answered the front door's generic 500, which tells the caller nothing by design. On a deployment with ENGINE_REHEARSAL=1 (staging has it, production does not) an unexpected exception inside an /engine route now
  // comes back with its name and message so a staging run can show WHY; anywhere else it still reaches the front door's generic answer, with nothing about what failed.
  const broken = (db) => { kit.seedReceivables()(db); db.prepare('PRAGMA foreign_keys = OFF').run(); db.prepare('DROP TABLE eng_party').run(); };
  r = await kit.route({ env: { BUSINESS_ID: 'eng-a', ENGINE_REHEARSAL: '1' }, seed: broken, frontDoor: true, method: 'GET', path: '/engine/receivables?party=Mokoena', role: 'accountant' });
  check(r.result && r.result.status === 500 && r.result.body.error === 'engine_route_failed' && /no such table/.test(String(r.result.body.detail)), 'on a rehearsal deployment an unexpected failure inside an engine route says what failed (' + (r.result && r.result.body && r.result.body.detail) + ')');
  r = await kit.route({ env: { BUSINESS_ID: 'eng-a' }, seed: broken, frontDoor: true, method: 'GET', path: '/engine/receivables?party=Mokoena', role: 'accountant' });
  check(r.result && r.result.status === 500 && r.result.body.error !== 'engine_route_failed' && !/no such table|eng_party/.test(JSON.stringify(r.result.body)), 'anywhere else (production has no ENGINE_REHEARSAL) the same failure is the front door\'s generic answer, with nothing about what failed');
});

if (require.main === module) kit.standalone(module.exports);
