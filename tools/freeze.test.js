// The read-only freeze (worker/src/freeze.ts), for the final copy of a migration. While READ_ONLY is "1" anything that would CHANGE data is refused with a clear 503; reads, the admin routes (the migration
// itself needs them) and sign-in carry on; and it is off unless the variable is exactly "1".
module.exports = async function runFreezeTests(context) {
  const standIn = global.Response;
  if (global.__RealResponse) global.Response = global.__RealResponse;
  try { await freezeTests(context); } finally { global.Response = standIn; }
};

async function freezeTests({ check, srcDir }) {
  const path = require('path'), fs = require('fs'), os = require('os'), esbuild = require('esbuild');
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fz-')), 'm.js');
  esbuild.buildSync({ entryPoints: [path.join(srcDir, 'freeze.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent' });
  const { readOnlyRefusal } = require(out);
  const frozen = { READ_ONLY: '1' };
  const ask = (method, p, env = frozen) => readOnlyRefusal(new Request('https://office.example' + p, { method }), env);
  const writes = [['POST', '/messages/text'], ['POST', '/files/customers-csv-import'], ['PUT', '/customers/1'], ['PATCH', '/customers/1'], ['DELETE', '/customers/1'], ['POST', '/actions/3/confirm'], ['POST', '/business-profile/logo']];
  const refused = writes.map(([m, p]) => ask(m, p));
  check(refused.every((r) => r && r.status === 503) && refused.every((r) => r.headers.get('Retry-After') === '120'), 'while frozen, every request that would change something (voice and text messages, imports, confirmations, edits, deletes, uploads) is refused with a 503 and a Retry-After');
  const body = await refused[0].json();
  check(body.readOnly === true && /read-only for a few minutes/.test(body.error) && body.retryAfterSeconds === 120, 'the refusal says plainly why, in words the app can show');
  check([['GET', '/customers'], ['GET', '/health'], ['HEAD', '/customers'], ['OPTIONS', '/messages/text']].every(([m, p]) => ask(m, p) === null), 'reading carries on: GET, HEAD and OPTIONS are never refused');
  check([['POST', '/admin/migration/rows'], ['POST', '/debug/directory/add-member'], ['POST', '/debug/init-indexes']].every(([m, p]) => ask(m, p) === null), 'the admin and debug routes are NOT frozen: the migration itself needs them, and they are behind the admin keys');
  check([['POST', '/auth/logout'], ['GET', '/auth/google/callback']].every(([m, p]) => ask(m, p) === null), 'signing out and in are not frozen');
  check(writes.every(([m, p]) => ask(m, p, {}) === null && ask(m, p, { READ_ONLY: '0' }) === null && ask(m, p, { READ_ONLY: 'true' }) === null && ask(m, p, { READ_ONLY: '' }) === null), 'it is OFF unless the variable is exactly "1" (unset, "0", "true" and empty all leave everything working)');
  const index = fs.readFileSync(path.join(srcDir, 'index.ts'), 'utf8');
  const handle = index.slice(index.indexOf('async function handleRequest('));
  check(/handleRequest\([^)]*\)[^{]*\{\s*(\/\/[^\n]*\n\s*)*const frozen = readOnlyRefusal\(request, env\);\s*if \(frozen\) return frozen;/.test(handle), 'the freeze is the FIRST thing the application\'s pipeline does, so nothing can change data before it is checked');
  const wrangler = path.join(srcDir, '..', 'wrangler.toml');
  if (fs.existsSync(wrangler)) check(!/^READ_ONLY\s*=/m.test(fs.readFileSync(wrangler, 'utf8')), 'production does NOT leave the read-only freeze switched on (it is for the final copy of a migration only)');
}
