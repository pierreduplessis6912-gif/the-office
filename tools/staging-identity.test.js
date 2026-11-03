// The staging object-identity check (tools/staging-identity.py + .github/workflows/staging-identity.yml). TESTS FIRST.
// WHAT IT IS FOR: the fix in business-object.ts (an object refuses a claim that does not match the name it was addressed by) only works if the PRODUCTION RUNTIME tells the object its own name. That cannot be known from here, so this check reads
//   /admin/health on real staging objects and records what they report (object.name, object.identityVisible). It is READ ONLY (it only ever issues GET), prints no key, and changes nothing on staging.
// WHAT THE TESTS PROVE: against a local fake of staging, the script tells apart (1) the name is exposed and is exactly business-<id>; (2) the name is not exposed (the fix is inert there); (3) the name IS exposed but in a different shape (the fix would
//   refuse legitimate claims: an UNSAFE answer, a failing run); (4) the fix is not deployed; (5) staging runs another commit than expected (nothing is read); (6) staging is unreachable. It cannot prove anything about the real runtime: only a run can.
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), crypto = require('crypto');
const { spawn } = require('child_process');
const kit = require('./engine-kit.js');

module.exports = kit.guard('staging identity check', async ({ check }) => {
  const SEED = 'test-seed-not-a-secret';
  const derive = (label) => crypto.createHmac('sha256', SEED).update(label).digest('base64').replace(/[=+/\n]/g, '').slice(0, 43);
  const SCRIPT = path.join(__dirname, 'staging-identity.py'), WORKFLOW = path.join(__dirname, '..', '.github', 'workflows', 'staging-identity.yml');
  check(fs.existsSync(SCRIPT) && fs.existsSync(WORKFLOW), 'the script and the workflow exist');
  if (!fs.existsSync(SCRIPT)) return;

  // a local fake of staging: /health says which commit runs; /admin/health answers per target business with whatever `health(business)` returns
  const run = async ({ commit = 'abc1234', expect = 'abc1234', health, businesses, status = 200 }) => {
    const log = [];
    const server = http.createServer((req, res) => {
      log.push({ method: req.method, url: req.url, key: req.headers['x-admin-key'], target: req.headers['x-target-business'], ua: req.headers['user-agent'] });
      res.setHeader('content-type', 'application/json');
      if (req.url === '/health') { res.end(JSON.stringify({ ok: true, commit })); return; }
      if (req.url === '/admin/health') { const b = req.headers['x-target-business']; res.statusCode = status; res.end(JSON.stringify(health(b))); return; }
      res.statusCode = 404; res.end('{}');
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sid-')), 'result.json');
    const env = { ...process.env, SEED, BASE: `http://127.0.0.1:${server.address().port}`, EXPECT_COMMIT: expect, OUT: out, ...(businesses ? { BUSINESSES: businesses } : {}) };
    const child = spawn('python3', [SCRIPT], { env });
    let stdout = '', stderr = ''; child.stdout.on('data', (d) => (stdout += d)); child.stderr.on('data', (d) => (stderr += d));
    const code = await new Promise((r) => child.on('close', r));
    server.close();
    let result = null; try { result = JSON.parse(fs.readFileSync(out, 'utf8')); } catch { /* none written */ }
    return { code, stdout, stderr, result, log, raw: fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '' };
  };
  const ok = (name, visible = true) => ({ business: name, object: { name: visible ? 'business-' + name : null, identityVisible: visible } });

  // (1) the name is exposed and matches
  const a = await run({ health: ok });
  check(a.code === 0 && a.result && a.result.verdict === 'runtime_exposes_the_object_name_and_it_matches', `(1) the name is exposed and is exactly business-<id> for both businesses: verdict ${a.result && a.result.verdict}, exit ${a.code}`);
  check(a.result && Object.keys(a.result.businesses).sort().join() === 'staging-co,staging-two' && a.result.businesses['staging-co'].object_name === 'business-staging-co' && a.result.businesses['staging-two'].name_matches === true, 'and it records, per business, the name it saw and whether it matched');
  check(a.log.length === 3 && a.log.every((l) => l.method === 'GET'), `READ ONLY: exactly three requests (one /health, one /admin/health per business) and every one is a GET (${a.log.map((l) => l.method).join(',')})`);
  check(a.log.filter((l) => l.url === '/admin/health').every((l) => l.key === derive('admin') && l.ua && !/python-urllib/i.test(l.ua)), 'it authenticates with the key DERIVED from the seed (the same derivation the staging workflow uses) and sends its own User-Agent, not the default one Cloudflare tends to refuse');
  check(!a.raw.includes(derive('admin')) && !a.stdout.includes(derive('admin')) && !a.stderr.includes(derive('admin')) && !a.raw.includes(SEED), 'the key and the seed appear in neither the record nor the output');
  check(a.log.map((l) => l.target).filter(Boolean).sort().join() === 'staging-co,staging-two', 'it targets exactly the two named staging businesses');

  // (2) the runtime tells the object nothing: the fix is inert there. Information, not an error
  const b = await run({ health: (n) => ok(n, false) });
  check(b.code === 0 && b.result.verdict === 'runtime_exposes_no_object_name', `(2) a runtime that exposes no object name is recorded as such, not as a failure: verdict ${b.result && b.result.verdict}, exit ${b.code}`);

  // (3) UNSAFE: a name is exposed but it is not business-<id>: the fix would refuse every legitimate claim
  const c = await run({ health: (n) => ({ business: n, object: { name: 'ab12cd34', identityVisible: true } }) });
  check(c.code !== 0 && c.result.verdict === 'runtime_exposes_the_name_but_it_does_not_match', `(3) a name exposed in a DIFFERENT shape is the unsafe case (the fix would lock businesses out) and FAILS the run: verdict ${c.result && c.result.verdict}, exit ${c.code}`);

  // (4) the fix is not deployed: no object field at all
  const d = await run({ health: (n) => ({ business: n }) });
  check(d.code !== 0 && d.result.verdict === 'the_fix_is_not_deployed', `(4) a health report with no object entry means the fix is not what is running, which FAILS the run rather than answering the question wrongly: verdict ${d.result && d.result.verdict}`);

  // (5) staging runs a different commit: nothing about objects is read
  const e = await run({ commit: 'zzz9999', expect: 'abc1234', health: ok });
  check(e.code !== 0 && e.result.verdict === 'commit_mismatch' && e.log.every((l) => l.url === '/health') && e.result.deployed_commit === 'zzz9999', `(5) staging running another commit than expected stops BEFORE any object is read, so the record cannot describe the wrong code (${e.log.length} request)`);

  // (6) staging cannot be read
  const f = await run({ health: ok, status: 500 });
  check(f.code !== 0 && f.result.verdict === 'unreachable', `(6) a health report that cannot be read is "unreachable", never a guess: verdict ${f.result && f.result.verdict}`);

  // the code and the workflow, read as text
  const py = fs.readFileSync(SCRIPT, 'utf8'), wf = fs.readFileSync(WORKFLOW, 'utf8');
  check(!/method\s*=\s*["'](POST|PUT|DELETE|PATCH)/i.test(py) && !/\.(post|put|delete|patch)\(/i.test(py), 'the script has no code path that is not a GET');
  const triggers = (wf.match(/^on:\s*\n((?:\s+.*\n)+)/m) || ['', ''])[1];
  check(/workflow_dispatch/.test(triggers) && !/(push|pull_request|schedule|workflow_call):/.test(triggers), 'the workflow starts by hand only');
  check(/git push origin HEAD:"\$GITHUB_REF_NAME"/.test(wf) && !/HEAD:main|origin main|git push -q origin HEAD:main/.test(wf), 'it records to the BRANCH it ran on, never to main (a push to main deploys production)');
  check(!/wrangler|secret put|deploy|CLOUDFLARE_API_TOKEN|migrat|DELETE FROM/i.test(wf.replace(/^#.*$/gm, '')), 'the workflow deploys nothing, sets no secret and holds no Cloudflare token: it only reads');
  check(/STAGING_KEY_SEED/.test(wf) && (wf.match(/secrets\./g) || []).length === 1, 'the only secret it uses is the staging key seed');
  check(/expect_commit/.test(wf) && /required:\s*true/.test(wf), 'it requires the commit staging must be running');
});

if (require.main === module) kit.standalone(module.exports);
