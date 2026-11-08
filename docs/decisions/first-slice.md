> **Status:** proposed. **Verified:** not yet. **Owns:** none.

> Parts A and B are verbatim from [the Architecture decision report](../audit/ARCHITECTURE_DECISION_REPORT_2026-11-02.md) (section 8) and [the Amended implementation proposal](../audit/AMENDED_IMPLEMENTATION_PROPOSAL_2026-11-02.md) (section 5). Part C is added from the engine's sample seed (`worker/src/engine/admin.ts`) and is NOT part of the originals. The amended version supersedes the original where they differ. **Proposed, not approved by a repository record; work has begun on this branch (see HANDOFF.md).**

# First slice: the Mokoena receivables scenario

## A. First working product slice (as first proposed)
**Scenario:** two synthetic businesses with different capability sets, and the sales end of the chain.
1. You speak or type: "What does Mokoena owe me?"
2. Business A answers from its own data, with the permitted detail, and says where the figures come from.
3. You drill to the invoices, then to one invoice with its payments, and return to the conversation with context intact.
4. You say "Record R500 from Mokoena." It is held, you approve it, and the answer changes.
5. In Business B, where the capability is not available, the same sentence is kept, answered honestly, and recorded as an observation.

**Acceptance criteria**
- Exact money (integer units).
- A payment allocation record exists.
- Outstanding has one derivation.
- A restricted member is refused with a reason, and sees no figures.
- Availability, permission and validity each fail independently.
- Executed atomically, with an outcome event and provenance.
- An unavailable request writes only the capture and an observation.
- No cross-business access.
- A restore drill passes on the new schema.
- Everything runs in CI on both backends.
- Interpretation is scripted first.

## B. The visible slice with Flutter (as amended after Pierre's review)

