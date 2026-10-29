> **Status:** real. **Verified:** not yet. **Owns:** none.

# DECISIONS: extraction-and-pipeline

Part of [DECISIONS.md](../../DECISIONS.md), split from it on 2026-10-24 without changing a word (the original is `git show 95bf743:DECISIONS.md`). Sections keep their original order.

## The Execution Ladder: AI extracts and narrates, it never matches (2026-07-11)

**The principle, stated as plainly as possible:** the AI's job is
exactly two things — decode what Peter said into a structured intent,
and narrate the outcome back in plain language. Everything in between
— figuring out *which* customer, *which* task, *which* document a vague
reference actually means — belongs to deterministic code, never to a
model's judgment. Not because the model can't do it. Because it
shouldn't have to, and because a system of record shouldn't guess.
Accounting software doesn't guess which invoice you meant. Neither
should this.

**How this was arrived at, because the reasoning matters as much as
the rule.** `resolveTaskCompletion` was originally built as an AI call
— hand Kimi the list of open tasks, ask it to judge which one a vague
completion phrase ("called them") referred to. It worked in testing.
Real conversation surfaced the actual problem: with two genuinely
similar open tasks and zero disambiguating language, this design was
*asking the AI to do exactly the kind of judgment call that should be
refused, not attempted*. Working through a Gmail analogy exposed the
real distinction: Gmail's zero-ambiguity comes from an explicit
selection event (a click); Office's equivalent selection event is
Peter's own words — "show me Jenny" *is* the selection, the same way a
click is. Once that's true, there's no reason the system should ever
re-derive "what's this about" through AI reasoning when a
deterministic, inspectable answer already exists or can be computed.

**The ladder itself, in resolution order:**
1. **Execution register / current selection** — whatever was most
   recently and explicitly named by Peter (a customer, a quotation, an
   invoice, a task). Not yet built — see Pinned Ideas below.
2. **Exact ID** — if the reference is already a real ID, resolve
   directly.
3. **Exact name / real substring or token match** — deterministic
   string matching against real stored data (proven live: word-token
   overlap with light stemming, not naive substring containment,
   which was tried first and found to under-match "called" against
   "call").
4. **Business aliases** — a stored mapping ("the tile guy" → a real
   supplier) built from a *previous* clarification, so the same
   question is never asked twice. Not yet built — see Pinned Ideas.
5. **Deterministic candidate count** — 0 real candidates means nothing
   to act on, say so; exactly 1 means that's the only possible
   referent, resolve without even needing to match; 2+ means present
   the real candidates.
6. **Ask Peter** — the only fallback, ever. There is deliberately no
   step 7. No "AI guess" rung exists on this ladder, and none should
   be added.

**What "ask Peter" actually is, precisely, so it doesn't quietly grow
back into reasoning:** code decides *that* clarification is needed and
*which* real candidates exist (steps 3–5 above); phrasing that into
"did you mean X or Y?" is plain string joining, not a model call. If a
future version wants friendlier phrasing via the AI, that phrasing
must never be handed the decision of *which* candidates to include —
only the job of saying it naturally. Extraction and narration are the
only two seats the AI ever occupies in this pipeline; matching is not
a third seat with a friendlier name.

**Proof this works, not just theory:** `resolveTaskCompletion` was
rebuilt as pure deterministic logic — zero AI calls, verified directly
in Node before ever touching production (see bug #20 above for the
real bug the rebuild itself surfaced and how it was fixed). The
"called them" test case, with two genuinely similar open tasks and no
disambiguating language, now correctly asks rather than guesses —
identical behavior to the AI-matching version, at a fraction of the
cost, with zero risk of a silent wrong guess.

**What's real today vs. what's designed but not built:**
- Real: deterministic candidate-count resolution (rungs 5–6) for task
  completion. This is the actual, working instance of the ladder.
- Not yet built: the execution register (rung 1) and the alias table
  (rung 4) — both well-reasoned, both genuinely useful, neither yet
  earned by a demonstrated need the way task completion was. Pinned,
  not built — same discipline as everything else in this file. If and
  when the register is built, it should be a small, generic key/value
  structure ("selections: customer→42, task→87"), not fixed nullable
  columns per entity type — new departments (marketing, tender,
  cybersecurity) shouldn't each require a schema migration to get a
  selection slot.
- A real open risk on aliases, worth deciding on purpose whenever
  they're built: an alias learned once ("the tile guy" → John) isn't
  necessarily permanent truth — if Peter later works with a second
  tile supplier, the same phrase needs to become ambiguous again, not
  silently keep resolving to John forever. Not a reason not to build
  aliases; a reason to design their invalidation rule deliberately
  rather than assume permanence.

## A genuinely poor-quality real photo, and a real, significant bug it found (2026-07-25)

**The real test**: an actual, physical delivery note from a brand-new
supplier (Belgotex, never mentioned before tonight), photographed on
Pierre's own phone — genuinely blurry, shot at an angle, partially
obscured by a dark object, real ambient lighting. Not a clean, staged
test image.

**The critical, actionable data proved reliable across repeated real
extraction — the peripheral data honestly didn't.** Item number,
description, ordered/delivered quantities, and the supplier's own name
came back identical and correct on two separate real vision passes
against the same photo. The one detail that genuinely varied was the
street address — "80 Commercia Road," then "80 Comrie Road" on a
second pass, neither matching this project's own reading of "20
Chesterfield Road" from the same image. A real, honest finding worth
keeping in mind going forward: vision extraction on a genuinely poor
image can be unreliable on details that never touch any real business
logic, while staying reliable on the fields that actually drive real
decisions.

**The real, significant bug this test found, worth recording
precisely.** This document is a real delivery note — no pricing
anywhere on it at all. The existing photo/document ingestion logic had
only ever been built and tested against real supplier invoices, and
unconditionally assumed every photographed supplier document was one.
`extractSupplierInvoice` correctly refused to invent a price — every
matched line item came back with `unit_price_billed: null`, exactly as
it should for a document with no price on it — but the result still
got held as a real, guard()'d "supplier_invoice" pending action, which
would have created an invalid expense with no real basis had it been
confirmed. Caught before confirming anything, by inspecting the real,
raw pending-action payload directly rather than assuming either way.

**The real fix**: both `/files/photo` and `/files/document` now check
whether any matched line item has real, non-null pricing before
deciding. None does — a genuine delivery note — and the document is
now correctly routed through real GRN extraction and recorded directly,
unguarded, matching GRN's own precedent exactly (quantity-only, no
money moving). Real pricing on at least one item still correctly takes
the existing, guard()'d supplier-invoice path.

**Verified completely, end to end, with the same real photo
re-uploaded after the fix**: `supplierInvoiceAction: null`,
`goodsReceivedAction: {grnId: 6}` — and the real, stored GRN data
confirmed exactly right: `quantity_received: 3.1, quantity_ordered:
3.1, variance: 0`, matching the physical document precisely.

## Two real findings on the pending-confirmation stamp, both deferred on purpose (2026-08-08)

A real, concrete example surfaced the on-device speech accuracy
tradeoff accepted when choosing on-device recognition as authoritative
over server-side transcription: an address captured as "eshawi"
instead of "Eshowe." Investigating it turned up two separate, real
findings — both explicitly deferred, not forgotten, "nothing is
breaking, mark it as future polish."

**Editability isn't just a frontend question.** `_resolvePendingItem`
posts to `/actions/{id}/confirm` with no request body at all — a pure
boolean signal telling the backend to commit whatever it already has
staged. There is currently no way for the client to send a corrected
value alongside a confirm. Adding a text field to the stamp without
also changing what confirm sends would be actively worse than doing
nothing — it would look edited and silently save the original, wrong
value anyway, on exactly the class of action `guard()` exists to
protect. Real edit-before-confirm needs the backend endpoint to accept
an edited value too; that's cross-stack work, not something to build
from the frontend alone. The honest, zero-risk path that already works
today with no code changes: reject, then say the correct value again.

**The stamp's visual language doesn't match what it's protecting.**
The original design comment calls it a "dashed-ink stamp," but the
actual border is a plain solid 2px line — the dashed texture was never
built. Pending items render in `_stampRed`, the app's main red, bold
all-caps label, solid border — Pierre's own words: "very obtrusive...
looks intimidating." Worth stating precisely why: a pending
confirmation is the *safe* thing happening, the system pausing before
committing anything — but the visual language borrowed is error/danger
styling, not "please check this." Real candidate directions, not yet
chosen: drop the alarm-red for a neutral or warm tone and reserve red
for actual failures; build the dashed texture the original concept
called for; or question whether the deliberate slight rotation is
earning its cost, since it's likely the most direct driver of "looks
skew" even though it was intentional.

## The real transcription source found — and the fix that actually followed from it

**The real, honest starting point, again:** the interaction_edges test earlier tonight produced "Sipo," "sipo," and "Sepo" as three separate people, all really meaning the same real installer already on file as "Sipho." The instinct was to look at server-side Whisper first — reasonable, since that's the transcription code visible in `ai.ts`.

**Real, direct check before building anything: no audio from tonight was ever in R2.** `/debug/list-audio`'s most recent file was from 2026-08-14, a month old. That's real, confirmed evidence — not a guess — that tonight's messages went through `/messages/text`, which takes plain text directly and never touches `transcribe()` or Whisper at all. Traced further, directly: `app/lib/main.dart` calls the on-device `speech_to_text` package's `listen()`, with no `localeId` and no other option set, and posts the recognized text straight to `/messages/text`. The actual source of tonight's confusion was the phone's own on-device recognizer, a genuinely different system from anything in the Worker.

**Checked directly before concluding anything: `speech_to_text`'s own public API (`SpeechListenOptions`) has no vocabulary or biasing option at all** — only `cancelOnError`, `partialResults`, `onDevice`, `listenMode`, `sampleRate`, `autoPunctuation`, `enableHapticFeedback`. That real gate closed, not assumed closed.

**The real fix that followed: a phonetic pass, verified by hand before writing a line of code.** Standard Soundex encodes "Sipho," "Sipo," and "Sepo" all to `S100` — the exact real cluster from tonight. Checked directly against the earlier, real Andre/Juandre bug before trusting this: those encode to `A536` and `J536` — different first letters, genuinely different codes, so this addition cannot reopen that fix. Wired into `reconcilePerson`'s existing final fallback, reached only when no exact or whole-word match exists — and, same as every other real candidate list in that function, a phonetic hit never auto-matches. It only ever returns `ambiguous`, which — because of the holdForConfirmation wiring from earlier tonight — now correctly asks instead of silently creating another duplicate.

**Real, honest limit worth keeping on record:** Soundex won't save the worst case from tonight — "Cpol" is too far a phonetic stretch from "Sipho" for any string-based technique to bridge. That's real evidence the on-device recognizer can still produce something no downstream fix will catch; worth remembering the next time a name lands unrecognizably wrong rather than just oddly wrong.

**Also built alongside this, real and separate:** `/debug/reprocess-turbo`, a read-only comparison between the live base Whisper model and `whisper-large-v3-turbo` + a real `initial_prompt` built from this business's actual known names. Confirmed same price either way ($0.0005/audio minute, same shared free daily neuron pool everything else already draws from). Still untested against a real recording as of this entry — it defends the separate, real `/files/audio` "Talk mode" path, not tonight's actual bug, and shouldn't be mistaken for having fixed tonight's issue.

---

## The multi-candidate confirm fix, the fragmentation it caught, and a real, reusable merge mechanism

**The real, honest starting point:** action #114, a genuine two-candidate `ambiguous_person` hold ("Bon hotel waterfront" against "SCHOONIES SEWE T/A BON WATERFRONT" and "Bon Hotel Empangeni"), had no way to be answered correctly — CONFIRM/REJECT could only express yes/no, never "the first one." Checked directly rather than assumed: it had already been resolved by REJECT, which — correctly, by its own design — created a brand-new customer rather than guessing. Then a follow-up capture did the same thing again. Real result, live, in one evening: one real business split across three separate customer records (41, 215, 216).

**The real, reusable fix, not a one-off patch:** the `ambiguous_person` CONFIRM handler now accepts an optional `personId` in the request body. If it matches one of the action's real candidates, that one gets used regardless of how many candidates exist. The single-candidate case is completely unchanged when no `personId` is sent. Usable today via a direct call even with no picker UI built — the same real mechanism a future picker would call, not a separate path to keep in sync later.

**The real cleanup that followed, built the same way everything else tonight was built — audit trail, not deletion:** a new, reusable `/debug/merge-customers` endpoint repoints every real, live-state table that references `customer_id` — checked directly, not assumed: `payments`, `expenses`, `invoices`, `quotations`, `stock_usage_log`, `snags`, `projects`, `leads`, `job_scopes`, `tasks` — from a losing id onto a surviving one. Deliberately does not touch `captures.customer_id`: a capture is the immutable record of what was actually believed true at the time it was made, same discipline as everything else in this project that refuses to rewrite raw history. The losing customer row is never deleted, only marked via a new, nullable `merged_into_customer_id` column, so the fact a merge happened — and into what — stays real and inspectable rather than silently erased.

**Confirmed working, real data, not assumed:** 215 and 216 merged into 41. Real per-table output showed exactly `job_scopes: 1` for each merge, zeros everywhere else — correct, since neither had ever touched an invoice, payment, or anything beyond the one job scope each had created. Verified after the fact, directly: job scopes 47, 55, and 56 all now sit under customer 41, "SCHOONIES SEWE T/A BON WATERFRONT," one real business, correctly unified.

---

## A real extraction failure caught deterministically — a known installer's name eating the real customer

**The real, honest starting point:** "let's schedule stylish for the bon waterfront installation" produced `customer_name: "Stylish"`, `character_name: null` — asking "is Stylish now a customer too?", the wrong question entirely. Traced directly against three real payloads side by side: two earlier phrasings ("...to install for...") extracted correctly every time; the moment that explicit verb was missing, "bon waterfront" — the real customer — wasn't captured as *any* field at all, not just mislabeled. A field swap couldn't have fixed this; there was nothing to swap into.

**The real, deterministic fix, not a prompt tweak alone:** reuses `checkCrossRoleCollision`'s own result rather than a new query. When a `work_observation` message names someone already on file as a character, with no `character_name` of its own, that's real, strong evidence the extraction dropped the actual customer — not a genuine "this installer is now also a customer" case. Responds honestly instead of asking the wrong question: *"'Stylish' is already on file as someone who does the work, not a customer — that might not have come through fully. Try saying it again?"* No pending action created, nothing to salvage — trusts a clean re-say the same way it already worked twice earlier.

**Confirmed working, real data:** the exact failing phrase, said again, produced the honest message with no Confirm/Reject shown at all — correct, since nothing was created.

**Real, named limit, on record rather than overstated:** this catches the failure after the fact; it doesn't fix the underlying language-understanding step, which is probabilistic and can mis-parse this sentence shape again in some other form. This is a safety net for one confirmed class of failure, not a guarantee against all of them.

---

## forget_last and the honest "Got it." fix, both confirmed working on real messages

**forget_last:** real register-clearing test — a customer name set the register, "forget that, never mind" followed, response came back as a plain "Okay." Confirmed directly: `/debug/selections` came back empty afterward, proving the register genuinely cleared rather than just appearing to.

**The honest fallback:** "for the flooring," said alone with no real customer or action attached, returned *"I didn't catch anything there I could act on"* — the exact honest message built to replace the old confident "Got it." for a message that genuinely captured nothing. No false success, no silent failure.

Both items closed and confirmed on real device tests, not just deploy success.

---

## Step 2 of the pending redesign — gesture graded by real stakes, confirmed working

**The real, honest starting point:** a full sweep found 12 distinct pending action types across 20 real `holdForConfirmation` call sites in this codebase — not just the three types touched earlier tonight. Grading a gesture by "stakes" only means something if every type is correctly classified, and only three had ever actually been read.

