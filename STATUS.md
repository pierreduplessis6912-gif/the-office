# The Office — Current State

Last updated: 2026-07-08. This is the authoritative "where things actually
stand" document. If it disagrees with a memory of a past conversation,
trust this file — it's meant to be kept current; conversation summaries
are not.

## Philosophy (proven over two real build sessions, not aspirational)

- **The API is the Office.** Every client — this Flutter app, the free
  web preview, a future WhatsApp integration, email — is just a window
  into the same backend. Nothing business-critical ever lives in a
  client.
- **guard():** every consequential write — payments, invoices,
  quotations, quote conversions, and (as of today) structured customer
  facts like address/phone — holds in `pending_actions` until a human
  explicitly confirms it. Nothing financial or identity-altering writes
  itself automatically.
- **No LLM arithmetic, ever.** Line totals, VAT, deposit splits, "who
  owes me money" — all computed deterministically in code from real
  stored numbers. The model's job is to identify *what was said*, never
  to calculate anything from it.
- **Every real AI call is wrapped in `withRetry`.** Real evidence
  2026-07-09: multiple genuine transient failures, every one succeeding
  cleanly on a plain retry seconds later. Any new function that calls
  `env.AI.run(...)` for anything user-facing must wrap the call the
  same way — see `withRetry` near the top of `index.ts`. The two
  `/debug/*` diagnostic routes that deliberately call the model raw,
  unwrapped, are the sole intentional exception, since they exist
  specifically to show unmodified behavior.
- **Build only what's earned by real evidence.** Every non-trivial
  piece here exists because a real test or a real failure demanded it,
  not because it seemed like a reasonable feature to add. This is the
  single most load-bearing habit in this project — it's what caught
  two genuine data-integrity bugs on 2026-07-08 alone (see below).
- **Five-domain lens** (Communication / Knowledge / Activity / Commerce
  / Governance) is a categorization tool for deciding whether a new
  idea belongs in this system at all — not a checklist demanding equal
  development across domains. Most of what exists today is
  Communication, Knowledge, and Commerce; Activity is real but unbuilt
  (see Pinned Ideas).

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
- R2 (`office-vault`) stores raw voice-note audio.
- `pdf-lib` (the Worker's first-ever real npm dependency) generates
  real invoice PDFs server-side — pure JS, no native code, runs
  directly in the Workers isolate.

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
                 -- exists, not yet exercised by any real flow
customer_facts   (id, customer_id, key, value, source_transcript, created_at)  -- EAV holding tier
pending_actions  (id, type, payload, status, source_transcript, created_at, resolved_at)
                 -- types in use: payment, invoice, quotation, convert_quote, customer_fact, schema_candidate
pending_memory_flush (id, customer_id, text, created_at)  -- staging queue, KV -> Vectorize
memory_errors    (id, customer_id, text, error, created_at)  -- durable log for background-write failures
business_profile (id fixed=1 via CHECK, name, trading_as, vat_no, address, phone, email, website,
                  banking_details, vat_registered, vat_rate)
                 -- real seeded data: Zululand PPE and Industrial Supplies / Zululand Flooring and Blinds
```

**Why `characters` is a separate table, not a `type` column on
`customers`:** the entire safety property — that a personal relation
can never accidentally touch an invoice or "who owes me money" — comes
from it being structurally impossible, not from application-code
discipline. A polymorphic `people` table with a nullable `customer_id`
would reopen exactly the class of bug `guard()` exists to prevent.
Deliberately rejected once already; don't reintroduce without a real
reason.

## Extraction schema (`Extraction` interface, `extractIntent`)

```
customer_name, character_name, character_relationship,
intent: payment | invoice | quotation | convert_quote | lookup | reminder | note | other,
amount, fact_key, fact_value, personal_note,
query_scope: customer | character | personal | business | null,
deposit_percent
```

Runs on **Kimi K2.6** (`chat_template_kwargs.thinking: false`,
`temperature: 0`) — proven superior to a smaller model via a real
head-to-head test (5/5 correct vs. 1/5, zero curated examples needed).
Query rewriting (pronoun/reference resolution using recent
conversation history) and answer synthesis also run on Kimi for the
same reason — the small model repeatedly failed subtle instruction
constraints ("resolve the reference, don't answer the question") even
after two prompt-wording attempts.

## Models in use

- `@cf/moonshotai/kimi-k2.6` — extraction, query rewriting, answer synthesis
- `@cf/openai/whisper` — voice transcription
- `@cf/baai/bge-base-en-v1.5` — embeddings
- `@cf/baai/bge-reranker-base` — reranks Vectorize results (real scores
  are ~0.0005 scale, NOT 0–1 — trust relative ranking + top-N, never an
  absolute threshold)

## Real bugs found and fixed on 2026-07-08 (worth remembering the shape of)

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

## Debug routes (deliberately left in during this experimentation phase)

`/debug/list-audio`, `/debug/reprocess`, `/debug/search-memory`,
`/debug/customer-notes`, `/debug/life-events`, `/debug/memory-errors`,
`/debug/memory-health`, `/debug/stress-memory`, `/debug/rerank-raw`,
`/debug/smoke-test`, `/debug/pdf-route-test`, `/admin/flush-memory`.

**Strip all of these before any real customer data flows through.**

`/debug/smoke-test` is the actual regression safety net — 9 real
classification test cases, zero side effects (tests `extractIntent`
in isolation, never writes to KV or D1), safe to rerun after every
single future change. Run it after anything touches `index.ts`.

## Free iteration loop

Web preview: `https://the-office-preview.pages.dev` — built via GitHub
Actions + Cloudflare Pages, zero Codemagic minutes. Type-mode is fully
real (talks to the live backend). The mic does not work on web —
confirmed, not a bug: `path_provider` has no web implementation, and
this is a genuinely native-only capability. Only spend a real Codemagic
build once a batch of UI changes is settled.

## Known gaps, deliberately deferred (named on purpose, not forgotten)

- **Auth:** `/auth` is a bare 501 stub. No multi-user, no
  multi-tenancy — this is explicitly one Office per business entity; a
  second real entity means a second Office instance, not a schema
  change.
- **App-side lag behind the backend:** the Flutter app does not send
  conversation history yet, so the query-rewriting fix is proven and
  working but currently unreachable through the real app — only via
  curl/the web preview. No tappable document-card UI exists yet for
  the `pdfUrl` the API already returns on invoice confirmation.
- **WhatsApp:** a real Evolution API number exists from earlier work;
  no read/reply pipeline is built. Real platform constraint to design
  around: WhatsApp enforces a 24-hour free-messaging window per
  contact without a pre-approved template.
- **GPS/location customer detection:** proven *possible* — D1
  genuinely supports the trig functions needed for real Haversine
  distance math, and TenderLogix already has substantial, reusable
  Google Places integration — but raw-GPS-to-address reverse geocoding
  specifically is not built anywhere yet.
- **Invoice line items:** no `discount_percent` field yet (deliberately
  deferred — prove basic multi-line totaling first). No per-invoice
  VAT override (only a business-wide toggle exists). No retention
  field.
- **PDF:** text-only, no business logo embedded yet.
- **Weekly/periodic briefing:** deliberately NOT built as a
  cron-generated pre-computed snapshot — that was identified as
  unearned complexity. The "smallest honest version" (on-demand
  personal/business lookup, computed live) is what exists.

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

