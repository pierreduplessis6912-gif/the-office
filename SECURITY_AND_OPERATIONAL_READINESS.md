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
