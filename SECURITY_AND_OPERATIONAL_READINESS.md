# Security & Operational Readiness — Working Doc

Pinned as a real, working checklist, not an architecture document — meant to
be worked through start to finish, the same way a real punch list gets
closed out, tracked alongside the BI-readiness work (`products` /
`reconcileProduct` / line-item `product`/`room` extraction) as a parallel,
equally real initiative.

**Origin:** an external code review of this exact repository. Every
specific, checkable claim in it was independently verified directly against
the live repo before this doc was written — CORS wildcard, zero-auth
`/debug/*` routes, exact file sizes (342KB/121KB/114KB/319KB), missing
`package-lock.json`, no `scripts` in `package.json`, the duplicated README
heading. None of it was exaggerated.

**A real addition the original review couldn't have caught:** the six
endpoints built during tonight's discoverability pass — `/snags`, `/leads`,
`/projects`, `/stock`, `/customers`, plus the Aged Creditors and
discrepancy-resolution routes — have **zero auth check**, same as
everything the review flagged. Confirmed directly, not assumed. Added to
the list below rather than treated as a separate problem.

---

## Actually urgent — real people's real data is exposed right now

- [x] Auth check on every real data-returning endpoint, starting with the
  six added tonight (`/snags`, `/leads`, `/projects`, `/stock`,
  `/customers`, `/reports/aged-creditors/pdf`,
  `/suppliers/:id/discrepancies`, `/suppliers/discrepancies/:id/resolve`,
  `/customers/:id/profitability`, `/customers/:id/statement/pdf`)
- [ ] Every other real, already-existing production endpoint audited the
  same way — not assumed safe just because it predates tonight
- [x] `/debug/*` and `/admin/*` routes locked down or removed from what's
  publicly reachable — compiled out of production, or behind real,
  strong admin auth with destructive routes specifically requiring
  explicit authorization and audit logging
- [x] The "unauthenticated session defaults to Owner-equivalent access"
  gap, specifically — no implicit full-access fallback, ever
- [x] File and document download endpoints get the same authorization
  policy as JSON endpoints — not treated as a separate, lesser category
- [x] Capability checks proven, not assumed: real tests showing Owner,
  Accountant, Installer, and an unauthenticated request each get
  genuinely different results on the same endpoint

## Real, worth doing soon — not actively bleeding today

- [x] Idempotency on every retryable write — audio uploads, photo
  uploads, document uploads, confirmation actions, payment creation,
  invoice creation, quotation conversion. Text messages already have
  this; voice upload routes reportedly don't yet.
- [x] Migrations as real, versioned files (`worker/migrations/0001_*.sql`
  onward) instead of `/debug/init-*` POST routes — every real table and
  column added tonight (`products`, `line_items.product_id`,
  `line_items.room`, and everything before it) went through this exact
  pattern and should eventually be captured as a real migration history
- [x] Replace wildcard CORS with explicit, known origins — development
  and production distinguished
- [ ] Split the large files into smaller domain modules — `index.ts`
  (342KB), `ai.ts` (121KB), `finance.ts` (114KB), `main.dart` (319KB)
  (started: `worker/src/auth.ts` extracted, see below) —
  same behavior, organized by real domain instead of one growing file
  each
- [x] A real lockfile (`worker/package-lock.json`) and `npm ci` in CI
  instead of `npm install`
- [x] At least a typecheck step in CI (`tsc --noEmit`) — real tests are
  the bigger, later piece, but even this catches a real class of
  mistake before it deploys
- [x] Silent error-swallowing audited one by one — each `catch {}` block
  classified explicitly as safe-to-ignore, retryable, needs durable
  failure recording, or must fail the request outright. A swallowed
  error on a confirmation write is a different kind of problem than one
  on best-effort capture enrichment, and the code currently doesn't
  distinguish them.
- [x] Stable, derived vector IDs for memory consolidation (from the
  source record) instead of a new random UUID per attempt — makes
  retries safe instead of risking duplicate insertion

## Real, but genuinely the lowest stakes on this list

- [ ] Remove the duplicated `# The Office` heading in the README
- [ ] Consolidate the large documentation set — `DECISIONS.md`,
  `OFFICE_CONSTITUTION.md`, `STATUS.md`, `FEATURES.md`, `ATLAS.md`, and
  the various architecture docs (including the two pinned tonight) —
  into a smaller, clearer hierarchy, with older material archived
  rather than deleted
