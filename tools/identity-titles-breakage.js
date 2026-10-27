// Proof that the title matching tests are not decorative (a wrong match puts a record under the wrong person). For each guard in worker/src/identity.ts it takes a COPY of the worker source, REMOVES that one guard, runs tools/mcp-changes.test.js against the copy and requires at least one check to FAIL.
// Run: NODE_PATH=worker/node_modules node --no-warnings tools/identity-titles-breakage.js
const fs = require('fs'), os = require('os'), path = require('path');
const root = path.join(__dirname, '..'), workerDir = path.join(root, 'worker');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'itb-')), copy = path.join(tmp, 'worker');
fs.cpSync(workerDir, copy, { recursive: true, filter: (src) => !src.split(path.sep).includes('node_modules') });
fs.symlinkSync(path.join(workerDir, 'node_modules'), path.join(copy, 'node_modules'));   // the real packages, read only: the copy needs them to build
const target = path.join(copy, 'src', 'identity.ts'), original = fs.readFileSync(target, 'utf8');
const run = require('./identity-titles.test.js');
const MUTATIONS = [
  ['a title is matched as if it were the name (the live bug)', 'const { title, core } = nameCore(spokenName);', 'const title = null as string | null; const core = spokenName.trim().split(/\\s+/);'],
  ['the sound-alike pass compares the first word, titles included', 'soundex(nameCore(p.name).core[0]) === targetCode', 'soundex(p.name.trim().split(/\\s+/)[0]) === targetCode'],
  ['a titled name is auto-matched on its surname alone', 'if (firstToken.length < 8 || title !== null) {', 'if (firstToken.length < 8) {'],
  ['"Mrs" is not recognised as a title', 'new Set(["mr", "mrs", "ms",', 'new Set(["mr", "ms",'],
  ['"Dr" is not recognised as a title', '"miss", "mister", "mnr", "mev", "dr",', '"miss", "mister", "mnr", "mev",'],
  ['"Prof" is not recognised as a title', '"dr", "prof", "sir"', '"dr", "sir"'],
  ['a title in capitals is not recognised', 'TITLES.has(tokens[i].replace(/\\.$/, "").toLowerCase())', 'TITLES.has(tokens[i].replace(/\\.$/, ""))'],
  ['a title with a full stop is not recognised', 'TITLES.has(tokens[i].replace(/\\.$/, "").toLowerCase())', 'TITLES.has(tokens[i].toLowerCase())'],
  ['a lone title is taken off, leaving nothing', 'while (i < tokens.length - 1 && TITLES.has', 'while (i < tokens.length && TITLES.has'],
  ['only one title is taken off', 'while (i < tokens.length - 1 && TITLES.has(tokens[i].replace(/\\.$/, "").toLowerCase())) i++;', 'if (i < tokens.length - 1 && TITLES.has(tokens[i].replace(/\\.$/, "").toLowerCase())) i++;'],
  ['any word that starts like a title is taken off', 'TITLES.has(tokens[i].replace(/\\.$/, "").toLowerCase())', '[...TITLES].some((t) => tokens[i].toLowerCase().startsWith(t))'],
  ['an exact full-name match is no longer tried first', 'if (exact.results.length === 1) {\n    return { status: "matched", id: exact.results[0].id, name: exact.results[0].name };\n  }\n  if (exact.results.length > 1) {\n    return { status: "ambiguous", candidates: exact.results };\n  }\n\n  const onlySuppliers', 'const onlySuppliers'],
];
(async () => {
  let missed = 0;
  const collect = () => { const list = []; return { list, check: (ok, label) => { if (!ok) list.push(label); } }; };
  { fs.writeFileSync(target, original); const c = collect(); await run({ check: c.check, srcDir: path.join(copy, 'src') }); console.log(`baseline (nothing removed): ${c.list.length} failing checks (must be 0)`); if (c.list.length) { missed++; console.log(c.list.join('\n')); } }
  for (const [name, from, to] of MUTATIONS) {
    fs.writeFileSync(target, original);
    if (!original.includes(from)) { console.log(`NOT APPLIED  ${name}: the text to remove was not found in the source (update this script)`); missed++; continue; }
    fs.writeFileSync(target, original.replace(from, to));
    const c = collect();
    try { await run({ check: c.check, srcDir: path.join(copy, 'src') }); } catch (e) { c.list.push('threw: ' + String(e.message).slice(0, 100)); }
    if (c.list.length === 0) { missed++; console.log(`NOT CAUGHT   ${name}`); } else console.log(`caught (${String(c.list.length).padStart(2)})  ${name}`);
  }
  fs.writeFileSync(target, original);
  console.log(missed === 0 ? `\nall ${MUTATIONS.length} title matching guards are held by a test that fails when the guard is removed` : `\n${missed} problem(s): see above`);
  process.exit(missed === 0 ? 0 : 1);
})();
