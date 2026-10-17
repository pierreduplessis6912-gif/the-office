// Converting a trial business to a paid plan, or extending its trial (tools/trial-guard.py and .github/workflows/prod-trial.yml; SHIP_CHECKLIST.md item 15). Without this an ended trial could never be brought back. The decision lives in a
// small script that writes nothing, tested for every way it must say no, and the workflow is read for its structure: one write gated by the guard, never retried, checked afterwards.
module.exports = async function runTrialGuardTests({ check, path, fs }) {
  const { execFileSync } = require('child_process'), os = require('os');
  const guard = path.join(__dirname, 'trial-guard.py');
  const stamp = (days) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 19).replace('T', ' ');
  const biz = (id, extra = {}) => ({ id, name: id.toUpperCase(), status: 'active', plan: 'trial', members: 1, source: 'signup', trial_ends_at: stamp(5), ...extra });
  const DIR = { businesses: [biz('running-co'), biz('ended-co', { trial_ends_at: stamp(-3) }), biz('paid-co', { plan: 'standard', trial_ends_at: null, source: 'admin' }), { id: 'old-co', name: 'Old', status: 'active', plan: 'standard', members: 2 }, biz('pending-co', { status: 'pending' }), biz('gone-co', { status: 'suspended' }), biz('weird-co', { trial_ends_at: 'soon' })] };
  const PLANS = { plans: [{ name: 'standard', messagesPerMemberPerDay: 100 }, { name: 'trial', messagesPerMemberPerDay: 30 }, { name: 'pro', messagesPerMemberPerDay: 500 }] };
  const OK = { id: 'ended-co', op: 'extend', plan: 'standard', days: '14', confirm: 'ended-co' };
  const run = (over = {}, dir = DIR, plans = PLANS) => {
    const a = { ...OK, ...over }, d = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-')), f = ['inputs', 'dir', 'plans'].map((n) => path.join(d, n + '.json'));
    const inputs = { business_id: a.id, op: a.op, plan: a.plan, days: a.days, confirm: a.confirm }; for (const k of Object.keys(inputs)) if (inputs[k] === undefined) delete inputs[k];
    const w = (file, v) => fs.writeFileSync(file, typeof v === 'string' ? v : JSON.stringify(v));
    w(f[0], typeof over.__raw === 'string' ? over.__raw : inputs); w(f[1], dir); w(f[2], plans);
    try { const stdout = execFileSync('python3', [guard, ...f], { stdio: ['pipe', 'pipe', 'pipe'] }).toString(); return { code: 0, raw: stdout, ...JSON.parse(stdout) }; }
    catch (e) { const stdout = e.stdout.toString(); return { code: e.status, raw: stdout, ...JSON.parse(stdout) }; }
  };

  // ---- a proper move -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const ext = run();
  check(ext.action === 'apply' && ext.code === 0 && ext.business_id === 'ended-co' && ext.op === 'extend' && ext.days === 14 && ext.members === 1 && /ENDED 3\.0 days ago \(the owner cannot sign in\)/.test(ext.state) && ext.reasons.length === 0 && /14 more day/.test(ext.warnings[0]), 'extending an ENDED trial may proceed, and the decision says it ended 3 days ago and that the owner cannot sign in');
  const con = run({ op: 'convert', id: 'running-co', confirm: 'running-co', plan: 'standard' });
  check(con.action === 'apply' && con.op === 'convert' && con.plan === 'standard' && /running, 5\.0 days left/.test(con.state) && /the trial is cleared/.test(con.warnings[0]), 'converting a RUNNING trial to the standard plan may proceed, and says how many days it had left');
  check(run({ op: 'convert', plan: 'pro' }).action === 'apply' && run({ days: ' 7 ' }).days === 7 && run({ days: '07' }).days === 7, 'any plan in the plan list can be converted to, and a number with spaces or a leading zero is understood');
  check(!/@/.test(ext.raw) && ext.name === 'ENDED-CO', 'the output carries the business and its plan, no personal data');

  // ---- every bad input ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  for (const [label, id] of [['upper case', 'Ended-Co'], ['an underscore', 'ended_co'], ['two characters', 'ab'], ['a space', 'ended co'], ['empty', ''], ['a command', 'x";rm -rf /;"']]) { const r = run({ id, confirm: id }); check(r.action === 'refuse' && r.code === 2 && r.reasons.some((x) => /3 to 40 lower-case letters, digits and hyphens/.test(x)), `refused: an id with ${label}`); }
  for (const [label, c] of [['empty', ''], ['different', 'ended-c'], ['in capitals', 'ENDED-CO'], ['with a space after', 'ended-co ']]) check(run({ confirm: c }).action === 'refuse' && run({ confirm: c }).reasons.some((x) => /type the business id exactly/.test(x)), `refused: the confirm box ${label}`);
  for (const [label, op] of [['empty', ''], ['delete', 'delete'], ['in capitals', 'EXTEND'], ['a command', 'extend;rm']]) check(run({ op }).action === 'refuse' && run({ op }).reasons.some((x) => /must be "convert" or "extend"/.test(x)), `refused: the action "${label}"`);
  for (const [label, days] of [['0', '0'], ['91', '91'], ['negative', '-3'], ['a fraction', '1.5'], ['text', 'abc'], ['empty', ''], ['1000', '1000'], ['a command', '7;rm']]) check(run({ days }).action === 'refuse' && run({ days }).reasons.some((x) => /days is a whole number from 1 to 90/.test(x)), `refused: ${label} days`);
  check(run({ days: '1' }).action === 'apply' && run({ days: '90' }).action === 'apply', 'one day and ninety days are accepted');
  for (const [label, plan] of [['missing', undefined], ['empty', ''], ['the trial plan', 'trial'], ['one that does not exist', 'platinum']]) { const r = run({ op: 'convert', plan }); check(r.action === 'refuse' && r.reasons.length === 1, `refused: converting to ${label}`); }
  check(run({ op: 'convert', plan: 'trial' }).reasons[0].includes('not a plan to convert TO') && run({ op: 'convert', plan: 'platinum' }).reasons[0] === 'there is no plan called platinum', 'and the reasons say why');
  check(run({ plan: 'platinum' }).action === 'apply', 'a plan name is ignored for an extend (and an unknown one does not stop it)');
  check(run({ id: 'Bad_ID', confirm: 'x', op: 'nope', days: 'x' }).reasons.length === 3 && run({ id: 'Bad_ID', confirm: 'x', op: 'convert', plan: 'trial' }).reasons.length === 3, 'several problems are reported at once');
  check(run({ id: 'Bad_ID', confirm: 'Bad_ID' }, '<html>', '').reasons.length === 1, 'a bad input is reported even when nothing could be fetched (the input checks come first)');

  // ---- it never decides blind ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  for (const [label, d] of [['an HTML error page', '<html>502</html>'], ['empty', ''], ['an error object', { error: 'unauthorized' }], ['businesses that is not a list', { businesses: 'x' }], ['entries without an id', { businesses: [{ name: 'x' }] }], ['null', 'null']]) { const r = run({}, d); check(r.action === 'refuse' && r.code === 2 && /directory could not be read/.test(r.reasons[0]), `a directory that cannot be read (${label}) is a refusal`); }
  for (const [label, p] of [['an HTML error page', '<html>'], ['empty', ''], ['an error object', { error: 'x' }], ['plans that is not a list', { plans: 'x' }], ['entries without a name', { plans: [{ messages: 1 }] }]]) { const r = run({}, DIR, p); check(r.action === 'refuse' && /list of plans could not be read/.test(r.reasons[0]), `a plan list that cannot be read (${label}) is a refusal`); }
  for (const [label, raw] of [['not JSON', 'nope {'], ['a list', '[1]'], ['empty', ''], ['null', 'null']]) check(run({ __raw: raw }).action === 'refuse' && run({ __raw: raw }).code === 2, `inputs that cannot be read (${label}) are a refusal, not a crash`);
  check(run({ __raw: JSON.stringify({ business_id: 5, op: ['extend'], plan: null, days: 14, confirm: {} }) }).action === 'refuse', 'inputs of the wrong TYPE (a number for days included) are refused, not a crash');
  const missing = (() => { try { execFileSync('python3', [guard, '/no/a', '/no/b', '/no/c'], { stdio: ['pipe', 'pipe', 'pipe'] }); return 0; } catch (e) { return e.status; } })();
  check(missing === 2, 'files that do not exist are a refusal too');

  // ---- the business ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  check(run({ id: 'no-such-biz', confirm: 'no-such-biz' }).reasons.some((x) => /there is no business called no-such-biz/.test(x)), 'a business that does not exist is refused');
  const paid = run({ id: 'paid-co', confirm: 'paid-co' });
  check(paid.action === 'refuse' && paid.reasons.some((x) => /not on a free trial: there is nothing to convert or extend/.test(x)), 'a business that is NOT on a trial (an operator\'s, or already converted) is refused: there is nothing to convert');
  check(run({ id: 'old-co', confirm: 'old-co' }).reasons.some((x) => /no trial information yet/.test(x)), 'a directory from before trials says so plainly');
  for (const id of ['pending-co', 'gone-co']) check(run({ id, confirm: id }).reasons.some((x) => /not active: only an active business can be moved off its trial/.test(x)), `${id} (not active) is refused`);
  check(run({ id: 'weird-co', confirm: 'weird-co' }).action === 'refuse', 'a trial end that cannot be read is refused rather than guessed');
  check(run({ id: 'ended-co', op: 'convert', plan: 'standard', confirm: 'ended-co' }).action === 'apply', 'an ended trial can be CONVERTED as well as extended');

  // ---- the workflow ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const raw = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'prod-trial.yml'), 'utf8'), code = raw.replace(/^\s*#.*$/gm, '');
  const triggers = code.slice(code.indexOf('on:'), code.indexOf('concurrency:'));
  const step = (name) => { const i = code.indexOf(`- name: ${name}`); const j = code.indexOf('\n      - name:', i + 5); return code.slice(i, j < 0 ? code.length : j); };
  check(/workflow_dispatch:/.test(triggers) && !/schedule:|push:|pull_request:|workflow_call:/.test(triggers) && ['business_id', 'op', 'confirm'].every((k) => new RegExp(`${k}:[\\s\\S]*?required: true`).test(triggers)) && /type: choice[\s\S]*?- extend\s*\n\s*- convert/.test(triggers), 'it starts by hand only; the id and confirmation are required and the action is a fixed choice (extend or convert)');
  const posts = [...code.matchAll(/-X\s*(POST|PUT|DELETE|PATCH)\s+"[^"]*"/g)].map((m) => m[0]);
  const apply = step('Apply it (the only write; a single attempt)');
  check(posts.length === 1 && /\/debug\/directory\/trial/.test(posts[0]) && /if: steps\.guard\.outputs\.action == 'apply'/.test(apply) && !/for attempt in|while |until |sleep /.test(apply), 'it makes exactly ONE post, to the trial route, only when the guard decided "apply", in a single attempt');
  const decide = step('Decide what may happen (writes nothing)');
  check(/trial-guard\.py "\$RESULTS\/inputs\.json" "\$RESULTS\/directory\.json" "\$RESULTS\/plans\.json"/.test(decide) && /exit \$GUARD/.test(decide) && /id: guard/.test(decide), 'the guard is handed the three files and its exit status is the step\'s (a refusal turns the run red)');
  check(/json\.dumps\(\{'business': d\['business_id'\], 'action': d\['op'\]/.test(apply) && /-d @"\$RESULTS\/apply-request\.json"/.test(apply), 'the request is built by Python from the guard\'s decision and sent from a file');
  const runs = [...code.matchAll(/run: \|([\s\S]*?)(?=\n      - |\n[a-z]|$)/g)].map((m) => m[1]).join('\n');
  check(!/\$\{\{\s*(github\.event\.inputs|inputs)/.test(runs) && ['business_id', 'op', 'days', 'plan', 'confirm'].every((k) => new RegExp(`: \\$\\{\\{ github\\.event\\.inputs\\.${k} \\}\\}`).test(code)), 'what a person types reaches the scripts only through environment variables, never pasted into a script (no injection)');
  check(JSON.stringify([...new Set([...code.matchAll(/secrets\.([A-Z_]+)/g)].map((m) => m[1]))].sort()) === JSON.stringify(['PROD_ADMIN_KEY', 'PROD_CONFIRM_KEY']) && /PROD_CONFIRM_KEY/.test(apply) && !/PROD_CONFIRM_KEY/.test(code.replace(apply, '')), 'only the two production admin secrets are used, and the confirmation key reaches the apply step ONLY');
  const verify = step('Check it afterwards (reads only)');
  check(/if: always\(\) && steps\.guard\.outputs\.action == 'apply'/.test(verify) && /mine\.get\("plan"\) == d\.get\("plan"\)/.test(verify) && /mine\.get\("trial_ends_at"\) is None/.test(verify) && /new > old/.test(verify) && /d\.get\("days", 0\) \* 86400 - 300/.test(verify) && /sys\.exit\(0 if all\(checks\.values\(\)\) else 1\)/.test(verify), 'afterwards it checks, and a failure turns the run red: a convert shows the plan and a cleared trial; an extend shows a later end by at least the days asked for');
  const record = step('Record what happened');
  check(/if: always\(\)/.test(record) && /ops\/production-trial-last\.json/.test(record) && /git push origin HEAD:"\$GITHUB_REF_NAME"/.test(record) && !/ADMIN|CONFIRM|secrets/.test(record), 'it records even when it fails, with no secret, on the branch it started from');
  check(/concurrency:\s*\n\s*group: prod-trial\s*\n\s*cancel-in-progress: false/.test(code), 'two changes can never run at once, and a running one is never cancelled half way');
};
