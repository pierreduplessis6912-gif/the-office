# Ship checklist: what stands between The Office and production

Written 2026-10-11 from a third outside review, **with every claim checked against the code first** (`DECISIONS.md`, "Two outside reviews"). It replaces section F of `OPEN_QUESTIONS.md` as the working list. Status is what the code shows today, not what any review said.

**How we work off it.** One item at a time, in the order below. Each item ends the same way: the claim is verified, the fix is built, it is tested with deliberate breakages, it is logged in `DECISIONS.md`, it is pushed and its pipeline is green, and, where it needs one, a live check is done. An item is only DONE when its **exit criteria** are met. Anything that needs Pierre (a decision, a secret, a Cloudflare resource) is marked **NEEDS PIERRE** with exactly what is needed.

Status key: **DONE** / **PARTLY** / **OPEN**. The latency work is paused until this list is done (Pierre, 2026-10-11).

## The list, in working order

| # | Item | Status | What the code shows |
|---|------|--------|---------------------|
| A | Database architecture for thousands of businesses | **CUT OVER** (2026-10-13) | **Production now serves the real business from its own Durable Object (`zululand-flooring-and-blinds`)**, in a single Worker with a shared directory, per-business scoping of notes, files and memories, an hourly job per business, and customers\' existing links honoured. Checked from outside after the switch: the front door healthy, a stranger refused (401, JSON), sign-in pointing at production, the object and the Worker each saying what they are, 4 team members in the directory, and **the object\'s counts identical to production\'s before the switch (2,002 rows, 46 tables, 42 notes, 129 files, 32,650,518 bytes)**. **Not yet verified: a real person using it** (Pierre signs in and tries it). Rollback: delete `BUSINESS_MODE` and `LEGACY_LINK_BUSINESS` from `worker/wrangler.toml` and deploy (anything written after the switch is not in the old database); the D1 recovery point is recorded in `ops/production-final-copy-last.json`. Items 6 to 10 and 13 are redesigned on this base and not yet built. |
| 1 | Front-door error handling | **DONE** (`b09d1f6`) | Every uncaught error is logged with the request id and answered with a JSON 500 that carries the CORS headers. |
| 2 | The shared admin key | **DONE** (2026-10-11) | Mint-session and erase-everything are **removed** (nothing used them). All 124 remaining admin routes have a tier, enforced by a test. 11 **privileged** routes need a second secret and are **switched off until `ADMIN_CONFIRM_KEY` is set**. Wrong guesses are throttled (5 in 15 minutes), the key is compared in constant time, and every call is recorded. |
| 3 | Signed document links | **DONE** (2026-10-11) | Already sound: HMAC-signed, expiring, and tied to one exact document. The gap was the **365-day lifetime**; customer links now last **60 days** (one value, `CUSTOMER_LINK_TTL_MS`), all now tested. Links already sent keep their original expiry; not revocable one by one (changing `SESSION_SECRET` kills every link and session at once). |
| 4 | Every route classified | **DONE** (2026-10-11) | The 126 admin routes have tiers; the **63 other routes (67 rows) are in a policy file checked against the real gate for each kind of caller**, with a readable `ROUTE_POLICY.md`, and invariants that hold whatever the file says (an installer never reaches a money route; only sign-in routes work without signing in). A new route, or a change to who may do what, fails the build until it is deliberate. |
| 5 | Deploy safety | **DONE** (2026-10-11) | Tests run on every push; a smoke test checks the live Worker after each deploy; a failed one **rolls the previous version back automatically** and the run turns red. **Proved by a drill** (a forced failure, the rollback ran, the Worker was healthy again) and by the first real deploy passing its smoke test. |
| 5b | Staging environment | **OPEN** | A second Worker with its **own database, storage and secrets**, so changes (migrations especially) and restore drills can be tried without touching real data. Needs new Cloudflare resources; matters most for items 8 and 10. |
| 6 | Model cost controls | **OPEN** | No rate limit, no daily cap, no budget alert. The model is the main running cost. |
| 7 | Observability and alerting | **PARTLY** | Structured logs with a request id and per-request timings exist. **No `[observability]` block in `wrangler.toml`** (log retention must be confirmed in the dashboard), no user in log lines, nothing that alerts. |
| 8 | Migrations | **OPEN** | 1 migration file, 39 lazy `CREATE TABLE IF NOT EXISTS`, 38 `/debug/init-*` routes. |
| 9 | Partial writes | **OPEN** | One atomic batch in the whole Worker. Multi-step writes (an invoice and its lines, a delivery and its stock updates, merges) run one statement after another. |
| 10 | Backups and restore | **BUILT; FIRST PRODUCTION SNAPSHOT TAKEN** (2026-10-13) | A daily, checksummed snapshot of each business (every table, the id counters, the notes, an inventory of the files, a fingerprint) goes from the business\'s own object into a SEPARATE bucket (`office-backups`), with the files mirrored incrementally, the newest 14 kept, and a **restore that verifies every checksum before changing anything, takes a safety snapshot first (so it is reversible), locks the business to admins while it runs, and compares the result with the fingerprint recorded at snapshot time.** **Proven on real Cloudflare (staging):** a business was damaged two ways (3 customers added, a note overwritten), the damaged fingerprint differed, and after the restore the customers (2), the note and the whole-business fingerprint were back to the original, with a safety snapshot and the other business untouched. **Production:** the first snapshot succeeded (46 tables, 2,004 rows, 42 notes, 129 files mirrored, 138 s) and a **daily GitHub check goes red** (so GitHub emails the owner) if there is no bucket, the last attempt failed, there is no complete snapshot, or the newest is over 30 hours old. **Not covered / not yet done:** the memory index (held by Cloudflare), an off-platform copy, a per-night cap on mirroring for very large businesses, and a restore on production data (deliberately not tried: staging is the evidence). The first AUTOMATIC nightly backup has not yet been seen. |
| 11 | Reproducible app build | **OPEN** | No `pubspec.lock`; Codemagic runs `flutter create` to generate the Android scaffold at build time. |
| 12 | App tests | **OPEN** | No Dart tests at all. |
| 13 | Load and performance | **PARTLY** | Timing instrumentation exists and shows a 7 s median per message; no load or volume test. Depends on 5 and the paused latency work. |
| 14 | Runbook | **OPEN** | Only a design document (`SECURITY_AND_OPERATIONAL_READINESS.md`). Each item above adds its own runbook section as it lands. |
| 15 | Onboarding | **OPEN (design only)** | `ONBOARDING_JOURNEY.md` is a design; the code barely mentions it. **NEEDS PIERRE: in scope for shipping?** |

