// Proof that the conversation-first spike tests are not decorative: each line breaks one guard (in converse-agent.ts, the connector's read-tool accessors in mcp.ts, or the two routes) and tools/converse-agent.test.js must FAIL.
// Run: NODE_PATH=worker/node_modules node --no-warnings tools/converse-agent-breakage.js
const fs = require('fs'), os = require('os'), path = require('path');
const root = path.join(__dirname, '..'), workerDir = path.join(root, 'worker');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cab-')), copy = path.join(tmp, 'worker');
fs.cpSync(workerDir, copy, { recursive: true, filter: (src) => !src.split(path.sep).includes('node_modules') });
fs.symlinkSync(path.join(workerDir, 'node_modules'), path.join(copy, 'node_modules'));
fs.copyFileSync(path.join(root, 'FEATURES.md'), path.join(tmp, 'FEATURES.md'));
const files = { agent: path.join(copy, 'src', 'converse-agent.ts'), mcp: path.join(copy, 'src', 'mcp.ts'), index: path.join(copy, 'src', 'index.ts') };
const originals = Object.fromEntries(Object.entries(files).map(([k, f]) => [k, fs.readFileSync(f, 'utf8')]));
const run = require('./converse-agent.test.js');
const MUTATIONS = [
  // read only
  ['mcp', 'a writing tool is offered to the model', '.filter((t) => !t.needsWrite && permitted(t, who))', '.filter((t) => permitted(t, who))'],
  ['mcp', 'a role is offered tools it may not use', '.filter((t) => !t.needsWrite && permitted(t, who))', '.filter((t) => !t.needsWrite)'],
  ['mcp', 'a writing tool can be RUN through the front door', 'if (tool.needsWrite || !permitted(tool, who))', 'if (!permitted(tool, who))'],
  ['mcp', 'a tool the role may not use can be run', 'if (tool.needsWrite || !permitted(tool, who))', 'if (tool.needsWrite)'],
  ['agent', 'the member is given the write scope', 'scope: SCOPE_READ }', 'scope: "mcp:write" }'],
  // grounded and bounded
  ['agent', 'a figure that is in no tool result is shown', ' && groundedIn(words, results, text);', ';'],
  ['agent', 'a claim that something was recorded is shown', ' && !CLAIMED.test(words) &&', ' &&'],
  ['agent', 'a very long reply is shown', 'words.length <= MAX_REPLY_CHARS && ', ''],
  ['agent', 'the model may call tools without limit', 'const MAX_MODEL_CALLS = 4;', 'const MAX_MODEL_CALLS = 40;'],
  ['agent', 'the last model call still gets tools', '...(last ? {} : { tools: offered })', 'tools: offered'],
  ['agent', 'tool results go into the system prompt', '{ role: "tool", tool_call_id', '{ role: "system", tool_call_id'],
  ['agent', 'a figure the person did not say counts as said', 'figures(said)]', 'figures(said), ...figures(reply)]'],
  // hand-off and failure
  ['agent', 'a hand-off is ignored (the model tries to do the work itself)', 'if (calls.some((c) => c.function?.name === HANDOFF_TOOL)) {', 'if (false) {'],
  ['agent', 'a failure of the front door ends the turn instead of passing the message on', '  } catch {\n    trace.outcome = "error";\n    return { kind: "pass", trace };\n  }\n}', '  } catch {\n    trace.outcome = "error";\n    return { kind: "fallback", message: AGENT_FALLBACK, trace };\n  }\n}'],
  ['agent', 'work is left to the model to recognise', 'if (LOOKS_LIKE_WORK.test(text)) {', 'if (false) {'],
  ['agent', 'an instruction with a figure is no longer recognised as work', '/\\d|^\\s*', '/^\\s*'],
  // switches and who
  ['agent', 'CONVERSE=off does not switch it off', ' || env.CONVERSE === "off"', ''],
  ['agent', 'it is on without CONVERSE_MODE', 'env.CONVERSE_MODE !== "agent" || ', ''],
  ['agent', 'it runs with no signed-in member', 'if (!who.email || !who.role) return { kind: "pass", trace };', ''],
  ['agent', 'history is not the member\'s own', 'await lastTurns(env, who.email)', 'await lastTurns(env, null as unknown as string)'],
  // the persona
  ['agent', 'the persona stops forbidding calculation', 'Never calculate, add up, round, count or estimate. ', ''],
  ['agent', 'the persona stops handing work off', 'call ${HANDOFF_TOOL} and say nothing else', 'do it yourself'],
  ['agent', 'the persona lists capabilities the role lacks', '.filter((c) => !c.needs || capabilities.includes(c.needs))', '.filter(() => true)'],
  ['agent', 'the persona stops telling the model to call tools with default arguments', 'call it WITHOUT them first and read what comes back. ', ''],
  ['agent', 'the persona lets the model guess a customer id', 'Never guess an id.', ''],
  ['agent', 'a rejected reply is not explained', 'trace.reason = calls.length > 0', 'trace.reasonX = calls.length > 0'],
  // the routes
  ['index', 'the front door runs before the follow-up check', 'const agentOut = followUp ? null : await tryAgent(', 'const agentOut = await tryAgent('],
  ['index', 'the typed route does not keep what was heard', 'if (viaAgent) captured = await logCapture(env, text, "text", null);', ''],
  ['index', 'the typed route does not record how the front door handled it', '{ interpreted: { converse: "agent", ...agentOut.trace } }', '{}'],
  ['index', 'the voice route never asks the front door', 'agentSpoken !== null && agentSpoken.kind !== "pass" ? followUpReply(transcript, agentSpoken.message)', 'false ? followUpReply(transcript, "")'],
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
  console.log(missed === 0 ? `\nall ${MUTATIONS.length} front-door guards are held by a test that fails when the guard is removed` : `\n${missed} problem(s): see above`);
  process.exit(missed === 0 ? 0 : 1);
})();
