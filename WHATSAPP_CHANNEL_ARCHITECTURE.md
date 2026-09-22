# WhatsApp Channel Architecture — A Real Vehicle, Not a Speculative One

Pinned the same way `CORE_SUBSTRATE_ARCHITECTURE.md` was: before anything gets built
on it, so the reasoning that got here is on record, not just the conclusion.
Different from most of what's pinned so far — this one is scoped from the
start as a real vehicle being pursued, not an exploration.

---

## The real framing this sits under

`CORE_SUBSTRATE_ARCHITECTURE.md` drew a line between the six proven,
domain-agnostic mechanisms this project is actually built on, and anything
vertical-specific that shouldn't be pre-built ahead of real evidence.
WhatsApp is a genuinely clean test of that line, and it passes: this is not
a new vertical. It's a new **channel** for the same one. The vocabulary
stays (customer, job scope, quotation). The consequence-weighting stays
(`guard()` gates a write the same way regardless of where the words came
from). What's new is only the door the words come through.

## Architecture — how it plugs in

- **No separate app or widget system.** WhatsApp gives text, buttons, and
  lists — nothing else. The entire mechanism is **phone-number-based
  identity**: the sender's number on an incoming message *is* the
  permission check, resolved before anything else happens.
- **One WhatsApp Business number per tenant**, tied to their own WABA. A
  message arrives at the webhook → look up the sender's number → branch:
  - **Owner/membership number** → the full, real pipeline already
    proven tonight — the same `extractIntent` → `guard()` → pending-action
    flow the Flutter app already uses, unchanged.
  - **Known customer number** → a scoped, limited session — sees only
    their own quotes, invoices, and job status, nothing else in the
    schema.
  - **Unrecognized number** → a new lead, flowing into the existing
    quotation/lead machinery already built and confirmed tonight.
- Reuses the existing phone-number normalization already in the identity
  layer (`libphonenumber-js`) — no new normalization logic to write.
- Photos and voice notes arrive as a different payload type on the same
  webhook (Meta gives a fetchable media URL) and flow into whatever
  document/receipt processing already exists.

## The customer-facing door — the genuinely bigger, separate feature

Distinct from the owner using WhatsApp as just another client: this is a
business's **own customers** — texting the business's number and getting
served directly, no owner in the loop for the read side.

- Needs a real, new grant/session type — not a full membership, a scoped
  **customer session**, matched by phone number against `customer_facts`,
  capability-limited to read-only access to *their own* records.
- `guard()` still applies to every write. Nothing an external customer
  says auto-executes; it becomes a real `pending_actions` entry the
  owner confirms, the same discipline already proven for everything
  else tonight.
- **This is the piece that deserves the same rigor already given to
  text-based identity resolution, not less.** Once an external,
  unauthenticated phone number can create a real `pending_actions` entry
  in a real business's system, that's a genuinely different trust
  boundary than anything built so far — worth treating with
  `reconcilePerson`'s own level of seriousness, not assumed safe merely
  because `guard()` sits in front of the eventual write.
- This is the version that's genuinely closer to real customer support —
  grounded in live operational data, not a generic knowledge base — and
  the real differentiator against Zendesk/Intercom-style bots.

## A real, undesigned gap: the confirmation UX itself

The backend reuse is real and mostly free. The interface is not.
Everything built tonight for the pending-confirmation experience — the
Orb reacting, gesture grading by real stakes, tap-to-edit a specific
field — has no equivalent inside a WhatsApp thread, because WhatsApp only
gives text, buttons, and lists. A pending confirmation over WhatsApp needs
its own real design, closer to "reply YES to confirm" than to anything
built so far. Not solved by this document — named so it doesn't get
silently assumed away by "no new logic required."

## Why Meta's official Cloud API, not Evolution API/Baileys

