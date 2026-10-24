> **Status:** real. **Verified:** not yet. **Owns:** none.

# DECISIONS: reports-and-finance

Part of [DECISIONS.md](../../DECISIONS.md), split from it on 2026-10-24 without changing a word (the original is `git show 95bf743:DECISIONS.md`). Sections keep their original order.

## Aged Creditors — built, with a real Principle 12 refinement and a real bug found live (2026-07-24)

**A real, valuable refinement to Principle 12, given directly by
Pierre, worth recording precisely.** The initial instinct was to treat
supplier-payment tracking as unearned speculation and offer a smaller,
honestly-scoped alternative instead. Pierre corrected this directly: a
supplier statement arriving monthly isn't speculative, it's a certain,
recurring, real-world event for any business with active supplier
relationships — which this one already has. The real distinction
Principle 12 actually protects against is speculative enterprise
completeness, not building ahead of a certain, predictable need.
"Building in certain anticipation" of something that will definitely
happen is a genuinely different thing from guessing at a maybe, even
though both involve building before an explicit request.

**The real feature, built on that basis**: `supplier_payments`,
mirroring customer payments exactly — the real prerequisite Aged
Debtors already had and Aged Creditors was missing. `getAgedCreditorsSummary`
mirrors the debtors side precisely, gated behind the same
`can_know_materials` capability already used for expense data, since
this is the same real domain (supplier money), not receivables.

**A real bug found on the very first live test, worth recording
honestly**: R25,930 instead of the correct R25,430 — a real R500
credit (from Variance Disposition's own credit resolution, a negative
expense) was silently dropped entirely. The exact cause: the loop
reused Aged Debtors' `if (owed <= 0) continue` check, correct there
(a fully-paid invoice has nothing left to age) but never designed for
a negative bill existing at all — Aged Debtors never has one, so this
scenario genuinely never arose on that side. Fixed by folding real
credits into the same payment pool, applied FIFO oldest-first, the
same convention already proven for real payments — not a new
mechanism, an extension of one already trusted.

**Verified completely, end to end, with real money moving three real
ways**: R25,930 gross expenses, correctly netted to R25,430 after the
real credit, correctly reduced to R15,430 after a real R10,000 payment
— every step proven against the exact predicted number before moving
to the next, not asserted.

## Corporate Stationary — the grounded core, and a real, significant bug found at the very center of the Worker (2026-07-25)

**The real, grounded core, deliberately scoped**: a real business logo,
captured via photo upload rather than typed in by hand, reusing the
exact R2 storage pattern already proven throughout tonight. Fonts,
color schemes, and marketing material were deliberately left pinned,
not built — no real, demonstrated need behind them yet, the same
discipline Principle 12 already exists to enforce.

**Three real bugs found and fixed in sequence, each one revealing the
next — worth recording precisely, since the last one is genuinely
significant.**

1. The `ALTER TABLE` migration for the new column lived only inside
   the separate, existing `/debug/business-profile` route, never
   called again after the schema change — the column genuinely didn't
   exist yet, causing a real SQL error on upload. Fixed by running the
   migration directly inside the new route too.
2. Retrieving the logo returned a real 200 status with a genuine
   0-byte body, even though a direct R2 HEAD check confirmed the
   stored object had the correct real size. Fixed by reading the full
   buffer before returning it, rather than streaming `object.body`
   directly.
3. **The real, significant one**: the same 0-byte result persisted
   even after that fix, with response headers (including a correct
   `Content-Length`) showing the right data was present. Traced to the
   CORS wrapper — the one function that wraps *every single response*
   this Worker has ever returned — which itself streamed
   `response.body` directly, silently truncating the body a second
   time, one level above the route-level fix. This had never surfaced
   before because every prior response in this Worker's entire history
   has been JSON; this logo route was the first binary response ever
   produced. Fixed at that one, central point instead — the correct,
   permanent fix, rather than working around it per-route.

**Verified decisively, and honestly, using two different tools rather
than trusting one.** `curl` continued reporting a 0-byte body even
after the real, root-cause fix was deployed and confirmed clean on
regression — traced to a client-side quirk in this specific `curl`
build, not the server. Settled definitively by opening the URL
directly in a real phone browser: the correct image displayed, with
the browser's own title bar confirming the exact real dimensions
(400×150) of the uploaded file. A good, concrete reminder that a
single tool reporting a failure isn't always proof of one — worth
checking with an independent method before concluding.

## Deliveries of items that were never ordered are received and reported as exceptions

**The decision (Pierre, 2026-10-03):** delivery notes for items that were not ordered can be received, and are treated as an exception report. Until now a delivery that matched nothing on the order was refused with an explanation (and before that, recorded as a nameless "unmatched item"). The goods did arrive; refusing to know about them was the wrong answer.

