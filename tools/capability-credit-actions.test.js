// Credit-note follow-ups, points 3 and 4 (branch engine-phase1): the per-line rounding rule, and the four actions that were not built: apply a leftover credit to another invoice, refund it, void a credit note, and issue a debit note.
// TESTS FIRST. Evidence label for every check: TEST of the engine on the route harness (NOT staging, NOT production). Expected state when first committed: RED. Research and decisions: docs/decisions/credit-note-follow-ups.md.
// In short: a full credit reproduces the invoice's tax to the cent, and credits can never add up to more tax than the invoice charged on a line; leftover credit is APPLIED to another invoice of the same customer (with its own date,
// never blocked by the tax lock because it changes no VAT) or REFUNDED (a separate money-out movement, never more than the credit left); a credit note can be VOIDED only while none of its credit has been applied elsewhere or refunded
// and not once its period is locked; and a DEBIT NOTE increases an invoice (tax inherited from the invoice line) and is owed by the customer like an invoice.
const kit = require('./engine-kit.js');

module.exports = kit.guard('credit actions', async ({ check }) => {
  const eng = kit.loadEngine();
  check(Boolean(eng && eng.permissions && eng.capabilities && eng.facts && eng.ledger), 'the engine exposes permissions, capabilities, facts and the ledger');
  if (!eng || !eng.permissions || !eng.ledger) return;
  const auth = kit.bundle('auth.ts', 'auth');
  const member = (role) => ({ email: `${role}@example.com`, caps: auth.ROLE_CAPABILITIES[role] || [] });
  const AV = [...kit.ALL_CAPABILITIES, 'credit_note.issue', 'credits.find', 'credit.apply', 'refund.record', 'credit_note.void', 'debit_note.issue', 'tax_lock.set', 'party.create'];
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
    do(cap, payload, role = 'accountant') { const id = api.prop(cap, payload, role); api.ok(id, role); return id; } }; return api; };
  const has = (role, p) => eng.permissions.permissionsFor(member(role).caps).has(p);

  // ---- 0. PERMISSIONS ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const PERMS = ['credit.apply', 'refund.record', 'credit_note.void', 'debit_note.issue'];
  check(['owner', 'accountant', 'admin'].every((r) => PERMS.every((p) => has(r, p))), 'owner, accountant and admin may apply, refund, void and issue debit notes (money corrections)');
  check(['sales', 'installer'].every((r) => PERMS.every((p) => !has(r, p))), 'a salesperson and an installer may not');
  check(['credits.find', 'credit.apply', 'refund.record', 'credit_note.void', 'debit_note.issue'].every((c) => eng.capabilities.CAPABILITY_IDS.includes(c)), 'the five capabilities exist in the engine');

  // ---- 1. ROUNDING (point 3): a full credit reproduces the invoice's tax to the cent; credits never add up to more tax than was charged ------------------------------------------------------------------
  const { facts } = eng; const CTX = { actorEmail: 'accountant@example.com', contract: 'test', contractVersion: 1 };
  const mk = async () => { const w = kit.makeWorld(); w.configure({ mode: 'engine', available: AV }); const c = (await facts.recordParty(w.env, { kind: 'organisation', name: 'Patel', roles: ['customer'] }, CTX)).id; return { w, c }; };
  let seed = 12345; const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  let mismatches = 0; const { w: rw, c: rc } = await mk();
  for (let i = 0; i < 40; i++) {
    const lines = Array.from({ length: 1 + rnd(4) }, (_, k) => ({ description: 'L' + k, quantityMilli: 1 + rnd(7000), unit: 'u', unitPriceMinor: 1 + rnd(99999), taxBp: [0, 1500, 1500, 500][rnd(4)] }));
    const inv = await facts.recordDocument(rw.env, { kind: 'invoice', direction: 'sell', partyId: rc, currency: 'ZAR', issuedOn: '2026-10-01', lines }, CTX);
    const cn = await facts.issueCreditNote(rw.env, { invoiceId: inv.id, reason: 'full', issuedOn: '2026-10-02', lines: lines.map((l, k) => ({ invoiceLineNo: k + 1, quantityMilli: l.quantityMilli, unitPriceMinor: l.unitPriceMinor })) }, CTX);
    const t = await eng.ledger.documentTotals(rw.env, inv.id);
    if (cn.totals.netMinor !== t.netMinor || cn.totals.taxMinor !== t.taxMinor || cn.totals.grossMinor !== t.grossMinor) mismatches++;
  }
  check(mismatches === 0, 'for 40 random invoices of 1 to 4 lines, crediting every line in full reproduces the invoice\'s net, tax and total to the cent (per-line rounding, the same arithmetic both ways)');
  const { w: tw, c: tc } = await mk();
  const thin = await facts.recordDocument(tw.env, { kind: 'invoice', direction: 'sell', partyId: tc, currency: 'ZAR', issuedOn: '2026-10-01', lines: [{ description: 'Small', quantityMilli: 1000, unit: 'u', unitPriceMinor: 30, taxBp: 1500 }] }, CTX);
  const invTax = (await eng.ledger.documentTotals(tw.env, thin.id)).taxMinor; let creditedTax = 0, refused = null;
  for (let k = 0; k < 3; k++) { try { const r = await facts.issueCreditNote(tw.env, { invoiceId: thin.id, reason: 'bit', issuedOn: '2026-10-02', lines: [{ invoiceLineNo: 1, quantityMilli: 1000, unitPriceMinor: 10 }] }, CTX); creditedTax += r.totals.taxMinor; } catch (e) { refused = e && e.code; } }
  check(creditedTax <= invTax, `credits that each round up can never add up to more tax than the invoice charged on the line (invoice tax ${invTax}c, credited ${creditedTax}c)`);
  check(creditedTax === invTax || refused === 'invalid_state', 'and if rounding would push the credited tax over, the credit is refused (invalid_state) instead of crediting a cent too much');
  const roundStatic = await mk(); const pr = await facts.recordDocument(roundStatic.w.env, { kind: 'invoice', direction: 'sell', partyId: roundStatic.c, currency: 'ZAR', issuedOn: '2026-10-01', lines: [{ description: 'X', quantityMilli: 1000, unit: 'u', unitPriceMinor: 30, taxBp: 1500 }] }, CTX);
  let msg = null; try { for (let k = 0; k < 6; k++) await facts.issueCreditNote(roundStatic.w.env, { invoiceId: pr.id, reason: 'bit', issuedOn: '2026-10-02', lines: [{ invoiceLineNo: 1, quantityMilli: 1000, unitPriceMinor: 5 }] }, CTX); } catch (e) { msg = e && e.message; }
  check(msg === null || /one credit note|fewer|more tax|worth/i.test(String(msg)), 'the refusal says what to do (credit the line in fewer notes) or that the line is used up');

  // ---- helpers for the route scenarios ------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const pay = (amountMinor) => ({ partyId: 1, amountMinor, currency: 'ZAR', occurredOn: '2026-11-05', allocate: 'oldest_first' });
  const credit = (extra = {}) => ({ invoiceId: 1, reason: 'Boards damaged on delivery', issuedOn: '2026-11-10', lines: [{ invoiceLineNo: 1, quantityMilli: 500, unitPriceMinor: 100000 }], ...extra });   // R575.00
  // invoice 1 paid in full, then credited R575.00: the whole credit is UNAPPLIED (credit note is document 3 (invoice 1, invoice 2, then it)), invoice 2 still owes R230.00
  const base = seq(); base.do('payment.record', pay(115000)); base.do('credit_note.issue', credit());
  const cnId = async (steps) => { const r = await run({ before: steps, ...open('accountant', 'document', 1) }); return ((body(r).result || {}).relations || []).find((x) => x.role === 'credit_note').ref.id; };
  const CN = await cnId(base.steps);
  const cnView = async (steps, id = CN, role = 'accountant') => { const r = await run({ before: steps, ...open(role, 'document', id) }); return body(r).result || {}; };
  check(fieldOf(await cnView(base.steps), 'availableMinor') === 57500, 'a credit note opens with the credit still AVAILABLE to apply or refund (R575.00)');
  const acct = async (steps) => (body(await run({ before: steps, ...owes() })).result) || {};
  const aply = (extra = {}) => ({ creditNoteId: CN, invoiceId: 2, amountMinor: 23000, appliedOn: '2026-11-11', ...extra });

  // ---- 2. APPLY a leftover credit to another invoice -----------------------------------------------------------------------------------------------------------------------------------------------------
  let r = await run({ before: base.steps, ...propose('accountant', 'credit.apply', aply(), 'Use the Mokoena credit to pay off invoice 2') });
  check(status(r) === 200 && body(r).status === 'held' && touchesNoFact(r) && added(r, 'eng_event') === 0, `proposing it is HELD and records nothing (${status(r)} ${body(r).status})`);
  const ap = seq(); ap.steps.push(...base.steps); ap.do('credit.apply', aply());
  const baseN = base.steps.length / 2;   // the sequencer counts actions: base used 2 actions
  const ap2 = seq(); ap2.do('payment.record', pay(115000)); ap2.do('credit_note.issue', credit()); const aId = ap2.prop('credit.apply', aply());
  r = await run({ before: ap2.steps, ...confirm('accountant', aId) });
  check(status(r) === 200 && added(r, 'eng_allocation') === 1 && added(r, 'eng_money_movement') === 0 && added(r, 'eng_document') === 0 && added(r, 'eng_event') === 3, `approving it records ONE allocation of the credit (no new money, no new document) with the credit.allocated event: 3 events with the allocation and the execution (${status(r)})`);
  ap2.ok(aId);
  let inv2 = await run({ before: ap2.steps, ...open('accountant', 'document', 2) });
  check(fieldOf(body(inv2).result, 'outstandingMinor') === 0 && fieldOf(body(inv2).result, 'status') === 'paid', 'invoice 2 is now paid by the credit');
  check(fieldOf(await cnView(ap2.steps), 'availableMinor') === 34500 && (await acct(ap2.steps)).unappliedCreditMinor === 34500 && (await acct(ap2.steps)).totalMinor === 0, 'the credit left falls to R345.00, the customer\'s account shows it, and they owe nothing');
  const partial = seq(); partial.do('payment.record', pay(115000)); partial.do('credit_note.issue', credit()); partial.do('credit.apply', aply({ amountMinor: 10000 }));
  inv2 = await run({ before: partial.steps, ...open('accountant', 'document', 2) });
  check(fieldOf(body(inv2).result, 'outstandingMinor') === 13000 && fieldOf(await cnView(partial.steps), 'availableMinor') === 47500, 'a part application works (R100.00 of it)');
  const applyRules = [
    [aply({ amountMinor: 57501 }), 'invalid_state', 'more than the credit that is left'], [aply({ amountMinor: 23001 }), 'invalid_state', 'more than the invoice owes'], [aply({ invoiceId: 1 }), 'invalid_state', 'an invoice that owes nothing (invoice 1 is paid)'],
    [aply({ creditNoteId: 2 }), 'invalid_state', 'something that is not a credit note (invoice 2)'], [aply({ creditNoteId: 999 }), 'not_found', 'a credit note that does not exist'], [aply({ invoiceId: 999 }), 'not_found', 'an invoice that does not exist'],
    [aply({ appliedOn: '2026-11-09' }), 'invalid_input', 'a date before the credit note'],
  ];
  for (const [payload, code, why] of applyRules) { r = await run({ before: base.steps, ...propose('accountant', 'credit.apply', payload) }); check(body(r).error === code && touchesNoFact(r) && added(r, 'eng_event') === 0, `${why} is refused at the door as ${code} (${status(r)} ${body(r).error}) and records nothing`); }
  for (const [payload, why] of [[aply({ amountMinor: 0 }), 'an amount of zero'], [aply({ amountMinor: 1.5 }), 'a fractional amount'], [aply({ colour: 'x' }), 'a field nobody declared'], [aply({ appliedOn: '2026-13-01' }), 'a date that does not exist'], [{}, 'nothing at all']]) { r = await run({ before: base.steps, ...propose('accountant', 'credit.apply', payload) }); check(status(r) === 422 && body(r).error === 'invalid_payload', `${why} is refused as invalid_payload`); }
  for (const role of ['sales', 'installer']) { r = await run({ before: base.steps, ...propose(role, 'credit.apply', aply()) }); check(status(r) === 403 && touchesNoFact(r), `${role} may not apply a credit`); }
  r = await kit.route({ env: ENV, seed: kit.seedReceivables(kit.ALL_CAPABILITIES), before: base.steps.slice(0, 0), ...propose('accountant', 'credit.apply', aply()) }); check(status(r) === 409 && body(r).error === 'capability_unavailable', 'a business without the capability is told so');
  const twice = seq(); twice.do('payment.record', pay(115000)); twice.do('credit_note.issue', credit()); const t1 = twice.prop('credit.apply', aply()); const t2 = twice.prop('credit.apply', aply()); twice.ok(t1);
  r = await run({ before: twice.steps, ...confirm('accountant', t2) });
  check(status(r) === 409 && added(r, 'eng_allocation') === 0, 'the same application approved twice cannot pay invoice 2 twice (stale or nothing left owing)');
  const locked = seq(); locked.do('payment.record', pay(115000)); locked.do('credit_note.issue', credit()); locked.do('tax_lock.set', { lockDate: '2026-11-10' }, 'owner'); const lk = locked.prop('credit.apply', aply());
  r = await run({ before: locked.steps, ...confirm('accountant', lk) });
  check(status(r) === 200 && added(r, 'eng_allocation') === 1, 'applying a credit is NOT blocked by the tax lock (it changes no VAT), as long as it is dated after both documents');

  // ---- 3. REFUND a leftover credit ----------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const rf = (extra = {}) => ({ creditNoteId: CN, amountMinor: 10000, refundedOn: '2026-11-12', method: 'eft', ...extra });
  const rb = seq(); rb.do('payment.record', pay(115000)); rb.do('credit_note.issue', credit()); const rId = rb.prop('refund.record', rf(), 'accountant');
  r = await run({ before: rb.steps.slice(0, rb.steps.length), ...confirm('accountant', rId) });
  check(status(r) === 200 && added(r, 'eng_money_movement') === 1 && added(r, 'eng_allocation') === 0 && added(r, 'eng_document') === 0 && added(r, 'eng_event') === 3, `approving a refund records ONE money-out movement (nothing allocated, no document) and the credit.refunded event: 3 events (${status(r)})`);
  rb.ok(rId);
  check(fieldOf(await cnView(rb.steps), 'availableMinor') === 47500 && (await acct(rb.steps)).unappliedCreditMinor === 47500 && (await acct(rb.steps)).totalMinor === 23000, 'the credit left falls to R475.00, shown on the account, and what the customer owes is unchanged');
  const full = seq(); full.do('payment.record', pay(115000)); full.do('credit_note.issue', credit()); full.do('refund.record', rf({ amountMinor: 57500 }));
  check(fieldOf(await cnView(full.steps), 'availableMinor') === 0 && (await acct(full.steps)).unappliedCreditMinor === 0, 'refunding all of it leaves no credit');
  const refundRules = [
    [rf({ amountMinor: 57501 }), 'invalid_state', 'more than the credit that is left'], [rf({ creditNoteId: 1 }), 'invalid_state', 'something that is not a credit note'], [rf({ creditNoteId: 999 }), 'not_found', 'a credit note that does not exist'],
  ];
  for (const [payload, code, why] of refundRules) { r = await run({ before: base.steps, ...propose('accountant', 'refund.record', payload) }); check(body(r).error === code && touchesNoFact(r) && added(r, 'eng_event') === 0, `${why} is refused at the door as ${code} (${status(r)} ${body(r).error}) and records nothing`); }
  for (const [payload, why] of [[rf({ amountMinor: 0 }), 'an amount of zero'], [rf({ method: 'barter' }), 'a method nobody declared'], [rf({ refundedOn: 'tomorrow' }), 'a date that is not a date'], [rf({ colour: 'x' }), 'a field nobody declared'], [rf({ refundedOn: '2026-11-09' }), 'a refund dated before the credit note']]) { r = await run({ before: base.steps, ...propose('accountant', 'refund.record', payload) }); check([422, 409].includes(status(r)) && touchesNoFact(r), `${why} is refused (${status(r)} ${body(r).error})`); }
  for (const role of ['sales', 'installer']) { r = await run({ before: base.steps, ...propose(role, 'refund.record', rf()) }); check(status(r) === 403 && touchesNoFact(r), `${role} may not record a refund`); }
  r = await run({ before: (() => { const q = seq(); q.do('payment.record', pay(115000)); q.do('credit_note.issue', credit()); q.do('refund.record', rf({ amountMinor: 40000 })); return q.steps; })(), ...propose('accountant', 'credit.apply', aply({ amountMinor: 23000 })) });
  check(status(r) === 409 && body(r).error === 'invalid_state' && touchesNoFact(r) && /17500/.test(String(body(r).message || '')), 'after a refund of R400.00 only R175.00 of the credit is left, so applying R230.00 is refused at the door and the message says how much is left (the credit itself is the limit, not the invoice)');
  const overspend = seq(); overspend.do('payment.record', pay(115000)); overspend.do('credit_note.issue', credit()); const o1 = overspend.prop('refund.record', rf({ amountMinor: 40000 })); const o2 = overspend.prop('credit.apply', aply()); overspend.ok(o1);
  r = await run({ before: overspend.steps, ...confirm('accountant', o2) });
  check(status(r) === 409 && added(r, 'eng_allocation') === 0, 'a refund and an application cannot both spend the same credit: the second is refused once the first is approved');

  // ---- 4. VOID a credit note ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const vd = (extra = {}) => ({ creditNoteId: CN, reason: 'Issued to the wrong customer', voidedOn: '2026-11-12', ...extra });
  const one = seq(); one.do('credit_note.issue', credit()); const oneCn = await cnId(one.steps);   // invoice 1 unpaid, credited R575.00 (applied to it)
  const vdo = (extra = {}) => ({ creditNoteId: oneCn, reason: 'Issued to the wrong customer', voidedOn: '2026-11-12', ...extra });
  const vp = seq(); vp.do('credit_note.issue', credit()); const vId = vp.prop('credit_note.void', vdo());
  r = await run({ before: vp.steps, ...confirm('accountant', vId) });
  check(status(r) === 200 && added(r, 'eng_reversal') === 3 && added(r, 'eng_document') === 0 && added(r, 'eng_money_movement') === 0 && added(r, 'eng_allocation') === 0, `approving a void records reversals of the credit note, its movement and its allocation (3), and adds no new money or document (${status(r)})`);
  vp.ok(vId);
  const i1 = await run({ before: vp.steps, ...open('accountant', 'document', 1) });
  check(fieldOf(body(i1).result, 'outstandingMinor') === 115000 && fieldOf(body(i1).result, 'creditedMinor') === 0 && fieldOf(body(i1).result, 'status') === 'unpaid', 'the invoice owes what it did before the credit note, and nothing is credited');
  const vcn = await cnView(vp.steps, oneCn);
  check(fieldOf(vcn, 'status') === 'voided' && fieldOf(vcn, 'availableMinor') === 0 && (vcn.history || []).some((h) => h.type === 'credit_note.voided' && h.contract === 'credit_note.void' && h.approvedBy === 'accountant@example.com'), 'the credit note opens as voided, with the void explained (who approved it, under which contract)');
  check((await acct(vp.steps)).totalMinor === 138000 && (await acct(vp.steps)).unappliedCreditMinor === 0, 'the customer owes R1,380.00 again and no credit is left');
  const again = seq(); again.do('credit_note.issue', credit()); again.do('credit_note.void', vdo()); again.do('credit_note.issue', credit({ lines: [{ invoiceLineNo: 1, quantityMilli: 1000, unitPriceMinor: 100000 }] }));
  const i1b = await run({ before: again.steps, ...open('accountant', 'document', 1) });
  check(fieldOf(body(i1b).result, 'creditedMinor') === 115000 && fieldOf(body(i1b).result, 'outstandingMinor') === 0, 'after a void the line can be credited in full again (a voided credit no longer counts against the line)');
  r = await run({ before: vp.steps, ...propose('accountant', 'credit_note.void', vdo()) }); check(status(r) === 409 && body(r).error === 'invalid_state' && touchesNoFact(r), 'voiding one that is already voided is refused as invalid_state');
  const spent = seq(); spent.do('payment.record', pay(115000)); spent.do('credit_note.issue', credit()); spent.do('credit.apply', aply({ amountMinor: 1000 }));
  r = await run({ before: spent.steps, ...propose('accountant', 'credit_note.void', vdo({ creditNoteId: CN })) });
  check(status(r) === 409 && body(r).error === 'invalid_state' && touchesNoFact(r), 'a credit note whose credit has been applied to another invoice cannot be voided');
  const refunded = seq(); refunded.do('payment.record', pay(115000)); refunded.do('credit_note.issue', credit()); refunded.do('refund.record', rf({ amountMinor: 1000 }));
  r = await run({ before: refunded.steps, ...propose('accountant', 'credit_note.void', vdo({ creditNoteId: CN })) });
  check(status(r) === 409 && body(r).error === 'invalid_state' && touchesNoFact(r), 'nor one whose credit has been refunded');
  const unspent = seq(); unspent.do('payment.record', pay(115000)); unspent.do('credit_note.issue', credit()); const uv = unspent.prop('credit_note.void', vdo({ creditNoteId: CN }));
  r = await run({ before: unspent.steps, ...confirm('accountant', uv) });
  check(status(r) === 200 && added(r, 'eng_reversal') === 2, 'one whose credit is entirely unapplied can be voided (2 reversals: the credit note and its movement, no allocation)');
  const lk2 = seq(); lk2.do('credit_note.issue', credit({ issuedOn: '2026-11-10' })); lk2.do('tax_lock.set', { lockDate: '2026-11-10' }, 'owner');
  r = await run({ before: lk2.steps, ...propose('accountant', 'credit_note.void', vdo()) });
  check(status(r) === 409 && body(r).error === 'period_locked' && touchesNoFact(r), 'a credit note dated on or before the tax lock cannot be voided (it would change a filed return)');
  for (const [payload, why] of [[vdo({ reason: '' }), 'no reason'], [vdo({ reason: 'x'.repeat(201) }), 'a reason over 200 characters'], [vdo({ voidedOn: 'someday' }), 'a date that is not a date'], [vdo({ colour: 'x' }), 'a field nobody declared'], [{}, 'nothing at all']]) { r = await run({ before: one.steps, ...propose('accountant', 'credit_note.void', payload) }); check(status(r) === 422 && body(r).error === 'invalid_payload' && touchesNoFact(r), `${why} is refused as invalid_payload`); }
  r = await run({ before: one.steps, ...propose('accountant', 'credit_note.void', vdo({ creditNoteId: 1 })) }); check(status(r) === 409 && body(r).error === 'invalid_state', 'voiding something that is not a credit note (invoice 1) is refused');
  r = await run({ before: one.steps, ...propose('accountant', 'credit_note.void', vdo({ creditNoteId: 999 })) }); check(status(r) === 404, 'voiding one that does not exist is refused as not_found');
  for (const role of ['sales', 'installer']) { r = await run({ before: one.steps, ...propose(role, 'credit_note.void', vdo()) }); check(status(r) === 403 && touchesNoFact(r), `${role} may not void a credit note`); }

  // ---- 5. DEBIT NOTE: increases an invoice ---------------------------------------------------------------------------------------------------------------------------------------------------------------
  const dn = (extra = {}) => ({ invoiceId: 1, reason: 'Extra underlay supplied on site', issuedOn: '2026-11-10', lines: [{ invoiceLineNo: 1, quantityMilli: 500, unitPriceMinor: 20000 }], ...extra });   // net 10000, tax 1500, gross 11500
  let rr = await run(propose('accountant', 'debit_note.issue', dn(), 'We supplied extra underlay, bill Mokoena for it'));
  check(status(rr) === 200 && body(rr).status === 'held' && touchesNoFact(rr) && JSON.stringify(rr.writes || {}).includes('11500'), 'proposing a debit note is HELD, records nothing, and the approval is shown the exact R115.00');
  const d1 = seq(); d1.do('debit_note.issue', dn());
  rr = await run({ before: d1.steps.slice(0, 1), ...confirm('accountant', 1) });
  check(status(rr) === 200 && added(rr, 'eng_document') === 1 && added(rr, 'eng_document_line') === 1 && added(rr, 'eng_document_number') === 1 && added(rr, 'eng_money_movement') === 0 && added(rr, 'eng_event') === 3, `approving it records ONE debit note document with its line and number, no money, and the debit_note.issued event (${status(rr)})`);
  check((await acct(d1.steps)).totalMinor === 138000 + 11500, 'the customer now owes R115.00 more (a debit note is owed like an invoice)');
  const inv1 = await run({ before: d1.steps, ...open('accountant', 'document', 1) });
  const dnId = ((body(inv1).result || {}).relations || []).find((x) => x.role === 'debit_note');
  check(Boolean(dnId) && fieldOf(body(inv1).result, 'outstandingMinor') === 115000, 'the invoice links to its debit note and still says what it charged; the debit note carries the extra');
  const dnv = await run({ before: d1.steps, ...open('accountant', 'document', dnId ? dnId.ref.id : 0) });
  check((body(dnv).result || {}).title === 'Debit note #1' && fieldOf(body(dnv).result, 'taxMinor') === 1500 && fieldOf(body(dnv).result, 'outstandingMinor') === 11500 && (body(dnv).result.relations || []).some((x) => x.role === 'debits' && x.ref.id === 1), 'it opens as Debit note #1 with the invoice line\'s own 15% tax (R15.00), R115.00 outstanding, and what it debits');
  const issuedH = ((body(dnv).result || {}).history || []).find((h) => h.type === 'debit_note.issued') || {};
  check(issuedH.contract === 'debit_note.issue' && issuedH.approvedBy === 'accountant@example.com' && Number.isInteger(issuedH.captureId) && Number.isInteger(issuedH.interpretationId), 'it is EXPLAINED: what was said, what was understood, who approved, under which contract');
  const pd = seq(); pd.do('debit_note.issue', dn()); pd.do('payment.record', { partyId: 1, amountMinor: 149500, currency: 'ZAR', occurredOn: '2026-11-11', allocate: 'oldest_first' });   // invoice 1 (R1,150.00) + invoice 2 (R230.00) + the debit note (R115.00), oldest first
  const dnAfter = await run({ before: pd.steps, ...open('accountant', 'document', dnId ? dnId.ref.id : 0) });
  check(fieldOf(body(dnAfter).result, 'outstandingMinor') === 0, 'a payment is allocated to the debit note like any other debt (oldest first)');
  const dnRules = [[dn({ invoiceId: 999 }), 'not_found', 'an invoice that does not exist'], [dn({ lines: [{ invoiceLineNo: 7, quantityMilli: 500, unitPriceMinor: 20000 }] }), 'invalid_input', 'a line the invoice does not have'], [dn({ lines: [{ invoiceLineNo: 1, quantityMilli: 500, unitPriceMinor: 0 }] }), 'invalid_input', 'a debit of nothing'], [dn({ issuedOn: '2026-09-30' }), 'invalid_input', 'a debit dated before the invoice']];
  for (const [payload, code, why] of dnRules) { rr = await run(propose('accountant', 'debit_note.issue', payload)); check(body(rr).error === code && touchesNoFact(rr), `${why} is refused at the door as ${code} (${status(rr)} ${body(rr).error})`); }
  for (const [payload, why] of [[dn({ reason: '' }), 'no reason'], [dn({ lines: [] }), 'no lines'], [dn({ lines: [{ invoiceLineNo: 1, quantityMilli: 500, unitPriceMinor: 20000, taxBp: 0 }] }), 'a tax rate supplied (inherited from the invoice line)'], [dn({ colour: 'x' }), 'a field nobody declared'], [dn({ issuedOn: '2026-02-30' }), 'a date that does not exist']]) { rr = await run(propose('accountant', 'debit_note.issue', payload)); check(status(rr) === 422 && body(rr).error === 'invalid_payload' && touchesNoFact(rr), `${why} is refused as invalid_payload`); }
  const q = seq(); q.do('credit_note.issue', credit()); rr = await run({ before: q.steps, ...propose('accountant', 'debit_note.issue', dn({ invoiceId: await cnId(q.steps) })) });
  check(status(rr) === 409 && body(rr).error === 'invalid_state', 'a debit note cannot debit a credit note (only an invoice)');
  for (const role of ['sales', 'installer']) { rr = await run(propose(role, 'debit_note.issue', dn())); check(status(rr) === 403 && touchesNoFact(rr), `${role} may not issue a debit note`); }
  const lk3 = seq(); lk3.do('tax_lock.set', { lockDate: '2026-11-10' }, 'owner'); rr = await run({ before: lk3.steps, ...propose('accountant', 'debit_note.issue', dn()) });
  check(status(rr) === 409 && body(rr).error === 'period_locked' && touchesNoFact(rr), 'a debit note dated on or before the tax lock is refused as period_locked');
  rr = await run({ before: [propose('accountant', 'debit_note.issue', dn()), confirm('accountant', 1)], ...confirm('accountant', 1) }); check(status(rr) !== 200 && added(rr, 'eng_document') === 0, 'approving the same debit note twice never bills twice');
  rr = await kit.route({ env: ENV, seed: kit.seedReceivables(kit.ALL_CAPABILITIES), ...propose('accountant', 'debit_note.issue', dn()) }); check(status(rr) === 409 && body(rr).error === 'capability_unavailable', 'a business without the capability is told so');

  // ---- 6. FINDING credit that is available ---------------------------------------------------------------------------------------------------------------------------------------------------------------
  rr = await run({ before: base.steps, method: 'GET', path: '/engine/credits?partyId=1', role: 'accountant' });
  const cr = (body(rr).result || {}).credits || [];
  check(status(rr) === 200 && cr.length === 1 && cr[0].availableMinor === 57500 && cr[0].ref.id === CN && cr[0].partyId === 1, 'finding credits lists the credit note with R575.00 available and a reference to open it');
  rr = await run({ before: full.steps, method: 'GET', path: '/engine/credits?partyId=1', role: 'accountant' });
  check(status(rr) === 200 && ((body(rr).result || {}).credits || []).length === 0, 'a credit that has been fully refunded is not listed');
  rr = await run({ before: base.steps, method: 'GET', path: '/engine/credits', role: 'installer' }); check(status(rr) === 403, 'an installer is refused');
  rr = await run({ before: base.steps, method: 'GET', path: '/engine/credits?partyId=abc', role: 'accountant' }); check(status(rr) === 422, 'a partyId that is not a number is refused as invalid');

  // ---- 7. THE FOUNDATIONS STILL HOLD ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const { verifyIntegrity, EVENT_MODEL } = eng;
  check(['credit.allocated', 'credit.refunded', 'credit_note.voided', 'debit_note.issued'].every((t) => EVENT_MODEL[t] && EVENT_MODEL[t].creates === null), 'the event model knows the four new events and says they create no fact row of their own');
  const wf = await mk(); const fi = await facts.recordDocument(wf.w.env, { kind: 'invoice', direction: 'sell', partyId: wf.c, currency: 'ZAR', issuedOn: '2026-10-01', lines: [{ description: 'F', quantityMilli: 1000, unit: 'u', unitPriceMinor: 100000, taxBp: 1500 }] }, CTX);
  const fi2 = await facts.recordDocument(wf.w.env, { kind: 'invoice', direction: 'sell', partyId: wf.c, currency: 'ZAR', issuedOn: '2026-10-02', lines: [{ description: 'G', quantityMilli: 1000, unit: 'u', unitPriceMinor: 20000, taxBp: 1500 }] }, CTX);
  await facts.recordPayment(wf.w.env, { direction: 'in', partyId: wf.c, amountMinor: 115000, currency: 'ZAR', occurredOn: '2026-10-03', method: 'eft', allocations: [{ documentId: fi.id, amountMinor: 115000 }] }, CTX);
  const cnf = await facts.issueCreditNote(wf.w.env, { invoiceId: fi.id, reason: 'x', issuedOn: '2026-10-04', lines: [{ invoiceLineNo: 1, quantityMilli: 500, unitPriceMinor: 100000 }] }, CTX);
  await facts.applyCredit(wf.w.env, { creditNoteId: cnf.documentId, invoiceId: fi2.id, amountMinor: 10000, appliedOn: '2026-10-05' }, CTX);
  await facts.refundCredit(wf.w.env, { creditNoteId: cnf.documentId, amountMinor: 5000, refundedOn: '2026-10-06', method: 'eft' }, CTX);
  await facts.issueDebitNote(wf.w.env, { invoiceId: fi.id, reason: 'extra', issuedOn: '2026-10-07', lines: [{ invoiceLineNo: 1, quantityMilli: 100, unitPriceMinor: 100000 }] }, CTX);
  let integ = await verifyIntegrity(wf.w.env);
  check(integ.ok === true && integ.problems.length === 0 && integ.warnings.length === 0, 'the integrity verifier is clean after a credit, an application, a refund and a debit note, with no warning about an unmodelled event');
  wf.w.db.prepare("INSERT INTO eng_event (type, payload_json) VALUES ('credit.allocated', ?)").run(JSON.stringify({ creditNoteId: 8888, invoiceId: fi2.id, allocationId: 1, amountMinor: 1, appliedOn: '2026-10-05' }));
  integ = await verifyIntegrity(wf.w.env);
  check(integ.ok === false && integ.problems.some((p) => p.code === 'orphan' && /8888/.test(p.detail) && /does not exist/.test(p.detail)), 'an application that points at a credit note that does not exist is REPORTED (orphan)');
  wf.w.db.prepare("INSERT INTO eng_event (type, payload_json) VALUES ('credit.refunded', ?)").run(JSON.stringify({ creditNoteId: cnf.documentId, movementId: 1, refundMovementId: 1, amountMinor: 99999999, refundedOn: '2026-10-06' }));
  integ = await verifyIntegrity(wf.w.env);
  check(integ.problems.some((p) => /more than|exceed|spent/i.test(p.detail)), 'refunds and applications that together spend more than the credit note are REPORTED by the verifier');
  // atomicity: a failure at each write of each action leaves nothing behind
  const atomic = async (label, prepare, act) => {
    const probe = await prepare(); probe.w.resetWrites(); await act(probe); const writes = probe.w.writeCount(); const leaked = [];
    for (let n = 1; n <= writes; n++) { const x = await prepare(); const was = JSON.stringify(x.w.counts()); x.w.failAt(n); let threw = false; try { await act(x); } catch { threw = true; } if (!threw || JSON.stringify(x.w.counts()) !== was) leaked.push(n); }
    check(writes >= 2 && leaked.length === 0, `${label} is atomic: a failure at each of its ${writes} writes leaves nothing behind` + (leaked.length ? ' (leaked at ' + leaked.join(',') + ')' : ''));
  };
  const prep = async () => { const x = await mk(); const a = await facts.recordDocument(x.w.env, { kind: 'invoice', direction: 'sell', partyId: x.c, currency: 'ZAR', issuedOn: '2026-10-01', lines: [{ description: 'F', quantityMilli: 1000, unit: 'u', unitPriceMinor: 100000, taxBp: 1500 }] }, CTX); const b = await facts.recordDocument(x.w.env, { kind: 'invoice', direction: 'sell', partyId: x.c, currency: 'ZAR', issuedOn: '2026-10-02', lines: [{ description: 'G', quantityMilli: 1000, unit: 'u', unitPriceMinor: 20000, taxBp: 1500 }] }, CTX);
    await facts.recordPayment(x.w.env, { direction: 'in', partyId: x.c, amountMinor: 115000, currency: 'ZAR', occurredOn: '2026-10-03', method: 'eft', allocations: [{ documentId: a.id, amountMinor: 115000 }] }, CTX);
    const cn = await facts.issueCreditNote(x.w.env, { invoiceId: a.id, reason: 'x', issuedOn: '2026-10-04', lines: [{ invoiceLineNo: 1, quantityMilli: 500, unitPriceMinor: 100000 }] }, CTX); return { ...x, a, b, cn }; };
  const xw = await prep(); const oc = (await facts.recordParty(xw.w.env, { kind: 'organisation', name: 'Other Customer', roles: ['customer'] }, CTX)).id;
  const oinv = await facts.recordDocument(xw.w.env, { kind: 'invoice', direction: 'sell', partyId: oc, currency: 'ZAR', issuedOn: '2026-10-02', lines: [{ description: 'H', quantityMilli: 1000, unit: 'u', unitPriceMinor: 20000, taxBp: 1500 }] }, CTX);
  let xcode = null; try { await facts.applyCredit(xw.w.env, { creditNoteId: xw.cn.documentId, invoiceId: oinv.id, amountMinor: 1000, appliedOn: '2026-10-05' }, CTX); } catch (e) { xcode = e && e.code; }
  check(xcode === 'invalid_state', `a credit cannot be applied to another customer's invoice (${xcode})`);
  await atomic('applying a credit', prep, (x) => facts.applyCredit(x.w.env, { creditNoteId: x.cn.documentId, invoiceId: x.b.id, amountMinor: 10000, appliedOn: '2026-10-05' }, CTX));
  await atomic('refunding a credit', prep, (x) => facts.refundCredit(x.w.env, { creditNoteId: x.cn.documentId, amountMinor: 5000, refundedOn: '2026-10-05', method: 'eft' }, CTX));
  await atomic('voiding a credit note', prep, (x) => facts.voidCreditNote(x.w.env, { creditNoteId: x.cn.documentId, reason: 'wrong', voidedOn: '2026-10-05' }, CTX));
  await atomic('issuing a debit note', prep, (x) => facts.issueDebitNote(x.w.env, { invoiceId: x.a.id, reason: 'extra', issuedOn: '2026-10-05', lines: [{ invoiceLineNo: 1, quantityMilli: 100, unitPriceMinor: 100000 }] }, CTX));
});

if (require.main === module) kit.standalone(module.exports);
