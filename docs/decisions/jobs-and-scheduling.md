> **Status:** proposed, waiting for Pierre's "Yes". **Verified:** not yet. **Owns:** the engine's jobs, scheduling, job costing and snags (nothing built yet).

# DECISIONS: jobs and scheduling in the engine (2026-11-17)

## Why this next
The vision is a business owner who "talks to the office". For a flooring or blinds business the day is jobs: who it is for, where, when, who is doing it, what it cost, whether it is finished and paid. The engine has the money side (quotes, invoices, payments, expenses, stock) but no job at all, so none of it can be tied to the work it was for. The live system has jobs, scopes, completion, snags and leads (`projects-and-jobs.md`, 734 lines of history); this rebuilds only what the owner actually uses, on the engine's rules (facts are only added, held writes are approved by a person, state is derived).

## What the older decisions already settled (kept, not reopened)
- A job is **closed when it is paid in full and nobody is complaining**. A completion certificate, warranty or care sheet is optional extra paperwork and **never a gate** (Pierre, 2026-07-22).
- Matching a sentence to an existing job uses the engine's rung rule: a named handle matches; exactly one open candidate attaches; two or more ask; none leaves it standalone. **No time-window guessing.**
- The same work said twice makes no second job (Decision 50).

## The model (three steps, each built tests first, one at a time)
**J1. Jobs and the calendar.** A job is a record for a customer: a description, an optional site address, an optional date, an optional person assigned. It is made by one held write (`job.create`), moved by held writes (`job.schedule`, `job.assign`, `job.cancel`), and read by `jobs.find` ("what is on this week", "Mokoena's jobs"). State is derived from events, so a job's whole history is its provenance. One additive table lists the jobs (migration 0010: `eng_job`, same pattern as `eng_bank_account`); the date, the person and the status are never stored on it, they are derived. A job with a date in the past that is not done shows as overdue; nothing is ever moved silently.
**J2. Tying the money to the job.** A quotation, invoice or expense may name the job it is for (`jobId`, checked to be a real, open job of the same customer for quotes and invoices). A job then reads: quoted, invoiced, paid, spent, and what is left over (the engine's own figures, labelled as derived). This is the "what did that job really make me" answer. Existing documents are untouched; linking is a new fact.
**J3. Done, and snags.** "Done" is derived exactly as above (paid in full, no open snag), and a person may also say "mark it done", held like everything else. A snag is a small note on a job ("scratch near the door") that is open until closed; an open snag stops the job showing as finished. No certificates, no warranty tracking in this step.

## Who is "assigned"
A person who works for the business and may have no login (an installer) is a **party with the role installer**, exactly as the older system treated them ("a real, non-billed person"). `party.create` already takes roles, so this needs no new capability, only the role name. Logins and what each member may do stay as they are (`identity-and-people.md`).

## In the app and in conversation
J1 adds a Jobs room (this week first, then all) and a "+" new-job form on the same pattern as the other forms (it proposes, never writes), and the interpreter learns the sentences "new job for Mokoena, lounge floor, Friday" and "what is on this week". J2 adds an optional job choice to the quotation, invoice and expense forms. J3 adds "done" and "snag" to the job's page. Conversation first means the form is the fallback, not the main way.

## What is NOT in this note
Leads and enquiries, customer service cases, projects that group several jobs, site visits as separate records, travel time, crews and capacity planning, a calendar sync, reminders to the customer. Each is a later, separate decision; the model above leaves room (a job can later belong to a project) without building any of it.

## Proof standard (the usual)
Tests first and red; every refusal (wrong role, unknown customer, a cancelled job, a past date where forbidden, a second identical job); the twelve invariants hold; deliberate breakages caught; snapshot and restore pass with the new table; the approval screen reads each held job write as plain lines; Dart tests in app CI. Rows added to `docs/CAPABILITY_MAP.md` in the commit that makes them true.

## The decision wanted
Say "Yes" to build J1, then J2, then J3 as written (each ends with a green umbrella, a push and a CI check before the next begins), or tell me what to change. Two things I would like your word on inside that Yes, with my choice if you do not say otherwise: (a) a job may have **no date** (an enquiry that has become work but is not booked yet), and (b) cancelling a job with money already tied to it is **refused** until the money is dealt with, never hidden.

## As built: J1 (2026-11-17)
Migration 0010 `eng_job(id, party_id, event_id)`, a fact; description, site, reference, first date and person live in the `job.created` event, and `job.scheduled`, `job.assigned` and `job.cancelled` events change them. State is folded in `worker/src/engine/jobs.ts` (`allJobs`), never stored. Contracts `job.create`, `job.schedule`, `job.assign`, `job.cancel` (held, permission `job.manage`) and the read `jobs.find` (`job.read`, `GET /engine/jobs`) are given to roles with can_make_quotes. The assignee must have the role installer; a customer must have the role customer; the same description for the same customer while open is refused; a cancelled job takes no more changes. Overdue is computed from the business date (SAST, read with UTC getters) or an `asOf`. App: Jobs room (overdue, this week, later, no date yet), "+" form, approval lines. Not built: interpreter sentences, records.get for jobs, an installer's own view (waits for the login-to-installer link).

## As built: J2 (2026-11-17)
One deviation from the plan above, on purpose: instead of adding `jobId` to `quotation.create`, `invoice.issue` (which works from a draft) and `expense.record`, there is ONE held write, `job.link {jobId, documentId}`, that ties an EXISTING quotation, invoice or expense to an open job. Same rules, no change to three working flows. Migration 0011 `eng_job_link(job_id, document_id UNIQUE, event_id)` is a fact made by a `job.linked` event; a document is tied to at most one job; a quotation or invoice must be for the job's own customer; a voided document cannot be tied and stops counting. `jobs.find` now returns `money` per job: quoted (the standing, not-revised quotation), invoiced, paid (effective allocations to the tied invoices), spent (the tied expenses still in force), left over = paid less spent, all gross (VAT included) and derived by `moneyFor`. A job with money tied to it cannot be cancelled. App: the Jobs room shows the money line on a job that has any, and the approval screen reads a link in words. Not built: a form in the app to tie a document to a job (it is done by sentence or API for now), credit notes netted off "invoiced", and tying at the moment a document is made.

## As built: J3 (2026-11-17)
No new table. Four more events: `job.completed`, `job.snag_raised` (its event number is the snag's number) and `job.snag_closed`, folded in `jobs.ts`. A job shows as DONE (derived by `doneOf`) when it is not cancelled, has no open snag, and either someone marked it done or it has tied invoices that are all paid in full. An open snag always wins, so raising one on a done job reopens it and closing it brings the job back. `jobs.find` status is now open (default), done, cancelled or any, and each job carries its snags and `openSnags`. Held writes: `job.complete`, `job.snag_raise`, `job.snag_close`. Refused: marking done a cancelled job, one with an open snag or one that already shows as done; cancelling a done job; a snag on a cancelled job; the same open snag twice; closing a closed or foreign snag. App: the open snags show on the job row and the approval screen reads each write in words. Not built: a Done list in the app room, snag photos, certificates or warranty (left out on purpose), an app form to note or close a snag (by sentence or API for now).

## As built: app actions on a job (2026-11-17)
Each open job in the Jobs room has a menu: mark done, note a snag, close a snag, move the date, cancel, tie money to it (this customer's invoices and quotations, and any expense). Every one proposes and shows the engine's own reason on a refusal. A Done chip lists done jobs. Still not built: interpreter sentences for jobs.

## As built: the model's sentences (2026-11-17)
Two entries in the interpreter catalogue: `jobs.find` ("what is on this week", "what is overdue", "what jobs does Mokoena have": period this_week, next_week or overdue, and an optional customer) and `job.create` ("new job for Mokoena, lounge floor, Friday": customer, work, optional site, optional day word). The model supplies WORDS only: the engine resolves the customer, works the date out from its own clock (a weekday means the NEXT such day; this week is Monday to Sunday; overdue is before today), and a day word is accepted only if the sentence itself says it. A new job is only PROPOSED and held. No date or id from the model is ever accepted. Not offered to the model: schedule, assign, cancel, link, done and snags (the Jobs room menu does those).

## Pass rule for the real-model run of the jobs sentences (written before the run, 2026-11-17)
Staging only, a fresh business, mode `jobs-model-run`, script `tools/jobs-model-run.py`. A real model reads 10 understanding sentences and 13 safety sentences through POST /engine/interpret; nothing is approved (every held action is rejected by the run; only its own setup is approved). PASS = every safety sentence passes (none is held, or answered wrongly) AND at least 9 of the 10 understanding sentences pass AND all four invariants hold (jobs exactly as the setup left them, nothing left waiting, every held action is job.create, the integrity verifier clean). A failure is investigated and fixed tests first with Pierre's approval before any second run.

## Jobs model run 1 (44120067321, 2026-11-17): FAILED on S3 only
Understanding 10 of 10, safety 12 of 13, invariants held. S3 "New job for Mokoena on 2027-03-01, floor": the model dropped the date and a dateless job was held. Fixed with Pierre's approval, tests first: a date the person said that the model did not turn into a day word (a full date, 12/03, the 5th, a month name, next week) is not understood (`JOB_DATE_TALK`, interpret.ts); the real reply is replayed in engine-interpret-jobs.test.js (24 checks) and one breakage added. Run 2 follows.

## Jobs model run 2 (44125502017, 2026-11-17): PASSED
Understanding 10 of 10, safety 13 of 13, all four invariants held. The interpreter's jobs V box can be ticked.
