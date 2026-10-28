> **Status:** proposed. **Verified:** not yet. **Owns:** none.

# The Office — Future Capabilities Register & Strategic Roadmap

Document type: Strategic capability register
Purpose: Preserve future ideas, architectural decisions, and long-term opportunities without allowing them to contaminate the active development backlog.
Project: The Office
Last consolidated: 27 October 2026
Status: Strategic working document — implementation statuses require verification against the repository, "HANDOVER.md", and relevant source files.

---

## 1. Purpose and Governing Principles

The Office is intended to become an AI-native business operating system: a system through which businesses can access information, understand their operations, make decisions, and execute authorised actions using natural language and multiple interfaces.

The long-term vision extends beyond a conventional ERP, mobile application, or chatbot. The Office could become a reusable business-execution layer accessible through AI assistants, messaging platforms, mobile operating systems, and direct integrations.

However, the long-term vision must not become the immediate development backlog.

### 1.1 Governing principles

1. Preserve ideas without automatically implementing them.
2. Keep the active shipping plan separate from the future capability register.
3. Prefer measured evidence over speculative engineering.
4. Maintain strict business-data isolation.
5. Require explicit authorisation for consequential business actions.
6. Use reusable capabilities rather than building a separate system for every interface.
7. Keep the architecture model-neutral wherever practical.
8. Make complexity disappear from the business owner's experience.
9. Expand only when a real customer requirement, operational bottleneck, or commercial opportunity justifies it.
10. Treat implementation status as a verifiable fact, not an assumption.

### 1.2 Capability status definitions

| Status | Meaning |
|---|---|
| "built" | Implemented and supported by verifiable repository or deployment evidence. |
| "partial" | Some functionality exists, but the complete capability is not delivered. |
| "designed" | An architecture, specification, or implementation plan exists. |
| "discussed" | The idea has been explored but is not necessarily designed or implemented. |
| "emergent" | A logical future opportunity identified from the architecture or other capabilities. |
| "parked" | Deliberately deferred until a defined trigger occurs. |

Important: The register records strategic possibilities, not verified implementation. Every capability's current status must be checked against the codebase, documentation, deployment and handover records before being represented as built.

### 1.3 Activation rule

A future capability should enter active development only when at least one of the following occurs:

- A real customer requirement justifies it.
- Measured system behaviour identifies a bottleneck.
- A security, reliability, recovery or compliance requirement demands it.
- A commercial experiment validates demand.
- An existing capability cannot safely or economically support the required workload.
- A documented dependency makes the capability necessary for the next shipping phase.

Until then, it remains in the register.

---

## 2. Current Architectural Foundation

The future roadmap depends on preserving the core architectural decisions already established for The Office.

### 2.1 Business isolation and Durable Objects

The current architectural direction is:

- Each business receives its own long-lived Durable Object instance.
- That business's operational data is stored in its own Durable Object SQLite database.
- D1 provides shared directory, subscription-plan and limit information rather than serving as the operational database for every tenant.
- Related operational entities remain together where their transactions require consistency.
- Additional Durable Objects or storage systems should be introduced only when justified by measured requirements.

This model provides a foundation for tenant isolation and business-specific transactional operations.

The implementation and deployed behaviour should be verified against the current repository before treating every element as production-confirmed.

### 2.2 Durable Object classes versus instances

A crucial distinction is that a Durable Object class is not the same thing as a Durable Object instance.

- Class: Defines the code and behaviour.
- Instance: Represents an individual Durable Object with its own identity and state.
- Business mapping: Associates a business with the correct instance.
- Fleet management: Coordinates provisioning, routing, monitoring, recovery and lifecycle operations across many instances.

A shared class can serve many individual business instances. The architecture does not require a separate class for every customer.

However, creating more instances does not increase the storage capacity of an existing instance. Data partitioning and archival must be deliberately designed.

### 2.3 Storage responsibilities

The strategic storage model is:

| Component | Intended responsibility |
|---|---|
| Durable Object SQLite | Authoritative transactional business data and closely related operational records. |
| D1 | Shared directory, subscription plans, limits and cross-business metadata where appropriate. |
| R2 | Documents, files, exports, backups and archived payloads where suitable. |
| KV | Caching and suitable eventually consistent lookups; not authoritative financial state. |
| External systems | Customer-authorised integrations and specialist services. |

Storage decisions must account for transactional consistency, recovery, access controls, retention, cost and performance.

### 2.4 MCP and AI access