- [ ] A real feature/status/test matrix, so a new contributor (or a
  future session) doesn't need to read the full historical narrative
  first
- [ ] Commit the Android project instead of generating it dynamically in
  CI (`flutter create` on a missing `android/` directory is fine for
  prototyping, fragile long-term)
- [ ] Pin build environments deliberately (Flutter, Java, Android SDK,
  Gradle, Kotlin versions) instead of riding `stable`

---

## What this document does not settle

- The exact auth mechanism for the newly-locked endpoints — reusing
  whatever real capability-check pattern already exists for the lookup
  paths (`capabilities.includes("can_know_profit")` and its siblings),
  or something more uniform — is a real design decision for when this
  work actually starts, not decided here.
- Whether file-splitting happens before or after the auth work — the
  auth gap is the one with real, live exposure; sequencing everything
  else is a judgment call to make once that's closed, not fixed now.
- How much of the "lowest stakes" section ever gets done versus
  permanently deprioritized — named honestly as real, not pretended to
  be equally urgent as the rest of this list.

---

## Progress log

Entries record what was *verified*, not just what was ticked. Nothing on
the checklist above is marked done until it is enabled and proven.

### Urgent tier, item 1 — auth on every data-returning route

**Audit, checked against the live code (a static scan, cross-checked by
reading the confirm handler and `/debug/stock-items` directly):**
161 routes in total. 118 are `/debug` or `/admin`, none with any auth
check. Of the other 43, only 2 had one — leaving about 37 real data or
action routes open once the 4 intentionally public ones (health check and
the login flow) are set aside. That includes `POST /messages/text`,
`POST /actions/:id/confirm` and `/reject` (the call that executes a held
financial write), the `PATCH` routes for invoices, quotations and
customers, both upload routes, both CSV imports, and every PDF.

**Built, deployed OFF:** a central default-deny gate (`authGate`,
`ENFORCE_APP_AUTH = false`) — one check at the top of the handler rather
than 37 edits, which also fixes the class of mistake (every endpoint added
since has been open by default). Stage 1 covers the app-facing JSON
routes. Stage 2 is the PDF routes, exempt until they have short-lived
signed links (they open through an external viewer, which cannot send an
Authorization header). Stage 3 is `/debug` and `/admin`, exempt until
there is an admin secret (gating them now would break the curl workflow).
`resolveCapabilities` now fails closed when enforcement is on. Switching
it on, or reverting, is a one-line deploy that does not depend on the app
being able to reach the backend, so a lockout cannot trap the fix.

**Verified before enabling:** every one of the app's 29 HTTP calls and 4
uploads sends the session token; the owner's membership exists and is
active.

**Found along the way:**
- Two restricted members have existed since 14 July — an installer and an
  accountant. Until enforcement is on, anyone can hold Owner powers simply
  by not signing in, so their restrictions are currently bypassable.
- **The gate proves who someone is, not what they may do.** The message
  path already enforces capabilities (it is what stops an installer
  dictating an invoice), but the REST routes check none, and the app
  itself only *displays* the signed-in role — it hides no rooms. So once
  signed in, a restricted member would still reach every route directly.
  Restricted access is not real until a route-to-capability layer exists.
- A real CORS bug: `Access-Control-Allow-Headers` omitted `Authorization`
  and `Allow-Methods` omitted `PATCH`, which blocked the web preview's
  login token and every PATCH route in a browser (the native app is
  unaffected). Fixed in the same change.

**Still to do before stage 1 is switched on:** the installer and
accountant signed in on a build that has sign-in (sessions are stateless,
so this cannot be verified from the server), and an agreed
route-to-capability matrix so restricted access actually binds.

### Stage 1 switched on — verified live

Identity gate and role layer are both on. **Verified:** signed in as the
owner, the app works; an unauthenticated request to `/customers` — which
returned the full customer list earlier the same day — now returns
`401 sign in required`. The exposure on the app's own routes is closed.

