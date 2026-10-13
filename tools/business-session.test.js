// Sessions and signed links in object mode (worker/src/auth.ts), architecture stage 2b. The property under test is the one that keeps businesses apart even if the router makes a mistake:
// an OBJECT honours only a session or a link made for ITS business, and the WORKER itself honours none (it never serves business data). Default mode (no objects) must behave exactly as before.
// The permission tests swap in a bare stand-in for Response; the real one is kept in __RealResponse, and is used for the duration.
module.exports = async function runBusinessSessionTests(context) {
  const standIn = global.Response;
  if (global.__RealResponse) global.Response = global.__RealResponse;
  try { await businessSessionTests(context); } finally { global.Response = standIn; }
};

async function businessSessionTests({ check, srcDir }) {
  const path = require('path'), fs = require('fs'), os = require('os'), esbuild = require('esbuild');
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bs-')), 'auth.js');
  esbuild.buildSync({ entryPoints: [path.join(srcDir, 'auth.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent' });
  const auth = require(out);
  const secret = { SESSION_SECRET: 'session-test-secret', ADMIN_KEY: 'k' };
  const inObject = (id) => ({ ...secret, BUSINESS_MODE: 'object', ...(id ? { BUSINESS_ID: id } : {}) });
  const decode = (token) => JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString());

  // ---- what a session carries ---------------------------------------------------------------------------------------------------------------------
  const withB = await auth.signSession(secret, 'a@x.co', 'alpha-co'), without = await auth.signSession(secret, 'a@x.co');
  check(decode(withB).b === 'alpha-co' && decode(withB).email === 'a@x.co' && !('b' in decode(without)), 'a session made by a sign-in that found a business carries it (b); one made without does not');
  const peeked = await auth.readSessionPayload(secret, withB);
  check(peeked.b === 'alpha-co' && (await auth.readSessionPayload(secret, 'junk')) === null && (await auth.readSessionPayload({ ...secret, SESSION_SECRET: 'x' }, withB)) === null, 'the router can read a verified session\'s business, and nothing from a forged or garbled one');

  // ---- default mode (no objects): exactly as before -------------------------------------------------------------------------------------------------
  check((await auth.verifySession(secret, without)).email === 'a@x.co' && (await auth.verifySession(secret, withB)).email === 'a@x.co', 'without objects, a session with or without a business verifies exactly as before (nothing changes for today\'s deployment)');
  // ---- object mode ------------------------------------------------------------------------------------------------------------------------------------
  const A = inObject('alpha-co'), B = inObject('beta-co'), W = inObject(null);
  check((await auth.verifySession(A, withB)).email === 'a@x.co', 'inside business A\'s object, a session made for A is honoured');
  const beta = await auth.signSession(secret, 'a@x.co', 'beta-co');
  check((await auth.verifySession(A, beta)) === null && (await auth.verifySession(B, withB)) === null, 'inside A\'s object a session made for B is REFUSED, and the other way round (even for the same person)');
  check((await auth.verifySession(A, without)) === null && (await auth.verifySession(W, without)) === null, 'a session with no business is refused in object mode, by an object and by the Worker');
  check((await auth.verifySession(W, withB)) === null && (await auth.verifySession(W, beta)) === null, 'the Worker itself honours NO session in object mode: it never serves business data, it only routes');
  // the gate, end to end up to the point a database would be needed
  const gate = async (env, token) => { const url = new URL('https://office.example/customers'); const r = await auth.authGate(new Request(url, { headers: token ? { cookie: `office_session=${token}` } : {} }), env, url); return r === null ? 'open' : r.status; };
  check((await gate(A, beta)) === 401 && (await gate(B, withB)) === 401 && (await gate(W, withB)) === 401 && (await gate(A, without)) === 401, 'the sign-in gate answers 401 to every one of those, before any data is touched');

  // ---- signed links --------------------------------------------------------------------------------------------------------------------------------------
  const linkA = await auth.signDocumentPath(A, '/invoices/3/pdf', 60000), linkNone = await auth.signDocumentPath(secret, '/invoices/3/pdf', 60000);
  check(decode(linkA).b === 'alpha-co' && !('b' in decode(linkNone)), 'a link made inside A\'s object carries A; one made without objects carries nothing');
  const open = async (env, token) => { const url = new URL('https://office.example/invoices/3/pdf?sig=' + encodeURIComponent(token)); const r = await auth.authGate(new Request(url), env, url); return r === null ? 'open' : r.status; };
  check((await open(A, linkA)) === 'open', 'A\'s object opens A\'s link');
  check((await open(B, linkA)) === 403 && (await open(W, linkA)) === 403 && (await open(A, linkNone)) === 403, 'B\'s object, and the Worker, refuse A\'s link, and A\'s object refuses a link made with no business');
  check((await open(secret, linkA)) === 'open' && (await open(secret, linkNone)) === 'open', 'without objects, links behave exactly as before (with or without a business in them)');
  // ---- links customers already hold (issued before the move, so they carry no business) --------------------------------------------------------------------------------
  const legacyOwner = { ...A, LEGACY_LINK_BUSINESS: 'alpha-co' }, legacyOther = { ...B, LEGACY_LINK_BUSINESS: 'alpha-co' }, legacyNone = A;
  check((await open(legacyOwner, linkNone)) === 'open', 'a link issued BEFORE the move (no business in it) is honoured by the one business designated to own such links');
  check((await open(legacyOther, linkNone)) === 403 && (await open(legacyNone, linkNone)) === 403 && (await open(W, linkNone)) === 403, 'and by NO other business, nor by one when none is designated, nor by the Worker');
  check((await open({ ...legacyOwner, BUSINESS_ID: 'alpha-co' }, await auth.signDocumentPath(B, '/invoices/3/pdf', 60000))) === 403, 'even the legacy business refuses a link that names ANOTHER business (the exception is only for links that name none)');
  const otherPath = new URL('https://office.example/invoices/4/pdf?sig=' + encodeURIComponent(linkNone)); const wrongPath = await auth.authGate(new Request(otherPath), legacyOwner, otherPath);
  check(wrongPath && wrongPath.status === 403, 'and a legacy link is still tied to its exact path (a link for invoice 3 does not open invoice 4)');
  check(auth.peekIsLegacyLink(linkNone) === true && auth.peekIsLegacyLink(linkA) === false && auth.peekIsLegacyLink('garbage') === false && auth.peekIsLegacyLink(null) === false, 'the router can tell a business-less link from one that names a business, without trusting either');
  check(auth.peekBusinessFromToken(linkA) === 'alpha-co' && auth.peekBusinessFromToken(linkNone) === null && auth.peekBusinessFromToken('garbage') === null && auth.peekBusinessFromToken(null) === null, 'the router can read which business a link is for without trusting it (the object verifies it)');
}
