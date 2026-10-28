> **Status:** archived. **Verified:** not yet. **Owns:** none.

> **Archived 2026-10-27.** The audit log of 2026-10-26, when the connector had 16 tools (11 read-only). It is a record of what was tested that day, not the current state: there are now 21 tools and the live results are in `PHONE_TEST_SCRIPT.md` and `MCP_ARCHITECTURE.md`.

# MCP test log (chronological, append-only)

One entry per meaningful test, newest session last. Current state, risks and priorities live in [MCP_TEST_SUMMARY.md](MCP_TEST_SUMMARY.md); this file is the evidence. Read [MCP_ARCHITECTURE.md](../../MCP_ARCHITECTURE.md) for what the MCP adapter is meant to do.

**Rules for entries.** Observations and hypotheses are labelled; nothing here is invented. This repo is PUBLIC and the tests run against production data, so entries use record IDs and counts only: no customer names, no amounts (except a difference of 0.00 and ratios), no links, no keys. Latency was NOT measured in any entry (the chat host exposes no timing); "total elapsed" is not recorded either. Fields: ID, scenario, environment, expected, actual, tools, result (pass/fail/partial/blocked/not verified), data quality, cause, category, severity/priority (S1 security or integrity, S2 wrong money, S3 broken workflow, S4 friction, S5 idea), action, acceptance, regression, status.

## Session 2026-10-26-A: first capability audit (Claude on claude.ai, read-only, production)

**Access verified:** the connector lists 16 tools in this chat. I loaded and used the 11 read-only ones (names match the stage-1 list in `MCP_ARCHITECTURE.md`). CORRECTION (same day, after the first push): the first version of this entry said 11 tools in all and nothing that writes; that was wrong. The other 5 were never loaded or called: `tell_the_office`, `schedule_job`, `edit_created_record`, `confirm_pending_action`, `reject_pending_action` (write-capable; repo stages 2 and 3, partly not deployed per `HANDOVER.md`). They are NOT verified and need Pierre's explicit go-ahead and the test business before any call. The auth mechanism (OAuth connector or key) is not observable from the chat. **Not accessible:** the repo was cloned read-only (public); there was no GitHub token, so nothing could be pushed. No tool exposes the running commit, so "production runs `c78633d`" (from `HANDOVER.md`) is not re-verified here.

| ID | Scenario | Tools | Result |
|---|---|---|---|
| MCPT-20261026-01 | Connect and list tools | tool discovery | partial (16 listed; the 11 read-only ones used; 5 write-capable ones not tested) |
| MCPT-20261026-02 | "Show me some customers" | list_customers(limit 5) | pass; see F-02, F-08 |
| MCPT-20261026-03 | "Latest invoices" | list_invoices(limit 5) | pass; see F-01, F-02, F-07 |
| MCPT-20261026-04 | "Who owes us, and how old is it?" | get_aged_debtors | pass on arithmetic; see F-03, F-09 |
| MCPT-20261026-05 | One customer's receivables | get_customer_receivables(one id) | pass (`reconciles: true`) |
| MCPT-20261026-06 | "What stock is low?" | get_stock(limit 10) | partial; see F-05 |
| MCPT-20261026-07 | "What jobs are coming up / outstanding?" | list_jobs(limit 5) | partial; see F-06 |
| MCPT-20261026-08 | "Open quotes" | list_quotes(limit 5) | partial; see F-01 |
| MCPT-20261026-09 | P&L reconciles to invoices | get_profit_and_loss + list_invoices(from 2026-09-01, to 2026-10-25, limit 100) | pass on revenue; see F-04 |
| MCPT-20261026-10 | "Why did revenue change?" | analyse(revenue, Oct 1-25) | pass; see F-10 |
| MCPT-20261026-11 | Audit trail of past requests | get_recent_history(limit 3) | pass; see F-11, F-12 |
| MCPT-20261026-12 | Customer document link | get_document_link | not verified (deliberately not called, see below) |
| MCPT-20261026-13 | Isolation and roles | none available | not verified |

**Details that matter**

- **-05 and -09 (money).** Expected: totals agree across tools. Actual: the 26 aged-debtor rows sum to the report total, and the bucket totals sum to it too; the P&L revenue for 2026-09-01 to 2026-10-25 equals the sum of the 30 invoices that `list_invoices` returned for the same range (difference 0.00; 30 rows against a limit of 100, so no paging was involved). The one-customer report (-05) also reports `reconciles: true`. These are internal agreements between tools on one day; they do not prove the underlying invoices are right.
- **-12.** Not called: it mints a signed, sign-in-free link to a real customer document in production. Needs Pierre's explicit go-ahead and a synthetic document (use the test business).
- **-13.** One business is visible to this session and there is no tool to switch or to act as a lesser role; `ownerOnly` enforcement and isolation are covered by `tools/mcp-endpoint.test.js` but not verified through a live client.
- **Workflows.** "Biggest customer by spend" cannot be answered by one tool (see F-12); it would take about 4 `list_invoices` pages and a sum done by the model. Not run end to end. No workflow was claimed end-to-end beyond P&L-to-invoice reconciliation.

