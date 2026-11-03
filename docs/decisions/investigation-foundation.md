> **Status:** proposed. **Verified:** not yet. **Owns:** none.

# DECISIONS: investigation-foundation

Recorded 2026-11-02 on branch `engine-phase1` (head `d4e4685` when written). Drafted from the BI readiness investigation (a read-only trace of the code and tests, no tests run, nothing changed) and revised after an independent architectural review; accepted by Pierre for recording as DOCUMENTATION ONLY. It authorises NO build. It does not approve merging or deploying Phase 1, it does not reopen Phase 1, and it does not touch the recovery gate, which stays OPEN. Every guarantee not backed by evidence is marked INTENDED or OPEN, never stated as fact.

## Investigation foundation: the principle, and what is decided now, deferred and not invented (2026-11-02)

**The principle.** Users can navigate from a business record into an investigation, move across related records, and trace an analytical answer back to its evidence, without the interface becoming the source of business truth. It is the shared foundation for the orb, drill-down and business intelligence.

**Decided now:** three shell-facing contracts (a record reference, an evidence-bearing result, a request context) and the rules every consumer shares. **Deferred:** the product concept, every analytical measure and its definition, search and aggregation, an engine conversation path and interpreter, an engine MCP tool, export and share, and any graph store (not needed on current evidence). **Not invented:** any accounting policy, and any product, stock or supplier relationship.

**What the investigation found (evidence).** The engine has stable business-scoped references, versions, permission-aware kind-level views, explicit receivables relationships and atomic writes. It has NO product record (an engine document line carries `description` and `unit` only), no collection, search or aggregation capability beyond `receivables.query`, no analytical measure, no structured link from a result to its sources (`derivedBy` is a free-text label, `records.ts:117`), no engine conversation path (`/messages/text` is refused in an engine business, `boundary.ts:30`), and no permission for cost, margin or suppliers (they sit in `UNMAPPED`, `permissions.ts:14`). No capability sets `captureId` (`facts.ts:15,58`) and no engine code writes `eng_interpretation`. The legacy system holds the only product data (`line_items.product_id` is nullable and filled only when the model supplied a product name, `finance.ts:181`; a supplier is a `characters` row; `getLastPricePaid`, `finance.ts:2207`, matches free text and returns one row) and contains the right precedents: `Evidence` with `reconciled` and `truncated` and `Finding{certainty, basis}` (`analysis.ts:14-32`), and an untrusted context hint (`context.ts`, pinned by `context.test.js:84`). Nothing found says the engine must be rebuilt: the gaps are additions.

## D1 and D2: the record reference, and the evidence-bearing result (2026-11-02)

### D1. A record reference, and what counts as a record
A reference is `{kind, id}`, scoped to the session's business; it never carries a business id. **The kind vocabulary is open**: the shell renders any kind generically (title, fields, relations, actions) and navigates by following `relations[].ref` and `sources[].ref`; it does not hard-code today's four kinds (`RECORD_KINDS`, `records.ts:26`). **Classification rule:** a concept is not a record kind merely because it has a name or appears on screen. It is a record when it is an independently STORED business object with its own identity, lifecycle and version; otherwise it is a RESULT produced from other information. An invoice is a record. A freshly generated statement is a result. A statement formally issued and stored later could be a record, and the contract allows that without the shell changing. A record a member may not see answers exactly as one that does not exist (true today at the kind level: `engine-operations.test.js:101`).

### D2. One envelope, four recognisable result types
A common outer envelope; each type keeps its identity and semantics, and the types are NOT interchangeable. **Record:** stable reference, record version, fields, relations, permitted actions, history. **Collection:** member references, and a statement of whether the returned set is the COMPLETE result of the declared query or only a page. **Calculation:** the measure or definition (id and version), parameters, the result, supporting evidence, caveats. **Explanation:** statements, each classed, with the support for each. Common to all: contract version, type, subject, permitted actions, caveats.

### D2a. What "version" means (four things, never conflated)
(1) the CONTRACT version: the shape of the envelope; (2) the RECORD version of one stored record; (3) EVIDENCE versions: the version of each source record used; (4) AS-OF: when the data was read, with a `consistency` field whose value is `not-established` until a snapshot guarantee exists. **INTENDED, not yet true:** today the engine has record versions only (`versionOf`, `records.ts:32`); it has no evidence versions, no as-of and no consistent-snapshot guarantee, and whether a multi-query read can tear is UNKNOWN. This record promises no global stale detection; it defines the fields and leaves the guarantee open.

### D2b. What "complete" means
Display truncation and calculation completeness are separate. Four cases must never look the same: (1) all eligible records used; (2) calculated from only a page; (3) incomplete because of the data (for example lines with no product identifier), reported as a coded caveat; (4) completeness cannot be established. A truncated list of source references (not all can be shown) does NOT mean the calculation is incomplete; both facts are reported independently. Reconciliation fits the type: a financial total reconciles to its sources (`analysis.ts` does this); an explanation demonstrates that each claim is supported; a record has nothing to reconcile. **Permission and leakage (OPEN prerequisite):** a result must not reveal records the member cannot see, neither their contents nor their existence through counts, totals or caveats. Whether such a result is refused or carries a generic "some records are not available to you" is an unresolved POLICY question, not decided here, and a prerequisite for any capability where it matters.

