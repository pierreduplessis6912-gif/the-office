> **Status:** real. **Verified:** not yet. **Owns:** none.

# RUNBOOK: first-response

Part of [RUNBOOK.md](../../RUNBOOK.md), split from it on 2026-10-24 without changing a word (the original is `git show 95bf743:RUNBOOK.md`). Sections keep their original order.

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
