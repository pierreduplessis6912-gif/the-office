// Proof that the undo tests are not decorative (it changes money records). For each guard in worker/src/mcp-undo.ts it takes a COPY of the worker source, REMOVES that one guard, runs tools/mcp-undo.test.js against the copy and requires at least one check to FAIL.
// Run: NODE_PATH=worker/node_modules node --no-warnings tools/mcp-undo-breakage.js
const fs = require('fs'), os = require('os'), path = require('path');
const root = path.join(__dirname, '..'), workerDir = path.join(root, 'worker');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mub-')), copy = path.join(tmp, 'worker');
fs.cpSync(workerDir, copy, { recursive: true, filter: (src) => !src.split(path.sep).includes('node_modules') });
const target = path.join(copy, 'src', 'mcp-undo.ts'), original = fs.readFileSync(target, 'utf8');
const run = require('./mcp-undo.test.js');
const MUTATIONS = [
  ['an invoice with a payment against it can be voided', 'if ((await count(env, "SELECT COUNT(*) AS n FROM payments WHERE invoice_id = ?", id)) > 0) return', 'if (false) return'],
  ['a quote that became an invoice can be removed', 'if ((await count(env, "SELECT COUNT(*) AS n FROM invoices WHERE quotation_id = ?", id)) > 0) return', 'if (false) return'],
  ['a quote with a job made from it can be removed', 'if ((await count(env, "SELECT COUNT(*) AS n FROM jobs WHERE quotation_id = ?", id)) > 0) return', 'if (false) return'],
  ['a job with an invoice can be removed', 'if ((await count(env, "SELECT COUNT(*) AS n FROM invoices WHERE job_scope_id = ?", id)) > 0) return', 'if (false) return'],
  ['a job with a quote can be removed', 'if ((await count(env, "SELECT COUNT(*) AS n FROM quotations WHERE job_scope_id = ?", id)) > 0) return', 'if (false) return'],
  ['a job with measurements, tasks or changes can be removed', 'if ((await count(env, `SELECT COUNT(*) AS n FROM ${t} WHERE job_scope_id = ?`, id)) > 0) return', 'if (false) return'],
  ['an invoice is deleted instead of voided (its number is lost)', 'if (table === "invoices") {\n      await env.OFFICE_DB.prepare("UPDATE invoices SET', 'if (false) {\n      await env.OFFICE_DB.prepare("UPDATE invoices SET'],
  ['a voided invoice keeps its amount', "SET status = 'void', amount = 0, retention_amount = 0, description", "SET status = 'void', description"],
  ['a voided invoice keeps its retention amount', "retention_amount = 0, description", "description"],
  ['no copy is saved before the change', 'await env.OFFICE_DB.prepare("UPDATE mcp_created_records SET snapshot = ? WHERE id = ?").bind(JSON.stringify(snapshot), tag.id).run();', ''],
  ['a quote\'s line items are not in the saved copy', 'snapshot.line_items = (await', 'snapshot.line_items_not = (await'],
  ['the tag is never marked undone (so it can be undone again)', "UPDATE mcp_created_records SET undone_at = datetime('now'), undone_by = ? WHERE id = ? AND undone_at IS NULL\").bind(by.slice(0, 254), tag.id).run();\n  } catch {", "UPDATE mcp_created_records SET undone_by = ? WHERE id = ? AND undone_at IS NULL\").bind(by.slice(0, 254), tag.id).run();\n  } catch {"],
  ['an already-undone tag is not recognised', "if (tag.undone_at !== null) return { ok: false, reason: \"already_undone\", message: \"That was already undone.\" };\n  const table", "if (false) return { ok: false, reason: \"already_undone\", message: \"That was already undone.\" };\n  const table"],
  ['an already void invoice is voided again (prefixed twice)', 'if (table === "invoices" && row.status === "void") return', 'if (false) return'],
  ['a quote deletes every quote\'s line items', 'DELETE FROM line_items WHERE quotation_id = ?").bind(tag.rec_id)', 'DELETE FROM line_items WHERE ? IS NOT NULL").bind(tag.rec_id)'],
  ['a removal deletes every row of the table', 'await env.OFFICE_DB.prepare(`DELETE FROM ${table} WHERE id = ?`).bind(tag.rec_id).run();', 'await env.OFFICE_DB.prepare(`DELETE FROM ${table} WHERE ? IS NOT NULL`).bind(tag.rec_id).run();'],
  ['a table that is not tracked (customers) can be undone through a tag', '|| !(TRACKED_TABLES as readonly string[]).includes(tag.tbl)) return', ') return'],
  ['a tag id of any type is accepted (a text "1" finds tag 1)', 'if (typeof tagId !== "number" || !Number.isInteger(tagId) || tagId < 1) return', 'if (tagId === null || tagId === undefined || typeof tagId === "object") return'],
  ['a call is undone oldest first', 'WHERE create_id = ? AND undone_at IS NULL ORDER BY id DESC', 'WHERE create_id = ? AND undone_at IS NULL ORDER BY id ASC'],
  ['a record that no longer exists is reported as undone', 'if (!row) return { ok: false, reason: "gone"', 'if (!row) return { ok: false, reason: "already_undone"'],
  ['a failing undo says it worked', 'return { ok: false, reason: "error", message: "That could not be undone. Nothing was lost: a copy was saved first." };', 'return { ok: true, action: "removed", kind, recordId: tag.rec_id };'],
  ['a call lists a tag that was already undone', 'WHERE create_id = ? AND undone_at IS NULL', 'WHERE create_id = ?'],
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
  console.log(missed === 0 ? `\nall ${MUTATIONS.length} undo guards are held by a test that fails when the guard is removed` : `\n${missed} problem(s): see above`);
  process.exit(missed === 0 ? 0 : 1);
})();
