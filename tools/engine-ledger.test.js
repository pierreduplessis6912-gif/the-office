// Engine ledger (worker/src/engine, branch engine-phase1). TESTS FIRST: what the engine's facts, derivations and corrections must guarantee, before they exist.
//   MONEY      integer arithmetic only: minor units, thousandths, basis points, half-up rounding per line, exact above 2^53 (no floats anywhere)
//   FACTS      recorded through ONE path that only inserts; no update or delete of a fact exists in the code (scanned), and each fact's event carries a snapshot of it so an edit made behind the engine's back is DETECTED
//   DERIVED    what is outstanding is computed in one place from effective facts (a reversed fact is not effective, and neither is what hangs off it)
//   CORRECTED  a mistake is reversed and, if need be, replaced: nothing is edited, the trail shows every step, a fact with live dependents cannot be reversed alone, nothing is reversed twice
//   ATOMIC     every operation is all or nothing: a failure injected at EVERY write leaves the business exactly as it was, and numbering has no gap
// Expected state when first committed: RED (worker/src/engine does not exist).
const fs = require('fs'), path = require('path');
const kit = require('./engine-kit.js');

module.exports = kit.guard('engine ledger', async ({ check }) => {
  const eng = kit.loadEngine();
  check(Boolean(eng), 'worker/src/engine/index.ts exists and builds (the engine module: money, facts, ledger, integrity)');
  if (!eng) return;
  const { money, facts, ledger, EngineError } = eng;
  const codeOf = async (fn) => { try { await fn(); return null; } catch (e) { return e && e.code ? e.code : 'threw:' + String(e && e.message).slice(0, 80); } };
  const CTX = { actorEmail: 'accountant@example.com', contract: 'test', contractVersion: 1 };

  // ---- MONEY ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  check(money.lineNetMinor(1000, 10000) === 10000, '1.000 unit at R100.00 is R100.00');
  check(money.lineNetMinor(2500, 4000) === 10000, '2.500 units at R40.00 is R100.00');
  check(money.lineNetMinor(1500, 333) === 500, 'rounding is half up: 1.500 x R3.33 = R4.995 is R5.00');
  check(money.lineNetMinor(333, 1000) === 333, '0.333 x R10.00 is R3.33');
  check(money.lineTaxMinor(10000, 1500) === 1500, '15% of R100.00 is R15.00');
  check(money.lineTaxMinor(10, 1500) === 2, 'tax rounds half up: 15% of 10c is 1.5c, so 2c');
  check(money.lineTaxMinor(333, 1500) === 50, '15% of R3.33 is 49.95c, so 50c');
  const t = money.documentTotals([{ quantityMilli: 1000, unitPriceMinor: 10000, taxBp: 1500 }, { quantityMilli: 2500, unitPriceMinor: 4000, taxBp: 1500 }, { quantityMilli: 1000, unitPriceMinor: 0, taxBp: 1500 }]);
  check(t.netMinor === 20000 && t.taxMinor === 3000 && t.grossMinor === 23000, 'a document totals its lines: tax is rounded per line, then added (net R200.00, tax R30.00, gross R230.00; a free line adds nothing)');
  check(money.lineNetMinor(1000000000, 100000000) === 100000000000000, 'exact beyond 2^53: 1,000,000.000 units at R1,000,000.00 is exactly R1,000,000,000,000.00 (no floating point)');
  check((await codeOf(() => money.lineNetMinor(9000000000000, 9000000000000))) === 'amount_out_of_range', 'a result that cannot be held exactly is refused, never rounded');
  check((await codeOf(() => money.lineNetMinor(1.5, 100))) === 'invalid_amount', 'a fractional quantity is refused');
  check((await codeOf(() => money.lineNetMinor('1000', 100))) === 'invalid_amount', 'a quantity given as text is refused (SQLite would coerce it; the engine does not)');
  check((await codeOf(() => money.lineNetMinor(1000, -1))) === 'invalid_amount', 'a negative price is refused');
  check((await codeOf(() => money.lineTaxMinor(100, 10001))) === 'invalid_amount', 'tax above 100% is refused');

  // ---- a business to work in -----------------------------------------------------------------------------------------------------------------------------------------------------------------
  const world = async () => {
    const w = kit.makeWorld();
    w.configure({ currency: 'ZAR' });
    const mokoena = (await facts.recordParty(w.env, { kind: 'person', name: 'Mokoena', roles: ['customer'] }, CTX)).id;
    const patel = (await facts.recordParty(w.env, { kind: 'organisation', name: 'Patel Builders', roles: ['customer'] }, CTX)).id;
    const lines = [{ description: 'Vinyl plank', quantityMilli: 10000, unit: 'm2', unitPriceMinor: 25000, taxBp: 1500 }, { description: 'Fitting', quantityMilli: 1000, unit: 'job', unitPriceMinor: 50000, taxBp: 1500 }];
    const inv1 = await facts.recordDocument(w.env, { kind: 'invoice', direction: 'sell', partyId: mokoena, currency: 'ZAR', issuedOn: '2026-10-01', lines }, CTX);   // net 300000, tax 45000, gross 345000
    const inv2 = await facts.recordDocument(w.env, { kind: 'invoice', direction: 'sell', partyId: mokoena, currency: 'ZAR', issuedOn: '2026-10-15', lines: [{ description: 'Skirting', quantityMilli: 4000, unit: 'm', unitPriceMinor: 5000, taxBp: 1500 }] }, CTX);   // gross 23000
    return { w, mokoena, patel, inv1, inv2 };
  };
  const { w, mokoena, patel, inv1, inv2 } = await world();
  check(inv1.number === 1 && inv2.number === 2, 'invoices are numbered in sequence, per business (1, 2)');
  check(inv1.totals.grossMinor === 345000 && (await ledger.documentTotals(w.env, inv1.id)).grossMinor === 345000, 'a document\'s total is derived from its lines (R3,450.00)');
  const q = await facts.recordDocument(w.env, { kind: 'quotation', direction: 'sell', partyId: mokoena, currency: 'ZAR', issuedOn: '2026-10-20', lines: [{ description: 'Quote', quantityMilli: 1000, unitPriceMinor: 100, taxBp: 0 }] }, CTX);
  check(q.number === 1, 'each kind numbers on its own: the first quotation is number 1');

  // ---- FACTS: one insert-only path, and what it records ------------------------------------------------------------------------------------------------------------------------------------
  check((await codeOf(() => facts.recordMovement(w.env, { direction: 'in', partyId: mokoena, amountMinor: 1.5, currency: 'ZAR', occurredOn: '2026-11-01' }, CTX))) === 'invalid_amount', 'a movement of fractional minor units is refused by the engine');
  check((await codeOf(() => facts.recordMovement(w.env, { direction: 'in', partyId: mokoena, amountMinor: '500', currency: 'ZAR', occurredOn: '2026-11-01' }, CTX))) === 'invalid_amount', 'a movement given as text is refused by the engine');
  check((await codeOf(() => facts.recordMovement(w.env, { direction: 'in', partyId: mokoena, amountMinor: 500, currency: 'ZAR', occurredOn: '1 November' }, CTX))) === 'invalid_input', 'a date that is not a calendar date is refused');
  check((await codeOf(() => facts.recordMovement(w.env, { direction: 'in', partyId: 99999, amountMinor: 500, currency: 'ZAR', occurredOn: '2026-11-01' }, CTX))) === 'not_found', 'a movement for a party that does not exist is refused');
  const payment = await facts.recordMovement(w.env, { direction: 'in', partyId: mokoena, amountMinor: 200000, currency: 'ZAR', occurredOn: '2026-11-02', method: 'eft' }, CTX);
  const ev = w.db.prepare('SELECT * FROM eng_event WHERE id = ?').get(payment.eventId);
  check(ev.type === 'payment.recorded' && ev.actor_email === 'accountant@example.com' && ev.contract === 'test' && ev.contract_version === 1, 'the movement\'s event records what happened, who did it and under which contract version');
  check(JSON.parse(ev.payload_json).amountMinor === 200000 && JSON.parse(ev.payload_json).partyId === mokoena, 'and carries a snapshot of the fact, so an edit made behind the engine\'s back can be detected');

  const engineDir = path.join(kit.workerDir, 'src', 'engine');
  const sources = fs.readdirSync(engineDir).filter((f) => f.endsWith('.ts')).map((f) => [f, fs.readFileSync(path.join(engineDir, f), 'utf8')]);
  const FACTS = ['eng_event', 'eng_party', 'eng_party_role', 'eng_document', 'eng_document_line', 'eng_document_number', 'eng_money_movement', 'eng_allocation', 'eng_reversal', 'eng_interpretation'];
  check(sameSet(eng.FACT_TABLES, FACTS), 'the engine declares exactly which tables hold facts: ' + FACTS.length + ' (FACT_TABLES)');
  check(sameSet(eng.MUTABLE_TABLES, ['eng_config', 'eng_draft', 'eng_observation']), 'and which three are working state (configuration, drafts, observations): MUTABLE_TABLES');
  const edits = sources.flatMap(([f, text]) => (text.match(new RegExp(`\\b(UPDATE|DELETE\\s+FROM|REPLACE\\s+INTO|INSERT\\s+OR\\s+REPLACE)\\s+(?:INTO\\s+)?"?(${FACTS.join('|')})\\b`, 'gi')) || []).map((m) => `${f}: ${m}`));
  check(edits.length === 0, 'NO code in worker/src/engine updates, deletes or replaces a fact' + (edits.length ? ': ' + edits.join('; ') : ''));
  check(typeof facts.update === 'undefined' && typeof facts.remove === 'undefined' && typeof facts.delete === 'undefined', 'the write path exposes no update or delete');

  // ---- ALLOCATION: conservation -------------------------------------------------------------------------------------------------------------------------------------------------------------
  const a1 = await facts.allocate(w.env, { movementId: payment.id, documentId: inv1.id, amountMinor: 150000 }, CTX);
  check((await ledger.unallocatedForMovement(w.env, payment.id)) === 50000, 'allocating R1,500.00 of a R2,000.00 payment leaves R500.00 unallocated');
  check((await ledger.outstandingForDocument(w.env, inv1.id)) === 195000, 'the invoice\'s outstanding falls to R1,950.00');
  check((await codeOf(() => facts.allocate(w.env, { movementId: payment.id, documentId: inv2.id, amountMinor: 50001 }, CTX))) === 'over_allocated', 'more than the payment still has is refused');
  check((await codeOf(() => facts.allocate(w.env, { movementId: payment.id, documentId: inv2.id, amountMinor: 30000 }, CTX))) === 'over_allocated', 'more than the invoice still owes is refused (R230.00 owed, R300.00 offered)');
  const usd = await facts.recordMovement(w.env, { direction: 'in', partyId: mokoena, amountMinor: 1000, currency: 'USD', occurredOn: '2026-11-02' }, CTX);
  check((await codeOf(() => facts.allocate(w.env, { movementId: usd.id, documentId: inv2.id, amountMinor: 1000 }, CTX))) === 'currency_mismatch', 'a payment in one currency is never allocated to a document in another');
  check((await codeOf(() => facts.allocate(w.env, { movementId: payment.id, documentId: inv2.id, amountMinor: 0 }, CTX))) === 'invalid_amount', 'an allocation of zero is refused');

  // ---- DERIVED: one place ----------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const acct = await ledger.outstandingForParty(w.env, mokoena);
  check(acct.totalMinor === 218000 && acct.documents.length === 2, 'the customer\'s account: R1,950.00 + R230.00 = R2,180.00 outstanding over two invoices');
  check(sameJson(acct.documents.map((d) => [d.id, d.grossMinor, d.allocatedMinor, d.outstandingMinor]), [[inv1.id, 345000, 150000, 195000], [inv2.id, 23000, 0, 23000]]), 'each invoice shows its gross, allocated and outstanding amounts');
  check((await ledger.outstandingForParty(w.env, patel)).totalMinor === 0, 'a customer with no documents owes nothing');

  // ---- CORRECTED ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const before = w.counts();
  const wrong = await facts.recordMovement(w.env, { direction: 'in', partyId: patel, amountMinor: 23000, currency: 'ZAR', occurredOn: '2026-11-03' }, CTX);   // recorded against the wrong customer
  const wrongAlloc = await facts.allocate(w.env, { movementId: wrong.id, documentId: inv2.id, amountMinor: 23000 }, CTX);   // and allocated to Mokoena's invoice: the mistake
  check((await ledger.outstandingForDocument(w.env, inv2.id)) === 0, 'before the correction the invoice shows as paid');
  check((await codeOf(() => facts.reverse(w.env, { documentId: inv2.id, reason: 'x' }, CTX))) === 'has_dependents', 'a document with an effective allocation cannot be reversed on its own');
  const fix = await facts.correctMovement(w.env, { movementId: wrong.id, reason: 'recorded against the wrong customer', replacement: { partyId: mokoena, allocations: [{ documentId: inv2.id, amountMinor: 23000 }] } }, CTX);
  check((await ledger.outstandingForDocument(w.env, inv2.id)) === 0 && (await ledger.outstandingForParty(w.env, patel)).totalMinor === 0, 'after the correction the invoice is still paid, now by the right customer');
  check((await ledger.isEffective(w.env, 'movement', wrong.id)) === false && (await ledger.isEffective(w.env, 'allocation', wrongAlloc.id)) === false && (await ledger.isEffective(w.env, 'movement', fix.replacementMovementId)) === true, 'the wrong movement and its allocation are no longer effective; the replacement is');
  check(w.count('eng_money_movement') === before.eng_money_movement + 2 && w.count('eng_reversal') === before.eng_reversal + 2, 'nothing was edited or removed: two movements exist (the wrong one and its replacement) and two reversals record the movement and its allocation');
  const trail = w.db.prepare("SELECT type FROM eng_event WHERE id >= ? ORDER BY id").all(wrong.eventId).map((r) => r.type);
  check(trail.includes('payment.recorded') && trail.includes('payment.allocated') && trail.includes('payment.reversed') && trail.filter((x) => x === 'payment.recorded').length === 2, 'the trail shows the original, the allocation, the reversal and the replacement: ' + trail.join(', '));
  check((await codeOf(() => facts.reverse(w.env, { movementId: wrong.id, reason: 'again' }, CTX))) === 'already_reversed', 'nothing is reversed twice');
  check((await codeOf(() => facts.reverse(w.env, { allocationId: wrongAlloc.id, reason: 'again' }, CTX))) === 'already_reversed' || (await codeOf(() => facts.reverse(w.env, { allocationId: wrongAlloc.id, reason: 'again' }, CTX))) === 'not_effective', 'an allocation that is already not effective cannot be reversed again');
  check((await codeOf(() => facts.reverse(w.env, { movementId: 99999, reason: 'x' }, CTX))) === 'not_found', 'reversing something that does not exist is refused');
  check((await codeOf(() => facts.reverse(w.env, { movementId: payment.id, reason: '   ' }, CTX))) === 'invalid_input', 'a reversal without a reason is refused');
  const rev = await facts.reverse(w.env, { allocationId: a1.id, reason: 'allocated to the wrong invoice' }, CTX);
  check((await ledger.unallocatedForMovement(w.env, payment.id)) === 200000 && (await ledger.outstandingForDocument(w.env, inv1.id)) === 345000, 'reversing an allocation frees the payment and restores what the invoice owes');
  const cleanInvoice = await facts.recordDocument(w.env, { kind: 'invoice', direction: 'sell', partyId: patel, currency: 'ZAR', issuedOn: '2026-11-04', lines: [{ description: 'Wrong', quantityMilli: 1000, unitPriceMinor: 100, taxBp: 0 }] }, CTX);
  check(!(await codeOf(() => facts.reverse(w.env, { documentId: cleanInvoice.id, reason: 'issued in error' }, CTX))), 'a document with nothing hanging off it can be reversed');
  check((await ledger.outstandingForParty(w.env, patel)).totalMinor === 0 && (await ledger.isEffective(w.env, 'document', cleanInvoice.id)) === false, 'and a reversed document no longer counts toward what is owed');

  // ---- INTEGRITY: an edit behind the engine's back is detected ------------------------------------------------------------------------------------------------------------------------------
  const clean = await eng.verifyIntegrity(w.env);
  check(clean.ok === true && clean.problems.length === 0, 'a business built through the engine verifies clean: ' + JSON.stringify(clean.problems).slice(0, 150));
  const tampered = (await world()).w;
  const tp = (await facts.recordMovement(tampered.env, { direction: 'in', partyId: 1, amountMinor: 1000, currency: 'ZAR', occurredOn: '2026-11-02' }, CTX));
  tampered.db.prepare('UPDATE eng_money_movement SET amount_minor = 999999 WHERE id = ?').run(tp.id);   // what the database itself cannot stop
  const v1 = await eng.verifyIntegrity(tampered.env);
  check(!v1.ok && v1.problems.some((p) => p.code === 'fact_changed'), 'a movement edited behind the engine\'s back is detected (fact_changed)');
  const over = (await world()).w;
  const om = await facts.recordMovement(over.env, { direction: 'in', partyId: 1, amountMinor: 1000, currency: 'ZAR', occurredOn: '2026-11-02' }, CTX);
  over.db.prepare("INSERT INTO eng_allocation (movement_id, document_id, amount_minor, event_id) VALUES (?, 1, 5000, ?)").run(om.id, om.eventId);
  const v2 = await eng.verifyIntegrity(over.env);
  check(!v2.ok && v2.problems.some((p) => p.code === 'over_allocated'), 'an allocation written around the engine that over-allocates a payment is detected (over_allocated)');
  const gap = (await world()).w;
  gap.db.prepare("UPDATE eng_document_number SET number = 5 WHERE document_id = 2").run();   // invoices numbered 1 and 5: a hole
  check(!(await eng.verifyIntegrity(gap.env)).ok, 'a hole or a stray number in the invoice sequence is detected');

  // ---- DERIVED does not depend on the cascade having been done: what hangs off a reversed payment is not effective, and the verifier says so --------------------------------------------------------------------
  const orphaned = await world();
  const op = await facts.recordMovement(orphaned.w.env, { direction: 'in', partyId: orphaned.mokoena, amountMinor: 100000, currency: 'ZAR', occurredOn: '2026-11-02' }, CTX);
  const oa = await facts.allocate(orphaned.w.env, { movementId: op.id, documentId: orphaned.inv1.id, amountMinor: 100000 }, CTX);
  check((await ledger.outstandingForDocument(orphaned.w.env, orphaned.inv1.id)) === 245000, 'control: with the payment allocated, the invoice owes R2,450.00');
  const rawEvent = Number(orphaned.w.db.prepare("INSERT INTO eng_event (type) VALUES ('raw.reversal') RETURNING id").get().id);
  orphaned.w.db.prepare("INSERT INTO eng_reversal (movement_id, reason, event_id) VALUES (?, 'written around the engine', ?)").run(op.id, rawEvent);   // the payment is reversed but its allocation is NOT (the cascade was bypassed)
  check((await ledger.outstandingForDocument(orphaned.w.env, orphaned.inv1.id)) === 345000 && (await ledger.isEffective(orphaned.w.env, 'allocation', oa.id)) === false, 'an allocation hanging off a reversed payment does not count even if nobody reversed it: the invoice owes the full R3,450.00 again');
  const orphanReport = await eng.verifyIntegrity(orphaned.w.env);
  check(!orphanReport.ok && orphanReport.problems.some((x) => x.code === 'allocation_on_reversed'), 'and the verifier reports it (allocation_on_reversed), so the inconsistency is found, not just tolerated');

  // ---- ATOMIC: a failure at EVERY write leaves nothing behind ----------------------------------------------------------------------------------------------------------------------------------
  const failEverywhere = async (label, prepare, operation) => {
    const probe = await prepare(); probe.w.resetWrites(); const state = JSON.stringify(probe.w.counts());
    await operation(probe); const writes = probe.w.writeCount();
    check(writes >= 2, `${label}: succeeds and makes ${writes} writes`);
    let leaked = [];
    for (let n = 1; n <= writes; n++) {
      const x = await prepare(); const was = JSON.stringify(x.w.counts()); x.w.failAt(n);
      const code = await codeOf(() => operation(x));
      if (code === null || JSON.stringify(x.w.counts()) !== was) leaked.push(`write ${n}${code === null ? ' (did not fail)' : ''}`);
    }
    check(leaked.length === 0, `${label}: a failure at each of its ${writes} writes leaves the business exactly as it was` + (leaked.length ? ' (leaked at ' + leaked.join(', ') + ')' : ''));
    return state;
  };
  await failEverywhere('issuing a document', world, ({ w: x, patel: p }) => facts.recordDocument(x.env, { kind: 'invoice', direction: 'sell', partyId: p, currency: 'ZAR', issuedOn: '2026-11-05', lines: [{ description: 'A', quantityMilli: 1000, unitPriceMinor: 100, taxBp: 1500 }, { description: 'B', quantityMilli: 1000, unitPriceMinor: 200, taxBp: 1500 }] }, CTX));
  await failEverywhere('recording a payment that settles two invoices', world, ({ w: x, mokoena: m, inv1: i1, inv2: i2 }) => facts.recordPayment(x.env, { direction: 'in', partyId: m, amountMinor: 30000, currency: 'ZAR', occurredOn: '2026-11-05', allocations: [{ documentId: i1.id, amountMinor: 7000 }, { documentId: i2.id, amountMinor: 23000 }] }, CTX));
  const partial = await world();
  const pBefore = JSON.stringify(partial.w.counts());
  check((await codeOf(() => facts.recordPayment(partial.w.env, { direction: 'in', partyId: partial.mokoena, amountMinor: 10000, currency: 'ZAR', occurredOn: '2026-11-05', allocations: [{ documentId: partial.inv1.id, amountMinor: 6000 }, { documentId: partial.inv2.id, amountMinor: 6000 }] }, CTX))) === 'over_allocated' && JSON.stringify(partial.w.counts()) === pBefore, 'allocating more than the payment holds refuses the WHOLE operation: the first allocation and the payment itself are not recorded');
  const settled = await facts.recordPayment(partial.w.env, { direction: 'in', partyId: partial.mokoena, amountMinor: 30000, currency: 'ZAR', occurredOn: '2026-11-05', allocations: [{ documentId: partial.inv1.id, amountMinor: 7000 }, { documentId: partial.inv2.id, amountMinor: 23000 }] }, CTX);
  check(settled.allocationIds.length === 2 && (await ledger.outstandingForDocument(partial.w.env, partial.inv2.id)) === 0 && (await ledger.outstandingForDocument(partial.w.env, partial.inv1.id)) === 338000, 'one payment settles one invoice in full and part of another, as one operation');
  const prepared = async () => { const c = await world(); const mv = await facts.recordMovement(c.w.env, { direction: 'in', partyId: c.patel, amountMinor: 23000, currency: 'ZAR', occurredOn: '2026-11-03' }, CTX); await facts.allocate(c.w.env, { movementId: mv.id, documentId: c.inv2.id, amountMinor: 23000 }, CTX); c.wrong = mv.id; return c; };
  await failEverywhere('correcting a payment (reverse and replace)', prepared, (c) => facts.correctMovement(c.w.env, { movementId: c.wrong, reason: 'wrong customer', replacement: { partyId: c.mokoena, allocations: [{ documentId: c.inv2.id, amountMinor: 23000 }] } }, CTX));
  const afterFailures = await world();
  afterFailures.w.failAt(2); await codeOf(() => facts.recordDocument(afterFailures.w.env, { kind: 'invoice', direction: 'sell', partyId: afterFailures.mokoena, currency: 'ZAR', issuedOn: '2026-11-06', lines: [{ description: 'A', quantityMilli: 1000, unitPriceMinor: 100, taxBp: 0 }] }, CTX));
  afterFailures.w.resetWrites();
  const nextNumber = (await facts.recordDocument(afterFailures.w.env, { kind: 'invoice', direction: 'sell', partyId: afterFailures.mokoena, currency: 'ZAR', issuedOn: '2026-11-06', lines: [{ description: 'A', quantityMilli: 1000, unitPriceMinor: 100, taxBp: 0 }] }, CTX)).number;
  check(nextNumber === 3, 'a failed issue leaves no gap in the numbering: the next invoice is number 3, not 4');
});

function sameSet(a, b) { return Array.isArray(a) && a.length === b.length && b.every((x) => a.includes(x)); }
function sameJson(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

if (require.main === module) kit.standalone(module.exports);
