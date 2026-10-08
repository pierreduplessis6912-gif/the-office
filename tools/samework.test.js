// Tests for "the same work said twice makes no new job" (decided with Pierre 2026-10-04, seen on the phone: jobs #73-#76 for one carpet repair).
module.exports = async function runSameWorkTests({ check, bundleTo, srcDir, path, sameJson }) {
  const { workKey, findOpenJobWithSameWork } = bundleTo('finance.ts', 'rm-samework-finance.js');
  const { newDatabase, d1 } = require('./harness.js');
  const workerDir = path.join(srcDir, '..');

  check(workKey('carpet repair') === 'carpet repair' && workKey('Repair of the Carpet') === 'carpet repair' && workKey('  CARPET,   repair! ') === 'carpet repair', 'the same words in any order, any case, ignoring small words and punctuation, are the same work');
  check(workKey('carpet repairs') !== workKey('carpet repair') && workKey('curtain fitting') !== workKey('carpet repair'), 'different words are different work (no guessing at plurals or meaning)');
  check(workKey(null) === '' && workKey('') === '' && workKey('the of for') === '', 'nothing to compare is no key');

  const db = newDatabase(workerDir);
  db.exec(`
    INSERT INTO people (name) VALUES ('Jenny Smith'), ('Thandi Mokoena');
    INSERT INTO customers (id, name, person_id) VALUES (1, 'Jenny Smith', 1), (2, 'Thandi Mokoena', 2);
    INSERT INTO projects (id, customer_id, description, created_at) VALUES (10, 1, 'Kitchen refit', '2026-09-01 08:00:00');
    INSERT INTO job_scopes (id, customer_id, description, project_id, created_at) VALUES
      (1, 1, 'carpet repair', NULL, '2026-10-01 08:00:00'), (2, 1, 'kitchen floor', 10, '2026-09-01 08:00:00'), (3, 2, 'carpet repair', NULL, '2026-10-02 08:00:00'), (4, 1, 'carpet repair', NULL, '2026-10-02 09:00:00');
    INSERT INTO invoices (id, customer_id, description, amount, job_scope_id, created_at) VALUES (1, 1, 'Kitchen refit', 5000, 2, '2026-09-05 08:00:00');
    INSERT INTO payments (customer_id, amount, source_transcript, invoice_id, created_at) VALUES (1, 5000, 'Jenny paid R5000', 1, '2026-09-20 08:00:00');
  `);
  const env = { OFFICE_DB: d1(db) };
  const obs = (job, tasks, components = []) => ({ job_description: job, components, tasks: tasks.map((d) => ({ description: d })) });

  let m = await findOpenJobWithSameWork(env, 1, obs('carpet repair', ['carpet repair']));
  check(m && m.id === 4 && m.description === 'carpet repair', 'the same work as an open job is that job (the most recent one when there are two)');
  m = await findOpenJobWithSameWork(env, 1, obs('observation', ['repair of the carpet']));
  check(m && m.id === 4, 'a task in other words matches, and the generic placeholder description does not get in the way');
  check((await findOpenJobWithSameWork(env, 1, obs('curtain fitting', ['curtain fitting']))) === null, 'different work is not matched');
  check((await findOpenJobWithSameWork(env, 1, obs('carpet repair', ['carpet repair'], [{ name: 'lounge' }]))) === null, 'a sentence with measurements is never matched (a re-measure is new detail)');
  check((await findOpenJobWithSameWork(env, 1, obs('carpet repair', []))) === null, 'nothing about tasks is not matched');
  check((await findOpenJobWithSameWork(env, 1, obs('observation', ['observation']))) === null && (await findOpenJobWithSameWork(env, 1, obs('', ['']))) === null, 'a placeholder or empty description is never matched');
  m = await findOpenJobWithSameWork(env, 2, obs('carpet repair', ['carpet repair']));
  check(m && m.id === 3, 'another customer\'s identical work is matched only against their own jobs');
  check((await findOpenJobWithSameWork(env, 1, obs('kitchen floor', ['kitchen floor']))) === null, 'a job whose project is paid in full is closed and is not matched');
  check((await findOpenJobWithSameWork(env, 999, obs('carpet repair', ['carpet repair']))) === null, 'a customer with no jobs matches nothing');
};
