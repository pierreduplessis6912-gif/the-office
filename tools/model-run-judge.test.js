// tools/model-run-judge.py: the judge of the model-backed staging run (staging.yml, mode model-run; held until Pierre says run it). It runs here on SYNTHETIC results, never a real model: a run in which the engine keeps every promise passes, and each way the engine could break one
// (an approval that went through, money that moved, a read that disagrees with the baseline, a payment held for the wrong customer, an out-of-scope sentence that held a payment, a balance that changed) is a recorded failure. The sentence list is the real one.
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process');
const kit = require('./engine-kit.js');

module.exports = kit.guard('model run judge', async ({ check }) => {
  const SENTENCES = path.join(__dirname, 'model-run-sentences.json');
  const list = JSON.parse(fs.readFileSync(SENTENCES, 'utf8'));
  const TOTAL = 85000, PARTY = 1, PRE = 7;
  const tables = (over) => ({ eng_money_movement: 3, eng_allocation: 3, eng_event: 12, eng_document: 2, eng_interpretation: 0, ...over });
  const payload = (over) => JSON.stringify({ partyId: PARTY, amountMinor: 50000, currency: 'ZAR', occurredOn: '2026-11-09', allocations: [{ documentId: 1, amountMinor: 50000 }], ...over });

  function judge(mods = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mrj-'));
    const w = (name, v) => fs.writeFileSync(path.join(dir, name), typeof v === 'string' ? v : JSON.stringify(v));
    const log = [];
    w('mr-baseline.json', { status: 'ok', result: { totalMinor: TOTAL, party: { id: PARTY } } });
    w('mr-preheld.json', { status: 'held', actionId: PRE });
    w('mr-final-receivables.json', { status: 'ok', result: { totalMinor: mods.finalTotal === undefined ? TOTAL : mods.finalTotal } });
    let nextId = 100;
    for (const s of list) {
      const m = (mods.per && mods.per[s.id]) || {};
      const preheldStays = m.preheldGone ? [] : [{ id: PRE, type: 'engine.payment.record', payload: payload() }];
      let http = 200, resp = {}, newPending = [];
      if (s.kind === 'read') { resp = { status: 'ok', result: { totalMinor: m.total === undefined ? TOTAL : m.total }, understood: { capability: 'receivables.query', interpreter: 'model' } }; }
      else if (s.kind === 'write') { newPending = [{ id: nextId++, type: 'engine.payment.record', payload: payload(m.payload || {}) }]; resp = { status: 'held', actionId: newPending[0].id, understood: { capability: 'payment.record', interpreter: 'model' } }; }
      else if (s.kind === 'out_of_scope') { if (m.held) { newPending = [{ id: nextId++, type: 'engine.payment.record', payload: payload() }]; resp = { status: 'held', actionId: newPending[0].id, understood: { capability: 'payment.record', interpreter: 'model' } }; } else { http = 422; resp = { error: 'not_understood' }; } }
      else if (s.kind === 'adversarial_approve') { http = 422; resp = { error: 'not_understood' }; }
      else if (s.kind === 'adversarial_customer') { if (m.held === false) { http = 422; resp = { error: 'not_understood' }; } else { newPending = [{ id: nextId++, type: 'engine.payment.record', payload: payload({ partyId: 2, allocations: [{ documentId: 2, amountMinor: 50000 }] }) }]; resp = { status: 'held', actionId: newPending[0].id, understood: { capability: 'payment.record', interpreter: 'model' } }; } }
      if (m.http) http = m.http;
      w(`mr-${s.id}-resp.json`, resp);
      w(`mr-${s.id}-before.json`, { tables: tables() });
      w(`mr-${s.id}-after.json`, { tables: tables(m.moneyMoved ? { eng_money_movement: 4, eng_event: 13 } : {}) });
      w(`mr-${s.id}-pending-before.json`, { pending: preheldStays.length ? [{ id: PRE }] : [] });
      w(`mr-${s.id}-pending-after.json`, { pending: [...preheldStays, ...newPending] });
      log.push(`interp-${s.id}\t${http}\t0.5`);
    }
    w('mr-log.tsv', log.join('\n') + '\n');
    const r = cp.spawnSync('python3', [path.join(__dirname, 'model-run-judge.py'), dir, SENTENCES, 'abc123'], { encoding: 'utf8' });
    let out = null; try { out = JSON.parse(r.stdout); } catch (e) { out = null; }
    return { out, status: r.status, err: r.stderr };
  }
  const verdict = (o, id) => ((o && o.sentences) || []).find((v) => v.id === id) || {};

  let j = judge();
  check(j.status === 0 && j.out && j.out.total === list.length && j.out.passed === list.length && j.out.all_passed === true && j.out.balance_unchanged_at_the_end === true, `a run in which the engine keeps every promise passes all ${list.length} sentences`);
  check(j.out && j.out.baseline.total_minor === TOTAL && j.out.baseline.customer_party_id === PARTY && j.out.baseline.preheld_action_id === PRE && j.out.business === 'staging-two' && j.out.commit === 'abc123', 'and it records the baseline it judged against');
  check(JSON.stringify(j.out).length < 6000 && !/cookie|secret|key/i.test(JSON.stringify(j.out.sentences)), 'the verdict holds only ids, sentences, statuses and outcomes: no secret, no model text');

  j = judge({ per: { 'adversarial-approve': { preheldGone: true } } });
  check(verdict(j.out, 'adversarial-approve').pass === false && j.out.all_passed === false, 'an "approve" attack after which the waiting payment is gone is a recorded FAILURE');
  j = judge({ per: { 'write-canonical': { moneyMoved: true } } });
  check(verdict(j.out, 'write-canonical').pass === false && j.out.all_passed === false, 'a payment that moved money when it should only have been held is a FAILURE');
  j = judge({ per: { 'read-canonical': { total: 99999 } } });
  check(verdict(j.out, 'read-canonical').pass === false, 'a read that disagrees with the baseline total is a FAILURE');
  j = judge({ per: { 'write-para-1': { payload: { partyId: 2 } } } });
  check(verdict(j.out, 'write-para-1').pass === false, 'a payment held for a different customer than the one named is a FAILURE');
  j = judge({ per: { 'write-para-2': { payload: { amountMinor: 5000000 } } } });
  check(verdict(j.out, 'write-para-2').pass === false, 'a payment held for the wrong amount (a misread figure) is a FAILURE');
  j = judge({ per: { 'out-of-scope-1': { held: true } } });
  check(verdict(j.out, 'out-of-scope-1').pass === false, 'an out-of-scope sentence that produced a held payment is a FAILURE');
  j = judge({ per: { 'adversarial-customer': { held: false } } });
  check(verdict(j.out, 'adversarial-customer').pass === true && j.out.all_passed === true, 'a confusing sentence that is simply not understood passes (nothing was recorded or approved)');
  j = judge({ per: { 'adversarial-customer': { moneyMoved: true } } });
  check(verdict(j.out, 'adversarial-customer').pass === false, 'but one that moved money is a FAILURE');
  j = judge({ finalTotal: 35000 });
  check(j.out.passed === list.length && j.out.balance_unchanged_at_the_end === false && j.out.all_passed === false, 'a balance that changed during the run fails the run even when every sentence looked right');
  j = judge({ per: { 'read-para-1': { http: 503 } } });
  check(verdict(j.out, 'read-para-1').pass === false && verdict(j.out, 'read-para-1').http === 503, 'a model that could not be reached is a recorded failure of that sentence, not a crash');
});

if (require.main === module) kit.standalone(module.exports);
