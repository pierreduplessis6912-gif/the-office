// Fixtures for the Mokoena slice (branch engine-phase1): the REAL answers of the engine's routes on the harness, in the world docs/decisions/first-slice.md section C defines (the engine's own sample seed, run through its admin route), normalised so they are stable
// (clock times in a record's history and a held action's creation time are fixed). The Dart tests in app/test/slice_model_test.dart read these files, and tools/slice-mokoena.test.js fails if a file differs from what the engine answers now, so the app's reader
// and the backend cannot drift apart unseen (PROJECTION_VISION.md, "no shared fixture proving the backend and the app agree"). The ambiguous-name fixture comes from the receivables kit world, which has two customers called Mokoena (the sample world has one).
// Regenerate with: NODE_PATH=worker/node_modules node tools/slice-fixtures.js   (it writes app/test/fixtures/slice/*.json and changes nothing else)
const fs = require('fs'), path = require('path');
const kit = require('./engine-kit.js');
const DIR = path.join(__dirname, '..', 'app', 'test', 'fixtures', 'slice');
const DART_FILE = path.join(__dirname, '..', 'app', 'lib', 'engine', 'engine_fixtures.dart');
const FIXED_AT = '2026-01-01T00:00:00.000Z';
const stripDebug = (v) => { if (Array.isArray(v)) return v.map(stripDebug); if (v && typeof v === 'object') { const o = {}; for (const [k, x] of Object.entries(v)) if (k !== 'debug') o[k] = stripDebug(x); return o; } return v; };   // the model's reply is shown in a rehearsal only; a recorded answer for the app never carries it
const normalise = (v) => JSON.parse(JSON.stringify(v).replace(/"at":"[^"]*"/g, `"at":"${FIXED_AT}"`).replace(/"created_at":"[^"]*"/g, '"created_at":"2026-01-01 00:00:00"'));