**Findings from this session** (full table in the summary)

| ID | Observation (facts) | Hypothesis, labelled | Cat | Sev | Status |
|---|---|---|---|---|---|
| F-01 | Invoices 311/312 (same customer, amount and description, 80 s apart) and quotes 27/28 (same customer, amount, description) look like repeats. | A repeated dictation or retry created two records; unconfirmed, and the intent may be genuine. | BUG | S2 | proposed |
| F-02 | Customers 13 and 223 are the same name apart from letter case; both hold open invoices. History row 5 resolved the spoken name to 13 while invoice 309 went to 223. | Name matching was case-sensitive at one point; unconfirmed. `list_customers` says merged duplicates are left out, so these were never merged. | BUG | S2 | proposed |
| F-03 | Aged-debtor buckets count from the date entered. The Sept 1 import put all imported invoices at one date, so most of the debt sits in one bucket. | Known and decided: `docs/decisions/extraction-and-pipeline.md` ("Which date"). The source date is held in the pending action's payload but not stored on the invoice. | CAPABILITY | S2 | proposed |
| F-04 | P&L shows cost of sales 0 and operating expenses 0, so net profit equals revenue. | No expenses are captured at all, or none are categorised; not established. | CAPABILITY | S2 | proposed |
| F-05 | Two tracked stock items, both with no reorder threshold, so `below_reorder` can never be true. | Thresholds were never set; the data is the cause, not the tool. | CAPABILITY | S4 | proposed |
| F-06 | Jobs carry no status, assignee or completion; job 43 has no customer; jobs 39 and 41 look alike. | Status is not modelled for job scopes; unconfirmed. | CAPABILITY | S3 | proposed |
| F-07 | Invoice 308's description is the dictated instruction ("generate an invoice for ..."), not a clean description. | The raw transcript is stored when no description is extracted. | UX | S4 | proposed |
| F-08 | All customers seen have no address (5 of 5). | Import carried no address; unconfirmed. | BUG | S5 | proposed |
| F-09 | Bucket field names (`days30`, `days60`) hold 30-60 and 60-90 day ages; one customer with a zero balance still appears as a row. | Naming left over from an earlier shape. | UX | S4 | proposed |
| F-10 | `analyse` flags every customer in a window as `new_in_period` when the comparison window has none of their invoices, including customers with earlier imported invoices. Evidence is attached for 3 of 5 contributors (documented in `limits`). | The flag means "none in the comparison window", not "new customer". | UX | S4 | proposed |
| F-11 | In history rows 6 and 7 (source "text"), `recorded.heard` holds many partial phrases joined without spaces ("who", "who is", "who is our", ...). | Interim speech results are appended instead of replaced, in the app or the history writer; unconfirmed. | BUG | S3 | proposed |
| F-12 | "Who has spent the most with us" opened a financial snapshot; the earlier "biggest customer" got a clarifying question. No MCP tool ranks customers by revenue. | Missing combined query (see summary). | CAPABILITY | S3 | proposed |
| F-13 | `HANDOVER.md` "Backend live" line said five MCP tools when this audit began; eleven read-only plus write-capable tools exist. | Stale line after stage 1 went live. | BUG (docs) | S5 | proposed |

**Security note (SECURITY, S4, observation).** Free-text fields (invoice and quote descriptions, history transcripts) come back to the model unchanged and are written from dictation. They are untrusted input. The 11 tools used are read-only, but the connector also lists write-capable tools (`tell_the_office`, `confirm_pending_action`, ...), so the exposure is real; `MCP_ARCHITECTURE.md` concerns 1 and 3 apply now (see `MCP_ARCHITECTURE.md`, concerns 1 and 3).

**Not measured:** latency (all tests); pagination past one page; every quote status other than draft; stock movement; suppliers, purchase orders, staff and reminders (no MCP tool exists for them; that is a capability finding, not a failure).

**Files changed this session:** `MCP_TEST_LOG.md`, `MCP_TEST_SUMMARY.md`, `INDEX.md` (one table row and the status list). Committed locally in the audit container only; NOT pushed, NOT deployed.