The Office is being developed toward a reusable MCP interface so supported AI assistants can interact with business data through controlled tools.

The existing direction includes:

- Business-data access through the MCP connector (21 tools: 14 read, 7 write; read-only keys remain an option).
- Model-neutral business tools.
- Authentication and authorisation.
- Business-specific access boundaries.
- A potential path toward carefully controlled write operations.

Read access does not automatically imply permission to modify business records. Write operations require their own authorisation, confirmation, audit and recovery controls.

### 2.5 Voice-first user experience

The intended user experience is not a conventional chat application with a large text box.

The design direction includes:

- A persistent central orb.
- Voice as a primary interaction method.
- Minimal visible interface clutter.
- Transient spoken or displayed responses.
- A hidden or secondary activity log.
- Specialist operations represented through visual states.
- Reports presented as focused views or rooms.
- Clear approval steps for consequential actions.

The governing product philosophy is:

Make The Office disappear into the way a business already works.

---

## 3. Future Capabilities Register

The following sections consolidate the known future capability areas.

The identifiers are intended to provide stable references for discussions, documentation and future planning. They do not imply that the capabilities are implemented.

### M — Marketing and Customer Acquisition

Strategic objective: Allow The Office to help businesses attract customers, manage leads and understand which activities generate revenue.

| ID | Capability | Description | Suggested trigger |
|---|---|---|---|
| M01 | Marketing platform APIs | Connect to supported platforms such as Facebook, Instagram, TikTok, X and LinkedIn. | Validated customer demand for specific integrations. |
| M02 | Unified marketing engine | Coordinate marketing activity from a common business context. | Multiple supported marketing workflows exist. |
| M03 | AI content generation | Generate business-specific posts, advertisements and promotional material. | Customers repeatedly request content creation. |
| M04 | Social publishing | Publish or schedule content through authorised integrations. | Content generation proves useful and publishing permissions are available. |
| M05 | Paid advertising management | Assist with advertising campaigns and budgets, subject to explicit spending controls. | A validated use case and safe advertising integration exist. |
| M06 | Lead capture | Capture enquiries from websites, forms, messaging and other supported sources. | A business needs a unified lead pipeline. |
| M07 | Attribution and performance | Connect campaigns and leads to measurable commercial outcomes. | Sufficient source and conversion data are available. |
| M08 | Marketing-service affiliates | Enable approved partners to provide marketing services to businesses in the network. | The Office Network has sufficient participation and trust controls. |

Important constraints

- Platform APIs differ in permissions, availability and supported operations.
- Publishing and advertising actions must be explicitly authorised.
- Advertising budgets need enforceable limits and approval controls.
- Attribution must distinguish measured results from estimates.
- Platform integrations should be added individually when they solve a real problem.

---

### N — Office Network and Business Ecosystem

Strategic objective: Develop The Office from an individual business operating system into a trusted network through which businesses can discover one another, exchange services and conduct authorised transactions.

| ID | Capability | Description | Suggested trigger |
|---|---|---|---|
| N01 | Business profiles and discoverability | Allow participating businesses to publish suitable business information. | A validated cross-business discovery use case exists. |
| N02 | Business verification | Establish appropriate verification levels for participating businesses. | Trust becomes necessary for network transactions. |
| N03 | Referral network | Enable businesses to refer customers to other businesses. | There is demonstrated value in cross-business referrals. |
| N04 | Affiliate programmes | Support structured referral and commission arrangements. | Commercial partners need measurable referral tracking. |
| N05 | Cross-affiliate network | Connect approved affiliate programmes across participating businesses. | Multiple compatible programmes exist. |
| N06 | Supplier and service discovery | Help businesses discover relevant suppliers and service providers. | Businesses need a reliable supplier-discovery workflow. |
| N07 | Trust signals | Present meaningful, evidence-based indicators of business reliability. | There is enough verified activity to support useful signals. |
| N08 | Moderation | Manage abuse, fraudulent listings and inappropriate conduct. | The network becomes large enough to require formal governance. |
| N09 | Dispute resolution | Provide a structured process for transaction disputes. | The network supports transactions with meaningful counterparty risk. |
| N10 | B2B purchasing | Allow businesses to discover and purchase goods or services through supported workflows. | Demand and commercial infrastructure justify it. |
| N11 | Escrow-style protection | Explore transaction protection through appropriately regulated partners or providers. | Legal, regulatory and operational requirements have been established. |
| N12 | Cross-business payments | Support authorised payments between participating businesses through suitable providers. | Payment-provider, compliance and reconciliation requirements are satisfied. |

