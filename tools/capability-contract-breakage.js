// Deliberate-breakage proof for the capability contract (HANDOVER rule 8: security-sensitive code). A test that cannot fail proves nothing, so every enforcement point is removed or
// weakened IN TURN, in a fresh process each time (a module cache would otherwise reuse the first build), and tools/capability-contract.test.js must then FAIL. A mutation the suite does
// not catch is a hole in the tests and fails this script. Every file is restored in a finally block and again on exit: a killed run once left a mutated module behind.
// Run: NODE_PATH=worker/node_modules node tools/capability-contract-breakage.js   (about 40 seconds). It runs the suite on the Durable Object adapter, the one with transactions.
const fs = require('fs'), path = require('path'), { spawnSync } = require('child_process');
const root = path.join(__dirname, '..');
const CONTRACT = 'worker/src/capability-contract.ts', VISIT = 'worker/src/capabilities/log-visit.ts', INDEX = 'worker/src/index.ts';

const MUTATIONS = [
  { name: 'confirm: drop the contract\'s own permission check', file: CONTRACT, find: 'if (!contract.requires.every((c) => member.caps.includes(c)))', replace: 'if (false)' },
  { name: 'confirm: drop the availability check', file: CONTRACT, find: 'if (!isAvailable(env, contract.id)) return refusal(409', replace: 'if (false) return refusal(409' },
  { name: 'confirm: drop the payload check', file: CONTRACT, find: 'if (!checked.ok) return refusal(422, "invalid_payload", checked.reason);', replace: 'if (false) return refusal(422, "invalid_payload", checked.reason);' },
  { name: 'confirm: execute without a transaction', file: CONTRACT, find: 'const outcome = await atomically(env, async (tx) => {', replace: 'const outcome = await ((e: Env, body: (x: Env) => Promise<Record<string, unknown>>) => body(e))(env, async (tx) => {' },
  { name: 'door: drop the availability check', file: CONTRACT, find: 'if (!isAvailable(env, contract.id)) return { status: "refused", code: "capability_unavailable"', replace: 'if (false) return { status: "refused", code: "capability_unavailable"' },
  { name: 'door: drop the payload check', file: CONTRACT, find: 'if (!checked.ok) return { status: "refused", code: "invalid_payload"', replace: 'if (false) return { status: "refused", code: "invalid_payload"' },
  { name: 'door: do not capture the request first', file: CONTRACT, find: 'await logCapture(env, request.transcript, request.source || "text");', replace: '/* mutation: no capture */' },
  { name: 'availability: no configuration means available', file: CONTRACT, find: 'if (typeof e.BUSINESS_ID !== "string" || !e.CAPABILITY_CONFIG) return false;', replace: 'if (typeof e.BUSINESS_ID !== "string" || !e.CAPABILITY_CONFIG) return true;' },
  { name: 'availability: a business with no entry means available', file: CONTRACT, find: 'return Array.isArray(entry?.available) && (entry!.available as unknown[]).includes(id);', replace: 'return !entry || (Array.isArray(entry?.available) && (entry!.available as unknown[]).includes(id));' },
  { name: 'availability: depends on currency', file: CONTRACT, find: 'return Array.isArray(entry?.available) && (entry!.available as unknown[]).includes(id);', replace: 'return Array.isArray(entry?.available) && (entry!.available as unknown[]).includes(id) && (entry as any).currency === "ZAR";' },
  { name: 'payload: allow a day and a half of minutes', file: VISIT, find: 'p.minutes > 1440', replace: 'p.minutes > 100000' },
  { name: 'payload: allow fields nobody declared', file: VISIT, find: 'if (stray !== undefined)', replace: 'if (false)' },
  { name: 'route: remove the hook (the old unknown-type path)', file: INDEX, find: 'const contract = contractForHeldType(action.type);', replace: 'const contract = null as ReturnType<typeof contractForHeldType>;' },
  { name: 'route: do not put the claim back after a refusal', file: INDEX, find: 'if (decided.status !== 200) await env.OFFICE_DB.prepare("UPDATE pending_actions SET status = \'pending\' WHERE id = ?").bind(id).run();', replace: '/* mutation: claim left in place */' },
];

const originals = new Map();
const restoreAll = () => { for (const [f, text] of originals) fs.writeFileSync(path.join(root, f), text); };
process.on('exit', restoreAll);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { restoreAll(); process.exit(130); });

const runSuite = () => {
  const r = spawnSync(process.execPath, ['--no-warnings', path.join(__dirname, 'capability-contract.test.js')], {
    env: { ...process.env, NODE_PATH: path.join(root, 'worker', 'node_modules'), HARNESS_BACKEND: 'do', HARNESS_INDEXES: '1' }, encoding: 'utf8', timeout: 120000,
  });
  const out = r.stdout || '';
  const m = /(\d+)\/(\d+) correct, (\d+) failing/.exec(out);
  return { exit: r.status, failing: m ? Number(m[3]) : null, total: m ? Number(m[2]) : null, crashed: !m, first: (out.split('\n').find((l) => l.startsWith('FAIL')) || '').slice(0, 130) };
};

let bad = 0;
const base = runSuite();
console.log(`unmutated: ${base.crashed ? 'CRASHED' : base.total - base.failing + '/' + base.total + ' correct'}`);
if (base.crashed || base.failing !== 0) { console.log('the unmutated suite must be green before a mutation means anything'); process.exit(1); }

for (const [i, m] of MUTATIONS.entries()) {
  const full = path.join(root, m.file);
  if (!originals.has(m.file)) originals.set(m.file, fs.readFileSync(full, 'utf8'));
  const text = originals.get(m.file);
  if (text.split(m.find).length !== 2) { console.log(`${String(i + 1).padStart(2)}. ${m.name}: the text to mutate is not found exactly once (the code moved: update this script)`); bad++; continue; }
  let res;
  try { fs.writeFileSync(full, text.replace(m.find, () => m.replace)); res = runSuite(); } finally { fs.writeFileSync(full, text); }
  const caught = !res.crashed && res.failing > 0;
  if (!caught) bad++;
  console.log(`${String(i + 1).padStart(2)}. ${caught ? 'CAUGHT  ' : res.crashed ? 'CRASHED ' : 'SURVIVED'} ${m.name}${caught ? `  (${res.failing} failing; first: ${res.first})` : ''}`);
}
console.log(bad ? `\n${bad} mutation(s) not caught: the tests have a hole` : `\nall ${MUTATIONS.length} mutations caught`);
process.exit(bad ? 1 : 0);
