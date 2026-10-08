# The Office — Decisions, Rationale & Philosophy

This file holds the *why* — architectural rationale, rejected
alternatives with their reasoning, pinned philosophy not yet built,
and the complete, unabridged history of every real bug found and
fixed. It decays far slower than `STATUS.md` (the *what* — current
state, active reference) and doesn't need to compete with today's
real state for a reader's attention. Both files are authoritative for
what they cover.

Split out 2026-07-17 after external review found `STATUS.md` had grown
to 67% the size of the entire production codebase, with its most
decay-prone content (routes, schema, environment quirks) interleaved
with its most durable (rationale, rejections, philosophy) at the same
priority. Nothing here is less real or less authoritative than
`STATUS.md` — it's simply the content that ages on a different clock.

## Why `characters` is a separate table, not a `type` column on `customers`

The entire safety property — that a personal relation can never
accidentally touch an invoice or "who owes me money" — comes from it
being structurally impossible, not from application-code discipline.
A polymorphic `people` table with a nullable `customer_id` would
reopen exactly the class of bug `guard()` exists to prevent.
Deliberately rejected once already; don't reintroduce without a real
reason. The same `tenant_id`-style temptation has resurfaced from
AI-generated documents on three separate occasions — treat any
document proposing shared/polymorphic structure with real suspicion.

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
    `getQuotationsSummary`, the Finance ember). Real, exportable
    statement of account per customer added 2026-07-12
    (`getCustomerStatementData` — chronological transactions, a real
    running balance; `generateStatementPdf` — a genuine PDF export,
    verified live against Jenny Hawke's real invoices and payments).
  - **Expense side — real capture started (2026-07-12), one record
    deep, now its own ember bucket too** (kept separate from Finance
    deliberately — opposite direction of money). A bare `expenses`
    table (`character_id`, `amount`, `description`, `source_transcript`)
    and a real `expense` intent ("bought glue for R850 at BUCO"),
    guard()-confirmed same as every other money-touching intent.
    Deliberately still missing: no chart of accounts, no expense
    category, no VAT extraction, no job-cost linking. The gap from
    here to an actual P&L is still real — this is progress, not the
    finish.
  - **First combined view of both sides, 2026-07-12:**
    `getFinancialSnapshot` — total invoiced, total actually received,
    total spent, and a rough cash-basis position, honestly labeled as
    NOT a full P&L (no categorization or job-cost linking exists yet
    to make that claim). Wired into genuinely general business
    questions only, verified live with real numbers spanning both
    sides.
  - **Aged debtors analysis — real, built, exportable (2026-07-12).**
    `getAgedDebtorsReport` buckets real outstanding balances by real
    invoice age (current / 30-60 / 60-90 / 90+ days), verified live
    with real numbers. Genuine, disclosed limitation, not silently
    assumed away: payments in this schema link only to a customer,
    never to a specific invoice, so which invoice a payment actually
    settled can't be known with certainty — FIFO allocation (oldest
    invoice paid first) is applied deterministically in code, and
    stated directly on the exported PDF itself, not buried in a
    footnote. `generateAgedDebtorsPdf` — real, exportable, same visual
    family as invoices/quotations/statements. Confirmed working
    correctly both ways: a narrow question ("who owes me money") gets
    a narrow answer without the aging detail dragged in; a specific
    request for the breakdown gets the full aging picture — the
    relevance-filtering fix from earlier in this document working as
    intended, verified rather than assumed.
  - **Expense categories — real, built (2026-07-12).** A closed set
    (materials/fuel/tools/subcontractor/other), classified at confirm
    time by `classifyExpenseCategory`, same shape as
    `classifyBusinessTopic` — the real prerequisite for eventually
    distinguishing cost of sales from operating expenses. Uncovered a
    genuinely serious bug in the process (see bug #30): expenses with
    no named supplier were silently vanishing entirely, with no record
    and no error — fixed, verified live alongside the category feature
    in the same test.
  - **Job-cost linking — real, built, verified live (2026-07-12).**
    `expenses.customer_id` links a cost to the job it was actually for,
    genuinely distinct from `character_id` (who was paid) — no
    ambiguity risk, since an expense never invoices anyone.
    `getJobProfitability`: real revenue invoiced against a customer
    minus real expenses explicitly linked to that job, verified live
    (Jenny's job: R13,664 revenue, R420 linked cost, R13,244 profit,
    correct arithmetic). Honest about its own limitation, and the
    honesty is now guaranteed rather than left to chance: the caveat
    (only explicitly-linked expenses count) used to be baked into one
    fact string handed to the model, which reliably stripped it out
    during synthesis, twice in a row, live. Fixed by splitting the
    return so the caveat is appended deterministically in code — never
    a fact for the model to weigh and possibly drop, same fix pattern
    as the aged-debtors capability hint.
  - **The formal profit-and-loss statement — real, built, verified
    live with exact correct arithmetic (2026-07-12). The roadmap's
    original destination, honestly reached.** `getProfitAndLoss` /
    `getProfitAndLossSummary`: real accrual-based revenue (invoiced,
    not paid — a genuinely different, explicit convention from the
    cash-basis snapshot, stated directly rather than left ambiguous),
    real Cost of Sales vs Operating Expenses split (materials/
    subcontractor vs fuel/tools/other/uncategorized), named explicitly
    as a reasonable convention, not an infallible standard.
    `generateProfitAndLossPdf` — real, exportable, same visual family
    as the other three reports. Verified live: Revenue R40,114 − Cost
    of Sales R420 = Gross Profit R39,694; minus Operating Expenses
    R1,500 = Net Profit R38,194 — every figure checked and correct,
    traceable back to three real expense rows and real invoices, none
    of it estimated or narrated by the model. A single "how are we
    doing financially" question now correctly synthesizes cash
    position, formal P&L, outstanding debtors, aged breakdown,
    per-customer detail, and category breakdown together into one
    coherent, well-organized answer — everything built across this
    entire roadmap working together, not just individually. This
    closes the accounting-capability roadmap pinned 2026-07-11: every
    number in that answer traces back to a real row in a real table.
- **Guide — a dissatisfaction-triggered capability-discovery layer
  (2026-07-12).** Real, sharp diagnosis, and not hypothetical — it
  named a failure that had already happened live in this exact
  session: "who owes me money?" answered correctly, but the aged
  breakdown only surfaced once the exact phrasing was given
  explicitly. Proposed mechanism: detect dissatisfaction ("that's not
  what I meant," a follow-up implying the answer was insufficient),
  then surface nearby capabilities by name, never by teaching magic
  phrasing. Pinned, not built — the dissatisfaction-detection trigger
  itself is a real, unsolved classification problem (distinguishing
  "that's not what I meant" from an unrelated new question), and nothing
  today demonstrates it's needed beyond the one real, narrow case
  already handled below with the smaller, static registry instead.
- **Behavioral Preferences — deterministic, worker-maintained
  workflow learning (2026-07-12).** Real, well-reasoned design (observe
  before suggesting, real occurrence thresholds before acting, "learns
  behavior, not identity"). Pinned, not built — checked honestly
  against real evidence: zero repeated-behavior occurrences exist
  anywhere in this system yet, not even the single occurrence the
  proposal's own thresholds would call "coincidence." One real,
  load-bearing gap in the design as proposed, named rather than
  glossed over: matching today's phrasing against a stored past
  trigger — real speech never repeats identically — is itself an
  unsolved matching problem, not something "no AI reasoning required"
  actually resolves on its own. Worth building once real, repeated
  usage patterns actually exist to observe — not before.
- **The small, real, static piece actually built now: a capability
  registry (2026-07-12).** Not Guide, not Behavioral Preferences — a
  plain list of what each department can genuinely produce today
  (Finance: outstanding invoices, aged debtors, cash position,
  financial snapshot, statement of account), used to append a single,
  honest, real mention of a closely related capability exactly where
  the actual live gap occurred — an outstanding-balance answer now
  briefly notes the aged breakdown is also available, since that's a
  genuine, already-built capability sitting right next to the one just
  answered. No dissatisfaction-detection, no learning, no confidence
  scores — the static piece a fuller Guide would eventually need,
  built small first, same discipline as everything else in this
  document.
- **Multi-industry expansion — onboarding-as-capture, universal
  primitives, six industries scoped (2026-07-12).** A genuinely
  thorough, fluent proposal, checked against the same standard as
  everything else pinned here rather than given a pass for its
  detail. Real, worth keeping regardless of timing:
  - **Onboarding is a capture, not a form.** A direct, correct
    extension of the receptacle philosophy — Peter describes his
    business the same way he describes a job; extraction identifies
    the business model; ambiguity holds as a real `schema_candidate`
    (already real, already proven) rather than a form field. This
    part doesn't need a second industry to be true — it's a genuine
    insight about onboarding itself.
  - **`business_config` as a real, small primitive** — what gets
    discovered from onboarding, read on every extraction call as
    translation context (Principle 2: helps map words to the right
    intent, never computes anything, never decides). A real, well-
    shaped idea.
  - **`jobs`/`job_scopes` naturally generalizing toward "project"** —
    correct observation about something that already exists
    (`jobs` has sat "unexercised by any real flow" in this schema
    since early sessions), not a reason to rename it now. Renaming
    for hypothetical future use, before a second real use case exists
    to prove the generalization against, is exactly the premature-
    generalization risk the execution register was deliberately
    proven small before extending.
  - **`movements`, `time_entries` as candidate universal shapes** for
    logistics and professional-services work respectively — real,
    reasonable designs, checked against the Constitution's own
    principles correctly (deterministic distance/billable-amount
    computation in code, never AI; real lifecycle reuse via
    `pending_actions`). Genuinely unbuilt, and correctly so.
  - **The honest self-correction worth stating plainly:** the source
    proposal's own "Honest Roadmap" contradicts its own stated
    standard in one place — it says the onboarding mechanism is
    "pinned until one non-trade user is ready to test it live," then
    immediately recommends building the logistics onboarding first,
    as though that industry already has more evidentiary weight than
    Hospitality or Agriculture. It doesn't. Zero real customers exist
    outside Peter's own flooring business — not one logistics
    operator, retailer, consultant, farmer, or restaurant has ever
    sent Office a real message. Every industry in this proposal,
    including logistics, is held to the exact same standard: pinned
    until a real person in that industry is actually trying to use
    Office and hits a real wall, the same way `resolveTaskCompletion`
    and the expense-guard bug were only ever fixed because a real
    message exposed them. This is, so far, the single largest
    distance from real evidence any idea pinned in this document has
    proposed at once — bigger than Guide, Behavioral Preferences, or
    Workers for Platforms, each of which was pinned specifically
    because nothing real demanded them yet either.
  - Real, related, and worth distinguishing: this is about *multiple
    businesses/industries* each getting their own onboarding-
    discovered configuration. It's a different question from "how's
    Sipho doing" (departments owning facts about participants
    *within* one business) — related in spirit (both are about the
    right context shaping the right answer), not the same proposal.
- **Design-session document, 2026-07-12 — Brain Dump Mode, Call Office
  Mode, team architecture, beta philosophy, forgetfulness design.**
  Real, substantial thinking, pinned as a coherent whole rather than
  actioned piecemeal — genuinely varies in how close each piece is to
  earned:
  - **The framing insight worth protecting regardless of what gets
    built:** the Office is becoming a trusted business memory, not
    just a task executor. Not abstract — this is literally what
    Principle 24 (2026-07-12) turned out to be about: whether the
    system's memory can be trusted to answer honestly under real,
    ambiguous conditions.
  - **Brain Dump Mode — the most exciting idea here, and the biggest
    real architectural leap.** Every extraction function today assumes
    one intent per message. A real brain dump needs to split one
    message into several separate intents in a single pass — not a
    parameter tweak, a genuinely different extraction shape. **Seeded
    live 2026-07-12** with a real four-topic message (an expense, a
    vehicle observation, two separate reminders) — this wasn't
    theorized, it produced three precise, concrete findings:
    1. **Nothing is silently destroyed.** The raw capture is preserved
       exactly as spoken (Principle 22's receptacle holding), verified
       directly against `/debug/captures`.
    2. **But non-primary content gets genuinely misattributed**, not
       just dropped. The model's single winning intent ("expense",
       touching supplier BUCO) caused the *entire* raw transcript —
       including "phone the electrician" and "get dog food," which
       have nothing to do with BUCO — to be filed as a character note
       under that supplier. Confirmed directly in BUCO's own notes.
    3. **Genuinely actionable items silently never became tasks.**
       "Phone the electrician tomorrow" and "get dog food" are as
       clear as any reminder already handled correctly elsewhere in
       this system — they just never surfaced as one, because task
       creation is still gated to when `reminder`/`task_complete` wins
       as the *primary* intent, not to whether real actionable content
       exists anywhere in the message.
    A fourth, structural finding worth naming even though it's not a
    bug: **"the bakkie's making a grinding noise" has nowhere real to
    live at all** — no vehicle/equipment concept exists anywhere in
    this schema. Even a perfect brain-dump splitter would have nothing
    real to file that specific fact into yet. Not actioned — these
    findings sharpen the pinned proposal into precise, evidenced
    requirements rather than speculation, which is exactly what
    seeding was for.
  - **The forgetfulness insight is the sharpest UX observation in the
    document** — Peter stops trusting the Office not because it
    failed, but because he stopped feeding it. A design problem, not a
    bug; not solvable by fixing code, needs an actual answer
    (evening brain dump, "anything else happen today") when it's
    built.
  - **Shake-to-report isn't speculative — it's a name for what already
    happened live tonight.** Every one of the three team-support bugs
    (2026-07-12) got solved because transcript, extraction, and
    execution were already attached to the same event and directly
    inspectable — the exact diagnostic pattern shake-to-report would
    formalize into a real beta feature.
  - **Team architecture, Call Office Mode, personality/tone, pricing
    discovery** — real, reasonable, genuinely unbuilt. Pinned until a
    real beta user creates the actual pressure to build them.
  - **The beta philosophy itself ("release reliable, learn from real
    use") is a genuine evolution of, not a contradiction of, the
    standard this whole document has held to** — the fastest way to
    get the real evidence this whole approach depends on is real
    users, and the fastest way to get real users is to actually ship.
    Worth naming explicitly so it reads as the natural conclusion, not
    an abandonment, when it's acted on.
- **HR as a real primitive, split deliberately (2026-07-13).** Real,
  correctly-spotted — every future industry has some version of
  role/skill/qualification for the people working in it, the same way
  every industry has some version of a customer or a job. Split into
  two genuinely different weights of decision, not one:
  - **Operational path — built, real, working.** `character_facts`
    (parallel to `customer_facts`, not shared — characters have real,
    different keys with no address-column special-casing to inherit):
    role, skill, qualification, license, site permit. Extraction
    extended to recognize structured facts about a character, not
    just a customer (previously explicitly customer-only in the
    prompt's own instructions). Same guard()'d discipline as every
    other structured fact in this system — nothing about a real
    person gets written without confirmation. Surfaces in "how's
    Sipho doing" alongside notes and job activity — the answer
    genuinely knows more about him now, the actual first real payoff
    of this primitive. **Verified live end to end**: "Sipho has a
    driver's license" → correctly guard()'d → confirmed → written to a
    real row → "how's Sipho doing?" now genuinely answers with his
    real job assignment *and* his license, in one honest answer.
    **One real bug found and fixed in the process, same class as
    Principle 24**: `getCharacterFacts`' output was first handed to
    the model as a regular fact-array entry, and got silently dropped
    during synthesis for a general question — the model judged it
    "not literally relevant" the same way it once dropped the
    job-profitability caveat. Fixed the same proven way: never left to
    the model's own relevance judgment, appended deterministically
    after synthesis instead.
  - **Medical records and disciplinary history — explicitly NOT part
    of the operational build, pinned separately on purpose.** These
    are regulated (POPIA's "special personal information" in this
    business's real market — health data specifically requires real
    consent or a specific legal basis before it can even be processed
    at all; disciplinary records carry real employment-law weight
    too). Treating this with the same "capture everything, guard()
    the money" pattern as glue receipts would be a genuine liability,
    not just an engineering gap — and it's not purely an engineering
    call to make alone. Needs a real compliance/legal read on consent
    and access before a single schema decision gets made, not folded
    in because it happened to be mentioned in the same sentence as
    role and skill.
- **Obsidian vault export — an experimental, read-only projection of
  Office memory, explicitly gated on Office being stable and in beta
  (2026-07-13).** Not for now; pinned exactly as proposed, and
  genuinely well-bounded from the start rather than needing correction
  the way some pinned ideas here have:
  - **D1 stays the single, authoritative source of truth** — Obsidian
    never participates in execution, never becomes a second write
    path. Directly Principle 16 (Immutable History) held intact, not
    a new decision.
  - **"Deterministic projection" is the right term, and the right
    constraint** — pure, reproducible code generating the vault, never
    an AI-narrated summary that could drift from the real data or
    hallucinate a connection. Principle 1 applied to an export layer.
  - **Genuinely zero production risk** — read-only, disposable,
    delete-and-regenerate at will. Real, stated purposes worth
    building toward when the time comes: A/B testing D1 lookups
    against graph-style retrieval, visual inspection of memory,
    markdown-based version/backup.
  - **Three real design questions to answer when this is actually
    built, named now so they're not skipped later:** (1) "graph-like"
    isn't automatic just from exporting to markdown — Obsidian's real
    power (bidirectional links, the graph view) only happens if the
    generator deliberately emits real cross-references between a
    customer's page and their real invoices/jobs/expenses/characters,
    a real design decision, not a given side-effect. (2) Conversation
    history has a genuinely different shape than the structured D1
    data — how raw captures become graph-like markdown (one file per
    capture? threaded by customer? by day?) is real, undecided design
    work. (3) Worth being precise about what the A/B test actually
    validates — D1 is live, exact, transactional; a regenerated vault
    is a disposable snapshot, stale the moment new data lands. Closer
    to testing whether graph-style browsing gives better human insight
    than querying does, not a fair "which should power production"
    comparison — worth naming precisely so it isn't oversold later.
  - **Sharper now than when first pinned (2026-07-14):** Principle 27
    (A Network, Not Modules) named the same graph-shaped question this
    export would visualize — "starting from Sipho, what connects to
    what" is exactly the traversal Principle 26's permission model
    depends on too. Worth remembering, when this is eventually built,
    that it's not just a nice visualization — it's a real, honest test
    of whether the graph mental model already being used to reason
    about permissions actually holds up when drawn out.
- **First real UI prototype, built and iterated in-browser (2026-07-13)
  — deliberately zero Flutter build minutes spent, since almost
  everything about feel can be designed and tested for free before a
  single real build runs.** Two real, working HTML prototypes (not
  static mockups), each fetching live data from the real production
  API — no mocked data anywhere in either.
  - **First pass:** a card-dashboard-first design — real ember counts,
    real docket-style cards for tasks/schedule/finance/expenses. Real,
    useful, and the wrong opening move — corrected against a real
    reference screenshot into what became Principle 25.
  - **Second pass, the one that stuck:** hold-to-talk (real browser
    speech recognition where supported) and write-it-down (genuinely
    wired to the live `/messages/text` endpoint, real responses shown)
    as the dominant, opening act. Small ember dots in the masthead —
    peripheral, not competing for attention — each behaving like real
    fire rather than a flat on/off state: irregular flicker for
    Tasks/Scheduler/Expenses, a slow heavy brighten-and-fade for
    Finance, a faint warm edge even at rest rather than fully "off."
    The dashboard demoted to a calm bottom sheet, one tap away from an
    ember, never the default view.
  - **A real addition, built then removed**: a waveform appearing
    while Office listens. Recognized, once actually seen in motion,
    as exactly the "🎤 Recording..." convention this design exists to
    avoid — removed in favor of exactly two signals when listening:
    the mic itself slowly igniting from charcoal to warm glow, and one
    ember (Tasks) briefly brightening. Nothing more. The backdrop and
    entrance of the ember sheet softened to match the same restraint
    — a gentle fade rather than a dark modal-snap, a slower, calmer
    slide.
  - **Explicitly pinned for later, not now**: genuine irregularity in
    the ember flicker — real randomness rather than a repeating
    keyframe loop, so no two embers, or the same ember twice, ever
    flicker identically. Worth doing with real care when the time
    comes, not bolted on now.
  - **The durable insight, extracted into Principle 25**: this isn't
    a visual style, it's a different opening question than every
    existing CRM/ERP/field-service app — "tell me what's happening"
    instead of "what do you want to do." Worth actively defending as
    real features get added, not a decision that stays made on its
    own.
- **Conversational auth and permissions — superseded by a refined,
  precise Membership-model proposal (2026-07-14).** The 2026-07-13
  version raised a real concern: "evidence-based permissions" needed
  a precise definition before it was a decision, since a role
  description ("Sipho is an installer") must never be allowed to
  silently imply an access grant. This version genuinely resolves
  that concern rather than just restating it:
  - **Auth and authorization cleanly separated — the correct, standard
    shape.** Google handles who you are; Office handles what you can
    do. A Google identity represents one person, never one business —
    the person can own Offices and separately hold memberships in
    others.
  - **Membership is the real entity that answers the earlier
    concern** — refined from an earlier, clunkier "Office × Person ×
    Role" notation into the correct, natural name for what it actually
    is. A structured, explicit, inspectable thing that can be created
    and revoked on its own, never inferred from an HR fact or a role
    description. This is exactly the separate, guard()-able access
    grant the earlier concern called for.
  - **The Sipho example does real work, not just illustration — and
    the deeper insight underneath it is worth stating plainly: nobody
    belongs to a company anymore, people belong to multiple Offices.**
    Sipho owns his own isolated Office (Sipho Projects) and separately
    holds a scoped membership in Zululand Flooring as Installer — zero
    data bleed between them, exactly like real life, where the same
    person might work a trade, run a weekend side business, and help
    with a spouse's business, all at once. This extends "isolated
    instance per business" (rejected shared multi-tenancy three
    separate times already) rather than compromising it: the only
    thing that needs to live outside any single Office's isolated
    database is a small, pure routing directory — which Google
    accounts hold which memberships in which instances. That's
    metadata about access, never business data — the same distinction
    a landlord's keyring makes versus what's actually inside any
    tenant's apartment. Worth stating explicitly rather than left
    implicit, since it's what makes this compatible with everything
    already decided.
  - **The "Choose Office" pattern is a better, more general answer to
    tonight's own multi-persona need than the earlier "bookmarked URL
    per instance" idea.** One real Google identity, many real
    memberships, a simple picker when more than one exists — solves
    the exact "log in as different accounts, seed different
    industries" problem as a first-class product feature (useful for
    real accountants and multi-business owners too), not a dev-only
    workaround.
  - **Permission enforcement for a conversation-first product is
    genuinely harder than for a normal app — refined into Principle 26
    (Permission-Aware Answers).** A normal SaaS tool hides a button.
    Office has no buttons to hide — if Sipho asks "how are we doing
    financially?", the same `answerFromMemory` synthesis that already
    answers Peter correctly needs to know it must refuse or redact for
    Sipho specifically. The precise, buildable discipline this
    resolved into: the permission check belongs at fact construction,
    before synthesis, never as a redaction pass on the output — the
    same distrust of the model's own judgment Principle 24 already
    established, applied one layer earlier. A model never given the
    real profit figure cannot leak what it was never handed.
  - **Update 2026-07-14 — no longer just pinned. Steps 1-4 of the
    phased auth scope are real, built, and verified live**, not just
    designed:
    - **Step 1 — real Google OAuth**, fully working end to end:
      `/auth/google/login` (CSRF-protected via a signed state
      parameter), `/auth/google/callback` (real token exchange, the ID
      token verified directly against Google's own tokeninfo endpoint
      — never trusted on its own — checking `aud` matches this app's
      real client ID and `email_verified` is true), `/auth/me`,
      `/auth/logout`. Sessions are signed HMAC-SHA256 tokens (30-day
      expiry), verified on every request with no server-side session
      store needed.
    - **Real bug found and fixed live**: a pre-existing placeholder
      (`"auth: reserved, not yet implemented"`) was shadowing every
      real `/auth/*` route from a previous session — found and removed
      the moment real sign-in returned the old stub instead of
      reaching Google.
    - **Step 2 — a real `memberships` table** (Office × Person × Role,
      one per Google account, matching the Membership architecture
      exactly) plus a real, deliberately incomplete `ROLE_CAPABILITIES`
      map — only Owner and Installer defined, since those are the only
      two roles anyone concretely specified a capability list for
      (Principle 22 discipline: not enumerated in advance for roles
      nobody has asked for).
    - **Step 3 — proven with two genuinely different real
      memberships** — Peter as Owner (11 real capabilities), a test
      account as Installer (4 narrower capabilities, correctly
      excluding profit/payroll/banking/settings) — confirmed via
      `/debug/memberships` returning the exact, correctly-differentiated
      capability lists for each.
    - **Step 4 — Principle 26 implemented for real, on one real path**:
      the financial lookup (`getFinancialSnapshot`, `getProfitAndLossSummary`
      gated on `can_know_profit`; `getOutstandingInvoices`,
      `getAgedDebtorsSummary` gated on `can_know_debtors`). Checked at
      fact-gathering, before synthesis, exactly as designed — a
      neutral, valueless marker replaces the real facts when not
      permitted, never the real number filtered after the fact.
      **Verified live, side by side, same exact question, same exact
      code path:** Sipho (Installer) received *"I don't have that on
      file — the financial performance data and outstanding balances
      for this business are restricted for your role"* — a real,
      honest refusal, never having received the real figures at all.
      Peter (Owner) received the complete, accurate real picture. Real
      bug caught before shipping in the process: `outstandingFacts`
      ("who owes us money") is literally the same debtors category as
      the already-obviously-named `agedFacts` and was almost left
      ungated — caught and fixed before it went live. A second small
      bug caught: the aged-breakdown hint checked `outstandingFacts.length
      > 0`, which would have fired even when access was restricted,
      since the restriction marker itself is a one-element array —
      fixed to check the real capability directly.
    - **A real, admin-gated testing tool** (`/admin/mint-session`) was
      needed and built to actually verify the Installer path, since
      the test membership's email isn't a real, controllable Google
      account — genuinely useful going forward for any future role
      that needs verifying without a real second Gmail account on
      hand.
  - **What's explicitly still open, not done tonight, worth being
    precise about before picking this up again:**
    - **The "no session defaults to full access" gap is still real and
      still temporary** — safe only because Peter is currently the
      only real user. This must be closed before any real second
      person with genuinely restricted access uses the live system,
      not just an admin-minted test session.
    - **Only the financial lookup path is permission-aware.** Every
      other synthesis path (customer-scope answers, character-scope
      HR facts, quotations, expenses) still runs with full access
      regardless of who's asking — Principle 26 exists as a real,
      working pattern now, not yet threaded everywhere it needs to be.
    - **Voice input doesn't resolve real capabilities yet** — the two
      voice-path callers of `processTranscript` still use the default,
      unlike `/messages/text` which now resolves the real session.
    - **Google's brand verification hasn't been submitted** — the
      consent screen still shows the raw domain instead of "The
      Office," expected and fine for testing with people who already
      trust you, a real thing to do before a genuine public beta.
    - **Choose Office / multi-instance routing (step 5) hasn't been
      started** — correctly last, since it only matters once a real
      second instance exists to choose between.
    - A real, brief, unresolved mystery: the exact same financial
      query hung twice, then succeeded cleanly on a third attempt with
      identical code and identical (empty) data. Nothing found in the
      four real functions on that path suggests a genuine defect —
      most likely a transient AI-call latency spike, not a bug, but
      worth remembering if it recurs.
- **Heartbeat and Pulse — a real, well-timed concept, explicitly
  gated on the auth foundation (2026-07-14).** Correctly arrives right
  as its own prerequisite is nearly cleared — steps 1-4 above are
  proven live, not just planned, so this isn't premature the way it
  would have been earlier tonight.
  - **The real insight, worth taking at face value:** industries don't
    differ by feature set, they differ by operational heartbeat — the
    expected sequence work moves through (flooring's lead → measure →
    quote → material order → install → snag → invoice → payment;
    courier's pickup → dispatch → deliver → proof → invoice). The
    Office stays universal; only the rhythm it's tracking changes.
    This sharpens the earlier multi-industry scoping discussion with
    better vocabulary — "does this trade's heartbeat fit what the
    schema's primitives already cover" is a more precise question than
    the technical framing used at the time.
  - **A real gap worth naming precisely, so it isn't glossed over
    later:** tonight's embers are genuinely simpler than "pulse"
    describes. They show magnitude — how many open tasks exist,
    scaled by count. Pulse describes something meaningfully further —
    whether the *current* state is normal or abnormal *for this
    business's own rhythm*. Three open tasks isn't inherently a
    disturbance; it's only one if this business typically runs with
    zero. That needs a real, new capability — tracking what's typical
    over time and detecting deviation from it — not a reinterpretation
    of the existing ember code. Correctly not attempted yet.
  - **Two connections worth drawing explicitly, not left as
    coincidence:** (1) genuinely related to, but distinct from, the
    already-pinned Guide concept — Guide learns which *capabilities*
    to surface from real usage; Heartbeat learns the expected *rhythm*
    of work and flags deviation from it. Related, not duplicate,
    stays a separate pin. (2) "Businesses don't have modules, they
    have rhythms" makes the same structural move as Principle 27, on a
    different axis — Principle 27 says stop thinking in departments,
    entities connect to each other (relational); this says stop
    thinking in departmental snapshots, activity flows through time in
    an expected sequence (temporal). The same critique of modular
    thinking, arrived at independently twice in one night.
  - **Sharpened significantly, 2026-07-17 — deviation-from-expectation
    is another mode of Pulse, not a new subsystem.** Real, granular
    examples surfaced the refinement: a courier's rate jumping from
    R150 to R250, a material's cost drifting from R250 to R400, a
    delivered color not matching what was approved, a job quietly
    stretching from one day to three. None of these are errors —
    every one violates an expectation that already exists, built from
    years of accumulated, mostly-subconscious experience. Briefly
    named an "Attention Engine" before the framing was corrected —
    rightly rejected, since that name implies a new service, a new
    database, a new moving part, when the actual mechanism is
    identical to Pulse's original one at a smaller grain: accumulate
    real values for something → establish what's normal
    deterministically → compare a new value against it → stay silent
    unless it materially deviates. Genuinely the same shape, just
    applied to a specific attribute (a supplier's usual rate, a
    material's usual cost) rather than the business's overall rhythm
    — a real generalization, not two ideas sharing a name.
  - **One real precision the original framing didn't spell out, worth
    stating explicitly before this is ever built:** "materially
    deviated" has to be a deterministic computation — a genuine
    statistical threshold over real historical values — never an AI
    judgment call about what feels like a meaningful change. The exact
    same line Principle 1 and Principle 24 already draw everywhere
    else in this system, applied here too. The model's role stays
    strictly limited to narrating an observation already computed in
    code, never deciding whether one exists.
  - **Connects to Principle 28 by already fitting its existing
    structure, not by needing new language added to it.** "Expectation"
    is a specific kind of relationship — many instances of the same
    fact-type related to each other across time — which is Layer 2.
    "An observation that reality deviated" is a specific kind of
    cognition — noticing, explicitly not deciding — which is Layer 3.
    Stronger to show the principle was already general enough to cover
    this than to extend its wording for a case it already handled.
  - **A real, deliberate distinction from the Patient Prospector's
    "Candidate Nuggets" stage, worth keeping separate rather than
    letting two similar-sounding ideas merge into one.** That pipeline
    holds a single *fact* awaiting confirmation before it becomes
    truth. This holds a *pattern* awaiting enough accumulated evidence
    before it becomes a trustworthy baseline at all — genuinely
    different mechanisms, both refusing to assert too early, related
    in spirit only.
  - **Why this still correctly isn't built:** needs more than Layer 1
    being reliable — it needs real historical *volume* for any given
    attribute before a baseline is statistically meaningful at all, a
    single data point can't establish an expectation. Layer 1's
    reliability is necessary but not sufficient on its own.
  - Concept only, explicitly not for implementation — correctly
    deferred behind a stable beta, same discipline as everything else
    held to a real trigger before being built.
- **Institutional Knowledge, Introspection & Business Evolution — a
  real, well-reasoned philosophy document, deliberately pinned rather
  than pursued (2026-07-15).** Captured explicitly to prevent losing
  the thinking, not as a signal to start building it — arrived right
  as the discipline of "solve for the real Peter, not the ideal one"
  was being consciously re-committed to, and correctly set aside
  rather than let that discipline slip.
  - **The real shape of the idea, worth having on record precisely:**
    a full cognitive loop (reality → senses → memory → Pulse →
    introspection → observation → conversation → Peter decides →
    speech → implementation → reality changes) where Pulse becomes a
    scheduler for *when* reflection is warranted, not a reaction to
    every event. Introspection reflects on what's already been
    learned, looking for emergent conventions, drifted principles, or
    changed rhythms — never inventing them.
  - **Discovery is deterministic — the one piece of real, load-bearing
    engineering discipline in this whole document, worth protecting
    regardless of when or whether the rest gets built.** A pattern
    like "Blindquip usually grants 5% off orders of 10+ blinds" must
    be counted and evidenced in code (26 of 27 occurrences), never
    invented or inferred by the model — the model only ever explains
    a pattern that deterministic counting already surfaced. Exactly
    the same discipline already proven three times this project
    (Principle 24's deterministic-append pattern), applied to a new,
    future capability rather than a new idea in itself.
  - **Principles versus Conventions is a real, useful distinction** —
    explicit, chosen operating philosophies (80% deposits, PPE
    requirements) versus discovered, relationship-driven patterns
    that emerge from repeated behavior and require confirmation
    before they become real. Both remain fully overridable — Peter
    creating a 50% deposit quotation against an adopted 80% principle
    gets asked "is this an intentional exception?", never blocked.
  - **Provenance — remembering *why* the business changed, not just
    *what* changed** — is arguably the most durable, generally-useful
    idea in the document, worth remembering on its own even
    independent of whether the rest is ever built: a convention's full
    lineage (what evidence surfaced it, what triggered the surfacing,
    who confirmed it, when) reconstructable months later when someone
    asks "why do we do it this way now."
  - Explicitly not for implementation — the current, real priority
    remains solving reliability for the actual, present-day Peter, not
    building institutional-memory capability for a more sophisticated
    future one. Pinned so the thinking survives without pulling focus
    from what's actually earned right now.
- **A missing primitive found through real reliability testing, not
  contrived (2026-07-15): a named person who represents an entity has
  nowhere to live.** A real "day in the life" scenario run through
  `/debug/split-topics` — a customer meeting (Alphonse, of Squinnies)
  and a separate supplier follow-up (Leon, of Floornet) — surfaced
  this cleanly: both named individuals were dropped entirely, only
  their companies survived extraction. Not a bug — `customers` and
  `characters` both exist, but neither slot fits "a real person, tied
  to an organization, distinct from being that organization's stand-in
  or a fully separate character of their own." A supplier rep, a site
  foreman, a facilities contact are all this same shape. A real trade
  business deals with Alphonse specifically, every time — losing the
  name while keeping the abstract company is losing the actually
  useful, actionable part.
  - **Directly, explicitly the thing Principle 27 already named**: a
    business is a network of connected entities, not siloed records.
    A contact-at-an-entity relationship is exactly the kind of
    connection that principle says shouldn't be lost — right now it
    structurally cannot be captured at all, in either direction.
  - **A second, related finding from the same test, worth having on
    record separately:** an explicitly self-hedged number ("I think
    it's fifty six square meters... I'll have to get the exact
    measure") has no way to be recorded as provisional rather than
    certain — the system currently can't distinguish a measurement
    Peter is sure of from one he's flagged, in his own words, as an
    estimate pending confirmation.
  - Not for implementation now — reliability for the current, real
    Peter stays the priority. Pinned so a genuine, recurring gap found
    through real testing survives to be addressed deliberately, not
    forgotten because it surfaced mid-test rather than mid-design.
- **Layer 1 (Constitution Principle 28) resolved, 2026-07-15/16 — all
  three real bugs found through genuine testing, fixed, and proven
  with real evidence, not assumed fixed.** The direct, complete answer
  to "truth must arrive before truth can be related":
  - **Retry safety (Stage 0).** A stable, caller-supplied idempotency
    key, checked before any real work starts. A completed request
    returns its exact original result again, never reprocessed; a
    request still mid-flight returns a clear `still_processing` signal
    rather than starting a second copy of the same work. Proven twice
    — once on a simple case (four identical calls, one real payment,
    `id: 5`, confirmed once), and once under genuine, natural load
    (the same heavy combined scenario that first exposed the bug,
    correctly refusing to duplicate a still-running attempt rather
    than silently creating a fourth batch of job scopes).
  - **Direct-area extraction.** A directly-stated total area ("thirty
    square meters," no width-by-length breakdown) now has a real path
    — `WorkComponent.area_sqm`, extracted directly since pulling a
    number already stated whole is transcription, not arithmetic,
    never violating the no-LLM-math discipline. Proven live:
    `area_sqm: 30` recorded correctly, and `area_sqm: 160` in the
    earlier, denser scenario.
  - **Pricing attachment — found to be a genuinely symmetric gap, not
    a one-directional one, through direct testing.** A rate stated in
    the same breath as the work it describes used to reach nowhere
    when `work_observation` won as the segment's top-level intent —
    fixed by calling the same, already-proven `extractScopePricing`
    immediately against the real, just-computed component areas. But
    a second, real test — the identical sentence, on a second run —
    showed the classifier can pick `price_scope` instead for very
    similarly structured phrasing, and *that* path was separately
    discarding a measurement sitting in the same message whenever no
    job scope already existed to price against. Fixed symmetrically:
    when `price_scope` wins with nothing to price, the same message is
    now checked for a measurement too, mirroring the work_observation
    path exactly. Both directions converge to the same, correct
    result now — proven live: "Measured Jenny's lounge at thirty
    square meters, we'll fit vinyl at three hundred rand a square
    meter" correctly produced a real R9,000 quotation (30 × R300,
    verified against the actual math), a real job scope with the
    correct area, and a real, confirmed quotation record with a real
    PDF and share message — the complete chain, working end to end.
  - A single shared helper (`buildQuotationLineItems`) now backs both
    the price_scope and work_observation pricing paths — one real
    implementation of the rate-times-area arithmetic, not two copies
    silently able to drift apart from each other.
  - **What's still honestly open, not solved by this pass:** a
    self-hedged measurement ("I think it's fifty six square meters...
    I'll have to get the exact measure") still returns null rather
    than being recorded as provisional — a genuinely different,
    harder problem than a confidently-stated direct area, correctly
    not conflated with it. The contact-at-an-entity gap (Alfons,
    Leon, Wilma) remains completely untouched — correctly Layer 2's
    concern, not Layer 1's. A minor, unconfirmed variance was also
    noticed (a task present in one test run, missing in a near-
    identical repeat) — not chased further, worth remembering if it
    recurs.
  - **Layer 2 (Project, relationship assembly) is now genuinely
    earned to begin, by Principle 28's own ordering** — truth has
    arrived; only now does asking how these truths relate become the
    right next question.
- **The Patient Prospector, sharpened (2026-07-16) — not an aspiration
  requiring new mechanism, a real pipeline already proven for money,
  not yet offered to everything else.** The original framing (below)
  named a genuine gap; this refinement locates it precisely:
  Speech → Receptacle → Patient Prospector (LLM) → Candidate Nuggets →
  Deterministic Validators → Truth → Relationships → Memory.
  - **The decisive realization: every stage of this already exists for
    money, tested and proven, not theoretical.** "Candidate Nuggets"
    is `pending_actions`, already real. "Deterministic Validators" is
    Peter's own confirm action, already built. The R9,000 quotation
    from two nights ago is the concrete, working proof of the whole
    chain — the LLM produced a candidate (rate, area, matched
    customer), it sat unconsummated as a real row, Peter's
    confirmation was the validation step, only then did it become
    Truth. The mechanism isn't missing. It's just narrow.
  - **The real, precise question this generates: which other kinds of
    extraction deserve the same candidate-then-validate treatment
    money already gets, and which genuinely don't need it?** Job
    scopes, components, and measurements currently skip the candidate
    stage entirely — written straight to Truth, no validation gate at
    all. That's exactly why the hedged measurement ("I think it's
    fifty six... I'll have to get the exact measure") has nowhere to
    go: there's no provisional state for a component to sit in, the
    way a quotation already gets to sit in `pending_actions`. Not
    everything needs this — recreating friction for confident,
    low-stakes statements would be a real regression — but Peter's own
    hedge is direct evidence at least some component data belongs
    there too.
  - Kept explicitly in the arsenal of yet-to-be-earned architecture —
    not because the mechanism needs inventing, but because deciding
    which extractions actually deserve it is real design work, not yet
    done.
- **The original Patient Prospector framing, preserved for context —
  a genuine, valuable aspiration, worth distinguishing carefully from
  what's actually built (2026-07-15).**
  A week-ending philosophy document reframed extraction: not filtering,
  not boiling, but patiently letting speech settle like sediment,
  swirling rather than immediately carving, until real nuggets of
  truth emerge on their own.
  - **The precise, important correction: this describes where the
    system should eventually get to, not where it is.** Everything
    actually built and tested is fast and immediate, not patient —
    `splitIntoTopics` carves a message apart in one pass before any
    deep understanding happens; every extraction function fires once,
    immediately, on the raw transcript, with no mechanism to hold an
    ambiguous fragment and let more context resolve it later. The
    receptacle (Principle 22) genuinely embodies "nothing is
    discarded" — that part is real and already true. "Swirling until
    nuggets appear" is not.
  - **"Context is part of extraction, not added afterwards" is the
    same honest distinction, on a wider claim.** Reconciliation
    (matching a name to an existing customer) happens *after*
    extraction today; extraction itself doesn't yet draw on
    accumulated business history, active projects, or prior
    conversations while actually classifying a sentence. A real,
    worthwhile target — not yet how the system works.
  - **The closing line is the truest sentence in the document, and
    worth taking completely seriously:** "I don't think we're
    building an AI assistant anymore... I think we're building a
    business that slowly learns itself." The same realization from
    earlier this week — that this was always about memory — evolved
    one step further, now standing on a real, tested foundation
    (Layer 1) instead of just intuition.
  - Not for implementation — a real, well-earned philosophy to build
    toward once it's genuinely earned, in the same order Principle 28
    already established: truth, then relationship, then this.

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

## The Succession Asset — a real reframe of what Office ultimately is (2026-07-17)

**The observed problem, real and directly witnessed, not theoretical:**
South Africa's flooring trade is aging out with no real youth pipeline
behind it — businesses that don't survive past the founder, closing
outright rather than transferring. **Why they actually close:** rarely
the tools, the truck, or the client list. The real asset — pricing
reasoning, supplier reliability, customer history, the "why we do it
this way" — lives entirely in one person's head and retires or dies
with them. Nothing transferable exists to hand over, so the business
simply ends.

**What Office changes about that, if the capture has genuinely
happened over years, not just transactions but the reasoning behind
decisions:** the business stops being a single point of failure. The
knowledge survives the person. That reframes the product from
"software to run your business better" into something with real,
independent stakes of its own — the reason a business still exists
when its founder no longer can. A succession tool wearing a
day-to-day assistant's clothes.

**Where this actually belongs — not filed under one existing idea, but
the convergence of two already on record:** Principle 22 (Capabilities
Emerge From Captured Reality) explains the *mechanism* — Peter
describes reality once, in his own words, nothing re-entered. The
Institutional Knowledge document's **provenance** concept — already
named there as arguably its most durable, generally-useful idea —
explains the *payload*: remembering *why* the business changed, not
just *what*, is precisely the transferable asset a founder's
retirement would otherwise erase completely. This isn't a new
principle. It's the highest-stakes expression of two already earned.

**A real, verified correction to the competitive claim, worth stating
precisely rather than overreaching:** succession planning as a
category has real, existing players in South Africa — formal
consultants, structured assessment services, an established academic
literature independently confirming the exact diagnosis above (tacit,
person-locked knowledge with no natural transfer mechanism is a real,
well-documented failure mode, not invented here). "No competition"
is not quite accurate. What's genuinely uncontested is the
*mechanism*: every real competitor treats succession as a deliberate,
effortful process someone actively undertakes — assessments,
mentoring programs, structured transition plans. Nobody is offering
knowledge transfer as an incidental byproduct of simply running the
business through ordinary daily conversation. The sharper, more
defensible pitch: Office doesn't compete with succession consultants —
it makes formal succession planning unnecessary for the knowledge-
transfer problem specifically, because the knowledge was already
captured years before anyone needed to plan anything.

**Why this is a stronger pitch, not just a different one:** a moat no
funded competitor can buy (the value only becomes real with years of
accumulated history — impossible to shortcut with capital or
engineering speed), a genuine reason for patience rather than a
constraint on it, and a referral trigger with far more weight than
convenience — the kind of story that spreads at a retirement or a
handover, not at the tile counter.

**The discipline this demands — directly the same evidence-before-
claim standard Principle 28 already applies to architecture, now
applied to positioning:** don't sell this story yet. No Office has
survived a real transfer; the claim is unproven by definition until
one does. Build for "run my business" today, let a real succession
outcome actually happen, then tell the true story once it's real —
not before.

**A real, honest caveat worth pinning alongside the rest, not left
implicit:** this is a powerful *external* narrative — for referrals,
for founder conviction about long-term value — but Office itself
should never surface mortality-framing to Peter directly. The product
stays "software that runs your business better," full stop, from his
own daily vantage point. The succession story lives outside the
product, never inside a sentence Office actually says to him.

## Go-to-market strategy, sequencing, and product gaps surfaced through real conversation (2026-07-19)

Not an architecture session — a strategy conversation, from a separate
chat, about who this is actually for and what earns priority once real
users are about to exist. Pinned for the same reason as the Patient
Prospector and Institutional Knowledge documents: real, worthwhile
thinking, mostly not being built yet.

**One correction worth making before this is taken at face value: the
document's own claim that Principle 26 covers "just the financial
lookup" is already out of date relative to the same night's real
work.** By the time this was written, reads were already gated across
customer-scope, character-scope, and business-scope quotations and
expenses, and writes were gated for the first time too (payment,
expense, invoice, quotation, convert_quote, all behind
`can_manage_invoices`) — see the entries above this one. Doesn't change
the document's real point (permission-awareness needs to be *complete*
before "Teams" is a real, sellable tier, not just started), but the
distance still remaining is smaller than the document implies.

**Verified, not assumed: the "no due/scheduled time on tasks" claim
still holds** — confirmed directly against the live code, unlike two
other claims found stale in this same document earlier tonight. Worth
noting precisely, since a document making several claims about current
state deserves the same scrutiny as any other — this one earned its
place in the ranking.

**The tiers being one product, not three, and Enterprise being
genuinely different (real per-tenant infrastructure, not a bigger
plan)** is a real, precise architectural claim, directly consistent
with the isolated-instance-per-business principle already settled
multiple times in this project — not a new decision, an application of
one already made.

**The Excel/paper-not-Pastel positioning is a real, sharp finding,
and it connects directly to the Succession Asset entry above rather
than standing alone.** Together they describe the same shape of
wedge from two angles: don't compete with Pastel on features (a fight
on its home turf, not yet winnable), don't compete with succession
consultants on formality (the mechanism is uncontested) — compete on
being the thing that correctly captures what already happens, with
zero added friction, which neither alternative was ever designed to
do.

**A real, concrete, currently-missing feature surfaced here, sharper
than the earlier Succession Asset pin named it:** there is no actual
ownership-transfer flow. Changing who holds owner-equivalent access on
a real business, while preserving its full history, isn't a real
product capability yet — only a blunt, debug-level delete-then-recreate
of a membership row. Worth building deliberately before succession is
ever sold as a promise rather than implied, exactly as this document
says.

**The vent-channel idea is worth taking seriously, and its own
internal caution is exactly right, not a footnote to soften later.** A
raw, personnel-sensitive rant ("that rep is USELESS again") must never
surface verbatim to another session or a successor — only a counted,
graduated pattern should ever become shared business memory. This is
correctly named as a subtler instance of the subject-attribution
failure-shape (pattern 2 in STATUS.md, recurred three times already,
not a new problem class) — and it's the same reasoning already proven
for Blindquip-style deterministic discovery: a single instance stays
low-confidence by construction, a real pattern doesn't, and nothing
about a rant's emotional intensity should be allowed to substitute for
real, counted repetition.

**Bulk historical ingestion sharpens something already true rather
than introducing something new**: volume solves recurrence and
proportion questions (what's normal, what's a supplier's real share)
on day one instead of over years, but it does not and cannot solve
*rationale* — only the live vent habit, accumulated and counted over
real time, can ever answer "why do we buy from Floornet instead of
Belgotex." Two different problems, both real, neither substitutes for
the other. Directly connects to the `unpdf` finding surfaced the same
session — a shoebox of scanned paper runs straight into exactly that
gap.

**The ranked feature candidates are a real, useful list, not a
commitment** — due/scheduled time on tasks, pack-size/cut-list
arithmetic (rightly called the highest-leverage of the untouched
ideas, since it produces real structured data as a side effect of
normal use rather than requiring anyone to narrate reasoning), receipt
capture and a vehicle logbook, bulk import, and contact-at-an-entity
(already pinned above, reordered here for its direct dependency
relationship with rep-reputation tracking).

**The one real adjustment this document makes to the discipline
itself, worth stating plainly:** everything built so far was built for
and tested by a single patient user against his own live system.
That's about to meet an audience with no patience for architectural
correctness and no context for why something is deliberately unbuilt.
The discipline doesn't get abandoned — but the bar for what's allowed
to jump the queue now has an external judge, not just Peter, and
low-blast-radius utility (due dates, cut lists) is correctly named as
what should move faster than reflective, institutional-memory features
(rep reputation, succession tooling) — which can safely stay pinned
for years without hurting anyone.

## Complete bug archive (full, unabridged history — see STATUS.md's Failure Shapes for the distilled patterns)

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

**2026-07-12, real expense capture (first crash found via a live 1101
error, not curl output):**
29. **A real crash on the very first live expense test** — Cloudflare
    error 1101, an unhandled exception. Root cause: the generic
    `pendingActionId` confirmation-message branch (shared by payment,
    invoice, quotation, price_scope) used a `customer!.name` non-null
    assertion that had silently held for every intent built so far,
    because every one of them was genuinely keyed to a customer.
    `expense` was the first guard()'d intent keyed to `character` (a
    supplier) instead — `customer` was correctly `null`, and the
    assertion, which TypeScript accepted at compile time, threw at
    runtime on every real message. Fixed with a dedicated `expense`
    branch, same pattern as `task_complete` and `convert_quote`
    getting their own branches before it. Worth remembering the shape
    of this one specifically: a non-null assertion is only as safe as
    every future caller sharing the same assumption — the moment a
    genuinely different shape (character instead of customer) reuses
    a "generic" branch, the assertion becomes the bug.
30. **A more serious variant of the same theme, found live 2026-07-12
    while testing expense categorization:** the guard() condition for
    `expense` required a named supplier (`character`) to exist before
    the expense would even be held for confirmation at all. "Filled up
    the bakkie with diesel for R650" — a completely real, common
    expense with no clear supplier character — silently vanished with
    no pending action, no record, and no error. `recordExpense`
    already correctly supported a null `characterId`; the guard
    condition itself was the bug, requiring something that was never
    actually necessary. This is the exact silent-loss failure mode the
    receptacle exists to prevent, just one layer past where the
    receptacle can catch it — the raw capture was logged correctly,
    but the *business record* it should have produced never
    materialized. Fixed to require only a real amount, same pattern as
    `invoice`. Verified live: `characterId: null` now correctly
    recorded rather than silently dropped, categorization
    (`classifyExpenseCategory`, 2026-07-12 — real, closed-set AI
    classification into materials/fuel/tools/subcontractor/other, same
    shape as `classifyBusinessTopic`, legitimate per Principle 2 since
    a wrong category is low-stakes and easily corrected) confirmed
    working correctly alongside the fix in the same test.
31. **The job-profitability caveat was reliably stripped out during
    synthesis, twice in a row, live 2026-07-12.** `getJobProfitability`
    used to bake its "only explicitly-linked expenses count" caveat
    into one combined fact string handed to `answerFromMemory` — and
    the model's own relevance-filtering (correctly protective in every
    prior case) treated the caveat as extraneous and dropped it both
    times a real profitability question was asked. A caveat qualifying
    the very number being reported isn't optional context to weigh —
    fixed by splitting the return into `{fact, caveat}` and appending
    the caveat deterministically in code after synthesis, never a fact
    the model could discard. Same fix pattern as the aged-debtors
    capability hint (bug-adjacent feature, not numbered separately).

**2026-07-12, team support ("how's Sipho doing") — a real, three-layer
debugging chain, each bug only found because the previous one got
fixed and testing kept going:**
32. **A real name collision silently defeated character resolution.**
    "Sipho" existed as both a customer (id 12, an unrelated much
    earlier test) and a character (id 7, today's real installer). A
    lookup for `character_name` used `findExistingEntityByName` — a
    function that checks customers first, found the wrong-type match,
    correctly rejected it, and had nothing left to fall back to,
    leaving `character` silently unset even though the right character
    genuinely existed. The register/AI-fallback then kicked in and
    answered about a completely unrelated customer. Root cause: that
    function is genuinely correct for its own real use (the register's
    ambiguous-reference fallback, where the type truly isn't known in
    advance) — the bug was using it in the lookup branch, where
    extraction had already told us which table a name came from.
    Fixed with `findExistingCustomerByName`/`findExistingCharacterByName`
    — type-specific, read-only lookups for when the type is already
    known. Verified via a direct diagnostic route
    (`/debug/find-character`) proving the lookup itself was correct in
    isolation before chasing the bug further downstream.
33. **The deeper bug, only visible once #32 was fixed: `answerFromMemory`
    judged real, correct, directly relevant facts as not answering the
    question at all**, triggering its own "say you don't have that on
    file" instruction. Diagnostics proved every layer upstream was
    correct — character resolution, job-installer linking, fact
    assembly all returned exactly the right data. The actual bug was
    in how the model read "how's Sipho doing?" — as a general wellbeing
    check, not what it meant in context. **The first fix was itself a
    mistake, caught and corrected live**: forcing "how's X doing" to
    always mean work status was still a guess, just a different one —
    it would have confidently answered wrong the moment someone
    genuinely meant wellbeing. Corrected to Principle 24: never guess
    which interpretation of an ambiguous question was meant; share
    real, known facts about the person anyway, since withholding
    known information on a technicality of wording is worse than
    answering something slightly off the literal question. Verified
    live: "how's Sipho doing?" now correctly surfaces his real job
    assignment.

**2026-07-13, real multi-intent processing — the architectural
response to a real problem named directly: a beta user's first
message will be exactly as wide as a real conversation, and if
compound messages can't survive contact with the system, there's no
point shipping.** `processTranscript` split into `processOneExtraction`
(the reusable core — internal logic UNCHANGED from the proven single-
intent version) and a thin outer wrapper that logs the raw capture
once, splits a message into genuinely separate topics via
`extractMultipleIntents`, and runs each one through the same
guard()/record logic that already existed per intent. Deliberately
built the safe way: `extractMultipleIntents` reuses `extractIntent`
unchanged on each identified segment rather than duplicating its
large, carefully-tuned prompt. `ProcessResult` gained `pendingActionIds`
(a real array — a compound message can hold more than one guard()d
item) alongside `pendingActionId` for backward compatibility. Seeded
immediately with a real, compound message (an invoice, a job
observation, two reminders) and found three real bugs in the process,
each one only visible because the previous one got fixed:
34. **A work-observation segment naming only an installer, no separate
    customer, had the installer's name forced into `customer_name`**
    since it was the only name available — creating a job scope linked
    to the wrong entity. Root cause was in `extractIntent`'s own
    customer_name/character_name distinction, not the split — it would
    have misfired the same way even in a single, non-split message
    with this exact phrasing. Fixed with an explicit rule: who's DOING
    the work is never customer_name, even when no other name exists to
    fall back to.
35. **Fixing #34 exposed a real, direct consequence**: `recordWorkObservation`
    required a non-null `customerId`, so a correctly-resolved "no
    customer named yet" would have silently dropped the entire
    measurement. Fixed to record with a null customer link rather than
    lose it — Principle 22 applied directly. Also caught, before
    shipping: the message-building code used a `customer!.name` non-
    null assertion that would have thrown the moment a work
    observation genuinely had no customer — same pattern as two
    earlier crashes this session, caught this time before it reached
    production.
36. **The split itself over-triggered on the word "and" as a topic
    boundary**, breaking one continuous work observation ("Sipho is
    measuring the hospital and theatre one is three by two") into two
    incomplete fragments — a room's dimensions separated from the job
    observation they belong to. Fixed with an explicit rule ("and"
    does not by itself mean a new topic) rather than relying on one
    example to convey it implicitly, plus a directly matching example.
37. **A real, confirmed live crash (error 1101)**, traced precisely
    rather than guessed at: fixing #35 in code wasn't enough, because
    `job_scopes.customer_id` had a real `NOT NULL` constraint in the
    live schema that a TypeScript type change alone can't touch.
    Confirmed via direct schema introspection (`PRAGMA table_info`,
    added as a real, reusable diagnostic route) rather than
    reconstructing the schema from memory of the code that reads it.
    Fixed with a careful, atomic table-recreation migration (SQLite
    can't relax a NOT NULL constraint via a simple ALTER) — every real
    column preserved exactly, IDs preserved exactly since
    `job_scopes.id` is referenced by `scope_components`/`scope_tasks`.
    **Verified with a real before/after row-by-row comparison**, not
    just "it deployed successfully" — 7 job scopes before, 7 after,
    identical IDs, identical data, zero loss.

All four bugs fixed, verified live together in the original compound
message that surfaced them: a real invoice correctly guard()'d, a
real job scope correctly linked to the right entity with no crash,
and the two reminder-shaped segments (already independently verified
correct — a real task, a real character note) all recorded from one
message, each in its own correct home.
38. **One more found during the migration's own verification, not the
    feature itself**: `/debug/job-scopes` used an `INNER JOIN` against
    customers — which silently excludes any row with a `NULL`
    `customer_id` from the view entirely, real data sitting untouched
    in the table but invisible to the debug route meant to show it.
    Not a data-loss bug, a visibility bug, but a real one now that a
    job scope can genuinely have no customer yet. Fixed to `LEFT
    JOIN`. Caught precisely because verification didn't stop at "the
    migration ran successfully" — it went looking for the specific
    row it expected to see and found it missing, which is what
    actually surfaced this.

**The whole arc, five real bugs deep, closes with one thing worth
naming plainly: every single one was found because testing kept going
past the point where things "looked fixed."** The Sipho fix revealed
the over-split; the over-split fix and the nullable-customer fix
together revealed the live crash; fixing the crash and verifying it
properly revealed the debug view's own blind spot. None of these
would have surfaced from a single pass of "does this work now?" —
only from checking the actual, specific thing each fix was supposed
to produce, every time.

**2026-07-17:**
39. **A parallel storage channel bypassed a gate applied to its
    primary channel.** Found while directly, live-testing the freshly-
    extended customer-scope permission gate with three real sessions —
    Owner, Installer, Accountant, each asking "what does Jenny owe?"
    Installer correctly received the honest refusal for the structured
    financial summary ("Jenny's financial balance exists but is
    restricted for your role") — then, in the very same response,
    received the identical fact anyway: "Jenny paid R500," verbatim,
    from a completely separate code path. `getCustomerFinancialSummary`
    was correctly gated behind `can_know_debtors`; the raw-transcript
    customer-note fallback (`appendCustomerNote`), which fires for any
    non-question, non-personal-errand message about a customer, was
    gated by nothing at all — it had been silently duplicating every
    payment, invoice, quotation, and priced job into an ungated note
    since the fallback was first built, entirely independent of the
    structured tables that were later given real permission gates.
    Fixed by excluding any intent with its own real structured storage
    (payment, expense, invoice, quotation, price_scope,
    work_observation) from the raw-note fallback — it now only fires
    for genuinely narrative facts with no other structured home,
    exactly its original purpose. Verified with a brand-new customer
    (no pre-existing note to leak from): Installer received only the
    honest restriction, nothing else. Real, decisive proof, and the
    same discipline as always — the leak was found by testing the real
    thing, not assumed fixed once the primary gate was in place.

40. **A pronoun-continuation clause wrongly treated as its own topic.**
    Found while testing the newly-built line-item discount feature —
    "Quote for Jenny - supply and fit vinyl for R8000, give her 10
    percent off that" produced a real quotation for the full R8000,
    the discount silently missing. Checking the actual stored
    `source_transcript` on the pending action revealed why: the
    discount clause was never part of it at all. `splitIntoTopics`
    had separated "give her 10 percent off that" into its own segment,
    which classified as a generic "note" and vanished with no
    connection to the quotation it was meant to modify — the pending
    action's own stored payload was the direct evidence, not a guess.
    The same underlying shape as bug #36 (over-splitting on "and"),
    but a different linguistic trigger: a pronoun ("that") referring
    directly back to something just stated is exactly as strong a
    continuation signal as "and," and the splitter had no rule
    covering it. Fixed with an explicit rule and a real worked example
    in the splitting prompt. Verified twice — `/debug/split-topics`
    directly confirmed the clause now stays attached, and the full
    end-to-end flow produced a correct R7,200 quotation, itself
    verified against the raw stored `discount_percent` and
    `line_total` on the pending action, not just the summary message.
    The discount feature itself was correct throughout; it simply
    never received the information it needed until segmentation was
    fixed first.

41. **A third-party dependency type-checked and bundled cleanly, then
    failed at actual runtime.** Building PDF text extraction: `unpdf`
    installed cleanly, its real API was verified directly (installed
    locally, inspected the actual type definitions rather than
    guessed), and `tsc` found zero errors. Deployed successfully.
    Uploading a real PDF failed anyway — "Serverless PDF.js bundle
    could not be resolved: TypeError: Object.defineProperty called on
    non-object" — a failure specific to `unpdf`'s own internal dynamic
    resolution of which PDF.js build to use, only reachable at actual
    runtime inside the real Workers sandbox, invisible to local
    type-checking or bundling. Fixed by switching to `pdfjs-serverless`
    directly — the lower-level, zero-dependency package `unpdf` itself
    wraps — avoiding whatever dynamic resolution step was failing.
    Verified live: real, correct text extracted from a real PDF
    (Office's own generated quotation, round-tripped through upload
    and extraction). The same underlying principle as bug 37/38
    (verify against live reality, don't assume from what compiles) —
    applied here to a third-party dependency's actual runtime behavior
    rather than the project's own schema, a genuinely broader instance
    of the same failure shape.

**2026-07-20 — the first real, live provisioning run, Zululand
Flooring's own genuinely isolated instance:**

42. **A resource-creation command's own output format didn't match
    what the parsing regex was written against.** The KV namespace
    creation step's ID-extraction regex was anchored to the older,
    TOML-style output (`id = "..."`); the actual wrangler version in
    use (4.86.0) outputs JSON (`"id": "..."`) by default. Found live —
    the KV namespace was genuinely created successfully, but the
    workflow failed anyway because it couldn't read back the ID it
    needed for the next step. Fixed the same robust way D1's own
    parsing already worked: extract the ID by its real shape (32 hex
    characters) rather than depending on any particular surrounding
    syntax, so it doesn't matter which format a given wrangler version
    defaults to.
43. **`wrangler deploy` needs a real permission no documentation
    checked surfaced: User → User Details → Read.** Every account- and
    zone-level permission already confirmed correct (D1, R2, KV,
    Vectorize, Workers Scripts, DNS) still wasn't enough — deploy
    itself needs to verify who's using the token, a genuinely separate
    permission category (user-level, not account or zone-scoped) from
    everything already researched. Found only by an actual failed
    deploy; the error message itself named the missing permission
    precisely.
44. **`wrangler kv namespace list --json` failed outright: "Unknown
    argument: json."** The same `--json` flag confirmed working for
    `wrangler d1 list` (and used successfully elsewhere in this same
    workflow) isn't supported by every wrangler subcommand — a real,
    undocumented inconsistency across the CLI, not a single bug so
    much as evidence the CLI's own flag support can't be assumed
    uniform. Fixed by moving both the D1 and KV existence-checks off
    wrangler's CLI list output entirely, onto the raw Cloudflare REST
    API directly — the same, more reliable pattern already proven
    working elsewhere in this exact workflow (the zone lookup, the DNS
    record check), now applied consistently rather than mixed with a
    CLI dependency that had just proven unreliable.
45. **Binding a deployed Worker to its actual URL route needs its own,
    separate zone-level permission: Zone → Workers Routes → Edit.**
    The script itself deployed successfully — real, visible upload
    confirmation, correct bindings shown — and only then failed,
    specifically on the request to attach the route. A different
    permission from DNS:Edit, even though both are scoped to the same
    zone; confirmed against Cloudflare's own official Workers
    documentation, not guessed, once the precise, real error pointed
    at what was missing.

**All four found only by actually running the pipeline, never by
research alone** — the same discipline this whole bug archive has run
on from its very first entry, now proven true for infrastructure, not
just conversational extraction. Verified fully working, end to end,
immediately after: `/health`, `/debug/smoke-test`, and the real,
correctly-seeded Owner membership all confirmed independently on the
new, genuinely separate instance.

**2026-07-21 — found while testing the very first item on a routine
follow-up list, the most serious bug this project has found:**

46. **The model fabricated a real quotation from a message that never
    stated a price at all.** "Measured Thabo lounge at twenty five
    square meters, fitting laminate" — no rand figure, no rate, no
    price language anywhere — produced a real, held-for-confirmation
    quotation for R625 (25 sqm × a fabricated R25/sqm rate). Traced to
    `extractScopePricing`'s own system prompt, which opened with "a
    tradesperson is stating prices to apply to a job that was already
    measured" — a presumption, baked into the very first sentence,
    that a price exists to be found. The prompt also echoes each
    component's real, already-known area back to the model as context
    (`"Thabo lounge (25 sqm)"`) — and on this message, the model
    mistook that already-given area for a stated rate, since the same
    number ("twenty five") appeared in the transcript too. Every other
    failure shape in this archive is about a real, stated fact being
    dropped, misattributed, or misrouted — this is the first found in
    the opposite direction: a fact that was never stated at all,
    invented instead. Given this touches real money and a real,
    confirmable action, it's the most serious bug found this project,
    not just a new pattern.
    - **Fixed in two layers, deliberately not relying on the prompt
      alone.** The primary, load-bearing fix: a real, deterministic
      gate (`transcriptMentionsPricing`) checks the transcript itself
      for actual price language — "rand," "R" followed by a digit,
      "price," "rate," "cost," "charge," "quote," "discount," or "per
      sq/square/m2/metre/meter" — before the pricing extraction is
      ever called at all, on both call sites that could reach it. The
      model is never asked to judge whether a price exists; a
      deterministic check decides that first, matching the exact
      discipline already proven everywhere else in this project. The
      secondary fix: the prompt itself now explicitly states a price
      may not exist at all, includes an instruction that finding
      nothing means returning an empty result rather than inventing
      one, and — critically — includes a real, negative worked example
      showing the exact failure case (the Thabo transcript) correctly
      producing `{"priced_items": []}`. A prompt that never shows what
      "nothing found" looks like implicitly teaches a model that
      finding something is always the expected, correct outcome.
    - **Verified on both sides, not just the failure case.** The exact
      failure transcript, re-run after the fix, correctly produced only
      a job scope, no quotation, `pendingActionId: null`. A genuine,
      correctly-priced case ("twenty square meters... at two hundred
      rand a square meter," a fresh customer to avoid an unrelated
      job-scope-matching ambiguity from the first retest) correctly
      produced a real R4,000 quotation — proving the fix closed the
      hallucination without breaking the real, legitimate case it
      needs to keep working.

## Purchase Orders, Goods Received Notes, and Supplier Invoices — a real, three-way design for implementation (2026-07-19)

**The problem this closes, and why it's not a fresh idea in isolation.**
Everything built so far tracks money flowing *in* — quotations,
invoices, payments. Nothing structured tracks money and materials
flowing *out*, to suppliers. This is precisely the missing data behind
something already pinned: the Heartbeat/Pulse refinement used "a
delivery arrives short" as a worked example of reality deviating from
expectation, but nothing exists today to ever detect that, because
nothing records what was ordered, what actually arrived, or what a
supplier actually billed for it. This document is that missing
foundation, designed properly rather than smuggled in as a side effect
of something else.

**Correcting my own earlier suggestion, on the record:** proposed
collapsing receipt and billing into one event ("the tiles arrived,
R380 a sqm, 20 short, all in one breath"). That's real and worth
supporting as a *shortcut* for the common, honest case — but a genuine
three-way structure is the correct default, not an oversimplification
worth keeping. A supplier's formal invoice frequently arrives
separately from the delivery, sometimes weeks later, and needs
reconciling against both what was ordered and what actually showed up
— standard accounts-payable practice, not enterprise complexity nobody
asked for.

### The three stages, and what each one actually is

1. **Purchase Order (PO)** — a real commitment, not yet a transaction.
   Peter tells the system he's ordering something; nothing financial
   happens yet. "Order 160 sqm of carpet tile from Floornet at R380 a
   square meter." Attaches to a supplier (`characters`, same as every
   other supplier relationship already built), not `customers` — a PO
   is the mirror image of a Quotation, Peter → Supplier instead of
   Peter → Customer.

2. **Goods Received Note (GRN)** — the delivery actually arriving,
   recorded as a distinct, separate event. "The Floornet delivery
   arrived, but it was only 140 sqm." Reconciled against the *open* PO
   it fulfills — a PO can have multiple GRNs against it (partial
   deliveries over time), and its status advances as GRNs accumulate.
   A GRN is about physical quantity received, not price — the
   supplier's invoice may not exist yet at this point.

3. **Supplier Invoice** — the supplier's own formal bill, a genuinely
   separate document from the GRN, arriving on its own timeline. "Got
   Floornet's invoice, 140 sqm at R390 a square meter." This is where
   real money moves — confirming a supplier invoice creates a real
   expense, the same way confirming a customer invoice already creates
   real revenue. Reconciliation happens here, deterministically: billed
   quantity checked against received quantity (from the GRN), billed
   price checked against expected price (from the PO). Any real
   discrepancy is a computed fact, never an AI judgment call —
   Principle 1 and Principle 24's discipline, applied to money leaving
   the business the same way it's already applied to money arriving.

**The shortcut worth keeping for the honest, common case:** if Peter
narrates receipt and billing together in one breath, the system should
recognize this and create a GRN and Supplier Invoice together in a
single confirmed action, rather than forcing an artificial two-step
conversation. The three-stage *data model* stays real either way; the
*conversational* path can legitimately collapse two of the three steps
when that's genuinely how it happened.

### Real data model

- **`purchase_orders`** — id, character_id (supplier), description,
  status (draft/partially_received/received/cancelled), created_at,
  source_transcript. Same guard()/pending-action lifecycle already
  proven for quotations — a candidate PO held for confirmation before
  it's real.
- **`po_line_items`** — id, purchase_order_id, description,
  quantity_ordered, unit, unit_price_expected.
- **`goods_received_notes`** — id, purchase_order_id, received_date,
  source_transcript, created_at.
- **`grn_line_items`** — id, grn_id, po_line_item_id,
  quantity_received. Linked back to the specific PO line item it's
  fulfilling, not just the PO as a whole — a real delivery can be
  short on one material and correct on another in the same shipment.
- **`supplier_invoices`** — id, character_id (supplier),
  purchase_order_id, description, amount, status, source_transcript,
  created_at, supplier_reference (the supplier's own invoice number,
  when given — genuinely useful for later disputes, never invented if
  not stated).
- **`supplier_invoice_line_items`** — id, supplier_invoice_id,
  po_line_item_id, quantity_billed, unit_price_billed, line_total.

**Deliberately not replacing the existing, simple expense flow.** A
quick, informal purchase ("bought glue for R850 at BUCO") has no PO,
no GRN, no formal supplier relationship worth tracking — it stays
exactly as `expenses` already handles it. This system is for the
*formal*, ongoing supplier relationships (bulk material orders) that
genuinely have a real order-to-delivery-to-billing lifecycle worth
tracking. Confirming a supplier invoice creates a real `expenses` row
too, same as today, just with real provenance attached (linked back to
its PO and GRN) — richer, not a parallel, competing system.

### Deterministic reconciliation — the actual point of building this

The whole value of a three-stage model is the two comparisons it makes
possible, both computed in code, never asked of the model:

- **Quantity variance**: `quantity_billed` (or `quantity_received`)
  against `quantity_ordered`. 140 vs 160 ordered is a real, computed
  12.5% shortage — a fact, stated plainly, not an AI's impression that
  "it seems a bit short."
- **Price variance**: `unit_price_billed` against
  `unit_price_expected`. R390 vs R380 expected is a real, computed
  R10/sqm variance — again, arithmetic in code, the model's only job
  is recognizing the numbers actually stated.

Both variances become real, stored facts on the supplier invoice
record itself — visible on request, and exactly the kind of structured
signal the Heartbeat/Pulse refinement needs before "a delivery arrived
short" can ever become a real, live observation rather than a
hypothetical example in a pinned document.

### Real, open design questions — deliberately not decided here, worth deciding before code, same discipline as everything else

1. **Does a PO need its own confirmation step, or can it sit as loose
   intent until goods arrive?** Leaning toward keeping the PO itself
   lightweight — the real, consequential confirmation is the GRN and
   Supplier Invoice, since that's where money and stock actually move.
   A PO existing without ever needing Peter's explicit sign-off might
   be the right call, but this is a real decision, not a default.
2. **Does a real, computed discrepancy automatically become a
   Heartbeat/Pulse observation, or just a stored fact Peter can ask
   about?** Given Pulse's own gate (not earned until real accumulated
   volume exists), the honest answer is: store the discrepancy as real
   data now, let it become an observation only once that mechanism is
   actually built — not before.
3. **Partial GRNs against one PO — how does "received" status actually
   resolve?** A PO with three line items, two fully received and one
   still outstanding, needs a real, defined status model, not an
   assumed one.
4. **What happens when a supplier invoice references *no* PO at all**
   (a genuinely ad-hoc supplier bill, no formal order ever placed)?
   Should this be rejected, or accepted as a standalone supplier
   invoice with no reconciliation possible? Real businesses do
   sometimes get billed for things they never formally ordered.

**Explicitly not for implementation now** — a real, substantial design,
deserving the same weight as Layer 2's own pending design pass, not a
same-session build. Pinned so the thinking survives intact until it's
genuinely its turn.

## Consumables stock and stocktakes — a narrower, more honest scope than "inventory" (2026-07-19)

**The real question worth asking plainly before designing anything:
does a flooring contractor actually need inventory, in the traditional
sense?** Mostly, no. Carpet, tile, vinyl — the bulk of material —
gets ordered *per job*, arrives, gets installed, and is fully consumed
by the PO/GRN system above. That's not inventory. A full SKU-based
warehouse system with reorder points and stock locations would be
real over-engineering for a business that doesn't hold generic stock
waiting for the next sale — exactly the enterprise-completeness
Principle 12 already warns against building for a business that never
asked for it.

**What's genuinely real, and the only part worth designing for now:
consumables.** Glue, screed, adhesive, trims, small tools — bought in
bulk, drawn down gradually across many jobs, worth a real, running
quantity on hand. A meaningfully narrower scope than "inventory," and
the honest one.

### The design

- **`stock_items`** — id, name, unit, quantity_on_hand (a real,
  deterministically-maintained running total, never estimated),
  reorder_threshold (optional, for a future low-stock observation, not
  built yet), created_at.
- **Incremented** by a confirmed GRN for a genuinely generic,
  non-job-specific material (screed, glue) — distinct from job-specific
  materials (carpet, tile) ordered via the same PO/GRN system, which
  are consumed by that one job and never touch stock at all.
- **Decremented** by recorded usage — a new, real intent ("used 5
  liters of glue on Jenny's job") linking a stock drawdown to the real
  job it was consumed on, the same subject-attribution discipline
  already proven (Principle 24) applied to a new case: who or what
  this sentence is actually about.
- **`stocktakes`** — id, conducted_date, source_transcript. A real
  event: a physical count.
- **`stocktake_lines`** — id, stocktake_id, stock_item_id,
  quantity_counted, quantity_expected (captured at the time, from the
  system's own running total), variance (computed deterministically —
  counted minus expected, never an AI's impression of "seems about
  right"). The exact same reconciliation philosophy as PO/GRN/Supplier
  Invoice above, one layer further: a real discrepancy between what
  the system believes and what's physically true, stated as a fact,
  not judged.

**A real, honest dependency, not an arbitrary sequencing choice: this
needs PO/GRN to exist and be genuinely proven with real usage before
it means anything.** Quantity on hand is only ever as trustworthy as
the GRN data feeding it — building stock tracking before that
foundation is real would be building relationship on top of truth that
doesn't exist yet, precisely what Principle 28 already named as the
wrong order.

**Real correction, made the same session, on the record rather than
silently fixed:** point 1 below originally framed job-material remnants
as a rare edge case worth explicitly excluding. A real, concrete
example corrected that — a PO for 50m² vinyl, a 100m² roll of underlay,
and 10 lengths of skirting, against a real invoice for 50m² vinyl,
50m² underlay, and 8 skirtings. That excess (50m² underlay, 2
skirting lengths) isn't a rare remainder — it's a near-certain,
structural byproduct of how ordering actually works: materials come in
fixed pack sizes (a full roll, a bundle of lengths), and a specific
job's real need almost never matches that round quantity exactly.
"Job-specific material is fully consumed by the job it's ordered for"
was the wrong assumption underneath the original design above — the
excess has to live somewhere, meaning it becomes real stock the moment
a PO's ordered quantity is reconciled against what a job's real
invoice/usage actually consumed. **This is the same real phenomenon
already named, from a different angle, in the go-to-market document's
ranked feature candidates** — "pack-size rounding arithmetic and cut
lists" was already called the single highest-leverage untouched idea
there, precisely because it forces this exact structured data (roll
width, wastage, pack efficiency) into the system as a byproduct of
normal ordering, not something anyone narrates on purpose. Two
separate threads finding the same real thing from different
directions — worth trusting precisely because it wasn't found once.

**Real, open questions, deliberately not decided here:**
1. Given the correction above, job-specific material *does* need a
   real remnant-tracking path — not excluded, but the real mechanics
   (how a PO's ordered quantity minus an invoice's actual consumed
   quantity becomes a genuine stock increment, tied back to which pack
   size it came from) are a real design task of their own, not yet
   worked out here. **A real requirement this surfaces:** `stock_items`
   needs product-code specificity, not just a loose material name —
   "ERP308 skirting" is a specific supplier profile, genuinely
   different from another profile like ERP205, not a variant of one
   generic "skirting" item. Without a real product-code/reference
   field, two different remnants would incorrectly merge into one
   count. **And the actual business value worth stating plainly, not
   left implicit:** the whole point is a real, accurate answer to "how
   many lengths of ERP308 do we have?" directly preventing an
   unnecessary order — the same conversational-query discipline
   already proven everywhere else (Principle 24: AI recognizes which
   product is being asked about, deterministic code returns the real,
   current quantity, never a guess or a recollection). This is the
   concrete case for why remnant tracking is worth building at all, not
   just an interesting capability sitting alongside everything else.
2. Does a stocktake variance ever become a Heartbeat/Pulse observation
   (unexplained shrinkage worth flagging), the same open question
   already named for PO/GRN discrepancies above? Same answer likely
   applies: store the real variance now, let it become an observation
   once that mechanism actually exists.

**Explicitly not for implementation now**, and explicitly third in a
real, honest dependency chain — behind PO/GRN/Supplier Invoice, which
themselves are behind nothing but their own design being finished.
Pinned in the same breath it was thought through, not built ahead of
what it depends on.

## Room visualizers — a real, evidence-based answer, not a speculative one (2026-07-19)

**The open question, closed with actual research rather than left as a
guess.** Discussing what "The Office" should and shouldn't cover
raised whether a room/floor visualizer belongs in scope. Checked
directly rather than assumed: Belgotex has no visualizer anywhere on
its site. Azura has a real "Room Visualizer / Floor Visualiser / Rug
Visualiser." Finfloor has one too — and fetching the actual page
directly (not just a search summary) revealed the decisive detail: it
isn't custom-built. The page literally announces launching Roomvo, a
third-party visualization platform, and the button on the page calls
`roomvo.startStandaloneVisualizer()` directly.

**Sharper still: both Finfloor and Azura actively encourage flooring
*contractors* — not just their own retail sites — to embed their
licensed visualizer on the contractor's own website.** A real,
practical, near-term opportunity worth acting on independent of
anything here: Zululand Flooring likely already qualifies for one of
these, free or near-free, through its existing supplier relationships.

**A real correction to the reasoning, made the same session — the
original conclusion had the wrong justification underneath it.** The
actual point being made wasn't "contractors already have their own
websites to embed this on." Many don't — a real, common case, not an
edge one. The actual goal is sharper on-site decisions, standing in the
customer's room, with no website involved on either side. That's a
different, better question, and it changes what's worth checking.

**Checked directly, honestly, rather than assumed either way: no
confirmed evidence exists that Roomvo (or similar platforms) offers a
real API for a third-party *app* to integrate with directly.** Their
actual integrations are website/e-commerce platforms (Shopify,
Magento) — their product is fundamentally a website-embed tool, not an
API-first service for someone else's app to call. Worth being honest
about this as a real limitation rather than assuming integration is
possible just because the capability exists somewhere.

**But the underlying goal doesn't need that API at all — a much
simpler answer already exists.** Finfloor's and Azura's visualizers are
public web tools. A contractor standing in a customer's room, with no
website of their own, can simply open `finfloor.co.za` or `azura.co.za`
directly in a phone's browser and use the real, working visualizer
immediately. No integration, no API, no building required. The "no
website" problem was never actually a blocker for the on-site case —
it would only have been one if the visualizer only lived embedded on
some other contractor's own site, which isn't how these tools actually
work.

**The real, evidence-based conclusion for Office, and the honest reason
behind it — not the one first written:** not "no gap because everyone
has a website," but "no gap because the supplier's own public tool
already serves exactly the on-site, standing-in-the-room case, on the
same phone Office already lives on, and no confirmed path exists to
fold that capability into Office even if it seemed worth attempting."
Building a visualizer from scratch would still be solving an
already-solved problem — exactly what Principle 12 warns against.
Office stays disciplined about what it actually is: a trusted record of
what happened, not a customer-facing image generator competing with
tools that already reach the people who'd use them, on the device
they'd already be using them from.

**A real correction to this whole conclusion, made in the same
session — the actual concern was sharper than "no website exists,"
and it changes the answer.** The real point: showing a customer a
supplier's own branded visualizer in the room, mid-sale, hands them
the exact name of the supplier — a genuine disintermediation risk, not
a small one. A customer who now knows precisely which brand and which
product can shop that around to another installer, or go directly to
the supplier. "Just open the supplier's site" doesn't solve this; it
actively creates it.

**Real, new evidence found the same session that reopens this
properly, rather than leaving the earlier conclusion standing
uncorrected:** Cloudflare Workers AI — the exact infrastructure this
project already runs on for transcription and vision-description — has
real, documented image-editing models, callable the identical way
every other AI call in this codebase already works (`env.AI.run(...)`).
Stable Diffusion Inpainting takes a photo, a mask marking a specific
region, and a prompt, and edits just that region. FLUX.2 unifies
generation and editing with multi-reference support — plausibly
capable of taking a room photo and a separate photo of the actual
flooring product, and compositing them together. This would happen
entirely within Office's own infrastructure — no supplier website, no
branding, no name ever shown to the customer. Not rebuilding Roomvo's
platform; a much narrower, specific thing — one photo in, one photo
out.

**Real, honest uncertainty, not overclaimed:** the model existing and
being callable is a different claim from it producing genuinely
convincing results for this specific case. Realistic floor replacement
— correct perspective, correct lighting, correct shadow — is a
genuinely hard computer-vision problem, and this hasn't been
prototyped or tested. A real, promising, technically-grounded avenue,
not a proven solution.

**Where this leaves the question:** not closed. The earlier "no gap to
fill" conclusion was reasoning from the wrong justification and is
superseded by this — a real, unbranded, in-app visualization may be
genuinely achievable using infrastructure already proven elsewhere in
this project, protecting exactly the supplier relationship a contractor
depends on. Worth a real prototype — a masked room photo, a product
texture, one actual generation call — before deciding anything further,
the same evidence-before-commitment discipline as everything else here.

## Layer 2 (Project) — a real design pass with Claude Fable 5, verified rather than accepted (2026-07-20)

**A genuinely productive use of a one-time premium credit, and the
right way to spend a limited one — one focused pass, not spread thin.**
A separate Fable 5 session was briefed with the real Calypso Centre
evidence and pointed at the actual repo. The result was checked line by
line against the live schema before being trusted, the same discipline
applied to every claim in this project regardless of source.

**What held up, verified directly, worth keeping:**
- **The proximity-in-time rejection is correct, and it's the sharpest
  point in the whole design.** A tunable day-window as a matching
  signal is a guess wearing code's clothing, not a real deterministic
  one — the same standing discipline already proven everywhere else,
  correctly applied here rather than relaxed for convenience.
- **"`job_scopes` has no site column" — confirmed exactly** against the
  real, live schema (`id, customer_id, description, scheduled_date_raw,
  source_transcript, created_at, scheduled_date, installer_id`).
  "Same site" as a matching signal genuinely isn't implementable
  without a real schema addition first.
- **A real, embarrassing correction to this project's own Constitution
  citation, confirmed accurate:** Principle 24's real title is "Share
  What's Known, Don't Guess What's Meant," not "The Execution Ladder"
  — that's a separate, related document living in this file, not in
  `OFFICE_CONSTITUTION.md` at all. A real error in an earlier brief,
  caught by a fresh reader actually checking the source rather than
  trusting a paraphrase.
- **Reusing the existing rung-based resolution (Principle 24) for
  cross-capture project attachment** — a named handle matches directly;
  exactly one open candidate auto-attaches; two or more asks rather
  than guesses; zero leaves the scope standalone — is a sound,
  minimal-new-mechanism design, consistent with how every other
  ambiguous-match problem in this project has already been solved.

**What didn't hold up — the central, load-bearing claim, corrected with
real evidence rather than taken on faith:** "co-birth (same capture ∧
same customer) is a fact the receptacle recorded" was checked directly
and is not accurate. `captureId` genuinely exists and flows through the
processing pipeline as a real parameter — but it is only ever used to
update the `captures` table's own hint and text. It is never passed
into `recordWorkObservation`, and `job_scopes` has no `capture_id`
column at all. The infrastructure to capture this signal is real and
close — one parameter away — but the signal itself does not exist in
stored data today. "Already exists and is being ignored" was the wrong
framing; "doesn't exist yet, genuinely cheap to add" is the honest one.
A second, related claim in the same design — "quotations reach the
project through edges that already exist" — has the identical problem:
`quotations` has no `job_scope_id` column, confirmed directly against
the real INSERT statement. The connection to a job scope is looked up
once at creation time and never persisted; there is no existing edge to
traverse.

**What this means for the design's own "one table, one column"
footprint claim: understated, not wrong in spirit.** The real footprint
is closer to a `projects` table, `project_id` on `job_scopes`, *plus* a
new `capture_id` on `job_scopes` (to make same-breath detection
possible at all), *plus* either a real edge from quotations/invoices
back to their job scope, or an honest acceptance that those documents
only ever reach a project transitively and imprecisely, not directly.

**On contact-at-entity staying genuinely separate from Project:** the
design's case (different evidence, different structural problem) is
sound in its core logic, though one supporting detail was imprecise —
Alfons *was* named in direct connection with the Calypso site (as the
building's owner) in the same real test that motivated Project, so
"Calypso contains no named site contact" overstated the separation
slightly. Doesn't change the underlying conclusion — a person's
relationship to an organization and a job's relationship to other job
phases remain genuinely different kinds of gaps — but worth the
correction on record rather than repeating an overstated version of a
correct conclusion.

**Explicitly not for implementation now** — a real, sharpened design,
not a finished one. The next real step is deciding whether to actually
add `capture_id` to `job_scopes` and thread it through
`recordWorkObservation`, which would make same-breath project assembly
genuinely buildable rather than theoretically clean. Pinned so this
verified, corrected version — not the original, partially-inaccurate
one — is what survives.

## Real, unpinned gaps found surveying the complete flooring contractor lifecycle (2026-07-21)

Found while deliberately walking the full lead-to-warranty lifecycle of
a real flooring job, looking for what's missing even from everything
already built or pinned. Four real, distinct gaps, none built, none
previously written down anywhere.

**The lead/enquiry stage has no home at all.** Everything built so far
assumes a customer and a quotation exist together — there's no concept
of "someone enquired, hasn't been quoted yet." A real business has a
stage before that, and losing it means losing real signal: no way to
answer "how many enquiries turned into quotes," no way to distinguish
"genuinely interested, not yet priced" from "quoted and gone quiet."
Quotation win-rate — floated once already as a candidate feature — has
no foundation to stand on without this. Real shape, roughly: a `leads`
table (a name/contact, what they're interested in, a source, a status
— enquired/quoted/won/lost), converting into a real customer and
quotation once it's priced, not duplicating that data.

**Snag lists don't exist anywhere — a real, standard, industry concept,
not an edge case.** After an install, defects get found — a gap at a
skirting joint, a seam that lifted, a colour that doesn't quite match.
Real flooring businesses track these as their own thing, with their own
resolution status, separate from the original job scope that's already
"done." Genuinely absent from every document written tonight, including
the ones that went deep on job scopes specifically. Real shape,
roughly: a `snags` table linked to a `job_scope_id`, a description, a
status (open/resolved), maybe a resolved-by-installer reference — small,
bounded, and directly useful the same day it's said aloud ("there's a
gap at the skirting in Jenny's lounge").

**Warranty and guarantee tracking has no home.** "This carpet carries a
10-year wear warranty" is a real, common promise a flooring business
makes, and needs to be answerable for, potentially years later, by
someone who wasn't in the room when it was said. Nothing captures this
today — not on an invoice, not as a customer fact, nowhere. Real shape,
roughly: attached to the invoice or job scope it applies to, a real
term and a real start date, queryable the way any other structured fact
already is.

**Payroll and bank reconciliation are permission names with no feature
behind them — the sharpest, most concrete finding here.**
`can_know_payroll` and `can_know_banking` both exist in the real,
live `ROLE_CAPABILITIES` map, granted to Owner and Accountant — but
there is no payroll data model and no bank-feed or reconciliation
concept anywhere in this project. The permission system is quietly
assuming two features that were never actually designed, let alone
built. Not urgent to build either — but worth naming precisely, since a
capability that gates nothing real is a different kind of gap than a
missing feature: it's a promise the permission model is already
making on the product's behalf.

**Explicitly not designed in full here, deliberately** — each of these
is a real, separate design task on the same scale as PO/GRN or
consumables stock, not something to rush through in one pass just
because they were all found in the same lifecycle walk. Pinned so the
real evidence for each survives, in the order they'd likely earn their
turn: snag lists (smallest, most immediately useful) and the lead stage
(foundational to win-rate and several already-pinned ideas) first;
warranty tracking and the payroll/banking gap correctly last, since
neither has real, pressing evidence behind it yet, only the honest
observation that the permission model already implies them.

## Purchase Orders, Goods Received Notes, and Supplier Invoices — the design is now real and built (2026-07-21)

The full three-way design pinned earlier is no longer just a design.
Built incrementally over one real session, tested with real, predicted-
in-advance numbers at every stage — the same discipline that's proven
correct for everything else in this project, applied here to the
largest single feature built in one sitting so far.

**Purchase Orders** — unguarded, matching the exact precedent already
established for job scopes (a real commitment, not yet a transaction).
Proven live with the original design's own worked example, verbatim: a
real PO for 50m² vinyl, a 100m² roll of underlay, and 10 lengths of
skirting from Floornet, extracted with all three quantities and units
correct, and — critically — `unit_price_expected: null` on every line,
since no price was ever stated. The same hallucination discipline
proven earlier in the session (bug 46) held correctly here too, on the
very first real test.

**Goods Received Notes** — guard()'d, matching the original design's
own distinction that this is where real stock changes hands. Proven
live with the exact shortage scenario that motivated the whole PO/GRN
design in the first place: 50 vinyl delivered clean, underlay short by
50, skirting short by 2 — every number matching the original design
conversation's own worked example exactly. The real, deterministic
variance computation (never asked of the model) is the actual point of
this stage, and it worked correctly on the first real test.

**Supplier Invoices** — the third and final stage, where real money
moves and both real reconciliations (quantity and price) exist for a
reason. Tested three separate ways, since a supplier invoice
genuinely arrives three different ways in real life:

1. **Spoken aloud** — "got Floornet's invoice INV-4471, 50 sqm vinyl at
   R180, 50 sqm underlay at R35, 8 lengths of skirting at R120" —
   correctly computed a real R11,710 total and created a real expense.
   Price variance came back null for every line, correctly — the
   original PO never had an expected price stated, so there was
   nothing to compare against, an honest outcome not a bug.
2. **A real, uploaded PDF** — a genuine test invoice generated and
   uploaded, extracted via the exact same `pdfjs-serverless` text
   extraction already proven earlier the same session, correctly
   identifying a real shortage (30 ordered, 28 billed) from a real
   document's actual text.
3. **A real photographed invoice** — the same test invoice rendered to
   a real JPEG and uploaded as a photo. A genuinely different
   technical path (vision description, not text extraction) — and a
   real, honest finding along the way: an initial test photo was
   cropped too narrow, cutting off the line-item table entirely. The
   vision model correctly reported no amounts were visible in what it
   was actually shown, and the system correctly produced **no**
   supplier invoice action at all rather than a false or empty one —
   the exact same safety discipline that fixed bug 46, holding
   correctly under a genuinely different failure mode this time,
   proven rather than assumed. Once the crop was corrected, the vision
   description preserved every real figure precisely — "28 sqm,
   R220.00, R6160.00" — and the full pipeline worked identically to
   the PDF path.

**A real bug found and fixed live**: the confirm step for the first
real supplier invoice failed with `no such table: supplier_invoices` —
the schema migration had been listed but never actually run before the
confirm was attempted. Verified the pending action was still safely
intact (nothing had been written before the failure), ran the real
migration, and the retry succeeded cleanly — a real, live demonstration
that a failed confirm attempt genuinely doesn't corrupt or lose
anything, matching the same retry-safety discipline already proven
elsewhere in this project.

**Document ingestion — the real design decision made this session,
worth recording precisely**: rather than inventing a new upload
parameter, supplier-invoice extraction from an uploaded PDF or photo
reuses the exact same caption-to-supplier-character reconciliation
already proven for `/files/document` and `/files/photo` — if the
caption names a supplier with a real, open PO, the document's own real,
extracted text (never the caption) is run through the identical
extraction and guard()'d confirmation as the spoken path. One
mechanism, three real entry points, not three separate systems.

**Real, honest limitations, named rather than hidden:**
- A PO is never marked "closed" or "fully billed" — `findLatestOpenPurchaseOrder`
  finds the most recent PO for a supplier regardless of whether it's
  already been fully reconciled. Real, live evidence of this: the
  second and third Supplier Invoice tests both matched against the
  same PO. Not incorrect, just a real gap worth closing once there's
  evidence it causes real confusion.
- Vision-based extraction was proven precise on one clear, well-lit,
  sharp test image. A genuinely blurry or poorly-lit real photo of a
  paper invoice is a real, different test this session didn't cover —
  worth remembering before assuming this generalizes to every real
  photo a phone camera produces in the field.

## A real refinement to PO/GRN/Supplier Invoice, given directly by Pierre the same night, sharpened on a second pass (2026-07-21)

**Superseding the first version of this pin** — Pierre gave a more
precise second pass on the same thinking; this version replaces it
rather than sitting alongside a vaguer draft.

**The real scenario, stated precisely: GRN capture is a two-person
job, not an Office-only one.** Whoever physically receives the goods —
an installer on site, or a clerk at the warehouse — signs the real,
physical delivery note, then photographs it and uploads it. Office's
role there is purely to capture what was actually signed for, using
the exact photo-upload path already built and proven tonight. Goods
delivered straight to site, with no warehouse and no receiving clerk
involved at all, are the normal case this needs to serve, not an edge
case.

**A real, explicit division of what each stage reconciles, confirmed
directly, not left implicit:**
- **The delivery note (GRN) is quantity-only, always.** Confirms the
  existing design correctly, and rules out ever conflating it with
  pricing.
- **The Supplier Invoice is fundamentally a pricing exercise**, married
  against the PO. Quantity is a real, secondary check there — and per
  the reconciliation refinement below, that secondary check should
  compare against the GRN's real received quantity, not the PO's
  ordered quantity.

**The real design need this whole conversation was building toward: a
document-completeness status on the PO**, tracking whether a delivery
note has been received and whether a supplier invoice has been
received — closing the PO only once both are present. Confirmed
explicitly: the two documents sometimes arrive together, in which case
both reconciliations can happen in one motion — but they often arrive
separately, and when they do, the PO needs a real, visible intermediate
state ("delivery note received, awaiting invoice"), not just two
independent events that happen to share a purchase_order_id with
nothing tracking the gap between them. This directly closes a
limitation already named in this same night's own write-up: "a PO is
never marked closed or fully billed." Leaning toward computing this
status live rather than storing it, matching the same "compute on
read" discipline already chosen for partial-GRN status in the original
design.

**The reconciliation refinement, unchanged from the first pass and
still real:** Supplier Invoice reconciliation currently compares what's
billed against what was *ordered* (the PO) — never against what was
actually *received* (the GRN). If a supplier delivers 28 units but
bills for the full 30 ordered, comparing against the PO shows zero
variance and misses the real problem entirely. The GRN is the more
honest source of truth for "what did we actually get."

**A real, open question this second pass surfaced, not yet answered:**
GRN recording was built tonight with no capability check at all — any
authenticated session can currently record one. That happens to
already match what's being described here (an installer needs to be
able to do this, not just Peter), but it was an omission, not a
deliberate decision. Worth a real answer before this gets built
further: should recording a GRN require any specific capability, or is
"any authenticated session can capture a delivery note" the genuinely
correct, intentional behavior — given it only ever touches quantity,
never money?

**Explicitly not built tonight** — a real, precise design captured at
the moment it was given, correctly deferred to tomorrow's "tidy up
loose ends" pass rather than rushed through at the end of a long
session. The three pieces (document status, GRN-based reconciliation,
the GRN permission question) are related and worth resolving together,
not as separate passes.

**Built and proven the same night, sooner than "tomorrow" — all three
pieces resolved:**

1. **GRN permission question, resolved**: GRN capture stays
   deliberately open to anyone in the organisation — no capability
   gate — since it only ever touches quantity, never money. What makes
   it safe is accountability, not restriction: `recorded_by` now
   captures the real, confirming user's actual identity, verified live
   (`pierreduplessis6912@gmail.com` on a real, confirmed delivery). A
   first test showed `null`, correctly — that was a genuine mistake in
   the test command itself (no session cookie sent), not the feature;
   the retest with the cookie included proved it works exactly as
   designed.

2. **Document-completeness status, built**: a real, computed status on
   every PO — "ordered, awaiting delivery" → "delivery note received,
   awaiting invoice" → "closed" — verified live through the full,
   real transition on one real PO, in order, exactly as designed.

3. **GRN-based reconciliation, built and proven with Pierre's own
   exact scenario**: ordered 20m² of grout, delivered only 15m²,
   billed for the full 20m² ordered. The old comparison
   (`quantityVarianceVsOrdered: 0`) shows exactly the blind spot this
   was built to close — billed matches ordered, so nothing looks
   wrong. The new, primary comparison against what was actually
   received (`quantityVariance: 5`) catches the real problem
   precisely. Both figures are kept and returned together, deliberately
   — the old comparison isn't discarded, it's demoted to a secondary
   check, exactly as the design specified, and seeing both side by
   side is itself the proof the fix does what it was meant to do.

All three verified with real, predicted-in-advance numbers before
being trusted, the same discipline as everything else in this project.

## Variance disposition — what happens after a discrepancy is found (2026-07-22)

**The real gap this closes.** Everything built so far *detects* a
variance (a real, computed number) but does nothing with it — no
reason, no resolution, no evidence trail. A real business needs the
next step: why did this happen, and how does it actually get closed
out.

**Three real, distinct reason codes, genuinely different problems, not
one problem with three names:**
- **Short delivered** — a genuine quantity shortfall. Already
  computed today via the GRN-based reconciliation just built; this
  reason code is the missing label on a number that already exists.
- **Incorrectly dispatched** — the wrong item, or wrong specification,
  sent entirely. A different *kind* of problem from a quantity
  mismatch — worth being precise that this might not even match a PO
  line by description the way a real shortage does (it's not "less of
  the right thing," it's "the wrong thing"), so it may need its own
  detection path rather than reusing the existing matched_description
  logic as-is.
- **Damaged** — right item, right quantity, physically unusable. A
  genuinely new dimension neither quantity nor price variance
  currently captures at all — a delivery can show zero variance on
  both and still be a real, damaged-goods problem.
- **Over-receipt** — added after real research into established ERP
  reason-code taxonomy (below); a real, distinct case none of the
  above three actually names, even though the existing GRN variance
  math already computes it (a positive number with no label for what
  it means).

**Real ERP research, done deliberately before finalizing these codes
from scratch — a genuine validation, not just new vocabulary.** SAP's
own goods-receipt/invoice matching splits discrepancies the exact same
way this design already does — quantity variance at the goods-receipt
stage, price variance at the invoice stage — real, external
confirmation the GRN-for-quantity, Supplier-Invoice-for-price
architectural split was the right one, not a coincidence to dismiss.
Oracle's retail invoice-matching system has a real, established reason-
code taxonomy worth comparing directly: Cost Discrepancy, Quantity
Discrepancy, Tax Discrepancy, Credit Note Tax Discrepancy, **RTV
Chargeback** (Return-to-Vendor), Allowance Discrepancy. Mapped against
what's pinned here: short delivered ≈ Quantity Discrepancy;
incorrectly dispatched ≈ mis-pick (the industry term, though
"incorrectly dispatched" is honestly the clearer, plainer wording for
the same real thing); damaged ≈ RTV Chargeback — a real, established
term worth adopting directly for the "damaged → credit" resolution
path, rather than inventing new language for something the industry
already names precisely.

**Two real resolution paths, not just a note:**
- **Back order** — the shortfall remains genuinely owed, expected
  later. The PO line stays meaningfully open past what "closed" (per
  the document-completeness status just built) currently means.
- **Credit** — the supplier formally writes it off; what's actually
  owed is reduced, a real adjustment against the eventual expense, not
  just an annotation.

**A real evidence requirement for damaged goods specifically**: a real
photo (the same upload path already proven for GRN and Supplier
Invoice ingestion), plus what's being called an "endorsement" — the
physical delivery note itself gets annotated and signed at the point
of receipt, with Office capturing that annotation via the same photo,
not a separate mechanism. Worth deciding whether "incorrectly
dispatched" carries the same evidence requirement — a real, open
question, not assumed either way.

**Real, open design questions, deliberately not answered here:**
1. Where does a disposition actually live — a new field on
   `grn_line_items` itself, or a genuinely separate table (a
   discrepancy can arguably have its own lifecycle: raised, evidenced,
   resolved)? Leaning toward separate, given the evidence and
   resolution-tracking needs described above don't fit cleanly as
   columns on an existing row.
2. Does raising a disposition need its own guard()'d confirmation, the
   same as GRN and Supplier Invoice, or does it inherit the
   confirmation of whichever stage it's raised against? Given a credit
   resolution is a real financial adjustment, it likely needs the same
   discipline as every other financial write in this project — worth
   a real, deliberate answer, not a default.
3. Does a "back order" disposition need a real, new PO-like record of
   its own (the remaining, still-owed quantity, trackable through its
   own delivery), or does it just keep the original PO line's
   "closed" status honestly deferred until the shortfall actually
   arrives?
4. Who can raise a disposition — the same "open to anyone, traceable"
   answer already settled for GRN capture itself, or does a credit
   resolution specifically need the same financial-write gate as
   Supplier Invoice, since it's the one path here that touches money?

**Explicitly not built tonight** — a real, substantial new layer,
deserving the same design-first discipline as PO/GRN/Supplier Invoice
itself got, not a rushed addition at the end of a long session. Pinned
precisely so the real distinctions (three different reason codes, two
different resolution paths, one real evidence requirement) survive
intact until this is actually specced and built.

## Cross-role identity collision — a real, deterministic alternative to teaching every ambiguous phrasing (2026-07-22)

**The real problem this replaces, named honestly.** Fixing the "Thabo
upstairs is twenty five square meters" misclassification (below) by
adding a rule and an example is a real fix for that one phrasing, but
not a real fix for the underlying class of problem — natural language
has effectively unlimited variation, and no number of examples ever
converges. Pierre named this directly, and correctly.

**The actual, precise fix: this was never a language-understanding
problem. It's a missing, checkable fact.** Thabo already has an
established identity in this system — a real character, an installer.
The question was never "is this sentence ambiguous," it's "does this
message's role assignment for this name conflict with what's already
on file." That's not something to ask a model to judge better. It's a
direct database lookup, exactly the same "code decides, model only
transcribes" discipline already proven everywhere else in this
project.

**The real, sharp distinction Pierre's own examples draw, worth
building exactly as stated:**
- **"Thabo measure X" / "Thabo is installing Y"** — the extracted role
  (installer, performing work) matches Thabo's already-established
  role. No collision. Stays completely frictionless — this is the
  common case, and it must never gain friction from this fix.
- **"Thabo paid R5000" / "schedule a meeting with Thabo about
  pricing"** — the extraction would place Thabo in a customer-shaped
  role (paying, being quoted), but the only "Thabo" on file is a
  character. A real, checkable mismatch: this name has an established
  identity in one table, and this specific message is trying to use it
  in the other. Reuses the exact same "ask when genuinely ambiguous"
  rung already proven throughout this project (Principle 24's Ladder)
  — not a new mechanism, an application of one already trusted.

**The real mechanic**: before reconciling a newly-extracted
customer_name or character_name, check the *other* table for the same
name too. If it matches nothing there, proceed exactly as today —
zero added friction for the overwhelming majority of real messages. If
it matches an existing record in the other table, that's a real,
detected collision — hold it and ask, rather than either silently
creating a duplicate identity or silently misassigning the role.

**Real, open questions, deliberately not answered here:**
1. What does "ask" actually look like mechanically — a new
   pending-action type requiring a real yes/no answer before anything
   else about the message gets written, or something lighter?
2. If Peter confirms "yes, same Thabo," does the original message get
   reprocessed automatically with the corrected role, or does he need
   to restate it? Reprocessing is more seamless but touches more of the
   pipeline; restating is simpler to build but real friction on an
   already-rare case.
3. Exact-name matching only, or does this need fuzzy matching (a
   nickname, a spelling variant)? Exact-match-only is the safer,
   simpler start — a fuzzy match risks flagging collisions that were
   never real ones.

**Explicitly not built tonight** — this touches the core reconciliation
path every single message in this project runs through; a change at
this scale deserves to be specced properly first, not rushed at the
end of a long session. Pinned precisely so the real distinction (a
checkable fact, not a language problem) survives intact.

## Layer 2 (Project) — same-breath assembly, proven working with real data (2026-07-22)

**The first real success of Layer 2**, built the same night as the
capture_id prerequisite that made it possible at all. A real, phased
job for one customer — "measured Thabo downstairs at forty square
meters for screed, remind me to order more screed, and Thabo upstairs
is twenty five square meters for carpet" — correctly split into three
segments (screed observation, an unrelated reminder, carpet
observation), and the two job scopes born from the same real message
were automatically, deterministically grouped into one real project.
No AI judgment involved in the grouping itself — a real, computed fact
(same capture, same customer) the receptacle already had.

**A real bug found and fixed on the way there, worth being honest
about its actual scope.** The first attempt at this test failed —
zero projects created — and Layer 2's own logic was correctly
suspected first, then correctly ruled out: both job scopes shared the
same real `capture_id`, confirming the grouping mechanism's own
precondition-check worked exactly as designed. The real failure was
upstream — the second job scope's customer reconciliation had silently
failed, because the model misclassified "Thabo upstairs is twenty five
square meters for carpet" as an installer assignment rather than a
customer measurement, confusing "is" as a linking verb (describing a
measurement) with "is" as an action verb (describing installer work).
Fixed with a precise rule and the exact real failing case as a
worked example — a real, honest, narrow fix for one phrasing, not a
general solution, exactly as named in the identity-collision pin
above.

**Worth stating plainly what this proves and what it doesn't.** This
confirms the same-breath assembly *mechanism* is sound — the
deterministic check, the project creation, the multi-row update, all
worked correctly on the first real, correctly-classified attempt.
It does not mean the upstream classification problem is solved in
general — the cross-role identity collision design pinned above this
entry is the real, scalable answer to that, still not built. Same-breath
assembly and cross-capture attachment (the harder half of Layer 2,
still deferred pending a real answer to "what makes a project open")
remain two separate pieces of work.

## Layer 2 (Project) — job_scope_id linking, and three real bugs found on the way to proving it (2026-07-22)

**The real feature**: quotations and invoices now carry a real
`job_scope_id`, captured at the one real point pricing actually
happens — closing the exact gap the Fable 5 design review correctly
identified in the original Layer 2 pin ("quotations reach the project
through edges that already exist" was checked and found false; those
edges never persisted anywhere). A project can now show a real,
computed `totalQuoted` and `totalInvoiced`, summed via a real join
through `job_scopes.project_id` — the actual point of grouping phases
together in the first place, not just a label on some measurements.

**Three real, distinct bugs found and fixed on the single test that
proved this** — worth recording honestly as three separate failures,
not one:

1. **Wrong job scope matched.** Pricing "Thabo's screed job" matched
   against the *carpet* job scope instead, because `findLatestJobScope`
   picked whichever was most recently created, ignoring what was
   actually named. Exposed only because Layer 2 now lets one customer
   genuinely have multiple job scopes — before, "most recent" rarely
   mattered.
2. **The fix for #1 didn't work on its first attempt, and the reason
   was real and worth naming.** Matching against real words from each
   candidate job scope's description/components/tasks seemed right,
   but the customer's own name ("Thabo") is present in every
   component name for that customer ("Thabo downstairs", "Thabo
   upstairs") — an artifact of how components get named, not a real
   distinguishing signal. It matched everything equally, so the most
   recent candidate kept winning regardless. Fixed by excluding the
   customer's own name from the matching words.
3. **A task's rate had nowhere to inherit a real area from.** Once
   matching correctly found the *right* job scope, pricing still came
   back wrong — R80 flat instead of R3,200. "Screed" is a task, not a
   component, and a task has no `area_sqm` of its own; only the
   component it's linked to does. `buildQuotationLineItems` only ever
   checked components directly, never followed a task's real link back
   to its component. Fixed by resolving a task-matched rate through its
   real, linked component — applied consistently across all three real
   call sites, not just the one the bug was found on.

**Verified completely, end to end, not just the final number**: the
real payload (`description: "screed"`, `quantity: 40`, `unit_price:
80`, `line_total: 3200`, `jobScopeId: 24`) confirmed correct before
confirming; the confirmed quotation correct; and — the real proof this
whole arc mattered — Project #1's own `totalQuoted` correctly showing
3200 immediately after, computed live through the real join, not
asserted.

**Worth naming plainly**: this is the same discipline as every other
real fix in this project, just under real, sustained pressure — the
first fix attempt for bug #1 was believed correct and deployed, then
proven wrong on retest; the second attempt for the same bug was also
believed correct, then proven wrong again by a *different* bug (#3)
hiding behind the first. Each retest was treated as the real test it
was, not a formality — the discipline held under three consecutive
failures on the same scenario, which is a harder thing to prove than
succeeding on the first try.

## Layer 2 (Project) — the third real piece: queryable in conversation (2026-07-22)

**The real feature**: a project's real, grouped phases and its real,
computed total quoted and invoiced value now surface in ordinary
conversation, gated behind `can_know_jobs` — the same precedent
already established for installer job activity, since a project is
fundamentally the same kind of job information, seen from the
customer's side. Closes the real gap between "correct in a debug
route" and "actually useful to Peter" — everything built earlier
tonight (same-breath assembly, job_scope_id linking) only had any real
value once it could actually answer a question asked the way Peter
would really ask it.

**Verified with a real, natural, unpolished question — not a
carefully-worded test case**: "hows Thabo job going" (no capital,
no punctuation, no "please tell me about") produced: *"Project 'carpet
installation': phases are screed installation and carpet installation;
total quoted so far R3200; total invoiced so far R0."* Both real
phases named correctly, the real R3,200 quoted figure correct
(matching the exact quotation confirmed earlier the same session), R0
invoiced correctly reflecting that nothing has been invoiced yet — not
a rounding coincidence, the actual, current truth.

**This closes the full arc of tonight's Layer 2 work — three real
pieces, each proven independently, now working together**: same-breath
assembly (job scopes group into a real project), job_scope_id linking
(quotations and invoices attach to the real phase they were priced
from, rolling up into real project totals), and conversational
visibility (the whole thing is actually askable, not just correct).
Cross-capture attachment and the broader identity-collision design
remain the two real, deliberately deferred pieces — both still pending
real answers to open questions, not rushed defaults.

## Job completion — a real, documented event, connecting three previously separate ideas (2026-07-22)

**What this replaces.** The earlier proposal for closing a project —
"Peter says it's done" — was too simple, and Pierre corrected it
directly: completion is a real, documented event, not a sentence. A
signed completion certificate, care/maintenance instructions for the
installed product, and warranty documentation are real artifacts worth
capturing for the jobs where they genuinely matter.

**A real, important self-correction, on the same thread, worth
recording precisely rather than folding in silently: the certificate
must never become a required gate.** Pierre caught this directly —
making a signed completion certificate a prerequisite for a job ever
being marked closed risks exactly the enterprise-completeness a
business never asked for, the same trap Principle 12 already exists to
guard against. **The actual, simpler, and arguably more honest
definition: a job is closed when it's paid in full and nobody's
complaining.** For the overwhelming majority of real jobs, that isn't
a proxy for completion — it *is* completion, in the only sense that
matters day to day. Skipping the formal paperwork must never block
this simpler, real signal from doing its job. The certificate,
warranty, and care documentation remain real and worth capturing —
as optional, additional documentation for jobs where it genuinely
matters (larger contracts, formal warranties), never as a gate.

**A real, practical consequence of this correction, worth naming
explicitly: it likely unblocks "what makes a project open" sooner than
the fuller completion design does.** "Paid in full, no open complaint"
is already computable directly from real, existing data — invoices and
payments already in the system — without needing to build a whole new
certificate-capture feature first. The richer completion design (the
artifacts, warranty, snags, the debtors-confidence connection) remains
real and worth building for the jobs that need it, but the *simple*
default this correction reveals may be sufficient, on its own, to
answer the question that started this whole thread.

**The real, valuable discovery this makes: three ideas that looked
separate were never actually separate.** Warranty tracking was already
named as a real gap earlier tonight ("a real, common promise a
flooring business makes... nothing captures this today") — but it
isn't a standalone feature. It's part of what completion means for the
jobs where it applies. Snag lists were also already named as a real
gap ("after an install, defects get found... real businesses track
these as their own thing") — and a real, honest question follows
immediately: can a job be signed
off while snags are still open? Project closing, warranty tracking,
and snag resolution are one coherent lifecycle stage, not three
disconnected ideas that each happened to get named on different
nights.

**How capture likely works, reusing what's already proven rather than
inventing something new**: the same photo/document upload path already
proven tonight for Supplier Invoice ingestion — a real photo of a
signed completion certificate, a photo of warranty documentation — is
the natural, consistent mechanism here too, not a new one.

**Question 2, resolved directly, not left open — but sharpened on a
second pass, since the first answer was too simple.** The real,
deterministic factor isn't "snag vs. no snag" — it's *when* an issue is
raised relative to the sign-off itself:

- **An issue noted *at* the moment of signing** is a real, direct hold
  on the outstanding balance — the customer signs the certificate but
  flags the problem right there, and withholds what's due until it's
  fixed. This is genuinely different from a formal retention
  arrangement (a pre-agreed percentage withheld on every job,
  regardless of any actual issue) — this is ad hoc, triggered by a
  real, noted problem at the exact moment of sign-off, tied to that
  one invoice.
- **A clean sign-off, balance already due, then a problem discovered
  later** — the money question is already settled by the time this
  happens, and stays settled. What follows is a purely separate
  classification decision: does this rise to a real warranty claim (the
  warranty terms actually cover it), or is it just a minor snag to fix
  quickly? Either way, it never reopens a balance already due.

The project's "closed" status itself is unaffected either way — the
certificate is signed either way, completion is real either way. The
real difference is only ever on the financial side: whether the
outstanding balance is genuinely held open by something noted at
signing, or already settled and untouched by whatever surfaces later.

**A real, valuable connection this reveals, worth building alongside
snags rather than as an afterthought: snags and retention are often the
same real mechanism, from two different angles.** A snag with a real
retention arrangement behind it (built and proven earlier tonight) is
naturally the real trigger for releasing that retained amount —
resolving the snag is what the withheld money was actually waiting for.
A snag with no retention behind it is just a standalone quality issue,
tracked and resolved quickly, with no financial mechanism attached at
all. Worth a real, explicit link from a snag record to the customer's
retention arrangement when one exists, rather than treating every snag
identically regardless of whether real money is sitting behind it.

**Real, open questions, deliberately not answered here:**
1. Is every one of these artifacts mandatory for completion, or is the
   certificate the one real requirement, with warranty and maintenance
   information optional depending on the job (a simple repair likely
   has no warranty to capture at all)?
2. ~~Does an open snag genuinely block completion~~ — resolved above:
   no, completion is unaffected either way. The real distinction is
   financial, not statutory — an issue noted at signing holds the
   balance; one discovered after a clean sign-off doesn't.
3. Does "project open" (needed to resolve cross-capture attachment,
   the reason this whole thread started) simply mean "no completion
   event recorded yet," or does it need finer states (in progress,
   snagging, awaiting sign-off)? Sharpened further by the bureaucracy
   correction above — the simplest real answer may just be "a real,
   outstanding balance exists on this project's invoices," computable
   right now from data already in the system, not waiting on any part
   of the fuller completion design to be built first.
4. Where does ongoing maintenance actually live once captured — a real
   recurring reminder (reusing the due-date mechanism already built for
   tasks), or just a stored fact Peter can ask about later?
5. What actually distinguishes a warranty claim from a minor snag, for
   an issue discovered after a clean sign-off? Both are quality issues
   found later, but one is real enough to invoke formal warranty terms
   and one is a quick fix — likely a real, human judgment Peter makes
   at the moment he notices it (not something to infer from the issue's
   own description), but worth a real, deliberate answer rather than an
   assumed default.

**A real, valuable connection to something already built tonight,
worth naming explicitly: completion status feeds directly into
collections confidence.** Right now, an outstanding invoice on the
Aged Debtors report is just a number owed, with no way to distinguish
a purely financial chase from a balance that might genuinely still be
in question over unfinished or disputed work. Once completion is real,
"closed" becomes a trustworthy signal specifically for this: a debtors
clerk (or Peter himself) looking at a closed job's outstanding balance
can act with real confidence — a signed certificate exists, the work
itself isn't in dispute, this is purely collections. A job *without*
that status is genuinely different — the balance might be legitimately
held up by an unresolved completion issue (the "issue noted at
signing" case above), not just a slow payer, and shouldn't be chased
the same way. Worth a real flag on the Aged Debtors report itself once
completion exists — not a new report, an enrichment of the one already
built and proven.

**Explicitly not built tonight** — this is now a real, three-part
design (completion, warranty, snags), each already substantial on its
own, correctly deserving proper specification before code, the same
discipline as every other design of this scale tonight.

## Layer 2 (Project) — cross-capture attachment, the fourth real piece, and the full original vision now proven (2026-07-22)

**The real feature**: a standalone job scope — no same-breath siblings,
born from a genuinely separate message — now auto-attaches to an
existing project when the customer has exactly one real, open one.
Built directly on the simple, honest answer to "what makes a project
open" from the bureaucracy-correction thread above: no invoice yet, or
a real invoice not fully covered by the customer's real payments,
reusing the exact FIFO logic already proven for Aged Debtors.

**Deliberately, honestly scoped to one rung, not the whole Ladder.**
The design's other two rungs — matching a stated project handle
directly, and asking when two or more open projects genuinely compete
— are left unbuilt on purpose. They need real design work this session
hasn't done (how would Peter actually name a project in conversation?
how does an ask-and-wait flow work mechanically, given nothing like it
exists yet in this codebase?), not a guessed-at implementation
standing in for a real answer. The one rung built tonight is the
cleanest and most valuable: most real customers will only ever have
one open job at a time, and this is the case that matters most,
proven correctly rather than assumed.

**Verified live, with a genuinely separate message, not a contrived
one**: a new job scope for Thabo, sent as its own real message minutes
after the original — a different `capture_id` entirely (184, versus
178) — correctly attached to the existing Project #1 alongside the
two job scopes already there from the original same-breath test.

**This closes the full, original Layer 2 vision — the same-breath and
cross-capture halves of Project assembly, both real, both proven,
working together.** What started as a design pinned weeks ago,
sharpened by a cross-model review, corrected multiple times on
verification, and built incrementally across one long night — same-
breath assembly, job_scope_id linking, conversational visibility, and
now cross-capture attachment — is now a genuinely complete, working
feature, not a partial one with an asterisk. The remaining, real gaps
(the two deferred Ladder rungs, the broader identity-collision design,
job completion, warranty, snags) are honestly named, not hidden, and
correctly left for their own turn.

## Layer 2 (Project) — connecting real scheduling data, a missing connection rather than a missing mechanism (2026-07-24)

**Pierre's real observation**: throughout the entire Layer 2 arc — same-
breath assembly, job_scope_id linking, conversational visibility,
cross-capture attachment — nothing had touched scheduling. "Fifteen
square meters, hallway, Thabo, next Friday" had no way to actually
register anywhere meaningful.

**Verified before building anything, rather than assumed either way**:
a real test ("measured Thabo hallway at fifteen square meters for
laminate, doing it next Friday") showed the extraction and storage
mechanism had been working correctly the entire time —
`scheduled_date_raw: "next Friday"`, `scheduled_date: "2026-07-31"`,
correctly resolved. Every Layer 2 test tonight had simply used plain
measurement phrases with no scheduling language, so this had never
been exercised. The real gap was never a missing capture mechanism —
it was a missing connection between data that already existed and the
Layer 2 features that should have been surfacing it.

**Closed additively, in two places**: `getCustomerProjectSummary` now
shows each phase's real scheduled date when one exists, so a real
question like "hows Thabo job going" can answer with real, useful
timing, not just financial totals. The scheduler ember (a real,
permanent production route, not a debug one) now also returns real
project context (`project_id`, `project_description`) alongside its
existing fields — added without changing the existing response shape,
so nothing that already consumes this route breaks.

**A real, live operational note, not a code issue**: the deploy for
this change hung on the "Deploy to Cloudflare Workers" step for
several minutes — every step before it succeeded cleanly — then
completed successfully on its own. A genuine, transient delay, not a
build problem; worth remembering if a future deploy seems stuck rather
than immediately assuming something broke.

## Job completion — the simple, financial half is now real and built (2026-07-24)

**The real feature**: every project now shows a real, computed status
— "open" or "closed (paid in full)" — following the bureaucracy
correction's actual, honest default rather than a formal certificate
requirement. Reuses the exact same, already-proven FIFO logic from
`getOpenProjectsForCustomer` (built for cross-capture attachment), not
a new, parallel computation of the same real fact.

**A real bug found and fixed on the way to proving it, worth recording
precisely**: `convertQuoteToInvoice` — the quote-to-invoice conversion
path — never carried forward the source quotation's real
`job_scope_id`, so a converted invoice silently dropped out of a
project's real totals even though the quotation itself was correctly
linked (`recordInvoice` and `recordQuotation` had both been fixed
earlier tonight; this third, real path was missed). Fixed by copying
the link forward deterministically, plus a real, safe, idempotent
backfill for any invoice already created via conversion before the
fix. This is the exact shape of gap the "map" pinned below exists to
catch earlier next time — a real concept (job_scope_id must be true of
every invoice) with more than one real creation path, and only two of
the three were checked on the first pass.

**Verified on both real sides, not just the happy path**: Thabo's
project correctly showed "open" while R2,400 remained genuinely
outstanding (R800 paid against a R3,200 invoice), and correctly
flipped to "closed (paid in full)" the moment the real, remaining
balance was actually paid — proven with real money moving through the
system, not asserted.

**Complaint-tracking remains real and deliberately unbuilt** — the
"no open complaint" half of the original definition has nothing to
check against yet, since snags don't exist as a system. This is
honestly a partial build of the full definition, not the whole thing —
the financial half, which is the one immediately useful and buildable
right now.

## The Atlas idea — what got built tonight, and two real, deliberately unearned levels beyond it (2026-07-24)

**What's real and built**: `ATLAS.md`, a structured, per-concept
register (created by, reads, must always contain, known historical
bugs) for concepts with more than one real code path — seeded honestly
with two real, evidenced entries (Invoice, Job Scope), not invented
ones. Grew directly out of a real, live discussion about why diagnosis
keeps getting faster while completeness (finding *every* place a fix
needs to apply) doesn't automatically improve with experience — this
document exists to make that harder discipline faster to start, not to
replace the real grep across the codebase that actually verifies it.

**Two real, further ideas surfaced in the same conversation, correctly
recognized as not yet earned:**

1. **The Office querying its own atlas at runtime, as something it
   trusts and reasons from, not just something read before editing.**
   The real, honest tension worth naming: the atlas's own first
   real-world test — the `convertQuoteToInvoice` bug — is proof this
   is genuinely hard even with real discipline applied; two of three
   invoice-creation paths were fixed correctly and the third was still
   missed on the first pass. A manually-maintained document has the
   same failure mode as any other documentation — it goes stale the
   moment a new path is added and the entry isn't updated — and a
   *wrong* map that's *trusted* is worse than no map, since it creates
   false confidence rather than appropriate caution. The real,
   unresolved question isn't "should this exist," it's whether it can
   be maintained by hand at all, or needs to be derived from the
   actual code rather than written about it — genuinely unanswered,
   not defaulted either way.
2. **A business-facing version — Peter asking "what happens if I
   change courier" and getting a real, structured answer about
   dependencies, prices, and history.** A real, exciting parallel to
   Pulse (one watches relationships, one watches time), but gated by
   the exact same real, honest limitation already pinned for Pulse
   itself: it needs real, accumulated business volume it hasn't earned
   yet. A courier-dependency atlas for one supplier relationship isn't
   a real system tonight, it's a guess with better formatting.

**On naming a new Constitution principle for this** — a real, good
instinct, deliberately not acted on yet. Every existing Principle in
this project emerged from lived building experience, not from a
proposal, however sound. Held as a strong, real candidate — something
like "every important truth should know where it comes from, where it
goes, and what depends on it" — to earn its number once the Atlas has
actually been built on, consulted, and proven useful a few real times,
not before.

## Variance Disposition — the first real piece is built and proven (2026-07-24)

**The real feature**: raising a reason and resolution against a real,
already-computed GRN discrepancy — reason codes and resolution paths
validated against real ERP research earlier the same night. Reuses
GRN's own precedent exactly: unguarded but traceable, since naming why
a discrepancy happened is documentation, not money moving.

**A real bug found and fixed on the way, worth recording precisely,
and the Atlas's own first real vindication**: the initial
implementation tried to resolve the recording user's identity via
`resolveCapabilities(request, env)` inside `processOneExtraction` —
but `request` was never in scope there; that function only ever
receives a pre-resolved `capabilities` array. Caught by `tsc` before
deployment, not live. Fixed by threading a real `email` parameter
through `processTranscript` and `processOneExtraction`, the exact same
way `capabilities` already is — and while fixing it, found that the
voice-upload path had never been passing its own resolved email
through either, a second, real gap closed in the same pass rather than
left for later.

**Verified live with a real, existing discrepancy, not a fabricated
one**: "the underlay shortage on Floornet, that's a back order" —
correctly matched against the real -50 underlay variance from GRN
testing earlier the same night, recorded as `reason: short_delivered`,
`resolution: back_order`, and — the real proof of the traceability fix
— `recorded_by: pierreduplessis6912@gmail.com`, not null.

**Deliberately, honestly scoped to raising a reason, not resolving
money yet.** The "credit" resolution path currently just stores a
stated `credit_amount` as data — it does not yet create a real expense
reduction against what's owed to the supplier. That's a real, separate
next step, kept apart on purpose so "naming why" and "actually
adjusting the money" don't get conflated into one change, matching the
same one-domino-at-a-time discipline as every other multi-stage
feature built tonight.

## Variance Disposition — complete, both halves proven with real data (2026-07-24)

**The real feature, finished**: a credit resolution with a real,
stated amount now creates the real financial write-off it implies — a
negative expense against the supplier, reducing what's actually owed
— guard()'d, since real money moves. Raising a plain reason (or a back
order with no amount) stays exactly as it was: immediate, unguarded,
traceable.

**Verified live, end to end, on a real, previously-untouched
discrepancy**: "the skirting shortage on Floornet, Floornet is
crediting us R500 for it" — held for confirmation (`pendingActionId:
67`, correctly not immediate this time), confirmed, and produced a
real, exact expense: `amount: -500, description: "Credit for Skirting
(short_delivered)"`, correctly linked to Floornet. The original
underlay disposition (back order, no amount) sits alongside it in the
same debug view, both correctly traced to the real confirming user.

**This closes the full Variance Disposition arc** — real ERP research
done before finalizing reason codes, four real, open design questions
answered deliberately rather than defaulted, a real type-error bug
caught by tsc before deployment and fixed by threading a real
identity parameter through two functions (the same pattern the Atlas
now has a real, seeded entry for), and both resolution paths — back
order and credit — proven with real money and real data, not asserted.

## Two real ideas from the ERP research thread, pinned rather than built mid-stream (2026-07-24)

**A deliberate practice, not a one-off**: periodically revisit the
existing "idea tank" — pinned designs deferred not because they were
weak, but because the infrastructure they depended on didn't exist
yet. Consumables stock was explicitly pinned as "sequenced after
PO/GRN" — and PO/GRN is now real and proven. The same reasoning likely
applies to other pinned items once their real prerequisite exists.
This deserves its own, deliberate pass — not squeezed in as an
afterthought to whatever else is being built — to see what can now
slot in reliably that couldn't before.

**GRN-informed pricing**: real, dated cost history now exists — every
GRN and Supplier Invoice records what a material actually cost, per
supplier, over time — that didn't exist before tonight's PO/GRN/
Supplier Invoice arc. This makes a genuinely new capability possible:
not replacing Peter's own pricing judgment, but grounding it with a
real fact he could ask for, or be shown, when pricing a job using a
material with real purchase history — "the last real price paid for
vinyl from Floornet was R180/sqm." A real, different kind of pricing
support than exists today, reliable now specifically because real
cost history exists to draw from — it wouldn't have been reliable
before this arc was built.

**Explicitly not built tonight** — both are real, named, and worth
real design attention on their own terms, not folded into whatever
else is in progress at the moment they're raised.

## Aged Creditors — built, with a real Principle 12 refinement and a real bug found live (2026-07-24)

**A real, valuable refinement to Principle 12, given directly by
Pierre, worth recording precisely.** The initial instinct was to treat
supplier-payment tracking as unearned speculation and offer a smaller,
honestly-scoped alternative instead. Pierre corrected this directly: a
supplier statement arriving monthly isn't speculative, it's a certain,
recurring, real-world event for any business with active supplier
relationships — which this one already has. The real distinction
Principle 12 actually protects against is speculative enterprise
completeness, not building ahead of a certain, predictable need.
"Building in certain anticipation" of something that will definitely
happen is a genuinely different thing from guessing at a maybe, even
though both involve building before an explicit request.

**The real feature, built on that basis**: `supplier_payments`,
mirroring customer payments exactly — the real prerequisite Aged
Debtors already had and Aged Creditors was missing. `getAgedCreditorsSummary`
mirrors the debtors side precisely, gated behind the same
`can_know_materials` capability already used for expense data, since
this is the same real domain (supplier money), not receivables.

**A real bug found on the very first live test, worth recording
honestly**: R25,930 instead of the correct R25,430 — a real R500
credit (from Variance Disposition's own credit resolution, a negative
expense) was silently dropped entirely. The exact cause: the loop
reused Aged Debtors' `if (owed <= 0) continue` check, correct there
(a fully-paid invoice has nothing left to age) but never designed for
a negative bill existing at all — Aged Debtors never has one, so this
scenario genuinely never arose on that side. Fixed by folding real
credits into the same payment pool, applied FIFO oldest-first, the
same convention already proven for real payments — not a new
mechanism, an extension of one already trusted.

**Verified completely, end to end, with real money moving three real
ways**: R25,930 gross expenses, correctly netted to R25,430 after the
real credit, correctly reduced to R15,430 after a real R10,000 payment
— every step proven against the exact predicted number before moving
to the next, not asserted.

## Office scales by scope, not by product — an architectural direction, given by Pierre (2026-07-24)

**The core claim, and why it's recorded as an already-true property,
not a future goal.** One Office, one reasoning architecture, identical
capabilities regardless of who's using it or how large the business
behind it is. This isn't aspirational — it's already real, proven
today by how permissions actually work: Sipho and Peter run through
the exact same code path right now, and the only thing that differs
between them is what capabilities their real membership carries and
what reality has actually been populated for them to query. Nothing
about the architecture itself would need to change to add a third
membership, a hundredth customer, or a more elaborate permission
structure — it would only mean more reality poured into the same
shape. The unifying pattern behind every real query this system
answers, at any scale — "has Eagle Express raised their courier
rate," "why did laminate margins fall," "why is one branch
outperforming another" — is the same cognitive operation: observe
reality, compare against expectation, explain the deviation. This is
also not a new idea introduced here — it's the same real pattern
already named twice tonight in different clothes: Pulse (watching time
for deviations) and the Atlas (watching relationships for ripples).
Office is not software for a specific industry; it's a reasoning
architecture, and flooring is simply the first domain rich enough to
prove it under real operational pressure.

**The genuinely speculative extension, kept explicitly separate and
gated.** A nested hierarchy of Offices — branch, regional, national,
each aggregating the layer below it, permissions handled the same way
throughout (a regional manager is simply a character within each
branch Office, no separate "corporate mode" needed) — is real,
sound reasoning about *if* a second organizational layer ever exists.
It is not a description of anything true today. Zululand Flooring has
no branches, no regions, no national structure — one owner, one
installer crew, a handful of active suppliers. This is precisely the
shape Principle 12 exists to catch: a real, well-reasoned design for a
scale of business that hasn't been shown to exist yet, and it stays
gated behind real evidence that a second, actual organizational layer
exists and needs it — not built, not scaffolded, correctly recorded as
*why* the architecture should hold up if that day comes.

**One real, precise distinction worth being careful about, since it
touches something already explicitly settled**: isolated-instance-per-
business was proposed and correctly rejected as multi-tenancy three
separate times in this project's own history, each time by an
AI-generated document. This direction is a genuinely different shape —
each branch stays a fully isolated instance, with a separate
aggregation layer sitting *above* already-separate instances, not one
shared instance across tenants — but it's worth stating that
distinction explicitly rather than letting the two ideas blur, given
one of them has a real history of being correctly rejected in this
exact project.

## Identity Collision — built, tested, and a real lookup-side gap found and fixed the cheap way first (2026-07-25)

**The real feature, given directly by Pierre weeks earlier and built
here**: before a new customer or character record would ever be
silently created, `checkCrossRoleCollision` checks the exact same name
against the *other* table — a direct, deterministic database lookup,
never a model judgment call. If the name doesn't already exist in its
own, intended table, and does exist in the other, that's a real,
detected collision. Only fires on exact name matches, and only when a
new record would otherwise be created — the common, frictionless case
(a known installer referred to as an installer) is completely
untouched.

**Confirmation creates a real, new record, then reprocesses the
original extraction** — an installer can genuinely also become a real
customer, as two separate, real records. Reprocessing naturally
doesn't re-trigger the collision, since the name now exists in its own
table — the exact same `reconcileCustomer`/`reconcileCharacter` logic
just finds it normally from there. `captureId` is preserved through
reprocessing so same-breath assembly context isn't lost.

**Verified live on the first real test**: "Floornet paid us R500" —
Floornet already existed only as a supplier character — correctly
held for confirmation, correctly created a real, new, separate customer
record (id 19) on confirmation, and correctly fell through to the
normal payment flow from there.

**A real, honest gap this same test surfaced, and a real, precise fix
found for it — the cheap fix, tried before the expensive one, exactly
as planned.** The collision check only ever runs on writes; a lookup
like "does Floornet owe us anything" bypassed it entirely and
resolved straight to the supplier, since lookups are deliberately
read-only and were never meant to create anything. Pierre's own
correction here was the right one: rather than building an expensive
"check both tables on every lookup" mechanism, the real, natural
direction of the question — "X owes us" versus "we owe X" — should
already disambiguate on its own, the same way a real person would
never confuse the two. The first test of that theory showed it wasn't
actually true yet, though — both phrasings resolved to the supplier
regardless of direction. Traced to a real, specific bias: "Floornet"
had been used as a supplier example six separate times throughout this
same prompt, and the model was very likely pattern-matching the name
itself rather than reading the sentence's actual direction. Fixed with
a real, explicit rule, and — deliberately — a fresh, neutral worked
example name never previously associated with either role in this
prompt, rather than reinforcing the same bias with a seventh Floornet
example. Verified correct on both directions after the fix, and on a
real, full message-processing test, not just the raw extraction.

## Layer 2 — the ask-when-2-plus rung, a real structural bug found live, and a real architectural fix (2026-07-25)

**The real feature attempted first**: the second deferred Layer 2
Ladder rung — asking when two or more open projects genuinely compete
for a standalone job scope — reusing the exact hold-for-confirmation
mechanism just proven for Identity Collision. Built directly inside
`recordWorkObservation`, mirroring where same-breath assembly already
lived.

**A real, live bug found on the very first test, and a precise,
honest diagnosis of why it happened.** A customer with two genuinely
separate, already-existing open projects had a new, multi-segment
message sent — and instead of correctly asking which project the new
job belonged to, both segments silently merged into one of the
existing projects. The exact cause: `recordWorkObservation` only ever
sees one segment of a message at a time. The first segment of the new
message had no same-breath sibling yet — its own sibling, from the
same message, hadn't been created yet — so it fell through to
cross-capture attachment, found exactly one open project, and
attached. Its real sibling then arrived moments later, found the first
segment as a same-breath match with a project already assigned, and
joined it there too — silently merging two genuinely separate jobs
into one project that had nothing to do with either of them. The
earlier successful test (Thabo) had worked only by coincidence — he
had zero pre-existing open projects at the time, so the first
segment's cross-capture check correctly found nothing.

**The real, structural fix, not a patch.** Cross-capture attachment
was removed from `recordWorkObservation` entirely — it cannot be
decided correctly one segment at a time. A new function,
`resolveCrossCaptureAttachment`, holds the exact same logic (one open
project attaches, two or more asks, zero stays standalone) but is now
called only once, in `processTranscript`, after every real segment of
the whole message has been processed and same-breath assembly has
already had its full, complete chance to group whatever it's going to
group. Only job scopes still genuinely undecided (`project_id` null)
at that point get resolved.

**Verified completely, end to end, with a fresh customer and real
data**: two genuinely separate open projects created correctly (same-
breath assembly proven still intact), a third, standalone message
correctly triggering the real question — "This customer has 2 open
projects (laminate flooring installation, tile installation) — which
one is job scope #37?" — confirmed with a real, chosen project id, and
the final state checked directly: the chosen project correctly gained
the new job scope, the other project completely untouched.

## Consumables Stock — the idea-tank review's first real, unlocked item, built and proven end to end (2026-07-25)

**The real feature**: registration (a real, deliberate, opt-in action —
never guessed which materials count as consumables), a real hook
inside GRN confirmation that increments a tracked stock item's real
running total only when its exact name already matches one Peter
registered, real usage decrementing it, and real stocktakes correcting
it to match physical ground truth — the same reconciliation philosophy
as PO/GRN/Supplier Invoice, one layer further.

**Built specifically because tonight's idea-tank review found it —
this is the concrete proof the practice works.** Consumables Stock was
explicitly pinned weeks earlier as "sequenced after PO/GRN," deferred
not because the design was weak but because its real prerequisite
didn't exist yet. PO/GRN is now real and proven, so this was the
correct next thing to build, not a guess about what might be useful.

**A real bug found on the very first live test, worth recording
precisely.** "Used 5 bags of screed on Jenny's job" correctly
recognized the intent but failed to match against screed — a stock
item that definitely existed and was definitely being tracked. The
real cause: the given item list was formatted as "screed (bags)," and
the prompt's instruction to copy the match "exactly from the given
list" was genuinely ambiguous about whether that meant the whole
display string or just the bare name. The model very likely copied
the full string, which could never match against the bare `name`
field the matching code actually compared against. Fixed in both
`extractStockUsage` and `extractStocktake` with an explicit rule and a
concrete example distinguishing the two.

**Verified completely, end to end, with one real material carried
through the whole lifecycle**: registered screed as stock, ordered and
received 20 bags via a real PO/GRN (confirmed `quantity_on_hand: 20`),
used 5 on a real job (confirmed 15 remaining), and ran a real
stocktake counting 14 — correctly computing `variance: -1` against the
expected 15, and correctly correcting `quantity_on_hand` down to 14 to
match physical reality.

**Deliberately, honestly scoped** — job-specific material remnant
tracking (the "50m² underlay excess" case, requiring real product-code
specificity and PO-vs-invoice reconciliation mechanics) remains its
own, separate, harder design task, exactly as the original pin left
it. This build is the core, simple consumables model only.

## GRN-informed pricing — built, and a real, subtle bug found in an existing, general-purpose check (2026-07-25)

**The real feature**: a real, historical question — "what did we last
pay for vinyl" — answered directly from real supplier invoice data,
most recent first. Grounds Peter's own pricing judgment with a real
fact he can ask for; never suggests a rate, never replaces his own
decision.

**A real, subtle bug found on the very first live test, worth
recording precisely — a new query type colliding with an existing,
general-purpose mechanism it was never designed to know about.** The
extraction was correct — `query_scope: "material_price"`, the material
name correctly captured — but the answer came from a completely
different path: Jenny's own facts, not the real price data. The cause:
the "sticky selection" register (Principle 24's Execution Ladder,
rung 1) resolves a lookup with no named customer against whichever
customer was last discussed — a real, valuable mechanism for genuine
follow-ups ("show me the quote" after "show me Jenny"). Its own
exclusion list only ever accounted for `"personal"` and conditionally
`"business"` — it had no way to know a brand new query_scope
(`"material_price"`) had been added elsewhere in the same project, and
correctly-but-blindly treated it as "could be an entity follow-up,"
silently overwriting `query_scope` to `"customer"` and pulling in the
last-selected customer. Fixed by adding `"material_price"` to the same
exclusion list `"personal"` already sits in — a real, small fix, but
the kind of gap that only ever surfaces by adding a genuinely new case
and testing it against the whole system, not just the code written for
it.

**Verified live, with real, dated data**: "The last real price paid
for Vinyl was R180 (from Floornet, 2026-07-21)" — a real number
pulled from an actual supplier invoice recorded hours earlier the same
session, correctly beating out even this project's own imprecise
memory of what that number was.

## Snags — the smallest, most immediately useful piece of the job-completion/warranty/snags design, built and proven end to end (2026-07-25)

**The real feature**: raising and resolving a real quality issue
against a real customer's job, deliberately unguarded but traceable —
matching GRN's own precedent exactly, since this is a quality note,
never money moving directly. Built first, per the original design's
own sequencing guidance ("snag lists — smallest, most immediately
useful"), ahead of warranty tracking and the harder open questions
still left pinned.

**The real, valuable connection to retention, surfaced honestly as
information only, never as an automatic financial write.** Resolving
a snag checks whether it was genuinely the last open one for that
customer, and whether a real retention arrangement exists — if both
are true, Peter is told directly that a real amount may now be
releasable, so he can decide to release it himself, the same
deliberate action every other financial write in this project already
requires.

**Verified live, and a real, honest distinction found along the way
that could easily have been mistaken for a bug.** The first resolution
test showed "a real retention of R0 may now be releasable" — which
looked wrong at first, but was actually correct: `retention_amount` is
computed and stored on each invoice at the moment it's created,
reflecting what was genuinely withheld then, not recalculated
retroactively. Jenny's existing invoices were created hours before her
retention arrangement was set up in this same test, so they correctly
show R0 — nothing was ever withheld on them. Confirmed by creating a
fresh invoice after setting her real 10% retention (correctly showing
`retentionAmount: 200`), then raising and resolving a third snag —
this time correctly showing "a real retention of R200 may now be
releasable," proving the connection works exactly as designed once a
real retention arrangement genuinely existed at invoice time.

**Deliberately, honestly scoped** — warranty tracking, the "when is an
issue noted relative to sign-off" financial distinction, and the
remaining open design questions (mandatory vs. optional artifacts,
maintenance reminders, warranty-vs-snag classification) remain exactly
where the original pin left them: real, named, and correctly
sequenced for later.

## A genuinely poor-quality real photo, and a real, significant bug it found (2026-07-25)

**The real test**: an actual, physical delivery note from a brand-new
supplier (Belgotex, never mentioned before tonight), photographed on
Pierre's own phone — genuinely blurry, shot at an angle, partially
obscured by a dark object, real ambient lighting. Not a clean, staged
test image.

**The critical, actionable data proved reliable across repeated real
extraction — the peripheral data honestly didn't.** Item number,
description, ordered/delivered quantities, and the supplier's own name
came back identical and correct on two separate real vision passes
against the same photo. The one detail that genuinely varied was the
street address — "80 Commercia Road," then "80 Comrie Road" on a
second pass, neither matching this project's own reading of "20
Chesterfield Road" from the same image. A real, honest finding worth
keeping in mind going forward: vision extraction on a genuinely poor
image can be unreliable on details that never touch any real business
logic, while staying reliable on the fields that actually drive real
decisions.

**The real, significant bug this test found, worth recording
precisely.** This document is a real delivery note — no pricing
anywhere on it at all. The existing photo/document ingestion logic had
only ever been built and tested against real supplier invoices, and
unconditionally assumed every photographed supplier document was one.
`extractSupplierInvoice` correctly refused to invent a price — every
matched line item came back with `unit_price_billed: null`, exactly as
it should for a document with no price on it — but the result still
got held as a real, guard()'d "supplier_invoice" pending action, which
would have created an invalid expense with no real basis had it been
confirmed. Caught before confirming anything, by inspecting the real,
raw pending-action payload directly rather than assuming either way.

**The real fix**: both `/files/photo` and `/files/document` now check
whether any matched line item has real, non-null pricing before
deciding. None does — a genuine delivery note — and the document is
now correctly routed through real GRN extraction and recorded directly,
unguarded, matching GRN's own precedent exactly (quantity-only, no
money moving). Real pricing on at least one item still correctly takes
the existing, guard()'d supplier-invoice path.

**Verified completely, end to end, with the same real photo
re-uploaded after the fix**: `supplierInvoiceAction: null`,
`goodsReceivedAction: {grnId: 6}` — and the real, stored GRN data
confirmed exactly right: `quantity_received: 3.1, quantity_ordered:
3.1, variance: 0`, matching the physical document precisely.

## The lead/enquiry stage — built and proven end to end, both real lifecycle paths (2026-07-25)

**The real feature**: raising a real, new enquiry — name, interest,
source — deliberately unguarded but traceable. Converts into a real
customer and quotation once priced, exactly as originally pinned, by
hooking directly into the already-proven `recordQuotation` and
`convertQuoteToInvoice` paths rather than inventing a separate
mechanism — the real point of the whole design.

**A real, careful exclusion, worth recording precisely.** Raising or
losing a lead deliberately never touches `reconcileCustomer` or the
identity-collision check at all — the name stays purely in the real
`leads` table until genuinely quoted. Getting this right mattered:
without it, every new enquiry would have silently created a real
customer record on day one, the exact duplication this whole design
exists to prevent.

**Verified live across both real lifecycle paths, with a genuine,
unplanned collision along the way that proved two features working
together correctly.** Sipho's enquiry raised cleanly (`customer: null`,
confirming the exclusion held). Quoting him then correctly triggered
Identity Collision — he turned out to already be a known installer
character from earlier tonight — confirmed as a real, new customer,
and the lead automatically transitioned to `status: "quoted",
customer_id: 23`. Converting that quote to an invoice then correctly
transitioned it to `status: "won"`. A second, separate lead (Themba)
was raised and explicitly marked lost, correctly left with
`customer_id: null` since he was never quoted — the real, honest
distinction between "never converted" and "converted then lost"
that the status field exists to capture.

## Supplier Statement Reconciliation — the real, buildable version of the original ERP example, built and proven (2026-07-25)

**The real feature, deliberately bounded**: rather than attempting
complex, fuzzy matching against every individual historical line on a
real supplier statement, this extracts only the one real, stated fact
that actually matters — the claimed closing balance — and compares it
directly against the real, internal outstanding balance already
computed for Aged Creditors. The smallest real domino that answers the
actual question this whole ERP-research thread started with.

**Reused, not duplicated**: `getOutstandingBalanceForSupplier` calls
`getAgedCreditorsReport` directly and finds the matching row, rather
than reimplementing its FIFO logic a second time — the exact
parallel-implementation risk the Atlas exists to catch, avoided by
construction rather than by remembering to check.

**A real, careful distinction from supplier_invoice**, gated on the
caption's own real intent rather than requiring an open PO — a
statement covers a whole real account across a whole period, not one
specific delivery, so the existing per-PO reconciliation path was
never the right one to reuse here.

**Verified live with a real, generated test document carrying a
deliberate, honest discrepancy**: a real PDF statement claiming a
closing balance of R15,000, against Floornet's real, internal
outstanding balance of R15,430 (itself already proven earlier tonight
through real expenses, a real credit, and a real payment). The system
correctly extracted the stated R15,000 — never invented, never
recalculated from the statement's other figures — and correctly
computed the real difference: `-430`, exactly as designed.

## Chain automation — a real, new architectural direction, given by Pierre (2026-07-25)

**The real observation, and why it's genuinely new rather than a
restatement of what's already built.** Every real stage of the full
lead-to-invoice lifecycle now exists and works — lead, measurement,
quote, ordering, receiving, invoicing, snags, all proven tonight. But
every single transition between them requires Peter to narrate it into
existence — "order the materials," "the delivery arrived," "convert
the quote." The system is entirely reactive: Peter speaks, The Office
responds. It never, on its own, notices that a real state change just
happened and that a real, obvious next action follows from it.

**What's actually missing is the connective tissue, not more stages.**
A real trigger layer — something that watches for a real state
transition (a quote accepted and deposited, stock arriving) and
proposes the next real action as a pending item for Peter to review
and release, rather than waiting to be told. Not a bigger version of
`holdForConfirmation` — that mechanism is already exactly right, proven
all night. What's missing is the trigger itself: the thing that
decides *when* a new pending action should be drafted in the first
place, on the system's own initiative.

**A real, valuable connection worth naming precisely: this is the
same real pattern as Pulse/Heartbeat, applied to workflow progression
instead of anomaly detection.** Observe reality, compare against
expectation, surface something worth acting on — the exact shape
already pinned and deliberately gated behind real accumulated volume.
This isn't a ninth, unrelated idea sitting apart from that one; it's
the same architectural shape pointed at a different real question.
Worth remembering that connection when either one is picked up, since
solving the general "notice a state change, propose the next action"
problem well would likely serve both at once.

**Deliberately, explicitly excluded from this direction, per Pierre's
own instruction: the customer-facing acceptance channel.** Everything
built tonight assumes Peter is the one talking to The Office. A
customer accepting a quote and paying a deposit without Peter relaying
it is a genuinely different kind of input this system has never
received — the first time an external party, not Peter, would trigger
something directly. That's a real, separate, harder design question
(a customer portal, a signed link, some new channel entirely) and
stays out of scope here. The real, honest default for now: Peter still
relays "she accepted" as one real fact, the same way he relays
everything else — chain automation begins from that point forward,
not before it.

**A real, honest gap that would remain even with this trigger layer
built, worth naming precisely rather than glossed over**: job-specific
stock. Consumables (screed, glue) have real, running quantities today,
checked automatically on delivery. A named, job-specific product like
"Kronos Swiss Lucerne 3x4" is never tracked as stock at all — it's
ordered and consumed per job. "Stock levels checked" as a real,
automated trigger needs a genuinely different tracking shape for
job-specific materials than exists today — connects directly to the
job-specific remnant-tracking question already left open in the
Consumables Stock design.

**Not built here, deliberately** — a real, substantial architectural
direction on the same scale as Pulse itself, correctly pinned rather
than rushed into, given how many of tonight's own already-proven
mechanisms it would need to touch and reuse correctly.

## Corporate Stationary — the grounded core, and a real, significant bug found at the very center of the Worker (2026-07-25)

**The real, grounded core, deliberately scoped**: a real business logo,
captured via photo upload rather than typed in by hand, reusing the
exact R2 storage pattern already proven throughout tonight. Fonts,
color schemes, and marketing material were deliberately left pinned,
not built — no real, demonstrated need behind them yet, the same
discipline Principle 12 already exists to enforce.

**Three real bugs found and fixed in sequence, each one revealing the
next — worth recording precisely, since the last one is genuinely
significant.**

1. The `ALTER TABLE` migration for the new column lived only inside
   the separate, existing `/debug/business-profile` route, never
   called again after the schema change — the column genuinely didn't
   exist yet, causing a real SQL error on upload. Fixed by running the
   migration directly inside the new route too.
2. Retrieving the logo returned a real 200 status with a genuine
   0-byte body, even though a direct R2 HEAD check confirmed the
   stored object had the correct real size. Fixed by reading the full
   buffer before returning it, rather than streaming `object.body`
   directly.
3. **The real, significant one**: the same 0-byte result persisted
   even after that fix, with response headers (including a correct
   `Content-Length`) showing the right data was present. Traced to the
   CORS wrapper — the one function that wraps *every single response*
   this Worker has ever returned — which itself streamed
   `response.body` directly, silently truncating the body a second
   time, one level above the route-level fix. This had never surfaced
   before because every prior response in this Worker's entire history
   has been JSON; this logo route was the first binary response ever
   produced. Fixed at that one, central point instead — the correct,
   permanent fix, rather than working around it per-route.

**Verified decisively, and honestly, using two different tools rather
than trusting one.** `curl` continued reporting a 0-byte body even
after the real, root-cause fix was deployed and confirmed clean on
regression — traced to a client-side quirk in this specific `curl`
build, not the server. Settled definitively by opening the URL
directly in a real phone browser: the correct image displayed, with
the browser's own title bar confirming the exact real dimensions
(400×150) of the uploaded file. A good, concrete reminder that a
single tool reporting a failure isn't always proof of one — worth
checking with an independent method before concluding.

## The Flutter rebuild — marrying the proven backend logic with the real, intended manifesto design (2026-07-26)

**A real, significant mix-up found and fixed first, before any of
this could safely start.** The web-preview deploy workflow had been
silently repointed, in an earlier part of this same session, from a
genuine `flutter build web` of `main.dart` to a static HTML manifesto
prototype — meaning every "web preview" screenshot for a stretch of
this session was showing a different artifact than believed. Found
by checking the actual workflow file's real history rather than
trusting either account, fixed by restoring the genuine Flutter
build and giving the manifesto its own, permanently separate
workflow and Cloudflare Pages project so this collision can't
recur.

**Reading the real, documented ember history before touching any
code.** Rather than treat the manifesto's four embers (tasks,
scheduler, finance, expenses) as a fixed given, `DECISIONS.md` was
searched directly and found to hold a real, dated design journey —
an earlier 2026-07-10 "notification embers" concept (actions-needed,
reports-ready, calendar, to-do) that was genuinely superseded three
days later once real, in-browser building happened, settling on
magnitude-based counts per business domain instead. The core,
durable principle survived every iteration: embers report a real,
deterministic count, never editorialize, never assert urgency —
"Peter must guide."

**Broadened to five embers, decided deliberately rather than
defaulted into**: Tasks folds in Snags (both a real, open thing to
do). Scheduler folds in Projects (a project is just grouped job
scopes). Finance stays customer-side. Suppliers broadens the old
Expenses ember to cover everything money-going-out — informal
expenses, POs, GRN, supplier invoices/payments, Aged Creditors,
Consumables Stock. Pending is genuinely new — the real, direct
fulfillment of the original 2026-07-10 "actions needed" concept,
proposed once, never wired into a UI until now.

**A real, comprehensive UI capability map built and pushed**
(`UI_MAP.md`) — every backend capability from `FEATURES.md` (itself
brought current first, since it had gone stale relative to
everything built earlier tonight) paired with its real or intended
home in the app, honestly naming genuinely open placement questions
rather than deciding them alone.

**Design inspiration drawn deliberately from this very chat
interface** — the hamburger drawer for navigating existing data
(Reports & Documents, People, and History folded in together, since
the manifesto's own separate swipe-right history gesture had two
real, named problems: a handle that blended invisibly into the
background, and chat bubbles the whole rebuild was already moving
away from) — and the three-dot menu for meta, account-level actions
(Account, Settings, Help) that were never real ember or business-data
concerns.

**History resolved as a real, deliberately simple ledger, not a
richer feature** — reasoned through directly: conversational lookup
already answers the specific "what did X pay" questions history
might otherwise serve, so a plain, chronological input/output log,
minimally built, is the right shape — expected to matter less over
time as trust in conversational answers grows, the same way
comfort tools naturally recede once their reason for existing fades.
Deliberately not over-invested in for exactly that reason.

**Two real steps of the agreed, sequenced rebuild built and proven
live, end to end, via real screenshots — not just claimed from a
green build status.** Visual shell: dark theme (the real, confirmed
manifesto palette), the five embers in the masthead, the hamburger
drawer and three-dot menu, an empty-by-default stage (no hardcoded
seed message — Principle 25, "empty screen is relief"), and real
camera/document upload wired to `/files/photo` and `/files/document`
— the single most significant functional gap named in `UI_MAP.md`,
closed. Real data wiring: two extended and two genuinely new backend
`/embers/*` routes, fetched on startup and after every real action,
verified against real, live counts (7 tasks, 4 projects, 1 supplier
owed, 11 real pending actions accumulated across the whole session).

**A real gap found only by Pierre actually testing it, not by
review** — tapping an ember did nothing, since the visual dot had
never been wired for interaction at all (a later step in the
original sequence). Built immediately rather than deferred further,
reusing the ember data already cached to compute the counts rather
than a separate fetch — verified live: tapping Pending correctly
opened a real sheet listing the actual, accumulated pending actions
from the whole session (#75 supplier_invoice, six real quotations,
a payment, two facts).

**All of this preserves, unmodified, every proven mechanism from the
original Flutter build** — confirm/reject via the real
`pendingActionId`/`factPendingActionId` fields, conversation-history
sending for pronoun resolution, and the record-and-upload voice flow
(deliberately kept over the manifesto's live browser speech
recognition, which doesn't carry over to a native build). Porting
these was never in question — only the visual and interaction layer
around them changed.

## ADR-0007 — Authentication Redirect (2026-07-27)

**Current:** OAuth callback redirects directly with a signed JWT in
the URL (`theoffice://auth-callback?token=...`).

**Reason:** Simplifies Flutter integration and removes dependency on
an additional exchange endpoint while auth is still being proven end
to end. Cookies were never a real option for an app-based client — no
native cookie jar, and the wildcard CORS origin blocks credentialed
cookie requests on web regardless.

**Known limitations:**
- Token appears in a redirect URL — logged, cached, visible to
  debuggers and crash reports.
- No refresh tokens — a 30-day signed token with no rotation.
- No server-side logout — sign-out is genuinely local-only; the old
  token stays valid until its own expiry if somehow replayed.
- No token revocation, no 401-detection/refresh/retry loop.

**Success criteria before redesign:** Android flow proven end to end
on a real device. Web flow proven end to end in the preview. A real
user actually authenticated successfully through the whole path —
tap sign in → Google → redirect → app resumes → token stored →
`/auth/me` → Office opens.

**Future (Auth v2):** Replace the direct JWT redirect with a
short-lived, single-use authorization code
(`theoffice://auth-callback?code=...`), exchanged via a new
`POST /auth/exchange` for a real access token and refresh token pair.
Adds real refresh-on-expiry and real server-side logout (revoking the
refresh token) without changing the mobile UX at all.

**Explicit, deliberate decision, given directly by Pierre:** finish
the MVP flow first — Android intent filter, web callback page,
end-to-end testing, real error handling (cancelled login, network
failures) — before touching the protocol at all. Ship Auth v1, use
it, learn from it, then harden. Not a compromise being quietly
carried forward; a real, named, sequenced roadmap.

**Web flow proven live, 2026-07-27** — real, complete end-to-end
test: tap sign in → real Google login → redirect → app caught the
callback via the installed `web/auth-callback.html` page → token
stored in secure storage → real, signed-in email shown in the account
sheet. Every piece worked together correctly on the first real test:
the platform-aware backend redirect (`platform`/`redirect_origin`
remembered from `/auth/google/login`, used to build the correct
same-origin callback target `flutter_web_auth_2`'s own postMessage
security model requires), the real callback page itself, and the
app's platform-aware `_signIn()`.

One of ADR-0007's two success criteria is now real, not assumed.
Remaining before Auth v2 is even considered: the Android native flow
— the `theoffice://` intent filter still needs patching into
`codemagic.yaml`, and a real, fresh native build has never exercised
any of this — plus real error-handling for cancelled logins and
network failures.

## The first successful native Android build — a real, multi-round debugging journey (2026-07-27)

**The real, decisive milestone**: the very first successful native
build of the entire redesigned app — dark theme, five embers, drawer,
camera/document upload, the full login flow, all of it — a real,
downloadable `app-release.apk`. Every prior native attempt, going back
to a single build months ago, predates this whole redesign.

**The real, wrong hypothesis, worth recording honestly rather than
glossed over.** The first failure — `jni-1.0.1/android/build.gradle`,
`Could not find method kotlin()` — was reasonably assumed to be a
Kotlin Gradle plugin version mismatch, and reasonably assumed to
trace back through `flutter_web_auth_2` → `desktop_webview_window` →
`jni`, given that chain's real, heavy desktop-platform footprint.
Both assumptions were wrong. Upgrading `flutter_web_auth_2` did
nothing. Bumping the Kotlin version did nothing.

**The real fix came from refusing to guess a third time and instead
running `flutter pub deps` directly** — a genuinely different,
correct root cause: `jni` comes from `path_provider_android`, a
dependency present since the very first build, months before any of
tonight's auth work. `desktop_webview_window` (confirmed via the same
tree) depends on nothing more than `flutter` and `path` — the
suspected chain never existed. `path_provider_android`'s own real
changelog confirmed the precise version boundary: 2.2.22 was the last
version before it switched to Kotlin DSL build files (2.2.23) and
then added the real, incompatible `jni` dependency (2.3.0). Pinned
via `dependency_overrides` to 2.2.22 — the real fix.

**Two more real, genuinely different bugs surfaced immediately after,
each traced and fixed in turn rather than assumed away:**
- `:file_picker:checkReleaseAarMetadata` failed because a transitive
  dependency now requires `compileSdk` 36+, while the app itself only
  overrides its own `:app` module's `compileSdk` — each third-party
  plugin module is its own, independent Gradle subproject with its
  own setting. Fixed with a real `subprojects { afterEvaluate { ... } }`
  block in the root `android/build.gradle.kts`, forcing every Android
  module to compile against 36.
- That fix itself then failed — "Cannot run Project.afterEvaluate(Action)
  when the project is already evaluated" — because the existing,
  pre-existing `evaluationDependsOn(":app")` block forces early
  evaluation, and the new block had been appended *after* it in the
  file. Fixed by registering it first instead, before anything else
  in the file could force evaluation — a real Gradle lifecycle-
  ordering lesson, not a logic error.

**The real, durable lesson, worth stating plainly for next time:**
when a Gradle/native-build failure names a specific package and line
number, get the real, proven dependency chain (`flutter pub deps`,
filtered for the actual package name) before forming any hypothesis
about which of your own dependencies caused it. A plausible-sounding
chain, reasoned from a dependency list alone, was wrong twice in this
exact session. Every patch here was also verified locally against a
realistic, simulated project structure before being pushed to a real
build — including one real bug (a misplaced Kotlin import) caught
this way before it ever reached Codemagic.

## The visual/UX design convergence, and the Office Runtime v1 build (2026-07-28–29)

A long, genuinely important arc that produced four real governance
documents and a working code foundation, none of which had been
written up here until now.

**The design convergence.** Pierre ran the same open question — what
should The Office actually feel like, and how should it be built —
through several parallel conversations (this one, Kimi, ChatGPT) and
brought each response back for real, critical evaluation rather than
picking one blindly. That process produced, in order:
`EXPERIENCE_BRIEF.md` (the braai/embers emotional core), the Ether
manifesto (`ether-manifesto.html`, voice-first, "the sigh state"),
`DESIGN_CONSTITUTION_V2.md` (real, numbered rules — the void is
sacred, embers are subconscious, motion is weather not theatre), and
`NATIVE_TRANSITION_BRIEF.md` (stop judging feel from the web preview,
verify on the real device). Each document sharpened or genuinely
corrected something in the one before it — Rule 3 of the Constitution
resolved a question the Experience Brief only gestured at; the
Constitution's "no waveform" instruction explicitly overrode the
Ether manifesto's waveform idea on that one point.

**The embers/orb redesign — real, iterative, several rounds of direct
feedback, not one pass.** Started from a simple `RadialGradient`
circle. Direct feedback ("these are all floating orbs, not embers")
led to a genuine mechanism change, not just a shape tweak: real,
seeded pseudo-random "crackle" (hold, then jump abruptly to an
unrelated value — see `_crackleValue` in `main.dart`) replacing a
smooth sine-wave pulse, since the smooth *behavior* was the actual
cause of the "orb" read, regardless of outline. Real bugs found and
fixed along the way, each confirmed live rather than assumed: a
`BlendMode.plus` additive blend needed `saveLayer` isolation or it
interacted with the canvas beneath it; `Stack`'s default
`Clip.hardEdge` was silently clipping `OverflowBox`'s larger glow
area at three separate nesting levels; the glow radius at high
brightness tiers exceeded its own `CustomPaint` canvas size. The orb
gained real layered depth (tuned gradient stops for a rim-light
effect, a genuine floor reflection) and a persistent, time-of-day
greeting using the real signed-in user's email rather than a
hardcoded name.

**The A/B experiment branch (`experiment/kimi-ab-test`) — explored,
not adopted.** Kimi proposed a fragment-shader "Heat Orb" (turbulent
noise field, no hard edge at all) as an alternative to the
`CustomPainter` approach. Built faithfully on a real, separate branch
with its own, separate Cloudflare Pages project
(`the-office-ab-experiment`) — deliberately isolated so it could never
touch the real preview. Two real bugs fixed along the way (a
non-nullable field compared against null; the shader-uniform API in
the original code didn't match Flutter's actual `dart:ui` API,
corrected to `fragmentShader()` + `setFloat()`) and one real
deployment issue (the project's Cloudflare-side production branch
didn't match what the workflow was pushing, routing every deploy to a
non-root preview URL rather than the visible one — fixed by pinning
`--branch=main` explicitly). The shader did render, and did
demonstrate genuinely different visual qualities (no discernible
edge) — but the branch was never merged into `main`; the
`CustomPainter` approach, refined through the crackle/depth work
above, is what's live. Worth remembering this branch exists if the
shader approach is ever revisited, rather than rediscovering it from
scratch.

**Office Runtime v1 — planned in `OFFICE_RUNTIME_V1.md`, then
genuinely built the same session.** Real, converged architecture
across the same multi-conversation process: a runtime answers "what
is the current state of the world," not "how do I animate this."
Deliberately excludes a generic capability/plugin framework — just a
single "Current Capability" slot, until enough real capabilities
exist to generalize their shape honestly from evidence rather than
guess at it.

Built, in order, each step verified with a real, successful build
before the next began:
- `lib/runtime/office_clock.dart` — a single, shared `Ticker`-based
  timing source. One real bug found and fixed on the first build that
  actually compiled it: `ChangeNotifier` lives in
  `package:flutter/foundation.dart`, not `scheduler.dart`, which only
  provides `Ticker`/`TickerProvider`.
- `lib/runtime/office_state.dart` — real, named states (Idle,
  Listening, Thinking, Responding, RoomOpening, RoomClosing,
  Executing) as the single source of truth, plus a minimal,
  `Stream`-based event mechanism for the few things a bare state
  value can't carry (a response's actual text, which ember is
  currently "thinking").
- All three existing visual systems — the orb's breathe cycle, all 5
  embers' drift, the decorative spark field — migrated off their own,
  independent `AnimationController`s onto the one shared clock. A
  real reduction: several independent tickers down to one shared
  timing source, each system's existing visual behavior deliberately
  preserved exactly (same math, same timing) so this was verifiably a
  migration, not a redesign — changing what it looked like at the
  same time as how it was driven would have made it impossible to
  attribute any difference to the right cause.
- Real state transitions wired at the actual, existing trigger
  points: Listening when recording starts, Thinking during a real
  response wait, Responding (and a real `ResponseReceived` event)
  centralized in `_updateMessage`/`_addMessage` — the one, shared
  place every flow's actual response already passes through, rather
  than duplicated across three flows' success/error paths.
  Executing wraps the real, guarded confirm/reject action.
- `lib/runtime/office_room.dart` — the real materialization pattern
  for Rule 8 ("a room opens, not a popup, not a sheet, not a toast"),
  using `showGeneralDialog`'s own `transitionBuilder` for a genuine
  fade+scale entrance rather than a standard bottom-sheet slide.
  People rebuilt as the first real capability against this — the
  first real test of whether the foundation actually supports
  building something new on top of it, not just organizing what
  already existed.

**Verified on the real, native device**, not just the web preview —
the explicit point of `NATIVE_TRANSITION_BRIEF.md`. Pierre's own
report: "looks a little bit smoother... the animations look the
same." Both halves of that are exactly the intended, predicted
result — smoother from fewer tickers and proper `RepaintBoundary`
isolation; visually identical because the migration deliberately
changed *how* the animations are driven, not *what* they look like.

## The Word Field System, the void realized in full, and real-time on-device speech (2026-08-06)

A single session that moved from an external design proposal to a
verified, working real-time voice pipeline on the actual device — four
real bugs found and fixed along the way, each traced from real
evidence rather than assumed, and one genuine architecture reversal
mid-build when a platform constraint turned out to make the original
plan technically impossible.

**The proposal, evaluated critically rather than adopted by
default.** An external conversation (reading like Kimi or ChatGPT)
proposed a full physics-based word-particle system — words drifting
toward the orb under simulated gravity, dissolving into an event
horizon, the response condensing back out "like water on glass." The
right response wasn't wholesale adoption or dismissal: it turned out
to already match, almost verbatim, the Speech Visualisation spec in
`NATIVE_TRANSITION_BRIEF.md` and a named-but-never-built "Speech
System" slot in `OFFICE_RUNTIME_V1.md`'s own architecture diagram —
not a new idea, an unbuilt one. What needed real pushback: the
cinematic "black hole"/"event horizon" framing fights Rule 7 (never
loud) and the Ember Test directly; semantic word-weighting needed to
ride the real, already-computed extraction result per Principle 1,
not a fresh AI judgement made just for the animation. Built as Phase 1
only — appear, drift, dissolve on a fixed timer — smallest real domino
first, the same discipline as the Runtime v1 build itself.

**Real bug 1 — invisible by simple ordering mistake.** `WordField` was
placed before `Column` in the body `Stack`, so it painted underneath
the permanent message ledger rather than on top of it. Found from a
real on-device screenshot Pierre sent showing the ledger with zero
trace of any animation. Fixed by reordering — a plain mistake, not a
deep one.

**Real bug 2 — invisible for a subtler, truthier reason, found only
by extracting real video frames.** Even after the ordering fix, still
reportedly invisible. Claude has no native video playback — the real,
working method turned out to be ffmpeg-extracting dense frame bursts
from Pierre's screen recordings and inspecting them as stills, dense
enough to reconstruct real timing. A `WF:N` counter (temporary,
explicitly marked as such, removed once it had answered its question)
proved the event pipeline genuinely worked — `WordSpoken`, defined in
`office_state.dart` since it was first written but never once emitted
anywhere until this session, was now firing and populating real
`WordParticle`s. A full-resolution frame then showed why nothing
registered anyway: the words were painting, correctly positioned, but
at 15px, low contrast, mostly caught mid-fade rather than at peak
opacity, directly overlapping the permanent ledger's own bold text
showing the identical words underneath. Not broken — camouflaged by
its own duplicate. Durable lesson, worth stating plainly for next
time: a video upload is genuinely usable evidence even without native
playback — ffmpeg frame extraction, done densely enough around the
moment that matters, found two real bugs tonight that reading the
code alone could not have caught.

**"The void stays a void" — Rule 3 realized in full, not the partial,
additive version this had been.** Pierre's own words: "the void stays
a void. It must never become a ledger or chat bubble... Words dissolve
out of my mouth into the void. Words appear out of the void as an
answer." This meant more than fixing contrast — the permanent
`ListView` ledger was removed entirely. Replaced with `_ActiveResponse`:
at most one office message ever visible at a time, a real crystallize-in
(fade + scale, not a chat bubble), held for a reading-time-proportional
duration, then dissolved — the direct mirror of Peter's own words on
the input side. `_messages` itself was deliberately left untouched
underneath — it still feeds `_recentHistory()` for real pronoun
resolution ("her" → "Jenny"), and the real transcript already lives
server-side regardless of what the screen shows; the void performs
forgetting, the backend doesn't. One non-negotiable safety rule
enforced here: a message carrying an unresolved `guard()`-held pending
item (a real payment, invoice, quotation) never auto-dissolves while
any item on it is still pending — enforced by simply never arming the
dissolve timer while that's true, reusing `_MessageLine` and
`_resolvePendingItem` completely untouched rather than rewriting any
part of the confirm/reject path itself.

**Real bug 3 — the void's two halves racing each other.** Once both
halves existed, a real screen recording showed the answer crystallizing
in while Peter's own words were still visibly dissolving on top of it
— the backend had answered faster than the input words' natural ~4s
cycle. Not a delay problem; fixed by having the response's arrival
immediately clear any still-visible input words and activate after one
short, deliberate 220ms beat, rather than either colliding with them
or making every answer wait out the words' full natural life for no
reason.

**Real bug 4 — a ~24-second dead first attempt, found the same way.**
A third recording showed 24 straight seconds of a completely
unchanging idle screen before anything happened at all — not "no
visual feedback," genuinely no message ever added, meaning the
recording flow never completed on the first real attempt. Best
evidence-based explanation, not fully confirmed: Android's own
permission dialog likely intercepted the interaction. Separately, real
code review confirmed the orb does attempt a recording-state visual
change (a brighter gradient blend) but the base color stays identical
in the common, non-"all clear" case — the same low-contrast pattern as
bug 2, flagged but deliberately not fixed in this pass, since the
architecture change below made it moot for voice specifically.

**The architecture reversal: real-time on-device speech recognition
replaces record-then-upload entirely.** Pierre's real, pointed
question — why does voice input here lag ~8 seconds when live
transcription elsewhere feels instant — led to a proposal to run
on-device recognition alongside the existing audio-upload pipeline,
framed as "nothing else about the pipeline changes." That framing was
wrong: Android does not support recording raw audio while on-device
speech recognition is active at the same time, confirmed directly
against the speech_to_text plugin's own documentation, not assumed.
Surfaced honestly before writing any code, with the real fork it
created: on-device recognition as a mere preview (keep the existing
architecture, accept the lag) versus on-device recognition becoming
authoritative (instant, but no second, server-side transcription pass
to catch a mishearing). Pierre chose the latter explicitly, naming the
real accuracy tradeoff and the existing guard()/confirm mechanism as
the accepted mitigation.

Built: the entire record→upload→server-transcribe pipeline for voice
removed (`record` and `path_provider` dependencies dropped entirely,
confirmed genuinely unused elsewhere first). `speech_to_text` (7.4.0)
now drives live recognition directly; each new recognized word is
diffed against the previous partial result and emitted as its own
`WordSpoken` event the instant it arrives — real appear-and-dissolve
per word, live, not a batch replay after the fact. The finalized
transcript posts through the exact same `/messages/text` endpoint
typed messages already used, rather than a separate voice-specific
route. `patch_android_manifest.py` gained the real `<queries>` block
Android 11+ requires before the OS's own speech service becomes
visible to the app at all — a documented plugin requirement, not
guessed at. Real robustness built in deliberately, not assumed: an
explicit tap-to-stop sends whatever was heard directly rather than
depending solely on the plugin's own `stop()` reliably firing one more
result callback; a status listener resets the recording state if
Android's own short pause timeout ends a session with no explicit
second tap; an error listener prevents the mic from ever looking
permanently stuck on.

**Verified on the real device — a real, unambiguous success.**
Pierre's own words: "instant, words floating, disappearing, black
screen, rendered a response. Native speech, perfect." First Codemagic
build carrying a genuinely new native dependency, first try. The web
preview build passing throughout this whole arc was real signal for
compilation correctness — never mistaken for confirmation of on-device
plugin behavior, timing, or contrast, which is what real device
testing kept catching that reading code alone did not.

## The real orb rebuild — the case against tuning, and Stage 0 confirmed (2026-08-07)

A separate real critique, delivered plainly: "our embers are in the
wrong place they don't look or behave like embers, our orb looks like
a 2D ball, the background doesn't do much... the visual is flat and
boring." Verified against the actual code before agreeing with any of
it — the orb is a plain `Container` with a static 4-stop
`RadialGradient`, the embers are business-domain tap targets wearing
an ember costume, and the ambient field is small gradient-dot circles
drifting upward. The code comment on that last one already quoted a
*previous* round of this exact complaint ("not orb looking floating
balls") — the earlier fix added an opacity flicker; the shape never
changed. Same complaint twice, because the first fix treated a
materials problem as a timing problem.

**The real, structural conclusion:** Canvas primitives — circles,
gradients, blur — cannot produce "fluid" or "alive" no matter how long
they're tuned, because those qualities come from surface behavior, not
shape. That's what fragment shaders exist for. Two rounds of external
research (evaluated critically, not adopted by default, matching the
Word Field arc's discipline) proposed real, verified reference
material: `LiquidGlassOrbShader.metal` (real, sophisticated "single
coherent swell" wave design — but Metal, not GLSL, needs real
translation, not reuse), `orb.js` (real GLSL, but Flutter's
`FragmentProgram` only accepts a fragment shader — no vertex stage, no
`attribute`/`varying` — so its structure needs real interface work;
also honestly closer to a JARVIS energy orb than the calm-lake target),
and `liquid-shape-distortions` (real, MIT, 107 stars — but its own
README calls it "psychedelic" and built for "rave posters," the
opposite end of the spectrum from calm; the fBM/simplex noise
technique is the real value, not its tuning). Flame engine was
separately proposed and rejected — real and legitimate (10.7k stars,
actively maintained), but adopting a second rendering/game-loop
paradigm to re-earn tonight's already-verified architecture from zero
was the wrong trade for a benefit that was still theoretical.

**Staged plan, refined through one real round of external critique**
(the same evaluate-don't-adopt discipline applied here too — most of
it adopted, one part pushed back on): six stages, each gated on a real
device recording before the next begins. Stage 1 explicitly knows
nothing about Office state — time, resolution, and fixed material
parameters only, so a wrong-looking result can only mean the material
is wrong, not the state machine or controller. The `OrbController`
translates semantic state into material parameters (`energy`,
`swell`), never `if state → playAnimation()` — the concrete API shape
of "simulate, don't animate." Interaction (`interactionStrength`,
`X`, `Y`, `age`) stays separate from state (`stateEnergy`,
`stateSwell`) so a tap disturbs the material without changing what
state it's in — "same lake, different disturbance." The old Container
orb stays reachable behind a runtime toggle rather than a branch,
specifically so old and new can be compared in the same build without
a second Codemagic cycle. One real pushback on the external proposal:
literal `.mp4` recordings committed into the repo were rejected —
binaries don't belong in git and can't be diffed — real findings go in
this file instead, the same discipline as everything else here.

**Stage 0, confirmed on the real device.** Deliberately the most
brutal version possible: a single trivial `.frag` shader — no SDF, no
noise, no helper functions beyond necessary — proving asset
declaration, `impellerc` compilation, `FragmentProgram.fromAsset`
loading, real-device rendering, and per-frame uniform updates, all in
one pass, driven by the existing `OfficeClock` rather than a new timer.
Verified Flutter's exact current shader conventions directly against
the live documentation before writing anything — `#include
<flutter/runtime_effect.glsl>`, `out vec4 fragColor` (never
`gl_FragColor`), `FlutterFragCoord()` (never `gl_FragCoord`, which
Impeller doesn't support) — rather than relying on possibly-stale
training knowledge for a case where a wrong guess would have wasted
the entire point of the stage. Mounted as a small, off-by-default,
purely additive overlay toggled from the existing more-menu, never
touching the real orb's own rendering — the feature-flag discipline
applied from the very first stage, not deferred to Stage 2. Pierre's
own real-device confirmation: "Success." The pipeline is proven; Stage
1 is now a contained graphics problem, not an open question about
whether Flutter and this project's Android setup can run shaders at
all.

## Two real findings on the pending-confirmation stamp, both deferred on purpose (2026-08-08)

A real, concrete example surfaced the on-device speech accuracy
tradeoff accepted when choosing on-device recognition as authoritative
over server-side transcription: an address captured as "eshawi"
instead of "Eshowe." Investigating it turned up two separate, real
findings — both explicitly deferred, not forgotten, "nothing is
breaking, mark it as future polish."

**Editability isn't just a frontend question.** `_resolvePendingItem`
posts to `/actions/{id}/confirm` with no request body at all — a pure
boolean signal telling the backend to commit whatever it already has
staged. There is currently no way for the client to send a corrected
value alongside a confirm. Adding a text field to the stamp without
also changing what confirm sends would be actively worse than doing
nothing — it would look edited and silently save the original, wrong
value anyway, on exactly the class of action `guard()` exists to
protect. Real edit-before-confirm needs the backend endpoint to accept
an edited value too; that's cross-stack work, not something to build
from the frontend alone. The honest, zero-risk path that already works
today with no code changes: reject, then say the correct value again.

**The stamp's visual language doesn't match what it's protecting.**
The original design comment calls it a "dashed-ink stamp," but the
actual border is a plain solid 2px line — the dashed texture was never
built. Pending items render in `_stampRed`, the app's main red, bold
all-caps label, solid border — Pierre's own words: "very obtrusive...
looks intimidating." Worth stating precisely why: a pending
confirmation is the *safe* thing happening, the system pausing before
committing anything — but the visual language borrowed is error/danger
styling, not "please check this." Real candidate directions, not yet
chosen: drop the alarm-red for a neutral or warm tone and reserve red
for actual failures; build the dashed texture the original concept
called for; or question whether the deliberate slight rotation is
earning its cost, since it's likely the most direct driver of "looks
skew" even though it was intentional.

## The receptacle audit — Mr Stevenson, and where Layer 1/2 doctrine meets real complexity for the first time (2026-08-09)

A real, natural, multi-clause booking — a job, an amount, an
installer, and a date, all in one breath — repeatedly failed to
schedule correctly across five real attempts. Requested afterward:
read back through the actual governing doctrine (`OFFICE_CONSTITUTION.md`,
`DECISIONS.md`, `STATUS.md`) to see what was already decided and where
the real gaps sit, rather than treat this as an isolated string of
bugs. It isn't one — it's the first time this doctrine's own stated
promises met a genuinely complex, real utterance, and several of them
didn't fully hold.

**The promise being tested, named precisely.** Principle 3 (Nothing Is
Lost) and Principle 22 (Capabilities Emerge From Captured Reality) —
"Peter doesn't maintain business systems. He describes reality, once,
in his own words" — is exactly what "invoice Stevenson for R20,000 for
two rooms of laminate, schedule Jabulani to install next Monday" is:
one real utterance meant to update several things at once. Tonight
proved that promise doesn't yet hold for this specific shape of
complexity.

**Principle 28 claims more than tonight's evidence supports, and the
doctrine should say so plainly rather than leave the gap silent.** It
declares Layer 1 (Reliability — "a deterministic fact heard clearly...
must never disappear before reaching storage") "genuinely resolved" as
of 2026-07-15, on the strength of a real R9,000 quotation. The
2026-07-24 Layer 2 scheduling entry found the same thing again,
independently — extraction and storage worked correctly for "measured
Thabo hallway at fifteen square meters for laminate, doing it next
Friday." Both real, both true — and both single, unsplit utterances
where every fact arrived in one continuous statement. Tonight's real
test was the first to combine an amount, a room, an installer, and a
date across what `splitIntoTopics` treats as multiple separate topics
— and extraction completeness broke down exactly at that seam, not
because it regressed, but because it was never actually tested against
this shape before. Layer 1 is resolved for the utterance shapes it was
tested against; tonight is real evidence it isn't yet resolved for
this one.

**Layer 2's existing mechanisms don't have a gap where I assumed one —
they share one, single, unexamined precondition.** Read directly
before building anything tonight, not assumed: same-breath assembly
(2026-07-22) requires `customerId !== null` to run at all. Cross-
capture attachment (2026-07-25) requires `scope.customer_id !== null`
too. Both are real, correct, already proven — and both were built and
tested against segments that always had a real customer resolved.
Neither considers the case where a segment has real, valuable
information (an installer, a date) but genuinely no customer of its
own — exactly what "schedule Jabulani to install next Monday," split
away from the sentence that named Stevenson, actually is. The new
`attachToSiblingJobScope` (scheduler.ts) fills that specific,
confirmed-real gap — matched only on `capture_id`, deliberately not
`customer_id`, since the whole point is handling the segment that
doesn't have one. Confirmed directly against the code, not assumed:
this doesn't duplicate or conflict with either existing mechanism: they
solve "how do complete job scopes relate to each other"; this solves
"how does an incomplete segment's real information reach the sibling
it belongs to."

**A second, separate, still-open gap: what a segment's content means,
not just how the sentence gets divided.** `/debug/intent-test`,
confirmed directly: "the job is the one we invoice for 20,000 rand to
rooms" classifies as `intent: "invoice"` — reading a present-tense,
referential amount (identifying which existing job is meant) as an
instruction to bill new work. No existing principle or prior Layer 2
entry names this distinction — it's a genuinely new category of gap,
not a previously-decided thing implemented wrong. Deliberately not
patched tonight: fixing it well likely means either `splitIntoTopics`
preserving more shared context between related segments, or a real,
new way of naming "this amount identifies an existing thing" apart
from "this amount states a new one" — not a quick prompt tweak guessed
at near midnight. Real, related, and confirmed independently by
`customer_name: "rooms"` on the same test — a hallucinated common noun
where no real name existed in the segment at all. That one *was* fixed
and reverified live via the same tool.

**The real, durable win independent of any single fix tonight:**
`/debug/split-test` and `/debug/intent-test` — real, read-only, direct
views into two steps of the pipeline that previously had zero
visibility, closing exactly the kind of guessing that cost real cycles
on both the ember shader and this arc. The customer_name fix was
verified true, not just claimed, because these existed.

**What's genuinely still open, named rather than left implicit:**
whether Principle 28's Layer 1 status needs a qualifying update instead
of a flat "resolved"; whether `attachToSiblingJobScope` should extend
to the installer-double-booking check it currently skips; and the
intent-misclassification gap above, which needs real design thought,
not a rushed patch.

**Real bug found live, 2026-08-26 — a pure scheduling voice note
silently discarded.** "Schedule the Premier Hotel to be installed
tomorrow" — a named customer, a real date, no measurements or task
text — produced no job scope at all, and nothing showed up in
Scheduler. Not a date-parsing bug: `resolveScheduledDate` correctly
turns "tomorrow" into a real ISO date, and `recordWorkObservation`
correctly saves it once called. The actual bug was one step earlier —
the gate deciding whether to call `recordWorkObservation` at all only
ever checked `observation.components.length > 0 ||
observation.tasks.length > 0`, never whether a date or installer was
actually extracted. A pure "schedule X" statement satisfies neither
condition, so the whole thing was skipped before the correct,
downstream logic was ever reached. Fixed by also checking
`scheduled_date_raw`/`installer_name` in that gate.

Two other, similar-looking gates checked and deliberately left alone,
not silently assumed safe: the `price_scope` fallback path (a
different context — nothing measured genuinely means nothing to
price, so skipping is correct there) and the sibling-attach path added
2026-08-09 (a different scenario — no customer named at all, not a
named customer with no measurements).

**The real, durable gap this exposed:** unlike `extractIntent`
(covered by `/debug/intent-test`, `/debug/split-test`, and 22 cases in
`/debug/smoke-test`), `extractWorkObservation` and its recording gate
had zero live visibility — exactly why this went unnoticed. Closed the
same way those were: added `/debug/work-observation-test`, read-only,
same real, proven zero-side-effect design.

**What was genuinely still open at that point:** the fix had not been
independently, empirically verified against a real voice transcript —
confirmed by direct code reading, not by observing corrected live
behavior. The existing 22-case smoke suite doesn't exercise this code
path either (it stops at `extractIntent`), so a clean run there would
not, on its own, confirm this specific fix.

**Real, second bug found — this one only surfaced because verification
kept going instead of stopping at the first green light.**
`/debug/work-observation-test` confirmed the gate fix worked in
isolation (`wouldRecord: true`, `resolvedDate: "2026-08-28"`). On that
basis, a real fresh native build was run and the same voice note
spoken again — and the job still didn't reach Scheduler. It showed up
as a task instead. That test call had a real, honest blind spot: it
invoked `extractWorkObservation` directly, which meant it never
verified that the real, upstream `extractIntent` classifier would
route this phrase there in the first place. Called `/debug/intent-test`
directly against the exact phrase — confirmed `intent: "reminder"`,
not `"work_observation"`. A second, genuinely different, earlier bug,
not a recurrence of the first.

**Root cause:** `work_observation`'s own written definition in the
extraction prompt only ever described "measuring, scoping, or
inspecting a job" — it never once mentioned scheduling or assigning a
date or installer, even though the downstream code
(`extractWorkObservation`, `resolveScheduledDate`) was already built
correctly to handle exactly that. The classifier had no way to know a
pure scheduling statement belonged there, so it reasonably fell back
to "reminder" — genuinely, structurally similar wording ("remind me to
call Jenny by Friday" vs. "schedule the Premier Hotel... tomorrow").
Fixed by adding an explicit clause to `work_observation`'s definition,
naming the exact confirmed phrase as a worked example, rather than a
broad rewrite that could shift other, already-correct classifications.

**The full, real verification chain, each link checked before trusting
the next:**
1. `/debug/intent-test` re-run against the same phrase — confirmed
   `intent: "work_observation"`.
2. `/debug/smoke-test` re-run — all 22 cases still passed, including
   the one closest in shape to the new clause ("heading to jenny's job
   now, remind me to get dog food after" — still correctly classified
   `"reminder"`), confirming the new clause is genuinely narrow, not a
   rule that happened to fix one case by loosening the boundary
   everywhere.
3. A real, fresh native build, the exact same voice note spoken again
   — the job appeared in Scheduler: correct customer, correct
   description, correct date.

**Why this is the real, worked example of the discipline asked for
directly:** two separate, real bugs, in two different layers of the
same pipeline (a downstream recording gate, an upstream classification
definition), each one found by direct code investigation rather than
guessing, each fix checked in isolation before being trusted, and nothing
declared "done" until the actual, live behavior was observed — not
just a diagnostic tool's output. The first fix alone would have shipped
looking correct (its own test passed) while the real, reported bug
remained completely unfixed. Layered verification, not single-point
confirmation, is what actually caught that.

**Calendar integration, 2026-08-27 — Scheduler's real, first "third
tap": a job leaves the Office and exists somewhere else.** Every real
feature built before this stayed inside the app. This is the first
time a job genuinely, permanently exists outside it — a real device
calendar entry, shareable, visible without ever opening the Office —
directly following the newly-settled principle that the third tap is
where the app stops describing and starts touching reality.

**A real dead end, checked directly rather than assumed away.** The
existing Google OAuth in this codebase was suspected as reusable
infrastructure for this. Checked directly instead of assuming: it
requests only `openid email profile`, and the code only ever captures
an `id_token`, never an access or refresh token. That's genuinely
login/access-control — verifying who's allowed to use the app at all
— not authorization to act on a user's calendar. A real, different
capability that happens to share the word "OAuth." Reusing it would
not have worked; this was confirmed, not guessed.

**The real, simpler path: Android's own native calendar, no OAuth at
all.** Confirmed via direct search: a real, built-in Android content
provider, needing only standard `READ_CALENDAR`/`WRITE_CALENDAR`
runtime permissions — the same familiar pattern already used for
microphone access. For anyone with a real Google account already
signed into their phone, the OS itself keeps the device calendar
synced with Google Calendar automatically, delivering the real,
practical outcome wanted without OAuth ever entering the picture.

**A real mistake caught and fixed before any code was written.** The
first draft of `CALENDAR_INTEGRATION_ARCHITECTURE.md` named
`device_calendar_plus` as the chosen package, but described the
hand-off, pre-filled behavior that's specifically `flutter_native_calendar`'s
feature — `device_calendar_plus` is built around direct read/write, a
different mode. Caught by re-reading the document's own claims against
what was actually verified, corrected before any implementation began.
`flutter_native_calendar` (confirmed real, current version `^0.3.0`
directly against pub.dev) became the real choice for this first
version; `device_calendar_plus` correctly named instead as the right
choice for a later, direct-write version.

**A second real, structural discovery, this one about the repo
itself.** Attempted to edit `AndroidManifest.xml` directly to add the
new permissions — it doesn't exist in the repository at all. The
`android/` directory is deliberately not committed; it's generated
fresh on every build via `flutter create`, per `codemagic.yaml`. The
real, correct, already-established mechanism for this exact situation
was `patch_android_manifest.py` — a real, existing script, already
proven for microphone and camera permissions, that patches the
freshly-generated manifest as a build step. Editing the (non-existent,
non-persistent) committed manifest would have been real, wasted effort
that silently did nothing on the next build. Found before that mistake
was made, not after.

**Deliberately narrow first version, matching the same "smallest real
domino" discipline used everywhere else tonight.** A real, explicit
"Add to Calendar" action per job — not an ongoing sync, which would
mean handling updates, deletions, and duplicate prevention correctly,
forever, on someone's real calendar. Hands off to the device's own
calendar app with the job pre-filled (customer, description, an
honest all-day event, since only a date was ever extracted from
voice, never a specific time) — the person taps save themselves. No
`WRITE_CALENDAR` permission requested yet; that's the real, named next
step once this version is proven, not attempted here.

**What was genuinely uncertain going in, named rather than assumed
safe:** this was the first native-platform package dependency added
all night — everything before it was pure Dart, verifiable by the
automated web-preview build alone. A mobile-only native plugin could
plausibly have broken that same web build, or worked differently in a
real native build than the web preview could ever show. Checked
directly rather than hoped: the web-preview build was confirmed
passing with the new dependency in place before writing any Dart code
against it, and the real native build and a real device tap were what
finally, actually confirmed this working — not assumed from a clean
compile alone.

**Real, found discrepancy, pinned rather than fixed — imported
historical invoices double-charging VAT on PDF generation.** Checked
directly against a real, generated PDF for an imported invoice
(ZF21426): the source CSV shows `Tax: 0, Subtotal: 11860, Total:
11860`, but the generated PDF showed VAT of R1,779 and a total of
R13,639. Root cause, confirmed directly in the existing PDF code: any
invoice's stored `amount` automatically gets 15% VAT added at PDF-
generation time unless that customer is explicitly marked VAT-exempt —
correct, sensible behavior for a new invoice created through voice,
where the amount is genuinely a pre-tax subtotal. The CSV import
instead stored the file's own `Total` column — already the real,
final, historically accurate figure — so the existing logic then added
a second, fictional 15% on top of a number that was already complete.
Likely affects most of the 271 already-imported invoices, since the
real, uploaded file shows the large majority with `Tax: 0`.

**Why this is pinned, not fixed immediately, in the pinner's own
words:** "the notion that another business would be as messy as me is
unhinged." The real, uploaded data shows the same customer sometimes
billed with tax, sometimes without, across the same business's own
history — which the existing, simple all-or-nothing per-customer
VAT-exempt flag genuinely cannot represent. Building a general,
per-invoice tax-final override to solve this would be solving for a
problem that may be specific, real mess from one business's own
history — not a universal case every future business's historical
import would need. Real evidence from a second business would change
this; none exists yet.

---

## Real, extracted lessons — the CSV import journey

The detailed, blow-by-blow of building customer and invoice bulk
import is already recorded above, entry by entry. This is the
consolidated, forward-looking version — what should actually change
about how future work like this gets done, not a re-telling.

**Test parsers against the real, actual file, never pasted or
reconstructed text.** The very first version of the invoice CSV,
pasted into a chat message, appeared to have real, inconsistent
delimiters (tabs, then semicolons). It didn't — the real, uploaded
file was completely, consistently comma-delimited throughout. The
apparent inconsistency was purely an artifact of the paste. A parser
built to handle a paste-artifact problem that doesn't exist in the
real file is effort spent solving the wrong thing.

**Independently verify a parser against real edge cases before it
touches live code — and this is the one part of the journey that
already worked, worth reinforcing, not just critiquing.** Both the
customer and invoice CSV parsers were written and tested standalone,
against real data extracted from the actual file, before being placed
in `index.ts`. The invoice parser's payment-detail sums were checked
against all 295 real rows, with zero reconciliation mismatches, before
any endpoint used it. This should stay the default for any future
parsing work, not something reached for only when a project feels
important enough.

**A shared field's meaning is a real contract with everything that
already reads it — writing to it isn't enough; what already consumes
it has to be checked too.** The VAT double-charge happened because
`invoices.amount` was silently written as a post-tax total, while the
already-existing PDF logic had always treated that same field as a
pre-tax subtotal and calculated VAT on top of it. Nothing was wrong
with either piece of code in isolation — the bug lived entirely in the
unchecked assumption that both sides agreed on what the field meant.
Before writing new data into an existing table or field, find and read
what already consumes it, not just confirm the column exists and
accepts the value.

**A platform quirk can look like a data problem at first — check the
platform before concluding the data is wrong.** CSV files, especially
Excel-saved ones, are a well-documented `file_picker` limitation on
Android specifically, unrelated to anything about the file itself.
Confirmed directly via search before writing a fix, rather than
guessing at what might be wrong with the file.

**Two similar-looking actions sitting next to each other, both opening
the same generic system file picker, are a real, easy way to select
the wrong one without noticing.** The customer-import and invoice-
import icons look different, but the file picker each one opens looks
identical regardless of which button triggered it — nothing in that
screen tells the person which import they're actually about to run.
Worth a real, named lesson for any future feature with more than one
similar action: the file picker itself carries no context back to the
person using it.

## Real, extracted lessons — the ember positioning escapade

Also already recorded above in the individual commits. This is the
consolidated version.

**A confirmed, correctly-deployed code change producing zero visible
difference is a real, distinct category of problem from "the fix was
wrong" — and it deserves a different, cheaper diagnostic step much
earlier, not three more rounds of the same kind of guess.** Three
separate alignment adjustments were made, each verified present in the
live, deployed code, before a five-minute fix (a visible build-version
marker on screen) actually confirmed the real code was reaching the
device at all. That diagnostic should have been the second move, not
the fourth, the moment a real, dramatic code change produced no
visible effect whatsoever.

**A child that already nearly fills its parent's available space makes
`Align`'s positioning value nearly irrelevant, no matter how dramatic
the value.** The real root cause: an earlier fix grew the ember
container's own height to stop one ember from rendering outside it,
which left almost no real slack in the parent for `Align` to
distribute at all. The lesson generalizes past this one bug: fixing an
overflow by growing a container can silently consume the very room a
sibling or the same widget's own positioning depends on. Check the
full, real parent-child size relationship, not just whether the
immediate overflow is gone.

**When multiple, parallel UI variants exist behind a toggle, confirm
which one is actually active on the real device before diagnosing
anything about its appearance.** Real time was spent reasoning about
whether "old" and "tear" embers were both visible at once before
checking the toggle's actual default value directly in the code — it
defaults false, so only one variant was ever being seen the entire
time.

**A textual description of a UI problem is a real, working hypothesis,
not a confirmed diagnosis — a screenshot resolves ambiguity that
several rounds of careful reasoning cannot.** Multiple, plausible-
sounding but ultimately wrong theories were built from words alone
before the actual, real constraint (a too-small parent height) was
found by directly calculating the numbers. Ask for a screenshot early
in any UI-positioning report, before investing in more than one
theory-driven fix.

---

## The full arc — from "huge gap between expectation and reality" to a working, voice-triggered dashboard

**Where this started: a real, honest admission, driving, mid-session
— "there's a huge gap between what this app should be able to do and
what it's actually doing... it's very laggy... it tells me it doesn't
have things on file... nothing is tying it all together."** Named
directly as more important than any single feature: a real, working
system that feels coherent, not a collection of individually-tested
rooms.

**The real audit that followed (`CAPABILITY_AUDIT.md`) found something
genuinely surprising: the backend was far deeper than five rooms
suggested** — real leads, projects, snags, full P&L, aged debtors and
creditors, all real and working, checked directly against the code.
The actual problem wasn't missing capability — it was capability with
no discoverable path, answerable only if the right words were spoken.

**A real, measured performance fix came first** — seven independent
database aggregates for a general financial question were running
sequentially instead of concurrently, a real, confirmed, direct
contributor to the reported "very laggy" feeling. Fixed with
`Promise.all`, every conditional branch preserved exactly.

**Then a real, live demonstration of the deeper problem**: "what's our
financial position" as a spoken question took two minutes of silence
before answering — not from any single, findable bug, but from routing
a question that has a real, structured, already-known answer through
an unnecessary, slow AI-synthesis step. This produced the real,
architectural reframe that governed everything after: AI should
determine intent and route, never compose an answer a real,
deterministic path already has. Refined further with a genuine,
load-bearing distinction — complexity, not topic, decides whether a
question deserves a real dashboard or a real, spoken sentence — and
tied to the project's own core identity: "the last thing we want is
SAP, but we do want to capture the business intelligence in SAP." Real
depth, delivered through the shell's own minimal shape, never through
SAP's actual navigation. All captured in `LOOKUP_ROUTING_ARCHITECTURE.
md` and pinned into `ERP_MODE_ARCHITECTURE.md` alongside its
input-side counterpart.

**Building it, in order: classify, test live, then wire in — the same
discipline as every other classifier tonight.** `classifyDashboardIntent`
built, tested against three real, distinct categories (a confident
match, a correctly-distinguished sibling case, and — the one that
mattered most — a narrow, specific question correctly recognized as
*not* dashboard-worthy) before ever touching the live pipeline.

**A real, severe regression, introduced and then found and fixed the
same night.** Wiring the classifier in meant wrapping existing,
working logic in a new `else` block — which silently moved several
variable declarations out of scope for code sitting right after that
block that still needed them. A genuine `ReferenceError`, a real 500,
on any business-scope question that fell through to the conversational
path — a regression on already-working functionality, caused by the
new feature's own wiring, not a pre-existing issue. Found by reading
the actual, pushed code line by line after a real, reported 500 error,
not guessed at.

**A second, deeper, genuinely different bug, found only by real,
repeated live testing after the crash was fixed:** "who owes me
money," asked with real conversation history present, kept getting
silently answered about Jenny — whoever the `register`'s most recently
touched selection happened to be — instead of opening the real,
correct dashboard. Confirmed directly: the `register` is real,
persisted D1 state, not conversation memory. It survives indefinitely,
with no sense of staleness, until something else explicitly overwrites
it.

**The real, key insight belongs to the person who lived with this
system the longest, not to a fix found in the code.** Put directly:
the `register` was originally built to make the system feel
"responsive and alive" — a real, deliberate, good feature — and the
same mechanism that created that feeling was now the thing quietly
breaking a genuinely broad question by pulling it back to stale,
irrelevant context. Correctly reframed, on the spot, as not a forced
choice between "a practical ERP" and "a persistent conversation tool"
— the real fix was recognizing that a person handles this by reading
one, precise signal per sentence (does this specific message actually
point back to something, or does it stand on its own), not by running
two competing modes.

**The precise fix reused an already-proven pattern rather than
inventing a new one** — `splitIntoTopics`' own, existing pronoun-
detection judgment, applied one level up to the whole-message
question of whether entity resolution should even be attempted.
`containsBackwardReference` built, and — worth naming honestly — my
own first test example in its prompt was itself wrong ("what's that
going to cost" characterized as non-referential when it's actually a
genuine reference in almost any real context); caught by the model
faithfully following a flawed instruction, corrected before it caused
real harm. Tested live against both real, load-bearing cases — the new
bug ("who owes me money" → correctly, no reference) and the
already-proven, older case ("those instances" → correctly, a real
reference, confirming the fix doesn't regress it) — before being wired
into the actual `scopeCouldBeEntity` check, replacing the blunter,
real gap in the original history-length proxy.

**Confirmed working by recreating the exact, real, original failure —
not a fresh, easy case.** Real conversation history deliberately
present, the same genuinely standalone question asked again — the
real dashboard opened correctly this time.

---

## Building the identity layer — from research to a real, safely-backfilled foundation

**Started from `IDENTITY_ARCHITECTURE.md`, itself built on real,
external research** — Git's `.mailmap` discipline, and real,
independently-converging patterns checked directly against Twenty
CRM's and Frappe/ERPNext's live schemas, not just summaries.

**The real, first step was deliberately narrow and purely additive:**
a new, empty `people` table, and nullable `person_id` columns on
`customers`, `characters`, `leads`. Nothing existing read, touched, or
altered — the same, proven migration discipline as every schema
change tonight.

**`reconcilePerson` built next, implementing the real, precise
threshold from the architecture document** — an exact match
reconciles; no match is genuinely new; anything weaker (a short token
under 8 characters, even with one candidate, or multiple candidates at
any length) is never guessed, returned as ambiguous instead.
Independently verified against real SQLite behavior, across all four
real outcomes, before ever being pushed.

**A real, genuinely confusing deployment mystery followed, worked
through methodically rather than guessed at.** The new diagnostic
route returned a bare "Not Found" with no real, useful detail.
Ruled out, one real, direct test at a time, in this order: a
structural routing problem (a zero-logic sibling route, added the
same way, worked fine); a caching issue (a fresh, uncached URL still
failed); a genuine Cloudflare platform incident (checked directly
against Cloudflare's own, official, real-time status API — nothing
relevant, unresolved). The actual cause only became visible once the
route was rewritten to catch and surface its own real error instead of
letting it throw uncaught — at which point it simply worked, cleanly,
on the next normally-timed deploy. Two consecutive, unusually slow
deploys immediately before this were the most likely real explanation
in hindsight: a genuine Cloudflare edge-propagation delay, not a code
defect — code, imports, and call sites were all independently
re-verified correct throughout and never needed to change.

**The real backfill was built with a safe, honest default: dry-run
first, real writes only on explicit `?commit=true`,** per the
architecture document's own stated caution to run this "reviewed, not
assumed correct silently." The first dry run surfaced a real, serious
bug in the backfill's own logic, not a pre-existing one: it only
checked for an exact string match across tables, without applying the
same 8-character caution `reconcilePerson` already used going
forward. Confirmed as a genuine bug, not a hypothetical one, by real,
direct knowledge: "Sipho," "Thabo," and "Alfons" were confirmed to
each be different, real people despite an exact name match — only
"Andre" happened to be correct. Three wrong, automatic merges would
have been committed silently if this dry run had been trusted at face
value instead of actually read.

**Fixed by applying the identical threshold already proven in
`reconcilePerson`, verified against the exact, real, confirmed bug
scenario before being pushed again.** The second, corrected dry run
showed every one of those real collisions correctly flagged for
review instead of merged — including "Andre" itself, applied
consistently rather than specially exempted, since the system has no
way to know in advance which short-name match is the safe one.

**The real, final judgment call: commit now, since the safe default
already prevents any wrong merge, rather than delay for a full
resolution tool first.** The one, real gap that decision accepts —
Andre's two records staying split until manually reviewed — is a
small, reversible cost against the real, immediate benefit of giving
every future capture a populated `people` table to check against.
Paired with one, small, real addition so that gap couldn't quietly get
lost: a persistent `needs_merge_review` flag on `people` itself, and a
plain, direct `/debug/people-needing-review` endpoint — so the six
real, flagged records (two Andres, two Siphos, Alfons, Thabo) stay
genuinely findable whenever there's time to resolve them by hand,
rather than disappearing into a one-time API response.

**Committed successfully. Zero wrong merges — the one measurable this
entire effort was built to guarantee.**

---

## A third, distinct register-staleness bug — found by direct insight, not by chasing the code

**Real sequence that broke:** "What does Alfons owe us?" (correctly
answered, R8150) → "Does Andre owe us anything?" → answered with
Alfons's real facts again, though worded honestly enough to notice
its own mismatch: "I don't have that on file, the information I have
is for Alfons."

**The real, key insight belongs to Pierre, not to chasing the
identity code.** Directed straight at the actual cause: "look in the
cache or persistent conversation section." That one line pointed
past two real, plausible but wrong theories tonight (a bad match in
the new `reconcilePerson` shortcut; the older register-staleness fix
from earlier not covering this case) — both checked and ruled out
directly, not assumed — to the real, third, distinct cause.

**Confirmed: for a `lookup` intent, `reconcileCustomer` is never
even called — a separate, read-only function, `findExistingCustomerByName`,
is used instead**, and correctly, honestly returned no match for
Andre. The real bug was one level up: the register-check that runs
afterward only asked "is `customer` still unset," never "why." A
real name that was genuinely given and honestly didn't match was
being treated identically to a vague, nameless follow-up — both
leave `customer` unset — and silently fell through to the register's
stale selection instead of the honest "not on file" answer. The
earlier, same-night `containsBackwardReference` fix didn't cover this
either, since it was deliberately scoped only to `query_scope ===
"business"`; this case's scope was `"customer"`, never touched by it.

**Fixed with one, real, precise addition: the register only fires
when no real name was given in the message at all.** Traced against
every already-proven case tonight before pushing — the ProSupply
follow-up, "who owes me money," a genuine vague "his address" — all
have no real name extracted, so none were at risk; only the new case
(a real name given, honestly unmatched) changes. Confirmed live,
twice: the exact, original failure now answers honestly with no
mention of Alfons; and immediately after, a genuinely vague follow-up
("what's his address") still correctly resolves through the register,
unaffected.

**Real, honest pattern worth naming for whatever comes next:** three
separate, distinct bugs tonight all trace back to the same, single
mechanism — a name-check that only asks "do I have an answer" without
asking "do I actually have grounds to be confident in it." Worth
remembering as its own, real principle the next time a lookup falls
back to something plausible-looking, not just for the register
specifically.


---

## Relational Identity Architecture pinned — a second, auxiliary signal for the genuinely ambiguous cases

**The real, honest starting point:** the six people still sitting at
`/debug/people-needing-review` aren't a backlog problem — they're
proof that `reconcilePerson`'s string-threshold matching has a real
ceiling. It resolves identity from a name alone. It was never going
to responsibly resolve two genuinely ambiguous names on its own, and
it shouldn't be pushed to.

**The real insight, arrived at by thinking through the problem out
loud rather than by staring at the schema:** a person isn't just a
name — they're a position in a real web of who they've talked to,
which jobs they've touched, and when. Two independent conversations
that keep circling the same job, the same referral chain, the same
time-of-day pattern are real evidence of identity, separate from and
complementary to a matching string. `RELATIONAL_IDENTITY_ARCHITECTURE.md`
pins this as a genuinely new, staged layer: passive edge-logging
first with zero behavior change, then a tiebreaker consulted only in
the exact ambiguous zone `reconcilePerson` already can't resolve
alone, then Vectorize-based shape-matching named honestly as a later,
separate stretch — Vectorize already sits in this stack, provisioned
and mostly unused for this.

**The real, deliberate boundary drawn before any of this gets built:**
it was tempting, in thinking this through, to imagine a system that
eventually recognizes its own emergent patterns and lets that
recognition become a new category on its own authority. Named
directly and rejected: that's functionally identical to letting AI
invent a business fact instead of routing to a deterministic one —
the exact thing the AI-routes-it-doesn't-decide principle exists to
prevent. Any future capability that proposes a new relational
category still goes through the same human-confirmation gate as every
other consequential write in this system, permanently, not as a
placeholder for once the tech is better.

**What stays true regardless of how far this goes:** `reconcilePerson`
keeps its current authority untouched. The new layer only ever adds a
second opinion in the cases it's already honest about not being sure
of — it never gets to auto-merge anything by itself.

---

## The real transcription source found — and the fix that actually followed from it

**The real, honest starting point, again:** the interaction_edges test earlier tonight produced "Sipo," "sipo," and "Sepo" as three separate people, all really meaning the same real installer already on file as "Sipho." The instinct was to look at server-side Whisper first — reasonable, since that's the transcription code visible in `ai.ts`.

**Real, direct check before building anything: no audio from tonight was ever in R2.** `/debug/list-audio`'s most recent file was from 2026-08-14, a month old. That's real, confirmed evidence — not a guess — that tonight's messages went through `/messages/text`, which takes plain text directly and never touches `transcribe()` or Whisper at all. Traced further, directly: `app/lib/main.dart` calls the on-device `speech_to_text` package's `listen()`, with no `localeId` and no other option set, and posts the recognized text straight to `/messages/text`. The actual source of tonight's confusion was the phone's own on-device recognizer, a genuinely different system from anything in the Worker.

**Checked directly before concluding anything: `speech_to_text`'s own public API (`SpeechListenOptions`) has no vocabulary or biasing option at all** — only `cancelOnError`, `partialResults`, `onDevice`, `listenMode`, `sampleRate`, `autoPunctuation`, `enableHapticFeedback`. That real gate closed, not assumed closed.

**The real fix that followed: a phonetic pass, verified by hand before writing a line of code.** Standard Soundex encodes "Sipho," "Sipo," and "Sepo" all to `S100` — the exact real cluster from tonight. Checked directly against the earlier, real Andre/Juandre bug before trusting this: those encode to `A536` and `J536` — different first letters, genuinely different codes, so this addition cannot reopen that fix. Wired into `reconcilePerson`'s existing final fallback, reached only when no exact or whole-word match exists — and, same as every other real candidate list in that function, a phonetic hit never auto-matches. It only ever returns `ambiguous`, which — because of the holdForConfirmation wiring from earlier tonight — now correctly asks instead of silently creating another duplicate.

**Real, honest limit worth keeping on record:** Soundex won't save the worst case from tonight — "Cpol" is too far a phonetic stretch from "Sipho" for any string-based technique to bridge. That's real evidence the on-device recognizer can still produce something no downstream fix will catch; worth remembering the next time a name lands unrecognizably wrong rather than just oddly wrong.

**Also built alongside this, real and separate:** `/debug/reprocess-turbo`, a read-only comparison between the live base Whisper model and `whisper-large-v3-turbo` + a real `initial_prompt` built from this business's actual known names. Confirmed same price either way ($0.0005/audio minute, same shared free daily neuron pool everything else already draws from). Still untested against a real recording as of this entry — it defends the separate, real `/files/audio` "Talk mode" path, not tonight's actual bug, and shouldn't be mistaken for having fixed tonight's issue.

---

## The real data-loss bug — on-device speech revisions silently discarding a correct transcript, and the confirmed fix

**The real, honest starting point:** three separate, clean, unambiguous commands tonight — a new customer, an invoice, a scheduled install — all arrived at the server missing their beginning, including the customer's name every time. This was first mistaken for a possible extraction or ambiguous-hold regression from earlier tonight's work; checked directly and ruled out, since none of that code runs until a customer name already exists, and none of it exists on `/messages/text`'s path at all. Also checked and ruled out: a Cloudflare outage (the Worker was confirmed live and responding), and the earlier "forget that last one" self-correction theory, which didn't hold once the same exact sentence, spoken slowly and deliberately a second time, produced the identical truncation — `"on Friday"`, verbatim, twice. A repeatable, deterministic result rules out random mishearing.

**The real mechanism, traced directly in `main.dart`, not guessed:** the on-device recognizer can revise an earlier guess mid-utterance rather than extend it — already partially documented in this file's own existing comment on that exact branch. When it does, the app clears the display and treats the revision as the whole transcript, discarding everything accumulated before it. Whatever got sent — through the natural final-result path or the manual tap-to-stop path — was whatever the recognizer had most recently revised itself to, with nothing keeping track of the longest, most complete thing it had actually produced.

**The real fix:** a new `_longestTranscript` field, updated on every recognizer callback and never allowed to shrink, reset at the start of each new listen session alongside `_lastPartialTranscript`. Both real send sites now send whichever is genuinely longer between the current result and the longest one seen this utterance — so a late, shorter revision can no longer overwrite an already-correct, complete transcript. A final result that's genuinely longer (the normal happy path) is unaffected.

**Confirmed working end to end, not just at the capture:** the exact sentence that failed twice tonight — "schedule stylish to install for Steven on Friday" — was repeated after the fix shipped and a real Codemagic rebuild, and this time landed whole: customer "Steven" created, job scope #49 created with installer "stylish," description "installation," and "Friday" correctly resolved to a real calendar date, all correctly linked back to the capture that produced them.

**Also real and worth keeping on record, separate from this bug:** the generic `"Got it."` fallback (a much older, pre-existing pattern, not part of tonight's regression) still doesn't distinguish "nothing to report because everything worked" from "nothing to report because nothing was extractable." That's a real, smaller, still-open honesty gap — not urgent, but real, and it's what made this bug so much harder to notice in the moment, since a silent data-loss and a genuine success currently sound identical.

---

## Job scope amendment detection, built and confirmed working end-to-end

**The real, honest starting point:** `recordWorkObservation` always created a new job scope unconditionally — no check anywhere for whether a message describing a schedule or installer change was actually about a job that already existed for that same customer. Confirmed live: "Steven asked if we can start after 12 on Friday..." created job scope 50, separate from job scope 49, both for the same real customer and the same real Friday.

**The real design, logic'd out before building anything:** reuse `findLatestJobScope` exactly as-is for recall — the same real, deterministic transcript-matching already proven for pricing since 2026-07-22 — rather than inventing a new matching mechanism. Trigger narrowed deliberately to the real evidence: only considered when the new message has no components or tasks of its own, since a genuinely new job almost always comes with real measurements attached, while a pure logistics change doesn't. A new `job_scope_amendments` table holds one real, permanent row per field that actually changes (`job_scope_id`, `capture_id`, `field_name`, `old_value`, `new_value`), written before `job_scopes` itself is touched, so `job_scopes` stays simple "current truth" while the full real history lives permanently in the audit log. Held for confirmation exactly like every other consequential write — CONFIRM applies the update, REJECT creates a genuinely new, separate job scope via the same path that would have run anyway.

**The real gap found immediately after building it:** the first attempt only patched one of three real places in `index.ts` that could create a job scope from a pure-logistics observation. Confirmed live: "Richards Hotel job, let's schedule that for next Wednesday" created a fourth new job scope (54) instead of holding, because it landed in a different branch — the one that relies on the current selection rather than restating an explicit customer name — which the first patch never touched. Fixed properly: moved the check into one real, shared function (`checkForJobScopeAmendment`, in `finance.ts`, colocated with `findLatestJobScope` and `holdForConfirmation`), called from both real sites that can produce a pure-logistics observation, rather than patched into one call site at a time.

**Confirmed working end-to-end, on a clean customer, not just at the hold:** "Bond Empangeni job, let's schedule that for next Tuesday" correctly held, referencing job scope 48 by name and description. Confirmed: `job_scope_amendments` now shows a real row — `old_value: null`, `new_value: "next Tuesday"` — and job scope 48 itself shows `scheduled_date_raw: "next Tuesday"`, correctly resolved to a real calendar date, installer untouched since it wasn't part of the message. No new job scope was created.

**Real, known leftover from testing, deliberately not touched without confirmation first:** job scope 54 (Richards Hotel) is itself a leftover mistake from testing the bug this fix addresses — created before the fix deployed, then matched against itself on a contaminated second attempt (`old_value` and `new_value` identical). Left in place pending a direct decision on deleting it, not merged or silently cleaned up.

**Also real and still open, unrelated to this fix:** "Steven" (213) and "Stevens" (214) are almost certainly the same real customer, split across two records from the same testing session — job scopes 51 and 53 sit under the wrong one. Noted, not yet acted on.

---

## The multi-candidate confirm fix, the fragmentation it caught, and a real, reusable merge mechanism

**The real, honest starting point:** action #114, a genuine two-candidate `ambiguous_person` hold ("Bon hotel waterfront" against "SCHOONIES SEWE T/A BON WATERFRONT" and "Bon Hotel Empangeni"), had no way to be answered correctly — CONFIRM/REJECT could only express yes/no, never "the first one." Checked directly rather than assumed: it had already been resolved by REJECT, which — correctly, by its own design — created a brand-new customer rather than guessing. Then a follow-up capture did the same thing again. Real result, live, in one evening: one real business split across three separate customer records (41, 215, 216).

**The real, reusable fix, not a one-off patch:** the `ambiguous_person` CONFIRM handler now accepts an optional `personId` in the request body. If it matches one of the action's real candidates, that one gets used regardless of how many candidates exist. The single-candidate case is completely unchanged when no `personId` is sent. Usable today via a direct call even with no picker UI built — the same real mechanism a future picker would call, not a separate path to keep in sync later.

**The real cleanup that followed, built the same way everything else tonight was built — audit trail, not deletion:** a new, reusable `/debug/merge-customers` endpoint repoints every real, live-state table that references `customer_id` — checked directly, not assumed: `payments`, `expenses`, `invoices`, `quotations`, `stock_usage_log`, `snags`, `projects`, `leads`, `job_scopes`, `tasks` — from a losing id onto a surviving one. Deliberately does not touch `captures.customer_id`: a capture is the immutable record of what was actually believed true at the time it was made, same discipline as everything else in this project that refuses to rewrite raw history. The losing customer row is never deleted, only marked via a new, nullable `merged_into_customer_id` column, so the fact a merge happened — and into what — stays real and inspectable rather than silently erased.

**Confirmed working, real data, not assumed:** 215 and 216 merged into 41. Real per-table output showed exactly `job_scopes: 1` for each merge, zeros everywhere else — correct, since neither had ever touched an invoice, payment, or anything beyond the one job scope each had created. Verified after the fact, directly: job scopes 47, 55, and 56 all now sit under customer 41, "SCHOONIES SEWE T/A BON WATERFRONT," one real business, correctly unified.

---

## A real extraction failure caught deterministically — a known installer's name eating the real customer

**The real, honest starting point:** "let's schedule stylish for the bon waterfront installation" produced `customer_name: "Stylish"`, `character_name: null` — asking "is Stylish now a customer too?", the wrong question entirely. Traced directly against three real payloads side by side: two earlier phrasings ("...to install for...") extracted correctly every time; the moment that explicit verb was missing, "bon waterfront" — the real customer — wasn't captured as *any* field at all, not just mislabeled. A field swap couldn't have fixed this; there was nothing to swap into.

**The real, deterministic fix, not a prompt tweak alone:** reuses `checkCrossRoleCollision`'s own result rather than a new query. When a `work_observation` message names someone already on file as a character, with no `character_name` of its own, that's real, strong evidence the extraction dropped the actual customer — not a genuine "this installer is now also a customer" case. Responds honestly instead of asking the wrong question: *"'Stylish' is already on file as someone who does the work, not a customer — that might not have come through fully. Try saying it again?"* No pending action created, nothing to salvage — trusts a clean re-say the same way it already worked twice earlier.

**Confirmed working, real data:** the exact failing phrase, said again, produced the honest message with no Confirm/Reject shown at all — correct, since nothing was created.

**Real, named limit, on record rather than overstated:** this catches the failure after the fact; it doesn't fix the underlying language-understanding step, which is probabilistic and can mis-parse this sentence shape again in some other form. This is a safety net for one confirmed class of failure, not a guarantee against all of them.

---

## forget_last and the honest "Got it." fix, both confirmed working on real messages

**forget_last:** real register-clearing test — a customer name set the register, "forget that, never mind" followed, response came back as a plain "Okay." Confirmed directly: `/debug/selections` came back empty afterward, proving the register genuinely cleared rather than just appearing to.

**The honest fallback:** "for the flooring," said alone with no real customer or action attached, returned *"I didn't catch anything there I could act on"* — the exact honest message built to replace the old confident "Got it." for a message that genuinely captured nothing. No false success, no silent failure.

Both items closed and confirmed on real device tests, not just deploy success.

---

## The people-table merge gap, closed — confirmed with the same real case that exposed it

**The real, honest starting point:** customer-level merges never touched the underlying `people` table, so a merged duplicate's name kept surfacing as its own separate candidate in `reconcilePerson`'s exact, whole-word, and Soundex queries. Confirmed as the real cause, not just suspected: this is exactly why "bon waterfront" still showed three candidates after the Bon Hotel Waterfront merge earlier tonight, when it should have shown two.

**The real fix, two halves:**
1. `identity.ts` — `merged_into_person_id IS NULL` added to all three of `reconcilePerson`'s real queries, so a merged person is genuinely invisible to future matching, not just renamed elsewhere. The same real gap found one level down and fixed too: `reconcileCustomer`'s two direct customer-table queries and `checkCrossRoleCollision`'s customer-side check now exclude `merged_into_customer_id IS NOT NULL` rows — otherwise an exact re-mention of a merged customer's old name would still resolve straight back to the now-defunct row. `characters` has no merge column yet and was deliberately left untouched — no evidence of that specific bug.
2. `index.ts` — `/debug/init-people-merge` (new column) and `/debug/merge-customers` extended to actually perform the people-level merge: reads each side's real `person_id`, repoints anything else referencing the losing person onto the survivor, and marks the losing person via `merged_into_person_id` — never deleted, same inspectable pattern as the customer-level merge.

**Confirmed working, real data, the exact case that exposed the gap:** re-running the Bon Hotel Waterfront merge (215 → 41) returned `peopleMerged: {fromPersonId: 221, intoPersonId: 29}`. Saying "bon waterfront" again afterward produced a real picker with exactly two candidates — "SCHOONIES SEWE T/A BON WATERFRONT" and "Bon Hotel Empangeni" — with "Bon hotel waterfront" genuinely gone. Full loop closed: the same real sentence that caused the original fragmentation now resolves correctly.

---

## Step 2 of the pending redesign — gesture graded by real stakes, confirmed working

**The real, honest starting point:** a full sweep found 12 distinct pending action types across 20 real `holdForConfirmation` call sites in this codebase — not just the three types touched earlier tonight. Grading a gesture by "stakes" only means something if every type is correctly classified, and only three had ever actually been read.

**The real, deliberate design choice, argued through before writing anything:** starting from an empty "needs a hold" list and defaulting everything else to a tap would silently leave the other 11 types — including every financial document type: payment, invoice, quotation, expense, supplier invoice, purchase order, variance disposition — exactly as easy to mis-tap as today, dressed up as if they'd been reviewed when they hadn't. Built the other way around instead: hold is the floor for everything, and a type only drops to a quick tap once it's individually reviewed and confirmed low-stakes. Tonight, that's exactly one type — `job_scope_amendment`.

**The real build:** `pendingActionType` threaded through every one of `processOneExtraction`'s real return points and `processTranscript`, the same real pattern already proven for `pendingCandidates`. Client-side, `_requiresHold` is the single real gate (`true` for anything except `job_scope_amendment`), and a new `_HoldAction` widget — a quiet underline filling in under the label as it's held, cancels cleanly on early release — replaces the plain tap for everything on the safe-by-default side. Applied uniformly to the plain Confirm/Reject row and to every option in the multi-candidate picker, including "None of these."

**Confirmed working, real device tests:** a `job_scope_amendment` still resolves on a plain, quick tap, unchanged. Everything else — tested directly — does nothing at all on a quick tap; only an actual sustained hold, with the fill visibly completing, fires the real action.

---

## The logo, actually working — found via the discoverability-plus-audit pass, not guessed at

**The real starting point:** FEATURES.md claimed the logo was "ready to appear on generated PDFs." Tested directly rather than trusted — it wasn't. Every real PDF generator queried the business's name, VAT number, and address, but none of them ever selected `logo_r2_key` or called any image-drawing function at all. Stored and served back correctly; never once drawn onto anything.

**A second, deeper gap found in the same pass:** there was no real, discoverable way to upload a logo in the first place. `/business-profile/logo` existed as a working endpoint, but nothing in the app ever called it — the tiny placeholder found on file (plain text reading "Zululand Flooring" in a box, 1502 bytes) was almost certainly a raw test upload from an earlier session, not a real feature.

**Both fixed, then refined through several real, honest rounds against real generated documents:**
- A shared `drawLogoIfPresent` helper, called from all real render points across all four document types (invoice/quotation, statement, aged debtors, profit and loss) — including both pagination continuation pages for the two paginated documents, now living inside their `drawHeader` closures (made async for this) so the logo repeats correctly on every page the same way the rest of the header already does.
- **Position bug, caught on a real document:** the first version's Y math placed the logo's bottom edge below the header content's own start line — it was overlapping "BILL TO" and the customer's real address. Fixed, and moved from top-right (where every one of these documents already puts the *recipient's* details) to top-left, beside the business's own name — a business's own logo can never again collide with a customer's information, by construction.
- **Redundancy, caught by direct feedback:** the logo already carries the business's own name as part of its own design, so drawing the separate "Zululand Flooring and Blinds" text alongside it was genuinely redundant, not just visually busy. The name text is now skipped entirely whenever a logo is present, and falls back exactly as before whenever no logo is on file — never losing a business's name off a document that has none.
- **Sizing, refined through three real rounds against real generated invoices**, including one with the exact intended size circled directly on a screenshot: grew from an initial 120×26 all the way to 300×85, re-anchored near the true top of the page rather than a point sized for the text line it replaced, confirmed safe against the independently-positioned "BILL TO" block before each enlargement.
- **New discoverability, built the same real way as every other room:** "Business Profile" added as a fourth item in the existing drawer, opening a real "Upload Logo" action using the gallery picker (a real logo is almost always already a saved file, not something to photograph live).

**Confirmed working, real device tests, multiple rounds:** the logo now renders correctly — properly sized, properly positioned, no overlap, no redundant text — on a real generated invoice, with the business's actual logo, uploaded through the actual new feature rather than a raw API call. Confirmed directly: "Its good for now."

---

## Snags, Leads, and Projects — the first full discoverability-plus-audit pass, confirmed working

**The real premise, applied for real this time:** each of these three had been a genuinely working backend feature for months — real schemas, real deterministic logic, in Snags' case a real tie to retention release, in Projects' case a real computed total quoted/invoiced — with zero discoverable surface anywhere in the app. Voice-only, or reachable only via a raw `/debug/*` call.

**Built the same real way for all three:** a real, non-debug endpoint (or two, where a real action exists), reusing the exact same functions the voice intents already call rather than duplicating logic, plus a real drawer entry and room following the exact established `_PeopleRoomContent` pattern — ember-born opening, real fetch/loading/error states.
- **Snags:** `GET /snags`, `POST /snags/:id/resolve` (reuses `resolveSnag` directly). Real tap-to-resolve, open items first.
- **Leads:** `GET /leads`, `POST /leads/:id/mark-lost` (reuses `markLeadLost` directly). No "mark won" action built — a lead becomes a real customer automatically through the existing quotation/invoice machinery, not through anything this room does.
- **Projects:** `GET /projects`, deliberately read-only — there is no real "resolve" or "complete" action for a project anywhere in the backend, so none was invented client-side either. Shows each project's real customer, description, linked job scopes, and computed total quoted/invoiced.

**Confirmed working, real device test, all three at once, after one real rebuild:** described directly as "genuinely rich."

---

## Aged Creditors, Stock, and Customers — the second discoverability-plus-audit batch, confirmed working

**The real trigger:** asked directly what else sat in the same sphere after the first batch landed. Audited rather than guessed, the same way every real finding tonight got made — checked each real backend function against whether a real, non-debug endpoint and a real UI surface actually existed for it.

- **Aged Creditors:** `getAgedCreditorsReport` had real, proven data (including a real fix for negative-expense credits) but no PDF generator at all, despite `generateAgedDebtorsPdf` existing for the opposite direction of money since 2026-07-12. Built as a faithful mirror — same visual family, same FIFO convention — and added as a third item in the existing Reports sheet.
- **Stock:** `getTrackedStockItems` had been real, working data since 2026-07-25, entirely voice-only. Deliberately scoped to current levels only — the related discrepancy-resolution piece (`getOpenDiscrepanciesForSupplier`, `recordVarianceDisposition`) is naturally per-supplier and was deliberately left as a real, separate extension of the existing Suppliers room rather than folded in here.
- **Customers — the real, unexpected sixth domain**, found while trying to place Job Profitability (which takes a `customerId` and needs a real detail view to live in): "People" turned out to only ever show characters. Customers had no real list anywhere in the app at all. Built a full new room mirroring People's exact real search pattern, with a real detail dialog that fetches Job Profitability fresh on open — real data since 2026-07-22, previously only reachable as the answer to one specific spoken business question.

**Confirmed working, real device test, all three at once, after one real rebuild:** "All up and running."

**Total real ledger for the whole discoverability-plus-audit pass tonight: six real domains** (Snags, Leads, Projects, Aged Creditors, Stock, Customers) that had real, working backend logic and zero discoverable surface, all now reachable.

---

## The BI foundation — products, reconcileProduct, and the real extraction that feeds it, confirmed working

**The real starting point:** a request for date-ranged reports and analytical queries ("most common product for a customer") led to a real, systematic audit of the data model itself, not just the report functions. `/debug/table-schema` (already real, already existed) confirmed every core transaction table already has a real `created_at` — the date-range gap is purely that report functions never filter on it, a smaller fix than first assumed. A new, temporary `/debug/description-frequency` endpoint then confirmed the real, deeper gap: `line_items.description` held job narratives ("Thabo upstairs," "Jenny's lounge"), not product references — the concept of a product didn't exist in this schema at all.

**Built the same real way as every other identity-bearing entity in this project:**
- `reconcileProduct` in `identity.ts` — exact match, then whole-word, then phonetic, mirroring `reconcilePerson` precisely, deliberately not reusing `looksLikeAName` (a people-specific heuristic that would incorrectly reject an ordinary noun like "vinyl").
- A real `products` table and `line_items.product_id`/`room` columns, added via the same `/debug/init-*` idempotent pattern as everything else.
- `extractLineItems` extended additively — `product` and `room` as new, separate, nullable fields; `description` instruction explicitly left unchanged ("should still read naturally and completely on its own, the same as always") so nothing that already reads it broke.
- `recordInvoice`/`recordQuotation` wired to a new `resolveProductId` helper: matched → real id, new → creates a real product row, ambiguous → deliberately left unlinked rather than guessed, since there's no real evidence yet of product-name collisions the way there was for people's names. `convertQuoteToInvoice`'s synthetic "balance due" line correctly left untouched — no real product is being purchased there.

**A real bug found and fixed during smoke testing, not glossed over:** the `room` column addition never actually made it into the live migration handler — an earlier push overwrote that specific edit without carrying it forward, confirmed directly by diffing against the real deployed file, not assumed. Action #129 (and a duplicate #130 created by a retry during the failure) were left genuinely stuck in `pending_actions` as a result — real data recovered via a temporary direct-call diagnostic endpoint (`/debug/retry-quotation`) rather than lost.

**Confirmed working, three real smoke tests, in order:**
1. An ordinary quotation with no product or room mentioned ("General repairs") — both fields correctly stayed null, nothing regressed.
2. A quotation with a real product and room ("vinyl," "main bedroom") — both fields populated correctly, a new real product row created.
3. The same product said differently ("vinyl flooring") on a separate quotation — resolved to the exact same `product_id`, not a second, fragmented one — proof the whole-word matching genuinely works, not exact-string luck.

---

## The products foundation, complete on both sides — real proof through the actual document-upload path

**Extended past the sell side:** `po_line_items.product_id` and `supplier_invoice_line_items.product_id` added, mirroring the customer-facing work exactly. `recordPurchaseOrder` resolves a real product via the same `resolveProductId` helper the sell side already uses. `recordSupplierInvoice` deliberately doesn't re-resolve — it inherits `product_id` directly from the matched PO line, since a supplier invoice is always reconciled against a PO line that already has this once it's been ordered.

**Tested through the real, physical pathway a supplier invoice actually arrives by, not just a spoken sentence:** a realistic Floornet invoice PDF generated to match a real placed PO exactly (50 sqm vinyl, no variance, isolating the one real question — does `product_id` inherit correctly). Uploaded through the app's real document path.

**A real, honest finding along the way, not a bug:** the first upload attempt, with no caption, correctly did nothing beyond storing the file — confirmed directly against the code, this is a deliberate design principle ("never guess a subject from the file itself, only ever from something actually said about it"), not a missed case. The supplier's name being printed on the letterhead was never going to be enough on its own. Re-uploaded with a caption naming the supplier, which correctly triggered the real chain: find Floornet's open PO, extract the invoice against its real line items, hold for confirmation.

**Confirmed working, real device test, the complete real chain:** the new supplier invoice line item shows `product_id: 1`, `product_name: "vinyl"` — the exact same product as the original purchase order and every customer-facing quotation earlier tonight. One real product, one real identity, reachable from voice, text, and a genuine uploaded document, on both the buy side and the sell side. The products foundation is complete.

---

## A real, live splitIntoTopics bug — fragmentation, wrong pricing, and why the first fix wasn't enough

**The real starting point:** a real, live dictation for Dr Van der Walt —
four room measurements (3x3 store, 1.2x1.2 kitchen, 7x5 main, 3.5x2.5)
followed by the customer's name and a per-square-meter price — produced
three separate job scopes, one component each, and no quotation at all.
Traced directly, not guessed: `extractMultipleIntents` calls
`splitIntoTopics` first, then runs extraction separately on each
resulting piece — and `splitIntoTopics` had wrongly treated each bare
room measurement as its own topic, since nothing grammatically tied them
together the way the existing July fix's "and"-joined example did.
`extractWorkObservation`'s own `components` field was already correctly
designed as an array, built to hold every measured part of one job — it
never got the chance, because the input was fragmented before it ever
ran.

**First fix, a prompt addition — insufficient, confirmed by a real,
live retest, not assumed adequate:** a new rule and a new example added
to `splitIntoTopics`'s prompt, teaching it that a bare sequence of
room-plus-dimension statements is still building up ONE observation, the
same as if "and" had joined them. Typechecked, deployed, verified through
CI — and then redictating the same real message still produced five
fragmented job scopes sharing one `capture_id`, not one. The earlier
"and" bug had a concrete, syntactic trigger to key off; this pattern has
none, and the model didn't reliably make the same nuanced judgment call
a second time even with explicit new instructions.

**The real, working fix — deterministic, not another prompt attempt:**
`mergeBareMeasurementFragments` in `ai.ts`, run on `splitIntoTopics`'s
output before extraction. A short fragment (six words or fewer)
containing a real dimension pattern and nothing else is never mistaken
for a complete, standalone topic, and gets merged with whatever segment
follows it — almost always the one supplying the missing customer and
price. Deliberately conservative in one direction only: the real risk
accepted is over-merging two genuinely separate, back-to-back bare
room-quote jobs, rarer and far less costly than the silent fragmentation
this replaces. Verified with a real, standalone test extracted directly
from the source — the exact live failure, the existing "and"-joined
case, unrelated real topics, and a complete separate quote that happens
to contain a dimension, all behaving correctly, 5/5.

**Confirmed live, the real way, after a real false start:** the first
retest showed the identical old data — same ids, same timestamps down to
the second — because no new dictation had actually happened; caught by
checking the real timestamps rather than trusting the report of a
retest. Once genuinely redictated fresh: one job scope, four real
components with correct areas (9, 1.44, 35, 8.75 sqm), and Quotation #29
— R750/m² correctly applied per room, R40,642.50 subtotal, R46,738.875
total. The quotation math was never a second, separate bug — it was a
downstream symptom of the same fragmentation; once the real, complete
set of components reached the pricing step together, the math was
correct on its own.

---

## A real, live UX gap: the app silently discarded the server's own confirm guidance

**The real starting point:** right after the confirm/reject race-condition
fix deployed, a real, live request — "generate an invoice for Thanda
Royal Game Reserve for sisal carpet installation, R98000 excluding VAT"
— correctly triggered an `identity_collision` check ("Thanda Royal sounds
like an existing customer, confirm?"). After confirming, no invoice
appeared, and it reasonably looked like something had just broken.

**Traced directly rather than assumed related to the race fix just
pushed:** `identity_collision`'s confirm handler does exactly what it's
supposed to — creates the real customer record, then replays the
original request through `processOneExtraction`. Since invoice creation
is itself a consequential write requiring its own confirmation, this
replay correctly created a *second*, separate pending action — an
"invoice" one — rather than an immediate, final invoice. Confirmed live,
through the app's own real "Pending" ember (`/embers/pending`, the same
member-open route every real member can already reach): the invoice
action was there, waiting, and confirming it produced the real invoice
correctly.

**The real gap wasn't the backend — it was the client silently
discarding what the backend already said.** `processOneExtraction`'s own
return shape already includes a real, clear `message` field —
`"Invoice noted for Thanda Royal of R98000 — needs your confirmation
(action #X) before it's recorded."` — confirmed directly in the real
source. `main.dart`'s confirm handler only ever read `pdfUrl` from a
successful confirm response; `message` was never read or shown at all,
regardless of whether the tapped pending item was found locally or not.
Every confirm that triggers a replay and creates a new, follow-up
pending action — not just this one — left the person with zero
indication anything further was needed.

**Fixed on the client:** `message` is now read and shown whenever
present, in addition to the existing local status update, so real,
substantive server guidance (a new pending action, a job scope also
recorded, an installer conflict) actually reaches the person doing the
confirming. The generic "Confirmed."/"Rejected." fallback is skipped
when a real message is available, since the real message already
implies success on its own.

---

## Date-ranging in the report functions, built and confirmed live — the first real prerequisite for conversational BI

**The real starting point:** `CONVERSATIONAL_BI_ARCHITECTURE.md` named date-ranging as the missing foundation under its flagship example, "compare April to March": every report function was all-time only, with no date filter anywhere in the codebase. Picked as the smallest, most contained item on the remaining-work list.

**What was built:** an optional `DateRange` (`from`/`to`, inclusive, `YYYY-MM-DD`) on `getProfitAndLoss`, `getProfitAndLossSummary`, `getFinancialSnapshot`, `getExpenseSummary` and `getQuotationsSummary`, plus `parseDateRange` for validation and a read-only `GET /debug/profit-and-loss?from=&to=` route for live checking. With no range, every function behaves exactly as before, so no existing caller changed.

**Two real decisions, named rather than buried:**
(1) *Timezone.* `created_at` is stored in UTC (`datetime('now')`), but a business month is a South African local month. South Africa is a fixed UTC+2 with no daylight saving, so each local calendar day is converted to an exact half-open UTC window. A record made at 23:30 local on 31 March counts as March, not April.
(2) *Which date.* Ranges apply to `created_at`, the date a record was entered, because it is the only date every one of these tables genuinely has. Ranged output says so in a note. A later CSV import of historical invoices would land in the month it was imported, not the month the invoice was originally issued. Real business dates (invoice date, payment date) would be their own, separate piece of work.

Malformed, impossible (`2026-02-30`) or reversed dates throw a readable error rather than silently falling back to all-time, since a plausible-looking wrong report is worse than a visible failure. Dates are validated and bound as parameters, never interpolated into SQL.

**Verified, the real way:** typecheck clean against the baseline (44 known, 0 new), role matrix 165/165, and 10 checks against a real SQLite database, including the exact midnight boundaries in both directions, a Feb + Mar + Apr partition that sums to the all-time total, single-day and open-ended ranges, an empty period returning zeros rather than an error, and deep-equality of every function's no-range output against the original code. Diffed against a fresh fetch before each push; CI green on both pushes (Typecheck, Role-matrix, Deploy).

**Confirmed live:** all-time figures matched the previous output; a full-2026 range matched all-time (all current data is from 2026); October 2026 returned R98,000 revenue against R10.8M all-time, which is the Thanda Royal invoice from the confirm-guidance fix, so a fresh, distinguishable result rather than a stale one; a malformed date returned a 400.

**Noticed along the way, not touched:** the all-time P&L shows `materials` at R-500, a negative expense, which pulls Cost of Sales below zero. Likely a credit or refund entered as an expense, but not traced yet. Worth a look before the BI layer reports on it. Also not done: the P&L PDF does not take a range yet, and the aged debtors/creditors reports are "as at today" by nature, so ranging does not apply to them.

**What this unblocks:** the BI document's second prerequisite, grouping by product rather than the unpopulated category column.


---

## processOneExtraction validation steps — done; the real shape is different from the plan in four ways

**The real starting point:** `PROCESS_ONE_EXTRACTION_REWRITE.md` named four validation steps to complete before any code moves. All four are done, against the real code, and recorded in full at the end of that document. No production code was changed.

**What the evidence changed.** (1) `ProcessingResult` cannot be a single outcome: one call can hold a quotation or invoice *and* record a job scope; the function also returns early from 10 places, and `payment` has no Pass 2 branch of its own (it relies on a catch-all). (2) The six-group split does not cohere: `invoice`, `price_scope` and `work_observation` each carry their own, differently-behaving copy of the same observation-recording block, and three real intents (stock) plus the 236-line `lookup` have no home. (3) `INTENT_CAPABILITIES` as proposed is insufficient: the creation gate is a default-open denylist where REST is default-deny, `purchase_order` is a direct write whose creation gate is its only gate (the earlier "already gated on confirm" note was wrong for it), and intent is not action type. (4) The creation gate has no test coverage; the 165-case matrix compiles only `auth.ts`.

**Verification:** the analysis is mechanical (TypeScript compiler AST over the real `index.ts`; capability tables loaded from the compiled real `auth.ts`), with items traced only by reading marked as such. One possible bug, an invoice hold orphaned by the amendment early-return, is recorded as unreproduced.

**Four decisions left to Pierre** are listed at the end of the rewrite document; the safe first step regardless of those answers is Phase 0: `INTENT_RULES` in `auth.ts`, behaviour-identical, with the existing test harness extended to cover it.


---

## A real, live duplicate-customer bug, and the silent drop it exposed next to it

**The real starting point:** a live dictation, "invoice Alfons R5000 for repairs", produced a second customer alongside the existing "Alfons", differing only in capitalisation. The first question was why the "is this the same person?" check never fired.

**Traced directly, then reproduced on a real SQLite database rather than assumed:** `wholeWordClause` (identity.ts), the shared single-word name matcher, is `column = ? OR column LIKE ? OR ...`. SQLite's `LIKE` ignores ASCII case, but plain `=` does not, and a one-word name can only ever match through the `=` branch (the other three patterns all need a space). So `alfons` against a stored `Alfons` found nothing. Multi-word names such as "Jenny Smith" were never affected, since they match through `LIKE`. The reason the ask-first check stayed silent is that two checks in the same flow disagreed: the preamble's own existence check uses `COLLATE NOCASE`, found "Alfons", and so skipped the ambiguity question, while `reconcileCustomer` then used the case-sensitive matcher, found nothing, and inserted a new row. The speech recogniser capitalises the same spoken name inconsistently, so this was reachable by ordinary use.

**Fixed:** `COLLATE NOCASE` on the `=` branch, one line. The same helper serves customers, characters, people and products, so all four are fixed together. Verified against a real database: the reported case now matches; results for exact-case names are identical to before for every first and last token tested; the earlier Andre/Juandre and partial-word fixes still hold. Typecheck clean against the baseline, role matrix 165/165, CI green.

**Confirmed live:** an existing customer "Sheriff", dictated as lower-case "sheriff", matched the existing customer and produced a confirmation rather than a new row.

**Not done, deliberately:** the one existing "Alfons"/"alfons" duplicate is not merged by this fix. A merge route already exists (`/debug/merge-customers`, repoints records and marks the losing row, never deletes); a spoken "merge X into Y" intent was judged not worth building yet, since the cause is fixed and other name variants already trigger the ask-first question.

**The second finding, found while chasing a suspected regression:** "invoice site service R5000 for repairs", typed in lower case against an existing "Site Services", returned "I didn't catch anything there I could act on." A suspected regression from the day's deploys was ruled out directly: `/debug/intent-test` (extraction only, no identity code) showed `customer_name: null` for that text, and the correctly capitalised "Site Services" extracted fine, with intent `invoice` and amount 5000 read correctly both times. So the AI missed the name; nothing we deployed was involved. The real gap was downstream: `invoice`, `quotation` and `payment` all require a resolved customer, and with none, no Pass 2 branch matched, so a correctly understood R5000 invoice fell through to the generic nothing-happened message. The supplier intents already avoid this with their own "no supplier was named" branches; these three did not.

**Fixed:** a new branch, placed before the generic catch-all, says what was heard and what is missing ("I heard an invoice for R5000, but no customer name came through — who is it for?"). Checked mechanically that it reads only `customer` and `pendingActionId` and sits ahead of the catch-all. One behaviour change to note: a payment with only a supplier name resolved used to say "Found existing: X" and quietly do nothing; it now asks for a customer. Typecheck clean, role matrix 165/165, CI green. **Live check of the new message itself is still pending**, so it is not claimed as confirmed.

**Still open:** the AI can still miss lower-case names. A deterministic fallback matching the typed words against existing customers, held for confirmation in the same ask-first style, was proposed but not built.


---

## The confirm-guidance client fix, confirmed live on the rebuilt app

**Confirmed, the real way, after the Codemagic rebuild:** with the rebuilt app installed, "invoice stylish R500" (a name already on file as a character) correctly raised the identity-collision question (action #141). Tapping Confirm then showed the server's own follow-up message on screen, "Invoice noted for stylish of R500 — needs your confirmation (action #142) before it's recorded.", and the replayed invoice appeared as its own new pending action, exactly the case that used to look like a silent failure. This closes the fix recorded under "the app silently discarded the server's own confirm guidance"; it was previously deployed but not verified on a device.

**Two small things observed, neither a defect in the fix:** the customer row created by the confirm carries the spoken casing ("stylish", lower case) rather than the character's "Stylish", since the replay uses the name as extracted; this is cosmetic and the case-insensitive matcher now treats the two as the same name. And the test left a real customer row and a pending test invoice (#142) that need rejecting or merging by hand.


---

## Phase 0 of the processOneExtraction work: one exhaustive permission table, and three decisions applied

**The real starting point:** the validation results in `PROCESS_ONE_EXTRACTION_REWRITE.md` found that creation-time permissions were a hand-kept list in `index.ts` that was open by default, with no test coverage (the 165-case role matrix compiled `auth.ts` only), and that it ran *after* the name-resolution preamble, which can write. Pierre answered the four open decisions: installers may dictate goods received; gate creation for money and stock only; move the check ahead of customer creation; the scheduling-labelled-as-invoice question was set aside as unproven.

**Phase 0a — behaviour identical, deployed and verified.** `INTENT_RULES` in `auth.ts`, typed `Record<intent, ...>` so an intent added to the union in `types.ts` without a row is a compile error, and asserted again by the test. Every intent lists what held actions it can produce and who may create it, with "open" always a written-down choice. `index.ts` now asks `intentCreationRefusal()` instead of two hand-kept checks, and the old `FINANCIAL_WRITE_INTENTS` list is gone (the test fails if it comes back). Verified by comparing the new table against the old logic for every intent, for owner, accountant, installer and an unknown role, plus null, empty and hostile values such as `constructor` and `__proto__`.

**Phase 0c — decisions 1 and 2, as separate, named differences.** `goods_received` creation now accepts `can_manage_invoices` or `can_know_materials`, matching confirmation, so the "known mismatch" reason on that row was deleted rather than kept. The three stock intents are gated with `can_know_materials` (the capability the REST layer already uses for `/stock`); owner, accountant and installer all hold it, so this changes nothing in practice and makes the rule explicit. Every intended difference from the old logic is listed by name in the test (`DECIDED_DIFFERENCES`); anything not listed must still match the old behaviour exactly.

**Phase 0b — decision 3, as its own commit.** The check now runs before any name is looked up or created. Previously a refused role could still leave a real customer row behind, because `reconcileCustomer` inserts one for an unknown name and the identity checks can raise held actions before the old gate ran. The refusal now carries `customer: null, character: null`. The test asserts the gate sits before `reconcileCustomer`, `reconcileCharacter`, `holdForConfirmation`, `setSelection` and `updateCaptureHint` inside the function, by source order.

**Verification:** the role-matrix suite grew from 165 to 386 checks. Seven deliberate breakages of the rules (a removed row, `purchase_order` made open, a deleted reason, an orphan row, a typo in a produced action type, the old list reintroduced, a wrong capability on `lose_lead`) and the old gate ordering were each confirmed to make it fail. Typecheck unchanged at the 44 tolerated baseline, CI green on every push.

**Not verified live, stated plainly:** only the owner role can be exercised from the app. The refusal paths and the installer goods-received change are proven by tests against the real tables, not by a live installer session.

**Still open:** the upload path (`POST /files/document`) does not use this table. By decision 2 it should: an uploaded priced supplier invoice creates a held `supplier_invoice` for any member (money), while an uploaded delivery note records a goods-received note directly (stock, which installers are now allowed). Gating the former is a behaviour change on that path and has not been done.


---

## The upload path now uses the same permission table

**The real starting point:** Phase 0 left one gap on purpose: `POST /files/document` and `POST /files/photo` did not use `INTENT_RULES`. Traced by reading, they let any member trigger three things: a held supplier invoice (money), a goods-received note recorded directly with no confirmation (stock), and a supplier statement comparison. The last was not on the earlier list: it returns both the supplier's claimed balance and the real amount owed in its response, and installers cannot see supplier balances anywhere else (`/embers/suppliers` needs `can_manage_invoices`), so it was a money read open to everyone.

**What was built:** both handlers read the caller's capabilities and ask the same table, keyed by what the upload would do (`supplier_invoice`, `goods_received`, `supplier_statement`), because they decide by the supplier an upload resolves to and not by a spoken intent. Under Pierre's decisions: installers may upload a delivery note (recorded as a goods-received note) but not a priced supplier invoice or a statement; owner and accountant are unchanged. The file and capture are always stored. A refused upload now carries `refusal` in its response. `supplier_statement` became a gated money row, which also means a *spoken* statement from an installer is refused (it recorded nothing before).

**Verified:** the role-matrix suite is now 412 checks: the three outputs for each role against the real table, source-pattern guards that both handlers keep every refusal branch ahead of its write, and `supplier_statement` listed by name as a decided difference. Each guard was removed in turn, in each handler, and the suite failed every time (the first photo-handler checks accidentally hit the document handler, so they were redone against the photo handler specifically). Typecheck unchanged at the 44 tolerated baseline; CI green on both deploys.

**Not verified live, and one known gap:** only the owner can be exercised from the app, so the refusals are proven by tests against the real tables, not a live installer session. And the app ignores `refusal`: `main.dart` falls through to "Stored — nothing real to reconcile it against yet." for a refused upload. That is misleading but claims nothing false. Showing the real reason is a two-line change in `main.dart` that needs a Codemagic rebuild; not made.

**Deliberately not changed:** the upload handlers still call `reconcileCustomer` and `reconcileCharacter` before anything is gated, which can create a customer or character row from a caption. Customers and characters are neither money nor stock, so by the decision that was left alone.


---

## Uploads now identify the supplier and document type from the document itself

**The real starting point:** an owner upload of a Floornet delivery note returned "Stored — nothing real to reconcile it against yet". Traced directly: the whole supplier-document pipeline (supplier invoice, goods received, statement) decides who a document is from solely by a typed caption, and `main.dart` never sends a caption (zero occurrences in the file; the server reads one on both upload routes). So every upload from the app was captionless and could never reconcile. A typed follow-up ("the uploaded delivery note is from Floornet, it was purely for stock") did not help either: nothing links a later message to an earlier upload, and it was processed as a standalone spoken claim with no items, so it held a goods-received confirmation (#143) built from a sentence with nothing in it to match.

**The principle amended, deliberately:** the recorded rule was "never guess a subject from the file itself, only ever from something actually said about it". It is right for site photos and wrong for printed business documents that name their own issuer. Pierre challenged it directly (the document already says DELIVERY NOTE and who sent it). New rule: a document's printed issuer and type may be READ, never trusted: the issuer is matched only against suppliers that already exist, nothing is ever created from a document, anything not clearly a supplier document does nothing exactly as before, a stated subject (a caption that resolved one) always wins, and because the supplier was inferred and not stated, a delivery note is HELD for one-tap confirmation instead of being recorded directly.

**What was built:** `extractDocumentIdentity` (ai.ts) reads the printed document type (delivery note, supplier invoice, supplier statement, or other) and the issuing business, never the recipient. The matching decision is plain code (identity.ts `matchIssuerToSuppliers`): case, punctuation and legal suffixes ignored; exact beats partial; two candidates at the same level are reported as ambiguous, never picked. `documents.ts` is the read-only glue; a supplier is a character a purchase order names, or one filed as a supplier, excluding merged duplicates. Both upload handlers use it only when nothing was stated, and now say in plain words what happened: held for confirmation, no open order for that supplier, none of the items matched the open order, issuer unreadable, issuer not a known supplier, or ambiguous. The response carries `message` and the held action id. Two read-only admin-key routes were added because `/debug/captures` needs a signed-in session and cannot be reached from a terminal: `/debug/recent-captures` and `/debug/pending-action?id=`.

**Verified:** the role-matrix suite is now 455 checks. The matcher is tested exhaustively (suffixes, case, accents, ties, exact-beats-partial, no substring matching), the whole inference helper against a fake model and database (code-fenced replies, wrong shapes, unknown types, a failing model, over-long issuers, an issuer for an "other" document), the extractor directly, and source guards that both handlers run document-first only when nothing was stated, hold an inferred delivery before the direct-record path is reachable, and carry the message. Eleven deliberate breakages were each caught (one initially survived because a second layer masked it, and was closed with a direct test). The supplier SQL was also run against a real SQLite database: suppliers found by tag and by purchase order, installers and merged duplicates excluded, an issuer equal to an installer's name or to our own business matching nothing. CI green on every deploy. `main.dart` was changed to show the server's message, and the web build, which compiles it, succeeded: the first real Dart compile this app's edits have had.

**Not verified, stated plainly:** no live run on a real delivery note yet; how well the vision model reads a given photo is untested, and the earlier captionless upload's stored text can now be inspected with the new route. A scanned PDF with no text layer still yields nothing to read. The phone app needs a Codemagic rebuild before it shows the new messages and the confirmation buttons for an inferred delivery.

**Deliberately not done:** a late caption for an earlier upload, and any guessing from recency. If the issuer cannot be read, the document is stored with an honest message and nothing is recorded.


---

## Document-first uploads, confirmed live on a real delivery note

**Confirmed, the real way, on the rebuilt app:** a photo of a real Floornet delivery note uploaded with no caption (capture 483) was identified from the document alone and produced "Delivery noted from Floornet (read from the document) — needs your confirmation (action #144) before it's recorded.", with Confirm and Reject shown. The new inspection route showed exactly what the vision model read: the Floornet letterhead as the issuer, "Zululand Flooring & Blinds" (our own business) as the delivery address, the delivery order number, the item line and "2.00 Box". The issuer was picked correctly over the recipient. The earlier captionless upload of the same note (capture 481) had read it equally well; it was never lacking text, only a way to use it.

**Also confirmed:** the app rebuild is the one running (the server message and the confirmation buttons both appear), and the supplier was matched from the document without a caption (the capture's own subject hint is deliberately left empty for an inferred match; the provenance is recorded on the held action instead).

**Not yet verified:** the contents of the held action (which purchase-order lines it matched, and the quantity and unit it would record: the note says "2.00 Box" of a 5 m2 item, and the order may be in square metres) and the result of confirming it.


---

## A delivery that matched nothing on the order was held, confirmed and recorded as "unmatched item"

**The real starting point:** the first live delivery through document-first uploads (action #144) was confirmed, and `/debug/pending-action?id=144` showed its recorded line: `"matched_description": null, "quantity_received": 2`. The note (2 boxes of a marble charcoal product) matched nothing on Floornet's open order, and the model said so correctly by returning `null`. Nothing in the code treated that as "no match".

**Traced, in the code:** every goods-received path only checked that SOME line existed (`line_items.length > 0`), and a null-matched line is a line. So it was held, and on confirmation `recordGoodsReceived` inserted a goods-received note with one line whose description is the literal text "unmatched item" (the real item name is not kept), quantity 2, no order line, no variance. No stock was changed: the stock increment matches on the item's name and an empty name matches nothing. So the damage in this one case is a single near-empty entry. But the safeguard added the day before ("couldn't match any of its items to their open order, so nothing was recorded") could never fire for this case, which is exactly the case it was written for. It was found only by inspecting the real held action, not by any test, because the tests used a model reply with a matched line. The same weakness already existed in the caption-stated upload path and in the dictation path (it is how #143, held from a sentence with nothing in it, came to exist).

**Fixed, in all three paths (document upload, photo upload, dictation):** a pure function, `splitGoodsReceivedLines`, decides which lines are real matches: the model's name must be non-null AND actually on the order (case-insensitive, as recording does it). Only matched lines are held or recorded. If none match, nothing is held, and the reply says what the order does contain ("none of its items match their open order (on order: …)"). In a mixed delivery the matched lines go through and the reply says how many were left out. This also means a caption-stated delivery no longer records "unmatched item" rows; that is a deliberate change to the older behaviour, because the row discarded what the item was.

**Verified:** typecheck unchanged against the baseline; the suite is 466 checks. The splitter is tested directly (null, mixed, a name the model made up that isn't on the order, case, empty order, empty name), and a source guard fails if any goods-received path hands unfiltered lines to a hold or a record again (every use of the extractor's lines must be an argument to the splitter: three uses, three filtered). Each path was broken in turn and the suite failed every time. CI green on both deploys.

**A flaw in my own checking, recorded because it matters:** the first batch of these mutation checks reported zero failures for every case. That was not success. The mutated copy had no `node_modules`, so the test crashed on bundling `finance.ts` before it could fail anything. It was caught only because "nothing failed" for a mutation that must fail is itself a signal. The harness now also confirms each run actually completed.

**Left as it is, deliberately:** the one entry #144 created ("unmatched item", 2) stays; it affects no stock or variance, and there is no delete route. And a real design question this surfaced, not decided here: the delivery note was for stock that was never ordered, but goods received requires an open order to match against, so such a delivery can only be refused with an explanation. Whether to support an "unordered delivery" (recording the item's real name from the document) is a product decision for Pierre.


---

## Document-first goods received, confirmed live on a delivery that matches an order

**Confirmed, the real way:** after placing an order for 2 boxes of marble carpet tiles with Floornet, uploading the real delivery note (photo, no caption) produced a held goods-received action (#145) that was confirmed. `/debug/pending-action?id=145` shows the held payload: purchase order 9, supplier Floornet, one line, `matched_description: "Marble charcoal carpet tile"`, `quantity_received: 2`. Three separate things worked together:

- **Issuer to supplier:** the model read the issuer as "The Flooring Network T/A Floornet" and plain code matched it to the supplier "Floornet" (a partial match: the supplier's name is wholly contained in the printed one). The recipient, "Zululand Flooring & Blinds", was correctly not taken for the issuer.
- **Item to order line, by meaning:** the printed item "[TBT/MAR/011] MARBLE CHARCOAL 011 5m2" was matched to the order line "Marble charcoal carpet tile" although no wording is the same, and the quantity read was the printed 2.00 Box, equal to the 2 ordered.
- **Provenance:** the held action's source text begins with a line stating the document was read, not stated, and by whom it was matched; so the origin of the match is on the record.

**This is the first complete pass of the chain without a caption, without a typed note, and without any fault to work around:** photo in, supplier and document type read from the document, items matched to the order, one confirmation, recorded.

**Still unverified:** the unit question for tiles sold by the box (the order is a count of boxes here, so 2 equals 2; an order in square metres delivered in boxes would need a conversion that nothing does yet), and the open product decision recorded in the previous entry about deliveries of items that were never ordered.


---

## Deliveries of items that were never ordered are received and reported as exceptions

**The decision (Pierre, 2026-10-03):** delivery notes for items that were not ordered can be received, and are treated as an exception report. Until now a delivery that matched nothing on the order was refused with an explanation (and before that, recorded as a nameless "unmatched item"). The goods did arrive; refusing to know about them was the wrong answer.

**The design, and why it reuses what exists:** an unordered item is stored as a goods-received line carrying the **name the delivery gave it**, with no order line and an **ordered quantity of 0**, so its variance equals what arrived. That one choice means it is automatically an ordinary open discrepancy: it appears in the existing per-supplier discrepancy list and can be resolved by the existing resolve route and the existing spoken variance-disposition flow, with no second system. The extractor (`extractGoodsReceived`) now also returns each line's item name and unit as written on the delivery, sanitised; `classifyGoodsReceivedLines` (finance.ts, pure) sorts lines into matched, exceptions (named and a real positive quantity) and dropped (no name or no sensible quantity: never recorded, since a line with no identity is noise). `planDelivery` and `deliveryHeldMessage` (documents.ts, pure) decide what is done and what is said, so every branch is tested without a database or model, and the three entry points only carry the plan out: document upload, photo upload, and a spoken delivery. A delivery whose supplier was read from the document, and every spoken delivery, is held for one-tap confirmation; a typed-caption upload is recorded directly. A delivery with **no open order at all** is also received, but only if the document is a delivery note (an invoice or statement still needs an order to check against). The confirm response now says in words when items were logged as exceptions. An unordered item that is also a registered stock item (matched by exact name, the existing rule) still adds to stock, since it physically arrived.

**The report:** `GET /delivery-exceptions` (`can_manage_invoices`, so owner and accountant, not installers; `?status=all` includes resolved ones) lists every unordered item across suppliers, newest first, with supplier, name, quantity, whether there was an open order, who recorded it and when. `GET /debug/delivery-exceptions` is the same with the admin key, readable from a terminal.

**One storage compromise, stated plainly:** `goods_received_notes.purchase_order_id` is `NOT NULL`, so a delivery against no order at all is stored with order id **0**. Rebuilding a live table to allow null was judged riskier than a documented sentinel; nothing joins on it in a way that 0 breaks, and the report reads it as "no open order".

**Verified:** typecheck unchanged against the baseline; the suite is 507 checks, now including `recordGoodsReceived` against a fake database, because the first version of this change **crashed on exactly its main input** and typecheck could not see it: an exception line has an ordered quantity of 0 (not null) but no order line to read a name from, and a non-null assertion hid that. It was found by running the real SQL against a real SQLite database (not available in CI, which runs Node 20), which also confirmed: mixed deliveries, exception-only deliveries, a delivery with no order, older held actions with nameless lines still recording the old way, the report excluding both matched lines and the old "unmatched item" row, exceptions appearing in the existing discrepancy list and leaving it once resolved, and stock behaviour. Sixteen deliberate breakages (including re-introducing that crash) were caught; one survived at first, a no-order branch open to any document, and was closed with a stricter guard checked against both upload handlers. A transitional commit kept the old helper for one deploy so the build was green at every step. CI green on all nine pushes.

**Not verified, and honest limits:** no live exception delivery has been run yet. The app has no screen for the report; it can be read with the admin key, or per supplier through the existing discrepancies route and the spoken flow. A late-found limit of the existing design that this inherits: "open order" means the supplier's **most recent** order, whether or not it has been fully delivered, so a second delivery against an already-completed order is matched against it again.


---

## Order status by quantity, receiving against all outstanding orders, and one exception report for every kind of difference

**The decision (Pierre, 2026-10-03):** ordered-versus-delivered discrepancies belong on the same exception report as deliveries with no order, and the right way to know which order a delivery belongs to is order status. Two further answers: a short delivery is flagged immediately and **stays until it is resolved**, and a delivery goes against the **best match across all of the supplier's outstanding orders**, not just the latest.

**What actually existed, checked in the code and this log rather than from memory:** a *document-completeness* status ("ordered, awaiting delivery", "delivery note received, awaiting invoice", "closed" once a supplier invoice exists), computed on read, verified live in July, and shown **only** in two debug views; nothing used it. The harder question the original design pinned ("Partial GRNs against one PO: how does received status actually resolve?") and the back-order path were designed but never built. Two defects followed from that, both confirmed in the code: a delivery was always matched against the supplier's single most recent order whether or not it was already delivered, and every delivery was compared with the **full** ordered quantity, so 20 ordered with 15 and then 5 arriving flagged a shortage of 5 and then a second, false one of 15.

**What was built:**
- **Outstanding per order line** = ordered minus everything received against it (the same sum supplier-invoice reconciliation already used, "a real delivery can arrive in more than one shipment") minus any shortfall the supplier **credited**. A back order, or a reason recorded with no resolution, does not close the remainder; only an explicit credit does (the original design: back order stays owed, credit writes it off). This hole was found after the first version shipped: without it a credited remainder would sit on the order forever and absorb a later delivery of the same item.
- **Matching** (`getOutstandingOrderLines`, `candidateOrderLines`, `allocateDelivery`, pure and tested): the extractor is shown every outstanding item across the supplier's orders; a delivery fills the **oldest** order first and spills to the next; variance is measured against what was **outstanding**, so only the last line touched can be short and a delivery beyond everything outstanding is over by the difference. A completed order stops attracting deliveries, so a further delivery of the same item is an unordered exception.
- **Recording** (`recordDelivery`): one goods-received note per order touched; the allocation is worked out **when the delivery is recorded**, not when it was held, because another delivery may have been confirmed in between (a held line whose order was completed meanwhile becomes an exception instead of vanishing). Holds made since this change carry `allocate: true`; older held actions still confirm the old way. All three entry points (document, photo, spoken) and the confirm step use it.
- **One report, three kinds** (`getDeliveryExceptions`, `GET /delivery-exceptions`, `GET /debug/delivery-exceptions`): `unordered`, `short`, `over`, each with what the line expected, what arrived, whether there was an open order, and open or resolved. Shortages and overages were already open discrepancies in the existing machinery; the report now shows them too. Resolving still uses the existing resolve route and spoken flow.
- **Order status by quantity**, computed on read (`orderDeliveryStatus`): awaiting delivery, partially delivered, fully delivered, counting credited shortfalls. Both purchase-order debug views now show it beside the document status, plus received and outstanding per line.

**Verified:** typecheck unchanged against the baseline; the suite is 551 checks, which include allocation across one and several orders, the "15 then 5" case, over-delivery, zero-quantity shortages, the floating-point trap (0.1 + 0.2 against 0.3), `recordDelivery` against a fake database, the report's three kinds, the order statuses, and source guards that every hold carries `allocate: true`. All of it was also run against a real SQLite database, including credit versus back order versus a bare reason, a line resolved twice not being written off twice, and received-per-line still summing correctly for invoice reconciliation. Twenty-three deliberate breakages were caught; two weak guards of mine survived at first (the debug view computing but not returning the status, and a floating-point test that could not fail) and were strengthened. Along the way my own edit deleted a block of `finance.ts` through a wrong end marker; typecheck caught it before anything was pushed. CI green on all fourteen pushes.

**What this does to existing data, stated plainly:** older orders that were delivered short (for example the underlay at 50 of 100, the skirting at 8 of 10 and the grout at 15 of 20) now show as open shortages on the report and still count as **outstanding**, so a later delivery of those items will be matched to those old orders, oldest first. That is the model working as designed; resolve them with a credit to close them. The old "unmatched item" row stays out of the report (it has no ordered quantity and no variance).

**Not verified live; known limits:** no live multi-order or partial delivery has been run yet. The app has no screen for the report. Supplier-invoice detection still looks at the supplier's **latest** order only, and an invoice is still reconciled against a single order. There is no explicit "close this order" action: an order completes by being delivered or credited. Resolving a shortage with a plain acceptance, or a reason alone, records it but leaves the quantity outstanding.


---

## The delivery exception report can be asked for in words

**Why:** the report existed only as a route and the app has no screen for it, so on a phone it was unreachable. Rather than wait for a screen (which needs an app change and a rebuild), it is answerable as a business question by voice or text.

**How it works:** a deterministic wording check (`asksAboutDeliveryExceptions`, the same accepted pattern as the "aged breakdown" check in the business lookup) catches questions such as "any delivery exceptions", "what discrepancies do we have", "any short deliveries" or "anything unordered come in"; it deliberately does not catch "except for Friday", "there is a material shortage on site" or ordinary financial questions. It is handled right after the material-price case and ahead of the general business branch, only when no customer or supplier was named. It needs `can_manage_invoices`, exactly like the report route, and is checked before anything is read; other roles are told it is restricted. The answer is built in code (`deliveryExceptionAnswer`), not paraphrased by a model: a count with the kinds (not on any order, short, over), then one line per exception naming the supplier, the item, what arrived against what was expected, and the date, cut at 20 lines with a count of the rest. With nothing open it says so. One extra example, "any delivery exceptions?", was added to the question classifier so the question is recognised as a business lookup.

**Verified:** 580 checks (the trigger against ten questions it must match and nine it must not, the exact answer text for each kind, the 20-line cut, the permission, and that the branch comes before the general business branch and makes no model call); nine deliberate breakages, including making the trigger too broad and opening it to every role, were caught. CI green on all four pushes.

**Not verified live, and the one real uncertainty:** whether the real model classifies a spoken "any delivery exceptions?" as a lookup. The wording check only runs once the message has been classified as a lookup, and that classification could not be tested offline; `/debug/intent-test` shows it directly. If it misclassifies, the fix is another example, not new code.


---

## Stock: where the "inventory system" actually is, and asking on delivery whether to add new items

**The question (Pierre, looking at the Stock Room):** one line, 15 bags of screed. Surely the test orders updated it? Where is inventory manifested?

**What it actually is, traced in the code:** the Stock Room screen reads one table, `stock_items` (name, unit, quantity on hand, reorder threshold) through `GET /stock`. It is a small **consumables ledger**, not a general inventory. Only four things change it: registering an item (a spoken `register_stock_item`; nothing else ever creates one, and deliveries never do), a delivery whose item name equals a registered stock item's name, a recorded usage ("used 5 bags of screed on Jenny's job"), and a stocktake that overwrites the count. Everything else that arrives (carpet, tiles, vinyl) is tracked as order, then delivery, then invoice, with no on-hand quantity. That was a deliberate July decision (the system must never guess which deliveries are stock), and the grout delivery also predates the stock feature. So the marble tiles, the grout and the other test orders were never going to appear there. The real gap was that there was no way to say a delivery is **for stock**: the only route was registering the item first with a name matching the order line exactly.

**The decision (Pierre):** when a delivery arrives with items that are not already stock, **ask on delivery: add to stock?**

**What was built:**
- `recordDelivery` now also reports the items that arrived and are not registered stock (`notInStock`, totalled per item, with their unit); registered items still update by themselves, exactly as before.
- `proposeStockAdditions` raises **one** `stock_add` question per delivery covering all such items ("Add to stock? Marble charcoal carpet tile (2 box), Grout (7 bag) (action #71)."). The question is stored as the action's own text, because the Pending room shows that text. An item is **not asked about again** once it has been declined (a rejected question stays on record) or while a question about it is still waiting, compared without regard to case, using a read-only JSON query; no new table.
- Confirming (`addDeliveredItemsToStock`) registers each item and adds what arrived (if the item was registered in the meantime, this delivery's quantity is still added once); from then on that item updates by itself on every later delivery, in any capitalisation. A payload is not trusted: blank, zero, negative and non-numeric entries are ignored and units are bounded.
- Asked after the delivery is recorded and never allowed to undo it (a failed question is swallowed). Raised from the confirm step and from the direct-record upload path. `stock_add` is answerable by anyone who may know materials (installer, accountant, owner), the same capability that gates stock everywhere else.
- **App:** after a confirm, the app showed the server's message as plain text and never offered buttons for a follow-up question it raised (this is also why the identity-collision follow-up #142 had no buttons). A confirm response that names a follow-up action now gets its own Confirm/Reject. This also fixes that earlier case. Compiled by the real Flutter web build.

**Verified:** typecheck unchanged; 608 checks including the whole flow against a real SQLite database (a registered item updates by itself; the tiles are reported and asked about once; a second delivery does not raise a second question; confirming registers the item at 2 box; the next delivery adds to it silently in any capitalisation; a declined item is never asked again but a new one is; an item registered meanwhile is added once). Thirteen deliberate breakages, including forgetting declines, case-sensitive comparison, trusting a bad payload, removing the permission, and removing the app's buttons, were all caught. One old guard was too tight for the longer handler and was widened after checking the wording was intact. CI green on all five server pushes and on the Flutter web build.

**Not verified live, and limits:** the buttons need a **Codemagic rebuild** to appear on the phone; until then the question arrives as text and is answerable from the Pending room. It is one question per delivery, so it is all-or-nothing for the items in it (declining remembers all of them). Units do not convert: a delivery in boxes adds boxes to an item whose unit was given in sqm. Past deliveries are not asked about retroactively. Each new job-specific item will be asked about once and then, if declined, never again.


---

## Rewrite Phase 1: the contract the function never had, as scaffolding nothing calls

**Re-measured first, because the function had changed:** `processOneExtraction` is now lines 183 to 1938 (1,756 lines). It still returns through one 9-field shape from **10 places**: 9 early returns (the permission refusal, forget-last, the identity and ambiguity holds, two job-scope amendment holds) and one final. Phase 0 had merged the two permission gates into one, which is why the early-return count dropped by one. The two-pass structure and the shared state are unchanged (`pendingActionId` and `pendingActionType` still have 10 writers; `customer` and `character` 2; `workObservationResult` 2).

**What the real return sites turned out to obey, found by reading all ten:** a strict pattern, which is what makes a lossless contract possible. With no action id, the type, candidates and changes are all null. An action id always comes with its type. Candidates only ever accompany an `ambiguous_person` hold and changes only a `job_scope_amendment` hold. Only the final return carries a fact hold or a recorded job scope. Every assignment of `pendingActionId` is paired with one of `pendingActionType`.

**What was built (`worker/src/intents/`, nothing in the live code calls it):**
- `result.ts`: `LegacyProcessResult` (the live shape, named and unchanged), the new `ProcessingResult` (a held action carrying its type, candidates and changes; a separate fact hold; a list of recorded effects; the message), `legacyResultIssues`, and the two adapters. The adapters are lossless over every well-formed result and **refuse anything that breaks the rules** (a `MalformedLegacyResult` error), so a drift in the real function shows as an error and not a plausible wrong answer. One call can both hold an action and record something, which is why recorded effects are a list and not a single outcome.
- `dispatcher.ts`: `ProcessingInput` (the eight positional arguments as one object), `ResolvedExtraction`, the handler type, an adapter that wraps the live function (passed in, never imported, so no import cycle with `index.ts` is possible), and `INTENT_GROUP`: the planned grouping as data, exhaustive over the intent union. It is the corrected plan from the validation results (invoice, price_scope and work_observation as one group; stock and lookup given homes; snags with leads), not the original six.

**A gap found along the way:** the typecheck's `include` was `src/*.ts`, which is not recursive, so anything in `src/intents/` would have silently escaped it. Proven with a deliberate type error that the old setting missed and the new one (`src/**/*.ts`) catches. Widened as part of this change; the tolerated-error baseline is unchanged.

**Verified:** typecheck unchanged against the baseline; the suite is 713 checks, 105 of them new (their own file, run from the existing CI step so the pipeline did not change). The round trip is checked to be the identity over 432 well-formed results in both directions; six kinds of malformed result are refused; the ten real return sites are checked against the rules above, with a tripwire that counts object returns in any formatting (a single-line return escaped the first version of it, found by mutation); the adapter's parameter order and the legacy type's field names and nullability are compared with the live function's, so neither can drift unnoticed; the grouping is checked exhaustive; and a test fails if anything outside `src/intents` imports the scaffold. Twenty deliberate breakages were each caught; three of my own mutations were initially invalid or too weak (one crashed the build instead of testing behaviour, one return form escaped the tripwire) and were redone. CI green on all five pushes, the last of which ran the new tests for the first time.

**Not done, deliberately:** no handler exists, nothing calls the scaffold, the live function was not touched. Phase 2 is the characterization harness. One real constraint on it: CI runs Node 20, which lacks `node:sqlite`, so tests that need a real database can run locally but not in CI unless the pipeline's Node version is raised.


---

## Rewrite Phase 2: the characterization harness, and the first thing it found

**Pipeline:** raised to Node 22 (the workflow edit was permitted and the full pipeline, deploy included, passed), so tests can use `node:sqlite` and a real database.

**The harness (`tools/harness.js`, `tools/characterization.test.js`, `tools/cases/`, `tools/golden/`):** runs the **real** `processOneExtraction`, unmodified, against a real SQLite database built from the live baseline schema (`worker/migrations/0001_baseline.sql`, captured from the live database's own `sqlite_master`), with a scripted AI that **fails loudly on any call nobody planned for** (embeddings always succeed, as in production), in-memory stand-ins for the notes store, the file store and the vector index, and a **frozen clock** (the function stamps times into notes and puts today's date in a note's key, so a recording made today would not match tomorrow's). The function is exposed by an in-memory esbuild transform of `index.ts`, so the live code is untouched. Each case records what the function returns and exactly which rows, notes and vectors it wrote. The recordings in `tools/golden/` are the equivalence matrix the rewritten handlers must reproduce; when behaviour is changed on purpose, `GOLDEN_UPDATE=1` regenerates them and the diff in the commit is the review. Recorded so far: the payments group (24 cases: payment, expense and supplier payment across owner, accountant, installer and a role with no permissions, and across existing, new, case-variant and near-match names) and `convert_quote` (5 cases). Stable across repeated runs and across machines (reproduced in CI).

**What it found: supplier payments leaked into free-text notes.** The recordings showed a dictated "paid Floornet R10000" being copied into the supplier's note, and with no supplier named into the day's note; payments and expenses did not do this. The cause was the third hand-kept list in the function: `hasStructuredHomeAlready`, a list of six intents added in the 2026-07-17 fix for payments, to which the money intents added later were never added. Reproduced end to end with the harness: an **installer's** lookup of that supplier was built from the note containing the amount, though installers cannot see supplier payments anywhere else. A second path leaked the same way: `convert_quote` wrote its words ("she paid 30 percent upfront") into a note queue. Not every odd-looking recording was a bug: a payment with no amount is held on purpose (`payments.amount` is nullable and `recordPayment` is typed to accept no amount), which was checked in the code before saying anything.

**The fix:** the list is gone. `intentKeepsOutOfNotes` (auth.ts) derives the answer from `INTENT_RULES`: any intent that needs `can_manage_invoices` to create is money and keeps its words out of ungated notes, plus `work_observation`, which has structured storage though it is open. That adds supplier payment, supplier invoice, purchase order, credit, quote conversion, delivery and spoken supplier statement, and a new gated money intent is covered the moment it is gated. The regenerated recordings changed **only** the nine cases that leaked (five supplier payments, four quote conversions); every reply, hold and resolved name is identical before and after, which was checked mechanically. A test fails if `index.ts` ever carries its own list again.

**Verified:** typecheck unchanged; 845 checks. The suite was mutation-tested: changing a reply, a hold type, a permission, an expense's requirements, removing a note write, reverting to the old six-intent list, and un-freezing the clock were each detected. Two of my own mutations were false alarms (one could not find its target text, one hit another group's wording) and were redone against the right targets.

**An incident, recorded because it is a process lesson:** while pushing this change GitHub's API stopped responding mid-batch. My script did not stop at the first failed push, so `index.ts` and the tests landed without `auth.ts` (which defines the function `index.ts` now imports). That commit failed its typecheck, so the pipeline never deployed it and production stayed on the last good build; the missing file was then pushed over plain git (a different host, which still worked) and the pipeline passed. The lesson is applied: multi-file changes now go as **one atomic commit over git**, so a half-applied state cannot exist, and the push step stops at the first failure.

**Not done:** only two groups are recorded. The groups that call a model (procurement, invoicing and pricing, observations, lookups) need scripted replies and come next; stock, snags and leads, and the identity holds are further groups.


---

## Rewrite Phase 2, procurement: three more things the recordings found

The procurement group (purchase order, goods received, supplier invoice, variance disposition, and a spoken supplier statement) is recorded in 39 cases, with a scripted model, including a model that fails and a model that finds nothing, because that behaviour is part of what rewritten handlers must reproduce. Reading the recordings critically found three places where "the model gave us nothing usable" was recorded as if it were something:

1. **A model failure silently closed a shortage.** With the model down, a variance disposition row was written with no reason, no resolution and no credit. Any disposition counts as resolved, so the shortage dropped off the open list and the exception report with nothing actually recorded (the reply even said "Noted for Underlay, no reason stated"). Now nothing is written and the reply asks what happened (why it happened, back order or credit).
2. **A supplier invoice with no lines was held for confirmation**, which would have recorded an invoice of nothing. Now nothing is held and the reply says it could not make out any items.
3. **A purchase order with no lines was recorded**, and as the supplier's most recent order it then became what a later supplier invoice is checked against, which matches nothing. Now nothing is recorded and the reply says so.

All three now behave like deliveries already did. Verified in the commit history: the first commit records today's behaviour, the second changes the code and the recordings, and the recording diff is **exactly four of the 39 cases** (the order with no items, the order when the model fails, the invoice when the model fails, the disposition when the model fails); the other 35 are identical, checked mechanically. Each fix was mutation-tested in both directions (removing it fails; making it too aggressive, for example refusing a reason with no resolution or refusing a one-item order, also fails). 964 checks.

**Not changed, noted for a decision:** a disposition that records only a reason (no resolution) also counts as resolved, so it too leaves the open list. That looks deliberate (naming why a shortage happened is documentation) and was left alone, but it means a shortage can leave the exception report without being credited or back-ordered. A model that fails during a **goods received** or **supplier invoice with lines** reading is handled, but a model that fails during a purchase-order reading no longer records anything, so a person dictating an order while the model is down must say it again.


---

## Rewrite Phase 2, invoicing and pricing: a suspected bug confirmed, a crash found, two silent replies fixed

Recorded: `invoice`, `quotation` and `price_scope` in 29 cases (with the three readers scripted: the job-observation reader, the quotation line-item reader and the scope-pricing reader), across owner, accountant and installer, with and without an amount, a task, an installer, a date, an existing job scope, and with each model failing. `work_observation`, the third member of this entangled group, is recorded separately.

**Confirmed by reproduction: the invoice orphan.** It had been suspected since the validation analysis, from reading, and never reproduced. With an amount in the sentence and a date-only change for a customer who already has a job scope, the function creates **two** pending actions (the invoice, then the amendment question) and replies about the amendment alone. The invoice hold exists and was never mentioned, and the app only offers buttons for the amendment. Now the reply says "Your invoice for Jenny Smith of R3000 is also waiting for confirmation (action #1)." The invoice is still reached through the Pending room rather than its own buttons (see `OPEN_QUESTIONS.md`).

**A crash found by the runner:** a `price_scope` request with no customer named **threw** (`Cannot read properties of null`). The reply for a job with nothing to price dereferenced `customer!.name`, a non-null assertion on a customer that was never named. The recording of "must not throw" failed on it, which is how it surfaced. It now gets the same honest reply as invoices, quotations and payments with no customer ("I heard a price for a job, but no customer name came through, who is it for?"). My first attempt did not work: the catch-all reply for that case sits later in the chain than the branch that crashed, so the crash still fired first; the crashing branch had to be guarded on there being a customer.

**Two silent replies:** an invoice with a named customer but no amount and nothing to record, and a quotation with no readable items and no amount, were both answered "Found existing customer: Jenny Smith.", as if they had been lookups. They now say what was heard and what is missing.

**Verified:** typecheck unchanged; 1,154 checks. The recording diff is **exactly four of the 29 cases**, 25 are identical (checked mechanically), and in all four the rows written are the same before and after: these are reply-only changes. Six deliberate breakages were each caught, in both directions (removing a fix, and making it too aggressive, for example a note about an invoice that was never held, or an amountless-invoice reply that steals the reply of a recorded job scope). The push has two commits so the history shows baseline then fix; the baseline withholds the crashing case so every commit passes.

**Not done:** `work_observation`, lookups, stock, snags and leads and the identity holds remain to be recorded.


---

## Rewrite Phase 2, work observations: a mislabelled reply and a job built from nothing

Recorded: `work_observation` in 18 cases: a job with measurements, with and without prices, for owner, accountant and installer (an installer records the job but is never priced for, shown by the pricing model not being called at all); a date-only change for a customer who already has a job (the amendment question); attaching to a sibling job or lead from the same message; an installer already booked that day; an unknown installer; a customer not on file; no customer named; a model that finds nothing, fails, or finds only an installer. This completes the entangled invoicing, pricing and observation group.

**A mislabelled reply.** When a spoken observation also priced the job, a *quotation* was held, but the reply read **"Payment noted for Jenny Smith, needs your confirmation"**. The noun was guessed from the intent, and a spoken observation is not one of the intents it knows, so it fell through to "Payment". It now comes from the type of the action actually held.

**A job built from nothing.** When the model found nothing, or failed, a job scope was recorded anyway, with no measurements, no tasks, no date and no installer. As the customer's most recent job it then became what a later "price Jenny's job" tries to price (and is told it cannot match anything). The invoice branch has always guarded against this; this branch did not. Nothing observed is not a job: nothing is recorded and the reply says what could not be made out.

**Verified:** typecheck unchanged; 1,229 checks. The recording diff is **exactly four of the 18 cases** (the two priced observations, and the two where nothing was observed); 14 are identical (checked mechanically). In the two priced cases the rows written are identical and only the noun changed; in the other two a job scope is no longer written. Five deliberate breakages were caught in both directions, including treating an installer-only or a date-only observation as "nothing" and removing the role gate on pricing. One mutation survived at first because no case had an observation with only an installer; a case was added and it is now caught.

**Not changed, recorded in `OPEN_QUESTIONS.md`:** pricing skipped without a word when the pricing model fails or finds nothing; a date spoken as an ordinal word ("the seventeenth") is not parsed to a date at all, though "the 10th" is; and a customer-less job scope is recorded when only an installer or date is heard and there is nothing to attach it to.


---

## Rewrite Phase 2, lookups: recorded, and what the recordings say about who can see what

Recorded: lookups in 36 cases, covering a material's last price, the delivery exception question, business-wide questions (which screen opens, and which facts each role's answer is built from, including follow-ups about quotations, invoices and expenses and a model that fails), a supplier or installer, a customer, and "what is on today", across owner, accountant, installer and a role with no permissions. The answer-writer is scripted to **echo the facts it is given**, so each recording shows exactly what each role's answer was built from; that is the point of recording a lookup, because the facts are where permissions are enforced. Lookups were confirmed to write nothing but the stored sentence and, for a named person, the selection context: no note, file or business row.

**No code was changed.** The lookups behave as designed. What the recordings did was make visible, for the first time in one place, how open each answer actually is. Five things are recorded in `OPEN_QUESTIONS.md` for a decision, because they are policy, not defects:

1. **An installer sees expense totals and the aged-creditors breakdown**, including what is owed to each supplier ("Floornet: R1200 total outstanding"), through a business question, because both are gated by `can_know_materials`. The supplier screen needs `can_manage_invoices`.
2. **Notes written before the notes fix still contain money**, and are still readable by an installer (a supplier note with "paid Floornet R10000" was read back to one). The earlier fix stops new leaks; it does not clean what is already stored.
3. **A material's last price (and which supplier charged it) is ungated**: any role, including one with no permissions, can ask.
4. **A person's details are shown to every role**, and `can_know_payroll` and `can_know_banking` exist but nothing in the code ever checks them. Harmless today, since no payroll data is stored, but a day rate or a bank detail saved as a "detail" would be visible to everyone.
5. Smaller: a broad financial question from an installer still opens the snapshot screen (the screen's own data is gated, so it shows nothing), and "There are 1 quotations on file" has a grammar slip.

**Verified:** typecheck unchanged; 1,376 checks; stable across runs; the whole suite runs in about 30 seconds. Two earlier lookup fixes are already covered by these recordings (the delivery exception question is permission-gated; an installer is told it is restricted).

**Not done:** stock, snags and leads, and the identity holds (the preamble that runs before every intent) remain to be recorded. After those the whole function is characterized.


---

## Rewrite Phase 2, stock, snags and leads: one real defect

Recorded: stock (27 cases: registering an item, using stock, counting it) and snags and leads (28 cases: raising and resolving a snag including the retention release, raising a lead, and the owner-only "lead lost"), each with its model scripted, across owner, accountant, installer and a role with no permissions, and with each model failing or finding nothing.

**One real defect: registering a stock item that was already tracked inserted a second row with the same name.** Deliveries then added to the first, usage matched the first, and the second sat at zero for ever, shown as a duplicate line on the stock screen. Registering is now idempotent: the same name (ignoring case) is the same item, the existing row is reused, and the reply says "Already tracking Screed (bags)" instead of claiming a new item. The two boundary cases were added so the fix is pinned from both sides: the same item in a different case is reused, and a different item whose name merely starts like a tracked one ("Screed Plus") is still created.

**Verified:** typecheck unchanged; 1,602 checks. The recording diff for the existing cases is **exactly one of 25** (the duplicate registration: one row no longer added); the snags and leads recordings were unchanged (28 of 28). Four deliberate breakages, including a too-strict match (a different case treated as a different item) and a too-loose one (a name that merely starts with a tracked name treated as the same item), were caught. One of my own mutations ran in the wrong direction and looked like a survivor until it was redone correctly.

**What the recordings confirmed is working:** an unmatched item, an item with no quantity, nothing tracked yet, and a model that fails all give an honest "couldn't match" reply and write nothing; installers may register, use and count stock and a role with no permissions is refused with nothing written (the decision that money and stock are gated at creation); resolving the last open snag releases the customer's retention only if they hold one, and not while another snag is open; marking a lead lost is owner-only; a snag or lead the model cannot read says so.

**Recorded in `OPEN_QUESTIONS.md`, not changed:** using more stock than is on hand records the usage and reports "-5 remaining" without comment; and any duplicate stock rows that already exist in the live data from before this fix are not merged.

**The function is now characterized except for its opening step.** Recorded so far: payments, quote conversions, procurement, invoicing and pricing, work observations, lookups, stock, and snags and leads (about 220 cases). What remains is the identity step that runs before every intent (finding or creating the customer or supplier, and the "is this the same person?" holds).


---

## Rewrite Phase 2, the opening step: "forget that" could abandon anyone's pending action

The opening step of `processOneExtraction`, what runs before any intent, is recorded in 42 cases: "forget that", finding or creating a customer, finding or creating a supplier or installer, the question raised when a name belongs to someone who does the work, the question raised when a name merely sounds like someone on file (one candidate, or several), a lookup that finds and never creates, and the follow-up fallback that works out who "her" or "him" meant (from the current selection, from the conversation, or from neither), including a model that fails at either step. **With this, all of `processOneExtraction` is characterized** (about 260 cases across nine groups).

**A permission bypass: "forget that" abandoned the newest pending action of anyone's.** Recorded rows showed an installer's "forget that" (and the same from a role with no permissions) abandoning the owner's pending R98,000 invoice, which the confirm and reject routes would have refused them. The command is open to every role by design, but it never asked whose action it was abandoning. It now takes the newest pending action the caller could resolve through the normal routes, and nothing if there is none. The rule is written once (`canResolveActionType`) and a test proves it agrees with the real confirm route for every role and every action type the suite knows: the owner may resolve anything (only the owner holds `can_manage_settings`, and a type with no entry is owner-only); everyone else needs a capability listed for the type.

**Two wording faults in the collision question:** it said a person was "already on file as a **character**" (the system's own word, when it knew they were an installer or a supplier) and the reverse said "now acting as **a installer**". It now names the real relationship with the right article ("an installer", "a supplier"), and "a contact" when none is recorded.

**Verified:** typecheck unchanged; 1,853 checks. Of the 36 baseline cases exactly **five** changed (the two "forget that" cases that used to abandon the owner's invoice, and the three collision questions); 31 are identical. Six cases were added so each side of the fix is pinned (the installer takes the newest action they may resolve and skips a newer invoice; the accountant skips an owner-only action; the owner may abandon an owner-only action; and each wording variant). Seven deliberate breakages, including too-strict and too-loose versions of the rule, were caught. One batch of mutation runs exceeded the time limit and was split in two.

**What the recordings confirmed is working:** near-matches and name collisions stop and ask, and write nothing but the held question; a lookup never creates a customer or supplier; a name on file in a different case matches; a follow-up uses the current selection first, then the conversation, then gives up honestly; a model that fails at either step degrades to "I don't have anything on file"; a personal question never borrows the selection; a customer and a supplier in one message are linked.

**Recorded in `OPEN_QUESTIONS.md`:** the "current selection" (who "her" means) is one setting for the whole business, not one per person, so one person's lookups change what another person's follow-up means, and "forget that" clears it for everyone.

**What is not characterized:** only `processOneExtraction` is. Its callers are not: the splitting of a spoken message into topics, the confirm and reject routes and what they replay, and the upload handlers.


---

## A wrong declaration, found while preparing to record the callers (and my scaffold had copied it)

`processOneExtraction` declared its amendment-question changes as `{ field, oldValue, newValue }`. What it really returns, built in `checkForJobScopeAmendment`, is `{ field, label, displayValue }`; `processTranscript`, which receives it, declared the real shape. Two of the 45 "tolerated" type errors were exactly this disagreement, and a third (an argument error where `processTranscript` stores the result) had the same root cause. **My Phase 1 scaffold copied the wrong declaration** into `PendingChange`, and its drift guard could not catch it because it compared only top-level field names. The recordings, which hold the real runtime values, are what showed the true shape.

Fixed in all three places: the declared return type (a type-only change: behaviour is identical), the scaffold, and the guard, which now compares the nested shape in the scaffold, in the function's declaration and in the code that builds it (mutation-tested: changing any one of the three fails). The baseline of tolerated type errors shrank from 45 to 42. The candidates' shape (`{ id, name }`) was checked too and was right.

**Lesson, kept deliberately:** a guard that compares names but not nested shapes passes on a wrong declaration. The scaffold's earlier claim of being "lossless over the real domain" was true only at the top level.


---

## Rewrite Phase 2, the first caller: `processTranscript` recorded

`processTranscript` is what calls `processOneExtraction`: it logs the capture, asks a model to split the spoken message into topics, asks a model to read each topic, runs each through the function, attaches a new job to the customer's open project (or asks which), and joins the replies. It is recorded in 19 cases, each a whole spoken message with both models scripted. The harness gained a second kind of case (a "transcript" case, which supplies no extraction because a model reads each topic) and loads both functions from one in-memory bundle of `index.ts`; the live code is still untouched.

**Recorded and confirmed working:** one topic and several; the replies joined as a bulleted list; a topic the model cannot read becomes "I didn't catch anything there I could act on" without disturbing the others; **every way the splitter can fail** (it throws, answers with something that is not a list, an empty list, a list with a non-text item) falls back to treating the whole message as one topic, which the recordings show gives the same result as a clean one-topic message; a run of bare measurements is merged into the topic that follows it; a question and an action in one message; the audio key kept on a spoken capture; a refused money topic and an allowed snag in the same message each get their own reply; the new job is attached to the customer's one open project, asked about when there are two, and left alone when there are none.

**Recorded in `OPEN_QUESTIONS.md`, not changed:** with **two jobs in one message**, both are grouped under a brand-new project and no question is asked, even when the customer already has two open projects; with one job it asks which existing project. So the same customer is treated differently depending on how many jobs were in one sentence, and a duplicate project is created. This is a design question, not a defect I can settle.

**Verified:** 1,931 checks; all nine existing recordings are byte-identical after regeneration, which is itself a check that the new harness changes nothing. Six deliberate breakages of the caller (the reply format, the splitter fallback, which pending action is primary, never asking the project question, joining merged fragments differently, and skipping project resolution for multi-topic messages) were each caught; **one survived at first** because my only multi-topic job case created its own project, so skipping resolution made no difference, and a case with one job and an unrelated topic was added to close it.

**Not yet recorded:** the confirm and reject routes and what they replay, the upload handlers, and the route layer around them.


---

## Rewrite Phase 2, the confirm and reject routes: two ways a question could be lost

The confirm and reject routes are where a held action finally becomes a record. They are recorded in 51 cases through the **real request handler and the real authentication gate**: the harness signs a real session, seeds a real membership row, and uses the real role table, so the gate's own answers (401 signed out, 403 not a member, 403 wrong role) are part of the recordings. Each held action is created first by running the real dictation, so its stored payload is exactly what the code writes and not a hand-copied guess; the recorded writes are those of the final request only. Covered: every action type the handler knows (payment, expense, supplier payment, invoice and quotation with their signed document links, quote conversion, delivery with the stock question it raises, supplier invoice, credit, identity question, near-match question with one and several candidates, amendment, project question, customer and supplier facts, schema suggestion), confirming twice, an unknown id, a payload that cannot be read, and an unknown type.

**Two defects, both ways a question could be lost, both fixed:**

1. **A refused answer killed the question for ever.** When a near-match question had several candidates and the request did not choose one (or chose one that was not a candidate), the handler returned a 400, but it had already marked the action `processing` and never put it back. The recordings show the action changed on that 400, and a correct answer afterwards was told "action already processing". The same happened to the project question. A claim is now released on every early return that did not complete the action.
2. **The replay ran with the confirmer's permissions.** An identity or near-match question replays the original dictation when answered, using the permissions of whoever answers. An installer who confirmed a question about a payment the owner had dictated got "confirmed", a customer was created, the payment was refused by the replay, and it was **silently lost**. An installer's *reject* created a person and a customer the same way. Now the answerer's permission for the original intent is checked before anything is written: the question is put back untouched, the answerer is told why (403), and the owner can still answer it. The accountant, who may record payments, is unaffected.

**Verified:** 1,934 checks plus the new cases; the recording diff is **exactly nine of 51 cases** (the five that used to lose or stick, plus the answers that now succeed after a refused attempt), 42 identical, checked mechanically. Nine deliberate breakages (not releasing a claim in either place, releasing it as the wrong status, removing the permission check from each of the three replay paths, a refusal that still consumes the question, a refusal that never fires, and one that refuses even the owner) were caught; **one survived at first** (no case had an installer *confirming* a near-match question about a payment) and a case was added.

**A baseline that was wrong, caught and redone:** the suite replaces the global `Response` with a small stand-in at its top for its permission tests, which made every route case throw "response.text is not a function" and my first recording hold `result: null` for all 50. It was noticed because every case showed as having thrown. The suite now keeps the real `Response` and swaps it in only while a route case runs, and the baseline was re-recorded against the **original** code in a scratch copy, so the before and after are compared like for like.

**Recorded in `OPEN_QUESTIONS.md`, not changed:** answering "yes, the same person" to an identity question creates the customer (or supplier) record **unlinked** from the existing person, whereas the near-match answer links it. The 2026-07-25 comment in the code says the record is created "separately", so this may be intended, but the question itself reads "is this the *same* person". And rejecting an identity question ("someone else was meant") drops the original dictation without a word.

**Not yet recorded:** the upload handlers and the remaining routes around them.


---

## Rewrite Phase 2, the upload handlers: one lost voice note, and a 131-line duplicate

The three upload handlers (`/files/document`, `/files/photo`, `/files/audio`) are recorded in 50 cases through the real request handler. The PDFs are **real, with a real text layer**, generated with the same library the product uses, so the text extraction is exercised for real (a scanned PDF with no text layer, a plain text file, an image, and an image the vision model cannot describe are all cases). The harness gained multipart request bodies, a deterministic `randomUUID` (the handlers put a random id in the storage key and echo it in the response, so a recording would otherwise differ on every run), raw model replies (speech to text does not answer in the chat shape), and **pairs**: cases that must behave identically with each other, not only with their own recordings.

**Recorded and confirmed working:** a delivery note read from the document alone is held for confirmation, with the supplier marked as read from the document and not stated; with a caption naming the supplier it is recorded directly, and an unordered item is received and logged as an exception; an unknown issuer, an issuer that could be either of two suppliers, and an unreadable issuer each get an honest "nothing was recorded" reply; a priced supplier invoice is held; a statement is compared with the books; an installer's supplier invoice and statement are refused (the file is still stored), while an installer's delivery note is accepted, as decided; the same upload sent again is answered from the first without writing anything; a model that fails at any step degrades to "stored" with no message.

**One real defect, fixed: a voice note whose transcription failed (or came back empty) left no record at all.** The audio file was stored and the person was told it had been received, but nothing was written to the database, so nothing pointed at the file and it could never be found or retried. Documents and photos have always logged a capture before anything else; audio only did so inside a successful transcription. It now logs a capture (source `voice`, pointing at the stored file) when there is nothing to process. The response is unchanged.

**A structural finding: the 131-line supplier-document decision section exists twice**, in the document handler and again in the photo handler, **identical except for the name of one variable** (verified by diffing them). Four pairs of cases (a delivery read from the file, a caption naming the supplier, an unknown issuer, an installer's refused supplier invoice) now run the same scenario through both and must agree on the message, the refusal, the held action and the subject. Breaking only the photo copy, in two different ways, fails the pairs. This is the clearest candidate for the **first real handler move in Phase 3**: it is fully recorded, it is duplicated, and a single shared function would remove the possibility of the two ever drifting apart.

**Verified:** 2,342 checks; the recording diff for the audio fix is **exactly two of 50 cases**, 48 identical. Twelve deliberate breakages were each caught, none survived: removing the three permission refusals, recording a document-read delivery without confirmation, breaking **only the photo copy** two ways (inference and refusal) and a third (which customer a caption named), the retry answer for documents and for voice notes, ignoring the conversation sent with a voice note, reading a PDF without its spaces, and the audio fix removed or made too aggressive. Three of those were caught first by older source-pattern tests, which is the order it should be.

**Already recorded, now with a case:** a caption naming a customer who is not on file creates the customer **before any permission check**, even for an installer (item 9 in `OPEN_QUESTIONS.md`, left alone by decision).


---

## Decisions session, round 1: who can see what

Pierre went through the open questions, most serious first. Round 1 (the three access questions):

1. **Installers must not see expense totals or supplier balances.** Decided: hide both. Applied: the expense summary and the aged-creditors breakdown in a business question now need the invoicing permission, the same strength as the supplier screen, using the "restricted for your role" markers that already existed. Owner and accountant are unchanged; an installer's answer now says expense activity and supplier balances exist but are restricted. Two cases were added (an installer's and an accountant's follow-up about expenses) so each gate is pinned on its own; the recording diff is **one existing case** (the installer's narrow question) plus the two new ones, 35 identical. Five deliberate breakages were caught (either gate reverted, either over-tightened to owner-only); one of my own mutations was invalid (the accountant also holds the profit permission, so it restricted nobody) and was redone.
2. **Old notes that still hold money: left as they are.** Accepted knowingly. The earlier fix stops new leaks; notes already stored can still hold, for example, "paid Floornet R10000", and an installer can still read them.
3. **A material's last price (and the supplier): stays open to every role.**


---

## The permission grid: the owner switches a role's permissions on and off

Built at Pierre's direction ("most of these decisions are on/off toggles of a master permission grid, so build that in the owner"): backend and screen together, starting with the existing capabilities.

**How it works.** Every gate in the code already asks "does this caller hold capability X", and the capability table was read in only four places, so the grid is that table made editable. `ROLE_CAPABILITIES` stays as the **defaults and the fallback**; the owner's changes are stored as **overrides** on top of it and applied through one loader, `getRoleCapabilities`, which every request reads (so a change takes effect immediately). The tables are created the first time they are needed, so there is no migration to run by hand. Four owner-only routes serve the screen: read the grid, change one switch (`PATCH`, not `PUT`: the worker allows only GET, POST and PATCH in its CORS headers and uses PATCH for every other update, which would otherwise have worked on the phone and failed on the web build), reset a role, and read the audit trail. A new **Permissions** room (drawer) shows role tabs, one switch per permission with a plain-language description, a "changed" mark, a reset button and the last few changes.

**The property that matters: with no overrides, nothing changes.** All 12 existing recordings regenerate byte-identical, so a role has exactly what it had until the owner flips something.

**Guard rails, each tested and each mutation-checked:**
- The owner's row can never be changed or overridden, so nobody can be locked out (a stray override row against the owner is ignored; a case proves the owner still opens the grid and the owner-only leads).
- Owner-only permissions (`can_manage_settings`, `can_invite_members`, `can_delete_data`) can never be given to another role. `can_manage_settings` matters most: the owner-only routes, "lose lead" and the owner-only action types all rely on only the owner holding it. Stray override rows granting them (and unknown or unused ones) are ignored.
- A permission that **nothing in the code checks cannot be switched.** Six of the twelve are never checked anywhere (payroll, banking, measurements, voice notes, invite members, delete data). A switch wired to nothing would mislead, and an override stored today would silently become live the day something started checking it. A test compares each permission's "in use" flag with the code and fails when they disagree, so that day forces a deliberate decision.
- If the overrides cannot be read, the request **fails**; it does not quietly fall back to the wider defaults (only "the table does not exist yet" means "no overrides").
- Only a difference from the default is stored; switching something back removes the override; a change that changes nothing is not logged. Every real change is audited (who, role, permission, from, to, when).

**The effects are recorded, not just the settings** (44 cases through the real request handler and gate): taking materials from the installer makes the stock room 403; giving an accountant jobs opens projects; taking money from an accountant stops them confirming a payment and giving it to an installer lets them; taking profit from an accountant, and giving money to an installer, each change what a business question shows them, with a control case for each default beside it.

**Verified:** 2,638 checks. Nine deliberate breakages were each caught (switches ignored everywhere, the route gate or the dictation and lookup path reading the static table again, an owner-only or unused permission becoming switchable, the owner becoming overridable, an override kept after switching back, a no-op change logged, and an unreadable table failing open). The loader's first version re-sorted the defaults into catalog order, so "no overrides" did not literally return the defaults; the test caught it and the defaults now keep their own order.

**The honest limit, and why it matters:** with the existing capabilities only **five are real switches** (money in and out, who owes us, profit, materials and stock, jobs). `can_manage_invoices` is checked in 44 places, so it is one coarse switch: it governs recording money, but also seeing quotations, expense totals and supplier balances. Pierre's earlier decisions that need finer control (supplier balances separately from expense totals, material prices, person details) cannot be separate switches until those become their own capabilities. Splitting them was offered and **deferred by decision**; it is recorded in `OPEN_QUESTIONS.md`.

**The screen is unverified on a phone.** The Dart cannot be compiled in the sandbox: it was written to mirror the Leads room, checked for balanced brackets and for every identifier and constant it uses, and the web build in CI is the compile check. It needs a Codemagic rebuild to appear on the phone.


---

## Decisions session, round 2: notes and captions

Round 2 (the remaining "who can see or create what" questions), decided by Pierre:

5. **Stock, snag and lead sentences stay out of notes too.** Applied: the seven intents (register a stock item, stock used, stock count, raise and resolve a snag, raise and lose a lead) join the explicit set of intents whose sentence is never copied into a customer's or supplier's note, because each has structured storage of its own and a note is read back to anyone who looks the person up. The recording diff is **53 of 414 cases, and in every one the only difference is notes no longer written** (69 note writes removed in total); checked mechanically: no reply, hold or other row changed in any of them, and 361 cases are identical. Three deliberate breakages were caught, including one that made it too broad (reminders, which were not decided, would have been kept out too).
6. **An upload caption is permission-checked before it creates anyone.** Applied to both the document and the photo handler: the caption gets the same check as dictation. A role that is refused (an installer whose caption says "Brand New Person lounge quote") can no longer create the customer or supplier it names; the file is still stored, still linked to someone **already on file** (finding is harmless), and the response now carries the refusal so the client can say why. A role that is allowed is unchanged: an owner's caption still creates, and so does an installer's with an **open** intent such as a note, exactly as dictation does. One existing recording changed (the installer's new-customer caption: a customer row no longer created); ten cases were added, including document-versus-photo pairs for a new customer (installer and owner) and a new supplier, so the two copies of the logic cannot drift (seven pairs in all). Five deliberate breakages were caught, including breaking **only the photo copy** for customers and for suppliers, and making it too strict (an allowed caption unable to create, a refused one losing its link to an existing customer). My first set of cases left the photo copy's supplier branch uncovered; that gap was found by asking what a photo-only breakage of that branch would do, and closed.

**Question 4 (person details and the unused pay permissions)** was answered by the permission grid: the payroll and banking switches cannot be flipped until something in the code checks them, so there is nothing to decide yet.

**Verified:** 2,696 checks; typecheck unchanged.


---

## Decisions session, round 3: shortages and orders

Round 3 (how the books behave), decided by Pierre:

7. **A reason alone closes a shortage: kept as it is.** Saying only "it was damaged" still counts as resolving the shortage and removes it from the exception report.
8. **Only a credit writes off a shortage: kept as it is.** Accepting a shortage leaves the missing quantity outstanding, so a later delivery of that item is matched to the old order.
9. **Cancelling an order: built, as a spoken "cancel the Floornet order".**

**How cancelling works.** A **held action**, never a direct write: it is destructive, so it asks first and shows which order ("Cancel Floornet order #1 Vinyl and underlay (50 sqm Vinyl, 100 sqm Underlay not yet received)? Needs your confirmation"). With one open order it offers that one; with several it **never guesses**: it lists them and asks for a number ("cancel order 3"); a number followed by a unit ("order 50 sqm") is a quantity, not an order number; a number that is not one of the open orders lists the ones that are. The supplier must already be on file: the opening step **finds and never creates** for this intent, so a cancel for a name nobody has heard of cannot create a supplier. Permission is the same as placing an order (the invoicing permission); the held action needs the same to confirm. Confirming records the cancellation and **closes that order's open shortages** (resolution "cancelled"), since the rest is no longer expected. A cancelled order stops attracting deliveries (a delivery confirmed afterwards is received as an exception), is no longer "the latest open order" an invoice is checked against, and is not offered for cancelling again. Orders have no status column, so a cancellation is its own small row, in a table created the first time it is needed (no migration to run by hand; remembered per database handle, because a process-wide flag would be wrong for any second database).

**The property that matters: with nothing cancelled, nothing changes.** All 414 existing recordings across 13 files are **byte-identical**; only 23 new cases were added (15 dictation, 8 confirm and reject, including the chain where a delivery held before the cancellation is confirmed after it).

**Verified:** 2,801 checks; typecheck unchanged. Nine deliberate breakages were each caught (a cancelled order still attracting deliveries or still being the invoice's order, an unknown supplier being created, cancelling that does nothing, a cancel that is never held, shortages left open, any role allowed to cancel, an accountant unable to confirm, and the whole order-number unit guard removed). **Two of my own checks were wrong first:** my "quantity" case read "order **of** 50 sqm", which the order-number reader never looked at, so it did not exercise the guard at all; and removing one unit word from the guard changed nothing because `sq` independently blocked "sqm". Both were found because the mutation survived, and fixed (a phrasing where the guard matters, and removing the whole guard).

**Two honest limits.** The reader that classifies a spoken sentence is a real language model and could not be run here: its prompt now describes the intent and gives an example, but "cancel the Floornet order" needs one real try on the phone (recorded in `OPEN_QUESTIONS.md`). And the Pending room labels a held action by its raw type, so it shows "CANCEL_ORDER" with the original sentence, as it already shows "STOCK_ADD" and "IDENTITY_COLLISION".


---

## Decisions session, round 4: nothing waiting or dropped without saying so

Round 4 (the "part of what you said got dropped silently" group), decided by Pierre:

**11. Say so when the job part of an invoice could not be read.** If the reader that pulls the installer, date and measurements out of "invoice Jenny R5000, Sepo installs Monday" fails, the invoice is still held but the reply now says: "I couldn't read any job details (measurements, an installer or a date) from that, so only the invoice was noted. Say the job part again if you want it recorded." The reader now reports when it **actually failed** (a `readFailed` flag set only in its failure path), so the note appears only then, and never when the reader worked and simply found nothing ("invoice Jenny R5000" alone says nothing extra, which a case pins). An invoice with no amount and a failed reader says so too.

**12. Say so when prices were mentioned and no quotation came of it.** A job description with prices ("lounge 5 by 4, R450 a square metre"), where the pricing reader fails, finds no priced item, or the total is nothing, now records the job and adds: "You mentioned prices, but I couldn't make out a priced item, so no quotation was made. Say the prices again against the job." A role that is never priced for (an installer) gets nothing extra; a case pins that.

**10. Show both waiting actions in the app.** The server built its list of waiting actions from each segment's primary id only, so an invoice held alongside a job-change question (the orphan found earlier) was in the reply text but in **no field at all**, and the app only ever read the primary id. Now: a segment that creates two holds carries the earlier one in an **optional** `alsoPending` field (present at that one site only, so no other result is touched), and the response carries a full ordered `pendingActions` list with each type. The app adds a Confirm and Reject for each extra item, and with more than one thing waiting it puts a short caption above each ("Job change", "Invoice", and so on). A **project question and a near-match question are deliberately not added as items**: they need a chosen project or person, so a plain Confirm would only be refused, exactly as before. The Phase 1 scaffold carries the new optional field both ways, and its drift guard now compares optional fields and extracts the interface by matching braces (its first version cut the interface short at the new field's inline braces, which the guard itself noticed).

**The property that matters:** 419 of the 448 existing recordings are **byte-identical**; 29 differ only by the added `pendingActions` key (checked mechanically, with the key stripped they equal the old recordings); 3 have a changed reply, exactly the three decided ones; 2 are new (an invoice with no amount and a failed reader, and a whole message that holds an invoice and a job-change question, showing both waiting actions in order with their types).

**Verified:** 2,811 checks; typecheck unchanged. Seven server breakages were caught: the failed-reader flag removed; the note added even when the reader worked; the pricing note removed; the pricing note shown to an installer; the invoice left out of the waiting list; the project question left out; the primary action no longer first.

**The app part is unverified on a phone, and the Dart cannot be compiled here.** It is a pure insertion of three blocks (no existing line changed), each checked for balanced brackets in place, using only identifiers already used elsewhere in the file; the web build in the pipeline is the compile check. It needs a Codemagic rebuild to appear on the phone (see `OPEN_QUESTIONS.md`).


---

## Decisions session, round 5: names and identity

Round 5, decided by Pierre:

**13. "Yes, the same person" now links them.** Confirming an identity question ("is this the same Jabulani, now acting as a customer too?") used to insert the customer (or supplier) record **unlinked** from the existing person, though the near-match answer links its record and the question reads "same person". The new record is now linked to the person the existing one already has; if the existing record has no person yet (one from before people were recorded), one is created and linked to **both**. The 2026-07-25 comment in the code said the record was created "separately"; that is now superseded by this decision.

**14. Rejecting an identity question says what was dropped.** "No, someone else was meant" used to record nothing and say nothing, so the person had to notice and repeat everything. The reply is now: `Okay, nothing was recorded. I didn't act on "<what was said>". Say it again with the name you meant.` (shortened with "..." past 120 characters). **This needed an app change as well:** the app only ever read the server's message after a *confirm*, so a message from a reject would never have reached the person. It now reads the message after a reject too, which also means that a near-match question rejected as "a new person", whose replay can leave a question of its own waiting, now shows that question with its buttons, as a confirm always did. The app change is one condition and a comment.

**15. Two jobs in one message ask about the customer's existing projects, as one job does.** They used to be grouped under a brand-new project whenever a second job for the same customer arrived in one message, even if the customer already had open projects, and no question was asked. Now, if the customer has an open project, nothing is invented: each job goes to the same step that places a single job (attached to the one open project, or asked about when there are several). A group project is still created when the customer has **no open project**. "Open" is the existing definition (no invoice yet, or an unpaid one), reused rather than approximated, so a customer whose only project is paid in full still gets a group project; a case pins that, and so does the "any project at all" mistake.

**Verified:** 2,831 checks; typecheck unchanged. **Of the recordings, six changed (the four identity confirmations now carry the person link, the reject gained its message, and "two jobs for a customer with two open projects" now asks), five were added, and every other recording is identical.** Seven deliberate breakages were caught: existing projects ignored; **any** project (even a paid one) suppressing the grouping; a confirmed same person left unlinked; no person created when the existing record has none; a silent reject; a reject message added to every rejected action; and the long-sentence shortening removed.

**Unverified on a phone:** the app change (the web build compiles it). It needs a Codemagic rebuild; see `OPEN_QUESTIONS.md`.


---

## Decisions session, round 6 (part 1): stock

Round 6 was stock and units, decided by Pierre: build per-item unit conversion (**16**, below, in its own change), say the count looks off (**17**), and build a merge for duplicate stock rows (**18**).

**17. Using more stock than is on hand says the count looks off.** It is still recorded (the usage happened; the count was wrong), but the reply, which used to report "-5 remaining" without comment, now adds: "That is more than the 15 on hand, so the count looks off. A stock count will put it right." Using exactly what is on hand ("0 remaining") says nothing extra, which a case pins, and so does the too-noisy mistake of calling it off at zero.

**18. A tool to merge the duplicate stock rows that already exist.** Registering a stock item became idempotent earlier, which stopped new duplicates but left any that were already in the live data. `POST /debug/merge-stock-items` (admin key) is a **dry run unless sent `{"confirm": true}`**, so what would change is always shown first. For each set of rows with the same name (ignoring case and spaces): the earliest row is kept, the others' quantities are added to it, their usage and stock-count history is repointed to it, each merge is recorded in a `stock_item_merges` table (created the first time it is needed), and the extras are removed. A set whose **units differ** (bags and kg) is left alone and reported, never guessed at, and the message says so (my first message said "No duplicate stock items to merge" while the response listed a set it had refused to touch). A request that is not exactly `confirm: true` (for example the word "yes") is only a dry run. Run twice, the second does nothing. A session without the admin key, including a signed-in owner, gets 401.

To use it from Termux: `curl -X POST .../debug/merge-stock-items -H "X-Admin-Key: ..." -d '{}'` shows what would merge; add `{"confirm":true}` to do it.

**Verified:** 2,874 checks; typecheck unchanged. Of the existing recordings **one** changed (the over-use reply); **10 cases are new** (9 for the merge, 1 for exactly-on-hand); every other recording is identical. Six deliberate breakages were caught: the negative-count note removed or made too broad (firing at zero); the dry run actually merging; any truthy value counting as confirm; the usage history left pointing at a removed row; and rows with different units merged anyway. The harness gained an admin-key option for route steps.


---

## Decisions session, round 6 (part 2): per-item unit conversion

Decided by Pierre: **16. build per-item unit conversion.** (Parts 17 and 18 of the same round, the stock count warning and the duplicate-stock merge, were built and recorded above.) The first reply said the other session would build this and I would review it; Pierre then changed his mind and asked me to build it. `main` was checked before and again immediately before pushing and had not moved, so the two did not overlap.

**The problem.** A delivery counted in boxes against an order placed in square metres was compared number to number (20 boxes against 50 sqm looked like a shortage of 30), and stock was added in whatever unit the delivery used. For a flooring business that is the ordinary case, not an edge.

**What it does.**
- **Saying it once.** "A box of laminate is 2.2 square metres" is a new spoken intent (`set_unit_conversion`), gated like the rest of stock (materials access). It is a direct write, always replies with what it understood, and saying it again replaces the number (and says what it replaced). A conversion the other way round for the same item replaces the opposite one, so the two can never contradict each other. A name the classifier mistakes for a customer cannot create one (the opening step only finds, never creates, for this intent).
- **Using it on a delivery,** on all three paths (spoken, document, photo): a line in a different unit from the order line it matches is converted when a conversion is known (the reply says "20 boxes of Vinyl counted as 50 sqm"). When two **recognised** units differ and **no conversion is known, nothing is guessed and nothing is held or recorded**: the reply names both units, says how to answer ("a box of Vinyl is 2.2 sqm"), and asks for the delivery to be said again.
- **Two rules that stop it getting in the way.** Only units the table *recognises* (square metres however spelled, boxes, bags, rolls, lengths, tiles, sheets, litres, kilograms, tubes, tins, packs, pallets, metres, each) are ever treated as different; a unit it does not know, or none stated, is compared exactly as before, so a word it has never seen cannot block a delivery. And an item is matched by its whole name first, then by a conversion whose words are all contained in it ("laminate" applies to "Pergo laminate", not to "laminated board"), longest first.
- **At confirmation.** A delivery held before the conversion was known is converted when it is confirmed. A held delivery that still cannot be converted is **not** recorded number against number (that would log a false shortage): it goes back to waiting with a 409 and the same question. (My first version recorded it as before; I did not like that it contradicted the point of the feature.)
- **Stock** is added in the stock item's own unit (50 sqm delivered, stock kept in boxes: 20 boxes added).

**The property that matters.** Against `main`, **no existing recording changed or was removed**; 33 were added (12 for the spoken capture, 10 for spoken deliveries, 4 for confirmation, 7 for uploads including three document-versus-photo pairs). The table is created the first time it is needed, so there is no migration to run, and the test seeds create it with the same statement, which a test now compares with the code's.

**Verified:** typecheck unchanged; **3,103 checks** (about 230 new, including a normaliser table, the conversion maths against a real SQLite database, and the delivery check). **Eleven deliberate breakages were each caught:** the spoken path no longer unit-checking; **only the photo copy** no longer asking; recording no longer converting a held delivery; stock added in the delivery's unit; the confirm guard removed; **unrecognised units counted as different (too strict)**; an inverse conversion not inverted; a conversion and its opposite both allowed; a misread sentence able to create a customer; any role allowed to set one; and a substring match ("laminated"). Two of my own checks were wrong first: my new test looked for the case files relative to the source directory, which does not exist in a mutation copy, so every mutation run "crashed" until it used its own location; and one source-pattern guard had to change from "classify the extraction's lines" to "unit-check, then classify" on all three paths, which makes it stricter, not weaker.

**Honest limits, recorded in `OPEN_QUESTIONS.md`.** The reader that turns "a box of laminate is 2.2 square metres" into an item, two units and a number is a real language model and could not be run here; its prompt and example are in, but it needs one real try on the phone. **Stock usage and stock counts are not converted** (their readers carry no unit, so "used 3 boxes" of an item kept in sqm is recorded as 3 sqm). There is no screen or spoken way to list or delete conversions; saying it again changes one. And the recognised units are a fixed list.


---

## Decisions session, round 7 (part 1): dates in words; "Add to stock?" stays

Round 7, decided by Pierre: **13.** match supplier invoices across all open orders (built next, in its own change); **14.** teach the date reader the ordinal words; **15.** leave "Add to stock?" as one question per delivery.

**14. "The seventeenth" now schedules the 17th.** The date reader found no date in ordinal words at all, so the words were kept and nothing was scheduled (while "the 17th" always worked). The rule is **equivalence: an ordinal word means exactly its digit form**, so the existing day-of-month logic is reused unchanged: first to thirty-first, including the compound forms ("twenty-first", "twenty first", "thirty first"). One guard, because they are everyday words: **"first" and "second" count as a date only when they stand alone ("the first", "the second.") or are followed by "of" ("first of the month")**, never in front of another word, so "the first job", "a second coat" and "the second thing" are not dates, and "first thing Monday" is still Monday. A stronger word still wins ("the seventeenth tomorrow" is tomorrow), exactly as with digits.

**Verified:** typecheck unchanged; 3,131 checks. A property test checks **every day from the first to the thirty-first, in four phrasings each (124 phrasings), against its digit form**. Against `main`, **no existing recording changed**; four cases were added that run it through the real path: a date in words stored on a new job (the 17th), a compound ordinal (the 21st), "the first job" correctly storing **no** date, and an amendment confirmation moving a job from the 10th to the 17th. That the existing recordings did not move is itself informative: none of them showed a resolved date, so this path had not been pinned before. Five deliberate breakages were caught (ordinal words not read; "first" and "second" dates anywhere in a sentence; "first of the month" no longer a date; "twenty-first" reading as the 20th; and, in an earlier draft of my own check, "first of the month" without a leading "the", which the property test found).

**Found while doing it, recorded in `OPEN_QUESTIONS.md` and not changed:** the date reader ignores **month names**. "The 17th of November" is read as the 17th of the nearest month that has not passed, not as 17 November.

**15. "Add to stock?" stays as one question per delivery** (kept as it is).


---

## Decisions session, round 7 (part 2): supplier invoices matched across all open orders

Decided by Pierre: **13. match supplier invoices across all open orders**, as deliveries already are.

**The problem.** A supplier invoice was matched against the supplier's **latest order only**, so a bill that covered two orders, or the older of two, was checked against the wrong one (wrong quantities, wrong expected prices), while deliveries had long matched across every outstanding order, oldest first.

**What it does.**
- **Open means quantity not yet invoiced.** The candidates are the supplier's non-cancelled order lines with something not yet invoiced (what each line was ordered, less what earlier invoices billed against it), oldest order first. A cancelled order is never used.
- **Allocation is the same rule as for deliveries.** Each billed line fills the oldest order line that has the item, spills the rest into the next, and **anything billed beyond everything ordered stays on the last line it reached**, so over-billing still shows as a variance. Two billed lines of one item share the capacity. A billed line that is on no open order stays unmatched and does not widen the invoice.
- **One invoice, one expense.** An invoice that spans orders is recorded as **a single supplier invoice** (filed under the oldest order it touches) whose lines each name their own order line, so no schema change was needed. The reply says "Matched across orders #1 and #2."
- **When nothing has anything unbilled left** (every order already invoiced in full), the **latest order is used as before**, so nothing that worked is lost. Whether an upload is treated as an invoice or a delivery note still depends on the supplier having any order, exactly as before.
- **Single-order invoices are exactly as they were.** Explicit order-line ids are added **only when an invoice touches more than one order**, so the held payload of an ordinary invoice is byte-for-byte what it was (a mutation that adds them everywhere breaks 12 checks, including existing recordings).
- All three entry paths (spoken, document, photo) and the confirmation are covered; the invoice reader is shown each distinct item once, however many orders have it.

**One behaviour change to be aware of.** A supplier with the same item on two orders now has a small invoice matched to the **older** order, where it used to be the latest. That is the decision, but it is visible.

**The property that matters.** Against `main`, **no existing recording changed or was removed**; 15 were added (9 spoken, 3 confirmation, 3 uploads including a document-versus-photo pair and a real PDF). The spoken cases: an invoice spanning two orders; one that fits the oldest; the oldest already invoiced so the newer is used; everything invoiced so the latest is used; over-billing; an unmatched line beside matched ones; a cancelled order; two lines of one item sharing capacity; an accountant. Confirmation records, for a 70 bill, **one invoice of R12,950, one expense and a line against each order** (variances: 0 and −10 against what was ordered, +5 on price), and for a 100 bill, +20 over-billing against the last order.

**Verified:** typecheck unchanged; **3,217 checks** (about 66 new, including unit tests of the allocation, and of the pool against a real SQLite database: already-invoiced lines leave it, a part-invoiced line keeps only what is left, a cancelled order is out, and the fallback to the latest order). **Nine deliberate breakages were caught:** a cancelled order used; what is already invoiced ignored; no fallback to the latest order; explicit ids on every invoice; recording ignoring a line's own order line; the invoice filed under the newest order instead of the oldest; **only the spoken path** reverted to the latest order; **only the photo copy** reverted; and the note never shown. **My own unit test found a real bug first:** a zero-quantity line was filed under the newest order instead of the oldest, because the excess-goes-to-the-last-order rule applied when there was no excess.

**Not changed, recorded in `OPEN_QUESTIONS.md`:** nothing checks a supplier invoice's reference, so the same invoice said twice is recorded twice; and the invoice reader captures no unit, so an invoice in boxes against an order in square metres is matched number to number (the unit conversion built earlier applies to deliveries and stock, not to invoices).


---

## Decisions session, round 8 (part 1): month names in dates; the same invoice said twice

Round 8, decided by Pierre: **16.** say a supplier invoice is already recorded; **17.** read the month in a date; **18.** a spoken list and "forget" for unit conversions (built next, in its own change).

**17. A named month is read.** "The 17th of November" used to be read as the 17th of the nearest month that had not passed, with the month ignored. Now "the 17th of November", "November 17th", "17 nov", "nov. 17" and the ordinal words ("the seventeenth of November") all give that date, with every month in full and abbreviated. Rules: a month counts **only when it sits next to a day number**, so "I may do it Monday" and "we march on Friday" are not dates; a number that is a duration ("march 3 days from now") is not a day; the year is this year, or **next year when that date has already gone by** ("2 October" said on 3 October is 2027, "3 October" said on 3 October is today); a day the month does not have (31 November, 29 February in a common year) is **no date at all**, not the 1st of the next month; and an explicit day and month beat a weekday said beside them ("Thursday 17 November"). Phrases with no month are read exactly as before. A property test checks **every month, full and abbreviated, in both orders, for three days each (144 phrasings)**.

**16. The same supplier invoice said twice is not recorded twice.** An invoice whose reference is already **recorded** for that supplier, or already **waiting for confirmation**, is not recorded or held again, and the reply says so ("Invoice INV-7731 from Floornet is already recorded (R9250 on 2026-10-03), so nothing was recorded again", or "...already waiting for your confirmation (action #1)..."). References are compared ignoring case and extra spaces, **only for the same supplier** (two suppliers can both have an INV-001, and a case pins that), and an invoice with no reference stated cannot be checked and is held as before. It applies on all three paths (spoken, document, photo), and there is a **backstop at confirmation** for two copies that were held before this existed: the second is not recorded, goes back to waiting with the reason (409), and can be rejected.

**Verified:** typecheck unchanged; **3,294 checks**; against `main` **no existing recording changed or was removed** and 15 were added (three for the months, seven spoken duplicate cases, two confirmation cases, three uploads including a document-versus-photo pair and a real PDF). Eight deliberate breakages were caught: month names ignored; 31 November becoming 1 December; the duplicate check removed from the spoken path; **only the photo copy** holding a duplicate again; references compared case-sensitively; a reference counting as a duplicate across **all suppliers**; an invoice already waiting held again; and the confirmation backstop removed. **Two of my own mistakes were caught on the way:** my first month patch aborted on a wrong anchor and its spot-check then "failed" against the old code (nothing had been applied); and a confirmation recording showed a date taken from the database's real clock, which would have broken the next day, so that case now seeds its already-recorded invoice with an explicit date.

**Found while doing it, recorded and not changed:** the existing day-of-month reader takes the **first number it sees** as the day, so "5 pm on the 17th" is read as the 5th and "3 days from now" as the 3rd.


---

## Decisions session, round 8 (part 2): seeing and removing unit conversions

Decided by Pierre: **18. add a spoken list and "forget" for unit conversions.** (Parts 16 and 17, the duplicate supplier invoice and month names, are recorded above.)

**The problem.** A unit conversion could be said and replaced, but a wrong one could not be seen or removed, and nothing could say which were saved.

**What it does.**
- **The list** is a new lookup scope (`unit_conversions`): "what conversions do I have" or "how many square metres in a box of laminate". It is **answered in code, not paraphrased by a model**, so the list is always exact: "Unit conversions: 1 box of laminate = 2.2 sqm; 1 roll of underlay = 15 sqm." Asked about one material it shows that material's conversions and any whose name contains it (a conversion for "laminate" applies to "Quickstep laminate", so it is shown). With none it says how to save one. It needs materials access (a role without it is told the conversions exist but are restricted), and, like the price lookup, a customer on the screen is **not** borrowed as the subject of the question.
- **"Forget the laminate conversion"** is a new intent (`forget_unit_conversion`) that carries the material in `fact_value`, exactly as the price lookup does, and needs the same materials access as saving one. It is a direct write (a conversion is brought back by saying it again). **It removes exactly that item's conversion and never a looser match**: forgetting "laminate" does not touch "Quickstep laminate", and forgetting a name that is not saved deletes nothing and shows what is saved under similar names ("Say the name exactly to forget one"). With no material named it asks which. Once forgotten, a delivery of that item asks for the conversion again, as it did before one was saved. The opening step only finds, never creates, for this intent, so a material misread as a customer cannot create one.

**The property that matters.** Against `main`, **no existing recording changed**; 15 were added (7 lookup cases for the list, 8 for forget). The table is still created the first time it is needed; the lookup cases' seed table is compared with the code's, like the others.

**Verified:** typecheck unchanged; **3,376 checks**, including unit tests against a real SQLite database of listing in order, filtering both ways, exact-only forgetting, and the "once forgotten it asks again" behaviour. **Six deliberate breakages were caught:** forgetting that also forgets "Quickstep laminate" (a looser match); forgetting that reports success but deletes nothing; a role with no permissions able to list; any role able to forget; a misread forget sentence able to create a customer; and a customer on the screen borrowed as the subject of a conversions question. **My first attempt at the "looser match" mutation was wrong:** its search text assumed a multi-line query and silently did not apply, so the harness reported a survivor that was really an untested guard. It was redone against the real text and is now caught (including making the delete loose too).

**Not run here, and needs one real try on the phone:** the model that classifies "forget the laminate conversion" and "what conversions do I have". Their prompts describe the new intent and scope and give an example each, and the intent description says it is not "forget that", which discards the previous message, but a language model could not be run in this environment.


---

## Decisions session, round 9 (part 1): times are not days; two cosmetic faults

Round 9, decided by Pierre: **19.** apply the guard against times and durations everywhere; **20.** fix both cosmetic faults; **21.** convert stock usage and counts, asking when the unit is unknown (built next, in its own change).

**19. A time, a duration or an amount is never the day.** The plain day reader took the first number it saw, so "5 pm on the 17th" was the 5th and "3 days from now" the 3rd. A number is now skipped when it is a **time** ("5 pm", "5pm", "5:30", the 30 of "5:30", "5 o'clock"), a **duration** ("3 days", "2 weeks", "10 minutes") or an **amount of something** ("20 sqm", "2 boxes", any unit the unit table recognises). Of the numbers left, **one with an ordinal ending ("the 17th") wins over a bare one**, otherwise the first is taken exactly as before, so "3 rooms on the 17th" is the 17th. A phrase with none of these words reads exactly as it always did, and "in 3 days", "tomorrow" and "next week Monday" are unchanged (they are read first). "3 days from now" is now **no date** instead of the wrong date (supporting "N days from now" as a date was not asked for). **72 time phrasings** (every hour, six ways) are tested, plus durations, amounts with and without an ordinal ending, and the ordinal found wherever it falls.

**20. Two cosmetic faults.** (a) A role that cannot see the financial screens (no profit or debtors permission, the same rule as the screens' own data routes) used to be sent to an empty snapshot screen, or asked which of two screens it would like; it is now told "The financial overview exists for this business but is restricted for your role." Owner and accountant still open the screens. (b) "There are 1 quotations on file" and "There are 1 expenses on file" now read in the singular ("There is 1 quotation on file"). A scan of every count-then-plural-noun message in the code found no others that can read "1" (the order and project messages only appear when there are two or more).

**The property that matters.** Against `main`: of the existing recordings, **five changed and in every one the only difference is the plural wording** (checked mechanically), **one was renamed and re-recorded** (the installer's broad question, whose behaviour is the point of 20a), and the rest are identical. Eleven cases were added (eight for the screens and plurals, three for dates).

**Verified:** typecheck unchanged; **3,434 checks**. Six deliberate breakages were caught: an installer sent to the empty screen again; **too strict** (the accountant restricted from the screens); one quotation reading in the plural again; a time or duration read as the day again; and an amount read as the day again. **That last one first survived:** every amount case I had written also contained "the 17th", so the ordinal preference already picked the right number and the amount guard was never exercised; phrasings with no ordinal ending ("20 sqm on the 17") were added and it is now caught.


---

## Decisions session, round 9 (part 2): stock used or counted in another unit

Decided by Pierre: **21. convert stock usage and counts, asking when the unit is unknown.** (Parts 19 and 20, times not being read as days and the two cosmetic faults, are recorded above.)

**The problem.** "Used 3 boxes of laminate" for an item kept in square metres was recorded as 3 sqm, because the stock readers captured no unit. Deliveries already converted; this is the other half.

**What it does.** The usage and stocktake readers now also capture the **unit the quantity was said in**. When that is a recognised unit that differs from the unit the item is kept in:
- with a **conversion known** (either direction), the quantity is converted and the reply says so: "Recorded 6.6 used of Laminate — 33.4 remaining. (3 boxes of Laminate counted as 6.6 sqm.)"; a stocktake converts the count the same way and corrects the stock to it;
- with **no conversion known**, **nothing is recorded** and the reply asks once: "Laminate is kept in sqm but you said boxes, and I don't know how many sqm are in a box. Say, for example, 'a box of Laminate is 2.2 sqm' (with the real number). Then say it again."
A unit that was not said, or is not one the table recognises, passes through exactly as before, so an unfamiliar word can never block a count. Over-using after conversion still says the count looks off ("66 used… −26 remaining. That is more than the 40 on hand, so the count looks off."). Same rules and the same conversions as for deliveries, one shared check.

**The property that matters.** Against `main`, **no existing recording changed or was removed** (none of the existing scripted readings carries a unit); 11 cases were added: usage converted, usage with no conversion known, a conversion stored the other way round, the same unit spelled differently, an unrecognised unit, no unit said, an installer, over-using after conversion, and three for stocktakes.

**Verified:** typecheck unchanged; **3,485 checks**, including unit tests of the shared check (converted with its note, same unit another way, no unit, unrecognised unit, an item kept with no unit, the question's wording, a fraction of a box). **Four deliberate breakages were caught:** usage recording the number said instead of the converted amount; usage recording when no conversion is known instead of asking; a stocktake recording the number said; and the **too-strict** rule that treats an unrecognised or missing unit as different.

**Not run here, and needs one real try on the phone:** the language model that reads the sentence. Both prompts now ask for the unit and their examples show it ("used 5 bags of screed" gives "bags"), but a model could not be run in this environment, so "used 3 boxes of laminate" is unverified against the real reader.


---

## Decisions session, round 10 (part 1): statements, payments with no amount, jobs with no customer

Round 10, decided by Pierre: **22.** give spoken supplier statements a home; **23.** a payment with no amount asks how much and holds nothing; **24.** a job with no customer asks which customer.

**22. Supplier statements have a home, spoken or uploaded.** A spoken statement ("Floornet says we owe them R12,000") used to do nothing but say "Found existing: Floornet", and an *uploaded* statement was compared with the books and then forgotten. Now every statement is recorded in a `supplier_statements` table (created the first time it is needed, so no migration) with the supplier, what they claim, **what the books said at that moment**, the difference, where it came from (spoken, document or photo), what was said, and who. The spoken reply is the same as an uploaded one's, with a sentence about the difference: "Statement from Floornet: they claim R12000, our records show R11000. They claim R1000 more than our records." (or "less", or "That matches our records."). The **supplier must already be on file** (find-only, so a statement for a name nobody has heard of creates no supplier and says so), no supplier named asks which, and no balance stated asks "what do they say is owed?". Permission is unchanged: a role that may not check statements is refused. **The history can be asked for:** "what did Floornet claim we owe" (or "what have the suppliers claimed") is a new lookup scope, answered in code, newest first, five at a time, with the same permission. All three upload paths (document, image, photo) record, and a document-versus-photo pair pins that.

**23. A payment with no amount asks how much and holds nothing.** It used to be held for confirmation with the amount blank, so it could be confirmed without a number. Now: "I heard a payment from Jenny Smith, but no amount came through — how much was it?", the same as an invoice with no amount; an amount of zero is no amount. A payment of that kind that was **held before this change** can still be confirmed (a case seeds one to pin it).

**24. A job with no customer asks which customer.** A sentence with only an installer and/or a date, no customer, and no job or lead from the same capture to attach it to used to be recorded as a customer-less job, findable only by its installer or date. Now: "I heard a job with Sipho for next Monday, but no customer came through — which customer is it for? Nothing was recorded." It is decided **before the installer is resolved**, so a sentence that is only asked about creates no installer (a case with a newly named installer proves it). A scheduling sentence that belongs to the job or lead just before it in the same message still attaches, exactly as before (two existing cases pin that and did not change).

**The property that matters.** Against `main`: **two existing recordings changed** (the two uploaded statements, which now store a row and say what the difference means), **four were renamed and re-recorded** (each is precisely the behaviour decided above), **26 were added**, and every other recording is identical.

**Verified:** typecheck unchanged; **3,594 checks**, including unit tests of the statement helpers against a real SQLite database and a guard that the table the lookup cases create is exactly the table the code creates. **Eleven deliberate breakages were caught:** a spoken statement compared but not recorded; **only the photo copy** not recording; a statement for an unknown supplier able to create the supplier; the difference sentence the wrong way round; a role without the permission able to read the history; the history showing every supplier's statements when one was asked; a payment with no amount held again; a customer-less job recorded instead of asked about; a sentence that is only asked about still creating an installer; and a scheduling sentence that belongs to the previous job asked about instead of attached. **One of my own mutations first "survived" wrongly:** my helper replaces only the first occurrence of a text, and the find-only rule appears at two sites, so the second site was never mutated; it was redone at both and is caught.

**Not changed, recorded in `OPEN_QUESTIONS.md`:** a job with **measurements or tasks but no customer** is still recorded customer-less (only the installer-and-date-only case now asks). **Not run here, and needs one real try on the phone:** the language model that reads "Floornet says we owe them R12,000" (the statement description now says to put the stated balance in `amount`) and "what did Floornet claim we owe".


---

## Decisions session, round 11: sensitive details, one selection per person, the mislabelled installer message

Round 11, decided by Pierre: **25.** gate the sensitive person-detail keys; **26.** one current selection per person; **27.** fix the installer message labelled "invoice" now.

**25. Pay and bank details need their own permission.** A person's saved details (cell, address, licence and so on) were shown to every role, and `can_know_payroll` and `can_know_banking` were defined but checked nowhere. Now a detail whose **key** is a **payroll** word (day rate, daily/hourly rate, salary, wage, commission, bonus, per day...) needs `can_know_payroll`, and a **banking** one (bank, bank account, account number, IBAN, swift, branch code, sort code, card number, routing...) needs `can_know_banking`, **both to be read and to be saved**. The owner and accountant have both by default; an installer sees only the ordinary details, and an installer who says "Jabulani's day rate is R600 a day" is told "Nothing was saved: pay details like a day rate or salary can only be saved by someone with payroll access." and **nothing is held** (a role that could never read it back is not left to hold it). The key is matched in whole words, so **"account manager" and "payment terms" are not sensitive** and a cell number, address, licence or skill is shown as before; a key that reads as both counts as banking. The two permissions are no longer placeholders: they are **real switches in the Permissions room**, which now has **seven** (money, debtors, profit, materials, jobs, payroll, banking), and the grid's own guards were updated to say so. A free-text note that happens to mention a bank account is not covered (only a saved detail is): see `OPEN_QUESTIONS.md`.

**26. "Her", "him" and "forget that" are each person's own.** The current selection was one setting for the whole business (a leftover from when the app had one user), so one person's lookups changed what another person's "and her balance" meant and "forget that" cleared it for everyone. It is now **one selection per signed-in member**, in a `member_selections` table created the first time it is needed (no migration; the old shared table is left alone and **no longer read, so everyone's current selection starts empty after this deploy, by design**). The email is matched ignoring case and spaces; a caller with no known email shares one anonymous selection, apart from everyone else's. "Forget that" clears the person who said it and nobody else's. This reaches every place a selection is set (a customer, a supplier or installer, and the document just made), read, or cleared.

**27. An installer's scheduling message labelled "invoice" is read as the job it is.** It used to be refused outright as money. Now, when the label is "invoice" but there is **no amount** in it, the role may not record invoices, and the role **may** record jobs, it is processed as a job. **Anything with an amount stays refused.** Job recording is open to every role in this system, so even a role with no permissions gets this treatment; my first case for that role claimed it stayed refused, which was wrong, and is corrected.

**The property that matters.** Against `main`, of **589 existing cases 362 are identical**, **217 differ only by the selection table's name and the new person column** (checked mechanically: renaming the table back and dropping the column gives the old recording), **9 differ only by the two catalog entries** in the permission grid's listing, and **1 is a deliberate change of example** (the grid's "a permission nothing uses cannot be switched" case now uses `measurements`, the one that really is unused, instead of payroll, which now is). None was removed; **18 were added** (four for what each role is shown of a person's details, six for saving them, four for selections per person, four for the installer message).

**Verified:** typecheck unchanged; **3,734 checks**, including unit tests of the key classifier against 45 keys, of what each permission shows, and of selections per person against a real SQLite database (isolation, case-insensitive email, the anonymous bucket, only your own cleared, and the old table ignored), plus a guard that the seed table equals the code's. **Eight deliberate breakages were caught:** every detail shown again; a role able to save a pay or bank detail; a key rule so broad it hides the account manager; selections stored for nobody in particular; one person's "her" read from anyone's; "forget that" clearing everyone's; an invoice with an amount read as a job; and the mislabelled message refused as money again. **Mistakes of mine on the way, all caught:** my debug-route patch aborted on a wrong anchor (nothing written); the old selection seeds needed the new table; my selection test crashed on `null` instead of failing cleanly when a mutation deleted the other person's selection (now null-safe); one mutation was invalid twice because of a bind mismatch; and my first "stays refused" case was wrong.

**Not run here:** the language model that reads "Jabulani's day rate is R600" and the mislabelled scheduling message.


---

## Decisions session, round 12: every job needs a customer, notes keep out pay and bank sentences, invoice units

Round 12, decided by Pierre: **28.** ask which customer in every case; **29.** keep pay and bank details out of notes; **30.** capture the unit on supplier invoices and convert it.

**28. A job with no customer asks which customer, in every case.** Last round only the installer-and-date-only case asked; a job with measurements or tasks but no customer was still recorded customer-less. Now the rule is the one stated: *no customer named and nothing in the same message supplies one* asks "I heard a job (1 room measured, 1 task noted), but no customer came through — which customer is it for? Nothing was recorded." (the parenthesis only when something was measured or noted; installer and date are named as before). **What "supplies one" means:** for a measured room or a task, a **job already recorded earlier in the same capture that has a customer**: the second room in "Jenny, the lounge is 5 by 4. The kitchen is 3 by 3." takes Jenny, and both jobs are filed under her (a case pins it); for an installer or a date alone, a job or lead from the same capture to attach to (unchanged). With neither, it asks and records nothing, and creates no installer.

**29. A sentence that says a pay or bank detail is kept out of notes.** **Found while testing this, and it was a hole in my own round 11:** the four recordings from that round showed the sentence "Jabulani's day rate is R600 a day" being **copied into the person's free-text notes** (a KV write readable by every role) in addition to being held as a detail, so last round's gate could be walked around, and I had recorded the leak without noticing. Now a sentence that says a bank or pay detail (a bank account, account number, IBAN, swift code, branch or sort code, card number; a day, hourly or pay rate, salary, wages, payroll; or an amount per day, hour, week or month) is **not copied into notes** on any path (a customer's, a supplier's or installer's, or a life note), and the reply says so *only when the sentence went nowhere else*: "It looks like a pay or bank detail, so it was not kept in the notes. To save it, say it as a detail (for example "Sipho's day rate is R600 a day")." A saved detail, or a refusal with its own reason, says nothing extra. It looks at the sentence, not a key, so it is deliberately plain: "Jenny's account is overdue", "payment terms", "the swift delivery" and "R450 a square metre" are ordinary and kept (the detector first read "swift" on its own as a bank word and the unit test caught it). The words stay in the raw capture.

**30. A supplier invoice billed in another unit is converted, as deliveries and stock are.** The invoice reader now captures **the unit the quantity was billed in**. When it is a recognised unit that differs from the order's, with a conversion known (either direction), **the quantity and the price per unit both convert so the line total is unchanged**: 20 boxes at R462.50 are held as **50 sqm at R185** (R9,250 either way) and the reply says "(20 boxes of Vinyl counted as 50 sqm.)"; on confirmation the variances are computed in the order's unit (a price variance of +R5 against the expected R180, in the case). With **no conversion known, nothing is held** and the question is asked once ("Vinyl was ordered in sqm but this invoice is in boxes... Say, for example, 'a box of Vinyl is 2.2 sqm'... Then say the invoice again."). A unit that was not stated or not recognised, or the same unit spelled another way, passes through exactly as before. All three entry paths (spoken, document, photo), with a document-versus-photo pair and a real PDF; a line with no price converts its quantity and stays priceless (a price is never invented).

**The property that matters.** Against `main`, of 633 recordings, **601 existing cases are identical**, **4 changed**, **2 were renamed and re-recorded** and **26 were added**. The 4 are the round 11 detail cases, and in each the only difference is the leaked note that is now gone; the 2 are the measured-room-with-no-customer cases, which now ask, as decided. Every pre-existing invoice case is byte-identical (none of their scripted readings carries a unit).

**Verified:** typecheck unchanged; **3,888 checks**, including unit tests of the sentence detector against 35 sentences and of the invoice unit check against a real SQLite database (quantity and price, the inverse conversion, no conversion, unrecognised unit, no unit, no price, and the caller's own lines never modified). **Eight deliberate breakages were caught:** a second room losing the same-message customer; a measured room recorded customer-less again; a pay sentence copied into notes again; the redundant "not kept in notes" line on a saved detail; the **too-broad** detector (the bare word "account"); an invoice that converts the quantity but not the price (so the total changes); **only the spoken path**, and **only the photo copy**, holding an invoice in an unconvertible unit.

**Not run here:** the language model that now also reads the unit off an invoice ("20 boxes at 462.50") and the one that reads each sentence; both need one real try on the phone.


---

## Follow-up to round 12: a hole in the note guard, found by independent review

I reviewed round 12 the way I review every change I did not write: a fresh checkout (typecheck unchanged, 3,888 checks, deployed), then my own probes through the real code. Round 12's finding was right and worse than described: **my own round 11 recordings showed the refused sentence ("Jabulani's bank account is FNB 62012345678") being written to the person's notes while the reply said "Nothing was saved"**, and I had recorded it without reading the `effects` field, only the message. Round 12's fix closed it for a customer's note and a supplier's or installer's note, and my probes confirmed both.

**It left one path open.** The model's own `personal_note` field was written to the **life notes unconditionally**: "remember my account number is 62012345678" wrote `life:<date>` while the reply said "it was not kept in the notes", **a reply that contradicted what the system did**. The sentence detector only looked at what was said, on the transcript path, and the reply flag was computed from the transcript alone.

**Fix.** The same detector now guards the personal note on **both sides** (the note's own wording, and what was said), and the reply flag agrees with what was done, so the reply says a note was kept out exactly when it was. An ordinary life note ("buy diesel on Friday") is still kept.

**Verified:** typecheck unchanged; **3,908 checks**; against `main` **no existing recording changed** and 5 were added (a sensitive life note; one where only the note's own wording is sensitive; one where only what was said is; a day rate; and an ordinary one still kept). **Four deliberate breakages were caught:** the guard removed; only the note checked; only what was said checked; and the reply no longer telling the truth. My original probe (five sentences through the real code) now shows no notes written for the four sensitive ones and the two ordinary ones kept.

**What this says about my own process.** The leak was visible in recordings I had in front of me; I printed what I expected to see (the message and whether a hold existed) and not the field where the leak was. Reviews of recordings should read *every* recorded effect, not only the ones the change was about.


---

## Decisions session, round 13 (part 1): three finer permission switches

Round 13, decided by Pierre: **31.** add the three finer permission switches; **32.** add a spoken reopen for a cancelled order, held for confirmation (built next); **33.** leave the unit list as it is and add units as they turn up (nothing to build: recorded here).

**31. Expense totals, supplier balances and material prices are switches of their own.** One switch, "Money in and out", governed recording money *and* seeing quotations, expense totals and supplier balances, and the last price paid for a material was not gated at all. Now, in the Permissions room (which now has **ten** switches):
- **See expense totals** governs expense totals in answers ("what are we spending") and the expenses screen (which is also open to anyone with profit access, so taking only this away leaves the screen open through profit; taking both away closes it).
- **See what we owe suppliers** governs supplier balances in answers, the suppliers screen and the aged creditors report.
- **See material prices** governs "what did we last pay for vinyl".
"Money in and out" now means recording money and seeing quotations (its description says so).

**Nothing changes until you flip one.** The defaults are exactly who has each thing today: owner and accountant have all three; the installer has material prices only (which were open to everyone), and neither money view. **And so that a role you have ALREADY switched off cannot silently regain a view, expense totals and supplier balances FOLLOW "Money in and out" until set on their own:** a role switched off from money stays without both views, one given money gets both with it, and an explicit setting on either wins (so you can give an accountant expense totals without money in and out, or take expense totals away without touching money). Material prices do not follow money; they never were tied to it.

**A design bug, found by a recorded case and fixed.** The screen stores a setting only when it differs from the default, and switching something back to its default removes the setting. For a switch that follows another, comparing with the static default is wrong: with money taken away, switching expense totals **on** equalled the accountant's default (on), so it deleted the very setting meant to keep it on, and it fell straight back to following money (off). The case "money taken away but expense totals switched on" showed expenses still hidden. It now compares with what the switch would be if left alone (what money says), so the setting is stored; three grid cases pin it (stored when different, removed when the same, and cleared by a reset). My unit test had missed it because it inserted the override row directly instead of going through the screen.

**The property that matters.** Against `main`, of **636 existing cases, 627 are identical** and **9 differ only by the catalog listing** (the three new switches and one reworded description), checked mechanically. None was removed; **22 were added** (the effect of each switch alone; money taken away taking both views with it; an explicit setting winning; each route open and closed; material prices; the three grid cases), and 11 unit tests of the inheritance (defaults, a role switched off staying off, a role given money getting both, an explicit setting winning, one view on its own without money, the owner never overridden, and no overrides leaving the accountant exactly the default).

**Verified:** typecheck unchanged; **4,023 checks**. **Seven deliberate breakages were caught:** the new switches no longer following money (a role switched off silently regains them); the setPermission bug restored; expense totals in answers governed by money again; the suppliers screen governed by money again; material prices open to every role again; and the aged creditors report governed by money again. **That last one survived at first, and instructively:** my first attempt at cases for the report route recorded "this link is missing or has expired" even for the *control*, because that route needs a signed link, so five new cases looked like proof and proved nothing. They were removed, and the rule table is now checked directly.

**Not run here:** nothing in this change needs the language model, but the Permissions room itself (three new rows) has not been looked at on a phone; it lists whatever the server's catalog says, so it should simply show them.

## Decision 33: the recognised unit list stays as it is

Decided by Pierre 2026-10-04: **leave it; add units as they turn up.** A unit outside the list (a "bundle", a "pair") is still never converted and never flagged, by design, so it cannot block a delivery. Each unit added later risks a wrong match, so they are added one at a time when one is actually needed.


---

## Decisions session, round 13 (part 2): reopening a cancelled order

Decided by Pierre: **32. add a spoken reopen, held for confirmation.** (Parts 31 and 33 of the same round, the finer permission switches and the unit list, are recorded above.)

**What it does.** "Reopen the Floornet order" is the mirror of cancelling one: a **held action** that names the order and needs your confirmation ("Reopen Floornet order #1 Vinyl and underlay (50 sqm Vinyl, 100 sqm Underlay ordered, cancelled 2026-10-03)? Needs your confirmation (action #1) before it's reopened."). With one cancelled order it offers that one; with several it **never guesses**: it lists them and asks for a number ("reopen order 2"); a number that is not one of the cancelled orders lists the ones that are (an order that is still open is not offered); with none it says so. The supplier must already be on file (find-only, so a name nobody has heard of creates no supplier), and the permission is the same as cancelling it (invoicing), for the request and for the confirmation.

**On confirming:** the cancellation is removed, so the order is **outstanding again and a delivery matches it again**, and **the shortages the cancellation closed are open again**: "Reopened Floornet order #1. 1 shortage the cancellation had closed is open again." **Only those.** A shortage closed for another reason (a credit, an acceptance, a reason given) was resolved on its own account and stays resolved, even on the same order; the cancellation marked its own closures (resolution "cancelled", reason "order cancelled") and only those are undone. Confirming an order that was reopened in the meantime says it is already open and changes nothing. An order can be cancelled again after it was reopened.

**The property that matters.** Against `main`, **no existing recording changed or was removed**; 18 were added (eleven spoken, six confirmation including a **full round trip**, cancel, confirm, reopen, confirm, which removes the cancellation and restores exactly the shortage it had closed; and one showing a delivery matching a reopened order). 16 unit tests run against a real SQLite database cover the edges: a credited shortage staying resolved, a closure recorded by hand on the same order left alone, another supplier's orders never listed, an unknown order, idempotence, and cancelling again after reopening.

**Verified:** typecheck unchanged; **4,124 checks**. **Six deliberate breakages were caught:** reopening that also undoes closures the cancellation did not make; reopening that reports success but leaves the order cancelled; reopening that leaves the cancellation's shortages shut; the cancelled list showing every supplier's orders; a reopen able to create a supplier (the rule removed at **both** sites, the mistake my earlier mutation helper had made); and any role able to reopen. **One flaw of my own, caught on reading the recordings:** two messages said "cancelled 2026-10-05", a date taken from the database's real clock, which would have broken the next day; the cases now carry an explicit cancellation date, and the recordings were checked for any other real-clock date.

**Not run here:** the language model that reads "reopen the Floornet order" (its prompt describes the intent and gives an example, and says it is the opposite of cancelling), so it needs one real try on the phone, once with two cancelled orders.


---

## Found by the first real phone test: "...and schedule for the 17th"

Pierre typed, on the real app, "Invoice AGS Lewende Waters R3000 for carpet repair and schedule for the 17th". The invoice was held and a job was recorded, but **the 17th was lost**, with the reply "I don't have anything on file for that yet." Typing the same words again gave "I don't have that on file." instead. Three further runs isolated it: "Schedule AGS Lewende Waters for the 17th" on its own worked (it found the job and asked whether to update it); the same sentence with a comma instead of "and" worked (the date was saved, though the reply did not say so); and only the version with "and schedule" failed.

**Cause, from the code and the two different replies.** The message is split at "and" into two parts, and the second, "schedule for the 17th", has **no customer name**. The first reply can only come from a part with no customer that the model labelled as a quote conversion or a price request; the second can only come from the answering step, i.e. the model labelled **the very same fragment** as a question. **The real model read identical words two different ways**, which is exactly what the stand-in model used in all earlier tests cannot show, and why no earlier check could have caught it.

**Fix 1: decided in code, not by asking the model to be consistent.** A later part of the same message is a *scheduling continuation* only when **all** of these hold: it starts like an instruction (schedule, book, install, fit, start, plan, set, optionally after "and", "then", "also" or "please"); it is short (14 words or fewer); it names no customer or supplier and carries no amount; it has no money in it (a rand amount, "deposit", "invoice", "price", "paid"...); it is not a question; and it holds a date the date reader can read. Then it is read as scheduling whatever the model called it. **If an earlier part of the same message recorded a job, the date goes to that job** (the existing "attach to the job just recorded" step, with no question); **otherwise it is for the customer of the part before it** (so a customer who already has a job is still asked "update it, or a separate new job?"). A genuine question ("what is scheduled for the 17th?"), a part with money, a part that names its own customer, and a part with nothing before it to belong to are all left exactly as they were.

**Fix 2: the reply now says when a date was saved.** An invoice that also scheduled a job said nothing about the date, so there was no way to tell from the reply whether it had been kept: now "Job scope #75 also recorded — 1 task noted, scheduled for Sat 17 Oct." A job observation says the same, and a date attached to a job that already existed says "Job scope #1 **updated** — scheduled for Sat 17 Oct." instead of "recorded" (it was recorded already).

**The property that matters.** Against `main`, of **676 existing cases, 664 are identical** and **12 differ only by the added date wording or "updated"** (checked mechanically: stripping the clause and the word gives back the old recording, with the same database rows). None was removed; **14 were added**: the real failure reproduced with the fragment labelled four different ways (a price request, a question, a quote conversion, a note), a continuation after an invoice that recorded no job, one for a customer who already has a job, and the four cases where the rule must stay out of the way; plus four invoice cases in the exact shape of the third phone test. A further **70 unit tests** cover what the rule is and is not (10 phrasings x 6 labels, then 17 negatives).

**Verified:** typecheck unchanged; **4,260 checks**. **Eight deliberate breakages were caught:** the rule never applied (the original bug); money no longer stopping it; a question mark no longer stopping it; the date going to the customer instead of the job just recorded; a date attached to an existing job reported as a new record; and **an invoice that scheduled a job saying nothing about the date, which survived at first**: no case had an invoice with an amount plus a job with a date, which is exactly the shape of the phone test, so one was missing from the very test that found the bug. Four were added and it is caught.

**Not verified, and the one thing that matters:** this was reproduced with the model's mistake *scripted* four ways, because the real model cannot run here. **Please say the original sentence again on the real app after this deploys.** Expect two lines: the invoice waiting, and "Job scope #N updated — scheduled for Sat 17 Oct."

**Seen on the phone and not changed, recorded in `OPEN_QUESTIONS.md`:** every invoice sentence that mentions work **creates a new job**, even when the customer already has that job: the test sentences made three jobs (#73, #74 and #75) for one carpet repair. That is a design question, separate from this fix.


---

## Found by the second real phone test: the Suppliers screen did not know about cancellations

Pierre placed an order with a throwaway supplier on the real app, then said "Cancel the Zztest order". The cancel worked on the real model: it read the sentence correctly and held "Cancel Zztest Supplies order #10 Vinyl (50 sqm Vinyl not yet received)? Needs your confirmation". **But his screenshot of the Suppliers screen, taken before he confirmed, showed that order as "ORDERED, AWAITING DELIVERY", and on reading the code I could say before he tapped Confirm that it would stay that way.**

**The gap was mine.** The purchase-order list that feeds the Suppliers screen (and the admin list that shares its logic) worked out each order's status from deliveries and invoices only, and **never read the cancellations table**: not one mention of "cancel" in the file. When I built the cancel I made the money logic honour it (what is outstanding, which order an invoice is matched to, the shortages it closes) but never looked at the screen that lists orders. No test looked at that screen either, which is why a real screenshot found it.

**Fix.** Both lists now say **"cancelled"** for a cancelled order (whatever else has happened to it, so an order that was partly invoiced and then cancelled still reads cancelled) with `cancelledOn` the day, and an order that is reopened reads as before. Backend only: the app shows whatever status text it is given, so no rebuild is needed.

**Also fixed on the way.** The cancellation's timestamp came from the database's own clock, which the tests cannot hold still, so a case that cancelled through the app recorded the real day's date and would have broken the next morning. It now comes from the application clock (the same instant in production, and frozen in tests).

**The property that matters.** Against `main`, **no existing recording changed or was removed**; 7 were added (an open order, a cancelled one with its day, one **cancelled through the app** and one **cancelled then reopened** (the real sequences), one partly invoiced and cancelled, and the two admin-list cases).

**Verified:** typecheck unchanged; **4,289 checks**. **Three behaviour-only breakages were caught:** the Suppliers screen no longer finding an order's cancellation; the admin list likewise; and "closed" outranking "cancelled". **My first run of these mutations was meaningless, and I caught it:** an old source-pattern guard looked for the exact old `return { ...order, documentStatus, deliveryStatus, ...}` text, which my fix changed, so it failed on the *real* code as well, and the mutations reported "caught" only because that guard was already failing. I updated the guard, added one that requires both views to know about cancellations, and redid the mutations so they change behaviour and leave the text alone, which is the only way they prove anything.

**Not changed:** the screen's colour for the new status (it is whatever the app uses for a status it has not styled); look at it on the phone and tell me if it should be different.


---

## Found by the third phone test: "what open orders do we have", and an order said "for" instead of "from"

Pierre sent a screenshot of his history after a run of tests and pointed at two things.

**1. Nothing answered "what open orders do we have" / "what open supplier orders do we have?"** The question was read as a broad money question, and the reply asked "Did you want to see the full financial snapshot, or are you asking specifically about who owes you money?". The data was there (the Suppliers screen lists it) but nothing exposed it by voice. **Now a new lookup scope, `open_orders`, answers it in code**, from the same data and with the same permission as the Suppliers screen (invoicing; other roles are told it is restricted): "Open orders (2): Belgotex #103 Carpet (20 sqm Carpet not yet received); Floornet #101 Vinyl and underlay (50 sqm Vinyl, 100 sqm Underlay not yet received)." An order delivered in full or cancelled is not open, a part-delivered one shows only what is still due, a named supplier ("what are we waiting for from Belgotex") shows theirs only, and a long list shows eight and says how many more. A customer on the screen is not borrowed as the subject.

**2. "Order 10 boxes of laminate FOR zztest."** From the code: the classifier is told an order's supplier is who it is **from**, "never customer_name", and says nothing about "for"; **an order has no customer or job at all** (a supplier, a description and a date), so "for Jenny's job" has nowhere to be kept; and an order sentence was **not** protected from creating customers the way a lookup is, so a name the model read as a customer ("zztest") would have **created a customer called "zztest"**. Three changes: (a) **an order sentence can no longer create a customer** (a supplier named in an order may still be new, as before); (b) **when a name after "for" arrives instead of a supplier we ask rather than guess**, because an order is written straight away and a wrong guess would be a wrong order: if the name is a supplier we know, "I heard an order "for Zztest", but orders are placed from a supplier. Zztest Supplies is a supplier: did you mean "from Zztest Supplies"? Nothing was recorded."; if not, "…no supplier name came through, so nothing was recorded. Which supplier is it from?"; (c) **when an order IS recorded and a "for …" was also heard, the reply says that part was not kept** ("I heard "for Jenny Smith", but orders are not linked to a customer or job yet, so that part was not kept.").

**The property that matters.** Against `main`, **no existing recording changed or was removed**; 12 were added (seven for the open-orders lookup, five for orders said "for"), plus 13 unit tests of the open-orders query against a real database (cancelled, delivered in full, part-delivered, no supplier, another supplier, unknown supplier, the wording, the limit).

**Verified:** typecheck unchanged; **4,350 checks**. **Six deliberate breakages were caught:** a role without invoicing access able to list orders; a named supplier's question listing every supplier's; an order sentence able to create a customer again; the "did you mean from" suggestion removed; a recorded order saying nothing about a dropped "for"; and a customer on the screen borrowed as the subject. **A seed mistake of mine, caught by reading the output:** my first list showed only one supplier, because I had added line items to an order that exists in a *different* seed than the one I built on, so the lines pointed at nothing; I gave the seed its own order and the list then showed both suppliers.

**Not changed, and a decision for Pierre:** linking an order to a customer or job. Flooring orders are usually placed *for a job*, and it would give materials cost per job (the system already works out profitability per customer). The order table would need a link. Recorded in `OPEN_QUESTIONS.md`. **Also not changed:** the classifier's prompt about "for"; the code now handles both readings safely, so I left the prompt alone rather than change what the real model sees without being able to test it. And an order recorded with no line items is not "open" (nothing is outstanding on it); new orders always have lines, so this only affects old data.


---

## Found by the third phone test: a long reply was cut off and could not be scrolled

Pierre: the list of open orders "gives a couple of lines and then it cuts off", and it cannot be scrolled. **Cause, from the app code:** the reply is plain text in a `Stack` above the orb with no height limit and no scrolling, so a long reply is clipped to whatever room the screen gives it. Every long answer was affected, not only this list (the unit conversions, the statements history, a long customer answer).

**Fix (app only, one block, no server change).** The reply now takes at most the height it is given and **scrolls inside it**; a short reply is unchanged (the scroll view is only as tall as its content). It also covers the reply that carries Confirm and Reject. The change is one line replaced and fourteen added, a wrapper around the existing widget, checked for balanced brackets; the pending-confirmation widget was checked for flexible children (none), which would have broken inside a scroll view. **It cannot be compiled or run here: the web build in the pipeline is the compile check, and it needs a Codemagic rebuild and a look on the phone.** Whether it fits comfortably is a judgement about space on the real screen, so please look at the open-orders list and say if the scrolling area is too small or too large.


---

## Decision 52: an order placed FOR a customer is linked to that customer, and its cost counts against the job

Decided by Pierre (dictated, after the third phone test): link an order to a job, "so if it's order for Jenny from Floornet, it's a linked job, and then we can get a costing for that job as well."

**The system's own model made this simple.** In this system a *job*, for costing, **is the customer**: job profitability is the customer's invoices less the expenses carrying that customer's id, and `recordExpense` already takes a `customerId` documented as "which job this cost is FOR". So the order is linked to the **customer**, and the existing profit report picks the costs up with no new report.

**What it does.**
- **The link.** "Order 20 bags of adhesive from Floornet for Jenny Smith" records the order **and links it to Jenny Smith** ("Purchase order #1 recorded for Floornet — 1 item(s), for Jenny Smith's job."). The customer is found by name only: an order never creates one. If the name after "for" is not a customer, the order is still recorded, not linked, and the reply says so ("I heard "for Nobody Known", but that isn't a customer I have, so the order isn't linked to a job."). The link is its own small table, created the first time it is needed (no migration); an order with no link is exactly what it always was.
- **The cost.** When the supplier's invoice for that order is confirmed, **its expense carries the customer**, so it appears in "costs linked to this job". **A credit for a shortage on that order reduces the same job's cost** (a negative expense for the same customer).
- **Never a guess.** An invoice that spans several orders is put on a customer only if **every** order is linked and **all to the same customer**. A mix of linked and unlinked orders, or orders for two different customers, is attributed to **no** job: a guess would put a cost on the wrong job.
- **The costing line.** A job's profitability now adds the cost still to come: "Revenue R5000, costs linked to this job R1200, profit R3800. **Ordered for this job and not yet invoiced: R3600 plus 1 unpriced line (2 orders).**" (quantity times the expected price where one is known, and a count of lines with no price). A cancelled order and an order already invoiced (its cost arrives as an expense instead) are not counted; another customer's orders never are. A customer with only an order placed for them, and no invoice or expense yet, still gets a costing.
- **The open-orders list** says who each order is for: "Floornet #201 Vinyl (10 sqm Vinyl, 4 sqm Underlay not yet received) for Jenny Smith".

**Also from the same phone test.** What happened to "order 10 boxes of laminate for zztest": the real model read the name as the supplier and the order was recorded for Zztest Supplies, so the new "did you mean from?" question (which applies when the name arrives as a customer) did not need to fire; Pierre was happy with that. And the long-reply scrolling fix is recorded above; its web build compiled.

**The property that matters.** Against `main`, **no existing recording changed**; two were renamed (my own cases from the previous change, which now link instead of reporting "not kept"); **12 were added** (six for the cost attribution, including the three never-a-guess cases and the credit; two spoken; four for the costing and the open-orders list), plus 22 unit tests against a real database (who a cost is for, the costing line, and a guard that the seed table equals the code's).

**Verified:** typecheck unchanged; **4,409 checks**. **Eight deliberate breakages were caught:** an invoice's cost no longer put on the order's customer; a credit no longer reducing it; a linked-plus-unlinked invoice put on the linked customer; an invoice across two customers put on the first; a spoken order no longer linking; a cancelled order still counted as cost to come; an invoiced order still counted; and the open-orders list not saying who an order is for.

**Limits, stated plainly.** **The link is to the customer, not to one of their jobs:** a customer with several jobs gets all their orders on one costing, because that is how this system defines a job for costing. If you want costing per job within a customer, that needs a different link and is a bigger change. **The cost is attributed when the supplier's invoice is confirmed**, so an order that has not been invoiced shows only as "ordered, not yet invoiced". An order placed before this change has no link (they cannot be guessed); an existing order cannot be linked afterwards by voice yet. The language model's reading of "for Jenny" is unverified on the real model, though the code is safe against either reading.


---

## Decision 50: the same work said again makes no new job

Decided by Pierre (the opposite of my recommendation, which was to ask): **link quietly.** Seen on the phone: saying "invoice AGS Lewende Waters R3000 for carpet repair" three times made jobs #73, #74 and #75 for one repair, and a fourth (#76) on the next test.

**What the code showed.** The held invoice carries **no link to a job at all** (just the customer, the amount and the words), so the duplicates came from the **job part** of the sentence, which always recorded a new job.

**What it does now.** When the work in an invoice sentence is **the same work as a job the customer already has open, no new job is created**, and the reply says which: "Invoice noted for Jenny Smith of R3000 — needs your confirmation (action #1) before it's recorded. This is the same work as job #1 ("carpet repair"), so no new job was created." Three precise rules keep it from over-reaching:
- **Same work** means the same words in any order, ignoring case, punctuation and small words ("the", "of", "for"...): "repair of the carpet" matches "carpet repair"; "carpet repairs" or "curtain fitting" do not (no guessing at plurals or meaning).
- **Open** uses the system's own meaning of an open project: a job whose project is **paid in full is closed** and is not matched (a repair a year later makes a new job). A job not in any project is open. The most recent match wins; another customer's jobs are never considered.
- **Tasks only, never measurements.** A sentence with measurements is new detail and still makes a job: silently dropping a re-measure would be worse than a duplicate.

**A date or installer in the same sentence is not applied quietly.** "Invoice Jenny R3000 for carpet repair, install on the 17th" for a customer with that job now asks the usual question ("Job #1 ("carpet repair") — update it, or create this as a separate new job?") with the invoice waiting, and creates no new job. So the one thing that could be changed behind your back (a date) still asks.

**The property that matters.** Against `main`, **no existing recording changed or was removed**; 7 were added (the same work; the same work in other words; different work; the same words with measurements; the same work with a date; a closed job; and no amount), plus 9 unit tests against a real database (the matching, the closed project, another customer, measurements, placeholders).

**Verified:** typecheck unchanged; **4,449 checks**. **Four deliberate breakages were caught:** the same work making a new job again (the original problem); a sentence with measurements matched to an old job; a job in a paid-in-full project matched as open; and a date applied by recording a job instead of asking about the existing one.

**Not changed, and stated plainly:** the invoice itself is still not linked to a job (it never was); only the duplicate is removed. If you want an invoice tied to its job, that is a separate change. Existing duplicates (#73 to #76) are not merged. And the language model's reading of the sentence's work description is unverified on the real model: the matching depends on it producing the same words twice, which a plainly worded repeat should; a differently worded repeat will make a new job.