Evolution API impersonates a real WhatsApp Web session — unofficial, a
real ToS violation, real ban risk that scales with usage. Not viable for
real paying clients. Meta's Cloud API is the sanctioned, official path —
no BSP (Business Solution Provider) required since Cloud API's release;
`graph.facebook.com` is called directly.

## Business verification — what Meta actually checks

Not the code, not the app, not a pitch deck — purely legal business
legitimacy. Business Info in Meta Business Manager (name, address, phone,
email, website) matched against 2–3 real supporting documents (Certificate
of Incorporation, Business License, Utility Bill). Invoices, tax returns,
and website screenshots are explicitly rejected as proof. Typically 1–14
business days; changing Business Manager info mid-review restarts the
process. One-time, covers the whole Business Manager going forward — not
redone per client. Template messages (anything outside a live 24-hour
window) get separately, individually reviewed by Meta on an ongoing basis.

## Costs — checked directly, and one real correction to the working model

**Confirmed real and correctly dated:** Meta ends free customer-service
replies from **1 October 2026** — verified directly against multiple
current sources, not taken on faith. New rates from that date: utility
and service messages priced per delivered message at the recipient
country's rate; marketing priced separately and higher.

**The real correction:** every source checked also states a **1,000 free
service messages per business phone number per month** threshold that
survives October 1 — this was missing from the original cost estimate. Given
the architecture already calls for **one number per tenant**, and the
realistic estimate is 50–300 outbound messages/tenant/month, most tenants
would likely stay entirely inside that free tier and pay close to
**nothing**, not the ~R6–36/tenant/month figure the original estimate
carried. Worth re-running the pricing model with the free tier included
before this number becomes load-bearing anywhere real (a pricing page, a
client quote). Even in the worst case where the free tier is exceeded, the
prior R6–36/tenant/month figure (roughly 1–5% of blended revenue) still
holds as a ceiling, not a floor.

Design implication either way: since charging is now per-message rather
than gated purely by the 24-hour window, this still favors **concise,
batched replies** over chatty back-and-forth — cheaper, and consistent
with the zero-fluff preference already in place elsewhere in this project.

## Policy — what's actually restricted, and what isn't

- **The January 15, 2026 "AI Providers" rule** (the one that ended
  ChatGPT-on-WhatsApp) bars AI access from being the primary
  functionality of what's offered on WhatsApp. **Doesn't apply here** —
  The Office is a business using AI internally to run its own
  operations, not an AI company reselling chat access as the product.
  Meta confirmed directly to TechCrunch that a business running its own
  support bot for its own customers remains fully permitted.
- **The one hard, surviving restriction:** WhatsApp Business Data can
  never be pooled or used to train or improve a model beyond that one
  client's exclusive use — no cross-tenant training, ever. Already
  consistent with the existing tenant-isolation architecture (separate
  D1 per tenant).
- **Directing customers to your own app:** no explicit rule against it.
  The real reason to be sparing about it is product logic, not policy —
  pushing customers off WhatsApp undermines the reason WhatsApp was the
  right channel to begin with.
- **Real, local precedent:** Absa ChatBanking, live since July 2018,
  reportedly the world's first bank to fully launch WhatsApp banking,
  same number-as-identity architecture, still running today. Real
  evidence this pattern is proven at real scale in this exact market,
  not just theoretically permitted.
- **The one honest, ongoing risk worth naming plainly, not as a
  footnote:** this policy landscape has already moved twice within the
  span this research covers — the January AI-provider rule, then this
  October pricing restructure. Building a core distribution channel on
  a platform whose rules move this fast isn't a reason not to pursue
  it, but it's a real, standing dependency to carry explicitly, not
  something to treat as settled once and forgotten.

## White-labeling / reselling

**Version 1 — each client's own branded instance.** Already inherent to
the multi-tenant architecture; their customers never see "The Office,"
only their own business's name, number, and logo. True at the code
level. **Not free at the operations level** — each client still needs
their own real Meta Business verification, their own number, their own
WABA. Real, recurring, per-tenant human friction, even with zero new
code required.

