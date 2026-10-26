// The upload link through the REAL front door and the REAL photo and document routes (worker/src/index.ts, mcp-upload.ts): no session, only a signed link and a ticket. What this pins that the module tests cannot: that the gate really admits only the signed link, that the file really reaches the app's own route and is stored and read by it (the vault, the capture, the description), and that nothing about it works for someone without the link.
const path = require('path');

module.exports = async function runUploadRouteTests(context) {
  const standIn = global.Response;
  if (global.__RealResponse) global.Response = global.__RealResponse;
  try { await routeTests(context); } finally { global.Response = standIn; }
};

async function routeTests({ check, srcDir }) {
  const harness = require('./harness.js'), workerDir = path.join(srcDir, '..'), fns = await harness.loadFunctions(workerDir);
  const ENV = { BUSINESS_ID: 'acme-co', SESSION_SECRET: 'upload-routes-secret' };
  const route = (spec) => harness.runRouteCase(fns, workerDir, { env: ENV, noSession: true, frontDoor: true, ai: [{ match: /./, reply: 'A photo of a delivery note from Acme Supplies: 4 boxes of vinyl planks.' }], ...spec });
  const sigFor = async (p, ttl = 60000, env = ENV) => encodeURIComponent(await fns.auth.signDocumentPath(env, p, ttl));
  const DDL = [
    "CREATE TABLE IF NOT EXISTS mcp_keys (id TEXT PRIMARY KEY, label TEXT NOT NULL, email TEXT NOT NULL, hash TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), created_by TEXT NOT NULL, last_used_at TEXT, revoked_at TEXT, uses INTEGER NOT NULL DEFAULT 0, scope TEXT NOT NULL DEFAULT 'mcp:read')",
    "CREATE TABLE IF NOT EXISTS mcp_upload_tickets (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL DEFAULT (datetime('now')), key_id TEXT NOT NULL, email TEXT NOT NULL, create_id INTEGER NOT NULL, used_count INTEGER NOT NULL DEFAULT 0, max_uses INTEGER NOT NULL DEFAULT 5, results TEXT)",
  ];
  const seed = (extra) => (db) => { db.exec('PRAGMA foreign_keys = OFF'); for (const d of DDL) db.exec(d);
    db.prepare("INSERT INTO mcp_keys (id, label, email, hash, created_by, scope) VALUES ('k1', 'Claude on my phone', 'owner@example.com', 'h', 'owner@example.com', 'mcp:write')").run();
    db.prepare("INSERT INTO mcp_upload_tickets (key_id, email, create_id) VALUES ('k1', 'owner@example.com', 7)").run(); if (extra) extra(db); };
  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]).toString('base64');
  const get = async (sig, spec = {}) => route({ name: 'upload page', method: 'GET', path: `/upload/1${sig === undefined ? '' : '?sig=' + sig}`, seed: seed(), ...spec });
  const post = async (sig, form, spec = {}) => route({ name: 'upload', method: 'POST', path: `/upload/1${sig === undefined ? '' : '?sig=' + sig}`, form, seed: seed(), ...spec });

  { const s = await sigFor('/upload/1'); const a = await get(s), none = await get(undefined), wrong = await get(await sigFor('/upload/2')), other = await get(await sigFor('/upload/1', 60000, { ...ENV, SESSION_SECRET: 'not-ours' })), expired = await get(await sigFor('/upload/1', -10 * 365 * 24 * 3600 * 1000));   // years ago: the harness runs on its own clock
    check(a.result.status === 200 && /type="file"/.test(a.result.body) && /\/upload\/1\?sig=/.test(a.result.body) && Object.keys(a.writes).length <= 1 && [none, wrong, other, expired].every((r) => r.result.status === 403), 'through the real front door: the page opens with the signed link and nothing else; no signature, one for another ticket, one made with another secret, and an expired one are all refused (403)'); }
  { const s = await sigFor('/upload/1'); const r = await post(s, { file: { name: 'note.jpg', type: 'image/jpeg', base64: JPEG }, caption: 'delivery note' }); const w = r.writes;
    check(r.result.status === 200 && /<h1>Sent<\/h1>/.test(r.result.body) && w.mcp_upload_tickets.changed[0].after.used_count === 1 && JSON.parse(w.mcp_upload_tickets.changed[0].after.results)[0].received === true && JSON.parse(w.mcp_upload_tickets.changed[0].after.results)[0].kind === 'photo', 'a photo sent through the link reaches the app\'s own photo route and comes back as received');
    check(w.captures && w.captures.added.length >= 1 && w.captures.added.some((c) => c.source === 'photo') && r.effects.some((e) => /photos\//.test(JSON.stringify(e))), 'the app\'s own route did its work: the image is stored in the vault and logged as a photo capture, exactly as one sent from the app'); }
  { const s = await sigFor('/upload/1'); const none = await post(undefined, { file: { name: 'n.jpg', type: 'image/jpeg', base64: JPEG } }), other = await post(await sigFor('/upload/9'), { file: { name: 'n.jpg', type: 'image/jpeg', base64: JPEG } }), html = await post(s, { file: { name: 'n.jpg', type: 'image/jpeg', text: '<html><script>1</script></html>' } });
    check([none, other].every((r) => r.result.status === 403 && !r.writes.captures && !r.writes.mcp_upload_tickets) && html.result.status === 415 && !html.writes.captures, 'without the link, or with one for another ticket, nothing is stored or counted; HTML sent as a photo is refused (415) and never stored'); }
  { const s = await sigFor('/upload/1'); const used = await post(s, { file: { name: 'n.jpg', type: 'image/jpeg', base64: JPEG } }, { seed: seed((db) => db.prepare('UPDATE mcp_upload_tickets SET used_count = 5').run()) }), revoked = await post(s, { file: { name: 'n.jpg', type: 'image/jpeg', base64: JPEG } }, { seed: seed((db) => db.prepare("UPDATE mcp_keys SET revoked_at = datetime('now')").run()) }), old = await post(s, { file: { name: 'n.jpg', type: 'image/jpeg', base64: JPEG } }, { seed: seed((db) => db.prepare("UPDATE mcp_upload_tickets SET created_at = datetime('now', '-20 minutes')").run()) });
    check([used, revoked, old].every((r) => r.result.status === 403 && !r.writes.captures), 'a link whose ticket is used up, whose key was stopped, or that is older than ten minutes is refused even though its signature is still good, and nothing is stored'); }
  { const s = await sigFor('/upload/1'); const put = await route({ name: 'put', method: 'PUT', path: `/upload/1?sig=${s}`, seed: seed() }), del = await route({ name: 'del', method: 'DELETE', path: `/upload/1?sig=${s}`, seed: seed() });
    check(put.result.status === 405 && del.result.status === 405, 'only GET and POST exist on it (405)'); }
};
