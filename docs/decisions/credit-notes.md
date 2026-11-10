> **Status:** built in the engine and CI-tested on branch `engine-phase1` (2026-11-10); **not** proven on a real staging object, **not** read by a real model, **not** wired to the app. **Verified:** by `tools/capability-credit-notes.test.js` (66 checks) and fifteen deliberate breakages in `tools/engine-breakage.js`. **Owns:** the meaning of "a credit note" in the engine.

# Credit notes: issue

Capability-map row 3 (`docs/CAPABILITY_MAP.md`), the next one in Pierre's order after quotations.

## How the three questions were decided
Pierre was asked three accounting questions (does a credit note reduce what a customer owes by being allocated to an invoice; what happens to the tax; can it exceed the invoice) and answered on 2026-11-10: **"Use best practice in these scenarios."** That is a delegation, recorded here so it is not mistaken for a specific ruling. The answers below are the usual practice for a VAT-registered business (a credit note adjusts the original tax invoice and reduces both the value and the VAT on it, at the original rate, and refers back to it). **Claude is not an accountant or a tax adviser, and nothing here has been checked against South African VAT law or by Pierre's accountant; that check is open** and any line below can be changed by Pierre.

## What it is
- **`credit_note.issue`** (held write): credits ONE invoice, line by line, for a stated reason. Each credited line names an invoice line (`invoiceLineNo`), a quantity (in thousandths) and a unit price (in cents). It records, in one transaction: the credit note document (kind `credit_note`, its own number sequence), a non-cash movement (direction `in`, method `credit`) for its total, an allocation of the part still owed on the invoice, and a `credit_note.issued` event tying them to the invoice. The approval is shown the exact net, tax and total the engine worked out.
- It is reached through the proposals door and opened through records: the invoice shows `Credited` and a link to each credit note; the credit note shows its reason, what was applied, what was left unapplied, and which invoice it credits. There is no separate find route yet.

## Decisions taken (best practice; each open to change by Pierre)
1. **A credit note reduces what is owed by being applied to the invoice** as a non-cash movement allocated to it (the pattern the fit test walked), so the invoice's `outstanding` falls and its status moves toward paid. The invoice document itself is never edited; what is owed, credited and left over is derived.
2. **Tax is inherited, never chosen.** Every credited line takes the tax rate of the invoice line it credits, so the VAT credited is exactly proportional. A credit line that supplies its own tax rate is refused.
3. **A line can never be credited for more than it was worth,** counting all earlier credit notes (cumulative net per invoice line, at most the line's original net), and not at a higher unit price than it was charged. So a credit note can never exceed the invoice. Crediting exactly what remains is allowed.
4. **A reason is required** (up to 200 characters), and a credit note cannot be dated before its invoice.
5. **Only an invoice can be credited** (a document of a kind the customer owes for, direction `sell`, not reversed). A quotation, or a credit note, cannot.
6. **The excess stays as an unapplied credit.** If the invoice was already paid (fully or partly), only what is still owed is applied; the rest of the credit is recorded as unapplied on the customer (`unappliedMinor` on the credit note) and is **never silently refunded or spent**. What the customer owes is unchanged by an unapplied credit. Refunding or applying it to another invoice is a separate capability, not built.
7. **Permission** (engine vocabulary): `credit_note.issue`, granted to `can_manage_invoices` only (owner, accountant, admin). A salesperson and an installer cannot, even though a salesperson can make quotes: a credit note is a money correction. Proposing and approving both need it.
8. **An earlier proposal about the customer or the invoice becomes stale** when a credit note is issued (a payment proposed before a credit must be proposed again), and two people cannot both credit the same amount past the invoice.
9. **No schema migration.** Everything uses existing fact tables and a new event type, `credit_note.issued`, which the integrity verifier knows and checks (the credit note, invoice and movement must exist; applied plus unapplied must equal the credit note's total and its movement).
10. **The invoice record's `Paid` figure includes credits.** `Credited` is shown beside it so the two can be told apart.

## Not in this capability (each a separate decision, none assumed)
Voiding or reversing a credit note, a refund to the customer, applying an unapplied credit to another invoice, supplier credit notes (purchases), rounding rules beyond the engine's existing per-line arithmetic, the PDF, and how a credit note affects VAT returns or period reporting (no VAT reporting exists on the engine).

## Evidence (labelled)
- **Test** (route harness, a stand-in for Durable Object storage): the half, full, cumulative and price credits; an already-paid and a part-paid invoice (unapplied credit); fourteen invalid payloads, six rule refusals, a quotation refused, an over-credit refused, a salesperson and installer refused, availability, double approval, stale and racing credits, a payment made stale by a credit; the invoice byte-for-byte unchanged; the integrity verifier (an orphan and a sum that does not add up are reported); atomicity at every one of its writes.
- **Test** (deliberate breakage): fifteen mutations (over-credit, forgetting earlier credits, a higher price, a non-invoice, no reason, a chosen tax rate, applying more than is owed, editing the invoice, forgetting the unapplied credit, who may issue, the stale check, the verifier's two checks, and the record treating a credit note as a debt) each make the suite fail.
- **Unknown / not done:** a real Durable Object has not run it; a real model has not been shown it (`interpret.ts` offers only the receivables read and the payment); the app does not call it; the outside-assistant (MCP) door does not offer it; snapshot and restore with these events is unproven; **the accounting treatment has not been reviewed by an accountant.**

## Next for this capability (each needs Pierre's word)
1. His (or his accountant's) review of decisions 1 to 6 and 10.
2. A staging proof (a `credit-notes-proof` mode like `quotations-proof`).
3. Showing the model the capability, then wiring to the app.
