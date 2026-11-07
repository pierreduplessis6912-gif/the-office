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
