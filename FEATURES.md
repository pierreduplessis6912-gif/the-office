# The Office — Features, by Department (a lens, not a wall)

This document exists for one purpose: to make the whole system legible
at a glance, organized the way a flooring contractor would naturally
think about their own business — customers, quotations, jobs, money,
people, paperwork. **This is explicitly a lens for reading this
document, not a claim about internal architecture.** Constitution
Principle 27 ("A Network, Not Modules") is the real rule the code
follows — Sipho exists simultaneously as a character, an installer, a
job's assigned worker, and a conversation participant, never siloed
into one department's exclusive concern. The groupings below exist so
a reader — new to the project, or a real future user — can find "where
does X live" quickly. They are not walls between systems, and nothing
in the actual code enforces them as walls either.

Every input example below is either a real phrase actually tested this
project, or phrased in the exact same natural style as one that was.
Every output is grounded in what the current, real code actually does
— verified against `STATUS.md`, `DECISIONS.md`, and the live routes,
not invented for this document.

---

## Customers

**What it is:** the record of who Peter does business with. Every
other department that touches money or a job hangs off a real customer
record.

**Inputs:**
- Any message naming a customer, in any context — "Jenny paid R500,"
  "quote for Thabo," "measured Nomvula's lounge." A name is never
  entered on its own; it's recognized as a byproduct of the real thing
  being said.

**Outputs:**
- A real, reconciled customer record — created automatically the first
  time a name is mentioned (`matched: false`), or matched to an
  existing one (`matched: true`). Never asked to be manually created.
- Everything else in this document (a quotation, an invoice, a job, a
  note) attaches to this record, permanently.

---

## Quotations & Pricing

**What it is:** what Peter is proposing to charge, before any money
has moved.

**Inputs:**
- A flat quote: *"Quote for Jenny — carpet fitting for R8000, give her
  10 percent off that."*
- Pricing tied to a real measurement: *"Measured Jenny's lounge at
  thirty square meters, we'll fit vinyl at three hundred rand a square
  meter"* — the pricing attaches to the job's real, just-computed area,
  not a separately-stated number.
- A rate stated for something already measured earlier, in a separate
  message.

