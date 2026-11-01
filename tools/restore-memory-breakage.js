// Deliberate-breakage proof for the restore memory change (HANDOVER rule 8: security-sensitive code; a restore is the one thing that must work on the worst day). Every safeguard the change
// added or kept is removed or weakened IN TURN, in a fresh process each time, and tools/restore-memory.test.js or tools/backup.test.js must then FAIL. A mutation neither suite catches is a
// hole in the tests and fails this script. Every file is restored in a finally block and again on exit: a killed run once left a mutated module behind.
// Run: NODE_PATH=worker/node_modules node tools/restore-memory-breakage.js   (about two minutes: run it as one tool call, not inside the umbrella).
const fs = require('fs'), os = require('os'), path = require('path'), { spawnSync } = require('child_process');
const root = path.join(__dirname, '..');
const BACKUP = 'worker/src/backup.ts';
const KEEP = '    await gunzip(bytes);\n    tableBytes.set(t.name, bytes);';

const MUTATIONS = [
  { name: 'checksum: do not verify a part against its recorded size and SHA-256', find: 'if (bytes.length !== part.bytes || (await sha256(bytes)) !== part.sha256) throw new Error(`a part of the snapshot is damaged (its checksum does not match): ${part.key}`);', replace: 'if (false) throw new Error("mutation");' },
  { name: 'up front: do not decompress each part once to prove it can be', find: KEEP, replace: '    tableBytes.set(t.name, bytes);' },
  { name: 'apply: read the bucket again inside the transaction', find: 'const text = await gunzip(tableBytes.get(name) ?? new Uint8Array());', replace: 'const text = await getPart(bucket, manifest.tables.find((x) => x.name === name)!.part);' },
  { name: 'memory: keep every table\'s decompressed text through the safety snapshot and the apply', find: KEEP, replace: '    ((globalThis as any).__keep ??= []).push(await gunzip(bytes));\n    tableBytes.set(t.name, bytes);' },
  { name: 'pager: pages of 201', find: 'if (page.length === pageSize) {', replace: 'if (page.length === pageSize + 1) {' },
  { name: 'pager: lose a character at every line break', find: 'start = end + 1;', replace: 'start = end + 2;' },
  { name: 'pager: skip over a row that is not JSON', find: 'page.push(JSON.parse(text.slice(start, end)) as Record<string, unknown>);', replace: 'try { page.push(JSON.parse(text.slice(start, end)) as Record<string, unknown>); } catch { /* mutation: skipped */ }' },
];

const originals = new Map();
const restoreAll = () => { for (const [f, text] of originals) fs.writeFileSync(path.join(root, f), text); };
process.on('exit', restoreAll);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { restoreAll(); process.exit(130); });

const backupRunner = path.join(os.tmpdir(), `restore-breakage-backup-runner-${process.pid}.js`);
fs.writeFileSync(backupRunner, `global.__RealResponse = global.Response; const srcDir = ${JSON.stringify(path.join(root, 'worker', 'src'))}; let total = 0, fails = 0;
const check = (c, m) => { total++; if (!c) { fails++; console.log('FAIL  ' + m); } };
require(${JSON.stringify(path.join(__dirname, 'backup.test.js'))})({ check, srcDir }).then(() => { console.log(total - fails + '/' + total + ' correct, ' + fails + ' failing'); process.exit(fails ? 1 : 0); }).catch((e) => { console.log('CRASHED ' + (e && e.message)); process.exit(2); });\n`);

const env = { ...process.env, NODE_PATH: path.join(root, 'worker', 'node_modules') };
const runOne = (file) => {
  const r = spawnSync(process.execPath, ['--no-warnings', file], { env, encoding: 'utf8', timeout: 180000 });
  const out = r.stdout || '';
  const m = /(\d+)\/(\d+) correct, (\d+) failing/.exec(out);
  return { crashed: !m, failing: m ? Number(m[3]) : null, first: (out.split('\n').find((l) => l.startsWith('FAIL')) || '').slice(0, 120) };
};
const runBoth = () => ({ memory: runOne(path.join(__dirname, 'restore-memory.test.js')), backup: runOne(backupRunner) });
const caught = (x) => x.memory.failing > 0 || x.backup.failing > 0;   // a clean failing check in EITHER suite; the other suite crashing on the same mutation is just more noise, not a miss

let bad = 0;
const base = runBoth();
console.log(`unmutated: restore-memory ${base.memory.failing === 0 ? 'green' : 'NOT green'}, backup ${base.backup.failing === 0 ? 'green' : 'NOT green'}`);
if (base.memory.failing !== 0 || base.backup.failing !== 0) { console.log('both suites must be green before a mutation means anything'); process.exit(1); }

for (const [i, m] of MUTATIONS.entries()) {
  const full = path.join(root, BACKUP);
  if (!originals.has(BACKUP)) originals.set(BACKUP, fs.readFileSync(full, 'utf8'));
  const text = originals.get(BACKUP);
  if (text.split(m.find).length !== 2) { console.log(`${i + 1}. ${m.name}: the text to mutate is not found exactly once (the code moved: update this script)`); bad++; continue; }
  let res;
  try { fs.writeFileSync(full, text.replace(m.find, () => m.replace)); res = runBoth(); } finally { fs.writeFileSync(full, text); }
  const ok = caught(res);
  if (!ok) bad++;
  const by = res.memory.failing > 0 ? `restore-memory: ${res.memory.first}` : res.backup.failing > 0 ? `backup: ${res.backup.first}` : '';
  console.log(`${i + 1}. ${ok ? 'CAUGHT  ' : (res.memory.crashed || res.backup.crashed) ? 'CRASHED ' : 'SURVIVED'} ${m.name}${ok ? `  (${by})` : ''}`);
}
console.log(bad ? `\n${bad} mutation(s) not caught: the tests have a hole` : `\nall ${MUTATIONS.length} mutations caught`);
process.exit(bad ? 1 : 0);
