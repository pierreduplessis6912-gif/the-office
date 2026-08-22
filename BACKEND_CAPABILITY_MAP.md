# Backend Capability Map — Ingest / Store / Relay

Pinned for planning the "ERP mode" behind the void, per direct
instruction: scope the whole system first, forget building anything
yet. Every route, table, and field named below was checked directly
against the real, current `worker/src/` code — nothing here is
assumed. Organized the way the actual system works: one shared
ingestion pipeline feeding many separate domains, each with its own
storage shape and its own (partial) retrieval surface.

---

## 1. Ingestion — how anything gets in, at all

Every input type — typed text, voice transcript, photo, document —
flows through exactly one function, `logCapture()`, into one table,
`captures`. Nothing bypasses this. `source` distinguishes the type
(`text` / `voice` / `photo` / `document`); a photo or document is
logged with a placeholder raw_text ("[photo — description pending]")
until vision/OCR fills it in.

From there, a separate extraction step (not the same request) reads
the raw capture and, when it can, fills in `subject_hint`,
`customer_id`, and/or `character_id`, and flips `extraction_status`
to `processed`. This is why `character_id`/`customer_id` filtering
works cleanly on `/debug/captures` — it's a real, structured column,
not fuzzy text matching after the fact.

**What this means for ERP mode:** there is exactly one, uniform
"history" concept underneath every domain — a chronological stream
of captures, some now linked to a person, a customer, a job, or
nothing at all. A single, reusable "raw history" view could serve
every module, not just people.

---

## 2. People (personal relations) — `characters`

- **Store:** `characters` (id, name, relationship, created_at — no
  visible `CREATE TABLE`, an original/foundational table). Real,
  separate `character_facts` table (structured key/value, sourced
  from transcripts). Real, separate `character_notes` (via
  `appendCharacterNote`).
- **Relay:** `/debug/characters` (list, includes notes),
  `/debug/character-facts?characterId=X`,
  `/debug/find-character`, `/debug/captures?characterId=X`.
- **Real, confirmed gap:** no relationship to `customers`, invoices,
  quotes, or projects at all. This is personal relations only (wife,
  nanny, staff) — never business contacts. Already logged in
  `ROOMS_BACKEND_SCOPE.md`.

## 3. Customers / Sales

- **Store:** `customers` (no visible `CREATE TABLE` — foundational).
  Real, separate `customer_notes`. Quotations and invoices exist as
  real, distinct concepts (see below) — not stored on the customer
  row itself.
- **Relay:** `/debug/find-customer`, `/debug/customer-notes`,
  `/debug/quotations`, `/debug/invoices`.
- **Real, confirmed gap:** no single "customer detail" route that
  joins notes + quotations + invoices + job history together — each
  is a separate query today. A real customer detail view would need
  to assemble these itself, not call one existing endpoint.

## 4. Scheduling / Jobs

- **Store:** `job_scopes_new` (the real, current table — an earlier
  `job_scopes` was migrated away from), `tasks`, `projects`.
- **Relay:** `/debug/job-scopes`, `/debug/schedule`, `/debug/tasks`,
  `/debug/projects`.
- **Real, confirmed strength:** this is genuinely rich — job scopes
  carry the co-birth/deterministic-grouping logic already proven
  tonight's earlier sessions, real scheduling data, real task
  tracking.

## 5. Finance (quotations, invoices, expenses)

- **Store:** quotations/invoices (foundational, no visible `CREATE
  TABLE`), `expenses`, `business_profile`.
- **Relay:** `/debug/quotations`, `/debug/invoices`,
  `/debug/expenses`, `/debug/aged-creditors`,
  `/reports/aged-debtors/pdf`, `/reports/profit-and-loss/pdf`,
  `/debug/business-profile`.
- **Real, confirmed strength:** this is the most mature, most tested
  domain in the whole backend — deterministic totaling/VAT/deposit
  math, guarded quote-to-invoice conversion, real PDF generation
  already proven working.

## 6. Suppliers

- **Store:** `purchase_orders`, `po_line_items`,
  `goods_received_notes`, `grn_line_items`, `variance_dispositions`,
  `supplier_invoices`, `supplier_invoice_line_items`,
  `supplier_payments`.
- **Relay:** `/debug/purchase-orders`, `/debug/goods-received`,
  `/debug/supplier-invoices`, `/debug/variance-dispositions`.
- **Real, confirmed strength:** genuinely rich, multi-table, already
  proven (the supplier-statement-reconciliation work). Matches the
  earlier finding in `ROOMS_BACKEND_SCOPE.md`.

## 7. Inventory

- **Store:** `stock_items` (name, unit, quantity_on_hand,
  reorder_threshold — confirmed no price field), `stock_usage_log`,
  `stocktakes`, `stocktake_lines`.
- **Relay:** `/debug/stock-items`, `/debug/stocktakes`.
- **Real, confirmed gap:** no pricing/catalog concept at all, as
  already found. Quantity-tracking only.

## 8. Field operations

- **Store:** `snags`, `leads`.
- **Relay:** `/debug/snags`, `/debug/leads`.
- **Real, unresolved:** these two haven't been explored in any prior
  session tonight — genuinely unknown how rich they are without
  reading further.

## 9. Home-screen embers (summary counts only)

- `/embers/tasks`, `/embers/scheduler`, `/embers/finance`,
  `/embers/expenses`, `/embers/suppliers`, `/embers/pending` — these
  power the five ember counts already live on the void. Summary
  numbers only, not list/detail data — a real, separate, already-
  solved concern from what ERP mode would need.

---

## The real, honest shape of what "ERP mode" would need to build

Every domain above already has real ingestion and real storage. The
gap is uniformly on the **relay** side: most `/debug/*` routes return
one table's raw rows, unfiltered beyond a single foreign key, with no
shared concept of search, sort, pagination, or cross-table detail
views (a customer's notes + quotes + invoices together; a job's
tasks + snags + linked captures together). None of that assembly
exists in the backend today — it would need to be built, not just
surfaced.

**So the real scoping conclusion:** the front-end shell (sidebar,
table, search, detail-view pattern) is only half the work. The other
half — real, joined, list-and-detail-shaped read endpoints per
domain — doesn't exist yet for most domains and would need genuine,
new backend work, domain by domain, not just a new way of displaying
what's already there. Finance and Suppliers are the closest to
ERP-ready as-is; Inventory and the two unexplored field-ops tables
(snags, leads) are the furthest.
