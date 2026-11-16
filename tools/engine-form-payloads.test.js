// The app's forms (docs/decisions/create-from-screen.md) send the same payload a sentence would, through POST /engine/proposals. This pins the engine's side for the first form, "new customer or supplier":
// exactly what the form sends is HELD (nothing recorded), becomes a customer/supplier only on approval, and a refusal carries the engine's own reason for the form to show.
const kit = require('./engine-kit.js');

module.exports = kit.guard('engine form payloads (F1 to F4, quotation, invoice)', async ({ check }) => {
  const AV = [...kit.ALL_CAPABILITIES, 'party.create', 'parties.find', 'expense.record', 'supplier_payment.record', 'quotation.create', 'invoice.issue'];
  const run = (spec) => kit.route({ env: { BUSINESS_ID: 'eng-a' }, seed: kit.seedReceivables(AV), ...spec });
  const body = (r) => (r.result && r.result.body) || {};
  const status = (r) => r.result && r.result.status;
  const added = (r, t) => ((r.writes && r.writes[t] && r.writes[t].added) || []).length;
  const send = (role, payload) => ({ method: 'POST', path: '/engine/proposals', role, body: { capability: 'party.create', payload, transcript: 'Added from the New customer or supplier form', source: 'app' } });
  const form = { kind: 'organisation', name: 'Mokoena Flooring', roles: ['customer', 'supplier'], contact: { phone: '082 555 0101', email: 'info@mokoena.example' } };

  let r = await run(send('owner', form));
  check(status(r) === 200 && body(r).status === 'held' && Number.isInteger(body(r).actionId), `the form's payload is held (${status(r)} ${body(r).status})`);
  check(added(r, 'eng_party') === 0 && added(r, 'eng_party_role') === 0, 'and nothing is recorded by sending it');
  const before = [send('owner', form), { method: 'POST', path: '/actions/1/confirm', role: 'owner', body: {} }];
  r = await run({ before: before.slice(0, 1), ...before[1] });
  check(status(r) === 200 && added(r, 'eng_party') === 1 && added(r, 'eng_party_role') === 2, `approving it records one party with two roles (${status(r)})`);
  r = await run({ before, method: 'GET', path: '/engine/parties', role: 'owner' });
  const list = (body(r).result || {}).parties || [];
  check(list.some((p) => p.name === 'Mokoena Flooring' && p.kind === 'organisation'), 'and it is in the list of customers and suppliers');

  const small = { kind: 'person', name: 'Thandi', roles: ['customer'] };
  r = await run(send('owner', small));
  check(status(r) === 200 && body(r).status === 'held', 'a person with only a name and a role is held too');

  r = await run({ before, ...send('owner', { ...form, name: 'mokoena flooring' }) });
  check(status(r) >= 400 && /already a customer or supplier called Mokoena Flooring/.test(String(body(r).message)), `a name already used is refused with the engine's own reason (${status(r)}: ${body(r).message})`);
  r = await run(send('owner', { ...small, name: '   ' }));
  check(status(r) >= 400 && typeof body(r).message === 'string' && body(r).message.length > 5, `a blank name is refused with a reason (${body(r).message})`);
  r = await run(send('owner', { ...small, roles: [] }));
  check(status(r) >= 400, 'no role is refused');
  r = await run(send('installer', small));
  check(status(r) >= 400 && added(r, 'eng_party') === 0, `someone who may not add parties is refused (${status(r)})`);

  // ---- F2: record a payment received -------------------------------------------------------------------------------------------------------------------------------------------------------
  const payForm = { partyId: 1, amountMinor: 45050, currency: 'ZAR', occurredOn: '2026-11-16', method: 'eft', allocate: 'oldest_first' };
  const pay = (role, payload) => ({ method: 'POST', path: '/engine/proposals', role, body: { capability: 'payment.record', payload, transcript: 'Added from the Record a payment form', source: 'app' } });
  r = await run(pay('accountant', payForm));
  check(status(r) === 200 && body(r).status === 'held' && added(r, 'eng_money_movement') === 0, 'the payment form\'s payload is held and records nothing');
  r = await run({ before: [pay('accountant', payForm)], method: 'POST', path: '/actions/1/confirm', role: 'accountant', body: {} });
  check(status(r) === 200 && added(r, 'eng_money_movement') === 1 && added(r, 'eng_allocation') === 1, `approving it records the payment and settles the oldest invoice (${status(r)})`);
  r = await run(pay('accountant', { ...payForm, bankAccountId: 999 }));
  check(status(r) >= 400 && /not one of the business's bank accounts/.test(String(body(r).message)), `a bank account that does not exist is refused with the engine's reason (${body(r).message})`);
  r = await run(pay('accountant', { ...payForm, method: 'cash', bankAccountId: 1 }));
  check(status(r) >= 400, 'cash naming a bank account is refused');
  r = await run(pay('accountant', { ...payForm, amountMinor: 0 }));
  check(status(r) >= 400, 'an amount of nothing is refused');
  r = await run(pay('installer', payForm));
  check(status(r) >= 400 && added(r, 'eng_money_movement') === 0, 'someone who may not record payments is refused');

  // ---- F3: record an expense ----------------------------------------------------------------------------------------------------------------------------------------------------------------
  const expForm = { supplierId: 2, incurredOn: '2026-11-16', paidOn: '2026-11-16', method: 'eft', category: 'materials', currency: 'ZAR', amountsIncludeTax: true, taxInvoiceHeld: true, amountPaidMinor: 115000, lines: [{ description: 'Skirting boards', amountMinor: 115000, taxBp: 1500 }] };
  const exp = (role, payload) => ({ method: 'POST', path: '/engine/proposals', role, body: { capability: 'expense.record', payload, transcript: 'Added from the Record an expense form', source: 'app' } });
  const mkSupplier = [send('owner', { kind: 'organisation', name: 'Timber Supplies', roles: ['supplier'] }), { method: 'POST', path: '/actions/1/confirm', role: 'owner', body: {} }];   // party 2, after Mokoena
  r = await run({ before: mkSupplier, ...exp('accountant', expForm) });
  check(status(r) === 200 && body(r).status === 'held' && added(r, 'eng_money_movement') === 0, `the expense form's payload is held and records nothing (${JSON.stringify(body(r)).slice(0, 160)})`);
  r = await run({ before: [...mkSupplier, exp('accountant', expForm)], method: 'POST', path: '/actions/2/confirm', role: 'accountant', body: {} });
  check(status(r) === 200 && added(r, 'eng_money_movement') === 1, `approving it records the expense and its payment (${status(r)} ${JSON.stringify(body(r)).slice(0, 160)})`);
  r = await run({ before: mkSupplier, ...exp('accountant', { ...expForm, category: 'nonsense' }) });
  check(status(r) >= 400 && /category must be one of/.test(String(body(r).message)), `an unknown category is refused with the engine's reason (${body(r).message})`);
  r = await run({ before: mkSupplier, ...exp('accountant', { ...expForm, method: 'cash', bankAccountId: 1 }) });
  check(status(r) >= 400, 'cash naming a bank account is refused');
  r = await run({ before: mkSupplier, ...exp('installer', expForm) });
  check(status(r) >= 400 && added(r, 'eng_money_movement') === 0, 'someone who may not record expenses is refused');

  // ---- F4: pay a supplier -------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const spForm = { supplierId: 2, amountMinor: 115000, currency: 'ZAR', paidOn: '2026-11-16', method: 'eft', allocate: 'oldest_first' };
  const sp = (role, payload) => ({ method: 'POST', path: '/engine/proposals', role, body: { capability: 'supplier_payment.record', payload, transcript: 'Added from the Pay a supplier form', source: 'app' } });
  r = await run({ before: mkSupplier, ...sp('accountant', spForm) });
  check(status(r) === 409 && /payable to this supplier/.test(String(body(r).message)) && added(r, 'eng_money_movement') === 0, `with no bills owing, the form's payload is refused with the engine's own reason and records nothing (${body(r).message}); the held path is proven by the supplier payment suites`);
  r = await run({ before: mkSupplier, ...sp('accountant', { ...spForm, method: 'cash', bankAccountId: 1 }) });
  check(status(r) >= 400, 'cash naming a bank account is refused');
  r = await run({ before: mkSupplier, ...sp('installer', spForm) });
  check(status(r) >= 400 && added(r, 'eng_money_movement') === 0, 'someone who may not pay suppliers is refused');

  // ---- the quotation form ----------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const qForm = { partyId: 1, issuedOn: '2026-11-17', currency: 'ZAR', validUntil: '2026-12-17', reference: 'Lounge floor', lines: [{ description: 'Vinyl plank', quantityMilli: 2500, unit: 'm²', unitPriceMinor: 45000, taxBp: 1500 }, { description: 'Fitting', quantityMilli: 1000, unit: null, unitPriceMinor: 80000, taxBp: 0 }] };
  const quo = (role, payload) => ({ method: 'POST', path: '/engine/proposals', role, body: { capability: 'quotation.create', payload, transcript: 'Added from the Make a quotation form', source: 'app' } });
  r = await run(quo('sales', qForm));
  check(status(r) === 200 && body(r).status === 'held' && added(r, 'eng_document') === 0, `the quotation form's payload is held and makes nothing (${JSON.stringify(body(r)).slice(0, 140)})`);
  r = await run({ before: [quo('sales', qForm)], method: 'POST', path: '/actions/1/confirm', role: 'owner', body: {} });
  check(status(r) === 200 && added(r, 'eng_document') === 1 && added(r, 'eng_document_line') === 2, `approving it makes the quotation with its two lines (${status(r)} ${JSON.stringify(body(r)).slice(0, 140)})`);
  r = await run(quo('sales', { ...qForm, partyId: 99 }));
  check(status(r) >= 400 && /no such customer/.test(String(body(r).message)), `an unknown customer is refused with the engine's reason (${body(r).message})`);
  r = await run(quo('sales', { ...qForm, lines: [{ ...qForm.lines[0], taxBp: undefined }] }));
  check(status(r) >= 400, 'a line with no VAT rate is refused (VAT is never assumed)');
  r = await run(quo('installer', qForm));
  check(status(r) >= 400 && added(r, 'eng_document') === 0, 'someone who may not make quotations is refused');

  // ---- the invoice form: open a draft, save the lines into it (neither is held), then propose invoice.issue ------------------------------------------------------------------------
  const iContents = { currency: 'ZAR', issuedOn: '2026-11-17', reference: 'Lounge floor', lines: [{ description: 'Vinyl plank', quantityMilli: 2500, unit: 'm²', unitPriceMinor: 45000, taxBp: 1500 }, { description: 'Fitting', quantityMilli: 1000, unit: null, unitPriceMinor: 80000, taxBp: 0 }] };
  const open = (role) => ({ method: 'POST', path: '/engine/drafts', role, body: { kind: 'invoice', direction: 'sell', partyId: 1 } });
  const save = (role, payload = iContents, v = 1) => ({ method: 'PUT', path: '/engine/drafts/1', role, body: { expectedVersion: v, partyId: 1, payload } });
  const issue = (role, version = 2) => ({ method: 'POST', path: '/engine/proposals', role, body: { capability: 'invoice.issue', payload: { draftId: 1, expectedVersion: version }, transcript: 'Added from the Make an invoice form', source: 'app' } });
  r = await run(open('accountant'));
  check(status(r) === 200 && body(r).id === 1 && body(r).version === 1 && added(r, 'eng_document') === 0, `opening a draft returns its number and version and makes no document (${JSON.stringify(body(r)).slice(0, 120)})`);
  r = await run({ before: [open('accountant')], ...save('accountant') });
  check(status(r) === 200 && body(r).version === 2 && body(r).validation && body(r).validation.ok === true && body(r).validation.totals && body(r).validation.totals.grossMinor === 45000 * 2.5 * 1.15 + 80000, `saving the form's lines gives version 2 and the engine's own totals (${JSON.stringify(body(r)).slice(0, 200)})`);
  r = await run({ before: [open('accountant')], ...save('accountant', { ...iContents, issuedOn: undefined }) });
  check(status(r) === 200 && body(r).validation.ok === false && body(r).validation.errors.some((e) => e.field === 'issuedOn'), 'a draft with no date is not ready, and the engine names the field');
  r = await run({ before: [open('accountant'), save('accountant')], ...issue('accountant') });
  check(status(r) === 200 && body(r).status === 'held' && added(r, 'eng_document') === 0, `the issue proposal for the saved draft is held and makes no invoice (${JSON.stringify(body(r)).slice(0, 140)})`);
  r = await run({ before: [open('accountant'), save('accountant'), issue('accountant')], method: 'POST', path: '/actions/1/confirm', role: 'accountant', body: {} });
  check(status(r) === 200 && added(r, 'eng_document') === 1 && added(r, 'eng_document_line') === 2, `approving it issues the invoice with its two lines (${status(r)} ${JSON.stringify(body(r)).slice(0, 140)})`);
  r = await run({ before: [open('accountant'), save('accountant')], ...issue('accountant', 1) });
  check(status(r) >= 400 && added(r, 'eng_document') === 0, 'proposing against an older version of the draft is refused');
  r = await run(open('installer'));
  check(status(r) === 403, 'someone who may not work on drafts cannot open one');
});
if (require.main === module) kit.standalone(module.exports);
