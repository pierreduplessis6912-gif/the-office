// WHAT NEEDS ATTENTION (docs/decisions/needs-attention.md): one derived list of what the business should look at now. It stores nothing, lists only what the viewer may read, says why each item is there,
// and uses 30 days after issue for a customer invoice only because no due date is recorded (and says so).
const kit = require('./engine-kit.js');

module.exports = kit.guard('engine attention', async ({ check }) => {
  const eng = kit.loadEngine();
  const { facts, capabilities } = eng;
  const CTX = { actorEmail: 'owner@example.com', contract: 'test', contractVersion: 1 };
  const AV = [...kit.ALL_CAPABILITIES, 'attention.find', 'invoices.find', 'supplier_invoices.find', 'supplier_invoice.record', 'jobs.find', 'quotations.find', 'stock.reorder_suggestions', 'job.create', 'quotation.create'];
  const w = kit.makeWorld(); w.configure({ currency: 'ZAR', mode: 'engine', available: AV });
  await facts.setBusinessProfile(w.env, { legalName: 'Test (Pty) Ltd', address: '5 Industrial Road', vatRegistered: true, vatNumber: '4123456789' }, CTX);
  const TODAY = '2026-11-17';
  const FULL = { perms: new Set(['receivables.read', 'bill.read', 'job.read', 'quotation.read', 'stock.read']), available: new Set(AV) };
  const read = (viewer, params = { asOf: TODAY }) => capabilities.READS.find((q) => q.id === 'attention.find').run(w.env, viewer, params);
  const kinds = (r) => r.items.map((i) => i.kind);

  const empty = await read(FULL);
  check(empty.count === 0 && empty.items.length === 0 && empty.truncated === false, 'a business with nothing wrong has an empty list');

  const mokoena = (await facts.recordParty(w.env, { kind: 'person', name: 'Mokoena', roles: ['customer'] }, CTX)).id;
  const vendor = (await facts.recordParty(w.env, { kind: 'organisation', name: 'Tile Co', roles: ['supplier'] }, CTX)).id;
  const lines = (price) => [{ description: 'Floor', quantityMilli: 1000, unit: 'job', unitPriceMinor: price, taxBp: 1500 }];

  // customer invoices: no due date is recorded, so 30 days after issue is used and the item says so
  const old = await facts.recordDocument(w.env, { kind: 'invoice', direction: 'sell', partyId: mokoena, currency: 'ZAR', issuedOn: '2026-10-01', lines: lines(100000) }, CTX);
  const fresh = await facts.recordDocument(w.env, { kind: 'invoice', direction: 'sell', partyId: mokoena, currency: 'ZAR', issuedOn: '2026-11-10', lines: lines(100000) }, CTX);
  let r = await read(FULL);
  const late = r.items.filter((i) => i.kind === 'invoice_late');
  check(late.length === 1 && late[0].ref.id === old.id && late[0].amountMinor === 115000, 'only the invoice more than 30 days old is listed, for what is still owing');
  check(/no due date was recorded/i.test(late[0].detail) && /30 days/.test(late[0].detail), 'the item says the 30 days is a rule used because no due date was recorded');
  check(late[0].dueOn === '2026-10-31', 'its date is issue date plus 30 days');
  await facts.recordPayment(w.env, { direction: 'in', partyId: mokoena, amountMinor: 115000, currency: 'ZAR', occurredOn: '2026-11-12', method: 'eft', allocations: [{ documentId: old.id, amountMinor: 115000 }] }, CTX);
  r = await read(FULL);
  check(!kinds(r).includes('invoice_late'), 'a paid invoice drops off the list');

  // supplier bills
  const bill = (no, dueOn) => facts.recordSupplierInvoice(w.env, { supplierId: vendor, invoicedOn: '2026-11-01', dueOn, currency: 'ZAR', supplierInvoiceNumber: no, category: 'materials', taxInvoiceHeld: true, lines: [{ description: 'Boards', quantityMilli: 1000, unit: 'u', unitPriceMinor: 50000, taxBp: 1500 }] }, CTX);
  await facts.recordDocument(w.env, { kind: 'invoice', direction: 'sell', partyId: mokoena, currency: 'ZAR', issuedOn: '2026-09-15', lines: lines(30000) }, CTX);
  await bill('B-NODUE', undefined);
  await bill('B-LATE', '2026-11-10'); await bill('B-SOON', '2026-11-20'); await bill('B-FAR', '2026-12-30');
  r = await read(FULL);
  check(kinds(r).filter((k) => k === 'bill_overdue').length === 1 && kinds(r).filter((k) => k === 'bill_due_soon').length === 1, 'one overdue bill and one due within 7 days; a bill due later is not listed');
  check(r.items[0].kind === 'bill_overdue' && kinds(r).indexOf('invoice_late') > 0, 'overdue bills come first, then late invoices');
  check(!r.items.some((i) => /B-NODUE/.test(i.detail)), 'a bill with no due date is never called overdue');

  // jobs: overdue and open snag
  const job = (await facts.createJob(w.env, { partyId: mokoena, description: 'Lounge floor', scheduledOn: '2026-11-10' }, CTX)).jobId;
  await facts.raiseSnag(w.env, { jobId: job, note: 'Gap at the door' }, CTX);
  r = await read(FULL);
  check(kinds(r).includes('job_overdue') && kinds(r).includes('job_snag'), 'an overdue job and its open snag are both listed');
  check(r.items.find((i) => i.kind === 'job_snag').detail === 'Gap at the door', 'the snag item carries the snag note');
  await facts.cancelJob(w.env, { jobId: job, reason: 'Customer changed plans' }, CTX);
  r = await read(FULL);
  check(!kinds(r).includes('job_overdue') && !kinds(r).includes('job_snag'), 'a cancelled job is no longer listed');

  // quotations
  const q = await facts.recordDocument(w.env, { kind: 'quotation', direction: 'sell', partyId: mokoena, currency: 'ZAR', issuedOn: '2026-10-01', terms: { validUntil: '2026-10-31' }, lines: lines(20000) }, CTX);
  await facts.recordDocument(w.env, { kind: 'quotation', direction: 'sell', partyId: mokoena, currency: 'ZAR', issuedOn: '2026-10-01', lines: lines(9000) }, CTX);
  r = await read(FULL);
  check(kinds(r).filter((k) => k === 'quote_expired').length === 1, 'an open quotation past its valid-until date is listed');

  // stock
  const item = (await facts.createItem(w.env, { sku: 'T-1', name: 'Tile glue', unit: 'each', reorderLevelMilli: 5000 }, CTX)).itemId;
  r = await read(FULL);
  check(r.items.some((i) => i.kind === 'stock_low' && i.ref.id === item), 'stock below its reorder level is listed');

  // viewers see only what they may read
  const onlyJobs = { perms: new Set(['job.read']), available: new Set(AV) };
  const noBills = { perms: new Set(['receivables.read', 'job.read']), available: new Set(AV) };
  const unavailable = { perms: FULL.perms, available: new Set(AV.filter((c) => c !== 'supplier_invoices.find')) };
  check((await read(onlyJobs)).items.every((i) => i.kind.startsWith('job_')), 'a viewer who may only read jobs sees only job items');
  check(!kinds(await read(noBills)).some((k) => k.startsWith('bill_')), 'a viewer without bill.read sees no bills');
  check(!kinds(await read(unavailable)).some((k) => k.startsWith('bill_')), 'a read this business does not have switched on adds nothing');
  check((await read({ perms: new Set(), available: new Set(AV) })).count === 0, 'a viewer who may read nothing sees an empty list');

  // shape and honesty
  r = await read(FULL);
  check(r.today === TODAY && r.derivedBy === 'attention.attentionItems' && r.count === r.items.length, 'the answer names the day it was worked out for and how it was derived');
  check(r.items.every((i) => i.title && i.detail && ['string'].includes(typeof i.kind)), 'every item has a title and says why');
  const again = await read(FULL);
  check(JSON.stringify(again) === JSON.stringify(r), 'reading twice gives the same list (nothing is stored or changed)');
  check((await read(FULL, { asOf: '2026-11-01' })).items.filter((i) => i.kind === 'bill_overdue').length === 0, 'asking as of an earlier day gives that day\'s list');
  const bad = capabilities.READS.find((q2) => q2.id === 'attention.find').validate({ asOf: 'tomorrow' });
  check(bad.ok === false, 'a badly written date is refused');
  check(capabilities.READS.find((q2) => q2.id === 'attention.find').validate({ nope: 1 }).ok === false, 'a stray field is refused');

  // ---- the REST door: the list is for any member who may read something on it, not the owner alone (the handler then shows each person only their own sections) ---------------------------------------------------
  const auth = kit.bundle('auth.ts', 'auth');
  const AV2 = [...kit.ALL_CAPABILITIES, 'attention.find', 'invoices.find', 'jobs.find', 'quotations.find'];
  const door = (role) => kit.route({ env: { BUSINESS_ID: 'eng-a' }, seed: kit.seedReceivables(AV2), method: 'GET', path: '/engine/attention', role });
  const codeOf = (r) => r.result && r.result.status;
  for (const role of ['owner', 'accountant', 'installer']) {
    const r = await door(role);
    check(codeOf(r) === 200, `the attention list answers the ${role} at the REST door (${codeOf(r)})`);
  }
  const allowed = new Set(); for (const e of (auth.ROUTE_RULES || [])) if (e.path && e.path.test('/engine/attention')) for (const c of e.anyOf || []) allowed.add(c);
  check(allowed.size > 0, 'the REST route table names who may ask for the attention list');
});
if (require.main === module) kit.standalone(module.exports);
