# Open questions

One living list of everything that is undecided, unverified or deliberately left alone, so nothing depends on
anyone remembering it. Each item says what the question is, what the system does **today** (the default until
someone decides), and where the evidence is. When one is settled, move it to the bottom with the date and the
decision, and say where it was applied. Last updated 2026-10-04 (decisions session, round 4 applied).

## A. Decisions only Pierre can make

3. **Units do not convert.** A delivery in boxes against an order in square metres is compared number to number, and
   stock quantities are added in the delivery's unit. *Options:* a per-item conversion factor (a box is 5 m2) captured
   once; or require orders and deliveries in the same unit.
5. **Supplier invoices are checked against the latest order only**, and against a single order. Deliveries now match
   across all outstanding orders; invoices still do not. *Option:* the same oldest-first matching for invoices.
6. **"Add to stock?" is one question per delivery**, all or nothing, and is not asked retroactively. Each new
   job-specific item is asked about once and then, if declined, never again. *Option:* a question per item.
7. **A spoken supplier statement now stays out of free-text notes** (it is money, and notes are ungated) and has no
   structured home, so the words survive only in the raw capture. *Question:* should a spoken statement be recorded
   somewhere, or is the capture enough?
10. **A payment with no amount is held for confirmation on purpose** (`payments.amount` is nullable and
    `recordPayment` accepts none). Confirmed as design in the code; listed in case Pierre would rather the amount
    be asked for.
25. **A date spoken as an ordinal word ("the seventeenth") is not parsed to a date**, though "the 10th" is. The words are
    kept but nothing is scheduled from them. Found while recording; not changed. *Option:* teach the date reader the words.
