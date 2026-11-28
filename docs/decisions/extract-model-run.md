> **Status:** unaudited. **Verified:** not yet. **Owns:** none.

# Staging run of the `ai.ts` extractions on real models — pass rule written BEFORE the run

Status: written 2026-11-27 on Pierre's word ("Yes", build a staging mode for the `ai.ts` routes). Nothing here touches production. The run itself is dispatched only on his word (staging mode `extract-model-run`).

## Why
The 26 chat calls in `worker/src/ai.ts` (the older message pipeline) now go through the model router (`docs/MODEL_ROUTES.md`). The existing staging model runs all go through `/engine/interpret`, so none of them reaches these calls. The umbrella proves the wiring with scripted models only. This run asks a REAL model through the SAME functions.

## What is real
`POST /debug/extract-probe` (admin key, like every `/debug` route) calls ONE allowed `ai.ts` function with the given inputs and returns what it returned plus which model answered (`via`) and why if none did. It writes nothing: no business data, no memory, no files. The staging Worker's own route settings decide the model (Moonshot Kimi first, DeepSeek second, unless the switch says otherwise).

## Pass rule (all of this, or the run FAILS)
14 cases, each one function with a fixed sentence (stock usage, stocktake, snag, lead, lead lost, expense category, dashboard intent, backward reference twice, memory answer, follow-up entity, line items, goods received, topic split).
**Safety (every one must pass):**
- S1 Every case on a "records" route (stock usage, stocktake, lead lost, goods received, follow-up entity, memory answer) was answered by Cloudflare, NEVER by Moonshot.
- S2 An unknown function name is refused 422; nothing is called.
- S3 No 5xx on any case.
- S4 The probe wrote nothing (the staging business's row counts are the same before and after).
**Understanding (at least 12 of 14; a real model varies):**
- U1 stock usage: item Plywood 18mm, quantity 3, job customer mentions Mokoena.
- U2 stocktake: item Plywood 18mm, quantity 8.
- U3 snag: description mentions skirting.
- U4 lead: name mentions Thandi, interest mentions blind, source mentions Facebook.
- U5 lead lost: matched name Thandi Zulu (not the other open lead).
- U6 expense category: "Diesel for the bakkie" is `fuel`.
- U7 dashboard intent: "How much are people owing me?" is `aged_debtors`.
- U8 backward reference: "What about her balance?" is true.
- U9 backward reference: "What is Mokoena's balance?" is false.
- U10 memory answer: the answer mentions oak.
- U11 follow-up entity: "whats her balance?" after a Dlamini question resolves to something mentioning Dlamini.
- U12 line items: at least one item, and the reading mentions 450.
- U13 goods received: supplier mentions Timber, at least one line.
- U14 topic split: two or more topics.

A case where no model answered is reported as `model_unavailable` (with the reason), not a pass.

## Rules for the run
A failed case is a RESULT, not a reason to repeat: the cause is looked at, a fix needs Pierre's approval, tests first. Record: `ops/staging-extract-model-run-last.json` (sentences, results, which model answered each, scores, pass or fail; no secrets).
