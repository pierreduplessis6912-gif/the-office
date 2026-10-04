# Open questions

One living list of everything that is undecided, unverified or deliberately left alone, so nothing depends on
anyone remembering it. Each item says what the question is, what the system does **today** (the default until
someone decides), and where the evidence is. When one is settled, move it to the bottom with the date and the
decision, and say where it was applied. Last updated 2026-10-04 (the whole function is characterized).

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
24. **A spoken job observation that mentions prices silently produces no quotation when the pricing model fails or finds
    nothing.** The job is recorded and the reply says nothing about the quote that was not made. *Option:* say so.
25. **A date spoken as an ordinal word ("the seventeenth") is not parsed to a date**, though "the 10th" is. The words are
    kept but nothing is scheduled from them. Found while recording; not changed. *Option:* teach the date reader the words.
26. **A job scope with no customer is recorded** when only an installer or a date is heard and there is nothing in the same
    message to attach it to. It is findable only by its installer or date. May be intended (to be attached later); worth
    confirming.
27. **An installer can see expense totals and the aged-creditors breakdown (what we owe each supplier) through a business
    question**, because both are gated by `can_know_materials`, while the supplier screen needs `can_manage_invoices`.
    The same data is reachable at two different strengths. *Options:* gate the creditors part by `can_manage_invoices`; or
    accept it for expenses and not for balances. (`DECISIONS.md`, "Rewrite Phase 2, lookups".)
28. **Notes written before the notes fix still hold money and are still readable by an installer.** The fix stops new
    leaks (supplier payments, quote conversions and so on) but does not clean what is stored. *Options:* a one-off admin
    scrub of existing notes that look like money (list them first, then remove); or filter at read time.
29. **A material's last price, and which supplier charged it, is ungated.** Any role, including one with no permissions,
    can ask. *Option:* gate by `can_know_materials` or `can_manage_invoices`.
30. **A person's details (cell, address and so on) are shown to every role, and `can_know_payroll` and `can_know_banking`
    are defined but never checked anywhere.** Harmless while no payroll data is stored; a day rate or a bank detail saved
    as a "detail" would be visible to everyone. *Option:* gate the sensitive detail keys, or use the two unused
    capabilities for them.
31. **A broad financial question from an installer still opens the snapshot screen** (its data is gated, so it shows
    nothing). A cosmetic mismatch. Also: "There are 1 quotations on file" has a plural slip.
32. **Using more stock than is on hand is recorded and the reply says "-5 remaining" with no comment.** It may be the
    right behaviour (usage is a fact; the count was wrong), but the reply could say that the count looks off.
33. **Duplicate stock rows that already exist in the live data are not merged** (the fix stops new ones). List them with
    `/debug/stock-items` and merge by hand, or ask for a one-off merge.
34. **The "current selection" (who "her" or "him" refers to) is one setting for the whole business, not one per person.**
    One person's lookups change what another person's "and her balance" means, and "forget that" clears it for everyone.
    A leftover from when the app had one user. *Option:* a selection per signed-in member.
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

19. **Characterization coverage.** All of `processOneExtraction` is now recorded: payments, convert_quote, procurement (39),
    invoicing and pricing (29), work observations (18), lookups (36), stock (27), snags and leads (28) and the opening
    identity step (42): about 260 cases. **What is not recorded is everything around it:** the splitting of a spoken
    message into topics, the confirm and reject routes and what they replay, and the upload handlers (item 20).
20. **The upload handlers (`/files/document`, `/files/photo`) are not characterized**; they are separate code with
    their own tests by source pattern only.
21. **Phase 3 itself** (the first real handler reproducing its recording exactly) has not started.

## Settled (kept so the reasoning is not lost)

- 2026-10-04: "forget that" abandoned the newest pending action of anyone's (an installer could abandon the owner's invoice).
  It now takes only what the caller could resolve through the normal routes. (`DECISIONS.md`, "Rewrite Phase 2, the opening step".)
- 2026-10-04: registering an already-tracked stock item created a duplicate row. Now reused. (`DECISIONS.md`, "Rewrite Phase 2, stock, snags and leads".)
- 2026-10-04: a spoken observation that priced a job was announced as "Payment noted", and an observation of nothing was
  recorded as a job. Both fixed. (`DECISIONS.md`, "Rewrite Phase 2, work observations".)
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
