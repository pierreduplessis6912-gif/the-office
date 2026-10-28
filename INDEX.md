> **Status:** real. **Verified:** 2026-10-24. **Owns:** `tools/analysis.test.js`, `tools/onboarding.test.js`, `tools/billing.test.js`, `tools/context.test.js`, `tools/experience.test.js`, `tools/followup.test.js`, `tools/converse.test.js`, `tools/converse-agent.test.js`, `tools/history.test.js`, `tools/mcp-keys-breakage.js`, `tools/route-policy-gen.js`, `tools/route-policy.test.js`, `worker/src/analysis.ts`, `worker/src/billing.ts`, `worker/src/context.ts`, `worker/src/experience.ts`, `worker/src/followup.ts`, `worker/src/history.ts`, `worker/src/identity.ts`, `worker/src/intents/lookup.ts`, `worker/src/mcp.ts`, `worker/src/onboarding.ts`.

# INDEX: feature to document, code and tests

Start at [HANDOVER.md](HANDOVER.md). Links here are checked by `tools/docs-check.js`. A date under "Verified" means the document's named paths, identifiers and its built-or-not claims were checked against the code on that day. "Not yet" means they were not, or only partly: the document's own audit note (at its top) says what was and was not checked.

| Feature | Document | Code | Tests |
|---|---|---|---|
| Reply envelope | [ENVELOPE.md](ENVELOPE.md) | [`worker/src/experience.ts`](worker/src/experience.ts) | [`tools/experience.test.js`](tools/experience.test.js) |
| Workspace context | [CONTEXT.md](CONTEXT.md) | [`worker/src/context.ts`](worker/src/context.ts) | [`tools/context.test.js`](tools/context.test.js) |
| Who can call what | [ROUTE_POLICY.md](ROUTE_POLICY.md) | [`tools/route-policy-gen.js`](tools/route-policy-gen.js) | [`tools/route-policy.test.js`](tools/route-policy.test.js) |
| Read-only MCP adapter | [MCP_ARCHITECTURE.md](MCP_ARCHITECTURE.md) | [`worker/src/mcp.ts`](worker/src/mcp.ts) | [`tools/mcp-keys-breakage.js`](tools/mcp-keys-breakage.js) |
| MCP testing record | [PHONE_TEST_SCRIPT.md](PHONE_TEST_SCRIPT.md) (the live checklist and its last results); the 2026-10-26 audit is archived: [docs/archive/MCP_TEST_SUMMARY.md](docs/archive/MCP_TEST_SUMMARY.md), [docs/archive/MCP_TEST_LOG.md](docs/archive/MCP_TEST_LOG.md) | none | none |
| MCP versus app baseline plan | [MCP_VS_APP_BASELINE.md](MCP_VS_APP_BASELINE.md) | none | none yet (plan only) |
| Analysis and reports | [CONVERSATIONAL_BI_ARCHITECTURE.md](CONVERSATIONAL_BI_ARCHITECTURE.md) | [`worker/src/analysis.ts`](worker/src/analysis.ts) | [`tools/analysis.test.js`](tools/analysis.test.js) |
| Spoken follow-ups | [CONVERSATIONAL_BI_ARCHITECTURE.md](CONVERSATIONAL_BI_ARCHITECTURE.md) | [`worker/src/followup.ts`](worker/src/followup.ts) | [`tools/followup.test.js`](tools/followup.test.js) |
| Conversational layer (Phase 1) | [CONVERSATIONAL_LAYER.md](CONVERSATIONAL_LAYER.md) | [`worker/src/converse.ts`](worker/src/converse.ts) | [`tools/converse.test.js`](tools/converse.test.js) |
| History and audit | [DECISIONS.md](DECISIONS.md) | [`worker/src/history.ts`](worker/src/history.ts) | [`tools/history.test.js`](tools/history.test.js) |
| Billing (PayFast sandbox) | [SHIP_CHECKLIST.md](SHIP_CHECKLIST.md) | [`worker/src/billing.ts`](worker/src/billing.ts) | [`tools/billing.test.js`](tools/billing.test.js) |
| Onboarding | [ONBOARDING_JOURNEY.md](ONBOARDING_JOURNEY.md) | [`worker/src/onboarding.ts`](worker/src/onboarding.ts) | [`tools/onboarding.test.js`](tools/onboarding.test.js) |
| Identity | [IDENTITY_ARCHITECTURE.md](IDENTITY_ARCHITECTURE.md) | [`worker/src/identity.ts`](worker/src/identity.ts) | no dedicated test file |
| Lookup routing | [LOOKUP_ROUTING_ARCHITECTURE.md](LOOKUP_ROUTING_ARCHITECTURE.md) | [`worker/src/intents/lookup.ts`](worker/src/intents/lookup.ts) | no dedicated test file |

