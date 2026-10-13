// A full rehearsal of moving a business, on the real local Cloudflare runtime, with SYNTHETIC data (no real customer data is involved). A D1-mode SOURCE (how production is today) is loaded with
// awkward data, then migrated over HTTP by tools/migrate-lib.mjs into a business object on an object-mode TARGET. Afterwards: fingerprints equal, the team can sign in, a new customer does not reuse
// a deleted id, the other business sees none of it, the shared stores hold only prefixed keys, the source is untouched, a second run changes nothing, and tampering is detected.
//   node migration-rehearsal.mjs <path-to-worker-folder> <path-to-esbuild>
import { Miniflare } from "miniflare";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { migrate } from "../migrate-lib.mjs";

const workerDir = path.resolve(process.argv[2]), esbuild = path.resolve(process.argv[3]);
const out = path.join(workerDir, "bundle.mjs");
execFileSync(esbuild, ["src/index.ts", "--bundle", "--format=esm", "--platform=neutral", "--conditions=workerd,worker,browser", "--main-fields=module,main", "--external:cloudflare:*", "--external:node:*", `--outfile=${out}`, "--log-level=error"], { cwd: workerDir, stdio: "inherit" });
const script = fs.readFileSync(out, "utf8"), baseline = fs.readFileSync(path.join(workerDir, "migrations", "0001_baseline.sql"), "utf8");
const SECRET = "rehearsal-secret", KEYS = { ADMIN_KEY: "k-admin", ADMIN_CONFIRM_KEY: "k-confirm" };
const mk = (extra) => new Miniflare({ modules: true, script, compatibilityDate: "2026-07-01", compatibilityFlags: ["nodejs_compat"], bindings: { ...KEYS, SESSION_SECRET: SECRET, ENVIRONMENT: "test", ...extra.bindings }, d1Databases: ["OFFICE_DB"], kvNamespaces: ["CUSTOMER_NOTES"], r2Buckets: ["OFFICE_VAULT"], ...(extra.durable ? { durableObjects: { BUSINESS: { className: "BusinessObject", useSQLite: true }, TRIAL: { className: "TrialObject", useSQLite: true } } } : {}) });
const src = mk({ bindings: {} }), tgt = mk({ bindings: { BUSINESS_MODE: "object" }, durable: true });
const results = []; const check = (ok, what, detail = "") => { results.push(ok); console.log((ok ? "ok   " : "FAIL ") + what + (detail ? "  [" + detail + "]" : "")); };
const b64u = (buf) => Buffer.from(buf).toString("base64url");
const cookie = (email, b) => { const p = b64u(JSON.stringify({ email, exp: Date.now() + 3600_000, ...(b ? { b } : {}) })); return { Cookie: `office_session=${p}.${b64u(crypto.createHmac("sha256", SECRET).update(p).digest())}` }; };
const adm = { "X-Admin-Key": "k-admin", "X-Admin-Confirm": "k-confirm" };
const json = { "Content-Type": "application/json" };
const fetchImpl = (url, init) => (new URL(url).host === "source" ? src : tgt).dispatchFetch(url, init);
const S = { base: "http://source", adminKey: "k-admin", confirmKey: "k-confirm" };
const T = { base: "http://target", adminKey: "k-admin", confirmKey: "k-confirm", business: "zulu-co" };

