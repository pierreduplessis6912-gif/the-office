// The OAuth routes for assistants that cannot send a static key (worker/src/mcp-oauth-routes.ts, worker/src/mcp-oauth-issue.ts; rules in mcp-oauth.test.js). SECURITY-SENSITIVE: this is the first place the flow is reachable. Part 1 drives the whole flow (register, authorize, Google hook, consent, token) with a stand-in business; part 2 drives the business-side issue through the REAL pipeline.
// THE RULES (each is also proven by a deliberate breakage, tools/mcp-oauth-routes-breakage.js): (1) a failed authorize request is never redirected anywhere; (2) only an ACTIVE OWNER reaches the consent page, everyone else is sent back as access_denied, and no normal session is ever issued on this path; (3) the consent button works only with a signed ticket AND the nonce cookie of the browser that saw the page, and never from another site; (4) a code works once (the business refuses a second use) and only with the right verifier, client and address; (5) everything is closed when MCP is off, there are no business objects, or no secret; (6) the key is issued only for an owner who is still active, and only through the admin-keyed internal route.
const path = require('path'), fs = require('fs'), os = require('os'), crypto = require('crypto'), esbuild = require('esbuild');

module.exports = async function runMcpOauthRouteTests(context) {
  const standIn = global.Response;
  if (global.__RealResponse) global.Response = global.__RealResponse;
  try { await routeTests(context); } finally { global.Response = standIn; }
};

