> **Status:** real. **Verified:** not yet. **Owns:** `worker/src/experience.ts`, `tools/experience.test.js`, `tools/experience-contract.test.js`.

# The reply envelope — contract version 1 (Phase 1)

**The principle.** The intelligence thinks. The envelope projects. The Office becomes the experience. The envelope **communicates what the backend has already established** and **recommends how the front end might present it**. It is not an intent engine, not a business-logic layer and **not an authorization mechanism**: it grants nothing, decides nothing and executes nothing.

**Additive and versioned.** One new object, `experience`, is added to the reply of the two app-facing routes (`POST /messages/text` and the voice-note route). **Every existing reply field keeps its name, value and meaning, and `message` is always still there**, so a client that ignores `experience` (including today's app) behaves exactly as before. A breaking change needs a new `version`. Nothing is added to the debug transcription route.

**Uploads (2026-10-24).** `POST /files/photo` and `POST /files/document` carry the same `experience` object, built from the reply's `message` and its held action (`pendingActionId`, with its real type read from `pending_actions`). Each upload is also recorded in the history (`source` `photo` or `document`, `heard` always null). Nothing else in those replies changed.

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
* **No `refuse` mode.** A permission refusal reaches the app today only as words inside `message`; there is no structured signal, and guessing from text is not allowed. It stays listed as unknown (`refusal_reason`). (Version 2 adds it, from a structured signal and never from text: see "Version 2" below.)
* **No stakes grading.** The reply gives the action `type`; the app already grades its confirm gesture from it. The envelope passes the type through and asserts nothing about stakes.

## Safety rules the code and tests enforce

* Built only from an allowlist of fields; nothing else in the reply (capabilities, e-mail addresses, tokens) is ever copied.
* Never throws and never changes the reply: a malformed, partial or hostile reply still yields a valid envelope (or a minimal fallback naming `envelope_error`), and the original fields are returned untouched.
* Bounded: at most 50 items per list and 200 characters per copied string.
* If a reply already contains an `experience` field, it is left exactly as it is.

**Update, 2026-10-19:** workspace context (the app saying what is on screen) now exists as its own contract, `CONTEXT.md`: it is accepted, validated and recorded with the turn, and is NOT used to interpret speech yet. It is deliberately NOT part of this envelope's version 1.

**Update, 2026-10-20: an app command is not speech.** The lookup path signals "open this screen" to today's app by putting `__OPEN_DASHBOARD__:<name>` in `message` (the app recognises it and opens the room). That is an instruction for one client, not words. The envelope therefore never offers it as `speak` (`speak` is null) and names it in `unknown` as `message_is_an_app_command`; `from` does not list `message`; history records it as a plain description ("Opened financial snapshot"). The reply itself is unchanged: `message` still carries the marker, so apps already installed keep working. A message that merely mentions a marker inside ordinary text is still speech. The structured replacement (an `open_room` mode with a room name, per `PROJECTION_VISION.md`) is a deliberate later version, not part of this fix.

## Version 2 (2026-10-24): `open_room` and `refuse`

**Only a reply that uses one of the two new parts is stamped `"version": 2`.** Every other reply is exactly version 1, with no new keys, so a client that reads only version 1 loses nothing, and ignores a version 2 envelope the way it ignores any version it does not know (`message` is unchanged, so the screen-opening command and the words still work). **The app reads version 2 since front-end slice 11 (2026-10-24, CI-verified only, not on a device):** `open_room` opens the named screen from structure (the in-band marker still works), and refusals are read into the reader (`isRefusal`, reason and topic) with NO screen of their own yet: a refusal is still shown as its words. Version 2 modes are honoured only inside a version 2 envelope.

* **`open_room`.** When `message` is a recognised open-this-screen command naming a screen the app can open (`financial_snapshot`, `aged_debtors`), `established.room` and `recommendation.room` name it and `recommendation.mode` is `open_room`. `room` leaves `unknown`; `message_is_an_app_command` stays (it is still a command, never speech). Any other command or name stays a version 1 reply with the command unrecognised. A held action or a clarification outranks it.
* **`refuse`.** The places that refuse a person because of their role now ALSO say so in structure (`worker/src/refusals.ts`): the reply carries `refusals` (a list of `{ reason, topic }` from a closed vocabulary, never free text, never a name or an amount) and `refusalScope` (`whole` only when every part of the message was refused, else `part`). The envelope copies only vocabulary items, at most 10, as `established.refusals = { scope, items }` and removes `refusal_reason` from `unknown`. `recommendation.mode` is `refuse` only for scope `whole` with nothing held; `part` is reported but the mode stays as it was. Words that merely sound like a refusal are never read as one.
* **Reasons.** `role_cannot_record` (topics `money`, `leads`, `statements`, `stock`: the role may not create this kind of record) and `role_cannot_see` (topics `material_prices`, `open_orders`, `supplier_statements`, `unit_conversions`, `delivery_exceptions`, `financial_overview`, `debtors`, `financial_analysis`: the answer was withheld). Two PART reasons mean something was withheld INSIDE a real answer and never make the reply a refusal: `role_cannot_see_part` (`outstanding_balances`, `quotation_activity`, `expense_activity`, `financial_performance`, `supplier_balances`, `job_activity`, `customer_balance`, `job_profitability`) and `role_cannot_record_part` (`sensitive_details`: a pay or bank detail that was not saved). A segment counts as wholly refused only if it carries a whole reason.
* **Coverage (complete for the Worker's reply routes, 2026-10-24).** Every sentence that refuses a person because of their role in a reply now carries its structured twin: dictation, lookups (whole answers and withheld parts), spoken follow-ups, upload refusals (`refusals` and `refusalScope` on the upload response too, and in its envelope) and a refused sensitive detail. `tools/refusal-coverage.test.js` scans the source and fails if a refusal sentence is not beside a structured refusal, so a new one cannot be added without its twin. Named exceptions, which are not replies: an HTTP 403 on a route, and the MCP endpoint's own protocol. Role refusals are the only kind this covers: a refusal for another reason (a missing record, a validation failure) is not a `refuse`.
