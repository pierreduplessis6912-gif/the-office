> **Status:** real. **Verified:** not yet. **Owns:** none.

> Reference copy of the long handoff as it stood on 2026-11-07. The entry point is [HANDOFF.md](../HANDOFF.md); where they differ, that file and the live repository win.

# HANDOFF: continuing The Office work with any model

Written 2026-11-03 so work can continue when one assistant's usage runs out. It assumes NOTHING from earlier chats. Read it fully, then follow "First 10 minutes".

## Current priority (read this first)
**The mission is the product, not the engine.** The engine core on branch `engine-phase1` is the built, CI-green foundation, partly proven on real staging, **not merged and not deployed**. Its remaining verification items are **PARKED**: they block DEPLOYING, not BUILDING.

The next work is a **visible product slice, the Mokoena receivables scenario**: a persistent orb, a natural question, a permission-aware answer, drill-down to source records, back to conversation, then propose and approve a payment. It is checked against a **16-domain blueprint** so nothing ends up sales-specific.

**Nothing in it is authorised to build yet.** Pierre must choose: authorise the slice, or settle the build boundary first. Direction accepted 2026-11-02: rebuild the engine core on the retained platform substrate ([docs/decisions/engine-foundation.md](decisions/engine-foundation.md)). The 71-rule audit is kept as **evidence only, not a checklist**, and the register sequence is stopped.

**Not in this repository. Ask Pierre for them, never invent them:** the 71-rule audit, the 16-domain blueprint, and the first-slice definition. Once supplied, record them in `docs/` before relying on them.

## Who and how
- Pierre is a solo founder working **from a phone** (Termux and GitHub Actions). He wants direct answers, **one priority at a time**, results in chat (no long documents). **He decides.** Every build, staging run and merge needs his explicit approval.
- Evidence labels used everywhere: **[C]** code read, **[T]** automated test, **[X]** committed record of a real staging run, **[D]** public Cloudflare docs, **[I]** inference, **[U]** unknown. Never present [I] or [U] as fact. CI is authoritative; a local pass is not.

## Orient yourself: read in this order
1. **This file.** 2. [docs/PRODUCT_VISION.md](PRODUCT_VISION.md) and [docs/ROADMAP.md](ROADMAP.md). 3. [VISION.md](../VISION.md) (the projection layer: orb, envelope) and [HANDOVER.md](../HANDOVER.md) (the Mokoena scenario; older context). 4. The architecture that governs your task: [docs/decisions/engine-foundation.md](decisions/engine-foundation.md), [docs/decisions/investigation-foundation.md](decisions/investigation-foundation.md) (proposed), [DECISIONS.md](../DECISIONS.md), [FUTURE_CAPABILITIES.md](../FUTURE_CAPABILITIES.md), [SHIP_CHECKLIST.md](../SHIP_CHECKLIST.md), [OPEN_QUESTIONS.md](../OPEN_QUESTIONS.md). 5. **Establish the live repository state** (Working rules); never trust a commit id written in a document. 6. Restate the approval boundaries to Pierre before acting.

## Environments: what each kind of assistant can and cannot do
| Environment | Can | Cannot | Use it for |
|---|---|---|---|
| **Repository plus a shell** (for example Claude Code, or a command-line agent in Termux) | Everything in this file: read, run tests, run mutations on a copy, use CI | nothing relevant | All engineering. **Required for the first task.** |
| **Browse-only chat** (can read GitHub pages, often only URLs Pierre pastes) | Read code and diffs | Run tests or mutations; fetch a URL Pierre did not supply | A read-only review **from the review bundle**, labelled PARTIAL. The repository is public, so the bundle's pinned raw URLs should work. |
| **Chat-only, no network** | Reason about text Pierre pastes or attaches | Read the repository | A review from the attached bundle, labelled PARTIAL. |
- **A free chat session cannot do the engineering work, and no prompt changes that.** In the last session two such sessions correctly refused: they had no repository, shell or network. That is the right behaviour.
- **Say what you cannot do in your first reply.** Do not loop. If a tool refuses URLs Pierre did not supply, ask for **all** the URLs you need in **one** message; never ask twice.
- A review that did not run the mutations has **no evidence for check 4**. Do not give an acceptance recommendation on it.

