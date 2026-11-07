> **Status:** proposed. **Verified:** not yet. **Owns:** none.

> Recovered on 2026-11-07 from the assistant's own saved transcript of the 2026-11-02 session (engine phase 1 and investigation), because it had never been committed. Written against repository commit `f469510`. Verbatim, except that one closing sentence about a session token was removed. It is a PROPOSAL: Pierre accepted rebuilding the engine core on a retained platform substrate as the leading direction, subject to clarifications, and the amended proposal followed.
> It amends the Architecture decision report after Pierre's review; where they differ, this one wins. Section 3 holds the twelve minimum invariants that the slice's acceptance criterion 7 cites.

# Amended implementation proposal

Nothing is built or changed. I read the Flutter app, the Worker wiring, the route policy and the capability model to ground this. The facts below are labelled **[C]** source or **[D]** documentation. Everything else is a proposal.

## 1. Refined architecture and schema sketch

Each business keeps its own isolated Durable Object, and the engine lives inside it. Everything is per business, money is integer minor units, and recorded facts are never updated.

```
-- S1 = built in the first slice. captures and pending_actions are existing infrastructure tables, reused.
eng_party(id, kind person|organisation, name, merged_into → eng_party)                       S1
eng_party_role(party_id → eng_party, role, since)                                            S1 (customer)
eng_document(id, kind, direction sell|buy, party_id → eng_party, currency, reference,
             issued_on, terms_json, event_id → eng_event)                                    S1 (kind = invoice)
eng_document_line(id, document_id → eng_document, line_no, description,
             quantity_milli, unit, unit_price_minor, tax_bp)                                 S1
eng_money_movement(id, direction in|out, party_id → eng_party, amount_minor > 0,
             currency, occurred_on, method, event_id → eng_event)                            S1
eng_allocation(id, movement_id → eng_money_movement, document_id → eng_document,
             amount_minor > 0, event_id → eng_event)                                         S1
eng_event(id, type, occurred_at, actor_email, capture_id → captures,
             proposal_id → pending_actions, approved_by, contract, contract_version, payload_json)   S1, append-only
eng_interpretation(id, capture_id → captures, interpreter script|model, capability,
             payload_json, status proposed|refused|unsupported, reason)                      S1
eng_observation(id, capture_id → captures, kind unsupported|unavailable|ambiguous, note, status)       S1
eng_config(key, value_json)   -- currency, time zone, default tax rate, which capabilities are available   S1
```

- **Derivations:** the outstanding amount of a document is its lines plus tax, minus its allocations. The outstanding amount of a party sums over its documents. One function does each, and every read path uses it.
- **Enforced by the database:** foreign keys, positive amounts, and triggers that abort any update or delete on documents, lines, movements, allocations and events. Over-allocation is also blocked by a trigger.
- **Capabilities in S1:**
  - `receivables.query` is a read. It needs `can_know_debtors`.
  - `payment.record` is held for approval. It needs `can_manage_invoices`. Allocation is oldest-first, written as explicit allocation rows. Today it is inferred at read time.
  - `invoice.issue` seeds the data through the same boundary, by script. It isn't conversational.
- **Permissions reused [C]:** these are existing capability names, held by owner, accountant and admin, and not by installer or sales. Payments are guarded by `can_manage_invoices` (`auth.ts:581`), and receivables knowledge by `can_know_debtors`.

## 2. Cross-domain fit

The test is whether S1's tables ever need to change. They never carry a reserved column for a later domain. Later domains add new tables that point at S1 tables, or add rows and kinds as data.

