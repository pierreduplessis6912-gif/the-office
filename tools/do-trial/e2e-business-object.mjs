// End to end, on the local Cloudflare runtime: the WHOLE application (bundled from worker/src) with BUSINESS_MODE=object, so every request is served by a business's Durable Object.
// Usage (from a scratch folder holding a copy of worker/ with its dependencies installed and miniflare@4 installed):
//   node e2e-business-object.mjs <path-to-worker-folder> <path-to-esbuild>
// It signs in as an owner WITHOUT Google (a session cookie is just a signed {email, exp}), creates customers through the real CSV import, reads them back, and shows that the Worker's
// own database was never touched: every byte of the business's data is inside the object.
import { Miniflare } from "miniflare";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const workerDir = path.resolve(process.argv[2]);
const esbuild = path.resolve(process.argv[3]);
const out = path.join(workerDir, "bundle.mjs");
execFileSync(esbuild, ["src/index.ts", "--bundle", "--format=esm", "--platform=neutral", "--conditions=workerd,worker,browser", "--main-fields=module,main", "--external:cloudflare:*", "--external:node:*", `--outfile=${out}`, "--log-level=error"], { cwd: workerDir, stdio: "inherit" });

const SECRET = "e2e-session-secret";
const b64u = (buf) => Buffer.from(buf).toString("base64url");
const cookieFor = (email) => { const p = b64u(JSON.stringify({ email, exp: Date.now() + 3600_000 })); return `office_session=${p}.${b64u(crypto.createHmac("sha256", SECRET).update(p).digest())}`; };

const mf = new Miniflare({
  modules: true, script: fs.readFileSync(out, "utf8"), compatibilityDate: "2026-07-01", compatibilityFlags: ["nodejs_compat"],
  bindings: { ADMIN_KEY: "k-admin", ADMIN_CONFIRM_KEY: "k-confirm", SESSION_SECRET: SECRET, BUSINESS_MODE: "object", ENVIRONMENT: "test", RECORD_TIMINGS: "1" },
  d1Databases: ["OFFICE_DB"], kvNamespaces: ["CUSTOMER_NOTES"], r2Buckets: ["OFFICE_VAULT"],
  durableObjects: { BUSINESS: { className: "BusinessObject", useSQLite: true }, TRIAL: { className: "TrialObject", useSQLite: true } },
});
const call = async (p, init = {}) => { const t = performance.now(); const r = await mf.dispatchFetch("http://localhost" + p, init); const text = await r.text(); let body; try { body = JSON.parse(text); } catch { body = text; } return { status: r.status, body, headers: r.headers, ms: Math.round(performance.now() - t) }; };
const results = []; const check = (ok, what, detail = "") => { results.push({ ok, what, detail }); console.log((ok ? "ok   " : "FAIL ") + what + (detail ? "  [" + detail + "]" : "")); };
const origin = { Origin: "https://the-office-preview.pages.dev" };
const admin = { "X-Admin-Key": "k-admin" };

const health = await call("/health");
check(health.status === 200 && health.body.status === "ok", "GET /health is served through the business object", `status ${health.status}`);
const stranger = await call("/customers", { headers: origin });
check(stranger.status === 401 && stranger.body.error === "sign in required" && stranger.headers.get("access-control-allow-origin") === origin.Origin, "a stranger is refused with a JSON 401 and the CORS header (the front door and the sign-in gate run inside the object)");
const noKey = await call("/debug/customers");
check(noKey.status === 401, "an admin route without the key is refused (the admin gate runs inside the object)");
const privileged = await call("/debug/create-membership", { method: "POST", headers: { ...admin, "Content-Type": "application/json" }, body: JSON.stringify({ google_email: "owner@example.com", role: "owner" }) });
check(privileged.status === 403, "a privileged route with only the admin key is refused", `status ${privileged.status}`);
const member = await call("/debug/create-membership", { method: "POST", headers: { ...admin, "X-Admin-Confirm": "k-confirm", "Content-Type": "application/json" }, body: JSON.stringify({ google_email: "owner@example.com", role: "owner" }) });
check(member.status === 200, "an owner is created with both keys", `status ${member.status} ${JSON.stringify(member.body).slice(0, 80)}`);
const cookie = { Cookie: cookieFor("owner@example.com") };
const itemsOf = (b) => (Array.isArray(b?.items) ? b.items : []);
const empty = await call("/customers", { headers: cookie });
check(empty.status === 200 && Array.isArray(empty.body.items) && empty.body.items.length === 0, "signed in as the owner, the customer list is empty", `status ${empty.status}`);
const boundary = "----e2eboundary";
const csv = "name,address\nJenny Smith,1 Main Rd\nSipho Dlamini,2 High St\n";
const upload = `--${boundary}\r\nContent-Disposition: form-data; name="csv"; filename="customers.csv"\r\nContent-Type: text/csv\r\n\r\n${csv}\r\n--${boundary}--\r\n`;
const imported = await call("/files/customers-csv-import", { method: "POST", headers: { ...cookie, "Content-Type": `multipart/form-data; boundary=${boundary}` }, body: upload });
check(imported.status === 200, "the real customer CSV import runs inside the object", `status ${imported.status} ${JSON.stringify(imported.body).slice(0, 120)}`);
const after = await call("/customers", { headers: cookie });
const list = itemsOf(after.body);
check(after.status === 200 && list.length === 2 && list.some((c) => c.name === "Jenny Smith"), "the two customers are read back out of the object", `${list.length} customers`);
const workerD1 = await mf.getD1Database("OFFICE_DB");
const tables = (await workerD1.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'sqlite_%'").all()).results;
check(tables.length === 0, "the Worker's OWN database was never touched: every byte of the business's data is inside the object", `tables in the Worker's D1: ${tables.length}`);
const timings = await call("/debug/timings", { headers: admin });
check(timings.status === 200 && timings.body.requests >= 1, "per-request timing is recorded from inside the object", `requests recorded: ${timings.body.requests}`);
const burst = await Promise.all(Array.from({ length: 12 }, () => call("/customers", { headers: cookie })));
check(burst.every((r) => r.status === 200 && itemsOf(r.body).length === 2), "12 concurrent requests all succeed and agree", `slowest ${Math.max(...burst.map((r) => r.ms))} ms`);
const indexes = await call("/debug/init-indexes", { method: "POST", headers: admin });
check(indexes.status === 200 && indexes.body.failed.length === 0 && indexes.body.alreadyThere.length >= 20, "the object applied the indexes itself on wake", `${indexes.body.alreadyThere?.length} already there, ${indexes.body.created?.length} created now (tables made on first use)`);
await mf.dispose();
const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `\n${failed} FAILED` : `\nall ${results.length} end-to-end checks passed`);
process.exit(failed ? 1 : 0);
