// The migration RUNNER (tools/migrate-lib.mjs) driven in-process against the real route handlers (worker/src/migration-routes.ts) over stand-in stores. The same runner is rehearsed on the real
// Cloudflare runtime by tools/do-trial/migration-rehearsal.mjs; this covers its LOGIC in every build: it refuses to mix, it never writes to the source, it retries a glitch but not an answer, it
// registers only active members, it reports a copy that silently lost something, and its comparison agrees with the Worker's.
const path = require('path'), fs = require('fs'), os = require('os'), esbuild = require('esbuild');
const { pathToFileURL } = require('url');
const { DatabaseSync } = require('node:sqlite');

module.exports = async function runMigrateRunnerTests(context) {
  const standIn = global.Response;
  if (global.__RealResponse) global.Response = global.__RealResponse;
  try { await runnerTests(context); } finally { global.Response = standIn; }
};

async function runnerTests({ check, srcDir }) {
  const bundle = (entry) => { const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mr-')), 'm.js'); esbuild.buildSync({ entryPoints: [path.join(srcDir, entry)], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent' }); return require(out); };
  const routes = bundle('migration-routes.ts'), mg = bundle('migration.ts'), { DoD1Database } = bundle('storage/do-d1.ts'), sb = bundle('scoped-bindings.ts');
  const lib = await import(pathToFileURL(path.join(__dirname, 'migrate-lib.mjs')).href);
  const baseline = fs.readFileSync(path.join(srcDir, '..', 'migrations', '0001_baseline.sql'), 'utf8');
  const plain = (r) => (r ? { ...r } : r);
  const makeSide = (setup) => {
    const db = new DatabaseSync(':memory:'); db.exec(baseline); if (setup) setup(db);
    const sql = { exec(query, ...binds) { const s = db.prepare(query); if (/^\s*(select|with|pragma|values)\b/i.test(query) || /\breturning\b/i.test(query)) { const rows = s.all(...binds).map(plain); return { toArray: () => rows, rowsRead: rows.length, rowsWritten: 0 }; } const r = s.run(...binds); return { toArray: () => [], rowsRead: 0, rowsWritten: Number(r.changes) }; } };
    const storage = { transactionSync(fn) { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } } };
    const kv = new Map(), r2 = new Map();
    // A memory index that applies a write LATE (found on the real index: about 100 seconds): upsert only queues, and processNext() applies one queued write, as Cloudflare's index info would report.
    const vecs = new Map(), queue = []; let mutation = 0, processed = null, stall = false, lagReads = 0, hidden = null;
    const mem = { vecs, processNext: () => { if (!stall && queue.length) { const q = queue.shift(); for (const v of q.vs) vecs.set(v.id, { values: Array.from(v.values), metadata: v.metadata, namespace: v.namespace }); processed = q.id; } return processed; }, stall: (on) => { stall = on; }, lagReads: (n) => { lagReads = n; }, hide: (id) => { hidden = id; } };
    const page = (all, limit, cursor) => { const start = cursor ? Number(cursor) : 0; return { slice: all.slice(start, start + limit), more: start + limit < all.length, cursor: start + limit < all.length ? String(start + limit) : undefined }; };
    const env = {
      OFFICE_DB: new DoD1Database(sql, storage),
      CUSTOMER_NOTES: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => { kv.set(k, v); }, list: async ({ limit = 1000, cursor, prefix = '' } = {}) => { const p = page([...kv.keys()].filter((k) => k.startsWith(prefix)).sort(), limit, cursor); return { keys: p.slice.map((name) => ({ name })), list_complete: !p.more, cursor: p.cursor }; } },
      MEMORY: { upsert: async (vs) => { const id = `mutation-${++mutation}`; queue.push({ id, vs }); return { mutationId: id }; }, getByIds: async (ids) => { if (lagReads > 0) { lagReads--; return []; } return ids.filter((i) => vecs.has(i) && i !== hidden).map((i) => ({ id: i, ...vecs.get(i) })); } },
      OFFICE_VAULT: { get: async (k) => (r2.has(k) ? { body: r2.get(k).bytes, httpMetadata: { contentType: r2.get(k).type }, arrayBuffer: async () => r2.get(k).bytes.buffer.slice(r2.get(k).bytes.byteOffset, r2.get(k).bytes.byteOffset + r2.get(k).bytes.byteLength) } : null), put: async (k, body, o) => { r2.set(k, { bytes: new Uint8Array(body), type: o?.httpMetadata?.contentType }); }, list: async ({ limit = 1000, cursor, prefix = '' } = {}) => { const p = page([...r2.keys()].filter((k) => k.startsWith(prefix)).sort(), limit, cursor); return { objects: p.slice.map((key) => ({ key, size: r2.get(key).bytes.length })), truncated: p.more, cursor: p.cursor }; } },
    };
    return { db, env, kv, r2, mem };
  };
  const fresh = () => {
    const S = makeSide((db) => {
      db.exec("CREATE TABLE lazy_things (id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT)");
      db.prepare('INSERT INTO customers (name, address) VALUES (?, ?)').run('Ann "A" O\'Neil', 'x'); db.prepare('INSERT INTO customers (name) VALUES (?)').run('Bo 🙂'); db.prepare('INSERT INTO customers (name) VALUES (?)').run('Gone'); db.exec("DELETE FROM customers WHERE name = 'Gone'");
      db.prepare('INSERT INTO payments (customer_id, amount, source_transcript) VALUES (?, ?, ?)').run(1, 10.5, 'paid'); db.exec("INSERT INTO lazy_things (label) VALUES ('a'), ('b')");
      db.prepare('INSERT INTO memberships (google_email, role, status) VALUES (?, ?, ?)').run('owner@x.co', 'owner', 'active'); db.prepare('INSERT INTO memberships (google_email, role, status) VALUES (?, ?, ?)').run('crew@x.co', 'installer', 'active'); db.prepare('INSERT INTO memberships (google_email, role, status) VALUES (?, ?, ?)').run('gone@x.co', 'installer', 'suspended');
    });
    for (let i = 1; i <= 120; i++) S.kv.set(`customer:${i}`, `note ${i}`);
    for (let i = 1; i <= 45; i++) S.mem.vecs.set(`pmf-${i}`, { values: [i, 1, 0], metadata: { customerId: '1', text: `memory ${i}` } });
    for (let i = 1; i <= 105; i++) S.r2.set(`photos/${i}.bin`, { bytes: new Uint8Array([i, 255 - i, i]), type: 'image/png' });
    const T = makeSide(); T.env.BUSINESS_ID = 'zulu-co';   // the target is a business's object, and says so
    return { S, T };
  };
  // the runner talks to this instead of the network; every call is recorded
  const wire = ({ S, T }, hooks = {}) => {
    const calls = [], directory = [];
    const targetEnv = hooks.scopedTarget ? sb.scopeBindings(T.env, 'zulu-co') : T.env;
    const fetchImpl = async (url, init = {}) => {
      const u = new URL(url), host = u.host, method = init.method ?? 'GET';
      calls.push({ host, method, path: u.pathname });
      if (hooks.before) { const early = await hooks.before({ host, method, path: u.pathname, init, calls }); if (early) return early; }
      let body = init.body;
      if (hooks.rewriteBody) body = hooks.rewriteBody({ host, method, path: u.pathname, body }) ?? body;
      if (host === 'api.cloudflare.com') {
        if (u.pathname.endsWith('/src-index/list')) return Response.json({ success: true, result: { vectors: [...S.mem.vecs.keys()].map((id) => ({ id })), isTruncated: false } });
        if (u.pathname.endsWith('/info')) return Response.json({ success: true, result: { processedUpToMutation: T.mem.processNext() } });
        return new Response('not found', { status: 404 });
      }
      if (u.pathname === '/debug/directory/check-members') { const asked = JSON.parse(body); (hooks.asked ??= []).push(asked); return Response.json({ conflicts: (hooks.conflicts ?? []).filter((c) => asked.emails.includes(c.email)) }); }
      if (u.pathname === '/debug/directory/add-member') { directory.push(JSON.parse(body)); return Response.json({ inDirectory: true }); }
      if (u.pathname === '/debug/init-indexes') return Response.json({ created: [], alreadyThere: [], failed: [] });
      const request = new Request(url, { method, headers: init.headers, body });
      return (await routes.migrationRoute(request, host === 'source' ? S.env : targetEnv, u)) ?? new Response('not found', { status: 404 });
    };
    return { fetchImpl, calls, directory };
  };
  const side = (host, extra = {}) => ({ base: `http://${host}`, adminKey: 'k', confirmKey: 'c', ...extra });

  // ---- a clean run ------------------------------------------------------------------------------------------------------------------------------------------------------------
  const world = fresh(), w = wire(world);
  const report = await lib.migrate({ source: side('source'), target: side('target', { business: 'zulu-co' }), fetchImpl: w.fetchImpl, pageSize: 2 });
  check(report.ok === true && report.mismatches.length === 0, 'a clean run completes with every fingerprint matching', report.mismatches.join('; '));
  const fa = await mg.fingerprint(world.S.env), fb = await mg.fingerprint(world.T.env);
  check(mg.compareFingerprints(fa, fb).length === 0 && fb.notes.count === 120 && fb.files.count === 105 && fb.tables.customers.count === 2 && fb.sequences.customers === 3, 'and the target really is identical: 120 notes and 105 files copied across several pages, the table created on first use, and the id counter at 3 although the highest id is 2');
  const writesToSource = w.calls.filter((c) => c.host === 'source' && c.method !== 'GET' && c.path !== '/admin/migration/vectors-by-ids');
  check(writesToSource.length === 0 && w.calls.some((c) => c.host === 'source') && w.calls.some((c) => c.host === 'target' && c.method === 'POST'), 'the runner NEVER writes to the source: every call it makes to the source is a read');
  check(w.directory.length === 2 && w.directory.every((d) => d.business_id === 'zulu-co' && d.skip_membership === true) && w.directory.map((d) => d.email).sort().join() === 'crew@x.co,owner@x.co', 'only the ACTIVE members are registered in the directory (the suspended one is not), and without re-creating their memberships');
  check(w.calls.filter((c) => c.host === 'target' && c.method === 'GET' && c.path.endsWith('/fingerprint')).length === 2, 'the target\'s fingerprint is taken before (to check it is empty) and after (to prove the copy)');

  // ---- the runner asks both ends who they are BEFORE copying a byte -----------------------------------------------------------------------------------------------------------
  const noWrites = (w) => !w.calls.some((c) => c.method === 'POST' && c.path.startsWith('/admin/migration/'));
  const selfTarget = fresh(); selfTarget.T.env = selfTarget.S.env;   // a target that is really the SAME deployment as the source
  const wSame = wire(selfTarget);
  const sameRun = await lib.migrate({ source: side('source'), target: side('target', { business: 'zulu-co' }), fetchImpl: wSame.fetchImpl });
  check(!sameRun.ok && /refusing to copy/.test(sameRun.mismatches.join()) && noWrites(wSame) && selfTarget.S.db.prepare('SELECT COUNT(*) AS n FROM customers').get().n === 2, 'if the "target" is really the SAME deployment as the source (it ignores the business it was asked for), the run REFUSES before copying anything: a database is never copied onto itself');
  const other = fresh(); other.T.env.BUSINESS_ID = 'someone-else-co';
  const wOther = wire(other);
  const otherRun = await lib.migrate({ source: side('source'), target: side('target', { business: 'zulu-co' }), fetchImpl: wOther.fetchImpl });
  check(!otherRun.ok && /target answered as someone-else-co/.test(otherRun.mismatches.join()) && noWrites(wOther), 'a target that answers as a DIFFERENT business is refused, and nothing is written');
  const objSource = fresh(); objSource.S.env.BUSINESS_ID = 'a-business';
  const wObj = wire(objSource);
  const objRun = await lib.migrate({ source: side('source'), target: side('target', { business: 'zulu-co' }), fetchImpl: wObj.fetchImpl });
  check(!objRun.ok && /source answered as a-business/.test(objRun.mismatches.join()) && noWrites(wObj), 'a source that is really a business\'s object, when a single-business deployment was expected, is refused');
  const okSides = wire(fresh());
  const okRun = await lib.migrate({ source: side('source'), target: side('target', { business: 'zulu-co' }), fetchImpl: okSides.fetchImpl, pageSize: 50 });
  check(okRun.ok && okRun.steps[0].name === 'who is who' && okRun.steps[0].target === 'zulu-co' && okRun.steps[0].source === 'the single-business deployment', 'and when each end is what was asked for, it is the FIRST thing the run records, then it proceeds');

  // ---- the team is checked BEFORE anything is copied -------------------------------------------------------------------------------------------------------------------------
  const team = { asked: [] }, wt = wire(fresh(), team);
  const checked = await lib.migrate({ source: side('source'), target: side('target', { business: 'zulu-co' }), fetchImpl: wt.fetchImpl, pageSize: 2 });
  const firstWrite = wt.calls.findIndex((c) => c.host === 'target' && c.method === 'POST' && c.path.startsWith('/admin/migration/')), checkAt = wt.calls.findIndex((c) => c.path === '/debug/directory/check-members');
  check(checked.ok && checkAt >= 0 && checkAt < firstWrite && team.asked[0].emails.sort().join() === 'crew@x.co,owner@x.co' && team.asked[0].business_id === 'zulu-co', 'the team is checked in the directory BEFORE the first write to the target, and only the ACTIVE members are asked about');
  const clash = { conflicts: [{ email: 'crew@x.co', business_id: 'other-co' }] }, wc = wire(fresh(), clash);
  const clashed = await lib.migrate({ source: side('source'), target: side('target', { business: 'zulu-co' }), fetchImpl: wc.fetchImpl, pageSize: 2 });
  check(!clashed.ok && /crew@x\.co \(in other-co\)/.test(clashed.mismatches.join()) && /NOTHING was copied/.test(clashed.mismatches.join()) && !wc.calls.some((c) => c.host === 'target' && c.method === 'POST' && c.path.startsWith('/admin/migration/')), 'if a team member already belongs to another business, the run STOPS before copying anything and names them (nothing at all is written to the target)');

  // ---- memories: listed through Cloudflare's API, copied in batches, verified AFTER the target has processed them ----------------------------------------------------------
  const vw = fresh(), wv = wire(vw, { scopedTarget: true });
  const vopts = { accountId: 'a', apiToken: 't', indexName: 'src-index', targetIndexName: 'tgt-index', maxWaitMs: 400 };
  const vrun = await lib.migrate({ source: side('source'), target: side('target', { business: 'zulu-co' }), fetchImpl: wv.fetchImpl, vectors: vopts, pollMs: 1 });
  const mstep = vrun.steps.find((s) => s.name === 'memories');
  check(vrun.ok === true && mstep.listed === 45 && mstep.copied === 45 && mstep.differ === 0 && mstep.processed === true, 'memories: 45 are listed through Cloudflare\'s API, copied in batches of 20, the runner WAITS until the target index reports it has processed the last write, and every one reads back identical', JSON.stringify(mstep) + ' ' + vrun.mismatches.join('; '));
  check([...vw.T.mem.vecs.keys()].length === 45 && [...vw.T.mem.vecs.entries()].every(([id, v]) => id.startsWith(sb.vectorPrefix('zulu-co')) && v.namespace === 'zulu-co'), 'in the target index every memory sits under the business\'s prefix and namespace');
  check(wv.calls.filter((c) => c.host === 'api.cloudflare.com' && c.path.endsWith('/info')).length >= 2, 'the wait really polled Cloudflare\'s index info (the writes were not visible at first, as on the real index)');
  check(vrun.steps.every((s) => typeof s.ms === 'number' && s.ms >= 0), 'every step of the run is timed, so a slow migration shows where its time went');
  const reordered = fresh();
  for (const [id, v] of reordered.S.mem.vecs) reordered.S.mem.vecs.set(id, { ...v, metadata: { text: v.metadata.text, customerId: v.metadata.customerId } });   // the same metadata, keys in the other order
  const rrun = await lib.migrate({ source: side('source'), target: side('target', { business: 'zulu-co' }), fetchImpl: wire(reordered, { scopedTarget: true }).fetchImpl, vectors: vopts, pollMs: 1 });
  check(rrun.ok === true && rrun.steps.find((s) => s.name === 'memories').differ === 0, 'memories whose metadata comes back with its keys in a different order are still the same memories');
  // Found on the real index: Cloudflare said the writes were processed, yet reads straight afterwards still showed old state (25 of 45 differed after 120 s; none did after 160 s).
  const laggy = fresh(); laggy.T.mem.lagReads(3);
  const lrun = await lib.migrate({ source: side('source'), target: side('target', { business: 'zulu-co' }), fetchImpl: wire(laggy, { scopedTarget: true }).fetchImpl, vectors: vopts, pollMs: 1 });
  const lstep = lrun.steps.find((s) => s.name === 'memories');
  check(lrun.ok === true && lstep.firstPassDiffered === 45 && lstep.differ === 0 && typeof lstep.readLagSeconds === 'number', 'when reads LAG behind the index\'s processed marker, only the memories that differ are checked again, and the run passes once they settle (it does not call a timing lag a difference)', JSON.stringify(lstep));
  const broken = fresh(); broken.T.mem.hide(`${sb.vectorPrefix('zulu-co')}pmf-3`);
  const brun = await lib.migrate({ source: side('source'), target: side('target', { business: 'zulu-co' }), fetchImpl: wire(broken, { scopedTarget: true }).fetchImpl, vectors: { ...vopts, verifyMaxMs: 20 }, pollMs: 1 });
  check(!brun.ok && /1 differ after being read back/.test(brun.mismatches.join()) && brun.steps.find((s) => s.name === 'memories').firstPassDiffered === 1, 'but a memory that NEVER reads back correctly is still reported once the time is up: the re-checking only forgives lag, not damage');
  // Production has ONE index: on a re-run the business's own copies (prefixed ids) are in the listing and must not be copied again as if they were originals.
  const shared = fresh();
  for (let i = 1; i <= 3; i++) shared.S.mem.vecs.set(`${sb.vectorPrefix('zulu-co')}pmf-${i}`, { values: [i, 1, 0], metadata: { customerId: '1', text: `copy ${i}` }, namespace: 'zulu-co' });
  const wsh = wire(shared, { scopedTarget: true });
  const shrun = await lib.migrate({ source: side('source'), target: side('target', { business: 'zulu-co' }), fetchImpl: wsh.fetchImpl, vectors: { ...vopts, targetIndexName: 'src-index' }, pollMs: 1 });
  const shstep = shrun.steps.find((s) => s.name === 'memories');
  check(shrun.ok === true && shstep.listed === 45 && shstep.skippedCopiesAlreadyInTheIndex === 3 && shstep.copied === 45, 'when the source and the target use the SAME index, the business\'s own copies already in it are skipped, not copied again as if they were originals (3 skipped, 45 copied)', JSON.stringify(shstep));
  const stalled = fresh(); stalled.T.mem.stall(true);
  const srun = await lib.migrate({ source: side('source'), target: side('target', { business: 'zulu-co' }), fetchImpl: wire(stalled, { scopedTarget: true }).fetchImpl, vectors: { ...vopts, maxWaitMs: 20 }, pollMs: 1 });
  check(srun.steps.find((s) => s.name === 'memories').readLagSeconds === 0, 'and it does not then burn its whole re-checking time on writes that were never processed');
  check(!srun.ok && srun.mismatches.some((m) => /had not processed the writes/.test(m)), 'if the target index never catches up, the run is NOT ok and says it could not verify the memories (it does not report them as copied)');

  // ---- ONE notes store and ONE bucket sharedStores by the source and the business's object: exactly production --------------------------------------------------------------------------
  const sharedStores = fresh();
  sharedStores.T.env = { ...sharedStores.T.env, BUSINESS_ID: 'zulu-co', CUSTOMER_NOTES: sb.scopeKv(sharedStores.S.env.CUSTOMER_NOTES, 'zulu-co'), OFFICE_VAULT: sb.scopeR2(sharedStores.S.env.OFFICE_VAULT, 'zulu-co') };
  const wShared = wire(sharedStores);
  const sharedRun = await lib.migrate({ source: side('source'), target: side('target', { business: 'zulu-co' }), fetchImpl: wShared.fetchImpl, pageSize: 50 });
  check(sharedRun.ok === true && sharedRun.mismatches.length === 0, `with the notes store and bucket SHARED by the source and the target (production), the run passes: the source does not count the business\'s own copies (the first real copy reported double and failed here) [ok=${sharedRun.ok} error=${sharedRun.error} after=${sharedRun.failedAfter} mismatches=${sharedRun.mismatches.join('; ')}]`);
  const physical = [...sharedStores.S.kv.keys()];
  const detail = `[kv=${physical.length} prefixedOnce=${physical.filter((k) => k.startsWith('b:zulu-co:')).length} twice=${physical.filter((k) => k.includes('b:zulu-co:b:')).length} r2=${[...sharedStores.S.r2.keys()].length}]`;
  check(physical.length === 240 && physical.filter((k) => k.startsWith('b:zulu-co:')).length === 120 && !physical.some((k) => k.includes('b:zulu-co:b:')) && [...sharedStores.S.r2.keys()].length === 210 && ![...sharedStores.S.r2.keys()].some((k) => k.includes('b/zulu-co/b/')), 'physically the store holds the 120 originals and the 120 prefixed copies (and the files likewise), and nothing is prefixed twice ' + detail);
  const forcedAgain = await lib.migrate({ source: side('source'), target: side('target', { business: 'zulu-co' }), fetchImpl: wire(sharedStores).fetchImpl, force: true, pageSize: 50 });
  check(forcedAgain.ok === true && [...sharedStores.S.kv.keys()].length === 240 && ![...sharedStores.S.kv.keys()].some((k) => k.includes('b:zulu-co:b:')), 'a forced SECOND run in the sharedStores stores copies the originals again and does NOT copy the copies (still 240 keys, none prefixed twice)');

  // ---- verify only: read both ends, write NOTHING ------------------------------------------------------------------------------------------------------------------------------
  const wVerify = wire(sharedStores);
  const verified = await lib.migrate({ source: side('source'), target: side('target', { business: 'zulu-co' }), fetchImpl: wVerify.fetchImpl, verifyOnly: true });
  check(verified.ok === true && verified.steps.map((s) => s.name).join() === 'who is who,fingerprints compared' && !wVerify.calls.some((c) => c.method === 'POST'), 'verify-only asks both ends who they are, compares their fingerprints, and makes NO write request of any kind');
  sharedStores.T.db.prepare("UPDATE customers SET name = 'TAMPERED' WHERE id = 1").run();
  const tampered = await lib.migrate({ source: side('source'), target: side('target', { business: 'zulu-co' }), fetchImpl: wire(sharedStores).fetchImpl, verifyOnly: true });
  check(!tampered.ok && tampered.mismatches.some((m) => /table customers: same row count/.test(m)), 'and it notices a changed cell');
  const selfVerify = fresh(); selfVerify.T.env = selfVerify.S.env;
  const refusedVerify = await lib.migrate({ source: side('source'), target: side('target', { business: 'zulu-co' }), fetchImpl: wire(selfVerify).fetchImpl, verifyOnly: true });
  check(!refusedVerify.ok && /refusing to copy/.test(refusedVerify.mismatches.join()), 'verify-only still refuses when the two ends are not what was asked for (the same deployment)');
  check(/--verify-only/.test(fs.readFileSync(path.join(__dirname, 'migrate.mjs'), 'utf8')) && /verifyOnly: process\.argv\.includes\('--verify-only'\)/.test(fs.readFileSync(path.join(__dirname, 'migrate.mjs'), 'utf8')), 'the command line has --verify-only');

  // ---- it will not mix, and a second run is safe ---------------------------------------------------------------------------------------------------------------------
  const w2 = wire(world);
  const refused = await lib.migrate({ source: side('source'), target: side('target', { business: 'zulu-co' }), fetchImpl: w2.fetchImpl });
  check(!refused.ok && /refusing to mix/.test(refused.mismatches.join()) && !w2.calls.some((c) => c.host === 'target' && c.method === 'POST'), 'a target that already holds data is refused, and NOTHING is written to it');
  const forced = await lib.migrate({ source: side('source'), target: side('target', { business: 'zulu-co' }), fetchImpl: wire(world).fetchImpl, force: true });
  check(forced.ok === true && mg.compareFingerprints(fa, await mg.fingerprint(world.T.env)).length === 0, 'with force a second run succeeds and changes nothing');

  // ---- it reports a copy that silently lost something ------------------------------------------------------------------------------------------------------------------
  const dropFrom = (table) => ({ rewriteBody: ({ host, method, path, body }) => { if (host === 'target' && method === 'POST' && path === '/admin/migration/rows') { const j = JSON.parse(body); if (j.table === table && j.rows.length) { j.rows = j.rows.slice(0, -1); return JSON.stringify(j); } } return undefined; } });
  const lossy = fresh();
  const lost = await lib.migrate({ source: side('source'), target: side('target', { business: 'zulu-co' }), fetchImpl: wire(lossy, dropFrom('lazy_things')).fetchImpl, pageSize: 1 });
  check(!lost.ok && lost.mismatches.some((m) => /table lazy_things: 2 rows in the source, 0 in the target/.test(m)), 'if the target silently drops rows, the run is NOT ok and says which table', lost.mismatches.join('; '));
  const orphaned = fresh();
  const orphanRun = await lib.migrate({ source: side('source'), target: side('target', { business: 'zulu-co' }), fetchImpl: wire(orphaned, dropFrom('customers')).fetchImpl, pageSize: 1 });
  check(orphanRun.ok === false && /FOREIGN KEY constraint failed/.test(orphanRun.error ?? '') && typeof orphanRun.failedAfter === 'string' && orphanRun.failedAfter.length > 0 && orphanRun.steps.length === orphanRun.steps.filter((s) => s.name).length && orphaned.T.db.prepare('SELECT COUNT(*) AS n FROM payments').get().n === 0, 'and if a parent row goes missing, the database REFUSES the payment that references it (no orphan is ever created) and the run stops, reporting the error and the last step it completed', JSON.stringify({ error: orphanRun.error, after: orphanRun.failedAfter }));
  const garbled = fresh();
  const wg = wire(garbled, { before: async ({ host, method, path, init }) => { if (host === 'target' && method === 'POST' && path === '/admin/migration/file') { const bytes = new Uint8Array(init.body); bytes[0] ^= 1; init.body = bytes; } return null; } });
  const garble = await lib.migrate({ source: side('source'), target: side('target', { business: 'zulu-co' }), fetchImpl: wg.fetchImpl });
  check(!garble.ok && garble.mismatches.some((m) => /files: same count/.test(m)), 'if a file arrives with one byte changed, the run is NOT ok');

  // ---- glitches and answers ----------------------------------------------------------------------------------------------------------------------------------------------------
  const glitchy = fresh(); let boom = 0;
  const wb = wire(glitchy, { before: async ({ host, path }) => { if (host === 'source' && path === '/admin/migration/manifest' && boom++ < 2) return new Response('upstream glitch', { status: 503 }); return null; } });
  const ok503 = await lib.migrate({ source: side('source'), target: side('target', { business: 'zulu-co' }), fetchImpl: wb.fetchImpl });
  check(ok503.ok === true && boom === 3, 'a 503 glitch is retried and the run still completes (found live: a new deploy takes a moment to reach every location)');
  const denied = fresh(); let tries = 0;
  const wd = wire(denied, { before: async ({ host, path }) => { if (host === 'source' && path === '/admin/migration/whoami') { tries++; return new Response('{"error":"forbidden"}', { status: 403 }); } return null; } });
  const denial = await lib.migrate({ source: side('source'), target: side('target', { business: 'zulu-co' }), fetchImpl: wd.fetchImpl });
  check(denial.ok === false && /403/.test(denial.error ?? '') && tries === 1 && denial.failedAfter === 'the start', 'a 403 is an ANSWER, not a glitch: it stops at once, is not retried, and is REPORTED (the first real rehearsal crashed and printed nothing)');
  check(Array.isArray(denial.steps) && typeof denial.durationMs === 'number', 'a failed run still returns its steps and its duration, so the command line can always print a report');

  // ---- pieces ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const m = await mg.manifest(world.S.env), order = lib.copyOrder(m.tables);
  check(order.indexOf('customers') < order.indexOf('payments') && order.length === m.tables.length && new Set(order).size === order.length, 'tables are copied parents first (customers before the payments that reference them), each exactly once');
  const same = { tables: { a: { count: 1, hash: 'x' } }, sequences: { a: 3 }, notes: { count: 1, hash: 'n' }, files: { count: 1, hash: 'f' } };
  const variants = [same, { ...same, tables: { a: { count: 2, hash: 'x' } } }, { ...same, tables: { a: { count: 1, hash: 'y' } } }, { ...same, sequences: { a: 2 } }, { ...same, notes: { count: 2, hash: 'n' } }, { ...same, notes: { count: 1, hash: 'z' } }, { ...same, files: { count: 0, hash: 'f' } }, { ...same, files: { count: 1, hash: 'g' } }, { ...same, tables: {} }];
  check(variants.every((v) => JSON.stringify(lib.compareFingerprints(same, v)) === JSON.stringify(mg.compareFingerprints(same, v))), 'the runner\'s comparison agrees with the Worker\'s on every kind of difference');
  const libSrc = fs.readFileSync(path.join(__dirname, 'migrate-lib.mjs'), 'utf8');
  check(/if \(\(occupied\.length \|\| before\.notes\.count \|\| before\.files\.count\) && !force\)/.test(libSrc) && /report\.ok = report\.mismatches\.length === 0;/.test(libSrc), 'the refusal to mix and the final verdict are what the tests above exercise');
  const cli = fs.readFileSync(path.join(__dirname, 'migrate.mjs'), 'utf8');
  check(/process\.env/.test(cli) && !/--(source|target)-?key/.test(cli) && /process\.exit\(report\.ok \? 0 : 1\)/.test(cli), 'the command line takes its keys from the environment (never the command line, which lands in shell history) and exits non-zero unless the proof passed');
};
