# Self-Help Architecture — Teaching From Real Decisions, Without Guessing

Pinned the same way `WHATSAPP_CHANNEL_ARCHITECTURE.md` and
`ONBOARDING_JOURNEY.md` were — a real design, scoped before any of it gets
built.

## The real tension this resolves

"Teach from the real decisions behind how this works" pulls toward rich,
generative answers pulled live from `DECISIONS.md` and the other
architecture docs. Everything else built tonight insists the opposite — AI
classifies and routes, it never invents, and it never gets to represent a
real decision's reasoning on the fly, because that's exactly the kind of
thing that can quietly drift from what was actually decided. This document
resolves that the same way the rest of the project already does: keep the
generative step out of it entirely.

## The real mechanism — reused, not invented

This is structurally the same problem `classifyDashboardIntent` already
solved. That function takes a spoken question, classifies it against a
small, known, real set of dashboards, and returns a marker the app opens
directly — cheap, fast, no hallucination risk, because it's choosing
between real, fixed options, never generating an answer from scratch. A
help question is the same shape: classify "how do I upload an invoice"
against a small, curated set of real topics, and return a pre-written
answer — never a live summary of raw decision-log text.

**Concretely:**
- A small, real table of help topics, each with a real question or two it
  matches, and a hand-written (or AI-drafted, human-reviewed) answer.
- A classifier, the same real shape as `classifyDashboardIntent`, matching
  a spoken or typed question against that table — confident match, or
  genuinely unsure, never a forced guess.
- Every answer is written *once*, by hand, distilled from the real
  decision that actually justifies it, and traceable back to it. Slower to
  build up than a search index over the raw docs — but the only version
  where every answer is guaranteed accurate rather than merely
  plausible-sounding.

## Why this serves "feels alive," not just "answers questions"

The same classification result can also trigger the real room-opening
mechanism already proven tonight — the exact `__OPEN_DASHBOARD__:` pattern
already wired for business questions. "How do I see my leads" doesn't just
explain in words; it opens the real Leads room while explaining, the same
way asking about the financial snapshot already does. That's the real
difference between a static FAQ sitting behind a menu and something that
feels like part of the place responding to you.

## The real, disciplined growth path

Start small. A handful of the most likely real questions to begin with —
this exact conversation is real evidence for the first one ("can The
Office explain itself"). Grow the topic table the same way `interaction_edges`
should have been built in the first place: driven by real questions people
actually ask, confirmed as genuinely recurring, not a list anticipated in
one sitting and built ahead of any evidence they'd ever come up.

## What stays deliberately dormant

Full semantic search over the raw documentation set — embeddings,
Vectorize, a real RAG layer over `DECISIONS.md` and the architecture docs —
is explicitly not built here. It's a real, plausible eventual answer once
the curated topic table genuinely runs out of room (a real question that
doesn't fit any curated topic, recurring often enough to matter), but
building it now would be exactly the premature-tool mistake already caught
once tonight, aimed at a different problem. The curated approach is
deliberately the first, cheaper thing tried — not assumed to be the final
shape forever.

## What this document does not settle

- The real, initial topic list — left for whenever this is actually built,
  informed by whatever questions have genuinely come up by then, not
  drafted speculatively in this document.
- Where in the app this gets triggered from — a dedicated "help" entry
  point, or folded into the same general question-answering path
  `classifyDashboardIntent` already runs through. A real implementation
  decision, not an architectural one.
- The real threshold for when the curated table "runs out of room" and
  semantic search over the raw docs becomes justified — deliberately left
  as a judgment call for whoever's looking at the real evidence at that
  time, not a number decided in advance.
