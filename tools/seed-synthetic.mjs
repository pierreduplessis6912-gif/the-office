#!/usr/bin/env node
// Generates a deterministic SYNTHETIC business for migration rehearsals: no real data is involved, every email is @example.com. Output (in the folder given):
//   seed.sql      database rows (awkward on purpose: quotes, emoji, newlines, NULLs, decimals, a long text, a deleted top id, a column added later, a table created on first use, a foreign key)
//   kv.json       250 notes             [{key, value}]
//   files.json    40 files, with files/  [{key, file, contentType}]  (binary, varied sizes)
//   vectors.ndjson 45 memories, 768 dimensions, one per line (the memory index's own upload format)
//   expected.json what a correct migration must end with
// Usage: node tools/seed-synthetic.mjs <outdir>
import fs from 'node:fs';
import path from 'node:path';

export const SYNTHETIC = { owner: 'rehearsal-owner@example.com', crew: 'rehearsal-crew@example.com', suspended: 'rehearsal-old@example.com', notes: 250, files: 40, vectors: 45, dimensions: 768 };
const q = (s) => (s === null ? 'NULL' : `'${String(s).replace(/'/g, "''")}'`);

export function generate(outdir) {
  fs.mkdirSync(path.join(outdir, 'files'), { recursive: true });
  const sql = [];
  const add = (s) => sql.push(s.trim().replace(/;?$/, ';'));
  add('ALTER TABLE tasks ADD COLUMN priority TEXT');
  add('CREATE TABLE lazy_things (id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT)');
  const longText = 'Synthetic long address line. '.repeat(700);   // about 20 KB
  const customers = [["O'Brien \"Big\" Dlamini", '1 Main Rd', 7.5], ['José 🙂 Ñandú', null, null], ['multi\nline\ttab', longText, 0.1], ['Plain Name', '', 10], ['Deleted Soon', 'x', null]];
  for (const [name, address, ret] of customers) add(`INSERT INTO customers (name, address, retention_percent) VALUES (${q(name)}, ${q(address)}, ${ret === null ? 'NULL' : ret})`);
  add("DELETE FROM customers WHERE name = 'Deleted Soon'");   // the highest id is gone: the counter must still say 5
  add(`INSERT INTO invoices (customer_id, description, amount, retention_amount) VALUES (1, ${q('floor "A" 🙂')}, 1500.5, 0), (3, 'blinds', 820, 0)`);
  add(`INSERT INTO payments (customer_id, amount, source_transcript, invoice_id) VALUES (1, 500.25, ${q('Jenny paid R500')}, 1)`);
  add(`INSERT INTO tasks (description, done, priority) VALUES (${q('call Jenny')}, 0, 'high'), (${q('quote ✓')}, 1, NULL)`);
  add(`INSERT INTO expenses (description, source_transcript, amount) VALUES ('fuel', ${q('spent R850')}, 850.25)`);
  add(`INSERT INTO stock_items (name, unit, quantity_on_hand) VALUES ('Underlay', 'm2', 12.5)`);
  add("INSERT INTO lazy_things (label) VALUES ('one'), ('two')");
  add(`INSERT INTO memberships (google_email, role, status) VALUES (${q(SYNTHETIC.owner)}, 'owner', 'active'), (${q(SYNTHETIC.crew)}, 'installer', 'active'), (${q(SYNTHETIC.suspended)}, 'installer', 'suspended')`);
  fs.writeFileSync(path.join(outdir, 'seed.sql'), sql.join('\n') + '\n');

  const kv = [];
  for (let i = 1; i <= SYNTHETIC.notes; i++) kv.push({ key: `customer:${i}`, value: JSON.stringify({ id: i, note: `REHEARSAL note ${i} 🙂 "quoted"`, n: i * 1.5 }) });
  fs.writeFileSync(path.join(outdir, 'kv.json'), JSON.stringify(kv));

  const files = [];
  for (let i = 1; i <= SYNTHETIC.files; i++) {
    const bytes = Buffer.alloc(300 + i * 11);
    for (let j = 0; j < bytes.length; j++) bytes[j] = (i * 31 + j * 7) & 255;
    const key = `${['voice-notes', 'documents', 'photos', 'logos'][i % 4]}/file-${i}.bin`;
    const file = `f${String(i).padStart(3, '0')}.bin`;
    fs.writeFileSync(path.join(outdir, 'files', file), bytes);
    files.push({ key, file, contentType: i % 2 ? 'audio/mp4' : 'image/png' });
  }
  fs.writeFileSync(path.join(outdir, 'files.json'), JSON.stringify(files));

  const lines = [];
  for (let i = 1; i <= SYNTHETIC.vectors; i++) {
    const values = new Array(SYNTHETIC.dimensions).fill(0); values[(i * 7) % SYNTHETIC.dimensions] = 1;   // one-hot: each memory is the nearest match of exactly itself
    lines.push(JSON.stringify({ id: `pmf-${i}`, values, metadata: { customerId: '1', text: `REHEARSAL memory ${i}` } }));
  }
  fs.writeFileSync(path.join(outdir, 'vectors.ndjson'), lines.join('\n') + '\n');

  const expected = { customers: 4, customerCounter: 5, notes: SYNTHETIC.notes, files: SYNTHETIC.files, vectors: SYNTHETIC.vectors, activeMembers: 2, nextCustomerId: 6, probeMemory: { index: 1, text: 'REHEARSAL memory 1', hotDimension: 7 } };
  fs.writeFileSync(path.join(outdir, 'expected.json'), JSON.stringify(expected, null, 1));
  return expected;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!process.argv[2]) { console.error('usage: node tools/seed-synthetic.mjs <outdir>'); process.exit(2); }
  console.log(JSON.stringify(generate(process.argv[2])));
}
