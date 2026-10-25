> **Status:** real. **Verified:** 2026-10-24. **Owns:** `worker/src/context.ts`, `tools/context.test.js`.

# Workspace context — the contract for the front end (version 1, Phase 5)

**What it is.** The app MAY tell The Office what the user is looking at, so a follow-up such as "compare that to August" can later be understood without the user repeating the report. **In this phase the context is accepted, validated and recorded with the turn, but it is NOT used to interpret speech** (nothing in the backend can use it yet; the first consumer will be the intelligence layer). So sending it changes no reply today. It is safe to start sending now.

**It is an untrusted hint, never a permission.** Whatever the app says is validated against allowlists. A field that is not on the list (a role, capabilities, a token, an address, anything claiming authority) is **dropped and its name reported, never kept**. Every action and every record is still authorised by the session on the server, exactly as before, and the context is never handed to the code that decides what a caller may see or do.

## The shape

```json
{ "version": 1, "room": "finance", "report": "profit_and_loss",
  "period":  { "from": "2026-09-01", "to": "2026-09-30" },
  "compare": { "from": "2026-08-01", "to": "2026-08-31" },
  "filters": { "status": "outstanding", "min_amount": 500, "include_vat": true },
  "sort": "amount_desc",
  "selection": [ { "type": "customer", "id": 12 } ] }
```

Every part is optional. Rules:
* `version`: exactly `1`.
* `room`: a lower-case slug (`^[a-z][a-z0-9_]{0,31}$`). The server checks only the SHAPE: the app owns its own room names.
* `report`: one of `profit_and_loss`, `aged_debtors`, `aged_creditors` (the reports the server actually has).
* `period` / `compare`: exactly `from` and `to`, real calendar dates `YYYY-MM-DD`, `from` not after `to`, at most 3,660 days. `compare` is only accepted beside a valid `period`.
* `filters`: at most 10 entries; each key a slug; each value a short plain string (letters, digits, space and `_ . , ' -`, up to 40 characters), a finite number or a boolean.
* `sort`: a slug. `selection`: up to 5 entries of exactly `{type: slug, id: positive whole number}`.
* The whole context must be under 4,000 characters.

## How a bad context is handled

**A bad field never costs the message.** Valid parts are kept; invalid parts are dropped, and the names of the dropped parts are reported in `rejected` (never their values): `report`, `period`, `filters.status` (a bad value under a valid key), `filters.key_invalid`, `selection`, and `unknown:<name>` for a field that is not on the list. A context that is not an object, or is too large, is refused whole (`context_malformed`, `context_too_large`).

## How to send it

* **Text:** add `"context": {...}` to the body of `POST /messages/text`.
* **Voice note:** the body is the audio, so send the same JSON as base64url in the `X-Office-Context` header (up to 5,000 characters; a bad header is ignored and costs nothing; reasons `context_header_invalid`, `context_header_too_large`).
* **Dry run while you build:** `POST /context/check` with `{"context": {...}}` answers `{context, rejected, used: false, note}`: what WOULD be kept and what would be dropped. It reads nothing and changes nothing, and is open to every signed-in member.

## What happens to it

It is stored with the turn as `viewing` (what the app said was on screen), read back by `GET /history` as `viewing` beside, not inside, what was heard and what was generated, so the audit record shows what the app claimed was displayed. It is never copied into a reply, never passed to the language model and never used to decide access.
