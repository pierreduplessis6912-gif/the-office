# The Office — Current State

Last updated: 2026-07-10. This is the authoritative "where things actually
stand" document. If it disagrees with a memory of a past conversation,
trust this file — it's meant to be kept current; conversation summaries
are not.

## Philosophy (proven over four real build sessions, not aspirational)

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
job_scopes       (id, customer_id, description, scheduled_date_raw, source_transcript, created_at)
                 -- scheduled_date_raw is the phrase exactly as said ("next Thursday") — deliberately
                 -- never resolved into a real date; that's genuine future work, not done yet
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
allowed to invent new ones). Same reasoning as `rewriteQuery` and
`answerFromMemory` being their own steps — one job per call.

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

**Query rewriting runs with `chat_template_kwargs.thinking: true`**
(the one deliberate exception to `thinking: false` elsewhere) —
proven necessary twice: once for basic reference resolution, and again
2026-07-09 when a *second*, more subtle bug surfaced — resolving a
pronoun correctly required weighing *recency* against *frequency* of
mention, which the model only got right when allowed to reason
step-by-step, confirmed via a direct side-by-side comparison with real
reasoning traces as evidence, not assumption.

## Models in use

- `@cf/moonshotai/kimi-k2.6` — extraction, query rewriting (thinking
  enabled), answer synthesis, image description (confirmed to support
  vision input)
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

## Debug and diagnostic routes

`/debug/list-audio`, `/debug/reprocess`, `/debug/search-memory`,
`/debug/customer-notes`, `/debug/life-events`, `/debug/memory-errors`,
`/debug/memory-health`, `/debug/stress-memory`, `/debug/rerank-raw`,
`/debug/smoke-test`, `/debug/captures` (supports `?status=` filter to
revisit unprocessed captures as a batch), `/debug/job-scopes`,
`/debug/quotations`, `/debug/invoices` (both real, verified 2026-07-10
while proving price_scope end to end — each shows line items directly,
not just the summed total, since a right total can hide a wrong line),
`/debug/kv-set` (generic KV write-back, the counterpart to
`/debug/customer-notes` GET — POST `{key, value}`) and
`/debug/delete-customer?id=` (scoped: deletes the customers row, its
KV notes, and any pending_memory_flush entries — not a general SQL
executor). Both earned live 2026-07-10 correcting real data a
subject-attribution bug had polluted, not built ahead of need — kept
because the same class of correction will likely be needed again.
`/debug/rewrite-thinking-test` (served its diagnostic purpose already
— safe to remove), `/debug/pdf-route-test` (leftover from a routing
diagnosis — safe to remove), `/admin/flush-memory`.

**Strip all debug/admin routes before any real customer data flows
through production.** `/files/audio`, `/files/photo`, `/messages/text`,
and `/actions/*` are real, production routes — not debug — and stay.

`/debug/smoke-test` is the actual regression safety net — 14 real
classification test cases as of 2026-07-10 (grew from 11), zero side
effects (tests `extractIntent` in isolation, never writes to KV or
D1), safe to rerun after every single future change. **Note:** it
fires its cases concurrently — a real, observed cause of transient
`extraction: null` failures unrelated to actual code correctness. If
it fails, check the `rawOnFailure` field on failing cases and retry
once before concluding there's a genuine regression.

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
  ever changes).
- **Document/PDF capture — the third "sense" — is still completely
  untouched.** Voice and photos are both real; there's no upload path
  for a supplier quote, an existing invoice, or a scanned form yet.
- **`captures.subject_hint` is a loose text string, not a real foreign
  key.** "Show me every capture about Jenny" would need a fuzzy text
  match today, not a clean join.
- **No tappable document-card UI** for the `pdfUrl` the API already
  returns on invoice confirmation — the URL is real and correct;
  nothing in the app surfaces it as something to tap yet.
- **WhatsApp:** a real Evolution API number exists from earlier work;
  no read/reply pipeline is built. Real platform constraint to design
  around: WhatsApp enforces a 24-hour free-messaging window per
  contact without a pre-approved template.
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
  standard per-request/CPU billing beyond that. Solves compute
  isolation and routing between businesses natively — proven at real
  scale by Cloudflare, not something to build custom. Does **not**
  automatically solve fleet-wide deployment or cross-instance schema
  migrations — those remain real tooling to build deliberately
  (see "Office Developer Tools" framing) whenever this is actually
  triggered. Runtime code itself needs zero changes to migrate; only
  the deployment/binding/routing mechanism around it changes.
  Explicitly not to be built ahead of the trigger: manual provisioning
  becoming an actual bottleneck, or someone needing to sign up without
  a human in the loop at all.
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
    that?") — is the same mechanism `rewriteQuery` already proves necessary
    for single-hop resolution (the recency-vs-frequency bug, 2026-07-09),
    extended to real depth. **This is now the next priority to prove out**,
    ahead of new features: a real multi-turn smoke-test scenario (modeled on
    a "why don't you buy from us anymore" / follow-up / follow-up rep
    conversation), run the same disciplined way as the existing 11-case
    `/debug/smoke-test`, to find where depth actually breaks before building
    anything new to fix it.
- **Reports/exports on demand** (a conversation compiled into a document)
  are confirmed to be the same category as invoice/quotation PDFs — an
  output layer built on top of retrieval, not a prerequisite for it. Not
  prioritized ahead of retrieval depth itself.
- **The ambient "briefing card" / ambient emotional state (the sigh, red ↔
  green cognitive-load indicator, unprompted "3 things need your
  attention")** is explicitly *not* the same as conversational retrieval —
  it's push, not pull, and it directly re-raises the periodic-briefing
  question already decided against once ("Known gaps": deliberately not
  built as a cron-generated snapshot, named as unearned complexity). Real,
  demonstrated need has been the bar for every other build decision here
  (the receptacle, work observations, `withRetry`, thinking-mode for
  rewrites) — this is the first idea on the roadmap that has no such
  evidence and, by its own nature (an ambient/automatic layer), can't
  straightforwardly generate the kind of evidence a bug or a lost
  measurement does. Pierre named the real risk directly: this could land as
  invasive or dictatorial if built wrong. **Deliberately held apart from
  "deferred pending evidence": this is deferred pending a real design
  decision about tone and control, to be made on purpose, not backed into.**

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
