// Proof that the Moonshot front door tests are not decorative: each line breaks one guard (in converse-moonshot.ts or the typed route) and tools/converse-moonshot.test.js must FAIL.
// Run: NODE_PATH=worker/node_modules node --no-warnings tools/converse-moonshot-breakage.js
const fs = require('fs'), os = require('os'), path = require('path');
const root = path.join(__dirname, '..'), workerDir = path.join(root, 'worker');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cmb-')), copy = path.join(tmp, 'worker');
fs.cpSync(workerDir, copy, { recursive: true, filter: (src) => !src.split(path.sep).includes('node_modules') });
fs.symlinkSync(path.join(workerDir, 'node_modules'), path.join(copy, 'node_modules'));
fs.copyFileSync(path.join(root, 'FEATURES.md'), path.join(tmp, 'FEATURES.md'));
const files = { moon: path.join(copy, 'src', 'converse-moonshot.ts'), index: path.join(copy, 'src', 'index.ts') };
const originals = Object.fromEntries(Object.entries(files).map(([k, f]) => [k, fs.readFileSync(f, 'utf8')]));
const run = require('./converse-moonshot.test.js');
const MUTATIONS = [
  ['moon', 'a per-request header works in production too', 'if (env.ENVIRONMENT === "staging" && header)', 'if (header)'],
  // production: off unless deliberately on, in the typed and the voice route
  ['moon', 'the key is no longer required', 'cfg === null || !env.MOONSHOT_API_KEY || ', 'cfg === null || '],
  ['moon', 'CONVERSE=off no longer switches the front door off', 'if (env.CONVERSE === "off") return { kind: "pass", trace: off };', ''],
  ['index', 'the voice route never uses the front door', 'spokenMoon !== null && (spokenMoon.kind === "reply" || spokenMoon.kind === "fallback") ? followUpReply(transcript, spokenMoon.message)', 'false ? followUpReply(transcript, "")'],
  // what crosses to Moonshot
  ['moon', 'the engine\'s earlier answer is sent back to Moonshot as an assistant turn', 'if (answeredHere) { turns.push({ role: "user", content: heard.trim().slice(0, TURN_CHARS) }); turns.push({ role: "assistant", content: replied.slice(0, TURN_CHARS) }); }\n      else handled.push(heard.trim().slice(0, TURN_CHARS));', 'turns.push({ role: "user", content: heard.trim().slice(0, TURN_CHARS) }); turns.push({ role: "assistant", content: replied.slice(0, TURN_CHARS) });'],
  ['moon', 'a placeholder stands in for the engine\'s answer again', 'else handled.push(heard.trim().slice(0, TURN_CHARS));', 'else { turns.push({ role: "user", content: heard.trim().slice(0, TURN_CHARS) }); turns.push({ role: "assistant", content: "(The Office answered that from the business records.)" }); }'],
  ['moon', 'the fixed sentence is fed back as an assistant turn', 'trace.outcome === "reply" && replied.length > 0;', 'replied.length > 0;'],
  ['moon', 'the person\'s business words are dropped (recall and intent lost)', 'const kept = handled.slice(-NOTE_ITEMS);', 'const kept: string[] = [];'],
  ['moon', 'the note stops saying the model did not answer these', 'you did not answer them and their answers are not shown to you', 'carry on'],
  ['moon', 'a failed request is not classed', 'return { ok: false, failure: { kind: "http", status: response.status }, ms: Date.now() - started };', 'return { ok: false, failure: { kind: "malformed" }, ms: Date.now() - started };'],
  ['moon', 'a timeout is called a network error', 'kind: e instanceof Error && e.name === "AbortError" ? "timeout" : "network"', 'kind: "network"'],
  ['index', 'a failure of the Moonshot request is not recorded', 'moonOut.kind !== "pass" || moonOut.trace.outcome === "error"', 'moonOut.kind !== "pass"'],
  ['moon', 'other members\' turns are sent', 'scope: "own"', 'scope: "all"'],
  ['moon', 'a talk reply is not marked, so the next turn cannot tell it from an engine answer', 'return { converse: "moonshot", moonshot: out.trace };', 'return { moonshot: out.trace };'],
  ['moon', 'work reaches the model', 'if (LOOKS_LIKE_WORK.test(text)) {', 'if (false) {'],
  ['moon', 'the persona stops forbidding figures', 'never state a figure, number, date or fact about the business, and', 'be careful with figures, and'],
  // what may be shown
  ['moon', 'a talk reply with a figure is shown', 'if (ungroundedFigures(words, [], text).length > 0) {', 'if (false) {'],
  ['moon', 'a talk reply claiming it recorded something is shown', 'if (CLAIMS_DONE.test(words)) { trace.outcome = "fallback"; trace.reason = "claim";', 'if (false) { trace.outcome = "fallback"; trace.reason = "claim";'],
  // failure and switches
  ['moon', 'a Moonshot failure ends the turn instead of passing the message on', 'if (!r.ok) { trace.outcome = "error"; trace.failure = r.failure; return { kind: "pass", trace }; }', 'if (!r.ok) { trace.outcome = "error"; trace.failure = r.failure; return { kind: "fallback", message: AGENT_FALLBACK, trace }; }'],
  ['moon', 'CONVERSE=off does not switch it off', 'if (env.CONVERSE === "off") return { kind: "pass", trace: off };', ''],
  ['moon', 'it runs without a key', 'if (cfg === null || !env.MOONSHOT_API_KEY || !who.email', 'if (cfg === null || !who.email'],
  // configuration and the request
  ['moon', 'a header is honoured in production', 'env.ENVIRONMENT === "staging" && header', 'header'],
  ['moon', 'any model name is accepted', 'if (!MOONSHOT_MODELS.includes(model)) return null;', ''],
  ['moon', 'the K2.7 Code models are told to switch thinking off', 'if (cfg.model === "kimi-k2.6" && cfg.thinking === "off") b.thinking', 'if (cfg.thinking === "off") b.thinking'],
  ['moon', 'the K3 series gets no effort', 'if (cfg.model.startsWith("kimi-k3")) b.reasoning_effort = cfg.effort;', ''],
  ['moon', 'the URL is changed', 'https://api.moonshot.ai/v1/chat/completions', 'https://api.moonshot.cn/v1/chat/completions'],
  // the route
  ['index', 'the typed route does not keep what was heard', 'if (viaMoon) captured = await logCapture(env, text, "text", null);', ''],
  ['index', 'the routing is not recorded', '{ interpreted: interpretedFor(moonOut, processed.extraction) }', '{}'],
  ['index', 'the front door runs before the follow-up check', 'const moonOut = followUp || readAnswer ? null : await tryMoonshot(', 'const moonOut = await tryMoonshot('],
];
(async () => {
  let missed = 0;
  const collect = () => { const list = []; return { list, check: (ok, label) => { if (!ok) list.push(label); } }; };
  const clearBuildCache = () => { for (const n of ['rm-poe', 'rm-auth']) delete require.cache[path.join(os.tmpdir(), `${n}-${process.pid}.js`)]; };
  const reset = () => { for (const [k, f] of Object.entries(files)) fs.writeFileSync(f, originals[k]); };
  reset(); clearBuildCache(); { const c = collect(); await run({ check: c.check, srcDir: path.join(copy, 'src') }); console.log(`baseline (nothing broken): ${c.list.length} failing checks (must be 0)`); if (c.list.length) { console.log(c.list.join('\n')); process.exit(1); } }
  for (const [k, name, from, to] of MUTATIONS) {
    reset();
    if (!originals[k].includes(from)) { console.log(`NOT APPLIED  ${name}: the text to change was not found in ${k} (update this script)`); missed++; continue; }
    fs.writeFileSync(files[k], originals[k].replace(from, to)); clearBuildCache();
    const c = collect();
    try { await run({ check: c.check, srcDir: path.join(copy, 'src') }); } catch (e) { c.list.push('threw: ' + String(e.message).slice(0, 100)); }
    if (c.list.length === 0) { missed++; console.log(`NOT CAUGHT   ${name}`); } else console.log(`caught (${String(c.list.length).padStart(2)})  ${name}`);
  }
  reset();
  console.log(missed === 0 ? `\nall ${MUTATIONS.length} Moonshot front-door guards are held by a test that fails when the guard is removed` : `\n${missed} problem(s): see above`);
  process.exit(missed === 0 ? 0 : 1);
})();
