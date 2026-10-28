> **Status:** archived. **Verified:** not yet. **Owns:** none.

> **Archived 2026-10-27.** The summary of the 2026-10-26 audit (16 tools, 11 read-only). Not the current state: see `MCP_ARCHITECTURE.md` and `PHONE_TEST_SCRIPT.md`.

# MCP test summary (current state)

Evidence is in [MCP_TEST_LOG.md](MCP_TEST_LOG.md); findings are named F-nn there. This page is rewritten as things change; the log is not. Only things actually observed are stated as fact. Public repo: no customer names or amounts here.

## What works (observed 2026-10-26, production, read-only)

- The connector lists 16 tools; the 11 read-only ones were called from a claude.ai chat (the 5 write-capable ones were not touched): `get_profit_and_loss`, `analyse`, `get_aged_debtors`, `get_customer_receivables`, `get_recent_history`, `list_customers`, `list_jobs`, `list_invoices`, `list_quotes`, `get_stock`, `get_document_link` (the last one not exercised).
- Money agrees across tools: aged-debtor rows and buckets sum to the report total; P&L revenue equals the sum of the period's invoices (difference 0.00). Reports label what is fact, calculated, or not established, which is the right habit.
- The history tool shows a request's full life (heard, interpreted, replied, proposed, decided, written) and the screen the person was viewing.

## What is not verified

The 5 write-capable tools (`tell_the_office`, `schedule_job`, `edit_created_record`, `confirm_pending_action`, `reject_pending_action`) and the human-confirms-money rule through them; latency; business isolation and non-owner roles through a live client; `get_document_link`; paging past one page; any quote status except draft; the running commit; the Flutter app on a device (per `HANDOVER.md`).

## Backend limitations (priority order)

0. **Highest-risk untested area:** write-capable tools, including a confirm that an assistant can call. `MCP_ARCHITECTURE.md` concern 1 says the model must not confirm its own money; the first test is on the test business, with Pierre's go-ahead.

1. **Money and data integrity (S2).** F-01 repeated-looking invoices and quotes; F-02 the same customer split by letter case, with open invoices on both; F-03 no business date, so ageing and period reports follow the import date (decided and documented, but it makes the largest debtor bucket mostly an import artefact); F-04 no expenses, so "net profit" equals revenue.
2. **Broken workflows (S3).** F-06 jobs have no status, so "what is outstanding" cannot be answered; F-11 history transcripts are concatenated partials; F-12 no revenue-by-customer ranking, so a basic question takes about 4 paged calls plus a sum by the model.
3. **Coverage.** No MCP tools for suppliers, purchase orders, staff, tasks, notes or reminders. Whether the backend has them is not checked here.
4. **Friction (S4/S5).** F-05, F-07, F-08, F-09, F-10, F-13.

## Flutter projection opportunities

Only where the backend already returns enough. Each needs the seven-point write-up (scenario, limit, experience, backend change, behaviour, acceptance, risks) before it is accepted; the first two are drafted.

- **P-1: Debtors room with an honest age.** *Scenario:* "Who owes me, and who should I chase?" *Limit:* the buckets are dominated by the import date (F-03) and the field names mislead (F-09). *Experience:* one projection (stacked bars by bucket, tap a customer for the receivables list), with a one-line note when most of a bucket shares one entry date. *Backend change:* expose the count of invoices sharing an entry date, and rename the bucket keys (envelope version bump). *Acceptance:* a bucket whose invoices share one entry date shows the note; names read 0-30, 30-60, 60-90, 90+. *Risks:* needs F-03 first to be truly useful.
- **P-2: Ember for suspected repeats.** *Scenario:* two matching invoices a minute apart. *Limit:* nothing flags it (F-01). *Experience:* a quiet ember on the later one: "Same customer, amount and description, 80 seconds apart. Keep both?" with a clear keep/void approval. *Backend change:* a repeat check at hold time, using the same rule as Principle 28's content check. *Acceptance:* a regression feeds the two-invoice case and expects one held action carrying a repeat flag. *Risks:* false positives for real repeat jobs; the person decides, so cost is one tap.
- **Not yet proposals (single observation):** a top-customers projection (needs the ranking from F-12 first); a job board by status (needs F-06).

## Proposed regression tests (none written yet; repo convention is `tools/*.test.js`)

- RT-1: P&L revenue for a range equals the sum of `list_invoices` for the same range (the check done by hand in MCPT-20261026-09). Fits `tools/mcp-endpoint.test.js`.
- RT-2: two identical dictated invoices in one minute produce one held action with a repeat flag (F-01).
- RT-3: "Alfons" and "alfons" resolve to one customer (F-02).
- RT-4: a text turn's `heard` equals the final transcript only (F-11).
- RT-5: aged-debtor row totals equal bucket totals equal the report total.

## Three highest-value next actions

1. Test the write path on the test business (explicit go-ahead needed): can an assistant confirm its own invoice?
2. Confirm with Pierre whether invoices 311/312 and the two customers are genuine, then fix F-01 and F-02 (they change what is owed).
3. Decide on the business-date piece of work (F-03) and on recording expenses (F-04); both change what the reports mean.
