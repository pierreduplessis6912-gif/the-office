> **Status:** real. **Verified:** 2026-10-24. **Owns:** none.

# RUNBOOK: running The Office when something happens

Written 2026-10-14 for Pierre. Every command and route here was read from the code or run; the last section says, for each part, whether it has been **executed** or only written. Nothing here is a guess about how the system behaves unless it says so.

**The business:** `zululand-flooring-and-blinds`, on `https://office.websitehub.co.za`, one Durable Object per business (it runs in Paris, data centre CDG).

---

## Contents (the sections moved to `docs/runbook/`; every heading is listed, in original order inside each part)

Split on 2026-10-24 from the 558-line original, which is `git show 95bf743:RUNBOOK.md`; "was line N" refers to it. Search a heading here, open its part.

### [first-response](docs/runbook/first-response.md): setup, the daily check, what each red or warning message means (4 sections)

- [0. Set up once in Termux (the admin keys)](docs/runbook/first-response.md) (was line 11)
- [1. Every day: nothing](docs/runbook/first-response.md) (was line 26)
- [2. When the health check goes RED: what each message means and what to do](docs/runbook/first-response.md) (was line 33)
- [3. WARNINGS (the check stays green)](docs/runbook/first-response.md) (was line 48)

### [deploy-and-recovery](docs/runbook/deploy-and-recovery.md): deploy, hotfix, rollback, restore, provider outage, cost spike (4 sections)

- [4. Deploy, hotfix, rollback](docs/runbook/deploy-and-recovery.md) (was line 58)
- [5. Restore from a backup](docs/runbook/deploy-and-recovery.md) (was line 68)
- [6. The model provider is down](docs/runbook/deploy-and-recovery.md) (was line 83)
- [7. A cost spike](docs/runbook/deploy-and-recovery.md) (was line 91)

### [support-and-secrets](docs/runbook/support-and-secrets.md): support questions, secrets and tokens, what has been executed, gaps, CI failures (5 sections)

- [8. Common support questions](docs/runbook/support-and-secrets.md) (was line 101)
- [9. Secrets and tokens](docs/runbook/support-and-secrets.md) (was line 115)
- [10. What has actually been executed](docs/runbook/support-and-secrets.md) (was line 125)
- [11. Gaps this runbook cannot close yet](docs/runbook/support-and-secrets.md) (was line 141)
- [16. When CI fails and you cannot see why](docs/runbook/support-and-secrets.md) (was line 206)

### [customers-and-onboarding](docs/runbook/customers-and-onboarding.md): new business, adding people, self-serve signup, trials, directory, owners managing their team (6 sections)

- [12. Creating a new customer's business](docs/runbook/customers-and-onboarding.md) (was line 149)
- [13. Adding a person to an existing business](docs/runbook/customers-and-onboarding.md) (was line 169)
- [14. Self-serve signup: a genuinely new customer onboarding themselves](docs/runbook/customers-and-onboarding.md) (was line 179)
- [15. Bringing a trial back (convert to a paid plan, or extend)](docs/runbook/customers-and-onboarding.md) (was line 195)
- [17. Seeing the directory, and a privacy reminder](docs/runbook/customers-and-onboarding.md) (was line 212)
- [18. Owners managing their own team (server done, no app screen yet)](docs/runbook/customers-and-onboarding.md) (was line 218)
