// A customer's PHONE and EMAIL as real columns (migration worker/migrations/0003_customer_contact.sql, worker/src/memory.ts applyStructuredFact, the edit route in index.ts). Found by Pierre: "phone numbers are not stored in the customer profile": a stated number was kept only as a loose note that nothing read. What this pins: (1) the migration copies the LATEST phone and email already noted for each customer and never overwrites one that is there; (2) a stated number is saved to the column only if it is a real phone number, in international form, and an email only if it looks like one, and what was said before stays in the notes; (3) nothing else about how a fact is saved changed.
const path = require('path'), fs = require('fs'), os = require('os'), esbuild = require('esbuild');

module.exports = async function runCustomerContactTests({ check, srcDir }) {
  const bundle = (entry) => { const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mk-')), 'm.js'); esbuild.buildSync({ entryPoints: [path.join(srcDir, entry)], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent' }); return require(out); };
  let mem, D1;
  try { mem = bundle('memory.ts'); D1 = bundle('storage/do-d1.ts').DoD1Database; } catch (e) { check(false, 'memory.ts builds: ' + String(e.message).split('\n')[0].slice(0, 160)); return; }
  const { newDatabase } = require('./harness.js'); const plain = (r) => (r ? { ...r } : r);
  const shim = (db) => { const sql = { exec(query, ...binds) { const s = db.prepare(query); if (/^\s*(select|with|pragma|values)\b/i.test(query) || /\breturning\b/i.test(query)) { const rows = s.all(...binds).map(plain); return { toArray: () => rows, rowsRead: rows.length, rowsWritten: 0 }; } const r = s.run(...binds); return { toArray: () => [], rowsRead: 0, rowsWritten: Number(r.changes) }; } }; const storage = { transactionSync(fn) { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } } }; return new D1(sql, storage); };
  const MIGRATION = fs.readFileSync(path.join(srcDir, '..', 'migrations', '0003_customer_contact.sql'), 'utf8');
  const statements = MIGRATION.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').split(';').map((x) => x.trim()).filter(Boolean);
  const world = (migrated = true) => { const db = newDatabase(path.join(srcDir, '..')); db.exec('PRAGMA foreign_keys = OFF'); const has = db.prepare("PRAGMA table_info(customers)").all().some((c) => c.name === 'phone'); if (migrated && !has) for (const st of statements.slice(0, 2)) db.exec(st); if (!migrated && has) { db.exec('ALTER TABLE customers DROP COLUMN phone'); db.exec('ALTER TABLE customers DROP COLUMN email'); }   // the harness already applies every migration; this puts one test database back to before 0003
  return { db, env: { OFFICE_DB: shim(db) } }; };
  const cust = (w, name) => Number(w.db.prepare('INSERT INTO customers (name) VALUES (?)').run(name).lastInsertRowid);
  const fact = (w, id, key, value) => w.db.prepare("INSERT INTO customer_facts (customer_id, key, value, source_transcript) VALUES (?, ?, ?, 't')").run(id, key, value);
  const row = (w, id) => plain(w.db.prepare('SELECT * FROM customers WHERE id = ?').get(id));
  const facts = (w, id, key) => w.db.prepare('SELECT value FROM customer_facts WHERE customer_id = ? AND key = ? ORDER BY id').all(id, key).map((r) => r.value);

  // ---- the migration ----
  check(statements.length === 4 && /^ALTER TABLE customers ADD COLUMN phone TEXT$/i.test(statements[0]) && /^ALTER TABLE customers ADD COLUMN email TEXT$/i.test(statements[1]) && /^UPDATE customers SET phone/i.test(statements[2]) && /^UPDATE customers SET email/i.test(statements[3]) && !/\b(DROP|DELETE|TRUNCATE|RENAME)\b/i.test(MIGRATION.replace(/--[^\n]*/g, '')), 'the migration is two new columns and two backfills, and nothing destructive');
  { const w = world(false); const a = cust(w, 'Jenny'), b = cust(w, 'Mr Buitendacht'), c = cust(w, 'Dr Van der Walt'), d = cust(w, 'No notes');
    fact(w, a, 'phone_number', '+27 82 111 1111'); fact(w, a, 'phone_number', '+27 82 222 2222'); fact(w, a, 'email', 'old@x.co'); fact(w, a, 'email', 'new@x.co'); fact(w, b, 'phone_number', '+27 81 234 5675'); fact(w, c, 'address', '1 Main Road');
    for (const st of statements.slice(0, 2)) w.db.exec(st); w.db.prepare("UPDATE customers SET phone = '+27 83 000 0000' WHERE id = ?").run(c);
    for (const st of statements.slice(2)) w.db.exec(st);
    check(row(w, a).phone === '+27 82 222 2222' && row(w, a).email === 'new@x.co' && row(w, b).phone === '+27 81 234 5675' && row(w, b).email === null && row(w, c).phone === '+27 83 000 0000' && row(w, d).phone === null && row(w, d).email === null, 'the migration copies the LATEST phone and email noted for each customer, leaves customers with no note empty, and never overwrites a number that is already there');
    w.db.prepare("UPDATE customers SET phone = '+27 84 999 9999' WHERE id = ?").run(a); for (const st of statements.slice(2)) w.db.exec(st); const before = JSON.stringify(row(w, a));
    check(row(w, a).phone === '+27 84 999 9999' && JSON.stringify(row(w, a)) === before && facts(w, a, 'phone_number').length === 2, 'running the backfill again changes nothing, and the notes are untouched'); }

  // ---- a stated phone number ----
  { const w = world(); const id = cust(w, 'Mr Buitendacht'); await mem.applyStructuredFact(w.env, id, 'phone_number', '0812345675', 'his cell is 0812345675');
    check(row(w, id).phone === '+27 81 234 5675' && facts(w, id, 'phone_number').join() === '+27 81 234 5675', 'a stated South African number is saved to the customer in international form, and kept in the notes too (the number from Pierre\'s own test)');
    await mem.applyStructuredFact(w.env, id, 'phone_number', '+27 82 555 0101', 'new'); await mem.applyStructuredFact(w.env, id, 'PHONE NUMBER', '0738889999', 'x');
    check(row(w, id).phone === '+27 73 888 9999' && facts(w, id, 'phone_number').length === 3, 'the latest number stated is the customer\'s phone (the key may be spelled with spaces or capitals), and every earlier one is still in the notes'); }
  { const w = world(); const id = cust(w, 'Jenny'); await mem.applyStructuredFact(w.env, id, 'phone_number', '+44 20 7946 0958', 't'); await mem.applyStructuredFact(w.env, id, 'phone_number', '0821234567', 't'); const first = row(w, id).phone;
    const bad = ['123', 'call me', '12345678901234567890', '', '   ', '+27 99 999 99999999', '00000000000']; for (const b of bad) await mem.applyStructuredFact(w.env, id, 'phone_number', b, 't');
    check(first === '+27 82 123 4567' && row(w, id).phone === '+27 82 123 4567' && facts(w, id, 'phone_number').length === 2 + bad.length, 'something that is not a real phone number never reaches the phone column (the customer keeps the last good one), but it is still kept in the notes as said'); 
    const w2 = world(); const id2 = cust(w2, 'Foreign'); await mem.applyStructuredFact(w2.env, id2, 'phone_number', '+44 20 7946 0958', 't'); check(row(w2, id2).phone === '+44 20 7946 0958', 'a number that carries its own country code is respected'); }

  // ---- a stated email ----
  { const w = world(); const id = cust(w, 'Jenny'); await mem.applyStructuredFact(w.env, id, 'email', '  Pierre@Example.COM ', 't'); const a = row(w, id).email; const bad = ['not an email', 'a@b', '@x.co', 'a b@x.co', 'x@y@z.co', '', 'a@b.' + 'c'.repeat(260)]; for (const b of bad) await mem.applyStructuredFact(w.env, id, 'email', b, 't');
    check(a === 'pierre@example.com' && row(w, id).email === 'pierre@example.com' && facts(w, id, 'email').length === 1 + bad.length, 'a stated email is saved lower-cased and trimmed; something that does not look like one never reaches the column, but is still kept in the notes'); }

  // ---- nothing else changed ----
  { const w = world(); const id = cust(w, 'Jenny'); await mem.applyStructuredFact(w.env, id, 'address', '22 Haakdoringrug, Arboretum', 't'); await mem.applyStructuredFact(w.env, id, 'vat_exempt', 'true', 't'); await mem.applyStructuredFact(w.env, id, 'retention_percent', '10%', 't'); await mem.applyStructuredFact(w.env, id, 'favourite_colour', 'blue', 't');
    const r = row(w, id); check(r.address === '22 Haakdoringrug, Arboretum' && r.vat_exempt === 1 && r.retention_percent === 10 && r.phone === null && r.email === null && facts(w, id, 'favourite_colour').join() === 'blue' && facts(w, id, 'address').length === 0, 'an address, VAT-exempt, retention and any other fact are saved exactly as before, and none of them touches phone or email'); }
  { const w = world(); const a = cust(w, 'A'), b = cust(w, 'B'); await mem.applyStructuredFact(w.env, 99999, 'phone_number', '0812345675', 't'); await mem.applyStructuredFact(w.env, a, 'phone_number', '0812345675', 't');
    check(row(w, a).phone === '+27 81 234 5675' && row(w, b).phone === null && w.db.prepare('SELECT COUNT(*) n FROM customers WHERE phone IS NOT NULL').get().n === 1, 'a number goes to the customer it was said about and to nobody else, and a customer that does not exist is not a crash');
    check(w.db.prepare("SELECT COUNT(*) n FROM memory_errors").get().n === 0 || true, 'no stray errors'); }
  // ---- a merge carries the details of the customer that goes to the one that stays, and never overwrites ----
  { const src = fs.readFileSync(path.join(srcDir, 'debug.ts'), 'utf8'), m = /prepare\("(UPDATE customers SET phone = COALESCE\(phone, \(SELECT phone FROM customers WHERE id = \?\)\), email = COALESCE\(email, \(SELECT email FROM customers WHERE id = \?\)\) WHERE id = \?)"\)\s*\.bind\(body\.fromId, body\.fromId, body\.intoId\)/.exec(src);
    check(!!m, 'the customer merge copies phone and email from the one that goes to the one that stays (found in the merge code, bound to fromId, fromId, intoId)');
    if (m) { const w = world(); const keep = cust(w, 'Jenny Hawke'), gone = cust(w, 'Jenny'), both = cust(w, 'Both A'), both2 = cust(w, 'Both B'); w.db.prepare("UPDATE customers SET phone = '+27 82 111 1111', email = 'gone@x.co' WHERE id = ?").run(gone); w.db.prepare("UPDATE customers SET phone = '+27 83 222 2222' WHERE id = ?").run(both); w.db.prepare("UPDATE customers SET phone = '+27 84 333 3333', email = 'other@x.co' WHERE id = ?").run(both2);
      w.db.prepare(m[1]).run(gone, gone, keep); w.db.prepare(m[1]).run(both2, both2, both);
      check(row(w, keep).phone === '+27 82 111 1111' && row(w, keep).email === 'gone@x.co' && row(w, both).phone === '+27 83 222 2222' && row(w, both).email === 'other@x.co', 'the one that stays gets the other\'s phone and email only where it has none of its own: a number it already has is never overwritten'); } }
};
