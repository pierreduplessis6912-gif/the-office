// Starting a business from the app (worker/src/signup.ts, signin.ts, and the trial parts of directory.ts, limits.ts and auth.ts; SHIP_CHECKLIST.md item 15; decided with Pierre 2026-10-17: open to anyone, a 14-day trial with
// small limits). A new owner signs in with Google, the browser tab shows a page, and the form that comes back creates their business. Anyone can do it, so every way it must say no is tested, a failure part way must be
// retryable without leaving orphans, the page must not be injectable, and a trial must really end.
const path = require('path'), fs = require('fs'), os = require('os'), esbuild = require('esbuild');
const { DatabaseSync } = require('node:sqlite');

const MARK = '@@SIGNUP-RESULT@@';

async function body({ check, srcDir }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'signup-')), entry = path.join(dir, 'entry.ts'), out = path.join(dir, 'signup.js');
  const at = (f) => JSON.stringify(path.join(srcDir, f));
  fs.writeFileSync(entry, `export * from ${at('signup')};\nexport { signedInRedirect } from ${at('signin')};\nexport { signSession, readSessionPayload, signSignupToken, readSignupToken } from ${at('auth')};\nexport { createBusiness, addDirectoryMember, ensureDirectory, lookupAccessForEmail, lookupBusinessForEmail, findEndedTrialForEmail, listDirectory } from ${at('directory')};\nexport { readPlan, clearPlanCache, TRIAL_PLAN } from ${at('limits')};\nexport { convertTrial, extendTrial, sqlTime, fromSqlTime, MAX_EXTEND_DAYS } from ${at('freetrial')};\n`);
  esbuild.buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent' });
  const m = require(out);
  const src = (f) => fs.readFileSync(path.join(srcDir, f), 'utf8');

  // A world: the shared directory (a real SQLite behind the same shim the directory tests use) and a fake business namespace that answers like the real one (membership check, membership create) and can be told to fail.
  const world = (extra = {}) => {
    const db = new DatabaseSync(':memory:'), objects = new Map(), calls = [], state = { failCreate: false };
    const OFFICE_DB = { prepare: (sql) => { const st = (binds) => ({ bind: (...b) => st(b), first: async () => db.prepare(sql).get(...binds) ?? null, all: async () => ({ results: db.prepare(sql).all(...binds) }), run: async () => db.prepare(sql).run(...binds) }); return st([]); } };
    const BUSINESS = { idFromName: (name) => ({ name }), get: (id) => ({ fetch: async (url, init = {}) => {
      const u = new URL(typeof url === 'string' ? url : url.url), bid = id.name.replace(/^business-/, ''), mem = objects.get(bid) ?? objects.set(bid, new Map()).get(bid);
      calls.push({ bid, path: u.pathname, method: init.method });
      if (u.pathname === '/debug/membership-check') { const row = mem.get(u.searchParams.get('email')); return Response.json(row ? { found: true, role: row.role, status: row.status } : { found: false, role: null, status: null }); }
      if (u.pathname === '/debug/create-membership') { if (state.failCreate) return new Response('boom', { status: 500 }); const b = JSON.parse(init.body); mem.set(b.google_email, { role: b.role, status: 'active' }); return Response.json({ ok: true }); }
      return new Response('?', { status: 404 }); } }) };
    return { db, objects, calls, state, env: { OFFICE_DB, SHARED_DB: OFFICE_DB, BUSINESS, ADMIN_KEY: 'k', SESSION_SECRET: 'secret-for-the-tests', BUSINESS_MODE: 'object', PLAN_CACHE_SECONDS: '0', ...extra } };
  };
  const post = (fields, ip = '1.2.3.4', headers = {}) => new Request('https://office.websitehub.co.za/auth/signup', { method: 'POST', body: new URLSearchParams(fields), headers: { 'CF-Connecting-IP': ip, ...headers } });
  const tokenFor = (env, email) => m.signSignupToken(env, email);
  const rows = (w) => { try { return w.db.prepare('SELECT id, name, status, plan, source, trial_ends_at FROM businesses ORDER BY id').all(); } catch { return []; } };   // a refusal that left no table behind has created no business
  const decode = (token) => JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString());
  const tokenOf = (res) => new URL(res.headers.get('Location')).searchParams.get('token');
  const text = async (res) => await res.text();

  // ---- the name, the slug, the id ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const v = m.validateBusinessName;
  check(v('  Acme   Floors ').ok && v('  Acme   Floors ').name === 'Acme Floors' && v("O'Brien & Sons (Pty) Ltd").ok && v('Ab').ok && v('x'.repeat(80)).ok, 'a business name is tidied (spacing) and accepts 2 to 80 characters, with an apostrophe, an ampersand and brackets');
  check([undefined, null, 5, ['x'], {}, '', '   ', 'A', 'x'.repeat(81), 'Acme\u0007', 'Acme <b>', 'a>b'].every((x) => v(x).ok === false), 'a name that is missing, not text, too short or long, has a control character, or has < or > is refused with a message');
  check(m.slugify('Acme Floors & Blinds (Pty) Ltd') === 'acme-floors-blinds-pty-ltd' && m.slugify('Crème Brûlée Café') === 'creme-brulee-cafe' && m.slugify('x'.repeat(60)).length === 28 && m.slugify('日本語') === 'business' && m.slugify('!!') === 'business' && m.slugify('a'.repeat(27) + '-b-c') === 'a'.repeat(27), 'a slug is lower-case letters and digits, at most 28 characters, accents folded, never ends with a hyphen, and a name with no letters becomes "business"');
  const id1 = await m.businessIdFor('Acme Floors', 'Owner@Acme.co.za');
  check(/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(id1) && id1.length <= 35 && id1 === (await m.businessIdFor('Acme Floors', '  owner@acme.co.za ')) && id1 !== (await m.businessIdFor('Acme Floors', 'other@acme.co.za')) && id1 !== (await m.businessIdFor('Acme Blinds', 'owner@acme.co.za')) && id1.startsWith('acme-floors-'), 'the business id is the slug plus six characters of a hash of the owner\'s email: always a valid id, the SAME for the same person (so a retry resumes it), different for anyone else, and never longer than 35');
  check((await m.businessIdFor('x'.repeat(200), 'a@b.co')).length <= 40, 'even a very long name gives an id inside the directory\'s limit of 40');

  // ---- the signed proof, and a session that is not one -------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const w0 = world(), t0 = await tokenFor(w0.env, 'Someone@Example.com');
  check((await m.readSignupToken(w0.env, t0))?.email === 'Someone@Example.com' && decode(t0).purpose === 'signup', 'a signup token carries the address Google verified, and says what it is for');
  check((await m.readSignupToken(w0.env, await m.signSignupToken(w0.env, 'a@b.co', -1))) === null, 'an EXPIRED signup token is refused');
  const [pl, sg] = t0.split('.');
  const forged = Buffer.from(JSON.stringify({ purpose: 'signup', email: 'victim@x.co', exp: Date.now() + 1e6 })).toString('base64url');
  check((await m.readSignupToken(w0.env, `${forged}.${sg}`)) === null && (await m.readSignupToken(w0.env, `${pl}.${sg}x`)) === null && (await m.readSignupToken({ ...w0.env, SESSION_SECRET: 'another-secret' }, t0)) === null, 'a token with its payload changed, its signature changed, or checked under another secret is refused');
  check((await m.readSignupToken(w0.env, null)) === null && (await m.readSignupToken(w0.env, '')) === null && (await m.readSignupToken(w0.env, 'not-base64.not-base64')) === null && (await m.readSignupToken(w0.env, 'x')) === null && (await m.readSignupToken(w0.env, 'a.b.c')) === null, 'a missing or malformed token is refused, never a crash');
  // Defence in depth: even a token carrying the right signature (made by someone holding the secret, for another purpose) must not pass as a signup proof.
  const craft = async (payload) => { const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(w0.env.SESSION_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']); const b64 = Buffer.from(JSON.stringify(payload)).toString('base64url'); return `${b64}.${Buffer.from(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`signup.${b64}`))).toString('base64url')}`; };
  check((await m.readSignupToken(w0.env, await craft({ purpose: 'signup', email: 'a@b.co', exp: Date.now() + 1e6 })))?.email === 'a@b.co' && (await m.readSignupToken(w0.env, await craft({ purpose: 'password-reset', email: 'a@b.co', exp: Date.now() + 1e6 }))) === null && (await m.readSignupToken(w0.env, await craft({ purpose: 'signup', email: 42, exp: Date.now() + 1e6 }))) === null && (await m.readSignupToken(w0.env, await craft({ purpose: 'signup', email: 'a@b.co', exp: 'never' }))) === null && (await m.readSignupToken(w0.env, await craft({ email: 'a@b.co', exp: Date.now() + 1e6 }))) === null, 'a correctly SIGNED token that was made for another purpose, or has no purpose, or an address that is not text, or an expiry that is not a number, is refused (the check works, so the test of it is not just the signature)');
  const session = await m.signSession(w0.env, 'a@b.co', 'acme-co');
  check((await m.readSignupToken(w0.env, session)) === null && (await m.readSessionPayload(w0.env, t0)) === null, 'a SESSION can never pass as a signup token, and a signup token can never pass as a session (they are signed over different strings)');
  const session2 = await m.signSession(w0.env, 'a@b.co', 'acme-co', Date.now() + 5000), soon = decode(session2).exp - Date.now();
  check(soon > 3000 && soon <= 5000 && decode(await m.signSession(w0.env, 'a@b.co', 'acme-co')).exp - Date.now() > 29 * 86400000 && (await m.readSessionPayload(w0.env, await m.signSession(w0.env, 'a@b.co', 'acme-co', Date.now() - 1))) === null, 'a session can be made to END EARLY (a trial\'s ends with the trial), a normal one still lasts 30 days, and one already past its end is refused');

  // ---- the page a browser sees --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const w1 = world(), page = await m.handleUnknownAccount(new Request('https://x/auth/google/callback', { headers: { Accept: 'text/html' } }), w1.env, '  New.Owner@Example.com ');
  const html = await text(page), ptoken = html.match(/name="token" value="([^"]+)"/)?.[1];
  check(page.status === 200 && /text\/html/.test(page.headers.get('Content-Type')) && /new\.owner@example\.com/.test(html) && /name="business_name"/.test(html) && /type="checkbox" name="agree" required/.test(html) && /I work for a business/.test(html) && /method="post" action="\/auth\/signup"/.test(html) && /14-day free trial/.test(html), 'an unknown address gets a PAGE: the address it signed in with, a name box, a tick, "start my 14-day free trial", and "I work for a business"');
  check((await m.readSignupToken(w1.env, ptoken))?.email === 'new.owner@example.com', 'the page carries a signed proof for exactly that address');
  const h = page.headers;
  check(h.get('Cache-Control') === 'no-store' && h.get('X-Frame-Options') === 'DENY' && h.get('Referrer-Policy') === 'no-referrer' && h.get('X-Content-Type-Options') === 'nosniff' && /default-src 'none'/.test(h.get('Content-Security-Policy')) && /frame-ancestors 'none'/.test(h.get('Content-Security-Policy')) && !/form-action/.test(h.get('Content-Security-Policy')) && !/<script/i.test(html), 'the page is never cached or framed, runs no script, and its policy has NO form-action (Chrome would apply it to the redirect to theoffice:// that the form ends in)');
  const hostile = await text(m.startBusinessPage('"><img src=x onerror=alert(1)>@evil.co', 'tok"><script>', { error: '<b>bad</b>', name: '"><svg onload=alert(2)>' }));
  check(!/<img src=x/.test(hostile) && !/<script>/.test(hostile) && !/<svg onload/.test(hostile) && !/<b>bad/.test(hostile) && /&lt;img src=x onerror=alert\(1\)&gt;/.test(hostile) && /&quot;&gt;&lt;svg onload/.test(hostile), 'everything put in the page (the address, the token, the error, the name typed) is HTML-escaped: nothing can inject markup');

  // ---- starting a business: the whole thing -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const w = world(), tok = await tokenFor(w.env, 'Owner@Acme.co.za'), t_before = Date.now();
  const res = await m.handleSignupPost(post({ token: tok, business_name: '  Acme   Floors ', agree: 'on' }), w.env);
  const id = id1, loc = new URL(res.headers.get('Location') ?? 'x:/'), sess = loc.searchParams.get('token');
  check(res.status === 303 && loc.protocol === 'theoffice:' && loc.host === 'auth-callback' && loc.searchParams.get('role') === 'owner' && loc.searchParams.get('email') === 'owner@acme.co.za', 'the form ends with a 303 to the app\'s own address (theoffice://auth-callback) carrying the session, the address and the role "owner"');
  const biz = rows(w);
  check(biz.length === 1 && biz[0].id === id && biz[0].name === 'Acme Floors' && biz[0].status === 'active' && biz[0].plan === 'trial' && biz[0].source === 'signup', 'exactly ONE business was created: named as typed (tidied), active, on the trial plan, marked as started by its owner');
  const ends = Date.parse(biz[0].trial_ends_at.replace(' ', 'T') + 'Z');
  check(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(biz[0].trial_ends_at) && Math.abs(ends - (t_before + 14 * 86400000)) < 60000, 'its trial ends in 14 days (in the directory\'s own time format)');
  const pay = await m.readSessionPayload(w.env, sess);
  check(pay?.email === 'owner@acme.co.za' && pay?.b === id && Math.abs(decode(sess).exp - ends) < 1500 && /office_session=/.test(res.headers.get('Set-Cookie')) && /HttpOnly; Secure; SameSite=Lax/.test(res.headers.get('Set-Cookie')), 'the session is for that business and that address, ENDS WITH THE TRIAL, and is also set as a secure cookie');
  check(w.objects.get(id)?.get('owner@acme.co.za')?.role === 'owner' && w.objects.get(id).get('owner@acme.co.za').status === 'active' && (await m.lookupBusinessForEmail(w.env, 'owner@acme.co.za')) === id, 'the owner\'s membership exists INSIDE the business\'s own object (as an active owner) and the directory sends their address there');
  m.clearPlanCache();
  const plan = await m.readPlan({ ...w.env, BUSINESS_ID: id }), plan2 = await m.readPlan({ ...w.env, BUSINESS_ID: 'no-such-business-1' });
  check(plan.name === 'trial' && plan.messagesPerMemberPerDay === 30 && plan.neuronsPerBusinessPerDay === 60000 && plan.mode === 'enforce' && m.TRIAL_PLAN.neuronsPerBusinessPerDay === 60000, 'the new business really runs on the small trial limits (30 messages a person a day, 60,000 neurons a business a day), ENFORCED, and not on the standard plan');
  check(plan2.name === 'standard' && plan2.mode === 'warn', 'while a business with no plan row keeps the standard default');

  // double tap / page left open: the second form is a sign-in, not a second business
  const again = await m.handleSignupPost(post({ token: await tokenFor(w.env, 'owner@acme.co.za'), business_name: 'Something Else Entirely', agree: 'on' }), w.env);
  check(again.status === 303 && rows(w).length === 1 && (await m.readSessionPayload(w.env, tokenOf(again)))?.b === id && new URL(again.headers.get('Location')).searchParams.get('role') === 'owner', 'a second tap (or an old page) SIGNS THE OWNER IN to their existing business: no second business, whatever name is typed');

  // ---- every way it must say no --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const refused = async (fields, extra = {}, ip) => { const x = world(extra); const r = await m.handleSignupPost(post(fields(x.env, await tokenFor(x.env, 'nobody@example.com')), ip), x.env); return { x, r, body: await text(r) }; };
  const ok = (e, t) => ({ token: t, business_name: 'Acme', agree: 'on' });
  for (const [label, f] of [['no token', () => ({ business_name: 'Acme', agree: 'on' })], ['a garbage token', () => ({ token: 'garbage', business_name: 'Acme', agree: 'on' })], ['an empty token', () => ({ token: '', business_name: 'Acme', agree: 'on' })]]) {
    const o = await refused(f); check(o.r.status === 400 && /That took too long/.test(o.body) && rows(o.x).length === 0 && !o.r.headers.get('Location'), `refused: ${label} (a page, nothing created)`);
  }
  { const x = world(); const r = await m.handleSignupPost(post({ token: await m.signSignupToken(x.env, 'a@b.co', -1), business_name: 'Acme', agree: 'on' }), x.env); check(r.status === 400 && rows(x).length === 0, 'refused: an EXPIRED token (the page sat open too long)'); }
  { const x = world(); const r = await m.handleSignupPost(post({ token: await m.signSession(x.env, 'a@b.co', 'acme-co'), business_name: 'Acme', agree: 'on' }), x.env); check(r.status === 400 && rows(x).length === 0, 'refused: a SESSION token offered as the proof'); }
  {
    // A signature is 32 bytes = 43 base64url characters, and the LAST character carries only 4 meaningful bits: changing it can alter nothing but padding bits and leave the token VALID. (An earlier version of this test altered the last
    // character and failed about one run in sixteen, in CI too.) The FIRST character carries all six bits, so every other character must break the signature: tried exhaustively, not by luck.
    const x = world(), t = await tokenFor(x.env, 'a@b.co'), [pl, sg] = t.split('.'), alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    let accepted = 0, tried = 0; for (const c of alphabet) { if (c === sg[0]) continue; tried++; if ((await m.readSignupToken(x.env, `${pl}.${c}${sg.slice(1)}`)) !== null) accepted++; }
    const r = await m.handleSignupPost(post({ token: `${pl}.${sg[0] === 'A' ? 'B' : 'A'}${sg.slice(1)}`, business_name: 'Acme', agree: 'on' }), x.env);
    check(tried === 63 && accepted === 0 && r.status === 400 && rows(x).length === 0, 'refused: a token with its signature altered (every one of the 63 other first characters breaks it, tried exhaustively; the form refuses it and creates nothing)');
  }
  for (const [label, name] of [['an empty name', ''], ['one letter', 'A'], ['a name with a tag', 'Acme <script>alert(1)</script>'], ['81 characters', 'x'.repeat(81)]]) {
    const o = await refused((e, t) => ({ token: t, business_name: name, agree: 'on' })); check(o.r.status === 400 && /class="error"/.test(o.body) && !/<script>alert/.test(o.body) && rows(o.x).length === 0, `refused with a message on the same page: ${label}`);
  }
  { const o = await refused((e, t) => ({ token: t, business_name: 'My Typed Name' })); check(o.r.status === 400 && /tick the box/i.test(o.body) && /value="My Typed Name"/.test(o.body) && rows(o.x).length === 0, 'refused: the box is not ticked; the page comes back with the name already typed, and nothing is created'); }
  { const x = world({ BUSINESS: undefined }); const r = await m.handleSignupPost(post({ token: await tokenFor(x.env, 'a@b.co'), business_name: 'Acme', agree: 'on' }), x.env); check(r.status === 404, 'where business objects are not enabled (the old single-database mode) starting a business is simply not available'); }
  { const x = world(); const r = await m.handleSignupPost(new Request('https://x/auth/signup', { method: 'POST', body: 'x', headers: { 'Content-Type': 'application/json' } }), x.env); check(r.status === 400 && rows(x).length === 0, 'a body that is not a form is a page, not a crash'); }

  // ---- a person who already belongs somewhere ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  {
    const x = world(); await m.ensureDirectory(x.env); await m.createBusiness(x.env, 'live-co', 'Live Co'); await m.addDirectoryMember(x.env, 'staff@live.co', 'live-co'); x.objects.set('live-co', new Map([['staff@live.co', { role: 'installer', status: 'active' }]]));
    const r = await m.handleSignupPost(post({ token: await tokenFor(x.env, 'staff@live.co'), business_name: 'My Own Thing', agree: 'on' }), x.env);
    check(r.status === 303 && (await m.readSessionPayload(x.env, tokenOf(r)))?.b === 'live-co' && new URL(r.headers.get('Location')).searchParams.get('role') === 'installer' && rows(x).length === 1, 'an employee who already belongs to a business and finds the signup form just signs in to THEIR business with THEIR role: it can never create a second business for an address');
    const gone = world(); await m.ensureDirectory(gone.env); await m.createBusiness(gone.env, 'live-co', 'Live Co'); await m.addDirectoryMember(gone.env, 'staff@live.co', 'live-co');
    const r2 = await m.handleSignupPost(post({ token: await tokenFor(gone.env, 'staff@live.co'), business_name: 'My Own Thing', agree: 'on' }), gone.env);
    check(r2.status === 403 && /not active/.test(await text(r2)) && rows(gone).length === 1, 'a member whose membership is not active in their business is told so, and still cannot start another');
    const q = await m.handleUnknownAccount(new Request('https://x/', { headers: { Accept: 'text/html' } }), gone.env, 'staff@live.co');
    check(q.status === 403 && /not active/.test(await text(q)), 'the callback shows the same "not active" page to that person instead of inviting them to start a business');
  }

  // ---- the caps ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  {
    const x = world({ SIGNUP_DAILY_CAP: '2' }); const go = async (email, name, ip) => m.handleSignupPost(post({ token: await tokenFor(x.env, email), business_name: name, agree: 'on' }, ip), x.env);
    const a = await go('a@one.co', 'One', '1.1.1.1'), b = await go('b@two.co', 'Two', '2.2.2.2'), c = await go('c@three.co', 'Three', '3.3.3.3');
    check(a.status === 303 && b.status === 303 && c.status === 429 && /We are full for today/.test(await text(c)) && rows(x).length === 2 && !c.headers.get('Location'), 'the daily cap: with a cap of 2, the third new business of the day gets a "try again tomorrow" page (429) and nothing is created');
    const again = await go('a@one.co', 'One', '1.1.1.1');
    check(again.status === 303 && rows(x).length === 2, 'but someone who ALREADY has a business can still sign in when the cap is reached');
    const none = world({ SIGNUP_DAILY_CAP: '0' }); check((await m.handleSignupPost(post({ token: await tokenFor(none.env, 'a@one.co'), business_name: 'One', agree: 'on' }), none.env)).status === 429 && rows(none).length === 0, 'a cap of 0 closes signup altogether');
  }
  {
    const x = world({ SIGNUP_IP_DAILY_CAP: '1' }); const go = async (email, ip) => m.handleSignupPost(post({ token: await tokenFor(x.env, email), business_name: 'Biz ' + email[0], agree: 'on' }, ip), x.env);
    const a = await go('a@one.co', '9.9.9.9'), b = await go('b@two.co', '9.9.9.9'), c = await go('c@three.co', '8.8.8.8');
    check(a.status === 303 && b.status === 429 && c.status === 303 && rows(x).length === 2, 'the per-address cap: with a cap of 1, a second business from the SAME network address is refused, one from another address is not');
    const stored = x.db.prepare('SELECT ip FROM signup_ips').all().map((r) => r.ip);
    check(stored.length === 2 && stored.every((s) => /^[0-9a-f]{16}$/.test(s)) && !stored.some((s) => s.includes('.')), 'the network address is stored only as a short hash, never as the address');
  }
  { const x = world(); const r = await Promise.all([1, 2, 3].map(async (i) => m.handleSignupPost(post({ token: await tokenFor(x.env, `p${i}@x.co`), business_name: 'Shared Name', agree: 'on' }, `10.0.0.${i}`), x.env))); const ids = rows(x).map((b) => b.id); check(r.every((x) => x.status === 303) && new Set(ids).size === 3, 'three different people starting a business with the SAME name get three different businesses'); }

  // ---- a failure part way, and the retry ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  {
    const x = world({ SIGNUP_DAILY_CAP: '1' }); x.state.failCreate = true; const t = await tokenFor(x.env, 'retry@acme.co');
    const bad = await m.handleSignupPost(post({ token: t, business_name: 'Retry Co', agree: 'on' }), x.env);
    const row = rows(x)[0], leaked = JSON.stringify([await text(bad.clone())]);
    check(bad.status === 500 && /Something went wrong/.test(await text(bad)) && !/boom|500|membership could not/.test(leaked) && row.status === 'pending' && (await m.lookupBusinessForEmail(x.env, 'retry@acme.co')) === null && x.db.prepare('SELECT COUNT(*) n FROM directory_members').get().n === 0, 'when the object cannot be set up the person sees a plain page (no internals), the business stays PENDING, and nobody can sign in to it (no directory entry yet)');
    x.state.failCreate = false;
    x.db.prepare("UPDATE businesses SET trial_ends_at = datetime('now', '+10 days') WHERE id = ?").run(row.id);   // the first attempt was four days ago: a retry must not start a fresh 14 days
    row.trial_ends_at = rows(x)[0].trial_ends_at;
    const good = await m.handleSignupPost(post({ token: t, business_name: 'Retry Co', agree: 'on' }), x.env);
    check(good.status === 303 && rows(x).length === 1 && rows(x)[0].status === 'active' && rows(x)[0].id === row.id && rows(x)[0].trial_ends_at === row.trial_ends_at && x.objects.get(row.id).get('retry@acme.co').role === 'owner', 'the RETRY finishes the same business (no orphan, the same trial end, even with the daily cap of 1 already used by the first attempt) and the person is signed in');
    const trial = Date.parse(rows(x)[0].trial_ends_at.replace(' ', 'T') + 'Z');
    check(Math.abs(decode(tokenOf(good)).exp - trial) < 1500 && Math.abs(trial - (Date.now() + 10 * 86400000)) < 60000, 'and the session still ends exactly when the ORIGINAL trial ends (10 days from now, not a fresh 14): retrying never extends it');
  }
  {
    const x = world(); await m.ensureDirectory(x.env); await m.createBusiness(x.env, await m.businessIdFor('Squat Co', 'x@y.co'), 'Someone Elses', 'standard', { source: 'admin' });
    const r = await m.handleSignupPost(post({ token: await tokenFor(x.env, 'x@y.co'), business_name: 'Squat Co', agree: 'on' }), x.env);
    check(r.status === 500 && rows(x).length === 1 && rows(x)[0].name === 'Someone Elses' && !x.objects.size, 'an id that this person did not start (not a pending signup) is never touched or completed');
  }

  // ---- the trial ends ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  {
    const x = world(); const r = await m.handleSignupPost(post({ token: await tokenFor(x.env, 'trial@x.co'), business_name: 'Trial Co', agree: 'on' }), x.env); const bid = rows(x)[0].id;
    const live = await m.lookupAccessForEmail(x.env, 'trial@x.co');
    check(live?.businessId === bid && typeof live.trialEndsAt === 'string' && (await m.findEndedTrialForEmail(x.env, 'trial@x.co')) === null, 'during the trial the address signs in, and the access says when the trial ends');
    x.db.prepare("UPDATE businesses SET trial_ends_at = datetime('now', '-1 minute') WHERE id = ?").run(bid);
    check((await m.lookupAccessForEmail(x.env, 'trial@x.co')) === null && (await m.lookupBusinessForEmail(x.env, 'trial@x.co')) === null && (await m.findEndedTrialForEmail(x.env, 'trial@x.co'))?.name === 'Trial Co', 'when the trial ENDS the address no longer finds a business, and the directory can say that it was an ended trial');
    const page = await m.handleUnknownAccount(new Request('https://x/', { headers: { Accept: 'text/html' } }), x.env, 'trial@x.co'), body = await text(page);
    check(page.status === 403 && /Your free trial has ended/.test(body) && /Trial Co/.test(body) && /has not been deleted/.test(body) && /please contact us/.test(body) && !/name="business_name"/.test(body), 'the sign-in then shows "your free trial has ended" (with the business named, a note that nothing is deleted, "please contact us") and does NOT offer to start another business');
    const withContact = await text(await m.handleUnknownAccount(new Request('https://x/', { headers: { Accept: 'text/html' } }), { ...x.env, SUPPORT_CONTACT: 'call Pierre on 082 000 0000' }, 'trial@x.co'));
    check(/To keep using The Office, call Pierre on 082 000 0000\./.test(withContact), 'a contact line, when one is set, finishes the sentence');
    const retry = await m.handleSignupPost(post({ token: await tokenFor(x.env, 'trial@x.co'), business_name: 'Brand New Start', agree: 'on' }), x.env);
    check(retry.status === 403 && rows(x).length === 1, 'and signing up AGAIN with the same address after the trial is refused: it cannot be used to get fresh trials');
    check(x.db.prepare('SELECT COUNT(*) n FROM directory_members').get().n === 1 && (await m.listDirectory(x.env)).businesses[0].trial_ends_at !== undefined, 'the operator\'s directory listing shows the trial end');
  }

  // ---- a directory that predates trials -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  {
    const x = world(); x.db.exec("CREATE TABLE businesses (id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', plan TEXT NOT NULL DEFAULT 'standard', created_at TEXT NOT NULL DEFAULT (datetime('now')));CREATE TABLE directory_members (email TEXT PRIMARY KEY, business_id TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));INSERT INTO businesses (id, name) VALUES ('old-co', 'Old Co');INSERT INTO directory_members (email, business_id) VALUES ('boss@old.co', 'old-co');");
    const cols = () => x.db.prepare('PRAGMA table_info(businesses)').all().map((c) => c.name);
    check(!cols().includes('trial_ends_at') && (await m.lookupAccessForEmail(x.env, 'boss@old.co'))?.businessId === 'old-co' && (await m.lookupAccessForEmail(x.env, 'boss@old.co')).trialEndsAt === null && (await m.listDirectory(x.env)).businesses[0].members === 1 && (await m.findEndedTrialForEmail(x.env, 'boss@old.co')) === null && !cols().includes('trial_ends_at'), 'a directory from BEFORE trials (the one in production today) still works for every READ: sign-in, listing, ended-trial check; and a read never adds a column');
    await m.ensureDirectory(x.env); await m.ensureDirectory(x.env);
    check(cols().includes('trial_ends_at') && cols().includes('source') && cols().filter((c) => c === 'source').length === 1 && x.db.prepare("SELECT source FROM businesses WHERE id = 'old-co'").get().source === 'admin' && (await m.lookupAccessForEmail(x.env, 'boss@old.co'))?.businessId === 'old-co', 'the first WRITE adds the two columns (once: repeating is harmless), the existing business is marked as created by an operator, and it still signs in');
    await m.createBusiness(x.env, 'op-made', 'Op Made');
    const op = x.db.prepare("SELECT status, source, trial_ends_at, plan FROM businesses WHERE id = 'op-made'").get();
    check(op.status === 'active' && op.source === 'admin' && op.trial_ends_at === null && op.plan === 'standard', 'a business an OPERATOR creates is unchanged: active, standard, no trial, source "admin"');
  }

  // ---- how a sign-in ends ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  {
    const e = world().env, who = { sessionEmail: 'a@b.co', displayEmail: 'A@B.co', role: 'owner', businessId: 'acme-co' };
    const native = await m.signedInRedirect(new Request('https://x/'), e, who), web = await m.signedInRedirect(new Request('https://x/', { headers: { Cookie: 'oauth_platform=web; oauth_redirect_origin=https://app.example.com' } }), e, who, 303);
    check(native.status === 302 && native.headers.get('Location').startsWith('theoffice://auth-callback?token=') && new URL(native.headers.get('Location')).searchParams.get('email') === 'A@B.co' && web.status === 303 && web.headers.get('Location').startsWith('https://app.example.com/auth-callback.html?token='), 'a sign-in ends with a redirect to the app\'s own address: theoffice:// on a phone, the remembered web origin on the web; the status can be chosen (302 from the callback, 303 after the form)');
  }

  // ---- the REAL sign-in, end to end, with Google faked ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  // The callback is the live sign-in path for every existing business, and it was changed (the trial-aware lookup, the shared redirect, the page for a browser). Everything above drives pieces; this drives the Worker's actual
  // entry point (routing, the gate and the callback itself) with only Google's two answers faked, so a regression in how a MEMBER signs in cannot hide behind tests of the new parts.
  const workerOut = path.join(dir, 'worker.js');
  await esbuild.build({ entryPoints: [path.join(srcDir, 'index.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: workerOut, logLevel: 'silent' });
  const worker = require(workerOut).default, ctx = { waitUntil() {}, passThroughOnException() {} };
  const realFetch = globalThis.fetch;
  const google = (email, over = {}) => { globalThis.fetch = async (url, init) => { const u = new URL(String(url)); if (u.origin === 'https://oauth2.googleapis.com' && u.pathname === '/token') return Response.json({ id_token: 'idt' }); if (u.origin === 'https://oauth2.googleapis.com' && u.pathname === '/tokeninfo') return Response.json({ aud: 'client-id', email, email_verified: 'true', ...over }); return realFetch(url, init); }; };
  const signIn = (w, headers = {}, query = 'code=c&state=S') => worker.fetch(new Request(`https://office.websitehub.co.za/auth/google/callback?${query}`, { headers: { Cookie: 'oauth_state=S', ...headers } }), { ...w.env, GOOGLE_CLIENT_ID: 'client-id', GOOGLE_CLIENT_SECRET: 'secret' }, ctx);
  const HTML = { Accept: 'text/html,application/xhtml+xml' };
  try {
    // a member of a business an operator created: signs in exactly as before
    const a = world(); await m.ensureDirectory(a.env); await m.createBusiness(a.env, 'live-co', 'Live Co'); await m.addDirectoryMember(a.env, 'Boss@Live.co', 'live-co'); a.objects.set('live-co', new Map([['boss@live.co', { role: 'owner', status: 'active' }]]));
    google('Boss@Live.co'); const r1 = await signIn(a, HTML), l1 = new URL(r1.headers.get('Location') ?? 'x:/'), s1 = l1.searchParams.get('token'), p1 = s1 ? decode(s1) : {};
    check(r1.status === 302 && l1.protocol === 'theoffice:' && l1.searchParams.get('role') === 'owner' && l1.searchParams.get('email') === 'Boss@Live.co' && (await m.readSessionPayload(a.env, s1))?.b === 'live-co' && p1.email === 'boss@live.co' && Math.abs(p1.exp - (Date.now() + 30 * 86400000)) < 60000 && /office_session=/.test(r1.headers.get('Set-Cookie')), 'THE LIVE PATH: a member of an operator-created business signs in as before: a 302 to the app with their session for that business, their role and address, a normal 30-day session, and the cookie');
    check(a.calls.filter((c) => c.path === '/debug/membership-check').length === 1 && a.db.prepare('SELECT COUNT(*) n FROM businesses').get().n === 1, 'and the sign-in asked the business\'s own object once, and created nothing');
    // an unknown address: a page for a browser, the old JSON for anything else
    google('Fresh@Person.co'); const r2 = await signIn(a, HTML), b2 = await text(r2), t2 = b2.match(/name="token" value="([^"]+)"/)?.[1];
    check(r2.status === 200 && /Start my business/.test(b2) && /fresh@person\.co/.test(b2) && (await m.readSignupToken(a.env, t2))?.email === 'fresh@person.co', 'an UNKNOWN address, from a browser, gets the page with a proof for exactly that address');
    for (const [label, hdrs] of [['no Accept header', {}], ['Accept: application/json', { Accept: 'application/json' }], ['Accept: */*', { Accept: '*/*' }]]) {
      google('Fresh@Person.co'); const r = await signIn(a, hdrs), j = await r.json();
      check(r.status === 403 && j.error === 'no active membership for this Google account' && j.email === 'Fresh@Person.co' && !r.headers.get('Location'), `the same address from anything that is not asking for a web page (${label}) gets the JSON refusal, exactly as before`);
    }
    // the new owner's whole journey: page -> form (the gate lets it through with no session) -> a session that works
    const post2 = await worker.fetch(post({ token: t2, business_name: 'Fresh Floors', agree: 'on' }), { ...a.env, GOOGLE_CLIENT_ID: 'client-id', GOOGLE_CLIENT_SECRET: 'secret' }, ctx);
    const l2 = new URL(post2.headers.get('Location') ?? 'x:/'), s2 = l2.searchParams.get('token'), fresh = rows(a).find((b) => b.name === 'Fresh Floors') ?? {};
    check(post2.status === 303 && l2.protocol === 'theoffice:' && l2.searchParams.get('role') === 'owner' && fresh?.plan === 'trial' && fresh.status === 'active' && (await m.readSessionPayload(a.env, s2))?.b === fresh.id, 'THE NEW OWNER\'S JOURNEY through the real entry point: the page\'s form is accepted with NO session (the gate lets the public route through) and ends in the app\'s address with a session for their new trial business');
    google('Fresh@Person.co'); const r3 = await signIn(a, HTML), l3 = new URL(r3.headers.get('Location') ?? 'x:/'), exp3 = decode(l3.searchParams.get('token') ?? 'e30.x').exp, endT = Date.parse(fresh.trial_ends_at.replace(' ', 'T') + 'Z');
    check(r3.status === 302 && l3.searchParams.get('role') === 'owner' && Math.abs(exp3 - endT) < 1500 && exp3 < Date.now() + 14.1 * 86400000, 'and when they sign in AGAIN the next day they are a normal member: straight in, with a session that ENDS WITH THE TRIAL (not 30 days)');
    // the trial ends
    a.db.prepare("UPDATE businesses SET trial_ends_at = datetime('now', '-1 hour') WHERE id = ?").run(fresh.id);
    google('Fresh@Person.co'); const r4 = await signIn(a, HTML), b4 = await text(r4); google('Fresh@Person.co'); const r4j = await signIn(a, {}), j4 = await r4j.json();
    check(r4.status === 403 && /Your free trial has ended/.test(b4) && /Fresh Floors/.test(b4) && !/name="business_name"/.test(b4) && r4j.status === 403 && j4.error === 'no active membership for this Google account', 'after the trial: a browser is told "your free trial has ended" (and is not offered a new business), anything else gets the plain refusal');
    // A session minted for a trial carries the trial's end. Once that moment has passed it is dead at the front door (the Worker answers 401 itself and the business's object is never woken); one a moment before it works.
    const reached = () => a.calls.length, before = reached();
    const dead = await worker.fetch(new Request('https://office.websitehub.co.za/customers', { headers: { Cookie: `office_session=${await m.signSession(a.env, 'fresh@person.co', fresh.id, Date.now() - 1)}` } }), a.env, ctx);
    check(dead.status === 401 && reached() === before, 'and a session whose TRIAL END has passed is refused at the front door (401) without ever reaching the business\'s object');
    const alive = await worker.fetch(new Request('https://office.websitehub.co.za/customers', { headers: { Cookie: `office_session=${await m.signSession(a.env, 'fresh@person.co', fresh.id, Date.now() + 60000)}` } }), a.env, ctx);
    check(alive.status !== 401 && reached() > before, 'while one a minute BEFORE the trial\'s end is routed on to the business as normal');
    // the existing refusals are untouched
    google('Boss@Live.co', { aud: 'someone-elses-client' }); check((await signIn(a, HTML)).status === 401, 'a token for a DIFFERENT Google client is still refused (401)');
    google('Boss@Live.co', { email_verified: 'false' }); check((await signIn(a, HTML)).status === 401, 'an unverified email is still refused (401): the page can only ever be shown for an address Google verified');
    google('Boss@Live.co'); check((await signIn(a, HTML, 'code=c&state=WRONG')).status === 400 && (await signIn(a, HTML, 'state=S')).status === 400, 'a wrong or missing OAuth state or code is still refused (400)');
    // the old single-database mode never shows the page
    const legacy = world({ BUSINESS_MODE: undefined, BUSINESS: undefined }); legacy.db.exec('CREATE TABLE memberships (id INTEGER PRIMARY KEY, google_email TEXT, role TEXT, status TEXT)');
    google('Fresh@Person.co'); const r5 = await signIn(legacy, HTML);
    check(r5.status === 403 && (await r5.json()).error === 'no active membership for this Google account', 'where business objects are not enabled (the old single-database mode) there is no page: the JSON refusal stays');
  } finally { globalThis.fetch = realFetch; }

  // ---- bringing a trial back (freetrial.ts, the "Production trial" workflow) ---------------------------------------------------------------------------------------------------------------------------------------------------
  // Found missing right after signup shipped: once a trial's end passed the address found no business, and changing the plan did not help because the end date stayed set. An operator must be able to CONVERT a trial business to a plan
  // it pays for, or EXTEND the trial, and an ENDED trial must come back to life. Only an active business that has a trial may be touched.
  const started = async (email, name) => { const x = world(); const r = await m.handleSignupPost(post({ token: await tokenFor(x.env, email), business_name: name, agree: 'on' }), x.env); return { x, r, id: rows(x)[0].id }; };
  const endIt = (x, id, when = '-2 days') => x.db.prepare("UPDATE businesses SET trial_ends_at = datetime('now', ?) WHERE id = ?").run(when, id);
  const trialRow = (x, id) => x.db.prepare('SELECT status, plan, trial_ends_at FROM businesses WHERE id = ?').get(id);
  {
    const { x, id } = await started('owner@back.co', 'Back Co'); endIt(x, id);
    check((await m.lookupAccessForEmail(x.env, 'owner@back.co')) === null, 'precondition: the trial has ended and the owner finds no business');
    const e1 = await m.extendTrial(x.env, id, 7);
    check(e1.ok === true && Math.abs(m.fromSqlTime(e1.trialEndsAt) - (Date.now() + 7 * 86400000)) < 60000 && (await m.lookupAccessForEmail(x.env, 'owner@back.co'))?.businessId === id && (await m.findEndedTrialForEmail(x.env, 'owner@back.co')) === null, 'EXTENDING an ended trial by 7 days brings the business back for exactly 7 days from NOW (an ended trial counts from today, not from when it ended): the owner finds it again and it is no longer an ended trial');
    check(trialRow(x, id).plan === 'trial' && trialRow(x, id).status === 'active', 'and it stays on the trial plan');
    x.db.prepare("UPDATE businesses SET trial_ends_at = datetime('now', '+3 days') WHERE id = ?").run(id);
    const e2 = await m.extendTrial(x.env, id, 5);
    check(e2.ok && Math.abs(m.fromSqlTime(e2.trialEndsAt) - (Date.now() + 8 * 86400000)) < 60000 && e2.wasEndingAt !== e2.trialEndsAt, 'extending a trial that is STILL RUNNING adds to its current end (3 days left + 5 = 8), so extending never shortens it');
    const back = await started('owner@conv.co', 'Conv Co'); endIt(back.x, back.id);
    const c1 = await m.convertTrial(back.x.env, back.id, 'standard');
    const a = await m.lookupAccessForEmail(back.x.env, 'owner@conv.co');
    m.clearPlanCache(); const pl = await m.readPlan({ ...back.x.env, BUSINESS_ID: back.id });
    check(c1.ok === true && c1.plan === 'standard' && trialRow(back.x, back.id).trial_ends_at === null && trialRow(back.x, back.id).plan === 'standard' && a?.businessId === back.id && a.trialEndsAt === null && (await m.findEndedTrialForEmail(back.x.env, 'owner@conv.co')) === null && pl.name === 'standard', 'CONVERTING an ended trial to the standard plan clears the trial: the owner finds the business again as a normal member (no trial end, so their next session is a normal 30 days), it runs on the standard plan, and it is not an ended trial');
    check((await m.convertTrial(back.x.env, back.id, 'standard')).status === 409 && (await m.extendTrial(back.x.env, back.id, 7)).status === 409, 'a business that has been converted is no longer on a trial: converting or extending it again is refused (409)');
    const run = await started('owner@run.co', 'Run Co'), before = trialRow(run.x, run.id).trial_ends_at, cv = await m.convertTrial(run.x.env, run.id, 'standard');
    check(cv.ok && cv.wasEndingAt === before && (await m.lookupAccessForEmail(run.x.env, 'owner@run.co'))?.trialEndsAt === null, 'converting a trial that is still RUNNING also works, and says when it would have ended');
  }
  {
    const { x, id } = await started('owner@ref.co', 'Ref Co'); const snap = () => JSON.stringify(trialRow(x, id));
    for (const d of [0, -1, 91, 1.5, '7', NaN, null, undefined, Infinity, [7], {}]) check((await m.extendTrial(x.env, id, d)).status === 400, `extend refuses days = ${JSON.stringify(d) ?? String(d)}`);
    check((await m.extendTrial(x.env, id, 1)).ok === true && (await m.extendTrial(x.env, id, 90)).ok === true && m.MAX_EXTEND_DAYS === 90, 'extend accepts 1 and 90 days (and nothing beyond)');
    const s0 = snap();
    for (const [label, call, status] of [['an unknown business', () => m.extendTrial(x.env, 'no-such-biz-1', 7), 404], ['an invalid id', () => m.extendTrial(x.env, 'Bad Id', 7), 400], ['a missing id', () => m.extendTrial(x.env, undefined, 7), 400], ['an id that is not text', () => m.convertTrial(x.env, 42, 'standard'), 400], ['convert with no plan', () => m.convertTrial(x.env, id, undefined), 400], ['convert with an empty plan', () => m.convertTrial(x.env, id, ''), 400], ['convert TO the trial plan', () => m.convertTrial(x.env, id, 'trial'), 400], ['convert to a plan that does not exist', () => m.convertTrial(x.env, id, 'platinum'), 404], ['convert to a plan that is not text', () => m.convertTrial(x.env, id, { name: 'standard' }), 400]]) { const r = await call(); check(r.ok === false && r.status === status, `refused (${status}): ${label}`); }
    check(snap() === s0, 'and none of those refusals changed the business');
    const adm = world(); await m.ensureDirectory(adm.env); await m.createBusiness(adm.env, 'op-made', 'Op Made'); const pend = world(); await m.ensureDirectory(pend.env); await m.createBusiness(pend.env, 'half-made', 'Half Made', 'trial', { status: 'pending', trialEndsAt: '2099-01-01 00:00:00', source: 'signup' });
    const susp = world(); await m.ensureDirectory(susp.env); await m.createBusiness(susp.env, 'gone-co', 'Gone Co', 'trial', { status: 'suspended', trialEndsAt: '2099-01-01 00:00:00' });
    check((await m.extendTrial(adm.env, 'op-made', 7)).status === 409 && (await m.convertTrial(adm.env, 'op-made', 'standard')).status === 409, 'a business an OPERATOR created (it has no trial) cannot be "converted" or "extended": there is nothing to convert');
    const pe = await m.extendTrial(pend.env, 'half-made', 7), se = await m.convertTrial(susp.env, 'gone-co', 'standard');
    check(pe.status === 409 && /pending/.test(pe.error) && se.status === 409 && /suspended/.test(se.error), 'a half-made (pending) or suspended business cannot be moved off a trial');
    const old = world(); old.db.exec("CREATE TABLE businesses (id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', plan TEXT NOT NULL DEFAULT 'standard', created_at TEXT NOT NULL DEFAULT (datetime('now')));INSERT INTO businesses (id, name) VALUES ('old-co', 'Old Co');");
    const oe = await m.extendTrial(old.env, 'old-co', 7);
    check(oe.ok === false && oe.status === 409 && /no trial information/.test(oe.error), 'on a directory from BEFORE trials it says so plainly (409), never a crash');
  }
  {
    const x = world({ ADMIN_KEY: 'k-admin', ADMIN_CONFIRM_KEY: 'k-confirm' }); const r0 = await m.handleSignupPost(post({ token: await tokenFor(x.env, 'owner@route.co'), business_name: 'Route Co', agree: 'on' }), x.env); const id = rows(x)[0].id; endIt(x, id);
    const call = (body, headers) => worker.fetch(new Request('https://office.websitehub.co.za/debug/directory/trial', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) }), x.env, ctx);
    const both = { 'X-Admin-Key': 'k-admin', 'X-Admin-Confirm': 'k-confirm' };
    const nobody = await call({ business: id, action: 'extend', days: 7 }, {}), onlyKey = await call({ business: id, action: 'extend', days: 7 }, { 'X-Admin-Key': 'k-admin' }), wrong = await call({ business: id, action: 'extend', days: 7 }, { 'X-Admin-Key': 'nope', 'X-Admin-Confirm': 'k-confirm' });
    check(nobody.status !== 200 && onlyKey.status !== 200 && wrong.status !== 200 && (await m.lookupAccessForEmail(x.env, 'owner@route.co')) === null, 'the route is PRIVILEGED: with no key, only the admin key, or a wrong key it does nothing (an ended trial stays ended)');
    const bad = await call({ business: id, action: 'delete' }, both), badj = await worker.fetch(new Request('https://office.websitehub.co.za/debug/directory/trial', { method: 'POST', headers: both, body: 'not json' }), x.env, ctx);
    check(bad.status === 400 && /convert" or "extend/.test((await bad.json()).error) && badj.status === 400, 'an unknown action, or a body that is not JSON, is a plain 400');
    const ok = await call({ business: id, action: 'extend', days: 7 }, both), okj = await ok.json();
    check(ok.status === 200 && okj.ok === true && okj.business === id && (await m.lookupAccessForEmail(x.env, 'owner@route.co'))?.businessId === id, 'with BOTH keys the route extends the trial and the owner is restored');
    const cv = await call({ business: id, action: 'convert', plan: 'standard' }, both), cvj = await cv.json();
    check(cv.status === 200 && cvj.plan === 'standard' && trialRow(x, id).trial_ends_at === null, 'and converts it');
    check((await call({ business: id, action: 'convert', plan: 'standard' }, both)).status === 409 && (await call({ business: 'no-such-biz-1', action: 'extend', days: 3 }, both)).status === 404, 'and the failures come back as their own statuses (409 not on a trial, 404 no such business)');
  }
  check(/"POST \/debug\/directory\/trial": "privileged"/.test(src('admin-routes.ts')) && /url\.pathname === "\/debug\/directory\/trial" && request\.method === "POST"/.test(src('debug.ts')) && /import \{ convertTrial, extendTrial \} from "\.\/freetrial"/.test(src('debug.ts')) && /from "\.\/freetrial"/.test(src('signup.ts')) && !/export (async )?function (convertTrial|extendTrial)/.test(src('trial.ts')), 'the route is classified privileged, answered in debug.ts, and lives in freetrial.ts (trial.ts, the older architecture-trial module, is untouched)');

  // ---- how it is wired in ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const index = src('index.ts');
  check(/url\.pathname === "\/auth\/signup" && request\.method === "POST"[\s\S]{0,400}handleSignupPost\(request, env\)/.test(index) && /PUBLIC_ROUTES = new Set\([\s\S]{0,300}"\/auth\/signup"/.test(src('auth.ts')) && /WORKER_ONLY = new Set\(\[[^\]]*"\/auth\/signup"/.test(src('routing.ts')), 'the form\'s route exists, is public (the person has no session yet), and is answered by the Worker itself, not forwarded to a business');
  check(/env\.BUSINESS_MODE === "object" && \(request\.headers\.get\("Accept"\) \?\? ""\)\.includes\("text\/html"\)\) return handleUnknownAccount/.test(index) && /return Response\.json\(\s*\{ error: "no active membership for this Google account"/.test(index), 'only a BROWSER in object mode gets the page; anything else still gets the JSON refusal as before');
  check(/lookupAccessForEmail\(env, sessionEmail\)/.test(index) && /notAfterMs = Date\.parse\(/.test(index) && /signedInRedirect\(request, env, \{ sessionEmail, displayEmail: claims\.email, role: membership\.role, businessId: sessionBusiness, notAfterMs \}\)/.test(index), 'the callback hands a trial\'s end to the session, and finishes through the shared redirect');
  check(!/signSession/.test(index.replace(/^import[\s\S]*?from "\.\/auth";/m, '')) && !/office_session=\$\{sessionToken\}/.test(index), 'the redirect lives in ONE place (signin.ts): index.ts no longer builds sessions or cookies itself');
  check(/TRIAL_DAYS = 14/.test(src('signup.ts')) && /messagesPerMemberPerDay: 30, neuronsPerBusinessPerDay: 60_000, mode: "enforce"/.test(src('limits.ts')) && /DEFAULT_DAILY_CAP = 50/.test(src('signup.ts')) && /DEFAULT_IP_DAILY_CAP = 10/.test(src('signup.ts')), 'the numbers Pierre approved are the numbers in the code: 14 days, 30 messages and 60,000 neurons, enforced; and the safety rails of 50 a day and 10 per address');
}

// These tests need the platform's REAL Request, Response and FormData, and the suite's earlier tests install a minimal stand-in for Response globally. So they run in their OWN Node process (which has the real ones), and each result
// is replayed through the suite's `check`, so the messages and the counts appear in the suite exactly as if they had run inside it.
module.exports = async function runSignupTests({ check, srcDir }) {
  const { execFileSync } = require('child_process');
  let lines;
  try {
    lines = execFileSync(process.execPath, ['--no-warnings', __filename], { env: { ...process.env, SIGNUP_CHILD: '1', SIGNUP_SRC: srcDir }, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 }).toString().split('\n').filter((l) => l.startsWith(MARK));   // the Worker logs its own lines to stdout: only lines with the marker are results
  } catch (e) { check(false, `the signup tests crashed: ${String(e.stderr || e.message).split('\n').slice(0, 4).join(' | ').slice(0, 400)}`); return; }
  const results = lines.map((l) => JSON.parse(l.slice(MARK.length)));
  check(results.length >= 60, `the signup tests ran (${results.length} checks)`);
  for (const r of results) check(r.ok, r.message);
};

if (require.main === module && process.env.SIGNUP_CHILD === '1') {
  const results = [];
  body({ check: (ok, message) => results.push({ ok: !!ok, message }), srcDir: process.env.SIGNUP_SRC })
    .then(() => { for (const r of results) process.stdout.write(MARK + JSON.stringify(r) + '\n'); })
    .catch((e) => { process.stderr.write(String(e && e.stack)); process.exit(1); });
}