26. **A job scope with no customer is recorded** when only an installer or a date is heard and there is nothing in the same
    message to attach it to. It is findable only by its installer or date. May be intended (to be attached later); worth
    confirming.
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
35. **Two jobs in one message are grouped under a brand-new project and no question is asked, even when the customer
    already has open projects; one job asks which existing project.** The same customer is treated differently depending
    on how many jobs were in one sentence, and a duplicate project is created. *Options:* ask which existing project in
    both cases; or keep the new group project but ask whether it belongs to an existing one. (`DECISIONS.md`, "Rewrite
    Phase 2, the first caller".)
36. **Answering "yes, the same person" to an identity question creates the customer (or supplier) record unlinked from
    the existing person**, whereas the near-match answer links it. The code's own 2026-07-25 comment says the record is
    created "separately", so it may be intended; the question itself reads "is this the same person". *Option:* link it, as
    the near-match answer does. (`DECISIONS.md`, "Rewrite Phase 2, the confirm and reject routes".)
37. **Rejecting an identity question ("someone else was meant") drops the original dictation without a word.** Nothing is
    recorded and nothing says so; the person has to say it again with a different name. *Option:* say what was dropped.
38. **The permission grid is coarse: five real switches.** `can_manage_invoices` is checked in 44 places, so one switch
    governs recording money AND seeing quotations, expense totals and supplier balances. Finer control (expense totals,
    supplier balances, material prices, person details as their own switches) needs new capabilities. Offered and
    deferred ("start with the existing ones"). A material's last price is not gated by any capability at all, so it
    cannot be a switch until it gets one. (`DECISIONS.md`, "The permission grid".)
11. **An installer's scheduling message that the classifier labels "invoice" is refused outright.** Set aside on
    2026-10-03 as unproven (it was only ever seen in a code comment). Reopen if a real one is refused.




39. **A cancelled order cannot be reopened.** To order the same thing again, place a new order. Cancelling is a held
    action and is recorded with who cancelled it, but there is no "uncancel". *Option:* a spoken "reopen the Floornet
    order".

## B. Needs a live check only a phone can give

12. **The Codemagic rebuild**: the Confirm/Reject buttons for a follow-up question raised by a confirm ("Add to stock?",
    and a replayed invoice after an identity question). The web build compiled the change; the phone build is unverified.
13. **A live multi-order or partial delivery**, and the exception report after it. Verified on a real database and by
    tests, never run on a real delivery note with two orders.
15. **The Permissions screen on a real phone.** The web build compiles it; the phone build and a real tap-through are
    unverified (switch something off for the installer, then check on the installer's phone that the room is gone).
14b. **Both waiting actions on a phone.** The app now shows a Confirm and Reject for each thing waiting, with a caption.
    Try "invoice Jenny R3000 and move the install to the 17th" for a customer who already has a job: expect two captioned
    pairs, "Job change" and "Invoice". The web build compiles it; the phone build needs a Codemagic rebuild and a real tap.
14a. **A real "cancel the Floornet order".** The reader that classifies a spoken sentence is a real language model and could
    not be run here; its prompt describes the new intent and gives an example, but it needs one real try on the phone, and
    one with several open orders (it should list them and ask for a number).
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

19. **Characterization coverage.** All of `processOneExtraction` is recorded (about 260 cases), its caller
    `processTranscript` (19), the confirm and reject routes (51) and the upload handlers (50: documents, photos, voice
    notes, with real PDFs and document-versus-photo pairs). About 380 cases in all, run through the real request handler
    and the real auth gate where a route is involved.
20. **Not recorded: the remaining routes.** The list screens, the document downloads (the PDF renderer), sign-in, and the
    `/admin` and `/debug` routes. The risky paths (dictation, confirmation, uploads) are all recorded.
21. **Phase 3 itself** (the first real handler reproducing its recording exactly) has not started. **Recommended first
    move:** the supplier-document decision section that exists twice, identically, in the document and photo upload
    handlers (131 lines): it is fully recorded, duplicated, and a single shared function removes the chance of the copies
    drifting. (`DECISIONS.md`, "Rewrite Phase 2, the upload handlers".)

## Settled (kept so the reasoning is not lost)

- 2026-10-04, decided by Pierre (decisions session, round 4):
  - **An invoice and a job-change question both waiting: the app shows both** (a Confirm and Reject for each, captioned). The
    server now lists every waiting action with its type. A project question and a near-match question are not added as
    items (they need a choice, not a plain Confirm). Applied; the app part is unverified on a phone.
  - **Say so when the job part of an invoice could not be read** (only when the reader actually failed). Applied.
  - **Say so when prices were mentioned and no quotation was made.** Applied; never shown to a role that is not priced for.

- 2026-10-04, decided by Pierre (decisions session, round 3):
  - **A reason alone still closes a shortage** (kept as it is).
  - **Only a credit writes off a shortage; accepting one does not** (kept as it is).
  - **Cancelling an order: built** as a spoken, held action that names the order, never guesses between several, never
    creates a supplier, closes the order's open shortages and stops the order attracting deliveries. All 414 existing
    recordings are unchanged. (`DECISIONS.md`, "Decisions session, round 3".)

- 2026-10-04, decided by Pierre (decisions session, round 2):
  - **Stock, snag and lead sentences stay out of notes too** (they join the money intents). Applied; 53 recordings differ only
    by notes no longer written.
  - **An upload caption is permission-checked before it creates a customer or supplier,** in both the document and the photo
    handler. A refused role creates nobody, keeps the link to anyone already on file, and is told why. Applied and paired.

- 2026-10-04: **the permission grid was built** (backend and screen): the owner switches a role's permissions on and off, with
  guard rails, an audit trail and reset. With nothing switched, behaviour is identical to before. Round 2 questions 4 to 6
  (person details, other sentences in notes, upload captions creating customers) were not answered before it; only the
  first is a permission, and it is covered by the inert payroll and banking permissions, which cannot be switched until
  something uses them.

- 2026-10-04, decided by Pierre (decisions session, round 1):
  - **Installers no longer see expense totals or what is owed to each supplier** through a business question. Both now need
    the invoicing permission, the same strength as the supplier screen (they were gated by `can_know_materials`). Applied;
    pinned by recordings for the installer, the accountant and the owner.
  - **Notes written before the notes fix are left as they are.** They can still hold money (for example "paid Floornet
    R10000") and an installer can still read them. Accepted knowingly; the leak into new notes is closed.
  - **A material's last price (and which supplier charged it) stays open to every role,** including one with no permissions.

- 2026-10-04: a voice note whose transcription failed left no database record (the file was stored and unfindable). It now
  logs a capture, as documents and photos always did. (`DECISIONS.md`, "Rewrite Phase 2, the upload handlers".)
- 2026-10-04: a refused answer to a near-match or project question left the action stuck as "processing" for ever, and an
  installer could consume or reject a question about a payment they may not record, losing the payment. Both fixed.
  (`DECISIONS.md`, "Rewrite Phase 2, the confirm and reject routes".)
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
