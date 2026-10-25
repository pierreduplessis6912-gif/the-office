// The roles an owner may give (worker/src/auth.ts ROLE_CAPABILITIES, team.ts ASSIGNABLE_ROLES; decided with Pierre 2026-10-18: sales and admin join owner, accountant and installer). A role is not only a list of capabilities: some
// code branches on a role's NAME (the audit found exactly one such branch that matters: only "installer" is scoped to their own jobs), so a new role silently lands on the "not scoped" side of it. These tests pin the definitions, make
// that decision explicit, and scan the whole source so that a NEW role-name branch cannot be added without someone deciding what it means for every role.
const path = require('path'), fs = require('fs'), os = require('os'), esbuild = require('esbuild');

module.exports = async function runRolesTests(context) {
  const standIn = global.Response;
  if (global.__RealResponse) global.Response = global.__RealResponse;
  try { await rolesTests(context); } finally { global.Response = standIn; }
};

async function rolesTests({ check, srcDir }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roles-')), out = path.join(dir, 'auth.js');
  esbuild.buildSync({ entryPoints: [path.join(srcDir, 'auth.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent' });
  const auth = require(out), R = auth.ROLE_CAPABILITIES, sorted = (a) => [...a].sort().join();
  const OWNER_ONLY = ['can_invite_members', 'can_delete_data', 'can_manage_settings'], SENSITIVE = ['can_know_profit', 'can_know_payroll', 'can_know_banking'], MONEY = ['can_manage_invoices', 'can_know_profit', 'can_know_debtors', 'can_know_payroll', 'can_know_banking', 'can_know_expense_totals', 'can_know_supplier_balances'];

  // ---- the definitions ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  check(sorted(R.admin) === sorted(['can_know_debtors', 'can_manage_invoices', 'can_make_quotes', 'can_know_expense_totals', 'can_know_supplier_balances', 'can_know_materials', 'can_know_material_prices', 'can_know_jobs', 'can_know_measurements', 'can_capture_voice_notes']), 'ADMIN is exactly: the office\'s day-to-day running (money in and out, quotations, debtors, expenses, supplier balances, materials and prices, jobs, measurements, voice notes)');
  check(sorted(R.sales) === sorted(['can_know_jobs', 'can_know_measurements', 'can_capture_voice_notes', 'can_know_materials', 'can_know_material_prices', 'can_make_quotes']), 'SALES is exactly an installer\'s capabilities plus QUOTATIONS (since 2026-10-18): jobs, measurements, voice notes, materials and prices, and quoting, and no money');
  for (const role of ['admin', 'sales', 'accountant', 'installer']) check(OWNER_ONLY.every((c) => !R[role].includes(c)), `${role} holds NONE of the owner-only capabilities (invite, delete data, settings)`);
  check(SENSITIVE.every((c) => !R.admin.includes(c)), 'an admin does NOT hold the three most sensitive views by default (profit, payroll, banking): the owner can switch them on per business');
  check(MONEY.every((c) => !R.sales.includes(c)), 'sales holds NO money capability at all: it can quote (its own switch) but cannot confirm payments, raise invoices or see money');
  check(['admin', 'sales'].every((r) => R[r].every((c) => auth.CAPABILITY_BY_KEY[c])), 'every capability either holds is a real, catalogued one (the owner bypasses the table entirely, so "a subset of the owner\'s list" is not the property)');
  check(R.admin.length === new Set(R.admin).size && R.sales.length === new Set(R.sales).size, 'no duplicates');
  check(auth.EDITABLE_ROLES.includes('admin') && auth.EDITABLE_ROLES.includes('sales') && !auth.EDITABLE_ROLES.includes('owner'), 'both are EDITABLE in the permission grid (so an owner can adjust them per business) and the owner still is not');
  check(sorted(auth.EDITABLE_ROLES) === sorted(['accountant', 'installer', 'sales', 'admin']), 'the editable roles are exactly accountant, installer, sales and admin');
  OWNER_ONLY.forEach((c) => check(!auth.isEditableCapability(c), `${c} can never be granted to another role by an override`));
  const team = fs.readFileSync(path.join(srcDir, 'team.ts'), 'utf8'), listed = (team.match(/export const ASSIGNABLE_ROLES = \[([^\]]*)\]/) || [, ''])[1].match(/"[a-z]+"/g) || [];
  check(listed.length === 5 && listed.every((r) => R[r.replace(/"/g, '')]), 'every role an owner may give HAS a capability definition (a role with none would be a membership that can do nothing) and the list is owner, admin, accountant, sales, installer');

  // ---- the one role-name branch that matters: job scoping -----------------------------------------------------------------------------------------------------------------------------------------------------
  const { newDatabase, d1 } = require('./harness.js'), db = newDatabase(path.join(srcDir, '..')), env = { OFFICE_DB: d1(db), SESSION_SECRET: 'roles-secret' };
  for (const role of ['owner', 'accountant', 'installer', 'sales', 'admin']) db.prepare("INSERT INTO memberships (google_email, role, status) VALUES (?, ?, 'active')").run(`${role}@example.com`, role);
  const scope = async (role) => auth.getJobScope(new Request('https://x/projects', { headers: { cookie: `office_session=${await auth.signSession(env, `${role}@example.com`)}` } }), env);
  const scopes = Object.fromEntries(await Promise.all(['owner', 'accountant', 'installer', 'sales', 'admin'].map(async (r) => [r, (await scope(r)).scoped])));
  check(scopes.installer === true && scopes.owner === false && scopes.accountant === false && scopes.sales === false && scopes.admin === false, 'ONLY an installer is scoped to their own jobs. Sales and admin see EVERY job: deliberate (a salesperson and an office admin need all of them), and now written down and tested');

  // ---- the audit, as a test: every comparison of a role's NAME in the source -----------------------------------------------------------------------------------------------------------------------------
  const found = [];
  for (const f of fs.readdirSync(srcDir).filter((x) => x.endsWith('.ts'))) for (const line of fs.readFileSync(path.join(srcDir, f), 'utf8').split('\n')) for (const m of line.matchAll(/(?<!typeof )\b([A-Za-z_.]*role)\s*(===|!==|==|!=)\s*"([a-z_]+)"/g)) found.push(`${f}: ${m[1]} ${m[2]} "${m[3]}"`);
  const counts = found.reduce((o, k) => ((o[k] = (o[k] || 0) + 1), o), {});
  // Each is justified: auth.ts x2 (the owner's capabilities cannot be overridden; the gate's owner bypass), the ONE installer job scope, index.ts x2 (the owner bypass in two handlers), permissions.ts x2 (the owner's row cannot be edited),
  // team.ts (an owner is never changed through the app), emptiness.ts (the one member of an empty business must be an OWNER), team-people.ts (the PERSON record made for a login: an installer is an "installer", everyone else "staff": a label, not a permission), and an unrelated chat-history role in ai.ts.
  const EXPECTED = { 'auth.ts: role === "owner"': 2, 'auth.ts: ctx.role !== "installer"': 1, 'index.ts: ctx.role !== "owner"': 2, 'permissions.ts: role === "owner"': 2, 'team.ts: row.role === "owner"': 1, 'emptiness.ts: role !== "owner"': 1, 'plans.ts: role !== "owner"': 1, 'team-people.ts: role === "installer"': 1, 'ai.ts: h.role === "user"': 2, 'mcp.ts: who.role === "owner"': 1, 'mcp-oauth-routes.ts: who.role !== "owner"': 1 };   // mcp.ts: the read-only MCP tools mirror the gate, which lets the owner through without a rule; mcp-oauth-routes.ts: only the owner may connect an assistant
  check(JSON.stringify(counts, Object.keys(counts).sort()) === JSON.stringify(EXPECTED, Object.keys(EXPECTED).sort()), 'the role-name comparisons in the whole Worker source are EXACTLY these (owner guards, the ONE installer job scope, and an unrelated chat-history role). A NEW one fails this test: decide what it means for admin, sales, accountant and installer before changing the list. Found: ' + JSON.stringify(counts));
}
