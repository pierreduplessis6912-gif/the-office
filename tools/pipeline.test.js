// Guards on the deploy pipeline (SHIP_CHECKLIST.md item 5): the safety it provides must not be removable by accident. Reads .github/workflows/deploy.yml as text.
module.exports = async function runPipelineTests({ check, path, fs }) {
  const file = path.join(__dirname, '..', '.github', 'workflows', 'deploy.yml');
  const yml = fs.readFileSync(file, 'utf8');
  const code = yml.replace(/^\s*#.*$/gm, '');
  const at = (needle) => code.indexOf(needle);
  const trigger = code.slice(at('on:'), at('concurrency:'));

  check(!/\bpaths:/.test(trigger), 'the tests must run on EVERY push to main: the trigger must not have a paths filter (it used to, so a change to the tests, the recordings or the route policy was never checked)');
  check(/workflow_dispatch:/.test(trigger) && /drill:/.test(trigger), 'a person can start the pipeline by hand, with a "drill" option that proves the rollback works');
  check(/name: Role-matrix test on the Durable Object adapter, with every index applied\s*\n\s*run: node tools\/role-matrix\.test\.js\s*\n\s*env:\s*\n\s*NODE_PATH: worker\/node_modules\s*\n\s*HARNESS_BACKEND: do\s*\n\s*HARNESS_INDEXES: "1"/.test(code), 'CI also runs the whole suite through the Durable Object adapter WITH every index applied, so neither the adapter nor the indexes can drift from the real behaviour unnoticed');
  check(/test:\s*\n\s*runs-on/.test(code) && /npm run typecheck/.test(code) && /node tools\/role-matrix\.test\.js/.test(code), 'the test job runs the typecheck and the whole suite');
  check(/deploy:\s*\n\s*needs: \[test, gate\]\s*\n(\s*#[^\n]*\n)?\s*if: \$\{\{ always\(\) && needs\.test\.result == 'success' && needs\.test\.outputs\.deploy_needed == 'true' && \(needs\.gate\.result == 'success' \|\| needs\.gate\.result == 'skipped'\) \}\}/.test(code), 'the deploy job needs the tests to pass, runs only when the Worker changed, and (see gate.test.js) is stopped by a failed staging gate');
  check(/\^\(worker\/\|\\\.github\/workflows\/deploy\\\.yml\$\)/.test(code), 'the Worker counts as changed when anything under worker/ or this pipeline file changes');

  const order = ['Deploy to Cloudflare Workers', 'Smoke test the live Worker', 'Roll back to the previous version', 'Smoke test again after the rollback'].map((n) => at('name: ' + n));
  check(order.every((i) => i > 0) && order.every((v, i) => i === 0 || v > order[i - 1]), 'in the deploy job the order is: deploy, smoke test, roll back, smoke test again');
  check(/id: smoke\s*\n\s*continue-on-error: true/.test(code), 'the smoke test step must not stop the job by itself (the rollback has to be able to run), and has the id the later steps read');
  const rollback = code.slice(at('name: Roll back to the previous version'), at('name: Smoke test again after the rollback'));
  check(/if: steps\.smoke\.outcome == 'failure'/.test(rollback) && /rollback --message "[^"]+" --yes/.test(rollback), 'a failed smoke test triggers an automatic rollback that needs no person to confirm it');
  check(/name: Smoke test again after the rollback\s*\n\s*if: steps\.smoke\.outcome == 'failure'\s*\n\s*run: bash tools\/smoke-test\.sh/.test(code), 'after a rollback the Worker is smoke-tested again, so a rollback that did not help is not mistaken for success');
  check(/name: Mark the run failed[^\n]*\n\s*if: steps\.smoke\.outcome == 'failure' && github\.event\.inputs\.drill != 'true'\s*\n\s*run: \|[\s\S]*?exit 1/.test(code), 'a real failed deploy ends as a FAILED run (red), so it cannot be missed');
  check((code.match(/FORCE_FAIL/g) || []).length === 1 && /FORCE_FAIL: \$\{\{ github\.event\.inputs\.drill == 'true' && '1' \|\| '0' \}\}/.test(code), 'a deliberate failure can only come from the manual drill option, never from a normal push');
  check((code.match(/bash tools\/smoke-test\.sh https:\/\/office\.websitehub\.co\.za/g) || []).length === 2 && fs.existsSync(path.join(__dirname, 'smoke-test.sh')), 'both smoke tests check the live production address with the committed script');
  check((code.match(/secrets\./g) || []).length === 4 && !/secrets\.[A-Z_]*(?<!CF_API_TOKEN)(?<!CLOUDFLARE_ACCOUNT_ID)\b/.test(code.replace(/secrets\.(CF_API_TOKEN|CLOUDFLARE_ACCOUNT_ID)/g, '')), 'the pipeline uses only the two Cloudflare secrets it already had, and the smoke test uses none');
};