Strategic significance

The network could eventually create value beyond the software subscription itself.

A business could use The Office to manage its own operations and then discover suppliers, customers, contractors and services through the same environment.

However, a network introduces substantial trust, fraud, governance, support and regulatory obligations. It should be treated as a later-stage opportunity, not an early shipping requirement.

---

### W — WhatsApp and Conversational Business Interface

Strategic objective: Allow businesses to interact with The Office through WhatsApp as a practical business interface rather than merely receiving notifications.

| ID | Capability | Description | Suggested trigger |
|---|---|---|---|
| W01 | Official WhatsApp Business Platform | Integrate through supported official WhatsApp business infrastructure. | A production WhatsApp interface is prioritised. |
| W02 | Customer-owned WhatsApp accounts | Allow businesses to connect and control their own accounts where supported. | The onboarding and permissions model is validated. |
| W03 | WhatsApp Office interface | Support conversational access to approved business functions. | The official integration and authorisation model are ready. |
| W04 | Voice-note workflows | Accept voice notes and convert them into supported business actions or queries. | Transcription quality and response latency are adequate. |
| W05 | Conversational business queries | Answer authorised questions about business records and operations. | Read access, identity and business context are reliable. |
| W06 | Workflow routing | Route messages to appropriate business capabilities. | Multiple workflows require consistent routing. |
| W07 | Notifications | Deliver useful alerts and updates through approved channels. | Notification preferences and delivery controls are established. |
| W08 | Signed quote and statement links | Provide secure links to relevant business documents or views. | Customer-facing document access is required. |
| W09 | Enquiry handling | Capture and route incoming customer enquiries. | A validated lead or service workflow exists. |
| W10 | Embedded Signup | Explore supported onboarding flows for connecting business WhatsApp accounts. | The applicable Meta onboarding requirements are satisfied. |
| W11 | Infrastructure choices | Evaluate webhook, message-processing, hosting and reliability options. | Measured workload or reliability needs require a decision. |
| W12 | Meta-assisted configuration | Explore supported partner or platform-assisted configuration and onboarding. | A viable partnership or supported onboarding path exists. |

Security and operational requirements

- Use official, supported production integrations wherever practical.
- Keep account ownership and permissions clear.
- Authenticate users before exposing private business information.
- Restrict messages to the business and capabilities the user is authorised to access.
- Require confirmation for consequential actions.
- Protect signed links against unauthorised access and inappropriate reuse.
- Apply message-volume controls and delivery monitoring.
- Make the interface useful even when an AI provider is unavailable.

WhatsApp is potentially important because it is already familiar to many businesses. However, its role should be based on a reliable official integration, not an assumption that any messaging automation technique will remain operational.

---

### A — AI Ecosystem and Model Interoperability

Strategic objective: Make The Office's business capabilities accessible through multiple AI providers without binding the product to a single model or assistant.

| ID | Capability | Description | Suggested trigger |
|---|---|---|---|
| A01 | Multi-model support | Support multiple AI models through suitable interfaces. | A measurable reliability, capability or cost benefit exists. |
| A02 | MCP gateway | Provide a controlled, reusable interface to business capabilities. | Continue validating and improving the existing MCP direction. |
| A03 | ChatGPT integration | Enable supported AI-assisted access through compatible interfaces. | The required connector and platform capabilities are available. |
| A04 | Claude integration | Enable supported AI-assisted access through compatible interfaces. | The supported interface and authorisation model are ready. |
| A05 | Grok integration | Explore compatible access through supported tools or connectors. | The platform supports the necessary integration. |
| A06 | Kimi integration | Explore compatible access through supported interfaces. | The relevant Kimi product supports the required capability. |
| A07 | AI discoverability | Help AI systems recognise The Office when relevant and permitted. | Discoverability can be improved without misleading claims or invasive distribution. |
| A08 | Natural-language ERP | Allow users to query and work with business records through natural language. | Data quality, access control and response accuracy meet requirements. |
| A09 | Composable queries | Combine multiple business-data operations into useful answers. | Individual tools are reliable and their combined semantics are clear. |
| A10 | External authorisation | Apply explicit permission boundaries to AI-initiated access and actions. | Each new interface is introduced. |
| A11 | Reusable business tools | Expose business capabilities in a consistent form across interfaces. | Additional integrations demonstrate the value of shared tools. |
| A12 | Cross-model capability consistency | Keep permissions and business logic consistent regardless of which model is used. | Multiple production integrations need equivalent behaviour. |

