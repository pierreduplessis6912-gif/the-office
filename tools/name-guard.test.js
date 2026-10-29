// The customer name guard (Pierre, 2026-10-29). Found by the Office read baseline: after the canonical people check, reconcileCustomer matched ANY existing customer whose name merely CONTAINED the spoken first and last words
// ("Jan Hendrik Botha" landed on "Jan Pieter Botha", "Spike Hazel Larch" on "Spike Willow Larch"). Money actions were held and named the match, but a job scope or measurement was written at once, and nothing said the name differed.
// Now a near-match is ASKED, before any write, with the existing ambiguous_person hold (so the permission map, the result checks and the app's picker are unchanged), and there are THREE outcomes:
//   confirm = the same one (the message goes on with the existing customer); reject = a new customer (as spoken); correct = neither: say the right name (the original message is processed again with it) or drop it.
// What this pins: the question and its candidates; each outcome; that nothing is written before the answer; that an exact name (any case) and a lookup are never asked; the failure paths; NAME_GUARD=off restores the old behaviour.
const path = require('path'), fs = require('fs');

module.exports = async function runNameGuardTests({ check, srcDir }) {
  const workerDir = path.join(srcDir, '..');
  const harness = require('./harness.js'), fns = await harness.loadFunctions(workerDir);
  const userOf = (input) => input.messages.filter((m) => m.role === 'user').pop().content;
  const SPLIT = { match: /Find genuinely SEPARATE topics and split/, reply: (input) => [userOf(input)] };
  const READ = (o) => ({ match: /Extract structured facts from a tradesperson's message/, reply: { ...harness.EXTRACTION_DEFAULTS, ...o } });
  const PAY = (name) => READ({ intent: 'payment', customer_name: name, amount: 500 });
  const seed = (...names) => (db) => { const ins = db.prepare('INSERT INTO customers (name) VALUES (?)'); for (const n of names) ins.run(n); };
  const route = (spec) => harness.runRouteCase(fns, workerDir, { env: { BUSINESS_ID: 'acme-co' }, role: 'owner', ...spec });
  const say = (text, ai, seeds, extra = {}) => route({ name: text.slice(0, 40), method: 'POST', path: '/messages/text', body: { text }, ai, seed: seed(...seeds), ...extra });
  const post = (p, body) => ({ method: 'POST', path: p, body });
  const asked = (r) => r.result && r.result.body && r.result.body.pendingActionType === 'ambiguous_person';
  const Q1 = /sounds like an existing customer, "Jan Pieter Botha" — is this the same one, a new customer, or did I hear the name wrong\? \(action #\d+\)/;
  const customersAdded = (r) => (r.writes.customers && (r.writes.customers.added || r.writes.customers.inserted || r.writes.customers)) || null;
  const SAID = 'Jan Hendrik Botha paid R500';

  // ---- the question ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  { const r = await say(SAID, [SPLIT, PAY('Jan Hendrik Botha')], ['Jan Pieter Botha']);
    check(r.threw === null && r.result.status === 200 && asked(r) && Q1.test(r.result.body.message), 'a name that only partly matches an existing customer is ASKED, with all three ways out in the question (same one, a new customer, did I hear the name wrong): ' + String(r.threw || r.result.body.message).slice(0, 150));
    check(JSON.stringify(r.result.body.pendingCandidates) === JSON.stringify([{ id: 1, name: 'Jan Pieter Botha' }]), 'the candidate is the existing customer, with its id (the app\'s picker reads pendingCandidates)');
    check(!r.writes.customers && !r.writes.payments && !r.writes.people, 'NOTHING is written before the answer: no new customer, no person, no payment (' + Object.keys(r.writes).join(',') + ')'); }
  { const r = await say('Jan Hendrik Botha: measure the lounge', [SPLIT, READ({ intent: 'work_observation', customer_name: 'Jan Hendrik Botha' })], ['Jan Pieter Botha']);
    check(r.threw === null && asked(r) && !r.writes.job_scopes && !r.writes.customers, 'a job scope or measurement (which is NOT held for confirmation) is asked about too, and nothing is written until it is answered'); }
  { const r = await say(SAID, [SPLIT, PAY('Jan Hendrik Botha')], ['Jan Pieter Botha', 'Jan Willem Botha']);
    check(asked(r) && /could be more than one customer already on file — which one is it, a new customer, or did I hear the name wrong\? \(action #\d+\)/.test(r.result.body.message) && r.result.body.pendingCandidates.length === 2, 'several near matches: a numbered choice of them, still with the two other ways out'); }
  { const r = await say('Bon paid R500', [SPLIT, PAY('Bon')], ['Bon Hotel Empangeni', 'Bond Empangeni']);
    check(asked(r) && JSON.stringify(r.result.body.pendingCandidates.map((c) => c.name)) === JSON.stringify(['Bon Hotel Empangeni']), 'a single name matches whole WORDS only: "Bon" offers "Bon Hotel Empangeni", not "Bond Empangeni"'); }

  // ---- when it must NOT ask ------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  { const r = await say('jan  pieter botha paid R500', [SPLIT, PAY('jan  pieter botha')], ['Jan Pieter Botha']);
    check(r.threw === null && !asked(r) && /Payment noted for Jan Pieter Botha of R500 — needs your confirmation/.test(r.result.body.message), 'the same name in another case or with stray spaces is the same customer: no question, the money action is held as before'); }
  { const r = await say('Jenny paid R500', [SPLIT, PAY('Jenny')], ['Jenny Hawke', 'Jennys', 'Jenny']);
    check(!asked(r) && /Payment noted for /.test(r.result.body.message), 'a customer that exists under exactly the spoken name is never asked about, even when similar names exist (which of them the payment goes to is the existing behaviour and a separate finding)'); }
  { const r = await say('Thabo Mokoena paid R500', [SPLIT, PAY('Thabo Mokoena')], ['Jan Pieter Botha']);
    check(!asked(r) && /Payment noted for Thabo Mokoena/.test(r.result.body.message), 'a name that matches nothing is a new customer with no question'); }
  { const r = await say('How much does Jan Hendrik Botha owe?', [SPLIT, READ({ intent: 'lookup', query_scope: 'customer', customer_name: 'Jan Hendrik Botha' })], ['Jan Pieter Botha']);
    check(r.threw === null && !asked(r) && !r.writes.customers, 'a lookup is never asked (it only finds, it writes nothing)'); }
  { const r = await say(SAID, [SPLIT, PAY('Jan Hendrik Botha')], ['Jan Pieter Botha'], { env: { BUSINESS_ID: 'acme-co', NAME_GUARD: 'off' } });
    check(!asked(r) && /Payment noted for Jan Pieter Botha of R500/.test(r.result.body.message), 'NAME_GUARD=off restores the old behaviour exactly (the silent match)'); }

  // ---- the three outcomes ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  { const r = await say(SAID, [SPLIT, PAY('Jan Hendrik Botha')], ['Jan Pieter Botha'], { before: [post('/messages/text', { text: SAID })], method: 'POST', path: '/actions/1/confirm', body: {} });
    check(r.threw === null && r.result.body.status === 'confirmed' && /Payment noted for Jan Pieter Botha of R500 — needs your confirmation \(action #\d+\)/.test(r.result.body.message) && !r.writes.customers, 'THE SAME ONE: the message goes on with the existing customer, held for confirmation as any payment is, and no new customer is made (' + String(r.threw || JSON.stringify(r.result.body)).slice(0, 120) + ')'); }
  { const r = await say(SAID, [SPLIT, PAY('Jan Hendrik Botha')], ['Jan Pieter Botha'], { before: [post('/messages/text', { text: SAID })], method: 'POST', path: '/actions/1/reject', body: {} });
    check(r.threw === null && r.result.body.status === 'rejected_as_new_person' && /Payment noted for Jan Hendrik Botha of R500/.test(r.result.body.message) && !!r.writes.customers, 'A NEW CUSTOMER: the spoken name is created as its own customer and the message goes on with it (' + String(r.threw || JSON.stringify(r.result.body)).slice(0, 120) + ')'); }
  { const mk = (body, extra = []) => say(SAID, [SPLIT, PAY('Jan Hendrik Botha')], ['Jan Pieter Botha'], { before: [post('/messages/text', { text: SAID }), ...extra], method: 'POST', path: '/actions/1/correct', body });
    const a = await mk({ name: 'Jan Pieter Botha' });
    check(a.threw === null && a.result.body.status === 'corrected' && /Payment noted for Jan Pieter Botha of R500/.test(a.result.body.message) && !a.writes.customers, 'NEITHER, I MEANT AN EXISTING ONE: the corrected name is used and the original message is processed again with it');
    const b = await mk({ name: 'Thabo Mokoena' });
    check(b.result.body.status === 'corrected' && /Payment noted for Thabo Mokoena of R500/.test(b.result.body.message) && !!b.writes.customers, 'NEITHER, IT IS SOMEONE NEW: the corrected name becomes a new customer and the message goes on');
    const c = await mk({ name: 'Jan Peter Botha' });
    check(c.result.body.status === 'corrected' && asked(c) && /Jan Pieter Botha/.test(c.result.body.message), 'a correction that is itself a near match is asked about again (never silently matched)');
    const d = await mk({ discard: true });
    check(d.result.status === 200 && /nothing was recorded/i.test(d.result.body.message) && /Jan Hendrik Botha paid R500/.test(d.result.body.message) && !d.writes.customers && !d.writes.payments, 'NEITHER, FORGET IT: nothing is recorded, and the reply says what was not acted on so it can be said again');
    const e = await say(SAID, [SPLIT, PAY('Jan Hendrik Botha')], ['Jan Pieter Botha'], { before: [post('/messages/text', { text: SAID }), post('/actions/1/correct', { discard: true })], method: 'POST', path: '/actions/1/correct', body: { name: 'Thabo Mokoena' } });
    check(e.result.status === 409 && e.result.body.error === 'action already rejected', 'an action already answered cannot be answered again: 409, "action already rejected" (' + JSON.stringify(e.result.body) + ')'); }
  { const bad = [{}, { name: '' }, { name: '   ' }, { name: 'x' }, { name: 'a'.repeat(200) }, { name: 12 }, { name: 'Jan; DROP TABLE customers' }, { discard: 'yes' }];
    const got = []; for (const body of bad) { const r = await say(SAID, [SPLIT, PAY('Jan Hendrik Botha')], ['Jan Pieter Botha'], { before: [post('/messages/text', { text: SAID })], method: 'POST', path: '/actions/1/correct', body }); got.push([JSON.stringify(body).slice(0, 30), r.result.status]); }
    check(got.every(([, s]) => s === 400), 'a correction that is not a usable name (nothing, blank, one letter, too long, not text, code) is refused with 400 and the question stays open: ' + JSON.stringify(got.filter(([, s]) => s !== 400)));
    const still = await say(SAID, [SPLIT, PAY('Jan Hendrik Botha')], ['Jan Pieter Botha'], { before: [post('/messages/text', { text: SAID }), post('/actions/1/correct', { name: '' })], method: 'POST', path: '/actions/1/confirm', body: {} });
    check(still.result.status === 200 && still.result.body.status === 'confirmed', 'after a refused correction the question is still open and can be answered'); }
  { const wrongType = await route({ name: 'wrong type', method: 'POST', path: '/messages/text', body: { text: 'Jenny paid R500' }, ai: [SPLIT, PAY('Jenny')], seed: seed('Jenny Hawke'), before: [] });
    const r = await route({ name: 'correct a payment', method: 'POST', path: '/actions/1/correct', body: { name: 'Thabo Mokoena' }, ai: [SPLIT, PAY('Jan Pieter Botha')], seed: seed('Jan Pieter Botha'), before: [post('/messages/text', { text: 'Jan Pieter Botha paid R500' })] });
    check(r.result.status === 400 && /only a customer name question/.test(r.result.body.error || ''), 'only a customer name question can be corrected: a held payment is refused with 400 and left as it was (' + r.result.status + ' ' + JSON.stringify(r.result.body).slice(0, 80) + ')'); }

  { const two = ['Jan Pieter Botha', 'Jan Willem Botha'];
    const r = await say(SAID, [SPLIT, PAY('Jan Hendrik Botha')], two, { before: [post('/messages/text', { text: SAID })], method: 'POST', path: '/actions/1/correct', body: { name: 'jan willem botha' } });
    check(r.result.body.status === 'corrected' && /Payment noted for Jan Willem Botha of R500/.test(r.result.body.message) && !r.writes.customers, 'a correction that is exactly the SECOND of two similar customers goes to THAT one (carried by id, never re-matched by first and last word)'); }

  // ---- the Office's OLDER near-match question (the canonical people check) offers the same three ways out ---------------------------------------------------------------------------------------
  // The real-model smoke on staging (2026-10-29) found it: after one near match was made a NEW customer (a person record exists), the next similar name is caught by the people check, whose question had two options and refused "correct".
  { const PAYN = { match: /Extract structured facts from a tradesperson's message/, reply: (input) => ({ ...harness.EXTRACTION_DEFAULTS, intent: 'payment', amount: 500, customer_name: userOf(input).replace(/ paid.*$/, '') }) };
    const A = 'Jan Hendrik Botha paid R500', B = 'Jan Willem Botha paid R500';
    const first = [post('/messages/text', { text: A }), post('/actions/1/reject', {})];
    const q = await say(B, [SPLIT, PAYN], ['Jan Pieter Botha'], { before: first });
    check(asked(q) && /is this the same one, a new customer, or did I hear the name wrong\? \(action #\d+\)/.test(q.result.body.message) || /could be more than one (?:customer|person) already on file — which one is it, a new customer, or did I hear the name wrong\? \(action #\d+\)/.test(q.result.body.message), 'once a person record exists, the people check asks the SAME three-way question (the real model smoke saw the old two-way one): ' + String(q.result.body.message).slice(0, 170));
    const fix = await say(B, [SPLIT, PAYN], ['Jan Pieter Botha'], { before: [...first, post('/messages/text', { text: B })], method: 'POST', path: '/actions/3/correct', body: { name: 'Jan Hendrik Botha' } });
    check(fix.result.status === 200 && fix.result.body.status === 'corrected' && /Payment noted for Jan Hendrik Botha of R500/.test(fix.result.body.message), 'and "correct" works on it too: the right name, an existing customer, by id (' + fix.result.status + ' ' + String(fix.result.body.message || JSON.stringify(fix.result.body)).slice(0, 100) + ')');
    const forget = await say(B, [SPLIT, PAYN], ['Jan Pieter Botha'], { before: [...first, post('/messages/text', { text: B })], method: 'POST', path: '/actions/3/correct', body: { discard: true } });
    check(forget.result.status === 200 && /nothing was recorded/i.test(forget.result.body.message), 'and so does "forget it"'); }

  // ---- several candidates -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  { const two = ['Jan Pieter Botha', 'Jan Willem Botha'], first = [post('/messages/text', { text: SAID })];
    const none = await say(SAID, [SPLIT, PAY('Jan Hendrik Botha')], two, { before: first, method: 'POST', path: '/actions/1/confirm', body: {} });
    check(none.result.status === 400 && Array.isArray(none.result.body.candidates) && none.result.body.candidates.length === 2, 'with several candidates, "the same one" needs to say which (400 with the list), as the existing person picker does');
    const pick = await say(SAID, [SPLIT, PAY('Jan Hendrik Botha')], two, { before: first, method: 'POST', path: '/actions/1/confirm', body: { personId: 2 } });
    check(pick.result.status === 200 && /Payment noted for Jan Willem Botha of R500/.test(pick.result.body.message), 'and the chosen one is used');
    const wrong = await say(SAID, [SPLIT, PAY('Jan Hendrik Botha')], two, { before: first, method: 'POST', path: '/actions/1/confirm', body: { personId: 99 } });
    check(wrong.result.status === 400, 'a choice that is not one of the candidates is refused'); }

  // ---- the source -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const read = (f) => fs.readFileSync(path.join(srcDir, f), 'utf8');
  check(/\(confirm\|reject\|correct\|edit-field\)/.test(read('auth.ts')), 'the correct route is authorized per hold type exactly like confirm and reject (the same ACTION_ROUTE rule)');
  check(/NAME_GUARD/.test(read('intents/opening.ts')) && /findLooseCustomerMatches/.test(read('intents/opening.ts')) && /export async function findLooseCustomerMatches/.test(read('identity.ts')), 'the near-match question is raised where customers are resolved, from one read-only matcher in identity.ts, behind the NAME_GUARD switch');
  const lm = read('identity.ts'), body = lm.slice(lm.indexOf('export async function findLooseCustomerMatches'), lm.indexOf('export async function findLooseCustomerMatches') + 1800);
  check(!/INSERT|UPDATE|DELETE/.test(body.split('\n').slice(0, 40).join('\n')), 'the matcher only reads');
};
