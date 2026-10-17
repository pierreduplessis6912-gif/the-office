// The read-only production directory listing (.github/workflows/prod-directory.yml). It must only READ, use only the admin READ key (never the confirmation key), record no email (the listing has none) and never push another branch's code to main.
module.exports = async function runProdDirectoryTests({ check, path, fs }) {
  const raw = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'prod-directory.yml'), 'utf8'), code = raw.replace(/^\s*#.*$/gm, '');
  const triggers = code.slice(code.indexOf('on:'), code.indexOf('concurrency:'));
  check(/workflow_dispatch:/.test(triggers) && !/schedule:|push:|pull_request:|workflow_call:/.test(triggers), 'it starts by hand only');
  check(!/-X\s*(POST|PUT|DELETE|PATCH)/.test(code) && /\/debug\/directory" -H "X-Admin-Key: \$ADMIN"/.test(code), 'it makes no write request: one GET of the directory');
  check(JSON.stringify([...new Set([...code.matchAll(/secrets\.([A-Z_]+)/g)].map((m) => m[1]))]) === JSON.stringify(['PROD_ADMIN_KEY']) && !/X-Admin-Confirm/.test(code), 'it uses ONLY the admin read key, never the confirmation key');
  check(/"id", "name", "status", "plan", "members", "source", "trial_ends_at"/.test(code) && !/email/i.test(code.replace(/git config user\.email "[^"]*"/, '').replace(/no emails/g, '')), 'it records exactly the listing\'s fields (member COUNT, no email)');
  check(/sys\.exit\(0 if status == "200" and listing is not None else 1\)/.test(code) && /if: always\(\)/.test(code) && /git push origin HEAD:"\$GITHUB_REF_NAME"/.test(code) && !/git push origin HEAD:main/.test(code), 'it goes red when the directory cannot be read, records even then, and records on the branch it started from');
};
