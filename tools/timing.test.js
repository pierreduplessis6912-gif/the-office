// Tests for the per-request timing breakdown (added 2026-10-04 after Pierre noticed latency): it must only ever OBSERVE.
module.exports = async function runTimingTests({ check, bundleTo, srcDir, path, fs }) {
  const T = bundleTo('timing.ts', 'rm-timing.js');
  const { newTally, instrumentEnv, breakdown, shouldRecordTiming, normalizeTimingPath, recordTiming, timingsSummary, mcpTimingPath } = T;
  const { newDatabase, d1 } = require('./harness.js');
  const workerDir = path.join(srcDir, '..');

  // ---- per-call detail: which prompt, when, and whether it threw; text of a message is never kept ------------------------------------------------
  { const real = Date.now; let clock = 5000; Date.now = () => clock;
    try {
      const calls = [];
      const ai = { run: async (model, inputs) => { calls.push(inputs); clock += 100; if (inputs.messages[1].content === 'boom') throw new Error('model down'); return { response: 'x' }; } };
      const tl = newTally(); const w = instrumentEnv({ AI: ai }, tl);
      await w.AI.run('m', { messages: [{ role: 'system', content: 'Split a tradesperson message into topics.   Extra rules follow here and keep going on and on' }, { role: 'user', content: 'invoice Jenny for 1200 rand' }] });
      let threw = false; try { await w.AI.run('m', { messages: [{ role: 'system', content: 'Extract structured facts' }, { role: 'user', content: 'boom' }] }); } catch { threw = true; }
      check(threw && tl.aiCalls.length === 2 && tl.aiCalls[0].ok === true && tl.aiCalls[1].ok === false && tl.aiCalls[0].s === 0 && tl.aiCalls[0].e === 100 && tl.aiCalls[1].s === 100, 'each model call is kept with its prompt, offsets from the first call, and whether it threw');
      check(tl.aiCalls[0].p.length <= 48 && !JSON.stringify(tl.aiCalls).includes('Jenny') && !JSON.stringify(tl.aiCalls).includes('1200'), 'the label is the fixed start of the system prompt: no message text is kept');
      check(calls.length === 2 && w.AI.run.length >= 0, 'the call itself and its result are untouched');
      const many = newTally(); const w2 = instrumentEnv({ AI: { run: async () => ({}) } }, many); for (let i = 0; i < 30; i++) await w2.AI.run('m', { messages: [{ role: 'system', content: 's' }] });
      check(many.aiCalls.length === 12 && many.ai.n === 30, 'only the first 12 calls are kept in detail, while the count stays exact');
      const noPrompt = newTally(); await instrumentEnv({ AI: { run: async () => ({}) } }, noPrompt).AI.run('m', {}); await instrumentEnv({ AI: { run: async () => ({}) } }, noPrompt).AI.run('m', null);
      check(noPrompt.aiCalls.length === 2 && noPrompt.aiCalls.every((c) => typeof c.p === 'string'), 'a call with no system prompt, or odd input, still records without throwing');
    } finally { Date.now = real; } }

  // ---- the stored detail, on a table made BEFORE the column existed (what production has), and in the summary ---------------------------------------
  { const old = newDatabase(workerDir);
    old.exec("CREATE TABLE request_timings (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL DEFAULT (datetime('now')), method TEXT NOT NULL, path TEXT NOT NULL, status INTEGER NOT NULL, total_ms INTEGER NOT NULL, ai_n INTEGER NOT NULL, ai_ms INTEGER NOT NULL, db_n INTEGER NOT NULL, db_ms INTEGER NOT NULL, kv_n INTEGER NOT NULL, kv_ms INTEGER NOT NULL, vec_n INTEGER NOT NULL, vec_ms INTEGER NOT NULL, r2_n INTEGER NOT NULL, r2_ms INTEGER NOT NULL)");
    old.prepare("INSERT INTO request_timings (method, path, status, total_ms, ai_n, ai_ms, db_n, db_ms, kv_n, kv_ms, vec_n, vec_ms, r2_n, r2_ms) VALUES ('POST', '/messages/text', 200, 900, 1, 300, 5, 900, 0, 0, 0, 0, 0, 0)").run();
    const oenv = { OFFICE_DB: d1(old), RECORD_TIMINGS: '1' };
    const mk = (calls) => { const x = newTally(); x.ai = { n: calls.length, ms: calls.reduce((a, c) => a + (c.e - c.s), 0) }; x.aiCalls = calls; return x; };
    // two calls one after another, then a request where two overlap and one threw and was retried
    await recordTiming(oenv, { method: 'POST', pathname: '/messages/text', status: 200, totalMs: 4000, tally: mk([{ p: 'Split topics', s: 0, e: 900, ok: true }, { p: 'Extract facts', s: 900, e: 2600, ok: true }]) });
    await recordTiming(oenv, { method: 'POST', pathname: '/mcp:tell_the_office', status: 200, totalMs: 5000, tally: mk([{ p: 'Split topics', s: 0, e: 800, ok: true }, { p: 'Extract facts', s: 500, e: 900, ok: false }, { p: 'Extract facts', s: 950, e: 2500, ok: true }]) });
    const sm = await timingsSummary(oenv);
    const route = (name) => sm.byPath.find((r) => r.route === name);
    check(sm.requests === 3 && route('POST /messages/text').n === 2, 'an older table gets the new column added, and its existing row still reads');
    check(route('POST /messages/text').meanAiWallMs === 1300 && route('POST /messages/text').requestsWithOverlappingModelCalls === 0, 'model time on the wall clock is reported, and calls that ran one after another are not called overlapping');
    check(route('POST /mcp:tell_the_office').requestsWithOverlappingModelCalls === 1 && route('POST /mcp:tell_the_office').requestsWithAFailedModelCall === 1, 'overlapping calls and a failed call are counted per route');
    const sp = sm.byPrompt.find((r) => r.prompt === 'Extract facts');
    check(sp && sp.calls === 3 && sp.failures === 1 && sp.maxMs === 1700, 'per prompt: how many calls, how many threw, the slowest');
    check(sm.slowest.some((r) => Array.isArray(r.modelCalls)), 'the slowest requests carry their model calls');
    const fresh = newDatabase(workerDir); const fenv = { OFFICE_DB: d1(fresh), RECORD_TIMINGS: '1' };
    await recordTiming(fenv, { method: 'POST', pathname: '/messages/text', status: 200, totalMs: 100, tally: mk([{ p: 'Split topics', s: 0, e: 50, ok: true }]) });
    check(fresh.prepare("SELECT ai_calls FROM request_timings").get().ai_calls.includes('Split topics') && !fresh.prepare("SELECT ai_calls FROM request_timings").get().ai_calls.includes('invoice'), 'a new table has the column and stores the detail as plain data');
  }

  // ---- the connector's calls are told apart by tool name, and by nothing else --------------------------------------------------------
  check(mcpTimingPath('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_aged_debtors","arguments":{}}}') === '/mcp:get_aged_debtors', 'a tool call is labelled with the tool name');
  check(mcpTimingPath('{"method":"tools/call","params":{"name":"tell_the_office","arguments":{"text":"invoice Jenny for 1200"}}}') === '/mcp:tell_the_office' && !mcpTimingPath('{"method":"tools/call","params":{"name":"tell_the_office","arguments":{"text":"invoice Jenny for 1200"}}}').includes('Jenny'), 'the label carries the name only, never an argument');
  check(mcpTimingPath('{"method":"tools/list"}') === '/mcp' && mcpTimingPath('not json') === '/mcp' && mcpTimingPath('') === '/mcp' && mcpTimingPath(null) === '/mcp' && mcpTimingPath(undefined) === '/mcp', 'any other method, a malformed body, or no body stays /mcp');
  check(mcpTimingPath('{"method":"tools/call","params":{"name":"../../etc or <script>"}}') === '/mcp' && mcpTimingPath('{"method":"tools/call","params":{"name":"' + 'a'.repeat(41) + '"}}') === '/mcp' && mcpTimingPath('{"method":"tools/call","params":{"name":5}}') === '/mcp', 'an unusual, overlong or non-text name is not used as a label');

  // ---- the wrapper, against a clock the test controls ---------------------------------------------------------------------------
  const realNow = Date.now; let now = 1000; Date.now = () => now;
  try {
    const out = { x: 1 };
    const boom = new Error('database went away');
    const stmt = { first: async () => { now += 7; return out; }, all: async () => { now += 9; return { results: [] }; }, run: async () => { now += 5; return { success: true }; }, fails: async () => { now += 3; throw boom; } };
    stmt.bind = () => stmt;
    const env = {
      ADMIN_KEY: 'k', RECORD_TIMINGS: '1',
      OFFICE_DB: { label: 'db', prepare: () => stmt },
      AI: { run: async () => { now += 300; return { response: 'hi' }; } },
      CUSTOMER_NOTES: { get: async () => { now += 20; return 'v'; } },
      MEMORY: { query: async () => { now += 40; return {}; } },
      OFFICE_VAULT: { get: async () => { now += 11; return null; } },
    };
    const tally = newTally(); const e2 = instrumentEnv(env, tally);
    check(e2.ADMIN_KEY === 'k' && e2.RECORD_TIMINGS === '1' && e2.OFFICE_DB.label === 'db', 'the timed environment keeps every other setting, and non-call properties pass straight through');
    e2.OFFICE_DB.prepare('SELECT 1').bind(1);
    check(tally.db.n === 0, 'preparing and binding a statement does no work and is not counted');
    const r1 = await e2.OFFICE_DB.prepare('SELECT 1').bind(1).first();
    check(r1 === out, 'it returns exactly what the call returned (the same object, not a copy)');
    check(tally.db.n === 1 && tally.db.ms === 7, 'a database call is counted and timed (7 ms)');
    await e2.OFFICE_DB.prepare('x').all(); await e2.OFFICE_DB.prepare('x').run();
    check(tally.db.n === 3 && tally.db.ms === 7 + 9 + 5, 'every kind of database call is counted and the times add up');
    let caught = null; try { await e2.OFFICE_DB.prepare('x').fails(); } catch (e) { caught = e; }
    check(caught === boom && tally.db.n === 4 && tally.db.ms === 7 + 9 + 5 + 3, 'a failing call is still counted and timed, and rethrows the very same error');
    await e2.AI.run('m', {}); await e2.CUSTOMER_NOTES.get('k'); await e2.MEMORY.query([]); await e2.OFFICE_VAULT.get('k');
    check(tally.ai.n === 1 && tally.ai.ms === 300 && tally.kv.n === 1 && tally.kv.ms === 20 && tally.vec.n === 1 && tally.vec.ms === 40 && tally.r2.n === 1 && tally.r2.ms === 11, 'the model, notes store, memory search and file storage are each counted and timed on their own');
    // a missing binding must be left alone, not crash every request (found by the first end-to-end run of a business object)
    const bare = instrumentEnv({ ADMIN_KEY: 'k', OFFICE_DB: env.OFFICE_DB }, newTally());
    check(bare.AI === undefined && bare.MEMORY === undefined && bare.CUSTOMER_NOTES === undefined && bare.OFFICE_VAULT === undefined && typeof bare.OFFICE_DB.prepare === 'function' && bare.ADMIN_KEY === 'k', 'a binding that is not there (no model, no memory index) is left as it is, instead of crashing every request');
    const before = JSON.stringify(tally); await env.OFFICE_DB.prepare('x').first(); await env.AI.run('m', {});
    check(JSON.stringify(tally) === before && env.OFFICE_DB !== e2.OFFICE_DB, 'the original environment is untouched: calling it directly is not counted');
    const b = breakdown(tally);
    check(b.aiCalls === 1 && b.aiMs === 300 && b.dbCalls === 4 && b.dbMs === 24 && b.kvMs === 20 && b.vecMs === 40 && b.r2Ms === 11, 'the breakdown reports calls and milliseconds for each kind, under flat names for the log line');
  } finally { Date.now = realNow; }

  // ---- which requests are kept, and under what name -----------------------------------------------------------------------------
  check(shouldRecordTiming('POST', '/messages/text') && shouldRecordTiming('POST', '/actions/12/confirm') && shouldRecordTiming('DELETE', '/x') && shouldRecordTiming('PATCH', '/x') && shouldRecordTiming('PUT', '/x'), 'requests that change something are kept');
  check(!shouldRecordTiming('GET', '/debug/suppliers-list') && !shouldRecordTiming('OPTIONS', '/messages/text') && !shouldRecordTiming('HEAD', '/x'), 'the app\'s constant reading is never kept (it would add a write to every poll)');
  check(!shouldRecordTiming('POST', '/debug/timings') && !shouldRecordTiming('GET', '/debug/timings'), 'the timing route never records itself');
  check(normalizeTimingPath('/actions/123/confirm') === '/actions/:id/confirm' && normalizeTimingPath('/customers/5') === '/customers/:id' && normalizeTimingPath('/messages/text') === '/messages/text' && normalizeTimingPath('/a/12b/c') === '/a/12b/c', 'ids are folded out of the route so the same route is one row group');

  // ---- recording and the rolling limit ------------------------------------------------------------------------------------------
  const db = newDatabase(workerDir); const denv = { OFFICE_DB: d1(db), RECORD_TIMINGS: '1' };
  const tl = (aiN, aiMs, dbN, dbMs) => { const t = newTally(); t.ai = { n: aiN, ms: aiMs }; t.db = { n: dbN, ms: dbMs }; return t; };
  await recordTiming(denv, { method: 'POST', pathname: '/actions/12/confirm', status: 200, totalMs: 400, tally: tl(0, 0, 9, 180) }, 3);
  const first = db.prepare('SELECT * FROM request_timings').all();
  check(first.length === 1 && first[0].path === '/actions/:id/confirm' && first[0].total_ms === 400 && first[0].db_n === 9 && first[0].db_ms === 180 && first[0].method === 'POST', 'a request is recorded with its route (ids folded out), status, total and per-kind counts and times');
  for (let i = 2; i <= 5; i++) await recordTiming(denv, { method: 'POST', pathname: '/messages/text', status: 200, totalMs: i * 100, tally: tl(1, i * 60, 8, i * 10) }, 3);
  const kept = db.prepare('SELECT total_ms FROM request_timings ORDER BY id').all().map((r) => r.total_ms);
  check(kept.length === 3 && kept[0] === 300 && kept[2] === 500, 'only the most recent are kept (here 3 of 5), so the history can never grow without limit');

  // ---- the summary --------------------------------------------------------------------------------------------------------------
  const db2 = newDatabase(workerDir); const env2 = { OFFICE_DB: d1(db2), RECORD_TIMINGS: '1' };
  const empty = await timingsSummary({ OFFICE_DB: d1(newDatabase(workerDir)) });
  check(empty.requests === 0 && empty.byPath.length === 0 && empty.enabled === false, 'with nothing recorded (no table yet) the summary is empty, and says timing is not switched on');
  check(db2.prepare("SELECT name FROM sqlite_master WHERE name = 'request_timings'").all().length === 0, 'and reading a summary does not create the table');
  for (let i = 1; i <= 10; i++) await recordTiming(env2, { method: 'POST', pathname: '/messages/text', status: 200, totalMs: i * 100, tally: tl(1, i * 50, 8, i * 10) });
  await recordTiming(env2, { method: 'POST', pathname: '/actions/7/confirm', status: 200, totalMs: 120, tally: tl(0, 0, 6, 60) });
  const s = await timingsSummary(env2);
  const msg = s.byPath.find((r) => r.route === 'POST /messages/text');
  check(s.enabled === true && s.requests === 11 && s.byPath.length === 2, 'the summary counts the requests and groups them by route');
  check(msg.n === 10 && msg.p50Ms === 500 && msg.p95Ms === 1000, 'it reports the median and the 95th percentile (100 to 1000 ms: 500 and 1000)');
  check(msg.meanAiMs === 275 && msg.meanAiCalls === 1 && msg.meanDbMs === 55 && msg.meanDbCalls === 8, 'and how much of the time went to the model and to the database, with how many calls');
  check(s.byPath[0].route === 'POST /messages/text', 'routes are listed slowest first');
  check(s.slowest.length === 10 && s.slowest[0].totalMs === 1000 && s.slowest[0].aiMs === 500 && s.slowest[9].totalMs <= s.slowest[0].totalMs, 'the slowest requests are listed with their breakdown, slowest first');

  // ---- it can only observe: the Worker's front door ------------------------------------------------------------------------------
  const indexSrc = fs.readFileSync(path.join(srcDir, 'index.ts'), 'utf8');
  const timingSrc = fs.readFileSync(path.join(srcDir, 'timing.ts'), 'utf8');
  check(/const timingOn = env\.RECORD_TIMINGS === "1";/.test(indexSrc), 'timing must be off unless RECORD_TIMINGS is "1", so the tests and every other environment run exactly as before');
  check(/handleRequest\(request, timingOn \? instrumentEnv\(env, tally\) : meterOn \? instrumentEnv\(env, tally, \"ai\"\) : env, ctx, requestId\)/.test(indexSrc), 'the request is handled with the FULLY timed environment only when timing is on; otherwise only the model binding is wrapped (usage metering), and with metering off nothing is');
  check(/ctx\.waitUntil\(recordTiming\(env,/.test(indexSrc) && !/await recordTiming\(/.test(indexSrc), 'recording must happen after the response has gone (waitUntil) and never be awaited, so it cannot slow a request');
  check(indexSrc.indexOf('recordTiming(env,') > indexSrc.indexOf('handleRequest(request, timingOn'), 'and only after the request has been handled');
  check(/recordTiming\(env, \{/.test(indexSrc) && !/recordTiming\(timedEnv|recordTiming\(instrumentEnv/.test(indexSrc), 'recording must use the ORIGINAL environment, so it does not time itself');
  check(!/^import .* from "\.\/(?!types")/m.test(timingSrc) && !/\bctx\b|waitUntil/.test(timingSrc.replace(/\/\/.*$/gm, '')), 'timing.ts must import nothing but types and never run anything in the background itself');
  check(!/RECORD_TIMINGS/.test(fs.readFileSync(path.join(__dirname, 'harness.js'), 'utf8')), 'the test harness must never switch timing on (the recordings must run exactly as before)');
  const norm = (x) => x.replace(/\s+/g, ' ').trim();
  const codeDdl = timingSrc.match(/"(CREATE TABLE IF NOT EXISTS request_timings [^"]*)"/);
  const seedDdl = fs.readFileSync(path.join(__dirname, 'cases', 'actions.js'), 'utf8').match(/"(CREATE TABLE IF NOT EXISTS request_timings [^"]*)"/);
  check(Boolean(codeDdl) && Boolean(seedDdl) && norm(codeDdl[1]) === norm(seedDdl[1]), 'the table the recorded cases create must be exactly the table the code creates');
  const toml = path.join(workerDir, 'wrangler.toml');
  if (fs.existsSync(toml)) check(/^RECORD_TIMINGS = "1"/m.test(fs.readFileSync(toml, 'utf8')), 'timing must be switched on in wrangler.toml for production');
  const debugSrc = fs.readFileSync(path.join(srcDir, 'debug.ts'), 'utf8');
  check(/url\.pathname === "\/debug\/timings" && request\.method === "GET"/.test(debugSrc) && !/"\/debug\/timings"/.test(fs.readFileSync(path.join(srcDir, 'auth.ts'), 'utf8')), '/debug/timings must exist and must not be one of the app\'s own routes (so it needs the admin key)');
};
