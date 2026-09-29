# Feature Status Matrix

A real, current snapshot — not a claim about architecture, a lens for a
new reader (or a future session) to see what actually exists, what's
reachable from where, and what's genuinely been tested versus assumed
safe. Kept honest: "Tested" means live-verified or covered by the real
CI test suite, not "should work."

| Feature | Backend | Voice/Text | App (native) | Web preview | Auth-gated | Tested |
|---|---:|---:|---:|---:|---:|---:|
| Text capture | Yes | Yes | Yes | Yes | Yes | Yes |
| Voice capture | Yes | Yes | Yes | No | Yes | Partial |
| Photo/document capture | Yes | — | Yes | No | Yes | Yes |
| Quotations | Yes | Yes | Yes | Yes | Yes | Yes |
| Invoices | Yes | Yes | Yes | Yes | Yes | Yes |
| Payments | Yes | Yes | Yes | Yes | Yes | Yes |
| Expenses | Yes | Yes | Yes | Yes | Yes | Yes |
| Purchase orders | Yes | Yes | Yes | Yes | Yes | Yes |
| Goods received / variance | Yes | Yes | Partial | No | Yes | Yes |
| Supplier invoices | Yes | Yes | Partial | No | Yes | Yes |
| Snags | Yes | Yes | Yes | Yes | Yes | Yes |
| Leads | Yes | Yes | Yes | Yes | Yes (owner-only) | Yes |
| Projects | Yes | Yes | Yes | Yes | Yes | Yes |
| Stock | Yes | Yes | Yes | Yes | Yes | Yes |
| Customers (list + profitability) | Yes | Yes | Yes | Yes | Yes | Yes |
| Products (identity, buy+sell link) | Yes | Yes | No room yet | No | Yes | Yes |
| PDF documents (invoice/quote/statement/reports) | Yes | — | Yes | Yes | Yes (signed links) | Yes |
| Business profile / logo | Yes | — | Yes | Yes | Yes (owner-only) | Yes |
| Tasks / scheduler | Yes | Yes | Yes | Yes | Yes | Partial |
| Memory (customer/character facts, notes) | Yes | Yes | Partial | No | Yes | Partial |
| Role scoping (owner/accountant/installer) | Yes | Yes | Yes | — | Yes | Yes, live |
| CSV import (customers, invoices) | Yes | — | Yes | Yes | Yes (owner-only) | Partial |
| Idempotency (text, uploads) | Yes | — | Yes | Yes | — | Yes |
| CORS allowlist | Yes | — | N/A | Yes | — | Yes, live |
| Structured logging | Yes | — | N/A | N/A | — | Yes, live |

## What "Tested" actually means here

- **Yes** — either live-verified against the real, deployed system with
  real data, or covered by the real, committed CI test suite
  (`tools/role-matrix.test.js`, the typecheck gate).
- **Yes, live** — specifically confirmed against the real, deployed
  worker with a real request, not just offline or in CI.
- **Partial** — the real, core path has been exercised and works;
  known, named edge cases haven't been (voice capture's transcription
  fallback path, memory consolidation's retry behavior under a genuine
  partial failure).
- No blank "No" row exists deliberately — a feature real enough to list
  here has had at least some direct verification; anything that hasn't
  isn't included as if it were done.

## What this document does not cover

- The remaining file-splitting work (`finance.ts`, `ai.ts`, `main.dart`,
  the `processOneExtraction` rewrite) — tracked in
  `SECURITY_AND_OPERATIONAL_READINESS.md` and
  `PROCESS_ONE_EXTRACTION_REWRITE.md`, not duplicated here.
- Real, pinned architectural designs not yet built (WhatsApp, onboarding,
  self-help, conversational BI) — those are real, upcoming work, not
  features to mark done or not-done in a present-tense table like this
  one.
- This table itself needs updating in the same commit as any real,
  future change to what it describes — the same discipline `ATLAS.md`
  already holds itself to — or it becomes exactly the kind of stale
  documentation this whole cleanup tier exists to prevent.
