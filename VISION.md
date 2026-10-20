# The Office: where the vision lives (start here)

**Read in this order.** 1) this file, 2) `ENVELOPE.md` (the reply contract), 3) `CONTEXT.md` (what the app may tell the server), 4) `EXPERIENCE_BRIEF.md`, `DESIGN_CONSTITUTION_V2.md`, `OFFICE_CONSTITUTION.md`, `UI_MAP.md` (the older design documents), 5) the newest entries of `DECISIONS.md` (why things were built the way they were) and `RUNBOOK.md` (how they work).

## The principle (Pierre's)
**The intelligence thinks, the envelope projects, The Office becomes the experience.** The server decides what is true and what is allowed. The reply envelope only reports what a reply has ALREADY established and suggests how the app might present it. It is not an intent engine, not business logic and not an authorization mechanism: it grants nothing and executes nothing. Anything that needs permission still goes through the existing trusted routes.

## The envelope, in one screen (full contract: `ENVELOPE.md`)
One extra `experience` object on the reply of **two routes only: `POST /messages/text` and the voice-note route** (not the debug transcription route). Four parts kept apart: **established** (facts copied from the reply), **recommendation** (`speak`, `confirm` or `clarify`), **unknown** (an explicit list of what is not known), **mustStillPass** (what must still go through trusted execution). Phase 1 deliberately has NO intent classes, rooms, workspaces, evidence, certainty, `refuse` mode or stakes grading, because today's reply does not establish them; a permission refusal reaches the app only as words, and guessing from text is not allowed.

## The design doctrine (summary; Pierre's original text is the authority)
A quiet void with a persistent orb. Speech is transient, not a chat log. Rooms are task spaces. History is a RECORD, not the main experience. Reduced motion must be honoured. The interface projects what the server establishes; it does not decide. Inspect before changing, preserve working behaviour, report conflicts before redesigning, and measure performance before adding effects. **Pierre's full doctrine was pasted into chat and was never saved as a file: to make it authoritative, save his original text as `DESIGN_DOCTRINE.md`.**

## What is built (backend wrap-up, all live)
Reply envelope (Phase 1). Reports as data (profit and loss, aged debtors, aged creditors). Analysis layer (`GET /reports/analysis`: facts and calculations only, never a cause). History and audit (`GET /history`; records the two message routes). Workspace context (accepted, validated and recorded, NOT yet used to interpret speech). Billing and access cutoff. Customer emails (5b) are not built (needs an email provider key).

## What is NOT covered, said plainly
**Photo and document uploads are not wrapped in the envelope and are not recorded in history** (only the text and voice-note routes are). Extending the envelope or the history record to them would be NEW scope, not unfinished work. The app (Flutter) is built in small slices, each in RUNBOOK.md and DECISIONS.md. As of main `8d3a1f6`, per the commit log: slice 1 lapsed-business handling, slice 2 the owner's Subscription item, slice 3 reduced motion and labels, slice 4 reading the reply envelope, slice 6 an Activity room reading `GET /history`, slice 7 the analysis workspace, slice 8 sending workspace context (slice 5 was parked, with the reason in DECISIONS.md). **Nothing in the app has been verified on a device.** Check RUNBOOK.md for each slice's exact scope before assuming anything is finished.
