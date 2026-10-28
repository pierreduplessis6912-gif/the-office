// The conversational layer, Phase 1 (worker/src/converse.ts). CONVERSATIONAL_LAYER.md is the document. What this pins:
//  - it runs ONLY when the ordinary pipeline found nothing to act on (intent "other", nothing held, nothing refused); every business instruction keeps its exact old path
//  - a greeting or "I want to have a conversation" gets a conversational reply instead of "I didn't catch anything there I could act on."
//  - "what can you help me with?" is answered from a capability list that is checked against FEATURES.md (live headings only), filtered by the member's role
//  - Kimi gets no tools and no business data, and its words pass a deterministic check before they can be shown: no figure, no claim that anything was recorded, saved, created, sent or confirmed
//  - converse.ts cannot write: a source check on its imports and SQL, and the only thing that changes in the reply is `message`
//  - CONVERSE=off restores the old behaviour exactly; any failure anywhere returns the old message
//  - a member's earlier turns come only from their own history in their own business's database
const path = require('path'), fs = require('fs'), os = require('os'), esbuild = require('esbuild');

module.exports = async function runConverseTests({ check, srcDir }) {
  const workerDir = path.join(srcDir, '..'), root = path.join(workerDir, '..');
  const bundle = (entry) => { const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cv-')), 'm.js'); esbuild.buildSync({ entryPoints: [path.join(srcDir, entry)], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent' }); return require(out); };
  let cv, noIntent;
  try { cv = bundle('converse.ts'); noIntent = bundle('no-intent.ts'); } catch (e) { check(false, 'converse.ts builds: ' + String(e.message).split('\n')[0].slice(0, 160)); return; }
  const NO = noIntent.NO_INTENT_MESSAGE;
  const harness = require('./harness.js'), fns = await harness.loadFunctions(workerDir);
  const route = (spec) => harness.runRouteCase(fns, workerDir, { env: { BUSINESS_ID: 'acme-co' }, ...spec });
  const userOf = (input) => input.messages.find((m) => m.role === 'user').content;
  const SPLIT = { match: /Find genuinely SEPARATE topics and split/, reply: (input) => [userOf(input)] };
  const READ_OTHER = { match: /Extract structured facts from a tradesperson's message/, reply: { ...harness.EXTRACTION_DEFAULTS, intent: 'other' } };
  const READ_PAYMENT = { match: /Extract structured facts from a tradesperson's message/, reply: { ...harness.EXTRACTION_DEFAULTS, intent: 'payment', customer_name: 'Jenny Smith', amount: 500 } };
  const PERSONA = /You are The Office, a calm/;
  const talk = (reply) => ({ match: PERSONA, reply });
  const isPersona = (s) => PERSONA.test(s);
  const personaCalls = (r) => r.aiInputs.filter(isPersona);
  const systemOf = (inputJson) => JSON.parse(inputJson).messages.find((m) => m.role === 'system').content;
  const seed = (db) => db.exec(`INSERT INTO people (name) VALUES ('Jenny Smith'); INSERT INTO customers (name, person_id) VALUES ('Jenny Smith', 1);`);
  const say = (text, ai, extra = {}) => route({ name: text.slice(0, 40), method: 'POST', path: '/messages/text', body: { text }, role: 'owner', seed, ai, ...extra });
  const logOnly = (r) => Object.keys(r.writes).every((t) => ['captures', 'interaction_log'].includes(t));
  const HELLO = 'Hello. I am here and listening. What is on your mind about the business today?';

  // ---- 1. a greeting and "I want to have a conversation" -------------------------------------------------------------------------------------------------------------------------------------
  { const r = await say('Hi Office, I want to have a conversation with you', [SPLIT, READ_OTHER, talk(HELLO)]);
    check(r.threw === null && r.result.status === 200 && r.result.body.status === 'processed' && r.result.body.message === HELLO && r.result.body.message !== NO, '"Hi Office, I want to have a conversation with you" gets a conversational reply, not the failure text (' + JSON.stringify(r.threw || r.result.body.message).slice(0, 90) + ')');
    check(logOnly(r) && personaCalls(r).length === 1 && r.aiCalls.length === 3, 'it makes exactly one extra model call and writes only the capture and the history line: no business record, no held action (' + Object.keys(r.writes).join(',') + ')');
    check(r.result.body.experience && typeof r.result.body.experience === 'object' && r.result.body.pendingActionId === null, 'the reply still carries the envelope (version 1 reads `message`), so an old APK is unaffected');
    const seen = JSON.parse(personaCalls(r)[0]);
    check(seen.tools === undefined && seen.functions === undefined && seen.temperature !== undefined && /thinking/.test(JSON.stringify(seen.chat_template_kwargs || {})), 'the model is given no tools and no functions, and runs with thinking off like every other call');
    const sys = seen.messages.find((m) => m.role === 'system').content;
    check(/never (?:state|give|invent|say)[^.]*(?:figure|number|amount)/i.test(sys) && /never say[^.]*(?:recorded|saved|created|sent|confirmed)/i.test(sys) && !/R\s?\d/.test(sys), 'the persona forbids stating figures and claiming that anything was recorded, saved, created, sent or confirmed');
    const last = seen.messages[seen.messages.length - 1];
    check(last.role === 'user' && last.content === 'Hi Office, I want to have a conversation with you', 'the person\'s own words are the last message sent'); }

  // ---- 2. "what can you help me with?": only real capabilities, filtered by role -------------------------------------------------------------------------------------------------------------
  const features = fs.readFileSync(path.join(root, 'FEATURES.md'), 'utf8');
  const live = features.split('## Designed, not yet built')[0], designed = features.split('## Designed, not yet built')[1] || '';
  const liveHeadings = [...live.matchAll(/^## (.+)$/gm)].map((m) => m[1].trim());
  check(Array.isArray(cv.REAL_CAPABILITIES) && cv.REAL_CAPABILITIES.length >= 10 && cv.REAL_CAPABILITIES.every((c) => typeof c.feature === 'string' && typeof c.says === 'string'), 'the capability list exists and every entry names the FEATURES.md section it comes from');
  check(cv.REAL_CAPABILITIES.every((c) => liveHeadings.includes(c.feature)), 'every capability named comes from a section of FEATURES.md that is built (not from "Designed, not yet built"): ' + cv.REAL_CAPABILITIES.filter((c) => !liveHeadings.includes(c.feature)).map((c) => c.feature).join(' | '));
  check(!cv.REAL_CAPABILITIES.some((c) => /warranty|remnant/i.test(c.says)) && /warranty/i.test(designed), 'nothing from the designed-but-not-built list is offered (warranty tracking, remnant tracking)');
  for (const role of ['owner', 'installer']) {
    const caps = fns.auth.ROLE_CAPABILITIES[role] || [];
    const r = await say('What can you help me with?', [SPLIT, READ_OTHER, talk('I can help with quotes, invoices, expenses and more. What would you like to start with?')], { role });
    const sys = personaCalls(r).length ? systemOf(personaCalls(r)[0]) : '';
    const listed = cv.REAL_CAPABILITIES.filter((c) => sys.includes(c.says));
    const expected = cv.REAL_CAPABILITIES.filter((c) => !c.needs || caps.includes(c.needs));
    check(r.result.body.message.startsWith('I can help with quotes') && listed.length === expected.length && listed.length > 0, `"what can you help me with?" (${role}): the model is given exactly the capabilities that role has (${listed.length} of ${cv.REAL_CAPABILITIES.length}), nothing else`);
  }
  check(cv.REAL_CAPABILITIES.some((c) => c.needs) && cv.REAL_CAPABILITIES.every((c) => !c.needs || /^can_/.test(c.needs)), 'a capability that needs a permission (financial reporting) is only described to someone who holds it');

  // ---- 3. a real business instruction keeps the old path, held for confirmation --------------------------------------------------------------------------------------------------------
  const pay = await say('Jenny paid R500', [SPLIT, READ_PAYMENT, talk('SHOULD NEVER BE CALLED')]);
  const payOff = await say('Jenny paid R500', [SPLIT, READ_PAYMENT, talk('SHOULD NEVER BE CALLED')], { env: { BUSINESS_ID: 'acme-co', CONVERSE: 'off' } });
  check(pay.threw === null && /Payment noted for Jenny Smith of R500 — needs your confirmation \(action #1\) before it's recorded\./.test(pay.result.body.message) && pay.result.body.pendingActionId === 1, 'a real instruction ("Jenny paid R500") still comes back held for confirmation, with its action number (' + String(pay.threw || pay.result.body.message).slice(0, 80) + ')');
  check(personaCalls(pay).length === 0 && pay.aiCalls.length === 2 && !!pay.writes.pending_actions, 'the conversation layer is never called for it (two model calls as before), and the held action is written');
  check(JSON.stringify(pay.result.body) === JSON.stringify(payOff.result.body) && JSON.stringify(pay.writes) === JSON.stringify(payOff.writes), 'with the layer on, the reply and every record written are identical to the reply and records with it switched off');

  // ---- 4. the kill switch restores the old behaviour exactly ---------------------------------------------------------------------------------------------------------------------------
  const off = await say('Hi Office, I want to have a conversation with you', [SPLIT, READ_OTHER, talk('SHOULD NEVER BE CALLED')], { env: { BUSINESS_ID: 'acme-co', CONVERSE: 'off' } });
  const broken = await say('Hi Office, I want to have a conversation with you', [SPLIT, READ_OTHER, talk(() => { throw new Error('model down'); })]);
  check(off.result.body.message === NO && personaCalls(off).length === 0 && off.aiCalls.length === 2, 'CONVERSE=off: the old message, word for word, and no extra model call');
  check(broken.result.status === 200 && broken.result.body.message === NO && logOnly(broken), 'a failing model gives the old message too: the conversation can only ever add to the old behaviour, never remove it');
  check(JSON.stringify(off.result.body) === JSON.stringify(broken.result.body) && JSON.stringify(off.writes) === JSON.stringify(broken.writes), 'and the whole reply and every write are identical in both cases');
  { const on = await say('Hi Office, I want to have a conversation with you', [SPLIT, READ_OTHER, talk(HELLO)]);
    const keys = (o) => Object.keys(o).sort().join();
    check(keys(on.result.body) === keys(off.result.body) && on.result.body.transcript === off.result.body.transcript && on.result.body.pendingActionIds.length === 0, 'switched on, the reply has the same fields as before; only `message` (and what is derived from it) differs'); }

  // ---- 5. fragments of one sentence ----------------------------------------------------------------------------------------------------------------------------------------------------
  { const replies = [];
    const frag = talk((input) => { const n = replies.length + 1; const reply = ['Go on, I am listening.', 'Take your time.', 'Yes, and then what?'][n - 1]; replies.push(reply); return reply; });
    const r = await say('and what we should do next', [SPLIT, READ_OTHER, frag], { before: [{ method: 'POST', path: '/messages/text', body: { text: 'I was thinking about how' } }, { method: 'POST', path: '/messages/text', body: { text: 'this whole week has gone' } }] });
    const calls = personaCalls(r), failures = [r.result.body.message].filter((m) => m === NO).length;
    console.log(`  recorded: one sentence sent in 3 pieces -> ${replies.length} conversational replies, ${failures} failure texts in the last piece (the first two pieces: ${replies.slice(0, 2).join(' / ')})`);
    check(r.threw === null && replies.length === 3 && failures === 0 && r.result.body.message === 'Yes, and then what?', 'fragmented turns: none of the three pieces gets the failure text; each is answered as conversation');
    const lastSystem = JSON.parse(calls[2]).messages.map((m) => m.content).join('\n');
    check(/I was thinking about how/.test(lastSystem) && /this whole week has gone/.test(lastSystem) && /Go on, I am listening\./.test(lastSystem), 'the third piece is answered with the first two (and the replies to them) in view, taken from the member\'s own history'); }

  // ---- 6. isolation: only the caller's own turns, only from their own business's database -------------------------------------------------------------------------------------------
  { const lastUser = (input) => input.messages.filter((m) => m.role === 'user').pop().content;
    const answers = talk((input) => (/OWNER-EARLIER/.test(lastUser(input)) ? 'Owner earlier reply.' : /ZEBRA-SECRET/.test(lastUser(input)) ? 'Accountant earlier reply ZEBRA-REPLY.' : HELLO));
    const before = [{ method: 'POST', path: '/messages/text', role: 'owner', body: { text: 'OWNER-EARLIER-LINE about my day' } }, { method: 'POST', path: '/messages/text', role: 'accountant', body: { text: 'ZEBRA-SECRET about the books' } }];
    const r = await say('Hello again', [SPLIT, READ_OTHER, answers], { before });
    const sent = personaCalls(r).pop() || '';
    check(/OWNER-EARLIER-LINE/.test(sent) && /Owner earlier reply\./.test(sent) && !/ZEBRA/.test(sent), 'another member\'s turns in the same business are never given to the model (only the caller\'s own history is read)');
    const acc = await say('Hello again', [SPLIT, READ_OTHER, answers], { before, role: 'accountant' });
    const sentAcc = personaCalls(acc).pop() || '';
    check(/ZEBRA-SECRET/.test(sentAcc) && /ZEBRA-REPLY/.test(sentAcc) && !/OWNER-EARLIER/.test(sentAcc), 'and the accountant sees their own turns, not the owner\'s'); }
  { // two businesses are two databases: what is in the other one cannot be reached from this one
    const here = harness.newDatabase(workerDir), there = harness.newDatabase(workerDir);
    const hs = bundle('history.ts');
    const put = async (db, secret) => { const id = Number(db.prepare("INSERT INTO captures (raw_text, source) VALUES (?, 'text')").run(secret).lastInsertRowid); await hs.recordInteraction({ OFFICE_DB: harness.d1(db) }, { actorEmail: 'owner@example.com', source: 'text', captureId: id, processed: { message: 'ok' } }); };
    await put(here, 'HERE-LINE'); await put(there, 'OTHER-BUSINESS-SECRET');
    const prompts = []; const env = { OFFICE_DB: harness.d1(here), SHARED_DB: harness.d1(there), AI: { run: async (m, input) => { prompts.push(JSON.stringify(input)); return { choices: [{ message: { content: HELLO } }] }; } } };
    const processed = { message: NO, extraction: { intent: 'other' }, customer: null, pendingActionIds: [], pendingActionId: null, factPendingActionId: null };
    const out = await cv.tryConverse(env, 'hi', processed, { email: 'owner@example.com', capabilities: fns.auth.ROLE_CAPABILITIES.owner });
    check(out === HELLO && prompts.length === 1 && /HERE-LINE/.test(prompts[0]) && !/OTHER-BUSINESS-SECRET/.test(prompts[0]), 'history is read from the business\'s own database only: another business\'s database (even one bound beside it) is never read'); }

  // ---- 7. the gate: when the layer may run, and what may be shown ------------------------------------------------------------------------------------------------------------------------
  const stub = (reply, calls = []) => ({ calls, AI: { run: async (m, input) => { calls.push(input); if (reply instanceof Error) throw reply; return { choices: [{ message: { content: reply } }] }; } } });
  const base = { message: NO, extraction: { intent: 'other' }, customer: null, character: null, pendingActionIds: [], pendingActionId: null, factPendingActionId: null };
  const who = { email: 'owner@example.com', capabilities: fns.auth.ROLE_CAPABILITIES.owner };
  const tryWith = async (processed, reply, env = {}) => { const s = stub(reply); const e = { OFFICE_DB: harness.d1(harness.newDatabase(workerDir)), ...env, AI: s.AI }; return { out: await cv.tryConverse(e, 'hi', processed, who), calls: s.calls }; };
  { const cases = [
      ['a customer was found', { ...base, customer: { id: 1, name: 'Jenny', matched: true } }], ['something was held (the list)', { ...base, pendingActionIds: [3] }], ['something was held (the first)', { ...base, pendingActionId: 3 }], ['a fact was held', { ...base, factPendingActionId: 4 }],
      ['a role refusal was made', { ...base, refusals: [{ code: 'x' }] }], ['the intent was a payment', { ...base, extraction: { intent: 'payment' } }], ['the model could not read it (no extraction)', { ...base, extraction: null }],
      ['the message is not the failure text', { ...base, message: 'Got it.' }], ['a lookup', { ...base, extraction: { intent: 'lookup' }, message: 'Jenny owes R1,200.' }], ['a character was noted', { ...base, character: { id: 2, name: 'Sipho', matched: true } }]];
    const outs = []; for (const [name, p] of cases) { const t = await tryWith(p, HELLO); outs.push([name, t.out, t.calls.length]); }
    check(outs.every(([, out, n]) => out === null && n === 0), 'it declines (and makes no model call) whenever anything was understood, held, found or refused: ' + outs.filter(([, out, n]) => out !== null || n !== 0).map((o) => o[0]).join(', ')); }
  { const t = await tryWith(base, HELLO, { CONVERSE: 'off' }); check(t.out === null && t.calls.length === 0, 'CONVERSE=off: nothing happens, no model call'); }
  { const t = await tryWith(base, HELLO); check(t.out === HELLO && t.calls.length === 1, 'nothing understood and nothing held: the reply is shown'); }
  { const refused = ['Done, I have recorded that invoice for you.', 'I created a quote for Jenny.', 'Your invoice has been sent.', 'I have saved that.', 'That is confirmed.', "I've scheduled it for Friday.", 'Noted, I have logged it.', 'I updated the stock.', 'It was added to your list.', 'I have paid the supplier.',
      'Your balance is R1,200.', 'You have 3 customers.', 'Jenny owes you 500 rand.', 'That was in 2026.', '', '   ', 'x'.repeat(701)];
    const outs = []; for (const reply of refused) outs.push([reply, (await tryWith(base, reply)).out]);
    check(outs.every(([, out]) => out === null), 'a model reply with a figure, a year, or a claim that anything was recorded, saved, created, sent, confirmed, logged, added, updated, scheduled or paid is never shown (the old message stands): ' + outs.filter(([, o]) => o !== null).map((o) => JSON.stringify(o[0])).join(' ')); }
  { const fine = ['Good morning. How can I help today?', 'I can help you quote a job, invoice a customer, or look at your expenses. What would you like to do?', "Of course. Tell me what's on your mind.", 'Anything you ask me to do is held until you confirm it.', 'Tell me about the job and I will help you work out what to say.'];
    const outs = []; for (const reply of fine) outs.push([reply, (await tryWith(base, reply)).out]);
    check(outs.every(([reply, out]) => out === reply), 'ordinary conversation passes, including talk about confirming (the check is for claims that something HAS been done): ' + outs.filter(([r, o]) => o !== r).map((o) => JSON.stringify(o[0])).join(' ')); }
  { const t = await tryWith(base, new Error('model down')); check(t.out === null, 'a model failure returns null, never throws'); const t2 = await tryWith(base, undefined); check(t2.out === null, 'a malformed model answer returns null'); }
  { const s = stub(HELLO); const e = { OFFICE_DB: { prepare() { throw new Error('db down'); } }, AI: s.AI }; check((await cv.tryConverse(e, 'hi', base, who)) === HELLO, 'if the history cannot be read, the conversation carries on without it'); }

  // ---- 8. converse.ts cannot write, and the routes only ever swap `message` ----------------------------------------------------------------------------------------------------------
  const src = fs.readFileSync(path.join(srcDir, 'converse.ts'), 'utf8'), code = src.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  const imports = [...code.matchAll(/^\s*import\s+(?:type\s+)?(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s+"([^"]+)"/gm)].map((m) => m[1]).sort();
  check(JSON.stringify(imports) === JSON.stringify(['./ai', './history', './no-intent', './types']), 'converse.ts imports only the retry helper, the history reader, the failure-text constant and types (' + imports.join(', ') + '): nothing that can write a record or hold an action');
  const names = (from) => [...code.matchAll(new RegExp('import\\s+(?:type\\s+)?\\{([^}]*)\\}\\s+from\\s+"' + from.replace(/[./]/g, '\\$&') + '"', 'g'))].flatMap((m) => m[1].split(',').map((x) => x.trim()).filter(Boolean)).sort().join();
  check(names('./ai') === 'withRetry' && names('./history') === 'readHistory' && names('./no-intent') === 'NO_INTENT_MESSAGE' && names('./types') === 'Env', 'and only these names from them: withRetry, readHistory (the reader, never recordInteraction or any writer), the constant, and the Env type (' + [names('./ai'), names('./history')].join(' | ') + ')');
  check(!/\.(?:prepare|exec|batch)\(/.test(code) && !/\b(?:INSERT INTO|UPDATE \w+ SET|DELETE FROM|ALTER TABLE|CREATE TABLE|DROP TABLE|INSERT OR)\b/i.test(code), 'converse.ts has no SQL write and no database call of its own (history comes only through readHistory)');
  check(!/pending_actions|OFFICE_VAULT|CUSTOMER_NOTES|MEMORY|SHARED_DB|OFFICE_DB\.prepare|\.put\(|waitUntil|fetch\(/.test(code), 'converse.ts touches no held action, file store, notes, memory, shared database, network or background work');
  check((code.match(/env\.AI\.run\(/g) || []).length === 1 && /withRetry\(\s*\(\)\s*=>\s*env\.AI\.run\(/.test(code), 'the one model call is inside withRetry');
  check(/CONVERSE/.test(code) && /scope:\s*"own"/.test(code) && !/scope:\s*"all"/.test(code), 'it reads the CONVERSE switch and reads history with scope "own" only');
  const index = fs.readFileSync(path.join(srcDir, 'index.ts'), 'utf8');
  check((index.match(/tryConverse\(/g) || []).length === 2 && /import \{ tryConverse \} from "\.\/converse"/.test(index), 'the two routes (typed message, voice note) call it, once each');
  check((index.match(/\{ \.\.\.processed, message: \w+ \}/g) || []).length === 2, 'the routes replace only `message` in the reply, in exactly those two places; nothing else of it is touched');
  const reply = fs.readFileSync(path.join(srcDir, 'intents', 'reply.ts'), 'utf8');
  check(/NO_INTENT_MESSAGE/.test(reply) && !/"I didn't catch anything there I could act on\."/.test(reply) && NO === "I didn't catch anything there I could act on.", 'the failure text is one constant, word for word as before');

  // ---- 9. a voice note goes the same way ----------------------------------------------------------------------------------------------------------------------------------------------
  { const WHISPER = (reply) => ({ match: /@cf\/openai\/whisper/, raw: true, reply });
    const voice = { name: 'note.m4a', type: 'audio/mp4', text: 'fake audio bytes' };
    const a = await route({ name: 'voice greeting', method: 'POST', path: '/files/audio', role: 'owner', seed, before: [], ai: [WHISPER({ text: 'hello office' }), SPLIT, READ_OTHER, talk(HELLO)], form: { audio: voice } });
    check(a.threw === null && a.result.status === 200 && a.result.body.message === HELLO && personaCalls(a).length === 1, 'a spoken "hello office" is answered as conversation too');
    const b = await route({ name: 'voice greeting off', method: 'POST', path: '/files/audio', role: 'owner', seed, before: [], env: { BUSINESS_ID: 'acme-co', CONVERSE: 'off' }, ai: [WHISPER({ text: 'hello office' }), SPLIT, READ_OTHER, talk('NEVER')], form: { audio: voice } });
    check(b.result.body.message === NO && personaCalls(b).length === 0, 'and CONVERSE=off gives the old message for voice as well');
    const c = await route({ name: 'voice payment', method: 'POST', path: '/files/audio', role: 'owner', seed, before: [], ai: [WHISPER({ text: 'Jenny paid R500' }), SPLIT, READ_PAYMENT, talk('NEVER')], form: { audio: voice } });
    check(/needs your confirmation/.test(c.result.body.message) && personaCalls(c).length === 0, 'a spoken business instruction is untouched: held for confirmation, no conversation call'); }
};