async function build() {
  const ENV_A = { BUSINESS_ID: 'eng-a', ENGINE_REHEARSAL: '1' };
  const SEED = { admin: true, method: 'POST', path: '/admin/engine/provision-sample', body: { confirm: 'eng-a' } };
  const run = (s) => kit.route({ env: ENV_A, ...s, before: [SEED, ...(s.before || [])] });
  const r500 = { partyId: 1, amountMinor: 50000, currency: 'ZAR', occurredOn: '2026-11-07', method: 'eft', allocate: 'oldest_first' };
  const propose = (role = 'accountant', payload = r500, transcript = 'Record R500 from Mokoena') => ({ method: 'POST', path: '/engine/proposals', role, body: { capability: 'payment.record', payload, transcript } });
  const confirm = (role = 'accountant', id = 1) => ({ method: 'POST', path: `/actions/${id}/confirm`, role, body: {} });
  const reject = (role = 'accountant', id = 1) => ({ method: 'POST', path: `/actions/${id}/reject`, role, body: {} });
  const ask = (role, party) => ({ method: 'GET', path: `/engine/receivables?party=${party}`, role });
  const open = (role, kind, id) => ({ method: 'GET', path: `/engine/records/${kind}/${id}`, role });
  const twoMokoenas = (db) => { kit.seedReceivables()(db); const e = Number(db.prepare("INSERT INTO eng_event (type, actor_email, contract, contract_version, payload_json) VALUES ('party.created', 'seed@example.com', 'seed', 1, ?) RETURNING id").get(JSON.stringify({ kind: 'organisation', name: 'Mokoena', roles: ['customer'] })).id); db.prepare("INSERT INTO eng_party (kind, name, event_id) VALUES ('organisation', 'Mokoena', ?)").run(e); db.prepare("INSERT INTO eng_party_role (party_id, role, event_id) VALUES (2, 'customer', ?)").run(e); };
  const offB = kit.asEngineBusiness((db) => db.prepare("INSERT INTO eng_config (key, value_json) VALUES ('available', '[]')").run());
  // ---- the assistant (the engine's interpreter and what it offers since the first slice): the same engine, a scripted model, the same sample ---------------------------------------------------------------------------------
  const callJson = (capability, args) => JSON.stringify({ capability, arguments: args });
  const AI = [
    { match: /Who is Patel\?/, reply: () => callJson('parties.find', { name: 'Patel' }) },
    { match: /VAT this month/, reply: () => callJson('vat.summary', { period: 'this_month' }) },
    { match: /spend on fuel/, reply: () => callJson('expenses.find', { category: 'fuel', period: 'last_month' }) },
    { match: /Add Dlamini Timber/, reply: () => callJson('party.create', { name: 'Dlamini Timber', role: 'supplier' }) },
    { match: /Bought plywood from Timber Supplies/, reply: () => callJson('expense.record', { supplier: 'Timber Supplies', amountCents: 23000, vat: 'incl_vat', description: 'Plywood', category: 'materials', method: 'eft', invoiceHeld: true }) },
    { match: /Bought glue from Nobody/, reply: () => callJson('expense.record', { supplier: 'Nobody Ltd', amountCents: 10000, vat: 'incl_vat', description: 'Glue', category: 'materials', method: 'eft' }) },
    { match: /Lock the tax period/, reply: () => callJson(null) },
  ];
  const sayTo = (text, role = 'accountant') => ({ method: 'POST', path: '/engine/interpret', role, body: { text } });
  // every default role can now ask about stock (the materials capability), so the refused-installer scenario (a member with nothing to ask) is built with the owner's own mechanism: the capability overrides revoke the materials capabilities
  const REVOKE_MATERIALS = (db) => { db.exec("CREATE TABLE IF NOT EXISTS role_capability_overrides (role TEXT NOT NULL, capability TEXT NOT NULL, granted INTEGER NOT NULL, updated_by TEXT, updated_at TEXT, PRIMARY KEY (role, capability))"); const ins = db.prepare("INSERT OR REPLACE INTO role_capability_overrides (role, capability, granted) VALUES (?, ?, 0)"); for (const c of ['can_know_materials', 'can_know_material_prices']) ins.run('installer', c); };
  const asked = (text, extra = {}) => run({ ai: AI, ...sayTo(text, extra.role), before: extra.before, ...(extra.seed ? { seed: extra.seed } : {}) });
  const SUP = [{ method: 'POST', path: '/engine/proposals', role: 'accountant', body: { capability: 'party.create', payload: { kind: 'organisation', name: 'Timber Supplies', roles: ['supplier'], contact: { vatNumber: '4111111111' } }, transcript: 'setup' } }, confirm('accountant', 1)];
  const WORDS = { patel: 'Who is Patel?', vat: 'What is my VAT this month?', fuel: 'What did I spend on fuel last month?', party: 'Add Dlamini Timber as a supplier', expense: 'Bought plywood from Timber Supplies for R230 including VAT, paid by EFT, I have the invoice', nobody: 'Bought glue from Nobody Ltd for R100 including VAT', lock: 'Lock the tax period up to the end of last month' };
  const pendingAfter = (before) => run({ ai: AI, before, method: 'GET', path: '/actions/pending', role: 'accountant' });
  const out = {
    'assistant-parties': (await asked(WORDS.patel)).result,
    'assistant-vat': (await asked(WORDS.vat)).result,
    'assistant-expenses': (await asked(WORDS.fuel)).result,
    'assistant-held-party': (await asked(WORDS.party)).result,
    'assistant-held-expense': (await asked(WORDS.expense, { before: SUP })).result,
    'assistant-not-understood': (await asked(WORDS.lock)).result,
    'assistant-refused': (await asked(WORDS.nobody, { before: SUP })).result,
    'assistant-refused-installer': (await asked(WORDS.patel, { role: 'installer', seed: REVOKE_MATERIALS })).result,
    'assistant-pending-party': (await pendingAfter([sayTo(WORDS.party)])).result,
    'assistant-pending-expense': (await pendingAfter([...SUP, sayTo(WORDS.expense)])).result,
    'assistant-confirm-party': (await run({ ai: AI, before: [sayTo(WORDS.party)], ...confirm('accountant', 1) })).result,
    'assistant-confirm-expense': (await run({ ai: AI, before: [...SUP, sayTo(WORDS.expense)], ...confirm('accountant', 2) })).result,
    'record-party-supplier': (await run({ before: SUP, ...open('accountant', 'party', 3) })).result,
    'receivables-answer': (await run(ask('accountant', 'Mokoena'))).result,
    'receivables-after-payment': (await run({ before: [propose(), confirm()], ...ask('accountant', 'Mokoena') })).result,
    'receivables-ambiguous': (await kit.route({ env: { BUSINESS_ID: 'eng-a' }, ...ask('accountant', 'Mokoena'), seed: twoMokoenas })).result,
    'receivables-refused': (await run(ask('installer', 'Mokoena'))).result,
    'receivables-not-found': (await run(ask('accountant', 'Nobody'))).result,
    'record-document': (await run(open('accountant', 'document', 1))).result,
    'record-document-after-payment': (await run({ before: [propose(), confirm()], ...open('accountant', 'document', 1) })).result,
    'record-party': (await run(open('accountant', 'party', 1))).result,
    'record-movement-reversed': (await run(open('accountant', 'movement', 1))).result,
    'pending-held': (await run({ before: [propose()], method: 'GET', path: '/actions/pending', role: 'accountant' })).result,
    'proposal-held': (await run(propose())).result,
    'proposal-refused': (await run(propose('installer'))).result,
    'confirm-ok': (await run({ before: [propose()], ...confirm() })).result,
    'confirm-stale': (await run({ before: [propose(), propose('accountant', { ...r500, amountMinor: 10000 }, 'Record R100 from Mokoena'), confirm('accountant', 2)], ...confirm('accountant', 1) })).result,
    'reject-ok': (await run({ before: [propose()], ...reject() })).result,
    'reject-refused': (await run({ before: [propose()], ...reject('installer') })).result,
    'confirm-after-reject': (await run({ before: [propose(), reject()], ...confirm() })).result,
    'pending-empty': (await run({ before: [propose(), reject()], method: 'GET', path: '/actions/pending', role: 'accountant' })).result,
    'pending-held-over': (await run({ before: [propose('accountant', { ...r500, amountMinor: 100000 }, 'Record R1000 from Mokoena')], method: 'GET', path: '/actions/pending', role: 'accountant' })).result,
    'receivables-after-overpay': (await run({ before: [propose('accountant', { ...r500, amountMinor: 100000 }, 'Record R1000 from Mokoena'), confirm()], ...ask('accountant', 'Mokoena') })).result,
    'unavailable-ask': (await kit.route({ env: { BUSINESS_ID: 'eng-b' }, seed: offB, ...ask('accountant', 'Mokoena') })).result,
    'unavailable-proposal': (await kit.route({ env: { BUSINESS_ID: 'eng-b' }, seed: offB, ...propose() })).result,
  };
  const files = {}; for (const [k, v] of Object.entries(out)) files[k + '.json'] = normalise(stripDebug(v));
  return files;
}
// The same answers as Dart source, so the engine shell's entry point (app/lib/engine_main.dart) can run on them without bundling files (no pubspec change). The backend test fails if this file differs from what the engine answers now.
function dartSource(files) {
  const body = Object.entries(files).map(([name, v]) => `  '${name.replace(/\.json$/, '')}': r'''${JSON.stringify(v, null, 2)}''',`).join('\n');
  return `// GENERATED by tools/slice-fixtures.js from the engine's own routes. Do not edit: regenerate with\n//   NODE_PATH=worker/node_modules node tools/slice-fixtures.js\n// The engine shell's demo entry point (lib/engine_main.dart) runs on these RECORDED answers, not on a live business, and tools/slice-mokoena.test.js fails if this file differs from what the engine answers now.\nconst Map<String, String> engineFixtureJson = <String, String>{\n${body}\n};\n`;
}
module.exports = { build, DIR, DART_FILE, dartSource };
if (require.main === module) {
  global.__RealResponse = global.Response;
  build().then((files) => { fs.mkdirSync(DIR, { recursive: true }); for (const f of fs.readdirSync(DIR)) if (f.endsWith('.json')) fs.unlinkSync(path.join(DIR, f)); for (const [n, v] of Object.entries(files)) fs.writeFileSync(path.join(DIR, n), JSON.stringify(v, null, 2) + '\n'); fs.writeFileSync(DART_FILE, dartSource(files)); console.log('wrote ' + Object.keys(files).length + ' fixtures to ' + DIR + ' and ' + DART_FILE); }).catch((e) => { console.error(e); process.exit(1); });
}
