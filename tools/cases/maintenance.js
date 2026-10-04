// Characterization cases for the maintenance tools reached with the admin key (not a session): so far, merging the duplicate
// stock rows that exist from before registering a stock item became idempotent. The tool is a DRY RUN unless it is sent
// {"confirm": true}, so what would change is always shown first. A set whose units differ is skipped, never guessed at.
module.exports = function cases(caps) {
  const dupes = (db) => db.exec(`
    INSERT INTO stock_items (id, name, unit, quantity_on_hand) VALUES (1, 'Screed', 'bags', 15), (2, 'screed', 'bags', 0), (3, 'Adhesive', 'litres', 8);
    INSERT INTO stock_usage_log (stock_item_id, quantity_used, source_transcript) VALUES (1, 3, 'used 3 bags of screed'), (2, 1, 'used 1 bag of screed');
    INSERT INTO stocktakes (id, source_transcript, created_at) VALUES (1, 'counted the screed', '2026-10-01 08:00:00');
    INSERT INTO stocktake_lines (stocktake_id, stock_item_id, quantity_counted, quantity_expected, variance) VALUES (1, 2, 0, 0, 0);
  `);
  const noDupes = (db) => db.exec(`INSERT INTO stock_items (id, name, unit, quantity_on_hand) VALUES (1, 'Screed', 'bags', 15), (2, 'Adhesive', 'litres', 8);`);
  const differentUnits = (db) => db.exec(`INSERT INTO stock_items (id, name, unit, quantity_on_hand) VALUES (1, 'Screed', 'bags', 15), (2, 'screed', 'kg', 40), (3, 'Adhesive', 'litres', 8);`);
  const three = (db) => db.exec(`
    INSERT INTO stock_items (id, name, unit, quantity_on_hand) VALUES (1, 'Grout', NULL, 2), (2, ' GROUT ', 'bags', 5), (3, 'grout', 'bags', 1.5);
  `);
  const m = (name, seed, body, extra) => ({ kind: 'route', name, seed, path: '/debug/merge-stock-items', admin: true, before: [], ai: [], ...(body === undefined ? {} : { body }), ...(extra || {}) });
  return [
    m('merge stock items: a dry run lists the duplicates and changes nothing', dupes),
    m('merge stock items: confirmed, the earliest row is kept and the history follows it', dupes, { confirm: true }),
    m('merge stock items: nothing is duplicated', noDupes, { confirm: true }),
    m('merge stock items: a set whose units differ is skipped, not guessed at', differentUnits, { confirm: true }),
    m('merge stock items: three rows with names that differ only in case and spaces, one without a unit', three, { confirm: true }),
    m('merge stock items: run again after a merge, there is nothing left to do', dupes, { confirm: true }, { before: [{ route: true, method: 'POST', path: '/debug/merge-stock-items', admin: true, body: { confirm: true } }] }),
    m('merge stock items: a request that is not exactly confirm:true is only a dry run', dupes, { confirm: 'yes' }),
    { kind: 'route', name: 'merge stock items: no admin key is refused', seed: dupes, path: '/debug/merge-stock-items', noSession: true, before: [], ai: [], body: { confirm: true } },
    { kind: 'route', name: 'merge stock items: a signed-in owner without the admin key is refused', seed: dupes, path: '/debug/merge-stock-items', role: 'owner', before: [], ai: [], body: { confirm: true } },
  ];
};
