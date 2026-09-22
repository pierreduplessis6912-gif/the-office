# Onboarding Journey — Welcome, Guided Setup, and Showing Off What's Real

Pinned the same way `WHATSAPP_CHANNEL_ARCHITECTURE.md` and
`SECURITY_AND_OPERATIONAL_READINESS.md` were — a real design, scoped before
any of it gets built, not an exploration.

**The one thing worth saying before anything else in this document:** this
describes the journey for a genuinely new, separate business joining The
Office. That implies real tenant isolation, which doesn't exist yet. This
document is safe to design and even partially build now — but actually
onboarding a second real business still depends on the multi-tenant auth
work already tracked in `SECURITY_AND_OPERATIONAL_READINESS.md`. Scoping
this now is the same move as pinning the WhatsApp channel before Meta
verification was underway — real design work that doesn't need to wait for
its own prerequisite to be finished first.

---

## The real premise

A new owner can start talking to The Office with nothing set up at all —
that already works, today, for anyone. But the actual value of this system
is that it becomes *their* business's memory, not a generic assistant. The
whole point of onboarding is closing that gap deliberately, rather than
hoping someone stumbles into it after a few weeks of unprompted use.

## The journey

**1. Welcome moment.** Right now, first launch drops straight into the cold
"TAP OR HOLD TO SPEAK" orb, no introduction at all. The real, honest framing
to set immediately: *you can talk to me right now, with nothing set up — but
the real value comes from your own data being in here.*

**2. A guided tour — each step a real action, and a real "do it later," never
a wall.**

- **Business Profile** — name, VAT, address, logo. Fully real, built
  tonight. The tour only needs to point at it.
- **Import your customers** — real, already proven (`reconcileCustomer`-based
  CSV import, deterministic header-alias matching).
- **Import your historical invoices** — real, but with a genuine limitation
  worth naming honestly rather than glossing over: today it's hard-coded to
  one specific prior tool's export format (literally built for migrating off
  "Invoice Simple," the tool Zululand itself switched from — expects
  columns named exactly "Invoice," "Client," "Total," "Balance due"). A
  general onboarding flow can't assume every new business used that same
  tool. **Real, concrete gap:** this needs the same deterministic
  header-alias matching the customer import already has, not a fixed
  column list.
- **Add your team** — installers, staff. **Real, confirmed gap:** no bulk
  import exists at all, only one at a time by voice. Painful for someone
  starting with five installers on day one.
- **Add your suppliers** — same real gap, since suppliers are stored as
  characters.
- **Seed your common products/materials** — the entity built tonight, and
  also a real gap: today a product is only ever created the moment it's
  first mentioned in a real quotation or purchase order. No way to
  pre-load "we mostly work with vinyl, carpet tile, and screed" up front.

**3. Real persistence for "do it later."** If skipping a step is genuine,
something real has to remember what's still outstanding, or "later" quietly
becomes "never." A small, real `onboarding_progress` record per tenant,
surfaced as a gentle, resumable reminder — in the drawer, most likely — not
a nag, not a blocking modal.

**4. The always-open door.** None of this ever gates voice. Talking to it
already works regardless of onboarding state; the tour is additive on top
of that, never a prerequisite for it.

## The showcase layer — three real categories, each needing a different trigger

This is the more important half, honestly — the difference between someone
discovering months of real, built capability by accident (or never) and
being shown it deliberately, at the moment it actually lands.

**Category 1 — works immediately, zero existing data. Real "try this right
now" moments, safe on day one:**

- *"Try saying: 'Quote [any name] R500 for general repairs.'"* — the whole
  core loop in one sentence: real capture, real hold, real confirmation.
- *"Try: 'Order 50 square meters of vinyl from [any supplier].'"* — the
  buy side working as naturally as the sell side.
- *"Ask: 'What's my cash position?'"* — genuinely striking specifically
  *because* the numbers are all zero on day one. A real, honest dashboard
  opening with real (if empty) figures proves the number is computed, not
  decorated.
- *"Say: 'Forget that, never mind'"* after any pending confirmation — a
  small, real, working piece of `forget_last`, worth surfacing on its own.

**Category 2 — milestone-triggered, surfaced only once genuinely relevant.**
Showing these on day one would be showing an empty room:

- After the first quotation is confirmed → *"You can also just photograph a
  written quote and it'll capture it the same way."*
- After the first invoice → *"You can ask for a Statement of Account for any
  customer, any time."*
- The second time the same product gets mentioned with different wording
  (a real, already-proven moment — tonight's own smoke test: "vinyl" then
  "vinyl flooring") → *"The Office just recognized 'vinyl flooring' as the
  same product as 'vinyl' — you'll never have to word it consistently."*
- The first real snag or lead created → a one-line pointer to that room in
  the drawer — these are exactly the six domains that were invisible until
  tonight's discoverability pass.

**Category 3 — the identity-resolution matching itself, genuinely the most
impressive thing built, and the hardest to demo honestly.** This can't
happen organically on a fresh account — there's nothing yet to be ambiguous
*about*. Rather than fake it with seeded data, the honest move is a real,
**explicitly-labeled, opt-in scripted walkthrough** — never presented as the
owner's own real data. A short guided two-message script (a mock "Sipho,"
then "Sipo") showing the real picker actually fire, clearly framed as a
demonstration. Honesty matters specifically here — faking this one would
undermine the actual trust the rest of the system depends on.

## The one real design decision this scoping surfaced

The onboarding checklist and the milestone "did you know" callouts are not
two separate systems. They're one real, resumable list — the same
underlying steps, with two different triggers for when an item gets shown:
some at the start, on request; some the moment real behavior makes them
land. Building these as two disconnected mechanisms would be real,
avoidable duplication.

## What this document does not settle

- The real multi-tenant auth prerequisite this whole journey depends on for
  an actual second business — tracked in
  `SECURITY_AND_OPERATIONAL_READINESS.md`, not solved here.
- The exact real schema for `onboarding_progress` — a real, later design
  pass, not decided in this document.
- Whether the Category 3 scripted demo ships as a fixed, hand-written
  script or something more dynamic — real, deliberately left open until
  there's a reason to prefer one over the other.
- The precise wording and visual treatment of every "did you know" moment —
  real content work, not architecture, left for whenever this actually gets
  built.
