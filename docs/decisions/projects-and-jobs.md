> **Status:** real. **Verified:** not yet. **Owns:** none.

# DECISIONS: projects-and-jobs

Part of [DECISIONS.md](../../DECISIONS.md), split from it on 2026-10-24 without changing a word (the original is `git show 95bf743:DECISIONS.md`). Sections keep their original order.

## The Succession Asset — a real reframe of what Office ultimately is (2026-07-17)

**The observed problem, real and directly witnessed, not theoretical:**
South Africa's flooring trade is aging out with no real youth pipeline
behind it — businesses that don't survive past the founder, closing
outright rather than transferring. **Why they actually close:** rarely
the tools, the truck, or the client list. The real asset — pricing
reasoning, supplier reliability, customer history, the "why we do it
this way" — lives entirely in one person's head and retires or dies
with them. Nothing transferable exists to hand over, so the business
simply ends.

**What Office changes about that, if the capture has genuinely
happened over years, not just transactions but the reasoning behind
decisions:** the business stops being a single point of failure. The
knowledge survives the person. That reframes the product from
"software to run your business better" into something with real,
independent stakes of its own — the reason a business still exists
when its founder no longer can. A succession tool wearing a
day-to-day assistant's clothes.

**Where this actually belongs — not filed under one existing idea, but
the convergence of two already on record:** Principle 22 (Capabilities
Emerge From Captured Reality) explains the *mechanism* — Peter
describes reality once, in his own words, nothing re-entered. The
Institutional Knowledge document's **provenance** concept — already
named there as arguably its most durable, generally-useful idea —
explains the *payload*: remembering *why* the business changed, not
just *what*, is precisely the transferable asset a founder's
retirement would otherwise erase completely. This isn't a new
principle. It's the highest-stakes expression of two already earned.

**A real, verified correction to the competitive claim, worth stating
precisely rather than overreaching:** succession planning as a
category has real, existing players in South Africa — formal
consultants, structured assessment services, an established academic
literature independently confirming the exact diagnosis above (tacit,
person-locked knowledge with no natural transfer mechanism is a real,
well-documented failure mode, not invented here). "No competition"
is not quite accurate. What's genuinely uncontested is the
*mechanism*: every real competitor treats succession as a deliberate,
effortful process someone actively undertakes — assessments,
mentoring programs, structured transition plans. Nobody is offering
knowledge transfer as an incidental byproduct of simply running the
business through ordinary daily conversation. The sharper, more
defensible pitch: Office doesn't compete with succession consultants —
it makes formal succession planning unnecessary for the knowledge-
transfer problem specifically, because the knowledge was already
captured years before anyone needed to plan anything.

**Why this is a stronger pitch, not just a different one:** a moat no
funded competitor can buy (the value only becomes real with years of
accumulated history — impossible to shortcut with capital or
engineering speed), a genuine reason for patience rather than a
constraint on it, and a referral trigger with far more weight than
convenience — the kind of story that spreads at a retirement or a
handover, not at the tile counter.

**The discipline this demands — directly the same evidence-before-
claim standard Principle 28 already applies to architecture, now
applied to positioning:** don't sell this story yet. No Office has
survived a real transfer; the claim is unproven by definition until
one does. Build for "run my business" today, let a real succession
outcome actually happen, then tell the true story once it's real —
not before.

**A real, honest caveat worth pinning alongside the rest, not left
implicit:** this is a powerful *external* narrative — for referrals,
for founder conviction about long-term value — but Office itself
should never surface mortality-framing to Peter directly. The product
stays "software that runs your business better," full stop, from his
own daily vantage point. The succession story lives outside the
product, never inside a sentence Office actually says to him.

## Layer 2 (Project) — a real design pass with Claude Fable 5, verified rather than accepted (2026-07-20)

**A genuinely productive use of a one-time premium credit, and the
right way to spend a limited one — one focused pass, not spread thin.**
A separate Fable 5 session was briefed with the real Calypso Centre
evidence and pointed at the actual repo. The result was checked line by
line against the live schema before being trusted, the same discipline
applied to every claim in this project regardless of source.

**What held up, verified directly, worth keeping:**
- **The proximity-in-time rejection is correct, and it's the sharpest
  point in the whole design.** A tunable day-window as a matching
  signal is a guess wearing code's clothing, not a real deterministic
  one — the same standing discipline already proven everywhere else,
  correctly applied here rather than relaxed for convenience.
- **"`job_scopes` has no site column" — confirmed exactly** against the
  real, live schema (`id, customer_id, description, scheduled_date_raw,
  source_transcript, created_at, scheduled_date, installer_id`).
  "Same site" as a matching signal genuinely isn't implementable
  without a real schema addition first.
- **A real, embarrassing correction to this project's own Constitution
  citation, confirmed accurate:** Principle 24's real title is "Share
  What's Known, Don't Guess What's Meant," not "The Execution Ladder"
  — that's a separate, related document living in this file, not in
  `OFFICE_CONSTITUTION.md` at all. A real error in an earlier brief,
  caught by a fresh reader actually checking the source rather than
  trusting a paraphrase.
