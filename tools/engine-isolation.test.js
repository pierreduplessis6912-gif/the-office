// Engine tenant isolation, Task 3 (branch engine-phase1). TESTS ONLY: no source was changed for them.
// THE QUESTION: can one business access, mutate or infer another business's data through the engine's record references, relationships, operations or authorization boundaries?
// THE LAYERS, tested SEPARATELY so one cannot hide a failure in another (each test name says which boundary it is about):
//   ROUTER      routeRequest (routing.ts): which business a request is sent to. A fake-free unit test of the routing decision. It CANNOT show what the Worker's fetch does with that decision.
//   OBJECT      one real BusinessObject, with NO router in front: it refuses anything not made for its own business.
//   FRONT DOOR  the Worker's REAL default-export fetch -> routeRequest -> forwardToBusiness -> two REAL business objects -> the real engine routes.
//   MISROUTE    the router is made wrong ON PURPOSE (a request for A is delivered to B's object): the object must still refuse, and nothing of B may reach A.
// WHAT THIS IS NOT: the namespace is a plain map of object names to objects and storage is a stand-in over Node SQLite. This is NOT real Cloudflare routing and NOT a real Durable Object; engine isolation on a real object is unproven.
//   It also says nothing about Flutter, MCP, the admin routes, file storage or signed links (their own mechanisms and legacy tests), timing or other side channels, or permissions WITHIN a business.
// WHAT PROVES THE TESTS CAN FAIL: tools/engine-breakage.js removes one tenant-boundary protection at a time (the router's use of the session, its signature check, the object's session-business check, the object's one-business binding,
//   the forwarding step's header overwrite) and a COMPOUND removal of the router, session check and binding together, which must make this suite show a real leak. It proves these checks catch those faults, not that every leak is detectable.
// FIXTURES: two engine businesses with OVERLAPPING ids (party 1, document 1, payment 1 in both) but different data, so nothing here can pass merely because ids are globally unique, plus one PERSON who is an active member of BOTH
//   (the session's business claim is then the only thing separating them: membership alone would let them in).
const crypto = require('crypto');
const kit = require('./engine-kit.js');