**Smallest viable path** [C: facts about the current app]
- Reuse: `reply_envelope.dart`, `runtime/office_state.dart` (the orb's states), `access_guard.dart`, `workspace_context.dart` and the refusal view. The envelope already carries provenance (`from`), refusals, held actions, candidates, a `room` for drill-down, and a confirmation flag.
- **Extract by copy:** the `FilamentOrb`, about 145 lines and self-contained, and sign-in with session handling, about 100 lines tied to the main state class. `main.dart` stays untouched until the slice passes.
- Build a new entry, `engine_main.dart`, of roughly 900 to 1,200 lines. It holds the persistent orb above the navigator, a conversation list, an answer card, a drill sheet, an approval card and a trace sheet.
- Deliver through the web preview on your phone's browser. That is quicker than an APK. It needs one workflow addition: a build target for the new entry. Today's preview builds only `main.dart` (`deploy-web-preview.yml:59`).
- Typed input first. Voice comes later.

**Complete acceptance criteria**
- **Interface**
  1. Opening the app shows the orb in its idle state, and it stays visible during drill-down.
  2. A typed question returns an answer from recorded outcomes, with provenance shown.
  3. Drilling opens the invoice list, then one invoice with its lines, allocations and trace. Returning keeps the conversation and its context.
  4. "Record R500 from Mokoena" produces an approval card. Approving updates the figures, and the trace shows capture, interpretation, proposal, approval and event.
  5. A restricted member (installer or sales) gets a refusal with no figures.
  6. A business where the capability is unavailable gets an honest answer, and only a capture and an observation are written.
- **Foundations**
  7. All twelve invariants in section 3 hold under test.
  8. Two engine businesses cannot see each other's data.
  9. Availability, permission and validity fail independently.
- **Process**
  10. Everything runs in CI on both backends.
  11. A staging rehearsal and a restore drill pass on the engine tables.
  12. Flutter widget tests cover flows 1 to 6 against a fake API.
  13. Interpretation is scripted in CI. One model-backed run is recorded, with your approval.

## C. What the engine's sample seed provides (added; not part of the originals)
- **Mokoena** (person, customer). **Invoice #1**, 2026-10-01: Vinyl plank, 2.000 m2 at R500.00. Net R1,000.00, tax 15% R150.00, **gross R1,150.00**.
- A payment of **R300.00** was first recorded against Patel Builders by mistake, then corrected to Mokoena (a reversal and a replacement) and allocated to invoice #1. **Outstanding R850.00.**
- "Record R500 from Mokoena", allocated oldest first to invoice #1, leaves **R350.00** outstanding.
- **Patel Builders** has invoice #2 (2026-10-02, Skirting, gross R460.00, unpaid). It must never appear in Mokoena's answer.
- The seed has one business. **Business B**, with the capability unavailable, has to be created in the tests.

## D. Build status against section B (added 2026-11-07 by the build chat; evidence labels: [T] test, [X] committed staging record, [D] documentation, [U] unknown)
The backend contract is walked in `tools/slice-mokoena.test.js` (40 checks, in the section C world built by the engine's own sample-seed admin route, on the harness: NOT staging); the app's reader and journey model is `app/lib/slice_model.dart` with `app/test/slice_model_test.dart`, which reads the engine's real answers saved in `app/test/fixtures/slice/` (generated by `tools/slice-fixtures.js`; the backend test fails if a fixture drifts). These are characterisation checks of existing engine behaviour, not red-first. The first screen step (the orb, a typed question and the answer card) is built in `app/lib/engine/`; `app/lib/engine_main.dart` is a separate demo entry point (the shell on the recorded answers, with a menu to switch who is asking), and `.github/workflows/deploy-engine-preview.yml` publishes it to a PREVIEW alias when the branch `engine-preview` is pushed (Pierre's decision each time; it ran once on 2026-11-07, run 42462823185 at `f5254c8`, with success), but nobody has yet confirmed what it looks like on a phone.

| # | Criterion | Status |
|---|---|---|
| 1 | Orb idle and visible during drill-down | Partly [T, CI at `63ad182`]: `app/lib/engine/engine_shell.dart` shows the persistent orb (the FilamentOrb extracted by copy, `engine_orb.dart`) from the start and keeps it while a question is answered; widget-tested. Drill-down screens are not built, and there is no entry point or preview target yet |
| 2 | Typed question, answer with provenance | [T, CI at `63ad182`]: a typed question (understood by a scripted pattern) brings an answer card with the customer, R850.00, invoice #1, issued, paid and outstanding, and the named source and account version; a restricted member, a business without the capability, an unknown customer, an unscripted question and two same-named customers are each answered honestly (`engine_shell_test.dart`, against the real fixtures through a fake API). Provenance is only a version and a free-text label. Not yet seen on a phone |
| 3 | Drill to invoices, one invoice, return | [T, CI at `b5caefc`]: tapping the invoice opens it as a room (the orb stays) with its figures and where they were derived, its line, its payments with the correction (the reversed R300.00 and the one that stands), what it connects to and its history; the customer and a reversed payment open as records of their own; back steps one level at a time and Back to the conversation returns the answer (`engine_shell_test.dart`, against the real fixtures through a fake API). The history now shows the trail on facts recorded through an approved proposal (capture, proposal, approver, contract), as a line under the entry in the room. The capture is shown by id, not its words. Not yet seen on a phone |
| 4 | "Record R500" approval card; figures update; trace | [T, CI at `35d99de`]: "Record R500 from Mokoena" (scripted; only for the customer whose answer is on screen) is proposed and HELD; the approval view shows the customer and invoice by name (read through record reads), the amount, the exact allocation (R500.00 to invoice #1), what was said and the account version, with the oldest-first allocation and today's date marked as the Office's assumptions (audit decision D2); nothing is recorded until approval; approving re-reads the answer (R350.00, paid R800.00); a member who may not record is refused in the engine's words; a stale approval is refused and nothing is said to be recorded; leaving the approval keeps the payment held and says so (`engine_shell_test.dart`, against the real fixtures through a fake API, which records what the shell sent). After approval the invoice's history shows the new allocation with its trail (capture, proposal, approver, contract). There is no reject action, so a held payment can only be approved or left waiting. Not yet seen on a phone |
| 5 | Restricted member refused, no figures | Backend [T]. The refusal view exists for legacy envelopes only [D]; no engine screen |
| 6 | Business without the capability answered honestly | [T]: 409 `capability_unavailable`, no figure; a proposal writes only a capture and an observation. No screen |
| 7 | Twelve invariants hold under test | Mapped in part E: eleven covered (including 6, provenance, closed 2026-11-07), one partly (5, a single derivation per position) |
| 8 | Two engine businesses cannot see each other | Existing isolation suites [T], local stand-in; real staging objects [X] |
| 9 | Availability, permission, validity fail independently | [T]: unavailable 409, not_permitted 403, stale 409 in this slice's test, plus `engine-operations.test.js` |
| 10 | CI on both backends | [X] green at `864a332` (default and adapter); later commits pending their records |
| 11 | Staging rehearsal and restore drill on the engine tables | [X] exist (see `ops/staging-*-last.json`); the recovery gate is still open |
| 12 | Flutter widget tests for flows 1 to 6 against a fake API | Not built. Only model tests exist, with fixtures standing in for the API |
| 13 | Interpretation scripted in CI; one model-backed run | The question is scripted in the tests [T]. No model-backed run: needs Pierre's approval |

## E. The twelve invariants against the tests (criterion 7; added 2026-11-07 by the build chat; evidence labels: [T] test, [C] code read, [D] documentation, [U] unknown)
The invariants are section 3 of `docs/audit/AMENDED_IMPLEMENTATION_PROPOSAL_2026-11-02.md`. This is the build chat's reading of the engine suites (`tools/engine-*.test.js`) and `worker/src/engine/`; it ran no new engine test for it. Eleven are covered (invariant 6 after the provenance change described below) and one partly.

| # | Invariant | Status |
|---|---|---|
| 1 | Money and quantities are integers | Covered [T]: a fractional quantity is refused (no floating point), an allocation must be whole minor units, and a total is exact beyond 2^53 (`engine-schema`, `engine-ledger`) |
| 2 | Recorded facts are append-only | Covered by absence and detection [C, T]: no update or delete write path exists, only `eng_config`, `eng_draft` and `eng_observation` are mutable (`MUTABLE_TABLES`), and a row deleted around the engine is DETECTED by the integrity verifier (`engine-integrity`). It is not blocked by database triggers, because the migration runner cannot carry them [T, `engine-schema`] |
| 3 | Foreign keys are enforced | Covered [T] (`engine-schema`: lines, allocations and events pointing at nothing are refused) |
| 4 | Allocations are conserved | Covered [T]: zero and non-whole allocations are refused, a payment is never allocated across currencies, and an over-allocation written around the engine is detected (`over_allocated`). A held payment that over-allocates at confirm is refused [C]; I did not find a test that names it [U] |
| 5 | Each position has one derivation | Partly: every derived figure names its derivation (`derivedBy`) and reads go through the ledger module [T, C]; no test asserts that two paths cannot disagree [U] |
| 6 | Every record carries provenance (capture, proposal, approval) | Covered [T, CI at `0cdfc1e`: backend 9400 of 9400 with the Durable Object adapter suite passing, typecheck passing; app analyze 0 errors, 245 tests, web build]. When an engine payment is held, the door records an interpretation (the capture, the capability, the held action); at confirm the engine finds that capture again and every event the approval writes (payment, allocation, execution) carries the capture, the proposal, the approver and the contract and version; a record's history shows them, and shows none (null) for a fact written without a proposal. Limits: the capture is shown by its id, not its words; the interpreter is recorded as `script` unless the caller says `model` (today the only interpreter is the app's scripted one); refused proposals write no interpretation; a held action written by other code has no interpretation, so no capture
| 7 | Execution only from an approved proposal, approval rechecked | Covered [T]: an installer cannot confirm (403), a stale approval is refused, a malformed held action is refused at confirm, and the same proposal cannot execute twice (`engine-schema`, `engine-operations`, `slice-mokoena`) |
| 8 | Execution and its outcome are one atomic transaction, with an idempotency key | Covered on the Durable Object adapter [T]: a failure at each write of issuing leaves nothing behind, and a proposal executes once. The route-level failure-injection loop needs transactions, which the harness lacks (`engine-operations`) |
| 9 | Tenant isolation | Covered [T]: 12 checks in `engine-isolation` (router, front door, misroute). A staging record exists [X]; I have not re-read it |
| 10 | Availability, permission and validity are checked server-side | Covered [T]: unavailable (409), not permitted (403), invalid payload and stale are different answers, and the interface cannot change the result |
| 11 | Responses come from recorded outcomes; a refusal reveals nothing | Covered [T]: refusals carry no figure, and a hidden record answers exactly as a missing one (`slice-mokoena`) |
| 12 | An unavailable or unsupported request writes a capture and an observation, nothing else | Covered [T]: an unavailable proposal writes only a capture and an observation, a refused one only a capture, and an unavailable READ writes nothing at all (a read has no capture) |

**Invariant 6 was the one real gap and was closed on 2026-11-07** (the change above). It is additive engine code with no schema change and no legacy table touched; a first attempt that added a column to the legacy `pending_actions` table was dropped because it changed every recorded legacy snapshot. The coupling between the legacy door and the engine is unchanged (the engine's own contracts carry the provenance as hooks), which the ownership checks R4 and R5 pin. Three existing engine tests were changed on purpose: a held proposal now also writes an interpretation, `eng_interpretation` has exactly one writer (`engine/facts.ts`), and the fit test no longer inserts its own interpretation.
