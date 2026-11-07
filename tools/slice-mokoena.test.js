// Mokoena receivables slice (branch engine-phase1). TESTS FIRST. This is the BACKEND CONTRACT the visible slice stands on, walked as one story through the engine's REAL routes on the test harness (a stand-in for Durable Object storage, NOT staging, NOT production):
//   STAGE ONE   a natural question (scripted: "what does Mokoena owe?") -> a permission-aware, evidence-bearing answer -> drill-down to the records beneath it -> back to the conversation (the shell's own state, not a server step).
//   STAGE TWO   propose a payment -> it is HELD, not recorded -> an authorised member approves -> the new position is read back.
// Nothing here is authorised to ship; it states what the shell may rely on. The slice is checked against the 16-domain blueprint as a DESIGN check once that document is supplied; until then the neutrality checks below are structural only.
// Evidence labels: every check is a TEST of the existing engine; a check that fails is a GAP the slice must close or a contract the shell must not assume.
const kit = require('./engine-kit.js');

module.exports = kit.guard('mokoena slice', async ({ check }) => {
  const ENV = { BUSINESS_ID: 'eng-a' };
  const run = (spec) => kit.route({ env: ENV, seed: kit.seedReceivables(), ...spec });
  const ask = (role, party = 'Mokoena') => ({ method: 'GET', path: `/engine/receivables?party=${encodeURIComponent(party)}`, role });
  const open = (role, kind, id) => ({ method: 'GET', path: `/engine/records/${kind}/${id}`, role });
  const propose = (role, payload, capability = 'payment.record') => ({ method: 'POST', path: '/engine/proposals', role, body: { capability, payload, transcript: 'Mokoena paid R1,150' } });
  const confirm = (role, id = 1) => ({ method: 'POST', path: `/actions/${id}/confirm`, role, body: {} });
  const added = (res, t) => ((res.writes && res.writes[t] && res.writes[t].added) || []).length;
  const body = (res) => (res.result && res.result.body) || {};
  const pay = { partyId: 1, amountMinor: 115000, currency: 'ZAR', occurredOn: '2026-11-07', method: 'eft', allocate: 'oldest_first' };
  const figures = ['138000', '115000', '23000'];
  const leaksFigure = (res) => figures.some((f) => JSON.stringify(body(res)).includes(f));

  // ---- STAGE ONE: the question and the evidence-bearing answer --------------------------------------------------------------------------------------------------------------------------------
  const q = await run(ask('accountant'));
  const a = body(q).result || {};
  check(q.result && q.result.status === 200 && body(q).status === 'ok', 'an accountant asking what Mokoena owes gets an ok answer');
  check(a.party && a.party.id === 1 && a.party.name === 'Mokoena' && a.currency === 'ZAR' && a.totalMinor === 138000, 'the answer names the customer, the currency and the total: R1,380.00 outstanding');
  check(Array.isArray(a.documents) && a.documents.length === 2 && a.documents[0].outstandingMinor === 115000 && a.documents[1].outstandingMinor === 23000, 'the total is carried by two documents, oldest first: R1,150.00 (2026-10-01) and R230.00 (2026-10-15)');
  check(a.documents && a.documents.every((d) => d.ref && d.ref.kind === 'document' && Number.isInteger(d.ref.id) && Number.isInteger(d.grossMinor) && Number.isInteger(d.allocatedMinor)), 'each document line carries a record reference to open and whole-number figures (nothing is a decimal the shell would have to compute)');
  check(Number.isInteger(a.version) && a.version > 0 && typeof a.derivedBy === 'string' && a.derivedBy.length > 0, 'the answer carries the version of the account it read and which derivation produced the figure (the evidence the engine has today)');
  check(a.documents && a.documents.reduce((s, d) => s + d.outstandingMinor, 0) === a.totalMinor, 'the lines add up to the total, so the shell never needs to calculate one');
  const keyNames = []; JSON.stringify(a, (k, v) => { if (k) keyNames.push(k); return v; });
  check(!keyNames.some((k) => /invoice|quote|sales|order/i.test(k)), 'the answer\'s field names are generic (party, document, kind), so the same shape can carry other domains: ' + [...new Set(keyNames)].join(', '));

  // ---- permission-aware: a refusal reveals no figure -----------------------------------------------------------------------------------------------------------------------------------------
  for (const role of ['owner', 'admin']) { const r = await run(ask(role)); check(r.result && r.result.status === 200 && body(r).result && body(r).result.totalMinor === 138000, `${role} gets the same answer`); }
  for (const role of ['installer', 'sales']) {
    const r = await run(ask(role));
    check(r.result && r.result.status === 403 && !leaksFigure(r), `${role} is refused (403) and the refusal carries no figure`);
  }
  const nobody = await run(ask('accountant', 'Nobody'));
  check(nobody.result && nobody.result.status === 404 && !leaksFigure(nobody), 'an unknown customer answers not_found with no figure');
  const two = await run({ ...ask('accountant'), seed: (db) => { kit.seedReceivables()(db); const e = Number(db.prepare("INSERT INTO eng_event (type, actor_email, contract, contract_version, payload_json) VALUES ('party.created', 'seed@example.com', 'seed', 1, ?) RETURNING id").get(JSON.stringify({ kind: 'organisation', name: 'Mokoena', roles: ['customer'] })).id); db.prepare("INSERT INTO eng_party (kind, name, event_id) VALUES ('organisation', 'Mokoena', ?)").run(e); db.prepare("INSERT INTO eng_party_role (party_id, role, event_id) VALUES (2, 'customer', ?)").run(e); } });
  check(two.result && body(two).status === 'ambiguous' && Array.isArray(body(two).candidates) && body(two).candidates.length === 2 && !leaksFigure(two), 'a name that matches two customers comes back ambiguous with both candidates and no figure, so the shell must ask which one');

  // ---- STAGE ONE: drill-down from the answer to the records beneath it ----------------------------------------------------------------------------------------------------------------------
  const ref = a.documents && a.documents[0] && a.documents[0].ref;
  const doc = ref ? await run(open('accountant', ref.kind, ref.id)) : null;
  const d = doc ? (body(doc).result || {}) : {};
  check(doc && doc.result && doc.result.status === 200, 'following the first line\'s reference opens that document for an accountant');
  console.log('  slice (information): a document record view has these top-level fields: ' + Object.keys(d).join(', '));
  check(Number.isInteger(d.version) && d.version > 0, 'the record view carries its own version');
  check(JSON.stringify(d).includes('115000'), 'and shows the figure the answer summarised (R1,150.00), so the drill-down agrees with the answer');
  check(JSON.stringify(d).includes('Vinyl plank'), 'and shows what was sold, the line beneath the figure');
  const party = await run(open('accountant', 'party', 1));
  check(party.result && party.result.status === 200, 'the customer record opens too (the other way back up from a document)');
  console.log('  slice (information): a party record view has these top-level fields: ' + Object.keys(body(party).result || {}).join(', '));
  const hidden = ref ? await run(open('installer', ref.kind, ref.id)) : null, absent = await run(open('installer', 'document', 99999));
  check(hidden && absent && hidden.result.status === absent.result.status && JSON.stringify(body(hidden)) === JSON.stringify(body(absent)), 'a record an installer may not see answers exactly as one that does not exist, so drill-down reveals nothing');

  // ---- STAGE TWO: propose, hold, approve, see the result -------------------------------------------------------------------------------------------------------------------------------------
  const proposed = await run(propose('accountant', pay));
  check(proposed.result && proposed.result.status === 200 && body(proposed).status === 'held' && Number.isInteger(body(proposed).actionId), 'proposing a payment from an accountant is HELD with an action number');
  check(added(proposed, 'eng_money_movement') === 0 && added(proposed, 'eng_allocation') === 0, 'and nothing is recorded yet: a proposal is not an approval');
  const stillOwes = await run({ ...ask('accountant'), before: [propose('accountant', pay)] });
  check(body(stillOwes).result && body(stillOwes).result.totalMinor === 138000, 'while it is held the customer still owes R1,380.00 (a held payment changes no figure)');
  const refused = await run(propose('installer', pay));
  check(refused.result && refused.result.status === 403 && added(refused, 'pending_actions') === 0, 'an installer cannot propose a payment (403) and nothing is held');
  const approved = await run({ before: [propose('accountant', pay)], ...confirm('accountant') });
  check(approved.result && approved.result.status === 200 && added(approved, 'eng_money_movement') === 1 && added(approved, 'eng_allocation') === 1, 'an accountant approving it records the payment and its allocation');
  const after = await run({ before: [propose('accountant', pay), confirm('accountant')], ...ask('accountant') });
  const n = body(after).result || {};
  check(n.totalMinor === 23000, 'reading back afterwards, Mokoena owes R230.00');
  const first = (n.documents || []).find((x) => x.ref && x.ref.id === 1);
  check(!first || first.outstandingMinor === 0, 'and the settled invoice no longer shows an outstanding amount');
  check(n.version > a.version, 'the account\'s version has moved on, so an approval built on the old figures could not be replayed');
  const cannot = await run({ before: [propose('accountant', pay)], ...confirm('installer') });
  check(cannot.result && cannot.result.status === 403 && added(cannot, 'eng_money_movement') === 0, 'an installer cannot approve the held payment (403) and nothing is recorded');
  const stale = await run({ before: [propose('accountant', pay), propose('accountant', { ...pay, amountMinor: 23000 }), confirm('accountant', 2)], ...confirm('accountant', 1) });
  check(stale.result && stale.result.status === 409 && body(stale).error === 'stale' && added(stale, 'eng_money_movement') === 0, 'approving after the account changed underneath is refused as stale: an approval is only for what it showed');
});

if (require.main === module) kit.standalone(module.exports);
