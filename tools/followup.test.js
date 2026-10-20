// Spoken follow-ups on an open analysis (worker/src/followup.ts). THE GATE (LOOKUP_ROUTING_ARCHITECTURE.md: a classifier does not go live without recorded phrases and zero side effects): a table of recorded phrasings, each with what it must be taken as, and EVERY ONE must match: a phrase that is a follow-up is routed, and a phrase that is not (an ordinary command, a general question the existing routes answer, a question about something else) is left alone (null), so the ordinary pipeline handles it exactly as before. It is PRECISION-FIRST: when in doubt it is not a follow-up.
// Then the behaviour against real SQL: nothing happens unless an analysis is on screen; the answers are built from the analysis and receivables data, with exact figures, never a cause; permissions are the routes' own; a customer is never guessed (a name that fits two customers, or "their" with nothing selected, is asked about); it never writes; and the interpretation is recorded.
const path = require('path'), fs = require('fs'), os = require('os'), esbuild = require('esbuild');

module.exports = async function runFollowUpTests({ check, srcDir }) {
  const bundle = (entry) => { const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fu-')), 'm.js'); esbuild.buildSync({ entryPoints: [path.join(srcDir, entry)], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent' }); return require(out); };
  let fu, hs, ex;
  try { fu = bundle('followup.ts'); hs = bundle('history.ts'); ex = bundle('experience.ts'); } catch (e) { check(false, 'followup.ts builds: ' + String(e.message).split('\n')[0].slice(0, 160)); return; }

  // ---- the recorded phrases ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  // [phrase, class or null, topic (null = taken from the open analysis), pronoun]
  const P = [
    // why did it change
    ['why did it drop', 'why_changed', null], ['Why did it drop?', 'why_changed', null], ['and why did that fall', 'why_changed', null], ['so why is it down', 'why_changed', null], ['why did it go up', 'why_changed', null], ['why did it go up so much', 'why_changed', null],
    ['ok why did it change', 'why_changed', null], ['why is it lower', 'why_changed', null], ['why did this rise', 'why_changed', null], ['how come it dropped', 'why_changed', null], ['why was it worse', 'why_changed', null],
    ['why did revenue drop', 'why_changed', 'revenue'], ['why did sales fall this month', 'why_changed', 'revenue'], ['why are expenses up', 'why_changed', 'expenses'], ['why did our costs go up', 'why_changed', 'expenses'], ['why is profit down', 'why_changed', 'profit'], ['why did profit drop so much', 'why_changed', 'profit'], ['why did income dip', 'why_changed', 'revenue'],
    ['what changed', 'why_changed', null], ['what happened there', 'why_changed', null], ["what's driving it", 'why_changed', null], ['whats driving that', 'why_changed', null], ['what is driving this', 'why_changed', null], ["what's behind the drop", 'why_changed', null], ["what's behind that", 'why_changed', null], ['what caused the increase', 'why_changed', null], ['what caused that', 'why_changed', null],
    ["what's driving the rise in expenses", 'why_changed', 'expenses'],
    // which parts moved it
    ['which customers caused most of that', 'top_drivers', null], ['Which customers caused most of that?', 'top_drivers', null], ['which customers drove that', 'top_drivers', null], ['which customer was behind it', 'top_drivers', null], ['which categories drove it', 'top_drivers', null], ['which category caused most of the increase', 'top_drivers', null],
    ['who drove that', 'top_drivers', null], ["who's behind it", 'top_drivers', null], ['who caused that', 'top_drivers', null], ['what are the biggest contributors', 'top_drivers', null], ['show me the top movers', 'top_drivers', null], ['top contributors', 'top_drivers', null], ['which customers were responsible for the drop', 'top_drivers', null],
    // a customer's outstanding invoices
    ['show me their outstanding invoices', 'customer_invoices', null, true], ['Show me their outstanding invoices.', 'customer_invoices', null, true], ['show their unpaid invoices', 'customer_invoices', null, true], ['list their overdue invoices', 'customer_invoices', null, true], ['what do they owe', 'customer_invoices', null, true], ['how much do they owe', 'customer_invoices', null, true], ['and show me their outstanding invoices', 'customer_invoices', null, true],
    ['how much does Jenny owe', 'customer_invoices', null, false], ['what does Jenny owe us', 'customer_invoices', null, false], ["show me Jenny's outstanding invoices", 'customer_invoices', null, false], ['list Ballz unpaid invoices', 'customer_invoices', null, false], ['show me the unpaid invoices for Thandi', 'customer_invoices', null, false],
    // NOT follow-ups: left alone, so the ordinary pipeline answers exactly as before
    ['invoice Jenny for 1200', null], ['what is on my list today', null], ['remind me to call Thandi tomorrow', null], ['add 5 boards to stock', null], ['what is our financial position', null], ['show me aged debtors', null], ['who owes me money', null], ['which customers owe me money', null], ['show me everyone who owes us', null], ['who owes us the most', null],
    ['which customers have outstanding invoices', null], ['show me my outstanding invoices', 'customer_invoices', null, false], ['why did the customer cancel', null], ['why is my invoice late', null], ['why did you do that', null], ['why did it fail', null], ['why did that happen', null], ['why did it', null], ['why was the delivery late', null], ['why did the price go up', null],
    ['which customers should I call', null], ['who is the top customer', null], ['what are my top customers', null], ['which customers moved the most', null], ['Jenny owes me 500', null], ['record a payment from Jenny', null], ['show me their invoices', null], ['what changed on the schedule', null], ['why did revenue and expenses drop', null], ['', null], ['hello', null], ['x'.repeat(300), null], ['why did it drop '.repeat(30), null],
  ];
  let wrong = 0, confidentWrong = 0;
  for (const [text, cls, topic, pronoun] of P) {
    const got = fu.classifyFollowUp(text);
    const ok = cls === null ? got === null : got !== null && got.cls === cls && (topic === undefined || got.topic === topic) && (pronoun === undefined || got.pronoun === pronoun);
    if (!ok) { wrong++; if (got !== null && (cls === null || got.cls !== cls)) confidentWrong++; }
    check(ok, `the phrase ${JSON.stringify(text.length > 60 ? text.slice(0, 60) + '...' : text)} is ${cls === null ? 'left alone' : 'taken as ' + cls + (topic ? ' (' + topic + ')' : '') + (pronoun ? ' (their)' : '')}${ok ? '' : '; got ' + JSON.stringify(got)}`);
  }
  check(wrong === 0 && confidentWrong === 0, `THE GATE: all ${P.length} recorded phrases are routed as recorded, and none is confidently routed wrongly (${wrong} wrong, ${confidentWrong} confident-wrong)`);

  // ---- against real SQL --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const { newDatabase } = require('./harness.js'); const D1 = bundle('storage/do-d1.ts').DoD1Database; const plain = (r) => (r ? { ...r } : r);
  const shim = (db) => { const sql = { exec(query, ...binds) { const s = db.prepare(query); if (/^\s*(select|with|pragma|values)\b/i.test(query) || /\breturning\b/i.test(query)) { const rows = s.all(...binds).map(plain); return { toArray: () => rows, rowsRead: rows.length, rowsWritten: 0 }; } const r = s.run(...binds); return { toArray: () => [], rowsRead: 0, rowsWritten: Number(r.changes) }; } }; const storage = { transactionSync(fn) { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } } }; return new D1(sql, storage); };
  const db = newDatabase(path.join(srcDir, '..')); const env = { OFFICE_DB: shim(db) };
  const cust = (name) => Number(db.prepare('INSERT INTO customers (name) VALUES (?)').run(name).lastInsertRowid);
  const inv = db.prepare('INSERT INTO invoices (customer_id, description, amount, created_at) VALUES (?, ?, ?, ?)');
  const pay = db.prepare("INSERT INTO payments (customer_id, amount, source_transcript, created_at) VALUES (?, ?, 't', ?)");
  const jenny = cust('Jenny'), ballz = cust('Ballz'), thandi = cust('Thandi Mokoena');
  inv.run(jenny, 'Sept floor', 5000, '2026-09-10 08:00:00'); inv.run(ballz, 'Sept blinds', 4000, '2026-09-12 08:00:00');
  inv.run(jenny, 'Oct floor', 8000, '2026-10-14 10:00:00'); inv.run(ballz, 'Oct blinds', 3000, '2026-10-05 10:00:00'); inv.run(thandi, 'Oct decking', 2000, '2026-10-16 10:00:00'); pay.run(jenny, 1500, '2026-10-01 08:00:00');
  const OWNER = ['can_know_profit', 'can_know_debtors'];
  const ctx = (over = {}) => ({ version: 1, room: 'analysis', report: 'profit_and_loss', period: { from: '2026-10-01', to: '2026-10-31' }, compare: { from: '2026-09-01', to: '2026-09-30' }, filters: { topic: 'revenue' }, ...over });
  const CAUSAL = /because|due to|caused|as a result|result of|reason|owing to|thanks to|therefore|led to|resulted/i;

  // nothing happens unless an analysis is on screen, and the kill switch works
  check(await fu.tryFollowUp(env, 'why did it drop', null, OWNER) === null && await fu.tryFollowUp(env, 'why did it drop', ctx({ room: 'finance' }), OWNER) === null && await fu.tryFollowUp(env, 'why did it drop', ctx({ room: undefined }), OWNER) === null, 'with no analysis on screen (no context, another room, no room) a follow-up phrase is NOT taken: the ordinary pipeline answers it');
  check(await fu.tryFollowUp({ ...env, FOLLOWUPS: 'off' }, 'why did it drop', ctx(), OWNER) === null && await fu.tryFollowUp(env, 'invoice Jenny for 1200', ctx(), OWNER) === null && await fu.tryFollowUp(env, 'who owes me money', ctx(), OWNER) === null, 'the kill switch turns it off, and a phrase that is not a follow-up is left alone even with an analysis on screen');

  // why did it change
  { const r = await fu.tryFollowUp(env, 'why did it drop', ctx(), OWNER);
    check(r !== null && /For 1 Oct to 31 Oct 2026 against 1 Sep to 30 Sep 2026: Revenue rose by R4,000\.00 \(44\.44%\), from R9,000\.00 to R13,000\.00\./.test(r.message) && /Jenny accounts for R3,000\.00 of the change \(75% of it\)/.test(r.message) && /The records show what changed, not why it happened\./.test(r.message) && /ask which customers drove it/.test(r.message), 'why did it drop (revenue open): the exact change from the report with the period and the comparison, the biggest driver, and a plain statement that the records do not say why');
    check(r && !CAUSAL.test(r.message.replace(/"[^"]*"/g, '')) && r.interpreted.followUp === 'why_changed' && r.interpreted.outcome === 'answered' && r.interpreted.topic === 'revenue', 'and the answer gives no cause, and the interpretation says what was understood'); }
  { const r = await fu.tryFollowUp(env, 'why are expenses up', ctx({ filters: { topic: 'revenue' } }), OWNER);
    check(r && r.interpreted.topic === 'expenses' && /no net change in total expenses|Total expenses/.test(r.message), 'a topic named in the phrase wins over the topic on screen (the period stays the one on screen)'); }
  { const r = await fu.tryFollowUp(env, 'why did it drop', ctx({ filters: undefined }), OWNER), r2 = await fu.tryFollowUp(env, 'why did it drop', ctx({ period: undefined, compare: undefined }), OWNER);
    check(r && /Which would you like to look at: revenue, expenses or profit\?/.test(r.message) && r.interpreted.outcome === 'asked' && r2 && /Open the analysis and pick a period first/.test(r2.message), 'with no topic or no period to go on it ASKS instead of guessing'); }

  // which parts moved it
  { const r = await fu.tryFollowUp(env, 'which customers caused most of that', ctx(), OWNER);
    check(r && /The biggest movers by customer, for 1 Oct to 31 Oct 2026 against 1 Sep to 30 Sep 2026, were Jenny up R3,000\.00 \(75% of the change\) and Thandi Mokoena up R2,000\.00 \(50% of the change\)\./.test(r.message) && !/Ballz/.test(r.message.split('were')[1].split('not why')[0]) && /not why it happened/.test(r.message) && r.interpreted.followUp === 'top_drivers', 'which customers caused that: the biggest movers by customer with their share of the change (an offset is not named as a driver)'); }
  { const r = await fu.tryFollowUp(env, 'who drove that', ctx({ period: { from: '2026-10-01', to: '2026-10-31' }, compare: { from: '2026-10-01', to: '2026-10-31' } }), OWNER);
    check(r && /Nothing moved enough to name by customer/.test(r.message), 'when nothing moved it says so instead of naming a driver'); }

  // a customer's outstanding invoices
  { const r = await fu.tryFollowUp(env, 'how much does Jenny owe', ctx(), OWNER);
    check(r && /Jenny has R11,500\.00 outstanding across 2 invoices\. The oldest is R3,500\.00 from 2026-09-10, \d+ days old\./.test(r.message) && /calculated: payments are applied to the oldest invoices first, not matched to specific invoices/.test(r.message) && r.interpreted.customerId === jenny, 'how much does Jenny owe: the total, the count and the oldest, labelled calculated (R1,500 paid is applied to the oldest invoice first)'); }
  { const r = await fu.tryFollowUp(env, 'show me their outstanding invoices', ctx({ report: 'aged_debtors', selection: [{ type: 'customer', id: ballz }] }), OWNER);
    check(r && /^Ballz has R7,000\.00 outstanding across 2 invoices/.test(r.message), '"their" means the customer selected on screen'); }
  { const r = await fu.tryFollowUp(env, 'show me their outstanding invoices', ctx(), OWNER), nobody = await fu.tryFollowUp(env, 'show me their outstanding invoices', ctx({ period: undefined, compare: undefined }), OWNER);
    check(r && /^Which customer do you mean\? The biggest movers were Jenny, Thandi Mokoena\./.test(r.message) && r.interpreted.outcome === 'asked' && nobody && /Which customer do you mean\? Tap one in the analysis, or say their name\./.test(nobody.message), '"their" with nothing selected ASKS (naming the biggest movers when it can), it does not pick one'); }
  { const dup = cust('Jenny');   // a second customer with the same name
    const r = await fu.tryFollowUp(env, 'what does Jenny owe us', ctx(), OWNER);
    check(r && /More than one customer fits: Jenny, Jenny\. Which one do you mean\?/.test(r.message) && r.interpreted.reason === 'more_than_one_customer', 'a name that fits two customers is ASKED about, never guessed');
    db.prepare('DELETE FROM customers WHERE id = ?').run(dup); }
  { const r = await fu.tryFollowUp(env, 'how much does Thandi owe', ctx(), OWNER), n = await fu.tryFollowUp(env, 'how much does Zed owe', ctx(), OWNER), paidup = cust('Paid Up'); inv.run(paidup, 'Settled', 100, '2026-10-01 08:00:00'); pay.run(paidup, 150, '2026-10-02 08:00:00');
    const p = await fu.tryFollowUp(env, 'what does Paid Up owe', ctx(), OWNER);
    check(r && /^Thandi Mokoena has R2,000\.00 outstanding across 1 invoice\./.test(r.message) && n === null && p && /^Nothing is outstanding for Paid Up\. R50\.00 of their payments is not applied to any invoice\./.test(p.message), 'a first name is enough when only one customer fits; an unknown name is NOT a follow-up (the ordinary pipeline answers it); and a paid-up customer shows nothing outstanding and any unapplied payment'); }
  check(await fu.tryFollowUp(env, 'show me the outstanding invoices', ctx(), OWNER) === null, 'a general "show me the outstanding invoices" (no customer, no "their") is NOT a follow-up: the existing routes answer it');

  // permissions: the routes' own, and no figures leak
  { const a = await fu.tryFollowUp(env, 'why did it drop', ctx(), []), b = await fu.tryFollowUp(env, 'how much does Jenny owe', ctx(), ['can_know_profit']), c = await fu.tryFollowUp(env, 'which customers caused that', ctx(), ['can_know_debtors']);
    check(a && a.message === 'The financial analysis is restricted for your role.' && b && b.message === 'Who owes what is restricted for your role.' && c && c.message === 'The financial analysis is restricted for your role.' && ![a, b, c].some((x) => /R\d/.test(x.message)) && a.interpreted.outcome === 'restricted', 'the analysis needs the profit capability and a customer\'s invoices need the debtors capability (as their routes do), and a restricted role gets no figures'); }

  // never writes, and the interpretation is recorded with the turn
  { const after = db.prepare('SELECT COUNT(*) n FROM invoices').get().n, caps = db.prepare('SELECT COUNT(*) n FROM captures').get().n, pend = db.prepare('SELECT COUNT(*) n FROM pending_actions').get().n;
    check(caps === 0 && pend === 0 && after === 6, 'answering follow-ups wrote nothing: no capture, no held action, no invoice (the invoices are the ones the test inserted)'); }
  { const reply = fu.followUpReply('why did it drop', 'A message.'), env2 = ex.buildExperience(reply);
    check(reply.message === 'A message.' && reply.pendingActions.length === 0 && reply.pendingActionId === null && reply.extraction === null && reply.rewrittenQuery === 'why did it drop' && env2.recommendation.mode === 'speak' && env2.recommendation.speak === 'A message.' && env2.mustStillPass.confirmationRequired === false, 'the reply has the shape every message route returns, carries only words, and its envelope is a plain speak');
    const w = { db: newDatabase(path.join(srcDir, '..')) }; const wenv = { OFFICE_DB: shim(w.db) };
    const cap = Number(w.db.prepare("INSERT INTO captures (raw_text, source) VALUES ('why did it drop', 'text')").run().lastInsertRowid);
    const ok = await hs.recordInteraction(wenv, { actorEmail: 'o@x.co', source: 'text', captureId: cap, processed: reply, viewing: ctx(), interpreted: { followUp: 'why_changed', outcome: 'answered', topic: 'revenue' } });
    const row = w.db.prepare('SELECT interpreted, replied, mode, viewing FROM interaction_log').get();
    check(ok === true && JSON.parse(row.interpreted).followUp === 'why_changed' && row.replied === 'A message.' && row.mode === 'speak' && JSON.parse(row.viewing).room === 'analysis', 'the turn is recorded with what was understood (interpreted), what was said, and what was on screen'); }
};
