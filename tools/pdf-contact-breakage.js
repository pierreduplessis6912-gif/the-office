// Proof that the document contact tests are not decorative (a document goes to a customer). For each guard in worker/src/finance.ts (the customer block of the documents) it takes a COPY of the worker source, REMOVES that one guard, runs tools/mcp-changes.test.js against the copy and requires at least one check to FAIL.
// Run: NODE_PATH=worker/node_modules node --no-warnings tools/pdf-contact-breakage.js
const fs = require('fs'), os = require('os'), path = require('path');
const root = path.join(__dirname, '..'), workerDir = path.join(root, 'worker');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pcb-')), copy = path.join(tmp, 'worker');
fs.cpSync(workerDir, copy, { recursive: true, filter: (src) => !src.split(path.sep).includes('node_modules') });
fs.symlinkSync(path.join(workerDir, 'node_modules'), path.join(copy, 'node_modules'));   // the real packages, read only: the copy needs them to build
const target = path.join(copy, 'src', 'finance.ts'), original = fs.readFileSync(target, 'utf8');
const run = require('./pdf-contact.test.js');
const MUTATIONS = [
  ['a document does not load the customer\'s phone and email', 'c.phone as customer_phone, c.email as customer_email,', 'NULL as customer_phone, NULL as customer_email,'],
  ['a quotation or invoice does not draw the phone and email', 'for (const contact of [doc.customer_phone, doc.customer_email]) {', 'for (const contact of [] as Array<string | null>) {'],
  ['the email is drawn before the phone', 'for (const contact of [doc.customer_phone, doc.customer_email]) {', 'for (const contact of [doc.customer_email, doc.customer_phone]) {'],
  ['a statement does not load the phone and email', 'SELECT name, address, phone, email FROM customers WHERE id = ?', 'SELECT name, address, NULL AS phone, NULL AS email FROM customers WHERE id = ?'],
  ['a statement does not draw the phone and email', 'for (const contact of [customer.phone, customer.email]) {', 'for (const contact of [] as Array<string | null>) {'],
  ['the contact lines are drawn in the business\'s own column', 'drawColumnLine(page, font, contact, right, yRight, 595.28 - 50 - right);', 'drawColumnLine(page, font, contact, left, yRight, 595.28 - 50 - right);'],
  ['a long line is not made smaller', 'while (size > 7 && font.widthOfTextAtSize(line, size) > maxWidth) size -= 0.5;', ''],
  ['a line too long for the column is not cut', 'if (font.widthOfTextAtSize(line, size) > maxWidth) {\n    while', 'if (false) {\n    while'],
  ['the column is as wide as the whole page', 'drawColumnLine(page, font, contact, right, yRight, 595.28 - 50 - right);', 'drawColumnLine(page, font, contact, right, yRight, 595.28);'],
  ['a character the PDF font cannot draw is not replaced', 'let line = text.replace(/[^\\x20-\\x7e\\xa0-\\xff]/g, "?").trim();', 'let line = text.trim();'],
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
  console.log(missed === 0 ? `\nall ${MUTATIONS.length} document contact guards are held by a test that fails when the guard is removed` : `\n${missed} problem(s): see above`);
  process.exit(missed === 0 ? 0 : 1);
})();
