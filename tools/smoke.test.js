// Tests for the post-deploy smoke test (SHIP_CHECKLIST.md item 5). A smoke test that cannot fail is worthless, so the SCRIPT is run against fake servers that behave
// well and badly, and must pass only for the good one.
const http = require('http'), { execFile } = require('child_process');

function startServer(mode) {
  let healthCalls = 0;
  const server = http.createServer((req, res) => {
    const origin = req.headers.origin;
    const cors = mode === 'noCors' ? {} : (origin ? { 'Access-Control-Allow-Origin': origin } : {});
    const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json', ...cors }); res.end(JSON.stringify(body)); };
    if (req.url === '/health') {
      healthCalls++;
      if (mode === 'health500') return json(500, { error: 'boom' });
      if (mode === 'flaky' && healthCalls <= 2) return json(503, { error: 'starting' });
      return json(200, { status: 'ok', service: 'office-api' });
    }
    if (mode === 'html') { res.writeHead(401, { 'Content-Type': 'text/html' }); return res.end('<html>Error 1101</html>'); }
    if (req.url === '/debug/customers') return mode === 'adminOpen' ? json(200, { customers: [] }) : json(401, { error: 'unauthorized' });
    if (req.url === '/customers' && mode === 'customersOpen') return json(200, { customers: [] });
    return json(401, { error: 'sign in required' });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` })));
}
const runScript = (script, url, env) => new Promise((resolve) => execFile('bash', [script, url], { env: { ...process.env, SMOKE_DELAY: '0', SMOKE_RETRIES: '3', ...env }, encoding: 'utf8', timeout: 60000 }, (err, stdout) => resolve({ code: err ? (err.code === undefined ? 1 : err.code) : 0, out: String(stdout || '') })));

module.exports = async function runSmokeTests({ check, path, fs }) {
  const script = path.join(__dirname, 'smoke-test.sh');
  const attempt = async (mode, env) => { const s = await startServer(mode); const r = await runScript(script, s.url, env); s.server.close(); return r; };

  const good = await attempt('good');
  check(good.code === 0 && /all checks passed/.test(good.out), 'a healthy Worker passes the smoke test');
  const h500 = await attempt('health500');
  check(h500.code !== 0 && /\/health did not answer ok/.test(h500.out), 'a Worker whose /health fails is caught');
  const flaky = await attempt('flaky');
  check(flaky.code === 0 && /not ready/.test(flaky.out), 'a new version that takes a moment to come up is waited for, not failed (health fails twice, then passes)');
  const customersOpen = await attempt('customersOpen');
  check(customersOpen.code !== 0 && /GET \/customers should refuse a stranger/.test(customersOpen.out), 'a deploy that serves the customer list to a stranger is caught');
  const adminOpen = await attempt('adminOpen');
  check(adminOpen.code !== 0 && /GET \/debug\/customers should refuse a stranger/.test(adminOpen.out), 'a deploy that opens an admin route without the key is caught');
  const html = await attempt('html');
  check(html.code !== 0 && /answered an HTML page/.test(html.out) && /should answer JSON/.test(html.out), 'an HTML error page (a crashed Worker) is caught');
  const noCors = await attempt('noCors');
  check(noCors.code !== 0 && /lacks the CORS header/.test(noCors.out), 'a refusal the app could not read (no CORS header) is caught');
  const forced = await attempt('good', { FORCE_FAIL: '1' });
  check(forced.code !== 0 && /FORCE_FAIL is set/.test(forced.out) && /all checks passed/.test(forced.out) === false, 'FORCE_FAIL makes a healthy Worker fail on purpose (this is what the rollback drill uses)');
  const down = await runScript(script, 'http://127.0.0.1:1', {});
  check(down.code !== 0 && /did not answer ok/.test(down.out), 'a Worker that cannot be reached at all is caught');

  const src = fs.readFileSync(script, 'utf8').replace(/^\s*#.*$/gm, '');
  check(!/-X (PUT|PATCH|DELETE)/.test(src) && !/curl[^\n]*(-d |--data|-F |--form)/.test(src) && !/ADMIN_KEY|X-Admin-Key|Authorization:|cookie/i.test(src), 'the smoke test never writes and never carries a secret: it only asks as a stranger');
};

if (require.main === module) {
  const path = require('path'), fs = require('fs');
  let fails = 0;
  const check = (ok, msg) => { console.log((ok ? 'ok   ' : 'FAIL ') + msg); if (!ok) fails++; };
  module.exports({ check, path, fs }).then(() => process.exit(fails ? 1 : 0));
}
