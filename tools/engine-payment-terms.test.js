// PAYMENT TERMS (docs/decisions/needs-attention.md): a customer may have a default payment term in days (contact field paymentTermsDays, whole days 0 to 365, set on party.create or party.edit and so held,
// approved and kept in history). When an invoice is issued WITHOUT its own due date, the due date becomes the issue date plus the customer's term, written onto the invoice's own terms at that moment: a later
// change of the term never moves a due date already issued, and an own due date always wins. No term, no due date (Needs attention then uses its 30-day fallback and says so).
const kit = require('./engine-kit.js');

module.exports = kit.guard('engine payment terms', async ({ check }) => {
  const eng = kit.loadEngine();
  const { facts, capabilities, drafts, parties } = eng;
  const CTX = { actorEmail: 'owner@example.com', contract: 'test', contractVersion: 1 };
  const codeOf = async (fn) => { try { await fn(); return null; } catch (e) { return e && e.code ? e.code : 'threw:' + String(e && e.message).slice(0, 80); } };
  const AV = [...kit.ALL_CAPABILITIES, 'attention.find', 'invoices.find'];
  const w = kit.makeWorld(); w.configure({ currency: 'ZAR', mode: 'engine', available: AV });
  const viewer = { perms: new Set(['receivables.read']), available: new Set(AV) };
  const dueOf = async (docId) => JSON.parse((await w.env.OFFICE_DB.prepare('SELECT terms_json FROM eng_document WHERE id = ?').bind(docId).first()).terms_json).dueOn;
  const line = [{ description: 'Fitting', quantityMilli: 1000, unit: 'job', unitPriceMinor: 100000, taxBp: 1500 }];
  const issue = async (partyId, issuedOn, terms) => {
    const d = await drafts.createDraft(w.env, { kind: 'invoice', direction: 'sell', partyId }, CTX);
    await drafts.saveDraft(w.env, d.id, { expectedVersion: 1, payload: { currency: 'ZAR', issuedOn, lines: line, ...(terms === undefined ? {} : { terms }) } }, CTX);
    return (await drafts.issueDraft(w.env, d.id, { expectedVersion: 2 }, CTX)).documentId;
  };

  // ---- the term itself --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const net30 = (await facts.recordParty(w.env, { kind: 'person', name: 'Net Thirty', roles: ['customer'], contact: { paymentTermsDays: '30' } }, CTX)).id;
  check((await parties.partyProfile(w.env, net30)).contact.paymentTermsDays === '30', 'a customer can be created with a payment term in days');
  for (const bad of ['-1', '366', '30.5', 'thirty', ' ', '1e2', '030']) {
    check(await codeOf(() => facts.recordParty(w.env, { kind: 'person', name: 'Bad ' + bad, roles: ['customer'], contact: { paymentTermsDays: bad } }, CTX)) === 'invalid_input', `a term of "${bad}" is refused`);
  }
  const plain = (await facts.recordParty(w.env, { kind: 'person', name: 'Plain', roles: ['customer'] }, CTX)).id;
  await facts.reviseParty(w.env, { partyId: plain, contact: { paymentTermsDays: '14' } }, CTX);
  check((await parties.partyProfile(w.env, plain)).contact.paymentTermsDays === '14', 'a term can be set later by an edit, which is a new fact in the history');
  await facts.reviseParty(w.env, { partyId: plain, contact: { paymentTermsDays: null } }, CTX);
  check((await parties.partyProfile(w.env, plain)).contact.paymentTermsDays === undefined, 'and cleared again');
  const zero = (await facts.recordParty(w.env, { kind: 'person', name: 'Cash', roles: ['customer'], contact: { paymentTermsDays: '0' } }, CTX)).id;
  check((await parties.partyProfile(w.env, zero)).contact.paymentTermsDays === '0', 'a term of 0 days (pay on the day) is allowed');

  // ---- it becomes the invoice's own due date at issue -------------------------------------------------------------------------------------------------------------------------------------
  const a = await issue(net30, '2026-11-10');
  check(await dueOf(a) === '2026-12-10', 'an invoice issued with no due date gets the issue date plus the customer\'s term');
  const b = await issue(net30, '2026-11-10', { dueOn: '2026-11-12' });
  check(await dueOf(b) === '2026-11-12', 'a due date typed on the invoice wins over the customer\'s term');
  const c = await issue(plain, '2026-11-10');
  check(await dueOf(c) === undefined, 'a customer with no term gives an invoice with no due date');
  const z = await issue(zero, '2026-11-10');
  check(await dueOf(z) === '2026-11-10', 'a term of 0 days makes the invoice due on the issue day');
  const eom = await issue(net30, '2026-12-15');
  check(await dueOf(eom) === '2027-01-14', 'days are counted across a month and year end');
  await facts.reviseParty(w.env, { partyId: net30, contact: { paymentTermsDays: '60' } }, CTX);
  check(await dueOf(a) === '2026-12-10', 'changing the term later does not move a due date already issued');
  const d2 = await issue(net30, '2026-11-10');
  check(await dueOf(d2) === '2027-01-09', 'a new invoice uses the new term');

  // ---- a quotation or a bill is not given a due date by it --------------------------------------------------------------------------------------------------------------------------------------
  const q = await facts.recordDocument(w.env, { kind: 'quotation', direction: 'sell', partyId: net30, currency: 'ZAR', issuedOn: '2026-11-10', lines: line }, CTX);
  check(await dueOf(q.id) === undefined, 'a quotation is not given a due date');
  const qd = await drafts.createDraft(w.env, { kind: 'quotation', direction: 'sell', partyId: net30 }, CTX);
  await drafts.saveDraft(w.env, qd.id, { expectedVersion: 1, payload: { currency: 'ZAR', issuedOn: '2026-11-10', lines: line } }, CTX);
  const qi = await drafts.issueDraft(w.env, qd.id, { expectedVersion: 2 }, CTX);
  check(await dueOf(qi.documentId) === undefined, 'nor is a quotation issued from a draft');

  // ---- Needs attention reads it -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const r = await capabilities.READS.find((x) => x.id === 'attention.find').run(w.env, viewer, { asOf: '2026-11-17' });
  check(!r.items.some((i) => i.ref && i.ref.id === a), 'an invoice still inside its term is not on the attention list');
  check(r.items.some((i) => i.ref && i.ref.id === z && i.kind === 'invoice_late' && /was due 2026-11-10/.test(i.detail)), 'one past its term is, with the date it was due');
});
if (require.main === module) kit.standalone(module.exports);