**Role layer:** tested offline, 144 of 144 decisions correct, run against
the actual deployed decision code with the switches on (installer,
accountant, owner and an unknown role; every route the app calls;
confirm, reject and edit-field by action type; default-deny for unknown
types and nonexistent actions). The same test fails 2 of 144 when a bug is
put back, so it can fail. It is committed as `tools/role-matrix.test.js`.

**Caught before switching on:** `/files/audio` was missing from the allow
list and would have refused installers their voice capture — the one thing
the role exists for. Found by checking the route list against the matrix,
not by the SQL tests, which is why both kinds of check are worth having.

**Still open, so the checklist item is not ticked:** live tests of the
installer and accountant logins; stage 2; stage 3.

### Stage 3 design — `/debug` and `/admin`, not yet built

The app itself calls exactly **7** `/debug` routes (`financial-snapshot`,
`schedule`, `captures`, `tasks-list`, `suppliers-list`, `finance-list`,
`characters-list`). The server has about 120 debug and admin routes, so
over 110 are never used by the app. Plan: the 7 get role rules like every
other route, session plus capability. Everything else requires an owner
session **or** an `X-Admin-Secret` header matching a Worker secret, and
fails closed if that secret is not set. Needs one step from the owner:
setting `ADMIN_SECRET` in the Cloudflare dashboard.

### Stage 2 design — PDF links, not yet built

The document links are the ones sent to customers ("view it here"), so they
must stay openable without an account. They need short-lived signed links,
not a login — a customer can open theirs; nobody can guess the next number.

### Stage 3 switched on — a real bug found and fixed live, then verified

**Built:** the app's 7 real `/debug` dependencies (found by grepping
`main.dart`, not assumed) given normal session + role rules —
`financial-snapshot`/`suppliers-list`/`finance-list` to accountant,
`schedule`/`tasks-list` to installer, `characters-list` to both,
`captures` left owner-only by omission, per direct instruction (it is
the raw, unfiltered dictation history for every member). The other
roughly 110 `/debug` routes, and `/admin`, reuse the exact same
`X-Admin-Key` check that has protected `/admin` since 13 July — no
second secret. 165 of 165 role decisions verified offline before this
went live, up from 144; the same test fails when the owner-only rule
for `captures` is accidentally removed.

**A real, live bug, found by direct testing, not by review:** the admin-
key check was placed as a second, later check inside `handleRequest`'s
long sequential `if` chain. Since a route's own `if` returns before
anything placed later in the file can run, only the routes *after* that
point in the file were actually protected — 32 of 120. The other 88,
including `/debug/table-schema`, returned real data with no key and with
a wrong key both, confirmed live with a direct request before the fix.

**Fixed:** moved the check into `authGate`, which runs first for every
request regardless of where a route's handler sits in the file, and
deleted the now-redundant duplicate — one canonical enforcement point.
Deliberately kept independent of `ENFORCE_APP_AUTH`, so it protects
`/admin` exactly as it always has even if stage 1 is ever switched off.

**Verified live, after the fix, three direct requests:** no key —
`401`. A wrong key — `401`. The real key — the real schema, `200`. The
first two are the exact request that returned real data before the fix.

**Lesson worth keeping, not just fixing:** a check's correctness depends
on *where* it sits in a sequential handler, not just its own logic being
right — reviewing the check in isolation would have missed this
entirely; it only showed up by testing the actual live behavior.

**Still open:** live tests of the installer and accountant logins —
stage 1 and 2 are switched on and their mechanics verified offline, but
neither role has actually signed in and been checked against the real
system yet. That's the one item left before this tier of the checklist
is genuinely closed, not just built.

### Both roles live-verified — this tier genuinely closed

**Installer (Liam, id 16):** Customers scoped correctly to his three
real jobs (Bon Waterfront, Richards Hotel, Bond Empangeni). Projects and
Snags came back empty — checked directly against the unscoped owner
view first, confirming no project or snag row exists for any of his
customers at all, for anyone. The empty room was the scoping working
correctly, not a bug — proven, not assumed.

**Accountant (Pauline, gmclaughlin613@gmail.com, real membership id 5,
created live via `/debug/create-membership`):** confirmed working exactly
as designed — profitability and invoices visible and unscoped across
every customer, Snags/Projects/Leads refused.

