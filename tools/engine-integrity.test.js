// Engine integrity verifier, Task 2 (worker/src/engine/integrity.ts, branch engine-phase1). TESTS FIRST. Every finding the verifier can report has a DEFINED INVARIANT behind it, and each is tested here three ways:
// the clean business reports nothing, and a deliberately corrupted business reports EXACTLY the code for that invariant (not merely "not ok"). The corruptions are raw SQL, the thing the database itself does not stop.
//   THE EVENT MODEL  (integrity.ts EVENT_MODEL): eight event types each create exactly one fact row (party.created also creates that party's roles); operation.executed creates NO fact; any other type is NOT MODELLED.
//                    Both directions are checked: an event whose fact has been deleted (event_without_fact), a fact with no event or the wrong one (fact_wrong_event), and a fact twice over (event_multiple_facts).
//   WHAT A CLEAN RESULT MEANS: no violation was found among the invariants this verifier checks. It is NOT proof that the data is authentic or unaltered: a coordinated edit of a fact and its event, the deletion of both, a swap
//                    of two document numbers and an edit of a document's terms are NOT detected, and the last four tests here PIN that, so the limitation is evidence and not only prose.
// Not here: triggers, schema changes, scheduling, the ownership-boundary test, cross-business isolation (Task 3).
const fs = require('fs'), path = require('path');
const kit = require('./engine-kit.js');