### D2c. A classification is not proof
The statement classes are business fact, calculation, inference and unverified hypothesis. A class describes the KIND of claim and does not prove it: a calculation can be reproducible and still rest on incomplete data; a fact records what was entered, not that the real-world event happened. A result therefore carries material QUALIFICATIONS: what supports it and what it does not establish. A confident calculation over poor data must not read as a confident conclusion.

## D3 and D4: investigation context is explicit, client-held, untrusted and never a business record (2026-11-02)

### D3. Request context
The shell sends `{subject?, selection[], parameters{period, compare, filters}, screen{room, ref?}}`. The current SCREEN and the investigation SUBJECT are separate (a user can look at an invoice while investigating a product). **Client-held does not mean client-trusted:** the server validates every reference, filter, period, selection and requested operation, and resolves references through permission-checked reads on every request; supplying a reference never grants access. **Subject changes:** each constraint declares which kinds of subject it applies to, so a customer filter cannot silently carry into a supplier investigation; the client keeps what is relevant and the server never merges old context in. **Bounded and versioned:** the existing limits stay (at most 5 selections and 10 filters, `context.ts`) and the context carries a version so it can evolve. **Ambiguity** is returned as candidates, never guessed (the pattern in `followup.ts` and `reconcileProduct`, `identity.ts:246`). Server-held investigation sessions are deferred until a demonstrated need. Conversation history is never a context source.

### D4. An investigation selection is never a business record
A selection, a temporary filter or "these invoices" is investigation state. It is request-scoped and is never persisted as business data. It never creates a business entity, never establishes a relationship and never alters a record, however the user navigates. It is evidence only when it names STORED records.

## D5: rules every consumer shares, and what is intended versus verified (2026-11-02)

### The rules
(1) Permission is checked at every hop and at every source. (2) A refusal reveals no withheld figure. (3) The shell computes nothing; it only formats. (4) Every new record kind, relationship or measure is an additive migration with a stated backup, restore, rollback and recovery-gate implication; it declares its permissions, returns a D2 result, passes the stop rule and an isolation test, and records any definition it relies on instead of assuming one.

### Intended interface versus verified implementation
| Element | Status |
|---|---|
| Open record-kind vocabulary | INTENDED. Four kinds are hard-coded today (`records.ts:26`). |
| Record view: reference, version, relations, actions | Exists and tested for document and party views. Movement and draft views exist but NO test opens them through `records.get`. |
| Common envelope, collection and calculation types | NOT FOUND. Only record views and one receivables result exist. |
| Evidence versions, as-of, consistency | NOT FOUND. Multi-query read consistency UNKNOWN. |
| Structured source references and definitions | NOT FOUND. `derivedBy` is a free-text label. |
| Provenance from capture to outcome | PARTIAL: `captureId` is never set; no engine code writes `eng_interpretation` (`engine-fit.test.js:113` writes it by hand). |
| Client-held context | EXISTS in legacy, narrow and tested (`context.test.js:84`); not used by the engine. |
| Permission at every hop | Kind-level only. Cost, margin and supplier permissions are unmapped. |
| Engine cross-business isolation | TESTED LOCALLY (Task 3) through the real front door and two real business objects on a stand-in for Durable Object storage; NOT shown on a real Durable Object; one ownership-initialization finding (an unused object bound to the first business that named it) is FIXED on the branch where the runtime exposes the object's name, NOT verified on a real object. See `engine-foundation.md`. |
| Recovery and restore gate | STILL OPEN: the restore fix is proven on the harness only; `staging-two` is in engine mode. |

## Investigation foundation: open questions and what is deliberately deferred (2026-11-02)

**Phase 2 on the receivables slice** can proceed against a FAKE API that follows D1 to D4; the shell must work with the orb absent, render a record, follow a permitted relationship, display a result with its evidence, and handle ambiguity and refusal without assuming every answer is a chat message. Nothing about products blocks it. No build is authorised by this record.

**Open, deliberately left open:** how a consistent multi-query read is guaranteed; whether a result over partly hidden data is refused or flagged; how a stored statement document, if ever issued, would be versioned; the engine isolation test and real-object tests for movement and draft views; the recovery gate.

**Deferred, with their business definitions undecided and NOT invented:** what a product is versus a stock item or a service; what counts as "sold" (invoiced, delivered or paid); what landed cost includes and how it is apportioned; the cost method and the cost basis for a margin; how credits, returns and voids count; the product, stock and supplier model; search, collections and aggregation; an engine conversation path; export and share. Known traps the future measures must handle (from the investigation, [I] unless noted): lines with a null `product_id` are silently excluded; a voided invoice keeps its lines (`mcp-undo.ts:59,61`), so a naive sum counts it; the only legacy sale date is the recording time `created_at`; quantities are REAL with a free `unit`; product merges (`merged_into_product_id`) must be followed; `stock_items` and `products` are separate identities, so "used" differs from "sold".
