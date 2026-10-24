> **Status:** real. **Verified:** not yet. **Owns:** none.

# DECISIONS: procurement-and-stock

Part of [DECISIONS.md](../../DECISIONS.md), split from it on 2026-10-24 without changing a word (the original is `git show 95bf743:DECISIONS.md`). Sections keep their original order.

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

## Aged Creditors, Stock, and Customers — the second discoverability-plus-audit batch, confirmed working

**The real trigger:** asked directly what else sat in the same sphere after the first batch landed. Audited rather than guessed, the same way every real finding tonight got made — checked each real backend function against whether a real, non-debug endpoint and a real UI surface actually existed for it.

- **Aged Creditors:** `getAgedCreditorsReport` had real, proven data (including a real fix for negative-expense credits) but no PDF generator at all, despite `generateAgedDebtorsPdf` existing for the opposite direction of money since 2026-07-12. Built as a faithful mirror — same visual family, same FIFO convention — and added as a third item in the existing Reports sheet.
- **Stock:** `getTrackedStockItems` had been real, working data since 2026-07-25, entirely voice-only. Deliberately scoped to current levels only — the related discrepancy-resolution piece (`getOpenDiscrepanciesForSupplier`, `recordVarianceDisposition`) is naturally per-supplier and was deliberately left as a real, separate extension of the existing Suppliers room rather than folded in here.
- **Customers — the real, unexpected sixth domain**, found while trying to place Job Profitability (which takes a `customerId` and needs a real detail view to live in): "People" turned out to only ever show characters. Customers had no real list anywhere in the app at all. Built a full new room mirroring People's exact real search pattern, with a real detail dialog that fetches Job Profitability fresh on open — real data since 2026-07-22, previously only reachable as the answer to one specific spoken business question.

**Confirmed working, real device test, all three at once, after one real rebuild:** "All up and running."

**Total real ledger for the whole discoverability-plus-audit pass tonight: six real domains** (Snags, Leads, Projects, Aged Creditors, Stock, Customers) that had real, working backend logic and zero discoverable surface, all now reachable.

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

## Rewrite Phase 2, stock, snags and leads: one real defect

Recorded: stock (27 cases: registering an item, using stock, counting it) and snags and leads (28 cases: raising and resolving a snag including the retention release, raising a lead, and the owner-only "lead lost"), each with its model scripted, across owner, accountant, installer and a role with no permissions, and with each model failing or finding nothing.

**One real defect: registering a stock item that was already tracked inserted a second row with the same name.** Deliveries then added to the first, usage matched the first, and the second sat at zero for ever, shown as a duplicate line on the stock screen. Registering is now idempotent: the same name (ignoring case) is the same item, the existing row is reused, and the reply says "Already tracking Screed (bags)" instead of claiming a new item. The two boundary cases were added so the fix is pinned from both sides: the same item in a different case is reused, and a different item whose name merely starts like a tracked one ("Screed Plus") is still created.

**Verified:** typecheck unchanged; 1,602 checks. The recording diff for the existing cases is **exactly one of 25** (the duplicate registration: one row no longer added); the snags and leads recordings were unchanged (28 of 28). Four deliberate breakages, including a too-strict match (a different case treated as a different item) and a too-loose one (a name that merely starts with a tracked name treated as the same item), were caught. One of my own mutations ran in the wrong direction and looked like a survivor until it was redone correctly.

**What the recordings confirmed is working:** an unmatched item, an item with no quantity, nothing tracked yet, and a model that fails all give an honest "couldn't match" reply and write nothing; installers may register, use and count stock and a role with no permissions is refused with nothing written (the decision that money and stock are gated at creation); resolving the last open snag releases the customer's retention only if they hold one, and not while another snag is open; marking a lead lost is owner-only; a snag or lead the model cannot read says so.

**Recorded in `OPEN_QUESTIONS.md`, not changed:** using more stock than is on hand records the usage and reports "-5 remaining" without comment; and any duplicate stock rows that already exist in the live data from before this fix are not merged.

