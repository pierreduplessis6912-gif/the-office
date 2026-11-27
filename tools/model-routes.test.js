// THE MODEL ROUTER (docs/MODEL_ROUTES.md): every chat-model call goes through worker/src/model-routes.ts, which has ONE table of routes (a primary model and a fallback each), ONE catalogue of models (each with its own provider settings),
// and ONE override (the Worker variable MODEL_ROUTES) that the "Staging model secrets" workflow sets. Cloudflare retired its Kimi on 2026-11-20 (410, code 5028); this is what makes the next change a one-line switch.
const kit = require('./engine-kit.js');
const fs = require('fs');
const path = require('path');

module.exports = kit.guard('model routes', async ({ check, srcDir }) => {
  const mod = kit.bundle('model-routes.ts', 'model-routes-suite');
  check(Boolean(mod && typeof mod.chat === 'function' && typeof mod.resolveRoute === 'function' && mod.MODELS && mod.DEFAULT_ROUTE), 'the router exports chat, resolveRoute, the catalogue (MODELS) and the default route');
  if (!mod || typeof mod.chat !== 'function') return;
  const KEY = 'sk-moon-router-test-123';
  const messages = [{ role: 'system', content: 'You read one sentence.' }, { role: 'user', content: '<<<\nhello\n>>>' }];
  const okBody = (content) => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  const setup = ({ moon, cf, key = KEY, routes } = {}) => {
    const log = { moon: [], cf: [] };
    const env = {
      ...(key ? { MOONSHOT_API_KEY: key } : {}), ...(routes !== undefined ? { MODEL_ROUTES: routes } : {}),
      AI: { run: async (model, input) => { log.cf.push({ model, input }); const r = cf ? cf(model, input) : { choices: [{ message: { content: 'from-cf' } }] }; if (r === 'HANG') return new Promise(() => {}); if (r instanceof Error) throw r; return r; } },
    };
    const real = globalThis.fetch;
    globalThis.fetch = async (url, init) => { if (String(url).startsWith('https://api.moonshot.ai/')) { log.moon.push({ url: String(url), body: JSON.parse(init.body), headers: init.headers || {} }); const r = moon ? moon() : okBody('from-moon'); if (r === 'HANG') return new Promise((_, rej) => init.signal.addEventListener('abort', () => { const e = new Error('The operation was aborted'); e.name = 'AbortError'; rej(e); })); if (r instanceof Error) throw r; return r; } return real(url, init); };
    return { env, log, done: () => { globalThis.fetch = real; } };
  };
  const run = async (opts, route = 'interpret', extra = {}) => { const s = setup(opts); try { const out = await mod.chat(s.env, route, { messages, maxTokens: 200, ...extra }); return { out, log: s.log }; } finally { s.done(); } };

  // ---- the table and the catalogue ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  check(Object.keys(mod.MODELS).includes('kimi') && Object.keys(mod.MODELS).includes('deepseek') && mod.DEFAULT_ROUTE.primary === 'kimi' && mod.DEFAULT_ROUTE.fallback === 'deepseek', 'the catalogue names kimi (Moonshot) and deepseek (Cloudflare); the default route is Kimi first, DeepSeek as the fallback');
  check(mod.MODELS.kimi.provider === 'moonshot' && mod.MODELS.kimi.id === 'kimi-k2.6' && mod.MODELS.deepseek.provider === 'cloudflare' && mod.MODELS.deepseek.id === '@cf/deepseek-ai/deepseek-v4.1-flash-1017', 'each catalogue entry names its provider and its model id');

  // ---- resolving a route ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const R = (routes, route) => mod.resolveRoute({ MODEL_ROUTES: routes }, route);
  check(JSON.stringify(R(undefined, 'interpret')) === JSON.stringify({ primary: 'kimi', fallback: 'deepseek' }), 'no override: the default route');
  check(R('{"*":"deepseek"}', 'extract.intent').primary === 'deepseek' && R('{"*":"deepseek"}', 'extract.intent').fallback === 'kimi', 'a "*" override sets every route; a lone model gets the other one as its fallback');
  check(R('{"extract":"deepseek"}', 'extract.intent').primary === 'deepseek' && R('{"extract":"deepseek"}', 'interpret').primary === 'kimi', 'a prefix override ("extract") covers extract.intent and nothing else');
  check(R('{"extract":"deepseek","extract.intent":"kimi"}', 'extract.intent').primary === 'kimi' && R('{"*":"deepseek","extract":"kimi"}', 'extract.snag').primary === 'kimi', 'the most specific override wins (exact, then longest prefix, then "*")');
  check(JSON.stringify(R('{"interpret":["deepseek",null]}', 'interpret')) === JSON.stringify({ primary: 'deepseek', fallback: null }) && R('{"interpret":["deepseek","kimi"]}', 'interpret').fallback === 'kimi', 'an array sets the primary and the fallback explicitly (null = no fallback)');
  for (const bad of ['not json', '[]', '{"*":"gpt-9"}', '{"*":5}', '{"interpret":["kimi","gpt-9"]}', '"x"', '{"":"kimi"}']) {
    const r = R(bad, 'interpret');
    check(r.primary === 'kimi' && r.fallback === 'deepseek', `a bad override (${bad}) changes nothing: the default route applies`);
  }
  check(R('{"extract":"deepseek","bogus":"nope"}', 'extract.intent').primary === 'deepseek', 'one bad entry does not cancel the good ones');
  check(R('{"extract":"deepseek"}', 'extractor.x').primary === 'kimi' && R('{"extract":"deepseek"}', 'extract').primary === 'deepseek', 'a prefix matches whole dotted parts only ("extract" covers "extract" and "extract.x", not "extractor.x")');
  check(R('{"extract":"deepseek","extract.intent":"kimi"}', 'extract.intent.deep').primary === 'kimi' && R('{"extract.intent":"kimi","extract":"deepseek"}', 'extract.intent.deep').primary === 'kimi' && R('{"extract.intent":"deepseek","extract":"kimi"}', 'extract.intent.deep').primary === 'deepseek', 'the LONGEST matching prefix wins whatever the order of the keys');

  // ---- calling: Moonshot ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  let r = await run({});
  const mb = (r.log.moon[0] || {}).body || {};
  check(r.out.content === 'from-moon' && r.out.via === 'moonshot:kimi-k2.6' && r.log.moon.length === 1 && r.log.cf.length === 0, 'Kimi at Moonshot answers first and Cloudflare is not asked');
  check(r.log.moon[0].url === 'https://api.moonshot.ai/v1/chat/completions' && mb.model === 'kimi-k2.6' && mb.thinking && mb.thinking.type === 'disabled' && mb.max_completion_tokens === 200 && mb.chat_template_kwargs === undefined && mb.reasoning_effort === undefined && (r.log.moon[0].headers.Authorization || '') === 'Bearer ' + KEY && !JSON.stringify(mb).includes(KEY) && JSON.stringify(mb.messages) === JSON.stringify(messages), 'the Moonshot request: its own model id, thinking disabled, the answer cap, the key only in the Authorization header, the messages exactly as given');
  // ---- calling: Cloudflare ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  r = await run({ key: null });
  const ci = (r.log.cf[0] || {}).input || {};
  check(r.out.content === 'from-cf' && r.out.via === 'cloudflare:deepseek-v4.1-flash-1017' && r.log.moon.length === 0 && r.log.cf[0].model === '@cf/deepseek-ai/deepseek-v4.1-flash-1017' && ci.reasoning_effort === 'none' && ci.max_completion_tokens === 200 && ci.temperature === 0 && ci.chat_template_kwargs === undefined && JSON.stringify(ci.messages) === JSON.stringify(messages), 'without a key nothing goes to Moonshot; Cloudflare gets DeepSeek with reasoning off, the answer cap and temperature 0');
  r = await run({}, 'interpret', { temperature: 0.4 });
  check(r.log.moon[0].body.temperature === undefined, 'a temperature is never sent to Moonshot (Kimi K2.6 fixes its own)');
  r = await run({ key: null }, 'interpret', { temperature: 0.4 });
  check(r.log.cf[0].input.temperature === 0.4, 'a route that asks for a temperature gets it on Cloudflare');
  r = await run({ key: null }, 'interpret', { maxTokens: undefined });
  check(r.log.cf[0].input.max_completion_tokens === undefined, 'no cap asked for, none sent');
  // ---- falling back ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  for (const [label, moon] of [['an HTTP 500', () => new Response('boom', { status: 500 })], ['an HTTP 402 (no credit)', () => new Response('{"error":"insufficient"}', { status: 402 })], ['a network error', () => new Error('connection reset')], ['no choices', () => new Response(JSON.stringify({ choices: [] }), { status: 200 })], ['a null reply', () => okBody(null)], ['a blank reply', () => okBody('   ')]]) {
    r = await run({ moon });
    check(r.out.content === 'from-cf' && r.out.via === 'cloudflare:deepseek-v4.1-flash-1017' && r.log.moon.length === 1 && r.log.cf.length === 1, `${label} from Moonshot: the fallback answers`);
  }
  r = await run({ moon: () => new Response('boom', { status: 500 }), cf: () => { const e = new Error('5028: gone'); e.name = 'AiError'; return e; } });
  check(r.out.content === null && r.out.via === null && /moonshot: HTTP 500/.test(r.out.why) && /cloudflare: AiError: 5028/.test(r.out.why) && !r.out.why.includes(KEY) && r.out.why.length <= 260, 'when both fail: no text, and both reasons (cut short, never the key)');
  r = await run({ cf: () => ({ choices: [] }), key: null });
  check(r.out.content === null && /answered without text/.test(r.out.why), 'a Cloudflare answer with no text is a failure with its reason');
  r = await run({ cf: () => ({ response: 'legacy shape' }), key: null });
  check(r.out.content === 'legacy shape', 'the older Cloudflare response shape is still read');
  // ---- the override changes what is called ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  r = await run({ routes: '{"*":"deepseek"}' });
  check(r.out.via === 'cloudflare:deepseek-v4.1-flash-1017' && r.log.moon.length === 0 && r.log.cf.length === 1, 'switched to DeepSeek: Moonshot is not called at all');
  r = await run({ routes: '{"*":"deepseek"}', cf: () => new Error('down') });
  check(r.out.via === 'moonshot:kimi-k2.6' && r.log.cf.length === 1 && r.log.moon.length === 1, 'switched to DeepSeek and it fails: Kimi is the fallback');
  r = await run({ routes: '{"interpret":["deepseek",null]}', cf: () => new Error('down') });
  check(r.out.content === null && r.log.moon.length === 0, 'with no fallback a failure is just a failure (Moonshot is not tried)');
  r = await run({ routes: '{"extract":"deepseek"}' }, 'interpret');
  check(r.out.via === 'moonshot:kimi-k2.6', 'an override for another route does not touch this one');
  r = await run({ routes: '{"interpret":["kimi","kimi"]}', moon: () => new Response('x', { status: 500 }) });
  check(r.out.content === null && r.log.moon.length === 1 && r.log.cf.length === 0, 'a route whose fallback is its own primary asks that model once, not twice');
  let t0 = Date.now();
  r = await run({ moon: () => 'HANG' }, 'interpret', { timeoutMs: 30 });
  check(r.out.content === 'from-cf' && r.log.cf.length === 1 && Date.now() - t0 < 3000, 'a Moonshot call that never answers is cut off at the timeout and the fallback answers');
  t0 = Date.now();
  r = await run({ key: null, cf: () => 'HANG' }, 'interpret', { timeoutMs: 30 });
  check(r.out.content === null && /cloudflare: Error: model timeout/.test(r.out.why) && Date.now() - t0 < 3000, 'a Cloudflare call that never answers is cut off at the timeout, with its reason');
  r = await run({ routes: '{"interpret":["kimi",null]}', moon: () => new Response('x', { status: 500 }) });
  check(r.out.content === null && r.log.cf.length === 0, 'Kimi with no fallback: a Moonshot failure is not retried at Cloudflare');

  // ---- the index cannot go stale -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  // No file but the router may name a chat model or call Moonshot. The files still on the retired Cloudflare Kimi are listed in UNMOVED: the list may only SHRINK (an entry that no longer names a model is stale and fails), and a new file can never join it.
  const UNMOVED = ['ai.ts', 'converse.ts', 'debug.ts', 'trial.ts'];
  const OWN_PATH = ['converse-moonshot.ts'];   // the conversation front door, which calls Moonshot directly on its own path (its own tests pin its one fetch)
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.ts') ? [path.join(dir, e.name)] : []));
  const files = walk(srcDir).map((f) => ({ rel: path.relative(srcDir, f).split(path.sep).join('/'), text: fs.readFileSync(f, 'utf8') }));
  const NAMES_CHAT = /@cf\/(moonshotai|deepseek-ai|zai-org|qwen|google|meta|nvidia)\/|api\.moonshot\.ai/;
  const offenders = files.filter((f) => NAMES_CHAT.test(f.text) && f.rel !== 'model-routes.ts' && !UNMOVED.includes(f.rel) && !OWN_PATH.includes(f.rel));
  check(offenders.length === 0, `no file but the router names a chat model or Moonshot${offenders.length ? ' [OFFENDERS: ' + offenders.map((f) => f.rel).join(', ') + ']' : ''}`);
  const stale = UNMOVED.filter((rel) => { const f = files.find((x) => x.rel === rel); return !f || !/@cf\/moonshotai\//.test(f.text); });
  check(stale.length === 0, `every file in the not-yet-moved list still names the retired model (moved ones come off the list)${stale.length ? ' [STALE: ' + stale.join(', ') + ']' : ''}`);
  const importers = files.filter((f) => /from\s+["'](\.\.?\/)+model-routes["']/.test(f.text)).map((f) => f.rel);
  const engineImporters = importers.filter((rel) => rel.startsWith('engine/'));
  check(JSON.stringify(engineImporters) === JSON.stringify(['engine/interpret.ts']), `of the engine files only the interpreter imports the router [seen: ${engineImporters.join(', ')}]`);
  const interp = files.find((f) => f.rel === 'engine/interpret.ts').text;
  check(!/\.AI\b|MOONSHOT_API_KEY|fetch\(/.test(interp) && /chat\(env, "interpret"/.test(interp), 'the interpreter reaches a model only through the router (route "interpret")');
  // ---- the switch workflow: it can only set what the router understands ------------------------------------------------------------------------------------------------------------------------------------------------------------
  // It lives in the existing staging-secrets workflow because a NEW workflow file cannot be started until it is on the default branch, and nothing here merges to it.
  const wf = path.join(srcDir, '..', '..', '.github', 'workflows', 'staging-moonshot-key.yml');
  check(fs.existsSync(wf) && !fs.existsSync(path.join(srcDir, '..', '..', '.github', 'workflows', 'model-route.yml')), 'the model switch lives in the staging-secrets workflow (one file)');
  if (fs.existsSync(wf)) {
    const w = fs.readFileSync(wf, 'utf8');
    const model = (w.match(/MODELS = \[([^\]]*)\]/) || [])[1] || '';
    check(JSON.stringify(model.split(',').map((x) => x.trim().replace(/"/g, '')).sort()) === JSON.stringify(Object.keys(mod.MODELS).sort()), 'the workflow offers exactly the catalogue models (' + model + ')');
    check(/route-set/.test(w) && /route-clear/.test(w) && /"MODEL_ROUTES"/.test(w) && /office-staging-api/.test(w) && !/office-api\b(?!-)/.test(w.replace(/office-staging-api/g, '')) && /workflow_dispatch/.test(w), 'the workflow sets or clears MODEL_ROUTES, targets only the STAGING Worker, and is started by hand');
    const routeBlock = w.slice(w.indexOf('if act in ("route-set"'), w.indexOf('if act == "verify"'));
    check(routeBlock.length > 200 && !/git |commit|push/.test(routeBlock), 'the switch commits nothing');
  }
});
if (require.main === module) kit.standalone(module.exports);
