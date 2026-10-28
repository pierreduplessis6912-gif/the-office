// Held actions proposed through a connection (worker/src/mcp-pending.ts): the LINK from a held action to the key that proposed it, what the assistant may decide, and the list. Each rule is also proven by a deliberate breakage (tools/mcp-pending-breakage.js).
const path = require('path'), fs = require('fs'), os = require('os'), esbuild = require('esbuild');

module.exports = async function runMcpPendingTests({ check, srcDir }) {
  const bundle = (entry) => { const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mk-')), 'm.js'); esbuild.buildSync({ entryPoints: [path.join(srcDir, entry)], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent' }); return require(out); };
  let pm, D1;
  try { pm = bundle('mcp-pending.ts'); D1 = bundle('storage/do-d1.ts').DoD1Database; } catch (e) { check(false, 'mcp-pending.ts builds: ' + String(e.message).split('\n')[0].slice(0, 160)); return; }
  const { newDatabase } = require('./harness.js'); const plain = (r) => (r ? { ...r } : r);
  const shim = (db) => { const sql = { exec(query, ...binds) { const s = db.prepare(query); if (/^\s*(select|with|pragma|values)\b/i.test(query) || /\breturning\b/i.test(query)) { const rows = s.all(...binds).map(plain); return { toArray: () => rows, rowsRead: rows.length, rowsWritten: 0 }; } const r = s.run(...binds); return { toArray: () => [], rowsRead: 0, rowsWritten: Number(r.changes) }; } }; const storage = { transactionSync(fn) { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } } }; return new D1(sql, storage); };
  const world = () => { const db = newDatabase(path.join(srcDir, '..')); db.exec('PRAGMA foreign_keys = OFF');
    db.exec("CREATE TABLE IF NOT EXISTS mcp_created_records (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL DEFAULT (datetime('now')), create_id INTEGER NOT NULL, key_id TEXT NOT NULL, tbl TEXT NOT NULL, rec_id INTEGER NOT NULL, undone_at TEXT, undone_by TEXT, snapshot TEXT, UNIQUE (tbl, rec_id))");
    db.exec("CREATE TABLE IF NOT EXISTS mcp_keys (id TEXT PRIMARY KEY, label TEXT NOT NULL, email TEXT NOT NULL, hash TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), created_by TEXT NOT NULL, last_used_at TEXT, revoked_at TEXT, uses INTEGER NOT NULL DEFAULT 0, scope TEXT NOT NULL DEFAULT 'mcp:read')");
    db.prepare("INSERT INTO mcp_keys (id, label, email, hash, created_by, scope) VALUES ('k1', 'Claude on my phone', 'o@x.co', 'h', 'o@x.co', 'mcp:write')").run();
    const held = (type, payload, status = 'pending') => Number(db.prepare("INSERT INTO pending_actions (type, payload, source_transcript, status) VALUES (?, ?, 't', ?)").run(type, typeof payload === 'string' ? payload : JSON.stringify(payload), status).lastInsertRowid);
    return { db, env: { OFFICE_DB: shim(db) }, held }; };
  const links = (w) => w.db.prepare('SELECT * FROM mcp_pending_links ORDER BY id').all().map(plain);

  // ---- the summary: only an amount, a description and a name, never the whole payload ----
  check(pm.summarise(JSON.stringify({ amount: 1250.5, description: 'fuel Tuesday', customerName: 'Jenny', secret: 'x', transcript: 'private' })) === 'R1\u00a0250,5, fuel Tuesday, for Jenny' || /^R1.250,5, fuel Tuesday, for Jenny$/.test(pm.summarise(JSON.stringify({ amount: 1250.5, description: 'fuel Tuesday', customerName: 'Jenny', secret: 'x' }))), 'a held action is summarised as its amount, description and name');
  { const a = pm.summarise(JSON.stringify({ amount: 5, secret: 'x', transcript: 'private words' })), b = pm.summarise('not json'), c = pm.summarise(null), d = pm.summarise(JSON.stringify({ description: 'x'.repeat(500), customerName: 'bad\u0000name' })), e = pm.summarise(JSON.stringify({ amount: 'big', description: 5 })), f = pm.summarise(JSON.stringify({ amount: Infinity, description: '   ' }));
    check(/^R5$/.test(a) && b === null && c === null && d.length < 200 && !d.includes('\u0000') && e === null && f === null && !String(a).includes('private'), 'the summary never repeats other fields of the payload, survives bad JSON, is short, has no control characters, and ignores an amount that is not a number'); }

  // ---- linking: only actions still pending, only once, with what the assistant may decide ----
  { const w = world(); const e = w.held('expense', { amount: 1, description: 'x', customerName: 'Jenny' }), inv = w.held('invoice', { amount: 9 }), amb = w.held('ambiguous_person', { x: 1 }), gone = w.held('expense', { amount: 3 }, 'confirmed');
    const out = await pm.linkHeld(w.env, 'k1', 7, [e, inv, amb, gone, e, 99999, 0, -1, 1.5]); const rows = links(w);
    check(out.length === 3 && rows.length === 3 && out.find((o) => o.actionId === e).canConfirmHere === true && out.find((o) => o.actionId === inv).canConfirmHere === true && out.find((o) => o.actionId === amb).canConfirmHere === false && out.find((o) => o.actionId === e).kind === 'expense' && out.find((o) => o.actionId === amb).kind === 'ambiguous person' && rows.every((r) => r.key_id === 'k1' && r.create_id === 7 && r.status === 'waiting'), 'a call links only the held actions that are still pending (not one already decided, an unknown or a nonsense id), once each, to its key and call, and says which the assistant may decide itself'); }
  { const w = world(); const many = []; for (let i = 0; i < 25; i++) many.push(w.held('expense', { amount: i + 1 })); const out = await pm.linkHeld(w.env, 'k1', 7, many);
    check(out.length === 20 && links(w).length === 20, 'a call links at most 20 held actions'); }
  { const w = world(); const e = w.held('expense', { amount: 1 }); await pm.linkHeld(w.env, 'k1', 7, [e]); await pm.linkHeld(w.env, 'k2', 8, [e]);
    check(links(w).length === 1 && links(w)[0].key_id === 'k1' && links(w)[0].create_id === 7, 'a held action already linked is never re-linked to another key'); }
  { const w = world(); const kinds = ['expense', 'payment', 'invoice', 'quotation', 'stock_add', 'customer_fact', 'link_order']; const none = ['ambiguous_person', 'identity_collision', 'project_ambiguity', 'job_scope_amendment', 'imported_invoice', 'supplier_payment', 'convert_quote', 'cancel_order', 'goods_received'];
    check(kinds.every((k) => pm.CONFIRMABLE.has(k)) && none.every((k) => !pm.CONFIRMABLE.has(k)) && pm.CONFIRMABLE.size === 7, 'an assistant may decide only expense, payment, invoice, quote, stock add, customer fact and link order (each can be put back): everything that needs an answer or cannot yet be reversed is left to the owner'); }

  { const w = world(); const f = w.held('customer_fact', { customerId: 1, key: 'email', value: 'a@b.co' }); const out = await pm.linkHeld(w.env, 'k1', 7, pm.heldIdsOf([], [f]));
    check(JSON.stringify(pm.heldIdsOf([3, 4, 3, 0, -1, 1.5, 'x', null], [4, 9, 9, NaN, 2])) === '[3,4,9,2]' && JSON.stringify(pm.heldIdsOf(undefined, 'x')) === '[]' && out.length === 1 && out[0].actionId === f && out[0].kind === 'customer fact' && out[0].canConfirmHere === true && /email: a@b\.co/.test(out[0].summary) && links(w).length === 1, 'the held FACT actions of a tell are linked to the key with the others (whole positive numbers once, in order), so an assistant that proposed a customer detail may confirm it itself'); }

  // ---- finding and finishing ----
  { const w = world(); const e = w.held('expense', { amount: 1 }); await pm.linkHeld(w.env, 'k1', 7, [e]);
    const l = await pm.findLink(w.env, e), none = await pm.findLink(w.env, e + 50), bad = [await pm.findLink(w.env, 0), await pm.findLink(w.env, 'x'), await pm.findLink(w.env, null)];
    check(l && l.key_id === 'k1' && l.create_id === 7 && l.type === 'expense' && none === null && bad.every((x) => x === null), 'a link is found for a held action a connection proposed, and nothing is found for any other id'); 
    await pm.finishLink(w.env, l, 'confirmed', 'app', [{ table: 'expenses', id: 11 }, { table: 'customers', id: 5 }, { table: 'invoices', id: 12 }]);
    const row = links(w)[0], recs = w.db.prepare('SELECT tbl, rec_id, key_id, create_id FROM mcp_created_records ORDER BY id').all().map(plain), again = await pm.findLink(w.env, e);
    check(row.status === 'confirmed' && row.resolved_by === 'app' && row.resolved_at !== null && again === null && recs.length === 2 && recs[0].tbl === 'expenses' && recs[0].rec_id === 11 && recs[0].key_id === 'k1' && recs[0].create_id === 7 && !recs.some((r) => r.tbl === 'customers'), 'finishing a link records how it ended and tags what was created (only tracked tables), and the link is no longer waiting');
    await pm.finishLink(w.env, l, 'rejected', 'app', []); check(links(w)[0].status === 'confirmed', 'a link that already ended is not ended again'); }
  { const w = world(); const e = w.held('expense', { amount: 1 }); await pm.linkHeld(w.env, 'k1', 7, [e]); const l = await pm.findLink(w.env, e); await pm.finishLink(w.env, l, 'rejected', 'claude', [{ table: 'expenses', id: 3 }]);
    check(links(w)[0].status === 'rejected' && links(w)[0].resolved_by === 'claude', 'a rejection is recorded as such'); }

  // ---- the collector ----
  { const c = pm.collector(); c.sink.record('expenses', 4); c.sink.record('expenses', 4); c.sink.record('payments', 2); c.sink.untraced(); check(c.tagged.length === 2 && c.untraced() === 1, 'the collector keeps each created record once and counts what could not be traced'); }

  // ---- the list ----
  { const w = world(); const a = w.held('expense', { amount: 1, description: 'fuel', customerName: 'Jenny' }), b = w.held('invoice', { amount: 90 }), c = w.held('payment', { amount: 5 }); await pm.linkHeld(w.env, 'k1', 7, [a, b, c]); const lb = await pm.findLink(w.env, b); await pm.finishLink(w.env, lb, 'confirmed', 'claude', []); const lc = await pm.findLink(w.env, c); await pm.finishLink(w.env, lc, 'rejected', 'app', []);
    const list = await pm.listHeld(w.env, 50), text = JSON.stringify(list);
    check(list.length === 3 && list[0].actionId === c && list[0].state === 'rejected' && list[1].actionId === b && list[1].state === 'confirmed' && list[1].resolvedBy === 'claude' && list[2].actionId === a && list[2].state === 'waiting' && list[2].kind === 'expense' && list[2].connection === 'Claude on my phone' && /fuel/.test(list[2].summary) && !text.includes('"hash"') && !text.includes('key_id') && !text.includes('payload'), 'the list shows newest first what connections proposed, how each ended and by whom, with the connection\'s name, never a key id, hash or payload');
    check((await pm.listHeld(w.env, 2)).length === 2 && (await pm.listHeld(w.env, 0)).length === 3 && (await pm.listHeld(w.env, NaN)).length === 3, 'the list is bounded and a nonsense limit falls back to 50'); }
  { const w = world(); check((await pm.listHeld(w.env, 50)).length === 0 && (await pm.findLink(w.env, 1)) === null, 'with no link table yet, the list is empty and nothing is found (no error)'); }
};
