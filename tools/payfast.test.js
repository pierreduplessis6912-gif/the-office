// PayFast (worker/src/payfast.ts). The pure rules, pinned before anything uses them, because a subtle mistake here costs real money or rejects real customers. PayFast's own documentation says a payment request must be SIGNED and a
// notification (ITN) must be checked four ways: a valid signature, a source that belongs to PayFast, an amount that matches the order, and PayFast's own confirmation (/eng/query/validate). Website Hub's existing code sends an unsigned
// link (anyone can edit the amount) and builds signatures with encodeURIComponent, whereas PayFast's signature is built the way PHP's urlencode does it (a space is "+", and ! ' ( ) * ~ are escaped), so a genuine notification with a space
// in it would not match. Each of those is a test here. What these tests CANNOT prove is that PayFast's own sandbox accepts a signature we make: that is only proven by a real sandbox payment (and is stated as such in the runbook).
const path = require('path'), fs = require('fs'), os = require('os'), crypto = require('crypto'), esbuild = require('esbuild');

module.exports = async function runPayfastTests(context) {
  const standIn = global.Response;
  if (global.__RealResponse) global.Response = global.__RealResponse;   // the full suite swaps in a stand-in Response; the confirmation tests need the real one
  try { await payfastTests(context); } finally { global.Response = standIn; }
};

