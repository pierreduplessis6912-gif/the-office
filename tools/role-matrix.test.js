const fs = require('fs');
const path = require('path');
const os = require('os');
const esbuild = require('esbuild');
const src = fs.readFileSync(process.env.SRC || path.join(__dirname, '..', 'worker', 'src', 'auth.ts'), 'utf8');

const roleCaps = src.match(/const ROLE_CAPABILITIES[^=]*=\s*\{[\s\S]*?\n\};/)[0];
const start = src.indexOf('const ENFORCE_CAPABILITIES');
const end = src.indexOf('// The signed-in member, or null.');
if (start < 0 || end < 0) throw new Error('could not extract the deployed decision code');
const code = roleCaps + '\n' + src.slice(start, end) + '\nmodule.exports = { authorizeRestrictedMember, ENFORCE_CAPABILITIES };';
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

  console.log(`\n${total - fails}/${total} decisions correct` + (fails ? `  —  ${fails} WRONG` : '  —  all correct'));
  process.exit(fails ? 1 : 0);
})();
