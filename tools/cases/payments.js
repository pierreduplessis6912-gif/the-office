// Characterization cases for the payments group: payment, expense, supplier_payment.
// Each case names a real situation; the harness records what the live function returns and writes.
module.exports = function cases(caps) {
  const seed = (db) => {
    db.exec(`
      INSERT INTO people (name) VALUES ('Jenny Smith'), ('Sipho Dlamini');
      INSERT INTO customers (name, person_id) VALUES ('Jenny Smith', 1), ('Sipho Dlamini', 2);
      INSERT INTO characters (name, relationship) VALUES ('Floornet', 'supplier'), ('Jabulani', 'installer');
    `);
  };
  const pay = (name, role, extraction, transcript) => ({ name, seed, transcript: transcript || 'Jenny paid R500', extraction: { intent: 'payment', ...extraction }, capabilities: caps[role] });
  const exp = (name, role, extraction, transcript) => ({ name, seed, transcript: transcript || 'filled up the bakkie with diesel for R650', extraction: { intent: 'expense', ...extraction }, capabilities: caps[role] });
  const sup = (name, role, extraction, transcript) => ({ name, seed, transcript: transcript || 'paid Floornet R10000', extraction: { intent: 'supplier_payment', ...extraction }, capabilities: caps[role] });
  return [
    // ---- payment ----
    pay('payment: owner, existing customer', 'owner', { customer_name: 'Jenny Smith', amount: 500 }),
    pay('payment: owner, existing customer in a different case', 'owner', { customer_name: 'jenny smith', amount: 500 }, 'jenny smith paid R500'),
    pay('payment: owner, a name nobody has heard of', 'owner', { customer_name: 'Thandi Mokoena', amount: 750 }, 'Thandi Mokoena paid R750'),
    pay('payment: owner, a near-match to an existing customer', 'owner', { customer_name: 'Sipo Dlamini', amount: 300 }, 'Sipo Dlamini paid R300'),
    pay('payment: owner, no amount heard', 'owner', { customer_name: 'Jenny Smith', amount: null }, 'Jenny paid'),
    pay('payment: owner, no customer named', 'owner', { customer_name: null, amount: 500 }, 'someone paid R500'),
    pay('payment: owner, only a supplier named', 'owner', { customer_name: null, character_name: 'Floornet', character_relationship: 'supplier', amount: 500 }, 'Floornet paid R500'),
    pay('payment: accountant, existing customer', 'accountant', { customer_name: 'Jenny Smith', amount: 500 }),
    pay('payment: installer is refused', 'installer', { customer_name: 'Jenny Smith', amount: 500 }),
    pay('payment: a role with no capabilities is refused', 'stranger', { customer_name: 'Jenny Smith', amount: 500 }),
    pay('payment: installer with an unknown name is refused before anything is created', 'installer', { customer_name: 'Brand New Person', amount: 500 }, 'Brand New Person paid R500'),
    // ---- expense ----
    exp('expense: owner, no one named', 'owner', { amount: 650 }),
    exp('expense: owner, an existing supplier named', 'owner', { amount: 1200, character_name: 'Floornet', character_relationship: 'supplier' }, 'bought adhesive from Floornet for R1200'),
    exp('expense: owner, a new supplier named', 'owner', { amount: 90, character_name: 'Corner Hardware', character_relationship: 'supplier' }, 'screws from Corner Hardware R90'),
    exp('expense: owner, a customer named too', 'owner', { amount: 200, customer_name: 'Jenny Smith' }, 'R200 skirting for Jenny'),
    exp('expense: owner, no amount', 'owner', { amount: null }, 'bought some stuff'),
    exp('expense: accountant', 'accountant', { amount: 650 }),
    exp('expense: installer is refused', 'installer', { amount: 650 }),
    // ---- supplier_payment ----
    sup('supplier payment: owner, existing supplier', 'owner', { amount: 10000, character_name: 'Floornet', character_relationship: 'supplier' }),
    sup('supplier payment: owner, no supplier named', 'owner', { amount: 10000 }, 'paid R10000'),
    sup('supplier payment: owner, a new supplier name', 'owner', { amount: 5000, character_name: 'Newco Supplies', character_relationship: 'supplier' }, 'paid Newco Supplies R5000'),
    sup('supplier payment: owner, no amount', 'owner', { amount: null, character_name: 'Floornet' }, 'paid Floornet'),
    sup('supplier payment: accountant, existing supplier', 'accountant', { amount: 10000, character_name: 'Floornet', character_relationship: 'supplier' }),
    sup('supplier payment: installer is refused', 'installer', { amount: 10000, character_name: 'Floornet', character_relationship: 'supplier' }),
  ];
};