**The design, and why it reuses what exists:** an unordered item is stored as a goods-received line carrying the **name the delivery gave it**, with no order line and an **ordered quantity of 0**, so its variance equals what arrived. That one choice means it is automatically an ordinary open discrepancy: it appears in the existing per-supplier discrepancy list and can be resolved by the existing resolve route and the existing spoken variance-disposition flow, with no second system. The extractor (`extractGoodsReceived`) now also returns each line's item name and unit as written on the delivery, sanitised; `classifyGoodsReceivedLines` (finance.ts, pure) sorts lines into matched, exceptions (named and a real positive quantity) and dropped (no name or no sensible quantity: never recorded, since a line with no identity is noise). `planDelivery` and `deliveryHeldMessage` (documents.ts, pure) decide what is done and what is said, so every branch is tested without a database or model, and the three entry points only carry the plan out: document upload, photo upload, and a spoken delivery. A delivery whose supplier was read from the document, and every spoken delivery, is held for one-tap confirmation; a typed-caption upload is recorded directly. A delivery with **no open order at all** is also received, but only if the document is a delivery note (an invoice or statement still needs an order to check against). The confirm response now says in words when items were logged as exceptions. An unordered item that is also a registered stock item (matched by exact name, the existing rule) still adds to stock, since it physically arrived.

**The report:** `GET /delivery-exceptions` (`can_manage_invoices`, so owner and accountant, not installers; `?status=all` includes resolved ones) lists every unordered item across suppliers, newest first, with supplier, name, quantity, whether there was an open order, who recorded it and when. `GET /debug/delivery-exceptions` is the same with the admin key, readable from a terminal.

**One storage compromise, stated plainly:** `goods_received_notes.purchase_order_id` is `NOT NULL`, so a delivery against no order at all is stored with order id **0**. Rebuilding a live table to allow null was judged riskier than a documented sentinel; nothing joins on it in a way that 0 breaks, and the report reads it as "no open order".

**Verified:** typecheck unchanged against the baseline; the suite is 507 checks, now including `recordGoodsReceived` against a fake database, because the first version of this change **crashed on exactly its main input** and typecheck could not see it: an exception line has an ordered quantity of 0 (not null) but no order line to read a name from, and a non-null assertion hid that. It was found by running the real SQL against a real SQLite database (not available in CI, which runs Node 20), which also confirmed: mixed deliveries, exception-only deliveries, a delivery with no order, older held actions with nameless lines still recording the old way, the report excluding both matched lines and the old "unmatched item" row, exceptions appearing in the existing discrepancy list and leaving it once resolved, and stock behaviour. Sixteen deliberate breakages (including re-introducing that crash) were caught; one survived at first, a no-order branch open to any document, and was closed with a stricter guard checked against both upload handlers. A transitional commit kept the old helper for one deploy so the build was green at every step. CI green on all nine pushes.

**Not verified, and honest limits:** no live exception delivery has been run yet. The app has no screen for the report; it can be read with the admin key, or per supplier through the existing discrepancies route and the spoken flow. A late-found limit of the existing design that this inherits: "open order" means the supplier's **most recent** order, whether or not it has been fully delivered, so a second delivery against an already-completed order is matched against it again.


---

## Quoting as its own capability, 2026-10-18 (step 3 of the sequence)

**The request and the decision.** Sales could not quote, because quoting lived inside "Money in and out", the capability that also confirms payments. Pierre's sequence ended with splitting it. I chose the precedent of 2026-10-04 (expense totals): the new capability is checked ALONE by the quotation rules (so the switch is real, not cosmetic), and it follows its parent until an owner sets it (so nothing changes for any existing role). I rejected "either capability" because an accountant with money on could then quote with Quotations switched off, which would make the switch decorative.

**The audit first, as with the roles.** Quotations were bound to money in five ways: confirming a dictated quotation, three MIXED actions (`price_scope` can produce an invoice; `convert_quote` turns a quote into an invoice; a measurement can nest a quotation), a route that edited quotations in the same rule as invoices and customers, the quotation PDF link, and a classifier that decides what is "money". There is exactly ONE place a quotation is created in production (`recordQuotation`, reached only by confirming a held `quotation` action), so the gate lives entirely in the capability tables and no handler changed. The mixed actions stay money-only: giving sales `price_scope` would let a salesperson create a held INVOICE they cannot confirm.

