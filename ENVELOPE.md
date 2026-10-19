# The reply envelope (design contract, version 1) — DRAFT FOR PIERRE'S REVIEW, nothing built yet

**Why.** The backend answers in sentences; the design doctrine needs it to answer in *intentions*, so the front end can decide how to present each one (speak, open a room, update the open report, show analysis, ask to confirm, ask a question, or refuse). This envelope is that contract. **It is additive**: every field the app reads today (`message`, `pendingActions`, `pendingCandidates`, `pendingChanges`, `embers`, ...) stays exactly as it is, so the current app keeps working unchanged; the new part is one extra object, `experience`.

**Where.** Added to the reply of `POST /messages/text` (and the audio route, which shares `processTranscript`), next to the existing fields.

## What a reply gains

```json
{
  "status": "processed", "transcript": "...", "message": "...", "...every existing field unchanged...",
  "experience": {
    "version": 1,
    "intent":  { "class": "A|B|C|D|E|F|unknown", "clear": true, "summary": "what was understood, in a few plain words" },
    "present": { "mode": "speak|open_room|update_workspace|analysis|confirm|clarify|refuse",
                 "speak": "short text to say aloud or flash and fade, or null",
                 "room": "finance|jobs|people|customers|suppliers|documents|stock|reports|settings|null",
                 "workspace": { "report": "...", "period": {"from":"...","to":"..."}, "compare": {"from":"...","to":"..."}, "filters": {}, "sort": "..." } },
    "confirm": { "required": true, "actionIds": [12], "stakes": "low|medium|high", "changes": [ {"field":"...","from":"...","to":"..."} ] },
    "clarify": { "question": "one concise question", "options": [ {"id":"...","label":"..."} ] },
    "evidence": [ { "kind": "record", "ref": {"type":"invoice","id":42}, "label": "..." } ],
    "certainty": "fact|calculated|inferred|unknown",
    "refusal": { "reason": "permission|unavailable", "message": "one concise sentence" }
  }
}
```

Only the parts that apply are filled; the rest are `null` or empty. `class` is the doctrine's A to F: **A** information retrieval, **B** open a room or report, **C** change what is already open, **D** deeper analysis, **E** operational action, **F** ambiguous.

## What it is built from, honestly

* **Phase 1 (this change): derived, no new intelligence.** From signals the reply already has. A held action (`pendingActionIds`, `pendingActionType`, `pendingChanges`) is **E** with `mode: confirm`, and its stakes come from the action type. A candidate list (`pendingCandidates`) is **F** with `mode: clarify` and the options. A request refused for permission is `mode: refuse`. Everything else is `unknown` with `mode: speak` and the existing `message`, **so nothing is guessed**. Pure function, unit-tested, no behaviour change.
* **Phase 2: reports as data**, so `B` and `C` have something real to open and update (profit and loss, aged debtors and creditors as JSON with a period and a comparison period).
* **Phase 3: analysis (`D`)**, with contributors, evidence links and `certainty` that says plainly whether a statement is fact, calculation or inference, and never invents a cause.
* **Phase 4: a history and audit record** of heard, interpreted, proposed, executed and replied, so history can show what The Office actually said.
* **Phase 5: workspace context.** The app may send `context: { room, report, period, filters, selection }` with a request so "compare that to August" can be understood. Phase 1 only accepts and validates it (never trusts it for permissions: authorisation stays server-side).

## Rules the envelope must never break

1. **Authorisation is not in the envelope.** A `confirm`, `open_room` or `workspace` is a *suggestion about presentation*. Every action and every record is still checked server-side, on every route, as today.
2. **Never present an inference as a fact.** `certainty` is set by the code that made the claim, not defaulted upward.
3. **Additive and versioned.** Existing fields never change meaning; a new `version` is required for any breaking change.
4. **No room or report is named that does not exist.** An unknown room is `null`, never invented.
5. **The `message` always remains**, so a client that ignores `experience` (including today's app) still gets a complete answer.
