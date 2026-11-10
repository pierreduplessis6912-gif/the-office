// Customers and suppliers (branch engine-phase1): create, edit, find. TESTS FIRST, in the Mokoena slice style (docs/CAPABILITY_MAP.md, "what done means", boxes 1 and 2). Evidence label for every check: TEST of the engine on the route harness
// (a stand-in for Durable Object storage: NOT staging, NOT production). Expected state when first committed: RED (the capabilities party.create, party.edit and parties.find do not exist yet).
// What the capability is (docs/decisions/customers-suppliers.md): a party is a customer, a supplier or both. CREATING and EDITING one are held writes, approved by a person; FINDING is a read. A party row is a FACT and is never updated:
// an edit is a new fact (a party.revised event) and the CURRENT name, roles and contact details are derived from the party and its revisions, so history is never lost and the integrity verifier still holds.
const kit = require('./engine-kit.js');

module.exports = kit.guard('customers and suppliers', async ({ check }) => {
  const eng = kit.loadEngine();
  check(Boolean(eng && eng.permissions && eng.capabilities && eng.operations && eng.facts), 'the engine exposes permissions, capabilities, operations and facts');
  if (!eng || !eng.permissions || !eng.capabilities) return;
  const auth = kit.bundle('auth.ts', 'auth');
  const member = (role) => ({ email: `${role}@example.com`, caps: auth.ROLE_CAPABILITIES[role] || [] });
  const AV = [...kit.ALL_CAPABILITIES, 'parties.find', 'party.create', 'party.edit'];
  const ENV = { BUSINESS_ID: 'eng-a' };
  const run = (spec) => kit.route({ env: ENV, seed: kit.seedReceivables(AV), ...spec });
  const propose = (role, capability, payload, transcript = 'a sentence from the person') => ({ method: 'POST', path: '/engine/proposals', role, body: { capability, payload, transcript } });
  const confirm = (role, id = 1) => ({ method: 'POST', path: `/actions/${id}/confirm`, role, body: {} });
  const find = (role, query = '') => ({ method: 'GET', path: `/engine/parties${query}`, role });
  const open = (role, id) => ({ method: 'GET', path: `/engine/records/party/${id}`, role });
  const ask = (role, party) => ({ method: 'GET', path: `/engine/receivables?party=${encodeURIComponent(party)}`, role });
  const added = (res, t) => ((res.writes && res.writes[t] && res.writes[t].added) || []).length;
  const addedTables = (res) => Object.keys(res.writes || {}).filter((t) => added(res, t) > 0).sort();
  const body = (res) => (res.result && res.result.body) || {};
  const status = (res) => res.result && res.result.status;
  const FACTS = ['eng_party', 'eng_party_role', 'eng_document', 'eng_document_line', 'eng_document_number', 'eng_money_movement', 'eng_allocation', 'eng_reversal'];
  const touchesNoFact = (res) => FACTS.every((t) => added(res, t) === 0);
  const patel = { kind: 'organisation', name: 'Patel Builders', roles: ['customer'], contact: { email: 'accounts@patel.example', phone: '+27 82 555 0101', address: '12 Main Road, Empangeni' } };
  const makePatel = [propose('accountant', 'party.create', patel, 'Add Patel Builders as a customer'), confirm('accountant', 1)];   // party 2, action 1

  // ---- 1. PERMISSIONS: the engine's own vocabulary, decided for every role -----------------------------------------------------------------------------------------------------------------------
  const has = (role, p) => eng.permissions.permissionsFor(member(role).caps).has(p);
  check(['owner', 'accountant', 'admin'].every((r) => has(r, 'party.read') && has(r, 'party.manage')), 'owner, accountant and admin may read and manage customers and suppliers');
  check(['installer', 'sales'].every((r) => !has(r, 'party.read') && !has(r, 'party.manage')), 'an installer and a salesperson hold neither (a default: widening it is a decision for the owner, not an accident)');
  const ids = eng.capabilities.CAPABILITY_IDS;
  check(['parties.find', 'party.create', 'party.edit'].every((c) => ids.includes(c)), 'the three capabilities exist in the engine');

  // ---- 2. CREATE: held first, recorded only on approval ---------------------------------------------------------------------------------------------------------------------------------------------
  let r = await run(propose('accountant', 'party.create', patel, 'Add Patel Builders as a customer'));
  check(status(r) === 200 && body(r).status === 'held' && Number.isInteger(body(r).actionId), `proposing a new customer is HELD (${status(r)} ${body(r).status})`);
  check(touchesNoFact(r) && added(r, 'eng_event') === 0, 'and nothing is recorded yet: no party, no role, no event, only what was said and the proposal');
  check(added(r, 'captures') === 1 && added(r, 'eng_interpretation') === 1, 'what was said is kept first, with the interpretation that linked it to the proposal');
  r = await run({ before: [propose('accountant', 'party.create', patel, 'Add Patel Builders as a customer')], ...confirm('accountant', 1) });
  check(status(r) === 200 && added(r, 'eng_party') === 1 && added(r, 'eng_party_role') === 1, `approving it records ONE party with its role (${status(r)}, ${added(r, 'eng_party')} party, ${added(r, 'eng_party_role')} role)`);
  check(added(r, 'eng_event') === 2 && !(r.writes && r.writes.eng_document) && !(r.writes && r.writes.eng_money_movement), 'with the party.created event and the single operation.executed event, and no money or document touched');
  const both = await run({ before: [propose('accountant', 'party.create', { kind: 'person', name: 'Dlamini Timber', roles: ['customer', 'supplier'] })], ...confirm('accountant', 1) });
  check(status(both) === 200 && added(both, 'eng_party_role') === 2, 'a party can be both a customer and a supplier: two roles, one party');
  const opened = await run({ before: makePatel, ...open('accountant', 2) });
  const view = body(opened).result || {};
  const field = (k) => ((view.fields || []).find((f) => f.key === k) || {}).value;
  check(status(opened) === 200 && view.title === 'Patel Builders' && field('name') === 'Patel Builders' && field('roles') === 'customer' && field('email') === 'accounts@patel.example' && field('phone') === '+27 82 555 0101' && field('address') === '12 Main Road, Empangeni', 'the new record opens with its name, role and contact details');
  const created = (view.history || []).find((h) => h.type === 'party.created') || {};
  check(created.contract === 'party.create' && created.contractVersion === 1 && created.approvedBy === 'accountant@example.com' && Number.isInteger(created.captureId) && Number.isInteger(created.interpretationId) && Number.isInteger(created.proposalId), 'and it is EXPLAINED: what was said, what was understood, which proposal, who approved it and under which contract');

  // ---- 3. CREATE refusals: each for its own reason, nothing written ---------------------------------------------------------------------------------------------------------------------------
  const badPayloads = [
    [{ ...patel, colour: 'blue' }, 'a field nobody declared'], [{ ...patel, name: '   ' }, 'a blank name'], [{ ...patel, name: 'x'.repeat(121) }, 'a name over 120 characters'], [{ ...patel, kind: 'company' }, 'a kind that is neither person nor organisation'],
    [{ ...patel, roles: [] }, 'no role'], [{ ...patel, roles: ['banana'] }, 'a role that is neither customer nor supplier'], [{ ...patel, roles: ['customer', 'customer'] }, 'the same role twice'], [{ ...patel, roles: 'customer' }, 'roles that are not a list'],
    [{ ...patel, contact: { email: 'not an email' } }, 'an email that is not one'], [{ ...patel, contact: { phone: 'call me' } }, 'a phone number that is not one'], [{ ...patel, contact: { fax: '1' } }, 'a contact field nobody declared'], [{ ...patel, contact: { email: null } }, 'a null contact field on create'], [null, 'no payload at all'],
  ];
  for (const [payload, why] of badPayloads) {
    r = await run(propose('accountant', 'party.create', payload));
    check(status(r) === 422 && body(r).error === 'invalid_payload' && touchesNoFact(r) && added(r, 'eng_interpretation') === 0, `${why} is refused at the door as invalid_payload (${status(r)} ${body(r).error}) and records nothing`);
  }
  r = await run({ before: makePatel, ...propose('accountant', 'party.create', { kind: 'person', name: '  patel   BUILDERS ', roles: ['supplier'] }) });
  check(status(r) === 409 && body(r).error === 'duplicate' && touchesNoFact(r), `a name that is already taken, ignoring case and spacing, is refused as DUPLICATE (${status(r)} ${body(r).error})`);
  check(/add the role|already/i.test(String(body(r).message || '')), 'and the message points at editing the existing record instead of creating a second one');
  r = await run(propose('accountant', 'party.create', { kind: 'person', name: 'mokoena', roles: ['customer'] }));
  check(status(r) === 409 && body(r).error === 'duplicate', 'the customer the business already had (Mokoena) counts too');
  for (const role of ['installer', 'sales']) { r = await run(propose(role, 'party.create', patel)); check(status(r) === 403 && touchesNoFact(r), `${role} may not propose a new customer: refused 403, nothing recorded`); }
  r = await run({ before: [propose('accountant', 'party.create', patel)], ...confirm('installer', 1) });
  check(status(r) === 403 && added(r, 'eng_party') === 0, 'an installer cannot approve one either');
  r = await kit.route({ env: ENV, seed: kit.seedReceivables(kit.ALL_CAPABILITIES), ...propose('accountant', 'party.create', patel) });
  check(status(r) === 409 && body(r).error === 'capability_unavailable' && touchesNoFact(r), 'a business without the capability is told so honestly (capability_unavailable) and records nothing');
  r = await run({ before: [propose('accountant', 'party.create', patel), confirm('accountant', 1)], ...confirm('accountant', 1) });
  check(status(r) !== 200 && added(r, 'eng_party') === 0, `approving the same proposal twice never creates a second party (${status(r)})`);

  // ---- 4. EDIT: a new fact, never an update ---------------------------------------------------------------------------------------------------------------------------------------------------------------
  const edit = (payload, transcript = 'Change that customer') => propose('accountant', 'party.edit', payload, transcript);
  r = await run({ before: makePatel, ...edit({ partyId: 2, name: 'Patel Builders (Pty) Ltd' }, 'Patel Builders is now Patel Builders Pty Ltd') });
  check(status(r) === 200 && body(r).status === 'held' && touchesNoFact(r) && added(r, 'eng_event') === 0, 'proposing an edit is HELD and changes nothing');
  const rename = [...makePatel, edit({ partyId: 2, name: 'Patel Builders (Pty) Ltd' }, 'Patel Builders is now Patel Builders Pty Ltd'), confirm('accountant', 2)];
  r = await run({ before: [...makePatel, edit({ partyId: 2, name: 'Patel Builders (Pty) Ltd' })], ...confirm('accountant', 2) });
  check(status(r) === 200 && added(r, 'eng_event') === 2 && added(r, 'eng_party') === 0 && added(r, 'eng_party_role') === 0 && !(r.writes && r.writes.eng_party && r.writes.eng_party.changed && r.writes.eng_party.changed.length), `approving it records the party.revised event and the execution, and NO party row is added or changed (${addedTables(r).join(', ')})`);
  const after = await run({ before: rename, ...open('accountant', 2) });
  const v2 = body(after).result || {};
  check(v2.title === 'Patel Builders (Pty) Ltd', 'the record now opens under the new name');
  const hist = (v2.history || []).map((h) => h.type);
  check(hist.includes('party.created') && hist.includes('party.revised'), 'and its history keeps BOTH facts: what it was created as, and the revision');
  const revised = (v2.history || []).find((h) => h.type === 'party.revised') || {};
  check(revised.contract === 'party.edit' && revised.approvedBy === 'accountant@example.com' && Number.isInteger(revised.captureId) && Number.isInteger(revised.interpretationId), 'the revision is EXPLAINED too: what was said, what was understood, who approved, under which contract');
  const byNew = await run({ before: rename, ...ask('accountant', 'Patel Builders (Pty) Ltd') });
  const byOld = await run({ before: rename, ...ask('accountant', 'Patel Builders') });
  check(status(byNew) === 200 && body(byNew).result && body(byNew).result.party.name === 'Patel Builders (Pty) Ltd', 'what Patel owes is found under the new name');
  check(status(byOld) === 404, 'and no longer under the old one');
  check(!addedTables(await run({ before: rename, ...open('accountant', 2) })).length, 'opening a record writes nothing');
  r = await run({ before: [...makePatel, edit({ partyId: 2, addRoles: ['supplier'], contact: { phone: null, email: 'new@patel.example' } }), confirm('accountant', 2)], ...open('accountant', 2) });
  const v3 = body(r).result || {}; const f3 = (k) => ((v3.fields || []).find((f) => f.key === k) || {}).value;
  check(f3('roles') === 'customer, supplier' && f3('email') === 'new@patel.example' && f3('phone') === null && f3('address') === '12 Main Road, Empangeni', 'a role can be added, a contact field changed and another cleared (null), and the rest is untouched');
  r = await run({ before: [...makePatel, edit({ partyId: 2, addRoles: ['supplier'] }), confirm('accountant', 2), edit({ partyId: 2, removeRoles: ['customer'] }), confirm('accountant', 3)], ...open('accountant', 2) });
  check(((body(r).result || {}).fields || []).find((f) => f.key === 'roles').value === 'supplier', 'a role can be removed while another remains');
  const editRefusals = [
    [{ partyId: 2, removeRoles: ['customer'] }, 'invalid_state', 'removing the only role'], [{ partyId: 2, removeRoles: ['supplier'] }, 'invalid_state', 'removing a role the party does not have'], [{ partyId: 2, addRoles: ['customer'] }, 'invalid_state', 'adding a role it already has'],
    [{ partyId: 2, name: 'Patel Builders' }, 'invalid_input', 'a rename to the name it already has (nothing to change)'], [{ partyId: 2, name: 'Mokoena' }, 'duplicate', 'a rename onto another party\'s name'], [{ partyId: 99, name: 'Ghost' }, 'not_found', 'a party that does not exist'],
  ];
  for (const [payload, code, why] of editRefusals) {
    r = await run({ before: makePatel, ...edit(payload) });
    check(touchesNoFact(r) && added(r, 'eng_event') === 0 && body(r).error === code, `${why} is refused at the door as ${code} (${status(r)} ${body(r).error}) and records nothing`);
  }
  for (const [payload, why] of [[{ partyId: 2 }, 'an edit that changes nothing'], [{ partyId: 2, name: 'A', colour: 'blue' }, 'a field nobody declared'], [{ partyId: 'two', name: 'A' }, 'a partyId that is text'], [{ partyId: 2, name: '' }, 'a blank name'], [{ partyId: 2, addRoles: ['banana'] }, 'a role nobody declared'], [{ partyId: 2, contact: { email: 'nope' } }, 'a bad email']]) {
    r = await run({ before: makePatel, ...edit(payload) });
    check(status(r) === 422 && body(r).error === 'invalid_payload' && touchesNoFact(r), `${why} is refused as invalid_payload`);
  }
  for (const role of ['installer', 'sales']) { r = await run({ before: makePatel, ...propose(role, 'party.edit', { partyId: 2, name: 'Hijacked' }) }); check(status(r) === 403 && touchesNoFact(r), `${role} may not propose an edit`); }
  // stale: an approval is only for the record as it was shown
  r = await run({ before: [...makePatel, edit({ partyId: 2, name: 'First' }), edit({ partyId: 2, name: 'Second' }), confirm('accountant', 3)], ...confirm('accountant', 2) });
  check(status(r) === 409 && body(r).error === 'stale' && added(r, 'eng_event') === 0, `an edit approved after the record changed is refused as STALE (${status(r)} ${body(r).error}), so nobody overwrites what they have not seen`);
  // two proposals for the same new name: the second approval meets the duplicate
  r = await run({ before: [...makePatel, edit({ partyId: 2, name: 'Same Name' }), propose('accountant', 'party.create', { kind: 'person', name: 'Same Name', roles: ['customer'] }), confirm('accountant', 2)], ...confirm('accountant', 3) });
  check(status(r) === 409 && body(r).error === 'duplicate' && added(r, 'eng_party') === 0, 'a name taken between the proposal and the approval is caught AT the approval (duplicate), not only at the door');
  // a payment proposed before a rename is stale afterwards: the account it showed has changed
  const pay = { partyId: 2, amountMinor: 1000, currency: 'ZAR', occurredOn: '2026-11-07', allocations: [] };
  r = await run({ before: [...makePatel, propose('accountant', 'payment.record', pay), edit({ partyId: 2, name: 'Renamed' }), confirm('accountant', 3)], ...confirm('accountant', 2) });
  check(status(r) === 409 && body(r).error === 'stale' && added(r, 'eng_money_movement') === 0, 'a payment proposed before the customer was renamed is refused as stale: the approval is for the record it showed');
  // money is untouched by an edit
  r = await run({ before: [edit({ partyId: 1, name: 'Mokoena Flooring' }), confirm('accountant', 1)], ...ask('accountant', 'Mokoena Flooring') });
  const acct = body(r).result || {};
  check(status(r) === 200 && acct.totalMinor === 138000 && (acct.documents || []).length === 2 && acct.party && acct.party.id === 1, 'renaming the customer who owes money changes no money: the same invoices, the same R1,380.00 under the new name');

  // ---- 5. FIND: a read ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const world = [...makePatel, propose('accountant', 'party.create', { kind: 'person', name: 'Dlamini Timber', roles: ['supplier'] }), confirm('accountant', 2)];
  r = await run({ before: world, ...find('accountant') });
  const all = (body(r).result || {}).parties || [];
  check(status(r) === 200 && all.length === 3 && all.map((p) => p.name).sort().join('|') === 'Dlamini Timber|Mokoena|Patel Builders', 'finding with no filter lists every party');
  check(all.every((p) => p.ref && p.ref.kind === 'party' && Number.isInteger(p.ref.id) && Array.isArray(p.roles) && p.contact && typeof p.contact === 'object'), 'each carries a record reference to open, its roles and its contact details');
  r = await run({ before: world, ...find('accountant', '?name=PATEL') });
  check(((body(r).result || {}).parties || []).length === 1 && body(r).result.parties[0].name === 'Patel Builders', 'finding by part of a name ignores case');
  r = await run({ before: world, ...find('accountant', '?role=supplier') });
  check(((body(r).result || {}).parties || []).map((p) => p.name).join() === 'Dlamini Timber', 'finding by role returns only the suppliers');
  r = await run({ before: world, ...find('accountant', '?name=zzz') });
  check(status(r) === 200 && ((body(r).result || {}).parties || []).length === 0, 'finding something that is not there is an honest empty answer, not an error');
  r = await run({ before: [...makePatel, edit({ partyId: 2, name: 'Renamed Builders' }), confirm('accountant', 2)], ...find('accountant', '?name=renamed') });
  check(((body(r).result || {}).parties || []).length === 1, 'finding uses the CURRENT name');
  r = await run({ before: world, ...find('accountant', '?role=banana') });
  check(status(r) === 422, 'a role nobody declared is refused as invalid');
  for (const role of ['installer', 'sales']) { r = await run({ before: world, ...find(role) }); check(status(r) === 403 && !/Patel|Dlamini|Mokoena/.test(JSON.stringify(body(r))), `${role} is refused (403) and the refusal names no customer`); }
  r = await kit.route({ env: ENV, seed: kit.seedReceivables(kit.ALL_CAPABILITIES), ...find('accountant') });
  check(status(r) === 409 && body(r).error === 'capability_unavailable', 'a business without the capability is told so (capability_unavailable)');

  // ---- 6. EXPLAINED RECORDS: what a member may do from the record ----------------------------------------------------------------------------------------------------------------------------------
  r = await run({ before: makePatel, ...open('owner', 2) });
  const act = ((body(r).result || {}).actions || []).find((a) => a.capability === 'party.edit') || {};
  check(act.valid === true, 'an owner opening a party is offered the edit action as valid');
  r = await run({ before: makePatel, ...open('installer', 2) });
  check(status(r) === 404, 'an installer opening a party gets exactly what a record that does not exist gets');
  r = await kit.route({ env: ENV, seed: kit.seedReceivables(kit.ALL_CAPABILITIES), before: [], ...open('owner', 1) });
  check(!((body(r).result || {}).actions || []).some((a) => a.capability === 'party.edit'), 'where the business does not have the capability, the record does not offer it');

  // ---- 7. THE FOUNDATIONS STILL HOLD ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const { facts, verifyIntegrity, EVENT_MODEL } = eng;
  check(Boolean(EVENT_MODEL['party.revised']) && EVENT_MODEL['party.revised'].creates === null, 'the event model knows party.revised, and says it creates no fact row (the current profile is derived)');
  const w = kit.makeWorld(); w.configure({ mode: 'engine', available: AV });
  const CTX = { actorEmail: 'accountant@example.com', contract: 'test', contractVersion: 1 };
  const pid = (await facts.recordParty(w.env, { kind: 'organisation', name: 'Patel Builders', roles: ['customer'], contact: { email: 'a@b.example' } }, CTX)).id;
  const snapshot = JSON.stringify(w.db.prepare('SELECT * FROM eng_party ORDER BY id').all()) + JSON.stringify(w.db.prepare('SELECT * FROM eng_party_role ORDER BY party_id, role').all());
  await facts.reviseParty(w.env, { partyId: pid, name: 'Patel Builders (Pty) Ltd', addRoles: ['supplier'], contact: { phone: '+27 82 555 0101' } }, CTX);
  check(JSON.stringify(w.db.prepare('SELECT * FROM eng_party ORDER BY id').all()) + JSON.stringify(w.db.prepare('SELECT * FROM eng_party_role ORDER BY party_id, role').all()) === snapshot, 'an edit leaves the party rows byte-for-byte as they were created: a fact is never edited');
  let integ = await verifyIntegrity(w.env);
  check(integ.ok === true && integ.problems.length === 0 && integ.warnings.length === 0, 'and the integrity verifier is clean after a create and an edit, with no warning about an unmodelled event');
  w.db.prepare("INSERT INTO eng_event (type, payload_json) VALUES ('party.revised', ?)").run(JSON.stringify({ partyId: 999, name: 'Ghost' }));
  integ = await verifyIntegrity(w.env);
  check(integ.ok === false && integ.problems.some((p) => p.code === 'orphan' && /999/.test(p.detail)), 'a revision that points at a party that does not exist is REPORTED by the verifier (orphan)');
  // atomicity: a failure at each write of a create leaves nothing behind
  const probe = kit.makeWorld(); probe.configure({ mode: 'engine', available: AV });
  probe.resetWrites(); await facts.recordParty(probe.env, { kind: 'person', name: 'Atomic', roles: ['customer', 'supplier'], contact: { email: 'a@b.example' } }, CTX); const writes = probe.writeCount();
  let leaked = [];
  for (let n = 1; n <= writes; n++) {
    const x = kit.makeWorld(); x.configure({ mode: 'engine', available: AV }); const was = JSON.stringify(x.counts()); x.failAt(n);
    let threw = false; try { await facts.recordParty(x.env, { kind: 'person', name: 'Atomic', roles: ['customer', 'supplier'], contact: { email: 'a@b.example' } }, CTX); } catch { threw = true; }
    if (!threw || JSON.stringify(x.counts()) !== was) leaked.push(n);
  }
  check(writes >= 4 && leaked.length === 0, `creating a party is atomic: a failure at each of its ${writes} writes leaves no party, no role and no event` + (leaked.length ? ' (leaked at ' + leaked.join(',') + ')' : ''));
  const bad = [['name', { partyId: pid, name: '' }], ['an unknown party', { partyId: 12345, name: 'X' }], ['a role it does not hold', { partyId: pid, removeRoles: ['customer', 'banana'] }]];
  for (const [why, input] of bad) { const was = JSON.stringify(w.counts()); let code = null; try { await facts.reviseParty(w.env, input, CTX); } catch (e) { code = e && e.code; } check(code !== null && JSON.stringify(w.counts()) === was, `the fact layer itself refuses an edit with ${why} and writes nothing (${code})`); }
});

if (require.main === module) kit.standalone(module.exports);
