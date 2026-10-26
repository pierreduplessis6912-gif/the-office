// THE UPLOAD LINK (worker/src/mcp-upload.ts, the gate in auth.ts, the router in routing.ts). SECURITY-SENSITIVE: it is a page and an upload opened WITHOUT a sign-in, by a link, so each rule is also proven by a deliberate breakage (tools/mcp-upload-breakage.js): (1) opened only by a valid, unexpired signature for THIS ticket's exact path, and by a ticket that is still open (not used up, not older than 10 minutes, key not revoked, member still an active owner); (2) at most 5 files per ticket, each use claimed before the file is read; (3) judged by CONTENT: a JPEG, a PNG or a PDF, not empty, at most 8 MB; (4) handed to the app's own route as the member, the held actions linked to the key; (5) the person is shown only the app's own plain message, escaped.
const path = require('path'), fs = require('fs'), os = require('os'), esbuild = require('esbuild');

module.exports = async function runMcpUploadTests(context) {
  // The suite runs with a stand-in Response; these tests build real ones, so the real one is put back for their duration.
  const standIn = global.Response;
  if (global.__RealResponse) global.Response = global.__RealResponse;
  try { await uploadTests(context); } finally { global.Response = standIn; }
};

async function uploadTests({ check, srcDir }) {
  const bundle = (entry) => { const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mk-')), 'm.js'); esbuild.buildSync({ entryPoints: [path.join(srcDir, entry)], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent' }); return require(out); };
  let up, auth, routing, D1;
  try { up = bundle('mcp-upload.ts'); auth = bundle('auth.ts'); routing = bundle('routing.ts'); D1 = bundle('storage/do-d1.ts').DoD1Database; } catch (e) { check(false, 'mcp-upload.ts builds: ' + String(e.message).split('\n')[0].slice(0, 160)); return; }
  const { newDatabase } = require('./harness.js'); const plain = (r) => (r ? { ...r } : r);
  const shim = (db) => { const sql = { exec(query, ...binds) { const s = db.prepare(query); if (/^\s*(select|with|pragma|values)\b/i.test(query) || /\breturning\b/i.test(query)) { const rows = s.all(...binds).map(plain); return { toArray: () => rows, rowsRead: rows.length, rowsWritten: 0 }; } const r = s.run(...binds); return { toArray: () => [], rowsRead: 0, rowsWritten: Number(r.changes) }; } }; const storage = { transactionSync(fn) { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } } }; return new D1(sql, storage); };
  const SECRET = 'upload-test-secret', ORIGIN = 'https://office.test';
  const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]), PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]), PDF = new TextEncoder().encode('%PDF-1.4\n1 0 obj\n');
  const world = () => { const db = newDatabase(path.join(srcDir, '..')); db.exec('PRAGMA foreign_keys = OFF');
    db.exec("CREATE TABLE IF NOT EXISTS mcp_keys (id TEXT PRIMARY KEY, label TEXT NOT NULL, email TEXT NOT NULL, hash TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), created_by TEXT NOT NULL, last_used_at TEXT, revoked_at TEXT, uses INTEGER NOT NULL DEFAULT 0, scope TEXT NOT NULL DEFAULT 'mcp:read')");
    db.prepare("INSERT INTO mcp_keys (id, label, email, hash, created_by, scope) VALUES ('k1', 'Claude on my phone', 'owner@x.co', 'h', 'owner@x.co', 'mcp:write')").run();
    db.prepare("INSERT INTO memberships (google_email, role, status) VALUES ('owner@x.co', 'owner', 'active')").run();
    db.prepare("INSERT INTO memberships (google_email, role, status) VALUES ('sales@x.co', 'sales', 'active')").run();
    const env = { OFFICE_DB: shim(db), SESSION_SECRET: SECRET, BUSINESS_ID: 'acme-co' };
    const calls = []; const reply = { current: () => Response.json({ status: 'stored', message: 'Photo received.', pendingActionId: null }) };
    const serveWith = (sink) => async (request) => { const form = await request.formData().catch(() => null); const rec = { method: request.method, url: request.url, auth: request.headers.get('Authorization'), fields: {} };
      if (form) for (const [k, v] of form.entries()) rec.fields[k] = typeof v === 'string' ? v : { name: v.name, type: v.type, size: v.size, bytes: new Uint8Array(await v.arrayBuffer()) };
      calls.push(rec); return reply.current(request, sink); };
    return { db, env, calls, reply, serveWith }; };
  const ticket = async (w, who = { keyId: 'k1', email: 'owner@x.co' }) => await up.issueTicket(w.env, who, 7);
  const send = (w, id, { file, name = 'x.jpg', type = 'image/jpeg', caption, raw } = {}) => { let body; if (raw !== undefined) body = raw; else { const f = new FormData(); if (file) f.set('file', new File([file], name, { type })); if (caption !== undefined) f.set('caption', caption); body = f; } return up.receiveUpload(w.env, new Request(`${ORIGIN}/upload/${id}?sig=x`, { method: 'POST', body }), id, w.serveWith); };
  const html = async (r) => await r.text();
  const count = (w, t) => { try { return w.db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n; } catch { return 0; } };

  // ---- the LINK: its signature covers the exact path, and the gate opens only that ----
  { const w = world(); const id = await ticket(w), link = await up.linkFor(w.env, ORIGIN, id), url = new URL(link), sig = url.searchParams.get('sig');
    const open = async (p, s, method = 'GET', e = w.env) => { const u = new URL(ORIGIN + p + (s === undefined ? '' : '?sig=' + encodeURIComponent(s))); const r = await auth.authGate(new Request(u, { method }), e, u); return r === null ? 'open' : r.status; };
    check(url.pathname === `/upload/${id}` && url.origin === ORIGIN && !!sig, 'the link is /upload/<ticket> on the same origin with a signature');
    check(await open(`/upload/${id}`, sig) === 'open' && await open(`/upload/${id}`, sig, 'POST') === 'open', 'the gate opens the page (GET) and the upload (POST) for that exact path with that signature');
    const other = await auth.signDocumentPath(w.env, `/upload/${id + 1}`, 60000), pdf = await auth.signDocumentPath(w.env, '/invoices/3/pdf', 60000), expired = await auth.signDocumentPath(w.env, `/upload/${id}`, -1000), foreign = await auth.signDocumentPath({ ...w.env, SESSION_SECRET: 'someone-elses' }, `/upload/${id}`, 60000);
    const refused = [await open(`/upload/${id}`, undefined), await open(`/upload/${id}`, ''), await open(`/upload/${id}`, 'garbage'), await open(`/upload/${id}`, other), await open(`/upload/${id}`, pdf), await open(`/upload/${id}`, expired), await open(`/upload/${id}`, foreign), await open(`/upload/${id}`, sig, 'POST', { ...w.env, BUSINESS_MODE: 'object', BUSINESS_ID: 'another-business' })];
    check(refused.every((x) => x === 403), 'no signature, an empty or garbage one, one for another ticket, one for an invoice PDF, an expired one, one made with another secret, or one for another business: all refused (403)');
    check(await open('/invoices/3/pdf', sig) === 403 && await open(`/upload/${id + 1}`, sig) === 403, 'and an upload signature opens nothing else: not a PDF path, not another ticket');
    check(await open(`/upload/${id}`, sig, 'PUT') === 405 && await open(`/upload/${id}`, sig, 'DELETE') === 405 && await open(`/upload/${id}`, sig, 'PATCH') === 405, 'only GET and POST are allowed on it, even with a good signature (405)');
    const shapes = []; for (const p of ['/upload/abc', `/upload/${id}/x`, '/upload/', '/upload', `/upload/${id}.json`, `//upload/${id}`]) shapes.push(await open(p, sig));
    check(shapes.every((x) => x === 401), 'a path that only looks like an upload (not a number, an extra part, no id) is not opened by it: it falls to the normal sign-in rule (401)'); }

  // ---- the ROUTER sends the link to the business it was made for ----
  { const w = world(); const id = await ticket(w); const sigFor = async (b) => await auth.signDocumentPath({ ...w.env, BUSINESS_ID: b }, `/upload/${id}`, 60000); const route = async (p, sig, method = 'GET') => routing.routeRequest(new Request(`${ORIGIN}${p}${sig ? '?sig=' + encodeURIComponent(sig) : ''}`, { method }), { ...w.env });
    const a = await route(`/upload/${id}`, await sigFor('acme-co')), none = await route(`/upload/${id}`, undefined), junk = await route(`/upload/${id}`, 'not.a.token'), post = await route(`/upload/${id}`, await sigFor('other-co'), 'POST');
    check(a.kind === 'business' && a.businessId === 'acme-co' && post.kind === 'business' && post.businessId === 'other-co' && none.kind === 'worker' && junk.kind === 'worker', 'the router hands an upload link to the business named in its signature (page and upload alike); one with no signature, or a garbled one, wakes no business and meets the Worker\'s own gate'); }

  // ---- the TICKET: good only while it is still good, right now ----
  { const w = world(); const id = await ticket(w), ok = await up.openTicket(w.env, id);
    const bad = [await up.openTicket(w.env, id + 99), await up.openTicket(w.env, 0), await up.openTicket(w.env, -3), await up.openTicket(w.env, 1.5), await up.openTicket(w.env, '1'), await up.openTicket(w.env, null)];
    check(ok.ok === true && bad.every((x) => x.ok === false && x.reason === 'gone'), 'a real ticket opens; an unknown id, zero, a negative, a fraction, a text or nothing is "gone"'); }
  { const reasons = []; const make = async (mut) => { const w = world(); const id = await ticket(w); mut(w, id); return (await up.openTicket(w.env, id)); };
    reasons.push((await make((w, id) => w.db.prepare("UPDATE mcp_upload_tickets SET created_at = datetime('now', '-11 minutes') WHERE id = ?").run(id))).reason);
    reasons.push((await make((w, id) => w.db.prepare("UPDATE mcp_upload_tickets SET used_count = max_uses WHERE id = ?").run(id))).reason);
    reasons.push((await make((w) => w.db.prepare("UPDATE mcp_keys SET revoked_at = datetime('now')").run())).reason);
    reasons.push((await make((w) => w.db.prepare("DELETE FROM mcp_keys").run())).reason);
    reasons.push((await make((w) => w.db.prepare("UPDATE memberships SET role = 'sales' WHERE google_email = 'owner@x.co'").run())).reason);
    reasons.push((await make((w) => w.db.prepare("UPDATE memberships SET status = 'removed' WHERE google_email = 'owner@x.co'").run())).reason);
    reasons.push((await make((w) => w.db.prepare("DELETE FROM memberships WHERE google_email = 'owner@x.co'").run())).reason);
    check(reasons.join() === 'expired,used,revoked,revoked,notowner,notowner,notowner', 'a ticket stops working when it is older than 10 minutes, used up, its key revoked or gone, or its member no longer an active owner (checked NOW, not when the link was made)');
    const w = world(); const nine = await ticket(w); w.db.prepare("UPDATE mcp_upload_tickets SET created_at = datetime('now', '-9 minutes') WHERE id = ?").run(nine); check((await up.openTicket(w.env, nine)).ok === true, 'at nine minutes it still works'); }

  // ---- the PAGE ----
  { const w = world(); const id = await ticket(w); const r = await up.uploadPage(w.env, id, `/upload/${id}?sig=abc"><script>alert(1)</script>`), h = await html(r);
    check(r.status === 200 && /<form method="post" action="\/upload\/\d+\?sig=abc&quot;&gt;&lt;script&gt;/.test(h) && /enctype="multipart\/form-data"/.test(h) && /type="file"/.test(h) && !/<script/i.test(h) && /default-src 'none'/.test(r.headers.get('Content-Security-Policy')) && r.headers.get('Cache-Control') === 'no-store' && r.headers.get('X-Frame-Options') === 'DENY' && /5 more files/.test(h), 'the page is plain HTML with no script, posts back to the same address (the address is escaped), cannot be framed or cached, and says how many files are left');
    const closedPages = [await up.uploadPage(w.env, id + 50, '/x'), (w.db.prepare("UPDATE mcp_upload_tickets SET used_count = max_uses").run(), await up.uploadPage(w.env, id, '/x'))]; const codes = closedPages.map((r) => r.status);
    check(codes[0] === 404 && codes[1] === 403 && (await html(closedPages[0])).includes('not valid') && (await html(closedPages[1])).includes('used up'), 'an unknown ticket is a 404 and a used-up one a 403, each with its own plain reason and no form'); }

  // ---- judged by CONTENT ----
  { const t = (b) => up.sniff(b);
    check(t(JPEG).kind === 'photo' && t(JPEG).mime === 'image/jpeg' && t(PNG).mime === 'image/png' && t(PDF).kind === 'pdf' && t(PDF).mime === 'application/pdf', 'a JPEG, a PNG and a PDF are recognised by their first bytes');
    const no = [new Uint8Array(0), Uint8Array.from([0xff, 0xd8]), Uint8Array.from([0x89, 0x50, 0x4e, 0x47]), new TextEncoder().encode('GIF89a....'), new TextEncoder().encode('RIFF....WEBPVP8 '), new TextEncoder().encode('<html><script>alert(1)</script>'), new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'), new TextEncoder().encode('PK\u0003\u0004zip'), new TextEncoder().encode('MZ\u0090 exe'), new TextEncoder().encode(' %PDF-1.4'), new TextEncoder().encode('%PDF'), new TextEncoder().encode('#!/bin/sh')];
    check(no.every((b) => t(b) === null), 'empty, truncated, a GIF, a WebP, HTML, SVG, a zip, a program, a script, a PDF with something in front of it, or a bare "%PDF" are NOT passed on'); }

  // ---- receiving: handed to the app's own route, as the member ----
  { const w = world(); const id = await ticket(w); w.db.prepare("INSERT INTO pending_actions (type, payload, source_transcript, status) VALUES ('supplier_invoice', ?, 't', 'pending')").run(JSON.stringify({ amount: 1200, description: 'vinyl planks', customerName: 'Acme Supplies' }));
    w.reply.current = () => Response.json({ status: 'stored', message: 'Supplier invoice noted for Acme Supplies of R1200 \u2014 needs your confirmation.', pendingActionId: 1 });
    const r = await send(w, id, { file: JPEG, caption: 'Tuesday delivery' }), h = await html(r), c = w.calls[0], link = w.db.prepare('SELECT * FROM mcp_pending_links').get(), t = w.db.prepare('SELECT used_count, results FROM mcp_upload_tickets').get(); const verified = await auth.verifySession({ ...w.env, BUSINESS_MODE: 'object' }, (c.auth || '').replace('Bearer ', ''));
    check(r.status === 200 && /<h1>Sent<\/h1>/.test(h) && h.includes('Supplier invoice noted for Acme Supplies') && w.calls.length === 1 && c.method === 'POST' && c.url === `${ORIGIN}/files/photo` && c.fields.photo.type === 'image/jpeg' && c.fields.photo.bytes.length === JPEG.length && c.fields.photo.bytes.every((b, i) => b === JPEG[i]) && !('document' in c.fields) && c.fields.caption === 'Tuesday delivery' && c.fields.idempotency_key === `mcp-upload-${id}-1`, 'a photo is handed to the app\'s own /files/photo route, byte for byte, as a "photo" with its note and a retry-safe key, and the person is told what the Office made of it');
    const sess = JSON.parse(Buffer.from((c.auth || '').replace('Bearer ', '').split('.')[0], 'base64url').toString());
    check(verified && verified.email === 'owner@x.co' && sess.exp - Date.now() <= 61000 && sess.exp - Date.now() > 0, 'it is sent as the owner the ticket belongs to, with a real session that lasts no more than a minute');
    check(link.pending_id === 1 && link.key_id === 'k1' && link.create_id === 7 && link.type === 'supplier_invoice' && t.used_count === 1 && JSON.parse(t.results)[0].held[0].actionId === 1 && JSON.parse(t.results)[0].held[0].canConfirmHere === false && JSON.parse(t.results)[0].received === true && JSON.parse(t.results)[0].kind === 'photo', 'the held action it produced is LINKED to the key that asked for the link, a supplier invoice is NOT one the assistant may confirm itself, and what happened is noted on the ticket'); }
  { const w = world(); const id = await ticket(w); w.db.prepare("INSERT INTO pending_actions (type, payload, source_transcript, status) VALUES ('expense', ?, 't', 'pending')").run(JSON.stringify({ amount: 30 })); w.reply.current = () => Response.json({ status: 'stored', message: 'Expense noted.', pendingActionId: 1 });
    await send(w, id, { file: PNG, name: 'r.png', type: 'image/png' }); const e = JSON.parse(w.db.prepare('SELECT results FROM mcp_upload_tickets').get().results)[0];
    check(w.calls[0].fields.photo.type === 'image/png' && w.calls[0].fields.photo.name === 'upload.png' && e.held[0].kind === 'expense' && e.held[0].canConfirmHere === true, 'a held expense from a photo IS one the assistant may confirm itself, like any it proposed'); }
  { const w = world(); const id = await ticket(w); w.reply.current = () => Response.json({ status: 'stored', message: 'Document read.', pendingActionId: null }); const r = await send(w, id, { file: PDF, name: 'inv.pdf', type: 'application/pdf' }), c = w.calls[0];
    check(r.status === 200 && c.url === `${ORIGIN}/files/document` && c.fields.document.type === 'application/pdf' && c.fields.document.name === 'upload.pdf' && !('photo' in c.fields) && !('caption' in c.fields), 'a PDF is handed to /files/document as a "document", with no note when none was given');
    const w2 = world(); const id2 = await ticket(w2); await send(w2, id2, { file: JPEG, type: 'application/pdf', name: 'it-is-a-photo.pdf' }); await send(w2, id2, { file: PDF, type: 'image/jpeg', name: 'it-is-a-pdf.jpg' });
    check(w2.calls[0].url.endsWith('/files/photo') && w2.calls[1].url.endsWith('/files/document'), 'what the file IS decides where it goes, not its name or what the browser called it'); }
  { const w = world(); const id = await ticket(w); await send(w, id, { file: JPEG, caption: 'a\u0000b\u0007c' + 'x'.repeat(400) }); const cap = w.calls[0].fields.caption;
    const w2 = world(); const id2 = await ticket(w2); await send(w2, id2, { file: JPEG, caption: '   ' });
    check(cap.length === 200 && !/[\u0000-\u001f]/.test(cap) && !('caption' in w2.calls[0].fields), 'a note is cleaned of control characters and cut to 200, and a blank one is not sent'); }

  // ---- refused before anything is passed on ----
  { const w = world(); const big = new Uint8Array(8 * 1024 * 1024 + 1); big[0] = 0xff; big[1] = 0xd8; big[2] = 0xff; const one = async (opts) => send(w, await ticket(w), opts);
    const cases = [['no file', await one({ caption: 'x' }), 400], ['empty file', await one({ file: new Uint8Array(0) }), 400], ['too big', await one({ file: big }), 413], ['html as a photo', await one({ file: new TextEncoder().encode('<html><script>x</script></html>'), name: 'x.jpg', type: 'image/jpeg' }), 415], ['a program', await one({ file: new TextEncoder().encode('MZ\u0090\u0000'), name: 'x.pdf', type: 'application/pdf' }), 415], ['not a form', await one({ raw: JSON.stringify({ file: 'x' }) }), 400]];
    check(cases.every(([, r, code]) => r.status === code) && w.calls.length === 0, 'no file, an empty one, one over 8 MB, HTML or a program dressed up as a photo or PDF, and something that is not a form are each refused with their own status, and NOTHING is passed on'); }
  { const w = world(); const id = await ticket(w); await send(w, id, { file: new Uint8Array(0) }); await send(w, id, { caption: 'x' }); await send(w, id, { file: new TextEncoder().encode('nope') });
    check(w.db.prepare('SELECT used_count FROM mcp_upload_tickets').get().used_count === 3 && w.calls.length === 0, 'each attempt, good or bad, uses one of the ticket\'s five places (claimed before the file is read)'); }

  // ---- at most five ----
  { const w = world(); const id = await ticket(w); const out = []; for (let i = 0; i < 7; i++) out.push((await send(w, id, { file: JPEG })).status);
    check(out.join() === '200,200,200,200,200,403,403' && w.calls.length === 5 && w.db.prepare('SELECT used_count FROM mcp_upload_tickets').get().used_count === 5, 'a ticket takes five files: the sixth and seventh are refused and never passed on');
    const w2 = world(); const id2 = await ticket(w2); const burst = await Promise.all(Array.from({ length: 9 }, () => send(w2, id2, { file: JPEG })));
    check(burst.filter((r) => r.status === 200).length === 5 && w2.calls.length === 5 && w2.db.prepare('SELECT used_count FROM mcp_upload_tickets').get().used_count === 5, 'nine sent at the same moment: exactly five go through, never more'); }
  { const cases = [['expired', (w, id) => w.db.prepare("UPDATE mcp_upload_tickets SET created_at = datetime('now', '-11 minutes')").run()], ['revoked', (w) => w.db.prepare("UPDATE mcp_keys SET revoked_at = datetime('now')").run()], ['no longer an owner', (w) => w.db.prepare("UPDATE memberships SET role = 'sales' WHERE google_email = 'owner@x.co'").run()]];
    for (const [name, mut] of cases) { const w = world(); const id = await ticket(w); mut(w, id); const r = await send(w, id, { file: JPEG }); check(r.status === 403 && w.calls.length === 0 && w.db.prepare('SELECT used_count FROM mcp_upload_tickets').get().used_count === 0, `a ${name} ticket cannot send: refused, nothing passed on, no place used`); } }

  // ---- when the app's route fails, or refuses ----
  { const w = world(); const id = await ticket(w); w.reply.current = () => Response.json({ error: 'boom' }, { status: 500 }); const a = await send(w, id, { file: JPEG });
    w.reply.current = () => { throw new Error('network'); }; const b = await send(w, id, { file: JPEG }); w.reply.current = () => new Response('<html>oops</html>', { status: 502 }); const c = await send(w, id, { file: JPEG });
    const r = JSON.parse(w.db.prepare('SELECT results FROM mcp_upload_tickets').get().results);
    check([a, b, c].every((x) => x.status === 502) && r.length === 3 && r.every((x) => x.received === false && x.held.length === 0) && count(w, 'mcp_pending_links') === 0, 'a failing, throwing or non-JSON answer from the app is a plain 502 page, noted as not received, with nothing linked'); }
  { const w = world(); const id = await ticket(w); w.reply.current = () => Response.json({ status: 'stored', refusal: 'That supplier is not recognised.', message: 'ignored', pendingActionId: null }); const r = await send(w, id, { file: JPEG }), h = await html(r), e = JSON.parse(w.db.prepare('SELECT results FROM mcp_upload_tickets').get().results)[0];
    check(r.status === 200 && h.includes('That supplier is not recognised.') && e.refused === true && e.message === 'That supplier is not recognised.', 'a refusal from the app is shown as the app said it and noted as refused'); }
  { const w = world(); const id = await ticket(w); w.reply.current = () => Response.json({ status: 'stored', message: '<script>alert("x")</script> & <img src=x onerror=1>', pendingActionId: null }); const r = await send(w, id, { file: JPEG }), h = await html(r);
    check(!/<script/i.test(h) && !/<img/i.test(h) && h.includes('&lt;script&gt;') && h.includes('&amp;'), 'whatever the app\'s message contains is escaped before the person sees it'); }
  { const w = world(); const id = await ticket(w); w.reply.current = () => Response.json({ status: 'stored', message: 'x'.repeat(2000), pendingActionId: 999999 }); await send(w, id, { file: JPEG }); const e = JSON.parse(w.db.prepare('SELECT results FROM mcp_upload_tickets').get().results)[0];
    check(e.message.length <= 300 && e.held.length === 0 && count(w, 'mcp_pending_links') === 0, 'a very long message is cut, and a held-action id that does not exist is not linked'); }

  // ---- what the assistant that asked can see ----
  { const w = world(); const id = await ticket(w); const waiting = await up.ticketOutcome(w.env, 'k1', id); await send(w, id, { file: JPEG }); const got = await up.ticketOutcome(w.env, 'k1', id), stranger = await up.ticketOutcome(w.env, 'k2', id), bad = [await up.ticketOutcome(w.env, 'k1', 0), await up.ticketOutcome(w.env, 'k1', '1'), await up.ticketOutcome(w.env, 'k1', id + 9)];
    w.db.prepare("UPDATE mcp_upload_tickets SET created_at = datetime('now', '-30 minutes') WHERE id = ?").run(id); const later = await up.ticketOutcome(w.env, 'k1', id); const w2 = world(); const id2 = await ticket(w2); w2.db.prepare("UPDATE mcp_upload_tickets SET created_at = datetime('now', '-30 minutes')").run(); const exp = await up.ticketOutcome(w2.env, 'k1', id2);
    check(waiting.found && waiting.state === 'waiting' && waiting.filesLeft === 5 && got.state === 'received' && got.uploads.length === 1 && got.filesLeft === 4 && stranger.found === false && bad.every((x) => x.found === false) && later.state === 'received' && later.filesLeft === 0 && exp.state === 'expired', 'the assistant sees waiting, received (with what each file became) or expired, and ONLY for a ticket its own key made; another key, or a bad id, finds nothing'); }
}
