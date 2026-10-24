// The reply envelope as a CONTRACT between the backend and the app (ENVELOPE.md, version 1). tools/contract/envelope-v1.json is the one shared
// fixture: the backend test below proves worker/src/experience.ts produces exactly the recorded envelopes for the recorded replies (and that the
// recorded replies are the ones defined here), and the app's Dart test (app/test/envelope_contract_test.dart) proves the app's reader reads those
// same recorded envelopes as the contract says. Change the envelope on either side without the other and one of the two fails.
// To record a deliberate change: CONTRACT_UPDATE=1 node tools/role-matrix.test.js, then review the diff of the fixture like any other change.
const path = require('path'), fs = require('fs'), os = require('os'), assert = require('assert'), esbuild = require('esbuild');

const FIXTURE = path.join(__dirname, 'contract', 'envelope-v1.json');
const FIXTURE2 = path.join(__dirname, 'contract', 'envelope-v2.json');
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
  'an app command naming no known screen': { message: '__OPEN_DASHBOARD__:payroll' },
  'a message that only mentions a command is still speech': { message: 'Say __OPEN_DASHBOARD__:aged_debtors to open it.' },
  'not an object': null,
};

// Version 2 (open_room and refuse). The app reads only version 1 today and must IGNORE these envelopes (app/test/envelope_contract_test.dart pins that), so they live in their own fixture.
const REPLIES_V2 = {
  'a recognised app command opens a room': { message: '__OPEN_DASHBOARD__:financial_snapshot' },
  'the aged debtors room': { message: '__OPEN_DASHBOARD__:aged_debtors' },
  'a whole refusal': { message: 'The financial overview exists for this business but is restricted for your role.', refusals: [{ reason: 'role_cannot_see', topic: 'financial_overview' }], refusalScope: 'whole' },
  'a refusal to record': { message: "Recording payments, invoices, quotations, or supplier transactions isn't available for your role — let someone with that permission know.", refusals: [{ reason: 'role_cannot_record', topic: 'money' }], refusalScope: 'whole' },
  'a refusal in part of the message': { message: '- Done.\n- Stock recording is restricted.', refusals: [{ reason: 'role_cannot_record', topic: 'stock' }], refusalScope: 'part' },
  'a withheld part of a composed answer': { message: 'Quotations are up this month. Balances are restricted for your role.', refusals: [{ reason: 'role_cannot_see_part', topic: 'outstanding_balances' }], refusalScope: 'part' },
  'a spoken follow-up refused': { message: 'Who owes what is restricted for your role.', refusals: [{ reason: 'role_cannot_see', topic: 'debtors' }], refusalScope: 'whole' },
  'an upload refused': { message: "Checking supplier statements isn't available for your role — let someone with that permission know.", refusals: [{ reason: 'role_cannot_record', topic: 'statements' }], refusalScope: 'whole' },
  'a sensitive detail not saved': { message: 'Found existing: Sipho. Nothing was saved: pay details can only be saved by someone with payroll access.', refusals: [{ reason: 'role_cannot_record_part', topic: 'sensitive_details' }], refusalScope: 'part' },
  'a refusal beside a held action': { message: 'Drafted. One part was refused.', pendingActionId: 12, pendingActionIds: [12], pendingActions: [{ id: 12, type: 'invoice' }], pendingActionType: 'invoice', refusals: [{ reason: 'role_cannot_record', topic: 'leads' }], refusalScope: 'part' },
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
  // version 2: the same record-and-compare, in its own fixture
  const produced2 = Object.entries(REPLIES_V2).map(([name, reply]) => ({ name, reply, experience: ex.buildExperience(reply) }));
  if (process.env.CONTRACT_UPDATE === '1') fs.writeFileSync(FIXTURE2, JSON.stringify({ contract: 'ENVELOPE.md, version 2', regenerate: 'CONTRACT_UPDATE=1 node tools/role-matrix.test.js', cases: produced2 }, null, 2) + '\n');
  { let fx2 = null; try { fx2 = JSON.parse(fs.readFileSync(FIXTURE2, 'utf8')); } catch { /* checked below */ }
    check(fx2 !== null && Array.isArray(fx2.cases) && same(fx2.cases.map((c) => c.name), produced2.map((c) => c.name)), 'the version 2 fixture exists and records exactly the replies this test defines (re-record with CONTRACT_UPDATE=1)');
    if (fx2 !== null && Array.isArray(fx2.cases)) for (const p of produced2) {
      const recorded = fx2.cases.find((c) => c.name === p.name);
      check(recorded !== undefined && same(recorded.reply, JSON.parse(JSON.stringify(p.reply))) && same(recorded.experience, JSON.parse(JSON.stringify(p.experience))), `version 2 fixture "${p.name}": the recorded reply is the one defined here and the backend produces exactly the recorded envelope`);
      const e = p.experience;
      check(e.version === 2 && ['open_room', 'refuse', 'speak', 'confirm'].includes(e.recommendation.mode), `version 2 fixture "${p.name}": stamped version 2, with a mode this contract defines`);
      check(e.mustStillPass.confirmationRequired === (e.established.heldActions.length > 0), `version 2 fixture "${p.name}": confirmation is required exactly when something is held`);
    } }
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