async function payfastTests({ check, srcDir }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-')), out = path.join(dir, 'p.js');
  try { esbuild.buildSync({ entryPoints: [path.join(srcDir, 'payfast.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent' }); } catch (e) { check(false, 'payfast.ts exists and builds: ' + String(e.message).split('\n')[0].slice(0, 140)); return; }
  const p = require(out), nodeMd5 = (s) => crypto.createHash('md5').update(s, 'utf8').digest('hex');

  // ---- MD5 (the Workers runtime has none that every environment shares, so it is done in plain code) ---------------------------------------------------------------------------------------------------------------
  check(p.md5Hex('') === 'd41d8cd98f00b204e9800998ecf8427e' && p.md5Hex('abc') === '900150983cd24fb0d6963f7d28e17f72' && p.md5Hex('The quick brown fox jumps over the lazy dog') === '9e107d9d372bb6826bd81d3542a419d6', 'MD5 matches the published test vectors');
  const samples = ['a', 'message digest', 'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(63), 'x'.repeat(64), 'x'.repeat(65), 'x'.repeat(119), 'x'.repeat(120), 'Café ñandú', '日本語のテスト', 'emoji 😀 test', 'a=1&b=2&c=3', 'S'.repeat(1000)];
  for (let i = 0; i < 40; i++) samples.push(crypto.randomBytes(1 + i * 7).toString('base64'));
  check(samples.every((s) => p.md5Hex(s) === nodeMd5(s)), `MD5 agrees with Node's own on ${samples.length} inputs, at every block-size boundary and with unicode (UTF-8)`);

  // ---- PHP-style urlencode ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const php = { 'a b': 'a+b', 'Café': 'Caf%C3%A9', '~': '%7E', "a'b": 'a%27b', '(x)': '%28x%29', '*': '%2A', '!': '%21', 'a@b.co': 'a%40b.co', 'a-b_c.d': 'a-b_c.d', '100%': '100%25', 'a&b=c': 'a%26b%3Dc', '': '', '+': '%2B', '/': '%2F', ' ': '+', 'ü': '%C3%BC', 'R399.00': 'R399.00' };
  for (const [input, want] of Object.entries(php)) check(p.phpUrlencode(input) === want, `urlencode(${JSON.stringify(input)}) is ${JSON.stringify(want)}, as PHP does it`);
  check(p.phpUrlencode('a b') !== encodeURIComponent('a b') && p.phpUrlencode("it's") !== encodeURIComponent("it's"), 'and it is NOT encodeURIComponent (a space and an apostrophe differ), which is why a signature built that way would not match');

  // ---- amounts ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  check(p.centsToRand(39900) === '399.00' && p.centsToRand(5) === '0.05' && p.centsToRand(100) === '1.00' && p.centsToRand(299000) === '2990.00' && p.centsToRand(0) === '0.00', 'cents become a PayFast amount exactly (no floating point)');
  check(p.randToCents('399.00') === 39900 && p.randToCents('0.05') === 5 && p.randToCents('2990.00') === 299000 && p.randToCents('10') === 1000 && p.randToCents('1.5') === 150 && p.randToCents(' 399.00 ') === 39900, 'an amount PayFast sends becomes cents exactly');
  for (const bad of ['', 'abc', '-1.00', '1.234', '1,00', '1e3', '12.', '.5x', null, undefined, 399]) check(p.randToCents(bad) === null, `an amount that is not a plain rand figure is refused: ${JSON.stringify(bad)}`);
  check(p.randToCents('19.99') === 1999 && p.randToCents('0.10') === 10 && p.randToCents('0.30') === 30 && p.randToCents('1.15') === 115, 'amounts that floating point gets wrong (19.99, 0.30, 1.15) are exact');

  // ---- the signature of a payment REQUEST (empty values left out, values trimmed, in the documented order) -----------------------------------------------------------------------------------------------------------
  const fields = [['merchant_id', '10000100'], ['merchant_key', '46f0cd694581a'], ['return_url', 'https://x.co/r'], ['name_first', ' Sipho '], ['email_address', 'a@b.co'], ['m_payment_id', 'ord-1'], ['amount', '399.00'], ['item_name', 'The Office Single user'], ['custom_str1', ''], ['subscription_type', '1']];
  const expectString = 'merchant_id=10000100&merchant_key=46f0cd694581a&return_url=https%3A%2F%2Fx.co%2Fr&name_first=Sipho&email_address=a%40b.co&m_payment_id=ord-1&amount=399.00&item_name=The+Office+Single+user&subscription_type=1&passphrase=My+Pass%21';
  check(p.checkoutSignature(fields, 'My Pass!') === nodeMd5(expectString), 'a payment request is signed: the fields in the order given, empty ones left out, values trimmed, each encoded like PHP, then the passphrase, then MD5');
  check(p.checkoutSignature(fields, '') === nodeMd5(expectString.replace(/&passphrase=.*$/, '')) && p.checkoutSignature(fields, null) === p.checkoutSignature(fields, ''), 'with no passphrase it is signed without one');
  check(p.checkoutSignature(fields, 'My Pass!') !== p.checkoutSignature(fields.map(([k, v]) => [k, k === 'amount' ? '1.00' : v]), 'My Pass!'), 'changing the amount changes the signature (so an edited amount is rejected by PayFast)');
  check(p.checkoutSignature([...fields].reverse(), 'My Pass!') !== p.checkoutSignature(fields, 'My Pass!'), 'the ORDER of the fields matters');

  // ---- the signature of a NOTIFICATION (every posted field incl. empty ones, exactly as posted, never trimmed) -------------------------------------------------------------------------------------------------
  const posted = [['m_payment_id', 'ord-1'], ['pf_payment_id', '1089250'], ['payment_status', 'COMPLETE'], ['item_name', 'The Office Team (3 seats)'], ['amount_gross', '897.00'], ['custom_str1', ''], ['name_first', "O'Neil "], ['email_address', 'a@b.co'], ['token', 'abc-123']];
  const itnString = 'm_payment_id=ord-1&pf_payment_id=1089250&payment_status=COMPLETE&item_name=The+Office+Team+%283+seats%29&amount_gross=897.00&custom_str1=&name_first=O%27Neil+&email_address=a%40b.co&token=abc-123';
  const signedPairs = (pairs, pass) => [...pairs, ['signature', nodeMd5(pass ? `${itnString}&passphrase=${encodeURIComponent(pass).replace(/%20/g, '+')}` : itnString)]];
  check(p.itnParamString(signedPairs(posted, 'secret')) === itnString, 'the notification string leaves out the signature, keeps EVERY other field in the order posted, empty ones included, spaces as "+"');
  check(p.verifyItnSignature(signedPairs(posted, 'secret'), 'secret') === true && p.verifyItnSignature(signedPairs(posted, ''), '') === true, 'a genuine notification verifies (with a space and an apostrophe in it, which encodeURIComponent would have broken)');
  check(p.verifyItnSignature(signedPairs(posted, 'secret'), 'other') === false && p.verifyItnSignature(signedPairs(posted, 'secret'), '') === false, 'with the wrong passphrase it does not');
  check(p.verifyItnSignature(posted, 'secret') === false && p.verifyItnSignature([...posted, ['signature', '']], 'secret') === false && p.verifyItnSignature([...posted, ['signature', 'zz']], 'secret') === false, 'a notification with no signature, an empty one or a malformed one does not');
  const tampered = signedPairs(posted, 'secret').map(([k, v]) => [k, k === 'amount_gross' ? '1.00' : v]); check(p.verifyItnSignature(tampered, 'secret') === false, 'an edited amount does not');
  const swapped = signedPairs(posted, 'secret'); [swapped[0], swapped[1]] = [swapped[1], swapped[0]]; check(p.verifyItnSignature(swapped, 'secret') === false, 'fields in a different order do not (PayFast signs them in the order it sent them)');
  const upper = signedPairs(posted, 'secret').map(([k, v]) => [k, k === 'signature' ? v.toUpperCase() : v]); check(p.verifyItnSignature(upper, 'secret') === true, 'the signature is compared without regard to case');
  check(p.verifyItnSignature(signedPairs(posted, 'secret').map(([k, v]) => [k, k === 'name_first' ? "O'Neil" : v]), 'secret') === false, 'a value is NEVER trimmed before checking (the signature covers what was posted)');
  check(p.parseItnBody('a=1&b=a+b&c=%C3%A9&d=&e=x%3Dy').map((x) => x.join('=')).join('|') === 'a=1|b=a b|c=é|d=|e=x=y', 'a notification body is read in order, "+" is a space, and empty fields are kept');

  // ---- where a notification comes from (advisory) ----------------------------------------------------------------------------------------------------------------------------------------------------------------------
  check(p.ipAllowed('197.97.145.150') && p.ipAllowed('41.74.179.200') && p.ipAllowed('144.126.193.139') && !p.ipAllowed('8.8.8.8') && !p.ipAllowed('') && !p.ipAllowed(null) && !p.ipAllowed('197.97.145.200') && !p.ipAllowed('not an ip') && !p.ipAllowed('::1'), 'the published PayFast address ranges are recognised and nothing else is');
  check(p.ipAllowed('1.2.3.4', ['1.2.3.0/24']) && !p.ipAllowed('197.97.145.150', ['1.2.3.0/24']) && p.ipAllowed('9.9.9.9', ['9.9.9.9']), 'and the ranges can be given in configuration, because PayFast can change them');

  // ---- asking PayFast to confirm ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  { const calls = []; const ok = async (url, init) => { calls.push([url, init]); return new Response('VALID'); }, bad = async () => new Response('INVALID'), boom = async () => { throw new Error('network'); }, err500 = async () => new Response('x', { status: 500 });
    const pairs = signedPairs(posted, 'secret');
    check((await p.confirmWithPayFast(ok, true, pairs)) === true && calls[0][0] === 'https://sandbox.payfast.co.za/eng/query/validate' && calls[0][1].method === 'POST' && calls[0][1].body === itnString && !/signature|passphrase|secret/.test(calls[0][1].body), 'confirmation POSTs the notification string (no signature, no passphrase) to the sandbox host, and "VALID" is accepted');
    await p.confirmWithPayFast(ok, false, pairs); check(calls[1][0] === 'https://www.payfast.co.za/eng/query/validate', 'and to the live host when not sandbox');
    check((await p.confirmWithPayFast(bad, false, pairs)) === false && (await p.confirmWithPayFast(boom, false, pairs)) === false && (await p.confirmWithPayFast(err500, false, pairs)) === false && (await p.confirmWithPayFast(async () => new Response('valid but not'), false, pairs)) === false, 'anything but exactly "VALID" (INVALID, an error, a failed call) is NOT confirmed: it never accepts on a failure'); }

  // ---- the payment request we build ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const req = p.buildCheckout({ merchantId: '10000100', merchantKey: '46f0cd694581a', passphrase: 'My Pass!', sandbox: true, orderId: 'ord-1', amountCents: 89700, itemName: 'The Office Team (3 seats)', itemDescription: 'Monthly', frequency: 'monthly', email: 'a@b.co', firstName: 'Sipho', lastName: 'Dlamini', businessId: 'acme-co', returnUrl: 'https://x.co/r', cancelUrl: 'https://x.co/c', notifyUrl: 'https://x.co/n', today: '2026-10-20' });
  const f = Object.fromEntries(req.fields);
  check(req.url === 'https://sandbox.payfast.co.za/eng/process' && f.merchant_id === '10000100' && f.amount === '897.00' && f.recurring_amount === '897.00' && f.subscription_type === '1' && f.frequency === '3' && f.cycles === '0' && f.billing_date === '2026-10-20' && f.m_payment_id === 'ord-1' && f.custom_str1 === 'acme-co' && f.notify_url === 'https://x.co/n' && /^[0-9a-f]{32}$/.test(f.signature), 'a monthly checkout is a signed subscription: the exact amount, recurring monthly with no end date, starting today, with our order id and notification address');
  check(req.fields[req.fields.length - 1][0] === 'signature' && p.checkoutSignature(req.fields.filter(([k]) => k !== 'signature'), 'My Pass!') === f.signature, 'the signature is the last field and is the signature of all the others');
  const annual = Object.fromEntries(p.buildCheckout({ merchantId: '1', merchantKey: 'k', passphrase: '', sandbox: false, orderId: 'o', amountCents: 299000, itemName: 'x', frequency: 'annual', email: 'a@b.co', businessId: 'b', returnUrl: 'r', cancelUrl: 'c', notifyUrl: 'n', today: '2026-10-20' }).fields);
  check(annual.frequency === '6' && annual.amount === '2990.00' && annual.recurring_amount === '2990.00' && p.buildCheckout({ merchantId: '1', merchantKey: 'k', passphrase: '', sandbox: false, orderId: 'o', amountCents: 1, itemName: 'x', frequency: 'annual', email: 'a@b.co', businessId: 'b', returnUrl: 'r', cancelUrl: 'c', notifyUrl: 'n', today: '2026-10-20' }).url === 'https://www.payfast.co.za/eng/process', 'an annual checkout recurs yearly, and live uses the live host');
  check(req.fields.every(([k, v]) => typeof v === 'string' && v.length > 0 || k === 'signature') && !req.fields.some(([k]) => k === 'passphrase'), 'no empty field is sent, and the passphrase is never part of the request');
  for (const [label, bad] of [['a zero amount', { amountCents: 0 }], ['a negative amount', { amountCents: -5 }], ['a fractional amount', { amountCents: 1.5 }], ['no order id', { orderId: '' }], ['a bad frequency', { frequency: 'weekly' }], ['no notification address', { notifyUrl: '' }]]) { let threw = false; try { p.buildCheckout({ merchantId: '1', merchantKey: 'k', passphrase: '', sandbox: true, orderId: 'o', amountCents: 100, itemName: 'x', frequency: 'monthly', email: 'a@b.co', businessId: 'b', returnUrl: 'r', cancelUrl: 'c', notifyUrl: 'n', today: '2026-10-20', ...bad }); } catch { threw = true; } check(threw, `a checkout is refused for ${label}`); }
  const src = fs.readFileSync(path.join(srcDir, 'payfast.ts'), 'utf8').replace(/\/\/[^\n]*/g, '');
  check(!/encodeURIComponent/.test(src) && !/Math\.round\(.*100\)|parseFloat|Number\(.*\) \* 100/.test(src), 'the module never uses encodeURIComponent (it would not match PayFast) and never turns an amount into cents with floating point');
}
