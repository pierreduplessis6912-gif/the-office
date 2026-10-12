// End to end on the local Cloudflare runtime, architecture stage 2b: the WHOLE application (bundled from worker/src) in object mode with TWO businesses in ONE Worker, created through the
// shared directory. It proves each business has its own data, and attacks the boundary every way it can: a client naming another business, a validly signed session for the wrong business, a
// session with no business, a stranger, an admin without the key, and moving a member between businesses.
// Usage (from a scratch folder holding a copy of worker/ with its dependencies installed, and miniflare@4):
//   node e2e-business-object.mjs <path-to-worker-folder> <path-to-esbuild>
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
const cookieFor = (email, b) => { const p = b64u(JSON.stringify({ email, exp: Date.now() + 3600_000, ...(b ? { b } : {}) })); return { Cookie: `office_session=${p}.${b64u(crypto.createHmac("sha256", SECRET).update(p).digest())}` }; };

const mf = new Miniflare({
  modules: true, script: fs.readFileSync(out, "utf8"), compatibilityDate: "2026-07-01", compatibilityFlags: ["nodejs_compat"],
  bindings: { ADMIN_KEY: "k-admin", ADMIN_CONFIRM_KEY: "k-confirm", SESSION_SECRET: SECRET, BUSINESS_MODE: "object", ENVIRONMENT: "test", RECORD_TIMINGS: "1" },
  d1Databases: ["OFFICE_DB"], kvNamespaces: ["CUSTOMER_NOTES"], r2Buckets: ["OFFICE_VAULT"],
  durableObjects: { BUSINESS: { className: "BusinessObject", useSQLite: true }, TRIAL: { className: "TrialObject", useSQLite: true } },
});
const call = async (p, init = {}) => { const t = performance.now(); const r = await mf.dispatchFetch("http://localhost" + p, init); const text = await r.text(); let body; try { body = JSON.parse(text); } catch { body = text; } return { status: r.status, body, headers: r.headers, ms: Math.round(performance.now() - t) }; };
const results = []; const check = (ok, what, detail = "") => { results.push({ ok, what, detail }); console.log((ok ? "ok   " : "FAIL ") + what + (detail ? "  [" + detail + "]" : "")); };
const admin = { "X-Admin-Key": "k-admin" }, both = { ...admin, "X-Admin-Confirm": "k-confirm" }, json = { "Content-Type": "application/json" };
const names = (r) => (Array.isArray(r.body?.items) ? r.body.items.map((c) => c.name).sort() : null);
const upload = (rows, who) => { const boundary = "----e2e"; const body = `--${boundary}\r\nContent-Disposition: form-data; name="csv"; filename="c.csv"\r\nContent-Type: text/csv\r\n\r\nname\n${rows.join("\n")}\n\r\n--${boundary}--\r\n`; return call("/files/customers-csv-import", { method: "POST", headers: { ...who, "Content-Type": `multipart/form-data; boundary=${boundary}` }, body }); };

// ---- the Worker answers what needs no business ---------------------------------------------------------------------------------------------------------------
const health = await call("/health");
check(health.status === 200 && health.body.status === "ok", "GET /health is answered by the Worker itself");
const stranger = await call("/customers", { headers: { Origin: "https://the-office-preview.pages.dev" } });
check(stranger.status === 401 && stranger.headers.get("access-control-allow-origin") === "https://the-office-preview.pages.dev", "a stranger is refused with a JSON 401 and the CORS header, and no object is woken");

// ---- two businesses, created through the directory ---------------------------------------------------------------------------------------------------------
const onlyAdmin = await call("/debug/directory/create-business", { method: "POST", headers: { ...admin, ...json }, body: JSON.stringify({ id: "alpha-co", name: "Alpha Flooring", owner_email: "owner@alpha.co" }) });
check(onlyAdmin.status === 403, "creating a business needs BOTH admin keys (the admin key alone is refused)", `status ${onlyAdmin.status}`);
const makeA = await call("/debug/directory/create-business", { method: "POST", headers: { ...both, ...json }, body: JSON.stringify({ id: "alpha-co", name: "Alpha Flooring", owner_email: "Owner@Alpha.co" }) });
const makeB = await call("/debug/directory/create-business", { method: "POST", headers: { ...both, ...json }, body: JSON.stringify({ id: "beta-co", name: "Beta Blinds", owner_email: "owner@beta.co" }) });
check(makeA.status === 200 && makeA.body.created === true && makeA.body.ownerMembershipStatus === 200 && makeB.status === 200 && makeB.body.ownerMembershipStatus === 200, "two businesses are created, each with its owner made INSIDE its own object", `alpha ${makeA.ms} ms, beta ${makeB.ms} ms (includes creating the object)`);
const listing = await call("/debug/directory", { headers: admin });
check(listing.status === 200 && listing.body.businesses.length === 2 && listing.body.businesses.every((b) => b.members === 1) && !JSON.stringify(listing.body).includes("@"), "the directory lists both businesses with one member each and never shows an email address");
const move = await call("/debug/directory/add-member", { method: "POST", headers: { ...both, ...json }, body: JSON.stringify({ email: "owner@alpha.co", business_id: "beta-co", role: "owner" }) });
check(move.status === 400 && /already belongs to another business/.test(move.body.error), "a member already in one business cannot be added to another", move.body.error);