// ---- the source: a D1-mode business with awkward data ----------------------------------------------------------------------------------------------------------------------
const d1 = await src.getD1Database("OFFICE_DB");
const statements = baseline.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").split(";").map((s) => s.trim()).filter(Boolean);
await d1.batch(statements.map((s) => d1.prepare(s)));
const run = (sql, ...binds) => d1.prepare(sql).bind(...binds).run();
await d1.prepare("ALTER TABLE tasks ADD COLUMN priority TEXT").run();
await d1.prepare("CREATE TABLE lazy_things (id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT)").run();
const big = "x".repeat(50000);
for (const [name, address, ret] of [["O'Brien \"Big\" Dlamini", "1 Main Rd", 7.5], ["José 🙂 Ñandú", null, null], ["multi\nline\ttab", big, 0.1], ["Plain Name", "", 10], ["Deleted Soon", "x", null]]) await run("INSERT INTO customers (name, address, retention_percent) VALUES (?, ?, ?)", name, address, ret);
await run("DELETE FROM customers WHERE name = 'Deleted Soon'");
await run("INSERT INTO invoices (customer_id, description, amount, retention_amount) VALUES (1, 'floor \"A\"', 1500.5, 0), (3, 'blinds', 820, 0)");
await run("INSERT INTO payments (customer_id, amount, source_transcript, invoice_id) VALUES (1, 500.25, 'Jenny paid R500', 1)");
await run("INSERT INTO tasks (description, done, priority) VALUES ('call Jenny', 0, 'high'), ('quote ✓', 1, NULL)");
await run("INSERT INTO expenses (description, source_transcript, amount) VALUES ('fuel', 'spent R850', 850.25)");
await run("INSERT INTO lazy_things (label) VALUES ('one'), ('two')");
await run("INSERT INTO memberships (google_email, role, status) VALUES ('owner@zulu.co', 'owner', 'active'), ('sipho@zulu.co', 'installer', 'active'), ('old@zulu.co', 'installer', 'suspended')");
const kvNs = await src.getKVNamespace("CUSTOMER_NOTES"), r2 = await src.getR2Bucket("OFFICE_VAULT");
for (let i = 1; i <= 250; i++) await kvNs.put(`customer:${i}`, JSON.stringify({ id: i, note: `ZULU note ${i} 🙂 "quoted"`, n: i * 1.5 }));
for (let i = 1; i <= 130; i++) { const bytes = new Uint8Array(300 + i * 11); for (let j = 0; j < bytes.length; j++) bytes[j] = (i * 31 + j * 7) & 255; await r2.put(`${["voice-notes", "documents", "photos", "logos"][i % 4]}/file-${i}.bin`, bytes, { httpMetadata: { contentType: i % 2 ? "audio/mp4" : "image/png" } }); }
const srcFp = async () => (await (await src.dispatchFetch("http://source/admin/migration/fingerprint", { headers: adm })).json());
const sourceBefore = await srcFp();

// ---- the target: an empty business, created for a migration -----------------------------------------------------------------------------------------------------------
const made = await tgt.dispatchFetch("http://target/debug/directory/create-business", { method: "POST", headers: { ...adm, ...json }, body: JSON.stringify({ id: "zulu-co", name: "Zulu Flooring", migrating: true }) });
const madeBody = await made.json();
check(made.status === 200 && madeBody.migrating === true && madeBody.objectStatus === 200, "a business created for a migration starts completely empty (no invented owner) and its object is created at once", JSON.stringify(madeBody));

