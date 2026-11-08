// Engine operations (worker/src/engine, branch engine-phase1). TESTS FIRST. The five conditions an operation passes through are told apart and each fails on its own, for a different reason and a different answer:
//   UNDERSTOOD (the engine has such a capability)  AVAILABLE (this business has it)  PERMITTED (this member may use it)  VALID NOW (the facts allow it, and the approval is still for what it showed)  EXECUTED (authorised, atomic, once)
// and the same operation gives the same result through every entrance. Reads (receivables.query, records.get), the door (propose), drafts (create, save, issue) and the confirm through the REAL route are all covered.
// Expected state when first committed: RED (permissions, drafts, records, capabilities and operations do not exist yet).
const path = require('path');
const kit = require('./engine-kit.js');

module.exports = kit.guard('engine operations', async ({ check }) => {
  const eng = kit.loadEngine();
  check(Boolean(eng && eng.permissions && eng.drafts && eng.operations && eng.records), 'the engine exposes permissions, drafts, records and operations');
  if (!eng || !eng.permissions || !eng.drafts || !eng.operations || !eng.records) return;
  const { facts, ledger, permissions, drafts, operations } = eng;
  const auth = kit.bundle('auth.ts', 'auth');
  const contract = kit.bundle('capability-contract.ts', 'contract');
  const codeOf = async (fn) => { try { await fn(); return null; } catch (e) { return e && e.code ? e.code : 'threw:' + String(e && e.message).slice(0, 80); } };
  const member = (role) => ({ email: `${role}@example.com`, caps: auth.ROLE_CAPABILITIES[role] || [] });
  const CTX = { actorEmail: 'accountant@example.com', contract: 'test', contractVersion: 1 };

  // ---- PERMITTED: the adapter from today's capability names to the engine's own -----------------------------------------------------------------------------------------------------------------------
  const legacy = [...new Set(Object.values(auth.ROLE_CAPABILITIES).flat())].sort();
  const decided = new Set([...Object.keys(permissions.MAP), ...permissions.UNMAPPED]);
  check(legacy.every((c) => decided.has(c)) && [...decided].every((c) => legacy.includes(c)), `every legacy capability (${legacy.length}) is either mapped to engine permissions or deliberately listed as not an engine concern, and the lists name nothing that no longer exists: a new legacy capability FAILS here until someone decides`);
  const has = (role, p) => permissions.permissionsFor(member(role).caps).has(p);
  check(['owner', 'accountant', 'admin'].every((r) => has(r, 'receivables.read') && has(r, 'payment.record') && has(r, 'payment.correct') && has(r, 'invoice.issue')), 'owner, accountant and admin may read receivables and record, correct and issue');
  check(['installer', 'sales'].every((r) => !has(r, 'receivables.read') && !has(r, 'payment.record') && !has(r, 'payment.correct') && !has(r, 'invoice.issue')), 'an installer and a salesperson hold none of them');
  check(permissions.permissionsFor(['can_unknown_future_capability']).size === 0, 'a capability the adapter has never heard of grants nothing');

  // ---- a business in engine mode with receivables ----------------------------------------------------------------------------------------------------------------------------------------------------------
  const build = async (available) => {
    const w = kit.makeWorld(); w.configure({ mode: 'engine', available: available || kit.ALL_CAPABILITIES });
    const mokoena = (await facts.recordParty(w.env, { kind: 'person', name: 'Mokoena', roles: ['customer'] }, CTX)).id;
    const lines = (price, description) => [{ description, quantityMilli: 1000, unit: 'job', unitPriceMinor: price, taxBp: 1500 }];   // the same descriptions the seeded business uses, so the two can be compared
    const inv1 = await facts.recordDocument(w.env, { kind: 'invoice', direction: 'sell', partyId: mokoena, currency: 'ZAR', issuedOn: '2026-10-01', lines: lines(100000, 'Vinyl plank') }, CTX);   // gross 115000
    const inv2 = await facts.recordDocument(w.env, { kind: 'invoice', direction: 'sell', partyId: mokoena, currency: 'ZAR', issuedOn: '2026-10-15', lines: lines(20000, 'Skirting') }, CTX);    // gross 23000
    return { w, mokoena, inv1, inv2 };
  };
  const { w, mokoena, inv1, inv2 } = await build();
  const read = (role, capability, params, world = w) => operations.invokeRead(world.env, member(role), capability, params);

  // ---- DRAFTS: a working copy, validated on every save, issued into an immutable document ------------------------------------------------------------------------------------------------------
  const d = await drafts.createDraft(w.env, { kind: 'invoice', direction: 'sell', partyId: mokoena }, CTX);
  check(d.id > 0 && d.version === 1, 'a draft is created at version 1');
  const incomplete = await drafts.readDraft(w.env, d.id);
  check(incomplete.validation.ok === false && incomplete.validation.errors.length >= 3 && incomplete.validation.totals === null, 'an empty draft is valid to SAVE but not ready: it lists what is missing (no lines, no date, no currency) and has no total');
  const good = { currency: 'ZAR', issuedOn: '2026-11-03', lines: [{ description: 'Fitting', quantityMilli: 2000, unit: 'm2', unitPriceMinor: 30000, taxBp: 1500 }, { description: 'Trim', quantityMilli: 1000, unit: 'job', unitPriceMinor: 5000, taxBp: 0 }] };
  const saved = await drafts.saveDraft(w.env, d.id, { expectedVersion: 1, payload: good }, CTX);
  check(saved.version === 2 && saved.validation.ok === true && saved.validation.totals.grossMinor === 74000, 'saving recalculates: 2.000 x R300.00 + 15% tax + R50.00 = R740.00, and the version moves to 2');
  check((await codeOf(() => drafts.saveDraft(w.env, d.id, { expectedVersion: 1, payload: good }, CTX))) === 'stale', 'saving with an out-of-date version is refused as stale: nobody overwrites what they have not seen');
  const bad = await drafts.saveDraft(w.env, d.id, { expectedVersion: 2, payload: { ...good, lines: [{ description: '', quantityMilli: 1.5, unitPriceMinor: -5, taxBp: 99999 }] } }, CTX);
  check(bad.validation.ok === false && bad.validation.errors.some((e) => /lines\[0\]/.test(e.field)), 'a draft with a bad line saves (it is a draft) but is reported as not ready, field by field');
  await drafts.saveDraft(w.env, d.id, { expectedVersion: 3, payload: good }, CTX);
  check((await codeOf(() => drafts.issueDraft(w.env, d.id, { expectedVersion: 3 }, CTX))) === 'stale', 'issuing a draft that has changed since it was looked at is refused as stale');
  const before = w.counts();
  const issued = await drafts.issueDraft(w.env, d.id, { expectedVersion: 4 }, CTX);
  check(issued.number === 3 && issued.totals.grossMinor === 74000, 'issuing creates the document, takes the next invoice number (3) and keeps the draft\'s total');
  check(w.changedTables(before).includes('eng_document') && w.changedTables(before).includes('eng_document_line') && w.changedTables(before).includes('eng_document_number'), 'and it is an ordinary immutable document with its lines and number');
  check((await codeOf(() => drafts.saveDraft(w.env, d.id, { expectedVersion: 5, payload: good }, CTX))) === 'invalid_state' && (await codeOf(() => drafts.issueDraft(w.env, d.id, { expectedVersion: 5 }, CTX))) === 'invalid_state', 'an issued draft is closed: it cannot be saved or issued again');
  // issuing is atomic: a failure at each write leaves no document, no number, and the draft still open
  const issueProbe = await build(); const dd = await drafts.createDraft(issueProbe.w.env, { kind: 'invoice', direction: 'sell', partyId: issueProbe.mokoena }, CTX); await drafts.saveDraft(issueProbe.w.env, dd.id, { expectedVersion: 1, payload: good }, CTX);
  issueProbe.w.resetWrites(); await drafts.issueDraft(issueProbe.w.env, dd.id, { expectedVersion: 2 }, CTX); const issueWrites = issueProbe.w.writeCount();
  let leaked = [];
  for (let n = 1; n <= issueWrites; n++) {
    const x = await build(); const x2 = await drafts.createDraft(x.w.env, { kind: 'invoice', direction: 'sell', partyId: x.mokoena }, CTX); await drafts.saveDraft(x.w.env, x2.id, { expectedVersion: 1, payload: good }, CTX);
    const was = JSON.stringify(x.w.counts()); const draftBefore = JSON.stringify(x.w.db.prepare('SELECT * FROM eng_draft WHERE id = ?').get(x2.id)); x.w.failAt(n);
    const code = await codeOf(() => drafts.issueDraft(x.w.env, x2.id, { expectedVersion: 2 }, CTX));
    if (code === null || JSON.stringify(x.w.counts()) !== was || JSON.stringify(x.w.db.prepare('SELECT * FROM eng_draft WHERE id = ?').get(x2.id)) !== draftBefore) leaked.push(n);
  }
  check(issueWrites >= 5 && leaked.length === 0, `issuing a draft is atomic: a failure at each of its ${issueWrites} writes leaves no document, no number and the draft still open` + (leaked.length ? ' (leaked at ' + leaked.join(',') + ')' : ''));

  // ---- AVAILABLE / PERMITTED / VALID: reads, each failing for its own reason ------------------------------------------------------------------------------------------------------------------------
  const acct = await read('accountant', 'receivables.query', { partyId: mokoena });
  check(acct.status === 'ok' && acct.result.totalMinor === 115000 + 23000 + 74000 && acct.result.documents.length === 3, 'receivables.query answers from the ledger: R1,150.00 + R230.00 + R740.00 = R2,120.00 outstanding over three invoices');
  check(acct.result.derivedBy === 'ledger.outstandingForParty' && Number.isInteger(acct.result.version) && acct.result.party.name === 'Mokoena', 'and says how it was derived and which version of the account it is');
  check(JSON.stringify((await read('accountant', 'receivables.query', { partyName: 'mokoena' })).result) === JSON.stringify(acct.result), 'a customer can be named instead of numbered (case does not matter) and gives the same answer');
  await facts.recordParty(w.env, { kind: 'person', name: 'Mokoena Junior', roles: ['customer'] }, CTX);
  const amb = await read('accountant', 'receivables.query', { partyName: 'Mokoena' });
  check(amb.status === 'ok' || amb.status === 'ambiguous', 'a name that is an exact match still answers');
  const amb2 = await read('accountant', 'receivables.query', { partyName: 'Moko' });
  check(amb2.status === 'refused' && amb2.code === 'not_found', 'a partial name is not guessed at: it matches nothing');
  const r1 = await read('installer', 'receivables.query', { partyId: mokoena });
  check(r1.status === 'refused' && r1.code === 'not_permitted' && !JSON.stringify(r1).includes('115000'), 'an installer is refused (not_permitted) and the refusal reveals no figure');
  const noCap = await build(['records.get']);
  const r2 = await operations.invokeRead(noCap.w.env, member('accountant'), 'receivables.query', { partyId: noCap.mokoena });
  check(r2.status === 'refused' && r2.code === 'capability_unavailable', 'in a business that does not have the capability it is refused as UNAVAILABLE (a different answer from not permitted)');
  check((await read('accountant', 'receivables.query', { partyId: 'x' })).code === 'invalid_payload' && (await read('accountant', 'receivables.query', {})).code === 'invalid_payload' && (await read('accountant', 'receivables.query', { partyId: 1, extra: 1 })).code === 'invalid_payload', 'bad or surplus parameters are refused as invalid, not guessed at');
  check((await read('accountant', 'receivables.query', { partyId: 99999 })).code === 'not_found', 'a customer that does not exist is not_found');
  check((await read('accountant', 'nonsense.capability', {})).code === 'unknown_capability', 'a capability the engine has never heard of is unknown, not unavailable');
  const reasons = new Set([r1.code, r2.code, 'invalid_payload', 'not_found', 'unknown_capability']);
  check(reasons.size === 5, 'understood, available, permitted, valid and found fail with five DIFFERENT answers');

  // ---- records.get: one record contract for every consumer -----------------------------------------------------------------------------------------------------------------------------------------------
  const doc = await read('accountant', 'records.get', { kind: 'document', id: inv1.id });
  check(doc.status === 'ok' && doc.result.ref.kind === 'document' && doc.result.version > 0, 'records.get returns a record view with its identity and version');
  const f = (v, k) => (v.fields.find((x) => x.key === k) || {}).value;
  check(f(doc.result, 'grossMinor') === 115000 && f(doc.result, 'outstandingMinor') === 115000 && f(doc.result, 'number') === 1, 'an invoice shows its number and its derived amounts');
  check(doc.result.fields.filter((x) => x.derivedBy).length >= 2 && doc.result.fields.find((x) => x.key === 'outstandingMinor').derivedBy === 'ledger.outstandingForDocument', 'every derived figure says which derivation produced it');
  check(doc.result.collections.lines.length === 1 && doc.result.relations.some((x) => x.role === 'customer' && x.ref.kind === 'party' && x.ref.id === mokoena), 'it carries its lines and a navigable relation to the customer');
  check(doc.result.actions.some((a) => a.capability === 'payment.record' && a.valid === true), 'and the actions this member may take now, each with whether it is valid');
  const reader = await read('installer', 'records.get', { kind: 'document', id: inv1.id });
  const missing = await read('installer', 'records.get', { kind: 'document', id: 99999 });
  check(JSON.stringify(reader) === JSON.stringify(missing) && reader.status === 'refused' && reader.code === 'not_found', 'a record the member may not see is INDISTINGUISHABLE from one that does not exist: identical answers for the installer\'s request to see invoice 1 and invoice 99999');
  const party = await read('accountant', 'records.get', { kind: 'party', id: mokoena });
  check(f(party.result, 'outstandingMinor') === 212000 && party.result.collections.documents.length === 3 && party.result.relations.filter((x) => x.ref.kind === 'document').length === 3, 'a customer\'s view is their statement: the invoices, what is outstanding, each one a relation to follow');
  check((await read('accountant', 'records.get', { kind: 'spaceship', id: 1 })).code === 'invalid_payload' && (await read('accountant', 'records.get', { kind: 'document', id: 0 })).code === 'invalid_payload', 'an unknown kind or a bad id is invalid');

  // ---- the DOOR: what was said is kept first, then the request is answered honestly ---------------------------------------------------------------------------------------------------------------------------
  const prop = (world, role, capability, payload, transcript = 'Mokoena paid five hundred rand') => eng.operations.proposeCapabilityAs(world.env, member(role), { capability, payload, transcript, source: 'text' });
  const pay = { partyId: mokoena, amountMinor: 50000, currency: 'ZAR', occurredOn: '2026-11-04', method: 'eft', allocate: 'oldest_first' };
  let b = w.counts(); let p = await prop(w, 'accountant', 'payment.record', pay);
  check(p.status === 'held' && Number.isInteger(p.actionId), 'a valid proposal from a permitted member where the capability is available is held for approval');
  check(JSON.stringify(w.changedTables(b)) === JSON.stringify(['captures', 'eng_interpretation', 'pending_actions']), 'and writes only the capture, what was understood from it and the held action: ' + w.changedTables(b).join(', '));
  { const it = w.db.prepare('SELECT * FROM eng_interpretation').all(); check(it.length === 1 && it[0].capture_id === Number(w.db.prepare('SELECT id FROM captures ORDER BY id DESC LIMIT 1').get().id) && it[0].capability === 'payment.record' && it[0].status === 'proposed' && JSON.parse(it[0].payload_json).actionId === p.actionId, 'the interpretation names the capture, the capability and the held action (invariant 6: the trail from what was said to the proposal)'); }
  const held = JSON.parse(w.db.prepare('SELECT payload FROM pending_actions WHERE id = ?').get(p.actionId).payload);
  check(Array.isArray(held.allocations) && held.allocations.length === 1 && held.allocations[0].documentId === inv1.id && held.allocations[0].amountMinor === 50000 && !('allocate' in held), 'the held action carries the EXACT allocations the approver will be approving (oldest invoice first), not an instruction to work them out later');
  check(Number.isInteger(held.basedOn && held.basedOn.partyVersion) && held.basedOn.partyVersion > 0, 'and the version of the account it was based on');
  b = w.counts(); p = await prop(w, 'installer', 'payment.record', pay);
  check(p.status === 'refused' && p.code === 'not_permitted' && JSON.stringify(w.changedTables(b)) === JSON.stringify(['captures']), 'a member who may not record payments is refused at the door; only what was said is kept (captures)');
  b = w.counts(); p = await prop(w, 'accountant', 'payment.record', { ...pay, amountMinor: 1.5 });
  check(p.status === 'refused' && p.code === 'invalid_payload' && JSON.stringify(w.changedTables(b)) === JSON.stringify(['captures']), 'a malformed payload is refused as invalid; only the capture is kept');
  b = w.counts(); p = await prop(w, 'accountant', 'payment.record', { ...pay, allocate: undefined, allocations: [{ documentId: inv2.id, amountMinor: 99999999 }] });
  check(p.status === 'refused' && p.code === 'over_allocated' && JSON.stringify(w.changedTables(b)) === JSON.stringify(['captures']), 'a proposal the facts cannot support (more than the invoice owes) is refused as INVALID NOW at the door');
  b = w.counts(); p = await prop(w, 'accountant', 'invent.something', {});
  check(p.status === 'refused' && p.code === 'unknown_capability' && JSON.stringify(w.changedTables(b)) === JSON.stringify(['captures', 'eng_observation']), 'a request for something the engine cannot do writes the capture and an OBSERVATION (a possible unmet need), and invents nothing: ' + w.changedTables(b).join(', '));
  check(w.db.prepare("SELECT kind, status FROM eng_observation ORDER BY id DESC LIMIT 1").get().kind === 'unsupported', 'the observation says it was unsupported, and is open');
  const off = await build(['receivables.query']);
  b = off.w.counts(); p = await eng.operations.proposeCapabilityAs(off.w.env, member('accountant'), { capability: 'payment.record', payload: pay, transcript: 'Mokoena paid five hundred rand', source: 'text' });
  check(p.status === 'refused' && p.code === 'capability_unavailable' && JSON.stringify(off.w.changedTables(b)) === JSON.stringify(['captures', 'eng_observation']) && off.w.db.prepare("SELECT kind FROM eng_observation").get().kind === 'unavailable', 'an unavailable capability writes only the capture and an observation (unavailable): nothing is held, nothing recorded');

  // ---- EXECUTED: through the REAL route, the held action confirmed by a member ------------------------------------------------------------------------------------------------------------------------
  const ENV = { BUSINESS_ID: 'eng-a' };
  const propose = (role, payload, capability = 'payment.record') => ({ method: 'POST', path: '/engine/proposals', role, body: { capability, payload, transcript: 'Mokoena paid five hundred rand' } });
  const confirm = (role, id = 1) => ({ method: 'POST', path: `/actions/${id}/confirm`, role, body: {} });
  const run = (spec) => kit.route({ env: ENV, seed: kit.seedReceivables(), ...spec });
  let r = await run({ before: [propose('accountant', pay)], ...confirm('accountant') });
  const added = (res, t) => ((res.writes && res.writes[t] && res.writes[t].added) || []).length;
  check(r.result && r.result.status === 200 && added(r, 'eng_money_movement') === 1 && added(r, 'eng_allocation') === 1, `an accountant confirming the held payment records it and its allocation (${r.result && r.result.status}, ${added(r, 'eng_money_movement')} payment, ${added(r, 'eng_allocation')} allocation)`);
  const events = ((r.writes && r.writes.eng_event && r.writes.eng_event.added) || []).map((e) => e.type);
  check(events.includes('payment.recorded') && events.includes('payment.allocated') && events.filter((t) => t === 'operation.executed').length === 1, 'the trail records the payment, the allocation and exactly one execution: ' + events.join(', '));
  const exec = ((r.writes.eng_event.added) || []).find((e) => e.type === 'operation.executed');
  check(exec && exec.actor_email === 'accountant@example.com' && exec.proposal_id === 1 && exec.contract === 'payment.record', 'and says who approved it, which proposal and which contract');
  r = await run({ before: [propose('accountant', pay)], ...confirm('installer') });
  check(r.result && r.result.status === 403 && added(r, 'eng_money_movement') === 0, `an installer cannot confirm it: refused ${r.result && r.result.status}, nothing recorded`);
  r = await run({ before: [propose('accountant', pay), propose('accountant', { ...pay, amountMinor: 20000 }), confirm('accountant', 2)], ...confirm('accountant', 1) });
  check(r.result && r.result.status === 409 && r.result.body.error === 'stale' && added(r, 'eng_money_movement') === 0 && !(r.writes && r.writes.pending_actions), `an approval is only for what it showed: confirming after the account changed is refused as STALE (${r.result && r.result.status} ${r.result && r.result.body && r.result.body.error}), and the action stays pending`);
  r = await kit.route({ env: ENV, seed: kit.seedReceivables(['payment.record']), before: [propose('accountant', pay)], ...confirm('accountant') });
  const sealed = r.result && r.result.status === 200;
  r = await kit.route({ env: ENV, seed: (db) => { kit.seedReceivables()(db); db.prepare("UPDATE eng_config SET value_json = '[\"receivables.query\"]' WHERE key = 'available'").run(); db.prepare("INSERT INTO pending_actions (id, type, payload, source_transcript) VALUES (1, 'engine.payment.record', ?, 'x')").run(JSON.stringify({ partyId: 1, amountMinor: 100, currency: 'ZAR', occurredOn: '2026-11-04', allocations: [], basedOn: { partyVersion: 1 } })); }, ...confirm('accountant') });
  check(sealed && r.result && r.result.status === 409 && r.result.body.error === 'capability_unavailable' && added(r, 'eng_money_movement') === 0, `a capability switched off after it was proposed is refused at confirm as UNAVAILABLE (${r.result && r.result.body && r.result.body.error})`);
  r = await kit.route({ env: ENV, seed: (db) => { kit.seedReceivables()(db); db.prepare("INSERT INTO pending_actions (id, type, payload, source_transcript) VALUES (1, 'engine.payment.record', ?, 'x')").run(JSON.stringify({ partyId: 1, amountMinor: 1.5, currency: 'ZAR', occurredOn: '2026-11-04', allocations: [], basedOn: { partyVersion: 1 } })); }, ...confirm('accountant') });
  check(r.result && r.result.status === 422 && r.result.body.error === 'invalid_payload' && added(r, 'eng_money_movement') === 0, 'a held action written DIRECTLY with a bad payload is refused at confirm (invalid_payload), not executed');
  // ATOMIC: the confirm is one unit with the confirmation. On the REAL confirm function with real transactions (every backend): a failure injected at each of its writes leaves no payment, allocation or event, and the action still pending.
  const confirmUnit = async (failAt) => {
    const x = await build();
    const door = await eng.operations.proposeCapabilityAs(x.w.env, member('accountant'), { capability: 'payment.record', payload: { ...pay, partyId: x.mokoena }, transcript: 'Mokoena paid five hundred rand', source: 'text' });
    const action = x.w.db.prepare('SELECT id, payload FROM pending_actions WHERE id = ?').get(door.actionId);
    const was = JSON.stringify(x.w.counts()); const statusBefore = x.w.db.prepare('SELECT status FROM pending_actions WHERE id = ?').get(door.actionId).status;
    if (failAt) x.w.failAt(failAt); else x.w.resetWrites();
    let out = null, threw = null;
    try { out = await contract.executeThroughContract(x.w.env, contract.contractForHeldType('engine.payment.record'), { id: action.id, payload: action.payload }, member('accountant')); } catch (e) { threw = e; }
    return { x, out, threw, was, statusBefore, writes: x.w.writeCount(), after: () => JSON.stringify(x.w.counts()), status: () => x.w.db.prepare('SELECT status FROM pending_actions WHERE id = ?').get(door.actionId).status };
  };
  const okRun = await confirmUnit(0);
  check(okRun.out && okRun.out.status === 200 && okRun.status() === 'confirmed' && okRun.writes >= 6, `the confirm function succeeds and makes ${okRun.writes} writes (the counting run)`);
  const unitLeaks = [];
  for (let n = 1; n <= okRun.writes; n++) { const f = await confirmUnit(n); if (!f.threw || f.after() !== f.was || f.status() !== f.statusBefore) unitLeaks.push(n); }
  check(unitLeaks.length === 0, `the confirm is atomic: a failure at each of its ${okRun.writes} writes leaves no payment, allocation, event or confirmation` + (unitLeaks.length ? ' (leaked at ' + unitLeaks.join(',') + ')' : ''));
  // executing the SAME approval twice cannot record twice. The first defence is the version: after one execution the account has changed, so a replay is refused as stale.
  const twice = await confirmUnit(0);
  const savedPayload = twice.x.w.db.prepare('SELECT payload FROM pending_actions WHERE id = 1').get().payload;
  const again = await contract.executeThroughContract(twice.x.w.env, contract.contractForHeldType('engine.payment.record'), { id: 1, payload: savedPayload }, member('accountant'));
  check(again.status === 409 && twice.x.w.count('eng_money_movement') === 1, `a replayed approval is refused (${again.status} ${again.body && again.body.error}) and records nothing: still one payment`);
  // The second defence stands on its own: a held action written WITHOUT a version stamp passes the version check, executes its payment, and is then stopped by the one-execution-per-proposal rule, which rolls it all back.
  const unstamped = await confirmUnit(0);
  const bare = JSON.parse(unstamped.x.w.db.prepare('SELECT payload FROM pending_actions WHERE id = 1').get().payload); delete bare.basedOn;
  const paymentsBefore = unstamped.x.w.count('eng_money_movement'), eventsBefore = unstamped.x.w.count('eng_event');
  const replay = await contract.executeThroughContract(unstamped.x.w.env, contract.contractForHeldType('engine.payment.record'), { id: 1, payload: JSON.stringify(bare) }, member('accountant'));
  check(replay.status === 409 && replay.body.error === 'already_executed' && unstamped.x.w.count('eng_money_movement') === paymentsBefore && unstamped.x.w.count('eng_event') === eventsBefore, `with no version stamp the one-execution rule stops it (${replay.status} ${replay.body && replay.body.error}) and the whole attempt is rolled back`);
  if (process.env.HARNESS_BACKEND === 'do') {
    // through the route too: the route harness has transactions only on the Durable Object step (as in the capability proof)
    const counted = await run({ before: [propose('accountant', pay)], ...confirm('accountant'), failAtWrite: 0 });
    let routeLeaks = [];
    for (let n = 1; n <= counted.writeCount; n++) {
      const f2 = await run({ before: [propose('accountant', pay)], ...confirm('accountant'), failAtWrite: n });
      if (added(f2, 'eng_money_movement') + added(f2, 'eng_allocation') + added(f2, 'eng_event') > 0) routeLeaks.push(n);
    }
    check(counted.writeCount >= 6 && routeLeaks.length === 0, `through the real route, a failure at each of the ${counted.writeCount} writes of the confirm leaves nothing behind` + (routeLeaks.length ? ' (leaked at ' + routeLeaks.join(',') + ')' : ''));
  } else console.log('  engine operations: the route-level failure-injection loop needs transactions, so it runs on the Durable Object adapter step only');

  // ---- the SAME operation through two entrances gives the same result ---------------------------------------------------------------------------------------------------------------------------------
  // The seeded business and a world built through the engine's own functions hold the same two invoices recorded in the same order, so the answers must be IDENTICAL, down to the version.
  const viaRoute = await kit.route({ env: ENV, seed: kit.seedReceivables(), method: 'GET', path: '/engine/receivables?party=1', role: 'accountant' });
  const fn = await build(); const viaFunction = await operations.invokeRead(fn.w.env, member('accountant'), 'receivables.query', { partyId: 1 });
  check(viaRoute.result && viaRoute.result.status === 200 && viaFunction.status === 'ok', 'the receivables route answers 200 and the function answers ok');
  check(viaRoute.result && JSON.stringify(viaRoute.result.body.result) === JSON.stringify(viaFunction.result) && viaFunction.result.totalMinor === 138000, 'the route and the function return the IDENTICAL result for the same facts (one operation, one result, whichever entrance: R1,380.00 outstanding)');
  const recordRoute = await kit.route({ env: ENV, seed: kit.seedReceivables(), method: 'GET', path: '/engine/records/document/1', role: 'accountant' });
  const recordFn = await operations.invokeRead(fn.w.env, member('accountant'), 'records.get', { kind: 'document', id: 1 });
  const strip = (v) => JSON.stringify({ ...v, history: undefined });   // event timestamps differ between two worlds; everything else must not
  check(recordRoute.result && recordRoute.result.status === 200 && strip(recordRoute.result.body.result) === strip(recordFn.result), 'a record view through the route equals the same view through the function (apart from the clock times in its history)');
  const denied = await kit.route({ env: ENV, seed: kit.seedReceivables(), method: 'GET', path: '/engine/receivables?party=1', role: 'installer' });
  check(denied.result && denied.result.status === 403 && !JSON.stringify(denied.result.body).includes('115000'), 'and an installer is refused at the route as well, with no figure in the answer');
  const hidden = await kit.route({ env: ENV, seed: kit.seedReceivables(), method: 'GET', path: '/engine/records/document/1', role: 'installer' });
  const absent = await kit.route({ env: ENV, seed: kit.seedReceivables(), method: 'GET', path: '/engine/records/document/99999', role: 'installer' });
  check(hidden.result && absent.result && hidden.result.status === absent.result.status && JSON.stringify(hidden.result.body) === JSON.stringify(absent.result.body), 'through the route too, a record an installer may not see answers exactly as one that does not exist (same status, same body)');
});

if (require.main === module) kit.standalone(module.exports);
