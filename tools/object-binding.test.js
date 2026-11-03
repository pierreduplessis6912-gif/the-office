// OWNERSHIP OF A BUSINESS OBJECT: who may establish it, and that nothing ordinary can change it (worker/src/business-object.ts; branch engine-phase1). TESTS ONLY: no source file was changed for them.
// THE PRINCIPLE (from the review of 2026-11-03): provisioning CREATES identity, requests EXERCISE it, verification CONFIRMS it, and the three must not become interchangeable. This suite pins what is true today about the first two and records, without endorsing it,
// what is not yet the principle: an ordinary request can still establish ownership of an unbound object (the first valid claim), where the principle says only authenticated provisioning should.
//   STATIC     the stored binding (the object_meta row `business_id`) is written in exactly one place, by a plain INSERT that cannot overwrite; nothing updates or deletes it; no meta-writer is ever given its key or a dynamic key; and the table is excluded from snapshots, restore and migration.
//   RESTORE    a restore leaves the binding exactly as it was.
//   REQUESTS   on a REAL object, requests of every shape (same claim, another business, malformed, missing, with admin keys) cannot create, change or reset the binding; the alarm never binds. With a runtime name and without one.
//   PROVISIONING both ways a business comes to exist (the admin create-business route and sign-up) create the directory row FIRST, then bind the object by an admin-keyed call, and the object ends bound to exactly that business under exactly that name.
// WHAT IS PINNED AS A KNOWN BEHAVIOUR, NOT A CONTRACT (each says so): an unauthenticated key naming an unknown business still creates and binds an object for it.
// Not here: the object-level states (a missing, malformed or mismatched stored binding, and the alarm), which are in tools/business-object.test.js beside the rest of the object contract.
const fs = require('fs'), path = require('path');
const kit = require('./engine-kit.js');
const ts = require(require.resolve('typescript', { paths: [kit.workerDir, path.join(kit.workerDir, 'node_modules')] }));