// ---- the migration ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
const report = await migrate({ source: S, target: T, fetchImpl, pageSize: 3, log: () => {} });
check(report.ok, "THE MIGRATION COMPLETES AND EVERY FINGERPRINT MATCHES", `${report.durationMs} ms; ${report.mismatches.join(" | ") || "no differences"}`);
for (const s of report.steps.filter((x) => ["source manifest", "schema", "id counters", "database done", "notes", "files", "directory", "indexes", "fingerprints compared"].includes(x.name))) console.log("       " + s.name + " " + JSON.stringify(s).slice(0, 170).replace(/^\{"name":"[^"]*",?/, "{"));

const fpT = await (await tgt.dispatchFetch("http://target/admin/migration/fingerprint", { headers: { ...adm, "X-Target-Business": "zulu-co" } })).json();
check(fpT.tables.customers.count === 4 && fpT.sequences.customers === 5 && fpT.notes.count === 250 && fpT.files.count === 130 && fpT.tables.lazy_things.count === 2 && fpT.tables.payments.count === 1, "the target holds the business's 4 customers (counter at 5), 250 notes, 130 files, the table created on first use, and the payment that references a customer (a foreign key)");
const sourceAfter = await srcFp();
const sourceAfterMigration = () => sourceAfter;
check(JSON.stringify(sourceBefore) === JSON.stringify(sourceAfter), "the SOURCE is untouched: its fingerprint is identical before and after");
const kvKeys = (await (await tgt.getKVNamespace("CUSTOMER_NOTES")).list({ limit: 1000 })).keys.map((k) => k.name);
const r2Keys = (await (await tgt.getR2Bucket("OFFICE_VAULT")).list({ limit: 1000 })).objects.map((o) => o.key);
check(kvKeys.length === 250 && kvKeys.every((k) => k.startsWith("b:zulu-co:")) && r2Keys.length === 130 && r2Keys.every((k) => k.startsWith("b/zulu-co/")), "in the shared stores the migrated notes and files sit ONLY under the business's own prefix", `${kvKeys.length} notes, ${r2Keys.length} files`);

// ---- re-running, refusing to mix, noticing damage, and healing it ---------------------------------------------------------------------------------------------------
const targetFp = async (biz = "zulu-co") => (await (await tgt.dispatchFetch("http://target/admin/migration/fingerprint", { headers: { ...adm, "X-Target-Business": biz } })).json());
const { compareFingerprints } = await import("../migrate-lib.mjs");
const settled = JSON.stringify(await targetFp());
const refuse = await migrate({ source: S, target: T, fetchImpl, pageSize: 50 });
check(!refuse.ok && /refusing to mix/.test(refuse.mismatches.join()) && JSON.stringify(await targetFp()) === settled, "pointing the migration at a target that already holds data is REFUSED, and nothing is changed");
const again = await migrate({ source: S, target: T, fetchImpl, pageSize: 50, force: true });
check(again.ok === true && JSON.stringify(await targetFp()) === settled, "a forced SECOND run succeeds and changes nothing (an interrupted migration is simply run again)", again.mismatches.join(" | "));
const damage = await tgt.dispatchFetch("http://target/admin/migration/rows", { method: "POST", headers: { ...adm, "X-Target-Business": "zulu-co", ...json }, body: JSON.stringify({ table: "customers", rows: [{ __rowid: 1, id: 1, name: "TAMPERED", vat_exempt: 0 }] }) });
const hurt = compareFingerprints(sourceAfterMigration(), await targetFp());
check(damage.status === 200 && hurt.length === 1 && /customers: same row count \(4\) but the contents differ/.test(hurt[0]), "if ONE cell in the target is altered afterwards, the fingerprint comparison notices exactly that", hurt.join(" | "));
const healed = await migrate({ source: S, target: T, fetchImpl, pageSize: 50, force: true });
check(healed.ok === true && JSON.stringify(await targetFp()) === settled, "and running the migration again HEALS it: the target is identical again");

// ---- the team can sign in, and the business works --------------------------------------------------------------------------------------------------------------------
const dir = await (await tgt.dispatchFetch("http://target/debug/directory", { headers: adm })).json();
check(dir.businesses.length === 1 && dir.businesses[0].id === "zulu-co" && dir.businesses[0].members === 2, "the two ACTIVE team members are registered in the directory (the suspended one is not), so they can sign in");
const owner = cookie("owner@zulu.co", "zulu-co");
const list = await (await tgt.dispatchFetch("http://target/customers", { headers: owner })).json();
check(list.items.length === 4 && list.items.some((c) => c.name === "José 🙂 Ñandú") && list.items.some((c) => c.name === "O'Brien \"Big\" Dlamini"), "the migrated owner signs in and sees the migrated customers, emoji and quotes intact");
const suspended = await tgt.dispatchFetch("http://target/customers", { headers: cookie("old@zulu.co", "zulu-co") });
check(suspended.status === 403 || suspended.status === 401, "the suspended member cannot get in", `status ${suspended.status}`);
const boundary = "----b"; const upload = `--${boundary}\r\nContent-Disposition: form-data; name="csv"; filename="c.csv"\r\nContent-Type: text/csv\r\n\r\nname\nBrand New\n\r\n--${boundary}--\r\n`;
const imp = await tgt.dispatchFetch("http://target/files/customers-csv-import", { method: "POST", headers: { ...owner, "Content-Type": `multipart/form-data; boundary=${boundary}` }, body: upload });
const after = await (await tgt.dispatchFetch("http://target/customers", { headers: owner })).json();
const brandNew = after.items.find((c) => c.name === "Brand New");
check(imp.status === 200 && brandNew && brandNew.id === 6, "a NEW customer gets id 6, not the deleted customer's 5 (which would have inherited that customer's old notes): the id counter moved across", `id ${brandNew?.id}`);
const note1 = await (await tgt.dispatchFetch("http://target/debug/customer-notes?customerId=1", { headers: { ...adm, "X-Target-Business": "zulu-co" } })).text();
check(note1.includes("ZULU note 1"), "a migrated note is readable through the application's own route");

// ---- another business sees none of it -----------------------------------------------------------------------------------------------------------------------------------
await tgt.dispatchFetch("http://target/debug/directory/create-business", { method: "POST", headers: { ...adm, ...json }, body: JSON.stringify({ id: "other-co", name: "Other", owner_email: "boss@other.co" }) });
const otherList = await (await tgt.dispatchFetch("http://target/customers", { headers: cookie("boss@other.co", "other-co") })).json();
const otherNote = await (await tgt.dispatchFetch("http://target/debug/customer-notes?customerId=1", { headers: { ...adm, "X-Target-Business": "other-co" } })).text();
check(otherList.items.length === 0 && !otherNote.includes("ZULU"), "ANOTHER business on the same Worker sees none of the migrated customers or notes");
const otherFp = await (await tgt.dispatchFetch("http://target/admin/migration/fingerprint", { headers: { ...adm, "X-Target-Business": "other-co" } })).json();
check(otherFp.notes.count === 0 && otherFp.files.count === 0 && otherFp.tables.customers.count === 0, "and its notes, files and customers are all empty");

await src.dispose(); await tgt.dispose();
const bad = results.filter((r) => !r).length;
console.log(bad ? `\n${bad} FAILED` : `\nall ${results.length} rehearsal checks passed`);
process.exit(bad ? 1 : 0);
