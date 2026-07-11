# The Office Constitution

This is not a build log. `STATUS.md` is the build log — it changes
every session, and it should. This document is different on purpose:
it holds the principles that shouldn't change even when the
implementation does, ten times over.

**How to use this document:** when you're tempted to let the AI "just
guess," don't ask "can we?" Ask "does this violate a principle below?"
If the answer is yes, the temptation is wrong, regardless of how
convenient it would be in the moment.

**How this document grows:** organized chronologically by research
entry — not by product, not by technology — because what matters is
what Office *learned*, in the order it learned it. Every entry studies
one real system and asks the same five questions:

1. What problem were they solving?
2. How did they solve it?
3. Does Office have this problem?
4. What principle survives if we throw their implementation away?
5. *(implicit in every answer)* — bucket the finding honestly:

- **✅ Adopted** — validated, Office has this problem, the principle is real and in use (or about to be)
- **❌ Rejected** — Office doesn't have this problem; the idea is left behind on purpose, not forgotten
- **⏸ Deferred** — real principle, but Office is missing a prerequisite before it's actionable
- **❓ Unknown** — needs more research or more real evidence before it can be judged either way

A principle earns a number the first time it's stated. Numbers never
get reused or renumbered, even if a later entry deepens or partially
supersedes an earlier one — the history of *why* Office believes
something is as important as the belief itself.

---

## Genesis — principles discovered building Office itself (2026-07-11)

These weren't borrowed from anywhere. They were forced into existence
by real bugs, in the same session, before any deliberate research
began — which is its own kind of evidence: a principle earned by
necessity, not proposed in the abstract.

### Principle 1 — Deterministic Before AI

> If the worker can answer, the AI must never guess.

**Origin:** `resolveTaskCompletion` was originally built as an AI
call — hand the model a list of open tasks, ask it to judge which one
a vague completion phrase meant. It worked in testing, then real
conversation surfaced the actual failure mode: with two genuinely
similar open tasks and no disambiguating language, the design was
asking the AI to make exactly the kind of judgment call a system of
record should refuse to make. Rebuilt as pure deterministic word-token
matching — zero AI calls in the matching step, verified directly in
Node before ever touching production.

**Reason:** Accounting software doesn't guess which invoice you meant.
Banks don't guess which account you meant. A system that guesses,
even well, is a chatbot with good instincts. A system that resolves
deterministically and only asks when it genuinely can't is a system of
record. Those are different products, and Office is trying to be the
second one.

**Status:** ✅ Adopted. Proven in production — the execution ladder
(register → exact ID → exact name → alias → deterministic candidate
count → ask Peter) has no "AI guess" rung, and none should ever be
added.

### Principle 2 — AI Is a Translator

> Human ⇄ Office. Not a decision maker. Not business logic.

**Origin:** The same conversation that produced Principle 1, pushed
one step further — even the *phrasing* of a clarification question
("did you mean X or Y?") must never be handed the decision of which
candidates to include, only the job of saying it naturally. The AI's
entire footprint in the resolution pipeline is exactly two seats:
extract what Peter said into structured intent, narrate what the
worker did back into plain language. Matching, resolving, deciding —
none of that is a third seat with a friendlier name.

**Reason:** This is what keeps the model swappable. Kimi today, Opus
or GPT-5 next year for some specialist task — none of it should matter
to Office's correctness, because the AI was never the one holding
business logic in the first place. The worker owns the business. The
AI only ever translates between Peter's words and the worker's
structured world, in both directions.

**Status:** ✅ Adopted. Every extraction function in the codebase
(`extractIntent`, `resolveFollowUpEntity`, `classifyBusinessTopic`,
`extractScopePricing`) already follows this — none of them ever
decide, they only ever identify or narrate.

---

## Research 001 — Gmail (2026-07-11)

Chosen deliberately over Linux as the first real study, on the theory
that Gmail is already an execution workspace, not a filing cabinet —
closer to what Office is trying to be than an operating system kernel
is.

### Principle 3 — Nothing Is Lost

**Borrowed from:** Gmail's Archive/Delete split. Archiving never
deletes — it removes exactly one label (`Inbox`) while the message
stays permanently, fully searchable in `All Mail`. Delete is a
separate, deliberate, cold action with its own 30-day grace period
before anything is actually gone.

1. *Problem:* users were afraid of losing correspondence, so the
   system needed a zero-risk "get this out of my way" action.