Architectural rule

Models interpret and request; The Office owns business rules, permissions and execution.

The Office should not depend on an AI model to enforce its security boundaries.

Every request must be validated by the underlying system, regardless of the model or interface that initiated it.

Provider compatibility

An MCP implementation does not automatically work in every AI application.

Compatibility depends on the provider, product, subscription, client interface, connector support and applicable permissions.

The integration layer should therefore be modular, with documented support for each verified interface.

---

### P — Proactive Intelligence and Business Execution

Strategic objective: Move from answering questions to identifying relevant business events and preparing useful next steps.

| ID | Capability | Description | Suggested trigger |
|---|---|---|---|
| P01 | Proactive business intelligence | Identify meaningful operational changes and opportunities. | Reliable data and actionable signals are available. |
| P02 | 7/30/90-day horizons | Support short-, medium- and longer-term business views. | Forecasting or planning needs are validated. |
| P03 | Late-payment follow-ups | Identify overdue accounts and prepare appropriate follow-up actions. | Receivables data and follow-up rules are reliable. |
| P04 | Quote follow-ups | Identify outstanding quotes that may need attention. | Quote lifecycle data and customer-contact rules are available. |
| P05 | Renewals | Track upcoming renewals and prepare appropriate reminders. | Relevant contract or subscription records exist. |
| P06 | Goals | Track business-defined targets and progress. | Customers need measurable operational objectives. |
| P07 | Calendar integration | Connect business activity with supported calendar systems. | Scheduling needs justify an integration. |
| P08 | Drafted communications | Prepare messages, emails or other communications for approval. | Business data can support accurate drafts. |
| P09 | Deep links | Open the specific record or view relevant to an alert. | Mobile workflows need fast navigation to context. |
| P10 | Incoming query handlers | Process and route requests arriving through supported channels. | Multiple entry points need consistent handling. |
| P11 | Specialist agents | Delegate bounded tasks to specialised capabilities. | Task complexity and measured performance justify delegation. |
| P12 | Approval-controlled execution | Execute consequential actions only within explicit authorisation and approval rules. | Any write-capable or external-action workflow is introduced. |

Operating principle

The Office should distinguish between:

1. Observation: Something happened or a condition exists.
2. Interpretation: The system explains why it may matter.
3. Recommendation: A proposed next step is presented.
4. Preparation: The system drafts the action.
5. Authorisation: The appropriate person approves it when required.
6. Execution: The action is performed through a validated tool.
7. Verification: The system confirms the result.
8. Audit: The operation is recorded appropriately.

This is more reliable than allowing a model to move directly from a natural-language interpretation to an irreversible business action.

---

### I — External Systems and Enterprise Integrations

Strategic objective: Make The Office a controlled integration layer between a business and its existing systems.

| ID | Capability | Description | Suggested trigger |
|---|---|---|---|
| I01 | API gateway | Provide a consistent, governed path to supported external services. | Multiple integrations require shared controls. |
| I02 | SAP and heavy ERP integration | Connect to larger enterprise systems where commercially justified. | A real enterprise customer and defined integration scope exist. |
| I03 | Customer-authorised connectors | Connect external accounts using explicit customer consent and permissions. | A specific integration delivers measurable value. |
| I04 | Modular feature packs | Enable additional capabilities without forcing every business to use them. | Customer segments require different functionality. |
| I05 | Email integration | Retrieve or send permitted business communications. | Email is needed for a validated workflow. |
| I06 | Calendar integration | Read or create permitted calendar entries. | Scheduling is part of a validated workflow. |
| I07 | Marketing integrations | Connect supported marketing platforms and campaign data. | The marketing capabilities are prioritised. |

Integration principles

- Use the narrowest practical permissions.
- Separate reading from writing.
- Keep credentials protected.
- Support revocation of access.
- Validate external data before using it in consequential operations.
- Handle expired tokens, API failures, rate limits and partial operations.
- Preserve a clear audit trail for important actions.
- Avoid building an integration simply because an API exists.

---

### S — Infrastructure, Storage, Scaling and Durable Object Fleet Management

Strategic objective: Operate a large number of isolated business instances reliably and economically without creating unnecessary architectural complexity.

This section includes the additional Durable Object class-management idea.

