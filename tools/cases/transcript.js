// Characterization cases for processTranscript: the CALLER of processOneExtraction. It logs the capture, asks a model to
// split the message into topics, asks a model to read each topic, runs each through processOneExtraction, attaches a new
// job scope to the customer's open project (or asks which), and joins the replies. Every case here is a whole spoken
// message, so the models are scripted at both steps, and the failures at each step are cases in their own right.
module.exports = function cases(caps) {
  const DEFAULTS = { customer_name: null, character_name: null, character_relationship: null, intent: 'other', amount: null, fact_key: null, fact_value: null, personal_note: null, query_scope: null, deposit_percent: null, scope_document_type: null, due_date_raw: null };
  const base = (db) => db.exec(`
    INSERT INTO people (name) VALUES ('Jenny Smith'), ('Thandi Mokoena'), ('Jabulani');
    INSERT INTO customers (name, person_id) VALUES ('Jenny Smith', 1), ('Thandi Mokoena', 2);
    INSERT INTO characters (name, relationship, person_id) VALUES ('Jabulani', 'installer', 3);
  `);
  const oneProject = (db) => { base(db); db.exec(`INSERT INTO projects (id, customer_id, description, created_at) VALUES (1, 1, 'Kitchen refit', '2026-09-01 08:00:00');`); };
  const twoProjects = (db) => { oneProject(db); db.exec(`INSERT INTO projects (id, customer_id, description, created_at) VALUES (2, 1, 'Lounge floor', '2026-09-10 08:00:00');`); };
  // A project whose invoice is paid in full is no longer open (open = no invoice yet, or an unpaid one).
  const paidProject = (db) => {
    base(db);
    db.exec(`
      INSERT INTO projects (id, customer_id, description, created_at) VALUES (1, 1, 'Kitchen refit', '2026-09-01 08:00:00');
      INSERT INTO job_scopes (id, customer_id, description, project_id, created_at) VALUES (1, 1, 'Kitchen', 1, '2026-09-01 08:00:00');
      INSERT INTO invoices (id, customer_id, description, amount, job_scope_id, created_at) VALUES (1, 1, 'Kitchen refit', 5000, 1, '2026-09-05 08:00:00');
      INSERT INTO payments (customer_id, amount, source_transcript, invoice_id, created_at) VALUES (1, 5000, 'Jenny paid R5000', 1, '2026-09-20 08:00:00');
    `);
  };
  const SPLIT = (reply) => ({ match: /Find genuinely SEPARATE topics and split/, reply });
  const READ = (bySegment) => ({ match: /Extract structured facts from a tradesperson's message/, reply: (input) => {
    const seg = input.messages.find((m) => m.role === 'user').content;
    if (!(seg in bySegment)) throw new Error('no scripted reading for: ' + seg);
    const e = bySegment[seg];
    return e === null ? 'this is not json' : { ...DEFAULTS, ...e };
  } });
  const OBS = (reply) => ({ match: /Extract the structure of a tradesperson's job observation/, reply });
  const SNAG = (reply) => ({ match: /reporting a real, physical quality issue found on a job/, reply });
  const DASH = (reply) => ({ match: /broad, whole-business question wanting a real, visual snapshot/, reply });
  const ANSWER = { match: /Answer the tradesperson's question using only the facts below/, reply: (input) => 'ANSWER FROM FACTS:\n' + ((input.messages.find((m) => m.role === 'system').content.split('Facts:\n')[1]) || '') };
  const boom = () => { throw new Error('model unavailable'); };
  const nothing = { job_description: 'observation', components: [], tasks: [], scheduled_date_raw: null, installer_name: null };
  const t = (name, role, seed, transcript, ai, extra) => ({ kind: 'transcript', name, seed, transcript, capabilities: caps[role], ai, ...(extra || {}) });
  const pay = { intent: 'payment', customer_name: 'Jenny Smith', amount: 500 };
  const diesel = { intent: 'expense', amount: 650 };
  const lounge = (extra) => ({ ...nothing, job_description: 'laminate', components: [{ name: 'lounge', width: 5, length: 4, unit: 'm', area_sqm: null }], tasks: [{ description: 'laminate', component_name: null }], ...(extra || {}) });
  const A = 'Jenny paid R500', B = 'diesel for the bakkie R650', C = 'Thandi called about a quote';

  return [
    // ---------------- splitting and reading ----------------
    t('transcript: owner, one topic', 'owner', base, A, [SPLIT([A]), READ({ [A]: pay })]),
    t('transcript: owner, two topics are run separately and the replies are joined', 'owner', base, `${A} and ${B}`, [SPLIT([A, B]), READ({ [A]: pay, [B]: diesel })]),
    t('transcript: owner, three topics and the middle one is not understood', 'owner', base, `${A}. ${C}. ${B}`, [SPLIT([A, C, B]), READ({ [A]: pay, [C]: null, [B]: diesel })]),
    t('transcript: owner, the splitter fails so the whole message is one topic', 'owner', base, A, [SPLIT(boom), READ({ [A]: pay })]),
    t('transcript: owner, the splitter answers with something that is not a list', 'owner', base, A, [SPLIT('nonsense'), READ({ [A]: pay })]),
    t('transcript: owner, the splitter answers with an empty list', 'owner', base, A, [SPLIT([]), READ({ [A]: pay })]),
    t('transcript: owner, the splitter answers with a list that has a non-text item', 'owner', base, A, [SPLIT([1, 'x']), READ({ [A]: pay })]),
    t('transcript: owner, the model that reads the topic fails', 'owner', base, A, [SPLIT([A]), READ({ [A]: null })]),
    t('transcript: owner, every topic fails to read', 'owner', base, `${A} and ${B}`, [SPLIT([A, B]), READ({ [A]: null, [B]: null })]),
    t('transcript: owner, bare measurements are merged into the topic that follows them', 'owner', base, '3x3 store. 1.2x1.2 kitchen. Jenny Smith rooms measured in metres', [
      SPLIT(['3x3 store', '1.2x1.2 kitchen', 'Jenny Smith rooms measured in metres']),
      READ({ '3x3 store. 1.2x1.2 kitchen. Jenny Smith rooms measured in metres': { intent: 'note', customer_name: 'Jenny Smith' } })]),
    t('transcript: owner, a question and an action in one message', 'owner', base, `what is outstanding on the lounge job and ${A}`, [
      SPLIT(['what is outstanding on the lounge job', A]), READ({ 'what is outstanding on the lounge job': { intent: 'lookup', query_scope: 'business' }, [A]: pay }), DASH('NONE'), ANSWER]),

    // ---------------- what the capture records ----------------
    t('transcript: owner, a spoken message keeps its audio key', 'owner', base, A, [SPLIT([A]), READ({ [A]: pay })], { source: 'voice', r2Key: 'audio/1791000000000-abc.webm' }),

    // ---------------- attaching a new job to the customer's open project ----------------
    t('transcript: owner, a new job is attached to the customer\'s one open project', 'owner', oneProject, 'Jenny lounge is 5 by 4 metres, laminate', [SPLIT(['Jenny lounge is 5 by 4 metres, laminate']), READ({ 'Jenny lounge is 5 by 4 metres, laminate': { intent: 'work_observation', customer_name: 'Jenny Smith' } }), OBS(lounge())]),
    t('transcript: owner, a new job and the customer has two open projects, so it asks which', 'owner', twoProjects, 'Jenny lounge is 5 by 4 metres, laminate', [SPLIT(['Jenny lounge is 5 by 4 metres, laminate']), READ({ 'Jenny lounge is 5 by 4 metres, laminate': { intent: 'work_observation', customer_name: 'Jenny Smith' } }), OBS(lounge())]),
    t('transcript: owner, a new job and the customer has no open project', 'owner', base, 'Jenny lounge is 5 by 4 metres, laminate', [SPLIT(['Jenny lounge is 5 by 4 metres, laminate']), READ({ 'Jenny lounge is 5 by 4 metres, laminate': { intent: 'work_observation', customer_name: 'Jenny Smith' } }), OBS(lounge())]),
    t('transcript: owner, two jobs for a customer with two open projects, asked about each', 'owner', twoProjects, 'Jenny lounge is 5 by 4 metres. Jenny kitchen is 3 by 3 metres.', [
      SPLIT(['Jenny lounge is 5 by 4 metres', 'Jenny kitchen is 3 by 3 metres']),
      READ({ 'Jenny lounge is 5 by 4 metres': { intent: 'work_observation', customer_name: 'Jenny Smith' }, 'Jenny kitchen is 3 by 3 metres': { intent: 'work_observation', customer_name: 'Jenny Smith' } }),
      OBS(lounge())]),

    t('transcript: owner, one job and an expense in one message, and the customer has two open projects', 'owner', twoProjects, 'Jenny lounge is 5 by 4 metres, laminate, and diesel for the bakkie R650', [
      SPLIT(['Jenny lounge is 5 by 4 metres, laminate', B]), READ({ 'Jenny lounge is 5 by 4 metres, laminate': { intent: 'work_observation', customer_name: 'Jenny Smith' }, [B]: diesel }), OBS(lounge())]),

    t('transcript: owner, two jobs and the customer has one open project: both are attached to it', 'owner', oneProject, 'Jenny lounge is 5 by 4 metres. Jenny kitchen is 3 by 3 metres.', [
      SPLIT(['Jenny lounge is 5 by 4 metres', 'Jenny kitchen is 3 by 3 metres']),
      READ({ 'Jenny lounge is 5 by 4 metres': { intent: 'work_observation', customer_name: 'Jenny Smith' }, 'Jenny kitchen is 3 by 3 metres': { intent: 'work_observation', customer_name: 'Jenny Smith' } }),
      OBS(lounge())]),
    t('transcript: owner, two jobs and the customer has no open project: they are grouped under a new one', 'owner', base, 'Jenny lounge is 5 by 4 metres. Jenny kitchen is 3 by 3 metres.', [
      SPLIT(['Jenny lounge is 5 by 4 metres', 'Jenny kitchen is 3 by 3 metres']),
      READ({ 'Jenny lounge is 5 by 4 metres': { intent: 'work_observation', customer_name: 'Jenny Smith' }, 'Jenny kitchen is 3 by 3 metres': { intent: 'work_observation', customer_name: 'Jenny Smith' } }),
      OBS(lounge())]),
    t('transcript: owner, two jobs and the customer\'s only project is paid in full, so it is not open and they are grouped under a new one', 'owner', paidProject, 'Jenny lounge is 5 by 4 metres. Jenny kitchen is 3 by 3 metres.', [
      SPLIT(['Jenny lounge is 5 by 4 metres', 'Jenny kitchen is 3 by 3 metres']),
      READ({ 'Jenny lounge is 5 by 4 metres': { intent: 'work_observation', customer_name: 'Jenny Smith' }, 'Jenny kitchen is 3 by 3 metres': { intent: 'work_observation', customer_name: 'Jenny Smith' } }),
      OBS(lounge())]),

    // ---------------- several things waiting for an answer (the app shows a Confirm and Reject for each) ----------------
    t('transcript: owner, an invoice and a date change for a customer who already has a job: both waiting actions are listed', 'owner', (db) => {
      base(db);
      db.exec(`
        INSERT INTO job_scopes (id, customer_id, description, scheduled_date_raw, scheduled_date, created_at) VALUES (1, 1, 'Lounge laminate', 'the 10th', '2026-10-10', '2026-10-01 08:00:00');
        INSERT INTO scope_components (id, job_scope_id, name, width_mm, length_mm, area_sqm) VALUES (1, 1, 'Lounge', 5000, 4000, 20);
      `);
    }, 'invoice Jenny R3000 and move the install to the 17th', [
      SPLIT(['invoice Jenny R3000 and move the install to the 17th']),
      READ({ 'invoice Jenny R3000 and move the install to the 17th': { intent: 'invoice', customer_name: 'Jenny Smith', amount: 3000 } }),
      OBS({ ...nothing, scheduled_date_raw: 'the seventeenth' })]),

    // ---------------- roles ----------------
    t('transcript: installer, a money topic is refused and a snag in the same message is recorded', 'installer', base, `${A}. Jenny carpet has a loose seam`, [
      SPLIT([A, 'Jenny carpet has a loose seam']), READ({ [A]: pay, 'Jenny carpet has a loose seam': { intent: 'raise_snag', customer_name: 'Jenny Smith' } }), SNAG({ description: 'loose seam' })]),
    t('transcript: a role with no permissions, a money topic is refused', 'stranger', base, A, [SPLIT([A]), READ({ [A]: pay })]),
  ];
};