2. *How solved:* archiving is non-destructive by construction — it's
   a label removal, not a deletion.
3. *Does Office have this problem?* Yes — and Office had already,
   independently, arrived at the same answer before this research
   happened. `tasks.done` doesn't delete a row, it flips a flag.
   `pending_actions.status` never deletes a record either.
4. *What survives if we throw away the implementation?* **User
   actions never permanently destroy business information.**

**Status:** ✅ Adopted, and retroactively confirmed rather than newly
discovered — Office was already compliant. Formalized as a standing
rule going forward: nothing in Office is ever hard-deleted by a normal
user action. Only the debug/admin cleanup routes delete anything at
all, and those exist specifically to correct real data-entry errors,
not for everyday use.

### Principle 4 — Search Before Browse

**Borrowed from:** Gmail's founding bet that search beats foldering at
scale — cited, alongside labels, as one of the two things that made
Gmail's model different from every email client before it.

1. *Problem:* as volume grows, browsing a folder tree to find one
   thing becomes slower than just asking for it directly.
2. *How solved:* search became the primary retrieval mechanism;
   foldering (labels) became a secondary, optional organizing layer.
3. *Does Office have this problem?* Yes, and Office made the identical
   bet independently. Peter never browses a customer list to find
   Jenny's balance — he asks, and `answerFromMemory` retrieves it
   directly.
4. *What survives?* **Retrieval should begin from intent, not
   navigation.**

**Status:** ✅ Adopted — already true, confirmed by research rather
than introduced by it. Worth keeping as an explicit guardrail against
ever adding browsing-first UI (a customer list as a default view,
a folder tree of tasks) as a shortcut later.

### Principle 5 — Multi-Membership Over Single Parent

**Borrowed from:** Gmail Labels vs. folders. An email can carry many
labels at once; it was never forced into exactly one location the way
a traditional folder-based client requires.

1. *Problem:* real messages don't have one true category — an email
   is often simultaneously "Invoice," "Urgent," and "from Jenny."
2. *How solved:* labels are a many-to-many tag system, not a
   single-parent hierarchy.
3. *Does Office have this problem?* Partially, and it's real: a task
   could genuinely belong to a project AND a customer AND be personal,
   simultaneously, the moment "projects" (or departments) become real.
   Today's schema uses a single `customer_id` foreign key pattern
   everywhere, which can't express that.
4. *What survives?* **A business object should be findable by every
   real thing it relates to, not filed under just one of them.**

**Status:** ⏸ Deferred — missing prerequisite. Nothing built yet
(tasks, notes) has actually needed multi-membership; the single-parent
pattern has been sufficient for everything real so far. Worth
revisiting the moment "projects" or departments become real business
objects, not before — building tagging ahead of that need would be
exactly the unearned complexity this whole project has avoided
everywhere else.

### Principle 6 — Threading Needs a Hard Key

**Borrowed from:** Gmail conversation threading — messages
self-assemble into a thread from real, unambiguous header data
(`Message-ID`, `In-Reply-To`), never from a human manually linking
them, and never from an inferred guess about relatedness.

1. *Problem:* related messages arrive scattered in time; users
   shouldn't have to manually reassemble the conversation.
2. *How solved:* a hard, structural linking key that already exists in
   every message's metadata.
3. *Does Office have this problem?* Unclear. This is close to the
   already-pinned "relational memory / events with multiple
   participants" idea (a late-delivery event findable from both the
   supplier's side and the customer's side) — but Gmail's threading
   only works *because* the hard key already exists. Office has no
   equivalent unambiguous key between, say, a ProSupply note and the
   Jenny job it happens to mention.
4. *What survives?* **Group related records by a real, structural key
   — never by inferring relatedness.**

**Status:** ❓ Unknown / ⏸ Deferred — genuinely double-flagged.
Adopting the *shape* of threading without a real hard key would mean
silently guessing which records belong together, which is precisely
what Principle 1 rules out. Not rejected — the underlying need may be
real (see the already-pinned events/participants idea) — but not
actionable until there's a real, structural way to establish the link
deterministically, the same way `line_items`' CHECK constraint
deterministically links to exactly one of `quotation_id`/`invoice_id`.

### Principle 7 — Suppression Is Not Completion

**Borrowed from:** Gmail's Mute — a deliberately distinct, stronger
state from ordinary Archive. Archive means "get out of my way, but
come back if something changes." Mute means "never resurface this,
even if something does."

