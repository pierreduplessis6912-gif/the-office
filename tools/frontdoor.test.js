// Tests for the Worker's front door (hardening, 2026-10-11): nothing that goes wrong inside a request may escape as a bare failure.
// The permission tests swap in a bare stand-in for Response (it only records a status and a body); the real one is kept in __RealResponse for tests that read a
// body back. This needs the real one, so it is swapped in for the duration and always restored.
module.exports = async function runFrontDoorTests(context) {
  const standIn = global.Response;
  if (global.__RealResponse) global.Response = global.__RealResponse;
  try {
    await frontDoorTests(context);
  } finally {
    global.Response = standIn;
  }
};

async function frontDoorTests({ check, bundleTo, srcDir, path, fs }) {
  const { runGuarded } = bundleTo('frontdoor.ts', 'rm-frontdoor.js');
  const logs = [];
  const log = (level, id, msg, fields) => logs.push({ level, id, msg, fields });
  // If the front door lets an error escape, that must show up as a FAILED CHECK, not as a crash of the whole suite.
  const attempt = async (fn) => { try { return await fn(); } catch (error) { return { status: 'THREW', json: async () => ({}), headers: { get: () => '' } }; } };
  const req = new Request('https://office.example/messages/text?secret=abc123', { method: 'POST' });

  const fine = new Response('fine', { status: 200 });
  check((await runGuarded(req, 'req-1', async () => fine, log)) === fine && logs.length === 0, 'a normal response is returned exactly as it was (the same object) and nothing is logged');
  const refused = new Response('no', { status: 403 });
  check((await runGuarded(req, 'req-2', async () => refused, log)) === refused && logs.length === 0, 'a route\'s own error response (a 403) passes through untouched and is not logged as a failure');

  const leaky = 'D1_ERROR: no such table: secret_table_name';
  const failed = await attempt(() => runGuarded(req, 'req-3', async () => { throw new Error(leaky); }, log));
  const body = await failed.json();
  check(failed.status === 500 && body.requestId === 'req-3' && typeof body.error === 'string' && /json/.test(failed.headers.get('content-type') || ''), 'an uncaught error becomes a JSON 500 that carries the request id');
  check(!JSON.stringify(body).includes('secret_table_name') && !JSON.stringify(body).includes('D1_ERROR'), 'and tells the caller nothing about what failed');
  check(logs.length === 1 && logs[0].level === 'error' && logs[0].id === 'req-3' && logs[0].fields.error === leaky && logs[0].fields.method === 'POST' && /Error/.test(logs[0].fields.stack || ''), 'it is logged once, as an error, with the request id, the method, the message and the stack');
  check(logs[0].fields.path === '/messages/text' && !JSON.stringify(logs[0].fields).includes('abc123'), 'the log carries the path and never the query string (which can hold a key or a name)');

  logs.length = 0;
  const plain = await attempt(() => runGuarded(req, 'req-4', async () => { throw 'a plain string, not an Error'; }, log));
  check(plain.status === 500 && logs.length === 1 && logs[0].fields.error === 'a plain string, not an Error', 'something thrown that is not an Error object is handled the same way');
  logs.length = 0;
  const sync = await attempt(() => runGuarded(req, 'req-5', () => { throw new Error('thrown before any await'); }, log));
  check(sync.status === 500 && logs.length === 1, 'an error thrown before the handler ever awaits is caught too');

  // ---- the front door is actually used, and error responses still get the CORS headers --------------------------------------------
  const indexSrc = fs.readFileSync(path.join(srcDir, 'index.ts'), 'utf8');
  const doorSrc = fs.readFileSync(path.join(srcDir, 'frontdoor.ts'), 'utf8');
  check(/const response = await runGuarded\(request, requestId, \(\) => handleRequest\(/.test(indexSrc) && (indexSrc.match(/handleRequest\(/g) || []).length === 2, 'the request must be handled only through the front door (handleRequest is defined once and called once, inside it)');
  check(indexSrc.indexOf('runGuarded(') > 0 && indexSrc.indexOf('runGuarded(') < indexSrc.indexOf('newHeaders.set(key, value)'), 'the front door must run BEFORE the CORS headers are added, so an error response carries them and the app can read it');
  const doorCode = doorSrc.replace(/\/\/.*$/gm, '');
  check(!/Response\.json\(\{[^}]*(\.message|\.stack|failure)/.test(doorCode), 'the error response must never include the message or the stack');
  check(!/^import .* from "\.\//m.test(doorCode), 'frontdoor.ts must import nothing from the rest of the Worker (it has to work when everything else is what broke)');
}
