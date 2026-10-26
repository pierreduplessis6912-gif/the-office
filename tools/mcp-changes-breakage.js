// Proof that the stage 3 (edit and schedule) tests are not decorative (they change money records and the schedule). For each guard in worker/src/mcp-changes.ts it takes a COPY of the worker source, REMOVES that one guard, runs tools/mcp-changes.test.js against the copy and requires at least one check to FAIL.
// Run: NODE_PATH=worker/node_modules node --no-warnings tools/mcp-changes-breakage.js
const fs = require('fs'), os = require('os'), path = require('path');
const root = path.join(__dirname, '..'), workerDir = path.join(root, 'worker');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcb-')), copy = path.join(tmp, 'worker');
fs.cpSync(workerDir, copy, { recursive: true, filter: (src) => !src.split(path.sep).includes('node_modules') });
fs.symlinkSync(path.join(workerDir, 'node_modules'), path.join(copy, 'node_modules'));   // the real packages, read only: the copy needs them to build
const target = path.join(copy, 'src', 'mcp-changes.ts'), original = fs.readFileSync(target, 'utf8');
const run = require('./mcp-changes.test.js');
const MUTATIONS = [
  ['an edit reaches a record that was not tagged to a connection', 'const row = tagged ? await env.OFFICE_DB.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(id).first<Record<string, unknown>>() : null;\n  if (!tagged || !row) return', 'const row = await env.OFFICE_DB.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(id).first<Record<string, unknown>>();\n  if (!row) return'],
  ['an edit reaches a record whose tag was undone', 'WHERE tbl = ? AND rec_id = ? AND undone_at IS NULL', 'WHERE tbl = ? AND rec_id = ?'],
  ['an unknown field is accepted and changed', 'if (!FIELDS[kind].includes(key)) return', 'if (false) return'],
  ['an empty change is accepted', 'if (keys.length < 1 || keys.length > FIELDS[kind].length) return', 'if (keys.length > 99) return'],
  ['an amount of zero or less is accepted', 'v > 0 && v <= MAX_AMOUNT ? Math.round', 'v <= MAX_AMOUNT ? Math.round'],
  ['an enormous amount is accepted', 'v > 0 && v <= MAX_AMOUNT ? Math.round', 'v > 0 ? Math.round'],
  ['an amount is not rounded to the cent', 'Math.round(v * 100) / 100 : null', 'v : null'],
  ['a description of any length or characters is accepted', 't.length >= 1 && t.length <= max && !/[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]/.test(t) ? t : null', 't.length >= 1 ? t : null'],
  ['done accepts a non-boolean', 'if (typeof v !== "boolean") return { ok: false, message: "done must be true or false." };', ''],
  ['a void invoice can be edited', 'if (row.status === "void") return "That invoice is void.";', ''],
  ['an invoice with a payment can be edited', 'if ((await count(env, "SELECT COUNT(*) AS n FROM payments WHERE invoice_id = ?", id)) > 0) return "A payment', 'if (false) return "A payment'],
  ['an invoice amount can change though it has line items', 'if (money && (await count(env, "SELECT COUNT(*) AS n FROM line_items WHERE invoice_id = ?", id)) > 0) return', 'if (false) return'],
  ['an invoice amount can change though it has retention', 'if (money && Number(row.retention_percent ?? 0) > 0) return', 'if (false) return'],
  ['a quote that is not a draft can be edited', 'if (row.status !== "draft") return', 'if (false) return'],
  ['a quote that became an invoice can be edited', 'if ((await count(env, "SELECT COUNT(*) AS n FROM invoices WHERE quotation_id = ?", id)) > 0) return "That quote has been turned', 'if (false) return "That quote has been turned'],
  ['a quote amount can change though it has line items', 'if (money && (await count(env, "SELECT COUNT(*) AS n FROM line_items WHERE quotation_id = ?", id)) > 0) return', 'if (false) return'],
  ['an amount over the threshold is not flagged', 'read.values.amount > flagOver', 'read.values.amount > 1e15'],
  ['an expense amount is flagged too', '(kind === "invoice" || kind === "quote") && typeof', 'typeof'],
  ['an edit to the same value is recorded as a change', 'asText(row[f]) !== asText(read.values[f]));', 'true);'],
  ['the old and new value are not recorded before the change', 'for (const f of changed) await env.OFFICE_DB.prepare("INSERT INTO mcp_changes', 'for (const f of []) await env.OFFICE_DB.prepare("INSERT INTO mcp_changes'],
  ['the row is not changed (the answer says it was)', 'await env.OFFICE_DB.prepare(`UPDATE ${table} SET ${f} = ? WHERE id = ?`).bind(read.values[f], id).run();', ''],
  ['a job can be scheduled in the past', 'if (date < today) return refuse("A job cannot be scheduled in the past.");', ''],
  ['an impossible date (a 13th month, 30 February) is accepted', ' || Number.isNaN(Date.parse(`${date}T00:00:00Z`)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date', ''],
  ['a date too far ahead is accepted', 'if (date > `${now.getFullYear() + 2}-12-31`) return refuse("That date is too far ahead.");', ''],
  ['a job that does not exist can be scheduled', 'if (!job) return refuse("That job was not found.", "not_found");', ''],
  ['scheduling does not record the old date', "VALUES (?, 'job_scopes', ?, 'scheduled_date', ?, ?)", "VALUES (?, 'job_scopes', ?, 'scheduled_date', NULL, ?)"],
  ['scheduling does not write the amendment the app writes', 'await env.OFFICE_DB.prepare("INSERT INTO job_scope_amendments (job_scope_id, capture_id, field_name, old_value, new_value) VALUES (?, NULL, \'scheduled_date\', ?, ?)").bind(job.id, job.scheduled_date, date).run();', ''],
  ['a change can be reverted twice', 'if (ch.reverted_at !== null) return', 'if (false) return'],
  ['a revert overwrites a later change', 'if (asText(row[ch.field]) !== ch.new_value) return', 'if (false) return'],
  ['a revert is not recorded as reverted', "UPDATE mcp_changes SET reverted_at = datetime('now'), reverted_by = ? WHERE id = ? AND reverted_at IS NULL", "UPDATE mcp_changes SET reverted_by = ? WHERE id = ? AND reverted_at IS NULL"],
  ['a revert can touch any field of any table (a planted change)', '|| !allowed.includes(ch.field)) return', ') return'],
  ['a revert of a schedule does not put the raw date back', 'await env.OFFICE_DB.prepare("UPDATE job_scopes SET scheduled_date_raw = ? WHERE id = ?").bind(ch.old_value, ch.rec_id).run();', ''],
  ['a revert of a schedule does not write the amendment', 'await env.OFFICE_DB.prepare("INSERT INTO job_scope_amendments (job_scope_id, capture_id, field_name, old_value, new_value) VALUES (?, NULL, \'scheduled_date\', ?, ?)").bind(ch.rec_id, ch.new_value, ch.old_value).run();', ''],
  ['a revert of a record that is gone is reported as done', 'if (!row) return { ok: false, reason: "gone"', 'if (!row) return { ok: false, reason: "error"'],
  ['the list shows changes to tables that are not editable', 'results.filter((r) => typeof r.tbl === "string" && KIND_OF[r.tbl as string]).map', 'results.map'],
  ['a revert id of any type is accepted', 'if (typeof changeId !== "number" || !Number.isInteger(changeId) || changeId < 1) return', 'if (changeId === null || changeId === undefined || typeof changeId === "object") return'],
];
(async () => {
  let missed = 0;
  const collect = () => { const list = []; return { list, check: (ok, label) => { if (!ok) list.push(label); } }; };
  { fs.writeFileSync(target, original); const c = collect(); await run({ check: c.check, srcDir: path.join(copy, 'src') }); console.log(`baseline (nothing removed): ${c.list.length} failing checks (must be 0)`); if (c.list.length) { missed++; console.log(c.list.join('\n')); } }
  for (const [name, from, to] of MUTATIONS) {
    fs.writeFileSync(target, original);
    if (!original.includes(from)) { console.log(`NOT APPLIED  ${name}: the text to remove was not found in the source (update this script)`); missed++; continue; }
    fs.writeFileSync(target, original.replace(from, to));
    const c = collect();
    try { await run({ check: c.check, srcDir: path.join(copy, 'src') }); } catch (e) { c.list.push('threw: ' + String(e.message).slice(0, 100)); }
    if (c.list.length === 0) { missed++; console.log(`NOT CAUGHT   ${name}`); } else console.log(`caught (${String(c.list.length).padStart(2)})  ${name}`);
  }
  fs.writeFileSync(target, original);
  console.log(missed === 0 ? `\nall ${MUTATIONS.length} stage 3 guards are held by a test that fails when the guard is removed` : `\n${missed} problem(s): see above`);
  process.exit(missed === 0 ? 0 : 1);
})();
