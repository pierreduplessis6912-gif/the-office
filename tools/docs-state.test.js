// The handover's production commit gate (tools/docs-state.js). Each case is a fact about which of the two is older.
const { productionCommitCheck } = require('./docs-state.js');
module.exports = async function runDocsStateTests({ check }) {
  const H = (sha) => `State: the last code deploy is \`${sha}\` (checked).`;
  const git = (order) => ({ exists: (c) => order.includes(c.slice(0, 7)) ? true : false, isAncestor: (a, b) => order.indexOf(a.slice(0, 7)) < order.indexOf(b.slice(0, 7)) });
  const L = ['aaaaaaa', 'bbbbbbb', 'ccccccc'], FULL = (s) => s + '1234567890123456789012345678901234';
  const run = (named, rec, g = git(L)) => productionCommitCheck({ handover: H(named), recordCommit: rec ? FULL(rec) : null, ...g });
  check(run('bbbbbbb', 'bbbbbbb').errors.length === 0 && run('bbbbbbb', 'bbbbbbb').warnings.length === 0, 'the handover naming exactly the commit production runs passes');
  { const r = run('aaaaaaa', 'ccccccc'); check(r.errors.length === 1 && /newer: update the State section/.test(r.errors[0]), 'a handover naming an OLDER commit than production reports is an ERROR (it went stale when the deploy went live)'); }
  { const r = run('ccccccc', 'aaaaaaa'); check(r.errors.length === 0 && r.warnings.length === 1 && /run prod-signup-check/.test(r.warnings[0]), 'a handover naming a NEWER commit than the record is only a warning (the record has not been refreshed)'); }
  { const r = productionCommitCheck({ handover: 'no commit here', recordCommit: FULL('aaaaaaa'), ...git(L) }); check(r.errors.length === 1 && /must say "the last code deploy is/.test(r.errors[0]), 'a State section that does not name the commit at all is an ERROR (the gate would otherwise pass silently)'); }
  { const r = run('ddddddd', 'aaaaaaa'); check(r.errors.length === 1 && /not a commit in this repository/.test(r.errors[0]), 'a commit that does not exist is an ERROR'); }
  { const r = run('aaaaaaa', null); check(r.errors.length === 0 && r.warnings.length === 1, 'no running_commit in the record is a warning, not an error'); }
  { const r = run('aaaaaaa', 'ccccccc', { exists: () => null, isAncestor: () => null }); check(r.errors.length === 0 && r.warnings.length === 1 && /skipped/.test(r.warnings[0]), 'when git cannot say (a shallow clone) the check warns and never fails the build'); }
  { const r = run('aaaaaaa', 'ccccccc', { exists: () => true, isAncestor: () => false }); check(r.errors.length === 0 && r.warnings.length === 1 && /not on one line of history/.test(r.warnings[0]), 'two commits on different lines of history only warn'); }
  check(run('aaaaaaa1234567', 'aaaaaaa').errors.length === 0 && run('aaaaaaa', 'aaaaaaa').errors.length === 0, 'a short and a long form of the same commit are the same commit');
};
