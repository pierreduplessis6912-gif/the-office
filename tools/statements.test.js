// Tests for supplier statements having a home (decided 2026-10-04): the table, recording, the sentence about the difference, and the history.
module.exports = async function runStatementTests({ check, bundleTo, srcDir, fs, path, sameJson }) {
  const { recordSupplierStatement, statementDifferenceNote, listSupplierStatements, supplierStatementsAnswer } = bundleTo('finance.ts', 'rm-stmt-finance.js');
  const { newDatabase, d1 } = require('./harness.js');
  const workerDir = path.join(srcDir, '..');
  const fresh = () => { const db = newDatabase(workerDir); db.exec(`INSERT INTO characters (id, name, relationship) VALUES (1, 'Floornet', 'supplier'), (2, 'Belgotex', 'supplier');`); return { db, env: { OFFICE_DB: d1(db) } }; };

  check(statementDifferenceNote(0) === ' That matches our records.', 'a statement that agrees says so');
  check(statementDifferenceNote(1000) === ' They claim R1000 more than our records.' && statementDifferenceNote(-500) === ' They claim R500 less than our records.', 'and one that does not says which way round, without a minus sign');
  check(statementDifferenceNote(0.5) === ' They claim R0.5 more than our records.', 'a small difference is not rounded away');

  let { env } = fresh();
  check(sameJson(await listSupplierStatements(env, null), []), 'with nothing recorded the history is empty (and the table is created on first look)');
  const a = await recordSupplierStatement(env, 1, 12000, 11000, 'spoken', 'Floornet says 12000', 'owner@example.com');
  check(a.id === 1 && a.difference === 1000, 'recording a statement returns its id and the difference (claimed less books)');
  const b = await recordSupplierStatement(env, 1, 10500.505, 11000, 'document', null, null);
  check(b.difference === -499.5, 'the difference is rounded to cents (10500.505 - 11000)');
  await recordSupplierStatement(env, 2, 4000, 4000, 'photo', null, null);
  const mine = await listSupplierStatements(env, 1);
  check(mine.length === 2 && mine[0].claimed === 10500.505 && mine[1].claimed === 12000 && mine.every((r) => r.supplier === 'Floornet'), 'one supplier\'s history is theirs only, newest first');
  check((await listSupplierStatements(env, null)).length === 3, 'with no supplier named it is every supplier\'s');
  for (let i = 0; i < 8; i++) await recordSupplierStatement(env, 1, 100 + i, 100, 'spoken', null, null);
  check((await listSupplierStatements(env, 1)).length === 5 && (await listSupplierStatements(env, 1, 20)).length === 10, 'the history shows the latest five unless more are asked for');
  const srcRow = await env.OFFICE_DB.prepare('SELECT source, source_text, recorded_by FROM supplier_statements WHERE id = 1').first();
  check(srcRow.source === 'spoken' && srcRow.source_text === 'Floornet says 12000' && srcRow.recorded_by === 'owner@example.com', 'where it came from, what was said and who said it are kept');

  const rows = [{ supplier: 'Floornet', date: '2026-10-03', claimed: 10500, books: 11000, difference: -500, source: 'photo' }, { supplier: 'Floornet', date: '2026-10-02', claimed: 11000, books: 11000, difference: 0, source: 'document' }, { supplier: 'Floornet', date: '2026-10-01', claimed: 12000, books: 11000, difference: 1000, source: 'spoken' }];
  check(supplierStatementsAnswer(rows, 'Floornet') === 'Statements from Floornet: 2026-10-03: claimed R10500, our records R11000 (R500 less); 2026-10-02: claimed R11000, our records R11000 (matched); 2026-10-01: claimed R12000, our records R11000 (R1000 more).', 'the answer reads one line per statement, newest first');
  check(/^Statements: Floornet, 2026-10-03: claimed/.test(supplierStatementsAnswer(rows, null)), 'asked about every supplier, each line names its supplier');
  check(supplierStatementsAnswer([], 'Floornet') === 'No statements from Floornet have been recorded yet.' && supplierStatementsAnswer([], null) === 'No supplier statements have been recorded yet.', 'and says so when there are none');

  // The table the seeds create is the table the code creates.
  const norm = (x) => x.replace(/\s+/g, ' ').trim();
  const code = fs.readFileSync(path.join(srcDir, 'finance.ts'), 'utf8').match(/"(CREATE TABLE IF NOT EXISTS supplier_statements [^"]*)"/);
  check(Boolean(code), 'the code creates the supplier_statements table');
  const seed = fs.readFileSync(path.join(__dirname, 'cases', 'lookups.js'), 'utf8').match(/"(CREATE TABLE IF NOT EXISTS supplier_statements [^"]*)"/);
  check(Boolean(seed) && Boolean(code) && norm(seed[1]) === norm(code[1]), 'the table the lookups cases create must be exactly the table the code creates');
};