## Where the last session stopped
- Documentation is complete and pushed (vision, roadmap, review bundle, this file).
- Pierre **re-prioritised from the engine review to the product slice**; this file now records that. The `da55997` review is **parked, not done**.
- **Credentials:** a classic GitHub token (scopes `repo`, `workflow`) was pasted into a chat twice so this file could be pushed. Treat it as exposed: **it must be revoked.** A new assistant needs a new fine-grained token from Pierre, scoped to this repo with a short expiry, supplied through a secret or environment setting and never pasted into a chat.
- A decision is waiting on Pierre: which repository-enabled environment he will use (a command-line agent in Termux, an agent inside GitHub Actions, or a cloud shell) and whether he has an API key or paid plan.

## Last verified state (re-check with git; the newest commit is usually a CI record, not code)
| Field | Value |
|---|---|
| Branch | `engine-phase1` (`main` is `30a249f`, untouched) |
| Last commit that changed production code (`worker/src`, migrations, `wrangler.toml`) | `243b3fa` |
| Last code commit with a green CI record | `da55997`: 9,353 of 9,353 default, 9,350 of 9,350 adapter, typecheck success (`ops/proof-tests-last.json`). The production code itself was last verified at `ec3baed` (run 41607411580). Commits after `da55997` were documentation only. |
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
Integrity verifier with 10 codes and an event model; tenant-isolation tests (router, object, front door, misroute) and an ownership test; the identity fix (an object refuses a claim that does not match its runtime name; verified on real staging objects); manifest validation before restore; the restore-verification fix **proven on real staging objects**; a copy-based, filterable breakage runner; staging modes `identity` and `restore-proof`; the documentation set (vision, roadmap, review bundle, this file).

## Approval ledger (nothing below is approved unless it says so)
| Item | Status |
|---|---|
| Mokoena first slice: stage one (question, evidence-bearing answer, drill-down, back to conversation), then stage two (propose and approve a payment) | **Not authorised.** Pierre chooses: authorise, or settle the build boundary first. |
| Build boundary (where it is built, fake API or real engine, which blueprint domains it is checked against) | **To be settled by Pierre** |
| Recording the 71-rule audit, the 16-domain blueprint and the first-slice definition in `docs/` | **Awaiting Pierre's content** |
| PARKED: review of `da55997`; authenticated post-deploy health gate; staging rehearsal of that gate and of a rollback; memory ramp test | **Not approved.** They block deploying, not building. |
| Production manifest validation (read-only) | **Separate approval, not given** |
| Recovery-gate acceptance | **Pierre's alone** |
| Setup script for a repository-enabled environment | Proposed, not built |
| Merge, deploy | **Pierre's call.** Not established as production-ready. |

## First task for the next model: the Mokoena slice decision brief (read only, no code)
Give Pierre, in at most 10 lines: (a) what the first slice would contain, split into **stage one** (question, evidence-bearing answer, drill-down, back to conversation) and **stage two** (propose and approve a payment); (b) what it would build on in `engine-phase1` (`GET /engine/receivables`, `GET /engine/records/:kind/:id`, `POST /engine/proposals` and the held-action confirm path) and what it would not need; (c) the **build boundary** Pierre must settle first: where it is built (`engine-phase1` or `main`; the web preview is published only from `main`), fake API or real engine, and which blueprint domains it is checked against; (d) what is still unknown (the three items not in the repository: ask for them). Then **WAIT for approval. Do not write code.**

## PARKED task: accept or reject `da55997` (read only; do not start unless Pierre asks)
`da55997` ("Object ownership: tests only") is committed and CI-green but **not reviewed**. Green CI does not show the tests prove the intended invariant. **Read the actual test code** (`tools/object-binding.test.js`, the new checks in `tools/business-object.test.js`, the mutations it added to `tools/engine-breakage.js`); do not infer coverage from test names or counts. Establish whether the tests:
1. exercise the REAL object lifecycle (the production class over a stand-in for Durable Object storage, not a re-implementation);
2. prove the binding is genuinely write-once, and that **an ordinary request cannot establish, change or reset ownership**;
3. cover a **missing**, a **malformed** and a **mismatched** stored binding, with the exact behaviour asserted;
4. **fail when the protection is deliberately removed**: for each claim name the mutation and run it on a copy with the established runner (`node tools/engine-breakage.js --only <text>`; it never touches the tree);
5. do not assert the first-claim binding on a runtime with no name as an acceptable security contract (it is a known limitation, not a guarantee).
**Report:** code evidence, test evidence, mutation evidence, gaps, unknowns, and an acceptance recommendation. Do not change code to make a test pass; Pierre decides.

