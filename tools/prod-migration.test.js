// Guards on the two PRODUCTION workflows that prepare the real migration (prod-create-business.yml and prod-copy.yml). They touch production, so what each may do is pinned: one creates the empty business
// (one write), the other copies into the business's object and nothing else. Neither may copy the memories yet, neither may force, and neither may commit a key or an address.
module.exports = async function runProdMigrationTests({ check, path, fs }) {
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', f), 'utf8').replace(/^\s*#.*$/gm, '');
  const create = read('prod-create-business.yml'), copy = read('prod-copy.yml');
  const manual = (code) => { const t = code.slice(code.indexOf('on:'), code.indexOf('concurrency:')); return /workflow_dispatch:/.test(t) && !/\bpush:/.test(t) && !/\bschedule:/.test(t) && !/pull_request/.test(t); };
  const secretsOf = (code) => [...new Set([...code.matchAll(/secrets\.([A-Z_]+)/g)].map((m) => m[1]))].sort();
  const writer = (code) => { const start = code.indexOf("python3 - <<'PY'", code.indexOf('mkdir -p ops')); return code.slice(start, code.indexOf('\n          PY', start)); };

  // ---- create the empty business -------------------------------------------------------------------------------------------------------------------------------------------------
  check(manual(create) && manual(copy), 'both production workflows start by hand only');
  check(/PROD_URL: https:\/\/office\.websitehub\.co\.za/.test(create) && /BUSINESS_ID: zululand-flooring-and-blinds/.test(create) && !/BUSINESS_ID: \$\{\{/.test(create), 'creating the business is fixed to production and to the business Pierre approved (its id is permanent: it names the object)');
  const posts = [...create.matchAll(/-X\s*(POST|PUT|DELETE|PATCH)\s+"([^"]+)"/gi)];
  check(posts.length === 1 && posts[0][1] === 'POST' && /\/debug\/directory\/create-business$/.test(posts[0][2]) && /\\"migrating\\":true/.test(create), 'it makes exactly ONE write: the creation of the business, with migrating:true (empty, no invented owner); everything else it does is a read');
  check(JSON.stringify(secretsOf(create)) === JSON.stringify(['PROD_ADMIN_KEY', 'PROD_CONFIRM_KEY']) && !/echo[^\n]*\$(ADMIN|CONFIRM)/.test(create), 'it uses exactly the two production keys, from the environment, and never echoes them');
  check(writer(create).length > 200 && !/KEY|SECRET|TOKEN|PASSWORD|EMAIL|ADMIN\b|CONFIRM\b/.test(writer(create).replace(/the_business_object_says_it_is|the_worker_says_it_is/g, '')), 'its committed record is ids, counts and statuses only');

  // ---- the copy -------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  check(/PROD_URL: https:\/\/office\.websitehub\.co\.za/.test(copy) && /BUSINESS: zululand-flooring-and-blinds/.test(copy) && !/BUSINESS: \$\{\{/.test(copy), 'the copy is fixed to production and to that one business');
  check(/SOURCE_URL: \$\{\{ env\.PROD_URL \}\}/.test(copy) && /TARGET_URL: \$\{\{ env\.PROD_URL \}\}/.test(copy) && /node tools\/migrate\.mjs/.test(copy), 'its source and target are the SAME address by design (one deployment, a business\'s object inside it): which is only safe because the runner asks both ends who they are and refuses otherwise (tested separately)');
  check(!/--force/.test(copy) && !/VECTOR_INDEX|CF_API_TOKEN|CF_ACCOUNT_ID|TARGET_VECTOR_INDEX/.test(copy) && /"memories_copied": False/.test(copy), 'it never forces and does NOT copy the memories (production still searches that index with no namespace, so copies would appear twice until the cutover); the record says so');
  check(JSON.stringify(secretsOf(copy)) === JSON.stringify(['PROD_ADMIN_KEY', 'PROD_CONFIRM_KEY']), 'it uses exactly the two production keys');
  check(!/-X\s*(POST|PUT|DELETE|PATCH)/i.test(copy) && !/wrangler/.test(copy) && /node tools\/inventory\.mjs/.test(copy), 'the only writes it can cause are the runner\'s own (into the business\'s object and its prefixed notes and files); it makes no write request itself and runs no deployment command');
  check(/EMAIL = re\.compile/.test(copy) && /json\.dump\(scrub\(out\)/.test(copy) && /<email>/.test(copy), 'its committed record is SCRUBBED: anything that looks like an email address is replaced before it is written (the runner\'s messages can name members)');
  check(writer(copy).length > 400 && !/KEY|SECRET|TOKEN|PASSWORD/.test(writer(copy)), 'and it can carry no key, secret or token');
  for (const [name, code, file] of [['create', create, 'production-business-last'], ['copy', copy, 'production-copy-last']]) check(/permissions:\s*\n\s*contents: write/.test(code) && new RegExp(`git add ops/${file}\\.json`).test(code) && !/git add -A|git add \./.test(code), `the ${name} workflow may write only to the repository, and only adds its own record file`);
};
