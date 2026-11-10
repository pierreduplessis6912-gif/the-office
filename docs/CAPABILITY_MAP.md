> **Status:** partly built. **Verified:** 2026-11-09 (row 1 updated after the customers and suppliers build; statuses read from the repository and the committed CI and staging records that day; the "real platform" column is only what a staging record shows). **Owns:** none.

# CAPABILITY MAP: the vision, one capability at a time, and how far each has got

**Why this exists.** Pierre's priority (2026-11-09): the vision, with ALL capabilities tested and wired into the final product eventually. This is the one board that says, for each capability, how far it has really got, so nothing is forgotten between sessions. Update a row in the SAME commit as the work. It is a status board, not a design: designs live in `docs/decisions/`.

## What "done" means for a capability (the Mokoena slice is the pattern)
A capability is DONE only when every box is true. A box not yet true is shown as a dash.
1. **Engine:** its contract exists (validation, permission, availability, held for approval if it writes; reads return the engine's own words and figures).
2. **CI-tested:** a backend test in the slice style (the happy path, every refusal, the stale and unauthorised cases), the twelve invariants still hold, and deliberate breakages are caught.
3. **Real platform:** proven on a real staging object (a real Durable Object refuses things the test harness accepts: the compound-SELECT defect, 2026-11-09, is the proof).
4. **Conversation:** a real model reads the natural sentences for it through the engine's interpreter, judged against a written pass rule.
5. **Explained:** its records open with their provenance trail (what was said, who approved, which contract).
6. **App:** a screen or room uses the real client, not recorded answers.
7. **Outside assistants:** the same capability is reachable through the MCP/other channels through the same door.
8. **Recovery:** snapshot and restore still pass with it (table-size limits respected).
Legend for the columns: **E** engine, **C** CI-tested, **R** real platform, **V** conversation, **X** explained, **A** app, **M** MCP. A tick is true today; "p" is partial (see the note); a dash is not started.

## Core operations (the 16 blueprint domains, `docs/audit/DOMAIN_BLUEPRINT_2026-11-02.md`)
| Capability | Domain | E | C | R | V | X | A | M | Note |
|---|---|---|---|---|---|---|---|---|---|
| Read what a customer owes | Finance | ✓ | ✓ | ✓ | ✓ | ✓ | p | - | App shows it on recorded answers only |
| Open a record (invoice, customer, payment) | Finance | ✓ | ✓ | ✓ | - | ✓ | p | - | Not interpretable by the model yet |
| Record a payment (held, then approved) | Finance | ✓ | ✓ | p | ✓ | ✓ | p | - | On the real object it was held and declined, never approved |
| Decline a held action | Governance | ✓ | ✓ | ✓ | - | - | p | - | |
| Correct a payment | Finance | ✓ | ✓ | p | - | ✓ | - | - | Used in the sample seed on staging |
| Issue an invoice | Sales | ✓ | ✓ | p | - | ✓ | - | - | Numbering continuity and tax output not done |
| Per-business availability and role permissions | Platform | ✓ | ✓ | ✓ | ✓ | - | p | - | |
| Tenant isolation | Platform | ✓ | ✓ | p | - | - | - | - | |
| Provenance trail (capture, interpretation, proposal, approval) | Governance | ✓ | ✓ | - | ✓ | ✓ | p | - | Not yet seen on a real approval |
| Backup and restore of engine tables | Platform | ✓ | ✓ | ✓ | - | - | - | - | A single table above about 18 MB cannot be snapshotted |
| A model as one more interpreter | Automation/AI | ✓ | ✓ | ✓ | n/a | - | - | - | One staging run, 9 of 10 |
| Create and edit customers and suppliers (and find them) | CRM | ✓ | ✓ | - | - | ✓ | - | - | party.create, party.edit (held) and parties.find, CI-tested with ten deliberate breakages; no schema change (an edit is a new fact). Not run on a real object, not shown to the model, not called by the app. docs/decisions/customers-suppliers.md |
| Quotations (create, revise, accept) | Sales | - | - | - | - | - | - | - | Walked on paper [fit test] |
| Credit notes | Sales | - | - | - | - | - | - | - | Walked [fit-domains] |
| Expenses | Finance | - | - | - | - | - | - | - | |
| Purchase orders, goods received, supplier invoices and payments, variances | Procurement | - | - | - | - | - | - | - | Walked [fit test] |
| Stock: receive, issue, count, reserve, value, price list | Inventory | - | - | - | - | - | - | - | Walked [fit-domains] |
| Jobs, projects, scopes, visits, assignments, completion evidence | Projects, Field | - | - | - | - | - | - | - | Walked [fit test] |
| Leads and campaigns | Marketing | - | - | - | - | - | - | - | Walked [fit-domains] |
| Customer service cases | Customer service | - | - | - | - | - | - | - | Walked [fit-domains] |
| Assets and maintenance | Assets | - | - | - | - | - | - | - | Walked [fit-domains] |
| Communications log | CRM | - | - | - | - | - | - | - | Walked [fit-domains] |
| Document output (PDF, share links) | Documents | - | - | - | - | - | - | - | Exports are listed unavailable |
| Governed reports and measures beyond receivables | Intelligence | - | - | - | - | - | - | - | Legacy reports exist on the live system only |
| Reconciliation, cash flow, periods | Finance | - | - | - | - | - | - | - | |
| Field service capacity and scheduling | Field service | - | - | - | - | - | - | - | Not even walked |

## Reach (the future-capabilities register groups, `FUTURE_CAPABILITIES.md`)
| Group | What it is | State |
|---|---|---|
| W: WhatsApp and conversational channels | The same engine through WhatsApp, voice notes, notifications | Not started |
| A: AI ecosystem and MCP | Any assistant can use the engine through its tools | A read-only MCP exists on the LIVE system; the engine has no MCP tools |
| P: Proactive intelligence | Overdue receivables, follow-ups, cash-flow signals, prepared communications | Not started |
| I: External systems | Accounting, banking, calendar and other integrations | Not started on the engine |
| S: Scale and fleet | Storage growth, partitioning, fleet management | Only the snapshot-size limit is measured |
| D: Devices | Native entry points | Not started |
| C: Commercial | Plans, billing, provisioning | Billing exists on the LIVE system; nothing on the engine side |
| N: Network and ecosystem | Cross-business services, suppliers | Not started |
| M: Marketing integrations | Campaign channels | Walked in the fit test only |
| V: Long-horizon outcomes | The network of businesses | Not started |

## The order I propose (each one built to the "done" standard above, one at a time)
1. **Customers and suppliers** (create, edit, find): everything else points at a party.
2. **Quotations**, then **invoices in full** (numbering, tax, output).
3. **Payments and expenses** to completion (approve on a real object).
4. **Purchasing chain**, then **stock**, then **jobs**.
5. **Reports and measures**, reconciliation, cash flow.
6. The **reach** groups, starting with the engine's MCP and a channel.
Each step ends with the app and conversation wired to the REAL client, which needs Pierre's approval to connect. The order is a proposal; tell me to reorder.

## How this stays honest
Every row changes in the commit that changes its truth, with the CI or staging record that shows it. A tick needs a record; "p" says what is missing. If a row cannot be shown true from the repository, it is a dash.
