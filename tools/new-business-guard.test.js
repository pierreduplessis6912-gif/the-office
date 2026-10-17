// Creating a customer's business (tools/new-business-guard.py and .github/workflows/prod-new-business.yml; SHIP_CHECKLIST.md item 15, part 3). Creating a business leaves a directory entry, a sign-in and a Durable Object behind, and
// an owner's email can belong to only one business, so the decision lives in a small script that writes nothing, tested for every way it must say no. The workflow is read for its structure: one write, gated by the guard, never
// retried, nothing typed by a person placed in a script, and the owner's email (personal data) never printed in full and never recorded.
module.exports = async function runNewBusinessGuardTests({ check, path, fs }) {
  const { execFileSync } = require('child_process'), os = require('os');
  const guard = path.join(__dirname, 'new-business-guard.py');
  const DIR = { businesses: [{ id: 'zululand-flooring-and-blinds', name: 'Zululand Flooring and Blinds', status: 'active', plan: 'standard', members: 4 }, { id: 'half-made', name: 'Half Made', status: 'active', plan: 'standard', members: 0 }, { id: 'gone-away', name: 'Gone Away', status: 'suspended', plan: 'standard', members: 0 }] };
  const NONE = { conflicts: [] };
  const OK = { id: 'acme-floors', name: 'Acme Floors', email: 'Owner@Acme.co.za', confirm: 'acme-floors' };
  const run = (over = {}, dir = DIR, conflicts = NONE) => {
    const a = { ...OK, ...over }, d = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-')), f1 = path.join(d, 'dir.json'), f2 = path.join(d, 'con.json');
    fs.writeFileSync(f1, typeof dir === 'string' ? dir : JSON.stringify(dir)); fs.writeFileSync(f2, typeof conflicts === 'string' ? conflicts : JSON.stringify(conflicts));
    const env = { ...process.env, BUSINESS_ID: a.id, BUSINESS_NAME: a.name, OWNER_EMAIL: a.email, CONFIRM: a.confirm };
    for (const k of ['BUSINESS_ID', 'BUSINESS_NAME', 'OWNER_EMAIL', 'CONFIRM']) if (env[k] === undefined) delete env[k];
    try { const stdout = execFileSync('python3', [guard, f1, f2], { env, stdio: ['pipe', 'pipe', 'pipe'] }).toString(); return { code: 0, raw: stdout, ...JSON.parse(stdout) }; }
    catch (e) { const stdout = e.stdout.toString(); return { code: e.status, raw: stdout, ...JSON.parse(stdout) }; }
  };

  // ---- a proper creation ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const good = run();
  check(good.action === 'create' && good.code === 0 && good.business_id === 'acme-floors' && good.name === 'Acme Floors' && good.existing === false && good.reasons.length === 0 && good.warnings.length === 0, 'a new id, a name, a free email and the id typed again: it may CREATE');
  check(good.ownerMasked === 'o***@acme.co.za' && !/owner@acme/i.test(good.raw) && !/Owner@Acme/.test(good.raw), 'the owner\'s email appears only MASKED (o***@acme.co.za), in any case: the output never carries it in full');
  const tidy = run({ name: '  Acme    Floors  ', email: '  OWNER@ACME.CO.ZA ', id: ' acme-floors ' , confirm: 'acme-floors' });
  check(tidy.action === 'create' && tidy.name === 'Acme Floors' && tidy.business_id === 'acme-floors', 'spaces and capitals typed on a phone are tidied (the name\'s spacing, the email\'s case and spaces, the id\'s outer spaces) exactly as the server tidies them');

  // ---- every bad business id ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const ids = [['upper case', 'Acme-Floors'], ['an underscore', 'acme_floors'], ['a space', 'acme floors'], ['two characters', 'ab'], ['41 characters', 'a'.repeat(41)], ['a leading hyphen', '-acme-floors'], ['a trailing hyphen', 'acme-floors-'], ['a dot', 'acme.floors'], ['a slash', 'acme/floors'], ['non-ASCII', 'acmé-floors'], ['empty', ''], ['a quote and a command', 'acme";rm -rf /;"']];
  for (const [label, id] of ids) { const r = run({ id, confirm: id }); check(r.action === 'refuse' && r.code === 2 && r.reasons.some((x) => /3 to 40 lower-case letters, digits and hyphens/.test(x)), `refused: an id with ${label}`); }
  check(run({ id: 'abc', confirm: 'abc' }).action === 'create' && run({ id: 'a'.repeat(40), confirm: 'a'.repeat(40) }).action === 'create', 'the shortest (3) and longest (40) ids are accepted');
  for (const id of ['admin', 'api', 'app', 'auth', 'debug', 'demo', 'health', 'office', 'staging', 'test', 'www', 'staging-co', 'staging-two']) { const r = run({ id, confirm: id }); check(r.action === 'refuse' && r.reasons.some((x) => /is reserved/.test(x)), `refused: "${id}" is reserved (it could be mistaken for a system or staging name)`); }

  // ---- confirm, name, email ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  for (const [label, c] of [['empty', ''], ['different', 'acme-floor'], ['in capitals', 'ACME-FLOORS'], ['with a space after', 'acme-floors ']]) check(run({ confirm: c }).action === 'refuse' && run({ confirm: c }).reasons.some((x) => /type the business id exactly/.test(x)), `refused: the confirm box ${label}`);
  check(run({ confirm: undefined }).action === 'refuse', 'refused: the confirm box missing altogether');
  for (const [label, n] of [['empty', ''], ['only spaces', '    '], ['one character', 'A'], ['81 characters', 'x'.repeat(81)], ['a control character', 'Acme\u0007Floors'], ['an angle bracket', 'Acme <b>Floors</b>']]) check(run({ name: n }).action === 'refuse' && run({ name: n }).reasons.some((x) => /2 to 80 characters/.test(x)), `refused: a name that is ${label}`);
  check(run({ name: 'Acme\nFloors' }).name === 'Acme Floors' && run({ name: 'Acme\tFloors' }).action === 'create', 'a newline or a tab inside a name is just whitespace and is tidied to a single space');
  check(run({ name: 'x'.repeat(80) }).action === 'create' && run({ name: 'Ab' }).action === 'create' && run({ name: "O'Brien & Sons (Pty) Ltd" }).action === 'create', 'names of 2 and 80 characters, and with an apostrophe, an ampersand and brackets, are accepted');
  for (const [label, e] of [['no @', 'owner.acme.co.za'], ['two @', 'a@b@acme.co.za'], ['no dot in the domain', 'owner@acme'], ['a space inside', 'ow ner@acme.co.za'], ['empty', ''], ['255 characters', 'a'.repeat(64) + '@' + 'b'.repeat(186) + '.com'], ['a 65-character local part', 'a'.repeat(65) + '@acme.co.za'], ['only an @', '@']]) check(run({ email: e }).action === 'refuse' && run({ email: e }).reasons.some((x) => /not a valid email address/.test(x)), `refused: an email with ${label}`);
  check(run({ email: 'first.last+floors@acme.co.za' }).action === 'create' && run({ email: 'a'.repeat(64) + '@' + 'b'.repeat(185) + '.com' }).action === 'create', 'an email with dots and a plus sign is accepted, and so is one of exactly 254 characters (the limit)');
  const several = run({ id: 'Bad_ID', confirm: 'x', name: 'A', email: 'nope' });
  check(several.reasons.length === 4, 'every problem is reported at once (a bad id, a wrong confirm, a bad name, a bad email), so a person fixes them in one go');
  check(run({ id: 'Bad_ID', confirm: 'Bad_ID' }, '<html>502</html>', '').reasons.length === 1 && /3 to 40/.test(run({ id: 'Bad_ID', confirm: 'Bad_ID' }, '<html>502</html>', '').reasons[0]), 'a bad input is reported even when the directory could not be fetched (the input checks come first)');

  // ---- it never decides blind --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  for (const [label, d] of [['an HTML error page', '<html>502 Bad Gateway</html>'], ['empty', ''], ['an error object', { error: 'unauthorized' }], ['businesses that is not a list', { businesses: 'x' }], ['entries without an id', { businesses: [{ name: 'x' }] }], ['entries that are not objects', { businesses: ['acme'] }], ['null', 'null']]) { const r = run({}, d); check(r.action === 'refuse' && r.code === 2 && /directory could not be read/.test(r.reasons[0]), `a directory that cannot be read (${label}) is a refusal: nothing is created blind`); }
  for (const [label, c] of [['an HTML error page', '<html>502</html>'], ['empty', ''], ['an error object', { error: 'bad request' }], ['conflicts that is not a list', { conflicts: 'none' }], ['entries without an email', { conflicts: [{ business_id: 'x' }] }], ['null', 'null']]) { const r = run({}, DIR, c); check(r.action === 'refuse' && r.code === 2 && /already taken\?' could not be read/.test(r.reasons[0]), `a clash answer that cannot be read (${label}) is a refusal`); }

  // ---- the email belongs to another business -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const taken = run({}, DIR, { conflicts: [{ email: 'owner@acme.co.za', business_id: 'another-company' }] });
  check(taken.action === 'refuse' && taken.reasons.some((x) => /already belongs to another business/.test(x)) && !/another-company/.test(taken.raw), 'an email that already belongs to another business is REFUSED, and the output does not say WHICH business (it never leaks one business\'s id into another\'s log)');
  check(run({ email: 'OWNER@ACME.CO.ZA' }, DIR, { conflicts: [{ email: 'Owner@Acme.co.za ', business_id: 'x' }] }).action === 'refuse', 'the clash is found whatever the case or spacing');
  check(run({}, DIR, { conflicts: [{ email: 'someone.else@acme.co.za', business_id: 'x' }] }).action === 'create', 'a clash for a DIFFERENT email does not stop this one');

  // ---- a business that already exists ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const exists = run({ id: 'zululand-flooring-and-blinds', confirm: 'zululand-flooring-and-blinds', name: 'Zululand' });
  check(exists.action === 'refuse' && exists.existing === true && exists.reasons.some((x) => /already exists and already has 4 member\(s\).*add-member/.test(x)), 'a business that already has members is REFUSED, so a typed id can never add a second owner to a live business (and the reason points to the add-member route)');
  const half = run({ id: 'half-made', confirm: 'half-made', name: 'Half Made' });
  check(half.action === 'resume' && half.code === 0 && half.existing === true && half.warnings.length === 1 && /half-created/.test(half.warnings[0]), 'a business that exists with NO members (a half-created one) may be completed: "resume", with a note saying so');
  const suspended = run({ id: 'gone-away', confirm: 'gone-away', name: 'Gone Away' });
  check(suspended.action === 'refuse' && suspended.reasons.some((x) => /exists but is not active/.test(x)), 'a business that exists but is not active is refused');
  const noCount = run({ id: 'half-made', confirm: 'half-made', name: 'Half Made' }, { businesses: [{ id: 'half-made', status: 'active' }] });
  check(noCount.action === 'refuse' && /member count could not be read/.test(noCount.reasons[0]), 'a business whose member count cannot be read is refused rather than assumed empty');
  check(run({}, { businesses: [] }).action === 'create', 'an empty directory is fine: the first business can be created');
  const missing = (() => { try { execFileSync('python3', [guard, '/no/such/a.json', '/no/such/b.json'], { env: { ...process.env, BUSINESS_ID: 'acme-floors', BUSINESS_NAME: 'Acme Floors', OWNER_EMAIL: 'o@acme.co.za', CONFIRM: 'acme-floors' }, stdio: ['pipe', 'pipe', 'pipe'] }); return 0; } catch (e) { return e.status; } })();
  check(missing === 2, 'files that do not exist are a refusal too');

  // ---- the workflow --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const raw = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'prod-new-business.yml'), 'utf8'), code = raw.replace(/^\s*#.*$/gm, '');
  const triggers = code.slice(code.indexOf('on:'), code.indexOf('concurrency:'));
  const step = (name) => { const i = code.indexOf(`- name: ${name}`); const j = code.indexOf('\n      - name:', i + 5); return code.slice(i, j < 0 ? code.length : j); };
  check(/workflow_dispatch:/.test(triggers) && !/schedule:|push:|pull_request:|workflow_call:/.test(triggers) && ['business_id', 'business_name', 'owner_email', 'confirm'].every((k) => new RegExp(`${k}:[\\s\\S]*?required: true`).test(triggers)), 'it starts by hand only, with four REQUIRED inputs (id, name, owner email, confirm)');
  const posts = [...code.matchAll(/-X\s*(POST|PUT|DELETE|PATCH)\s+"[^"]*"/g)].map((m) => m[0]);
  check(posts.length === 2 && /\/debug\/directory\/check-members/.test(posts[0]) && /\/debug\/directory\/create-business/.test(posts[1]), 'it makes exactly TWO posts: the read-only email check, then the one create');
  const createStep = step("Create the business and its owner (the only write; a single attempt)");
  check(/if: steps\.guard\.outputs\.action == 'create' \|\| steps\.guard\.outputs\.action == 'resume'/.test(createStep) && createStep.includes('/debug/directory/create-business') && /id: guard/.test(step('Decide what may happen (writes nothing)')), 'the create step runs ONLY when the guard decided create or resume');
  check(!/for attempt in|while |until |sleep /.test(createStep), 'the create is a SINGLE attempt: no retry loop');
  check(/exit \$GUARD/.test(step('Decide what may happen (writes nothing)')) && /python3 tools\/new-business-guard\.py "\$RESULTS\/directory\.json" "\$RESULTS\/conflicts\.json"/.test(step('Decide what may happen (writes nothing)')), 'a refusal makes the run go RED (the guard\'s exit status is the step\'s) and it is handed both files it needs');
  const runs = [...code.matchAll(/run: \|([\s\S]*?)(?=\n      - |\n[a-z]|$)/g)].map((m) => m[1]).join('\n');
  check(!/\$\{\{\s*(github\.event\.inputs|inputs)/.test(runs) && ['business_id', 'business_name', 'owner_email', 'confirm'].every((k) => new RegExp(`: \\$\\{\\{ github\\.event\\.inputs\\.${k} \\}\\}`).test(code)), 'what a person types reaches the scripts only through environment variables, never pasted into a script (no injection)');
  check(/json\.dumps\(\{'id': d\['business_id'\], 'name': d\['name'\], 'owner_email': os\.environ\['OWNER_EMAIL'\]\.strip\(\)\.lower\(\), 'plan': 'standard'\}\)/.test(createStep) && /-d @"\$RESULTS\/create-request\.json"/.test(createStep) && /json\.dumps\(\{'business_id'/.test(step("Ask whether the owner's email is already taken (reads only)")), 'both request bodies are built by Python (the id and name from the guard\'s tidied decision) and sent from a file, not assembled in shell; the plan is fixed to standard');
  check(JSON.stringify([...new Set([...code.matchAll(/secrets\.([A-Z_]+)/g)].map((m) => m[1]))].sort()) === JSON.stringify(['PROD_ADMIN_KEY', 'PROD_CONFIRM_KEY']) && /PROD_URL: https:\/\/office\.websitehub\.co\.za/.test(code), 'it uses only the two production admin secrets, against production');
  check(['Ask whether the owner\'s email is already taken (reads only)', 'Create the business and its owner (the only write; a single attempt)'].every((n) => /PROD_CONFIRM_KEY/.test(step(n))) && !/PROD_CONFIRM_KEY/.test(code.replace(step("Ask whether the owner's email is already taken (reads only)"), '').replace(createStep, '')), 'the confirmation key is available to those TWO steps only (the check and the create)');
  const recordStep = step('Record what happened');
  check(/if: always\(\)/.test(recordStep) && /ops\/production-new-business-last\.json/.test(recordStep) && !/OWNER_EMAIL|ownerMasked|owner_email|ADMIN|CONFIRM/.test(recordStep), 'it records what happened even when it fails, and the record step has no secret and never touches the owner\'s email');
  check(/ownerMasked/.test(step('Decide what may happen (writes nothing)')) && !/OWNER_EMAIL/.test(step('Decide what may happen (writes nothing)').replace(/python3 tools[^\n]*/, '')), 'the summary shows the owner only as the masked address');
  const verify = step('Check it afterwards (reads only)');
  check(/if: always\(\) && \(steps\.guard\.outputs\.action == 'create' \|\| steps\.guard\.outputs\.action == 'resume'\)/.test(verify) && /X-Target-Business: \$BUSINESS_ID/.test(verify) && /health\.get\("business"\) == bid/.test(verify) && /mine\.get\("plan"\) == "standard"/.test(verify) && /mine\["members"\] >= 1/.test(verify) && /sys\.exit\(0 if all\(checks\.values\(\)\) else 1\)/.test(verify), 'afterwards it checks, and a failure turns the run red: in the directory, active, on the standard plan; the owner is a member; its own object answers AS ITSELF');
  check(/concurrency:\s*\n\s*group: prod-new-business\s*\n\s*cancel-in-progress: false/.test(code), 'two creations can never run at once, and a running one is never cancelled half way');
};
