// The owner's UNDO of what a connected assistant created (worker/src/mcp-undo.ts). It changes money records, so each rule is also proven by a deliberate breakage (tools/mcp-undo-breakage.js): (1) only a TAGGED record can be undone, by its tag; (2) only what is untouched (a payment, a conversion, a link or measurements block it, with the reason, and nothing changes); (3) a copy is saved before the change and the tag is marked only after it; (4) once only; (5) nothing but the tagged record (and a quote's own line items) is touched; (6) an invoice is VOIDED (number kept, amount to nothing), never deleted.
const path = require('path'), fs = require('fs'), os = require('os'), esbuild = require('esbuild');

module.exports = async function runMcpUndoTests({ check, srcDir }) {
  const bundle = (entry) => { const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mk-')), 'm.js'); esbuild.buildSync({ entryPoints: [path.join(srcDir, entry)], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent' }); return require(out); };
  let undo, D1;
  try { undo = bundle('mcp-undo.ts'); D1 = bundle('storage/do-d1.ts').DoD1Database; } catch (e) { check(false, 'mcp-undo.ts builds: ' + String(e.message).split('\n')[0].slice(0, 160)); return; }
  const { newDatabase } = require('./harness.js'); const plain = (r) => (r ? { ...r } : r);
  const shim = (db) => { const sql = { exec(query, ...binds) { const s = db.prepare(query); if (/^\s*(select|with|pragma|values)\b/i.test(query) || /\breturning\b/i.test(query)) { const rows = s.all(...binds).map(plain); return { toArray: () => rows, rowsRead: rows.length, rowsWritten: 0 }; } const r = s.run(...binds); return { toArray: () => [], rowsRead: 0, rowsWritten: Number(r.changes) }; } }; const storage = { transactionSync(fn) { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } } }; return new D1(sql, storage); };
  const world = () => { const db = newDatabase(path.join(srcDir, '..')); db.exec('PRAGMA foreign_keys = OFF');
    db.exec("CREATE TABLE IF NOT EXISTS mcp_created_records (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL DEFAULT (datetime('now')), create_id INTEGER NOT NULL, key_id TEXT NOT NULL, tbl TEXT NOT NULL, rec_id INTEGER NOT NULL, undone_at TEXT, undone_by TEXT, snapshot TEXT, UNIQUE (tbl, rec_id))");
    db.exec("CREATE TABLE IF NOT EXISTS mcp_keys (id TEXT PRIMARY KEY, label TEXT NOT NULL, email TEXT NOT NULL, hash TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), created_by TEXT NOT NULL, last_used_at TEXT, revoked_at TEXT, uses INTEGER NOT NULL DEFAULT 0, scope TEXT NOT NULL DEFAULT 'mcp:read')");
    db.prepare("INSERT INTO mcp_keys (id, label, email, hash, created_by, scope) VALUES ('k1', 'Claude on my phone', 'o@x.co', 'h', 'o@x.co', 'mcp:write')").run();
    const cust = Number(db.prepare("INSERT INTO customers (name) VALUES ('Jenny')").run().lastInsertRowid);
    const mk = { invoice: (d = 'Carpet repair', a = 3000) => Number(db.prepare("INSERT INTO invoices (customer_id, description, amount, source_transcript, retention_amount) VALUES (?, ?, ?, 't', 0)").run(cust, d, a).lastInsertRowid), quote: (d = 'Quote') => Number(db.prepare("INSERT INTO quotations (customer_id, description, amount, source_transcript) VALUES (?, ?, 100, 't')").run(cust, d).lastInsertRowid),
      expense: () => Number(db.prepare("INSERT INTO expenses (amount, description, source_transcript, category) VALUES (50, 'fuel', 't', 'fuel')").run().lastInsertRowid), task: () => Number(db.prepare("INSERT INTO tasks (description, done) VALUES ('call', 0)").run().lastInsertRowid),
      job: () => Number(db.prepare("INSERT INTO job_scopes (customer_id, description) VALUES (?, 'lay floor')").run(cust).lastInsertRowid), payment: (inv = null) => Number(db.prepare("INSERT INTO payments (customer_id, amount, source_transcript, invoice_id) VALUES (?, 500, 't', ?)").run(cust, inv).lastInsertRowid) };
    const tag = (tbl, id, call = 1) => Number(db.prepare('INSERT INTO mcp_created_records (create_id, key_id, tbl, rec_id) VALUES (?, ?, ?, ?)').run(call, 'k1', tbl, id).lastInsertRowid);
    return { db, env: { OFFICE_DB: shim(db) }, mk, tag, cust }; };
  const row = (w, t, id) => plain(w.db.prepare(`SELECT * FROM ${t} WHERE id = ?`).get(id)), n = (w, t) => w.db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
  const tagRow = (w, id) => plain(w.db.prepare('SELECT * FROM mcp_created_records WHERE id = ?').get(id));

  // ---- an invoice is voided, never deleted ----
  { const w = world(); const i = w.mk.invoice('Carpet repair', 3000), other = w.mk.invoice('Not mine', 777), t = w.tag('invoices', i); w.db.prepare('UPDATE invoices SET retention_percent = 10, retention_amount = 300 WHERE id = ?').run(i);
    const r = await undo.undoTagged(w.env, t, 'owner@x.co'), after = row(w, 'invoices', i), snap = JSON.parse(tagRow(w, t).snapshot);
    check(r.ok === true && r.action === 'voided' && after.status === 'void' && after.amount === 0 && after.retention_amount === 0 && after.description === 'VOID: Carpet repair' && n(w, 'invoices') === 2 && row(w, 'invoices', other).amount === 777 && row(w, 'invoices', other).status === 'issued', 'an invoice is VOIDED: it keeps its number and its row, its amount goes to nothing, it says VOID, and another invoice is untouched');
    check(snap.row.amount === 3000 && snap.row.description === 'Carpet repair' && tagRow(w, t).undone_at !== null && tagRow(w, t).undone_by === 'owner@x.co', 'the original invoice is saved first, and the tag records when and by whom it was undone'); }
  { const w = world(); const i = w.mk.invoice(), t = w.tag('invoices', i), p = w.mk.payment(i);
    const r = await undo.undoTagged(w.env, t, 'o'); const before = row(w, 'invoices', i);
    check(r.ok === false && r.reason === 'blocked' && /payment/.test(r.message) && before.status !== 'void' && before.amount === 3000 && tagRow(w, t).undone_at === null && tagRow(w, t).snapshot === null && n(w, 'payments') === 1, 'an invoice with a payment against it is REFUSED with the reason: nothing changes and no copy is made'); }
  { const w = world(); const i = w.mk.invoice(), t = w.tag('invoices', i); await undo.undoTagged(w.env, t, 'o'); const again = await undo.undoTagged(w.env, t, 'o');
    const w2 = world(); const j = w2.mk.invoice(); const t2 = w2.tag('invoices', j); w2.db.prepare("UPDATE invoices SET status = 'void' WHERE id = ?").run(j); const already = await undo.undoTagged(w2.env, t2, 'o');
    check(again.ok === false && again.reason === 'already_undone' && row(w, 'invoices', i).description === 'VOID: Carpet repair' && already.ok === false && already.reason === 'already_undone', 'a second undo is refused and changes nothing (the description is not prefixed twice)'); }

  // ---- the others are removed, with a saved copy ----
  for (const [kind, table, make] of [['expense', 'expenses', (w) => w.mk.expense()], ['task', 'tasks', (w) => w.mk.task()], ['payment', 'payments', (w) => w.mk.payment()], ['job', 'job_scopes', (w) => w.mk.job()], ['quote', 'quotations', (w) => w.mk.quote()]]) {
    const w = world(); const a = make(w), b = make(w), t = w.tag(table, a); const r = await undo.undoTagged(w.env, t, 'o'), snap = JSON.parse(tagRow(w, t).snapshot);
    check(r.ok === true && r.action === 'removed' && r.kind === kind && row(w, table, a) === undefined && row(w, table, b) !== undefined && n(w, table) === 1 && snap.row.id === a && tagRow(w, t).undone_at !== null, `a ${kind} is removed with a saved copy, and the next ${kind} is untouched`); }
  { const w = world(); const q = w.mk.quote(), keep = w.mk.quote('other'), t = w.tag('quotations', q);
    w.db.prepare("INSERT INTO line_items (quotation_id, description, quantity, unit_price, line_total) VALUES (?, 'a', 1, 10, 10)").run(q); w.db.prepare("INSERT INTO line_items (quotation_id, description, quantity, unit_price, line_total) VALUES (?, 'b', 1, 10, 10)").run(keep);
    const r = await undo.undoTagged(w.env, t, 'o'), snap = JSON.parse(tagRow(w, t).snapshot);
    check(r.ok === true && n(w, 'line_items') === 1 && w.db.prepare('SELECT quotation_id q FROM line_items').get().q === keep && snap.line_items.length === 1, 'a quote takes only its OWN line items with it, and they are in the saved copy'); }

  { const w = world(); const q = w.mk.quote(), t = w.tag('quotations', q); await undo.undoTagged(w.env, t, 'o'); const again = await undo.undoTagged(w.env, t, 'o');
    check(again.ok === false && again.reason === 'already_undone' && /already/.test(again.message), 'a removed record undone a second time says it was already undone (not that it is gone)'); }
  { const w = world(); const k = w.mk.task(), t = w.tag('tasks', k); w.db.exec("CREATE TRIGGER stop_delete BEFORE DELETE ON tasks BEGIN SELECT RAISE(ABORT, 'no'); END");
    const r = await undo.undoTagged(w.env, t, 'o'); const tg = tagRow(w, t);
    check(r.ok === false && r.reason === 'error' && /Nothing was lost/.test(r.message) && row(w, 'tasks', k) !== undefined && tg.undone_at === null && JSON.parse(tg.snapshot).row.id === k, 'when the change itself fails, the answer says so, the record is still there, the tag is NOT marked undone, and the saved copy exists'); }
  // ---- refused when something hangs off it ----
  { const cases = [['quote turned into an invoice', 'quotations', (w, id) => w.db.prepare("INSERT INTO invoices (customer_id, description, amount, source_transcript, quotation_id) VALUES (1, 'x', 1, 't', ?)").run(id), /invoice/, (w) => w.mk.quote()],
      ['job with an invoice', 'job_scopes', (w, id) => w.db.prepare("INSERT INTO invoices (customer_id, description, amount, source_transcript, job_scope_id) VALUES (1, 'x', 1, 't', ?)").run(id), /invoice/, (w) => w.mk.job()],
      ['job with measurements', 'job_scopes', (w, id) => w.db.prepare("INSERT INTO scope_components (job_scope_id, name) VALUES (?, 'kitchen')").run(id), /measurements/, (w) => w.mk.job()],
      ['job with tasks', 'job_scopes', (w, id) => w.db.prepare("INSERT INTO scope_tasks (job_scope_id, description) VALUES (?, 'lift')").run(id), /measurements/, (w) => w.mk.job()],
      ['job with recorded changes', 'job_scopes', (w, id) => w.db.prepare("INSERT INTO job_scope_amendments (job_scope_id, field_name) VALUES (?, 'date')").run(id), /measurements/, (w) => w.mk.job()],
      ['quote with a job made from it', 'quotations', (w, id) => w.db.prepare("INSERT INTO jobs (customer_id, description, quotation_id) VALUES (1, 'x', ?)").run(id), /job/, (w) => w.mk.quote()],
      ['job with a quote', 'job_scopes', (w, id) => w.db.prepare("INSERT INTO quotations (customer_id, description, amount, source_transcript, job_scope_id) VALUES (1, 'x', 1, 't', ?)").run(id), /quote/, (w) => w.mk.job()]];
    for (const [name, table, hang, why, make] of cases) { const w = world(); const id = make(w), t = w.tag(table, id); hang(w, id); const r = await undo.undoTagged(w.env, t, 'o');
      check(r.ok === false && r.reason === 'blocked' && why.test(r.message) && row(w, table, id) !== undefined && tagRow(w, t).undone_at === null && tagRow(w, t).snapshot === null, `a ${name} is REFUSED with the reason and nothing changes`); } }

  // ---- only a tagged record, by its tag ----
  { const w = world(); const i = w.mk.invoice(), t = w.tag('invoices', i); const bad = [await undo.undoTagged(w.env, i + 100), await undo.undoTagged(w.env, 0), await undo.undoTagged(w.env, -1), await undo.undoTagged(w.env, '1'), await undo.undoTagged(w.env, null), await undo.undoTagged(w.env, 1.5), await undo.undoTagged(w.env, { id: t })];
    w.db.prepare("INSERT INTO mcp_created_records (create_id, key_id, tbl, rec_id) VALUES (9, 'k1', 'customers', ?)").run(w.cust); const wrongTable = await undo.undoTagged(w.env, Number(w.db.prepare('SELECT MAX(id) m FROM mcp_created_records').get().m), 'o');
    check(bad.every((x) => x.ok === false && x.reason === 'not_found') && wrongTable.ok === false && wrongTable.reason === 'not_found' && row(w, 'invoices', i).status !== 'void' && row(w, 'customers', w.cust) !== undefined, 'a record id is not a tag: an untagged id, a non-number or a table that is not tracked (customers) is refused and nothing is touched'); }
  { const w = world(); const i = w.mk.invoice(), t = w.tag('invoices', i); w.db.prepare('DELETE FROM invoices WHERE id = ?').run(i); const r = await undo.undoTagged(w.env, t, 'o');
    check(r.ok === false && r.reason === 'gone' && tagRow(w, t).undone_at === null, 'a tagged record that no longer exists is reported as gone, not as undone'); }

  // ---- a whole call, newest first; one refusal does not stop the rest ----
  { const w = world(); const i = w.mk.invoice(), p = w.mk.payment(i), e = w.mk.expense(), other = w.mk.expense(); const ti = w.tag('invoices', i, 5), tp = w.tag('payments', p, 5), te = w.tag('expenses', e, 5); w.tag('expenses', other, 6);
    const r = await undo.undoCall(w.env, 5, 'o'); const by = Object.fromEntries(r.results.map((x) => [x.kind, x.result.ok]));
    check(r.found === true && r.results.length === 3 && r.results[0].tagId === te && by.payment === true && by.invoice === true && by.expense === true && row(w, 'invoices', i).status === 'void' && row(w, 'payments', p) === undefined && row(w, 'expenses', e) === undefined && row(w, 'expenses', other) !== undefined, 'undoing a call goes newest first (so the payment goes before the invoice it was against), and another call\'s record is untouched');
    const again = await undo.undoCall(w.env, 5, 'o'), none = await undo.undoCall(w.env, 99, 'o'), junk = await undo.undoCall(w.env, 'x', 'o');
    check(again.found === false && none.found === false && junk.found === false, 'a call already undone, an unknown call and a non-number find nothing'); }
  { const w = world(); const i = w.mk.invoice(), p = w.mk.payment(i); w.tag('payments', p, 7); w.tag('invoices', i, 7); const e = w.mk.expense(); w.tag('expenses', e, 7);
    // tagged payment, then invoice, then expense: newest first is expense, invoice (BLOCKED: the payment is still there), payment
    const r = await undo.undoCall(w.env, 7, 'o'); const by = r.results.map((x) => x.kind + ':' + (x.result.ok ? 'ok' : x.result.reason));
    check(by.join() === 'expense:ok,invoice:blocked,payment:ok' && row(w, 'invoices', i).status !== 'void' && row(w, 'payments', p) === undefined && row(w, 'expenses', e) === undefined, 'a refusal on one record (an invoice with a payment still against it) is reported for that record and the rest still run');
    const second = await undo.undoCall(w.env, 7, 'o'); check(second.found === true && second.results.length === 1 && second.results[0].result.ok === true && row(w, 'invoices', i).status === 'void', 'undoing the call again afterwards voids the invoice once the payment is gone'); }

  // ---- the list ----
  { const w = world(); const i = w.mk.invoice('Carpet', 3000), q = w.mk.quote(), t1 = w.tag('invoices', i, 1), t2 = w.tag('quotations', q, 2); await undo.undoTagged(w.env, t2, 'o'); const g = w.mk.expense(); const t3 = w.tag('expenses', g, 3); w.db.prepare('DELETE FROM expenses WHERE id = ?').run(g);
    const list = await undo.listCreated(w.env, 50), by = Object.fromEntries(list.map((x) => [x.id, x]));
    check(list.length === 3 && list[0].id === t3 && by[t1].state === 'active' && by[t1].kind === 'invoice' && by[t1].connection === 'Claude on my phone' && by[t1].summary.amount === 3000 && by[t2].state === 'undone' && by[t3].state === 'gone' && !JSON.stringify(list).includes('"hash"') && !JSON.stringify(list).includes('snapshot'), 'the list shows newest first with the connection\'s name, what each one is and whether it is still undoable, undone or gone; it never shows a key hash or the saved copies');
    const v = w.mk.invoice('V', 1), tv = w.tag('invoices', v); await undo.undoTagged(w.env, tv, 'o'); const lv = (await undo.listCreated(w.env, 50)).find((x) => x.id === tv);
    check(lv.state === 'undone', 'a voided invoice shows as undone'); }
  { const w = world(); for (let i = 0; i < 5; i++) w.tag('tasks', w.mk.task());
    const a = await undo.listCreated(w.env, 2), b = await undo.listCreated(w.env, 0), c = await undo.listCreated(w.env, 100000), d = await undo.listCreated(w.env, NaN);
    check(a.length === 2 && b.length === 5 && c.length === 5 && d.length === 5, 'the list is bounded (at most 200, at least 1, and a nonsense limit falls back to 50)'); }
};
