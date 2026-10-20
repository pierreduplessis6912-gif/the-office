// The credential core for the read-only MCP adapter (worker/src/mcp-keys.ts; design in MCP_ARCHITECTURE.md). SECURITY-SENSITIVE, so every guard here is also proven by a deliberate breakage (tools/mcp-keys-breakage.js removes each guard from a copy of the source in turn and requires THESE tests to fail). THE RULES this pins: (1) a key is returned once and never stored or listed: only its SHA-256 hash is stored; (2) a wrong secret, an unknown key,
// a key with another key's secret, a revoked key, a key for another business, a malformed key and a member who is no longer active all fail; (3) a malformed string never reaches the database; (4) the capabilities are those of the member's role NOW (a demoted member loses access at once); (5) only an active member can be issued a key, and a business holds at most 10 active keys; (6) revoking is immediate, idempotent and keeps the row.
const path = require('path'), fs = require('fs'), os = require('os'), crypto = require('crypto'), esbuild = require('esbuild');

module.exports = async function runMcpKeyTests({ check, srcDir }) {
  const bundle = (entry) => { const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mk-')), 'm.js'); esbuild.buildSync({ entryPoints: [path.join(srcDir, entry)], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent' }); return require(out); };
  let mk, D1;
  try { mk = bundle('mcp-keys.ts'); D1 = bundle('storage/do-d1.ts').DoD1Database; } catch (e) { check(false, 'mcp-keys.ts builds: ' + String(e.message).split('\n')[0].slice(0, 160)); return; }
  const { newDatabase } = require('./harness.js'); const plain = (r) => (r ? { ...r } : r);
  const shim = (db) => { const sql = { exec(query, ...binds) { const s = db.prepare(query); if (/^\s*(select|with|pragma|values)\b/i.test(query) || /\breturning\b/i.test(query)) { const rows = s.all(...binds).map(plain); return { toArray: () => rows, rowsRead: rows.length, rowsWritten: 0 }; } const r = s.run(...binds); return { toArray: () => [], rowsRead: 0, rowsWritten: Number(r.changes) }; } }; const storage = { transactionSync(fn) { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } } }; return new D1(sql, storage); };
  const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
  const world = () => { const db = newDatabase(path.join(srcDir, '..')); db.exec('PRAGMA foreign_keys = OFF'); const m = db.prepare('INSERT INTO memberships (google_email, role, status) VALUES (?, ?, ?)'); m.run('owner@acme.co', 'owner', 'active'); m.run('sales@acme.co', 'sales', 'active'); m.run('gone@acme.co', 'installer', 'inactive'); return { db, env: { OFFICE_DB: shim(db), BUSINESS_MODE: 'object', BUSINESS_ID: 'acme-co' } }; };
  const issue = (w, over = {}) => mk.issueKey(w.env, { businessId: 'acme-co', email: 'owner@acme.co', label: 'Claude on my phone', createdBy: 'owner@acme.co', ...over });
  const SECRET = 'A'.repeat(43), ID = '0123456789abcdef', good = `omk.acme-co.${ID}.${SECRET}`;

  // ---- reading a key: exactly the format, or nothing ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  { const p = mk.parseKey(good);
    check(p && p.businessId === 'acme-co' && p.keyId === ID && p.secret === SECRET && mk.peekBusinessFromKey(good) === 'acme-co', 'a well-formed key is read into its business, its public id and its secret, and the business can be peeked for routing');
    const bad = [null, undefined, 5, {}, [], '', 'x', ' ' + good, good + ' ', good + '\n', good + '.x', `xmk.acme-co.${ID}.${SECRET}`, `OMK.acme-co.${ID}.${SECRET}`, `omk.acme-co.${ID}`, `omk.${ID}.${SECRET}`, `omk.ACME.${ID}.${SECRET}`, `omk.a.${ID}.${SECRET}`, `omk.-acme.${ID}.${SECRET}`, `omk.acme..${ID}.${SECRET}`,
      `omk.acme-co.${ID.toUpperCase()}.${SECRET}`, `omk.acme-co.${ID.slice(1)}.${SECRET}`, `omk.acme-co.${ID}0.${SECRET}`, `omk.acme-co.0123456789abcdeg.${SECRET}`, `omk.acme-co.${ID}.${SECRET.slice(1)}`, `omk.acme-co.${ID}.${SECRET}A`, `omk.acme-co.${ID}.${'A'.repeat(42)}+`, `omk.acme-co.${ID}.${'A'.repeat(42)}/`, `omk.acme-co.${ID}.${'A'.repeat(42)}=`, `omk.acme-co.${ID}.${'A'.repeat(42)} `, 'omk.' + 'a'.repeat(300)];
    check(bad.every((b) => mk.parseKey(b) === null) && bad.every((b) => mk.peekBusinessFromKey(b) === null), `${bad.length} malformed keys (wrong prefix or case, wrong number of parts, a bad business id, a bad key id, a bad secret length or character, whitespace, too long, not a string) are all refused, and none names a business`); }
  { const req = (h) => new Request('https://x.example/mcp', { headers: h ? { Authorization: h } : {} });
    check(mk.bearerKey(req('Bearer abc.def')) === 'abc.def' && mk.bearerKey(req('bearer abc')) === 'abc' && mk.bearerKey(req('Basic abc')) === null && mk.bearerKey(req('Bearer')) === null && mk.bearerKey(req('Bearer a b')) === null && mk.bearerKey(req(null)) === null, 'the key is read from "Authorization: Bearer <key>" and from nothing else'); }

  // ---- issuing: shown once, only the hash is stored ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  { const w = world(); const a = await issue(w), b = await issue(w, { label: '  Cursor  ' });
    const row = w.db.prepare('SELECT * FROM mcp_keys WHERE id = ?').get(a.id), p = mk.parseKey(a.key);
    check(a.ok === true && p && p.businessId === 'acme-co' && p.keyId === a.id && /^[0-9a-f]{16}$/.test(a.id) && b.ok === true && a.key !== b.key && a.id !== b.id && b.label === 'Cursor', 'issuing returns a well-formed key once for an active member (two keys differ; the label is trimmed)');
    check(row.hash === sha(p.secret) && row.hash !== p.secret && !JSON.stringify(row).includes(p.secret) && row.label === 'Claude on my phone' && row.email === 'owner@acme.co' && row.created_by === 'owner@acme.co' && row.revoked_at === null && row.uses === 0, 'ONLY the SHA-256 hash of the secret is stored: the secret appears nowhere in the row');
    const listed = await mk.listKeys(w.env), text = JSON.stringify(listed);
    check(listed.length === 2 && listed.every((k) => !('hash' in k) && !('key' in k) && !('secret' in k)) && !text.includes(p.secret) && !text.includes(row.hash) && listed.map((k) => k.id).includes(a.id), 'listing never returns a hash or a secret'); }
  { const w = world();
    const r = [await issue(w, { label: '' }), await issue(w, { label: '   ' }), await issue(w, { label: 'x'.repeat(61) }), await issue(w, { label: 'bad\nlabel' }), await issue(w, { label: 5 }), await issue(w, { email: 'nobody@acme.co' }), await issue(w, { email: 'gone@acme.co' }), await issue(w, { email: 5 }), await issue(w, { email: 'not-an-address' }), await issue(w, { createdBy: null }), await issue(w, { businessId: 'NOT VALID' })];
    check(r.every((x) => x.ok === false && typeof x.error === 'string' && !('key' in x)) && w.db.prepare('SELECT COUNT(*) n FROM mcp_keys').get().n === 0, 'issuing refuses an empty, over-long or control-character label, an address that is not an ACTIVE member (unknown, inactive, not an address), a missing issuer and a bad business, and stores nothing'); }
  { const w = world(); const made = []; for (let i = 0; i < 10; i++) made.push(await issue(w, { label: 'k' + i }));
    const eleventh = await issue(w); await mk.revokeKey(w.env, made[0].id); const again = await issue(w);
    check(made.every((m) => m.ok) && eleventh.ok === false && /10 active keys/.test(eleventh.error) && again.ok === true, 'a business holds at most 10 active keys; revoking one makes room'); }

  // ---- using a key: every guard ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  { const w = world(); const a = await issue(w), b = await issue(w, { label: 'second' }); const pa = mk.parseKey(a.key), pb = mk.parseKey(b.key);
    const ok = await mk.authenticateKey(w.env, a.key), used = w.db.prepare('SELECT uses, last_used_at FROM mcp_keys WHERE id = ?').get(a.id);
    check(ok.ok === true && ok.keyId === a.id && ok.email === 'owner@acme.co' && ok.role === 'owner' && ok.capabilities.includes('can_know_profit') && ok.capabilities.includes('can_know_debtors') && used.uses === 1 && used.last_used_at !== null, 'a valid key authenticates as its member with that member\'s role capabilities, and the use is noted');
    const flipped = a.key.slice(0, -1) + (a.key.slice(-1) === 'A' ? 'B' : 'A'), unknown = `omk.acme-co.${'f'.repeat(16)}.${pa.secret}`, crossed = `omk.acme-co.${pa.keyId}.${pb.secret}`;
    const r = [await mk.authenticateKey(w.env, flipped), await mk.authenticateKey(w.env, unknown), await mk.authenticateKey(w.env, crossed)];
    check(r.every((x) => x.ok === false && x.reason === 'unknown_or_bad_key'), 'a wrong secret (one character changed), an unknown key id, and one key\'s id with another key\'s secret ALL fail, and fail the same way (the caller learns nothing about which)');
    check(w.db.prepare('SELECT uses FROM mcp_keys WHERE id = ?').get(a.id).uses === 1, 'a failed attempt is not counted as a use'); }
  { const w = world(); const a = await issue(w), b = await issue(w, { label: 'other' });
    await mk.revokeKey(w.env, a.id); const r = await mk.authenticateKey(w.env, a.key), other = await mk.authenticateKey(w.env, b.key), twice = await mk.revokeKey(w.env, a.id), row = w.db.prepare('SELECT revoked_at FROM mcp_keys WHERE id = ?').get(a.id);
    check(r.ok === false && r.reason === 'revoked' && other.ok === true && twice.found === true && row.revoked_at !== null && w.db.prepare('SELECT COUNT(*) n FROM mcp_keys').get().n === 2, 'a revoked key fails at once (another key still works); revoking again is harmless; the row is kept');
    const none = [await mk.revokeKey(w.env, 'f'.repeat(16)), await mk.revokeKey(w.env, 'nope'), await mk.revokeKey(w.env, null)];
    check(none.every((x) => x.found === false), 'revoking an unknown or malformed id finds nothing and changes nothing'); }
  { const w = world(); const a = await issue(w, { email: 'sales@acme.co' });
    const before = await mk.authenticateKey(w.env, a.key);
    w.db.prepare("UPDATE memberships SET role = 'accountant' WHERE google_email = 'sales@acme.co'").run(); const promoted = await mk.authenticateKey(w.env, a.key);
    w.db.prepare("UPDATE memberships SET status = 'inactive' WHERE google_email = 'sales@acme.co'").run(); const inactive = await mk.authenticateKey(w.env, a.key);
    w.db.prepare("UPDATE memberships SET status = 'active', role = 'sales' WHERE google_email = 'sales@acme.co'").run(); const back = await mk.authenticateKey(w.env, a.key);
    w.db.prepare("DELETE FROM memberships WHERE google_email = 'sales@acme.co'").run(); const deleted = await mk.authenticateKey(w.env, a.key);
    check(before.ok && before.role === 'sales' && !before.capabilities.includes('can_know_profit') && promoted.ok && promoted.role === 'accountant' && JSON.stringify(promoted.capabilities) !== JSON.stringify(before.capabilities) && inactive.ok === false && inactive.reason === 'member_inactive' && back.ok && back.role === 'sales' && deleted.ok === false && deleted.reason === 'member_inactive', 'the capabilities are the member\'s role NOW (changing the role changes them), and a deactivated or removed member loses access at once and regains it only if reinstated'); }
  { const w = world(); const a = await issue(w);
    const elsewhere = { ...w.env, BUSINESS_ID: 'other-co' }, noId = { ...w.env, BUSINESS_ID: undefined }, single = { OFFICE_DB: w.env.OFFICE_DB };
    const r = [await mk.authenticateKey(elsewhere, a.key), await mk.authenticateKey(noId, a.key)];
    check(r.every((x) => x.ok === false && x.reason === 'wrong_business') && (await mk.authenticateKey(single, a.key)).ok === true, 'in a business object, a key for ANOTHER business (or with no business set) fails before the database is read; a single-database deployment has no business to compare');
    let touched = 0; const trap = { BUSINESS_MODE: 'object', BUSINESS_ID: 'acme-co', OFFICE_DB: new Proxy({}, { get() { touched++; throw new Error('the database was read'); } }) };
    const m = [await mk.authenticateKey(trap, 'garbage'), await mk.authenticateKey(trap, null), await mk.authenticateKey(trap, `omk.acme-co.${ID}.short`)];
    check(m.every((x) => x.ok === false && x.reason === 'malformed') && touched === 0, 'a malformed key is refused without touching the database at all');
    const fresh = world(); const bare = await mk.authenticateKey(fresh.env, good);
    check(bare.ok === false && bare.reason === 'unknown_or_bad_key', 'before any key was ever issued (no table yet) a well-formed key simply fails'); }
};
