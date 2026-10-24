> **Status:** real. **Verified:** not yet. **Owns:** none.

# RUNBOOK: support-and-secrets

Part of [RUNBOOK.md](../../RUNBOOK.md), split from it on 2026-10-24 without changing a word (the original is `git show 95bf743:RUNBOOK.md`). Sections keep their original order.

## 8. Common support questions

| A member says | It is | Do this |
|---|---|---|
| "I can't sign in" | Sign-in is Google. Their email must be a member of this business (and of no other: one email, one business) | Use **"Production add a member"** (section 13). Check which Google account they are signing in WITH: a screenshot of the account chooser showed the owner's address was not on the phone at all (2026-10-17) |
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
| Create a customer's business | **Run in production, including the create (2026-10-17)** | The guard (97 checks, 6 breakages of the privacy design caught, 14 of the guard and workflow earlier); the route has created two businesses on real Cloudflare in every rehearsal; in production it refused the live business and a mistyped confirmation, then CREATED `tender-hub`: every step passed, an independent check showed 4 members for the live business and 1 for the new one, the record holds no email, and a canary run of the same code left 0 occurrences of the address in 11 log files | The real address was not searched for in the create run's logs (by design: the checking tool must only ever be given placeholders); the canary run of identical code is the evidence |

## 11. Gaps this runbook cannot close yet

1. **The notes and files are restored AFTER the database transaction commits**, so a failure there would leave the database restored and the notes or files old. Unlike the database part, that is not atomic.
2. **No way to trigger point-in-time recovery.**
3. **A real model outage has never been seen.**
4. **The intermittent edge 502s on uploads** are unexplained (checklist item 13).
5. **Admin work needs the keys in Termux** (apart from the workflows listed here).

## 16. When CI fails and you cannot see why

GitHub's logs are not reachable from where Claude works. **"Log excerpt"** (Actions, Run workflow, a run id, default step name `Role-matrix`) reads that run's TEST step from inside GitHub and records the failing lines and the last lines in `ops/log-excerpt-last.json` (it refuses a deploy or secret step; output is capped). **"Log leak check"** counts a PLACEHOLDER string in a run's logs (never a real address: the needle is a public input).

**Two things to know about the pipeline.** (1) **The deploy decision asks PRODUCTION what it is running** (fixed 2026-10-17; it used to ask "did the Worker change since the previous commit?", so a red run followed by a tests-only fix silently skipped the deploy and a migration's staging gate). The deploy stamps its commit into the Worker (`wrangler deploy --var GIT_SHA`), `/health` reports it (`{"status":"ok","service":"office-api","commit":"<40 characters>"}`), and the pipeline asks it before every push (`tools/deployed-base.sh`), then deploys if the Worker or the deploy workflow changed SINCE THAT COMMIT, and gates if a migration did. **When production's answer is missing, malformed, not in this history or not an ancestor, it deploys and runs the staging gate** (when in doubt, do the safe, slower thing), so the first push after an old Worker, or a transient network failure, costs a gate run and nothing worse. A manual run of the deploy workflow still always deploys and is never gated. To see what production runs: open `/health`, or run **"Production signup check"** (it records `running_commit`). **Proven on the real pipeline:** a deliberate drill (a red commit with a Worker change, then a tests-only fix) deployed the Worker change, and production then reported the fix's commit. (2) Any workflow that records its result by pushing must push to `$GITHUB_REF_NAME`, never `main`: from a branch it would otherwise push that branch's unmerged code to `main`, which deploys to production (three staging record steps and the leak check had this; all fixed and pinned).