1. *Problem:* some ongoing things (noisy group threads) need permanent
   suppression, which is a different need from "this one instance is
   handled."
2. *How solved:* two separate states, not one collapsed into the
   other.
3. *Does Office have this problem?* Not yet demonstrated, but plausible
   the moment tasks get heavier real use — "this is done" (task
   complete) and "stop reminding me about this at all, ever" are
   different things, and today only the first exists.
4. *What survives?* **"Handled" and "never again" are different states
   and shouldn't be collapsed into one.**

**Status:** ⏸ Deferred — no real evidence yet that Peter needs this
distinction; noted so it isn't rediscovered as a surprise later.

### Rejected — Keyboard-Shortcut-Driven Navigation

**Borrowed from:** Gmail's dense keyboard shortcut system (`e` to
archive, `#` to delete, `j`/`k` to move through a list) for fast triage
of a long visual list.

1. *Problem:* fast navigation through a dense list of many items.
2. *How solved:* single-key shortcuts bound to list position.
3. *Does Office have this problem?* **No.** Office's entire design
   thesis is the opposite of a dense list — one response area, no
   scrollback as the default view, voice as the primary input. There
   is no list to shortcut through.
4. *What survives?* Nothing — the principle underneath (fast triage of
   many items) doesn't apply because Office deliberately has no "many
   items" surface to triage.

**Status:** ❌ Rejected. Left behind on purpose, not overlooked.

---

## Research 002 — Operating Systems (2026-07-11)

Originally planned as the first study; done second because Gmail
turned out to be the more useful starting shape. Studied properly now
rather than skipped.

### Principle 8 — Decide and Execute Are Separate Roles

**Borrowed from:** the OS scheduler/dispatcher split. The short-term
scheduler *decides* which process runs next; the dispatcher is a
distinct mechanism that actually performs the context switch and hands
over control. They are never the same piece of code.

1. *Problem:* deciding what should happen next and actually making it
   happen are different kinds of work, and conflating them makes
   both harder to reason about and test independently.
2. *How solved:* two named, separate roles, always.
3. *Does Office have this problem?* Yes, and — same pattern as several
   Gmail findings — Office already does this correctly without having
   named it: `extractIntent` decides *what* is happening; the
   dispatch chain in `processTranscript` executes it. They've never
   been the same function.
4. *What survives?* **Decide what should happen, and how it gets
   executed, in two separate places — never conflate classification
   with action.**

**Status:** ✅ Adopted — confirmed, already true in practice; worth
keeping deliberate as new intents get added, so the temptation to let
an extraction function also "just handle" its own side effect is
recognized and refused.

### Principle 9 — Queues Decouple Producer From Consumer

**Borrowed from:** OS message queues and event loops — a producer
places work on a queue and moves on; a consumer drains it whenever
it's ready. Neither blocks waiting on the other.

1. *Problem:* two pieces of work happening at different speeds
   shouldn't force the faster one to wait for the slower one.
2. *How solved:* an intermediate queue, decoupling timing entirely.
3. *Does Office have this problem?* Yes, and again — already solved,
   independently, before this research happened. `pending_memory_flush`
   is a real message queue: KV writes happen immediately and don't
   wait on Vectorize's slower consolidation step, which drains the
   queue on its own schedule.
4. *What survives?* **When two steps run at different speeds, decouple
   them with a real queue rather than forcing the fast one to wait.**

**Status:** ✅ Adopted — confirmed, already built correctly.

---

## Research 003 — CRM / Salesforce (2026-07-11)

### Principle 10 — Loose vs. Owned Relationships Are Different Things

**Borrowed from:** Salesforce's Lookup vs. Master-Detail relationship
types. A Lookup is a loose association — related records exist
independently of each other. Master-Detail is ownership — the child
has no independent existence and is deleted along with its parent.

1. *Problem:* not every relationship between two records means the
   same thing; some are "these happen to be connected," others are
   "this literally cannot exist without that."
2. *How solved:* two distinct relationship types, chosen deliberately
   per case, not a single generic foreign key for everything.
3. *Does Office have this problem?* Yes, and — same pattern a third
   time — already solved correctly. `customers`/`characters` are
   Lookup-style: structurally separate, no ownership either way (the
   entire safety property behind that separation, see `STATUS.md`).
   `line_items` are Master-Detail-style: they have no independent
   existence, own no identity without their parent quotation or
   invoice, enforced by a real CHECK constraint.
