// Expenses (branch engine-phase1): record a PAID expense, void it, find them, and feed input tax into the VAT summary. TESTS FIRST. Evidence label for every check: TEST of the engine on the route harness (NOT staging, NOT production).
// Expected state when first committed: RED. Research and decisions: docs/decisions/expenses.md. In short: an expense is a paid purchase: ONE held write records an `expense` document (from a supplier) and the money-out movement that paid it
// (no payable, no allocation); tax is explicit per line and the amount actually paid must match the computed total; input tax claimability is DERIVED (business VAT registered, supplier a vendor, valid tax invoice held, category not denied by
// s17(2)) with the reasons shown; the claim date is the invoice date or the first open day after the tax lock; nothing is edited (void and re-record); and the VAT summary gains its input side (fields 14 and 15).
const kit = require('./engine-kit.js');

module.exports = kit.guard('expenses', async ({ check }) => {
  const eng = kit.loadEngine();
  check(Boolean(eng && eng.permissions && eng.capabilities && eng.facts && eng.expenses && eng.business), 'the engine exposes permissions, capabilities, facts, the expenses module and the business module');
  if (!eng || !eng.permissions || !eng.expenses) return;
  const auth = kit.bundle('auth.ts', 'auth');
  const member = (role) => ({ email: `${role}@example.com`, caps: auth.ROLE_CAPABILITIES[role] || [] });
  const AV = [...kit.ALL_CAPABILITIES, 'party.create', 'business.profile.set', 'tax_lock.set', 'expense.record', 'expense.void', 'expenses.find', 'vat.summary'];
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
    prop(cap, payload, role = 'accountant') { n += 1; steps.push(propose(role, cap, payload, `(${cap})`)); return n; },
    ok(id, role = 'accountant') { steps.push(confirm(role, id)); return api; },
    setN(k) { n = k; },
    do(cap, payload, role = 'accountant') { const id = api.prop(cap, payload, role); api.ok(id, role); return id; } }; return api; };
  const ext = (src) => { const q = seq(); q.steps.push(...src.steps); q.setN(src.steps.filter((x) => x.method === 'POST' && x.path === '/engine/proposals').length); return q; };
  const has = (role, p) => eng.permissions.permissionsFor(member(role).caps).has(p);
  const profile = { legalName: 'Zululand Flooring and Blinds (Pty) Ltd', address: '5 Industrial Road, Empangeni, 3880', vatRegistered: true, vatNumber: '4123456789' };
  // the world: the business is VAT registered (action 1), supplier 2 "Timber Supplies" is a vendor (action 2), supplier 3 "Corner Spaza" is not (action 3)
  const world = seq();
  world.do('business.profile.set', profile, 'owner');
  world.do('party.create', { kind: 'organisation', name: 'Timber Supplies', roles: ['supplier'], contact: { vatNumber: '4111111111', address: '1 Mill Road, Empangeni' } });
  world.do('party.create', { kind: 'person', name: 'Corner Spaza', roles: ['supplier'] });
  const ex = (extra = {}) => ({ supplierId: 2, incurredOn: '2026-10-10', method: 'eft', category: 'materials', currency: 'ZAR', amountsIncludeTax: true, lines: [{ description: 'Plywood sheets', amountMinor: 23000, taxBp: 1500 }], amountPaidMinor: 23000, taxInvoiceHeld: true, supplierInvoiceNumber: 'INV-1001', receiptRef: 'receipt-photo-17', ...extra });   // net R200.00, tax R30.00, total R230.00
  const one = ext(world); one.do('expense.record', ex());
  const find = (role, q = '') => get(role, `/engine/expenses${q}`);
  const list = async (steps, q = '', role = 'accountant') => (body(await run({ before: steps, ...find(role, q) })).result || {});
  const view = async (steps, id, role = 'accountant') => (body(await run({ before: steps, ...get(role, `/engine/records/document/${id}`) })).result || {});

  // ---- 1. PERMISSIONS ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  check(['owner', 'accountant', 'admin'].every((r) => has(r, 'expense.record') && has(r, 'expense.void') && has(r, 'expense.read')), 'owner, accountant and admin may record, void and read expenses');
  check(['sales', 'installer'].every((r) => !has(r, 'expense.record') && !has(r, 'expense.void')), 'a salesperson and an installer may not record or void one (field-staff submission for approval is a later decision)');
  check(['expense.record', 'expense.void', 'expenses.find'].every((c) => eng.capabilities.CAPABILITY_IDS.includes(c)), 'the three capabilities exist in the engine');

  // ---- 2. RECORD: held first, recorded only on approval ---------------------------------------------------------------------------------------------------------------------------------------------------
  let r = await run({ before: world.steps, ...propose('accountant', 'expense.record', ex(), 'Bought plywood from Timber Supplies for R230, paid by EFT') });
  check(status(r) === 200 && body(r).status === 'held' && touchesNoFact(r) && added(r, 'eng_event') === 0, `proposing an expense is HELD and records nothing (${status(r)} ${body(r).status})`);
  check(JSON.stringify(r.writes || {}).includes('3000') && JSON.stringify(r.writes || {}).includes('23000'), 'the approval is shown the exact tax (R30.00) and total (R230.00) the engine worked out');
  const prop = ext(world); const pid = prop.prop('expense.record', ex());
  r = await run({ before: prop.steps, ...confirm('accountant', pid) });
  check(status(r) === 200 && added(r, 'eng_document') === 1 && added(r, 'eng_document_line') === 1 && added(r, 'eng_document_number') === 1 && added(r, 'eng_money_movement') === 1 && added(r, 'eng_allocation') === 0, `approving it records ONE expense document, its line and number, and ONE money-out movement, and NO allocation (${status(r)})`);
  check(added(r, 'eng_event') === 4 && added(r, 'eng_reversal') === 0, 'with four events: document.issued, payment.recorded, expense.recorded and the execution');
  const found = await list(one.steps);
  const e = (found.expenses || [])[0] || {};
  check((found.expenses || []).length === 1 && e.number === 1 && e.category === 'materials' && e.supplierId === 2 && e.supplierName === 'Timber Supplies' && e.netMinor === 20000 && e.taxMinor === 3000 && e.grossMinor === 23000 && e.amountPaidMinor === 23000 && e.method === 'eft' && e.ref && e.ref.kind === 'document', 'finding lists it: number 1, materials, Timber Supplies, net R200.00, tax R30.00, total R230.00, paid by EFT, with a reference to open it');
  const v = await view(one.steps, e.id);
  check(v.title === 'Expense #1' && fieldOf(v, 'category') === 'materials' && fieldOf(v, 'supplier') === 'Timber Supplies' && fieldOf(v, 'amountPaidMinor') === 23000 && fieldOf(v, 'method') === 'eft' && fieldOf(v, 'taxInvoiceHeld') === true && fieldOf(v, 'supplierInvoiceNumber') === 'INV-1001' && fieldOf(v, 'receiptRef') === 'receipt-photo-17' && fieldOf(v, 'status') === 'recorded', 'the record opens as Expense #1 with its category, supplier, what was paid and how, the invoice number, the receipt reference and its status');
  check(fieldOf(v, 'inputTaxClaimable') === true && fieldOf(v, 'inputTaxMinor') === 3000 && fieldOf(v, 'inputTaxReasons') === '' && fieldOf(v, 'claimDate') === '2026-10-10', 'it says the R30.00 input tax is claimable (a vendor, a tax invoice, a VAT registered business), with no reasons against it, claimed on the invoice date');
  check(fieldOf(v, 'outstandingMinor') === null && fieldOf(v, 'allocatedMinor') === null, 'and says nothing is "owed" on it: it was paid');
  const rec = (v.history || []).find((h) => h.type === 'expense.recorded') || {};
  check(rec.contract === 'expense.record' && rec.contractVersion === 1 && rec.approvedBy === 'accountant@example.com' && Number.isInteger(rec.captureId) && Number.isInteger(rec.interpretationId) && Number.isInteger(rec.proposalId), 'it is EXPLAINED: what was said, what was understood, which proposal, who approved it and under which contract');
  const sup = await run({ before: one.steps, ...get('accountant', '/engine/receivables?party=Mokoena') });
  check((body(sup).result || {}).totalMinor === 138000, 'it touches no customer\'s account: Mokoena still owes R1,380.00');
  const net = ext(world); net.do('expense.record', ex({ amountsIncludeTax: false, lines: [{ description: 'Plywood sheets', amountMinor: 20000, taxBp: 1500 }] }));
  const ne = ((await list(net.steps)).expenses || [])[0] || {};
  check(ne.netMinor === 20000 && ne.taxMinor === 3000 && ne.grossMinor === 23000, 'amounts entered WITHOUT tax come to the same R200.00 net, R30.00 tax, R230.00 total');
  const split = ext(world); split.do('expense.record', ex({ lines: [{ description: 'Plywood', amountMinor: 11500, taxBp: 1500 }, { description: 'Screws', amountMinor: 5000, taxBp: 0 }], amountPaidMinor: 16500, supplierInvoiceNumber: 'INV-1002' }));
  const se = ((await list(split.steps)).expenses || [])[0] || {};
  check(se.netMinor === 15000 && se.taxMinor === 1500 && se.grossMinor === 16500, 'a split expense carries each line\'s own tax rate (R115.00 at 15% and R50.00 at 0%)');
  const two = ext(one); two.do('expense.record', ex({ supplierInvoiceNumber: 'INV-1002', incurredOn: '2026-10-12' }));
  check(((await list(two.steps)).expenses || []).map((x) => x.number).sort().join() === '1,2', 'expenses are numbered in their own sequence, 1 then 2');

  // ---- 3. RECORD refusals ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const bad = [
    [ex({ colour: 'blue' }), 'a field nobody declared'], [ex({ supplierId: 'two' }), 'a supplier number that is text'], [ex({ category: 'groceries' }), 'a category that is not on the list'], [ex({ category: '' }), 'no category'], [ex({ method: 'barter' }), 'a payment method nobody declared'],
    [ex({ lines: [] }), 'no lines'], [ex({ lines: [{ description: 'x', amountMinor: 100 }] }), 'a line with no tax rate (VAT is never assumed)'], [ex({ lines: [{ description: 'x', amountMinor: 0, taxBp: 1500 }] }), 'a line of zero'], [ex({ lines: [{ description: 'x', amountMinor: 1.5, taxBp: 1500 }] }), 'a fractional amount'],
    [ex({ lines: [{ description: 'x', amountMinor: 100, taxBp: 10001 }] }), 'a tax rate over 100%'], [ex({ lines: [{ description: ' ', amountMinor: 100, taxBp: 1500 }] }), 'a blank description'], [ex({ amountsIncludeTax: 'yes' }), 'amountsIncludeTax that is not true or false'], [{ ...ex(), amountsIncludeTax: undefined }, 'no statement of whether the amounts include tax'],
    [ex({ taxInvoiceHeld: 'yes' }), 'taxInvoiceHeld that is not true or false'], [ex({ incurredOn: '2026-02-30' }), 'a date that does not exist'], [ex({ paidOn: 'soon' }), 'a paid date that is not a date'], [ex({ currency: 'rand' }), 'a currency that is not a code'], [ex({ amountPaidMinor: 0 }), 'an amount paid of zero'],
    [ex({ supplierInvoiceNumber: 'x'.repeat(61) }), 'an invoice number over 60 characters'], [ex({ receiptRef: 'x'.repeat(201) }), 'a receipt reference over 200 characters'], [ex({ capital: 'yes' }), 'capital that is not true or false'], [null, 'no payload at all'],
  ];
  for (const [payload, why] of bad) { r = await run({ before: world.steps, ...propose('accountant', 'expense.record', payload) }); check(status(r) === 422 && body(r).error === 'invalid_payload' && touchesNoFact(r), `${why} is refused at the door as invalid_payload (${status(r)} ${body(r).error}) and records nothing`); }
  const rules = [
    [ex({ supplierId: 99 }), 'not_found', 'a supplier that does not exist'], [ex({ supplierId: 1 }), 'invalid_state', 'a party that is only a customer (Mokoena)'], [ex({ amountPaidMinor: 23002 }), 'invalid_input', 'an amount paid that is more than 1 cent away from the lines\' total'], [ex({ amountPaidMinor: 22000 }), 'invalid_input', 'an amount paid that does not match the lines'],
    [ex({ paidOn: '2026-10-09' }), 'invalid_input', 'a payment dated before the expense'],
  ];
  for (const [payload, code, why] of rules) { r = await run({ before: world.steps, ...propose('accountant', 'expense.record', payload) }); check(body(r).error === code && touchesNoFact(r) && added(r, 'eng_event') === 0, `${why} is refused at the door as ${code} (${status(r)} ${body(r).error}) and records nothing`); }
  r = await run({ before: world.steps, ...propose('accountant', 'expense.record', ex({ amountPaidMinor: 23001 })) }); check(status(r) === 200 && body(r).status === 'held', 'but a payment one cent off is tolerated (the supplier may round at invoice level)');
  r = await run({ before: one.steps, ...propose('accountant', 'expense.record', ex({ incurredOn: '2026-10-11' })) });
  check(status(r) === 409 && body(r).error === 'duplicate' && touchesNoFact(r), 'the same supplier invoice number from the same supplier twice is refused as DUPLICATE');
  r = await run({ before: one.steps, ...propose('accountant', 'expense.record', ex({ supplierId: 3, taxInvoiceHeld: false })) }); check(status(r) === 200 && body(r).status === 'held', 'the same invoice number from a DIFFERENT supplier is fine');
  for (const role of ['sales', 'installer']) { r = await run({ before: world.steps, ...propose(role, 'expense.record', ex()) }); check(status(r) === 403 && touchesNoFact(r), `${role} may not propose an expense: refused 403, nothing recorded`); }
  r = await run({ before: [...world.steps, propose('accountant', 'expense.record', ex())], ...confirm('installer', 4) }); check(status(r) === 403 && added(r, 'eng_document') === 0, 'an installer cannot approve one either');
  r = await kit.route({ env: ENV, seed: kit.seedReceivables(kit.ALL_CAPABILITIES), ...propose('accountant', 'expense.record', ex()) }); check(status(r) === 409 && body(r).error === 'capability_unavailable' && touchesNoFact(r), 'a business without the capability is told so');
  r = await run({ before: [...prop.steps, confirm('accountant', pid)], ...confirm('accountant', pid) }); check(status(r) !== 200 && added(r, 'eng_document') === 0 && added(r, 'eng_money_movement') === 0, `approving the same proposal twice never records twice (${status(r)})`);
  const dupRace = ext(world); const d1 = dupRace.prop('expense.record', ex()); const d2 = dupRace.prop('expense.record', ex({ incurredOn: '2026-10-11' })); dupRace.ok(d1);
  r = await run({ before: dupRace.steps, ...confirm('accountant', d2) }); check(status(r) === 409 && body(r).error === 'duplicate' && added(r, 'eng_document') === 0, 'a duplicate that slipped in between the proposal and the approval is caught AT the approval');

  // ---- 4. INPUT TAX: derived, with the reasons (the claimability matrix) ------------------------------------------------------------------------------------------------------------------------------------
  const { facts } = eng; const CTX = { actorEmail: 'accountant@example.com', contract: 'test', contractVersion: 1 };
  const mk = async (prof = profile) => { const w = kit.makeWorld(); w.configure({ mode: 'engine', available: AV }); if (prof) await facts.setBusinessProfile(w.env, prof, CTX);
    const vend = (await facts.recordParty(w.env, { kind: 'organisation', name: 'Vendor Co', roles: ['supplier'], contact: { vatNumber: '4222222222' } }, CTX)).id;
    const nonv = (await facts.recordParty(w.env, { kind: 'person', name: 'Spaza', roles: ['supplier'] }, CTX)).id; return { w, vend, nonv }; };
  const rec1 = async (x, extra = {}, sup = 'vend') => facts.recordExpense(x.w.env, { supplierId: x[sup], incurredOn: '2026-10-10', method: 'eft', category: 'materials', currency: 'ZAR', amountsIncludeTax: true, lines: [{ description: 'Item', amountMinor: 23000, taxBp: 1500 }], amountPaidMinor: 23000, taxInvoiceHeld: true, ...extra }, CTX);
  const tax = async (x, rr) => eng.expenses.inputTaxOf(x.w.env, rr.documentId);
  let X = await mk(); let t = await tax(X, await rec1(X));
  check(t.claimable === true && t.taxMinor === 3000 && t.reasons.length === 0 && t.claimDate === '2026-10-10', 'a vendor supplier, a tax invoice, a VAT registered business and an allowed category: claimable (R30.00)');
  X = await mk(null); t = await tax(X, await rec1(X));
  check(t.claimable === false && t.reasons.some((m) => /not VAT registered|VAT registered/i.test(m)), 'a business that is not recorded as VAT registered cannot claim, and the reason says so');
  X = await mk({ ...profile, vatRegistered: false }); t = await tax(X, await rec1(X));
  check(t.claimable === false && t.reasons.some((m) => /VAT registered/i.test(m)), 'nor one recorded as not VAT registered');
  X = await mk(); t = await tax(X, await rec1(X, {}, 'nonv'));
  check(t.claimable === false && t.reasons.some((m) => /supplier/i.test(m) && /VAT number/i.test(m)), 'a supplier with no VAT number on record is not a vendor: the VAT is not claimable, and the reason says so');
  t = await tax(X, await rec1(X, { taxInvoiceHeld: false }));
  check(t.claimable === false && t.reasons.some((m) => /tax invoice/i.test(m)), 'without a valid tax invoice, input tax is not claimable (above R50)');
  t = await tax(X, await rec1(X, { taxInvoiceHeld: false, lines: [{ description: 'Small', amountMinor: 4000, taxBp: 1500 }], amountPaidMinor: 4000 }));
  check(t.claimable === true && t.taxMinor === 522, 'a purchase of R50 or less needs only the receipt: claimable without a tax invoice (R5.22 of R40.00)');
  for (const c of ['entertainment', 'motor_car', 'club_subscription']) { t = await tax(X, await rec1(X, { category: c })); check(t.claimable === false && t.reasons.some((m) => /denied|17\(2\)/i.test(m)), `${c} is denied input tax outright (VAT Act s17(2)), and the reason says so`); }
  t = await tax(X, await rec1(X, { category: 'other' })); check(t.claimable === true && (t.advisory || []).some((m) => /classif/i.test(m)), 'the category "other" is claimable but flagged for an accountant to classify');
  t = await tax(X, await rec1(X, { lines: [{ description: 'Zero rated', amountMinor: 5000, taxBp: 0 }], amountPaidMinor: 5000 }));
  check(t.claimable === false && t.taxMinor === 0 && t.reasons.some((m) => /no tax/i.test(m)), 'a zero-rated purchase has no input tax to claim');
  t = await tax(X, await rec1(X, { capital: true })); check(t.claimable === true && t.capital === true, 'a capital purchase is claimable and marked capital (VAT201 field 14)');
  // the claim date: an expense dated in a locked period is claimed in the first open period
  await facts.setTaxLock(X.w.env, { lockDate: '2026-10-31' }, CTX);
  t = await tax(X, await rec1(X, { incurredOn: '2026-10-15', supplierInvoiceNumber: 'LATE-1' }));
  check(t.claimable === true && t.claimDate === '2026-11-01', 'an expense dated 15 October after October was locked is still recorded, and its input tax is claimed on 1 November, the first open day (SARS allows a claim up to five years later)');
  t = await tax(X, await rec1(X, { incurredOn: '2026-11-15', supplierInvoiceNumber: 'LATE-2' })); check(t.claimDate === '2026-11-15', 'one dated in the open period is claimed on its own date');

  // ---- 5. VOID: reversals, never a deletion ------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const vd = (id, extra = {}) => ({ expenseId: id, reason: 'Entered against the wrong supplier', voidedOn: '2026-10-20', ...extra });
  const E1 = e.id;
  r = await run({ before: one.steps, ...propose('accountant', 'expense.void', vd(E1), 'That plywood expense was the wrong supplier, void it') });
  check(status(r) === 200 && body(r).status === 'held' && touchesNoFact(r), 'proposing a void is HELD and records nothing');
  const vo = ext(one); const vId = vo.prop('expense.void', vd(E1));
  r = await run({ before: vo.steps, ...confirm('accountant', vId) });
  check(status(r) === 200 && added(r, 'eng_reversal') === 2 && added(r, 'eng_document') === 0 && added(r, 'eng_money_movement') === 0, `approving it records TWO reversals (the money-out movement and the expense document) and adds no money or document (${status(r)})`);
  vo.ok(vId);
  check(((await list(vo.steps)).expenses || []).length === 0 && ((await list(vo.steps, '?status=voided')).expenses || []).length === 1, 'a voided expense leaves the default list and is found under status=voided');
  const vv = await view(vo.steps, E1);
  check(fieldOf(vv, 'status') === 'voided' && (vv.history || []).some((h) => h.type === 'expense.voided' && h.contract === 'expense.void' && h.approvedBy === 'accountant@example.com'), 'its record says voided and the void is explained (who approved it, under which contract)');
  r = await run({ before: vo.steps, ...propose('accountant', 'expense.void', vd(E1)) }); check(status(r) === 409 && body(r).error === 'invalid_state' && touchesNoFact(r), 'voiding one that is already voided is refused as invalid_state');
  const again = ext(vo); again.do('expense.record', ex());
  check(((await list(again.steps)).expenses || []).length === 1, 'after a void the same invoice number can be recorded again (a voided expense no longer counts as a duplicate)');
  for (const [payload, why] of [[vd(E1, { reason: '' }), 'no reason'], [vd(E1, { reason: 'x'.repeat(201) }), 'a reason over 200 characters'], [vd(E1, { voidedOn: 'someday' }), 'a date that is not a date'], [vd(E1, { colour: 'x' }), 'a field nobody declared'], [{}, 'nothing at all']]) { r = await run({ before: one.steps, ...propose('accountant', 'expense.void', payload) }); check(status(r) === 422 && body(r).error === 'invalid_payload' && touchesNoFact(r), `${why} is refused as invalid_payload`); }
  r = await run({ before: one.steps, ...propose('accountant', 'expense.void', vd(999)) }); check(status(r) === 404, 'voiding one that does not exist is refused as not_found');
  r = await run({ before: one.steps, ...propose('accountant', 'expense.void', vd(1)) }); check(status(r) === 409 && body(r).error === 'invalid_state', 'voiding something that is not an expense (invoice 1) is refused');
  for (const role of ['sales', 'installer']) { r = await run({ before: one.steps, ...propose(role, 'expense.void', vd(E1)) }); check(status(r) === 403 && touchesNoFact(r), `${role} may not void an expense`); }
  const lk = ext(one); lk.do('tax_lock.set', { lockDate: '2026-10-31' }, 'owner');
  r = await run({ before: lk.steps, ...propose('accountant', 'expense.void', vd(E1, { voidedOn: '2026-11-02' })) });
  check(status(r) === 409 && body(r).error === 'period_locked' && touchesNoFact(r), 'an expense whose input tax was claimed in a locked period cannot be voided (it would change a filed return)');
  const nt = ext(world); nt.do('expense.record', ex({ supplierId: 3, taxInvoiceHeld: false, supplierInvoiceNumber: 'N-1' })); nt.do('tax_lock.set', { lockDate: '2026-10-31' }, 'owner');
  const nte = ((await list(nt.steps)).expenses || [])[0] || {};
  r = await run({ before: nt.steps, ...propose('accountant', 'expense.void', vd(nte.id, { voidedOn: '2026-11-02' })) });
  check(status(r) === 200 && body(r).status === 'held', 'but one with no claimable input tax can be voided even in a locked period (it has no VAT effect)');
  const staleV = ext(one); const sv1 = staleV.prop('expense.void', vd(E1)); const sv2 = staleV.prop('expense.void', vd(E1, { reason: 'Second try' })); staleV.ok(sv1);
  r = await run({ before: staleV.steps, ...confirm('accountant', sv2) }); check(status(r) === 409 && added(r, 'eng_reversal') === 0, 'the same void approved twice never reverses twice');

  // ---- 6. FIND ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const mix = ext(world); mix.do('expense.record', ex({ category: 'materials', supplierInvoiceNumber: 'A-1', incurredOn: '2026-10-05' })); mix.do('expense.record', ex({ category: 'fuel', supplierInvoiceNumber: 'A-2', incurredOn: '2026-10-20' })); mix.do('expense.record', ex({ category: 'fuel', supplierId: 3, taxInvoiceHeld: false, supplierInvoiceNumber: 'A-3', incurredOn: '2026-11-03' }));
  let L = await list(mix.steps); check((L.expenses || []).length === 3 && L.count === 3 && L.truncated === false, 'finding with no filter lists every expense');
  check((await list(mix.steps, '?from=2026-10-10&to=2026-10-31')).expenses.length === 1, 'finding by period lists only those incurred inside it');
  check((await list(mix.steps, '?category=fuel')).expenses.length === 2, 'finding by category');
  check((await list(mix.steps, '?supplierId=3')).expenses.length === 1, 'finding by supplier');
  L = await list(mix.steps); check(JSON.stringify(L.categories) === JSON.stringify(['fuel', 'materials']), 'the result also lists the categories in use');
  for (const [q, why] of [['?category=groceries', 'a category that is not on the list'], ['?supplierId=abc', 'a supplier number that is not a number'], ['?from=2026-10-31&to=2026-10-01', 'an end before the start'], ['?from=soon', 'a date that is not a date'], ['?status=banana', 'a status nobody declared']]) { r = await run({ before: mix.steps, ...find('accountant', q) }); check(status(r) === 422, `${why} is refused as invalid`); }
  for (const role of ['installer', 'sales']) { r = await run({ before: mix.steps, ...find(role) }); check(status(r) === 403 && !/Timber|materials/.test(JSON.stringify(body(r))), `${role} is refused (403) and the refusal names nothing`); }
  r = await kit.route({ env: ENV, seed: kit.seedReceivables(kit.ALL_CAPABILITIES), ...find('accountant') }); check(status(r) === 409 && body(r).error === 'capability_unavailable', 'a business without the capability is told so');

  // ---- 7. THE VAT SUMMARY GAINS ITS INPUT SIDE ------------------------------------------------------------------------------------------------------------------------------------------------------------
  const vat = (q) => get('accountant', `/engine/vat${q}`);
  const inp = ext(world);
  inp.do('expense.record', ex({ supplierInvoiceNumber: 'V-1', incurredOn: '2026-10-10' }));                                                                                                                              // claimable R30.00, field 15
  inp.do('expense.record', ex({ supplierInvoiceNumber: 'V-2', incurredOn: '2026-10-11', category: 'entertainment', lines: [{ description: 'Client lunch', amountMinor: 11500, taxBp: 1500 }], amountPaidMinor: 11500 }));       // denied R15.00
  inp.do('expense.record', ex({ supplierInvoiceNumber: 'V-3', incurredOn: '2026-10-12', category: 'tools', capital: true, lines: [{ description: 'Table saw', amountMinor: 115000, taxBp: 1500 }], amountPaidMinor: 115000 })); // capital R150.00, field 14
  r = await run({ before: inp.steps, ...vat('?from=2026-10-01&to=2026-10-31') }); const vs = body(r).result || {};
  check(status(r) === 200 && vs.field14Minor === 15000 && vs.field15Minor === 3000 && vs.inputTaxMinor === 18000, 'October input tax: capital goods R150.00 (field 14) and other goods R30.00 (field 15), R180.00 in all; the entertainment tax is not claimed');
  check(vs.field4Minor === 18000 && vs.netVatMinor === 0, 'and net VAT for October is output R180.00 less input R180.00: nothing to pay');
  check((vs.inputExcluded || []).length === 1 && vs.inputExcluded[0].taxMinor === 1500 && /denied|17\(2\)/i.test(vs.inputExcluded[0].reasons.join(' ')), 'the expense whose tax was not claimed is listed with its reason (R15.00, entertainment)');
  check(vs.outputOnly === false && (vs.notes || []).some((n) => /expenses/i.test(n) && /bill/i.test(n)), 'the summary no longer says it is output only, and says plainly that input tax covers recorded expenses and that supplier bills are not in it yet');
  r = await run({ before: inp.steps, ...vat('?from=2026-11-01&to=2026-11-30') }); check((body(r).result || {}).inputTaxMinor === 0 && (body(r).result || {}).netVatMinor === 0, 'November has no expenses: no input tax');
  const lateLock = ext(inp); lateLock.do('tax_lock.set', { lockDate: '2026-10-31' }, 'owner'); lateLock.do('expense.record', ex({ supplierInvoiceNumber: 'V-4', incurredOn: '2026-10-20' }));
  r = await run({ before: lateLock.steps, ...vat('?from=2026-11-01&to=2026-11-30') }); check((body(r).result || {}).field15Minor === 3000, 'an expense from October recorded after the lock is claimed in NOVEMBER');
  r = await run({ before: lateLock.steps, ...vat('?from=2026-10-01&to=2026-10-31') }); check((body(r).result || {}).inputTaxMinor === 18000, 'and October\'s figure does not move once it is locked');
  const vd2 = ext(inp); vd2.do('expense.void', vd(((await list(inp.steps)).expenses.find((x) => x.supplierInvoiceNumber === 'V-1') || {}).id || 0));
  r = await run({ before: vd2.steps, ...vat('?from=2026-10-01&to=2026-10-31') }); check((body(r).result || {}).field15Minor === 0, 'a voided expense no longer counts');

  // ---- 8. THE FOUNDATIONS STILL HOLD ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const { verifyIntegrity, EVENT_MODEL } = eng;
  check(['expense.recorded', 'expense.voided'].every((x) => EVENT_MODEL[x] && EVENT_MODEL[x].creates === null), 'the event model knows both new events and says they create no fact row of their own');
  const wf = await mk(); const done = await rec1(wf); await facts.voidExpense(wf.w.env, { expenseId: done.documentId, reason: 'x', voidedOn: '2026-10-20' }, CTX); await rec1(wf, { supplierInvoiceNumber: 'KEEP' });
  let integ = await verifyIntegrity(wf.w.env);
  check(integ.ok === true && integ.problems.length === 0 && integ.warnings.length === 0, 'the integrity verifier is clean after a record, a void and another record, with no warning about an unmodelled event');
  wf.w.db.prepare("INSERT INTO eng_event (type, payload_json) VALUES ('expense.recorded', ?)").run(JSON.stringify({ documentId: 7777, movementId: 1, supplierId: wf.vend, category: 'materials', amountPaidMinor: 1 }));
  integ = await verifyIntegrity(wf.w.env);
  check(integ.ok === false && integ.problems.some((p) => p.code === 'orphan' && /7777/.test(p.detail) && /does not exist/.test(p.detail)), 'an expense event that points at a document that does not exist is REPORTED (orphan)');
  const w2 = await mk(); const r2 = await rec1(w2);
  w2.w.db.prepare("INSERT INTO eng_event (type, payload_json) VALUES ('expense.recorded', ?)").run(JSON.stringify({ documentId: r2.documentId, movementId: r2.movementId, supplierId: w2.vend, category: 'materials', amountPaidMinor: 999 }));
  integ = await verifyIntegrity(w2.w.env);
  check(integ.problems.some((p) => /amount paid|does not match|movement/i.test(p.detail)), 'an expense whose recorded amount paid does not match its money-out movement is REPORTED by the verifier');
  w2.w.db.prepare("INSERT INTO eng_event (type, payload_json) VALUES ('expense.voided', ?)").run(JSON.stringify({ documentId: r2.documentId, reason: 'x', voidedOn: '2026-10-20' }));
  integ = await verifyIntegrity(w2.w.env);
  check(integ.problems.some((p) => /not reversed|voided/i.test(p.detail)), 'a void event for an expense that was not actually reversed is REPORTED');
  const atomic = async (label, prep, act) => { const pr = await prep(); pr.w.resetWrites(); await act(pr); const writes = pr.w.writeCount(); const leaked = [];
    for (let n = 1; n <= writes; n++) { const q = await prep(); const was = JSON.stringify(q.w.counts()); q.w.failAt(n); let threw = false; try { await act(q); } catch { threw = true; } if (!threw || JSON.stringify(q.w.counts()) !== was) leaked.push(n); }
    check(writes >= 4 && leaked.length === 0, `${label} is atomic: a failure at each of its ${writes} writes leaves nothing behind` + (leaked.length ? ' (leaked at ' + leaked.join(',') + ')' : '')); };
  await atomic('recording an expense', async () => mk(), (q) => rec1(q));
  await atomic('voiding an expense', async () => { const q = await mk(); q.exp = await rec1(q); return q; }, (q) => facts.voidExpense(q.w.env, { expenseId: q.exp.documentId, reason: 'x', voidedOn: '2026-10-20' }, CTX));
  const wn = await mk(); const was = JSON.stringify(wn.w.counts()); let codes = [];
  for (const input of [{ supplierId: 99, incurredOn: '2026-10-10', method: 'eft', category: 'materials', currency: 'ZAR', amountsIncludeTax: true, lines: [{ description: 'x', amountMinor: 100, taxBp: 1500 }], amountPaidMinor: 100, taxInvoiceHeld: true }, { supplierId: wn.vend, incurredOn: '2026-10-10', method: 'eft', category: 'groceries', currency: 'ZAR', amountsIncludeTax: true, lines: [{ description: 'x', amountMinor: 100, taxBp: 1500 }], amountPaidMinor: 100, taxInvoiceHeld: true }, { supplierId: wn.vend, incurredOn: '2026-10-10', method: 'eft', category: 'materials', currency: 'ZAR', amountsIncludeTax: true, lines: [{ description: 'x', amountMinor: 100, taxBp: 1500 }], amountPaidMinor: 500, taxInvoiceHeld: true }]) { try { await facts.recordExpense(wn.w.env, input, CTX); codes.push('none'); } catch (er) { codes.push(er && er.code); } }
  check(codes.every((c) => c && c !== 'none') && JSON.stringify(wn.w.counts()) === was, `the fact layer itself refuses a missing supplier, a category off the list and an amount paid that does not match, and writes nothing (${codes.join(', ')})`);
});

if (require.main === module) kit.standalone(module.exports);
