# RUNBOOK: running The Office when something happens

Written 2026-10-14 for Pierre. Every command and route here was read from the code or run; the last section says, for each part, whether it has been **executed** or only written. Nothing here is a guess about how the system behaves unless it says so.

**The business:** `zululand-flooring-and-blinds`, on `https://office.websitehub.co.za`, one Durable Object per business (it runs in Paris, data centre CDG).

---

## 0. Set up once in Termux (the admin keys)

```
export OFFICE=https://office.websitehub.co.za
export BIZ=zululand-flooring-and-blinds
export ADMIN='<ADMIN_KEY>'
export CONFIRM='<ADMIN_CONFIRM_KEY>'
```

- **Read and write routes** need `-H "X-Admin-Key: $ADMIN"`.
- **Privileged routes** (restore, unlock, add a member, plans, merges, deletes, export) also need `-H "X-Admin-Confirm: $CONFIRM"`.
- **Anything about one business** also needs `-H "X-Target-Business: $BIZ"`.
- **Five wrong keys from one place lock that place out for 15 minutes**, even if the sixth is right. If you are locked out, wait; do not keep trying.
- The same two keys sit in GitHub as the secrets `PROD_ADMIN_KEY` and `PROD_CONFIRM_KEY`; the workflows use those, so for most things you never need the keys on your phone.

## 1. Every day: nothing

`Production health` (a GitHub workflow) reads the business every three hours (minute 7 of every third hour UTC: 02:07, 05:07, 08:07 … your time). It goes **red** when something that must happen on its own has stopped, and shows **warnings** for things worth knowing. Its last result is in `ops/production-health-last.json` (a verdict and counts, no secrets).

- Whether GitHub **emails** you about a red run depends on your GitHub notification settings (Settings, Notifications, Actions). Check that once.
- Run it by hand any time: GitHub, Actions, "Production health", Run workflow.

## 2. When the health check goes RED: what each message means and what to do

