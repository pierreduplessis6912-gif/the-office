// Engine foundation schema (migration 0004, branch engine-phase1). TESTS FIRST: these say what the database itself must refuse, before the migration exists. The engine's facts are recorded once and never
// edited (documents, lines, money movements, allocations, reversals, events), money and quantities are INTEGERS (minor units, thousandths: SQLite would otherwise happily store 1.5 or '100' in an INTEGER column),
// every relationship is a real foreign key, and the tables must restore: a restore wipes every live table and refills them parents-first, so the tables may not form a foreign-key cycle.
// What is deliberately NOT here: triggers. The migration machinery splits a step on ';' and a test refuses any step containing DELETE, so append-only triggers cannot be a migration; immutability and conservation are
// enforced at the engine's single write path and verified by tools/engine-ledger.test.js (and an integrity verifier), and that trade-off is recorded in docs/decisions.
const fs = require('fs'), path = require('path');
const kit = require('./engine-kit.js');

module.exports = kit.guard('engine schema', async ({ check }) => {
  const file = path.join(kit.workerDir, 'migrations', '0004_engine_foundation.sql');
  const TABLES = ['eng_config', 'eng_event', 'eng_party', 'eng_party_role', 'eng_draft', 'eng_document', 'eng_document_line', 'eng_document_number', 'eng_money_movement', 'eng_allocation', 'eng_reversal', 'eng_interpretation', 'eng_observation'];

  // ---- the migration obeys the platform's own rules ------------------------------------------------------------------------------------------------------------------------------------------
  const exists = fs.existsSync(file);
  check(exists, 'worker/migrations/0004_engine_foundation.sql exists');
  if (exists) {
    const text = fs.readFileSync(file, 'utf8');
    const statements = text.replace(/--[^\n]*/g, '').split(';').map((s) => s.trim()).filter(Boolean);
    check(statements.length > 0 && statements.every((s) => /^CREATE (UNIQUE )?(TABLE|INDEX) IF NOT EXISTS /i.test(s)), 'every step is an additive CREATE TABLE / CREATE INDEX IF NOT EXISTS (the README rule)');
    check(!/\b(DROP|DELETE|TRUNCATE|RENAME)\b/i.test(text), 'no step contains DROP, DELETE, TRUNCATE or RENAME, not even in a comment (schema.test.js refuses them)');
    check(!/\bTRIGGER\b/i.test(text), 'no trigger: the runner splits steps on ";" and a trigger body has semicolons');
  }

  const w = kit.makeWorld();
  const tables = w.tables();
  for (const t of TABLES) check(tables.includes(t), `table ${t} exists in a fresh business`);
  if (!TABLES.every((t) => tables.includes(t))) return;   // nothing below means anything without the tables

  // ---- the database refuses what the engine must never record ----------------------------------------------------------------------------------------------------------------------------------
  const db = w.db;
  const refuses = (fn) => { try { fn(); return false; } catch (e) { return /constraint|FOREIGN KEY|UNIQUE|CHECK|NOT NULL/i.test(String(e && e.message)); } };
  const ev = (type = 'test', proposal = null) => Number(db.prepare("INSERT INTO eng_event (type, proposal_id) VALUES (?, ?) RETURNING id").get(type, proposal).id);
  const party = (name = 'Mokoena') => Number(db.prepare("INSERT INTO eng_party (kind, name, event_id) VALUES ('person', ?, ?) RETURNING id").get(name, ev('party.created')).id);
  const doc = (p, kind = 'invoice', direction = 'sell') => Number(db.prepare("INSERT INTO eng_document (kind, direction, party_id, currency, issued_on, event_id) VALUES (?, ?, ?, 'ZAR', '2026-11-01', ?) RETURNING id").get(kind, direction, p, ev('document.issued')).id);
  const line = (d, no = 1, qty = 1000, price = 10000, tax = 1500) => db.prepare('INSERT INTO eng_document_line (document_id, line_no, description, quantity_milli, unit, unit_price_minor, tax_bp) VALUES (?, ?, ?, ?, ?, ?, ?)').run(d, no, 'Vinyl plank', qty, 'm2', price, tax);
  const move = (p, amount = 50000, direction = 'in', currency = 'ZAR') => db.prepare('INSERT INTO eng_money_movement (direction, party_id, amount_minor, currency, occurred_on, method, event_id) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id').get(direction, p, amount, currency, '2026-11-02', 'eft', ev('payment.recorded'));
  const alloc = (m, d, amount) => db.prepare('INSERT INTO eng_allocation (movement_id, document_id, amount_minor, event_id) VALUES (?, ?, ?, ?)').run(m, d, amount, ev('payment.allocated'));

  const p = party(), d = doc(p);
  check(!refuses(() => line(d, 1)), 'a valid line is accepted (1.000 unit at R100.00, 15% tax)');
  check(!refuses(() => line(d, 2, 2500, 0, 0)), 'a free line (unit price zero) is accepted: an explicit zero price is legitimate');
  check(refuses(() => line(d, 1)), 'two lines may not share a line number in one document');
  check(refuses(() => line(d, 3, 0)), 'a line of zero quantity is refused');
  check(refuses(() => line(d, 3, 1.5)), 'a quantity that is not a whole number of thousandths (1.5) is refused: no floating point');
  check(refuses(() => line(d, 3, 'abc')), 'a quantity that is not a number at all is refused (text that merely LOOKS like a whole number is coerced by SQLite before any check sees it, so the engine\'s own write path must reject text: tools/engine-ledger.test.js)');
  check(refuses(() => line(d, 3, 1000, -1)), 'a negative unit price is refused: corrections are reversals, never negative lines');
  check(refuses(() => line(d, 3, 1000, 10.5)), 'a price that is not whole minor units is refused');
  check(refuses(() => line(d, 3, 1000, 100, 10001)), 'tax above 100% (10,000 basis points) is refused');
  check(refuses(() => line(99999, 4)), 'a line for a document that does not exist is refused (foreign key)');
  check(refuses(() => db.prepare("INSERT INTO eng_document (kind, direction, party_id, currency, issued_on, event_id) VALUES ('invoice', 'sideways', ?, 'ZAR', '2026-11-01', ?)").run(p, ev())), 'a document direction other than sell or buy is refused');
  check(refuses(() => db.prepare("INSERT INTO eng_document (kind, direction, party_id, currency, issued_on, event_id) VALUES ('invoice', 'sell', ?, 'RAND', '2026-11-01', ?)").run(p, ev())), 'a currency that is not a 3-letter code is refused');
  check(refuses(() => db.prepare("INSERT INTO eng_party (kind, name, event_id) VALUES ('robot', 'X', ?)").run(ev())), 'a party kind other than person or organisation is refused');
  check(refuses(() => db.prepare("INSERT INTO eng_party (kind, name, event_id) VALUES ('person', '   ', ?)").run(ev())), 'a party with a blank name is refused');

  const m = Number(move(p, 50000).id);
  check(refuses(() => move(p, 0)), 'a money movement of zero is refused');
  check(refuses(() => move(p, -500)), 'a negative money movement is refused');
  check(refuses(() => move(p, 1.5)), 'a money movement that is not whole minor units is refused');
  check(refuses(() => move(p, 'abc')), 'a money movement that is not a number at all is refused');
  check(refuses(() => move(p, 500, 'sideways')), 'a movement direction other than in or out is refused');
  check(refuses(() => move(p, 500, 'in', 'R')), 'a movement currency that is not a 3-letter code is refused');
  check(!refuses(() => alloc(m, d, 20000)), 'an allocation of part of a movement to a document is accepted');
  check(refuses(() => alloc(m, d, 0)), 'an allocation of zero is refused');
  check(refuses(() => alloc(m, d, 2.5)), 'an allocation that is not whole minor units is refused');
  check(refuses(() => alloc(99999, d, 100)), 'an allocation of a movement that does not exist is refused (foreign key)');
  check(refuses(() => alloc(m, 99999, 100)), 'an allocation to a document that does not exist is refused (foreign key)');

  // reversals: exactly one target, each target once, a reason always
  const rev = (cols) => db.prepare(`INSERT INTO eng_reversal (${Object.keys(cols).join(', ')}, reason, event_id) VALUES (${Object.keys(cols).map(() => '?').join(', ')}, ?, ?)`).run(...Object.values(cols), 'wrong customer', ev('correction'));
  check(refuses(() => db.prepare("INSERT INTO eng_reversal (reason, event_id) VALUES ('x', ?)").run(ev())), 'a reversal of nothing is refused');
  check(refuses(() => db.prepare("INSERT INTO eng_reversal (movement_id, document_id, reason, event_id) VALUES (?, ?, 'x', ?)").run(m, d, ev())), 'a reversal of two things at once is refused');
  check(refuses(() => db.prepare("INSERT INTO eng_reversal (movement_id, reason, event_id) VALUES (?, '  ', ?)").run(m, ev())), 'a reversal without a reason is refused');
  const m2 = Number(move(p, 700).id);
  check(!refuses(() => rev({ movement_id: m2 })), 'a movement can be reversed');
  check(refuses(() => rev({ movement_id: m2 })), 'the same movement cannot be reversed twice');

  // events: an approved proposal executes at most once (idempotency); the facts it records may be several; events with no proposal are unconstrained
  db.prepare("INSERT INTO pending_actions (id, type, payload, source_transcript, status) VALUES (7, 'payment', '{}', 'x', 'confirmed')").run();
  check(!refuses(() => ev('operation.executed', 7)), 'an approved proposal can be recorded as executed');
  check(refuses(() => ev('operation.executed', 7)), 'the same proposal cannot be recorded as executed twice: executing twice cannot record twice');
  check(!refuses(() => { ev('payment.recorded', 7); ev('payment.allocated', 7); ev('payment.allocated', 7); }), 'but the facts one proposal records may be several: one payment can settle two invoices');
  check(!refuses(() => { ev('note'); ev('note'); }), 'events with no proposal are not constrained against each other');
  check(refuses(() => db.prepare("INSERT INTO eng_event (type, capture_id) VALUES ('x', 99999)").run()), 'an event pointing at a capture that does not exist is refused (foreign key)');
  check(refuses(() => db.prepare("INSERT INTO eng_event (type) VALUES ('')").run()), 'an event with no type is refused');

  // numbering: unique per kind, one number per document
  const numberedDoc = doc(p);
  check(!refuses(() => db.prepare("INSERT INTO eng_document_number (kind, number, document_id) VALUES ('invoice', 1, ?)").run(numberedDoc)), 'a document can be given the next invoice number');
  check(refuses(() => db.prepare("INSERT INTO eng_document_number (kind, number, document_id) VALUES ('invoice', 1, ?)").run(doc(p))), 'an invoice number cannot be used twice');
  check(refuses(() => db.prepare("INSERT INTO eng_document_number (kind, number, document_id) VALUES ('invoice', 2, ?)").run(numberedDoc)), 'a document cannot have two numbers');
  check(!refuses(() => db.prepare("INSERT INTO eng_document_number (kind, number, document_id) VALUES ('quotation', 1, ?)").run(doc(p, 'quotation'))), 'each kind numbers independently');

  // ---- the tables restore: no foreign-key cycle, parents first -----------------------------------------------------------------------------------------------------------------------------------
  const mig = kit.bundle('migration.ts', 'migration');
  const order = await mig.tablesParentsFirst(w.env, await mig.listTables(w.env));
  const edges = [];
  for (const t of TABLES) for (const fk of db.prepare(`PRAGMA foreign_key_list(${t})`).all()) edges.push([fk.table, t]);
  const pos = (t) => order.indexOf(t);
  check(edges.length >= 12 && edges.every(([parent, child]) => parent === child || pos(parent) < pos(child)), `restore orders every engine table after the tables it points at (${edges.length} relationships, no cycle)`);
  check(!edges.some(([parent, child]) => parent === child), 'no engine table points at itself (restore orders parents first and a self-reference is a cycle in disguise)');
});

if (require.main === module) kit.standalone(module.exports);
