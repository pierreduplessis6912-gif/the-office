> **Status:** proposed. **Verified:** not yet. **Owns:** none.

> Recovered on 2026-11-07 from the Claude Doc it was written in (revision 23, last edited 2026-11-02), because it had never been committed. Converted from the document's structure to markdown by a script; the text is unchanged. **The document's own status: every decision is proposed for owner approval; none is accepted and none authorises implementation.** Pierre has reported that the 71 rules are kept as *evidence only, not a checklist* and that the register sequence is stopped. Whether any decision was ever signed off is not recorded in this repository.

# The Office: constitutional audit decision record — revised draft for approval

Nov 1, 2026 · @Pierre

## Status, scope and evidence legend

This revised draft proposes eleven decisions (D1 to D11) as 71 numbered rules for owner approval, updated to apply the reviewer verdicts and corrections and the owner's proposals on lead conversion. None is accepted, and none authorises implementation. The reviews approve the direction of the record only.

- **Starting point:** the earlier draft record, held as a document. No PDF was attached to the first revision request, so that document was used. It is unchanged, for comparison.
- **Repository facts:** `main` at `42bcb74`; audit branch `claim/audit-1` at `ca3bd20`. Every finding was traced from source. None was run, deployed or observed on a live system.
- **This revision did not:** edit code, configuration, the constitutions or any other repository file; run tests or model calls; touch staging or production; change permissions or routes; pass any gate; or start any implementation.
- **New reading:** no broad investigation. The second revision read the conversation-layer contract (`CONVERSATIONAL_LAYER.md` and `converse.ts`) because one verdict depends on what it says about `other`. The lead-conversion check read the worker's SQL and functions on the `leads` table, their callers, and recorded test names, read-only.
- **Reviewer verdicts:** eight verdicts on the open questions and four later corrections are applied below. They approve the record's direction. They are not approval to implement, run tests, access staging or production, change permissions, or alter any constitutional principle.

| Label | Meaning |
| --- | --- |
| \[C\] | Existing source evidence from the audit |
| \[T\] | Test or fixture definition. None was executed. |
| \[I\] | Inference from source |
| \[U\] | Unknown: not established by the audit |
| Proposed | A product decision recommended for owner approval |
| Unresolved | A question the owner or further evidence must settle |
| Not authorised | Implementation work. Nothing in this record starts it. |

Each decision below separates four things: source evidence, the rules proposed for approval, the questions still unresolved, and any implementation that is not yet authorised.

## Constitutional basis

Twelve principles and rules were checked against the constitution text. Four statements in the revision request could not be found as stated, and one principle (identity) is still unsettled. The statements are treated as owner direction, not as numbered principles. **The relevance column is inference.** No operational rule in this record is a constitutional principle. A rule is attributed to a principle only where the principle's own text says so.

| Source | What the text says (verified) | Relevant to \[I\] |
| --- | --- | --- |
| Principle 1, Deterministic Before AI | "If the worker can answer, the AI must never guess." | D1, D5, D11 |
| Principle 2, AI Is a Translator | "Not a decision maker. Not business logic." Its footprint is extracting intent and narrating what the worker did. | D1, D7, D11 |
| Principle 8, Decide and Execute Are Separate Roles | Deciding and executing are distinct roles, never the same piece of code. | D2, D8 |
| Principle 12, Standard Shapes First, Custom Only When Forced | A strict default toward reuse; custom structure is the exception that needs justification. | Reuse of existing mechanisms, throughout |
| Principle 16, Immutable History, Mutable Pointers | The record of what happened is permanent; only pointers move. | D6 |
| Principle 17, One Chain, One Source of Truth Per Stage | Each stage owns its document, references the earlier stage by ID, and never recalculates what it settled. | D1, D2 |
| Principle 21, Generic Lifecycle, Specific Capability | "The lifecycle a piece of work moves through is the generic part. What happens at the execute step never has to be." | No universal executor, throughout |
| Principle 24, Share What's Known, Don't Guess What's Meant | When meaning is ambiguous, share the known facts rather than guess. | D5, D7 |
| Principle 26, Permission-Aware Answers | "The Office does not authorize questions. It authorizes knowledge." | D10, D11 |
| Principle 28, Truth Before Relationship Before Cognition | "Truth must arrive before truth can be related." | Ordering of work |
| Design Constitution, Rule 4 | Information Appears Only When Invited. | D2, D6 |
| Design Constitution, Rule 7 | The Office Is Never Loud. | D2 |

**Not found as stated, so not attributed to a principle**

- **"The Office begins as a shell; nothing gets built merely because it is possible."** Not in either constitution. Related text: `ERP_MODE_ARCHITECTURE.md` says the shell serves voice and "doesn't change shape as capability grows", and Design Rule 4 says "The screen begins empty." Treated as owner direction.
- **"New architecture must earn its existence through evidence."** Not a numbered principle. Related text: Principle 12 (custom only when forced), Principle 23 ("this earned its own Worker") and Principle 25 ("Every new piece of UI must earn its way onto this calm surface"). Treated as owner direction.
- **"Truth, structure and cognition, in that order."** The constitution's title for Principle 28 is "Truth Before Relationship Before Cognition". This draft uses the constitution's wording.
- **Identity.** The constitution's index describes research entry 008 as "grounded, but not yet settled into a numbered principle of its own". D4 therefore has no settled constitutional principle behind it. (The source marks the entry with a question-mark symbol, which is left out here.)
- **Permission to act.** Principle 26 governs knowledge. The action side rests on the existing capability model, which I did not verify as a numbered principle \[U\].

## D1 and D2: pricing integrity and approval visibility

The integrity guarantees can be adopted now. The numerical limits from the earlier draft cannot: they are business-policy proposals without an established basis, and they are no longer rules.

### D1. Measurement, rates and pricing

**Status: Proposed for owner approval.**

**Guarantee.** A value entering a financial document must satisfy the validity rules established for its field. Missing or uncertain information must not silently become a different charge.

**Source evidence \[C\].**

- The model chooses "mm" or "m" from the size of the numbers. Code reads exactly "m" as metres and anything else, including no unit, as millimetres (`scheduler.ts:303-312`).
- A model-supplied area is stored when a dimension is missing, and rates are unvalidated (`ai.ts:775-776`).
- A per-square-metre rate with no area becomes a flat line (`job-pricing.ts:525-541`). Negative lines can offset positive ones. The only guard is that the total must exceed zero (`job-pricing.ts:218, 412`).
- Confirmation stores the payload as given (`index.ts:3054-3090`, `finance.ts:229-244`).
- Whether any wrong quotation has been issued is unknown \[U\].

