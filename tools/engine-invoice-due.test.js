// A DUE DATE ON A CUSTOMER INVOICE (docs/decisions/needs-attention.md): a draft may carry terms.dueOn, checked on every save (a real date, not before the issue date) and kept on the issued document's terms.
// "Needs attention" then uses that recorded date; only an invoice with none falls back to 30 days after issue (and says so).
const kit = require('./engine-kit.js');

module.exports = kit.guard('engine invoice due date', async ({ check }) => {
  const eng = kit.loadEngine();
  const { facts, capabilities, drafts } = eng;
  const CTX = { actorEmail: 'owner@example.com', contract: 'test', contractVersion: 1 };
  const AV = [...kit.ALL_CAPABILITIES, 'attention.find', 'invoices.find'];
  const w = kit.makeWorld(); w.configure({ currency: 'ZAR', mode: 'engine', available: AV });
  const viewer = { perms: new Set(['receivables.read']), available: new Set(AV) };
  const attention = () => capabilities.READS.find((q) => q.id === 'attention.find').run(w.env, viewer, { asOf: '2026-11-17' });
  const cust = (await facts.recordParty(w.env, { kind: 'person', name: 'Mokoena', roles: ['customer'] }, CTX)).id;
  const line = [{ description: 'Fitting', quantityMilli: 1000, unit: 'job', unitPriceMinor: 100000, taxBp: 1500 }];
  const issue = async (issuedOn, terms) => {
    const d = await drafts.createDraft(w.env, { kind: 'invoice', direction: 'sell', partyId: cust }, CTX);
    const payload = { currency: 'ZAR', issuedOn, lines: line, ...(terms === undefined ? {} : { terms }) };
    const s = await drafts.saveDraft(w.env, d.id, { expectedVersion: 1, payload }, CTX);
    return { d, s };
  };

  // ---- the draft checks the date ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  let x = await issue('2026-11-10', { dueOn: '2026-11-05' });
  check(x.s.validation.ok === false && x.s.validation.errors.some((e) => e.field === 'terms.dueOn' && /before/i.test(e.message)), 'a due date before the issue date is not ready');
  x = await issue('2026-11-10', { dueOn: '2026-02-30' });
  check(x.s.validation.ok === false && x.s.validation.errors.some((e) => e.field === 'terms.dueOn'), 'a due date that is not a real date is not ready');
  x = await issue('2026-11-10', { dueOn: 'soon' });
  check(x.s.validation.ok === false && x.s.validation.errors.some((e) => e.field === 'terms.dueOn'), 'a due date that is words is not ready');
  x = await issue('2026-11-10', { dueOn: '2026-11-10' });
  check(x.s.validation.ok === true, 'a due date on the issue day is fine');
  x = await issue('2026-11-10', {});
  check(x.s.validation.ok === true, 'no due date is still fine (it is optional)');
  x = await issue('2026-11-10', 'net 30');
  check(x.s.validation.ok === false && x.s.validation.errors.some((e) => e.field === 'terms'), 'terms that are not an object are not ready');

  // ---- it is kept on the issued document ------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const a = await issue('2026-11-10', { dueOn: '2026-11-15' });
  const ai = await drafts.issueDraft(w.env, a.d.id, { expectedVersion: 2 }, CTX);
  let r = await attention();
  const mine = (id) => r.items.find((i) => i.kind === 'invoice_late' && i.ref.id === id);
  check(mine(ai.documentId) && mine(ai.documentId).dueOn === '2026-11-15', 'an invoice younger than 30 days is listed once its OWN due date has passed');
  check(!/no due date/i.test(mine(ai.documentId).detail) && /2026-11-15/.test(mine(ai.documentId).detail), 'and says it was due on that date, not that none was recorded');

  const b = await issue('2026-09-01', { dueOn: '2026-12-31' });
  const bi = await drafts.issueDraft(w.env, b.d.id, { expectedVersion: 2 }, CTX);
  r = await attention();
  check(!mine(bi.documentId), 'an invoice older than 30 days is NOT listed while its own due date is still ahead');

  const c = await issue('2026-09-01', undefined);
  const ci = await drafts.issueDraft(w.env, c.d.id, { expectedVersion: 2 }, CTX);
  r = await attention();
  check(mine(ci.documentId) && /no due date was recorded/i.test(mine(ci.documentId).detail), 'an invoice with no due date still falls back to 30 days and says so');
  check(mine(ci.documentId).dueOn === '2026-10-01', 'the fallback date is the issue date plus 30 days');

  // ---- the invoice list says the due date and whether it is overdue (the engine's own word; the app never works it out) ----------------------------------------------------------------------
  const list = async (asOf) => (await capabilities.READS.find((q) => q.id === 'invoices.find').run(w.env, viewer, { status: 'any', ...(asOf ? { asOf } : {}) })).invoices;
  let rows = await list('2026-11-17');
  const row = (id) => rows.find((x) => x.id === id);
  check(row(ai.documentId).dueOn === '2026-11-15' && row(ai.documentId).overdue === true, 'an invoice past its recorded due date is overdue and shows the date');
  check(row(bi.documentId).dueOn === '2026-12-31' && row(bi.documentId).overdue === false, 'an invoice before its due date is not overdue');
  check(row(ci.documentId).dueOn === null && row(ci.documentId).overdue === false, 'an invoice with no recorded due date shows none and is never called overdue (the 30-day fallback is only for Needs attention)');
  rows = await list('2026-11-14');
  check(row(ai.documentId).overdue === false, 'asked as of an earlier day, the same invoice is not yet overdue');
  rows = await list('2026-11-17');
  await facts.recordPayment(w.env, { direction: 'in', partyId: cust, amountMinor: 115000, currency: 'ZAR', occurredOn: '2026-11-16', method: 'eft', allocations: [{ documentId: ai.documentId, amountMinor: 115000 }] }, CTX);
  rows = await list('2026-11-17');
  check(row(ai.documentId).dueOn === '2026-11-15' && row(ai.documentId).overdue === false, 'a paid invoice is not overdue, though it still shows its due date');
  check(capabilities.READS.find((q) => q.id === 'invoices.find').validate({ asOf: 'tomorrow' }).ok === false, 'a badly written asOf is refused');
});
if (require.main === module) kit.standalone(module.exports);
