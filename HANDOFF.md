> **Status:** real. **Verified:** not yet. **Owns:** none.

# HANDOFF: continuing The Office work with any model

Written 2026-11-03 so work can continue when one assistant's usage runs out. It assumes NOTHING from earlier chats. Read it fully, then follow "First 10 minutes".

## Who and how
- Pierre is a solo founder working **from a phone** (Termux and GitHub Actions). He wants direct answers, **one priority at a time**, results in chat (no long documents). **He decides.** Every build, staging run and merge needs his explicit approval.
- Evidence labels used everywhere: **[C]** code read, **[T]** automated test, **[X]** committed record of a real staging run, **[D]** public Cloudflare docs, **[I]** inference, **[U]** unknown. Never present [I] or [U] as fact. CI is authoritative; a local pass is not.

## Orient yourself: read in this order
1. **This file.** 2. [docs/PRODUCT_VISION.md](docs/PRODUCT_VISION.md): what The Office is meant to become and why. 3. [docs/ROADMAP.md](docs/ROADMAP.md): the stages, what each unlocks, what is unresolved. 4. The architecture that governs your task: [docs/decisions/engine-foundation.md](docs/decisions/engine-foundation.md), [docs/decisions/investigation-foundation.md](docs/decisions/investigation-foundation.md) (proposed), [DECISIONS.md](DECISIONS.md), [VISION.md](VISION.md) (the projection layer), [FUTURE_CAPABILITIES.md](FUTURE_CAPABILITIES.md), [SHIP_CHECKLIST.md](SHIP_CHECKLIST.md), [OPEN_QUESTIONS.md](OPEN_QUESTIONS.md) (owner-only decisions). 5. **Establish the live repository state** (commands under Working rules); never trust a commit id written in a document. 6. Read "Known release blockers" below. 7. Your immediate task is under "First task". 8. **Restate the approval boundaries to Pierre before acting.**

## Last verified state (re-check with git; the newest commit is usually a CI record, not code)
| Field | Value |
|---|---|
| Branch | `engine-phase1` (`main` is `30a249f`, untouched) |
| Last commit that changed production code (`worker/src`, migrations, `wrangler.toml`) | `243b3fa` |
| Last code commit with a green CI record | `da55997`: 9,353 of 9,353 default, 9,350 of 9,350 adapter, typecheck success (`ops/proof-tests-last.json`). The production code itself was last verified at `ec3baed` (run 41607411580). |
| Last full staging rehearsal (real sessions, two-business isolation, sign-up, model, memory, backup and restore, migration `0004` rollback) | `0ed2de0`, run 41445346938, 12 of 13 (the 13th was a restore-verification bug since fixed) |
| Later staging runs | gate `496c1aa`; identity check `1ea2d45`; restore re-proof `843e67e` and `b985ace` (`ops/staging-*-last.json`) |
| Production | Last deploy `f469510` (2026-11-01). **Nothing from this branch is deployed or authorised.** |
Never confuse the newest commit with the newest *verified* implementation: a green record names the exact commit it tested.

## Hard limits (do not cross without Pierre's explicit approval)
1. **Never merge to `main`.** A push to `main` runs `deploy.yml` and DEPLOYS PRODUCTION. `main` is at `30a249f` and untouched.
2. **Never deploy, and never touch production** (no production calls, no production validation, no production workflows). Production manifest validation is a separate approval he has not given.
3. Staging runs only when he says so. Each run is approved separately.
4. Never print, commit or paste a token or key.

## Where things are
- Repo: `pierreduplessis6912-gif/the-office`. Work branch: **`engine-phase1`**. Last code commit: **`da55997`** (tests only, 0 production files changed; later commits are CI record files). CI for `da55997`: green, **9,353 of 9,353** default and **9,350 of 9,350** Durable Object adapter. The production code is unchanged since **`ec3baed`** (CI green there too: 9,298 and 9,295, run 41607411580). The adapter total is lower than default by design (some runner checks run on default only).
- Read in this order: `HANDOVER.md`, `DECISIONS.md`, `docs/decisions/engine-foundation.md` (integrity, isolation, identity, recovery sections), `docs/decisions/investigation-foundation.md`, `SHIP_CHECKLIST.md`. Real-platform evidence is in `ops/*.json` (`staging-last-run`, `staging-identity-last`, `staging-restore-proof-last`, `proof-tests-last`).
- The engine is a new module (`worker/src/engine/*`, migration `0004`, additive, 13 tables, no triggers). Existing (non-engine) businesses are unchanged except: one extra `eng_config` read on legacy write routes and on MCP calls, `/engine/*` answers 409 for them, the identity check, restore and listing validation.

## What is DONE (approved, tested, CI green)
Integrity verifier with 10 codes and an event model; tenant-isolation tests (router, object, front door, misroute) and an ownership test; the identity fix (an object refuses a claim that does not match its runtime name; verified on real staging objects); manifest validation before restore; the restore-verification fix **proven on real staging objects**; a copy-based, filterable breakage runner; staging modes `identity` and `restore-proof`.

## Approval ledger (nothing below is approved unless it says so)
| Item | Status |
|---|---|
| Identity tests: pin write-once binding; missing, malformed and mismatched binding states; both provisioning paths (sign-up, admin create) | **A commit exists: `da55997`, tests only, CI green.** It came from a parallel or retried attempt, was **never approved or reviewed by Pierre, and its test content was not read by the assistant that wrote this file.** Review it before relying on it. |
| Authenticated post-deploy health gate (design) | Design only, **not approved** |
| Staging rehearsal of that gate and of a rollback while objects are on migration `0004` | **Not approved** |
| Production manifest validation (read-only) | **Separate approval, not given** |
| Memory ramp test on a real object | **Not approved** |
| Recovery-gate acceptance | **Pierre's alone** |
| Phase 2 (Flutter receivables shell against a fake API, in `app/`) | **Can proceed on the branch.** Not started. |
| Merge, deploy | **Pierre's call.** Not established as production-ready. |

