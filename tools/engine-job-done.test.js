// DONE AND SNAGS (docs/decisions/jobs-and-scheduling.md, J3): a job shows as done when someone marks it done, or when the invoices tied to it are all paid in full; an open snag always stops it being done; snags are
// noted and closed (their number is the event that raised them); a done job cannot be cancelled; nothing is stored as a state, it is all derived from events and links.
const kit = require('./engine-kit.js');

module.exports = kit.guard('engine job done and snags (J3)', async ({ check }) => {
  const eng = kit.loadEngine();
  const { facts, capabilities, verifyIntegrity } = eng;
  const CTX = { actorEmail: 'owner@example.com', contract: 'test', contractVersion: 1 };
  const codeOf = async (fn) => { try { await fn(); return null; } catch (e) { return e && e.code ? e.code : 'threw:' + String(e && e.message).slice(0, 80); } };
  const w = kit.makeWorld(); w.configure({ currency: 'ZAR' });
  await facts.setBusinessProfile(w.env, { legalName: 'Test (Pty) Ltd', address: '5 Industrial Road', vatRegistered: true, vatNumber: '4123456789' }, CTX);
  const cust = (await facts.recordParty(w.env, { kind: 'person', name: 'Mokoena', roles: ['customer'] }, CTX)).id;
  const rd = capabilities.READS.find((q) => q.id === 'jobs.find');
  const find = async (status) => (await rd.run(w.env, { caps: ['job.read'] }, { status, asOf: '2026-11-17' })).jobs;
  const get = async (id) => (await find('any')).find((j) => j.id === id);
  const mk = async (what) => (await facts.createJob(w.env, { partyId: cust, description: what, scheduledOn: '2026-11-10' }, CTX)).jobId;
  const lines = [{ description: 'Floor', quantityMilli: 1000, unit: 'job', unitPriceMinor: 100000, taxBp: 1500 }];

  // ---- marked done ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const a = await mk('Lounge floor');
  check((await get(a)).status === 'open' && (await get(a)).overdue === true, 'a new job is open (and overdue here: its date has passed)');
  await facts.completeJob(w.env, { jobId: a }, CTX);
  let j = await get(a);
  check(j.status === 'done' && j.markedDone === true && j.overdue === false, 'a job marked done shows as done, and is no longer overdue');
  check((await find('open')).every((x) => x.id !== a) && (await find('done')).some((x) => x.id === a), 'done jobs leave the open list and show under done');
  check(await codeOf(() => facts.completeJob(w.env, { jobId: a }, CTX)) === 'invalid_state', 'marking a job done that already shows as done changes nothing');
  check(await codeOf(() => facts.cancelJob(w.env, { jobId: a, reason: 'x' }, CTX)) === 'invalid_state', 'a done job cannot be cancelled');

  // ---- snags ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const s1 = await facts.raiseSnag(w.env, { jobId: a, note: 'Scratch near the door' }, CTX);
  j = await get(a);
  check(j.status === 'open' && j.openSnags === 1 && j.snags[0].id === s1.snagId && j.snags[0].note === 'Scratch near the door' && j.snags[0].open === true, 'a snag raised on a done job stops it showing as done');
  check(await codeOf(() => facts.raiseSnag(w.env, { jobId: a, note: ' scratch NEAR the door ' }, CTX)) === 'duplicate', 'the same open snag twice is refused');
  check(await codeOf(() => facts.completeJob(w.env, { jobId: a }, CTX)) === 'invalid_state', 'a job with an open snag cannot be marked done');
  check(await codeOf(() => facts.closeSnag(w.env, { jobId: a, snagId: 999 }, CTX)) === 'not_found', 'closing a snag that does not exist is refused');
  const b = await mk('Bedroom blinds');
  check(await codeOf(() => facts.closeSnag(w.env, { jobId: b, snagId: s1.snagId }, CTX)) === 'not_found', 'a snag cannot be closed through another job');
  await facts.closeSnag(w.env, { jobId: a, snagId: s1.snagId }, CTX);
  j = await get(a);
  check(j.status === 'done' && j.openSnags === 0 && j.snags[0].open === false, 'closing the last snag lets the job show as done again (it was marked done)');
  check(await codeOf(() => facts.closeSnag(w.env, { jobId: a, snagId: s1.snagId }, CTX)) === 'invalid_state', 'a snag that is already closed cannot be closed again');
  check(await codeOf(() => facts.raiseSnag(w.env, { jobId: a, note: 'Scratch near the door' }, CTX)) === null, 'the same note can be raised again once the earlier snag is closed');

  // ---- done by money: every tied invoice paid in full -------------------------------------------------------------------------------------------------------------------------------------------------
  const inv = await facts.recordDocument(w.env, { kind: 'invoice', direction: 'sell', partyId: cust, currency: 'ZAR', issuedOn: '2026-11-05', lines }, CTX);
  await facts.linkToJob(w.env, { jobId: b, documentId: inv.id }, CTX);
  check((await get(b)).status === 'open', 'an invoice tied to a job but not paid leaves it open');
  await facts.recordPayment(w.env, { direction: 'in', partyId: cust, amountMinor: 50000, currency: 'ZAR', occurredOn: '2026-11-10', method: 'eft', allocations: [{ documentId: inv.id, amountMinor: 50000 }] }, CTX);
  check((await get(b)).status === 'open', 'a part payment leaves it open');
  await facts.recordPayment(w.env, { direction: 'in', partyId: cust, amountMinor: 65000, currency: 'ZAR', occurredOn: '2026-11-11', method: 'eft', allocations: [{ documentId: inv.id, amountMinor: 65000 }] }, CTX);
  check((await get(b)).status === 'done' && (await get(b)).markedDone === false, 'the job shows as done by itself once the tied invoice is paid in full');
  const s2 = await facts.raiseSnag(w.env, { jobId: b, note: 'Blind hangs crooked' }, CTX);
  check((await get(b)).status === 'open', 'an open snag stops a paid job showing as done');
  await facts.closeSnag(w.env, { jobId: b, snagId: s2.snagId }, CTX);
  check((await get(b)).status === 'done', 'and closing it brings it back to done');
  check(await codeOf(() => facts.completeJob(w.env, { jobId: b }, CTX)) === 'invalid_state', 'a job already done by payment cannot be marked done again');

  // ---- the rest -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const c = await mk('Patio');
  await facts.cancelJob(w.env, { jobId: c, reason: 'Not going ahead' }, CTX);
  check(await codeOf(() => facts.completeJob(w.env, { jobId: c }, CTX)) === 'invalid_state' && await codeOf(() => facts.raiseSnag(w.env, { jobId: c, note: 'x' }, CTX)) === 'invalid_state', 'a cancelled job cannot be marked done or given a snag');
  check(await codeOf(() => facts.completeJob(w.env, { jobId: 999 }, CTX)) === 'not_found' && await codeOf(() => facts.raiseSnag(w.env, { jobId: 999, note: 'x' }, CTX)) === 'not_found', 'a job that does not exist is refused');
  check(rd.validate({ status: 'done' }).ok === true && rd.validate({ status: 'finished' }).ok === false, 'the read accepts done as a status');
  for (const [id, good, bad] of [['job.complete', { jobId: 1 }, { jobId: 1, x: 1 }], ['job.snag_raise', { jobId: 1, note: 'n' }, { jobId: 1, note: ' ' }], ['job.snag_close', { jobId: 1, snagId: 2 }, { jobId: 1 }]]) {
    const k = capabilities.ENGINE_CONTRACTS.find((x) => x.id === id);
    check(!!k && k.heldType === 'engine.' + id && k.permissions.includes('job.manage') && k.recordsExecution === true && k.validate(good).ok === true && k.validate(bad).ok === false, `${id} is a held contract with a strict payload`);
  }
  const v = await verifyIntegrity(w.env);
  check(v.ok === true, `the verifier is content (${JSON.stringify(v.problems || []).slice(0, 200)})`);
});
if (require.main === module) kit.standalone(module.exports);