**Part A. Integrity rules proposed for adoption now (no numerical threshold).**

1. A missing measurement unit is clarified, never inferred from magnitude.
2. A per-square-metre charge without an established area is clarified. It never silently becomes a flat charge.
3. Structural validity: a value is present and a finite number of the right kind before it enters a document. A malformed or missing value is not silently converted.
4. Proposed operational rule set for semantic invalidity. It is field-specific. It is not a blanket zero or negative-number rule, and it is not an established constitutional principle.
   - A measurement dimension at or below zero is invalid.
   - A discount above 100%, under the proposed discount model (a stated percentage reducing a line's price), is invalid.
   - A negative ordinary rate is invalid unless the line is represented as an explicitly defined credit or adjustment.
   - Other zero or negative values are not made invalid by this rule. For example, an explicitly stated zero price is a legitimate value (D3).
5. Negative lines are preserved where the business operation genuinely permits them, such as an explicitly defined credit or adjustment. Their meaning is explicit and they are visible before approval (D2).
6. Quotation and invoice totals follow their declared document semantics. Today a total at or below zero creates no document (`job-pricing.ts:218, 412`). No credit-note document type is introduced or implied by this record.
7. A malformed or missing value is distinguished from an unusual but possibly legitimate one. The first is clarified. The second is never rewritten.
8. An explicit unusual value is never silently rewritten, clamped or dropped. Where an established owner policy identifies it as unverified, it is shown as unverified before approval (D2).
9. A negative discount is not given a business meaning from its sign alone, as a surcharge or otherwise. When its meaning is uncertain, the Office asks.

**Part B. Business-policy proposals (****deferred; un****validated; not rules).** The owner proposed these figures in conversation for the flooring business. The audit does not establish them as valid general limits, and they are not Office-wide rules. They stay deferred. If business evidence later supports one, it does not silently become an Office-wide rule: it needs its own decision, scoped to the business or trade the evidence supports. No policy-settings framework is built to accommodate these figures, and no replacement figures are proposed.

| Proposal | Proposed figure | Status |
| --- | --- | --- |
| Component area range | 2 m² to 200 m² | Deferred; unvalidated. A landing, a stair or a single window for blinds can fall under 2 m². |
| Per-square-metre rate ceiling | R3,000/m² | Deferred; unvalidated |
| Discount ceiling | 25%, with above held as unverified | Deferred; unvalidated. A negative discount is handled by D1 rule 9, not by this ceiling. |
| Flat or unit price, quantity, total warning | No ceiling proposed | Nothing to validate |

**How D1 and D2 fit together.**

| Situation | Handling | Where the approver sees it |
| --- | --- | --- |
| Missing unit | Clarify; nothing held | The reply says what is missing |
| Per-sqm rate, no established area | Clarify; nothing held | The reply says what is missing |
| Malformed value (not a finite number, wrong kind) | Not entered; clarify | The reply says what was not entered |
| Value judged semantically invalid by rule 4 | Not entered; clarify | The reply says why |
| Negative discount, meaning uncertain | Clarify; nothing held | The reply says what is unclear (rule 9) |
| Explicit unusual value flagged by an owner policy (none adopted: Part B is deferred) | Held; shown as unverified | Approval context (D2) |
| Negative line the operation permits | Held normally; marked negative | Approval context (D2) |
| Unverified item the approver has acknowledged | Stays unverified. The document still needs its normal confirmation. | Approval context and the record (D2 rule 6, D6) |
| Quotation or invoice total at or below zero | No document; the reply explains | The reply |

**Not authorised:** any validator, any change to the line builder, any change to confirmation.

### D2. Approval visibility

**Status: Proposed for owner approval.**

**Guarantee.** No financial action is confirmed through a surface that conceals its material financial consequences.

**Source evidence \[C\].**

- The pending queue shows the type and the original sentence only (`main.dart:3959-3989`).
- A quotation nested in a work observation shows no total in its reply (`reply.ts:164-176`; recorded fixture \[T\]).
- The outside-assistant summary shows the amount and a short description, not the lines (`mcp-pending.ts:27-42`).
- The reply envelope carries no amount or line fields (`reply_envelope.dart:33-68`).

**Rules proposed.**

1. Before confirming a quotation or invoice, the approver has access to: the customer and document type; the total and number of lines; each line's quantity, unit, rate and total, as applicable; the area calculation where relevant; clear marking of negative lines and unverified values.
2. The approver can tell an established value from an unresolved one.
3. The conversation stays quiet. Detail may be one tap away, provided the approval context itself shows the total and any material warning, and the full detail is genuinely accessible before confirmation. This is consistent with Design Rules 4 and 7 \[I\].
4. Confirming from the conversation view is allowed under rule 3.
5. Acknowledgement is at item level. An unverified document is presented with each unverified item and the reason it is unverified, and proceeding requires the approver to acknowledge those items individually. The default is that a human approver makes the acknowledgement. The number of taps and other interaction details are left open, provided any bulk acknowledgement identifies every covered item unambiguously.
6. Acknowledging that an item is unverified is not confirming it as an established business fact. An acknowledgement does not change the item's factual status and does not substitute for the confirmation or approval the document requires. The record keeps the unverified status and who acknowledged it (D6).
7. An outside assistant receives the same material information and remains subject to the applicable authorisation rules. It may present the unverified items and their reasons, but it does not acknowledge them on a human's behalf unless that authority is explicitly decided and permitted. Whether it ever may is unresolved.

**Boundary.** This decides what the Office guarantees, not how it renders it. No UI framework is prescribed.

**Unresolved.** Whether an outside assistant may ever be given authority to acknowledge unverified items on a human's behalf. Until that is explicitly decided and permitted, the default is that it may not. Today an outside assistant confirms held actions through the owner's key \[C\], so under this default it could not confirm a document that has unverified items. Rule 6 applies to whoever acknowledges.

## D3, D4 and D5: purchase orders, identity and stock

These three keep the earlier guarantees, with the exceptions and wording made precise. None invents a threshold.

### D3. Purchase orders

**Status: Proposed for owner approval.**

**Guarantee.** An ordered quantity or expected price is valid before it becomes a business expectation.

**Source evidence \[C\].** A purchase order is written directly, with no approval step (`finance.ts:268-296`). Its quantities and prices are saved as the model gave them. A non-positive ordered quantity drops out of the outstanding list (`finance.ts:522-551`). The delivery side validates its own numbers (`finance.ts:362-383`, `:1555-1559`).

**Rules proposed.**

1. A line with a missing, zero or negative quantity is clarified, and nothing is recorded for that line.
2. Partial acceptance is preserved: valid lines are recorded, and invalid or incomplete lines are left unresolved.
3. The reply states which lines were recorded, which were not, and what information is still outstanding. It never implies the whole order was recorded when only some lines were.
4. Price states stay distinct. An absent price is clarified and never silently shown as zero. An invalid price is clarified. A price the user explicitly states as zero (a free line) is recorded as a zero-price line and is not treated as missing.
5. No commercial plausibility limit on quantity or price is proposed, and none is invented here.
6. Delivery-side safeguards are unchanged.

**Not authorised:** any change to the order writer or the reply.

### D4. Identity resolution

**Status: Proposed for owner approval.** The constitution has no settled identity principle (research entry 008 is still unsettled), so this decision rests on the owner's direction and the source evidence.

**Guarantee.** A name supplied by interpretation does not, by itself, establish a person's identity or business relationship. Each route has a deliberate policy for finding an existing person, handling ambiguity and near-matches, creating a new person, and checking role compatibility.

**Source evidence \[C\].** Typed and spoken messages apply collision, ambiguity and near-match checks (`opening.ts:174-296`). Other routes do not: stock usage (`stock.ts:51`), installers (`job-pricing.ts:118, 315`) and captions (`upload-caption.ts:46-58`). The installer match ignores the relationship (`identity.ts:463-488`). The lead-conversion check (results under the unresolved decisions) enumerated every route that touches the `lead``s` table. No route converts a lead by lead id. A lead is linked to a customer only by name equality when a quotation is confirmed (`finance.ts:2338-2345`), and the sibling-lead path creates or matches a customer from the lead's name without the opening-step safeguards (`scheduler.ts:530-541`). Product creation is documented as intended (`types.ts:117-121`).

**Rules proposed.**

1. Stock usage naming an unknown job customer: clarify with the normal identity questions before creating anyone.
2. An installer's name matching someone in another role: ask which person it is.
3. Routes that can create a person ask "same person or new?" on a near-match. Imports follow their own explicit matching and deduplication rules.
4. An operation acting on something that must exist (resolving a snag) and naming an unknown customer creates the person only after asking.
5. An installer's name matching nobody: ask first.
6. A customer name matching someone in a different role: ask, on every route that can resolve a customer.
7. A caption naming someone who matches nobody: ask first.
8. A typed or spoken invoice, quote or payment naming a genuinely new customer, with no near-match, continues to create the customer, unless the evidence later gives a reason to change it.
9. Lead conversion links the specific lead by its id, not by name matching. This is proposed policy. Current source links by name, so it does not describe current behaviour.
10. When the lead cannot be identified confidently, because several leads share a name or none match, the Office asks which lead. It does not link every match, and it does not leave the lead silently unlinked.
11. The sibling-lead path asks before creating a customer from a lead's name. A route called lead conversion does not bypass the identity safeguards when it creates a new entity or meets an identity conflict.

**Boundaries.** Product creation stays under its existing documented policy and is outside this record. Not every route must share one implementation. No universal resolver or rewrite is proposed.

**Unresolved.** None at the policy level: the owner's answers are recorded as rules 9 to 11. How a quotation or any other route obtains the lead's id is an implementation question. It is not decided or authorised here.

**Not authorised:** any change to any identity route.

### D5. Stock quantities

**Status: Proposed for owner approval.**

**Guarantee.** Each stock operation has a defined quantity meaning. Stock integrity stays distinct from financial integrity, and this is not an inventory redesign.

**Source evidence \[C\].** Spoken usage and stocktakes write the model's quantity unvalidated (`finance.ts:1704, 1752`). A negative usage already raises stock today, unlabelled. Over-use is allowed with a warning (`stock.ts:100-105`). Delivery additions validate their numbers (`finance.ts:1555-1559`). No money path from stock quantity was found.

**Rules proposed.**

1. A negative usage is treated as a return only when the user's instruction establishes that a return is intended, and it is then marked as a return. If the meaning is uncertain, the Office asks. It does not infer the operation from the sign alone.
2. A zero or missing usage quantity records nothing, and the reply explains what was missing.
3. A negative stocktake count is rejected pending clarification.
4. Usage above the current balance is permitted, with a warning.
5. Unchanged: unit-mismatch clarification, and the stocktake overwrite.

**Not authorised:** any change to the stock writers.

## D6, D7 and D8: traceability, undeclared operations and forget\_last

D6 is reworded to mean real provenance. D7 no longer lets a catch-all create people. D8 gains explicit wording rules.

### D6. Traceability

**Status: Proposed for owner approval.**

**Guarantee.** Consequential operations can be reconstructed: what changed, when, who or what initiated it, what source led to it, and whether it was confirmed, reversed or corrected.

**Source evidence \[C\].** Held actions record who confirmed or rejected them (`action_events`, `history.ts:94`). Many direct writes record the original sentence but not who made them. Snags carry no capture link (`finance.ts:2241-2248`). A lead marked lost and a snag resolved record no actor (`finance.ts:2326-2328`). The hold insert records no creator (`finance.ts:3539-3543`).

**Rules proposed.**

1. A consequential record keeps the initiating actor or system.
2. Where the initiator and the person who authorised or confirmed the action differ, both are kept.
3. A record links to its originating capture or document where one exists. A record derived from another record, or from a system operation, records that source or lineage. A source link is never fabricated where none exists.
4. Deletions and status changes are logged with actor and time.
5. Corrections and edits are logged with the previous and new values.
6. The trail is available on request. It does not have to be permanently visible in the normal interface, which is consistent with Design Rule 4 \[I\].

**Gate (closed).** Any stored-data or schema change this needs stays behind the restore-drill gate. The gate has not been passed, and this draft does not authorise work to pass it. Existing mechanisms (`source_transcript`, `capture_id`, `action_events`) are preferred where sufficient. No universal audit-log architecture is proposed.

**Not authorised:** any new column, log or change to the writers.

### D7. Undeclared operations

**Status: Proposed for owner approval.**

**Guarantee.** An unrecognised or undeclared operation produces no business write before it is rejected. That includes entity creation, notes and life events.

**Source evidence \[C\].** The model's intent is cast without validation (`ai.ts:~640`). The creation gate allows an intent that has no rule (`auth.ts:564-566, 732`). An unrecognised intent can create a customer or supplier and save a note (`opening.ts:151-299`, `facts-notes.ts:113-124`), and the reply says so (`reply.ts:241-268`). A raw capture is stored before interpretation (`index.ts:332`). The prompt gives `o``the``r` no definition. The conversation-layer contract uses it as one signal that the pipeline understood nothing: the layer runs only when the whole reply is the old failure text, the intent was `other`, and nothing was found, held or refused (`CONVERSATIONAL_LAYER.md:36`, `converse.ts:64-75`). An extraction that failed altogether is treated separately and is not a conversation (`converse.ts:64-75`). The contract also says the conversational layer cannot create, modify, approve or confirm business records (`CONVERSATIONAL_LAYER.md`, about lines 28-32). That sentence is about the layer, not about `other`. The contract does not otherwise define `other` and does not mention declared note capture. `note` is a separate declared intent with its own definition and examples. How often the model emits an unknown intent is unknown \[U\].

**Rules proposed.**

1. Principle: an unrecognised or undeclared operation fails closed. It causes no business write before it is rejected, including entity creation, notes and life events.
2. A failed classification produces no business write: no filed note, life event or person. This is the proposed guarantee. Whether a raw capture may be preserved without filing any business record is a separate question, decided deliberately (see the unresolved list) and not left to the model's interpretation.
3. A catch-all or failed classification confers no entity-creation authority. Creating a person must arise from an explicit entity-creation operation with its own policy (D4).
4. Three cases stay distinct: a failed classification (an extraction that fails altogether, or the model's `other`), declared note capture (`note`), and explicit entity-creation operations. Treating `other` as the no-intent or fallback value is a proposed default pending owner approval and clarification of the contract. It is not an established description of current behaviour in every context. The contract uses `other` as one signal, under the conditions in the evidence above.
5. Where the user's intent is unclear, the Office asks rather than saving a guessed record. Anything it does save records its source and actor (D6), and the reply says what was actually saved.

**Unresolved.** Whether a raw capture may be preserved, without filing any business record, when classification fails, and who may see it. Capture-first storage is existing source behaviour \[C\]. This record does not decide the question, and nothing is implemented.

**Not authorised:** any change to the gate, the router or `other`.

### D8. forget\_last

**Status: Proposed for owner approval.**

**Guarantee.** Whose pending action may be abandoned is an explicit rule, and an ambiguous instruction never abandons an arbitrary action silently.

**Source evidence \[C\].** It clears the speaker's selection and abandons the most recent pending action the caller may resolve, with no per-member filter (`opening.ts:77-90`). An owner can resolve any type (`auth.ts:527-531`). The hold records no creator (`finance.ts:3539-3543`).

**Rules proposed.**

1. A member may abandon their own pending actions. The owner may also abandon another member's.
2. With several eligible pending actions, the Office asks which one. The question identifies whose action and what it is.
3. With none, it clears the selection and does not imply that an action was abandoned.
4. The owner with nothing of their own pending, but others' pending, is asked which of theirs. The owner-facing wording names whose action is being abandoned.
5. Each abandonment is logged as a status-change event (D6 rule 4).

**Gate (closed).** Per-member scoping needs the creator recorded on pending actions, so it waits behind the restore-drill gate. The gate has not been passed.

**Not authorised:** any change to stored data or to the abandon path.

## D9, D10 and D11: evidence, pending-item visibility and personal-day answers

D9 no longer makes an unauthorised model call a prerequisite for every correction. D10 and D11 now separate permission to know from permission to act.

### D9. Replay fixtures and evidence

**Status: Proposed for owner approval.**

**Guarantee.** Evidence used to claim behaviour is preserved states what it does and does not show.

**Source evidence \[C, T\].** The 756 recorded cases are authored fixtures, not captured model behaviour. By static reconstruction (not execution), about 117 contain a model call nobody scripted, which fails and falls back while the case passes. The harness comment says an unplanned call fails loudly, but the model functions swallow it (`tools/harness.js:180-194`). `GOLDEN_UPDATE=1` regenerates the recordings. No test was executed in the audit, so whether the current suite passes is unknown \[U\].

**Rules proposed.**

1. Every report states whether its evidence is an authored fixture, an executed test or a real-model run.
2. Cases that rely on unscripted fallbacks are corrected so every model call is scripted. Each changed recording names the approved rule that requires it, and any change not traceable to an approved rule is flagged to the owner and never accepted silently. The owner reviews by spot-check.
3. For a change to model-dependent behaviour, before-and-after real-model evidence is required when such runs are approved and available. A deterministic correction does not need an unauthorised staging model call.
4. Staging model calls remain prohibited until the staging approvals are explicitly granted: a named commit, a model-spend ceiling and the front-door state.
5. No claim is made that the current suite passes.

**Gate (closed).** The staging approvals have not been granted.

**Not authorised:** any fixture edit, test run, staging activity or model call.

### D10. Pending-item visibility

**Status: Proposed for owner approval.**

**Guarantee.** Lists, counts and previews do not disclose pending items to roles that are not authorised to know about them (Principle 26).

**Source evidence \[C\].** `GET /embers/pending` is open to every role and returns each pending action's type and original sentence with no capability filter (`index.ts:3998-4003`). The sibling `/actions/pending` filters by the caller's confirmation capability (`index.ts:2209-2216`), which is an action permission used as a read filter. Whether that capability's semantics fit as a permission to know is not established. The app shows only an id and type (`main.dart:1882-1886`). A sweep of 21 reads of pending actions found no other client-facing list needing a new filter. It was by source reading and was not a runtime verification of every deployed surface \[U\].

**Rules proposed.**

1. Knowledge permissions and action permissions are separate. Read visibility follows the applicable permission to know the information. Confirming, rejecting and abandoning are governed by the applicable action permissions. Inability to act is not assumed to mean inability to know, and the reverse.
2. An action capability is not assumed to grant access to related pending items or facts. An existing capability is reused for access only where its actual semantics fit.
3. A count, preview or original sentence does not leak the existence or content of an item the viewer may not access.
4. Where no existing capability's semantics fit, access is restricted conservatively and the gap is recorded in the permission gaps table. No new permissions framework is proposed, and no permission or route is changed by this record.

**Unresolved.** Which permission to know governs pending items. The gap is recorded in the permission gaps table. Nothing is changed.

**Not authorised:** any change to the embers or other lists.

### D11. Personal-day answers

**Status: Proposed for owner approval.**

**Guarantee.** A personal-day answer never reveals facts the requesting role is not authorised to know.

**Source evidence \[C\].** The personal-day branch applies no capability filter to three sources: today's schedule, confirmed actions with customer names and amounts (`scheduler.ts:692-716`), and the shared life-event store (`lookup.ts:316-319`). The life-event store is one shared note per day with no author (`memory.ts:267-274, 289-304`). The customer branch of the same handler does gate by capability (`lookup.ts:288-290`).

**Rules proposed.**

1. The answer applies the same underlying knowledge permissions as the relevant trusted reads. The conversational interface does not expand access because it is composing a summary.
2. Scope covers schedules, confirmed actions and life events.
3. Facts are filtered by authorised scope before model synthesis. This is consistent with the model's role as narrator of facts the worker has already authorised (Principle 2) \[I\].
4. A record with missing authorship or provenance is handled conservatively. By the owner's earlier proposal it is shown to the owner role only, and that is recorded as a permission gap until a permission is defined.
5. Confirmed financial facts follow the read permission that applies to that fact. The person who confirmed an action is not assumed to be the only person who may know it. Broad access is not inferred from a job title or from the ability to perform an unrelated action. Where no existing capability's semantics fit, access is restricted conservatively and the gap is recorded.
6. A life-event note is visible to its author. Others' notes are withheld until a permission to know them is defined, and none was identified in the audit \[U\]. The owner's earlier proposal to see all of them is recorded as a permission gap.
7. Today's schedule is not shown on the strength of `can_know_jobs` alone, because that capability's fit for schedules is not established \[U\]. Until the fit is verified it is restricted conservatively and the gap is recorded. A role that needs its own day's schedule would not see it in a personal-day answer meanwhile \[I\]. If the fit is later verified, the existing capability is reused. If it is not, the owner decides what is needed. No new permissions framework is justified yet.
8. Each permission gap is recorded. No permission or route is changed, and no new permissions framework is proposed.

**Gate (closed).** Recording the author of a life event is a stored-data change and stays behind the restore-drill gate, which has not been passed.

**Not authorised:** any change to the lookup, the stores or any access grant.

**Permission gaps recorded (D10 and D11).** These are recorded, not fixed. This record changes no permission or route.

| Information | Existing capability that might fit | Fit established? | Interim handling proposed |
| --- | --- | --- | --- |
| Pending items: existence, type, original sentence | The confirmation capability used by the pending list, which is an action permission | No | Not assumed to grant access. Owner role only until a permission to know is defined. |
| Confirmed financial actions in a personal-day answer | The `can_know_*` capabilities that gate the customer branch of the lookup (`lookup.ts:288-290`) | Not established \[U\] | Restricted conservatively |
| Others' life-event notes | None identified in the audit \[U\] | No | Visible to the author only. The owner's earlier proposal to see all is a recorded gap. |
| Records with missing authorship | None | No | Owner role only, by the owner's earlier proposal. Recorded gap. |
| Today's schedule | `can_know_jobs` | Not established \[U\] | Restricted conservatively (owner role only) until the fit is verified. Recorded gap. |

## Dependencies, gates and deferred work

Both gates are closed and stay closed. Recording a rule does not open a gate, and no rule here authorises work to pass one.

| Gate or dependency | Status | Items it affects | Why |
| --- | --- | --- | --- |
| Restore-drill gate: no stored-data or schema change until three successful synthetic restore drills and a rehearsed rollback | **Closed; not passed** | D6, D8, D11 (author of a life event), and D7 rule 4 where it needs a stored author | Each needs an author, creator or source recorded on existing records |
| Staging approvals: a named commit, a model-spend ceiling, the front-door state | **Not granted** | D9 rule 3 (real-model evidence) | Real-model runs need staging model calls |
| D1 depends on D2 | Dependency | D1 rules 5 and 8, and the held-unverified handling | The negative-line and unverified markers appear in the approval context |
| D2 depends on D6 | Dependency | D2 rules 5 and 6 | The record keeps who acknowledged an unverified item and that it stayed unverified |
| D7 depends on D6 | Dependency | D7 rule 4 | A saved note records its source and actor |
| D8 depends on D6 | Dependency | D8 rules 1 and 5 | Per-member scoping needs a recorded creator; abandonment is logged as a status change |
| D11 depends on D6 | Dependency | D11 rules 4 and 6 | Author information for life events |
| D10 and D11 depend on a permission decision | Open | D10 rule 4; D11 rules 4 to 8 | Which permission to know applies (see the permission gaps table). No permission or route changes. |
| Nothing stored expected | Inference \[I\] | D1 (validation), D2, D3, D4, D5, D10, D11 rules 1 to 3, 5 and 7 | They change what the Office asks, shows or filters, using data and capabilities that already exist |

**Deferred, not decided, not started**

- A counts-only production read, to learn how often bad values occur. It needs explicit approval and a precise statement of what it accesses.
- A universal operation registry, validation framework, executor, identity resolver, audit-log architecture or permissions framework.
- A policy-settings framework for the numerical business-policy proposals in D1 Part B.
- Any change to permissions or routes, and a new user-interface framework.
- Changes to the extraction prompt or the model.
- A customer credit-note document type. D1 rule 6 only says none is introduced.
- Any rebuild decision. The audit found specific gaps, not a case for replacement.
- Unchanged by this record: product creation from names, unit-mismatch clarification, the stocktake overwrite, and the delivery-side safeguards.

## Change summary and change log

The first revision changed 25 points against the earlier draft. The second applied eight reviewer verdicts and the third four corrections. The later updates record the lead-conversion check and the owner's proposals from it. The rule count is now 71.

**Count reconciliation.** First revision: the earlier draft counted gate and dependency notes as numbered points. This record counts rules only and lists gates and dependencies in their own table. That moved the count from 67 to 64 (D1 −4, D8 −1, D10 +1, D11 +1). Second revision: D1 +1 (a negative discount gets no meaning from its sign), D2 +1 (acknowledging is split from confirming), D11 +1 (permission gaps are recorded), giving 67 by coincidence, with different content from the earlier draft's 67. Third revision: D7 +1 (the guarantee that a failed classification produces no business write is stated on its own), giving 68. Fifth update: D4 +3 (rules 9 to 11 for lead conversion), giving 71. D2 and D11 were reworded in the third revision with the same rule counts.

| ID | Previous rule or wording | Recommended revised rule | Reason | Type |
| --- | --- | --- | --- | --- |
| D1 | Area 2 to 200 m², rate up to R3,000/m² and discount to 25% were signed-off rules | Recorded as unvalidated business-policy proposals needing separate owner confirmation and a basis | The audit does not establish them as valid general limits; the Office is not only a flooring business | Evidence limitation |
| D1 | Outside the limits, the document is held unverified | An unusual value is never rewritten; where an established policy flags it, it is shown as unverified before approval | Separates malformed or missing values from unusual but legitimate ones (Principle 1) | Product-policy refinement |
| D1 | Negative lines allowed | Preserved where the operation genuinely permits them; meaning explicit; visible before approval | Avoids treating every negative as valid | Product-policy refinement |
| D1 | A total at or below zero is for a credit note only | Totals follow their declared document semantics; no credit-note type introduced | Scope: a new document type is not part of this task | Product-policy refinement |
| D1 | Not stated | Structural validity is distinct from semantic validity and from commercial plausibility | A finite-value check is not a plausibility threshold | Product-policy refinement |
| D2 | Details one tap away | The approval context shows the total and any material warning; full detail genuinely accessible before confirming | Informed approval without a noisy interface (Design Rules 4 and 7) | Product-policy refinement |
| D2 | Confirm is the approval | Confirming an unverified document requires acknowledging the unverified items; the record keeps who acknowledged | Confirm alone must not make an unverified value established | Product-policy refinement |
| D2 | Outside assistant confirms only with the same detail | Same material information and the applicable authorisation rules | An assistant must not bypass the guarantees | Product-policy refinement |
| D3 | Reply behaviour not specified | The reply states which lines were recorded, which were not, and what is outstanding | Never imply a partial order was complete | Product-policy refinement |
| D3 | A zero or negative price treated as missing; unpriced lines not accepted | Absent, invalid and explicitly zero prices kept distinct; never silently zero | A free line is not missing information | Product-policy refinement |
| D3 | "Implausible value: ask" with no limits set | No plausibility limit proposed or invented | No evidence-based threshold exists | Evidence limitation |
| D4 | Near-match asked everywhere except imports and lead conversion | Routes that can create a person ask; imports follow their own rules; lead conversion preserves the lead's identity and cannot bypass safeguards | The exceptions need defining, not just naming | Product-policy refinement |
| D4 | Not stated | Constitution has no settled identity principle; sibling-lead path matches by name today | Honest evidence status | Evidence limitation |
| D5 | A negative usage is a return, marked | A return only when the instruction establishes it; otherwise ask | A sign alone does not carry the meaning (Principles 1 and 24) | Product-policy refinement |
| D6 | Every record points to the sentence or document that produced it | Real provenance: initiator, authoriser where different, source or lineage, never a fabricated link | Some records have no originating sentence | Product-policy refinement |
| D6 | Every direct write records who | The initiating actor or system | Some writes are made by the system | Product-policy refinement |
| D7 | `other` may create people after asking | A catch-all confers no creation authority; creation needs a recognised operation with its own policy | Principle 2: classification is not authority | Product-policy refinement |
| D7 | `other` may save notes | Declared capture preserved; if intent is unclear, ask; whether `other` is declared capture is unresolved | The source suggests `other` is the model's no-intent value | Evidence limitation |
| D8 | Not stated | Wording names whose action is abandoned; none means clear the selection without implying an abandonment | Avoid silent arbitrary abandonment | Product-policy refinement |
| D8 | Gate listed as a numbered rule | Moved to the gates table; the gate stays closed | Count reconciliation | Dependency correction |
| D9 | Real-model recordings before any behaviour change | Before-and-after real-model evidence only for model-dependent changes, when approved and available | A deterministic correction should not need an unauthorised model call | Dependency correction |
| D10 | Roles that can resolve an item may see it | Knowledge and action permissions separated | Permission to know is not permission to act (Principle 26) | Product-policy refinement |
| D11 | Confirmed money actions shown to the confirmer and the owner | Shown per the read permission for that fact; no assumption the confirmer is the only person who may know | Avoid inferring access from role or action | Product-policy refinement |
| D11 | Facts shown to the model for composing the answer | Facts are filtered by authorised scope before model synthesis | The model must not widen access (Principle 2) | Product-policy refinement |
| D11 | Life events: owner sees all, others their own | Author and holders of a know-others'-notes permission; the owner holds it today \[I\]; permission existence unresolved | The permission is not established in source | Evidence limitation |

Every revised decision is **proposed for owner approval**. This revision is not accepted or ratified.

### Second revision: reviewer verdicts

| Verdict | What the reviewer decided | Revised record | Reason | Type |
| --- | --- | --- | --- | --- |
| 1 (D1 Part B) | Area, rate and discount thresholds stay deferred and unvalidated. No silent promotion to Office-wide rules. No policy framework. | Part B marked deferred. Promotion needs its own decision scoped to the business or trade. No framework. | The evidence does not support general limits | Evidence limitation |
| 2 (D1) | A negative discount gets no business meaning from its sign alone | New rule 9: ask when the meaning is uncertain. The earlier "below 0% unresolved" note is closed. | A sign alone does not carry a meaning | Product-policy refinement |
| 3 (D1) | Provisionally accept the semantic-invalidity list. Field-specific, not blanket. Not a constitutional principle. | Rule 4: dimensions at or below zero; discounts above 100% under the proposed model; negative ordinary rates unless an explicit credit or adjustment. Labelled a proposed operational rule set. | Separates meaning rules from plausibility thresholds | Product-policy refinement |
| 4 (D2) | Acknowledging an item as unverified is not confirming it as established | New rule 6: an acknowledgement changes no factual status and replaces no approval | Confirm and acknowledge are different acts | Product-policy refinement |
| 5 (D2) | Item-level acknowledgement. Taps and interaction details open. | Rule 5: item level; any bulk acknowledgement identifies every covered item | Keeps the truth per item without prescribing the interface | Product-policy refinement |
| 6 (D7) | `other` is a no-intent value only if the contract confirms it. No creation authority. Keep the three cases distinct. Do not implement. | Contract read: confirmed in part. Rules 2 to 4 restated. The unresolved question narrowed. | The contract uses `other` as one signal, not as a general definition | Evidence limitation |
| 7 (D10, D11) | Knowledge and action permissions are separate. Reuse only where semantics fit. Restrict conservatively. Record gaps. No framework. | D10 rules 1 to 4; D11 rules 4 to 8; a permission gaps table | An action capability is not a permission to know | Product-policy refinement |
| 8 (D4) | Lead-conversion identity stays unresolved evidence. Specify a narrow read-only check. Claim nothing either way. | D4 evidence and unresolved wording reworded; check specified under the unresolved decisions | The audit traced one conversion route only | Evidence limitation |
| Housekeeping | Attribute no operational rule to a principle without textual support | References in D2, D5, D6 and D11 changed to "consistent with ... \[I\]" or removed; the relevance column is labelled inference | Evidence discipline | Evidence limitation |

### Third revision: reviewer corrections

| Item | Reviewer correction | Revised record | Reason | Type |
| --- | --- | --- | --- | --- |
| D11 rule 7 and the permission gaps table | The schedule permission is not yet established | `can_know_jobs` is not treated as sufficient. The schedule is restricted conservatively until the fit is verified, and the gap stays explicit. | Consistency with D10 rule 2 | Evidence limitation |
| D2 rule 7 and the unresolved question | An outside assistant's acknowledgement stays unresolved | The default is that a human acknowledges. An assistant may present the items but not acknowledge on a human's behalf unless that is explicitly decided and permitted. | Avoid granting authority through ambiguous wording | Product-policy refinement |
| D7 rules 2 and 4 | Separate the contract's use of `other` from the proposed default, and state the no-write guarantee clearly | New rule 2: a failed classification produces no business write. Rule 4 labels the treatment of `other` as a proposed default. Raw capture preservation is a separate, deliberate question. | The contract confirms only one use of `other` | Product-policy refinement |
| Constitutional basis | A stray symbol near the identity status | The source's question-mark symbol is left out of the identity bullet | Rendering | Presentation |

### Fourth update: lead-conversion check

| Item | Before | Now | Reason | Type |
| --- | --- | --- | --- | --- |
| D4 evidence, rule 3 and unresolved wording; unresolved question 5 | Lead identity was unresolved evidence, with a narrow read-only check specified | The check was run. Results are recorded under the unresolved decisions. Rule 3 stays a proposed policy and is now stated as not matching current behaviour. Question 5 is reworded from an evidence question to an owner decision. | The evidence was gathered exactly as specified | Evidence limitation, closed |

The rule count is unchanged at 68.

### Fifth update: owner proposals on lead conversion

| Item | Before | Now | Reason | Type |
| --- | --- | --- | --- | --- |
| D4 rules 3 and 9 to 11; unresolved question 5 | Rule 3 carried the lead-conversion policy as a proposal, with the evidence question just answered | Rule 3 covers near-match and imports only. New rules 9 to 11: link the specific lead by id; ask which lead when it cannot be identified confidently; ask before the sibling-lead path creates a customer. The question is closed. | The owner answered the three narrow questions the check results framed | Product-policy refinement |

The rule count is now 71 (D4 +3). Five unresolved questions remain: four open and one deferred.

## Unresolved decisions and the implementation boundary

Five questions remain: four are open and one, the numerical policies, is deferred. Each is for the owner, or for evidence the audit did not gather. None justifies another broad audit. The lead-conversion question is closed: the check results and the owner's answers are recorded below and in D4 rules 9 to 11.

| # | Unresolved question | Affects | Settled by |
| --- | --- | --- | --- |
| 1 | Should an outside assistant ever be permitted to acknowledge unverified items on a human's behalf? Default until decided: no (D2 rule 7). | D2 | Owner |
| 2 | What defines an explicitly defined credit or adjustment line, and what exact form does the discount model take (a stated percentage reducing a line's price, 0 to 100%)? Whether line items carry such a marker is unknown \[U\]. | D1 rule 4 | Owner, with evidence on whether line items carry such a marker |
| 3 | Which permission to know governs pending items, confirmed financial facts, others' life-event notes, records with missing authorship and today's schedule (does `can_know_jobs` fit)? Gaps are recorded and access is restricted conservatively meanwhile. | D10, D11 | Owner, informed by the existing capability model |
| 4 | For a failed classification (`other`), may the raw capture be preserved without filing any business record, and who may see that capture? Capture-first storage is existing source behaviour \[C\]. | D7 | Owner |
| 5 | Deferred: what business basis would justify the area, rate and discount figures, and for which business or trade? | D1 Part B | Owner, with business evidence. Not a decision now. |

### Lead-conversion source check: specification and results

**Purpose.** Establish, from source and test definitions only, how every lead-conversion route behaves. It makes no claim in advance about whether identifier-based conversion exists. The check was run as specified below, and its results follow the specification.

1. Enumerate every place in the worker that reads or writes the `leads` table or moves a lead between statuses, and every caller that links a lead to a customer or creates a customer from one. Starting points already seen in the audit \[C\]: the sibling-lead path (`scheduler.ts:530-541`) and two lead status updates, one matching by name and one by customer id. They are starting points only. The list is not assumed complete.
2. For each route, record the identifier used to find the lead (lead id, lead name, customer id or capture), and whether name matching is exact, case-insensitive or looser.
3. Record ambiguity handling for zero, one and several matching leads or customers: whether the route asks, picks one, or proceeds.
4. Record every customer creation or modification the route can cause, including through shared helpers, and whether the opening-step identity safeguards apply.
5. Record which of these behaviours tests define \[T\], without running them.
6. Report each route in a table, labelling every finding as source evidence, test definition, inference or unknown.

**Boundaries.** Read-only. No tests or workflows run, no staging or production access, no data, and no repository change.

**Results.** The check was run read-only on the worker source, with a second, looser search to confirm the enumeration was complete. Nothing was executed.

| # | Route | Identifier | Ambiguity handling | Customer effect |
| --- | --- | --- | --- | --- |
| 1 | `raise_lead` (open to every role) | None: inserts a new lead from the extracted name (`finance.ts:2312`) | No duplicate check | None. The opening step excludes lead intents from customer creation by design (`opening.ts:~157-162`). |
| 2 | `lose_lead` by dictation | Lead id, resolved from the name among open leads | Case-insensitive exact name. The first of equal names wins, in unspecified order. The sole open lead is the default. No match if several and none is named (`snags-leads.ts:102-107`). | None |
| 3 | `POST /leads/:id/mark-lost` | Lead id | Unambiguous. Blocks only "already lost", so a won lead can be marked lost (`index.ts:886-896`). Needs `can_manage_settings` (`auth.ts:804`). | None |
| 4 | Quotation confirmed: `transitionLeadToQuoted` (`finance.ts:2338`, called from `recordQuotation`) | The customer's name | Case-insensitive exact equality on enquired leads. Every matching lead is updated and linked to that customer. | Lead rows only |
| 5 | Quote converted to invoice: `transitionLeadToWon` (`finance.ts:2349`, called from `convertQuoteToInvoice`) | Customer id, stored by route 4 | Every quoted lead of that customer becomes won | Lead rows only |
| 6 | Sibling-lead path: `attachToSiblingJobScope` (`scheduler.ts:530-541`) | Capture id, then the latest lead's name | Latest lead only. No question is asked. | Creates or matches a customer by name and inserts a job scope. The lead is not updated or linked. |
| 7 | Reads: `hasSiblingToAttach`, `GET /leads`, admin views | Capture id, or none | Not applicable | None |

**Findings \[C\].**

- No route converts a lead by lead id. The only lead-to-customer link is written by route 4, by name. Lead ids appear only in marking a lead lost.
- Route 6 is the only place a lead's name reaches `reconcileCustomer`. It calls it directly, so none of the opening step's collision, ambiguity or near-match checks apply. Its comment documents why it exists (`scheduler.ts:520-529`).
- Lead intents are excluded from customer creation in the opening step by design (`opening.ts:~157-162`).
- No lead route modifies a customer's own record. Routes 4 and 5 change lead rows only.

**Consequences \[I\], not demonstrated behaviour.**

- A lead whose name differs from the customer's (for example "Andre" and "Andre Botha") is never linked and stays enquired.
- Two enquired leads with the same name are linked and moved together.
- A customer invoiced directly, with no quotation, never moves its lead.
- A customer created by route 6 stays unlinked to its lead until a quotation links them by name.

**Tests \[T\].** 17 recorded cases name leads: raise and lose cases, role refusals, "a lead keeps the name out of the customer list", and one sibling-lead case. `atomic.test.js` and `role-matrix.test.js` reference the lead functions. How they cover routes 4 and 5 was not read \[U\].

**What this means for D4****.** The earlier proposed policy was not met by current source: conversion links by name, and one route creates a customer without the safeguards. The owner's answers are recorded as D4 rules 9 to 11, as proposed policy. They do not describe current behaviour, and nothing is implemented.

**Implementation boundary.** This revised record is not authorisation to implement any rule. It authorises no code or configuration change, no test or workflow run, no model call, no staging or production access, no schema or stored-data change, and no commit, merge or push. The restore-drill gate and the staging approvals stay closed. After the owner approves a guarantee, the next step is to determine the smallest sufficient enforcement mechanism for it, starting from the existing mechanisms named in this record. That determination is itself a separate decision.

## Evidence basis and source references

Every finding was traced from source in the repository at `main` `42bcb74`. None was run, deployed or observed on a live system, and nothing here upgrades an inference or an unknown into source evidence.

| Item | Key source references \[C\] |
| --- | --- |
| D1 | `ai.ts:775-776` (rates unvalidated); `scheduler.ts:303-312` (unit read as mm unless "m"; area); `job-pricing.ts:218, 412, 525-541` (total above zero; per-sqm rate becomes a flat line); `finance.ts:229-244` and `index.ts:3054-3090` (confirm stores the payload) |
| D2 | `main.dart:3959-3989` (queue shows type and sentence); `reply.ts:164-176` (nested quotation shows no total); `reply_envelope.dart:33-68`; `experience.ts:79-84`; `mcp-pending.ts:27-42` |
| D3 | `finance.ts:268-296` (purchase order written unvalidated); `:522-551` (outstanding); `:362-383`, `:1555-1559` (delivery validators) |
| D4 | `opening.ts:174-296` (guarded route); `stock.ts:51`, `job-pricing.ts:118, 315`, `upload-caption.ts:46-58` (other routes); `identity.ts:463-488` (installer match ignores role); `scheduler.ts:530-541` (lead path by name); `types.ts:117-121` (product policy) |
| D5 | `finance.ts:1704, 1752` (speech usage and stocktake unvalidated); `stock.ts:100-105` (over-use warning) |
| D6 | `finance.ts:2241-2248, 2326-2328` (snag and lead writes); `history.ts:94` (`action_events`); `finance.ts:3539-3543` (no creator on holds) |
| D7 | `ai.ts:~640` (intent cast); `auth.ts:564-566, 732` (unknown intent allowed); `opening.ts:151-299`; `facts-notes.ts:113-124`; `reply.ts:241-268`; `CONVERSATIONAL_LAYER.md:36` |
| D8 | `opening.ts:77-90`; `auth.ts:527-531`; `finance.ts:3539-3543` |
| D9 | `tools/harness.js:180-194`; `tools/characterization.test.js`; 756 authored cases, about 117 with unscripted calls (static reconstruction) \[T\] |
| D10 | `index.ts:3998-4003` (embers unfiltered) against `:2209-2216` (pending list filtered by confirmation capability); `main.dart:1882-1886`; a sweep of 21 pending-action reads |
| D11 | `lookup.ts:288-290, 316-319`; `scheduler.ts:692-716`; `memory.ts:267-274, 289-304` (shared life-event store, no author) |
| Constitution | `OFFICE_CONSTITUTION.md` principle index and Principles 1, 2, 8, 12, 16, 17, 21, 24, 26, 28; `DESIGN_CONSTITUTION_V2.md` Rules 4 and 7 |

**What this basis cannot show:** how often any of these conditions occurs, runtime behaviour on malformed model output, whether the replay suite passes today, and whether any quotation has been wrong. The replay fixtures are authored, not captured from the real model. The 21-read sweep of pending actions was by source reading, not a runtime check of every deployed surface.

**Added in the second revision \[C\].** `CONVERSATIONAL_LAYER.md` (about lines 28-32 and line 36) and `converse.ts:64-75` for the contract's use of `other` and for the statement that the conversational layer cannot create, modify, approve or confirm business records. This was the only new reading. The lead-conversion statements rest on the audit's earlier reading of `scheduler.ts:530-541` and on two status updates whose routes were not traced.

**Added with the lead-conversion check \[C, T\].** `finance.ts:2304-2355` (lead writes and transitions), `finance.ts:254` and `:2614` (their callers), `scheduler.ts:444-450, 498-566` (the sibling-lead path), `snags-leads.ts:80-118` (raise and lose), `index.ts:878-900` and `auth.ts:803-804` (the REST routes and their permission), `opening.ts:~157-162` (lead intents excluded from customer creation), and 17 recorded cases naming leads \[T\]. The check covers the worker's SQL on `leads`. It did not read production data, or how `atomic.test.js` and `role-matrix.test.js` cover the transitions \[U\].
