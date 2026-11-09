// Schema fit, second set (branch engine-phase1): the FIVE domains docs/decisions/first-slice.md part F listed as having no engine shape and no walk: INVENTORY (6), CUSTOMER SERVICE (10), ASSETS (12), MARKETING (13) and CRM COMMUNICATIONS (2).
// Same method and the same STOP RULE as tools/engine-fit.test.js: the later domains' tables (tf2_*) exist ONLY in this test, written as a later migration would write them (they POINT AT the foundation tables and the foundation is never altered); everything derived (on-hand stock,
// book value, a case's status, a campaign's conversion, the last contact) is derived the way a capability would, from facts and links; if any walk needed a column on an engine table the stop rule below would fail and the foundation would be corrected, not defended.
// What this shows: that the foundation CAN carry these five without changing shape. What it does not: that they are built (nothing here is a capability, a route or a screen), that the shapes below are the right ones for a real inventory or service desk, or anything about production.
const kit = require('./engine-kit.js');

module.exports = kit.guard('engine fit domains', async ({ check }) => {
  const eng = kit.loadEngine();
  check(Boolean(eng), 'the engine module builds');
  if (!eng) return;
  const { facts, ledger } = eng;
  const CTX = { actorEmail: 'fit@example.com', contract: 'fit', contractVersion: 1 };
  const w = kit.makeWorld(); w.configure({ mode: 'engine', available: kit.ALL_CAPABILITIES });
  const db = w.db;
  const signature = (d) => JSON.stringify(d.prepare("SELECT name, sql FROM sqlite_master WHERE name LIKE 'eng\\_%' ESCAPE '\\' ORDER BY name").all().map((r) => [r.name, r.sql]));
  const before = signature(db);

  db.exec(`
    CREATE TABLE tf2_item (id INTEGER PRIMARY KEY AUTOINCREMENT, sku TEXT NOT NULL UNIQUE, name TEXT NOT NULL, event_id INTEGER NOT NULL REFERENCES eng_event(id));
    CREATE TABLE tf2_stock_move (id INTEGER PRIMARY KEY AUTOINCREMENT, item_id INTEGER NOT NULL REFERENCES tf2_item(id), kind TEXT NOT NULL CHECK (kind IN ('receive','issue','adjust','reserve','release')), quantity_milli INTEGER NOT NULL CHECK (quantity_milli > 0), sign INTEGER NOT NULL CHECK (sign IN (-1, 1)), source_document_id INTEGER REFERENCES eng_document(id), reason TEXT, event_id INTEGER NOT NULL REFERENCES eng_event(id));
    CREATE TABLE tf2_price (id INTEGER PRIMARY KEY AUTOINCREMENT, item_id INTEGER NOT NULL REFERENCES tf2_item(id), party_role TEXT NOT NULL, price_minor INTEGER NOT NULL, valid_from TEXT NOT NULL, event_id INTEGER NOT NULL REFERENCES eng_event(id));
    CREATE TABLE tf2_case (id INTEGER PRIMARY KEY AUTOINCREMENT, party_id INTEGER NOT NULL REFERENCES eng_party(id), kind TEXT NOT NULL CHECK (kind IN ('complaint','query')), subject TEXT NOT NULL, event_id INTEGER NOT NULL REFERENCES eng_event(id));
    CREATE TABLE tf2_case_event (id INTEGER PRIMARY KEY AUTOINCREMENT, case_id INTEGER NOT NULL REFERENCES tf2_case(id), type TEXT NOT NULL, actor_party_id INTEGER REFERENCES eng_party(id), capture_id INTEGER REFERENCES captures(id), event_id INTEGER NOT NULL REFERENCES eng_event(id));
    CREATE TABLE tf2_case_document (case_id INTEGER NOT NULL REFERENCES tf2_case(id), document_id INTEGER NOT NULL REFERENCES eng_document(id), role TEXT NOT NULL, PRIMARY KEY (case_id, document_id, role));
    CREATE TABLE tf2_asset (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, acquired_document_id INTEGER NOT NULL REFERENCES eng_document(id), acquired_on TEXT NOT NULL, cost_minor INTEGER NOT NULL, life_months INTEGER NOT NULL CHECK (life_months > 0), event_id INTEGER NOT NULL REFERENCES eng_event(id));
    CREATE TABLE tf2_asset_event (id INTEGER PRIMARY KEY AUTOINCREMENT, asset_id INTEGER NOT NULL REFERENCES tf2_asset(id), type TEXT NOT NULL CHECK (type IN ('assigned','maintained','disposed')), worker_party_id INTEGER REFERENCES eng_party(id), document_id INTEGER REFERENCES eng_document(id), occurred_on TEXT NOT NULL, event_id INTEGER NOT NULL REFERENCES eng_event(id));
    CREATE TABLE tf2_campaign (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, channel TEXT NOT NULL, event_id INTEGER NOT NULL REFERENCES eng_event(id));
    CREATE TABLE tf2_touch (id INTEGER PRIMARY KEY AUTOINCREMENT, campaign_id INTEGER NOT NULL REFERENCES tf2_campaign(id), party_id INTEGER NOT NULL REFERENCES eng_party(id), capture_id INTEGER REFERENCES captures(id), event_id INTEGER NOT NULL REFERENCES eng_event(id));
    CREATE TABLE tf2_communication (id INTEGER PRIMARY KEY AUTOINCREMENT, party_id INTEGER NOT NULL REFERENCES eng_party(id), channel TEXT NOT NULL CHECK (channel IN ('call','whatsapp','email','visit')), direction TEXT NOT NULL CHECK (direction IN ('in','out')), capture_id INTEGER REFERENCES captures(id), document_id INTEGER REFERENCES eng_document(id), event_id INTEGER NOT NULL REFERENCES eng_event(id));
  `);
  const ev = (type, payload = {}) => Number(db.prepare("INSERT INTO eng_event (type, actor_email, contract, contract_version, payload_json) VALUES (?, 'fit@example.com', 'fit', 1, ?) RETURNING id").get(type, JSON.stringify(payload)).id);
  const cap = (text) => Number(db.prepare("INSERT INTO captures (raw_text, source) VALUES (?, 'fit') RETURNING id").get(text).id);
  const doc = (kind, direction, partyId, lines, issuedOn = '2026-10-01') => facts.recordDocument(w.env, { kind, direction, partyId, currency: 'ZAR', issuedOn, lines }, CTX);
  const line = (description, quantityMilli, unitPriceMinor, taxBp = 1500) => ({ description, quantityMilli, unit: 'unit', unitPriceMinor, taxBp });
  const party = async (name, roles) => (await facts.recordParty(w.env, { kind: 'organisation', name, roles }, CTX)).id;
  const customer = await party('Mokoena Builders', ['customer']), supplier = await party('Floor Supplies', ['supplier']), fitter = await party('Sipho', ['worker']), lead = await party('Zulu Interiors', ['lead']), lead2 = await party('Naidoo Homes', ['lead']);

  // ---- 6. INVENTORY: an item, stock moves sourced from documents, on-hand, reserved, available, valuation, a price list that changes ------------------------------------------------------------------
  const item = Number(db.prepare("INSERT INTO tf2_item (sku, name, event_id) VALUES ('PLANK-18', 'Plank 18mm', ?) RETURNING id").get(ev('item.created')).id);
  const move = (kind, sign, qtyMilli, documentId, reason = null) => db.prepare('INSERT INTO tf2_stock_move (item_id, kind, quantity_milli, sign, source_document_id, reason, event_id) VALUES (?, ?, ?, ?, ?, ?, ?)').run(item, kind, qtyMilli, sign, documentId, reason, ev('stock.' + kind));
  const bought = await doc('supplier_invoice', 'buy', supplier, [line('Plank 18mm', 100000, 5000)]);   // 100.000 at R50.00
  move('receive', 1, 100000, bought.id);
  const sold = await doc('invoice', 'sell', customer, [line('Plank 18mm', 30000, 8000)]);               // 30.000 at R80.00
  move('issue', -1, 30000, sold.id);
  const quote = await doc('quotation', 'sell', customer, [line('Plank 18mm', 20000, 8000)]);
  move('reserve', 1, 20000, quote.id);
  move('adjust', -1, 2000, null, 'stock count: 2.000 damaged and written off');
  const onHand = () => Number(db.prepare("SELECT COALESCE(SUM(CASE WHEN kind IN ('receive','issue','adjust') THEN sign * quantity_milli END), 0) AS n FROM tf2_stock_move WHERE item_id = ?").get(item).n);
  const reserved = () => Number(db.prepare("SELECT COALESCE(SUM(CASE kind WHEN 'reserve' THEN quantity_milli WHEN 'release' THEN -quantity_milli END), 0) AS n FROM tf2_stock_move WHERE item_id = ?").get(item).n);
  check(onHand() === 68000 && reserved() === 20000 && onHand() - reserved() === 48000, 'inventory: 100 received, 30 issued, 2 written off leaves 68.000 on hand; 20.000 reserved for a quotation leaves 48.000 available: all derived from stock moves, none stored as a state');
  const avgCostMinor = () => { const r = db.prepare("SELECT SUM(l.quantity_milli) AS q, SUM(l.quantity_milli * l.unit_price_minor) AS v FROM tf2_stock_move m JOIN eng_document_line l ON l.document_id = m.source_document_id WHERE m.item_id = ? AND m.kind = 'receive'").get(item); return Math.round(r.v / r.q); };
  check(avgCostMinor() === 5000 && Math.round(onHand() * avgCostMinor() / 1000) === 340000, 'stock is valued from what it cost: the weighted average cost comes from the supplier invoice lines the stock arrived on (R50.00), so 68 on hand are worth R3,400.00');
  move('release', 1, 20000, quote.id);
  check(reserved() === 0 && onHand() - reserved() === 68000, 'releasing a reservation is its own move, and the quotation it was held for is untouched');
  const price = (role, minor, from) => db.prepare('INSERT INTO tf2_price (item_id, party_role, price_minor, valid_from, event_id) VALUES (?, ?, ?, ?, ?)').run(item, role, minor, from, ev('price.set'));
  price('customer', 8000, '2026-10-01'); price('customer', 9000, '2026-11-01');
  const priceOn = (role, date) => (db.prepare('SELECT price_minor AS p FROM tf2_price WHERE item_id = ? AND party_role = ? AND valid_from <= ? ORDER BY valid_from DESC LIMIT 1').get(item, role, date) || {}).p;
  check(priceOn('customer', '2026-10-15') === 8000 && priceOn('customer', '2026-11-15') === 9000, 'a price list is effective-dated rows, and the price on a date is the latest one in force at that date');
  const soldLine = db.prepare('SELECT unit_price_minor AS p FROM eng_document_line WHERE document_id = ?').get(sold.id).p;
  check(soldLine === 8000, 'and a later price change never reaches back: the invoice already issued still carries the price it was issued at');

  // ---- 10. CUSTOMER SERVICE: a complaint about an invoice, assigned, remedied by a credit note, replied to, resolved ---------------------------------------------------------------------------------------
  const theCase = Number(db.prepare("INSERT INTO tf2_case (party_id, kind, subject, event_id) VALUES (?, 'complaint', 'Damaged boards on the invoice', ?) RETURNING id").get(customer, ev('case.opened')).id);
  const caseEv = (type, actor = null, capture = null) => db.prepare('INSERT INTO tf2_case_event (case_id, type, actor_party_id, capture_id, event_id) VALUES (?, ?, ?, ?, ?)').run(theCase, type, actor, capture, ev('case.' + type));
  caseEv('opened', null, cap('Sipho, the boards on the last job were damaged, you charged me full price'));
  db.prepare("INSERT INTO tf2_case_document (case_id, document_id, role) VALUES (?, ?, 'subject')").run(theCase, sold.id);
  caseEv('assigned', fitter);
  const caseStatus = () => (db.prepare('SELECT type FROM tf2_case_event WHERE case_id = ? ORDER BY id DESC LIMIT 1').get(theCase) || {}).type;
  check(caseStatus() === 'assigned', 'customer service: a case is a record about a party and a document; its status is the LAST event on it (derived), not a column');
  const credit = await doc('credit_note', 'sell', customer, [line('Damaged boards', 1000, 8000)], '2026-10-20');
  db.prepare("INSERT INTO tf2_case_document (case_id, document_id, role) VALUES (?, ?, 'remedy')").run(theCase, credit.id);
  caseEv('replied', fitter, cap('Sorry about that, I have issued a credit note for the damaged boards')); caseEv('resolved', fitter);
  const grossOf = async (ids) => { let n = 0; for (const id of ids) n += (await ledger.documentTotals(w.env, id)).grossMinor; return n; };
  const remedy = await grossOf(db.prepare("SELECT document_id AS id FROM tf2_case_document WHERE case_id = ? AND role = 'remedy'").all(theCase).map((r) => r.id));
  check(caseStatus() === 'resolved' && remedy === credit.totals.grossMinor && remedy === 9200, 'the remedy is a document of its own linked to the case (a credit note of R92.00 with tax), the case is resolved by an event, and the words the customer and the business said are the verbatim captures');
  const open = (partyId) => Number(db.prepare("SELECT COUNT(*) AS n FROM tf2_case c WHERE c.party_id = ? AND COALESCE((SELECT type FROM tf2_case_event WHERE case_id = c.id ORDER BY id DESC LIMIT 1), 'opened') <> 'resolved'").get(partyId).n);
  check(open(customer) === 0, 'and "open cases for this customer" is derived the same way: none now');

  // ---- 12. ASSETS: a purchased asset, assigned to a worker, maintained, depreciated straight-line, disposed -----------------------------------------------------------------------------------------------
  const buy = await doc('supplier_invoice', 'buy', supplier, [line('Table saw', 1000, 1200000, 0)], '2026-01-01');   // R12,000.00, no tax
  const asset = Number(db.prepare("INSERT INTO tf2_asset (name, acquired_document_id, acquired_on, cost_minor, life_months, event_id) VALUES ('Table saw', ?, '2026-01-01', ?, 60, ?) RETURNING id").get(buy.id, buy.totals.grossMinor, ev('asset.acquired')).id);
  const assetEv = (type, worker, documentId, on) => db.prepare('INSERT INTO tf2_asset_event (asset_id, type, worker_party_id, document_id, occurred_on, event_id) VALUES (?, ?, ?, ?, ?, ?)').run(asset, type, worker, documentId, on, ev('asset.' + type));
  assetEv('assigned', fitter, null, '2026-01-05');
  const service = await doc('supplier_invoice', 'buy', supplier, [line('Blade sharpening', 1000, 25000, 0)], '2026-06-10');
  assetEv('maintained', null, service.id, '2026-06-10');
  const holder = () => (db.prepare("SELECT worker_party_id AS w FROM tf2_asset_event WHERE asset_id = ? AND type = 'assigned' ORDER BY id DESC LIMIT 1").get(asset) || {}).w;
  const monthsBetween = (a, b) => (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + (Number(b.slice(5, 7)) - Number(a.slice(5, 7)));
  const bookValue = (on) => { const a = db.prepare('SELECT * FROM tf2_asset WHERE id = ?').get(asset); const gone = db.prepare("SELECT 1 FROM tf2_asset_event WHERE asset_id = ? AND type = 'disposed' AND occurred_on <= ?").get(asset, on); if (gone) return 0; const used = Math.min(a.life_months, Math.max(0, monthsBetween(a.acquired_on, on))); return Math.round(a.cost_minor * (a.life_months - used) / a.life_months); };
  check(holder() === fitter && bookValue('2026-07-01') === 1080000 && bookValue('2026-01-01') === 1200000, 'assets: the current holder is the last assignment, and straight-line book value over 60 months is R10,800.00 after 6 months (54 of 60 months left of R12,000.00), derived from the cost on the supplier invoice');
  const upkeep = await grossOf(db.prepare("SELECT document_id AS id FROM tf2_asset_event WHERE asset_id = ? AND type = 'maintained'").all(asset).map((r) => r.id));
  check(upkeep === 25000, 'maintenance is a supplier invoice linked to the asset: R250.00 of upkeep, derived');
  assetEv('disposed', null, null, '2026-09-30');
  check(bookValue('2026-10-15') === 0 && bookValue('2026-07-01') === 1080000, 'a disposal is an event: the book value after it is nothing, and what it was before it is unchanged (derived by date)');

  // ---- 13. MARKETING: a campaign, touches of leads (parties with the role lead), conversion to a sale, revenue attributed --------------------------------------------------------------------------------
  const campaign = Number(db.prepare("INSERT INTO tf2_campaign (name, channel, event_id) VALUES ('Spring flooring special', 'whatsapp', ?) RETURNING id").get(ev('campaign.created')).id);
  const touch = (partyId, text) => db.prepare('INSERT INTO tf2_touch (campaign_id, party_id, capture_id, event_id) VALUES (?, ?, ?, ?)').run(campaign, partyId, cap(text), ev('campaign.touch'));
  touch(lead, 'Hi Zulu, we have a spring special on vinyl planks this month'); touch(lead2, 'Hi Naidoo, we have a spring special on vinyl planks this month');
  const leadSale = await doc('invoice', 'sell', lead, [line('Vinyl plank', 20000, 8000)], '2026-10-12');   // gross 184000
  const touched = () => Number(db.prepare('SELECT COUNT(DISTINCT party_id) AS n FROM tf2_touch WHERE campaign_id = ?').get(campaign).n);
  const converted = () => Number(db.prepare("SELECT COUNT(DISTINCT t.party_id) AS n FROM tf2_touch t WHERE t.campaign_id = ? AND EXISTS (SELECT 1 FROM eng_document d WHERE d.party_id = t.party_id AND d.direction = 'sell' AND d.kind IN ('invoice','quotation'))").get(campaign).n);
  check(touched() === 2 && converted() === 1 && Math.round(converted() * 10000 / touched()) === 5000, 'marketing: two leads touched by a campaign, one of them later bought: a conversion of 50.00% (5000 basis points), derived from the touches and the documents, with no "converted" flag anywhere');
  const attributed = await grossOf(db.prepare("SELECT id FROM eng_document WHERE direction = 'sell' AND kind = 'invoice' AND party_id IN (SELECT party_id FROM tf2_touch WHERE campaign_id = ?)").all(campaign).map((r) => r.id));
  check(attributed === leadSale.totals.grossMinor && attributed === 184000, 'and the revenue the campaign is credited with is the sum of the sales invoices of the parties it touched (R1,840.00)');

  // ---- 2. CRM COMMUNICATIONS: calls and messages against a party, with the words verbatim, linked to a document where one is the subject --------------------------------------------------------------------
  const comm = (partyId, channel, direction, text, documentId = null) => db.prepare('INSERT INTO tf2_communication (party_id, channel, direction, capture_id, document_id, event_id) VALUES (?, ?, ?, ?, ?, ?)').run(partyId, channel, direction, cap(text), documentId, ev('comm.' + direction));
  comm(customer, 'call', 'in', 'Customer called asking when the invoice will be corrected', sold.id);
  comm(customer, 'whatsapp', 'out', 'Told the customer the credit note is on its way', credit.id);
  comm(customer, 'whatsapp', 'in', 'Thanks, can you also quote the skirting?');
  const last = (partyId) => db.prepare('SELECT channel, direction FROM tf2_communication WHERE party_id = ? ORDER BY id DESC LIMIT 1').get(partyId);
  const unanswered = (partyId) => { const lastOut = Number((db.prepare("SELECT COALESCE(MAX(id), 0) AS n FROM tf2_communication WHERE party_id = ? AND direction = 'out'").get(partyId)).n); return Number(db.prepare("SELECT COUNT(*) AS n FROM tf2_communication WHERE party_id = ? AND direction = 'in' AND id > ?").get(partyId, lastOut).n); };
  check(last(customer).channel === 'whatsapp' && last(customer).direction === 'in' && unanswered(customer) === 1, 'CRM communications: the last contact with a customer, and how many of their messages are still unanswered, are derived from the communications (one inbound message after our last reply)');
  const bySubject = Number(db.prepare('SELECT COUNT(*) AS n FROM tf2_communication WHERE document_id = ?').get(sold.id).n);
  check(bySubject === 1 && Number(db.prepare("SELECT COUNT(*) AS n FROM tf2_communication c JOIN captures k ON k.id = c.capture_id WHERE c.party_id = ?").get(customer).n) === 3, 'every communication keeps its words as a verbatim capture, and a document can be the subject of one');

  // ---- THE STOP RULE -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const probe = kit.makeWorld(); const probeBefore = signature(probe.db); probe.db.exec('ALTER TABLE eng_allocation ADD COLUMN sneaky TEXT');
  check(signature(probe.db) !== probeBefore, 'CONTROL: a column added to a foundation table WOULD change the signature this suite compares, so the stop rule below can fail');
  check(signature(db) === before, 'THE STOP RULE: after inventory, customer service, assets, marketing and CRM communications, NOT ONE foundation table changed shape (no column added, none altered)');
  const v = await eng.verifyIntegrity(w.env);
  check(v.ok, 'and the books verify clean after all of it: ' + JSON.stringify(v.problems).slice(0, 160));
});

if (require.main === module) kit.standalone(module.exports);
