// The snapshot MANIFEST, validated before anything acts on it (worker/src/backup.ts; branch engine-phase1, Task 4). TESTS FIRST.
// THE FINDING (read-only experiment, 2026-11-02): restore verified checksums and replaced data in ONE transaction, but it trusted the manifest's SHAPE. A manifest missing `columns` for a table that no longer exists, or missing `fingerprint`,
// made restore REPLACE THE DATA and only then throw, so the caller was told it had failed after it had succeeded; `version` was never checked; and one truncated or malformed manifest made listSnapshots throw for EVERY snapshot, hiding the good ones
// from the admin routes an operator uses to choose one. A part's key was never required to be inside the snapshot's own folder, so a manifest could point restore at another business's bytes.
// THE RULE: validate EXACTLY what restore and listing USE, before the lock, the safety snapshot or any schema change; tolerate everything else, so a good older snapshot is never made unrestorable by a validator stricter than the data.
// Existing semantics are kept: a manifest that is not complete, or names another business or snapshot, is "no complete snapshot" (readManifest returns null), not "cannot be trusted".
const kit = require('./engine-kit.js');

module.exports = kit.guard('snapshot manifest validation', async ({ check }) => {
  const bk = kit.bundle('backup.ts', 'backup');
  check(typeof bk.inspectManifest === 'function' && typeof bk.validateManifest === 'function', 'backup.ts exposes inspectManifest and validateManifest');
  if (typeof bk.inspectManifest !== 'function') return;
  const DAY = (n) => new Date(`2026-11-0${n}T03:00:00Z`);
  const KEY = (b, name) => `${b}/${name}/manifest.json`;

  // a business with data, a good snapshot, and a second snapshot whose manifest the case corrupts
  const trial = async (mutate, { prep, between } = {}) => {
    const w = kit.makeWorld({ backups: true });
    for (let i = 1; i <= 5; i++) w.db.prepare('INSERT INTO customers (name, address) VALUES (?, ?)').run('C' + i, 'S' + i);
    const good = await bk.takeSnapshot(w.env, DAY(1)), bad = await bk.takeSnapshot(w.env, DAY(2));
    const key = KEY('eng-a', bad.name), text = await (await w.env.BACKUPS.get(key)).text();
    if (between) await between(w, bad);
    await w.env.BACKUPS.put(key, typeof mutate === 'function' ? mutate(text, JSON.parse(text), bad) : text);
    if (prep) prep(w);
    w.db.prepare("INSERT INTO customers (name) VALUES ('DAMAGE')").run();
    const gets = []; const realGet = w.env.BACKUPS.get; w.env.BACKUPS.get = async (k) => { gets.push(k); return realGet(k); };
    let threw = null, rep = null; try { rep = await bk.restoreSnapshot(w.env, bad.name, 'eng-a'); } catch (e) { threw = String((e && e.message) || e); }
    w.env.BACKUPS.get = realGet;
    const keys = [...w.env.BACKUPS.m.keys()];
    return {
      w, good, bad, threw, rep, gets,
      untouched: w.db.prepare("SELECT COUNT(*) AS n FROM customers WHERE name = 'DAMAGE'").get().n === 1,   // the live data was NOT replaced
      locked: (w.db.prepare("SELECT value FROM object_meta WHERE key = 'restoring'").get() || {}).value === '1',
      safety: keys.some((k) => /-pre-restore\//.test(k)),   // a safety snapshot is taken only once the manifest is trusted
      listed: await bk.listSnapshots(w.env).then((l) => l, (e) => ({ error: String(e.message) })),
    };
  };
  const mut = (f) => (t, m, snap) => JSON.stringify((f(m, snap), m));
  const refused = (r, why) => r.threw && /cannot be trusted/.test(r.threw) && (!why || why.test(r.threw)) && r.untouched && !r.locked && !r.safety;

  // ---- CONTROLS ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const c0 = await trial();
  check(c0.rep && c0.rep.ok === true && !c0.untouched && !c0.threw, 'CONTROL: an untouched manifest restores, verifies clean and replaces the damaged data');
  const ext = await trial(mut((m) => { m.futureField = { a: 1 }; m.tables[0].extra = 'x'; m.notes.note = 'y'; m.fingerprint.extra = 1; }));
  check(ext.rep && ext.rep.ok === true, 'FORWARD COMPATIBLE: unknown extra fields at every level are tolerated (only what restore and listing USE is validated), so a good snapshot is never made unrestorable by a stricter validator');
  check((await bk.readManifest(c0.w.env, c0.bad.name)) !== null, 'readManifest still returns the manifest of a good snapshot');

  // ---- not JSON, not an object ------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  let r = await trial((t) => t.slice(0, Math.floor(t.length / 2)));
  check(refused(r, /not valid JSON/), `a TRUNCATED manifest is refused with a clear reason before anything changes: "${r.threw}"`);
  for (const [label, text] of [['an array', '[]'], ['null', 'null'], ['a string', '"x"'], ['a number', '7']]) {
    r = await trial(() => text); check(refused(r), `a manifest that is ${label} is refused before anything changes`);
  }

  // ---- identity semantics are preserved: these were always "no complete snapshot", never "cannot be trusted" ----------------------------------------------------------------------------------------
  for (const [label, f] of [['complete is false', (m) => { m.complete = false; }], ['complete is missing', (m) => { delete m.complete; }], ['it names another business', (m) => { m.business = 'someone-else'; }], ['it names another snapshot', (m) => { m.name = '20250101T000000Z'; }]]) {
    r = await trial(mut(f)); check(r.threw && /no complete snapshot/.test(r.threw) && r.untouched && !r.locked && !r.safety && (await bk.readManifest(r.w.env, r.bad.name)) === null, `${label}: "no complete snapshot" and readManifest is null, exactly as before`);
  }

  // ---- the version ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  for (const v of [2, 0, '1', null, 'one']) { r = await trial(mut((m) => { m.version = v; })); check(refused(r, /unsupported manifest version/), `version ${JSON.stringify(v)} is refused as unsupported before anything changes`); }
  r = await trial(mut((m) => { delete m.version; })); check(refused(r, /unsupported manifest version/), 'a missing version is refused as unsupported');

  // ---- tables -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const T = (f, label, why) => async () => { const x = await trial(mut((m) => { f(m.tables.find((t) => t.name === 'customers'), m); })); check(refused(x, why), `${label}: refused before anything changes`); };
  for (const [label, f] of [['"tables" missing', (_t, m) => { delete m.tables; }], ['"tables" is an object', (_t, m) => { m.tables = {}; }], ['"tables" is null', (_t, m) => { m.tables = null; }]]) { r = await trial(mut((m) => f(null, m))); check(refused(r, /tables/), `${label}: refused before anything changes`); }
  const tableCases = [
    ['a table entry is not an object', (_t, m) => { m.tables[0] = 7; }, /tables\[0\]/],
    ['a table name that is not an identifier', (t) => { t.name = 'customers; DROP TABLE customers'; }, /name/],
    ['two tables with the same name', (_t, m) => { m.tables.push({ ...m.tables[1] }); }, /duplicate/],
    ['a table with no sql', (t) => { delete t.sql; }, /sql/],
    ['a table with empty sql', (t) => { t.sql = ''; }, /sql/],
    ['a table with no columns', (t) => { delete t.columns; }, /columns/],
    ['columns that are not an array', (t) => { t.columns = 'id,name'; }, /columns/],
    ['a column entry that is not an object', (t) => { t.columns[0] = 'id'; }, /columns/],
    ['a column whose name is not an identifier', (t) => { t.columns[0].name = 'a b'; }, /column/],
    ['a column with no type', (t) => { delete t.columns[0].type; }, /column/],
    ['a negative row count', (t) => { t.rows = -1; }, /rows/],
    ['a row count that is not a number', (t) => { t.rows = 'many'; }, /rows/],
    ['a table with no part', (t) => { delete t.part; }, /part/],
    ['a part with a malformed checksum', (t) => { t.part.sha256 = 'abc'; }, /sha256/],
    ['a part with no key', (t) => { delete t.part.key; }, /key/],
    ['a part with a negative size', (t) => { t.part.bytes = -5; }, /bytes/],
  ];
  for (const [label, f, why] of tableCases) await T(f, label, why)();

  // the two the experiment showed REPLACING THE DATA before failing
  r = await trial(mut((m) => { delete m.tables.find((t) => t.name === 'business_profile').columns; }), { prep: (w) => w.db.exec('DROP TABLE business_profile') });
  check(refused(r, /columns/), 'THE FINDING: a table whose columns are missing AND which is gone from the live database used to REPLACE THE DATA and then throw; it is now refused before anything changes');
  r = await trial(mut((m) => { delete m.fingerprint; }));
  check(refused(r, /fingerprint/), 'THE FINDING: a missing fingerprint used to REPLACE THE DATA and then throw; it is now refused before anything changes');

  // ---- sequences, notes, files, fingerprint ---------------------------------------------------------------------------------------------------------------------------------------------------------------
  for (const [label, f, why] of [
    ['"sequences" missing', (m) => { delete m.sequences; }, /sequences/], ['"sequences" is not an array', (m) => { m.sequences = {}; }, /sequences/], ['a sequence with no name', (m) => { m.sequences[0] = { seq: 1 }; }, /sequences/], ['a sequence with a bad value', (m) => { m.sequences[0] = { name: 'customers', seq: 'x' }; }, /sequences/],
    ['"notes" missing', (m) => { delete m.notes; }, /notes/], ['notes with no part', (m) => { delete m.notes.part; }, /notes/], ['notes with a bad count', (m) => { m.notes.count = 'x'; }, /notes/],
    ['"files" missing', (m) => { delete m.files; }, /files/], ['files with no inventory part', (m) => { delete m.files.inventory; }, /files/], ['files with a bad count', (m) => { m.files.count = -1; }, /files/],
    ['fingerprint with no tables', (m) => { delete m.fingerprint.tables; }, /fingerprint/], ['a fingerprint table entry without a hash', (m) => { m.fingerprint.tables.customers = { count: 5 }; }, /fingerprint/], ['fingerprint with no notes', (m) => { delete m.fingerprint.notes; }, /fingerprint/], ['fingerprint with no files', (m) => { delete m.fingerprint.files; }, /fingerprint/], ['fingerprint with no sequences', (m) => { delete m.fingerprint.sequences; }, /fingerprint/],
  ]) { r = await trial(mut((m) => f(m))); check(refused(r, why), `${label}: refused before anything changes`); }

  // ---- ISOLATION: a part may only be read from the snapshot's OWN folder ------------------------------------------------------------------------------------------------------------------------------
  r = await trial((t, m) => { m.tables.find((x) => x.name === 'customers').part.key = 'other-co/20260101T000000Z/tables/customers.jsonl.gz'; return JSON.stringify(m); }, { between: async (w, bad) => { const src = await w.env.BACKUPS.get(bad.tables.find((x) => x.name === 'customers').part.key); await w.env.BACKUPS.put('other-co/20260101T000000Z/tables/customers.jsonl.gz', await src.arrayBuffer()); } });
  check(refused(r, /outside|folder/) && !r.gets.some((k) => k.startsWith('other-co/')), `a part pointing into ANOTHER business's folder (with a correct checksum) is refused and NO byte of that folder is read (reads: ${r.gets.filter((k) => !k.startsWith('eng-a/')).join(', ') || 'none outside eng-a'})`);
  r = await trial((t, m, snap) => { m.tables.find((x) => x.name === 'customers').part.key = `eng-a/${c0.good.name}/tables/customers.jsonl.gz`; return JSON.stringify(m); });
  check(refused(r, /outside|folder/), 'a part inside another SNAPSHOT of the same business is refused too: a snapshot reads only its own folder');

  // ---- listing: one bad manifest no longer hides the good ones ---------------------------------------------------------------------------------------------------------------------------------------
  for (const [label, f] of [['truncated', (t) => t.slice(0, 100)], ['"tables" missing', mut((m) => { delete m.tables; })], ['"notes" missing', mut((m) => { delete m.notes; })], ['version 2', mut((m) => { m.version = 2; })]]) {
    const x = await trial(f);
    const list = Array.isArray(x.listed) ? x.listed : [];
    const g = list.find((s) => s.name === x.good.name), b = list.find((s) => s.name === x.bad.name);
    check(Array.isArray(x.listed) && g && g.complete === true && g.tables > 40 && b && b.complete === false && typeof b.unreadable === 'string' && b.unreadable.length > 0, `listing with a ${label} manifest does NOT throw: the good snapshot is still listed complete, the bad one is listed unreadable with its reason (${Array.isArray(x.listed) ? 'ok' : x.listed.error})`);
  }
  const x = await trial(mut((m) => { m.complete = false; })); const lb = (Array.isArray(x.listed) ? x.listed : []).find((s) => s.name === x.bad.name);
  check(lb && lb.complete === false && lb.unreadable === undefined, 'an incomplete snapshot is listed incomplete and NOT as unreadable (its meaning is unchanged)');

  // ---- the admin routes an operator actually uses -----------------------------------------------------------------------------------------------------------------------------------------------------
  const routes = kit.bundle('backup-routes.ts', 'backuproutes');
  const call = async (w, method, path, body) => { const url = new URL('https://x' + path); const res = await routes.backupRoute(new Request(url, { method, ...(body ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}) }), w.env, url); return { status: res.status, json: await res.json() }; };
  const rt = await trial(mut((m) => { delete m.tables; }));
  const st = await call(rt.w, 'GET', '/admin/backup/status'), ls = await call(rt.w, 'GET', '/admin/backup/list');
  check(st.status === 200 && st.json.snapshots === 2 && st.json.complete === 1 && st.json.unreadable === 1 && st.json.newest && st.json.newest.name === rt.good.name, `GET /status with one unreadable manifest answers 200, counts 2 snapshots, 1 complete, 1 unreadable, and names the good one as the newest (${st.status} ${JSON.stringify({ s: st.json.snapshots, c: st.json.complete, u: st.json.unreadable })})`);
  check(ls.status === 200 && ls.json.snapshots.length === 2 && ls.json.snapshots.filter((x) => x.unreadable).length === 1, 'GET /list answers 200 with both snapshots, one marked unreadable with its reason (before the fix it was a 400 that hid every snapshot)');
  const rr = await call(rt.w, 'POST', '/admin/backup/restore', { snapshot: rt.bad.name, confirm: 'eng-a' });
  check(rr.status === 400 && /cannot be trusted/.test(rr.json.error) && /nothing was changed/.test(rr.json.error) && rt.w.db.prepare("SELECT COUNT(*) AS n FROM customers WHERE name = 'DAMAGE'").get().n === 1, `POST /restore of that snapshot answers 400 "${rr.json.error}" and the live data is untouched`);
  const clean = await trial();
  const cs = await call(clean.w, 'GET', '/admin/backup/status');
  check(cs.json.unreadable === 0 && cs.json.snapshots >= 2 && cs.json.complete === cs.json.snapshots, `GET /status with only good snapshots reports unreadable: 0 and every snapshot complete (${cs.json.complete} of ${cs.json.snapshots})`);

  // ---- the validator on its own -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const v = bk.validateManifest(JSON.parse(await (await c0.w.env.BACKUPS.get(KEY('eng-a', c0.good.name))).text()), 'eng-a', c0.good.name);
  check(v.status === 'ok' && v.manifest.tables.length > 40, 'validateManifest accepts a real manifest');
  check(bk.validateManifest(undefined, 'eng-a', 'x').status === 'unreadable' && bk.validateManifest({}, 'eng-a', 'x').status === 'incomplete', 'it never throws: undefined is unreadable, an empty object is incomplete');
});

if (require.main === module) kit.standalone(module.exports);