- **Reusing the existing rung-based resolution (Principle 24) for
  cross-capture project attachment** — a named handle matches directly;
  exactly one open candidate auto-attaches; two or more asks rather
  than guesses; zero leaves the scope standalone — is a sound,
  minimal-new-mechanism design, consistent with how every other
  ambiguous-match problem in this project has already been solved.

**What didn't hold up — the central, load-bearing claim, corrected with
real evidence rather than taken on faith:** "co-birth (same capture ∧
same customer) is a fact the receptacle recorded" was checked directly
and is not accurate. `captureId` genuinely exists and flows through the
processing pipeline as a real parameter — but it is only ever used to
update the `captures` table's own hint and text. It is never passed
into `recordWorkObservation`, and `job_scopes` has no `capture_id`
column at all. The infrastructure to capture this signal is real and
close — one parameter away — but the signal itself does not exist in
stored data today. "Already exists and is being ignored" was the wrong
framing; "doesn't exist yet, genuinely cheap to add" is the honest one.
A second, related claim in the same design — "quotations reach the
project through edges that already exist" — has the identical problem:
`quotations` has no `job_scope_id` column, confirmed directly against
the real INSERT statement. The connection to a job scope is looked up
once at creation time and never persisted; there is no existing edge to
traverse.

**What this means for the design's own "one table, one column"
footprint claim: understated, not wrong in spirit.** The real footprint
is closer to a `projects` table, `project_id` on `job_scopes`, *plus* a
new `capture_id` on `job_scopes` (to make same-breath detection
possible at all), *plus* either a real edge from quotations/invoices
back to their job scope, or an honest acceptance that those documents
only ever reach a project transitively and imprecisely, not directly.

