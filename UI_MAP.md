# The Office — UI Capability Map

Every real backend capability, paired with where it lives (or should
live) in the app. Built for one reason: so that every function in
Cloudflare eventually has a real, considered home in the UI — not
built all at once, but never silently forgotten either. This document
exists to make that honest, not to demand immediate completeness.

Grounded in `FEATURES.md`, the real, current inventory of what the
backend actually does — nothing mapped here that isn't real there
first.

The core philosophy stays exactly what it's always been: minimal,
voice-first, an empty screen as relief (Constitution Principle 25 —
discoverable, never displayed). This map exists to make sure that
discipline is a deliberate choice for each capability, not an
accident of what happened to get built first.

---

## Already has a real home (built or in direct progress)

| Capability | Lives in | Status |
|---|---|---|
| Conversational lookup, any message | The stage (main conversation surface) | Built |
| Photo capture | Camera button in composer, `/files/photo` | Built (manifesto) — needs porting to Flutter |
| Document upload | Upload button in composer, `/files/document` | Built (manifesto) — needs porting to Flutter |
| Voice input | Talk button | Built in `main.dart` (record-and-upload); manifesto's live browser recognition does not carry over to native — keep `main.dart`'s approach |
| Tasks & Reminders (read) | Tasks ember → sheet | Built (manifesto) |
| Job Scopes (today's schedule, read) | Scheduler ember → sheet | Built (manifesto) |
| Invoicing & Payments (outstanding, read) | Finance ember → sheet | Built (manifesto) |
| Expenses (today's, read) | Expenses ember → sheet | Built (manifesto) |
| Team & Contacts (Characters) | Menu drawer → People | Built (manifesto) |
| Profit & Loss, Aged Debtors (PDF) | Menu drawer → Reports & Documents | Built (manifesto) |
| History of what's been said | Swipe-left history panel | Built (manifesto) |

## Real, load-bearing gap — must be ported before anything else

| Capability | Needs |
|---|---|
| Confirm/reject for any guard()'d action | The single most critical missing piece — payments, invoices, quotations, expenses, supplier invoices, retention facts, everything financial depends on this. Proven working in `main.dart`; entirely absent from the manifesto. |
| Conversation history sent with each message | Needed for pronoun/follow-up resolution ("what does she owe" after "Jenny...") — proven in `main.dart`, absent from the manifesto's `sendToOffice`. |
| Generated PDF links (quote, invoice, statement) surfaced after confirming | Proven in `main.dart` (`pdfUrl` shown on a confirmed stamp) — needs the same treatment once confirm/reject is ported. |

## Real capabilities with no obvious home yet — genuinely open, not guessed at

These are real, proven backend capabilities that don't cleanly fit
today's four embers or existing menu sections. Naming them here
rather than silently deciding alone:

- **Suppliers & Procurement** (Purchase Orders, GRN, Supplier
  Invoices, Supplier Payments, Aged Creditors) — does "Finance" grow
  to cover both directions (owed to us, owed by us), or does this
  need its own, separate home? A fifth ember risks breaking the
  deliberately small, symmetric masthead design.
- **Consumables Stock** (registering, usage, stocktakes) — no ember
  or menu section covers "how much do we have" today.
- **Snags** — arguably belongs under Tasks (a real, open thing to
  do), or arguably its own thing, since it's tied to a specific job
  and customer rather than Peter's own personal errands.
- **Leads & Enquiries** — likely belongs under People (someone, not
  yet a customer), but worth confirming rather than assuming.
- **Supplier Statement Reconciliation** — tied to Suppliers &
  Procurement, same open question.
- **Projects (Layer 2)** — likely belongs under Scheduler alongside
  job scopes, but a project spans multiple phases/dates, which the
  current "today's jobs" framing doesn't quite capture.
- **Corporate Stationary** (logo) — likely Menu drawer → Office,
  alongside Settings.
- **Statement of Account** (per-customer, PDF) — Financial Reporting
  covers P&L and Aged Debtors in the reports menu; a per-customer
  statement doesn't fit a general reports list the same way. Possibly
  surfaced from within the People section, next to that customer.
- **A real "who am I" indicator** — nothing today shows which real
  session/role is active; a small, honest addition once relevant
  (multiple real users, not just Peter).

## Deliberately, honestly not built yet — matching `DECISIONS.md`

Real, substantial designs, correctly gated, no UI question to answer
because the backend capability itself doesn't exist yet:

- Job-specific material remnant tracking
- Warranty tracking, the richer job-completion artifacts
- The named-handle Layer 2 rung
- Chain automation (deliberately gated behind the mirror being
  "polished bright" first — this document is part of that polishing)
- Office scales by scope
