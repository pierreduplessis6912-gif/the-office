// The read-only production probe of the signup front door (.github/workflows/prod-signup-check.yml). It asks the live Worker only what any stranger could ask, so the structure is what matters: it uses no secret, writes nothing
// (its one POST is a GARBAGE proof that must be refused), and goes red when any check is false, so a deploy that broke the front door cannot look fine.
module.exports = async function runProdSignupCheckTests({ check, path, fs }) {
  const raw = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'prod-signup-check.yml'), 'utf8'), code = raw.replace(/^\s*#.*$/gm, '');
  const triggers = code.slice(code.indexOf('on:'), code.indexOf('concurrency:'));
  check(/workflow_dispatch:/.test(triggers) && !/schedule:|push:|pull_request:|workflow_call:/.test(triggers), 'it starts by hand only');
  check(!/secrets\./.test(code) && !/X-Admin-Key|X-Admin-Confirm|Authorization/.test(code), 'it uses NO secret and sends no key: it can only ever learn what a stranger could');
  const writes = [...code.matchAll(/-X\s*(POST|PUT|DELETE|PATCH)\s+[^\n]*/g)].map((m) => m[0]);
  check(writes.length === 1 && /--data-urlencode "token=garbage"/.test(writes[0]) && /\/auth\/signup/.test(writes[0]), 'its ONLY non-read request is one POST of a GARBAGE proof to /auth/signup, which must be refused and create nothing');
  for (const k of ['the_health_check_answers', 'the_health_check_reports_the_commit_production_is_running', 'a_garbage_proof_is_refused_with_a_page', 'that_page_is_not_cached_or_framed_and_runs_no_script', 'the_sign_in_callback_still_refuses_a_visit_with_no_state', 'the_sign_in_start_still_sends_people_to_google', 'a_stranger_is_still_refused_the_data']) check(code.includes(`"${k}"`), `it checks: ${k}`);
  check(/sys\.exit\(1 if bad else 0\)/.test(code) && /\[k for k, v in out\.items\(\) if v is False\]/.test(code), 'a false check turns the run RED');
  const record = code.slice(code.indexOf('- name: Record what happened'));
  check(/if: always\(\)/.test(record) && /ops\/production-signup-check-last\.json/.test(record) && /git push origin HEAD:"\$GITHUB_REF_NAME"/.test(record) && !/git push origin HEAD:main/.test(record), 'it records even when it fails, on the branch it started from (never pushing another branch\'s code to main)');
};
