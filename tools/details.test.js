// Tests for sensitive person details (decided 2026-10-04): which keys are payroll or banking, who may handle them, and what a role is shown.
module.exports = async function runDetailTests({ check, bundleTo, srcDir, path, sameJson }) {
  const { sensitiveFactKind, mayHandleSensitiveFact, getCharacterFacts } = bundleTo('memory.ts', 'rm-details-memory.js');
  const { newDatabase, d1 } = require('./harness.js');
  const workerDir = path.join(srcDir, '..');

  const payroll = ['day rate', 'Day_Rate', 'daily rate', 'hourly rate', 'pay rate', 'rate', 'salary', 'monthly salary', 'wage', 'wages', 'payroll number', 'commission', 'bonus', 'ctc', 'rate per day', 'per day', 'earnings'];
  const banking = ['bank', 'bank name', 'bank account', 'banking details', 'account number', 'Account No', 'acc number', 'iban', 'swift code', 'branch code', 'sort code', 'card number', 'routing number'];
  const plain = ['cell', 'phone', 'address', 'email', 'licence', 'license', 'skill', 'role', 'account manager', 'payment terms', 'vat number', 'start date', 'rated by customers', 'surname', 'birthday', 'next of kin'];
  for (const k of payroll) check(sensitiveFactKind(k) === 'payroll', `"${k}" is a payroll detail (got ${sensitiveFactKind(k)})`);
  for (const k of banking) check(sensitiveFactKind(k) === 'banking', `"${k}" is a banking detail (got ${sensitiveFactKind(k)})`);
  for (const k of plain) check(sensitiveFactKind(k) === null, `"${k}" is an ordinary detail, shown as before (got ${sensitiveFactKind(k)})`);
  check(sensitiveFactKind('bank account rate') === 'banking', 'a key that is both reads as banking first (the more sensitive reading wins)');

  check(mayHandleSensitiveFact(null, []) === true, 'an ordinary detail needs no permission');
  check(mayHandleSensitiveFact('payroll', ['can_know_payroll']) === true && mayHandleSensitiveFact('payroll', ['can_know_banking']) === false, 'a payroll detail needs payroll access, and banking access does not stand in for it');
  check(mayHandleSensitiveFact('banking', ['can_know_banking']) === true && mayHandleSensitiveFact('banking', ['can_know_payroll', 'can_know_jobs']) === false, 'a banking detail needs banking access');

  const db = newDatabase(workerDir);
  db.exec(`INSERT INTO characters (id, name, relationship) VALUES (1, 'Sipho', 'installer');
    INSERT INTO character_facts (character_id, key, value, created_at) VALUES (1, 'cell', '083 555 0202', '2026-10-01 08:00:00'), (1, 'day_rate', 'R600 a day', '2026-10-02 08:00:00'), (1, 'bank_account', 'FNB 6201234', '2026-10-03 08:00:00');`);
  const env = { OFFICE_DB: d1(db) };
  check(sameJson(await getCharacterFacts(env, 1, []), ['cell: 083 555 0202']), 'a role with neither permission sees only the ordinary detail');
  check(sameJson(await getCharacterFacts(env, 1, ['can_know_payroll']), ['day rate: R600 a day', 'cell: 083 555 0202']), 'payroll access shows the pay detail but not the bank detail');
  check(sameJson(await getCharacterFacts(env, 1, ['can_know_banking']), ['bank account: FNB 6201234', 'cell: 083 555 0202']), 'banking access shows the bank detail but not the pay detail');
  check((await getCharacterFacts(env, 1, ['can_know_payroll', 'can_know_banking'])).length === 3, 'both permissions show everything');
  check((await getCharacterFacts(env, 1)).length === 3, 'with no capabilities given (the admin tools) everything is returned');
};