4. *What survives?* **Name the difference between "these are related"
   and "this belongs to that" explicitly in the schema — don't let one
   generic foreign key pattern quietly stand in for both.**

**Status:** ✅ Adopted — confirmed, already correctly distinguished.

### Principle 11 — Business Objects Convert Along a Funnel

**Borrowed from:** Salesforce's Lead → Account/Contact/Opportunity
conversion — an unqualified prospect becomes real business objects
once qualified, a one-way progression through real stages.

1. *Problem:* a business relationship starts uncertain and becomes
   more concrete over time; the data shape needs to reflect that
   instead of forcing full structure from the first moment.
2. *How solved:* a real, named conversion step between lifecycle
   stages, not one flat object trying to represent every stage at
   once.
3. *Does Office have this problem?* Yes — and this is the clearest
   parallel found in any research entry to something Office built
   deliberately, in stages, over real sessions: `work_observation` →
   `price_scope` → `quotation`/`invoice` is exactly this funnel.
   Job scopes measure something uncertain; `price_scope` converts it
   into a real priced document only once real prices are known;
   `convert_quote` converts a quotation into an invoice only once work
   is actually done and a deposit is paid.
4. *What survives?* **Model the business relationship's real
   uncertainty over time — don't force final structure onto an early,
   unconfirmed stage.**

**Status:** ✅ Adopted — confirmed; this is effectively a description
of `job_scopes`' entire design, arrived at independently.

### Principle 12 — Standard Shapes First, Custom Only When Forced

**Borrowed from:** Salesforce's own best-practice guidance — use
standard objects (Account, Contact, Opportunity) before ever building
a custom object; only diverge when the standard shape genuinely
doesn't fit.

1. *Problem:* premature custom structure creates maintenance burden
   and fragments what should be one coherent model.
2. *How solved:* a strict default toward reuse, custom objects treated
   as the exception requiring justification, not the default.
3. *Does Office have this problem?* Yes, and it's the same discipline
   as "build only what's earned" that's governed every decision in
   this project already — most visibly in the three separate,
   documented rejections of a polymorphic `people` table.
4. *What survives?* **Reach for what already exists before building
   something new; require a real, demonstrated gap before adding
   structure.**

**Status:** ✅ Adopted — confirmed; this is a restatement of a
principle Office already lived by, not a new one.

---

## Research 004 — Search (SQLite FTS5) (2026-07-11)

Studied instead of Elasticsearch — same underlying ideas, and directly
relevant since `line_items`/`tasks` already live in the exact SQLite
database Office runs on.

### Principle 13 — Matching and "Did You Mean" Are Different Layers

**Borrowed from:** FTS5's own documentation, stated almost verbatim —
*"FTS5 is not a typo-tolerant engine. It does prefix matching, not
fuzzy matching. If you need 'did you mean...' behavior, that's a layer
above FTS5."*

1. *Problem:* exact, deterministic matching and forgiving,
   judgment-based suggestion are fundamentally different jobs, and a
   real search engine refuses to conflate them.
2. *How solved:* the matching engine stays strictly literal; anything
   fuzzier is explicitly a separate, higher layer, built on top, never
   folded in.
3. *Does Office have this problem?* Yes — this is, almost word for
   word, the same conclusion the Execution Ladder work reached
   independently, before this research happened: matching is
   deterministic (`resolveTaskCompletion`); "did you mean X or Y" is a
   distinct, later step that only ever presents what the deterministic
   layer already found.
4. *What survives?* **Keep exact matching and forgiving suggestion in
   two separate layers, always — never let a matching engine start
   guessing on its own authority.**

**Status:** ✅ Adopted — direct, independent confirmation of Genesis
Principle 1, from an authoritative real system, found *after* Office
had already arrived at the same design under pressure.

### Principle 14 — Stemming Is Indexing, Not Reasoning

**Borrowed from:** FTS5's Porter tokenizer — "connect" is made to
match "connecting" and "connected" through a fixed, deterministic
suffix-stripping algorithm applied at index time, not through a model
judging that the words are related.

1. *Problem:* naive exact-string matching misses obviously related
   word forms ("call" vs. "called").
2. *How solved:* a small, fixed, rule-based transformation applied
   uniformly — same input always produces the same output.
