// Tests for the permission grid's catalog, guard rails and loader (auth.ts). Run from role-matrix.test.js. The behaviour of
// the routes, and the proof that switching something really changes what a role can do and see, is in the recorded group
// tools/cases/permissions.js; this file is about the rules the grid must never break.
module.exports = async function runPermissionTests({ check, compiled, srcDir, fs, path, sameJson }) {
  const { ROLE_CAPABILITIES, CAPABILITY_CATALOG, CAPABILITY_BY_KEY, EDITABLE_ROLES, isEditableCapability, applyOverrides, getRoleCapabilities } = require(compiled);
  const authSrc = fs.readFileSync(path.join(srcDir, 'auth.ts'), 'utf8');

  // ---- 1. With no overrides, every role has exactly what it always had --------------------------------------------------
  const noOverrides = { OFFICE_DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: [] }) }) }) } };
  for (const role of [...Object.keys(ROLE_CAPABILITIES), 'stranger', '']) {
    check(sameJson(await getRoleCapabilities(noOverrides, role), ROLE_CAPABILITIES[role] || []), `with no overrides "${role}" must have exactly its default capabilities`);
  }

  // ---- 2. The catalog is complete, and honest about what is owner only and what is unused ------------------------------
  const inTable = new Set(Object.values(ROLE_CAPABILITIES).flat());
  for (const k of inTable) check(Boolean(CAPABILITY_BY_KEY[k]), `capability "${k}" is in a role's table but missing from the catalog`);
  for (const c of CAPABILITY_CATALOG) check(inTable.has(c.key), `catalog capability "${c.key}" is held by no role, so it is dead weight`);
  const ownerOnly = CAPABILITY_CATALOG.filter((c) => c.ownerOnly).map((c) => c.key).sort();
  check(sameJson(ownerOnly, ['can_delete_data', 'can_invite_members', 'can_manage_settings']), `exactly the three administrative capabilities are owner only (got ${ownerOnly.join(', ')})`);
  for (const role of EDITABLE_ROLES) for (const k of ROLE_CAPABILITIES[role]) check(!CAPABILITY_BY_KEY[k].ownerOnly, `the default for "${role}" must never include the owner-only capability "${k}"`);
  check(sameJson([...EDITABLE_ROLES].sort(), ['accountant', 'installer']) && !EDITABLE_ROLES.includes('owner'), 'the roles the owner can edit are the accountant and the installer, never the owner');
  check(CAPABILITY_CATALOG.every((c) => c.label && c.description), 'every capability has a plain-language label and description for the screen');
  check(CAPABILITY_CATALOG.filter((c) => isEditableCapability(c.key)).length === 10, 'exactly ten capabilities can be switched today: money, debtors, profit, materials, jobs, payroll, banking, and (since 2026-10-04) expense totals, supplier balances and material prices (the others are owner only or not used by anything yet)');

  // ---- 3. The "in use" flags match the code, so a switch is never wired to nothing ----------------------------------------
  // A capability nothing checks cannot be switched. When code starts checking one, this fails until its flag is flipped on purpose,
  // so an override stored while it did nothing can never silently become live.
  const gridStart = authSrc.indexOf('// The permission grid (2026-10-04'), gridEnd = authSrc.indexOf('// Real, new, per direct instruction — the first real item on');
  const tableMatch = authSrc.match(/const ROLE_CAPABILITIES[^=]*=\s*\{[\s\S]*?\n\};/)[0];
  let everything = authSrc.slice(0, gridStart) + authSrc.slice(gridEnd);
  everything = everything.replace(tableMatch, '');
  for (const f of fs.readdirSync(srcDir)) if (f.endsWith('.ts') && f !== 'auth.ts') everything += '\n' + fs.readFileSync(path.join(srcDir, f), 'utf8');
  for (const c of CAPABILITY_CATALOG) {
    const uses = everything.split(`"${c.key}"`).length - 1;
    check(c.inUse ? uses > 0 : uses === 0, c.inUse
      ? `"${c.key}" is marked in use but nothing in the code checks it`
      : `"${c.key}" is marked NOT in use but the code now checks it ${uses} time(s): flip its inUse flag in the catalog, deliberately, so it becomes a switch`);
  }

  // ---- 3b. Expense totals and supplier balances follow "Money in and out" until set on their own (decided 2026-10-04) ----------
  const withRows = (rows) => ({ OFFICE_DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: rows }) }) }) } });
  const ov = (capability, granted) => ({ capability, granted });
  const has = async (role, rows, k) => (await getRoleCapabilities(withRows(rows), role)).includes(k);
  check(await has('accountant', [], 'can_know_expense_totals') && await has('accountant', [], 'can_know_supplier_balances') && await has('accountant', [], 'can_know_material_prices'), 'by default the accountant has all three new switches (as they had these things before)');
  check(!(await has('installer', [], 'can_know_expense_totals')) && !(await has('installer', [], 'can_know_supplier_balances')) && await has('installer', [], 'can_know_material_prices'), 'by default the installer has material prices (which were open to everyone) and neither money view');
  check(!(await has('accountant', [ov('can_manage_invoices', 0)], 'can_know_expense_totals')) && !(await has('accountant', [ov('can_manage_invoices', 0)], 'can_know_supplier_balances')), 'a role already switched OFF from "Money in and out" stays without both views (they follow it: nothing silently comes back)');
  check(await has('accountant', [ov('can_manage_invoices', 0)], 'can_know_material_prices'), 'but material prices do not follow money: they were never tied to it');
  check(await has('installer', [ov('can_manage_invoices', 1)], 'can_know_expense_totals') && await has('installer', [ov('can_manage_invoices', 1)], 'can_know_supplier_balances'), 'a role given "Money in and out" gets both views with it, as before');
  check(await has('accountant', [ov('can_manage_invoices', 0), ov('can_know_expense_totals', 1)], 'can_know_expense_totals') && !(await has('accountant', [ov('can_manage_invoices', 0), ov('can_know_expense_totals', 1)], 'can_know_supplier_balances')), 'an explicit setting wins: expense totals switched on stays on without money, and supplier balances (not set) still follow money');
  check(!(await has('accountant', [ov('can_know_expense_totals', 0)], 'can_know_expense_totals')) && await has('accountant', [ov('can_know_expense_totals', 0)], 'can_know_supplier_balances') && await has('accountant', [ov('can_know_expense_totals', 0)], 'can_manage_invoices'), 'switching one view off leaves the other, and money, alone');
  check(!(await has('installer', [ov('can_know_material_prices', 0)], 'can_know_material_prices')), 'material prices can be taken away from the installer');
  check(await has('installer', [ov('can_know_expense_totals', 1)], 'can_know_expense_totals') && !(await has('installer', [ov('can_know_expense_totals', 1)], 'can_manage_invoices')), 'a view can be given on its own, without giving money in and out');
  check(await has('owner', [ov('can_know_expense_totals', 0), ov('can_manage_invoices', 0)], 'can_know_expense_totals'), 'the owner is never overridden');
  const stableAcc = await getRoleCapabilities(withRows([]), 'accountant');
  check(sameJson(stableAcc, ROLE_CAPABILITIES.accountant), 'with no overrides the accountant is exactly the default, in the default order (the inheritance changes nothing by itself)');

  // ---- 3c. The signed report links are governed by the right switch (they cannot be exercised through the harness without a signed link,
  // so the rule table is read directly) ---------------------------------------------------------------------------------
  const sigStart = authSrc.indexOf('export const SIGNABLE_DOCUMENT_PATHS');
  const sigBlock = authSrc.slice(sigStart, authSrc.indexOf('];', sigStart));
  const sigRules = {};
  for (const m of sigBlock.matchAll(/pattern:\s*\/\^([^,]*?)\$\/,\s*anyOf:\s*\[([^\]]*)\]/g)) sigRules[m[1].replace(/\\\//g, '/')] = m[2].split(',').map((x) => x.trim().replace(/"/g, '')).filter(Boolean);
  check(sameJson(sigRules['/reports/aged-creditors/pdf'], ['can_know_supplier_balances']), `the aged creditors report is governed by "See what we owe suppliers" alone (got ${JSON.stringify(sigRules['/reports/aged-creditors/pdf'])})`);
  check(Boolean(sigRules['/reports/aged-debtors/pdf']) && !sigRules['/reports/aged-debtors/pdf'].includes('can_know_supplier_balances'), 'and the aged debtors report is not governed by the supplier balances switch');
  check(Object.keys(sigRules).length >= 4, `the signed-link rule table was read (${Object.keys(sigRules).length} rules)`);

  // ---- 4. Overrides: what they may and may not do -------------------------------------------------------------------------
  const inst = ROLE_CAPABILITIES.installer;
  check(applyOverrides(inst, [{ capability: 'can_know_materials', granted: 0 }]).includes('can_know_materials') === false, 'an override can take a capability away');
  check(applyOverrides(inst, [{ capability: 'can_manage_invoices', granted: 1 }]).includes('can_manage_invoices') === true, 'an override can give a capability');
  check(applyOverrides(['can_know_jobs', 'can_know_materials'], []).join() === 'can_know_jobs,can_know_materials', 'with nothing to apply the defaults come back unchanged, in their own order');
  check(applyOverrides(['can_know_jobs'], [{ capability: 'can_know_profit', granted: 1 }, { capability: 'can_manage_invoices', granted: 1 }]).join() === 'can_know_jobs,can_manage_invoices,can_know_profit', 'defaults keep their order and anything granted follows in catalog order, not the order it was stored');
  for (const [name, row] of [['an owner-only capability', { capability: 'can_manage_settings', granted: 1 }], ['another owner-only capability', { capability: 'can_delete_data', granted: 1 }], ['a capability nothing uses', { capability: 'can_know_measurements', granted: 1 }], ['a capability that does not exist', { capability: 'can_do_anything', granted: 1 }]]) {
    check(sameJson(applyOverrides(inst, [row]), applyOverrides(inst, [])), `an override granting ${name} must be ignored (a stray row can never widen access)`);
  }
  check(!applyOverrides(ROLE_CAPABILITIES.accountant, [{ capability: 'can_manage_settings', granted: 0 }]).includes('can_manage_settings'), 'ignoring a revoke of an owner-only capability the role never had changes nothing');

  // The owner is never overridden, whatever is stored; a role that is not defined stays empty.
  const hostile = { OFFICE_DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: [{ capability: 'can_manage_settings', granted: 0 }, { capability: 'can_manage_invoices', granted: 0 }] }) }) }) } };
  check(sameJson(await getRoleCapabilities(hostile, 'owner'), ROLE_CAPABILITIES.owner), 'the owner can never be overridden, so nobody can be locked out');
  check(sameJson(await getRoleCapabilities(hostile, 'stranger'), []), 'a role that is not defined stays empty whatever is stored');
  const widening = { OFFICE_DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: [{ capability: 'can_manage_invoices', granted: 1 }] }) }) }) } };
  check((await getRoleCapabilities(widening, 'installer')).includes('can_manage_invoices'), 'a stored grant is applied for an editable role');

  // A failure to read the owner's restrictions must fail the request, never fall back to the wider defaults. Only "no such table" means "no overrides".
  const broken = { OFFICE_DB: { prepare: () => ({ bind: () => ({ all: async () => { throw new Error('D1_ERROR: database is locked'); } }) }) } };
  let failedClosed = false;
  try { await getRoleCapabilities(broken, 'installer'); } catch (e) { failedClosed = /locked/.test(String(e.message)); }
  check(failedClosed, 'if the overrides cannot be read the request fails; it must not quietly use the wider defaults');
  let createdTables = 0, first = true;
  const missing = { OFFICE_DB: { prepare: (sql) => ({ run: async () => { createdTables++; return {}; }, bind: () => ({ all: async () => { if (first) { first = false; throw new Error('D1_ERROR: no such table: role_capability_overrides'); } return { results: [] }; } }) }) } };
  check(sameJson(await getRoleCapabilities(missing, 'installer'), ROLE_CAPABILITIES.installer) && createdTables === 2, 'the first time the tables are missing they are created (two), and the defaults apply: there is no migration to run by hand');

  // ---- 5. Nothing reads the static table around the loader any more -----------------------------------------------------
  const outsideLoader = authSrc.slice(0, gridStart) + authSrc.slice(gridEnd);
  check(!/ROLE_CAPABILITIES\[(membership\.role|role)\]/.test(outsideLoader), 'auth.ts must read a caller\'s capabilities through getRoleCapabilities, never straight from the static table');
  check((authSrc.match(/await getRoleCapabilities\(env, (membership\.role|role)\)/g) || []).length >= 3, 'the three places that resolve a caller\'s capabilities must all use the loader');
};
