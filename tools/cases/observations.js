// Characterization cases for work_observation: the third member of the entangled invoicing, pricing and observation
// group. A spoken job observation can record a job scope, attach to a sibling job from the same message, ask whether to
// amend an existing job, flag an installer clash, and (for a role that may) price what it recorded. Each case scripts
// the readers it needs; the pricing reader is always scripted in the pricing cases so that "was it called" is a fact
// in the recording and not an accident.
module.exports = function cases(caps) {
  const base = (db) => db.exec(`
    INSERT INTO people (name) VALUES ('Jenny Smith'), ('Thandi Mokoena');
    INSERT INTO customers (name, person_id) VALUES ('Jenny Smith', 1), ('Thandi Mokoena', 2);
    INSERT INTO characters (name, relationship) VALUES ('Jabulani', 'installer'), ('Sipho', 'installer');
  `);
  const withScope = (db) => {
    base(db);
    db.exec(`
      INSERT INTO job_scopes (id, customer_id, description, scheduled_date_raw, scheduled_date, created_at) VALUES (1, 1, 'Lounge laminate', 'the 10th', '2026-10-10', '2026-10-01 08:00:00');
      INSERT INTO scope_components (id, job_scope_id, name, width_mm, length_mm, area_sqm) VALUES (1, 1, 'Lounge', 5000, 4000, 20);
    `);
  };
  // The capture the harness creates is always id 1, so a job scope or lead with capture_id 1 is "from the same message".
  const siblingScope = (db) => {
    base(db);
    db.exec(`INSERT INTO job_scopes (id, customer_id, description, capture_id, created_at) VALUES (1, 1, 'Lounge laminate', 1, '2026-10-03 11:00:00');`);
  };
  const siblingLead = (db) => {
    base(db);
    db.exec(`INSERT INTO leads (name, interest, capture_id) VALUES ('Thandi Mokoena', 'bedroom carpet', 1);`);
  };
  // Jabulani is already booked for Monday 5 October on Jenny's job.
  const busyInstaller = (db) => {
    base(db);
    db.exec(`INSERT INTO job_scopes (id, customer_id, description, installer_id, scheduled_date, scheduled_date_raw, created_at) VALUES (1, 1, 'Lounge laminate', 1, '2026-10-05', 'next Monday', '2026-10-01 08:00:00');`);
  };
  const OBS = (reply) => ({ match: /Extract the structure of a tradesperson's job observation/, reply });
  const PRICE = (reply) => ({ match: /priced_items/, reply });
  const boom = () => { throw new Error('model unavailable'); };
  const nothing = { job_description: 'observation', components: [], tasks: [], scheduled_date_raw: null, installer_name: null };
  const obs = (o) => ({ ...nothing, ...o });
  const lounge = obs({ job_description: 'laminate installation', components: [{ name: 'lounge', width: 5, length: 4, unit: 'm', area_sqm: null }], tasks: [{ description: 'laminate installation', component_name: null }] });
  const priceLounge = PRICE({ priced_items: [{ matched_name: 'lounge', description: 'Lounge', pricing_type: 'per_sqm', rate: 450 }] });
  const c = (name, role, seed, extraction, transcript, ai) => ({ name, seed, transcript, extraction: { intent: 'work_observation', customer_name: 'Jenny Smith', ...extraction }, capabilities: caps[role], ai });

  return [
    c('observation: owner, a customer and measurements, no prices', 'owner', base, {}, 'Jenny lounge is 5 by 4 metres, laminate', [OBS(lounge)]),
    c('observation: owner, measured and priced (a quotation is held alongside)', 'owner', base, {}, 'Jenny lounge is 5 by 4 metres, laminate, R450 a square metre', [OBS(lounge), priceLounge]),
    c('observation: accountant, measured and priced', 'accountant', base, {}, 'Jenny lounge is 5 by 4 metres, laminate, R450 a square metre', [OBS(lounge), priceLounge]),
    c('observation: installer records the job but is not priced for', 'installer', base, {}, 'Jenny lounge is 5 by 4 metres, laminate, R450 a square metre', [OBS(lounge), priceLounge]),
    c('observation: owner, prices mentioned but the pricing model finds none', 'owner', base, {}, 'Jenny lounge is 5 by 4 metres, laminate, about R450', [OBS(lounge), PRICE({ priced_items: [] })]),
    c('observation: owner, prices mentioned and the pricing model fails', 'owner', base, {}, 'Jenny lounge is 5 by 4 metres, laminate, R450 a square metre', [OBS(lounge), PRICE(boom)]),
    c('observation: owner, a date-only change for a customer who already has a job', 'owner', withScope, {}, 'move Jenny\'s install to next Monday', [OBS(obs({ scheduled_date_raw: 'next Monday' }))]),
    c('observation: owner, no customer, installer and date, a sibling job in the same message', 'owner', siblingScope, { customer_name: null }, 'Jabulani will install it next Monday', [OBS(obs({ scheduled_date_raw: 'next Monday', installer_name: 'Jabulani' }))]),
    c('observation: owner, no customer, installer and date, a sibling lead in the same message', 'owner', siblingLead, { customer_name: null }, 'Sipho will install it next Monday', [OBS(obs({ scheduled_date_raw: 'next Monday', installer_name: 'Sipho' }))]),
    c('observation: owner, no customer, installer and date, nothing to attach to', 'owner', base, { customer_name: null }, 'Sipho will install it next Monday', [OBS(obs({ scheduled_date_raw: 'next Monday', installer_name: 'Sipho' }))]),
    c('observation: owner, an installer who is already booked that day', 'owner', busyInstaller, { customer_name: 'Thandi Mokoena' }, 'Thandi lounge is 4 by 3 metres, Jabulani installs next Monday',
      [OBS(obs({ job_description: 'carpet', components: [{ name: 'lounge', width: 4, length: 3, unit: 'm', area_sqm: null }], tasks: [{ description: 'carpet', component_name: null }], scheduled_date_raw: 'next Monday', installer_name: 'Jabulani' }))]),
    c('observation: owner, only an installer is named (no date, no measurements)', 'owner', base, {}, 'Sipho will do Jenny\'s job', [OBS(obs({ installer_name: 'Sipho' }))]),
    c('observation: owner, an installer nobody has heard of', 'owner', base, {}, 'Jenny lounge is 5 by 4 metres, Thabo installs', [OBS({ ...lounge, installer_name: 'Thabo' })]),
    c('observation: owner, a customer who is not on file', 'owner', base, { customer_name: 'Brand New Person' }, 'Brand New Person lounge is 5 by 4 metres, laminate', [OBS(lounge)]),
    c('observation: owner, measurements but no customer named', 'owner', base, { customer_name: null }, 'lounge is 5 by 4 metres, laminate', [OBS(lounge)]),
    c('observation: owner, the model finds nothing', 'owner', base, {}, 'Jenny lounge is big', [OBS(nothing)]),
    c('observation: owner, the model fails', 'owner', base, {}, 'Jenny lounge is 5 by 4 metres, laminate', [OBS(boom)]),
    c('observation: a role with no permissions (the intent is open to every role)', 'stranger', base, {}, 'Jenny lounge is 5 by 4 metres, laminate', [OBS(lounge)]),
  ];
};
