// Tests for the admin gate (hardening, 2026-10-11, SHIP_CHECKLIST.md item 2): tiers for every route, a second secret for privileged ones, throttled wrong
// guesses, a constant-time comparison, a record of every call, and the two removed routes staying removed.
// The permission tests swap in a bare stand-in for Response; the real one is kept in __RealResponse. This needs the real one, so it is swapped in and restored.
module.exports = async function runAdminGateTests(context) {
  const standIn = global.Response;
  if (global.__RealResponse) global.Response = global.__RealResponse;
  try {
    await adminGateTests(context);
  } finally {
    global.Response = standIn;
  }
};

async function adminGateTests({ check, bundleTo, srcDir, path, fs }) {
  const gate = bundleTo('admin-gate.ts', 'rm-admin-gate.js');
  const { ADMIN_ROUTE_TIERS } = bundleTo('admin-routes.ts', 'rm-admin-routes.js');
  const { newDatabase, d1 } = require('./harness.js');
  const workerDir = path.join(srcDir, '..');
  const read = (f) => fs.readFileSync(path.join(srcDir, f), 'utf8');
  const debugSrc = read('debug.ts'), indexSrc = read('index.ts'), authSrc = read('auth.ts'), gateSrc = read('admin-gate.ts');

  // ---- every route has a tier, and the table lists nothing that does not exist --------------------------------------------------------------
  const found = new Set();
  for (const text of [debugSrc, indexSrc]) {
    for (const line of text.split('\n')) {
      const m = line.match(/pathname === "(\/(?:debug|admin)\/[^"]+)"(?: && request\.method === "(\w+)")?/);
      if (m && (line.trim().startsWith('if (') || line.trim().startsWith('} else if'))) found.add(`${m[2] || 'ANY'} ${m[1]}`);
      // A route matched by a pattern with an id in it (the id is written :id in the table), which an exact-match search cannot see.
      const rx = line.match(/url\.pathname\.match\(\/\^(.+?)\$\/\) && request\.method === "(\w+)"/);
      if (rx && (line.trim().startsWith('if (') || line.trim().startsWith('} else if'))) {
        const p = rx[1].replace(/\\\//g, '/').replace(/\\d\+/g, ':id');
        if (/^\/(debug|admin)\//.test(p)) found.add(`${rx[2]} ${p}`);
      }
    }
  }
  // The migration routes are matched by a switch in their own file (case "GET /manifest"), under /admin/migration.
  for (const m of read('migration-routes.ts').matchAll(/case "(GET|POST) (\/[a-z-]+)":/g)) found.add(`${m[1]} /admin/migration${m[2]}`);
  for (const m of read('backup-routes.ts').matchAll(/case "(GET|POST) (\/[a-z-]+)":/g)) found.add(`${m[1]} /admin/backup${m[2]}`);
  const tabled = new Set(Object.keys(ADMIN_ROUTE_TIERS));
  const unclassified = [...found].filter((k) => !tabled.has(k)), stale = [...tabled].filter((k) => !found.has(k));
  check(unclassified.length === 0, `every admin and debug route must be in the tier table (not in it: ${unclassified.join(', ')})`);
  check(stale.length === 0, `the tier table must list only routes that exist (listed but not found: ${stale.join(', ')})`);
  check(found.size === 162 && ![...found].some((k) => k.startsWith('ANY ')), 'there are 162 admin and debug routes (160 exact paths and 2 with an id in the path), each checked for its HTTP method');

  // ---- the tiers themselves ---------------------------------------------------------------------------------------------------------------
  const privileged = Object.entries(ADMIN_ROUTE_TIERS).filter(([, t]) => t === 'privileged').map(([k]) => k).sort();
  const expectedPrivileged = ['POST /debug/directory/plans/set', 'POST /debug/directory/set-plan', 'POST /debug/directory/trial', 'POST /admin/backup/restore', 'POST /admin/backup/unlock', 'GET /admin/migration/whoami', 'POST /debug/directory/check-members', 'POST /admin/migration/vectors-query', 'GET /admin/migration/manifest', 'GET /admin/migration/rows', 'GET /admin/migration/notes', 'GET /admin/migration/files', 'GET /admin/migration/file', 'GET /admin/migration/fingerprint', 'POST /admin/migration/schema', 'POST /admin/migration/rows', 'POST /admin/migration/sequences', 'POST /admin/migration/notes', 'POST /admin/migration/file', 'POST /admin/migration/vectors', 'POST /admin/migration/vectors-by-ids', 'GET /admin/export', 'POST /debug/business-profile', 'POST /debug/create-membership', 'POST /debug/delete-character', 'POST /debug/directory/add-member', 'POST /debug/directory/create-business', 'POST /debug/delete-customer', 'POST /debug/delete-membership', 'POST /debug/merge-characters', 'POST /debug/merge-customers', 'POST /debug/merge-stock-items', 'POST /debug/migrate-jobscopes-nullable-customer', 'POST /debug/set-membership-character'].sort();
  check(JSON.stringify(privileged) === JSON.stringify(expectedPrivileged), `the privileged routes (change who has access, change banking details, delete or merge, read everything) must be exactly these 34 (found: ${privileged.join(', ')})`);
  check(Object.entries(ADMIN_ROUTE_TIERS).filter(([k]) => k.includes('/init-')).every(([, t]) => t === 'schema') && Object.keys(ADMIN_ROUTE_TIERS).filter((k) => k.includes('/init-')).length === 39, 'the 39 set-up routes are all "schema"');
  check(['GET /debug/smoke-test', 'GET /debug/intent-test', 'GET /debug/reprocess', 'GET /debug/stress-memory', 'GET /debug/search-memory', 'GET /debug/rewrite-thinking-test'].every((k) => ADMIN_ROUTE_TIERS[k] === 'write'), 'a GET that spends model budget or changes data is "write", not "read"');
  check(ADMIN_ROUTE_TIERS['GET /debug/customers'] === 'read' && ADMIN_ROUTE_TIERS['GET /debug/timings'] === 'read', 'a plain look at data is "read"');

  // ---- the two removed routes stay removed -----------------------------------------------------------------------------------------------
  check(!/pathname === "\/admin\/(mint-session|flush)"/.test(debugSrc + indexSrc) && !Object.keys(ADMIN_ROUTE_TIERS).some((k) => /mint-session|\/admin\/flush$/.test(k)), 'minting a session as any user and erasing everything must not exist as routes (nothing used them)');

  // ---- the gate ---------------------------------------------------------------------------------------------------------------------------
  const db = newDatabase(workerDir);
  const env = { OFFICE_DB: d1(db), ADMIN_KEY: 'k-admin-123', ADMIN_CONFIRM_KEY: 'k-confirm-456', SESSION_SECRET: 'session-secret' };
  const call = (method, p, headers, e = env, ip = '203.0.113.7') => gate.authorizeAdmin(new Request('https://office.example' + p, { method, headers: { 'CF-Connecting-IP': ip, ...(headers || {}) } }), e, p);
  const status = async (promise) => { const r = await promise; return r === null ? 'allowed' : r.status; };
  check((await status(call('GET', '/debug/customers'))) === 401, 'no key is refused');
  check((await status(call('GET', '/debug/customers', { 'X-Admin-Key': 'wrong' }))) === 401, 'a wrong key is refused');
  check((await status(call('GET', '/debug/customers', { 'X-Admin-Key': 'k-admin-123' }))) === 'allowed', 'the right key opens a read route');
  check((await status(call('GET', '/debug/customers', { 'X-Admin-Key': '' }, { ...env, ADMIN_KEY: '' }))) === 401, 'with no admin key configured at all, nothing is let in (not even an empty key)');
  check((await status(call('GET', '/debug/pending-action/12', { 'X-Admin-Key': 'k-admin-123' }))) === 'allowed' && (await status(call('POST', '/debug/complete-task/7', { 'X-Admin-Key': 'k-admin-123' }))) === 'allowed', 'a route with an id in its path (pending-action/12, complete-task/7) is found in the table by its :id form and opens with the admin key');
  check((await status(call('GET', '/debug/pending-action/abc', { 'X-Admin-Key': 'k-admin-123' }))) === 403, 'but an id that is not a number is not that route');
  const unknown = await call('GET', '/debug/no-such-route', { 'X-Admin-Key': 'k-admin-123' });
  check(unknown !== null && unknown.status === 403, 'a route that is not in the tier table is refused even with the right key (fail closed)');
  check((await status(call('POST', '/debug/merge-customers', { 'X-Admin-Key': 'k-admin-123' }))) === 403, 'a privileged route with only the admin key is refused');
  check((await status(call('POST', '/debug/merge-customers', { 'X-Admin-Key': 'k-admin-123', 'X-Admin-Confirm': 'wrong' }))) === 403, 'a privileged route with the wrong confirmation key is refused');
  check((await status(call('POST', '/debug/merge-customers', { 'X-Admin-Key': 'k-admin-123', 'X-Admin-Confirm': 'k-confirm-456' }))) === 'allowed', 'a privileged route with both keys is allowed');
  check((await status(call('GET', '/admin/export', { 'X-Admin-Key': 'k-admin-123' }))) === 403, 'reading everything at once (export) is privileged too');
  const off = await call('POST', '/debug/merge-customers', { 'X-Admin-Key': 'k-admin-123', 'X-Admin-Confirm': 'anything' }, { ...env, ADMIN_CONFIRM_KEY: undefined });
  check(off !== null && off.status === 403 && /switched off/.test((await off.json()).error), 'while the second secret is not set, privileged routes are switched off, whatever is sent');
  check((await status(call('POST', '/debug/init-snags', { 'X-Admin-Key': 'k-admin-123' }))) === 'allowed' && (await status(call('GET', '/debug/smoke-test', { 'X-Admin-Key': 'k-admin-123' }))) === 'allowed', 'schema and write routes need only the admin key');
  check(!db.prepare("SELECT name FROM sqlite_master WHERE name = 'admin_audit'").all().length, 'checking a key creates no table (a missing audit table just means no failures yet)');

  // ---- throttling wrong guesses ---------------------------------------------------------------------------------------------------------
  const failRow = (source, st = 401) => gate.recordAdminCall(env, { method: 'GET', path: '/debug/customers', tier: 'read', status: st, source });
  const sourceA = await gate.hashSource(env, new Request('https://o/x', { headers: { 'CF-Connecting-IP': '203.0.113.7' } }));
  for (let i = 0; i < 4; i++) await failRow(sourceA);
  check((await status(call('GET', '/debug/customers', { 'X-Admin-Key': 'k-admin-123' }))) === 'allowed', 'four failures from one source do not lock it out');
  await failRow(sourceA);
  const locked = await call('GET', '/debug/customers', { 'X-Admin-Key': 'k-admin-123' });
  check(locked !== null && locked.status === 429 && locked.headers.get('Retry-After') === String(gate.LOCKOUT_MINUTES * 60), 'five failures lock a source out: even the CORRECT key is refused (429, with when to retry)');
  const lockedWrong = await call('GET', '/debug/customers', { 'X-Admin-Key': 'a-wrong-guess' });
  check(lockedWrong !== null && lockedWrong.status === 429, 'during a lockout a WRONG key gets the very same 429, so the answer never reveals whether a guess was right');
  check((await status(call('GET', '/debug/customers', { 'X-Admin-Key': 'k-admin-123' }, env, '198.51.100.9'))) === 'allowed', 'a different source is not affected');
  db.prepare("UPDATE admin_audit SET created_at = datetime('now', '-20 minutes')").run();
  check((await status(call('GET', '/debug/customers', { 'X-Admin-Key': 'k-admin-123' }))) === 'allowed', 'the lockout ends after 15 minutes');
  db.prepare('DELETE FROM admin_audit').run();
  for (let i = 0; i < 6; i++) await failRow(sourceA, 200);
  check((await status(call('GET', '/debug/customers', { 'X-Admin-Key': 'k-admin-123' }))) === 'allowed', 'successful calls never count towards a lockout');

  // ---- the record ---------------------------------------------------------------------------------------------------------------------------
  db.prepare('DELETE FROM admin_audit').run();
  await gate.recordAdminCall(env, { method: 'POST', path: '/debug/merge-customers', tier: 'privileged', status: 200, source: sourceA });
  const row = db.prepare('SELECT * FROM admin_audit').all()[0];
  check(row.method === 'POST' && row.path === '/debug/merge-customers' && row.tier === 'privileged' && row.status === 200 && /^[0-9a-f]{16}$/.test(row.source), 'a call is recorded with its route, tier, outcome and a 16-character hashed source');
  check(!JSON.stringify(row).includes('203.0.113.7') && !db.prepare("PRAGMA table_info(admin_audit)").all().some((c) => /key|ip|query|body/i.test(c.name)), 'the record holds neither the address, nor the key, nor the query string, nor the body');
  const other = await gate.hashSource(env, new Request('https://o/x', { headers: { 'CF-Connecting-IP': '198.51.100.9' } }));
  const reseeded = await gate.hashSource({ ...env, SESSION_SECRET: 'another' }, new Request('https://o/x', { headers: { 'CF-Connecting-IP': '203.0.113.7' } }));
  check(other !== sourceA && reseeded !== sourceA && other.length === 16, 'the hashed source differs by address, and by secret (so it cannot be looked up from a list of addresses)');

  // ---- constant-time comparison -------------------------------------------------------------------------------------------------------------
  check((await gate.safeEqual('abc', 'abc')) && !(await gate.safeEqual('abc', 'abd')) && !(await gate.safeEqual('abc', 'abcd')) && !(await gate.safeEqual('', 'a')) && (await gate.safeEqual('', '')), 'the comparison is right for equal, different, different-length and empty values');
  const gateCode = gateSrc.replace(/\/\/.*$/gm, '');
  check(!/(ADMIN_KEY|ADMIN_CONFIRM_KEY)\s*[!=]==|[!=]==\s*env\.ADMIN/.test(gateCode) && /diff(erence)? \|= x\[i\] \^ y\[i\]/.test(gateCode), 'the keys are never compared with === or !==, only through the constant-time comparison');

  // ---- it is actually used ---------------------------------------------------------------------------------------------------------------------
  check(/if \(isAdminPath\(path\)\) \{[\s\S]*?return authorizeAdmin\(request, env, path\);/.test(authSrc) && !/providedKey/.test(authSrc), 'the auth gate must send every admin route through authorizeAdmin, with no key comparison of its own left behind');
  check(/ctx\.waitUntil\(\s*hashSource\(env, request\)/.test(indexSrc) && /isAdminPath\(url\.pathname\) && response\.status !== 429/.test(indexSrc) && !/await recordAdminCall\(/.test(indexSrc), 'every admin call is recorded after the response has gone, never awaited, and a lockout refusal is not recorded (a flood of guesses cannot fill the table)');
  check(/ADMIN_CONFIRM_KEY\?: string;/.test(read('types.ts')), 'the second secret is optional in the type, so a missing one means "switched off", never a crash');
}
