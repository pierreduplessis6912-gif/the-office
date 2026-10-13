// The model probe (worker/src/trial.ts, GET /debug/trial-ai): it pads the prompt to a chosen size and can send Cloudflare's session-affinity header, to MEASURE what prompt size and prompt caching do to latency
// before anything in the application is changed. It must build a prompt that is cacheable (identical, padding first), send the header only when asked, and pass the usage figures through.
module.exports = async function runTrialTests(context) {
  const standIn = global.Response;
  if (global.__RealResponse) global.Response = global.__RealResponse;
  try { await trialTests(context); } finally { global.Response = standIn; }
};

async function trialTests({ check, srcDir }) {
  const path = require('path'), fs = require('fs'), os = require('os'), esbuild = require('esbuild');
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tr-')), 'm.js');
  esbuild.buildSync({ entryPoints: [path.join(srcDir, 'trial.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent' });
  const { trialAi } = require(out);
  const calls = [];
  const env = { AI: { run: async (model, input, options) => { calls.push({ model, input, options }); return { usage: { prompt_tokens: 10, completion_tokens: 1, cached: calls.length > 1 ? 5 : 0 } }; } } };
  const ask = async (query) => { calls.length = 0; const res = await trialAi(env, new URL('https://x/debug/trial-ai?' + query)); return { res, body: await res.json() }; };

  const plain = await ask('n=3');
  check(plain.body.callsMs.length === 3 && calls.length === 3 && calls.every((c) => c.model === '@cf/moonshotai/kimi-k2.6' && c.input.chat_template_kwargs.thinking === false && c.input.max_tokens === 5 && c.options === undefined), 'with no options the probe makes the application\'s own call (Kimi, thinking off, a five-token answer) and sends no extra headers');
  const padded = await ask('n=4&chars=2000&salt=cold-1');
  const systems = calls.map((c) => c.input.messages[0].content);
  check(systems.every((s) => s === systems[0]) && systems[0].startsWith('[cold-1] The Office keeps') && systems[0].length >= 2000 && systems[0].length <= 2030 && systems[0].endsWith('Answer with one word.'), 'the padding is at the START of the instructions, identical on every call (prompt caching matches the exact token sequence from the start), begins with the salt that makes the prefix cold, and is about the size asked for');
  const sized = await ask('n=1&chars=40000');
  check(calls[0].input.messages[0].content.length >= 40000 && sized.body.promptPaddingChars === 40000, 'a 40,000-character prompt (the size of the application\'s biggest) can be measured');
  const affine = await ask('n=2&chars=500&affinity=ses_abc-1');
  check(calls.every((c) => c.options && c.options.extraHeaders['x-session-affinity'] === 'ses_abc-1') && affine.body.affinity === 'ses_abc-1', 'the affinity header is sent on every call when asked for (through the binding\'s extraHeaders)');
  const hostile = await ask('n=1&affinity=' + encodeURIComponent('a b/../c;d') + '&salt=' + encodeURIComponent('x y!z'));
  check(calls[0].options.extraHeaders['x-session-affinity'] === 'abcd' && !/[^\w-]/.test(hostile.body.salt), 'the affinity and the salt are reduced to plain word characters (nothing odd reaches a header or a prompt)');
  check(plain.body.usage.length === 3 && plain.body.usage[1].cached === 5, 'the usage figures the model reports (where cached tokens appear) are passed through for every call');
  const huge = await ask('n=99&chars=999999');
  check(huge.body.calls === 10 && calls.length === 10 && calls[0].input.messages[0].content.length <= 60030, 'the number of calls and the size are bounded (10 calls, 60,000 characters)');
  const forwarded = [];
  const objectEnv = { TRIAL: { idFromName: (n) => n, get: (id, opts) => ({ fetch: async (u) => { forwarded.push({ id, opts, u: String(u) }); return Response.json({ callsMs: [5, 6], usage: [null, null] }); } }) } };
  const viaObject = await (await trialAi(objectEnv, new URL('https://x/debug/trial-ai?where=object&n=2&chars=300&affinity=s1&salt=k'))).json();
  check(forwarded[0].opts.locationHint === 'weur' && /n=2/.test(forwarded[0].u) && /chars=300/.test(forwarded[0].u) && /affinity=s1/.test(forwarded[0].u) && /salt=k/.test(forwarded[0].u) && viaObject.where === 'object' && viaObject.medianMs === 6, 'asked of the London object, the size, the affinity and the salt are all forwarded to it');
  const bad = await trialAi(objectEnv, new URL('https://x/debug/trial-ai?where=object&hint=mars'));
  check(bad.status === 400, 'an invalid placement hint is refused');
}
