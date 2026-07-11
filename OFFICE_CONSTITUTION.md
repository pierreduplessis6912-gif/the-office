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

*Next: Research 002 — CRM (relationship representation, not UI).*
