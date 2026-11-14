// VOICE CAPTURE INTO AN ENGINE BUSINESS: POST /engine/capture/audio (docs/decisions/engine-capture.md, approved by Pierre 2026-11-14). TESTS FIRST; expected state when first committed: RED.
// Run in CI with a SCRIPTED transcriber and a SCRIPTED model (the route harness's stand-in for env.AI): no real model or speech service is called. What it pins:
//   RECEPTACLE FIRST  the file is stored and a capture row points at it BEFORE anything is understood; a failed transcription or an unreachable model still leaves the file and its row.
//   ONE DOOR          the transcript goes through the SAME interpreter as typed text (/engine/interpret): a read is answered, a write is HELD, nothing is approved, nothing is recorded as money.
//   PROVENANCE        the capture row carries the transcript, the file's key and source 'voice', and the interpretation names THAT row (no second capture row per note).
//   SAFE              idempotent on retry, bad files refused before anything is stored, a legacy business and a signed-out caller are refused.
const kit = require('./engine-kit.js');

module.exports = kit.guard('engine capture voice', async ({ check }) => {
  const ENV_A = { BUSINESS_ID: 'eng-a', ENGINE_REHEARSAL: '1' };
  const SEED = { admin: true, method: 'POST', path: '/admin/engine/provision-sample', body: { confirm: 'eng-a' } };
  const call = (capability, args) => JSON.stringify(capability === null ? { capability: null } : { capability, arguments: args });
  // The scripted speech model: it "hears" whatever the audio's text says (the harness's File body is the bytes of the text we give it).
  const heard = (re, text) => ({ match: re, raw: true, reply: { text } });
  const SPEECH = [
    { match: /whisper/, raw: true, reply: (input) => ({ text: Buffer.from(input.audio).toString('utf8') }) },
  ];
  const MODEL = [
    { match: /What does Mokoena owe me\?/, reply: call('receivables.query', { customer: 'Mokoena' }) },
    { match: /Record R500 from Mokoena\./, reply: call('payment.record', { customer: 'Mokoena', amountCents: 50000 }) },
    { match: /Book Sepo for Thursday/, reply: call(null) },
  ];
  const AI = [...SPEECH, ...MODEL];
  const note = (text, extra = {}) => ({ audio: { name: 'note.m4a', type: 'audio/m4a', text }, ...extra });
  const send = (form, opts = {}) => kit.route({ env: ENV_A, ai: opts.ai || AI, ...(opts.seed ? { seed: opts.seed } : {}), before: [SEED, ...(opts.before || [])], method: 'POST', path: '/engine/capture/audio', form, role: opts.role || 'accountant', ...(opts.noSession ? { noSession: true } : {}) });
  const status = (r) => r.result && r.result.status, body = (r) => (r.result && r.result.body) || {};
  const added = (r, t) => ((r.writes && r.writes[t] && r.writes[t].added) || []);
  const tables = (r) => Object.keys(r.writes || {}).filter((t) => added(r, t).length > 0).sort();
  const puts = (r) => (r.effects || []).filter((e) => e.r2 === 'put');
  const nothing = (r) => tables(r).length === 0 && puts(r).length === 0;

  // ---- a spoken question is answered, and the file and its row exist -----------------------------------------------------------------------------------------------------------------------------
  let r = await send(note('What does Mokoena owe me?'));
  check(status(r) === 200 && body(r).status === 'ok' && body(r).transcript === 'What does Mokoena owe me?', `a spoken question is answered through the interpreter and the transcript is shown back (got ${status(r)} ${JSON.stringify(body(r)).slice(0, 160)})`);
  const caps = added(r, 'captures');
  check(caps.length === 1 && caps[0].source === 'voice' && caps[0].raw_text === 'What does Mokoena owe me?' && /^engine-captures\/voice\//.test(String(caps[0].r2_key)), `exactly ONE capture row: source voice, the transcript, the file's key (got ${JSON.stringify(caps.map((c) => [c.source, c.raw_text, c.r2_key]))})`);
  check(puts(r).length === 1 && puts(r)[0].key === caps[0].r2_key, 'the file was stored once, under the key the capture row names');
  check(body(r).captureId === caps[0].id, 'the answer names the capture row');
  check(tables(r).every((t) => ['captures'].includes(t)), `a read writes only the capture (got ${tables(r).join(', ')})`);

  // ---- a spoken write is HELD, linked to the voice capture, never approved ----------------------------------------------------------------------------------------------------------------------
  r = await send(note('Record R500 from Mokoena.'));
  check(status(r) === 200 && body(r).status === 'held' && typeof body(r).actionId === 'number', `a spoken payment is HELD for approval (got ${status(r)} ${JSON.stringify(body(r)).slice(0, 160)})`);
  const interp = added(r, 'eng_interpretation')[0] || {}, cap2 = added(r, 'captures');
  check(cap2.length === 1 && interp.capture_id === cap2[0].id && interp.interpreter === 'model', 'the interpretation names the ONE voice capture row (no second row for the same note)');
  check(added(r, 'eng_event').length === 0 && added(r, 'eng_movement').length === 0 && added(r, 'eng_allocation').length === 0, 'nothing is recorded as money: only a person approving can do that');

  // ---- not understood: honest, the file and row still kept --------------------------------------------------------------------------------------------------------------------------------------
  r = await send(note('Book Sepo for Thursday'));
  check(status(r) === 422 && body(r).error === 'not_understood' && added(r, 'captures').length === 1 && puts(r).length === 1 && added(r, 'eng_observation').length === 1, 'an unsupported sentence is answered honestly and the file, its capture and an observation are kept');

  // ---- receptacle first: nothing heard, or no model, still keeps the file ---------------------------------------------------------------------------------------------------------------------------
  r = await send(note('x'), { ai: [{ match: /whisper/, raw: true, reply: { text: '' } }, ...MODEL] });
  check(status(r) === 200 && body(r).status === 'captured' && body(r).transcript === null && /could not be heard|could not hear|not heard/i.test(String(body(r).message)), `a note that could not be heard is kept and said so, nothing is done (got ${status(r)} ${JSON.stringify(body(r)).slice(0, 160)})`);
  check(added(r, 'captures').length === 1 && puts(r).length === 1 && added(r, 'captures')[0].source === 'voice' && added(r, 'captures')[0].r2_key === puts(r)[0].key && tables(r).join() === 'captures', 'the file and its capture row exist, and nothing else was written');
  r = await send(note('x'), { ai: [{ match: /whisper/, raw: true, reply: () => { throw new Error('speech service down'); } }, ...MODEL] });
  check(status(r) === 200 && body(r).status === 'captured' && added(r, 'captures').length === 1 && puts(r).length === 1, 'a speech service that is down also leaves the file and its row (the legacy bug: a stored file with no row)');
  r = await send(note('What does Mokoena owe me?'), { ai: [...SPEECH, { match: /./, reply: () => { throw new Error('model down'); } }] });
  check(status(r) === 503 && body(r).error === 'model_unavailable' && body(r).transcript === 'What does Mokoena owe me?' && added(r, 'captures').length === 1 && puts(r).length === 1, 'a model that cannot be reached: 503, but the file, the transcript and the capture row are kept so it can be retried');

  // ---- idempotent on retry ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const key = 'retry-1';
  const first = await send(note('Record R500 from Mokoena.', { idempotency_key: key }));
  const second = await send(note('Record R500 from Mokoena.', { idempotency_key: key }), { before: [{ method: 'POST', path: '/engine/capture/audio', form: note('Record R500 from Mokoena.', { idempotency_key: key }), role: 'accountant' }] });
  check(status(second) === status(first) && JSON.stringify(body(second)) === JSON.stringify(body(first)) && tables(second).length === 0 && puts(second).length === 1, 'the same upload sent twice (a dropped network) gives the same answer, writes no row the second time, and the file was stored once in all (the effects include the first send)');

  // a failure that may pass (model down) is not replayed forever: the same key tried again, with the model back, gets the real answer
  let modelCalls = 0;
  const flaky = [...SPEECH, { match: /What does Mokoena owe me\?/, reply: () => { if (modelCalls++ === 0) throw new Error('model down'); return call('receivables.query', { customer: 'Mokoena' }); } }];
  const formDown = note('What does Mokoena owe me?', { idempotency_key: 'down-1' });
  const retry = await send(formDown, { ai: flaky, before: [{ method: 'POST', path: '/engine/capture/audio', form: note('What does Mokoena owe me?', { idempotency_key: 'down-1' }), role: 'accountant' }] });
  check(status(retry) === 200 && body(retry).status === 'ok', `the first try fails (model down, 503); the same key tried again is run for real, not frozen as a replay of the failure (got ${status(retry)} ${JSON.stringify(body(retry)).slice(0, 120)})`);

  // ---- bad uploads are refused before anything is stored ------------------------------------------------------------------------------------------------------------------------------------------------
  r = await send({});
  check([400, 422].includes(status(r)) && nothing(r), `no file: refused, nothing stored (got ${status(r)})`);
  r = await send({ audio: { name: 'a.m4a', type: 'audio/m4a', text: '' } });
  check([400, 422].includes(status(r)) && nothing(r), `an empty file: refused, nothing stored (got ${status(r)})`);
  r = await send({ audio: { name: 'a.exe', type: 'application/x-msdownload', text: 'MZ' } });
  check([415, 422].includes(status(r)) && nothing(r), `a file that is not audio: refused, nothing stored (got ${status(r)})`);
  r = await send({ audio: { name: 'big.m4a', type: 'audio/m4a', base64: Buffer.alloc(11 * 1024 * 1024, 1).toString('base64') } });
  check(status(r) === 413 && nothing(r), `a file over 10 MB: refused 413, nothing stored (got ${status(r)})`);
  check(status(await kit.route({ env: ENV_A, ai: AI, before: [SEED], method: 'POST', path: '/engine/capture/audio', form: { audio: { name: 'n.m4a', type: 'audio/m4a', text: 'hello' } }, role: 'accountant' })) !== 500, 'a valid upload never fails with a server error');

  // ---- who may ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  r = await send(note('What does Mokoena owe me?'), { noSession: true });
  check(status(r) === 401 && nothing(r), `signed out: refused 401, nothing stored (got ${status(r)})`);
  r = await kit.route({ method: 'POST', path: '/engine/capture/audio', form: note('What does Mokoena owe me?'), role: 'owner', ai: AI });
  check(status(r) === 409 && body(r).error === 'not_engine_mode' && nothing(r), `a legacy business is refused 409 not_engine_mode, nothing stored (got ${status(r)})`);
  r = await kit.route({ env: ENV_A, ai: AI, before: [SEED], method: 'POST', path: '/files/audio', form: note('What does Mokoena owe me?'), role: 'owner' });
  check(status(r) === 409 && body(r).error === 'engine_mode', 'the legacy audio route stays refused in an engine business');
});

if (require.main === module) kit.standalone(module.exports);