**Outputs:**
- A real, held-for-confirmation quotation — Peter always sees the
  total before anything is recorded ("Quotation noted for Jenny of
  R7,200 — needs your confirmation").
- Once confirmed: a real quotation record, a generated PDF, and a
  ready-to-send message ("Hi Jenny, here's your quote — R7,200. View it
  here: [pdf link]").
- All arithmetic (rate × area, discount applied) computed in code,
  never asked of the model — a stated number is only ever transcribed,
  never calculated.

---

## Invoicing & Payments

**What it is:** real money, moving. The one place in the whole system
where every write requires deliberate confirmation and a real
capability (`can_manage_invoices`) to even attempt.

**Inputs:**
- A direct invoice: *"Invoice Jenny for R3200."*
- Converting an existing quote: *"Convert Jenny's latest quote to an
  invoice."*
- A payment: *"Jenny paid R500."*

**Outputs:**
- A held, confirmable action for every one of these — never written
  directly.
- Once confirmed: a real invoice or payment record, a generated PDF (for
  invoices), and a ready-to-send message.
- An Installer or anyone without `can_manage_invoices` gets an honest,
  immediate refusal instead — *"Recording payments, invoices,
  quotations, or expenses isn't available for your role."*

---

## Job Scopes & Work Observations

**What it is:** what's actually being measured and done — the real,
physical shape of the job, independent of price.

**Inputs:**
- *"I measured the reception area at 6600 by 4100, we also need repair
  work and screeding."*
- A directly-stated total, no width/length breakdown: *"We are looking
  at around a hundred and sixty square meters of carpet tile."*
- An installer assignment: *"Sipho is doing Jenny's install next
  Thursday."*

**Outputs:**
- A real job scope record — components (with real, computed area,
  whether from width×length or a direct total), tasks, and an assigned
  installer (reconciled as a real character, not invented).
- No confirmation gate — a measurement is a cheap, easily corrected
  mistake, unlike money. `guard()` is reserved for consequence.

---

## Expenses

**What it is:** what the business spent.

**Inputs:**
- *"Bought glue for R850 at BUCO."*
- An expense tied to a specific job, for real job-costing later.

**Outputs:**
- A held, confirmable expense action, same as any other financial
  write — gated by `can_manage_invoices`.
- Feeds directly into Financial Reporting below (Cost of Sales,
  Operating Expenses, per-job profitability).

---

## Financial Reporting

**What it is:** the formal, exportable documents a real accountant or
a real bank would expect to see — distinct from a quick conversational
answer.

**Inputs:** no direct conversational input — these are generated on
request, from real, already-recorded data (`/reports/profit-and-loss/pdf`,
`/reports/aged-debtors/pdf`, `/customers/{id}/statement/pdf`).

**Outputs:**
- **Profit & Loss** — accrual-based (real invoiced amounts, not cash
  received), Cost of Sales, Gross Profit, Operating Expenses, Net
  Profit, expense breakdown by category.
- **Aged Debtors** — who owes what, bucketed by age (current, 30-60,
  60-90, 90+), payments allocated oldest-invoice-first.
- **Statement of Account** — real, chronological transaction history
  per customer with a running balance, correctly labeled *"CREDIT
  BALANCE"* rather than a nonsensical negative "balance due" when
  payments exceed invoiced amounts.
- Every figure verified live against real, known underlying data before
  being trusted — see `DECISIONS.md` for the reports-testing session
  that found and fixed real formatting bugs this way.

---

## Team & Contacts (Characters)

**What it is:** everyone who isn't a paying customer — installers,
suppliers, personal relations — structurally incapable of ever
touching an invoice or a payment, by design, not by convention.

**Inputs:**
- *"Sipho is doing Jenny's install."*
- *"Leon Derksen is our sales rep at Floornet."*
- A real, structured fact: *"Sipho's driver's license is code C1."*
- A personal relation, deliberately kept separate: *"my wife's
  birthday is in March."*

**Outputs:**
- A real character record, with real HR-style facts (role, skill,
  license) when relevant, and real notes otherwise.
- "How's Sipho doing?" surfaces his real job activity (gated by
  `can_know_jobs`) and his structured facts together — never dropped
  by the model's own judgment about what's "relevant enough."

---

## Tasks & Reminders

**What it is:** Peter's own personal errands and follow-ups — never
confused with a customer's own commercial record, even when a
customer's name is what triggered the reminder.

**Inputs:**
- *"Remind me to buy dog food."*
- *"John has lost his work boots, we need to get him some new ones."*
- Marking something done: closed by fully deterministic word-token
  matching, no AI call involved in confirming "which task."

**Outputs:**
- A real task record, already linked to a real customer or character
  when one is genuinely relevant (built, working end to end) — though
  no due/scheduled time exists yet, and no per-item UI action (a real
  `[Call]` button) exists in the app yet either.

---

## Memory & Notes

**What it is:** everything that doesn't have a more specific,
structured home — the receptacle everything else is built on top of.

**Inputs:** anything genuinely narrative — a preference, a fact with
no dedicated table, an observation with nowhere more specific to go.

**Outputs:**
- The raw capture itself, logged unconditionally before any
  understanding happens (Principle 22) — nothing is ever lost even if
  extraction gets it wrong.
- Real customer/character notes, surfaced in context when relevant.
- **Deliberately excluded now, found via direct, real testing:** any
  intent with its own structured storage (a payment, an invoice, a
  measurement) no longer duplicates into this layer — a real security
  and consistency fix, not just a tidiness one.

---

## Documents & Files

**What it is:** anything physical — a photo, a voice note, an audio
file, a PDF — turned into something the rest of the system can use.

**Inputs:**
- A photo of a site, a sample, a delivery.
- A voice note, transcribed and processed exactly like typed text.
- A real PDF — a supplier's statement, a delivery note, anything with
  text worth extracting.

**Outputs:**
- Real, correct extracted text from an uploaded PDF (verified live,
  closing a loop where Office's own generated invoice was uploaded and
  read back correctly) — a genuine parse failure and a scanned document
  with no text layer are reported as two distinct, honest outcomes.
- A real, generated PDF for every quotation, invoice, and report.

---

## Auth & Permissions

**What it is:** who is asking, and what they're allowed to know or do
— not a bolt-on afterthought, a real, tested layer now covering both
reading and writing.

**Inputs:** a real Google sign-in; every message and voice upload now
carries the real, resolved session behind it.

**Outputs:**
- Three real roles today — Owner, Installer, Accountant — each with a
  genuinely different, correct answer to the same question, proven
  live: *"what does Jenny owe?"* answered fully for Owner and
  Accountant, honestly refused for Installer, never a silent omission
  that reads as ignorance.
- Financial writes (payment, invoice, quotation, expense) gated the
  same way reads are.
- **Real, still-open gap:** no session yet defaults to full access —
  safe only because Peter is currently the sole real user.

---

## Conversational Lookup

**What it is:** not a separate department so much as the thing that
makes every department above feel like one conversation rather than a
dashboard with many screens — Principle 25's own point made literal.

**Inputs:** any direct question — "what does Jenny owe," "how's Sipho
doing," "how are we doing financially."

**Outputs:** a synthesized, natural answer drawing on whichever real,
permission-scoped facts actually apply — never a raw data dump, never
an invented number, always grounded in something actually retrieved.

---

## Suppliers & Procurement (Purchase Orders, Deliveries, Supplier Bills)

**What it is:** the mirror image of Quotations/Invoicing — Peter →
Supplier instead of Peter → Customer — with real, deterministic
reconciliation as the actual point of building it, not just record-
keeping.

**Inputs:**
- Ordering: *"order 20 bags of screed from Floornet."*
- A delivery arriving: *"the Floornet screed delivery arrived, all 20
  bags"* — or a real, photographed delivery note, caption naming the
  supplier.
- A supplier's bill: *"got Floornet's invoice INV-4471"* — spoken, or a
  real, uploaded PDF/photo of the actual invoice.
- Settling a balance: *"paid Floornet R5000 off their account."*

**Outputs:**
- A real purchase order, unguarded (a commitment being placed, not
  money moving yet).
- A real Goods Received Note — quantity received compared against
  quantity ordered, a real variance computed in code, unguarded but
  traceable (who recorded it).
- A real Supplier Invoice — quantity billed compared against quantity
  *received* (not just ordered), and price billed compared against
  price expected — both real, deterministic reconciliations, guard()'d
  since real money moves. Real document/photo ingestion correctly
  distinguishes an actual invoice (has pricing) from a genuine delivery
  note (none at all) rather than assuming every photographed supplier
  document is a bill.
- A real, computed document-completeness status per order — "ordered,
  awaiting delivery" → "delivery note received, awaiting invoice" →
  "closed."
- **Aged Creditors** — the real mirror of Aged Debtors for the
  supplier side, real expenses played against real supplier payments
  and real credits, oldest-first.

---

## Variance Disposition

**What it is:** what happens after a real GRN discrepancy is found —
why it happened, and how it gets resolved. Reason codes validated
against real ERP research (short delivered, incorrectly dispatched,
damaged, over-receipt) rather than invented.

**Inputs:**
- Naming a reason: *"the underlay shortage on Floornet, that's a back
  order."*
- Resolving with a credit: *"the vinyl arrived damaged, Floornet is
  crediting us R500 for it."*

**Outputs:**
- Raising a reason is unguarded but traceable — documentation, not
  money moving.
- A credit resolution with a real, stated amount is guard()'d and
  creates a real, negative expense against the supplier — the actual
  financial write-off it implies.

---

## Consumables Stock

**What it is:** a deliberately narrow scope — real, running quantities
for genuinely generic materials (screed, glue), never full inventory
and never job-specific product tracking.

**Inputs:**
- Starting to track one: *"track screed as stock, we buy it in bags."*
- Real usage: *"used 5 bags of screed on Jenny's job."*
- A real, physical count: *"counted 14 bags of screed."*

**Outputs:**
- A confirmed GRN automatically increments a tracked item's real
  running total — only when its exact name already matches one Peter
  deliberately registered, never guessed from a delivered material's
  name.
- A real stocktake computes a real variance against the system's
  belief, and corrects the running total to match physical truth —
  the same reconciliation philosophy as PO/GRN/Supplier Invoice, one
  layer further.

---

## Snags

**What it is:** a real, physical quality issue found on a job, and its
resolution — the smallest, most immediately useful piece of the
lead-to-warranty lifecycle.

**Inputs:**
- *"Jenny's carpet has a loose seam near the door."*
- *"fixed the loose seam on Jenny's carpet."*

**Outputs:**
- Raising and resolving both unguarded but traceable — a quality
  note, not money moving.
- Resolving one surfaces a real, honest connection to retention —
  if it was genuinely the last open snag and a real retention
  arrangement exists, Peter is told a real amount may now be
  releasable, never an automatic financial write.

---

## Leads & Enquiries

**What it is:** someone interested, not yet a customer — converts into
a real customer and quotation once priced, rather than duplicating
that data.

**Inputs:**
- *"Sipho enquired about carpet for his lounge, he found us through a
  referral."*
- *"lost the Sipho enquiry."*

**Outputs:**
- A real lead record — status enquired → quoted → won/lost.
- The quoted and won transitions happen automatically, hooked directly
  into the already-real quotation and quote-to-invoice paths — never a
  separate, duplicate mechanism.
- A lead's name deliberately never touches customer reconciliation
  until it's genuinely quoted — raising or losing one can never
  silently create a real customer record.

---

## Supplier Statement Reconciliation

**What it is:** the real, buildable version of comparing a supplier's
own claimed account balance against Office's real, internal one —
deliberately scoped to the one fact that actually matters, not
complex, fuzzy line-by-line matching.

**Inputs:** a real, uploaded supplier statement (PDF or photo), caption
naming the supplier.

**Outputs:** the real, claimed closing balance extracted from the
document, compared directly against the real, internal outstanding
balance already computed for Aged Creditors — surfacing the actual
difference, if any.

---

## Identity Collision

**What it is:** a real, deterministic check — before a new customer or
character record is ever silently created, verifying the exact name
isn't already known under a genuinely conflicting role.

**Inputs:** any message that would otherwise create a new customer or
character record for a name already known as the other.

**Outputs:** held for real confirmation rather than silently creating
a duplicate or misassigned identity — confirming creates a real, new,
separate record, since the same person can genuinely be both a
customer and a supplier or installer.

---

## Projects (Layer 2)

**What it is:** grouping related job scopes into one real project,
without Peter ever having to say "these belong together."

**Inputs:** multiple components/tasks named in the same breath, or a
later, separate message for a customer with an existing open project.

**Outputs:**
- Same-breath assembly — job scopes sharing the same real capture
  automatically form or join one project.
- Cross-capture attachment — a later, standalone job scope
  automatically attaches to a customer's one open project; if two or
  more genuinely compete, Peter is asked directly which one, rather
  than guessed.
- Real, computed job-completion status (open / closed, paid in full)
  and scheduling shown per phase, conversationally ("how's Jenny's job
  going").

---

## Corporate Stationary

**What it is:** the business's own real logo, captured once and reused
on every generated document — the grounded, demonstrated-need core;
fonts, color schemes, and marketing material deliberately left
unbuilt, no real need shown for them yet.

**Inputs:** a real photo of the business logo, uploaded once.

**Outputs:** stored and served back reliably, ready to appear on
generated PDFs.

---

## Designed, not yet built — for completeness, not confusion with the above

Real, substantial design documents exist in `DECISIONS.md`, fully
specced, deliberately not built yet:

- **Job-specific material remnant tracking** — the harder half of
  stock (a job-specific product like carpet or tile, not a generic
  consumable) — genuinely separate from Consumables Stock above, still
  needing real product-code specificity and PO-vs-invoice
  reconciliation mechanics worked out.
- **Warranty tracking**, and the richer job-completion questions
  (mandatory vs. optional artifacts, maintenance reminders) — Snags
  above is the real, simpler half of this same design already built.
- **The named-handle Layer 2 rung** — referring to a specific project
  by name in conversation, rather than the ask-when-ambiguous rung
  already built.
- **Chain automation** — a real trigger layer noticing state
  transitions across the full lead-to-invoice chain and proposing the
  next action, deliberately gated behind the mirror being "polished
  bright" first, not action yet.
- **Office scales by scope** — the nested-offices architectural
  direction, correctly gated behind real evidence of a second
  organizational layer that doesn't exist yet.

Named here so this map stays complete, not because they're active
today.


