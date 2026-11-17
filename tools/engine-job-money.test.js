// MONEY TIED TO A JOB (docs/decisions/jobs-and-scheduling.md, J2): job.link ties an existing quotation, invoice or expense to an open job; the job then reads what was quoted, invoiced, paid and spent (derived, gross,
// effective documents only); a quotation or invoice must be for the job's customer; one document, one job; a voided document cannot be tied and stops counting; a job with money tied cannot be cancelled.
const kit = require('./engine-kit.js');

module.exports = kit.guard('engine job money (J2)', async ({ check }) => {
  const eng = kit.loadEngine();
  const { facts, capabilities, verifyIntegrity } = eng;
  const CTX = { actorEmail: 'owner@example.com', contract: 'test', contractVersion: 1 };
  const codeOf = async (fn) => { try { await fn(); return null; } catch (e) { return e && e.code ? e.code : 'threw:' + String(e && e.message).slice(0, 80); } };
  const w = kit.makeWorld(); w.configure({ currency: 'ZAR' });
  await facts.setBusinessProfile(w.env, { legalName: 'Test (Pty) Ltd', address: '5 Industrial Road', vatRegistered: true, vatNumber: '4123456789' }, CTX);
  const mokoena = (await facts.recordParty(w.env, { kind: 'person', name: 'Mokoena', roles: ['customer'] }, CTX)).id;
  const dlamini = (await facts.recordParty(w.env, { kind: 'person', name: 'Dlamini', roles: ['customer'] }, CTX)).id;
  const vendor = (await facts.recordParty(w.env, { kind: 'organisation', name: 'Tile Co', roles: ['supplier'] }, CTX)).id;
  const job = (await facts.createJob(w.env, { partyId: mokoena, description: 'Lounge floor' }, CTX)).jobId;
  const other = (await facts.createJob(w.env, { partyId: dlamini, description: 'Patio' }, CTX)).jobId;
  const lines = (price) => [{ description: 'Floor', quantityMilli: 1000, unit: 'job', unitPriceMinor: price, taxBp: 1500 }];
  const money = async (id) => (await capabilities.READS.find((q) => q.id === 'jobs.find').run(w.env, { caps: ['job.read'] }, { status: 'any', asOf: '2026-11-17' })).jobs.find((j) => j.id === id).money;
  const link = (jobId, documentId) => facts.linkToJob(w.env, { jobId, documentId }, CTX);

  const zero = await money(job);
  check(zero.quotedMinor === 0 && zero.invoicedMinor === 0 && zero.paidMinor === 0 && zero.spentMinor === 0 && zero.leftOverMinor === 0 && zero.linked === 0, 'a job with nothing tied to it has all-zero money');

  const quote = await facts.recordDocument(w.env, { kind: 'quotation', direction: 'sell', partyId: mokoena, currency: 'ZAR', issuedOn: '2026-11-01', lines: lines(100000) }, CTX);
  const inv = await facts.recordDocument(w.env, { kind: 'invoice', direction: 'sell', partyId: mokoena, currency: 'ZAR', issuedOn: '2026-11-05', lines: lines(100000) }, CTX);
  const exp = await facts.recordExpense(w.env, { supplierId: vendor, incurredOn: '2026-11-06', method: 'eft', category: 'materials', currency: 'ZAR', amountsIncludeTax: true, lines: [{ description: 'Tiles', amountMinor: 23000, taxBp: 1500 }], amountPaidMinor: 23000, taxInvoiceHeld: true }, CTX);
  await link(job, quote.id); await link(job, inv.id); await link(job, exp.documentId);
  let m = await money(job);
  check(m.quotedMinor === 115000 && m.invoicedMinor === 115000 && m.paidMinor === 0 && m.spentMinor === 23000 && m.leftOverMinor === -23000 && m.linked === 3, `quoted, invoiced and spent show, nothing paid yet (${JSON.stringify(m)})`);

  await facts.recordPayment(w.env, { direction: 'in', partyId: mokoena, amountMinor: 50000, currency: 'ZAR', occurredOn: '2026-11-10', method: 'eft', allocations: [{ documentId: inv.id, amountMinor: 50000 }] }, CTX);
  m = await money(job);
  check(m.paidMinor === 50000 && m.leftOverMinor === 27000, `a payment allocated to the tied invoice shows as paid, and left over is paid less spent (${JSON.stringify(m)})`);

  // ---- the rules ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  check(await codeOf(() => link(job, inv.id)) === 'duplicate', 'tying the same document to the same job again is refused');
  check(await codeOf(() => link(other, inv.id)) === 'duplicate', 'a document is tied to at most one job');
  const quote2 = await facts.recordDocument(w.env, { kind: 'quotation', direction: 'sell', partyId: mokoena, currency: 'ZAR', issuedOn: '2026-11-02', lines: lines(5000) }, CTX);
  check(await codeOf(() => link(other, quote2.id)) === 'invalid_state', 'a quotation for another customer cannot be tied to the job');
  const exp2 = await facts.recordExpense(w.env, { supplierId: vendor, incurredOn: '2026-11-07', method: 'eft', category: 'materials', currency: 'ZAR', amountsIncludeTax: true, lines: [{ description: 'Glue', amountMinor: 11500, taxBp: 1500 }], amountPaidMinor: 11500, taxInvoiceHeld: true }, CTX);
  check(await codeOf(() => link(other, exp2.documentId)) === null, 'an expense has no customer, so it can be tied to any open job');
  check(await codeOf(() => link(job, 99999)) === 'not_found' && await codeOf(() => link(999, quote2.id)) === 'not_found', 'a document or a job that does not exist is refused');
  const pay = w.db.prepare("SELECT id FROM eng_document WHERE kind NOT IN ('quotation', 'invoice', 'expense') LIMIT 1").get();
  if (pay) check(await codeOf(() => link(job, Number(pay.id))) === 'not_found', 'only quotations, invoices and expenses can be tied');

  // ---- a quotation that has been revised no longer stands ----------------------------------------------------------------------------------------------------------------------------------------
  const q3 = await facts.recordDocument(w.env, { kind: 'quotation', direction: 'sell', partyId: mokoena, currency: 'ZAR', issuedOn: '2026-11-03', lines: lines(20000) }, CTX);
  await link(job, q3.id);
  const before = (await money(job)).quotedMinor;
  await facts.reviseQuotation(w.env, { quotationId: q3.id, lines: lines(30000) }, CTX);
  check(before === 115000 + 23000 && (await money(job)).quotedMinor === 115000, `a tied quotation that has been revised stops counting as quoted (${before} then ${(await money(job)).quotedMinor})`);

  // ---- voiding stops it counting -------------------------------------------------------------------------------------------------------------------------------------------------------------------
  await facts.voidExpense(w.env, { expenseId: exp.documentId, reason: 'Wrong supplier', voidedOn: '2026-11-12' }, CTX);
  m = await money(job);
  check(m.spentMinor === 0 && m.linked === 3, `a voided expense no longer counts as spent (${JSON.stringify(m)})`);
  check(await codeOf(() => link(job, exp.documentId)) === 'duplicate', 'a voided expense that was tied stays tied on record');

  // ---- cancelling ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  check(await codeOf(() => facts.cancelJob(w.env, { jobId: job, reason: 'x' }, CTX)) === 'invalid_state', 'a job with money tied to it cannot be cancelled');
  const emptyJob = (await facts.createJob(w.env, { partyId: mokoena, description: 'Bathroom' }, CTX)).jobId;
  check(await codeOf(() => facts.cancelJob(w.env, { jobId: emptyJob, reason: 'Not going ahead' }, CTX)) === null, 'a job with nothing tied to it can still be cancelled');
  check(await codeOf(() => link(emptyJob, quote2.id)) === 'invalid_state', 'nothing can be tied to a cancelled job');

  // ---- the quote that stands -------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const lc = capabilities.ENGINE_CONTRACTS.find((k) => k.id === 'job.link');
  check(!!lc && lc.heldType === 'engine.job.link' && lc.permissions.includes('job.manage') && lc.recordsExecution === true && lc.validate({ jobId: 1, documentId: 2 }).ok === true && lc.validate({ jobId: 1 }).ok === false && lc.validate({ jobId: 1, documentId: 2, x: 1 }).ok === false, 'job.link is a held contract that takes exactly a job and a document');
  check(await codeOf(() => capabilities.READS.find((q) => q.id === 'jobs.find').run(w.env, { caps: ['job.read'] }, {})) === null, 'the read still runs with the links in place');

  const v = await verifyIntegrity(w.env);
  check(v.ok === true, `the verifier is content (${JSON.stringify(v.problems || []).slice(0, 200)})`);
  w.db.prepare("INSERT INTO eng_event (type, actor_email, payload_json) VALUES ('job.linked', 'x', '{\"jobId\":1,\"documentId\":999}')").run();
  const v2 = await verifyIntegrity(w.env);
  check(v2.ok === false && JSON.stringify(v2.problems).includes('event_without_fact'), 'a link event without its link row is reported');
});
if (require.main === module) kit.standalone(module.exports);