**Two silent failures the design had to avoid, both found by reading rather than by a test failing.** (1) The inheritance rule removes a child capability when its parent is absent, so it would have stripped quoting from sales; and the permission switch assumed "the default of a following capability is its parent's state", so switching quoting off for sales would have looked like "back to default" and been discarded. They needed ONE shared rule. My first formulation (a role is independent if the child is on by default) was WRONG: the static role lists already contain a child wherever the parent is (the accountant lists expense totals), so that rule would have stopped the accountant's quoting from following money and changed existing behaviour. The tests, written first, included "taking money from an accountant still takes quoting away", which failed it. The correct rule: a role is independent ONLY when its static default has the child WITHOUT the parent, which is sales alone. (2) `intentKeepsOutOfNotes` derives "money" from the capability; a quotation that no longer needed money would have stopped being kept out of notes, and a dictated quote (customer and price) would have been readable by an installer through a note. Pinned to the list recorded from the code before the change.

**Proof.** 43 quote checks; 13 breakages caught (all on the first real run, after confirming the unmodified run was green first, the lesson from the handover); both backends 6,659; the real staging object 42 of 42, proving the gate WITHOUT needing any data (the gate runs before the handler, so a caller who may edit a quotation gets 404 for one that does not exist and a caller who may not gets 403); production probe 9 of 9 and the live commit confirmed. The permission screen recording was re-recorded only after proving structurally that the ONLY differences were 25 added Quotations rows and 25 reworded money descriptions.

**A process note.** This step went cleanly because of what the previous one cost: I confirmed the rehearsal was running MY commit before waiting on it, used shell-safe commands, and checked the unmodified tests before trusting any breakage result. None of that was clever; it was the three mistakes from the handover turned into habits.

**Not done, said plainly.** Sales cannot use `price_scope` (the plain "quote ..." phrasing works), have no list of their quotations, and no real dictated quote has been tried as a salesperson. The admin role's Quotations default follows money (it holds it), so an owner who removes money from an admin also removes quoting, which is the consistent behaviour but worth knowing. The Team screen is still unverified.

---

## The analysis layer (backend wrap-up point 2), 2026-10-19

**Pierre's instruction.** "You don't need me to approve the 5 points, just carry on with them all as scoped." I took that as authority to design, build, rehearse and deploy each point without stopping for sign-off on its shape, keeping the same evidence discipline, and to report what I found as I went.

**The first thing I found was that I was not alone.** Before touching point 1 I looked, and the code already contained it: reports as data had been built, rehearsed (68 of 68) and deployed about an hour earlier, and a second session had since posted a coordination file and shipped a billing health check (69 of 69). So the "two sessions" that appeared as unexplained commits earlier in the day were real and still active. The coordination file's own rule is that a session claims a point and pushes the claim BEFORE starting. Points 2 to 4 were marked as "assumed" for a session that had not started them, and no branch existed for any of them, so I claimed point 2 and pushed the claim (`617e215`) before writing any code. I tell Pierre plainly that if he sent the same instruction to more than one window he should say which session owns which points, because two sessions editing the same files is how work is lost. (It nearly happened once already: the other session had edited the same line of the rehearsal workflow that my change needed, so my first edit failed to apply and I redid it against the current text.)

**Design choices and why.** (1) **One source of truth.** The analysis calls `profitAndLossData` and never recomputes a business figure; the only SQL it adds is read-only evidence, and it goes through the report's own date filter (the filter lives in finance.ts, so I added the two evidence functions THERE rather than copying the filter). A `reconciled` flag compares the records with the report's figure, so if the report's logic is ever changed without the evidence, the flag falls and a test catches it. (2) **No causes.** Pierre's design doctrine says an analysis must separate verified facts from hypotheses and must not invent explanations. The honest implementation of that is to offer no inference at all in this phase: every finding is a fact or a calculation, a test searches every finding for causal language, and `notEstablished` says what is NOT known. (3) **No supplier, because the data has none.** I read the schema before designing: an expense record has an amount, a description, a category, a date and an optional customer, but no supplier (supplier invoices are a separate table the report does not use). The doctrine's example question ("show me the supplier responsible for most of that increase") therefore cannot be answered from the report's own data, and the analysis says so instead of guessing from descriptions. (4) **Drivers and offsets,** because a total can rise while one category falls, and a share of the change can exceed 100%; presenting only the top contributors would hide the offsets. (5) **Authorised like the report it reads** (`can_know_profit`), because the analysis exposes the same figures plus expense descriptions to the same audience.

