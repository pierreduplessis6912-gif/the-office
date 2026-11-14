> **Status:** approved by Pierre 2026-11-14 ("Approved", taken as approval with the stated defaults). **Verified:** not yet. **Owns:** none.

# DECISIONS: engine-capture (voice notes, photos and documents into an engine business)

Written 2026-11-14 by the build chat. Pierre said capture is required for the pilot (his answer to question 3 of `app-connection.md`). A DESIGN FOR APPROVAL: no code, no staging run, no real-model run. Evidence labels: [C] code read, [T] test, [D] documentation, [I] inference, [U] unknown.

## What the legacy capture does today [C]
- `POST /files/audio`, `/files/photo`, `/files/document` (multipart, an `idempotency_key`): the raw file is stored in R2 (`OFFICE_VAULT`) first, a `captures` row points at it (`r2_key`, `source` voice, photo or document), then the file is understood: audio by Whisper (`transcribe`), images by a vision model (`describeImage`), then the legacy pipeline writes legacy records.
- A lesson already paid for: a failed transcription once left a stored file with NO database row, so it could never be found or retried while the person was told it was received. The row is now written first.
- In an ENGINE business these routes are refused by the boundary, so today there is no capture at all [C, T].

## Principles (all already in the doctrine; nothing new is decided)
1. **Receptacle first.** Raw file to R2 and a capture row exist before anything is understood. Nothing said or photographed is ever lost because understanding failed.
2. **Understanding is a reading, not a fact.** A transcript or a description is an interpretation with its provenance; it creates no business record. Only a HELD proposal through the same door as typed text does, and a person approves it.
3. **The model never sees business data and never approves** (`interpret.ts`). Unchanged.
4. **Honest when unsure.** Not understood means a capture and an observation only (invariant 12).

## Proposed design
- **New engine routes** `POST /engine/capture/audio`, `/photo`, `/document`, classified `engine` in `boundary.ts` and `ROUTE_POLICY.md` (refused in a legacy business, as every `/engine/*` route is). The legacy routes stay refused in an engine business. Same multipart shape and the same idempotency key as legacy, so the app's upload code is reused and a dropped network cannot capture twice.
- **Voice:** store, write the capture row, transcribe, then pass the transcript to the existing interpreter (`/engine/interpret`) exactly as typed text. The answer returns the transcript so the person sees what was heard. No transcript: the capture stays, the answer says so, a retry path exists.
- **Photos and documents:** store, write the capture row, describe or extract text, then ask the interpreter for a PROPOSAL where the content fits a capability the business has (for example a supplier bill or an expense). A proposal is held with the file attached as evidence; the approval card shows the file. Nothing fits means the capture is kept and an observation says what was seen. Needs a catalogue of which capabilities may be proposed from a document, tests first, with the same pass-rule habit as stock.
- **Caption rule:** a subject (which customer or supplier) comes only from something actually said or typed with the file, never guessed from the image (the legacy rule in `resolveUploadCaption`, kept).
- **Provenance:** the interpretation names the capture; the record's history shows the file. The existing trail (capture, interpretation, proposal, approver, contract) is reused unchanged.
- **Tests (before code):** a scripted transcriber and describer in the route harness (the model-run habit), the idempotent replay, the failed-transcription case (the legacy bug, as a regression), isolation (one business cannot read another's file), permission, size and type limits, deliberate breakages in `tools/engine-breakage.js`. Then a staging proof on a real object (R2 and the object behave differently from the harness), and a real-model run ONLY on Pierre's explicit word.

## Risks and limits to decide
- **Recovery.** Snapshots cover the engine tables, not R2. A restore keeps the capture rows and their keys, so files must not be deleted while a row points at them; retention needs a rule [U].
- **Privacy.** Photos can show people and places. Access follows the capability that reads the record; the file is never served by a public URL [I].
- **Size and cost.** Per-file and per-day limits, and a format list, so one upload cannot exhaust the object or the model budget [U].
- **Name hints for transcription.** Whisper does better with the business's own names (`transcribeWithNameHints` exists, unwired). Handing it party or item names touches the rule that the model does not see business data. Default: NO in v1; decide after a real run shows how bad names are.
- **WhatsApp and email as capture channels** are a separate design (`WHATSAPP_CHANNEL_ARCHITECTURE.md`), not this one.

## Order of work if approved
1. Voice (smallest, the product's core): route, tests, breakages, staging proof.
2. Photo and document to a held proposal, one capability at a time (supplier bill first).
3. The app's capture button on the real client (needs the app-connection design approved).

## Questions for Pierre (each has a default)
1. Approve the design as written? **Default: yes.**
2. Which comes first for the pilot: voice, or photos and documents? **Default: voice.**
3. Which documents matter most to you (supplier bills, quotes, delivery notes, receipts)? **Default: supplier bills and receipts first.**
4. Retention: keep raw files for how long? **Default: as long as any record points at them, no deletion.**
5. Name hints for transcription: leave off in v1? **Default: off.**
