#!/usr/bin/env node
// Command line for the read-only inventory (tools/inventory-lib.mjs). Keys come from the environment, never the command line.
//   SOURCE_URL SOURCE_ADMIN_KEY SOURCE_CONFIRM_KEY   the deployment to count (nothing is written to it)
//   SOURCE_BUSINESS                                   optional: after the cutover an admin call must NAME the business whose data to count
//   VECTOR_COUNT                                      optional: how many memories its index holds (Cloudflare's API knows; the Worker cannot list it)
import { inventory } from './inventory-lib.mjs';
const env = process.env;
const need = ['SOURCE_URL', 'SOURCE_ADMIN_KEY', 'SOURCE_CONFIRM_KEY'].filter((k) => !env[k]);
if (need.length) { console.error('missing in the environment: ' + need.join(', ')); process.exit(2); }
const report = await inventory({ source: { base: env.SOURCE_URL, adminKey: env.SOURCE_ADMIN_KEY, confirmKey: env.SOURCE_CONFIRM_KEY, business: env.SOURCE_BUSINESS || undefined }, vectorCount: Number(env.VECTOR_COUNT || 0) });
console.log(JSON.stringify(report, null, 1));
process.exit(report.ok ? 0 : 1);
