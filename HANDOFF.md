> **Status:** real. **Verified:** not yet. **Owns:** none.

# HANDOFF: continuing The Office work with any model

Written 2026-11-03 so work can continue when one assistant's usage runs out. It assumes NOTHING from earlier chats. Read it fully, then follow "First 10 minutes".

## Who and how
- Pierre is a solo founder working **from a phone** (Termux and GitHub Actions). He wants direct answers, **one priority at a time**, results in chat (no long documents). **He decides.** Every build, staging run and merge needs his explicit approval.
- Evidence labels used everywhere: **[C]** code read, **[T]** automated test, **[X]** committed record of a real staging run, **[D]** public Cloudflare docs, **[I]** inference, **[U]** unknown. Never present [I] or [U] as fact. CI is authoritative; a local pass is not.

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

## Known release blockers (why it is not merge-ready)
1. The deploy smoke test is unauthenticated, so it cannot detect an object-level failure; it needs an authenticated gate (design in `engine-foundation.md`).
2. Production's real manifests have not been checked against the new validator.
3. The recovery gate is open. 4. Memory margin at size is unmeasured on a real object. 5. Not re-run end to end on staging at this exact head.

## Working rules
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
1. Read this file and `HANDOVER.md`. 2. Verify state (above). 3. Tell Pierre in three lines what you found and which single item from the ledger you propose. 4. Wait for his approval. 5. Do one item per turn; end with what is verified, what is not, and the next step.

## Paste this to start a new session
"You are continuing work on The Office (repo pierreduplessis6912-gif/the-office, branch engine-phase1). Read HANDOFF.md and HANDOVER.md first. Do not merge, deploy, or touch production. Verify git state, tell me in three lines what you find and which one ledger item you propose, then wait for my approval. Keep replies short, label evidence, never claim what you have not verified."
