# ERP Mode — Architecture

Pinned before moving to design. Builds directly on
`ROOMS_BACKEND_SCOPE.md` and `BACKEND_CAPABILITY_MAP.md` — read those
first for the real, verified backend evidence this proposal is
grounded in. This document is the shape decided from that evidence,
not a new investigation.

---

## Voice is the hero — the shell serves it, never competes with it

Real, direct instruction, and the single most important constraint on
everything else in this document: ERP mode must never become a mini
SAP, or SAP Light. The shell exists to find and review what voice
already created — not to become a second, competing way of getting
data into the system.

The whole backend is genuinely, entirely built around one idea:
describe what happened, let extraction turn it into structured data.
That's not an implementation detail to work around — it's the
product's actual identity. A rich, well-reasoned system already
exists around this (`guard()`'s human-confirmation discipline,
deterministic financial math, the unified capture pipeline). The
shell's job is to stay lean and subordinate to that, permanently:

- **Search, view, and a narrow edit-existing-record form** are the
  real ceiling for the shell's own write capability. Editing a
  record that already exists (born from voice) is genuinely
  different from creating one from nothing — the shell may do the
  former; voice alone does the latter.
- **No "New Invoice" button that starts a document from a blank
  form.** However convenient it might look once the shell exists,
  a document is only ever born through voice. This is a permanent
  constraint, not a temporary one pending future backend work.
- **When manual editing is genuinely needed** (per the real,
  reasoned decision already made), it works *with* the same
  underlying, deterministic functions voice already calls
  (`recordInvoice`, etc.) — never a parallel, competing write path
  that could quietly drift from what voice produces.

This principle disciplines every other section in this document. If
a future addition to the shell would make it feel like a faster or
more capable way to enter data than speaking, that's the signal it's
drifted from what this system actually is.

---

## The core principle — two modes, one system

**Rest — the void.** Orb breathing, embers drifting, the lake alive
underneath. This answers "where do I want to go." Nothing about it
changes for ERP mode. It stays calm, ambient, minimal — the
front door, not the application.

**Work — inside a room.** The moment a real doorway opens, the
metaphor gets out of the way. This answers "where is that thing."
Real lists, real search, real detail views. Dark background carried
over from the void (not a jarring switch to light), but the content
itself stops pretending to be ambient.

The Embers aren't the application. They're the way in.

---

## The doorway — generic, already proven

Tap an ember: it brightens, the orb reacts with a real, genuine hint
of that ember's own color, the room grows outward from that exact
point and slips into focus rather than popping into place. This
mechanic is already built and already proven tonight — and it's
generic. Every module enters through the same grammar. Nothing about
the doorway itself is module-specific.

Closing mirrors opening: the room collapses back into the ember it
came from, not a generic close button.

---

## The shared shell — the one real, new primitive

Every module — Finance, Suppliers, and eventually Scheduling and
Inventory — opens into the same real shape:

- A search field
- A real list — each row showing only the two or three fields that
  actually matter for that module (amount and status for an invoice;
  supplier and date for a purchase order)
- Tap a row for its detail view

One shell, built once, reused everywhere — not six bespoke screens.
This is the direct, concrete answer to what
`BACKEND_CAPABILITY_MAP.md` found: the same missing relay shape
repeating in every domain. That's one real thing to build well, not
six separate, smaller ones. The same instinct that made `OfficeClock`
and `OfficeStateMachine` shared primitives instead of one-off
implementations per feature.

## Depth and cognitive load — staying light

A real, named risk, not a vague concern: `BACKEND_CAPABILITY_MAP.md`
shows Finance alone covers quotations, invoices, expenses,
aged-creditors, and two separate PDF reports. Left unchecked, that's
five sub-menus before a second module is even reached — the exact
thing the Experience Brief has warned against since the beginning:
relief, not productivity software. Nobody should need a tutorial to
get a simple number out of this.

