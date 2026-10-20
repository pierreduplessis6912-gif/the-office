// The reply envelope as a CONTRACT between the backend and the app (ENVELOPE.md, version 1). tools/contract/envelope-v1.json is the one shared
// fixture: the backend test below proves worker/src/experience.ts produces exactly the recorded envelopes for the recorded replies (and that the
// recorded replies are the ones defined here), and the app's Dart test (app/test/envelope_contract_test.dart) proves the app's reader reads those
// same recorded envelopes as the contract says. Change the envelope on either side without the other and one of the two fails.
// To record a deliberate change: CONTRACT_UPDATE=1 node tools/role-matrix.test.js, then review the diff of the fixture like any other change.
const path = require('path'), fs = require('fs'), os = require('os'), assert = require('assert'), esbuild = require('esbuild');

const FIXTURE = path.join(__dirname, 'contract', 'envelope-v1.json');
const many = (n) => Array.from({ length: n }, (_, i) => ({ id: i + 1, type: 'invoice' }));

// The replies the backend is asked to wrap. Inputs only; the expected envelopes live in the fixture.
const REPLIES = {
  'a plain reply': { message: 'Done.' },
  'one held invoice': { message: "I've drafted an invoice for Jenny.", pendingActionId: 12, pendingActionIds: [12], pendingActions: [{ id: 12, type: 'invoice' }], pendingActionType: 'invoice' },
  'an ambiguous person with candidates': { message: 'Which Jenny?', pendingActionId: 5, pendingActions: [{ id: 5, type: 'ambiguous_person' }], pendingCandidates: [{ id: 1, name: 'Jenny Adams' }, { id: 2, name: 'Jenny Botha' }] },
  'several held actions, one a choice': { message: 'Three things are waiting.', pendingActions: [{ id: 7, type: 'stock_add' }, { id: 8, type: 'invoice' }, { id: 9, type: 'project_ambiguity' }] },
  'a held action with proposed changes': { message: 'Review the amount.', pendingActionId: 20, pendingActions: [{ id: 20, type: 'job_scope_amendment' }], pendingChanges: [{ field: 'amount', label: 'Amount', displayValue: 'R1,200.00' }] },
  'a held action with no type': { message: 'Waiting.', pendingActions: [{ id: 3, type: null }] },
  'malformed fields': { message: 12, pendingActions: 'nope', pendingCandidates: [{ id: 'x', name: 5 }, { id: 4, name: 'Kept' }] },
  'a list longer than the cap': { message: 'Many.', pendingActions: many(60) },
  'a message too long to repeat': { message: 'x'.repeat(2500) },
  'long strings are cut': { message: 'ok', pendingActions: [{ id: 2, type: 'y'.repeat(300) }], pendingCandidates: [{ id: 6, name: 'n'.repeat(300) }] },
  'fields outside the allowlist are never copied': { message: 'ok', token: 'secret', email: 'a@b.co', capabilities: ['all'], pendingActions: [{ id: 4, type: 'invoice', token: 'secret', url: 'https://evil.example' }] },
  'a message that is an app command': { message: '__OPEN_DASHBOARD__:financial_snapshot' },
  'a message that only mentions a command is still speech': { message: 'Say __OPEN_DASHBOARD__:aged_debtors to open it.' },
  'not an object': null,
};

module.exports = async function runExperienceContractTests({ check, srcDir }) {
  let ex;
  try { const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'xc-')), 'm.js'); esbuild.buildSync({ entryPoints: [path.join(srcDir, 'experience.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent' }); ex = require(out); } catch (e) { check(false, 'experience.ts builds for the contract test: ' + String(e.message).split('\n')[0].slice(0, 160)); return; }
  const same = (a, b) => { try { assert.deepStrictEqual(a, b); return true; } catch { return false; } };

  const produced = Object.entries(REPLIES).map(([name, reply]) => ({ name, reply, experience: ex.buildExperience(reply) }));
  if (process.env.CONTRACT_UPDATE === '1') {
    fs.writeFileSync(FIXTURE, JSON.stringify({ contract: 'ENVELOPE.md, version 1', regenerate: 'CONTRACT_UPDATE=1 node tools/role-matrix.test.js', cases: produced, compatibility: (readFixture() || {}).compatibility || [] }, null, 2) + '\n');
  }
  const fx = readFixture();
  check(fx !== null && Array.isArray(fx.cases), 'the shared envelope fixture exists and has cases');
  if (fx === null || !Array.isArray(fx.cases)) return;
  check(same(fx.cases.map((c) => c.name), produced.map((c) => c.name)), 'the fixture records exactly the replies this test defines (re-record with CONTRACT_UPDATE=1 if you changed them)');
  for (const p of produced) {
    const recorded = fx.cases.find((c) => c.name === p.name);
    check(recorded !== undefined && same(recorded.reply, JSON.parse(JSON.stringify(p.reply))), `fixture "${p.name}": the recorded reply is the one defined here`);
    check(recorded !== undefined && same(recorded.experience, JSON.parse(JSON.stringify(p.experience))), `fixture "${p.name}": the backend produces exactly the recorded envelope`);
  }
  // the app relies on these facts about every recorded envelope
  for (const c of fx.cases) {
    const e = c.experience, keys = Object.keys(e).sort().join();
    check(e.version === 1 && keys === 'established,mustStillPass,recommendation,unknown,version', `fixture "${c.name}": version 1 with exactly the four parts`);
    check(['speak', 'confirm', 'clarify'].includes(e.recommendation.mode), `fixture "${c.name}": the mode is one of the three the app knows`);
    check(e.established.heldActions.every((h) => Number.isSafeInteger(h.id) && h.id > 0 && (h.type === null || typeof h.type === 'string')), `fixture "${c.name}": held actions are positive whole ids with a text or null type`);
    check(e.mustStillPass.confirmationRequired === (e.established.heldActions.length > 0), `fixture "${c.name}": confirmation is required exactly when something is held`);
  }
  // compatibility entries are written by hand for the app's reader (forward compatibility); the backend only checks they are well formed
  const compat = fx.compatibility || [];
  check(compat.length >= 5 && compat.every((c) => typeof c.name === 'string' && c.experience !== undefined && c.expect && typeof c.expect.read === 'boolean'), 'the compatibility entries are well formed (name, experience, expect.read)');

  function readFixture() { try { return JSON.parse(fs.readFileSync(FIXTURE, 'utf8')); } catch { return null; } }
};
