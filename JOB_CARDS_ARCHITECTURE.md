# Job Cards — Architecture

Pinned while still reasoning this out, per direct instruction — not a
build plan yet. Builds on `BACKEND_CAPABILITY_MAP.md` and
`ERP_MODE_ARCHITECTURE.md`; read those first.

---

## The core idea

A job card is not a new table that owns data. It's a real, separate
ember and room — its own front door into the void, alongside Finance,
People, Scheduling, Suppliers, Pending — that pulls together, at read
time, what already exists in each of those domains' own, authoritative
tables. Finance's invoices, People's customers and installers,
Scheduling's job scopes and tasks — a job card assembles a real view
across all of them, for one specific job, without ever becoming a
second source of truth for any of it.

This matters architecturally, not just semantically: if a job card
stored its own copy of a snag's description or an invoice's amount,
that copy could quietly drift from the real record the moment either
changed. Pulling live, every time, is what keeps this honest.

## The real, full picture this is meant to hold

Per direct instruction: photos before, during, and after installation;
notes (moisture readings, delays, snags); payment follow-up notes — a
real snapshot spanning first interaction, procurement, scheduling,
install, last mile, and after-sales.

## The one real, load-bearing decision this rests on

Per direct instruction: cross-linking and referencing to *specific
jobs* is crucial — not just to a customer. This settles what was
previously an open question. A customer with two separate jobs over
time must never have their snags, photos, or notes blend together
under one, blurred view. Job-level granularity is the real
requirement, not customer-level.

## What was verified directly against the current backend

The honest, current state: nearly everything links to `customer_id`,
not `job_scope_id`. Specifically, checked directly:

- `captures` (photos, notes) — only ever had `customer_id` and
  `character_id` added as foreign keys. No `job_scope_id` column
  exists.
- `snags` — links only to `customer_id`. No `job_scope_id`.
- `invoices`/`quotations` — the one place `job_scope_id` already
  exists, added for `price_scope`'s pricing needs specifically.
- `leads` — has a real `customer_id` column, but it is never actually
  set anywhere in the code. A lead and the customer it becomes are
  structurally strangers today, even though the column exists.
- "After-sales" — does not exist as a concept anywhere in the backend.
  No table, no column, nothing to build on yet.

Given the real, load-bearing decision above (job-level, not
customer-level), this means real, new schema work is required before
a job card can honestly assemble a single job's full picture:
`job_scope_id` needs adding to `snags` and `captures`, the same real,
narrow shape as the `due_date` addition to `invoices` earlier —
a real, idempotent `ALTER TABLE`, not a redesign.

## What already works and needs no new schema

- Job scope → its own real, rich data: description, customer,
  installer (via `characters`), scheduled date, measurement
  components, task breakdown — all already returned by
  `/debug/job-scopes`.
- Job scope → quotation/invoice → line items — the one real,
  already-existing cross-domain link, proven working in the Projects
  endpoint's real total-quoted/total-invoiced aggregation.

## What this means for the ember/room itself

A real, new ember on the void, entering its own room the same,
already-proven doorway every other room uses. Inside: search/select a
job, then a real detail view assembling, live, from each real domain:

- Scheduling's job scope (description, dates, installer, tasks)
- Finance's linked quotation/invoice and its real line items
- People's customer and installer records
- Photos and notes, once `job_scope_id` exists on `captures`
- Snags, once `job_scope_id` exists on `snags`

Payment follow-up notes and after-sales remain real, named gaps with
no existing structure to pull from yet — not attempted here, named
so they aren't quietly assumed solved.

## What this document does not settle

- The real, new backend endpoint(s) needed to assemble this
  cross-domain view — not designed here.
- Whether leads should get a real "convert to customer" flow (closing
  the `customer_id` gap) as a prerequisite, or whether first-interaction
  history stays out of job cards until that's solved separately.
- The real shape of "after-sales" as a concept — genuinely undefined,
  not just unbuilt.
- Sequencing relative to Scheduling's own, separately known extraction
  issues, which job cards would inherit by depending on job scopes.
