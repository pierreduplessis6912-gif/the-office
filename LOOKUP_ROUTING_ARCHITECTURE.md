# Lookup Routing Architecture — AI Determines Intent, Never Composes the Answer

Pinned before building, per direct instruction — the same treatment
Job Cards and Calendar Integration got. Builds directly on the
"deterministic over probabilistic for money" principle that has
governed every financial calculation all along; this extends it one
step further, to how an answer gets *assembled*, not just calculated.

---

## The core principle, in the words it was proposed in

"Instead of making AI deterministic in answering certain questions...
we can use AI to determine intent, and based on the intent of the
question, choose the suitable UX to show... there is an LLM layer, but
it is in determining the intent of the question and the suitable
answer, not in actually answering the question."

The model's real job becomes routing: recognizing what's being asked,
and selecting an already-correct, already-built output — never
narrating a number it never actually touched. This closes two real
problems in one move: the two-minute wait for a composed sentence
disappears, since there's no sentence to compose; and there's no risk
of the model ever softening, miscounting, or reinterpreting a real
figure on the way to answering.

## The real, load-bearing distinction: complexity, not topic

Confirmed directly, in the words it was drawn: not every financial
question deserves a dashboard. The split is complexity, with real,
concrete examples given for each side:

**Complex, dashboard-worthy** — "what's our profit and loss for a
certain period," "what's our financial standing currently," "what
does our cash flow look like." Multi-faceted, structured, genuinely
benefit from a real, visual presentation rather than a spoken
sentence.

**Simple, conversational** — "what does Jenny owe us." A single,
specific, narrow fact. Answering this with a full dashboard would be
over-engineering a question that's genuinely just a sentence's worth
of information.

Both lanes stay deterministic in the sense that matters — a
dashboard-worthy question gets real, pre-computed numbers with no AI
touching the math; a conversational question can still use real AI
synthesis for phrasing, but only ever over facts already pulled from
real SQL, exactly as `answerFromMemory` already does today. The
routing decision is what's new — which lane a question belongs in —
not a wholesale rejection of synthesis everywhere.

## What already exists and can be built on directly

This is not a rebuild. The real, working precedent for "AI determines
category, never generates the fact" already exists in two places,
confirmed directly in the live code:

- `extraction.query_scope` (personal / business / customer) is
  already real, working routing — a first, coarse-grained version of
  exactly this idea.
- `classifyBusinessTopic` is a more precise, already-proven example:
  it decides whether a business question is about invoices,
  quotations, expenses, or genuinely general, purely to decide *which
  real facts to gather* — never touching the numbers themselves. The
  real, new work is extending this same kind of classification one
  step further, to decide not just which facts to gather, but whether
  to hand them to a dashboard or to `answerFromMemory`.

`/debug/financial-snapshot`, built and verified tonight, is a real,
live proof that the deterministic side of this already works
end-to-end — real, structured numbers, zero AI, built from the same
SQL already powering voice lookups.

## The real, new pieces this introduces

**A real classification step deciding "dashboard or sentence."** Not
yet designed — needs its own careful prompt work and real, live
testing, the same discipline every other classification bug tonight
was found and fixed with. This is a real, new decision point, not an
extension of an existing one.

**A named, finite set of real dashboards to route to.** Not yet
decided how many, or how they relate to each other — a single,
tabbed financial view versus several separate ones is a real, open
question, not resolved by this document.

**A genuinely new interaction pattern.** Every room built so far opens
by a tap. This would be the first time a spoken question opens a room
on its own, without a tap at all — worth naming explicitly as new,
not assumed to behave like anything already built.

## What this document does not settle

- The real, exact wording and structure of the new classification
  step's prompt.
- How many distinct dashboards exist, and what each one shows.
- What happens if the classifier is genuinely unsure which lane a
  question belongs in — a real, honest fallback needs deciding, not
  left implicit.
- Whether a dashboard opened by voice should look and behave exactly
  like a dashboard opened by tapping an ember, or whether a
  voice-triggered entry deserves its own, distinct framing.
