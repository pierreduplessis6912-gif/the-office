> **Status:** real. **Verified:** not yet. **Owns:** none.

# Review bundle: commit da55997 ("Object ownership: tests only")

Self-contained input for the read-only review in [HANDOFF.md](../../HANDOFF.md): the commit's actual diff and the production code it tests, so a reviewer **needs no browsing and no shell** to read the code. Generated from git at commit `da55997ccb1bc109c7802d991bfb2644f115e39b`. **It cannot give mutation evidence:** that needs a shell (see the last section). A review done from this bundle alone is PARTIAL and must say so.

## The five checks you are answering (full wording in HANDOFF.md)
1. Do the tests exercise the REAL object lifecycle? 2. Is the binding genuinely write-once, and can an ordinary request not establish, change or reset it? 3. Are missing, malformed and mismatched stored bindings covered, with exact behaviour asserted? 4. Do the tests FAIL when the protection is deliberately removed (needs a shell)? 5. Do any tests assert first-claim binding as an acceptable security contract?

**Do not treat any behaviour the commit labels OBSERVATION or "Recorded, NOT endorsed" as accepted policy.** Those are open security-contract questions for Pierre. The commit message and decision text also claim counts (40 checks, 15 identity-state checks, 6 mutations all caught); treat them as claims to verify, not facts.

## The production code under test: `worker/src/business-object.ts` `fetch` (unchanged by the commit)
````ts
186:       const claimed = request.headers.get("X-Business-Id");
187:       if (!isBusinessId(claimed)) return Response.json({ error: "no business named" }, { status: 400 });
188:       // An object is addressed by NAME (objectNameFor(business)) and the runtime tells it that name, which no request can supply. A claim that does not match is refused BEFORE anything is read, bound or written, so a request can
189:       // neither bind an unused object nor take one over merely by naming a business (a router fault would otherwise give it to the wrong business for good and lock the real one out). Where the runtime exposes no name, or not a string,
190:       // the first-claim binding below is the only protection: a deliberate fail-open so an unexpected runtime can never lock a business out; health.ts reports object.identityVisible so a real object can be checked.
191:       const ownName = (this.state.id as { name?: unknown } | undefined)?.name;
192:       const objectName = typeof ownName === "string" ? ownName : undefined;
193:       if (objectName !== undefined && objectName !== objectNameFor(claimed)) return Response.json({ error: "this object belongs to another business" }, { status: 403 });
194:       if (this.businessId === null) {
195:         const known = (await this.db.prepare("SELECT value FROM object_meta WHERE key = 'business_id'").first<{ value: string }>())?.value ?? null;
196:         if (known === null) await this.db.prepare("INSERT INTO object_meta (key, value) VALUES ('business_id', ?)").bind(claimed).run();
197:         this.businessId = known ?? claimed;
198:       }
199:       if (this.businessId !== claimed) return Response.json({ error: "this object belongs to another business" }, { status: 403 });
200:       // A failed schema step: everyone but an administrator is turned away with a clear 503 (the admin routes stay open so the failure can be seen and retried).
201:       if (this.schemaError && !isAdminPath(new URL(request.url).pathname)) {
202:         return Response.json({ error: "This business is being updated and is unavailable for a few minutes. Please try again shortly.", updating: true, retryAfterSeconds: 60 }, { status: 503, headers: { "Retry-After": "60" } });
203:       }
204:       // While a restore is running, everyone but an administrator is turned away: a half-replaced business must not be read or written.
205:       if (!isAdminPath(new URL(request.url).pathname) && (await this.db.prepare("SELECT value FROM object_meta WHERE key = 'restoring'").first<{ value: string }>())?.value === "1") {
206:         return Response.json({ error: "This business is being restored from a backup and is unavailable for a few minutes. Please try again shortly.", restoring: true, retryAfterSeconds: 60 }, { status: 503, headers: { "Retry-After": "60" } });
207:       }
208:       // The hourly job: an object that has been named arms its own alarm once (nothing runs for a business nobody has used).
209:       if (jobs && !this.alarmChecked) {
210:         const existing = await this.state.storage.getAlarm();
211:         if (existing === null) {
212:           const first = Date.now() + jitterMs(claimed) + 60_000;
213:           await this.state.storage.setAlarm(first);
214:           await this.setMeta("next_alarm_at", new Date(first).toISOString()).catch(() => undefined);
215:         } else {
216:           // An alarm armed BEFORE this was recorded (an object that was already running) is recorded now, so the health report can see when it will run. Found by the first real staging run.
217:           await this.setMeta("next_alarm_at", new Date(existing).toISOString()).catch(() => undefined);
218:         }
219:         this.alarmChecked = true;
220:       }
221:       // The notes store, the file storage and the memory index are shared by every business, so each is confined to this business (scoped-bindings.ts).
222:       const objectEnv = scopeBindings({ ...this.env, OFFICE_DB: this.db as unknown as D1Database, SHARED_DB: this.env.OFFICE_DB, BUSINESS_ID: claimed, RETRY_SCHEMA: () => this.retrySchema() } as Env, claimed);
223:       objectEnv.OBJECT_NAME = objectName;   // set on the scoped result, so the pinned scopeBindings(...) expression above (scoped-bindings.test.js) stays exactly as it was
224:       const ctx = { waitUntil: (p: Promise<unknown>) => this.state.waitUntil(p), passThroughOnException: () => undefined } as unknown as ExecutionContext;
225:       return serve(request, objectEnv, ctx);
226:     }
227:   };
228: }
````

Naming and validation (`worker/src/directory.ts`):
````ts
11:export const BUSINESS_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
12:export const isBusinessId = (value: unknown): value is string => typeof value === "string" && BUSINESS_ID_PATTERN.test(value);
13:export const objectNameFor = (businessId: string): string => `business-${businessId}`;
79:    return row && isBusinessId(row.business_id) ? { businessId: row.business_id, trialEndsAt: row.trial_ends_at ?? null, selfStarted: row.source === "signup" } : null;
94:    return row && isBusinessId(row.id) ? { businessId: row.id, name: row.name, endedAt: row.ended } : null;
111:    if (!row || !isBusinessId(row.id)) return null;
````