| Relationship | How it fits | New beyond S1 |
|---|---|---|
| Customer → quotation → sales order → invoice → payment allocation | Quotation, sales order and invoice are `eng_document` kinds, with lineage and partial invoicing through links. A payment is a money movement with allocations. A credit note is a kind with its own allocation. Retention and deposits sit in `terms_json`, and a deposit is an allocated movement. | `eng_document_link` (new table), new kinds as data |
| Supplier → PO → goods received → supplier invoice → payment allocation | The same tables with `direction = buy`. Goods received links to PO lines, and the three-way match is a comparison of linked quantities and amounts. A payment out is a money movement. | Links, kinds, a supplier role |
| Job → planned and actual materials and labour → profitability | A job is a work item. Planned and actual lines, time entries and quantity movements are new tables. Costs are attributed from document lines to the job. Profitability is revenue attributed minus costs attributed. | `eng_work_item`, plan lines, quantity movements, time entries, `eng_attribution` |
| Worker → assignment → visit → completion evidence | A visit is a child work item. An assignment names a worker party and a window. Completion is a work event, and evidence links to a document or capture. Capacity is a projection. | Assignment, work event, evidence link |
| Capture → interpreted facts → proposal → authorisation → outcome | This is S1 itself: capture, interpretation, a held proposal, approval, then an outcome event carrying all four references. | Nothing |

**Decisions that would otherwise constrain later domains**
- **Status derives, it is never stored.** A stored status becomes a second truth. Materialise it later only with a reconcile test.
- **Document kinds are data,** validated by the contract, not a `CHECK` enum. No invoice-only columns on the document table.
- **Kind-specific terms** (retention, deposit) live in a validated JSON column. Core columns stay kind-neutral.
- **No negative amounts.** Corrections are reversal events or credit documents. This avoids the negative-line hacks.
- **References are foreign-keyed,** with polymorphism only as two nullable foreign keys under a `CHECK`.
- **Currency per document and movement,** with one currency per business enforced at first. Foreign exchange comes later.
- **Quantities are integers in thousandths.**
- **Time:** UTC instants, with the business time zone in config.
- **Contracts are versioned,** and the version is recorded on events so history stays interpretable.

## 3. Minimum invariants, and what stays out

**Enforced in the first implementation**
1. Money and quantities are integers. No floats.
2. Recorded facts are append-only.
3. Foreign keys are enforced.
4. Allocations are conserved: per movement and per document, never over-allocated.
5. Each position has one derivation.
6. Every record carries provenance: capture, proposal and approval references. The only exception is system-generated records, which carry a reason.
7. Execution happens only from an approved proposal, and approval is rechecked at execution.
8. Execution and its outcome event are one atomic transaction, with an idempotency key.
9. Tenant isolation: nothing crosses businesses.
10. Availability, permission and validity are each checked server-side, and the interface can't change the result.
11. Responses are built from recorded outcomes only. A refusal reveals no withheld data.
12. An unsupported or unavailable request writes a capture and an observation, and nothing else.

**Outside this scope** (rules, not foundations): the tax rules beyond a per-line rate, rounding policy beyond one documented default, pricing, stock valuation, retention release, credit-note semantics, foreign exchange, approval hierarchies, capacity, payroll.

## 4. Coexistence and source of truth

- **Who owns writes:** the engine, exclusively, for engine-mode businesses, which use only the `eng_` tables. Legacy businesses use only the legacy tables. The mode is a per-business setting, and no business switches during the slice.
- **What is reused:** the same Worker and Durable Object [C]. Sessions, memberships, `ROUTE_RULES`, the held-action lifecycle (the contract hook from `claim/proof-1`), the 16 existing capability names, and backup and restore, which lists every table and so covers the new ones.
- **What is added:** the contract's own permission, availability and payload checks, plus a front-door switch at `/messages/text` (`index.ts:4007`).
- **Two truths prevented by:**
  - An import-boundary test: engine code may not import the legacy domain modules.
  - A search test that fails if a legacy file names an `eng_` table.
  - A guard that makes engine-mode businesses refuse legacy domain write routes, with a test enumerating every write route.
  - An additive migration that leaves legacy tables untouched.
