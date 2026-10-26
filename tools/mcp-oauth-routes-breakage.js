// Proof that the OAuth route tests are not decorative (security-sensitive: this is how an assistant obtains a key without pasting one). For each guard in worker/src/mcp-oauth-routes.ts and mcp-oauth-issue.ts it takes a COPY of the worker source, REMOVES that one guard, runs tools/mcp-endpoint.test.js against the copy, and requires at least one check to FAIL. A guard whose removal no test notices is reported and the script exits non-zero. It never touches the real source.
// Run: NODE_PATH=worker/node_modules node --no-warnings tools/mcp-oauth-routes-breakage.js
const fs = require('fs'), os = require('os'), path = require('path');
const root = path.join(__dirname, '..'), workerDir = path.join(root, 'worker');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mkx-')), copy = path.join(tmp, 'worker');
fs.cpSync(workerDir, copy, { recursive: true, filter: (src) => !src.split(path.sep).includes('node_modules') });
fs.symlinkSync(path.join(workerDir, 'node_modules'), path.join(copy, 'node_modules'));   // the real packages, read only: the copy needs them to build
const files = { routes: path.join(copy, 'src', 'mcp-oauth-routes.ts'), issue: path.join(copy, 'src', 'mcp-oauth-issue.ts'), core: path.join(copy, 'src', 'mcp-oauth.ts') };
const originals = Object.fromEntries(Object.entries(files).map(([k, f]) => [k, fs.readFileSync(f, 'utf8')]));
const run = require('./mcp-oauth-routes.test.js');
// The harness bundles the worker to a fixed file name per process and Node caches what it requires, so the cache is cleared before every run: otherwise each mutated run would silently reuse the first build and test nothing.
const clearBuildCache = () => { for (const n of ['rm-poe', 'rm-auth']) delete require.cache[path.join(os.tmpdir(), `${n}-${process.pid}.js`)]; };

