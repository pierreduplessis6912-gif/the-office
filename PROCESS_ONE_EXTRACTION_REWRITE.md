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


---

# Validation results (2026-10-02) — the four steps, done against the real code

Method, so it can be re-run rather than trusted: `index.ts` parsed with the TypeScript compiler API (`typescript` is already in `worker/`), `processOneExtraction` located by name (L182–1925 at the time), every function-scope variable catalogued, Pass 1 = statements before `let message`, Pass 2 = the `if/else if` chain from `let message` onward. Capability tables were loaded from the real, compiled `auth.ts`, not retyped. Items marked **(by reading)** were traced in source but not reproduced against the running system.

## Step 1 — does `ProcessingResult` fit? Mostly, but not as first proposed

**What the evidence shows.** 45 function-scope variables are set in Pass 1; 33 are read by Pass 2. About 28 of those are *private to one intent*: written by exactly one block, read only by that intent's Pass 2 branches (e.g. `goodsReceivedNoOpenPo`, `stocktakeResult`, `leadLostNoMatch`). Those map cleanly onto a per-intent outcome. The genuinely shared state is small and nameable:

| Variable | Writers in Pass 1 | Note |
|---|---|---|
| `pendingActionId` / `pendingActionType` | 10 | Mutually exclusive by `intent` guard (payment, expense, supplier_payment, goods_received, supplier_invoice, variance_disposition, invoice, quotation/price_scope, convert_quote, work_observation), so a single `held: {id, type} \| null` is representable. |
| `customer` / `character` | 2 each | Preamble, plus the lookup backward-reference fallback (L510–543). |
| `workObservationResult` | 2 | Written by both the `invoice` branch and the `work_observation` branch. |
| `snagNoCustomer` | 2 | Shared flag across raise_snag and resolve_snag. |
| `factPendingActionId` | 2 | customer_fact and character_fact holds. |

**Four findings that change the contract:**

1. **An outcome is not one-of-N.** An `invoice` call can hold an invoice *and* record a job scope in the same invocation; Pass 2 handles this by appending to the catch-all branch (the 2026-08-09 fix). `ProcessingResult` therefore needs a held action *and* a list of recorded effects, not a single discriminated outcome.
2. **Pass 1 returns early from 10 places**, each hand-building the same 8-field object (L253, 317, 335, 378, 410, 440, 609, 628, 1065, 1298), plus the final return. The contract needs an explicit "short-circuit" result kind, not just a fall-through value.
3. **Pass 2 branch #37 (`else if (pendingActionId)`) is an unguarded catch-all** whose default label is `"Payment"`: the `payment` intent has *no branch of its own* and works only by falling into it. Moving or reordering branches silently changes payment messages. It also dereferences `customer!.name`. Today this is safe only because every intent that reaches it has a customer, a guarantee enforced by convention, not by types.
4. **Side effects Pass 2 cannot see.** The `price_scope` fallback records a job scope but surfaces only its id (`jobScopeIdForPricing`), so the message never mentions it. `ProcessingResult` needs an explicit effects list so a message builder *can* say what was recorded.

**Possible bug, by reading — not reproduced.** In the `invoice` branch (L1020–1086) the held invoice is created first (`pendingActionId = held.id`), and the amendment early-return can then fire (L1065), returning `amendment.pendingActionId` and an amendment-only message. Conditions: intent `invoice`, an amount, an observation with no components or tasks but a date or installer, and an existing job scope for that customer. In that case the invoice hold exists in `pending_actions` (visible in the Pending ember) but the response never mentions it and its id is replaced. Worth reproducing with a real dictation before any extraction work, and worth a regression test either way.

## Step 2 — handler grouping: three of six groups do not cohere as drawn

- **`procurement.ts` holds up.** `goods_received` and `supplier_invoice` are structurally near-identical (character → latest open PO → AI extraction → hold → supplier-name flag). Caveats: `purchase_order` is a *direct write*, not a hold; `variance_disposition` mixes a direct write (reason) with a hold (credit).
- **`payments.ts` mostly holds up** (one hold each, no recording), with the catch-all coupling noted above for `payment`.
- **`financial.ts` and `jobs.ts` do not hold as separate groups.** `invoice`, `price_scope` (fallback) and `work_observation` all contain their own copy of "extract observation → record it → maybe price it", with three different behaviours: `invoice` reconciles the installer and runs the amendment check; the `price_scope` fallback does neither; `work_observation` does both plus attach-to-sibling-scope plus inline pricing gated on `can_manage_invoices`. The comments say "mirrors exactly"; the code does not. They need a shared sub-module (`intents/observation.ts`), and its three variants' differences must be preserved by an equivalence test or changed *deliberately and visibly*, never as a side effect of a refactor.
- **`jobs.ts` as drawn mixes unlike things.** Snags and leads are simple direct writes and cohere with each other; `work_observation` is the entangled one.
- **Gaps in the plan's six groups.** `register_stock_item`, `stock_usage` and `stocktake` have no home. `lookup` is 236 lines (L1646–1882, about 13% of the function) with its own read-side capability regime and 10+ inline checks; it is not a "memory" handler. `supplier_statement` is a valid classifier output but is referenced only on the upload path (index.ts ~4810/4941), not in `processOneExtraction`, so a *spoken* one matches no branch (what message it falls to was not traced). Real count: 26 values in the `intent` union, 24 handled explicitly, not "~30".

