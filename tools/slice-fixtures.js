// Fixtures for the Mokoena slice (branch engine-phase1): the REAL answers of the engine's routes on the harness, normalised so they are stable (clock times in a record's history are fixed). The Dart tests in app/test/slice_model_test.dart read these files,
// and tools/slice-mokoena.test.js fails if a file differs from what the engine answers now, so the app's reader and the backend cannot drift apart unseen (PROJECTION_VISION.md, "no shared fixture proving the backend and the app agree").
// Regenerate with: NODE_PATH=worker/node_modules node tools/slice-fixtures.js   (it writes app/test/fixtures/slice/*.json and changes nothing else)
const fs = require('fs'), path = require('path');
const kit = require('./engine-kit.js');
const DIR = path.join(__dirname, '..', 'app', 'test', 'fixtures', 'slice');
const FIXED_AT = '2026-01-01T00:00:00.000Z';
const normalise = (v) => JSON.parse(JSON.stringify(v).replace(/"at":"[^"]*"/g, `"at":"${FIXED_AT}"`));

async function build() {
  const ENV = { BUSINESS_ID: 'eng-a' };
  const run = (s) => kit.route({ env: ENV, seed: kit.seedReceivables(), ...s });
  const pay = { partyId: 1, amountMinor: 115000, currency: 'ZAR', occurredOn: '2026-11-07', method: 'eft', allocate: 'oldest_first' };
  const propose = { method: 'POST', path: '/engine/proposals', role: 'accountant', body: { capability: 'payment.record', payload: pay, transcript: 'Mokoena paid R1,150' } };
  const confirm = { method: 'POST', path: '/actions/1/confirm', role: 'accountant', body: {} };
  const twoMokoenas = (db) => { kit.seedReceivables()(db); const e = Number(db.prepare("INSERT INTO eng_event (type, actor_email, contract, contract_version, payload_json) VALUES ('party.created', 'seed@example.com', 'seed', 1, ?) RETURNING id").get(JSON.stringify({ kind: 'organisation', name: 'Mokoena', roles: ['customer'] })).id); db.prepare("INSERT INTO eng_party (kind, name, event_id) VALUES ('organisation', 'Mokoena', ?)").run(e); db.prepare("INSERT INTO eng_party_role (party_id, role, event_id) VALUES (2, 'customer', ?)").run(e); };
  const ask = (role, party) => ({ method: 'GET', path: `/engine/receivables?party=${party}`, role });
  const out = {
    'receivables-answer': (await run(ask('accountant', 'Mokoena'))).result,
    'receivables-after-payment': (await run({ before: [propose, confirm], ...ask('accountant', 'Mokoena') })).result,
    'receivables-ambiguous': (await run({ ...ask('accountant', 'Mokoena'), seed: twoMokoenas })).result,
    'receivables-refused': (await run(ask('installer', 'Mokoena'))).result,
    'receivables-not-found': (await run(ask('accountant', 'Nobody'))).result,
    'record-document': (await run({ method: 'GET', path: '/engine/records/document/1', role: 'accountant' })).result,
    'record-party': (await run({ method: 'GET', path: '/engine/records/party/1', role: 'accountant' })).result,
    'proposal-held': (await run(propose)).result,
    'proposal-refused': (await run({ ...propose, role: 'installer' })).result,
    'confirm-ok': (await run({ before: [propose], ...confirm })).result,
    'confirm-stale': (await run({ before: [propose, { ...propose, body: { ...propose.body, payload: { ...pay, amountMinor: 23000 } } }, { ...confirm, path: '/actions/2/confirm' }], ...confirm })).result,
  };
  const files = {}; for (const [k, v] of Object.entries(out)) files[k + '.json'] = normalise(v);
  return files;
}
module.exports = { build, DIR };
if (require.main === module) {
  global.__RealResponse = global.Response;
  build().then((files) => { fs.mkdirSync(DIR, { recursive: true }); for (const [n, v] of Object.entries(files)) fs.writeFileSync(path.join(DIR, n), JSON.stringify(v, null, 2) + '\n'); console.log('wrote ' + Object.keys(files).length + ' fixtures to ' + DIR); }).catch((e) => { console.error(e); process.exit(1); });
}
