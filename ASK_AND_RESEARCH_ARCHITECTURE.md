# Ask & Research Architecture — Answering What Isn't in the Database

Pinned before building, per direct instruction — the same treatment
Job Cards, Calendar Integration, Lookup Routing, and Identity got.
This is a genuinely new category: every capability built so far
answers from the Office's own, real database. This is the first time
it would answer from outside it entirely.

---

## The real, motivating examples

Two, deliberately different real questions, given directly: "give me
the theory of relativity" and "what was the Springboks' score against
the All Blacks last week." Different in a way that matters
technically, not just topically.

## The real, load-bearing distinction: static versus time-sensitive

**Static, well-established knowledge** (the theory of relativity, how
photosynthesis works, who wrote a given novel) is already inside any
capable model's own training — a direct call to the same model already
used everywhere in this codebase (`@cf/moonshotai/kimi-k2.6`) can
likely answer this well today, with no new infrastructure at all.

**Time-sensitive, current knowledge** (a score from last week, current
prices, recent news) is different in kind, not just degree — no
static model, however capable, was trained on something that happened
after its training data ended. Answering this honestly requires real,
live access to the outside world.

## The real, honest technical gap, checked directly rather than assumed

Cloudflare's own "AI Search" product — the platform this backend
already runs on — was checked directly against its real documentation
before assuming it solved this. It doesn't: it searches **your own,
pre-indexed documents** (an uploaded FAQ, a site you've explicitly
crawled) — a real, different, more limited thing than a live, general
web search for current events. There is no already-available, native
way for this backend to answer a genuinely time-sensitive question
today. A real, new, external dependency — a third-party search API,
called directly from the Worker — would be needed specifically for
that half of this feature. This is worth naming plainly rather than
assuming Cloudflare's own AI tooling already covers it.

## How this fits the existing classification system

The current `extractIntent` system recognizes five real, narrow
scopes — personal, business, a specific customer, a specific
character, material pricing — all deliberately built around
extracting facts from a tradesperson's own, real business. A genuine
research question fits none of them, and forcing it into one would be
the same mistake `query_scope` already exists to prevent elsewhere.
This needs its own, new, real category — a `research` intent,
recognized and routed separately from `lookup`, never confused with a
question about the business's own real data.

## What "deterministic before AI" means here, honestly reconsidered

Every other capability in this codebase has a real, exact ground
truth to check an AI's output against — an invoice total, a customer
balance — and the standing principle is that AI must never guess where
that ground truth exists. A genuine research question has no such
ground truth inside this system at all; the "truth" lives entirely
outside it, in the model's training or in a live search result. The
principle doesn't disappear here — it changes shape: the honest
equivalent is that the Office must never confidently answer beyond
what it actually retrieved. A static question answered from the
model's own real knowledge should read differently from a
time-sensitive one actually backed by a real, live search result —
and if a live search is unavailable or returns nothing useful, the
honest answer is saying so plainly, not confidently guessing a score.

## The real, honest tension worth naming, not ignoring

This is a genuine, real expansion beyond "voice-first ERP for a
flooring business" toward "voice-first assistant for a tradesperson,"
full stop — closer to the water-cooler and pre-meeting-prep use cases
directly named for wanting this, than to invoicing or scheduling. Not
a contradiction of anything already built, but a real, honest
broadening worth being deliberate about, not something to let arrive
by accident through one feature's scope creep.

## What this document does not settle

- Which real, specific third-party search API to integrate, and its
  real cost/rate-limit profile at this business's actual scale.
- The real, exact prompt and classification logic for recognizing a
  `research` intent distinctly from every existing category.
- Whether a research answer ever gets voiced back conversationally
  only, or whether some answers (a long, structured explanation)
  deserve a real room of their own, the same way a financial question
  now can.
- How to honestly signal, in the moment, whether an answer came from
  the model's own static knowledge or from an actual, real, live
  search — so trust in the answer matches what actually backs it.
