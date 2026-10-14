// Where a business's Durable Object runs (worker/src/location.ts; SHIP_CHECKLIST.md item 13): asked once a day, recorded in the object's metadata, shown in the health report. It is bookkeeping: it must
// parse strictly, ask ONLY a fixed Cloudflare address and send nothing about the business, keep the last good answer when a check fails, never throw, and never be able to stop the hourly job, the backup or the next alarm.
const path = require('path'), fs = require('fs'), os = require('os'), esbuild = require('esbuild');
const { DatabaseSync } = require('node:sqlite');

module.exports = async function runLocationTests(context) {
  // The suite's harness swaps in a stand-in Response; these tests answer with real ones (as the atomic tests do).
  const standIn = global.Response;
  if (global.__RealResponse) global.Response = global.__RealResponse;
  try { await locationTests(context); } finally { global.Response = standIn; }
};

async function locationTests({ check, srcDir }) {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'loc-')), 'm.js');
  esbuild.buildSync({ entryPoints: [path.join(srcDir, 'location.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent' });
  const L = require(out);
  const world = () => {
    const db = new DatabaseSync(':memory:'); db.exec('CREATE TABLE object_meta (key TEXT PRIMARY KEY, value TEXT)');
    const stmt = (q, b = []) => ({ bind: (...a) => stmt(q, a), first: async () => db.prepare(q).get(...b) ?? null, run: async () => { db.prepare(q).run(...b); } });
    return { db, env: { OFFICE_DB: { prepare: (q) => stmt(q) } } };
  };
  const TRACE = (colo, loc) => ['fl=123f45', 'h=www.cloudflare.com', 'ip=203.0.113.9', 'ts=1790000000.123', 'visit_scheme=https', 'uag=workerd', `colo=${colo}`, 'sliver=none', `loc=${loc}`, 'tls=TLSv1.3', 'warp=off'].join('\n');
  const answer = (text, status = 200) => async () => new Response(text, { status });
  const NOW = new Date('2026-10-14T16:00:00Z');

  // ---- the parser: strict -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const ok = L.parseTrace(TRACE('DFW', 'US')), za = L.parseTrace(TRACE('JNB', 'ZA')), crlf = L.parseTrace(TRACE('CPT', 'ZA').replace(/\n/g, '\r\n'));
  check(ok.colo === 'DFW' && ok.country === 'US' && za.colo === 'JNB' && za.country === 'ZA' && crlf.colo === 'CPT' && crlf.country === 'ZA', 'the trace is read for its data centre and country (Dallas / US, Johannesburg / ZA, and with Windows line endings)');
  const junk = [L.parseTrace(''), L.parseTrace('<html>502 Bad Gateway</html>'), L.parseTrace('colo=dfw\nloc=us'), L.parseTrace('colo=DALLAS\nloc=USA'), L.parseTrace('colo=DFW; DROP TABLE x\nloc=<b>'), L.parseTrace(undefined), L.parseTrace(null)];
  check(junk.every((r) => r.colo === null && r.country === null), 'anything that is not a three-letter data centre and a two-letter country is NOT an answer (empty, an error page, lower case, long names, injected text, undefined, null)');
  check(L.parseTrace('colo=JNB').colo === 'JNB' && L.parseTrace('colo=JNB').country === null && L.parseTrace('loc=ZA').colo === null, 'a data centre without a country is still an answer, a country without a data centre is not');

  // ---- asking and recording ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  let w = world(); const seen = [];
  const spy = async (url, init) => { seen.push({ url, init }); return new Response(TRACE('DFW', 'US')); };
  const got = await L.recordLocation(w.env, spy, NOW);
  check(got.colo === 'DFW' && got.country === 'US' && got.error === null && got.checkedAt === NOW.toISOString(), 'a successful check records the data centre, the country and when, with no error');
  check(seen.length === 1 && seen[0].url === 'https://www.cloudflare.com/cdn-cgi/trace' && seen[0].init.method === 'GET' && !seen[0].init.body && !seen[0].init.headers && !!seen[0].init.signal, 'it asks ONE fixed Cloudflare address with a plain GET: no body, no headers (nothing about the business, a member or a session is sent), and a timeout');
  check(JSON.stringify(await L.readLocation(w.env)) === JSON.stringify(got), 'what is recorded reads back identically');

  // ---- failures: recorded, last good kept, never thrown ------------------------------------------------------------------------------------------------------------------------------------------------
  const later = new Date('2026-10-15T16:00:00Z');
  const failures = [['the network fails', async () => { throw new Error('connection refused'); }], ['the trace answers 503', answer('x', 503)], ['the answer is an error page', answer('<html>bad gateway</html>')], ['the request times out', async () => { throw new DOMException('The operation timed out', 'TimeoutError'); }]];
  for (const [label, fn] of failures) {
    const w2 = world(); await L.recordLocation(w2.env, async () => new Response(TRACE('JNB', 'ZA')), NOW);
    let threw = null, after = null; try { after = await L.recordLocation(w2.env, fn, later); } catch (e) { threw = e; }
    check(threw === null && after.colo === 'JNB' && after.country === 'ZA' && typeof after.error === 'string' && after.error.length > 0 && after.checkedAt === later.toISOString(), `${label}: it does not throw, the error and the time are recorded, and the LAST GOOD answer (JNB / ZA) is kept`);
  }
  const fresh = world(); const none = await L.recordLocation(fresh.env, async () => { throw new Error('offline'); }, NOW);
  check(none.colo === null && none.country === null && /offline/.test(none.error), 'with no earlier answer a failed check records the failure and an empty location (it does not invent one)');
  const longError = await L.recordLocation(world().env, async () => { throw new Error('x'.repeat(5000)); }, NOW);
  check(longError.error.length <= 200, 'a very long error is cut to 200 characters');
  const broken = { OFFICE_DB: { prepare: () => { throw new Error('no such table: object_meta'); } } };
  let brokenThrew = null, brokenResult = null; try { brokenResult = await L.recordLocation(broken, async () => new Response(TRACE('DFW', 'US')), NOW); } catch (e) { brokenThrew = e; }
  check(brokenThrew === null && brokenResult.colo === 'DFW', 'if the answer cannot even be saved (no bookkeeping table) it still does not throw and still returns the answer');

  // ---- when it is stale ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const at = (h) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
  check(L.locationIsStale({ colo: null, country: null, checkedAt: null, error: null }, NOW.getTime()) === true, 'never asked: stale');
  check(L.locationIsStale({ colo: 'DFW', country: 'US', checkedAt: at(3), error: null }, NOW.getTime()) === false && L.locationIsStale({ colo: 'DFW', country: 'US', checkedAt: at(23), error: null }, NOW.getTime()) === false, 'a settled answer under a day old is NOT asked again (an object does not move)');
  check(L.locationIsStale({ colo: 'DFW', country: 'US', checkedAt: at(25), error: null }, NOW.getTime()) === true, 'a settled answer over a day old is re-checked');
  check(L.locationIsStale({ colo: null, country: null, checkedAt: at(0.5), error: 'offline' }, NOW.getTime()) === false && L.locationIsStale({ colo: null, country: null, checkedAt: at(1), error: 'offline' }, NOW.getTime()) === true, 'a check that found nothing is retried at the next hourly alarm, not hammered within the hour');
  check(L.locationIsStale({ colo: 'DFW', country: 'US', checkedAt: 'not a date', error: null }, NOW.getTime()) === true, 'an unreadable time counts as stale');
  const mangled = world(); mangled.db.prepare("INSERT INTO object_meta (key, value) VALUES ('location', ?)").run('{not json');
  check(JSON.stringify(await L.readLocation(mangled.env)) === JSON.stringify({ colo: null, country: null, checkedAt: null, error: null }), 'a damaged record reads as "never asked", not as a crash');

  // ---- the first health reading answers straight away; later ones do not ask again ----------------------------------------------------------------------------------------------------------------
  const first = world(); let calls = 0; const counting = async () => { calls++; return new Response(TRACE('JNB', 'ZA')); };
  const e1 = await L.ensureLocation(first.env, counting, NOW), e2 = await L.ensureLocation(first.env, counting, later);
  check(e1.colo === 'JNB' && e2.colo === 'JNB' && calls === 1, 'ensureLocation asks the FIRST time only (so the first health reading shows an answer without waiting for an alarm) and never again while one is on record');
  const failedOnce = world(); let c2 = 0; await L.ensureLocation(failedOnce.env, async () => { c2++; throw new Error('offline'); }, NOW); await L.ensureLocation(failedOnce.env, async () => { c2++; return new Response(TRACE('JNB', 'ZA')); }, later);
  check(c2 === 1, 'a health reading does not retry a failed check on every call: the hourly alarm does that');

  // ---- the wiring --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const bo = fs.readFileSync(path.join(srcDir, 'business-object.ts'), 'utf8'), hl = fs.readFileSync(path.join(srcDir, 'health.ts'), 'utf8');
  const i = bo.indexOf('recordLocation(here)'), tryAt = bo.lastIndexOf('try {', i), catchAt = bo.indexOf('} catch', i), backupAt = bo.indexOf('The daily backup is separate'), finallyAt = bo.indexOf('} finally {', i);
  check(i > 0 && tryAt > bo.indexOf('jobs.consolidate') && catchAt > i && catchAt < backupAt && backupAt < finallyAt && /catch \{\s*\n\s*\/\/ never stops anything/.test(bo.slice(catchAt, catchAt + 80)), 'the alarm asks in its OWN try/catch, after the hourly job and before the backup, so it can never stop the job, the backup or the next alarm (which is set in the finally)');
  check(/locationIsStale\(await readLocation\(here\), Date\.now\(\)\)/.test(bo) && !/atomically\(/.test(bo.slice(tryAt, catchAt)), 'it asks only when the record is stale, and never inside a transaction');
  check(/location: await ensureLocation\(env\)\.catch\(/.test(hl) && /import \{ ensureLocation \} from "\.\/location";/.test(hl), 'the health report shows the location, and a failure to read it cannot fail the report');
}