**What this closes:** identity (stage 1), roles (stage 2), and
`/debug`/`/admin` (stage 3) are now switched on and live-verified end to
end, not just built and offline-tested. Anonymous access to `/customers`
returns 401. Both restricted roles were checked against the real system,
not test data — installer scoped correctly to his own jobs and refused
money; accountant saw all customers and money and was refused jobs. The
original finding this tier started from — that identity, once proven,
still was not authorization — is now a closed gap, not an open one.

**What is still real and open, named plainly rather than folded into
"done":**
- Stage 2's PDF exemption — document links still need short-lived
  signed URLs rather than staying openly guessable; not built.
- The dictation-side test never explicitly run: an installer or
  accountant *saying* something outside their role (a job-scope change
  for the accountant, a quotation for the installer) and getting refused
  by `capabilities.includes(...)` in the message path itself, rather than
  only the REST routes checked here.
- Two duplicate installer records under different capitalisation
  (Jabulani/jabulani, Stylish/stylish, Sipo/sipo) — flagged earlier
  tonight, not yet cleaned up. Real risk for scoping specifically: a job
  assigned to one spelling will not show for a login linked to the other.

### Stage 2 — PDF signed links, built and pushed, not yet live-verified

**A real finding that shaped the whole design:** `launchUrl` opens an
external browser tab, which carries no session at all — so even the
owner's own in-app "View Statement" taps were reaching the server with
zero auth, exactly the same as a customer's link. Every PDF needed the
same fix, not just the customer-facing ones.

**Built:** `signDocumentPath` / `verifyDocumentToken`, reusing
`SESSION_SECRET` and the existing `hmacKey` — no new secret. A signature
is tied to its exact path, so copying one document's link onto another
id fails. A new, normal, session-protected `/documents/sign` endpoint,
with its own capability allowlist (`SIGNABLE_DOCUMENT_PATHS`), which the
app calls before opening any PDF. Customer-facing links (built
server-side the moment a quote or invoice is confirmed) sign with a long
expiry — a customer may reasonably reopen theirs months later,
unguessability is the real protection, not a tight window; the app's own
interactive taps sign with a short one, since they're used immediately.

**Verified offline before pushing:** 9 of 9 round-trip cases against the
actual deployed signing functions (wrong path, wrong document kind, no
token, garbage input, wrong secret, tampered signature, expired token,
long-lived token). The role matrix still passes at 165/165. Diffs
against all three live files (`index.ts`, `finance.ts`, `main.dart`)
showed only the intended edits.

**Deployed, with two real, immediate consequences named plainly rather
than glossed over:** any already-sent, unopened customer PDF link with
the old, unsigned format now fails. The app's own report/statement
buttons were broken between the worker deploy and the client push —
closed by pushing `main.dart` immediately after, but genuinely broken in
between for anyone using the app in that window.

**Still open:** the client change needs a real Codemagic rebuild before
it takes effect at all — nothing here has been tested against the real,
rebuilt app yet. That live test is what would actually close this item,
not this push.

### CI typecheck and lockfile — built, real bugs found, live-verified

**Built:** `worker/tsconfig.json` (deliberately excludes the DOM lib —
including it conflicts with `@cloudflare/workers-types`' own definitions
of the same globals, which was inflating the error count before this was
diagnosed). `worker/scripts/check-types.js` compares a fresh `tsc` run
against a committed baseline, normalized to ignore line/column numbers,
and fails only on a genuinely new error. `worker/package-lock.json` —
this project's first — and `npm ci` in place of `npm install`.

**Two real, live bugs found by running this for the first time, not
review — fixed before the baseline was ever written, so neither shows
up in it:**
1. A genuine `ReferenceError`-in-waiting: `recorded`, in the work-
   observation path, was declared inside the `else` branch of an
   `if/else` and used afterward, outside both branches — unconditionally
   out of scope regardless of which branch ran. Every real attempt to
   dictate a job's pricing in the same breath as the job itself (the
   exact feature a 2026-07-15 comment describes) would have thrown,
   for anyone with `can_manage_invoices`. Fixed by hoisting the
   declaration to the scope that actually contains both branches.
2. `WorkObservationExtraction`, used as a type annotation in `index.ts`,
   was never imported from `types.ts`. Harmless at runtime (erased at
   compile time), but a real gap in what the compiler could ever have
   caught here.