## Exit criteria and what each item needs

**2. Admin key. DONE 2026-10-11** (`DECISIONS.md`, "Hardening item 2"). Every `/admin` and `/debug` route sits in a tier table (read-only, privileged, destructive) and a test fails if one is unclassified. Every admin call leaves an audit row (route, time, outcome, hashed source). Wrong keys are logged and throttled, and compared in constant time. Destructive routes need a second secret. *NEEDS PIERRE: (a) which routes to remove from production altogether (minting a session and erase-everything are the candidates); (b) to set a second Cloudflare secret.*

**3. Signed links. DONE 2026-10-11** (`DECISIONS.md`, "Hardening item 3"; the 60 days is my default, Pierre has not chosen). The token is confirmed to bind to its exact path and to expire; the lifetime is shortened or links become revocable; a test proves an expired, tampered or wrong-path link is refused. *NEEDS PIERRE: how long should a customer's invoice link live (30, 60 or 90 days)?*

**4. Route classification. DONE 2026-10-11** (`DECISIONS.md`, "Hardening item 4"). A table lists every route with the roles allowed; a test fails if a route exists that is not in it. A policy matrix is generated from the code, not hand-written.

**5. Deploy safety. DONE 2026-10-11** (`DECISIONS.md`, "Hardening item 5, part 1"); **staging is now item 5b, still open.** A staging Worker and database exist and every deploy goes there first; the pipeline then checks `/health` and one front-door behaviour, promotes to production, checks again, and **rolls back automatically** if the check fails. *Needs a Cloudflare staging database; I can create it with the pipeline's token if it allows.*

**6. Cost controls.** Per-member and global daily caps on model calls and transcription, refused with a plain message in the app's own voice; every call counted; a warning at 80% of a cap. *NEEDS PIERRE: the limits (a first suggestion: 300 messages per member per day, and a global cap you can raise).*

**7. Observability.** Log retention is on and confirmed; the request-end line carries a hashed member id; every uncaught error is also written to a small table; the hourly job checks the last hour (errors, slow requests, cost) and sends one alert. An induced error produces an alert within the hour. *NEEDS PIERRE: where alerts go (email, WhatsApp or Telegram).*

**8. Migrations.** The production schema is captured as migration `0002`; a database built only from migration files has exactly the schema the code expects (a test compares them); migrations are applied by the pipeline and recorded in a ledger. The lazy creators stay as a safety net until this is proven, then become no-ops.

**9. Partial writes.** Every multi-step write on a money or stock path is listed; each is made atomic (a D1 batch) or shown safe to retry. A test injects a failure after each step and proves no half-written financial state remains. Money paths first (invoice and quotation, goods received, payments).

**10. Backup and restore.** A daily export to R2 (with 30 days kept) that includes the KV notes; Cloudflare's own point-in-time recovery for D1 confirmed and written down; a real restore done once on staging with matching record counts; the steps written in the runbook. Depends on 5.

**11. Reproducible app build.** `android/` and `pubspec.lock` are committed (generated once by a one-time pipeline run, with no manual step), and Codemagic no longer runs `flutter create`. Two builds a week apart use identical dependency versions.

**12. App tests.** `flutter test` runs in the pipeline before any build and covers the state machine, the API client's reading of the replies the app depends on, and session expiry; the Worker's recorded route cases are the contract the app is tested against.

**13. Load.** On staging, with realistic volumes (thousands of captures and invoices) and concurrent requests, p95 stays under an agreed target. This is where the paused latency work resumes.

**14. Runbook.** `RUNBOOK.md` covers deploy, hotfix, rollback, restore, a model-provider outage, a cost spike and common support questions; **every section has been executed once**, not just written.

**15. Onboarding.** Either declared out of scope for the first ship (and said so), or built: resumable, persistent, safe to retry.

## Refactor tidy-ups (optional, after the list above)

Adopt the Phase 1 result contract and delete the unused dispatcher; split the 3,161-line route handler into route modules (after route recordings exist); replace the source-text guards with typed ones. Detail in `DECISIONS.md`, "Phase 3 summary".

## Decisions needed from Pierre, collected

1. Which admin routes to remove from production (2).
2. The second admin secret to set in Cloudflare (2).
3. Customer link lifetime (3).
4. Cost limits (6).
5. Where alerts go (7).
6. Onboarding in or out of scope for the first ship (15).
