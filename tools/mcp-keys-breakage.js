// Proof that the credential tests are not decorative (security-sensitive code, per the handover's rule). For each guard in worker/src/mcp-keys.ts it takes a COPY of the worker source, REMOVES that one guard, runs tools/mcp-keys.test.js against the copy, and requires at least one check to FAIL. A guard whose removal no test notices is reported and the script exits non-zero. It never touches the real source.
// Run: NODE_PATH=worker/node_modules node --no-warnings tools/mcp-keys-breakage.js
// Not behaviourally testable (held by review and by the comments in the source instead): that a MISSING key costs the same hash comparison as a wrong one (timing).
const fs = require('fs'), os = require('os'), path = require('path');
const root = path.join(__dirname, '..'), workerDir = path.join(root, 'worker');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mkb-')), copy = path.join(tmp, 'worker');
fs.cpSync(workerDir, copy, { recursive: true, filter: (src) => !src.split(path.sep).includes('node_modules') });
const targets = { keys: path.join(copy, 'src', 'mcp-keys.ts'), format: path.join(copy, 'src', 'mcp-key-format.ts') }, originals = Object.fromEntries(Object.entries(targets).map(([k, f]) => [k, fs.readFileSync(f, 'utf8')]));
const run = require('./mcp-keys.test.js');

const MUTATIONS = [
  ['a wrong secret is accepted (the hash comparison no longer refuses)', 'keys', 'if (row === null || !same) return', 'if (row === null) return'],
  ['a revoked key still works', 'keys', 'if (row.revoked_at !== null) return { ok: false, reason: "revoked" };', ''],
  ['a deactivated member\'s key still works', 'keys', 'if (!member || member.status !== "active") return { ok: false, reason: "member_inactive" };', 'if (!member) return { ok: false, reason: "member_inactive" };'],
  ['capabilities are the owner\'s whatever the member\'s role is', 'keys', 'const capabilities = await getRoleCapabilities(env, member.role);', 'const capabilities = await getRoleCapabilities(env, "owner");'],
  ['a key for another business is accepted', 'keys', 'if (env.BUSINESS_MODE === "object" && (!env.BUSINESS_ID || key.businessId !== env.BUSINESS_ID)) return { ok: false, reason: "wrong_business" };', ''],
  ['the secret is stored in the clear instead of its hash', 'keys', '.bind(id, label, email, await sha256Hex(secret), createdBy)', '.bind(id, label, email, secret, createdBy)'],
  ['listing returns the hash', 'keys', 'SELECT id, label, email, created_at, created_by, last_used_at, revoked_at, uses FROM mcp_keys', 'SELECT id, label, email, hash, created_at, created_by, last_used_at, revoked_at, uses FROM mcp_keys'],
  ['any secret length or character is accepted', 'format', 'const SECRET = /^[A-Za-z0-9_-]{43}$/;', 'const SECRET = /^.+$/;'],
  ['a key id of any shape is accepted', 'format', 'export const KEY_ID_PATTERN = /^[0-9a-f]{16}$/;', 'export const KEY_ID_PATTERN = /^.+$/;'],
  ['extra parts after the secret are accepted', 'format', 'if (parts.length !== 4 || parts[0] !== KEY_PREFIX) return null;', 'if (parts.length < 4 || parts[0] !== KEY_PREFIX) return null;'],
  ['a key can be issued to someone who is not an active member', 'keys', 'if (!member || member.status !== "active") return { ok: false, error: "that address is not an active member." };', ''],
  ['a business can hold any number of active keys', 'keys', 'if ((active?.n ?? 0) >= MAX_ACTIVE_KEYS)', 'if (false)'],
  ['revoking does not revoke', 'keys', "UPDATE mcp_keys SET revoked_at = datetime('now') WHERE id = ? AND revoked_at IS NULL", 'UPDATE mcp_keys SET uses = uses WHERE id = ?'],
  ['a malformed key is looked up in the database', 'keys', 'if (key === null) return { ok: false, reason: "malformed" };', 'if (key === null) { try { await env.OFFICE_DB.prepare("SELECT 1").first(); } catch { /* noted */ } return { ok: false, reason: "malformed" }; }'],
  ['a business id of any shape is accepted in a key', 'format', 'if (!isBusinessId(businessId) || !KEY_ID_PATTERN.test(keyId) || !SECRET.test(secret)) return null;', 'if (!KEY_ID_PATTERN.test(keyId) || !SECRET.test(secret)) return null;'],
  ['a label with control characters is accepted', 'keys', '|| /[\\u0000-\\u001f\\u007f]/.test(label)', ''],
];

(async () => {
  let missed = 0;
  const collect = () => { const list = []; return { list, check: (ok, label) => { if (!ok) list.push(label); } }; };
  const restore = () => { for (const [k, f] of Object.entries(targets)) fs.writeFileSync(f, originals[k]); };
  { restore(); const c = collect(); await run({ check: c.check, srcDir: path.join(copy, 'src') }); console.log(`baseline (nothing removed): ${c.list.length} failing checks (must be 0)`); if (c.list.length) { missed++; console.log('  ' + c.list.join('\n  ')); } }
  for (const [name, file, from, to] of MUTATIONS) {
    restore();
    if (!originals[file].includes(from)) { console.log(`NOT APPLIED  ${name}: the text to remove was not found in the source (update this script)`); missed++; continue; }
    fs.writeFileSync(targets[file], originals[file].replace(from, to));
    const c = collect();
    try { await run({ check: c.check, srcDir: path.join(copy, 'src') }); } catch (e) { c.list.push('threw: ' + String(e.message).slice(0, 100)); }
    if (c.list.length === 0) { missed++; console.log(`NOT CAUGHT   ${name}`); } else console.log(`caught (${String(c.list.length).padStart(2)})  ${name}`);
  }
  restore();
  console.log(missed === 0 ? `\nall ${MUTATIONS.length} guards are held by a test that fails when the guard is removed` : `\n${missed} problem(s): see above`);
  process.exit(missed === 0 ? 0 : 1);
})();
