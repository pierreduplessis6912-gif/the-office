# The reply envelope — contract version 1 (Phase 1)

**The principle.** The intelligence thinks. The envelope projects. The Office becomes the experience. The envelope **communicates what the backend has already established** and **recommends how the front end might present it**. It is not an intent engine, not a business-logic layer and **not an authorization mechanism**: it grants nothing, decides nothing and executes nothing.

**Additive and versioned.** One new object, `experience`, is added to the reply of the two app-facing routes (`POST /messages/text` and the voice-note route). **Every existing reply field keeps its name, value and meaning, and `message` is always still there**, so a client that ignores `experience` (including today's app) behaves exactly as before. A breaking change needs a new `version`. Nothing is added to the debug transcription route.

## The four parts (they are kept apart on purpose)

```json
"experience": {
  "version": 1,
  "established":    { "from": ["message","pendingActions"], "heldActions": [{"id":12,"type":"invoice"}], "candidates": null, "changes": null },
  "recommendation": { "mode": "speak|confirm|clarify", "speak": "the existing message, or null" },
  "unknown":        ["intent_class","room","workspace","evidence","certainty","refusal_reason"],
  "mustStillPass":  { "confirmationRequired": true, "through": "…", "authorization": "…" }
}
```

1. **Established** — facts copied (bounded, validated) from fields the reply already carries: `pendingActions` (`{id, type}`), `pendingCandidates` (`{id, name}`), `pendingChanges` (`{field, label, displayValue}`). `from` names which reply fields were read, so every statement is traceable to the reply. Nothing is inferred.
2. **Recommendation** — a *suggestion* about presentation, never an instruction. `clarify` when the reply carries candidates to choose between; else `confirm` when there are held actions awaiting the existing confirm/reject flow; else `speak` (the existing `message`). `speak` repeats the message verbatim, or is `null` if it is empty or too long (the `message` field is always the full text).
3. **Unknown** — an explicit list of what the envelope does NOT establish. In Phase 1 this always includes `intent_class`, `room`, `workspace`, `evidence`, `certainty` and `refusal_reason`, and it names any reply field that was malformed (`reply_field_malformed:<field>`) or cut short (`reply_field_truncated:<field>`).
4. **Must still go through trusted mechanisms** — `confirmationRequired` is true exactly when there are held actions. Executing, rejecting or editing a held action is done ONLY through the existing pending-action routes (confirm, reject, edit-field), which re-check authorization and validation on every call. The envelope carries no address, token, permission or capability and grants nothing.

## What Phase 1 deliberately does NOT do

* **No intent classes** (A to F). The current reply does not establish one, so none is invented; `intent_class` is listed as unknown.
* **No rooms, workspaces, reports, evidence or certainty.** Nothing in today's reply supports them; they arrive with the later phases (reports as data, analysis, history and audit record, workspace context).
* **No `refuse` mode.** A permission refusal reaches the app today only as words inside `message`; there is no structured signal, and guessing from text is not allowed. It stays listed as unknown (`refusal_reason`).
* **No stakes grading.** The reply gives the action `type`; the app already grades its confirm gesture from it. The envelope passes the type through and asserts nothing about stakes.

## Safety rules the code and tests enforce

* Built only from an allowlist of fields; nothing else in the reply (capabilities, e-mail addresses, tokens) is ever copied.
* Never throws and never changes the reply: a malformed, partial or hostile reply still yields a valid envelope (or a minimal fallback naming `envelope_error`), and the original fields are returned untouched.
* Bounded: at most 50 items per list and 200 characters per copied string.
* If a reply already contains an `experience` field, it is left exactly as it is.

**Update, 2026-10-19:** workspace context (the app saying what is on screen) now exists as its own contract, `CONTEXT.md`: it is accepted, validated and recorded with the turn, and is NOT used to interpret speech yet. It is deliberately NOT part of this envelope's version 1.
