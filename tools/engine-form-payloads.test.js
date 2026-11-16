// The app's forms (docs/decisions/create-from-screen.md) send the same payload a sentence would, through POST /engine/proposals. This pins the engine's side for the first form, "new customer or supplier":
// exactly what the form sends is HELD (nothing recorded), becomes a customer/supplier only on approval, and a refusal carries the engine's own reason for the form to show.
const kit = require('./engine-kit.js');

module.exports = kit.guard('engine form payloads (F1)', async ({ check }) => {
  const AV = [...kit.ALL_CAPABILITIES, 'party.create', 'parties.find'];
  const run = (spec) => kit.route({ env: { BUSINESS_ID: 'eng-a' }, seed: kit.seedReceivables(AV), ...spec });
  const body = (r) => (r.result && r.result.body) || {};
  const status = (r) => r.result && r.result.status;
  const added = (r, t) => ((r.writes && r.writes[t] && r.writes[t].added) || []).length;
  const send = (role, payload) => ({ method: 'POST', path: '/engine/proposals', role, body: { capability: 'party.create', payload, transcript: 'Added from the New customer or supplier form', source: 'app' } });
  const form = { kind: 'organisation', name: 'Mokoena Flooring', roles: ['customer', 'supplier'], contact: { phone: '082 555 0101', email: 'info@mokoena.example' } };

  let r = await run(send('owner', form));
  check(status(r) === 200 && body(r).status === 'held' && Number.isInteger(body(r).actionId), `the form's payload is held (${status(r)} ${body(r).status})`);
  check(added(r, 'eng_party') === 0 && added(r, 'eng_party_role') === 0, 'and nothing is recorded by sending it');
  const before = [send('owner', form), { method: 'POST', path: '/actions/1/confirm', role: 'owner', body: {} }];
  r = await run({ before: before.slice(0, 1), ...before[1] });
  check(status(r) === 200 && added(r, 'eng_party') === 1 && added(r, 'eng_party_role') === 2, `approving it records one party with two roles (${status(r)})`);
  r = await run({ before, method: 'GET', path: '/engine/parties', role: 'owner' });
  const list = (body(r).result || {}).parties || [];
  check(list.some((p) => p.name === 'Mokoena Flooring' && p.kind === 'organisation'), 'and it is in the list of customers and suppliers');

  const small = { kind: 'person', name: 'Thandi', roles: ['customer'] };
  r = await run(send('owner', small));
  check(status(r) === 200 && body(r).status === 'held', 'a person with only a name and a role is held too');

  r = await run({ before, ...send('owner', { ...form, name: 'mokoena flooring' }) });
  check(status(r) >= 400 && /already a customer or supplier called Mokoena Flooring/.test(String(body(r).message)), `a name already used is refused with the engine's own reason (${status(r)}: ${body(r).message})`);
  r = await run(send('owner', { ...small, name: '   ' }));
  check(status(r) >= 400 && typeof body(r).message === 'string' && body(r).message.length > 5, `a blank name is refused with a reason (${body(r).message})`);
  r = await run(send('owner', { ...small, roles: [] }));
  check(status(r) >= 400, 'no role is refused');
  r = await run(send('installer', small));
  check(status(r) >= 400 && added(r, 'eng_party') === 0, `someone who may not add parties is refused (${status(r)})`);
});
if (require.main === module) kit.standalone(module.exports);
