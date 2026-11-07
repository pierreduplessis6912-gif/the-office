> **Status:** proposed. **Verified:** not yet. **Owns:** none.

> Recovered on 2026-11-07 from the assistant's own saved transcript of the 2026-11-02 session (engine direction and restore), because it had never been committed. Written against repository commit `f469510`. Verbatim, except that one closing sentence about a session token was removed. It is a PROPOSAL: Pierre accepted rebuilding the engine core on a retained platform substrate as the leading direction, subject to clarifications, and the amended proposal followed.

# Architecture decision report

This was read-only. Nothing was edited, run, merged or deployed. I read the repository at `f469510`, the prior reports, the handover and the committed CI and staging records. I did not verify the app on a device. I did not exercise any real model, and I could not see production data.

Labels: **[C]** source, **[D]** documentation, **[X]** executed result, **[I]** my inference, **[U]** unknown.

**Premise correction:** I've treated Zululand as test data, as you say. The handover calls it "Pierre's real one", so that line is wrong. My earlier case for keeping this repository partly rested on a live business that had to keep running. That premise is withdrawn, and it's new evidence, so I'm reopening the question.

## 1. Verdict: rebuild the engine core on a retained platform substrate

**Recommendation:**
- **Rebuild:** the business-reality model, the capability layer, the interpretation boundary, and the domain code.
- **Retain:** the platform and trust substrate.
- **Where:** a clean engine module in this repository, not a new repository.
- **Confidence:** medium-high on the direction, medium on the shape.

**Why rebuild the core, not evolve it [C]**
- **Money is floating-point.** There are 35 `REAL` columns and no integer minor units.
- **Few relationships are enforced.** The baseline schema declares 2 foreign keys.
- **Payments are never matched to an invoice.** Outstanding is derived oldest-first at read time (`finance.ts:2987`).
- **Parties are role-as-text.** A supplier is a `characters` row with `relationship = "supplier"`.
- **Voiding rewrites history.** The statement sets `amount = 0`.
- **The job concept is split.** `jobs`, `job_scopes` and `projects` overlap, and nothing in the worker writes `jobs`.
- **No labour, ledger or sales-order concept exists.**
- **The code is monolithic.** `finance.ts` has 4,351 lines and 121 exported functions across sales, stock, leads, reports and PDFs. `index.ts` has 4,204 lines, and the app's `main.dart` has 10,290.
- **The catalogue is closed.** There are 31 intents, a 41k-character prompt and a cast, unchecked model output.

**Why keep the substrate [X]**
- **Isolation:** a Durable Object per business, with isolation executed on real Cloudflare.
- **Authorisation:** deny-by-default gates and the held-action lifecycle.
- **Recovery:** the backup path, with 4 restore drills passed after the fix.
- **Verification pipeline:** CI with 8,683 checks on two backends, and the staging rehearsal.
- **Why not a new repository:** it adds nothing a directory boundary can't. It would lose the constitutions, history, CI and the verified pipeline.

## 2. Target architecture: responsibilities and boundaries
The engine's responsibilities, as a chain with enforceable seams:

1. **Capture:** verbatim input stored first, and kept.
2. **Business reality:** one per-business store of parties, relationships, events and documents.
3. **Interpretation:** the model *proposes* a capability and a typed payload. It never decides or writes.
4. **Capability resolution:** does the engine know it, and does this business have it?
5. **Validation and preconditions:** checked against the facts, not just the shape of the input.
6. **Authorisation and approval:** may this member do this? Is consent required?
7. **Deterministic execution:** atomic, and it records an outcome event.
8. **Projection:** every position (balance, stock, status) has one derivation.
9. **Response:** truthful and permission-aware, through any interface.
10. **Observations:** an unsupported request is kept and answered honestly, with no invented operation.
11. **Governance:** audit, recovery and reversals.

**Five conditions, kept distinct (your section 6):**
- **Understood:** the engine declares a contract for it.
- **Available:** a per-business record says so.
- **Permitted:** a member permission.
- **Valid now:** preconditions evaluated against facts.
- **Executed:** an authorised outcome event.

**Capability changes and discovery**
- The capability-contract proof shows one workable enforcement boundary. It checks at the door and again at confirm, and legacy declarations can't loosen it [X]. It does not prove the product capability.
- **Introducing, configuring, restricting or improving** a capability means changing its contract or a business's availability record. Neither touches unrelated capabilities.
- **Discovery** is a chain over what's recorded: observation, then potential need, then evaluation (existing capability, configuration, or genuine gap), then an authorised decision, then a controlled change. The engine records observations and answers honestly. A potential need is never promoted to truth, and a proposal never counts as an authorised change. How needs are evaluated and who decides remains an open product question; I'm not designing it.

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

## 4. Workflow integrity
- **Sales:** customer, quote and invoice exist, with deposit math in code. A quote has only two states, draft and converted. An invoice is issued, voided or converted. A payment belongs to a customer and is never matched to an invoice. **Answerable [C]:** what was promised, invoiced and paid, and what remains, from one derivation. **Not answerable:** what must happen next, and under what conditions.
- **Purchasing:** the strongest chain. A PO has no status column and its delivery status is derived. A three-way match with variance dispositions exists, and so does duplicate detection. Supplier payments are per supplier and not allocated to invoices. There is no approval step.
- **Jobs:** scheduling and cost linking exist. Costs are attributed through the customer, which is customer-centred. There is **no labour** concept at all. Profitability is project-level.
- **Contracting flow:** deposit, procurement, supplier invoice and stock use exist. **Missing:** revision, acceptance, retention *release* (only a mention in a comment), and per-invoice allocation.

