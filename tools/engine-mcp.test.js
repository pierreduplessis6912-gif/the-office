// THE OUTSIDE-ASSISTANT (MCP) DOOR FOR AN ENGINE BUSINESS (branch engine-phase1; docs/decisions/engine-mcp.md). TESTS FIRST. Expected state when first committed: RED.
// Until now an engine business offered NO tool over MCP (engine-boundary.test.js still holds: a business with no capability available offers none). This suite pins the engine's own tools: they are the SAME door a member uses, not a copy:
// reads go through invokeRead and proposals through proposeCapabilityAs, with the key's member (so the engine's own permission, availability and validation rules answer), and an outside assistant can PROPOSE (a write key only) but can never
// APPROVE: there is no approve tool, and a person approves in The Office as ever. Three generic tools carry every capability so nothing is re-implemented: list_capabilities (what this member may do here, with the shape of each request),
// read (a read capability) and propose (a write capability, held for a person). Evidence: TEST on the route harness with MCP keys (NOT staging, NOT production).
const kit = require('./engine-kit.js');
const crypto = require('crypto');

module.exports = kit.guard('engine mcp', async ({ check }) => {
  const sha = (x) => crypto.createHash('sha256').update(x).digest('hex');
  const keyOf = (name) => { const secret = crypto.createHash('sha256').update('secret:' + name).digest('base64url'); const id = sha('id:' + name).slice(0, 16); return { id, secret, key: `omk.acme-co.${id}.${secret}`, hash: sha(secret) }; };
  const KEYS = { accountantR: ['accountant@example.com', 'mcp:read'], accountantW: ['accountant@example.com', 'mcp:write'], ownerW: ['owner@example.com', 'mcp:write'], installerW: ['installer@example.com', 'mcp:write'], salesW: ['sales@example.com', 'mcp:write'] };
  const K = Object.fromEntries(Object.keys(KEYS).map((n) => [n, keyOf(n)]));
  const DDL = "CREATE TABLE IF NOT EXISTS mcp_keys (id TEXT PRIMARY KEY, label TEXT NOT NULL, email TEXT NOT NULL, hash TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), created_by TEXT NOT NULL, last_used_at TEXT, revoked_at TEXT, uses INTEGER NOT NULL DEFAULT 0, scope TEXT)";
  const seed = (db) => { db.exec(DDL); for (const [n, [email, scope]] of Object.entries(KEYS)) db.prepare('INSERT INTO mcp_keys (id, label, email, hash, created_by, scope) VALUES (?, ?, ?, ?, ?, ?)').run(K[n].id, n, email, K[n].hash, 'owner@example.com', scope); };
  const ENV = { BUSINESS_ID: 'acme-co', BUSINESS_MODE: 'object', SESSION_SECRET: 'engine-mcp-secret', ENGINE_REHEARSAL: '1' };
  const PROVISION = { admin: true, method: 'POST', path: '/admin/engine/provision-sample', body: { confirm: 'acme-co' } };
  const rpc = (method, params, id = 1) => ({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
  const mcp = (who, body, before = []) => kit.route({ method: 'POST', path: '/mcp', noSession: true, headers: { Authorization: 'Bearer ' + K[who].key }, env: ENV, seed, before: [PROVISION, ...before], body });
  const tools = async (who, before) => { const m = await mcp(who, rpc('tools/list'), before); return (((m.result.body || {}).result || {}).tools || []); };
  const names = (list) => list.map((t) => t.name).sort();
  const callTool = async (who, name, args, before) => { const m = await mcp(who, rpc('tools/call', { name, arguments: args }), before); const b = m.result.body || {}; if (b.error) return { rpcError: b.error, writes: m.writes }; const text = (((b.result || {}).content || [])[0] || {}).text; let data = null; try { data = JSON.parse(text); } catch { /* an error message is plain text */ } return { isError: (b.result || {}).isError === true, text, data, writes: m.writes }; };
  const added = (res, t) => ((res.writes && res.writes[t] && res.writes[t].added) || []).length;
  const written = (res) => Object.keys(res.writes || {}).filter((t) => added(res, t) > 0).sort();
  const BOOKKEEPING = ['mcp_keys', 'mcp_calls'];
  const factTables = ['eng_party', 'eng_party_role', 'eng_document', 'eng_document_line', 'eng_money_movement', 'eng_allocation', 'eng_event', 'eng_reversal'];
  const route = (role, method, path, body, before = []) => kit.route({ env: { BUSINESS_ID: 'acme-co', ENGINE_REHEARSAL: '1' }, seed, before: [PROVISION, ...before], method, path, role, body });

  // ---- what is offered -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  let t = await tools('accountantR');
  check(JSON.stringify(names(t)) === JSON.stringify(['list_capabilities', 'read']), `a read-only key for an accountant is offered exactly list_capabilities and read (${names(t).join(', ')}) and no legacy tool`);
  check(t.every((x) => x.annotations && x.annotations.readOnlyHint === true && x.annotations.destructiveHint === false), 'both are marked read-only');
  t = await tools('accountantW');
  check(JSON.stringify(names(t)) === JSON.stringify(['list_capabilities', 'propose', 'read']), 'a write key adds propose (the only write tool)');
  const prop = t.find((x) => x.name === 'propose');
  check(prop && prop.annotations.readOnlyHint === false && prop.annotations.destructiveHint === false && /never approve|cannot approve|a person approves/i.test(prop.description), 'propose is marked as a write that is not destructive, and says an assistant can never approve: a person does');
  const instCaps = JSON.parse((await callTool('installerW', 'list_capabilities', {})).text).capabilities.map((x) => x.id).sort();
  check(names(await tools('installerW')).join() === 'list_capabilities,propose,read' && instCaps.includes('purchase_orders.find') && instCaps.includes('goods.receive') && !instCaps.some((i) => ['payment.record', 'party.create', 'expense.record', 'vat.summary', 'receivables.query'].includes(i)), 'an installer (field staff) is offered the tools but sees ONLY the purchasing capabilities their role allows (read orders, propose a receipt): none of the money ones');
  const noCaps = await kit.route({ method: 'POST', path: '/mcp', noSession: true, headers: { Authorization: 'Bearer ' + K.accountantW.key }, env: ENV, seed: (db) => { seed(db); db.prepare("INSERT INTO eng_config (key, value_json) VALUES ('mode', '\"engine\"')").run(); }, body: rpc('tools/list') });
  check((((noCaps.result.body || {}).result || {}).tools || []).length === 0, 'an engine business with no capability available offers nothing (as before)');
  for (const legacy of ['get_customer_receivables', 'tell_the_office', 'schedule_job', 'confirm_pending_action', 'reject_pending_action']) { const c = await callTool('accountantW', legacy, {}); check(c.rpcError && c.rpcError.code === -32602, `${legacy} is still an unknown tool in an engine business: there is no way to approve over MCP`); }

  // ---- list_capabilities: what THIS member may do here -------------------------------------------------------------------------------------------------------------------------------------------------------------------
  let c = await callTool('accountantW', 'list_capabilities', {});
  const caps = (c.data && c.data.capabilities) || [];
  const idsOf = (list, kind) => list.filter((x) => !kind || x.kind === kind).map((x) => x.id).sort();
  check(c.isError === false && caps.every((x) => x.id && ['read', 'write'].includes(x.kind) && x.label && typeof x.hint === 'string' && x.hint.length > 10), 'each capability has an id, a kind (read or write), a label and a hint about the shape of the request');
  check(['receivables.query', 'parties.find', 'quotations.find', 'expenses.find', 'vat.summary', 'credits.find'].every((i) => idsOf(caps, 'read').includes(i)) && ['payment.record', 'party.create', 'quotation.create', 'credit_note.issue', 'expense.record', 'debit_note.issue'].every((i) => idsOf(caps, 'write').includes(i)), 'an accountant sees the reads and writes they may use (receivables, parties, quotations, expenses, VAT, credits; payments, parties, quotes, credit and debit notes, expenses)');
  check(!idsOf(caps).includes('tax_lock.set') && !idsOf(caps).includes('business.profile.set') && !idsOf(caps).includes('business.get'), 'but not the owner-only business settings or the tax lock');
  c = await callTool('ownerW', 'list_capabilities', {}); check(idsOf((c.data || {}).capabilities || []).includes('tax_lock.set') && idsOf(c.data.capabilities).includes('business.get'), 'the owner does see them');
  c = await callTool('salesW', 'list_capabilities', {}); const sc = idsOf((c.data || {}).capabilities || []);
  check(sc.includes('quotations.find') && sc.includes('quotation.create') && !sc.includes('payment.record') && !sc.includes('expense.record') && !sc.includes('vat.summary'), 'a salesperson sees only the quote capabilities, never the money ones');
  const partialSeed = await kit.route({ method: 'POST', path: '/mcp', noSession: true, headers: { Authorization: 'Bearer ' + K.accountantW.key }, env: ENV, seed: (db) => { seed(db); db.prepare("INSERT INTO eng_config (key, value_json) VALUES ('mode', '\"engine\"')").run(); db.prepare("INSERT INTO eng_config (key, value_json) VALUES ('available', ?)").run(JSON.stringify(['parties.find', 'party.create'])); }, body: rpc('tools/call', { name: 'list_capabilities', arguments: {} }) });
  const pcaps = JSON.parse((((partialSeed.result.body || {}).result || {}).content || [{ text: '{}' }])[0].text).capabilities || [];
  check(JSON.stringify(idsOf(pcaps)) === JSON.stringify(['parties.find', 'party.create']), 'a business that has switched on only two capabilities lists only those two');
  check(written(await callTool('accountantW', 'list_capabilities', {})).every((x) => BOOKKEEPING.includes(x)), 'listing writes nothing but the key\'s use counter and the call record');

  // ---- read: the same answers a member gets ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  c = await callTool('accountantR', 'read', { capability: 'receivables.query', params: { partyName: 'Mokoena' } });
  const viaRoute = await route('accountant', 'GET', '/engine/receivables?party=Mokoena');
  check(c.isError === false && c.data && c.data.result && c.data.result.totalMinor === 85000 && c.data.result.totalMinor === viaRoute.result.body.result.totalMinor, 'a receivables question over MCP returns exactly the figure the app gets (R850.00)');
  c = await callTool('accountantR', 'read', { capability: 'parties.find', params: { name: 'Patel' } });
  check(c.isError === false && ((c.data.result || {}).parties || []).length === 1 && c.data.result.parties[0].name === 'Patel Builders', 'finding a party works');
  c = await callTool('accountantR', 'read', { capability: 'vat.summary', params: { from: '2026-10-01', to: '2026-10-31' } });
  const viaVat = await route('accountant', 'GET', '/engine/vat?from=2026-10-01&to=2026-10-31');
  check(c.isError === false && c.data.result.field1Minor === viaVat.result.body.result.field1Minor && c.data.result.field4Minor === viaVat.result.body.result.field4Minor, 'the VAT summary is the same figures the app gets');
  c = await callTool('accountantR', 'read', { capability: 'records.get', params: { kind: 'party', id: 1 } });
  check(c.isError === false && c.data.result && c.data.result.title === 'Mokoena', 'a record opens, explained as in the app');
  c = await callTool('accountantR', 'read', { capability: 'receivables.query', params: { partyName: 'Mokoena' } });
  check(written(c).every((x) => BOOKKEEPING.includes(x)), 'a read writes nothing but the key\'s use counter and the call record');
  for (const [args, why] of [[{ capability: 'nope.nothing', params: {} }, 'a capability that does not exist'], [{ capability: 'payment.record', params: {} }, 'a WRITE capability passed to read'], [{ capability: 'tax_lock.set', params: {} }, 'a capability this member may not use'], [{ capability: 'vat.summary', params: { from: 'soon', to: 'later' } }, 'invalid parameters'], [{ capability: 'parties.find', params: 'Patel' }, 'parameters that are not an object'], [{ capability: 'parties.find', params: {}, extra: 1 }, 'an argument the tool does not have'], [{ params: {} }, 'no capability named'], [{ capability: 5 }, 'a capability that is not text'], [{ capability: 'parties.find', params: { name: 'x'.repeat(30000) } }, 'an enormous parameter']]) {
    c = await callTool('accountantR', 'read', args);
    check(((c.isError === true) || (c.rpcError && c.rpcError.code === -32602)) && written(c).every((x) => BOOKKEEPING.includes(x)), `${why} is refused with a reason and nothing is written`);
  }
  c = await callTool('accountantR', 'read', { capability: 'payment.record', params: {} });
  check(c.isError === true && /not a read capability/.test(c.text || ''), 'a WRITE capability passed to read is refused with that reason (the engine door is never reached)');
  c = await callTool('accountantW', 'propose', { capability: 'parties.find', payload: {} });
  check(c.isError === true && /not a write capability/.test(c.text || ''), 'and a READ capability passed to propose is refused with that reason');
  c = await callTool('accountantR', 'read', { capability: 'parties.find', params: { name: 'x'.repeat(30000) } });
  check(c.isError === true && /too large/.test(c.text || ''), 'an enormous parameter is refused as too large');
  c = await callTool('installerW', 'read', { capability: 'parties.find', params: {} }); check(c.isError === true && /not a read capability/.test(c.text || ''), 'an installer calling read for a capability their role does not allow is refused (parties are not theirs to read)');
  const withoutExpenses = await kit.route({ method: 'POST', path: '/mcp', noSession: true, headers: { Authorization: 'Bearer ' + K.accountantR.key }, env: ENV, seed: (db) => { seed(db); db.prepare("INSERT INTO eng_config (key, value_json) VALUES ('mode', '\"engine\"')").run(); db.prepare("INSERT INTO eng_config (key, value_json) VALUES ('available', ?)").run(JSON.stringify(['parties.find'])); }, body: rpc('tools/call', { name: 'read', arguments: { capability: 'expenses.find', params: {} } }) });
  check((((withoutExpenses.result.body || {}).result || {}).isError) === true, 'a read capability the business has not switched on is refused as unavailable');

  // ---- propose: held for a person, never approved ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const newParty = { kind: 'organisation', name: 'Dlamini Timber', roles: ['supplier'] };
  c = await callTool('accountantW', 'propose', { capability: 'party.create', payload: newParty, note: 'The assistant read an email: Dlamini Timber is a new supplier' });
  check(c.isError === false && c.data && c.data.status === 'held' && Number.isInteger(c.data.actionId) && /person/i.test(c.data.message || '') , 'proposing a party is HELD for a person (with the action number), and the answer says a person must approve it');
  check(written(c).filter((x) => !BOOKKEEPING.includes(x)).sort().join() === ['captures', 'eng_interpretation', 'pending_actions'].sort().join() && factTables.every((x) => added(c, x) === 0), 'it writes only what was said, the interpretation and the held action: no party exists yet');
  const cap = ((c.writes.captures || {}).added || [])[0] || {}, interp = ((c.writes.eng_interpretation || {}).added || [])[0] || {};
  check(cap.source === 'mcp' && /Dlamini Timber is a new supplier/.test(cap.raw_text || '') && interp.interpreter === 'model' && interp.capability === 'party.create', 'the trail says it came over MCP, keeps the assistant\'s own words, and that an outside model interpreted it');
  const flow = await kit.route({ env: { BUSINESS_ID: 'acme-co', ENGINE_REHEARSAL: '1' }, seed, before: [PROVISION, { method: 'POST', path: '/mcp', noSession: true, headers: { Authorization: 'Bearer ' + K.accountantW.key }, body: rpc('tools/call', { name: 'propose', arguments: { capability: 'party.create', payload: newParty } }) }], method: 'GET', path: '/actions/pending', role: 'accountant' });
  const pend = (flow.result.body.pending || []);
  check(pend.length === 1 && pend[0].type === 'engine.party.create' && JSON.parse(pend[0].payload).name === 'Dlamini Timber', 'the member sees it waiting in The Office, exactly as proposed');
  const approved = await kit.route({ env: { BUSINESS_ID: 'acme-co', ENGINE_REHEARSAL: '1' }, seed, before: [PROVISION, { method: 'POST', path: '/mcp', noSession: true, headers: { Authorization: 'Bearer ' + K.accountantW.key }, body: rpc('tools/call', { name: 'propose', arguments: { capability: 'party.create', payload: newParty } }) }], method: 'POST', path: '/actions/1/confirm', role: 'accountant', body: {} });
  check(approved.result.status === 200 && added(approved, 'eng_party') === 1, 'and a person approving it in The Office creates the party: the only way a write happens');
  // every contract, not just parties
  c = await callTool('accountantW', 'propose', { capability: 'expense.record', payload: { supplierId: 1, incurredOn: '2026-10-10', method: 'eft', category: 'materials', currency: 'ZAR', amountsIncludeTax: true, lines: [{ description: 'Plywood', amountMinor: 23000, taxBp: 1500 }], amountPaidMinor: 23000, taxInvoiceHeld: true } });
  check(c.isError === true && /supplier/i.test(c.text), 'an expense for a party that is not a supplier is refused with the engine\'s own reason (Mokoena is a customer), nothing held');
  c = await callTool('accountantW', 'propose', { capability: 'payment.record', payload: { partyId: 1, amountMinor: 50000, currency: 'ZAR', occurredOn: '2026-11-07', allocate: 'oldest_first' } });
  check(c.isError === false && c.data.status === 'held', 'a payment is proposed and held through the same door (the first slice\'s own capability)');
  c = await callTool('ownerW', 'propose', { capability: 'tax_lock.set', payload: { lockDate: '2026-10-31' } });
  check(c.isError === false && c.data.status === 'held', 'the owner may propose the tax lock (and a person still approves it)');
  c = await callTool('accountantW', 'propose', { capability: 'tax_lock.set', payload: { lockDate: '2026-10-31' } });
  check(c.isError === true && /permission/i.test(c.text) && factTables.every((x) => added(c, x) === 0), 'an accountant proposing the tax lock is refused for lack of permission, exactly as in the app');
  const viaApp = await route('accountant', 'POST', '/engine/proposals', { capability: 'party.create', payload: { ...newParty, name: '' }, transcript: 'x' });
  c = await callTool('accountantW', 'propose', { capability: 'party.create', payload: { ...newParty, name: '' } });
  check(c.isError === true && c.text.includes(viaApp.result.body.message.replace(/ Nothing was done\.$/, '')), 'an invalid proposal gets the SAME reason over MCP as in the app');
  for (const [args, why] of [[{ capability: 'nope.nothing', payload: {} }, 'a capability that does not exist'], [{ capability: 'parties.find', payload: {} }, 'a READ capability passed to propose'], [{ capability: 'party.create', payload: 'x' }, 'a payload that is not an object'], [{ capability: 'party.create' }, 'no payload'], [{ capability: 'party.create', payload: newParty, extra: 1 }, 'an argument the tool does not have'], [{ capability: 'party.create', payload: newParty, note: 5 }, 'a note that is not text'], [{ capability: 'party.create', payload: { ...newParty, name: 'x'.repeat(30000) } }, 'an enormous payload'], [{ capability: 'party.create', payload: newParty, note: 'n'.repeat(2000) }, 'a note over 1000 characters']]) {
    c = await callTool('accountantW', 'propose', args);
    check(((c.isError === true) || (c.rpcError && c.rpcError.code === -32602)) && factTables.every((x) => added(c, x) === 0) && !written(c).includes('pending_actions'), `${why} is refused with a reason and nothing is held`);
  }
  c = await callTool('accountantR', 'propose', { capability: 'party.create', payload: newParty }); check(c.isError === true && /restricted/i.test(c.text || '') && !written(c).includes('pending_actions') && factTables.every((x) => added(c, x) === 0), 'a read-only key calling propose is denied (a read key never runs a creating tool) and nothing is held');
  check(!names(await tools('accountantR')).includes('propose'), 'and propose is not even listed for it');
  c = await callTool('salesW', 'propose', { capability: 'expense.record', payload: {} }); check((c.isError === true || (c.rpcError && c.rpcError.code === -32602)) && !written(c).includes('pending_actions'), 'a salesperson proposing an expense is refused (not permitted), nothing held');
  const noExp = await kit.route({ method: 'POST', path: '/mcp', noSession: true, headers: { Authorization: 'Bearer ' + K.accountantW.key }, env: ENV, seed: (db) => { seed(db); db.prepare("INSERT INTO eng_config (key, value_json) VALUES ('mode', '\"engine\"')").run(); db.prepare("INSERT INTO eng_config (key, value_json) VALUES ('available', ?)").run(JSON.stringify(['party.create'])); }, body: rpc('tools/call', { name: 'propose', arguments: { capability: 'expense.record', payload: {} } }) });
  check((((noExp.result.body || {}).result || {}).isError) === true && !written(noExp).includes('pending_actions'), 'a write capability the business has not switched on is refused as unavailable (and only an observation is kept, as for any client)');

  // ---- the key itself ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const bad = await kit.route({ method: 'POST', path: '/mcp', noSession: true, headers: { Authorization: 'Bearer omk.acme-co.0000000000000000.nope' }, env: ENV, seed, before: [PROVISION], body: rpc('tools/list') });
  check(bad.result.status === 401, 'a key that does not verify is refused (401) before anything else');
  check(written(await mcp('accountantR', rpc('ping'))).every((x) => BOOKKEEPING.includes(x)), 'and a valid call writes only bookkeeping');
});

if (require.main === module) kit.standalone(module.exports);