**On contact-at-entity staying genuinely separate from Project:** the
design's case (different evidence, different structural problem) is
sound in its core logic, though one supporting detail was imprecise —
Alfons *was* named in direct connection with the Calypso site (as the
building's owner) in the same real test that motivated Project, so
"Calypso contains no named site contact" overstated the separation
slightly. Doesn't change the underlying conclusion — a person's
relationship to an organization and a job's relationship to other job
phases remain genuinely different kinds of gaps — but worth the
correction on record rather than repeating an overstated version of a
correct conclusion.

**Explicitly not for implementation now** — a real, sharpened design,
not a finished one. The next real step is deciding whether to actually
add `capture_id` to `job_scopes` and thread it through
`recordWorkObservation`, which would make same-breath project assembly
genuinely buildable rather than theoretically clean. Pinned so this
verified, corrected version — not the original, partially-inaccurate
one — is what survives.

## Layer 2 (Project) — same-breath assembly, proven working with real data (2026-07-22)

**The first real success of Layer 2**, built the same night as the
capture_id prerequisite that made it possible at all. A real, phased
job for one customer — "measured Thabo downstairs at forty square
meters for screed, remind me to order more screed, and Thabo upstairs
is twenty five square meters for carpet" — correctly split into three
segments (screed observation, an unrelated reminder, carpet
observation), and the two job scopes born from the same real message
were automatically, deterministically grouped into one real project.
No AI judgment involved in the grouping itself — a real, computed fact
(same capture, same customer) the receptacle already had.

**A real bug found and fixed on the way there, worth being honest
about its actual scope.** The first attempt at this test failed —
zero projects created — and Layer 2's own logic was correctly
suspected first, then correctly ruled out: both job scopes shared the
same real `capture_id`, confirming the grouping mechanism's own
precondition-check worked exactly as designed. The real failure was
upstream — the second job scope's customer reconciliation had silently
failed, because the model misclassified "Thabo upstairs is twenty five
square meters for carpet" as an installer assignment rather than a
customer measurement, confusing "is" as a linking verb (describing a
measurement) with "is" as an action verb (describing installer work).
Fixed with a precise rule and the exact real failing case as a
worked example — a real, honest, narrow fix for one phrasing, not a
general solution, exactly as named in the identity-collision pin
above.

**Worth stating plainly what this proves and what it doesn't.** This
confirms the same-breath assembly *mechanism* is sound — the
deterministic check, the project creation, the multi-row update, all
worked correctly on the first real, correctly-classified attempt.
It does not mean the upstream classification problem is solved in
general — the cross-role identity collision design pinned above this
entry is the real, scalable answer to that, still not built. Same-breath
assembly and cross-capture attachment (the harder half of Layer 2,
still deferred pending a real answer to "what makes a project open")
remain two separate pieces of work.

## Layer 2 (Project) — job_scope_id linking, and three real bugs found on the way to proving it (2026-07-22)

**The real feature**: quotations and invoices now carry a real
`job_scope_id`, captured at the one real point pricing actually
happens — closing the exact gap the Fable 5 design review correctly
identified in the original Layer 2 pin ("quotations reach the project
through edges that already exist" was checked and found false; those
edges never persisted anywhere). A project can now show a real,
computed `totalQuoted` and `totalInvoiced`, summed via a real join
through `job_scopes.project_id` — the actual point of grouping phases
together in the first place, not just a label on some measurements.

**Three real, distinct bugs found and fixed on the single test that
proved this** — worth recording honestly as three separate failures,
not one:

1. **Wrong job scope matched.** Pricing "Thabo's screed job" matched
   against the *carpet* job scope instead, because `findLatestJobScope`
   picked whichever was most recently created, ignoring what was
   actually named. Exposed only because Layer 2 now lets one customer
   genuinely have multiple job scopes — before, "most recent" rarely
   mattered.
2. **The fix for #1 didn't work on its first attempt, and the reason
   was real and worth naming.** Matching against real words from each
   candidate job scope's description/components/tasks seemed right,
   but the customer's own name ("Thabo") is present in every
   component name for that customer ("Thabo downstairs", "Thabo
   upstairs") — an artifact of how components get named, not a real
   distinguishing signal. It matched everything equally, so the most
   recent candidate kept winning regardless. Fixed by excluding the
   customer's own name from the matching words.
3. **A task's rate had nowhere to inherit a real area from.** Once
   matching correctly found the *right* job scope, pricing still came
   back wrong — R80 flat instead of R3,200. "Screed" is a task, not a
   component, and a task has no `area_sqm` of its own; only the
   component it's linked to does. `buildQuotationLineItems` only ever
   checked components directly, never followed a task's real link back
   to its component. Fixed by resolving a task-matched rate through its
   real, linked component — applied consistently across all three real
   call sites, not just the one the bug was found on.

**Verified completely, end to end, not just the final number**: the
real payload (`description: "screed"`, `quantity: 40`, `unit_price:
80`, `line_total: 3200`, `jobScopeId: 24`) confirmed correct before
confirming; the confirmed quotation correct; and — the real proof this
whole arc mattered — Project #1's own `totalQuoted` correctly showing
3200 immediately after, computed live through the real join, not
asserted.

**Worth naming plainly**: this is the same discipline as every other
real fix in this project, just under real, sustained pressure — the
first fix attempt for bug #1 was believed correct and deployed, then
proven wrong on retest; the second attempt for the same bug was also
believed correct, then proven wrong again by a *different* bug (#3)
hiding behind the first. Each retest was treated as the real test it
was, not a formality — the discipline held under three consecutive
failures on the same scenario, which is a harder thing to prove than
succeeding on the first try.

## Layer 2 (Project) — the third real piece: queryable in conversation (2026-07-22)

**The real feature**: a project's real, grouped phases and its real,
computed total quoted and invoiced value now surface in ordinary
conversation, gated behind `can_know_jobs` — the same precedent
already established for installer job activity, since a project is
fundamentally the same kind of job information, seen from the
customer's side. Closes the real gap between "correct in a debug
route" and "actually useful to Peter" — everything built earlier
tonight (same-breath assembly, job_scope_id linking) only had any real
value once it could actually answer a question asked the way Peter
would really ask it.

**Verified with a real, natural, unpolished question — not a
carefully-worded test case**: "hows Thabo job going" (no capital,
no punctuation, no "please tell me about") produced: *"Project 'carpet
installation': phases are screed installation and carpet installation;
total quoted so far R3200; total invoiced so far R0."* Both real
phases named correctly, the real R3,200 quoted figure correct
(matching the exact quotation confirmed earlier the same session), R0
invoiced correctly reflecting that nothing has been invoiced yet — not
a rounding coincidence, the actual, current truth.

**This closes the full arc of tonight's Layer 2 work — three real
pieces, each proven independently, now working together**: same-breath
assembly (job scopes group into a real project), job_scope_id linking
(quotations and invoices attach to the real phase they were priced
from, rolling up into real project totals), and conversational
visibility (the whole thing is actually askable, not just correct).
Cross-capture attachment and the broader identity-collision design
remain the two real, deliberately deferred pieces — both still pending
real answers to open questions, not rushed defaults.

## Job completion — a real, documented event, connecting three previously separate ideas (2026-07-22)

**What this replaces.** The earlier proposal for closing a project —
"Peter says it's done" — was too simple, and Pierre corrected it
directly: completion is a real, documented event, not a sentence. A
signed completion certificate, care/maintenance instructions for the
installed product, and warranty documentation are real artifacts worth
capturing for the jobs where they genuinely matter.

**A real, important self-correction, on the same thread, worth
recording precisely rather than folding in silently: the certificate
must never become a required gate.** Pierre caught this directly —
making a signed completion certificate a prerequisite for a job ever
being marked closed risks exactly the enterprise-completeness a
business never asked for, the same trap Principle 12 already exists to
guard against. **The actual, simpler, and arguably more honest
definition: a job is closed when it's paid in full and nobody's
complaining.** For the overwhelming majority of real jobs, that isn't
a proxy for completion — it *is* completion, in the only sense that
matters day to day. Skipping the formal paperwork must never block
this simpler, real signal from doing its job. The certificate,
warranty, and care documentation remain real and worth capturing —
as optional, additional documentation for jobs where it genuinely
matters (larger contracts, formal warranties), never as a gate.

**A real, practical consequence of this correction, worth naming
explicitly: it likely unblocks "what makes a project open" sooner than
the fuller completion design does.** "Paid in full, no open complaint"
is already computable directly from real, existing data — invoices and
payments already in the system — without needing to build a whole new
certificate-capture feature first. The richer completion design (the
artifacts, warranty, snags, the debtors-confidence connection) remains
real and worth building for the jobs that need it, but the *simple*
default this correction reveals may be sufficient, on its own, to
answer the question that started this whole thread.

**The real, valuable discovery this makes: three ideas that looked
separate were never actually separate.** Warranty tracking was already
named as a real gap earlier tonight ("a real, common promise a
flooring business makes... nothing captures this today") — but it
isn't a standalone feature. It's part of what completion means for the
jobs where it applies. Snag lists were also already named as a real
gap ("after an install, defects get found... real businesses track
these as their own thing") — and a real, honest question follows
immediately: can a job be signed
off while snags are still open? Project closing, warranty tracking,
and snag resolution are one coherent lifecycle stage, not three
disconnected ideas that each happened to get named on different
nights.

**How capture likely works, reusing what's already proven rather than
inventing something new**: the same photo/document upload path already
proven tonight for Supplier Invoice ingestion — a real photo of a
signed completion certificate, a photo of warranty documentation — is
the natural, consistent mechanism here too, not a new one.

**Question 2, resolved directly, not left open — but sharpened on a
second pass, since the first answer was too simple.** The real,
deterministic factor isn't "snag vs. no snag" — it's *when* an issue is
raised relative to the sign-off itself:

- **An issue noted *at* the moment of signing** is a real, direct hold
  on the outstanding balance — the customer signs the certificate but
  flags the problem right there, and withholds what's due until it's
  fixed. This is genuinely different from a formal retention
  arrangement (a pre-agreed percentage withheld on every job,
  regardless of any actual issue) — this is ad hoc, triggered by a
  real, noted problem at the exact moment of sign-off, tied to that
  one invoice.
- **A clean sign-off, balance already due, then a problem discovered
  later** — the money question is already settled by the time this
  happens, and stays settled. What follows is a purely separate
  classification decision: does this rise to a real warranty claim (the
  warranty terms actually cover it), or is it just a minor snag to fix
  quickly? Either way, it never reopens a balance already due.

The project's "closed" status itself is unaffected either way — the
certificate is signed either way, completion is real either way. The
real difference is only ever on the financial side: whether the
outstanding balance is genuinely held open by something noted at
signing, or already settled and untouched by whatever surfaces later.

**A real, valuable connection this reveals, worth building alongside
snags rather than as an afterthought: snags and retention are often the
same real mechanism, from two different angles.** A snag with a real
retention arrangement behind it (built and proven earlier tonight) is
naturally the real trigger for releasing that retained amount —
resolving the snag is what the withheld money was actually waiting for.
A snag with no retention behind it is just a standalone quality issue,
tracked and resolved quickly, with no financial mechanism attached at
all. Worth a real, explicit link from a snag record to the customer's
retention arrangement when one exists, rather than treating every snag
identically regardless of whether real money is sitting behind it.

**Real, open questions, deliberately not answered here:**
1. Is every one of these artifacts mandatory for completion, or is the
   certificate the one real requirement, with warranty and maintenance
   information optional depending on the job (a simple repair likely
   has no warranty to capture at all)?
2. ~~Does an open snag genuinely block completion~~ — resolved above:
   no, completion is unaffected either way. The real distinction is
   financial, not statutory — an issue noted at signing holds the
   balance; one discovered after a clean sign-off doesn't.
3. Does "project open" (needed to resolve cross-capture attachment,
   the reason this whole thread started) simply mean "no completion
   event recorded yet," or does it need finer states (in progress,
   snagging, awaiting sign-off)? Sharpened further by the bureaucracy
   correction above — the simplest real answer may just be "a real,
   outstanding balance exists on this project's invoices," computable
   right now from data already in the system, not waiting on any part
   of the fuller completion design to be built first.
4. Where does ongoing maintenance actually live once captured — a real
   recurring reminder (reusing the due-date mechanism already built for
   tasks), or just a stored fact Peter can ask about later?
5. What actually distinguishes a warranty claim from a minor snag, for
   an issue discovered after a clean sign-off? Both are quality issues
   found later, but one is real enough to invoke formal warranty terms
   and one is a quick fix — likely a real, human judgment Peter makes
   at the moment he notices it (not something to infer from the issue's
   own description), but worth a real, deliberate answer rather than an
   assumed default.

**A real, valuable connection to something already built tonight,
worth naming explicitly: completion status feeds directly into
collections confidence.** Right now, an outstanding invoice on the
Aged Debtors report is just a number owed, with no way to distinguish
a purely financial chase from a balance that might genuinely still be
in question over unfinished or disputed work. Once completion is real,
"closed" becomes a trustworthy signal specifically for this: a debtors
clerk (or Peter himself) looking at a closed job's outstanding balance
can act with real confidence — a signed certificate exists, the work
itself isn't in dispute, this is purely collections. A job *without*
that status is genuinely different — the balance might be legitimately
held up by an unresolved completion issue (the "issue noted at
signing" case above), not just a slow payer, and shouldn't be chased
the same way. Worth a real flag on the Aged Debtors report itself once
completion exists — not a new report, an enrichment of the one already
built and proven.

**Explicitly not built tonight** — this is now a real, three-part
design (completion, warranty, snags), each already substantial on its
own, correctly deserving proper specification before code, the same
discipline as every other design of this scale tonight.

## Layer 2 (Project) — cross-capture attachment, the fourth real piece, and the full original vision now proven (2026-07-22)

**The real feature**: a standalone job scope — no same-breath siblings,
born from a genuinely separate message — now auto-attaches to an
existing project when the customer has exactly one real, open one.
Built directly on the simple, honest answer to "what makes a project
open" from the bureaucracy-correction thread above: no invoice yet, or
a real invoice not fully covered by the customer's real payments,
reusing the exact FIFO logic already proven for Aged Debtors.

**Deliberately, honestly scoped to one rung, not the whole Ladder.**
The design's other two rungs — matching a stated project handle
directly, and asking when two or more open projects genuinely compete
— are left unbuilt on purpose. They need real design work this session
hasn't done (how would Peter actually name a project in conversation?
how does an ask-and-wait flow work mechanically, given nothing like it
exists yet in this codebase?), not a guessed-at implementation
standing in for a real answer. The one rung built tonight is the
cleanest and most valuable: most real customers will only ever have
one open job at a time, and this is the case that matters most,
proven correctly rather than assumed.

**Verified live, with a genuinely separate message, not a contrived
one**: a new job scope for Thabo, sent as its own real message minutes
after the original — a different `capture_id` entirely (184, versus
178) — correctly attached to the existing Project #1 alongside the
two job scopes already there from the original same-breath test.

**This closes the full, original Layer 2 vision — the same-breath and
cross-capture halves of Project assembly, both real, both proven,
working together.** What started as a design pinned weeks ago,
sharpened by a cross-model review, corrected multiple times on
verification, and built incrementally across one long night — same-
breath assembly, job_scope_id linking, conversational visibility, and
now cross-capture attachment — is now a genuinely complete, working
feature, not a partial one with an asterisk. The remaining, real gaps
(the two deferred Ladder rungs, the broader identity-collision design,
job completion, warranty, snags) are honestly named, not hidden, and
correctly left for their own turn.

## Layer 2 (Project) — connecting real scheduling data, a missing connection rather than a missing mechanism (2026-07-24)

**Pierre's real observation**: throughout the entire Layer 2 arc — same-
breath assembly, job_scope_id linking, conversational visibility,
cross-capture attachment — nothing had touched scheduling. "Fifteen
square meters, hallway, Thabo, next Friday" had no way to actually
register anywhere meaningful.

**Verified before building anything, rather than assumed either way**:
a real test ("measured Thabo hallway at fifteen square meters for
laminate, doing it next Friday") showed the extraction and storage
mechanism had been working correctly the entire time —
`scheduled_date_raw: "next Friday"`, `scheduled_date: "2026-07-31"`,
correctly resolved. Every Layer 2 test tonight had simply used plain
measurement phrases with no scheduling language, so this had never
been exercised. The real gap was never a missing capture mechanism —
it was a missing connection between data that already existed and the
Layer 2 features that should have been surfacing it.

**Closed additively, in two places**: `getCustomerProjectSummary` now
shows each phase's real scheduled date when one exists, so a real
question like "hows Thabo job going" can answer with real, useful
timing, not just financial totals. The scheduler ember (a real,
permanent production route, not a debug one) now also returns real
project context (`project_id`, `project_description`) alongside its
existing fields — added without changing the existing response shape,
so nothing that already consumes this route breaks.

**A real, live operational note, not a code issue**: the deploy for
this change hung on the "Deploy to Cloudflare Workers" step for
several minutes — every step before it succeeded cleanly — then
completed successfully on its own. A genuine, transient delay, not a
build problem; worth remembering if a future deploy seems stuck rather
than immediately assuming something broke.

## Job completion — the simple, financial half is now real and built (2026-07-24)

**The real feature**: every project now shows a real, computed status
— "open" or "closed (paid in full)" — following the bureaucracy
correction's actual, honest default rather than a formal certificate
requirement. Reuses the exact same, already-proven FIFO logic from
`getOpenProjectsForCustomer` (built for cross-capture attachment), not
a new, parallel computation of the same real fact.

**A real bug found and fixed on the way to proving it, worth recording
precisely**: `convertQuoteToInvoice` — the quote-to-invoice conversion
path — never carried forward the source quotation's real
`job_scope_id`, so a converted invoice silently dropped out of a
project's real totals even though the quotation itself was correctly
linked (`recordInvoice` and `recordQuotation` had both been fixed
earlier tonight; this third, real path was missed). Fixed by copying
the link forward deterministically, plus a real, safe, idempotent
backfill for any invoice already created via conversion before the
fix. This is the exact shape of gap the "map" pinned below exists to
catch earlier next time — a real concept (job_scope_id must be true of
every invoice) with more than one real creation path, and only two of
the three were checked on the first pass.

**Verified on both real sides, not just the happy path**: Thabo's
project correctly showed "open" while R2,400 remained genuinely
outstanding (R800 paid against a R3,200 invoice), and correctly
flipped to "closed (paid in full)" the moment the real, remaining
balance was actually paid — proven with real money moving through the
system, not asserted.

**Complaint-tracking remains real and deliberately unbuilt** — the
"no open complaint" half of the original definition has nothing to
check against yet, since snags don't exist as a system. This is
honestly a partial build of the full definition, not the whole thing —
the financial half, which is the one immediately useful and buildable
right now.

## Layer 2 — the ask-when-2-plus rung, a real structural bug found live, and a real architectural fix (2026-07-25)

**The real feature attempted first**: the second deferred Layer 2
Ladder rung — asking when two or more open projects genuinely compete
for a standalone job scope — reusing the exact hold-for-confirmation
mechanism just proven for Identity Collision. Built directly inside
`recordWorkObservation`, mirroring where same-breath assembly already
lived.

**A real, live bug found on the very first test, and a precise,
honest diagnosis of why it happened.** A customer with two genuinely
separate, already-existing open projects had a new, multi-segment
message sent — and instead of correctly asking which project the new
job belonged to, both segments silently merged into one of the
existing projects. The exact cause: `recordWorkObservation` only ever
sees one segment of a message at a time. The first segment of the new
message had no same-breath sibling yet — its own sibling, from the
same message, hadn't been created yet — so it fell through to
cross-capture attachment, found exactly one open project, and
attached. Its real sibling then arrived moments later, found the first
segment as a same-breath match with a project already assigned, and
joined it there too — silently merging two genuinely separate jobs
into one project that had nothing to do with either of them. The
earlier successful test (Thabo) had worked only by coincidence — he
had zero pre-existing open projects at the time, so the first
segment's cross-capture check correctly found nothing.

**The real, structural fix, not a patch.** Cross-capture attachment
was removed from `recordWorkObservation` entirely — it cannot be
decided correctly one segment at a time. A new function,
`resolveCrossCaptureAttachment`, holds the exact same logic (one open
project attaches, two or more asks, zero stays standalone) but is now
called only once, in `processTranscript`, after every real segment of
the whole message has been processed and same-breath assembly has
already had its full, complete chance to group whatever it's going to
group. Only job scopes still genuinely undecided (`project_id` null)
at that point get resolved.

**Verified completely, end to end, with a fresh customer and real
data**: two genuinely separate open projects created correctly (same-
breath assembly proven still intact), a third, standalone message
correctly triggering the real question — "This customer has 2 open
projects (laminate flooring installation, tile installation) — which
one is job scope #37?" — confirmed with a real, chosen project id, and
the final state checked directly: the chosen project correctly gained
the new job scope, the other project completely untouched.

## Snags — the smallest, most immediately useful piece of the job-completion/warranty/snags design, built and proven end to end (2026-07-25)

**The real feature**: raising and resolving a real quality issue
against a real customer's job, deliberately unguarded but traceable —
matching GRN's own precedent exactly, since this is a quality note,
never money moving directly. Built first, per the original design's
own sequencing guidance ("snag lists — smallest, most immediately
useful"), ahead of warranty tracking and the harder open questions
still left pinned.

**The real, valuable connection to retention, surfaced honestly as
information only, never as an automatic financial write.** Resolving
a snag checks whether it was genuinely the last open one for that
customer, and whether a real retention arrangement exists — if both
are true, Peter is told directly that a real amount may now be
releasable, so he can decide to release it himself, the same
deliberate action every other financial write in this project already
requires.

**Verified live, and a real, honest distinction found along the way
that could easily have been mistaken for a bug.** The first resolution
test showed "a real retention of R0 may now be releasable" — which
looked wrong at first, but was actually correct: `retention_amount` is
computed and stored on each invoice at the moment it's created,
reflecting what was genuinely withheld then, not recalculated
retroactively. Jenny's existing invoices were created hours before her
retention arrangement was set up in this same test, so they correctly
show R0 — nothing was ever withheld on them. Confirmed by creating a
fresh invoice after setting her real 10% retention (correctly showing
`retentionAmount: 200`), then raising and resolving a third snag —
this time correctly showing "a real retention of R200 may now be
releasable," proving the connection works exactly as designed once a
real retention arrangement genuinely existed at invoice time.

**Deliberately, honestly scoped** — warranty tracking, the "when is an
issue noted relative to sign-off" financial distinction, and the
remaining open design questions (mandatory vs. optional artifacts,
maintenance reminders, warranty-vs-snag classification) remain exactly
where the original pin left them: real, named, and correctly
sequenced for later.

## The lead/enquiry stage — built and proven end to end, both real lifecycle paths (2026-07-25)

**The real feature**: raising a real, new enquiry — name, interest,
source — deliberately unguarded but traceable. Converts into a real
customer and quotation once priced, exactly as originally pinned, by
hooking directly into the already-proven `recordQuotation` and
`convertQuoteToInvoice` paths rather than inventing a separate
mechanism — the real point of the whole design.

**A real, careful exclusion, worth recording precisely.** Raising or
losing a lead deliberately never touches `reconcileCustomer` or the
identity-collision check at all — the name stays purely in the real
`leads` table until genuinely quoted. Getting this right mattered:
without it, every new enquiry would have silently created a real
customer record on day one, the exact duplication this whole design
exists to prevent.

**Verified live across both real lifecycle paths, with a genuine,
unplanned collision along the way that proved two features working
together correctly.** Sipho's enquiry raised cleanly (`customer: null`,
confirming the exclusion held). Quoting him then correctly triggered
Identity Collision — he turned out to already be a known installer
character from earlier tonight — confirmed as a real, new customer,
and the lead automatically transitioned to `status: "quoted",
customer_id: 23`. Converting that quote to an invoice then correctly
transitioned it to `status: "won"`. A second, separate lead (Themba)
was raised and explicitly marked lost, correctly left with
`customer_id: null` since he was never quoted — the real, honest
distinction between "never converted" and "converted then lost"
that the status field exists to capture.

## Job scope amendment detection, built and confirmed working end-to-end

**The real, honest starting point:** `recordWorkObservation` always created a new job scope unconditionally — no check anywhere for whether a message describing a schedule or installer change was actually about a job that already existed for that same customer. Confirmed live: "Steven asked if we can start after 12 on Friday..." created job scope 50, separate from job scope 49, both for the same real customer and the same real Friday.

**The real design, logic'd out before building anything:** reuse `findLatestJobScope` exactly as-is for recall — the same real, deterministic transcript-matching already proven for pricing since 2026-07-22 — rather than inventing a new matching mechanism. Trigger narrowed deliberately to the real evidence: only considered when the new message has no components or tasks of its own, since a genuinely new job almost always comes with real measurements attached, while a pure logistics change doesn't. A new `job_scope_amendments` table holds one real, permanent row per field that actually changes (`job_scope_id`, `capture_id`, `field_name`, `old_value`, `new_value`), written before `job_scopes` itself is touched, so `job_scopes` stays simple "current truth" while the full real history lives permanently in the audit log. Held for confirmation exactly like every other consequential write — CONFIRM applies the update, REJECT creates a genuinely new, separate job scope via the same path that would have run anyway.

**The real gap found immediately after building it:** the first attempt only patched one of three real places in `index.ts` that could create a job scope from a pure-logistics observation. Confirmed live: "Richards Hotel job, let's schedule that for next Wednesday" created a fourth new job scope (54) instead of holding, because it landed in a different branch — the one that relies on the current selection rather than restating an explicit customer name — which the first patch never touched. Fixed properly: moved the check into one real, shared function (`checkForJobScopeAmendment`, in `finance.ts`, colocated with `findLatestJobScope` and `holdForConfirmation`), called from both real sites that can produce a pure-logistics observation, rather than patched into one call site at a time.

**Confirmed working end-to-end, on a clean customer, not just at the hold:** "Bond Empangeni job, let's schedule that for next Tuesday" correctly held, referencing job scope 48 by name and description. Confirmed: `job_scope_amendments` now shows a real row — `old_value: null`, `new_value: "next Tuesday"` — and job scope 48 itself shows `scheduled_date_raw: "next Tuesday"`, correctly resolved to a real calendar date, installer untouched since it wasn't part of the message. No new job scope was created.

**Real, known leftover from testing, deliberately not touched without confirmation first:** job scope 54 (Richards Hotel) is itself a leftover mistake from testing the bug this fix addresses — created before the fix deployed, then matched against itself on a contaminated second attempt (`old_value` and `new_value` identical). Left in place pending a direct decision on deleting it, not merged or silently cleaned up.

**Also real and still open, unrelated to this fix:** "Steven" (213) and "Stevens" (214) are almost certainly the same real customer, split across two records from the same testing session — job scopes 51 and 53 sit under the wrong one. Noted, not yet acted on.

---

## Snags, Leads, and Projects — the first full discoverability-plus-audit pass, confirmed working

**The real premise, applied for real this time:** each of these three had been a genuinely working backend feature for months — real schemas, real deterministic logic, in Snags' case a real tie to retention release, in Projects' case a real computed total quoted/invoiced — with zero discoverable surface anywhere in the app. Voice-only, or reachable only via a raw `/debug/*` call.

**Built the same real way for all three:** a real, non-debug endpoint (or two, where a real action exists), reusing the exact same functions the voice intents already call rather than duplicating logic, plus a real drawer entry and room following the exact established `_PeopleRoomContent` pattern — ember-born opening, real fetch/loading/error states.
- **Snags:** `GET /snags`, `POST /snags/:id/resolve` (reuses `resolveSnag` directly). Real tap-to-resolve, open items first.
- **Leads:** `GET /leads`, `POST /leads/:id/mark-lost` (reuses `markLeadLost` directly). No "mark won" action built — a lead becomes a real customer automatically through the existing quotation/invoice machinery, not through anything this room does.
- **Projects:** `GET /projects`, deliberately read-only — there is no real "resolve" or "complete" action for a project anywhere in the backend, so none was invented client-side either. Shows each project's real customer, description, linked job scopes, and computed total quoted/invoiced.

**Confirmed working, real device test, all three at once, after one real rebuild:** described directly as "genuinely rich."

---

## Decision 50: the same work said again makes no new job

Decided by Pierre (the opposite of my recommendation, which was to ask): **link quietly.** Seen on the phone: saying "invoice AGS Lewende Waters R3000 for carpet repair" three times made jobs #73, #74 and #75 for one repair, and a fourth (#76) on the next test.

**What the code showed.** The held invoice carries **no link to a job at all** (just the customer, the amount and the words), so the duplicates came from the **job part** of the sentence, which always recorded a new job.

**What it does now.** When the work in an invoice sentence is **the same work as a job the customer already has open, no new job is created**, and the reply says which: "Invoice noted for Jenny Smith of R3000 — needs your confirmation (action #1) before it's recorded. This is the same work as job #1 ("carpet repair"), so no new job was created." Three precise rules keep it from over-reaching:
- **Same work** means the same words in any order, ignoring case, punctuation and small words ("the", "of", "for"...): "repair of the carpet" matches "carpet repair"; "carpet repairs" or "curtain fitting" do not (no guessing at plurals or meaning).
- **Open** uses the system's own meaning of an open project: a job whose project is **paid in full is closed** and is not matched (a repair a year later makes a new job). A job not in any project is open. The most recent match wins; another customer's jobs are never considered.
- **Tasks only, never measurements.** A sentence with measurements is new detail and still makes a job: silently dropping a re-measure would be worse than a duplicate.

**A date or installer in the same sentence is not applied quietly.** "Invoice Jenny R3000 for carpet repair, install on the 17th" for a customer with that job now asks the usual question ("Job #1 ("carpet repair") — update it, or create this as a separate new job?") with the invoice waiting, and creates no new job. So the one thing that could be changed behind your back (a date) still asks.

**The property that matters.** Against `main`, **no existing recording changed or was removed**; 7 were added (the same work; the same work in other words; different work; the same words with measurements; the same work with a date; a closed job; and no amount), plus 9 unit tests against a real database (the matching, the closed project, another customer, measurements, placeholders).

**Verified:** typecheck unchanged; **4,449 checks**. **Four deliberate breakages were caught:** the same work making a new job again (the original problem); a sentence with measurements matched to an old job; a job in a paid-in-full project matched as open; and a date applied by recording a job instead of asking about the existing one.

**Not changed, and stated plainly:** the invoice itself is still not linked to a job (it never was); only the duplicate is removed. If you want an invoice tied to its job, that is a separate change. Existing duplicates (#73 to #76) are not merged. And the language model's reading of the sentence's work description is unverified on the real model: the matching depends on it producing the same words twice, which a plainly worded repeat should; a differently worded repeat will make a new job.


---

## Rewrite Phase 3, step 5: snags and leads leave processOneExtraction

**The third intent group out of the big function:** raising a snag against a customer's job, resolving one (and saying whether retention can now be released), raising a lead and marking a lead lost now live in **`worker/src/intents/snags-leads.ts`** (one handler, `handleSnagsAndLeads`). `processOneExtraction` fell from 1,954 to **1,843 lines** and `index.ts` from 5,575 to **5,465**.

**Checked before it moved.** Eight result variables, **none referenced anywhere else in the function**; the four intents read only the sentence, the customer and the capture, and write nothing back to the caller but the reply. The action code was one contiguous block with nothing else in it. **The one lead-specific line in the function's opening step stays where it is** (a lead's name must not be matched as a customer; it is about identity, not about recording a lead), and a new guard keeps it there. Any sentence of these four intents that produced no reply before still falls through to the same later branches: the handler returns nothing and the chain continues exactly as it did.

**The property that matters.** **No recording changed, was removed or was added: all 751 are untouched,** and no existing guard failed. **Twenty-six new checks** guard it: `index.ts` calls the handler exactly once and uses its reply as the message; the big function may not contain its own copy of the snag and lead logic; the module must do each of the six things; the opening step's lead line must stay; and only `index.ts` may import it.

**A guard of mine was wrong, and the way it was wrong is worth recording.** The first version of the "no private copy" guard searched the whole of `index.ts` and flagged two uses of `resolveSnag` and `markLeadLost`. Those are the plain REST routes (resolve a snag, mark a lead lost directly): separate code that legitimately uses the same functions, not copies. Rather than loosen the guard everywhere, it was **narrowed to the big function**, which is what it exists to protect, and it still fails if a copy grows back there (proved below).

**Verified:** typecheck unchanged; **4,665 checks**. **Four deliberate breakages were caught:** the snag and lead replies no longer used; a raised snag no longer recorded; a rule inside the moved code removed (a single open lead no longer matched when the name is unclear: caught by the recorded case); and a private copy of the lead logic grown back in the big function. Eight imports `index.ts` no longer needed were removed.

**Where it stands after five Phase 3 steps:** the duplicated upload logic is gone (steps 1 and 1b), the find-only rule is one table (step 3), and three intent groups are out of the big function (order management, stock, snags and leads). `processOneExtraction` is **1,843 lines**, from 2,235 at the start of Phase 3 and 1,756 at the Phase 1 measurement; `index.ts` is **5,465**, from 6,297. **Every step has passed with all 751 recordings untouched.**


---
