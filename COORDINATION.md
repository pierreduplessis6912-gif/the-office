# Who is working on what (read this first, and READ THE CORRECTION BELOW)

**Correction, 2026-10-19 (Pierre).** This file was first written as if "two Claude sessions" were working here at once. **That is not established.** The repository's only collaborator is Pierre, who confirms he uses ONE chat on ONE device. Commits authored "Claude" appeared (14:22 to 15:00 UTC on 2026-10-19, and 06:05 to 06:19 earlier) that the visible chat did not make; all of them carry the identical identity `Claude <noreply@anthropic.com>`, so the author line cannot say which run made them. **The best-fitting (unverified) explanation is that the same instruction was executed in more than one ATTEMPT before the visible one, one after another: each attempt did one slice of the plan and left it in the repository for the next to find.** Whatever the cause, the protocol below prevents duplicated or colliding work.

**The protocol (every run, every time).**
1. **Check on arrival:** before building anything, compare the repository (`git log`, remote branches, queued workflow runs) with what you yourself did. On any commit you do not recognise, STOP, read it, and reconcile before building.
2. **Claim atomically, with the API (NOT a plain git push):** before starting a point, create the branch `claim/point-N` with GitHub's create-only call: `curl -X POST https://api.github.com/repos/pierreduplessis6912-gif/the-office/git/refs -d '{"ref":"refs/heads/claim/point-N","sha":"<current main sha>"}'` (with the token). It answers **201** the first time and **422 "Reference already exists"** to every later attempt, so only ONE run can claim a point; on a 422, someone already has it: do not start it. (A plain `git push` is NOT safe for this: pushing the same commit to an existing branch is a silent no-op, and a later commit can fast-forward it.) Then update the table below.
3. **Mark your commits:** every commit message ends with a line `Run: <id>`, an 8-character id made at the start of the run with `python3 -c "import uuid; print(uuid.uuid4().hex[:8])"` (the shell's `$RANDOM` is not available), so that if two runs ever commit in the same window the ids prove it.
4. **Trust the repository, not the status:** a workflow run's status can stay "queued" after it has finished; read the record it wrote (`ops/`) and what production reports it is running (the probe).

| Point | What | Claimed by | Status |
|---|---|---|---|
| 1 | Reports as data (profit and loss, aged debtors and creditors as JSON) | a prior attempt (labelled A in the first version) | DONE, merged and deployed (`e6cb537`) |
| 2 | The analysis layer (contributors, evidence, fact versus inference) | this run's attempt (labelled C) | DONE, merged and deployed (`d1a7380`) |
| 3 | A history and audit record (heard, interpreted, proposed, executed, replied) | this run (claim branch `claim/point-3-history`) | DONE, merged and deployed (`02987c2`) |
| 4 | Workspace context sent by the app | this run (claim branch `claim/point-4-context`) | DONE, merged (`5b50771`); see CONTEXT.md |
| 5a | Operations: a billing health check and a scheduled alert | a prior attempt (labelled B in the first version) | DONE, merged and deployed (`66bf474`) |
| 5b | Operations: customer e-mails for a failed payment, a coming lapse | a prior attempt (labelled B in the first version) | needs an e-mail provider key as a secret; can be built dark first |

Session B will touch: `worker/src/billing.ts` (a read-only health function), `worker/src/debug.ts` and `worker/src/admin-routes.ts` (one operator route), a new scheduled workflow, and a new email module. It will NOT touch the reply envelope, the reports module, the golden recordings or the Flutter app.

If a prior attempt (labelled A in the first version) has in fact claimed point 5, or intends to take a different order, say so here and a prior attempt (labelled B in the first version) will stop.

Session C (point 2) will touch: a NEW `worker/src/analysis.ts` and its test, the report routes in `worker/src/index.ts` (one added route, `/reports/analysis`), `worker/src/admin-routes.ts` only if an operator route is needed, the route-policy pins, and `ENVELOPE.md` only to ADD nothing to version 1 (the analysis is its own route). It reads `reports-data.ts` and does NOT change it. It will NOT touch billing, the email module, the reply envelope's code, or the Flutter app. Points 3 and 4 are not claimed by this run's attempt (labelled C) yet; whoever starts one adds a claim first.

Session C (point 3) will touch: a new `worker/src/history.ts` and its test, ONE new table created lazily in the business database, the text and voice-note handlers in `worker/src/index.ts` only to RECORD (a write after the reply is built, swallowed on failure so it can never change a reply), one read route for the history, the route-policy pins, and the golden recordings ONLY if a recorded reply changes (it should not). It will NOT touch billing, the email module, the reports or analysis modules, the envelope's code, or the Flutter app. Point 4 is not claimed yet.

**Status of the five backend wrap-up points (2026-10-19): 1 reports as data DONE; 2 analysis layer DONE; 3 history and audit record DONE; 4 workspace context DONE; 5 operations: 5a the billing health check and alert DONE, 5b customer emails for a failed payment or a coming lapse NOT built (it needs an email provider key from Pierre).** The front-end contracts are ENVELOPE.md (the reply envelope), CONTEXT.md (workspace context), and the routes `/reports/profit-and-loss|aged-debtors|aged-creditors`, `/reports/analysis`, `/history` and `/context/check`.

## Front end (Flutter app)

Front-end work is claimed with the same create-only call (`claim/frontend-N-<name>`). Slice 1 (`claim/frontend-1-audit`): audit against the doctrine, and handling a lapsed business with a shared client and a gate, DONE and merged; the app has tests and CI records `ops/app-compile-last.json`. **Nothing here is verified on a device.** Candidate next slices, none claimed: the owner's plans button; sending workspace context; reduced motion and accessibility; reading the reply envelope; a history view; an analysis view.
Slice 2 (`claim/frontend-2-plans-button`): the owner's Subscription drawer item, DONE and merged (not verified on a device). Still unclaimed: sending workspace context; reduced motion and accessibility; reading the reply envelope; a history view; an analysis view.


Ops (`claim/ops-lapse-check`): `prod-billing-state.yml` (test businesses only) sets and restores a subscription state; DONE and merged. Slices 1 and 2 verified on a device (2026-10-20). Ballz restored to active.

Slice 3 (`claim/frontend-3-motion-a11y`): reduced motion and screen-reader labels, DONE and merged (not verified on a device). Still unclaimed: sending workspace context; reading the reply envelope; a history view; an analysis view; tests for the rest of the app.

Slice 4 (`claim/frontend-4-envelope`): reading the reply envelope, DONE and merged (reader plus a gap-filling safety net; not verified on a device). Still unclaimed: sending workspace context; a history view; an analysis view; tests for the rest of the app.

Slice 5 (`claim/frontend-5-context`): PARKED, nothing built; reason in DECISIONS.md (no screen is on screen while a message is sent). Next in order: (c) history view, (d) analysis view, then context (b) under a new claim.
