// The production restore (tools/restore-guard.py and .github/workflows/prod-restore.yml; SHIP_CHECKLIST.md items 10 and 14). A restore REPLACES the live business with a backup, so the decision to do one lives in a small script that
// writes nothing, and it is tested on its own for every way it must say no. The workflow is read for its structure: one write, gated by the guard, never retried, nothing typed by a person ever placed in a script.
module.exports = async function runRestoreGuardTests({ check, path, fs }) {
  const { execFileSync } = require('child_process'), os = require('os');
  const guard = path.join(__dirname, 'restore-guard.py'), BIZ = 'zululand-flooring-and-blinds';
  const snap = (name, complete = true, finishedAt = '2026-10-13T16:42:05.640Z') => ({ name, complete, finishedAt, tables: 46, rows: 2004, notes: 42, files: 129 });
  const LIST = { snapshots: [snap('20261012T163900Z', true, '2026-10-12T16:42:00.000Z'), snap('20261013T163948Z'), snap('20261014T163900Z', false, null)] };
  const run = (list, snapshot, confirm, business = BIZ, deny = undefined) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-')), file = path.join(dir, 'list.json'), denyFile = path.join(dir, 'deny.json');
    fs.writeFileSync(file, typeof list === 'string' ? list : JSON.stringify(list));
    if (deny !== undefined) fs.writeFileSync(denyFile, typeof deny === 'string' ? deny : JSON.stringify(deny));
    const args = deny === undefined ? [guard, file] : [guard, file, denyFile];
    const env = { ...process.env, BUSINESS: business }; delete env.SNAPSHOT; delete env.CONFIRM;
    if (snapshot !== undefined) env.SNAPSHOT = snapshot; if (confirm !== undefined) env.CONFIRM = confirm;
    try { return { code: 0, ...JSON.parse(execFileSync('python3', args, { env, stdio: ['pipe', 'pipe', 'pipe'] }).toString()) }; }
    catch (e) { return { code: e.status, ...JSON.parse(e.stdout.toString()) }; }
  };

  // ---- nothing named: it lists and changes nothing ------------------------------------------------------------------------------------------------------------------------------------------------------------
  for (const [label, s, c] of [['nothing typed at all', undefined, undefined], ['empty boxes', '', ''], ['a snapshot box of spaces', '   ', ''], ['only the confirm box filled', '', BIZ]]) {
    const r = run(LIST, s, c);
    check(r.action === 'list' && r.code === 0 && r.available.length === 3 && r.newestComplete === '20261013T163948Z' && r.reasons.length === 0, `${label}: it only LISTS (the default: a mis-tap restores nothing), and names the newest COMPLETE snapshot (an unfinished newer one is not offered as newest)`);
  }

  // ---- a proper restore ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const good = run(LIST, '20261013T163948Z', BIZ);
  check(good.action === 'restore' && good.code === 0 && good.snapshot === '20261013T163948Z' && good.reasons.length === 0 && good.warnings.length === 1 && /safety snapshot of the current state is taken first/.test(good.warnings[0]), 'the newest complete snapshot with the business id typed exactly may be restored, with the warning that what was written since is replaced and a safety snapshot is taken first');
  const older = run(LIST, '20261012T163900Z', BIZ);
  check(older.action === 'restore' && older.warnings.length === 2 && /NOT the newest complete snapshot \(20261013T163948Z\)/.test(older.warnings[0]) && /everything written after 2026-10-12T16:42:00\.000Z will be lost/.test(older.warnings[0]), 'an OLDER complete snapshot may be restored, and the warning names the newest and what will be lost');
  const padded = run(LIST, '  20261013T163948Z  ', BIZ);
  check(padded.action === 'restore' && padded.snapshot === '20261013T163948Z', 'spaces around the snapshot name (a phone keyboard) are forgiven; none are forgiven in the confirm box');

  // ---- every way it must refuse (exit 2, reasons, nothing to restore) ----------------------------------------------------------------------------------------------------------------------------------------
  const refusals = [
    ['a snapshot without the business id', run(LIST, '20261013T163948Z', ''), /type the business id exactly/],
    ['the wrong business id', run(LIST, '20261013T163948Z', 'some-other-business'), /type the business id exactly/],
    ['the business id in capitals', run(LIST, '20261013T163948Z', BIZ.toUpperCase()), /type the business id exactly/],
    ['the business id with a space after it', run(LIST, '20261013T163948Z', BIZ + ' '), /type the business id exactly/],
    ['the confirm box left undefined', run(LIST, '20261013T163948Z', undefined), /type the business id exactly/],
    ['a snapshot that does not exist', run(LIST, '20250101T000000Z', BIZ), /there is no snapshot called 20250101T000000Z; the list has: 20261012T163900Z, 20261013T163948Z, 20261014T163900Z/],
    ['a snapshot that never finished', run(LIST, '20261014T163900Z', BIZ), /never finished \(it has no manifest\)/],
    ['a name with a quote and a command in it', run(LIST, '2026";rm -rf /;"', BIZ), /letters, digits, dots, dashes and underscores only/],
    ['a path', run(LIST, '../../20261013T163948Z', BIZ), /letters, digits, dots, dashes and underscores only/],
    ['a name with a space in the middle', run(LIST, '20261013T163948Z extra', BIZ), /letters, digits, dots, dashes and underscores only/],
    ['a name of 81 characters', run(LIST, 'a'.repeat(81), BIZ), /letters, digits, dots, dashes and underscores only/],
    ['a newline in the name', run(LIST, '20261013T163948Z\nsnapshot', BIZ), /letters, digits, dots, dashes and underscores only/],
  ];
  for (const [label, r, re] of refusals) check(r.action === 'refuse' && r.code === 2 && r.reasons.some((x) => re.test(x)), `refused: ${label}`);
  check(run({ snapshots: [snap('20261014T163900Z', false, null)] }, '20261014T163900Z', BIZ).action === 'refuse' && run({ snapshots: [] }, '20261013T163948Z', BIZ).action === 'refuse' && run({ snapshots: [] }, '20261013T163948Z', BIZ).reasons.some((x) => /the list has: nothing/.test(x)), 'refused: when no complete snapshot exists at all (or none exists) there is nothing to restore from');
  const both = run(LIST, '20250101T000000Z', 'wrong');
  check(both.reasons.length === 2, 'both problems are reported at once (a wrong id AND a missing snapshot), so a person fixes both in one go');

  // ---- it never decides blind ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const unreadable = [['an HTML error page', '<html>502 Bad Gateway</html>'], ['an empty answer', ''], ['an error object', { error: 'unauthorized' }], ['snapshots that is not a list', { snapshots: 'none' }], ['entries without names', { snapshots: [{ complete: true }] }], ['entries that are not objects', { snapshots: ['20261013T163948Z'] }], ['null', 'null']];
  for (const [label, l] of unreadable) {
    const asList = run(l, '', ''), asRestore = run(l, '20261013T163948Z', BIZ);
    check(asList.action === 'refuse' && asList.code === 2 && asRestore.action === 'refuse' && asRestore.code === 2 && /could not be read/.test(asRestore.reasons[0]), `a list that cannot be read (${label}) is a refusal, in list mode AND restore mode: nothing is restored blind`);
  }
  const missingFile = (() => { try { execFileSync('python3', [guard, '/no/such/list.json'], { env: { ...process.env, SNAPSHOT: '20261013T163948Z', CONFIRM: BIZ, BUSINESS: BIZ }, stdio: ['pipe', 'pipe', 'pipe'] }); return 0; } catch (e) { return e.status; } })();
  check(missingFile === 2, 'a list file that does not exist is a refusal too');
  check(run(LIST, '20261013T163948Z', BIZ, '').action === 'refuse', 'with no business id configured at all it refuses (an empty confirm box can never match an empty business)');

  // ---- the DENY LIST: a snapshot can be a perfectly COMPLETE copy of a damaged business ----------------------------------------------------------------------------------------------------------------------
  const DAMAGED = { snapshots: [snap('20261013T163948Z'), { ...snap('20261014T183344Z'), rows: 2006 }, { ...snap('20261014T185527Z'), rows: 1583 }, { ...snap('20261014T195218Z-pre-restore'), rows: 1583 }] };
  const DENY = { snapshots: { '20261014T185527Z': 'taken of the damaged state', '20261014T195218Z-pre-restore': 'the safety snapshot of that damaged state' } };
  const d1 = run(DAMAGED, '20261014T185527Z', BIZ, BIZ, DENY), d2 = run(DAMAGED, '20261014T195218Z-pre-restore', BIZ, BIZ, DENY);
  check(d1.action === 'refuse' && d1.code === 2 && d1.reasons.some((x) => /is on the deny list and will never be restored: taken of the damaged state/.test(x)) && d2.action === 'refuse' && d2.reasons.some((x) => /the safety snapshot of that damaged state/.test(x)), 'a snapshot on the deny list is REFUSED even though it is complete, exists and the business id was typed exactly, and the refusal says why');
  const ok2 = run(DAMAGED, '20261014T183344Z', BIZ, BIZ, DENY);
  check(ok2.action === 'restore' && ok2.reasons.length === 0 && !ok2.warnings.some((w) => /largest complete snapshot/.test(w)) && ok2.warnings.some((w) => /NOT the newest complete snapshot/.test(w)), 'a snapshot NOT on the deny list is unaffected: the good one still restores (with the usual warnings, and no shrink warning because it has the most rows)');
  const shown = run(DAMAGED, '', '', BIZ, DENY);
  check(shown.action === 'list' && shown.available.filter((s) => s.denied).map((s) => s.name).join() === '20261014T185527Z,20261014T195218Z-pre-restore' && shown.available.find((s) => s.name === '20261014T183344Z').denied === null, 'in list mode the denied snapshots are MARKED with their reasons, and the others are not');
  const bothProblems = run(DAMAGED, '20261014T185527Z', 'wrong', BIZ, DENY);
  check(bothProblems.reasons.length === 2, 'a denied snapshot with a wrong confirmation reports both problems at once');
  const badDeny = [['not JSON', 'nope {'], ['a list instead of an object', { snapshots: ['a'] }], ['an empty reason', { snapshots: { '20261014T185527Z': '' } }], ['a reason that is not text', { snapshots: { '20261014T185527Z': 5 } }], ['no snapshots key', { other: {} }], ['null', 'null']];
  for (const [label, d] of badDeny) {
    const a = run(DAMAGED, '', '', BIZ, d), b = run(DAMAGED, '20261013T163948Z', BIZ, BIZ, d);
    check(a.action === 'refuse' && a.code === 2 && b.action === 'refuse' && /deny list could not be read/.test(b.reasons[0]), `a deny list that was given but cannot be read (${label}) is a refusal, in list mode AND restore mode: nothing is restored blind`);
  }
  check(run(LIST, '20261013T163948Z', BIZ, BIZ, { snapshots: {} }).action === 'restore' && run(LIST, '20261013T163948Z', BIZ).action === 'restore', 'an EMPTY deny list denies nothing, and the guard still works when no deny list is given at all');
  // ---- the shrink WARNING (a snapshot with far fewer rows than the largest complete one) ----------------------------------------------------------------------------------------------------------------
  const rowsList = (rows) => ({ snapshots: [{ ...snap('20261012T163900Z'), rows: 1000 }, { ...snap('20261013T163948Z'), rows: rows }] });
  const shrink = run(rowsList(899), '20261013T163948Z', BIZ), edge = run(rowsList(900), '20261013T163948Z', BIZ), same = run(rowsList(1000), '20261013T163948Z', BIZ), big = run({ snapshots: [{ ...snap('20261012T163900Z'), rows: 5000 }, { ...snap('20261013T163948Z'), rows: 1000 }] }, '20261013T163948Z', BIZ);
  check(shrink.action === 'restore' && shrink.warnings.some((w) => /holds 899 rows and the largest complete snapshot holds 1000: restoring it would lose about 10% of the rows/.test(w)), 'a snapshot with under 90% of the largest snapshot\'s rows gets a WARNING saying how many rows it would lose (still allowed: it is a warning, not a refusal)');
  check(!edge.warnings.some((w) => /largest complete snapshot/.test(w)) && !same.warnings.some((w) => /largest complete snapshot/.test(w)) && big.warnings.some((w) => /lose about 80% of the rows/.test(w)), 'exactly 90% and equal row counts do not warn; a snapshot with a fifth of the rows does (80% lost)');
  const incomplete = run({ snapshots: [{ ...snap('20261012T163900Z'), rows: 1000 }, { ...snap('20261013T163948Z'), rows: 100 }, { ...snap('20261014T163900Z', false, null), rows: 99999 }] }, '20261012T163900Z', BIZ);
  check(!incomplete.warnings.some((w) => /largest complete snapshot/.test(w)), 'an unfinished snapshot never counts as the "largest" one');
  // ---- the real deny file --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const realDeny = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'ops', 'restore-denylist.json'), 'utf8')).snapshots;
  check(Object.keys(realDeny).sort().join() === '20261014T185527Z,20261014T195218Z-pre-restore' && Object.entries(realDeny).every(([k, v]) => /^\d{8}T\d{6}Z(-pre-restore)?$/.test(k) && typeof v === 'string' && v.length > 40), 'the real deny list holds the two snapshots of the damaged state of 2026-10-14, each with a real reason');
  const viaFile = run(DAMAGED, '20261014T185527Z', BIZ, BIZ, { snapshots: realDeny });
  check(viaFile.action === 'refuse' && viaFile.reasons.some((x) => /Never restore it/.test(x)), 'and the guard, given that very file, refuses the damaged snapshot');

  // ---- the workflow ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const raw = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'prod-restore.yml'), 'utf8'), code = raw.replace(/^\s*#.*$/gm, '');
  const triggers = code.slice(code.indexOf('on:'), code.indexOf('concurrency:'));
  check(/workflow_dispatch:/.test(triggers) && !/schedule:|push:|pull_request:|workflow_call:/.test(triggers), 'it starts by hand only: nothing can start a restore but a person');
  check(/snapshot:[\s\S]*?default: ""/.test(triggers) && /confirm:[\s\S]*?default: ""/.test(triggers), 'both boxes default to EMPTY, so running it unchanged only lists');
  const posts = [...code.matchAll(/-X\s*(POST|PUT|DELETE|PATCH)\s+"[^"]*"/g)].map((m) => m[0]);
  check(posts.length === 1 && /\/admin\/backup\/restore/.test(posts[0]), 'its ONLY write is one POST to /admin/backup/restore');
  const step = (name) => { const i = code.indexOf(`- name: ${name}`); const j = code.indexOf('\n      - name:', i + 5); return code.slice(i, j < 0 ? code.length : j); };
  const restoreStep = step('Restore (the only write; a single attempt)');
  check(/if: steps\.guard\.outputs\.action == 'restore'/.test(restoreStep) && restoreStep.includes('/admin/backup/restore') && /id: guard/.test(step('Decide what may happen (writes nothing)')), 'the restore step runs ONLY when the guard decided "restore"');
  check(!/for attempt in|while |until |sleep /.test(restoreStep), 'the restore is a SINGLE attempt: no retry loop (a blind second restore is not something to automate)');
  check(/python3 tools\/restore-guard\.py "\$RESULTS\/list\.json" ops\/restore-denylist\.json/.test(step('Decide what may happen (writes nothing)')) && /DENIED, NEVER RESTORE/.test(step('Decide what may happen (writes nothing)')), 'the workflow hands the guard the deny list from the repository, and shows denied snapshots in its summary');
  check(/exit \$GUARD/.test(step('Decide what may happen (writes nothing)')) && /python3 tools\/restore-guard\.py/.test(step('Decide what may happen (writes nothing)')), 'a refusal makes the run go RED (the guard\'s exit status is the step\'s)');
  const runs = [...code.matchAll(/run: \|([\s\S]*?)(?=\n      - |\n[a-z]|$)/g)].map((m) => m[1]).join('\n');
  check(!/\$\{\{\s*(github\.event\.inputs|inputs)/.test(runs) && /SNAPSHOT: \$\{\{ github\.event\.inputs\.snapshot \}\}/.test(code) && /CONFIRM: \$\{\{ github\.event\.inputs\.confirm \}\}/.test(code), 'what a person types reaches the scripts only through environment variables, never pasted into a script (no injection)');
  check(/json\.dumps\(\{'snapshot': os\.environ\['SNAPSHOT'\]\.strip\(\), 'confirm': os\.environ\['CONFIRM'\]\}\)/.test(restoreStep) && /-d @"\$RESULTS\/restore-request\.json"/.test(restoreStep), 'the request body is built by Python from the environment and sent from a file, not assembled in shell');
  check(JSON.stringify([...new Set([...code.matchAll(/secrets\.([A-Z_]+)/g)].map((m) => m[1]))].sort()) === JSON.stringify(['PROD_ADMIN_KEY', 'PROD_CONFIRM_KEY']) && /PROD_URL: https:\/\/office\.websitehub\.co\.za/.test(code) && /BUSINESS: zululand-flooring-and-blinds/.test(code), 'it uses only the two production admin secrets, against production, for the one business');
  check(/ADMIN_CONFIRM: \$\{\{ secrets\.PROD_CONFIRM_KEY \}\}/.test(restoreStep) && !/PROD_CONFIRM_KEY/.test(code.replace(restoreStep, '')), 'the confirmation key is available to the restore step ONLY');
  check(/rep\.get\("safetySnapshot"\)/.test(code) && /To UNDO this restore, run this workflow again/.test(code), 'it prints the safety snapshot\'s name and how to undo the restore');
  check(/- name: Record what happened\s*\n\s*if: always\(\)/.test(code) && /ops\/production-restore-last\.json/.test(code) && !/ADMIN|CONFIRM/.test(step('Record what happened')), 'it records what happened even when it fails, and the record step has no secrets in it');
  check(/concurrency:\s*\n\s*group: prod-restore\s*\n\s*cancel-in-progress: false/.test(code), 'two restores can never run at once, and a running one is never cancelled half way');
};