**Version 2 — a reseller/partner channel.** A genuinely separate, later
decision. Compatible with "no partners, ever" since a reseller is a
customer/contract relationship, not equity. Open, unresolved question:
whether resellers need their own Meta Tech Provider status or can onboard
through the primary one — to be confirmed directly with Meta when this is
actually pursued, not assumed now.

## Rate limits — two distinct kinds, often conflated

**1. Tech Provider onboarding limit** (new client businesses signed up):

| Status | New businesses / rolling 7 days |
|---|---|
| Default | 10 |
| After Business Verification + App Review + Access Verification | 200, automatic |
| Beyond 200/week | Apply for Meta Business Partner status |

At 200/week this is functionally not a constraint at any realistically
planned growth rate.

**2. Messaging tier limit** (per-tenant daily send volume — only counts
messages sent *outside* an already-open 24-hour conversation; replies
within an open window aren't limited by this axis):

| Tier | Unique customers/24hr |
|---|---|
| Unverified | 250 |
| Verified (immediate) | 2,000 |
| Automatic scaling | 10,000 → 100,000 → Unlimited |

Gated on quality rating (Green/Yellow/Red) and ≥50% of current limit used
over 7 days, checked roughly every 6 hours. Scoped per Business Portfolio
— each client owns their own portfolio, so one tenant's growth never
crowds another's capacity. Throughput (messages/second) is a separate
axis, ~80 MPS standard up to 1,000 MPS at Unlimited — irrelevant at
current scale.

## Infrastructure — Durable Objects, D1, and Queues

- **D1 stays the real data store.** Per-tenant sizing is essentially a
  non-issue — even generous estimates put a single tenant at 100+ years
  before D1's 10 GB per-database cap.
- **Account-wide storage** is the more real, though still distant,
  ceiling — roughly 500–2,000 tenants before Cloudflare's total account
  storage limit becomes relevant, and even that's raisable by request,
  not a hard wall.
- **Durable Objects** would sit as a thin, single-tenant gatekeeper in
  front of D1 — not a replacement — solving write *ordering* (two
  near-simultaneous messages from one customer racing each other), not
  storage or rate limits. Correctly scoped as something to introduce
  **when real evidence of concurrent-write collisions shows up**, not
  preemptively — the same "build only what's earned by real usage"
  discipline `CORE_SUBSTRATE_ARCHITECTURE.md` already commits to. Fully
  incremental to add later (no data migration — a DO just changes which
  function routes a tenant's writes); pilot on one real tenant (Zululand,
  most likely) before any wider rollout.
- **Queues solve a different problem — decoupling, not ordering.**
  Recommended at webhook launch itself, not deferred, because Meta
  expects a fast ack on incoming webhook events: the webhook validates
  and pushes to a Queue, returns 200 immediately, a separate consumer
  does the real `extractIntent`/`guard()` work. The existing
  `pending_memory_flush` + hourly cron pattern in `memory.ts` is already
  an informal, hand-rolled version of this same idea — real Queues add
  automatic retries and dead-letter handling a hand-rolled table doesn't
  get for free.

## What this document does not settle

- The real confirmation UX for a pending action reached over WhatsApp —
  named as a real gap above, not designed here.
- The real security model for the customer-facing door beyond "treat it
  with `reconcilePerson`'s own seriousness" — the actual mechanism still
  needs the same kind of evidence-driven design pass everything else in
  this project has gotten.
- Whether resellers need their own Meta Tech Provider status — an open
  question for Meta directly, not resolved here.
- The exact, current South African Rand rate card — the per-message
  pricing structure and the free-tier threshold are confirmed directly;
  the specific R0.12/R0.62 figures in the original estimate were not
  independently re-verified against a current, SA-specific rate card in
  this pass, and should be checked again closer to actual launch, since
  Meta's own documentation is the source of truth for exact regional
  rates, not any third-party summary.
