// Usage: from a scratch folder, `npm install miniflare@4 esbuild`, then
//   npx esbuild <repo>/tools/do-trial/real-worker.ts --bundle --format=esm --platform=neutral --outfile=real-worker.mjs
//   node <repo>/tools/do-trial/run-real.mjs real-worker.mjs   (prints the real Durable Object's answers as JSON)
import { Miniflare } from "miniflare";
import fs from "node:fs";
const mf = new Miniflare({ modules: true, script: fs.readFileSync(process.argv[2], "utf8"), compatibilityDate: "2026-07-01", durableObjects: { TEST: { className: "TestObject", useSQLite: true } } });
console.log(await (await mf.dispatchFetch("http://localhost/")).text());
await mf.dispose();
