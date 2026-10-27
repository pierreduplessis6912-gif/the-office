// Proof that the customer contact tests are not decorative (a wrong number on a customer is a message sent to the wrong person). For each guard in the customer phone and email code (memory.ts, index.ts, debug.ts and migration 0003) it takes a COPY of the worker source, REMOVES that one guard, runs tools/mcp-changes.test.js against the copy and requires at least one check to FAIL.
// Run: NODE_PATH=worker/node_modules node --no-warnings tools/customer-contact-breakage.js
const fs = require('fs'), os = require('os'), path = require('path');
const root = path.join(__dirname, '..'), workerDir = path.join(root, 'worker');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-')), copy = path.join(tmp, 'worker');
fs.cpSync(workerDir, copy, { recursive: true, filter: (src) => !src.split(path.sep).includes('node_modules') });
fs.symlinkSync(path.join(workerDir, 'node_modules'), path.join(copy, 'node_modules'));   // the real packages, read only: the copy needs them to build
const files = { memory: path.join(copy, 'src', 'memory.ts'), index: path.join(copy, 'src', 'index.ts'), debug: path.join(copy, 'src', 'debug.ts'), migration: path.join(copy, 'migrations', '0003_customer_contact.sql') };
const originals = Object.fromEntries(Object.entries(files).map(([k, f]) => [k, fs.readFileSync(f, 'utf8')]));
const runs = { memory: require('./customer-contact.test.js'), index: require('./customer-contact-routes.test.js') };
const MUTATIONS = [
  // proven by tools/customer-contact.test.js
  ['memory', 'a stated phone number is not saved to the customer', 'await env.OFFICE_DB.prepare("UPDATE customers SET phone = ? WHERE id = ?").bind(normalizedValue, customerId).run();', ''],
  ['memory', 'a phone number that is not valid is saved to the column', 'if (parsed?.isValid()) {\n        normalizedValue = parsed.formatInternational();', 'if (true) {\n        normalizedValue = parsed!.formatInternational();'],
  ['memory', 'the phone is saved as it was said, not in international form', 'UPDATE customers SET phone = ? WHERE id = ?").bind(normalizedValue, customerId)', 'UPDATE customers SET phone = ? WHERE id = ?").bind(value, customerId)'],
  ['memory', 'a number is saved to every customer', 'UPDATE customers SET phone = ? WHERE id = ?").bind(normalizedValue, customerId)', 'UPDATE customers SET phone = ? WHERE ? IS NOT NULL").bind(normalizedValue, customerId)'],
  ['memory', 'something that is not an email is saved as one', 'if (/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(normalizedValue) && normalizedValue.length <= 254) {', 'if (true) {'],
  ['memory', 'an absurdly long email is saved', ' && normalizedValue.length <= 254) {', ') {'],
  ['memory', 'an email is saved with its capitals', 'normalizedValue = value.trim().toLowerCase();\n      if (/', 'normalizedValue = value.trim();\n      if (/'],
  ['memory', 'the note of what was said is no longer kept', 'INSERT INTO customer_facts (customer_id, key, value, source_transcript) VALUES (?, ?, ?, ?)', 'INSERT INTO customer_facts (customer_id, key, value, source_transcript) SELECT ?, ?, ?, ? WHERE 0'],
  ['debug', 'a merge no longer carries the phone and email across', 'COALESCE(phone, (SELECT phone FROM customers WHERE id = ?))', 'COALESCE((SELECT phone FROM customers WHERE id = ?), phone)'],
  ['migration', 'the backfill overwrites a number that is already there', 'ORDER BY f.id DESC LIMIT 1) WHERE phone IS NULL;', 'ORDER BY f.id DESC LIMIT 1);'],
  ['migration', 'the backfill takes the OLDEST number, not the latest', "f.key = 'phone_number' ORDER BY f.id DESC", "f.key = 'phone_number' ORDER BY f.id ASC"],
  ['migration', 'the backfill is dropped for emails', "UPDATE customers SET email = (SELECT f.value FROM customer_facts f WHERE f.customer_id = customers.id AND f.key = 'email' ORDER BY f.id DESC LIMIT 1) WHERE email IS NULL;", ''],
  // proven by tools/customer-contact-routes.test.js
  ['index', 'the edit route accepts a phone number that is not valid', 'if (!parsed?.isValid()) return Response.json({ error: "that is not a valid phone number" }, { status: 400 });', '', 'index'],
  ['index', 'the edit route accepts an email that is not one', 'else if (e.length > 254 || !/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(e)) return', 'else if (false) return', 'index'],
  ['index', 'the edit route accepts a phone of the wrong kind of value', 'if (typeof body.phone !== "string") return Response.json({ error: "phone must be text" }, { status: 400 });', '', 'index'],
  ['index', 'the edit route cannot clear a phone number', 'if (body.phone.trim() === "") phone = null;', 'if (false) phone = null;', 'index'],
  ['index', 'the edit route cannot clear an email', 'if (e === "") email = null;', 'if (false) email = null;', 'index'],
  ['index', 'the edit route saves the phone as typed', 'phone = parsed.formatInternational(); }', 'phone = body.phone.trim(); }', 'index'],
  ['index', 'the customer list cannot be searched by phone or email', 'OR address LIKE ?2 OR phone LIKE ?2 OR email LIKE ?2)', 'OR address LIKE ?2)', 'index'],
  ['index', 'the customer list leaves out the phone and email', 'SELECT id, name, address, phone, email, created_at FROM customers', 'SELECT id, name, address, NULL AS phone, NULL AS email, created_at FROM customers', 'index'],
];
(async () => {
  let missed = 0;
  const collect = () => { const list = []; return { list, check: (ok, label) => { if (!ok) list.push(label); } }; };
  const clearBuildCache = () => { for (const n of ['rm-poe', 'rm-auth']) delete require.cache[path.join(os.tmpdir(), `${n}-${process.pid}.js`)]; };   // the harness bundles the worker to a fixed file per process and Node caches it: cleared before every run so each mutation is really tested
  const reset = () => { for (const [k, f] of Object.entries(files)) fs.writeFileSync(f, originals[k]); };
  for (const k of Object.keys(runs)) { reset(); clearBuildCache(); const c = collect(); await runs[k]({ check: c.check, srcDir: path.join(copy, 'src') }); console.log(`baseline for ${k} (nothing removed): ${c.list.length} failing checks (must be 0)`); if (c.list.length) { missed++; console.log(c.list.join('\n')); } }
  for (const [k, name, from, to, which] of MUTATIONS) {
    reset();
    if (!originals[k].includes(from)) { console.log(`NOT APPLIED  ${name}: the text to remove was not found in ${k} (update this script)`); missed++; continue; }
    fs.writeFileSync(files[k], originals[k].replace(from, to));
    clearBuildCache();
    const c = collect();
    try { await runs[which || k]({ check: c.check, srcDir: path.join(copy, 'src') }); } catch (e) { c.list.push('threw: ' + String(e.message).slice(0, 100)); }
    if (c.list.length === 0) { missed++; console.log(`NOT CAUGHT   ${name}`); } else console.log(`caught (${String(c.list.length).padStart(2)})  ${name}`);
  }
  reset();
  console.log(missed === 0 ? `\nall ${MUTATIONS.length} customer contact guards are held by a test that fails when the guard is removed` : `\n${missed} problem(s): see above`);
  process.exit(missed === 0 ? 0 : 1);
})();
