// The real-object RE-PROOF of the restore-verification fix (tools/restore-proof-judge.py, run by the `restore-proof` mode of .github/workflows/staging.yml). TESTS FIRST.
// THE QUESTION: on 2026-11-02 the staging rehearsal (run 41445346938) showed that restoring an OLDER snapshot onto a table that a later migration had given a new column reported "table customers: same row count (101) but the contents differ" and ok:false, because the
// restore hashed every LIVE column. The fix hashes the snapshot's own columns and is proven on the harness with controls, but never on a real Durable Object. This is that proof: snapshot staging-two BEFORE a deploy, let the deploy add a column to customers on the
// real object, restore the older snapshot, and require that it verifies clean, that the column is still there, and that the engine data comes back exactly.
// IT ALSO ANSWERS A DEPLOYMENT QUESTION: the snapshot was written by the PREVIOUS code and is read by the NEW manifest validator, and staging holds up to 14 real snapshots per business from older code. A validator that rejects a real, good manifest would make recovery worse, so
// every existing snapshot of each staging business must validate (unreadable: 0).
// WHAT THE TESTS PROVE: the judge cannot say "proven" when the run was vacuous (the column was never added), when the restore failed or reported differences (including the original bug's exact message), when data or the column was lost, when the engine is not back exactly,
// or when any existing snapshot does not validate. They cannot prove anything about the real platform: only the run can.
const fs = require('fs'), os = require('os'), path = require('path'), { spawnSync } = require('child_process');
const kit = require('./engine-kit.js');

