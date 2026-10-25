// Proof that the MCP endpoint tests are not decorative (security-sensitive: this is the first place a key READS data). For each guard in worker/src/mcp.ts, the gate (auth.ts) and the router (routing.ts) it takes a COPY of the worker source, REMOVES that one guard, runs tools/mcp-endpoint.test.js against the copy, and requires at least one check to FAIL. A guard whose removal no test notices is reported and the script exits non-zero. It never touches the real source.
// Run: NODE_PATH=worker/node_modules node --no-warnings tools/mcp-endpoint-breakage.js
const fs = require('fs'), os = require('os'), path = require('path');
const root = path.join(__dirname, '..'), workerDir = path.join(root, 'worker');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mkx-')), copy = path.join(tmp, 'worker');
fs.cpSync(workerDir, copy, { recursive: true, filter: (src) => !src.split(path.sep).includes('node_modules') });
fs.symlinkSync(path.join(workerDir, 'node_modules'), path.join(copy, 'node_modules'));   // the real packages, read only: the copy needs them to build
const files = { mcp: path.join(copy, 'src', 'mcp.ts'), auth: path.join(copy, 'src', 'auth.ts'), routing: path.join(copy, 'src', 'routing.ts'), reads: path.join(copy, 'src', 'mcp-reads.ts') };
const originals = Object.fromEntries(Object.entries(files).map(([k, f]) => [k, fs.readFileSync(f, 'utf8')]));
const run = require('./mcp-endpoint.test.js');
// The harness bundles the worker to a fixed file name per process and Node caches what it requires, so the cache is cleared before every run: otherwise each mutated run would silently reuse the first build and test nothing.
const clearBuildCache = () => { for (const n of ['rm-poe', 'rm-auth']) delete require.cache[path.join(os.tmpdir(), `${n}-${process.pid}.js`)]; };

const MUTATIONS = [
  ['the gate no longer requires a well-formed key for /mcp', 'auth', 'if (path === "/mcp") return parseKey(bearerKey(request)) === null ?', 'if (path === "/mcp-never") return parseKey(bearerKey(request)) === null ?'],
  ['the router no longer sends /mcp to the business the key names', 'routing', 'if (path === "/mcp") {', 'if (path === "/mcp-never") {'],
  ['the handler no longer refuses a key that does not authenticate', 'mcp', 'if (!auth.ok) return unauthorized(request);', 'if (!auth.ok) { /* carried on */ }'],
  ['the kill switch no longer stops the endpoint', 'mcp', 'if (env.MCP === "off") return', 'if (env.MCP === "never") return'],
  ['a business whose subscription has ended is still served', 'mcp', 'if (await businessLapsed(env)) return unauthorized(request);', ''],
  ['any role is allowed a tool whose route has no rule (the report tools open to everyone)', 'mcp', 'return rule !== undefined && rule.anyOf.some((c) => who.capabilities.includes(c));', 'return rule === undefined || rule.anyOf.some((c) => who.capabilities.includes(c));'],
  ['tools/list shows every tool whatever the role', 'mcp', 'TOOLS.filter((t) => permitted(t, who)).map(', 'TOOLS.map('],
  ['tools/call no longer checks the role', 'mcp', 'if (!permitted(tool, who)) {', 'if (false) {'],
  ['the per-key rate limit is not applied', 'mcp', 'if (await overLimit(env, who.keyId)) return', 'if (false) return'],
  ['tool calls are not audited', 'mcp', 'await audit(env, who, tool.name, outcome, Date.now() - started);', ''],
  ['a request body of any size is accepted', 'mcp', 'if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) return failure(null, -32600, "The request is too large.", 413);', ''],
  ['unknown arguments are accepted and ignored', 'mcp', 'if (!allowed.includes(key)) return { ok: false, message: `unknown argument: ${key.slice(0, 40)}` };', ''],
  ['a customer id is coerced from text', 'mcp', 'typeof id === "number" && Number.isSafeInteger(id) ? String(id) : null', 'String(id)'],
  ['the history tool reads everyone\'s turns, not the member\'s own', 'mcp', 'new URLSearchParams({ who: "me", limit: String(limit) })', 'new URLSearchParams({ who: "all", limit: String(limit) })'],
  ['a write-capable name is added to the tool list', 'mcp', 'name: "get_recent_history",', 'name: "create_invoice",'],
  ['the stage 1 tools are open to every role (the owner-only flag is ignored)', 'mcp', '  if (tool.ownerOnly) return false;\n', ''],
  ['a document link lasts a year instead of 10 minutes', 'mcp', 'signDocumentPath(env, path, 10 * 60 * 1000)', 'signDocumentPath(env, path, 365 * 24 * 60 * 60 * 1000)'],
  ['a document link is made for a record that does not exist', 'mcp', 'if (!(await documentExists(env, kind, id.id)))', 'if (false)'],
  ['a quotation link points at the invoice path', 'mcp', '`/quotations/${id.id}/pdf`', '`/invoices/${id.id}/pdf`'],
  ['the wider reads accept unknown arguments', 'mcp', 'for (const key of Object.keys(args)) if (!allowed.includes(key)) return bad(`unknown argument: ${key.slice(0, 40)}`); return read(env, args);', 'return read(env, args);'],
  ['a page may be of any size', 'reads', 'limit < 1 || limit > MAX_PAGE', 'limit < 1'],
  ['a search is not made literal (a % matches everything)', 'reads', '"%" + s.replace(/[\\\\%_]/g, (c) => "\\\\" + c) + "%";', '"%" + s + "%";'],
  ['merged duplicate customers are listed', 'reads', 'WHERE merged_into_customer_id IS NULL AND (?1', 'WHERE (?1'],
  ['a reversed date range is accepted', 'reads', 'if (out.from && out.to && out.from > out.to) return { ok: false, error: "from must not be after to." };', ''],
  ['a customer filter is ignored on invoices', 'reads', 'FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id\n      WHERE (?1 IS NULL OR i.customer_id = ?1) AND', 'FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id\n      WHERE 1 = 1 AND'],
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
  console.log(missed === 0 ? `\nall ${MUTATIONS.length} endpoint guards are held by a test that fails when the guard is removed` : `\n${missed} problem(s): see above`);
  process.exit(missed === 0 ? 0 : 1);
})();