**The real, deliberate design choice, argued through before writing anything:** starting from an empty "needs a hold" list and defaulting everything else to a tap would silently leave the other 11 types — including every financial document type: payment, invoice, quotation, expense, supplier invoice, purchase order, variance disposition — exactly as easy to mis-tap as today, dressed up as if they'd been reviewed when they hadn't. Built the other way around instead: hold is the floor for everything, and a type only drops to a quick tap once it's individually reviewed and confirmed low-stakes. Tonight, that's exactly one type — `job_scope_amendment`.

**The real build:** `pendingActionType` threaded through every one of `processOneExtraction`'s real return points and `processTranscript`, the same real pattern already proven for `pendingCandidates`. Client-side, `_requiresHold` is the single real gate (`true` for anything except `job_scope_amendment`), and a new `_HoldAction` widget — a quiet underline filling in under the label as it's held, cancels cleanly on early release — replaces the plain tap for everything on the safe-by-default side. Applied uniformly to the plain Confirm/Reject row and to every option in the multi-candidate picker, including "None of these."

**Confirmed working, real device tests:** a `job_scope_amendment` still resolves on a plain, quick tap, unchanged. Everything else — tested directly — does nothing at all on a quick tap; only an actual sustained hold, with the fill visibly completing, fires the real action.

---

## The BI foundation — products, reconcileProduct, and the real extraction that feeds it, confirmed working

**The real starting point:** a request for date-ranged reports and analytical queries ("most common product for a customer") led to a real, systematic audit of the data model itself, not just the report functions. `/debug/table-schema` (already real, already existed) confirmed every core transaction table already has a real `created_at` — the date-range gap is purely that report functions never filter on it, a smaller fix than first assumed. A new, temporary `/debug/description-frequency` endpoint then confirmed the real, deeper gap: `line_items.description` held job narratives ("Thabo upstairs," "Jenny's lounge"), not product references — the concept of a product didn't exist in this schema at all.

**Built the same real way as every other identity-bearing entity in this project:**
- `reconcileProduct` in `identity.ts` — exact match, then whole-word, then phonetic, mirroring `reconcilePerson` precisely, deliberately not reusing `looksLikeAName` (a people-specific heuristic that would incorrectly reject an ordinary noun like "vinyl").
- A real `products` table and `line_items.product_id`/`room` columns, added via the same `/debug/init-*` idempotent pattern as everything else.
- `extractLineItems` extended additively — `product` and `room` as new, separate, nullable fields; `description` instruction explicitly left unchanged ("should still read naturally and completely on its own, the same as always") so nothing that already reads it broke.
- `recordInvoice`/`recordQuotation` wired to a new `resolveProductId` helper: matched → real id, new → creates a real product row, ambiguous → deliberately left unlinked rather than guessed, since there's no real evidence yet of product-name collisions the way there was for people's names. `convertQuoteToInvoice`'s synthetic "balance due" line correctly left untouched — no real product is being purchased there.

**A real bug found and fixed during smoke testing, not glossed over:** the `room` column addition never actually made it into the live migration handler — an earlier push overwrote that specific edit without carrying it forward, confirmed directly by diffing against the real deployed file, not assumed. Action #129 (and a duplicate #130 created by a retry during the failure) were left genuinely stuck in `pending_actions` as a result — real data recovered via a temporary direct-call diagnostic endpoint (`/debug/retry-quotation`) rather than lost.

**Confirmed working, three real smoke tests, in order:**
1. An ordinary quotation with no product or room mentioned ("General repairs") — both fields correctly stayed null, nothing regressed.
2. A quotation with a real product and room ("vinyl," "main bedroom") — both fields populated correctly, a new real product row created.
3. The same product said differently ("vinyl flooring") on a separate quotation — resolved to the exact same `product_id`, not a second, fragmented one — proof the whole-word matching genuinely works, not exact-string luck.

---

## The products foundation, complete on both sides — real proof through the actual document-upload path

**Extended past the sell side:** `po_line_items.product_id` and `supplier_invoice_line_items.product_id` added, mirroring the customer-facing work exactly. `recordPurchaseOrder` resolves a real product via the same `resolveProductId` helper the sell side already uses. `recordSupplierInvoice` deliberately doesn't re-resolve — it inherits `product_id` directly from the matched PO line, since a supplier invoice is always reconciled against a PO line that already has this once it's been ordered.

**Tested through the real, physical pathway a supplier invoice actually arrives by, not just a spoken sentence:** a realistic Floornet invoice PDF generated to match a real placed PO exactly (50 sqm vinyl, no variance, isolating the one real question — does `product_id` inherit correctly). Uploaded through the app's real document path.

**A real, honest finding along the way, not a bug:** the first upload attempt, with no caption, correctly did nothing beyond storing the file — confirmed directly against the code, this is a deliberate design principle ("never guess a subject from the file itself, only ever from something actually said about it"), not a missed case. The supplier's name being printed on the letterhead was never going to be enough on its own. Re-uploaded with a caption naming the supplier, which correctly triggered the real chain: find Floornet's open PO, extract the invoice against its real line items, hold for confirmation.

**Confirmed working, real device test, the complete real chain:** the new supplier invoice line item shows `product_id: 1`, `product_name: "vinyl"` — the exact same product as the original purchase order and every customer-facing quotation earlier tonight. One real product, one real identity, reachable from voice, text, and a genuine uploaded document, on both the buy side and the sell side. The products foundation is complete.

---

## A real, live splitIntoTopics bug — fragmentation, wrong pricing, and why the first fix wasn't enough

**The real starting point:** a real, live dictation for Dr Van der Walt —
four room measurements (3x3 store, 1.2x1.2 kitchen, 7x5 main, 3.5x2.5)
followed by the customer's name and a per-square-meter price — produced
three separate job scopes, one component each, and no quotation at all.
Traced directly, not guessed: `extractMultipleIntents` calls
`splitIntoTopics` first, then runs extraction separately on each
resulting piece — and `splitIntoTopics` had wrongly treated each bare
room measurement as its own topic, since nothing grammatically tied them
together the way the existing July fix's "and"-joined example did.
`extractWorkObservation`'s own `components` field was already correctly
designed as an array, built to hold every measured part of one job — it
never got the chance, because the input was fragmented before it ever
ran.

**First fix, a prompt addition — insufficient, confirmed by a real,
live retest, not assumed adequate:** a new rule and a new example added
to `splitIntoTopics`'s prompt, teaching it that a bare sequence of
room-plus-dimension statements is still building up ONE observation, the
same as if "and" had joined them. Typechecked, deployed, verified through
CI — and then redictating the same real message still produced five
fragmented job scopes sharing one `capture_id`, not one. The earlier
"and" bug had a concrete, syntactic trigger to key off; this pattern has
none, and the model didn't reliably make the same nuanced judgment call
a second time even with explicit new instructions.

**The real, working fix — deterministic, not another prompt attempt:**
`mergeBareMeasurementFragments` in `ai.ts`, run on `splitIntoTopics`'s
output before extraction. A short fragment (six words or fewer)
containing a real dimension pattern and nothing else is never mistaken
for a complete, standalone topic, and gets merged with whatever segment
follows it — almost always the one supplying the missing customer and
price. Deliberately conservative in one direction only: the real risk
accepted is over-merging two genuinely separate, back-to-back bare
room-quote jobs, rarer and far less costly than the silent fragmentation
this replaces. Verified with a real, standalone test extracted directly
from the source — the exact live failure, the existing "and"-joined
case, unrelated real topics, and a complete separate quote that happens
to contain a dimension, all behaving correctly, 5/5.

**Confirmed live, the real way, after a real false start:** the first
retest showed the identical old data — same ids, same timestamps down to
the second — because no new dictation had actually happened; caught by
checking the real timestamps rather than trusting the report of a
retest. Once genuinely redictated fresh: one job scope, four real
components with correct areas (9, 1.44, 35, 8.75 sqm), and Quotation #29
— R750/m² correctly applied per room, R40,642.50 subtotal, R46,738.875
total. The quotation math was never a second, separate bug — it was a
downstream symptom of the same fragmentation; once the real, complete
set of components reached the pricing step together, the math was
correct on its own.

---

## Date-ranging in the report functions, built and confirmed live — the first real prerequisite for conversational BI

**The real starting point:** `CONVERSATIONAL_BI_ARCHITECTURE.md` named date-ranging as the missing foundation under its flagship example, "compare April to March": every report function was all-time only, with no date filter anywhere in the codebase. Picked as the smallest, most contained item on the remaining-work list.

**What was built:** an optional `DateRange` (`from`/`to`, inclusive, `YYYY-MM-DD`) on `getProfitAndLoss`, `getProfitAndLossSummary`, `getFinancialSnapshot`, `getExpenseSummary` and `getQuotationsSummary`, plus `parseDateRange` for validation and a read-only `GET /debug/profit-and-loss?from=&to=` route for live checking. With no range, every function behaves exactly as before, so no existing caller changed.

**Two real decisions, named rather than buried:**
(1) *Timezone.* `created_at` is stored in UTC (`datetime('now')`), but a business month is a South African local month. South Africa is a fixed UTC+2 with no daylight saving, so each local calendar day is converted to an exact half-open UTC window. A record made at 23:30 local on 31 March counts as March, not April.
(2) *Which date.* Ranges apply to `created_at`, the date a record was entered, because it is the only date every one of these tables genuinely has. Ranged output says so in a note. A later CSV import of historical invoices would land in the month it was imported, not the month the invoice was originally issued. Real business dates (invoice date, payment date) would be their own, separate piece of work.

Malformed, impossible (`2026-02-30`) or reversed dates throw a readable error rather than silently falling back to all-time, since a plausible-looking wrong report is worse than a visible failure. Dates are validated and bound as parameters, never interpolated into SQL.

**Verified, the real way:** typecheck clean against the baseline (44 known, 0 new), role matrix 165/165, and 10 checks against a real SQLite database, including the exact midnight boundaries in both directions, a Feb + Mar + Apr partition that sums to the all-time total, single-day and open-ended ranges, an empty period returning zeros rather than an error, and deep-equality of every function's no-range output against the original code. Diffed against a fresh fetch before each push; CI green on both pushes (Typecheck, Role-matrix, Deploy).

**Confirmed live:** all-time figures matched the previous output; a full-2026 range matched all-time (all current data is from 2026); October 2026 returned R98,000 revenue against R10.8M all-time, which is the Thanda Royal invoice from the confirm-guidance fix, so a fresh, distinguishable result rather than a stale one; a malformed date returned a 400.

**Noticed along the way, not touched:** the all-time P&L shows `materials` at R-500, a negative expense, which pulls Cost of Sales below zero. Likely a credit or refund entered as an expense, but not traced yet. Worth a look before the BI layer reports on it. Also not done: the P&L PDF does not take a range yet, and the aged debtors/creditors reports are "as at today" by nature, so ranging does not apply to them.

**What this unblocks:** the BI document's second prerequisite, grouping by product rather than the unpopulated category column.


---

## processOneExtraction validation steps — done; the real shape is different from the plan in four ways

**The real starting point:** `PROCESS_ONE_EXTRACTION_REWRITE.md` named four validation steps to complete before any code moves. All four are done, against the real code, and recorded in full at the end of that document. No production code was changed.

**What the evidence changed.** (1) `ProcessingResult` cannot be a single outcome: one call can hold a quotation or invoice *and* record a job scope; the function also returns early from 10 places, and `payment` has no Pass 2 branch of its own (it relies on a catch-all). (2) The six-group split does not cohere: `invoice`, `price_scope` and `work_observation` each carry their own, differently-behaving copy of the same observation-recording block, and three real intents (stock) plus the 236-line `lookup` have no home. (3) `INTENT_CAPABILITIES` as proposed is insufficient: the creation gate is a default-open denylist where REST is default-deny, `purchase_order` is a direct write whose creation gate is its only gate (the earlier "already gated on confirm" note was wrong for it), and intent is not action type. (4) The creation gate has no test coverage; the 165-case matrix compiles only `auth.ts`.

**Verification:** the analysis is mechanical (TypeScript compiler AST over the real `index.ts`; capability tables loaded from the compiled real `auth.ts`), with items traced only by reading marked as such. One possible bug, an invoice hold orphaned by the amendment early-return, is recorded as unreproduced.

**Four decisions left to Pierre** are listed at the end of the rewrite document; the safe first step regardless of those answers is Phase 0: `INTENT_RULES` in `auth.ts`, behaviour-identical, with the existing test harness extended to cover it.


---

## The confirm-guidance client fix, confirmed live on the rebuilt app

