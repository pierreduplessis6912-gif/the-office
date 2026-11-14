# Engine capture: photos and documents, slice 1 — 2026-11-14

Status: built and tested on `engine-phase1`; nothing deployed, no real model run. Follows `engine-capture.md` (approved).

## Built
- `POST /engine/capture/photo` (images) and `POST /engine/capture/document` (images or PDF), multipart, optional `caption` and `idempotency_key`; 10 MB limit; 415 for other types; legacy routes stay refused in an engine business.
- **Receptacle first**: file to R2 and a capture row before anything is read. A failed reading still leaves both.
- **A reading, not a command**: what the picture shows is kept on the capture row and shown back; it is never given to the interpreter. Words inside a photograph cannot make a held action.
- **Caption rule**: only a typed caption goes through the interpreter, as typed text (read answered, write held, not understood honest). No caption: capture and reading only. Subjects are never guessed from the file.
- A PDF is kept and said to be not yet read.

## Not built (each needs its own design and Pierre's word)
- Turning a supplier bill or receipt photo into a HELD proposal (structured extraction of lines and amounts). It is the next slice; the reading stays a reading until then.
- Reading PDFs.
- A staging proof with a real R2 object and a real vision model run (needs his explicit word and a written pass rule).
- Retention and per-day limits (default stands: nothing deleted while a row points at it).
