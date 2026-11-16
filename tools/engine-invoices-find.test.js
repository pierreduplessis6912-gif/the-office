// The business-wide invoice list (invoices.find, GET /engine/invoices): every customer invoice not reversed, newest first, with what is still owed on each.
//   derived   the list is the per-customer receivables worked out for everyone; it agrees with receivables.query and writes nothing
//   filters   status owing / paid / any, by customer; a wrong filter is refused
//   people    whoever may know the debtors may read it; a salesperson and an installer may not
const kit = require('./engine-kit.js');

module.exports = kit.guard('engine invoice list', async ({ check }) => {
  const AV = [...kit.ALL_CAPABILITIES, 'invoices.find'];
  const ENV = { BUSINESS_ID: 'eng-a' };
  const run = (spec) => kit.route({ env: ENV, seed: kit.seedReceivables(AV), ...spec });
  const body = (r) => (r.result && r.result.body) || {};
  const status = (r) => r.result && r.result.status;
  const propose = (capability, payload) => ({ method: 'POST', path: '/engine/proposals', role: 'accountant', body: { capability, payload, transcript: 'a sentence' } });
  const confirm = (id) => ({ method: 'POST', path: `/actions/${id}/confirm`, role: 'accountant', body: {} });
  const find = (role, q = '') => ({ method: 'GET', path: `/engine/invoices${q}`, role });
  const paid = [propose('payment.record', { partyId: 1, amountMinor: 115000, currency: 'ZAR', occurredOn: '2026-11-05', allocate: 'oldest_first' }), confirm(1)];
  const written = (r) => Object.values(r.writes || {}).reduce((n, t) => n + ((t && t.added) || []).length, 0);

  let r = await run(find('owner'));
  let res = body(r).result || {};
  check(status(r) === 200 && res.count === 2 && res.invoices.length === 2, `lists both invoices (${status(r)} ${res.count})`);
  check(res.invoices[0].id > res.invoices[1].id, 'newest first');
  check(res.owingMinor === 138000 && res.invoices.every((i) => i.status === 'owing' && i.partyName === 'Mokoena' && i.ref.kind === 'document'), 'each owes in full, named for its customer, total R1380.00');
  const rec = await run({ method: 'GET', path: '/engine/receivables?party=Mokoena', role: 'owner' });
  check((body(rec).result || {}).totalMinor === res.owingMinor, 'the total agrees with what the customer owes');
  check(written(r) === 0, 'reading writes nothing');

  r = await run({ before: paid, ...find('owner') });
  res = body(r).result || {};
  check(res.count === 2 && res.invoices.filter((i) => i.status === 'paid').length === 1 && res.owingMinor === 23000, 'after paying invoice 1 it shows paid and only R230.00 is owing');
  r = await run({ before: paid, ...find('owner', '?status=owing') });
  check(((body(r).result || {}).invoices || []).length === 1 && body(r).result.invoices[0].id === 2, 'status=owing leaves out the paid one');
  r = await run({ before: paid, ...find('owner', '?status=paid') });
  check(((body(r).result || {}).invoices || []).length === 1 && body(r).result.invoices[0].id === 1, 'status=paid shows only the paid one');
  r = await run(find('owner', '?partyId=999'));
  check(status(r) === 200 && (body(r).result || {}).count === 0, 'a customer with none gives an empty list');
  r = await run(find('owner', '?status=late'));
  check(status(r) !== 200, `an unknown status is refused (${status(r)})`);
  for (const role of ['owner', 'accountant', 'admin']) check(status(await run(find(role))) === 200, `${role} may read it`);
  for (const role of ['sales', 'installer']) check(status(await run(find(role))) === 403, `${role} may not`);
});
if (require.main === module) kit.standalone(module.exports);
