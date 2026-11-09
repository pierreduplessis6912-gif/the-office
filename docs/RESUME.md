> **Status:** real. **Verified:** 2026-11-09. **Owns:** none.

# RESUME: start here after a break (one screen, plain language)

**What The Office is:** a business run by talking to it. The engine (branch `engine-phase1`) is the new, correct core: it holds the truth, the permissions and the money, and AI only helps read what you said. The old live system on `main` still does the real work and is untouched.

**Where we are (2026-11-09):** the engine's foundation is built and proven (tests, plus real tests on staging). One small scenario works end to end in the engine, "What does Mokoena owe me?" then "Record R500", with a demo you can open. **It is not connected to the app, not merged, not live.** Nothing a customer uses has changed yet.

**The one thing that matters next:** make the engine run a real business. That means widening what it can do (customers, quotes, invoices, payments, expenses), connecting it to the app, and moving ONE business onto it as a pilot (the plan is in `docs/decisions/engine-legacy-coexistence-scoping.md`).

**Only three decisions are ever needed from Pierre to keep moving; everything else has a default:**
1. Go with the plan "migrate one business at a time, pilot first" (the default if not said otherwise)?
2. Approve connecting the engine to the app on staging (first time it touches anything real; asks nothing of production).
3. Which business is the pilot (the default is Pierre's own).

**Defaults the build chat may take without asking:** tests, docs, small code on `engine-phase1`, CI. **Always ask first:** merging to `main`, anything on production or staging, any token, money or customer data.

**Parked on purpose (do not spend tokens on these until asked):** the table-size guard, the recovery-gate acceptance, extra domain walks, the shell's question history.

**To start a fresh chat, paste this:**
> Continue The Office (repo pierreduplessis6912-gif/the-office, branch engine-phase1). Read docs/RESUME.md, then HANDOFF.md. Tell me in five lines where we are and do the next step. Keep replies short.

Detail lives in `HANDOFF.md` and part D of `docs/decisions/first-slice.md`; this card is only the short version.
