// Credit-note follow-ups, the last four (branch engine-phase1): (1) UNDO an application of credit or a refund, (2) apply or refund an unapplied OVERPAYMENT, (3) the VAT period SUMMARY (output side), and (4) the stored-configuration gap for
// debit notes. TESTS FIRST. Evidence label for every check: TEST of the engine on the route harness (NOT staging, NOT production). Expected state when first committed: RED. Research and decisions:
// docs/decisions/credit-note-follow-ups.md ("The last four"). In short: removing an allocation or voiding a refund are new facts (reversals), never edits, and every derived figure (credit left, credit owed back, whether a credit note can be
// voided) honours them; an overpayment is handled exactly like a credit (apply to another invoice, or refund); the VAT summary follows the VAT201 (field 1 standard-rated supplies INCLUDING VAT net of credit notes, field 4 output tax by the
// tax fraction, field 2 zero-rated) for the OUTPUT side only; and a debit note is a receivable whenever an invoice is.
const kit = require('./engine-kit.js');

module.exports = kit.guard('credit undo, overpayments and VAT summary', async ({ check }) => {
  const eng = kit.loadEngine();
  check(Boolean(eng && eng.permissions && eng.capabilities && eng.facts && eng.business), 'the engine exposes permissions, capabilities, facts and the business module');
  if (!eng || !eng.permissions || !eng.business) return;
  const auth = kit.bundle('auth.ts', 'auth');
  const member = (role) => ({ email: `${role}@example.com`, caps: auth.ROLE_CAPABILITIES[role] || [] });
  const AV = [...kit.ALL_CAPABILITIES, 'credit_note.issue', 'credits.find', 'credit.apply', 'refund.record', 'credit_note.void', 'debit_note.issue', 'tax_lock.set', 'allocation.remove', 'refund.void', 'payment.allocate', 'payment.refund', 'vat.summary'];
  const ENV = { BUSINESS_ID: 'eng-a' };
  const run = (spec) => kit.route({ env: ENV, seed: kit.seedReceivables(AV), ...spec });
  const propose = (role, capability, payload, transcript = 'a sentence from the person') => ({ method: 'POST', path: '/engine/proposals', role, body: { capability, payload, transcript } });
  const confirm = (role, id = 1) => ({ method: 'POST', path: `/actions/${id}/confirm`, role, body: {} });
  const open = (role, kind, id) => ({ method: 'GET', path: `/engine/records/${kind}/${id}`, role });
  const owes = (role = 'accountant') => ({ method: 'GET', path: '/engine/receivables?party=Mokoena', role });
  const added = (res, t) => ((res.writes && res.writes[t] && res.writes[t].added) || []).length;
  const body = (res) => (res.result && res.result.body) || {};
  const status = (res) => res.result && res.result.status;
  const FACTS = ['eng_party', 'eng_party_role', 'eng_document', 'eng_document_line', 'eng_document_number', 'eng_money_movement', 'eng_allocation', 'eng_reversal'];
  const touchesNoFact = (res) => FACTS.every((t) => added(res, t) === 0);
  const fieldOf = (v, k) => ((v.fields || []).find((f) => f.key === k) || {}).value;
  const seq = () => { let n = 0; const steps = []; const api = { steps,
    prop(cap, payload, role = 'accountant') { n += 1; steps.push(propose(role, cap, payload, `(${cap})`)); return n; },
    ok(id, role = 'accountant') { steps.push(confirm(role, id)); return api; },
    setN(k) { n = k; },
    do(cap, payload, role = 'accountant') { const id = api.prop(cap, payload, role); api.ok(id, role); return id; } }; return api; };
  const ext = (src) => { const q = seq(); q.steps.push(...src.steps); q.setN(src.steps.filter((x) => x.method === 'POST' && x.path === '/engine/proposals').length); return q; };
  const has = (role, p) => eng.permissions.permissionsFor(member(role).caps).has(p);
  const acct = async (steps) => (body(await run({ before: steps, ...owes() })).result) || {};
  const pay = (amountMinor, extra = {}) => ({ partyId: 1, amountMinor, currency: 'ZAR', occurredOn: '2026-11-05', allocate: 'oldest_first', ...extra });
  const credit = () => ({ invoiceId: 1, reason: 'Boards damaged on delivery', issuedOn: '2026-11-10', lines: [{ invoiceLineNo: 1, quantityMilli: 500, unitPriceMinor: 100000 }] });   // R575.00

  // ---- 0. PERMISSIONS ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const MONEY = ['allocation.remove', 'refund.void', 'payment.allocate', 'payment.refund'];
  check(['owner', 'accountant', 'admin'].every((r) => MONEY.every((p) => has(r, p)) && has(r, 'vat.read')), 'owner, accountant and admin may undo, apply or refund an overpayment, and read the VAT summary');
  check(['sales', 'installer'].every((r) => MONEY.every((p) => !has(r, p)) && !has(r, 'vat.read')), 'a salesperson and an installer may not');
  check(['allocation.remove', 'refund.void', 'payment.allocate', 'payment.refund', 'vat.summary'].every((c) => eng.capabilities.CAPABILITY_IDS.includes(c)), 'the five capabilities exist in the engine');

  // ---- 1. UNDO an application of credit (remove the allocation) and a refund (void it) ------------------------------------------------------------------------------------------------------------
  // invoice 1 paid in full then credited R575.00 (all unapplied); the credit note is document 3
  const base = seq(); base.do('payment.record', pay(115000)); base.do('credit_note.issue', credit());
  const CN = 3, aply = (extra = {}) => ({ creditNoteId: CN, invoiceId: 2, amountMinor: 23000, appliedOn: '2026-11-11', ...extra });
  const cnView = async (steps, id = CN) => (body(await run({ before: steps, ...open('accountant', 'document', id) })).result) || {};
  const applied = ext(base); applied.do('credit.apply', aply());   // action 3
  const inv2 = async (steps) => (body(await run({ before: steps, ...open('accountant', 'document', 2) })).result) || {};
  check(fieldOf(await inv2(applied.steps), 'outstandingMinor') === 0, 'set-up: the credit has paid invoice 2');
  const allocationId = async (steps) => { const v = await inv2(steps); const al = ((v.collections || {}).allocations || [])[0]; return al ? al.id : null; };
  const alId = await allocationId(applied.steps);
  check(Number.isInteger(alId), 'the invoice record lists its allocation so it can be named');
  const undo = (extra = {}) => ({ allocationId: alId, reason: 'Applied to the wrong invoice', ...extra });
  let r = await run({ before: applied.steps, ...propose('accountant', 'allocation.remove', undo(), 'That credit was meant for another invoice') });
  check(status(r) === 200 && body(r).status === 'held' && touchesNoFact(r) && added(r, 'eng_event') === 0, 'proposing the removal is HELD and records nothing');
  const rem = ext(applied); const r0 = rem.prop('allocation.remove', undo());
  r = await run({ before: rem.steps, ...confirm('accountant', 4) });
  check(status(r) === 200 && added(r, 'eng_reversal') === 1 && added(r, 'eng_allocation') === 0 && added(r, 'eng_money_movement') === 0 && added(r, 'eng_document') === 0, `approving it records ONE reversal of the allocation and nothing else is added (${status(r)})`);
  rem.steps.push(confirm('accountant', 4));
  check(fieldOf(await inv2(rem.steps), 'outstandingMinor') === 23000, 'invoice 2 owes R230.00 again');
  check(fieldOf(await cnView(rem.steps), 'availableMinor') === 57500 && (await acct(rem.steps)).unappliedCreditMinor === 57500, 'and the credit is available again (R575.00), shown on the customer\'s account');
  for (const [payload, code, why] of [[undo({ allocationId: 999 }), 'not_found', 'an allocation that does not exist']]) { r = await run({ before: applied.steps, ...propose('accountant', 'allocation.remove', payload) }); check(body(r).error === code && touchesNoFact(r), `${why} is refused at the door as ${code}`); }
  r = await run({ before: rem.steps, ...propose('accountant', 'allocation.remove', undo()) }); check(status(r) === 409 && ['not_effective', 'invalid_state', 'already_reversed'].includes(body(r).error), 'removing an allocation that has already been removed is refused');
  for (const [payload, why] of [[undo({ reason: '' }), 'no reason'], [undo({ reason: 'x'.repeat(201) }), 'a reason over 200 characters'], [undo({ colour: 'x' }), 'a field nobody declared'], [{ reason: 'x' }, 'no allocation named'], [undo({ allocationId: 'one' }), 'an allocation number that is text']]) { r = await run({ before: applied.steps, ...propose('accountant', 'allocation.remove', payload) }); check(status(r) === 422 && body(r).error === 'invalid_payload' && touchesNoFact(r), `${why} is refused as invalid_payload`); }
  for (const role of ['sales', 'installer']) { r = await run({ before: applied.steps, ...propose(role, 'allocation.remove', undo()) }); check(status(r) === 403 && touchesNoFact(r), `${role} may not remove an allocation`); }
  const unlockedAfter = ext(applied); unlockedAfter.do('tax_lock.set', { lockDate: '2026-11-30' }, 'owner'); r = await run({ before: unlockedAfter.steps, ...propose('accountant', 'allocation.remove', undo()) });
  check(status(r) === 200 && body(r).status === 'held', 'removing an allocation is NOT blocked by the tax lock (it changes no VAT)');
  // a credit note whose credit was applied can be voided once the application is removed
  r = await run({ before: applied.steps, ...propose('accountant', 'credit_note.void', { creditNoteId: CN, reason: 'wrong customer', voidedOn: '2026-11-12' }) }); check(status(r) === 409 && body(r).error === 'invalid_state', 'a credit note whose credit is applied still cannot be voided');
  const voidOk = ext(rem); voidOk.prop('credit_note.void', { creditNoteId: CN, reason: 'wrong customer', voidedOn: '2026-11-12' });
  r = await run({ before: voidOk.steps, ...confirm('accountant', 5) }); check(status(r) === 200 && added(r, 'eng_reversal') === 2, 'but once the application has been removed it can be voided (a reversed application no longer counts)');
  // refunds: void a refund
  const rf = (extra = {}) => ({ creditNoteId: CN, amountMinor: 10000, refundedOn: '2026-11-12', method: 'eft', ...extra });
  const refunded = ext(base); refunded.do('refund.record', rf());
  const refundMovement = async (steps) => { const v = await cnView(steps); const h = (v.history || []).find((x) => x.type === 'credit.refunded'); return h && h.payload ? h.payload.refundMovementId : null; };
  const rmId = 3 + 1 + 1;   // movements: payment (1), the credit note's credit movement (2), the refund (3); ids resolved below from the record
  const rmv = await refundMovement(refunded.steps);
  const vr = (extra = {}) => ({ movementId: Number.isInteger(rmv) ? rmv : 3, reason: 'The bank returned the transfer', ...extra });
  const vsteps = ext(refunded); vsteps.prop('refund.void', vr(), 'accountant');
  r = await run({ before: vsteps.steps, ...confirm('accountant', 4) });
  check(status(r) === 200 && added(r, 'eng_reversal') === 1 && added(r, 'eng_money_movement') === 0, `voiding a refund records ONE reversal of the money-out movement (${status(r)})`);
  vsteps.steps.push(confirm('accountant', 4));
  check(fieldOf(await cnView(vsteps.steps), 'availableMinor') === 57500 && (await acct(vsteps.steps)).unappliedCreditMinor === 57500, 'the refunded credit is available again');
  r = await run({ before: base.steps, ...propose('accountant', 'refund.void', vr({ movementId: 1 })) }); check(status(r) === 409 && body(r).error === 'invalid_state', 'voiding something that is not a refund (the customer\'s own payment) is refused');
  r = await run({ before: vsteps.steps, ...propose('accountant', 'refund.void', vr()) }); check(status(r) === 409, 'voiding a refund that has already been voided is refused');
  r = await run({ before: refunded.steps, ...propose('accountant', 'refund.void', vr({ movementId: 999 })) }); check(status(r) === 404, 'voiding a refund that does not exist is refused as not_found');
  r = await run({ before: refunded.steps, ...propose('accountant', 'refund.void', vr({ reason: '' })) }); check(status(r) === 422, 'a reason is required');
  for (const role of ['sales', 'installer']) { r = await run({ before: refunded.steps, ...propose(role, 'refund.void', vr()) }); check(status(r) === 403, `${role} may not void a refund`); }
  const voidAfterRefund = ext(vsteps); voidAfterRefund.prop('credit_note.void', { creditNoteId: CN, reason: 'wrong customer', voidedOn: '2026-11-13' });
  r = await run({ before: voidAfterRefund.steps, ...confirm('accountant', 5) }); check(status(r) === 200, 'a credit note whose only refund was voided can be voided');

  // ---- 2. OVERPAYMENTS: apply to another invoice, or refund ---------------------------------------------------------------------------------------------------------------------------------------
  // the customer pays R2,000.00 against R1,380.00 owed: R620.00 is unapplied (the payment is movement 1)
  const over = seq(); over.do('payment.record', pay(200000));
  check((await acct(over.steps)).unappliedCreditMinor === 62000 && (await acct(over.steps)).totalMinor === 0, 'set-up: an overpayment of R620.00 shows as credit owed back, and the customer owes nothing');
  const newInv = async (steps) => { const s = seq(); s.steps.push(...steps); return s; };
  r = await run({ before: over.steps, ...propose('accountant', 'payment.refund', { paymentId: 1, amountMinor: 20000, refundedOn: '2026-11-12', method: 'eft' }, 'Refund Mokoena the R200 they overpaid') });
  check(status(r) === 200 && body(r).status === 'held' && touchesNoFact(r), 'proposing a refund of an overpayment is HELD');
  const ref = ext(over); ref.do('payment.refund', { paymentId: 1, amountMinor: 20000, refundedOn: '2026-11-12', method: 'eft' });
  check((await acct(ref.steps)).unappliedCreditMinor === 42000, 'after refunding R200.00 the credit owed back is R420.00');
  const refAct = ext(over); const rp = refAct.prop('payment.refund', { paymentId: 1, amountMinor: 20000, refundedOn: '2026-11-12', method: 'eft' });
  r = await run({ before: refAct.steps, ...confirm('accountant', 2) });
  check(status(r) === 200 && added(r, 'eng_money_movement') === 1 && added(r, 'eng_allocation') === 0 && added(r, 'eng_event') === 3, 'approving it records ONE money-out movement and the overpayment.refunded event (3 events with the execution)');
  const refundRules = [[{ paymentId: 1, amountMinor: 62001, refundedOn: '2026-11-12', method: 'eft' }, 'invalid_state', 'more than the overpayment'], [{ paymentId: 999, amountMinor: 100, refundedOn: '2026-11-12', method: 'eft' }, 'not_found', 'a payment that does not exist'], [{ paymentId: 1, amountMinor: 100, refundedOn: '2026-11-01', method: 'eft' }, 'invalid_input', 'a refund dated before the payment']];
  for (const [payload, code, why] of refundRules) { r = await run({ before: over.steps, ...propose('accountant', 'payment.refund', payload) }); check(body(r).error === code && touchesNoFact(r), `${why} is refused at the door as ${code}`); }
  r = await run({ before: base.steps, ...propose('accountant', 'payment.refund', { paymentId: 2, amountMinor: 100, refundedOn: '2026-11-12', method: 'eft' }) }); check(status(r) === 409 && body(r).error === 'invalid_state', 'the movement behind a credit note is refunded with refund.record, not as a payment: refused');
  for (const [payload, why] of [[{ paymentId: 1, amountMinor: 0, refundedOn: '2026-11-12', method: 'eft' }, 'an amount of zero'], [{ paymentId: 1, amountMinor: 100, refundedOn: '2026-11-12', method: 'barter' }, 'a method nobody declared'], [{ paymentId: 1, amountMinor: 100, refundedOn: '2026-11-12', method: 'eft', colour: 'x' }, 'a field nobody declared']]) { r = await run({ before: over.steps, ...propose('accountant', 'payment.refund', payload) }); check(status(r) === 422 && body(r).error === 'invalid_payload', `${why} is refused as invalid_payload`); }
  for (const role of ['sales', 'installer']) { r = await run({ before: over.steps, ...propose(role, 'payment.refund', { paymentId: 1, amountMinor: 100, refundedOn: '2026-11-12', method: 'eft' }) }); check(status(r) === 403, `${role} may not refund a payment`); }
  // apply the overpayment to a NEW invoice: issue a debit note (a receivable) of R115.00 and allocate R115.00 of the overpayment to it
  const dn = (extra = {}) => ({ invoiceId: 1, reason: 'Extra underlay supplied on site', issuedOn: '2026-11-10', lines: [{ invoiceLineNo: 1, quantityMilli: 500, unitPriceMinor: 20000 }], ...extra });   // R115.00
  const withDebit = ext(over); withDebit.do('debit_note.issue', dn());
  check((await acct(withDebit.steps)).totalMinor === 11500, 'set-up: a debit note of R115.00 is owed (the overpayment was not spread onto it automatically)');
  const dnId = async (steps) => ((((body(await run({ before: steps, ...open('accountant', 'document', 1) })).result) || {}).relations || []).find((x) => x.role === 'debit_note') || { ref: { id: 0 } }).ref.id;
  const D = await dnId(withDebit.steps);
  const pa = (extra = {}) => ({ paymentId: 1, invoiceId: D, amountMinor: 11500, allocatedOn: '2026-11-11', ...extra });
  r = await run({ before: withDebit.steps, ...propose('accountant', 'payment.allocate', pa(), 'Use the overpayment to settle the debit note') });
  check(status(r) === 200 && body(r).status === 'held' && touchesNoFact(r), 'proposing the allocation of an overpayment is HELD');
  const alloc = ext(withDebit); const al0 = alloc.prop('payment.allocate', pa());
  r = await run({ before: alloc.steps, ...confirm('accountant', 3) });
  check(status(r) === 200 && added(r, 'eng_allocation') === 1 && added(r, 'eng_money_movement') === 0 && added(r, 'eng_document') === 0 && added(r, 'eng_event') === 3, 'approving it records ONE allocation (no new money) and the overpayment.allocated event');
  alloc.steps.push(confirm('accountant', 3));
  check((await acct(alloc.steps)).totalMinor === 0 && (await acct(alloc.steps)).unappliedCreditMinor === 50500, 'the debit note is settled, and R505.00 of the overpayment is still owed back');
  const allocRules = [[pa({ amountMinor: 11501 }), 'invalid_state', 'more than the debit note owes'], [pa({ amountMinor: 62001, invoiceId: D }), 'invalid_state', 'more than the overpayment'], [pa({ paymentId: 999 }), 'not_found', 'a payment that does not exist'], [pa({ invoiceId: 999 }), 'not_found', 'an invoice that does not exist'], [pa({ allocatedOn: '2026-11-04' }), 'invalid_input', 'a date before the payment']];
  for (const [payload, code, why] of allocRules) { r = await run({ before: withDebit.steps, ...propose('accountant', 'payment.allocate', payload) }); check(body(r).error === code && touchesNoFact(r), `${why} is refused at the door as ${code}`); }
  r = await run({ before: base.steps, ...propose('accountant', 'payment.allocate', pa({ paymentId: 2, invoiceId: 2 })) }); check(status(r) === 409 && body(r).error === 'invalid_state', 'the movement behind a credit note is applied with credit.apply, not as a payment: refused');
  r = await run({ before: withDebit.steps, ...propose('accountant', 'payment.allocate', pa({ colour: 'x' })) }); check(status(r) === 422, 'a field nobody declared is refused');
  for (const role of ['sales', 'installer']) { r = await run({ before: withDebit.steps, ...propose(role, 'payment.allocate', pa()) }); check(status(r) === 403, `${role} may not allocate a payment`); }
  const spend = ext(withDebit); const s1 = spend.prop('payment.refund', { paymentId: 1, amountMinor: 55000, refundedOn: '2026-11-12', method: 'eft' }); const s2 = spend.prop('payment.allocate', pa()); spend.ok(s1);
  r = await run({ before: spend.steps, ...confirm('accountant', s2) }); check(status(r) === 409 && added(r, 'eng_allocation') === 0, 'a refund and an allocation cannot both spend the same overpayment: the second is refused once the first is approved');
  r = await run({ before: over.steps, method: 'GET', path: '/engine/credits?partyId=1', role: 'accountant' });
  check(((body(r).result || {}).payments || []).length === 1 && body(r).result.payments[0].availableMinor === 62000 && body(r).result.payments[0].ref.kind === 'movement', 'finding credit also lists the overpayment (R620.00 available) with a reference to open it');

  // ---- 3. DEBIT NOTES: a receivable whenever an invoice is (the stored-configuration gap) ------------------------------------------------------------------------------------------------------
  const { readConfig } = eng;
  const w0 = kit.makeWorld(); w0.configure({ mode: 'engine', available: AV });
  w0.db.prepare("INSERT OR REPLACE INTO eng_config (key, value_json) VALUES ('receivable_kinds', ?)").run(JSON.stringify(['invoice']));
  const cfg = await eng.config.readConfig(w0.env);
  check(cfg.receivableKinds.includes('invoice') && cfg.receivableKinds.includes('debit_note'), 'a business whose stored configuration says only "invoice" still treats a debit note as owed (it is part of an invoice\'s family)');
  w0.db.prepare("INSERT OR REPLACE INTO eng_config (key, value_json) VALUES ('receivable_kinds', ?)").run(JSON.stringify(['pro_forma']));
  const cfg2 = await eng.config.readConfig(w0.env);
  check(!cfg2.receivableKinds.includes('debit_note'), 'but a business that does not treat invoices as owed is not given debit notes as owed');

  // ---- 4. THE VAT SUMMARY (output side) --------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const vat = (role, q = '') => ({ method: 'GET', path: `/engine/vat${q}`, role });
  // seed: invoice 1 (2026-10-01, net 100000 tax 15000 gross 115000), invoice 2 (2026-10-15, net 20000 tax 3000 gross 23000)
  r = await run(vat('accountant', '?from=2026-10-01&to=2026-10-31'));
  let v = body(r).result || {};
  check(status(r) === 200 && v.field1Minor === 138000 && v.taxPerDocumentsMinor === 18000 && v.field4Minor === 18000 && v.differenceMinor === 0 && v.field2Minor === 0, 'October: standard-rated supplies INCLUDING VAT are R1,380.00 (VAT201 field 1), output tax R180.00 by the tax fraction (field 4) and by the documents, and they agree');
  check(v.outputOnly === true && v.inputTaxMinor === null && (v.notes || []).some((n) => /input/i.test(n)) && (v.notes || []).some((n) => /exempt/i.test(n)), 'it says plainly that it covers the OUTPUT side only, and that exempt supplies are not told apart from zero-rated ones');
  r = await run(vat('accountant', '?from=2026-09-01&to=2026-09-30')); v = body(r).result || {};
  check(v.field1Minor === 0 && v.field4Minor === 0 && (v.documents || []).length === 0, 'a period with no sales reports nothing');
  r = await run(vat('accountant', '?from=2026-10-01&to=2026-10-14')); v = body(r).result || {};
  check(v.field1Minor === 115000 && v.field4Minor === 15000 && (v.documents || []).length === 1, 'only documents dated inside the period count (invoice 2, dated 15 October, is outside)');
  const cr = seq(); cr.do('credit_note.issue', credit());
  r = await run({ before: cr.steps, ...vat('accountant', '?from=2026-11-01&to=2026-11-30') }); v = body(r).result || {};
  check(v.field1Minor === -57500 && v.field4Minor === -7500 && v.taxPerDocumentsMinor === -7500, 'a credit note reduces the period it is ISSUED in: November shows field 1 of minus R575.00 and output tax of minus R75.00, and October is untouched');
  r = await run({ before: cr.steps, ...vat('accountant', '?from=2026-10-01&to=2026-11-30') }); v = body(r).result || {};
  check(v.field1Minor === 138000 - 57500 && v.field4Minor === 18000 - 7500, 'over both months the credit note nets against the invoices (VAT201: credit notes issued are offset against standard-rated supplies)');
  const voided = seq(); voided.do('credit_note.issue', credit()); voided.do('credit_note.void', { creditNoteId: 3, reason: 'wrong customer', voidedOn: '2026-11-12' });
  r = await run({ before: voided.steps, ...vat('accountant', '?from=2026-11-01&to=2026-11-30') }); v = body(r).result || {};
  check(v.field1Minor === 0 && (v.documents || []).length === 0, 'a voided credit note no longer counts');
  const deb = seq(); deb.do('debit_note.issue', dn());
  r = await run({ before: deb.steps, ...vat('accountant', '?from=2026-11-01&to=2026-11-30') }); v = body(r).result || {};
  check(v.field1Minor === 11500 && v.field4Minor === 1500, 'a debit note adds to the period it is issued in');
  r = await run(vat('accountant', '?from=2026-10-01&to=2026-10-31')); v = body(r).result || {};
  check(v.locked === false && v.lockDate === null && v.incompleteDocuments === 2, 'the summary says whether the period is locked, and how many documents lack tax particulars (here both invoices: no business profile yet)');
  const lk = seq(); lk.do('tax_lock.set', { lockDate: '2026-10-31' }, 'owner');
  r = await run({ before: lk.steps, ...vat('accountant', '?from=2026-10-01&to=2026-10-31') }); v = body(r).result || {};
  check(v.locked === true && v.lockDate === '2026-10-31', 'after the lock moves to 31 October, October reads as locked');
  r = await run({ before: lk.steps, ...vat('accountant', '?from=2026-10-01&to=2026-11-30') }); check((body(r).result || {}).locked === false, 'a period that runs past the lock is not locked as a whole');
  const odd = kit.makeWorld(); odd.configure({ mode: 'engine', available: AV });
  const { facts } = eng; const CTX = { actorEmail: 'accountant@example.com', contract: 'test', contractVersion: 1 };
  const oc = (await facts.recordParty(odd.env, { kind: 'organisation', name: 'Patel', roles: ['customer'] }, CTX)).id;
  await facts.recordDocument(odd.env, { kind: 'invoice', direction: 'sell', partyId: oc, currency: 'ZAR', issuedOn: '2026-10-05', lines: [{ description: 'Std', quantityMilli: 1000, unit: 'u', unitPriceMinor: 10000, taxBp: 1500 }, { description: 'Zero', quantityMilli: 1000, unit: 'u', unitPriceMinor: 5000, taxBp: 0 }, { description: 'Odd', quantityMilli: 1000, unit: 'u', unitPriceMinor: 2000, taxBp: 500 }] }, CTX);
  const vs = await eng.business.vatSummary(odd.env, { from: '2026-10-01', to: '2026-10-31' });
  check(vs.field1Minor === 11500 && vs.field2Minor === 5000 && vs.otherRates.length === 1 && vs.otherRates[0].taxBp === 500 && vs.otherRates[0].netMinor === 2000 && vs.otherRates[0].taxMinor === 100, 'standard-rated (15%) and zero-rated lines are separated, and any other rate is listed apart for the accountant instead of being guessed');
  const rnd = kit.makeWorld(); rnd.configure({ mode: 'engine', available: AV });
  const rc = (await facts.recordParty(rnd.env, { kind: 'organisation', name: 'R', roles: ['customer'] }, CTX)).id;
  for (let i = 0; i < 6; i++) await facts.recordDocument(rnd.env, { kind: 'invoice', direction: 'sell', partyId: rc, currency: 'ZAR', issuedOn: '2026-10-05', lines: [{ description: 'T', quantityMilli: 1000, unit: 'u', unitPriceMinor: 30 + i, taxBp: 1500 }] }, CTX);
  const rv = await eng.business.vatSummary(rnd.env, { from: '2026-10-01', to: '2026-10-31' });
  check(Math.abs(rv.differenceMinor) <= 6 && rv.differenceMinor === rv.field4Minor - rv.taxPerDocumentsMinor, 'where per-line rounding and the tax-fraction method differ by cents, the summary shows the DIFFERENCE instead of hiding it');
  for (const [q, why] of [['?from=2026-10-01', 'no end date'], ['?from=2026-10-31&to=2026-10-01', 'an end before the start'], ['?from=soon&to=later', 'dates that are not dates'], ['?from=2026-02-30&to=2026-03-01', 'a date that does not exist']]) { r = await run(vat('accountant', q)); check(status(r) === 422, `${why} is refused as invalid`); }
  r = await run(vat('installer', '?from=2026-10-01&to=2026-10-31')); check(status(r) === 403, 'an installer is refused (403)');
  r = await run(vat('sales', '?from=2026-10-01&to=2026-10-31')); check(status(r) === 403, 'a salesperson is refused (403)');
  r = await kit.route({ env: ENV, seed: kit.seedReceivables(kit.ALL_CAPABILITIES), ...vat('accountant', '?from=2026-10-01&to=2026-10-31') }); check(status(r) === 409 && body(r).error === 'capability_unavailable', 'a business without the capability is told so');

  // ---- 5. THE FOUNDATIONS STILL HOLD ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const { verifyIntegrity, EVENT_MODEL } = eng;
  check(['overpayment.allocated', 'overpayment.refunded'].every((t) => EVENT_MODEL[t] && EVENT_MODEL[t].creates === null), 'the event model knows the two new events');
  const wf = kit.makeWorld(); wf.configure({ mode: 'engine', available: AV });
  const fc = (await facts.recordParty(wf.env, { kind: 'organisation', name: 'Patel', roles: ['customer'] }, CTX)).id;
  const f1 = await facts.recordDocument(wf.env, { kind: 'invoice', direction: 'sell', partyId: fc, currency: 'ZAR', issuedOn: '2026-10-01', lines: [{ description: 'F', quantityMilli: 1000, unit: 'u', unitPriceMinor: 100000, taxBp: 1500 }] }, CTX);
  const f2 = await facts.recordDocument(wf.env, { kind: 'invoice', direction: 'sell', partyId: fc, currency: 'ZAR', issuedOn: '2026-10-02', lines: [{ description: 'G', quantityMilli: 1000, unit: 'u', unitPriceMinor: 20000, taxBp: 1500 }] }, CTX);
  const pm = await facts.recordPayment(wf.env, { direction: 'in', partyId: fc, amountMinor: 200000, currency: 'ZAR', occurredOn: '2026-10-03', method: 'eft', allocations: [{ documentId: f1.id, amountMinor: 115000 }] }, CTX);
  await facts.allocatePayment(wf.env, { paymentId: pm.movementId, invoiceId: f2.id, amountMinor: 23000, allocatedOn: '2026-10-04' }, CTX);
  const rr = await facts.refundPayment(wf.env, { paymentId: pm.movementId, amountMinor: 10000, refundedOn: '2026-10-05', method: 'eft' }, CTX);
  let integ = await verifyIntegrity(wf.env);
  check(integ.ok === true && integ.problems.length === 0 && integ.warnings.length === 0, 'the integrity verifier is clean after an allocation and a refund of an overpayment, with no warning about an unmodelled event');
  wf.db.prepare("INSERT INTO eng_event (type, payload_json) VALUES ('overpayment.refunded', ?)").run(JSON.stringify({ movementId: pm.movementId, refundMovementId: rr.movementId, amountMinor: 99999999, refundedOn: '2026-10-06', method: 'eft' }));
  integ = await verifyIntegrity(wf.env);
  check(integ.problems.some((p) => /spend more|more than/i.test(p.detail)), 'refunds and allocations that together spend more than the payment are REPORTED by the verifier');
  wf.db.prepare("INSERT INTO eng_event (type, payload_json) VALUES ('overpayment.allocated', ?)").run(JSON.stringify({ movementId: 424242, invoiceId: f2.id, allocationId: 1, amountMinor: 1, allocatedOn: '2026-10-04' }));
  integ = await verifyIntegrity(wf.env);
  check(integ.problems.some((p) => p.code === 'orphan' && /424242/.test(p.detail) && /does not exist/.test(p.detail)), 'an allocation of a payment that does not exist is REPORTED (orphan)');
  const mkp = async () => { const x = kit.makeWorld(); x.configure({ mode: 'engine', available: AV }); const c = (await facts.recordParty(x.env, { kind: 'organisation', name: 'P', roles: ['customer'] }, CTX)).id; const a = await facts.recordDocument(x.env, { kind: 'invoice', direction: 'sell', partyId: c, currency: 'ZAR', issuedOn: '2026-10-01', lines: [{ description: 'F', quantityMilli: 1000, unit: 'u', unitPriceMinor: 100000, taxBp: 1500 }] }, CTX); const b = await facts.recordDocument(x.env, { kind: 'invoice', direction: 'sell', partyId: c, currency: 'ZAR', issuedOn: '2026-10-02', lines: [{ description: 'G', quantityMilli: 1000, unit: 'u', unitPriceMinor: 20000, taxBp: 1500 }] }, CTX); const p = await facts.recordPayment(x.env, { direction: 'in', partyId: c, amountMinor: 200000, currency: 'ZAR', occurredOn: '2026-10-03', method: 'eft', allocations: [{ documentId: a.id, amountMinor: 115000 }] }, CTX); return { x, a, b, p }; };
  const atomic = async (label, act) => { const pr = await mkp(); pr.x.resetWrites(); await act(pr); const writes = pr.x.writeCount(); const leaked = []; for (let n = 1; n <= writes; n++) { const q = await mkp(); const was = JSON.stringify(q.x.counts()); q.x.failAt(n); let threw = false; try { await act(q); } catch { threw = true; } if (!threw || JSON.stringify(q.x.counts()) !== was) leaked.push(n); } check(writes >= 2 && leaked.length === 0, `${label} is atomic: a failure at each of its ${writes} writes leaves nothing behind` + (leaked.length ? ' (leaked at ' + leaked.join(',') + ')' : '')); };
  const xp = await mkp(); const xc = (await facts.recordParty(xp.x.env, { kind: 'organisation', name: 'Other Customer', roles: ['customer'] }, CTX)).id;
  const xinv = await facts.recordDocument(xp.x.env, { kind: 'invoice', direction: 'sell', partyId: xc, currency: 'ZAR', issuedOn: '2026-10-02', lines: [{ description: 'H', quantityMilli: 1000, unit: 'u', unitPriceMinor: 20000, taxBp: 1500 }] }, CTX);
  let xcode = null; try { await facts.allocatePayment(xp.x.env, { paymentId: xp.p.movementId, invoiceId: xinv.id, amountMinor: 1000, allocatedOn: '2026-10-05' }, CTX); } catch (e) { xcode = e && e.code; }
  check(xcode === 'invalid_state', `an overpayment cannot be allocated to another customer's invoice (${xcode})`);
  await atomic('allocating an overpayment', (q) => facts.allocatePayment(q.x.env, { paymentId: q.p.movementId, invoiceId: q.b.id, amountMinor: 23000, allocatedOn: '2026-10-04' }, CTX));
  await atomic('refunding an overpayment', (q) => facts.refundPayment(q.x.env, { paymentId: q.p.movementId, amountMinor: 10000, refundedOn: '2026-10-05', method: 'eft' }, CTX));
});

if (require.main === module) kit.standalone(module.exports);
