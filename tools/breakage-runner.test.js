// The breakage runner (tools/engine-breakage.js): it must never touch the working tree, and it must be able to run only part of the list. TESTS FIRST.
// THE INCIDENT (2026-11-03): the runner edited sources IN PLACE and relied on exit and signal handlers to put them back. A second attempt committed while it ran, so a mutated validator line (the SHA-256 check removed) reached a commit; and a run killed between tool
// calls left tools/restore-proof-judge.py mutated. A SIGKILL cannot run a handler. So the runner now mutates an ISOLATED COPY and never the tree, and this test KILLS it mid-mutation to prove the tree survives.
// THE SECOND PROBLEM: 108 mutations take over 12 minutes, longer than one tool call, so selection is needed: --only <text> (name, suite or file; repeatable), --since <git ref> (mutations whose target file, or whose suite, changed), --list, --keep.
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const kit = require('./engine-kit.js');

module.exports = kit.guard('breakage runner', async ({ check }) => {
  const SELECT = path.join(__dirname, 'breakage-select.js');
  check(fs.existsSync(SELECT), 'the selection module exists');
  if (!fs.existsSync(SELECT)) return;
  const sel = require(SELECT);

  // ---- selection, as a pure function -----------------------------------------------------------------------------------------------------------------------------------------------------------------
  const M = [
    { name: 'money: round down', suite: 'a.test.js', file: 'worker/src/money.ts' },
    { name: 'Router: a header wins', suite: 'b.test.js', file: 'worker/src/routing.ts', also: [{ file: 'worker/src/auth.ts' }] },
    { name: 'ownership: a stray write', suite: 'c.test.js', file: 'worker/src/engine/records.ts' },
  ];
  const ids = (opts, changed) => sel.select(M, { only: [], since: null, ...opts }, changed || []).map((x) => x.index + 1).join(',');
  check(ids({}) === '1,2,3', 'no filter selects every mutation, keeping its original number');
  check(ids({ only: ['router'] }) === '2' && ids({ only: ['ROUTER'] }) === '2', '--only matches the mutation name, ignoring case');
  check(ids({ only: ['b.test.js'] }) === '2', '--only matches the suite');
  check(ids({ only: ['engine/records.ts'] }) === '3', '--only matches the file');
  check(ids({ only: ['money', 'stray'] }) === '1,3', 'several --only are a union');
  check(ids({ only: ['nothing like this'] }) === '', 'a filter that matches nothing selects nothing');
  check(ids({ since: 'HEAD~1' }, ['worker/src/money.ts']) === '1', '--since selects a mutation whose target file changed');
  check(ids({ since: 'HEAD~1' }, ['worker/src/auth.ts']) === '2', '--since also sees the extra files of a compound mutation');
  check(ids({ since: 'HEAD~1' }, ['tools/c.test.js']) === '3', '--since selects the mutations of a suite whose TEST file changed (the tests that must still catch them)');
  check(ids({ since: 'HEAD~1' }, ['README.md', 'docs/x.md']) === '', '--since selects nothing when only unrelated files changed');
  check(ids({ since: 'HEAD~1', only: ['router'] }, ['worker/src/auth.ts']) === '2' && ids({ since: 'HEAD~1', only: ['money'] }, ['worker/src/auth.ts']) === '', '--only and --since together narrow (an intersection)');
  const p = sel.parseArgs(['--only', 'x', '--only', 'y', '--since', 'HEAD~2', '--list', '--keep']);
  check(JSON.stringify(p) === JSON.stringify({ only: ['x', 'y'], since: 'HEAD~2', list: true, keep: true }), 'the arguments are parsed');
  const err = (argv) => { try { sel.parseArgs(argv); return null; } catch (e) { return String(e.message); } };
  check(/unknown option/.test(err(['--bogus'])) && /needs a value/.test(err(['--only'])) && /needs a value/.test(err(['--since', '--list'])), 'an unknown option or a missing value is refused, not ignored');

  // ---- the runner itself: the working tree is NEVER touched -----------------------------------------------------------------------------------------------------------------------------------------
  if (process.env.HARNESS_BACKEND === 'do') return;   // the runner is exercised once (on the default backend); the selection tests above run on both
  const RUNNER = path.join(__dirname, 'engine-breakage.js'), TARGET = path.join(__dirname, '..', 'worker', 'src', 'engine', 'money.ts');
  const NAME = 'round down instead of half up';
  const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  const env = { ...process.env, NODE_PATH: path.join(__dirname, '..', 'worker', 'node_modules') };
  const before = sha(TARGET);

  const listed = spawnSync(process.execPath, ['--no-warnings', RUNNER, '--list', '--only', NAME], { encoding: 'utf8', env, timeout: 60000 });
  check(listed.status === 0 && /1 of \d+ mutations selected/.test(listed.stdout) && /round down instead of half up/.test(listed.stdout) && !/unmutated|CAUGHT/.test(listed.stdout), `--list shows the selection and runs nothing: ${listed.stdout.trim().split('\n').slice(0, 2).join(' | ').slice(0, 120)}`);

  const ran = spawnSync(process.execPath, ['--no-warnings', RUNNER, '--only', NAME], { encoding: 'utf8', env, timeout: 280000 });
  const copy = (/isolated copy: (\S+)/.exec(ran.stdout) || [])[1];
  check(ran.status === 0 && /CAUGHT/.test(ran.stdout) && /all 1 selected mutations caught/.test(ran.stdout) && /1 of \d+ mutations selected/.test(ran.stdout), `a selected mutation is run and caught, and ONLY that one (exit ${ran.status})`);
  check(Boolean(copy) && /never touched/.test(ran.stdout) && sha(TARGET) === before, 'the runner says it works in an isolated copy, and the real file is byte-identical afterwards');
  check(Boolean(copy) && !fs.existsSync(copy), 'and the copy is removed when it finishes');

  // THE INCIDENT, REPRODUCED: kill the runner with SIGKILL while a mutation is applied. The close promise is created AT SPAWN (a listener attached after the child has already exited never fires, which once made this test end silently with exit 0).
  const pristine = fs.readFileSync(TARGET);
  const child = spawn(process.execPath, ['--no-warnings', RUNNER, '--only', NAME], { env });
  const closed = new Promise((resolve) => child.on('close', resolve));
  let out = ''; child.stdout.on('data', (d) => (out += d));
  const copyPath = () => (/isolated copy: (\S+)/.exec(out) || [])[1];
  const copyMutated = () => { const c = copyPath(); if (!c) return false; try { return sha(path.join(c, 'worker', 'src', 'engine', 'money.ts')) !== before; } catch { return false; } };
  let applied = false, realChanged = false;
  for (let i = 0; i < 400 && !applied && !realChanged; i++) { await new Promise((r) => setTimeout(r, 100)); realChanged = sha(TARGET) !== before; applied = copyMutated(); }
  const killedCopy = copyPath();
  child.kill('SIGKILL'); await closed;
  const leftChanged = sha(TARGET) !== before;
  if (realChanged || leftChanged) fs.writeFileSync(TARGET, pristine);   // never leave the real tree mutated, whatever the runner did
  if (killedCopy) fs.rmSync(killedCopy, { recursive: true, force: true });   // the killed runner could not clean its own copy
  check(applied, 'CONTROL: the kill happened while the mutation was applied, and the mutation was in the COPY');
  check(!realChanged && !leftChanged, 'THE INCIDENT: the REAL file was never mutated, and after a SIGKILL in the middle of a mutation it is byte-identical (no handler ran, and none was needed)');
});

if (require.main === module) kit.standalone(module.exports);