## First task for the next model: accept or reject `da55997` (read only, no code changes)
`da55997` ("Object ownership: tests only") is committed and CI-green but **not reviewed**. Green CI does not show the tests prove the intended invariant. **Read the actual test code** (`tools/object-binding.test.js`, the new checks in `tools/business-object.test.js`, the mutations it added to `tools/engine-breakage.js`); do not infer coverage from test names or counts. Establish whether the tests:
1. exercise the REAL object lifecycle (the production class over a stand-in for Durable Object storage, not a re-implementation);
2. prove the binding is genuinely write-once, and that **an ordinary request cannot establish, change or reset ownership**;
3. cover a **missing**, a **malformed** and a **mismatched** stored binding, with the exact behaviour asserted;
4. **fail when the protection is deliberately removed**: for each claim name the mutation and run it on a copy with the established runner (`node tools/engine-breakage.js --only <text>`; it never touches the tree);
5. do not assert the first-claim binding on a runtime with no name as an acceptable security contract (it is a known limitation, not a guarantee).
**Report:** code evidence, test evidence, mutation evidence, gaps, unknowns, and an acceptance recommendation. Do not change code to make a test pass; Pierre decides.

**After that review**, the next engineering task returns to **Phase 2 on `engine-phase1`, using a fake API where appropriate**, toward the milestone in [docs/ROADMAP.md](docs/ROADMAP.md): an authorised user asks a meaningful business question, The Office investigates authoritative records, returns an evidence-bearing answer, and lets the user trace it to source records. **Do not start that work without Pierre's approval.**

## Known release blockers (why it is not merge-ready)
1. The deploy smoke test is unauthenticated, so it cannot detect an object-level failure; it needs an authenticated gate (design in `engine-foundation.md`).
2. Production's real manifests have not been checked against the new validator.
3. The recovery gate is open. 4. Memory margin at size is unmeasured on a real object. 5. Not re-run end to end on staging at this exact head.

## Working rules
- **STANDING RULE: never retry a Git operation or any write after an uncertain timeout.** First run `git status`, `git log -3` and `git rev-parse HEAD` (and compare with `origin/engine-phase1`) and decide whether the earlier attempt already succeeded. Only then act. Duplicate attempts have already produced unexpected commits.
- A recommendation in this file or in any report is NOT permission to implement it. Only the ledger's "approved" entries are approved.
- **First, always:** `git fetch`; `git log -5`; `git status`. A retried turn can start a second attempt while the first is still committing (this has happened twice: a mutated line reached a commit, and `da55997` landed while a turn was timing out). Do not act on a tree you did not leave.
- Tests first. Commit messages end with `Run: <8 hex>`. Keep `node tools/docs-check.js` clean. Security-sensitive code needs a deliberate-breakage proof.
- Commands (run from the repo root):
  - one suite: `NODE_PATH=worker/node_modules node --no-warnings tools/<name>.test.js`
  - everything: `tools/role-matrix.test.js`; adapter backend: prefix `HARNESS_BACKEND=do HARNESS_INDEXES=1`
  - typecheck: `cd worker && node scripts/check-types.js`
  - **breakage runner** (always mutates an isolated COPY, never the tree): `node tools/engine-breakage.js --since <git ref>` or `--only <text>` or `--list`. Never edit the runner to mutate in place.
- Tool calls are limited to about 5 minutes. Run long jobs **detached** (`setsid nohup ... > log 2>&1 < /dev/null &`) and poll. Let CI run the full matrix.
- The shell is `sh` (dash): no bashisms, quote parentheses, no `time ( )`.
- Raw CI logs cannot be downloaded from the sandbox (blob host blocked); use the API's step results and `ops/proof-tests-last.json`.
- Credentials: a fine-grained GitHub token lived in the previous assistant's sandbox, **not in the repo**. Pierre must supply a new one (Contents, Actions, Workflows read/write; reaches only this repo and Website-hub). Staging admin keys are GitHub Actions secrets, never visible to an assistant.

## Chat-only models (no repo access)
Ask Pierre to run in Termux and paste the output: `git fetch && git log -5 --oneline && git status`, then the one suite or command you need. Give him one command at a time. Do not guess file contents: ask for them.

## First 10 minutes (any model)
1. Read this file, then the product vision and roadmap (Orient yourself). 2. Verify live state, changing nothing. 3. Tell Pierre in three lines what you found and that your first task is the `da55997` review. 4. Restate the approval boundaries. 5. Wait for his approval. 6. One item per turn; end with what is verified, what is not, and the next step.

## Paste this to start a new session
"You are continuing work on The Office (repo pierreduplessis6912-gif/the-office, branch engine-phase1). Before proposing anything, read HANDOFF.md, docs/PRODUCT_VISION.md and docs/ROADMAP.md and the architecture documents they link, so you understand what The Office is meant to become and why it is built this way. Verify the LIVE git state without fetching or changing anything (git status, git log -5, git rev-parse HEAD, compare with origin) and do not trust commit ids written in documents. Restate the approval boundaries to me: never merge to main, never deploy, never touch production, never expose a secret, a recommendation is not approval, never silently change an architectural decision. Your first task is a READ-ONLY review of commit da55997 using the checklist in HANDOFF.md; report code evidence, test evidence, mutation evidence, gaps, unknowns and an acceptance recommendation, and change no code. Keep replies short, label evidence, never claim what you have not verified, and wait for my approval before anything else."