async function routeTests({ check, srcDir }) {
  const bundle = (entry) => { const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mor-')), 'm.js'); esbuild.buildSync({ entryPoints: [path.join(srcDir, entry)], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent' }); return require(out); };
  let R, mk;
  try { R = bundle('mcp-oauth-routes.ts'); mk = bundle('mcp-keys.ts'); } catch (e) { check(false, 'mcp-oauth-routes.ts builds: ' + String(e.message).split('\n')[0].slice(0, 160)); return; }

  const ENV = { SESSION_SECRET: 'route-secret', BUSINESS_MODE: 'object' };
  const NOW = 1_800_000_000_000, ORIGIN = 'https://office.test', CB = 'https://claude.ai/api/mcp/auth_callback';
  const b64u = (b) => Buffer.from(b).toString('base64url');
  const verifier = b64u(crypto.randomBytes(32)), challenge = b64u(crypto.createHash('sha256').update(verifier).digest());
  const calls = [];
  let script = async () => ({ ok: true, json: async () => ({ key: 'omk.acme-co.0123456789abcdef.secret' }) });
  const call = async (...args) => { calls.push(args); return script(...args); };
  const hit = (method, p, { body, headers, env = ENV, now = NOW } = {}) => R.handleOAuthRoute(new Request(ORIGIN + p, { method, headers, body }), env, call, now);
  const cookiesOf = (res) => res.headers.getSetCookie();
  const cookieValue = (res, name) => { const c = cookiesOf(res).find((x) => x.startsWith(name + '=')); return c ? c.slice(name.length + 1).split(';')[0] : null; };
  const form = (o) => new URLSearchParams(o).toString();
  const FORM = { 'content-type': 'application/x-www-form-urlencoded' };

  // ---- (5) closed unless everything is in place; discovery ----
  for (const p of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-authorization-server/mcp']) {
    const r = await hit('GET', p), b = await r.json();
    check(r.status === 200 && r.headers.get('access-control-allow-origin') === '*' && (p.includes('protected') ? b.resource === ORIGIN + '/mcp' : b.token_endpoint === ORIGIN + '/oauth/token'), 'discovery answers ' + p);
  }
  check((await hit('GET', '/health')) === null && (await hit('GET', '/mcp')) === null, 'a path that is not an OAuth route is left alone (null)');
  { const closed = []; for (const env of [{ ...ENV, MCP: 'off' }, { ...ENV, BUSINESS_MODE: undefined }, { ...ENV, SESSION_SECRET: '' }, { BUSINESS_MODE: 'object' }]) for (const [m, p] of [['GET', '/.well-known/oauth-protected-resource'], ['POST', '/oauth/register'], ['GET', '/oauth/authorize'], ['POST', '/oauth/consent'], ['POST', '/oauth/token']]) closed.push((await hit(m, p, { env })).status);
    check(closed.length === 20 && closed.every((s) => s === 404), 'with MCP off, no business objects, or no secret, every OAuth route is closed (404)'); }
  check((await hit('OPTIONS', '/oauth/token')).status === 204 && (await hit('POST', '/.well-known/oauth-authorization-server')).status === 405 && (await hit('GET', '/oauth/token')).status === 405 && (await hit('GET', '/oauth/consent')).status === 405 && (await hit('POST', '/oauth/authorize')).status === 405, 'a preflight is answered and a wrong method is 405');

  // ---- registration ----
  const registerJson = async (b) => hit('POST', '/oauth/register', { body: typeof b === 'string' ? b : JSON.stringify(b), headers: { 'content-type': 'application/json' } });
  const reg = await registerJson({ client_name: 'Claude', redirect_uris: [CB] }), client = await reg.json();
  check(reg.status === 201 && typeof client.client_id === 'string', 'a client registers through the route (201)');
  check((await registerJson({ client_name: 'X', redirect_uris: ['https://evil.example/cb'] })).status === 400 && (await registerJson('not json')).status === 400 && (await registerJson('x'.repeat(9000))).status === 400, 'a stranger\'s return address, a body that is not JSON, and an oversized body are refused (400)');

  // ---- (1) authorize ----
  const authQuery = (o = {}) => '?' + form({ client_id: client.client_id, redirect_uri: CB, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', state: 'st-1', ...o });
  { const bad = [['an unknown client', { client_id: 'nope' }], ['another return address', { redirect_uri: 'https://evil.example/cb' }], ['no challenge', { code_challenge: '' }], ['a plain challenge method', { code_challenge_method: 'plain' }], ['an implicit-flow request', { response_type: 'token' }], ['a scope that is not offered', { scope: 'mcp:write' }]];
    let ok = 0; for (const [, o] of bad) { const r = await hit('GET', '/oauth/authorize' + authQuery(o)); if (r.status === 400 && !r.headers.get('location') && cookiesOf(r).length === 0 && (r.headers.get('content-type') || '').startsWith('text/html')) ok++; }
    check(ok === bad.length, 'a failed authorize request (' + bad.map((b) => b[0]).join(', ') + ') is a plain page: no redirect, no cookie');
    const r = await hit('GET', '/oauth/authorize' + authQuery()), cookie = cookiesOf(r)[0] || '';
    check(r.status === 302 && r.headers.get('location') === '/auth/google/login?mcp=1' && /^oauth_mcp=/.test(cookie) && /HttpOnly/.test(cookie) && /Secure/.test(cookie) && /SameSite=Lax/.test(cookie) && /Max-Age=600/.test(cookie), 'a good request is parked in a short-lived HttpOnly cookie and sent to the Google sign-in'); }

  // ---- the whole flow, as a function ----
  const signIn = async ({ role = 'owner', active = true, businessId = 'acme-co', email = 'owner@example.com', tamper, now = NOW, noCookie } = {}) => {
    const auth = await hit('GET', '/oauth/authorize' + authQuery());
    let sealed = cookieValue(auth, 'oauth_mcp'); if (tamper) sealed = sealed.slice(0, -2) + (sealed.endsWith('AA') ? 'BB' : 'AA');
    const req = new Request(ORIGIN + '/auth/google/callback', { headers: noCookie ? {} : { cookie: 'oauth_mcp=' + sealed } });
    return R.continueOAuthSignIn(req, ENV, { email, businessId, role, active }, now);
  };
  const consentOf = async (res) => { const html = await res.text(); const m = /name="ticket" value="([^"]+)"/.exec(html); return { html, ticket: m && m[1], nonce: cookieValue(res, 'oauth_mcp_nonce') }; };
  const allow = (c, extra = {}) => hit('POST', '/oauth/consent', { body: form({ ticket: c.ticket, decision: 'allow' }), headers: { ...FORM, cookie: 'oauth_mcp_nonce=' + c.nonce, ...extra } });
  const target = (res) => new URL(res.headers.get('location'));

  // ---- (2) the Google hook ----
  check((await signIn({ noCookie: true })) === null, 'a sign-in that is not for an assistant is left to the app (null)');
  const owner = await signIn(), page = await consentOf(owner);
  check(owner.status === 200 && page.ticket && /Claude/.test(page.html) && /owner@example\.com/.test(page.html) && /acme-co/.test(page.html) && /read/i.test(page.html), 'an active owner is shown the consent page naming the assistant, the account and the business');
  check(owner.headers.get('x-frame-options') === 'DENY' && /frame-ancestors 'none'/.test(owner.headers.get('content-security-policy') || '') && owner.headers.get('cache-control') === 'no-store' && /SameSite=Strict/.test(cookiesOf(owner).find((c) => c.startsWith('oauth_mcp_nonce=')) || '') && /oauth_mcp=;.*Max-Age=0/.test(cookiesOf(owner).find((c) => c.startsWith('oauth_mcp=')) || ''), 'the page cannot be framed, is never cached, sets its nonce cookie (SameSite=Strict) and clears the request cookie');
  { const denied = []; for (const spec of [{ role: 'accountant' }, { role: 'installer' }, { role: 'sales' }, { role: 'admin' }, { active: false }, { businessId: null }, { role: null }]) { const r = await signIn(spec); denied.push(r.status === 302 && target(r).origin + target(r).pathname === CB && target(r).searchParams.get('error') === 'access_denied' && target(r).searchParams.get('state') === 'st-1' && !target(r).searchParams.get('code')); }
    check(denied.every(Boolean), 'every other role, an inactive member, no business and no role are sent back to the assistant as access_denied, with its state and no code'); }
  { const all = [owner, await signIn({ role: 'sales' }), await signIn({ tamper: true })].flatMap(cookiesOf).join('\n'); check(!/office_session/.test(all), 'no normal session cookie is issued on this path'); }
  { const t = await signIn({ tamper: true }), e = await signIn({ now: NOW + 11 * 60 * 1000 });
    check(t.status === 400 && !t.headers.get('location') && e.status === 400 && !e.headers.get('location'), 'a tampered or expired request cookie is a plain page (400), not a redirect'); }
  { const off = await R.continueOAuthSignIn(new Request(ORIGIN + '/auth/google/callback', { headers: { cookie: 'oauth_mcp=x' } }), { ...ENV, MCP: 'off' }, { email: 'owner@example.com', businessId: 'acme-co', role: 'owner', active: true }, NOW);
    check(off.status === 404 && !off.headers.get('location'), 'with MCP off the hook refuses even a cookie that is present'); }

  // ---- (3) consent ----
  { const r = await allow(page), t = target(r);
    check(r.status === 302 && t.origin + t.pathname === CB && t.searchParams.get('state') === 'st-1' && typeof t.searchParams.get('code') === 'string' && /oauth_mcp_nonce=;.*Max-Age=0/.test(cookiesOf(r)[0] || ''), 'Allow sends the browser back with a code and its state, and clears the nonce'); }
  { const p = await consentOf(await signIn());
    const noNonce = await hit('POST', '/oauth/consent', { body: form({ ticket: p.ticket, decision: 'allow' }), headers: FORM });
    const wrongNonce = await hit('POST', '/oauth/consent', { body: form({ ticket: p.ticket, decision: 'allow' }), headers: { ...FORM, cookie: 'oauth_mcp_nonce=' + b64u(crypto.randomBytes(18)) } });
    const foreign = await allow(p, { origin: 'https://evil.example' }), nullCross = await allow(p, { origin: 'null', 'sec-fetch-site': 'cross-site' }), crossOnly = await allow(p, { 'sec-fetch-site': 'cross-site' });
    const forged = await hit('POST', '/oauth/consent', { body: form({ ticket: p.ticket.slice(0, -2) + 'AA', decision: 'allow' }), headers: { ...FORM, cookie: 'oauth_mcp_nonce=' + p.nonce } });
    const code = target(await allow(await consentOf(await signIn()))).searchParams.get('code');
    const asTicket = await hit('POST', '/oauth/consent', { body: form({ ticket: code, decision: 'allow' }), headers: { ...FORM, cookie: 'oauth_mcp_nonce=' + p.nonce } });
    const late = await R.handleOAuthRoute(new Request(ORIGIN + '/oauth/consent', { method: 'POST', body: form({ ticket: p.ticket, decision: 'allow' }), headers: { ...FORM, cookie: 'oauth_mcp_nonce=' + p.nonce } }), ENV, call, NOW + 11 * 60 * 1000);
    check([noNonce, wrongNonce, forged, asTicket, late].every((r) => r.status === 400 && !r.headers.get('location')) && [foreign, nullCross, crossOnly].every((r) => r.status === 403 && !r.headers.get('location')), 'Allow without the nonce cookie, with another browser\'s nonce, with a forged, expired or wrong-kind ticket (400), or posted from another site (403: a foreign Origin, or the browser saying cross-site even with Origin null), grants nothing and redirects nowhere'); }
  { const sameSite = await allow(await consentOf(await signIn()), { origin: 'null', 'sec-fetch-site': 'same-origin' }), t = target(sameSite);
    check(sameSite.status === 302 && t.origin + t.pathname === CB && !!t.searchParams.get('code'), 'Allow works when the browser sends Origin: null with Sec-Fetch-Site same-origin (what Chrome sends from this page): the real-phone failure of 2026-10-25'); }
  { const p = await consentOf(await signIn()), r = await hit('POST', '/oauth/consent', { body: form({ ticket: p.ticket, decision: 'deny' }), headers: { ...FORM, cookie: 'oauth_mcp_nonce=' + p.nonce } }), t = target(r), other = await hit('POST', '/oauth/consent', { body: form({ ticket: p.ticket }), headers: { ...FORM, cookie: 'oauth_mcp_nonce=' + p.nonce } });
    check(t.searchParams.get('error') === 'access_denied' && !t.searchParams.get('code') && target(other).searchParams.get('error') === 'access_denied', 'Cancel, and anything that is not exactly "allow", is access_denied with no code'); }

  // ---- (4) token ----
  const getCode = async () => target(await allow(await consentOf(await signIn()))).searchParams.get('code');
  const tokenForm = (code, o = {}) => form({ grant_type: 'authorization_code', code, client_id: client.client_id, redirect_uri: CB, code_verifier: verifier, ...o });
  const token = (code, o) => hit('POST', '/oauth/token', { body: tokenForm(code, o), headers: FORM });
  { calls.length = 0; const code = await getCode(), r = await token(code), b = await r.json();
    check(r.status === 200 && b.access_token === 'omk.acme-co.0123456789abcdef.secret' && b.token_type === 'Bearer' && b.scope === 'mcp:read' && !('refresh_token' in b) && r.headers.get('cache-control') === 'no-store' && r.headers.get('access-control-allow-origin') === '*', 'a good code with the right verifier is traded for a read-only key (no refresh token, never cached)');
    const [, businessId, method, route, sent] = calls[0] || [];
    check(calls.length === 1 && businessId === 'acme-co' && method === 'POST' && route === '/debug/mcp-oauth-issue' && sent.email === 'owner@example.com' && /^Claude connector: Claude$/.test(sent.label) && /^[A-Za-z0-9_-]{22}$/.test(sent.jti), 'the key is asked of the signed-in owner\'s own business, through the internal route, with the code\'s one-time id'); }
  { // THE WHOLE WAY, as a browser does it: read the real consent page, tick a choice, press Allow, send exactly the fields the page's own form holds. (The earlier test posted the field by hand and so missed that the choice sat outside the form and was never sent.)
    const browserForm = (html, { pick, click }) => { const forms = [...html.matchAll(/<form\b[^>]*>([\s\S]*?)<\/form>/gi)]; const form = forms.find((f) => new RegExp(`<button[^>]*name="decision"[^>]*value="${click}"`).test(f[1])); if (!form) return null; const params = new URLSearchParams(); const radios = [...form[1].matchAll(/<input\b[^>]*type="radio"[^>]*>/gi)].map((m) => m[0]);
      for (const m of form[1].matchAll(/<input\b[^>]*type="hidden"[^>]*>/gi)) params.set(/name="([^"]*)"/.exec(m[0])[1], /value="([^"]*)"/.exec(m[0])[1]);
      const chosen = radios.find((r) => (pick ? new RegExp(`value="${pick}"`).test(r) : / checked/.test(r))); if (chosen) params.set(/name="([^"]*)"/.exec(chosen)[1], /value="([^"]*)"/.exec(chosen)[1]); params.set('decision', click); return params; };
    const viaBrowser = async (pick) => { const c = await consentOf(await signIn()); const sub = browserForm(c.html, { pick, click: 'allow' }); const res = await hit('POST', '/oauth/consent', { body: sub.toString(), headers: { ...FORM, cookie: 'oauth_mcp_nonce=' + c.nonce } }); calls.length = 0; const r = await token(target(res).searchParams.get('code')), b = await r.json(); return { scope: b.scope, sent: calls[0] && calls[0][4] }; };
    const w = await viaBrowser('write'), d = await viaBrowser(undefined), r = await viaBrowser('read');
    check(w.scope === 'mcp:write' && w.sent.scope === 'mcp:write' && d.scope === 'mcp:read' && d.sent.scope === 'mcp:read' && r.scope === 'mcp:read' && r.sent.scope === 'mcp:read', 'THE WHOLE WAY, as a browser submits the real page: ticking "Read and create" and pressing Allow gives a create key; pressing Allow with nothing touched, or "Read only", gives a read-only key'); }
  { // the owner's choice on the consent page reaches the key that is issued: create only for exactly "write"
    const withAccess = async (access) => { const c = await consentOf(await signIn()); const res = await hit('POST', '/oauth/consent', { body: form({ ticket: c.ticket, decision: 'allow', ...(access === undefined ? {} : { access }) }), headers: { ...FORM, cookie: 'oauth_mcp_nonce=' + c.nonce } }); calls.length = 0; const r = await token(target(res).searchParams.get('code')), b = await r.json(); return { scope: b.scope, sent: calls[0] && calls[0][4] }; };
    const w = await withAccess('write'), results = [await withAccess(undefined), await withAccess('read'), await withAccess('WRITE'), await withAccess('writes'), await withAccess('mcp:write'), await withAccess('')];
    check(w.scope === 'mcp:write' && w.sent.scope === 'mcp:write' && results.every((x) => x.scope === 'mcp:read' && x.sent.scope === 'mcp:read'), 'Allow with "Read and create" ticked asks the business for a create-scope key; Allow with nothing ticked, "read", or anything else asks for a read-only key'); }
  { const code = await getCode(), good = await token(code); script = async () => ({ ok: false, json: async () => ({ reason: 'replayed' }) }); const again = await token(code), ab = await again.json(); script = async () => ({ ok: true, json: async () => ({ key: 'omk.acme-co.0123456789abcdef.secret' }) });
    check(good.status === 200 && again.status === 400 && ab.error === 'invalid_grant' && /already been used/.test(ab.error_description), 'a code that has been used is refused when the business says so (invalid_grant)'); }
  { const code = await getCode(); calls.length = 0;
    const wrongVerifier = await token(code, { code_verifier: b64u(crypto.randomBytes(32)) }), wrongUri = await token(code, { redirect_uri: 'http://localhost:9/cb' }), wrongClient = await token(code, { client_id: 'other' }), junk = await token('x.y'), wrongGrant = await token(code, { grant_type: 'password' });
    check([wrongVerifier, wrongUri, wrongClient, junk].every((r) => r.status === 400) && wrongGrant.status === 400 && calls.length === 0, 'the wrong verifier, address, client, a junk code or another grant type is refused (400) before the business is even asked'); }
  { const code = await getCode(); const late = await R.handleOAuthRoute(new Request(ORIGIN + '/oauth/token', { method: 'POST', body: tokenForm(code), headers: FORM }), ENV, call, NOW + 6 * 60 * 1000);
    check(late.status === 400 && (await late.json()).error === 'invalid_grant', 'a code older than five minutes is refused'); }
  { const code = await getCode(); const results = [];
    for (const [reply, status] of [[async () => { throw new Error('down'); }, 503], [async () => ({ ok: false, json: async () => ({ reason: 'not_owner' }) }), 400], [async () => ({ ok: false, json: async () => ({ reason: 'limit' }) }), 400], [async () => ({ ok: false, json: async () => ({}) }), 503], [async () => ({ ok: true, json: async () => ({}) }), 503]]) { script = reply; const r = await token(code); results.push(r.status === status && !('access_token' in (await r.json()))); }
    script = async () => ({ ok: true, json: async () => ({ key: 'omk.acme-co.0123456789abcdef.secret' }) });
    check(results.every(Boolean), 'when the business is down, refuses, or answers without a key, nothing is granted (no access_token)'); }
  check((await hit('POST', '/oauth/token', { body: 'x'.repeat(9000), headers: FORM })).status === 400, 'an oversized token request is refused');

  // ---- (6) the business's half, through the real pipeline ----
  const harness = require('./harness.js'), workerDir = path.join(srcDir, '..'), fns = await harness.loadFunctions(workerDir);
  const BENV = { BUSINESS_ID: 'acme-co', ADMIN_KEY: 'admin-key-test', ADMIN_CONFIRM_KEY: 'admin-confirm-test' };
  const issue = (name, body, extra = {}) => harness.runRouteCase(fns, workerDir, { name, method: 'POST', path: '/debug/mcp-oauth-issue', body, admin: true, env: BENV, ...extra });
  const JTI = () => b64u(crypto.randomBytes(16)), written = (r) => JSON.stringify(r.writes);
  const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
  { const jti = JTI(), r = await issue('owner issues', { email: 'owner@example.com', label: 'Claude connector: Claude', jti }), b = r.result.body, p = mk.parseKey(b.key);
    check(r.result.status === 200 && p && p.businessId === 'acme-co' && r.result.body.reason === undefined, 'the business issues a key to an active owner');
    check(written(r).includes(jti) && written(r).includes(sha(p.secret)) && !written(r).includes(p.secret) && written(r).includes('Claude connector: Claude'), 'it records the code\'s one-time id and stores only the key\'s hash and its label (never the secret)'); }
  { const w = await issue('write scope', { email: 'owner@example.com', label: 'Claude connector: Claude', jti: JTI(), scope: 'mcp:write' }), d = await issue('default scope', { email: 'owner@example.com', label: 'x', jti: JTI() }), junk = []; for (const scope of ['MCP:WRITE', 'write', '', null, 5, 'mcp:admin']) junk.push(await issue('odd scope', { email: 'owner@example.com', label: 'x', jti: JTI(), scope }));
    check(w.result.status === 200 && written(w).includes('mcp:write') && d.result.status === 200 && !written(d).includes('mcp:write') && junk.every((r) => r.result.status === 200 && !written(r).includes('mcp:write')), 'the internal issue route makes a create-scope key only for exactly "mcp:write"; no scope or any other value makes a read-only key'); }
  { const jti = JTI(), first = await issue('first use', { email: 'owner@example.com', label: 'a', jti }), again = await issue('second use', { email: 'owner@example.com', label: 'a', jti }, { before: [{ method: 'POST', path: '/debug/mcp-oauth-issue', body: { email: 'owner@example.com', label: 'a', jti }, admin: true }] });
    check(first.result.status === 200 && again.result.status === 400 && again.result.body.reason === 'replayed' && !written(again).includes('mcp_keys'), 'a code works once: the second use is refused (replayed) and issues no key'); }
  { const refused = []; for (const email of ['accountant@example.com', 'installer@example.com', 'sales@example.com', 'admin@example.com', 'nobody@example.com']) { const r = await issue('not owner ' + email, { email, label: 'x', jti: JTI() }); refused.push(r.result.status === 403 && r.result.body.reason === 'not_owner' && !written(r).includes('mcp_keys') && !written(r).includes('mcp_oauth_codes')); }
    check(refused.every(Boolean), 'every role that is not the owner, and an address that is not a member, is refused (403) and writes nothing'); }
  { const gone = await issue('deactivated owner', { email: 'owner@example.com', label: 'x', jti: JTI() }, { seed: (db) => { db.exec("CREATE TRIGGER deactivate_owner AFTER INSERT ON memberships WHEN NEW.google_email = 'owner@example.com' BEGIN UPDATE memberships SET status = 'inactive' WHERE rowid = NEW.rowid; END"); } });
    check(gone.result.status === 403, 'an owner who has been deactivated since the code was issued is refused (the check is made when the key is issued, not before)'); }
  { const bad = []; for (const body of [{ email: 'owner@example.com', label: 'x' }, { email: 'owner@example.com', label: 'x', jti: 'short' }, { email: 'owner@example.com', label: 'x', jti: 5 }, { label: 'x', jti: JTI() }, { email: 5, label: 'x', jti: JTI() }]) { const r = await issue('bad body', body); bad.push(r.result.status === 400 && !written(r).includes('mcp_keys')); }
    check(bad.every(Boolean), 'a missing or malformed one-time id or address is refused (400)'); }
  { const off = await issue('mcp off', { email: 'owner@example.com', label: 'x', jti: JTI() }, { env: { ...BENV, MCP: 'off' } }), none = await issue('no business', { email: 'owner@example.com', label: 'x', jti: JTI() }, { env: { ...BENV, BUSINESS_ID: undefined } });
    check(off.result.status === 409 && none.result.status === 400 && !written(off).includes('mcp_keys') && !written(none).includes('mcp_keys'), 'with MCP off, or for a deployment with no business of its own, nothing is issued'); }
  { const DDL = "CREATE TABLE IF NOT EXISTS mcp_keys (id TEXT PRIMARY KEY, label TEXT NOT NULL, email TEXT NOT NULL, hash TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), created_by TEXT NOT NULL, last_used_at TEXT, revoked_at TEXT, uses INTEGER NOT NULL DEFAULT 0)";
    const full = await issue('too many keys', { email: 'owner@example.com', label: 'x', jti: JTI() }, { seed: (db) => { db.exec(DDL); for (let i = 0; i < 10; i++) db.prepare("INSERT INTO mcp_keys (id, label, email, hash, created_by) VALUES (?, 'k', 'owner@example.com', 'h', 'owner@example.com')").run(String(i).padStart(16, '0')); } });
    check(full.result.status === 409 && full.result.body.reason === 'limit', 'at ten active keys the owner is told to revoke one first (limit)'); }
  { const asOwner = await harness.runRouteCase(fns, workerDir, { name: 'owner session calls the internal route', method: 'POST', path: '/debug/mcp-oauth-issue', body: { email: 'owner@example.com', label: 'x', jti: JTI() }, role: 'owner', env: BENV }), noAuth = await harness.runRouteCase(fns, workerDir, { name: 'no credentials', method: 'POST', path: '/debug/mcp-oauth-issue', body: { email: 'owner@example.com', label: 'x', jti: JTI() }, noSession: true, env: BENV }), noConfirm = await issue('admin key without the second secret', { email: 'owner@example.com', label: 'x', jti: JTI() }, { adminNoConfirm: true });
    check([asOwner, noAuth, noConfirm].every((r) => r.result.status >= 401 && r.result.status < 500 && !written(r).includes('mcp_keys')), 'the internal route is opened only by the admin key and its second secret: an owner\'s own session, no credentials, and the key alone are all refused'); }
}
