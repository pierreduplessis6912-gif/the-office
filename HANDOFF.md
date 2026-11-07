> **Status:** real. **Verified:** not yet. **Owns:** none.

# HANDOFF: start here (short; detail lives in the linked documents)

## Rule zero
Anything decided in a chat must be committed to this repository in that session. If it is not in the repo, treat it as **unverified**, however confidently a summary states it. (The sections below exist because this rule was broken: the architecture report, the 16-domain blueprint and the first-slice definition were written in a chat on 2026-11-02 and never committed. They were recovered on 2026-11-07.)

## Where we are
- **Built:** the engine core on branch `engine-phase1` (events, facts, documents, payments, reversals, integrity checks, isolation tests). CI-green, partly proven on real staging, **not merged, not deployed**.
- **Direction (Pierre, 2026-11-02):** rebuild the engine core on the retained platform substrate. Read [the verdict](docs/audit/ARCHITECTURE_VERDICT_2026-11-02.md), [the 16-domain blueprint](docs/audit/DOMAIN_BLUEPRINT_2026-11-02.md), then the full [Architecture decision report](docs/audit/ARCHITECTURE_DECISION_REPORT_2026-11-02.md) and the [Amended implementation proposal](docs/audit/AMENDED_IMPLEMENTATION_PROPOSAL_2026-11-02.md) (the amended one wins where they differ).

## What is next: the first slice
**The Mokoena receivables slice:** [docs/decisions/first-slice.md](docs/decisions/first-slice.md). A person asks "What does Mokoena owe me?", gets an answer with its provenance, drills to the invoices and one invoice, returns to the conversation, records R500 (held, then approved), and a second business without the capability is answered honestly. It is shown in the app with the persistent orb.
- **In progress:** two commits by the build chat, `e4b01c3` (backend contract tests) and `864a332` (the app shell's model, tests first). Check `git log` for later ones.
- **Decisions reported by the build chat (Pierre's, recorded nowhere else):** build on `engine-phase1`, no merge; the question is scripted against the real read endpoints in the test harness; stage two proposes and confirms a payment through the real engine in the harness, not staging.
- **Boundary:** no production, no staging, no merge, until Pierre says so. A repository record of his approval of the slice does not exist yet.

## Still missing from the repository (ask Pierre; never invent)
The 71-rule decision register (kept as evidence only, not a checklist; it is in the 2026-11-01 session transcript, not yet extracted).

## Parked (they block deploying, not building)
Review of commit `da55997`; an authenticated post-deploy health gate; production manifest validation (a separate approval, not given); the memory test on a real object; the recovery-gate decision (Pierre's alone).

## Hard limits
Never merge to `main` (that deploys production). Never deploy or touch production or staging without approval. Never expose a credential. A recommendation is not approval. Never silently change an architectural decision.

## How to start
1. Read this file, then [docs/decisions/first-slice.md](docs/decisions/first-slice.md), [docs/PRODUCT_VISION.md](docs/PRODUCT_VISION.md) and [docs/ROADMAP.md](docs/ROADMAP.md).
2. Verify the live git state without changing anything (`git status`, `git log -5`, `git rev-parse HEAD`, relation to origin). Never trust a commit id in a document.
3. Restate the hard limits. Work one item at a time and wait for Pierre's approval before anything beyond reading.

## Working rules
Never retry a Git operation or a write after an uncertain timeout; check state first. Run long jobs detached; tool calls time out at about 5 minutes. Label evidence as code, test, staging record, documentation, inference or unknown. A free chat with no repository and shell cannot do engineering work: say so, do not loop. The full earlier handoff (approval ledger, last verified state, commands, release blockers, start prompts) is in [docs/HANDOFF_REFERENCE.md](docs/HANDOFF_REFERENCE.md).