// ---- each business has its own data ---------------------------------------------------------------------------------------------------------------------------
const A = cookieFor("owner@alpha.co", "alpha-co"), B = cookieFor("owner@beta.co", "beta-co");
const emptyA = await call("/customers", { headers: A }), emptyB = await call("/customers", { headers: B });
check(emptyA.status === 200 && names(emptyA).length === 0 && emptyB.status === 200 && names(emptyB).length === 0, "each owner signs in to their own business, and both start empty (the owner's email was matched without regard to case)");
const importA = await upload(["Jenny Smith", "Sipho Dlamini"], A), importB = await upload(["Ben Adams"], B);
check(importA.status === 200 && importA.body.created === 2 && importB.status === 200 && importB.body.created === 1, "each business imports its own customers", `alpha ${importA.body.created}, beta ${importB.body.created}`);
const listA = await call("/customers", { headers: A }), listB = await call("/customers", { headers: B });
check(JSON.stringify(names(listA)) === JSON.stringify(["Jenny Smith", "Sipho Dlamini"]) && JSON.stringify(names(listB)) === JSON.stringify(["Ben Adams"]), "alpha sees only Jenny and Sipho; beta sees only Ben: neither can see the other's customers");

// ---- attacks on the boundary -------------------------------------------------------------------------------------------------------------------------------------
const spoof = await call("/customers", { headers: { ...A, "X-Business-Id": "beta-co" } });
check(JSON.stringify(names(spoof)) === JSON.stringify(["Jenny Smith", "Sipho Dlamini"]), "alpha's owner naming BETA in a header still gets ALPHA's data (the header is overwritten)");
const wrongB = await call("/customers", { headers: cookieFor("owner@alpha.co", "beta-co") });
check(wrongB.status === 403 || wrongB.status === 401, "a validly signed session putting alpha's owner INSIDE beta is refused (not a member there)", `status ${wrongB.status}`);
const noB = await call("/customers", { headers: cookieFor("owner@alpha.co") });
check(noB.status === 401, "a session with no business is refused", `status ${noB.status}`);
const unknown = await call("/customers", { headers: cookieFor("owner@alpha.co", "ghost-co") });
check(unknown.status === 403 || unknown.status === 401, "a session for a business that does not exist is refused (it would create an empty object, but see no data)", `status ${unknown.status}`);
const targetA = await call("/debug/customers", { headers: { ...admin, "X-Target-Business": "alpha-co" } }), targetB = await call("/debug/customers", { headers: { ...admin, "X-Target-Business": "beta-co" } });
const adminNames = (r) => (r.body.customers ?? r.body.items ?? r.body).map?.((c) => c.name).sort();
check(targetA.status === 200 && adminNames(targetA).includes("Jenny Smith") && !adminNames(targetA).includes("Ben Adams") && targetB.status === 200 && adminNames(targetB).includes("Ben Adams") && !adminNames(targetB).includes("Jenny Smith"), "an administrator names the business, and sees only that business's data");
const nameless = await call("/debug/customers", { headers: admin });
check(nameless.status === 400 && /X-Target-Business/.test(nameless.body.error), "an admin call that names no business is refused with a clear message");
const wrongKey = await call("/debug/customers", { headers: { "X-Admin-Key": "wrong", "X-Target-Business": "alpha-co" } });
check(wrongKey.status === 401, "a wrong admin key can never name a business", `status ${wrongKey.status}`);

// ---- the Worker holds no business data -------------------------------------------------------------------------------------------------------------------------
const workerD1 = await mf.getD1Database("OFFICE_DB");
const tables = (await workerD1.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'sqlite_%'").all()).results.map((t) => t.name).sort();
check(!tables.includes("customers") && !tables.includes("invoices") && !tables.includes("captures") && tables.includes("businesses") && tables.includes("directory_members"), "the Worker's own database holds only the shared layer (the directory, its audit): no customers, no invoices", `tables: ${tables.join(", ")}`);

// ---- many at once ---------------------------------------------------------------------------------------------------------------------------------------------------------
const burst = await Promise.all(Array.from({ length: 16 }, (_, i) => call("/customers", { headers: i % 2 ? A : B })));
check(burst.every((r, i) => r.status === 200 && (i % 2 ? names(r).length === 2 : names(r).length === 1)), "16 concurrent requests alternating between the two businesses each get their own business's data", `slowest ${Math.max(...burst.map((r) => r.ms))} ms`);
const checkA = await call("/debug/membership-check?email=Owner@Alpha.co", { headers: { ...admin, "X-Target-Business": "alpha-co" } }), checkB = await call("/debug/membership-check?email=owner@alpha.co", { headers: { ...admin, "X-Target-Business": "beta-co" } });
check(checkA.body.found === true && checkA.body.role === "owner" && checkA.body.status === "active" && checkB.body.found === false, "the membership check (used at sign-in) finds the owner in their own business and NOT in the other");
const timings = await call("/debug/timings", { headers: { ...admin, "X-Target-Business": "alpha-co" } });
check(timings.status === 200 && timings.body.requests >= 2, "request timings are read from a business's own object by naming it (only requests that change something are recorded: its owner's creation and the import)", `requests recorded in alpha: ${timings.body.requests}`);
const timingsNameless = await call("/debug/timings", { headers: admin });
check(timingsNameless.status === 400, "and asking for timings without naming a business is refused");
await mf.dispose();
const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `\n${failed} FAILED` : `\nall ${results.length} end-to-end checks passed`);
process.exit(failed ? 1 : 0);
