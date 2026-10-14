// Cost caps (worker/src/limits.ts). Plans are DATA in the shared layer; a member's day and a business's spend are checked BEFORE the model is called; in WARN mode nobody is stopped, in ENFORCE mode a
// member or business over the limit gets a clear 429; and a failure anywhere in this must NEVER stop anyone working (every read is fail-open). These tests pin each of those, and the counting rules (only
// a message that really ran counts: not a failure, not a retry answered from the stored result).
const path = require('path'), fs = require('fs'), os = require('os'), esbuild = require('esbuild');
const { DatabaseSync } = require('node:sqlite');

module.exports = async function runLimitsTests(context) {
  const standIn = global.Response;
  if (global.__RealResponse) global.Response = global.__RealResponse;
  try { await limitsTests(context); } finally { global.Response = standIn; }
};

async function limitsTests({ check, srcDir }) {
  const bundle = (entry) => { const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lm-')), 'm.js'); esbuild.buildSync({ entryPoints: [path.join(srcDir, entry)], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent' }); return require(out); };
  const lm = bundle('limits.ts'), auth = bundle('auth.ts'), us = bundle('usage.ts'), hl = bundle('health.ts'), mg = bundle('migration.ts'), dir = bundle('directory.ts'), { DoD1Database } = bundle('storage/do-d1.ts');
  const plain = (r) => (r ? { ...r } : r);
  const makeDb = () => {
    const db = new DatabaseSync(':memory:');
    const sql = { exec(query, ...binds) { const s = db.prepare(query); if (/^\s*(select|with|pragma|values)\b/i.test(query) || /\breturning\b/i.test(query)) { const rows = s.all(...binds).map(plain); return { toArray: () => rows, rowsRead: rows.length, rowsWritten: 0 }; } const r = s.run(...binds); return { toArray: () => [], rowsRead: 0, rowsWritten: Number(r.changes) }; } };
    const storage = { transactionSync(fn) { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } } };
    return { db, d1: new DoD1Database(sql, storage) };
  };
  const spyOn = (d1) => { const s = { calls: 0 }; return { s, d1: new Proxy(d1, { get(t, k) { if (k === 'prepare') return (...a) => { s.calls++; return t.prepare(...a); }; const v = t[k]; return typeof v === 'function' ? v.bind(t) : v; } }) }; };

  // a shared layer with a business, an object database, and members who can sign in
  const shared = makeDb(), obj = makeDb();
  const secretEnv = { SESSION_SECRET: 'test-secret-for-caps' };
  shared.db.exec("CREATE TABLE businesses (id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', plan TEXT NOT NULL DEFAULT 'standard', created_at TEXT NOT NULL DEFAULT (datetime('now')))");
  shared.db.exec("INSERT INTO businesses (id, name) VALUES ('zulu-co', 'Zulu Co')");
  const env = { ...secretEnv, OFFICE_DB: obj.d1, SHARED_DB: shared.d1, BUSINESS_ID: 'zulu-co', PLAN_CACHE_SECONDS: '0' };
  const sharedEnv = { OFFICE_DB: shared.d1 };
  const tokenOf = async (email) => auth.signSession(secretEnv, email);
  const msg = async (email, method = 'POST', p = '/messages/text') => new Request('https://x' + p, { method, headers: { Authorization: 'Bearer ' + (await tokenOf(email)) } });
  const t0 = new Date('2026-10-14T10:00:00Z');

  // ---- plans are data -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const first = await lm.listPlans(sharedEnv);
  check(first.length === 1 && first[0].name === 'standard' && first[0].messagesPerMemberPerDay === 100 && first[0].neuronsPerBusinessPerDay === 400000 && first[0].mode === 'warn', 'the starting plan is 100 messages a day per member, a 400,000-neuron daily ceiling per business, in WARN mode (placeholders to tune against real use)');
  const bad = [[{ name: 'Bad Name', messagesPerMemberPerDay: 5, neuronsPerBusinessPerDay: 5, mode: 'warn' }, /name must be/], [{ name: 'a', messagesPerMemberPerDay: 5, neuronsPerBusinessPerDay: 5, mode: 'warn' }, /name must be/], [{ name: 'ok', messagesPerMemberPerDay: 0, neuronsPerBusinessPerDay: 5, mode: 'warn' }, /messagesPerMemberPerDay/], [{ name: 'ok', messagesPerMemberPerDay: 100001, neuronsPerBusinessPerDay: 5, mode: 'warn' }, /messagesPerMemberPerDay/], [{ name: 'ok', messagesPerMemberPerDay: 2.5, neuronsPerBusinessPerDay: 5, mode: 'warn' }, /messagesPerMemberPerDay/], [{ name: 'ok', messagesPerMemberPerDay: '5', neuronsPerBusinessPerDay: 5, mode: 'warn' }, /messagesPerMemberPerDay/], [{ name: 'ok', messagesPerMemberPerDay: 5, neuronsPerBusinessPerDay: -1, mode: 'warn' }, /neuronsPerBusinessPerDay/], [{ name: 'ok', messagesPerMemberPerDay: 5, neuronsPerBusinessPerDay: 5, mode: 'block' }, /mode must be/]];
  const results = [];
  for (const [input, re] of bad) { const r = await lm.setPlan(sharedEnv, input); results.push(r.ok === false && re.test(r.error)); }
  check(results.every(Boolean) && (await lm.listPlans(sharedEnv)).length === 1, 'a plan with a bad name, a limit that is zero, too large, fractional, negative or not a number, or an unknown mode is REFUSED with the reason, and nothing is written');
  const made = await lm.setPlan(sharedEnv, { name: 'trial', messagesPerMemberPerDay: 20, neuronsPerBusinessPerDay: 50000, mode: 'enforce' });
  check(made.ok && (await lm.listPlans(sharedEnv)).find((p) => p.name === 'trial').mode === 'enforce', 'a plan can be created, and changed again');
  const assign = [await lm.assignPlan(sharedEnv, 'zulu-co', 'nope'), await lm.assignPlan(sharedEnv, 'ghost-co', 'trial'), await lm.assignPlan(sharedEnv, 5, 'trial')];
  check(assign[0].status === 404 && /no such plan/.test(assign[0].error) && assign[1].status === 404 && /no such business/.test(assign[1].error) && assign[2].status === 400 && shared.db.prepare("SELECT plan FROM businesses WHERE id = 'zulu-co'").get().plan === 'standard', 'giving a business a plan that does not exist, or a business that does not exist, or nonsense, is refused and changes nothing');
  check((await lm.assignPlan(sharedEnv, 'zulu-co', 'trial')).ok === true && shared.db.prepare("SELECT plan FROM businesses WHERE id = 'zulu-co'").get().plan === 'trial', 'a business can be given a plan');

  // ---- reading the plan: from the shared layer, cached, and fail-open ------------------------------------------------------------------------------------------------------------
  lm.clearPlanCache();
  const p1 = await lm.readPlan(env, 1000);
  check(p1.name === 'trial' && p1.messagesPerMemberPerDay === 20 && p1.mode === 'enforce', 'a business\'s plan is read from the shared layer (its own private database is a different database)');
  const cachedEnv = { ...env, PLAN_CACHE_SECONDS: '300' }; lm.clearPlanCache();
  await lm.readPlan(cachedEnv, 10_000);
  shared.db.exec("UPDATE plans SET messages_per_member_per_day = 21 WHERE name = 'trial'");
  const stale = await lm.readPlan(cachedEnv, 10_000 + 299_000), fresh = await lm.readPlan(cachedEnv, 10_000 + 301_000);
  check(stale.messagesPerMemberPerDay === 20 && fresh.messagesPerMemberPerDay === 21, 'the plan is remembered for five minutes (one shared-layer read, not one per message) and then read again');
  await lm.setPlan(sharedEnv, { name: 'trial', messagesPerMemberPerDay: 22, neuronsPerBusinessPerDay: 50000, mode: 'enforce' });
  check((await lm.readPlan({ ...env, PLAN_CACHE_SECONDS: '0' }, 1)).messagesPerMemberPerDay === 22, 'with the cache off every read is fresh (staging, so a rehearsal sees a change at once)');
  const failOpen = [
    ['the shared layer throws', { ...env, SHARED_DB: { prepare: () => { throw new Error('D1 is down'); } } }],
    ['there are no shared tables', { ...env, SHARED_DB: makeDb().d1 }],
    ['the business has no row', { ...env, BUSINESS_ID: 'nobody-co' }],
  ];
  for (const [what, e] of failOpen) { lm.clearPlanCache(); const p = await lm.readPlan(e, 1); check(p.name === 'standard' && p.mode === 'warn' && p.messagesPerMemberPerDay === 100, `FAIL-OPEN: when ${what}, the default plan applies (it warns and never blocks)`); }
  shared.db.exec("UPDATE plans SET mode = 'bogus' WHERE name = 'trial'"); lm.clearPlanCache();
  check((await lm.readPlan(env, 1)).mode === 'warn', 'and a plan row with a nonsense value is ignored in favour of the default');
  await lm.setPlan(sharedEnv, { name: 'trial', messagesPerMemberPerDay: 3, neuronsPerBusinessPerDay: 1000, mode: 'enforce' });

  // ---- who is counted ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const k = await lm.memberKey('Pierre@Example.com ');
  check(/^[0-9a-f]{12}$/.test(k) && k === (await lm.memberKey('pierre@example.com')) && k !== (await lm.memberKey('other@example.com')) && !k.includes('@'), 'a member is counted by a short hash of their address (case and spaces ignored), so the counts hold no readable address');

  // ---- the check before the model --------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const spy = spyOn(obj.d1), spied = { ...env, OFFICE_DB: spy.d1 };
  const notCap = [await lm.capBefore(spied, new Request('https://x/messages/text', { method: 'GET' }), t0), await lm.capBefore(spied, await msg('a@x.co', 'POST', '/customers'), t0), await lm.capBefore(spied, await msg('a@x.co', 'PUT', '/messages/text'), t0)];
  check(notCap.every((c) => c.countable === false && c.block === null) && spy.s.calls === 0, 'only the two routes that use the model are checked (text and voice): anything else is let through without touching a database');
  const unsigned = [await lm.capBefore(spied, new Request('https://x/messages/text', { method: 'POST' }), t0), await lm.capBefore(spied, new Request('https://x/messages/text', { method: 'POST', headers: { Authorization: 'Bearer garbage.token' } }), t0)];
  check(unsigned.every((c) => c.countable === false && c.block === null) && spy.s.calls === 0, 'a request with no valid session is not this check\'s business (the front door answers it)');
  const c1 = await lm.capBefore(env, await msg('a@x.co'), t0);
  check(c1.countable && c1.used === 0 && c1.over === null && c1.block === null && /^[0-9a-f]{12}$/.test(c1.member) && c1.plan.messagesPerMemberPerDay === 3, 'a first message of the day is allowed, uncounted so far, with the plan\'s limit known');
  const run = async (email, when = t0) => { const c = await lm.capBefore(env, await msg(email), when); if (!c.block) await lm.capAfter(env, c, when); return c; };
  await run('a@x.co'); await run('a@x.co');
  const third = await lm.capBefore(env, await msg('a@x.co'), t0);
  check(third.used === 2 && third.over === null && third.block === null, 'with a limit of 3 and two used, the third message is still allowed (the limit is the number allowed, not the number before it)');
  await lm.capAfter(env, third, t0);
  const fourth = await lm.capBefore(env, await msg('a@x.co'), new Date('2026-10-14T23:00:00Z'));
  const body = fourth.block ? await fourth.block.json() : null;
  check(fourth.block && fourth.block.status === 429 && fourth.block.headers.get('Retry-After') === '3600' && body.capped === true && body.reason === 'messages' && body.limit === 3 && body.used === 3 && body.resetsInSeconds === 3600 && /limit of 3 messages/.test(body.error) && /midnight UTC/.test(body.error), 'ENFORCE: the fourth message gets a clear 429 BEFORE the model is called, saying the limit, that it resets at midnight UTC and in how many seconds (3,600 at 23:00)');
  const other = await lm.capBefore(env, await msg('b@x.co'), t0);
  check(other.block === null && other.used === 0, 'another member of the same business is not affected');
  const nextDay = await lm.capBefore(env, await msg('a@x.co'), new Date('2026-10-15T00:00:01Z'));
  check(nextDay.block === null && nextDay.used === 0, 'and the next UTC day the member starts again from nothing');
  await lm.setPlan(sharedEnv, { name: 'trial', messagesPerMemberPerDay: 3, neuronsPerBusinessPerDay: 1000, mode: 'warn' });
  const warned = await lm.capBefore(env, await msg('a@x.co'), t0);
  check(warned.block === null && warned.over === 'messages' && warned.countable === true, 'WARN: the same member over the limit is NOT blocked, but the check says they are over');
  await lm.capAfter(env, warned, t0);
  const row = obj.db.prepare('SELECT messages, over_limit FROM member_usage WHERE day = ? AND member = ?').get('2026-10-14', warned.member);
  check(row.messages === 4 && row.over_limit === 1, 'and the day records that the member went over (4 messages, 1 of them over the limit)');

  // ---- the spend ceiling ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const sp = makeDb(); const spEnv = { ...env, OFFICE_DB: sp.d1 };
  await lm.setPlan(sharedEnv, { name: 'trial', messagesPerMemberPerDay: 50, neuronsPerBusinessPerDay: 1000, mode: 'enforce' });
  const tally = (n) => ({ ai: { n: 1 }, usage: { failures: 0, prompt: 1, completion: 1, cached: 0, neurons: n } });
  await us.recordModelUsage(spEnv, tally(999), t0);
  const under = await lm.capBefore(spEnv, await msg('a@x.co'), t0);
  await us.recordModelUsage(spEnv, tally(2), t0);
  const overSpend = await lm.capBefore(spEnv, await msg('a@x.co'), t0), spendBody = overSpend.block ? await overSpend.block.json() : null;
  check(under.block === null && overSpend.block && overSpend.block.status === 429 && spendBody.reason === 'spend' && spendBody.limit === 1000 && /business has reached today's usage limit/.test(spendBody.error), 'ENFORCE: a business whose neurons today reach its ceiling is turned away (999 of 1,000 is allowed, 1,001 is not), whoever the member is');
  await lm.setPlan(sharedEnv, { name: 'trial', messagesPerMemberPerDay: 50, neuronsPerBusinessPerDay: 1000, mode: 'warn' });
  const spendWarn = await lm.capBefore(spEnv, await msg('a@x.co'), t0);
  const yesterday = await lm.capBefore(spEnv, await msg('a@x.co'), new Date('2026-10-15T10:00:00Z'));
  check(spendWarn.block === null && spendWarn.over === 'spend' && yesterday.over === null, 'in WARN mode it is flagged but not blocked, and only TODAY\'s neurons count');

  // ---- what counts ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const resp = (status, headers = {}) => new Response(status === 204 ? null : '{}', { status, headers });
  check([200, 201, 204].every((s) => lm.isCountable(resp(s))) && [400, 401, 403, 404, 409, 429, 500, 502].every((s) => !lm.isCountable(resp(s))) && !lm.isCountable(resp(200, { 'X-Idempotent-Replay': '1' })), 'only a message that really ran is counted: a success, not a failure or a refusal, and not a retry answered from the stored result');
  const none = await lm.capBefore(env, await msg('zz@x.co'), t0);
  await lm.capAfter(env, { ...none, countable: false }, t0);
  check(obj.db.prepare('SELECT COUNT(*) AS n FROM member_usage WHERE member = ?').get(none.member).n === 0, 'a request that was not countable is never counted');
  obj.db.prepare("INSERT INTO member_usage (day, member, messages) VALUES ('2026-08-01', 'old', 9), ('2026-09-20', 'recent', 9)").run();
  await lm.capAfter(env, none, t0);
  check(obj.db.prepare("SELECT COUNT(*) AS n FROM member_usage WHERE member = 'old'").get().n === 0 && obj.db.prepare("SELECT COUNT(*) AS n FROM member_usage WHERE member = 'recent'").get().n === 1, 'daily counts older than 30 days are deleted');

  // ---- it must never stop anyone because it is broken ----------------------------------------------------------------------------------------------------------------------------------------------
  await lm.setPlan(sharedEnv, { name: 'trial', messagesPerMemberPerDay: 1, neuronsPerBusinessPerDay: 1000, mode: 'enforce' });
  const brokenObj = { ...env, OFFICE_DB: { prepare: () => { throw new Error('the object database is broken'); } }, PLAN_CACHE_SECONDS: '0' };
  const brokenCheck = await lm.capBefore(brokenObj, await msg('a@x.co'), t0);
  check(brokenCheck.block === null, 'FAIL-OPEN: when the business\'s own database is broken, nobody is blocked even in enforce mode');
  await lm.setPlan(sharedEnv, { name: 'trial', messagesPerMemberPerDay: 1, neuronsPerBusinessPerDay: 1000, mode: 'enforce' });
  const unreadable = { method: 'POST', headers: new Headers(), get url() { throw new Error('this request cannot even be read'); } };
  let raised = false, outcome = null; try { outcome = await lm.capBefore(env, unreadable, t0); } catch { raised = true; }
  check(raised === false && outcome.block === null && outcome.countable === false, 'FAIL-OPEN, the OUTER safety net: an unexpected error anywhere in the check (here a request whose URL cannot be read) lets the request through instead of failing it');
  const noSecret = await lm.capBefore({ ...env, SESSION_SECRET: undefined }, await msg('a@x.co'), t0);
  check(noSecret.block === null && noSecret.countable === false, 'and when the session cannot even be checked, nobody is blocked');
  let threw = false; try { await lm.capAfter({ ...env, OFFICE_DB: { prepare: () => { throw new Error('boom'); } } }, c1, t0); } catch { threw = true; }
  check(threw === true, 'counting failures are raised to the caller (which swallows them after the response has gone): the pipeline, not this function, decides they cannot reach the person');

  // ---- what the health report shows ---------------------------------------------------------------------------------------------------------------------------------------------------------------
  await lm.setPlan(sharedEnv, { name: 'trial', messagesPerMemberPerDay: 2, neuronsPerBusinessPerDay: 1000, mode: 'warn' });
  const hm = makeDb(); const hmEnv = { ...env, OFFICE_DB: hm.d1 }; hm.db.exec('CREATE TABLE object_meta (key TEXT PRIMARY KEY, value TEXT)');
  for (const who of ['a@x.co', 'a@x.co', 'a@x.co', 'b@x.co']) { const c = await lm.capBefore(hmEnv, await msg(who), t0); await lm.capAfter(hmEnv, c, t0); }
  const usage = await lm.memberUsageToday(hmEnv, t0);
  check(usage.activeMembers === 2 && usage.messages === 4 && usage.topMemberMessages === 3 && usage.membersAtOrOverLimit === 1 && usage.plan.name === 'trial' && !JSON.stringify(usage).includes('@') && !/[0-9a-f]{12}/.test(JSON.stringify(usage)), 'the health report shows how many members used it today, how many messages, the busiest member\'s count and how many are at or over the limit: and identifies nobody');
  const report = await hl.healthReport(hmEnv, t0);
  check(report.limits.activeMembers === 2 && report.limits.membersAtOrOverLimit === 1 && report.limits.plan.mode === 'warn', 'and it is part of the health report');
  check(mg.SKIP_TABLES.has('member_usage'), 'the daily counts are left out of migrations and backups (restoring an old backup must never reset a member\'s day)');

  // ---- the wiring ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const index = fs.readFileSync(path.join(srcDir, 'index.ts'), 'utf8'), authSrc = fs.readFileSync(path.join(srcDir, 'auth.ts'), 'utf8'), objSrc = fs.readFileSync(path.join(srcDir, 'business-object.ts'), 'utf8');
  const iCap = index.indexOf('const cap = await capBefore(env, request);'), iRun = index.indexOf('cap.block ?? (await runGuarded(');
  check(iCap > 0 && iRun > iCap && /if \(cap\.countable && cap\.over && !cap\.block\) response\.headers\.set\("X-Usage-Warning"/.test(index) && /if \(cap\.countable && !cap\.block && isCountable\(response\)\) ctx\.waitUntil\(capAfter\(env, cap\)\.catch\(\(\) => undefined\)\);/.test(index), 'the pipeline checks BEFORE anything else runs (a block is returned in place of the request, so the model is never called), warns in a header, and counts only a countable response, after it has gone, with a failure that cannot reach the person');
  check(/"X-Idempotent-Replay": "1"/.test(authSrc) && /SHARED_DB: this\.env\.OFFICE_DB/.test(objSrc), 'a retry answered from the stored result is marked (so it is not counted twice), and a business\'s object is handed the shared database to read its plan from');
  check(index.includes('url.pathname === "/messages/text"') && index.includes('url.pathname === "/files/audio"') && [...lm.CAP_ROUTES].sort().join() === 'POST /files/audio,POST /messages/text', 'the two routes that use the model are exactly the two that are limited');
}
