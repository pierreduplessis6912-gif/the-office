// The Moonshot front door, SPIKE (worker/src/converse-moonshot.ts), staging only. A Kimi model called directly at Moonshot is the conversation layer; the Office's own pipeline stays behind it, inside Cloudflare. What this pins:
//  - the SURFACE POLICY, against the real request body sent to Moonshot: the persona, the person's own words, what the conversation layer itself said, and the message just typed; an answer the ENGINE gave is replaced by a placeholder;
//    no business fact, no record, no other member's turns, no key in the body. Policy B additionally sends the engine's answer for the current turn so it can be narrated, and only then
//  - one decision per message (talk, or hand to the engine); work is decided in code and never reaches the model; a model failure leaves the message to the pipeline, identical to the switch being off
//  - a talk reply holding a figure the person did not say is a business question and goes to the engine; one claiming something was done gets the fixed sentence
//  - Policy B: a narration is shown only if its figures are the engine's own and it claims nothing; otherwise the engine's words are shown unchanged
//  - configuration: a Worker secret sets it; a per-request header may set it ONLY where ENVIRONMENT is "staging"; models and values outside the allowed ones are ignored
//  - the model parameters per Kimi model, the one URL, the key only in the Authorization header
// Moonshot is SCRIPTED here (a stubbed fetch): this proves the plumbing and the guards, not how well each Kimi model routes or narrates, which is what the staging matrix measures.
const path = require('path'), fs = require('fs'), os = require('os'), esbuild = require('esbuild');

