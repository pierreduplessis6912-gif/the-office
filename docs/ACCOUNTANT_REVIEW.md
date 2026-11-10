> **Status:** a review pack for a South African accountant or tax practitioner, written 2026-11-10 from the research in `docs/decisions/credit-notes.md` and `docs/decisions/credit-note-follow-ups.md`. **It is not a review:** nothing below has been checked by an accountant, and Claude is not one. The point is to make that review short: what The Office does, why, and the exact questions it cannot settle itself. **Verified:** every behaviour listed is covered by the engine's tests (CI), not by staging; none has run on a real business's books.

# The Office: tax documents, credit notes and the VAT summary: questions for an accountant

## What to look at
1. **Credit notes** (`credit_note.issue`), **debit notes** (`debit_note.issue`), and what can happen to leftover credit (`credit.apply`, `refund.record`, `credit_note.void`, `allocation.remove`, `refund.void`, and for overpayments `payment.allocate`, `payment.refund`). Decisions: `docs/decisions/credit-notes.md` and `docs/decisions/credit-note-follow-ups.md`.
2. **The business profile and the tax lock** (`business.profile.set`, `tax_lock.set`) and the **completeness check** on every tax document (which prescribed particulars a document still lacks).
3. **The VAT summary** (`vat.summary`, `GET /engine/vat?from=YYYY-MM-DD&to=YYYY-MM-DD`): the output side of a VAT201 for a period.
All figures come from recorded facts; nothing is typed in. Every document, movement and reversal is kept; nothing is edited or deleted.

## What it does, and the basis (please confirm or correct each)
| # | Behaviour | Basis used | Confirm? |
| --- | --- | --- | --- |
| 1 | A credit note reduces what is owed by being allocated to the invoice it credits, line by line, for a stated reason; each credited line takes the TAX RATE of its invoice line. | VAT Act s21(3)(a) particulars (BDO summary); credit-note-vs-refund practice in Odoo, Xero, QuickBooks | |
| 2 | A line can never be credited for more than it was worth, counting all earlier credit notes, and the tax credited on a line can never exceed the tax the invoice charged on it (per-line rounding). | s21 adjusts the excess tax only | |
| 3 | A credit note applies to the invoice up to what is still owed; the rest stays as **credit owed back** to the customer (shown separately, never netted). It is then applied to another invoice of the same customer, or refunded (a separate money-out movement). | Xero, QuickBooks, Odoo, Manager.io | |
| 4 | A credit note can be voided only while none of its credit has been applied elsewhere or refunded (or after those are undone), and not if it is dated in a locked tax period. | Xero, QuickBooks | |
| 5 | A debit note adds to an invoice, tax inherited from the invoice line, and is owed by the customer like an invoice. | s21 debit notes | |
| 6 | **Tax lock date:** only moves forward; invoices, credit notes and debit notes dated on or before it are refused; applying credit, removing an application and voiding a refund are NOT blocked (they change no VAT). | Xero lock dates; Odoo tax lock date | |
| 7 | **Document completeness:** vendor name, address and VAT number (10 digits starting with 4); recipient address above R5,000; recipient VAT number advised if on record. It flags; it never blocks issuing. | s20(4), s21(3), BGR rulings; secondary SA guide for the R5,000 tiers | |
| 8 | **VAT summary:** field 1 = standard-rated (15%) supplies INCLUDING VAT, credit notes issued in the period offset against it, debit notes added; field 4 = field 1 × 15/115; field 2 = zero-rated (0%) supplies; any other rate listed apart; a document counts in the period of its own issue date. | VAT201 guide; SAIT note that credit notes offset field 1 | |

## Questions only an accountant can settle
1. **Time of supply.** The summary uses the document's issue date. Is that acceptable for this business, or does it need time-of-supply rules (e.g. payment-basis vendors, deposits, supplies spanning periods)?
2. **Exempt versus zero-rated.** Both are 0% in the engine and are reported as zero-rated (field 2). How should exempt supplies (field 3) be recorded when this business has them?
3. **Other rates.** Anything that is neither 15% nor 0% is listed apart. Are there legitimate cases for this business (e.g. the 2018 14% transition; none expected now)?
4. **Tax-fraction rounding.** Field 4 is computed on the VAT-inclusive total by the tax fraction; per-document tax is summed line by line. Any difference is shown. Which should be reported when they differ by cents, and is the shown difference sufficient for the file?
5. **Credit notes dated in a filed period.** The engine refuses (the lock) and asks for a date in the open period, the SA position that the adjustment belongs to the period of issue. Is that the treatment the business's advisor wants, including for an unlock override (not built)?
6. **Credit notes and bad debts.** A credit note is a price adjustment. Is any use of credit notes for bad debts (s22) expected? (Not supported; bad-debt relief is a different adjustment.)
7. **Refunds of overpayments and unclaimed credit.** Credit owed back to a customer is shown but never expires or is written off. Any treatment needed (e.g. long-standing credits)?
8. **Debit notes and the original invoice date.** A debit note carries its own date and period. Confirm that is right when it corrects an invoice from a filed period.
9. **Foreign currency.** Documents carry a currency but the summary adds amounts as recorded. Foreign-currency invoices need the VAT amount in rand at a prescribed rate (BGR 11): not built. Does the business invoice in foreign currency?
10. **Input tax.** Not reported at all (no purchases or expenses in the engine yet), so the summary is NOT a complete VAT201. What does the accountant need from purchases to build it (supplier tax invoices, field 14/15/18 classification)?
11. **Vendor details on the sent document.** The profile holds name, address, VAT number and company registration number; the document that is SENT (PDF or email) is not built. The completeness check is the gate for it. Is the checklist (docs/decisions/credit-note-follow-ups.md, point 1) complete for this business?
12. **Records and retention.** The engine never deletes. Is that sufficient for the five-year retention duty, and what export (CSV/PDF) does the accountant need for an audit?

## How to produce the figures for a period
Open the owner or accountant view and ask for the VAT summary of the period (for the API: `GET /engine/vat?from=2026-10-01&to=2026-10-31`). It lists every document counted, with whether its tax particulars are complete, whether the period is locked, and the notes above. Nothing here has been run on a real business's data.