## 5. Existing component decisions
| Component | Decision |
|---|---|
| Worker, Durable Object per business, directory, scoped stores | **Retain** |
| CI, staging rehearsal, records, test harness | **Retain** |
| Backup and restore | **Retain.** It is schema-agnostic. |
| Auth tables, route policy | **Retain, redesign:** separate availability from permission. |
| Held-action lifecycle | **Retain, redesign:** make it generic over contracts, and record who created each action. |
| MCP transport, OAuth, keys | **Retain, redesign:** tools derived from the contracts a business and member have. |
| Conversation layer and doctrine | **Retain, redesign:** feed it the business's real capability list. |
| Extraction and prompt | **Replace** with a validated boundary. |
| Domain code (`finance.ts`, scheduler, pricing) | **Replace.** Use it as a behaviour reference only. |
| Schema (42 baseline plus 38 runtime tables) | **Replace.** |
| Reports and PDFs | **Investigate:** the drawing code may port, the data layer won't. |
| Characterization fixtures | **Retain** as an oracle of intended behaviour. |
| Flutter `main.dart` | **Replace progressively** (see section 7). |
| Constitutions and decision records | **Retain** |

## 6. Business-reality model: minimum principles
1. **One party graph** with roles (customer, supplier, worker), not a table per role.
2. **Relationships are typed.** "Owned" relationships are enforced by the database. "Related" ones are explicit link records.
3. **Events are immutable.** Positions (balances, stock, status) are derived once, or are pointers that provably reconcile.
4. **Money is exact:** integer minor units, a currency, and tax per line.
5. **Allocations are first-class records:** payment to invoice, receipt to order line, stock to job. They are not inferred at read time.
6. **Every record carries provenance:** who or what initiated it, which capture or document, and which approval.
7. **Lifecycles are named transitions** with preconditions. Each transition is an operation.
8. **Corrections are events.** Nothing is rewritten in place, so no `amount = 0` voids.
9. **Configuration is data:** units, tax, currency, time zone and terminology per business.
10. **Knowledge and action permissions are separate,** and both are independent of availability.

## 7. Interface direction
- **Verified [C, D]:** a `FilamentOrb` exists. A versioned reply envelope contract exists on both ends and is pinned by a contract test. A workspace-context mechanism and 12 Dart test files exist. The last recorded analyze and tests succeeded on 27 Oct. Slices 3 to 10 are **not verified on a device** [D].
- **Verdict on Flutter:** a suitable toolkit, not an established foundation. `main.dart` holds 83% of the app. I would keep Flutter and reuse the envelope reader, the `runtime/` folder, the access guard and the tests. I would build the first slice as a thin new shell and retire `main.dart` progressively. The interface adapts to the engine, and correctness never depends on which interface asked.
- **Unknown [U]:** whether the orb, drill-down and return-to-conversation feel right. Only you opening the web preview or a build can answer that.

## 8. First working product slice
**Scenario:** two synthetic businesses with different capability sets, and the sales end of the chain.
1. You speak or type: "What does Mokoena owe me?"
2. Business A answers from its own data, with the permitted detail, and says where the figures come from.
3. You drill to the invoices, then to one invoice with its payments, and return to the conversation with context intact.
4. You say "Record R500 from Mokoena." It is held, you approve it, and the answer changes.
5. In Business B, where the capability is not available, the same sentence is kept, answered honestly, and recorded as an observation.

**Acceptance criteria**
- Exact money (integer units).
- A payment allocation record exists.
- Outstanding has one derivation.
- A restricted member is refused with a reason, and sees no figures.
- Availability, permission and validity each fail independently.
- Executed atomically, with an outcome event and provenance.
- An unavailable request writes only the capture and an observation.
- No cross-business access.
- A restore drill passes on the new schema.
- Everything runs in CI on both backends.
- Interpretation is scripted first.

## 9. One-week plan: foundations first
- **Days 1–2:** the party, event and money schema. The operation boundary with availability, permission and validity separated. Acceptance tests first, red. Two synthetic businesses in the harness.
- **Day 3:** invoice, payment, allocation and the outstanding derivation, with provenance.
- **Day 4:** the held approval, the envelope, and the thin shell: orb, ask, answer, drill, return.
- **Day 5:** CI on both backends, a staging rehearsal and a restore drill on the new schema.
- **Days 6–7:** hardening, review, and a real-model interpretation run, only with your approval.
- **Later, not this week:** the other 14 domains, discovery evaluation, billing live, and retiring the legacy code.
- **Risk:** this is aggressive, and the schema and operation boundary are where it would slip.

## 10. Blocking decisions
1. **Topology:** confirm the clean engine module inside this repository, with its own Durable Object class. The alternative is a new repository.
2. **Interpretation for the slice:** scripted first with one approved real-model run, or real-model from the start. The second needs a spend ceiling.
3. **Money and tax scope for the slice:** single currency with a per-business VAT rate, or more.

## Recommendation, evidence and next task
**Recommendation:** rebuild the engine core on the retained platform substrate, in this repository.

**Evidence:** the model weaknesses in section 1, the closed catalogue and the missing availability and discovery, set against a substrate that is verified on real Cloudflare.

**Next bounded task (needs your approval):** on a new branch, write the slice's acceptance tests first (red), a schema sketch for parties, events, money and allocations, and the operation boundary stub. No engine behaviour yet.
