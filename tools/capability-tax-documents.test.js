// Tax documents and periods (branch engine-phase1): the business profile, the recipient's VAT number, the tax lock date, and the document completeness check. TESTS FIRST. Evidence label for every check: TEST of the engine on the route
// harness (NOT staging, NOT production). Expected state when first committed: RED. Decisions and research: docs/decisions/credit-note-follow-ups.md, points 1, 2 and 3.
// In short: a business keeps its own legal particulars (name, address, VAT number, company registration number) as a held write by the OWNER; a customer may carry a VAT number; a TAX LOCK DATE can only move forward, and invoices and
// credit notes must be dated after it; and a derived COMPLETENESS check lists exactly which prescribed particulars a tax document still lacks (it flags, it never blocks issuing; it is the gate for any future send).
const kit = require('./engine-kit.js');

module.exports = kit.guard('tax documents and periods', async ({ check }) => {
  const eng = kit.loadEngine();
  check(Boolean(eng && eng.permissions && eng.capabilities && eng.facts && eng.business), 'the engine exposes permissions, capabilities, facts and the business module');
  if (!eng || !eng.permissions || !eng.business) return;
  const auth = kit.bundle('auth.ts', 'auth');
  const member = (role) => ({ email: `${role}@example.com`, caps: auth.ROLE_CAPABILITIES[role] || [] });
  const AV = [...kit.ALL_CAPABILITIES, 'party.create', 'party.edit', 'credit_note.issue', 'business.profile.set', 'tax_lock.set', 'business.get'];
  const ENV = { BUSINESS_ID: 'eng-a' };
  const run = (spec) => kit.route({ env: ENV, seed: kit.seedReceivables(AV), ...spec });
  const propose = (role, capability, payload, transcript = 'a sentence from the person') => ({ method: 'POST', path: '/engine/proposals', role, body: { capability, payload, transcript } });
  const confirm = (role, id = 1) => ({ method: 'POST', path: `/actions/${id}/confirm`, role, body: {} });
  const get = (role, path) => ({ method: 'GET', path, role });
  const added = (res, t) => ((res.writes && res.writes[t] && res.writes[t].added) || []).length;
  const body = (res) => (res.result && res.result.body) || {};
  const status = (res) => res.result && res.result.status;
  const FACTS = ['eng_party', 'eng_party_role', 'eng_document', 'eng_document_line', 'eng_document_number', 'eng_money_movement', 'eng_allocation', 'eng_reversal'];
  const touchesNoFact = (res) => FACTS.every((t) => added(res, t) === 0);
  const fieldOf = (v, k) => ((v.fields || []).find((f) => f.key === k) || {}).value;
  const seq = () => { let n = 0; const steps = []; const api = { steps,
    prop(cap, payload, role = 'owner') { n += 1; steps.push(propose(role, cap, payload, `(${cap})`)); return n; },
    ok(id, role = 'owner') { steps.push(confirm(role, id)); return api; },
    do(cap, payload, role = 'owner') { const id = api.prop(cap, payload, role); api.ok(id, role); return id; } }; return api; };
  const profile = { legalName: 'Zululand Flooring and Blinds (Pty) Ltd', address: '5 Industrial Road, Empangeni, 3880', vatRegistered: true, vatNumber: '4123456789', companyRegistrationNumber: '2019/123456/07' };
  const credit = (extra = {}) => ({ invoiceId: 1, reason: 'Boards damaged on delivery', issuedOn: '2026-11-10', lines: [{ invoiceLineNo: 1, quantityMilli: 500, unitPriceMinor: 100000 }], ...extra });

  // ---- 1. PERMISSIONS: owner only (the engine's own vocabulary, decided for every role) -----------------------------------------------------------------------------------------------------------
  const has = (role, p) => eng.permissions.permissionsFor(member(role).caps).has(p);
  check(has('owner', 'business.manage'), 'the owner may set the business profile and the tax lock');
  check(['accountant', 'sales', 'installer'].every((r) => !has(r, 'business.manage')), 'no other role may (the legacy capability behind it, can_manage_settings, can never be granted to another role)');
  check(['business.profile.set', 'tax_lock.set', 'business.get'].every((c) => eng.capabilities.CAPABILITY_IDS.includes(c)), 'the three capabilities exist in the engine');

  // ---- 2. THE BUSINESS PROFILE ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  let r = await run(get('owner', '/engine/business'));
  check(status(r) === 200 && (body(r).result || {}).profile && (body(r).result.profile.legalName ?? null) === null && body(r).result.taxLockDate === null, 'a business that has set nothing has no profile and no tax lock');
  r = await run(propose('owner', 'business.profile.set', profile, 'Our company is Zululand Flooring and Blinds, VAT number 4123456789'));
  check(status(r) === 200 && body(r).status === 'held' && added(r, 'eng_event') === 0 && touchesNoFact(r), 'proposing a business profile is HELD and records nothing');
  const setP = seq(); setP.do('business.profile.set', profile);
  r = await run({ before: setP.steps.slice(0, 1), ...confirm('owner', 1) });
  check(status(r) === 200 && added(r, 'eng_event') === 2 && touchesNoFact(r), 'approving it records the business.profile_set event and the execution, and NO fact row');
  r = await run({ before: setP.steps, ...get('owner', '/engine/business') });
  const bp = (body(r).result || {}).profile || {};
  check(bp.legalName === profile.legalName && bp.address === profile.address && bp.vatRegistered === true && bp.vatNumber === '4123456789' && bp.companyRegistrationNumber === '2019/123456/07', 'the profile is read back exactly as set');
  const edit = seq(); edit.do('business.profile.set', profile); edit.do('business.profile.set', { address: '9 New Street, Empangeni', companyRegistrationNumber: null });
  r = await run({ before: edit.steps, ...get('owner', '/engine/business') });
  check(body(r).result.profile.address === '9 New Street, Empangeni' && (body(r).result.profile.companyRegistrationNumber ?? null) === null && body(r).result.profile.legalName === profile.legalName, 'a later change replaces only what it names, and null clears a field; the history of earlier profiles is kept as events');
  const badProfile = [
    [{ ...profile, colour: 'blue' }, 'a field nobody declared'], [{ ...profile, legalName: '' }, 'a blank legal name'], [{ ...profile, legalName: 'x'.repeat(121) }, 'a legal name over 120 characters'], [{ ...profile, vatNumber: '123' }, 'a VAT number that is not 10 digits'],
    [{ ...profile, vatNumber: '5123456789' }, 'a VAT number that does not begin with 4'], [{ ...profile, vatNumber: '41234567AB' }, 'a VAT number with letters'], [{ ...profile, companyRegistrationNumber: '2019-123456-07' }, 'a company registration number in the wrong format'],
    [{ ...profile, vatRegistered: 'yes' }, 'vatRegistered that is not true or false'], [{}, 'nothing to change'], [null, 'no payload at all'],
  ];
  for (const [payload, why] of badProfile) { r = await run(propose('owner', 'business.profile.set', payload)); check(status(r) === 422 && body(r).error === 'invalid_payload' && added(r, 'eng_event') === 0, `${why} is refused at the door as invalid_payload (${status(r)} ${body(r).error})`); }
  r = await run(propose('owner', 'business.profile.set', { vatRegistered: true }));
  check(status(r) === 409 && body(r).error === 'invalid_state', 'saying the business is VAT registered without a VAT number is refused as invalid_state');
  r = await run({ before: setP.steps, ...propose('owner', 'business.profile.set', { vatRegistered: false }) });
  check(status(r) === 200 && body(r).status === 'held', 'saying it is not VAT registered is allowed (the number may then stay on record)');
  for (const role of ['accountant', 'sales', 'installer']) { r = await run(propose(role, 'business.profile.set', profile)); check(status(r) === 403 && added(r, 'eng_event') === 0, `${role} may not propose a business profile: refused 403`); }
  r = await run({ before: [propose('owner', 'business.profile.set', profile)], ...confirm('accountant', 1) }); check(status(r) === 403 && added(r, 'eng_event') === 0, 'an accountant cannot approve one either');
  r = await run(get('accountant', '/engine/business')); check(status(r) === 403, 'only the owner may read the business settings through this door');
  r = await kit.route({ env: ENV, seed: kit.seedReceivables(kit.ALL_CAPABILITIES), ...propose('owner', 'business.profile.set', profile) });
  check(status(r) === 409 && body(r).error === 'capability_unavailable', 'a business without the capability is told so');

  // ---- 3. THE RECIPIENT'S VAT NUMBER (on the customer) ----------------------------------------------------------------------------------------------------------------------------------------------------
  const cust = seq(); cust.do('party.create', { kind: 'organisation', name: 'Patel Builders', roles: ['customer'], contact: { vatNumber: '4987654321', address: '12 Main Road, Empangeni' } }, 'accountant');
  r = await run({ before: cust.steps, ...get('accountant', '/engine/records/party/2') });
  check(fieldOf(body(r).result || {}, 'vatNumber') === '4987654321', 'a customer can carry a VAT number, and the record shows it');
  r = await run(propose('accountant', 'party.create', { kind: 'organisation', name: 'X', roles: ['customer'], contact: { vatNumber: 'no' } }));
  check(status(r) === 422 && body(r).error === 'invalid_payload', 'a VAT number that is too short is refused');
  r = await run(propose('accountant', 'party.create', { kind: 'organisation', name: 'X', roles: ['customer'], contact: { vatNumber: 'ab cd 12 !!' } }));
  check(status(r) === 422, 'a VAT number with odd characters is refused');

  // ---- 4. THE TAX LOCK DATE: forward only, enforced on credit notes ---------------------------------------------------------------------------------------------------------------------------------------
  const lock = (date) => ({ lockDate: date });
  r = await run(propose('owner', 'tax_lock.set', lock('2026-10-20'), 'The September-October VAT return is filed'));
  check(status(r) === 200 && body(r).status === 'held' && added(r, 'eng_event') === 0, 'proposing a tax lock is HELD and records nothing');
  const locked = seq(); locked.do('tax_lock.set', lock('2026-10-20'));
  r = await run({ before: locked.steps.slice(0, 1), ...confirm('owner', 1) });
  check(status(r) === 200 && added(r, 'eng_event') === 2 && touchesNoFact(r), 'approving it records the tax_lock.set event and the execution, and NO fact row');
  r = await run({ before: locked.steps, ...get('owner', '/engine/business') });
  check(body(r).result.taxLockDate === '2026-10-20', 'the lock date is read back');
  for (const [date, code, why] of [['2026-10-20', 'invalid_state', 'the same date'], ['2026-10-01', 'invalid_state', 'an earlier date (a lock only moves forward)']]) { r = await run({ before: locked.steps, ...propose('owner', 'tax_lock.set', lock(date)) }); check(body(r).error === code && added(r, 'eng_event') === 0, `${why} is refused at the door as ${code}`); }
  for (const [payload, why] of [[lock('2026-02-30'), 'a date that does not exist'], [lock('soon'), 'a date that is not a date'], [{}, 'no date'], [{ lockDate: '2026-10-20', note: 'x' }, 'a field nobody declared']]) { r = await run(propose('owner', 'tax_lock.set', payload)); check(status(r) === 422 && body(r).error === 'invalid_payload', `${why} is refused as invalid_payload`); }
  r = await run({ before: locked.steps, ...propose('owner', 'tax_lock.set', lock('2026-11-30')) }); check(status(r) === 200 && body(r).status === 'held', 'a later date is allowed');
  for (const role of ['accountant', 'sales', 'installer']) { r = await run(propose(role, 'tax_lock.set', lock('2026-10-20'))); check(status(r) === 403, `${role} may not set the tax lock`); }
  r = await run({ before: locked.steps, ...propose('accountant', 'credit_note.issue', credit({ issuedOn: '2026-10-20' })) });
  check(status(r) === 409 && body(r).error === 'period_locked' && touchesNoFact(r) && /after 2026-10-20|open/i.test(String(body(r).message || '')), `a credit note dated ON the lock date is refused as period_locked (${status(r)} ${body(r).error}) with a message to date it in the open period`);
  r = await run({ before: locked.steps, ...propose('accountant', 'credit_note.issue', credit({ issuedOn: '2026-10-19' })) });
  check(status(r) === 409 && body(r).error === 'period_locked', 'and one dated before it');
  r = await run({ before: locked.steps, ...propose('accountant', 'credit_note.issue', credit({ issuedOn: '2026-10-21' })) });
  check(status(r) === 200 && body(r).status === 'held', 'a credit note dated the day after the lock is allowed');
  const racing = seq(); const cn = racing.prop('credit_note.issue', credit({ issuedOn: '2026-10-25' }), 'accountant'); racing.do('tax_lock.set', lock('2026-10-31'));
  r = await run({ before: racing.steps, ...confirm('accountant', cn) });
  check(status(r) === 409 && body(r).error === 'period_locked' && added(r, 'eng_document') === 0, 'a credit note proposed before the lock moved is refused AT the approval if the period has since been locked');
  const nolock = seq(); nolock.do('credit_note.issue', credit({ issuedOn: '2026-10-02' }), 'accountant');
  r = await run({ before: nolock.steps, ...get('accountant', '/engine/records/document/1') });
  check(fieldOf(body(r).result || {}, 'creditedMinor') === 57500, 'with no lock set, a credit note dated in the past (after its invoice) is allowed');

  // ---- 5. THE LOCK ALSO GUARDS INVOICES (at the fact layer) ---------------------------------------------------------------------------------------------------------------------------------------------
  const { facts, drafts, business, verifyIntegrity, EVENT_MODEL } = eng;
  const w = kit.makeWorld(); w.configure({ mode: 'engine', available: AV });
  const CTX = { actorEmail: 'owner@example.com', contract: 'test', contractVersion: 1 };
  const pc = (await facts.recordParty(w.env, { kind: 'organisation', name: 'Patel', roles: ['customer'] }, CTX)).id;
  const mkDraft = async (issuedOn) => { const d = await drafts.createDraft(w.env, { kind: 'invoice', direction: 'sell', partyId: pc }, CTX); const s = await drafts.saveDraft(w.env, d.id, { expectedVersion: d.version, payload: { currency: 'ZAR', issuedOn, lines: [{ description: 'Floor', quantityMilli: 1000, unit: 'job', unitPriceMinor: 100000, taxBp: 1500 }] } }, CTX); return { id: d.id, version: s.version }; };
  await facts.setTaxLock(w.env, { lockDate: '2026-10-20' }, CTX);
  const d1 = await mkDraft('2026-10-20'); let code = null; try { await drafts.issueDraft(w.env, d1.id, { expectedVersion: d1.version }, CTX); } catch (e) { code = e && e.code; }
  check(code === 'period_locked', `an invoice dated on or before the lock cannot be issued (${code})`);
  const d2 = await mkDraft('2026-10-21'); const iss = await drafts.issueDraft(w.env, d2.id, { expectedVersion: d2.version }, CTX);
  check(Number.isInteger(iss.documentId), 'one dated after it can');

  // ---- 6. THE COMPLETENESS CHECK: what a tax document still lacks (it flags; it never blocks) ------------------------------------------------------------------------------------------------------------
  const w2 = kit.makeWorld(); w2.configure({ mode: 'engine', available: AV });
  const c2 = (await facts.recordParty(w2.env, { kind: 'organisation', name: 'Patel', roles: ['customer'] }, CTX)).id;
  const small = await facts.recordDocument(w2.env, { kind: 'invoice', direction: 'sell', partyId: c2, currency: 'ZAR', issuedOn: '2026-10-01', lines: [{ description: 'Floor', quantityMilli: 1000, unit: 'job', unitPriceMinor: 100000, taxBp: 1500 }] }, CTX);   // R1,150.00
  const big = await facts.recordDocument(w2.env, { kind: 'invoice', direction: 'sell', partyId: c2, currency: 'ZAR', issuedOn: '2026-10-01', lines: [{ description: 'Floor', quantityMilli: 1000, unit: 'job', unitPriceMinor: 600000, taxBp: 1500 }] }, CTX);   // R6,900.00
  let p = await business.documentParticulars(w2.env, small.id);
  check(p.applicable === true && p.complete === false && ['vendor name', 'vendor address', 'vendor VAT number'].every((m) => p.missing.includes(m)), 'with no business profile a tax document lacks the vendor\'s name, address and VAT number');
  await facts.setBusinessProfile(w2.env, profile, CTX);
  p = await business.documentParticulars(w2.env, small.id);
  check(p.complete === true && p.missing.length === 0, 'with the profile set, a document of R1,150.00 is complete (the recipient\'s address is not required up to R5,000)');
  p = await business.documentParticulars(w2.env, big.id);
  check(p.complete === false && p.missing.includes('recipient address') && p.advisory.some((a) => /recipient VAT number/.test(a)), 'a document above R5,000 also needs the recipient\'s address, and advises the recipient\'s VAT number if they are a vendor');
  await facts.reviseParty(w2.env, { partyId: c2, contact: { address: '12 Main Road, Empangeni', vatNumber: '4987654321' } }, CTX);
  p = await business.documentParticulars(w2.env, big.id);
  check(p.complete === true && p.advisory.length === 0, 'once the customer has an address and a VAT number it is complete');
  await facts.setBusinessProfile(w2.env, { vatRegistered: false }, CTX);
  p = await business.documentParticulars(w2.env, small.id);
  check(p.complete === false && p.missing.includes('vendor VAT registration'), 'a business not recorded as VAT registered is not issuing tax documents, and says so');
  const q = await facts.recordDocument(w2.env, { kind: 'quotation', direction: 'sell', partyId: c2, currency: 'ZAR', issuedOn: '2026-10-01', lines: [{ description: 'x', quantityMilli: 1000, unitPriceMinor: 100, taxBp: 1500 }] }, CTX);
  p = await business.documentParticulars(w2.env, q.id); check(p.applicable === false, 'a quotation is not a tax document: the check does not apply');
  p = await business.documentParticulars(w2.env, 99999); check(p === null, 'a document that does not exist has no particulars');
  r = await run({ before: [...setP.steps], ...get('owner', '/engine/records/document/1') });
  const rv = body(r).result || {};
  check(fieldOf(rv, 'particularsComplete') === true && fieldOf(rv, 'particularsMissing') === '', 'an invoice record shows whether its tax particulars are complete (here yes, after the profile)');
  r = await run(get('owner', '/engine/records/document/1'));
  check(fieldOf(body(r).result || {}, 'particularsComplete') === false && /vendor name/.test(fieldOf(body(r).result || {}, 'particularsMissing')), 'and what is missing when the profile has not been set');

  // ---- 7. THE FOUNDATIONS STILL HOLD ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
  check(['business.profile_set', 'tax_lock.set'].every((t) => EVENT_MODEL[t] && EVENT_MODEL[t].creates === null), 'the event model knows both new events and says they create no fact row');
  let integ = await verifyIntegrity(w2.env);
  check(integ.ok === true && integ.problems.length === 0 && integ.warnings.length === 0, 'the integrity verifier is clean after profile, lock and party edits, with no warning about an unmodelled event');
  w2.db.prepare("INSERT INTO eng_event (type, payload_json) VALUES ('tax_lock.set', ?)").run(JSON.stringify({ lockDate: '2026-10-01' }));
  w2.db.prepare("INSERT INTO eng_event (type, payload_json) VALUES ('tax_lock.set', ?)").run(JSON.stringify({ lockDate: '2026-09-01' }));
  integ = await verifyIntegrity(w2.env);
  check(integ.ok === false && integ.problems.some((x) => /lock/i.test(x.detail) && /forward|earlier|backward/i.test(x.detail)), 'a tax lock that moved BACKWARD in the record is REPORTED by the verifier');
  const was = JSON.stringify(w.counts()); let c = null; try { await facts.setTaxLock(w.env, { lockDate: '2026-10-01' }, CTX); } catch (e) { c = e && e.code; }
  check(c === 'invalid_state' && JSON.stringify(w.counts()) === was, `the fact layer itself refuses to move the lock backward and writes nothing (${c})`);
});

if (require.main === module) kit.standalone(module.exports);
