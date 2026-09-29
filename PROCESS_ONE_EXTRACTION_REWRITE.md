# processOneExtraction Rewrite — A Real, Staged Plan, Not a Blank-Page Rewrite

Pinned the same way `WHATSAPP_CHANNEL_ARCHITECTURE.md`, `ONBOARDING_JOURNEY.md`,
`SELF_HELP_ARCHITECTURE.md`, and `CONVERSATIONAL_BI_ARCHITECTURE.md` were — a
real design, captured deliberately before any of it gets built, so the next
session starts from a genuine plan rather than a blank page or a rushed
extraction at the tail end of an already long one.

## The real problem, grounded in evidence already found tonight

`processOneExtraction` is roughly 1,746 lines (`index.ts`, currently around
182–1928), and it is not a grab-bag the way the 120 `/debug` routes were —
it is a genuine two-pass pipeline with real, implicit shared state: an
earlier pass (roughly lines 239–1483) does the actual recording work for
each of the ~30 real intent branches, and a separate, later pass (roughly
1490–1646 and beyond) re-checks the same intents again to build the
human-readable response text, reading whatever the first pass just
recorded.

This is not a hypothetical risk. **It already produced a real bug found
earlier tonight:** `FINANCIAL_WRITE_INTENTS`, the array gating which
intents require `can_manage_invoices` *at creation*, was missing five real
entries (`supplier_invoice`, `supplier_payment`, `goods_received`,
`purchase_order`, `variance_disposition`) — despite all five already being
correctly gated at *confirmation* time by `auth.ts`'s
`ACTION_TYPE_CAPABILITY`. Two lists, meant to agree, maintained
independently, drifted. That is exactly the class of mistake a function
this size and shape makes easy, and exactly what a real, structural fix
needs to close off — not just this one instance of it.

## Why this is not `debug.ts` again

`debug.ts`'s 119 routes were independent entry points — no shared state,
no dependency between one route and another. Extracting them was
mechanical: find the real boundary, move the code, verify nothing else
referenced it.

`processOneExtraction` is a pipeline with real, invisible dependencies
between its two passes. Extracting an intent group without first proving
exactly which variables its message-building pass reads, and where each
one is actually set, risks a silent bug — the wrong value, a stale one
from a different intent's branch — that would not fail a typecheck or a
smoke test. It would just produce a plausible-sounding wrong answer,
which is worse than a visible failure. This is why the two external
reviews consulted on this, and my own read, all converged on the same
conclusion: no grouped-intent extraction until the pipeline's real
internal contract is made explicit first.

## The real target shape

```
worker/src/
├── index.ts                    (HTTP handler, route dispatch only)
├── auth.ts                     (session, roles, capabilities — already real)
├── debug.ts                    (debug routes — already real)
├── intents/
│   ├── dispatcher.ts           (resolves shared state once, one upfront
│   │                            capability check, dispatches by intent)
│   ├── result.ts               (ProcessingResult — the real contract
│   │                            between the recording pass and the
│   │                            response-building pass)
│   ├── resolver.ts             (resolveExtraction — customer/character
│   │                            resolution, capability resolution; the
│   │                            genuinely self-contained preamble)
│   ├── handlers/
│   │   ├── payments.ts         (payment, expense, supplier_payment)
│   │   ├── financial.ts        (invoice, quotation, convert_quote, price_scope)
│   │   ├── procurement.ts      (purchase_order, goods_received,
│   │   │                        supplier_invoice, variance_disposition)
│   │   ├── jobs.ts             (work_observation, snags, leads)
│   │   ├── memory.ts           (lookups, tasks, reminders, forget_last)
│   │   └── identity.ts         (customer/character facts, identity_collision)
│   └── tests/
│       ├── matrix.test.js      (the real equivalence matrix)
│       └── <one per handler group>
```

`index.ts` becomes a real, thin HTTP handler — route dispatch, content
negotiation (text vs. audio vs. upload), response serialization. Nothing
about *what a payment means* lives there anymore.

## The real contract: `ProcessingResult`

Every intent handler takes the same resolved, explicit input
(`ResolvedExtraction` — everything `resolveExtraction` computed once) and
returns the same explicit output (`ProcessingResult` — what was recorded,
what the user sees, what side effects happened). No handler reads a
variable some other branch happened to set earlier in a shared scope.

This is the one idea in the whole proposal that would have structurally
prevented the real bug this document opened with — a single,
per-intent-type table (`canExecute`), checked once per intent before any
handler runs, rather than a standalone array someone has to remember to
keep in sync by hand.

## The real answer to the open gap — a single source of truth