module.exports = async function runConverseMoonshotTests({ check, srcDir }) {
  const workerDir = path.join(srcDir, '..');
  const bundle = (entry) => { const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cm-')), 'm.js'); esbuild.buildSync({ entryPoints: [path.join(srcDir, entry)], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent' }); return require(out); };
  let mo, ag;
  try { mo = bundle('converse-moonshot.ts'); ag = bundle('converse-agent.ts'); } catch (e) { check(false, 'converse-moonshot.ts builds: ' + String(e.message).split('\n')[0].slice(0, 160)); return; }
  const harness = require('./harness.js'), fns = await harness.loadFunctions(workerDir);
  const ROLE = fns.auth.ROLE_CAPABILITIES, KEY = 'sk-TESTKEY-KEYMARK-0001', FALLBACK = ag.AGENT_FALLBACK;
  const userOf = (input) => input.messages.filter((m) => m.role === 'user').pop().content;
  const SPLIT = { match: /Find genuinely SEPARATE topics and split/, reply: (input) => [userOf(input)] };
  const READ_PAYMENT = { match: /Extract structured facts from a tradesperson's message/, reply: { ...harness.EXTRACTION_DEFAULTS, intent: 'payment', customer_name: 'Jenny Smith', amount: 500 } };
  const READ_LOOKUP = { match: /Extract structured facts from a tradesperson's message/, reply: { ...harness.EXTRACTION_DEFAULTS, intent: 'lookup', query_scope: 'personal' } };
  const ANSWER = (text) => ({ match: /Answer the tradesperson's question using only the facts below/, reply: text });
  const seed = (db) => db.exec("INSERT INTO customers (name) VALUES ('Jenny Smith'); INSERT INTO pending_actions (type, payload, source_transcript, status, resolved_at) VALUES ('invoice', '{\"customerName\":\"ZEBRA-INVOICE-CUSTOMER\",\"amount\":1500}', 'x', 'confirmed', '2026-10-03 10:00:00')");
  const ENVS = { BUSINESS_ID: 'acme-co', ENVIRONMENT: 'staging', CONVERSE_MODE: 'moonshot', MOONSHOT_API_KEY: KEY };

  // a scripted Moonshot: handler(body, n) returns { content, tool_calls } or throws / returns a Response
  const reply = (m) => new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: m.content === undefined ? null : m.content, ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}) } }], usage: { prompt_tokens: 100, completion_tokens: 20 } }), { status: 200 });
  const ENGINE_CALL = [{ id: 't1', type: 'function', function: { name: mo.ENGINE_TOOL, arguments: '{}' } }];
  const run = async (handler, fn) => { const real = globalThis.fetch, calls = []; globalThis.fetch = async (url, init) => { if (String(url).startsWith('https://api.moonshot.ai/')) { const body = JSON.parse(init.body); calls.push({ url: String(url), body, headers: init.headers }); const out = await handler(body, calls.length); return out instanceof Response ? out : reply(out); } return real(url, init); }; try { return await fn(calls); } finally { globalThis.fetch = real; } };
  const route = (spec) => harness.runRouteCase(fns, workerDir, { env: ENVS, ...spec });
  const say = (text, ai, extra = {}) => route({ name: text.slice(0, 40), method: 'POST', path: '/messages/text', body: { text }, role: 'owner', seed, ai, ...extra });
  const logOnly = (r) => Object.keys(r.writes).every((t) => ['captures', 'interaction_log'].includes(t));
  const cfgHeader = (o) => ({ headers: { 'X-Converse-Config': JSON.stringify(o) } });

  // ---- configuration ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  { const E = (o) => ({ ...o }), c = mo.moonConfig;
    const a = c(E({ CONVERSE_MODE: 'moonshot' }), null);
    check(a && a.model === 'kimi-k2.6' && a.thinking === 'off' && a.policy === 'A' && a.effort === 'low', 'a Worker secret CONVERSE_MODE=moonshot turns it on with the defaults: kimi-k2.6, thinking off, Policy A, low effort');
    check(c(E({ ENVIRONMENT: 'production', CONVERSE_MODE: 'moonshot' }), JSON.stringify({ mode: 'moonshot', model: 'kimi-k3', policy: 'B' })).model === 'kimi-k2.6' && c(E({ ENVIRONMENT: 'production' }), JSON.stringify({ mode: 'moonshot' })) === null && c(E({}), JSON.stringify({ mode: 'moonshot' })) === null, 'a per-request header is IGNORED unless ENVIRONMENT is "staging": it cannot switch the front door on, or change its model, anywhere else');
    const s = c(E({ ENVIRONMENT: 'staging' }), JSON.stringify({ mode: 'moonshot', model: 'kimi-k2.7-code-highspeed', thinking: 'on', policy: 'B', effort: 'high' }));
    check(s && s.model === 'kimi-k2.7-code-highspeed' && s.thinking === 'on' && s.policy === 'B' && s.effort === 'high', 'on staging the header sets model, thinking, policy and effort');
    check(c(E({ ENVIRONMENT: 'staging' }), JSON.stringify({ mode: 'moonshot', model: 'gpt-5' })) === null && c(E({ ENVIRONMENT: 'staging' }), JSON.stringify({ mode: 'moonshot', model: '../../x' })) === null && c(E({ ENVIRONMENT: 'staging' }), 'not json') === null && c(E({ ENVIRONMENT: 'staging', CONVERSE_MODE: 'moonshot' }), '[1,2]').model === 'kimi-k2.6', 'a model outside the six Kimi models, junk, or a malformed header is ignored');
    check(c(E({ ENVIRONMENT: 'staging', CONVERSE_MODE: 'moonshot' }), JSON.stringify({ policy: 'Z', thinking: 'maybe', effort: 'ultra' })).policy === 'A' && c(E({ ENVIRONMENT: 'staging', CONVERSE_MODE: 'moonshot' }), JSON.stringify({ policy: 'Z', thinking: 'maybe', effort: 'ultra' })).thinking === 'off', 'values that are not allowed fall back to the safe defaults'); }

  // ---- the request to Moonshot: the URL, the key, the parameters per model ---------------------------------------------------------------------------------------------------------
  const hdr = (h) => h.Authorization || h.authorization;
  for (const [model, thinking, expect] of [['kimi-k2.6', 'off', (b) => b.thinking && b.thinking.type === 'disabled' && b.reasoning_effort === undefined], ['kimi-k2.6', 'on', (b) => b.thinking === undefined && b.reasoning_effort === undefined], ['kimi-k2.7-code', 'off', (b) => b.thinking === undefined], ['kimi-k2.7-code-highspeed', 'on', (b) => b.thinking === undefined], ['kimi-k3', 'off', (b) => b.thinking === undefined && b.reasoning_effort === 'low'], ['kimi-k3.1-pro-highspeed', 'on', (b) => b.thinking === undefined && b.reasoning_effort === 'low']]) {
    await run(() => ({ content: 'Hello there.' }), async (calls) => {
      const r = await say('Hello Office', [], { ...cfgHeader({ mode: 'moonshot', model, thinking, policy: 'A' }) });
      const c = calls[0] || {};
      check(r.threw === null && calls.length === 1 && c.url === 'https://api.moonshot.ai/v1/chat/completions' && c.body.model === model && expect(c.body) && hdr(c.headers) === 'Bearer ' + KEY && !JSON.stringify(c.body).includes(KEY), `${model} (thinking ${thinking}): one request to the one URL, the right parameters (thinking is only ever disabled on kimi-k2.6; the K3 series gets an effort), and the key only in the Authorization header, never in the body`);
    });
  }

  // ---- talk: answered by the conversation layer, the engine never starts -----------------------------------------------------------------------------------------------------------
  await run(() => ({ content: 'Good morning. All good here. What can I do for you?' }), async (calls) => {
    const r = await say('Good morning Office, how are you?', []);
    check(r.threw === null && r.result.body.message === 'Good morning. All good here. What can I do for you?' && calls.length === 1 && r.aiCalls.length === 0 && logOnly(r), 'a greeting is answered by the conversation layer with ONE Moonshot call and NO in-Worker model call (scripted: a second would throw), writing only the capture and the history line (' + (r.threw || Object.keys(r.writes).join(',')) + ')');
    check(r.result.body.experience && r.result.body.pendingActionId === null, 'the reply carries the envelope (version 1 reads `message`)');
    check(JSON.stringify(calls[0].body.tools).includes(mo.ENGINE_TOOL) && calls[0].body.tools.length === 1 && calls[0].body.tools[0].function.parameters.properties && Object.keys(calls[0].body.tools[0].function.parameters.properties).length === 0, 'the model has exactly one tool, with no arguments: hand the message to the engine (nothing for it to invent)');
    const sys = calls[0].body.messages[0].content;
    check(/Never state a figure|never state a figure/i.test(sys) && /never say that anything was recorded/i.test(sys) && !/R\s?\d/.test(sys) && !/ZEBRA/.test(JSON.stringify(calls[0].body)), 'the persona forbids figures and claims, holds no figure, and no business fact is in the request');
  });
  await run(() => ({ content: 'Hello.' }), async () => {
    const r = await route({ name: 'trace', method: 'GET', path: '/history?limit=1', role: 'owner', seed, ai: [], before: [{ method: 'POST', path: '/messages/text', body: { text: 'Hello Office' } }] });
    const it = (r.result.body.items || [])[0] || {}, interp = (it.generated || {}).interpreted || {};
    check(it.recorded && it.recorded.heard === 'Hello Office' && (it.generated || {}).replied === 'Hello.' && interp.converse === 'moonshot' && interp.moonshot && interp.moonshot.model === 'kimi-k2.6' && interp.moonshot.outcome === 'reply' && Array.isArray(interp.moonshot.model_ms) && interp.moonshot.tokens && interp.moonshot.tokens.in === 100, 'the history keeps what was heard, what was said, and the routing: model, outcome, milliseconds and tokens per call'); });

  // ---- a business question: handed to the engine, whose words the person gets ---------------------------------------------------------------------------------------------------------
  await run((b) => ({ tool_calls: ENGINE_CALL }), async (calls) => {
    const r = await say('What did we get done today?', [SPLIT, READ_LOOKUP, ANSWER('You confirmed one invoice today, for R1500.')]);
    check(r.threw === null && r.result.body.message === 'You confirmed one invoice today, for R1500.' && calls.length === 1, 'Policy A: a business question goes to the engine and the person gets the ENGINE\'s words verbatim, with no second Moonshot call (' + String(r.threw || r.result.body.message).slice(0, 70) + ')');
    check(!JSON.stringify(calls.map((c) => c.body)).includes('R1500') && !JSON.stringify(calls.map((c) => c.body)).includes('ZEBRA'), 'and nothing the engine knows (an invoice, a figure, a name) was in anything sent to Moonshot');
    const h = await route({ name: 'routed', method: 'GET', path: '/history?limit=1', role: 'owner', seed, ai: [SPLIT, READ_LOOKUP, ANSWER('You confirmed one invoice today, for R1500.')], before: [{ method: 'POST', path: '/messages/text', body: { text: 'What did we get done today?' } }] });
    const interp = ((((h.result.body.items || [])[0] || {}).generated || {}).interpreted) || {};
    check(interp.intent === 'lookup' && interp.moonshot && interp.moonshot.outcome === 'engine' && interp.moonshot.via === 'model' && interp.converse === undefined, 'the history keeps the engine\'s own interpretation with the routing alongside (routed by the model, not marked as a conversation reply)'); });

  // ---- Policy B: narration, checked ---------------------------------------------------------------------------------------------------------------------------------------------------------
  const policyB = cfgHeader({ mode: 'moonshot', policy: 'B' });
  const narr = (text) => (b, n) => n === 1 ? { tool_calls: ENGINE_CALL } : { content: text };
  for (const [label, narration, shown] of [['accepted when its figures are the engine\'s', 'Today you got one invoice confirmed, R1500 in all.', 'Today you got one invoice confirmed, R1500 in all.'], ['refused when it adds a figure', 'You confirmed R1500 today, up R200 on yesterday.', 'You confirmed one invoice today, for R1500.'], ['refused when it claims anything was done', 'I have recorded that invoice for R1500.', 'You confirmed one invoice today, for R1500.'], ['refused when it is empty', '  ', 'You confirmed one invoice today, for R1500.']]) {
    await run(narr(narration), async (calls) => {
      const r = await say('What did we get done today?', [SPLIT, READ_LOOKUP, ANSWER('You confirmed one invoice today, for R1500.')], { ...policyB });
      check(r.threw === null && r.result.body.message === shown && calls.length === 2 && JSON.stringify(calls[1].body).includes('R1500'), `Policy B narration ${label}: ${JSON.stringify(r.result.body.message).slice(0, 60)}`);
    });
  }
  await run((b, n) => n === 1 ? { tool_calls: ENGINE_CALL } : new Response('boom', { status: 500 }), async () => { const r = await say('What did we get done today?', [SPLIT, READ_LOOKUP, ANSWER('You confirmed one invoice today, for R1500.')], { ...policyB }); check(r.result.body.message === 'You confirmed one invoice today, for R1500.', 'Policy B: if the narration call fails, the engine\'s own words are shown'); });
  await run((b, n) => n === 1 ? { tool_calls: ENGINE_CALL } : { content: 'Narrated' }, async (calls) => { const r = await say('Jenny settled her account', [SPLIT, READ_PAYMENT], { ...policyB }); check(/Payment noted for Jenny Smith of R500 — needs your confirmation \(action #\d+\) before it's recorded\./.test(r.result.body.message) && Number.isInteger(r.result.body.pendingActionId) && calls.length === 1, 'Policy B never narrates over a held action: its words, its number and its confirmation wording come through exactly, and no narration call is made (' + String(r.result.body.message).slice(0, 70) + ')'); });

  // ---- work is decided in code, a failure passes the message on ------------------------------------------------------------------------------------------------------------------
  await run(() => ({ content: 'NEVER' }), async (calls) => {
    const work = await say('Jenny paid R500', [SPLIT, READ_PAYMENT]);
    const off = await say('Jenny paid R500', [SPLIT, READ_PAYMENT], { env: { BUSINESS_ID: 'acme-co' } });
    check(calls.length === 0 && /needs your confirmation/.test(work.result.body.message) && JSON.stringify(work.result.body) === JSON.stringify(off.result.body) && JSON.stringify({ ...work.writes, interaction_log: undefined }) === JSON.stringify({ ...off.writes, interaction_log: undefined }), 'an instruction never reaches Moonshot at all: it goes to the engine by code, held for confirmation, with the reply and every record identical to the front door being off (only the history line carries the routing note)'); });
  for (const [label, handler] of [['answers 500', () => new Response('boom', { status: 500 })], ['throws', () => { throw new Error('network down'); }], ['returns junk', () => new Response('<html>nope</html>', { status: 200 })], ['returns no choices', () => new Response(JSON.stringify({ choices: [] }), { status: 200 })]]) {
    await run(handler, async () => {
      const failing = await say('Jenny settled her account', [SPLIT, READ_PAYMENT]);
      const off = await say('Jenny settled her account', [SPLIT, READ_PAYMENT], { env: { BUSINESS_ID: 'acme-co' } });
      check(JSON.stringify(failing.result.body) === JSON.stringify(off.result.body) && JSON.stringify(failing.writes) === JSON.stringify(off.writes), `if Moonshot ${label}, the message goes to the pipeline and the result is identical to the front door being off`);
    });
  }

  // ---- what a talk reply may contain ----------------------------------------------------------------------------------------------------------------------------------------------------
  await run(() => ({ content: 'You owe R9,999 on three invoices.' }), async () => { const r = await say('hello', [SPLIT, READ_LOOKUP, ANSWER('You confirmed one invoice today, for R1500.')]); check(r.result.body.message === 'You confirmed one invoice today, for R1500.', 'a talk reply with a figure the person did not say is treated as a business question: the engine answers, the figure is never shown'); });
  await run(() => ({ content: 'Done, I have recorded that for you.' }), async () => { const r = await say('hello', []); check(r.result.body.message === FALLBACK && logOnly(r), 'a talk reply claiming something was done is replaced by the fixed sentence'); });
  await run(() => ({ content: 'x'.repeat(1500) }), async () => { const r = await say('hello', []); check(r.result.body.message === FALLBACK, 'a very long talk reply is replaced by the fixed sentence'); });
  await run(() => ({ content: 'NEVER' }), async (calls) => { const r = await say('I said 12', [SPLIT, READ_LOOKUP, ANSWER('You said 12.')]); check(calls.length === 0 && r.result.body.message === 'You said 12.', 'a message with a figure in it goes to the engine by code, so the model never sees it and no figure can be repeated by the model'); });

  // ---- the surface policy, against the real request body ------------------------------------------------------------------------------------------------------------------------------
  await run((b) => (/Jenny settled/.test(b.messages[b.messages.length - 1].content) ? { tool_calls: ENGINE_CALL } : { content: 'You asked me hello, then said Jenny settled her account.' }), async (calls) => {
    const before = [{ method: 'POST', path: '/messages/text', body: { text: 'Hello Office' } }, { method: 'POST', path: '/messages/text', body: { text: 'Jenny settled her account' } }];
    const r = await say('What did I just say?', [SPLIT, READ_PAYMENT], { before, ...cfgHeader({ mode: 'moonshot', policy: 'A' }) });
    const last = calls[calls.length - 1].body, sent = JSON.stringify(last), roles = last.messages.map((m) => m.role);
    check(/Hello Office/.test(sent) && /Jenny settled her account/.test(sent), 'the person\'s own earlier words are sent (so it can recall what was said)');
    check(!/Payment noted|needs your confirmation|Jenny Smith|R500/.test(sent) && sent.includes('The Office answered that from the business records'), 'but the ENGINE\'s earlier answer (a held payment with a name and an amount) is NOT: it is replaced by a placeholder');
    check(!/ZEBRA|R1500/.test(sent) && !sent.includes(KEY), 'no seeded business fact (a confirmed invoice) and no key is anywhere in the body');
    check(roles[0] === 'system' && roles[roles.length - 1] === 'user' && roles.every((x) => ['system', 'user', 'assistant'].includes(x)) && /Good morning|Hello/.test(sent) === true, 'the message order is system, then the turns, then the message just typed; no tool role, nothing else');
    check(r.threw === null && r.result.body.message === 'You asked me hello, then said Jenny settled her account.', 'and the recall is answered'); });
  await run((b) => ({ content: 'Hello again.' }), async (calls) => {
    const before = [{ method: 'POST', path: '/messages/text', role: 'owner', body: { text: 'OWNER-EARLIER-LINE about my day' } }, { method: 'POST', path: '/messages/text', role: 'accountant', body: { text: 'ZEBRA-SECRET about the books' } }];
    await say('Hello again', [], { before }); const a = JSON.stringify(calls[calls.length - 1].body);
    await say('Hello again', [], { before, role: 'accountant' }); const b = JSON.stringify(calls[calls.length - 1].body);
    check(/OWNER-EARLIER/.test(a) && !/ZEBRA/.test(a) && /ZEBRA-SECRET/.test(b) && !/OWNER-EARLIER/.test(b), 'only the member\'s own turns are sent, never another member\'s'); });

  // ---- switches and order ----------------------------------------------------------------------------------------------------------------------------------------------------------------------
  await run(() => ({ content: 'NEVER' }), async (calls) => {
    const off = await say('Hello Office', [SPLIT, { match: /Extract structured facts from a tradesperson's message/, reply: { ...harness.EXTRACTION_DEFAULTS, intent: 'other' } }, { match: /You are The Office, a calm/, reply: 'Phase one.' }], { env: { ...ENVS, CONVERSE: 'off' } });
    const nokey = await say('Hello Office', [SPLIT, { match: /Extract structured facts from a tradesperson's message/, reply: { ...harness.EXTRACTION_DEFAULTS, intent: 'other' } }, { match: /You are The Office, a calm/, reply: 'Phase one.' }], { env: { ...ENVS, MOONSHOT_API_KEY: undefined } });
    const prod = await say('Hello Office', [SPLIT, { match: /Extract structured facts from a tradesperson's message/, reply: { ...harness.EXTRACTION_DEFAULTS, intent: 'other' } }, { match: /You are The Office, a calm/, reply: 'Phase one.' }], { env: { BUSINESS_ID: 'acme-co', ENVIRONMENT: 'production', MOONSHOT_API_KEY: KEY }, ...cfgHeader({ mode: 'moonshot' }) });
    check(calls.length === 0 && off.result.body.message === "I didn't catch anything there I could act on." && nokey.result.body.message === 'Phase one.' && prod.result.body.message === 'Phase one.', 'CONVERSE=off (which switches the whole conversation layer off), a missing key, and production (a header cannot switch it on) each leave the front door off: Moonshot is never called'); });
  await run(() => ({ content: 'NEVER' }), async (calls) => {
    const ctx = { version: 1, room: 'analysis', report: 'profit_and_loss', period: { from: '2026-10-01', to: '2026-10-31' }, compare: { from: '2026-09-01', to: '2026-09-30' }, filters: {} };
    const r = await say('why did it drop', [], { body: { text: 'why did it drop', context: ctx } });
    check(r.threw === null && calls.length === 0, 'the existing follow-up check still runs FIRST: with an analysis open the front door is never asked'); });

  // ---- the source ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const src = fs.readFileSync(path.join(srcDir, 'converse-moonshot.ts'), 'utf8'), code = src.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  const imports = [...code.matchAll(/^\s*import\s+(?:type\s+)?(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s+"([^"]+)"/gm)].map((m) => m[1]).sort();
  check(JSON.stringify(imports) === JSON.stringify(['./converse', './converse-agent', './history', './types']), 'converse-moonshot.ts imports only the Phase 1 and front-door helpers, the history reader and types (' + imports.join(', ') + ')');
  check(!/\.(?:prepare|exec|batch)\(/.test(code) && !/\b(?:INSERT INTO|UPDATE \w+ SET|DELETE FROM|ALTER TABLE|CREATE TABLE|DROP TABLE)\b/i.test(code) && !/pending_actions|OFFICE_VAULT|CUSTOMER_NOTES|MEMORY|SHARED_DB|waitUntil|processTranscript|env\.AI\b/.test(code), 'it has no SQL, no held action, no file store, no in-Worker model call and never runs the pipeline itself');
  const hosts = [...code.matchAll(/https?:\/\/[^\s"'`)]+/g)].map((m) => m[0]);
  check(hosts.length === 1 && hosts[0] === 'https://api.moonshot.ai/v1/chat/completions' && (code.match(/\bfetch\(/g) || []).length === 1, 'the one URL is Moonshot\'s chat endpoint and there is one fetch');
  check((code.match(/MOONSHOT_API_KEY/g) || []).length === 3 && /Authorization: `Bearer \$\{env\.MOONSHOT_API_KEY\}`/.test(code), 'the key is read in exactly three places: the Authorization header and the two checks that it exists');
  const index = fs.readFileSync(path.join(srcDir, 'index.ts'), 'utf8');
  check((index.match(/tryMoonshot\(/g) || []).length === 1 && (index.match(/\bnarrate\(/g) || []).length === 1 && /import \{ interpretedFor, narrate, tryMoonshot \} from "\.\/converse-moonshot"/.test(index), 'the typed route calls it once (the voice route is not wired in this spike)');
};
