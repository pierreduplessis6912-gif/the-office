> **Status:** real. **Verified:** not yet. **Owns:** none.

# DECISIONS: strategy-and-philosophy

Part of [DECISIONS.md](../../DECISIONS.md), split from it on 2026-10-24 without changing a word (the original is `git show 95bf743:DECISIONS.md`). Sections keep their original order.

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