**The function is now characterized except for its opening step.** Recorded so far: payments, quote conversions, procurement, invoicing and pricing, work observations, lookups, stock, and snags and leads (about 220 cases). What remains is the identity step that runs before every intent (finding or creating the customer or supplier, and the "is this the same person?" holds).


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

## Decision 54: link an existing order to a customer by voice, and move the costs already recorded for it

Decided by Pierre: **add the spoken link, held.** Orders placed before the link existed (decision 52) could not be linked afterwards.

**What it does.** "Link order 12 to Jenny", "put order 12 on Jenny's job" or "the Floornet order was for Jenny" is a **held action**, like a cancel, with the same permission (invoicing): "Link Floornet order #1 Vinyl and underlay (50 sqm Vinyl, 100 sqm Underlay ordered) to Jenny Smith's job? Needs your confirmation (action #1) before it's linked." **It never guesses between several:** a number names the order; with only the supplier named it takes that supplier's one unlinked order, and with several it lists them and asks for a number. The customer must already exist (nothing is created for a name nobody has heard of), a cancelled order is refused, a number that is not an order is said so, and an order **already linked to someone else says it will move it, and its costs**.

**Moving the costs already recorded: only where the match is certain.** An older order may already have had its supplier invoice confirmed, and that cost was recorded with no customer. On confirming, the order is linked and those costs move onto the job: a supplier invoice's expense is found by the supplier, the amount and the words it was recorded from, and **it must be exactly one candidate**; a credit's expense is found by the disposition that made it. Anything that cannot be matched with certainty is **left alone and counted, never guessed**, and the reply says so ("1 supplier invoice could not be matched to its cost with certainty, so it was left as it was."). A cost that belongs to **another** customer with no link saying why is never taken; an order moved from another customer takes its costs with it. Linking the same order to the same customer again moves nothing.