module.exports = kit.guard('engine integrity', async ({ check }) => {
  const eng = kit.loadEngine();
  check(Boolean(eng && eng.verifyIntegrity && eng.EVENT_MODEL), 'the engine exposes verifyIntegrity and the EVENT_MODEL it checks against');
  if (!eng || !eng.EVENT_MODEL) return;
  const { facts } = eng;
  const CTX = { actorEmail: 'accountant@example.com', contract: 'test', contractVersion: 1 };
  const lines = (price) => [{ description: 'Work', quantityMilli: 2000, unit: 'm2', unitPriceMinor: price, taxBp: 1500 }];

  // one business with every kind of fact in it, built ONLY through the engine's own write path
  const baseline = async () => {
    const w = kit.makeWorld(); w.configure({ mode: 'engine', available: kit.ALL_CAPABILITIES });
    const a = (await facts.recordParty(w.env, { kind: 'person', name: 'Mokoena', roles: ['customer'] }, CTX)).id;
    const b = (await facts.recordParty(w.env, { kind: 'organisation', name: 'Patel Builders', roles: ['customer'] }, CTX)).id;
    const lonely = (await facts.recordParty(w.env, { kind: 'person', name: 'Lonely', roles: [] }, CTX)).id;
    const inv1 = await facts.recordDocument(w.env, { kind: 'invoice', direction: 'sell', partyId: a, currency: 'ZAR', issuedOn: '2026-10-01', reference: 'PO-77', lines: lines(150000) }, CTX);   // gross 345000
    const inv2 = await facts.recordDocument(w.env, { kind: 'invoice', direction: 'sell', partyId: b, currency: 'ZAR', issuedOn: '2026-10-02', lines: lines(10000) }, CTX);                      // gross 23000
    const pay1 = await facts.recordPayment(w.env, { direction: 'in', partyId: a, amountMinor: 200000, currency: 'ZAR', occurredOn: '2026-10-20', allocations: [{ documentId: inv1.id, amountMinor: 150000 }] }, CTX);
    const mv2 = await facts.recordMovement(w.env, { direction: 'in', partyId: a, amountMinor: 5000, currency: 'ZAR', occurredOn: '2026-10-21' }, CTX);   // a payment nothing depends on
    const wrong = await facts.recordPayment(w.env, { direction: 'in', partyId: a, amountMinor: 23000, currency: 'ZAR', occurredOn: '2026-10-22', allocations: [{ documentId: inv2.id, amountMinor: 23000 }] }, CTX);
    const fix = await facts.correctMovement(w.env, { movementId: wrong.movementId, reason: 'wrong customer', replacement: { partyId: b, allocations: [{ documentId: inv2.id, amountMinor: 23000 }] } }, CTX);
    const doc3 = await facts.recordDocument(w.env, { kind: 'invoice', direction: 'sell', partyId: a, currency: 'ZAR', issuedOn: '2026-11-01', lines: lines(1000) }, CTX);   // the last invoice, nothing depends on it
    return { w, db: w.db, a, b, lonely, inv1, inv2, pay1, mv2, wrong, fix, doc3 };
  };
  const rawEvent = (x, type, payload) => Number(x.db.prepare('INSERT INTO eng_event (type, payload_json) VALUES (?, ?) RETURNING id').get(type, typeof payload === 'string' ? payload : JSON.stringify(payload)).id);
  const eventOf = (x, table, id) => Number(x.db.prepare(`SELECT event_id FROM ${table} WHERE id = ?`).get(id).event_id);
  const fkOff = (x, fn) => { x.db.exec('PRAGMA foreign_keys = OFF'); try { fn(); } finally { x.db.exec('PRAGMA foreign_keys = ON'); } };
  const codes = (r) => [...new Set(r.problems.map((p) => p.code))].sort();

  const clean = await baseline();
  const r0 = await eng.verifyIntegrity(clean.w.env);
  check(r0.ok === true && r0.problems.length === 0 && Array.isArray(r0.warnings) && r0.warnings.length === 0, 'CONTROL: a business built through the engine, with parties, documents, payments, a correction and reversals, reports nothing: ' + JSON.stringify(r0.problems).slice(0, 120));

  // `exact` = the corruption must produce EXACTLY these codes, so a finding is attributable to one invariant
  const detect = async (label, mutate, expected, { exact = true } = {}) => {
    const x = await baseline(); await mutate(x);
    const r = await eng.verifyIntegrity(x.w.env), got = codes(r);
    const ok = exact ? JSON.stringify(got) === JSON.stringify([...expected].sort()) : expected.every((c) => got.includes(c));
    check(!r.ok && ok, `${label} -> ${exact ? 'exactly ' : 'includes '}${expected.join(', ')} (got: ${got.join(', ') || 'nothing'})`);
  };

  // ---- THE EVENT MODEL, event to fact: a fact that was DELETED while its event survived ------------------------------------------------------------------------------------------------------------------
  await detect('a payment nothing depends on is deleted (its payment.recorded event survives)', (x) => x.db.prepare('DELETE FROM eng_money_movement WHERE id = ?').run(x.mv2.id), ['event_without_fact']);
  await detect('an allocation is deleted (its payment.allocated event survives)', (x) => x.db.prepare('DELETE FROM eng_allocation WHERE id = ?').run(x.pay1.allocationIds[0]), ['event_without_fact']);
  await detect('a reversal row is deleted: a payment is silently "un-reversed" (its payment.reversed event survives)', (x) => x.db.prepare('DELETE FROM eng_reversal WHERE movement_id = ?').run(x.wrong.movementId), ['event_without_fact']);
  await detect('a party nothing depends on is deleted (its party.created event survives)', (x) => x.db.prepare('DELETE FROM eng_party WHERE id = ?').run(x.lonely), ['event_without_fact']);
  await detect('a document is deleted with its lines and number (its document.issued event survives)', (x) => { x.db.prepare('DELETE FROM eng_document_number WHERE document_id = ?').run(x.doc3.id); x.db.prepare('DELETE FROM eng_document_line WHERE document_id = ?').run(x.doc3.id); x.db.prepare('DELETE FROM eng_document WHERE id = ?').run(x.doc3.id); }, ['event_without_fact']);
  await detect('a party\'s role row is deleted (party.created recorded the roles)', (x) => x.db.prepare('DELETE FROM eng_party_role WHERE party_id = ?').run(x.a), ['fact_changed']);

  // ---- fact to event: the wrong event, a second fact for one event ---------------------------------------------------------------------------------------------------------------------------------------
  await detect('two payments claim the same event', (x) => x.db.prepare('INSERT INTO eng_money_movement (direction, party_id, amount_minor, currency, occurred_on, method, event_id) SELECT direction, party_id, amount_minor, currency, occurred_on, method, event_id FROM eng_money_movement WHERE id = ?').run(x.mv2.id), ['event_multiple_facts']);
  await detect('a payment points at an allocation\'s event (the wrong kind of event)', (x) => x.db.prepare('UPDATE eng_money_movement SET event_id = ? WHERE id = ?').run(eventOf(x, 'eng_allocation', x.pay1.allocationIds[0]), x.mv2.id), ['fact_wrong_event'], { exact: false });
  await detect('a document points at a payment\'s event', (x) => x.db.prepare('UPDATE eng_document SET event_id = ? WHERE id = ?').run(eventOf(x, 'eng_money_movement', x.mv2.id), x.doc3.id), ['fact_wrong_event'], { exact: false });
  await detect('a reversal row points at the wrong kind of event', (x) => x.db.prepare('UPDATE eng_reversal SET event_id = ? WHERE movement_id = ?').run(eventOf(x, 'eng_money_movement', x.mv2.id), x.wrong.movementId), ['fact_wrong_event'], { exact: false });
  await detect('an operation.executed event has a fact hanging off it (that event creates none)', (x) => { const e = rawEvent(x, 'operation.executed', {}); x.db.prepare('UPDATE eng_money_movement SET event_id = ? WHERE id = ?').run(e, x.mv2.id); }, ['fact_wrong_event'], { exact: false });

  // ---- edits against the snapshot: the cases that were never tested in isolation -----------------------------------------------------------------------------------------------------------------------
  await detect('a party is renamed', (x) => x.db.prepare("UPDATE eng_party SET name = 'Renamed' WHERE id = ?").run(x.a), ['fact_changed']);
  await detect('a party\'s kind is changed', (x) => x.db.prepare("UPDATE eng_party SET kind = 'organisation' WHERE id = ?").run(x.a), ['fact_changed']);
  await detect('an allocation\'s amount is edited (reduced, so conservation still holds)', (x) => x.db.prepare('UPDATE eng_allocation SET amount_minor = 100000 WHERE id = ?').run(x.pay1.allocationIds[0]), ['fact_changed']);
  await detect('a document header is edited (issue date)', (x) => x.db.prepare("UPDATE eng_document SET issued_on = '2026-01-01' WHERE id = ?").run(x.inv1.id), ['fact_changed']);
  await detect('a document line is edited (unit price raised)', (x) => x.db.prepare('UPDATE eng_document_line SET unit_price_minor = unit_price_minor + 1 WHERE document_id = ?').run(x.inv1.id), ['fact_changed']);
  await detect('a document\'s reference is edited (recorded in its event, newly compared)', (x) => x.db.prepare("UPDATE eng_document SET reference = 'TAMPERED' WHERE id = ?").run(x.inv1.id), ['fact_changed']);
  await detect('a payment is edited (control: the case that was already tested)', (x) => x.db.prepare('UPDATE eng_money_movement SET amount_minor = 999999 WHERE id = ?').run(x.mv2.id), ['fact_changed']);

  await detect('a payment points at an event that does not exist (foreign keys off for the corruption)', (x) => fkOff(x, () => x.db.prepare('UPDATE eng_money_movement SET event_id = 99999 WHERE id = ?').run(x.mv2.id)), ['fact_wrong_event'], { exact: false });
  await detect('a party role is carried by a different party\'s event', (x) => x.db.prepare('UPDATE eng_party_role SET event_id = ? WHERE party_id = ?').run(eventOf(x, 'eng_party', x.b), x.a), ['fact_wrong_event'], { exact: false });
  await detect('a payment\'s direction contradicts its event (payment.recorded means money IN)', (x) => x.db.prepare("UPDATE eng_money_movement SET direction = 'out' WHERE id = ?").run(x.mv2.id), ['fact_wrong_event'], { exact: false });
  await detect('a document\'s number row is deleted (the document is left without a number)', (x) => x.db.prepare('DELETE FROM eng_document_number WHERE document_id = ?').run(x.doc3.id), ['number_gap']);

  // ---- reversal rows against their events --------------------------------------------------------------------------------------------------------------------------------------------------------------------
  await detect('a reversal\'s reason is edited', (x) => x.db.prepare("UPDATE eng_reversal SET reason = 'tampered' WHERE movement_id = ?").run(x.wrong.movementId), ['reversal_mismatch']);
  await detect('a reversal is re-pointed at a different payment', (x) => x.db.prepare('UPDATE eng_reversal SET movement_id = ? WHERE movement_id = ?').run(x.mv2.id, x.wrong.movementId), ['reversal_mismatch'], { exact: false });

  // ---- conservation, orphans: previously asserted only loosely or not at all ----------------------------------------------------------------------------------------------------------------------------------
  await detect('a DOCUMENT is over-allocated by an allocation that has its own consistent event (payments stay within their amounts)', async (x) => {
    const big = await facts.recordMovement(x.w.env, { direction: 'in', partyId: x.a, amountMinor: 900000, currency: 'ZAR', occurredOn: '2026-11-02' }, CTX);
    const e = rawEvent(x, 'payment.allocated', { movementId: big.id, documentId: x.inv1.id, amountMinor: 250000 });
    x.db.prepare('INSERT INTO eng_allocation (movement_id, document_id, amount_minor, event_id) VALUES (?, ?, 250000, ?)').run(big.id, x.inv1.id, e);   // 150000 + 250000 > 345000
  }, ['over_allocated']);
  await detect('a PAYMENT is over-allocated by an allocation that has its own consistent event', (x) => {
    const e = rawEvent(x, 'payment.allocated', { movementId: x.mv2.id, documentId: x.inv1.id, amountMinor: 6000 });
    x.db.prepare('INSERT INTO eng_allocation (movement_id, document_id, amount_minor, event_id) VALUES (?, ?, 6000, ?)').run(x.mv2.id, x.inv1.id, e);   // 6000 > 5000
  }, ['over_allocated']);
  await detect('an allocation points at a document that does not exist (foreign keys off for the corruption)', (x) => {
    const e = rawEvent(x, 'payment.allocated', { movementId: x.mv2.id, documentId: 99999, amountMinor: 100 });
    fkOff(x, () => x.db.prepare('INSERT INTO eng_allocation (movement_id, document_id, amount_minor, event_id) VALUES (?, 99999, 100, ?)').run(x.mv2.id, e));
  }, ['orphan']);
  await detect('an invoice number is changed, leaving a hole (asserted by CODE now, not just "not ok")', (x) => x.db.prepare('UPDATE eng_document_number SET number = 9 WHERE document_id = ?').run(x.doc3.id), ['number_gap']);

  // ---- malformed and unknown events -----------------------------------------------------------------------------------------------------------------------------------------------------------------------
  await detect('a fact-creating event\'s payload is not JSON', (x) => x.db.prepare("UPDATE eng_event SET payload_json = 'not json' WHERE id = ?").run(eventOf(x, 'eng_money_movement', x.mv2.id)), ['event_payload_malformed'], { exact: false });
  await detect('an operation.executed event\'s payload is not a JSON object', (x) => rawEvent(x, 'operation.executed', '{broken'), ['event_payload_malformed']);
  const unknown = await baseline(); rawEvent(unknown, 'mystery.thing', {});
  const ru = await eng.verifyIntegrity(unknown.w.env);
  check(ru.ok === true && ru.problems.length === 0 && ru.warnings.length === 1 && ru.warnings[0].code === 'event_type_not_modelled', 'an event type the model does not know is a WARNING (event_type_not_modelled), not a violation: it does not flip ok (code rolled back from newer code, or a type nobody modelled yet)');
  const nonfact = await baseline(); rawEvent(nonfact, 'operation.executed', { movementId: 1 });
  const rn = await eng.verifyIntegrity(nonfact.w.env);
  check(rn.ok === true && rn.warnings.length === 0, 'a legitimate non-fact event (operation.executed) needs no fact: clean, and no warning');

  // ---- the model cannot drift: every event type the code writes is in it ------------------------------------------------------------------------------------------------------------------------------------
  const factsSrc = fs.readFileSync(path.join(kit.workerDir, 'src', 'engine', 'facts.ts'), 'utf8');
  const written = new Set([...factsSrc.matchAll(/appendEvent\(tx, ([^;]+?), ctx,/g)].flatMap((m) => [...m[1].matchAll(/"([a-z_]+\.[a-z_]+)"/g)].map((q) => q[1])));
  written.add('operation.executed');   // written by capability-contract.ts
  const modelled = Object.keys(eng.EVENT_MODEL);
  check(written.size >= 9 && [...written].every((t) => modelled.includes(t)), `every event type the engine writes (${[...written].sort().join(', ')}) is in the EVENT_MODEL: adding an event type without modelling it FAILS here`);
  check(modelled.every((t) => written.has(t)), 'and the model lists no event type the engine never writes');

  // ---- WHAT A CLEAN RESULT DOES NOT MEAN: the limitations, pinned as evidence ----------------------------------------------------------------------------------------------------------------------------
  const coordinated = await baseline();
  coordinated.db.prepare('UPDATE eng_money_movement SET amount_minor = 6000 WHERE id = ?').run(coordinated.mv2.id);
  coordinated.db.prepare("UPDATE eng_event SET payload_json = json_set(payload_json, '$.amountMinor', 6000) WHERE id = ?").run(eventOf(coordinated, 'eng_money_movement', coordinated.mv2.id));
  check((await eng.verifyIntegrity(coordinated.w.env)).ok === true, 'KNOWN LIMITATION, pinned: a COORDINATED edit of a fact and its event is NOT detected (neither is independently protected): a clean result is not proof of authenticity');
  const bothGone = await baseline(); const ev2 = eventOf(bothGone, 'eng_money_movement', bothGone.mv2.id);
  bothGone.db.prepare('DELETE FROM eng_money_movement WHERE id = ?').run(bothGone.mv2.id); bothGone.db.prepare('DELETE FROM eng_event WHERE id = ?').run(ev2);
  check((await eng.verifyIntegrity(bothGone.w.env)).ok === true, 'KNOWN LIMITATION, pinned: deleting a fact AND its event is NOT detected');
  const swapped = await baseline();
  const nums = swapped.db.prepare("SELECT document_id AS d, number AS n FROM eng_document_number WHERE kind = 'invoice' AND number IN (1, 2) ORDER BY number").all();
  swapped.db.prepare('UPDATE eng_document_number SET number = 999 WHERE document_id = ?').run(nums[0].d); swapped.db.prepare('UPDATE eng_document_number SET number = ? WHERE document_id = ?').run(nums[0].n, nums[1].d); swapped.db.prepare('UPDATE eng_document_number SET number = ? WHERE document_id = ?').run(nums[1].n, nums[0].d);
  check((await eng.verifyIntegrity(swapped.w.env)).ok === true, 'KNOWN LIMITATION, pinned: swapping two documents\' numbers is NOT detected (the number is not in the event, and there is no gap)');
  const terms = await baseline(); terms.db.prepare("UPDATE eng_document SET terms_json = '{\"tampered\":true}' WHERE id = ?").run(terms.inv1.id);
  check((await eng.verifyIntegrity(terms.w.env)).ok === true, 'KNOWN LIMITATION, pinned: editing a document\'s terms is NOT detected (they are not recorded in the event)');
});

if (require.main === module) kit.standalone(module.exports);
