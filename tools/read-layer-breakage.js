// Proof that the read layer tests and the date reader tests are not decorative: each line breaks one guard and the matching test must then FAIL.
// Run: NODE_PATH=worker/node_modules node --no-warnings tools/read-layer-breakage.js
const fs = require('fs'), os = require('os'), path = require('path'), esbuild = require('esbuild');
const root = path.join(__dirname, '..'), workerDir = path.join(root, 'worker');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rlb-')), copy = path.join(tmp, 'worker');
fs.cpSync(workerDir, copy, { recursive: true, filter: (src) => !src.split(path.sep).includes('node_modules') });
fs.symlinkSync(path.join(workerDir, 'node_modules'), path.join(copy, 'node_modules'));
fs.copyFileSync(path.join(root, 'FEATURES.md'), path.join(tmp, 'FEATURES.md'));
const F = { rl: path.join(copy, 'src', 'read-layer.ts'), index: path.join(copy, 'src', 'index.ts'), sched: path.join(copy, 'src', 'scheduler.ts') };
const O = Object.fromEntries(Object.entries(F).map(([k, f]) => [k, fs.readFileSync(f, 'utf8')]));
const srcDir = path.join(copy, 'src');
const bundleTo = (entry, name) => { const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dt-')), name); esbuild.buildSync({ entryPoints: [path.join(srcDir, entry)], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent' }); return require(out); };
const runRL = () => require('./read-layer.test.js')({ check: null, srcDir });
const M = [
  ['rl', 'read', 'any role may use it (not owner only)', 'who.role !== "owner"', 'false'],
  ['rl', 'read', 'READ_LAYER=off does not switch it off', 'env.READ_LAYER === "off" || ', ''],
  ['rl', 'read', 'a message with a number is taken', ' || /\\d/.test(q)', ''],
  ['rl', 'read', 'a money question is taken', 'if (MONEY.test(q)) return null;', ''],
  ['rl', 'read', 'a message that is not question-shaped is taken', ' || !STARTER.test(q)', ''],
  ['rl', 'read', 'coming up volunteers things far off', 'const AHEAD_DAYS = 14;', 'const AHEAD_DAYS = 400;'],
  ['rl', 'read', 'today leaves out what is overdue', 'label: `Today, ${short(t)}`, days: false, overdue: true', 'label: `Today, ${short(t)}`, days: false, overdue: false'],
  ['rl', 'read', 'past jobs appear', '{ from: w.from, to: w.to }, null)).items', '{ from: null, to: null }, null)).items'],
  ['rl', 'read', 'a converted quote is called open', '["converted", "rejected", "declined", "void", "lost"]', '[]'],
  ['rl', 'read', 'a low stock item is not flagged', '(at or below the reorder level of ${s.reorder_threshold})', ''],
  ['rl', 'read', 'a customer\'s jobs include everyone\'s', 'jobsData(env, PAGE, NO_RANGE, customer.id)', 'jobsData(env, PAGE, NO_RANGE, null)'],
  ['rl', 'read', 'the date is read from the wrong weekday', 'DAYS[now.getDay()]', 'DAYS[(now.getDay() + 1) % 7]'],
  ['rl', 'read', 'undated jobs are mixed into the dated ones', 'Not yet scheduled:', 'Soon:'],
  ['index', 'read', 'the typed route does not keep what was heard', 'if (readAnswer) captured = await logCapture(env, text, "text", null);', ''],
  ['index', 'read', 'the typed route does not record the read layer', '{ interpreted: { intent: "lookup", read_layer: readAnswer.kind } }', '{}'],
  ['index', 'read', 'the voice route never asks the read layer', 'spokenRead ? followUpReply(transcript, spokenRead.message)', 'false ? followUpReply(transcript, "")'],
  ['sched', 'dates', 'an ISO date is misread again', 'const isoMatch = phrase.match(', 'const isoMatch = null && phrase.match('],
  ['sched', 'dates', '"from now" is a duration again', 'const fromNow = phrase.match(', 'const fromNow = null && phrase.match('],
  ['sched', 'dates', 'a count in words is not read', 'const inCount = phrase.match(/in\\s+(\\d+|a|one|two', 'const inCount = phrase.match(/in\\s+(\\d+|ZZZ|YYY'],
  ['sched', 'dates', 'the word today is read before "from today"', 'const fromNow = phrase.match(', 'if (phrase.includes("today")) return toIso(now);\n  const fromNow = phrase.match('],
];
(async () => {
  let missed = 0;
  const reset = () => { for (const [k, f] of Object.entries(F)) fs.writeFileSync(f, O[k]); };
  const clear = () => { for (const n of ['rm-poe', 'rm-auth']) delete require.cache[path.join(os.tmpdir(), `${n}-${process.pid}.js`)]; };
  const exec = async (which) => { const fails = []; const check = (ok, label) => { if (!ok) fails.push(label); };
    if (which === 'read') await require('./read-layer.test.js')({ check, srcDir }); else await require('./dates.test.js')({ check, bundleTo }); return fails; };
  reset(); clear(); { const a = await exec('read'), b = await exec('dates'); console.log(`baseline (nothing broken): ${a.length + b.length} failing checks (must be 0)`); if (a.length + b.length) { console.log([...a, ...b].join('\n')); process.exit(1); } }
  for (const [k, which, name, from, to] of M) {
    reset();
    if (!O[k].includes(from)) { console.log(`NOT APPLIED  ${name}: text not found in ${k} (update this script)`); missed++; continue; }
    fs.writeFileSync(F[k], O[k].replace(from, to)); clear();
    let fails; try { fails = await exec(which); } catch (e) { fails = ['threw: ' + String(e.message).slice(0, 80)]; }
    if (fails.length === 0) { missed++; console.log(`NOT CAUGHT   ${name}`); } else console.log(`caught (${String(fails.length).padStart(2)})  ${name}`);
  }
  reset();
  console.log(missed === 0 ? `\nall ${M.length} read layer and date reader guards are held by a test that fails when the guard is removed` : `\n${missed} problem(s): see above`);
  process.exit(missed === 0 ? 0 : 1);
})();
