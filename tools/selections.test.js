// Tests for one "current selection" per signed-in person (decided 2026-10-04): "her", "him" and "forget that" are each person's own.
module.exports = async function runSelectionTests({ check, bundleTo, srcDir, fs, path, sameJson }) {
  const { setSelection, getSelection, getCurrentSelection, clearSelections } = bundleTo('identity.ts', 'rm-selections-identity.js');
  const { newDatabase, d1 } = require('./harness.js');
  const workerDir = path.join(srcDir, '..');
  const fresh = () => { const db = newDatabase(workerDir); return { db, env: { OFFICE_DB: d1(db) } }; };

  let { env } = fresh();
  check((await getCurrentSelection(env, 'owner@example.com')) === null, 'with nothing selected there is no selection (and the table is created on first look)');
  await setSelection(env, 'customer', 1, 'Jenny Smith', 'owner@example.com');
  check(sameJson(await getCurrentSelection(env, 'owner@example.com'), { type: 'customer', id: 1, name: 'Jenny Smith' }), 'a person\'s selection is remembered for them');
  check((await getCurrentSelection(env, 'accountant@example.com')) === null, 'and is NOT anyone else\'s: another person\'s "her" has nothing to refer to');
  await setSelection(env, 'character', 2, 'Sipho', 'accountant@example.com');
  check((await getCurrentSelection(env, 'owner@example.com'))?.name === 'Jenny Smith' && (await getCurrentSelection(env, 'accountant@example.com'))?.name === 'Sipho', 'two people hold two different selections at once');
  check((await getCurrentSelection(env, '  OWNER@Example.com '))?.name === 'Jenny Smith', 'an email is matched ignoring case and spaces');
  await setSelection(env, 'customer', 3, 'Thandi Mokoena', 'owner@example.com');
  check((await getSelection(env, 'customer', 'owner@example.com'))?.label === 'Thandi Mokoena', 'selecting again replaces that person\'s own selection of that kind');
  check((await getSelection(env, 'customer', 'accountant@example.com')) === null, 'and leaves everyone else\'s alone');
  await clearSelections(env, 'owner@example.com');
  check((await getCurrentSelection(env, 'owner@example.com')) === null && (await getCurrentSelection(env, 'accountant@example.com'))?.name === 'Sipho', '"forget that" clears the person who said it, and nobody else');
  await setSelection(env, 'quotation', 9, 'quotation for Jenny (R450)', null);
  check((await getCurrentSelection(env, null))?.type === 'quotation' && (await getCurrentSelection(env, ''))?.type === 'quotation' && (await getCurrentSelection(env, 'owner@example.com')) === null, 'a person with no known email shares one anonymous selection, apart from everyone else\'s');

  // The old shared table (still in the live database) is left alone and no longer read.
  ({ env } = (() => { const x = fresh(); x.db.exec("INSERT INTO selections (key, entity_id, label, updated_at) VALUES ('customer', 1, 'Jenny Smith', '2026-10-03 11:00:00');"); return x; })());
  check((await getCurrentSelection(env, 'owner@example.com')) === null, 'a selection left in the old shared table is not read for anyone');

  // The table the seeds create is the table the code creates.
  const norm = (x) => x.replace(/\s+/g, ' ').trim();
  const code = fs.readFileSync(path.join(srcDir, 'identity.ts'), 'utf8').match(/"(CREATE TABLE IF NOT EXISTS member_selections [^"]*)"/);
  check(Boolean(code), 'the code creates the member_selections table');
  for (const f of ['identity', 'lookups']) {
    const seed = fs.readFileSync(path.join(__dirname, 'cases', f + '.js'), 'utf8').match(/"(CREATE TABLE IF NOT EXISTS member_selections [^"]*)"/);
    check(Boolean(seed) && Boolean(code) && norm(seed[1]) === norm(code[1]), `the table the ${f} cases create must be exactly the table the code creates`);
  }
};