## Step 3 — `INTENT_CAPABILITIES`: the proposed shape is not enough

Evidence from the real tables (matrix computed from compiled `auth.ts` plus the real `FINANCIAL_WRITE_INTENTS`):

1. **The creation gate is a denylist; REST is default-deny.** An intent not on `FINANCIAL_WRITE_INTENTS` is open by default. This is the structural root of the five-entry drift, not a one-off slip. Six intents that write directly are open today (`register_stock_item`, `stock_usage`, `stocktake`, `raise_snag`, `resolve_snag`, `raise_lead`); some of that is surely intentional, but nothing distinguishes "deliberately open" from "forgotten".
2. **`purchase_order` is a direct write with no held action, so it has no confirm-time gate at all.** The creation gate is its *only* gate. The earlier note that all five widened intents were "already gated on confirm" is wrong for it; the widening was load-bearing for `purchase_order`, not belt-and-braces.
3. **Intent is not action type.** `price_scope` produces `invoice` *or* `quotation`; `work_observation` can produce a nested `quotation` and a `job_scope_amendment`; `invoice` can produce `job_scope_amendment`. A table keyed by intent cannot simply *derive* `ACTION_TYPE_CAPABILITY` (keyed by action type).
4. **"Same capability" is the wrong assertion.** Confirm-time entries are any-of lists (`goods_received`: `can_manage_invoices` or `can_know_materials`); creation is a single capability. A strict equality check would either fail legitimately or force them identical.
5. **One upfront check cannot express nested gating.** `work_observation` is deliberately *not* on the list (a measurement records regardless of role) but its nested quotation is gated inline (L1332). Handlers need a `canCreate(actionType)` function, not only a pre-dispatch yes/no.
6. **Real create-vs-confirm disagreements today** (installer = `can_know_jobs`, `can_know_measurements`, `can_capture_voice_notes`, `can_know_materials`):
   - `goods_received`: installer may *confirm* (via `can_know_materials`) but may not *dictate* it. `auth.ts` says "Installers receive deliveries on site." Photo/document uploads are open to every member and are not gated by this list, so the same action is creatable by an installer through one channel and refused through another.
   - `invoice`: an installer's scheduling message that the classifier labels `invoice` is refused outright, though the branch's non-financial output (`job_scope_amendment`) is something installers may confirm.
   - `work_observation`: an accountant may create it (and its amendment hold) but can never confirm a `job_scope_amendment` (needs `can_know_jobs`).
7. **Two incompatible philosophies are in force.** `auth.ts`: "creating a held action is harmless", which is why uploads are open. `index.ts`: gate at creation so a "misleading held action" never exists. Both cannot be the rule. This is a decision for Pierre, not a refactor detail.
8. **Authorization runs after side effects.** The preamble calls `reconcileCustomer` (`INSERT INTO customers`) and can create `identity_collision` / `ambiguous_person` holds, and writes `setSelection` / `updateCaptureHint`, all *before* the capability gate at L608. A restricted role dictating a financial message about an unknown name gets a customer row created, then a refusal. Moving the check upfront fixes this, but it is a **behaviour change**, so it must be done and recorded as one, separately from the structural move.
9. **The creation gate has zero test coverage.** `tools/role-matrix.test.js` compiles `auth.ts` only and exercises `authorizeRestrictedMember`; `FINANCIAL_WRITE_INTENTS` lives in `index.ts`. The 165/165 test passed throughout the period when five intents were missing. The one concrete placement argument that matters: putting the rules in `auth.ts` puts creation-time gating inside the existing test harness for free.
10. **Read-side gating is a third regime** (lookup, 10+ inline `can_know_*` checks) and should stay out of `INTENT_CAPABILITIES`; list it as its own audit surface.

**Revised design.**

```ts
// auth.ts — default-deny, every intent listed, "open" must be explicit
type Gate = { create: string[] | "open"; confirm?: ActionType[] };   // create = any-of
export const INTENT_RULES: Record<Intent, {
  produces: ActionType[];            // held types it may create; [] = direct write
  create: string[] | "open";         // any-of capabilities, or deliberately open
  reason?: string;                   // REQUIRED whenever create !== the confirm caps of what it produces
}>;
// derived, never hand-edited: creationGate(intent), and a check against ACTION_TYPE_CAPABILITY
```

