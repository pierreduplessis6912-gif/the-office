// Tests for the signed links sent to customers (SHIP_CHECKLIST.md item 3, 2026-10-11). A link is the only thing that lets a customer, with no login, open an invoice
// or quotation PDF (which carries the business's banking details), so it must be tied to one exact document, must expire, and must not be forgeable.
// The permission tests swap in a bare stand-in for Response; the real one is kept in __RealResponse. This needs the real one, so it is swapped in and restored.
const realNow = Date.now;   // the real clock, restored whatever happens
module.exports = async function runSignedLinkTests(context) {
  const standIn = global.Response;
  if (global.__RealResponse) global.Response = global.__RealResponse;
  try {
    await signedLinkTests(context);
  } finally {
    global.Response = standIn;
    Date.now = realNow;
  }
};

async function signedLinkTests({ check, bundleTo, srcDir, path, fs }) {
  const auth = bundleTo('auth.ts', 'rm-auth-links.js');
  const env = { SESSION_SECRET: 'link-test-secret', ADMIN_KEY: 'k' };
  const DAY = 24 * 60 * 60 * 1000;
  const open = async (p, sig, e = env) => {
    const url = new URL('https://office.example' + p + (sig === undefined ? '' : '?sig=' + encodeURIComponent(sig)));
    const r = await auth.authGate(new Request(url), e, url);
    return r === null ? 'open' : r.status;
  };

  const good = await auth.signDocumentPath(env, '/invoices/3/pdf', 60 * 1000);
  check((await open('/invoices/3/pdf', good)) === 'open', 'a valid link opens exactly the document it was made for');
  check((await open('/invoices/4/pdf', good)) === 403, 'the same link on a different document is refused (invoice 3\'s link never opens invoice 4)');
  check((await open('/quotations/3/pdf', good)) === 403, 'and not a quotation with the same number either');
  const quote = await auth.signDocumentPath(env, '/quotations/2/pdf', 60 * 1000);
  check((await open('/quotations/2/pdf', quote)) === 'open', 'a quotation link opens its quotation');
  check((await open('/invoices/3/pdf', await auth.signDocumentPath(env, '/invoices/3/pdf', -1000))) === 403, 'an expired link is refused');
  check((await open('/invoices/3/pdf', await auth.signDocumentPath({ ...env, SESSION_SECRET: 'someone-elses-secret' }, '/invoices/3/pdf', 60000))) === 403, 'a link signed with a different secret is refused');

  const [payload, signature] = good.split('.');
  const flip = (t) => t.slice(0, -2) + (t.slice(-2) === 'AA' ? 'BB' : 'AA');
  check((await open('/invoices/3/pdf', flip(payload) + '.' + signature)) === 403, 'a link with its content altered is refused');
  check((await open('/invoices/3/pdf', payload + '.' + flip(signature))) === 403, 'a link with its signature altered is refused');
  check((await open('/invoices/3/pdf', undefined)) === 403 && (await open('/invoices/3/pdf', '')) === 403 && (await open('/invoices/3/pdf', 'garbage')) === 403 && (await open('/invoices/3/pdf', 'a.b.c')) === 403, 'no link, an empty link and malformed links are all refused');

  // ---- how long a customer's link lasts, tested against a clock the test controls -------------------------------------------------------
  check(auth.CUSTOMER_LINK_TTL_MS === 60 * DAY, 'a customer link lasts 60 days (twice the 30-day payment terms), not a year');
  const start = realNow.call(Date);
  let now = start; Date.now = () => now;
  const customerLink = await auth.signDocumentPath(env, '/invoices/9/pdf', auth.CUSTOMER_LINK_TTL_MS);
  now = start + 59 * DAY;
  check((await open('/invoices/9/pdf', customerLink)) === 'open', 'a customer link still works after 59 days');
  now = start + 61 * DAY;
  check((await open('/invoices/9/pdf', customerLink)) === 403, 'and is refused after 61 days');
  Date.now = realNow;

  // ---- every place that makes a link uses it -------------------------------------------------------------------------------------------
  const indexSrc = fs.readFileSync(path.join(srcDir, 'index.ts'), 'utf8').replace(/\/\/.*$/gm, '');
  const sites = [...indexSrc.matchAll(/signDocumentPath\(env, [^,]+, ([^)]+)\)/g)].map((m) => m[1].trim());
  check(sites.length === 4 && sites.filter((s) => s === 'CUSTOMER_LINK_TTL_MS').length === 3 && sites.filter((s) => s === '10 * 60 * 1000').length === 1, `links are made in exactly four places: three for customers (the one shared lifetime) and the owner's own in-app tap (10 minutes); found: ${sites.join(' | ')}`);
  check(!/365 \* 24/.test(indexSrc), 'no link lifetime of a year remains anywhere');
}
