// The owner's routes for the read-only MCP keys (POST /mcp-keys, GET /mcp-keys, POST /mcp-keys/revoke), driven through the REAL request pipeline as each role (worker/src/index.ts, the gate in auth.ts; credential rules in mcp-keys.test.js). SECURITY-SENSITIVE. THE RULES this pins: (1) OWNER ONLY: every route is refused to every other role (403) and to someone not signed in (401); (2) the key is in the answer to issuing ONCE, and what is stored is only its hash: the secret
// appears in no stored row; (3) the list never carries a hash or a secret; (4) a key can only be issued for an ACTIVE member of THIS business, with a plain label; (5) revoking takes an id in the body, answers 404 for an unknown one and 400 for a malformed one; (6) with MCP switched off, nothing new can be issued (listing and revoking still work, so an owner can always shut a key); (7) without a business of its own there is nothing to issue.
const path = require('path'), fs = require('fs'), os = require('os'), crypto = require('crypto'), esbuild = require('esbuild');

module.exports = async function runMcpKeyRouteTests(context) {
  const standIn = global.Response;
  if (global.__RealResponse) global.Response = global.__RealResponse;
  try { await routeTests(context); } finally { global.Response = standIn; }
};

async function routeTests({ check, srcDir }) {
  const bundle = (entry) => { const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mr-')), 'm.js'); esbuild.buildSync({ entryPoints: [path.join(srcDir, entry)], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent' }); return require(out); };
  let mk;
  try { mk = bundle('mcp-keys.ts'); } catch (e) { check(false, 'mcp-keys.ts builds: ' + String(e.message).split('\n')[0].slice(0, 160)); return; }
  const harness = require('./harness.js'), workerDir = path.join(srcDir, '..'), fns = await harness.loadFunctions(workerDir);
  const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
  const ENV = { BUSINESS_ID: 'acme-co' };
  const route = (spec) => harness.runRouteCase(fns, workerDir, { env: ENV, ...spec });
  const DDL = "CREATE TABLE IF NOT EXISTS mcp_keys (id TEXT PRIMARY KEY, label TEXT NOT NULL, email TEXT NOT NULL, hash TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), created_by TEXT NOT NULL, last_used_at TEXT, revoked_at TEXT, uses INTEGER NOT NULL DEFAULT 0)";
  const ID = '0123456789abcdef', seeded = (db) => { db.exec(DDL); db.prepare("INSERT INTO mcp_keys (id, label, email, hash, created_by) VALUES (?, 'Seeded', 'owner@example.com', ?, 'owner@example.com')").run(ID, sha('seed-secret')); };

  // ---- owner only ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const calls = [['GET', '/mcp-keys', undefined], ['POST', '/mcp-keys', { label: 'x' }], ['POST', '/mcp-keys/revoke', { id: ID }]];
  let refused = 0, total = 0;
  for (const [method, p, body] of calls) for (const role of ['accountant', 'installer', 'sales', 'admin']) { const r = await route({ name: `${method} ${p} as ${role}`, method, path: p, body, role, seed: seeded }); total++; if (r.result.status === 403 && !JSON.stringify(r.writes).includes('mcp_keys')) refused++; else check(false, `${method} ${p} is refused to ${role} (403) and changes nothing; got ${r.result.status}`); }
  check(refused === total, `all ${total} (3 routes x 4 other roles) are refused with 403 and write nothing: keys are for the owner only`);
  const noSession = []; for (const [method, p, body] of calls) { const r = await route({ name: `no session ${method} ${p}`, method, path: p, body, noSession: true, seed: seeded }); noSession.push(r.result.status); }
  check(noSession.every((s) => s === 401), 'and to someone not signed in (401)');

  // ---- issuing -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  { const r = await route({ name: 'owner issues', method: 'POST', path: '/mcp-keys', body: { label: 'Claude on my phone' }, role: 'owner' }), b = r.result.body, p = mk.parseKey(b.key), row = (r.writes.mcp_keys || r.writes['mcp_keys'] || {}).added || null;
    check(r.result.status === 201 && p && p.businessId === 'acme-co' && b.shownOnce === true && b.id === p.keyId && b.label === 'Claude on my phone' && b.email === 'owner@example.com' && /cannot be shown again/.test(b.note), 'the owner issues a key for their own address (201): a well-formed key for THIS business, with a note that it is shown once');
    const written = JSON.stringify(r.writes);
    check(written.includes(sha(p.secret)) && !written.includes(p.secret) && written.includes('Claude on my phone') && written.includes('owner@example.com'), 'what was STORED is the hash of the secret, the label and the address: the secret itself is in no stored row'); }
  { const r = await route({ name: 'owner issues for a member', method: 'POST', path: '/mcp-keys', body: { label: 'Cursor', email: 'Sales@Example.com' }, role: 'owner' });
    check(r.result.status === 201 && r.result.body.email === 'sales@example.com', 'the owner can issue a key for another active member (their role then limits what the key can read)'); }
  { const bad = [{ label: '' }, { label: 'x'.repeat(61) }, { label: 'a\nb' }, {}, { label: 'ok', email: 'nobody@example.com' }, { label: 'ok', email: 5 }];
    const out = []; for (const body of bad) { const r = await route({ name: 'bad issue ' + JSON.stringify(body).slice(0, 30), method: 'POST', path: '/mcp-keys', body, role: 'owner' }); out.push([r.result.status, JSON.stringify(r.writes).includes('mcp_keys') && /"added"/.test(JSON.stringify(r.writes.mcp_keys || {})) ? 'wrote' : 'none', typeof r.result.body.error, 'key' in r.result.body]); }
    check(out.every(([s, w, t, k]) => s === 400 && t === 'string' && !k), 'an empty, over-long or control-character label, no label, an address that is not an active member, and an address that is not text are all refused (400) with a reason and no key');
    const nobody = await route({ name: 'issue to inactive', method: 'POST', path: '/mcp-keys', body: { label: 'x', email: 'ghost@example.com' }, role: 'owner', seed: (db) => db.prepare("INSERT INTO memberships (google_email, role, status) VALUES ('ghost@example.com', 'installer', 'inactive')").run() });
    check(nobody.result.status === 400, 'a deactivated member cannot be issued a key'); }
  { const off = await route({ name: 'issue with MCP off', method: 'POST', path: '/mcp-keys', body: { label: 'x' }, role: 'owner', env: { BUSINESS_ID: 'acme-co', MCP: 'off' } }), none = await route({ name: 'issue with no business', method: 'POST', path: '/mcp-keys', body: { label: 'x' }, role: 'owner', env: {} });
    check(off.result.status === 409 && /switched off/.test(off.result.body.error) && none.result.status === 409 && /business of their own/.test(none.result.body.error), 'with MCP switched off, or with no business of its own, nothing is issued (409)');
    const list = await route({ name: 'list with MCP off', method: 'GET', path: '/mcp-keys', role: 'owner', env: { BUSINESS_ID: 'acme-co', MCP: 'off' }, seed: seeded }), rev = await route({ name: 'revoke with MCP off', method: 'POST', path: '/mcp-keys/revoke', body: { id: ID }, role: 'owner', env: { BUSINESS_ID: 'acme-co', MCP: 'off' }, seed: seeded });
    check(list.result.status === 200 && rev.result.status === 200, 'but listing and revoking still work with MCP off, so an owner can always shut a key'); }

  // ---- listing and revoking ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  { const r = await route({ name: 'owner lists', method: 'GET', path: '/mcp-keys', role: 'owner', seed: seeded }), text = JSON.stringify(r.result.body);
    check(r.result.status === 200 && r.result.body.keys.length === 1 && r.result.body.keys[0].id === ID && r.result.body.keys[0].label === 'Seeded' && r.result.body.keys[0].revoked_at === null && r.result.body.keys.every((k) => !('hash' in k)) && !text.includes(sha('seed-secret')), 'the owner lists the keys: id, label, member, dates and use, never a hash or a secret'); }
  { const first = await route({ name: 'revoke', method: 'POST', path: '/mcp-keys/revoke', body: { id: ID }, role: 'owner', seed: seeded }), again = await route({ name: 'revoke twice', method: 'POST', path: '/mcp-keys/revoke', body: { id: ID }, role: 'owner', seed: seeded, before: [{ method: 'POST', path: '/mcp-keys/revoke', body: { id: ID }, role: 'owner' }] });
    const after = await route({ name: 'list after revoke', method: 'GET', path: '/mcp-keys', role: 'owner', seed: seeded, before: [{ method: 'POST', path: '/mcp-keys/revoke', body: { id: ID }, role: 'owner' }] });
    check(first.result.status === 200 && first.result.body.revoked === true && again.result.status === 200 && after.result.body.keys.length === 1 && after.result.body.keys[0].revoked_at !== null, 'the owner revokes a key (200), the list then shows WHEN it was revoked (the row is kept), and revoking again is harmless');
    const unknown = await route({ name: 'revoke unknown', method: 'POST', path: '/mcp-keys/revoke', body: { id: 'f'.repeat(16) }, role: 'owner', seed: seeded });
    const malformed = []; for (const body of [{ id: 'nope' }, { id: 5 }, {}, { id: ID.toUpperCase() }, { id: ID + '0' }]) malformed.push((await route({ name: 'revoke malformed', method: 'POST', path: '/mcp-keys/revoke', body, role: 'owner', seed: seeded })).result.status);
    check(unknown.result.status === 404 && malformed.every((s) => s === 400), 'an unknown key id is 404 and a malformed or missing id is 400'); }
}
