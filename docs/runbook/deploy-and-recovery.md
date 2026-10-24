> **Status:** real. **Verified:** not yet. **Owns:** none.

# RUNBOOK: deploy-and-recovery

Part of [RUNBOOK.md](../../RUNBOOK.md), split from it on 2026-10-24 without changing a word (the original is `git show 95bf743:RUNBOOK.md`). Sections keep their original order.

## 4. Deploy, hotfix, rollback

**Deploy** = push to `main`. The pipeline runs, in order: typecheck, the whole test suite (twice: once on each database backend), a **staging gate only if a database migration changed**, the deploy, a smoke test of the live Worker. About 5 to 7 minutes. If the smoke test fails, it **rolls back to the previous version by itself**, smoke-tests again, and marks the run failed.

**Hotfix** = a small commit pushed the same way. Nothing skips the tests.

**Go back after a bad change** = revert the commit (`git revert <sha>`, push). Same pipeline.

**Do NOT go back to the old database by deleting `BUSINESS_MODE = "object"` and `LEGACY_LINK_BUSINESS` from `worker/wrangler.toml`.** That was a safe rollback only at the cutover on 2026-10-13. Everything written since lives in the business's object; the old database holds the data as it was at the cutover. Doing it now would show members stale data. Only consider it if the object itself is destroyed, and then restore from a backup first (section 5).

## 5. Restore from a backup

A snapshot of every table, the notes and an inventory of the files is taken automatically about once a day (when the newest is 20 hours old) into a **separate** bucket (`office-backups`); the newest 14 are kept. Files are mirrored incrementally.

**The easy way: the "Production restore" workflow** (GitHub, Actions, Run workflow). It needs no keys on your phone.
1. **List first.** Run it with both boxes **empty**: it only lists the snapshots (name, complete or not, rows, files, when) and writes nothing. This is the default, so a mis-tap restores nothing.
2. **Restore.** Run it again with the snapshot name in `snapshot` **and** the business id typed exactly in `confirm` (`zululand-flooring-and-blinds`). A small script decides first, and **refuses** (the run goes red, nothing is written) if the snapshot does not exist, never finished, the name has odd characters, the id is not typed exactly, or the snapshot is on the **deny list** (`ops/restore-denylist.json`: snapshots that are complete copies of a damaged business, each with its reason; the list shows them as `DENIED, NEVER RESTORE`). Restoring an older snapshot than the newest is allowed and is warned about, and so is a snapshot with under 90% of the rows of the largest one (it says how much it would lose). **If you ever see that a snapshot holds damaged data, add its name and reason to `ops/restore-denylist.json`.**
3. **What the restore does:** checks every checksum before changing anything; takes a **safety snapshot of the current state**; locks the business (members get "This business is being restored", retry in 60 seconds); then replaces the data **in ONE transaction, emptying tables children first and filling them parents first by the schema's foreign keys, so a restore that fails part way changes NOTHING** (true since 2026-10-14; before that it did not, see the decision log); then the notes and files; then checks a fingerprint. It is a **single attempt**: the workflow never retries a restore.
4. **To UNDO a restore**, run the workflow again with the **safety snapshot's name** (printed at the end of the run) and the id typed in `confirm`.
5. **Afterwards:** the run checks `/health`; then run "Production health" and check the numbers look right. The record is `ops/production-restore-last.json` (names, counts and statuses only).

**The manual way** (if GitHub is unavailable): `curl -s $OFFICE/admin/backup/list -H "X-Admin-Key: $ADMIN" -H "X-Target-Business: $BIZ"`, then `curl -s -X POST $OFFICE/admin/backup/restore -H "X-Admin-Key: $ADMIN" -H "X-Admin-Confirm: $CONFIRM" -H "X-Target-Business: $BIZ" -H "Content-Type: application/json" -d '{"snapshot":"<name>","confirm":"zululand-flooring-and-blinds"}'`. If the business stays locked after a failed restore: read `/admin/backup/status`, then `POST /admin/backup/unlock` (privileged) only once you know why.

**What a restore does not bring back:** the memory index (Vectorize), and there is no copy outside Cloudflare. **Point-in-time recovery** exists at Cloudflare (30 days for SQLite-backed objects) but **nothing in the Worker lets you trigger it**, so it is not available to you today.

## 6. The model provider is down

Every model call is tried 3 times (waits of 0.3 s then 0.6 s). If it still fails, each feature falls back instead of crashing, and the failure is logged. What a member sees, from the recorded test cases: when the second-stage reading fails on an invoice sentence, **the invoice is still noted and held for confirmation**, and the reply says it could not read the job details and to say that part again. **What was never observed:** a total provider outage end to end.

- **Check:** Cloudflare's status page (Workers AI); the health report's model failure counts (`GET /admin/health`).
- **Tell members:** say the job part again later; held actions are not lost.
- **Nothing to switch off.** If it drags on, do the cost-spike steps only if spend is rising (section 7).

## 7. A cost spike

A message costs about 940 neurons (about $0.01). Free allowance: 10,000 neurons a day for the whole account; after that $0.011 per 1,000.

- **See it:** the production health check warns above a dollar figure and at 80% of the day's ceiling; `GET /admin/health` shows today's model use.
- **The ceiling is a real stop.** Plan `standard` is in **enforce** mode (since 2026-10-14): 100 messages per member per day, 400,000 neurons (about $4.40) per business per day. Over either limit, the member sees "You have reached today's limit of 100 messages. It resets at midnight UTC" (or the business version). **Midnight UTC is 02:00 your time.**
- **Lower the limits fast:** GitHub, Actions, **"Production plan mode"**, Run workflow: set the two numbers (whole numbers) and keep `enforce`. It takes effect within 5 minutes. It reads the result back and records it in `ops/production-plan-last.json`.
- **Switch to warn (record only, never block):** the same workflow with `warn`.
- **The app needs the Codemagic rebuild** (done?) to show the friendly limit message; until then a member who hits a limit sees "Something went wrong".
