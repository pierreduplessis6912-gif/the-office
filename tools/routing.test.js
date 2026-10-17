// The Worker's router (worker/src/routing.ts), architecture stage 2b. It decides which business's object serves a request WITHOUT any lookup, from the signed session, a signed link or an admin
// header. The properties that matter: it trusts only what it has verified, it never lets a client name its own object, public routes wake nothing, and forwarding overwrites a client-supplied
// business header. (Every object also refuses a request made for another business: tested in business-session.test.js and business-object.test.js.)
const path = require('path'), fs = require('fs'), os = require('os'), esbuild = require('esbuild');

module.exports = async function runRoutingTests({ check, srcDir }) {
  const bundle = (entry) => { const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rt-')), 'm.js'); esbuild.buildSync({ entryPoints: [path.join(srcDir, entry)], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent' }); return require(out); };
  const routing = bundle('routing.ts'), auth = bundle('auth.ts');
  const base = { SESSION_SECRET: 'router-secret', ADMIN_KEY: 'k-admin' };
  const req = (p, init = {}) => new Request('https://office.example' + p, init);
  const route = (p, init, env = base) => routing.routeRequest(req(p, init), env);
  const sess = async (email, b, env = base) => auth.signSession(env, email, b);
  const cookie = (token) => ({ headers: { cookie: `office_session=${token}` } });
  const is = (r, kind, id) => r.kind === kind && (id === undefined || r.businessId === id);

  // ---- a signed-in member goes to their business ---------------------------------------------------------------------------------------------
  const alpha = await sess('a@x.co', 'alpha-co');
  check(is(await route('/customers', cookie(alpha)), 'business', 'alpha-co') && is(await route('/auth/me', cookie(alpha)), 'business', 'alpha-co') && is(await route('/messages/text', { method: 'POST', ...cookie(alpha) }), 'business', 'alpha-co'), 'a signed-in member\'s request goes to the business named in their session');
  check(is(await route('/customers', { headers: { Authorization: 'Bearer ' + alpha } }), 'business', 'alpha-co'), 'whether the session arrives as a cookie or as a bearer token');
  check(is(await route('/customers', { headers: { ...cookie(alpha).headers, 'X-Business-Id': 'beta-co' } }), 'business', 'alpha-co'), 'a client-supplied business header changes nothing: the session decides');
  // ---- and anything it cannot verify goes to the Worker, which refuses it, waking no object ---------------------------------------------------
  const noB = await sess('a@x.co', undefined), otherSecret = await auth.signSession({ ...base, SESSION_SECRET: 'someone-else' }, 'a@x.co', 'alpha-co');
  const [payload, sig] = alpha.split('.'); const forgedPayload = Buffer.from(JSON.stringify({ email: 'a@x.co', exp: Date.now() + 1e6, b: 'beta-co' })).toString('base64url');
  const expired = await (async () => { const real = Date.now; Date.now = () => real() - 40 * 24 * 3600 * 1000; try { return await sess('a@x.co', 'alpha-co'); } finally { Date.now = real; } })();
  const wrongShape = await (async () => { const p = Buffer.from(JSON.stringify({ email: 'a@x.co', exp: Date.now() + 1e6, b: 'NOT valid!' })).toString('base64url'); const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(base.SESSION_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']); return p + '.' + Buffer.from(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(p))).toString('base64url'); })();
  for (const [name, token] of [['a session with no business', noB], ['a session signed with another secret', otherSecret], ['a session whose business was altered after signing', forgedPayload + '.' + sig], ['an expired session', expired], ['a session whose business is not a valid id (even though validly signed)', wrongShape], ['garbage', 'not-a-session']]) check(is(await route('/customers', cookie(token)), 'worker'), `${name} is left to the Worker's own gate (no object is woken)`);
  check(is(await route('/customers'), 'worker'), 'a request with no session at all is left to the Worker');
  // ---- public routes never need a business ------------------------------------------------------------------------------------------------------------
  const publics = ['/', '/health', '/auth/google/login', '/auth/google/callback', '/auth/logout'];
  check((await Promise.all(publics.map((p) => route(p, cookie(alpha))))).every((r) => is(r, 'worker')), 'the public routes (root, health, sign-in, sign-out) are answered by the Worker even when the caller holds a business session');
  // ---- administrators ---------------------------------------------------------------------------------------------------------------------------------
  const admin = (extra) => ({ headers: { 'X-Admin-Key': 'k-admin', ...extra } });
  check(is(await route('/debug/customers', admin({ 'X-Target-Business': 'beta-co' })), 'business', 'beta-co'), 'an admin call with the right key goes to the business it names');
  const nameless = await route('/debug/customers', admin({}));
  check(nameless.kind === 'refuse' && nameless.status === 400 && /X-Target-Business/.test(nameless.error), 'an admin call with the right key that names no business is refused with a clear message (the Worker holds no business data)');
  check((await route('/debug/customers', admin({ 'X-Target-Business': 'NOT valid' }))).kind === 'refuse', 'an invalid business name is refused');
  check(is(await route('/debug/customers', { headers: { 'X-Admin-Key': 'wrong', 'X-Target-Business': 'beta-co' } }), 'worker') && is(await route('/debug/customers', { headers: { 'X-Target-Business': 'beta-co' } }), 'worker'), 'a wrong or missing admin key can NEVER name a business: it is left to the Worker\'s admin gate, which refuses and records it');
  check((await Promise.all(['/debug/directory', '/debug/directory/create-business', '/debug/trial-do', '/debug/memory-health', '/debug/stress-memory'].map((p) => route(p, admin({ 'X-Target-Business': 'beta-co' }))))).every((r) => is(r, 'worker')), 'the directory and the Worker\'s own measuring routes are answered by the Worker, whatever business is named');
  check(is(await route('/debug/timings', admin({ 'X-Target-Business': 'beta-co' })), 'business', 'beta-co'), 'but the request timings (model versus database) are a business\'s own: they are read from its object by naming it');
  // ---- signed links -----------------------------------------------------------------------------------------------------------------------------------
  const link = await auth.signDocumentPath({ ...base, BUSINESS_ID: 'alpha-co' }, '/invoices/3/pdf', 60000), linkNoB = await auth.signDocumentPath(base, '/invoices/3/pdf', 60000);
  check(is(await route('/invoices/3/pdf?sig=' + encodeURIComponent(link)), 'business', 'alpha-co'), 'a customer\'s signed link goes to the business it was made for');
  const legacyEnv = { ...base, LEGACY_LINK_BUSINESS: 'alpha-co' };
  check(is(await route('/invoices/3/pdf?sig=' + encodeURIComponent(linkNoB), undefined, legacyEnv), 'business', 'alpha-co') && is(await route('/invoices/3/pdf?sig=' + encodeURIComponent(link), undefined, { ...base, LEGACY_LINK_BUSINESS: 'beta-co' }), 'business', 'alpha-co'), 'a link made before the move goes to the one business designated for such links, and a link that names a business still goes to THAT business');
  check(is(await route('/invoices/3/pdf?sig=garbage', undefined, legacyEnv), 'worker') && is(await route('/invoices/3/pdf', undefined, legacyEnv), 'worker') && is(await route('/invoices/3/pdf?sig=' + encodeURIComponent(linkNoB), undefined, { ...base, LEGACY_LINK_BUSINESS: 'NOT valid' }), 'worker'), 'garbage, no link, and an invalid designation are still left to the Worker, which refuses them');
  check(is(await route('/invoices/3/pdf?sig=' + encodeURIComponent(linkNoB)), 'worker') && is(await route('/invoices/3/pdf?sig=garbage'), 'worker') && is(await route('/invoices/3/pdf'), 'worker'), 'a link with no business, a garbled link and no link are left to the Worker, which refuses them');

  // ---- forwarding -------------------------------------------------------------------------------------------------------------------------------------
  // ---- BEFORE the switch to object mode: only an administrator can reach an object --------------------------------------------------------------------------------------------
  const pre = { ...base, BUSINESS: {} };   // a deployment that has business objects but still serves from its database
  const target = (p, headers = {}, env = pre) => routing.adminTargetBusiness(req(p, { headers }), env);
  check((await target('/admin/migration/manifest', { 'X-Admin-Key': 'k-admin', 'X-Target-Business': 'zulu-co' })) === 'zulu-co' && (await target('/debug/customers', { 'X-Admin-Key': 'k-admin', 'X-Target-Business': 'zulu-co' })) === 'zulu-co', 'before the switch, an admin call with the right key naming a business reaches that business\'s object');
  const nobody = [
    ['a wrong admin key', '/admin/migration/manifest', { 'X-Admin-Key': 'wrong', 'X-Target-Business': 'zulu-co' }],
    ['no admin key', '/admin/migration/manifest', { 'X-Target-Business': 'zulu-co' }],
    ['no business named', '/admin/migration/manifest', { 'X-Admin-Key': 'k-admin' }],
    ['an invalid business name', '/admin/migration/manifest', { 'X-Admin-Key': 'k-admin', 'X-Target-Business': 'NOT valid' }],
    ['a NON-admin route (a session\'s business is ignored before the switch)', '/customers', { 'X-Admin-Key': 'k-admin', 'X-Target-Business': 'zulu-co', cookie: 'office_session=' + alpha }],
    ['the directory (answered by the Worker)', '/debug/directory/create-business', { 'X-Admin-Key': 'k-admin', 'X-Target-Business': 'zulu-co' }],
    ['the Worker\'s own measuring routes', '/debug/trial-do', { 'X-Admin-Key': 'k-admin', 'X-Target-Business': 'zulu-co' }],
  ];
  for (const [what, p, h] of nobody) check((await target(p, h)) === null, `before the switch, ${what} is NOT sent to an object`);
  check((await target('/admin/migration/manifest', { 'X-Admin-Key': 'k-admin', 'X-Target-Business': 'zulu-co' }, base)) === null, 'and on a deployment with no business objects nothing is ever routed to one');
  const idx = fs.readFileSync(path.join(srcDir, 'index.ts'), 'utf8');
  check(/if \(env\.BUSINESS_MODE !== "object"\) \{\s*const targeted = await adminTargetBusiness\(request, env\);\s*if \(targeted\) return forwardToBusiness\(request, env, targeted\);\s*\}/.test(idx), 'the entry point does this ONLY when the mode is not "object", and only through that one function');

  // ---- sign-in in object mode: the directory names the business, that business's object confirms the membership --------------------------------------------------
  const indexSrc = fs.readFileSync(path.join(srcDir, 'index.ts'), 'utf8');
  const callback = indexSrc.slice(indexSrc.indexOf('pathname === "/auth/google/callback"'), indexSrc.indexOf('pathname === "/auth/me"'));
  check(/if \(env\.BUSINESS_MODE === "object"\) \{[\s\S]*?lookupAccessForEmail\(env, sessionEmail\)[\s\S]*?callBusiness\(env, businessId, "GET", `\/debug\/membership-check\?email=/.test(callback) && /signedInRedirect\(request, env, \{ sessionEmail, displayEmail: claims\.email, role: membership\.role, businessId: sessionBusiness, notAfterMs \}\)/.test(callback), 'in object mode a sign-in asks the directory for the member\'s business, asks THAT business\'s object whether the membership is active, and signs a session carrying the business');
  check(/\} else \{\s*membership = await env\.OFFICE_DB\.prepare\("SELECT \* FROM memberships WHERE google_email = \?"\)\s*\.bind\(claims\.email\)/.test(callback) && /if \(!membership \|\| membership\.status !== "active"\)/.test(callback), 'and without objects the sign-in is exactly as it was: the same membership query, the same refusal');
  const seen = [];
  const namespace = { idFromName: (name) => ({ name }), get: (id, opts) => ({ fetch: async (r, init) => { seen.push({ id, opts, request: r, init }); return new Response('forwarded'); } }) };
  const sent = new Request('https://office.example/customers', { method: 'POST', headers: { 'X-Business-Id': 'beta-co', 'X-Target-Business': 'beta-co', 'X-Keep': 'yes' }, body: 'payload' });
  await routing.forwardToBusiness(sent, { BUSINESS: namespace }, 'alpha-co');
  const f = seen[0];
  check(f.id.name === 'business-alpha-co' && f.opts.locationHint === 'weur' && f.request.headers.get('X-Business-Id') === 'alpha-co' && f.request.headers.get('X-Target-Business') === null && f.request.headers.get('X-Keep') === 'yes' && f.request.method === 'POST' && (await f.request.text()) === 'payload', 'forwarding names the object from the business, places it in Western Europe, OVERWRITES a client-supplied business header, removes the admin targeting header, and keeps the method, the other headers and the body');
  await routing.callBusiness({ BUSINESS: namespace, ADMIN_KEY: 'k-admin', ADMIN_CONFIRM_KEY: 'k-confirm' }, 'alpha-co', 'POST', '/debug/create-membership', { google_email: 'o@x.co', role: 'owner' });
  const c = seen[1];
  check(c.id.name === 'business-alpha-co' && c.init.headers['X-Business-Id'] === 'alpha-co' && c.init.headers['X-Admin-Key'] === 'k-admin' && c.init.headers['X-Admin-Confirm'] === 'k-confirm' && c.init.method === 'POST' && JSON.parse(c.init.body).role === 'owner' && String(c.request).endsWith('/debug/create-membership'), 'an internal call to a business carries the admin keys the Worker holds, the business name, and a JSON body');
  let threw = false; try { await routing.callBusiness({ ADMIN_KEY: 'k' }, 'alpha-co', 'GET', '/x'); } catch (e) { threw = /not enabled/.test(String(e.message)); }
  check(threw, 'an internal call without business objects enabled fails loudly instead of silently doing nothing');
};
