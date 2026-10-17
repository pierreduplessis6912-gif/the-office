// The staging gate (SHIP_CHECKLIST.md item 8). A push that changes a migration file must first pass a gate on staging: the candidate code, with the real steps, is deployed there and every business object must
// apply them with nothing failed, nothing pending and no rows lost; if it does not, production is not deployed. Here the two scripts the workflows run are EXECUTED (the change detector against throwaway git
// histories, the judge against every pass and fail case) and the workflows' structure is pinned.
module.exports = async function runGateTests({ check, path, fs }) {
  const { execFileSync } = require('child_process'), os = require('os');
  const root = path.join(__dirname, '..');
  const read = (f) => fs.readFileSync(path.join(root, '.github', 'workflows', f), 'utf8').replace(/^\s*#.*$/gm, '');
  const deploy = read('deploy.yml'), staging = read('staging.yml');

  // ---- the change detector, run against real git histories ----------------------------------------------------------------------------------------------------------------------------------
  const script = path.join(__dirname, 'migrations-changed.sh');
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-'));
  git(repo, 'init', '-q'); git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't');
  const commit = (files) => { for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true }); fs.writeFileSync(path.join(repo, f), c); } git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'c'); return git(repo, 'rev-parse', 'HEAD'); };
  const ask = (before, sha, event = 'push') => execFileSync('bash', [script, before, sha, event], { cwd: repo, encoding: 'utf8' }).trim();
  const base = commit({ 'worker/migrations/0001_baseline.sql': 'a', 'worker/src/a.ts': 'a', 'worker/migrations/README.md': 'r' });
  const c1 = commit({ 'worker/migrations/0002_add_x.sql': 'ALTER TABLE t ADD COLUMN x TEXT;' });
  const c2 = commit({ 'worker/src/a.ts': 'b' });
  const c3 = commit({ 'worker/migrations/README.md': 'changed' });
  const c4 = commit({ 'worker/migrations/0001_baseline.sql': 'edited' });
  const c5 = commit({ 'worker/migrations/notes.sql': 'x', 'docs/a.md': 'x' });
  const c6 = commit({ 'worker/src/b.ts': 'x', 'worker/migrations/0003_more.sql': 'y', 'tools/t.js': 'x' });
  check(ask(base, c1) === 'true', 'a push that ADDS a migration file is gated');
  check(ask(c1, c2) === 'false', 'a push that changes only Worker code is not');
  check(ask(c2, c3) === 'false', 'nor one that changes only the migrations README');
  check(ask(c3, c4) === 'true', 'a push that EDITS an existing migration is gated (the most dangerous kind)');
  check(ask(c4, c5) === 'false', 'a file in that folder that is not named like a migration (NNNN_words.sql) is ignored, as the generator ignores it');
  check(ask(c5, c6) === 'true', 'a migration among other changed files is still found');
  check(ask('0000000000000000000000000000000000000000', c1) === 'true' && ask('', c1) === 'true' && ask('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', c1) === 'true', 'WHEN IN DOUBT, GATE: a first push, an empty or an unknown starting commit (a rewritten history) is gated');
  check(ask(base, c1, 'workflow_dispatch') === 'false', 'a manual run is never gated (a person asked for exactly that deploy)');

  // ---- the judge, run against every pass and fail case ------------------------------------------------------------------------------------------------------------------------------------------
  const judge = (files, expected = 3, label = 'gate') => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gj-'));
    for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), typeof body === 'string' ? body : JSON.stringify(body));
    execFileSync('python3', [path.join(__dirname, 'gate-judge.py'), dir, String(expected), label], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return JSON.parse(fs.readFileSync(path.join(dir, label + '.json'), 'utf8'));
  };
  const goodSchema = { latestKnownStep: 3, appliedSteps: 3, pending: [], error: null, unknownApplied: 0 };
  const manifest = (c, i) => ({ tables: [{ name: 'customers', count: c }, { name: 'invoices', count: i }] });
  const scenario = (over = {}) => {
    const f = {};
    for (const b of ['staging-co', 'staging-two']) { f[`gate-health-${b}.json`] = { schema: goodSchema }; f[`schema-before-${b}.json`] = manifest(5, 3); f[`gate-after-${b}.json`] = manifest(5, 3); }
    return { ...f, ...over };
  };
  const good = judge(scenario());
  check(good.ok === true && good.problems.length === 0 && good.businesses['staging-co'].tables_compared === 2, 'a healthy staging passes: the new code is live, nothing failed, nothing pending, no rows lost');
  const bad = [
    ['the object has not picked up the new code', { 'gate-health-staging-co.json': { schema: { ...goodSchema, latestKnownStep: 2 } } }, /never reached the object \(it knows steps up to 2, expected 3\)/],
    ['a step FAILED', { 'gate-health-staging-co.json': { schema: { ...goodSchema, error: { name: '0003_x', message: 'no such table: y' }, pending: ['0003_x'] } } }, /schema step FAILED: 0003_x: no such table: y/],
    ['a step is pending', { 'gate-health-staging-two.json': { schema: { ...goodSchema, pending: ['0002_a', '0003_b'] } } }, /2 step\(s\) not applied: 0002_a, 0003_b/],
    ['rows were lost', { 'gate-after-staging-co.json': manifest(4, 3) }, /rows or tables lost: customers/],
    ['a table disappeared', { 'gate-after-staging-two.json': { tables: [{ name: 'customers', count: 5 }] } }, /rows or tables lost: invoices/],
    ['the health report is unreadable', { 'gate-health-staging-co.json': '<html>502</html>' }, /health report could not be read/],
    ['the health report is missing', { 'gate-health-staging-two.json': '' }, /health report could not be read/],
  ];
  const results = bad.map(([what, patch, re]) => { const v = judge(scenario(patch)); return { what, ok: v.ok === false && v.problems.some((p) => re.test(p)) }; });
  check(results.every((r) => r.ok), `the gate FAILS, naming the business and the reason, for each of: ${bad.map((b) => b[0]).join('; ')}`);
  const one = judge(scenario({ 'gate-after-staging-co.json': manifest(1, 3) }));
  check(one.ok === false && one.businesses['staging-two'].ok === true && one.businesses['staging-co'].ok === false && /^staging-co: /.test(one.problems[0]), 'one bad business fails the whole gate, and the other is reported fine');
  const calm = [
    ['more rows than before (staging grew)', scenario({ 'gate-after-staging-co.json': manifest(9, 8) })],
    ['steps from earlier runs this code does not know (a rolled-back deploy)', scenario({ 'gate-health-staging-co.json': { schema: { ...goodSchema, unknownApplied: 2 } } })],
    ['no manifest from before (the very first run: nothing to compare)', (() => { const s = scenario(); delete s['schema-before-staging-co.json']; delete s['schema-before-staging-two.json']; return s; })()],
  ];
  check(calm.every(([, s]) => judge(s).ok === true), `it does not cry wolf: ${calm.map((c) => c[0]).join('; ')}`);
  const drill = judge(scenario({ 'gate-health-staging-co.json': { schema: { ...goodSchema, latestKnownStep: 990, error: { name: '0990_gate_drill_broken', message: 'syntax error' }, pending: ['0990_gate_drill_broken'] } }, 'gate-health-staging-two.json': { schema: { ...goodSchema, latestKnownStep: 990, error: { name: '0990_gate_drill_broken', message: 'syntax error' }, pending: ['0990_gate_drill_broken'] } } }), 990);
  check(drill.ok === false && drill.problems.every((p) => /gate_drill_broken/.test(p)) && drill.problems.length === 2, 'the drill\'s broken step is caught in BOTH businesses, by name');
  const relabel = (s, from, to) => Object.fromEntries(Object.entries(s).map(([k, v]) => [k.startsWith(from + '-') ? to + k.slice(from.length) : k, v]));
  const recovered = judge(relabel(scenario(), 'gate', 'recovered'), 3, 'recovered'), recoveredBad = judge(relabel(scenario({ 'gate-health-staging-co.json': { schema: { ...goodSchema, error: { name: '0003_x', message: 'm' } } } }), 'gate', 'recovered'), 3, 'recovered');
  check(recovered.ok === true && recoveredBad.ok === false, 'the same judge reads another set of files by label (the drill\'s recovery check) and judges them the same way');

  // ---- the production workflow ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  check(/migrations_changed: \$\{\{ steps\.changes\.outputs\.migrations_changed \}\}/.test(deploy) && /echo "migrations_changed=\$\(bash tools\/migrations-changed\.sh "\$BASE" "\$GITHUB_SHA" "\$EVENT"\)" >> "\$GITHUB_OUTPUT"/.test(deploy), 'the test job decides whether a migration changed by running the script that was tested here, against the commit PRODUCTION RUNS (deploy-base.test.js)');
  check(/gate:\s*\n\s*needs: test\s*\n\s*if: needs\.test\.outputs\.migrations_changed == 'true'\s*\n\s*permissions:\s*\n\s*contents: write\s*\n\s*uses: \.\/\.github\/workflows\/staging\.yml\s*\n\s*with:\s*\n\s*mode: gate\s*\n\s*secrets: inherit/.test(deploy), 'the gate job runs after the tests, only when a migration changed, as the staging workflow in GATE mode');
  check(/deploy:\s*\n\s*needs: \[test, gate\]/.test(deploy) && /needs\.gate\.result == 'success' \|\| needs\.gate\.result == 'skipped'/.test(deploy) && !/needs\.gate\.result != 'failure'/.test(deploy) && /always\(\)/.test(deploy), 'the deploy waits for the gate and runs only if it PASSED or was not needed: a failed or cancelled gate stops it');

  // ---- the staging workflow ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const trigger = staging.slice(staging.indexOf('on:'), staging.indexOf('concurrency:'));
  check(/workflow_call:\s*\n\s*inputs:\s*\n\s*mode:\s*\n\s*type: string\s*\n\s*default: gate/.test(trigger) && /options:\s*\n\s*- rehearsal\s*\n\s*- gate\s*\n\s*- gate-drill/.test(trigger) && !/\bpush:/.test(trigger) && !/\bschedule:/.test(trigger) && !/pull_request/.test(trigger), 'staging can be called by the pipeline (defaulting to the LIGHT gate mode) or started by a person with a choice of three modes, and by nothing else');
  const step = (name) => { const i = staging.indexOf(`      - name: ${name}\n`); const j = staging.indexOf('\n      - ', i + 10); return i < 0 ? '' : staging.slice(i, j < 0 ? undefined : j); };
  const rehearsalOnly = ['Add a temporary schema step (staging only, NEVER committed)', 'Measure the Durable Object on staging', 'Measure what a Durable Object\'s SQLite does about transactions', 'Exercise two businesses end to end', 'Verify the business objects migrated their schema on Cloudflare', 'Back up, damage and restore a business on Cloudflare', 'Probe the memory index on Cloudflare', 'Measure the model, prompt size and prompt caching', 'Send a real sentence through the business object', 'Read the health report and what the model cost (after the real sentence)', 'Rehearse the cost caps on Cloudflare (enforce, then warn)'];
  check(/MODE: \$\{\{ inputs\.mode \|\| 'rehearsal' \}\}/.test(staging) && rehearsalOnly.every((n) => step(n).includes("if: env.MODE == 'rehearsal'")) && /Record what happened\s*\n\s*if: always\(\) && env\.MODE == 'rehearsal'/.test(staging) && /if: env\.MODE == 'rehearsal' && github\.event\.inputs\.owner_email != ''/.test(staging), 'every heavy rehearsal step, the owner step and the rehearsal\'s record run ONLY in rehearsal mode, so the gate is light');
  const common = ['Create the database (safe to re-run)', 'Write staging\'s Worker configuration', 'Create the tables', 'Record the business objects as they are BEFORE the schema step (the previous code is still deployed)', 'Deploy staging\'s Worker', 'Smoke test staging', 'Create two businesses in the shared directory', 'Set up staging\'s schema and indexes'];
  check(common.every((n) => step(n) !== '' && !/\n\s*if: env\.MODE/.test(step(n))), 'the steps the gate needs (provision, record before, deploy, smoke test, the businesses) run in EVERY mode');
  const gateStep = step('Gate - check that every business object applied the real schema steps'), verdict = step('Gate verdict');
  check(/if: env\.MODE == 'gate' \|\| env\.MODE == 'gate-drill'/.test(gateStep) && /python3 tools\/gate-judge\.py "\$RESULTS" "\$EXPECTED" gate/.test(gateStep) && /seq 1 24/.test(gateStep) && /latestKnownStep'\) == \$EXPECTED/.test(gateStep) && staging.indexOf('Gate - check') > staging.indexOf('Set up staging\'s schema and indexes'), 'the gate waits for each object to pick up the candidate code (existing objects can run the previous code for a few minutes after a deploy), then runs the judge that was tested here');
  check(/if: env\.MODE == 'gate'/.test(verdict) && /sys\.exit\(1\)/.test(verdict) && /Production is NOT deployed/.test(verdict) && /did not pass/.test(verdict) && /SMOKE: \$\{\{ steps\.smoke\.outcome \}\}/.test(verdict), 'the gate verdict FAILS the job (exit 1, "Production is NOT deployed") on a failed judge, a failed staging smoke test, or a gate check that did not complete');
  const target = 'git push origin HEAD:"$GITHUB_REF_NAME"', pushes = [...staging.matchAll(/git push origin HEAD:"\$GITHUB_REF_NAME"/g)].length;
  check(pushes === 3 && !/git push origin HEAD:main/.test(staging) && step('Record what happened').includes(target) && step('Drill - record the result and judge it').includes(target) && step('Record the load test').includes(target), 'the gate COMMITS NOTHING: the only pushes are the rehearsal\'s record, the drill\'s record and the load test\'s record (and the gate step itself pushes nothing)');
  const drillRecord = step('Drill - record the result and judge it');
  check(drillRecord.indexOf('git checkout -- worker/src/schema-steps.ts worker/src/baseline-sql.ts') > 0 && drillRecord.indexOf('rm -f worker/migrations/0990_gate_drill_broken.sql') > drillRecord.indexOf('git checkout --') && drillRecord.indexOf('git pull --rebase') > drillRecord.indexOf('rm -f worker/migrations/0990') && /the_gate_caught_the_broken_step_in_every_business/.test(drillRecord) && /after_removing_it_every_business_recovered/.test(drillRecord) && /gate_drill_broken/.test(drillRecord) && /sys\.exit\(0 if .*drill_passed/.test(drillRecord), 'the drill restores the tracked file and removes its broken migration BEFORE it commits and rebases, and passes only if the gate caught the broken step in every business AND they all recovered');
  check(step('Inject a deliberately broken schema step (gate drill only, NEVER committed)').includes("if: env.MODE == 'gate-drill'") && staging.indexOf('Inject a deliberately broken') < staging.indexOf("Deploy staging's Worker") && /THIS IS NOT SQL/.test(step('Inject a deliberately broken schema step (gate drill only, NEVER committed)')) && !fs.readdirSync(path.join(root, 'worker', 'migrations')).some((f) => /gate_drill/.test(f)), 'the drill\'s broken step is injected only in drill mode, before the deploy, and is never in the committed migrations folder');
};
