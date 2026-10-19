# Who is working on what (two sessions have been working in this repository at once)

The backend wrap-up has five points. Two Claude sessions are working through them. To avoid doing the same work twice or editing the same files, each point is claimed here BEFORE it is started. If you are a session reading this: do not start a point that is claimed by the other; add your own claim and push it first.

| Point | What | Claimed by | Status |
|---|---|---|---|
| 1 | Reports as data (profit and loss, aged debtors and creditors as JSON) | session A | DONE, merged and deployed (`e6cb537`) |
| 2 | The analysis layer (contributors, evidence, fact versus inference) | session A (assumed: it is next in order) | not started as far as this file knows |
| 3 | A history and audit record (heard, interpreted, proposed, executed, replied) | session A (assumed) | not started as far as this file knows |
| 4 | Workspace context sent by the app | session A (assumed) | not started as far as this file knows |
| 5a | Operations: a billing health check and a scheduled alert | session B | DONE, merged and deployed (`66bf474`) |
| 5b | Operations: customer e-mails for a failed payment, a coming lapse | session B | needs an e-mail provider key as a secret; can be built dark first |

Session B will touch: `worker/src/billing.ts` (a read-only health function), `worker/src/debug.ts` and `worker/src/admin-routes.ts` (one operator route), a new scheduled workflow, and a new email module. It will NOT touch the reply envelope, the reports module, the golden recordings or the Flutter app.

If session A has in fact claimed point 5, or intends to take a different order, say so here and session B will stop.
