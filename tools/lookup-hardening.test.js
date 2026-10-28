// Lookup hardening (worker/src/ai.ts answerFromMemory), tested ALONE, before the conversation routing that comes after it. Two targeted changes to the lookup's no-answer and failure paths, nothing else:
//  - when the model says it has nothing on file, only that one sentence is returned: the unrelated facts it went on to list are not (found 2026-10-28: "I don't have that on file. The facts provided are about a confirmed invoice (R1500 ...)")
//  - when the model call fails or comes back empty, a fixed safe sentence is returned: NOT the first fact of the bundle (which was an arbitrary business fact)
// A normal answer is returned exactly as before (trimmed), and so is the empty-bundle answer.
const path = require('path'), fs = require('fs'), os = require('os'), esbuild = require('esbuild');

module.exports = async function runLookupHardeningTests({ check, srcDir }) {
  const bundle = (entry) => { const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lh-')), 'm.js'); esbuild.buildSync({ entryPoints: [path.join(srcDir, entry)], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent' }); return require(out); };
  let ai; try { ai = bundle('ai.ts'); } catch (e) { check(false, 'ai.ts builds: ' + String(e.message).split('\n')[0].slice(0, 160)); return; }
  const NO = ai.LOOKUP_NO_ANSWER, FAILED = ai.LOOKUP_FAILED;
  check(NO === "I don't have that on file." && typeof FAILED === 'string' && FAILED.length > 10 && !/\d/.test(FAILED), 'the two fixed sentences exist, and the failure one holds no figure');
  const env = (reply) => ({ AI: { run: async () => { if (reply instanceof Error) throw reply; return { choices: [{ message: { content: reply } }] }; } } });
  const ask = (reply, facts = ['ZEBRA-INVOICE: invoice confirmed for Staging Customer One (R1500).', 'Another fact.']) => ai.answerFromMemory(env(reply), 'what is going on?', facts);

  // a normal answer is exactly as before
  check(await ask('Jenny owes R1,200 across two invoices.') === 'Jenny owes R1,200 across two invoices.', 'a normal answer is returned as it was');
  check(await ask('  Jenny owes R1,200.\n  ') === 'Jenny owes R1,200.', 'and is trimmed as it was');
  check(await ask('- Jenny: R1,200 outstanding\n- Sipho: R300 outstanding') === '- Jenny: R1,200 outstanding\n- Sipho: R300 outstanding', 'a list answer is returned whole');
  check(await ask('That is restricted for your role.', ['Outstanding balances exist for this business but are restricted for your role.']) === 'That is restricted for your role.', 'a role-restricted answer is untouched');
  check(await ask('Jenny owes R500. I don\'t have that on file for Sipho.') === 'Jenny owes R500. I don\'t have that on file for Sipho.', 'an answer that only MENTIONS something missing, after a real answer, is not cut (targeted: only a reply that opens with the no-answer sentence is trimmed)');
  check(await ai.answerFromMemory(env('never used'), 'q', []) === "I don't have anything on file for that yet.", 'an empty bundle gives the same sentence as before');

  // the model says it has nothing on file: only that
  const longer = ["I don't have that on file.", "I don't have that on file. The facts provided are about a confirmed invoice (R1500 for Staging Customer One) and some dated messages, but none of them address what you asked.", "i don't have that on file, but ZEBRA-INVOICE is confirmed.", "I don’t have that on file.\n\nHere is what I do have: R1500.", "  I don't have that on file"];
  const trimmed = []; for (const reply of longer) trimmed.push(await ask(reply));
  check(trimmed.every((t) => t === NO), 'a reply that opens with "I don\'t have that on file" returns exactly that sentence, whatever followed it: ' + trimmed.filter((t) => t !== NO).map((t) => JSON.stringify(t.slice(0, 50))).join(' '));
  check(trimmed.every((t) => !/ZEBRA|R1500|Staging Customer/.test(t)), 'and none of the facts is in what comes back');

  // the model fails or says nothing: the safe sentence, never a fact
  const failures = [new Error('model down'), '', '   \n', undefined, null, 42, { text: 'x' }];
  const failed = []; for (const reply of failures) failed.push(await ask(reply));
  check(failed.every((t) => t === FAILED), 'a failed or empty model answer returns the fixed safe sentence: ' + failed.filter((t) => t !== FAILED).map((t) => JSON.stringify(String(t).slice(0, 50))).join(' '));
  check(failed.every((t) => !/ZEBRA|R1500|Staging Customer|Another fact/.test(t)), 'and never the first fact of the bundle (or any fact)');
  const body = fs.readFileSync(path.join(srcDir, 'ai.ts'), 'utf8'); const fn = body.slice(body.indexOf('export async function answerFromMemory'), body.indexOf('export function arrayBufferToBase64'));
  check(!/\bfacts\[0\]/.test(fn), 'answerFromMemory no longer returns facts[0] anywhere');

  // through the real route: a lookup that fails or has no answer
  const harness = require('./harness.js'), workerDir = path.join(srcDir, '..'), fns = await harness.loadFunctions(workerDir);
  const userOf = (input) => input.messages.find((m) => m.role === 'user').content;
  const SPLIT = { match: /Find genuinely SEPARATE topics and split/, reply: (input) => [userOf(input)] };
  const READ = { match: /Extract structured facts from a tradesperson's message/, reply: { ...harness.EXTRACTION_DEFAULTS, intent: 'lookup', query_scope: 'personal' } };
  const seed = (db) => db.exec("INSERT INTO pending_actions (type, payload, source_transcript, status, resolved_at) VALUES ('invoice', '{\"customerName\":\"Staging Customer One\",\"amount\":1500}', 'x', 'confirmed', '2026-10-03 10:00:00')");
  const via = (answer) => harness.runRouteCase(fns, workerDir, { env: { BUSINESS_ID: 'acme-co' }, name: 'lookup', method: 'POST', path: '/messages/text', body: { text: 'what is up' }, role: 'owner', seed, ai: [SPLIT, READ, { match: /Answer the tradesperson's question using only the facts below/, reply: answer }] });
  { const r = await via(() => { throw new Error('model down'); }); check(r.threw === null && r.result.body.message === FAILED, 'a lookup whose answer model fails says the safe sentence (it used to print "invoice confirmed for Staging Customer One (R1500)"): ' + JSON.stringify(r.threw || r.result.body.message).slice(0, 80)); }
  { const r = await via("I don't have that on file. The facts provided are about a confirmed invoice (R1500)."); check(r.result.body.message === NO, 'a lookup answered "I don\'t have that on file. The facts provided are..." says only the first sentence'); }
  { const r = await via('You confirmed one invoice today, for R1500.'); check(r.result.body.message === 'You confirmed one invoice today, for R1500.', 'a real lookup answer comes through unchanged'); }
};
