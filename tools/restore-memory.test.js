// Restore memory (worker/src/backup.ts, branch claim/restore-1, decided with Pierre 2026-11-01). The restore drill on Cloudflare first failed on 2026-10-28 when the restore itself returned
// "Durable Object's isolate exceeded its memory limit and was reset" at 41,534 rows, having passed at 41,508 three days earlier: a restore at the edge of the limit. What it held at once:
// EVERY table's decompressed text (a map of all of them), then a full SAFETY SNAPSHOT of the current state taken while still holding it, then a whole table parsed into an array of objects
// (customers: 26,000 rows) before the first insert. TESTS FIRST. The properties this file pins, none of which need Cloudflare:
//   1. the pager that replaces "split the whole table, filter, parse the whole table" returns exactly what that did, in pages of at most 200, whatever the text looks like
//   2. every snapshot part is read from the backup bucket BEFORE the first row is deleted, once each, and never inside the transaction (atomic.ts: only the database is touched in there)
//   3. a restore of a staging-sized business completes within a 24 MB JavaScript heap (tools/restore-memory-probe.js): it must not hold every table at once. A local heap is not a Durable
//      Object's 128 MB, so this proves "does not grow with every table at once"; only the staging drill proves it fits on Cloudflare.
// Expected state when first committed: RED (backup.ts has no pager yet and the probe runs out of memory).
const path = require('path'), { spawnSync } = require('child_process');

// An exception here must show up as a FAILING CHECK, never as a crash: in the umbrella a throw would abort every suite after it.
module.exports = async function runRestoreMemoryTests(context) {
  const standIn = global.Response;   // the umbrella stubs Response; snapshots are gzipped through the real one (as tools/backup.test.js does)
  if (global.__RealResponse) global.Response = global.__RealResponse;
  try { await suite(context); } catch (e) { context.check(false, 'the restore memory suite threw instead of failing a check: ' + String((e && e.message) || e).slice(0, 160)); } finally { global.Response = standIn; }
};

