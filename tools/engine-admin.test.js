// Engine admin routes (worker/src/engine/admin.ts, branch engine-phase1). TESTS FIRST. Two routes exist so the migration can be REHEARSED on real Cloudflare objects, and they are deliberately narrow:
//   GET  /admin/engine/status           (tier read)       the engine's state in one answer: mode, availability, a row count AND a content hash per engine table, and the integrity verifier's verdict
//   POST /admin/engine/provision-sample (tier privileged) puts an engine-empty business into engine mode with a small known sample, ONLY where ENGINE_REHEARSAL=1 (a staging variable production never has),
//                                                         only with the business id as confirmation, and refuses a business that already has engine data
// The hashes are the instrument the real rehearsal compares before and after a restore, so this suite proves they survive a restore and change when anything does.
const kit = require('./engine-kit.js');

module.exports = kit.guard('engine admin', async ({ check }) => {
  let admin; try { admin = kit.bundle('engine/admin.ts', 'engineadmin'); } catch (e) { admin = null; }
  check(Boolean(admin && admin.engineAdminRoute), 'worker/src/engine/admin.ts exists and builds (engineAdminRoute)');
  if (!admin || !admin.engineAdminRoute) return;
  const tiers = kit.bundle('admin-routes.ts', 'adminroutes').ADMIN_ROUTE_TIERS;
  const eng = kit.loadEngine();
  const call = async (env, method, path, body) => {
    const url = new URL('https://office.test' + path);
    const res = await admin.engineAdminRoute(new Request(url, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }), env, url);
    return res ? { status: res.status, body: await res.json() } : null;
  };
  const flagged = (w) => ({ ...w.env, ENGINE_REHEARSAL: '1' });

  check(tiers['GET /admin/engine/status'] === 'read' && tiers['POST /admin/engine/provision-sample'] === 'privileged', 'the status route is tier read and the provisioning route is tier PRIVILEGED (both admin secrets, off until the second is set)');
  const w0 = kit.makeWorld();
  check((await call(w0.env, 'GET', '/admin/backup/status')) === null && (await call(w0.env, 'GET', '/admin/engineer')) === null, 'a path outside /admin/engine/ is not this module\'s: it answers null so the next handler gets it');

  // ---- status ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const fresh = await call(w0.env, 'GET', '/admin/engine/status');
  check(fresh.status === 200 && fresh.body.mode === 'legacy' && fresh.body.rows === 0 && fresh.body.integrity.ok === true && Object.keys(fresh.body.tables).length === 16 && Object.keys(fresh.body.hashes).length === 16, 'a business that never used the engine reports: legacy mode, no rows, 16 empty engine tables each with a hash, integrity clean');
  const twice = await call(w0.env, 'GET', '/admin/engine/status');
  check(JSON.stringify(twice.body) === JSON.stringify(fresh.body), 'the status of an unchanged business is identical every time (a hash that moved on its own would be useless)');

  // ---- provisioning: refused unless every condition holds ----------------------------------------------------------------------------------------------------------------------------------------
  let before = w0.counts();
  let r = await call(w0.env, 'POST', '/admin/engine/provision-sample', { confirm: 'eng-a' });
  check(r.status === 404 && JSON.stringify(w0.counts()) === JSON.stringify(before), `without ENGINE_REHEARSAL=1 the route does not exist for this deployment (${r.status}) and nothing is written`);
  r = await call(flagged(w0), 'POST', '/admin/engine/provision-sample', { confirm: 'another-business' });
  check(r.status === 400 && JSON.stringify(w0.counts()) === JSON.stringify(before), 'with the wrong business id as confirmation it is refused and nothing is written');
  r = await call(flagged(w0), 'POST', '/admin/engine/provision-sample');
  check(r.status === 400 && JSON.stringify(w0.counts()) === JSON.stringify(before), 'with no confirmation at all it is refused and nothing is written');
  const noBusiness = { ...flagged(w0), BUSINESS_ID: undefined };
  r = await call(noBusiness, 'POST', '/admin/engine/provision-sample', { confirm: 'eng-a' });
  check(r.status === 400 && JSON.stringify(w0.counts()) === JSON.stringify(before), 'with no business named (the Worker-level call, not an object) it is refused');

  // ---- provisioning: what it does ---------------------------------------------------------------------------------------------------------------------------------------------------------------
  r = await call(flagged(w0), 'POST', '/admin/engine/provision-sample', { confirm: 'eng-a' });
  check(r.status === 200 && r.body.mode === 'engine' && r.body.integrity.ok === true, `with the flag and the confirmation it provisions: engine mode, integrity clean (${r.status})`);
  const t = r.body.tables;
  check(t.eng_party === 2 && t.eng_document === 2 && t.eng_document_line === 2 && t.eng_money_movement === 2 && t.eng_allocation === 2 && t.eng_reversal === 2 && t.eng_draft === 1 && t.eng_observation === 1 && t.eng_config === 2, 'the sample is exactly what the rehearsal expects: 2 parties, 2 invoices, a payment corrected (2 movements, 2 allocations, 2 reversals), 1 open draft, 1 observation, 2 settings: ' + JSON.stringify(t).slice(0, 200));
  check(JSON.stringify(r.body.available) === JSON.stringify(eng.capabilities.CAPABILITY_IDS), 'and the business is given every engine capability');
  before = w0.counts();
  const again = await call(flagged(w0), 'POST', '/admin/engine/provision-sample', { confirm: 'eng-a' });
  check(again.status === 409 && JSON.stringify(w0.counts()) === JSON.stringify(before), 'a business that already has engine data is refused (409) and nothing changes: it cannot be provisioned twice or topped up');

  // ---- the hashes are a trustworthy instrument: stable, sensitive, and they survive a restore -------------------------------------------------------------------------------------------------
  const w = kit.makeWorld({ backups: true });
  await call(flagged(w), 'POST', '/admin/engine/provision-sample', { confirm: 'eng-a' });
  const s1 = (await call(w.env, 'GET', '/admin/engine/status')).body;
  const bk = kit.bundle('backup.ts', 'backup');
  const snap = await bk.takeSnapshot(w.env, new Date('2026-11-02T03:00:00Z'));
  w.db.exec('PRAGMA foreign_keys = OFF');
  w.db.exec('DELETE FROM eng_reversal'); w.db.exec('DELETE FROM eng_allocation'); w.db.prepare('UPDATE eng_document_line SET unit_price_minor = 1').run();
  w.db.exec('PRAGMA foreign_keys = ON');
  const damaged = (await call(w.env, 'GET', '/admin/engine/status')).body;
  check(JSON.stringify(damaged.hashes) !== JSON.stringify(s1.hashes) && damaged.hashes.eng_document_line !== s1.hashes.eng_document_line && damaged.hashes.eng_allocation !== s1.hashes.eng_allocation, 'damage changes the hash of exactly the tables it touched: the instrument can see it');
  check(damaged.hashes.eng_party === s1.hashes.eng_party && damaged.hashes.eng_event === s1.hashes.eng_event, 'and leaves the hash of untouched tables alone');
  const report = await bk.restoreSnapshot(w.env, snap.name, 'eng-a');
  const s2 = (await call(w.env, 'GET', '/admin/engine/status')).body;
  check(report.ok && JSON.stringify(s2) === JSON.stringify(s1), 'after the restore the status is IDENTICAL to what it was before the damage: counts, hashes, mode, availability, integrity');

  // ---- the memory RAMP (staging only): fill ONE table with marker rows so a snapshot and a restore can be tried at size on a real object -------------------------------------------------------------
  // POST /admin/engine/ramp {confirm, rows}  tops the number of marker rows in `captures` (source = 'ramp', about 110 bytes each) up to `rows`, never removing any; POST /admin/engine/ramp-clear {confirm} removes exactly the marker rows.
  // Same conditions as provisioning: PRIVILEGED, only where ENGINE_REHEARSAL=1, only with the business id as confirmation. It touches the captures table and nothing else.
  check(tiers['POST /admin/engine/ramp'] === 'privileged' && tiers['POST /admin/engine/ramp-clear'] === 'privileged', 'the ramp routes are tier PRIVILEGED (both admin secrets)');
  const wr = kit.makeWorld();
  const ramped = (w) => w.db.prepare("SELECT COUNT(*) AS n FROM captures WHERE source = 'ramp'").get().n;
  const others = (w) => w.db.prepare("SELECT COUNT(*) AS n FROM captures WHERE source <> 'ramp'").get().n;
  let b4 = wr.counts();
  r = await call(wr.env, 'POST', '/admin/engine/ramp', { confirm: 'eng-a', rows: 50 });
  check(r.status === 404 && JSON.stringify(wr.counts()) === JSON.stringify(b4), `without ENGINE_REHEARSAL=1 the ramp does not exist for this deployment (${r.status}) and nothing is written`);
  r = await call(wr.env, 'POST', '/admin/engine/ramp-clear', { confirm: 'eng-a' });
  check(r.status === 404, 'nor does the clear route');
  for (const bad of [{ confirm: 'another-business', rows: 50 }, { rows: 50 }, { confirm: 'eng-a' }, { confirm: 'eng-a', rows: 0 }, { confirm: 'eng-a', rows: -5 }, { confirm: 'eng-a', rows: '50' }, { confirm: 'eng-a', rows: 1.5 }, { confirm: 'eng-a', rows: 2000001 }]) {
    r = await call(flagged(wr), 'POST', '/admin/engine/ramp', bad);
    check(r.status === 400 && JSON.stringify(wr.counts()) === JSON.stringify(b4), `a ramp request ${JSON.stringify(bad)} is refused (400) and nothing is written`);
  }
  r = await call(flagged(wr), 'POST', '/admin/engine/ramp', { confirm: 'eng-a', rows: 50 });
  check(r.status === 200 && r.body.rampRows === 50 && ramped(wr) === 50, 'a valid ramp request puts exactly the marker rows asked for into captures');
  const sample = wr.db.prepare("SELECT raw_text, source FROM captures WHERE source = 'ramp' ORDER BY id LIMIT 1").get();
  const avg = wr.db.prepare("SELECT AVG(LENGTH(raw_text)) AS a, MIN(LENGTH(raw_text)) AS lo, MAX(LENGTH(raw_text)) AS hi FROM captures WHERE source = 'ramp'").get();
  check(sample.raw_text.startsWith('ramp-filler ') && avg.lo >= 100 && avg.hi <= 125, `each marker row is plain text of about 110 bytes (${avg.lo} to ${avg.hi}), clearly marked`);
  r = await call(flagged(wr), 'POST', '/admin/engine/ramp', { confirm: 'eng-a', rows: 80 });
  check(r.status === 200 && r.body.rampRows === 80 && ramped(wr) === 80, 'a larger request tops the marker rows up to the new total');
  r = await call(flagged(wr), 'POST', '/admin/engine/ramp', { confirm: 'eng-a', rows: 80 });
  check(r.status === 200 && ramped(wr) === 80, 'the same request again changes nothing');
  r = await call(flagged(wr), 'POST', '/admin/engine/ramp', { confirm: 'eng-a', rows: 10 });
  check(r.status === 200 && r.body.rampRows === 80 && ramped(wr) === 80, 'a smaller request never removes anything (it stays at 80)');
  const hashesBefore = (await call(wr.env, 'GET', '/admin/engine/status')).body.hashes;
  wr.db.prepare("INSERT INTO captures (raw_text, source) VALUES ('a real sentence', 'text')").run();
  const countsWithReal = wr.counts();
  r = await call(flagged(wr), 'POST', '/admin/engine/ramp-clear', { confirm: 'eng-a' });
  check(r.status === 200 && r.body.removed === 80 && ramped(wr) === 0 && others(wr) === 1, 'clearing removes exactly the marker rows and leaves a real capture alone');
  const after = wr.counts();
  check(Object.keys(after).every((t) => t === 'captures' || after[t] === countsWithReal[t]), 'and no other table was touched by the ramp or the clear');
  check(JSON.stringify((await call(wr.env, 'GET', '/admin/engine/status')).body.hashes) === JSON.stringify(hashesBefore), 'the engine tables are byte-for-byte as they were: the ramp never touches them');
  r = await call(flagged(wr), 'POST', '/admin/engine/ramp-clear', { confirm: 'wrong' });
  check(r.status === 400 && others(wr) === 1, 'clearing needs the business id as confirmation too');
});

if (require.main === module) kit.standalone(module.exports);
