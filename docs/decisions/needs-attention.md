# Needs attention (read-only)

**Status: built (engine read, route, MCP description, sentence). App panel: see below.**

## What it is
One list, worked out fresh on every read, of what the business should look at now. It writes nothing, stores nothing and adds no table. Every item has a title, a plain-words reason, the record it came from (`ref`) and, where there is one, a date and an amount.

`attention.find {asOf?}` -> `{ items (max 50), count, truncated, counts, today, derivedBy }`. REST: `GET /engine/attention?asOf=`. Sentence: "what needs my attention".

## What is on it (in the order a person should look)
1. `bill_overdue`: a supplier bill with a recorded due date before today and money still owing.
2. `invoice_late`: a customer invoice still owing 30 days after it was issued.
3. `job_overdue`: an open job dated before today.
4. `job_snag`: an open snag on a job that is not cancelled.
5. `bill_due_soon`: a bill falling due within 7 days.
6. `quote_expired`: an open quotation whose valid-until date has passed.
7. `stock_low`: stock whose position is below its reorder level (the existing reorder read).

Inside a kind: earliest date first, then the larger amount.

## Rules
- **Only what the viewer may read.** Each section is included only if the viewer holds the permission of the read it comes from (`receivables.read`, `bill.read`, `job.read`, `quotation.read`, `stock.read`) and the business has that read switched on. The read itself has no permission of its own, so it can never show more than the separate reads would. A viewer who may read nothing gets an empty list.
- **One rule is not a recorded fact.** Customer invoices carry no due date yet. 30 days after issue is used, and each such item SAYS so ("No due date was recorded, so 30 days after issue is used"). When invoices gain a due date, that date replaces the 30 days.
- **Nothing is guessed.** A bill with no due date is not listed as overdue. A quotation with no valid-until date is never expired. Cancelled jobs are left out.
- **Derived, not stored.** Reading twice gives the same list; there is nothing to correct afterwards.

## Not in this slice
Dismissing or snoozing an item, notifications, credit notes netted off invoices, a per-business threshold for the 30 days.

## Invoice due dates (added 2026-11-17, no schema change)
A customer invoice may now carry a due date. A draft's `terms.dueOn` is checked on every save (a real date, not before the issue date; `terms` must be an object) and is kept on the issued document's terms, the same place a bill keeps its own. "Needs attention" uses that date when there is one (item says "was due <date>"); only an invoice with none falls back to 30 days after issue and says so. The app's invoice form has an optional due-date field. Not done: payment terms ("net 30") as a customer default, showing the due date in the Invoices room, changing a due date after issue.
