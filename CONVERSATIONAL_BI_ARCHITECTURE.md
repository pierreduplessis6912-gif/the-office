# Conversational BI Architecture — A Persistent Analytical Relationship, Not Voice-Controlled Reporting

Pinned the same way `WHATSAPP_CHANNEL_ARCHITECTURE.md`, `ONBOARDING_JOURNEY.md`,
and `SELF_HELP_ARCHITECTURE.md` were — a real design, scoped before any of it
gets built.

## The real distinction this document draws

Not a voice interface bolted onto a conventional ERP — the equivalent of an
experienced BI/replenishment manager: describe what you want, the system
understands the business context, chooses the right analytical shape,
returns a concise answer with the option to see the table, and the
conversation continues from there ("why?", "drill into that", "compare
margin instead"). The goal is a standing analytical relationship, not a
single report generated per question.

## Two layers, kept deliberately separate

**Memory/preference** — how the owner thinks about the business, recurring
questions, preferred comparison periods, standing priorities. This is
context and preference, never business truth. Mirrors the real split
already in this codebase between `memory.ts`'s customer facts and
`finance.ts`'s actual math — this document just applies the same split one
layer up, to analysis rather than extraction.

**Deterministic analytical/query layer** — resolves dates, resolves
entities, applies permissions, queries structured records, calculates
totals and ratios and rankings, returns the evidence behind the answer.
The AI translates a spoken request into a structured query plan; it never
calculates or invents the result. Exactly the same discipline already
proven all night for extraction (`extractLineItems`, `reconcileProduct`)
— applied here to analysis instead.

## The real shape of a request

A spoken comparison becomes a structured plan (period, dimensions,
measures, ranking), executed deterministically, returned as both a
narrative and the underlying rows — so the conversation can keep going
("show me the table", "drill into vinyl", "export that") without
re-asking the whole question from scratch. The screen is the report
surface the conversation produced, not the primary way to navigate — the
same "interface disappears" principle already governing the rest of this
project.

## Two real, concrete gaps this document assumes — found by this exact
## project's own earlier audit tonight, not new findings

**Date-ranging doesn't exist yet, anywhere.** Checked directly earlier
tonight: `getProfitAndLoss` and every other report function is all-time
only — no `WHERE created_at BETWEEN...` anywhere in the codebase. The
flagship example in this design — "compare April to March" — is literally
unanswerable today. This is the real, honest first line of "what to
implement first," not something to assume is already sitting underneath
once the query-plan layer exists.

**"Category" as a dimension assumes a taxonomy that was deliberately never
built.** Tonight's own products-foundation audit found `products.category`
is a bare column, populated by nothing — left that way on purpose, since
no real evidence yet justifies inventing a category scheme. "Vinyl was the
fastest-*moving* category" doesn't work as written. Either the real
vertical slice groups by **product** (real, populated, already proven
tonight) instead of category, or populating category becomes its own
named, evidence-gated prerequisite — not something this design can quietly
assume already exists.

## The controlled-vocabulary risk, and the fix already designed once tonight

A big, upfront taxonomy of analytical terms (revenue, margin,
fastest-growing, aged, and so on), built in one sitting ahead of any real
question needing it, is exactly the shape of mistake `interaction_edges`
already made once tonight — real structure invented ahead of real
evidence. The fix is the same one just designed for `SELF_HELP_ARCHITECTURE.md`:
start from a small, real set of questions actually being asked, and grow
the vocabulary only when a real one doesn't fit — never draft the whole
list speculatively.

## What to build first — one real vertical slice, not a generic engine

Matches the exact discipline that has governed every real piece of tonight's
work — products before a full materials system, onboarding scoped before
multi-tenancy exists. One complete, real analytical experience:

> "Compare financial performance for period A and period B, grouped by
> product, and identify the fastest-growing one."

Real prerequisites, in honest order:
1. Date-range support in the report functions — the actual missing
   foundation, not assumed.
2. Grouping by product (real, populated) rather than category (real
   column, empty) — or category populated first, as its own named piece
   of work, if that's genuinely wanted instead.
3. The query-plan translation layer itself, deliberately scoped to this
   one real comparison shape first.

Everything else in the wider vision — standing briefs, drill-down state,
export formats, the full analytical vocabulary — is real and worth
building eventually, grown from real use of this one slice, not designed
ahead of it.

## Principles this reaffirms, already established elsewhere in this project

- Deterministic before AI — AI extracts and translates intent; code
  resolves and calculates. (`CORE_SUBSTRATE_ARCHITECTURE.md`)
- Share what is known, don't guess what is meant — ambiguity is asked
  about or held for a saved preference, never silently resolved.
  (`reconcilePerson`'s exact same discipline, one layer up.)
- Start with the smallest real domino, grow from evidence.
  (`SELF_HELP_ARCHITECTURE.md`, the products foundation, this document's
  own "one vertical slice first" instinct.)

## What this document does not settle

- The exact real schema for a query plan or a standing brief — left for
  the real implementation pass, once the date-range foundation exists.
- Whether category ever gets populated, and if so how — a real, separate
  decision, not assumed here either way.
- The real export/print formats — genuinely useful eventually, not
  scoped in this pass.
- How conversational drill-down state is actually persisted — a real
  design question for whoever builds the first vertical slice, informed
  by what that slice actually needs, not decided speculatively now.
