// Characterization cases for snags and leads: raise_snag, resolve_snag, raise_lead and lose_lead. Resolving the last open
// snag can release a customer's retention; losing a lead is owner-only. Each branch asks a model to read the sentence.
module.exports = function cases(caps) {
  const base = (db) => db.exec(`
    INSERT INTO people (name) VALUES ('Jenny Smith'), ('Thandi Mokoena');
    INSERT INTO customers (name, person_id, retention_percent) VALUES ('Jenny Smith', 1, 10), ('Thandi Mokoena', 2, NULL);
    INSERT INTO invoices (id, customer_id, description, amount, retention_percent, retention_amount, created_at) VALUES (1, 1, 'Lounge laminate', 5000, 10, 500, '2026-08-01 08:00:00');
  `);
  const oneSnag = (db) => { base(db); db.exec(`INSERT INTO snags (customer_id, description, status, created_at) VALUES (1, 'loose seam near the door', 'open', '2026-09-01 08:00:00');`); };
  const twoSnags = (db) => { oneSnag(db); db.exec(`INSERT INTO snags (customer_id, description, status, created_at) VALUES (1, 'scratched skirting', 'open', '2026-09-02 08:00:00');`); };
  const oneSnagNoRetention = (db) => { base(db); db.exec(`INSERT INTO snags (customer_id, description, status, created_at) VALUES (2, 'gap at the threshold', 'open', '2026-09-01 08:00:00');`); };
  const oneLead = (db) => { base(db); db.exec(`INSERT INTO leads (name, interest, status, created_at) VALUES ('Sipho', 'kitchen vinyl', 'enquired', '2026-09-01 08:00:00');`); };
  const twoLeads = (db) => { oneLead(db); db.exec(`INSERT INTO leads (name, interest, status, created_at) VALUES ('Lerato', 'bedroom carpet', 'enquired', '2026-09-02 08:00:00');`); };
  const SNAG = (reply) => ({ match: /reporting a real, physical quality issue found on a job/, reply });
  const SNAGFIX = (reply) => ({ match: /reporting a real, open snag as fixed/, reply });
  const LEAD = (reply) => ({ match: /reporting a real, new enquiry/, reply });
  const LOST = (reply) => ({ match: /reporting a real, open lead as lost/, reply });
  const boom = () => { throw new Error('model unavailable'); };
  const c = (name, role, seed, intent, extraction, transcript, ai) => ({ name, seed, transcript, extraction: { intent, ...extraction }, capabilities: caps[role], ai });
  return [
    // ---------------- raise_snag ----------------
    c('snag raise: owner, a customer and an issue', 'owner', base, 'raise_snag', { customer_name: 'Jenny Smith' }, 'Jenny\'s carpet has a loose seam near the door', [SNAG({ description: 'loose seam near the door' })]),
    c('snag raise: owner, no customer named', 'owner', base, 'raise_snag', {}, 'there is a loose seam near the door', []),
    c('snag raise: owner, the model finds no issue', 'owner', base, 'raise_snag', { customer_name: 'Jenny Smith' }, 'Jenny has a snag', [SNAG({ description: null })]),
    c('snag raise: owner, the model fails', 'owner', base, 'raise_snag', { customer_name: 'Jenny Smith' }, 'Jenny\'s carpet has a loose seam', [SNAG(boom)]),
    c('snag raise: installer (open to every role)', 'installer', base, 'raise_snag', { customer_name: 'Jenny Smith' }, 'Jenny\'s carpet has a loose seam near the door', [SNAG({ description: 'loose seam near the door' })]),
    c('snag raise: a role with no permissions (open to every role)', 'stranger', base, 'raise_snag', { customer_name: 'Jenny Smith' }, 'Jenny\'s carpet has a loose seam near the door', [SNAG({ description: 'loose seam near the door' })]),
    c('snag raise: owner, a customer who is not on file', 'owner', base, 'raise_snag', { customer_name: 'Brand New Person' }, 'Brand New Person has a loose seam', [SNAG({ description: 'loose seam' })]),

    // ---------------- resolve_snag ----------------
    c('snag resolve: owner, the only open snag, and the customer holds retention', 'owner', oneSnag, 'resolve_snag', { customer_name: 'Jenny Smith' }, 'fixed the loose seam at Jenny', [SNAGFIX({ matched_description: 'loose seam near the door' })]),
    c('snag resolve: owner, the model names nothing and there is one open snag', 'owner', oneSnag, 'resolve_snag', { customer_name: 'Jenny Smith' }, 'Jenny\'s snag is fixed', [SNAGFIX({ matched_description: null })]),
    c('snag resolve: owner, one of two is fixed (retention stays held)', 'owner', twoSnags, 'resolve_snag', { customer_name: 'Jenny Smith' }, 'fixed the loose seam at Jenny', [SNAGFIX({ matched_description: 'loose seam near the door' })]),
    c('snag resolve: owner, the model names nothing and there are two open snags', 'owner', twoSnags, 'resolve_snag', { customer_name: 'Jenny Smith' }, 'Jenny\'s snag is fixed', [SNAGFIX({ matched_description: null })]),
    c('snag resolve: owner, the last snag of a customer with no retention', 'owner', oneSnagNoRetention, 'resolve_snag', { customer_name: 'Thandi Mokoena' }, 'fixed the gap at Thandi', [SNAGFIX({ matched_description: 'gap at the threshold' })]),
    c('snag resolve: owner, no open snags for that customer', 'owner', base, 'resolve_snag', { customer_name: 'Jenny Smith' }, 'fixed the seam at Jenny', []),
    c('snag resolve: owner, no customer named', 'owner', oneSnag, 'resolve_snag', {}, 'fixed the loose seam', []),
    c('snag resolve: owner, the model fails and there is one open snag', 'owner', oneSnag, 'resolve_snag', { customer_name: 'Jenny Smith' }, 'fixed the loose seam at Jenny', [SNAGFIX(boom)]),
    c('snag resolve: installer (open to every role)', 'installer', oneSnag, 'resolve_snag', { customer_name: 'Jenny Smith' }, 'fixed the loose seam at Jenny', [SNAGFIX({ matched_description: 'loose seam near the door' })]),

    // ---------------- raise_lead ----------------
    c('lead raise: owner, a name, an interest and a source', 'owner', base, 'raise_lead', { customer_name: 'Sipho Dube' }, 'new enquiry from Sipho Dube, kitchen vinyl, found us on Facebook', [LEAD({ name: 'Sipho Dube', interest: 'kitchen vinyl', source: 'Facebook' })]),
    c('lead raise: owner, no name was caught by the classifier', 'owner', base, 'raise_lead', {}, 'someone is interested in vinyl', []),
    c('lead raise: owner, the model finds no name', 'owner', base, 'raise_lead', { customer_name: 'Sipho Dube' }, 'someone is interested', [LEAD({ name: null, interest: null, source: null })]),
    c('lead raise: owner, the model fails', 'owner', base, 'raise_lead', { customer_name: 'Sipho Dube' }, 'new enquiry from Sipho Dube', [LEAD(boom)]),
    c('lead raise: installer (open to every role)', 'installer', base, 'raise_lead', { customer_name: 'Sipho Dube' }, 'new enquiry from Sipho Dube, kitchen vinyl', [LEAD({ name: 'Sipho Dube', interest: 'kitchen vinyl', source: null })]),

    // ---------------- lose_lead (owner only) ----------------
    c('lead lost: owner, the only open lead', 'owner', oneLead, 'lose_lead', {}, 'Sipho lost the enquiry', [LOST({ matched_name: 'Sipho' })]),
    c('lead lost: owner, one of two named', 'owner', twoLeads, 'lose_lead', {}, 'Lerato decided not to go ahead', [LOST({ matched_name: 'Lerato' })]),
    c('lead lost: owner, the model names nothing and there are two', 'owner', twoLeads, 'lose_lead', {}, 'that lead is lost', [LOST({ matched_name: null })]),
    c('lead lost: owner, no open leads', 'owner', base, 'lose_lead', {}, 'Sipho lost the enquiry', []),
    c('lead lost: owner, the model fails and there is one open lead', 'owner', oneLead, 'lose_lead', {}, 'Sipho lost the enquiry', [LOST(boom)]),
    c('lead lost: accountant is refused', 'accountant', oneLead, 'lose_lead', {}, 'Sipho lost the enquiry', []),
    c('lead lost: installer is refused', 'installer', oneLead, 'lose_lead', {}, 'Sipho lost the enquiry', []),
  ];
};