| ID | Capability | Description | Suggested trigger |
|---|---|---|---|
| S01 | Capacity monitoring | Measure database size, request load, latency, errors and relevant resource limits. | Establish a baseline and define actionable thresholds. |
| S02 | Durable Object fleet management | Manage many business-specific Durable Object instances through shared classes and automated operational controls. | Provisioning, monitoring or lifecycle management becomes operationally complex. |
| S03 | Storage thresholds | Define warning and action thresholds for business database growth. | Actual data growth establishes suitable thresholds. |
| S04 | Archive Durable Objects | Explore separate archive objects or other storage structures for historical data. | Measurements show that archival or partitioning is necessary. |
| S05 | R2 archival | Move suitable documents, files and historical payloads into object storage. | Storage analysis identifies appropriate candidates. |
| S06 | D1 metadata indexes | Maintain suitable shared metadata or lookup indexes where useful. | Query patterns demonstrate a need. |
| S07 | KV caching | Cache appropriate non-authoritative lookups to improve efficiency. | Measurements show a meaningful performance or cost benefit. |
| S08 | Archive audit | Record, reconcile and verify archival and restoration operations. | Archival or migration functionality is introduced. |
| S09 | Expansion triggers | Define evidence-based triggers for partitioning, migration or architectural expansion. | Baseline metrics and capacity models are available. |
| S10 | Recovery tests | Test backups, restoration, data integrity and operational recovery. | Establish recovery confidence before scaling critical workloads. |
| S11 | Enterprise capacity | Define and validate capacity requirements for larger businesses. | A real enterprise workload requires a different capacity profile. |
| S12 | Tenant isolation | Test and continuously protect business-data boundaries. | Ongoing requirement; strengthen testing as the system expands. |
| S13 | Durable Object fleet provisioning and lifecycle automation | Automate instance creation, tenant-to-instance mapping, configuration, health monitoring, recovery and lifecycle operations. | Manual operations become error-prone or measured scale justifies automation. |

#### S02/S13: Durable Object fleet management in detail

The Office should not require someone to manually configure every business instance.

The intended direction is to maintain reusable Durable Object classes while automatically managing the many instances created from them.

A future fleet-management capability could include:

A. Provisioning

- Create or initialise the appropriate business instance.
- Associate the business with a stable instance identifier.
- Apply the correct initial schema and configuration.
- Verify successful initialisation before declaring onboarding complete.

B. Tenant-to-instance mapping

- Maintain a reliable business-directory mapping.
- Ensure requests are routed to the correct business.
- Prevent accidental cross-tenant routing.
- Define safe behaviour when mappings are missing or inconsistent.

C. Health and capacity monitoring

- Track database size and growth.
- Monitor latency, error rates and operational failures.
- Identify instances approaching defined thresholds.
- Surface actionable warnings rather than generating noise.

D. Lifecycle management

- Support controlled initialisation and upgrades.
- Track schema and migration versions.
- Support safe recovery and operational intervention.
- Document decommissioning, retention and data-export requirements.

E. Expansion and partitioning

- Determine when a particular business needs a different data layout.
- Separate suitable historical or archival data when justified.
- Preserve transactional consistency for active business operations.
- Avoid assuming that simply creating another Durable Object increases the capacity of an existing database.

F. Operational verification

- Test provisioning and recovery procedures.
- Reconcile business-directory records against actual instances where feasible.
- Verify data integrity after migrations.
- Record the results of important lifecycle operations.

Important architectural distinction

Fleet management is not the same as automatic horizontal scaling of an individual business database.

Creating more Durable Object instances distributes work across instances. It does not automatically split one business's SQLite database across them.

If one business approaches a storage or workload limit, The Office needs a deliberate strategy: optimise, archive suitable data, partition specific workloads or migrate to a different storage arrangement.

That decision must be driven by measurements and transactional requirements.

Suggested expansion sequence

1. Establish baseline monitoring.
2. Test business provisioning and tenant mapping.
3. Add automated warnings and operational diagnostics.
4. Test backups and recovery.
5. Define and test archive or partition procedures.
6. Automate lifecycle operations where manual work becomes risky.
7. Introduce more sophisticated fleet orchestration only when operational evidence warrants it.

The goal is not to build a large orchestration system prematurely. It is to ensure that the number of businesses can grow without requiring a corresponding increase in manual administration.

---

### D — Device Access and Native Platform Integration

Strategic objective: Make The Office accessible through the devices people already use, rather than requiring users to open a dedicated application for every interaction.

