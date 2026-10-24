> **Status:** real. **Verified:** not yet. **Owns:** none.

# DECISIONS: identity-and-people

Part of [DECISIONS.md](../../DECISIONS.md), split from it on 2026-10-24 without changing a word (the original is `git show 95bf743:DECISIONS.md`). Sections keep their original order.

## Cross-role identity collision — a real, deterministic alternative to teaching every ambiguous phrasing (2026-07-22)

**The real problem this replaces, named honestly.** Fixing the "Thabo
upstairs is twenty five square meters" misclassification (below) by
adding a rule and an example is a real fix for that one phrasing, but
not a real fix for the underlying class of problem — natural language
has effectively unlimited variation, and no number of examples ever
converges. Pierre named this directly, and correctly.

**The actual, precise fix: this was never a language-understanding
problem. It's a missing, checkable fact.** Thabo already has an
established identity in this system — a real character, an installer.
The question was never "is this sentence ambiguous," it's "does this
message's role assignment for this name conflict with what's already
on file." That's not something to ask a model to judge better. It's a
direct database lookup, exactly the same "code decides, model only
transcribes" discipline already proven everywhere else in this
project.

**The real, sharp distinction Pierre's own examples draw, worth
building exactly as stated:**
- **"Thabo measure X" / "Thabo is installing Y"** — the extracted role
  (installer, performing work) matches Thabo's already-established
  role. No collision. Stays completely frictionless — this is the
  common case, and it must never gain friction from this fix.
