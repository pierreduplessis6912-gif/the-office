# Engine capture: a receipt photo becomes a HELD expense — 2026-11-14

Status: written and built in one go on Pierre's instruction ("Write it and implement it", 2026-11-14). No deploy, no real-model run, no staging proof. Slice 2 of `engine-capture.md` (slice 1: `engine-capture-image.md`).

## Decision
A photographed receipt can become a HELD `expense.record` proposal, and nothing more.

1. **The person's intent is explicit, never taken from the picture.** The upload carries `intent=expense` (the app's "Record this receipt" button). Without it, slice 1 applies unchanged: kept and read, nothing acted on. Any other `intent` value is refused 422 before anything is stored.
2. **The reading is data, the capability set is one.** The reading (plus a typed caption, if any) goes to the interpreter with the catalogue narrowed to `expense.record` alone. A reading that makes the model answer anything else (a payment, a payment to a supplier, a read) is NOT UNDERSTOOD: capture and observation only. Words inside a photograph still cannot make any other action.
3. **Same rails as a typed expense.** Supplier resolved by the engine from the name (unknown supplier: refused, "add them first"), amount in whole cents inside the model-amount rail, VAT never assumed (the reading must say it), category and method from the fixed lists, a person approves. Method not on the receipt: not understood; the caption ("paid cash") supplies it.
4. **Provenance.** The interpretation and proposal name the capture row, which names the file in R2.
5. **Permission.** Needs the member's own `expense.record` permission; without it nothing is read into a proposal (403), the file and reading are still kept.

## Limits (stated, not hidden)
- The date is today (or yesterday only if a caption says so); a receipt's own printed date is not used yet.
- Supplier bills with lines and a three-way match (`supplier_invoice.record`) are NOT built: they need extraction of lines, order matching and tax invoice status, which is its own design.
- PDFs are kept, not read. No staging proof or real-model run (needs Pierre's explicit word and a pass rule).
- The approval card does not yet show the file.