**The baseline itself: 44 known, tolerated errors, none of them live
bugs** — confirmed by category, not assumed: ~15 Workers AI model calls
typed as `Record<string, unknown>` across many different models (real
future work to tighten properly, not tonight's), a Vectorize binding
type-narrowing gap, `instanceof File` losing its DOM-lib type as a
direct consequence of excluding DOM to fix the conflict above, and two
spots of real, low-stakes union-type looseness.

**Verified before pushing, and live in CI, not just locally:** a full
dry run (`npm ci` then `npm run typecheck`) from a clean scratch
directory; the checker proven to have teeth by reintroducing the exact
`recorded` bug (fails with 6 real errors) and reverting (clean again);
every one of the 7 real commits this required deployed successfully,
including the final one — checked at the step level, not just the job
level, that "Typecheck" ran as its own distinct step and passed before
"Deploy to Cloudflare Workers" ever ran.

### Dictation-side capability check — audited directly, a real gap found and fixed

**Not just "verified already real" — audited the same way as the REST
layer earlier tonight, by listing every actual extraction intent value
and checking each one against the enforcement list, rather than trusting
that the list was already complete.**

**Found:** `FINANCIAL_WRITE_INTENTS` gated `payment`, `expense`,
`invoice`, `quotation`, `price_scope`, and `convert_quote` — but
`supplier_invoice`, `supplier_payment`, `goods_received`,
`purchase_order`, and `variance_disposition` were real, distinct
intents, already gated on *confirm* by `ACTION_TYPE_CAPABILITY` (the
same `can_manage_invoices`), yet never gated at *creation*. An installer
could dictate "pay Floornet R10000" and it would sit held, waiting —
REST-layer confirm would correctly refuse them personally, but a
misleading held action would still exist for whoever else looked. Fixed
by widening the same list.

**A parallel, smaller gap fixed alongside it:** leads are owner-only at
the REST layer, but dictating a lead as lost had no equivalent check.
Added.

**Verified:** typecheck clean against the baseline, diff against live
showed only the intended widening plus pure additions, the full role
matrix still 165/165.

**Live test still open, same as it was for the REST layer before Liam
and Pauline actually signed in:** this has been checked by direct code
audit and offline typecheck, not yet by an installer or accountant
actually trying to dictate one of these and being refused. Worth doing
once there's a real, low-cost moment to.

### Stable vector IDs — fixed, checked against the real live schema first

Checked the real schema directly before deciding how to derive the id,
rather than assume: `pending_memory_flush.id` is a plain `INTEGER PRIMARY
KEY`, not `AUTOINCREMENT`, so it could in principle be reused after the
table goes fully empty. Derived the vector id from both `id` and
`created_at` together, not `id` alone — the same row, retried after a
partial failure (upsert succeeds, the following delete does not), keeps
the same timestamp and produces the same vector id, so the retry becomes
a real overwrite through Vectorize's own upsert-by-id semantics rather
than a silent duplicate; a genuinely new row that happens to land on a
reused id still gets a distinct one, since its timestamp will differ.

Verified: typecheck clean against the baseline, diff against live showed
only the three lines that needed to change.

### Idempotency — a much bigger finding than assumed, built end to end, rebuild pending

**Not "voice upload routes don't have this yet" — none of it was ever
real.** The server-side mechanism for `/messages/text` had existed since
2026-07-15, well-built, but a full audit of the client found it never
sent an `idempotency_key` for anything, ever. The protection had been
sitting completely dormant in production the whole time.

**Built, both sides:** `checkIdempotencyKey`/`completeIdempotencyKey`
extracted as shared server helpers from the exact, unchanged
`/messages/text` logic, then applied to `/files/audio`, `/files/photo`,
and `/files/document` — checked before any real work starts, completed
once at each handler's one real success return. Client-side, a real key
is now generated and sent for every text send and every upload — content
plus a rounded 30-second window (the real, considered design, matching
how Stripe and most payment systems handle exactly this: the same words
within the window are almost certainly an accidental resend; the same
words minutes later are almost certainly a second, genuine action, and
correctly get treated as one). Uploads use the local file path alone as
the content signal — deliberately not file size or bytes, since
`dart:io`'s `File` class is unavailable on web and this app supports web.

**A real, named, deliberately separate gap, not folded into "done":**
`/actions/:id/confirm` already refuses a retry arriving *after* the
original fully completed (`status !== 'pending'`), but two
near-simultaneous requests could still race *during* processing, before
that status update lands — the existing check isn't atomic protection
against that. This function branches into 17 different action types
doing genuinely different real work; retrofitting the same pattern
safely needs its own dedicated pass, not a rushed one tonight.

**Verified before pushing:** typecheck clean against the baseline; the
full role matrix and PDF signing round-trip both still pass; diffs
against live showed only the intended changes on both the server and
client side.

**Still open:** the client change needs a real rebuild before any of
this is live-verified — nothing here has been tested against actual
retried requests yet, same as the PDF and role work before their own
rebuilds confirmed them.

### CORS allowlist — switched on, live-verified

Confirmed directly which origin is real before building anything:
`the-office-preview.pages.dev` is genuinely in use; the AB-experiment
domain is confirmed not in use, deliberately excluded rather than
assumed stale. CORS is purely browser-enforced — the native app's HTTP
client ignores these headers entirely, so this only ever affects the
web preview, never the app itself.

Verified offline first (4 real cases against the extracted, actual
function: the real preview origin, the excluded AB domain, an unrelated
origin, no Origin header at all — plus the deployed-off default
confirmed to still return the exact prior wildcard behavior), then
switched on and verified live: the real preview origin gets a matching
`access-control-allow-origin`; an unrelated origin gets none at all;
both still return `200` — the request itself is never blocked, only a
browser's ability to read the response from an unrecognized origin.

### Silent error-swallowing — a real, scoped first pass, not the full audit

Audited all 32 completely silent (`catch {}`, no error variable at all)
blocks in `index.ts` — the highest-risk category, since nothing there
even names the error, let alone acts on it. Most were already
well-designed and correctly labeled (malformed-token parsing, the
idempotency race, the merge tooling's deliberate per-table skips) — no
changes needed.

**One real, systemic finding, fixed:** ~20 migration `ALTER`/`CREATE`
blocks swallowed *any* error under a comment that only ever meant
"already exists." Checked the real, live error text directly
(`/debug/probe-duplicate-column`, a temporary diagnostic, removed after)
before writing the check — a genuine duplicate-column `ALTER` on this
project's own D1 returns exactly `"D1_ERROR: duplicate column name:
...: SQLITE_ERROR"`. New `runIdempotentMigration` helper treats only
that specific, real case as safe; anything else now propagates as a
real failure instead of a silently reassuring `{"status":"ok"}`. Applied
to all 19 real `ALTER` sites.

**A further, more important finding along the way:** 4 of those wrapped
`CREATE TABLE IF NOT EXISTS`, which SQLite's own `IF NOT EXISTS` clause
already makes idempotent — a catch there was never really catching
"already exists" at all, since SQLite never throws for that reason in
the first place; it was silently masking whatever genuinely unexpected
error actually occurred. Those 4 had the try/catch removed entirely
rather than routed through the helper, since no error there is ever the
expected case.

**Verified live, not just offline:** re-ran an already-applied migration
(`merged_into_person_id`, genuinely already existing) — correctly still
returns `{"status":"ok"}`, confirming the real "duplicate column" case
is recognized correctly, not just in theory.

**Honestly scoped, not the full checklist item:** this covers the
silent (`catch {}`) category in `index.ts` only. The 39 `catch (err)`
blocks in the same file, and every block in `finance.ts`, `ai.ts`,
`identity.ts`, and `memory.ts`, remain unaudited. Real progress, not
completion.

### index.ts error-handling audit — now genuinely complete

Continued into the 39 `catch (err)` blocks, since naming the error isn't
the same as handling it correctly. Most were already right: every real
PDF route, every `PATCH` route, the debug diagnostics, the KV/R2 flush
tooling, the PDF text-extraction fallback, and the confirm handler's
outer catch (already a deliberate fix from earlier, explicitly commented
— the handler "never had error handling wrapped around it at all" before
that, producing Cloudflare's generic crash page with no way to see what
broke).

**But 14 more instances of the exact same migration-swallowing issue
turned up** — the earlier fix was real but incomplete, not wrong; these
were the identical unsafe pattern under `catch (err)` instead of the
bare `catch {}` the first regex matched. Some even returned a
misleading `status: "ok"` alongside a `note`/`detail` field that, if
actually read, might have revealed a genuine failure. All 14 now route
through the same `runIdempotentMigration` helper — confirmed none of
those specific debug routes are called by the client before
consolidating their response shape.

**`index.ts` is now genuinely, fully audited** — both the silent and
the named catch categories. `finance.ts`, `ai.ts`, `identity.ts`, and
`memory.ts` remain open.

### Error-handling audit — complete across every worker source file

**finance.ts:** 1 block, a deliberate, correct fallback (a broken logo
image degrades to text, never blocks a real document). Clean.

**identity.ts:** 1 block, `logInteractionEdge`, explicitly documented as
an auxiliary signal that must never affect real reconciliation. Clean.

**ai.ts:** 31 blocks. The large majority are a single, deliberate,
consistent pattern — AI output that fails to parse becomes an empty or
null extraction, which the already-established honest-fallback logic
elsewhere handles correctly, rather than crashing the request. The rest
are a well-designed, two-level durable-failure-recording path (the
memory-embedding failure: try to log it, give up cleanly if even that
fails) or reasonable safe defaults for quality concerns like reranking.
Clean.

**memory.ts:** 18 blocks. Seventeen already correct — durable
error-logging with a consistent "nothing further to do if even the
error log fails" safety net, or reasonable reads that degrade gracefully
(missing notes → empty list, one corrupted day skipped rather than
failing the whole read). One real, fixed inconsistency:
`runConsolidation`'s own failure-logging `INSERT` was the only durable-
error-logging site in the file *without* that same safety net — if that
specific insert failed, the whole consolidation run would have thrown
uncaught instead of degrading the same way its nine siblings do. Now
consistent.

**index.ts**, audited across two earlier passes: 32 silent blocks (14
real fixes — the migration-swallowing pattern) and 39 named blocks (14
more instances of the identical issue, missed by the first pass because
they used `catch (err)` instead of bare `catch {}`).

**The whole checklist item is now genuinely complete, not partial** —
every real source file in the worker has been read block by block, not
sampled, with 30 real fixes across two files and everything else
confirmed correct by direct review rather than assumed.

### Migrations as real files — the baseline established

Not a retroactive rewrite of the ~20 already-applied `/debug/init-*`
routes into history — the real, valuable move was establishing the
pattern going forward. Captured the true, live schema directly from
SQLite's own `sqlite_master` (a temporary diagnostic, removed after),
not reconstructed from source, which would have missed every column a
later `ALTER TABLE` added — confirmed this mattered directly:
`variance_dispositions` has a real `capture_id` column that a
source-only reconstruction would have missed entirely.

`worker/migrations/0001_baseline.sql` — all 41 real tables, every
statement `CREATE TABLE IF NOT EXISTS`, safe to run against the real,
live database which already has all of them. Verified by actually
running it against a fresh, empty SQLite database: all 41 created
cleanly, zero errors — not just written and assumed correct.

A real README explains the going-forward process: a schema change
becomes a new numbered file, idempotent, applied by hand for now (no
automated runner yet), never editing the baseline or an earlier file.

### File-splitting, real first step — worker/src/auth.ts extracted

Not the full domain-by-domain restructure at once — a real, deliberately
staged first step: the entire auth/security layer (sessions, roles and
capabilities, document-link signing, idempotency, safe migrations,
CORS — 15 exported functions, 5 exported constants, 4 functions and 8
constants kept properly module-private) pulled out of `index.ts` into
its own file.

**Verified thoroughly before the push, not assumed safe:** confirmed no
hidden dependency on anything else in `index.ts` beyond the `Env` type
and standard Web APIs; confirmed every real external call site to build
the minimal, correct export list rather than exporting everything
defensively; typecheck clean against the baseline on both files
together; the full existing test suite (165-case role matrix, 9-case
PDF signing round-trip, 4-case CORS allowlist, 5-case live-bug
regression) all re-extracted from the new file and re-verified passing.

**Two real, separate bugs found and fixed while wiring this back up,
not part of the plan going in:**
1. The committed role-matrix test had two hardcoded absolute paths
   pointing at my local sandbox — would have failed the moment it ran
   anywhere else, including real CI. Fixed to be genuinely portable,
   verified in a full simulation of the real CI sequence (a fresh
   `npm ci`, cross-directory `require` and all) before trusting it.
2. That same test had never actually been wired into the deploy
   workflow at all — only the typecheck step ran. Worse: the workflow
   file update to add it was built and verified locally, then never
   actually pushed on the first attempt — caught because the next
   deploy's step list was checked directly rather than assumed to
   match what was intended.

**Live-verified end to end, not just CI-green:** the role-matrix test
confirmed running as its own real step in the actual GitHub Actions
run (checked at the step level after the correction); the live,
deployed worker confirmed afterward with a real request — `/health`
with the real preview `Origin` header still returns the correct
`access-control-allow-origin`, exactly as before the split.

### File-splitting, second real step — worker/src/debug.ts extracted

The much harder case: unlike `auth.ts`, the 120 `/debug`/`/admin`
routes turned out to be interleaved throughout the file with real,
non-debug application routes in between, not one contiguous block.
Found and verified their exact boundaries using the real TypeScript
parser directly (`ts.createSourceFile`, walking the real AST for every
`if` statement matching the pathname pattern) rather than text-based
guessing, which would have been genuinely risky at this scale and
shape.

**One real, deliberate exception, not an oversight:** `/debug/reprocess`
stays in `index.ts` — it genuinely calls `processTranscript`, the core
message pipeline, and moving it too would have meant a real circular
import between the two files for the sake of a single route. 119 of
120 moved; the 120th has a real, structural reason not to.

**Two real, genuinely new issues found and fixed before this was
trusted, not assumed clean from a first pass:**
1. `getRealTableNames`, a helper the original code relied on as a
   closure over `handleRequest`'s own `env` parameter, moved with its
   two real callers (`/admin/export`, `/admin/flush`) but lost that
   closure access — given an explicit `env` parameter instead, since
   it's no longer nested inside the same scope.
2. **A real CI failure on the first push, correctly caught by the
   pipeline built earlier tonight, not glossed over:** the committed
   `check-types.js` does exact text matching, including the file path
   — several already-tolerated error categories were still attributed
   to `src/index.ts` in the committed baseline, so the exact-match
   check correctly flagged them as new the moment the code producing
   them genuinely moved to `debug.ts`. Not a new problem — the same 44
   known, tolerated errors, now correctly attributed to wherever they
   actually live. Regenerated the baseline and verified it directly
   against the real, committed script before pushing again: "Typecheck
   clean: 44 known, tolerated error(s), 0 new."

**Live-verified twice over:** the real CI run confirmed at the step
level (Typecheck, Role-matrix test, and Deploy all succeeded on the
corrected push); and, separately, a real request against the actual
deployed worker — `/debug/job-scopes` with the real admin key —
confirmed returning the same real, correct data it always has, proving
the actual moved code works in production, not just that CI was green.

### Three items ticked retroactively — verified against the real, live code just now, not assumed from memory

Found while reviewing the checklist fresh: three urgent-tier items were
genuinely satisfied by work already done and verified tonight, but never
explicitly ticked, since each update was scoped to whatever specific task
was active at the time rather than cross-checked against every related
checkbox. Re-verified each directly before ticking, not from memory:

- **`/debug`/`/admin` locked down** — confirmed live: `ENFORCE_APP_AUTH =
  true`, and the one route still living in `index.ts` (`/debug/reprocess`)
  goes through the exact same `authGate` check as everything in
  `debug.ts`, since the gate runs on path prefix, not on which file a
  route's body happens to live in.
- **The Owner-fallback gap** — confirmed directly in `resolveCapabilities`:
  `capabilities: ENFORCE_APP_AUTH ? [] : ROLE_CAPABILITIES.owner` — with
  `ENFORCE_APP_AUTH` genuinely `true` live, an unauthenticated request
  gets zero capabilities, never Owner's.
- **Capability checks proven** — the 165-case role matrix plus the live
  tests with Liam (installer, scoped correctly to his own jobs, refused
  money) and Pauline (accountant, saw all customers and money, refused
  jobs) already proved exactly this, in production, not just offline.