const MUTATIONS = [
  ['the choice sits OUTSIDE the form, so it is never sent and every connection is read only', 'core', 'value="${esc(input.ticket)}"><p><label><input type="radio" name="access" value="read" checked>', 'value="${esc(input.ticket)}"></form><p><label><input type="radio" name="access" value="read" checked>'],
  ['create is ticked by default when the page opens', 'core', '<input type="radio" name="access" value="read" checked> <b>Read only</b></label><br><label><input type="radio" name="access" value="write">', '<input type="radio" name="access" value="read"> <b>Read only</b></label><br><label><input type="radio" name="access" value="write" checked>'],
  ['the create choice is sent under another name', 'core', 'name="access" value="write">', 'name="accessx" value="write">'],
  ['the consent page grants create whatever the owner ticked', 'routes', 'oauth.scopeFromChoice(form.get("access"))', '"mcp:write"'],
  ['the owner\'s choice of create is ignored (a connector can only ever be read only)', 'routes', 'oauth.scopeFromChoice(form.get("access"))', '"mcp:read"'],
  ['any choice text that is not exactly "write" grants create', 'core', 'export const scopeFromChoice = (choice: unknown): string => (choice === "write" ? SCOPE_CREATE : SCOPE);', 'export const scopeFromChoice = (choice: unknown): string => (typeof choice === "string" && choice.toLowerCase().includes("write") ? SCOPE_CREATE : SCOPE);'],
  ['the token step issues a create key for every code', 'core', 'const granted = c.scope === SCOPE_CREATE ? SCOPE_CREATE : SCOPE;', 'const granted = SCOPE_CREATE;'],
  ['the token step ignores the chosen scope and always issues read only', 'core', 'const granted = c.scope === SCOPE_CREATE ? SCOPE_CREATE : SCOPE;', 'const granted = SCOPE;'],
  ['the chosen scope is not carried to the business when the key is asked for', 'routes', '{ email, label, jti, scope });', '{ email, label, jti });'],
  ['the business makes a create key whatever scope it was sent', 'issue', 'scope: input.scope === "mcp:write" ? "mcp:write" : "mcp:read" });', 'scope: "mcp:write" });'],
  ['a failed authorize request is redirected to the address it named', 'routes', 'if (!parsed.ok) return page(parsed.status, notice("This assistant cannot be connected", parsed.description));', 'if (!parsed.ok) return go(url.searchParams.get("redirect_uri") ?? "/");'],
  ['a member who is not the owner reaches the consent page', 'routes', '|| who.role !== "owner")', ')'],
  ['an inactive member reaches the consent page', 'routes', '|| !who.active', ''],
  ['a sign-in that is not for an assistant is taken over (no request cookie needed)', 'routes', 'if (!raw) return null;', 'if (!raw) { /* carried on */ }'],
  ['the consent button no longer needs the nonce cookie of this browser', 'routes', '!ticket || !nonce || typeof ticket.nonce !== "string" || !(await safeEqual(nonce, ticket.nonce)) ||', '!ticket ||'],
  ['a consent form posted from another site (a foreign Origin) is accepted', 'routes', '(origin && origin !== "null" && origin !== url.origin) ||', 'false ||'],
  ['a consent form the browser says is cross-site is accepted when its Origin is null', 'routes', ' || request.headers.get("Sec-Fetch-Site") === "cross-site")', ')'],
  ['anything but a deny is treated as Allow', 'routes', 'if (form.get("decision") === "allow")', 'if (form.get("decision") !== "deny")'],
  ['the consent page can be framed by another site', 'routes', '"X-Frame-Options": "DENY", ', ''],
  ['the kill switch no longer closes the OAuth routes', 'routes', 'env.MCP !== "off" && ', ''],
  ['the OAuth routes open on a deployment with no business objects', 'routes', 'env.BUSINESS_MODE === "object" && ', ''],
  ['the OAuth routes open with no signing secret', 'routes', 'typeof env.SESSION_SECRET === "string" && env.SESSION_SECRET.length > 0', 'true'],
  ['the token answer can be cached', 'routes', '"Cache-Control": "no-store", Pragma: "no-cache"', 'Pragma: "no-cache"'],
  ['a key is issued for a member who is not the owner', 'issue', ' || !(await getRoleCapabilities(env, member.role)).includes("can_invite_members")', ''],
  ['a key is issued for a member who is no longer active', 'issue', 'member.status !== "active" ||', ''],
  ['a code can be used more than once', 'issue', 'INSERT INTO mcp_oauth_codes (jti) VALUES (?)', 'INSERT OR IGNORE INTO mcp_oauth_codes (jti) VALUES (?)'],
  ['the business issues keys with MCP switched off', 'issue', 'if (env.MCP === "off") return refuse(409, "other");', ''],
  ['a malformed one-time id is accepted', 'issue', '!JTI.test(input.jti) || ', ''],
];

(async () => {
  let missed = 0;
  const collect = () => { const list = []; return { list, check: (ok, label) => { if (!ok) list.push(label); } }; };
  const restore = () => { for (const [k, f] of Object.entries(files)) fs.writeFileSync(f, originals[k]); };
  { restore(); clearBuildCache(); const c = collect(); await run({ check: c.check, srcDir: path.join(copy, 'src') }); console.log(`baseline (nothing removed): ${c.list.length} failing checks (must be 0)`); if (c.list.length) { missed++; console.log('  ' + c.list.join('\n  ')); } }
  for (const [name, file, from, to] of MUTATIONS) {
    restore();
    if (!originals[file].includes(from)) { console.log(`NOT APPLIED  ${name}: the text to remove was not found in ${file}.ts (update this script)`); missed++; continue; }
    fs.writeFileSync(files[file], originals[file].replace(from, to));
    const c = collect(); clearBuildCache();
    try { await run({ check: c.check, srcDir: path.join(copy, 'src') }); } catch (e) { c.list.push('threw: ' + String(e.message).slice(0, 100)); }
    if (c.list.length === 0) { missed++; console.log(`NOT CAUGHT   ${name}`); } else console.log(`caught (${String(c.list.length).padStart(2)})  ${name}`);
  }
  restore();
  console.log(missed === 0 ? `\nall ${MUTATIONS.length} OAuth route guards are held by a test that fails when the guard is removed` : `\n${missed} problem(s): see above`);
  process.exit(missed === 0 ? 0 : 1);
})();
