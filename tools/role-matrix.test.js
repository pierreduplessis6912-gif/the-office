const fs = require('fs');
const path = require('path');
const os = require('os');
const esbuild = require('esbuild');
const src = fs.readFileSync(process.env.SRC || path.join(__dirname, '..', 'worker', 'src', 'auth.ts'), 'utf8');

const roleCaps = src.match(/const ROLE_CAPABILITIES[^=]*=\s*\{[\s\S]*?\n\};/)[0];
const start = src.indexOf('const ENFORCE_CAPABILITIES');
const end = src.indexOf('// The signed-in member, or null.');
if (start < 0 || end < 0) throw new Error('could not extract the deployed decision code');
const code = roleCaps + '\n' + src.slice(start, end) + '\nmodule.exports = { authorizeRestrictedMember, ENFORCE_CAPABILITIES, INTENT_RULES, intentCreationRefusal, ACTION_TYPE_CAPABILITY, ROLE_CAPABILITIES };';
const js = esbuild.transformSync(code, { loader: 'ts', format: 'cjs', target: 'es2022' }).code;
const compiled = path.join(os.tmpdir(), 'role-matrix-decision-under-test.js');
fs.writeFileSync(compiled, js);

global.Response = class { static json(body, init) { const r = new this(); r.status = (init && init.status) || 200; r.body = body; return r; } };
const { authorizeRestrictedMember, ENFORCE_CAPABILITIES } = require(compiled);
if (ENFORCE_CAPABILITIES !== true) throw new Error('test is not running with the switch on');

const actionTypes = { 1:'job_scope_amendment', 2:'project_ambiguity', 3:'goods_received', 4:'ambiguous_person', 5:'customer_fact', 6:'identity_collision',
  7:'payment', 8:'invoice', 9:'quotation', 10:'expense', 11:'supplier_invoice', 12:'supplier_payment', 13:'variance_disposition', 14:'convert_quote',
  15:'character_fact', 16:'imported_invoice', 17:'schema_candidate', 18:'some_future_type' };
const env = { OFFICE_DB: { prepare: () => ({ bind: (id) => ({ first: async () => actionTypes[id] ? { type: actionTypes[id] } : null }) }) } };

async function allowed(role, method, path) {
  const res = await authorizeRestrictedMember({ method }, env, new URL('https://x' + path), role);
  return res === null;
}
let fails = 0, total = 0;
async function expect(role, method, path, want) {
  total++;
  const got = await allowed(role, method, path);
  if (got !== want) { fails++; console.log(`FAIL  ${role.padEnd(10)} ${method.padEnd(6)} ${path}  ->  ${got ? 'ALLOWED' : 'denied'}, wanted ${want ? 'allowed' : 'denied'}`); }
}

