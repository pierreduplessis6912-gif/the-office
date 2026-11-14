> **Status:** approved by Pierre 2026-11-14 ("Approved", taken as approval with the stated defaults). **Verified:** not yet. **Owns:** none.

# DECISIONS: app-connection (how the app reaches a real engine business)

Written 2026-11-14 by the build chat, suggested step (a) of `docs/RESUME.md`. A DESIGN FOR APPROVAL: it authorises no code, no merge, no deploy, no staging run. Evidence labels: [C] code read, [T] test, [D] documentation, [I] inference, [U] unknown. Builds on `engine-legacy-coexistence-scoping.md` (option B, migrate per business) and does not change any architectural decision in it.

## What already exists [C, T]
- **One session, one business.** A signed session carries the business it was made for; the Worker forwards to that business's object and an object refuses a session made for another (`auth.ts`). Sign-in, the bearer token and roles need no change.
- **Per-business mode.** A business is ENGINE or LEGACY (`eng_config` key `mode`), never both; `engineModeGate` refuses `/engine/*` in a legacy business and legacy business writes (including `POST /messages/text` and `/files/*`) in an engine business (`boundary.ts`, `tools/engine-boundary.test.js`). The held-action lifecycle (`/actions/pending`, confirm, reject) is shared.
- **Engine routes the app could call:** about 25 reads (`/engine/receivables`, parties, quotations, expenses, purchase orders, supplier invoices, items, stock and its reports, margin and others), `POST /engine/proposals` (any held write) and `POST /engine/interpret` (the model reads a sentence).
- **A real client that nothing uses:** `app/lib/engine/http_engine_api.dart` covers only four calls (receivables, a record, propose a payment, interpret). The shell (`engine_shell.dart`) runs on recorded answers in a separate entry point (`engine_main.dart`). `lib/main.dart` (10,290 lines) calls the legacy routes only.
- **Only door into engine mode today:** the staging-only `POST /admin/engine/provision-sample` [C]. A real business cannot become an engine business.

## The decisions needed

### 1. Sign-in: no change (recommended)
Use the existing sign-in and bearer session. Nothing new to build or secure. Alternative (a separate engine sign-in) adds a second identity path for no gain and is rejected [I].

### 2. Which business, and how the app knows (recommended)
The server tells the app the mode of the signed-in business; the app chooses the shell from that. Today there is no way to ask: `GET /engine/business` is refused in a legacy business. Proposed: one small platform read (or a field in the existing sign-in or bootstrap answer) returning `mode: "engine" | "legacy"`, allowed in both modes, classified in `ROUTE_POLICY.md` and `boundary.ts`. One app build, two shells, selected per business. A legacy business sees no change at all.

### 3. What ships, and how (recommended: three stages, each on Pierre's word)
1. **Preview, no real business.** The engine shell, on the real client, against a STAGING engine business seeded by `provision-sample`, published to the existing preview alias (`engine-preview`, never production). Pierre tries it on his phone. Exit: he says it behaves.
2. **Pilot.** His own flooring business, migrated per the coexistence scope (import with a reconciliation report he has seen, snapshot first, mode flip as the last write, legacy tables read-only for a rollback window). Exit: his word after living in it.
3. **Merge to `main`.** Only after a real-platform recovery rehearsal and his explicit word. Until then the live app builds from `main` and contains none of this.
Nothing in stages 2 and 3 is started by approving this document.

### 4. How a conversation reaches the engine (recommended)
In an engine business the shell sends text to `POST /engine/interpret` and proposes through `POST /engine/proposals`; the legacy `POST /messages/text` stays refused there (the boundary already does that). The model only reads; every write is held for approval; the approval card is the existing shared lifecycle. No change to the doctrine that the engine holds the truth.

### 5. The client work this implies (listed, not started)
- Widen `EngineApi`/`HttpEngineApi` from 4 calls to the reads and proposals the shell needs, with the same rules (https only, token never stored or logged, safe path segments).
- Screens for the capabilities that have none: parties, quotations, invoices, orders, bills, expenses, stock (each a row in the capability map; the A box).
- The mode switch in `main.dart` (small, at the top) and the pending-approvals list for engine actions.
- Contract tests: the fixtures must be generated from the real engine's answers, as `tools/slice-fixtures.js` does today, so the app and engine cannot drift.

### 6. Gaps this design does NOT close (stated so they are not forgotten)
- **Voice notes, photos and documents.** In an engine business `/files/*` is refused and there is no engine capture path. The product is voice-first, so this is on the critical path to a real pilot. Needs its own design [U].
- **Exports and documents** (PDF, tax output): listed unavailable in the engine today [D].
- **Numbering continuity** from the legacy invoice sequence [D].
- **Notifications and the background jobs** the legacy app relies on [U].

### 7. Rollback
Stage 1 touches no real data. Stage 2 is reversible by restore plus a mode reset (coexistence scope). The app build can fall back to the legacy shell for a business whose mode says legacy, so a rollback needs no new app release [I].

## Questions for Pierre (each has a default)
1. Approve decisions 1 to 4 as recommended? **Default: yes.**
2. Is the preview-first order (stage 1 on staging sample data, then your flooring business) right? **Default: yes.**
3. Is voice and photo capture into the engine required for the pilot? **ANSWERED by Pierre 2026-11-14: yes, required.** Designed in [engine-capture.md](engine-capture.md), awaiting his approval.
4. May I build the mode read (decision 2) and widen the client (decision 5) tests-first once you approve, without a further question for each screen? **Default: yes, one capability at a time, map updated each time.**
