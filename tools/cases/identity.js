// Characterization cases for the opening step of processOneExtraction: what runs before any intent. It clears the
// "forget that" state, finds or creates the customer and the supplier or installer named, stops to ask when a name
// collides with someone who does the work or sounds like someone already on file, and for a follow-up question with no
// name works out who was meant. Every intent depends on this, and it writes before anything else decides what to do.
// The generic "note" intent is used where the point is only the resolution; it is open to every role.
module.exports = function cases(caps) {
  const base = (db) => db.exec(`
    INSERT INTO people (name) VALUES ('Jenny Smith'), ('Sipho Dlamini'), ('Jabulani'), ('Floornet');
    INSERT INTO customers (name, person_id) VALUES ('Jenny Smith', 1), ('Sipho Dlamini', 2);
    INSERT INTO characters (name, relationship, person_id) VALUES ('Jabulani', 'installer', 3), ('Floornet', 'supplier', 4);
  `);
  const twoThandis = (db) => {
    base(db);
    db.exec(`
      INSERT INTO people (name) VALUES ('Thandi Mokoena'), ('Thandi Mokoeni');
      INSERT INTO customers (name, person_id) VALUES ('Thandi Mokoena', 5), ('Thandi Mokoeni', 6);
    `);
  };
  const selectedCustomer = (db) => { base(db); db.exec(`INSERT INTO selections (key, entity_id, label, updated_at) VALUES ('customer', 1, 'Jenny Smith', '2026-10-03 11:00:00');`); };
  const selectedCharacter = (db) => { base(db); db.exec(`INSERT INTO selections (key, entity_id, label, updated_at) VALUES ('character', 1, 'Jabulani', '2026-10-03 11:00:00');`); };
  const withPending = (db) => {
    base(db);
    db.exec(`
      INSERT INTO selections (key, entity_id, label, updated_at) VALUES ('customer', 1, 'Jenny Smith', '2026-10-03 11:00:00');
      INSERT INTO pending_actions (id, type, payload, source_transcript, status, created_at) VALUES
        (1, 'payment', '{"customerId":1,"customerName":"Jenny Smith","amount":500}', 'Jenny paid R500', 'pending', '2026-10-03 10:00:00'),
        (2, 'invoice', '{"customerId":2,"customerName":"Sipho Dlamini","amount":98000}', 'invoice Sipho R98000', 'pending', '2026-10-03 10:30:00');
    `);
  };
  // An older action an installer may resolve (a delivery) beneath a newer one only the owner and accountant may (an invoice).
  const mixedPending = (db) => {
    base(db);
    db.exec(`
      INSERT INTO pending_actions (id, type, payload, source_transcript, status, created_at) VALUES
        (1, 'goods_received', '{"purchaseOrderId":0,"supplierId":1,"lineItems":[]}', 'Floornet delivered grout', 'pending', '2026-10-03 10:00:00'),
        (2, 'invoice', '{"customerId":2,"customerName":"Sipho Dlamini","amount":98000}', 'invoice Sipho R98000', 'pending', '2026-10-03 10:30:00');
    `);
  };
  // An older payment beneath a newer action of a kind only the owner may resolve.
  const ownerOnlyNewest = (db) => {
    base(db);
    db.exec(`
      INSERT INTO pending_actions (id, type, payload, source_transcript, status, created_at) VALUES
        (1, 'payment', '{"customerId":1,"customerName":"Jenny Smith","amount":500}', 'Jenny paid R500', 'pending', '2026-10-03 10:00:00'),
        (2, 'character_fact', '{"characterId":1,"key":"cell","value":"083 555 0202"}', 'Jabulani cell is 083 555 0202', 'pending', '2026-10-03 10:30:00');
    `);
  };
  const unlabelledContact = (db) => { base(db); db.exec(`INSERT INTO characters (name, relationship) VALUES ('Mystery', NULL);`); };
  const BACK = (reply) => ({ match: /referential pronoun or demonstrative pointing back/, reply });
  const WHO = (reply) => ({ match: /STANDING TOPIC of the conversation below/, reply });
  const ANSWER = { match: /Answer the tradesperson's question using only the facts below/, reply: (input) => 'ANSWER FROM FACTS:\n' + ((input.messages.find((m) => m.role === 'system').content.split('Facts:\n')[1]) || '') };
  const DASH = (reply) => ({ match: /broad, whole-business question wanting a real, visual snapshot/, reply });
  const boom = () => { throw new Error('model unavailable'); };
  const prior = [{ role: 'user', text: 'how is Jenny doing' }, { role: 'office', text: 'Jenny owes R3000.' }];
  const c = (name, role, seed, extraction, transcript, ai, extra) => ({ name, seed, transcript, extraction: { intent: 'note', ...extraction }, capabilities: caps[role], ai, ...(extra || {}) });

  return [
    // ---------------- "forget that" ----------------
    c('forget that: owner, with something pending and a customer selected', 'owner', withPending, { intent: 'forget_last' }, 'forget that', []),
    c('forget that: an installer, while the owner has an invoice pending (open to every role)', 'installer', withPending, { intent: 'forget_last' }, 'forget that', []),
    c('forget that: a role with no permissions', 'stranger', withPending, { intent: 'forget_last' }, 'forget that', []),
    c('forget that: an installer takes the newest action they may resolve, not the newer invoice', 'installer', mixedPending, { intent: 'forget_last' }, 'forget that', []),
    c('forget that: an accountant, the newest action is owner-only, so the older payment is taken', 'accountant', ownerOnlyNewest, { intent: 'forget_last' }, 'forget that', []),
    c('forget that: the owner may abandon an owner-only action', 'owner', ownerOnlyNewest, { intent: 'forget_last' }, 'forget that', []),
    c('forget that: nothing pending and nothing selected', 'owner', base, { intent: 'forget_last' }, 'forget that', []),

    // ---------------- finding or creating a customer ----------------
    c('customer: owner, a name on file', 'owner', base, { customer_name: 'Jenny Smith' }, 'Jenny Smith called', []),
    c('customer: owner, a name on file in a different case', 'owner', base, { customer_name: 'jenny smith' }, 'jenny smith called', []),
    c('customer: owner, a name nobody has heard of', 'owner', base, { customer_name: 'Thandi Mokoena' }, 'Thandi Mokoena called', []),
    c('customer: owner, a name that sounds like one on file', 'owner', base, { customer_name: 'Sipo Dlamini' }, 'Sipo Dlamini called', []),
    c('customer: owner, a name that could be either of two on file', 'owner', twoThandis, { customer_name: 'Thandi Mokoeno' }, 'Thandi Mokoeno called', []),
    c('customer: a role with no permissions creates a customer (the intent is open)', 'stranger', base, { customer_name: 'Brand New Person' }, 'Brand New Person called', []),
    c('customer: owner, the name is already on file as an installer', 'owner', base, { customer_name: 'Jabulani' }, 'Jabulani called about a job', []),
    c('customer: owner, the name is already on file as a supplier', 'owner', base, { customer_name: 'Floornet' }, 'Floornet called about a job', []),
    c('customer: owner, the name is already on file with no relationship recorded', 'owner', unlabelledContact, { customer_name: 'Mystery' }, 'Mystery called about a job', []),
    c('customer: owner, a job observation with a name that is an installer, and no installer named', 'owner', base, { intent: 'work_observation', customer_name: 'Jabulani' }, 'Jabulani lounge is 5 by 4', []),
    c('customer: owner, a job observation with an installer name and an installer also named', 'owner', base, { intent: 'work_observation', customer_name: 'Jabulani', character_name: 'Sipho', character_relationship: 'installer' }, 'Jabulani lounge is 5 by 4, Sipho installs', []),
    c('customer: owner, a lead keeps the name out of the customer list', 'owner', base, { intent: 'raise_lead', customer_name: 'Sipho Dube' }, 'new enquiry from Sipho Dube', [{ match: /reporting a real, new enquiry/, reply: { name: 'Sipho Dube', interest: null, source: null } }]),

    // ---------------- finding or creating a supplier or installer ----------------
    c('character: owner, a supplier on file', 'owner', base, { character_name: 'Floornet', character_relationship: 'supplier' }, 'Floornet called', []),
    c('character: owner, a supplier on file in a different case', 'owner', base, { character_name: 'FLOORNET', character_relationship: 'supplier' }, 'FLOORNET called', []),
    c('character: owner, a new supplier', 'owner', base, { character_name: 'Newco Supplies', character_relationship: 'supplier' }, 'Newco Supplies called', []),
    c('character: owner, a new name with no relationship stated', 'owner', base, { character_name: 'Mystery Man' }, 'Mystery Man called', []),
    c('character: owner, the name is already on file as a customer', 'owner', base, { character_name: 'Jenny Smith', character_relationship: 'installer' }, 'Jenny Smith will install it', []),
    c('character: owner, the name is already on file as a customer, no relationship stated', 'owner', base, { character_name: 'Jenny Smith' }, 'Jenny Smith will do it', []),
    c('character: owner, a name that sounds like someone on file', 'owner', base, { character_name: 'Jabulane', character_relationship: 'installer' }, 'Jabulane will install it', []),
    c('both: owner, a customer and an installer in one message', 'owner', base, { customer_name: 'Jenny Smith', character_name: 'Jabulani', character_relationship: 'installer' }, 'Jabulani is installing at Jenny\'s', []),

    // ---------------- a lookup finds, and never creates ----------------
    c('lookup names: owner, a customer on file', 'owner', base, { intent: 'lookup', customer_name: 'Jenny Smith', query_scope: 'customer' }, 'how is Jenny doing', [ANSWER]),
    c('lookup names: owner, a customer nobody has heard of (nothing is created)', 'owner', base, { intent: 'lookup', customer_name: 'Nobody Known', query_scope: 'customer' }, 'how is Nobody Known doing', [ANSWER]),
    c('lookup names: owner, a supplier nobody has heard of (nothing is created)', 'owner', base, { intent: 'lookup', character_name: 'Nobody Known', character_relationship: 'supplier' }, 'how is Nobody Known doing', [ANSWER]),

    // ---------------- a follow-up with no name: who was meant? ----------------
    c('follow-up: owner, a customer is selected', 'owner', selectedCustomer, { intent: 'lookup', query_scope: 'customer' }, 'and what about her balance', [ANSWER]),
    c('follow-up: owner, a supplier or installer is selected', 'owner', selectedCharacter, { intent: 'lookup', query_scope: 'character' }, 'and what is he doing', [ANSWER]),
    c('follow-up: owner, nothing selected, and the conversation points at a customer', 'owner', base, { intent: 'lookup', query_scope: 'customer' }, 'and her balance', [WHO({ name: 'Jenny Smith' }), ANSWER], { history: prior }),
    c('follow-up: owner, nothing selected, and the conversation points at a supplier', 'owner', base, { intent: 'lookup', query_scope: 'character' }, 'and what do we owe them', [WHO({ name: 'Floornet' }), ANSWER], { history: prior }),
    c('follow-up: owner, nothing selected, the conversation names someone not on file', 'owner', base, { intent: 'lookup', query_scope: 'customer' }, 'and her balance', [WHO({ name: 'Nobody Known' }), ANSWER], { history: prior }),
    c('follow-up: owner, nothing selected, the conversation points at no one', 'owner', base, { intent: 'lookup', query_scope: 'customer' }, 'and her balance', [WHO({ name: null }), ANSWER], { history: prior }),
    c('follow-up: owner, nothing selected and the resolving model fails', 'owner', base, { intent: 'lookup', query_scope: 'customer' }, 'and her balance', [WHO(boom), ANSWER], { history: prior }),
    c('follow-up: owner, nothing selected and no history at all', 'owner', base, { intent: 'lookup', query_scope: 'customer' }, 'and her balance', [ANSWER]),
    c('follow-up: owner, a business question that points back, with a customer selected', 'owner', selectedCustomer, { intent: 'lookup', query_scope: 'business' }, 'what about her', [BACK('YES'), ANSWER]),
    c('follow-up: owner, a business question that stands on its own, with a customer selected', 'owner', selectedCustomer, { intent: 'lookup', query_scope: 'business' }, 'what is outstanding on the Lounge job', [BACK('NO'), DASH('NONE'), ANSWER]),
    c('follow-up: owner, a business question and the pointing-back check fails', 'owner', selectedCustomer, { intent: 'lookup', query_scope: 'business' }, 'what about her', [BACK(boom), DASH('NONE'), ANSWER]),
    c('follow-up: owner, a personal question never borrows the selection', 'owner', selectedCustomer, { intent: 'lookup', query_scope: 'personal' }, 'what do I need to do today', [ANSWER]),
  ];
};
