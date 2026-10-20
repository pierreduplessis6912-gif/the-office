// Proof that the key ROUTE tests are not decorative (security-sensitive). For each guard in the routes (worker/src/index.ts) and their gate (worker/src/auth.ts) it takes a COPY of the worker source, REMOVES that one guard, runs tools/mcp-keys-routes.test.js against the copy, and requires at least one check to FAIL. A guard whose removal no test notices is reported and the script exits non-zero. It never touches the real source.
// Run: NODE_PATH=worker/node_modules node --no-warnings tools/mcp-keys-routes-breakage.js
// Not behaviourally testable here (held by review): the `Cache-Control: no-store` header on the answer that carries a key (the route harness returns status and body only).
const fs = require('fs'), os = require('os'), path = require('path');
const root = path.join(__dirname, '..'), workerDir = path.join(root, 'worker');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mkr-')), copy = path.join(tmp, 'worker');
fs.cpSync(workerDir, copy, { recursive: true, filter: (src) => !src.split(path.sep).includes('node_modules') });
fs.symlinkSync(path.join(workerDir, 'node_modules'), path.join(copy, 'node_modules'));   // the real packages, read only: the copy needs them to build
const files = { index: path.join(copy, 'src', 'index.ts'), auth: path.join(copy, 'src', 'auth.ts') };
const originals = Object.fromEntries(Object.entries(files).map(([k, f]) => [k, fs.readFileSync(f, 'utf8')]));
const run = require('./mcp-keys-routes.test.js');
// The harness bundles the worker to a fixed file name per process and Node caches what it requires, so the cache is cleared before every run: otherwise each mutated run would silently reuse the first build and test nothing.
const clearBuildCache = () => { for (const n of ['rm-poe', 'rm-auth']) delete require.cache[path.join(os.tmpdir(), `${n}-${process.pid}.js`)]; };
const GATE = (m, p) => `  { method: "${m}", path: /^\\/mcp-keys${p}$/, anyOf: ["can_invite_members"] },\n`;

const MUTATIONS = [
  ['issuing is open to a role that can be granted (can_know_profit instead of the owner-only capability)', 'auth', GATE('POST', ''), GATE('POST', '').replace('can_invite_members', 'can_know_profit')],
  ['listing is open to a role that can be granted', 'auth', GATE('GET', ''), GATE('GET', '').replace('can_invite_members', 'can_know_profit')],
  ['revoking is open to a role that can be granted', 'auth', GATE('POST', '\\/revoke'), GATE('POST', '\\/revoke').replace('can_invite_members', 'can_know_profit')],
  ['MCP switched off no longer stops issuing', 'index', 'if (env.MCP === "off") return Response.json({ error: "Keys for outside assistants are switched off." }, { status: 409 });', ''],
  ['a business without an id of its own can still issue', 'index', 'if (!isBusinessId(env.BUSINESS_ID)) return Response.json({ error: "Keys need a business of their own." }, { status: 409 });', 'if (false) return Response.json({}, { status: 409 });'],
  ['the revoke id is not checked for shape', 'index', 'if (typeof asked?.id !== "string" || !/^[0-9a-f]{16}$/.test(asked.id)) return', 'if (typeof asked?.id !== "string") return'],
  ['revoking an unknown key says it worked', 'index', 'return done.found ? Response.json({ revoked: true, id: asked.id }) : Response.json({ error: "No such key." }, { status: 404 });', 'return Response.json({ revoked: true, id: asked.id });'],
  ['issuing ignores the validation result and answers 201 anyway', 'index', 'if (!made.ok) return Response.json({ error: made.error }, { status: 400 });', 'if (!made.ok) return Response.json({ id: "", key: "", label: "", email: "", shownOnce: true, note: "" }, { status: 201 });'],
  ['the answer to issuing does not say the key is shown once', 'index', 'shownOnce: true, note: "Copy this key now.', 'shownOnce: false, note: "Copy this key now.'],
];

(async () => {
  let missed = 0;
  const collect = () => { const list = []; return { list, check: (ok, label) => { if (!ok) list.push(label); } }; };
  const restore = () => { for (const [k, f] of Object.entries(files)) fs.writeFileSync(f, originals[k]); };
  { restore(); clearBuildCache(); const c = collect(); await run({ check: c.check, srcDir: path.join(copy, 'src') }); console.log(`baseline (nothing removed): ${c.list.length} failing checks (must be 0)`); if (c.list.length) { missed++; console.log('  ' + c.list.join('\n  ')); } }
  for (const [name, file, from, to] of MUTATIONS) {
    restore();
    if (!originals[file].includes(from)) { console.log(`NOT APPLIED  ${name}: the text to remove was not found in ${file}.ts (update this script)`); missed++; continue; }
    fs.writeFileSync(files[file], originals[file].replace(from, to));
    const c = collect(); clearBuildCache();
    try { await run({ check: c.check, srcDir: path.join(copy, 'src') }); } catch (e) { c.list.push('threw: ' + String(e.message).slice(0, 100)); }
    if (c.list.length === 0) { missed++; console.log(`NOT CAUGHT   ${name}`); } else console.log(`caught (${String(c.list.length).padStart(2)})  ${name}`);
  }
  restore();
  console.log(missed === 0 ? `\nall ${MUTATIONS.length} route guards are held by a test that fails when the guard is removed` : `\n${missed} problem(s): see above`);
  process.exit(missed === 0 ? 0 : 1);
})();
