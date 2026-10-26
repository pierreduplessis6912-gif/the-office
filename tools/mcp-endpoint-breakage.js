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
  ['an assistant may decide an action another key proposed', 'mcp', 'if (!link || link.key_id !== who.keyId) return', 'if (!link) return'],
  ['an assistant may decide an action that needs an answer', 'mcp', 'if (!CONFIRMABLE.has(link.type)) return', 'if (false) return'],
  ['confirming is not counted against the key\'s limit', 'mcp', 'await ensureRecords(env);\n  const reserved = await reserveWrite(env, who);\n  if (!reserved.ok) return reserved.refusal;\n  const id = args.action_id;', 'await ensureRecords(env);\n  const id = args.action_id;'],
  ['confirm and reject ignore an argument they do not know', 'mcp', 'for (const key of Object.keys(args)) if (key !== "action_id") return bad(`unknown argument: ${key.slice(0, 40)}`);', ''],
  ['a refusal from the app is reported as success', 'mcp', 'if (result.status < 200 || result.status >= 300) return', 'if (false) return'],
  ['a reject asks the app to confirm', 'mcp', 'result = await host.act(kind, id, { email: who.email });', 'result = await host.act("confirm", id, { email: who.email });'],
  ['a confirmed invoice over the threshold is not flagged', 'mcp', 'const flagged = await anyOverThreshold(env, tagged);\n  return { ok: true, data: { actionId: id,', 'const flagged = false;\n  return { ok: true, data: { actionId: id,'],
  ['held actions are not linked to the key that proposed them', 'mcp', 'const held = await linkHeld(env, who.keyId, slot?.id ?? 0, told.pendingActionIds);', 'const held: Awaited<ReturnType<typeof linkHeld>> = [];'],
  ['a read key can see confirm and reject', 'mcp', 'required: ["action_id"], additionalProperties: false },\n  needsWrite: true, ownerOnly: true, route: null,\n  run: (env, args, who, _origin, host) => decideHeld("confirm"', 'required: ["action_id"], additionalProperties: false },\n  needsWrite: false, ownerOnly: true, route: null,\n  run: (env, args, who, _origin, host) => decideHeld("confirm"'],
  ['confirm is open to any role that holds a write key', 'mcp', 'required: ["action_id"], additionalProperties: false },\n  needsWrite: true, ownerOnly: true, route: null,\n  run: (env, args, who, _origin, host) => decideHeld("reject"', 'required: ["action_id"], additionalProperties: false },\n  needsWrite: true, ownerOnly: false, route: null,\n  run: (env, args, who, _origin, host) => decideHeld("reject"'],
  ['a read-scope key can see and run schedule_job', 'mcp', 'required: ["job_id", "date"], additionalProperties: false },\n  needsWrite: true, ownerOnly: true', 'required: ["job_id", "date"], additionalProperties: false },\n  needsWrite: false, ownerOnly: true'],
  ['edit_created_record is open to any role that holds a write key', 'mcp', 'required: ["kind", "id", "changes"], additionalProperties: false },\n  needsWrite: true, ownerOnly: true', 'required: ["kind", "id", "changes"], additionalProperties: false },\n  needsWrite: true, ownerOnly: false'],
  ['scheduling is not counted against the key\'s limit', 'mcp', 'const reserved = await reserveWrite(env, who);\n    if (!reserved.ok) return reserved.refusal;\n    return scheduleJob', 'return scheduleJob'],
  ['editing is not counted against the key\'s limit', 'mcp', 'const reserved = await reserveWrite(env, who);\n    if (!reserved.ok) return reserved.refusal;\n    return editCreated', 'return editCreated'],
  ['schedule_job ignores an argument it does not know', 'mcp', 'for (const key of Object.keys(args)) if (key !== "job_id" && key !== "date") return bad(`unknown argument: ${key.slice(0, 40)}`);', ''],
  ['edit_created_record ignores an argument it does not know', 'mcp', 'for (const key of Object.keys(args)) if (key !== "kind" && key !== "id" && key !== "changes") return bad(`unknown argument: ${key.slice(0, 40)}`);', ''],
  ['an edit over the threshold is not flagged through the tool', 'mcp', 'return editCreated(env, who.keyId, { kind: args.kind, id: args.id, changes: args.changes }, FLAG_OVER);', 'return editCreated(env, who.keyId, { kind: args.kind, id: args.id, changes: args.changes }, 1e15);'],
  ['a voided invoice still gets a document link', 'reads', '${kind === "invoice" ? " AND status IS NOT \'void\'" : ""}', '${""}'],
  ['a record that could not be traced is no longer reported as untraced', 'mcp', '...(untraced > 0 ? { untracedNote:', '...(false ? { untracedNote:'],
  ['a read-scope key can see and run the creating tool', 'mcp', 'if (tool.needsWrite && who.scope !== SCOPE_WRITE) return false;', ''],
  ['the creating tool is open to any role that holds a write key', 'mcp', '  needsWrite: true, ownerOnly: true, route: null,', '  needsWrite: true, ownerOnly: false, route: null,'],
  ['the hourly cap on creating is not enforced', 'mcp', '(hour?.n ?? 0) >= CREATES_PER_HOUR ||', 'false ||'],
  ['the daily cap on creating is not enforced', 'mcp', '|| (day?.n ?? 0) >= CREATES_PER_DAY)', '|| false)'],
  ['the cap counts every key together instead of each key', 'mcp', "SELECT COUNT(*) AS n FROM mcp_creates WHERE key_id = ? AND created_at >= datetime('now', '-1 day')\").bind(who.keyId)", "SELECT COUNT(*) AS n FROM mcp_creates WHERE ? IS NOT NULL AND created_at >= datetime('now', '-1 day')\").bind(who.keyId)"],
  ['a failed attempt no longer uses up its place (counted after, not before)', 'mcp', 'const slot = await env.OFFICE_DB.prepare("INSERT INTO mcp_creates (key_id, email) VALUES (?, ?) RETURNING id").bind(who.keyId, who.email).first<{ id: number }>();', 'const slot = { id: 0 } as { id: number };'],
  ['an invoice, quote or payment over the threshold is not flagged', 'mcp', 'if ((row?.n ?? 0) > 0) return true;', ''],
  ['an invoice or quote over the threshold is refused instead of only flagged', 'mcp', 'const flagged = await anyOverThreshold(env, tagged);', 'const flagged = await anyOverThreshold(env, tagged); if (flagged) return { ok: false, message: "too large", outcome: "invalid" };'],
  ['what a call created is not recorded against its key (so nothing could be undone)', 'mcp', 'INSERT OR IGNORE INTO mcp_created_records (create_id, key_id, tbl, rec_id) VALUES (?, ?, ?, ?)', 'INSERT OR IGNORE INTO mcp_created_records (create_id, key_id, tbl, rec_id) SELECT ?, ?, ?, ? WHERE 0'],
  ['the creating tool runs with the owner\'s capabilities whoever the member is', 'mcp', 'host.tell(text, { email: who.email, capabilities: who.capabilities }, sink)', 'host.tell(text, { email: who.email, capabilities: ["can_know_profit", "can_know_debtors", "can_invite_members", "can_manage_settings"] }, sink)'],
  ['the creating tool is marked read only to the assistant', 'mcp', 'readOnlyHint: !t.needsWrite', 'readOnlyHint: true'],
  ['an over-long or control-character text is accepted', 'mcp', 'if (text.length < 1 || text.length > MAX_TELL_CHARS || /[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]/.test(text))', 'if (text.length < 1)'],
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
