// Characterization cases for the upload handlers (/files/document and /files/photo): a stored file, its description (read
// from a PDF's text layer, or described by a vision model), a caption that may name a supplier or customer, and then the
// supplier-document flow: a delivery note (recorded or held), a supplier invoice (held) or a supplier statement
// (compared with the books), or nothing. The PDFs are real, with a real text layer, so the text extraction is exercised.
// The two handlers contain the same 131-line decision section; pairs of cases below must therefore behave identically.
module.exports = function cases(caps) {
  const DEFAULTS = { customer_name: null, character_name: null, character_relationship: null, intent: 'other', amount: null, fact_key: null, fact_value: null, personal_note: null, query_scope: null, deposit_percent: null, scope_document_type: null, due_date_raw: null };
  const base = (db) => db.exec(`
    INSERT INTO people (name) VALUES ('Jenny Smith'), ('Floornet'), ('Belgotex');
    INSERT INTO customers (name, person_id) VALUES ('Jenny Smith', 1);
    INSERT INTO characters (name, relationship, person_id) VALUES ('Floornet', 'supplier', 2), ('Belgotex', 'supplier', 3);
  `);
  const withOrder = (db) => {
    base(db);
    db.exec(`
      INSERT INTO purchase_orders (id, supplier_id, description, created_at) VALUES (1, 1, 'Vinyl and underlay', '2026-10-01 08:00:00');
      INSERT INTO po_line_items (id, purchase_order_id, description, quantity_ordered, unit, unit_price_expected) VALUES (1, 1, 'Vinyl', 50, 'sqm', 180), (2, 1, 'Underlay', 100, 'sqm', 40);
    `);
  };
  // What a supplier is owed is built from expenses against them (a supplier invoice records one) less payments made.
  const withBooks = (db) => { withOrder(db); db.exec(`INSERT INTO expenses (character_id, amount, description, source_transcript, category, created_at) VALUES (1, 9250, 'vinyl', 'Floornet invoice INV-1', 'materials', '2026-09-10 08:00:00');`); };
  const twoFloornets = (db) => db.exec(`
    INSERT INTO people (name) VALUES ('Floornet Cape'), ('Floornet Joburg');
    INSERT INTO characters (name, relationship, person_id) VALUES ('Floornet Cape', 'supplier', 1), ('Floornet Joburg', 'supplier', 2);
  `);
  const IDENT = (reply) => ({ match: /Decide what kind of document it is and which business ISSUED it/, reply });
  const STMT = (reply) => ({ match: /claimed_closing_balance/, reply });
  const DESCRIBE = (text) => ({ match: /Describe exactly what is shown in this photo/, reply: text });
  const READ = (byCaption) => ({ match: /Extract structured facts from a tradesperson's message/, reply: (input) => {
    const cap = input.messages.find((m) => m.role === 'user').content;
    if (!(cap in byCaption)) throw new Error('no scripted reading for caption: ' + cap);
    return { ...DEFAULTS, ...byCaption[cap] };
  } });
  const GRAI = (reply) => ({ match: /quantity_received/, reply });
  const SIAI = (reply) => ({ match: /quantity_billed/, reply });
  const boom = () => { throw new Error('model unavailable'); };
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nWP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
  const pdf = (lines, name) => ({ name: name || 'scan.pdf', type: 'application/pdf', pdfLines: lines });
  const png = { name: 'photo.png', type: 'image/png', base64: PNG };
  const up = (name, role, seed, kind, file, extra, ai) => ({ kind: 'route', name, seed, path: kind === 'photo' ? '/files/photo' : '/files/document', role, before: [], ai, form: { [kind === 'photo' ? 'photo' : 'document']: file, ...(extra || {}) } });

  const noteLines = ['Floornet (Pty) Ltd', 'DELIVERY NOTE', 'Vinyl 50 sqm'];
  const invoiceLines = ['Floornet (Pty) Ltd', 'TAX INVOICE INV-7731', 'Vinyl 50 sqm at R185', 'Underlay 100 sqm at R40'];
  const stmtLines = ['Floornet (Pty) Ltd', 'STATEMENT OF ACCOUNT', 'Closing Balance: R20,000.00'];
  const delivery50 = GRAI({ supplier_name: 'Floornet', line_items: [{ matched_description: 'Vinyl', item_description: 'vinyl', unit: 'sqm', quantity_received: 50 }] });
  const noPrices = SIAI({ supplier_name: 'Floornet', supplier_reference: null, line_items: [{ matched_description: 'Vinyl', quantity_billed: 50, unit_price_billed: null }] });
  const priced = SIAI({ supplier_name: 'Floornet', supplier_reference: 'INV-7731', line_items: [{ matched_description: 'Vinyl', quantity_billed: 50, unit_price_billed: 185 }, { matched_description: 'Underlay', quantity_billed: 100, unit_price_billed: 40 }] });
  const floornetNote = 'Floornet delivery';
  const asFloornet = READ({ [floornetNote]: { intent: 'goods_received', character_name: 'Floornet', character_relationship: 'supplier' } });
  const noteText = 'Floornet (Pty) Ltd DELIVERY NOTE Vinyl 50 sqm';

  const specs = [
    // ---------------- a delivery note, with the supplier read from the document itself ----------------
    up('document: a delivery note, the supplier is read from the document, so it is held for confirmation', 'owner', withOrder, 'document', pdf(noteLines), {}, [IDENT({ document_type: 'delivery_note', issuer_name: 'Floornet (Pty) Ltd' }), delivery50]),
    up('document: a delivery note read from the document by an installer is held too', 'installer', withOrder, 'document', pdf(noteLines), {}, [IDENT({ document_type: 'delivery_note', issuer_name: 'Floornet (Pty) Ltd' }), delivery50]),
    up('document: a delivery note whose issuer is not a supplier on file', 'owner', withOrder, 'document', pdf(['Mystery Traders', 'DELIVERY NOTE', 'Vinyl 50 sqm']), {}, [IDENT({ document_type: 'delivery_note', issuer_name: 'Mystery Traders' })]),
    up('document: a delivery note whose issuer could be either of two suppliers', 'owner', (db) => twoFloornets(db), 'document', pdf(['Floornet', 'DELIVERY NOTE', 'Vinyl 50 sqm']), {}, [IDENT({ document_type: 'delivery_note', issuer_name: 'Floornet' })]),
    up('document: a delivery note with no issuer that can be read', 'owner', withOrder, 'document', pdf(['DELIVERY NOTE', 'Vinyl 50 sqm']), {}, [IDENT({ document_type: 'delivery_note', issuer_name: null })]),
    up('document: a document that is none of the supplier kinds is only stored', 'owner', withOrder, 'document', pdf(['Happy birthday Jenny']), {}, [IDENT({ document_type: 'other', issuer_name: null })]),
    up('document: the model that reads the document type fails', 'owner', withOrder, 'document', pdf(noteLines), {}, [IDENT(boom)]),

    // ---------------- a caption names the supplier ----------------
    up('document: a caption names the supplier, so a delivery note is recorded directly', 'owner', withOrder, 'document', pdf(noteLines), { caption: floornetNote }, [asFloornet, noPrices, delivery50]),
    up('document: a caption names the supplier and an installer uploads the delivery note', 'installer', withOrder, 'document', pdf(noteLines), { caption: floornetNote }, [asFloornet, noPrices, delivery50]),
    up('document: a caption names the supplier, and the order is not on the note', 'owner', withOrder, 'document', pdf(['Floornet (Pty) Ltd', 'DELIVERY NOTE', 'Grout 5 bags']), { caption: floornetNote },
      [asFloornet, noPrices, GRAI({ supplier_name: 'Floornet', line_items: [{ matched_description: null, item_description: 'grout', unit: 'bag', quantity_received: 5 }] })]),
    up('document: a caption names the supplier and no items can be made out', 'owner', withOrder, 'document', pdf(noteLines), { caption: floornetNote }, [asFloornet, noPrices, GRAI({ supplier_name: 'Floornet', line_items: [] })]),
    up('document: a caption names a supplier with no open order, and it is a delivery note', 'owner', base, 'document', pdf(noteLines), { caption: floornetNote }, [asFloornet, IDENT({ document_type: 'delivery_note', issuer_name: 'Floornet (Pty) Ltd' }), delivery50]),
    up('document: a caption names a supplier with no open order, and it is not a delivery note', 'owner', base, 'document', pdf(['Floornet (Pty) Ltd', 'Price list']), { caption: floornetNote }, [asFloornet, IDENT({ document_type: 'other', issuer_name: 'Floornet (Pty) Ltd' })]),

    // ---------------- a supplier invoice ----------------
    up('document: a priced supplier invoice is held for confirmation', 'owner', withOrder, 'document', pdf(invoiceLines), { caption: 'Floornet invoice' }, [READ({ 'Floornet invoice': { intent: 'supplier_invoice', character_name: 'Floornet', character_relationship: 'supplier' } }), priced]),
    up('document: a priced supplier invoice from an accountant', 'accountant', withOrder, 'document', pdf(invoiceLines), { caption: 'Floornet invoice' }, [READ({ 'Floornet invoice': { intent: 'supplier_invoice', character_name: 'Floornet', character_relationship: 'supplier' } }), priced]),
    up('document: a priced supplier invoice from an installer is refused', 'installer', withOrder, 'document', pdf(invoiceLines), { caption: 'Floornet invoice' }, [READ({ 'Floornet invoice': { intent: 'supplier_invoice', character_name: 'Floornet', character_relationship: 'supplier' } }), priced]),
    up('document: a supplier invoice read from the document alone is held', 'owner', withOrder, 'document', pdf(invoiceLines), {}, [IDENT({ document_type: 'supplier_invoice', issuer_name: 'Floornet (Pty) Ltd' }), priced]),

    // ---------------- a supplier statement ----------------
    up('document: a statement is compared with the books', 'owner', withBooks, 'document', pdf(stmtLines), { caption: 'statement from Floornet' }, [READ({ 'statement from Floornet': { intent: 'supplier_statement', character_name: 'Floornet', character_relationship: 'supplier' } }), STMT({ claimed_closing_balance: 20000 })]),
    up('document: a statement read from the document alone is compared', 'owner', withBooks, 'document', pdf(stmtLines), {}, [IDENT({ document_type: 'supplier_statement', issuer_name: 'Floornet (Pty) Ltd' }), STMT({ claimed_closing_balance: 20000 })]),
    up('document: a statement with no closing balance on it', 'owner', withBooks, 'document', pdf(['Floornet (Pty) Ltd', 'STATEMENT OF ACCOUNT']), { caption: 'statement from Floornet' }, [READ({ 'statement from Floornet': { intent: 'supplier_statement', character_name: 'Floornet', character_relationship: 'supplier' } }), STMT({ claimed_closing_balance: null })]),
    up('document: a statement from an installer is refused', 'installer', withBooks, 'document', pdf(stmtLines), { caption: 'statement from Floornet' }, [READ({ 'statement from Floornet': { intent: 'supplier_statement', character_name: 'Floornet', character_relationship: 'supplier' } })]),

    // ---------------- every kind of file ----------------
    up('document: a scanned PDF with no text layer', 'owner', withOrder, 'document', pdf([]), {}, [IDENT({ document_type: 'other', issuer_name: null })]),
    up('document: a plain text file', 'owner', withOrder, 'document', { name: 'notes.txt', type: 'text/plain', text: 'some notes' }, {}, [IDENT({ document_type: 'other', issuer_name: null })]),
    up('document: an image', 'owner', withOrder, 'document', png, {}, [DESCRIBE('A sheet of paper that reads: Happy birthday Jenny'), IDENT({ document_type: 'other', issuer_name: null })]),
    up('document: an image the vision model cannot describe', 'owner', withOrder, 'document', png, {}, [{ match: /Describe exactly what is shown in this photo/, reply: boom }, IDENT({ document_type: 'other', issuer_name: null })]),
    { kind: 'route', name: 'document: no file in the request', seed: withOrder, path: '/files/document', role: 'owner', before: [], ai: [], form: { caption: 'Floornet delivery' } },
    { ...up('document: signed out', 'owner', withOrder, 'document', pdf(noteLines), {}, []), noSession: true },
    { ...up('document: signed in but not a member', 'nobody', withOrder, 'document', pdf(noteLines), {}, []) },

    // ---------------- a caption that names a customer, and a retry ----------------
    up('document: a caption names a customer not on file, and the customer is created before any permission check', 'installer', withOrder, 'document', pdf(['Quote for the lounge']), { caption: 'Brand New Person lounge quote' }, [READ({ 'Brand New Person lounge quote': { intent: 'quotation', customer_name: 'Brand New Person' } })]),
    { ...up('document: the same upload sent again is answered from the first', 'owner', withOrder, 'document', pdf(noteLines), { idempotency_key: 'upload-key-1' }, [IDENT({ document_type: 'delivery_note', issuer_name: 'Floornet (Pty) Ltd' }), delivery50]),
      before: [{ route: true, method: 'POST', path: '/files/document', role: 'owner', form: { document: pdf(noteLines), idempotency_key: 'upload-key-1' } }] },

    // ---------------- the same logic through the photo handler ----------------
    up('photo: a delivery note read from the photo, held for confirmation', 'owner', withOrder, 'photo', png, {}, [DESCRIBE(noteText), IDENT({ document_type: 'delivery_note', issuer_name: 'Floornet (Pty) Ltd' }), delivery50]),
    up('photo: a caption names the supplier, so a delivery is recorded directly', 'owner', withOrder, 'photo', png, { caption: floornetNote }, [DESCRIBE(noteText), asFloornet, noPrices, delivery50]),
    up('photo: a photographed delivery note whose issuer is not a supplier on file', 'owner', withOrder, 'photo', png, {}, [DESCRIBE('Mystery Traders DELIVERY NOTE Vinyl 50 sqm'), IDENT({ document_type: 'delivery_note', issuer_name: 'Mystery Traders' })]),
    up('photo: a priced supplier invoice photographed by an installer is refused', 'installer', withOrder, 'photo', png, { caption: 'Floornet invoice' }, [DESCRIBE('Floornet TAX INVOICE Vinyl 50 sqm at R185'), READ({ 'Floornet invoice': { intent: 'supplier_invoice', character_name: 'Floornet', character_relationship: 'supplier' } }), priced]),
    up('photo: an ordinary site photo with no caption', 'owner', withOrder, 'photo', png, {}, [DESCRIBE('A half-laid vinyl floor in a lounge'), IDENT({ document_type: 'other', issuer_name: null })]),
    up('photo: an ordinary site photo with a caption naming a customer', 'owner', withOrder, 'photo', png, { caption: 'Jenny lounge so far' }, [DESCRIBE('A half-laid vinyl floor in a lounge'), READ({ 'Jenny lounge so far': { intent: 'note', customer_name: 'Jenny Smith' } })]),
    up('photo: the vision model fails', 'owner', withOrder, 'photo', png, {}, [{ match: /Describe exactly what is shown in this photo/, reply: boom }, IDENT({ document_type: 'other', issuer_name: null })]),
    { kind: 'route', name: 'photo: no file in the request', seed: withOrder, path: '/files/photo', role: 'owner', before: [], ai: [], form: { caption: 'Jenny lounge so far' } },
  ];

  // ---------------- a voice note: transcribed, then run through the whole message flow ----------------
  const WHISPER = (reply) => ({ match: /@cf\/openai\/whisper/, raw: true, reply });
  const SPLIT = (reply) => ({ match: /Find genuinely SEPARATE topics and split/, reply });
  const READ_SEGMENTS = (bySegment) => ({ match: /Extract structured facts from a tradesperson's message/, reply: (input) => {
    const seg = input.messages.find((m) => m.role === 'user').content;
    if (!(seg in bySegment)) throw new Error('no scripted reading for: ' + seg);
    return { ...DEFAULTS, ...bySegment[seg] };
  } });
  const SNAG = (reply) => ({ match: /reporting a real, physical quality issue found on a job/, reply });
  const voice = { name: 'note.m4a', type: 'audio/mp4', text: 'fake audio bytes' };
  const A = 'Jenny paid R500';
  const payA = { intent: 'payment', customer_name: 'Jenny Smith', amount: 500 };
  const audio = (name, role, seed, extra, ai, more) => ({ kind: 'route', name, seed, path: '/files/audio', role, before: [], ai, form: { audio: voice, ...(extra || {}) }, ...(more || {}) });
  specs.push(
    audio('audio: a voice note is transcribed and processed', 'owner', withOrder, {}, [WHISPER({ text: A }), SPLIT([A]), READ_SEGMENTS({ [A]: payA })]),
    audio('audio: two topics in one voice note', 'owner', withOrder, {}, [WHISPER({ text: `${A} and diesel R650` }), SPLIT([A, 'diesel R650']), READ_SEGMENTS({ [A]: payA, 'diesel R650': { intent: 'expense', amount: 650 } })]),
    audio('audio: a voice note from an installer, a money topic is refused and a snag is recorded', 'installer', withOrder, {}, [WHISPER({ text: `${A}. Jenny carpet has a loose seam` }), SPLIT([A, 'Jenny carpet has a loose seam']),
      READ_SEGMENTS({ [A]: payA, 'Jenny carpet has a loose seam': { intent: 'raise_snag', customer_name: 'Jenny Smith' } }), SNAG({ description: 'loose seam' })]),
    audio('audio: the transcription fails', 'owner', withOrder, {}, [WHISPER(boom)]),
    audio('audio: the transcription is empty', 'owner', withOrder, {}, [WHISPER({ text: '' })]),
    audio('audio: a follow-up uses the conversation sent with it', 'owner', withOrder, { history: JSON.stringify([{ role: 'user', text: 'how is Jenny doing' }, { role: 'office', text: 'Jenny is fine.' }]) },
      [WHISPER({ text: 'and her balance' }), SPLIT(['and her balance']), READ_SEGMENTS({ 'and her balance': { intent: 'lookup', query_scope: 'customer' } }),
       { match: /STANDING TOPIC of the conversation below/, reply: { name: 'Jenny Smith' } },
       { match: /Answer the tradesperson's question using only the facts below/, reply: (input) => 'ANSWER FROM FACTS:\n' + ((input.messages.find((m) => m.role === 'system').content.split('Facts:\n')[1]) || '') }]),
    { kind: 'route', name: 'audio: no file in the request', seed: withOrder, path: '/files/audio', role: 'owner', before: [], ai: [], form: {} },
    { ...audio('audio: the same voice note sent again is answered from the first', 'owner', withOrder, { idempotency_key: 'voice-key-1' }, [WHISPER({ text: A }), SPLIT([A]), READ_SEGMENTS({ [A]: payA })]),
      before: [{ route: true, method: 'POST', path: '/files/audio', role: 'owner', form: { audio: voice, idempotency_key: 'voice-key-1' } }] },
  );

  // The document handler's image path and the photo handler share one 131-line decision section. Given the same description
  // and the same models, they must agree on what to say, whether to refuse, and what to hold.
  const same = ['message', 'refusal', 'pendingActionId', 'subjectHint'];
  const asImage = (name, role, seed, extra, ai) => up(name, role, seed, 'document', png, extra, ai);
  specs.push(
    asImage('document (image): a delivery note read from the image, held for confirmation', 'owner', withOrder, {}, [DESCRIBE(noteText), IDENT({ document_type: 'delivery_note', issuer_name: 'Floornet (Pty) Ltd' }), delivery50]),
    asImage('document (image): a caption names the supplier, so a delivery is recorded directly', 'owner', withOrder, { caption: floornetNote }, [DESCRIBE(noteText), asFloornet, noPrices, delivery50]),
    asImage('document (image): a delivery note whose issuer is not a supplier on file', 'owner', withOrder, {}, [DESCRIBE('Mystery Traders DELIVERY NOTE Vinyl 50 sqm'), IDENT({ document_type: 'delivery_note', issuer_name: 'Mystery Traders' })]),
    asImage('document (image): a priced supplier invoice from an installer is refused', 'installer', withOrder, { caption: 'Floornet invoice' }, [DESCRIBE('Floornet TAX INVOICE Vinyl 50 sqm at R185'), READ({ 'Floornet invoice': { intent: 'supplier_invoice', character_name: 'Floornet', character_relationship: 'supplier' } }), priced]),
  );
  specs.pairs = [
    ['document (image): a delivery note read from the image, held for confirmation', 'photo: a delivery note read from the photo, held for confirmation', same],
    ['document (image): a caption names the supplier, so a delivery is recorded directly', 'photo: a caption names the supplier, so a delivery is recorded directly', same],
    ['document (image): a delivery note whose issuer is not a supplier on file', 'photo: a photographed delivery note whose issuer is not a supplier on file', same],
    ['document (image): a priced supplier invoice from an installer is refused', 'photo: a priced supplier invoice photographed by an installer is refused', same],
  ];
  return specs;
};
