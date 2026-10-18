// Route policy: what every non-admin route lets each kind of caller do, observed by running the REAL auth gate (SHIP_CHECKLIST.md item 4).
// Used by the generator (route-policy-gen.js, which writes route-policy.json and ROUTE_POLICY.md) and by the test (route-policy.test.js, which fails when the real
// gate's behaviour differs from the committed file, and when a route exists that is not in it). Admin routes are not here: they have tiers (admin-routes.ts).
const path = require('path'), fs = require('fs'), os = require('os'), esbuild = require('esbuild');

function extractRoutes(srcDir) {
  const idx = fs.readFileSync(path.join(srcDir, 'index.ts'), 'utf8'), dbg = fs.readFileSync(path.join(srcDir, 'debug.ts'), 'utf8'), au = fs.readFileSync(path.join(srcDir, 'auth.ts'), 'utf8');
  const out = new Map();
  const add = (method, pattern, concrete, how) => out.set(`${method} ${pattern}`, { method, pattern, concrete, how });
  const h = idx.indexOf('async function handleRequest(');
  for (const line of idx.slice(h).split('\n')) {
    let m = line.match(/url\.pathname === "(\/[^"]*)"(?: && request\.method === "(\w+)")?/);
    if (m && !/^\/(debug|admin)\//.test(m[1])) { for (const meth of (m[2] ? [m[2]] : ['GET', 'POST'])) add(meth, m[1], m[1], m[2] ? 'exact path' : 'exact path, any method'); continue; }
    m = line.match(/url\.pathname\.match\(\/\^(.+?)\$\/\) && request\.method === "(\w+)"/);
    if (m) {
      const pattern = m[1].replace(/\\\//g, '/').replace(/\\d\+/g, ':id');
      if (/^\/(debug|admin)\//.test(pattern)) continue;   // an admin route with an id: it has a tier (admin-routes.ts)
      add(m[2], pattern, pattern.replace(/:id/g, '1'), 'id in path');
    }
    if (/url\.pathname\.startsWith\("\/files"\)/.test(line)) { add('GET', '/files/*', '/files/example', 'any path under /files'); add('POST', '/files/*', '/files/example', 'any path under /files'); }
  }
  for (const p of au.match(/const PUBLIC_ROUTES = new Set\(\[([\s\S]*?)\]\);/)[1].match(/"([^"]+)"/g).map((s) => s.slice(1, -1))) add('GET', p, p, 'public list');
  for (const p of au.match(/const APP_DEBUG_ROUTES = new Set\(\[([\s\S]*?)\]\);/)[1].match(/"([^"]+)"/g).map((s) => s.slice(1, -1))) {
    const m = dbg.match(new RegExp('pathname === "' + p.replace(/\//g, '\\/') + '"(?: && request\\.method === "(\\w+)")?'));
    add(m && m[1] ? m[1] : 'GET', p, p, 'app screen (debug path)');
  }
  return [...out.values()];
}

// The three action types used to show how confirming or rejecting depends on WHAT is being confirmed (a money action, a stock action, a job action).
const ACTION_TYPES = [{ id: 1, type: 'invoice' }, { id: 2, type: 'stock_add' }, { id: 3, type: 'job_scope_amendment' }];

// The callers every route is probed as: nobody, and each role. The owner is always first.
const ROLES = ['owner', 'accountant', 'installer', 'sales', 'admin'];

function classify(row) {
  const { none, owner } = row;
  const others = ROLES.filter((r) => r !== 'owner').map((r) => row[r]);
  if (none === 'A') return 'public';
  if ([none, owner, ...others].every((v) => v === 403) && /\/pdf$/.test(row.pattern)) return 'signed link';
  if (owner === 'A' && others.every((v) => v === 'A')) return 'any member';
  if (owner === 'A' && others.every((v) => v !== 'A')) return 'owner only';
  if (owner === 'A') return 'some roles';
  return 'unexpected';
}

async function observe(srcDir, workerDir) {
  const bundle = (entry, name) => { const out = path.join(os.tmpdir(), name); esbuild.buildSync({ entryPoints: [path.join(srcDir, entry)], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent' }); return require(out); };
  const auth = bundle('auth.ts', 'policy-auth.js');
  const { newDatabase, d1 } = require('./harness.js');
  const db = newDatabase(workerDir);
  const env = { OFFICE_DB: d1(db), ADMIN_KEY: 'k', SESSION_SECRET: 'policy-secret' };
  for (const role of ROLES) db.prepare("INSERT INTO memberships (google_email, role, status) VALUES (?, ?, 'active')").run(`${role}@example.com`, role);
  for (const a of ACTION_TYPES) db.prepare("INSERT INTO pending_actions (id, type, payload, source_transcript, status) VALUES (?, ?, '{}', 'x', 'pending')").run(a.id, a.type);
  const sess = {}; for (const role of ROLES) sess[role] = await auth.signSession(env, `${role}@example.com`);
  const base = extractRoutes(srcDir);
  const targets = [];
  for (const r of base) {
    if (/^\/actions\/:id\/(confirm|reject|edit-field)$/.test(r.pattern)) for (const a of ACTION_TYPES) targets.push({ ...r, label: `${r.method} ${r.pattern} [${a.type}]`, concrete: r.concrete.replace('/1/', `/${a.id}/`) });
    else targets.push({ ...r, label: `${r.method} ${r.pattern}` });
  }
  const rows = [];
  for (const r of targets.sort((a, b) => a.label.localeCompare(b.label))) {
    const row = { route: r.label, pattern: r.pattern, how: r.how };
    for (const who of ['none', ...ROLES]) {
      const url = new URL('https://office.example' + r.concrete);
      const headers = who === 'none' ? {} : { cookie: `office_session=${sess[who]}` };
      const res = await auth.authGate(new Request(url, { method: r.method, headers }), env, url);
      row[who] = res === null ? 'A' : res.status;
    }
    row.class = classify(row);
    rows.push(row);
  }
  return rows;
}

const word = (v) => (v === 'A' ? 'yes' : v === 401 ? 'no (sign in)' : 'no');
function toMarkdown(rows) {
  const counts = rows.reduce((m, r) => ((m[r.class] = (m[r.class] || 0) + 1), m), {});
  let md = '# Route policy: who can call what\n\n';
  md += 'Generated by `node tools/route-policy-gen.js` from the **real** authentication gate, and checked on every build: the build fails if the gate behaves differently from this file, or if a route exists that is not in it. Do not edit by hand. To change who can do something, change the code, run the generator, and review the diff in this file.\n\n';
  md += 'Shown for the **default** role permissions; the owner can change them in Settings, which changes what an accountant or installer may do. Admin routes are not listed here: they have their own tiers (`worker/src/admin-routes.ts`) and need the admin key.\n\n';
  md += 'Classes: ' + Object.entries(counts).map(([k, v]) => `**${k}** ${v}`).join(', ') + '. A **signed link** route is opened only by a link the business sent (it carries its own signature), so it is refused to everyone who simply asks.\n\n';
  md += '| Route | Class | No login | Owner | Accountant | Installer | Sales | Admin |\n|---|---|---|---|---|---|---|---|\n';
  for (const r of rows) md += `| \`${r.route}\` | ${r.class} | ${word(r.none)} | ${word(r.owner)} | ${word(r.accountant)} | ${word(r.installer)} | ${word(r.sales)} | ${word(r.admin)} |\n`;
  return md;
}

module.exports = { extractRoutes, observe, toMarkdown, classify, ACTION_TYPES, ROLES };