## Every document, by status

**real:** [PHONE_TEST_SCRIPT.md](PHONE_TEST_SCRIPT.md), [ATLAS.md](ATLAS.md), [BACKEND_CAPABILITY_MAP.md](BACKEND_CAPABILITY_MAP.md), [CONTEXT.md](CONTEXT.md), [CORE_SUBSTRATE_ARCHITECTURE.md](CORE_SUBSTRATE_ARCHITECTURE.md), [DECISIONS.md](DECISIONS.md), [ENVELOPE.md](ENVELOPE.md), [FEATURES.md](FEATURES.md), [HANDOVER.md](HANDOVER.md), [OPEN_QUESTIONS.md](OPEN_QUESTIONS.md), [README.md](README.md), [ROOMS_BACKEND_SCOPE.md](ROOMS_BACKEND_SCOPE.md), [ROUTE_POLICY.md](ROUTE_POLICY.md), [RUNBOOK.md](RUNBOOK.md), [SECURITY_AND_OPERATIONAL_READINESS.md](SECURITY_AND_OPERATIONAL_READINESS.md), [SHIP_CHECKLIST.md](SHIP_CHECKLIST.md)

**partly built:** [CALENDAR_INTEGRATION_ARCHITECTURE.md](CALENDAR_INTEGRATION_ARCHITECTURE.md), [CONVERSATIONAL_LAYER.md](CONVERSATIONAL_LAYER.md), [CONVERSATIONAL_BI_ARCHITECTURE.md](CONVERSATIONAL_BI_ARCHITECTURE.md), [ERP_MODE_ARCHITECTURE.md](ERP_MODE_ARCHITECTURE.md), [FEATURE_STATUS_MATRIX.md](FEATURE_STATUS_MATRIX.md), [IDENTITY_ARCHITECTURE.md](IDENTITY_ARCHITECTURE.md), [LOOKUP_ROUTING_ARCHITECTURE.md](LOOKUP_ROUTING_ARCHITECTURE.md), [MCP_ARCHITECTURE.md](MCP_ARCHITECTURE.md), [OFFICE_RUNTIME_V1.md](OFFICE_RUNTIME_V1.md), [ONBOARDING_JOURNEY.md](ONBOARDING_JOURNEY.md), [UI_MAP.md](UI_MAP.md)

**proposed:** [ASK_AND_RESEARCH_ARCHITECTURE.md](ASK_AND_RESEARCH_ARCHITECTURE.md), [FUTURE_CAPABILITIES.md](FUTURE_CAPABILITIES.md), [JOB_CARDS_ARCHITECTURE.md](JOB_CARDS_ARCHITECTURE.md), [PROJECTION_VISION.md](PROJECTION_VISION.md), [RELATIONAL_IDENTITY_ARCHITECTURE.md](RELATIONAL_IDENTITY_ARCHITECTURE.md), [SELF_HELP_ARCHITECTURE.md](SELF_HELP_ARCHITECTURE.md), [WHATSAPP_CHANNEL_ARCHITECTURE.md](WHATSAPP_CHANNEL_ARCHITECTURE.md)

**principle:** [DESIGN_CONSTITUTION_V2.md](DESIGN_CONSTITUTION_V2.md), [EXPERIENCE_BRIEF.md](EXPERIENCE_BRIEF.md), [NATIVE_TRANSITION_BRIEF.md](NATIVE_TRANSITION_BRIEF.md), [OFFICE_CONSTITUTION.md](OFFICE_CONSTITUTION.md), [OFFICE_MOODBOARD.md](OFFICE_MOODBOARD.md), [VISION.md](VISION.md)

**archived:** [docs/archive/COORDINATION.md](docs/archive/COORDINATION.md), [docs/archive/MCP_TEST_LOG.md](docs/archive/MCP_TEST_LOG.md), [docs/archive/MCP_TEST_SUMMARY.md](docs/archive/MCP_TEST_SUMMARY.md), [docs/archive/PROCESS_ONE_EXTRACTION_REWRITE.md](docs/archive/PROCESS_ONE_EXTRACTION_REWRITE.md), [docs/archive/SECURITY_PROGRESS_LOG.md](docs/archive/SECURITY_PROGRESS_LOG.md), [docs/archive/BUILD_SEQUENCE.md](docs/archive/BUILD_SEQUENCE.md), [docs/archive/CAPABILITY_AUDIT.md](docs/archive/CAPABILITY_AUDIT.md), [docs/archive/STATUS.md](docs/archive/STATUS.md)

**unaudited:** none

Logs, never read whole, search by heading: [DECISIONS.md](DECISIONS.md) (split into `docs/decisions/`, one part per area) and [RUNBOOK.md](RUNBOOK.md) (split into `docs/runbook/`). Each is an index over part files; the index lists every heading with the part that holds it.
