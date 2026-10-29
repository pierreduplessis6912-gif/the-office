// Proof that the name guard tests are not decorative: each line breaks one guard and tools/name-guard.test.js must then FAIL.
// Run: NODE_PATH=worker/node_modules node --no-warnings tools/name-guard-breakage.js
const fs = require('fs'), os = require('os'), path = require('path');
const root = path.join(__dirname, '..'), workerDir = path.join(root, 'worker');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ngb-')), copy = path.join(tmp, 'worker');
fs.cpSync(workerDir, copy, { recursive: true, filter: (src) => !src.split(path.sep).includes('node_modules') });
fs.symlinkSync(path.join(workerDir, 'node_modules'), path.join(copy, 'node_modules'));
const F = { id: path.join(copy, 'src', 'identity.ts'), op: path.join(copy, 'src', 'intents', 'opening.ts'), ix: path.join(copy, 'src', 'index.ts'), au: path.join(copy, 'src', 'auth.ts') };
const O = Object.fromEntries(Object.entries(F).map(([k, f]) => [k, fs.readFileSync(f, 'utf8')]));
const srcDir = path.join(copy, 'src'), run = require('./name-guard.test.js');
const M = [
  ['op', 'the guard never asks', '!alreadyKnownCustomer && env.NAME_GUARD !== "off"', 'false'],
  ['op', 'the kill switch does nothing', 'env.NAME_GUARD !== "off"', 'true'],
  ['id', 'the same name in another case or spacing is asked about', '  if ((rows ?? []).some((r) => plain(r.name) === plain(spokenName))) return [];\n', ''],
  ['id', 'a single name matches inside other words', '${wholeWordClause("name")} AND merged_into_customer_id IS NULL ORDER BY id LIMIT 5`).bind(...wholeWordBindings(words[0]))', 'name LIKE ? AND merged_into_customer_id IS NULL ORDER BY id LIMIT 5`).bind(`%${words[0]}%`)'],
  ['op', 'the question does not offer the third way out', 'or did I hear the name wrong? (action #${held.id})`\n              : `"${extraction.customer_name}" could be', 'or is it? (action #${held.id})`\n              : `"${extraction.customer_name}" could be'],
  ['op', 'the candidates are not marked as customers', 'candidates: near, candidateKind: "customer", extraction', 'candidates: near, extraction'],
  ['ix', 'the same one is re-matched by name, not by id', 'payload.captureId, sameCapabilities, sameEmail, picked.id);', 'payload.captureId, sameCapabilities, sameEmail, null);'],
  ['ix', 'several candidates are resolved by taking the first', ': payload.candidates.length === 1 ? payload.candidates[0] : undefined;', ': payload.candidates[0];'],
  ['ix', 'a choice that is not a candidate is accepted', 'payload.candidates.find((c) => c.id === body.personId) :', 'payload.candidates.find((c) => c.id === body.personId) || payload.candidates[0] :'],
  ['ix', 'a correction that names an existing customer is re-matched by name', 'fixEmail, named ? named.id : null);', 'fixEmail, null);'],
  ['ix', 'a correction accepts anything as a name', "|| !/^[\\p{L}][\\p{L}\\p{N} .'’&-]*$/u.test(name))) {", '|| false)) {'],
  ['ix', 'a payment can be "corrected"', 'if (action.type !== "ambiguous_person" || !payload || payload.candidateKind !== "customer") return', 'if (false) return'],
  ['ix', 'an answered question can be answered again', '        await env.OFFICE_DB.prepare("UPDATE pending_actions SET status = \'rejected\', resolved_at = datetime(\'now\') WHERE id = ?").bind(id).run();\n        if (discard || name === null) {', '        if (discard || name === null) {'],
  ['ix', 'forget it does not say what was not recorded', 'return Response.json({ status: "discarded", id, message: shown ? `Okay, nothing was recorded. I', 'return Response.json({ status: "discarded", id, message: shown ? `Okay. I'],
  ['au', 'the correct route is not authorized like confirm and reject', '(confirm|reject|correct|edit-field)', '(confirm|reject|edit-field)'],
];
(async () => {
  let missed = 0;
  const reset = () => { for (const [k, f] of Object.entries(F)) fs.writeFileSync(f, O[k]); };
  const clear = () => { for (const n of ['rm-poe', 'rm-auth']) delete require.cache[path.join(os.tmpdir(), `${n}-${process.pid}.js`)]; };
  const exec = async () => { const fails = []; await run({ check: (ok, l) => { if (!ok) fails.push(l); }, srcDir }); return fails; };
  reset(); clear(); { const a = await exec(); console.log(`baseline (nothing broken): ${a.length} failing checks (must be 0)`); if (a.length) { console.log(a.join('\n')); process.exit(1); } }
  for (const [k, name, from, to] of M) {
    reset();
    if (!O[k].includes(from)) { console.log(`NOT APPLIED  ${name}: text not found in ${k} (update this script)`); missed++; continue; }
    fs.writeFileSync(F[k], O[k].replace(from, to)); clear();
    let fails; try { fails = await exec(); } catch (e) { fails = ['threw: ' + String(e.message).slice(0, 80)]; }
    if (fails.length === 0) { missed++; console.log(`NOT CAUGHT   ${name}`); } else console.log(`caught (${String(fails.length).padStart(2)})  ${name}`);
  }
  reset();
  console.log(missed === 0 ? `\nall ${M.length} name guard guards are held by a test that fails when the guard is removed` : `\n${missed} problem(s): see above`);
  process.exit(missed === 0 ? 0 : 1);
})();
