> **Status:** proposed. **Verified:** not yet. **Owns:** none.

> Extract: section 1 and the closing recommendation of [the Architecture decision report](ARCHITECTURE_DECISION_REPORT_2026-11-02.md), verbatim. Recovered on 2026-11-07 from the assistant's own saved transcript of the 2026-11-02 session (engine direction and restore), because it had never been committed. Written against repository commit `f469510`. Verbatim, except that one closing sentence about a session token was removed. It is a PROPOSAL: Pierre accepted rebuilding the engine core on a retained platform substrate as the leading direction, subject to clarifications, and the amended proposal followed.

## 1. Verdict: rebuild the engine core on a retained platform substrate

**Recommendation:**
- **Rebuild:** the business-reality model, the capability layer, the interpretation boundary, and the domain code.
- **Retain:** the platform and trust substrate.
- **Where:** a clean engine module in this repository, not a new repository.
- **Confidence:** medium-high on the direction, medium on the shape.

**Why rebuild the core, not evolve it [C]**
- **Money is floating-point.** There are 35 `REAL` columns and no integer minor units.
- **Few relationships are enforced.** The baseline schema declares 2 foreign keys.
- **Payments are never matched to an invoice.** Outstanding is derived oldest-first at read time (`finance.ts:2987`).
- **Parties are role-as-text.** A supplier is a `characters` row with `relationship = "supplier"`.
- **Voiding rewrites history.** The statement sets `amount = 0`.
- **The job concept is split.** `jobs`, `job_scopes` and `projects` overlap, and nothing in the worker writes `jobs`.
- **No labour, ledger or sales-order concept exists.**
- **The code is monolithic.** `finance.ts` has 4,351 lines and 121 exported functions across sales, stock, leads, reports and PDFs. `index.ts` has 4,204 lines, and the app's `main.dart` has 10,290.
- **The catalogue is closed.** There are 31 intents, a 41k-character prompt and a cast, unchecked model output.

**Why keep the substrate [X]**
- **Isolation:** a Durable Object per business, with isolation executed on real Cloudflare.
- **Authorisation:** deny-by-default gates and the held-action lifecycle.
- **Recovery:** the backup path, with 4 restore drills passed after the fix.
- **Verification pipeline:** CI with 8,683 checks on two backends, and the staging rehearsal.
- **Why not a new repository:** it adds nothing a directory boundary can't. It would lose the constitutions, history, CI and the verified pipeline.

## Recommendation, evidence and next task
**Recommendation:** rebuild the engine core on the retained platform substrate, in this repository.

**Evidence:** the model weaknesses in section 1, the closed catalogue and the missing availability and discovery, set against a substrate that is verified on real Cloudflare.

**Next bounded task (needs your approval):** on a new branch, write the slice's acceptance tests first (red), a schema sketch for parties, events, money and allocations, and the operation boundary stub. No engine behaviour yet.