Assertions (all runnable in `role-matrix.test.js`, since the data lives in `auth.ts`): (a) every member of the `Intent` union has a row (no silent omission); (b) every `produces` type exists in `ACTION_TYPE_CAPABILITY` or is declared owner-only; (c) any role that can *create* an intent but can *never confirm* anything it produces must carry a `reason`; (d) any role that can confirm but not create must carry a `reason`. This forces each current disagreement above to be a recorded decision rather than an accident.

## Step 4 — concrete Phase 1 scaffold, with checkable criteria

**Phase 0 (first, standalone, no extraction).** Build `INTENT_RULES` in `auth.ts`, make `index.ts` read its creation gate from it with *identical current behaviour* (reproduce the 11-intent list plus `lose_lead` exactly), and extend `role-matrix.test.js` with assertions (a)–(d). *Done when:* typecheck baseline unchanged; 165 existing cases plus the new ones pass; a test proves the derived creation gate equals today's hard-coded list for all 26 intents. Any of items 6–8 above are separate, later, labelled behaviour changes.

**Phase 1 (scaffold, nothing moves).** `intents/result.ts` (revised `ProcessingResult`: `held`, `factHeld`, `recorded[]`, `outcome`, `ui`, `message`, plus a `shortCircuit` kind for the 10 early returns), `intents/dispatcher.ts` that on day one is an adapter calling the *live* `processOneExtraction` and mapping its 8-field return into `ProcessingResult`. Stub handlers throw "not implemented" and are not reachable. *Done when:* compiles; nothing in `index.ts` calls the scaffold; the adapter round-trips the real return shape losslessly.

**Phase 2 (shadow mode, before any handler is real).** Run old and new side by side on the same input with the AI calls stubbed, compare results, log divergences, serve the old result. This builds the equivalence matrix from real behaviour. *Done when:* the matrix covers every one of the 24 handled intents across all three roles, with the three observation-recording variants characterised as they actually behave today.

**Extraction order, lowest entanglement first:** procurement, then payments, then snags/leads/stock, then the shared `observation.ts` and the invoice/price_scope/work_observation trio, then lookup. Each phase ends with its own tests green and a live check, per the existing strangler discipline.

## Open decisions for Pierre (cannot be settled by code)

1. May an installer *dictate* goods received (matching what they may confirm and what uploads already allow), or must it stay owner/accountant-only?
2. Which philosophy is the rule: held actions are harmless to create, or creation must be gated? (Determines whether upload paths should be gated.)
3. Approve moving the capability check ahead of `reconcileCustomer`, accepting it as a recorded behaviour change.
4. Should an installer's scheduling message labelled `invoice` still be refused outright?


### Addendum (same day) — correction to Step 3, items 6 and 7: the upload path is looser than described

Traced after the fact, in `POST /files/document` (index.ts ~4800–4860), by reading. The earlier text said only that uploads are "not gated by this list". More precisely:

- An uploaded supplier document can create a **held `supplier_invoice`** for *any* member, installer included. That is exactly the "misleading held action" the dictation-time gate exists to prevent, so the creation gate is not a real boundary today; it applies to one channel only.
- An uploaded delivery note (no real prices) is **recorded directly** as a goods-received note via `recordGoodsReceived`, with no hold and no confirmation, again for any member.
- So for goods received, dictation is the *stricter* channel (hold plus confirm, and refused outright for installers), while upload is a direct, unconfirmed write open to everyone. Refusing installers on dictation alone protects nothing the upload path does not already allow.
- This reframes decision 2. Held actions are inert until confirmed, which is the coherent reading of `auth.ts`'s "creating a held action is harmless". The real exposure is **direct writes**: uploaded GRNs, and dictated `purchase_order` (whose creation gate is its only gate). A consistent rule is likelier to be "gate creation of direct writes that move money or stock; held actions may stay open", rather than "gate everything at creation", which would also block installers photographing delivery notes.


### Status update (2026-10-03): Phase 0 is done and deployed

`INTENT_RULES` now lives in `auth.ts` (exhaustive by type and by test), `index.ts` reads its creation gate from it, the check runs before name resolution, goods received is open to installers, and money and stock are the gated domains. Role-matrix test: 386 checks, including equivalence with the old logic, mutation-checked. Full account under "Phase 0 of the processOneExtraction work" in `DECISIONS.md`. The four open decisions above are answered (1 yes, 2 money and stock only, 3 yes, 4 set aside). Phase 1 (the `ProcessingResult` scaffold) has not been started; the upload path still needs to adopt the same table.


### Status update (2026-10-03, later): Phase 1 is done and deployed

