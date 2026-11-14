> **Status:** real. **Verified:** 2026-11-12. **Owns:** none.

# RESUME: start here after a break (the takeover card; plain language)

**What The Office is:** a business run by talking to it. The engine (branch `engine-phase1`) is the new, correct core: it holds the truth, the permissions and the money, and AI only helps read what you said. The old live system on `main` still does the real work and is untouched.

**Where we are (2026-11-12):** `engine-phase1` is about 234 commits ahead of `main` (work since 2026-11-01). **It is not connected to the app, not merged, not live.** The live app builds from `main` and contains none of this.
- **Built, tested in CI and, mostly, proven on a real Cloudflare object:** customers and suppliers, quotations, invoices (from drafts), payments and receivables, credit notes, VAT, expenses, purchasing (orders, goods received, supplier bills, strict three-way match, supplier payments), and stock in five increments (ledger, counts, reservations, the order and sales links, write-downs, valuation as at a date, roll-forward). Also an interface for outside AI assistants (MCP) and a recovery path proven on the test harness.
- **The model as an interpreter:** understands the earlier sentences and the stock sentences. Stock model run 1 FAILED (9 of 14 understood, a negative quantity held), the engine was fixed with Pierre's approval, run 2 PASSED (14 of 14, safety 14 of 14, nothing approved).
- **The board is `docs/CAPABILITY_MAP.md`** (34 rows; boxes E engine, C CI, R real platform, V real model, X explained, A app, M outside assistants). At the last count: E 23, C 23, R 15, V 7, X 18, A 1 (a demo with recorded answers), M 12; 5 rows designed only.
- **Last checks:** umbrella suite 11121 of 11121 (`tools/role-matrix.test.js`), CI green on `16236e3`; stock proof run 3 (43236903582) 43 of 43; stock model run 2 (43296868094) passed. Records are under `ops/*-last.json`.

**Definition of "final form" (my suggestion, Pierre to confirm):** the live app runs one real business on the engine. That needs (1) a design, approved by Pierre, for connecting the app (sign-in, which business, what ships), (2) migrating the real business and merging to `main` (his word each time, after a real-platform recovery rehearsal), (3) the model and app screens for orders, bills, payments and stock, (4) the remaining features. Only 1 and 2 are on the critical path; no date can be promised, they depend on his approvals and on how many sessions he can run per week.

