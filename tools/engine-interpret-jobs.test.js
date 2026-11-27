// THE MODEL'S SENTENCES FOR JOBS (docs/decisions/jobs-and-scheduling.md): "new job for Mokoena, lounge floor, Friday" and "what is on this week". Scripted model, no real model. The model supplies WORDS (a name, the work, a day word
// that the sentence itself must say); the engine resolves the customer and works the date out from today; a write is only PROPOSED and HELD; an unknown customer, a made-up day and a stray argument are not understood.
const kit = require('./engine-kit.js');

module.exports = kit.guard('engine interpret (jobs)', async ({ check }) => {
  const ENV_A = { BUSINESS_ID: 'eng-a', ENGINE_REHEARSAL: '1' };
  const SEED = { admin: true, method: 'POST', path: '/admin/engine/provision-sample', body: { confirm: 'eng-a' } };
  const call = (capability, args) => JSON.stringify(capability === null ? { capability: null } : { capability, arguments: args });
  const say = (re, reply) => ({ match: re, reply: () => reply });
  const SCRIPT = [
    say(/New job for Mokoena, lounge floor, Friday/, call('job.create', { customer: 'Mokoena', description: 'Lounge floor', when: 'friday' })),
    say(/New job for Mokoena, patio at 5 Palm Road/, call('job.create', { customer: 'Mokoena', description: 'Patio', site: '5 Palm Road' })),
    say(/New job for Mokoena today, probe/, call('job.create', { customer: 'Mokoena', description: 'Probe', when: 'today' })),
    say(/New job for Mokoena tomorrow, blinds/, call('job.create', { customer: 'Mokoena', description: 'Blinds', when: 'tomorrow' })),
    say(/New job for Mokoena, bath, sometime/, call('job.create', { customer: 'Mokoena', description: 'Bath', when: 'friday' })),
    say(/New job for Nobody, floor/, call('job.create', { customer: 'Nobody', description: 'Floor' })),
    say(/New job for Mokoena with a date/, JSON.stringify({ capability: 'job.create', arguments: { customer: 'Mokoena', description: 'Floor', scheduledOn: '2030-01-01' } })),
    say(/New job for Mokoena by id/, JSON.stringify({ capability: 'job.create', arguments: { customer: 'Mokoena', description: 'Floor', partyId: 1 } })),
    say(/New job for Mokoena on the thirty-first/, call('job.create', { customer: 'Mokoena', description: 'Floor', when: '2026-12-31' })),
    { match: /New job for Mokoena on the same weekday/, reply: () => call('job.create', { customer: 'Mokoena', description: 'Weekly', when: WEEKDAY[0] }) },
    // the real model's reply to the date sentence (run 44120067321): it dropped the date and kept the rest
    say(/New job for Mokoena on 2027-03-01, floor/, call('job.create', { customer: 'Mokoena', description: 'floor' })),
    say(/New job for Mokoena on 3 March, floor/, call('job.create', { customer: 'Mokoena', description: 'floor' })),
    say(/New job for Mokoena on the 5th, floor/, call('job.create', { customer: 'Mokoena', description: 'floor' })),
    say(/New job for Mokoena on 12\/03, floor/, call('job.create', { customer: 'Mokoena', description: 'floor' })),
    say(/New job for Mokoena next week, floor/, call('job.create', { customer: 'Mokoena', description: 'floor' })),
    say(/New job for Mokoena at 12 Palm Road, floor/, call('job.create', { customer: 'Mokoena', description: 'Floor', site: '12 Palm Road' })),
    say(/What is on this week\?/, call('jobs.find', { period: 'this_week' })),
    say(/What is on next week\?/, call('jobs.find', { period: 'next_week' })),
    say(/What is overdue\?/, call('jobs.find', { period: 'overdue' })),
    say(/What jobs are open\?/, call('jobs.find', {})),
    say(/What jobs does Mokoena have\?/, call('jobs.find', { customer: 'Mokoena' })),
    say(/What jobs does Nobody have\?/, call('jobs.find', { customer: 'Nobody' })),
    say(/What is on next century\?/, call('jobs.find', { period: 'next_century' })),
    say(/What is on with a filter\?/, call('jobs.find', { status: 'cancelled' })),
    say(/What needs my attention\?/, call('attention.find', {})),
    say(/What needs my attention with a filter\?/, call('attention.find', { kind: 'job_overdue' })),
    say(/What needs my attention, jobs only\?/, call('attention.find', {})),
    say(/What needs Mokoena's attention\?/, call('attention.find', {})),
    say(/Only the bills that need my attention/, call('attention.find', {})),
    say(/What's urgent\?/, call('attention.find', {})),
    say(/Anything I need to deal with right now\?/, call('attention.find', {})),
    say(/What should I be worried about in the business\?/, call('attention.find', {})),
    say(/What needs my attention for Patel\?/, call('attention.find', {})),
    say(/What have I forgotten about\?/, call('attention.find', {})),
    say(/Is there anything I should look at today\?/, call('attention.find', {})),
  ];
  const WEEKDAY = ['monday'];
  const as = (role, text) => ({ method: 'POST', path: '/engine/interpret', role, body: { text } });
  const interpret = (text, role = 'owner', before = []) => kit.route({ env: ENV_A, ai: SCRIPT, before: [SEED, ...before], method: 'POST', path: '/engine/interpret', role, body: { text } });
  const added = (res, t) => ((res.writes && res.writes[t] && res.writes[t].added) || []).length;
  const tables = (res) => Object.keys(res.writes || {}).filter((t) => added(res, t) > 0).sort();
  const body = (res) => (res.result && res.result.body) || {};
  const status = (res) => res.result && res.result.status;
  const NOT = (res) => status(res) === 422 && body(res).error === 'not_understood';
  const HELD = JSON.stringify(['captures', 'eng_interpretation', 'pending_actions']);
  const pendingOf = async (text, role = 'owner') => { const res = await kit.route({ env: ENV_A, ai: SCRIPT, before: [SEED, as(role, text)], method: 'GET', path: '/actions/pending', role: 'owner' }); const p = (body(res).pending || [])[0]; try { let v = p ? (p.payload_json || p.payload) : null; while (typeof v === 'string') v = JSON.parse(v); return v; } catch { return null; } };
  const iso = (d) => d.toISOString().slice(0, 10);
  // the harness runs the worker on its own fixed clock, so "today" is what the ENGINE says it is: ask it through a sentence that says "today"
  const TODAY = (await pendingOf('New job for Mokoena today, probe')).scheduledOn;
  check(/^\d{4}-\d{2}-\d{2}$/.test(TODAY), `the engine's own date is read back through "today" (${TODAY})`);
  const base = new Date(TODAY + 'T00:00:00Z');
  const plus = (n) => iso(new Date(base.getTime() + n * 86400000));
  const mondayBased = (base.getUTCDay() + 6) % 7;
  WEEKDAY[0] = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'][mondayBased];
  const nextFriday = plus(((4 - mondayBased + 7) % 7) || 7);

  // ---- making a job ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  let r = await interpret('New job for Mokoena, lounge floor, Friday');
  check(status(r) === 200 && body(r).status === 'held' && body(r).understood.capability === 'job.create' && JSON.stringify(tables(r)) === HELD && added(r, 'eng_job') === 0, 'a new-job sentence is HELD and nothing is made until it is approved');
  let p = await pendingOf('New job for Mokoena, lounge floor, Friday');
  check(p && p.partyId === 1 && p.description === 'Lounge floor' && p.scheduledOn === nextFriday && p.siteAddress === undefined && Object.keys(p).length === 3, `the payload holds the resolved customer, the work and the date the ENGINE worked out (${JSON.stringify(p)} vs ${nextFriday})`);
  p = await pendingOf('New job for Mokoena on the same weekday as today ' + WEEKDAY[0]);
  check(p && p.scheduledOn === plus(7), `a weekday said on that very weekday means next week, not today (${p && p.scheduledOn} vs ${plus(7)})`);
  p = await pendingOf('New job for Mokoena tomorrow, blinds');
  check(p && p.scheduledOn === plus(1), 'tomorrow is worked out from today');
  p = await pendingOf('New job for Mokoena, patio at 5 Palm Road');
  check(p && p.siteAddress === '5 Palm Road' && p.scheduledOn === undefined, 'a site is kept, and no day means no date');
  for (const t of ['New job for Mokoena on 2027-03-01, floor', 'New job for Mokoena on 3 March, floor', 'New job for Mokoena on the 5th, floor', 'New job for Mokoena on 12/03, floor', 'New job for Mokoena next week, floor']) check(NOT(await interpret(t)), `a date the model dropped is not held without it: "${t}"`);
  check(status(await interpret('New job for Mokoena at 12 Palm Road, floor')) === 200, 'a street number is not mistaken for a date');
  check(NOT(await interpret('New job for Mokoena, bath, sometime')), 'a day word the sentence never says is not understood (a model never invents a day)');
  check(NOT(await interpret('New job for Mokoena on the thirty-first')), 'a date from the model is not accepted, only a day word');
  check(NOT(await interpret('New job for Mokoena with a date')) && NOT(await interpret('New job for Mokoena by id')), 'a date or an id supplied as an argument is not understood');
  r = await interpret('New job for Nobody, floor');
  check(status(r) === 404 || (body(r).code === 'not_found') || JSON.stringify(body(r)).includes('no customer called Nobody'), 'a customer the business does not have is refused by name, not guessed');
  r = await interpret('New job for Mokoena, lounge floor, Friday', 'installer');
  check(!(status(r) === 200 && body(r).status === 'held'), 'someone who may not manage jobs is not offered it and nothing is held');

  // ---- asking about jobs -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const world = [
    { method: 'POST', path: '/engine/proposals', role: 'owner', body: { capability: 'job.create', payload: { partyId: 1, description: 'Lounge floor', scheduledOn: plus(1) }, transcript: 'seed' } }, { method: 'POST', path: '/actions/1/confirm', role: 'owner', body: {} },
    { method: 'POST', path: '/engine/proposals', role: 'owner', body: { capability: 'job.create', payload: { partyId: 2, description: 'Shopfront', scheduledOn: plus(-3) }, transcript: 'seed' } }, { method: 'POST', path: '/actions/2/confirm', role: 'owner', body: {} },
    { method: 'POST', path: '/engine/proposals', role: 'owner', body: { capability: 'job.create', payload: { partyId: 2, description: 'Today job', scheduledOn: plus(0) }, transcript: 'seed' } }, { method: 'POST', path: '/actions/3/confirm', role: 'owner', body: {} },
    { method: 'POST', path: '/engine/proposals', role: 'owner', body: { capability: 'job.create', payload: { partyId: 1, description: 'Far away', scheduledOn: plus(40) }, transcript: 'seed' } }, { method: 'POST', path: '/actions/4/confirm', role: 'owner', body: {} },
  ];
  const names = (res) => ((body(res).result || {}).jobs || []).map((j) => j.description).sort();
  r = await interpret('What jobs are open?', 'owner', world);
  check(status(r) === 200 && body(r).understood.capability === 'jobs.find' && names(r).length === 4 && tables(r).length <= 3 && !tables(r).includes('pending_actions'), `"what jobs are open" reads every open job and writes nothing held (${names(r)})`);
  r = await interpret('What is overdue?', 'owner', world);
  check(JSON.stringify(names(r)) === JSON.stringify(['Shopfront']) && body(r).result.overdueCount === 1, `"overdue" is the open jobs dated before today (${names(r)})`);
  r = await interpret('What is on this week?', 'owner', world);
  const inWeek = (d) => { const mon = new Date(Date.parse(plus(-mondayBased) + 'T00:00:00Z')); const t = Date.parse(d + 'T00:00:00Z'); return t >= mon.getTime() && t <= mon.getTime() + 6 * 86400000; };
  const expectWeek = [[plus(1), 'Lounge floor'], [plus(0), 'Today job'], [plus(-3), 'Shopfront'], [plus(40), 'Far away']].filter(([d]) => inWeek(d)).map(([, n]) => n).sort();
  check(JSON.stringify(names(r)) === JSON.stringify(expectWeek), `"this week" is Monday to Sunday of this week (${names(r)} vs ${expectWeek})`);
  r = await interpret('What jobs does Mokoena have?', 'owner', world);
  check(JSON.stringify(names(r)) === JSON.stringify(['Far away', 'Lounge floor']), `a customer's jobs are only theirs (${names(r)})`);
  check(status(await interpret('What jobs does Nobody have?', 'owner', world)) !== 200, 'a customer the business does not have is refused');
  check(NOT(await interpret('What is on next century?', 'owner', world)) && NOT(await interpret('What is on with a filter?', 'owner', world)), 'an unknown period or a stray argument is not understood');
  check(!(status(await interpret('What jobs are open?', 'installer', world)) === 200 && names(await interpret('What jobs are open?', 'installer', world)).length > 0), 'someone who may not read jobs is not answered');

  // ---- what needs attention ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  r = await interpret('What needs my attention?', 'owner', world);
  const items = (res) => ((body(res).result || {}).items || []);
  check(status(r) === 200 && body(r).understood.capability === 'attention.find' && items(r).some((i) => i.kind === 'job_overdue' && /Shopfront/.test(i.title)) && JSON.stringify(tables(r).filter((t) => t === 'pending_actions')) === '[]', 'the attention sentence reads the list (the overdue job is on it) and holds nothing');
  check(NOT(await interpret('What needs my attention with a filter?', 'owner', world)), 'a stray argument on the attention sentence is not understood');
  // a sentence that NARROWS the list (a kind, a customer, "only") when the model dropped the narrowing: the list takes none, so it is refused, never answered whole as if it had been the question
  check(NOT(await interpret('What needs my attention, jobs only?', 'owner', world)) && NOT(await interpret("What needs Mokoena's attention?", 'owner', world)) && NOT(await interpret('Only the bills that need my attention', 'owner', world)) && NOT(await interpret('What needs my attention for Patel?', 'owner', world)), 'a narrowed attention sentence the model turned into the whole list is not understood');
  const PLAIN = ["What's urgent?", 'Anything I need to deal with right now?', 'What should I be worried about in the business?', 'What have I forgotten about?', 'Is there anything I should look at today?'];
  let plainOk = true; for (const t of PLAIN) { const x = await interpret(t, 'owner', world); if (!(status(x) === 200 && (body(x).understood || {}).capability === 'attention.find')) plainOk = false; }
  check(plainOk, 'plain ways of asking for the list are still understood');
  r = await interpret('What needs my attention?', 'installer', world);
  check(!items(r).some((i) => i.kind.startsWith('job_')), 'someone who may not read jobs is not shown the job items');
});
if (require.main === module) kit.standalone(module.exports);
