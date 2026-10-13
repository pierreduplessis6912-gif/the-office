// The synthetic business used for migration rehearsals (tools/seed-synthetic.mjs): deterministic, valid against the real schema, awkward on purpose, and nothing in it could be real data.
const path = require('path'), fs = require('fs'), os = require('os'), crypto = require('crypto');
const { pathToFileURL } = require('url');
const { DatabaseSync } = require('node:sqlite');

module.exports = async function runSeedTests({ check, srcDir }) {
  const { generate, SYNTHETIC } = await import(pathToFileURL(path.join(__dirname, 'seed-synthetic.mjs')).href);
  const a = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-a-')), b = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-b-'));
  const expected = generate(a); generate(b);
  const hashDir = (d) => { const h = crypto.createHash('sha256'); for (const f of ['seed.sql', 'kv.json', 'files.json', 'vectors.ndjson', 'expected.json']) h.update(fs.readFileSync(path.join(d, f))); for (const f of fs.readdirSync(path.join(d, 'files')).sort()) h.update(fs.readFileSync(path.join(d, 'files', f))); return h.digest('hex'); };
  check(hashDir(a) === hashDir(b), 'the synthetic business is DETERMINISTIC: generated twice, every byte is identical (a rehearsal can be repeated and compared)');

  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(path.join(srcDir, '..', 'migrations', '0001_baseline.sql'), 'utf8'));
  db.exec(fs.readFileSync(path.join(a, 'seed.sql'), 'utf8'));
  const n = (sql) => db.prepare(sql).get().n;
  check(n('SELECT COUNT(*) AS n FROM customers') === expected.customers && db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'customers'").get().seq === expected.customerCounter && n('SELECT COUNT(*) AS n FROM payments') === 1 && n('SELECT COUNT(*) AS n FROM lazy_things') === 2 && n("SELECT COUNT(*) AS n FROM pragma_table_info('tasks') WHERE name = 'priority'") === 1, 'the database seed is valid against the real schema, with a deleted top id (counter 5, four customers), a column added later, a table created on first use, and a payment that references a customer');
  check(n("SELECT COUNT(*) AS n FROM memberships WHERE status = 'active'") === expected.activeMembers && n("SELECT COUNT(*) AS n FROM memberships WHERE status = 'suspended'") === 1 && db.prepare("SELECT LENGTH(address) AS l FROM customers WHERE name LIKE 'multi%'").get().l > 15000, 'it has two active team members and one suspended, and a long text');
  const kv = JSON.parse(fs.readFileSync(path.join(a, 'kv.json'), 'utf8')), files = JSON.parse(fs.readFileSync(path.join(a, 'files.json'), 'utf8'));
  check(kv.length === SYNTHETIC.notes && new Set(kv.map((k) => k.key)).size === kv.length && files.length === SYNTHETIC.files && new Set(files.map((f) => f.key)).size === files.length && files.every((f) => fs.statSync(path.join(a, 'files', f.file)).size > 300), '250 distinct notes and 40 distinct non-empty files');
  const vectors = fs.readFileSync(path.join(a, 'vectors.ndjson'), 'utf8').trim().split('\n').map(JSON.parse);
  check(vectors.length === SYNTHETIC.vectors && vectors.every((v) => v.values.length === 768 && v.values.filter((x) => x === 1).length === 1) && new Set(vectors.map((v) => v.id)).size === vectors.length && vectors[0].values[expected.probeMemory.hotDimension] === 1, '45 distinct memories of exactly 768 dimensions, each the nearest match of itself');
  const everything = [fs.readFileSync(path.join(a, 'seed.sql'), 'utf8'), fs.readFileSync(path.join(a, 'kv.json'), 'utf8')].join('\n');
  const emails = [...everything.matchAll(/[A-Za-z0-9._-]+@[A-Za-z0-9.-]+/g)].map((m) => m[0]);
  check(emails.length >= 3 && emails.every((e) => e.endsWith('@example.com')), 'every email address in it ends @example.com: nothing here can be real data');
};
