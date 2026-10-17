// The deploy decision (found 2026-10-17: SHIP_CHECKLIST.md item 8 and RUNBOOK.md section 16). The pipeline used to ask "did the Worker change since the PREVIOUS commit?". When the previous commit failed its tests and never deployed, a
// following tests-only push answered "no" and the failed commit's Worker changes were silently never deployed (and a migration in it skipped the staging gate). It now asks PRODUCTION what commit it is running (the deploy stamps it into
// the Worker and /health reports it), and compares with that. Here the lookup script is EXECUTED against every answer production could give, the decision step is EXECUTED against the real histories that matter, and the workflow
// structure is pinned.
module.exports = async function runDeployBaseTests({ check, path, fs }) {
  const { execFileSync, spawnSync } = require('child_process'), os = require('os');
  const root = path.join(__dirname, '..');
  const raw = (f) => fs.readFileSync(path.join(root, '.github', 'workflows', f), 'utf8'), strip = (s) => s.replace(/^\s*#.*$/gm, '');
  const deploy = strip(raw('deploy.yml')), staging = strip(raw('staging.yml'));
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'db-'));
  git(repo, 'init', '-q', '-b', 'main'); git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't');
  fs.mkdirSync(path.join(repo, 'tools'), { recursive: true });
  for (const f of ['migrations-changed.sh', 'deployed-base.sh']) { try { fs.copyFileSync(path.join(__dirname, f), path.join(repo, 'tools', f)); } catch { /* the script under test may not exist yet */ } }
  const commit = (files) => { for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true }); fs.writeFileSync(path.join(repo, f), c); } git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'c'); return git(repo, 'rev-parse', 'HEAD'); };

  // History: c0 is what production runs. c1 changes the Worker AND adds a migration but FAILED its tests, so it was never deployed. c2 is the tests-only fix that follows it.
  const c0 = commit({ 'worker/src/a.ts': 'a', 'worker/migrations/0001_baseline.sql': 'a', 'tools/t.js': 'a' });
  const c1 = commit({ 'worker/src/a.ts': 'b', 'worker/migrations/0002_add_x.sql': 'ALTER TABLE t ADD COLUMN x TEXT;' });
  const c2 = commit({ 'tools/t.js': 'fixed' });
  const c3 = commit({ 'docs/readme.md': 'words' });
  git(repo, 'checkout', '-q', '-b', 'side', c0); const sibling = commit({ 'worker/src/side.ts': 'x' }); git(repo, 'checkout', '-q', 'main');

  // ---- what is production running? (tools/deployed-base.sh), against every answer /health could give ------------------------------------------------------------------------------------------------------------------------
  const script = path.join(__dirname, 'deployed-base.sh');
  const lookup = (body, sha = c3) => { const f = path.join(repo, 'health.json'); if (body === undefined) { try { fs.unlinkSync(f); } catch { /* not there */ } } else fs.writeFileSync(f, typeof body === 'string' ? body : JSON.stringify(body)); const r = spawnSync('bash', [script, sha, 'https://unreachable.invalid'], { cwd: repo, encoding: 'utf8', env: { ...process.env, HEALTH_FILE: f } }); return { out: r.stdout.trim(), code: r.status }; };
  check(fs.existsSync(script), 'tools/deployed-base.sh exists');
  check(lookup({ status: 'ok', service: 'office-api', commit: c0 }).out === c0, 'production says it runs c0 (an ancestor of what is being built): that is the base');
  check(lookup({ status: 'ok', commit: c3 }).out === c3 && lookup({ status: 'ok', commit: c1 }).out === c1, 'production running the commit being built (or any other ancestor) is believed');
  for (const [label, body] of [['no commit field (a Worker deployed before this existed)', { status: 'ok', service: 'office-api' }], ['a null commit', { status: 'ok', commit: null }], ['a number', { commit: 12345 }], ['an object', { commit: { sha: c0 } }], ['a list', { commit: [c0] }], ['not JSON', '<html>502 Bad Gateway</html>'], ['empty', ''], ['JSON that is not an object', '[1,2]'], ['null', 'null']]) { const r = lookup(body); check(r.out === '' && r.code === 0, `nothing is claimed when production answers: ${label}`); }
  check(lookup(undefined).out === '' && lookup(undefined).code === 0, 'nothing is claimed when production cannot be reached at all (no answer)');
  for (const [label, c] of [['an abbreviated sha', c0.slice(0, 12)], ['a branch name', 'main'], ['HEAD', 'HEAD'], ['a revision expression', 'HEAD~1'], ['an option that git would obey', '--upload-pack=touch /tmp/x'], ['upper case', c0.toUpperCase()], ['a sha with a trailing newline', c0 + '\n'], ['a sha with spaces', ' ' + c0], ['41 characters', c0 + '0'], ['39 characters', c0.slice(0, 39)]]) { const r = lookup({ commit: c }); check(r.out === '' && r.code === 0, `only a full 40-character lower-case sha is accepted, never ${label}`); }
  check(lookup({ commit: 'f'.repeat(40) }).out === '' && lookup({ commit: '0'.repeat(40) }).out === '', 'a well-formed sha that is not in this repository is not believed');
  check(lookup({ commit: sibling }).out === '', 'a commit that is NOT an ancestor of the one being built (another branch, a rewritten history) is not believed');
  check(lookup({ commit: c0 }, c0).out === c0 && lookup({ commit: c3 }, c0).out === '', 'and the direction matters: production running something NEWER than what is being built is not believed either');
  check(lookup({ commit: c0, extra: 'x'.repeat(200000) }).out === c0 || lookup({ commit: c0, extra: 'x'.repeat(200000) }).out === '', 'an enormous answer is handled without a crash');

  // ---- the decision step, EXECUTED -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const stepAt = deploy.indexOf('- name: Did the Worker change?');
  const body = deploy.slice(deploy.indexOf('run: |', stepAt) + 7).split('\n'); const lines = []; for (const l of body) { if (l.trim() !== '' && !l.startsWith('          ')) break; if (l.trim() === '' && lines.length && body[body.indexOf(l) + 1] !== undefined && !(body[body.indexOf(l) + 1] || '').startsWith('          ')) break; lines.push(l.replace(/^ {10}/, '')); }
  const stepScript = lines.join('\n');
  const decide = (baseSha, event, sha) => { const out = path.join(repo, 'gh-output'); fs.writeFileSync(out, ''); const r = spawnSync('bash', ['-c', stepScript], { cwd: repo, encoding: 'utf8', env: { ...process.env, BASE: baseSha, BEFORE: baseSha, EVENT: event, GITHUB_SHA: sha, GITHUB_OUTPUT: out } }); const o = Object.fromEntries(fs.readFileSync(out, 'utf8').split('\n').filter(Boolean).map((l) => l.split('='))); return { ...o, status: r.status }; };
  check(/deploy_needed/.test(stepScript) && /migrations_changed/.test(stepScript), 'the decision step could be extracted and run');
  const bug = decide(c0, 'push', c2);
  check(bug.deploy_needed === 'true' && bug.migrations_changed === 'true', 'THE BUG THIS FIXES: production runs c0, c1 (Worker change + a migration) failed and never deployed, and c2 is a tests-only fix. Judged against what production RUNS, the Worker changed and a migration changed: it DEPLOYS and it is GATED');
  const old = decide(c1, 'push', c2);
  check(old.deploy_needed === 'false' && old.migrations_changed === 'false', 'whereas judged against the previous commit (what it used to do) the answer would have been "nothing to deploy, no gate": the silent skip');
  check(decide(c1, 'push', c3).deploy_needed === 'false' && decide(c3, 'push', c3).deploy_needed === 'false', 'when production already runs everything that matters (only tests or documents since), nothing is deployed');
  const docsOnly = decide(c2, 'push', c3); check(docsOnly.deploy_needed === 'false' && docsOnly.migrations_changed === 'false', 'documents-only since what production runs: not deployed, not gated');
  for (const [label, b] of [['empty', ''], ['all zeros', '0'.repeat(40)], ['not in the repository', 'd'.repeat(40)]]) { const r = decide(b, 'push', c3); check(r.deploy_needed === 'true' && r.migrations_changed === 'true', `WHEN IN DOUBT, DEPLOY AND GATE: production's commit is unknown (${label})`); }
  const manual = decide('', 'workflow_dispatch', c3); check(manual.deploy_needed === 'true' && manual.migrations_changed === 'false', 'a manual run always deploys and is never gated (a person asked for exactly that), whatever production says');
  check(bug.status === 0 && docsOnly.status === 0 && manual.status === 0, 'the step itself always succeeds: it decides, it does not fail');

  // ---- how it is wired in --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const iRun = deploy.indexOf('- name: Which commit is production running?'), iChg = deploy.indexOf('- name: Did the Worker change?');
  check(iRun > 0 && iRun < iChg && /id: running/.test(deploy.slice(iRun, iChg)) && /bash tools\/deployed-base\.sh "\$GITHUB_SHA" https:\/\/office\.websitehub\.co\.za/.test(deploy.slice(iRun, iChg)) && /echo "base=\$\(bash tools\/deployed-base\.sh/.test(deploy.slice(iRun, iChg)), 'the pipeline asks production what it runs BEFORE it decides, with the commit being built');
  const chg = deploy.slice(iChg, deploy.indexOf('# The staging gate') > 0 ? deploy.indexOf('# The staging gate') : iChg + 2500).slice(0, deploy.slice(iChg).indexOf('\n  gate:'));
  check(/BASE: \$\{\{ steps\.running\.outputs\.base \}\}/.test(chg) && !/github\.event\.before/.test(deploy) && /bash tools\/migrations-changed\.sh "\$BASE" "\$GITHUB_SHA" "\$EVENT"/.test(chg) && /git diff --name-only "\$BASE" "\$GITHUB_SHA"/.test(chg), 'the decision (and the migration check) compare with that commit, and `github.event.before` is not used anywhere in the pipeline');
  check(/command: deploy --var GIT_SHA:\$\{\{ github\.sha \}\}/.test(deploy), 'the production deploy stamps the commit it deploys into the Worker (--var GIT_SHA)');
  check(/wrangler deploy --config wrangler\.staging\.toml --var GIT_SHA:\$GITHUB_SHA/.test(staging), 'and so does the staging deploy, so the mechanism is proven on real Cloudflare before production relies on it');
  check(/"health_reports_the_running_commit": health\.get\("commit"\) == os\.environ\.get\("GITHUB_SHA"\)/.test(staging) && /su-health\.json/.test(staging), 'the staging rehearsal checks that /health on the real Worker reports exactly the commit it was deployed from');
  const idx = fs.readFileSync(path.join(root, 'worker', 'src', 'index.ts'), 'utf8'), types = fs.readFileSync(path.join(root, 'worker', 'src', 'types.ts'), 'utf8');
  check(/Response\.json\(\{ status: "ok", service: "office-api", commit: env\.GIT_SHA \?\? null \}\)/.test(idx) && /GIT_SHA\?: string;/.test(types), '/health reports the commit the Worker was deployed from (null when none was stamped)');
  const sm = fs.readFileSync(path.join(__dirname, 'smoke-test.sh'), 'utf8');
  check(/status/.test(sm), 'the smoke test still reads /health (which keeps its status field)');
};