## The complete diff of the commit (tests, runner, kit, decision record)
````diff
diff --git a/DECISIONS.md b/DECISIONS.md
index 9d802ed..d35e6af 100644
--- a/DECISIONS.md
+++ b/DECISIONS.md
@@ -310,3 +310,4 @@ Split on 2026-10-24 from the 7958-line original, which is `git show 95bf743:DECI
 - [Engine tenant isolation and the ownership boundary: what is tested, and what is not (2026-11-02)](docs/decisions/engine-foundation.md) (new)
 - [Recovery hardening: the snapshot manifest is validated before anything acts on it (2026-11-02, Task 4 item 1)](docs/decisions/engine-foundation.md) (new)
 - [Real-object re-proof of the restore-verification fix (2026-11-02, Task 4 item 2)](docs/decisions/engine-foundation.md) (new)
+\n- [Object ownership: how it is established, what is pinned, and what is recorded but not endorsed (2026-11-03)](docs/decisions/engine-foundation.md) (new)\n
\ No newline at end of file
diff --git a/docs/decisions/engine-foundation.md b/docs/decisions/engine-foundation.md
index 36f0c3d..b26fb4e 100644
--- a/docs/decisions/engine-foundation.md
+++ b/docs/decisions/engine-foundation.md
@@ -166,3 +166,16 @@ One table of about 110-byte rows, Node, 2026-11-02: restore peaked at 37.5 MB he
 **The results, read from the committed records (`ops/staging-restore-proof-last.json`, two versions):** run on commit `843e67e` (record `f76aea0`; that commit's CI was green, 9,272 of 9,272 default and 9,275 of 9,275 Durable Object) and again on `b985ace` (record `8aa16b1`). In both, every check is true: the restore returned HTTP 200 with `ok: true` and `differences: []`, the exact check that failed on 2026-11-02; `customers` held 101 rows before and after; the probe column was on the real object before the restore (so the run was not vacuous) and after; nothing pending after the retry; the engine came back exactly and verified clean; and **every existing real snapshot validated: 14 of 14 on `staging-co` and 14 of 14 on `staging-two`, 0 unreadable**, including those written by months of older code. At both commits `worker/src` is byte-identical to the validated code (`e17e536`, checked by `git diff`). The second run's own CI (`b985ace`) had one failing check, in the new tooling's behaviour tests and not in `worker/src`, so the first run, on a green commit, is the primary evidence.
 **How this reached the branch, stated plainly:** several attempts at this work ran in sequence in one shared working tree (the first staging attempt, run 41587913275, is reported in commit `843e67e` to have failed in part 2 before recording anything; that report was not independently checked). The breakage script mutates sources in place, and a mutated line in `backup.ts` (the SHA-256 format check removed from `validateManifest`) was committed by mistake in `2d29635` and repaired in `243b3fa`, AFTER both staging runs; `worker/src` at the head is identical to the validated code. Nothing was lost, but it is a real hazard: see the handover rule about running the breakage script.
 **Not proven, even now:** PRODUCTION (merging deploys the validator there; production's real manifests have not been checked against it); the memory margin at size (the sample is small; the ramp was not approved or run); the verification's sensitivity on a real object (proven on the harness with controls); the recovery gate, which needs the owner's acceptance.
+
+
+## Object ownership: how it is established, what is pinned, and what is recorded but not endorsed (2026-11-03)
+**The principle (from the review of 2026-11-03):** provisioning CREATES identity, requests EXERCISE it, verification CONFIRMS it, and the three must not become interchangeable. The same applies to any future child object or storage partition: a newly provisioned object must not decide for itself which business owns it merely because a request supplied a business id.
+**The lifecycle, from the code:** a business object is BOUND when its `object_meta` table holds a `business_id` row (cached as `this.businessId`); the binding is written once, by a plain `INSERT`, by the FIRST request that carries a valid `X-Business-Id`, before authentication and before anything but the runtime-name check. Both ways a business comes to exist create the directory row in the Worker's own database FIRST and then make an admin-keyed call into the object: the admin create-business route makes one `create-membership` call (or a `GET /health` for a migration target); sign-up makes four, the first of which, a READ-ONLY `membership-check`, is the request that binds. Every request reaches an object only through `idFromName(objectNameFor(id))`, so the runtime name is `business-<id>` by construction; Cloudflare documents `ctx.id.name` for that addressing (changelog 2026-03-15; it is undefined for `newUniqueId()`, `idFromString()` and names over 1,024 bytes).
+**Pinned as INVARIANTS (tests, with breakage mutations):**
+- STATIC (parsed from the source): the key is named in exactly three statements, all in `business-object.ts` (two reads and one plain `INSERT` that cannot overwrite); nothing anywhere updates or deletes `object_meta`; every other write to it is a keyed upsert; every meta-writer call (at least 15 are asserted) passes a literal key and none passes `business_id`; `object_meta` is in `SKIP_TABLES`, so snapshots, restore, fingerprints and the migration routes cannot touch it.
+- RESTORE leaves the binding exactly as it was. On a REAL object, requests of every shape (the same claim, another business, with the admin keys, malformed, uppercase, missing, a lone target header) cannot create, change or reset it, with and without a runtime name; the alarm never binds.
+- PROVISIONING, both paths, against real objects with a call log: the directory row exists before the object's first request, which carries the admin key and the server-derived id; the object ends bound to exactly that business under exactly `business-<id>`; a repeat leaves the binding unchanged; another business's claim is refused.
+- Fail-CLOSED states: a MALFORMED stored value (empty, wrong shape, uppercase, padded) refuses every valid claim, rewrites nothing, and makes the alarm run no job and no backup while recording why; a MISMATCHED binding (stored alpha-co, runtime name business-beta-co) refuses both claims (alpha by the name check, beta by the binding check). Without a runtime name the stored binding is the only authority.
+**Recorded, NOT endorsed (labelled OBSERVATION in the tests; each departs from the principle):** (1) an ordinary request still establishes ownership of an unbound object, where only authenticated provisioning should; (2) with no runtime name, an object whose binding row is gone is re-bound by the next valid claim, whichever business that is (with a name, only the matching business can re-bind it); (3) the hourly alarm checks only the stored binding, never the runtime name; (4) an UNAUTHENTICATED key naming a business that is not in the directory is refused yet creates and binds an object for it; (5) the object's first request in sign-up is read-only and still binds. Pinning these documents them without making them contracts: a change that closes one is expected and the test should then be updated.
+**Evidence:** `tools/object-binding.test.js` (40 checks), 15 identity-state checks added to `tools/business-object.test.js` (89 in all), 6 breakage mutations, all caught in a selective run of the copy-based runner; no production source was changed. **Still open, and not decided here:** whether binding should be reachable ONLY through authenticated, directory-verified provisioning, and whether a name mismatch on a bound object should refuse (today) or be reported; the authenticated post-deployment health gate (designed in the review, not built); the staging rehearsal of that gate and of a rollback across migration `0004`; production's runtime name exposure and production's manifests (both unread); the recovery gate.
+\n
\ No newline at end of file
diff --git a/tools/business-object.test.js b/tools/business-object.test.js
index aaf348e..94a5d9a 100644
--- a/tools/business-object.test.js
+++ b/tools/business-object.test.js
@@ -86,6 +86,47 @@ async function businessObjectTests({ check, srcDir }) {
   const dbI = new DatabaseSync(':memory:'); const I = makeState(dbI); I.state.id = { name: 42 };
   check((await new Business(I.state, workerEnv).fetch(named('alpha-co'))).status === 200 && boundTo(dbI) === 'alpha-co', 'KNOWN LIMITATION: a name that is not a string is treated as not exposed (fail-open), never as a mismatch, so an unexpected runtime shape cannot lock a business out');
 
+  // ---- the STATES the stored identity can be in (Task: pin the exact refusal behaviour; the review of 2026-11-03) ---------------------------------------------------------------------------------------------------------
+  // Each is what the code does TODAY. Where today's behaviour is fail-closed it is pinned as an invariant; where it is not what the ownership principle wants (only authenticated provisioning should create ownership), it is labelled OBSERVATION: recorded, not endorsed.
+  const sjobs = (ranBy, backups) => ({ consolidate: async (e) => { ranBy.push(e.BUSINESS_ID); }, backup: async (e) => { backups.push(e.BUSINESS_ID); } });
+  const woke = async (name, jobsRan, backupsRan, db = new DatabaseSync(':memory:'), st = null) => {
+    const state = st || makeState(db); if (name && !st) state.state.id = { name };
+    const Cls = bo.makeBusinessObject(serve, sjobs(jobsRan, backupsRan)); const obj = new Cls(state.state, { ...workerEnv, BACKUPS: {} }); await obj.ready;
+    return { db, state, Cls, obj, again: async () => { const o = new Cls(state.state, { ...workerEnv, BACKUPS: {} }); await o.ready; return o; } };
+  };
+  const bindingOf = (db) => db.prepare("SELECT value FROM object_meta WHERE key = 'business_id'").get()?.value ?? null;
+  const unseen = () => seen.length;
+
+  // MISSING: the row is gone from an object that holds a business
+  { const ran = [], bk = []; const x = await woke(null, ran, bk); await x.obj.fetch(named('alpha-co')); x.db.exec("DELETE FROM object_meta WHERE key = 'business_id'");
+    const o2 = await x.again(), r = await o2.fetch(named('beta-co'));
+    check(r.status === 200 && bindingOf(x.db) === 'beta-co', 'OBSERVATION (recorded, NOT endorsed: only authenticated provisioning should create ownership): with no runtime name, an object whose binding row is gone is re-bound by the NEXT valid claim, whichever business that is (here alpha-co\'s object became beta-co\'s)'); }
+  { const ran = [], bk = []; const x = await woke('business-alpha-co', ran, bk); await x.obj.fetch(named('alpha-co')); x.db.exec("DELETE FROM object_meta WHERE key = 'business_id'");
+    const o2 = await x.again(), wrong = await o2.fetch(named('beta-co')), right = await o2.fetch(named('alpha-co'));
+    check(wrong.status === 403 && right.status === 200 && bindingOf(x.db) === 'alpha-co', 'MISSING binding WITH a runtime name: a claim for another business is refused, and the object can only be re-bound to the business its own name says: the name constrains re-binding'); }
+
+  // MALFORMED: a stored value that is not a business id (never validated on the way in, so it fails CLOSED: nobody is served and nothing is rewritten)
+  for (const bad of ['', 'NOT A BUSINESS', 'Alpha-Co', ' alpha-co', 'a']) {
+    const ran = [], bk = []; const x = await woke(null, ran, bk); await x.obj.ready;
+    x.db.prepare("INSERT INTO object_meta (key, value) VALUES ('business_id', ?)").run(bad);
+    const o2 = await x.again(), before = unseen(), r1 = await o2.fetch(named('alpha-co')), r2 = await o2.fetch(named('beta-co'));
+    check(r1.status === 403 && r2.status === 403 && unseen() === before && bindingOf(x.db) === bad, `MALFORMED stored binding ${JSON.stringify(bad)}: EVERY valid claim is refused 403, nothing reaches the pipeline, and the row is left exactly as it was (fail-closed, not repaired)`);
+    await o2.alarm();
+    const skipped = x.db.prepare("SELECT value FROM object_meta WHERE key = 'backup_skipped'").get()?.value || '';
+    check(ran.length === 0 && bk.length === 0 && /does not know its business/.test(skipped) && x.state.alarmSets() >= 1, `MALFORMED stored binding ${JSON.stringify(bad)}: the alarm runs NO job and NO backup, records WHY (the object does not know its business's name), and still arms the next alarm`);
+  }
+
+  // MISMATCHED: a stored binding that disagrees with the runtime name
+  { const ran = [], bk = []; const x = await woke(null, ran, bk); await x.obj.fetch(named('alpha-co'));   // bound to alpha-co with no name known
+    const named2 = makeState(x.db); named2.state.id = { name: 'business-beta-co' };               // the same storage, now woken under a name that does not match the binding
+    const o2 = await woke('business-beta-co', ran, bk, x.db, named2).then((y) => y.obj);
+    const a = await o2.fetch(named('alpha-co')), b = await o2.fetch(named('beta-co'));
+    check(a.status === 403 && b.status === 403 && bindingOf(x.db) === 'alpha-co', 'MISMATCHED (bound to alpha-co, runtime name business-beta-co): a claim for alpha-co is refused by the NAME check, a claim for beta-co by the BINDING check, and the binding is untouched: the object serves nobody');
+    const blind = await woke(null, ran, bk, x.db, makeState(x.db)); const c = await blind.obj.fetch(named('alpha-co'));
+    check(c.status === 200 && bindingOf(x.db) === 'alpha-co', 'MISMATCHED, but the runtime exposes no name: the stored binding is the only authority and the object serves alpha-co (the name witness is absent, so there is nothing to disagree with)');
+    ran.length = 0; await o2.alarm();
+    check(ran.length === 1 && ran[0] === 'alpha-co', 'OBSERVATION (recorded, NOT endorsed): the hourly alarm checks only the STORED binding, never the runtime name, so an object whose name disagrees with its binding still runs its job for the stored business'); }
+
   // ---- a second wake ---------------------------------------------------------------------------------------------------------------------------
   const again = await bo.ensureObjectSchema(objA.db, workerEnv);
   check(again.appliedBaseline === false && again.indexes.created.length === 0 && dbA.prepare('SELECT COUNT(*) AS n FROM customers').get().n === 1, 'a second wake does not redo the baseline, creates no index twice, and keeps the data');
