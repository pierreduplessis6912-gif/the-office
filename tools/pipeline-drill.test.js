// A DRILL, committed on purpose and removed in the next commit (2026-10-17): a check that fails, so CI goes RED and nothing deploys, followed by a tests-only commit that removes it. Under the old deploy decision (compare with the previous
// commit) that second commit asked "did the Worker change since the previous commit?", got "no", and skipped the deploy, leaving the red commit's Worker change undeployed. Under the new one (compare with what production runs) it must deploy.
module.exports = async function runPipelineDrill({ check }) {
  check(false, 'PIPELINE DRILL: this check fails on purpose, to make CI red');
};
