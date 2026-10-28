// The conversation-first front door, SPIKE (worker/src/converse-agent.ts), staging only: switched on only where CONVERSE_MODE is "agent", off everywhere else. CONVERSATIONAL_LAYER.md ("Direction change").
// The model gets the read tools the MCP connector has (same registry, same permission rule, read tools only) plus one hand-off tool that gives a real instruction to the EXISTING pipeline, unchanged. What this pins:
//  - nothing but reading: no creating, confirming or rejecting tool is ever offered, nobody is offered a tool their role may not use, and a tool the model calls that it was not offered is refused
//  - every figure in a reply must appear in a tool result (or in what the person said): an ungrounded or calculated figure, or a claim that something was recorded, is replaced by a fixed sentence
//  - at most three model calls per message; the last gets no tools
//  - a hand-off or any failure of the front door leaves the message to the existing pipeline: its reply and records are identical to the switch being off
//  - the model is never given a facts bundle: unrelated business facts can only reach it by a tool call it chooses, and a conversational prompt holds none
// The model is SCRIPTED here, so this proves the plumbing and the guards, not how well real Kimi chooses tools: that is what the staging evaluation measures.
const path = require('path'), fs = require('fs'), os = require('os'), esbuild = require('esbuild');

module.exports = async function runConverseAgentTests({ check, srcDir }) {
  const workerDir = path.join(srcDir, '..');
  const bundle = (entry) => { const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ca-')), 'm.js'); esbuild.buildSync({ entryPoints: [path.join(srcDir, entry)], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent' }); return require(out); };
  let ag, mcp;
  try { ag = bundle('converse-agent.ts'); mcp = bundle('mcp.ts'); } catch (e) { check(false, 'converse-agent.ts and mcp.ts build: ' + String(e.message).split('\n')[0].slice(0, 160)); return; }
  const harness = require('./harness.js'), fns = await harness.loadFunctions(workerDir);
  const ROLE = fns.auth.ROLE_CAPABILITIES;
  const FALLBACK = ag.AGENT_FALLBACK;
  const route = (spec) => harness.runRouteCase(fns, workerDir, { env: { BUSINESS_ID: 'acme-co', CONVERSE_MODE: 'agent' }, ...spec });
  const userOf = (input) => input.messages.filter((m) => m.role === 'user').pop().content;
  const SPLIT = { match: /Find genuinely SEPARATE topics and split/, reply: (input) => [userOf(input)] };
  const READ_PAYMENT = { match: /Extract structured facts from a tradesperson's message/, reply: { ...harness.EXTRACTION_DEFAULTS, intent: 'payment', customer_name: 'Jenny Smith', amount: 500 } };
  const AGENT = /the conversation front door/;
  // a scripted model: fn(input, turn) returns { content, tool_calls }; turn counts this scenario's calls to it
  const agent = (fn) => { let turn = 0; return { match: AGENT, raw: true, reply: (input) => { const m = fn(input, turn++); return { choices: [{ message: { role: 'assistant', content: m.content === undefined ? null : m.content, ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}) } }] }; } }; };
  const call = (name, args = {}, id = 'c1') => ({ id, type: 'function', function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } });
  const toolMsgs = (input) => input.messages.filter((m) => m.role === 'tool');
  const seed = (db) => db.exec("INSERT INTO customers (name) VALUES ('Jenny Smith'); INSERT INTO invoices (customer_id, description, amount, created_at) VALUES (1, 'Floor', 5000, '2026-10-01 08:00:00');");
  const say = (text, ai, extra = {}) => route({ name: text.slice(0, 40), method: 'POST', path: '/messages/text', body: { text }, role: 'owner', seed, ai, ...extra });
  const logOnly = (r) => Object.keys(r.writes).every((t) => ['captures', 'interaction_log'].includes(t));
  const inputsOf = (r) => r.aiInputs.map((s) => JSON.parse(s)).filter((i) => i.messages && /the conversation front door/.test((i.messages.find((m) => m.role === 'system') || {}).content || ''));
  const names = (input) => (input.tools || []).map((t) => t.function.name).sort();
  const WRITES = ['tell_the_office', 'schedule_job', 'edit_created_record', 'confirm_pending_action', 'reject_pending_action', 'get_upload_link', 'check_upload'];

  // ---- the tools: the connector's read tools, filtered the connector's way, never a writing one ------------------------------------------------------------------------------------------
  const whoOf = (role) => ({ keyId: 'in-app', email: role + '@example.com', role, capabilities: ROLE[role] || [], scope: 'mcp:read' });
  const owner = mcp.readToolsFor(whoOf('owner')).map((t) => t.name), installer = mcp.readToolsFor(whoOf('installer')).map((t) => t.name);
  check(owner.length >= 10 && WRITES.every((w) => !owner.includes(w)) && owner.includes('get_aged_debtors') && owner.includes('list_invoices'), 'the owner is offered the read tools (' + owner.length + ') and not one creating, confirming, rejecting or upload tool');
  check(installer.length < owner.length && !installer.includes('get_profit_and_loss') && WRITES.every((w) => !installer.includes(w)), 'an installer is offered fewer (' + installer.length + '): not the profit and loss, and the connector\'s permission rule decides, not this module');
  check(mcp.readToolsFor(whoOf('owner')).every((t) => typeof t.description === 'string' && t.inputSchema && t.inputSchema.type === 'object'), 'every offered tool carries its description and input schema');
  { const refused = await mcp.runReadTool({ OFFICE_DB: harness.d1(harness.newDatabase(workerDir)) }, 'tell_the_office', { text: 'invoice Jenny R5' }, whoOf('owner'), 'https://x.test'), unknown = await mcp.runReadTool({}, 'nope', {}, whoOf('owner'), 'https://x.test'), restricted = await mcp.runReadTool({ OFFICE_DB: harness.d1(harness.newDatabase(workerDir)) }, 'get_profit_and_loss', {}, whoOf('installer'), 'https://x.test');
    check(refused.ok === false && unknown.ok === false && restricted.ok === false && /not available|restricted|unknown/i.test(refused.text + unknown.text + restricted.text), 'running a writing tool, an unknown tool, or a tool the role may not use is refused with a plain sentence, whatever the model asks'); }

  // each layer on its own: even a caller holding the WRITE scope is offered no writing tool and cannot run one through this door
  { const w = { ...whoOf('owner'), scope: 'mcp:write' }, offeredToWriter = mcp.readToolsFor(w).map((t) => t.name);
    check(WRITES.every((x) => !offeredToWriter.includes(x)) && offeredToWriter.length === owner.length, 'layer 1: even with the write scope, no writing tool is offered through this door (the read filter holds by itself)');
    const db = harness.d1(harness.newDatabase(workerDir)); const ran = [];
    for (const name of ['tell_the_office', 'confirm_pending_action', 'reject_pending_action', 'schedule_job', 'edit_created_record', 'get_upload_link']) ran.push(await mcp.runReadTool({ OFFICE_DB: db }, name, { text: 'invoice Jenny R5', action_id: 1 }, w, 'https://x.test'));
    check(ran.every((x) => x.ok === false && /not available|restricted/i.test(x.text)), 'layer 2: even with the write scope, running any writing tool through this door is refused (the run filter holds by itself)'); }

  // ---- the figures check ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const g = ag.groundedIn;
  check(g('Jenny owes R5,000.', ['{"amount":5000}'], '') && g('That is R5000.00 in total.', ['{"outstanding":"5000.00"}'], '') && g('Due 2026-10-01.', ['{"due":"2026-10-01"}'], '') && g('No figures here.', [], ''), 'a figure that appears in a tool result (however it is formatted) is grounded, and a reply with no figure is');
  check(!g('Jenny owes R9,999.', ['{"amount":5000}'], '') && !g('R5,000 and R2,500.', ['{"amount":5000}'], '') && !g('You have 3 customers.', ['{"items":[1,2]}'], '') && !g('R50.', [], ''), 'a figure that is in no tool result, a figure calculated from them, a count, or any figure with no tool called is not');
  check(g('You said 12, so here it is.', [], 'I said 12'), 'a figure the person said themselves is fine to repeat');

  // ---- a greeting: talked to, no extraction, nothing written ---------------------------------------------------------------------------------------------------------------------------------
  { const r = await say('Good morning Office, how are you?', [agent(() => ({ content: 'Good morning. All good here. What can I do for you?' }))]);
    check(r.threw === null && r.result.body.message === 'Good morning. All good here. What can I do for you?' && r.aiCalls.length === 1 && logOnly(r), 'a greeting is answered by the front door with ONE model call: no split, no extraction (scripted, so a second call would throw), and only the capture and the history line are written (' + (r.threw || Object.keys(r.writes).join(',')) + ')');
    const first = inputsOf(r)[0];
    check(first && names(first).includes('hand_to_office') && names(first).includes('list_invoices') && WRITES.every((w) => !names(first).includes(w)), 'the model is offered the read tools and the hand-off, and no writing tool');
    check(r.result.body.experience && r.result.body.pendingActionId === null, 'the reply carries the envelope (version 1 reads `message`)'); }
  { const r = await route({ name: 'trace', method: 'GET', path: '/history?limit=1', role: 'owner', seed, ai: [agent(() => ({ content: 'Hello there.' }))], before: [{ method: 'POST', path: '/messages/text', body: { text: 'Hello Office' } }] });
    const it = (r.result.body.items || [])[0] || {}, interp = (it.generated || {}).interpreted || {};
    check(it.recorded && it.recorded.heard === 'Hello Office' && (it.generated || {}).replied === 'Hello there.' && interp.converse === 'agent' && interp.outcome === 'reply' && interp.steps === 1, 'the audit trail keeps what was heard, what was said and how the front door handled it (' + JSON.stringify(interp).slice(0, 80) + ')'); }

  // ---- a read: a tool is called, the figure comes from its result -----------------------------------------------------------------------------------------------------------------------------
  const readThenSay = agent((input, turn) => turn === 0 ? { tool_calls: [call('list_invoices')] } : { content: 'Jenny has one invoice, for R' + /"amount":\s*(\d+)/.exec(toolMsgs(input)[0].content)[1] + '.' });
  { const r = await say("Morning, Office. How are we looking on Jenny's invoices?", [readThenSay]);
    const ins = inputsOf(r);
    check(r.threw === null && /R5000\./.test(r.result.body.message) && ins.length === 2 && logOnly(r), 'a business question is answered in two model calls with a tool between them, the figure taken from the tool result, and nothing written (' + (r.threw || r.result.body.message) + ')');
    check(ins[1].messages.some((m) => m.role === 'assistant' && m.tool_calls) && toolMsgs(ins[1]).length === 1 && /5000/.test(toolMsgs(ins[1])[0].content) && ins[1].messages[0].content === ins[0].messages[0].content, 'the tool result goes back as a tool message after the assistant\'s call, and is never merged into the system prompt'); }
  { const two = agent((input, turn) => turn === 0 ? { tool_calls: [call('list_invoices', {}, 'a'), call('get_aged_debtors', {}, 'b')] } : { content: 'Jenny is the only one with an invoice, R5000.' });
    const r = await say('Hello, can you tell me what Jenny owes and then help me understand why our debtors are increasing?', [two]);
    check(r.threw === null && toolMsgs(inputsOf(r)[1]).length === 2 && /R5000/.test(r.result.body.message), 'a mixed message (a greeting, a lookup, a request for reasoning) is not swallowed: two tools are called in one step and both results go back'); }
  { const r = await say('how much do we have outstanding?', [agent((input, turn) => turn === 0 ? { tool_calls: [call('get_aged_debtors')] } : { content: 'Jenny owes R9,999 in total.' })]);
    check(r.result.body.message === FALLBACK && logOnly(r), 'a reply with a figure that is in no tool result is replaced by the fixed sentence: ' + r.result.body.message); }
  { const r = await say('how much do we have outstanding?', [agent((input, turn) => turn === 0 ? { tool_calls: [call('list_invoices')] } : { content: 'You have R5,000 and R2,500 outstanding.' })]);
    check(r.result.body.message === FALLBACK, 'and so is a figure the model calculated itself'); }
  { const r = await say('how much do we have outstanding?', [agent((input, turn) => turn === 0 ? { tool_calls: [call('list_invoices')] } : { content: 'Jenny owes R5,000.' })]);
    check(r.result.body.message === 'Jenny owes R5,000.', 'a figure formatted differently from the tool result (R5,000 for 5000) is still grounded'); }
  { const r = await say('hello', [agent(() => ({ content: 'Done, I have recorded that for you.' }))]);
    check(r.result.body.message === FALLBACK, 'a claim that something was recorded is replaced by the fixed sentence'); }
  { const r = await say('hello', [agent(() => ({ content: 'x'.repeat(1500) }))]); check(r.result.body.message === FALLBACK, 'a very long reply is replaced by the fixed sentence'); }

  // ---- limits on the loop, bad calls, permissions ----------------------------------------------------------------------------------------------------------------------------------------------
  { const r = await say('keep going', [agent(() => ({ tool_calls: [call('list_invoices')] }))]), ins = inputsOf(r);
    check(ins.length === 3 && !ins[2].tools && ins[0].tools && r.result.body.message === FALLBACK, 'a model that never stops calling tools gets three calls, the last without tools, then the fixed sentence (' + ins.length + ' calls)'); }
  { const r = await say('hmm', [agent((input, turn) => turn === 0 ? { tool_calls: [call('list_invoices', '{not json')] } : { content: 'I could not read that. What would you like to see?' })]);
    check(r.threw === null && /error|invalid|could not/i.test(toolMsgs(inputsOf(r)[1])[0].content) && /What would you like/.test(r.result.body.message), 'a tool call with unreadable arguments is answered with an error the model can read, and the conversation goes on'); }
  { const r = await say('what is our profit', [agent((input, turn) => turn === 0 ? { tool_calls: [call('get_profit_and_loss')] } : { content: 'I am not able to see that.' })], { role: 'installer' }), ins = inputsOf(r);
    const prof = (ins[0].tools || []).map((t) => t.function.name);
    check(!prof.includes('get_profit_and_loss') && ins.length === 2 && !/5000/.test(toolMsgs(ins[1])[0].content), 'a role not allowed to see the profit and loss is not offered it, and when the model calls it anyway it gets a refusal with no figure');
    const wr = await say('please do it', [agent((input, turn) => turn === 0 ? { tool_calls: [call('tell_the_office', { text: 'invoice Jenny R100' })] } : { content: 'I cannot do that here.' })]);
    check(wr.threw === null && logOnly(wr) && !/R100/.test(toolMsgs(inputsOf(wr)[1])[0].content), 'a call to a creating tool (not offered) is refused and nothing is created'); }

  // ---- hand-off: an instruction goes to the existing pipeline, exactly as before ---------------------------------------------------------------------------------------------------------------
  { const handoff = await say('Jenny paid R500', [agent(() => ({ tool_calls: [call('hand_to_office')] })), SPLIT, READ_PAYMENT]);
    const off = await say('Jenny paid R500', [SPLIT, READ_PAYMENT], { env: { BUSINESS_ID: 'acme-co' } });
    check(handoff.threw === null && /Payment noted for Jenny Smith of R500 — needs your confirmation/.test(handoff.result.body.message) && handoff.result.body.pendingActionId === 1, 'an instruction handed off is held for confirmation by the existing pipeline');
    check(JSON.stringify(handoff.result.body) === JSON.stringify(off.result.body) && JSON.stringify(handoff.writes) === JSON.stringify(off.writes), 'and the reply and every record written are identical to the front door being off'); }
  { const failing = await say('Jenny paid R500', [agent(() => { throw new Error('model down'); }), SPLIT, READ_PAYMENT]);
    const off = await say('Jenny paid R500', [SPLIT, READ_PAYMENT], { env: { BUSINESS_ID: 'acme-co' } });
    check(JSON.stringify(failing.result.body) === JSON.stringify(off.result.body) && JSON.stringify(failing.writes) === JSON.stringify(off.writes), 'if the front door itself fails (the model), the message goes to the existing pipeline and the result is identical to it being off'); }
  { const off = await say('Hello Office', [SPLIT, { match: /Extract structured facts from a tradesperson's message/, reply: { ...harness.EXTRACTION_DEFAULTS, intent: 'other' } }, agent(() => ({ content: 'NEVER' }))], { env: { BUSINESS_ID: 'acme-co', CONVERSE: 'off', CONVERSE_MODE: 'agent' } });
    const unset = await say('Hello Office', [SPLIT, { match: /Extract structured facts from a tradesperson's message/, reply: { ...harness.EXTRACTION_DEFAULTS, intent: 'other' } }, { match: /You are The Office, a calm/, reply: 'Phase one reply.' }], { env: { BUSINESS_ID: 'acme-co' } });
    check(off.result.body.message === "I didn't catch anything there I could act on." && inputsOf(off).length === 0, 'CONVERSE=off switches the front door off even in agent mode: the old reply, no front-door call');
    check(unset.result.body.message === 'Phase one reply.' && inputsOf(unset).length === 0, 'with CONVERSE_MODE unset (production) the front door does not exist and Phase 1 behaves exactly as it does today'); }

  // ---- isolation and leaks ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  { const lastUser = (input) => input.messages.filter((m) => m.role === 'user').pop().content;
    const ans = agent((input) => ({ content: /OWNER-EARLIER/.test(lastUser(input)) ? 'Owner earlier reply.' : /ZEBRA-SECRET/.test(lastUser(input)) ? 'Accountant earlier reply.' : 'Hello again.' }));
    const before = [{ method: 'POST', path: '/messages/text', role: 'owner', body: { text: 'OWNER-EARLIER-LINE about my day' } }, { method: 'POST', path: '/messages/text', role: 'accountant', body: { text: 'ZEBRA-SECRET about the books' } }];
    const a = await say('Hello again', [ans], { before }), b = await say('Hello again', [ans], { before, role: 'accountant' });
    const sa = JSON.stringify(inputsOf(a).pop().messages), sb = JSON.stringify(inputsOf(b).pop().messages);
    check(/OWNER-EARLIER/.test(sa) && !/ZEBRA/.test(sa) && /ZEBRA-SECRET/.test(sb) && !/OWNER-EARLIER/.test(sb), 'the model is given the member\'s own earlier turns only (not another member\'s)'); }
  { const leak = (db) => { seed(db); db.exec("INSERT INTO pending_actions (type, payload, source_transcript, status, resolved_at) VALUES ('invoice', '{\"customerName\":\"ZEBRA-INVOICE-CUSTOMER\",\"amount\":1500}', 'x', 'confirmed', '2026-10-03 10:00:00')"); };
    const r = await say('Good morning, what can you help me with?', [agent(() => ({ content: 'Good morning. I can help with your customers, quotes, invoices and more.' }))], { seed: leak, kvSeed: { 'life:2026-10-03': JSON.stringify({ facts: [{ text: 'ZEBRA-LIFE-NOTE' }] }) } });
    const sent = JSON.stringify(inputsOf(r)), shown = JSON.stringify(r.result.body);
    check(r.threw === null && !/ZEBRA|1500/.test(sent) && !/ZEBRA|1500/.test(shown), 'unrelated business facts (a confirmed invoice, a life note) are in neither the conversational prompt nor the reply: the model is given no facts bundle'); }
  { const r = await route({ name: 'voice', method: 'POST', path: '/files/audio', role: 'owner', seed, before: [], ai: [{ match: /@cf\/openai\/whisper/, raw: true, reply: { text: 'good morning office' } }, agent(() => ({ content: 'Good morning.' }))], form: { audio: { name: 'note.m4a', type: 'audio/mp4', text: 'fake audio bytes' } } });
    check(r.threw === null && r.result.body.message === 'Good morning.' && inputsOf(r).length === 1, 'a spoken greeting is answered the same way as a typed one'); }

  // ---- who and what comes first -----------------------------------------------------------------------------------------------------------------------------------------------------------------------
  { const seen = []; const env = { OFFICE_DB: harness.d1(harness.newDatabase(workerDir)), CONVERSE_MODE: 'agent', AI: { run: async () => { seen.push(1); return { choices: [{ message: { content: 'hi' } }] }; } } };
    const none = await ag.tryAgent(env, 'hello', { email: null, role: null, capabilities: [] }, 'https://x.test'), noRole = await ag.tryAgent(env, 'hello', { email: 'a@b.co', role: null, capabilities: [] }, 'https://x.test');
    check(none.kind === 'pass' && noRole.kind === 'pass' && seen.length === 0, 'with no signed-in member (or one with no role) the front door does nothing and makes no model call'); }
  { const ctx = { version: 1, room: 'analysis', report: 'profit_and_loss', period: { from: '2026-10-01', to: '2026-10-31' }, compare: { from: '2026-09-01', to: '2026-09-30' }, filters: {} };
    const seedBoth = (db) => { db.exec("INSERT INTO customers (name) VALUES ('Jenny Smith'); INSERT INTO invoices (customer_id, description, amount, created_at) VALUES (1, 'Sept', 5000, '2026-09-10 08:00:00'), (1, 'Oct', 8000, '2026-10-14 10:00:00');"); };
    const r = await say('why did it drop', [agent(() => ({ content: 'NEVER' }))], { seed: seedBoth, body: { text: 'why did it drop', context: ctx } });
    check(r.threw === null && inputsOf(r).length === 0 && /revenue|expenses|profit/i.test(r.result.body.message), 'the existing follow-up check still runs FIRST: with an analysis open, "why did it drop" is taken by the follow-up (its own answer or its own question) and the front door is never asked (' + String(r.threw || r.result.body.message).slice(0, 60) + ')'); }
  { const r = await say('hello', [agent(() => ({ content: 'Hello.' }))]), sys = (inputsOf(r)[0].messages[0] || {}).content || '';
    check(/Never calculate/.test(sys) && /Never say that anything was recorded/.test(sys) && new RegExp(ag.HANDOFF_TOOL).test(sys) && /Every fact or figure about the business must come from a tool result/.test(sys) && !/R\s?\d/.test(sys), 'the persona says: facts only from tools, copy figures exactly, never calculate, never claim anything was recorded, hand work off');
    const inst = await say('hello', [agent(() => ({ content: 'Hello.' }))], { role: 'installer' }), isys = (inputsOf(inst)[0].messages[0] || {}).content || '';
    check(/financial reports/.test(sys) === ((ROLE.owner || []).includes('can_know_profit')) && /financial reports/.test(isys) === ((ROLE.installer || []).includes('can_know_profit')), 'and it lists only the capabilities that role has'); }

  // ---- work is decided in code, never by the model alone ------------------------------------------------------------------------------------------------------------------------------------------------
  { const work = ['Bought diesel for R650', 'Jenny paid R500', 'Invoice Jenny R1200 for a repair', 'Remind me to call Thandi tomorrow', 'Add 5 boards to stock', 'Quote Sipho for the lounge', 'Can you remind me to phone Peter', 'schedule the Thandi job for Friday', 'Please record an expense of fifty rand', 'we bought glue today', 'Cancel the order for Floornet'];
    const talk = ['Hello Office', 'Good morning, Office. How are you doing today?', 'I want to have a conversation with you', 'What can you help me with?', 'Can you explain what you can help me with?', 'I had a difficult day yesterday and wanted to talk through something.', 'Do you remember what I just said?',
      "Morning, Office. How are we looking on Jenny's outstanding invoices?", 'Hello, can you tell me what Jenny owes and then help me understand why our debtors are increasing?', 'How much does Jenny owe?', 'Who owes us money?', 'How much have we spent on expenses?', 'What jobs do I have coming up?', 'Do we have any open quotes?', 'hmm', 'what about the other one'];
    const missed = work.filter((t) => !ag.LOOKS_LIKE_WORK.test(t)), swallowed = talk.filter((t) => ag.LOOKS_LIKE_WORK.test(t));
    check(missed.length === 0, 'every recorded instruction is recognised as work in code: ' + missed.join(' | '));
    check(swallowed.length === 0, 'and none of the recorded conversation, lookup or mixed messages is taken for work: ' + swallowed.join(' | '));
    const r = await say('Bought diesel for R650', [agent(() => ({ content: 'I can record that as an expense. Was this diesel for a specific job?' })), SPLIT, { match: /Extract structured facts from a tradesperson's message/, reply: { ...harness.EXTRACTION_DEFAULTS, intent: 'expense', amount: 650 } }]);
    check(r.threw === null && inputsOf(r).length === 0 && r.result.body.message !== 'I can record that as an expense. Was this diesel for a specific job?', 'an instruction never reaches the model at all (a real model chatted back instead of handing it off): the existing pipeline takes it and the model is not called (' + String(r.threw || r.result.body.message).slice(0, 70) + ')'); }

  // ---- the source: what the module may touch --------------------------------------------------------------------------------------------------------------------------------------------------
  const src = fs.readFileSync(path.join(srcDir, 'converse-agent.ts'), 'utf8'), code = src.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  const imports = [...code.matchAll(/^\s*import\s+(?:type\s+)?(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s+"([^"]+)"/gm)].map((m) => m[1]).sort();
  check(JSON.stringify(imports) === JSON.stringify(['./ai', './converse', './mcp', './mcp-keys', './types']), 'converse-agent.ts imports only the retry helper, the Phase 1 helpers (which read history), the connector\'s read-tool accessors and types (' + imports.join(', ') + ')');
  check(/scope:\s*SCOPE_READ\s*\}/.test(code) && !/SCOPE_WRITE|mcp:write/.test(code), 'layer 3: the member is built with the READ scope, and the write scope is not mentioned anywhere in the module');
  check(!/\.(?:prepare|exec|batch)\(/.test(code) && !/\b(?:INSERT INTO|UPDATE \w+ SET|DELETE FROM|ALTER TABLE|CREATE TABLE|DROP TABLE)\b/i.test(code) && !/pending_actions|OFFICE_VAULT|CUSTOMER_NOTES|MEMORY|SHARED_DB|waitUntil|fetch\(|processTranscript/.test(code), 'it has no SQL, no held action, no file store, no network, and never calls the pipeline itself: a hand-off only tells the route to');
  check((code.match(/env\.AI\.run\(/g) || []).length === 1 && /withRetry\(\s*\(\)\s*=>\s*env\.AI\.run\(/.test(code), 'the one model call is inside withRetry');
  check(/CONVERSE_MODE/.test(code) && /CONVERSE\b/.test(code) && /lastTurns\(env, who\.email\)/.test(code), 'it reads CONVERSE_MODE and CONVERSE, and takes history only through the Phase 1 reader (the member\'s own turns)');
  const index = fs.readFileSync(path.join(srcDir, 'index.ts'), 'utf8');
  check((index.match(/tryAgent\(/g) || []).length === 2 && /import \{ tryAgent \} from "\.\/converse-agent"/.test(index), 'the typed and the voice route call it, once each');
  const mcpSrc = fs.readFileSync(path.join(srcDir, 'mcp.ts'), 'utf8');
  check(/export function readToolsFor/.test(mcpSrc) && /!t\.needsWrite/.test(mcpSrc.slice(mcpSrc.indexOf('export function readToolsFor'))), 'mcp.ts exports the read-tool accessors, and the read filter is in it');
};
