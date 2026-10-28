// Proof that the reversible-decision tests are not decorative (security-sensitive: they decide what an assistant may confirm and whether the owner can put it back). For each guard in worker/src/mcp-effects.ts, mcp-pending.ts and mcp-undo.ts it takes a COPY of the worker source, REMOVES that one guard, runs the tests and requires them to FAIL.
// Run: NODE_PATH=worker/node_modules node --no-warnings tools/mcp-effects-breakage.js
const fs = require('fs'), os = require('os'), path = require('path');
const root = path.join(__dirname, '..'), workerDir = path.join(root, 'worker');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'meb-')), copy = path.join(tmp, 'worker');
fs.cpSync(workerDir, copy, { recursive: true, filter: (src) => !src.split(path.sep).includes('node_modules') });
fs.symlinkSync(path.join(workerDir, 'node_modules'), path.join(copy, 'node_modules'));
fs.mkdirSync(path.join(tmp, 'app', 'lib'), { recursive: true }); fs.copyFileSync(path.join(root, 'app', 'lib', 'mcp_created_model.dart'), path.join(tmp, 'app', 'lib', 'mcp_created_model.dart'));   // the test that every reversible kind is in the app's list reads this file
const files = { mcp: path.join(copy, 'src', 'mcp.ts'), effects: path.join(copy, 'src', 'mcp-effects.ts'), pending: path.join(copy, 'src', 'mcp-pending.ts'), undo: path.join(copy, 'src', 'mcp-undo.ts') };
const originals = Object.fromEntries(Object.entries(files).map(([k, f]) => [k, fs.readFileSync(f, 'utf8')]));
const runs = { endpoint: require('./mcp-endpoint.test.js'), effects: require('./mcp-effects.test.js'), pending: require('./mcp-pending.test.js'), routes: require('./mcp-pending-routes.test.js') };
// [file, what is broken, text to remove, what replaces it, which tests must fail]
const MUTATIONS = [
  ['effects', 'a stock add is undone although the stock changed since', 'if (row.quantity_on_hand !== it.quantityAfter) return', 'if (false) return', 'effects'],
  ['effects', 'an item the add created is removed although it was used', 'if ((n?.n ?? 0) > 0) return', 'if (false) return', 'effects'],
  ['effects', 'undoing a stock add adds instead of takes back', 'quantity_on_hand = quantity_on_hand - ?', 'quantity_on_hand = quantity_on_hand + ?', 'effects'],
  ['effects', 'a created item is not removed', 'if (it.created) await tx.OFFICE_DB.prepare("DELETE FROM stock_items', 'if (false) await tx.OFFICE_DB.prepare("DELETE FROM stock_items', 'effects'],
  ['effects', 'a customer detail is put back although it changed again', 'if (!same(now[c.column], c.after)) return', 'if (false) return', 'effects'],
  ['effects', 'a column that is not the customer\'s is accepted', 'if (!/^[a-z_]+$/.test(c.column) || !(c.column in now)) return { ok: false, reason: "error", message: "That change cannot be undone." };\n        if (!same(now[c.column], c.after)) return { ok: false, reason: "blocked", message: "That detail', 'if (false) return { ok: false, reason: "error", message: "That change cannot be undone." };\n        if (!same(now[c.column], c.after)) return { ok: false, reason: "blocked", message: "That detail', 'effects'],
  ['effects', 'a column that is not the job\'s is accepted', 'if (!/^[a-z_]+$/.test(c.column) || !(c.column in now)) return { ok: false, reason: "error", message: "That change cannot be undone." };\n        if (!same(now[c.column], c.after)) return { ok: false, reason: "blocked", message: "That job', 'if (false) return { ok: false, reason: "error", message: "That change cannot be undone." };\n        if (!same(now[c.column], c.after)) return { ok: false, reason: "blocked", message: "That job', 'effects'],
  ['effects', 'undoing a customer detail removes every note of that customer', 'DELETE FROM customer_facts WHERE id = ? AND customer_id = ?', 'DELETE FROM customer_facts WHERE customer_id = ?', 'effects'],
  ['effects', 'a decision that added nothing is still tagged', 'return items.length > 0 ? { effect: "stock_add", items } : null;', 'return { effect: "stock_add", items };', 'effects'],
  ['effects', 'an unreadable record of the change is undone anyway', 'if (!s) return { ok: false, reason: "error", message: "There is no record', 'if (false) return { ok: false, reason: "error", message: "There is no record', 'effects'],
  ['effects', 'a link order is undone although the order was linked to someone else since', 'if (link.customer_id !== linked) return', 'if (false) return', 'effects'],
  ['effects', 'a moved cost is put back although it changed again', 'if ((row.customer_id ?? null) !== (m.after ?? null)) return', 'if (false) return', 'effects'],
  ['effects', 'undoing a link order does not move the costs back', 'for (const m of moved) await tx.OFFICE_DB', 'for (const m of [] as typeof moved) await tx.OFFICE_DB', 'effects'],
  ['effects', 'undoing a link order with no earlier link leaves the link', 'if (previous === null) await tx.OFFICE_DB.prepare("DELETE FROM purchase_order_customers', 'if (false) await tx.OFFICE_DB.prepare("DELETE FROM purchase_order_customers', 'effects'],
  ['effects', 'a link order with too many costs to copy is still copied', 'if ((all.results ?? []).length > MAX_EXPENSE_ROWS) return null;', '', 'effects'],
  ['mcp', 'a decision whose copy cannot be taken is made anyway', 'if (!copy) return { ok: false, message: "A copy of what this would change', 'if (false) return { ok: false, message: "A copy of what this would change', 'endpoint'],
  ['effects', 'a job amendment is undone although the job changed again', 'if (!same(now[c.column], c.after)) return { ok: false, reason: "blocked", message: "That job has been changed again', 'if (false) return { ok: false, reason: "blocked", message: "That job has been changed again', 'effects'],
  ['effects', 'undoing a job amendment leaves its amendment records', 'for (const id of newAmendmentIds) await tx.OFFICE_DB.prepare("DELETE FROM job_scope_amendments', 'for (const id of [] as number[]) await tx.OFFICE_DB.prepare("DELETE FROM job_scope_amendments', 'effects'],
  ['effects', 'undoing a job amendment does not put the job back', 'for (const c of changes) await tx.OFFICE_DB.prepare(`UPDATE job_scopes SET', 'for (const c of [] as typeof changes) await tx.OFFICE_DB.prepare(`UPDATE job_scopes SET', 'effects'],
  ['pending', 'no copy is taken before a decision', 'before = await captureBefore(env, link.type, row?.payload ?? null);', 'before = null;', 'effects'],
  ['pending', 'the tag is tied to the wrong action', 'VALUES (?, ?, ?, ?, ?)").bind(link.create_id, link.key_id, effect.tbl, link.pending_id, effect.snapshot)', 'VALUES (?, ?, ?, ?, ?)").bind(link.create_id, link.key_id, effect.tbl, 0, effect.snapshot)', 'effects'],
  ['pending', 'a decision the owner made in the app is tagged to a connection', 'if (confirm && isEffectKind(link.type))', 'if (isEffectKind(link.type) && !confirm)', 'effects'],
  ['pending', 'a failed confirmation still ends the link', 'if (!response.ok) return;', '', 'routes'],
  ['pending', 'a stock add is not confirmable by an assistant', '"quotation", "stock_add", "customer_fact", "link_order", "job_scope_amendment"]);', '"quotation", "customer_fact", "link_order", "job_scope_amendment"]);', 'pending'],
  ['undo', 'a decision is undone twice', 'if (tag.undone_at !== null) return { ok: false, reason: "already_undone", message: "That was already undone." };\n    let snapshot', 'let snapshot', 'effects'],
  ['undo', 'an undone decision is not marked undone', "undone_at IS NULL\").bind(by.slice(0, 254), tag.id).run(); } catch { /* the change is already", "undone_at IS NULL AND 0\").bind(by.slice(0, 254), tag.id).run(); } catch { /* the change is already", 'effects'],
  ['undo', 'the list shows an undone decision as active', 'state: t.undone_at !== null ? "undone" : "active", undoneAt: t.undone_at, summary: { description: describeEffect', 'state: "active", undoneAt: t.undone_at, summary: { description: describeEffect', 'effects'],
];
(async () => {
  let missed = 0;
  const collect = () => { const list = []; return { list, check: (ok, label) => { if (!ok) list.push(label); } }; };
  const clearBuildCache = () => { for (const n of ['rm-poe', 'rm-auth']) delete require.cache[path.join(os.tmpdir(), `${n}-${process.pid}.js`)]; };
  const reset = () => { for (const [k, f] of Object.entries(files)) fs.writeFileSync(f, originals[k]); };
  for (const k of Object.keys(runs)) { reset(); clearBuildCache(); const c = collect(); await runs[k]({ check: c.check, srcDir: path.join(copy, 'src') }); console.log(`baseline for ${k} (nothing removed): ${c.list.length} failing checks (must be 0)`); if (c.list.length) { missed++; console.log(c.list.join('\n')); } }
  for (const [k, name, from, to, which] of MUTATIONS) {
    reset();
    if (!originals[k].includes(from)) { console.log(`NOT APPLIED  ${name}: the text to remove was not found in ${k} (update this script)`); missed++; continue; }
    fs.writeFileSync(files[k], originals[k].replace(from, to));
    clearBuildCache();
    const c = collect();
    try { await runs[which]({ check: c.check, srcDir: path.join(copy, 'src') }); } catch (e) { c.list.push('threw: ' + String(e.message).slice(0, 100)); }
    if (c.list.length === 0) { missed++; console.log(`NOT CAUGHT   ${name}`); } else console.log(`caught (${String(c.list.length).padStart(2)})  ${name}`);
  }
  reset();
  console.log(missed === 0 ? `\nall ${MUTATIONS.length} reversible-decision guards are held by a test that fails when the guard is removed` : `\n${missed} problem(s): see above`);
  process.exit(missed === 0 ? 0 : 1);
})();
