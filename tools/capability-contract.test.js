// Capability contract PROOF (branch claim/proof-1, decided with Pierre 2026-11-01). TESTS FIRST: this file says what a declared capability contract must ENFORCE,
// before any of it is written. The question it answers is not "can a capability be described?" but "can the old declarations (the intent union, the creation gate,
// the confirm-permission map, a directly written held action) get round the contract?". If they can, the contract only documents the architecture and does not establish it.
//
// ONE synthetic capability, `log_visit`, and three synthetic businesses described by EXPLICIT TEST CONFIGURATION (env.CAPABILITY_CONFIG, keyed by env.BUSINESS_ID):
//   visits-a  offers log_visit, rand, Johannesburg      visits-c  offers log_visit, dollar, New York      visits-b  does NOT offer it, dollar, New York
// so availability is told apart from currency and time zone (c against b differ only in availability) and from permissions (roles are tested separately).
// The contract (to be written, worker/src/capability-contract.ts):
//   payload   { client: 1..80 characters, minutes: a whole number 1..1440, note?: up to 500 characters }, nothing else
//   available only where env.CAPABILITY_CONFIG[env.BUSINESS_ID].available lists it; a business with no entry offers nothing (fail closed)
//   permission the confirming member needs can_make_quotes (checked by the contract itself, whatever the legacy map says)
//   refusals  a 4xx whose body.error is exactly capability_unavailable, invalid_payload or not_permitted; nothing is written and the held action stays pending
//   execution one row in proof_visits (a table THIS TEST creates: wiring a real table to production would need a migration, which the restore gate still forbids)
//   the door  proposeCapability(env, { capability, payload, transcript, source }): the raw request is captured FIRST; an unavailable, unknown or invalid request writes
//             NOTHING ELSE (no customer, note, life event or held action) and is answered honestly
// Expected state when this file is first committed: RED, for the right reasons (the module and the confirm hook do not exist). The CONTROL checks, which describe behaviour
// that must not change, pass from the start; a test that could pass by accident would prove nothing.
const fs = require('fs'), os = require('os'), path = require('path'), esbuild = require('esbuild');
const harness = require('./harness.js');

