// Proof that the conversational-layer tests are not decorative. Each line breaks one guard in worker/src/converse.ts (or the two routes, or the failure text) and the test must then FAIL. The first one is the one that matters most:
// a model reply that could reach a write.
// Run: NODE_PATH=worker/node_modules node --no-warnings tools/converse-breakage.js
const fs = require('fs'), os = require('os'), path = require('path');
const root = path.join(__dirname, '..'), workerDir = path.join(root, 'worker');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cvb-')), copy = path.join(tmp, 'worker');
fs.cpSync(workerDir, copy, { recursive: true, filter: (src) => !src.split(path.sep).includes('node_modules') });
fs.symlinkSync(path.join(workerDir, 'node_modules'), path.join(copy, 'node_modules'));
fs.copyFileSync(path.join(root, 'FEATURES.md'), path.join(tmp, 'FEATURES.md'));   // the test reads FEATURES.md from beside worker/
const files = { conv: path.join(copy, 'src', 'converse.ts'), index: path.join(copy, 'src', 'index.ts'), reply: path.join(copy, 'src', 'intents', 'reply.ts') };
const originals = Object.fromEntries(Object.entries(files).map(([k, f]) => [k, fs.readFileSync(f, 'utf8')]));
const run = require('./converse.test.js');
const MUTATIONS = [
  // the model's words reach a write (the doctrine's one hard line)
  ['conv', 'a model reply is written to a held action', 'return shown(r.choices?.[0]?.message?.content);', 'await env.OFFICE_DB.prepare("INSERT INTO pending_actions (type, payload, source_transcript, status) VALUES (\'invoice\', ?, \'x\', \'pending\')").bind(String(r.choices?.[0]?.message?.content)).run();\n    return shown(r.choices?.[0]?.message?.content);'],
  ['conv', 'a writer is imported beside the history reader', 'import { readHistory } from "./history";', 'import { readHistory, recordInteraction } from "./history";'],
  ['conv', 'a second module is imported', 'import { withRetry } from "./ai";', 'import { withRetry } from "./ai";\nimport { logCapture } from "./memory";'],
  // when it may run
  ['conv', 'it runs without the CONVERSE switch', 'if (env.CONVERSE === "off") return null;', ''],
  ['conv', 'it runs when the message is not the failure text', 'if (p.message !== NO_INTENT_MESSAGE) return false;', ''],
  ['conv', 'it runs when the intent was not "other"', 'if (p.extraction?.intent !== "other") return false;', ''],
  ['conv', 'it runs when a customer was found', 'if (p.customer || p.character) return false;', ''],
  ['conv', 'it runs when an action was held', 'if (Array.isArray(p.pendingActionIds) && p.pendingActionIds.length > 0) return false;', ''],
  ['conv', 'it runs when a role was refused', 'if (Array.isArray(p.refusals) && p.refusals.length > 0) return false;', ''],
  // what may be shown
  ['conv', 'a figure in the model reply is shown', 'if (/\\d/.test(text) || CLAIMED.test(text)) return null;', 'if (CLAIMED.test(text)) return null;'],
  ['conv', 'a claim that something was recorded is shown', 'if (/\\d/.test(text) || CLAIMED.test(text)) return null;', 'if (/\\d/.test(text)) return null;'],
  ['conv', 'an empty reply is shown', 'if (text.length === 0 || text.length > MAX_REPLY_CHARS) return null;', 'if (text.length > MAX_REPLY_CHARS) return null;'],
  ['conv', 'a very long reply is shown', 'const MAX_REPLY_CHARS = 700;', 'const MAX_REPLY_CHARS = 70000;'],
  ['conv', 'a failure of the model is not caught', '  } catch {\n    return null;\n  }\n}\n', '  } finally {\n  }\n}\n'],
  // what the model is given
  ['conv', 'history is read for everyone, not only the caller', 'scope: "own"', 'scope: "all"'],
  ['conv', 'the model call is not retried', 'await withRetry(() => env.AI.run(', 'await Promise.resolve().then(() => env.AI.run('],
  ['conv', 'the model is given tools', 'temperature: 0.4, chat_template_kwargs', 'tools: [{ type: "function" }], temperature: 0.4, chat_template_kwargs'],
  ['conv', 'a capability that is only designed is offered', '  { feature: "Customers",', '  { feature: "Warranty Tracking", says: "track warranties on finished jobs" },\n  { feature: "Customers",'],
  ['conv', 'a capability is described to someone without the permission', '.filter((c) => !c.needs || capabilities.includes(c.needs))', '.filter(() => true)'],
  ['conv', 'the persona stops forbidding claims of having recorded anything', '"- Never say that anything was recorded, saved, created, sent, scheduled, updated, paid or confirmed. Nothing happens in this conversation.",', ''],
  ['conv', 'the persona stops forbidding figures', '"- Never state, give or invent a figure, number, amount, date or count, and never name', '"- Be vague about figures, and never name'],
  // the routes and the failure text
  ['index', 'the typed route replaces the whole reply, not only the words', 'if (talked !== null) processed = { ...processed, message: talked };', 'if (talked !== null) processed = { message: talked } as typeof processed;', 'index'],
  ['index', 'the voice route never asks for a conversation', 'const spoken = transcript ? await tryConverse(', 'const spoken = transcript ? null && await tryConverse(', 'index'],
  ['reply', 'the failure text is changed', 'message = NO_INTENT_MESSAGE;', 'message = "Sorry, nothing there.";', 'reply'],
];

(async () => {
  let missed = 0;
  const collect = () => { const list = []; return { list, check: (ok, label) => { if (!ok) list.push(label); } }; };
  const clearBuildCache = () => { for (const n of ['rm-poe', 'rm-auth']) delete require.cache[path.join(os.tmpdir(), `${n}-${process.pid}.js`)]; };   // the harness bundles the worker to a fixed file per process and Node caches it
  const reset = () => { for (const [k, f] of Object.entries(files)) fs.writeFileSync(f, originals[k]); };
  reset(); clearBuildCache(); { const c = collect(); await run({ check: c.check, srcDir: path.join(copy, 'src') }); console.log(`baseline (nothing broken): ${c.list.length} failing checks (must be 0)`); if (c.list.length) { console.log(c.list.join('\n')); process.exit(1); } }
  for (const [k, name, from, to] of MUTATIONS) {
    reset();
    if (!originals[k].includes(from)) { console.log(`NOT APPLIED  ${name}: the text to change was not found in ${k} (update this script)`); missed++; continue; }
    fs.writeFileSync(files[k], originals[k].replace(from, to));
    clearBuildCache();
    const c = collect();
    try { await run({ check: c.check, srcDir: path.join(copy, 'src') }); } catch (e) { c.list.push('threw: ' + String(e.message).slice(0, 100)); }
    if (c.list.length === 0) { missed++; console.log(`NOT CAUGHT   ${name}`); } else console.log(`caught (${String(c.list.length).padStart(2)})  ${name}`);
  }
  reset();
  console.log(missed === 0 ? `\nall ${MUTATIONS.length} conversational-layer guards are held by a test that fails when the guard is removed` : `\n${missed} problem(s): see above`);
  process.exit(missed === 0 ? 0 : 1);
})();
