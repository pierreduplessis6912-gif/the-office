# Open questions

One living list of everything that is undecided, unverified or deliberately left alone, so nothing depends on
anyone remembering it. Each item says what the question is, what the system does **today** (the default until
someone decides), and where the evidence is. When one is settled, move it to the bottom with the date and the
decision, and say where it was applied. Last updated 2026-10-04 (decisions session, round 13 applied).

## A. Decisions only Pierre can make

49. **The note filter is plain.** It catches bank and pay words and an amount per day, hour, week or month. A sentence phrased
    outside those ("he's on 600 a shift", "FNB cheque 6201...") is still kept in notes, and the words of every sentence stay in
    the raw capture. *Option:* widen the patterns as real misses turn up, or ask the reader to flag them.
    (`DECISIONS.md`, "Decisions session, round 12".)



50. **Every invoice sentence that mentions work creates a new job, even when the customer already has that job.** Seen on the
    phone: saying "invoice AGS Lewende Waters R3000 for carpet repair" three times made jobs #73, #74 and #75 for the same repair.
    *Options:* when the customer already has an open job with the same description, link the invoice to it instead of creating one;
    or ask "update job #73, or a separate new job?" as a date change already does. (`DECISIONS.md`, "Found by the first real phone
    test".)

53. **Costing is per customer, not per job within a customer.** An order is linked to the customer it is for, so a customer with
    several jobs has all their orders on one costing, because this system defines a job, for costing, as the customer. *Option:*
    link an order to one of the customer's jobs and cost each separately (a bigger change). (`DECISIONS.md`, "Decision 52".)
54. **An order placed before the link existed cannot be linked afterwards by voice.** Only an order said "for <customer>" when it is
    placed is linked. *Option:* a spoken "link order 12 to Jenny" (held, like cancel).
## B. Needs a live check only a phone can give

12. **The Codemagic rebuild**: the Confirm/Reject buttons for a follow-up question raised by a confirm ("Add to stock?",
    and a replayed invoice after an identity question). The web build compiled the change; the phone build is unverified.
13. **A live multi-order or partial delivery**, and the exception report after it. Verified on a real database and by
    tests, never run on a real delivery note with two orders.
15. **The Permissions screen on a real phone.** The web build compiles it; the phone build and a real tap-through are
    unverified (switch something off for the installer, then check on the installer's phone that the room is gone).
14n. **Costing for a job on the phone.** Say "order 20 bags of adhesive from Floornet for [a customer]" (expect "...for [customer]'s
    job"), then ask "how is [customer] doing" (expect "Ordered for this job and not yet invoiced: R..."). When the supplier's invoice
    for it is confirmed, the cost should appear in "costs linked to this job".
14m. **A long reply scrolls (needs a Codemagic rebuild).** Ask "what open orders do we have" with several orders, and drag the
    reply: it should scroll inside the space above the orb instead of being cut off. Say if the area is too small or too large.
14l. **Open orders and a 'for' order on the phone.** Say "what open orders do we have" (expect a list by supplier with what is still
    due, not the financial snapshot question), and "order 10 boxes of laminate for zztest" (expect "did you mean from Zztest
    Supplies?" and no new customer called zztest; if one already exists from the earlier test it is harmless).
14k. **The original phone-test sentence, again, after this deploys:** "Invoice AGS Lewende Waters R3000 for carpet repair and
    schedule for the 17th". Expect the invoice waiting, then "Job scope #N updated — scheduled for Sat 17 Oct." The fix was tested
    with the model's mistake scripted four ways; only the real model can confirm it.
14j. **Round 12 on the phone.** Say a measured room with no customer (expect "which customer is it for?"), two rooms in one
    sentence-run naming Jenny once (expect both under her), "Sipho's bank is FNB, account number 6201..." as a note (expect "not
    kept in the notes"), and a supplier invoice in boxes with and without a box conversion saved. The models that read the unit
    and each sentence could not be run here.
14j. **A real "reopen the Floornet order".** The language model that reads it could not be run here. Cancel an order and confirm it,
    then say "reopen the Floornet order" (expect the order named and a confirmation), and once with two cancelled orders (expect a
    list and a request for a number).
14i. **Round 11 on the phone.** Say "Jabulani's day rate is R600 a day" as the installer (expect "Nothing was saved...") and as the
    owner (expect it held). Look at the Permissions room: it should now show Payroll and Banking details as switches. Ask "and
    her balance" on two phones signed in as two people: each should follow their own last customer, and "forget that" on
    one should not clear the other. The language model reads these sentences and could not be run here.
14h. **A real "Floornet says we owe them R12,000" and "what did Floornet claim we owe".** Both are read by the language model,
    which could not be run here (the first needs the stated balance to arrive in the amount). Try each once, and "Jenny paid"
    with no amount (expect "how much was it?") and "Sipho will install Monday" with no customer (expect "which customer?").
14g. **A real "used 3 boxes of laminate" and "counted 10 boxes of laminate".** The reader that turns the sentence into an item,
    a number and a unit is a language model that could not be run here. Try each once for an item kept in sqm with a box
    conversion saved (expect the converted amount and the note), and once with no conversion saved (expect the question).
14f. **A real "what conversions do I have" and "forget the laminate conversion".** Both are read by the language model, which
    could not be run here. Say each once on the phone (and check "forget that" still means the previous message).
14e. **A real unit conversion on a phone.** Say "a box of laminate is 2.2 square metres" (expect "Noted: 1 box of laminate =
    2.2 sqm"). Then place an order for laminate in square metres and say a delivery of it in boxes (expect "20 boxes of ... counted
    as ... sqm"), and once with no conversion on file (expect the question, and nothing recorded). The model that reads the
    sentence could not be run here.
14d. **The stock merge on the live data.** `curl -X POST <worker>/debug/merge-stock-items -H "X-Admin-Key: ..." -d '{}'` lists
    any duplicate stock rows (a dry run); add `{"confirm":true}` to merge them. Nothing has been run against the live data.
14c. **Rejecting an identity question on a phone.** Say a name that is already on file as an installer, tap Reject, and
    expect "Okay, nothing was recorded. I didn't act on ..." in the chat. The app now reads the server's message after a
    reject; the web build compiles it, the phone build needs a Codemagic rebuild.
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
51. **Colour for a cancelled order on the Suppliers screen.** The server now sends the status "cancelled" (with the day it was
    cancelled), and the app shows it in whatever style it uses for a status it has not styled, so it looks plain beside the
    coloured ones. Polish only, pinned by Pierre 2026-10-04 after the second phone test; a Dart change and a Codemagic rebuild,
    best done with the next app change. (`DECISIONS.md`, "Found by the second real phone test".)

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

- 2026-10-04, decided by Pierre (dictated, after the third phone test):
  - **An order is linked to the customer it is placed FOR** ("order ... from Floornet for Jenny"), so the cost of its supplier invoice
    (and a credit) counts against that customer's job, with a "not yet invoiced" line beside the profit. Applied.
    (`DECISIONS.md`, "Decision 52".)

- 2026-10-04, decided by Pierre (decisions session, round 13, orders):
  - **A spoken reopen for a cancelled order: built,** as a held action that names the order, never guesses between several, never
    creates a supplier, and on confirming brings the order back and re-opens only the shortages the cancellation closed. Applied.
    (`DECISIONS.md`, "Decisions session, round 13 (part 2)".)

- 2026-10-04, decided by Pierre (decisions session, round 13):
  - **Three finer permission switches: expense totals, supplier balances, material prices.** The first two follow "Money in and out"
    until set on their own, so a role already switched off cannot silently regain them; material prices default to every role. Applied.
    (`DECISIONS.md`, "Decisions session, round 13 (part 1)".)
  - **The recognised unit list stays as it is;** units are added one at a time when one turns up. (Nothing to build.)

- 2026-10-04, decided by Pierre (decisions session, round 12):
  - **A job with no customer asks which customer in every case** (a measured room takes the customer of an earlier job in the same
    message; otherwise it asks and records nothing). Applied.
  - **A sentence that says a pay or bank detail is kept out of free-text notes**, and the reply says so when it went nowhere else.
    This also closed a leak in round 11 (the sentence was being copied into notes as well as held as a detail). Applied.
  - **A supplier invoice billed in another unit is converted (quantity and price per unit) and, with no conversion known, asks and
    holds nothing**, as for deliveries and stock. Applied. (`DECISIONS.md`, "Decisions session, round 12".)

- 2026-10-04, decided by Pierre (decisions session, round 11):
  - **A person's pay and bank details need `can_know_payroll` / `can_know_banking`, to be read and to be saved** (by the detail's
    key; "account manager" and "payment terms" are not sensitive). The two permissions are now real switches. Applied.
  - **One current selection per signed-in person** ("her", "him", "forget that"); the old shared one is no longer read, so
    everyone starts empty after the deploy. Applied.
  - **An installer's scheduling message labelled "invoice" with no amount is read as the job it is;** with an amount it is still
    refused. Applied. (`DECISIONS.md`, "Decisions session, round 11".)

- 2026-10-04, decided by Pierre (decisions session, round 10):
  - **Supplier statements have a home, spoken or uploaded:** recorded with what the books said at that moment and the difference,
    and the history can be asked for. The supplier must already be on file. Applied.
  - **A payment with no amount asks how much and holds nothing.** Applied (a payment held before the change can still be confirmed).
  - **A job with only an installer and/or a date, no customer and nothing to attach to, asks which customer** and records nothing
    (and creates no installer). Applied. (`DECISIONS.md`, "Decisions session, round 10 (part 1)".)

- 2026-10-04, decided by Pierre (decisions session, round 9, stock units):
  - **Stock usage and counts said in another unit are converted, and when no conversion is known nothing is recorded and the
    person is asked once.** Same conversions and rules as for deliveries. Applied. (`DECISIONS.md`, "Decisions session, round 9 (part 2)".)

- 2026-10-04, decided by Pierre (decisions session, round 9):
  - **A time, a duration or an amount is never read as the day** ("5 pm on the 17th" is the 17th; "3 days from now" is no date).
    Applied. (`DECISIONS.md`, "Decisions session, round 9 (part 1)".)
  - **A role that cannot see the financial screens is told so instead of being sent to an empty one,** and "1 quotations" /
    "1 expenses" read in the singular. Applied.

- 2026-10-04, decided by Pierre (decisions session, round 8, conversions):
  - **A spoken list and "forget" for unit conversions: built.** The list is answered in code; forgetting removes exactly the named
    item's conversion, never a looser match, and offers near matches when the name is not saved. Materials access for both.
    (`DECISIONS.md`, "Decisions session, round 8 (part 2)".)

- 2026-10-04, decided by Pierre (decisions session, round 8):
  - **A named month is read** ("the 17th of November", "17 nov"); a date already gone by is next year; a day the month does not
    have is no date; "may" and "march" as ordinary words are not months. Applied. (`DECISIONS.md`, "Decisions session, round 8 (part 1)".)
  - **The same supplier invoice said twice is not recorded or held again,** and the reply says it is already recorded (or already
    waiting). Same supplier and same reference only; backstop at confirmation. Applied.

- 2026-10-04, decided by Pierre (decisions session, round 7, invoices):
  - **A supplier invoice is matched across all the supplier's open orders, oldest first,** as deliveries are (open = quantity
    not yet invoiced; everything invoiced falls back to the latest order). One invoice, one expense, a line against each order.
    All three entry paths and confirmation; no existing recording changed. (`DECISIONS.md`, "Decisions session, round 7 (part 2)".)

- 2026-10-04, decided by Pierre (decisions session, round 7):
  - **Dates in words are read** ("the seventeenth" schedules the 17th; every day, first to thirty-first, equals its digit form;
    "the first job" and "a second coat" are not dates). Applied. (`DECISIONS.md`, "Decisions session, round 7 (part 1)".)
  - **"Add to stock?" stays as one question per delivery** (kept as it is).

- 2026-10-04, decided by Pierre (decisions session, round 6, units):
  - **Per-item unit conversion: built.** Said once ("a box of laminate is 2.2 square metres"), used on every delivery (spoken,
    document, photo) and when stock is added; when two recognised units differ and none is known it asks and records nothing.
    No existing recording changed. (`DECISIONS.md`, "Decisions session, round 6 (part 2)".)

- 2026-10-04, decided by Pierre (decisions session, round 6, stock):
  - **Using more stock than is on hand says the count looks off** (still recorded). Applied.
  - **A merge for the duplicate stock rows already in the data: built** as `POST /debug/merge-stock-items` (admin key), a dry
    run unless `{"confirm": true}`. **Not yet run on the live data**: run it once with `{}` to see what it would merge.

- 2026-10-04, decided by Pierre (decisions session, round 5):
  - **"Yes, the same person" links them** (a person is created for both if the existing record had none). Applied.
  - **Rejecting an identity question says what was dropped.** Applied, with an app change so the message is shown after a reject.
  - **Two jobs in one message ask about the customer's existing open projects, as one job does;** a group project is only
    created when there is no open project to ask about. Applied.

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