**Review bundle (no browsing needed):** [docs/review/da55997-review-bundle.md](review/da55997-review-bundle.md) contains the commit's actual diff, the production code under test, pinned raw URLs and the mutation commands. A reviewer without a shell can read everything but the mutation evidence, and must say the review is partial.

**Not accepted policy:** the behaviours the commit lists as *Recorded, NOT endorsed* (the numbered list in the "Object ownership" section of [docs/decisions/engine-foundation.md](decisions/engine-foundation.md)) are open security-contract questions for Pierre. A passing suite does not accept them. The commit's own counts (40 checks, 15 identity-state checks, 6 mutations all caught) are claims to verify, not facts.

If Pierre un-parks this, report in this format and wait; the product slice does not wait on it.

## Known release blockers (they block DEPLOYING, not BUILDING)
1. The deploy smoke test is unauthenticated, so it cannot detect an object-level failure; it needs an authenticated gate (design in `engine-foundation.md`).
2. Production's real manifests have not been checked against the new validator.
3. The recovery gate is open. 4. Memory margin at size is unmeasured on a real object. 5. Not re-run end to end on staging at this exact head.
6. The ownership-boundary policy is undecided (whether a name mismatch on a bound object refuses or only reports; whether only authenticated provisioning may bind an object).

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
- Credentials: **no token is stored in the repo, and any token an earlier assistant used must be treated as expired or exposed.** Pierre must supply a new fine-grained token (Contents, Actions, Workflows read/write; scoped to this repo, short expiry). It must never be pasted into a chat or committed. Staging admin keys are GitHub Actions secrets, never visible to an assistant.

## Chat-only models (no repo access)
Ask Pierre to run in Termux and paste the output: `git fetch && git log -5 --oneline && git status`, then the one suite or command you need. Give him one command at a time. Do not guess file contents: ask for them.

## First 10 minutes (any model)
1. Read this file, then the vision and roadmap (Orient yourself). 2. Verify live state, changing nothing. 3. Tell Pierre in three lines what you found and that your first task is the slice decision brief. 4. Restate the approval boundaries. 5. Wait for his approval. 6. One item per turn; end with what is verified, what is not, and the next step.

## Paste this to start a new session (needs a repository and a shell)
"You are continuing work on The Office, a conversational business operating system (repo pierreduplessis6912-gif/the-office, branch engine-phase1). You have no memory of earlier chats; the repository is the memory. PRIORITY: the engine core on engine-phase1 is built, CI-green and partly proven on staging, but NOT merged and NOT deployed; its remaining verification items (including the da55997 review) are PARKED because they block deploying, not building. The real work is a visible product slice, the Mokoena receivables scenario (persistent orb, natural question, permission-aware answer, drill-down, back to conversation, then propose and approve a payment), checked against a 16-domain blueprint so nothing ends up sales-specific. NOTHING in it is authorised to build yet. Before proposing anything: read HANDOFF.md, docs/PRODUCT_VISION.md, docs/ROADMAP.md, VISION.md and HANDOVER.md and the engine decision docs they link; verify the LIVE git state without fetching or changing anything (git status, git log -5, git rev-parse HEAD, relation to origin) and do not trust commit ids in documents; restate the approval boundaries (never merge to main, never deploy, never touch production or staging, never expose a secret, a recommendation is not approval, never silently change an architectural decision). The 71-rule audit, the 16-domain blueprint and the first-slice definition are NOT in the repository: ask me for them and never invent them. Your first task is the slice decision brief in HANDOFF.md, read only, at most 10 lines, then wait for my approval; write no code. Never retry a Git operation or write after an uncertain timeout: check git status, git log -3 and git rev-parse HEAD first. Run long jobs detached. Label evidence as code read, test, real staging record, documentation, inference or unknown. Keep replies short, one priority at a time."

## Paste this instead if the model has no repository or network
"You are helping me continue work on The Office. You cannot see the repository, so I am attaching HANDOFF.md, VISION.md and HANDOVER.md. Read HANDOFF.md first and restate its current priority, hard limits and approval ledger in your own words. Then give the slice decision brief from the attached files only, labelled PARTIAL: at most 10 lines, covering the two stages of the Mokoena slice, what it would build on, the build boundary I must settle first, and what you still need from me (the 71-rule audit, the 16-domain blueprint, the first-slice definition). Change nothing. Never tell me to merge, deploy or touch production. Keep it short."
