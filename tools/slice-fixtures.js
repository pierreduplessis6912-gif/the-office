// Fixtures for the Mokoena slice (branch engine-phase1): the REAL answers of the engine's routes on the harness, in the world docs/decisions/first-slice.md section C defines (the engine's own sample seed, run through its admin route), normalised so they are stable
// (clock times in a record's history and a held action's creation time are fixed). The Dart tests in app/test/slice_model_test.dart read these files, and tools/slice-mokoena.test.js fails if a file differs from what the engine answers now, so the app's reader
// and the backend cannot drift apart unseen (PROJECTION_VISION.md, "no shared fixture proving the backend and the app agree"). The ambiguous-name fixture comes from the receivables kit world, which has two customers called Mokoena (the sample world has one).
// Regenerate with: NODE_PATH=worker/node_modules node tools/slice-fixtures.js   (it writes app/test/fixtures/slice/*.json and changes nothing else)
const fs = require('fs'), path = require('path');
const kit = require('./engine-kit.js');
const DIR = path.join(__dirname, '..', 'app', 'test', 'fixtures', 'slice');
const FIXED_AT = '2026-01-01T00:00:00.000Z';
const normalise = (v) => JSON.parse(JSON.stringify(v).replace(/"at":"[^"]*"/g, `"at":"${FIXED_AT}"`).replace(/"created_at":"[^"]*"/g, '"created_at":"2026-01-01 00:00:00"'));

async function build() {
  const ENV_A = { BUSINESS_ID: 'eng-a', ENGINE_REHEARSAL: '1' };
  const SEED = { admin: true, method: 'POST', path: '/admin/engine/provision-sample', body: { confirm: 'eng-a' } };
  const run = (s) => kit.route({ env: ENV_A, ...s, before: [SEED, ...(s.before || [])] });
  const r500 = { partyId: 1, amountMinor: 50000, currency: 'ZAR', occurredOn: '2026-11-07', method: 'eft', allocate: 'oldest_first' };
  const propose = (role = 'accountant', payload = r500, transcript = 'Record R500 from Mokoena') => ({ method: 'POST', path: '/engine/proposals', role, body: { capability: 'payment.record', payload, transcript } });
  const confirm = (role = 'accountant', id = 1) => ({ method: 'POST', path: `/actions/${id}/confirm`, role, body: {} });
  const ask = (role, party) => ({ method: 'GET', path: `/engine/receivables?party=${party}`, role });
  const open = (role, kind, id) => ({ method: 'GET', path: `/engine/records/${kind}/${id}`, role });
  const twoMokoenas = (db) => { kit.seedReceivables()(db); const e = Number(db.prepare("INSERT INTO eng_event (type, actor_email, contract, contract_version, payload_json) VALUES ('party.created', 'seed@example.com', 'seed', 1, ?) RETURNING id").get(JSON.stringify({ kind: 'organisation', name: 'Mokoena', roles: ['customer'] })).id); db.prepare("INSERT INTO eng_party (kind, name, event_id) VALUES ('organisation', 'Mokoena', ?)").run(e); db.prepare("INSERT INTO eng_party_role (party_id, role, event_id) VALUES (2, 'customer', ?)").run(e); };
  const offB = kit.asEngineBusiness((db) => db.prepare("INSERT INTO eng_config (key, value_json) VALUES ('available', '[]')").run());
  const out = {
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
    'unavailable-ask': (await kit.route({ env: { BUSINESS_ID: 'eng-b' }, seed: offB, ...ask('accountant', 'Mokoena') })).result,
    'unavailable-proposal': (await kit.route({ env: { BUSINESS_ID: 'eng-b' }, seed: offB, ...propose() })).result,
  };
  const files = {}; for (const [k, v] of Object.entries(out)) files[k + '.json'] = normalise(v);
  return files;
}
module.exports = { build, DIR };
if (require.main === module) {
  global.__RealResponse = global.Response;
  build().then((files) => { fs.mkdirSync(DIR, { recursive: true }); for (const f of fs.readdirSync(DIR)) if (f.endsWith('.json')) fs.unlinkSync(path.join(DIR, f)); for (const [n, v] of Object.entries(files)) fs.writeFileSync(path.join(DIR, n), JSON.stringify(v, null, 2) + '\n'); console.log('wrote ' + Object.keys(files).length + ' fixtures to ' + DIR); }).catch((e) => { console.error(e); process.exit(1); });
}
