> **Status:** principle. **Verified:** not yet. **Owns:** none.

# The Office: product vision

This states what The Office is meant to become and why it is built the way it is. It is **intent, not a specification**: nothing here is a technical requirement until a decision in [DECISIONS.md](../DECISIONS.md) or `docs/decisions/` makes it one. The facts about what exists live in the documents it links; they are not repeated here.

**Reading the status of any statement in the project:** *established implementation* (code plus tests, and where stated, real-platform evidence), *approved decision* (recorded in the decision documents), *proposed design* (written down, not approved), *inference* (reasoned, not observed), *unknown*. A vision sentence is none of these until a decision says so.

## What The Office is meant to become

A **conversational business operating system.** An authorised person says what they want to accomplish, in ordinary language. The Office should:

1. understand the underlying intent;
2. understand the business and its operating context;
3. establish what information and authority the request needs;
4. investigate authoritative business records;
5. apply governed business rules and calculations;
6. execute what the person is authorised to do;
7. produce a useful outcome;
8. retain evidence and traceability of what happened.

The person should not need to understand modules, database structure, navigation or implementation to run their business. Conversation is the primary interaction layer, but the interface should present the most appropriate form of output: a report, a graph, a document, a form, an approval control, a record. Not everything belongs in a chat reply (the projection-layer design is in [VISION.md](../VISION.md) and [ENVELOPE.md](../ENVELOPE.md)).

**The conversational model interprets intent. The business engine governs calculations, permissions and execution.** Intent starts work; authority, business rules and evidence govern it.

## One reliable platform, many different businesses

Businesses differ in people and responsibilities, roles and authority, products and services, customers and suppliers, workflows and approvals, policies, and integrations. The intent is **one common, reliable platform with controlled business-specific operating models**, not thousands of code paths. The system should learn how a business works through actual work, notice recurring patterns, and *propose* improvements. **Observed behaviour must never silently become authorised policy**: an owner approves it.

## One shared business truth

Accounting, administration, operations, HR, sales and other capabilities must not become separate assistants holding conflicting versions of the business. A business event keeps its meaning everywhere:

- a purchase order is not proof of delivery;
- a delivery is not an invoice;
- an invoice is not proof of payment;
- a payment is not necessarily settlement.

The system preserves relationships, evidence, history and provenance, so each of these stays distinct and traceable.

## Investigation and intelligence

A user asks a question, gets an answer, and can investigate it step by step: customer statement, invoice, lines, products sold, quantities, customers, suppliers, purchase costs, margin. They can always move from a summary to the records and evidence beneath it. Calculations are **governed, reproducible and explainable**.

## Principles to preserve

- The business should not have to reorganise itself around the software.
- Structure serves the product vision, not the reverse.
- Reliability and trust matter more than impressive demonstrations.
- The platform delivers useful business capability progressively; architecture exists to make future capability safer and cheaper, not to become the project.
- Build for real business outcomes, not technical sophistication.
- The ambition may be large, but **every external claim is limited to capabilities that exist and have been verified.** No promise that The Office will change the world.

## Where this stands (pointers, not a status report)

| Vision element | Where its real state is recorded |
|---|---|
| Business isolation and identity | [FUTURE_CAPABILITIES.md](../FUTURE_CAPABILITIES.md) section 2; the isolation, identity and ownership sections of [engine-foundation.md](decisions/engine-foundation.md) |
| Authentication and permissions | [ROUTE_POLICY.md](../ROUTE_POLICY.md); [IDENTITY_ARCHITECTURE.md](../IDENTITY_ARCHITECTURE.md); [identity-and-people.md](decisions/identity-and-people.md) |
| Engine: facts, events, documents, payments, reversals | [engine-foundation.md](decisions/engine-foundation.md) |
| Record and event integrity | the integrity section of [engine-foundation.md](decisions/engine-foundation.md) |
| Investigation and evidence-bearing results | [investigation-foundation.md](decisions/investigation-foundation.md) (a **proposed** decision) |
| Recovery and restore | the recovery sections of [engine-foundation.md](decisions/engine-foundation.md); [RUNBOOK.md](../RUNBOOK.md); [SHIP_CHECKLIST.md](../SHIP_CHECKLIST.md) |
| Business storage strategy | [FUTURE_CAPABILITIES.md](../FUTURE_CAPABILITIES.md); [CORE_SUBSTRATE_ARCHITECTURE.md](../CORE_SUBSTRATE_ARCHITECTURE.md) |
| Conversational layer | [CONVERSATIONAL_LAYER.md](../CONVERSATIONAL_LAYER.md); [CONVERSATIONAL_BI_ARCHITECTURE.md](../CONVERSATIONAL_BI_ARCHITECTURE.md); [LOOKUP_ROUTING_ARCHITECTURE.md](../LOOKUP_ROUTING_ARCHITECTURE.md) |
| What is built, feature by feature | [FEATURE_STATUS_MATRIX.md](../FEATURE_STATUS_MATRIX.md); [INDEX.md](../INDEX.md) |

## What this vision deliberately does not decide

These remain **open**, and an assistant must not treat the vision as having settled them: the product, measure and definition model for governed calculations; how business-specific operating models are represented and approved; whether and how the engine gets a conversation path (today an engine business refuses the legacy text route); the ownership-boundary policy details (see the identity section of [engine-foundation.md](decisions/engine-foundation.md)); storage partitioning beyond what measured need justifies. Decisions only the owner can make are collected in [OPEN_QUESTIONS.md](../OPEN_QUESTIONS.md).
