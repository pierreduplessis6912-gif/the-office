// THE TWO SMALL ENGINE GAPS (step c of docs/RESUME.md, 2026-11-14; docs/decisions/engine-gaps.md). TESTS FIRST; expected state when first committed: RED.
//  A. DRAFT INVOICES OVER HTTP: POST /engine/drafts (open one), GET /engine/drafts/<id> (read it with its validation), PUT /engine/drafts/<id> (save it, against the version the person saw). A draft is the one mutable working copy, not a business
//     fact: nothing is recorded until `invoice.issue` is PROPOSED, held and approved, exactly as before. Lines may name an item (itemId), which the issue already validates and keeps in the invoice's own terms.
//  B. QUOTATION LINES THAT NAME ITEMS: quotation.create and quotation.revise take `lineItems` [{lineNo, itemId}] exactly as purchase orders do, kept in the document's terms (no schema change), validated against the real items and their units.
//     Credit-note lines need no change: they point at the invoice's lines, and the invoice already names the items.
const kit = require('./engine-kit.js');

module.exports = kit.guard('engine gaps (drafts over HTTP, quotation items)', async ({ check }) => {
  const ENV_A = { BUSINESS_ID: 'eng-a', ENGINE_REHEARSAL: '1' };
  const SEED = { admin: true, method: 'POST', path: '/admin/engine/provision-sample', body: { confirm: 'eng-a' } };
  const prop = (capability, payload, role = 'accountant') => ({ method: 'POST', path: '/engine/proposals', role, body: { capability, payload, transcript: 'seed' } });
  const confirm = (id, role = 'accountant') => ({ method: 'POST', path: `/actions/${id}/confirm`, role, body: {} });
  const WORLD = []; let n = 0; const seed = (c, p) => { WORLD.push(prop(c, p), confirm(++n)); };
  seed('item.create', { sku: 'PLY-18', name: 'Plywood 18mm', unit: 'sheet' });      // item 1
  seed('item.create', { sku: 'SCR-50', name: 'Screws 50mm', unit: 'box' });         // item 2
  const run = (spec) => kit.route({ env: ENV_A, before: [SEED, ...WORLD, ...(spec.before || [])], ...spec, ...(spec.before ? { before: [SEED, ...WORLD, ...spec.before] } : {}) });
  const body = (r) => (r.result && r.result.body) || {};
  const status = (r) => r.result && r.result.status;
  const added = (r, t) => ((r.writes && r.writes[t] && r.writes[t].added) || []);
  const tables = (r) => Object.keys(r.writes || {}).filter((t) => added(r, t).length > 0 || (r.writes[t].changed || []).length > 0).sort();
  const FACTS = ['eng_party', 'eng_document', 'eng_document_line', 'eng_document_number', 'eng_money_movement', 'eng_allocation', 'eng_reversal', 'eng_event'];
  const noFacts = (r) => FACTS.every((t) => added(r, t).length === 0);
  const jline = (extra = {}) => ({ description: 'Plywood', quantityMilli: 2000, unit: 'sheet', unitPriceMinor: 30000, taxBp: 1500, ...extra });
  const open = (extra = {}) => ({ method: 'POST', path: '/engine/drafts', role: 'accountant', body: { kind: 'invoice', direction: 'sell', partyId: 1, ...extra } });
  const save = (id, version, payload, role = 'accountant') => ({ method: 'PUT', path: `/engine/drafts/${id}`, role, body: { expectedVersion: version, payload } });
  const GOOD = { currency: 'ZAR', issuedOn: '2026-10-01', lines: [jline({ itemId: 1 })] };

  // ================= A. drafts over HTTP =====================================================================================================================================================================================
  let r = await run({ ...open() });
  check(status(r) === 200 && typeof body(r).id === 'number' && body(r).version === 1 && noFacts(r) && tables(r).join() === 'eng_draft', `opening a draft: 200, its id and version 1, and only the draft is written (got ${status(r)} ${JSON.stringify(body(r)).slice(0, 100)} ${tables(r)})`);
  const D = body(r).id;
  r = await run({ before: [open()], method: 'GET', path: `/engine/drafts/${D}`, role: 'accountant' });
  check(status(r) === 200 && body(r).id === D && body(r).version === 1 && body(r).validation && body(r).validation.ok === false && body(r).issuedDocumentId === null, `reading it shows its version and that it is not ready (got ${status(r)} ${JSON.stringify(body(r)).slice(0, 140)})`);
  r = await run({ before: [open()], ...save(D, 1, GOOD) });
  check(status(r) === 200 && body(r).version === 2 && body(r).validation && body(r).validation.ok === true && noFacts(r), `saving a good draft: version 2, ready, nothing recorded as a business fact (got ${status(r)} ${JSON.stringify(body(r)).slice(0, 140)})`);
  r = await run({ before: [open(), save(D, 1, GOOD)], ...save(D, 1, GOOD) });
  check(status(r) === 409 && body(r).error === 'stale' && noFacts(r), `saving against a version that has moved on is refused as stale (got ${status(r)} ${body(r).error})`);
  r = await run({ before: [open()], ...save(D, 1, { currency: 'ZAR', lines: [{ description: 'x' }] }) });
  check(status(r) === 200 && body(r).validation.ok === false && body(r).validation.errors.length > 0, 'an incomplete draft saves, and says what is missing (it is a working copy)');
  for (const [bad, why] of [[{ kind: 'quotation' }, 'a kind other than invoice'], [{ direction: 'buy' }, 'a direction other than sell'], [{ partyId: 'one' }, 'a party that is not a number']]) {
    r = await run({ ...open(bad) });
    check(status(r) === 422 && tables(r).length === 0, `${why} is refused 422, nothing written (got ${status(r)})`);
  }
  r = await run({ before: [open()], method: 'PUT', path: `/engine/drafts/${D}`, role: 'accountant', body: { payload: GOOD } });
  check(status(r) === 422, 'a save without the version it was opened at is refused 422');
  r = await run({ before: [open()], method: 'PUT', path: `/engine/drafts/${D}`, role: 'accountant', body: { expectedVersion: 1 } });
  check(status(r) === 422, 'a save without a payload is refused 422');
  r = await run({ method: 'GET', path: '/engine/drafts/999', role: 'accountant' });
  check(status(r) === 404 && body(r).error === 'not_found', 'a draft that does not exist is not_found');
  r = await run({ method: 'GET', path: '/engine/drafts/abc', role: 'accountant' });
  check(status(r) === 403 || status(r) === 404, `a draft id that is not a number is not a route at all: refused by the gate or not found, never served (got ${status(r)})`);
  for (const role of ['installer', 'sales']) {
    r = await run({ ...open(), role });
    check(status(r) === 403 && tables(r).length === 0, `${role}: may not open a draft (the same capability that issues invoices): 403, nothing written (got ${status(r)})`);
  }
  r = await kit.route({ ...open(), role: 'owner' });
  check(status(r) === 409 && body(r).error === 'not_engine_mode' && tables(r).length === 0, 'a legacy business is refused: not_engine_mode, nothing written');
  r = await run({ method: 'POST', path: '/engine/drafts', role: 'accountant', noSession: true, body: { kind: 'invoice', direction: 'sell' } });
  check(status(r) === 401 || status(r) === 403, `signed out: refused (got ${status(r)})`);

  // the whole journey: open, save with an item, propose the issue, approve: the invoice exists and names its item
  const journey = [open(), save(D, 1, GOOD), prop('invoice.issue', { draftId: D, expectedVersion: 2 })];
  r = await run({ before: journey, ...confirm(n + 1) });
  const inv = added(r, 'eng_document')[0] || {};
  check(status(r) === 200 && added(r, 'eng_document').length === 1 && inv.kind === 'invoice' && /"lineItems":\[\{"lineNo":1,"itemId":1\}\]/.test(String(inv.terms_json)), `approving the issue records ONE invoice whose terms name the item on line 1 (got ${status(r)} ${String(inv.terms_json).slice(0, 80)})`);
  r = await run({ before: [open(), save(D, 1, { ...GOOD, lines: [jline({ itemId: 99 })] })], ...prop('invoice.issue', { draftId: D, expectedVersion: 2 }) });
  check(status(r) >= 400 && status(r) < 500 && added(r, 'pending_actions').length === 0, `a draft naming an item that does not exist cannot be proposed for issue: refused at the door, nothing held (got ${status(r)} ${body(r).error})`);
  r = await run({ before: [open(), save(D, 1, GOOD)], ...prop('invoice.issue', { draftId: D, expectedVersion: 1 }) });
  check(status(r) >= 400 && status(r) < 500 && added(r, 'pending_actions').length === 0, `proposing the issue of an older version of the draft is refused as stale (got ${status(r)} ${body(r).error})`);

  // ================= B. quotation lines that name items ========================================================================================================================================================================
  const q = (extra = {}) => ({ partyId: 1, issuedOn: '2026-10-01', currency: 'ZAR', lines: [jline(), { description: 'Screws', quantityMilli: 3000, unit: 'box', unitPriceMinor: 2000, taxBp: 1500 }], ...extra });
  const items = [{ lineNo: 1, itemId: 1 }, { lineNo: 2, itemId: 2 }];
  const made = (extra) => [prop('quotation.create', q(extra))];
  r = await run({ before: made({ lineItems: items }), ...confirm(n + 1) });
  const doc = added(r, 'eng_document')[0] || {};
  check(status(r) === 200 && doc.kind === 'quotation' && JSON.stringify(JSON.parse(doc.terms_json).lineItems) === JSON.stringify(items), `a quotation whose lines name items records them in its terms (got ${status(r)} ${String(doc.terms_json).slice(0, 100)})`);
  r = await run({ before: made({}), ...confirm(n + 1) });
  check(status(r) === 200 && !('lineItems' in JSON.parse((added(r, 'eng_document')[0] || {}).terms_json || '{}')), 'a quotation without lineItems is exactly as before (no lineItems in its terms)');
  r = await run({ before: made({ validUntil: '2026-11-01', lineItems: items }), ...confirm(n + 1) });
  check(status(r) === 200 && JSON.parse(added(r, 'eng_document')[0].terms_json).validUntil === '2026-11-01', 'validity and item naming sit together in the terms');
  for (const [bad, why, codes] of [
    [{ lineItems: [{ lineNo: 1, itemId: 99 }] }, 'an item that does not exist', [404]],
    [{ lineItems: [{ lineNo: 2, itemId: 1 }] }, 'a line in box naming an item stocked in sheets', [422, 409]],
    [{ lineItems: [{ lineNo: 3, itemId: 1 }] }, 'a line number the quotation does not have', [422]],
    [{ lineItems: [] }, 'an empty list', [422]],
    [{ lineItems: [{ lineNo: 1, itemId: 1, price: 5 }] }, 'a field a line item does not have', [422]],
    [{ lineItems: 'plywood' }, 'a list that is text', [422]],
  ]) {
    r = await run({ ...prop('quotation.create', q(bad)) });
    check(codes.includes(status(r)) && added(r, 'pending_actions').length === 0, `${why} is refused at the door (${codes.join(' or ')}), nothing held (got ${status(r)} ${body(r).error})`);
  }
  const first = [...made({ lineItems: items }), confirm(n + 1)];
  const nq = n + 1;   // the quotation is the next record: its document id is found from the write
  r = await run({ before: first, method: 'GET', path: '/engine/quotations', role: 'accountant' });
  const qid = ((body(r).result || {}).quotations || [])[0]?.id;
  check(typeof qid === 'number', 'the quotation can be found to revise');
  const rev = (payload) => prop('quotation.revise', { quotationId: qid, ...payload });
  const newLines = [jline({ quantityMilli: 4000 })];
  r = await run({ before: [...first, rev({ lines: newLines, lineItems: [{ lineNo: 1, itemId: 1 }] })], ...confirm(n + 2) });
  check(status(r) === 200 && JSON.stringify(JSON.parse(added(r, 'eng_document')[0].terms_json).lineItems) === JSON.stringify([{ lineNo: 1, itemId: 1 }]), 'a revision with new lines and new lineItems names the NEW items on the new document');
  r = await run({ before: [...first, rev({ lines: newLines })], ...confirm(n + 2) });
  check(status(r) === 200 && !('lineItems' in JSON.parse(added(r, 'eng_document')[0].terms_json)), 'new lines with no lineItems name no items (the old line numbers may not mean the same lines now)');
  r = await run({ before: [...first, rev({ validUntil: '2026-12-01' })], ...confirm(n + 2) });
  check(status(r) === 200 && JSON.stringify(JSON.parse(added(r, 'eng_document')[0].terms_json).lineItems) === JSON.stringify(items), 'a revision that leaves the lines alone carries the item naming forward');
  r = await run({ before: first, ...rev({ lineItems: items }) });
  check(status(r) === 422 && added(r, 'pending_actions').length === 0, 'lineItems without lines is refused (naming goes with the lines it names)');
  r = await run({ before: first, ...rev({ lines: newLines, lineItems: [{ lineNo: 1, itemId: 99 }] }) });
  check(status(r) >= 400 && status(r) < 500 && added(r, 'pending_actions').length === 0, 'a revision naming an item that does not exist is refused at the door');
});

if (require.main === module) kit.standalone(module.exports);