module.exports = kit.guard('engine isolation', async ({ check }) => {
  const eng = kit.loadEngine();
  const fns = await kit.buildHandler(), auth = fns.auth;
  const routing = kit.bundle('routing.ts', 'routing');

  // =====================================================================================================================================================================================================================
  // ROUTER: which business does a request go to? (routeRequest only: this is the router's responsibility, not the Worker's fetch)
  // =====================================================================================================================================================================================================================
  const renv = { SESSION_SECRET: 'router-secret', ADMIN_KEY: 'k-admin' };
  const route = (p, init = {}) => routing.routeRequest(new Request('https://office.example' + p, init), renv);
  const sess = (email, b, env = renv) => auth.signSession(env, email, b);
  const cookie = (t, extra = {}) => ({ headers: { cookie: `office_session=${t}`, ...extra } });
  const goes = (r, id) => r.kind === 'business' && r.businessId === id;
  const ENGINE_PATHS = [['GET', '/engine/receivables?party=1'], ['GET', '/engine/records/document/1'], ['POST', '/engine/proposals'], ['POST', '/actions/1/confirm']];
  const rA = await sess('a@x.co', 'alpha-co'), rB = await sess('b@x.co', 'beta-co');

  let all = true;
  for (const [method, p] of ENGINE_PATHS) all = all && goes(await route(p, { method, ...cookie(rA) }), 'alpha-co') && goes(await route(p, { method, ...cookie(rB) }), 'beta-co');
  check(all, 'ROUTER: on every engine path (records, receivables, proposals, confirm) a session goes to ITS business: alpha to alpha-co, beta to beta-co');
  all = true;
  for (const [method, p] of ENGINE_PATHS) all = all && goes(await route(p, { method, headers: { Authorization: 'Bearer ' + rA } }), 'alpha-co');
  check(all, 'ROUTER: the same when the session arrives as a bearer token');

  all = true;
  for (const [method, p] of ENGINE_PATHS) {
    all = all && goes(await route(p, { method, ...cookie(rA, { 'X-Business-Id': 'beta-co' }) }), 'alpha-co')
      && goes(await route(p, { method, ...cookie(rA, { 'X-Target-Business': 'beta-co' }) }), 'alpha-co')
      && goes(await route(p, { method, ...cookie(rA, { 'X-Admin-Key': 'k-admin', 'X-Target-Business': 'beta-co', 'X-Business-Id': 'beta-co' }) }), 'alpha-co');
  }
  check(all, 'ROUTER: on every engine path a client-supplied X-Business-Id, X-Target-Business, or even a VALID admin key with a target, changes nothing: the session decides (the admin header only means something on an admin path)');

  const [payload, sig] = rA.split('.');
  const forgedB = Buffer.from(JSON.stringify({ email: 'a@x.co', exp: Date.now() + 1e6, b: 'beta-co' })).toString('base64url');
  const expired = await (async () => { const real = Date.now; Date.now = () => real() - 40 * 24 * 3600 * 1000; try { return await sess('a@x.co', 'alpha-co'); } finally { Date.now = real; } })();
  const forged = { 'a session with no business': await sess('a@x.co', undefined), 'a session signed with another secret': await auth.signSession({ ...renv, SESSION_SECRET: 'someone-else' }, 'a@x.co', 'alpha-co'), 'a session whose business was altered after signing': forgedB + '.' + sig, 'an expired session': expired, 'garbage': 'not-a-token' };
  for (const [name, token] of Object.entries(forged)) {
    all = true;
    for (const [method, p] of ENGINE_PATHS) { const r = await route(p, { method, ...cookie(token) }); all = all && r.kind === 'worker'; }
    check(all, `ROUTER: ${name} is never sent to a business on any engine path: it is left to the Worker, which refuses it`);
  }
  all = true;
  for (const [method, p] of ENGINE_PATHS) all = all && (await route(p, { method })).kind === 'worker';
  check(all, 'ROUTER: a request with no session is left to the Worker on every engine path, and /engine and /actions are not among the paths the Worker answers by itself');

  const adminHdr = (extra = {}) => ({ method: 'POST', headers: { 'X-Admin-Key': 'k-admin', ...extra } });
  for (const p of ['/admin/engine/status', '/admin/engine/provision-sample']) {
    check(goes(await route(p, adminHdr({ 'X-Target-Business': 'beta-co' })), 'beta-co'), `ROUTER: ${p} with the right admin key goes to the business it NAMES`);
    const none = await route(p, adminHdr());
    check(none.kind === 'refuse' && none.status === 400, `ROUTER: ${p} with the key but no business named is refused 400, never guessed (${none.kind} ${none.status})`);
    const bad = await route(p, adminHdr({ 'X-Target-Business': 'NOT a business!' }));
    check(bad.kind === 'refuse' && bad.status === 400, `ROUTER: ${p} naming something that is not a business id is refused 400`);
    check((await route(p, { method: 'POST', headers: { 'X-Admin-Key': 'wrong', 'X-Target-Business': 'beta-co' } })).kind === 'worker' && (await route(p, { method: 'POST', headers: { 'X-Target-Business': 'beta-co' } })).kind === 'worker', `ROUTER: ${p} with a wrong or no admin key is left to the Worker's own admin gate, even when it names a business`);
  }

  // =====================================================================================================================================================================================================================
  // THE FIXTURES: two engine businesses behind the real front door, overlapping ids, different data, one person in both
  // =====================================================================================================================================================================================================================
  const f = await kit.makeFleet({ ids: ['alpha-co', 'beta-co'] });
  const CTX = { actorEmail: 'seed@example.com', contract: 'test', contractVersion: 1 };
  const lines = (price, tax) => [{ description: 'Work', quantityMilli: 1000, unit: 'm2', unitPriceMinor: price, taxBp: tax }];
  const seed = async (b, spec) => {
    const obj = f.objects['business-' + b], e = { OFFICE_DB: obj.db };
    for (const [email, role] of spec.members) await obj.db.prepare("INSERT INTO memberships (google_email, role, status) VALUES (?, ?, 'active')").bind(email, role).run();
    await obj.db.prepare("INSERT INTO eng_config (key, value_json) VALUES ('mode', '\"engine\"')").run();
    await obj.db.prepare("INSERT INTO eng_config (key, value_json) VALUES ('available', ?)").bind(JSON.stringify(kit.ALL_CAPABILITIES)).run();
    const pid = [], did = [];
    for (const name of spec.parties) pid.push((await eng.facts.recordParty(e, { kind: 'person', name, roles: ['customer'] }, CTX)).id);
    for (const d of spec.documents) did.push((await eng.facts.recordDocument(e, { kind: 'invoice', direction: 'sell', partyId: pid[d.party], currency: 'ZAR', issuedOn: '2026-10-0' + (d.party + 1), lines: lines(d.price, d.tax) }, CTX)).id);
    for (const m of spec.movements) {
      if (m.doc !== undefined) await eng.facts.recordPayment(e, { direction: 'in', partyId: pid[m.party], amountMinor: m.amount, currency: 'ZAR', occurredOn: '2026-10-20', allocations: [{ documentId: did[m.doc], amountMinor: m.alloc }] }, CTX);
      else await eng.facts.recordMovement(e, { direction: 'in', partyId: pid[m.party], amountMinor: m.amount, currency: 'ZAR', occurredOn: '2026-10-21' }, CTX);
    }
  };
  // alpha-co: parties 1-2, documents 1-2, payments 1-3.   beta-co: parties 1-3, documents 1-3, payments 1-2.   Overlap: party 1-2, document 1-2, payment 1-2. Only in beta-co: party 3, document 3. Only in alpha-co: payment 3.
  await seed('alpha-co', { members: [['owner@alpha.example', 'owner'], ['both@example.com', 'accountant']], parties: ['ALPHA CUSTOMER', 'ALPHA TWO'], documents: [{ party: 0, price: 123400, tax: 1500 }, { party: 1, price: 20000, tax: 0 }], movements: [{ party: 0, amount: 30000, doc: 0, alloc: 20000 }, { party: 1, amount: 7000 }, { party: 0, amount: 9100 }] });
  await seed('beta-co', { members: [['owner@beta.example', 'owner'], ['both@example.com', 'accountant']], parties: ['BETA CUSTOMER', 'BETA SECOND', 'BETA THIRD'], documents: [{ party: 0, price: 777000, tax: 1500 }, { party: 1, price: 555000, tax: 0 }, { party: 2, price: 424200, tax: 0 }], movements: [{ party: 0, amount: 100000, doc: 0, alloc: 100000 }, { party: 1, amount: 55000, doc: 1, alloc: 55000 }] });
  const A_ONLY = /ALPHA|141910|123400|121910/, B_ONLY = /BETA|893550|555000|424200|793550/;   // strings that can appear only in one business's responses
  const tA = await f.token('owner@alpha.example', 'alpha-co'), tB = await f.token('owner@beta.example', 'beta-co');
  const tBothA = await f.token('both@example.com', 'alpha-co'), tBothB = await f.token('both@example.com', 'beta-co');
  const hdr = (t, extra = {}) => ({ headers: { cookie: 'office_session=' + t, 'content-type': 'application/json', ...extra } });
  const grab = async (res) => ({ status: res.status, text: await res.text(), headers: JSON.stringify([...res.headers].sort()) });
  const get = async (p, t, extra) => grab(await f.front(p, hdr(t, extra)));
  const post = async (p, t, body) => grab(await f.front(p, { method: 'POST', ...hdr(t), body: JSON.stringify(body) }));
  const direct = async (b, p, init) => grab(await f.direct(b, p, init));
  const fp = (b) => { const raw = f.raws[b], h = crypto.createHash('sha256'); for (const { name } of raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()) { h.update(name); h.update(raw.prepare(`SELECT * FROM "${name}"`).all().map((r) => JSON.stringify(r)).sort().join('\n')); } return h.digest('hex'); };
  const eventCount = (b) => Number(f.raws[b].prepare('SELECT MAX(id) AS n FROM eng_event').get().n);
  const sameAnswer = (x, y, ids = []) => { const n = (s) => ids.reduce((t, id) => t.replace(new RegExp('\\b' + id + '\\b', 'g'), '<id>'), s); return x.status === y.status && n(x.text) === n(y.text) && x.headers === y.headers; };

  // bind each object to its own business, as provisioning does: an object remembers the first business that names it
  await direct('alpha-co', '/health', { headers: { 'X-Business-Id': 'alpha-co' } }); await direct('beta-co', '/health', { headers: { 'X-Business-Id': 'beta-co' } });
  const bound = (b) => f.raws[b].prepare("SELECT value FROM object_meta WHERE key = 'business_id'").get()?.value;
  check(bound('alpha-co') === 'alpha-co' && bound('beta-co') === 'beta-co', 'FIXTURE: each object is bound to its own business');

  // =====================================================================================================================================================================================================================
  // FRONT DOOR: the Worker's real fetch, through the router and both real objects
  // =====================================================================================================================================================================================================================
  const a1 = await get('/engine/records/document/1', tA), b1 = await get('/engine/records/document/1', tB);
  const field = (res, key) => JSON.parse(res.text).result.fields.find((x) => x.key === key)?.value;
  check(a1.status === 200 && b1.status === 200 && field(a1, 'grossMinor') === 141910 && field(b1, 'grossMinor') === 893550, `FIXTURE + FRONT DOOR: both businesses have a document 1 and they DIFFER (alpha ${field(a1, 'grossMinor')}, beta ${field(b1, 'grossMinor')}): nothing below can pass by ids being globally unique`);
  const pa = await get('/engine/records/party/1', tA), pb = await get('/engine/records/party/1', tB);
  check(JSON.parse(pa.text).result.title === 'ALPHA CUSTOMER' && JSON.parse(pb.text).result.title === 'BETA CUSTOMER', 'FRONT DOOR: the same reference (party 1) resolves to a different record in each business, each to its own');
  const ownVersion = (b) => eng.records.versionOf({ OFFICE_DB: f.objects['business-' + b].db }, { kind: 'document', id: 1 });
  const va = JSON.parse(a1.text).result.version, vb = JSON.parse(b1.text).result.version;
  check(va === await ownVersion('alpha-co') && vb === await ownVersion('beta-co') && va !== vb, `FRONT DOOR: a record's version is the one computed in its OWN business's database, and the two differ (alpha document 1 v${va}, beta document 1 v${vb}): metadata does not cross either`);
  const ra = await get('/engine/receivables?party=1', tA), rb = await get('/engine/receivables?party=1', tB);
  check(JSON.parse(ra.text).result.totalMinor === 121910 && JSON.parse(rb.text).result.totalMinor === 793550, 'FRONT DOOR: receivables for party 1 is each business\'s own total (121910 and 793550)');

  // the same PERSON in both businesses: the session's business decides, not the email
  const ba = await get('/engine/records/document/1', tBothA), bb = await get('/engine/records/document/1', tBothB);
  check(field(ba, 'grossMinor') === 141910 && field(bb, 'grossMinor') === 893550, 'FRONT DOOR: one person who is a member of BOTH businesses sees alpha with an alpha session and beta with a beta session: the session\'s business claim decides, not the email');
  const inj = await get('/engine/records/document/1', tBothA, { 'X-Business-Id': 'beta-co', 'X-Target-Business': 'beta-co', 'X-Admin-Key': 'fleet-admin' });
  check(inj.status === 200 && inj.text === ba.text && !B_ONLY.test(inj.text), 'FRONT DOOR: a member of both, holding an alpha session and sending X-Business-Id, X-Target-Business and the admin key naming beta, still gets ALPHA\'s record and nothing of beta\'s');

  // relationships: crawl every relation and collection reachable from a record; each hop must resolve inside the caller's own business
  const crawl = async (t, starts) => {
    const seen = new Map(), texts = [], queue = [...starts];
    while (queue.length && seen.size < 60) {
      const [kind, id] = queue.shift(), key = kind + '/' + id; if (seen.has(key)) continue;
      const r = await get(`/engine/records/${kind}/${id}`, t); texts.push(r.text); seen.set(key, r.status);
      if (r.status !== 200) continue;
      const res = JSON.parse(r.text).result;
      for (const rel of res.relations || []) queue.push([rel.ref.kind, rel.ref.id]);
      for (const d of (res.collections || {}).documents || []) if (Number.isInteger(d.id)) queue.push(['document', d.id]);
      for (const m of (res.collections || {}).payments || []) if (Number.isInteger(m.id)) queue.push(['movement', m.id]);
      for (const a of (res.collections || {}).allocations || []) { if (Number.isInteger(a.documentId)) queue.push(['document', a.documentId]); if (Number.isInteger(a.movementId)) queue.push(['movement', a.movementId]); }
    }
    return { seen, texts };
  };
  const ownRecords = (b) => new Set([['party', 'eng_party'], ['document', 'eng_document'], ['movement', 'eng_money_movement']].flatMap(([kind, table]) => f.raws[b].prepare(`SELECT id FROM ${table}`).all().map((r) => kind + '/' + r.id)));
  const startsFor = (b) => [...ownRecords(b)].filter((k) => k.startsWith('party/') || k.startsWith('movement/')).map((k) => k.split('/')).map(([kind, id]) => [kind, Number(id)]);
  const ca = await crawl(tA, startsFor('alpha-co')), cb = await crawl(tB, startsFor('beta-co'));
  const outside = (c, b) => [...c.seen.keys()].filter((k) => !ownRecords(b).has(k));
  check(ca.seen.size === ownRecords('alpha-co').size && [...ca.seen.values()].every((x) => x === 200) && outside(ca, 'alpha-co').length === 0 && !ca.texts.some((t) => B_ONLY.test(t)), `FRONT DOOR: crawling every relation and collection reachable from alpha's parties and payments reaches exactly alpha's own ${ca.seen.size} records, every hop resolves, and nothing of beta's appears [outside alpha: ${outside(ca, 'alpha-co').join(' ') || 'none'}; not 200: ${[...ca.seen].filter(([, v]) => v !== 200).map(([k, v]) => k + '=' + v).join(' ') || 'none'}]`);
  check(cb.seen.size === ownRecords('beta-co').size && [...cb.seen.values()].every((x) => x === 200) && outside(cb, 'beta-co').length === 0 && !cb.texts.some((t) => A_ONLY.test(t)), `FRONT DOOR: and the same for beta's own ${cb.seen.size} records, nothing of alpha's [outside beta: ${outside(cb, 'beta-co').join(' ') || 'none'}]`);
  check(!ca.seen.has('document/3') && !ca.seen.has('party/3') && !cb.seen.has('movement/3'), 'FRONT DOOR: no traversal ever reaches a record that exists only in the other business (alpha never reaches party 3 or document 3, beta never reaches payment 3)');

  // a reference that exists ONLY in the other business must be answered exactly like one that exists nowhere (status, body, headers)
  const missing = async (t, own, other, ids) => sameAnswer(await get(own, t), await get(other, t), ids);
  const foreignFromA = [['/engine/records/document/3', '/engine/records/document/99999', [3, 99999]], ['/engine/records/party/3', '/engine/records/party/99999', [3, 99999]], ['/engine/receivables?party=3', '/engine/receivables?party=99999', [3, 99999]], ['/engine/receivables?party=BETA%20THIRD', '/engine/receivables?party=NOBODY', []], ['/engine/receivables?party=BETA%20CUSTOMER', '/engine/receivables?party=NOBODY', []]];
  const fpB0 = fp('beta-co'), fpA0 = fp('alpha-co');
  let ok = true; for (const [x, y, ids] of foreignFromA) ok = ok && (await missing(tA, x, y, ids));
  check(ok, 'FRONT DOOR: alpha asking for beta-only records, a beta-only customer by id and by name, is answered EXACTLY like asking for a record that exists nowhere (same status, body and headers)');
  ok = true; for (const [x, y, ids] of [['/engine/records/movement/3', '/engine/records/movement/99999', [3, 99999]], ['/engine/receivables?party=ALPHA%20TWO', '/engine/receivables?party=NOBODY', []]]) ok = ok && (await missing(tB, x, y, ids));
  check(ok, 'FRONT DOOR: and beta asking for alpha-only records is answered exactly like a record that exists nowhere (the other direction)');
  const draftA = await get('/engine/records/draft/1', tA), nowhere = await get('/engine/records/draft/99999', tA);
  check(sameAnswer(draftA, nowhere, [1, 99999]), 'FRONT DOOR: a record kind that has no such id behaves the same for every kind (draft)');

  // operations: references to the other business's records are refused exactly as if they did not exist, and write nothing there
  const pay = (partyId, documentId) => ({ capability: 'payment.record', payload: { partyId, amountMinor: 1000, currency: 'ZAR', occurredOn: '2026-11-01', allocations: documentId === undefined ? [] : [{ documentId, amountMinor: 1000 }] }, transcript: 'x' });
  const fpBefore = fp('beta-co');
  const fa = await post('/engine/proposals', tA, pay(1, 3)), fn = await post('/engine/proposals', tA, pay(1, 99999));
  check(fa.status === 404 && sameAnswer(fa, fn, [3, 99999]), `FRONT DOOR: alpha proposing a payment against a beta-only document is refused exactly like against a document that exists nowhere (${fa.status}), differing only by the id the caller sent`);
  const fpa = await post('/engine/proposals', tA, pay(3)), fpn = await post('/engine/proposals', tA, pay(99999));
  check(fpa.status === 404 && sameAnswer(fpa, fpn, [3, 99999]), 'FRONT DOOR: alpha proposing a payment from a beta-only customer is refused exactly like from one that exists nowhere');
  const fpAfterAlphaProposals = fp('beta-co');   // taken BEFORE beta's own proposals below, which legitimately write to beta
  const fb = await post('/engine/proposals', tB, { capability: 'payment.correct', payload: { movementId: 3, reason: 'x', replacement: { partyId: 1, allocations: [] } }, transcript: 'x' }), fbn = await post('/engine/proposals', tB, { capability: 'payment.correct', payload: { movementId: 99999, reason: 'x', replacement: { partyId: 1, allocations: [] } }, transcript: 'x' });
  check(fb.status >= 400 && sameAnswer(fb, fbn, [3, 99999]), `FRONT DOOR: beta proposing to CORRECT an alpha-only payment is refused exactly like one that exists nowhere (${fb.status})`);
  check(fpAfterAlphaProposals === fpBefore && !f.raws['beta-co'].prepare('SELECT 1 FROM eng_money_movement WHERE amount_minor = 1000').get(), 'FRONT DOOR: none of alpha\'s refused proposals touched beta\'s database at all (every table identical, no payment of 1000 recorded)');

  // held actions: ids overlap, and an action that exists only in the other business cannot be confirmed
  const heldB = [await post('/engine/proposals', tB, pay(1, 1)), await post('/engine/proposals', tB, pay(1, 1)), await post('/engine/proposals', tB, pay(2, 2))];
  const heldA = [await post('/engine/proposals', tA, pay(1, 1)), await post('/engine/proposals', tA, pay(1, 1))];
  const ids = (xs) => xs.map((x) => JSON.parse(x.text).actionId).join(',');
  check(heldB.every((x) => x.status === 200) && heldA.every((x) => x.status === 200) && ids(heldB) === '1,2,3' && ids(heldA) === '1,2', `FIXTURE + FRONT DOOR: both businesses hold pending actions with OVERLAPPING ids (beta ${ids(heldB)}, alpha ${ids(heldA)}); action 3 exists only in beta [statuses ${[...heldB, ...heldA].map((x) => x.status).join(',')}; ${heldB.filter((x) => x.status !== 200).map((x) => x.text.slice(0, 90)).join(' | ')}]`);
  const fpB1 = fp('beta-co');
  const c3 = await post('/actions/3/confirm', tA, {}), c7 = await post('/actions/7/confirm', tA, {});
  const l3 = await post('/actions/3/confirm', tBothA, {}), l7 = await post('/actions/7/confirm', tBothA, {});
  check(l3.status === 403 && sameAnswer(l3, l7, [3, 7]) && fp('beta-co') === fpB1, `FRONT DOOR: for a LIMITED role (accountant) the refusal of a confirm is the same 403 for any id that is not theirs to confirm, so a beta-only action and a nonexistent one are indistinguishable (${l3.status} ${l3.text.slice(0, 50)})`);
  check(c3.status === 404 && sameAnswer(c3, c7, [3, 7]) && fp('beta-co') === fpB1, `FRONT DOOR: alpha confirming an action that exists only in beta is refused exactly like one that exists nowhere (${c3.status} ${c3.text.slice(0, 60)} | ${c7.status} ${c7.text.slice(0, 60)}), and beta's pending action is untouched`);
  const cOwn = await post('/actions/1/confirm', tA, {});
  check(cOwn.status === 200 && f.raws['alpha-co'].prepare('SELECT COUNT(*) AS n FROM eng_money_movement WHERE amount_minor = 1000').get().n === 1 && fp('beta-co') === fpB1 && f.raws['beta-co'].prepare("SELECT COUNT(*) AS n FROM pending_actions WHERE status = 'pending'").get().n === 3, 'FRONT DOOR: alpha confirming ITS OWN action 1 records the payment in alpha, and beta\'s database, including beta\'s own pending action 1, is untouched');

  // nothing of the other business ever reached the caller in any response, and no traffic from one changed the other
  const aTraffic = [a1, pa, ra, ba, inj, fa, fn, fpa, fpn, draftA, c3, c7, l3, l7, cOwn, ...ca.texts.map((t) => ({ text: t, headers: '' }))], bTraffic = [b1, pb, rb, bb, fb, fbn, ...cb.texts.map((t) => ({ text: t, headers: '' }))];
  check(!aTraffic.some((x) => B_ONLY.test(x.text + x.headers)) && !bTraffic.some((x) => A_ONLY.test(x.text + x.headers)), `FRONT DOOR: across ${aTraffic.length + bTraffic.length} responses (bodies and headers) nothing distinctive of one business appears in what the other was sent`);
  check(fp('alpha-co') !== fpA0 && fp('beta-co') !== fpB0, 'FRONT DOOR: (control) the fingerprints do change when a business legitimately changes, so the "untouched" checks above can fail');

  // =====================================================================================================================================================================================================================
  // OBJECT: one real object, no router in front, with engine data present so a failure would be visible
  // =====================================================================================================================================================================================================================
  const asObj = (t, claim, extra = {}) => ({ headers: { cookie: 'office_session=' + t, 'X-Business-Id': claim, ...extra } });
  const noSess = await direct('alpha-co', '/engine/records/document/1', { headers: { 'X-Business-Id': 'alpha-co' } });
  check(noSess.status === 401 && !A_ONLY.test(noSess.text), `OBJECT: alpha's object with no session answers ${noSess.status} and returns no data`);
  const wrongBiz = await direct('alpha-co', '/engine/records/document/1', asObj(await f.token('owner@beta.example', 'beta-co'), 'alpha-co'));
  check(sameAnswer(wrongBiz, noSess), 'OBJECT: a beta session sent to alpha\'s object is refused exactly like no session');
  const both = await direct('alpha-co', '/engine/records/document/1', asObj(tBothB, 'alpha-co'));
  check(sameAnswer(both, noSess) && !A_ONLY.test(both.text), 'OBJECT: a person who IS an active member of alpha, but whose session says beta, is refused by alpha\'s object: membership alone is not enough, the session\'s business must match (this is the check the membership table would otherwise mask)');
  const lie = await direct('alpha-co', '/engine/records/document/1', asObj(tBothB, 'beta-co'));
  check(lie.status === 403 && JSON.parse(lie.text).error === 'this object belongs to another business' && !A_ONLY.test(lie.text), 'OBJECT: a request that CLAIMS beta (with a beta session of a person who is also alpha\'s member) is refused 403 by alpha\'s object, which belongs to alpha: a request cannot change which business an object serves');
  const claimOnly = await direct('alpha-co', '/engine/receivables?party=1', asObj(tA, 'beta-co'));
  check(claimOnly.status === 403 && !A_ONLY.test(claimOnly.text), 'OBJECT: a valid alpha session with a claim for beta is refused 403 on the engine routes too');
  const nonMember = await direct('alpha-co', '/engine/records/document/1', asObj(await f.token('owner@beta.example', 'alpha-co'), 'alpha-co'));
  check(nonMember.status === 403 && !A_ONLY.test(nonMember.text), `OBJECT: a session that names alpha but belongs to someone who is not a member of alpha is refused (${nonMember.status}): the third line, membership`);
  const own = await direct('alpha-co', '/engine/records/document/1', asObj(tA, 'alpha-co'));
  check(own.status === 200 && field(own, 'grossMinor') === 141910, 'OBJECT: (control) alpha\'s own member, own session and own claim is served: the refusals above are not simply a broken object');

  // =====================================================================================================================================================================================================================
  // MISROUTE: the router is made wrong ON PURPOSE (alpha's requests are delivered to beta's object)
  // =====================================================================================================================================================================================================================
  f.setMisroute((name) => (name === 'business-alpha-co' ? 'business-beta-co' : name));
  const fpBm = fp('beta-co');
  const m1 = await get('/engine/records/document/1', tBothA), m2 = await get('/engine/records/document/1', tA), m3 = await post('/engine/proposals', tBothA, pay(1, 1)), m4 = await post('/actions/1/confirm', tBothA, {});
  check([m1, m2, m3, m4].every((x) => x.status === 403 && JSON.parse(x.text).error === 'this object belongs to another business'), `MISROUTE: when the router delivers alpha's request to BETA's object, beta's object refuses it 403, for reads, proposals and confirms, even for a person who is an active member of both (${[m1, m2, m3, m4].map((x) => x.status).join(',')})`);
  check(![m1, m2, m3, m4].some((x) => A_ONLY.test(x.text) || B_ONLY.test(x.text)) && fp('beta-co') === fpBm, 'MISROUTE: and no data of either business is in those responses, and beta\'s database is identical afterwards');
  f.setMisroute(null);
  const back = await get('/engine/records/document/1', tA);
  check(back.status === 200 && field(back, 'grossMinor') === 141910, 'MISROUTE: (control) with the router correct again, alpha is served normally');

  // OBSERVATION, recorded and NOT blessed as a security contract: an object that has never been named binds to the first business that names it
  await f.wake('gamma-co');
  await f.objects['business-gamma-co'].db.prepare("INSERT INTO memberships (google_email, role, status) VALUES ('owner@gamma.example', 'accountant', 'active')").run();
  f.setMisroute((name) => (name === 'business-alpha-co' ? 'business-gamma-co' : name));
  const g1 = await get('/engine/records/document/1', tA);
  f.setMisroute(null);
  const boundTo = f.raws['gamma-co'].prepare("SELECT value FROM object_meta WHERE key = 'business_id'").get()?.value ?? null;
  const g2 = await get('/engine/records/document/1', await f.token('owner@gamma.example', 'gamma-co'));
  check(!A_ONLY.test(g1.text) && !B_ONLY.test(g1.text) && !A_ONLY.test(g2.text) && !B_ONLY.test(g2.text), `OBSERVATION (a recorded behaviour, NOT a security contract; reported for a decision): gamma's object had never been named; alpha's request, misrouted to it, got ${g1.status}, and it then bound itself to "${boundTo}"; gamma's own owner then got ${g2.status}. No business data was exposed either way (the object has none), but an unused object accepts whichever business names it first`);
});

if (require.main === module) kit.standalone(module.exports);
