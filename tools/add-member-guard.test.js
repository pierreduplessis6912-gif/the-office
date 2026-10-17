// Adding a person to an existing business (tools/add-member-guard.py and .github/workflows/prod-add-member.yml; SHIP_CHECKLIST.md item 15). A membership is a sign-in plus a role, an email can belong to only one business, and the
// repository is public, so the decision lives in a small script that writes nothing, tested for every way it must say no, and the workflow is read for its structure: one write gated by the guard, never retried, and the
// person's email (personal data) NEVER in the environment or an expression, where GitHub would print it in a public log.
module.exports = async function runAddMemberGuardTests({ check, path, fs }) {
  const { execFileSync } = require('child_process'), os = require('os');
  const guard = path.join(__dirname, 'add-member-guard.py');
  const DIR = { businesses: [{ id: 'tender-hub', status: 'active', plan: 'standard', members: 1 }, { id: 'live-biz', status: 'active', plan: 'standard', members: 4 }, { id: 'empty-biz', status: 'active', plan: 'standard', members: 0 }, { id: 'dormant', status: 'suspended', plan: 'standard', members: 1 }] };
  const NOCLASH = { conflicts: [] }, NOTYET = { found: false, role: null, status: null };
  const OK = { id: 'tender-hub', email: 'Pierre@Example.com', role: 'installer', confirm: 'tender-hub' };
  const run = (over = {}, dir = DIR, conflicts = NOCLASH, membership = NOTYET) => {
    const a = { ...OK, ...over }, d = fs.mkdtempSync(path.join(os.tmpdir(), 'am-')), f = ['inputs', 'dir', 'con', 'mem'].map((n) => path.join(d, n + '.json'));
    const inputs = { business_id: a.id, member_email: a.email, role: a.role, confirm: a.confirm }; for (const k of Object.keys(inputs)) if (inputs[k] === undefined) delete inputs[k];
    const w = (file, v) => fs.writeFileSync(file, typeof v === 'string' ? v : JSON.stringify(v));
    w(f[0], typeof over.__raw === 'string' ? over.__raw : inputs); w(f[1], dir); w(f[2], conflicts); w(f[3], membership);
    const env = { ...process.env }; for (const k of ['BUSINESS_ID', 'MEMBER_EMAIL', 'ROLE', 'CONFIRM']) delete env[k];
    try { const stdout = execFileSync('python3', [guard, ...f], { env, stdio: ['pipe', 'pipe', 'pipe'] }).toString(); return { code: 0, raw: stdout, ...JSON.parse(stdout) }; }
    catch (e) { const stdout = e.stdout.toString(); return { code: e.status, raw: stdout, ...JSON.parse(stdout) }; }
  };

  // ---- a proper addition ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const good = run();
  check(good.action === 'add' && good.code === 0 && good.business_id === 'tender-hub' && good.role === 'installer' && good.membersBefore === 1 && good.reasons.length === 0 && good.warnings.length === 0, 'an existing business, a free email, a valid role and the id typed again: it may ADD');
  check(good.memberMasked === 'p***@example.com' && !/pierre@example/i.test(good.raw), 'the person\'s email appears only MASKED in the output, in any case');
  check(run({ email: '  PIERRE@EXAMPLE.COM ', id: ' tender-hub ', role: ' accountant ' }).action === 'add', 'spaces and capitals typed on a phone are tidied exactly as the server tidies them');

  // ---- the OWNER rule: an established business cannot be given another owner this way ------------------------------------------------------------------------------------------------------------------------
  check(run({ role: 'owner' }).action === 'add' && run({ id: 'empty-biz', confirm: 'empty-biz', role: 'owner' }).action === 'add', 'a business with ONE member (or none) can be given an owner');
  const ownerLive = run({ id: 'live-biz', confirm: 'live-biz', role: 'owner' });
  check(ownerLive.action === 'refuse' && ownerLive.code === 2 && ownerLive.reasons.some((x) => /already has 4 members: another OWNER cannot be added this way/.test(x)), 'a business that already has 4 members is REFUSED another owner (a typed id and a typo cannot hand an established business to someone)');
  check(['installer', 'accountant'].every((role) => run({ id: 'live-biz', confirm: 'live-biz', role }).action === 'add'), 'but an accountant or an installer can be added to the established business');
  check(run({ id: 'empty-biz', confirm: 'empty-biz', role: 'installer' }).warnings.some((w) => /no members yet: the first person is usually its owner/.test(w)), 'adding a non-owner to a business with NO members carries a note that the first person is usually its owner');

  // ---- every bad input ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  for (const [label, id] of [['upper case', 'Tender-Hub'], ['an underscore', 'tender_hub'], ['two characters', 'ab'], ['a leading hyphen', '-tender-hub'], ['a space', 'tender hub'], ['empty', ''], ['a quote and a command', 'x";rm -rf /;"']]) { const r = run({ id, confirm: id }); check(r.action === 'refuse' && r.code === 2 && r.reasons.some((x) => /3 to 40 lower-case letters, digits and hyphens/.test(x)), `refused: an id with ${label}`); }
  for (const [label, c] of [['empty', ''], ['different', 'tender-hu'], ['in capitals', 'TENDER-HUB'], ['with a space after', 'tender-hub ']]) check(run({ confirm: c }).action === 'refuse' && run({ confirm: c }).reasons.some((x) => /type the business id exactly/.test(x)), `refused: the confirm box ${label}`);
  for (const [label, e] of [['no @', 'pierre.example.com'], ['two @', 'a@b@example.com'], ['no dot in the domain', 'pierre@example'], ['a space inside', 'pi erre@example.com'], ['empty', ''], ['a 65-character local part', 'a'.repeat(65) + '@example.com']]) check(run({ email: e }).action === 'refuse' && run({ email: e }).reasons.some((x) => /not a valid email address/.test(x)), `refused: an email with ${label}`);
  for (const [label, role] of [['admin', 'admin'], ['empty', ''], ['in capitals', 'OWNER'], ['plural', 'installers'], ['a command', 'owner;rm']]) check(run({ role }).action === 'refuse' && run({ role }).reasons.some((x) => /the role must be one of: owner, accountant, installer/.test(x)), `refused: the role "${label}"`);
  check(run({ id: 'Bad_ID', confirm: 'x', email: 'nope', role: 'boss' }).reasons.length === 4, 'every problem is reported at once (id, confirm, email, role)');
  check(run({ id: 'Bad_ID', confirm: 'Bad_ID' }, '<html>', '', '').reasons.length === 1, 'a bad input is reported even when nothing could be fetched (the input checks come first)');

  // ---- it never decides blind ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  for (const [label, d] of [['an HTML error page', '<html>502</html>'], ['empty', ''], ['an error object', { error: 'unauthorized' }], ['businesses that is not a list', { businesses: 'x' }], ['entries without an id', { businesses: [{ name: 'x' }] }], ['null', 'null']]) { const r = run({}, d); check(r.action === 'refuse' && r.code === 2 && /directory could not be read/.test(r.reasons[0]), `a directory that cannot be read (${label}) is a refusal`); }
  for (const [label, c] of [['an HTML error page', '<html>502</html>'], ['empty', ''], ['an error object', { error: 'bad request' }], ['conflicts that is not a list', { conflicts: 'none' }], ['entries without an email', { conflicts: [{ business_id: 'x' }] }]]) { const r = run({}, DIR, c); check(r.action === 'refuse' && /belong to another business\?' could not be read/.test(r.reasons[0]), `a clash answer that cannot be read (${label}) is a refusal`); }
  for (const [label, m] of [['an HTML error page', '<html>'], ['empty', ''], ['an error object', { error: 'nope' }], ['found that is not true or false', { found: 'yes' }], ['null', 'null']]) { const r = run({}, DIR, NOCLASH, m); check(r.action === 'refuse' && /already a member here\?' could not be read/.test(r.reasons[0]), `a membership answer that cannot be read (${label}) is a refusal`); }
  for (const [label, raw] of [['not JSON', 'nope {'], ['a list', '[1]'], ['empty', ''], ['null', 'null']]) check(run({ __raw: raw }).action === 'refuse' && run({ __raw: raw }).code === 2, `inputs that cannot be read (${label}) are a refusal, not a crash`);
  check(run({ __raw: JSON.stringify({ business_id: 5, member_email: ['x'], role: { a: 1 }, confirm: null }) }).action === 'refuse', 'inputs of the wrong TYPE are refused, not a crash');
  const missing = (() => { try { execFileSync('python3', [guard, '/no/a.json', '/no/b.json', '/no/c.json', '/no/d.json'], { stdio: ['pipe', 'pipe', 'pipe'] }); return 0; } catch (e) { return e.status; } })();
  check(missing === 2, 'files that do not exist are a refusal too');

  // ---- the business ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  check(run({ id: 'no-such-biz', confirm: 'no-such-biz' }).reasons.some((x) => /there is no business called no-such-biz/.test(x)), 'a business that does not exist is refused');
  check(run({ id: 'dormant', confirm: 'dormant' }).reasons.some((x) => /exists but is not active/.test(x)), 'a business that is not active is refused');
  check(run({}, { businesses: [{ id: 'tender-hub', status: 'active' }] }).reasons.some((x) => /member count could not be read/.test(x)), 'a business whose member count cannot be read is refused rather than assumed');

  // ---- the email -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const clash = run({}, DIR, { conflicts: [{ email: 'pierre@example.com', business_id: 'another-company' }] });
  check(clash.action === 'refuse' && clash.reasons.some((x) => /already belongs to another business/.test(x)) && !/another-company/.test(clash.raw), 'an email that belongs to ANOTHER business is refused, and the output does not say which');
  check(run({ email: 'PIERRE@EXAMPLE.COM' }, DIR, { conflicts: [{ email: 'Pierre@Example.com ', business_id: 'x' }] }).action === 'refuse' && run({}, DIR, { conflicts: [{ email: 'someone@else.com', business_id: 'x' }] }).action === 'add', 'the clash is found whatever the case or spacing, and a clash for a DIFFERENT email does not stop this one');
  const already = run({}, DIR, NOCLASH, { found: true, role: 'accountant', status: 'active' });
  check(already.action === 'refuse' && already.reasons.some((x) => /already a member of this business \(as accountant\): there is nothing to add/.test(x)) && !/pierre@example/i.test(already.raw), 'a person who is ALREADY a member is refused with their role (nothing to add, and the repeat that would fail inside the business is never attempted)');

  // ---- the workflow ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const raw = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'prod-add-member.yml'), 'utf8'), code = raw.replace(/^\s*#.*$/gm, '');
  const triggers = code.slice(code.indexOf('on:'), code.indexOf('concurrency:'));
  const step = (name) => { const i = code.indexOf(`- name: ${name}`); const j = code.indexOf('\n      - name:', i + 5); return code.slice(i, j < 0 ? code.length : j); };
  check(/workflow_dispatch:/.test(triggers) && !/schedule:|push:|pull_request:|workflow_call:/.test(triggers) && ['business_id', 'member_email', 'role', 'confirm'].every((k) => new RegExp(`${k}:[\\s\\S]*?required: true`).test(triggers)) && /type: choice[\s\S]*?- installer\s*\n\s*- accountant\s*\n\s*- owner/.test(triggers), 'it starts by hand only, with four REQUIRED inputs, the role a fixed choice (installer, accountant, owner)');
  const posts = [...code.matchAll(/-X\s*(POST|PUT|DELETE|PATCH)\s+"[^"]*"/g)].map((m) => m[0]);
  check(posts.length === 2 && /\/debug\/directory\/check-members/.test(posts[0]) && /\/debug\/directory\/add-member/.test(posts[1]), 'it makes exactly TWO posts: the read-only email check, then the one add');
  const addStep = step('Add the member (the only write; a single attempt)');
  check(/if: steps\.guard\.outputs\.action == 'add'/.test(addStep) && addStep.includes('/debug/directory/add-member') && /id: guard/.test(step('Decide what may happen (writes nothing)')) && !/for attempt in|while |until |sleep /.test(addStep), 'the add step runs ONLY when the guard decided "add", and is a SINGLE attempt');
  check(!/github\.event\.inputs\.member_email/.test(code) && !/\$\{\{[^}]*member_email/i.test(code) && !/MEMBER_EMAIL/.test(code), 'the person\'s email is NOT in any environment variable and NOT in any expression anywhere in the workflow (GitHub prints a step\'s env block in its public log)');
  const first = step('Read the inputs and hide the email (first, before anything is printed)');
  check(code.indexOf('- name: Read the inputs and hide the email') < code.indexOf('- name: Read the directory') && /GITHUB_EVENT_PATH/.test(first) && /::add-mask::/.test(first) && first.indexOf('::add-mask::') < first.indexOf('json.dump') && /event\["inputs"\]/.test(first), 'the FIRST step reads the inputs from the event file, registers the email as a mask BEFORE writing anything, and writes a file; nothing runs before it');
  check(/add-member-guard\.py "\$RESULTS\/inputs\.json" "\$RESULTS\/directory\.json" "\$RESULTS\/conflicts\.json" "\$RESULTS\/membership\.json"/.test(step('Decide what may happen (writes nothing)')) && /exit \$GUARD/.test(step('Decide what may happen (writes nothing)')) && /json\.dumps\(\{'email': i\['member_email'\], 'business_id': d\['business_id'\], 'role': d\['role'\]\}\)/.test(addStep) && /-d @"\$RESULTS\/add-request\.json"/.test(addStep), 'the guard is handed the four files and its exit status is the step\'s; the add request is built by Python from the inputs file and the guard\'s decision, and sent from a file');
  const runs = [...code.matchAll(/run: \|([\s\S]*?)(?=\n      - |\n[a-z]|$)/g)].map((m) => m[1]).join('\n');
  check(!/\$\{\{\s*(github\.event\.inputs|inputs)/.test(runs) && JSON.stringify([...new Set([...code.matchAll(/secrets\.([A-Z_]+)/g)].map((m) => m[1]))].sort()) === JSON.stringify(['PROD_ADMIN_KEY', 'PROD_CONFIRM_KEY']), 'typed text is never pasted into a script, and only the two production admin secrets are used');
  check(['Ask whether the email belongs to ANOTHER business (reads only)', 'Add the member (the only write; a single attempt)'].every((n) => /PROD_CONFIRM_KEY/.test(step(n))) && !/PROD_CONFIRM_KEY/.test(code.replace(step('Ask whether the email belongs to ANOTHER business (reads only)'), '').replace(addStep, '')), 'the confirmation key is available to those TWO steps only');
  const record = step('Record what happened');
  check(/if: always\(\)/.test(record) && /ops\/production-add-member-last\.json/.test(record) && !/member_email|memberMasked|EMAIL|ADMIN|CONFIRM/.test(record), 'it records even when it fails, and the record step has no secret and never touches the email');
  const verify = step('Check it afterwards (reads only)');
  check(/mine\.get\("members"\) == before \+ 1/.test(verify) && /after\.get\("found"\) is True and after\.get\("role"\) == decision\.get\("role"\)/.test(verify) && /sys\.exit\(0 if all\(checks\.values\(\)\) else 1\)/.test(verify) && /X-Target-Business: \$BUSINESS_ID/.test(verify), 'afterwards it checks, and a failure turns the run red: one more member in the directory, and the business itself says the person is a member with the role asked for');
  check(/concurrency:\s*\n\s*group: prod-add-member\s*\n\s*cancel-in-progress: false/.test(code), 'two additions can never run at once, and a running one is never cancelled half way');
};