- **"Thabo paid R5000" / "schedule a meeting with Thabo about
  pricing"** — the extraction would place Thabo in a customer-shaped
  role (paying, being quoted), but the only "Thabo" on file is a
  character. A real, checkable mismatch: this name has an established
  identity in one table, and this specific message is trying to use it
  in the other. Reuses the exact same "ask when genuinely ambiguous"
  rung already proven throughout this project (Principle 24's Ladder)
  — not a new mechanism, an application of one already trusted.

**The real mechanic**: before reconciling a newly-extracted
customer_name or character_name, check the *other* table for the same
name too. If it matches nothing there, proceed exactly as today —
zero added friction for the overwhelming majority of real messages. If
it matches an existing record in the other table, that's a real,
detected collision — hold it and ask, rather than either silently
creating a duplicate identity or silently misassigning the role.

**Real, open questions, deliberately not answered here:**
1. What does "ask" actually look like mechanically — a new
   pending-action type requiring a real yes/no answer before anything
   else about the message gets written, or something lighter?
2. If Peter confirms "yes, same Thabo," does the original message get
   reprocessed automatically with the corrected role, or does he need
   to restate it? Reprocessing is more seamless but touches more of the
   pipeline; restating is simpler to build but real friction on an
   already-rare case.
3. Exact-name matching only, or does this need fuzzy matching (a
   nickname, a spelling variant)? Exact-match-only is the safer,
   simpler start — a fuzzy match risks flagging collisions that were
   never real ones.

**Explicitly not built tonight** — this touches the core reconciliation
path every single message in this project runs through; a change at
this scale deserves to be specced properly first, not rushed at the
end of a long session. Pinned precisely so the real distinction (a
checkable fact, not a language problem) survives intact.

## Identity Collision — built, tested, and a real lookup-side gap found and fixed the cheap way first (2026-07-25)

**The real feature, given directly by Pierre weeks earlier and built
here**: before a new customer or character record would ever be
silently created, `checkCrossRoleCollision` checks the exact same name
against the *other* table — a direct, deterministic database lookup,
never a model judgment call. If the name doesn't already exist in its
own, intended table, and does exist in the other, that's a real,
detected collision. Only fires on exact name matches, and only when a
new record would otherwise be created — the common, frictionless case
(a known installer referred to as an installer) is completely
untouched.

**Confirmation creates a real, new record, then reprocesses the
original extraction** — an installer can genuinely also become a real
customer, as two separate, real records. Reprocessing naturally
doesn't re-trigger the collision, since the name now exists in its own
table — the exact same `reconcileCustomer`/`reconcileCharacter` logic
just finds it normally from there. `captureId` is preserved through
reprocessing so same-breath assembly context isn't lost.

**Verified live on the first real test**: "Floornet paid us R500" —
Floornet already existed only as a supplier character — correctly
held for confirmation, correctly created a real, new, separate customer
record (id 19) on confirmation, and correctly fell through to the
normal payment flow from there.

**A real, honest gap this same test surfaced, and a real, precise fix
found for it — the cheap fix, tried before the expensive one, exactly
as planned.** The collision check only ever runs on writes; a lookup
like "does Floornet owe us anything" bypassed it entirely and
resolved straight to the supplier, since lookups are deliberately
read-only and were never meant to create anything. Pierre's own
correction here was the right one: rather than building an expensive
"check both tables on every lookup" mechanism, the real, natural
direction of the question — "X owes us" versus "we owe X" — should
already disambiguate on its own, the same way a real person would
never confuse the two. The first test of that theory showed it wasn't
actually true yet, though — both phrasings resolved to the supplier
regardless of direction. Traced to a real, specific bias: "Floornet"
had been used as a supplier example six separate times throughout this
same prompt, and the model was very likely pattern-matching the name
itself rather than reading the sentence's actual direction. Fixed with
a real, explicit rule, and — deliberately — a fresh, neutral worked
example name never previously associated with either role in this
prompt, rather than reinforcing the same bias with a seventh Floornet
example. Verified correct on both directions after the fix, and on a
real, full message-processing test, not just the raw extraction.

## The receptacle audit — Mr Stevenson, and where Layer 1/2 doctrine meets real complexity for the first time (2026-08-09)

A real, natural, multi-clause booking — a job, an amount, an
installer, and a date, all in one breath — repeatedly failed to
schedule correctly across five real attempts. Requested afterward:
read back through the actual governing doctrine (`OFFICE_CONSTITUTION.md`,
`DECISIONS.md`, `STATUS.md`) to see what was already decided and where
the real gaps sit, rather than treat this as an isolated string of
bugs. It isn't one — it's the first time this doctrine's own stated
promises met a genuinely complex, real utterance, and several of them
didn't fully hold.

**The promise being tested, named precisely.** Principle 3 (Nothing Is
Lost) and Principle 22 (Capabilities Emerge From Captured Reality) —
"Peter doesn't maintain business systems. He describes reality, once,
in his own words" — is exactly what "invoice Stevenson for R20,000 for
two rooms of laminate, schedule Jabulani to install next Monday" is:
one real utterance meant to update several things at once. Tonight
proved that promise doesn't yet hold for this specific shape of
complexity.

**Principle 28 claims more than tonight's evidence supports, and the
doctrine should say so plainly rather than leave the gap silent.** It
declares Layer 1 (Reliability — "a deterministic fact heard clearly...
must never disappear before reaching storage") "genuinely resolved" as
of 2026-07-15, on the strength of a real R9,000 quotation. The
2026-07-24 Layer 2 scheduling entry found the same thing again,
independently — extraction and storage worked correctly for "measured
Thabo hallway at fifteen square meters for laminate, doing it next
Friday." Both real, both true — and both single, unsplit utterances
where every fact arrived in one continuous statement. Tonight's real
test was the first to combine an amount, a room, an installer, and a
date across what `splitIntoTopics` treats as multiple separate topics
— and extraction completeness broke down exactly at that seam, not
because it regressed, but because it was never actually tested against
this shape before. Layer 1 is resolved for the utterance shapes it was
tested against; tonight is real evidence it isn't yet resolved for
this one.

**Layer 2's existing mechanisms don't have a gap where I assumed one —
they share one, single, unexamined precondition.** Read directly
before building anything tonight, not assumed: same-breath assembly
(2026-07-22) requires `customerId !== null` to run at all. Cross-
capture attachment (2026-07-25) requires `scope.customer_id !== null`
too. Both are real, correct, already proven — and both were built and
tested against segments that always had a real customer resolved.
Neither considers the case where a segment has real, valuable
information (an installer, a date) but genuinely no customer of its
own — exactly what "schedule Jabulani to install next Monday," split
away from the sentence that named Stevenson, actually is. The new
`attachToSiblingJobScope` (scheduler.ts) fills that specific,
confirmed-real gap — matched only on `capture_id`, deliberately not
`customer_id`, since the whole point is handling the segment that
doesn't have one. Confirmed directly against the code, not assumed:
this doesn't duplicate or conflict with either existing mechanism: they
solve "how do complete job scopes relate to each other"; this solves
"how does an incomplete segment's real information reach the sibling
it belongs to."

**A second, separate, still-open gap: what a segment's content means,
not just how the sentence gets divided.** `/debug/intent-test`,
confirmed directly: "the job is the one we invoice for 20,000 rand to
rooms" classifies as `intent: "invoice"` — reading a present-tense,
referential amount (identifying which existing job is meant) as an
instruction to bill new work. No existing principle or prior Layer 2
entry names this distinction — it's a genuinely new category of gap,
not a previously-decided thing implemented wrong. Deliberately not
patched tonight: fixing it well likely means either `splitIntoTopics`
preserving more shared context between related segments, or a real,
new way of naming "this amount identifies an existing thing" apart
from "this amount states a new one" — not a quick prompt tweak guessed
at near midnight. Real, related, and confirmed independently by
`customer_name: "rooms"` on the same test — a hallucinated common noun
where no real name existed in the segment at all. That one *was* fixed
and reverified live via the same tool.

**The real, durable win independent of any single fix tonight:**
`/debug/split-test` and `/debug/intent-test` — real, read-only, direct
views into two steps of the pipeline that previously had zero
visibility, closing exactly the kind of guessing that cost real cycles
on both the ember shader and this arc. The customer_name fix was
verified true, not just claimed, because these existed.

**What's genuinely still open, named rather than left implicit:**
whether Principle 28's Layer 1 status needs a qualifying update instead
of a flat "resolved"; whether `attachToSiblingJobScope` should extend
to the installer-double-booking check it currently skips; and the
intent-misclassification gap above, which needs real design thought,
not a rushed patch.

**Real bug found live, 2026-08-26 — a pure scheduling voice note
silently discarded.** "Schedule the Premier Hotel to be installed
tomorrow" — a named customer, a real date, no measurements or task
text — produced no job scope at all, and nothing showed up in
Scheduler. Not a date-parsing bug: `resolveScheduledDate` correctly
turns "tomorrow" into a real ISO date, and `recordWorkObservation`
correctly saves it once called. The actual bug was one step earlier —
the gate deciding whether to call `recordWorkObservation` at all only
ever checked `observation.components.length > 0 ||
observation.tasks.length > 0`, never whether a date or installer was
actually extracted. A pure "schedule X" statement satisfies neither
condition, so the whole thing was skipped before the correct,
downstream logic was ever reached. Fixed by also checking
`scheduled_date_raw`/`installer_name` in that gate.

Two other, similar-looking gates checked and deliberately left alone,
not silently assumed safe: the `price_scope` fallback path (a
different context — nothing measured genuinely means nothing to
price, so skipping is correct there) and the sibling-attach path added
2026-08-09 (a different scenario — no customer named at all, not a
named customer with no measurements).

**The real, durable gap this exposed:** unlike `extractIntent`
(covered by `/debug/intent-test`, `/debug/split-test`, and 22 cases in
`/debug/smoke-test`), `extractWorkObservation` and its recording gate
had zero live visibility — exactly why this went unnoticed. Closed the
same way those were: added `/debug/work-observation-test`, read-only,
same real, proven zero-side-effect design.

**What was genuinely still open at that point:** the fix had not been
independently, empirically verified against a real voice transcript —
confirmed by direct code reading, not by observing corrected live
behavior. The existing 22-case smoke suite doesn't exercise this code
path either (it stops at `extractIntent`), so a clean run there would
not, on its own, confirm this specific fix.

**Real, second bug found — this one only surfaced because verification
kept going instead of stopping at the first green light.**
`/debug/work-observation-test` confirmed the gate fix worked in
isolation (`wouldRecord: true`, `resolvedDate: "2026-08-28"`). On that
basis, a real fresh native build was run and the same voice note
spoken again — and the job still didn't reach Scheduler. It showed up
as a task instead. That test call had a real, honest blind spot: it
invoked `extractWorkObservation` directly, which meant it never
verified that the real, upstream `extractIntent` classifier would
route this phrase there in the first place. Called `/debug/intent-test`
directly against the exact phrase — confirmed `intent: "reminder"`,
not `"work_observation"`. A second, genuinely different, earlier bug,
not a recurrence of the first.

**Root cause:** `work_observation`'s own written definition in the
extraction prompt only ever described "measuring, scoping, or
inspecting a job" — it never once mentioned scheduling or assigning a
date or installer, even though the downstream code
(`extractWorkObservation`, `resolveScheduledDate`) was already built
correctly to handle exactly that. The classifier had no way to know a
pure scheduling statement belonged there, so it reasonably fell back
to "reminder" — genuinely, structurally similar wording ("remind me to
call Jenny by Friday" vs. "schedule the Premier Hotel... tomorrow").
Fixed by adding an explicit clause to `work_observation`'s definition,
naming the exact confirmed phrase as a worked example, rather than a
broad rewrite that could shift other, already-correct classifications.

**The full, real verification chain, each link checked before trusting
the next:**
1. `/debug/intent-test` re-run against the same phrase — confirmed
   `intent: "work_observation"`.
2. `/debug/smoke-test` re-run — all 22 cases still passed, including
   the one closest in shape to the new clause ("heading to jenny's job
   now, remind me to get dog food after" — still correctly classified
   `"reminder"`), confirming the new clause is genuinely narrow, not a
   rule that happened to fix one case by loosening the boundary
   everywhere.
3. A real, fresh native build, the exact same voice note spoken again
   — the job appeared in Scheduler: correct customer, correct
   description, correct date.

**Why this is the real, worked example of the discipline asked for
directly:** two separate, real bugs, in two different layers of the
same pipeline (a downstream recording gate, an upstream classification
definition), each one found by direct code investigation rather than
guessing, each fix checked in isolation before being trusted, and nothing
declared "done" until the actual, live behavior was observed — not
just a diagnostic tool's output. The first fix alone would have shipped
looking correct (its own test passed) while the real, reported bug
remained completely unfixed. Layered verification, not single-point
confirmation, is what actually caught that.

**Calendar integration, 2026-08-27 — Scheduler's real, first "third
tap": a job leaves the Office and exists somewhere else.** Every real
feature built before this stayed inside the app. This is the first
time a job genuinely, permanently exists outside it — a real device
calendar entry, shareable, visible without ever opening the Office —
directly following the newly-settled principle that the third tap is
where the app stops describing and starts touching reality.

**A real dead end, checked directly rather than assumed away.** The
existing Google OAuth in this codebase was suspected as reusable
infrastructure for this. Checked directly instead of assuming: it
requests only `openid email profile`, and the code only ever captures
an `id_token`, never an access or refresh token. That's genuinely
login/access-control — verifying who's allowed to use the app at all
— not authorization to act on a user's calendar. A real, different
capability that happens to share the word "OAuth." Reusing it would
not have worked; this was confirmed, not guessed.

**The real, simpler path: Android's own native calendar, no OAuth at
all.** Confirmed via direct search: a real, built-in Android content
provider, needing only standard `READ_CALENDAR`/`WRITE_CALENDAR`
runtime permissions — the same familiar pattern already used for
microphone access. For anyone with a real Google account already
signed into their phone, the OS itself keeps the device calendar
synced with Google Calendar automatically, delivering the real,
practical outcome wanted without OAuth ever entering the picture.

**A real mistake caught and fixed before any code was written.** The
first draft of `CALENDAR_INTEGRATION_ARCHITECTURE.md` named
`device_calendar_plus` as the chosen package, but described the
hand-off, pre-filled behavior that's specifically `flutter_native_calendar`'s
feature — `device_calendar_plus` is built around direct read/write, a
different mode. Caught by re-reading the document's own claims against
what was actually verified, corrected before any implementation began.
`flutter_native_calendar` (confirmed real, current version `^0.3.0`
directly against pub.dev) became the real choice for this first
version; `device_calendar_plus` correctly named instead as the right
choice for a later, direct-write version.

**A second real, structural discovery, this one about the repo
itself.** Attempted to edit `AndroidManifest.xml` directly to add the
new permissions — it doesn't exist in the repository at all. The
`android/` directory is deliberately not committed; it's generated
fresh on every build via `flutter create`, per `codemagic.yaml`. The
real, correct, already-established mechanism for this exact situation
was `patch_android_manifest.py` — a real, existing script, already
proven for microphone and camera permissions, that patches the
freshly-generated manifest as a build step. Editing the (non-existent,
non-persistent) committed manifest would have been real, wasted effort
that silently did nothing on the next build. Found before that mistake
was made, not after.

**Deliberately narrow first version, matching the same "smallest real
domino" discipline used everywhere else tonight.** A real, explicit
"Add to Calendar" action per job — not an ongoing sync, which would
mean handling updates, deletions, and duplicate prevention correctly,
forever, on someone's real calendar. Hands off to the device's own
calendar app with the job pre-filled (customer, description, an
honest all-day event, since only a date was ever extracted from
voice, never a specific time) — the person taps save themselves. No
`WRITE_CALENDAR` permission requested yet; that's the real, named next
step once this version is proven, not attempted here.

**What was genuinely uncertain going in, named rather than assumed
safe:** this was the first native-platform package dependency added
all night — everything before it was pure Dart, verifiable by the
automated web-preview build alone. A mobile-only native plugin could
plausibly have broken that same web build, or worked differently in a
real native build than the web preview could ever show. Checked
directly rather than hoped: the web-preview build was confirmed
passing with the new dependency in place before writing any Dart code
against it, and the real native build and a real device tap were what
finally, actually confirmed this working — not assumed from a clean
compile alone.

**Real, found discrepancy, pinned rather than fixed — imported
historical invoices double-charging VAT on PDF generation.** Checked
directly against a real, generated PDF for an imported invoice
(ZF21426): the source CSV shows `Tax: 0, Subtotal: 11860, Total:
11860`, but the generated PDF showed VAT of R1,779 and a total of
R13,639. Root cause, confirmed directly in the existing PDF code: any
invoice's stored `amount` automatically gets 15% VAT added at PDF-
generation time unless that customer is explicitly marked VAT-exempt —
correct, sensible behavior for a new invoice created through voice,
where the amount is genuinely a pre-tax subtotal. The CSV import
instead stored the file's own `Total` column — already the real,
final, historically accurate figure — so the existing logic then added
a second, fictional 15% on top of a number that was already complete.
Likely affects most of the 271 already-imported invoices, since the
real, uploaded file shows the large majority with `Tax: 0`.

**Why this is pinned, not fixed immediately, in the pinner's own
words:** "the notion that another business would be as messy as me is
unhinged." The real, uploaded data shows the same customer sometimes
billed with tax, sometimes without, across the same business's own
history — which the existing, simple all-or-nothing per-customer
VAT-exempt flag genuinely cannot represent. Building a general,
per-invoice tax-final override to solve this would be solving for a
problem that may be specific, real mess from one business's own
history — not a universal case every future business's historical
import would need. Real evidence from a second business would change
this; none exists yet.

---

## Building the identity layer — from research to a real, safely-backfilled foundation

**Started from `IDENTITY_ARCHITECTURE.md`, itself built on real,
external research** — Git's `.mailmap` discipline, and real,
independently-converging patterns checked directly against Twenty
CRM's and Frappe/ERPNext's live schemas, not just summaries.

**The real, first step was deliberately narrow and purely additive:**
a new, empty `people` table, and nullable `person_id` columns on
`customers`, `characters`, `leads`. Nothing existing read, touched, or
altered — the same, proven migration discipline as every schema
change tonight.

**`reconcilePerson` built next, implementing the real, precise
threshold from the architecture document** — an exact match
reconciles; no match is genuinely new; anything weaker (a short token
under 8 characters, even with one candidate, or multiple candidates at
any length) is never guessed, returned as ambiguous instead.
Independently verified against real SQLite behavior, across all four
real outcomes, before ever being pushed.

**A real, genuinely confusing deployment mystery followed, worked
through methodically rather than guessed at.** The new diagnostic
route returned a bare "Not Found" with no real, useful detail.
Ruled out, one real, direct test at a time, in this order: a
structural routing problem (a zero-logic sibling route, added the
same way, worked fine); a caching issue (a fresh, uncached URL still
failed); a genuine Cloudflare platform incident (checked directly
against Cloudflare's own, official, real-time status API — nothing
relevant, unresolved). The actual cause only became visible once the
route was rewritten to catch and surface its own real error instead of
letting it throw uncaught — at which point it simply worked, cleanly,
on the next normally-timed deploy. Two consecutive, unusually slow
deploys immediately before this were the most likely real explanation
in hindsight: a genuine Cloudflare edge-propagation delay, not a code
defect — code, imports, and call sites were all independently
re-verified correct throughout and never needed to change.

**The real backfill was built with a safe, honest default: dry-run
first, real writes only on explicit `?commit=true`,** per the
architecture document's own stated caution to run this "reviewed, not
assumed correct silently." The first dry run surfaced a real, serious
bug in the backfill's own logic, not a pre-existing one: it only
checked for an exact string match across tables, without applying the
same 8-character caution `reconcilePerson` already used going
forward. Confirmed as a genuine bug, not a hypothetical one, by real,
direct knowledge: "Sipho," "Thabo," and "Alfons" were confirmed to
each be different, real people despite an exact name match — only
"Andre" happened to be correct. Three wrong, automatic merges would
have been committed silently if this dry run had been trusted at face
value instead of actually read.

**Fixed by applying the identical threshold already proven in
`reconcilePerson`, verified against the exact, real, confirmed bug
scenario before being pushed again.** The second, corrected dry run
showed every one of those real collisions correctly flagged for
review instead of merged — including "Andre" itself, applied
consistently rather than specially exempted, since the system has no
way to know in advance which short-name match is the safe one.

**The real, final judgment call: commit now, since the safe default
already prevents any wrong merge, rather than delay for a full
resolution tool first.** The one, real gap that decision accepts —
Andre's two records staying split until manually reviewed — is a
small, reversible cost against the real, immediate benefit of giving
every future capture a populated `people` table to check against.
Paired with one, small, real addition so that gap couldn't quietly get
lost: a persistent `needs_merge_review` flag on `people` itself, and a
plain, direct `/debug/people-needing-review` endpoint — so the six
real, flagged records (two Andres, two Siphos, Alfons, Thabo) stay
genuinely findable whenever there's time to resolve them by hand,
rather than disappearing into a one-time API response.

**Committed successfully. Zero wrong merges — the one measurable this
entire effort was built to guarantee.**

---

## A third, distinct register-staleness bug — found by direct insight, not by chasing the code

**Real sequence that broke:** "What does Alfons owe us?" (correctly
answered, R8150) → "Does Andre owe us anything?" → answered with
Alfons's real facts again, though worded honestly enough to notice
its own mismatch: "I don't have that on file, the information I have
is for Alfons."

**The real, key insight belongs to Pierre, not to chasing the
identity code.** Directed straight at the actual cause: "look in the
cache or persistent conversation section." That one line pointed
past two real, plausible but wrong theories tonight (a bad match in
the new `reconcilePerson` shortcut; the older register-staleness fix
from earlier not covering this case) — both checked and ruled out
directly, not assumed — to the real, third, distinct cause.

**Confirmed: for a `lookup` intent, `reconcileCustomer` is never
even called — a separate, read-only function, `findExistingCustomerByName`,
is used instead**, and correctly, honestly returned no match for
Andre. The real bug was one level up: the register-check that runs
afterward only asked "is `customer` still unset," never "why." A
real name that was genuinely given and honestly didn't match was
being treated identically to a vague, nameless follow-up — both
leave `customer` unset — and silently fell through to the register's
stale selection instead of the honest "not on file" answer. The
earlier, same-night `containsBackwardReference` fix didn't cover this
either, since it was deliberately scoped only to `query_scope ===
"business"`; this case's scope was `"customer"`, never touched by it.

**Fixed with one, real, precise addition: the register only fires
when no real name was given in the message at all.** Traced against
every already-proven case tonight before pushing — the ProSupply
follow-up, "who owes me money," a genuine vague "his address" — all
have no real name extracted, so none were at risk; only the new case
(a real name given, honestly unmatched) changes. Confirmed live,
twice: the exact, original failure now answers honestly with no
mention of Alfons; and immediately after, a genuinely vague follow-up
("what's his address") still correctly resolves through the register,
unaffected.

**Real, honest pattern worth naming for whatever comes next:** three
separate, distinct bugs tonight all trace back to the same, single
mechanism — a name-check that only asks "do I have an answer" without
asking "do I actually have grounds to be confident in it." Worth
remembering as its own, real principle the next time a lookup falls
back to something plausible-looking, not just for the register
specifically.


---

## Relational Identity Architecture pinned — a second, auxiliary signal for the genuinely ambiguous cases

**The real, honest starting point:** the six people still sitting at
`/debug/people-needing-review` aren't a backlog problem — they're
proof that `reconcilePerson`'s string-threshold matching has a real
ceiling. It resolves identity from a name alone. It was never going
to responsibly resolve two genuinely ambiguous names on its own, and
it shouldn't be pushed to.

**The real insight, arrived at by thinking through the problem out
loud rather than by staring at the schema:** a person isn't just a
name — they're a position in a real web of who they've talked to,
which jobs they've touched, and when. Two independent conversations
that keep circling the same job, the same referral chain, the same
time-of-day pattern are real evidence of identity, separate from and
complementary to a matching string. `RELATIONAL_IDENTITY_ARCHITECTURE.md`
pins this as a genuinely new, staged layer: passive edge-logging
first with zero behavior change, then a tiebreaker consulted only in
the exact ambiguous zone `reconcilePerson` already can't resolve
alone, then Vectorize-based shape-matching named honestly as a later,
separate stretch — Vectorize already sits in this stack, provisioned
and mostly unused for this.

**The real, deliberate boundary drawn before any of this gets built:**
it was tempting, in thinking this through, to imagine a system that
eventually recognizes its own emergent patterns and lets that
recognition become a new category on its own authority. Named
directly and rejected: that's functionally identical to letting AI
invent a business fact instead of routing to a deterministic one —
the exact thing the AI-routes-it-doesn't-decide principle exists to
prevent. Any future capability that proposes a new relational
category still goes through the same human-confirmation gate as every
other consequential write in this system, permanently, not as a
placeholder for once the tech is better.

**What stays true regardless of how far this goes:** `reconcilePerson`
keeps its current authority untouched. The new layer only ever adds a
second opinion in the cases it's already honest about not being sure
of — it never gets to auto-merge anything by itself.

---

## The people-table merge gap, closed — confirmed with the same real case that exposed it

**The real, honest starting point:** customer-level merges never touched the underlying `people` table, so a merged duplicate's name kept surfacing as its own separate candidate in `reconcilePerson`'s exact, whole-word, and Soundex queries. Confirmed as the real cause, not just suspected: this is exactly why "bon waterfront" still showed three candidates after the Bon Hotel Waterfront merge earlier tonight, when it should have shown two.

**The real fix, two halves:**
1. `identity.ts` — `merged_into_person_id IS NULL` added to all three of `reconcilePerson`'s real queries, so a merged person is genuinely invisible to future matching, not just renamed elsewhere. The same real gap found one level down and fixed too: `reconcileCustomer`'s two direct customer-table queries and `checkCrossRoleCollision`'s customer-side check now exclude `merged_into_customer_id IS NOT NULL` rows — otherwise an exact re-mention of a merged customer's old name would still resolve straight back to the now-defunct row. `characters` has no merge column yet and was deliberately left untouched — no evidence of that specific bug.
2. `index.ts` — `/debug/init-people-merge` (new column) and `/debug/merge-customers` extended to actually perform the people-level merge: reads each side's real `person_id`, repoints anything else referencing the losing person onto the survivor, and marks the losing person via `merged_into_person_id` — never deleted, same inspectable pattern as the customer-level merge.

**Confirmed working, real data, the exact case that exposed the gap:** re-running the Bon Hotel Waterfront merge (215 → 41) returned `peopleMerged: {fromPersonId: 221, intoPersonId: 29}`. Saying "bon waterfront" again afterward produced a real picker with exactly two candidates — "SCHOONIES SEWE T/A BON WATERFRONT" and "Bon Hotel Empangeni" — with "Bon hotel waterfront" genuinely gone. Full loop closed: the same real sentence that caused the original fragmentation now resolves correctly.

---

## A real, live duplicate-customer bug, and the silent drop it exposed next to it

**The real starting point:** a live dictation, "invoice Alfons R5000 for repairs", produced a second customer alongside the existing "Alfons", differing only in capitalisation. The first question was why the "is this the same person?" check never fired.

**Traced directly, then reproduced on a real SQLite database rather than assumed:** `wholeWordClause` (identity.ts), the shared single-word name matcher, is `column = ? OR column LIKE ? OR ...`. SQLite's `LIKE` ignores ASCII case, but plain `=` does not, and a one-word name can only ever match through the `=` branch (the other three patterns all need a space). So `alfons` against a stored `Alfons` found nothing. Multi-word names such as "Jenny Smith" were never affected, since they match through `LIKE`. The reason the ask-first check stayed silent is that two checks in the same flow disagreed: the preamble's own existence check uses `COLLATE NOCASE`, found "Alfons", and so skipped the ambiguity question, while `reconcileCustomer` then used the case-sensitive matcher, found nothing, and inserted a new row. The speech recogniser capitalises the same spoken name inconsistently, so this was reachable by ordinary use.

**Fixed:** `COLLATE NOCASE` on the `=` branch, one line. The same helper serves customers, characters, people and products, so all four are fixed together. Verified against a real database: the reported case now matches; results for exact-case names are identical to before for every first and last token tested; the earlier Andre/Juandre and partial-word fixes still hold. Typecheck clean against the baseline, role matrix 165/165, CI green.

**Confirmed live:** an existing customer "Sheriff", dictated as lower-case "sheriff", matched the existing customer and produced a confirmation rather than a new row.

**Not done, deliberately:** the one existing "Alfons"/"alfons" duplicate is not merged by this fix. A merge route already exists (`/debug/merge-customers`, repoints records and marks the losing row, never deletes); a spoken "merge X into Y" intent was judged not worth building yet, since the cause is fixed and other name variants already trigger the ask-first question.

**The second finding, found while chasing a suspected regression:** "invoice site service R5000 for repairs", typed in lower case against an existing "Site Services", returned "I didn't catch anything there I could act on." A suspected regression from the day's deploys was ruled out directly: `/debug/intent-test` (extraction only, no identity code) showed `customer_name: null` for that text, and the correctly capitalised "Site Services" extracted fine, with intent `invoice` and amount 5000 read correctly both times. So the AI missed the name; nothing we deployed was involved. The real gap was downstream: `invoice`, `quotation` and `payment` all require a resolved customer, and with none, no Pass 2 branch matched, so a correctly understood R5000 invoice fell through to the generic nothing-happened message. The supplier intents already avoid this with their own "no supplier was named" branches; these three did not.

**Fixed:** a new branch, placed before the generic catch-all, says what was heard and what is missing ("I heard an invoice for R5000, but no customer name came through — who is it for?"). Checked mechanically that it reads only `customer` and `pendingActionId` and sits ahead of the catch-all. One behaviour change to note: a payment with only a supplier name resolved used to say "Found existing: X" and quietly do nothing; it now asks for a customer. Typecheck clean, role matrix 165/165, CI green. **Live check of the new message itself is still pending**, so it is not claimed as confirmed.

**Still open:** the AI can still miss lower-case names. A deterministic fallback matching the typed words against existing customers, held for confirmation in the same ask-first style, was proposed but not built.


---

## Decisions session, round 5: names and identity

Round 5, decided by Pierre:

**13. "Yes, the same person" now links them.** Confirming an identity question ("is this the same Jabulani, now acting as a customer too?") used to insert the customer (or supplier) record **unlinked** from the existing person, though the near-match answer links its record and the question reads "same person". The new record is now linked to the person the existing one already has; if the existing record has no person yet (one from before people were recorded), one is created and linked to **both**. The 2026-07-25 comment in the code said the record was created "separately"; that is now superseded by this decision.

**14. Rejecting an identity question says what was dropped.** "No, someone else was meant" used to record nothing and say nothing, so the person had to notice and repeat everything. The reply is now: `Okay, nothing was recorded. I didn't act on "<what was said>". Say it again with the name you meant.` (shortened with "..." past 120 characters). **This needed an app change as well:** the app only ever read the server's message after a *confirm*, so a message from a reject would never have reached the person. It now reads the message after a reject too, which also means that a near-match question rejected as "a new person", whose replay can leave a question of its own waiting, now shows that question with its buttons, as a confirm always did. The app change is one condition and a comment.

**15. Two jobs in one message ask about the customer's existing projects, as one job does.** They used to be grouped under a brand-new project whenever a second job for the same customer arrived in one message, even if the customer already had open projects, and no question was asked. Now, if the customer has an open project, nothing is invented: each job goes to the same step that places a single job (attached to the one open project, or asked about when there are several). A group project is still created when the customer has **no open project**. "Open" is the existing definition (no invoice yet, or an unpaid one), reused rather than approximated, so a customer whose only project is paid in full still gets a group project; a case pins that, and so does the "any project at all" mistake.

**Verified:** 2,831 checks; typecheck unchanged. **Of the recordings, six changed (the four identity confirmations now carry the person link, the reject gained its message, and "two jobs for a customer with two open projects" now asks), five were added, and every other recording is identical.** Seven deliberate breakages were caught: existing projects ignored; **any** project (even a paid one) suppressing the grouping; a confirmed same person left unlinked; no person created when the existing record has none; a silent reject; a reject message added to every rejected action; and the long-sentence shortening removed.

**Unverified on a phone:** the app change (the web build compiles it). It needs a Codemagic rebuild; see `OPEN_QUESTIONS.md`.


---

## Found by the fourth phone test: "TAL sounds like Thula", and what Reject means on an identity question

Pierre said "Order 20 bags of screed from TAL for jenny". The app asked whether TAL was an existing person, "Thula" (a customer). He rejected it, and the order was still created, linked to Jenny's job. His question was whether that was right.

**What the code does, and why it was right.** On a "sounds like someone already on file" question, **Confirm means "yes, the same one", and Reject means "no, a different one"**: rejecting creates the new person (here the new supplier TAL) and carries on with the original sentence. So rejecting did exactly what it should, and the order going through was correct. It only felt wrong because the word "Reject" sounds like "cancel everything". Jenny's costing afterwards showed the order as one unpriced line outstanding, which is the first sighting of the order-to-customer link (decision 52) working on the real model (it is unpriced because no price was said).

**Two real annoyances, both decided by Pierre.**
1. **A supplier's name was being compared with customers.** The check compared a new name with everyone on file, so a supplier company called TAL was held against a customer called Thula (they sound alike). **Now a supplier name is only checked against people who are themselves suppliers.** The sound-alike and partial-name checks are narrowed; an exact same name still matches across roles, and the separate collision question ("already on file as a customer, now a supplier too?") is untouched. An installer, a customer, or a name with no relationship stated is checked against everyone, exactly as before.
2. **The buttons.** On an identity question (a sound-alike, or a same-name collision) they now read **Same person** and **Different** instead of Confirm and Reject, in the reply and in the pending-items list. Every other question keeps Confirm and Reject. App only: the words are chosen from the type of question by a small helper.

**The property that matters.** Against `main`, **no existing recording changed or was removed**; 4 were added: a new supplier sounding like a customer is created with no question; a supplier sounding like another supplier still asks; a new installer sounding like a customer still asks; and a name with no relationship stated still asks.

**Verified:** typecheck unchanged; **4,579 checks**. **Two deliberate breakages were caught:** the relationship no longer passed (the original annoyance returns), and the rule applied to every name (this broke 14 existing recordings, which shows how well the existing cases guard against over-applying it). **The app change cannot be compiled or run here:** it is four label lines and a five-line helper, with the web build in the pipeline as the compile check, and it needs a Codemagic rebuild and a look on the phone.

**A limit worth knowing, recorded as an open question.** Most suppliers are created from an order sentence **without a person record**, so the "sounds like another supplier" check only ever sees the few that have one (for instance a supplier created by answering one of these questions). A near-duplicate supplier name ("Floornit" for "Floornet") is therefore usually **not** caught: it simply creates a second supplier. That was true before this change and is not made worse by it.

**Correction, same day: the first push of the button labels broke the app's web build.** The pipeline's web build failed ("Build web"), which is exactly what it is there to catch. Cause: the helper that picks the words took a plain `String`, but `PendingItem.type` is `String?` (it can be missing), and Dart refuses a possibly-missing value where a definite one is required. I checked that the list screen's own variable was in scope but not its *type*, and the two call sites in the reply used the nullable one. Fixed by letting the helper accept `String?`. The server side of the same push was unaffected and is live. Lesson: for an app change that cannot be compiled here, check the declared type of every value passed into a new function, not just that it exists.


---