**First 15 minutes of a fresh session (do these in order, report in five lines):**
1. `git config --global user.name` and `user.email` (rebases stall without them). Pierre must give you a GitHub token THIS session; use it only through `http.extraheader`, never print or store it. **He should revoke the token used so far** (it appears in the previous build's logs and transcripts) and issue a new fine-grained one for this repo only (contents and actions: write).
2. `git pull --rebase origin engine-phase1`, then `git log -8 --format='%h %an %s'`. **Read any commit you did not make before acting**: a timeout followed by a retry has produced a second attempt that committed on its own (the stock increment 5 commit: it was reviewed, one design flaw was found and fixed, and it was kept).
3. Check CI on HEAD (the Actions API) and read the newest `ops/*-last.json` records.
4. Run the umbrella detached (`NODE_PATH=worker/node_modules setsid nohup sh -c 'node --no-warnings tools/role-matrix.test.js > /tmp/umbrella.txt 2>&1; echo EXIT $? >> /tmp/umbrella.txt' &`, about 6 minutes); expect 11121 or more, all correct. Typecheck: `(cd worker && npx tsc --noEmit -p .)` filtered to `src/engine`, `auth.ts`, `mcp.ts` (about 43 other errors are the environment's baseline).
5. Ask Pierre ONE question: which next (below).

**Hard rules (from Pierre):** push only to `engine-phase1`; never merge to `main`, never deploy, never touch production; staging runs (`staging.yml` modes, dispatched by hand) ONLY on his explicit word each time; never ask him to paste or expose credentials; a recommendation is not approval; never silently change an architectural decision; tests first, deliberate breakages in `tools/engine-breakage.js`, the map and `HANDOFF.md` updated in the same commit, decisions in `docs/decisions/`; "best practice, researched"; complete what we start.

**Habits that matter (each from a real mistake):**
- Check CI before reporting a push (a type error once went unseen on three pushes). Docs-only pushes do not trigger CI.
- After a timeout or an uncertain git result, NEVER retry: `git status -sb`, `git log`, `git rev-parse HEAD` and `git ls-remote origin engine-phase1` first.
- Run long jobs detached; read results from a file.
- After any scripted edit to a file, check its size (`wc -l`); a line that opens a file for writing before reading it emptied `HANDOFF.md` once, and later edits then failed silently. Assert that an anchor exists before replacing.
- Keep a GitHub workflow `run:` step short: put scripts in `tools/*.py` (a 23,000-character step coincided with GitHub rejecting the whole workflow file; moving the script out fixed it, though I did not prove length was the cause).
- Python's compile check leaves `__pycache__`; it is now in `.gitignore`. Use `PYTHONDONTWRITEBYTECODE=1`.
- A deliberate breakage that "survives" is usually a weak test (or an equivalent mutant): fix the test, never the mutation list to hide it. If the run prints nothing, the runner itself is broken.
- Cloudflare refuses Python's default user agent (error 1010): staging scripts send a curl user agent.

**Needs Pierre's decision (all have defaults; none is blocking):**
- The design for connecting the app to a real business (sign-in, which business, what ships): not started; the single biggest step.
- Per-location stock valuation (option B; today a write-down is of the whole item, damaged units can be counted out as a loss instead).
- Should a reservation lapse when its quote is superseded? Who may reserve (salespeople without the materials capability cannot)? A second approver for a large count variance?
- Should the model be offered `stock.receive` with a cost and an explicit VAT word? Should "yesterday" be allowed for a stock movement?
- Procurement: match tolerance, supplier credit notes and returns, approval limits, costing an accepted price variance onto stock, landed cost, a one-step reorder-to-order.

**Suggested order next (my view, Pierre chooses):** (a) the app-connection design document, for his approval, before any code (APPROVED 2026-11-14: `docs/decisions/app-connection.md`; capture approved too: `docs/decisions/engine-capture.md`; the mode read and the voice route are built; next is widening the app client, then photo and document; a staging proof of voice needs Pierre's word); (b) the model for procurement sentences: BUILT 2026-11-14 on a scripted model (`docs/decisions/interpreter-procurement.md`), the real-model run and its staging mode are next and need Pierre's word; (c) small engine gaps: a route that creates a draft invoice over HTTP (so invoices that name their items can be proven on a real object), quotation and credit-note lines that name items; (d) an app stock screen in the demo.

**Parked on purpose (do not spend tokens until asked):** the pilot business and the migration plan (`docs/decisions/engine-legacy-coexistence-scoping.md`), the table-size guard, the recovery-gate acceptance, FIFO, lots and serials.

**To start a fresh chat, paste this:**
> Continue The Office (repo pierreduplessis6912-gif/the-office, branch engine-phase1). Read docs/RESUME.md (the takeover card), then HANDOFF.md, then docs/CAPABILITY_MAP.md. Do the five first-steps in RESUME.md, tell me in five lines where we are, and ask me which of the suggested next steps to do. I will give you a GitHub token in this chat; never store or print it. Keep replies short.

Detail lives in `HANDOFF.md` (the newest notes sit just above its "How to run things" section) and in `docs/decisions/` (`inventory.md`, `interpreter-stock.md`, `purchase-orders.md`, `supplier-invoices.md` and the others).
- Step (c) done (2026-11-14). Next in order: photo and document capture (docs/decisions/engine-capture.md). Staging proof of voice, real-model procurement run: only on Pierre's explicit word. Credit-note item naming waits for his decision.
- Photo and document capture slice 1 done. Next: bill/receipt photo to a held proposal (own design first), staging proof of voice and photo, real-model runs: only on Pierre's explicit word.
- Receipt photo to held expense done (slice 2). Next candidates: supplier bill with lines (own design), staging proof of voice and photo, real-model runs: only on Pierre's explicit word.
- Supplier bill photo to held supplier invoice done (slice 3). Next candidates: link a bill to its order, staging proof of voice/photo, real-model runs (each only on Pierre's explicit word), app capture buttons.
- Bill-to-order link and app photo/receipt/bill capture client done. Remaining from "do all 3": staging proof of capture (needs a staging mode and Pierre dispatching it by hand: the sandbox cannot dispatch workflows).
- "Do all 3" finished except the dispatch: run staging mode capture-proof by hand (Actions, staging, mode capture-proof) and read ops/staging-capture-proof-last.json when it lands.
