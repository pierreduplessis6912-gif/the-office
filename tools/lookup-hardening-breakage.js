// Proof that the lookup-hardening tests are not decorative: each line breaks one part of answerFromMemory's no-answer or failure path (worker/src/ai.ts) and tools/lookup-hardening.test.js must then FAIL.
// Run: NODE_PATH=worker/node_modules node --no-warnings tools/lookup-hardening-breakage.js
const fs = require('fs'), os = require('os'), path = require('path');
const root = path.join(__dirname, '..'), workerDir = path.join(root, 'worker');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lhb-')), copy = path.join(tmp, 'worker');
fs.cpSync(workerDir, copy, { recursive: true, filter: (src) => !src.split(path.sep).includes('node_modules') });
fs.symlinkSync(path.join(workerDir, 'node_modules'), path.join(copy, 'node_modules'));
const file = path.join(copy, 'src', 'ai.ts'), original = fs.readFileSync(file, 'utf8');
const run = require('./lookup-hardening.test.js');
const MUTATIONS = [
  ['a reply that says "I don\'t have that on file" keeps the facts it listed', 'return SAYS_NO_ANSWER.test(answer) ? LOOKUP_NO_ANSWER : answer.trim();', 'return answer.trim();'],
  ['the cut applies to any reply that mentions it, not only one that opens with it', "const SAYS_NO_ANSWER = /^\\s*i don['’]t have that on file\\b/i;", "const SAYS_NO_ANSWER = /i don['’]t have that on file\\b/i;"],
  ['the curly apostrophe is not recognised', "const SAYS_NO_ANSWER = /^\\s*i don['’]t have that on file\\b/i;", "const SAYS_NO_ANSWER = /^\\s*i don't have that on file\\b/i;"],
  ['leading space is not tolerated', "const SAYS_NO_ANSWER = /^\\s*i don['’]t have that on file\\b/i;", "const SAYS_NO_ANSWER = /^i don['’]t have that on file\\b/i;"],
  ['a failed model call returns the first fact again', '  } catch {\n    return LOOKUP_FAILED;', '  } catch {\n    return facts[0];'],
  ['an empty model answer returns the first fact again', 'if (typeof answer !== "string" || !answer.trim()) return LOOKUP_FAILED;', 'if (typeof answer !== "string" || !answer.trim()) return facts[0];'],
  ['a normal answer is no longer trimmed', ': answer.trim();', ': answer;'],
  ['the safe sentence carries a figure', 'export const LOOKUP_FAILED = "I couldn\'t look that up just now.', 'export const LOOKUP_FAILED = "I couldn\'t look that up just now (R0).'],
  ['the empty bundle answer changes', "return \"I don't have anything on file for that yet.\";", "return \"Nothing.\";"],
];
(async () => {
  let missed = 0;
  const collect = () => { const list = []; return { list, check: (ok, label) => { if (!ok) list.push(label); } }; };
  const clearBuildCache = () => { for (const n of ['rm-poe', 'rm-auth']) delete require.cache[path.join(os.tmpdir(), `${n}-${process.pid}.js`)]; };
  fs.writeFileSync(file, original); clearBuildCache();
  { const c = collect(); await run({ check: c.check, srcDir: path.join(copy, 'src') }); console.log(`baseline (nothing broken): ${c.list.length} failing checks (must be 0)`); if (c.list.length) { console.log(c.list.join('\n')); process.exit(1); } }
  for (const [name, from, to] of MUTATIONS) {
    fs.writeFileSync(file, original);
    if (!original.includes(from)) { console.log(`NOT APPLIED  ${name}: the text to change was not found (update this script)`); missed++; continue; }
    fs.writeFileSync(file, original.replace(from, to)); clearBuildCache();
    const c = collect();
    try { await run({ check: c.check, srcDir: path.join(copy, 'src') }); } catch (e) { c.list.push('threw: ' + String(e.message).slice(0, 100)); }
    if (c.list.length === 0) { missed++; console.log(`NOT CAUGHT   ${name}`); } else console.log(`caught (${String(c.list.length).padStart(2)})  ${name}`);
  }
  fs.writeFileSync(file, original);
  console.log(missed === 0 ? `\nall ${MUTATIONS.length} lookup-hardening guards are held by a test that fails when the guard is removed` : `\n${missed} problem(s): see above`);
  process.exit(missed === 0 ? 0 : 1);
})();
