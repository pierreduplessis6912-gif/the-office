// The handover must name the commit production really runs (docs-check uses this). Pure, so it can be tested without git.
// HANDOVER.md's State section says: "the last code deploy is `<sha>`". ops/production-signup-check-last.json says what production reports (`running_commit`). When the handover names an OLDER commit than production reports, it is stale: that is an ERROR (it stopped being true the moment a newer deploy went live and nobody updated it). When it names a NEWER one than the record, the record just has not been refreshed yet: a warning.
// isAncestor(a, b) and exists(c) return true, false, or null when git cannot say (a shallow clone): then the check only warns.
function productionCommitCheck({ handover, recordCommit, isAncestor, exists }) {
  const errors = [], warnings = [];
  const m = /last code deploy is `([0-9a-f]{7,40})`/.exec(handover || '');
  if (!m) { errors.push('HANDOVER.md: the State section must say "the last code deploy is `<commit>`" so it can be checked against production'); return { errors, warnings }; }
  const named = m[1];
  if (!recordCommit) { warnings.push('HANDOVER.md names production commit ' + named + ' but ops/production-signup-check-last.json has no running_commit to compare with'); return { errors, warnings }; }
  if (recordCommit.startsWith(named) || named.startsWith(recordCommit)) return { errors, warnings };
  const known = exists(named);
  if (known === false) { errors.push('HANDOVER.md names ' + named + ' as the last code deploy, which is not a commit in this repository'); return { errors, warnings }; }
  if (known === null) { warnings.push('HANDOVER.md production commit check skipped: git cannot resolve ' + named + ' here'); return { errors, warnings }; }
  if (isAncestor(named, recordCommit) === true) errors.push('HANDOVER.md names ' + named + ' as the last code deploy, but production reports ' + recordCommit.slice(0, 7) + ', which is newer: update the State section (production commit, test counts, what is proven)');
  else if (isAncestor(recordCommit, named) === true) warnings.push('HANDOVER.md names ' + named + ', newer than the production record (' + recordCommit.slice(0, 7) + '): run prod-signup-check.yml so the record confirms it');
  else warnings.push('HANDOVER.md names ' + named + ' and the production record says ' + recordCommit.slice(0, 7) + ': they are not on one line of history');
  return { errors, warnings };
}
module.exports = { productionCommitCheck };
