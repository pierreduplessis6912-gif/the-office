# The Office — Current State

**Last verified: 2026-07-17.** This is the authoritative "where things
actually stand" document, restructured this session after external
review found real, verified staleness (the header alone was six days
behind its own content). If it disagrees with a memory of a past
conversation, trust this file — it's meant to be kept current;
conversation summaries aren't.

**This document now covers only current state and active reference —
the *what*.** Rationale, rejected alternatives, philosophy essays, and
the full historical bug-by-bug log now live in `DECISIONS.md` — the
*why*, which decays far slower and doesn't need to compete with
today's real state for a reader's attention. Both files are real,
both are authoritative for what they cover; neither duplicates the
other on purpose.

**Current frontier: Layer 2 (Project — relationship assembly) is
genuinely earned to begin, not yet started.** Layer 1 (Constitution
Principle 28 — retry safety, direct-area extraction, symmetric pricing
attachment) is resolved and proven live, most recently with a real,
correctly-calculated R9,000 quotation running the full chain end to
end. See `DECISIONS.md` for the full reasoning and the complete,
archived bug history behind that conclusion.

**Real, active constraints, current as of this verification:**
- **Auth is real, not a stub** — Google OAuth (`/auth/google/login`,
  `/auth/google/callback`, `/auth/me`, `/auth/logout`), a real
  `memberships` table (Owner, Installer, Accountant roles defined),
  and Principle 26 (permission-aware synthesis) proven live on the
  financial lookup path specifically. Not yet threaded through every
  synthesis path — see Known Gaps below for exactly which ones remain
  full-access regardless of asker.
- **No session still defaults to full (Owner-equivalent) access** —
  safe only because Peter is currently the sole real user; must be
  closed before a real second person with genuinely restricted access
  uses the live system.
- **No longer single-instance — a real, second, genuinely isolated
  Office exists** (2026-07-20). Zululand Flooring now has its own
  separate D1, R2, KV, Vectorize, domain, and secrets — created
  entirely by the DIY provisioning workflow, not by hand, and verified
  live: `/health`, `/debug/smoke-test`, and the real Owner membership
  all confirmed correct on the new instance independently. The
  original sandbox remains the current one, still used for continued
  testing; Zululand Flooring is the first real business instance. See
  DECISIONS.md for the full arc, including four real bugs found only
  by actually running the pipeline live.
- **Principle 26 now covers the real, live voice-upload endpoint too**
  (2026-07-17) — `resolveCapabilities` wired in, matching
  `/messages/text` exactly. `/debug/reprocess` deliberately left on
  the default — a debugging tool, not a real production entry point.
  **Retry safety is a separate, different concern, and it's still
  genuinely open for voice input** — neither voice-upload route
  accepts an idempotency key yet, unlike `/messages/text`.

**Constitution principles cited below, indexed for a reader who only
has this file:** 1 (deterministic-first), 2 (low-stakes AI judgment is
acceptable, high-stakes never is), 16 (Immutable History), 19 (Silence
Is Success), 20 (One Office, Many Doors), 22 (Capabilities Emerge From
Captured Reality — the receptacle), 23 (A Worker Owns a Primitive), 24
(The Execution Ladder / Share What's Known), 25 (The Interface
Disappears), 26 (Permission-Aware Answers), 27 (A Network, Not
Modules), 28 (Truth Before Relationship Before Cognition). Full text
for each lives in `OFFICE_CONSTITUTION.md`.

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

