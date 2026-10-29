// The read layer (worker/src/read-layer.ts): the app's door to the same read-only data the MCP tools return (Pierre, 2026-10-29: "the MCP is the benchmark"), answering in WORDS, built by code from the shared data functions
// (mcp-reads.ts: jobsData, quotesData, stockData, customersData), so no model composes a figure and no model call is made. Found missing by the Office read baseline: today's date, jobs for anything but exactly today, tasks without
// due dates, quotes, stock, a customer's jobs. What this pins:
//  - GUARDS: owner only, exactly like the MCP list tools (they are ownerOnly); any other role, or none, gets null and the ordinary pipeline answers as it always did; READ_LAYER=off switches it off
//  - JUDGMENT, in code and tested (Pierre): "today" is today (plus anything overdue); "tomorrow"; "this week"; "coming up" is the next 14 days, soonest first, with what has no date apart; something far off (a January gala) is NOT volunteered and
//    appears only when a month is asked for; a done task and a past job never appear
//  - it never takes an instruction, a money question or anything not question-shaped: those reach the pipeline untouched
//  - it is read only: no write, no model call, nothing but SELECTs; the route records it in the history and logs the capture
const path = require('path'), fs = require('fs'), os = require('os'), esbuild = require('esbuild');

module.exports = async function runReadLayerTests({ check, srcDir }) {
  const workerDir = path.join(srcDir, '..');
  const bundle = (entry) => { const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rl-')), 'm.js'); esbuild.buildSync({ entryPoints: [path.join(srcDir, entry)], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent' }); return require(out); };
  let rl; try { rl = bundle('read-layer.ts'); } catch (e) { check(false, 'read-layer.ts builds: ' + String(e.message).split('\n')[0].slice(0, 160)); return; }
  const harness = require('./harness.js'), fns = await harness.loadFunctions(workerDir);
  const NOW = new Date(2026, 9, 29, 10, 0, 0);   // Thursday 29 October 2026, the business's own clock
  const owner = { role: 'owner' };
  const seed = (db) => db.exec(`
    INSERT INTO customers (id, name) VALUES (1, 'Spike Alder Birch'), (2, 'Sipho Dlamini');
    INSERT INTO job_scopes (id, customer_id, description, scheduled_date_raw, scheduled_date) VALUES
      (1, 1, 'vinyl flooring installation', 'today', '2026-10-29'), (2, 2, 'carpet installation', 'tomorrow', '2026-10-30'), (3, 1, 'tiling the kitchen', 'in 2 weeks', '2026-11-12'),
      (4, 1, 'hospital floor', '15 January', '2027-01-15'), (5, 1, 'measure the lounge', NULL, NULL), (6, 2, 'old job', 'last week', '2026-10-20');
    INSERT INTO tasks (id, description, done, due_date_raw, due_date) VALUES
      (1, 'phone Gran about her birthday', 0, 'tomorrow', '2026-10-30'), (2, 'attend the Zululand gala', 0, '15 January', '2027-01-15'), (3, 'send statements', 0, 'monday', '2026-10-27'),
      (4, 'order underlay', 0, NULL, NULL), (5, 'call Thandi', 0, 'today', '2026-10-29'), (6, 'file the VAT return', 1, 'today', '2026-10-29');
    INSERT INTO quotations (id, customer_id, description, amount, status) VALUES (1, 1, 'lounge flooring', 4500, 'pending'), (2, 2, 'office floor', 9000, 'converted');
    INSERT INTO stock_items (id, name, unit, quantity_on_hand, reorder_threshold) VALUES (1, 'alder screed', 'bags', 12, 5), (2, 'glue', 'tubs', 2, 4);`);
  const db = harness.newDatabase(workerDir); seed(db);
  const env = (extra = {}) => ({ OFFICE_DB: harness.d1(db), ...extra });
  const ask = async (q, who = owner, e = env()) => rl.tryReadLayer(e, q, who, NOW);
  const msg = async (q) => ((await ask(q)) || {}).message || '';
  const has = (m, ...parts) => parts.every((p) => m.toLowerCase().includes(p.toLowerCase()));
  const lacks = (m, ...parts) => parts.every((p) => !m.toLowerCase().includes(p.toLowerCase()));

  // ---- today's date --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  for (const q of ["What is today's date?", "What's the date today?", 'What day is it?', 'what date is it', "What's today's date"]) { const r = await ask(q); check(r && r.kind === 'date' && r.message === 'Today is Thursday 29 October 2026.', `"${q}" is answered with today's date from the business clock (${r && r.message})`); }

  // ---- the schedule, with judgment -------------------------------------------------------------------------------------------------------------------------------------------------------
  { const m = await msg("What's on for today?");
    check(has(m, 'vinyl flooring installation for Spike Alder Birch', 'call Thandi', 'send statements') && lacks(m, 'Gran', 'gala', 'carpet', 'tiling', 'hospital', 'old job', 'VAT return', 'order underlay'), '"what\'s on for today" is today\'s jobs and tasks plus what is OVERDUE: not tomorrow, not far off, not a done task, not a past job, not a task with no date: ' + m.replace(/\n/g, ' | ').slice(0, 150)); }
  { const m = await msg('What do I need to do tomorrow?');
    check(has(m, 'phone Gran about her birthday', 'carpet installation for Sipho Dlamini') && lacks(m, 'gala', 'Thandi', 'vinyl', 'hospital'), '"tomorrow" is tomorrow\'s: the reminder to phone Gran (Pierre\'s example) and the job, and not January\'s gala: ' + m.replace(/\n/g, ' | ').slice(0, 150)); }
  { const m = await msg('What jobs do I have today?'); check(has(m, 'vinyl flooring installation for Spike Alder Birch') && lacks(m, 'Thandi', 'Gran', 'carpet'), '"jobs today" is jobs only, today only'); }
  { const m = await msg('What tasks do I have tomorrow?'); check(has(m, 'phone Gran') && lacks(m, 'carpet', 'vinyl'), '"tasks tomorrow" is tasks only'); }
  { const m = await msg('What jobs do I have coming up?');
    check(has(m, 'vinyl flooring installation', 'carpet installation', 'tiling the kitchen', 'not yet scheduled', 'measure the lounge') && lacks(m, 'hospital', 'old job', 'Gran', 'gala', 'Thandi'), '"jobs coming up" is the next 14 days, soonest first, with what has no date kept apart, and NO job in January, no past job, no task: ' + m.replace(/\n/g, ' | ').slice(0, 200)); }
  { const m = await msg("What's coming up?");
    check(has(m, 'Gran', 'vinyl flooring installation', 'tiling the kitchen', 'overdue', 'send statements', 'call Thandi') && lacks(m, 'gala', 'hospital', 'old job', 'VAT return'), '"what\'s coming up" holds jobs and tasks for the next 14 days and what is overdue, and does NOT volunteer the gala or the job in January (Pierre): ' + m.replace(/\n/g, ' | ').slice(0, 200));
    check(m.indexOf('Today') < m.indexOf('Tomorrow') && m.indexOf('Tomorrow') < m.indexOf('Thu 12 Nov'), 'in date order: today, tomorrow, then the 12th'); }
  { const m = await msg('Do I have anything planned for January?');
    check(has(m, 'January 2027', 'hospital floor for Spike Alder Birch', 'attend the Zululand gala') && lacks(m, 'Gran', 'carpet', 'Thandi'), 'a month asked for shows what falls in it, however far off: ' + m.replace(/\n/g, ' | ').slice(0, 160)); }
  { const m = await msg("What's on this week?"); check(has(m, 'vinyl flooring installation', 'carpet installation', 'Gran') && lacks(m, 'tiling', 'hospital'), '"this week" runs from today to Sunday'); }
  { const m = await msg("What's on next week?"); check(has(m, 'Nothing scheduled') && has(m, 'next week') && lacks(m, 'tiling'), '"next week" is the following Monday to Sunday, and when empty says so plainly: ' + m); }
  { const m = await msg('What do I have on tomorrow?'); check(has(m, 'carpet installation', 'Gran'), 'a different wording of tomorrow reads the same'); }
  { const m = await msg("What's on for today?"); check(m.startsWith('Today, Thu 29 Oct') || /Today, Thu 29 Oct/.test(m), 'the heading carries the weekday and date (Thu 29 Oct)'); }
  { const empty = harness.newDatabase(workerDir); const m = ((await rl.tryReadLayer({ OFFICE_DB: harness.d1(empty) }, 'What jobs do I have today?', owner, NOW)) || {}).message; check(m === 'No jobs scheduled for today.', 'with nothing on, "jobs today" says so plainly and does not say "I don\'t have that on file" (' + m + ')'); }

  // ---- a customer's jobs, quotes, stock ---------------------------------------------------------------------------------------------------------------------------------------------------
  { const r = await ask("When is Spike Alder Birch's job?"); const m = r ? r.message : '';
    check(r && r.kind === 'customer_jobs' && has(m, 'Spike Alder Birch', 'vinyl flooring installation', 'tiling the kitchen', 'hospital floor', 'measure the lounge', 'not yet scheduled') && lacks(m, 'Sipho', 'carpet', 'old job'), 'a customer\'s jobs (the MCP\'s list_jobs with a customer filter): all of THEIR jobs, dated and undated, and no one else\'s: ' + m.replace(/\n/g, ' | ').slice(0, 200)); }
  { const m = await msg('Do we have any open quotes?'); check(has(m, 'lounge flooring', 'R4500', 'Spike Alder Birch') && lacks(m, 'office floor', 'R9000'), 'open quotes: the pending one, not the converted one'); }
  { const m = await msg('How much was the quote for Spike Alder Birch?'); check(has(m, 'R4500', 'lounge flooring'), 'a customer\'s quote and its amount'); }
  { const m = await msg('What do we have in stock?'); check(has(m, 'alder screed: 12 bags', 'glue: 2 tubs') && has(m, 'below'), 'stock: every tracked item with its quantity and unit, and an item at or below its reorder level flagged'); }
  { const m = await msg('How many bags of alder screed do we have?'); check(has(m, '12 bags', 'alder screed') && lacks(m, 'glue'), 'one item\'s quantity'); }
  check((await ask('How many bags of unobtainium do we have?')) === null, 'an item that is not tracked is not answered (it goes on to the pipeline, which will say so)');

  // ---- guards: owner only, a kill switch ---------------------------------------------------------------------------------------------------------------------------------------------------
  { const q = ["What's on for today?", 'Do we have any open quotes?', 'What do we have in stock?', "What is today's date?", "When is Spike Alder Birch's job?"], got = [];
    for (const role of ['installer', 'accountant', 'sales', 'member', '', null]) for (const x of q) got.push([role, x, await ask(x, { role })]);
    check(got.every(([, , r]) => r === null), 'any role but the owner (installer, accountant, none) gets nothing from the read layer, exactly as the MCP\'s list tools are owner only: the pipeline answers as before'); }
  check((await ask("What's on for today?", owner, env({ READ_LAYER: 'off' }))) === null && (await ask("What's on for today?", owner, env({ READ_LAYER: 'on' }))) !== null, 'READ_LAYER=off switches it off; anything else leaves it on');

  // ---- what it must never take -----------------------------------------------------------------------------------------------------------------------------------------------------------
  const never = ['Invoice Spike Alder Birch R3000 for carpet repair', 'Spike Alder Birch paid R1000', 'Quote Spike Alder Birch R4500 for lounge flooring', 'Bought glue for R850 for Spike', 'Schedule vinyl flooring installation for Spike today', 'Remind me to phone Gran tomorrow',
    'Add 12 bags of screed to stock', 'Measure the lounge, it is 6 metres by 4 metres', 'Remind me to attend the gala on 15 January', 'Schedule the quote for tomorrow', 'Please add tiling to the jobs for Friday',
    'How much does Spike Alder Birch owe?', 'Who owes us money?', 'How is the business doing financially?', 'How much have we spent on expenses?', 'Why did our expenses go up?', 'hello', 'What can you help me with?', 'Thanks, that is all', 'I want to have a conversation with you',
    'hmm', 'What about the other one?', 'quotes', 'stock', 'jobs', 'Do we have a customer called Sipho?', 'How many customers do we have?', 'What did I spend on diesel?', 'Tell me about the Zululand gala', 'What jobs do I have on the 12th', 'Do we have 3 open quotes', 'What invoices are scheduled for today', 'What did we spend on stock'];
  { const taken = []; for (const q of never) { if ((await ask(q)) !== null) taken.push(q); } check(taken.length === 0, 'an instruction, a money question, a greeting, a bare word or anything not about the schedule, quotes or stock is never taken: ' + taken.join(' | ')); }

  // ---- read only, and no model ------------------------------------------------------------------------------------------------------------------------------------------------------------
  { const before = JSON.stringify(db.prepare('SELECT (SELECT COUNT(*) FROM job_scopes) j, (SELECT COUNT(*) FROM tasks) t, (SELECT COUNT(*) FROM quotations) q, (SELECT COUNT(*) FROM stock_items) s, (SELECT SUM(done) FROM tasks) d').all());
    for (const q of ["What's coming up?", 'Do we have any open quotes?', 'What do we have in stock?', "When is Spike Alder Birch's job?"]) await ask(q);
    check(JSON.stringify(db.prepare('SELECT (SELECT COUNT(*) FROM job_scopes) j, (SELECT COUNT(*) FROM tasks) t, (SELECT COUNT(*) FROM quotations) q, (SELECT COUNT(*) FROM stock_items) s, (SELECT SUM(done) FROM tasks) d').all()) === before, 'asking changes nothing in the business'); }

  // ---- through the real routes: no model call, the history, the capture, the guards ------------------------------------------------------------------------------------------------
  const route = (spec) => harness.runRouteCase(fns, workerDir, { env: { BUSINESS_ID: 'acme-co' }, ...spec });
  const userOf = (input) => input.messages.filter((m) => m.role === 'user').pop().content;
  const SPLIT = { match: /Find genuinely SEPARATE topics and split/, reply: (input) => [userOf(input)] };
  const LOOKUP = { match: /Extract structured facts from a tradesperson's message/, reply: { ...harness.EXTRACTION_DEFAULTS, intent: 'lookup', query_scope: 'personal' } };
  const seedRoute = (d) => d.exec(`INSERT INTO customers (id, name) VALUES (1, 'Spike Alder Birch'); INSERT INTO job_scopes (customer_id, description, scheduled_date_raw, scheduled_date) VALUES (1, 'vinyl flooring installation', 'today', '2026-10-03');`);
  { const r = await route({ name: 'owner jobs', method: 'POST', path: '/messages/text', body: { text: 'What jobs do I have today?' }, role: 'owner', seed: seedRoute, ai: [] });
    check(r.threw === null && r.result.status === 200 && has(r.result.body.message, 'vinyl flooring installation for Spike Alder Birch') && r.aiCalls.length === 0 && Object.keys(r.writes).every((t) => ['captures', 'interaction_log'].includes(t)), 'typed route: the owner\'s question is answered from the data with NO model call and nothing written but the capture and the history line (' + String(r.threw || r.result.body.message).slice(0, 80) + ')');
    check(r.result.body.experience && r.result.body.pendingActionId === null, 'and the reply keeps the envelope'); }
  { const h = await route({ name: 'history', method: 'GET', path: '/history?limit=1', role: 'owner', seed: seedRoute, ai: [], before: [{ method: 'POST', path: '/messages/text', body: { text: 'What jobs do I have today?' } }] });
    const it = (h.result.body.items || [])[0] || {}, interp = (it.generated || {}).interpreted || {};
    check(it.recorded && it.recorded.heard === 'What jobs do I have today?' && interp.intent === 'lookup' && interp.read_layer === 'schedule', 'the history keeps what was heard and that the read layer answered (' + JSON.stringify(interp).slice(0, 80) + ')'); }
  { const r = await route({ name: 'installer jobs', method: 'POST', path: '/messages/text', body: { text: 'What jobs do I have today?' }, role: 'installer', seed: seedRoute, ai: [SPLIT, LOOKUP, { match: /Answer the tradesperson's question using only the facts below/, reply: 'PIPELINE ANSWER' }] });
    check(r.threw === null && r.result.body.message === 'PIPELINE ANSWER' && r.aiCalls.length >= 2, 'a non-owner\'s identical question still goes through the pipeline and gets its answer (' + String(r.threw || r.result.body.message).slice(0, 60) + ')'); }
  { const r = await route({ name: 'voice', method: 'POST', path: '/files/audio', role: 'owner', seed: seedRoute, before: [], ai: [{ match: /@cf\/openai\/whisper/, raw: true, reply: { text: 'what jobs do I have today' } }], form: { audio: { name: 'note.m4a', type: 'audio/mp4', text: 'fake audio bytes' } } });
    check(r.threw === null && has(r.result.body.message, 'vinyl flooring installation for Spike Alder Birch') && r.aiCalls.length === 1, 'a spoken question is answered the same way, from the same data (only the transcription is a model call)'); }
  { const r = await route({ name: 'instruction', method: 'POST', path: '/messages/text', body: { text: 'Spike Alder Birch paid R500' }, role: 'owner', seed: seedRoute, ai: [SPLIT, { match: /Extract structured facts from a tradesperson's message/, reply: { ...harness.EXTRACTION_DEFAULTS, intent: 'payment', customer_name: 'Spike Alder Birch', amount: 500 } }] });
    check(r.threw === null && /needs your confirmation/.test(r.result.body.message), 'an instruction goes through the pipeline and is held for confirmation, as before'); }
  { const r = await route({ name: 'off', method: 'POST', path: '/messages/text', body: { text: 'What jobs do I have today?' }, role: 'owner', seed: seedRoute, env: { BUSINESS_ID: 'acme-co', READ_LAYER: 'off' }, ai: [SPLIT, LOOKUP, { match: /Answer the tradesperson's question using only the facts below/, reply: 'PIPELINE ANSWER' }] });
    check(r.threw === null && r.result.body.message === 'PIPELINE ANSWER', 'READ_LAYER=off at the route gives the old behaviour'); }

  // ---- the source ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const src = fs.readFileSync(path.join(srcDir, 'read-layer.ts'), 'utf8'), code = src.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  check(!/\b(?:INSERT INTO|UPDATE \w+ SET|DELETE FROM|ALTER TABLE|CREATE TABLE|DROP TABLE|INSERT OR|REPLACE INTO)\b/i.test(code) && !/env\.AI\b|fetch\(|waitUntil|pending_actions|OFFICE_VAULT/.test(code), 'read-layer.ts has no write SQL, no model call, no network and no held action');
  const imports = [...code.matchAll(/^\s*import\s+(?:type\s+)?(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s+"([^"]+)"/gm)].map((m) => m[1]).sort();
  check(JSON.stringify(imports) === JSON.stringify(['./mcp-reads', './scheduler', './types']), 'it imports only the shared MCP data functions, the scheduler helpers and types (' + imports.join(', ') + ')');
  check(/role !== "owner"|role === "owner"/.test(code) && /READ_LAYER/.test(code), 'it checks the owner role and the READ_LAYER switch');
  const index = fs.readFileSync(path.join(srcDir, 'index.ts'), 'utf8');
  check((index.match(/tryReadLayer\(/g) || []).length === 2 && /import \{ tryReadLayer \} from "\.\/read-layer"/.test(index), 'the typed route and the voice route call it, once each');
};
