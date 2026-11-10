> **Status:** built in the engine, CI-tested and proven on a real staging Durable Object (`parties-proof`, 13 of 13, 2026-11-10); **not** read by a real model, **not** wired to the app. **Verified:** by `tools/capability-parties.test.js` (82 checks) and ten deliberate breakages in `tools/engine-breakage.js`. **Owns:** the meaning of "a customer or supplier" in the engine.

# Customers and suppliers: create, edit, find

Capability-map row 1 (`docs/CAPABILITY_MAP.md`). Everything else points at a party, so this came first.

## What it is
- **`party.create`** (held write): a person or organisation, with one or both roles (`customer`, `supplier`) and optional contact details (email, phone, address). Held for approval; nothing is recorded until a member approves.
- **`party.edit`** (held write): change the name, add or remove a role, set or clear a contact detail. Held, and stamped with the version of the record it was proposed against: an approval is only for what it showed.
- **`parties.find`** (read): by part of the current name, by role, or both; an empty filter lists up to 50. Route `GET /engine/parties?name=&role=`.
- The record view of a party now shows roles and contact details, offers the edit action to those who may, and lists every revision in its history with what was said, what was understood, who approved and under which contract.

## Decisions taken (defaults; each is open to change by Pierre)
1. **An edit is a new fact, not an update.** `eng_party` and `eng_party_role` stay exactly as created. A change is a `party.revised` event carrying only what changed; the CURRENT profile is derived (`worker/src/engine/parties.ts`) by folding the creating event's details and then each revision in order. This follows the engine's existing doctrine (a mistake is corrected by a new fact) and needs **no schema migration**, so nothing here touches the recovery gate.
2. **Names are unique** among customers and suppliers, ignoring case and spacing, checked at the door AND again at the approval (a name taken in between is caught). Creating "Patel" when a supplier "Patel" exists is refused with a pointer to add the role to the existing record. A case-only rename is a real edit.
3. **A party always has at least one role.** Roles are `customer` and `supplier` only; the fact layer itself stays free of them (it does not know what a business sells).
4. **Permissions** (engine vocabulary): `party.read` and `party.manage`. Default adapter: `can_know_debtors` grants `party.read`; `can_manage_invoices` grants `party.manage` (owner, accountant, admin). Installers and sales hold neither. Whether sales should read customers is the owner's decision; nothing here widens it by accident.
5. **An edit makes an earlier proposal about that party stale** (a payment proposed before a rename must be proposed again), because the party's version includes its revisions.
6. **No delete, no archive.** Nothing is removed; "archive a customer" is a later, separate decision.
7. **Two legacy tables name the new action types**: `ACTION_TYPE_CAPABILITY` (who may try to confirm: `can_manage_invoices`) and `ROUTE_RULES` for the find route (`can_know_debtors`). The contracts check the engine permission again at the door and at approval.

## Evidence (labelled)
- **Test** (route harness, a stand-in for Durable Object storage): every happy path, every refusal at the door, the stale and duplicate cases at approval, permissions per role, availability, the integrity verifier, atomicity of the create at every write, and that an edit leaves the party rows byte-for-byte unchanged.
- **Test** (deliberate breakage): ten mutations (duplicate check, stale check, last role, repeated role, email check, update-instead-of-revise, current-name lookup, orphan revision, who may edit, who holds the permission) each make the suite fail.
- **Code read:** the Dart shell does not use record actions or the party fields, so the regenerated party fixture (new fields, a new action) cannot change what it shows; Dart cannot run here, CI is the check.
- **Real staging record:** `ops/staging-parties-proof-last.json`, run 42802521790 at 53b72a5: held create, duplicate refused, rename, stale edit refused, contact cleared, installer refused 403, integrity clean, all through the real routes.
- **Unknown / not done:** finding scans every party's profile in memory (fine for hundreds; measure on staging before thousands); a real model has not been shown these capabilities (`interpret.ts` still offers only the receivables read and the payment); the app does not call it; the outside-assistant (MCP) door does not offer it; snapshot and restore with revision events is unproven.

## Next for this capability (each needs Pierre's word)
1. DONE (2026-11-10): a staging proof of create, edit and find on a real object: workflow `staging.yml` mode **`parties-proof`** (added 2026-11-10; its own business `staging-parties`, safe to re-run, record in `ops/staging-parties-proof-last.json`). The existing `rehearsal` has no party scenario and its two failures need separate diagnosis (HANDOFF.md).
2. Showing the model the three capabilities and judging it against a written pass rule.
3. Wiring to the app through the real client (needs his approval to connect).