module.exports = async function runCapabilityContractTests({ check, bundleTo, srcDir }) {
  const workerDir = path.join(srcDir, '..');
  const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  // ---- explicit test configuration -------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const CONFIG = {
    'visits-a': { available: ['log_visit'], currency: 'ZAR', timeZone: 'Africa/Johannesburg' },
    'visits-b': { available: [], currency: 'USD', timeZone: 'America/New_York' },
    'visits-c': { available: ['log_visit'], currency: 'USD', timeZone: 'America/New_York' },
  };
  const envFor = (id) => ({ BUSINESS_ID: id, CAPABILITY_CONFIG: CONFIG });
  const PROOF_DDL = "CREATE TABLE IF NOT EXISTS proof_visits (id INTEGER PRIMARY KEY AUTOINCREMENT, client TEXT NOT NULL, minutes INTEGER NOT NULL, note TEXT, pending_action_id INTEGER, created_at TEXT DEFAULT (datetime('now')))";
  const GOOD = { client: 'Mokoena', minutes: 45, note: 'second coat' };
  const BAD = [
    ['minutes of zero', { client: 'Mokoena', minutes: 0 }],
    ['minutes that is not a whole number', { client: 'Mokoena', minutes: 1.5 }],
    ['minutes over a day', { client: 'Mokoena', minutes: 1441 }],
    ['minutes given as text', { client: 'Mokoena', minutes: '45' }],
    ['no client', { minutes: 45 }],
    ['a blank client', { client: '   ', minutes: 45 }],
    ['a field the contract does not declare', { client: 'Mokoena', minutes: 45, surprise: true }],
    ['a payload that is not an object', 'Mokoena 45'],
    ['a null payload', null],
  ];

  // ---- two builds of the real request handler: as it is, and with a LEGACY declaration for the new type added to the old confirm-permission map -----------------------------------------------------
  // The second stands for someone declaring log_visit the old way (here: let anyone who can know jobs confirm it). The contract must not be loosened by that.
  const build = async (tag, legacyDeclaration) => {
    const expose = {
      name: 'expose-for-capability-proof',
      setup(b) {
        b.onLoad({ filter: /src[\\/]index\.ts$/ }, (a) => ({ contents: fs.readFileSync(a.path, 'utf8') + '\nexport { processOneExtraction as __poe, processTranscript as __pt, handleRequest as __hr, serveRequest as __sr };\n', loader: 'ts' }));
        if (legacyDeclaration) b.onLoad({ filter: /src[\\/]auth\.ts$/ }, (a) => {
          const marker = 'export const ACTION_TYPE_CAPABILITY: Record<string, string[]> = {';
          const src = fs.readFileSync(a.path, 'utf8');
          if (!src.includes(marker)) throw new Error('capability proof: the legacy confirm-permission map moved; update this test');
          return { contents: src.replace(marker, marker + '\n  ' + legacyDeclaration), loader: 'ts' };
        });
      },
    };
    const out = path.join(os.tmpdir(), `cc-proof-${tag}-${process.pid}.js`), authOut = path.join(os.tmpdir(), `cc-proof-auth-${process.pid}.js`);
    await esbuild.build({ entryPoints: [path.join(workerDir, 'src', 'index.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent', plugins: [expose] });
    await esbuild.build({ entryPoints: [path.join(workerDir, 'src', 'auth.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: authOut, logLevel: 'silent' });
    const mod = require(out);
    return { processOne: mod.__poe, processTranscript: mod.__pt, handleRequest: mod.__hr, serveRequest: mod.__sr, auth: require(authOut) };
  };
  const real = await build('real', null);
  const legacy = await build('legacy', 'log_visit: ["can_know_jobs"],');

  // ---- helpers over the harness's route runner: the REAL request handler, the REAL authentication gate, a real SQLite, and a before-and-after diff of every table ------------------------------------
  const run = (fns, spec) => harness.runRouteCase(fns, workerDir, { method: 'POST', path: '/actions/1/confirm', body: {}, role: 'owner', ...spec });
  const hold = (payload, type = 'log_visit') => (db) => {
    db.exec(PROOF_DDL);
    db.prepare("INSERT INTO pending_actions (id, type, payload, source_transcript, status) VALUES (1, ?, ?, ?, 'pending')").run(type, JSON.stringify(payload), 'visit at Mokoena for 45 minutes');
  };
  const added = (r, table) => ((r.writes && r.writes[table] && r.writes[table].added) || []);
  const confirmed = (r) => ((r.writes && r.writes.pending_actions && r.writes.pending_actions.changed) || []).some((c) => c.after && c.after.status === 'confirmed');
  const refusedWith = (r, code) => Boolean(r.result) && r.result.status >= 400 && r.result.status < 500 && Boolean(r.result.body) && r.result.body.error === code;
  const nothingExecuted = (r) => added(r, 'proof_visits').length === 0 && !confirmed(r);
  const why = (r) => (r.threw ? 'threw: ' + String(r.threw).slice(0, 80) : r.result ? `got ${r.result.status} ${JSON.stringify(r.result.body && r.result.body.error)}` : 'no result');

  // ==== CONTROLS: behaviour that exists today and must not change (these pass before any change) ================================================================================================
  let r = await run(real, { name: 'control: a held type nobody knows fails closed', seed: hold(GOOD, 'no_such_type') });
  check(r.result && r.result.status === 400 && /unknown pending action type/.test(JSON.stringify(r.result.body)), 'CONTROL: a held action of an unknown type is refused as unknown (' + why(r) + ')');
  check(!r.writes.pending_actions && !confirmed(r), 'CONTROL: and the claim is released: the action is still pending, nothing happened');

  for (const role of ['installer', 'accountant']) {
    r = await run(real, { name: `control: ${role} cannot confirm an unclassified type`, seed: hold(GOOD), env: envFor('visits-a'), role });
    check(r.result && r.result.status === 403 && nothingExecuted(r), `CONTROL: a ${role} cannot confirm log_visit through the legacy gate, which denies every type nobody classified (${why(r)})`);
  }

  r = await run(real, { name: 'control: editing a held action is closed for other types', seed: hold(GOOD), env: envFor('visits-a'), path: '/actions/1/edit-field', body: { field: 'minutes', value: '9999' } });
  check(r.result && r.result.status === 400 && /editing isn't available/.test(JSON.stringify(r.result.body)), 'CONTROL: a held log_visit cannot be edited into an invalid payload (the edit route refuses every type but one)');

  // ==== THE CONFIRM HOOK (red until it exists): each refusal names its own reason, so "unknown type" cannot pass for it ======================================================================
  r = await run(real, { name: 'confirm: available, valid, permitted', seed: hold(GOOD), env: envFor('visits-a') });
  check(r.result && r.result.status === 200 && added(r, 'proof_visits').length === 1 && confirmed(r), 'an available capability with a valid payload, confirmed by a permitted member, executes (' + why(r) + ')');
  const visit = added(r, 'proof_visits')[0];
  check(Boolean(visit) && visit.client === 'Mokoena' && visit.minutes === 45 && visit.note === 'second coat' && visit.pending_action_id === 1, 'the outcome is exactly what was approved, and points back at the held action');
  check(Boolean(r.result && r.result.body && r.result.body.outcome && r.result.body.outcome.minutes === 45), 'the reply reports the real outcome, not just "ok"');

  r = await run(real, { name: 'confirm: not available in this business', seed: hold(GOOD), env: envFor('visits-b') });
  check(refusedWith(r, 'capability_unavailable') && nothingExecuted(r), 'the OWNER cannot execute a capability this business does not have (' + why(r) + ')');

  r = await run(real, { name: 'confirm: business with no configuration', seed: hold(GOOD), env: envFor('visits-z') });
  check(refusedWith(r, 'capability_unavailable') && nothingExecuted(r), 'a business with no entry in the configuration offers nothing: unavailable, never "available by default" (' + why(r) + ')');

  for (const [label, payload] of BAD) {
    r = await run(real, { name: 'confirm: invalid payload ' + label, seed: hold(payload), env: envFor('visits-a') });
    check(refusedWith(r, 'invalid_payload') && nothingExecuted(r), `a held action written DIRECTLY with ${label} is refused at confirm, not executed (${why(r)})`);
  }

  // ==== THE DECISIVE TESTS: legacy declarations must not get round the contract ===============================================================================================================================
  r = await run(legacy, { name: 'bypass: weak legacy permission, installer', seed: hold(GOOD), env: envFor('visits-a'), role: 'installer' });
  check(refusedWith(r, 'not_permitted') && nothingExecuted(r), 'a LEGACY declaration that lets an installer confirm log_visit does not let one: the contract needs can_make_quotes (' + why(r) + ')');
  r = await run(legacy, { name: 'bypass: weak legacy permission, unavailable business', seed: hold(GOOD), env: envFor('visits-b'), role: 'owner' });
  check(refusedWith(r, 'capability_unavailable') && nothingExecuted(r), 'declaring the type in the legacy map does not make it available to a business that lacks it (' + why(r) + ')');
  r = await run(legacy, { name: 'bypass: weak legacy permission, invalid payload', seed: hold({ client: 'Mokoena', minutes: -5 }), env: envFor('visits-a'), role: 'owner' });
  check(refusedWith(r, 'invalid_payload') && nothingExecuted(r), 'declaring the type in the legacy map does not exempt its payload from the contract (' + why(r) + ')');
  r = await run(legacy, { name: 'bypass: legacy declaration, everything valid', seed: hold(GOOD), env: envFor('visits-a'), role: 'owner' });
  check(r.result && r.result.status === 200 && added(r, 'proof_visits').length === 1, 'with a legacy declaration present the valid, available, permitted case still executes exactly once (' + why(r) + ')');

  // ==== AVAILABILITY is independent of currency, time zone and role =========================================================================================================================================
  const decisions = {};
  for (const id of ['visits-a', 'visits-c', 'visits-b', 'visits-z']) {
    const x = await run(real, { name: 'matrix ' + id, seed: hold(GOOD), env: envFor(id) });
    decisions[id] = x.result && x.result.status === 200 && added(x, 'proof_visits').length === 1 ? 'executed' : refusedWith(x, 'capability_unavailable') ? 'unavailable' : 'other: ' + why(x);
  }
  check(sameJson(decisions, { 'visits-a': 'executed', 'visits-c': 'executed', 'visits-b': 'unavailable', 'visits-z': 'unavailable' }), 'availability follows the configuration only: a (rand, Johannesburg) and c (dollar, New York) both execute, b (dollar, New York) does not: ' + JSON.stringify(decisions));

  // ==== ATOMICITY: a failure part-way leaves nothing behind and says so ======================================================================================================================================
  const counted = await run(real, { name: 'atomic: count the writes', seed: hold(GOOD), env: envFor('visits-a'), failAtWrite: 0 });
  const countedOk = Boolean(counted.result) && counted.result.status === 200 && counted.writeCount >= 3;
  check(countedOk, 'the executing path writes at least the claim, the visit and the outcome (' + why(counted) + ', writes: ' + counted.writeCount + ')');
  if (countedOk) {
    for (let n = 1; n <= counted.writeCount; n++) {
      const f = await run(real, { name: 'atomic: fail at write ' + n, seed: hold(GOOD), env: envFor('visits-a'), failAtWrite: n });
      const honest = f.result ? f.result.status >= 400 : Boolean(f.threw);
      check(nothingExecuted(f) && honest, `a failure at write ${n} of ${counted.writeCount} leaves no visit, no confirmation, and an honest failure (${why(f)})`);
    }
  }

  // ==== THE DOOR: a scripted proposal. The raw request is kept; an unavailable or invalid one writes NOTHING ELSE ====================================================================================
  let door = null;
  try { door = bundleTo('capability-contract.ts', 'cc-proof-contract.js'); } catch (e) { door = null; }
  const doorCheck = async (name, body) => { if (!door || typeof door.proposeCapability !== 'function') { check(false, name + ' (worker/src/capability-contract.ts does not exist yet, or does not export proposeCapability)'); return; } await body(); };
  const world = (id) => {
    const db = harness.newDatabase(workerDir); db.exec(PROOF_DDL);
    const puts = [];
    const kv = { async put(k) { puts.push(k); }, async get() { return null; }, async delete() {}, async list() { return { keys: [], list_complete: true, cursor: null }; } };
    return { db, puts, env: { OFFICE_DB: harness.d1(db), CUSTOMER_NOTES: kv, BUSINESS_ID: id, CAPABILITY_CONFIG: CONFIG } };
  };
  const counts = (db) => { const o = {}; for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()) o[name] = Number(db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get().n); return o; };
  const changed = (b, a) => Object.keys(a).filter((t) => (a[t] || 0) !== (b[t] || 0)).sort();
  const request = (payload, extra) => ({ capability: 'log_visit', payload, transcript: 'visit at Mokoena for 45 minutes', source: 'text', ...(extra || {}) });

  await doorCheck('a valid proposal in an available business is held', async () => {
    const w = world('visits-a'), before = counts(w.db);
    const x = await door.proposeCapability(w.env, request(GOOD));
    check(x && x.status === 'held' && Number.isInteger(x.actionId), 'a valid proposal where the capability is available is held for confirmation');
    const held = w.db.prepare('SELECT type, payload, status FROM pending_actions WHERE id = ?').get(x && x.actionId);
    check(Boolean(held) && held.type === 'log_visit' && held.status === 'pending' && sameJson(JSON.parse(held.payload), GOOD), 'the held action carries the declared type and exactly the validated payload');
    check(sameJson(changed(before, counts(w.db)), ['captures', 'pending_actions']), 'only the capture and the held action were written: ' + changed(before, counts(w.db)).join(', '));
    check(w.db.prepare("SELECT COUNT(*) AS n FROM captures WHERE raw_text = 'visit at Mokoena for 45 minutes'").get().n === 1, 'the original request is preserved word for word');
  });

  await doorCheck('an unavailable capability is preserved and refused, and nothing else is created', async () => {
    const w = world('visits-b'), before = counts(w.db);
    const x = await door.proposeCapability(w.env, request(GOOD));
    check(x && x.status === 'refused' && x.code === 'capability_unavailable', 'a request for a capability this business does not have is refused as unavailable');
    check(typeof x.message === 'string' && /not available/i.test(x.message), 'and the answer says plainly that it was not done: "' + (x && x.message) + '"');
    check(sameJson(changed(before, counts(w.db)), ['captures']), 'ONLY the capture was written: no customer, no note, no life event, no held action, no visit (' + changed(before, counts(w.db)).join(', ') + ')');
    check(w.db.prepare("SELECT COUNT(*) AS n FROM captures WHERE raw_text = 'visit at Mokoena for 45 minutes'").get().n === 1, 'the original request is preserved word for word');
    check(w.puts.length === 0, 'and nothing was written to the notes store');
  });

  await doorCheck('an unknown capability is preserved and refused, not invented', async () => {
    const w = world('visits-a'), before = counts(w.db);
    const x = await door.proposeCapability(w.env, request(GOOD, { capability: 'log_visit_for_everyone' }));
    check(x && x.status === 'refused' && x.code === 'unknown_capability', 'a capability nobody declared is refused as unknown');
    check(sameJson(changed(before, counts(w.db)), ['captures']) && w.puts.length === 0, 'ONLY the capture was written (' + changed(before, counts(w.db)).join(', ') + ')');
  });

  for (const [label, payload] of BAD) {
    await doorCheck('proposing ' + label, async () => {
      const w = world('visits-a'), before = counts(w.db);
      const x = await door.proposeCapability(w.env, request(payload));
      check(x && x.status === 'refused' && x.code === 'invalid_payload', `a proposal with ${label} is refused as invalid before anything is held`);
      check(sameJson(changed(before, counts(w.db)), ['captures']) && w.puts.length === 0, `and only the capture was written (${changed(before, counts(w.db)).join(', ')})`);
    });
  }

  await doorCheck('the door decides availability from configuration alone', async () => {
    const out = {};
    for (const id of ['visits-a', 'visits-c', 'visits-b', 'visits-z']) { const w = world(id); const x = await door.proposeCapability(w.env, request(GOOD)); out[id] = x && x.status === 'held' ? 'held' : x && x.code; }
    check(sameJson(out, { 'visits-a': 'held', 'visits-c': 'held', 'visits-b': 'capability_unavailable', 'visits-z': 'capability_unavailable' }), 'currency and time zone do not change the door\'s decision: ' + JSON.stringify(out));
  });
};
