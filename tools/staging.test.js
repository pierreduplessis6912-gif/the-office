// Guards on the staging workflow (SHIP_CHECKLIST.md item 5b). It creates real cloud resources and a DNS record, so its safety properties must not be removable by accident.
module.exports = async function runStagingTests({ check, path, fs }) {
  const root = path.join(__dirname, '..');
  const yml = fs.readFileSync(path.join(root, '.github', 'workflows', 'staging.yml'), 'utf8');
  const code = yml.replace(/^\s*#.*$/gm, '');
  const trigger = code.slice(code.indexOf('on:'), code.indexOf('concurrency:'));

  check(/workflow_dispatch:/.test(trigger) && !/\bpush:/.test(trigger) && !/\bschedule:/.test(trigger) && !/pull_request/.test(trigger), 'staging creates real resources, so it starts by hand only: never on a push or a schedule');
  check(/CLOUDFLARE_API_TOKEN: \$\{\{ secrets\.PROVISION \}\}/.test(code) && /SEED: \$\{\{ secrets\.STAGING_KEY_SEED \}\}/.test(code), 'it uses the provisioning token and derives its keys from the one seed secret');
  check(/derive\(\)/.test(code) && /openssl dgst -sha256 -hmac/.test(code) && !/openssl rand/.test(code), 'the keys are DERIVED from the seed, never random and lost (the old provisioning workflow generated a random admin key that nobody could ever use)');
  check((code.match(/::add-mask::/g) || []).length === 3, 'each derived key is masked, so it never appears in a log');
  check(/wrangler d1 create "\$\{SLUG\}-db" --location weur/.test(code), 'staging\'s database is placed in Western Europe, like production, so its latency means the same thing');
  for (const step of ['Create the database', 'Create the notes store', 'Create the file storage', 'Create the memory index', 'Create the hostname']) check(code.includes(`name: ${step} (safe to re-run)`), `"${step}" is safe to re-run`);
  check(/d1\/database\?name=\$\{SLUG\}-db/.test(code) && /storage\/kv\/namespaces\?per_page=100/.test(code) && /dns_records\?name=\$\{SLUG\}\.websitehub\.co\.za/.test(code), 'the database, the notes store and the hostname are LOOKED UP before they are created');
  check(/SLUG: office-staging/.test(code) && !/SLUG: \$\{\{/.test(code), 'the instance name is fixed to office-staging: this workflow cannot be pointed at production or at a business');
  const config = code.slice(code.indexOf('name = "${SLUG}-api"'), code.indexOf('cat worker/wrangler.staging.toml'));
  check(/ENVIRONMENT = "staging"/.test(config) && /class_name = "TrialObject"/.test(config) && /new_sqlite_classes = \["TrialObject"\]/.test(config) && !/crons/.test(config), 'staging\'s Worker says it is staging, registers the Durable Object with SQLite storage, and has no hourly job (it would spend model budget for nothing)');
  check(/\$\{SLUG\}-db/.test(config) && /\$\{SLUG\}-vault/.test(config) && /\$\{SLUG\}-memory/.test(config) && !/office-db|office-vault|office-memory|d5343bef/.test(config), 'staging uses only its own resources and none of production\'s (no production database id, bucket or index appears in its configuration)');
  check(code.indexOf('name: Create the tables') > 0 && code.indexOf('name: Create the tables') < code.indexOf('name: Deploy staging') && /wrangler d1 migrations apply OFFICE_DB --remote --config wrangler\.staging\.toml/.test(code), 'the baseline tables are created before the Worker is deployed (the old provisioning workflow skipped this)');
  check(/printf '%s' "\$STAGING_ADMIN_KEY" \| wrangler secret put ADMIN_KEY/.test(code) && /printf '%s' "\$STAGING_CONFIRM_KEY" \| wrangler secret put ADMIN_CONFIRM_KEY/.test(code), 'staging gets its admin key and its second (privileged) key from the derived values');
  const writer = code.slice(code.indexOf("python3 - <<'PY'"), code.indexOf('\n          PY'));
  check(writer.length > 100 && !/KEY|SECRET|SEED|TOKEN/.test(writer.replace(/kv_namespace_id|database_id/g, '')), 'the record of what happened (committed to the repository) can never contain a key, a secret or a token: only ids and results');
  check(/permissions:\s*\n\s*contents: write/.test(code) && /git add ops\/staging-last-run\.json/.test(code) && !/git add -A|git add \./.test(code), 'it may write only to the repository, and only adds its own record file');
  check(/Create the tables[\s\S]*?Deploy staging[\s\S]*?Set staging's secrets[\s\S]*?Smoke test staging[\s\S]*?Set up staging's schema and indexes/.test(code), 'the order is: tables, deploy, secrets, smoke test, schema and indexes');
};
