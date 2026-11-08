// Schema fit (branch engine-phase1): can the foundations carry the OTHER domains without changing? These are executable walk-throughs of the representative cross-domain relationships. The later domains' tables
// (tf_*) exist ONLY in this test, written as a later migration would write them: they point at the foundation tables, and the foundation tables are never altered. THE STOP RULE: if any lifecycle needs a column
// on an engine table, this suite fails and the foundation is corrected before anything is built on it, not defended because it exists. What the walk-throughs derive (fulfilment, variance, profitability) is
// derived the way a capability would, from facts and links; the engine core knows no document kind and no lifecycle.
const kit = require('./engine-kit.js');

module.exports = kit.guard('engine fit', async ({ check }) => {
  const eng = kit.loadEngine();
  check(Boolean(eng), 'the engine module builds');
  if (!eng) return;
  const { facts, ledger, drafts } = eng;
  const CTX = { actorEmail: 'fit@example.com', contract: 'fit', contractVersion: 1 };
  const w = kit.makeWorld(); w.configure({ mode: 'engine', available: kit.ALL_CAPABILITIES });
  const db = w.db;
  const shape = () => JSON.stringify(['eng_config', 'eng_event', 'eng_party', 'eng_party_role', 'eng_draft', 'eng_document', 'eng_document_line', 'eng_document_number', 'eng_money_movement', 'eng_allocation', 'eng_reversal', 'eng_interpretation', 'eng_observation'].map((t) => [t, db.prepare(`PRAGMA table_info(${t})`).all().map((c) => [c.name, c.type, c.notnull, c.pk])]));
  const shapeBefore = shape();

  // the later domains, as later migrations would write them: new tables that POINT AT the foundation, nothing altered
  db.exec(`
    CREATE TABLE tf_document_link (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, from_document_id INTEGER NOT NULL REFERENCES eng_document(id), to_document_id INTEGER NOT NULL REFERENCES eng_document(id), quantity_milli INTEGER, event_id INTEGER NOT NULL REFERENCES eng_event(id));
    CREATE TABLE tf_movement_source (movement_id INTEGER PRIMARY KEY REFERENCES eng_money_movement(id), document_id INTEGER NOT NULL REFERENCES eng_document(id), event_id INTEGER NOT NULL REFERENCES eng_event(id));
    CREATE TABLE tf_work_item (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, parent_id INTEGER REFERENCES tf_work_item(id), party_id INTEGER REFERENCES eng_party(id), title TEXT NOT NULL, event_id INTEGER NOT NULL REFERENCES eng_event(id));
    CREATE TABLE tf_plan_line (id INTEGER PRIMARY KEY AUTOINCREMENT, work_item_id INTEGER NOT NULL REFERENCES tf_work_item(id), resource_kind TEXT NOT NULL, quantity_milli INTEGER NOT NULL, unit_cost_minor INTEGER NOT NULL);
    CREATE TABLE tf_time_entry (id INTEGER PRIMARY KEY AUTOINCREMENT, work_item_id INTEGER NOT NULL REFERENCES tf_work_item(id), worker_party_id INTEGER NOT NULL REFERENCES eng_party(id), minutes INTEGER NOT NULL, rate_minor_per_hour INTEGER NOT NULL, event_id INTEGER NOT NULL REFERENCES eng_event(id));
    CREATE TABLE tf_attribution (id INTEGER PRIMARY KEY AUTOINCREMENT, document_id INTEGER NOT NULL REFERENCES eng_document(id), work_item_id INTEGER NOT NULL REFERENCES tf_work_item(id), side TEXT NOT NULL CHECK (side IN ('revenue', 'cost')), amount_minor INTEGER NOT NULL, event_id INTEGER NOT NULL REFERENCES eng_event(id));
    CREATE TABLE tf_assignment (id INTEGER PRIMARY KEY AUTOINCREMENT, work_item_id INTEGER NOT NULL REFERENCES tf_work_item(id), worker_party_id INTEGER NOT NULL REFERENCES eng_party(id), event_id INTEGER NOT NULL REFERENCES eng_event(id));
    CREATE TABLE tf_work_event (id INTEGER PRIMARY KEY AUTOINCREMENT, work_item_id INTEGER NOT NULL REFERENCES tf_work_item(id), type TEXT NOT NULL, actor_party_id INTEGER REFERENCES eng_party(id), evidence_capture_id INTEGER REFERENCES captures(id), event_id INTEGER NOT NULL REFERENCES eng_event(id));
  `);
  const ev = (type, payload = {}) => Number(db.prepare("INSERT INTO eng_event (type, actor_email, contract, contract_version, payload_json) VALUES (?, 'fit@example.com', 'fit', 1, ?) RETURNING id").get(type, JSON.stringify(payload)).id);
  const link = (kind, from, to, qty = null) => db.prepare('INSERT INTO tf_document_link (kind, from_document_id, to_document_id, quantity_milli, event_id) VALUES (?, ?, ?, ?, ?)').run(kind, from, to, qty, ev('link.' + kind));
  const qty = (kind, to) => Number(db.prepare('SELECT COALESCE(SUM(quantity_milli), 0) AS n FROM tf_document_link WHERE kind = ? AND to_document_id = ?').get(kind, to).n);
  const doc = (kind, direction, partyId, lines, issuedOn = '2026-10-01') => facts.recordDocument(w.env, { kind, direction, partyId, currency: 'ZAR', issuedOn, lines }, CTX);
  const line = (description, quantityMilli, unitPriceMinor, taxBp = 1500) => ({ description, quantityMilli, unit: 'unit', unitPriceMinor, taxBp });
  const party = async (name, roles) => (await facts.recordParty(w.env, { kind: 'organisation', name, roles }, CTX)).id;
  const customer = await party('Mokoena Builders', ['customer']), other = await party('Patel', ['customer']), supplier = await party('Floor Supplies', ['supplier']), fitter = await party('Sipho', ['worker']);

  // ---- 1. SALES: customer -> quotation (revised, accepted) -> sales order -> staged fulfilment -> invoices -> payment, credit, correction -------------------------------------------------------------------
  const q1 = await doc('quotation', 'sell', customer, [line('Floor', 10000, 50000)]);
  const q2 = await doc('quotation', 'sell', customer, [line('Floor', 10000, 48000)]); link('revises', q1.id, q2.id);
  const current = (id) => { const next = db.prepare("SELECT to_document_id AS t FROM tf_document_link WHERE kind = 'revises' AND from_document_id = ?").get(id); return next ? current(next.t) : id; };
  check(current(q1.id) === q2.id, 'a quotation revised becomes a new document and the chain says which is current (from a "revises" link, not a status column)');
  ev('quotation.accepted', { documentId: q2.id });
  const accepted = (id) => Boolean(db.prepare("SELECT 1 FROM eng_event WHERE type = 'quotation.accepted' AND json_extract(payload_json, '$.documentId') = ?").get(id));
  check(accepted(q2.id) && !accepted(q1.id), 'acceptance is an EVENT about the current revision: derived, not a stored state');
  check((await ledger.outstandingForParty(w.env, customer)).totalMinor === 0, 'a quotation is not a debt: the customer owes nothing yet (what is settled by money is configuration, not a rule about names)');
  const order = await doc('sales_order', 'sell', customer, [line('Floor', 10000, 48000)]); link('accepts', q2.id, order.id);
  const d1 = await doc('delivery', 'sell', customer, [line('Floor', 6000, 0, 0)]); link('fulfils', d1.id, order.id, 6000);
  const d2 = await doc('delivery', 'sell', customer, [line('Floor', 4000, 0, 0)]); link('fulfils', d2.id, order.id, 4000);
  check(qty('fulfils', order.id) === 10000, 'an order fulfilled in two stages is fully fulfilled (6.000 + 4.000 of 10.000): what has been delivered is derived from the links');
  const inv1 = await doc('invoice', 'sell', customer, [line('Floor', 6000, 48000)]); link('invoices', inv1.id, order.id, 6000);   // net 288000, tax 43200, gross 331200
  check(qty('invoices', order.id) === 6000 && inv1.totals.grossMinor === 331200, 'partial invoicing: 60% of the order invoiced (R3,312.00 with tax); the other 40% is still to invoice');
  await facts.recordPayment(w.env, { direction: 'in', partyId: customer, amountMinor: 200000, currency: 'ZAR', occurredOn: '2026-10-20', allocations: [{ documentId: inv1.id, amountMinor: 200000 }] }, CTX);
  const cn = await doc('credit_note', 'sell', customer, [line('Damaged boards', 1000, 43478)]); link('credits', cn.id, inv1.id, null);   // gross 50000
  check(cn.totals.grossMinor === 50000, 'a credit note is a document of its own, linked to the invoice it credits');
  const credit = await facts.recordPayment(w.env, { direction: 'in', partyId: customer, amountMinor: cn.totals.grossMinor, currency: 'ZAR', occurredOn: '2026-10-25', method: 'credit', allocations: [{ documentId: inv1.id, amountMinor: cn.totals.grossMinor }] }, CTX);
  db.prepare('INSERT INTO tf_movement_source (movement_id, document_id, event_id) VALUES (?, ?, ?)').run(credit.movementId, cn.id, ev('credit.applied'));
  check((await ledger.outstandingForDocument(w.env, inv1.id)) === 331200 - 200000 - 50000, 'applying the credit is a NON-CASH movement allocated to the invoice, with a link to the credit note: R812.00 is still outstanding (331,200 - 200,000 - 50,000 = 81,200 cents)');
  const wrongMoney = await facts.recordPayment(w.env, { direction: 'in', partyId: other, amountMinor: 40000, currency: 'ZAR', occurredOn: '2026-10-26', allocations: [{ documentId: inv1.id, amountMinor: 40000 }] }, CTX);
  await facts.correctMovement(w.env, { movementId: wrongMoney.movementId, reason: 'recorded against the wrong customer', replacement: { partyId: customer, allocations: [{ documentId: inv1.id, amountMinor: 40000 }] } }, CTX);
  check((await ledger.outstandingForDocument(w.env, inv1.id)) === 41200 && (await ledger.outstandingForParty(w.env, other)).totalMinor === 0, 'a payment recorded against the wrong customer is corrected by reversal and replacement: R412.00 outstanding, the other customer untouched');

  // ---- 2. PURCHASING: supplier -> PO -> partial receipts (an over-delivery) -> supplier invoice (a price variance) -> payment out -----------------------------------------------------------------
  const po = await doc('purchase_order', 'buy', supplier, [line('Planks', 100000, 1000)]);   // 100.000 at R10.00
  const g1 = await doc('goods_received', 'buy', supplier, [line('Planks', 40000, 0, 0)]); link('receives', g1.id, po.id, 40000);
  const g2 = await doc('goods_received', 'buy', supplier, [line('Planks', 70000, 0, 0)]); link('receives', g2.id, po.id, 70000);
  const ordered = db.prepare('SELECT quantity_milli AS q, unit_price_minor AS p FROM eng_document_line WHERE document_id = ?').get(po.id);
  const received = qty('receives', po.id);
  check(received === 110000 && received - ordered.q === 10000, 'what arrived differs from what was ordered and is DERIVED: 110.000 received against 100.000 ordered, a surplus of 10.000 that needs a decision');
  ev('variance.accepted', { documentId: po.id, surplusMilli: 10000 });
  check(Boolean(db.prepare("SELECT 1 FROM eng_event WHERE type = 'variance.accepted'").get()), 'the decision about the variance is an event, kept with the facts it is about');
  const si = await doc('supplier_invoice', 'buy', supplier, [line('Planks', 100000, 1050)]); link('invoices', si.id, po.id, 100000);   // net 105000, tax 15750, gross 120750
  const invoiced = db.prepare('SELECT unit_price_minor AS p FROM eng_document_line WHERE document_id = ?').get(si.id);
  check(invoiced.p - ordered.p === 50 && si.totals.grossMinor === 120750, 'the supplier invoice matches the order and is dearer by 50 cents a unit: a price variance derived by comparing linked lines');
  await facts.recordPayment(w.env, { direction: 'out', partyId: supplier, amountMinor: 120750, currency: 'ZAR', occurredOn: '2026-11-02', method: 'eft', allocations: [{ documentId: si.id, amountMinor: 120750 }] }, CTX);
  check((await ledger.outstandingForDocument(w.env, si.id)) === 0, 'money out settles the supplier invoice through the SAME allocation mechanism as money in settles a customer invoice');

  // ---- 3. JOBS: job -> plan -> actual consumption and cost -> completion -> profitability --------------------------------------------------------------------------------------------------------------------------
  const job = Number(db.prepare('INSERT INTO tf_work_item (kind, party_id, title, event_id) VALUES (?, ?, ?, ?) RETURNING id').get('job', customer, 'Kitchen floor', ev('job.created')).id);
  db.prepare('INSERT INTO tf_plan_line (work_item_id, resource_kind, quantity_milli, unit_cost_minor) VALUES (?, ?, ?, ?)').run(job, 'labour_hours', 16000, 15000);
  const attribute = (d, side, amount) => db.prepare('INSERT INTO tf_attribution (document_id, work_item_id, side, amount_minor, event_id) VALUES (?, ?, ?, ?, ?)').run(d, job, side, amount, ev('attributed'));
  attribute(inv1.id, 'revenue', inv1.totals.netMinor);   // the invoice's net amount is this job's revenue
  attribute(si.id, 'cost', 100000);                      // part of the supplier invoice belongs to this job
  db.prepare('INSERT INTO tf_time_entry (work_item_id, worker_party_id, minutes, rate_minor_per_hour, event_id) VALUES (?, ?, ?, ?, ?)').run(job, fitter, 900, 15000, ev('time.logged'));
  const sum = (sql, ...b) => Number(db.prepare(sql).get(...b).n);
  const revenue = sum("SELECT COALESCE(SUM(amount_minor), 0) AS n FROM tf_attribution WHERE work_item_id = ? AND side = 'revenue'", job);
  const cost = sum("SELECT COALESCE(SUM(amount_minor), 0) AS n FROM tf_attribution WHERE work_item_id = ? AND side = 'cost'", job) + sum('SELECT COALESCE(SUM(minutes * rate_minor_per_hour / 60), 0) AS n FROM tf_time_entry WHERE work_item_id = ?', job);
  check(revenue === 288000 && cost === 100000 + 225000 && revenue - cost === -37000, 'job profitability is derived from what is ATTRIBUTED to the job: revenue R2,880.00 against supplier cost R1,000.00 and labour R2,250.00 (15 hours at R150.00): a loss of R370.00, traceable to the documents behind each figure');

  // ---- 4. FIELD: worker -> assignment -> visit -> work event -> completion evidence -------------------------------------------------------------------------------------------------------------------------------
  const visit = Number(db.prepare('INSERT INTO tf_work_item (kind, parent_id, party_id, title, event_id) VALUES (?, ?, ?, ?, ?) RETURNING id').get('visit', job, customer, 'Fit floor', ev('visit.created')).id);
  db.prepare('INSERT INTO tf_assignment (work_item_id, worker_party_id, event_id) VALUES (?, ?, ?)').run(visit, fitter, ev('visit.assigned'));
  const photo = Number(db.prepare("INSERT INTO captures (raw_text, source) VALUES ('photo of the finished floor', 'photo') RETURNING id").get().id);
  const done = (id) => Boolean(db.prepare("SELECT 1 FROM tf_work_event WHERE work_item_id = ? AND type = 'completed' AND evidence_capture_id IS NOT NULL").get(id));
  db.prepare('INSERT INTO tf_work_event (work_item_id, type, actor_party_id, event_id) VALUES (?, ?, ?, ?)').run(visit, 'started', fitter, ev('visit.started'));
  check(!done(visit), 'a visit that has started is not complete');
  db.prepare('INSERT INTO tf_work_event (work_item_id, type, actor_party_id, evidence_capture_id, event_id) VALUES (?, ?, ?, ?, ?)').run(visit, 'completed', fitter, photo, ev('visit.completed'));
  check(done(visit) && db.prepare('SELECT COUNT(*) AS n FROM tf_assignment WHERE work_item_id = ?').get(visit).n === 1, 'completion carries its evidence (the captured photo) and the visit knows who was assigned');
  const open = sum("SELECT COUNT(*) AS n FROM tf_work_item c WHERE c.parent_id = ? AND NOT EXISTS (SELECT 1 FROM tf_work_event e WHERE e.work_item_id = c.id AND e.type = 'completed')", job);
  check(open === 0, 'and the job\'s precondition for completion ("every visit completed") is derived from its children');

  // ---- 5. CAPTURE -> interpreted facts -> proposed operation -> authorisation -> recorded outcome, through the REAL door and confirm ---------------------------------------------------------------------------------
  const ops = eng.operations, auth = kit.bundle('auth.ts', 'auth'), contract = kit.bundle('capability-contract.ts', 'contract');
  const member = (role) => ({ email: `${role}@example.com`, caps: auth.ROLE_CAPABILITIES[role] });
  const said = 'Mokoena paid R2,000';
  const door = await ops.proposeCapabilityAs(w.env, member('accountant'), { capability: 'payment.record', payload: { partyId: customer, amountMinor: 20000, currency: 'ZAR', occurredOn: '2026-11-03', method: 'eft', allocate: 'oldest_first' }, transcript: said, source: 'text' });
  const captureId = Number(db.prepare('SELECT id FROM captures WHERE raw_text = ? ORDER BY id DESC LIMIT 1').get(said).id);
  // (the door itself now records what was understood: an interpretation naming the capture and the held action, never business truth)
  const held = db.prepare('SELECT id, payload FROM pending_actions WHERE id = ?').get(door.actionId);
  const outcome = await contract.executeThroughContract(w.env, contract.contractForHeldType('engine.payment.record'), { id: held.id, payload: held.payload }, member('accountant'));
  check(door.status === 'held' && outcome.status === 200, 'a spoken payment is captured, interpreted, held as a proposal and approved by an accountant');
  const trace = db.prepare(`SELECT c.raw_text AS said, i.capability AS capability, i.status AS understood, p.type AS proposal, p.status AS proposalStatus, e.type AS event, e.approved_by AS approvedBy
      FROM eng_interpretation i JOIN captures c ON c.id = i.capture_id JOIN pending_actions p ON p.id = json_extract(i.payload_json, '$.actionId') JOIN eng_event e ON e.proposal_id = p.id WHERE e.type = 'operation.executed'`).all();
  check(trace.length === 1 && trace[0].said === said && trace[0].understood === 'proposed' && trace[0].proposal === 'engine.payment.record' && trace[0].proposalStatus === 'confirmed' && trace[0].approvedBy === 'accountant@example.com', 'ONE query walks it end to end: what was said, how it was understood, the proposal, its confirmation, the execution and who approved it');
  const facts5 = db.prepare("SELECT COUNT(*) AS n FROM eng_event WHERE proposal_id = ? AND type IN ('payment.recorded', 'payment.allocated')").get(held.id).n;
  check(facts5 >= 2, `and every fact it recorded carries the same proposal (${facts5} events)`);

  // ---- the stop rule, and the books still hold -----------------------------------------------------------------------------------------------------------------------------------------------------
  // a CONTROL: the detector really detects. A column added to a foundation table in another business changes the shape this test compares.
  const probe = kit.makeWorld(); const probeShape = () => JSON.stringify(probe.db.prepare('PRAGMA table_info(eng_allocation)').all().map((c) => c.name));
  const probeBefore = probeShape(); probe.db.exec('ALTER TABLE eng_allocation ADD COLUMN sneaky TEXT');
  check(probeShape() !== probeBefore, 'CONTROL: a column added to a foundation table WOULD change the shape this suite compares, so the stop rule below can fail');
  check(shape() === shapeBefore, 'THE STOP RULE: after sales, purchasing, jobs, field work and the capture trail, NOT ONE foundation table changed shape (no column added, none altered)');
  const v = await eng.verifyIntegrity(w.env);
  check(v.ok, 'and the books verify clean after all of it: ' + JSON.stringify(v.problems).slice(0, 160));
});

if (require.main === module) kit.standalone(module.exports);
