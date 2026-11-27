// THE EXTRACTION PROBE (worker/src/extract-probe.ts, docs/decisions/extract-model-run.md): POST /debug/extract-probe calls one ALLOWED ai.ts function and reports what it returned and which model answered.
// It must refuse any other name, pass the caller's inputs through, report the model (or the reason none answered), and never reach a function that writes.
const kit = require('./engine-kit.js');
const fs = require('fs');
const path = require('path');

module.exports = kit.guard('extraction probe', async ({ check, srcDir }) => {
  const mod = kit.bundle('extract-probe.ts', 'extract-probe-suite');
  check(Boolean(mod && typeof mod.extractProbe === 'function' && Array.isArray(mod.EXTRACT_PROBE_FUNCTIONS)), 'the probe exports extractProbe and the list of functions it allows');
  if (!mod || typeof mod.extractProbe !== 'function') return;
  const post = (body) => new Request('https://x/debug/extract-probe', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) });
  const calls = [];
  const env = { MOONSHOT_API_KEY: 'k', AI: { run: async (model, input) => { calls.push({ model, input }); return { choices: [{ message: { content: JSON.stringify({ description: 'chipped skirting' }) } }] }; } } };
  const realFetch = globalThis.fetch;
  const moon = [];
  globalThis.fetch = async (url, init) => { if (String(url).startsWith('https://api.moonshot.ai/')) { moon.push(JSON.parse(init.body)); return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ description: 'chipped skirting' }) } }] }), { status: 200 }); } return realFetch(url, init); };
  try {
    // ---- refused -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
    for (const bad of [{ fn: 'storeUnscopedMemory', args: { text: 'x' } }, { fn: 'embedText', args: { text: 'x' } }, { fn: 'constructor' }, { fn: '__proto__' }, { fn: '' }, {}, 'not json']) {
      const before = calls.length + moon.length;
      const res = await mod.extractProbe(post(bad), env);
      check(res.status === 422 && calls.length + moon.length === before, `a name that is not allowed (${JSON.stringify(bad).slice(0, 40)}) is refused 422 and nothing is called`);
    }
    check(!mod.EXTRACT_PROBE_FUNCTIONS.some((n) => /^(store|embed|search|rerank|transcribe|describe)/.test(n)), 'no allowed function touches memory, vectors, audio or images');
    // ---- allowed: the answer, the model, the route ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
    const ok = await (await mod.extractProbe(post({ fn: 'extractSnag', args: { text: 'The skirting in the Dlamini bedroom is chipped' } }), env)).json();
    check(ok.fn === 'extractSnag' && ok.result && ok.result.description === 'chipped skirting' && ok.threw === null && ok.route === 'extract.snag' && ok.via === 'moonshot:kimi-k2.6' && ok.why === null && typeof ok.ms === 'number', `an allowed call returns the result, the route and the model that answered (${JSON.stringify(ok).slice(0, 160)})`);
    check(moon.length === 1 && JSON.stringify(moon[0].messages).includes('Dlamini bedroom'), 'the caller\'s sentence reaches the model');
    // a records route is answered by Cloudflare, never Moonshot
    moon.length = 0; calls.length = 0;
    const rec = await (await mod.extractProbe(post({ fn: 'extractStockUsage', args: { text: 'Used 3 sheets of plywood', stockItems: [{ name: 'Plywood 18mm', unit: 'sheet' }] } }), env)).json();
    check(rec.route === 'extract.stock_usage' && /^cloudflare:/.test(rec.via || '') && moon.length === 0 && calls.length >= 1, `a records route (stock usage) is answered by Cloudflare and never sent to Moonshot (${rec.via})`);
    // no model at all: the function swallows it, the probe says why
    const dead = { AI: { run: async () => { throw new Error('model unavailable'); } } };
    const down = await (await mod.extractProbe(post({ fn: 'extractLead', args: { text: 'New lead Thandi' } }), dead)).json();
    check(down.via === null && /no model|unavailable|Moonshot/i.test(down.why || '') && down.threw === null, `when no model answers the probe reports why instead of a bare empty answer (${JSON.stringify(down).slice(0, 200)})`);
    // a function that never asks a model says so
    const none = await (await mod.extractProbe(post({ fn: 'answerFromMemory', args: { text: 'What?', facts: [] } }), env)).json();
    check(none.route === null && none.via === null && /anything on file/i.test(String(none.result)), 'a call that never reached a model reports no route and no model');
  } finally { globalThis.fetch = realFetch; }
  // ---- wiring: the route exists, behind /debug (admin key), POST only ------------------------------------------------------------------------------------------------------------------------------------------------------------
  const debugSrc = fs.readFileSync(path.join(srcDir, 'debug.ts'), 'utf8');
  check(/url\.pathname === "\/debug\/extract-probe" && request\.method === "POST"\)\s*\{\s*return extractProbe\(request, env\);/.test(debugSrc), 'debug.ts routes POST /debug/extract-probe to the probe');
  const auth = fs.readFileSync(path.join(srcDir, 'auth.ts'), 'utf8');
  check(/path\.startsWith\("\/debug\/"\)/.test(auth) && !/APP_DEBUG_ROUTES[^;]*extract-probe/s.test(auth), 'the probe is under /debug and is not on the list of app routes, so it needs the admin key');
  check(fs.readFileSync(path.join(srcDir, 'ai.ts'), 'utf8').includes('lastModelCall = { route, via: r.via ?? null'), 'ai.ts notes the model of every chat call for the probe');
});
if (require.main === module) kit.standalone(module.exports);
