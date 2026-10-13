// Per-business model cost metering and the health report (worker/src/timing.ts addUsage, usage.ts, health.ts). The model is the only real cost of running a business here, and until 2026-10-14 what it
// reported using was thrown away. These tests pin: what is captured (tokens, cached tokens, NEURONS, failures), that awkward responses cannot corrupt it, the durable per-day totals and their retention, the
// dollar figure, and the health report's arithmetic (minutes since the job, the backlog, the error rate).
const path = require('path'), fs = require('fs'), os = require('os'), esbuild = require('esbuild');
const { DatabaseSync } = require('node:sqlite');

module.exports = async function runUsageTests(context) {
  const standIn = global.Response;
  if (global.__RealResponse) global.Response = global.__RealResponse;
  try { await usageTests(context); } finally { global.Response = standIn; }
};

async function usageTests({ check, srcDir }) {
  const bundle = (entry) => { const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'us-')), 'm.js'); esbuild.buildSync({ entryPoints: [path.join(srcDir, entry)], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent' }); return require(out); };
  const tm = bundle('timing.ts'), us = bundle('usage.ts'), hl = bundle('health.ts'), mg = bundle('migration.ts'), { DoD1Database } = bundle('storage/do-d1.ts');
  const baseline = fs.readFileSync(path.join(srcDir, '..', 'migrations', '0001_baseline.sql'), 'utf8');
  const plain = (r) => (r ? { ...r } : r);
  const makeDb = (withMeta = true) => {
    const db = new DatabaseSync(':memory:'); db.exec(baseline); if (withMeta) db.exec('CREATE TABLE object_meta (key TEXT PRIMARY KEY, value TEXT)');
    const sql = { exec(query, ...binds) { const s = db.prepare(query); if (/^\s*(select|with|pragma|values)\b/i.test(query) || /\breturning\b/i.test(query)) { const rows = s.all(...binds).map(plain); return { toArray: () => rows, rowsRead: rows.length, rowsWritten: 0 }; } const r = s.run(...binds); return { toArray: () => [], rowsRead: 0, rowsWritten: Number(r.changes) }; } };
    const storage = { transactionSync(fn) { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } } };
    return { db, env: { OFFICE_DB: new DoD1Database(sql, storage) } };
  };
  const reply = (p, c, n, cached) => ({ response: 'ok', usage: { prompt_tokens: p, completion_tokens: c, total_tokens: p + c, prompt_tokens_details: { cached_tokens: cached }, neurons: n } });

  // ---- capturing what the model reports ----------------------------------------------------------------------------------------------------------------------------------------------------
  const answers = [reply(100, 20, 12.5, 60), { shape: [1, 768], data: [[0.1]] }, reply(50, 5, 7.25, 0)];
  const ai = { run: async () => { const a = answers.shift(); if (a === 'throw') throw new Error('model down'); return a; } };
  const t = tm.newTally(), wrapped = tm.instrumentEnv({ AI: ai, OFFICE_DB: {} }, t);
  await wrapped.AI.run('m', {}); await wrapped.AI.run('embed', {}); await wrapped.AI.run('m', {});
  check(t.ai.n === 3 && t.usage.calls === 2 && t.usage.prompt === 150 && t.usage.completion === 25 && t.usage.cached === 60 && t.usage.neurons === 19.75 && t.usage.failures === 0, 'each model call\'s reported usage is captured and summed: tokens in and out, cached tokens and NEURONS (Cloudflare\'s billing unit); an embedding reports none and adds nothing');
  answers.push('throw');
  let threw = ''; try { await wrapped.AI.run('m', {}); } catch (e) { threw = e.message; }
  check(threw === 'model down' && t.usage.failures === 1 && t.ai.n === 4, 'a call that throws is counted as a failure and the error still reaches the caller unchanged');
  answers.push({ usage: { prompt_tokens: 'lots', completion_tokens: -5, neurons: NaN, prompt_tokens_details: { cached_tokens: Infinity } } }, null, undefined, { usage: 'none' });
  const before = JSON.stringify(t.usage);
  for (let i = 0; i < 4; i++) await wrapped.AI.run('m', {});
  const after = t.usage;
  check(after.prompt === 150 && after.completion === 25 && after.cached === 60 && after.neurons === 19.75 && after.calls === 3 && before !== JSON.stringify(after), 'nonsense in a response (a string, a negative, NaN, Infinity, null, no usage) adds NOTHING to the totals: it cannot corrupt them');
  const only = tm.newTally(), dbSeen = { prepare: () => ({ run: async () => ({}) }) };
  const narrow = tm.instrumentEnv({ AI: { run: async () => reply(1, 1, 1, 0) }, OFFICE_DB: dbSeen, CUSTOMER_NOTES: {} }, only, 'ai');
  await narrow.AI.run('m', {}); await narrow.OFFICE_DB.prepare('x').run();
  check(only.ai.n === 1 && only.db.n === 0 && narrow.OFFICE_DB === dbSeen, 'metering wraps ONLY the model binding: the database is the very same object and is not timed');
  check(tm.instrumentEnv({ OFFICE_DB: dbSeen }, tm.newTally(), 'ai').AI === undefined, 'and an absent model binding is left alone, as before');

  // ---- the durable daily totals ------------------------------------------------------------------------------------------------------------------------------------------------------------
  const { db, env } = makeDb();
  const day1 = new Date('2026-10-14T09:00:00Z'), day2 = new Date('2026-10-15T09:00:00Z');
  const tally = (calls, p, c, cached, n, failures = 0) => { const x = tm.newTally(); x.ai.n = calls; x.usage = { calls, failures, prompt: p, completion: c, cached, neurons: n }; return x; };
  await us.recordModelUsage(env, tally(3, 1000, 200, 600, 30.5), day1);
  await us.recordModelUsage(env, tally(2, 500, 50, 0, 10.25, 1), new Date('2026-10-14T20:00:00Z'));
  await us.recordModelUsage(env, tally(1, 10, 1, 0, 2), day2);
  const rows = db.prepare('SELECT * FROM model_usage ORDER BY day').all();
  check(rows.length === 2 && rows[0].day === '2026-10-14' && rows[0].requests === 2 && rows[0].model_calls === 5 && rows[0].failures === 1 && rows[0].prompt_tokens === 1500 && rows[0].completion_tokens === 250 && rows[0].cached_tokens === 600 && rows[0].neurons === 40.75 && rows[1].day === '2026-10-15' && rows[1].requests === 1, 'the totals ACCUMULATE per UTC day (requests, calls, failures, tokens, cached tokens, neurons) and a new day starts its own row');
  const idle = makeDb();
  await us.recordModelUsage(idle.env, tm.newTally(), day1);
  check(!idle.db.prepare("SELECT name FROM sqlite_master WHERE name = 'model_usage'").get(), 'a request that did not use the model writes nothing (it does not even create the table)');
  await us.recordModelUsage(env, tally(1, 1, 1, 0, 1), new Date('2027-02-01T00:00:00Z'));
  check(db.prepare('SELECT COUNT(*) AS n FROM model_usage').get().n === 1 && db.prepare('SELECT day FROM model_usage').get().day === '2027-02-01', 'days older than 90 are deleted');
  check(us.dollars(1000) === 0.011 && us.dollars(0) === 0 && us.dollars(10000) === 0.11 && us.NEURON_PRICE_USD === 0.011 / 1000 && us.FREE_NEURONS_PER_DAY === 10000, 'the dollar figure is Cloudflare\'s price: $0.011 per 1,000 neurons (the 10,000 a day free allowance is shared by the whole account, so a business\'s figure is gross)');
  const sm = await us.usageSummary(makeDb().env, 7, day1);
  check(sm.today.day === '2026-10-14' && sm.today.neurons === 0 && sm.recent.length === 0 && sm.totalEstimatedUsd === 0, 'before the model has ever been used the summary is zeros and does not fail (the table does not exist yet)');
  const filled = makeDb();
  for (const [d, n] of [['2026-10-14', 100], ['2026-10-12', 50], ['2026-10-01', 999]]) { await us.recordModelUsage(filled.env, tally(1, 1000, 100, 0, n), new Date(d + 'T10:00:00Z')); }
  const s7 = await us.usageSummary(filled.env, 7, new Date('2026-10-14T12:00:00Z'));
  check(s7.today.neurons === 100 && s7.today.estimatedUsd === 0.0011 && s7.recent.length === 2 && s7.totalNeurons === 150 && s7.totalEstimatedUsd === 0.0017 && s7.recent[0].day === '2026-10-14', 'the summary covers the last N days only, newest first, with today picked out and the totals and dollars worked out');
  const probe = makeDb(); probe.db.exec('CREATE TABLE model_usage (day TEXT PRIMARY KEY)');
  check(!(await mg.listTables(probe.env)).includes('model_usage') && mg.SKIP_TABLES.has('model_usage'), 'the usage table is left out of migrations and backups (restoring yesterday\'s total must never lower today\'s spend)');

  // ---- the health report ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const now = new Date('2026-10-14T12:00:00Z');
  const H = makeDb(); H.env.BUSINESS_ID = 'zulu-co';
  const fresh = await hl.healthReport(H.env, now);
  check(fresh.business === 'zulu-co' && fresh.hourlyJob.lastRunAt === null && fresh.hourlyJob.lastOk === null && fresh.hourlyJob.minutesSinceLastRun === null && fresh.memoryQueue.pending === 0 && fresh.requests.recent === 0 && fresh.requests.errorRate === 0 && fresh.model.today.neurons === 0, 'a business that has done nothing yet reports nulls and zeros, not errors');
  const put = (k, v) => H.db.prepare('INSERT INTO object_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, v);
  put('last_job_at', '2026-10-14T11:30:00.000Z'); put('last_job_ok', '1'); put('last_job_error', ''); put('last_job_ms', '842'); put('next_alarm_at', '2026-10-14T12:30:00.000Z');
  put('last_backup_success_at', '2026-10-14T06:00:00.000Z'); put('last_backup_ok', '1'); put('last_backup_error', '');
  H.db.prepare("INSERT INTO pending_memory_flush (customer_id, text, created_at) VALUES (1, 'a', '2026-10-14 10:30:00'), (2, 'b', '2026-10-14 11:45:00')").run();
  H.db.exec('CREATE TABLE request_timings (id INTEGER PRIMARY KEY AUTOINCREMENT, status INTEGER)');
  for (const st of [200, 200, 500, 200, 502, 200, 200, 200, 200, 200]) H.db.prepare('INSERT INTO request_timings (status) VALUES (?)').run(st);
  await us.recordModelUsage(H.env, tally(2, 1000, 100, 500, 55), now);
  const rep = await hl.healthReport(H.env, now);
  check(rep.hourlyJob.minutesSinceLastRun === 30 && rep.hourlyJob.lastOk === true && rep.hourlyJob.lastMs === 842 && rep.hourlyJob.nextAlarmAt === '2026-10-14T12:30:00.000Z', 'the hourly job: minutes since it last ran (30), that it succeeded, how long it took, and when it runs next');
  check(rep.backup.newestAgeHours === 6 && rep.backup.lastAttemptOk === true, 'the backup: the age of the newest snapshot in hours (6) and that the last attempt succeeded');
  check(rep.memoryQueue.pending === 2 && rep.memoryQueue.oldestPendingMinutes === 90, 'the memory queue: how many are waiting (2) and how old the oldest is (90 minutes)');
  check(rep.requests.recent === 10 && rep.requests.serverErrors === 2 && rep.requests.errorRate === 0.2, 'requests: how many of the last were server errors (2 of 10: 0.2)');
  check(rep.model.today.neurons === 55 && rep.model.today.estimatedUsd === 0.0006 && rep.model.today.promptTokens === 1000 && rep.model.today.cachedTokens === 500, 'and what the model cost today, in neurons, tokens and dollars');
  put('last_job_ok', '0'); put('last_job_error', 'embedding failed');
  const failed = await hl.healthReport(H.env, now);
  check(failed.hourlyJob.lastOk === false && failed.hourlyJob.lastError === 'embedding failed', 'a FAILED hourly job shows as failed, with its error');
  const notAnObject = await hl.healthReport(makeDb(false).env, now);
  check(notAnObject.business === null && notAnObject.hourlyJob.lastRunAt === null, 'outside a business\'s object (no bookkeeping table) the report still works');

  // ---- guards on the wiring ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const index = fs.readFileSync(path.join(srcDir, 'index.ts'), 'utf8'), debug = fs.readFileSync(path.join(srcDir, 'debug.ts'), 'utf8');
  check(/const meterOn = env\.METER_USAGE !== "0";/.test(index) && /timingOn \? instrumentEnv\(env, tally\) : meterOn \? instrumentEnv\(env, tally, "ai"\) : env/.test(index) && /if \(meterOn && tally\.ai\.n > 0\) \{\s*ctx\.waitUntil\(recordModelUsage\(env, tally\)\.catch\(\(\) => undefined\)\);/.test(index), 'the pipeline meters every request that used the model, through the model binding only, AFTER the response has gone (ctx.waitUntil) and with a failure that cannot reach the person; METER_USAGE=0 switches it off');
  check(/url\.pathname === "\/admin\/health" && request\.method === "GET"/.test(debug) && /healthReport\(env\)/.test(debug), 'the health report is a route');
}