3. *Does Office have this problem?* Yes, and it was solved the same
   way, independently, the same day: `resolveTaskCompletion`'s crude
   suffix-stripping `stem()` function is a hand-rolled Porter-style
   tokenizer, built to fix the exact bug this principle describes
   ("called them" failing to match "call Sarah...").
4. *What survives?* **Word-form normalization belongs in deterministic
   code, applied uniformly — it is indexing, not a judgment call, even
   though it looks a little like "understanding" language.**

**Status:** ✅ Adopted — confirmed; independently reinvented, now
named properly.

### Principle 15 — Synonyms Are Data, Not Judgment

**Borrowed from:** FTS5's synonym tokenizer — "dog" can be made to
also match "canine" or "k9," but only because that mapping was
supplied as data to the tokenizer, never because the engine reasoned
its way to the connection at query time.

1. *Problem:* some words mean the same thing without sharing any
   letters, which pure stemming can never catch.
2. *How solved:* a stored, explicit mapping, consulted at index or
   query time — still just a lookup table, not reasoning.
3. *Does Office have this problem?* Plausibly, later — this is exactly
   the already-pinned "business aliases" idea (rung 4 of the Execution
   Ladder): "the tile guy" → a real supplier, stored from a past
   clarification. Real evidence this session showed Peter's actual
   phrasing tends to already be specific, so this remains genuinely
   not yet earned.
4. *What survives?* **A synonym mapping is a stored fact to look up,
   never a similarity judgment made fresh each time.**

**Status:** ⏸ Deferred — same status as before this research, now
with stronger independent grounding for *how* to build it correctly
whenever it's earned: a literal lookup table, not an AI call.

---

## Research 005 — Git (2026-07-11)

### Principle 16 — Immutable History, Mutable Pointers

**Borrowed from:** Git's object model — blobs, trees, and commits are
permanent and content-addressed, never edited once created; branches
and `HEAD` are the only mutable things, and they're just names
pointing at a spot in that immutable history.

1. *Problem:* a system needs to both remember everything that
   happened, permanently, and represent "the current state" as
   something that can change — without letting the second need corrupt
   the first.
2. *How solved:* strict separation — the record of what happened is
   permanent; only a small set of pointers to that record are allowed
   to move.
3. *Does Office have this problem?* Yes, and it's mostly already
   solved, with one real gap worth naming honestly. `captures` is
   genuinely Git-like: logged raw and unconditionally, never edited.
   Every guarded record (`pending_actions`) carries its immutable
   `source_transcript` forever, even as `status` — the mutable
   pointer — moves from pending to confirmed. But the status column
   itself is a real `UPDATE`, with no separate, permanent record of
   *when* or *why* it moved, the way a Git ref-log records every place
   `HEAD` has ever pointed.
4. *What survives?* **The event that caused a change should be
   permanent; only a small, explicit pointer to "current state" should
   ever be allowed to move — and even that pointer's history is worth
   keeping.**

**Status:** ✅ Adopted for the core pattern (confirmed, already
mostly true) / ⏸ Deferred for the ref-log idea specifically — no real
gap has yet demonstrated Office needs a history of *when* a
pending_action's status changed, beyond the single `resolved_at`
timestamp it already has. Worth revisiting if an audit-trail need ever
surfaces for real.

---

## Research 006 — ERP / SAP (2026-07-11)

### Principle 17 — One Chain, One Source of Truth Per Stage

**Borrowed from:** ERP's document flow model (quote → sales order →
delivery → invoice → payment) — each stage is a real, distinct
document, linked to the one before it, and no stage is allowed to
silently duplicate or override what a prior stage already established.

1. *Problem:* a business transaction moves through real stages over
   time, and letting any one system re-derive or contradict an earlier
   stage's numbers creates exactly the kind of drift a system of
   record can't tolerate.
2. *How solved:* each stage owns its own real document, referencing
   the previous stage by ID, never recalculating what it already
   settled.
3. *Does Office have this problem?* Yes — already solved, the same
   pattern as Principle 11 from a different angle. `quotations` →
   `invoices` via `quotation_id`, with `line_items` computed once, in
   code, and never re-derived by the model at any later stage.
4. *What survives?* **Once a number is settled at one stage, every
   later stage references it — it is never recalculated or guessed at
   again.**

**Status:** ✅ Adopted — confirmed, already the entire reasoning
behind "the LLM must never do arithmetic."

---

## Research 007 — Databases (2026-07-11)

### Principle 18 — An Index Is a Precomputed Answer

