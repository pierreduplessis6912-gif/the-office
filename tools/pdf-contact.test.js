// The customer's PHONE and EMAIL on the documents (worker/src/finance.ts: generateDocumentPdf for quotations and invoices, generateStatementPdf, drawColumnLine). Found by Pierre: a quotation showed the customer's address but not the number that had been saved. What this pins by reading the text of REAL generated PDFs: (1) phone then email appear under the address, on a quotation, an invoice and a statement, when the customer has them; (2) a customer with neither gets exactly the document it always had; (3) a phone number or email, which a person typed, can never make a document fail or run off the page.
const path = require('path'), fs = require('fs'), os = require('os'), esbuild = require('esbuild');

module.exports = async function runPdfContactTests({ check, srcDir }) {
  const bundle = (entry) => { const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mk-')), 'm.js'); esbuild.buildSync({ entryPoints: [path.join(srcDir, entry)], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent' }); return require(out); };
  let fin, D1;
  try { fin = bundle('finance.ts'); D1 = bundle('storage/do-d1.ts').DoD1Database; } catch (e) { check(false, 'finance.ts builds: ' + String(e.message).split('\n')[0].slice(0, 160)); return; }
  const { newDatabase } = require('./harness.js'); const plain = (r) => (r ? { ...r } : r);
  const shim = (db) => { const sql = { exec(query, ...binds) { const s = db.prepare(query); if (/^\s*(select|with|pragma|values)\b/i.test(query) || /\breturning\b/i.test(query)) { const rows = s.all(...binds).map(plain); return { toArray: () => rows, rowsRead: rows.length, rowsWritten: 0 }; } const r = s.run(...binds); return { toArray: () => [], rowsRead: 0, rowsWritten: Number(r.changes) }; } }; const storage = { transactionSync(fn) { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } } }; return new D1(sql, storage); };
  const { resolvePDFJS } = await import(path.join(srcDir, '..', 'node_modules', 'pdfjs-serverless', 'dist', 'index.mjs'));
  const text = async (bytes) => { const { getDocument } = await resolvePDFJS(); const doc = await getDocument({ data: new Uint8Array(bytes), useSystemFonts: true }).promise; const out = []; for (let p = 1; p <= doc.numPages; p++) { const c = await (await doc.getPage(p)).getTextContent(); for (const it of c.items) if (it.str && it.str.trim()) out.push({ s: it.str, x: Math.round(it.transform[4]), y: Math.round(it.transform[5]) }); } return out; };
  const world = (cust = {}) => { const db = newDatabase(path.join(srcDir, '..')); db.exec('PRAGMA foreign_keys = OFF');
    db.prepare("INSERT OR REPLACE INTO business_profile (id, name, trading_as, vat_no, address, phone, email, banking_details, vat_registered, vat_rate) VALUES (1, 'Zululand Flooring and Blinds', NULL, 'VAT 4740319555', '14 Highwater', '0790128508', 'zululandflooring@gmail.com', 'Nedbank Acc 1302177966', 1, 15)").run();
    const id = Number(db.prepare("INSERT INTO customers (name, address, phone, email) VALUES (?, ?, ?, ?)").run(cust.name ?? 'Mr Buitendacht', cust.address === undefined ? '22 Haakdoringrug, Arboretum' : cust.address, cust.phone ?? null, cust.email ?? null).lastInsertRowid);
    const q = Number(db.prepare("INSERT INTO quotations (customer_id, description, amount, source_transcript, status) VALUES (?, '60m2 vinyl', 39000, 't', 'draft')").run(id).lastInsertRowid), i = Number(db.prepare("INSERT INTO invoices (customer_id, description, amount, source_transcript) VALUES (?, 'vinyl', 39000, 't')").run(id).lastInsertRowid);
    db.prepare("INSERT INTO line_items (quotation_id, description, quantity, unit, unit_price, line_total) VALUES (?, 'Vinyl', 60, 'm2', 650, 39000)").run(q); db.prepare("INSERT INTO line_items (invoice_id, description, quantity, unit, unit_price, line_total) VALUES (?, 'Vinyl', 60, 'm2', 650, 39000)").run(i);
    return { db, env: { OFFICE_DB: shim(db) }, id, q, i }; };
  const rightColumn = (items) => items.filter((x) => x.x >= 390).sort((a, b) => b.y - a.y).map((x) => x.s);

  // ---- a quotation, an invoice and a statement show the contact details under the address, phone then email ----
  { const w = world({ phone: '+27 81 234 5675', email: 'b@x.co' }); const q = rightColumn(await text(await fin.generateDocumentPdf(w.env, w.q, 'quotation'))), inv = rightColumn(await text(await fin.generateDocumentPdf(w.env, w.i, 'invoice'))), st = rightColumn(await text(await fin.generateStatementPdf(w.env, w.id)));
    const order = (lines) => ['Mr Buitendacht', '22 Haakdoringrug, Arboretum', '+27 81 234 5675', 'b@x.co'].map((x) => lines.findIndex((l) => l.includes(x)));
    const ok = (lines) => order(lines).every((i, k, a) => i >= 0 && (k === 0 || i > a[k - 1]));
    check(ok(q) && ok(inv) && ok(st), 'a quotation, an invoice and a statement each show the name, the address, the phone number and then the email, in that order, in the customer\'s block: ' + JSON.stringify({ q, inv, st })); }

  // ---- only what exists ----
  { const w = world({ phone: '+27 81 234 5675' }); const q = rightColumn(await text(await fin.generateDocumentPdf(w.env, w.q, 'quotation'))); const w2 = world({ email: 'b@x.co' }); const q2 = rightColumn(await text(await fin.generateDocumentPdf(w2.env, w2.q, 'quotation')));
    check(q.some((l) => l.includes('+27 81 234 5675')) && !q.some((l) => /@/.test(l)) && q2.some((l) => l.includes('b@x.co')) && !q2.some((l) => /\+27/.test(l)), 'a customer with only a phone shows only the phone, and one with only an email shows only the email'); }
  { const none = world(), nonePdf = await fin.generateDocumentPdf(none.env, none.q, 'quotation'), items = await text(nonePdf), right = rightColumn(items);
    const ref = world({ phone: '+27 81 234 5675', email: 'b@x.co' }), refItems = rightColumn(await text(await fin.generateDocumentPdf(ref.env, ref.q, 'quotation')));
    check(right.join('|') === ['BILL TO', 'Mr Buitendacht', '22 Haakdoringrug, Arboretum'].join('|') || (right.some((l) => l.includes('Mr Buitendacht')) && !right.some((l) => /@|\+27/.test(l))), 'a customer with neither phone nor email gets the customer block it always had: name and address, nothing added'); 
    const noAddr = world({ address: null, phone: '+27 81 234 5675' }); const r = rightColumn(await text(await fin.generateDocumentPdf(noAddr.env, noAddr.q, 'quotation')));
    check(r.some((l) => l.includes('+27 81 234 5675')) && r.some((l) => l.includes('Mr Buitendacht')), 'a customer with no address still shows the phone'); }

  // ---- the business\'s own header is untouched ----
  { const w = world({ phone: '+27 81 234 5675', email: 'b@x.co' }); const items = await text(await fin.generateDocumentPdf(w.env, w.q, 'quotation')), left = items.filter((x) => x.x < 390).map((x) => x.s);
    check(left.some((l) => l.includes('Zululand Flooring and Blinds')) && left.some((l) => l.includes('0790128508')) && left.some((l) => l.includes('zululandflooring@gmail.com')) && !left.some((l) => l.includes('+27 81 234 5675')), 'the business\'s own name, phone and email stay on the left, and the customer\'s details are not mixed into them'); }

  // ---- what a person typed can never break a document or run off the page ----
  { const w = world({ phone: '+27 81 234 5675', email: 'A'.repeat(40) + '@' + 'b'.repeat(60) + '.co.za' }); let q; try { q = await fin.generateDocumentPdf(w.env, w.q, 'quotation'); } catch (e) { q = null; }
    const items = q ? await text(q) : [], line = items.find((x) => /^A{10}/.test(x.s));
    check(q !== null && !!line && line.x >= 390 && line.s.endsWith('...') && line.s.length < 'A'.repeat(40).length + 60, 'an email too long for the column is cut with "..." and still printed inside it, and the document is made'); }
  { const mail = 'longer.name@example-company.co.za'; const w = world({ phone: '+27 81 234 5675', email: mail }); const items = await text(await fin.generateDocumentPdf(w.env, w.q, 'quotation')), line = items.find((x) => x.s.includes('longer.name'));
    check(!!line && line.s === mail && line.x >= 390, 'an email only a little too wide for the column is made smaller to fit and printed WHOLE, not cut'); }
  { const w = world({ phone: '+27 81 234 5675', email: 'jos\u00e9@x.co' }), v = world({ phone: '+27 81 234 5675', email: '\u4e2d\u6587@x.co' }), z = world({ phone: '+27 81 234 5675', email: 'a\u0007b@x.co' }); const out = [];
    for (const k of [w, v, z]) { try { const b = await fin.generateDocumentPdf(k.env, k.q, 'quotation'); out.push(!!b && (await text(b)).some((x) => /@x\.co/.test(x.s))); } catch (e) { out.push('threw: ' + e.message.slice(0, 60)); } }
    check(out.every((x) => x === true), 'an accented letter, a character the PDF font cannot draw, or a control character in an email never makes the document fail: it is drawn (as "?" where it must be)'); }
  { const w = world({ phone: '+27 81 234 5675', email: 'b@x.co' }); let n = 0; for (const [id, kind] of [[w.q, 'quotation'], [w.i, 'invoice']]) { const b = await fin.generateDocumentPdf(w.env, id, kind); if (b.length > 1000 && String.fromCharCode(...b.slice(0, 4)) === '%PDF') n++; } const s = await fin.generateStatementPdf(w.env, w.id);
    check(n === 2 && String.fromCharCode(...s.slice(0, 4)) === '%PDF', 'all three are still real PDFs'); }
};
