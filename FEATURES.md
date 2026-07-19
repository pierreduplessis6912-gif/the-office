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

## Designed, not yet built — for completeness, not confusion with the above

Two real, substantial design documents exist in `DECISIONS.md`, fully
specced, deliberately not built yet:

- **Purchase Orders, Goods Received Notes, and Supplier Invoices** — the
  mirror image of Quotations/Invoicing, Peter → Supplier instead of
  Peter → Customer, with real, deterministic reconciliation (quantity
  and price variance) as the actual point of building it.
- **Consumables stock and stocktakes** — a deliberately narrow scope
  (not full inventory), including real-time remnant tracking (a PO's
  ordered pack size against an invoice's actual consumption) so a
  question like "how many lengths of ERP308 do we have?" can one day
  get a real, accurate answer and prevent a needless order.

Both are explicitly sequenced behind Layer 2 and behind their own
listed open design questions — named here so this map stays complete,
not because they're active today.
