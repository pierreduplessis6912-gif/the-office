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

- [ ] Auth check on every real data-returning endpoint, starting with the
  six added tonight (`/snags`, `/leads`, `/projects`, `/stock`,
  `/customers`, `/reports/aged-creditors/pdf`,
  `/suppliers/:id/discrepancies`, `/suppliers/discrepancies/:id/resolve`,
  `/customers/:id/profitability`, `/customers/:id/statement/pdf`)
- [ ] Every other real, already-existing production endpoint audited the
  same way — not assumed safe just because it predates tonight
- [ ] `/debug/*` and `/admin/*` routes locked down or removed from what's
  publicly reachable — compiled out of production, or behind real,
  strong admin auth with destructive routes specifically requiring
  explicit authorization and audit logging
- [ ] The "unauthenticated session defaults to Owner-equivalent access"
  gap, specifically — no implicit full-access fallback, ever
- [ ] File and document download endpoints get the same authorization
  policy as JSON endpoints — not treated as a separate, lesser category
- [ ] Capability checks proven, not assumed: real tests showing Owner,
  Accountant, Installer, and an unauthenticated request each get
  genuinely different results on the same endpoint

## Real, worth doing soon — not actively bleeding today

- [ ] Idempotency on every retryable write — audio uploads, photo
  uploads, document uploads, confirmation actions, payment creation,
  invoice creation, quotation conversion. Text messages already have
  this; voice upload routes reportedly don't yet.
- [ ] Migrations as real, versioned files (`worker/migrations/0001_*.sql`
  onward) instead of `/debug/init-*` POST routes — every real table and
  column added tonight (`products`, `line_items.product_id`,
  `line_items.room`, and everything before it) went through this exact
  pattern and should eventually be captured as a real migration history
- [ ] Replace wildcard CORS with explicit, known origins — development
  and production distinguished
- [ ] Split the large files into smaller domain modules — `index.ts`
  (342KB), `ai.ts` (121KB), `finance.ts` (114KB), `main.dart` (319KB) —
  same behavior, organized by real domain instead of one growing file
  each
- [ ] A real lockfile (`worker/package-lock.json`) and `npm ci` in CI
  instead of `npm install`
- [ ] At least a typecheck step in CI (`tsc --noEmit`) — real tests are
  the bigger, later piece, but even this catches a real class of
  mistake before it deploys
- [ ] Silent error-swallowing audited one by one — each `catch {}` block
  classified explicitly as safe-to-ignore, retryable, needs durable
  failure recording, or must fail the request outright. A swallowed
  error on a confirmation write is a different kind of problem than one
  on best-effort capture enrichment, and the code currently doesn't
  distinguish them.
- [ ] Stable, derived vector IDs for memory consolidation (from the
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
