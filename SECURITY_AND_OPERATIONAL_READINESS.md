> **Status:** real. **Verified:** not yet. **Owns:** `worker/src/auth.ts`, `worker/src/routing.ts`, `worker/src/access.ts`, `worker/src/admin-gate.ts`.


> **Audit 2026-10-25 (line by line).** This is the July working log; the checklist below is read against the code as of today, the Progress log is dated history. Verified in code: 106 backticked names exist (the two missing, `ADMIN_SECRET` and `STATUS.md`, are history: now `ADMIN_KEY` plus `ADMIN_CONFIRM_KEY`, and the archived July status). The auth gate fails closed (`ENFORCE_APP_AUTH = true` in `auth.ts`: no session means no capabilities, so the old "no session means Owner" default is unreachable); CORS is enforced with an allowlist (`ENFORCE_CORS_ALLOWLIST = true`, one origin; `*` is only the off-switch); `worker/package-lock.json` and `npm ci` in CI exist; the README has one `# The Office` heading; `FEATURES.md` exists; the role matrix, gate and route-policy tests exist (`tools/role-matrix.test.js`, `gate.test.js`, `route-policy.test.js`). Still open and still true: the large-file split (on 2026-10-25 `index.ts` is 214,035 bytes, `debug.ts` 125,865, `auth.ts` 69,834; the 342KB of July is gone but the item stays unticked), and documentation consolidation (40 root documents). NOT re-proved: the live verifications in the Progress log (they are dated results). Known stale: the code comment above `resolveCapabilities` in `auth.ts` still describes the July default; the code under it fails closed. Verified stays "not yet" for the log; the checklist is current.

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
- [x] Every other real, already-existing production endpoint audited the
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
- [x] Structured logging and request correlation IDs — named in the
  original review's numbered list but never actually added as a
  tracked item until now

## Real, but genuinely the lowest stakes on this list

- [x] Remove the duplicated `# The Office` heading in the README
- [ ] Consolidate the large documentation set — `DECISIONS.md`,
  `OFFICE_CONSTITUTION.md`, `STATUS.md`, `FEATURES.md`, `ATLAS.md`, and
  the various architecture docs (including the two pinned tonight) —
  into a smaller, clearer hierarchy, with older material archived
  rather than deleted. Genuinely still open — the doc set grew tonight
  (five new architecture docs, this checklist, the feature matrix), not
  shrunk; a real consolidation deserves its own deliberate pass, not a
  rushed one at the end of a long session.
- [x] A real feature/status/test matrix, so a new contributor (or a
  future session) doesn't need to read the full historical narrative
  first — `FEATURE_STATUS_MATRIX.md`, built from genuine, verified
  evidence, not aspiration.
- [ ] ~~Commit the Android project instead of generating it dynamically
  in CI~~ — **considered and explicitly declined, not simply undone.**
  `codemagic.yaml`'s own comments document a real, previously-live bug:
  Flutter's `stable` channel moved forward and silently broke a static,
  regex-based Kotlin-version patch that assumed an older template
  shape. The fix already in place — a CLI bypass flag, not a pinned
  file — was chosen specifically because it is more resilient against
  Flutter's own evolving templates than a committed, hand-maintained
  `android/` folder would be. Committing it now would reintroduce the
  exact fragility this project already got burned by once and
  deliberately moved away from.
- [ ] ~~Pin build environments deliberately~~ — **declined for the same
  real reason.** The current design rides `flutter: stable` on purpose;
  pinning to a specific version trades one real risk (an unexpected
  upstream template change) for another real one (a hard-pinned old
  version silently falling behind a plugin's actual requirements), and
  the project has direct, documented evidence of the *template drift*
  risk actually happening, not the pinned-version one.

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

## Assistant sign-in (OAuth), branch `mcp-oauth-2`, 2026-10-25 (not deployed)

New PUBLIC paths in the gate (`auth.ts` `PUBLIC_ROUTES`) and the router (`routing.ts` `WORKER_ONLY`): discovery, `/oauth/register`, `/oauth/authorize`, `/oauth/consent`, `/oauth/token`, read from `OAUTH_PUBLIC_PATHS` in `mcp-oauth.ts`. Each step is proven by a signed value, Google sign-in and an owner check, never a session. `/mcp` answers 401 with the discovery header. Proof: `tools/mcp-oauth-routes.test.js` and `tools/mcp-oauth-routes-breakage.js` (17 guards). Not yet proven end to end: the `index.ts` wiring (staging slice 3). Design: `MCP_ARCHITECTURE.md`.

---

## Connected assistants (MCP): who can create and who can undo (2026-10-26)
A connected assistant's key has a scope: read only by default, create only when the owner ticks it on the consent page. Creating and deciding go through seven write tools (tell_the_office, schedule_job, edit_created_record, confirm_pending_action, reject_pending_action, get_upload_link, check_upload), owner only, with per-key caps and a flag over R50,000 (`MCP_ARCHITECTURE.md`); an assistant may confirm or reject only what its own key proposed and only kinds the owner can put back (six, `worker/src/mcp-pending.ts`). Undoing what it created or decided is the owner's own action in the app (`GET /mcp-created`, `POST /mcp-created/undo`, both `can_invite_members`, so owner only, and they work with MCP switched off); it acts only on records or decisions tagged to a key, by the tag's id, never deletes an invoice (it voids it), and refuses, writing nothing, to put back stock or a customer detail that has changed since (`worker/src/mcp-effects.ts`).

## Assistant confirm and reject (2026-10-26)
`confirm_pending_action` and `reject_pending_action` make the app's own confirm or reject request as the member a key belongs to, with a ONE-MINUTE session minted inside the Worker (`worker/src/mcp-act.ts`) and never shown to anyone, so the normal gate, atomic write and decision log all apply. They are write scope, owner only, limited to an action that the same key proposed and that only needs a yes, counted against the key's limit, audited and closed by `MCP=off`. The control that remains is claude.ai's per-tool approval; see `MCP_ARCHITECTURE.md`.

## The upload link (2026-10-26)
`/upload/<ticket>` is a page and an upload opened WITHOUT a sign-in, by a signed link (`signed link` class in `ROUTE_POLICY.md`, GET and POST only). It is bounded by: a signature over that exact path that ends in ten minutes; a ticket checked again on every use (10 minutes, at most 5 files, key not revoked, member still an active owner); a content check (JPEG, PNG or PDF by first bytes, at most 8 MB); and by the app's own photo and document routes, which hold anything touching money for confirmation. A leaked link can send a few files to the owner's pipeline for a few minutes; it cannot record money or read anything. Details: `MCP_ARCHITECTURE.md`, end.

## Progress log

Moved (verbatim) to [docs/archive/SECURITY_PROGRESS_LOG.md](docs/archive/SECURITY_PROGRESS_LOG.md) on 2026-10-25. It holds the dated, live-verified results behind every ticked item above.
