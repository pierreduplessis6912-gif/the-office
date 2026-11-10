// Credit notes (branch engine-phase1): issue. TESTS FIRST, in the Mokoena slice style (docs/CAPABILITY_MAP.md, "what done means", boxes 1 and 2). Evidence label for every check: TEST of the engine on the route harness (a stand-in for
// Durable Object storage: NOT staging, NOT production). Expected state when first committed: RED (credit_note.issue does not exist yet).
// What the capability is (docs/decisions/credit-notes.md, decided by Pierre as "best practice", 2026-11-10): a credit note is a DOCUMENT of kind "credit_note" that credits an INVOICE, line by line, for a stated REASON. Each credited
// line points at an invoice line and INHERITS its tax rate (never chosen again), and cannot credit more than that line was worth (cumulatively, across earlier credit notes). Issuing it is a held write that a person approves. It
// is then APPLIED to the invoice as a NON-CASH movement (method "credit") up to what is still owed on it; any excess (the invoice was already paid) stays as an unapplied credit on the customer, never silently refunded.
// A credit note is not a debt and nothing is edited: the invoice stays exactly as it was; what is owed is derived.
const kit = require('./engine-kit.js');

module.exports = kit.guard('credit notes', async ({ check }) => {
  const eng = kit.loadEngine();
  check(Boolean(eng && eng.permissions && eng.capabilities && eng.facts), 'the engine exposes permissions, capabilities and facts');
  if (!eng || !eng.permissions || !eng.capabilities) return;
  const auth = kit.bundle('auth.ts', 'auth');
  const member = (role) => ({ email: `${role}@example.com`, caps: auth.ROLE_CAPABILITIES[role] || [] });
  const AV = [...kit.ALL_CAPABILITIES, 'quotation.create', 'credit_note.issue'];
  const ENV = { BUSINESS_ID: 'eng-a' };
  const run = (spec) => kit.route({ env: ENV, seed: kit.seedReceivables(AV), ...spec });
  const propose = (role, capability, payload, transcript = 'a sentence from the person') => ({ method: 'POST', path: '/engine/proposals', role, body: { capability, payload, transcript } });
  const confirm = (role, id = 1) => ({ method: 'POST', path: `/actions/${id}/confirm`, role, body: {} });
  const open = (role, id) => ({ method: 'GET', path: `/engine/records/document/${id}`, role });
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
  // the seed: Mokoena owes invoice 1 (one line, 1.000 x R1,000.00 net, 15% tax, R1,150.00 gross) and invoice 2 (R230.00); R1,380.00 in all
  const credit = (extra = {}) => ({ invoiceId: 1, reason: 'Boards damaged on delivery', issuedOn: '2026-11-10', lines: [{ invoiceLineNo: 1, quantityMilli: 500, unitPriceMinor: 100000 }], ...extra });   // net 50000, tax 7500, gross 57500
  const inv = async (steps, id = 1, role = 'accountant') => { const r = await run({ before: steps, ...open(role, id) }); return { r, v: body(r).result || {} }; };
  const total = async (steps) => ((body(await run({ before: steps, ...owes() })).result) || {}).totalMinor;

  // ---- 1. PERMISSIONS --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const has = (role, p) => eng.permissions.permissionsFor(member(role).caps).has(p);
  check(['owner', 'accountant', 'admin'].every((r) => has(r, 'credit_note.issue')), 'owner, accountant and admin may issue a credit note (it is a money correction)');
  check(!has('sales', 'credit_note.issue') && !has('installer', 'credit_note.issue'), 'a salesperson and an installer may not');
  check(eng.capabilities.CAPABILITY_IDS.includes('credit_note.issue'), 'the capability exists in the engine');

  // ---- 2. ISSUE: held first, recorded only on approval ----------------------------------------------------------------------------------------------------------------------------------------------------
  let r = await run(propose('accountant', 'credit_note.issue', credit(), 'Credit Mokoena for half the boards, they arrived damaged'));
  check(status(r) === 200 && body(r).status === 'held' && touchesNoFact(r) && added(r, 'eng_event') === 0, `proposing a credit note is HELD and records nothing (${status(r)} ${body(r).status})`);
  check(JSON.stringify(r.writes || {}).includes('57500'), 'the approval is shown the exact credit the engine worked out (R575.00 with tax), not a figure the model made up');
  const one = seq(); one.do('credit_note.issue', credit());
  r = await run({ before: one.steps.slice(0, 1), ...confirm('accountant', 1) });
  check(status(r) === 200 && added(r, 'eng_document') === 1 && added(r, 'eng_document_line') === 1 && added(r, 'eng_document_number') === 1 && added(r, 'eng_money_movement') === 1 && added(r, 'eng_allocation') === 1, `approving it records the credit note, its line and number, ONE non-cash movement and ONE allocation (${status(r)})`);
  check(added(r, 'eng_event') === 5 && added(r, 'eng_reversal') === 0, 'with five events: document.issued, payment.recorded, the allocation, credit_note.issued and the execution; nothing reversed');
  let i1 = await inv(one.steps);
  check(fieldOf(i1.v, 'outstandingMinor') === 57500 && fieldOf(i1.v, 'grossMinor') === 115000 && fieldOf(i1.v, 'creditedMinor') === 57500 && fieldOf(i1.v, 'status') === 'part_paid', 'the invoice still says it was R1,150.00; R575.00 of it is now credited and R575.00 is still owed');
  check((i1.v.relations || []).some((x) => x.role === 'credit_note' && x.ref.kind === 'document'), 'and the invoice links to its credit note');
  check(await total(one.steps) === 138000 - 57500, 'the customer now owes R805.00 in all (R1,380.00 less the credit)');
  const cnId = ((i1.v.relations || []).find((x) => x.role === 'credit_note') || { ref: { id: 0 } }).ref.id;
  const cn = await inv(one.steps, cnId);
  check(cn.v.title === 'Credit note #1' && fieldOf(cn.v, 'kind') === 'credit_note' && fieldOf(cn.v, 'netMinor') === 50000 && fieldOf(cn.v, 'taxMinor') === 7500 && fieldOf(cn.v, 'grossMinor') === 57500, 'the credit note opens as Credit note #1: net R500.00, tax R75.00 (the invoice line\'s own 15%), total R575.00');
  check(fieldOf(cn.v, 'reason') === 'Boards damaged on delivery' && fieldOf(cn.v, 'appliedMinor') === 57500 && fieldOf(cn.v, 'unappliedMinor') === 0 && (cn.v.relations || []).some((x) => x.role === 'credits' && x.ref.id === 1), 'it states its reason, what was applied to the invoice, what is left unapplied (nothing), and which invoice it credits');
  check(fieldOf(cn.v, 'outstandingMinor') === null && fieldOf(cn.v, 'allocatedMinor') === null, 'and says nothing is "owed" on it: a credit note is not a debt');
  const issued = (cn.v.history || []).find((h) => h.type === 'credit_note.issued') || {};
  check(issued.contract === 'credit_note.issue' && issued.contractVersion === 1 && issued.approvedBy === 'accountant@example.com' && Number.isInteger(issued.captureId) && Number.isInteger(issued.interpretationId) && Number.isInteger(issued.proposalId), 'it is EXPLAINED: what was said, what was understood, which proposal, who approved it and under which contract');
  r = await run({ before: one.steps, ...open('accountant', 1) }); const i1b = body(r).result || {};
  check(JSON.stringify(i1b.collections.lines) === JSON.stringify([{ lineNo: 1, description: 'Vinyl plank', quantityMilli: 1000, unit: 'job', unitPriceMinor: 100000, taxBp: 1500 }]), 'the invoice\'s own line is exactly what it was: a credit note never edits the invoice');
  const full = seq(); full.do('credit_note.issue', credit({ lines: [{ invoiceLineNo: 1, quantityMilli: 1000, unitPriceMinor: 100000 }] }));
  i1 = await inv(full.steps); check(fieldOf(i1.v, 'outstandingMinor') === 0 && fieldOf(i1.v, 'status') === 'paid' && fieldOf(i1.v, 'creditedMinor') === 115000, 'crediting the whole invoice leaves nothing owed on it');
  const two = seq(); two.do('credit_note.issue', credit()); two.do('credit_note.issue', credit({ reason: 'The rest of the boards' }));
  i1 = await inv(two.steps); check(fieldOf(i1.v, 'creditedMinor') === 115000 && fieldOf(i1.v, 'outstandingMinor') === 0, 'two credit notes together may credit the whole line, and numbering runs 1, 2 in its own sequence');
  r = await run({ before: [...two.steps], ...open('accountant', ((i1.v.relations || []).filter((x) => x.role === 'credit_note')[1] || { ref: { id: 0 } }).ref.id) });
  check(body(r).result && body(r).result.title === 'Credit note #2', 'the second credit note is Credit note #2');
  const price = seq(); price.do('credit_note.issue', credit({ reason: 'Goodwill discount', lines: [{ invoiceLineNo: 1, quantityMilli: 1000, unitPriceMinor: 10000 }] }));
  i1 = await inv(price.steps); check(fieldOf(i1.v, 'creditedMinor') === 11500, 'a price credit works too: one unit credited at R100.00 is R115.00 with tax');

  // ---- 3. AN INVOICE THAT WAS ALREADY PAID: the excess stays as an unapplied credit ---------------------------------------------------------------------------------------------------------------
  const pay = (amountMinor) => ({ partyId: 1, amountMinor, currency: 'ZAR', occurredOn: '2026-11-05', allocate: 'oldest_first' });
  const paid = seq(); paid.do('payment.record', pay(115000)); paid.do('credit_note.issue', credit());
  i1 = await inv(paid.steps);
  check(fieldOf(i1.v, 'outstandingMinor') === 0 && fieldOf(i1.v, 'creditedMinor') === 57500, 'crediting an invoice that is already paid in full leaves it at nothing owed');
  const cnPaid = await inv(paid.steps, ((i1.v.relations || []).find((x) => x.role === 'credit_note') || { ref: { id: 0 } }).ref.id);
  check(fieldOf(cnPaid.v, 'appliedMinor') === 0 && fieldOf(cnPaid.v, 'unappliedMinor') === 57500, 'and the whole R575.00 is recorded as UNAPPLIED credit on the customer: nothing was owed on the invoice, and nothing is silently refunded');
  check(await total(paid.steps) === 23000, 'the customer still owes only invoice 2 (R230.00): an unapplied credit does not change what they owe');
  const acct = async (steps) => (body(await run({ before: steps, ...owes() })).result) || {};
  check((await acct(paid.steps)).unappliedCreditMinor === 57500 && (await acct(paid.steps)).totalMinor === 23000, 'but the customer\'s account shows the R575.00 credit SEPARATELY (unappliedCreditMinor), never netted into what they owe and never hidden: the business owes them that value back');
  check((await acct([])).unappliedCreditMinor === 0 && (await acct(one.steps)).unappliedCreditMinor === 0, 'a customer with nothing unapplied shows R0.00 of credit, including after a credit that was fully applied to the invoice');
  const part = seq(); part.do('payment.record', pay(100000)); part.do('credit_note.issue', credit());
  const cnPart = await inv(part.steps, ((await inv(part.steps)).v.relations.find((x) => x.role === 'credit_note') || { ref: { id: 0 } }).ref.id);
  check(fieldOf(cnPart.v, 'appliedMinor') === 15000 && fieldOf(cnPart.v, 'unappliedMinor') === 42500, 'a part-paid invoice (R150.00 owed) takes R150.00 of a R575.00 credit and R425.00 stays unapplied');

  check((await acct(part.steps)).unappliedCreditMinor === 42500, 'and the account shows the R425.00 left over');
  const pr = await run({ before: paid.steps, method: 'GET', path: '/engine/records/party/1', role: 'accountant' });
  check(fieldOf(body(pr).result || {}, 'unappliedCreditMinor') === 57500, 'the customer\'s record shows it too');

  // ---- 4. REFUSALS: each for its own reason, nothing written ------------------------------------------------------------------------------------------------------------------------------------------
  const bad = [
    [credit({ colour: 'blue' }), 'a field nobody declared'], [credit({ reason: '' }), 'no reason'], [credit({ reason: '   ' }), 'a blank reason'], [credit({ reason: 'x'.repeat(201) }), 'a reason over 200 characters'], [credit({ lines: [] }), 'no lines'],
    [credit({ lines: [{ invoiceLineNo: 1, quantityMilli: 500, unitPriceMinor: 100000, taxBp: 0 }] }), 'a tax rate supplied (it is inherited from the invoice line, never chosen again)'], [credit({ lines: [{ invoiceLineNo: 1, quantityMilli: 0, unitPriceMinor: 100000 }] }), 'a quantity of zero'],
    [credit({ lines: [{ invoiceLineNo: 1, quantityMilli: 500.5, unitPriceMinor: 100000 }] }), 'a fractional quantity'], [credit({ lines: [{ invoiceLineNo: 1, quantityMilli: 500, unitPriceMinor: -1 }] }), 'a negative price'], [credit({ lines: [{ invoiceLineNo: 'one', quantityMilli: 500, unitPriceMinor: 100000 }] }), 'a line number that is text'],
    [credit({ issuedOn: '2026-02-30' }), 'a date that does not exist'], [credit({ invoiceId: 'one' }), 'an invoice number that is text'], [credit({ lines: [{ invoiceLineNo: 1, quantityMilli: 500, unitPriceMinor: 100000 }, { invoiceLineNo: 1, quantityMilli: 100, unitPriceMinor: 100000 }] }), 'the same invoice line twice'], [null, 'no payload at all'],
  ];
  for (const [payload, why] of bad) { r = await run(propose('accountant', 'credit_note.issue', payload)); check(status(r) === 422 && body(r).error === 'invalid_payload' && touchesNoFact(r), `${why} is refused at the door as invalid_payload (${status(r)} ${body(r).error}) and records nothing`); }
  const rules = [
    [credit({ invoiceId: 999 }), 'not_found', 'an invoice that does not exist'], [credit({ lines: [{ invoiceLineNo: 7, quantityMilli: 500, unitPriceMinor: 100000 }] }), 'invalid_input', 'a line the invoice does not have'],
    [credit({ lines: [{ invoiceLineNo: 1, quantityMilli: 500, unitPriceMinor: 100001 }] }), 'invalid_input', 'a price above what the invoice line charged'], [credit({ lines: [{ invoiceLineNo: 1, quantityMilli: 1001, unitPriceMinor: 100000 }] }), 'invalid_state', 'more than the invoice line was worth'],
    [credit({ lines: [{ invoiceLineNo: 1, quantityMilli: 500, unitPriceMinor: 0 }] }), 'invalid_input', 'a credit of nothing'], [credit({ issuedOn: '2026-09-30' }), 'invalid_input', 'a credit dated before the invoice'],
  ];
  for (const [payload, code, why] of rules) { r = await run(propose('accountant', 'credit_note.issue', payload)); check(body(r).error === code && touchesNoFact(r) && added(r, 'eng_event') === 0, `${why} is refused at the door as ${code} (${status(r)} ${body(r).error}) and records nothing`); }
  const q = seq(); q.do('quotation.create', { partyId: 1, issuedOn: '2026-11-10', currency: 'ZAR', lines: [{ description: 'x', quantityMilli: 1000, unitPriceMinor: 100, taxBp: 1500 }] });
  r = await run({ before: q.steps, ...propose('accountant', 'credit_note.issue', credit({ invoiceId: 3 })) });
  check(status(r) === 409 && body(r).error === 'invalid_state' && touchesNoFact(r), 'a document that is not an invoice (a quotation) cannot be credited: invalid_state');
  r = await run({ before: one.steps, ...propose('accountant', 'credit_note.issue', credit({ lines: [{ invoiceLineNo: 1, quantityMilli: 501, unitPriceMinor: 100000 }] })) });
  check(status(r) === 409 && body(r).error === 'invalid_state' && touchesNoFact(r), 'the invoice line is worth R1,000.00 net and R500.00 is already credited, so crediting R501.00 more is refused: you can never credit more than was invoiced');
  r = await run({ before: one.steps, ...propose('accountant', 'credit_note.issue', credit({ lines: [{ invoiceLineNo: 1, quantityMilli: 500, unitPriceMinor: 100000 }] })) });
  check(status(r) === 200 && body(r).status === 'held', 'but crediting exactly the R500.00 that remains is allowed');
  for (const role of ['sales', 'installer']) { r = await run(propose(role, 'credit_note.issue', credit())); check(status(r) === 403 && touchesNoFact(r), `${role} may not propose a credit note: refused 403, nothing recorded`); }
  r = await run({ before: [propose('accountant', 'credit_note.issue', credit())], ...confirm('sales', 1) }); check(status(r) === 403 && added(r, 'eng_document') === 0, 'a salesperson cannot approve one either');
  r = await kit.route({ env: ENV, seed: kit.seedReceivables(kit.ALL_CAPABILITIES), ...propose('accountant', 'credit_note.issue', credit()) });
  check(status(r) === 409 && body(r).error === 'capability_unavailable' && touchesNoFact(r), 'a business without the capability is told so (capability_unavailable) and records nothing');
  r = await run({ before: [propose('accountant', 'credit_note.issue', credit()), confirm('accountant', 1)], ...confirm('accountant', 1) });
  check(status(r) !== 200 && added(r, 'eng_document') === 0 && added(r, 'eng_money_movement') === 0, `approving the same proposal twice never credits twice (${status(r)})`);
  const stale = seq(); const a = stale.prop('credit_note.issue', credit()); const b = stale.prop('credit_note.issue', credit()); stale.ok(b);
  r = await run({ before: stale.steps, ...confirm('accountant', a) });
  check(status(r) === 409 && ['stale', 'invalid_state'].includes(body(r).error) && added(r, 'eng_document') === 0, `a credit approved after the invoice was credited by someone else is refused (${status(r)} ${body(r).error}), so two people cannot both credit the same R500.00 past the invoice`);
  const raced = seq(); const ra = raced.prop('credit_note.issue', credit({ lines: [{ invoiceLineNo: 1, quantityMilli: 800, unitPriceMinor: 100000 }] })); raced.do('credit_note.issue', credit({ lines: [{ invoiceLineNo: 1, quantityMilli: 800, unitPriceMinor: 100000 }] }));
  r = await run({ before: raced.steps, ...confirm('accountant', ra) });
  check(status(r) === 409 && added(r, 'eng_document') === 0, 'two credits that together exceed the invoice line cannot both be approved');
  // a payment proposed before a credit is stale afterwards: the account it showed has changed
  const pstale = seq(); const pp = pstale.prop('payment.record', pay(50000)); pstale.do('credit_note.issue', credit());
  r = await run({ before: pstale.steps, ...confirm('accountant', pp) });
  check(status(r) === 409 && added(r, 'eng_money_movement') === 0, 'a payment proposed before the customer was credited is refused as stale: the approval is for the account it showed');

  // ---- 5. THE FOUNDATIONS STILL HOLD ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const { facts, verifyIntegrity, EVENT_MODEL } = eng;
  check(Boolean(EVENT_MODEL['credit_note.issued']) && EVENT_MODEL['credit_note.issued'].creates === null, 'the event model knows credit_note.issued, and says it creates no fact row of its own');
  const w = kit.makeWorld(); w.configure({ mode: 'engine', available: AV });
  const CTX = { actorEmail: 'accountant@example.com', contract: 'test', contractVersion: 1 };
  const cust = (await facts.recordParty(w.env, { kind: 'organisation', name: 'Patel', roles: ['customer'] }, CTX)).id;
  const invoice = await facts.recordDocument(w.env, { kind: 'invoice', direction: 'sell', partyId: cust, currency: 'ZAR', issuedOn: '2026-10-01', lines: [{ description: 'Floor', quantityMilli: 1000, unit: 'job', unitPriceMinor: 100000, taxBp: 1500 }] }, CTX);
  const rowOf = (id) => JSON.stringify([w.db.prepare('SELECT * FROM eng_document WHERE id = ?').get(id), w.db.prepare('SELECT * FROM eng_document_line WHERE document_id = ? ORDER BY id').all(id), w.db.prepare('SELECT * FROM eng_document_number WHERE document_id = ?').get(id)]);
  const before = rowOf(invoice.id);
  const res = await facts.issueCreditNote(w.env, { invoiceId: invoice.id, reason: 'Damaged', issuedOn: '2026-11-10', lines: [{ invoiceLineNo: 1, quantityMilli: 400, unitPriceMinor: 100000 }] }, CTX);
  check(res.totals.grossMinor === 46000 && res.appliedMinor === 46000 && res.unappliedMinor === 0 && res.number === 1 && Number.isInteger(res.documentId) && Number.isInteger(res.movementId), 'the fact layer issues a credit note: R460.00 credited and applied, number 1');
  check(rowOf(invoice.id) === before, 'the invoice, its line and its number are byte-for-byte what they were');
  check(await eng.ledger.outstandingForDocument(w.env, invoice.id) === 115000 - 46000, 'and what is owed on it is derived: R690.00');
  let integ = await verifyIntegrity(w.env);
  check(integ.ok === true && integ.problems.length === 0 && integ.warnings.length === 0, 'the integrity verifier is clean after a credit note, with no warning about an unmodelled event');
  w.db.prepare("INSERT INTO eng_event (type, payload_json) VALUES ('credit_note.issued', ?)").run(JSON.stringify({ documentId: 7777, invoiceId: invoice.id, movementId: res.movementId, appliedMinor: 1, unappliedMinor: 0 }));
  integ = await verifyIntegrity(w.env);
  check(integ.ok === false && integ.problems.some((p) => p.code === 'orphan' && /7777/.test(p.detail) && /does not exist/.test(p.detail)), 'a credit_note.issued event that points at a document that does not exist is REPORTED (orphan)');
  const w2 = kit.makeWorld(); w2.configure({ mode: 'engine', available: AV });
  const c2 = (await facts.recordParty(w2.env, { kind: 'organisation', name: 'P', roles: ['customer'] }, CTX)).id;
  const i2 = await facts.recordDocument(w2.env, { kind: 'invoice', direction: 'sell', partyId: c2, currency: 'ZAR', issuedOn: '2026-10-01', lines: [{ description: 'Floor', quantityMilli: 1000, unit: 'job', unitPriceMinor: 100000, taxBp: 1500 }] }, CTX);
  const r2 = await facts.issueCreditNote(w2.env, { invoiceId: i2.id, reason: 'x', issuedOn: '2026-11-10', lines: [{ invoiceLineNo: 1, quantityMilli: 400, unitPriceMinor: 100000 }] }, CTX);
  w2.db.prepare("INSERT INTO eng_event (type, payload_json) VALUES ('credit_note.issued', ?)").run(JSON.stringify({ documentId: r2.documentId, invoiceId: i2.id, movementId: r2.movementId, appliedMinor: 46000, unappliedMinor: 5 }));
  integ = await verifyIntegrity(w2.env);
  check(integ.ok === false && integ.problems.some((p) => /does not add up|applied|unapplied/i.test(p.detail)), 'a credit whose applied and unapplied amounts do not add up to the credit note is REPORTED by the verifier');
  // atomicity: a failure at each write leaves nothing behind
  const mk = async () => { const x = kit.makeWorld(); x.configure({ mode: 'engine', available: AV }); const c = (await facts.recordParty(x.env, { kind: 'organisation', name: 'P', roles: ['customer'] }, CTX)).id; const d = await facts.recordDocument(x.env, { kind: 'invoice', direction: 'sell', partyId: c, currency: 'ZAR', issuedOn: '2026-10-01', lines: [{ description: 'Floor', quantityMilli: 1000, unit: 'job', unitPriceMinor: 100000, taxBp: 1500 }] }, CTX); return { x, d }; };
  const probe = await mk(); probe.x.resetWrites(); await facts.issueCreditNote(probe.x.env, { invoiceId: probe.d.id, reason: 'x', issuedOn: '2026-11-10', lines: [{ invoiceLineNo: 1, quantityMilli: 400, unitPriceMinor: 100000 }] }, CTX); const writes = probe.x.writeCount();
  let leaked = [];
  for (let n = 1; n <= writes; n++) {
    const { x, d } = await mk(); const was = JSON.stringify(x.counts()); x.failAt(n);
    let threw = false; try { await facts.issueCreditNote(x.env, { invoiceId: d.id, reason: 'x', issuedOn: '2026-11-10', lines: [{ invoiceLineNo: 1, quantityMilli: 400, unitPriceMinor: 100000 }] }, CTX); } catch { threw = true; }
    if (!threw || JSON.stringify(x.counts()) !== was) leaked.push(n);
  }
  check(writes >= 8 && leaked.length === 0, `issuing a credit note is atomic: a failure at each of its ${writes} writes leaves no document, no movement, no allocation and no event` + (leaked.length ? ' (leaked at ' + leaked.join(',') + ')' : ''));
  for (const [why, input] of [['an invoice that does not exist', { invoiceId: 9999, reason: 'x', issuedOn: '2026-11-10', lines: [{ invoiceLineNo: 1, quantityMilli: 1, unitPriceMinor: 1 }] }], ['more than the line was worth', { invoiceId: invoice.id, reason: 'x', issuedOn: '2026-11-10', lines: [{ invoiceLineNo: 1, quantityMilli: 700, unitPriceMinor: 100000 }] }], ['a blank reason', { invoiceId: invoice.id, reason: ' ', issuedOn: '2026-11-10', lines: [{ invoiceLineNo: 1, quantityMilli: 1, unitPriceMinor: 1 }] }]]) {
    const was = JSON.stringify(w.counts()); let code = null; try { await facts.issueCreditNote(w.env, input, CTX); } catch (e) { code = e && e.code; } check(code !== null && JSON.stringify(w.counts()) === was, `the fact layer itself refuses ${why} and writes nothing (${code})`);
  }
});

if (require.main === module) kit.standalone(module.exports);