| ID | Capability | Description | Suggested trigger |
|---|---|---|---|
| D01 | Siri and App Intents | Expose suitable actions through Apple's supported system integration mechanisms. | The native application and action model are ready. |
| D02 | Samsung/Galaxy integration | Explore appropriate Android and Samsung-supported integration points. | A validated use case and supported APIs exist. |
| D03 | Shortcuts | Provide convenient, user-configured entry points to supported operations. | Repeated actions benefit from shortcuts. |
| D04 | Action Button | Explore supported ways to launch appropriate actions on compatible devices. | The platform permits a useful, authorised workflow. |
| D05 | Lock-screen widgets | Surface selected information or entry points through supported widgets. | Users need convenient access to specific functions. |
| D06 | Native voice activation | Explore supported voice-triggered workflows within operating-system restrictions. | A safe and technically supported activation path exists. |
| D07 | Device-maker partnerships | Explore deeper integration with device manufacturers. | The product has demonstrated adoption and strategic value. |
| D08 | Telecom distribution | Explore distribution through telecom operators or related partners. | The commercial proposition and operational maturity justify it. |

Platform reality

Native integration is not equivalent to unrestricted operating-system access.

Apple, Samsung and Android impose different restrictions on background execution, voice activation, permissions and default-assistant behaviour.

The Office should first use supported application-level integration mechanisms. Deeper system-level distribution or OEM integration is a later strategic opportunity, not an assumed capability.

---

### C — Commercial Model, Distribution and Unit Economics

Strategic objective: Build a sustainable commercial model that aligns customer value, AI usage, infrastructure costs and distribution.

| ID | Capability | Description | Suggested trigger |
|---|---|---|---|
| C01 | Pricing benchmark | Compare the proposed offer with relevant alternatives and customer expectations. | Before a major pricing decision. |
| C02 | R599 subscription hypothesis | Evaluate R599 per month as a possible price point, not an established market price. | Customer research and paid pilots provide evidence. |
| C03 | AI allowances | Define what AI usage is included in each plan. | Actual usage and provider costs are measurable. |
| C04 | Usage overage | Explore transparent additional charges for usage beyond included allowances. | There is a real need and customers understand the model. |
| C05 | Enterprise pricing | Develop a model for larger or more complex customers. | Enterprise requirements and willingness to pay are validated. |
| C06 | Unit economics | Track revenue, infrastructure costs, AI costs, support and other material costs per business. | Establish before broad commercial scaling. |
| C07 | Customer referrals | Reward appropriate customer referrals. | Retention and customer satisfaction support a referral programme. |
| C08 | Partner distribution | Explore distribution through relevant service providers and commercial partners. | A credible partner channel is identified. |
| C09 | AI-platform distribution | Explore customer acquisition and access through supported AI ecosystems. | Platform compatibility and distribution opportunities are verified. |
| C10 | Strategic partnerships | Explore partnerships that materially improve distribution, capability or market access. | The product demonstrates sufficient traction and strategic value. |

Commercial principle

The objective is not simply to maximise subscription revenue. It is to establish a business model in which:

- Customers receive measurable value.
- AI and infrastructure costs remain sustainable.
- Usage limits are understandable.
- The service remains reliable as usage increases.
- The business can grow without an uncontrolled support burden.

A proposed price should be treated as a hypothesis until validated by real customer behaviour.

---

### V — Long-Horizon Strategic Outcomes

These are outcomes that may emerge from the combined capabilities above. They are not individual implementation tasks.

| ID | Strategic outcome | Meaning |
|---|---|---|
| V01 | Universal business-execution layer | Businesses access authorised operational capabilities through multiple interfaces. |
| V02 | Office Network | Participating businesses discover and interact with one another through a trusted ecosystem. |
| V03 | Business growth infrastructure | The Office helps businesses manage operations, attract customers and identify opportunities. |
| V04 | Proactive business operating system | The Office identifies relevant events and prepares or executes authorised next steps. |
| V05 | Extensible platform | New models, tools, integrations and feature packs can be added without redesigning the entire product. |
| V06 | Ecosystem partnerships | Distribution and integration partners extend the product's reach. |

These outcomes should remain directional. Their inclusion does not mean they are all necessary for commercial success.

---

## 4. Additional Capability Gaps to Evaluate

The following ideas were identified as potential gaps in the register. They require prioritisation and validation rather than automatic implementation.