- **File structure (2026-07-12), reorganized per Principle 23 ("A
  Worker Owns a Primitive").** `index.ts` had grown to 3,876 lines —
  double a proposed 2,000-line review threshold. The review concluded
  honestly: everything in it still serves exactly one business, one
  deployment, no genuine second caller — so the answer was reorganize
  into real files, not split into separate Workers. Still **one**
  Cloudflare Worker, one deploy, one `wrangler.toml`:
  - `types.ts` — every shared interface (`Env`, `Extraction`,
    `ProcessResult`, etc.), no logic.
  - `ai.ts` — the AI primitive: every place a model is actually
    called (extraction, narration, rewriting, vision, embeddings,
    reranking). No business decisions.
  - `identity.ts` — customers, characters, the execution register
    (`setSelection`/`getSelection`/`getCurrentSelection`).
  - `scheduler.ts` — tasks, real scheduled dates, the ember counts,
    job-scope recording.
  - `memory.ts` — captures (the receptacle), customer/character
    notes, life events, structured facts, Vectorize consolidation.
  - `finance.ts` — the revenue chain and the expense side, guard()'d
    the same way, plus document generation (PDFs, share messages).
  - `index.ts` (1,715 lines remaining) — `processTranscript` (the
    orchestrator/Execution primitive) and `handleRequest` (routing) —
    deliberately NOT further split this pass; splitting the giant
    routing chain carries real risk for no current benefit, unlike
    extracting already-standalone data/logic functions.
  Verified with a full multi-file type-check before pushing (only
  the same pre-existing noise present in every check this session,
  zero new errors), then verified live in production: smoke test
  18/18, a real end-to-end message spanning three modules
  (extraction → identity → finance), and the execution register all
  confirmed working with zero functional regression.
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

**For exact, current columns on any table, `/debug/table-schema?table=X`
is authoritative** — verified directly against the live schema via
SQLite's own `PRAGMA table_info`, never stale by construction the way
a manually-maintained list here would be (and already was — this list
previously omitted `job_scopes.installer_id`, added weeks before the
omission was caught). What stays here is the real reasoning behind
each table's shape, which no introspection route can answer:

- **`customers`** — billed entities. **`characters`** — everyone else
  (installers, suppliers, personal relations) — never referenced by
  commerce tables, structurally, not by convention. See "Why
  `characters` is a separate table" in DECISIONS.md.
- **`line_items`** — a real CHECK constraint enforces exactly one of
  `quotation_id`/`invoice_id`, never both, never neither.
- **`job_scopes`** — `scheduled_date_raw` is the phrase exactly as
  said; `scheduled_date` is the real, resolved calendar date, always
  computed deterministically in code, never by the model.
- **`scope_components`** — `width_mm`/`length_mm` always real
  millimeters; `area_sqm` computed from real converted values in code,
  or accepted directly when stated as a whole total — never from the
  model's raw, possibly-unconverted numbers either way.
- **`customer_facts`** — an EAV holding tier; `key` is closed and
  consistent for phone/email/address, free text for anything
  trade-specific; `value` normalized in code, never by the model.
- **`captures`** — the receptacle (Principle 22). `subject_hint` is a
  loose text name, not a real foreign key — a known, named limitation.
- **`pending_actions`** — the candidate stage, real and proven for
  money and structured facts. See the Patient Prospector discussion in
  DECISIONS.md for where else this pattern may belong.
- **`tasks`** — personal errands only, deliberately separate from
  `pending_actions`' own done-state. Created only by `reminder`,
  closed only by `task_complete`, via fully deterministic word-token
  matching — no AI call anywhere in that step. See "The Execution
  Ladder" in DECISIONS.md.
- **`selections`** — the execution register, rung 1 of the Execution
  Ladder (Constitution Principle 16 / 24). Generic key/value on
  purpose — `key` *is* the type, so a new selection type never needs a
  migration, only new rows. Checked before any AI-based resolution is
  attempted, per Principle 1.
- **`memberships`** — Office × Person × Role, one per Google account.
  See Constitution Principles 25-27 for the full architecture.
- **`idempotency_keys`** — retry safety (Constitution Principle 28).
  `key` is the primary key deliberately — the database itself rejects
  a genuine concurrent duplicate, no application-level lock needed.

**Why work observations are unguarded while everything financial is
guarded:** money changes the outside world; a wrong measurement is a
cheap, easily corrected mistake. `guard()` is reserved for
consequence, not for every write.

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

## Failure shapes (distilled from 38 real bugs — full instances archived in DECISIONS.md)

Eight patterns account for the real majority of bugs found this project, seven recurring independently, one found once but general enough to watch for:

1. **Relevance-filtering silently drops real facts.** `answerFromMemory`'s own "be relevant, be brief" instruction has repeatedly judged a real, correct fact as not worth including — a caveat, a second fact alongside a first, a whole answer to an ambiguous question. Recurred four separate times (bugs 26, 28, 31, 33). **Fix pattern, proven every time:** never trust the model's judgment about what to include — append anything that must survive deterministically, in code, after synthesis.
2. **Subject-attribution: extraction fixates on an incidentally-mentioned name over the real subject.** "ProSupply was late delivering tiles for Jenny's job" is about ProSupply, not Jenny — three related bugs (11, 12, 13) all came from the same root confusion between "who's mentioned" and "who this is fundamentally about." **Fix:** the extraction prompt must ask "who or what is this sentence reporting on," not just which names appear.
3. **A non-null assertion on a branch shared across genuinely different shapes.** `customer!.name` held safely for years of intents genuinely keyed to a customer, then threw the moment a differently-shaped intent (keyed to a character, or genuinely customer-less) reused the same branch (bugs 29, 35). **Fix:** a dedicated branch per genuinely different shape, never a shared assertion papering over a real difference.
4. **A guard or exclusion condition gated on the wrong scope.** Reminder/task_complete content leaking into a customer's own notes because an exclusion only covered some intents, not all (16, 18); the execution register firing on scope conditions it should have respected (22, 25). **Fix:** when a new intent or field is added, every existing code path it could now touch needs auditing, not just the primary one it was built for.
5. **AI asked to perform judgment or matching that should be deterministic.** The foundational discovery of this whole project (bugs 20, 24, arguably 7) — resolving which task, which entity, which record was meant is a matching problem, not a language problem, and asking a model to guess invites exactly the ambiguity a system of record can't afford. See Constitution Principle 24 ("The Execution Ladder").
6. **Assumptions diverging from live reality — schema, infrastructure, a third-party dependency's actual runtime behavior, or a cloud provider's own tooling and permission model.** A TypeScript type change doesn't touch a live `NOT NULL` constraint (37); an `INNER JOIN` silently hides real rows with a `NULL` foreign key from a debug view (38); a PDF-parsing library type-checked and bundled cleanly, then failed at actual runtime inside the real Workers sandbox with an internal bundle-resolution error invisible to any local verification (41); a CLI tool's own output format didn't match documentation, a permission requirement wasn't discoverable from research at all, and the same CLI's `--json` flag worked for one subcommand but not another — all four found only by actually running a real provisioning pipeline live, never by research alone (42-45). **Fix:** verify against the actual live system — a direct query, `PRAGMA table_info`, a real deployed environment, or a real infrastructure run — before assuming. Never reconstruct reality from memory of the code that reads it, and never assume a clean type-check, a clean install, or well-documented tooling means clean runtime behavior.
7. **Segmentation misses a continuation signal and splits a single thought in two.** "Sipho is measuring the hospital *and* theatre one is three by two" split wrongly at "and" (36); "give her 10 percent off *that*" split wrongly at the comma, separated from the exact price "that" refers to (40) — the discount silently vanished as a result. Different linguistic triggers, same underlying miss: a word whose entire function is continuing the previous thought, mistaken for a topic boundary. **Fix:** each real instance becomes an explicit rule and worked example in the splitting prompt — "and," pronoun back-reference, whatever the next one turns out to be.
8. **A parallel storage channel duplicates data without inheriting the gating applied to its primary channel.** Found live 2026-07-17, extending Principle 26: `getCustomerFinancialSummary` was correctly gated behind `can_know_debtors`, but the same financial fact was *also* being duplicated verbatim into an entirely separate, ungated customer note by a completely different code path — proven directly when an Installer session, correctly refused the structured summary, received the identical fact anyway from the note. **Fix:** when gating any data, every path that could independently surface the same underlying fact needs the same gate, not just the one being actively worked on — a genuinely new pattern, distinct from the seven above, worth watching for whenever a second representation of the same fact exists anywhere in the system.

Real, significant one-off findings worth keeping in view even though they haven't recurred: a silent unit-conversion error was off by a factor of a million with total confidence (bug 9) — raw numbers and units are now always reported separately, conversion always happens in code, never asked of the model. Concurrent AI calls via `Promise.all` tripped Workers AI's own capacity ceiling at real scale (21) — regression suites run sequentially now. Open-ended prose generation had no natural stopping point under `thinking: true` and looped indefinitely (14) — replaced with closed-form extraction wherever a specific answer, not an essay, was actually needed.

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

`/debug/split-topics` (POST `{text}`) — real, direct visibility into
what the multi-intent split actually produced for a message, needed
2026-07-13 to diagnose real bugs precisely rather than guess at them
from a combined response. `/debug/find-character`, `/debug/find-
customer` (GET `?name=`) — isolating a name-lookup function from the
whole extraction pipeline, the exact tool that found the real name-
collision bug (#32) by proving the lookup itself was correct before
chasing the bug further downstream. `/debug/table-schema` (GET
`?table=`) — real schema introspection via SQLite's own `PRAGMA
table_info`, the only reliable way to confirm a real constraint before
writing a migration that touches it; guessing a schema from memory of
the code that reads it is exactly how a table-recreation migration
could silently lose a real column.

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

- **Auth is real, and Principle 26 (permission-aware answers) is now
  threaded broadly, not just the financial lookup — reads and writes
  both, proven live 2026-07-17.** Reads: customer-scope lookups
  (financial summary gated by `can_know_debtors`, job profitability by
  `can_know_profit`), character-scope lookups (installer/job activity
  gated by `can_know_jobs`, which Accountant deliberately lacks), and
  business-scope quotations/expenses (`can_manage_invoices` /
  `can_know_materials`). Writes: creating a payment, expense, invoice,
  quotation, or converting a quote to invoice now all require
  `can_manage_invoices` — proven with real evidence both directions,
  Installer honestly refused, Owner unaffected. **A real, second-order
  leak was found and fixed along the way**, not assumed away: narrative
  customer/character notes were duplicating the raw transcript of
  every financial message regardless of role, completely bypassing
  every structural gate — proven directly when an Installer session,
  correctly refused the structured financial summary, was handed the
  identical fact anyway from a note. Fixed by excluding any intent with
  its own structured storage from the raw-note fallback. **What's
  still genuinely open:** HR facts (role, skill, license) and
  customer/character identity facts (address, phone) remain ungated on
  both read and write — no established capability line exists for
  either yet, and inventing one speculatively would violate Principle
  22's own discipline. No session still defaults to full
  (Owner-equivalent) access, safe only because Peter remains the sole
  real user today. CORS remains wide open, no rate limiting exists —
  low urgency for a genuinely single-user system, the same underlying
  gap as the above, not a separate one.
- **No longer single instance.** This was explicitly one Office per
  business entity with no exception; a second real entity meant a
  second, genuinely isolated Office instance, not a schema change —
  now proven true, not just designed. Zululand Flooring's own real,
  separate instance exists, created by the DIY provisioning workflow
  and verified live. See DECISIONS.md for the full arc, including four
  real bugs found only by actually running the pipeline.
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
  PDF routes). **Correcting a stale claim found 2026-07-17:** the
  WhatsApp-ready message generator is not missing — `buildDocumentResponse`
  already produces a real `shareMessage` on every quotation and invoice
  confirmation, verified directly in the code across all three confirm
  paths. What's genuinely still missing is only the Android-side Share
  Sheet in/out wiring itself (native, out of scope for backend-only
  work).
- **GPS/location customer detection:** proven *possible* — D1
  genuinely supports the trig functions needed for real Haversine
  distance math (verified live), and TenderLogix already has
  substantial, reusable Google Places integration — but raw-GPS-to-
  address reverse geocoding specifically is not built anywhere yet.
- **Invoice line items now support a real, deterministic per-line
  discount** (2026-07-17) — `discount_percent`, extracted directly
  (transcription, not arithmetic), the actual discounted total always
  computed in code. Proven live end to end: a stated "10 percent off"
  on an R8000 line item produced a real, correctly-calculated R7,200
  quotation, verified directly against the raw stored payload, not
  just the summary message. Shown on generated PDFs as a clear
  annotation next to the description. Still genuinely missing: no
  per-invoice VAT override (only a business-wide toggle exists), no
  retention field.
- **PDF text extraction is now real and proven live** (2026-07-19) —
  `pdfjs-serverless`, real text pulled directly out of a real PDF
  (Office's own generated quotation, round-tripped: downloaded,
  re-uploaded, extracted correctly). A real, live runtime failure was
  found and fixed along the way: `unpdf`'s own convenience wrapper
  type-checked and bundled cleanly but failed at actual runtime with a
  bundle-resolution error — a genuinely runtime-only failure no local
  verification could have caught. Fixed by switching to the lower-
  level, zero-dependency package `unpdf` itself wraps, avoiding
  whatever dynamic resolution step was failing. A genuine parse
  failure and a scanned PDF with no real text layer are handled as two
  distinct, honest outcomes. **PDF generation itself:** still
  text-only, no business logo embedded yet — and the extraction test
  incidentally surfaced a small, separate, real gap: generated PDFs
  currently show "[Business name not set]" since no business name is
  configured anywhere yet.
- **Weekly/periodic briefing:** deliberately NOT built as a
  cron-generated pre-computed snapshot — identified as unearned
  complexity. The "smallest honest version" (on-demand personal/
  business lookup, computed live) is what exists.
- **Correcting a significant stale claim found 2026-07-17: tasks
  already have a real link to customer/character, fully built and
  working end to end, not missing.** `createTask` accepts and stores
  real `customer_id`/`character_id` (same one-of-the-two-never-both
  pattern already proven for `captures`), populated with the real,
  reconciled IDs at creation time — verified directly in the code, not
  assumed. `getOpenTasks` returns both fields on read. What's
  genuinely still missing, and the only real gap here: the ember bar's
  own UI only shows counts and a plain list today — no per-item
  `[Call]` action exists to actually *use* the link that's already
  there. The backend prerequisite this action needs has existed since
  2026-07-11; only the UI action itself was ever missing.
- **Tasks have no due/scheduled time at all**, only open/done. A
  `[Reschedule]` action on a task needs exactly the due-time concept
  the full scheduler (pinned, not built — see DECISIONS.md) would add.
  Deliberately not smuggled in early just to make one ember-bar button
  real.
- **No weather integration** — a completely new kind of gap versus
  Tasks/Scheduler/Finance, which are all real internal data already.
  Needs a genuine external API dependency that's never been discussed
  or evaluated anywhere in this project. Not stubbed, not estimated.

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


## See also

`DECISIONS.md` — architectural rationale, rejected alternatives, pinned philosophy, and the complete, unabridged bug history behind the failure-shapes above. `OFFICE_CONSTITUTION.md` — the full text of every principle cited in this document.
