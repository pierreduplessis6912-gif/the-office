// The general ledger, increment G1 (docs/decisions/general-ledger.md; branch engine-phase1). TESTS FIRST: what the journal must guarantee for the SELLING side (invoices, debit notes, credit notes, customer payments,
// refunds and their reversals) before it exists. Expected state when first committed: RED (worker/src/engine/journal.ts does not exist).
//   CHART      seeded once, on the first posting, from a data template; the engine posts to ROLES (receivables control, sales, VAT output, bank, cash), never to an account by name
//   POSTING    each financial fact writes its own balanced entry in the SAME transaction; a quotation, an allocation and a credit-note's non-cash movement write none
//   REVERSAL   a reversed fact gets ONE contra entry; nothing is edited; the trial balance always balances
//   SUBLEDGER  receivables control equals what customers owe, less what they are owed back (the sub-ledger the engine already derives)
//   RULES      the database itself refuses an unbalanced or non-integer line; foreign-currency facts are not posted and are reported, never hidden; the integrity verifier checks the journal
const kit = require('./engine-kit.js');

module.exports = kit.guard('engine general ledger (G1)', async ({ check }) => {
  const eng = kit.loadEngine();
  check(Boolean(eng && eng.journal), 'worker/src/engine/journal.ts exists and is exported as `journal`');
  if (!eng || !eng.journal) return;
  const { facts, journal, ledger, verifyIntegrity } = eng;
  const CTX = { actorEmail: 'accountant@example.com', contract: 'test', contractVersion: 1 };
  const codeOf = async (fn) => { try { await fn(); return null; } catch (e) { return e && e.code ? e.code : 'threw:' + String(e && e.message).slice(0, 80); } };

  const world = async () => {
    const w = kit.makeWorld();
    w.configure({ currency: 'ZAR' });
    const mokoena = (await facts.recordParty(w.env, { kind: 'person', name: 'Mokoena', roles: ['customer'] }, CTX)).id;
    const patel = (await facts.recordParty(w.env, { kind: 'organisation', name: 'Patel Builders', roles: ['customer'] }, CTX)).id;
    return { w, mokoena, patel };
  };
  const LINES = [{ description: 'Vinyl plank', quantityMilli: 10000, unit: 'm2', unitPriceMinor: 25000, taxBp: 1500 }, { description: 'Fitting', quantityMilli: 1000, unit: 'job', unitPriceMinor: 50000, taxBp: 1500 }];   // net 300000, tax 45000, gross 345000
  const invoice = (w, partyId, issuedOn = '2026-10-01', lines = LINES, kind = 'invoice') => facts.recordDocument(w.env, { kind, direction: 'sell', partyId, currency: 'ZAR', issuedOn, lines }, CTX);
  const shape = (entry) => entry.lines.map((l) => `${l.code} ${l.debitMinor > 0 ? 'D ' + l.debitMinor : 'C ' + l.creditMinor}`).sort();
  const entriesOf = (w, kind, id) => journal.entriesFor(w.env, kind, id);
  const balanced = (w) => { const e = w.db.prepare('SELECT e.id, SUM(l.debit_minor) AS d, SUM(l.credit_minor) AS c FROM eng_journal_entry e JOIN eng_journal_line l ON l.entry_id = e.id GROUP BY e.id').all(); return e.length > 0 && e.every((r) => r.d === r.c && r.d > 0); };

  // ---- CHART: seeded once, on the first posting, as data -----------------------------------------------------------------------------------------------------------------------------------------
  let { w, mokoena, patel } = await world();
  check(w.count('eng_account') === 0 && w.count('eng_journal_entry') === 0, 'a business that has posted nothing has no chart and no journal');
  const q = await facts.recordDocument(w.env, { kind: 'quotation', direction: 'sell', partyId: mokoena, currency: 'ZAR', issuedOn: '2026-10-01', lines: LINES }, CTX);
  check(w.count('eng_account') === 0 && w.count('eng_journal_entry') === 0, 'a quotation posts nothing and does not start the ledger');
  const inv1 = await invoice(w, mokoena);
  const accounts = w.count('eng_account');
  check(accounts >= 25 && w.count('eng_account_role') >= 20, `the first invoice seeds the chart (${accounts} accounts) and maps the roles`);
  const roles = ['receivables_control', 'payables_control', 'vat_output', 'vat_input', 'inventory', 'goods_received_not_invoiced', 'cost_of_sales', 'sales', 'bank', 'cash', 'stock_adjustments', 'purchase_variance', 'rounding', 'suspense', 'retained_earnings', 'expense:materials', 'expense:fuel', 'expense:other'];
  const mapped = [];
  for (const r of roles) mapped.push(await journal.accountForRole(w.env, r));
  check(mapped.every((a) => a && a.id && a.code && a.name && a.type), 'every role the engine posts to (including one expense role per category) is mapped to an account');
  const byRole = Object.fromEntries(roles.map((r, i) => [r, mapped[i]]));
  check(byRole.receivables_control.type === 'asset' && byRole.vat_output.type === 'liability' && byRole.sales.type === 'income' && byRole.cost_of_sales.type === 'cost_of_sales' && byRole['expense:fuel'].type === 'expense', 'accounts carry a type: assets, liabilities, income, cost of sales, expenses');
  await invoice(w, mokoena, '2026-10-02');
  check(w.count('eng_account') === accounts, 'the chart is seeded once: a second invoice adds no accounts');
  const chartEvents = w.db.prepare("SELECT id, actor_email, contract FROM eng_event WHERE type = 'ledger.chart_seeded'").all();
  check(chartEvents.length === 1 && chartEvents[0].actor_email === 'accountant@example.com' && w.db.prepare('SELECT COUNT(DISTINCT event_id) AS n FROM eng_account').get().n === 1, 'the chart is seeded by ONE event (who, when, under which contract) that every account points at: it has a trail like every other fact');

  // ---- POSTING: invoices ------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const e1 = await entriesOf(w, 'document', inv1.id);
  check(e1.length === 1 && e1[0].eventId === inv1.eventId, 'an invoice writes exactly one entry, carried by the invoice\'s own event');
  check(JSON.stringify(shape(e1[0])) === JSON.stringify([`${byRole.receivables_control.code} D 345000`, `${byRole.sales.code} C 300000`, `${byRole.vat_output.code} C 45000`].sort()), 'an invoice of R3,450.00 (net R3,000.00, VAT R450.00): Dr receivables R3,450.00, Cr sales R3,000.00, Cr VAT output R450.00');
  check(e1[0].entryDate === '2026-10-01', 'the entry is dated the invoice\'s issue date');
  const noVat = await invoice(w, mokoena, '2026-10-03', [{ description: 'Exempt', quantityMilli: 1000, unitPriceMinor: 10000, taxBp: 0 }]);
  check(JSON.stringify(shape((await entriesOf(w, 'document', noVat.id))[0])) === JSON.stringify([`${byRole.receivables_control.code} D 10000`, `${byRole.sales.code} C 10000`].sort()), 'an invoice with no VAT has no VAT line (a line of nothing is never written)');
  const free = await invoice(w, mokoena, '2026-10-03', [{ description: 'Free', quantityMilli: 1000, unitPriceMinor: 0, taxBp: 1500 }]);
  check((await entriesOf(w, 'document', free.id)).length === 0, 'an invoice worth nothing writes no entry');
  check((await entriesOf(w, 'document', q.id)).length === 0, 'a quotation has no entry');
  const dn = await facts.issueDebitNote(w.env, { invoiceId: inv1.id, reason: 'extra', issuedOn: '2026-10-07', lines: [{ invoiceLineNo: 1, quantityMilli: 1000, unitPriceMinor: 10000 }] }, CTX);
  const edn = (await entriesOf(w, 'document', dn.documentId))[0];
  check(edn && edn.lines.reduce((s, l) => s + l.debitMinor, 0) === dn.totals.grossMinor && edn.lines.some((l) => l.code === byRole.receivables_control.code && l.debitMinor === dn.totals.grossMinor), 'a debit note posts like an invoice: receivables debited the full amount');

  // ---- POSTING: payments, allocation, refunds -----------------------------------------------------------------------------------------------------------------------------------------------
  const pay = async (method, amount = 100000, party = mokoena, allocate = true) => facts.recordPayment(w.env, { direction: 'in', partyId: party, amountMinor: amount, currency: 'ZAR', occurredOn: '2026-11-02', method, allocations: allocate ? [{ documentId: inv1.id, amountMinor: amount }] : [] }, CTX);
  const pEft = await pay('eft');
  const eEft = await entriesOf(w, 'movement', pEft.movementId);
  check(eEft.length === 1 && JSON.stringify(shape(eEft[0])) === JSON.stringify([`${byRole.bank.code} D 100000`, `${byRole.receivables_control.code} C 100000`].sort()), 'a payment by EFT: Dr bank, Cr receivables; the allocation to the invoice adds NO entry (it only matches)');
  const pCash = await pay('cash', 5000, mokoena, false);
  check((await entriesOf(w, 'movement', pCash.movementId))[0].lines.some((l) => l.code === byRole.cash.code && l.debitMinor === 5000), 'a cash payment is debited to the cash account');
  const pNone = await pay(null, 7000, mokoena, false);
  check((await entriesOf(w, 'movement', pNone.movementId))[0].lines.some((l) => l.code === byRole.bank.code && l.debitMinor === 7000), 'a payment with no stated method goes to the bank account (the default)');
  const entriesBefore = w.count('eng_journal_entry');
  await facts.allocate(w.env, { movementId: pNone.movementId, documentId: inv1.id, amountMinor: 7000 }, CTX);
  check(w.count('eng_journal_entry') === entriesBefore, 'allocating an existing payment later writes nothing');

  const cn = await facts.issueCreditNote(w.env, { invoiceId: inv1.id, reason: 'damaged', issuedOn: '2026-10-20', lines: [{ invoiceLineNo: 1, quantityMilli: 2000, unitPriceMinor: 25000 }] }, CTX);
  const ecn = (await entriesOf(w, 'document', cn.documentId))[0];
  check(ecn && JSON.stringify(shape(ecn)) === JSON.stringify([`${byRole.sales.code} D ${cn.totals.netMinor}`, `${byRole.vat_output.code} D ${cn.totals.taxMinor}`, `${byRole.receivables_control.code} C ${cn.totals.grossMinor}`].sort()), 'a credit note is the invoice turned round: Dr sales, Dr VAT output, Cr receivables');
  check((await entriesOf(w, 'movement', cn.movementId)).length === 0, 'the credit note\'s own non-cash "credit" movement writes no entry (the credit note already did)');

  // refunds (leftover credit and an unallocated payment)
  const cn2 = await facts.issueCreditNote(w.env, { invoiceId: inv1.id, reason: 'again', issuedOn: '2026-10-21', lines: [{ invoiceLineNo: 2, quantityMilli: 1000, unitPriceMinor: 50000 }] }, CTX);
  const unapplied = cn2.unappliedMinor;
  if (unapplied > 0) {
    const rf = await facts.refundCredit(w.env, { creditNoteId: cn2.documentId, amountMinor: unapplied, refundedOn: '2026-10-25', method: 'eft' }, CTX);
    check(JSON.stringify(shape((await entriesOf(w, 'movement', rf.movementId))[0])) === JSON.stringify([`${byRole.receivables_control.code} D ${unapplied}`, `${byRole.bank.code} C ${unapplied}`].sort()), 'refunding leftover credit: Dr receivables, Cr bank');
  } else check(true, 'this scenario left no credit to refund (the refund path is covered below)');
  const over = await pay('eft', 20000, patel, false);
  const rp = await facts.refundPayment(w.env, { paymentId: over.movementId, amountMinor: 8000, refundedOn: '2026-11-03', method: 'cash' }, CTX);
  check(JSON.stringify(shape((await entriesOf(w, 'movement', rp.movementId))[0])) === JSON.stringify([`${byRole.receivables_control.code} D 8000`, `${byRole.cash.code} C 8000`].sort()), 'refunding an overpayment in cash: Dr receivables, Cr cash');

  // ---- SUBLEDGER: receivables control = what customers owe less what they are owed back -------------------------------------------------------------------------------------------------------------
  const ar = async () => { let expected = 0; for (const p of [mokoena, patel]) expected += (await ledger.outstandingForParty(w.env, p)).totalMinor - (await ledger.unappliedCreditForParty(w.env, p)); return { expected, actual: await journal.balanceOfRole(w.env, 'receivables_control') }; };
  let r = await ar();
  check(r.expected === r.actual, `receivables control (R${r.actual / 100}) equals the sub-ledger the engine derives (R${r.expected / 100})`);
  check(balanced(w) && (await journal.trialBalance(w.env)).totalDebitMinor === (await journal.trialBalance(w.env)).totalCreditMinor, 'every entry balances and the trial balance sums to zero');

  // ---- REVERSAL: one contra entry, nothing edited -------------------------------------------------------------------------------------------------------------------------------------------------
  const before = JSON.stringify(await entriesOf(w, 'movement', pEft.movementId));
  const corr = await facts.correctMovement(w.env, { movementId: pEft.movementId, reason: 'wrong amount', replacement: { partyId: mokoena, amountMinor: 90000, method: 'eft', allocations: [{ documentId: inv1.id, amountMinor: 90000 }] } }, CTX);
  const eOrig = await entriesOf(w, 'movement', pEft.movementId);
  check(eOrig.length === 2 && eOrig[1].reversesEntryId === eOrig[0].id && JSON.stringify(eOrig[0]) === JSON.stringify(JSON.parse(before)[0]), 'correcting a payment adds ONE contra entry that points at the original (the original is untouched)');
  check(shape(eOrig[1]).join() === [`${byRole.bank.code} C 100000`, `${byRole.receivables_control.code} D 100000`].sort().join(), 'the contra entry is the original turned round');
  check((await entriesOf(w, 'movement', corr.replacementMovementId)).length === 1, 'the replacement payment posts as its own entry');
  const inv3 = await invoice(w, patel, '2026-11-04');
  await facts.reverse(w.env, { documentId: inv3.id, reason: 'entered twice' }, CTX);
  const e3 = await entriesOf(w, 'document', inv3.id);
  check(e3.length === 2 && e3[1].reversesEntryId === e3[0].id, 'reversing an invoice posts one contra entry');
  check((await codeOf(() => facts.reverse(w.env, { documentId: inv3.id, reason: 'again' }, CTX))) === 'already_reversed' && (await entriesOf(w, 'document', inv3.id)).length === 2, 'a second reversal is refused, so a second contra entry cannot exist');
  const cn3 = await facts.issueCreditNote(w.env, { invoiceId: inv1.id, reason: 'oops', issuedOn: '2026-11-05', lines: [{ invoiceLineNo: 1, quantityMilli: 1000, unitPriceMinor: 25000 }] }, CTX);
  await facts.voidCreditNote(w.env, { creditNoteId: cn3.documentId, reason: 'mistake', voidedOn: '2026-11-06' }, CTX);
  check((await entriesOf(w, 'document', cn3.documentId)).length === 2 && (await entriesOf(w, 'movement', cn3.movementId)).length === 0, 'voiding a credit note reverses its entry once; its non-cash movement still has none');
  const allocCount = w.count('eng_journal_entry');
  const a = w.db.prepare('SELECT a.id FROM eng_allocation a WHERE NOT EXISTS (SELECT 1 FROM eng_reversal r WHERE r.allocation_id = a.id) AND NOT EXISTS (SELECT 1 FROM eng_reversal r WHERE r.movement_id = a.movement_id) AND NOT EXISTS (SELECT 1 FROM eng_reversal r WHERE r.document_id = a.document_id) ORDER BY a.id DESC LIMIT 1').get();
  await facts.reverse(w.env, { allocationId: a.id, reason: 'allocated to the wrong invoice' }, CTX);
  check(w.count('eng_journal_entry') === allocCount, 'reversing only an allocation writes nothing');
  r = await ar();
  check(r.expected === r.actual, `after corrections receivables control (R${r.actual / 100}) still equals the sub-ledger (R${r.expected / 100})`);
  check(balanced(w), 'every entry still balances after the corrections');

  // ---- RULES: the database refuses what the ledger must never hold -----------------------------------------------------------------------------------------------------------------------------
  const entry = w.db.prepare('SELECT id FROM eng_journal_entry ORDER BY id LIMIT 1').get().id, acct = byRole.bank.id;
  const refused = (d, c) => { try { w.db.prepare('INSERT INTO eng_journal_line (entry_id, line_no, account_id, debit_minor, credit_minor) VALUES (?, 99, ?, ?, ?)').run(entry, acct, d, c); return false; } catch { return true; } };
  check(refused(5, 5) && refused(0, 0) && refused(-5, 0) && refused(1.5, 0), 'a line must be exactly one of debit or credit, in whole non-negative cents: both, neither, negative and fractions are refused by the database itself (text is refused by the ledger code before it gets there: SQLite would coerce it)');
  const sameSource = () => { try { w.db.prepare("INSERT INTO eng_journal_entry (entry_date, source_kind, source_id, memo, event_id) VALUES ('2026-10-01', 'document', ?, 'again', ?)").run(inv1.id, inv1.eventId); return false; } catch { return true; } };
  check(sameSource(), 'the database refuses a second original entry for the same source');

  // ---- foreign currency: not posted, and said so ---------------------------------------------------------------------------------------------------------------------------------------------
  const usd = await facts.recordDocument(w.env, { kind: 'invoice', direction: 'sell', partyId: mokoena, currency: 'USD', issuedOn: '2026-11-07', lines: [{ description: 'Import', quantityMilli: 1000, unitPriceMinor: 10000, taxBp: 0 }] }, CTX);
  check((await entriesOf(w, 'document', usd.id)).length === 0, 'a foreign-currency invoice is not posted (no foreign exchange yet)');
  const ver = await verifyIntegrity(w.env);
  check(ver.ok && ver.warnings.some((x) => x.code === 'unposted_foreign_currency' && x.detail.includes(`document ${usd.id}`)), 'the integrity verifier is clean and REPORTS the unposted foreign-currency invoice by name');

  // ---- the verifier checks the journal -----------------------------------------------------------------------------------------------------------------------------------------------------
  const clean = await verifyIntegrity(w.env);
  check(clean.ok && clean.problems.length === 0, `the integrity verifier is clean on a business whose journal is right (problems: ${JSON.stringify(clean.problems)})`);
  const t = await world();
  await invoice(t.w, t.mokoena);
  t.w.db.prepare('UPDATE eng_journal_line SET debit_minor = debit_minor + 1 WHERE id = (SELECT MIN(id) FROM eng_journal_line WHERE debit_minor > 0)').run();
  check((await verifyIntegrity(t.w.env)).problems.some((p) => p.code === 'journal_unbalanced'), 'the verifier reports an entry whose debits and credits differ (a coordinated tamper)');
  const m = await world();
  const mi = await invoice(m.w, m.mokoena);
  m.w.db.prepare('DELETE FROM eng_journal_line WHERE entry_id IN (SELECT id FROM eng_journal_entry WHERE source_id = ?)').run(mi.id);
  m.w.db.prepare('DELETE FROM eng_journal_entry WHERE source_id = ?').run(mi.id);
  check((await verifyIntegrity(m.w.env)).problems.some((p) => p.code === 'journal_missing' && p.detail.includes(`document ${mi.id}`)), 'the verifier reports an invoice whose entry has been deleted (posted after the ledger started)');
  const s = await world();
  await invoice(s.w, s.mokoena);
  const lateInvoice = s.w.db.prepare("INSERT INTO eng_event (type, payload_json) VALUES ('document.issued', '{}') RETURNING id").get().id;
  const rawDoc = s.w.db.prepare("INSERT INTO eng_document (kind, direction, party_id, currency, issued_on, event_id) VALUES ('invoice', 'sell', ?, 'ZAR', '2026-11-08', ?) RETURNING id").get(s.mokoena, lateInvoice).id;
  s.w.db.prepare("INSERT INTO eng_document_line (document_id, line_no, description, quantity_milli, unit, unit_price_minor, tax_bp) VALUES (?, 1, 'Raw', 1000, 'job', 10000, 0)").run(rawDoc);
  check((await verifyIntegrity(s.w.env)).problems.some((p) => p.code === 'journal_missing'), 'a financial fact written around the one write path (no entry) is reported');

  // ---- ATOMIC: a failure at EVERY write of a posting operation leaves nothing behind ---------------------------------------------------------------------------------------------------------------
  let atomic = true;
  for (let n = 1; n <= 40; n++) {
    const x = await world(); await invoice(x.w, x.mokoena);
    const was = JSON.stringify(x.w.counts()); x.w.failAt(n);
    let failed = false; try { await facts.recordPayment(x.w.env, { direction: 'in', partyId: x.mokoena, amountMinor: 1000, currency: 'ZAR', occurredOn: '2026-11-02', method: 'eft', allocations: [] }, CTX); } catch { failed = true; }
    x.w.resetWrites();
    if (failed && JSON.stringify(x.w.counts()) !== was) { atomic = false; break; }
    if (!failed) break;
  }
  check(atomic, 'a failure injected at every write of a payment (its entry included) leaves the business exactly as it was');
  const ruleRefuses = (lines) => { try { eng.journal.checkedLines(lines); return null; } catch (e) { return e.code || String(e); } };
  check(ruleRefuses([{ role: 'bank', debitMinor: 500 }, { role: 'sales', creditMinor: 400 }]) === 'ledger_unbalanced' && ruleRefuses([{ role: 'bank', debitMinor: 1.5 }, { role: 'sales', creditMinor: 1.5 }]) === 'invalid_amount' && ruleRefuses([{ role: 'bank', debitMinor: 500 }, { role: 'sales', creditMinor: 500 }]) === null, 'the rule itself refuses an unbalanced entry and a fractional amount before anything is written, and lets a balanced one through');
});

if (require.main === module) kit.standalone(module.exports);