| It says | What it means | Do this |
|---|---|---|
| the health report could not be read | The Worker did not answer, or the admin key no longer matches | Run it again. Open `https://office.websitehub.co.za/health`: if that is not OK, see section 4 (a bad deploy). If it is OK, the `PROD_ADMIN_KEY` secret may have changed |
| the last hourly job FAILED: (reason) | The memory job failed. Customer data is **not** affected; memories are saved late | Read the reason. It retries every hour. If it keeps failing, check Cloudflare's status page (Workers AI, Vectorize) |
| the hourly job has never run and no run is scheduled | Nothing has armed the job | Open the app once (the first request arms it) and run the check again |
| the hourly job last ran N minutes ago | The job has stopped | Same as above; a new deploy also restarts it |
| the next hourly run is overdue (alarm stuck) | The alarm did not fire | Open the app once; if still overdue after the next check, deploy again (section 4) |
| the oldest memory has waited N minutes / N memories are waiting | The memory queue is backing up (the job or Vectorize is failing) | Fix the hourly job first. To push the queue by hand: `curl -s -X POST $OFFICE/admin/flush-memory -H "X-Admin-Key: $ADMIN" -H "X-Target-Business: $BIZ"` |
| server errors are X of the last N requests | Real failures are reaching members | Look at what changed: if a deploy just went out, go back (section 4). Otherwise read `GET /debug/timings` and Cloudflare's logs |
| the last backup attempt FAILED / the newest backup is N hours old / there is no backup | Backups are not happening | Run the "Production backup" workflow ("take one now") and read why it failed (the backup bucket `office-backups`, Cloudflare R2). **Do not ignore this one** |
| the daily backup was SKIPPED at (time): (reason) | The object could not even try its daily backup (no backup bucket bound, or it did not know its business's name). Found 2026-10-14: this happened after every restart until the bug was fixed | Read the reason. "No backup bucket" means the Worker's configuration lost the `BACKUPS` binding: restore it and deploy. Then run "Production backup" with `run` to take one now |
| a schema step FAILED / N schema steps are not applied | A database change did not apply. **Members get "This business is being updated" (503) until it is fixed** | Push a corrected migration, or revert the commit (section 4). After the fix: `curl -s -X POST $OFFICE/admin/schema/retry -H "X-Admin-Key: $ADMIN" -H "X-Target-Business: $BIZ"` (or wait: it retries hourly) |

## 3. WARNINGS (the check stays green)

| It says | What to do |
|---|---|
| applied N schema steps this code does not know | The code was rolled back behind the database. Deploy the current main again |
| the model has cost about $X today | Section 7 |
| N member(s) reached the daily message limit | Expected if someone is busy. If it is normal use, raise the limit (section 7) |
| the model has used N% of the day's spend ceiling | Section 7 |
| the object runs in the CDG data centre, not a South African one | Known and accepted (2026-10-14): nobody noticed the distance. Ignore unless members start complaining about speed |

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

## 8. Common support questions

| A member says | It is | Do this |
|---|---|---|
| "I can't sign in" | Sign-in is Google. Their email must be in this business's directory | `curl -s $OFFICE/debug/directory -H "X-Admin-Key: $ADMIN"` to look. To add: `POST /debug/directory/add-member` (privileged) with `{"email":"...","business_id":"zululand-flooring-and-blinds","role":"installer"}`. Roles: `owner`, `accountant`, `installer` (default) |
| "I can't confirm that invoice or payment" | The role decides. Installers cannot confirm money actions; accountants can; some actions are owner-only | Check their role; change it with the add-member route |
| "It says the business is being updated / restored" | A database change failed (section 2) or a restore is running (section 5). Retry in a minute | Run the health check |
| "It says I reached my limit" | Section 7 | Raise the limit if it is normal use |
| "It did not read the job part" | The model failed on that step (section 6) | Say it again |
| "My confirm failed" | If it says the confirm handler threw, **nothing was recorded** (true since 2026-10-14) | Tap confirm again |
| "A voice message or upload failed" | Rarely, Cloudflare's edge returns an instant 502 on an upload (seen in load tests; cause unknown) | Send it again, and check the waiting actions first so it does not go in twice. I have not tested an upload retry after a 502 |
| "There are two of the same customer" | The merge routes exist (privileged, and atomic now) | Ask Claude: give both names |
| "I want all my data" | `GET /admin/export` (privileged) exists | Not exercised by me |

## 9. Secrets and tokens

| Item | Where | What to know |
|---|---|---|
| `ADMIN_KEY`, `ADMIN_CONFIRM_KEY` | Production Worker secrets; GitHub secrets `PROD_ADMIN_KEY`, `PROD_CONFIRM_KEY` | Change both places together or the workflows get 401 |
| `SESSION_SECRET` | Production Worker secret | Changing it signs **everyone** out |
| GitHub token (fine-grained, repo only) | `/home/claude/.office_gh_token` | **Expires 2026-11-12. Rotate before then** |
| Old GitHub token (classic, repo and workflow) | github.com/settings/tokens | **Still valid. Revoke it when we finish** |
| Cloudflare token and account id | GitHub secrets `CF_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | Needed by the deploy |

## 10. What has actually been executed

| Section | Executed? | Evidence | Still not executed |
|---|---|---|---|
| Deploy | **Yes** | Every push runs it; the latest ran on 2026-10-14 | |
| Hotfix / revert | **Yes** | The revert `dca615c` went through the pipeline the same day | |
| Rollback (automatic) | **Yes** | The drill, run 38213798571: deployed, forced the smoke test to fail, rolled back, smoke-tested again and passed | |
| Rollback to the old database | **No, and it is not safe now** | | By design: see section 4 |
| Restore | **Executed in production on 2026-10-14 (after its first attempt FAILED and was fixed)** | The first real restore failed on a foreign key and left production partly deleted (decision log, 2026-10-14). After the fix (`4a161f2`) the staging rehearsal restored a business with LINKED data on real Cloudflare (42 tables, 40,234 rows in one transaction, 3 payments back, 0 differences), and the production restore of snapshot `20261014T185130Z` at 19:52 UTC succeeded (47 tables, 2,006 rows, 42 notes, 0 differences); an independent snapshot taken afterwards had the same counts | Restoring with the notes store or files failing part way (they are outside the database transaction) |
| Automatic daily backup | **Found broken, fixed and VERIFIED in production (2026-10-14)** | Production had ONE snapshot (taken by hand), 24.7 hours old, with no attempt since: after every restart the backup was skipped. Fixed (commit 9083b61) with a test that failed before and passes after. **The first automatic snapshot after the fix, `20261014T183344Z` (47 tables, 2,006 rows, 42 notes, 129 files), was taken by the alarm at 18:33:44 UTC, the minute it was due, with nobody using the app** | The next one is due about 20 hours after it |
| Model outage | **Partly** | Recorded test cases where model calls fail (the invoice is noted and held) | A real provider outage, end to end |
| Cost spike | **Yes** | The plan workflow ran in production on 2026-10-14: warn to enforce (run `acec10d`), then again with the new number inputs (run `b5184c7`: set 200, read back as 100 / 400,000 / enforce, health 200). On staging, enforce at a limit of 1 gave a 429 with the model spend unchanged | A real refusal on production; a real spike |
| Health alerts | **Yes** | The judging script is run by the tests against every way a business can be unhealthy; the check ran in production several times on 2026-10-14 | A real red alert reaching you |
| Support questions | **Written from the code** | Health, directory, backup status and plan reads were run | The member and merge routes, export |
| Create a customer's business | **Tested, not yet run** | The guard (88 checks, 14 breakages caught) and the workflow's structure; the route it calls has created two businesses on real Cloudflare in every staging rehearsal | **The workflow has never been run**, not even its refusal paths (list the directory, refuse an existing business with members) |

## 11. Gaps this runbook cannot close yet

1. **The notes and files are restored AFTER the database transaction commits**, so a failure there would leave the database restored and the notes or files old. Unlike the database part, that is not atomic.
2. **No way to trigger point-in-time recovery.**
3. **A real model outage has never been seen.**
4. **The intermittent edge 502s on uploads** are unexplained (checklist item 13).
5. **Admin work needs the keys in Termux** (apart from the workflows listed here).

## 12. Creating a new customer's business

A business is created by **you**, not by self-serve sign-up (decided 2026-10-14). It needs three things: a **business id** (3 to 40 lower-case letters, digits and hyphens, for example `acme-floors`), the **business name** as it should appear, and the **owner's Google email**, the account they will sign in with.

1. GitHub, Actions, **"Production new business"**, Run workflow. Fill the four boxes: the id, the name, the owner's email, and **the id again** in `confirm`.
2. It first **reads** the directory and asks whether that email already belongs to a business. A small script then decides. It **refuses**, before any write and with the run going red, when: the id is not valid or is reserved (`admin`, `api`, `app`, `auth`, `debug`, `demo`, `health`, `office`, `staging`, `test`, `www`, or starting `staging-`); the name or email is not valid; the id is not typed again exactly; **the email already belongs to another business** (one email can sign in to only one business; it does not say which); or **the business already exists and already has members** (so a typed id can never add a second owner to a live business; to add someone use `add-member`, section 8).
3. If it is allowed, it makes **one** attempt to create the business on the `standard` plan (100 messages per member per day, 400,000 neurons per business per day, enforced) with the owner as its owner. It then checks the result: the business is in the directory, active, on the standard plan; the owner is a member; its own object answers **as itself**. A failed check turns the run red.
4. **If it stops half way**, run it again with the **same boxes**: a business that exists with **no** members is completed; one that has members is refused.
5. Then tell the owner to install the app and **sign in with Google using exactly that address**. Their journey (business details, customers, invoices, team, suppliers, materials) starts the first time they open it, and each import step takes a spreadsheet.

The owner's email is personal data: the workflow shows it only masked (`o***@acme.co.za`) and the record (`ops/production-new-business-last.json`) holds the business id, its name and statuses only.

**What it does not do:** it sends no invitation (you tell the owner); there is **no workflow to delete a business**, so a business created by mistake stays as an empty business until Claude removes it by hand; and a new business's object is created from a GitHub runner, so it is placed wherever Cloudflare chooses for that first request (the Paris finding in section 3 applies; not felt so far).

**Executed?** The guard and the workflow's structure are tested (88 checks, 14 breakages caught). The create route it calls has run on **real Cloudflare** for two businesses in every staging rehearsal. **The workflow itself has not been run**, not even in its refusal paths.

