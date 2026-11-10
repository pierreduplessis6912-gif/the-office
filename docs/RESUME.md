> **Status:** real. **Verified:** 2026-11-09. **Owns:** none.

# RESUME: start here after a break (one screen, plain language)

**What The Office is:** a business run by talking to it. The engine (branch `engine-phase1`) is the new, correct core: it holds the truth, the permissions and the money, and AI only helps read what you said. The old live system on `main` still does the real work and is untouched.

**Where we are (2026-11-09):** the engine's foundation is built and proven (tests, plus real tests on staging). One small scenario works end to end in the engine, "What does Mokoena owe me?" then "Record R500", with a demo you can open. **It is not connected to the app, not merged, not live.** Nothing a customer uses has changed yet.

**Built since (2026-11-09):** customers and suppliers (create, edit, find) are in the engine and CI-tested, with no schema change; `docs/decisions/customers-suppliers.md` has the defaults. It waits on Pierre's word for a staging proof, then the model and the app.

**Built since (2026-11-10, second capability):** quotations (create, revise, accept, find) are in the engine and CI-tested, no schema change; `docs/decisions/quotations.md` has the defaults. Pierre approved the defaults, and the staging proof passed 14 of 14 on a real object.

**Built since (2026-11-10, third capability):** credit notes (issue) are in the engine and CI-tested, no schema change; Pierre delegated the accounting choices to "best practice" (not accountant-reviewed); `docs/decisions/credit-notes.md` has them. It waits on his word for a staging proof.

**Plan (2026-11-10):** complete the stack for what is built before adding rows: see `docs/STACK_COMPLETION.md`. The staging mode `stack-proof` is written and waits for Pierre's word to run.

**The one thing that matters next (Pierre's priority, 2026-11-09): the VISION, with ALL capabilities tested and wired into the final product eventually.** `docs/CAPABILITY_MAP.md` is the board: every capability, how far it has got (engine, CI, real platform, conversation, explained, app, outside assistants), and what "done" means. Work goes down that list one capability at a time, each to the same standard. The pilot and the look of the app are NOT the priority.

**Only ONE decision is needed from Pierre to keep moving, and it has a default:** the order of capabilities in the map (default: customers and suppliers, quotations, invoices in full, payments and expenses, purchasing, stock, jobs, reports, then the reach channels). Connecting the engine to the real app is approved separately when the first widened capability is ready.

**Defaults the build chat may take without asking:** tests, docs, small code on `engine-phase1`, CI. **Always ask first:** merging to `main`, anything on production or staging, any token, money or customer data.

**Parked on purpose (do not spend tokens on these until asked):** the pilot business and the migration plan (`engine-legacy-coexistence-scoping.md`), the table-size guard, the recovery-gate acceptance, the shell's question history.

**To start a fresh chat, paste this:**
> Continue The Office (repo pierreduplessis6912-gif/the-office, branch engine-phase1). Read docs/RESUME.md, then HANDOFF.md. Read docs/CAPABILITY_MAP.md, tell me in five lines where we are, and do the next capability on its list. Keep replies short.

Detail lives in `HANDOFF.md` and part D of `docs/decisions/first-slice.md`; this card is only the short version.
