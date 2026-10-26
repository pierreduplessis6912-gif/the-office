// Proof that the held-action tests are not decorative (they decide which records are tagged to a connection, and so which an undo can touch). For each guard in worker/src/mcp-pending.ts and the confirm wrapper in worker/src/index.ts it takes a COPY of the worker source, REMOVES that one guard, runs tools/mcp-changes.test.js against the copy and requires at least one check to FAIL.
// Run: NODE_PATH=worker/node_modules node --no-warnings tools/mcp-pending-breakage.js
const fs = require('fs'), os = require('os'), path = require('path');
const root = path.join(__dirname, '..'), workerDir = path.join(root, 'worker');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mpb-')), copy = path.join(tmp, 'worker');
fs.cpSync(workerDir, copy, { recursive: true, filter: (src) => !src.split(path.sep).includes('node_modules') });
fs.symlinkSync(path.join(workerDir, 'node_modules'), path.join(copy, 'node_modules'));   // the real packages, read only: the copy needs them to build
const files = { pending: path.join(copy, 'src', 'mcp-pending.ts'), index: path.join(copy, 'src', 'index.ts') };
const originals = Object.fromEntries(Object.entries(files).map(([k, f]) => [k, fs.readFileSync(f, 'utf8')]));
const runs = { pending: require('./mcp-pending.test.js'), index: require('./mcp-pending-routes.test.js') };
const MUTATIONS = [
  // module (mcp-pending.ts), proven by tools/mcp-pending.test.js
  ['pending', 'an assistant may decide an action that needs an answer', 'new Set(["expense", "payment", "invoice", "quotation"])', 'new Set(["expense", "payment", "invoice", "quotation", "ambiguous_person", "stock_add"])'],
  ['pending', 'an action already decided is linked again', 'if (r.status !== "pending") continue;', ''],
  ['pending', 'a held action is re-linked to another key', 'INSERT OR IGNORE INTO mcp_pending_links', 'INSERT OR REPLACE INTO mcp_pending_links'],
  ['pending', 'a call links more than 20 held actions', '.slice(0, 20);', '.slice(0, 2000);'],
  ['pending', 'a link that already ended is still found', "WHERE pending_id = ? AND status = 'waiting'\"", 'WHERE pending_id = ?"'],
  ['pending', 'a link that already ended is ended again', "WHERE id = ? AND status = 'waiting'\").bind(outcome, by, link.id)", 'WHERE id = ?").bind(outcome, by, link.id)'],
  ['pending', 'a record in a table that is not tracked is tagged', 'if ((TRACKED_TABLES as readonly string[]).includes(t.table)) await', 'await'],
  ['pending', 'the summary repeats the whole payload', 'return parts.length ? parts.join(", ") : null;', 'return JSON.stringify(p);'],
  ['pending', 'the list is oldest first', 'ORDER BY l.id DESC LIMIT ?', 'ORDER BY l.id ASC LIMIT ?'],
  ['pending', 'the collector keeps a record twice', 'if (!tagged.some((t) => t.table === table && t.id === id)) tagged.push({ table, id });', 'tagged.push({ table, id });'],
  ['pending', 'tagging at confirm is not tied to the call that proposed it', 'VALUES (?, ?, ?, ?)").bind(link.create_id, link.key_id, t.table, t.id)', 'VALUES (?, ?, ?, ?)").bind(0, link.key_id, t.table, t.id)'],
  // the wrapper in the app's confirm route (index.ts), proven by tools/mcp-pending-routes.test.js
  ['index', 'the record a confirmation creates is not tagged', '{ ...taggingEnv(env, seen.sink), __mcpTagged: true }', '{ ...env, __mcpTagged: true }'],
  ['index', 'a confirmation that failed still tags and ends the link', 'if (response.ok) await finishLink(env, link,', 'await finishLink(env, link,'],
  ['index', 'a rejection is recorded as a confirmation', 'decided[2] === "confirm" ? "confirmed" : "rejected", "app"', '"confirmed", "app"'],
  ['index', 'a confirm of an action no connection proposed is run through the wrapper but the link is not checked', 'const link = await findLink(env, Number(decided[1]));\n      if (!link) return', 'const link = (await findLink(env, Number(decided[1]))) ?? { id: 0, pending_id: 0, key_id: "x", create_id: 0, type: "x", status: "waiting" };\n      if (false) return'],
];
(async () => {
  let missed = 0;
  const collect = () => { const list = []; return { list, check: (ok, label) => { if (!ok) list.push(label); } }; };
  const clearBuildCache = () => { for (const n of ['rm-poe', 'rm-auth']) delete require.cache[path.join(os.tmpdir(), `${n}-${process.pid}.js`)]; };   // the harness bundles the worker to a fixed file per process and Node caches it: cleared before every run so each mutation is really tested
  const reset = () => { for (const [k, f] of Object.entries(files)) fs.writeFileSync(f, originals[k]); };
  for (const k of Object.keys(runs)) { reset(); clearBuildCache(); const c = collect(); await runs[k]({ check: c.check, srcDir: path.join(copy, 'src') }); console.log(`baseline for ${k} (nothing removed): ${c.list.length} failing checks (must be 0)`); if (c.list.length) { missed++; console.log(c.list.join('\n')); } }
  for (const [k, name, from, to] of MUTATIONS) {
    reset();
    if (!originals[k].includes(from)) { console.log(`NOT APPLIED  ${name}: the text to remove was not found in ${k} (update this script)`); missed++; continue; }
    fs.writeFileSync(files[k], originals[k].replace(from, to));
    clearBuildCache();
    const c = collect();
    try { await runs[k]({ check: c.check, srcDir: path.join(copy, 'src') }); } catch (e) { c.list.push('threw: ' + String(e.message).slice(0, 100)); }
    if (c.list.length === 0) { missed++; console.log(`NOT CAUGHT   ${name}`); } else console.log(`caught (${String(c.list.length).padStart(2)})  ${name}`);
  }
  reset();
  console.log(missed === 0 ? `\nall ${MUTATIONS.length} held-action guards are held by a test that fails when the guard is removed` : `\n${missed} problem(s): see above`);
  process.exit(missed === 0 ? 0 : 1);
})();