`worker/src/intents/result.ts` (the contract and lossless adapters) and `dispatcher.ts` (the input and handler types, the legacy adapter, and `INTENT_GROUP`) exist, are typechecked (the typecheck now covers subfolders), and are covered by a test file run from the existing CI step. Nothing calls them; the live function is untouched. Measured on the current code: 1,756 lines (183 to 1938), 10 return sites, a 9-field result, and the pending-field rules recorded in `DECISIONS.md` under "Rewrite Phase 1".

**Phase 2 (next): the characterization harness, before any handler is real.** Make the live function runnable under test (it is not exported), drive it with scripted model replies and a database stand-in, and record what it returns and what it writes, intent by intent, as the equivalence matrix the new handlers must later reproduce. Start with the group that has the least shared state (payments). Open decision for Pierre: tests against a real database need `node:sqlite`, which CI's Node 20 lacks; either raise the pipeline's Node version to 22 or accept that those characterization tests run locally only and that CI runs a statement-recording stand-in.

### Status update (2026-10-03, later still): Phase 2 has started

The characterization harness exists and runs in CI on Node 22. Recorded: the payments group and `convert_quote` (29 cases). It found and fixed a real leak (see "Rewrite Phase 2" in `DECISIONS.md`). **Next:** record the groups that need a scripted model (procurement, then invoicing and pricing, observations, lookups), then stock, snags and leads, and the identity holds. Only when a group is fully recorded does it become a candidate for Phase 3 (the first real handler, reproducing its recording exactly).

**Open questions** for this work and the surrounding product are kept in one place: `OPEN_QUESTIONS.md` at the repository root. Read it before starting any phase.

### Status update (2026-10-04, end of Phase 2)

Phase 2 is complete for everything that matters: the function (about 260 cases), its caller (19), the confirm and reject routes (51) and the upload handlers (50) are recorded, through the real request handler and the real auth gate where a route is involved. It found and fixed roughly twenty real defects along the way (see `DECISIONS.md`). **Phase 3, the first real handler, is ready to start.** Recommended first move: the 131-line supplier-document decision section that exists twice, identically, in the document and photo upload handlers, because it is fully recorded, duplicated, and self-contained. The recordings are its specification: the new function must reproduce all 50 upload cases exactly, and the document-versus-photo pairs must keep passing.

### Status update (2026-10-04): Phase 3 has begun

Phases 0, 1 and 2 are done (the permission table; the result shape as scaffolding; and the characterization harness, now **751 recorded cases and 4,585 checks**). **Phase 3, step 1 is done:** the supplier-document decision that existed twice in `index.ts` is one function in `worker/src/intents/supplier-document.ts`, with no recorded behaviour changed (see `DECISIONS.md`, "Rewrite Phase 3, step 1"). `index.ts` is 5,928 lines, down from 6,297.

**What the detour did to the target.** Between the Phase 1 measurement and now, `processOneExtraction` grew from 1,756 to **2,235 lines** (about 27%), because every feature added went into it (order cancel, reopen and link, supplier statements, unit conversions, the scheduling continuation, open orders). It still has 10 return points. **Decision: no new features until the next intent group has been extracted;** fixes for what the phone tests find only.

**Next:** step 1b (48 duplicated lines left between the two upload handlers), then the first intent group out of `processOneExtraction` (candidate: the order-management intents, the newest and most self-contained), chosen after reading the code and showing the exact lines first.

**Step 1b is done (2026-10-04):** the caption logic is one function in `worker/src/intents/upload-caption.ts`. The document handler is 97 lines and the photo handler 56; `index.ts` is 5,852 lines. What remains between them is deliberate (the idempotency start, in four routes; and the different ways a document and a photo are read). **Next: step 2, the first intent group out of `processOneExtraction`.**

**Step 2 is done (2026-10-04):** order management (cancel, reopen, link, a supplier's statement, a unit conversion) is one module, `worker/src/intents/order-admin.ts`. `processOneExtraction` is **2,039 lines** (from 2,235; it had been 1,756 at the Phase 1 measurement), `index.ts` 5,657. Not one recording changed. **Next:** the opening step's find-only lists become a table beside `INTENT_RULES`, then the next intent group; candidates by cohesion are the stock intents (register, usage, stocktake) and snags and leads, both small and well recorded (59 and 28 cases).

**Step 3 is done (2026-10-04):** the opening step's two find-only conditions are one table beside `INTENT_RULES` (`INTENTS_THAT_ONLY_FIND_CUSTOMERS` and `..._CHARACTERS`, differing by exactly `purchase_order`). No recording changed. **Next:** the next intent group; candidates by cohesion are the stock intents (register, usage, stocktake; 59 recorded cases) and snags and leads (28).

**Step 4 is done (2026-10-04):** stock (register, usage, stocktake) is `worker/src/intents/stock.ts`. `processOneExtraction` is **1,954 lines**, `index.ts` 5,575; no recording changed. **Next:** snags and leads (raise and resolve a snag, raise and lose a lead).

