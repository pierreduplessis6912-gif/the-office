// The two tools that read a run's logs from inside GitHub (log-leak-check.yml and log-excerpt.yml), built because the environment that writes this code cannot download logs. What matters: they only read, they take their
// inputs through environment variables, the excerpt tool refuses to excerpt a deploy or secret step, and a record never pushes another branch's code to main.
module.exports = async function runLogToolsTests({ check, path, fs }) {
  const load = (f) => fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', f), 'utf8').replace(/^\s*#.*$/gm, '');
  for (const [f, group] of [['log-leak-check.yml', 'log-leak-check'], ['log-excerpt.yml', 'log-excerpt']]) {
    const code = load(f), triggers = code.slice(code.indexOf('on:'), code.indexOf('concurrency:'));
    check(/workflow_dispatch:/.test(triggers) && !/schedule:|push:|pull_request:|workflow_call:/.test(triggers) && /run_id:[\s\S]*?required: true/.test(triggers), `${f}: starts by hand only, with a required run id`);
    check(/permissions:\s*\n\s*contents: write\s*\n\s*actions: read/.test(code) && !/secrets\./.test(code) && /GH_TOKEN: \$\{\{ github\.token \}\}/.test(code), `${f}: reads logs with the run's own token (actions: read) and uses no repository secret`);
    check(/case "\$RUN_ID" in ''\|\*\[!0-9\]\*\)/.test(code) && !/\$\{\{\s*(github\.event\.inputs|inputs)/.test([...code.matchAll(/run: \|([\s\S]*?)(?=\n      - |\n[a-z]|$)/g)].map((m) => m[1]).join('\n')), `${f}: the run id must be a number, and typed text reaches the scripts only through environment variables`);
    check(new RegExp(`group: ${group}\\s*\\n\\s*cancel-in-progress: false`).test(code) && /git push origin HEAD:"\$GITHUB_REF_NAME"/.test(code) && !/git push origin HEAD:main/.test(code), `${f}: one at a time, and it records on the branch it started from (never pushing another branch's code to main)`);
  }
  const ex = load('log-excerpt.yml');
  check(/len\(wanted\) < 4 or re\.search\(r"deploy\|secret\|key\|token\|prod", wanted\)/.test(ex) && /refused: choose a test step name/.test(ex), 'the excerpt tool REFUSES a step name that is short or mentions deploy, secret, key, token or prod: only test output is ever excerpted');
  check(/bad\[:40\]/.test(ex) && /lines\[-25:\]/.test(ex) && /l\[:400\]/.test(ex) && /l\[:300\]/.test(ex), 'and its output is capped (40 matching lines, the last 25, each line cut)');
  check(!/-X\s*(POST|PUT|DELETE|PATCH)/.test(ex) && !/-X\s*(POST|PUT|DELETE|PATCH)/.test(load('log-leak-check.yml')), 'neither tool makes any write request: they only download the logs');
  const leak = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'log-leak-check.yml'), 'utf8');
  check(/USE ONLY PLACEHOLDER STRINGS/.test(leak) && /Never type a real email address here/.test(leak), 'the leak check says in its own header that only placeholders may be searched for (the needle is a public input)');
};