(async () => {
  // Every route the app and server actually use, by role.
  const both = [ ['POST','/messages/text'],['POST','/files/audio'],['POST','/files/photo'],['POST','/files/document'],
                 ['GET','/actions/pending'],['GET','/embers/pending'],['GET','/business-profile/logo'],['GET','/stock'],['GET','/customers'],
                 ['GET','/debug/characters-list'] ];
  const jobs = [ ['GET','/projects'],['GET','/snags'],['POST','/snags/5/resolve'],['POST','/tasks/3/done'],['GET','/embers/tasks'],['GET','/embers/scheduler'],
                 ['GET','/debug/schedule'],['GET','/debug/tasks-list'] ];
  const money = [ ['GET','/customers/1/profitability'],['PATCH','/invoices/3'],['PATCH','/quotations/3'],['PATCH','/customers/3'],
                  ['GET','/suppliers/2/discrepancies'],['POST','/suppliers/discrepancies/4/resolve'],['GET','/delivery-exceptions'],
                  ['GET','/embers/finance'],['GET','/embers/expenses'],['GET','/embers/suppliers'],
                  ['GET','/debug/financial-snapshot'],['GET','/debug/suppliers-list'],['GET','/debug/finance-list'] ];
  const ownerOnly = [ ['GET','/leads'],['POST','/leads/1/mark-lost'],['POST','/business-profile/logo'],
                      ['POST','/files/customers-csv-import'],['POST','/files/invoices-csv-import'],['GET','/some/brand/new/route'],['POST','/actions/999/confirm'],
                      ['GET','/debug/captures'] ];  // owner-only by direct instruction, unfiltered dictation history
  const jobActions = [1,2,4,5,6], moneyActions = [7,8,9,10,11,12,13,14], ownerActions = [15,16,17,18];

  for (const [m,p] of both)      { await expect('installer',m,p,true);  await expect('accountant',m,p,true); }
  for (const [m,p] of jobs)      { await expect('installer',m,p,true);  await expect('accountant',m,p,false); }
  for (const [m,p] of money)     { await expect('installer',m,p,false); await expect('accountant',m,p,true); }
  for (const [m,p] of ownerOnly) { await expect('installer',m,p,false); await expect('accountant',m,p,false); }
  for (const id of jobActions)   for (const act of ['confirm','reject','edit-field']) { await expect('installer','POST',`/actions/${id}/${act}`,true); }
  for (const id of [1,2])        for (const act of ['confirm','reject']) { await expect('accountant','POST',`/actions/${id}/${act}`,false); }
  for (const id of [4,5,6])      { await expect('accountant','POST',`/actions/${id}/confirm`,true); }
  await expect('installer','POST','/actions/3/confirm',true);   // goods received: installers take deliveries
  await expect('accountant','POST','/actions/3/confirm',true);
  for (const id of moneyActions.filter(i => i !== 3)) { await expect('installer','POST',`/actions/${id}/confirm`,false); await expect('accountant','POST',`/actions/${id}/confirm`,true); }
  for (const id of ownerActions) for (const r of ['installer','accountant']) await expect(r,'POST',`/actions/${id}/confirm`,false);
  // The owner is never restricted, including by a capability the owner's own list lacks.
  for (const [m,p] of [...both,...jobs,...money,...ownerOnly]) await expect('owner',m,p,true);
  await expect('owner','POST','/actions/15/confirm',true);
  // An unknown role gets nothing beyond the open routes.
  await expect('stranger','GET','/customers',false);
  await expect('stranger','POST','/messages/text',true);

  // ---- Creation-time rules (INTENT_RULES) --------------------------------
  // The 165 cases above only ever covered CONFIRM-time and REST decisions.
  // Creation-time gating lived in index.ts and had no coverage at all, which
  // is how five financial intents went ungated while this suite stayed green.
  const { INTENT_RULES, intentCreationRefusal, ACTION_TYPE_CAPABILITY, ROLE_CAPABILITIES: RC } = require(compiled);
  const srcDir = path.dirname(process.env.SRC || path.join(__dirname, '..', 'worker', 'src', 'auth.ts'));
  const typesSrc = fs.readFileSync(path.join(srcDir, 'types.ts'), 'utf8');
  const indexSrc = fs.readFileSync(path.join(srcDir, 'index.ts'), 'utf8');
  const unionIntents = typesSrc.match(/intent:\s*((?:"[a-z_]+"\s*\|?\s*)+);/)[1].match(/"([a-z_]+)"/g).map((x) => x.replace(/"/g, ''));
  const check = (cond, msg) => { total++; if (!cond) { fails++; console.log('FAIL  ' + msg); } };
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

  // (a) Exhaustive both ways: every intent has a row, and no row is an orphan.
  check(unionIntents.length >= 20, `could not read the intent union from types.ts (got ${unionIntents.length})`);
  for (const i of unionIntents) check(has(INTENT_RULES, i), `intent "${i}" has no row in INTENT_RULES`);
  for (const i of Object.keys(INTENT_RULES)) check(unionIntents.includes(i), `INTENT_RULES has a row "${i}" that is not in the intent union`);

  // (b) Every held action type an intent produces is one the confirm side knows about.
  const ownerOnlyTypes = ['character_fact', 'imported_invoice', 'schema_candidate'];
  for (const [i, r] of Object.entries(INTENT_RULES))
    for (const t of r.produces) check(has(ACTION_TYPE_CAPABILITY, t) || ownerOnlyTypes.includes(t), `"${i}" produces "${t}", which ACTION_TYPE_CAPABILITY does not know`);

  // (c)+(d) Any create-vs-confirm disagreement must be a recorded decision (a reason), never an accident.
  const canConfirm = (type, role) => role === 'owner' || (ACTION_TYPE_CAPABILITY[type] || []).some((c) => (RC[role] || []).includes(c));
  for (const [i, r] of Object.entries(INTENT_RULES)) {
    if (r.produces.length === 0) continue;
    for (const role of ['accountant', 'installer']) {
      const create = intentCreationRefusal(i, RC[role]) === null;
      const confirm = r.produces.some((t) => canConfirm(t, role));
      if (create !== confirm) check(Boolean(r.reason), `"${i}": ${role} can ${create ? 'create but never confirm' : 'confirm but not create'} it, and the row carries no reason`);
    }
  }

  // The old hand-kept list must not come back as a second source of truth.
  check(!/FINANCIAL_WRITE_INTENTS/.test(indexSrc), 'index.ts still defines or uses FINANCIAL_WRITE_INTENTS; creation gating belongs in INTENT_RULES only');

  // Equivalence with the logic INTENT_RULES replaced (Phase 0a: no behaviour change).
  // DECIDED_DIFFERENCES lists, by name, every case where behaviour was changed ON PURPOSE
  // since; anything not listed there must still match the old logic exactly.
  const OLD_FINANCIAL = ['payment', 'expense', 'invoice', 'quotation', 'price_scope', 'convert_quote', 'supplier_invoice', 'supplier_payment', 'goods_received', 'purchase_order', 'variance_disposition'];
  const oldAllows = (intent, caps) => OLD_FINANCIAL.includes(intent ?? '') ? caps.includes('can_manage_invoices') : intent === 'lose_lead' ? caps.includes('can_manage_settings') : true;
  const DECIDED_DIFFERENCES = new Set([
    // Decision 1 (2026-10-02): installers may dictate goods received.
    'installer:goods_received',
    // Decision 2 (2026-10-02): money and stock are gated at creation. Stock now needs
    // can_know_materials, which every real role holds, so only a role with no capabilities changes.
    'stranger:register_stock_item', 'stranger:stock_usage', 'stranger:stocktake',
    // Decision 2, upload path (2026-10-02): a supplier statement returns the real balance owed to
    // a supplier, so it is money and needs can_manage_invoices. (A spoken one records nothing.)
    'installer:supplier_statement', 'stranger:supplier_statement',
  ]);
  const probes = [...unionIntents, null, undefined, '', 'some_future_intent', 'constructor', '__proto__', 'toString'];
  for (const role of ['owner', 'accountant', 'installer', 'stranger'])
    for (const intent of probes) {
      const caps = RC[role] || [];
      if (DECIDED_DIFFERENCES.has(`${role}:${intent}`)) continue;
      check((intentCreationRefusal(intent, caps) === null) === oldAllows(intent, caps), `creation decision changed for ${role} / ${String(intent)} (old logic ${oldAllows(intent, caps) ? 'allowed' : 'refused'})`);
    }
  // Decision 3 (2026-10-02): the permission check must run before ANYTHING that can write for a
  // name. reconcileCustomer/reconcileCharacter insert rows, and the identity checks hold actions.
  // Asserted on source order inside processOneExtraction, so a later edit cannot quietly reorder it.
  const fnStart = indexSrc.indexOf('async function processOneExtraction(');
  const fnBody = indexSrc.slice(fnStart);
  const gateAt = fnBody.indexOf('intentCreationRefusal(extraction?.intent, capabilities)');
  check(fnStart > 0 && gateAt > 0, 'could not find the creation gate inside processOneExtraction');
  for (const writer of ['await reconcileCustomer(', 'await reconcileCharacter(', 'holdForConfirmation(', 'ctx.waitUntil(setSelection(', 'ctx.waitUntil(updateCaptureHint(']) {
    const at = fnBody.indexOf(writer);
    check(at < 0 || gateAt < at, `the creation gate must run before "${writer}" inside processOneExtraction, but it comes after`);
  }

  // The decided differences themselves, asserted explicitly so they cannot drift silently.
  check(intentCreationRefusal('goods_received', RC.installer) === null, 'decision 1: an installer must be able to dictate goods received');
  check(intentCreationRefusal('goods_received', RC.accountant) === null && intentCreationRefusal('goods_received', RC.owner) === null, 'goods_received must stay allowed for accountant and owner');
  check(intentCreationRefusal('goods_received', RC.stranger || []) !== null, 'goods_received must stay refused for a role with no capabilities');
  for (const i of ['register_stock_item', 'stock_usage', 'stocktake']) {
    for (const role of ['owner', 'accountant', 'installer']) check(intentCreationRefusal(i, RC[role]) === null, `${role} must still be able to dictate ${i}`);
    check(/Recording stock isn't available/.test(intentCreationRefusal(i, []) || ''), `${i} must be refused, with the stock wording, for a role with no capabilities`);
  }
  check(intentCreationRefusal('purchase_order', RC.installer) !== null, 'purchase_order (a direct write; this gate is its only gate) must stay refused for installers');
  // ---- Upload path (decision 2, 2026-10-02) ---------------------------------
  // /files/document and /files/photo decide by the supplier an upload resolves to, not by a spoken
  // intent, so they ask the same table using three keys: supplier_invoice (a held money action),
  // goods_received (a direct stock write) and supplier_statement (a money read).
  const uploadOutputs = { supplier_invoice: { owner: true, accountant: true, installer: false },
                          goods_received: { owner: true, accountant: true, installer: true },
                          supplier_statement: { owner: true, accountant: true, installer: false } };
  for (const [out, byRole] of Object.entries(uploadOutputs))
    for (const [role, want] of Object.entries(byRole))
      check((intentCreationRefusal(out, RC[role]) === null) === want, `upload output "${out}" for ${role}: expected ${want ? 'allowed' : 'refused'}`);
  check(/Checking supplier statements isn't available/.test(intentCreationRefusal('supplier_statement', RC.installer) || ''), 'statement refusal wording changed');
  // Source-pattern guards: both handlers must keep every guard. Crude on purpose, and mutation-checked.
  const handlerSlice = (marker) => { const a = indexSrc.indexOf(marker); const b = indexSrc.indexOf('if (url.pathname === "', a + marker.length); return indexSrc.slice(a, b); };
  for (const [name, marker, respVar] of [['/files/document', 'if (url.pathname === "/files/document"', 'docResponseBody'], ['/files/photo', 'if (url.pathname === "/files/photo"', 'photoResponseBody']]) {
    const h = handlerSlice(marker);
    check(h.length > 500, `could not isolate the ${name} handler`);
    check(h.includes('resolveCapabilities(request, env)'), `${name}: must read the caller's capabilities`);
    // A held supplier invoice (money): its refusal branch must come before the hold that creates it.
    const siHold = h.search(/holdForConfirmation\(\s*env,\s*"supplier_invoice"/);
    check(h.includes('&& supplierInvoiceRefusal) {') && siHold > 0 && h.indexOf('&& supplierInvoiceRefusal) {') < siHold, `${name}: the supplier-invoice refusal branch must come before the hold it guards`);
    // A statement reconciliation (a money read): its refusal branch must come before the balance is read.
    check(h.includes('&& statementRefusal) {') && h.indexOf('&& statementRefusal) {') < h.indexOf('getOutstandingBalanceForSupplier('), `${name}: the statement refusal branch must come before the balance is read`);
    // Goods received: the permission flows into the plan, and a refused plan is handled before anything is held or recorded.
    check(h.includes('planDelivery(classified, { mustHold: inferredFromDocument, refused: Boolean(goodsReceivedRefusal) })'), `${name}: the delivery plan must carry both the permission and the inferred-supplier flag`);
    const iRefuse = h.indexOf('plan.action === "refuse"'), iHold = h.indexOf('plan.action === "hold"'), iRecord = h.indexOf('plan.action === "record"');
    check(iRefuse > 0 && iRefuse < iHold && iHold < iRecord && iRecord < h.indexOf('recordGoodsReceived('), `${name}: a delivery must be refused, then held, then recorded, in that order of checks`);
    check(new RegExp(respVar + ' = JSON\\.stringify\\(\\{ status: "stored", refusal: uploadRefusal').test(h), `${name}: the response must carry the refusal`);
  }

  // ---- Document-first identification (2026-10-03) -----------------------------------
  // A supplier document says what it is and who issued it, so an upload no longer needs a caption.
  // The AI only READS the printed kind and issuer; whether that is one of OUR suppliers is decided
  // by plain code, tested here, and an inferred match is held for confirmation, never recorded directly.
  const bundleTo = (entry, name) => { const out = path.join(os.tmpdir(), name); esbuild.buildSync({ entryPoints: [path.join(srcDir, entry)], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent' }); return require(out); };
  const { matchIssuerToSuppliers, businessNameWords } = bundleTo('identity.ts', 'rm-identity.js');
  const docsMod = bundleTo('documents.ts', 'rm-documents.js');
  const S = (id, name) => ({ id, name });
  const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  // The matcher: deterministic, existing suppliers only, never guesses between two.
  let m = matchIssuerToSuppliers([S(1, 'Floornet')], 'FLOORNET (PTY) LTD');
  check(m.kind === 'one' && m.supplier.id === 1 && m.strength === 'exact', 'issuer "FLOORNET (PTY) LTD" must match supplier "Floornet" exactly');
  m = matchIssuerToSuppliers([S(1, 'Floornet (Pty) Ltd')], 'floornet');
  check(m.kind === 'one' && m.strength === 'exact', 'legal suffixes and case must not matter, in either direction');
  m = matchIssuerToSuppliers([S(1, 'Floornet')], 'Floornet Durban Branch');
  check(m.kind === 'one' && m.strength === 'partial', 'a longer printed name that contains the supplier is a partial match');
  m = matchIssuerToSuppliers([S(1, 'Floornet'), S(2, 'floornet')], 'Floornet');
  check(m.kind === 'many' && m.suppliers.length === 2, 'two suppliers at the same level must be reported as ambiguous, never picked between');
  m = matchIssuerToSuppliers([S(1, 'Floornet'), S(2, 'Floornet Durban')], 'Floornet');
  check(m.kind === 'one' && m.supplier.id === 1 && m.strength === 'exact', 'an exact match must beat a partial one');
  check(matchIssuerToSuppliers([S(1, 'Floornet')], 'Acme Adhesives').kind === 'none', 'an unrelated issuer matches nothing');
  check(matchIssuerToSuppliers([S(1, 'Floornet')], 'Floor').kind === 'none', 'no substring matching: "Floor" must not match "Floornet"');
  check(matchIssuerToSuppliers([S(1, 'Floornet')], '').kind === 'none' && matchIssuerToSuppliers([S(1, 'Floornet')], 'Pty Ltd').kind === 'none', 'an issuer with no real words matches nothing');
  check(matchIssuerToSuppliers([S(1, 'The Company')], 'Floornet').kind === 'none', 'a supplier whose name is only noise words is never matched');
  check(matchIssuerToSuppliers([], 'Floornet').kind === 'none', 'no suppliers, no match');
  check(sameJson(businessNameWords('Floornet (Pty) Ltd.'), ['floornet']), 'name normalisation should reduce "Floornet (Pty) Ltd." to "floornet"');
  check(sameJson(businessNameWords('Café Ünïcode & Sons'), ['cafe', 'unicode', 'sons']), 'accents and "&" should normalise');

  // The inference helper, with a fake AI and a fake database.
  const mkEnv = ({ reply, throws, suppliers }) => { const calls = { db: [] }; return { calls, env: {
    AI: { run: async () => { if (throws) throw new Error('model unavailable'); return { choices: [{ message: { content: reply } }] }; } },
    OFFICE_DB: { prepare: (sql) => ({ all: async () => { calls.db.push(sql); return { results: suppliers || [] }; } }) } } }; };
  const infer = async (cfg) => { const { env, calls } = mkEnv(cfg); return { r: await docsMod.inferDocumentSupplier(env, 'document text'), calls }; };
  let o = await infer({ reply: '{"document_type":"delivery_note","issuer_name":"Floornet (Pty) Ltd"}', suppliers: [S(7, 'Floornet')] });
  check(o.r.kind === 'delivery_note' && o.r.match && o.r.match.kind === 'one' && o.r.match.supplier.id === 7, 'a delivery note from a known supplier must be recognised');
  o = await infer({ reply: '```json\n{"document_type":"supplier_invoice","issuer_name":"Floornet"}\n```', suppliers: [S(7, 'Floornet')] });
  check(o.r.kind === 'supplier_invoice' && o.r.match && o.r.match.kind === 'one', 'a code-fenced model reply must still parse');
  o = await infer({ reply: '{"document_type":"other","issuer_name":null}', suppliers: [S(7, 'Floornet')] });
  check(o.r.kind === 'other' && o.r.match === null && o.calls.db.length === 0, 'a site photo or anything else must do nothing, and never touch the supplier list');
  o = await infer({ reply: '{"document_type":"other","issuer_name":"Floornet"}', suppliers: [S(7, 'Floornet')] });
  check(o.r.kind === 'other' && o.r.issuer === null && o.calls.db.length === 0, 'an issuer given for an "other" document must be dropped');
  o = await infer({ reply: '{"document_type":"receipt","issuer_name":"Floornet"}', suppliers: [S(7, 'Floornet')] });
  check(o.r.kind === 'other', 'an unknown document type must become "other", never be trusted');
  o = await infer({ reply: 'not json at all', suppliers: [S(7, 'Floornet')] });
  check(o.r.kind === 'other' && o.calls.db.length === 0, 'an unparseable model reply must do nothing');
  o = await infer({ throws: true, suppliers: [S(7, 'Floornet')] });
  check(o.r.kind === 'other' && o.calls.db.length === 0, 'a failing model call must do nothing, not throw');
  o = await infer({ reply: '{"document_type":"delivery_note","issuer_name":null}', suppliers: [S(7, 'Floornet')] });
  check(o.r.kind === 'delivery_note' && o.r.issuer === null && o.r.match === null && o.calls.db.length === 0, 'a delivery note with no readable issuer must say so, without guessing');
  o = await infer({ reply: JSON.stringify({ document_type: 'delivery_note', issuer_name: 'x'.repeat(200) }), suppliers: [S(7, 'Floornet')] });
  check(o.r.issuer === null, 'an implausibly long issuer must be rejected');
  o = await infer({ reply: '{"document_type":"delivery_note","issuer_name":"Acme Adhesives"}', suppliers: [S(7, 'Floornet')] });
  check(o.r.match && o.r.match.kind === 'none', 'an issuer that is not one of our suppliers must match nothing, and must not create one');
  o = await infer({ reply: '{"document_type":"supplier_statement","issuer_name":"Floornet"}', suppliers: [S(7, 'Floornet'), S(8, 'Floornet')] });
  check(o.r.match && o.r.match.kind === 'many', 'two equally good suppliers must be reported as ambiguous');
  const supplierSql = o.calls.db[0] || '';
  check(/merged_into_character_id IS NULL/.test(supplierSql) && /purchase_orders/.test(supplierSql) && /supplier/i.test(supplierSql) && /^\s*SELECT/i.test(supplierSql), 'the supplier lookup must be a read-only SELECT that excludes merged duplicates and covers suppliers we have ordered from');

  // The extractor on its own (not only through the helper, which would mask a regression here).
  const aiMod = bundleTo('ai.ts', 'rm-ai.js');
  const extract = async (reply) => aiMod.extractDocumentIdentity({ AI: { run: async () => ({ choices: [{ message: { content: reply } }] }) } }, 'text');
  let e = await extract('{"document_type":"other","issuer_name":"Floornet"}');
  check(e.document_type === 'other' && e.issuer_name === null, 'extractor: an "other" document must never carry an issuer');
  e = await extract('{"document_type":"delivery_note","issuer_name":"  Floornet (Pty) Ltd  "}');
  check(e.document_type === 'delivery_note' && e.issuer_name === 'Floornet (Pty) Ltd', 'extractor: the issuer is trimmed and otherwise kept as printed');
  e = await extract('{"document_type":"delivery_note","issuer_name":42}');
  check(e.document_type === 'delivery_note' && e.issuer_name === null, 'extractor: a non-text issuer must become null');
  e = await extract('{"document_type":"DELIVERY_NOTE","issuer_name":"Floornet"}');
  check(e.document_type === 'other', 'extractor: document types are matched exactly, never loosely');

  // The handlers: both must use document-first only when nothing was stated, and an inferred delivery must be HELD.
  for (const [name, marker] of [['/files/document', 'if (url.pathname === "/files/document"'], ['/files/photo', 'if (url.pathname === "/files/photo"']]) {
    const h = handlerSlice(marker);
    const gate = h.indexOf('if (!subjectCharacterId && !subjectCustomerId) {');
    const call = h.indexOf('inferDocumentSupplier(env, description)');
    check(gate > 0 && call > gate, `${name}: document-first must run only when no subject was stated (caption wins)`);
    check(h.includes('lineItems: plan.lines'), `${name}: a held delivery must carry exactly the planned lines`);
    check(h.includes('mustHold: inferredFromDocument'), `${name}: a delivery whose supplier was read from the document must be held`);
    const holdAt = h.indexOf('plan.action === "hold"');
    check(/holdForConfirmation\(\s*env,\s*"goods_received"/.test(h.slice(holdAt, holdAt + 600)), `${name}: the held delivery must be a goods_received confirmation`);
    check((h.match(/await reconcileDelivery\(/g) || []).length === 2, `${name}: a delivery must be reconciled both against an open order and, for a delivery note, against none`);
    check(h.includes('await reconcileDelivery(subjectCharacterId, null, [])') && h.includes('extractDocumentIdentity(env, description)'), `${name}: a delivery note with no open order must still be received, and only a delivery note`);
    check(/if \(isDeliveryNote\) \{\s*await reconcileDelivery\(subjectCharacterId, null, \[\]\)/.test(h), `${name}: with no open order, only a document that is a delivery note may be received (an invoice or statement must not be logged as a delivery)`);
    check(h.includes('? documentKind === "delivery_note"') , `${name}: for a supplier read from the document, the delivery-note decision must come from the document's own kind`);
    check(/message: uploadRefusal \?\? uploadMessage, pendingActionId: uploadHeldActionId/.test(h), `${name}: the response must carry the message and the held action id`);
    check(h.includes("there's no open order for them") && h.includes("couldn't make out any items"), `${name}: the "nothing recorded" cases must explain themselves`);
  }
  // Goods received (decided 2026-10-03, Pierre): a delivery of items that were never ordered is RECEIVED
  // and reported as a delivery exception, not refused. History: such a line was once recorded as the
  // literal text "unmatched item", its real name lost.
  const finMod = bundleTo('finance.ts', 'rm-finance.js');
  const { classifyGoodsReceivedLines, getDeliveryExceptions, recordGoodsReceived } = finMod;
  const PO = [{ description: 'Vinyl' }, { description: 'Underlay' }];
  const L = (m, q, d, u) => ({ matched_description: m, quantity_received: q, item_description: d === undefined ? m : d, unit: u || null });
  let cl = classifyGoodsReceivedLines([L(null, 2, 'MARBLE CHARCOAL 011 5m2', 'Box')], PO);
  check(cl.matched.length === 0 && cl.exceptions.length === 1 && cl.exceptions[0].item_description === 'MARBLE CHARCOAL 011 5m2', 'an item that matches nothing, but is named on the delivery, is an exception that keeps its real name');
  cl = classifyGoodsReceivedLines([L('Vinyl', 50), L('Underlay', 40)], PO);
  check(cl.matched.length === 2 && cl.exceptions.length === 0, 'lines that match the order stay matched');
  cl = classifyGoodsReceivedLines([L('Vinyl', 50), L(null, 5, 'grout', 'bag')], PO);
  check(cl.matched.length === 1 && cl.exceptions.length === 1 && cl.dropped.length === 0, 'a mixed delivery is split into matched lines and exceptions');
  cl = classifyGoodsReceivedLines([L('MARBLE CHARCOAL', 2, 'marble charcoal tiles')], PO);
  check(cl.matched.length === 0 && cl.exceptions.length === 1, 'a name the model supplied that is not on the order is an exception, never a match');
  cl = classifyGoodsReceivedLines([L('Some Made Up Item', 2, null)], PO);
  check(cl.exceptions.length === 1 && cl.exceptions[0].item_description === 'Some Made Up Item', 'with no item name on the delivery, the model\'s own wording is used rather than losing the line');
  cl = classifyGoodsReceivedLines([L(null, 2, null)], PO);
  check(cl.matched.length === 0 && cl.exceptions.length === 0 && cl.dropped.length === 1, 'a line with no name at all is dropped, never recorded as an anonymous item');
  cl = classifyGoodsReceivedLines([L(null, 0, 'grout'), L(null, -3, 'grout'), L(null, NaN, 'grout')], PO);
  check(cl.exceptions.length === 0 && cl.dropped.length === 3, 'an exception needs a real positive quantity');
  cl = classifyGoodsReceivedLines([L('Vinyl', 0)], PO);
  check(cl.matched.length === 1, 'a matched line with quantity 0 is a real shortage and stays matched');
  cl = classifyGoodsReceivedLines([L('vinyl', 5)], PO);
  check(cl.matched.length === 1, 'matching is case-insensitive, exactly as recording does it');
  cl = classifyGoodsReceivedLines([L('Vinyl', 5), L(null, 1, 'trim')], []);
  check(cl.matched.length === 0 && cl.exceptions.length === 2, 'with no order at all, every named item is an exception');

  // The plan (pure): what is done, and by whom it must be confirmed.
  const { planDelivery, deliveryHeldMessage } = docsMod;
  const cls = (m, e) => ({ matched: new Array(m).fill(1), exceptions: new Array(e).fill(2) });
  check(planDelivery(cls(0, 0), { mustHold: false, refused: false }).action === 'none', 'nothing usable: nothing is done');
  check(planDelivery(cls(0, 0), { mustHold: false, refused: true }).action === 'none', 'nothing usable and refused: still just nothing');
  check(planDelivery(cls(1, 0), { mustHold: false, refused: false }).action === 'record', 'a stated supplier with matched lines is recorded directly');
  check(planDelivery(cls(1, 1), { mustHold: true, refused: false }).action === 'hold', 'a supplier that was read or heard is held for confirmation');
  check(planDelivery(cls(0, 2), { mustHold: false, refused: false }).action === 'record', 'a delivery of only unordered items is received too');
  check(planDelivery(cls(0, 2), { mustHold: true, refused: false }).action === 'hold', 'and held when the supplier was read');
  check(planDelivery(cls(2, 0), { mustHold: true, refused: true }).action === 'refuse', 'a role that may not record deliveries is refused, before anything is held');
  const pl = planDelivery(cls(2, 3), { mustHold: false, refused: false });
  check(pl.lines.length === 5 && pl.matchedCount === 2 && pl.exceptionCount === 3, 'the plan carries every line and the counts');
  check(/#12/.test(deliveryHeldMessage({ matchedCount: 1, exceptionCount: 0 }, 'Floornet', true, 12, true)) && /read from the document/.test(deliveryHeldMessage({ matchedCount: 1, exceptionCount: 0 }, 'Floornet', true, 12, true)), 'a held delivery says what it is, that it was read, and its action number');
  check(!/read from the document/.test(deliveryHeldMessage({ matchedCount: 1, exceptionCount: 0 }, 'Floornet', false, 12, true)), 'a spoken delivery does not claim to have been read from a document');
  check(/1 item\(s\) aren't on the order/.test(deliveryHeldMessage({ matchedCount: 2, exceptionCount: 1 }, 'Floornet', false, 5, true)), 'a mixed delivery says how many items are not on the order');
  check(/nothing that's on their open order/.test(deliveryHeldMessage({ matchedCount: 0, exceptionCount: 2 }, 'Floornet', false, 5, true)) && /delivery exception/.test(deliveryHeldMessage({ matchedCount: 0, exceptionCount: 2 }, 'Floornet', false, 5, true)), 'a delivery with nothing on the order says so and that it will be logged as an exception');
  check(/no open order/.test(deliveryHeldMessage({ matchedCount: 0, exceptionCount: 2 }, 'Floornet', false, 5, false)), 'a delivery from a supplier with no open order says that');

  // recordGoodsReceived against a fake database (the real SQL is checked separately, on a real database).
  // This caught nothing before it existed: the first version crashed on exactly this input, because an
  // exception line has an ordered quantity of 0 (not null) but no order line to read a name from.
  const mkGrnDb = ({ poLines = [], stock = [] }) => { const log = { header: [], lines: [], stockUpdates: [] }; let lineId = 100;
    const stmt = (sql, binds = []) => ({ bind: (...b) => stmt(sql, b),
      first: async () => { if (/INSERT INTO goods_received_notes/.test(sql)) { log.header.push(binds); return { id: 8 }; }
        if (/INSERT INTO grn_line_items/.test(sql)) { log.lines.push({ po: binds[1], description: binds[2], received: binds[3], ordered: binds[4], variance: binds[5] }); return { id: ++lineId }; }
        if (/FROM stock_items WHERE name/.test(sql)) { const hit = stock.find((s) => s.name.toLowerCase() === String(binds[0]).toLowerCase()); return hit ? { id: hit.id } : null; }
        return null; },
      all: async () => (/FROM po_line_items/.test(sql) ? { results: poLines } : { results: [] }),
      run: async () => { if (/UPDATE stock_items/.test(sql)) log.stockUpdates.push(binds); return {}; } });
    return { env: { OFFICE_DB: { prepare: (sql) => stmt(sql) } }, log }; };
  const POLINES = [{ id: 1, description: 'Vinyl', quantity_ordered: 50, unit: 'sqm', unit_price_expected: null, product_id: null }];
  let g = mkGrnDb({ poLines: POLINES, stock: [{ id: 3, name: 'Grout' }] });
  let rg = await recordGoodsReceived(g.env, 9, 11, 'src', [L('Vinyl', 50, 'vinyl'), L(null, 5, 'Grout', 'bag')], 'p@x.com');
  check(g.log.lines.length === 2 && g.log.lines[0].description === 'Vinyl' && g.log.lines[0].variance === 0, 'the matched line is recorded against its order line');
  check(g.log.lines[1].description === 'Grout [bag]' && g.log.lines[1].ordered === 0 && g.log.lines[1].variance === 5 && g.log.lines[1].po === null, 'an unordered item is recorded under its real name with an ordered quantity of 0, so its variance is what arrived');
  check(rg.exceptions.length === 1 && rg.exceptions[0].grnLineItemId === 102 && rg.exceptions[0].description === 'Grout', 'the exception is returned, with its line id');
  check(rg.variances.length === 2 && rg.variances[1].description === 'Grout [bag]', 'the exception also appears among the variances, under the recorded name');
  check(g.log.stockUpdates.length === 1 && g.log.stockUpdates[0][0] === 5, 'an unordered item that is a registered stock item still adds to stock, by exact name');
  g = mkGrnDb({ poLines: [] });
  rg = await recordGoodsReceived(g.env, 0, 14, 'src', [L(null, 3, 'Hercules 550 carpet', 'roll')]);
  check(g.log.header[0][0] === 0 && rg.exceptions.length === 1 && g.log.lines[0].description === 'Hercules 550 carpet [roll]', 'a delivery against no order at all is recorded with order id 0 and its exception line');
  g = mkGrnDb({ poLines: POLINES });
  rg = await recordGoodsReceived(g.env, 9, 11, 'older held action', [{ matched_description: null, quantity_received: 1 }]);
  check(rg.exceptions.length === 0 && g.log.lines[0].description === 'unmatched item' && g.log.lines[0].ordered === null && g.log.lines[0].variance === null, 'a line from an older held action, with no name, is still recorded the old way and is not an exception');

  // The report: statuses, and the exception signature must not drift.
  let reportBinds = null;
  const reportEnv = { OFFICE_DB: { prepare: (sql) => ({ bind: (...b) => { reportBinds = b; reportSql = sql; return { all: async () => ({ results: [
    { grn_line_item_id: 1, grn_id: 8, supplier_id: 11, supplier_name: 'Floornet', description: 'Grout [bag]', quantity_received: 5, purchase_order_id: 9, recorded_by: 'p@x.com', created_at: '2026-10-03', disposition_id: null, reason: null, resolution: null },
    { grn_line_item_id: 2, grn_id: 9, supplier_id: 14, supplier_name: 'Belgotex', description: 'Carpet [roll]', quantity_received: 3, purchase_order_id: 0, recorded_by: null, created_at: '2026-10-02', disposition_id: 4, reason: 'extra', resolution: 'accepted' } ] }) }; } }) } };
  let reportSql = '';
  const rep1 = await getDeliveryExceptions(reportEnv, 'all');
  check(rep1[0].status === 'open' && rep1[0].hadOpenOrder === true && rep1[1].status === 'resolved' && rep1[1].hadOpenOrder === false && rep1[1].resolution === 'accepted', 'the report marks open and resolved correctly, and whether there was an open order');
  check(reportBinds[0] === 'all', 'the report passes its status filter as a bound parameter');
  check(/po_line_item_id IS NULL AND gli\.quantity_ordered = 0/.test(reportSql) && /SELECT/i.test(reportSql) && !/INSERT|UPDATE|DELETE/i.test(reportSql), 'the report identifies exceptions by no order line and an ordered quantity of 0, and is read-only');
  await getDeliveryExceptions(reportEnv);
  check(reportBinds[0] === 'open', 'the report defaults to open exceptions only');

  // The extractor now carries the item's name and unit, sanitised.
  const extractGR = async (reply) => aiMod.extractGoodsReceived({ AI: { run: async () => ({ choices: [{ message: { content: reply } }] }) } }, 'text', []);
  let xg = await extractGR('{"supplier_name":"Floornet","line_items":[{"matched_description":null,"item_description":"  MARBLE CHARCOAL 011  ","unit":" Box ","quantity_received":2}]}');
  check(xg.line_items[0].item_description === 'MARBLE CHARCOAL 011' && xg.line_items[0].unit === 'Box' && xg.line_items[0].quantity_received === 2, 'extractor: the item name and unit are kept, trimmed');
  xg = await extractGR('{"supplier_name":null,"line_items":[{"matched_description":"   ","item_description":42,"unit":{},"quantity_received":"7"}]}');
  check(xg.line_items[0].matched_description === null && xg.line_items[0].item_description === null && xg.line_items[0].unit === null && xg.line_items[0].quantity_received === 7, 'extractor: blank or non-text fields become null and a numeric string becomes a number');
  xg = await extractGR('{"supplier_name":null,"line_items":"none"}');
  check(Array.isArray(xg.line_items) && xg.line_items.length === 0, 'extractor: a line_items that is not a list becomes an empty list');
  xg = await extractGR('{"supplier_name":null,"line_items":[{"matched_description":null,"item_description":"' + 'x'.repeat(400) + '","unit":"' + 'u'.repeat(90) + '","quantity_received":1}]}');
  check(xg.line_items[0].item_description.length === 160 && xg.line_items[0].unit.length === 20, 'extractor: over-long text is bounded');

  // Every path hands the extraction's lines to the classifier, and nothing else ever builds a hold or a record from raw lines.
  const rawUses = (indexSrc.match(/grnExtraction\.line_items/g) || []).length;
  const classUses = (indexSrc.match(/classifyGoodsReceivedLines\(grnExtraction\.line_items, (orderLines|poLineItems)\)/g) || []).length;
  check(rawUses === 3 && classUses === 3, `every goods-received path (document, photo, dictation) must classify through classifyGoodsReceivedLines; raw uses ${rawUses}, classified ${classUses}`);
  check(!/lineItems: grnExtraction\.line_items/.test(indexSrc) && !/splitGoodsReceivedLines/.test(indexSrc), 'a hold must never be built from unclassified goods-received lines');
  const finSrc = fs.readFileSync(path.join(srcDir, 'finance.ts'), 'utf8');
  check(!/last_insert_rowid/.test(finSrc), 'finance.ts must read new ids with RETURNING id, not last_insert_rowid(), which D1 does not guarantee across statements');
  const dictStart = indexSrc.indexOf('if (extraction?.intent === "goods_received") {');
  const dictBody = indexSrc.slice(dictStart, indexSrc.indexOf('Supplier Invoices, the third and final', dictStart));
  check(dictBody.includes('mustHold: true') && dictBody.indexOf('grnPlan.action === "hold"') > 0 && dictBody.indexOf('grnPlan.action === "hold"') < dictBody.indexOf('holdForConfirmation('), 'dictation: a spoken delivery is always held, and only when the plan says to');
  check(/goods_received" && goodsReceivedNoItems\) \{/.test(indexSrc) && !/goodsReceivedNoOpenPo|goodsReceivedNoMatchOnOrder/.test(indexSrc), 'dictation: a delivery with nothing readable gets its own honest reply, and having no open order no longer ends the delivery');
  const confirmAt = indexSrc.indexOf('if (action.type === "goods_received") {');
  check(/logged as delivery exceptions/.test(indexSrc.slice(confirmAt, confirmAt + 2500)), 'confirming a delivery says in words when items were logged as exceptions');
  check(/url\.pathname === "\/delivery-exceptions" && request\.method === "GET"/.test(indexSrc), 'the delivery exception report route must exist');

  // The two inspection routes must stay admin-key only (not in the app's own route list).
  const appDebug = src.match(/const APP_DEBUG_ROUTES = new Set\(\[([\s\S]*?)\]\);/)[1];
  check(!/recent-captures|pending-action/.test(appDebug), 'the inspection routes must not be added to the app route list, which would put them behind a session instead of the admin key');
  const dbgSrc = fs.readFileSync(path.join(srcDir, 'debug.ts'), 'utf8');
  const routeBody = (needle) => { const a = dbgSrc.indexOf(needle); return dbgSrc.slice(a, dbgSrc.indexOf('\nif (url.pathname', a + 10)); };
  for (const needle of ['url.pathname === "/debug/recent-captures"', 'url.pathname === "/debug/pending-action"']) {
    const body = routeBody(needle);
    check(body.length > 100 && !/INSERT|UPDATE|DELETE|DROP|ALTER/i.test(body), `${needle}: an inspection route must be read-only`);
  }

  // And the refusal wording that people actually see is unchanged.
  check(/payments, invoices, quotations, or supplier transactions/.test(intentCreationRefusal('payment', RC.installer) || ''), 'money refusal wording changed');
  check(/Managing leads isn't available/.test(intentCreationRefusal('lose_lead', RC.accountant) || ''), 'leads refusal wording changed');

  console.log(`\n${total - fails}/${total} decisions correct` + (fails ? `  —  ${fails} WRONG` : '  —  all correct'));
  process.exit(fails ? 1 : 0);
})();
