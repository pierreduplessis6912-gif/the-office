# The Office: where the vision lives (start here)

**Read in this order.** 1) this file, 2) `ENVELOPE.md` (the reply contract), 3) `CONTEXT.md` (what the app may tell the server), 4) `EXPERIENCE_BRIEF.md`, `DESIGN_CONSTITUTION_V2.md`, `OFFICE_CONSTITUTION.md`, `UI_MAP.md` (the older design documents), 5) the newest entries of `DECISIONS.md` (why things were built the way they were) and `RUNBOOK.md` (how they work).

## The principle (Pierre's)
**The intelligence thinks, the envelope projects, The Office becomes the experience.** The server decides what is true and what is allowed. The reply envelope only reports what a reply has ALREADY established and suggests how the app might present it. It is not an intent engine, not business logic and not an authorization mechanism: it grants nothing and executes nothing. Anything that needs permission still goes through the existing trusted routes.

## The envelope, in one screen (full contract: `ENVELOPE.md`)
One extra `experience` object on the reply of **two routes only: `POST /messages/text` and the voice-note route** (not the debug transcription route). Four parts kept apart: **established** (facts copied from the reply), **recommendation** (`speak`, `confirm` or `clarify`), **unknown** (an explicit list of what is not known), **mustStillPass** (what must still go through trusted execution). Phase 1 deliberately has NO intent classes, rooms, workspaces, evidence, certainty, `refuse` mode or stakes grading, because today's reply does not establish them; a permission refusal reaches the app only as words, and guessing from text is not allowed.

## The design doctrine (summary, kept for reference; superseded by PROJECTION_VISION.md)
A quiet void with a persistent orb. Speech is transient, not a chat log. Rooms are task spaces. History is a RECORD, not the main experience. Reduced motion must be honoured. The interface projects what the server establishes; it does not decide. Inspect before changing, preserve working behaviour, report conflicts before redesigning, and measure performance before adding effects. **Update 2026-10-20: Pierre confirmed the original doctrine existed only in chat and has been REPLACED by the projection layer vision (`PROJECTION_VISION.md`). There is no `DESIGN_DOCTRINE.md` to save; this summary is kept for reference only, and `PROJECTION_VISION.md` is the authority for where the design is heading.**

## What is built (backend wrap-up, all live)
Reply envelope (Phase 1). Reports as data (profit and loss, aged debtors, aged creditors). Analysis layer (`GET /reports/analysis`: facts and calculations only, never a cause). History and audit (`GET /history`; records the two message routes). Workspace context (accepted, validated and recorded, NOT yet used to interpret speech). Billing and access cutoff. Customer emails (5b) are not built (needs an email provider key).

## What is NOT covered, said plainly
**Photo and document uploads are not wrapped in the envelope and are not recorded in history** (only the text and voice-note routes are). Extending the envelope or the history record to them would be NEW scope, not unfinished work. The app (Flutter) is built in small slices, each in RUNBOOK.md and DECISIONS.md. As of main `8d3a1f6`, per the commit log: slice 1 lapsed-business handling, slice 2 the owner's Subscription item, slice 3 reduced motion and labels, slice 4 reading the reply envelope, slice 6 an Activity room reading `GET /history`, slice 7 the analysis workspace, slice 8 sending workspace context (slice 5 was parked, with the reason in DECISIONS.md). **Nothing in the app has been verified on a device.** Check RUNBOOK.md for each slice's exact scope before assuming anything is finished.

## The projection layer vision, and where the build stands (added 2026-10-20)
`PROJECTION_VISION.md` is the full design Pierre called "the vision" (written by an AI assistant in another chat; its own envelope is illustrative). It is the AIM; `ENVELOPE.md` and `CONTEXT.md` are what is BUILT. It replaces the earlier design doctrine (see above). Map, as of main `8d3a1f6`:

| Vision | Built | Gap |
| --- | --- | --- |
| Contract A, the reply envelope | `experience` on `POST /messages/text` and the voice-note route (`ENVELOPE.md`): established, recommendation, unknown, mustStillPass | No `replyId`, typed `references`, `content` blocks, `warnings` or `provenance.status`. `unknown` is a different idea from `warnings` |
| Modes (7) | 3: `speak`, `confirm`, `clarify` | No `open_room`, `update_workspace`, `analysis` or `refuse`. A refusal reaches the app only as words |
| Contract B, presentation model, policy, renderer registry | A defensive envelope reader (`app/lib/reply_envelope.dart`), used only to fill a gap in held actions. Rooms and the analysis sheet each fetch and draw their own data | No presentation policy, controller, content blocks (metric, table, record list, evidence, document) or registry |
| Contract C, the action boundary | Built and strong: confirm, reject and edit-field re-check authorization on every call; `mustStillPass`; decisions are recorded in history | Stale-action and replay behaviour not separately pinned |
| "Must never" list | Held: the server owns every figure; the analysis lists what it cannot establish; no widget is built from model output | none known |
| Orb state machine | `OfficeState` exists (idle, listening, thinking, a response state, room opening) | No explicit awaiting-input or error state; not driven by projection events |
| Typed money (`amountMinor` and currency) | Backend reports decimals (ZAR implied); the app holds doubles and only formats them | A representation difference to decide before the app handles more figures |
| Observability and contract tests | History and audit record (heard, interpreted, proposed, decided, written); backend and Dart each test the envelope | No shared fixture proving the backend and the app agree; no validation-outcome or renderer-failure logging |
| Scope: results of the intelligence | Text and voice go through the envelope and history | **Photo and document uploads feed the intelligence but have no envelope and no history record.** Room list fetches (snags, stock and so on) are not intelligence results and need none |
