// Deliberate-breakage proof for the engine (HANDOVER rule 8: security- and money-sensitive code; branch engine-phase1). A test that cannot fail proves nothing, so each guarantee is removed or weakened IN TURN, in a
// fresh process each time, and the suite responsible for it must then FAIL. A mutation no suite catches is a hole in the tests and fails this script. Every file is restored in a finally block and again on exit.
// Run: NODE_PATH=worker/node_modules node tools/engine-breakage.js   (several minutes: it runs the responsible suite once per mutation, on the Durable Object adapter).
const fs = require('fs'), path = require('path'), { spawnSync } = require('child_process');
const root = path.join(__dirname, '..');
const E = (f) => `worker/src/engine/${f}`, CONTRACT = 'worker/src/capability-contract.ts', MIG = 'worker/migrations/0004_engine_foundation.sql';
const OBJ = 'business-object.standalone.js', ISOL = 'engine-isolation.test.js', OWN = 'engine-ownership.test.js', INTEG = 'engine-integrity.test.js', ADDCOL = 'restore-added-column.test.js', ADMIN = 'engine-admin.test.js', LEDGER = 'engine-ledger.test.js', OPS = 'engine-operations.test.js', BOUNDARY = 'engine-boundary.test.js', SCHEMA = 'engine-schema.test.js';

