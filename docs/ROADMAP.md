> **Status:** principle. **Verified:** not yet. **Owns:** none.

# The Office: strategic roadmap

Direction, **not a schedule and not permission to implement anything.** There are no dates. Each stage says what useful business capability it should unlock. The register of individual future capabilities is [FUTURE_CAPABILITIES.md](../FUTURE_CAPABILITIES.md); the vision is [PRODUCT_VISION.md](PRODUCT_VISION.md); the live task list and approvals are in [HANDOFF.md](../HANDOFF.md). Stages overlap and are not strictly sequential. "State" is taken from the linked documents as of 2026-11-03 and was **not re-verified in writing this file**; the live state is the code, the tests and `ops/` records.

## 1. Foundation: a business's data is its own, correct, recoverable and provable
**Unlocks:** the confidence to put real records into the system.
- Business isolation and identity; authentication and permissions; reliable records and relationships; integrity verification; recovery and restore; evidence and provenance; governed operations.
- **State:** per-business objects, authentication and role permissions are established on `main`. The engine (events, facts, documents, payments, reversals, an integrity verifier, tenant-isolation and ownership tests, manifest-validated restore) is on branch `engine-phase1`: tested, and partly proven on real **staging** objects, **not deployed**. Release gates remain open (see HANDOFF.md).
- **Sources:** [engine-foundation.md](decisions/engine-foundation.md), [ROUTE_POLICY.md](../ROUTE_POLICY.md), [SHIP_CHECKLIST.md](../SHIP_CHECKLIST.md).
- **Open decisions:** the ownership-boundary policy; the deployment verification gate; recovery-gate acceptance.

## 2. Investigation: any answer can be traced to its records
**Unlocks:** "show me why" for every figure.
- Record discovery and retrieval; relationship traversal; evidence-bearing results; progressive investigation context; drill-down from a summary to source records.
- **State:** the engine returns versioned record views by reference and one collection (receivables). Search, product model and a general result envelope are **proposed, not approved or built**.
- **Sources:** [investigation-foundation.md](decisions/investigation-foundation.md) (proposed), [ENVELOPE.md](../ENVELOPE.md).

## 3. Business intelligence: governed, explainable numbers
**Unlocks:** reports the owner can trust and defend.
- Governed measures and calculations; financial and operational reporting; consistent definitions and periods; reconciliation and exception investigation.
- **State:** legacy reports as data and an analysis layer exist ([VISION.md](../VISION.md) lists them as built). Governed measures on the engine are **not started**.
- **Sources:** [CONVERSATIONAL_BI_ARCHITECTURE.md](../CONVERSATIONAL_BI_ARCHITECTURE.md), [reports-and-finance.md](decisions/reports-and-finance.md).

## 4. Conversational operations: ask, clarify, confirm, act, undo
**Unlocks:** running the business by saying what is needed, safely.
- Intent interpretation; clarification of ambiguity; authority-aware execution; confirmation and approval; traceable outcomes; undo, reversal and correction.
- **State:** a conversational layer and a confirm, reject and edit-field action boundary exist for legacy businesses. The engine has reversal and correction records, and **no conversation path** yet.
- **Sources:** [CONVERSATIONAL_LAYER.md](../CONVERSATIONAL_LAYER.md), [LOOKUP_ROUTING_ARCHITECTURE.md](../LOOKUP_ROUTING_ARCHITECTURE.md).

## 5. Business operating models: the Office fits the business
**Unlocks:** each business operates its own way on one platform.
- Conversational onboarding; business-specific roles and authority; team onboarding; progressive workflow discovery; owner-approved policy and workflow configuration.
- **State:** an onboarding journey exists in part. Workflow discovery and owner-approved policy configuration are **not built**; "observed becomes policy" is explicitly **not** allowed without approval.
- **Sources:** [ONBOARDING_JOURNEY.md](../ONBOARDING_JOURNEY.md), [identity-and-people.md](decisions/identity-and-people.md).

## 6. Broader platform: reach and growth
**Unlocks:** the product around the core.
- External integrations; additional capabilities; automation; storage growth and partitioning **where measured need justifies it**; commercial provisioning, plans and customer lifecycle.
- **State:** a read-only MCP adapter exists. Everything else is in the register.
- **Sources:** [FUTURE_CAPABILITIES.md](../FUTURE_CAPABILITIES.md), [MCP_ARCHITECTURE.md](../MCP_ARCHITECTURE.md), [accounts-and-billing.md](decisions/accounts-and-billing.md).

## The next capability milestone (not started)
**An authorised business user asks a meaningful business question, The Office investigates authoritative records, returns an evidence-bearing answer, and lets the user trace that answer to its source records.** It builds on stages 1 and 2 and is developed on `engine-phase1` against a fake API where appropriate. It is not authorised to begin until [HANDOFF.md](../HANDOFF.md) says so.

## Unresolved decisions that shape this roadmap
The ownership-boundary policy and whether a name mismatch on a bound object refuses or only reports; the authenticated post-deployment gate; recovery-gate acceptance and memory margin at size; whether the investigation foundation is approved; how the engine gets a conversation path; the preview route for the app, which today is published from `main` only. Owner-only decisions: [OPEN_QUESTIONS.md](../OPEN_QUESTIONS.md).