**Confirmed, the real way, after the Codemagic rebuild:** with the rebuilt app installed, "invoice stylish R500" (a name already on file as a character) correctly raised the identity-collision question (action #141). Tapping Confirm then showed the server's own follow-up message on screen, "Invoice noted for stylish of R500 — needs your confirmation (action #142) before it's recorded.", and the replayed invoice appeared as its own new pending action, exactly the case that used to look like a silent failure. This closes the fix recorded under "the app silently discarded the server's own confirm guidance"; it was previously deployed but not verified on a device.

**Two small things observed, neither a defect in the fix:** the customer row created by the confirm carries the spoken casing ("stylish", lower case) rather than the character's "Stylish", since the replay uses the name as extracted; this is cosmetic and the case-insensitive matcher now treats the two as the same name. And the test left a real customer row and a pending test invoice (#142) that need rejecting or merging by hand.


---

## Phase 0 of the processOneExtraction work: one exhaustive permission table, and three decisions applied

**The real starting point:** the validation results in `PROCESS_ONE_EXTRACTION_REWRITE.md` found that creation-time permissions were a hand-kept list in `index.ts` that was open by default, with no test coverage (the 165-case role matrix compiled `auth.ts` only), and that it ran *after* the name-resolution preamble, which can write. Pierre answered the four open decisions: installers may dictate goods received; gate creation for money and stock only; move the check ahead of customer creation; the scheduling-labelled-as-invoice question was set aside as unproven.

**Phase 0a — behaviour identical, deployed and verified.** `INTENT_RULES` in `auth.ts`, typed `Record<intent, ...>` so an intent added to the union in `types.ts` without a row is a compile error, and asserted again by the test. Every intent lists what held actions it can produce and who may create it, with "open" always a written-down choice. `index.ts` now asks `intentCreationRefusal()` instead of two hand-kept checks, and the old `FINANCIAL_WRITE_INTENTS` list is gone (the test fails if it comes back). Verified by comparing the new table against the old logic for every intent, for owner, accountant, installer and an unknown role, plus null, empty and hostile values such as `constructor` and `__proto__`.

**Phase 0c — decisions 1 and 2, as separate, named differences.** `goods_received` creation now accepts `can_manage_invoices` or `can_know_materials`, matching confirmation, so the "known mismatch" reason on that row was deleted rather than kept. The three stock intents are gated with `can_know_materials` (the capability the REST layer already uses for `/stock`); owner, accountant and installer all hold it, so this changes nothing in practice and makes the rule explicit. Every intended difference from the old logic is listed by name in the test (`DECIDED_DIFFERENCES`); anything not listed must still match the old behaviour exactly.

**Phase 0b — decision 3, as its own commit.** The check now runs before any name is looked up or created. Previously a refused role could still leave a real customer row behind, because `reconcileCustomer` inserts one for an unknown name and the identity checks can raise held actions before the old gate ran. The refusal now carries `customer: null, character: null`. The test asserts the gate sits before `reconcileCustomer`, `reconcileCharacter`, `holdForConfirmation`, `setSelection` and `updateCaptureHint` inside the function, by source order.

**Verification:** the role-matrix suite grew from 165 to 386 checks. Seven deliberate breakages of the rules (a removed row, `purchase_order` made open, a deleted reason, an orphan row, a typo in a produced action type, the old list reintroduced, a wrong capability on `lose_lead`) and the old gate ordering were each confirmed to make it fail. Typecheck unchanged at the 44 tolerated baseline, CI green on every push.

**Not verified live, stated plainly:** only the owner role can be exercised from the app. The refusal paths and the installer goods-received change are proven by tests against the real tables, not by a live installer session.

**Still open:** the upload path (`POST /files/document`) does not use this table. By decision 2 it should: an uploaded priced supplier invoice creates a held `supplier_invoice` for any member (money), while an uploaded delivery note records a goods-received note directly (stock, which installers are now allowed). Gating the former is a behaviour change on that path and has not been done.


---

## The upload path now uses the same permission table

**The real starting point:** Phase 0 left one gap on purpose: `POST /files/document` and `POST /files/photo` did not use `INTENT_RULES`. Traced by reading, they let any member trigger three things: a held supplier invoice (money), a goods-received note recorded directly with no confirmation (stock), and a supplier statement comparison. The last was not on the earlier list: it returns both the supplier's claimed balance and the real amount owed in its response, and installers cannot see supplier balances anywhere else (`/embers/suppliers` needs `can_manage_invoices`), so it was a money read open to everyone.

**What was built:** both handlers read the caller's capabilities and ask the same table, keyed by what the upload would do (`supplier_invoice`, `goods_received`, `supplier_statement`), because they decide by the supplier an upload resolves to and not by a spoken intent. Under Pierre's decisions: installers may upload a delivery note (recorded as a goods-received note) but not a priced supplier invoice or a statement; owner and accountant are unchanged. The file and capture are always stored. A refused upload now carries `refusal` in its response. `supplier_statement` became a gated money row, which also means a *spoken* statement from an installer is refused (it recorded nothing before).

**Verified:** the role-matrix suite is now 412 checks: the three outputs for each role against the real table, source-pattern guards that both handlers keep every refusal branch ahead of its write, and `supplier_statement` listed by name as a decided difference. Each guard was removed in turn, in each handler, and the suite failed every time (the first photo-handler checks accidentally hit the document handler, so they were redone against the photo handler specifically). Typecheck unchanged at the 44 tolerated baseline; CI green on both deploys.

**Not verified live, and one known gap:** only the owner can be exercised from the app, so the refusals are proven by tests against the real tables, not a live installer session. And the app ignores `refusal`: `main.dart` falls through to "Stored — nothing real to reconcile it against yet." for a refused upload. That is misleading but claims nothing false. Showing the real reason is a two-line change in `main.dart` that needs a Codemagic rebuild; not made.

**Deliberately not changed:** the upload handlers still call `reconcileCustomer` and `reconcileCharacter` before anything is gated, which can create a customer or character row from a caption. Customers and characters are neither money nor stock, so by the decision that was left alone.


---

## Rewrite Phase 1: the contract the function never had, as scaffolding nothing calls

**Re-measured first, because the function had changed:** `processOneExtraction` is now lines 183 to 1938 (1,756 lines). It still returns through one 9-field shape from **10 places**: 9 early returns (the permission refusal, forget-last, the identity and ambiguity holds, two job-scope amendment holds) and one final. Phase 0 had merged the two permission gates into one, which is why the early-return count dropped by one. The two-pass structure and the shared state are unchanged (`pendingActionId` and `pendingActionType` still have 10 writers; `customer` and `character` 2; `workObservationResult` 2).

**What the real return sites turned out to obey, found by reading all ten:** a strict pattern, which is what makes a lossless contract possible. With no action id, the type, candidates and changes are all null. An action id always comes with its type. Candidates only ever accompany an `ambiguous_person` hold and changes only a `job_scope_amendment` hold. Only the final return carries a fact hold or a recorded job scope. Every assignment of `pendingActionId` is paired with one of `pendingActionType`.

**What was built (`worker/src/intents/`, nothing in the live code calls it):**
- `result.ts`: `LegacyProcessResult` (the live shape, named and unchanged), the new `ProcessingResult` (a held action carrying its type, candidates and changes; a separate fact hold; a list of recorded effects; the message), `legacyResultIssues`, and the two adapters. The adapters are lossless over every well-formed result and **refuse anything that breaks the rules** (a `MalformedLegacyResult` error), so a drift in the real function shows as an error and not a plausible wrong answer. One call can both hold an action and record something, which is why recorded effects are a list and not a single outcome.
- `dispatcher.ts`: `ProcessingInput` (the eight positional arguments as one object), `ResolvedExtraction`, the handler type, an adapter that wraps the live function (passed in, never imported, so no import cycle with `index.ts` is possible), and `INTENT_GROUP`: the planned grouping as data, exhaustive over the intent union. It is the corrected plan from the validation results (invoice, price_scope and work_observation as one group; stock and lookup given homes; snags with leads), not the original six.

**A gap found along the way:** the typecheck's `include` was `src/*.ts`, which is not recursive, so anything in `src/intents/` would have silently escaped it. Proven with a deliberate type error that the old setting missed and the new one (`src/**/*.ts`) catches. Widened as part of this change; the tolerated-error baseline is unchanged.

**Verified:** typecheck unchanged against the baseline; the suite is 713 checks, 105 of them new (their own file, run from the existing CI step so the pipeline did not change). The round trip is checked to be the identity over 432 well-formed results in both directions; six kinds of malformed result are refused; the ten real return sites are checked against the rules above, with a tripwire that counts object returns in any formatting (a single-line return escaped the first version of it, found by mutation); the adapter's parameter order and the legacy type's field names and nullability are compared with the live function's, so neither can drift unnoticed; the grouping is checked exhaustive; and a test fails if anything outside `src/intents` imports the scaffold. Twenty deliberate breakages were each caught; three of my own mutations were initially invalid or too weak (one crashed the build instead of testing behaviour, one return form escaped the tripwire) and were redone. CI green on all five pushes, the last of which ran the new tests for the first time.

**Not done, deliberately:** no handler exists, nothing calls the scaffold, the live function was not touched. Phase 2 is the characterization harness. One real constraint on it: CI runs Node 20, which lacks `node:sqlite`, so tests that need a real database can run locally but not in CI unless the pipeline's Node version is raised.


---

## Rewrite Phase 2: the characterization harness, and the first thing it found

**Pipeline:** raised to Node 22 (the workflow edit was permitted and the full pipeline, deploy included, passed), so tests can use `node:sqlite` and a real database.

**The harness (`tools/harness.js`, `tools/characterization.test.js`, `tools/cases/`, `tools/golden/`):** runs the **real** `processOneExtraction`, unmodified, against a real SQLite database built from the live baseline schema (`worker/migrations/0001_baseline.sql`, captured from the live database's own `sqlite_master`), with a scripted AI that **fails loudly on any call nobody planned for** (embeddings always succeed, as in production), in-memory stand-ins for the notes store, the file store and the vector index, and a **frozen clock** (the function stamps times into notes and puts today's date in a note's key, so a recording made today would not match tomorrow's). The function is exposed by an in-memory esbuild transform of `index.ts`, so the live code is untouched. Each case records what the function returns and exactly which rows, notes and vectors it wrote. The recordings in `tools/golden/` are the equivalence matrix the rewritten handlers must reproduce; when behaviour is changed on purpose, `GOLDEN_UPDATE=1` regenerates them and the diff in the commit is the review. Recorded so far: the payments group (24 cases: payment, expense and supplier payment across owner, accountant, installer and a role with no permissions, and across existing, new, case-variant and near-match names) and `convert_quote` (5 cases). Stable across repeated runs and across machines (reproduced in CI).

**What it found: supplier payments leaked into free-text notes.** The recordings showed a dictated "paid Floornet R10000" being copied into the supplier's note, and with no supplier named into the day's note; payments and expenses did not do this. The cause was the third hand-kept list in the function: `hasStructuredHomeAlready`, a list of six intents added in the 2026-07-17 fix for payments, to which the money intents added later were never added. Reproduced end to end with the harness: an **installer's** lookup of that supplier was built from the note containing the amount, though installers cannot see supplier payments anywhere else. A second path leaked the same way: `convert_quote` wrote its words ("she paid 30 percent upfront") into a note queue. Not every odd-looking recording was a bug: a payment with no amount is held on purpose (`payments.amount` is nullable and `recordPayment` is typed to accept no amount), which was checked in the code before saying anything.

**The fix:** the list is gone. `intentKeepsOutOfNotes` (auth.ts) derives the answer from `INTENT_RULES`: any intent that needs `can_manage_invoices` to create is money and keeps its words out of ungated notes, plus `work_observation`, which has structured storage though it is open. That adds supplier payment, supplier invoice, purchase order, credit, quote conversion, delivery and spoken supplier statement, and a new gated money intent is covered the moment it is gated. The regenerated recordings changed **only** the nine cases that leaked (five supplier payments, four quote conversions); every reply, hold and resolved name is identical before and after, which was checked mechanically. A test fails if `index.ts` ever carries its own list again.

**Verified:** typecheck unchanged; 845 checks. The suite was mutation-tested: changing a reply, a hold type, a permission, an expense's requirements, removing a note write, reverting to the old six-intent list, and un-freezing the clock were each detected. Two of my own mutations were false alarms (one could not find its target text, one hit another group's wording) and were redone against the right targets.

**An incident, recorded because it is a process lesson:** while pushing this change GitHub's API stopped responding mid-batch. My script did not stop at the first failed push, so `index.ts` and the tests landed without `auth.ts` (which defines the function `index.ts` now imports). That commit failed its typecheck, so the pipeline never deployed it and production stayed on the last good build; the missing file was then pushed over plain git (a different host, which still worked) and the pipeline passed. The lesson is applied: multi-file changes now go as **one atomic commit over git**, so a half-applied state cannot exist, and the push step stops at the first failure.

**Not done:** only two groups are recorded. The groups that call a model (procurement, invoicing and pricing, observations, lookups) need scripted replies and come next; stock, snags and leads, and the identity holds are further groups.


---

## Rewrite Phase 2, procurement: three more things the recordings found

The procurement group (purchase order, goods received, supplier invoice, variance disposition, and a spoken supplier statement) is recorded in 39 cases, with a scripted model, including a model that fails and a model that finds nothing, because that behaviour is part of what rewritten handlers must reproduce. Reading the recordings critically found three places where "the model gave us nothing usable" was recorded as if it were something:

1. **A model failure silently closed a shortage.** With the model down, a variance disposition row was written with no reason, no resolution and no credit. Any disposition counts as resolved, so the shortage dropped off the open list and the exception report with nothing actually recorded (the reply even said "Noted for Underlay, no reason stated"). Now nothing is written and the reply asks what happened (why it happened, back order or credit).
2. **A supplier invoice with no lines was held for confirmation**, which would have recorded an invoice of nothing. Now nothing is held and the reply says it could not make out any items.
3. **A purchase order with no lines was recorded**, and as the supplier's most recent order it then became what a later supplier invoice is checked against, which matches nothing. Now nothing is recorded and the reply says so.

All three now behave like deliveries already did. Verified in the commit history: the first commit records today's behaviour, the second changes the code and the recordings, and the recording diff is **exactly four of the 39 cases** (the order with no items, the order when the model fails, the invoice when the model fails, the disposition when the model fails); the other 35 are identical, checked mechanically. Each fix was mutation-tested in both directions (removing it fails; making it too aggressive, for example refusing a reason with no resolution or refusing a one-item order, also fails). 964 checks.

**Not changed, noted for a decision:** a disposition that records only a reason (no resolution) also counts as resolved, so it too leaves the open list. That looks deliberate (naming why a shortage happened is documentation) and was left alone, but it means a shortage can leave the exception report without being credited or back-ordered. A model that fails during a **goods received** or **supplier invoice with lines** reading is handled, but a model that fails during a purchase-order reading no longer records anything, so a person dictating an order while the model is down must say it again.


---

## Rewrite Phase 2, invoicing and pricing: a suspected bug confirmed, a crash found, two silent replies fixed

Recorded: `invoice`, `quotation` and `price_scope` in 29 cases (with the three readers scripted: the job-observation reader, the quotation line-item reader and the scope-pricing reader), across owner, accountant and installer, with and without an amount, a task, an installer, a date, an existing job scope, and with each model failing. `work_observation`, the third member of this entangled group, is recorded separately.

**Confirmed by reproduction: the invoice orphan.** It had been suspected since the validation analysis, from reading, and never reproduced. With an amount in the sentence and a date-only change for a customer who already has a job scope, the function creates **two** pending actions (the invoice, then the amendment question) and replies about the amendment alone. The invoice hold exists and was never mentioned, and the app only offers buttons for the amendment. Now the reply says "Your invoice for Jenny Smith of R3000 is also waiting for confirmation (action #1)." The invoice is still reached through the Pending room rather than its own buttons (see `OPEN_QUESTIONS.md`).

**A crash found by the runner:** a `price_scope` request with no customer named **threw** (`Cannot read properties of null`). The reply for a job with nothing to price dereferenced `customer!.name`, a non-null assertion on a customer that was never named. The recording of "must not throw" failed on it, which is how it surfaced. It now gets the same honest reply as invoices, quotations and payments with no customer ("I heard a price for a job, but no customer name came through, who is it for?"). My first attempt did not work: the catch-all reply for that case sits later in the chain than the branch that crashed, so the crash still fired first; the crashing branch had to be guarded on there being a customer.

**Two silent replies:** an invoice with a named customer but no amount and nothing to record, and a quotation with no readable items and no amount, were both answered "Found existing customer: Jenny Smith.", as if they had been lookups. They now say what was heard and what is missing.

**Verified:** typecheck unchanged; 1,154 checks. The recording diff is **exactly four of the 29 cases**, 25 are identical (checked mechanically), and in all four the rows written are the same before and after: these are reply-only changes. Six deliberate breakages were each caught, in both directions (removing a fix, and making it too aggressive, for example a note about an invoice that was never held, or an amountless-invoice reply that steals the reply of a recorded job scope). The push has two commits so the history shows baseline then fix; the baseline withholds the crashing case so every commit passes.

**Not done:** `work_observation`, lookups, stock, snags and leads and the identity holds remain to be recorded.


---

## Rewrite Phase 2, work observations: a mislabelled reply and a job built from nothing

Recorded: `work_observation` in 18 cases: a job with measurements, with and without prices, for owner, accountant and installer (an installer records the job but is never priced for, shown by the pricing model not being called at all); a date-only change for a customer who already has a job (the amendment question); attaching to a sibling job or lead from the same message; an installer already booked that day; an unknown installer; a customer not on file; no customer named; a model that finds nothing, fails, or finds only an installer. This completes the entangled invoicing, pricing and observation group.

**A mislabelled reply.** When a spoken observation also priced the job, a *quotation* was held, but the reply read **"Payment noted for Jenny Smith, needs your confirmation"**. The noun was guessed from the intent, and a spoken observation is not one of the intents it knows, so it fell through to "Payment". It now comes from the type of the action actually held.

**A job built from nothing.** When the model found nothing, or failed, a job scope was recorded anyway, with no measurements, no tasks, no date and no installer. As the customer's most recent job it then became what a later "price Jenny's job" tries to price (and is told it cannot match anything). The invoice branch has always guarded against this; this branch did not. Nothing observed is not a job: nothing is recorded and the reply says what could not be made out.

**Verified:** typecheck unchanged; 1,229 checks. The recording diff is **exactly four of the 18 cases** (the two priced observations, and the two where nothing was observed); 14 are identical (checked mechanically). In the two priced cases the rows written are identical and only the noun changed; in the other two a job scope is no longer written. Five deliberate breakages were caught in both directions, including treating an installer-only or a date-only observation as "nothing" and removing the role gate on pricing. One mutation survived at first because no case had an observation with only an installer; a case was added and it is now caught.

**Not changed, recorded in `OPEN_QUESTIONS.md`:** pricing skipped without a word when the pricing model fails or finds nothing; a date spoken as an ordinal word ("the seventeenth") is not parsed to a date at all, though "the 10th" is; and a customer-less job scope is recorded when only an installer or date is heard and there is nothing to attach it to.


---

## Rewrite Phase 2, lookups: recorded, and what the recordings say about who can see what

Recorded: lookups in 36 cases, covering a material's last price, the delivery exception question, business-wide questions (which screen opens, and which facts each role's answer is built from, including follow-ups about quotations, invoices and expenses and a model that fails), a supplier or installer, a customer, and "what is on today", across owner, accountant, installer and a role with no permissions. The answer-writer is scripted to **echo the facts it is given**, so each recording shows exactly what each role's answer was built from; that is the point of recording a lookup, because the facts are where permissions are enforced. Lookups were confirmed to write nothing but the stored sentence and, for a named person, the selection context: no note, file or business row.

