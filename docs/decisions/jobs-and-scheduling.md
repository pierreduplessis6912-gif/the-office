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