module.exports = kit.guard('restore proof (judge and workflow)', async ({ check }) => {
  const JUDGE = path.join(__dirname, 'restore-proof-judge.py'), WF = path.join(__dirname, '..', '.github', 'workflows', 'staging.yml'), DEPLOY = path.join(__dirname, '..', '.github', 'workflows', 'deploy.yml');
  check(fs.existsSync(JUDGE), 'the judge script exists');
  if (!fs.existsSync(JUDGE)) return;
  const PROBE = 'probe_4321', COMMIT = 'abc1234def5678abc1234def5678abc1234def56';
  const cols = (...extra) => [{ name: 'id' }, { name: 'name' }, ...extra.map((name) => ({ name }))];
  const engineStatus = (over = {}) => ({ mode: 'engine', rows: 30, tables: { eng_party: 2, eng_document: 2 }, hashes: { eng_party: 'h1', eng_document: 'h2' }, integrity: { ok: true, problems: [], warnings: [] }, ...over });
  const good = () => ({
    'rp-pre-snapshot.json': { snapshot: '20261102T230000Z' },
    'rp-health-commit.json': { ok: true, commit: COMMIT.slice(0, 7) },
    'rp-manifest-before.json': { tables: [{ name: 'customers', count: 101, columns: cols(PROBE) }, { name: 'eng_party', count: 2, columns: cols() }], sequences: [] },
    'rp-restore.json': { ok: true, snapshot: '20261102T230000Z', safetySnapshot: '20261102T230500Z-pre-restore', tablesRestored: 66, rowsRestored: 430, differences: [] },
    'rp-restore-code.txt': '200',
    'rp-manifest-after.json': { tables: [{ name: 'customers', count: 101, columns: cols(PROBE) }, { name: 'eng_party', count: 2, columns: cols() }], sequences: [] },
    'rp-health-final.json': { schema: { pending: [], error: null } },
    'rp-engine-before.json': engineStatus(), 'rp-engine-after.json': engineStatus(),
    'rp-backup-status-staging-two.json': { snapshots: 14, complete: 14, unreadable: 0 }, 'rp-backup-list-staging-two.json': { snapshots: [{ name: '20261102T123131Z', complete: true }] },
    'rp-backup-status-staging-co.json': { snapshots: 9, complete: 9, unreadable: 0 }, 'rp-backup-list-staging-co.json': { snapshots: [{ name: '20261030T030000Z', complete: true }] },
    'rp-calls.txt': 'pre-snapshot curl_exit=0 http=200\nrestore curl_exit=0 http=200\nmanifest-before curl_exit=0 http=200\n',   // what the workflow's own calls did: the first thing to read when a run does not prove
  });
  const run = (mutate) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-')); const files = good(); if (mutate) mutate(files);
    for (const [name, v] of Object.entries(files)) if (v !== undefined) fs.writeFileSync(path.join(dir, name), typeof v === 'string' ? v : JSON.stringify(v));
    const r = spawnSync('python3', [JUDGE, dir, PROBE, COMMIT], { encoding: 'utf8' });
    let rec = null; try { rec = JSON.parse(fs.readFileSync(path.join(dir, 'restore-proof.json'), 'utf8')); } catch { /* none written */ }
    return { code: r.status, rec, out: r.stdout, err: r.stderr };
  };
  const fails = (label, mutate, ...keys) => { const r = run(mutate); check(r.rec && r.code !== 0 && r.rec.all_ok === false && keys.every((k) => r.rec[k] === false) && keys.length === r.rec.failed.filter((k) => keys.includes(k)).length, `${label} -> not proven: ${keys.join(', ')} false (failed: ${r.rec ? r.rec.failed.join(', ') : 'no record: ' + r.err.slice(0, 80)})`); return r; };

  const g = run();
  check(g.code === 0 && g.rec && g.rec.all_ok === true && g.rec.failed.length === 0, `CONTROL: a complete, correct run is proven (exit ${g.code}, failed: ${g.rec ? g.rec.failed.join(',') || 'none' : 'no record'})`);
  check(g.rec && g.rec.details && g.rec.details.pre_snapshot === '20261102T230000Z' && g.rec.details.restore && g.rec.details.restore.rowsRestored === 430 && Object.keys(g.rec.details.snapshots_validated).sort().join() === 'staging-co,staging-two', 'and it records what it saw: the snapshot, the restore report, and the real snapshots validated per business');

  fails('no snapshot was taken before the deploy', (f) => { f['rp-pre-snapshot.json'] = {}; }, 'a_snapshot_was_taken_before_the_deploy');
  fails('staging is running another commit', (f) => { f['rp-health-commit.json'] = { commit: 'zzz9999' }; }, 'the_deployed_commit_is_the_one_under_test');
  const vac = fails('VACUOUS: the deploy never added the column to the real object, so the scenario was not exercised', (f) => { f['rp-manifest-before.json'].tables[0].columns = cols(); }, 'the_probe_column_is_on_the_real_object_before_the_restore');
  check(vac.rec && /vacuous|precondition/i.test(JSON.stringify(vac.rec.details)), 'and the record says WHY: the precondition was not met, so the run proves nothing');
  fails('the restore refuses the real manifest the previous code wrote', (f) => { f['rp-restore.json'] = { error: 'the manifest of snapshot 20261102T230000Z cannot be trusted (tables is not an array); nothing was changed' }; f['rp-restore-code.txt'] = '400'; }, 'the_validator_accepted_the_manifest_the_previous_code_wrote', 'the_restore_returned_200_and_ok');
  fails('THE ORIGINAL BUG: the restore returns 200 but reports differences (the exact message of 2026-11-02)', (f) => { f['rp-restore.json'].ok = false; f['rp-restore.json'].differences = ['table customers: same row count (101) but the contents differ']; }, 'the_restore_returned_200_and_ok', 'the_restore_verified_clean');
  fails('the restore fails outright', (f) => { f['rp-restore.json'] = { error: 'boom' }; f['rp-restore-code.txt'] = '500'; }, 'the_restore_returned_200_and_ok', 'the_restore_verified_clean', 'customers_rows_are_unchanged');
  fails('a customer row count changed', (f) => { f['rp-manifest-after.json'].tables[0].count = 100; }, 'customers_rows_are_unchanged');
  fails('the restore restored no rows', (f) => { f['rp-restore.json'].rowsRestored = 0; }, 'customers_rows_are_unchanged');
  fails('the added column is gone after the restore', (f) => { f['rp-manifest-after.json'].tables[0].columns = cols(); }, 'the_probe_column_is_still_there_after_the_restore');
  fails('a schema step is still pending after the retry', (f) => { f['rp-health-final.json'] = { schema: { pending: ['1101_staging_probe'], error: null } }; }, 'nothing_is_pending_after_the_retry');
  fails('a schema step failed', (f) => { f['rp-health-final.json'] = { schema: { pending: [], error: 'duplicate column name' } }; }, 'nothing_is_pending_after_the_retry');
  fails('the engine data is not back exactly', (f) => { f['rp-engine-after.json'].hashes = { eng_party: 'DIFFERENT', eng_document: 'h2' }; }, 'the_engine_is_back_exactly_and_verifies_clean');
  fails('the engine verifier reports a problem after the restore', (f) => { f['rp-engine-after.json'].integrity = { ok: false, problems: [{ code: 'event_without_fact' }] }; }, 'the_engine_is_back_exactly_and_verifies_clean');
  const u = fails('a real existing snapshot does not validate (the validator is stricter than the real data)', (f) => { f['rp-backup-status-staging-two.json'] = { snapshots: 14, complete: 13, unreadable: 1 }; f['rp-backup-list-staging-two.json'] = { snapshots: [{ name: '20261014T030000Z', complete: false, unreadable: 'tables[0].columns is not an array' }] }; }, 'every_existing_snapshot_of_staging-two_validates');
  check(u.rec && JSON.stringify(u.rec.details.unreadable_snapshots).includes('20261014T030000Z') && JSON.stringify(u.rec.details.unreadable_snapshots).includes('columns is not an array'), 'and the record names the snapshot and the reason, so it can be investigated before it is called corruption or a validator defect');
  fails('the status has no unreadable count at all (the old code is what is running)', (f) => { f['rp-backup-status-staging-two.json'] = { snapshots: 14, complete: 14 }; }, 'every_existing_snapshot_of_staging-two_validates');
  fails('the second staging business has an unreadable snapshot', (f) => { f['rp-backup-status-staging-co.json'] = { snapshots: 9, complete: 8, unreadable: 1 }; }, 'every_existing_snapshot_of_staging-co_validates');
  fails('a call of the run itself failed (curl exit 28, a timeout)', (f) => { f['rp-calls.txt'] += 'restore curl_exit=28 http=000\n'; }, 'the_calls_all_completed');
  fails('the run recorded no calls at all (the workflow did not run its steps)', (f) => { f['rp-calls.txt'] = undefined; }, 'the_calls_all_completed');
  const nj = run((f) => { f['rp-pre-snapshot.json'] = '<html>error code: 1101</html>'; });
  check(nj.rec && nj.rec.a_snapshot_was_taken_before_the_deploy === false && JSON.stringify(nj.rec.details).includes('error code: 1101'), 'when the pre-deploy snapshot response is not JSON, the record says so and keeps the start of what came back, so the cause can be read without the raw log');
  check(nj.rec && Array.isArray(nj.rec.details.calls) && nj.rec.details.calls.length >= 3, 'and the record carries the calls the run made, with their curl and HTTP status');
  fails('the backup list for staging-two was never read', (f) => { f['rp-backup-status-staging-two.json'] = undefined; f['rp-backup-list-staging-two.json'] = undefined; }, 'the_backup_lists_of_staging_two_were_read');
  const empty = spawnSync('python3', [JUDGE, fs.mkdtempSync(path.join(os.tmpdir(), 'rp-empty-')), PROBE, COMMIT], { encoding: 'utf8' });
  check(empty.status !== 0 && !/Traceback/.test(empty.stderr), 'a run that produced no results at all is not proven and does not crash the judge');

  // ---- the workflow --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const wf = fs.readFileSync(WF, 'utf8');
  const step = (re) => (wf.match(new RegExp('      - name: ' + re + '[\\s\\S]*?(?=\\n      - name: |\\s*$)')) || [''])[0];
  const p1 = step('Restore proof, part 1'), p2 = step('Restore proof, part 2'), tmp = step('Add a temporary schema step');
  check(/options:[\s\S]*?- restore-proof/.test(wf.slice(wf.indexOf('workflow_dispatch:'), wf.indexOf('concurrency:'))), 'restore-proof is a choice of the manual dispatch');
  check(p1.length > 200 && /if: env\.MODE == 'restore-proof'/.test(p1) && /admin\/backup\/run/.test(p1) && /staging-two/.test(p1) && wf.indexOf('Restore proof, part 1') < wf.indexOf("- name: Deploy staging's Worker"), 'part 1 snapshots staging-two BEFORE the deploy, in this mode only');
  check(/if: env\.MODE == 'rehearsal' \|\| env\.MODE == 'restore-proof'/.test(tmp) && /ADD COLUMN probe_/.test(tmp), 'the temporary column-adding step runs in this mode as well as the rehearsal, and nowhere else');
  check(p2.length > 400 && /if: env\.MODE == 'restore-proof'/.test(p2) && /python3 tools\/restore-proof-judge\.py/.test(p2) && wf.indexOf('Restore proof, part 2') > wf.indexOf('Identity - read what the real objects report'), 'part 2 runs only in this mode, after the deploy, and has the judge decide');
  check(/admin\/backup\/restore/.test(p2) && /admin\/backup\/status/.test(p2) && /admin\/backup\/list/.test(p2) && /admin\/schema\/retry/.test(p2) && /admin\/engine\/status/.test(p2) && /STAGING_CONFIRM_KEY/.test(p2), 'part 2 restores, reads the backup status and list, retries the schema and reads the engine, with both admin keys (the restore is privileged)');
  check(/set \+e/.test(p2) && /rp-calls\.txt/.test(p2) && /call\(\)/.test(p2) && /call\(\)/.test(p1) && !/\$\(python3 -c/.test(p2.replace(/^\s*#.*$/gm, '')), 'HARDENED: neither part can die silently: errors are tolerated (set +e), every call is logged with its curl and HTTP status, and no command substitution can abort the step before the judge runs');
  check(/restore-proof\.json/.test(p2) && /did not produce a record/.test(p2) && /PUSHRC/.test(p2), 'a record is ALWAYS committed (a fallback record if the judge itself produced none) and a failed push fails the step');
  // BEHAVIOUR of the step's last section, run in bash with git and the judge stubbed: a record is ALWAYS committed, a failing judge or a failed push fails the step
  const tail = (p2.match(/ {10}RC=0\n {10}python3 tools\/restore-proof-judge\.py[\s\S]*$/) || [''])[0].split('\n').map((l) => l.replace(/^ {10}/, '')).join('\n');
  const runTail = ({ judge, push = 0 }) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-')), log = path.join(dir, 'log.txt');
    const script = `set +e\ncd "${dir}"\nexport RESULTS="${dir}/results" SCHEMA_PROBE_COLUMN=probe_1 EXPECT_COMMIT=abc GITHUB_REF_NAME=engine-phase1\nmkdir -p "$RESULTS"\n` +
      `python3() { case "${judge}" in ok) echo '{"all_ok": true}' > "$RESULTS/restore-proof.json"; return 0;; fail) echo '{"all_ok": false}' > "$RESULTS/restore-proof.json"; return 1;; none) return 2;; none0) return 0;; esac; }\n` +
      `git() { echo "git $*" >> "${log}"; if [ "$1" = push ]; then return ${push}; fi; return 0; }\n${tail}\n`;
    const r = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
    const rec = path.join(dir, 'ops', 'staging-restore-proof-last.json');
    return { code: r.status, record: fs.existsSync(rec) ? fs.readFileSync(rec, 'utf8') : null, log: fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '' };
  };
  check(tail.length > 300, 'the step\'s last section could be extracted to run');
  let t = runTail({ judge: 'ok' });
  check(t.code === 0 && /"all_ok": true/.test(t.record || '') && /git add ops\/staging-restore-proof-last\.json/.test(t.log) && /git push origin HEAD:engine-phase1/.test(t.log), 'BEHAVIOUR: a proving judge and a good push: the step succeeds, the judge\'s record is committed and pushed to the branch');
  t = runTail({ judge: 'fail' });
  check(t.code !== 0 && /"all_ok": false/.test(t.record || '') && /git push origin HEAD:engine-phase1/.test(t.log), 'BEHAVIOUR: a judge that does not prove FAILS the step, and its record is still committed and pushed');
  t = runTail({ judge: 'none' });
  check(t.code !== 0 && /did not produce a record/.test(t.record || '') && /git push origin HEAD:engine-phase1/.test(t.log), 'BEHAVIOUR: a judge that writes NOTHING still leaves a committed fallback record saying so, and FAILS the step (the first attempt died with no evidence)');
  t = runTail({ judge: 'none0' });
  check(t.code !== 0 && /did not produce a record/.test(t.record || ''), 'BEHAVIOUR: a judge that exits 0 but writes NO record is not a success: the fallback record is committed and the step FAILS (otherwise silence would read as proof)');
  t = runTail({ judge: 'ok', push: 1 });
  check(t.code !== 0, 'BEHAVIOUR: a proof whose record could not be pushed FAILS the step (an unrecorded proof is not a proof)');
  check(/git push origin HEAD:"\$GITHUB_REF_NAME"/.test(p2) && !/HEAD:main|origin main/.test(p2), 'it records to the BRANCH it ran on, never to main (a push to main deploys production)');
  check(!/provision/i.test(p1 + p2.replace(/^\s*#.*$/gm, '')) && !/wrangler|secret put|CLOUDFLARE_API_TOKEN/i.test((p1 + p2).replace(/^\s*#.*$/gm, '')), 'it provisions no engine data, sets no secret and holds no Cloudflare token: it snapshots, restores and reads');
  check(/uses: \.\/\.github\/workflows\/staging\.yml\s*\n\s*with:\s*\n\s*mode: gate/.test(fs.readFileSync(DEPLOY, 'utf8')) && !/restore-proof/.test(step('Gate - check that every business object')), 'production\'s pipeline still calls staging.yml in gate mode, never restore-proof, and the gate steps do not mention it');
});

if (require.main === module) kit.standalone(module.exports);
