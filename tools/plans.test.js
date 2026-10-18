// The plan catalogue, seats and per-seat limits (worker/src/limits.ts, seats.ts; billing slice 1, decided with Pierre 2026-10-20: Single user, Team per seat with a minimum of 3, Enterprise sales-led, copying the structure of Anthropic's own plans).
// Plans are DATA (a `plans` table in the shared layer), so a price or a limit changes without a deploy. Three things must hold: (1) the limits are FAIL-OPEN (any error gives the default plan, which only warns), so a shared layer that has not
// got the new columns yet must NOT silently drop a trial business's enforcement; (2) seats are counted from the real members and the real pending invitations, and only a plan that has a seat limit ever refuses anyone; (3) a failure in the
// seat check never stops an owner working.
const path = require('path'), fs = require('fs'), os = require('os'), esbuild = require('esbuild');
const { DatabaseSync } = require('node:sqlite');

module.exports = async function runPlansTests(context) {
  const standIn = global.Response;
  if (global.__RealResponse) global.Response = global.__RealResponse;
  try { await plansTests(context); } finally { global.Response = standIn; }
};

async function plansTests({ check, srcDir }) {
  const bundle = (entry) => { const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pl-')), 'm.js'); esbuild.buildSync({ entryPoints: [path.join(srcDir, entry)], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent' }); return require(out); };
  let lm, st, dir, D1;
  try { lm = bundle('limits.ts'); dir = bundle('directory.ts'); D1 = bundle('storage/do-d1.ts').DoD1Database; st = bundle('seats.ts'); } catch (e) { check(false, 'limits.ts, directory.ts and seats.ts build: ' + String(e.message).split('\n')[0].slice(0, 140)); return; }
  const plain = (r) => (r ? { ...r } : r);
  const makeDb = () => { const db = new DatabaseSync(':memory:'); const sql = { exec(query, ...binds) { const s = db.prepare(query); if (/^\s*(select|with|pragma|values)\b/i.test(query) || /\breturning\b/i.test(query)) { const rows = s.all(...binds).map(plain); return { toArray: () => rows, rowsRead: rows.length, rowsWritten: 0 }; } const r = s.run(...binds); return { toArray: () => [], rowsRead: 0, rowsWritten: Number(r.changes) }; } }; const storage = { transactionSync(fn) { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } } }; return { db, d1: new D1(sql, storage) }; };
  const names = (list) => list.map((p) => p.name).sort().join();

  // ---- the catalogue ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const fresh = async () => { const shared = makeDb(), obj = makeDb(); obj.db.exec("CREATE TABLE memberships (id INTEGER PRIMARY KEY AUTOINCREMENT, google_email TEXT NOT NULL UNIQUE, role TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active')"); const env = { OFFICE_DB: shared.d1, SHARED_DB: shared.d1, PLAN_CACHE_SECONDS: '0' }; await dir.ensureDirectory(env); return { shared, obj, env, oenv: { OFFICE_DB: obj.d1, SHARED_DB: shared.d1, BUSINESS_ID: 'acme', PLAN_CACHE_SECONDS: '0' } }; };
  {
    const { env } = await fresh(); const plans = await lm.listPlans(env), offers = await lm.listOffers(env), by = Object.fromEntries(offers.map((o) => [o.name, o]));
    check(names(offers) === 'enterprise,solo,team' && names(plans).includes('solo') && names(plans).includes('team') && names(plans).includes('enterprise') && names(plans).includes('standard'), 'the three plans a customer can have exist alongside the existing ones, and are assignable by an operator');
    check(by.solo.label === 'Single user' && by.solo.monthlyCents === 39900 && by.solo.annualCents === 399000 && by.solo.perSeat === false && by.solo.minSeats === 1 && by.solo.maxSeats === 1 && by.solo.messagesPerMemberPerDay === 100 && by.solo.neuronsPerBusinessPerDay === 20000 && by.solo.mode === 'enforce' && by.solo.public === true, 'SINGLE USER: R399 a month, R3,990 a year (two months free), one person, 20,000 AI units a day, enforced');
    check(by.team.label === 'Team' && by.team.monthlyCents === 29900 && by.team.annualCents === 299000 && by.team.perSeat === true && by.team.minSeats === 3 && by.team.maxSeats === null && by.team.neuronsPerBusinessPerDay === 20000 && by.team.mode === 'enforce' && by.team.public === true, 'TEAM: R299 a seat a month, R2,990 a seat a year, at least 3 seats, 20,000 AI units a day PER SEAT');
    check(by.enterprise.label === 'Enterprise' && by.enterprise.monthlyCents === null && by.enterprise.annualCents === null && by.enterprise.public === false && by.enterprise.perSeat === true, 'ENTERPRISE has no self-serve price and is not offered on the plans page: an operator sets it up');
    check(offers.map((o) => o.name).join() === 'solo,team,enterprise', 'the offers come in the order they are shown');
    check(!offers.some((o) => o.name === 'standard' || o.name === 'trial'), 'the plans a business is put on by an operator or starts on (standard, trial) are not offers');
  }
  {
    const { env } = await fresh(); await lm.listPlans(env);
    const set = await lm.setPlan(env, { name: 'solo', messagesPerMemberPerDay: 100, neuronsPerBusinessPerDay: 20000, mode: 'enforce', monthlyCents: 44900 }); const after = await lm.listOffers(env), solo = after.find((o) => o.name === 'solo');
    await lm.listPlans(env); await lm.ensureCatalog(env); const again = (await lm.listOffers(env)).find((o) => o.name === 'solo');
    check(set.ok && solo.monthlyCents === 44900 && solo.annualCents === 399000 && again.monthlyCents === 44900, 'an operator changes a price without a deploy, only that field changes, and re-reading the catalogue NEVER puts it back');
    const cases = [['a negative price', { monthlyCents: -1 }], ['a fractional price', { monthlyCents: 1.5 }], ['a price as text', { monthlyCents: '399' }], ['an absurd price', { monthlyCents: 10_000_001 }], ['per-seat as text', { perSeat: 'yes' }], ['a minimum of zero seats', { minSeats: 0 }], ['a maximum of zero seats', { maxSeats: 0 }], ['a maximum below the minimum', { minSeats: 5, maxSeats: 2 }], ['a label that is too long', { label: 'L'.repeat(41) }], ['an empty label', { label: '' }], ['public as text', { public: 'no' }], ['a sort that is not a number', { sort: 'first' }]];
    for (const [label, extra] of cases) { const r = await lm.setPlan(env, { name: 'team', messagesPerMemberPerDay: 100, neuronsPerBusinessPerDay: 20000, mode: 'enforce', ...extra }); check(r.ok === false && typeof r.error === 'string', `a plan change is refused: ${label}`); }
    check((await lm.setPlan(env, { name: 'enterprise', messagesPerMemberPerDay: 300, neuronsPerBusinessPerDay: 50000, mode: 'enforce', monthlyCents: null, annualCents: null, maxSeats: null })).ok === true, 'but a price may be cleared (null), which is what an enterprise plan has');
    const t = (await lm.listOffers(env)).find((o) => o.name === 'team'); check(t.monthlyCents === 29900 && t.minSeats === 3, 'and none of those refusals changed anything');
  }

  // ---- the trap: a shared layer from BEFORE the new columns (limits are fail-open, so a failed read would silently un-enforce the trial) ----------------------------------------------------------------------------
  {
    const shared = makeDb(); shared.db.exec("CREATE TABLE businesses (id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', plan TEXT NOT NULL DEFAULT 'standard', created_at TEXT NOT NULL DEFAULT (datetime('now')))");
    shared.db.exec("CREATE TABLE plans (name TEXT PRIMARY KEY, messages_per_member_per_day INTEGER NOT NULL, neurons_per_business_per_day INTEGER NOT NULL, mode TEXT NOT NULL DEFAULT 'warn', updated_at TEXT NOT NULL DEFAULT (datetime('now')))");
    shared.db.exec("INSERT INTO plans (name, messages_per_member_per_day, neurons_per_business_per_day, mode) VALUES ('trial', 30, 60000, 'enforce'), ('standard', 100, 400000, 'warn')"); shared.db.exec("INSERT INTO businesses (id, name, plan) VALUES ('trial-co', 'T', 'trial'), ('std-co', 'S', 'standard')");
    const env = { OFFICE_DB: shared.d1, SHARED_DB: shared.d1, BUSINESS_ID: 'trial-co', PLAN_CACHE_SECONDS: '0' };
    const t = await lm.readPlan(env), s = await lm.readPlan({ ...env, BUSINESS_ID: 'std-co' });
    check(t.name === 'trial' && t.neuronsPerBusinessPerDay === 60000 && t.messagesPerMemberPerDay === 30 && t.mode === 'enforce' && s.name === 'standard' && s.mode === 'warn', 'a shared layer that does not have the new columns yet STILL gives a trial business its trial limits, enforced (the lookup falls back to the old query; it never silently drops to the default that only warns)');
    const listed = await lm.listPlans(env); check(listed.some((p) => p.name === 'solo') && (await lm.readPlan(env)).name === 'trial', 'and the first read that can write adds the columns and the catalogue without disturbing the plans already there');
    check((await lm.readPlan({ ...env, BUSINESS_ID: 'std-co' })).neuronsPerBusinessPerDay === 400000 && (await lm.readPlan(env)).neuronsPerBusinessPerDay === 60000, 'and the existing limits are unchanged afterwards');
  }

  // ---- per-seat AI limits ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  {
    const { shared, env, oenv } = await fresh(); await lm.listPlans(env);
    const add = async (id, plan, seats) => { await dir.createBusiness(env, id, id, plan); if (seats !== undefined) shared.db.prepare('UPDATE businesses SET seats = ? WHERE id = ?').run(seats, id); };
    await add('team5', 'team', 5); await add('team-null', 'team'); await add('solo5', 'solo', 5); await add('ent10', 'enterprise', 10); await add('ent-huge', 'enterprise', 100000); await add('team1', 'team', 1);
    const read = async (id) => lm.readPlan({ ...oenv, BUSINESS_ID: id });
    check((await read('team5')).neuronsPerBusinessPerDay === 100000 && (await read('team-null')).neuronsPerBusinessPerDay === 20000 && (await read('solo5')).neuronsPerBusinessPerDay === 20000 && (await read('ent10')).neuronsPerBusinessPerDay === 500000 && (await read('team1')).neuronsPerBusinessPerDay === 20000, 'a per-seat plan\'s daily AI allowance is its per-seat figure times the seats paid for (5 seats: 100,000), a plan that is not per seat ignores seats, and no seats recorded means one');
    const huge = await read('ent-huge'); check(huge.name === 'enterprise' && huge.neuronsPerBusinessPerDay === lm.MAX_NEURONS, 'an enormous seat count is capped at the ceiling and never turns the plan invalid (an invalid plan falls back to the default)');
    check((await read('team5')).messagesPerMemberPerDay === 100 && (await read('team5')).mode === 'enforce', 'the messages a member may send are per member, whatever the seats');
  }

  // ---- seats: how many people a business may have ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  {
    const { shared, obj, env, oenv } = await fresh(); await lm.listPlans(env);
    const biz = async (id, plan, seats) => { await dir.createBusiness(env, id, id, plan); if (seats !== undefined) shared.db.prepare('UPDATE businesses SET seats = ? WHERE id = ?').run(seats, id); };
    await biz('trial-co', 'trial'); await biz('std-co', 'standard'); await biz('solo-co', 'solo'); await biz('team3', 'team', 3); await biz('team-null', 'team'); await biz('ent5', 'enterprise', 5); await biz('ent-null', 'enterprise'); await biz('odd-co', 'no-such-plan'); await biz('solo-seats', 'solo', 5);   // a Single user business that somehow has seats recorded (a downgrade) is still one person
    const cap = async (id) => (await st.seatCap({ ...oenv, BUSINESS_ID: id })).cap;
    check((await cap('trial-co')) === null && (await cap('std-co')) === null && (await cap('solo-co')) === 1 && (await cap('team3')) === 3 && (await cap('team-null')) === null && (await cap('ent5')) === 5 && (await cap('ent-null')) === null && (await cap('odd-co')) === null && (await cap('missing-co')) === null && (await cap('solo-seats')) === 1, 'seat limits: a trial or an operator\'s business has none, Single user is one, Team and Enterprise are the seats paid for (none recorded means no limit), and anything unknown has none');
    const members = (n, status = 'active') => { for (let i = 0; i < n; i++) obj.db.prepare("INSERT INTO memberships (google_email, role, status) VALUES (?, 'installer', ?)").run(`m${obj.db.prepare('SELECT COUNT(*) n FROM memberships').get().n}@x.co`, status); };
    const ask = (id, extra = {}) => st.checkSeat({ ...oenv, BUSINESS_ID: id }, { adding: 1, ...extra });
    members(1); const solo = await ask('solo-co');
    check(solo.ok === false && solo.status === 402 && /Single user/.test(solo.error) && /Team/.test(solo.error), 'a Single user business that has its one person cannot add another, and is told to move to Team');
    check((await ask('trial-co')).ok && (await ask('std-co')).ok && (await ask('team-null')).ok && (await ask('odd-co')).ok, 'a trial, an operator\'s business, a plan with no seats recorded and an unknown plan are never refused');
    check((await st.checkSeat({ ...oenv, BUSINESS_ID: 'solo-co' }, { adding: 0 })).ok === true, 'adding nobody is never refused');
    members(1); const t2 = await ask('team3'); check(t2.ok === true, 'a 3-seat Team with 2 people can add a third');
    members(1); const t3 = await ask('team3'); check(t3.ok === false && t3.status === 402 && /3 seats/.test(t3.error) && /seat/.test(t3.error), 'with all 3 seats used it cannot, and is told how many seats it has');
    obj.db.exec("DELETE FROM memberships WHERE id > 2"); obj.db.prepare("INSERT INTO memberships (google_email, role, status) VALUES ('gone@x.co', 'installer', 'inactive')").run(); check((await ask('team3')).ok === true, 'a deactivated member does not use a seat');
    await dir.upsertInvitation({ OFFICE_DB: shared.d1 }, 'invitee@x.co', 'team3', 'installer', 'boss@x.co', 'In Vitee'); check((await ask('team3')).ok === false, 'a pending invitation DOES use a seat (2 people and 1 invited is full)');
    check((await ask('team3', { ignoreInvitationFor: 'Invitee@X.co' })).ok === true, 'except for the person accepting that very invitation (it is already counted)');
    check((await ask('ent5')).ok === true, 'Enterprise with 5 seats and 2 people has room');
    const broken = { ...oenv, BUSINESS_ID: 'solo-co', SHARED_DB: { prepare: () => { throw new Error('no shared layer'); } } }; check((await st.checkSeat(broken, { adding: 1 })).ok === true, 'if the plan cannot be read the owner is NOT stopped (the seat check fails open, like every limit)');
    const brokenMembers = { ...oenv, BUSINESS_ID: 'solo-co', OFFICE_DB: { prepare: () => { throw new Error('no members table'); } } }; check((await st.checkSeat(brokenMembers, { adding: 1 })).ok === true, 'and neither if the members cannot be counted');
  }

  // ---- the module's own limits ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const seatsSrc = fs.readFileSync(path.join(srcDir, 'seats.ts'), 'utf8').replace(/\/\/[^\n]*/g, '');
  check(!/INSERT|UPDATE|DELETE|DROP|ALTER/.test(seatsSrc), 'the seat check only READS');
};