**Mistakes and near-misses of mine.** (1) I got the previous-period dates wrong twice in my own tests (I assumed the calendar month; the report's rule is the same length ending the day before, so October's 31 days compare with 31 August to 30 September); the code followed the report's rule correctly and the tests were wrong. (2) I named a field `role` (driver or offset), and the role-name audit flagged it, rightly: in this codebase `role` means a permission role and a comparison on it deserves scrutiny. I renamed it `part`. (3) Three breakages had been "caught" only by crashes, not by the check meant to catch them, and two survivors were real gaps (nothing asserted the evidence for the uncategorised category, and a record's displayed date being its UTC day rather than the local day the report counts it in); I closed them and redid the breakages properly. One survivor was my own bad mutation (I wrote a write statement into a comment, which the check correctly ignores). (4) **GitHub's status for the rehearsal run stayed on "queued" for twenty minutes while the run had in fact completed and written its record.** Rather than trusting the stuck status I looked at what was on the branch, found the workflow's record commit, and read the record, which showed 71 of 71 on my exact commit. I then dispatched a redundant second run before understanding that; it is harmless but I should have checked the branch first.

**What I could not verify.** The staging business has no expense data, so the real-object run cannot exercise the evidence queries on real rows; that is proven only against a local SQLite database, including a time-zone border record and the uncategorised category.

**Not done, said plainly.** The history and audit record (point 3, now claimed) and workspace context (point 4); further analysis topics such as by customer; and any cause of a change, which is deliberately absent.

---

## The history and audit record (backend wrap-up point 3), 2026-10-19

**Context first: the "other sessions" question.** Before building, Pierre challenged my repeated references to other Claude instances: he uses one chat on one device. I had overstated it: the commits I did not make carry the identical identity I use, the repository's only collaborator is Pierre, and what I actually had was a timeline. Pierre's own theory, which fits it best, is that when a turn times out and he presses retry, a second attempt starts while the first one's work is already landing, so the same instruction is executed in more than one attempt and only the last is visible. I could not verify that from inside; what I did was make the repository itself robust to it: a correction in COORDINATION.md (the "two sessions" story was not established), an ATOMIC claim per point using GitHub's create-only reference call (201 once, 422 after), a `Run:` id on every commit, a standing "check on arrival" step, and a rule to trust the records and the probe over a workflow's status (which can stay "queued" after it has finished). I also got one thing wrong first: I demonstrated an "atomic" claim with a plain `git push`, which is a silent no-op on an existing branch and can be fast-forwarded by a later commit; the API call is the correct primitive and I tested it properly (existing branch: 422; new: 201 then 422).

**Design choices and why.** (1) **The reply must never change.** Recording is a swallowed write after the reply is built, and the capture id reaches it through an optional callback rather than a new reply field, so the golden recordings of every reply are untouched (only a new write per turn appears). (2) **Do not copy the heard text.** It already lives in `captures`; copying would double the stored personal information for no gain. (3) **Do not instrument the pipeline to learn what was executed.** Eighteen tables already carry a `capture_id`, so "which records did this utterance create" is a read-time lookup, true by construction. The honest limit is that this covers exactly those eighteen tables. (4) **A decision is recorded from the response status alone,** never by reading the body: the confirm routes' bodies are theirs, and reading a response a second time is a way to break one. The cost is that the content of an edit-field change is not captured. (5) **Own versus everyone's.** Transcripts of what a person said are sensitive; every member can read their own, only the owner can ask for everyone's, and in a member's own view another person's address never appears (a decision by someone else shows as "another member"). (6) **Recorded speech and generated content are separate fields,** which is the doctrine's explicit requirement. (7) **Derive from the envelope.** The held actions and the recommended mode come from `buildExperience`, so the log and the reply cannot disagree.

**Mistakes and near-misses of mine.** (1) My first edit script stopped before writing `index.ts` because it could not find the voice-note call (it spans several lines), so the first test run showed 51 behaviour checks passing and 5 wiring pins failing; the failures were the signal that nothing had been saved. (2) The type checker caught that `logCapture` can return null, so the callback type had to allow it. (3) **A timestamp column named `at` would have made every golden recording flaky**: the harness masks columns ending in `_at`, so I renamed mine to `created_at` and kept `at` only as the output field. I found it by reading the failing recordings (an `"at": "2026-10-19 19:40:43"` in the diff), not by running the suite again and hoping. (4) The golden recordings: 18 checks failed, all of one form (a new `.writes.interaction_log` where the recording had nothing); I proved structurally that removing those additions returns the old files exactly before re-recording. (5) The empty-business rule flagged both tables as unclassified; they count as the owner's activity, which is the right behaviour (a business that has had a conversation is not empty).

**What I could not verify.** The real rehearsal proves the tables are created on a real object and a genuine message is recorded and read back; it does not exercise `recordsWritten` against real rows (the staging business has no records created from its one message), which is proven locally across fourteen tables including a table an older database lacks.

**Not done, said plainly.** A retention or purge policy and an erase-on-request path: the record is append-only and nothing expires it, which is a POPIA question that needs Pierre and a qualified person. Direct executions inside the pipeline are not recorded as events (they are traced through capture ids). Workspace context (point 4, claimed).

---
