// Characterization cases for the invoicing and pricing group: invoice, quotation and price_scope. (work_observation, the
// third member of this entangled group, is recorded separately.) These branches read the sentence with up to three
// models (the job-observation reader, the quotation line-item reader and the scope-pricing reader), so each case
// scripts the ones it needs. Several cases exist to settle questions that had only been asked by reading the code.
module.exports = function cases(caps) {
  const base = (db) => db.exec(`
    INSERT INTO people (name) VALUES ('Jenny Smith'), ('Thandi Mokoena');
    INSERT INTO customers (name, person_id) VALUES ('Jenny Smith', 1), ('Thandi Mokoena', 2);
    INSERT INTO characters (name, relationship) VALUES ('Jabulani', 'installer');
  `);
  // Jenny already has a measured job scope with one component and one task, booked for the 10th.
  const withScope = (db) => {
    base(db);
    db.exec(`
      INSERT INTO job_scopes (id, customer_id, description, scheduled_date_raw, scheduled_date, installer_id, created_at) VALUES (1, 1, 'Lounge laminate', 'the tenth', '2026-10-10', NULL, '2026-10-01 08:00:00');
      INSERT INTO scope_components (id, job_scope_id, name, width_mm, length_mm, area_sqm) VALUES (1, 1, 'Lounge', 5000, 4000, 20);
      INSERT INTO scope_tasks (id, job_scope_id, description, component_id) VALUES (1, 1, 'screeding', 1);
    `);
  };
  const OBS = (reply) => ({ match: /Extract the structure of a tradesperson's job observation/, reply });
  const LINES = (reply) => ({ match: /Extract every distinct line item from a tradesperson's quotation or invoice description/, reply });
  const PRICE = (reply) => ({ match: /priced_items/, reply });
  const boom = () => { throw new Error('model unavailable'); };
  const nothingObserved = { job_description: 'invoice', components: [], tasks: [], scheduled_date_raw: null, installer_name: null };
  const obs = (o) => ({ ...nothingObserved, ...o });
  const c = (name, role, seed, intent, extraction, transcript, ai) => ({ name, seed, transcript, extraction: { intent, customer_name: 'Jenny Smith', ...extraction }, capabilities: caps[role], ai });

  return [
    // ---------------- invoice ----------------
    c('invoice: owner, an amount and nothing observed', 'owner', base, 'invoice', { amount: 5000 }, 'invoice Jenny R5000', [OBS(nothingObserved)]),
    c('invoice: owner, an amount and a task (a job scope is recorded alongside the hold)', 'owner', base, 'invoice', { amount: 5000 }, 'invoice Jenny R5000 for repairs',
      [OBS(obs({ job_description: 'repairs', tasks: [{ description: 'repairs', component_name: null }] }))]),
    c('invoice: owner, no amount, rooms and an installer and a date', 'owner', base, 'invoice', {}, '2 rooms laminate and Jabulani to install next week Monday',
      [OBS(obs({ job_description: 'laminate installation', components: [{ name: 'room 1', width: 4, length: 3, unit: 'm', area_sqm: null }, { name: 'room 2', width: 3, length: 3, unit: 'm', area_sqm: null }], tasks: [{ description: 'laminate installation', component_name: null }], scheduled_date_raw: 'next week Monday', installer_name: 'Jabulani' }))]),
    c('invoice: owner, no amount, only a date, no existing job scope', 'owner', base, 'invoice', {}, 'schedule Jenny\'s install for next Monday', [OBS(obs({ scheduled_date_raw: 'next Monday' }))]),
    c('invoice: owner, an amount and a date-only change for a customer who already has a job scope', 'owner', withScope, 'invoice', { amount: 3000 }, 'invoice Jenny R3000 and move the install to the 17th',
      [OBS(obs({ scheduled_date_raw: 'the seventeenth' }))]),
    c('invoice: owner, no amount, a date-only change for a customer who already has a job scope', 'owner', withScope, 'invoice', {}, 'move Jenny\'s install to the 17th', [OBS(obs({ scheduled_date_raw: 'the seventeenth' }))]),
    c('invoice: owner, an amount and an installer nobody has heard of', 'owner', base, 'invoice', { amount: 4000 }, 'invoice Jenny R4000, Sepo will install it',
      [OBS(obs({ job_description: 'installation', tasks: [{ description: 'installation', component_name: null }], installer_name: 'Sepo' }))]),
    c('invoice: owner, an amount and the observation model fails', 'owner', base, 'invoice', { amount: 5000 }, 'invoice Jenny R5000 for repairs', [OBS(boom)]),
    c('invoice: owner, no amount and the observation model fails', 'owner', base, 'invoice', {}, 'invoice Jenny, Sepo installs on Monday', [OBS(boom)]),
    c('invoice: owner, no amount and nothing observed', 'owner', base, 'invoice', {}, 'invoice Jenny', [OBS(nothingObserved)]),
    c('invoice: owner, a customer who is not on file', 'owner', base, 'invoice', { customer_name: 'Brand New Person', amount: 800 }, 'invoice Brand New Person R800', [OBS(nothingObserved)]),
    c('invoice: owner, no customer named', 'owner', base, 'invoice', { customer_name: null, amount: 5000 }, 'invoice R5000 for repairs', []),
    c('invoice: accountant, an amount and a task', 'accountant', base, 'invoice', { amount: 5000 }, 'invoice Jenny R5000 for repairs',
      [OBS(obs({ job_description: 'repairs', tasks: [{ description: 'repairs', component_name: null }] }))]),
    c('invoice: installer is refused', 'installer', base, 'invoice', { amount: 5000 }, 'invoice Jenny R5000 for repairs', []),

    // ---------------- quotation (line items read by a model) ----------------
    c('quotation: owner, two line items', 'owner', base, 'quotation', {}, 'quote Jenny 20 square metres of carpet at R450 and underlay R2000',
      [LINES({ line_items: [{ description: 'Carpet', note: null, quantity: 20, unit: 'sqm', unit_price: 450, discount_percent: null }, { description: 'Underlay', note: null, quantity: 1, unit: null, unit_price: 2000, discount_percent: null }] })]),
    c('quotation: owner, a line with a stated discount', 'owner', base, 'quotation', {}, 'quote Jenny 10 sqm vinyl at R300 with 10 percent off',
      [LINES({ line_items: [{ description: 'Vinyl', note: null, quantity: 10, unit: 'sqm', unit_price: 300, discount_percent: 10 }] })]),
    c('quotation: owner, the model finds no lines but an amount was heard', 'owner', base, 'quotation', { amount: 5000 }, 'quote Jenny five thousand for the lounge', [LINES({ line_items: [] })]),
    c('quotation: owner, no lines and no amount', 'owner', base, 'quotation', {}, 'quote Jenny for the lounge', [LINES({ line_items: [] })]),
    c('quotation: owner, the model fails and an amount was heard', 'owner', base, 'quotation', { amount: 5000 }, 'quote Jenny five thousand for the lounge', [LINES(boom)]),
    c('quotation: owner, no customer named', 'owner', base, 'quotation', { customer_name: null }, 'quote 20 square metres of carpet at R450', []),
    c('quotation: accountant', 'accountant', base, 'quotation', {}, 'quote Jenny 20 square metres of carpet at R450',
      [LINES({ line_items: [{ description: 'Carpet', note: null, quantity: 20, unit: 'sqm', unit_price: 450, discount_percent: null }] })]),
    c('quotation: installer is refused', 'installer', base, 'quotation', {}, 'quote Jenny 20 square metres of carpet at R450', []),

    // ---------------- price_scope (price the job that was already measured) ----------------
    c('price scope: owner, a measured job priced per square metre and flat', 'owner', withScope, 'price_scope', {}, 'price Jenny\'s lounge at R450 a square metre and flat R1500 for the screeding',
      [PRICE({ priced_items: [{ matched_name: 'Lounge', description: 'Lounge', pricing_type: 'per_sqm', rate: 450 }, { matched_name: 'screeding', description: 'Screeding', pricing_type: 'flat', rate: 1500 }] })]),
    c('price scope: owner, scoped as an invoice', 'owner', withScope, 'price_scope', { scope_document_type: 'invoice' }, 'invoice Jenny for the lounge at R450 a square metre',
      [PRICE({ priced_items: [{ matched_name: 'Lounge', description: 'Lounge', pricing_type: 'per_sqm', rate: 450 }] })]),
    c('price scope: owner, no price was actually stated', 'owner', withScope, 'price_scope', {}, 'price Jenny\'s lounge', [PRICE({ priced_items: [] })]),
    c('price scope: owner, no measured job, but the sentence measures and prices it', 'owner', base, 'price_scope', {}, 'Jenny lounge 5 by 4 metres, laminate, R450 a square metre',
      [OBS(obs({ job_description: 'laminate', components: [{ name: 'lounge', width: 5, length: 4, unit: 'm', area_sqm: null }], tasks: [{ description: 'laminate', component_name: null }] })),
       PRICE({ priced_items: [{ matched_name: 'lounge', description: 'Lounge', pricing_type: 'per_sqm', rate: 450 }] })]),
    c('price scope: owner, no measured job and nothing measured', 'owner', base, 'price_scope', {}, 'price Jenny\'s job', [OBS(nothingObserved)]),
    c('price scope: owner, the pricing model fails', 'owner', withScope, 'price_scope', {}, 'price Jenny\'s lounge at R450 a square metre', [PRICE(boom)]),
    c('price scope: owner, no customer named', 'owner', withScope, 'price_scope', { customer_name: null }, 'price the lounge at R450 a square metre', []),
    c('price scope: installer is refused', 'installer', withScope, 'price_scope', {}, 'price Jenny\'s lounge at R450 a square metre', []),
  ];
};
