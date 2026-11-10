> **Status:** built in the engine, CI-tested and proven on a real staging Durable Object (`quotations-proof`, 14 of 14, run 42811115797, 2026-11-10); **not** read by a real model, **not** wired to the app. **Verified:** by `tools/capability-quotations.test.js` (91 checks) and fourteen deliberate breakages in `tools/engine-breakage.js`. **Owns:** the meaning of "a quotation" in the engine.

# Quotations: create, revise, accept, find

Capability-map row 2 (`docs/CAPABILITY_MAP.md`), the next one in Pierre's order after customers and suppliers.

## What it is
- **`quotation.create`** (held write): a quotation for a customer: issue date, currency, optional validity date and reference, and lines (description, quantity in thousandths, unit price in cents, an EXPLICIT tax rate in basis points per line). The approval is shown the exact net, tax and total the engine worked out.
- **`quotation.revise`** (held write): changes the lines, the validity, the reference or the date. It makes a NEW quotation document (its own number) and a `quotation.revised` event saying which one it replaces. Customer and currency cannot change. Stamped with the version it was proposed against (stale refused).
- **`quotation.accept`** (held write): records that the customer accepted the current revision (a `quotation.accepted` event). Accepted is final.
- **`quotations.find`** (read): `GET /engine/quotations?partyId=&status=`; by default only CURRENT quotations; `status=any` lists the whole history.
- The record view of a quotation shows its status, validity and reference, links to what it replaces or what replaced it, offers revise and accept only while it is open, and lists its revisions and acceptance in its history with what was said, who approved, under which contract.

## Decisions taken (**approved by Pierre 2026-11-10**, including that a salesperson may propose AND approve a quotation; still open to change by him)
1. **State is derived, never stored, and nothing is edited.** A quotation is an ordinary document of kind `quotation`; open, accepted and superseded come from the events (`worker/src/engine/quotations.ts`). **No schema migration**, so nothing here touches the recovery gate. The `tf_document_link` table of the fit test is the later, general answer for document relationships (orders, deliveries, credit notes); these two events say the same thing for quotations until that migration is decided, and it can absorb them.
2. **A revision is a new document with its own number** (a revision is quotation #2, not "#1 rev 2"). Number continuity for quotations, as for invoices, is not done.
3. **A quotation is not a debt.** The engine's configuration decides which kinds a customer owes for (invoices by default); quotations are not among them, and the record view shows no "paid" or "outstanding" for one. Tested: the customer owes exactly the same after create, revise and accept.
4. **VAT is never assumed.** Every line must carry its own tax rate; a line without one is refused. (Pierre's rule: no VAT treatment is chosen without his approval.)
5. **Only a customer can be quoted** (a party that is only a supplier is refused). Customer and currency are fixed for the life of a quotation chain.
6. **Accepted is final; revising an accepted quotation is refused**: make a new quotation. A quotation that has been replaced cannot be accepted or revised again; revise the current one. Two people cannot both revise the same version (stale).
7. **Permissions** (engine vocabulary): `quotation.read` and `quotation.manage`. Default adapter: `can_make_quotes` (a salesperson) and `can_manage_invoices` (owner, accountant, admin) grant both. Installers hold neither. A salesperson can therefore propose AND approve a quotation: confirm (a), restrict approval to `can_manage_invoices` instead (b). The default is (a) because making quotes is their job; it is the owner's call. Viewing a quotation needs `quotation.read`; viewing money documents still needs `receivables.read`.
8. **Not in this capability** (each a separate decision, none assumed): sending a quotation to the customer (no automatic sending), declining a quotation, expiry (validity is recorded, not enforced), converting an accepted quotation to an order or invoice, and the PDF.

## Evidence (labelled)
- **Test** (route harness, a stand-in for Durable Object storage): every happy path; sixteen invalid creates, seven invalid revisions, seven invalid acceptances, each refused for its own reason with nothing recorded; permissions per role; availability; stale and race cases; the integrity verifier (orphan references and a forked chain are reported); atomicity of a revision at each of its writes; the replaced document byte-for-byte unchanged; and that the customer's debt never changes.
- **Test** (deliberate breakage): fourteen mutations (revising a replaced or accepted quotation, accepting twice or a replaced one, an unchanged revision, an assumed tax rate, quoting a non-customer, a revision that edits the old document, replaced quotations listed by default, who may manage, the verifier's two checks, who may open one, and the record treating it as a debt) each make the suite fail.
- **Real staging record:** `ops/staging-quotations-proof-last.json`: held create at R402.50, a line without tax refused, a revision replacing the old quotation, a second revision of the same version refused (stale), replaced and accepted quotations refused further changes, an installer refused, a salesperson allowed, the customer's debt unchanged, integrity clean.
- **Unknown / not done:** finding derives every quotation in memory (fine for hundreds; measure on staging before thousands); a real model has not been shown these capabilities (`interpret.ts` still offers only the receivables read and the payment); the app does not call it; the outside-assistant (MCP) door does not offer it; snapshot and restore with these events is unproven.

## Next for this capability (each needs Pierre's word)
1. DONE (2026-11-10): a staging proof of create, revise, accept and find on a real object: workflow mode **`quotations-proof`** (added 2026-11-10 on Pierre's word; own business `staging-quotes`; record `ops/staging-quotations-proof-last.json`).
2. Showing the model the capabilities and judging it against a written pass rule.
3. Wiring to the app through the real client (needs his approval to connect).
