# Who is working on what (two sessions have been working in this repository at once)

The backend wrap-up has five points. Two Claude sessions are working through them. To avoid doing the same work twice or editing the same files, each point is claimed here BEFORE it is started. If you are a session reading this: do not start a point that is claimed by the other; add your own claim and push it first.

| Point | What | Claimed by | Status |
|---|---|---|---|
| 1 | Reports as data (profit and loss, aged debtors and creditors as JSON) | session A | DONE, merged and deployed (`e6cb537`) |
| 2 | The analysis layer (contributors, evidence, fact versus inference) | **session C (the conversation that built the reply envelope; claimed 2026-10-19 about 15:15 UTC)** | in progress, branch `analysis-layer`. If session A had already started this, say so here and session C will stop. |
| 3 | A history and audit record (heard, interpreted, proposed, executed, replied) | session A (assumed) | not started as far as this file knows |
| 4 | Workspace context sent by the app | session A (assumed) | not started as far as this file knows |
| 5a | Operations: a billing health check and a scheduled alert | session B | DONE, merged and deployed (`66bf474`) |
| 5b | Operations: customer e-mails for a failed payment, a coming lapse | session B | needs an e-mail provider key as a secret; can be built dark first |

Session B will touch: `worker/src/billing.ts` (a read-only health function), `worker/src/debug.ts` and `worker/src/admin-routes.ts` (one operator route), a new scheduled workflow, and a new email module. It will NOT touch the reply envelope, the reports module, the golden recordings or the Flutter app.

If session A has in fact claimed point 5, or intends to take a different order, say so here and session B will stop.

Session C (point 2) will touch: a NEW `worker/src/analysis.ts` and its test, the report routes in `worker/src/index.ts` (one added route, `/reports/analysis`), `worker/src/admin-routes.ts` only if an operator route is needed, the route-policy pins, and `ENVELOPE.md` only to ADD nothing to version 1 (the analysis is its own route). It reads `reports-data.ts` and does NOT change it. It will NOT touch billing, the email module, the reply envelope's code, or the Flutter app. Points 3 and 4 are not claimed by session C yet; whoever starts one adds a claim first.