**One flat, searchable list per module, not tabs per data type.**
Finance doesn't ask "invoices or quotations?" first. One list,
blended, each row quietly labeled with its own type. Search narrows
it — there's no menu to learn before you can even look for something.

**Search is the primary way to narrow things down, not a feature
alongside navigation.** Already named as a goal in this document;
made load-bearing here. Typing beats navigating. Fewer structural
decisions imposed on Peter, more just asking for what he wants.

**Filters and sort stay hidden until summoned.** A single small icon,
not a permanent row of chips consuming screen space — the same
Notion pattern already confirmed in research: controls appear on
demand, not by default. The list's own default order should already
be the useful one (overdue first, for Finance) so most of the time
nobody touches sort or filter at all.

**Reports are actions, not sections to browse.** Aged-debtors and P&L
are documents to generate, not a list to scroll. One small "generate"
action, not a tab implying a menu of reports to learn.

**A hard depth rule: two taps, always.** Void → module list → detail.
Never a third layer of category-picking in between. If a module's
real data can't fit that shape, that's a signal its data model needs
better blending in the list itself — not a reason to add a level of
navigation.

## Moving between modules without falling back to the void

A small, persistent way to jump from one module to another directly
— Finance to Suppliers, say — without returning through the ember-tap
ceremony each time. Once inside "retrieval mode," bouncing back to
the void to switch modules would undercut the whole point of work
mode existing. Doesn't need to be a full desktop sidebar; on a phone
this can be as simple as a slim, persistent module switcher living in
the room's own chrome.

---

## Where People actually sits in this

Its own overview stays exactly as it is — grouped, translucent
bubbles, real embers inside, per the direct visual correction earlier
tonight. That's still an honest picture of what People actually is
right now: a small, relational index, not a dataset that benefits
from a table yet.

But the moment an individual person has real data worth showing — a
customer with real, linked invoices; an installer with real, linked
jobs — tapping them should drop into the *same* shared detail view
every other module uses, not a separate, bespoke person-screen.

This isn't a permanent exception. It's an honest reflection of
People's current data maturity. The evidence for this: the AI/voice
layer already does real, cross-referenced retrieval today —
`resolveFollowUpEntity` in `ai.ts` genuinely resolves "what's her
balance" back to a standing topic and pulls real financial data. That
capability already exists; it currently has nowhere to physically
manifest and be browsable except through a spoken question and a
spoken answer, with nothing persistent left behind. ERP mode gives it
a real, queryable home. People keeps its own front door. It shares
everyone else's rooms.

---

## How this actually expands as backend capability grows

Each module's detail view is built to show only what's real right
now, with room left to grow — not rebuilt as data matures. Finance's
detail view might start as just amount, status, and line items, and
gain a linked-communications tab later without anything structural
changing. The shell itself doesn't change shape as capability grows;
it just displays more, because it was never built as a fixed,
finished thing.

---

## Sequencing — from the real, evidence-based decision already made

**Finance and Suppliers first.** Both independently confirmed as the
most relay-ready domains in `BACKEND_CAPABILITY_MAP.md`, and neither
has known, open extraction bugs the way Scheduling does — real,
unresolved issues (cross-segment pronoun resolution for money, an
installer misfiled as a customer) found the same night this was
scoped. Building a polished, searchable view on top of data that's
still sometimes wrong risks a beautiful window onto an unreliable
foundation. Scheduling becomes a deliberate second wave, once those
extraction issues get real attention — not the launch domain.

Inventory and the two unexplored field-ops tables (`snags`, `leads`)
stay further out, named but not yet scoped in detail.

---

## What this document does not settle

- The exact visual language of the shared shell (typography, list
  density, how search actually feels) — that's the design pass this
  document hands off to.
- Whether the module switcher lives as a persistent strip, a gesture,
  or something else — a real design decision, not an architectural
  one.
- The real, new backend read endpoints each module's detail view
  will need (joined, list-and-detail-shaped queries) — genuine,
  separate backend work per module, not addressed here.