module.exports = kit.guard('object binding', async ({ check }) => {
  // ======================================================================================================================================================================================================================
  // STATIC: parsed with TypeScript's own parser, so comments never count
  // ======================================================================================================================================================================================================================
  const SRC = path.join(kit.workerDir, 'src');
  const listTs = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? listTs(path.join(dir, e.name)) : e.name.endsWith('.ts') ? [path.join(dir, e.name)] : []));
  const GENERATED = new Set(['schema-steps.ts', 'baseline-sql.ts']);
  const info = {};   // file -> { strings: [text], metaCalls: [{ key: string|null }] }
  for (const file of listTs(SRC)) {
    const rel = path.relative(SRC, file).split(path.sep).join('/'); if (GENERATED.has(rel)) continue;
    const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true), f = { strings: [], metaCalls: [], skipTables: null };
    const lit = (n) => n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n));
    const visit = (n) => {
      if (lit(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) f.strings.push(n.text);
      if (ts.isCallExpression(n)) {
        const callee = ts.isIdentifier(n.expression) ? n.expression.text : ts.isPropertyAccessExpression(n.expression) ? n.expression.name.text : null;
        if (callee === 'setMeta') { const a = n.arguments.slice(0, 2).find(lit); f.metaCalls.push({ key: a ? a.text : null }); }   // setMeta(key, value) or setMeta(env, key, value): the key is the first string literal; null means a key that is not a literal
      }
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === 'SKIP_TABLES' && n.initializer && ts.isNewExpression(n.initializer) && n.initializer.arguments && n.initializer.arguments[0] && ts.isArrayLiteralExpression(n.initializer.arguments[0])) f.skipTables = n.initializer.arguments[0].elements.filter(lit).map((e) => e.text);
      ts.forEachChild(n, visit);
    };
    visit(sf); info[rel] = f;
  }
  check(Object.keys(info).length > 60 && info['business-object.ts'], `FIXTURE: ${Object.keys(info).length} source files parsed`);
  const stmts = (re) => Object.entries(info).flatMap(([file, f]) => f.strings.filter((s) => re.test(s)).map((s) => ({ file, s })));

  const keyed = stmts(/object_meta/).filter(({ s }) => /business_id/.test(s));
  const verbs = keyed.map(({ file, s }) => `${file} ${/^\s*INSERT/i.test(s) ? 'INSERT' : /^\s*SELECT/i.test(s) ? 'SELECT' : 'OTHER'}${/ON CONFLICT/i.test(s) ? ' (upsert)' : ''}`).sort();
  check(JSON.stringify(verbs) === JSON.stringify(['business-object.ts INSERT', 'business-object.ts SELECT', 'business-object.ts SELECT']), `STATIC: the key business_id is named in exactly three statements, all in business-object.ts: two reads and ONE plain INSERT that cannot overwrite (an upsert would be listed as such) [${verbs.join('; ')}]`);
  check(stmts(/(UPDATE|DELETE\s+FROM)\s+object_meta/i).length === 0, 'STATIC: no statement anywhere in production code updates or deletes object_meta, so the binding can be written once and never changed or reset by application code');
  const inserts = stmts(/INSERT[^;]*INTO\s+object_meta/i).filter(({ s }) => !/business_id/.test(s));
  check(inserts.length >= 3 && inserts.every(({ s }) => /ON CONFLICT/i.test(s)), `STATIC: every OTHER write to object_meta is a keyed upsert (${inserts.length} of them), so the only writer that has no conflict clause is the binding's own`);
  const calls = Object.entries(info).flatMap(([file, f]) => f.metaCalls.map((c) => ({ file, ...c })));
  check(calls.length >= 15 && calls.every((c) => c.key !== null), `STATIC: all ${calls.length} calls of a meta-writer pass a LITERAL key, so no request can choose which key is written`);
  check(!calls.some((c) => c.key === 'business_id'), 'STATIC: and none of them passes business_id');
  const skip = Object.values(info).map((f) => f.skipTables).find(Boolean);
  check(Array.isArray(skip) && skip.includes('object_meta'), 'STATIC: object_meta is in SKIP_TABLES, the list snapshots, restore, fingerprints and the migration routes all respect: none of them can copy, wipe or overwrite the binding');

  // ======================================================================================================================================================================================================================
  // RESTORE: the binding is untouched
  // ======================================================================================================================================================================================================================
  const bk = kit.bundle('backup.ts', 'backup');
  const w = kit.makeWorld({ backups: true });
  w.db.prepare("INSERT OR REPLACE INTO object_meta (key, value) VALUES ('business_id', 'eng-a')").run();
  for (let i = 1; i <= 4; i++) w.db.prepare('INSERT INTO customers (name, address) VALUES (?, ?)').run('C' + i, 'S' + i);
  const snap = await bk.takeSnapshot(w.env, new Date('2026-11-03T03:00:00Z'));
  check(!snap.tables.some((t) => t.name === 'object_meta'), 'RESTORE: a snapshot does not contain object_meta at all');
  w.db.prepare("INSERT INTO customers (name) VALUES ('DAMAGE')").run();
  const rep = await bk.restoreSnapshot(w.env, snap.name, 'eng-a');
  const row = () => w.db.prepare("SELECT value FROM object_meta WHERE key = 'business_id'").get();
  check(rep.ok === true && w.db.prepare("SELECT COUNT(*) AS n FROM customers WHERE name = 'DAMAGE'").get().n === 0 && row() && row().value === 'eng-a', 'RESTORE: a restore replaces the business\'s data and leaves the binding exactly as it was');

  // ======================================================================================================================================================================================================================
  // REQUESTS: what ordinary requests can do to a bound object, on a REAL object, with and without a runtime name
  // ======================================================================================================================================================================================================
  const hdr = (claim, extra = {}) => ({ headers: { ...(claim === undefined ? {} : { 'X-Business-Id': claim }), ...extra } });
  for (const exposeIdentity of [true, false]) {
    const f = await kit.makeFleet({ ids: ['alpha-co', 'beta-co'], exposeIdentity });
    const bound = (b) => f.raws[b].prepare("SELECT value FROM object_meta WHERE key = 'business_id'").get()?.value ?? null;
    const label = exposeIdentity ? 'with a runtime name' : 'WITHOUT a runtime name (the binding layer alone)';
    check((await f.direct('alpha-co', '/health', hdr('alpha-co'))).status === 200 && bound('alpha-co') === 'alpha-co', `REQUESTS (${label}): the first valid claim binds the object`);
    const probes = [['the same claim again', 'alpha-co', {}, 200], ['another business', 'beta-co', {}, 403], ['another business, with the admin keys', 'beta-co', { 'X-Admin-Key': 'fleet-admin', 'X-Admin-Confirm': 'fleet-confirm' }, 403], ['a claim that is not a business id', 'NOT a business!', {}, 400], ['an uppercase claim', 'ALPHA-CO', {}, 400], ['no claim at all', undefined, {}, 400], ['only a target header', undefined, { 'X-Target-Business': 'beta-co' }, 400]];
    for (const [what, claim, extra, status] of probes) {
      const r = await f.direct('alpha-co', '/health', hdr(claim, extra));
      check(r.status === status && bound('alpha-co') === 'alpha-co', `REQUESTS (${label}): ${what}: answered ${r.status}${r.status === status ? '' : ' (expected ' + status + ')'} and the binding is still alpha-co`);
    }
    check(bound('beta-co') === null, `REQUESTS (${label}): the other object, never named, is still unbound: nothing sent to alpha's object reached it`);
    // the alarm acts for a bound business but can never create ownership
    const woken = await f.wake('delta-co'); await woken.alarm();
    check(bound('delta-co') === null, `REQUESTS (${label}): the hourly alarm firing on an object nobody has named does NOT bind it`);
  }

  // ======================================================================================================================================================================================================================
  // PROVISIONING: both ways a business comes to exist, against REAL objects, with the call log checking ORDER
  // ======================================================================================================================================================================================================================
  const admin = (f, p, body) => f.front(p, { method: 'POST', headers: { 'X-Admin-Key': 'fleet-admin', 'X-Admin-Confirm': 'fleet-confirm', 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const prov = await kit.makeFleet({ ids: [], directory: true, autoWake: true });
  const boundOf = (f, b) => f.raws[b] ? f.raws[b].prepare("SELECT value FROM object_meta WHERE key = 'business_id'").get()?.value ?? null : undefined;
  const firstCall = (f, name) => f.calls.find((c) => c.name === name);

  const made = await admin(prov, '/debug/directory/create-business', { id: 'prov-co', name: 'Prov Co', owner_email: 'owner@prov.example' });
  const first = firstCall(prov, 'business-prov-co');
  check(made.status === 200 && first && first.adminKey && first.directoryHasRow === true, `PROVISIONING (admin create-business): the directory row exists BEFORE the object's first request, and that first request carries the admin key (${made.status}; first call: ${first && first.method} ${first && first.path}, directory row: ${first && first.directoryHasRow})`);
  check(boundOf(prov, 'prov-co') === 'prov-co' && prov.objects['business-prov-co'].state.id.name === 'business-prov-co' && first.claim === 'prov-co', 'PROVISIONING (admin create-business): the object ends bound to exactly that business, under exactly the name business-<id>, and the claim of the first request was that business');
  const intruder = await prov.direct('prov-co', '/health', hdr('someone-else'));
  check(intruder.status === 403 && boundOf(prov, 'prov-co') === 'prov-co', 'PROVISIONING (admin create-business): once provisioned, a request naming another business is refused and the binding stands');
  const again = await admin(prov, '/debug/directory/create-business', { id: 'prov-co', name: 'Prov Co', owner_email: 'owner@prov.example' });
  check(boundOf(prov, 'prov-co') === 'prov-co', `PROVISIONING (admin create-business): repeating the same creation (status ${again.status}) leaves the binding unchanged`);
  await admin(prov, '/debug/directory/create-business', { id: 'mig-co', name: 'Mig Co', migrating: true });
  const mig = firstCall(prov, 'business-mig-co');
  check(mig && mig.method === 'GET' && mig.path === '/health' && mig.adminKey && mig.directoryHasRow === true && boundOf(prov, 'mig-co') === 'mig-co', `PROVISIONING (a migration target): the first request is the admin-keyed health call, after the directory row exists, and it binds the object (${mig && mig.method} ${mig && mig.path})`);
  check(boundOf(prov, 'prov-co') === 'prov-co' && boundOf(prov, 'mig-co') === 'mig-co' && boundOf(prov, 'prov-co') !== boundOf(prov, 'mig-co'), 'PROVISIONING: two provisioned businesses are bound to two different ids');

  // sign-up, through the real entry point, into a real object
  const signup = kit.bundle('signup.ts', 'obsignup');
  const sf = await kit.makeFleet({ ids: [], directory: true, autoWake: true });
  const post = (fields) => new Request('https://office.websitehub.co.za/auth/signup', { method: 'POST', body: new URLSearchParams(fields), headers: { 'CF-Connecting-IP': '1.2.3.4' } });
  const token = await sf.auth.signSignupToken(sf.env, 'new@owner.example');
  const res = await signup.handleSignupPost(post({ token, business_name: 'Acme Floors', agree: 'on' }), sf.env);
  const id = await signup.businessIdFor('Acme Floors', 'new@owner.example'), sFirst = firstCall(sf, 'business-' + id);
  check(res.status === 303 && sFirst && sFirst.adminKey && sFirst.directoryHasRow === true && sFirst.claim === id, `PROVISIONING (sign-up): the directory row exists BEFORE the object's first request, which carries the admin key and the server-derived id (${res.status}; first call ${sFirst && sFirst.method} ${sFirst && sFirst.path})`);
  check(boundOf(sf, id) === id && sf.objects['business-' + id].state.id.name === 'business-' + id && id.startsWith('acme-floors-'), `PROVISIONING (sign-up): the object ends bound to the server-derived id (${id}) under exactly the name business-<id>`);
  const callsBefore = sf.calls.length;
  await signup.handleSignupPost(post({ token: await sf.auth.signSignupToken(sf.env, 'new@owner.example'), business_name: 'Acme Floors', agree: 'on' }), sf.env);
  check(boundOf(sf, id) === id && sf.calls.length > callsBefore && Object.keys(sf.raws).length === 1, 'PROVISIONING (sign-up): the same person submitting again finds their business and creates no second object; the binding is unchanged');
  const wrongClaim = await sf.direct(id, '/health', hdr('acme-floors-other'));
  check(wrongClaim.status === 403 && boundOf(sf, id) === id, 'PROVISIONING (sign-up): a request naming another business is refused by the new object');

  // ======================================================================================================================================================================================================================
  // OBSERVATION, recorded and NOT endorsed: an UNAUTHENTICATED key naming an unknown business still creates and binds an object
  // ======================================================================================================================================================================================================================
  const ghost = await kit.makeFleet({ ids: [], directory: true, autoWake: true });
  const key = 'omk.ghost-co.0123456789abcdef.' + 'A'.repeat(43);
  const gr = await ghost.front('/mcp', { method: 'POST', headers: { Authorization: 'Bearer ' + key, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  const directoryHasGhost = ghost.directoryRaw ? (() => { try { return Boolean(ghost.directoryRaw.prepare("SELECT 1 FROM businesses WHERE id = 'ghost-co'").get()); } catch { return false; } })() : null;
  check(gr.status >= 400 && gr.status < 500 && boundOf(ghost, 'ghost-co') === 'ghost-co' && directoryHasGhost === false, `OBSERVATION (a recorded behaviour, NOT a security contract; the principle says only authenticated provisioning should bind): a well-formed key naming a business that is NOT in the directory is refused (${gr.status}) yet its object was created and bound to "ghost-co" by that unauthenticated request (directory row: ${directoryHasGhost})`);
});

if (require.main === module) kit.standalone(module.exports);
