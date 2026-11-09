> **Status:** proposed. **Verified:** not yet. **Owns:** none.

# DECISIONS: engine-legacy-coexistence-scoping

Written 2026-11-09 by the build chat at Pierre's request to carry on ("there is still a lot to do"). A SCOPE FOR REVIEW: it authorises nothing and no code. It answers the biggest gap in the roadmap that has no plan: how a real business gets from the live legacy system to the engine, and what the engine must be able to do first. Evidence labels: [C] code read, [T] test, [D] documentation, [I] inference, [U] unknown.

## Where things stand today
- **Exclusive per-business mode [C, T].** A business is an ENGINE business or a LEGACY one, stored once (`eng_config` key `mode`; absent means legacy), and the two never write the same business's records (`worker/src/engine/boundary.ts`, `tools/engine-boundary.test.js`). Every route is classified (legacy business writes are refused in an engine business and `/engine/*` is refused in a legacy one); the held-action lifecycle is shared and decided by the action's type; the MCP tool list depends on the mode; platform writes (team, settings, billing, onboarding) work in both. This already implements the decision "no two competing engines or sources of truth" [D].
- **No way for a real business to become an engine business [C].** The only route in is the staging-only `provision-sample` admin route. There is no migration from legacy data, no engine onboarding, and the app's own screens call legacy routes (the engine shell is a separate demo entry point, unconnected).
- **The engine can do five things [C].** Read receivables, read a record, record a payment, correct a payment, issue an invoice. Everything else a business does is absent.
- **The live system holds the real functionality [D].** Legacy tables for customers, quotations, invoices and lines, payments, expenses, purchase orders and goods received, supplier invoices and payments, stock items, usage and stocktakes, jobs, projects and scopes, leads, snags, tasks, products and people (`worker/migrations/0001_baseline.sql`), with the accuracy and structure problems the 31 October audit listed (for example figures that disagree between a PDF and the ledger, and customer-level balances).

## What the engine would need before it can run a real business [I]
| Legacy area | Engine today | Gap |
|---|---|---|
| Customers and suppliers | Parties with roles [T] | A capability to create and edit them; a way to import them |
| Quotations | Document kind (configuration) [T, fit walk] | A capability (create, revise, accept) |
| Invoices | `invoice.issue` [T] | Numbering continuity from the legacy sequence; tax and PDF output (exports are listed unavailable [C]) |
| Payments and allocations | `payment.record`, `payment.correct` [T] | Legacy payments carry no allocation records, so an import must derive them |
| Expenses | Document kind and money out [fit walk] | A capability |
| Purchase orders, goods received, supplier invoices and payments | Walked on paper and in the fit test [T] | Capabilities for each; variance handling |
| Stock | Walked in the fit-domains test [T] | A capability and a stock model |
| Jobs, projects, scopes, snags, tasks, leads | Jobs and field work walked [T]; snags, tasks and leads not | Capabilities; the shapes are test shapes, not designs |
| Products and price lists | Walked (inventory) [T] | A capability |
| Conversation | A model route exists behind the engine [T, one staging run] | Wiring it to the app; the app's own interpretation is scripted |
This is a long list: the engine proves the foundation, not the business. I cannot size it honestly [U].

## Options for getting a real business onto the engine
| Option | What it is | For | Against |
|---|---|---|---|
| A. New businesses only | New sign-ups are engine businesses; existing businesses stay on legacy until retired | No migration risk to existing customers | New customers meet an engine that cannot yet do what a business needs; legacy stays alive indefinitely |
| B. Migrate per business (recommended) | An import tool reads one legacy business and writes engine facts, with a reconciliation report, then flips that business's mode; legacy tables stay read-only for a rollback window | One business at a time, checked against its own history; fits the exclusive-mode boundary already built | The import is real work (see below); a bad import must be caught by the report, not found by the customer |
| C. Strangle by capability inside one business | The engine serves some capabilities for a business that is still legacy for the rest | Gradual | Breaks "no two sources of truth" and the boundary tests: two writers of one business. Rejected |

## What option B's import would need (sketch, not started)
- **Provenance.** Every imported fact is an engine event with a contract such as `legacy-import`, the legacy table and row id, and a reason, so history shows where it came from and the append-only rules hold [I].
- **Reconciliation, not hiding.** The audit found the legacy figures disagree with themselves in places; the import must produce a per-customer comparison (legacy total against engine total) and list every difference, and the business is flipped only when the owner has seen it [I].
- **Allocation.** Legacy payments are not allocated to invoices; the import derives allocations oldest-first and flags them as ASSUMED, as the approval card flags the same assumption today [I].
- **Numbering, tax, currency** carried over so no document number repeats or skips.
- **Atomic and reversible.** Snapshot first; the mode flip is the LAST write after verification; the legacy tables are retained read-only for a window so a rollback is a restore plus a mode reset [I]. The table-size limit (`docs/decisions/snapshot-size-scoping.md`) applies to a large legacy business.

## Proposed order of work (each step a vertical slice proven in CI and, where it matters, on staging, as the Mokoena slice was)
1. **Agree the smallest business the engine must run for a first real customer** (the "v1 parity set"); my guess is parties, quotations, invoices, payments, expenses [I].
2. **Widen the engine capability by capability** to that set, each with its backend test, its staging proof and its shell screen.
3. **Wire the model route and the real client to the app** (needs Pierre's approval to connect), so a conversation reaches the engine.
4. **Build the import and its reconciliation report** and run it on a staging copy of real-looking data.
5. **Pilot on one willing business with its own history**: the natural candidate is Pierre's own flooring business, because he can judge the reconciliation himself.
6. Only then decide whether new sign-ups default to the engine, and plan retiring legacy capability by capability.

## Questions for Pierre
1. Is option B (migrate per business, pilot first) the right shape, or do you want A?
2. What is the smallest business the engine must run for a first customer (the v1 parity set)?
3. Is your own business the right pilot, and when would you be ready to look at a reconciliation report?
4. How much difference between legacy and engine totals would you accept in a report before you would refuse the flip, and who decides?
