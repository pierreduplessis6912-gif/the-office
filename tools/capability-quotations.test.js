// Quotations (branch engine-phase1): create, revise, accept, find. TESTS FIRST, in the Mokoena slice style (docs/CAPABILITY_MAP.md, "what done means", boxes 1 and 2). Evidence label for every check: TEST of the engine on the route
// harness (a stand-in for Durable Object storage: NOT staging, NOT production). Expected state when first committed: RED (quotation.create, quotation.revise, quotation.accept and quotations.find do not exist yet).
// What the capability is (docs/decisions/quotations.md): a quotation is a DOCUMENT of kind "quotation" for a customer, recorded as a held write that a person approves. A REVISION is a new document with its own number and a
// quotation.revised event saying which one it replaces; ACCEPTANCE is a quotation.accepted event about the current revision. What state a quotation is in (open, accepted, superseded) is DERIVED from those events, never a stored
// column, so nothing is edited and no schema changes. A quotation is not a debt: no money, no allocation, nothing the customer owes. VAT is never assumed: every line carries its own explicit tax rate.
const kit = require('./engine-kit.js');

module.exports = kit.guard('quotations', async ({ check }) => {
  const eng = kit.loadEngine();
  check(Boolean(eng && eng.permissions && eng.capabilities && eng.facts), 'the engine exposes permissions, capabilities and facts');
  if (!eng || !eng.permissions || !eng.capabilities) return;
  const auth = kit.bundle('auth.ts', 'auth');
  const member = (role) => ({ email: `${role}@example.com`, caps: auth.ROLE_CAPABILITIES[role] || [] });
  const AV = [...kit.ALL_CAPABILITIES, 'parties.find', 'party.create', 'party.edit', 'quotations.find', 'quotation.create', 'quotation.revise', 'quotation.accept'];
  const ENV = { BUSINESS_ID: 'eng-a' };
  const run = (spec) => kit.route({ env: ENV, seed: kit.seedReceivables(AV), ...spec });
  const propose = (role, capability, payload, transcript = 'a sentence from the person') => ({ method: 'POST', path: '/engine/proposals', role, body: { capability, payload, transcript } });
  const confirm = (role, id = 1) => ({ method: 'POST', path: `/actions/${id}/confirm`, role, body: {} });
  const find = (role, query = '') => ({ method: 'GET', path: `/engine/quotations${query}`, role });
  const open = (role, id) => ({ method: 'GET', path: `/engine/records/document/${id}`, role });
  const owes = (role) => ({ method: 'GET', path: '/engine/receivables?party=Mokoena', role });
  const added = (res, t) => ((res.writes && res.writes[t] && res.writes[t].added) || []).length;
  const body = (res) => (res.result && res.result.body) || {};
  const status = (res) => res.result && res.result.status;
  const FACTS = ['eng_party', 'eng_party_role', 'eng_document', 'eng_document_line', 'eng_document_number', 'eng_money_movement', 'eng_allocation', 'eng_reversal'];
  const touchesNoFact = (res) => FACTS.every((t) => added(res, t) === 0);
  const line = (description, quantityMilli, unitPriceMinor, taxBp = 1500) => ({ description, quantityMilli, unit: 'm2', unitPriceMinor, taxBp });
  const L1 = [line('Boards', 2000, 12500), line('Fitting', 1000, 10000)];   // net 25000 + 10000 = 35000, tax 3750 + 1500 = 5250, gross 40250
  const L2 = [line('Boards', 2000, 12500), line('Fitting', 1500, 10000)];   // net 25000 + 15000 = 40000, tax 3750 + 2250 = 6000, gross 46000
  const quote = { partyId: 1, issuedOn: '2026-11-10', currency: 'ZAR', validUntil: '2026-12-10', reference: 'Lounge floor', lines: L1 };
  // a small sequencer so a scenario reads as what was said and approved, with the action numbers kept straight
  const seq = () => { let n = 0; const steps = []; const api = { steps,
    prop(cap, payload, role = 'accountant') { n += 1; steps.push(propose(role, cap, payload, `(${cap})`)); return n; },
    ok(id, role = 'accountant') { steps.push(confirm(role, id)); return api; },
    do(cap, payload, role = 'accountant') { const id = api.prop(cap, payload, role); api.ok(id, role); return id; } }; return api; };
  const stateOf = async (steps, id, role = 'accountant') => { const r = await run({ before: steps, ...open(role, id) }); const v = body(r).result || {}; return { r, v, status: ((v.fields || []).find((f) => f.key === 'status') || {}).value }; };
  const fieldOf = (v, k) => ((v.fields || []).find((f) => f.key === k) || {}).value;

  // ---- 1. PERMISSIONS --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const has = (role, p) => eng.permissions.permissionsFor(member(role).caps).has(p);
  check(['owner', 'accountant', 'admin', 'sales'].every((r) => has(r, 'quotation.read') && has(r, 'quotation.manage')), 'owner, accountant, admin and a salesperson (the people who make quotes) may read and manage quotations');
  check(!has('installer', 'quotation.read') && !has('installer', 'quotation.manage'), 'an installer holds neither');
  check(['quotations.find', 'quotation.create', 'quotation.revise', 'quotation.accept'].every((c) => eng.capabilities.CAPABILITY_IDS.includes(c)), 'the four capabilities exist in the engine');

  // ---- 2. CREATE: held first, recorded only on approval, and never a debt ------------------------------------------------------------------------------------------------------------------------
  let r = await run(propose('accountant', 'quotation.create', quote, 'Quote Mokoena for the lounge floor'));
  check(status(r) === 200 && body(r).status === 'held' && touchesNoFact(r) && added(r, 'eng_event') === 0, `proposing a quotation is HELD and records nothing (${status(r)} ${body(r).status})`);
  const stamped = (r.writes && r.writes.eng_proposal && r.writes.eng_proposal.added) || [];
  check(JSON.stringify(body(r)).includes('40250') || JSON.stringify(r.writes || {}).includes('40250'), 'the approval is shown the exact total it will record (R402.50 with tax), worked out by the engine, not by the model');
  const made = seq(); made.do('quotation.create', quote);
  r = await run({ before: made.steps.slice(0, 1), ...confirm('accountant', 1) });
  check(status(r) === 200 && added(r, 'eng_document') === 1 && added(r, 'eng_document_line') === 2 && added(r, 'eng_document_number') === 1, `approving it records ONE quotation document with its two lines and its number (${status(r)})`);
  check(added(r, 'eng_event') === 2 && added(r, 'eng_money_movement') === 0 && added(r, 'eng_allocation') === 0, 'with the document.issued event and the single operation.executed event, and no money or allocation touched');
  const found = await run({ before: made.steps, ...find('accountant', '?partyId=1') });
  const list = (body(found).result || {}).quotations || [];
  check(status(found) === 200 && list.length === 1 && list[0].status === 'open' && list[0].number === 1 && list[0].grossMinor === 40250 && list[0].partyId === 1 && list[0].ref && list[0].ref.kind === 'document', 'finding the customer\'s quotations lists it: number 1, open, R402.50, with a reference to open it');
  const qid = list[0] ? list[0].ref.id : 0;
  let st = await stateOf(made.steps, qid);
  check(st.r.result.status === 200 && st.v.title === 'Quotation #1' && st.status === 'open' && fieldOf(st.v, 'netMinor') === 35000 && fieldOf(st.v, 'taxMinor') === 5250 && fieldOf(st.v, 'grossMinor') === 40250 && fieldOf(st.v, 'validUntil') === '2026-12-10' && fieldOf(st.v, 'reference') === 'Lounge floor', 'the record opens as Quotation #1, open, with its net, tax, total, validity and reference');
  check(fieldOf(st.v, 'outstandingMinor') === null && fieldOf(st.v, 'allocatedMinor') === null, 'and says nothing is "outstanding" or "paid": a quotation is not a debt');
  const issued = (st.v.history || []).find((h) => h.type === 'document.issued') || {};
  check(issued.contract === 'quotation.create' && issued.contractVersion === 1 && issued.approvedBy === 'accountant@example.com' && Number.isInteger(issued.captureId) && Number.isInteger(issued.interpretationId) && Number.isInteger(issued.proposalId), 'it is EXPLAINED: what was said, what was understood, which proposal, who approved it and under which contract');
  r = await run({ before: made.steps, ...owes('accountant') });
  check(status(r) === 200 && (body(r).result || {}).totalMinor === 138000, 'the customer owes exactly what they owed before (R1,380.00): a quotation is not a debt');
  const second = seq(); second.do('quotation.create', quote); second.do('quotation.create', { ...quote, reference: 'Kitchen' });
  r = await run({ before: second.steps, ...find('accountant', '?partyId=1') });
  check(((body(r).result || {}).quotations || []).map((q) => q.number).sort().join() === '1,2', 'quotations are numbered in their own sequence, 1 then 2');
  const bySales = seq(); bySales.do('quotation.create', quote, 'sales');
  r = await run({ before: bySales.steps, ...find('accountant', '?partyId=1') });
  check(((body(r).result || {}).quotations || []).length === 1, 'a salesperson can propose AND approve a quotation (making quotes is their job)');

  // ---- 3. CREATE refusals ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const bad = [
    [{ ...quote, colour: 'blue' }, 'a field nobody declared'], [{ ...quote, partyId: 'one' }, 'a partyId that is text'], [{ ...quote, lines: [] }, 'no lines'], [{ ...quote, lines: [{ description: 'x', quantityMilli: 1000, unitPriceMinor: 100 }] }, 'a line with no tax rate (VAT is never assumed)'],
    [{ ...quote, lines: [line('x', 1000, 100, 10001)] }, 'a tax rate over 100%'], [{ ...quote, lines: [line('x', 0, 100)] }, 'a quantity of zero'], [{ ...quote, lines: [line('x', 1000, -1)] }, 'a negative price'], [{ ...quote, lines: [line('x', 1000.5, 100)] }, 'a fractional quantity'],
    [{ ...quote, lines: [line('  ', 1000, 100)] }, 'a blank description'], [{ ...quote, currency: 'rand' }, 'a currency that is not a code'], [{ ...quote, issuedOn: '2026-02-30' }, 'a date that does not exist'], [{ ...quote, validUntil: '2026-11-09' }, 'a validity date before the issue date'],
    [{ ...quote, validUntil: 'soon' }, 'a validity date that is not a date'], [{ ...quote, lines: Array.from({ length: 101 }, (_, i) => line('L' + i, 1000, 100)) }, 'more than 100 lines'], [{ ...quote, reference: 'x'.repeat(121) }, 'a reference over 120 characters'], [null, 'no payload at all'],
  ];
  for (const [payload, why] of bad) { r = await run(propose('accountant', 'quotation.create', payload)); check(status(r) === 422 && body(r).error === 'invalid_payload' && touchesNoFact(r), `${why} is refused at the door as invalid_payload (${status(r)} ${body(r).error}) and records nothing`); }
  r = await run(propose('accountant', 'quotation.create', { ...quote, partyId: 99 }));
  check(status(r) === 404 && body(r).error === 'not_found' && touchesNoFact(r), 'a customer that does not exist is refused as not_found');
  const supOnly = seq(); supOnly.do('party.create', { kind: 'organisation', name: 'Floor Supplies', roles: ['supplier'] });
  r = await run({ before: supOnly.steps, ...propose('accountant', 'quotation.create', { ...quote, partyId: 2 }) });
  check(status(r) === 409 && body(r).error === 'invalid_state' && touchesNoFact(r), 'a party that is only a supplier cannot be quoted: refused as invalid_state');
  r = await run(propose('installer', 'quotation.create', quote)); check(status(r) === 403 && touchesNoFact(r), 'an installer may not propose a quotation: refused 403, nothing recorded');
  r = await run({ before: [propose('accountant', 'quotation.create', quote)], ...confirm('installer', 1) }); check(status(r) === 403 && added(r, 'eng_document') === 0, 'an installer cannot approve one either');
  r = await kit.route({ env: ENV, seed: kit.seedReceivables(kit.ALL_CAPABILITIES), ...propose('accountant', 'quotation.create', quote) });
  check(status(r) === 409 && body(r).error === 'capability_unavailable' && touchesNoFact(r), 'a business without the capability is told so (capability_unavailable) and records nothing');
  r = await run({ before: [propose('accountant', 'quotation.create', quote), confirm('accountant', 1)], ...confirm('accountant', 1) });
  check(status(r) !== 200 && added(r, 'eng_document') === 0, `approving the same proposal twice never creates a second quotation (${status(r)})`);

  // ---- 4. REVISE: a new document that replaces the old, never an edit ----------------------------------------------------------------------------------------------------------------------------
  const rev = (extra = {}) => ({ quotationId: qid, lines: L2, ...extra });
  r = await run({ before: made.steps, ...propose('accountant', 'quotation.revise', rev(), 'Make it fifteen hours of fitting') });
  check(status(r) === 200 && body(r).status === 'held' && touchesNoFact(r) && added(r, 'eng_event') === 0, 'proposing a revision is HELD and records nothing');
  const revd = seq(); revd.do('quotation.create', quote); const rid = revd.do('quotation.revise', rev({ validUntil: '2026-12-24' }));
  r = await run({ before: revd.steps.slice(0, 3), ...confirm('accountant', 2) });
  check(status(r) === 200 && added(r, 'eng_document') === 1 && added(r, 'eng_document_line') === 2 && added(r, 'eng_document_number') === 1 && added(r, 'eng_event') === 3, `approving it records ONE new document and the quotation.revised event (3 events with the execution; ${status(r)})`);
  r = await run({ before: revd.steps, ...find('accountant', '?partyId=1&status=any') });
  const both = (body(r).result || {}).quotations || [];
  const newest = both.find((q) => q.number === 2) || {}, oldest = both.find((q) => q.number === 1) || {};
  check(both.length === 2 && oldest.status === 'superseded' && newest.status === 'open' && newest.grossMinor === 46000 && newest.validUntil === '2026-12-24' && newest.partyId === 1 && newest.supersedes === oldest.ref.id && oldest.supersededBy === newest.ref.id, 'the old one is SUPERSEDED, the new one (number 2, R460.00, new validity) is open, and each says which replaced which');
  r = await run({ before: revd.steps, ...find('accountant', '?partyId=1') });
  check(((body(r).result || {}).quotations || []).length === 1 && body(r).result.quotations[0].number === 2, 'by default finding lists only the CURRENT quotation, not the ones it replaced');
  st = await stateOf(revd.steps, qid);
  check(st.status === 'superseded' && (st.v.relations || []).some((x) => x.role === 'superseded_by' && x.ref.id === newest.ref.id), 'the old record shows it is superseded and links to the one that replaced it');
  const stNew = await stateOf(revd.steps, newest.ref ? newest.ref.id : 0);
  check(stNew.status === 'open' && (stNew.v.relations || []).some((x) => x.role === 'revises' && x.ref.id === qid) && fieldOf(stNew.v, 'grossMinor') === 46000, 'the new record shows what it revises');
  const revH = (stNew.v.history || []).find((h) => h.type === 'quotation.revised') || {};
  check(revH.contract === 'quotation.revise' && revH.approvedBy === 'accountant@example.com' && Number.isInteger(revH.captureId) && Number.isInteger(revH.interpretationId), 'the revision is EXPLAINED too: what was said, what was understood, who approved, under which contract');
  const snapA = JSON.stringify(await run({ before: made.steps, ...open('accountant', qid) }).then((x) => [fieldOf(body(x).result || {}, 'grossMinor'), (body(x).result || {}).collections]));
  const snapB = JSON.stringify(await run({ before: revd.steps, ...open('accountant', qid) }).then((x) => [fieldOf(body(x).result || {}, 'grossMinor'), (body(x).result || {}).collections]));
  check(snapA === snapB, 'the superseded quotation\'s own lines and total are exactly what they were: a revision never edits the old document');
  r = await run({ before: revd.steps, ...owes('accountant') }); check((body(r).result || {}).totalMinor === 138000, 'a revision is still no debt');
  const reviseRefusals = [
    [rev({ quotationId: 999 }), 'not_found', 'a quotation that does not exist'], [rev({ lines: L1 }), 'invalid_input', 'a revision that changes nothing (same lines, same validity)'], [{ quotationId: qid }, 'invalid_payload', 'a revision with nothing in it'],
    [rev({ partyId: 2 }), 'invalid_payload', 'an attempt to move it to another customer'], [rev({ currency: 'USD' }), 'invalid_payload', 'an attempt to change the currency'], [rev({ lines: [{ description: 'x', quantityMilli: 1000, unitPriceMinor: 100 }] }), 'invalid_payload', 'a line with no tax rate'],
    [rev({ quotationId: 1.5 }), 'invalid_payload', 'a fractional quotation number'],
  ];
  for (const [payload, code, why] of reviseRefusals) { r = await run({ before: made.steps, ...propose('accountant', 'quotation.revise', payload) }); check(body(r).error === code && touchesNoFact(r) && added(r, 'eng_event') === 0, `${why} is refused at the door as ${code} (${status(r)} ${body(r).error}) and records nothing`); }
  r = await run({ before: revd.steps, ...propose('accountant', 'quotation.revise', rev({ lines: L1 })) });
  check(status(r) === 409 && body(r).error === 'invalid_state' && touchesNoFact(r), 'revising one that has already been replaced is refused as invalid_state: revise the current one');
  const inv = await run({ ...propose('accountant', 'quotation.revise', { quotationId: 1, lines: L2 }) });
  check(status(inv) === 409 && body(inv).error === 'invalid_state', 'revising something that is not a quotation (invoice 1) is refused as invalid_state');
  r = await run({ before: made.steps, ...propose('installer', 'quotation.revise', rev()) }); check(status(r) === 403 && touchesNoFact(r), 'an installer may not propose a revision');
  const stale = seq(); stale.do('quotation.create', quote); const s1 = stale.prop('quotation.revise', rev({ validUntil: '2026-12-20' })); const s2 = stale.prop('quotation.revise', rev({ validUntil: '2026-12-21' })); stale.ok(s2);
  r = await run({ before: stale.steps, ...confirm('accountant', s1) });
  check(status(r) === 409 && ['stale', 'invalid_state'].includes(body(r).error) && added(r, 'eng_document') === 0, `a revision approved after the quotation was already replaced is refused (${status(r)} ${body(r).error}), so two people cannot both revise the same version`);

  // ---- 5. ACCEPT: an event about the current revision --------------------------------------------------------------------------------------------------------------------------------------------
  const acc = seq(); acc.do('quotation.create', quote); const aid = acc.do('quotation.accept', { quotationId: qid });
  r = await run({ before: acc.steps.slice(0, 3), ...confirm('accountant', 2) });
  check(status(r) === 200 && added(r, 'eng_event') === 2 && FACTS.every((t) => added(r, t) === 0), `approving an acceptance records the quotation.accepted event and the execution, and NO fact row (${status(r)})`);
  st = await stateOf(acc.steps, qid);
  check(st.status === 'accepted' && (st.v.history || []).some((h) => h.type === 'quotation.accepted' && h.contract === 'quotation.accept' && h.approvedBy === 'accountant@example.com'), 'the quotation is now ACCEPTED, and the acceptance is explained (who approved, under which contract)');
  r = await run({ before: acc.steps, ...find('accountant', '?partyId=1&status=accepted') });
  check(((body(r).result || {}).quotations || []).length === 1, 'finding accepted quotations lists it');
  r = await run({ before: acc.steps, ...find('accountant', '?partyId=1&status=open') });
  check(((body(r).result || {}).quotations || []).length === 0, 'and it is no longer open');
  r = await run({ before: acc.steps, ...owes('accountant') }); check((body(r).result || {}).totalMinor === 138000, 'an accepted quotation is STILL not a debt: the customer owes nothing more');
  const acceptRefusals = [
    [{ before: acc.steps, ...propose('accountant', 'quotation.accept', { quotationId: qid }) }, 'invalid_state', 'accepting one that is already accepted'],
    [{ before: acc.steps, ...propose('accountant', 'quotation.revise', rev()) }, 'invalid_state', 'revising an accepted one (an accepted quotation is final: quote again)'],
    [{ before: revd.steps, ...propose('accountant', 'quotation.accept', { quotationId: qid }) }, 'invalid_state', 'accepting one that has been replaced'],
    [{ ...propose('accountant', 'quotation.accept', { quotationId: 999 }) }, 'not_found', 'accepting one that does not exist'], [{ ...propose('accountant', 'quotation.accept', { quotationId: 1 }) }, 'invalid_state', 'accepting something that is not a quotation (invoice 1)'],
    [{ before: made.steps, ...propose('accountant', 'quotation.accept', { quotationId: qid, note: 'ok' }) }, 'invalid_payload', 'a field nobody declared'], [{ before: made.steps, ...propose('accountant', 'quotation.accept', {}) }, 'invalid_payload', 'no quotation named'],
  ];
  for (const [spec, code, why] of acceptRefusals) { r = await run(spec); check(body(r).error === code && touchesNoFact(r) && added(r, 'eng_event') === 0, `${why} is refused at the door as ${code} (${status(r)} ${body(r).error}) and records nothing`); }
  r = await run({ before: made.steps, ...propose('installer', 'quotation.accept', { quotationId: qid }) }); check(status(r) === 403, 'an installer may not accept a quotation');
  const race = seq(); race.do('quotation.create', quote); const ra = race.prop('quotation.accept', { quotationId: qid }); race.do('quotation.revise', rev());
  r = await run({ before: race.steps, ...confirm('accountant', ra) });
  check(status(r) === 409 && added(r, 'eng_event') === 0, `an acceptance approved after the quotation was replaced is refused (${status(r)} ${body(r).error}): you cannot accept what you did not see`);
  const accSales = seq(); accSales.do('quotation.create', quote, 'sales'); accSales.do('quotation.accept', { quotationId: qid }, 'sales');
  st = await stateOf(accSales.steps, qid, 'sales'); check(st.status === 'accepted', 'a salesperson can accept too');

  // ---- 6. FIND ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  r = await run({ before: made.steps, ...find('accountant', '?partyId=2') }); check(status(r) === 200 && ((body(r).result || {}).quotations || []).length === 0, 'finding for a customer with none is an honest empty answer');
  r = await run({ before: made.steps, ...find('accountant', '?status=banana') }); check(status(r) === 422, 'a status nobody declared is refused as invalid');
  r = await run({ before: made.steps, ...find('accountant', '?partyId=abc') }); check(status(r) === 422, 'a partyId that is not a number is refused as invalid');
  r = await run({ before: made.steps, ...find('installer') }); check(status(r) === 403 && !/Mokoena|Lounge/.test(JSON.stringify(body(r))), 'an installer is refused (403) and the refusal names nothing');
  r = await kit.route({ env: ENV, seed: kit.seedReceivables(kit.ALL_CAPABILITIES), ...find('accountant') }); check(status(r) === 409 && body(r).error === 'capability_unavailable', 'a business without the capability is told so');
  r = await run({ before: made.steps, ...open('installer', qid) }); check(status(r) === 404 || status(r) === 403, 'an installer opening a quotation gets nothing');
  r = await run({ before: made.steps, ...open('accountant', qid) });
  const acts = (body(r).result || {}).actions || [];
  check(acts.some((a) => a.capability === 'quotation.revise' && a.valid === true) && acts.some((a) => a.capability === 'quotation.accept' && a.valid === true) && !acts.some((a) => a.capability === 'payment.record'), 'an open quotation offers revise and accept (and no payment: it is not a debt)');
  r = await run({ before: acc.steps, ...open('accountant', qid) });
  check(!((body(r).result || {}).actions || []).some((a) => a.valid === true && /quotation\./.test(a.capability)), 'an accepted one offers no further quotation action');

  // ---- 7. THE FOUNDATIONS STILL HOLD ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const { facts, verifyIntegrity, EVENT_MODEL } = eng;
  check(Boolean(EVENT_MODEL['quotation.revised']) && EVENT_MODEL['quotation.revised'].creates === null && Boolean(EVENT_MODEL['quotation.accepted']) && EVENT_MODEL['quotation.accepted'].creates === null, 'the event model knows quotation.revised and quotation.accepted, and says they create no fact row');
  const w = kit.makeWorld(); w.configure({ mode: 'engine', available: AV });
  const CTX = { actorEmail: 'accountant@example.com', contract: 'test', contractVersion: 1 };
  const cust = (await facts.recordParty(w.env, { kind: 'organisation', name: 'Patel', roles: ['customer'] }, CTX)).id;
  const q1 = await facts.recordDocument(w.env, { kind: 'quotation', direction: 'sell', partyId: cust, currency: 'ZAR', issuedOn: '2026-11-10', lines: L1 }, CTX);
  const rowOf = (id) => JSON.stringify([w.db.prepare('SELECT * FROM eng_document WHERE id = ?').get(id), w.db.prepare('SELECT * FROM eng_document_line WHERE document_id = ? ORDER BY id').all(id), w.db.prepare('SELECT * FROM eng_document_number WHERE document_id = ?').get(id)]);
  const before = rowOf(q1.id);
  const rv = await facts.reviseQuotation(w.env, { quotationId: q1.id, lines: L2, validUntil: '2026-12-24' }, CTX);
  check(Number.isInteger(rv.documentId) && rv.documentId !== q1.id && rv.number === 2, 'the fact layer revises a quotation into a new document with the next quotation number');
  check(rowOf(q1.id) === before, 'the replaced document, its lines and its number are byte-for-byte what they were: a revision never edits the old document');
  await facts.acceptQuotation(w.env, { quotationId: rv.documentId }, CTX);
  let integ = await verifyIntegrity(w.env);
  check(integ.ok === true && integ.problems.length === 0 && integ.warnings.length === 0, 'the integrity verifier is clean after a create, a revision and an acceptance, with no warning about an unmodelled event');
  w.db.prepare("INSERT INTO eng_event (type, payload_json) VALUES ('quotation.accepted', ?)").run(JSON.stringify({ documentId: 9999 }));
  integ = await verifyIntegrity(w.env);
  check(integ.ok === false && integ.problems.some((p) => p.code === 'orphan' && /9999/.test(p.detail)), 'an acceptance of a document that does not exist is REPORTED (orphan)');
  w.db.prepare("INSERT INTO eng_event (type, payload_json) VALUES ('quotation.revised', ?)").run(JSON.stringify({ documentId: rv.documentId, supersedes: 8888 }));
  integ = await verifyIntegrity(w.env);
  check(integ.problems.some((p) => p.code === 'orphan' && /8888/.test(p.detail)), 'a revision that replaces a document that does not exist is REPORTED (orphan)');
  const bad2 = kit.makeWorld(); bad2.configure({ mode: 'engine', available: AV });
  const c2 = (await facts.recordParty(bad2.env, { kind: 'organisation', name: 'P', roles: ['customer'] }, CTX)).id;
  const qA = await facts.recordDocument(bad2.env, { kind: 'quotation', direction: 'sell', partyId: c2, currency: 'ZAR', issuedOn: '2026-11-10', lines: L1 }, CTX);
  const qB = await facts.reviseQuotation(bad2.env, { quotationId: qA.id, lines: L2 }, CTX);
  bad2.db.prepare("INSERT INTO eng_event (type, payload_json) VALUES ('quotation.revised', ?)").run(JSON.stringify({ documentId: qB.documentId, supersedes: qA.id }));
  integ = await verifyIntegrity(bad2.env);
  check(integ.ok === false && integ.problems.some((p) => /more than once|twice|fork/i.test(p.detail)), 'a quotation replaced TWICE (a forked chain) is REPORTED by the verifier');
  // atomicity: a failure at each write of a revision leaves nothing behind
  const probe = kit.makeWorld(); probe.configure({ mode: 'engine', available: AV });
  const pc = (await facts.recordParty(probe.env, { kind: 'organisation', name: 'P', roles: ['customer'] }, CTX)).id;
  const pq = await facts.recordDocument(probe.env, { kind: 'quotation', direction: 'sell', partyId: pc, currency: 'ZAR', issuedOn: '2026-11-10', lines: L1 }, CTX);
  probe.resetWrites(); await facts.reviseQuotation(probe.env, { quotationId: pq.id, lines: L2 }, CTX); const writes = probe.writeCount();
  let leaked = [];
  for (let n = 1; n <= writes; n++) {
    const x = kit.makeWorld(); x.configure({ mode: 'engine', available: AV });
    const xc = (await facts.recordParty(x.env, { kind: 'organisation', name: 'P', roles: ['customer'] }, CTX)).id;
    const xq = await facts.recordDocument(x.env, { kind: 'quotation', direction: 'sell', partyId: xc, currency: 'ZAR', issuedOn: '2026-11-10', lines: L1 }, CTX);
    const was = JSON.stringify(x.counts()); x.failAt(n);
    let threw = false; try { await facts.reviseQuotation(x.env, { quotationId: xq.id, lines: L2 }, CTX); } catch { threw = true; }
    if (!threw || JSON.stringify(x.counts()) !== was) leaked.push(n);
  }
  check(writes >= 5 && leaked.length === 0, `revising is atomic: a failure at each of its ${writes} writes leaves no document, no line, no number and no event` + (leaked.length ? ' (leaked at ' + leaked.join(',') + ')' : ''));
  for (const [why, fn] of [['an unknown quotation', () => facts.acceptQuotation(w.env, { quotationId: 424242 }, CTX)], ['an invoice, not a quotation', () => facts.acceptQuotation(probe.env, { quotationId: 424242 }, CTX)], ['an accepted quotation revised', () => facts.reviseQuotation(w.env, { quotationId: rv.documentId, lines: L1 }, CTX)]]) {
    const was = JSON.stringify(w.counts()); let code = null; try { await fn(); } catch (e) { code = e && e.code; } check(code !== null && JSON.stringify(w.counts()) === was, `the fact layer itself refuses ${why} and writes nothing (${code})`);
  }
});

if (require.main === module) kit.standalone(module.exports);