const MUTATIONS = [
  // money: exact integer arithmetic
  { name: 'money: round down instead of half up', suite: LEDGER, file: E('money.ts'), find: 'return (numerator * BigInt(2) + denominator) / (denominator * BigInt(2));', replace: 'return numerator / denominator;' },
  { name: 'money: accept a fractional amount', suite: LEDGER, file: E('money.ts'), find: 'typeof value !== "number" || !Number.isSafeInteger(value) || value < min', replace: 'typeof value !== "number" || !Number.isFinite(value) || value < min' },
  { name: 'money: round an amount that cannot be held exactly', suite: LEDGER, file: E('money.ts'), find: 'if (value > MAX) throw new EngineError("amount_out_of_range"', replace: 'if (false) throw new EngineError("amount_out_of_range"' },
  // facts: conservation, currency, corrections, atomicity, numbering
  { name: 'allocate: allow more than the payment has left', suite: LEDGER, file: E('facts.ts'), find: 'if (amountMinor > (await unallocatedForMovement(tx, movementId))) throw new EngineError("over_allocated"', replace: 'if (false) throw new EngineError("over_allocated"' },
  { name: 'allocate: allow more than the document owes', suite: LEDGER, file: E('facts.ts'), find: 'if (amountMinor > (await outstandingForDocument(tx, documentId))) throw new EngineError("over_allocated"', replace: 'if (false) throw new EngineError("over_allocated"' },
  { name: 'allocate: allow a payment in another currency', suite: LEDGER, file: E('facts.ts'), find: 'if (mv.currency !== dc.currency) throw new EngineError("currency_mismatch"', replace: 'if (false) throw new EngineError("currency_mismatch"' },
  { name: 'reverse: allow a document that still has payments allocated', suite: LEDGER, file: E('facts.ts'), find: 'if (Number(live?.n ?? 0) > 0) throw new EngineError("has_dependents"', replace: 'if (false) throw new EngineError("has_dependents"' },
  { name: 'reverse: allow reversing a payment twice', suite: LEDGER, file: E('facts.ts'), find: 'if (await alreadyReversed("movement_id", movementId)) throw new EngineError("already_reversed"', replace: 'if (false) throw new EngineError("already_reversed"' },
  { name: 'facts: run operations without a transaction', suite: LEDGER, file: E('facts.ts'), find: '  return atomically(env, body);\n}\n\nfunction text', replace: '  return body(env);\n}\n\nfunction text' },
  { name: 'facts: skip a number in the sequence', suite: LEDGER, file: E('facts.ts'), find: 'SELECT COALESCE(MAX(number), 0) + 1 AS n FROM eng_document_number', replace: 'SELECT COALESCE(MAX(number), 0) + 2 AS n FROM eng_document_number' },
  // ledger: what is effective
  { name: 'ledger: a reversed payment\'s allocations still count', suite: LEDGER, file: E('ledger.ts'), find: "       AND NOT EXISTS (SELECT 1 FROM eng_reversal r WHERE r.movement_id = a.movement_id)`, documentId);", replace: "       `, documentId);" },
  // integrity: tamper evidence
  { name: 'integrity: do not compare a payment with its snapshot', suite: LEDGER, file: E('integrity.ts'), find: 'if (!s || !same([s.direction, s.partyId, s.amountMinor, s.currency, s.occurredOn, s.method ?? null], [m.direction, m.party_id, m.amount_minor, m.currency, m.occurred_on, m.method]))', replace: 'if (false)' },
  { name: 'integrity: do not report an over-allocated payment', suite: LEDGER, file: E('integrity.ts'), find: 'if (Number(m.used) > m.amount_minor) problems.push({ code: "over_allocated"', replace: 'if (false) problems.push({ code: "over_allocated"' },
  { name: 'integrity: do not report an allocation still counted on a reversed payment', suite: LEDGER, file: E('integrity.ts'), find: 'problems.push({ code: "allocation_on_reversed"', replace: 'void ({ code: "allocation_on_reversed"' },
  // boundary
  { name: 'boundary: never refuse a legacy write in an engine business', suite: BOUNDARY, file: E('boundary.ts'), find: 'return engine ? refuse(409, "engine_mode"', replace: 'return false ? refuse(409, "engine_mode"' },
  { name: 'boundary: leave /messages/text unclassified', suite: BOUNDARY, file: E('boundary.ts'), find: '  ["POST", /^\\/messages\\/text$/, "business_write"],                  // conversation into the legacy pipeline\n', replace: '' },
  { name: 'boundary: let a held action of the other kind through', suite: BOUNDARY, file: E('boundary.ts'), find: 'if (isEngineAction === engine) return null;', replace: 'return null;' },
  { name: 'boundary: every business is an engine business', suite: BOUNDARY, file: E('boundary.ts'), find: "return row?.value_json === '\"engine\"';", replace: 'return true;' },
  // operations
  { name: 'door: drop the member\'s permission check', suite: OPS, file: CONTRACT, find: 'if (request.member && !memberMayUse(contract, request.member))', replace: 'if (false)' },
  { name: 'confirm: drop the check that runs inside the transaction (staleness)', suite: OPS, file: CONTRACT, find: '    if (contract.check) await contract.check(tx, checked.value);', replace: '    /* mutation: no check at confirm */' },
  { name: 'confirm: do not record the one execution per proposal', suite: OPS, file: CONTRACT, find: 'if (contract.recordsExecution) await tx.OFFICE_DB.prepare(', replace: 'if (false) await tx.OFFICE_DB.prepare(' },
  { name: 'payment.record: ignore that the account changed', suite: OPS, file: E('capabilities.ts'), find: 'if (value.basedOn && (await versionOf(env, { kind: "party", id: value.partyId })) !== value.basedOn.partyVersion)', replace: 'if (false)' },
  { name: 'records: show a record to a member who may not see it', suite: OPS, file: E('records.ts'), find: '  if (!viewer.perms.has("receivables.read")) return null;\n', replace: '' },
  { name: 'permissions: the invoices capability no longer grants recording payments', suite: OPS, file: E('permissions.ts'), find: 'can_manage_invoices: ["payment.record", "payment.correct", "invoice.issue", "drafts.edit"],', replace: 'can_manage_invoices: ["payment.correct", "invoice.issue", "drafts.edit"],' },
  // integrity, Task 2: each new check has an invariant behind it, and removing it must make the integrity suite fail
  { name: 'integrity: an event whose fact was deleted is not reported', suite: INTEG, file: E('integrity.ts'), find: 'if (n === 0) problems.push({ code: "event_without_fact"', replace: 'if (false) problems.push({ code: "event_without_fact"' },
  { name: 'integrity: two facts for one event are not reported', suite: INTEG, file: E('integrity.ts'), find: 'else if (n > 1) problems.push({ code: "event_multiple_facts"', replace: 'else if (false) problems.push({ code: "event_multiple_facts"' },
  { name: 'integrity: a fact with the wrong kind of event is not reported', suite: INTEG, file: E('integrity.ts'), find: 'if (!expected.includes(ev.type)) {', replace: 'if (false) {' },
  { name: 'integrity: a fact whose event does not exist is not reported', suite: INTEG, file: E('integrity.ts'), find: 'problems.push({ code: "fact_wrong_event", detail: `${kind} ${id} points at event ${eventId}, which does not exist` }); return null;', replace: 'return null;' },
  { name: 'integrity: a payment direction is no longer tied to its event type', suite: INTEG, file: E('integrity.ts'), find: '[m.direction === "in" ? "payment.recorded" : "payment.made"]', replace: '["payment.recorded", "payment.made"]' },
  { name: 'integrity: a party is no longer compared with its snapshot', suite: INTEG, file: E('integrity.ts'), find: 'if (!s || !same([s.kind, s.name], [p.kind, p.name]))', replace: 'if (false)' },
  { name: 'integrity: a party\'s roles are no longer compared', suite: INTEG, file: E('integrity.ts'), find: 'if (recorded === null || !same(recorded, actual))', replace: 'if (false)' },
  { name: 'integrity: a role carried by another party\'s event is not reported', suite: INTEG, file: E('integrity.ts'), find: 'if (!parties.some((p) => p.id === r.party_id && p.event_id === r.event_id))', replace: 'if (false)' },
  { name: 'integrity: an allocation is no longer compared with its snapshot', suite: INTEG, file: E('integrity.ts'), find: 'if (!s || !same([s.movementId, s.documentId, s.amountMinor], [a.movement_id, a.document_id, a.amount_minor]))', replace: 'if (false)' },
  { name: 'integrity: a document is no longer compared with its snapshot at all', suite: INTEG, file: E('integrity.ts'), find: 'if (!s || !same([s.kind, s.direction, s.partyId, s.currency, s.issuedOn, s.reference ?? null,', replace: 'if (false && !same([s.kind, s.direction, s.partyId, s.currency, s.issuedOn, s.reference ?? null,' },
  { name: 'integrity: a document\'s reference is no longer compared', suite: INTEG, file: E('integrity.ts'), find: 's.issuedOn, s.reference ?? null, s.lines, s.totals], [d.kind, d.direction, d.party_id, d.currency, d.issued_on, d.reference ?? null, asRecorded, totals]', replace: 's.issuedOn, s.lines, s.totals], [d.kind, d.direction, d.party_id, d.currency, d.issued_on, asRecorded, totals]' },
  { name: 'integrity: a reversal row is no longer compared with its event', suite: INTEG, file: E('integrity.ts'), find: 'if (!matches) problems.push({ code: "reversal_mismatch"', replace: 'if (false) problems.push({ code: "reversal_mismatch"' },
  { name: 'integrity: a malformed event payload is not reported', suite: INTEG, file: E('integrity.ts'), find: 'if (payload === null) problems.push({ code: "event_payload_malformed"', replace: 'if (false) problems.push({ code: "event_payload_malformed"' },
  { name: 'integrity: an unmodelled event type is no longer warned about', suite: INTEG, file: E('integrity.ts'), find: 'if (!(e.type in EVENT_MODEL)) warnings.push(', replace: 'if (false) warnings.push(' },
  { name: 'integrity: a DOCUMENT over-allocation is not reported', suite: INTEG, file: E('integrity.ts'), find: 'if (Number(row[0]?.reversed ?? 0) === 0 && Number(row[0]?.n ?? 0) > gross) problems.push({ code: "over_allocated"', replace: 'if (false) problems.push({ code: "over_allocated"' },
  { name: 'integrity: foreign-key orphans are not reported', suite: INTEG, file: E('integrity.ts'), find: 'orphans.filter((r) => String(r.table ?? "").startsWith("eng_"))', replace: '[]' },
  { name: 'integrity: a hole in the numbering is not reported', suite: INTEG, file: E('integrity.ts'), find: 'if (k.lo !== 1 || k.hi !== k.n) problems.push({ code: "number_gap"', replace: 'if (false) problems.push({ code: "number_gap"' },
  { name: 'integrity: a document with no number is not reported', suite: INTEG, file: E('integrity.ts'), find: 'for (const u of unnumbered) problems.push({ code: "number_gap"', replace: 'for (const u of []) problems.push({ code: "number_gap"' },
  { name: 'integrity: an event type the engine writes is missing from the model', suite: INTEG, file: E('integrity.ts'), find: '  "payment.made": { creates: "movement", note: "one eng_money_movement with direction out" },\n', replace: '' },
  // tenant isolation and ownership, Task 3: each removes ONE protection (or, for the compound, ALL of the router's and object's layers) and the suite that owns it must fail
  { name: 'router: a client-supplied business header decides the route, not the session', suite: ISOL, file: 'worker/src/routing.ts', find: '  if (session?.b) return { kind: "business", businessId: session.b };', replace: '  const spoof = request.headers.get("X-Business-Id"); if (isBusinessId(spoof)) return { kind: "business", businessId: spoof };\n  if (session?.b) return { kind: "business", businessId: session.b };' },
  { name: 'router: a session whose signature does not verify is still believed', suite: ISOL, file: 'worker/src/auth.ts', find: '    if (!valid) return null;', replace: '    if (false) return null;' },
  { name: 'forwarding: a client-supplied X-Business-Id is no longer overwritten', suite: ISOL, file: 'worker/src/routing.ts', find: '  headers.set("X-Business-Id", businessId);', replace: '  if (!headers.has("X-Business-Id")) headers.set("X-Business-Id", businessId);' },
  { name: 'object: the session\'s business is no longer compared with the object\'s', suite: ISOL, file: 'worker/src/auth.ts', find: '  if (env.BUSINESS_MODE === "object" && (!env.BUSINESS_ID || payload.b !== env.BUSINESS_ID)) return null;', replace: '  if (false) return null;' },
  { name: 'object: a claim for another business is no longer refused', suite: ISOL, file: 'worker/src/business-object.ts', find: '      if (this.businessId !== claimed) return Response.json({ error: "this object belongs to another business" }, { status: 403 });', replace: '      if (false) return Response.json({ error: "this object belongs to another business" }, { status: 403 });' },
  { name: 'COMPOUND: router honours the client header AND the object drops the session check AND the one-business binding (every layer removed: a request for alpha must now be served beta\'s data)', suite: ISOL, file: 'worker/src/routing.ts', find: '  if (session?.b) return { kind: "business", businessId: session.b };', replace: '  const spoof = request.headers.get("X-Business-Id"); if (isBusinessId(spoof)) return { kind: "business", businessId: spoof };\n  if (session?.b) return { kind: "business", businessId: session.b };', also: [{ file: 'worker/src/auth.ts', find: '  if (env.BUSINESS_MODE === "object" && (!env.BUSINESS_ID || payload.b !== env.BUSINESS_ID)) return null;', replace: '  if (false) return null;' }, { file: 'worker/src/business-object.ts', find: '      if (this.businessId !== claimed) return Response.json({ error: "this object belongs to another business" }, { status: 403 });', replace: '      if (false) return Response.json({ error: "this object belongs to another business" }, { status: 403 });' }] },
  { name: 'ownership: an engine file reads a shared binding (SHARED_DB)', suite: OWN, file: 'worker/src/engine/records.ts', find: 'import type { Env } from "../types";', replace: 'import type { Env } from "../types";\nconst __leak = (e: Env) => (e as unknown as { SHARED_DB?: unknown }).SHARED_DB;' },
  { name: 'ownership: engine SQL names a legacy domain table', suite: OWN, file: 'worker/src/engine/ledger.ts', find: 'import type { Env } from "../types";', replace: 'import type { Env } from "../types";\nconst __q = "SELECT id FROM customers";' },
  { name: 'ownership: legacy code writes an engine table', suite: OWN, file: 'worker/src/index.ts', find: 'import { handleEngineRoute } from "./engine/routes";', replace: 'import { handleEngineRoute } from "./engine/routes";\nconst __w = "INSERT INTO eng_party (kind, name, event_id) VALUES (\'person\', \'x\', 1)";' },
  { name: 'ownership: a stray UPDATE of a fact table', suite: OWN, file: 'worker/src/engine/records.ts', find: 'import type { Env } from "../types";', replace: 'import type { Env } from "../types";\nconst __u = "UPDATE eng_money_movement SET amount_minor = 0";' },
  { name: 'ownership: an engine file imports an unreviewed module', suite: OWN, file: 'worker/src/engine/ledger.ts', find: 'import type { Env } from "../types";', replace: 'import type { Env } from "../types";\nimport "../customers";' },
  { name: 'ownership: a new legacy-to-engine coupling', suite: OWN, file: 'worker/src/index.ts', find: 'import { handleEngineRoute } from "./engine/routes";', replace: 'import { handleEngineRoute } from "./engine/routes";\nimport { isAvailable as __x } from "./engine/availability";' },
  // the object's own identity (the fix for the first-claim binding finding)
  { name: 'object identity: a claim that does not match the object\'s own name is no longer refused', suite: OBJ, file: 'worker/src/business-object.ts', find: 'if (objectName !== undefined && objectName !== objectNameFor(claimed)) return Response.json({ error: "this object belongs to another business" }, { status: 403 });', replace: 'if (false) return Response.json({ error: "this object belongs to another business" }, { status: 403 });' },
  { name: 'object identity: the object\'s name is no longer handed to the pipeline (so health cannot show it)', suite: ISOL, file: 'worker/src/business-object.ts', find: 'objectEnv.OBJECT_NAME = objectName;', replace: 'objectEnv.OBJECT_NAME = undefined;' },
  { name: 'object identity: an unexpected name shape locks a business out (fail-closed instead of fail-open)', suite: OBJ, file: 'worker/src/business-object.ts', find: 'const objectName = typeof ownName === "string" ? ownName : undefined;', replace: 'const objectName = ownName === undefined ? undefined : String(ownName);' },
  { name: 'health: the report no longer says whether the runtime exposes the object\'s name', suite: ISOL, file: 'worker/src/health.ts', find: 'identityVisible: typeof env.OBJECT_NAME === "string"', replace: 'identityVisible: true' },
  // the admin routes (privileged: they can put a business into engine mode)
  { name: 'admin: provisioning exists on a deployment that is not a rehearsal', suite: ADMIN, file: E('admin.ts'), find: 'if (env.ENGINE_REHEARSAL !== "1") return bad("this route exists only on a rehearsal deployment", 404);', replace: '/* mutation: no rehearsal flag */' },
  { name: 'admin: provisioning without the business id as confirmation', suite: ADMIN, file: E('admin.ts'), find: 'if (!body || body.confirm !== env.BUSINESS_ID) return bad("confirm must be the business id", 400);', replace: '/* mutation: no confirmation */' },
  { name: 'admin: provisioning a business that already has engine data', suite: ADMIN, file: E('admin.ts'), find: 'if ((now.rows as number) > 0 || now.mode !== "legacy") return bad(', replace: 'if (false) return bad(' },
  { name: 'admin: the status hash ignores the rows', suite: ADMIN, file: E('admin.ts'), find: 'hashes[t] = await sha256(JSON.stringify(all));', replace: 'hashes[t] = await sha256("constant");' },
  { name: 'admin: provisioning is demoted from privileged to write', suite: ADMIN, file: 'worker/src/admin-routes.ts', find: '"POST /admin/engine/provision-sample": "privileged",', replace: '"POST /admin/engine/provision-sample": "write",' },
  // restore verification (recovery-sensitive: found by the staging rehearsal)
  { name: 'restore: verify over every live column again (the false failure returns)', suite: ADDCOL, file: 'worker/src/backup.ts', find: 'await fingerprint(env, snapshotColumns)', replace: 'await fingerprint(env)' },
  { name: 'restore: the column restriction ignores every value (the check goes blind)', suite: ADDCOL, file: 'worker/src/migration.ts', find: 'canonical(keep ? Object.fromEntries(keep.map((k) => [k, row[k]])) : row)', replace: 'canonical(keep ? {} : row)' },
  // the database itself
  { name: 'migration: a reversal may point at two things', suite: SCHEMA, file: MIG, find: '+ (document_id IS NOT NULL) = 1)', replace: '+ (document_id IS NOT NULL) >= 0)' },
];

