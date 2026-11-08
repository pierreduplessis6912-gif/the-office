// Mokoena receivables slice (branch engine-phase1), the BACKEND CONTRACT the visible slice stands on, in the world docs/decisions/first-slice.md section C defines: Mokoena has invoice #1 (R1,150.00), a R300.00 payment first recorded against
// Patel Builders by mistake and then corrected (a reversal and a replacement), so R850.00 is outstanding; Patel has invoice #2 (R460.00, unpaid) and must never appear in Mokoena's answer. The world is built by the engine's own sample-seed admin route
// (worker/src/engine/admin.ts) inside the route harness, so it is the same data the staging rehearsal uses. Walked through the engine's REAL routes on the harness (a stand-in for Durable Object storage, NOT staging, NOT production):
//   STAGE ONE   "What does Mokoena owe me?" (scripted) -> a permission-aware, evidence-bearing answer -> drill-down to the invoice, its payments and the correction -> back to the conversation (the shell's own state, not a server step).
//   STAGE TWO   "Record R500 from Mokoena" -> HELD, nothing recorded -> an authorised member approves -> R350.00 outstanding. A business WITHOUT the capability is answered honestly and writes only a capture and an observation.
// Evidence labels: every check is a TEST of the existing engine; a check that fails is a GAP the slice must close or a contract the shell must not assume. Characterisation of existing behaviour, not red-first.
const kit = require('./engine-kit.js');

