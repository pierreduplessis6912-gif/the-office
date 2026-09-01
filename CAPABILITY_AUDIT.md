# Capability Audit — What's Actually Real

Written in direct response to a real, honest admission: the gap
between what this system is expected to do and what it actually does
had become genuinely unclear, even to the person who's used it the
most. Every claim below was checked directly against the live code in
this session — not recalled from `DECISIONS.md`, not assumed from an
earlier plan. Where something couldn't be verified, that's said
plainly rather than guessed.

This is a snapshot, not a living document — it will drift out of date
the moment new code is written. Treat it as ground truth for right
now, not forever.

---

## The real, three-way distinction that matters most

A capability existing in the backend does not mean a person can
actually reach it. Everything below is marked one of three ways:

- **Real, reachable by voice** — a real question or statement gets a
  real, correct answer or action, no special phrasing required.
- **Real, but voice-only, no visible UI** — the backend logic
  genuinely works, but nothing in any room lets a person discover or
  trigger it without already knowing the right words to say. This is
  very likely a real, significant source of the frustration described
  tonight — capability that exists but is invisible.
- **Not built** — no real code path exists at all, regardless of what
  might be remembered or assumed.

---

## Voice capture & extraction

**Real, reachable by voice.** `splitIntoTopics` genuinely handles
dense, multi-topic, run-on natural speech — this is not a limitation,
confirmed directly earlier tonight. Each segment gets its own,
separate intent classification via `extractIntent`. A real, wide set
of intents exist and are distinguished from each other: invoice,
quotation, payment, expense, work_observation, price_scope,
convert_quote, reminder, task_complete, note, lookup.

**Real, but voice-only, no visible UI.** The extraction quality itself
— whether a given phrasing gets classified correctly — is the single
biggest lever on whether the whole system feels reliable, and it's
also the hardest thing to audit here, since it depends on real, live
model behavior, not just code structure. Tonight's session found two
separate, real classification bugs by direct, live testing, not by
reading the prompt alone. The honest implication: this document can
confirm what a correct classification does downstream, not whether a
given real phrase will actually classify correctly.

## Scheduling

**Real, reachable by voice.** A pure "schedule X to be installed on
[date]" or "send [installer] to [customer]'s job" creates a real,
genuine job scope with a resolved date and linked installer — this was
directly, empirically confirmed working end-to-end tonight, including
the real fixes needed to get there.

**Not built — confirmed directly, not assumed.** `job_scopes` has no
completion status, no final/actual measurement distinct from what was
recorded at work-observation time, and no linkage to what an installer
is owed. Asking "what do we owe [installer] for that job" gets a real,
honest answer about scheduled jobs only — never a dollar figure —
because no dollar figure exists anywhere in the schema for installer
pay. This is a genuinely complete gap, not partial.

## Customer finance

**Real, reachable by voice — deeper than expected.** Confirmed
directly, well beyond invoices/quotations/payments: real leads with
stage transitions (enquired → quoted → won/lost), real snags tracked
per customer, real projects grouping related job scopes, real
job-cost-linked profitability per customer (when expenses are
explicitly linked), and a real customer-level financial summary
(balance) — all permission-gated by real capability checks, not a
single flat access level.

**Real, but voice-only, no visible UI.** Leads, snags, and projects
have no room, no list, no tappable surface anywhere in the app. They
exist purely as backend tables and voice-lookup facts. A person would
need to already know these concepts exist and ask about them by name
to ever see this data again.

**Real, business-wide reporting — voice-only.** Full profit and loss,
aged debtors, aged creditors, a financial snapshot — all real,
computed from live SQL, not estimated. All reachable only through a
spoken question with the right phrasing ("what's my financial
position," "who owes me money"). Real, generated PDFs exist for
several of these (P&L, aged debtors, customer statements, invoices,
quotations) but nothing in any room lets a person request one by
tapping — they're built, but there's no discoverable path to them
outside knowing to ask by voice.

## Supplier & procurement

**Real, reachable by voice and partially by UI.** Purchase orders,
goods received, variance dispositions, supplier invoices, supplier
payments, stock tracking (quantity on hand, usage, stocktakes) — all
real, backend-complete. The Suppliers room built tonight surfaces
purchase orders with real, computed status and line items — this part
genuinely has a visible, tappable surface.

**Real, but voice-only, no visible UI.** Stock levels, stocktake
history, and variance dispositions have no room at all — only
reachable through a `/debug/*` route or a spoken question.

## People & installers

**Real, reachable by voice.** Notes, HR-style facts (role, skill,
license), and real installer job-assignment history (which jobs, what
dates) — all correctly distinguished from customers, confirmed
directly in the identity-resolution logic.

**Real, reachable by UI.** The People room, built tonight, gives a
real, searchable, tappable view into this — genuinely one of the
better-covered domains now.

**Not built — the gap found live tonight.** No rate, no pay tracking,
no completion status, no "amount owed to an installer" anywhere in the
system. Assigning "a rate per m²" to an installer has no real,
structured home — it becomes an unstructured note at best, not
something any calculation can use.

## Pending / guard()

**Real, reachable by UI.** Every financial write of consequence is
held for explicit confirmation, and the Pending room, built tonight,
gives a real, working confirm/reject surface for it — genuinely solid,
end-to-end confirmed multiple times tonight including the CSV import
work.

## Calendar integration

**Real, reachable by UI, deliberately narrow.** A real "Add to
Calendar" action on a scheduled job hands off to the device's own
calendar app, pre-filled — confirmed working on a real device tonight.
Deliberately does not yet do a silent, direct write, and deliberately
does not sync changes back if a job is rescheduled — both real,
named, and pinned for later, not oversights.

## Bulk CSV import

**Real, reachable by UI, genuinely new tonight.** Customers and
historical invoices (with real, correctly reconciled payment history)
can be bulk-imported from a real Invoice Simple export, with
genuinely still-outstanding invoices held via the same guard()
mechanism rather than silently trusted. A real, known and pinned issue
exists: imported invoices with originally zero tax get VAT
incorrectly recalculated on their generated PDF — named and
deliberately not yet fixed, reasoning recorded in `DECISIONS.md`.

---

## The honest, cross-cutting pattern across all of the above

The backend is genuinely, substantially deeper than five rooms would
suggest — leads, projects, snags, full financial reporting, supplier
procurement, all real and working. But the large majority of that real
depth has no visible, tappable surface anywhere in the app. It exists
entirely behind a spoken question, and only answers correctly if the
right words are used. That is very likely the actual, primary source
of tonight's frustration: not missing capability, but real capability
with no discoverable path to it, and no way for a person — especially
a new one — to know what's safe to ask for versus what genuinely
doesn't exist yet.

## What this document does not settle

- Whether extraction reliably classifies real, live phrasing correctly
  for each of the intents and query scopes listed above — that can
  only be confirmed by real, repeated, live testing, not by reading
  code.
- Which of the voice-only capabilities above are worth a real, visible
  UI surface, and which are fine staying voice-only.
- Installer pay and job completion status as a real, new domain to
  design and build — named here as a confirmed gap, not scoped yet.