async function suite({ check, bundleTo }) {
  const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  // ---- 1. the pager ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const bk = bundleTo('backup.ts', 'rmt-backup.js');
  if (typeof bk.jsonLinePages !== 'function') {
    check(false, 'backup.ts exports jsonLinePages(text, pageSize): rows read one page at a time, not a whole table at once (it does not exist yet)');
  } else {
    const oldWay = (text) => text.split('\n').filter(Boolean).map((l) => JSON.parse(l));   // what restore did: every row of a table in memory at once, three times over
    const rows = (n) => Array.from({ length: n }, (_, i) => JSON.stringify({ id: i + 1, name: `Customer ${i + 1} "q" \u2713`, note: null }));
    const texts = {
      'empty text': '', 'one newline': '\n', 'a single row with no newline': rows(1).join('\n'), 'three rows and a trailing newline': rows(3).join('\n') + '\n',
      '199 rows': rows(199).join('\n'), '200 rows': rows(200).join('\n'), '201 rows': rows(201).join('\n'), '400 rows and a trailing newline': rows(400).join('\n') + '\n',
      '401 rows with a blank line between each': rows(401).join('\n\n'), 'a very long row': JSON.stringify({ id: 1, note: 'x'.repeat(300000) }),
    };
    for (const [label, text] of Object.entries(texts)) {
      const pages = [...bk.jsonLinePages(text, 200)];
      check(sameJson(pages.flat(), oldWay(text)), `the pager returns exactly the rows the old split-filter-parse did: ${label}`);
      check(pages.every((p, i) => p.length > 0 && (i === pages.length - 1 ? p.length <= 200 : p.length === 200)), `and in pages of 200, only the last one shorter, none empty: ${label}`);
    }
    let threw = false;
    try { [...bk.jsonLinePages('{"id":1}\nnot json\n{"id":3}', 200)]; } catch (e) { threw = true; }
    check(threw, 'a row that is not JSON still throws (a damaged part is never skipped over)');
  }

  // ---- 2. the order of reads and deletes -------------------------------------------------------------------------------------------------------------------------------------------------------------
  const probe = require('./restore-memory-probe.js');
  const events = [];
  const w = probe.buildWorld(300, { onSql: (q) => { if (/^\s*delete\s+from/i.test(q)) events.push('delete'); }, onGet: (bucket, key) => events.push('get:' + bucket + ':' + key) });
  const snap = await w.bk.takeSnapshot(w.env, new Date('2026-10-14T03:05:09Z'));
  events.length = 0;   // only what the RESTORE does from here on
  const report = await w.bk.restoreSnapshot(w.env, snap.name, 'zulu-co');
  check(Boolean(report) && report.ok === true, 'the restore of a small business still succeeds and reports itself ok');
  const firstDelete = events.indexOf('delete');
  check(firstDelete > 0, 'the restore deletes rows, and reads from the backup bucket before it does');
  check(firstDelete > 0 && events.slice(firstDelete).every((e) => !e.startsWith('get:')), 'NO read from the backup bucket happens after the first row is deleted: nothing but the database is touched inside the transaction');
  const tableReads = events.filter((e) => e.includes('/tables/'));
  check(tableReads.length === snap.tables.length && new Set(tableReads).size === tableReads.length, `each of the ${snap.tables.length} table parts is read from the bucket exactly once (read ${tableReads.length}, ${new Set(tableReads).size} different)`);

  // ---- 2b. a part that passes its checksum but will not decompress is refused BEFORE anything is touched ----------------------------------------------------------------------------------------
  // (The checksum is over the compressed bytes; the old code decompressed every part up front, so such a part was found before the safety snapshot and the lock. It still must be.)
  {
    const puts = [];
    const w2 = probe.buildWorld(50, { onPut: (bucket, key) => puts.push(bucket + ':' + key) });
    const snap2 = await w2.bk.takeSnapshot(w2.env, new Date('2026-10-14T03:05:09Z'));
    const crypto = require('crypto');
    const victim = snap2.tables.find((t) => t.name === 'customers');
    const junk = new TextEncoder().encode('this is not gzip at all');
    w2.backups.m.set(victim.part.key, { bytes: junk, meta: {} });
    victim.part.bytes = junk.length; victim.part.sha256 = crypto.createHash('sha256').update(junk).digest('hex');
    w2.backups.m.set(`zulu-co/${snap2.name}/manifest.json`, { bytes: new TextEncoder().encode(JSON.stringify(snap2)), meta: {} });
    for (let i = 1; i <= 3; i++) w2.db.prepare('INSERT INTO customers (name, address) VALUES (?, ?)').run(`DAMAGE ${i}`, 'x');
    const customersBefore = w2.count('customers');
    puts.length = 0;
    let refused = null;
    try { await w2.bk.restoreSnapshot(w2.env, snap2.name, 'zulu-co'); } catch (e) { refused = String((e && e.message) || e); }
    check(refused !== null, 'a part with a MATCHING checksum that is not valid gzip makes the restore refuse');
    check(!puts.some((k) => k.includes('-pre-restore')), 'and it is found before the safety snapshot is taken (nothing was written to the backup bucket)');
    check(w2.count('customers') === customersBefore, 'and before a single row is touched');
  }

  // ---- 3. a staging-sized business within a small heap ---------------------------------------------------------------------------------------------------------------------------------------
  // The default backend only: the Durable Object adapter step would repeat it for nothing.
  if (process.env.HARNESS_BACKEND === 'do') {
    console.log('  restore memory: the heap-capped probe runs on the default backend step only');
  } else {
    const run = spawnSync(process.execPath, ['--no-warnings', '--max-old-space-size=24', path.join(__dirname, 'restore-memory-probe.js'), '26000'], {
      env: { ...process.env, NODE_PATH: process.env.NODE_PATH || path.join(__dirname, '..', 'worker', 'node_modules') }, encoding: 'utf8', timeout: 150000,
    });
    const out = (run.stdout || '') + (run.stderr || '');
    check(/^OK rows=4\d{4}\b/m.test(run.stdout || ''), 'a restore of a staging-sized business (about 41k rows) completes within a 24 MB JavaScript heap (' + (/heap out of memory/.test(out) ? 'it ran out of memory' : (run.stdout || out).trim().slice(0, 100)) + ')');
  }
}

// Run on its own (node tools/restore-memory.test.js). The umbrella requires it instead.
if (require.main === module) {
  const esbuild = require('esbuild'), os = require('os');
  const srcDir = path.join(__dirname, '..', 'worker', 'src');
  let total = 0, fails = 0;
  const check = (c, m) => { total++; if (!c) { fails++; console.log('FAIL  ' + m); } };
  const bundleTo = (entry, name) => { const out = path.join(os.tmpdir(), name); esbuild.buildSync({ entryPoints: [path.join(srcDir, entry)], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent' }); return require(out); };
  module.exports({ check, bundleTo }).then(() => { console.log(`\n${total - fails}/${total} correct, ${fails} failing`); process.exit(fails ? 1 : 0); }).catch((e) => { console.log('SUITE CRASHED: ' + (e && e.stack || e)); process.exit(2); });
}
