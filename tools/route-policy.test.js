// The route policy (SHIP_CHECKLIST.md item 4): every non-admin route is in tools/route-policy.json, the REAL gate behaves exactly as that file says for each kind of
// caller, ROUTE_POLICY.md is the readable form of it, and a handful of invariants (written here, independent of the file) say what must never be true whatever the
// file says. To change who may do something: change the code, run `node tools/route-policy-gen.js`, review the diff.
// The permission tests swap in a bare stand-in for Response; the real one is kept in __RealResponse. The gate needs the real one, so it is swapped in and restored.
module.exports = async function runRoutePolicyTests(context) {
  const standIn = global.Response;
  if (global.__RealResponse) global.Response = global.__RealResponse;
  try {
    await routePolicyTests(context);
  } finally {
    global.Response = standIn;
  }
};

async function routePolicyTests({ check, srcDir, path, fs }) {
  const lib = require('./route-policy-lib.js');
  const workerDir = path.join(srcDir, '..');
  const expected = JSON.parse(fs.readFileSync(path.join(__dirname, 'route-policy.json'), 'utf8'));
  const observed = await lib.observe(srcDir, workerDir);
  const byRoute = (rows) => new Map(rows.map((r) => [r.route, r]));
  const exp = byRoute(expected), obs = byRoute(observed);

  // ---- every route is in the policy, and the policy lists nothing that does not exist ---------------------------------------------------
  const missing = [...obs.keys()].filter((k) => !exp.has(k)), stale = [...exp.keys()].filter((k) => !obs.has(k));
  check(missing.length === 0, `every route must be in tools/route-policy.json (run node tools/route-policy-gen.js and review the diff). Not in it: ${missing.join(', ')}`);
  check(stale.length === 0, `tools/route-policy.json must list only routes that exist. Listed but not found: ${stale.join(', ')}`);
  check(observed.length === 109, 'there are 109 route rows (105 routes, with confirm, reject and edit-field each shown for a money, a stock and a job action)');

  // ---- the real gate behaves exactly as the file says, for each kind of caller ------------------------------------------------------------
  const changed = [];
  for (const [route, o] of obs) {
    const e = exp.get(route);
    if (!e) continue;
    for (const who of ['none', ...lib.ROLES]) if (e[who] !== o[who]) changed.push(`${route} for ${who}: file says ${e[who]}, the gate now gives ${o[who]}`);
  }
  check(changed.length === 0, `the gate must behave as route-policy.json says (a change to who may do what must be deliberate: regenerate and review). Differences: ${changed.slice(0, 4).join(' | ')}${changed.length > 4 ? ` (and ${changed.length - 4} more)` : ''}`);
  check(fs.readFileSync(path.join(__dirname, '..', 'ROUTE_POLICY.md'), 'utf8') === lib.toMarkdown(expected), 'ROUTE_POLICY.md must be exactly the readable form of route-policy.json (run node tools/route-policy-gen.js)');

  // ---- invariants: what must never be true, whatever the file says ------------------------------------------------------------------------
  const rows = observed;

  // ---- the roles added 2026-10-18 (sales, admin): invariants that hold WHATEVER the file says, so a mistake in my reading of the file cannot hide one ---------------------------------------------------------------------------
  const route2 = (r) => r.route;
  check(rows.filter((r) => r.admin === 'A' && r.accountant !== 'A' && r.installer !== 'A').map(route2).length === 0, 'ADMIN may only reach what an accountant or an installer can already reach: there is no route only an admin can use (leaks: ' + rows.filter((r) => r.admin === 'A' && r.accountant !== 'A' && r.installer !== 'A').map(route2).join(', ') + ')');
  const salesExtra = rows.filter((r) => r.sales === 'A' && r.installer !== 'A').map(route2);
  check(JSON.stringify(salesExtra) === JSON.stringify(['PATCH /quotations/:id']), 'SALES may reach what an installer can, and EXACTLY ONE route more: editing a quotation (quoting is its own switch since 2026-10-18). Anything else is a leak (found: ' + salesExtra.join(', ') + ')');
  check(['PATCH /invoices/:id', 'PATCH /customers/:id'].every((k) => { const r = rows.find((x) => x.route === k); return r && r.sales === 403 && r.installer === 403; }), 'and sales still cannot edit an invoice or a customer');
  check(rows.filter((r) => r.class === 'owner only' && (r.admin === 'A' || r.sales === 'A')).length === 0 && rows.filter((r) => r.owner === 'A' && r.accountant !== 'A' && r.installer !== 'A' && (r.admin === 'A' || r.sales === 'A')).length === 0, 'a route only the owner can reach is NEVER reachable by an admin or a sales role');
  check(rows.filter((r) => /^(GET|POST|PATCH) \/(team|settings)/.test(r.route) && r.class !== 'public').every((r) => r.owner === 'A' && r.admin !== 'A' && r.sales !== 'A' && r.accountant !== 'A' && r.installer !== 'A') && rows.some((r) => r.route === 'POST /team/invite'), 'the team and settings routes are owner only: never an admin, never sales (so an admin cannot add people or change permissions)');
  check(rows.filter((r) => r.none === 'A').every((r) => r.admin === 'A' && r.sales === 'A'), 'a public route is public to every role too');
  check(rows.every((r) => r.none !== 401 || r.admin === 'A' || r.admin === 403 || r.admin === 401) && rows.filter((r) => r.owner === 401 && r.class !== 'own key').length === 0, 'no route answers 401 to a signed-in role (except the own-key route, which is opened by its key and by nothing else, so a session alone is refused there on purpose)');
  const reachableWithoutLogin = rows.filter((r) => r.none === 'A').map((r) => r.route).sort();
  const expectedPublic = ['GET /', 'GET /auth/google/callback', 'GET /auth/google/login', 'GET /auth/logout', 'GET /auth/me', 'GET /auth/signup', 'GET /auth/join', 'GET /billing/cancelled', 'GET /billing/card-updated', 'GET /billing/pay', 'GET /billing/payfast/notify', 'GET /billing/plans', 'GET /billing/return', 'GET /billing/start', 'GET /billing/update-card', 'GET /health', 'POST /', 'POST /auth/join', 'POST /auth/logout', 'POST /auth/signup', 'POST /billing/payfast/notify', 'POST /billing/start'].sort();
  check(JSON.stringify(reachableWithoutLogin) === JSON.stringify(expectedPublic), `without signing in, ONLY the sign-in routes, the health check and the root may be reached (found: ${reachableWithoutLogin.join(', ')})`);
  check(rows.filter((r) => r.class === 'signed link').every((r) => [r.none, r.owner, r.accountant, r.installer].every((v) => v === 403)) && rows.filter((r) => r.class === 'signed link').length === 6, 'the six document routes are opened ONLY by a signed link: a person who is signed in, owner included, is refused without one');
  check(rows.filter((r) => r.class !== 'public' && r.class !== 'signed link').every((r) => r.none === 401), 'every route that is not public or a signed link asks for a sign-in (401), never serves a stranger');
  check(rows.filter((r) => r.class !== 'signed link' && r.class !== 'own key').every((r) => r.owner === 'A'), 'the owner can reach every route that is not a signed link or an own-key route (no route locks the owner out)');
  check(rows.filter((r) => r.class === 'own key').map((r) => r.route).sort().join() === 'GET /mcp,POST /mcp' && rows.filter((r) => r.class === 'own key').every((r) => r.none === 401 && ['owner', 'accountant', 'installer', 'sales', 'admin'].every((x) => r[x] === 401)), 'the ONLY own-key routes are the MCP endpoint, and a session is refused there for every role (a key is the only way in)');

  const moneyRoutes = rows.filter((r) => /\/invoices\/:id|\/quotations\/:id|profitability|finance|financial-snapshot|suppliers|delivery-exceptions|embers\/(expenses|finance|suppliers)|^PATCH \/customers\/:id|\[invoice\]/.test(r.route));
  check(moneyRoutes.length >= 16 && moneyRoutes.every((r) => r.installer !== 'A'), `an installer must be refused on every money route (checked ${moneyRoutes.length}; allowed: ${moneyRoutes.filter((r) => r.installer === 'A').map((r) => r.route).join(', ') || 'none'})`);
  check(rows.filter((r) => /\[invoice\]/.test(r.route)).length === 3 && rows.filter((r) => /\[invoice\]/.test(r.route)).every((r) => r.owner === 'A' && r.accountant === 'A' && r.installer === 403), 'confirming, rejecting or editing a MONEY action is for the owner and the accountant, never the installer');

  const ownerOnly = rows.filter((r) => /settings\/permissions|csv-import|^POST \/business-profile\/logo|\/leads|^GET \/debug\/captures|documents\/sign|^(GET|POST) \/files\/\*/.test(r.route));
  check(ownerOnly.length === 16 && ownerOnly.every((r) => r.class === 'owner only'), `changing permissions, importing customers, invoices, team, suppliers or materials, uploading the logo, leads, raw captures, signing documents and raw file access are the OWNER only (checked ${ownerOnly.length})`);
  check(rows.filter((r) => /settings\/permissions/.test(r.route)).length === 4 && rows.filter((r) => /settings\/permissions/.test(r.route)).every((r) => r.accountant === 403 && r.installer === 403), 'nobody but the owner can read or change who may do what');
}
