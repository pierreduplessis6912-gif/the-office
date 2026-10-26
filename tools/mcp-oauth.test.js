// The OAuth core for assistants that cannot send a static key (worker/src/mcp-oauth.ts; MCP_ARCHITECTURE.md, "OAuth"). SECURITY-SENSITIVE: it decides who can obtain a key without pasting one. The rules pinned here: (1) only the assistants' own return addresses can ever be registered; (2) an unregistered or tampered client is refused and NEVER redirected; (3) PKCE S256 is mandatory and checked; (4) a value of one kind (client id, ticket, code) cannot stand in for another; (5) tickets and codes expire; (6) a code works once; (7) nothing the consent page prints can carry script; (8) the only scope is read.
const path = require('path'), fs = require('fs'), os = require('os'), crypto = require('crypto'), esbuild = require('esbuild');

module.exports = async function runMcpOauthTests({ check, srcDir }) {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mo-')), 'm.js');
  esbuild.buildSync({ entryPoints: [path.join(srcDir, 'mcp-oauth.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent' });
  const o = require(out);
  const env = { SESSION_SECRET: 'test-secret-one' }, other = { SESSION_SECRET: 'test-secret-two' };
  const NOW = 1_800_000_000_000, b64u = (b) => Buffer.from(b).toString('base64url');
  const verifier = b64u(crypto.randomBytes(32)), challenge = b64u(crypto.createHash('sha256').update(verifier).digest());
  const CB = 'https://claude.ai/api/mcp/auth_callback';
  const reg = async (b, e = env) => o.registerClient(e, b, NOW);

  // discovery
  const rm = o.protectedResourceMetadata('https://office.example'), am = o.authorizationServerMetadata('https://office.example');
  check(rm.resource === 'https://office.example/mcp' && rm.authorization_servers[0] === 'https://office.example' && rm.scopes_supported.join() === 'mcp:read', 'the protected-resource document names the endpoint, the one authorization server and the one scope');
  check(am.issuer === 'https://office.example' && am.code_challenge_methods_supported.join() === 'S256' && am.grant_types_supported.join() === 'authorization_code' && am.token_endpoint_auth_methods_supported.join() === 'none' && am.registration_endpoint.endsWith('/oauth/register'), 'the authorization-server document offers the code grant, S256 only, no client secret, and a registration endpoint');
  check(o.challengeHeader('https://office.example') === 'Bearer resource_metadata="https://office.example/.well-known/oauth-protected-resource"', 'an unauthenticated call is pointed at the discovery document');

  // registration
  const ok = await reg({ client_name: 'Claude', redirect_uris: [CB] });
  check(ok.ok && ok.status === 201 && ok.body.token_endpoint_auth_method === 'none' && ok.body.redirect_uris[0] === CB && typeof ok.body.client_id === 'string', 'the claude.ai return address registers');
  check((await reg({ client_name: 'Claude', redirect_uris: ['https://claude.com/api/mcp/auth_callback'] })).ok, 'the claude.com return address registers');
  check((await reg({ client_name: 'Tool', redirect_uris: ['http://localhost:8123/callback', 'http://127.0.0.1/cb'] })).ok, 'a loopback address on the owner\'s own machine registers');
  for (const [why, uri] of [['an attacker site', 'https://evil.example/cb'], ['a lookalike host', 'https://claude.ai.evil.example/api/mcp/auth_callback'], ['a different path on claude.ai', 'https://claude.ai/other'], ['plain http to claude.ai', 'http://claude.ai/api/mcp/auth_callback'], ['a user-info trick', 'http://localhost@evil.example/cb'], ['a loopback lookalike', 'http://localhost.evil.example/cb'], ['a fragment', CB + '#x'], ['a custom scheme', 'javascript:alert(1)'], ['a number', 5]]) check(!(await reg({ client_name: 'X', redirect_uris: [uri] })).ok, 'registration refuses ' + why);
  check(!(await reg({ client_name: 'X', redirect_uris: [CB, 'https://evil.example/cb'] })).ok, 'one bad address among good ones refuses the whole registration');
  check(!(await reg({ client_name: 'X', redirect_uris: [] })).ok && !(await reg({ client_name: 'X', redirect_uris: Array(6).fill(CB) })).ok && !(await reg({ client_name: 'X' })).ok, 'zero, six, or missing return addresses are refused');
  for (const name of ['', '   ', 'a'.repeat(61), '<script>', 'line\nbreak', 5, null]) check(!(await reg({ client_name: name, redirect_uris: [CB] })).ok, 'registration refuses the name ' + JSON.stringify(name));
  check(!(await reg(null)).ok && !(await reg([])).ok && !(await reg('x')).ok, 'registration refuses a body that is not an object');

  // authorize
  const params = (over = {}) => new URLSearchParams({ client_id: ok.body.client_id, redirect_uri: CB, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', state: 'abc', ...over });
  const good = await o.parseAuthorize(env, params(), NOW);
  check(good.ok && good.request.client_name === 'Claude' && good.request.redirect_uri === CB && good.request.state === 'abc', 'a correct authorize request is accepted');
  const refused = async (over, why) => { const r = await o.parseAuthorize(env, params(over), NOW); check(!r.ok && r.status === 400 && !('request' in r), why); return r; };
  await refused({ client_id: 'garbage' }, 'an unknown client is refused (and given a page, not a redirect)');
  await refused({ client_id: ok.body.client_id.slice(0, -2) + 'AA' }, 'a client id with a tampered signature is refused');
  await refused({ redirect_uri: 'https://claude.com/api/mcp/auth_callback' }, 'a return address the client did not register is refused, even though it is allowed in general');
  await refused({ response_type: 'token' }, 'the implicit flow is refused');
  await refused({ code_challenge_method: 'plain' }, 'PKCE plain is refused');
  await refused({ code_challenge: '' }, 'a missing code challenge is refused');
  await refused({ code_challenge: 'short' }, 'a malformed code challenge is refused');
  await refused({ scope: 'mcp:read mcp:write' }, 'a scope beyond read is refused');
  check((await o.parseAuthorize(env, params({ scope: 'mcp:read' }), NOW)).ok, 'the read scope is accepted');
  await refused({ state: 'x'.repeat(513) }, 'an oversized state is refused');
  check(!(await o.parseAuthorize(other, params(), NOW)).ok, 'a client registered under another secret is refused');

  // tickets and codes
  const who = { email: 'owner@example.com', businessId: 'acme-co' };
  const ticket = await o.makeTicket(env, good.request, who, 'nonce1', NOW);
  const t = await o.openTicket(env, ticket, NOW + 1000);
  check(t && t.email === who.email && t.businessId === 'acme-co' && t.nonce === 'nonce1' && t.challenge === challenge, 'a ticket carries who signed in, for which business, asking what');
  check(!(await o.openTicket(env, ticket, NOW + o.TICKET_TTL_MS + 1)), 'a ticket expires after ten minutes');
  check(!(await o.openTicket(env, ticket.slice(0, -2) + 'AA', NOW)) && !(await o.openTicket(other, ticket, NOW)) && !(await o.openTicket(env, undefined, NOW)) && !(await o.openTicket(env, 'a.b.c', NOW)), 'a tampered, foreign, missing or malformed ticket is refused');
  check(!(await o.openTicket(env, ok.body.client_id, NOW)), 'a client id cannot be used as a ticket');
  const dest = new URL(await o.grant(env, t, NOW));
  check(dest.origin + dest.pathname === CB && dest.searchParams.get('state') === 'abc' && dest.searchParams.get('code').length > 50, 'Allow sends the browser to the registered address with a code and the state');
  const denied = new URL(o.deny(t));
  check(denied.origin + denied.pathname === CB && denied.searchParams.get('error') === 'access_denied' && denied.searchParams.get('state') === 'abc' && !denied.searchParams.has('code'), 'Cancel sends the browser back saying no, with no code');
  check(!(await o.openTicket(env, dest.searchParams.get('code'), NOW)), 'a code cannot be used as a ticket');

  // the token endpoint
  const code = dest.searchParams.get('code'), used = new Set(); let issued = 0;
  const issue = async ({ email, businessId, label, jti }) => { if (used.has(jti)) return { ok: false, reason: 'replayed' }; used.add(jti); issued++; return { ok: true, key: `omk.${businessId}.0011223344556677.secret`, _label: label, _email: email }; };
  const form = (over = {}) => new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: CB, client_id: ok.body.client_id, code_verifier: verifier, ...over });
  const early = await o.exchangeCode(env, form({ code_verifier: b64u(crypto.randomBytes(32)) }), issue, NOW + 1000);
  check(early.status === 400 && early.body.error === 'invalid_grant' && issued === 0, 'a wrong verifier is refused and nothing is issued');
  for (const [over, why] of [[{ client_id: 'someone-else' }, 'another client id'], [{ redirect_uri: 'https://claude.com/api/mcp/auth_callback' }, 'another return address'], [{ code: 'x.y' }, 'a malformed code'], [{ code: ticket }, 'a ticket in place of a code'], [{ grant_type: 'password' }, 'another grant type'], [{ code_verifier: 'short' }, 'a short verifier'], [{ code_verifier: '' }, 'no verifier']]) { const r = await o.exchangeCode(env, form(over), issue, NOW + 1000); check(r.status === 400 && issued === 0, 'the token endpoint refuses ' + why); }
  check((await o.exchangeCode(env, form(), issue, NOW + o.CODE_TTL_MS + 1)).status === 400 && issued === 0, 'a code expires after five minutes');
  check((await o.exchangeCode(other, form(), issue, NOW + 1000)).status === 400 && issued === 0, 'a code signed under another secret is refused');
  const win = await o.exchangeCode(env, form(), issue, NOW + 1000);
  check(win.status === 200 && win.body.token_type === 'Bearer' && win.body.scope === 'mcp:read' && win.body.access_token.startsWith('omk.acme-co.') && !('refresh_token' in win.body) && issued === 1, 'the right code, client, address and verifier get a read-only key, once');
  const again = await o.exchangeCode(env, form(), issue, NOW + 2000);
  check(again.status === 400 && again.body.error === 'invalid_grant' && !('access_token' in again.body) && issued === 1, 'the same code a second time is refused');
  const labelled = await (async () => { let seen; await o.exchangeCode(env, form(), async (w) => { seen = w; return { ok: true, key: 'k' }; }, NOW + 3000); return seen; })();
  check(labelled.label === 'Claude connector: Claude' && labelled.email === who.email && labelled.businessId === 'acme-co', 'the key is labelled so the owner can find and stop it in the Assistants screen');
  for (const reason of ['limit', 'not_owner', 'other']) { const r = await o.exchangeCode(env, form(), async () => ({ ok: false, reason }), NOW + 3000); check(r.status !== 200 && !('access_token' in r.body), 'when the key cannot be issued (' + reason + ') nothing is granted'); }

  // the consent page
  const page = o.consentPage({ clientName: '<img src=x onerror=alert(1)>', businessId: 'acme"co', email: "o'<b>@example.com", ticket: 'a.b' });
  check(!page.includes('<img') && !page.includes("o'<b>@") && !page.includes('onerror=alert(1)>') && !page.includes('acme"co') && page.includes('&lt;img') && page.includes('o&#39;&lt;b&gt;@') && page.includes('acme&quot;co') && page.includes('action="/oauth/consent"') && (page.match(/<button/g) || []).length === 2 && page.includes('name="ticket"') && !/<script/i.test(page), 'the consent page escapes everything it prints, posts only to /oauth/consent, has exactly two buttons and no script');
  check(page.includes('name="access" value="read" checked') && /name="access" value="write"(?! checked)/.test(page) && !/value="write" checked/.test(page) && /never delete anything, move money or change who has access/.test(page) && /payments received/.test(page) && /schedule jobs/.test(page) && /20 changes an hour and 100 a day/.test(page) && /R50,000/.test(page) && (page.match(/<button/g) || []).length === 2, 'the consent page offers read only (ticked) or read and create, says what create can and cannot do and its limits, and still has exactly two buttons');

  // WHAT A BROWSER SENDS. The choice must be INSIDE the form the Allow button submits: a radio outside the form is never sent, and every connection is then read only whatever the owner ticked (this was a real bug: the tests posted the field directly). This reads the page the way a browser does.
  const browserForm = (html, { pick, click }) => {
    const forms = [...html.matchAll(/<form\b[^>]*>([\s\S]*?)<\/form>/gi)];
    const form = forms.find((f) => new RegExp(`<button[^>]*name="decision"[^>]*value="${click}"`).test(f[1]));
    if (!form) return null;
    const params = new URLSearchParams(); const radios = [...form[1].matchAll(/<input\b[^>]*type="radio"[^>]*>/gi)].map((m) => m[0]);
    for (const m of form[1].matchAll(/<input\b[^>]*type="hidden"[^>]*>/gi)) params.set(/name="([^"]*)"/.exec(m[0])[1], /value="([^"]*)"/.exec(m[0])[1]);
    const chosen = radios.find((r) => (pick ? new RegExp(`value="${pick}"`).test(r) : / checked/.test(r)));
    if (chosen) params.set(/name="([^"]*)"/.exec(chosen)[1], /value="([^"]*)"/.exec(chosen)[1]);
    params.set('decision', click);
    return { params, radios, formHtml: form[1] };
  };
  { const allowDefault = browserForm(page, { click: 'allow' }), allowWrite = browserForm(page, { pick: 'write', click: 'allow' }), allowRead = browserForm(page, { pick: 'read', click: 'allow' }), cancel = browserForm(page, { click: 'deny' });
    check(allowDefault !== null && allowDefault.radios.length === 2 && (page.match(/<form\b/g) || []).length === 1 && allowDefault.params.get('ticket') !== null && allowDefault.params.get('decision') === 'allow', 'the page has ONE form, and the ticket, both choices and both buttons are in it');
    check(allowDefault.params.get('access') === 'read' && o.scopeFromChoice(allowDefault.params.get('access')) === 'mcp:read' && allowRead.params.get('access') === 'read', 'pressing Allow with nothing touched sends "read": read only is the default');
    check(allowWrite.params.get('access') === 'write' && o.scopeFromChoice(allowWrite.params.get('access')) === 'mcp:write' && allowWrite.params.get('decision') === 'allow', 'ticking "Read and create" and pressing Allow SENDS access=write (the choice reaches the server)');
    check(cancel.params.get('decision') === 'deny' && (allowDefault.formHtml.match(/ checked/g) || []).length === 1 && /value="read" checked/.test(allowDefault.formHtml), 'Cancel sends deny, and exactly one choice (read only) is ticked when the page opens'); }

  // the owner's choice of scope: create only when the owner picks it, by the exact word, and only ever through the signed code
  check(o.scopeFromChoice('write') === 'mcp:write' && [undefined, null, '', 'read', 'WRITE', 'write ', 'mcp:write', 'writes', 5, ['write'], {}].every((v) => o.scopeFromChoice(v) === 'mcp:read'), 'the choice becomes mcp:write only for exactly "write"; anything else, or nothing, is mcp:read');
  { const seen = []; const take = async (w) => { seen.push(w.scope); return { ok: true, key: 'omk.acme-co.0011223344556677.secret' }; };
    const exchange = async (scopeArg) => { const d = new URL(scopeArg === 'NONE' ? await o.grant(env, t, NOW) : await o.grant(env, t, NOW, scopeArg)); const f = new URLSearchParams({ grant_type: 'authorization_code', code: d.searchParams.get('code'), redirect_uri: CB, client_id: ok.body.client_id, code_verifier: verifier }); return o.exchangeCode(env, f, take, NOW + 1000); };
    const w = await exchange('mcp:write'), r = await exchange('mcp:read'), none = await exchange('NONE'), junk = [await exchange('MCP:WRITE'), await exchange('write'), await exchange(''), await exchange('mcp:read mcp:write'), await exchange(undefined)];
    check(w.status === 200 && w.body.scope === 'mcp:write' && seen[0] === 'mcp:write' && r.body.scope === 'mcp:read' && seen[1] === 'mcp:read' && none.body.scope === 'mcp:read' && seen[2] === 'mcp:read' && junk.every((x) => x.status === 200 && x.body.scope === 'mcp:read') && seen.slice(3).every((x) => x === 'mcp:read'), 'a code carries the scope the owner chose to the key that is issued (and to the token answer); no scope, or anything that is not exactly mcp:write, is read only'); }
};