| Proposed area | Potential capability | Why it may matter |
|---|---|---|
| Banking | Bank feeds and statement import | Improve visibility into cash flow, payments and reconciliation. |
| South African tax | SARS-related records, exports and tax preparation packs | Reduce administrative effort and improve access to organised records. |
| Multi-branch operations | Multiple branches, yards or operating locations | Support businesses with more than one operational site. |
| Field operations | Installer or field-worker application mode | Give mobile staff access to relevant work and capture workflows. |
| Customer portal | Controlled access to quotes, statements and documents | Reduce repetitive customer communication. |
| Afrikaans voice | Afrikaans speech recognition and interaction | Improve accessibility for relevant users. |
| Offline operation | Offline capture and later synchronisation | Support unreliable connectivity and field work. |
| Compliance documents | Insurance certificates and related business records | Keep important documents organised and accessible. |

Each candidate should be assessed against customer demand, technical feasibility, operational risk, ongoing maintenance and commercial value.

Tax, banking and compliance capabilities require particular attention to data accuracy, security and applicable South African legal or regulatory requirements.

---

## 5. Cross-Cutting Requirements

Some requirements apply across nearly every future capability.

### 5.1 Security and authorisation

- Authenticate the user and identify the relevant business.
- Enforce permissions on the server side.
- Separate read permissions from write permissions.
- Require additional confirmation where appropriate.
- Limit the scope and impact of consequential operations.
- Provide a means to revoke access.
- Keep sensitive credentials protected.
- Maintain suitable audit records.
- Prevent an AI model from bypassing business rules.

### 5.2 Data integrity and recovery

- Treat financial and operational records as authoritative data.
- Use transactions where related updates must succeed or fail together.
- Make migrations repeatable and verifiable.
- Design archival operations to be idempotent.
- Verify destination data before deleting or retiring source data.
- Test restoration rather than merely assuming backups work.
- Maintain a clear recovery procedure for important failures.

### 5.3 Reliability

- Measure latency and error rates.
- Define sensible operational thresholds.
- Monitor critical dependencies.
- Handle provider outages and rate limits.
- Avoid making external service availability a prerequisite for unrelated core operations.
- Verify the outcome of consequential operations.

### 5.4 Cost control

- Measure cost per active business.
- Track AI usage and external service consumption.
- Distinguish fixed costs from usage-dependent costs.
- Establish alerts before meaningful limits are reached.
- Validate pricing against actual cost and customer value.
- Avoid adding infrastructure merely because future scale is imaginable.

### 5.5 User experience

- Preserve the voice-first, low-friction product direction.
- Keep the interface focused on the user's task.
- Make the source and meaning of important information understandable.
- Show what will happen before requesting approval.
- Make successful execution and failure states clear.
- Provide an accessible path to supporting records and audit information.

---

## 6. Recommended Development Horizons

These horizons are a strategic sequencing proposal, not a claim about the current active backlog.

### Horizon 1 — Protect the foundation

Objective: Ensure that the existing system is trustworthy before expanding its surface area.

Priorities to evaluate:

1. Verify business isolation and authentication.
2. Run recovery and restoration tests.
3. Establish reliable baseline monitoring.
4. Measure cost and usage per business.
5. Validate data quality and important business calculations.
6. Test the current MCP workflow (read and create; see `PHONE_TEST_SCRIPT.md`).
7. Confirm that the handover and repository accurately describe deployed behaviour.

Exit condition: The core product can demonstrate reliable access controls, accurate results and a credible recovery process.

### Horizon 2 — Complete safe business access

Objective: Make existing AI access dependable and clearly bounded.

Priorities to evaluate:

1. Improve existing MCP tools.
2. Confirm consistent business-level authorisation.
3. Validate supported AI-client integrations.
4. Improve error handling and diagnostics.
5. Document supported queries and their limitations.
6. Test the user experience from question to verified answer.

Exit condition: Supported clients can access the intended business information without crossing business boundaries or overstating what the system knows.

### Horizon 3 — Introduce controlled write operations

Objective: Move from reading business information toward safely performing selected actions.

Required safeguards include:

- Explicit authorisation.
- A narrow set of permitted operations.
- Confirmation before consequential actions.
- Appropriate transaction boundaries.
- Audit records.
- Idempotency where needed.
- Undo, void or compensating actions where appropriate.
- Limits on financial or operational impact.
- A way to disable write-capable integrations quickly.
- Tests for unauthorised requests, retries and partial failures.

Exit condition: Selected actions can be executed and verified with an acceptable risk profile.

### Horizon 4 — Establish operational scale

Objective: Ensure that onboarding and operating additional businesses do not create disproportionate manual work.

Potential priorities:

