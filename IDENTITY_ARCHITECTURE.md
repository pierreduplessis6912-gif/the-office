# Identity Architecture — A Real, Canonical Person

Pinned before building, per direct instruction — the same treatment
Job Cards, Calendar Integration, and Lookup Routing got. Builds
directly on `OFFICE_CONSTITUTION.md`'s Research 008 (Identity); read
that first for the full reasoning and the real, checked evidence
behind every decision below.

---

## The real, confirmed problem this solves

Two separate, serious bugs, found live in the same session, both
traced to the same root cause: `customers`, `characters`, and `leads`
are three genuinely disconnected tables, each holding its own,
partial, unaware answer to "who is this." The `register`-staleness bug
and the Andre/Juandre false-positive match were two different
symptoms of that one, real gap — not two unrelated defects.

## The core design — two real relationship shapes, not one

Confirmed independently across three real, established, open-source
systems, not designed from scratch:

**A new, real, canonical `people` table.** One row per real, distinct
human being the Office has ever encountered — customer contact,
installer, supplier rep, personal relation, anyone. This is the
missing, shared thing `customers`, `characters`, and `leads` should
all be able to point back to.

**A stable, primary relationship — one simple, direct foreign key.**
Andre as GM of Bon Hotel. Confirmed as the right shape by checking
Twenty CRM's real, live schema directly: even at real production
scale, a person has exactly one `companyId` — not a many-to-many join
table. `characters.relationship` already being free text (confirmed
already matching Twenty's own `jobTitle: string`) needs no change —
this principle validates what's already there, not replace it.

**Looser, secondary associations — a real, generic link table.** A
past personal purchase, a different property Andre is connected to.
Confirmed as the right shape by two, independent, unrelated open-
source systems converging on the same pattern without copying each
other: Frappe/ERPNext's `link_doctype` + `link_name` + `link_title`,
and Twenty's own `noteTargets`/`taskTargets`. Real schema:
`person_id`, `link_type` (a real, named string — "customer",
"job_scope", "supplier"), `link_id`, `created_at`. Deliberately not a
speculative, pre-built table — created only once a second, real
association type is actually needed, per the constitution's own
no-speculative-fields discipline.

## The real, precise matching threshold — not "be more careful"

Confirmed directly against Git's own, real, production `.mailmap`
tooling, which draws this exact line for the exact same reason:

- **An exact, full-name match** against an existing `people` row:
  reconcile automatically. High confidence, no human needed.
- **Anything weaker — a bare first name, a short or partial match, or
  more than one real candidate** — never guess. Hold and ask, reusing
  the exact mechanism already proven tonight for role collisions
  (same name appearing as both a customer and a character), extended
  to name collisions between two different real people too.
- **A real, starting number, not guessed:** tokens under 8 characters
  are treated as inherently weak signals on their own — the same
  threshold a real, current mailmap-checking tool uses "to reduce
  false positives." "Andre" (5 characters) would have been caught by
  this rule specifically, on top of the whole-word fix already
  shipped tonight.

## The real, low-risk migration path

Confirmed safe by Git's own core discipline: never alter the raw,
original capture.

1. Add `people` as a real, new, empty table. Nothing existing changes
   yet.
2. Add one new, nullable `person_id` column to `customers`,
   `characters`, and `leads`. Their own `name` fields stay exactly as
   they are, untouched, forever — the raw, as-captured record, same as
   a Git commit's original author line.
3. Backfill `person_id` for existing rows using the same, new,
   precise matching threshold above — run once, reviewed, not
   assumed correct silently.
4. New reconciliation logic (`reconcileCustomer`, `reconcileCharacter`,
   the sibling-lead lookup fixed tonight) starts checking `people`
   first, before falling back to their current, table-specific logic.
   Nothing about the existing, proven logic is removed — it becomes
   the fallback, not the only path.

## The real, contained, separate fix this absorbs

The `capture_id` audit named in the earlier gameplan stays a real,
separate, low-risk task: check every table that captures something
from a live conversation for the same structural key `job_scopes`
already had and `leads` was missing until tonight's fix. Independent
of the `people` table — can happen before, after, or alongside it.

## What this document does not settle

- The real, exact set of `link_type` values `people_links` should
  recognize at launch — deliberately not pre-built speculatively; add
  the first one only when a real, second association type is actually
  needed.
- Whether the 8-character threshold is exactly right for this
  business's real names, or needs real, live tuning after use — a
  starting point borrowed from real, external evidence, not assumed
  perfect.
- The real, exact backfill query and how partial/ambiguous existing
  rows in `customers`/`characters`/`leads` get resolved during
  migration — a real, separate, careful pass of its own before this
  is built.
- Whether `people` needs its own real room in the shell, or stays a
  backend-only reconciliation layer for now, consistent with the
  "surface existing capability only after identity is solid" ordering
  already agreed.
