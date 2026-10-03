// Characterization cases for convert_quote (turning an open quotation into an invoice, with an optional deposit).
// Needs no AI: the open quotation is found by a plain query and the deposit arithmetic is done in code.
module.exports = function cases(caps) {
  const seed = (db) => {
    db.exec(`
      INSERT INTO people (name) VALUES ('Jenny Smith'), ('Thandi Mokoena');
      INSERT INTO customers (name, person_id) VALUES ('Jenny Smith', 1), ('Thandi Mokoena', 2);
      INSERT INTO quotations (customer_id, description, amount, status) VALUES (1, 'Lounge laminate', 12000, 'draft');
    `);
  };
  const conv = (name, role, extraction, transcript) => ({ name, seed, transcript: transcript || 'convert Jenny\'s quote to an invoice', extraction: { intent: 'convert_quote', customer_name: 'Jenny Smith', ...extraction }, capabilities: caps[role] });
  return [
    conv('convert quote: owner, a quotation is open, no deposit', 'owner', {}),
    conv('convert quote: owner, a 30 percent deposit', 'owner', { deposit_percent: 30 }, 'convert Jenny\'s quote, she paid 30 percent upfront'),
    conv('convert quote: owner, the customer has no open quotation', 'owner', { customer_name: 'Thandi Mokoena' }, 'convert Thandi\'s quote to an invoice'),
    conv('convert quote: accountant', 'accountant', {}),
    conv('convert quote: installer is refused', 'installer', {}),
  ];
};
