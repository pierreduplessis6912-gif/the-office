// Backup and restore (worker/src/backup.ts, backup-routes.ts). The real business lives in ONE place, its object, so a backup is only worth something if a RESTORE is real. These tests take snapshots of a business,
// DAMAGE it every way the real one could be damaged (changed rows, deleted rows, extra rows, advanced id counters, changed and deleted notes, deleted files), restore, and compare fingerprints.
const path = require('path'), fs = require('fs'), os = require('os'), esbuild = require('esbuild'), crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

module.exports = async function runBackupTests(context) {
  const standIn = global.Response;
  if (global.__RealResponse) global.Response = global.__RealResponse;
  try { await backupTests(context); } finally { global.Response = standIn; }
};

async function backupTests({ check, srcDir }) {
  const bundle = (entry) => { const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bk-')), 'm.js'); esbuild.buildSync({ entryPoints: [path.join(srcDir, entry)], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent' }); return require(out); };
  const bk = bundle('backup.ts'), routes = bundle('backup-routes.ts'), mg = bundle('migration.ts'), { DoD1Database } = bundle('storage/do-d1.ts');
  const baseline = fs.readFileSync(path.join(srcDir, '..', 'migrations', '0001_baseline.sql'), 'utf8');
  const plain = (r) => (r ? { ...r } : r);

  // ---- fakes: a database, a notes store, two buckets (with prefixes, delimiters and cursors) ----------------------------------------------------------------------------------------------
  const fakeBucket = () => {
    const m = new Map(), puts = [];
    const toBytes = async (v) => (typeof v === 'string' ? new TextEncoder().encode(v) : v instanceof ArrayBuffer ? new Uint8Array(v) : new Uint8Array(v));
    const wrap = (key) => { const e = m.get(key); return e ? { key, size: e.bytes.length, httpMetadata: e.meta, arrayBuffer: async () => e.bytes.slice().buffer, text: async () => new TextDecoder().decode(e.bytes) } : null; };
    return {
      m, puts,
      put: async (key, value, opts = {}) => { m.set(key, { bytes: await toBytes(value), meta: opts.httpMetadata ?? {} }); puts.push(key); },
      get: async (key) => wrap(key), head: async (key) => wrap(key),
      delete: async (keys) => { for (const k of Array.isArray(keys) ? keys : [keys]) m.delete(k); },
      list: async ({ prefix = '', delimiter, cursor, limit = 1000 } = {}) => {
        const keys = [...m.keys()].filter((k) => k.startsWith(prefix)).sort();
        const objects = [], dirs = new Set();
        for (const k of keys) { const rest = k.slice(prefix.length), cut = delimiter ? rest.indexOf(delimiter) : -1; if (cut >= 0) dirs.add(prefix + rest.slice(0, cut + 1)); else objects.push({ key: k, size: m.get(k).bytes.length }); }
        const start = cursor ? Number(cursor) : 0, page = objects.slice(start, start + limit);
        return { objects: page, delimitedPrefixes: [...dirs].sort(), truncated: start + limit < objects.length, cursor: start + limit < objects.length ? String(start + limit) : undefined };
      },
    };
  };
  const makeBusiness = (business = 'zulu-co') => {
    const db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys = ON'); db.exec(baseline); db.exec('CREATE TABLE object_meta (key TEXT PRIMARY KEY, value TEXT)');
    db.exec('CREATE TABLE lazy_things (id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT)');
    const sql = { exec(query, ...binds) { const s = db.prepare(query); if (/^\s*(select|with|pragma|values)\b/i.test(query) || /\breturning\b/i.test(query)) { const rows = s.all(...binds).map(plain); return { toArray: () => rows, rowsRead: rows.length, rowsWritten: 0 }; } const r = s.run(...binds); return { toArray: () => [], rowsRead: 0, rowsWritten: Number(r.changes) }; } };
    // transactionSync AND the async transaction(), as a real Durable Object offers them (nesting is not needed here: the restore opens ONE transaction)
    const storage = { transactionSync(fn) { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } }, async transaction(fn) { db.exec('BEGIN'); try { const r = await fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } } };
    const kv = new Map(), vault = fakeBucket(), backups = fakeBucket();
    const env = {
      BUSINESS_ID: business, OFFICE_DB: new DoD1Database(sql, storage), BACKUPS: backups,
      CUSTOMER_NOTES: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => { kv.set(k, v); }, delete: async (k) => { kv.delete(k); }, list: async ({ limit = 1000, cursor, prefix = '' } = {}) => { const all = [...kv.keys()].filter((k) => k.startsWith(prefix)).sort(), start = cursor ? Number(cursor) : 0; return { keys: all.slice(start, start + limit).map((name) => ({ name })), list_complete: start + limit >= all.length, cursor: start + limit < all.length ? String(start + limit) : undefined }; } },
      OFFICE_VAULT: vault,
    };
    for (let i = 1; i <= 6; i++) db.prepare('INSERT INTO customers (name, address) VALUES (?, ?)').run(`Customer ${i} "quoted" ✓`, `${i} Test Street`);
    for (let i = 1; i <= 4; i++) db.prepare('INSERT INTO invoices (customer_id, description, amount) VALUES (?, ?, ?)').run(i, `Invoice ${i}`, i * 100);
    // Realistic LINKED data. A real Durable Object ENFORCES foreign keys (SQLite's default, which this test world used to leave OFF), and the schema has one: payments.customer_id -> customers. The first real restore on
    // production (2026-10-14) failed on it: it deleted tables alphabetically, reached `customers` while `payments` still pointed at it, and by then five earlier tables (business_profile, captures, character_facts,
    // characters, customer_facts: 423 rows) were already gone, with no transaction to undo it. Rows in `characters` (sorts BEFORE customers) and in `payments` (the child) put that exact shape in every restore test.
    for (let i = 1; i <= 3; i++) db.prepare("INSERT INTO characters (name, relationship) VALUES (?, 'installer')").run(`Installer ${i}`);
    for (let i = 1; i <= 3; i++) db.prepare('INSERT INTO payments (customer_id, amount, source_transcript) VALUES (?, ?, ?)').run(i, i * 50, 'paid');
    db.exec("INSERT INTO lazy_things (label) VALUES ('a'), ('b'), ('c')");
    db.exec('DELETE FROM lazy_things WHERE id = 3');   // the id counter is ahead of the highest row
    for (let i = 1; i <= 12; i++) kv.set(`customer:${i}`, `note ${i} ✓`);
    for (let i = 1; i <= 6; i++) vault.m.set(`voice-notes/${i}.bin`, { bytes: new Uint8Array([i, i + 1, i + 2, 0, 255]), meta: { contentType: 'audio/webm' } });
    return { env, db, kv, vault, backups };
  };
  const meta = (db, key) => db.prepare('SELECT value FROM object_meta WHERE key = ?').get(key)?.value ?? null;
  const fp = (env) => mg.fingerprint(env);
  const withoutFiles = (f) => ({ tables: f.tables, notes: f.notes, sequences: f.sequences });
  const t1 = new Date('2026-10-14T03:05:09Z');

  // ---- a snapshot ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const A = makeBusiness();
  const before = await fp(A.env);
  const m1 = await bk.takeSnapshot(A.env, t1);
  const tableCount = (await mg.listTables(A.env)).length;
  check(m1.name === '20261014T030509Z' && m1.complete === true && m1.business === 'zulu-co' && m1.tables.length === tableCount && tableCount >= 40, 'a snapshot is named by its time, is complete, and covers EVERY table the business has (40+)');
  check(m1.tables.reduce((n, t) => n + t.rows, 0) === Object.values(before.tables).reduce((n, t) => n + t.count, 0) && m1.notes.count === 12 && m1.files.count === 6, 'it holds every row, all 12 notes and an inventory of all 6 files');
  check(A.backups.puts[A.backups.puts.length - 1] === 'zulu-co/20261014T030509Z/manifest.json' && [...A.backups.m.keys()].filter((k) => k.endsWith('manifest.json')).length === 1, 'the manifest is written LAST (a snapshot that did not finish has no manifest, so it can never be mistaken for a good one)');
  check([...A.backups.m.keys()].every((k) => k.startsWith('zulu-co/')), 'everything is stored under the business\'s OWN folder in the backup bucket');
  const partsOk = m1.tables.every((t) => { const e = A.backups.m.get(t.part.key); return e && e.bytes.length === t.part.bytes && crypto.createHash('sha256').update(e.bytes).digest('hex') === t.part.sha256 && e.bytes[0] === 0x1f && e.bytes[1] === 0x8b; });
  check(partsOk, 'every part is gzip-compressed and recorded with its size and SHA-256 checksum');
  check(JSON.stringify(m1.fingerprint) === JSON.stringify(before), 'the snapshot records a fingerprint of everything it holds');
  check(m1.files.mirroredNow === 6 && [...A.backups.m.keys()].filter((k) => k.startsWith('zulu-co/files/')).length === 6, 'the files are mirrored into the backup bucket');
  const m2 = await bk.takeSnapshot(A.env, new Date('2026-10-15T03:05:09Z'));
  A.vault.m.set('photos/new.bin', { bytes: new Uint8Array([9, 9, 9]), meta: {} });
  const m3 = await bk.takeSnapshot(A.env, new Date('2026-10-16T03:05:09Z'));
  check(m2.files.mirroredNow === 0 && m3.files.mirroredNow === 1, 'the mirror is INCREMENTAL: the second night copies no file, and a new file is copied once (files never change, so they are not copied again)');
  const listed = await bk.listSnapshots(A.env);
  check(listed.length === 3 && listed.every((s) => s.complete) && listed[2].files === 7 && listed[0].tables === tableCount, 'the snapshots can be listed, oldest first, with what each holds');

  // ---- retention ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const R = makeBusiness();
  await R.backups.put('other-co/20260101T000000Z/manifest.json', '{"business":"other-co"}');
  for (let d = 1; d <= 16; d++) await bk.takeSnapshot(R.env, new Date(Date.UTC(2026, 9, d, 3, 0, 0)));
  const kept = await bk.listSnapshotNames(R.env);
  check(kept.length === 14 && kept[0] === '20261003T030000Z' && kept[13] === '20261016T030000Z', 'only the newest 14 snapshots are kept');
  check(![...R.backups.m.keys()].some((k) => k.startsWith('zulu-co/20261001T') || k.startsWith('zulu-co/20261002T')), 'the older ones are removed completely (every part), not just their manifest');
  check(R.backups.m.has('other-co/20260101T000000Z/manifest.json') && [...R.backups.m.keys()].filter((k) => k.startsWith('zulu-co/files/')).length === 6, 'retention never touches another business\'s folder or the file mirror');

  // ---- restore, after every kind of damage ---------------------------------------------------------------------------------------------------------------------------------------
  const D = makeBusiness();
  const good = await bk.takeSnapshot(D.env, new Date('2026-10-14T03:00:00Z'));
  const goodFp = await fp(D.env);
  D.db.exec("UPDATE customers SET name = 'VANDALISED' WHERE id = 2");
  D.db.exec('DELETE FROM invoices');
  for (let i = 0; i < 30; i++) D.db.prepare('INSERT INTO customers (name) VALUES (?)').run(`Junk ${i}`);
  D.db.exec("INSERT INTO lazy_things (label) VALUES ('later')");
  D.kv.set('customer:3', 'CHANGED'); D.kv.delete('customer:4'); D.kv.set('customer:99', 'a note that did not exist');
  const damagedFp = await fp(D.env);
  check(JSON.stringify(withoutFiles(damagedFp)) !== JSON.stringify(withoutFiles(goodFp)), 'the damage is real (rows changed, deleted and added; counters advanced; notes changed, deleted and added)');
  const lockSeen = [];
  const realDelete = D.env.CUSTOMER_NOTES.delete;
  D.env.CUSTOMER_NOTES.delete = async (k) => { lockSeen.push(meta(D.db, 'restoring')); return realDelete(k); };
  const report = await bk.restoreSnapshot(D.env, good.name, 'zulu-co');
  D.env.CUSTOMER_NOTES.delete = realDelete;
  const afterFp = await fp(D.env);
  check(report.ok === true && report.differences.length === 0 && report.tablesRestored === good.tables.length, 'the restore reports success with NO differences from the snapshot\'s own fingerprint', JSON.stringify(report));
  check(JSON.stringify(withoutFiles(afterFp)) === JSON.stringify(withoutFiles(goodFp)), 'and an independent fingerprint of the business now equals the one taken before the damage: every table, every row, every note, and the id counters EXACTLY (the old counters were ahead and are put back)');
  check(D.db.prepare('SELECT COUNT(*) AS n FROM customers').get().n === 6 && D.db.prepare("SELECT name FROM customers WHERE id = 2").get().name !== 'VANDALISED' && D.db.prepare('SELECT COUNT(*) AS n FROM invoices').get().n === 4 && D.kv.get('customer:3') === 'note 3 ✓' && D.kv.get('customer:4') === 'note 4 ✓' && !D.kv.has('customer:99'), 'concretely: the vandalised row is back, the deleted invoices are back, the junk is gone, the changed and deleted notes are back, the invented note is gone');
  check(D.db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'customers'").get().seq === 6 && D.db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'lazy_things'").get().seq === 3, 'the next id a new customer gets is what it would have been before the damage');
  check(lockSeen.length > 0 && lockSeen.every((v) => v === '1') && meta(D.db, 'restoring') === '0', 'the business is LOCKED while the data is replaced and unlocked afterwards');
  check(/-pre-restore$/.test(report.safetySnapshot) && (await bk.readManifest(D.env, report.safetySnapshot)) !== null, 'a safety snapshot of the damaged state was taken first');
  const undone = await bk.restoreSnapshot(D.env, report.safetySnapshot, 'zulu-co');
  check(undone.ok && JSON.stringify(withoutFiles(await fp(D.env))) === JSON.stringify(withoutFiles(damagedFp)), 'so a restore is itself REVERSIBLE: restoring the safety snapshot brings the damaged state back exactly');

  // ---- a restore that FAILS part way changes NOTHING ----------------------------------------------------------------------------------------------------------------------------------------------
  // The business's own data is replaced inside ONE transaction: if anything goes wrong the database is exactly as it was (the old code deleted table after table with no way back).
  const RB = makeBusiness();
  const rbSnap = await bk.takeSnapshot(RB.env, new Date('2026-10-14T03:00:00Z'));
  RB.db.exec("UPDATE customers SET name = 'CHANGED AFTER THE SNAPSHOT' WHERE id = 1");   // the live state differs from the snapshot, so a half-done restore would show
  const rbBefore = await fp(RB.env);
  const rbNotes = JSON.stringify([...RB.kv.entries()]);
  // how many row inserts a restore of this business makes (counted on a twin), so the failures land on the FIRST, the MIDDLE and the LAST of them
  const twin = makeBusiness(); const twinSnap = await bk.takeSnapshot(twin.env, new Date('2026-10-14T03:00:00Z'));
  let totalInserts = 0; const twinPrepare = twin.env.OFFICE_DB.prepare.bind(twin.env.OFFICE_DB);
  twin.env.OFFICE_DB.prepare = (q) => { if (/^\s*INSERT/i.test(q) && !/object_meta|sqlite_sequence/i.test(q)) totalInserts++; return twinPrepare(q); };
  await bk.restoreSnapshot(twin.env, twinSnap.name, 'zulu-co');
  check(totalInserts >= 15, `a restore of this business makes ${totalInserts} row inserts (enough for the failures below to land inside it)`);
  for (const failAt of [1, Math.ceil(totalInserts / 3), Math.ceil(totalInserts / 2), totalInserts - 1, totalInserts]) {
    let inserts = 0; const realPrepare = RB.env.OFFICE_DB.prepare.bind(RB.env.OFFICE_DB);
    RB.env.OFFICE_DB.prepare = (q) => { if (/^\s*INSERT/i.test(q) && !/object_meta|sqlite_sequence/i.test(q)) { inserts++; if (inserts === failAt) throw new Error('injected failure at insert ' + inserts); } return realPrepare(q); };
    let err = null; try { await bk.restoreSnapshot(RB.env, rbSnap.name, 'zulu-co'); } catch (e) { err = e; }
    RB.env.OFFICE_DB.prepare = realPrepare;
    check(err !== null && /injected failure at insert/.test(err.message) && JSON.stringify(withoutFiles(await fp(RB.env))) === JSON.stringify(withoutFiles(rbBefore)) && meta(RB.db, 'restoring') === '0' && JSON.stringify([...RB.kv.entries()]) === rbNotes, `a restore that fails at insert ${failAt} changes NOTHING: every table, every row, the id counters and the notes are exactly as they were, and the business is unlocked${err && !/injected/.test(err.message) ? ' (it failed differently: ' + err.message.slice(0, 80) + ')' : ''}`);
  }
  // ... and with the faults gone, the very same restore succeeds on the very same business
  const rbOk = await bk.restoreSnapshot(RB.env, rbSnap.name, 'zulu-co');
  check(rbOk.ok === true && RB.db.prepare('SELECT name FROM customers WHERE id = 1').get().name !== 'CHANGED AFTER THE SNAPSHOT', 'and with no fault the same restore succeeds on the same business (nothing was left half done)');
  // The restore relies on the schema's foreign keys having an order: no table may reference itself or form a cycle. A future schema step that does would need the restore taught about it, so it is checked here.
  const fkGraph = {}; for (const tb of await mg.listTables(RB.env)) fkGraph[tb] = new Set(RB.db.prepare(`PRAGMA foreign_key_list("${tb}")`).all().map((r) => r.table));
  const hasCycle = (() => { const state = {}; const visit = (n) => { if (state[n] === 1) return true; if (state[n] === 2) return false; state[n] = 1; for (const m of fkGraph[n] || []) if (visit(m)) return true; state[n] = 2; return false; }; return Object.keys(fkGraph).some(visit); })();
  check(!hasCycle && Object.values(fkGraph).some((s) => s.has('customers')) && Object.entries(fkGraph).every(([tb, s]) => !s.has(tb)), 'the schema\'s foreign keys (payments -> customers) have an order: no table references itself and none form a cycle');

  // ORDER from the foreign keys, not from the alphabet. In today's schema the parent (customers) happens to sort before its child (payments), so the alphabet works by luck; here a child (a_child) sorts BEFORE its
  // parent (z_parent), which only a real foreign-key order survives: children are emptied first and parents are filled first.
  const OR = makeBusiness();
  OR.db.exec('CREATE TABLE z_parent (id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT); CREATE TABLE a_child (id INTEGER PRIMARY KEY AUTOINCREMENT, z_id INTEGER NOT NULL REFERENCES z_parent(id))');
  OR.db.exec("INSERT INTO z_parent (label) VALUES ('p1'), ('p2'); INSERT INTO a_child (z_id) VALUES (1), (2), (2)");
  const orSnap = await bk.takeSnapshot(OR.env, new Date('2026-10-14T03:00:00Z'));
  const orGood = await fp(OR.env);
  OR.db.exec("DELETE FROM a_child WHERE id = 1; UPDATE z_parent SET label = 'CHANGED' WHERE id = 1; INSERT INTO z_parent (label) VALUES ('later')");
  const orReport = await bk.restoreSnapshot(OR.env, orSnap.name, 'zulu-co');
  check(orReport.ok === true && JSON.stringify(withoutFiles(await fp(OR.env))) === JSON.stringify(withoutFiles(orGood)) && OR.db.prepare('SELECT COUNT(*) AS n FROM a_child').get().n === 3 && OR.db.prepare('SELECT COUNT(*) AS n FROM z_parent').get().n === 2, 'a child table that sorts BEFORE its parent (a_child -> z_parent) is restored correctly: tables are emptied children first and filled parents first, by the foreign keys and not the alphabet');
  // tables that point at each other have NO order: the restore refuses BEFORE it changes anything
  const CY = makeBusiness();
  CY.db.exec('CREATE TABLE cyc_a (id INTEGER PRIMARY KEY, b_id INTEGER REFERENCES cyc_b(id)); CREATE TABLE cyc_b (id INTEGER PRIMARY KEY, a_id INTEGER REFERENCES cyc_a(id))');
  const cySnap = await bk.takeSnapshot(CY.env, new Date('2026-10-14T03:00:00Z'));
  CY.db.exec("UPDATE customers SET name = 'CHANGED AFTER' WHERE id = 1");
  const cyBefore = await fp(CY.env);
  let cyErr = null; try { await bk.restoreSnapshot(CY.env, cySnap.name, 'zulu-co'); } catch (e) { cyErr = e; }
  check(cyErr !== null && /point at each other in a circle \(cyc_[ab] -> cyc_[ab] -> cyc_[ab]\)/.test(cyErr.message) && JSON.stringify(withoutFiles(await fp(CY.env))) === JSON.stringify(withoutFiles(cyBefore)) && meta(CY.db, 'restoring') === '0', 'tables that point at each other in a circle make the restore REFUSE with a clear reason, before anything is changed (and the business is not left locked)');

  // ---- it refuses, and changes nothing, when it should ----------------------------------------------------------------------------------------------------------------------------------------
  const F = makeBusiness();
  const fs1 = await bk.takeSnapshot(F.env, new Date('2026-10-14T03:00:00Z'));
  F.db.exec("UPDATE customers SET name = 'KEEP ME' WHERE id = 1");
  const stateBefore = JSON.stringify(withoutFiles(await fp(F.env))), namesBefore = (await bk.listSnapshotNames(F.env)).join();
  const refuse = async (fn) => { try { await fn(); return null; } catch (e) { return String(e.message); } };
  const wrongConfirm = await refuse(() => bk.restoreSnapshot(F.env, fs1.name, 'other-co'));
  const unknown = await refuse(() => bk.restoreSnapshot(F.env, '20250101T000000Z', 'zulu-co'));
  const notAName = await refuse(() => bk.restoreSnapshot(F.env, '../other-co', 'zulu-co'));
  F.backups.m.delete(`zulu-co/${fs1.name}/manifest.json`);
  const incomplete = await refuse(() => bk.restoreSnapshot(F.env, fs1.name, 'zulu-co'));
  F.backups.m.set(`zulu-co/${fs1.name}/manifest.json`, { bytes: new TextEncoder().encode(JSON.stringify(fs1)), meta: {} });
  const customersPart = F.backups.m.get(fs1.tables.find((t) => t.name === 'customers').part.key); customersPart.bytes[customersPart.bytes.length - 3] ^= 0xff;
  const damaged = await refuse(() => bk.restoreSnapshot(F.env, fs1.name, 'zulu-co'));
  check(/confirm by sending/.test(wrongConfirm) && /no complete snapshot/.test(unknown) && /not a snapshot name/.test(notAName) && /no complete snapshot/.test(incomplete), 'it refuses a wrong confirmation, an unknown snapshot, a path-like name, and a snapshot with no manifest (one that never finished)');
  check(/damaged/.test(damaged) && JSON.stringify(withoutFiles(await fp(F.env))) === stateBefore && (await bk.listSnapshotNames(F.env)).join() === namesBefore && meta(F.db, 'restoring') === null, 'a DAMAGED snapshot (one flipped byte) is caught by its checksum BEFORE anything is changed: the business is untouched, no safety snapshot was taken, and it was never locked');
  const foreign = JSON.parse(JSON.stringify(fs1)); foreign.business = 'other-co';
  F.backups.m.set(`zulu-co/${fs1.name}/manifest.json`, { bytes: new TextEncoder().encode(JSON.stringify(foreign)), meta: {} });
  check((await bk.readManifest(F.env, fs1.name)) === null, 'a manifest that names a different business is not accepted');
  const E = makeBusiness(); E.db.exec("UPDATE customers SET name = 'x'");
  const failing = await bk.takeSnapshot(E.env, new Date('2026-10-14T03:00:00Z'));
  E.env.CUSTOMER_NOTES.put = async () => { throw new Error('the notes store is down'); };
  const midway = await refuse(() => bk.restoreSnapshot(E.env, failing.name, 'zulu-co'));
  check(/notes store is down/.test(midway) && meta(E.db, 'restoring') === '0', 'if a restore fails part-way the error is raised and the lock is still released (an administrator can run it again)');

  // ---- files ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const G = makeBusiness();
  const gs = await bk.takeSnapshot(G.env, new Date('2026-10-14T03:00:00Z'));
  G.vault.m.delete('voice-notes/2.bin');
  G.vault.m.set('photos/added-later.bin', { bytes: new Uint8Array([7]), meta: {} });
  const fromMirror = await bk.restoreSnapshot(G.env, gs.name, 'zulu-co');
  check(fromMirror.ok && fromMirror.filesRestoredFromMirror === 1 && G.vault.m.has('voice-notes/2.bin') && Buffer.from(G.vault.m.get('voice-notes/2.bin').bytes).equals(Buffer.from([2, 3, 4, 0, 255])) && G.vault.m.has('photos/added-later.bin'), 'a file deleted by accident comes back from the mirror byte for byte, and a file ADDED after the snapshot is not deleted by the restore');
  G.vault.m.delete('voice-notes/3.bin'); G.backups.m.delete('zulu-co/files/voice-notes/3.bin');
  const lost = await bk.restoreSnapshot(G.env, gs.name, 'zulu-co');
  check(!lost.ok && lost.filesMissingEverywhere.join() === 'voice-notes/3.bin', 'a file missing from BOTH places is reported by name, and the restore does not claim success');

  // ---- configuration errors -----------------------------------------------------------------------------------------------------------------------------------------------------------------
  const noBucket = await refuse(() => bk.takeSnapshot({ ...A.env, BACKUPS: undefined }));
  const noBusiness = await refuse(() => bk.takeSnapshot({ ...A.env, BUSINESS_ID: undefined }));
  check(/no backup bucket/.test(noBucket) && /per business/.test(noBusiness), 'with no backup bucket, or outside a business\'s object, it says so plainly instead of failing obscurely');

  // ---- the routes ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const H = makeBusiness();
  const call = async (method, p, body, env = H.env) => { const u = new URL('https://x' + p); const r = await routes.backupRoute(new Request(u, { method, ...(body ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}) }), env, u); return r ? { status: r.status, body: await r.json() } : null; };
  const st0 = await call('GET', '/admin/backup/status');
  check(st0.status === 200 && st0.body.backupBucketConfigured === true && st0.body.snapshots === 0 && st0.body.newest === null && st0.body.lastSuccessAt === null && st0.body.keep === 14, 'status before any backup says so: no snapshots, nothing newest, never succeeded');
  const run = await call('POST', '/admin/backup/run');
  const st1 = await call('GET', '/admin/backup/status');
  check(run.status === 200 && run.body.tables === tableCount && run.body.files === 6 && st1.body.lastAttemptOk === true && st1.body.lastSuccessAt && st1.body.complete === 1 && st1.body.newestAgeHours < 1, 'running a snapshot reports what it took, and status then shows the success, the snapshot and its age');
  const lst = await call('GET', '/admin/backup/list');
  check(lst.body.snapshots.length === 1 && lst.body.snapshots[0].complete === true, 'the list shows it');
  H.env.BACKUPS.put = async () => { throw new Error('the backup bucket is full'); };
  const failedRun = await call('POST', '/admin/backup/run'), st2 = await call('GET', '/admin/backup/status');
  check(failedRun.status === 400 && /bucket is full/.test(failedRun.body.error) && st2.body.lastAttemptOk === false && /bucket is full/.test(st2.body.lastError) && st2.body.lastSuccessAt === st1.body.lastSuccessAt, 'a FAILED backup is recorded (the failure, and that the last success is still the old one), so an alert can see it');
  const badBody = await call('POST', '/admin/backup/restore', {});
  const worker = await call('GET', '/admin/backup/status', null, { ...H.env, BUSINESS_ID: undefined });
  const nothing = await call('GET', '/admin/backup/zzz'), other = await routes.backupRoute(new Request('https://x/customers'), H.env, new URL('https://x/customers'));
  check(badBody.status === 400 && worker.status === 400 && /name one/.test(worker.body.error) && nothing.status === 404 && other === null, 'a restore with no snapshot or confirmation is refused, the Worker (no business named) refuses, an unknown backup route is a 404, and other paths are left alone');
  await call('POST', '/admin/backup/unlock');
  check(true, 'unlock is available');

  // ---- guards on the code itself -----------------------------------------------------------------------------------------------------------------------------------------------------------
  const code = fs.readFileSync(path.join(srcDir, 'backup.ts'), 'utf8');
  const restore = code.slice(code.indexOf('export async function restoreSnapshot'));
  const iCheck = restore.indexOf('getPart(bucket, t.part)'), iSafety = restore.indexOf('takeSnapshot(env, new Date(), "-pre-restore")'), iLock = restore.indexOf('setMeta(env, "restoring", "1")'), iWipe = restore.indexOf('DELETE FROM');
  check(iCheck > 0 && iCheck < iSafety && iSafety < iLock && iLock < iWipe && /finally \{\s*await setMeta\(env, "restoring", "0"\)/.test(restore), 'in a restore the ORDER is fixed: checksum everything, then the safety snapshot, then lock, then wipe; and the lock is released in a finally');
  const take = code.slice(code.indexOf('export async function takeSnapshot'), code.indexOf('export async function listSnapshotNames'));
  check(take.indexOf('"manifest.json"') > take.indexOf('files-inventory.json.gz') && take.indexOf('await applyRetention(env)') > take.indexOf('"manifest.json"'), 'in a snapshot the manifest comes after every part, and retention runs only after the new snapshot is complete');
  check(!/DELETE FROM "?\$?\{?(object_meta|admin_audit)/.test(code) && /SKIP_TABLES|listTables/.test(code), 'a restore wipes only the tables the migration helpers list (never the object\'s own bookkeeping or the audit log)');
}
