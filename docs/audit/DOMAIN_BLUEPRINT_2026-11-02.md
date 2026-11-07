> **Status:** proposed. **Verified:** not yet. **Owns:** none.

> Extract: section 3 of [the Architecture decision report](ARCHITECTURE_DECISION_REPORT_2026-11-02.md), verbatim. Recovered on 2026-11-07 from the assistant's own saved transcript of the 2026-11-02 session (engine direction and restore), because it had never been committed. Written against repository commit `f469510`. Verbatim, except that one closing sentence about a session token was removed. It is a PROPOSAL: Pierre accepted rebuilding the engine core on a retained platform substrate as the leading direction, subject to clarifications, and the amended proposal followed.

## 3. Capability coverage across the 16 domains
Verification tiers: V1 is authored fixtures executed in CI [X]. V2 is real-platform staging rehearsals [X]. V3 is real-use proofs in the handover [D].

| # | Domain | Status | What exists / what is missing |
|---|---|---|---|
| 1 | Platform and admin | Partial | Directory, plans and limits, memberships, signup, billing (sandbox only). **No per-business capability availability.** V1, V2. |
| 2 | CRM | Partial | Customers, characters, a `people` link, leads, facts. **No communications.** V1. |
| 3 | Sales | Partial | Quotes, quote-to-invoice with deposit and retention math, payments. **No sales order, revision, acceptance or credit note.** V1, V3. |
| 4 | Finance | Partial | Expenses, P&L, aged debtors and creditors, statements. **No ledger, reconciliation, cash flow, periods or allocation records.** V1, V3. |
| 5 | Procurement | Partial, strongest | PO, goods received, three-way match, variance dispositions, supplier statements. **No requests, approvals or supplier credits.** V1, V3. |
| 6 | Inventory | Partial | Items, usage, stocktake, unit conversions. **No movement ledger, reservation, valuation or price list.** V1. |
| 7 | Projects and jobs | Partial | Scopes, projects, amendments, project profitability. **No budgets, labour or milestones.** V1, V3. |
| 8 | Field service | Partial | Scheduling, installers, snags as rework. **No capacity, visits or sign-off.** V1, V3. |
| 9 | Documents | Implemented, partly verified | Verbatim captures, vault, upload classification, PDFs, notes. V1, V3. |
| 10 | Customer service | Minimal | Snags only. **No cases or complaints.** |
| 11 | People | Minimal | Memberships and roles. Payroll is an integration boundary. |
| 12 | Assets | **Missing** | No trace in the code. |
| 13 | Marketing | **Missing** | Leads only. No campaigns or sources. |
| 14 | Intelligence | Partial | Reports and analysis. **No forecasts or trends.** V1, V3. |
| 15 | Automation and AI | Partial | A closed 31-intent catalogue, a bounded conversation layer, 21 outside-assistant tools. **No triggers, recurrence or discovery.** |
| 16 | Governance | Implemented, partly verified | Audit, atomic writes, backups, 4 restore drills, undo. **Gaps:** direct-write provenance, float money, 2 foreign keys, no ledger invariants. V1, V2. |