**Borrowed from:** database indexes and materialized views — rather
than scanning and recomputing an answer from raw rows every time a
common question is asked, the answer (or a fast path to it) is kept
ready in advance.

1. *Problem:* recomputing the same aggregate from scratch on every
   request wastes work and risks inconsistency between two places
   that should agree.
2. *How solved:* a real, maintained structure that already holds (or
   can cheaply produce) the answer to a known, common question.
3. *Does Office have this problem?* Yes, and — same pattern as
   throughout this document — already solved. `getOutstandingInvoices`
   and `getQuotationsSummary` are real SQL aggregates, computed fresh
   from ground truth on request rather than an AI attempting to recall
   or reconstruct the numbers from memory.
4. *What survives?* **A known, common question deserves a real,
   precomputed or cheaply-computed path to its answer — never a
   from-scratch guess.**

**Status:** ✅ Adopted — confirmed. Worth noting explicitly:
Office's version of "the index" is real SQL, run fresh each time
rather than cached — correct for its current small scale, and worth
revisiting only if query volume or table size ever makes it genuinely
slow, not before.

---

## Principle 19 — Silence Is Success (2026-07-11)

Not borrowed from external research — discovered through direct product
conversation, crystallizing three things that had been scattered across
this project without ever being named as one belief: the Ether
manifesto's sigh state ("nothing urgent, breathe"), the embers'
own founding rule ("Peter must guide," never editorializing), and the
deliberately-rejected cron-generated briefing.

> The absence of notifications is a positive outcome, not a lack of
> functionality. An empty screen means the organization is under
> control — Office achieved something, not that it has nothing to
> show.

1. *Problem:* almost all business software measures its own value by
   how much it surfaces — more dashboards, more widgets, more things
   demanding attention. That's optimizing for the wrong signal.
2. *How solved:* invert the measure entirely. Success is a quiet
   screen. Office should actively want to have nothing to show Peter,
   the same way a good employee doesn't manufacture status updates to
   look busy.
3. *Does Office have this problem?* Yes, directly — the embers concept
   (color-coded, per-department pulse indicators, dark when a
   department has nothing pending) is the concrete mechanism this
   principle governs. An ember lighting up must always mean something
   *real* is pending; a quiet ember is the actual desired steady
   state, not an empty or unfinished one.
4. *What survives if the implementation changes?* **Office should be
   measured by how little it needs to show, not by how much it can
   show — silence is the product working, not the product being idle.**

**Status:** ✅ Adopted, as a design constraint on everything built from
here forward — including the ember bar, whenever it's built: every
ember's dark state must be treated as a genuine, positive outcome to
design for, not an empty placeholder waiting to be filled.

## Closing synthesis — where AI actually lives

Seven research entries in, the pattern is no longer a surprise: **every
single external system studied had already, independently, been
arrived at by Office under real pressure**, usually from a real bug,
before this research phase began. That's not a coincidence worth
under-selling — it's the strongest possible validation available,
because it means these principles weren't chosen because they sounded
right in the abstract. They were forced into existence by what actually
broke, and then confirmed, afterward, by decades of systems that
solved the same underlying problems for the same underlying reasons.

The honest map, laid end to end:

- **The Intent Engine** (Genesis Principles 1–2) is the scheduler and
  the translator — it decides what Peter meant and narrates what
  happened, and never the business logic in between.
- **The Dispatcher** (Principle 8) is `processTranscript`'s dispatch
  chain — decide and execute, kept apart on purpose.
- **Execution Registers** (pinned, not yet built) are the mutable
  pointers (Principle 16) — small, explicit, always pointing at
  something real and immutable underneath.
- **Business Objects** (Principles 10, 11, 17) are the real schema —
  loosely or tightly related on purpose, converting through real
  funnel stages, each number settled once and referenced forever after.
- **Search** (Principles 13–15) is retrieval-first (Principle 4),
  deterministic matching with forgiving suggestion kept strictly
  separate (Principle 1, confirmed independently by Principle 13).
- **Departments** (the still-distant "Finance/Marketing/Website/Tender"
  vision) are, in this language, just more business-object clusters
  behind the same dispatcher, the same execution ladder, the same
  narrator — nothing about the architecture changes shape to
  accommodate them; they're additional nouns, not a new kind of noun.

If a future version of Office is tempted to let the AI "just guess" —
match a task, resolve a customer, recalculate a total — the answer was
never really "can we?" It was always: does this violate Principle 1?