module.exports = kit.guard('mokoena slice', async ({ check }) => {
  const ENV_A = { BUSINESS_ID: 'eng-a', ENGINE_REHEARSAL: '1' };
  const SEED = { admin: true, method: 'POST', path: '/admin/engine/provision-sample', body: { confirm: 'eng-a' } };
  const run = (spec) => kit.route({ env: ENV_A, ...spec, before: [SEED, ...(spec.before || [])] });
  const ask = (role, party = 'Mokoena') => ({ method: 'GET', path: `/engine/receivables?party=${encodeURIComponent(party)}`, role });
  const open = (role, kind, id) => ({ method: 'GET', path: `/engine/records/${kind}/${id}`, role });
  const r500 = { partyId: 1, amountMinor: 50000, currency: 'ZAR', occurredOn: '2026-11-07', method: 'eft', allocate: 'oldest_first' };
  const propose = (role, payload = r500, transcript = 'Record R500 from Mokoena') => ({ method: 'POST', path: '/engine/proposals', role, body: { capability: 'payment.record', payload, transcript } });
  const confirm = (role, id = 1) => ({ method: 'POST', path: `/actions/${id}/confirm`, role, body: {} });
  const added = (res, t) => ((res.writes && res.writes[t] && res.writes[t].added) || []).length;
  const addedTables = (res) => Object.keys(res.writes || {}).filter((t) => added(res, t) > 0).sort();
  const body = (res) => (res.result && res.result.body) || {};
  const text = (res) => JSON.stringify(body(res));
  const figures = ['85000', '115000', '30000', '46000'];
  const leaksFigure = (res) => figures.some((f) => text(res).includes(f));

  // ---- STAGE ONE: the question and the evidence-bearing answer --------------------------------------------------------------------------------------------------------------------------------
  const q = await run(ask('accountant'));
  const a = body(q).result || {};
  check(q.result && q.result.status === 200 && body(q).status === 'ok', 'an accountant asking what Mokoena owes gets an ok answer');
  check(a.party && a.party.id === 1 && a.party.name === 'Mokoena' && a.currency === 'ZAR' && a.totalMinor === 85000, 'the answer names the customer, the currency and the total: R850.00 outstanding');
  const l0 = (a.documents || [])[0] || {};
  check(Array.isArray(a.documents) && a.documents.length === 1 && l0.number === 1 && l0.grossMinor === 115000 && l0.allocatedMinor === 30000 && l0.outstandingMinor === 85000, 'carried by one document: invoice #1, R1,150.00 issued, R300.00 paid (the corrected payment), R850.00 outstanding');
  check(l0.ref && l0.ref.kind === 'document' && l0.ref.id === 1 && Number.isInteger(l0.grossMinor) && Number.isInteger(l0.outstandingMinor), 'the line carries a record reference to open and whole-number figures (nothing is a decimal the shell would have to compute)');
  check(!/Patel|Skirting/.test(text(q)) && !text(q).includes('46000'), 'Patel Builders and invoice #2 never appear in Mokoena\'s answer');
  check(Number.isInteger(a.version) && a.version > 0 && typeof a.derivedBy === 'string' && a.derivedBy.length > 0, 'the answer carries the version of the account it read and which derivation produced the figure (the provenance the engine gives today: a version and a free-text label, not structured source references)');
  check(a.documents && a.documents.reduce((s, d) => s + d.outstandingMinor, 0) === a.totalMinor, 'the lines add up to the total, so the shell never needs to calculate one');
  const keyNames = []; JSON.stringify(a, (k, v) => { if (k) keyNames.push(k); return v; });
  check(!keyNames.some((k) => /invoice|quote|sales|order/i.test(k)), 'the answer\'s field names are generic (party, document, kind), so the same shape can carry other domains: ' + [...new Set(keyNames)].join(', '));
  const patel = await run(ask('accountant', '2'));
  check(body(patel).result && body(patel).result.party.name === 'Patel Builders' && body(patel).result.totalMinor === 46000, 'Patel Builders (asked by number) owes R460.00 on invoice #2, which no payment has touched');

  // ---- permission-aware: a refusal reveals no figure -----------------------------------------------------------------------------------------------------------------------------------------
  for (const role of ['owner', 'admin']) { const r = await run(ask(role)); check(r.result && r.result.status === 200 && body(r).result && body(r).result.totalMinor === 85000, `${role} gets the same answer`); }
  for (const role of ['installer', 'sales']) {
    const r = await run(ask(role));
    check(r.result && r.result.status === 403 && !leaksFigure(r), `${role} is refused (403) and the refusal carries no figure`);
  }
  const nobody = await run(ask('accountant', 'Nobody'));
  check(nobody.result && nobody.result.status === 404 && !leaksFigure(nobody), 'an unknown customer answers not_found with no figure');
  // a name that matches two customers: asked of the receivables kit world (two customers called Mokoena), because the sample world has one
  const two = await kit.route({ env: { BUSINESS_ID: 'eng-a' }, ...ask('accountant'), seed: (db) => { kit.seedReceivables()(db); const e = Number(db.prepare("INSERT INTO eng_event (type, actor_email, contract, contract_version, payload_json) VALUES ('party.created', 'seed@example.com', 'seed', 1, ?) RETURNING id").get(JSON.stringify({ kind: 'organisation', name: 'Mokoena', roles: ['customer'] })).id); db.prepare("INSERT INTO eng_party (kind, name, event_id) VALUES ('organisation', 'Mokoena', ?)").run(e); db.prepare("INSERT INTO eng_party_role (party_id, role, event_id) VALUES (2, 'customer', ?)").run(e); } });
  check(two.result && body(two).status === 'ambiguous' && Array.isArray(body(two).candidates) && body(two).candidates.length === 2 && !/\d{5}/.test(text(two)), 'a name that matches two customers comes back ambiguous with both candidates and no figure, so the shell must ask which one');

  // ---- STAGE ONE: drill-down from the answer to the invoice, its payments and the correction -------------------------------------------------------------------------------------------
  const ref = l0.ref;
  const doc = ref ? await run(open('accountant', ref.kind, ref.id)) : null;
  const d = doc ? (body(doc).result || {}) : {};
  const field = (k) => ((d.fields || []).find((f) => f.key === k) || {}).value;
  check(doc && doc.result && doc.result.status === 200 && d.title === 'Invoice #1' && Number.isInteger(d.version) && d.version > 0, 'following the line\'s reference opens invoice #1, with its own version');
  console.log('  slice (information): a document record view has these top-level fields: ' + Object.keys(d).join(', '));
  check(field('grossMinor') === 115000 && field('allocatedMinor') === 30000 && field('outstandingMinor') === 85000, 'the invoice shows the same figures the answer summarised, so the drill-down agrees with the answer');
  const lines = (d.collections && d.collections.lines) || [];
  check(lines.length === 1 && lines[0].description === 'Vinyl plank' && lines[0].quantityMilli === 2000 && lines[0].unitPriceMinor === 50000, 'and the line beneath the figure: Vinyl plank, 2.000 m2 at R500.00');
  const allocs = (d.collections && d.collections.allocations) || [];
  check(allocs.length === 2 && allocs.filter((x) => x.effective).length === 1 && allocs.every((x) => x.amountMinor === 30000), 'its payments show the correction: the R300.00 first recorded against the wrong customer is kept as a reversed allocation and the corrected one stands (an effective allocation of R300.00)');
  const types = (d.history || []).map((h) => h.type);
  check(types.includes('document.issued') && types.includes('payment.allocation_reversed'), 'its history records the issue and the reversal: ' + types.join(', '));
  check(d.relations && d.relations.some((x) => x.role === 'customer' && x.ref.id === 1 && x.label === 'Mokoena'), 'it names its customer, the way back up');
  const mv = await run(open('accountant', 'movement', allocs.find((x) => !x.effective).movementId));
  check(mv.result && mv.result.status === 200 && JSON.stringify(body(mv).result.fields).includes('reversed'), 'the first payment opens as a record of its own and says it was reversed');
  const party = await run(open('accountant', 'party', 1));
  check(party.result && party.result.status === 200, 'the customer record opens too (the other way up from an invoice)');
  console.log('  slice (information): a party record view has these top-level fields: ' + Object.keys(body(party).result || {}).join(', '));
  const hidden = ref ? await run(open('installer', ref.kind, ref.id)) : null, absent = await run(open('installer', 'document', 99999));
  check(hidden && absent && hidden.result.status === absent.result.status && JSON.stringify(body(hidden)) === JSON.stringify(body(absent)), 'a record an installer may not see answers exactly as one that does not exist, so drill-down reveals nothing');

  // ---- STAGE TWO: "Record R500 from Mokoena": propose, hold, approve, see the result -------------------------------------------------------------------------------------------------------
  const proposed = await run(propose('accountant'));
  check(proposed.result && proposed.result.status === 200 && body(proposed).status === 'held' && Number.isInteger(body(proposed).actionId), 'proposing R500 from an accountant is HELD with an action number');
  check(added(proposed, 'eng_money_movement') === 0 && added(proposed, 'eng_allocation') === 0, 'and nothing is recorded yet: a proposal is not an approval');
  const pending = await run({ before: [propose('accountant')], method: 'GET', path: '/actions/pending', role: 'accountant' });
  const card = ((body(pending).pending || [])[0]) || {};
  let held = {}; try { held = JSON.parse(card.payload); } catch (e) { held = {}; }
  check(card.type === 'engine.payment.record' && card.source_transcript === 'Record R500 from Mokoena' && held.amountMinor === 50000 && held.partyId === 1 && JSON.stringify(held.allocations) === JSON.stringify([{ documentId: 1, amountMinor: 50000 }]) && held.basedOn && Number.isInteger(held.basedOn.partyVersion), 'what waits for approval carries the words said, the amount and the EXACT allocation (R500.00 to invoice #1), and the version of the account it was based on');
  console.log('  slice (information): the held payment names the customer and the invoice only by number (partyId, documentId); an approval card that shows names, type and total (audit D2) must read them through permission-checked record reads or a server projection that does not exist yet');
  const stillOwes = await run({ ...ask('accountant'), before: [propose('accountant')] });
  check(body(stillOwes).result && body(stillOwes).result.totalMinor === 85000, 'while it is held Mokoena still owes R850.00 (a held payment changes no figure)');
  const refused = await run(propose('installer'));
  check(refused.result && refused.result.status === 403 && body(refused).error === 'not_permitted' && JSON.stringify(addedTables(refused)) === JSON.stringify(['captures']), 'an installer cannot propose a payment (403, not_permitted): nothing is held or recorded, and only what was said is kept (a capture)');
  const approved = await run({ before: [propose('accountant')], ...confirm('accountant') });
  check(approved.result && approved.result.status === 200 && added(approved, 'eng_money_movement') === 1 && added(approved, 'eng_allocation') === 1, 'an accountant approving it records the payment and its allocation');
  const after = await run({ before: [propose('accountant'), confirm('accountant')], ...ask('accountant') });
  const n = body(after).result || {};
  const n0 = (n.documents || [])[0] || {};
  check(n.totalMinor === 35000 && n0.allocatedMinor === 80000 && n0.outstandingMinor === 35000, 'reading back afterwards, Mokoena owes R350.00 (R800.00 paid of R1,150.00)');
  check(n.version > a.version, 'the account\'s version has moved on, so an approval built on the old figures could not be replayed');
  const patelAfter = await run({ before: [propose('accountant'), confirm('accountant')], ...ask('accountant', '2') });
  check(body(patelAfter).result && body(patelAfter).result.totalMinor === 46000, 'and Patel Builders still owes R460.00: the payment touched nobody else');
  const docAfter = await run({ before: [propose('accountant'), confirm('accountant')], ...open('accountant', 'document', 1) });
  const htypes = ((body(docAfter).result || {}).history || []).map((h) => h.type);
  console.log('  slice (information): after approval the invoice\'s history reads: ' + htypes.join(', ') + ' (capture, interpretation, proposal and approval are NOT in it: the trace the first-slice criteria ask for is only partly there)');
  check(htypes.filter((t) => t === 'payment.allocated').length === 3 && htypes.filter((t) => t === 'payment.allocation_reversed').length === 1, 'the invoice\'s history now shows the new allocation after the original, its reversal and the corrected one');
  const cannot = await run({ before: [propose('accountant')], ...confirm('installer') });
  check(cannot.result && cannot.result.status === 403 && added(cannot, 'eng_money_movement') === 0, 'an installer cannot approve the held payment (403) and nothing is recorded');
  const stale = await run({ before: [propose('accountant'), propose('accountant', { ...r500, amountMinor: 10000 }, 'Record R100 from Mokoena'), confirm('accountant', 2)], ...confirm('accountant', 1) });
  check(stale.result && stale.result.status === 409 && body(stale).error === 'stale' && added(stale, 'eng_money_movement') === 0, 'approving after the account changed underneath is refused as stale: an approval is only for what it showed');

  // ---- PROVENANCE (invariant 6, docs/decisions/first-slice.md part E): capture, proposal and approval are linked by reference, and a record's history shows them --------------------------------------------------
  const capRows = (((proposed.writes || {}).captures || {}).added) || [];
  const capId = capRows[0] && capRows[0].id;
  const interp = ((((proposed.writes || {}).eng_interpretation || {}).added) || [])[0] || {};
  check(Number.isInteger(capId) && interp.capture_id === capId && interp.capability === 'payment.record' && interp.status === 'proposed' && interp.interpreter === 'script' && JSON.parse(interp.payload_json).actionId === body(proposed).actionId, 'the held payment is linked to the capture it came from through what was understood (an interpretation: the words, the capability, the proposal)');
  check(JSON.stringify(addedTables(proposed)) === JSON.stringify(['captures', 'eng_interpretation', 'pending_actions']), 'and a proposal writes only the capture, the interpretation and the held action: ' + addedTables(proposed).join(', '));
  const evs = (((approved.writes || {}).eng_event || {}).added) || [];
  check(evs.length >= 3 && evs.every((e) => e.capture_id === capId && e.proposal_id === 1 && typeof e.approved_by === 'string' && e.approved_by.length > 0 && e.contract === 'payment.record' && e.contract_version === 1), `every event the approval wrote (payment, allocation, execution: ${evs.length}) carries the capture, the proposal, the approver and the contract`);
  const trail = ((body(docAfter).result || {}).history || []);
  const last = trail.filter((h) => h.type === 'payment.allocated').pop() || {};
  check(last.captureId === capId && last.proposalId === 1 && typeof last.approvedBy === 'string' && last.approvedBy.length > 0 && last.contract === 'payment.record' && last.contractVersion === 1, 'the invoice\'s history shows that trail on the new allocation: capture, proposal, approver, contract and version');
  const issued = trail.find((h) => h.type === 'document.issued') || {};
  check('captureId' in issued && issued.captureId === null && issued.proposalId === null, 'while a fact written without a proposal (the seeded invoice) shows no capture or proposal rather than inventing one');
  const forged = await run(propose('accountant', { ...r500, captureId: 1 }));
  check(forged.result && forged.result.status === 422 && body(forged).error === 'invalid_payload' && JSON.stringify(addedTables(forged)) === JSON.stringify(['captures']), 'a client cannot name its own capture: a payload that carries one is refused as invalid, and only what was said is kept');

  // ---- BUSINESS B: the capability is not available; the request is answered honestly and only a capture and an observation are written ---------------------------------------------------------
  const offB = kit.asEngineBusiness((db) => db.prepare("INSERT INTO eng_config (key, value_json) VALUES ('available', '[]')").run());
  const bAsk = await kit.route({ env: { BUSINESS_ID: 'eng-b' }, seed: offB, ...ask('accountant') });
  check(bAsk.result && bAsk.result.status === 409 && body(bAsk).error === 'capability_unavailable' && !/\d{4}/.test(text(bAsk)) && addedTables(bAsk).length === 0, 'in a business without the capability the question is answered honestly (409, unavailable, no figure) and nothing is written');
  const bProp = await kit.route({ env: { BUSINESS_ID: 'eng-b' }, seed: offB, ...propose('accountant') });
  check(bProp.result && bProp.result.status === 409 && body(bProp).error === 'capability_unavailable' && JSON.stringify(addedTables(bProp)) === JSON.stringify(['captures', 'eng_observation']), '"Record R500" there is answered honestly too (409, unavailable) and ONLY a capture and an observation are written');

  // ---- the app's reader and the backend cannot drift apart unseen: the committed fixtures (read by app/test/slice_model_test.dart) must equal what the engine answers now --------------------------------------------
  const fixtures = require('./slice-fixtures.js'), fs = require('fs'), path = require('path');
  const now = await fixtures.build();
  const drifted = Object.entries(now).filter(([name, v]) => { try { return JSON.stringify(JSON.parse(fs.readFileSync(path.join(fixtures.DIR, name), 'utf8'))) !== JSON.stringify(v); } catch (e) { return true; } }).map(([name]) => name);
  check(drifted.length === 0, `every committed fixture equals the engine's answer now (${Object.keys(now).length} checked)` + (drifted.length ? '; DRIFTED: ' + drifted.join(', ') + ' (regenerate with node tools/slice-fixtures.js)' : ''));
  let dartNow = ''; try { dartNow = fs.readFileSync(fixtures.DART_FILE, 'utf8'); } catch (e) { dartNow = ''; }
  check(dartNow === fixtures.dartSource(now), 'and the Dart copy the demo entry point runs on (app/lib/engine/engine_fixtures.dart) equals them too (regenerate with node tools/slice-fixtures.js)');
});

if (require.main === module) kit.standalone(module.exports);
