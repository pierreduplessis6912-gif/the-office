// THE MODEL ROUTER, as shipped on the hotfix branch (worker/src/model-routes.ts, docs/MODEL_ROUTES.md). Cloudflare retired @cf/moonshotai/kimi-k2.6 on 2026-11-20 (HTTP 410, code 5028); every chat call now goes through
// the router, which answers from DeepSeek on Cloudflare unless a Moonshot key is set, and never sends a "records" route to Moonshot. (The fuller suite lives on engine-phase1 as tools/model-routes.test.js.)
module.exports = async function runModelRoutesHotfix({ check, srcDir }) {
  const standIn = global.Response; if (global.__RealResponse) global.Response = global.__RealResponse;
  try { await body({ check, srcDir }); } finally { global.Response = standIn; }
};
async function body({ check, srcDir }) {
  const path = require('path'), fs = require('fs'), os = require('os'), esbuild = require('esbuild');
  const build = (entry, name) => { const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mrh-')), name); esbuild.buildSync({ entryPoints: [path.join(srcDir, entry)], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent' }); return require(out); };
  const mod = build('model-routes.ts', 'router.js');
  const ai = build('ai.ts', 'ai.js');
  const R = global.__RealResponse || Response;   // the umbrella swaps Response for a stand-in in places; the router needs a real one
  const real = globalThis.fetch;
  const run = async (fn, { key, cf, moon } = {}) => {
    const log = { cf: [], moon: [] };
    const env = { ...(key ? { MOONSHOT_API_KEY: key } : {}), AI: { run: async (model, input) => { log.cf.push({ model, input }); if (cf instanceof Error) throw cf; return { choices: [{ message: { content: cf ?? 'fuel' } }] }; } } };
    globalThis.fetch = async (url, init) => { if (String(url).startsWith('https://api.moonshot.ai/')) { log.moon.push(JSON.parse(init.body)); return moon ? moon() : new R(JSON.stringify({ choices: [{ message: { content: 'fuel' } }] }), { status: 200 }); } return real(url, init); };
    try { return { out: await fn(env), log }; } finally { globalThis.fetch = real; }
  };
  const msgs = [{ role: 'user', content: 'hi' }];
  check(mod.MODELS.deepseek.id === '@cf/deepseek-ai/deepseek-v4.1-flash-1017' && mod.MODELS.kimi.provider === 'moonshot', 'the catalogue names the DeepSeek model on Cloudflare and Kimi at Moonshot');
  // no key (production today): Cloudflare DeepSeek answers, Moonshot is never called, the retired model is never asked
  let r = await run((env) => mod.chat(env, 'extract.snag', { messages: msgs, temperature: 0 }));
  check(r.out.content === 'fuel' && r.out.via === 'cloudflare:deepseek-v4.1-flash-1017' && r.log.moon.length === 0 && r.log.cf.length === 1 && r.log.cf[0].model === '@cf/deepseek-ai/deepseek-v4.1-flash-1017' && r.log.cf[0].input.reasoning_effort === 'none', 'with no Moonshot key a call goes to DeepSeek on Cloudflare and nothing is sent out');
  // a key set: Moonshot first for the person's own words, Cloudflare for a records route
  r = await run((env) => mod.chat(env, 'extract.snag', { messages: msgs }), { key: 'k' });
  check(r.out.via === 'moonshot:kimi-k2.6' && r.log.moon.length === 1 && r.log.cf.length === 0, 'with a key, the person\'s own-words route goes to Moonshot first');
  for (const rt of ['extract.stock_usage', 'extract.goods_received', 'memory.answer', 'resolve.follow_up', 'vision.describe', 'converse.reply']) {
    r = await run((env) => mod.chat(env, rt, { messages: msgs }), { key: 'k' });
    check(/^cloudflare:/.test(r.out.via || '') && r.log.moon.length === 0, `the records route ${rt} is never sent to Moonshot, even with a key`);
  }
  check(mod.RESTRICTED_ROUTES.length === 15, 'fifteen routes are marked as holding records');
  // Moonshot failing falls back to Cloudflare; both failing reports why
  r = await run((env) => mod.chat(env, 'extract.snag', { messages: msgs }), { key: 'k', moon: () => new R('no', { status: 500 }) });
  check(r.out.content === 'fuel' && /^cloudflare:/.test(r.out.via) && r.log.moon.length === 1 && r.log.cf.length === 1, 'when Moonshot fails the call falls back to Cloudflare');
  r = await run((env) => mod.chat(env, 'extract.snag', { messages: msgs }), { cf: new Error('model unavailable') });
  check(r.out.content === null && r.out.via === null && /model unavailable/.test(r.out.why), 'when no model answers the reason is given');
  // the switch: MODEL_ROUTES moves a route
  const sw = mod.resolveRoute({ MODEL_ROUTES: JSON.stringify({ '*': 'deepseek' }) }, 'extract.snag');
  check(sw.primary === 'deepseek', 'the one switch (MODEL_ROUTES) moves routes');
  // the real ai.ts functions go through it: the answer keeps its shape, the retired model is not asked
  r = await run((env) => ai.classifyExpenseCategory(env, 'Diesel for the bakkie'), { cf: 'fuel' });
  check(r.out === 'fuel' && r.log.cf.length === 1 && r.log.cf[0].model !== '@cf/moonshotai/kimi-k2.6', 'ai.ts classifyExpenseCategory is answered through the router');
  r = await run((env) => ai.extractStockUsage(env, 'Used 3 sheets', [{ name: 'Plywood 18mm', unit: 'sheet' }]), { key: 'k', cf: JSON.stringify({ matched_item_name: 'Plywood 18mm', quantity_used: 3, job_customer_name: null }) });
  check(r.out.matched_item_name === 'Plywood 18mm' && r.log.moon.length === 0, 'ai.ts extractStockUsage (a records route) never reaches Moonshot');
  // no file but the router names a chat model or Moonshot (the front door has its own path)
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.ts') ? [path.join(dir, e.name)] : []));
  const NAMES = /@cf\/(moonshotai|deepseek-ai|zai-org|qwen|google|meta|nvidia)\/|api\.moonshot\.ai/;
  const offenders = walk(srcDir).filter((f) => NAMES.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(srcDir, f)).filter((f) => !['model-routes.ts', 'converse-moonshot.ts'].includes(f));
  check(offenders.length === 0, `no file but the router names a chat model (${offenders.join(', ')})`);
}
