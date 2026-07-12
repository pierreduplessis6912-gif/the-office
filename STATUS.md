# The Office — Current State

Last updated: 2026-07-11. This is the authoritative "where things actually
stand" document. If it disagrees with a memory of a past conversation,
trust this file — it's meant to be kept current; conversation summaries
are not.

## Philosophy (proven over five real build sessions, not aspirational)

- **The API is the Office.** Every client — this Flutter app, the free
  web preview, a future WhatsApp integration, email — is just a window
  into the same backend. Nothing business-critical ever lives in a
  client.
- **guard():** every consequential write — payments, invoices,
  quotations, quote conversions, and structured customer facts like
  address/phone — holds in `pending_actions` until a human explicitly
  confirms it. Nothing financial or identity-altering writes itself
  automatically.
- **No LLM arithmetic, ever.** Line totals, VAT, deposit splits, real
  area from raw dimensions, "who owes me money" — all computed
  deterministically in code from real stated numbers. The model's job
  is to identify *what was said* (including which unit was meant),
  never to calculate or convert anything itself.
- **Every real AI call is wrapped in `withRetry`.** Real evidence
  2026-07-09: multiple genuine transient failures, every one succeeding
  cleanly on a plain retry seconds later. Any new function that calls
  `env.AI.run(...)` for anything user-facing must wrap the call the
  same way — see `withRetry` near the top of `index.ts`. The two
  `/debug/*` diagnostic routes that deliberately call the model raw,
  unwrapped, are the sole intentional exception, since they exist
  specifically to show unmodified behavior.
- **Capture answers "when," extraction answers "what" and "whose."**
  The receptacle (`captures` table) organizes purely by time — nothing
  is categorized, labeled, or attributed at the moment it arrives.
  Identity, type, and ownership are only ever assigned afterward, by
  extraction, as enrichment. `tenant_id`-style thinking keeps trying to
  creep into the receptacle specifically because it feels natural to
  want to compartmentalize incoming data — resist it; that instinct
  belongs to extraction, not capture.
- **Universal fact types stay consistently named; trade-specific ones
  stay free.** `phone_number`, `email`, and `address` are always named
  exactly that regardless of how they were phrased ("cell," "mobile"),
  and phone numbers are normalized deterministically via
  `libphonenumber-js` — never reformatted by the model. Anything
  genuinely specific to one trade or job (a circuit rating, a paint
  colour) still flows through freely as an arbitrary `fact_key`, with
  no attempt to predict it in advance.
- **Build only what's earned by real evidence.** Every non-trivial
  piece here exists because a real test or a real failure demanded it,
  not because it seemed like a reasonable feature to add. This is the
  single most load-bearing habit in this project — it caught six real
  data-integrity or correctness bugs across 2026-07-08 and 2026-07-09
  (see below), several of them from genuinely dense, real, unscripted
  messages, not synthetic test cases.
- **Five-domain lens** (Communication / Knowledge / Activity / Commerce
  / Governance) is a categorization tool for deciding whether a new
  idea belongs in this system at all — not a checklist demanding equal
  development across domains.
- **Isolated instances, not shared tenancy, if this ever becomes
  multi-business.** Confirmed technically feasible and inexpensive via
  Cloudflare's Workers for Platforms ($25/month base) — but explicitly
  not needed, and not to be built, until manual provisioning of a
  second real business actually becomes a bottleneck. See Pinned Ideas.

## Architecture

- Cloudflare Worker (`office-api`) is the entire backend. Deployed via
  GitHub Actions on every push to `worker/**` (see `.github/workflows/deploy.yml`).
- D1 (`office-db`) is ground truth for anything structured.
- KV (`CUSTOMER_NOTES` namespace) is fast, per-entity narrative memory
  — customers, characters, and daily life events all live here, keyed
  by prefix (`customer:{id}`, `character:{id}`, `life:{date}`). Writes
  are instant; no async lag.
- Vectorize (`office-memory` index) is slow, batched, cross-entity
  associative search — fed by an hourly cron (and a manual
  `/admin/flush-memory` trigger) draining `pending_memory_flush` in one
  batched upsert, not many individual ones.
- R2 (`office-vault`) stores raw voice-note audio *and* raw photos
  (`voice-notes/` and `photos/` prefixes) — both now genuinely linked
  back to their D1 `captures` row via a real `r2_key` column, closing
  a gap where audio was stored with no cross-reference at all.
- `pdf-lib` generates real invoice PDFs server-side — pure JS, no
  native code, runs directly in the Workers isolate.
- `libphonenumber-js` normalizes phone numbers deterministically at
  the point of writing — pure JS, Workers-compatible, verified locally
  before shipping.
- The **receptacle** (`captures` table): every single message — voice
  or typed — is logged raw and unconditionally the instant it arrives,
  *before* extraction ever runs. Enriched afterward with a
  `subject_hint` once extraction knows who or what it was about.
  Nothing said is ever silently lost, even when extraction only
  partially understands it — proven directly against a real, dense
  message that had previously lost two measurements and three tasks
  down to a single phone number.
- **Photo capture**: `/files/photo` stores the raw image to R2
  immediately (the actual raw capture — a generated caption is already
  an interpretation, same as a transcript is for audio), then Kimi
  K2.6's vision capability (confirmed real and usable, same model
  already trusted elsewhere) describes it literally, including any
  legible text or numbers. An optional `caption` field reuses the
  exact same extraction/reconciliation pipeline as text to resolve a
  real `subject_hint`, rather than guessing from the image.
- **Work observations**: a distinct intent (`work_observation`) for
  scoping a job *before* any price exists — components (named parts of
  a job, sometimes with dimensions, sometimes not — a generalization
  of "areas" that also covers circuits, fixtures, rooms) and tasks
  (described work with no dimensions), stored unguarded (no financial
  consequence, unlike everything else `guard()` protects). Area is
  always computed in code from raw width/length; the model's only job
  is recognizing which unit (mm or m) was meant from context and
  magnitude, never converting it itself.

## D1 Schema (current, real)

