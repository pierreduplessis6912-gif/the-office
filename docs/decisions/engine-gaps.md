# Engine gaps (step c) — 2026-11-14

Status: built and tested on `engine-phase1`. Nothing deployed.

## Built
- **Draft invoices over HTTP**: `POST /engine/drafts` (invoice, sell only), `GET /engine/drafts/<id>` (with its validation), `PUT /engine/drafts/<id>` (against the version the person saw; stale → 409). Needs `drafts.edit` (held with `can_manage_invoices`); checked at the gate and again in the route. A draft is the one mutable working copy, not a business fact. Issuing is still a held `invoice.issue` proposal that a person approves.
- **Quotation lines that name items**: `quotation.create` and `quotation.revise` take `lineItems` [{lineNo, itemId}] as purchase orders do, kept in the document's terms (no schema change), validated against real items and units. A revision with new lines names only what it says; a revision leaving lines alone carries the naming forward; `lineItems` without `lines` is refused.

## Not built — needs Pierre's decision
- **Credit-note item naming.** A credit note's lines point at the invoice's lines, and the invoice already names its items. Whether a credit note should put stock back is the restock-from-credit-note decision (`inventory-integration.md`). Left alone.
