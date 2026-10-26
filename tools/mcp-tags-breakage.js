// Proof that the exact-tagging tests are not decorative (the undo acts on what is tagged, so a wrong tag is a wrong record changed). For each guard in worker/src/mcp-tags.ts it takes a COPY of the worker source, REMOVES that one guard, runs tools/mcp-tags.test.js against the copy and requires at least one check to FAIL.
// Run: NODE_PATH=worker/node_modules node --no-warnings tools/mcp-tags-breakage.js
const fs = require('fs'), os = require('os'), path = require('path');
const root = path.join(__dirname, '..'), workerDir = path.join(root, 'worker');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mtb-')), copy = path.join(tmp, 'worker');
fs.cpSync(workerDir, copy, { recursive: true, filter: (src) => !src.split(path.sep).includes('node_modules') });
const target = path.join(copy, 'src', 'mcp-tags.ts'), original = fs.readFileSync(target, 'utf8');
const run = require('./mcp-tags.test.js');
const MUTATIONS = [
  ['payments are not tracked', 'INTO\\s+"?(invoices|quotations|expenses|tasks|job_scopes|payments)"?', 'INTO\\s+"?(invoices|quotations|expenses|tasks|job_scopes)"?'],
  ['a table whose name only STARTS like a tracked one is tracked', '"?\\s*[\\s(]/i;', '/i;'],
  ['every statement is reported, tracked table or not', 'if (table !== null && (prop === "run"', 'if ((prop === "run"'],
  ['a bound statement is no longer watched', 'wrapStatement(target.bind(...values), table, sink, returning)', 'target.bind(...values)'],
  ['an insert that wrote nothing is reported anyway (its stale last row id)', 'if ((result as { meta?: { changes?: number } })?.meta?.changes === 0) return result; ', ''],
  ['an ignored insert with RETURNING is counted as untraced', 'if (!returning) sink.untraced(); return result;', 'sink.untraced(); return result;'],
  ['an unlearnable id is silently dropped instead of counted', 'if (id === null) sink.untraced(); else sink.record(table, id);', 'if (id !== null) sink.record(table, id);'],
  ['a non-RETURNING insert read with first() is assumed to be nothing', 'if (!returning) sink.untraced(); return result;', 'return result;'],
  ['the real environment is changed instead of copied', 'return { ...env, OFFICE_DB: wrapped } as Env;', 'env.OFFICE_DB = wrapped; return env;'],
  ['a failing insert is reported as if it worked', 'const result = await target[prop](...args);', 'try { sink.record(table, 1); } catch { /* x */ } const result = await target[prop](...args);'],
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
  console.log(missed === 0 ? `\nall ${MUTATIONS.length} tagging guards are held by a test that fails when the guard is removed` : `\n${missed} problem(s): see above`);
  process.exit(missed === 0 ? 0 : 1);
})();