diff --git a/tools/engine-breakage.js b/tools/engine-breakage.js
index 30e66a7..9c460b2 100644
--- a/tools/engine-breakage.js
+++ b/tools/engine-breakage.js
@@ -7,7 +7,7 @@ const { parseArgs, select } = require('./breakage-select.js');
 const sourceRoot = path.join(__dirname, '..');
 let root = sourceRoot;   // becomes the isolated copy before anything is edited or run
 const E = (f) => `worker/src/engine/${f}`, CONTRACT = 'worker/src/capability-contract.ts', MIG = 'worker/migrations/0004_engine_foundation.sql';
-const RPROOF = 'restore-proof.test.js', MANI = 'backup-manifest.test.js', STID = 'staging-identity.test.js', OBJ = 'business-object.standalone.js', ISOL = 'engine-isolation.test.js', OWN = 'engine-ownership.test.js', INTEG = 'engine-integrity.test.js', ADDCOL = 'restore-added-column.test.js', ADMIN = 'engine-admin.test.js', LEDGER = 'engine-ledger.test.js', OPS = 'engine-operations.test.js', BOUNDARY = 'engine-boundary.test.js', SCHEMA = 'engine-schema.test.js';
+const OBIND = 'object-binding.test.js', RPROOF = 'restore-proof.test.js', MANI = 'backup-manifest.test.js', STID = 'staging-identity.test.js', OBJ = 'business-object.standalone.js', ISOL = 'engine-isolation.test.js', OWN = 'engine-ownership.test.js', INTEG = 'engine-integrity.test.js', ADDCOL = 'restore-added-column.test.js', ADMIN = 'engine-admin.test.js', LEDGER = 'engine-ledger.test.js', OPS = 'engine-operations.test.js', BOUNDARY = 'engine-boundary.test.js', SCHEMA = 'engine-schema.test.js';
 
 const MUTATIONS = [
   // money: exact integer arithmetic
@@ -122,6 +122,13 @@ const MUTATIONS = [
   { name: 'restore proof: the regenerated tracked files are no longer put back before the rebase (the silent push race)', suite: RPROOF, file: '.github/workflows/staging.yml', find: '          git checkout -- worker/src/schema-steps.ts worker/src/baseline-sql.ts\n          git add ops/staging-restore-proof-last.json', replace: '          git add ops/staging-restore-proof-last.json' },
   { name: 'restore proof: the push is attempted once, with no retry', suite: RPROOF, file: '.github/workflows/staging.yml', find: 'for attempt in 1 2 3; do', replace: 'for attempt in 1; do' },
   { name: 'restore proof: a successful push is no longer recorded as success', suite: RPROOF, file: '.github/workflows/staging.yml', find: '&& { PUSHRC=0; break; }', replace: '&& { break; }' },
+  // who may establish and change a business object's ownership (object-binding.test.js, and the identity states in business-object.test.js)
+  { name: 'object binding: the binding\'s write becomes an upsert that can overwrite', suite: OBIND, file: 'worker/src/business-object.ts', find: 'INSERT INTO object_meta (key, value) VALUES (\'business_id\', ?)")', replace: 'INSERT INTO object_meta (key, value) VALUES (\'business_id\', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")' },
+  { name: 'object binding: object_meta is no longer excluded from snapshots, restore and migration', suite: OBIND, file: 'worker/src/migration.ts', find: '"admin_audit", "object_meta", ', replace: '"admin_audit", ' },
+  { name: 'object binding: a meta-writer is given the binding key (a request path could now rewrite ownership)', suite: OBIND, file: 'worker/src/business-object.ts', find: 'this.alarmChecked = true;', replace: 'this.alarmChecked = true; await this.setMeta("business_id", claimed);' },
+  { name: 'object binding: the Worker\'s own call into a new object names the wrong business', suite: OBIND, file: 'worker/src/routing.ts', find: 'const headers: Record<string, string> = { "X-Business-Id": businessId, "X-Admin-Key": env.ADMIN_KEY };', replace: 'const headers: Record<string, string> = { "X-Business-Id": "wrong-co", "X-Admin-Key": env.ADMIN_KEY };' },
+  { name: 'object binding: sign-up no longer creates the directory row before the object\'s first request', suite: OBIND, file: 'worker/src/signup.ts', find: 'if (!resume) await createBusiness(env, id, named.name, TRIAL_PLAN.name, { status: "pending", trialEndsAt: sqlTime(trialEnd), source: "signup" });', replace: '' },
+  { name: 'object binding: a malformed stored binding is silently repaired by the next claim', suite: OBJ, file: 'worker/src/business-object.ts', find: 'this.businessId = known ?? claimed;', replace: 'this.businessId = isBusinessId(known) ? known : claimed;' },
   // the admin routes (privileged: they can put a business into engine mode)
   { name: 'admin: provisioning exists on a deployment that is not a rehearsal', suite: ADMIN, file: E('admin.ts'), find: 'if (env.ENGINE_REHEARSAL !== "1") return bad("this route exists only on a rehearsal deployment", 404);', replace: '/* mutation: no rehearsal flag */' },
   { name: 'admin: provisioning without the business id as confirmation', suite: ADMIN, file: E('admin.ts'), find: 'if (!body || body.confirm !== env.BUSINESS_ID) return bad("confirm must be the business id", 400);', replace: '/* mutation: no confirmation */' },
diff --git a/tools/engine-kit.js b/tools/engine-kit.js
index 1fca324..a2198f8 100644
--- a/tools/engine-kit.js
+++ b/tools/engine-kit.js
@@ -142,19 +142,34 @@ const plain = plainRow;
     const storage = { sql, transactionSync(fn) { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } }, getAlarm: async () => alarmAt, setAlarm: async (t) => { alarmAt = t; alarmSets++; } };
     return { state: { storage, blockConcurrencyWhile: (fn) => fn(), waitUntil: (p) => waited.push(p) }, waited, alarm: () => alarmAt, alarmSets: () => alarmSets };
   };