```
customers        (id, name, address, created_at)
characters       (id, name, relationship, created_at)  -- NEVER referenced by commerce tables
payments         (id, customer_id, amount, source_transcript, invoice_id, created_at)
invoices         (id, customer_id, description, amount, status, source_transcript, quotation_id, created_at)
quotations       (id, customer_id, description, amount, status, source_transcript, created_at)
line_items       (id, quotation_id, invoice_id, description, note, quantity, unit, unit_price, line_total, created_at)
                 -- CHECK constraint: exactly one of quotation_id/invoice_id is set, never both, never neither
jobs             (id, customer_id, description, amount, source_transcript, quotation_id, status, created_at)
                 -- exists, still not exercised by any real flow
job_scopes       (id, customer_id, description, scheduled_date_raw, scheduled_date, source_transcript, created_at)
                 -- scheduled_date_raw is the phrase exactly as said ("next Thursday"); scheduled_date
                 -- (2026-07-11) is the real, resolved calendar date — resolveScheduledDate does the
                 -- actual date math deterministically, in code, no AI call, same reasoning as "the LLM
                 -- must never do arithmetic" extended to dates. Verified live: "next Thursday" resolved
                 -- correctly to the real date. Genuinely unparseable phrases stay honestly null.
scope_components (id, job_scope_id, name, width_mm, length_mm, area_sqm, created_at)
                 -- width_mm/length_mm always in real millimeters; area_sqm always computed in code
                 -- from real converted values, never from the model's raw, possibly-unconverted numbers
scope_tasks      (id, job_scope_id, description, component_id, created_at)
                 -- component_id nullable — set when a task was clearly about one named component
                 -- ("Theatre 2 needs moisture testing"), null when it applies to the whole job
customer_facts   (id, customer_id, key, value, source_transcript, created_at)  -- EAV holding tier
                 -- key is a closed, consistent name for phone_number/email/address; free text for
                 -- anything trade-specific. value is normalized in code for phone_number and email.
captures         (id, raw_text, source, subject_hint, extraction_status, r2_key, created_at)
                 -- THE RECEPTACLE. source: 'voice' | 'text' | 'photo'. subject_hint is a loose text
                 -- name, NOT a real foreign key — a known, named limitation, not an oversight.
pending_actions  (id, type, payload, status, source_transcript, created_at, resolved_at)
                 -- types in use: payment, invoice, quotation, convert_quote, customer_fact, schema_candidate
pending_memory_flush (id, customer_id, text, created_at)  -- staging queue, KV -> Vectorize
memory_errors    (id, customer_id, text, error, created_at)  -- durable log for background-write failures
business_profile (id fixed=1 via CHECK, name, trading_as, vat_no, address, phone, email, website,
                  banking_details, vat_registered, vat_rate, analytics_opt_in)
                 -- real seeded data: Zululand PPE and Industrial Supplies / Zululand Flooring and Blinds
                 -- analytics_opt_in: genuinely off by default, nothing built to use it yet — see below
tasks            (id, description, done, created_at, completed_at)  -- 2026-07-11, real, checkable
                 -- personal errands only ("get dog food", "phone my mother") — deliberately does NOT
                 -- duplicate pending_actions' own done state (status/resolved_at), which already covers
                 -- guard()-confirmed business records. Created only by "reminder" intent; matched and
                 -- closed only by "task_complete" intent, via fully deterministic word-token matching
                 -- (resolveTaskCompletion) — no AI call anywhere in that matching step. See the
                 -- Execution Ladder section below for why.
selections       (key PRIMARY KEY, entity_id, label, updated_at)  -- 2026-07-11, the execution register
                 -- rung 1 of the Execution Ladder, OFFICE_CONSTITUTION.md Principle 16. Generic
                 -- key/value on purpose — `key` IS the type ("customer", "character"; quotation/
                 -- invoice/task/supplier/project whenever those are earned) so a new selection type
                 -- never needs a schema migration, only new rows. Two real read strategies:
                 -- getSelection(key) for typed lookups ("the quote"), getCurrentSelection() for
                 -- untyped ones ("it"/"them") — a single query, no type names in it, ordered by
                 -- updated_at. Checked BEFORE any AI-based resolution is attempted, per Principle 1.
```

**Why `characters` is a separate table, not a `type` column on
`customers`:** the entire safety property — that a personal relation
can never accidentally touch an invoice or "who owes me money" — comes
from it being structurally impossible, not from application-code
discipline. A polymorphic `people` table with a nullable `customer_id`
would reopen exactly the class of bug `guard()` exists to prevent.
Deliberately rejected once already; don't reintroduce without a real
reason. The same `tenant_id`-style temptation has resurfaced from
AI-generated documents on three separate occasions — treat any
document proposing shared/polymorphic structure with real suspicion.

**Why work observations are unguarded while everything financial is
guarded:** money changes the outside world; a wrong measurement is a
cheap, easily corrected mistake. `guard()` is reserved for consequence,
not for every write.

## Extraction schema (`Extraction` interface, `extractIntent`)

```
customer_name, character_name, character_relationship,
intent: payment | invoice | quotation | convert_quote | price_scope
        | work_observation | lookup | reminder | note | other,
amount, fact_key, fact_value, personal_note,
query_scope: customer | character | personal | business | null,
deposit_percent,
scope_document_type: quotation | invoice | null  -- only set when intent is price_scope
```

Runs on **Kimi K2.6** (`chat_template_kwargs.thinking: false`,
`temperature: 0`) — proven superior to a smaller model via a real
head-to-head test (5/5 correct vs. 1/5, zero curated examples needed).

**Three dedicated, separate extraction calls exist for genuinely
different shapes of output**, rather than overloading the single flat
classifier: `extractLineItems` (multiple priced line items from one
quotation), `extractWorkObservation` (components + tasks + optional
schedule phrase from one job-scoping message), and `extractScopePricing`
(matches spoken rates to the real, already-measured component/task
names of an existing job_scope — grounded in real given names, never
allowed to invent new ones). Same reasoning as `resolveFollowUpEntity`
and `answerFromMemory` being their own steps — one job per call.

**`price_scope` (2026-07-10) is the job_scopes → priced-document link.**
It finds a customer's most recent `job_scope`, gives the model the
real component names/areas and task descriptions, and asks it to match
spoken rates against them — `pricing_type` ('per_sqm' or 'flat') and
`rate` only; the actual `area_sqm x rate` multiplication always
happens in code afterward, the same discipline as every other number
in this system. `scope_document_type` decides the destination using
the identical tense rule already proven for plain quotation vs invoice
("quote"/"price up" -> quotation; "invoice"/"invoice out" -> invoice),
defaulting to quotation when genuinely ambiguous since proposing a
price is less consequential than billing one. Reuses the exact same
guarded `holdForConfirmation` pipeline as every other quotation/invoice
— no new pending-action type, no schema change. Proven live 2026-07-10
against all three real job scopes: Dwayne (quotation #5, R25,311.50),
Jose (quotation #6, R54,050), and TestCo (same job scope priced twice
— quotation #4 R17,350, then invoice #4 R20,150 at a different rate —
confirming both destinations really work off the same underlying
mechanism).

`recordInvoice` now optionally accepts real line items — `line_items`
already supported `invoice_id` via its CHECK constraint (exactly one
of quotation_id/invoice_id, never both), it just never had a writer
until price_scope needed to produce invoices as naturally as
quotations. Plain flat-amount invoices (no job scope involved) are
unaffected — confirmed live: existing invoices created the old way
still show an empty `lineItems` array, only price_scope-derived
invoices carry real ones.

**Multi-turn conversational retrieval depth (2026-07-10) — proven live,**
**after one approach was tried, found broken, and replaced.** The
original design (`rewriteQuery`) asked the model to rewrite a vague
follow-up ("who did we deal with in those instances?") into a fully
self-contained, fluently-worded sentence before extraction ever saw
it. Real testing against a genuine 3-hop drill-down conversation (why
don't we buy from ProSupply anymore → who did we deal with in those
instances → when was that) found this approach reliably looped under
`thinking: true` — the raw reasoning trace showed the model redrafting
the same near-identical sentence five-plus times, hitting the token
ceiling with empty content, no matter how the prompt was tuned (five
separate attempts: worked example, decisiveness rules, conciseness
rules, effort-sizing instructions, a classify-then-route split). The
pattern only ever broke on open-ended prose *generation*; `thinking:
false` alone fixed the looping but broke the one case `thinking: true`
was originally added for (a genuine pronoun tie-break between two
different people). Root cause, once actually seen in the reasoning
traces: every fix added another rule, and thinking-mode reasoning has
room to audit its own answer against a growing rulebook — that's
what the "wait, let me reconsider..." loops actually were.

**Replaced entirely, not patched further.** `resolveFollowUpEntity`
asks only one narrow, closed-form question — which EXISTING named
entity does this follow-up refer to — the same JSON-extraction shape
as `extractIntent`'s `customer_name`/`character_name` fields, which
have never looped once anywhere in this build, because there's no
open-ended text to generate. `findExistingEntityByName` then does a
plain, read-only SELECT (never an INSERT — a mere lookup must never
silently create a customer or character). The *original, unedited*
question goes straight to `answerFromMemory` with that entity's real
facts. No sentence is ever rewritten by the model in this path at all.
Proven live across the full 3-hop ProSupply conversation, each hop
landing on the correct fact, no looping, `finish_reason: stop` every
time. One real resolution bug surfaced and was fixed in the same
session: the resolver initially anchored on any name mentioned in the
office's own reply (picked "Sarah" — a supporting detail — over
"ProSupply", the actual standing topic), which then collided with an
unrelated real customer coincidentally also named Sarah. Fixed by
anchoring explicitly on what Peter's own question was originally
about, not any name appearing anywhere in the exchange.

## Models in use

- `@cf/moonshotai/kimi-k2.6` — extraction, follow-up entity resolution
  (`thinking: false`, closed-form), answer synthesis, image description
  (confirmed to support vision input)