- **Evidence to expand to other capabilities:**
  - The slice passes in CI, a staging rehearsal and a restore drill on the engine tables.
  - You accept the experience on your phone, and one approved model-backed interpretation run.
  - **The key test:** the procurement chain is built on the same foundations without changing any S1 table. If it needs a foundation change, we stop and decide.
  - A parity decision for each legacy capability: port, replace or drop.

## 5. The visible slice with Flutter

**Smallest viable path** [C: facts about the current app]
- Reuse: `reply_envelope.dart`, `runtime/office_state.dart` (the orb's states), `access_guard.dart`, `workspace_context.dart` and the refusal view. The envelope already carries provenance (`from`), refusals, held actions, candidates, a `room` for drill-down, and a confirmation flag.
- **Extract by copy:** the `FilamentOrb`, about 145 lines and self-contained, and sign-in with session handling, about 100 lines tied to the main state class. `main.dart` stays untouched until the slice passes.
- Build a new entry, `engine_main.dart`, of roughly 900 to 1,200 lines. It holds the persistent orb above the navigator, a conversation list, an answer card, a drill sheet, an approval card and a trace sheet.
- Deliver through the web preview on your phone's browser. That is quicker than an APK. It needs one workflow addition: a build target for the new entry. Today's preview builds only `main.dart` (`deploy-web-preview.yml:59`).
- Typed input first. Voice comes later.

**Complete acceptance criteria**
- **Interface**
  1. Opening the app shows the orb in its idle state, and it stays visible during drill-down.
  2. A typed question returns an answer from recorded outcomes, with provenance shown.
  3. Drilling opens the invoice list, then one invoice with its lines, allocations and trace. Returning keeps the conversation and its context.
  4. "Record R500 from Mokoena" produces an approval card. Approving updates the figures, and the trace shows capture, interpretation, proposal, approval and event.
  5. A restricted member (installer or sales) gets a refusal with no figures.
  6. A business where the capability is unavailable gets an honest answer, and only a capture and an observation are written.
- **Foundations**
  7. All twelve invariants in section 3 hold under test.
  8. Two engine businesses cannot see each other's data.
  9. Availability, permission and validity fail independently.
- **Process**
  10. Everything runs in CI on both backends.
  11. A staging rehearsal and a restore drill pass on the engine tables.
  12. Flutter widget tests cover flows 1 to 6 against a fake API.
  13. Interpretation is scripted in CI. One model-backed run is recorded, with your approval.

## 6. First week, realistic

- **Day 0:** the blocking decisions below.
- **Day 1:** a branch. Tests first, red: the invariants, the operation boundary, the import and write-route guards.
- **Day 2:** the migration, the money, allocation and derivation, and the three contracts. Green on both backends.
- **Day 3:** the front-door switch, the read routes (`/engine/receivables`, `/engine/documents/:id`) classified in the route policy, the scripted interpreter, observations, and the envelope mapping.
- **Day 4:** the Flutter extraction and `engine_main.dart`, with widget tests, and the preview build target.
- **Day 5:** a staging rehearsal, a restore drill and the isolation check, then fixes.
- **Day 6:** the model-backed interpreter, only if approved. Your phone review.
- **Day 7:** hardening and a review package. No merge.
- **Where it slips:** the Flutter shell and preview target (day 4), and the schema and operation boundary (days 1 to 2). If the model step isn't approved, the slice still ships with scripted phrases.

## 7. Blocking decisions

1. **The schema-change gate.** Adding `eng_` tables is an additive migration. The drill-count part of the recovery gate is met, with 4 passing drills. The rollback rehearsal and your acceptance are not. I recommend accepting it, and folding the rollback rehearsal into the slice's staging step. The fallback is a separate Durable Object class, which would duplicate sessions and memberships.
2. **Stacking on the proof.** The engine branch builds on `claim/proof-1`'s commits, and the two merge together at slice acceptance. The alternative is merging the proof first, which deploys.
3. **The model step.** Approve a small spend for one recorded run, or defer it.

Defaults I'll apply unless you object: ZAR in minor units, one currency per business, a default VAT rate in config, and half-up rounding per line.
