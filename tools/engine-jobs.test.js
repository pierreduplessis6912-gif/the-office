// JOBS (docs/decisions/jobs-and-scheduling.md, J1): making a job, scheduling, assigning, cancelling, the derived state, the duplicate guard, the overdue flag, the read, permissions and the integrity verifier.
const kit = require('./engine-kit.js');

module.exports = kit.guard('engine jobs (J1)', async ({ check }) => {
  const eng = kit.loadEngine();
  const { facts, capabilities, verifyIntegrity, permissions } = eng;
  const CTX = { actorEmail: 'owner@example.com', contract: 'test', contractVersion: 1 };
  const codeOf = async (fn) => { try { await fn(); return null; } catch (e) { return e && e.code ? e.code : 'threw:' + String(e && e.message).slice(0, 80); } };
  const w = kit.makeWorld(); w.configure({ currency: 'ZAR' });
  const customer = (await facts.recordParty(w.env, { kind: 'person', name: 'Mokoena', roles: ['customer'] }, CTX)).id;
  const supplier = (await facts.recordParty(w.env, { kind: 'organisation', name: 'Tile Co', roles: ['supplier'] }, CTX)).id;
  const fitter = (await facts.recordParty(w.env, { kind: 'person', name: 'Sipho', roles: ['installer'] }, CTX)).id;
  const read = (params) => capabilities.READS.find((q) => q.id === 'jobs.find').run(w.env, { caps: ['job.read'] }, params);
  const contract = (id) => capabilities.ENGINE_CONTRACTS.find((k) => k.id === id);

  // ---- making a job ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const j1 = await facts.createJob(w.env, { partyId: customer, description: 'Lounge floor', siteAddress: '12 Palm Rd', scheduledOn: '2026-11-20', assigneeId: fitter, reference: 'PO-7' }, CTX);
  let r = await read({ asOf: '2026-11-17' });
  check(r.count === 1 && r.jobs[0].id === j1.jobId && r.jobs[0].partyName === 'Mokoena' && r.jobs[0].description === 'Lounge floor' && r.jobs[0].siteAddress === '12 Palm Rd' && r.jobs[0].scheduledOn === '2026-11-20' && r.jobs[0].assigneeName === 'Sipho' && r.jobs[0].reference === 'PO-7' && r.jobs[0].status === 'open' && r.jobs[0].overdue === false, `a job shows what it was made with (${JSON.stringify(r.jobs[0])})`);
  check(await codeOf(() => facts.createJob(w.env, { partyId: customer, description: ' lounge   FLOOR ' }, CTX)) === 'duplicate', 'the same work for the same customer while open is refused, whatever the spacing and case');
  check(await codeOf(() => facts.createJob(w.env, { partyId: supplier, description: 'Anything' }, CTX)) === 'invalid_state', 'a job cannot be made for someone who is not a customer');
  check(await codeOf(() => facts.createJob(w.env, { partyId: 999, description: 'Anything' }, CTX)) === 'not_found', 'a job for a customer that does not exist is refused');
  check(await codeOf(() => facts.createJob(w.env, { partyId: customer, description: 'Bath', assigneeId: supplier }, CTX)) === 'invalid_state', 'only an installer can be put on a job');
  check(await codeOf(() => facts.createJob(w.env, { partyId: customer, description: 'Bath', scheduledOn: '2026-13-45' }, CTX)) === 'invalid_input', 'a date that is not a date is refused');
  const bad = contract('job.create');
  check(bad.validate({ partyId: customer, description: 'x', color: 'red' }).ok === false && bad.validate({ partyId: 'a', description: 'x' }).ok === false && bad.validate({ partyId: 1, description: '   ' }).ok === false && bad.validate({ partyId: 1, description: 'x'.repeat(201) }).ok === false, 'the job contract refuses strays, a bad customer, an empty and an over-long description');
  const j2 = await facts.createJob(w.env, { partyId: customer, description: 'Bedroom blinds' }, CTX);

  // ---- scheduling ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  await facts.scheduleJob(w.env, { jobId: j2.jobId, scheduledOn: '2026-11-12' }, CTX);
  r = await read({ asOf: '2026-11-17' });
  check(r.jobs[0].id === j2.jobId && r.jobs[0].scheduledOn === '2026-11-12' && r.jobs[0].overdue === true && r.overdueCount === 1, 'a dated job before today is overdue and comes first, and nothing was moved silently');
  check(await codeOf(() => facts.scheduleJob(w.env, { jobId: j2.jobId, scheduledOn: '2026-11-12' }, CTX)) === 'invalid_state', 'scheduling a job for the date it already has changes nothing');
  await facts.scheduleJob(w.env, { jobId: j2.jobId, scheduledOn: '2026-11-25' }, CTX);
  await facts.scheduleJob(w.env, { jobId: j2.jobId, scheduledOn: null }, CTX);
  r = await read({ asOf: '2026-11-17' });
  check(r.jobs[r.jobs.length - 1].id === j2.jobId && r.jobs[r.jobs.length - 1].scheduledOn === null && r.overdueCount === 0, 'a job taken off the calendar has no date and goes last');
  check(await codeOf(() => facts.scheduleJob(w.env, { jobId: 999, scheduledOn: '2026-11-25' }, CTX)) === 'not_found', 'scheduling a job that does not exist is refused');
  const history = w.db.prepare("SELECT payload_json AS p FROM eng_event WHERE type = 'job.scheduled' ORDER BY id").all().map((e) => JSON.parse(e.p));
  check(history.length === 3 && history[1].previousOn === '2026-11-12' && history[2].scheduledOn === null, 'every move is an event that remembers the date before it');

  // ---- assigning -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  await facts.assignJob(w.env, { jobId: j2.jobId, assigneeId: fitter }, CTX);
  check((await read({ assigneeId: fitter, asOf: '2026-11-17' })).count === 2, 'the read can be narrowed to one person');
  check(await codeOf(() => facts.assignJob(w.env, { jobId: j2.jobId, assigneeId: fitter }, CTX)) === 'invalid_state', 'putting the same person on again changes nothing');
  check(await codeOf(() => facts.assignJob(w.env, { jobId: j2.jobId, assigneeId: customer }, CTX)) === 'invalid_state', 'a customer cannot be put on a job');
  await facts.assignJob(w.env, { jobId: j2.jobId, assigneeId: null }, CTX);
  check((await read({ assigneeId: fitter, asOf: '2026-11-17' })).count === 1 && await codeOf(() => facts.assignJob(w.env, { jobId: j2.jobId, assigneeId: null }, CTX)) === 'invalid_state', 'taking the person off works once and then there is nothing to take off');

  // ---- the date window and the customer filter -----------------------------------------------------------------------------------------------------------------------------------------------------
  check((await read({ from: '2026-11-17', to: '2026-11-23', asOf: '2026-11-17' })).count === 1, 'a week window shows only the dated jobs inside it');
  check((await read({ partyId: customer, asOf: '2026-11-17' })).count === 2 && (await read({ partyId: supplier, asOf: '2026-11-17' })).count === 0, 'the read can be narrowed to one customer');
  const rd = capabilities.READS.find((q) => q.id === 'jobs.find');
  check(rd.validate({ from: '2026-11-20', to: '2026-11-01' }).ok === false && rd.validate({ status: 'finished' }).ok === false && rd.validate({ nope: 1 }).ok === false, 'the read refuses a backwards window, an unknown status and strays');

  // ---- cancelling ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  check(await codeOf(() => facts.cancelJob(w.env, { jobId: j2.jobId, reason: '  ' }, CTX)) === 'invalid_input', 'cancelling needs a reason');
  await facts.cancelJob(w.env, { jobId: j2.jobId, reason: 'Customer changed her mind' }, CTX);
  check((await read({ asOf: '2026-11-17' })).count === 1 && (await read({ status: 'cancelled', asOf: '2026-11-17' })).jobs[0].cancelledReason === 'Customer changed her mind' && (await read({ status: 'any', asOf: '2026-11-17' })).count === 2, 'a cancelled job leaves the open list, stays on record with its reason');
  check(await codeOf(() => facts.cancelJob(w.env, { jobId: j2.jobId, reason: 'again' }, CTX)) === 'invalid_state' && await codeOf(() => facts.scheduleJob(w.env, { jobId: j2.jobId, scheduledOn: '2026-12-01' }, CTX)) === 'invalid_state' && await codeOf(() => facts.assignJob(w.env, { jobId: j2.jobId, assigneeId: fitter }, CTX)) === 'invalid_state', 'a cancelled job cannot be cancelled, scheduled or assigned again');
  check(await codeOf(() => facts.createJob(w.env, { partyId: customer, description: 'Bedroom blinds' }, CTX)) === null, 'the same work can be made again once the earlier job is cancelled');

  // ---- contracts, permissions, wiring ---------------------------------------------------------------------------------------------------------------------------------------------------------------
  for (const id of ['job.create', 'job.schedule', 'job.assign', 'job.cancel']) {
    const k = contract(id);
    check(!!k && k.heldType === 'engine.' + id && k.permissions.includes('job.manage') && k.recordsExecution === true, `${id} is a held contract that records its execution`);
  }
  check(rd.permissions.includes('job.read'), 'the read needs job.read');
  const eventsOf = ['job.created', 'job.scheduled', 'job.assigned', 'job.cancelled'];
  check(eventsOf.every((t) => w.db.prepare('SELECT COUNT(*) AS n FROM eng_event WHERE type = ?').get(t).n > 0), 'all four job events were written');
  check(permissions && Object.keys(permissions).length >= 0, 'permissions module loaded');

  // ---- integrity -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const v = await verifyIntegrity(w.env);
  check(v.ok === true, `the verifier is content (${JSON.stringify(v.problems || []).slice(0, 200)})`);
  w.db.prepare("INSERT INTO eng_event (type, actor_email, payload_json) VALUES ('job.scheduled', 'x', '{\"jobId\":999,\"scheduledOn\":\"2026-12-01\"}')").run();
  const v2 = await verifyIntegrity(w.env);
  check(v2.ok === false && JSON.stringify(v2.problems).includes('job_inconsistent'), 'an event naming a job that does not exist is reported');
});
if (require.main === module) kit.standalone(module.exports);
