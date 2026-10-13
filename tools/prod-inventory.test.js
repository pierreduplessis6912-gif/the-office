// Guards on the production inventory workflow (.github/workflows/prod-inventory.yml). It touches PRODUCTION, so it must be provably read-only, started by hand, use only the secrets it needs, and
// commit a record that can never carry a key or a personal detail.
module.exports = async function runProdInventoryTests({ check, path, fs }) {
  const yml = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'prod-inventory.yml'), 'utf8');
  const code = yml.replace(/^\s*#.*$/gm, '');
  const trigger = code.slice(code.indexOf('on:'), code.indexOf('concurrency:'));
  check(/workflow_dispatch:/.test(trigger) && !/\bpush:/.test(trigger) && !/\bschedule:/.test(trigger) && !/pull_request/.test(trigger), 'the production inventory starts by hand only');
  check(/PROD_URL: https:\/\/office\.websitehub\.co\.za/.test(code) && !/PROD_URL: \$\{\{/.test(code), 'it is pointed at production and cannot be pointed anywhere else');
  check(!/-X\s*(POST|PUT|DELETE|PATCH)/i.test(code) && !/--request\s+(POST|PUT|DELETE|PATCH)/i.test(code) && !/wrangler (deploy|secret|d1 execute|d1 migrations|kv|r2|vectorize create)/.test(code), 'it is READ-ONLY: no write request and no write command appears anywhere in it');
  check(/node tools\/inventory\.mjs/.test(code) && !/migrate\.mjs|--force|migrate-lib/.test(code) && !/fingerprint/.test(code), 'the only thing it runs against the data is the read-only inventory: not the migration runner, and it never asks for a fingerprint');
  const secrets = [...code.matchAll(/secrets\.([A-Z_]+)/g)].map((m) => m[1]).sort();
  check(JSON.stringify([...new Set(secrets)]) === JSON.stringify(['CLOUDFLARE_ACCOUNT_ID', 'PROD_ADMIN_KEY', 'PROD_CONFIRM_KEY', 'PROVISION']), `it uses exactly the four secrets it needs (found: ${[...new Set(secrets)].join(', ')})`);
  const keyStep = code.slice(code.indexOf('name: Inventory the production data'), code.indexOf('name: Record what was found'));
  check(/SOURCE_ADMIN_KEY: \$\{\{ secrets\.PROD_ADMIN_KEY \}\}/.test(keyStep) && /SOURCE_CONFIRM_KEY: \$\{\{ secrets\.PROD_CONFIRM_KEY \}\}/.test(keyStep) && !/echo[^\n]*(KEY|SOURCE_ADMIN|SOURCE_CONFIRM)/.test(keyStep), 'the production keys are handed to the inventory step through its environment only, and never echoed');
  const recordStart = code.indexOf('mkdir -p ops');
  const writerStart = code.indexOf("python3 - <<'PY'", recordStart);
  const writer = code.slice(writerStart, code.indexOf('\n          PY', writerStart));
  check(writer.length > 200 && !/KEY|SECRET|TOKEN|PASSWORD|EMAIL|google_email|name"\]/i.test(writer), 'the record committed to the repository is built from counts and sizes only: no key, token, address or name can be in it');
  check(/permissions:\s*\n\s*contents: write/.test(code) && /git add ops\/production-inventory-last\.json/.test(code) && !/git add -A|git add \./.test(code), 'it may write only to the repository, and only adds its own record file');
};