-async function makeFleet({ ids = ['alpha-co', 'beta-co'], exposeIdentity = true } = {}) {
+// directory: give the Worker a real shared directory (and the confirm key privileged admin routes need), so sign-up and create-business run for real. autoWake: an object is woken under its real name the first time it is addressed (an unknown business id gets an object too, as on the real platform).
+// Every call into an object is recorded in `calls` (name, claim, method, path, whether an admin key was sent, and whether the directory had a row for that business AT THAT MOMENT), which is what lets a test check provisioning ORDER.
+async function makeFleet({ ids = ['alpha-co', 'beta-co'], exposeIdentity = true, directory = false, autoWake = false } = {}) {
   const fns = await buildHandler(), mod = fns.mod;
   const env = { BUSINESS_MODE: 'object', SESSION_SECRET: 'fleet-secret', ADMIN_KEY: 'fleet-admin', METER_USAGE: '0' };
   const objects = {}, raws = {}; let misroute = null;
   // forwardToBusiness calls namespace.get(namespace.idFromName(name), { locationHint }).fetch(request); misroute(name) lets a test send a request to the WRONG object on purpose
-  env.BUSINESS = { idFromName: (name) => ({ name }), get: (id) => ({ fetch: (req) => objects[misroute ? misroute(id.name) : id.name].fetch(req) }) };
+  let dirRaw = null; const calls = [];
+  if (directory) {
+    dirRaw = new DatabaseSync(':memory:');
+    env.OFFICE_DB = { prepare: (sql) => { const st = (binds) => ({ bind: (...b) => st(b), first: async () => dirRaw.prepare(sql).get(...binds) ?? null, all: async () => ({ results: dirRaw.prepare(sql).all(...binds) }), run: async () => dirRaw.prepare(sql).run(...binds) }); return st([]); } };
+    env.ADMIN_CONFIRM_KEY = 'fleet-confirm'; env.PLAN_CACHE_SECONDS = '0';
+  }
+  const directoryHas = (id) => { if (!dirRaw) return null; try { return Boolean(dirRaw.prepare('SELECT 1 FROM businesses WHERE id = ?').get(id)); } catch { return false; } };   // false before the directory exists at all
+  // the Worker calls stub.fetch(request) when it forwards and stub.fetch(url, init) for its own internal calls (callBusiness): both shapes are accepted, as on the real platform
+  env.BUSINESS = { idFromName: (name) => ({ name }), get: (id) => ({ fetch: async (input, init) => {
+    const name = misroute ? misroute(id.name) : id.name, req = input instanceof Request ? input : new Request(input, init);
+    calls.push({ name, claim: req.headers.get('X-Business-Id'), method: req.method, path: new URL(req.url).pathname, adminKey: req.headers.has('X-Admin-Key'), directoryHasRow: directoryHas(id.name.replace(/^business-/, '')) });
+    if (!objects[name] && autoWake) await wake(name.replace(/^business-/, ''));
+    return objects[name].fetch(req);
+  } }) };
   const ctx = { waitUntil() {}, passThroughOnException() {} };
   const wake = async (b) => { const raw = new DatabaseSync(':memory:'); const st = makeDoState(raw); if (exposeIdentity) st.state.id = { name: 'business-' + b };   // what the runtime tells an object about the name it was addressed by (exposeIdentity: false simulates a runtime that tells it nothing)
     const o = new mod.BusinessObject(st.state, env); await o.ready; objects['business-' + b] = o; raws[b] = raw; return o; };
   for (const b of ids) await wake(b);
   const url = (p) => 'https://office.example' + p;
   return {
-    env, mod, auth: fns.auth, objects, raws, wake, ctx,
+    env, mod, auth: fns.auth, objects, raws, wake, ctx, calls, directoryRaw: dirRaw,
     setMisroute: (fn) => { misroute = fn; },
     db: (b) => objects['business-' + b].db,   // the object's own database, in the D1 shape the engine uses
     token: (email, b) => fns.auth.signSession(env, email, b),
diff --git a/tools/object-binding.test.js b/tools/object-binding.test.js
new file mode 100644
index 0000000..eed2aa1
--- /dev/null
+++ b/tools/object-binding.test.js
@@ -0,0 +1,132 @@
+// OWNERSHIP OF A BUSINESS OBJECT: who may establish it, and that nothing ordinary can change it (worker/src/business-object.ts; branch engine-phase1). TESTS ONLY: no source file was changed for them.
+// THE PRINCIPLE (from the review of 2026-11-03): provisioning CREATES identity, requests EXERCISE it, verification CONFIRMS it, and the three must not become interchangeable. This suite pins what is true today about the first two and records, without endorsing it,
+// what is not yet the principle: an ordinary request can still establish ownership of an unbound object (the first valid claim), where the principle says only authenticated provisioning should.
+//   STATIC     the stored binding (the object_meta row `business_id`) is written in exactly one place, by a plain INSERT that cannot overwrite; nothing updates or deletes it; no meta-writer is ever given its key or a dynamic key; and the table is excluded from snapshots, restore and migration.
+//   RESTORE    a restore leaves the binding exactly as it was.
+//   REQUESTS   on a REAL object, requests of every shape (same claim, another business, malformed, missing, with admin keys) cannot create, change or reset the binding; the alarm never binds. With a runtime name and without one.
+//   PROVISIONING both ways a business comes to exist (the admin create-business route and sign-up) create the directory row FIRST, then bind the object by an admin-keyed call, and the object ends bound to exactly that business under exactly that name.
+// WHAT IS PINNED AS A KNOWN BEHAVIOUR, NOT A CONTRACT (each says so): an unauthenticated key naming an unknown business still creates and binds an object for it.
+// Not here: the object-level states (a missing, malformed or mismatched stored binding, and the alarm), which are in tools/business-object.test.js beside the rest of the object contract.
+const fs = require('fs'), path = require('path');
+const kit = require('./engine-kit.js');
+const ts = require(require.resolve('typescript', { paths: [kit.workerDir, path.join(kit.workerDir, 'node_modules')] }));
+
+module.exports = kit.guard('object binding', async ({ check }) => {
+  // ======================================================================================================================================================================================================================
+  // STATIC: parsed with TypeScript's own parser, so comments never count
+  // ======================================================================================================================================================================================================================
+  const SRC = path.join(kit.workerDir, 'src');
+  const listTs = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? listTs(path.join(dir, e.name)) : e.name.endsWith('.ts') ? [path.join(dir, e.name)] : []));
+  const GENERATED = new Set(['schema-steps.ts', 'baseline-sql.ts']);
+  const info = {};   // file -> { strings: [text], metaCalls: [{ key: string|null }] }
+  for (const file of listTs(SRC)) {
+    const rel = path.relative(SRC, file).split(path.sep).join('/'); if (GENERATED.has(rel)) continue;
+    const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true), f = { strings: [], metaCalls: [], skipTables: null };
+    const lit = (n) => n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n));
+    const visit = (n) => {
+      if (lit(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) f.strings.push(n.text);
+      if (ts.isCallExpression(n)) {
+        const callee = ts.isIdentifier(n.expression) ? n.expression.text : ts.isPropertyAccessExpression(n.expression) ? n.expression.name.text : null;
+        if (callee === 'setMeta') { const a = n.arguments.slice(0, 2).find(lit); f.metaCalls.push({ key: a ? a.text : null }); }   // setMeta(key, value) or setMeta(env, key, value): the key is the first string literal; null means a key that is not a literal
+      }
+      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === 'SKIP_TABLES' && n.initializer && ts.isNewExpression(n.initializer) && n.initializer.arguments && n.initializer.arguments[0] && ts.isArrayLiteralExpression(n.initializer.arguments[0])) f.skipTables = n.initializer.arguments[0].elements.filter(lit).map((e) => e.text);
+      ts.forEachChild(n, visit);
+    };
+    visit(sf); info[rel] = f;
+  }
+  check(Object.keys(info).length > 60 && info['business-object.ts'], `FIXTURE: ${Object.keys(info).length} source files parsed`);
+  const stmts = (re) => Object.entries(info).flatMap(([file, f]) => f.strings.filter((s) => re.test(s)).map((s) => ({ file, s })));
+
+  const keyed = stmts(/object_meta/).filter(({ s }) => /business_id/.test(s));
+  const verbs = keyed.map(({ file, s }) => `${file} ${/^\s*INSERT/i.test(s) ? 'INSERT' : /^\s*SELECT/i.test(s) ? 'SELECT' : 'OTHER'}${/ON CONFLICT/i.test(s) ? ' (upsert)' : ''}`).sort();
+  check(JSON.stringify(verbs) === JSON.stringify(['business-object.ts INSERT', 'business-object.ts SELECT', 'business-object.ts SELECT']), `STATIC: the key business_id is named in exactly three statements, all in business-object.ts: two reads and ONE plain INSERT that cannot overwrite (an upsert would be listed as such) [${verbs.join('; ')}]`);
+  check(stmts(/(UPDATE|DELETE\s+FROM)\s+object_meta/i).length === 0, 'STATIC: no statement anywhere in production code updates or deletes object_meta, so the binding can be written once and never changed or reset by application code');
+  const inserts = stmts(/INSERT[^;]*INTO\s+object_meta/i).filter(({ s }) => !/business_id/.test(s));
+  check(inserts.length >= 3 && inserts.every(({ s }) => /ON CONFLICT/i.test(s)), `STATIC: every OTHER write to object_meta is a keyed upsert (${inserts.length} of them), so the only writer that has no conflict clause is the binding's own`);
+  const calls = Object.entries(info).flatMap(([file, f]) => f.metaCalls.map((c) => ({ file, ...c })));
+  check(calls.length >= 15 && calls.every((c) => c.key !== null), `STATIC: all ${calls.length} calls of a meta-writer pass a LITERAL key, so no request can choose which key is written`);
+  check(!calls.some((c) => c.key === 'business_id'), 'STATIC: and none of them passes business_id');
+  const skip = Object.values(info).map((f) => f.skipTables).find(Boolean);
+  check(Array.isArray(skip) && skip.includes('object_meta'), 'STATIC: object_meta is in SKIP_TABLES, the list snapshots, restore, fingerprints and the migration routes all respect: none of them can copy, wipe or overwrite the binding');
+
+  // ======================================================================================================================================================================================================================
+  // RESTORE: the binding is untouched
+  // ======================================================================================================================================================================================================================
+  const bk = kit.bundle('backup.ts', 'backup');
+  const w = kit.makeWorld({ backups: true });
+  w.db.prepare("INSERT OR REPLACE INTO object_meta (key, value) VALUES ('business_id', 'eng-a')").run();
+  for (let i = 1; i <= 4; i++) w.db.prepare('INSERT INTO customers (name, address) VALUES (?, ?)').run('C' + i, 'S' + i);
+  const snap = await bk.takeSnapshot(w.env, new Date('2026-11-03T03:00:00Z'));
+  check(!snap.tables.some((t) => t.name === 'object_meta'), 'RESTORE: a snapshot does not contain object_meta at all');
+  w.db.prepare("INSERT INTO customers (name) VALUES ('DAMAGE')").run();
+  const rep = await bk.restoreSnapshot(w.env, snap.name, 'eng-a');
+  const row = () => w.db.prepare("SELECT value FROM object_meta WHERE key = 'business_id'").get();
+  check(rep.ok === true && w.db.prepare("SELECT COUNT(*) AS n FROM customers WHERE name = 'DAMAGE'").get().n === 0 && row() && row().value === 'eng-a', 'RESTORE: a restore replaces the business\'s data and leaves the binding exactly as it was');
+
+  // ======================================================================================================================================================================================================================
+  // REQUESTS: what ordinary requests can do to a bound object, on a REAL object, with and without a runtime name
+  // ======================================================================================================================================================================================================
+  const hdr = (claim, extra = {}) => ({ headers: { ...(claim === undefined ? {} : { 'X-Business-Id': claim }), ...extra } });
+  for (const exposeIdentity of [true, false]) {
+    const f = await kit.makeFleet({ ids: ['alpha-co', 'beta-co'], exposeIdentity });
+    const bound = (b) => f.raws[b].prepare("SELECT value FROM object_meta WHERE key = 'business_id'").get()?.value ?? null;
+    const label = exposeIdentity ? 'with a runtime name' : 'WITHOUT a runtime name (the binding layer alone)';
+    check((await f.direct('alpha-co', '/health', hdr('alpha-co'))).status === 200 && bound('alpha-co') === 'alpha-co', `REQUESTS (${label}): the first valid claim binds the object`);
+    const probes = [['the same claim again', 'alpha-co', {}, 200], ['another business', 'beta-co', {}, 403], ['another business, with the admin keys', 'beta-co', { 'X-Admin-Key': 'fleet-admin', 'X-Admin-Confirm': 'fleet-confirm' }, 403], ['a claim that is not a business id', 'NOT a business!', {}, 400], ['an uppercase claim', 'ALPHA-CO', {}, 400], ['no claim at all', undefined, {}, 400], ['only a target header', undefined, { 'X-Target-Business': 'beta-co' }, 400]];
+    for (const [what, claim, extra, status] of probes) {
+      const r = await f.direct('alpha-co', '/health', hdr(claim, extra));
+      check(r.status === status && bound('alpha-co') === 'alpha-co', `REQUESTS (${label}): ${what}: answered ${r.status}${r.status === status ? '' : ' (expected ' + status + ')'} and the binding is still alpha-co`);
+    }
+    check(bound('beta-co') === null, `REQUESTS (${label}): the other object, never named, is still unbound: nothing sent to alpha's object reached it`);
+    // the alarm acts for a bound business but can never create ownership
+    const woken = await f.wake('delta-co'); await woken.alarm();
+    check(bound('delta-co') === null, `REQUESTS (${label}): the hourly alarm firing on an object nobody has named does NOT bind it`);
+  }
+
+  // ======================================================================================================================================================================================================================
+  // PROVISIONING: both ways a business comes to exist, against REAL objects, with the call log checking ORDER
+  // ======================================================================================================================================================================================================================
+  const admin = (f, p, body) => f.front(p, { method: 'POST', headers: { 'X-Admin-Key': 'fleet-admin', 'X-Admin-Confirm': 'fleet-confirm', 'content-type': 'application/json' }, body: JSON.stringify(body) });
+  const prov = await kit.makeFleet({ ids: [], directory: true, autoWake: true });
+  const boundOf = (f, b) => f.raws[b] ? f.raws[b].prepare("SELECT value FROM object_meta WHERE key = 'business_id'").get()?.value ?? null : undefined;
+  const firstCall = (f, name) => f.calls.find((c) => c.name === name);
+
+  const made = await admin(prov, '/debug/directory/create-business', { id: 'prov-co', name: 'Prov Co', owner_email: 'owner@prov.example' });
+  const first = firstCall(prov, 'business-prov-co');
+  check(made.status === 200 && first && first.adminKey && first.directoryHasRow === true, `PROVISIONING (admin create-business): the directory row exists BEFORE the object's first request, and that first request carries the admin key (${made.status}; first call: ${first && first.method} ${first && first.path}, directory row: ${first && first.directoryHasRow})`);
+  check(boundOf(prov, 'prov-co') === 'prov-co' && prov.objects['business-prov-co'].state.id.name === 'business-prov-co' && first.claim === 'prov-co', 'PROVISIONING (admin create-business): the object ends bound to exactly that business, under exactly the name business-<id>, and the claim of the first request was that business');
+  const intruder = await prov.direct('prov-co', '/health', hdr('someone-else'));
+  check(intruder.status === 403 && boundOf(prov, 'prov-co') === 'prov-co', 'PROVISIONING (admin create-business): once provisioned, a request naming another business is refused and the binding stands');
+  const again = await admin(prov, '/debug/directory/create-business', { id: 'prov-co', name: 'Prov Co', owner_email: 'owner@prov.example' });
+  check(boundOf(prov, 'prov-co') === 'prov-co', `PROVISIONING (admin create-business): repeating the same creation (status ${again.status}) leaves the binding unchanged`);
+  await admin(prov, '/debug/directory/create-business', { id: 'mig-co', name: 'Mig Co', migrating: true });
+  const mig = firstCall(prov, 'business-mig-co');
+  check(mig && mig.method === 'GET' && mig.path === '/health' && mig.adminKey && mig.directoryHasRow === true && boundOf(prov, 'mig-co') === 'mig-co', `PROVISIONING (a migration target): the first request is the admin-keyed health call, after the directory row exists, and it binds the object (${mig && mig.method} ${mig && mig.path})`);
+  check(boundOf(prov, 'prov-co') === 'prov-co' && boundOf(prov, 'mig-co') === 'mig-co' && boundOf(prov, 'prov-co') !== boundOf(prov, 'mig-co'), 'PROVISIONING: two provisioned businesses are bound to two different ids');
+
+  // sign-up, through the real entry point, into a real object
+  const signup = kit.bundle('signup.ts', 'obsignup');
+  const sf = await kit.makeFleet({ ids: [], directory: true, autoWake: true });
+  const post = (fields) => new Request('https://office.websitehub.co.za/auth/signup', { method: 'POST', body: new URLSearchParams(fields), headers: { 'CF-Connecting-IP': '1.2.3.4' } });
+  const token = await sf.auth.signSignupToken(sf.env, 'new@owner.example');
+  const res = await signup.handleSignupPost(post({ token, business_name: 'Acme Floors', agree: 'on' }), sf.env);
+  const id = await signup.businessIdFor('Acme Floors', 'new@owner.example'), sFirst = firstCall(sf, 'business-' + id);
+  check(res.status === 303 && sFirst && sFirst.adminKey && sFirst.directoryHasRow === true && sFirst.claim === id, `PROVISIONING (sign-up): the directory row exists BEFORE the object's first request, which carries the admin key and the server-derived id (${res.status}; first call ${sFirst && sFirst.method} ${sFirst && sFirst.path})`);
+  check(boundOf(sf, id) === id && sf.objects['business-' + id].state.id.name === 'business-' + id && id.startsWith('acme-floors-'), `PROVISIONING (sign-up): the object ends bound to the server-derived id (${id}) under exactly the name business-<id>`);
+  const callsBefore = sf.calls.length;
+  await signup.handleSignupPost(post({ token: await sf.auth.signSignupToken(sf.env, 'new@owner.example'), business_name: 'Acme Floors', agree: 'on' }), sf.env);
+  check(boundOf(sf, id) === id && sf.calls.length > callsBefore && Object.keys(sf.raws).length === 1, 'PROVISIONING (sign-up): the same person submitting again finds their business and creates no second object; the binding is unchanged');
+  const wrongClaim = await sf.direct(id, '/health', hdr('acme-floors-other'));
+  check(wrongClaim.status === 403 && boundOf(sf, id) === id, 'PROVISIONING (sign-up): a request naming another business is refused by the new object');
+
+  // ======================================================================================================================================================================================================================
+  // OBSERVATION, recorded and NOT endorsed: an UNAUTHENTICATED key naming an unknown business still creates and binds an object
+  // ======================================================================================================================================================================================================================
+  const ghost = await kit.makeFleet({ ids: [], directory: true, autoWake: true });
+  const key = 'omk.ghost-co.0123456789abcdef.' + 'A'.repeat(43);
+  const gr = await ghost.front('/mcp', { method: 'POST', headers: { Authorization: 'Bearer ' + key, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
+  const directoryHasGhost = ghost.directoryRaw ? (() => { try { return Boolean(ghost.directoryRaw.prepare("SELECT 1 FROM businesses WHERE id = 'ghost-co'").get()); } catch { return false; } })() : null;
+  check(gr.status >= 400 && gr.status < 500 && boundOf(ghost, 'ghost-co') === 'ghost-co' && directoryHasGhost === false, `OBSERVATION (a recorded behaviour, NOT a security contract; the principle says only authenticated provisioning should bind): a well-formed key naming a business that is NOT in the directory is refused (${gr.status}) yet its object was created and bound to "ghost-co" by that unauthenticated request (directory row: ${directoryHasGhost})`);
+});
+
+if (require.main === module) kit.standalone(module.exports);
diff --git a/tools/role-matrix.test.js b/tools/role-matrix.test.js
index 7d7578b..1bcd1dc 100644
--- a/tools/role-matrix.test.js
+++ b/tools/role-matrix.test.js
@@ -1011,6 +1011,7 @@ async function expect(role, method, path, want) {
   await require('./backup-manifest.test.js')({ check, bundleTo, srcDir });
   await require('./restore-proof.test.js')({ check, bundleTo, srcDir });
   await require('./breakage-runner.test.js')({ check, bundleTo, srcDir });
+  await require('./object-binding.test.js')({ check, bundleTo, srcDir });
   await require('./engine-boundary.test.js')({ check, bundleTo, srcDir });
   await require('./engine-operations.test.js')({ check, bundleTo, srcDir });
   await require('./engine-restore.test.js')({ check, bundleTo, srcDir });
````

## Exact raw files, pinned to the commit (works only if the repository is readable by the tool; visibility unknown)
- https://raw.githubusercontent.com/pierreduplessis6912-gif/the-office/da55997ccb1bc109c7802d991bfb2644f115e39b/tools/object-binding.test.js
- https://raw.githubusercontent.com/pierreduplessis6912-gif/the-office/da55997ccb1bc109c7802d991bfb2644f115e39b/tools/business-object.test.js
- https://raw.githubusercontent.com/pierreduplessis6912-gif/the-office/da55997ccb1bc109c7802d991bfb2644f115e39b/tools/engine-breakage.js
- https://raw.githubusercontent.com/pierreduplessis6912-gif/the-office/da55997ccb1bc109c7802d991bfb2644f115e39b/tools/engine-kit.js
- https://raw.githubusercontent.com/pierreduplessis6912-gif/the-office/da55997ccb1bc109c7802d991bfb2644f115e39b/worker/src/business-object.ts
- https://raw.githubusercontent.com/pierreduplessis6912-gif/the-office/da55997ccb1bc109c7802d991bfb2644f115e39b/worker/src/directory.ts
- https://raw.githubusercontent.com/pierreduplessis6912-gif/the-office/da55997ccb1bc109c7802d991bfb2644f115e39b/docs/decisions/engine-foundation.md

## Mutation evidence (needs a shell and a checkout)
The runner works on an isolated copy and never touches the tree. From the repository root:
````sh
node tools/engine-breakage.js --list --only object-binding     # shows the mutations tied to this suite
node tools/engine-breakage.js --only object-binding           # runs them on a copy; each must report CAUGHT
````
A mutation that is not caught means a test does not protect what it claims. Record each mutation by name, what protection it removes, and which check failed.
