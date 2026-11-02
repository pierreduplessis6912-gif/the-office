// Restore verification after a column-adding migration (branch engine-phase1; found by the staging rehearsal of 2026-11-02, run 41445346938). TESTS FIRST. The migration rules allow `ALTER TABLE ... ADD COLUMN`, and a restore of an
// OLDER snapshot onto a table that has since gained a column must not cry wolf: the data in the snapshot's columns comes back exactly and the new column simply holds its default. Until now the restore verified by hashing every
// LIVE column, so it reported `table customers: same row count (101) but the contents differ` and `ok: false` for a restore that had worked, and an operator could not tell that from real damage.
// The fix hashes the live rows over the SNAPSHOT'S columns. It must stay sensitive: a changed value in a snapshot column, or a snapshot column that has gone missing, is still a difference.
const kit = require('./engine-kit.js');

module.exports = kit.guard('restore after an added column', async ({ check }) => {
  const bk = kit.bundle('backup.ts', 'backup'), mig = kit.bundle('migration.ts', 'migration');
  const build = () => {
    const w = kit.makeWorld({ backups: true });
    for (let i = 1; i <= 40; i++) w.db.prepare('INSERT INTO customers (name, address) VALUES (?, ?)').run('Customer ' + i, 'Street ' + i);
    const cols = w.db.prepare('PRAGMA table_info(customers)').all().map((c) => c.name);
    return { w, cols, original: () => JSON.stringify(w.db.prepare('SELECT ' + cols.join(',') + ' FROM customers ORDER BY id').all()) };
  };

  // ---- the restore itself --------------------------------------------------------------------------------------------------------------------------------------------------------------------
  let { w, original } = build();
  let snap = await bk.takeSnapshot(w.env, new Date('2026-11-02T03:00:00Z')); const before = original();
  w.db.prepare("INSERT INTO customers (name) VALUES ('DAMAGE')").run();
  let rep = await bk.restoreSnapshot(w.env, snap.name, 'eng-a');
  check(rep.ok === true && rep.differences.length === 0, 'CONTROL: with no column added the restore verifies clean');

  ({ w, original } = build());
  snap = await bk.takeSnapshot(w.env, new Date('2026-11-02T03:00:00Z'));
  const ref = original();
  w.db.exec("ALTER TABLE customers ADD COLUMN probe_1101 TEXT DEFAULT 'run1101'");   // a later migration adds a column, as the staging rehearsal's probe does
  w.db.prepare("INSERT INTO customers (name) VALUES ('DAMAGE')").run();
  rep = await bk.restoreSnapshot(w.env, snap.name, 'eng-a');
  check(rep.ok === true && rep.differences.length === 0, 'a restore of an OLDER snapshot onto a table that has gained a column verifies clean: ' + JSON.stringify(rep.differences));
  check(original() === ref && w.count('customers') === 40 && w.db.prepare("SELECT COUNT(*) AS n FROM customers WHERE name = 'DAMAGE'").get().n === 0, 'and the data in the snapshot\'s columns is back exactly, the damage gone');
  check(w.db.prepare("SELECT COUNT(*) AS n FROM customers WHERE probe_1101 = 'run1101'").get().n === 40, 'and the added column is still there, holding its default on every restored row');

  // ---- the verification stays SENSITIVE: hashing over the snapshot's columns must not blind it --------------------------------------------------------------------------------------------
  const x = build(); const only = { customers: x.cols };
  const fp = async (restrict) => (await mig.fingerprint(x.w.env, restrict)).tables.customers.hash;
  const base = await fp(only);
  check(base === (await fp(undefined)), 'with no extra column the restricted fingerprint equals the full one (restricting changes nothing that was there)');
  x.w.db.exec("ALTER TABLE customers ADD COLUMN extra_col TEXT DEFAULT 'a'");
  check((await fp(only)) === base && (await fp(undefined)) !== base, 'a column added since is ignored by the restricted fingerprint and seen by the full one');
  x.w.db.prepare("UPDATE customers SET extra_col = 'changed'").run();
  check((await fp(only)) === base, 'and changing the added column\'s values does not move it');
  x.w.db.prepare("UPDATE customers SET address = 'tampered' WHERE id = 7").run();
  check((await fp(only)) !== base, 'but changing one value in a SNAPSHOT column does: the difference is still detected');
  x.w.db.prepare("UPDATE customers SET address = 'Street 7' WHERE id = 7").run();
  check((await fp(only)) === base, 'control: putting it back restores the hash');
  const gone = build();
  gone.w.db.exec('ALTER TABLE customers DROP COLUMN address');
  check((await mig.fingerprint(gone.w.env, { customers: gone.cols })).tables.customers.hash !== base, 'a snapshot column that has gone missing from the live table is a difference too');
});

if (require.main === module) kit.standalone(module.exports);