**The property that matters.** Against `main`, **no existing recording changed or was removed**; 21 were added (thirteen spoken: held, by number, several unlinked, moving from another customer, an unknown number, a cancelled order, no customer, an unknown customer, no number and no supplier, nothing waiting, and the three roles; eight confirmations: linking, a cost moving, two identical costs left alone, a move between customers, another customer's cost not taken, the gate, twice, and reject), plus 17 unit tests against a real database.

**Verified:** typecheck unchanged; **4,563 checks**. **Six deliberate breakages were caught:** two identical costs no longer left alone; a cost belonging to another customer taken; a confirmation that does not actually link; a link creating an unknown customer; a cancelled order linkable; and any role able to link. **Two wording defects of mine, caught by reading the replies and fixed before pushing:** "left as they were" for a single invoice, and "R9250 of supplier invoices and any credits" when no credit was involved. **One bug of mine, caught by validating the cases before running them:** a seed called a string as a function.

**Limits, stated plainly.** A cost is moved only when exactly one expense matches the invoice by supplier, amount and the words it was recorded from; an older invoice recorded before those matched this way is reported as "could not be matched" and left, and can be fixed by hand. Credits are moved when found by their disposition, but are not added to the supplier-invoice total in the reply. Linking is to the **customer**, not to one of their jobs (item 53). The language model's reading of "link order 12 to Jenny" is unverified on the real model; the prompt describes the intent and gives an example.


---

## Rewrite Phase 3, step 1: the supplier-document decision, once

**The first real move of the rewrite, and the first piece of `index.ts` to leave it.** The supplier-document decision (what to do with an uploaded delivery note, supplier invoice or statement) existed twice in `index.ts`, once in each upload handler. It is now **one function in its own file, `worker/src/intents/supplier-document.ts`**, called by both handlers.

**It was verified before it was moved, because the log had it wrong.** The Phase 2 log called this "131 lines, identical except for the name of one variable". Re-measured before touching it: the section had **grown to 199 lines** (supplier statements were added to it since), and a byte-for-byte comparison found **exactly one differing line out of 199**: the word `"document"` versus `"photo"` when a supplier statement is saved. That one word is now the function's `source` parameter. **The body is the original code moved, not a rewrite** (no multi-line strings to disturb, so it was only shifted two levels left).

**The result.** The document handler went from **329 to 135 lines** and the photo handler from **290 to 96**; `index.ts` from **6,297 to 5,928 lines** (369 fewer, with the logic in one 261-line module instead of two copies). The two handlers can no longer drift apart. Eleven imports `index.ts` no longer needed were removed (six of them were already unused before this change).

**The property that matters.** **Not one of the 751 recorded cases changed**, including all the document-versus-photo pairs: the behaviour is identical. Only the source-text guards changed, and that is the part to read carefully.

**Why 33 guards failed, and what was done about them.** The guards are tests that search `index.ts` for the code's shape ("the refusal branch must come before the hold it guards"). The code moved, so they could not find it: they failed on the move, not on any change in behaviour (none of the failures was a recording). Updating a test to make it pass is exactly how a safety net gets weakened, so the update was kept faithful and then **proved**: each handler guard now reads the handler's own text **plus** the shared function's text (together they are what that handler runs), the file-wide counts became "once in the shared decision, once in dictation", and the Phase 1 scaffold guard still forbids importing the unfinished scaffold (`result`, `dispatcher`) and now allows only `index.ts` to import the first real handler. **Three new guards were added:** each handler must call the shared function **with its own source word**; neither handler may carry **its own copy** again; and only `index.ts` may import it.

**Verified:** typecheck unchanged; **4,585 checks**. **Four deliberate breakages were caught,** the first two by the recorded cases themselves and not only the guards: the photo handler recording its statements as coming from a document; the photo handler ignoring what the shared decision worked out about the supplier; a duplicate supplier invoice no longer being recognised in the shared function; and someone re-creating a private copy of the decision inside the photo handler (caught by the new guard).

**Still duplicated between the two handlers: 48 lines** in three blocks (the form-data and idempotency boilerplate, a set of declarations, and the 32-line caption-hint logic). That is step 1b, small and equally safe.


---

## Rewrite Phase 3, step 4: stock leaves processOneExtraction

**The second intent group out of the big function:** registering an item to track, recording stock used on a job, and a stocktake count now live in **`worker/src/intents/stock.ts`** (one handler, `handleStock`). `processOneExtraction` fell from 2,039 to **1,954 lines** and `index.ts` from 5,659 to **5,575**.

**Checked before it moved.** Every variable these three intents use was private to them (seven names, none referenced anywhere else in the function); they read only the sentence and write nothing back to the caller but the reply; and **all three always produce a reply**, so the single reply branch that replaces the 20-line chain cannot change which message wins. The pieces were separated in the original only by the call to the order handlers, which does nothing for a stock sentence, and **a sentence has exactly one intent**, so one handler at the position of the first branch keeps the order of writes identical. The code is **moved unchanged**, not rewritten: the same branches, the same messages, including the unit questions and the "count looks off" note.

**The property that matters.** **No recording changed, was removed or was added: all 751 are untouched,** and no existing guard failed (nothing had been watching this code in `index.ts`). **Eighteen new checks** guard it: `index.ts` calls the handler exactly once and uses its reply as the message; it may not contain its own copy (the stock functions, their result variables or the unit question); the module must do each of the five things (register, record usage, record a stocktake, check the unit, read the tracked items); and only `index.ts` may import it.

**Verified:** typecheck unchanged; **4,639 checks**. **Four deliberate breakages were caught:** the stock reply no longer used; stock no longer recorded; a rule inside the moved code removed (stock used in another unit with no conversion no longer asks; caught by the recorded case); and a private copy of the stock logic grown back in `index.ts`. Seven imports `index.ts` no longer needed were removed.

**Where it stands:** two groups out (order management, stock); `processOneExtraction` is **1,954 lines**, from 2,235 (and 1,756 at the Phase 1 measurement). Next: snags and leads.


---
