# Engine capture: a supplier bill photo becomes a HELD supplier invoice — 2026-11-14

Status: written and built in one go on Pierre's instruction ("Go with supplier bill", 2026-11-14). No deploy, no real-model run, no staging proof. Slice 3 of `engine-capture.md`; same rules as `engine-capture-receipt.md`.

## Decision
A photographed supplier bill can become a HELD `supplier_invoice.record` proposal, and nothing more.

1. **Explicit intent:** the upload carries `intent=supplier_bill` (the app's "Record this bill" button). Any other value besides `expense` is refused 422.
2. **Only that capability is offered, and only here.** `supplier_invoice.record` is added to the interpreter's catalogue as READING-ONLY: it is never offered for a typed or spoken sentence (the decision in `interpreter-procurement.md` that bills are not recorded from a sentence stands). With `intent=supplier_bill` it is the only capability offered; with `intent=expense` it is not.
3. **The model supplies words and plain numbers:** supplier name, the supplier's invoice number, the invoice date (and due date) only if printed, category, whether it is a tax invoice, how VAT is shown, and lines (description, quantity, unit, unit price in cents). The engine resolves the supplier, converts quantities, applies 15% only when VAT is shown as added, validates dates, and stamps the totals.
4. **Rails:** unknown supplier is refused (never created); invoice number required; VAT never assumed; prices must be shown WITHOUT VAT (added) or the bill has no VAT: a bill whose prices include VAT is not understood in this slice; dates must be real, not in the future and within 400 days; at most 30 lines; amounts inside the model-amount rail; an argument or line field the catalogue does not show is not understood. A duplicate supplier invoice number is refused by the engine as ever.
5. **Held, linked, approved by a person.** The proposal names the capture, which names the file. Nothing is recorded until a person approves.

## Limits
- The bill is NOT linked to a purchase order: it is held as `no_order`; matching to an order and the three-way match stays a manual step.
- Prices that include VAT are not understood (no rounding guesses).
- PDFs are kept, not read; no staging proof or real-model run; the approval card does not yet show the file.
