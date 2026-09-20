# Core Substrate Architecture — What Belongs to the Platform, and What Belongs to a Vertical

Pinned before anything is built on it, same treatment every real architecture
document in this project gets. Different in kind from the others, and worth
saying so directly: this one isn't scoping a feature. It's naming what The
Office actually is, underneath being a flooring tool — so that if this ever
becomes something other people build on, this document is where that
question got answered first, and why.

---

## The real question this answers

Everything built in this project so far was built for one real business.
Every fix tonight — the identity layer, the ambiguous-person picker, job
scope amendments, gesture grading — was earned by a real bug, in real data,
for Zululand Flooring and Blinds. None of it was designed in the abstract.

But none of the mechanisms that made those fixes work ever depended on
flooring. `reconcilePerson` doesn't know what an installer is. `guard()`
doesn't know what a job scope is. The discipline that makes this project
trustworthy — capture immutably, extract deterministically, resolve
identity against real evidence, hold anything consequential for a human,
grade that hold by real reviewed stakes, never delete, always mark — is a
runtime for *trustworthy consequential action*, not a runtime for flooring
that happens to be reusable.

That distinction is easy to lose gradually, one convenient vertical-specific
shortcut at a time, until the thing that was general quietly isn't anymore.
This document draws the line on purpose, while it's still easy to see where
it is.

## The real substrate — proven, not proposed

Everything here has already been proven against real bugs, in this real
project, not designed speculatively for this document:

1. **Immutable capture.** The raw record of what was actually said or done,
   never altered by anything downstream. Every fix tonight that involved an
   audit trail — `job_scope_amendments`, `merged_into_customer_id`,
   `merged_into_person_id` — depended on this holding absolutely.
2. **Deterministic-before-AI.** AI classifies and routes; it never invents a
   fact where a real, structured answer already exists. `findLatestJobScope`
   matching real transcript text against real job descriptions, not asking
   AI to guess which job was meant, is this principle doing real work.
3. **Real-evidence identity resolution.** Exact match, then whole-word,
   then phonetic, holding for a human the moment confidence runs out rather
   than ever guessing. Proven against a real, repeated, three-way
   fragmentation (Bon Hotel Waterfront) and fixed at the root, twice, once
   for the customer layer and once for the underlying person layer.
4. **`guard()` — nothing consequential executes without being held for a
   real human decision first.** Not "AI asks permission" as a vague
   gesture — a specific, structural gate between an AI proposal and a real
   write.
5. **Gesture graded by real, reviewed stakes, defaulting to the safer
   gesture for anything not yet reviewed.** Proven directly: 12 real
   pending-action types found in one audit; 11 defaulted to hold rather
   than being guessed into "probably fine."
6. **The audit trail pattern.** Never delete, always mark. A merged
   customer, a merged person, an edited job scope field — every one of
   these stays real and inspectable rather than silently overwritten.

None of these six needs a vertical to make sense. All six already work,
tonight, in production, for one real business.

## What is deliberately *not* in the substrate

Three things belong to a vertical, and pre-building any of them
speculatively is a real, named mistake this project already made once —
see `RELATIONAL_IDENTITY_ARCHITECTURE.md`'s `interaction_edges`, built
ahead of real evidence, for a relation type that turned out to hold zero
value once actually examined. That is the concrete, already-paid cost of
guessing at vertical-specific shape before a vertical is real.

- **Vocabulary.** Customer, installer, job scope — these are flooring's
  words for the substrate's real, general concepts (party, actor,
  consequential unit of work). A different vertical gets different words,
  not a different runtime.
- **What counts as consequential, and how consequential.** A schedule
  tweak and a medication order are not the same weight, and no one without
  real domain authority should be the one deciding that weighting.
- **What's genuinely shareable across tenants, and what must never
  cross a boundary.** This is the one `interaction_edges` got wrong by
  guessing. It is not decidable in the abstract — it takes real domain
  knowledge, per vertical, informed by real use, not a thesis written in
  one sitting.

Compliance and certification sit outside this distinction entirely. They
are not a feature to activate — HIPAA-equivalent infrastructure, a bar's
data-handling rules, a defense contractor's clearance requirements are
real, external, non-negotiable work that starts from zero the day a
vertical becomes real, regardless of how ready the code is.

## The real trigger for forking a vertical

Not a plausible-sounding thesis about a market. The same standard already
held tonight for `interaction_edges`, for the Whisper/turbo work, for
everything correctly built and correctly *not* built: real, validated
demand. If a thousand real lawyers show up wanting this, that is evidence.
A thousand lawyers imagined in the abstract is exactly the kind of
evidence that already produced one real, admitted mistake in this project.

## The real shape a fork takes

Given the isolated-instance principle already committed to elsewhere in
this project, and Durable Objects sitting as the real, current primitive
for exactly this kind of per-tenant isolation, a vertical fork's honest
shape is its **own deployment** — its own vocabulary, its own compliance
boundary, its own database — built *on* the six-item substrate as a
dependency, never one running system trying to be a flooring tool and a
law-firm tool at once. The substrate stays exactly as clean as it is
today, in every fork, because no fork ever gets to bend it to fit its own
vertical's shortcuts.

## What this document does not settle

- The real packaging mechanism for "the substrate as a dependency" — a
  shared library, a template to copy from, something else — not decided,
  left for whoever actually forks the first vertical, informed by what
  that real fork actually needs.
- Exactly how much of the current schema is genuinely vocabulary-only
  versus quietly load-bearing — `Extraction`'s `intent` enum and table
  names like `job_scopes` are real, if fairly shallow, flooring-shaped
  assumptions today. Not a rebuild to change later, but not literally free
  either — an honest gap between "the runtime is domain-agnostic" and
  "there is zero work to retarget it."
- Which vertical, if any, is actually worth pursuing first. This document
  deliberately settles the shape of the decision, not the decision itself.