const originals = new Map();
const restoreAll = () => { for (const [f, text] of originals) fs.writeFileSync(path.join(root, f), text); };
process.on('exit', restoreAll);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { restoreAll(); process.exit(130); });

const runSuite = (suite) => {
  const r = spawnSync(process.execPath, ['--no-warnings', path.join(__dirname, suite)], { env: { ...process.env, NODE_PATH: path.join(root, 'worker', 'node_modules'), HARNESS_BACKEND: 'do', HARNESS_INDEXES: '1' }, encoding: 'utf8', timeout: 280000 });
  const out = r.stdout || '';
  const m = /(\d+)\/(\d+) correct, (\d+) failing/.exec(out);
  return { failing: m ? Number(m[3]) : null, total: m ? Number(m[2]) : null, crashed: !m, first: (out.split('\n').find((l) => l.startsWith('FAIL')) || '').slice(0, 120) };
};

let bad = 0;
for (const suite of [...new Set(MUTATIONS.map((m) => m.suite))]) {
  const base = runSuite(suite);
  console.log(`unmutated ${suite}: ${base.crashed ? 'CRASHED' : base.total - base.failing + '/' + base.total + ' correct'}`);
  if (base.crashed || base.failing !== 0) { console.log('the unmutated suite must be green before a mutation means anything'); process.exit(1); }
}
for (const [i, m] of MUTATIONS.entries()) {
  const edits = [{ file: m.file, find: m.find, replace: m.replace }, ...(m.also || [])];   // a mutation may edit several files (the compound isolation control)
  let notFound = null;
  for (const e of edits) { const full = path.join(root, e.file); if (!originals.has(e.file)) originals.set(e.file, fs.readFileSync(full, 'utf8')); if (originals.get(e.file).split(e.find).length !== 2) { notFound = e; break; } }
  if (notFound) { console.log(`${String(i + 1).padStart(2)}. ${m.name}: the text to mutate is not found exactly once in ${notFound.file} (the code moved: update this script)`); bad++; continue; }
  let res;
  try { for (const e of edits) { const full = path.join(root, e.file); fs.writeFileSync(full, fs.readFileSync(full, 'utf8').replace(e.find, () => e.replace)); } res = runSuite(m.suite); } finally { for (const e of edits) fs.writeFileSync(path.join(root, e.file), originals.get(e.file)); }
  const caught = !res.crashed && res.failing > 0;
  if (!caught) bad++;
  console.log(`${String(i + 1).padStart(2)}. ${caught ? 'CAUGHT  ' : res.crashed ? 'CRASHED ' : 'SURVIVED'} ${m.name}${caught ? `  (${res.failing} failing; first: ${res.first})` : ''}`);
}
console.log(bad ? `\n${bad} mutation(s) not caught: the tests have a hole` : `\nall ${MUTATIONS.length} mutations caught`);
process.exit(bad ? 1 : 0);
