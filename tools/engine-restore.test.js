// Engine tables and recovery (branch engine-phase1). TESTS FIRST for what the migration must never cost the business: a restore must bring the engine's tables back EXACTLY (rows, relationships, numbering, the way the
// engine reads them), and a business that has taken the migration must still be recoverable to the moment BEFORE it. Restore wipes every live table and refills parents-first, so this is where an engine table that
// could not be wiped, refilled or ordered would show itself. The recovery gate (a rehearsed rollback on the real platform, and the owner's acceptance) is NOT closed by this suite: it proves the logic on the
// harness; the same rehearsal on real Cloudflare is a separate, approved step.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const kit = require('./engine-kit.js');

module.exports = kit.guard('engine restore', async ({ check }) => {
  const eng = kit.loadEngine();
  check(Boolean(eng), 'the engine module builds');
  if (!eng) return;
  const { facts, ledger, drafts } = eng;
  const bk = kit.bundle('backup.ts', 'backup');
  const CTX = { actorEmail: 'accountant@example.com', contract: 'test', contractVersion: 1 };
  const migration = fs.readFileSync(path.join(kit.workerDir, 'migrations', '0004_engine_foundation.sql'), 'utf8');
  const ENG = ['eng_config', 'eng_event', 'eng_party', 'eng_party_role', 'eng_draft', 'eng_document', 'eng_document_line', 'eng_document_number', 'eng_money_movement', 'eng_allocation', 'eng_reversal', 'eng_interpretation', 'eng_observation'];
  const fingerprint = (db, tables) => crypto.createHash('sha256').update(tables.map((t) => t + JSON.stringify(db.prepare(`SELECT * FROM "${t}" ORDER BY rowid`).all())).join('|')).digest('hex');
  const legacyTables = (w) => w.tables().filter((t) => !t.startsWith('eng_') && t !== 'object_meta');

  // a business with a real history in the engine: customers, invoices, a payment, a correction, a draft, an observation
  const populate = async (w) => {
    w.configure({ mode: 'engine', available: kit.ALL_CAPABILITIES });
    const a = (await facts.recordParty(w.env, { kind: 'person', name: 'Mokoena', roles: ['customer'] }, CTX)).id;
    const b = (await facts.recordParty(w.env, { kind: 'organisation', name: 'Patel Builders', roles: ['customer'] }, CTX)).id;
    const L = (price, d) => [{ description: d, quantityMilli: 2000, unit: 'm2', unitPriceMinor: price, taxBp: 1500 }];
    const i1 = await facts.recordDocument(w.env, { kind: 'invoice', direction: 'sell', partyId: a, currency: 'ZAR', issuedOn: '2026-10-01', lines: L(50000, 'Vinyl plank') }, CTX);
    const i2 = await facts.recordDocument(w.env, { kind: 'invoice', direction: 'sell', partyId: b, currency: 'ZAR', issuedOn: '2026-10-02', lines: L(20000, 'Skirting') }, CTX);
    const wrong = await facts.recordPayment(w.env, { direction: 'in', partyId: b, amountMinor: 30000, currency: 'ZAR', occurredOn: '2026-10-20', allocations: [{ documentId: i1.id, amountMinor: 30000 }] }, CTX);
    await facts.correctMovement(w.env, { movementId: wrong.movementId, reason: 'wrong customer', replacement: { partyId: a, allocations: [{ documentId: i1.id, amountMinor: 30000 }] } }, CTX);
    const d = await drafts.createDraft(w.env, { kind: 'invoice', direction: 'sell', partyId: a }, CTX);
    await drafts.saveDraft(w.env, d.id, { expectedVersion: 1, payload: { currency: 'ZAR', issuedOn: '2026-11-01', lines: L(10000, 'Fitting') } }, CTX);
    const cap = Number(w.db.prepare("INSERT INTO captures (raw_text, source) VALUES ('can you book a skip?', 'text') RETURNING id").get().id);
    w.db.prepare("INSERT INTO eng_observation (capture_id, kind, note) VALUES (?, 'unsupported', 'book a skip')").run(cap);
    return { a, b, i1, i2 };
  };

  // ---- RESTORE brings the engine back exactly -------------------------------------------------------------------------------------------------------------------------------------------------------
  const w = kit.makeWorld({ backups: true });
  const ids = await populate(w);
  check((await eng.verifyIntegrity(w.env)).ok, 'the business built through the engine verifies clean before the snapshot');
  const engineBefore = fingerprint(w.db, ENG), legacyBefore = fingerprint(w.db, legacyTables(w));
  const accountBefore = JSON.stringify(await ledger.outstandingForParty(w.env, ids.a));
  const snap = await bk.takeSnapshot(w.env, new Date('2026-11-01T03:00:00Z'));
  check(snap && snap.complete === true && ENG.every((t) => snap.tables.some((x) => x.name === t)), `a snapshot is taken, complete, and lists all ${ENG.length} engine tables (${snap.tables.length} tables in all)`);
  // damage that includes what a careless fix might do: remove facts, change a fact, add junk
  w.db.exec('PRAGMA foreign_keys = OFF');
  for (const t of ['eng_reversal', 'eng_allocation', 'eng_money_movement']) w.db.exec(`DELETE FROM ${t}`);
  w.db.prepare('UPDATE eng_document_line SET unit_price_minor = 1').run();
  w.db.prepare("INSERT INTO eng_event (type) VALUES ('junk')").run();
  w.db.prepare("INSERT INTO eng_draft (kind, direction, payload_json) VALUES ('invoice', 'sell', '{}')").run();
  w.db.exec('PRAGMA foreign_keys = ON');
  check(!(await eng.verifyIntegrity(w.env)).ok || fingerprint(w.db, ENG) !== engineBefore, 'after the damage the business is visibly not what it was');
  const report = await bk.restoreSnapshot(w.env, snap.name, 'eng-a');
  check(report.ok === true && report.differences.length === 0, `the restore reports ok with no differences (${report.tablesRestored} tables, ${report.rowsRestored} rows)`);
  check(fingerprint(w.db, ENG) === engineBefore, 'every engine table is back EXACTLY: rows, ids, relationships, in order');
  check(fingerprint(w.db, legacyTables(w)) === legacyBefore, 'and the legacy tables are untouched by it');
  check((await eng.verifyIntegrity(w.env)).ok, 'the restored business verifies clean: facts match their event snapshots, nothing over-allocated, numbering has no hole');
  check(JSON.stringify(await ledger.outstandingForParty(w.env, ids.a)) === accountBefore, 'what the customer owes is derived to the same answer after the restore');
  check(w.db.prepare('PRAGMA foreign_key_check').all().length === 0, 'and no relationship points at nothing');
  const next = await facts.recordDocument(w.env, { kind: 'invoice', direction: 'sell', partyId: ids.a, currency: 'ZAR', issuedOn: '2026-11-02', lines: [{ description: 'After restore', quantityMilli: 1000, unitPriceMinor: 100, taxBp: 0 }] }, CTX);
  check(next.number === 3 && next.id > ids.i2.id, 'the business carries on: the next invoice is number 3 and ids continue from where they were, no clash');

  // ---- ROLLBACK: a business that took the migration can be taken back to the moment BEFORE it, and forward again ------------------------------------------------------------------------------------
  const v = kit.makeWorld({ backups: true });
  v.db.exec('PRAGMA foreign_keys = OFF');
  for (const t of [...ENG].reverse()) v.db.exec(`DROP TABLE IF EXISTS ${t}`);   // a business as it was before migration 0004 existed
  v.db.exec('PRAGMA foreign_keys = ON');
  v.db.prepare("INSERT INTO customers (name, address) VALUES ('Legacy Customer', '1 Test Street')").run();
  v.db.prepare("INSERT INTO invoices (customer_id, description, amount) VALUES (1, 'Legacy invoice', 500)").run();
  check(ENG.every((t) => !v.tables().includes(t)), 'the pre-migration business has none of the engine tables');
  const legacyPre = fingerprint(v.db, legacyTables(v));
  const snapA = await bk.takeSnapshot(v.env, new Date('2026-11-01T03:00:00Z'));
  v.db.exec(migration);   // the migration arrives (additive)
  check(ENG.every((t) => v.tables().includes(t)) && fingerprint(v.db, legacyTables(v)) === legacyPre, 'the migration adds the engine tables and changes no legacy row');
  const idsV = await populate(v);
  const engineWith = fingerprint(v.db, ENG);
  const snapB = await bk.takeSnapshot(v.env, new Date('2026-11-01T04:00:00Z'));
  v.db.prepare("INSERT INTO customers (name) VALUES ('Damage')").run();
  const back = await bk.restoreSnapshot(v.env, snapA.name, 'eng-a');
  check(back.ok === true && back.differences.length === 0, 'restoring the PRE-migration snapshot succeeds on a business that has the engine tables and data');
  check(fingerprint(v.db, legacyTables(v)) === legacyPre, 'the legacy tables are back exactly as they were before the migration, the damage gone');
  check(ENG.every((t) => v.tables().includes(t) && v.count(t) === 0), 'the engine tables are EMPTY (the engine data did not exist then) and still there, inert');
  check((await eng.verifyIntegrity(v.env)).ok, 'an empty engine verifies clean');
  const fwd = await bk.restoreSnapshot(v.env, snapB.name, 'eng-a');
  check(fwd.ok === true && fwd.differences.length === 0 && fingerprint(v.db, ENG) === engineWith, 'and the POST-migration snapshot rolls it forward again: the engine tables are back exactly, from empty');
  check((await eng.verifyIntegrity(v.env)).ok && JSON.stringify(await ledger.outstandingForParty(v.env, idsV.a)).length > 20, 'verified clean, and the books derive');
  check(!v.db.prepare("SELECT 1 FROM eng_config WHERE key = 'mode' AND value_json != '\"engine\"'").get(), 'the business is still an engine business after the round trip (the mode is part of what is restored)');
});

if (require.main === module) kit.standalone(module.exports);
