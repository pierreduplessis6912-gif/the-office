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

  // ---- routes that hold records stay on Cloudflare ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  check(mod.RESTRICTED_ROUTES.length === 15 && ['memory.answer', 'vision.describe', 'classify.topic', 'resolve.follow_up', 'extract.supplier_statement', 'extract.document_identity', 'extract.supplier_invoice', 'extract.stocktake', 'converse.reply'].every((x) => mod.RESTRICTED_ROUTES.includes(x)) && !mod.RESTRICTED_ROUTES.includes('extract.intent'), 'the routes that hold records, files, history or photos are marked (15), and the person\'s own-words routes are not');
  for (const rt of mod.RESTRICTED_ROUTES) {
    const d = R(undefined, rt), star = R('{"*":"kimi"}', rt), pre = R(`{"${rt.split('.')[0]}":"kimi"}`, rt), exact = R(`{"${rt}":"kimi"}`, rt);
    if (!(d.primary === 'deepseek' && d.fallback === null && star.primary === 'deepseek' && star.fallback === null && pre.primary === 'deepseek' && exact.primary === 'kimi')) check(false, `route ${rt}: Cloudflare only by default, not moved by "*" or a prefix, moved only by an exact override`);
  }
  check(R('{"*":"kimi"}', 'extract.intent').primary === 'kimi' && R(undefined, 'extract.intent').primary === 'kimi' && R('{"extract":"deepseek"}', 'extract.supplier_statement').primary === 'deepseek', 'the person\'s own-words routes follow the defaults and every override');
  let rr = await run({}, 'memory.answer');
  check(rr.log.moon.length === 0 && rr.out.via === 'cloudflare:deepseek-v4.1-flash-1017', 'a route that holds records never goes to Moonshot by default, even with a key set');
  rr = await run({ cf: () => new Error('down') }, 'memory.answer');
  check(rr.log.moon.length === 0 && rr.out.content === null, 'and when Cloudflare fails it does NOT fall back to Moonshot');
  rr = await run({ routes: '{"memory.answer":"kimi"}' }, 'memory.answer');
  check(rr.log.moon.length === 1 && rr.out.via === 'moonshot:kimi-k2.6', 'an exact override can send it to Moonshot on purpose');

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

  // ---- ai.ts through the router: the real functions, with a stand-in Cloudflare ---------------------------------------------------------------------------------------------------------------------------------------------------
  const aiMod = kit.bundle('ai.ts', 'ai-via-router-suite');
  const aiEnv = (reply) => { const seen = []; return { seen, env: { AI: { run: async (model, input) => { seen.push({ model, input }); const x = reply(model, input); if (x instanceof Error) throw x; return x; } } } }; };
  let ae = aiEnv(() => ({ choices: [{ message: { content: 'INVOICES' } }] }));
  const topic = await aiMod.classifyBusinessTopic(ae.env, [{ role: 'user', text: 'what does Mokoena owe me' }], 'and Patel?');
  const si = (ae.seen[0] || {}).input || {};
  check(topic === 'invoices' && ae.seen.length === 1 && ae.seen[0].model === '@cf/deepseek-ai/deepseek-v4.1-flash-1017' && si.temperature === 0 && si.max_completion_tokens === 10 && si.reasoning_effort === 'none' && si.chat_template_kwargs === undefined && si.max_tokens === undefined && si.messages[0].role === 'system', 'ai.ts classifyBusinessTopic: asked through the router (a records route: Cloudflare only), temperature 0, a 10-token cap, the answer read');
  ae = aiEnv(() => ({ choices: [{ message: { content: '["I measured the lounge", "buy 5 bags of adhesive"]' } }] }));
  const parts = await aiMod.splitIntoTopics(ae.env, 'I measured the lounge and buy 5 bags of adhesive');
  check(Array.isArray(parts) && parts.length === 2 && (ae.seen[0].input.max_completion_tokens === undefined), 'ai.ts splitIntoTopics: the answer is read, and no cap is set where the caller sets none');
  ae = aiEnv(() => new Error('5028: gone'));
  const failed = await aiMod.classifyBusinessTopic(ae.env, [{ role: 'user', text: 'x' }], 'y');
  check(failed === 'general' && ae.seen.length === 3, 'when no model answers, ai.ts still retries three times and then falls back to its own default (the behaviour callers always had)');
  ae = aiEnv(() => new Error('down'));
  const described = await aiMod.describeImage(ae.env, 'AAAA', 'image/png');
  check(/^\[image description failed: no model answered/.test(described), 'ai.ts describeImage: a total failure is reported in its own words, not as an empty description');

  // ---- the index cannot go stale -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  // No file but the router may name a chat model or call Moonshot. The files still on the retired Cloudflare Kimi are listed in UNMOVED: the list may only SHRINK (an entry that no longer names a model is stale and fails), and a new file can never join it.
  const UNMOVED = [];
  const OWN_PATH = ['converse-moonshot.ts'];   // the conversation front door, which calls Moonshot directly on its own path (its own tests pin its one fetch)
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.ts') ? [path.join(dir, e.name)] : []));
  const files = walk(srcDir).map((f) => ({ rel: path.relative(srcDir, f).split(path.sep).join('/'), text: fs.readFileSync(f, 'utf8') }));
  const NAMES_CHAT = /@cf\/(moonshotai|deepseek-ai|zai-org|qwen|google|meta|nvidia)\/|api\.moonshot\.ai/;
  const offenders = files.filter((f) => NAMES_CHAT.test(f.text) && f.rel !== 'model-routes.ts' && !UNMOVED.includes(f.rel) && !OWN_PATH.includes(f.rel));
  check(offenders.length === 0, `no file but the router names a chat model or Moonshot${offenders.length ? ' [OFFENDERS: ' + offenders.map((f) => f.rel).join(', ') + ']' : ''}`);
  const stale = UNMOVED.filter((rel) => { const f = files.find((x) => x.rel === rel); return !f || !/@cf\/moonshotai\//.test(f.text); });
  check(stale.length === 0, `every file in the not-yet-moved list still names the retired model (moved ones come off the list)${stale.length ? ' [STALE: ' + stale.join(', ') + ']' : ''}`);
  // every route the code asks for is in the index (docs/MODEL_ROUTES.md), and every route that holds records is a route the code really uses
  const used = new Set(); for (const f of files) for (const m of f.text.matchAll(/(?:askChat|chat)\(env, "([a-z_.]+)"/g)) used.add(m[1]);
  const indexDoc = fs.readFileSync(path.join(srcDir, '..', '..', 'docs', 'MODEL_ROUTES.md'), 'utf8');
  const unindexed = [...used].filter((rt) => !indexDoc.includes('`' + rt + '`'));
  check(used.size >= 26 && unindexed.length === 0, `every route the code asks for is named in docs/MODEL_ROUTES.md (${used.size} routes)${unindexed.length ? ' [MISSING: ' + unindexed.join(', ') + ']' : ''}`);
  const strayRestricted = mod.RESTRICTED_ROUTES.filter((rt) => !used.has(rt));
  check(strayRestricted.length === 0, `every route marked as holding records is a route the code really uses${strayRestricted.length ? ' [STRAY: ' + strayRestricted.join(', ') + ']' : ''}`);
  const aiText = files.find((f) => f.rel === 'ai.ts').text;
  check(!/env\.AI\.run\(\s*"@cf\/(moonshotai|deepseek-ai)/.test(aiText) && (aiText.match(/askChat\(env, "/g) || []).length === 26, 'ai.ts asks its 26 chat questions only through the router (askChat), none directly');
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
