# Atlas

A real, structured, per-concept register — not of code, of *truth*.
For any concept with more than one real code path touching it, this
names every one of them, what must always be true of the concept
regardless of which path created it, and the real, historical bugs
that came from a path being missed.

**When to use this**: before changing anything about a concept listed
here, read its entry first. The actual, reliable way to verify it's
complete is still a real grep across the codebase for every genuine
creation site — this document exists to make that grep faster to
start by naming the known danger spots up front, not to replace it.
A stale entry is worse than no entry, so if a real path is added or
removed, this file gets updated in the same commit, not later.

**What this is not**: a map of the whole codebase, a test-coverage
report, or a claim about test suites that don't exist. Only real,
verified facts go in each entry. Where something genuinely doesn't
exist yet (like automated tests beyond the smoke-test route), that's
stated plainly rather than implied.

---

## Concept: Invoice

**Created by** (two real, independent paths — both must be checked
whenever something must be true of every invoice):
- `recordInvoice()` (`finance.ts`) — direct invoice, flat amount or
  line items
- `convertQuoteToInvoice()` (`finance.ts`) — quote-to-invoice
  conversion

**Reads from**:
- `customers` (retention rate, VAT-exempt status)
- `business_profile` (VAT registration, rate)
- `quotations` (when converted — amount, job_scope_id)
- `job_scopes` (when priced from a job scope)

**Must always be true, regardless of creation path**:
- `job_scope_id` set when the invoice was actually priced from a real
  job scope (nullable otherwise — a flat, unscoped invoice is a real,
  valid case)
- `retention_percent` / `retention_amount` computed from the
  customer's standing rate, if one exists
- VAT computed at PDF-generation time from `business_profile` and the
  customer's own `vat_exempt` flag — not stored redundantly on the
  invoice itself

**Known, real historical bugs**:
- `convertQuoteToInvoice` never carried forward the source quotation's
  real `job_scope_id`, so a converted invoice silently dropped out of
  a project's real totals even though `recordInvoice` had already been
  fixed to set it directly (2026-07-24). A real, safe, idempotent
  backfill exists for invoices created before the fix
  (`/debug/backfill-invoice-job-scope`).
- A flat, line-item-less invoice (`recordInvoice` with no `lineItems`)
  showed a wrong R0 subtotal on its generated PDF, since subtotal was
  computed purely by summing real line items with no fallback to the
  invoice's own stored amount (2026-07-21).

**Test/verification coverage**: no automated test suite for invoice
creation logic. Verified each time via live, real-data testing against
the deployed Worker — see DECISIONS.md's bug archive for the specific,
real scenarios each fix was proven against.

---

## Concept: Job Scope

**Created by** (one real path):
- `recordWorkObservation()` (`scheduler.ts`)

**Referenced by** (real, verified downstream consumers — a change to
Job Scope's shape or meaning likely touches all of these):
- `quotations.job_scope_id` / `invoices.job_scope_id` (pricing
  provenance)
- `job_scopes.project_id` (Layer 2 same-breath/cross-capture grouping)
- `job_scopes.scheduled_date` / `scheduled_date_raw` (scheduling)
- `job_scopes.capture_id` (the same-breath assembly signal itself)
- `scope_components` / `scope_tasks` (component measurements and
  linked tasks)

**Must always be true**:
- `customer_id` is a real, reconciled customer — never guessed
- `capture_id` is set (needed for same-breath assembly to function at
  all)
- Each real component may have `area_sqm`; each real task may be
  linked to a component via `component_id` — a task itself has no
  area of its own

**Known, real danger, proven live, not theoretical**: once a customer
can genuinely have more than one job scope (true since Layer 2's
same-breath and cross-capture assembly), "the customer's most recent
job scope" is not a safe default for anything — real evidence exists
of this producing a wrong quotation.

**Known, real historical bugs**:
- `findLatestJobScope` matched the wrong job scope entirely, using a
  most-recent heuristic that ignored what was actually named in the
  message (2026-07-22).
- The first fix for the above didn't work on its own — the customer's
  own name matched every one of their job scopes equally (component
  names are prefixed with the customer's name), always winning the
  match regardless of what was actually said. Fixed by excluding the
  customer's own name from the matching words.
- `buildQuotationLineItems` only ever matched against components
  directly, never against tasks — so a per-sqm rate stated for a task
  (e.g. "screed") had no area to price against, since only the task's
  *linked component* has one. Fixed across all three real call sites,
  not just the one the bug was found on (2026-07-22).

**Test/verification coverage**: no automated test suite. Verified live
each time — see DECISIONS.md's Layer 2 write-ups for the specific,
real scenarios (including three consecutive real failures on one test
before the correct fix landed).
