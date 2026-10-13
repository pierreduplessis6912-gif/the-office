#!/usr/bin/env node
// Command line for the migration runner (tools/migrate-lib.mjs). Keys come from the environment, never from the command line (which lands in shell history):
//   SOURCE_URL SOURCE_ADMIN_KEY SOURCE_CONFIRM_KEY   the deployment the business is moving FROM (nothing is ever written to it)
//   TARGET_URL TARGET_ADMIN_KEY TARGET_CONFIRM_KEY   the deployment it is moving TO, and BUSINESS: the id of the (empty) business created there with  create-business {"migrating": true}
//   CF_ACCOUNT_ID CF_API_TOKEN VECTOR_INDEX TARGET_VECTOR_INDEX   optional: also copy the memory index (Cloudflare's API lists the source and says when the target has processed the writes)
//   node tools/migrate.mjs [--force] [--skip=notes,files,db]
import { migrate } from './migrate-lib.mjs';
const env = process.env;
const need = ['SOURCE_URL', 'SOURCE_ADMIN_KEY', 'SOURCE_CONFIRM_KEY', 'TARGET_URL', 'TARGET_ADMIN_KEY', 'TARGET_CONFIRM_KEY', 'BUSINESS'].filter((k) => !env[k]);
if (need.length) { console.error('missing in the environment: ' + need.join(', ')); process.exit(2); }
const skip = (process.argv.find((a) => a.startsWith('--skip=')) ?? '').slice(7).split(',').filter(Boolean);
const report = await migrate({
  source: { base: env.SOURCE_URL, adminKey: env.SOURCE_ADMIN_KEY, confirmKey: env.SOURCE_CONFIRM_KEY },
  target: { base: env.TARGET_URL, adminKey: env.TARGET_ADMIN_KEY, confirmKey: env.TARGET_CONFIRM_KEY, business: env.BUSINESS },
  include: Object.fromEntries(skip.map((s) => [s, false])),
  vectors: env.VECTOR_INDEX ? { accountId: env.CF_ACCOUNT_ID, apiToken: env.CF_API_TOKEN, indexName: env.VECTOR_INDEX, targetIndexName: env.TARGET_VECTOR_INDEX } : null,
  force: process.argv.includes('--force'),
  log: (line) => console.error(line),
});
console.log(JSON.stringify(report, null, 1));
process.exit(report.ok ? 0 : 1);
