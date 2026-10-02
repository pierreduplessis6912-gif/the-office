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
                  ['GET','/suppliers/2/discrepancies'],['POST','/suppliers/discrepancies/4/resolve'],
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
  ]);
  const probes = [...unionIntents, null, undefined, '', 'some_future_intent', 'constructor', '__proto__', 'toString'];
  for (const role of ['owner', 'accountant', 'installer', 'stranger'])
    for (const intent of probes) {
      const caps = RC[role] || [];
      if (DECIDED_DIFFERENCES.has(`${role}:${intent}`)) continue;
      check((intentCreationRefusal(intent, caps) === null) === oldAllows(intent, caps), `creation decision changed for ${role} / ${String(intent)} (old logic ${oldAllows(intent, caps) ? 'allowed' : 'refused'})`);
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
  // And the refusal wording that people actually see is unchanged.
  check(/payments, invoices, quotations, or supplier transactions/.test(intentCreationRefusal('payment', RC.installer) || ''), 'money refusal wording changed');
  check(/Managing leads isn't available/.test(intentCreationRefusal('lose_lead', RC.accountant) || ''), 'leads refusal wording changed');

  console.log(`\n${total - fails}/${total} decisions correct` + (fails ? `  —  ${fails} WRONG` : '  —  all correct'));
  process.exit(fails ? 1 : 0);
})();
