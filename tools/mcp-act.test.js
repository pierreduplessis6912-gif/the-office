// How an assistant's confirm or reject reaches the app's route (worker/src/mcp-act.ts): as the member the key belongs to, with a ONE-MINUTE session made inside the Worker and never shown to anyone, on exactly the confirm or reject path of the id asked for, and nothing else.
const path = require('path'), fs = require('fs'), os = require('os'), esbuild = require('esbuild');

module.exports = async function runMcpActTests({ check, srcDir }) {
  const bundle = (entry) => { const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mk-')), 'm.js'); esbuild.buildSync({ entryPoints: [path.join(srcDir, entry)], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent' }); return require(out); };
  let act, auth;
  try { act = bundle('mcp-act.ts'); auth = bundle('auth.ts'); } catch (e) { check(false, 'mcp-act.ts builds: ' + String(e.message).split('\n')[0].slice(0, 160)); return; }
  const env = { SESSION_SECRET: 'test-secret-for-sessions', BUSINESS_ID: 'acme-co' };
  const serveFor = (reply) => { const seen = []; return { seen, serve: async (request) => { seen.push({ method: request.method, url: request.url, auth: request.headers.get('Authorization'), body: await request.text() }); return reply(request); } }; };
  const decode = (token) => JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString());

  { const s = serveFor(() => Response.json({ status: 'confirmed' })); const before = Date.now(); const r = await act.actThroughApp(env, s.serve, 'https://office.test/mcp?x=1', 'confirm', 41, { email: 'pierre@example.com' }); const call = s.seen[0], token = call.auth.replace('Bearer ', ''), p = decode(token);
    check(r.status === 200 && r.body.status === 'confirmed' && s.seen.length === 1 && call.method === 'POST' && call.url === 'https://office.test/actions/41/confirm' && call.body === '{}' && p.email === 'pierre@example.com' && p.b === 'acme-co' && p.exp - before <= 61000 && p.exp - before > 0, 'it makes ONE request, a POST to exactly /actions/<id>/confirm on the same origin (the path and query of the original are dropped), as the member, with a session that ends within a minute and is for this business');
    const verified = await auth.verifySession({ ...env, BUSINESS_MODE: 'object' }, token), other = await auth.verifySession({ ...env, SESSION_SECRET: 'another-secret' }, token);
    check(verified && verified.email === 'pierre@example.com' && other === null, 'the session is a real session for that member, and no other deployment accepts it'); }
  { const s = serveFor(() => Response.json({ status: 'rejected' })); await act.actThroughApp(env, s.serve, 'https://office.test/mcp', 'reject', 7, { email: 'pierre@example.com' });
    check(s.seen[0].url === 'https://office.test/actions/7/reject', 'a reject asks for the reject path'); }
  { const s = serveFor(() => Response.json({ error: 'action already confirmed' }, { status: 409 })); const r = await act.actThroughApp(env, s.serve, 'https://office.test/mcp', 'confirm', 3, { email: 'o@x.co' }), t = serveFor(() => new Response('<html>oops</html>', { status: 502 })), r2 = await act.actThroughApp(env, t.serve, 'https://office.test/mcp', 'confirm', 3, { email: 'o@x.co' });
    check(r.status === 409 && r.body.error === 'action already confirmed' && r2.status === 502 && r2.body === null, 'the app\'s own answer is passed back as it is (status and reason); an answer that is not JSON comes back with no body, never an error'); }
  { const s = serveFor(() => Response.json({})); const bad = []; for (const id of [0, -1, 1.5, NaN, Infinity, '3', null, undefined, {}, [1]]) bad.push(await act.actThroughApp(env, s.serve, 'https://office.test/mcp', 'confirm', id, { email: 'o@x.co' }));
    check(bad.every((x) => x.status === 400) && s.seen.length === 0, 'a bad action id (zero, negative, fraction, not a number) makes no request at all'); }
};