A single, real map — `INTENT_CAPABILITIES: Record<string, { creation?:
string; confirm?: string }>` — with both `canExecute` (creation-time) and
`ACTION_TYPE_CAPABILITY` (confirmation-time) *derived* from it, rather
than maintained as two separate lists. This is the concrete fix for the
gap named above, not just a plan to be careful a second time.

**The real assertion needs to be stronger than "both are defined,"
though.** Two intents could each have `creation` and `confirm` set to
*different* capabilities and still pass a check that only asks whether
both exist — which would be just as real a bug as the original omission,
just a mismatch instead of a gap. The real test: wherever both fields
apply to the same intent, they must be the *same* capability, not merely
both present.

**Where this single source of truth actually lives is a real, open
decision, not assumed here.** `ACTION_TYPE_CAPABILITY` already lives in
`auth.ts`; `canExecute` would live in `intents/dispatcher.ts`. Locating
`INTENT_CAPABILITIES` in `auth.ts` keeps the import direction clean —
`intents/` importing from `auth.ts` matches how `debug.ts` already does
tonight, with no circularity risk. A third, new location is possible but
adds a file and a decision this document doesn't make.

## The real, honest first step of the eventual build — not glossed over

The example handler shown during this design pass (a clean `payment`
handler) is illustrative, not a faithful transcription of the real,
current logic — the actual code also handles `pendingCandidates`,
`pendingActionType`, and follow-up context in ways the example didn't
cover. Before trusting that `ProcessingResult`'s shape is genuinely
sufficient, the real first step is tracing the actual two-pass structure
against it: for every one of the ~30 real intent branches, confirm every
field its real message-building pass reads is actually representable in
the proposed contract. That is real, careful, evidence-gathering work —
the same discipline that found the two-pass structure itself, and the
`getRealTableNames` closure bug during the `debug.ts` extraction, and the
stale-baseline CI failure right after it. It comes before any code moves,
not after.

## The test matrix is real, sized honestly

Intent × role × customer/character resolution × existing-vs-new entity ×
confirmation state × multi-segment message × follow-up conversation ×
success/partial-failure path. Built properly, this is realistically
comparable in size to the handlers themselves — not a line item to add
once the handlers exist, but a real, co-equal piece of the work.

## Migration strategy — strangler fig, not surgery

Scaffold the new `intents/` structure alongside the current, live
`processOneExtraction` — never editing the live function directly during
the build. Copy logic into the new shape deliberately, one handler group
at a time, with each group's own real tests passing before moving to the
next. Only once the full equivalence matrix passes against the new
structure does `index.ts` actually switch to calling it — and the old
function can be deleted only then, not before. This mirrors exactly the
discipline already proven twice tonight (`auth.ts`, `debug.ts`): verify
before moving, verify after, never trust an extraction that hasn't been
tested against the real, current behavior.

## The real, concrete validation work before Phase 1 — not vague

Sized honestly, roughly a session's worth of upfront work, not a "do
this tonight" add-on:

1. **Trace `ProcessingResult` against real intent logic.** Pick 3–4 real
   branches (`payment`, `invoice`, `quotation`, `work_observation`),
   trace their actual Pass 2 logic line by line, catalog every variable
   read that Pass 1 set, and confirm the proposed contract can represent
   all of them. If it can't, `ProcessingResult` gets redesigned before
   anything else proceeds — not patched around after the fact.
2. **Audit the six proposed handler groupings for real cohesion**, not
   assumed from conceptual similarity. Do the intents inside
   `payments.ts` genuinely share the same preamble logic, the same D1
   tables, the same confirmation flow — or does one of them have a
   genuinely separate path that belongs in its own file instead?
3. **Design `INTENT_CAPABILITIES`** as the real single source of truth
   described above, including where it lives and the same-capability
   assertion, before Phase 1 starts.
4. **Write a concrete Phase 1 scaffold example** — what `intents/
   dispatcher.ts` actually looks like on day one (dispatching to the
   still-live `processOneExtraction`, or to stubs that throw "not
   implemented"?), what a stub handler's real signature looks like, and
   explicit, checkable success criteria for each phase (most plainly:
   code compiles, and the full existing test suite still passes) — so
   "ready to move to the next phase" is a real, verifiable statement,
   not a feeling.

## What this document does not settle

- The results of the four validation items above — real, upcoming work,
  not assumed complete here.
- Whether the six proposed handler groupings are the right real
  boundaries — a reasonable starting hypothesis, pending the cohesion
  audit above.
- Timing — this is explicitly not scoped for the same session it was
  designed in. The validation work above is real, substantial work in
  its own right, before any scaffold code gets written.