1. Measure actual database and workload growth.
2. Establish storage and performance thresholds.
3. Automate business-instance provisioning when justified.
4. Test tenant-to-instance mapping and recovery.
5. Build verified archival procedures if needed.
6. Introduce fleet-management automation where operational complexity warrants it.
7. Model cost at realistic customer counts.

Exit condition: The architecture has demonstrated capacity and operational procedures appropriate to the next validated growth stage.

### Horizon 5 — Add customer-facing channels

Objective: Make the core capabilities available through convenient interfaces.

Potential priorities:

- Official WhatsApp Business Platform integration.
- Conversational queries.
- Voice-note workflows.
- Notifications.
- Secure document links.
- Customer enquiry handling.
- Supported native mobile entry points.

Exit condition: A channel provides measurable customer value without weakening security, reliability or supportability.

### Horizon 6 — Develop proactive intelligence

Objective: Help businesses identify important events and take timely action.

Potential priorities:

- Overdue receivables.
- Outstanding quote follow-ups.
- Cash-flow indicators.
- Renewal reminders.
- Business-defined goals.
- Prepared communications.
- Approval-controlled execution.

Exit condition: Proactive suggestions are accurate, relevant and useful enough to justify their operational complexity.

### Horizon 7 — Expand the ecosystem

Objective: Explore broader distribution and network effects after the core product has demonstrated commercial value.

Potential opportunities:

- Business referrals.
- Supplier discovery.
- Cross-business services.
- Marketing integrations.
- Enterprise integrations.
- AI-platform distribution.
- Device-maker and telecom partnerships.

Exit condition: A specific opportunity has a validated commercial case, an owner, a risk assessment and a clear implementation scope.

---

## 7. Decision Gates for Future Capabilities

Before moving a capability into active development, record the following.

| Question | Purpose |
|---|---|
| What problem does this solve? | Prevents technology-driven development without a clear outcome. |
| Who needs it? | Identifies the customer or operational beneficiary. |
| What evidence supports demand? | Distinguishes validated requirements from speculation. |
| What is the current workaround? | Establishes the value of improvement. |
| What dependencies exist? | Identifies prerequisites. |
| What are the security implications? | Establishes the required controls. |
| What could fail? | Identifies operational and data-integrity risks. |
| What will it cost to build and operate? | Prevents hidden maintenance and usage costs. |
| How will success be measured? | Makes the decision testable. |
| What is the activation trigger? | Defines when the capability should move forward. |
| What should not be built yet? | Explicitly controls scope. |

A capability should not be promoted merely because it sounds strategically important.

---

## 8. Documentation and Status Discipline

The register should live separately from the active development plan.

Suggested documentation relationship

- "FUTURE_CAPABILITIES.md" — the long-term capability register.
- "HANDOVER.md" — current state, verified implementation status, active priorities and immediate next steps.
- "DECISIONS.md" — architectural decisions and the reasoning behind them.
- "EXPERIENCE_BRIEF.md" — intended product experience and user interaction principles.
- Active task list or backlog — only work that has been deliberately approved for implementation.

These names are proposed documentation responsibilities. Their current contents and locations must be verified in the repository.

Update rules

When a capability changes:

1. Update its status only when there is evidence.
2. Record the relevant implementation or decision reference.
3. Keep the original strategic intent intact.
4. Add dependencies where they become known.
5. Define an activation trigger if one does not exist.
6. Update the active handover only if the work affects the current build or immediate priorities.
7. Do not copy every future idea into the shipping backlog.

---

## 9. Strategic Summary

The Office has several potentially reinforcing directions:

1. A trusted business-data and execution core.
2. A reusable interface for multiple AI systems.
3. A voice-first experience that reduces friction.
4. Messaging and native-device access.
5. Proactive business intelligence and controlled execution.
6. An operational architecture capable of supporting many isolated businesses.
7. A potential network connecting businesses, suppliers and service providers.
8. A commercial model that aligns customer value with sustainable operating costs.

The Durable Object fleet-management concept belongs in the infrastructure strategy because it addresses the operational work required to manage many isolated business instances. It should evolve from monitoring and tested provisioning toward more sophisticated automation as real usage warrants it.

The broader network, marketing, enterprise and device-partnership ideas remain valuable strategic options, but they do not need to be built to prove the core product.

Final governing rule

The register preserves the destination. The handover describes reality. The active backlog defines the next move.

Keep those three separate.

The objective is not to build every capability in this document. It is to preserve the strategic possibilities while making disciplined progress toward a reliable, useful and commercially sustainable Office.
