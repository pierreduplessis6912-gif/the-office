// Characterization harness for processOneExtraction (rewrite Phase 2).
//
// Runs the REAL function, unmodified, against a REAL SQLite database built from the live baseline schema
// (worker/migrations/0001_baseline.sql, captured from the live database's own sqlite_master), with a scripted
// AI that fails loudly on any call nobody planned for. It records what the function RETURNS and exactly which
// rows it WROTE. The recordings are the equivalence matrix the rewritten handlers must later reproduce.
//
// The live code is not edited: the function is exposed by an in-memory esbuild transform of index.ts that
// appends one export. Needs node:sqlite (Node 22), which is why the pipeline now runs Node 22.
const fs = require('fs');
const os = require('os');
const path = require('path');

let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (e) {
  throw new Error('characterization tests need node:sqlite (Node 22+); this is Node ' + process.version);
}

const plain = (row) => (row ? { ...row } : row);
const VOLATILE = /(^created_at$|^updated_at$|^resolved_at$|_at$)/;   // timestamps differ on every run

async function loadFunctions(workerDir) {
  const esbuild = require('esbuild');
  const expose = {
    name: 'expose-processOneExtraction',
    setup(b) {
      b.onLoad({ filter: /src[\\/]index\.ts$/ }, (a) => ({
        contents: fs.readFileSync(a.path, 'utf8') + '\nexport { processOneExtraction as __poe, processTranscript as __pt, handleRequest as __hr };\n',
        loader: 'ts',
      }));
    },
  };
  const out = path.join(os.tmpdir(), `rm-poe-${process.pid}.js`);
  await esbuild.build({ entryPoints: [path.join(workerDir, 'src', 'index.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent', plugins: [expose] });
  const mod = require(out);
  // auth.ts is bundled on its own for the real session signer and the real role table; its tokens verify against the
  // copy inside the index bundle because both use the same HMAC with the same secret.
  const authOut = path.join(os.tmpdir(), `rm-auth-${process.pid}.js`);
  await esbuild.build({ entryPoints: [path.join(workerDir, 'src', 'auth.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: authOut, logLevel: 'silent' });
  return { processOne: mod.__poe, processTranscript: mod.__pt, handleRequest: mod.__hr, auth: require(authOut) };
}

// Kept for the cases that only need the single-segment function.
async function loadProcessor(workerDir) {
  return (await loadFunctions(workerDir)).processOne;
}

function newDatabase(workerDir) {
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(path.join(workerDir, 'migrations', '0001_baseline.sql'), 'utf8'));
  return db;
}

// A D1-shaped wrapper. Deliberately as strict as D1: binding undefined or a boolean throws, as it does there.
function d1(db) {
  const stmt = (sql, binds = []) => ({
    bind: (...b) => stmt(sql, b),
    first: async (col) => { const row = plain(db.prepare(sql).get(...binds)) ?? null; return col && row ? row[col] : row; },
    all: async () => ({ results: db.prepare(sql).all(...binds).map(plain), success: true, meta: {} }),
    run: async () => { const r = db.prepare(sql).run(...binds); return { success: true, meta: { last_row_id: Number(r.lastInsertRowid), changes: Number(r.changes) } }; },
    raw: async () => db.prepare(sql).all(...binds).map((r) => Object.values(r)),
  });
  return {
    prepare: (sql) => stmt(sql),
    exec: async (sql) => { db.exec(sql); return { count: 1 }; },
    batch: async (stmts) => { const out = []; for (const s of stmts) out.push(await s.run()); return out; },
  };
}

// In-memory stand-ins for the other bindings the real code uses: the notes store (KV), the file store (R2) and the
// vector index. Everything they receive is logged, because a note written by a dictation is part of what it does.
function fakeKv(log, seed) {
  const m = new Map(Object.entries(seed || {}));
  return {
    get: async (k) => (m.has(k) ? m.get(k) : null),
    put: async (k, v) => { m.set(k, v); log.push({ kv: 'put', key: k, value: v }); },
    delete: async (k) => { m.delete(k); log.push({ kv: 'delete', key: k }); },
    list: async () => ({ keys: [...m.keys()].map((name) => ({ name })) }),
  };
}
function fakeR2(log) {
  const m = new Map();
  return {
    put: async (k, v) => { m.set(k, v); log.push({ r2: 'put', key: k }); },
    get: async (k) => (m.has(k) ? { body: m.get(k), arrayBuffer: async () => m.get(k) } : null),
    head: async (k) => (m.has(k) ? { key: k } : null),
    list: async () => ({ objects: [...m.keys()].map((key) => ({ key })) }),
    delete: async (k) => { m.delete(k); log.push({ r2: 'delete', key: k }); },
  };
}
function fakeVectorize(log) {
  return {
    upsert: async (v) => { log.push({ vectorize: 'upsert', count: v.length, metadata: v.map((x) => x.metadata) }); },
    query: async () => ({ matches: [] }),
    describe: async () => ({ dimensions: 768, vectorCount: 0 }),
  };
}

// Scripted AI. Each script entry: { match: RegExp tested against the system prompt + input, reply: object or fn }.
// An AI call with no matching entry throws, so a case can never silently depend on a model nobody scripted.
function scriptedAi(script) {
  const calls = [];
  const inputs = [];
  return {
    calls,
    inputs,
    run: async (model, input) => {
      const system = (input && input.messages && input.messages.find((m) => m.role === 'system') || {}).content || '';
      const hay = `${model}\n${system}\n${JSON.stringify(input)}`;   // the model name too, so a script can match on it
      if (/bge/.test(String(model))) { calls.push('(embedding)'); return { data: [new Array(8).fill(0)] }; }
      calls.push(system.slice(0, 70).replace(/\s+/g, ' '));
      inputs.push(JSON.stringify(input));
      const hit = (script || []).find((s) => s.match.test(hay));
      if (!hit) throw new Error('unscripted AI call: ' + system.slice(0, 120).replace(/\s+/g, ' '));
      const reply = typeof hit.reply === 'function' ? hit.reply(input) : hit.reply;
      if (hit.raw) return reply;   // some models (speech to text) do not answer in the chat-completion shape
      return { choices: [{ message: { content: typeof reply === 'string' ? reply : JSON.stringify(reply) } }] };
    },
  };
}

function snapshot(db) {
  const out = {};
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()) {
    out[name] = db.prepare(`SELECT * FROM "${name}"`).all().map((r) => {
      const o = plain(r);
      for (const k of Object.keys(o)) if (VOLATILE.test(k)) delete o[k];
      return o;
    });
  }
  return out;
}

// Rows added, changed and removed, per table, keyed by id where there is one.
function diff(before, after) {
  const out = {};
  for (const table of Object.keys(after)) {
    const key = (r) => (r.id !== undefined ? 'id:' + r.id : JSON.stringify(r));
    // A table created during the case (the permission-grid tables are created the first time they are needed) was empty before.
    const b = new Map((before[table] || []).map((r) => [key(r), r])), a = new Map(after[table].map((r) => [key(r), r]));
    const added = [...a].filter(([k]) => !b.has(k)).map(([, r]) => r);
    const removed = [...b].filter(([k]) => !a.has(k)).map(([, r]) => r);
    const changed = [...a].filter(([k, r]) => b.has(k) && JSON.stringify(b.get(k)) !== JSON.stringify(r)).map(([k, r]) => ({ before: b.get(k), after: r }));
    if (added.length || removed.length || changed.length) out[table] = { ...(added.length ? { added } : {}), ...(changed.length ? { changed } : {}), ...(removed.length ? { removed } : {}) };
  }
  return out;
}

const EXTRACTION_DEFAULTS = { customer_name: null, character_name: null, character_relationship: null, intent: 'other', amount: null, fact_key: null, fact_value: null, personal_note: null, query_scope: null, deposit_percent: null, scope_document_type: null, due_date_raw: null };

// The function stamps times into notes and builds today's date into a note's key, so a recording made today would
// not match tomorrow's run. The clock is frozen for the duration of each case instead of masking times in the output.
const FROZEN_NOW = Date.parse('2026-10-03T12:00:00.000Z');
async function withFrozenClock(fn) {
  // The upload handlers put crypto.randomUUID() in a storage key, which is echoed in the response, so a recording would
  // differ on every run. Within a case it returns a counter instead (the same sequence each time).
  const realUuid = Object.getOwnPropertyDescriptor(globalThis.crypto, 'randomUUID');
  let uuidCounter = 0;
  Object.defineProperty(globalThis.crypto, 'randomUUID', { value: () => `00000000-0000-4000-8000-${String(++uuidCounter).padStart(12, '0')}`, configurable: true, writable: true });
  const RealDate = globalThis.Date;
  class FrozenDate extends RealDate {
    constructor(...a) { if (a.length === 0) super(FROZEN_NOW); else super(...a); }
    static now() { return FROZEN_NOW; }
  }
  globalThis.Date = FrozenDate;
  try { return await fn(); } finally {
    globalThis.Date = RealDate;
    if (realUuid) Object.defineProperty(globalThis.crypto, 'randomUUID', realUuid); else delete globalThis.crypto.randomUUID;
  }
}

// A real PDF with a text layer, built with the same library the product uses, so the upload handler's text extraction
// is exercised for real. No lines gives a blank page: a scanned document with no text layer.
async function makePdf(lines) {
  const { PDFDocument, StandardFonts } = require('pdf-lib');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595, 842]);
  (lines || []).forEach((line, i) => page.drawText(line, { x: 50, y: 780 - i * 22, size: 12, font }));
  return doc.save();
}

// A multipart body: { document: { name, type, pdfLines | text | base64 }, caption: '...', idempotency_key: '...' }.
async function buildForm(spec) {
  const form = new FormData();
  for (const [key, value] of Object.entries(spec)) {
    if (value && typeof value === 'object') {
      const bytes = value.pdfLines !== undefined ? await makePdf(value.pdfLines) : value.base64 ? Buffer.from(value.base64, 'base64') : Buffer.from(value.text || '');
      form.append(key, new File([bytes], value.name, { type: value.type }));
    } else if (value !== undefined && value !== null) {
      form.append(key, value);
    }
  }
  return form;
}

async function runCase(processOne, workerDir, spec) {
  const db = newDatabase(workerDir);
  if (spec.seed) spec.seed(db);
  db.prepare("INSERT INTO captures (raw_text, source) VALUES (?, 'text')").run(spec.transcript);
  const captureId = Number(db.prepare('SELECT MAX(id) AS m FROM captures').get().m);
  const before = snapshot(db);
  const ai = scriptedAi(spec.ai);
  const pendingWork = [], backgroundErrors = [];
  const ctx = { waitUntil: (p) => pendingWork.push(Promise.resolve(p).catch((e) => backgroundErrors.push(String(e && e.message || e)))), passThroughOnException() {} };
  const effects = [];
  const env = { OFFICE_DB: d1(db), AI: ai, CUSTOMER_NOTES: fakeKv(effects, spec.kvSeed), OFFICE_VAULT: fakeR2(effects), MEMORY: fakeVectorize(effects) };
  const extraction = spec.extraction === null ? null : { ...EXTRACTION_DEFAULTS, ...spec.extraction };
  let result = null, threw = null;
  await withFrozenClock(async () => {
    try {
      result = await processOne(env, spec.transcript, extraction, spec.history || [], ctx, captureId, spec.capabilities, spec.email === undefined ? 'owner@example.com' : spec.email);
    } catch (e) {
      threw = String(e && e.message || e);
    }
    await Promise.all(pendingWork);
  });
  const after = snapshot(db);
  const writes = diff(before, after);
  return { result, threw, aiCalls: ai.calls, aiInputs: ai.inputs, backgroundErrors, writes, effects };
}

// Runs the caller of processOneExtraction: it logs the capture, asks a model to split the message into topics, runs each
// topic through processOneExtraction, attaches a new job scope to the customer's open project, and joins the replies.
// Unlike runCase, no capture is pre-inserted (logCapture does it) and no extraction is passed in (a model reads each topic).
async function runTranscriptCase(processTranscript, workerDir, spec) {
  const db = newDatabase(workerDir);
  if (spec.seed) spec.seed(db);
  const before = snapshot(db);
  const ai = scriptedAi(spec.ai);
  const pendingWork = [], backgroundErrors = [];
  const ctx = { waitUntil: (p) => pendingWork.push(Promise.resolve(p).catch((e) => backgroundErrors.push(String(e && e.message || e)))), passThroughOnException() {} };
  const effects = [];
  const env = { OFFICE_DB: d1(db), AI: ai, CUSTOMER_NOTES: fakeKv(effects, spec.kvSeed), OFFICE_VAULT: fakeR2(effects), MEMORY: fakeVectorize(effects) };
  let result = null, threw = null;
  await withFrozenClock(async () => {
    try {
      result = await processTranscript(env, spec.transcript, ctx, spec.history || [], spec.source || 'text', spec.r2Key === undefined ? null : spec.r2Key, spec.capabilities, spec.email === undefined ? 'owner@example.com' : spec.email);
    } catch (e) {
      threw = String(e && e.message || e);
    }
    await Promise.all(pendingWork);
  });
  const after = snapshot(db);
  return { result, threw, aiCalls: ai.calls, aiInputs: ai.inputs, backgroundErrors, writes: diff(before, after), effects };
}

// Drives a ROUTE through the real request handler and the real authentication gate: a real signed session cookie, a real
// membership row, the real role table. Used for the confirm and reject routes, where a held action finally becomes a record.
// A case may begin with `before` steps: { say: true, transcript, extraction, role } runs the real dictation (so the held
// action's payload is exactly what the code writes, not a hand-copied guess) and { route: true, method, path, body, role }
// makes an earlier request. The recorded writes are only those of the final request.
async function runRouteCase(fns, workerDir, spec) {
  const { processOne, handleRequest, auth } = fns;
  const db = newDatabase(workerDir);
  if (spec.seed) spec.seed(db);
  for (const role of ['owner', 'accountant', 'installer']) db.prepare("INSERT INTO memberships (google_email, role, status) VALUES (?, ?, 'active')").run(`${role}@example.com`, role);
  const ai = scriptedAi(spec.ai);
  const pendingWork = [], backgroundErrors = [];
  const ctx = { waitUntil: (p) => pendingWork.push(Promise.resolve(p).catch((e) => backgroundErrors.push(String(e && e.message || e)))), passThroughOnException() {} };
  const effects = [];
  const env = { OFFICE_DB: d1(db), AI: ai, CUSTOMER_NOTES: fakeKv(effects, spec.kvSeed), OFFICE_VAULT: fakeR2(effects), MEMORY: fakeVectorize(effects), SESSION_SECRET: 'harness-session-secret', ADMIN_KEY: 'harness-admin-key', GOOGLE_CLIENT_ID: 'harness-client-id' };
  const call = async (step) => {
    const headers = step.form ? {} : { 'content-type': 'application/json' };   // a form sets its own boundary
    if (!step.noSession) headers.cookie = `office_session=${await auth.signSession(env, `${step.role || 'owner'}@example.com`)}`;
    const payload = step.form ? await buildForm(step.form) : step.body === undefined ? undefined : JSON.stringify(step.body);
    const request = new Request('https://office.test' + step.path, { method: step.method || 'POST', headers, body: payload });
    const response = await handleRequest(request, env, ctx, 'req-1');
    const text = await response.text();
    let body = text;
    try { body = JSON.parse(text); } catch (e) { /* not JSON: keep the text */ }
    return { status: response.status, body };
  };
  const logLines = [];
  const realLog = console.log, realError = console.error;
  const standIn = globalThis.Response;
  if (globalThis.__RealResponse) globalThis.Response = globalThis.__RealResponse;   // see role-matrix.test.js
  console.log = (l) => logLines.push(String(l));
  console.error = (l) => logLines.push(String(l));
  let result = null, threw = null, before = null;
  try {
    await withFrozenClock(async () => {
      try {
        for (const step of spec.before || []) {
          if (step.say) {
            db.prepare("INSERT INTO captures (raw_text, source) VALUES (?, 'text')").run(step.transcript);
            const captureId = Number(db.prepare('SELECT MAX(id) AS m FROM captures').get().m);
            const role = step.role || 'owner';
            await processOne(env, step.transcript, { ...EXTRACTION_DEFAULTS, ...step.extraction }, [], ctx, captureId, auth.ROLE_CAPABILITIES[role] || [], `${role}@example.com`);
          } else {
            await call(step);
          }
          await Promise.all(pendingWork.splice(0));
        }
        before = snapshot(db);
        result = await call(spec);
        await Promise.all(pendingWork.splice(0));
      } catch (e) {
        threw = String(e && e.stack ? e.message : e);
      }
    });
  } finally {
    console.log = realLog; console.error = realError;
    globalThis.Response = standIn;
  }
  if (before === null) before = snapshot(db);
  const errorLogs = logLines.map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter((l) => l && l.level === 'error').map((l) => ({ message: l.message, detail: l.detail, actionId: l.actionId }));
  return { result, threw, aiCalls: ai.calls, aiInputs: ai.inputs, backgroundErrors, writes: diff(before, snapshot(db)), effects, errorLogs };
}

module.exports = { loadFunctions, loadProcessor, runCase, runTranscriptCase, runRouteCase, newDatabase, EXTRACTION_DEFAULTS };
