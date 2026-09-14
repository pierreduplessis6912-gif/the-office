# Relational Identity Architecture — Identity as Position, Not Record

Pinned before building, per direct instruction — the same treatment
Job Cards, Calendar Integration, Lookup Routing, Identity, and Ask &
Research all got. Builds directly on `IDENTITY_ARCHITECTURE.md` — this
does not replace `reconcilePerson`, it adds a second, optional signal
that only speaks when the first one is genuinely unsure.

---

## The real problem this addresses

`reconcilePerson` resolves identity from string similarity alone. The
six people currently flagged at `/debug/people-needing-review` are
exactly the cases where a name-similarity threshold cannot
responsibly decide — genuinely ambiguous names, no stronger signal
available to fall back on. Every real bug already fixed this project
(the register-staleness bugs, the Andre/Juandre false match) traces
to the same root shape: identity resolved from one isolated
attribute — a string — rather than from the real relational context
Peter obviously has access to the moment he says a name out loud
(which job this is, who else was just mentioned, what conversation
this is continuing).

## The core idea, stated plainly

A person doesn't just have a name. They have a position in a web of
who they've talked to, which jobs they've touched, and when. Two
independent conversations that keep circling the same job, the same
time-of-day pattern, and the same referral chain are evidence of
identity every bit as real as a matching string — arguably harder to
produce by accident, since it can't be spoofed by two unrelated
people who simply happen to share a name.

## Where this sits relative to `reconcilePerson` — auxiliary, not a replacement

Non-negotiable ordering, matching how `people` itself was rolled out
as a fallback-preserving addition rather than a rip-and-replace:

1. `reconcilePerson` keeps deciding every case it already decides
   confidently. Nothing about its current authority changes.
2. The relational layer is consulted only in the exact ambiguous zone
   that currently produces a flagged-for-review record — not a clean
   match, not a clean miss.
3. If the relational layer also can't produce a confident answer, the
   record still falls through to human review exactly as it does
   today. The new layer only ever adds a second source of confidence
   — it never gets authority to auto-merge on its own.

## The staged real design — build-now, honest stretch, and out of scope

**Stage 1 — passive logging, zero behavior change.** A new
`interaction_edges` table: `(capture_id, person_id_a, person_id_b,
relation_type, context, created_at)`. Populated passively alongside
every capture that already flows through `reconcilePerson` today. No
decision anywhere depends on it yet — this is the same dry-run-before-
any-real-change discipline the `people` backfill used, applied to a
new signal instead of a new migration.

**Stage 2 — the tiebreaker.** A new `resolveByRelationalContext()`
function, called only when `reconcilePerson`'s confidence lands in
the ambiguous middle. Confidence here comes from relational density —
how many independent edges converge on the same person — not from a
single string-distance number. Checked retroactively against the
real, currently-flagged six records first, before it is trusted on
anything live, per the project's own "verify against real behavior,
not reasoning" standard.

**Stage 3 — shape matching via Vectorize.** Vectorize is already
provisioned in this stack and mostly unused for this purpose. A
person's or job's relational trajectory, embedded as a vector, turns
"does this new interaction resemble a known pattern" into a real,
cheap nearest-neighbor query instead of hand-written heuristics.
Genuinely buildable on infrastructure already paid for and running,
but a real, separate research-and-tuning effort — named honestly as a
later phase, not promised on the same timeline as Stages 1–2.

**Named but explicitly out of scope: cross-instance pattern sharing.**
Tokenized, Datavant-style trust-signal sharing across separate Office
instances — a supplier's track record following them between
businesses, without any business's raw data ever leaving its own
instance — is architecturally consistent with Workers for Platforms,
already pinned elsewhere in this project for multi-tenant
provisioning. It is a distinct, later project of its own, not part of
this document's build.

**Named but explicitly rejected: the system deciding for itself what
relational shapes deserve to become categories.** This was argued
through directly, out loud, before this document was written: letting
the system autonomously recognize an emergent pattern and treat that
recognition as settled fact is functionally identical to letting AI
invent a business fact instead of routing to a deterministic one —
the exact thing the "AI routes, it doesn't decide" principle exists
to prevent. Any future capability that proposes a new relational
category still requires the same human-confirmation gate that already
governs every other consequential write in this system. This is a
permanent boundary this document is deliberately not trying to design
around, not a temporary one waiting on better technology to remove.

## What this document does not settle

- The real set of `relation_type` values `interaction_edges`
  recognizes at launch — deliberately not pre-built speculatively,
  per the constitution's no-speculative-fields discipline; add the
  first ones only once Stage 1's passive logging shows which
  relations actually recur.
- The real confidence threshold for relational density — how many
  converging edges are enough to count — a starting point to be tuned
  against real data, not assumed correct up front, the same honest
  posture Identity's own 8-character threshold took.
- Whether Stage 3's Vectorize work happens before or after Job Cards
  and the remaining dashboards in the existing priority-ordered
  roadmap — a sequencing decision for `STATUS.md`, not this document.
- Whether `interaction_edges` gets backfilled retroactively from
  historical captures, or only starts accumulating from the day it
  ships.
