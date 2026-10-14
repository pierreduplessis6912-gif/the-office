// The load test (tools/load-test.py measures, tools/load-judge.py decides, the staging workflow's `load` mode runs them: SHIP_CHECKLIST.md item 12). What is pinned here: the JUDGE (every target, and that it fails
// CLOSED on anything missing), the SAFETY of the script (staging only, a hard ceiling on real sentences), the script's MECHANICS end to end against a local fake server (so a typo cannot hide until the one expensive
// run), and the WORKFLOW wiring. The real numbers come only from a real run on Cloudflare.
const { spawnSync, spawn } = require('child_process');
const http = require('http');
const os = require('os');

module.exports = async function runLoadTests({ check, path, fs }) {
  const tools = __dirname, repo = path.join(tools, '..');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'load-'));
  const judgeFile = path.join(tools, 'load-judge.py'), scriptFile = path.join(tools, 'load-test.py');
  const judge = (data, raw) => { const f = path.join(tmp, 'r.json'); fs.writeFileSync(f, raw !== undefined ? raw : JSON.stringify(data)); const r = spawnSync('python3', [judgeFile, f], { encoding: 'utf8' }); let v = null; try { v = JSON.parse(r.stdout); } catch { /* unreadable */ } return { status: r.status, v }; };
  const ph = (name, c, p95, extra = {}) => ({ name, concurrency: c, seconds: 15, requests: 100, rps: 20, statuses: { 200: 100 }, errors: 0, p50: p95 / 2, p95, p99: p95 * 1.1, max: p95 * 1.2, ok_p95: p95, ...extra });
  const good = () => ({
    seeded: { a: true, b: true },
    phases: [ph('reads', 1, 0.3), ph('reads', 10, 0.5), ph('reads', 50, 1.5), ph('customers_import', 1, 0.8), ph('customers_import', 10, 1.5), ph('invoices_import', 1, 1), ph('invoices_import', 10, 2), ph('mixed', 10, 0.8)],
    isolation: { b_alone: ph('isolation_b_alone', 5, 0.3), b_while_a_is_written_to: ph('b_reads', 5, 0.4), a_writes: ph('a_writes', 25, 3) },
    model_in_flight: { baseline_reads: ph('model_baseline_reads', 5, 0.3), reads_while_sentences_wait: ph('reads_in_flight', 5, 0.5, { requests: 40 }), sentences: ph('sentences', 5, 9, { requests: 5 }) },
    server_side: { health: { requests: { serverErrors: 0 } } },
  });
  const verdict = (mutate) => { const d = good(); mutate(d); return judge(d); };
  const problem = (v, re) => v.v && v.v.ok === false && v.status === 1 && v.v.problems.some((p) => re.test(p));

  // ---- the judge ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const g = judge(good());
  check(g.status === 0 && g.v.ok === true && g.v.problems.length === 0 && g.v.findings.length >= 6, 'judge: a healthy run passes, with its findings listed');
  check(g.v.knees.reads === 50 && g.v.knees.customers_import === null, 'judge: it reports where each load starts to bend (reads at 50 at once here; the writes did not bend in what was tested)');
  check(problem(verdict((d) => { d.phases.find((p) => p.name === 'reads' && p.concurrency === 10).errors = 2; }), /reads at 10 at once: 2 of 100 requests failed/), 'judge: a single failure at 10 at once or fewer is a PROBLEM');
  const high = verdict((d) => { d.phases.find((p) => p.name === 'reads' && p.concurrency === 50).errors = 4; });
  check(high.v.ok === true && high.v.warnings.some((w) => /reads at 50 at once: 4 of 100/.test(w)) && high.v.knees.reads === 50, 'judge: failures above 10 at once are WARNINGS (that is where the test looks for the knee), and the knee is reported');
  check(problem(verdict((d) => { d.phases.find((p) => p.name === 'reads' && p.concurrency === 10).p95 = 2.5; }), /p95 2\.5s is over the 2\.0s target/), 'judge: reads slower than 2 seconds at 10 at once fail');
  check(problem(verdict((d) => { d.phases.find((p) => p.name === 'invoices_import' && p.concurrency === 10).p95 = 6; }), /invoices_import at 10 at once: p95 6s is over the 5\.0s target/), 'judge: writes slower than 5 seconds at 10 at once fail');
  check(problem(verdict((d) => { d.isolation.b_while_a_is_written_to.p95 = 1.5; }), /ISOLATION BROKEN.*0\.3s to 1\.5s/), 'judge: if another business slows while one is written to, ISOLATION IS BROKEN');
  check(verdict((d) => { d.isolation.b_alone.p95 = 0.08; d.isolation.b_while_a_is_written_to.p95 = 0.5; }).v.ok === true, 'judge: a quiet p95 of 80 ms rising to 500 ms is noise, not a broken isolation (the half-second slack)');
  check(problem(verdict((d) => { d.model_in_flight.reads_while_sentences_wait.p95 = 2.0; }), /A MODEL CALL BLOCKS THE BUSINESS.*0\.3s to 2s/), 'judge: reads that stall while sentences wait on the model fail: a model call blocks the business');
  check(problem(verdict((d) => { d.model_in_flight.reads_while_sentences_wait.requests = 2; }), /only 2 reads happened while the sentences waited/), 'judge: too few reads inside the model window to say anything is a problem, not a pass');
  check(problem(verdict((d) => { d.model_in_flight.sentences.errors = 1; d.model_in_flight.sentences.statuses = { 200: 4, 500: 1 }; }), /1 of 5 real sentences failed/), 'judge: a failed real sentence fails the run');
  const noModel = verdict((d) => { d.model_in_flight = null; });
  check(noModel.v.ok === true && noModel.v.warnings.some((w) => /model in flight was not measured/.test(w)), 'judge: no sentences sent is allowed, with a warning that it was not measured');
  check(problem(verdict((d) => { d.model_in_flight = { baseline_reads: null, reads_while_sentences_wait: null, sentences: null }; }), /only partly measured/), 'judge: a half-measured model run fails');
  check(problem(verdict((d) => { d.phases = d.phases.filter((p) => p.name !== 'mixed'); }), /the mixed load was never measured/), 'judge: FAILS CLOSED when a load was never measured');
  check(problem(verdict((d) => { d.phases = d.phases.filter((p) => !(p.name === 'reads' && p.concurrency <= 10)); }), /reads were never measured at 10 or fewer/), 'judge: FAILS CLOSED when reads were only measured above 10 at once (nothing to hold to the target)');
  check(problem(verdict((d) => { delete d.isolation; }), /isolation between businesses was not measured/), 'judge: FAILS CLOSED when isolation was not measured');
  check(problem(verdict((d) => { d.seeded.b = false; }), /could not be given its starting customers/), 'judge: a business that could not be seeded makes the whole run meaningless');
  check(problem(verdict((d) => { d.server_side.health.requests.serverErrors = 3; }), /health report counted 3 server errors/), "judge: the business's own health report counting server errors fails the run even if no client saw one");
  const unreadable = judge(null, 'this is not json');
  check(unreadable.status === 1 && unreadable.v && unreadable.v.ok === false && /no readable result/.test(unreadable.v.problems[0]), 'judge: a result it cannot read is a failure, never a pass');
  const empty = judge({});
  check(empty.status === 1 && empty.v.ok === false && empty.v.problems.length >= 4, 'judge: an empty result fails with every missing piece named');

  // ---- the script's safety ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const refuse = (env) => spawnSync('python3', [scriptFile], { encoding: 'utf8', env: { PATH: process.env.PATH, COOKIE_A: 'a', COOKIE_B: 'b', ...env } });
  const prod = refuse({ LOAD_HOST: 'office.websitehub.co.za' });
  check(prod.status !== 0 && /refusing to load test anything but staging/.test(prod.stderr) && !prod.stdout, 'safety: the script REFUSES the production host (and prints nothing)');
  check(refuse({ LOAD_HOST: 'office-staging.evil.com' }).status !== 0 && refuse({ LOAD_HOST: '' }).status !== 0 && refuse({ LOAD_HOST: 'zululand.websitehub.co.za' }).status !== 0, 'safety: it refuses a look-alike domain, no host at all, and any other business host');
  check(refuse({ LOAD_HOST: 'office.websitehub.co.za', LOAD_LOCAL_PORT: '9999' }).status !== 0 && /works only with LOAD_HOST=127\.0\.0\.1/.test(refuse({ LOAD_HOST: 'office.websitehub.co.za', LOAD_LOCAL_PORT: '9999' }).stderr), 'safety: the local-port switch (for the tests) cannot be used to reach any other host');
  const src = fs.readFileSync(scriptFile, 'utf8');
  check(/SENTENCES = max\(0, min\(int\(os\.environ\.get\("LOAD_SENTENCES", "5"\)\), 8\)\)/.test(src) && !/office\.websitehub\.co\.za/.test(src.replace(/office-staging\.<domain>/g, '')), 'safety: real sentences are capped at 8 in the code, and the production host appears nowhere in it');

  // ---- the script end to end, against a local fake server -------------------------------------------------------------------------------------------------------------------------------------------
  const seen = { cookies: {}, imports: 0, sentences: 0, admin: [] };
  const server = http.createServer((req, res) => {
    let size = 0; req.on('data', (c) => { size += c.length; });
    req.on('end', () => {
      const send = (status, body, delay = 2) => setTimeout(() => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); }, delay);
      if (req.url.startsWith('/debug/timings') || req.url.startsWith('/admin/health')) { seen.admin.push([req.url, req.headers['x-admin-key'], req.headers['x-target-business']]); return send(200, req.url.startsWith('/admin/health') ? { requests: { recent: 10, serverErrors: 0 } } : { routes: [] }); }
      const cookie = req.headers.cookie; if (!cookie) return send(401, { error: 'no session' });
      seen.cookies[cookie] = (seen.cookies[cookie] || 0) + 1;
      if (req.method === 'GET' && req.url === '/customers') return send(200, { items: [{ id: 1, name: 'x' }, { id: 2, name: 'y' }] });
      if (req.method === 'POST' && /csv-import$/.test(req.url)) { seen.imports++; return send(200, { status: 'ok', imported: 3 }, 4); }
      if (req.method === 'POST' && req.url === '/messages/text') { seen.sentences++; return send(200, { pendingActionId: seen.sentences }, 300); }
      return send(404, {});
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const run = await new Promise((resolve) => {
    const child = spawn('python3', [scriptFile], { env: { PATH: process.env.PATH, LOAD_HOST: '127.0.0.1', LOAD_LOCAL_PORT: String(port), COOKIE_A: 'office_session=AAAA', COOKIE_B: 'office_session=BBBB', ADMIN_KEY: 'k', LOAD_SECONDS: '0.4', LOAD_STEPS: '1,3', LOAD_SENTENCES: '50', LOAD_MODEL_SECONDS: '1' } });
    let out = '', err = ''; child.stdout.on('data', (c) => { out += c; }); child.stderr.on('data', (c) => { err += c; });
    child.on('close', (code) => resolve({ code, out, err }));
  });
  server.close();
  let m = null; try { m = JSON.parse(run.out); } catch { /* reported below */ }
  check(run.code === 0 && m !== null, `script: it runs end to end against a fake server and prints readable JSON (exit ${run.code}${run.err ? ', ' + run.err.slice(0, 200) : ''})`);
  if (m) {
    const names = m.phases.map((p) => `${p.name}@${p.concurrency}`).join(',');
    check(names === 'reads@1,reads@3,customers_import@1,customers_import@3,invoices_import@1,invoices_import@3,mixed@3', `script: it measures reads, both imports and a mixed load at each level it was given (${names})`);
    check(m.phases.every((p) => p.requests > 0 && p.errors === 0 && p.p95 !== null && p.statuses['200'] === p.requests), 'script: every phase made requests, none failed, and each has its percentiles');
    check(m.seeded.a === true && m.seeded.b === true && m.customers_before_reads === 2, 'script: both businesses were seeded first and the customer count was read');
    check(m.isolation && m.isolation.b_alone.requests > 0 && m.isolation.b_while_a_is_written_to.requests > 0 && m.isolation.a_writes.requests > 0, 'script: the isolation measurement ran (the second business alone, then while the first is written to)');
    check((seen.cookies['office_session=BBBB'] || 0) > 0 && (seen.cookies['office_session=AAAA'] || 0) > 0, 'script: both businesses\' sessions were used (the second business is read with ITS OWN session)');
    const mf = m.model_in_flight;
    check(mf && mf.sentences.requests === 8 && seen.sentences === 8, 'script: asked for 50 real sentences it sent 8 (the ceiling holds, and the fake server saw exactly 8)');
    check(mf && mf.reads_while_sentences_wait.requests >= 3 && mf.reads_while_sentences_wait.window_seconds > 0.2 && mf.baseline_reads.requests > 0, 'script: reads were timed INSIDE the window in which the sentences waited, and a quiet baseline was taken first');
    check(seen.admin.length === 2 && seen.admin.every((a) => a[1] === 'k' && a[2] === 'staging-co') && m.server_side.health.requests.serverErrors === 0, "script: it asked the business's own timings and health report, with the admin key and the business named");
    const j = judge(m);
    check(j.status === 0 && j.v.ok === true, `script + judge: what the script prints, the judge reads and passes (${j.v ? j.v.problems.join('; ') : 'unreadable'})`);
  }

  // ---- the workflow --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const wf = fs.readFileSync(path.join(repo, '.github', 'workflows', 'staging.yml'), 'utf8');
  check(/options:\n\s+- rehearsal\n\s+- gate\n\s+- gate-drill\n\s+- load\n/.test(wf) && /load_sentences:\n[\s\S]*?default: "5"/.test(wf), 'workflow: `load` is a mode a person can start, with a setting for how many real sentences (default 5)');
  const step = (name) => { const i = wf.indexOf(`      - name: ${name}`); const j = wf.indexOf('\n      - name:', i + 10); return wf.slice(i, j < 0 ? undefined : j); };
  check(/if: env\.MODE == 'gate' \|\| env\.MODE == 'gate-drill'/.test(step('Gate - check that every business object applied the real schema steps')) && !/MODE != 'rehearsal'/.test(wf), 'workflow: the schema gate check runs only in the gate modes (it used to run in every mode but rehearsal, which would have included load)');
  const ld = step('Load test the business objects on Cloudflare (staging only)');
  check(/if: env\.MODE == 'load'/.test(ld) && /LOAD_HOST="\$\{SLUG\}\.websitehub\.co\.za"/.test(ld) && /ADMIN_KEY="\$STAGING_ADMIN_KEY"/.test(ld) && /::add-mask::\$COOKIE_A/.test(ld) && /LOAD_SENTENCES: \$\{\{ github\.event\.inputs\.load_sentences \|\| '5' \}\}/.test(ld) && /continue-on-error: true/.test(ld), 'workflow: the load step runs only in load mode, aims at the staging host, masks the sessions, and passes the sentence setting');
  const vd = step('Load test verdict');
  check(/if: always\(\) && env\.MODE == 'load'/.test(vd) && /load-judge\.py "\$RESULTS\/load\.json" --markdown >> "\$GITHUB_STEP_SUMMARY"/.test(vd) && /exit \$JUDGED/.test(vd), 'workflow: the verdict step always runs, writes the summary, and FAILS THE JOB when a target is missed');
  const rc = step('Record the load test');
  check(/if: always\(\) && env\.MODE == 'load'/.test(rc) && /ops\/load-test-last\.json/.test(rc) && /git add ops\/load-test-last\.json/.test(rc) && /numbers only, no secrets/.test(rc), 'workflow: the result is committed to ops/load-test-last.json (numbers only), with nobody involved');
  const dep = fs.readFileSync(path.join(repo, '.github', 'workflows', 'deploy.yml'), 'utf8');
  check(!/mode: load/.test(dep) && /mode: gate/.test(dep), 'workflow: the production pipeline can never start a load test (it only ever asks for the gate)');
};