- `@cf/openai/whisper` — voice transcription
- `@cf/baai/bge-base-en-v1.5` — embeddings
- `@cf/baai/bge-reranker-base` — reranks Vectorize results (real scores
  are ~0.0005 scale, NOT 0–1 — trust relative ranking + top-N, never an
  absolute threshold)

## Real bugs found and fixed (worth remembering the shape of, not just the fix)

**2026-07-08:**
1. **Reconciliation collision.** First-token-only name matching
   silently merged two different customers who shared a first name
   ("John Wilkins" matched an existing "John Titlestadt"). Fixed:
   requires both first AND last name to match when a full name is
   given; falls back to loose first-token matching only when genuinely
   just one name was spoken.
2. **Unguarded structured-fact writes.** `applyStructuredFact` fired
   immediately via `ctx.waitUntil`, independent of `guard()` — a
   misreconciled customer (bug #1, before the fix landed) had their
   real address silently overwritten before anyone ever saw a
   confirmation prompt to reject. Fixed: structured facts now hold in
   `pending_actions` (type `customer_fact`) exactly like money.
3. Reranker/embedding thresholds were never reliable absolute numbers
   — both replaced with relative-ranking approaches, discovered via
   real test data, not assumption.
4. Silent background failures (`ctx.waitUntil` with no `try/catch`)
   recurred multiple times — always log to `memory_errors` now.
5. Lookups (questions) must never be stored as memory facts — two
   independent defenses: intent classification AND a deterministic
   `looksLikeAQuestion()` text-shape check, since classification alone
   has been observed to misfire.
6. Bare pronouns ("her", "him") were being accepted as customer names,
   creating garbage records — a `NOT_A_NAME` denylist plus a minimum
   length check now rejects them before any customer gets created.

**2026-07-09:**
7. **Recency-vs-frequency pronoun resolution.** `rewriteQuery` was
   resolving "her" to whichever person was mentioned *more often* in
   recent history, not most recently — even after an explicit prompt
   rule stating recency should win. Fixed by enabling `thinking: true`
   for this specific call, proven necessary via a real side-by-side
   comparison (thinking off: wrong customer; thinking on: correct,
   with a real reasoning trace showing it correctly applying the rule).
8. **Single-customer balance lookups never touched real financial
   data.** "What's Sarah's balance" only searched narrative KV notes
   — real confirmed payments and invoices were invisible to it, so a
   customer who had genuinely paid still came back "I don't have that
   on file." Fixed: `getCustomerFinancialSummary` now always runs
   alongside narrative notes for any customer-scoped lookup, honest
   about the case where payments exist with no invoice to balance
   against (a real "credit," not a fabricated debt).
9. **Silent, catastrophic unit error in work observations.** A real
   message ("Theatre 2 is 8 by 6") had its dimensions written straight
   into `width_mm`/`length_mm` fields with no unit conversion,
   producing `area_sqm: 0.000048` instead of the real 48 m² — off by a
   factor of a million, silently, with total confidence. Fixed: the
   model now reports the raw number plus which unit it recognizes was
   meant (mm or m, from magnitude and context); the actual
   multiplication always happens afterward, in code.
10. **Tasks had no link to which component they belonged to.** "Theatre
    2 needs moisture testing" and "Theatre 3 needs skirting removed
    first" both landed as flat, unlabeled job-level tasks. Fixed:
    `scope_tasks.component_id`, resolved in code from an optional
    `component_name` the model reports per task.

**2026-07-10:**
11. **Subject-attribution: extraction picked an incidentally-mentioned
    name over the real subject of the message.** "ProSupply was late
    delivering the tiles for Jenny's job back in March" got filed
    under Jenny (the job mentioned as context) instead of ProSupply
    (who the message was actually about — the late delivery). Found
    live while seeding a real multi-turn retrieval test, not
    synthetically. Fixed: the extraction prompt now explicitly asks
    "who or what is this sentence fundamentally reporting on," not
    just which names appear in it — with a real example baked in.
    Live data this had already polluted (a stray note filed onto
    Jenny Hawke's real customer file) was corrected by hand afterward
    via the two debug routes added for exactly this.
12. **`character_name` was defined too narrowly — personal relations
    only, no way to hold a supplier.** The same bug above also
    revealed that a supplier ("ProSupply") had nowhere safe to live:
    forcing it into `customers` would have made it silently
    quotable/invoiceable, the exact class of risk `characters` exists
    to prevent for personal relations. Fixed by broadening the real
    invariant: `character_name` now covers anyone NOT billed by the
    tradesperson — personal or business — not just personal relations.
    `characters.relationship` already stored a free string; no schema
    change needed, only the extraction prompt's definition.
13. **A named staff contact at a supplier fragmented off its own
    entity.** "Called ProSupply... spoke to Sarah in dispatch" filed
    the note under a brand-new standalone character "Sarah",
    disconnected from ProSupply — the fact that actually explained why
    Peter stopped buying from them became unreachable by asking about
    ProSupply. Fixed with the same subject-attribution discipline as
    bug #11: a person named only as a company's staff/contact is a
    detail of that relationship, not a separate entity.
14. **`rewriteQuery` reliably looped under `thinking: true` on
    fact-summary references, no matter how the prompt was tuned.**
    Real multi-turn testing (why don't we buy from ProSupply anymore →
    who did we deal with in those instances) found the model
    redrafting the same near-identical rewritten sentence five-plus
    times, hitting the token ceiling with empty content — confirmed via
    a dedicated raw-introspection debug route showing the actual
    reasoning trace and `finish_reason: length`, not guessed at. Five
    separate fixes attempted first (raising `max_tokens` 600→1200→2500,
    fixing a self-conflicting worked example, explicit decisiveness/
    conciseness rules, a classify-then-route split between `thinking`
    modes) — all failed to stop the loop, because the real cause was
    open-ended prose *generation* having no natural stopping point
    under `thinking: true`, not any specific wording. See the
    Extraction schema section above for the actual fix: the whole
    approach was replaced with closed-form entity extraction
    (`resolveFollowUpEntity`), not patched further.
15. **The replacement's first version anchored on the wrong entity.**
    `resolveFollowUpEntity` initially picked any name mentioned in the
    office's own reply, not necessarily the actual standing topic —
    it resolved "who did we deal with" to "Sarah" (a supporting detail
    inside ProSupply's notes) instead of "ProSupply" itself, and that
    wrong name then collided with an unrelated real customer
    coincidentally also named Sarah. Fixed by anchoring explicitly on
    what Peter's own question was originally about, treating other
    names in a reply as supporting detail unless the new message
    specifically asks about one of them.

**2026-07-11, found live via the static preview UI, not curl testing:**
16. **A reminder's raw transcript leaked a personal errand into a
    customer's own file.** "Heading to jenny's job now, remind me to
    get dog food after" correctly isolated `personal_note`, but the
    raw transcript — dog food and all — was *also* stored verbatim as
    a customer note under Jenny, since storage only skipped that
    fallback when there was no customer at all. Same subject-
    attribution principle as bug #11, just missed for this intent.
    Fixed by excluding "reminder" (and later "task_complete") from
    ever writing to a customer/character's own note store.
17. **Business-scope follow-ups pulled in unrelated fact sets.** "How
    many quotations are pending?" → "names and amounts" surfaced
    invoice-balance facts too, because business-scope lookups always
    fetched both outstanding-invoice and quotation facts regardless of
    which one the conversation was actually about. Fixed with
    `classifyBusinessTopic`, the business-scope sibling of
    `resolveFollowUpEntity` — same standing-topic anchoring, one level
    up from named entities.
18. **A purely-personal reminder involving a character created no
    task at all, silently.** "Remind me to phone my mother" correctly
    classified as `reminder` with `character_name: "mother"`, but left
    `personal_note: null` — the model treated the whole message as
    being about that character rather than a mixed split, since there
    was no separate customer to split away from. Task creation used to
    depend on `personal_note` being set, so no task was created, while
    the response still said "Got it." Fixed by decoupling: a reminder
    always creates a task now, falling back to the full transcript
    when there was nothing to split.
19. **Bare pronoun-only task completions ("did that", "called them")
    misclassified as `note` instead of `task_complete`, twice in a
    row.** Root cause: `extractIntent` classifies before it ever knows
    what open tasks exist, so it had no grounding that a vague
    completion was even plausible. Fixed by broadening the
    `task_complete` rule and examples to explicitly include pronoun-
    only phrasing — the real matching precision still lives entirely
    downstream, in code, against the real open-task list.
20. **A real architectural correction, not just a bug: task
    completion matching was originally implemented as an AI call**
    (`resolveTaskCompletion` handed Kimi the list of open tasks and
    asked it to judge which one matched). Direct testing surfaced a
    real, repeatable failure mode this design invites: real
    ambiguity (two genuinely similar open "call" tasks) needing to be
    asked about rather than guessed. Working through this live
    produced the session's biggest standing principle — see "The
    Execution Ladder" below — and the function was rebuilt as pure
    deterministic word-token matching, zero AI calls. The rebuild
    itself then surfaced a second, narrower bug: naive full-string
    substring matching missed "called" against "call" entirely,
    falling back to presenting *every* open task as a candidate,
    including a completely unrelated one ("pick up the kids" showing
    up for "called them"). Fixed with light deterministic stemming and
    token-overlap matching instead of substring containment — still a
    literal index, not AI judgment, just a correct one. Verified
    directly in Node before ever redeploying.
21. **The smoke-test suite itself became unreliable at 17 cases.**
    Running all cases concurrently via `Promise.all` started tripping
    Workers AI's own capacity limit ("3040: Capacity temporarily
    exceeded"), which never happened at 11–14 cases. A regression
    suite that fails under its own concurrent load isn't trustworthy;
    fixed by running cases sequentially instead.

**2026-07-11, execution register:**
22. **The register check was gated behind `history.length > 0`,**
    inherited unchanged from the old AI-only fallback it replaced.
    The register reads real, persisted D1 state — it needs no history
    at all — but a live test that deliberately sent no history skipped
    it entirely and fell through to "I don't have that on file." Fixed
    by making the register check unconditional whenever nothing was
    directly named; only the genuine AI-based fallback stays gated
    behind having real history text to scan.
23. **`getCurrentSelection` was hardcoded pairwise comparison of
    exactly two type names, not actually a generic primitive** — it
    only looked like one because the schema underneath it already
    was. Caught before a third type could multiply the pattern:
    rebuilt as a single query with no type names in it at all,
    ordered by `updated_at`. Adding a third, fourth, or tenth selection
    type now means only inserting rows under a new key.
24. **Phantom customer/character creation on lookup**, found via
    external code review and confirmed against the actual code:
    `reconcileCustomer`/`reconcileCharacter` create a row on no-match
    and were called unconditionally for every intent, including
    `lookup` — so asking about someone who doesn't exist silently
    created them, then correctly said "I don't have anything on
    file." A real violation of Principle 1 (a lookup should be pure
    resolution, never a write), fixed by routing lookup intent
    through the already-existing read-only `findExistingEntityByName`
    instead.

**2026-07-11, real scheduling ("what's up today"):**
25. **The execution register silently overrode a genuinely self-
    scoped question.** "What's up for today?" was correctly classified
    `query_scope: "personal"` by the model — no entity involved at
    all — but the register still fired (intent=lookup, no name given)
    and silently rewrote it to a customer lookup about whichever
    customer was most recently touched, answering "New customer
    Sipho, measured the office..." instead of the actual schedule.
    Fixed by excluding `personal`-scoped lookups from register/AI
    fallback resolution entirely — that classification is a strong,
    reliable signal nothing entity-specific is being asked about.
    Deliberately kept `business`-scoped lookups eligible for the
    fallback: the already-proven ProSupply case genuinely needs it to
    correct an uncertain business-wide guess into the right entity, so
    the fix couldn't be "block the register for anything non-
    customer" — the two cases needed different treatment.
26. **`answerFromMemory` silently dropped facts under its own "be
    brief, one sentence" instruction** whenever a question genuinely
    had multiple distinct relevant answers. "What's up today" combining
    one scheduled job and five open tasks collapsed down to mentioning
    only the job — not wrong, just incomplete, and silently so. The
    same failure family as the dog-food bug from earlier this session,
    the opposite symptom: that one crammed in too much irrelevant
    content into one sentence, this one dropped too much relevant
    content trying to stay in one — both from asking a single sentence
    to do a list's job. Fixed by requiring coverage of every relevant
    fact; a single-fact answer still naturally comes out as one
    sentence, a multi-fact one becomes a short list instead of a
    silent omission.

**2026-07-11, ember bar and a regression it exposed:**
27. **Task descriptions stored the raw "remind me to..." phrasing
    verbatim**, making completion messages read oddly ("Marked done:
    remind me to get dog food" instead of "Marked done: get dog
    food"). Fixed with a small, deterministic prefix-stripper
    (`cleanTaskDescription`), verified directly in Node before
    deploying. Historical tasks created before the fix keep the old
    phrasing — same honest asymmetry as the captures FK backfill, not
    silently rewritten.
28. **A real regression in `answerFromMemory`, caught the very next
    time "what's up today" was tested for real.** As life events
    genuinely accumulated across a full day of real testing, the
    personal-scope fact list grew long enough that the model started
    echoing raw life-event facts back nearly verbatim — dropping the
    actual schedule/task facts entirely, which were appended later in
    the array and never reached. Bug #26's fix (cover every relevant
    fact) was correct but left "relevant" ambiguous under a long,
    noisy fact list. Fixed two ways: facts reordered so the most
    directly relevant ones (schedule, completed-today) come first,
    life events last as supplementary context; and the prompt
    tightened to make relevance-filtering an explicit, separate step
    from coverage — "decide what answers this question first, then
    cover all of those, don't just repeat back everything given."

## Debug and diagnostic routes

`/debug/list-audio`, `/debug/reprocess`, `/debug/search-memory`,
`/debug/customer-notes`, `/debug/life-events`, `/debug/memory-errors`,
`/debug/memory-health`, `/debug/stress-memory`, `/debug/rerank-raw`,
`/debug/smoke-test`, `/debug/captures` (supports `?status=` filter to
revisit unprocessed captures as a batch), `/debug/job-scopes`,
`/debug/quotations`, `/debug/invoices` (both real, verified 2026-07-10
while proving price_scope end to end — each shows line items directly,
not just the summed total, since a right total can hide a wrong line),
`/debug/characters` (the `characters` table had zero visibility until
today), `/debug/kv-set` (generic KV write-back, the counterpart to
`/debug/customer-notes` GET — POST `{key, value}`), `/debug/delete-
customer?id=` and `/debug/delete-character?id=` (scoped: delete the
row, its KV notes, and — for customers — any pending_memory_flush
entries; not a general SQL executor). All four earned live 2026-07-10
correcting real data two subject-attribution bugs had polluted, not
built ahead of need — kept because the same class of correction will
likely be needed again. `/debug/resolve-entity-test` — the real
replacement for the abandoned query-rewriting approach, see Extraction
schema section above; takes the same `{text, history}` shape as
`/messages/text` so a real drill-down conversation can be replayed
exactly. `/debug/init-tasks-table` (one-time schema init — no
Cloudflare CLI access from this environment, `IF NOT EXISTS` makes it
safe to call more than once), `/debug/tasks` (list, for verifying
matching behavior directly), `/debug/complete-task/:id` (direct
tappable completion, no natural-language matching needed — the real
endpoint a future ember list would call). `/debug/init-selections-
table` (same one-time schema-init pattern) and `/debug/selections`
(list, for verifying the execution register directly). `/debug/init-
captures-fk` (idempotent `ALTER TABLE`, real customer_id/character_id
columns) — `/debug/captures` now supports real `?customerId=`/
`?characterId=` filtering, a genuine join, no more fuzzy `subject_hint`
text matching. `/debug/init-job-scopes-date` (same idempotent pattern,
the real `scheduled_date` column) and `/debug/schedule` (the actual
calendar query — real, queryable dates, computed live, no cron
snapshot). `/debug/rewrite-thinking-
test` (served its diagnostic purpose already — safe to remove),
`/debug/pdf-route-test` (leftover from a routing diagnosis — safe to
remove), `/admin/flush-memory`.

**Strip all debug/admin routes before any real customer data flows
through production.** `/files/audio`, `/files/photo`, `/files/document`
(2026-07-11, the third "sense" — verified live with a real image and a
real PDF), `/messages/text`, `/embers/tasks`, `/embers/scheduler`,
`/embers/finance` (2026-07-11 — the real tap-to-expand register behind
each ember; every `/messages/text` response also carries live
`embers: {tasks, scheduler, finance}` counts, recomputed fresh on every
turn, riding along with the normal response rather than needing any
push/real-time infrastructure — see OFFICE_CONSTITUTION.md Principle
19, "Silence is success," and the UX vision section below for the full
design),
and `/actions/*` are real, production routes — not debug — and stay.

`/debug/smoke-test` is the actual regression safety net — 17 real
classification test cases as of 2026-07-11 (grew from 11), zero side
effects (tests `extractIntent` in isolation, never writes to KV or
D1), safe to rerun after every single future change. Runs sequentially,
not concurrently — real bug found live 2026-07-11: at 17 cases,
`Promise.all` started tripping Workers AI's own capacity limit, which
never happened at 11–14. If it ever fails again, check the
`rawOnFailure` field on failing cases before concluding there's a
genuine regression.

## Free iteration loop

Web preview: `https://the-office-preview.pages.dev` — built via GitHub
Actions + Cloudflare Pages, zero Codemagic minutes. Type-mode is fully
real (talks to the live backend), and now includes: conversation
history sent with every message (closing the gap where the proven
query-rewriting fix was unreachable through the actual app), and real
tappable Confirm/Reject buttons driven by the actual `pendingActionId`
/`factPendingActionId` fields — not text-matching — with live visual
state (pending / confirmed / rejected). The mic still does not work on
web — confirmed, not a bug: `path_provider` has no web implementation.
**This UI has never been shipped to Peter's actual installed app via
Codemagic — still only proven on the web preview.**

## Known gaps, deliberately deferred (named on purpose, not forgotten)

- **Auth:** `/auth` is a bare 501 stub. No multi-user, no
  multi-tenancy — this is explicitly one Office per business entity; a
  second real entity means a second Office instance, not a schema
  change (see Pinned Ideas for the real, costed migration path if this
  ever changes). Real, related gap named alongside this by external
  review 2026-07-11: CORS is wide open and there's no rate limiting —
  low urgency for a genuinely single-user system reachable only by
  Peter, but the same underlying gap as no-auth, not a separate one.
- **PDF text extraction is not built.** `/files/document` (2026-07-11)
  stores a real PDF reliably and correctly — verified live with a real
  file — but doesn't read its contents. No PDF-parsing capability
  exists in this environment; `pdf-lib` (already a dependency) is a
  generation/manipulation library, not a text-extraction one. Named
  honestly rather than pretended solved.
- **`captures` real FK backfill.** `customer_id`/`character_id` (added
  2026-07-11) are correctly populated for every NEW capture from here
  on, verified live via a real clean join (`?customerId=1`). Every
  capture from *before* that migration only has the old text
  `subject_hint`, no real FK — a genuine asymmetry, deliberately left
  as-is for now rather than backfilled. A retroactive backfill would
  mean re-deriving structure from a loose string after the fact, the
  exact kind of fuzzy matching Principle 1 is skeptical of — low risk
  as a one-time correction rather than an ongoing judgment call, but
  not worth doing while the real capture volume stays this small.
- **WhatsApp (2026-07-11, real pivot):** the plan changed from a
  WhatsApp Business API integration to native Android behavior — Share
  Sheet in/out (see OFFICE_CONSTITUTION.md Principle 20, "One Office,
  Many Doors"). A real Evolution API number exists from earlier work
  and remains real, working technology — deliberately parked as a
  possible future door, not abandoned, but no longer the active plan.
  Verified against what's actually built, not aspirational: all three
  native "doors" this pivot depends on already exist independently of
  WhatsApp — file upload (`/files/document`), photo capture
  (`/files/photo`), and document display (the real quotation/invoice
  PDF routes). What's still missing: the actual Share Sheet
  in/out wiring on the Android side (native, not backend — out of
  scope for backend-only work), and a real "prepare a WhatsApp-ready
  message" generator for a confirmed quotation/invoice (backend,
  genuinely missing — the confirm response returns the raw record and
  `pdfUrl` today, not the actual text a human would send).
- **GPS/location customer detection:** proven *possible* — D1
  genuinely supports the trig functions needed for real Haversine
  distance math (verified live), and TenderLogix already has
  substantial, reusable Google Places integration — but raw-GPS-to-
  address reverse geocoding specifically is not built anywhere yet.
- **Invoice line items:** no `discount_percent` field yet (deliberately
  deferred — prove basic multi-line totaling first, which is now
  proven). No per-invoice VAT override (only a business-wide toggle
  exists). No retention field.
- **PDF:** text-only, no business logo embedded yet.
- **Weekly/periodic briefing:** deliberately NOT built as a
  cron-generated pre-computed snapshot — identified as unearned
  complexity. The "smallest honest version" (on-demand personal/
  business lookup, computed live) is what exists.
- **Tasks have no link to a real customer or character** — pure text,
  no FK, unlike `captures` which got exactly this fix 2026-07-11. Named
  live by the ember-bar UX design: a `[Call]` action button on a task
  ("call Sarah about invoice") needs a real phone number to call, which
  means the task needs a real link to Sarah's actual record. Not built
  — the ember bar itself only shows real counts and a real list today,
  no per-item actions yet.
- **Tasks have no due/scheduled time at all**, only open/done. A
  `[Reschedule]` action on a task needs exactly the due-time concept
  the full scheduler (pinned, not built — see Pinned Ideas) would add.
  Deliberately not smuggled in early just to make one ember-bar button
  real.
- **No weather integration** — a completely new kind of gap versus
  Tasks/Scheduler/Finance, which are all real internal data already.
  Needs a genuine external API dependency that's never been discussed
  or evaluated anywhere in this project. Not stubbed, not estimated.

## Pinned ideas (validated as real and possible, not built)

- Business profile logo/details captured via a photo upload during
  onboarding, rather than typed in by hand.
- GPS-based "you've arrived at Jenny's" detection (see gap above).
- WhatsApp integration, tiered by permission level: Level 1 read-only
  first, Level 2 draft-and-confirm (matches `guard()`'s existing
  philosophy exactly), Level 3 trusted-contact auto-reply, Level 4
  fully autonomous — explicitly not recommended to enable globally.
- Phone contacts as a reconciliation *aid* (surfacing a phone number to
  disambiguate a name collision), not a bulk customer-import source —
  native OS permission only, no Meta/WhatsApp Business API involved.
- **Durable Object per entity**, for concurrent-write protection —
  e.g. `appendCustomerNote`'s read-modify-write has no lock today.
  Real risk only once more than one channel (voice + WhatsApp,
  concretely) can write to the *same* customer's record at the *same*
  instant. Not needed with one input channel and low volume.
- **Durable Object as a shared rate-limiter / token bucket** for
  outbound AI calls — a real, documented Cloudflare pattern, distinct
  from the per-entity use case above. Solves a coordination problem at
  volumes far beyond anything seen yet (Workers AI's real published
  limit is 300 req/min for most LLMs; today's real traffic is nowhere
  close). `withRetry` is the correct fix for today's actual scale.
- **Cross-instance/cross-business analytics.**
  `business_profile.analytics_opt_in` exists as a real column,
  genuinely off by default, nothing built to use it yet. Silent
  cross-tenant crawling (even of field *names*, not values) is
  permanently off the table — it breaks the actual privacy promise
  isolation exists to make, and raises real POPIA exposure the moment
  a second real business exists. Only disclosed, explicit opt-in,
  pattern-only telemetry (never raw content) is legitimate — modeled
  on Anthropic's own business/API-tier data policy (never used for
  training without explicit consent), not the more permissive
  consumer-tier default that drew real regulatory criticism.
- **Workers for Platforms migration**, for eventual multi-business
  provisioning. Confirmed real and current: $25/month base plan (on
  top of the existing $5/month Workers Paid plan already in use),
  standard per-request/CPU billing beyond that — Cloudflare only
  bills one request across the whole dispatch → user Worker → outbound
  Worker chain, not each hop separately. Solves compute isolation and
  routing between businesses natively — proven at real scale by
  Cloudflare, not something to build custom. Each user Worker can have
  its own D1/R2/KV bindings, matching the non-negotiable isolated-
  instance-per-business decision exactly. Does **not** automatically
  solve fleet-wide deployment or cross-instance schema migrations —
  those remain real tooling to build deliberately (see "Office
  Developer Tools" framing) whenever this is actually triggered.
  Runtime code itself needs zero changes to migrate — a user Worker is
  an ordinary Worker script; only the deployment/binding/routing
  mechanism around it changes when the time comes.
  **Decided explicitly 2026-07-11, with real numbers behind it, not
  just "wait for a trigger" in the abstract:** a likely multi-month
  runway with zero real customers means $25/month would accumulate for
  no present benefit. Deferred on cost, not just principle — and
  deferring costs nothing later, since the code doesn't change either
  way. Explicitly not to be built ahead of the trigger: manual
  provisioning becoming an actual bottleneck, or someone needing to
  sign up without a human in the loop at all.
- **A dedicated domain and a separate Cloudflare account for Office
  (2026-07-11).** Real, current migration paths confirmed for each
  real piece: D1 (`wrangler d1 export` → fresh database → `wrangler d1
  execute --file`, genuinely simple), R2 (its S3-compatible API means
  a plain `rclone copy` between old and new bucket, no special
  cross-account tooling needed), Workers AI (account-level, nothing to
  migrate, just enable it), secrets (re-added fresh — a clean
  opportunity to rotate everything properly). One piece flagged as
  genuinely unverified rather than assumed: no confirmed native
  Vectorize cross-account export tool found; the real fallback is that
  Vectorize is explicitly a derived index (not yet load-bearing per
  this document), rebuildable from the real source data already
  sitting in D1/KV if needed. `office.websitehub.co.za` is confirmed
  the real, current production API domain — not preview-only, that's
  the separate `the-office-preview.pages.dev` static client instead.
  A genuinely new, dedicated domain sidesteps the one real complication
  in the account move (Custom Domains/Routes require the Worker and
  the DNS zone to share an account) by becoming its own zone on the
  new account from day one, rather than needing a CNAME workaround
  against the current shared zone.
- **Relational memory: events with multiple participants, not notes
  owned by one entity (2026-07-10).** Surfaced by the ProSupply/Jenny
  bug above — that bug is fixed (a note now attributes to its real
  single subject), but it exposed a real, larger question underneath:
  should the same event ever be visible from more than one entity's
  side? E.g. a late-delivery event should arguably be findable both by
  asking about the supplier AND by asking about the customer whose job
  it delayed. This is a genuine, well-reasoned hypothesis — but nothing
  that's actually happened yet has demonstrated the need for it; today
  a note simply belongs to whichever single entity it's really about,
  and that's honestly sufficient until someone asks about Jenny and is
  missing something that only lives under ProSupply. Held to the same
  bar as everything else here: pinned, not built, until a real gap
  demonstrates it.

  **If and when it's built, the design must NOT be a single
  polymorphic "Entity" table with a type column.** That was explicitly
  proposed and explicitly rejected — it's the exact same shape as the
  `people` table already rejected three times, and it would reopen the
  one thing `characters` exists to structurally guarantee: that a
  personal relation or supplier can never accidentally become billable
  through a bad reconciliation. The safe version of the same idea
  already has a proven precedent in this schema — `line_items` already
  links to *either* `quotation_id` *or* `invoice_id` via a CHECK
  constraint (exactly one non-null, never both), not a single
  polymorphic `document_id`. An `events` + `event_participants` table
  using the identical pattern (`customer_id` or `character_id`, never
  both) gets the real benefit — one event, viewable from either side —
  without reopening that risk. `customers` and `characters` stay
  exactly as structurally separate as they are today.
- **Execution register (2026-07-11).** Rung 1 of the Execution Ladder
  (see that section above for the full reasoning) — a small, generic
  key/value store of Peter's most recent explicit selections
  ("customer" → 42, "task" → 87), read before any deterministic
  matching or AI reasoning is attempted for a vague reference. Not
  session/ephemeral state that needs a decay policy — the selection
  simply *is* whatever was last explicitly named, overwritten the
  moment something new is named, same way a file stays "selected" in
  a desktop UI until something else is clicked. Genuinely useful,
  well-reasoned, not yet built — no real gap has demonstrated it's
  needed yet the way task completion demonstrated deterministic
  candidate-count resolution. When built: generic key/value, not fixed
  nullable columns per entity type, so new departments don't each need
  a schema migration to get a selection slot.
- **Business aliases (2026-07-11).** Rung 4 of the Execution Ladder —
  a stored mapping from a role-style phrase ("the tile guy") to a real
  entity, built from a *previous* clarification so the same question
  is never asked twice. Deliberately not built yet: real conversation
  this session showed Peter's actual phrasing tends to already be
  specific ("James from CTM," "John from Tile Africa"), so generic
  role-matching would have solved a rarer case than the common one.
  Worth building once real, repeated evidence shows Peter actually
  using role-descriptors instead of names — not before. If built, the
  invalidation rule needs deliberate design: an alias learned once
  isn't necessarily permanent (a second tile supplier later would need
  the same phrase to become ambiguous again, not silently keep
  resolving to the first one forever).
- **The full scheduling engine (2026-07-11).** Real reframe worth
  keeping: a calendar answers "what does my day look like," a
  scheduler answers "what needs to happen, and when" — Office needs
  the second one, and a calendar (whenever one exists) is just one
  view over it, the same way Gmail's Inbox is a view over stored mail,
  not the storage itself. The full shape: a generic `schedules` table
  (`trigger_time`, `recurrence`, `target`, `payload`, `status`) that
  can fire a reminder to Peter OR notify a future department ("quarter
  end → Finance → prepare VAT summary"). Genuinely the right eventual
  primitive — but pinned, not built, for two real reasons: (1) it
  would generalize two things — `tasks` (open/done, no due time) and
  `job_scopes.scheduled_date` (a real date, no recurrence) — before
  either has been pressure-tested on its own, the exact premature-
  generalization risk the execution register was deliberately proven
  small before extending; (2) "wakes departments and notifies Peter"
  implies genuine PUSH (a real Cron Trigger or notification channel),
  which is in direct tension with everything else decided this
  session — the embers design ("Peter must guide"), the Ether
  manifesto's own anti-pattern list ("no notifications, it waits for
  him"), and the deliberately-rejected cron-generated briefing. The
  honest, already-proven version stays PULL: "what's up today"
  (2026-07-11) computes live, on request, from real scheduled jobs and
  open tasks — no cron, no push — the same "smallest honest version"
  discipline as the weekly briefing. Real push is a separate, later,
  deliberate decision, not something to fold in by calling it "the
  scheduler."
- **A unique thread/conversation identifier (2026-07-11).** Real
  instinct, checked honestly against every real bug found today
  (register scope-override, `answerFromMemory` dropping facts,
  phantom customer creation, the dog-food leak) — none of them
  actually needed one; all were solved with real timestamps, real
  debug routes, and the real conversation text already in hand. This
  is genuinely distinct from the execution register: the register
  deliberately holds only "the current value per type," overwritten
  the instant something new is named — it has no memory of the
  *sequence* that led there, on purpose. A thread ID would matter the
  moment something needs what the register structurally can't give:
  replaying everything that happened in a real time window,
  independent of which entities were touched, OR a durable server-side
  fallback if client-side `history` transmission ever proves
  unreliable (an app killed mid-conversation, a closed tab) — today,
  multi-turn resolution depends entirely on the client re-sending
  recent turns each request. Neither trigger has actually happened
  yet. Pinned, not built, until one does.
- **Notification Listener (2026-07-11).** A real, distinct Android
  capability — not a WhatsApp feature specifically, its own thing with
  its own weight. With explicit user consent, Office could observe
  incoming notification text from supported apps and offer to act on
  it ("Jenny: 'can you quote the lounge?' → create a quotation task?").
  Deliberately NOT folded into the WhatsApp pivot (Principle 20) as a
  footnote — real, separate privacy and consent considerations, and a
  real, named risk: heavy Play Store scrutiny of anything resembling
  automated interaction with other apps' content, with genuine
  rejection risk if it reads as the app's primary purpose rather than
  a clearly consented, secondary convenience. Worth scoping carefully,
  narrowly, and explicitly if built — not a default assumption.
- **The accounting-capability endgame (2026-07-11): a real P&L.**
  Named explicitly now as the actual destination Finance-department
  work is heading toward, so it's a deliberate roadmap, not an
  assumption quietly baked into every finance-adjacent feature.
  Honest split, checked directly rather than glossed over:
  - **Revenue side — real, working, most of accounts receivable
    already functions:** quotations → invoices → payments is a
    genuine chain, deterministic VAT math, real per-customer and
    business-wide outstanding-balance queries (`getOutstandingInvoices`,
    `getQuotationsSummary`, the Finance ember).
  - **Expense side — does not exist in any form.** No concept of a
    cost anywhere in this schema: no expenses table, no way to record
    what Peter pays out (materials, fuel, supplier invoices, wages),
    no chart of accounts, no income/expense categorization. A P&L is
    revenue minus expenses — today Office can only ever answer the
    first half.
  - Not a reason to hesitate on finance-adjacent work — the register
    wiring for quotations/invoices is worth building regardless of how
    far the P&L destination is — but worth being honest that "building
    toward a P&L" and "the revenue chain already works" are not the
    same claim, and shouldn't be quietly conflated.

## UX vision — the Ether, and what it does / doesn't change (2026-07-10)

A design manifesto ("The Ether") and a business-philosophy vision doc were
reviewed against this file directly, on purpose, to test which parts are
already earned by the real backend and which parts would reopen settled
decisions. Conclusion: **architecture and UX have deliberately been kept
separate throughout this build, and most of the vision holds without moving
architecture at all.**

- **"Askable, not searchable."** Two genuinely different things travel under
  this phrase, and only one is a new capability:
  - *Canonical facts rendered as affordances* ("phone James" → tappable
    contact card, "WhatsApp James" → prepopulated message) is a client
    rendering decision on data that's already correct — `customer_facts`
    already stores `phone_number`/`email`/`address` under closed, consistent
    keys, already normalized via `libphonenumber-js`. No backend work
    implied; this is UI work on top of what already exists.
  - *Conversational, multi-turn retrieval depth* — asking a question, then
    drilling into the answer two or three more turns deep with pronouns and
    references ("who did we deal with in those instances?" / "when was
    that?"). **Proven live 2026-07-10** with the exact scenario named here
    (why don't we buy from ProSupply anymore → who did we deal with → when
    was that), all three hops landing on the correct fact. Not via
    `rewriteQuery`, which this same testing found and replaced — see the
    Extraction schema section above for the real mechanism
    (`resolveFollowUpEntity`) and the five failed attempts that preceded it.
- **Reports/exports on demand** (a conversation compiled into a document)
  are confirmed to be the same category as invoice/quotation PDFs — an
  output layer built on top of retrieval, not a prerequisite for it. Not
  prioritized ahead of retrieval depth itself.
- **The ambient "briefing card" / ambient emotional state (the sigh, red ↔
  green cognitive-load indicator, unprompted "3 things need your
  attention")** was explicitly *not* the same as conversational retrieval —
  it's push, not pull, and it directly re-raised the periodic-briefing
  question already decided against once ("Known gaps": deliberately not
  built as a cron-generated snapshot, named as unearned complexity). Real,
  demonstrated need had been the bar for every other build decision here
  (the receptacle, work observations, `withRetry`, thinking-mode for
  rewrites) — this was the first idea on the roadmap with no such evidence
  and, by its own nature (an ambient/automatic layer), couldn't
  straightforwardly generate the kind of evidence a bug or a lost
  measurement does. Deliberately held apart from "deferred pending
  evidence": deferred pending a real design decision about tone and
  control, to be made on purpose, not backed into. **That decision was
  made 2026-07-10 — see the section immediately below.** Resolved as
  "notification embers," not the original briefing-card shape.

## Architectural pivot: structured answers become navigation, not prose (2026-07-10)

**The core realization.** Every real bug found and fixed today — the
ProSupply subject-attribution errors, the `rewriteQuery` looping saga, the
quotations/invoices topic-mixing, the dog food leaking into Jenny's
file — happened in exactly one place: asking a model to *narrate*
structured business data in prose. The data itself was never wrong.
`answerFromMemory` given a bag of real facts and asked to compose a
paragraph about them will, correctly, include things a person wouldn't —
because "what's relevant to include" is a judgment call, and judgment
calls are exactly where every failure today lived. This isn't a
hallucination problem — nothing was invented, ever. It's an
over-inclusion / composition problem: real facts, wrongly weighted into
prose.

**The reframe.** An office assistant doesn't answer questions — it hands
you the thing you asked for. "How many quotations are pending?" isn't
actually a question needing an essay; it's a request for a list. "Show
me Jenny's invoice" isn't a request for a summary of Jenny; it's a
request to open a specific document. Once a request resolves to
something that already exists as structured data — a register, a
document, a customer summary — the model's job is to *identify which
one*, not describe its contents. The application renders it; the model
never touches the content of what gets shown.

**What this changes.** The entire financial/structured-data surface —
quotation counts, invoice lists, customer dashboards, "show me X" —
moves from prose narration to a closed, typed navigation payload
alongside the existing `message` field:

```
{
  "message": "You have 5 outstanding quotations.",  // always present —
                                                      // the short spoken
                                                      // line, TTS-ready,
                                                      // still fully
                                                      // AI-narrated
  "view": {
    "type": "register" | "document" | "summary" | "contact" | "confirm" | null,
    ...
  }
}
```

`view: null` is the ordinary case — most intake, most small facts, all
personality and conversational narration, unchanged. `view` only appears
when the answer is *fundamentally* one of those closed types. `confirm`
generalizes the existing `pendingActionId`/guard() stamp into the same
family rather than being its own separate field. Not yet built — this is
a designed contract, to be proven the same way everything else here has
been: via debug routes first, real testing, before any client renders it.

**What does NOT change — this is the important boundary.** Intake,
`guard()`, storage, retrieval mechanics, and — explicitly — conversational,
relational retrieval (multi-turn drill-down: "why don't we buy from
ProSupply anymore" → "who did we deal with" → "when was that") stay
exactly as built and proven today. That's *understanding*, not financial
data retrieval, and understanding is the one thing genuinely worth
spending model reasoning on. The pivot is specifically: once understanding
resolves to a request for structured business data, stop narrating it and
navigate to it instead. Conversation-shaped questions stay conversations;
data-shaped requests become navigation.

**"Notification embers" — the UI concept this pairs with, and the actual
resolution of the ambient/emotional-layer question above.** Four
color-coded, glanceable indicators, each a real, deterministic count in a
real bucket — no narration, no editorializing, no synthesized "cognitive
load" score:
- **Red — actions needed.** Real, already-built: the `pending_actions`
  table (guard()-held quotations, invoices, payments, facts). Tap → a
  `register` view of what's actually pending.
- **Blue — reports/documents ready.** Real, already-built as of today:
  real invoices/quotations with real `pdfUrl`s. Tap → a `register` of
  real documents.
- **Yellow — calendar.** Does NOT exist yet. `job_scopes.scheduled_date_raw`
  is a raw, unparsed text field today, not a queryable date. Real
  plumbing would be needed before this ember means anything.
- **Green — to-do list.** Does NOT exist yet. No task/to-do entity with a
  done/not-done state exists — `personal_note`/life events are narrative
  facts by date, not checkable items. Also needs real plumbing first.

Red and blue are a rendering layer on data that's already correct and
tested; yellow and green are new, unearned plumbing and shouldn't be
assumed equally close just because the four embers look symmetric in a
mockup.

**Why this resolves the ambient layer question rather than reopening it.**
The original risk, named directly: the system narrating unprompted
judgments about Peter's state ("you've accomplished something today,
chill"). Embers never do this. They report a real count; Peter supplies
100% of the interpretation. The system never asserts anything about his
cognitive load, never weights one bucket's urgency against another's,
never pushes. Pierre was explicit: "it has to be self-guiding, Peter must
guide" — the system does not editorialize what's shown, only shows what's
real and lets Peter decide what it means. That constraint is what makes
this the safe version of the idea that was deliberately parked, not a
second ambient feature sitting alongside a still-deferred one.

**One real open technical question, not yet resolved:** does document
generation stay synchronous (today's behavior — confirm a quotation, the
PDF exists immediately, in the same response that would light the ember)
or does "turns blue when ready" imply something that can take real
background time, requiring an async/notify mechanism that doesn't exist
in this architecture at all right now? These are genuinely different
builds. Not decided yet — flagged so it isn't silently assumed either way
when this gets built.

## The Execution Ladder: AI extracts and narrates, it never matches (2026-07-11)

**The principle, stated as plainly as possible:** the AI's job is
exactly two things — decode what Peter said into a structured intent,
and narrate the outcome back in plain language. Everything in between
— figuring out *which* customer, *which* task, *which* document a vague
reference actually means — belongs to deterministic code, never to a
model's judgment. Not because the model can't do it. Because it
shouldn't have to, and because a system of record shouldn't guess.
Accounting software doesn't guess which invoice you meant. Neither
should this.

**How this was arrived at, because the reasoning matters as much as
the rule.** `resolveTaskCompletion` was originally built as an AI call
— hand Kimi the list of open tasks, ask it to judge which one a vague
completion phrase ("called them") referred to. It worked in testing.
Real conversation surfaced the actual problem: with two genuinely
similar open tasks and zero disambiguating language, this design was
*asking the AI to do exactly the kind of judgment call that should be
refused, not attempted*. Working through a Gmail analogy exposed the
real distinction: Gmail's zero-ambiguity comes from an explicit
selection event (a click); Office's equivalent selection event is
Peter's own words — "show me Jenny" *is* the selection, the same way a
click is. Once that's true, there's no reason the system should ever
re-derive "what's this about" through AI reasoning when a
deterministic, inspectable answer already exists or can be computed.

**The ladder itself, in resolution order:**
1. **Execution register / current selection** — whatever was most
   recently and explicitly named by Peter (a customer, a quotation, an
   invoice, a task). Not yet built — see Pinned Ideas below.
2. **Exact ID** — if the reference is already a real ID, resolve
   directly.
3. **Exact name / real substring or token match** — deterministic
   string matching against real stored data (proven live: word-token
   overlap with light stemming, not naive substring containment,
   which was tried first and found to under-match "called" against
   "call").
4. **Business aliases** — a stored mapping ("the tile guy" → a real
   supplier) built from a *previous* clarification, so the same
   question is never asked twice. Not yet built — see Pinned Ideas.
5. **Deterministic candidate count** — 0 real candidates means nothing
   to act on, say so; exactly 1 means that's the only possible
   referent, resolve without even needing to match; 2+ means present
   the real candidates.
6. **Ask Peter** — the only fallback, ever. There is deliberately no
   step 7. No "AI guess" rung exists on this ladder, and none should
   be added.

**What "ask Peter" actually is, precisely, so it doesn't quietly grow
back into reasoning:** code decides *that* clarification is needed and
*which* real candidates exist (steps 3–5 above); phrasing that into
"did you mean X or Y?" is plain string joining, not a model call. If a
future version wants friendlier phrasing via the AI, that phrasing
must never be handed the decision of *which* candidates to include —
only the job of saying it naturally. Extraction and narration are the
only two seats the AI ever occupies in this pipeline; matching is not
a third seat with a friendlier name.

**Proof this works, not just theory:** `resolveTaskCompletion` was
rebuilt as pure deterministic logic — zero AI calls, verified directly
in Node before ever touching production (see bug #20 above for the
real bug the rebuild itself surfaced and how it was fixed). The
"called them" test case, with two genuinely similar open tasks and no
disambiguating language, now correctly asks rather than guesses —
identical behavior to the AI-matching version, at a fraction of the
cost, with zero risk of a silent wrong guess.

**What's real today vs. what's designed but not built:**
- Real: deterministic candidate-count resolution (rungs 5–6) for task
  completion. This is the actual, working instance of the ladder.
- Not yet built: the execution register (rung 1) and the alias table
  (rung 4) — both well-reasoned, both genuinely useful, neither yet
  earned by a demonstrated need the way task completion was. Pinned,
  not built — same discipline as everything else in this file. If and
  when the register is built, it should be a small, generic key/value
  structure ("selections: customer→42, task→87"), not fixed nullable
  columns per entity type — new departments (marketing, tender,
  cybersecurity) shouldn't each require a schema migration to get a
  selection slot.
- A real open risk on aliases, worth deciding on purpose whenever
  they're built: an alias learned once ("the tile guy" → John) isn't
  necessarily permanent truth — if Peter later works with a second
  tile supplier, the same phrase needs to become ambiguous again, not
  silently keep resolving to John forever. Not a reason not to build
  aliases; a reason to design their invalidation rule deliberately
  rather than assume permanence.

## Real infrastructure quirks worth remembering

- Vectorize had one real, unexplained processing stall (matched an
  independent bug report from an unrelated user online) — recovered by
  deleting and recreating the index. `/debug/memory-health` exists to
  catch this going forward, though it has a known flaw: it can't yet
  distinguish "genuinely stuck" from "just no new writes recently."
- `office-api`'s first-ever npm dependency (`pdf-lib`) required adding
  an explicit `npm install` step to the deploy workflow —
  `wrangler-action`'s automatic package-manager detection isn't
  guaranteed to work correctly without a lockfile already present.
- The Cloudflare zone has three overlapping route patterns
  (`websitehub.co.za/*`, `*.websitehub.co.za/*` → `wh-build`/TenderLogix;
  `office.websitehub.co.za/*` → `office-api`) — subdomain-specific
  routing correctly takes precedence; confirmed directly via the
  Cloudflare API, not assumed.
- **`worker/src/index.ts` has grown large enough that inline `curl -d`
  pushes to the GitHub Contents API fail** with "Argument list too
  long." Fixed by writing the JSON payload to a temp file and using
  `--data-binary @file` instead of an inline `-d` argument. Any future
  session pushing to this file should use the file-based method from
  the start.
- **Claude's own sandbox has no direct network access to
  `office.websitehub.co.za` or the Cloudflare API** — confirmed
  directly (a self-attempted curl returned "Host not in allowlist").
  Every real test against the live system has to be run by Pierre and
  pasted back; Claude constructs exact commands but cannot execute
  them itself. `api.github.com` *is* reachable from the sandbox,
  which is how code pushes and `STATUS.md` itself get read/written
  directly.
- Cloudflare's own D1/Workers AI APIs occasionally hang on an
  individual request, unrelated to load — always resolved cleanly on
  a plain retry with a timeout added (`curl -m`). Treated as a known,
  low-frequency quirk, not a pattern requiring architectural response.
