# Open questions

One living list of everything that is undecided, unverified or deliberately left alone, so nothing depends on
anyone remembering it. Each item says what the question is, what the system does **today** (the default until
someone decides), and where the evidence is. When one is settled, move it to the bottom with the date and the
decision, and say where it was applied. Last updated 2026-10-04 (later).

## A. Decisions only Pierre can make

1. **Does a reason alone close a shortage?** Today any variance disposition counts as "resolved", including one that
   records only a reason (for example "damaged") with no back order and no credit, so the shortage leaves the open list
   and the exception report. It looks deliberate (naming why is documentation), but it means a shortage can leave the
   report without being credited or back-ordered. *Options:* keep; or only a back order or a credit closes it, a bare
   reason leaves it open. (`DECISIONS.md`, "Rewrite Phase 2, procurement".)
2. **Does a plain acceptance write off the remainder?** A shortage resolved as accepted, or with a reason only, records
   it but leaves the quantity *outstanding*, so a later delivery of that item is matched to that old order. Only an
   explicit credit writes the remainder off. *Options:* keep (credit or nothing); or treat "accepted" as a write-off too.
3. **Units do not convert.** A delivery in boxes against an order in square metres is compared number to number, and
   stock quantities are added in the delivery's unit. *Options:* a per-item conversion factor (a box is 5 m2) captured
   once; or require orders and deliveries in the same unit.
4. **No explicit "close this order".** An order completes only by being delivered or credited. A cancelled or abandoned
   order stays outstanding and keeps attracting deliveries. *Option:* a spoken "cancel the Floornet order".
5. **Supplier invoices are checked against the latest order only**, and against a single order. Deliveries now match
   across all outstanding orders; invoices still do not. *Option:* the same oldest-first matching for invoices.
6. **"Add to stock?" is one question per delivery**, all or nothing, and is not asked retroactively. Each new
   job-specific item is asked about once and then, if declined, never again. *Option:* a question per item.
7. **A spoken supplier statement now stays out of free-text notes** (it is money, and notes are ungated) and has no
   structured home, so the words survive only in the raw capture. *Question:* should a spoken statement be recorded
   somewhere, or is the capture enough?
8. **Only money intents are kept out of notes.** Stock usage, stocktakes, snags, leads and "lose lead" sentences are still
   copied into customer and supplier notes. That was out of scope (only money and stock were decided) but is a policy
   question. (`DECISIONS.md`, "Rewrite Phase 2".)
9. **Customer and supplier rows are created from an upload's caption before anything is gated.** Neither is money or
   stock, so it was left alone by decision. Worth revisiting if phantom records become a nuisance.
10. **A payment with no amount is held for confirmation on purpose** (`payments.amount` is nullable and
    `recordPayment` accepts none). Confirmed as design in the code; listed in case Pierre would rather the amount
    be asked for.
22. **When an invoice and an amendment question are both waiting, the app offers buttons for the amendment only.** The
    reply now names the invoice and its action number, but answering it means opening the Pending room. *Option:* let
    the app show both. (A Dart change and a rebuild.)
23. **When the job-observation model fails, an invoice is still held but the job, installer and date part is silently
    dropped**, and the reply says nothing about what was lost. *Option:* say so.
11. **An installer's scheduling message that the classifier labels "invoice" is refused outright.** Set aside on
    2026-10-03 as unproven (it was only ever seen in a code comment). Reopen if a real one is refused.

## B. Needs a live check only a phone can give

12. **The Codemagic rebuild**: the Confirm/Reject buttons for a follow-up question raised by a confirm ("Add to stock?",
    and a replayed invoice after an identity question). The web build compiled the change; the phone build is unverified.
13. **A live multi-order or partial delivery**, and the exception report after it. Verified on a real database and by
    tests, never run on a real delivery note with two orders.
14. **A real "add to stock?" round trip** (order something that is not stock, deliver it, confirm the delivery, answer).

## C. Unverified claims that the new harness can now settle

(none open: the one item here was settled on 2026-10-04, see below.)

## D. Housekeeping Pierre said not to worry about

16. The "Alfons" and "alfons" duplicate customers, the "stylish" test customer, pending test actions (#142, #143), and
    goods-received note #7 (a line literally named "unmatched item", from before a fix). None affects stock or variance.
17. An app screen for the exception report (a Dart change and a Codemagic rebuild). Today it is reachable by voice or
    text ("any delivery exceptions?") and by the admin key.
18. A late caption for an earlier upload. Deliberately not built: guessing from recency would reintroduce guessing.

## E. Engineering

19. **Characterization coverage.** Recorded: payments, convert_quote, procurement (39 cases), invoicing and pricing
    (29 cases: invoice, quotation, price_scope). To record: work observations, lookups, stock, snags and leads, identity
    holds (the preamble). Nothing moves in
    Phase 3 until its group is fully recorded.
20. **The upload handlers (`/files/document`, `/files/photo`) are not characterized**; they are separate code with
    their own tests by source pattern only.
21. **Phase 3 itself** (the first real handler reproducing its recording exactly) has not started.

## Settled (kept so the reasoning is not lost)

- 2026-10-04: the invoice orphan was real (an invoice hold created and never mentioned when an amendment question was
  returned instead). Reproduced with the harness and fixed in the reply. (`DECISIONS.md`, "Rewrite Phase 2, invoicing and pricing".)
- 2026-10-04: a purchase order, supplier invoice or disposition built from nothing usable is no longer recorded, held or
  filed as resolved. (`DECISIONS.md`, "Rewrite Phase 2, procurement".)
- 2026-10-03: installers may dictate goods received. Gate creation for money and stock only. Move the permission
  check ahead of customer creation. (`DECISIONS.md`, "Phase 0".)
- 2026-10-03: an unordered delivery is received and reported as an exception, not refused.
- 2026-10-03: a short delivery is flagged at once and stays until resolved; a delivery goes against the best match
  across all outstanding orders.
- 2026-10-03: ask on delivery whether to add new items to stock.
- 2026-10-03: CI runs Node 22 so tests can use a real database.
