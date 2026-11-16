// Bank statements, increment G5a (docs/decisions/bank-reconciliation.md): bringing in what the bank says.
//   facts     a statement and its lines are inserted once with one event; nothing is edited; nothing is written to the ledger
//   twice     the same statement again changes nothing (refused: nothing new); an overlapping one adds only the new lines; two identical real lines on one day are two lines
//   checks    opening + lines = closing or the whole statement is refused; dates inside the period; amounts whole cents and not nothing
//   csv       the engine reads dates and amounts itself (several layouts); an unreadable line refuses the whole file and says which
//   guards    owner-only (can_manage_settings); the integrity verifier finds a statement that no longer adds up
const kit = require('./engine-kit.js');

module.exports = kit.guard('engine bank statements (G5a)', async ({ check }) => {
  const eng = kit.loadEngine();
  const { facts, capabilities, bank, verifyIntegrity } = eng;
  const CTX = { actorEmail: 'owner@example.com', contract: 'test', contractVersion: 1 };
  const codeOf = async (fn) => { try { await fn(); return null; } catch (e) { return e && e.code ? e.code : 'threw:' + String(e && e.message).slice(0, 80); } };
  const L = (date, description, amountMinor, balanceMinor) => ({ date, description, amountMinor, ...(balanceMinor === undefined ? {} : { balanceMinor }) });
  const stmt = (lines, over = {}) => ({ periodFrom: '2026-11-01', periodTo: '2026-11-30', openingMinor: 100000, closingMinor: 100000 + lines.reduce((s, l) => s + l.amountMinor, 0), lines, ...over });
  const good = [L('2026-11-02', 'EFT Mokoena INV-12', 250000), L('2026-11-03', 'Bank fee', -1500), L('2026-11-10', 'EFT Timber Supplies', -90000)];

  // ---- the plain import ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  let w = kit.makeWorld();
  const v = capabilities.bankStatementImport.validate(stmt(good));
  check(v.ok === true, 'a statement whose opening plus lines equals its closing is accepted');
  const r = await facts.importStatement(w.env, v.value, CTX);
  const ev = w.db.prepare('SELECT type, actor_email FROM eng_event WHERE id = ?').get(r.eventId);
  check(r.added === 3 && r.skipped === 0 && w.count('eng_bank_statement') === 1 && w.count('eng_bank_line') === 3 && ev.type === 'bank_statement.imported' && ev.actor_email === 'owner@example.com', 'the import is one event, one statement and a line each, with who did it');
  check(w.count('eng_journal_entry') === 0 && w.count('eng_account') === 0, 'a statement writes nothing to the ledger: it only says what the bank says');
  const st = w.db.prepare('SELECT * FROM eng_bank_statement').get();
  check(st.file_total_minor === 250000 - 1500 - 90000, 'the statement keeps what the file said in total');
  check((await verifyIntegrity(w.env)).ok === true, 'the integrity verifier is content with a good statement');

  // ---- twice, overlapping, identical lines -----------------------------------------------------------------------------------------------------------------------------------------------------
  const before = JSON.stringify(w.counts());
  check(await codeOf(() => facts.importStatement(w.env, v.value, CTX)) === 'invalid_state' && JSON.stringify(w.counts()) === before, 'the same statement again is refused (nothing new) and writes nothing at all');
  const more = stmt([L('2026-11-10', 'EFT Timber Supplies', -90000), L('2026-11-12', 'Cash deposit', 30000)], { periodFrom: '2026-11-10', periodTo: '2026-11-30', openingMinor: 348500, closingMinor: 288500 });
  const ov = capabilities.bankStatementImport.validate(more);
  const ro = await facts.importStatement(w.env, ov.value, CTX);
  check(ov.ok && ro.added === 1 && ro.skipped === 1 && w.count('eng_bank_line') === 4, 'an overlapping statement adds only the lines not already there, and counts the skipped one');
  check((await verifyIntegrity(w.env)).ok === true, 'and the verifier still agrees (lines stored plus skipped equal what the file had)');
  const twin = capabilities.bankStatementImport.validate(stmt([L('2026-11-05', 'Card fee', -5000), L('2026-11-05', 'Card fee', -5000)]));
  const w2 = kit.makeWorld(); const rt = await facts.importStatement(w2.env, twin.value, CTX);
  check(rt.added === 2 && w2.count('eng_bank_line') === 2, 'two identical fees on the same day are two lines, not a duplicate');
  const again = await codeOf(() => facts.importStatement(w2.env, twin.value, CTX));
  check(again === 'invalid_state', 'and bringing that statement in again is still recognised line for line');
  check(await codeOf(async () => w.db.prepare("INSERT INTO eng_bank_line (statement_id, line_no, line_date, description, amount_minor, fingerprint, event_id) SELECT statement_id, 9, line_date, description, amount_minor, fingerprint, event_id FROM eng_bank_line LIMIT 1").run()) !== null, 'the database itself refuses a second copy of a line');

  // ---- refusals --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const bad = (p) => capabilities.bankStatementImport.validate(p);
  const refused = [
    bad({ ...stmt(good), closingMinor: 1 }),                                  // does not add up
    bad(stmt([L('2026-12-01', 'Late', 100)], { closingMinor: 100100 })),        // outside the period
    bad(stmt([L('2026-11-02', 'Zero', 0)])),                                    // nothing
    bad(stmt([L('2026-11-02', 'Half cent', 10.5)])),                            // fraction
    bad(stmt([L('2026-11-02', '   ', 100)], { closingMinor: 100100 })),         // no description
    bad({ ...stmt(good), csv: 'a' }),                                           // both ways in
    bad({ periodFrom: '2026-11-01', periodTo: '2026-11-30', openingMinor: 0, closingMinor: 0 }), // neither
    bad({ ...stmt(good), extra: 1 }),                                           // stray field
    bad({ ...stmt(good), periodTo: '2026-10-31' }),                             // period backwards
    bad(stmt([])),                                                               // no lines
  ];
  check(refused.every((x) => x.ok === false), 'the contract refuses: a statement that does not add up, a line outside its period, an amount of nothing, a fraction of a cent, no description, both lines and csv, neither, a stray field, a backwards period and an empty statement');
  check(bad({ ...stmt(good), closingMinor: 1 }).reason.includes('closing'), 'and says why in plain words');

  // ---- csv: the engine reads the file ----------------------------------------------------------------------------------------------------------------------------------------------------------
  check(bank.amountToMinor('1 234,50') === 123450 && bank.amountToMinor('1,234.50') === 123450 && bank.amountToMinor('(120.00)') === -12000 && bank.amountToMinor('-R 45.10') === -4510 && bank.amountToMinor('R45') === 4500 && bank.amountToMinor('12.3') === 1230 && bank.amountToMinor('1,5') === 150 && bank.amountToMinor('abc') === null && bank.amountToMinor('1.234') === null && bank.amountToMinor('') === null, 'amounts: spaces, commas and points as thousands or decimals, brackets and minus for money out, a rand sign; nonsense is not an amount');
  check(bank.dateToIso('2026-11-03') === '2026-11-03' && bank.dateToIso('2026/11/03') === '2026-11-03' && bank.dateToIso('03/11/2026') === '2026-11-03' && bank.dateToIso('31/02/2026') === null && bank.dateToIso('soon') === null, 'dates: year first or day first, a date that does not exist is refused');
  const a = bank.parseStatementCsv('Date,Description,Amount,Balance\n2026-11-02,"EFT, Mokoena",2500.00,3500.00\n2026-11-03,Bank fee,-15.00,3485.00');
  check(a.ok && a.value.length === 2 && a.value[0].description === 'EFT, Mokoena' && a.value[0].amountMinor === 250000 && a.value[1].amountMinor === -1500 && a.value[1].balanceMinor === 348500, 'a one-amount-column file (a quoted comma included)');
  const b = bank.parseStatementCsv('Date;Details;Money In;Money Out\n03/11/2026;Deposit;100,00;\n04/11/2026;Fee;;12,50');
  check(b.ok && b.value[0].amountMinor === 10000 && b.value[1].amountMinor === -1250, 'a semicolon file with money in and money out columns');
  const c = bank.parseStatementCsv('Date,Description,Amount\n2026-11-02,Fine,10.00\nsometime,Bad,10.00');
  check(c.ok === false && c.reason.includes('line 2'), 'an unreadable line refuses the whole file and names the line');
  check(bank.parseStatementCsv('Foo,Bar\n1,2').ok === false && bank.parseStatementCsv('Date,Description,Amount').ok === false, 'a file with no usable header, or no lines, is refused');
  const viaCsv = capabilities.bankStatementImport.validate({ periodFrom: '2026-11-01', periodTo: '2026-11-30', openingMinor: 0, closingMinor: 98500, csv: 'Date,Description,Amount\n2026-11-02,In,1000.00\n2026-11-03,Out,-15.00' });
  check(viaCsv.ok === true && viaCsv.value.lines.length === 2, 'a statement can be given as csv text and the engine does the reading');

  // ---- who may --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  check(capabilities.bankStatementImport.permissions.length === 1 && capabilities.bankStatementImport.permissions[0] === 'business.manage' && capabilities.bankStatementImport.heldType === 'engine.bank_statement.import', 'importing a statement needs the permission to manage the business, like locking the books');

  // ---- the verifier finds what no longer adds up ------------------------------------------------------------------------------------------------------------------------------------------------------
  const t = kit.makeWorld(); await facts.importStatement(t.env, v.value, CTX);
  t.db.prepare('UPDATE eng_bank_statement SET closing_minor = closing_minor + 1').run();
  const rep = await verifyIntegrity(t.env);
  check(rep.ok === false && rep.problems.some((p) => p.code === 'bank_statement_inconsistent'), 'a statement whose closing balance is changed afterwards is found by the verifier');
  const t2 = kit.makeWorld(); await facts.importStatement(t2.env, v.value, CTX);
  t2.db.prepare('DELETE FROM eng_bank_line WHERE id = (SELECT MIN(id) FROM eng_bank_line)').run();
  check((await verifyIntegrity(t2.env)).problems.some((p) => p.code === 'bank_statement_inconsistent'), 'and a line removed afterwards is found too');
});

if (require.main === module) kit.standalone(module.exports);