**No code was changed.** The lookups behave as designed. What the recordings did was make visible, for the first time in one place, how open each answer actually is. Five things are recorded in `OPEN_QUESTIONS.md` for a decision, because they are policy, not defects:

1. **An installer sees expense totals and the aged-creditors breakdown**, including what is owed to each supplier ("Floornet: R1200 total outstanding"), through a business question, because both are gated by `can_know_materials`. The supplier screen needs `can_manage_invoices`.
2. **Notes written before the notes fix still contain money**, and are still readable by an installer (a supplier note with "paid Floornet R10000" was read back to one). The earlier fix stops new leaks; it does not clean what is already stored.
3. **A material's last price (and which supplier charged it) is ungated**: any role, including one with no permissions, can ask.
4. **A person's details are shown to every role**, and `can_know_payroll` and `can_know_banking` exist but nothing in the code ever checks them. Harmless today, since no payroll data is stored, but a day rate or a bank detail saved as a "detail" would be visible to everyone.
5. Smaller: a broad financial question from an installer still opens the snapshot screen (the screen's own data is gated, so it shows nothing), and "There are 1 quotations on file" has a grammar slip.

**Verified:** typecheck unchanged; 1,376 checks; stable across runs; the whole suite runs in about 30 seconds. Two earlier lookup fixes are already covered by these recordings (the delivery exception question is permission-gated; an installer is told it is restricted).

**Not done:** stock, snags and leads, and the identity holds (the preamble that runs before every intent) remain to be recorded. After those the whole function is characterized.


---

## Rewrite Phase 2, the opening step: "forget that" could abandon anyone's pending action

The opening step of `processOneExtraction`, what runs before any intent, is recorded in 42 cases: "forget that", finding or creating a customer, finding or creating a supplier or installer, the question raised when a name belongs to someone who does the work, the question raised when a name merely sounds like someone on file (one candidate, or several), a lookup that finds and never creates, and the follow-up fallback that works out who "her" or "him" meant (from the current selection, from the conversation, or from neither), including a model that fails at either step. **With this, all of `processOneExtraction` is characterized** (about 260 cases across nine groups).

**A permission bypass: "forget that" abandoned the newest pending action of anyone's.** Recorded rows showed an installer's "forget that" (and the same from a role with no permissions) abandoning the owner's pending R98,000 invoice, which the confirm and reject routes would have refused them. The command is open to every role by design, but it never asked whose action it was abandoning. It now takes the newest pending action the caller could resolve through the normal routes, and nothing if there is none. The rule is written once (`canResolveActionType`) and a test proves it agrees with the real confirm route for every role and every action type the suite knows: the owner may resolve anything (only the owner holds `can_manage_settings`, and a type with no entry is owner-only); everyone else needs a capability listed for the type.

**Two wording faults in the collision question:** it said a person was "already on file as a **character**" (the system's own word, when it knew they were an installer or a supplier) and the reverse said "now acting as **a installer**". It now names the real relationship with the right article ("an installer", "a supplier"), and "a contact" when none is recorded.

**Verified:** typecheck unchanged; 1,853 checks. Of the 36 baseline cases exactly **five** changed (the two "forget that" cases that used to abandon the owner's invoice, and the three collision questions); 31 are identical. Six cases were added so each side of the fix is pinned (the installer takes the newest action they may resolve and skips a newer invoice; the accountant skips an owner-only action; the owner may abandon an owner-only action; and each wording variant). Seven deliberate breakages, including too-strict and too-loose versions of the rule, were caught. One batch of mutation runs exceeded the time limit and was split in two.

**What the recordings confirmed is working:** near-matches and name collisions stop and ask, and write nothing but the held question; a lookup never creates a customer or supplier; a name on file in a different case matches; a follow-up uses the current selection first, then the conversation, then gives up honestly; a model that fails at either step degrades to "I don't have anything on file"; a personal question never borrows the selection; a customer and a supplier in one message are linked.

**Recorded in `OPEN_QUESTIONS.md`:** the "current selection" (who "her" means) is one setting for the whole business, not one per person, so one person's lookups change what another person's follow-up means, and "forget that" clears it for everyone.

**What is not characterized:** only `processOneExtraction` is. Its callers are not: the splitting of a spoken message into topics, the confirm and reject routes and what they replay, and the upload handlers.


---

## A wrong declaration, found while preparing to record the callers (and my scaffold had copied it)

`processOneExtraction` declared its amendment-question changes as `{ field, oldValue, newValue }`. What it really returns, built in `checkForJobScopeAmendment`, is `{ field, label, displayValue }`; `processTranscript`, which receives it, declared the real shape. Two of the 45 "tolerated" type errors were exactly this disagreement, and a third (an argument error where `processTranscript` stores the result) had the same root cause. **My Phase 1 scaffold copied the wrong declaration** into `PendingChange`, and its drift guard could not catch it because it compared only top-level field names. The recordings, which hold the real runtime values, are what showed the true shape.

Fixed in all three places: the declared return type (a type-only change: behaviour is identical), the scaffold, and the guard, which now compares the nested shape in the scaffold, in the function's declaration and in the code that builds it (mutation-tested: changing any one of the three fails). The baseline of tolerated type errors shrank from 45 to 42. The candidates' shape (`{ id, name }`) was checked too and was right.

**Lesson, kept deliberately:** a guard that compares names but not nested shapes passes on a wrong declaration. The scaffold's earlier claim of being "lossless over the real domain" was true only at the top level.


---

## Rewrite Phase 2, the first caller: `processTranscript` recorded

`processTranscript` is what calls `processOneExtraction`: it logs the capture, asks a model to split the spoken message into topics, asks a model to read each topic, runs each through the function, attaches a new job to the customer's open project (or asks which), and joins the replies. It is recorded in 19 cases, each a whole spoken message with both models scripted. The harness gained a second kind of case (a "transcript" case, which supplies no extraction because a model reads each topic) and loads both functions from one in-memory bundle of `index.ts`; the live code is still untouched.

**Recorded and confirmed working:** one topic and several; the replies joined as a bulleted list; a topic the model cannot read becomes "I didn't catch anything there I could act on" without disturbing the others; **every way the splitter can fail** (it throws, answers with something that is not a list, an empty list, a list with a non-text item) falls back to treating the whole message as one topic, which the recordings show gives the same result as a clean one-topic message; a run of bare measurements is merged into the topic that follows it; a question and an action in one message; the audio key kept on a spoken capture; a refused money topic and an allowed snag in the same message each get their own reply; the new job is attached to the customer's one open project, asked about when there are two, and left alone when there are none.

**Recorded in `OPEN_QUESTIONS.md`, not changed:** with **two jobs in one message**, both are grouped under a brand-new project and no question is asked, even when the customer already has two open projects; with one job it asks which existing project. So the same customer is treated differently depending on how many jobs were in one sentence, and a duplicate project is created. This is a design question, not a defect I can settle.

**Verified:** 1,931 checks; all nine existing recordings are byte-identical after regeneration, which is itself a check that the new harness changes nothing. Six deliberate breakages of the caller (the reply format, the splitter fallback, which pending action is primary, never asking the project question, joining merged fragments differently, and skipping project resolution for multi-topic messages) were each caught; **one survived at first** because my only multi-topic job case created its own project, so skipping resolution made no difference, and a case with one job and an unrelated topic was added to close it.

**Not yet recorded:** the confirm and reject routes and what they replay, the upload handlers, and the route layer around them.


---

## Rewrite Phase 2, the confirm and reject routes: two ways a question could be lost

The confirm and reject routes are where a held action finally becomes a record. They are recorded in 51 cases through the **real request handler and the real authentication gate**: the harness signs a real session, seeds a real membership row, and uses the real role table, so the gate's own answers (401 signed out, 403 not a member, 403 wrong role) are part of the recordings. Each held action is created first by running the real dictation, so its stored payload is exactly what the code writes and not a hand-copied guess; the recorded writes are those of the final request only. Covered: every action type the handler knows (payment, expense, supplier payment, invoice and quotation with their signed document links, quote conversion, delivery with the stock question it raises, supplier invoice, credit, identity question, near-match question with one and several candidates, amendment, project question, customer and supplier facts, schema suggestion), confirming twice, an unknown id, a payload that cannot be read, and an unknown type.

**Two defects, both ways a question could be lost, both fixed:**

1. **A refused answer killed the question for ever.** When a near-match question had several candidates and the request did not choose one (or chose one that was not a candidate), the handler returned a 400, but it had already marked the action `processing` and never put it back. The recordings show the action changed on that 400, and a correct answer afterwards was told "action already processing". The same happened to the project question. A claim is now released on every early return that did not complete the action.
2. **The replay ran with the confirmer's permissions.** An identity or near-match question replays the original dictation when answered, using the permissions of whoever answers. An installer who confirmed a question about a payment the owner had dictated got "confirmed", a customer was created, the payment was refused by the replay, and it was **silently lost**. An installer's *reject* created a person and a customer the same way. Now the answerer's permission for the original intent is checked before anything is written: the question is put back untouched, the answerer is told why (403), and the owner can still answer it. The accountant, who may record payments, is unaffected.

**Verified:** 1,934 checks plus the new cases; the recording diff is **exactly nine of 51 cases** (the five that used to lose or stick, plus the answers that now succeed after a refused attempt), 42 identical, checked mechanically. Nine deliberate breakages (not releasing a claim in either place, releasing it as the wrong status, removing the permission check from each of the three replay paths, a refusal that still consumes the question, a refusal that never fires, and one that refuses even the owner) were caught; **one survived at first** (no case had an installer *confirming* a near-match question about a payment) and a case was added.

**A baseline that was wrong, caught and redone:** the suite replaces the global `Response` with a small stand-in at its top for its permission tests, which made every route case throw "response.text is not a function" and my first recording hold `result: null` for all 50. It was noticed because every case showed as having thrown. The suite now keeps the real `Response` and swaps it in only while a route case runs, and the baseline was re-recorded against the **original** code in a scratch copy, so the before and after are compared like for like.

**Recorded in `OPEN_QUESTIONS.md`, not changed:** answering "yes, the same person" to an identity question creates the customer (or supplier) record **unlinked** from the existing person, whereas the near-match answer links it. The 2026-07-25 comment in the code says the record is created "separately", so this may be intended, but the question itself reads "is this the *same* person". And rejecting an identity question ("someone else was meant") drops the original dictation without a word.

**Not yet recorded:** the upload handlers and the remaining routes around them.


---

## Rewrite Phase 2, the upload handlers: one lost voice note, and a 131-line duplicate

The three upload handlers (`/files/document`, `/files/photo`, `/files/audio`) are recorded in 50 cases through the real request handler. The PDFs are **real, with a real text layer**, generated with the same library the product uses, so the text extraction is exercised for real (a scanned PDF with no text layer, a plain text file, an image, and an image the vision model cannot describe are all cases). The harness gained multipart request bodies, a deterministic `randomUUID` (the handlers put a random id in the storage key and echo it in the response, so a recording would otherwise differ on every run), raw model replies (speech to text does not answer in the chat shape), and **pairs**: cases that must behave identically with each other, not only with their own recordings.

**Recorded and confirmed working:** a delivery note read from the document alone is held for confirmation, with the supplier marked as read from the document and not stated; with a caption naming the supplier it is recorded directly, and an unordered item is received and logged as an exception; an unknown issuer, an issuer that could be either of two suppliers, and an unreadable issuer each get an honest "nothing was recorded" reply; a priced supplier invoice is held; a statement is compared with the books; an installer's supplier invoice and statement are refused (the file is still stored), while an installer's delivery note is accepted, as decided; the same upload sent again is answered from the first without writing anything; a model that fails at any step degrades to "stored" with no message.

**One real defect, fixed: a voice note whose transcription failed (or came back empty) left no record at all.** The audio file was stored and the person was told it had been received, but nothing was written to the database, so nothing pointed at the file and it could never be found or retried. Documents and photos have always logged a capture before anything else; audio only did so inside a successful transcription. It now logs a capture (source `voice`, pointing at the stored file) when there is nothing to process. The response is unchanged.

**A structural finding: the 131-line supplier-document decision section exists twice**, in the document handler and again in the photo handler, **identical except for the name of one variable** (verified by diffing them). Four pairs of cases (a delivery read from the file, a caption naming the supplier, an unknown issuer, an installer's refused supplier invoice) now run the same scenario through both and must agree on the message, the refusal, the held action and the subject. Breaking only the photo copy, in two different ways, fails the pairs. This is the clearest candidate for the **first real handler move in Phase 3**: it is fully recorded, it is duplicated, and a single shared function would remove the possibility of the two ever drifting apart.

**Verified:** 2,342 checks; the recording diff for the audio fix is **exactly two of 50 cases**, 48 identical. Twelve deliberate breakages were each caught, none survived: removing the three permission refusals, recording a document-read delivery without confirmation, breaking **only the photo copy** two ways (inference and refusal) and a third (which customer a caption named), the retry answer for documents and for voice notes, ignoring the conversation sent with a voice note, reading a PDF without its spaces, and the audio fix removed or made too aggressive. Three of those were caught first by older source-pattern tests, which is the order it should be.

**Already recorded, now with a case:** a caption naming a customer who is not on file creates the customer **before any permission check**, even for an installer (item 9 in `OPEN_QUESTIONS.md`, left alone by decision).


---

## Decisions session, round 1: who can see what

Pierre went through the open questions, most serious first. Round 1 (the three access questions):

1. **Installers must not see expense totals or supplier balances.** Decided: hide both. Applied: the expense summary and the aged-creditors breakdown in a business question now need the invoicing permission, the same strength as the supplier screen, using the "restricted for your role" markers that already existed. Owner and accountant are unchanged; an installer's answer now says expense activity and supplier balances exist but are restricted. Two cases were added (an installer's and an accountant's follow-up about expenses) so each gate is pinned on its own; the recording diff is **one existing case** (the installer's narrow question) plus the two new ones, 35 identical. Five deliberate breakages were caught (either gate reverted, either over-tightened to owner-only); one of my own mutations was invalid (the accountant also holds the profit permission, so it restricted nobody) and was redone.
2. **Old notes that still hold money: left as they are.** Accepted knowingly. The earlier fix stops new leaks; notes already stored can still hold, for example, "paid Floornet R10000", and an installer can still read them.
3. **A material's last price (and the supplier): stays open to every role.**


---

## Decisions session, round 2: notes and captions

Round 2 (the remaining "who can see or create what" questions), decided by Pierre:

5. **Stock, snag and lead sentences stay out of notes too.** Applied: the seven intents (register a stock item, stock used, stock count, raise and resolve a snag, raise and lose a lead) join the explicit set of intents whose sentence is never copied into a customer's or supplier's note, because each has structured storage of its own and a note is read back to anyone who looks the person up. The recording diff is **53 of 414 cases, and in every one the only difference is notes no longer written** (69 note writes removed in total); checked mechanically: no reply, hold or other row changed in any of them, and 361 cases are identical. Three deliberate breakages were caught, including one that made it too broad (reminders, which were not decided, would have been kept out too).
6. **An upload caption is permission-checked before it creates anyone.** Applied to both the document and the photo handler: the caption gets the same check as dictation. A role that is refused (an installer whose caption says "Brand New Person lounge quote") can no longer create the customer or supplier it names; the file is still stored, still linked to someone **already on file** (finding is harmless), and the response now carries the refusal so the client can say why. A role that is allowed is unchanged: an owner's caption still creates, and so does an installer's with an **open** intent such as a note, exactly as dictation does. One existing recording changed (the installer's new-customer caption: a customer row no longer created); ten cases were added, including document-versus-photo pairs for a new customer (installer and owner) and a new supplier, so the two copies of the logic cannot drift (seven pairs in all). Five deliberate breakages were caught, including breaking **only the photo copy** for customers and for suppliers, and making it too strict (an allowed caption unable to create, a refused one losing its link to an existing customer). My first set of cases left the photo copy's supplier branch uncovered; that gap was found by asking what a photo-only breakage of that branch would do, and closed.

**Question 4 (person details and the unused pay permissions)** was answered by the permission grid: the payroll and banking switches cannot be flipped until something in the code checks them, so there is nothing to decide yet.

**Verified:** 2,696 checks; typecheck unchanged.


---

## Decisions session, round 4: nothing waiting or dropped without saying so

Round 4 (the "part of what you said got dropped silently" group), decided by Pierre:

**11. Say so when the job part of an invoice could not be read.** If the reader that pulls the installer, date and measurements out of "invoice Jenny R5000, Sepo installs Monday" fails, the invoice is still held but the reply now says: "I couldn't read any job details (measurements, an installer or a date) from that, so only the invoice was noted. Say the job part again if you want it recorded." The reader now reports when it **actually failed** (a `readFailed` flag set only in its failure path), so the note appears only then, and never when the reader worked and simply found nothing ("invoice Jenny R5000" alone says nothing extra, which a case pins). An invoice with no amount and a failed reader says so too.

**12. Say so when prices were mentioned and no quotation came of it.** A job description with prices ("lounge 5 by 4, R450 a square metre"), where the pricing reader fails, finds no priced item, or the total is nothing, now records the job and adds: "You mentioned prices, but I couldn't make out a priced item, so no quotation was made. Say the prices again against the job." A role that is never priced for (an installer) gets nothing extra; a case pins that.

**10. Show both waiting actions in the app.** The server built its list of waiting actions from each segment's primary id only, so an invoice held alongside a job-change question (the orphan found earlier) was in the reply text but in **no field at all**, and the app only ever read the primary id. Now: a segment that creates two holds carries the earlier one in an **optional** `alsoPending` field (present at that one site only, so no other result is touched), and the response carries a full ordered `pendingActions` list with each type. The app adds a Confirm and Reject for each extra item, and with more than one thing waiting it puts a short caption above each ("Job change", "Invoice", and so on). A **project question and a near-match question are deliberately not added as items**: they need a chosen project or person, so a plain Confirm would only be refused, exactly as before. The Phase 1 scaffold carries the new optional field both ways, and its drift guard now compares optional fields and extracts the interface by matching braces (its first version cut the interface short at the new field's inline braces, which the guard itself noticed).

**The property that matters:** 419 of the 448 existing recordings are **byte-identical**; 29 differ only by the added `pendingActions` key (checked mechanically, with the key stripped they equal the old recordings); 3 have a changed reply, exactly the three decided ones; 2 are new (an invoice with no amount and a failed reader, and a whole message that holds an invoice and a job-change question, showing both waiting actions in order with their types).

**Verified:** 2,811 checks; typecheck unchanged. Seven server breakages were caught: the failed-reader flag removed; the note added even when the reader worked; the pricing note removed; the pricing note shown to an installer; the invoice left out of the waiting list; the project question left out; the primary action no longer first.

**The app part is unverified on a phone, and the Dart cannot be compiled here.** It is a pure insertion of three blocks (no existing line changed), each checked for balanced brackets in place, using only identifiers already used elsewhere in the file; the web build in the pipeline is the compile check. It needs a Codemagic rebuild to appear on the phone (see `OPEN_QUESTIONS.md`).


---

## Decisions session, round 11: sensitive details, one selection per person, the mislabelled installer message

Round 11, decided by Pierre: **25.** gate the sensitive person-detail keys; **26.** one current selection per person; **27.** fix the installer message labelled "invoice" now.

**25. Pay and bank details need their own permission.** A person's saved details (cell, address, licence and so on) were shown to every role, and `can_know_payroll` and `can_know_banking` were defined but checked nowhere. Now a detail whose **key** is a **payroll** word (day rate, daily/hourly rate, salary, wage, commission, bonus, per day...) needs `can_know_payroll`, and a **banking** one (bank, bank account, account number, IBAN, swift, branch code, sort code, card number, routing...) needs `can_know_banking`, **both to be read and to be saved**. The owner and accountant have both by default; an installer sees only the ordinary details, and an installer who says "Jabulani's day rate is R600 a day" is told "Nothing was saved: pay details like a day rate or salary can only be saved by someone with payroll access." and **nothing is held** (a role that could never read it back is not left to hold it). The key is matched in whole words, so **"account manager" and "payment terms" are not sensitive** and a cell number, address, licence or skill is shown as before; a key that reads as both counts as banking. The two permissions are no longer placeholders: they are **real switches in the Permissions room**, which now has **seven** (money, debtors, profit, materials, jobs, payroll, banking), and the grid's own guards were updated to say so. A free-text note that happens to mention a bank account is not covered (only a saved detail is): see `OPEN_QUESTIONS.md`.

**26. "Her", "him" and "forget that" are each person's own.** The current selection was one setting for the whole business (a leftover from when the app had one user), so one person's lookups changed what another person's "and her balance" meant and "forget that" cleared it for everyone. It is now **one selection per signed-in member**, in a `member_selections` table created the first time it is needed (no migration; the old shared table is left alone and **no longer read, so everyone's current selection starts empty after this deploy, by design**). The email is matched ignoring case and spaces; a caller with no known email shares one anonymous selection, apart from everyone else's. "Forget that" clears the person who said it and nobody else's. This reaches every place a selection is set (a customer, a supplier or installer, and the document just made), read, or cleared.

**27. An installer's scheduling message labelled "invoice" is read as the job it is.** It used to be refused outright as money. Now, when the label is "invoice" but there is **no amount** in it, the role may not record invoices, and the role **may** record jobs, it is processed as a job. **Anything with an amount stays refused.** Job recording is open to every role in this system, so even a role with no permissions gets this treatment; my first case for that role claimed it stayed refused, which was wrong, and is corrected.

**The property that matters.** Against `main`, of **589 existing cases 362 are identical**, **217 differ only by the selection table's name and the new person column** (checked mechanically: renaming the table back and dropping the column gives the old recording), **9 differ only by the two catalog entries** in the permission grid's listing, and **1 is a deliberate change of example** (the grid's "a permission nothing uses cannot be switched" case now uses `measurements`, the one that really is unused, instead of payroll, which now is). None was removed; **18 were added** (four for what each role is shown of a person's details, six for saving them, four for selections per person, four for the installer message).

**Verified:** typecheck unchanged; **3,734 checks**, including unit tests of the key classifier against 45 keys, of what each permission shows, and of selections per person against a real SQLite database (isolation, case-insensitive email, the anonymous bucket, only your own cleared, and the old table ignored), plus a guard that the seed table equals the code's. **Eight deliberate breakages were caught:** every detail shown again; a role able to save a pay or bank detail; a key rule so broad it hides the account manager; selections stored for nobody in particular; one person's "her" read from anyone's; "forget that" clearing everyone's; an invoice with an amount read as a job; and the mislabelled message refused as money again. **Mistakes of mine on the way, all caught:** my debug-route patch aborted on a wrong anchor (nothing written); the old selection seeds needed the new table; my selection test crashed on `null` instead of failing cleanly when a mutation deleted the other person's selection (now null-safe); one mutation was invalid twice because of a bind mismatch; and my first "stays refused" case was wrong.

**Not run here:** the language model that reads "Jabulani's day rate is R600" and the mislabelled scheduling message.


---

## Decisions session, round 12: every job needs a customer, notes keep out pay and bank sentences, invoice units

Round 12, decided by Pierre: **28.** ask which customer in every case; **29.** keep pay and bank details out of notes; **30.** capture the unit on supplier invoices and convert it.

**28. A job with no customer asks which customer, in every case.** Last round only the installer-and-date-only case asked; a job with measurements or tasks but no customer was still recorded customer-less. Now the rule is the one stated: *no customer named and nothing in the same message supplies one* asks "I heard a job (1 room measured, 1 task noted), but no customer came through — which customer is it for? Nothing was recorded." (the parenthesis only when something was measured or noted; installer and date are named as before). **What "supplies one" means:** for a measured room or a task, a **job already recorded earlier in the same capture that has a customer**: the second room in "Jenny, the lounge is 5 by 4. The kitchen is 3 by 3." takes Jenny, and both jobs are filed under her (a case pins it); for an installer or a date alone, a job or lead from the same capture to attach to (unchanged). With neither, it asks and records nothing, and creates no installer.

**29. A sentence that says a pay or bank detail is kept out of notes.** **Found while testing this, and it was a hole in my own round 11:** the four recordings from that round showed the sentence "Jabulani's day rate is R600 a day" being **copied into the person's free-text notes** (a KV write readable by every role) in addition to being held as a detail, so last round's gate could be walked around, and I had recorded the leak without noticing. Now a sentence that says a bank or pay detail (a bank account, account number, IBAN, swift code, branch or sort code, card number; a day, hourly or pay rate, salary, wages, payroll; or an amount per day, hour, week or month) is **not copied into notes** on any path (a customer's, a supplier's or installer's, or a life note), and the reply says so *only when the sentence went nowhere else*: "It looks like a pay or bank detail, so it was not kept in the notes. To save it, say it as a detail (for example "Sipho's day rate is R600 a day")." A saved detail, or a refusal with its own reason, says nothing extra. It looks at the sentence, not a key, so it is deliberately plain: "Jenny's account is overdue", "payment terms", "the swift delivery" and "R450 a square metre" are ordinary and kept (the detector first read "swift" on its own as a bank word and the unit test caught it). The words stay in the raw capture.

**30. A supplier invoice billed in another unit is converted, as deliveries and stock are.** The invoice reader now captures **the unit the quantity was billed in**. When it is a recognised unit that differs from the order's, with a conversion known (either direction), **the quantity and the price per unit both convert so the line total is unchanged**: 20 boxes at R462.50 are held as **50 sqm at R185** (R9,250 either way) and the reply says "(20 boxes of Vinyl counted as 50 sqm.)"; on confirmation the variances are computed in the order's unit (a price variance of +R5 against the expected R180, in the case). With **no conversion known, nothing is held** and the question is asked once ("Vinyl was ordered in sqm but this invoice is in boxes... Say, for example, 'a box of Vinyl is 2.2 sqm'... Then say the invoice again."). A unit that was not stated or not recognised, or the same unit spelled another way, passes through exactly as before. All three entry paths (spoken, document, photo), with a document-versus-photo pair and a real PDF; a line with no price converts its quantity and stays priceless (a price is never invented).

**The property that matters.** Against `main`, of 633 recordings, **601 existing cases are identical**, **4 changed**, **2 were renamed and re-recorded** and **26 were added**. The 4 are the round 11 detail cases, and in each the only difference is the leaked note that is now gone; the 2 are the measured-room-with-no-customer cases, which now ask, as decided. Every pre-existing invoice case is byte-identical (none of their scripted readings carries a unit).

**Verified:** typecheck unchanged; **3,888 checks**, including unit tests of the sentence detector against 35 sentences and of the invoice unit check against a real SQLite database (quantity and price, the inverse conversion, no conversion, unrecognised unit, no unit, no price, and the caller's own lines never modified). **Eight deliberate breakages were caught:** a second room losing the same-message customer; a measured room recorded customer-less again; a pay sentence copied into notes again; the redundant "not kept in notes" line on a saved detail; the **too-broad** detector (the bare word "account"); an invoice that converts the quantity but not the price (so the total changes); **only the spoken path**, and **only the photo copy**, holding an invoice in an unconvertible unit.

**Not run here:** the language model that now also reads the unit off an invoice ("20 boxes at 462.50") and the one that reads each sentence; both need one real try on the phone.


---

## Follow-up to round 12: a hole in the note guard, found by independent review

I reviewed round 12 the way I review every change I did not write: a fresh checkout (typecheck unchanged, 3,888 checks, deployed), then my own probes through the real code. Round 12's finding was right and worse than described: **my own round 11 recordings showed the refused sentence ("Jabulani's bank account is FNB 62012345678") being written to the person's notes while the reply said "Nothing was saved"**, and I had recorded it without reading the `effects` field, only the message. Round 12's fix closed it for a customer's note and a supplier's or installer's note, and my probes confirmed both.

**It left one path open.** The model's own `personal_note` field was written to the **life notes unconditionally**: "remember my account number is 62012345678" wrote `life:<date>` while the reply said "it was not kept in the notes", **a reply that contradicted what the system did**. The sentence detector only looked at what was said, on the transcript path, and the reply flag was computed from the transcript alone.

**Fix.** The same detector now guards the personal note on **both sides** (the note's own wording, and what was said), and the reply flag agrees with what was done, so the reply says a note was kept out exactly when it was. An ordinary life note ("buy diesel on Friday") is still kept.

**Verified:** typecheck unchanged; **3,908 checks**; against `main` **no existing recording changed** and 5 were added (a sensitive life note; one where only the note's own wording is sensitive; one where only what was said is; a day rate; and an ordinary one still kept). **Four deliberate breakages were caught:** the guard removed; only the note checked; only what was said checked; and the reply no longer telling the truth. My original probe (five sentences through the real code) now shows no notes written for the four sensitive ones and the two ordinary ones kept.

**What this says about my own process.** The leak was visible in recordings I had in front of me; I printed what I expected to see (the message and whether a hold existed) and not the field where the leak was. Reviews of recordings should read *every* recorded effect, not only the ones the change was about.


---

## Found by the first real phone test: "...and schedule for the 17th"

Pierre typed, on the real app, "Invoice AGS Lewende Waters R3000 for carpet repair and schedule for the 17th". The invoice was held and a job was recorded, but **the 17th was lost**, with the reply "I don't have anything on file for that yet." Typing the same words again gave "I don't have that on file." instead. Three further runs isolated it: "Schedule AGS Lewende Waters for the 17th" on its own worked (it found the job and asked whether to update it); the same sentence with a comma instead of "and" worked (the date was saved, though the reply did not say so); and only the version with "and schedule" failed.

**Cause, from the code and the two different replies.** The message is split at "and" into two parts, and the second, "schedule for the 17th", has **no customer name**. The first reply can only come from a part with no customer that the model labelled as a quote conversion or a price request; the second can only come from the answering step, i.e. the model labelled **the very same fragment** as a question. **The real model read identical words two different ways**, which is exactly what the stand-in model used in all earlier tests cannot show, and why no earlier check could have caught it.

**Fix 1: decided in code, not by asking the model to be consistent.** A later part of the same message is a *scheduling continuation* only when **all** of these hold: it starts like an instruction (schedule, book, install, fit, start, plan, set, optionally after "and", "then", "also" or "please"); it is short (14 words or fewer); it names no customer or supplier and carries no amount; it has no money in it (a rand amount, "deposit", "invoice", "price", "paid"...); it is not a question; and it holds a date the date reader can read. Then it is read as scheduling whatever the model called it. **If an earlier part of the same message recorded a job, the date goes to that job** (the existing "attach to the job just recorded" step, with no question); **otherwise it is for the customer of the part before it** (so a customer who already has a job is still asked "update it, or a separate new job?"). A genuine question ("what is scheduled for the 17th?"), a part with money, a part that names its own customer, and a part with nothing before it to belong to are all left exactly as they were.

**Fix 2: the reply now says when a date was saved.** An invoice that also scheduled a job said nothing about the date, so there was no way to tell from the reply whether it had been kept: now "Job scope #75 also recorded — 1 task noted, scheduled for Sat 17 Oct." A job observation says the same, and a date attached to a job that already existed says "Job scope #1 **updated** — scheduled for Sat 17 Oct." instead of "recorded" (it was recorded already).

**The property that matters.** Against `main`, of **676 existing cases, 664 are identical** and **12 differ only by the added date wording or "updated"** (checked mechanically: stripping the clause and the word gives back the old recording, with the same database rows). None was removed; **14 were added**: the real failure reproduced with the fragment labelled four different ways (a price request, a question, a quote conversion, a note), a continuation after an invoice that recorded no job, one for a customer who already has a job, and the four cases where the rule must stay out of the way; plus four invoice cases in the exact shape of the third phone test. A further **70 unit tests** cover what the rule is and is not (10 phrasings x 6 labels, then 17 negatives).

**Verified:** typecheck unchanged; **4,260 checks**. **Eight deliberate breakages were caught:** the rule never applied (the original bug); money no longer stopping it; a question mark no longer stopping it; the date going to the customer instead of the job just recorded; a date attached to an existing job reported as a new record; and **an invoice that scheduled a job saying nothing about the date, which survived at first**: no case had an invoice with an amount plus a job with a date, which is exactly the shape of the phone test, so one was missing from the very test that found the bug. Four were added and it is caught.

**Not verified, and the one thing that matters:** this was reproduced with the model's mistake *scripted* four ways, because the real model cannot run here. **Please say the original sentence again on the real app after this deploys.** Expect two lines: the invoice waiting, and "Job scope #N updated — scheduled for Sat 17 Oct."

**Seen on the phone and not changed, recorded in `OPEN_QUESTIONS.md`:** every invoice sentence that mentions work **creates a new job**, even when the customer already has that job: the test sentences made three jobs (#73, #74 and #75) for one carpet repair. That is a design question, separate from this fix.


---

## Found by the third phone test: a long reply was cut off and could not be scrolled

Pierre: the list of open orders "gives a couple of lines and then it cuts off", and it cannot be scrolled. **Cause, from the app code:** the reply is plain text in a `Stack` above the orb with no height limit and no scrolling, so a long reply is clipped to whatever room the screen gives it. Every long answer was affected, not only this list (the unit conversions, the statements history, a long customer answer).

**Fix (app only, one block, no server change).** The reply now takes at most the height it is given and **scrolls inside it**; a short reply is unchanged (the scroll view is only as tall as its content). It also covers the reply that carries Confirm and Reject. The change is one line replaced and fourteen added, a wrapper around the existing widget, checked for balanced brackets; the pending-confirmation widget was checked for flexible children (none), which would have broken inside a scroll view. **It cannot be compiled or run here: the web build in the pipeline is the compile check, and it needs a Codemagic rebuild and a look on the phone.** Whether it fits comfortably is a judgement about space on the real screen, so please look at the open-orders list and say if the scrolling area is too small or too large.


---

## Rewrite Phase 3, step 1b: the caption logic, once

**The rest of the duplication between the two upload handlers, except one deliberate remainder.** Step 1 left 48 identical lines in three blocks. The two larger ones were really **one** 39-line block: read the caption, find or create the customer or supplier it names, under the **same permission check as dictation**, then record the text and the hint on the capture. Re-measured before moving it: **exactly one line out of 39 differs**, the label put in front of the file's description (`[Document: …]` versus `[Photo description: …]`). That label is now a parameter, and the block is **one function in `worker/src/intents/upload-caption.ts`**, called by both handlers, moved unchanged (no multi-line strings to disturb).

**Left alone on purpose.** The last 8 lines are the idempotency start (`const idempotencyKey = …; checkIdempotencyKey(…); if (replay) return replay`). It is a **standard guard with an early return that appears in four routes** (audio, document, photo and one more), not logic that can drift in one place, and sharing it would mean changing routes outside this step for almost no gain. It is better handled when the routes' preambles are looked at together. The two handlers also legitimately **stay different** in how they get the file's text (a document is read for text, a photo is described by a vision model).

**The result.** The document handler is now **97 lines** (was 329 before step 1) and the photo handler **56** (was 290); `index.ts` is **5,852 lines**, from 6,297 at the start of Phase 3. The two handlers share two functions and differ only where the files differ.

**The property that matters.** **No recording changed, was removed or was added: all 751 are untouched**, including the document-versus-photo pairs. Unlike step 1, **not one existing guard failed**: nothing had been searching the handlers for this block's text. That is a reason for care, not comfort: a move that breaks no guard also has no guard that notices if a handler quietly grows a private copy again. **Three new guards were added:** each handler must call the shared function with **its own label**, neither may carry its own copy of the caption logic, and only `index.ts` may import it.

**Verified:** typecheck unchanged; **4,590 checks**. **Four deliberate breakages were caught:** a photo's caption labelled as a document (13 failures, the new guard and recordings both); the permission check inside the shared function removed (an installer's caption would create a customer: caught by the recorded case); a private copy re-created in the photo handler (the new guard); and the capture no longer recording the caption and description text (69 recorded cases fail).


---

## Rewrite Phase 3, step 2: order management leaves processOneExtraction

**The first intent group out of the big function.** Cancelling an order, reopening a cancelled one, linking an existing order to a customer, a supplier's statement and a unit conversion now live in **`worker/src/intents/order-admin.ts`** (two handlers, `handleOrderHolds` and `handleOrderRecords`). `processOneExtraction` fell from **2,235 to 2,039 lines** (about 9%) and `index.ts` from 5,852 to **5,657**.

**Why it was a clean first group, checked before anything moved.** These intents were not in one place: each had a small find-only condition in the opening step (left where it is), an action branch in Pass 1, and a reply branch in the Pass 2 chain. **Every variable they use was private to them: not one was referenced anywhere else in the function.** They read only the sentence, the supplier, the customer and the member, and wrote back only the held action's number and type plus the message. And no branch in the reply chain could intercept these intents, so moving their replies could not change which message wins.

**How it moved: the code is unchanged, not rewritten.** The same branches, the same messages, the same order. **Two handlers, because the pieces ran at two different places** (the held actions early, the statement and unit conversion later, after other code), and the order of database writes must not change; a guard now checks the two calls stay in that order. Each handler returns the finished reply (and, for a held action, its number and type), or `null` when the sentence is not one of its intents, so the function's reply chain has one short branch for each in place of about 44 lines.

**The property that matters.** **No recording changed, was removed or was added: all 751 are untouched, and not one existing guard failed.** As in step 1b, that is a reason for care: nothing was watching this code in `index.ts`, so nothing would notice a branch growing back there. **Four kinds of new guard were added** (22 checks): `index.ts` must call each handler exactly once; the held actions must be decided before the two that write immediately; the held action's number and type must be handed back and the replies used as the message; `index.ts` must not carry its own copy (it may not contain the hold, the statement recording, the conversion writes, or the old variable names); the module must really hold or record each thing; and only `index.ts` may import it.

**Verified:** typecheck unchanged; **4,612 checks**. **Six deliberate breakages were caught:** a held cancel, reopen or link no longer handing back its action number (nothing to confirm); the reply no longer used (59 recorded cases fail); a statement and a unit conversion no longer recorded; a rule inside the moved code removed (a cancelled order linkable: caught by the recorded case); the two handlers run in the opposite order; and a private copy of the cancel logic grown back in `index.ts`. Twenty-one imports `index.ts` no longer needed were removed.

**What this does not change, said plainly.** `processOneExtraction` is still **2,039 lines with 10 return points**; this was one group of about nine, so the rewrite is roughly a tenth done by size. The opening step's find-only lists (the conditions at the start of the function that say "find, never create") still name these intents and should move to a table next to `INTENT_RULES`. The lookups that belong to this group (open orders, unit conversions, supplier statements) stay with the lookup group. The confirm and reject routes, which carry out these held actions, are a separate function and were not touched.


---

## Rewrite Phase 3, step 3: the "find, never create" rule becomes one table

**Two long hand-written conditions in the opening step of `processOneExtraction` are now one table in `auth.ts`, beside `INTENT_RULES`.** The rule is old and sound (found 2026-07-11: a lookup for a Jenny who does not exist silently created her): a sentence that only asks, or that acts on something that must already exist, must never create a customer or a supplier. Which intents that covers had been edited by hand **six times** as intents were added, in two separate chains, once with an intent removed from one and forgotten in the other.

**Now:** `INTENTS_THAT_ONLY_FIND_CUSTOMERS` and `INTENTS_THAT_ONLY_FIND_CHARACTERS` (suppliers), with two small functions, `intentOnlyFindsCustomers` and `intentOnlyFindsCharacters`, which the opening step asks. **The two lists differ by exactly one intent, `purchase_order`**, and that difference is the rule written down: an order may create a *new supplier* (ordering from someone for the first time is normal) but never a customer (a name after "for" is who it is for, not someone to create). This is a deliberate narrowing of nothing: the lists are **exactly** what the two conditions said.

**The property that matters.** **No recording changed, was removed or was added**; all 751 are untouched. Nine new checks: the two lists are asserted **exactly** (lookup, cancel, reopen, link, the two unit conversions, a supplier statement, and an order for customers; the same without the order for suppliers); they differ by exactly `purchase_order`; every name in them is a real intent; an order may create a supplier but not a customer; ordinary recording intents are not find-only; a missing or unknown intent is not find-only (handled as before); the opening step asks the table once for each kind; and `index.ts` may not grow its own hand-written list again.

**Verified:** typecheck unchanged; **4,621 checks**. **Four deliberate breakages were caught:** an order able to create a customer again; the two lists swapped at the customer check (exactly the slip this table exists to prevent); an order unable to create a new supplier; and a lookup for someone who does not exist able to create her (the 2026-07-11 bug). **One mistake of mine, caught immediately:** the new test block used a helper defined later in the same function, and the test's compiled copy of `auth.ts` is assembled from slices with an explicit export list, so the new names had to be added to it; both showed up as a crash on the first run, not as a silent pass.

**Effect on size:** `processOneExtraction` is unchanged in length (the conditions were one line each); this step is about **making the rule correct by construction**, not about size. Next: the next intent group out of the function.


---

## Rewrite Phase 3, step 6: procurement by dictation leaves processOneExtraction

**The fourth intent group, and the biggest so far:** placing a purchase order, recording goods received, holding a supplier invoice for confirmation and recording what a supplier said about a delivery discrepancy now live in **`worker/src/intents/procurement.ts`** (one handler, `handleProcurement`, 312 lines). `processOneExtraction` fell from 1,843 to **1,581 lines** (14%) and `index.ts` from 5,465 to **5,204**.

**Checked before it moved.** The group is four action blocks (217 lines) and 44 lines of reply branches. **Twenty-four function-level variables are declared in it, and every one is private to it**: none is referenced anywhere else in the function. Nothing unrelated sits between the blocks. The reply branches are one contiguous run plus one earlier branch, and every other branch in that stretch of the chain is specific to a different intent, so moving procurement's replies to one place cannot change which message wins. The order handlers' call sits in the middle of the group's declarations and stays where it is.

**The difference from the earlier moves, and why it matters.** This group **holds actions** (a delivery, a supplier invoice, a discrepancy resolution waiting for confirmation). So, unlike stock or snags, **the handler returns the held action's number and type even when none of its reply branches matched, and the caller uses the reply only when there is one**; otherwise a held action could be created and then lost, with nothing for the person to confirm. Two guards pin that: the handler must end with the return that always hands the held action back, and the caller must use the reply only when it is non-empty.

**The property that matters.** **No recording changed, was removed or was added: all 751 are untouched.** Four existing guards failed, and all four were guards that read the *dictation* delivery code from `index.ts` (that every hold allocates on confirm, that every goods-received path unit-checks then classifies, that a spoken delivery is always held and only when the plan says so, and that a delivery with nothing readable gets its own reply). They now read the same code from its new home, with every assertion intact, and a guard that the block can be found at all. **Twenty-nine new checks** guard the move: one call; the held action handed back; the reply used only when there is one; no private copy of any of seventeen procurement names in the big function; the module must do each of six things; and only `index.ts` may import it.

**Verified:** typecheck unchanged; **4,694 checks**. **Five deliberate breakages were caught:** a held action no longer handing its number back; **a held action lost whenever no reply matched** (the risk specific to this move); the replies no longer used (148 recorded cases fail); a rule inside the moved code removed (a duplicate supplier invoice no longer recognised: caught by the recorded case); and a private copy grown back in the big function. Seventeen imports `index.ts` no longer needed were removed.

**A gap in the recordings, found by that breakage and recorded honestly.** "A held action lost whenever no reply matched" was caught **only by the guard**, not by any recorded case: no recorded case exercises a held procurement action with no reply branch matching. The guard is the defence for that case, and it is a structural one (it reads the code, not a behaviour). If such a case can happen in real use it should be recorded; none is known.

**Where it stands after six Phase 3 steps:** four intent groups are out (order management, stock, snags and leads, procurement), the upload logic exists once, and the find-only rule is one table. `processOneExtraction` is **1,581 lines**, from 2,235 at the start of Phase 3 (and 1,756 at the Phase 1 measurement); `index.ts` is **5,204**, from 6,297. **Every step has passed with all 751 recordings untouched.**


---

## Rewrite Phase 3, step 7: the job-pricing map, and the first duplicate removed from it

**The mapping of the job-pricing group, and what it found.** The group (invoice, quotation, price scope, convert quote, work observation) is one region of about 400 lines (the invoice block, a combined quotation-and-price-scope block, convert quote, and a 162-line work-observation block). A line-by-line comparison found **far less copy-paste than the upload handlers had**: the invoice's job part and the work-observation block share **27 lines**, not the whole of each. The real finding is different, and it is why this group is harder than the four before it: **these blocks do not only read and reply.** Each contains an **early `return` of the function's whole result** (the "update that job, or a separate new one?" question), and the work-observation block **assigns the function's `customer` variable** (taking it from a sibling job in the same message). Neither can be moved as a plain handler the way stock or snags could. A move needs a deliberate contract for an early return and for that assignment, and that is the next step, not this one.

**This step removes the duplication that is real, in place.** Two things existed twice, once in the invoice's job part and once in a spoken observation, and were verified **identical** before anything was replaced: the 20-line "update that job?" result, and the 7-line result a recorded observation reports back. Each is now one function above `processOneExtraction` (`jobAmendmentReturn` and `recordedObservationResult`), called from both places. The explanation of why the invoice waiting beside the question is mentioned (found by the recordings on 2026-10-03: the hold was created and then the reply never mentioned it) was in only one of the two copies, and is now with the code in one place. `processOneExtraction` fell from 1,581 to **1,531 lines**; `index.ts` is unchanged in length because the helpers sit in the same file.

**The property that matters.** **No recording changed, was removed or was added: all 751 are untouched.**

**Two Phase 1 guards failed, and they asked the right question.** They count the function's multi-line `return { … }` sites (10) and refuse to let that number change until the adapter's rules have been re-checked against the new shape. Two of those sites became calls to one helper, so the function now has 8 object-literal sites. Changing the number alone would have defeated the guard, so the helper's shape is held to the **same rules** the two sites it replaced were: the guard now checks that it carries an action id only with its type, that changes accompany only a `job_scope_amendment` hold, and that it carries no candidates, fact hold or job scope; that the function has exactly two calls to it where the two sites were; and that the `job_scope_amendment` result is written once in the whole file.

**A bug of mine, caught on the first run.** The first version replaced the two result builders before the two returns, which shifted the line numbers I had recorded for the returns, so the second replacement landed in the wrong place and the file no longer parsed (the typecheck said so at once). Fixed by restoring the file and making all four replacements in one pass from the bottom up.

**Verified:** typecheck unchanged; **4,692 checks**. **Four deliberate breakages were caught, each call site separately:** the invoice waiting beside an amendment question no longer mentioned; the invoice's call site no longer telling the helper about the invoice hold; a recorded observation no longer reporting the date it scheduled; and a spoken observation (the second call site) reporting no tasks.

**What this means for the plan.** The remaining groups are **not** the easy kind. Moving the work-observation and invoice blocks needs the Phase 1 result contract used for real: a handler that can return either a finished result (the amendment question) or the state the reply needs, and that reports a customer it found. That is the design work for step 8.


---

## Rewrite Phase 3, step 8: job pricing leaves processOneExtraction (the state-bag handler)

**Authorised without review by Pierre ("if you have a clear path forward then go ahead, I don't need to review it, but log it faithfully"). This entry is that log: the design, why it was chosen, what it costs, and what is still open.**

**What moved.** The decision-and-write part of the job-pricing group: an invoice and the work in the same sentence, a quotation or a price for a scope, converting a quote to an invoice, and a spoken job observation, **one contiguous region of 368 lines**, now live in **`worker/src/intents/job-pricing.ts`** (one handler, `handleJobPricing`). With it moved the two helpers from step 7 (`jobAmendmentReturn`, `recordedObservationResult`) and two small functions that lived in `index.ts` and were referenced **only** by this region (`transcriptMentionsPricing`, `buildQuotationLineItems`). `processOneExtraction` fell from 1,531 to **1,172 lines** (23% in one step) and now has **8 return points**, from 10; `index.ts` fell from 5,204 to **4,728**.

**Why the earlier approach (a plain handler that returns a reply) could not be used, and what was used instead.** The blocks do not only read and reply. The analysis that decided the design, run before anything moved: the region reads **nine** things (the sentence, the extraction, the customer, the supplier, the capture, the member's permission to write invoices, and the pending-action pair) and **assigns back exactly three** (`customer`, `pendingActionId`, `pendingActionType`); it declares **ten** variables and **every one is used by the reply code after it**; and it has **two** return sites, both the "update that job, or a separate new one?" question. So the handler returns a **state bag**: `terminal` (a finished result, or null), the three values it assigns back, and `state` (the ten values under their original names). **The reply code was deliberately not moved** and stays exactly where it was, so which message wins cannot have changed; moving the replies into the handler is a later step. `terminal` is typed with the existing Phase 1 `LegacyProcessResult`, whose ten fields were already pinned by a Phase 1 test to the function's actual return shape.

**A trap in the design, found by reading rather than by a test, and handled.** An early return happens in the *middle* of the region, **before later variables are declared**. A handler that returned its state at that point would reference variables that do not exist yet (they are `let`, so it would throw at run time). So the two early returns carry `state: null` and the caller returns `terminal` immediately; only the final return carries state. A guard pins that: exactly two early returns with null state and one final return.

**The property that matters.** **No recording changed, was removed or was added: all 751 are untouched**, in the most heavily recorded part of the system.

**What failed, and what was done.** Four guards failed, all the step 7 guards that looked for the helper inside `index.ts` (it moved with the region); they now read the new module with every assertion intact. **Twenty-eight new checks** guard the move: one call; the finished result returned at once; the customer and the held action handed back; **the ten values destructured by the caller equal the keys of the handler's state type** (derived from the code, so a value added to one and not the other fails); the final return hands back every one of the ten; exactly two early returns and one final; the big function may not contain its own copy (twelve names); the module must do each of nine things; and only `index.ts` may import it.

**Verified:** typecheck unchanged; **4,720 checks**. **Eight deliberate breakages were caught, one for each way the state bag can lose something:** the early return ignored (the "update that job?" question lost); the customer the handler found dropped; the held action dropped (nothing to confirm); the same-work match not handed back; a recorded observation not handed back (53 recorded cases fail); a rule inside the moved code removed; and a private copy grown back in the big function. Eight imports `index.ts` no longer needed were removed.

**Two mistakes of mine, both caught immediately.** (1) The parser for the variables' declared types stopped at the first `;` inside the multi-line type of one of them, so it crashed before changing anything; it now stops only when the braces balance. (2) The two helper functions the region used were defined in `index.ts` rather than imported, which the typecheck reported at once; the analysis confirmed they were referenced nowhere else, so they moved with it instead of being exported.

**What this design costs, stated plainly.**
- **`jobPricing.state!` is a non-null assertion.** It is safe only because the caller has already returned when `terminal` is set, and `state` is null only on that path. A guard checks the early-return shape, but the type system does not enforce it. A discriminated union (`{ terminal } | { state }`) would, and is the cleaner form; it was not used here because it changes the call shape and this step's rule was to move code unchanged.
- **The replies still live in `index.ts`**, so the group is only half out: the decision is in one place and what it says is in another, linked by ten variable names and a guard that they match.
- **The three assigned-back values are a design smell.** A handler that mutates the caller's customer by returning it is a step toward, not the end of, the Phase 1 contract (which has the handler report what it found and the caller decide).

**Where it stands after eight Phase 3 steps:** five intent groups are out (order management, stock, snags and leads, procurement, job pricing), the upload logic exists once, and the find-only rule is one table. `processOneExtraction` is **1,172 lines**, from 2,235 at the start of Phase 3 (47% smaller) and 1,756 at the Phase 1 measurement; `index.ts` is **4,728**, from 6,297. **Every step has passed with all 751 recordings untouched.**


---

## Rewrite Phase 3, step 9: the opening step leaves processOneExtraction

**The sixth piece out of the big function, and the first one that is not a group of intents.** The first **410 lines** of `processOneExtraction` now live in **`worker/src/intents/opening.ts`** (`handleOpeningStep`, 459 lines with its types): the stretch that decides **who a sentence is about and what may be done about them, before anything is recorded**. It is where a customer or supplier is found or created, where a name that sounds like someone already on file is held as a question (`ambiguous_person`, `identity_collision`), where a role that may not create this kind of sentence is refused (the creation gate), where "forget that" and a follow-up ("how is she doing") are resolved from the person's own selection, and where the selection and the capture's hint are written in the background. **`processOneExtraction` fell from 1,172 to 768 lines** (from 2,235 at the start of Phase 3, so 66% smaller), **has 1 return point (from 10 at the Phase 1 measurement)**, and `index.ts` fell from 4,728 to **4,322**. Moved unchanged, not rewritten.

**Checked before it moved.** The stretch ends at the first intent-specific block. Of the **ten** variables it declares, **only five are used afterwards** (`customer`, `character`, `pendingActionId`, `pendingActionType`, `canManageInvoicesForWrites`); the other five are private to it. It reads all eight parameters and **reassigns exactly one**, the extraction (a resolved follow-up updates it), so that is handed back too. It has **seven early returns** of the whole result. Its background writes (`ctx.waitUntil`) need the execution context, which is passed in.

**The design, and an improvement on step 8.** The handler returns **either the finished result or a small state object** (`opening: true`, the extraction and the five values). The seven early returns are therefore **left as plain object literals, written exactly as they always were**, so the Phase 1 rules about result shapes can keep inspecting them (step 8 had wrapped them in a `terminal` field, which hides the literals from those rules). The caller returns the result at once when there is no `opening` marker, otherwise takes the extraction and the five values. The Phase 1 guards were extended to scan **both** files: sites are collected from the opening step first and the function after it, so the last site is still the function's final return; the count is still 8 (7 early, 1 final).

**The property that matters.** **No recording changed, was removed or was added: all 751 are untouched**, in the part of the system that creates and matches people.

**Six guards failed, all reading this code from `index.ts`, and each was updated rather than loosened:** the find-only table is asked once for customers and once for suppliers (now in the opening step, and nothing else in `index.ts` may use it); a lead's name is kept out of customer matching; "forget that" chooses only among actions the caller may resolve; and the two Phase 1 return-site counts. **One needed re-stating, not just re-pointing:** "the creation gate must run before anything is written" used to be one position check inside the function. It now has **two halves, both checked**: the gate comes before every writer inside the opening step, and the opening step is called before any writer in the function that follows. **Twenty-nine new checks** guard the move (one call; a finished result returned at once; the extraction and the five values handed back, with the destructured names compared against the state type so one added to either side and not the other fails; the final return hands back all of them; no private copy of ten opening-step operations in the big function; the module must do each of seven things; only `index.ts` may import it).

**Verified:** typecheck unchanged; **4,749 checks**. **Six deliberate breakages were caught:** a refusal or an identity question from the opening step ignored, so the sentence carries on (100 recorded cases fail); the updated extraction dropped; the supplier not handed back (162 fail); every member told they may write invoices; **the creation gate removed** (32 fail); and a private copy put back **before** the opening step (caught by the new ordering guard). Ten imports `index.ts` no longer needed were removed.

**My mistakes, all caught.** (1) The module imported `HistoryTurn` twice (the typecheck said so). (2) Two attempts at the guard patch aborted on quote-matching **before saving anything**, so nothing was half-applied. (3) **A guard of mine was too broad**, and the way it was wrong matters: it forbade any call to `intentCreationRefusal(` in the big function, but one remains legitimately, as the permission check for the "what did Floornet claim" lookup, which is a different use from the gate on the sentence's own intent. It now forbids only `intentCreationRefusal(extraction?.intent`, and says why.

**What this design costs, stated plainly.** The caller now declares `customer`, `character` and the others by destructuring (`let { … } = opening`), and the type system knows nothing of the rule "the extraction may have changed": a guard pins that the caller takes it, but a future edit that adds a sixth value must add it in three places (the state type, the final return, the destructuring), and a guard checks the first and third match. The handler still takes the whole execution context to run its background writes.

**Where it stands after nine Phase 3 steps:** six pieces are out (order management, stock, snags and leads, procurement, job pricing, the opening step), the upload logic exists once and the find-only rule is one table. **`processOneExtraction` is 768 lines, from 2,235; `index.ts` is 4,322, from 6,297. Every step has passed with all 751 recordings untouched.** What is left in the function is the reply chain (about 500 lines, including the 82-line `task_complete` block), and a few small intent blocks (payments, expense, supplier payment, `forget_last`'s neighbours).

---

## Rewrite Phase 3, step 10: answering a question (every lookup) leaves processOneExtraction

**The biggest single piece left in the reply chain, and the cleanest.** The lookup branch, **275 lines**, now lives in **`worker/src/intents/lookup.ts`** (`answerLookup`, 309 lines with its types). It answers every kind of question a person can ask the business: about a customer, about a supplier, about the whole business, delivery exceptions, price history, open orders, supplier statements, unit conversions, and so on, with the same scopes, the same permission refusals and the same answers. **`processOneExtraction` fell from 768 to 495 lines** (from 2,235 at the start of Phase 3, so **78% smaller**) and `index.ts` from 4,330 to **4058**. Moved unchanged, not rewritten.

**Checked before it moved.** The body **reads six things** (the extraction, the sentence, the conversation, the member's permissions, the customer and the supplier) and **assigns back exactly one**, the message. It has **no early return and no background work**, and it declares nothing that the code after it uses. So it is a plain function that returns the answer, and **the branch's condition stays in the reply chain exactly where it was**: nothing about which reply wins can have changed, which is the property that made the reply chain risky to touch.

**The property that matters.** **No recording changed, was removed or was added: all 751 are untouched.**

**Three guards failed, all reading lookup logic from `index.ts`, and each was updated rather than loosened:** the delivery-exception question is handled before the general business branch, and the report may be read only by a role that can manage invoices (both now read from the new file), and the check that **every permission marked "in use" is actually checked somewhere**. **That last one exposed a real gap in the guard, older than this step:** it read only the top-level source folder and never looked inside `src/intents/`, so a permission checked only in an intents module would have looked unused (or, the other way, an unchecked one could hide). It now reads both. **77 new checks in total since step 9's push** (this step's guards: the call exists exactly once; the branch stays in the chain and its answer is the message; the big function holds none of eight pieces of lookup logic; the module must do each of six things; and only `index.ts` may import it).

**A guard that earns its place: a question must never change anything.** Read with comments removed, `lookup.ts` may not contain a hold, an insert, an update, a delete, any `.run(`, any `record…` or `register…` call, or background work. It passed on the moved code, which confirms the lookup really was read-only; if a future edit makes a question write, it fails.

**Verified:** typecheck unchanged; **4826 checks** (run in the full checkout). **Six deliberate breakages were caught:** the answer to a question thrown away (107 recorded cases fail); a role without invoicing access able to list open orders (a permission refusal inside the moved code, caught by the recorded case); the delivery-exception question no longer answered before the business branch; a lookup that deletes something; a private copy of the lookup logic grown back in the big function (214 fail); and a role without material access shown the material price. Twenty-five imports `index.ts` no longer needed were removed.

**My mistakes along the way, all caught.** (1) **My first analysis of what the branch reads missed `customer` and `character`**, because they are now declared by destructuring, which my pattern did not see, even though the branch visibly uses them; I only caught it by looking at the branch's own `else if (character)` lines, and redid the analysis before building anything. (2) **I assumed the message started with a value**: it is declared `let message: string;` with none, so passing it in was wrong; the typecheck refused, and the function now declares its own, as the branch had. (3) The import detector matched a local variable named `breakdown` against the timing module's export of the same name, a harmless false positive that I excluded. (4) **I made the same test-ordering mistake a second time:** a guard used `lookupSrc` before the line that defines it, which crashed the suite on the first run; it is now defined once with the other source reads.

**Where it stands after ten Phase 3 steps:** seven pieces are out (order management, stock, snags and leads, procurement, job pricing, the opening step, lookups), the upload logic exists once and the find-only rule is one table. **`processOneExtraction` is 495 lines, from 2,235; `index.ts` is 4058, from 6,297. Every step has passed with all 751 recordings untouched.** **What is left in the function:** the replies for the job-pricing group (about 110 lines, tangled in the shared held-action reply code, which is why they were not moved with their decisions), the generic held-action reply, the 20-line `task_complete` block that assigns the message, a few small intent blocks (payment, expense, supplier payment, `forget_last`), the two closing reply branches and the final return.


---

## Rewrite Phase 3, step 11: facts, notes and reminders leave processOneExtraction

**What moved.** What a sentence leaves behind **besides its main effect**: a fact about a customer or a supplier (held for confirmation, and **refused for a role that may not handle pay or bank details**), a personal note, a reminder, and filing the sentence itself as a note against whoever it was about (unless it was a question, an errand, something that already has a structured home, or **a pay or bank detail, which must be kept out**). **112 lines** are now **`worker/src/intents/facts-notes.ts`** (`handleFactsAndNotes`). `processOneExtraction` is **385 lines**; `index.ts` is **385**. Moved unchanged, not rewritten.

**Checked before it moved.** The region **reads seven things and assigns no outer variable at all**, has no early return, and of its eight declared variables exactly **four** are used by the reply code afterwards (the fact hold, the kind of sensitive fact, whether it was refused, and whether a note was kept out), so exactly those four are returned. It creates up to two held actions and queues up to five background writes, which is why the handler takes the execution context.

**The property that matters.** **No recording changed, was removed or was added: all 751 are untouched.** One existing guard failed ("index.ts must ask `intentKeepsOutOfNotes`, never carry its own list of intents again"); it now reads the notes step from its new home with the assertion intact, and also checks that `index.ts` no longer mentions the function at all.

**New guards, aimed at the privacy-sensitive parts.** The four returned values must equal the four destructured by the caller (compared as sets, so one added to either side and not the other fails); the big function may not contain ten pieces of this logic; the module must do each of nine things; and two **orderings are pinned**: a supplier fact is checked for pay or bank details **before it can be held**, and a sentence holding a pay or bank detail is kept out of the notes (the decision is made before any note is written).

**Verified:** typecheck unchanged; **4850 checks**. **Four deliberate breakages were caught:** a pay or bank detail saved as a supplier fact for a role that may not handle it; a held fact no longer reported to the reply; a sentence with a bank detail filed as a note (12 recorded cases fail); and a private copy of the notes step grown back in the big function (it was caught by the guard, and the breakage also showed how widely the helper is used). Nine imports `index.ts` no longer needed were removed.


---

## Rewrite Phase 3, step 12: money said out loud leaves processOneExtraction

**What moved.** The three places a spoken sentence turns into money waiting for confirmation: **a customer paid, an expense, a payment to a supplier**. Each is **held, never written at once**. **59 lines** are now **`worker/src/intents/payments.ts`** (`handlePayments`). `processOneExtraction` is **331 lines**; `index.ts` is **331**. Moved unchanged, not rewritten.

**Checked before it moved.** Nothing unrelated sat between the three blocks; the only variable they declare (whether a supplier payment named no supplier) is used by the reply code, so it is returned; they read five things and assign back only the held action's number and type, which are handed back. A sentence has exactly one intent, so only one block ever runs.

**The property that matters.** **No recording changed, was removed or was added: all 751 are untouched**, and no existing guard failed (nothing had been watching this code in `index.ts`), so the guards for it are new, and they are the strongest of any move so far because this is money.

**New guards.** **The module may only HOLD money for confirmation, never write it:** read with comments removed, `payments.ts` may not contain a payment, expense or supplier-payment write, an insert, an update, a delete, any `.run(`, or background work; each of the three must hold under its own name and report the matching type. **And `processOneExtraction` may no longer create a held action itself**: after this step every one is made by a handler, and a guard fails if the function makes one again. The held payment's number and type, and the "no supplier named" flag, must come back to the caller.

**Verified:** typecheck unchanged; **4867 checks**. **Five deliberate breakages were caught:** a held payment no longer handed back (nothing to confirm); a supplier payment with no supplier named no longer reported; **a payment written immediately instead of held** (1,034 checks fail); the big function making a held action of its own again (515); and a held expense reported as a payment. **One apparent survivor was not real**: my search text for that last breakage had the wrong indentation, so the breakage was never applied (the tool reports exactly that); redone with the right text it was caught.


---

## Rewrite Phase 3, step 13: the reply chain leaves processOneExtraction. Phase 3 is complete.

**The last piece.** The **reply chain**, 234 lines that decide **what the person is told**, is now **`worker/src/intents/reply.ts`** (`composeReply`, 278 lines with its input type). It includes the "complete a task" branch (which reads the open tasks and completes one) and the closing notes about sensitive facts and notes that were kept out. Moved unchanged, not rewritten: the same branches in the same order. **`processOneExtraction` is now 105 lines** (from 2,235 at the start of Phase 3, **95% smaller**), with **one return point**; `index.ts` is **105**.

**Checked before it moved.** The chain is a **pure function of what it is given**: it reads 28 values, **assigns no outer variable** (it declares only the message), has **no early return and no background work**, and the function's final return needs nothing from inside it. Its inputs are the results the other steps produced, grouped as they were produced (the handlers' results, the four facts-and-notes values, the ten job-pricing values) and destructured back to their **original names** inside the module, so the chain itself did not change. The function that calls it is now **only an orchestrator**: it opens the sentence, runs each step, asks the reply module what to say, and returns.

**The property that matters.** **No recording changed, was removed or was added: all 751 are untouched.** Seven guards failed, all of the form "this handler's reply must be used as the message" (and the lookup one), reading the chain from `index.ts`; each now reads it from the reply module with the assertion intact. One of them changed meaning rather than location: the lookup is now asked by the reply module, so nothing at the top level imports it, and the guard says exactly that.

**New guards, aimed at the new shape.** The reply is called exactly once, and **everything it reads must be passed to it and nothing else** (compared as sets, so a value added to one side and not the other fails); the four facts-and-notes values and the ten job-pricing values travel whole; **the orchestrator may build no message itself**; and **the reply may only read, ask a lookup, and complete a task**: the only things it may await are a lookup, the open tasks and a task completion, and it may contain no hold, insert, update, delete, `.run(` or background work.

**A guard of mine had a gap, and a breakage found it.** My first guard that the orchestrator builds no message looked for assignments to a variable named exactly `message`. A breakage that built text under a different name **survived**. I first misread why (my test used a variable called `message2`, so the breakage was weak), but it exposed a real gap: text could be built under any other name. The orchestrator has, in fact, **no template string, no `+=` and no string literal over 25 characters**, so the guard now **forbids all three**, and the breakage was redone in both forms (a long literal and a concatenation) and caught.

**Verified:** typecheck unchanged; **4891 checks**. **Seven distinct breakages caught:** a held fact never mentioned in the reply; a recorded job observation never mentioned (54 recorded cases fail); a supplier payment with no supplier told as if it were held; the orchestrator building wording under another name (two forms); the reply deleting something; and the generic held-action reply made unreachable, which would leave a held action silent (52 fail). **Two mistakes of mine along the way, both caught:** I guessed the module that exports a type instead of looking it up (the typecheck said so), and the lookup import guard had to be re-stated because the lookup is now asked by the reply module.

---

## Phase 3 summary: what was done, and what was not

**What was done.** Over thirteen numbered steps (and one `1b`), `processOneExtraction` went from **2,235 lines with 10 return points to 105 lines with 1**, and `index.ts` from **6,297 to 105 lines**. What came out is **14 modules in `worker/src/intents/`, 3242 lines in all**: the supplier-document decision (once, where it existed twice), the upload caption, order management, stock, snags and leads, procurement, job pricing, the opening step, lookups, facts and notes, payments and the reply; plus the find-never-create rule as one table and the job-amendment result written once. **Every one of the 14 steps passed with all 751 recordings untouched**, and the safety net grew from 2,696 checks (at the start of the whole effort) to 4891.

**What was not done, stated plainly.**
- **The Phase 1 result contract was never adopted.** The handlers return bespoke shapes (a reply, a state bag, a finished result or a state object), not the `ProcessingResult` the plan envisaged, and `toLegacyResult` still has no caller. The orchestrator hands five handlers' held actions to its own variables (`pendingActionId`, `pendingActionType`) one by one, which is a smell a contract would remove.
- **Replies are composed in one place from 16 inputs**, not by each group. That was chosen because moving them into their groups would have meant splitting the shared held-action reply, and no guard could prove that safe; it is correct but not the end the plan described.
- **`index.ts` is still 105 lines.** It holds the routes and the other large functions, which Phase 3 did not touch (`processTranscript`, the confirm and reject routes and the rest).
- **The guards read source text.** Many of them are searches of the code for its shape; they proved their worth (each move was checked by deliberately breaking it) but they are brittle by nature, and a real fix for that is typed contracts, not more text searches.
- **Real-model behaviour was never re-tested.** Everything was verified against the scripted recordings; nothing here has been looked at on the phone. The phone checks, the Codemagic rebuild (long replies scroll; Same person / Different buttons) and the timing readout (`GET /debug/timings`, admin key) are all still waiting.


---

## Phone verification after Phase 3

**Reported by Pierre, 2026-10-04: "Tests ran, all came back perfect."** Recorded as his report, not as a checked result. **What is not known:** which of the phone checks he ran (the list is the "Needs a live check only a phone can give" section of `OPEN_QUESTIONS.md`), whether the app was rebuilt first (the long-reply scrolling and the Same person / Different buttons need a Codemagic rebuild), and what the timing route showed (`GET /debug/timings`, admin key), so the latency question is **still open**. What it does support: the refactor, which was verified only against scripted recordings, behaved correctly on the real model and phone in at least the flows he exercised. It does not replace itemised checks, and the section's items stay listed until each is confirmed.


---

## The pipeline gap, closed, and the phone confirmation, 2026-10-17

**Pierre's confirmation of the front door (from his phone, after the first real signup):** "The app opens to a blank unsigned in office on sign in; if a business exists it logs in; if you choose an email address that doesn't have access you go through to the new signup page where you enter your business name and agree to the terms and it returns you to the office signed in. Pretty frictionless." This answers the question I could not answer from here (whether the app opened signed in after the form): it does. He also said to keep the repository public for now, so the privacy point about business names in workflow records stays open as a decision, not closed.

**The gap (found 2026-10-17, recorded earlier).** The pipeline decided whether to deploy, and whether a migration changed, by comparing the new commit with the PREVIOUS commit on `main`. If that previous commit had failed its tests and never deployed, a following tests-only commit answered "no Worker change" and the deploy was silently skipped, leaving the red commit's Worker change undeployed and, if it had a migration, skipping the staging gate that exists to protect migrations.

**The fix, and why this shape.** Ask PRODUCTION what it runs. The deploy stamps its commit into the Worker (`--var GIT_SHA`), `/health` reports it, and the pipeline's lookup (`tools/deployed-base.sh`) believes the answer only when it is a full 40-character lower-case sha that is an ancestor of (or equal to) the commit being built; anything else prints nothing, and the decision step treats "unknown" as "deploy and gate". **Rejected: "compare with the last SUCCESSFUL run".** It is simpler (no Worker change) but wrong in at least one case that exists: a rollback DRILL ends "success" while the Worker is rolled back to the previous version, so the run's commit would claim code production is not running. Asking production cannot be wrong that way, and a rollback restores the previous version's variables, so `/health` tells the truth after one too. **Cost, stated:** the first push after this, with an old Worker reporting no commit, deploys and runs the staging gate (it did, and both passed), and any transient failure to reach `/health` does the same; a manual run still always deploys and is never gated.

**Proof, in the order it was gathered.** (1) 44 checks written FIRST and run against the old pipeline (30 failed, as they should): the lookup script executed against every answer production could give (no field, null, wrong types, not JSON, empty, unreachable, an abbreviated sha, a branch name, `HEAD`, a revision expression, an option git would obey, upper case, trailing newline, spaces, 41 and 39 characters, an unknown sha, a sibling branch's commit, production NEWER than the build, an enormous body) and the REAL decision step extracted from `deploy.yml` and run against the real history that bit me (production runs c0, c1 changes the Worker and adds a migration and fails, c2 is tests-only: it must deploy AND gate; judged the old way it says neither). (2) Thirteen breakages, twelve caught; the survivor was an explicit "does this commit exist" check that `git merge-base --is-ancestor` already makes redundant (it fails for a commit the repository does not have), so I deleted it rather than keep dead code. (3) A branch rehearsal on real Cloudflare: 16 of 16, including that the REAL staging Worker's `/health` reported the exact commit it was deployed from (so `--var GIT_SHA` works with the real wrangler before production depended on it). (4) The first production push behaved as designed (no commit reported, so deploy and gate; both passed; smoke test passed). (5) A workflow-only commit then asked production, found it current, and SKIPPED the gate and the deploy: the "nothing to deploy" path, on the real pipeline. (6) **The drill:** commit A, a harmless Worker change (a comment) plus a check that fails on purpose: CI red, gate and deploy skipped, production unchanged. Commit B, tests-only: the deploy job ran, the live smoke test passed, and production then reported commit B. Under the old logic B would have skipped the deploy. The drill's one Worker-visible residue is a comment at the end of `types.ts`, kept as the record.

**Things that went wrong in this stretch.** A command exceeded the 300-second limit (adapter suite plus push plus a pipeline watch in one call) and returned nothing, leaving me unsure whether the push had landed; the lesson, applied since, is to keep each call short and to check the remote's state first when a call dies without output. (The push had landed.) One existing pin (`gate.test.js`) named the old variable and was updated deliberately.

**Not done.** The first real BAD migration path through the new gate decision (a migration inside a failed commit followed by a tests-only fix) is proven only by the executed decision-step test, not by a real migration on the real pipeline; I chose not to commit a real migration to production to prove it. The repository privacy decision is still open (kept public for now, by Pierre). Still open from earlier: the signup name is not copied into the business profile, owners cannot add staff in the app, no billing, no privacy policy page, convert and a real ended trial have not been seen in production.

---

## The reply envelope, Phase 1, 2026-10-19

**The request.** Pierre shared a design doctrine for the front end (a quiet void, a persistent orb, rooms, intent-driven responses, temporary analytical layers, history as a record) and said the backend had outpaced the app, which now felt flat, and that he wanted the backend wrapped up as far as possible so the front end could be designed. I audited the backend against the doctrine before proposing anything. The finding: the backend answers in SENTENCES (a status, the transcript and a text `message`, which the app reads as `data['message']`), where the doctrine needs it to answer in INTENTIONS. Also missing: structured reports (profit and loss and the aged reports exist only as PDFs), any analysis, any record of what The Office answered (`captures` stores what was said, not the reply), and any way to know what the user is looking at. What already existed and I did not touch: about fifteen room screens, the orb and the void with ember data feeds, the held-action confirm, reject and edit-field flow (the doctrine's draft-versus-commit rule), and server-side authorization on every route.

**Pierre's refinement, which shaped the design.** I had drafted the envelope as a bundle (intent class, rooms, evidence, a refuse mode, stakes). Pierre refined it before I built anything: the envelope is a projector, not a second intent engine or an authorization mechanism; it must keep four things explicitly apart (established facts, the recommended presentation, unknown information, and actions that must still pass through trusted execution); and it must not invent classifications or instructions the current implementation does not support. I rewrote the contract to match, and the rewrite removed things I had proposed: the intent classes, the rooms, the evidence and certainty fields, the stakes, and the refuse mode.

**The refuse mode, specifically.** I searched the pipeline for a structured permission-refusal signal and found none: capability checks happen inside the pipeline and a refusal surfaces only as words in `message`. So Phase 1 does not offer the mode, and a test pins that refusal-sounding words stay a plain message. This is the doctrine applied to my own design: say what is unknown rather than guess from text.

**Process, and what the evidence is worth.** (1) **Backward compatibility was shown structurally.** The suite's golden recordings are real replies from the real handlers; 19 of them changed (a new field appeared where the recording had nothing). Per my own rule that a re-recording is only safe after a structural check, I proved that removing every `experience` block from the regenerated files returns the old recordings exactly, rather than eyeballing a 573-line diff. (2) **A harness flaw was hiding survivors.** Four of my deliberate breakages reported "caught", but by a crash (the test could not find `ENVELOPE.md` from the mutation harness's copy of the code), not by the check meant to catch them. Fixing the lookup revealed two genuine gaps: nothing tested a numeric-string id with a valid type, and nothing tested the wrapper on a non-object reply. The second exposed a small real flaw: an array reply would have been spread into an object and lost. Fixed and tested. (3) **One gap I found by asking what could be guessed:** nothing tested that refusal-sounding words are not turned into a mode; added before the breakages. (4) **My tools stalled twice** on trivial commands (a one-off, recovered; the repository was intact), and a Python search worked where a grep did not. (5) Deployment waited for Pierre: he saw the test results and the proposed diff (seven files, 795 insertions; production code was one new 92-line pure module and three changed lines) before anything went out, and said he liked it.

**What I could not verify.** The staging rehearsal cannot elicit a held action or an ambiguous person because those need the live AI, so the real-object evidence for the confirm and clarify modes is the golden recordings (three genuine held-action replies recorded as `confirm`), not a live conversation. I also could not obtain a clean list of every intent the extractor produces, which is part of why no intent class is offered.

**Not done, said plainly.** Phase 2 (reports as data), Phase 3 (analysis), Phase 4 (a history and audit record), Phase 5 (workspace context from the app); the notification-failure alert and customer emails; the in-app plans button and the app's 401 handling; the terms and privacy pages; the live PayFast secrets; and the separate Google token-verification hardening.

---

## Conversational layer, Phase 1: words for what the pipeline found nothing to act on (2026-10-28)
Built on branch `converse-layer`; Pierre approved the doctrine wording and Phase 1 (subject to gates) on 2026-10-28, and Principle 2 of the constitution carries a dated amendment. `worker/src/converse.ts` runs only when the whole reply is the old failure text from an intent of "other"; it gives Kimi a persona, the real capabilities and the member's own last turns, no tools and no data, and shows its words only if they hold no digit and claim nothing was recorded. It can change only `message`. Kill switch `CONVERSE=off`. `tools/converse.test.js` and 24 breakages in `tools/converse-breakage.js`; see `CONVERSATIONAL_LAYER.md`.

## Lookup hardening: no unrelated fact on a no-answer or a failure (2026-10-28)
Found on staging: a conversational question answered by the lookup path printed an unrelated confirmed invoice. `answerFromMemory` now returns only "I don't have that on file." when the model opens with that, and a fixed safe sentence when the model call fails or is empty (it returned the first fact of the bundle). One recorded case changed, reviewed line by line. Separate branch `lookup-hardening`, tested alone before the conversation routing; see `LOOKUP_ROUTING_ARCHITECTURE.md`.

## Customer name guard: a near-match customer name is asked, with a third way out (2026-10-29)
Found by the Office read baseline: a new person's name could be silently matched to an existing customer whose name merely contained the spoken first and last words. Pierre pointed out the existing guards (the cross-role Identity Collision question; every money action held and naming the match), and added a third option: neither, or correct the name. Built on branch `name-guard`: the near match is asked before any write using the existing `ambiguous_person` hold with `candidateKind: "customer"`; confirm = the same one, reject = a new customer, `POST /actions/:id/correct` = the right name or forget it; `NAME_GUARD=off` restores the old behaviour. Two things left for Pierre: an exact name still loses to the first row containing the words (changing it altered two recorded "same person" scenarios), and a confirmed "same one" is asked again next time. See IDENTITY_ARCHITECTURE.md.
