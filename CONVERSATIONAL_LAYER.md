> **Status:** partly built. **Verified:** 2026-10-28. **Owns:** `worker/src/converse.ts`, `tools/converse.test.js`, `tools/converse-breakage.js`, `tools/converse-smoke.py`, `.github/workflows/converse-smoke.yml`.

# The conversational layer

Doctrine approved by Pierre 2026-10-28 (wording below). Phase 1 is approved subject to gates: the diff inspected, a fast-forward merge only, a controlled deploy with `CONVERSE=off` kept as the rollback, a production smoke test, and observed latency. Phases 2 to 4 are proposed only; each needs its own chat and his yes.

## Why
The app feels transactional; the MCP feels conversational. A message with nothing to act on ("hello", "I want to have a conversation with you") ended as "I didn't catch anything there I could act on." The layer answers such a message in words, using Kimi (already in the stack). No new model, no agent framework, no schema change.

## Doctrine (APPROVED by Pierre, 2026-10-28, in his wording)
> The conversational LLM may converse naturally, explain capabilities, guide onboarding, troubleshoot and narrate information supplied by trusted Office capabilities.
>
> It must not invent business facts, financial figures, calculations, transaction statuses or claims that an operation succeeded. Business facts and financial figures must be grounded in authorised data or deterministic calculations. Any calculations must use trusted, validated inputs and established business rules.
>
> The conversational layer cannot independently create, modify, approve or confirm business records. All business actions remain under the existing Office processing engine and its validation, authorisation, confirmation and audit controls.
>
> The conversational layer may explain what it knows, acknowledge uncertainty, ask clarifying questions and help users express their intentions without forcing every utterance into an actionable task.

Phase 1 uses much less than this allows, on purpose: the model is given no business data at all, so it may state no figure (a reply with a digit is dropped), and onboarding, troubleshooting and narrating trusted data belong to later phases. `OFFICE_CONSTITUTION.md` Principle 2 said the AI has "exactly two seats"; it now carries a dated amendment pointing here, because a bounded third seat (conversation) exists. Nothing else in the constitution changed.

## What Phase 1 does (`tryConverse`)
- **When:** only if the whole reply is the old failure text (`NO_INTENT_MESSAGE`), the intent was "other", and nothing was found, held or refused. A business instruction, a lookup, a follow-up or an upload never reaches it: its path and its records are byte-identical (the test runs one instruction with the layer on and off and compares the reply and every write).
- **What the model gets:** a short Office persona, the capabilities from `REAL_CAPABILITIES` (one per built section of `FEATURES.md`, filtered by the member's permissions), the member's own last six turns (`readHistory`, scope "own", their own business's database), and what they just said. No tools, no business data.
- **What may be shown:** a reply with a digit (any figure, amount, date or count), or a claim that something was recorded, saved, created, sent, confirmed and the like, is dropped and the old message stands. So does an empty or over-long reply, and any failure of the model or the history.
- **Reply:** only `message` changes; envelope version 1, so old APKs work. Typed and voice routes both. Switch: `CONVERSE=off` restores the old behaviour exactly.

## Proof
`tools/converse.test.js` (44 checks, part of the backend suite) and `tools/converse-breakage.js` (24 deliberate breakages, each must fail a test; the first makes a model reply reach a held action). Fragments of one sentence sent in three pieces: each piece is answered as conversation (none gets the failure text), and the third is answered with the first two in view.

## Observed on staging, 2026-10-28 (real Kimi, same code as production; record: `ops/converse-smoke-last.json`, run `40685915830`)
- **Passed:** a greeting ("Morning. What can I do for you?") and "I want to have a conversation with you" ("I'm here. What's on your mind?") get natural, short replies with no figure; a business instruction ("<customer> paid R500") is still held for confirmation (action #149, rejected afterwards, staging left as found); the conversation turns wrote no record and held no action (checked in the history of records written); `CONVERSE` set as a Worker secret turned the layer off at once (the exact old reply) and removing it turned it on again.
- **Limit found, not fixed:** the layer runs only when the pipeline's intent is "other". Real Kimi classifies "What can you help me with?" and "Do you know what I just told you about my day?" as a **lookup**, so they never reach the layer: they got the existing lookup answer ("I don't have that on file", once followed by facts about an invoice). The same happened to one greeting ("Hey Office, how are you"). So "what can you help me with?" does not yet describe capabilities, and a follow-up that uses earlier turns was NOT demonstrated live (it is proven only by the tests, which script the classifier). The two failed smoke checks (`follow_up_uses_the_previous_turn`, `off_samples_all_original_reply`) are this routing, not the layer misbehaving. Options, for Pierre: (a) accept Phase 1 as is; (b) also run the layer when a lookup found nothing ("I don't have that on file"); (c) put a conversational check before the lookup. Each changes Phase 1's gate, so none is built.
- **Latency (n=5 each, wall clock from the runner, includes network):** greeting with the layer on: median 7.1 s, mean 8.5 s (4.4 to 14.3 s); with `CONVERSE` off: median 3.6 s, mean 4.2 s (2.4 to 7.7 s); added by the layer about 3.4 s median, 4.3 s mean. Server-side, the layer's own model call averaged 1.0 s (max 2.9 s, 8 calls, no failures); the existing split and extract calls average 1.6 s and 2.7 s. The wall-clock gap is larger than the call itself and the samples are few and noisy (one "on" sample took the lookup path), so treat it as an order of magnitude: about 1 to 4 s extra. Not optimised.

## Not verified
A smoke test on PRODUCTION (it needs a signed-in session, which only the app has); how the app shows the reply on a device; the follow-up using earlier turns with real Kimi; how to flip `CONVERSE` on production from a phone (on staging a Worker secret named `CONVERSE` set through the Cloudflare API worked; no production workflow for it exists yet).

## Later phases (do not build without a new chat and Pierre's yes)
2. **Read-only conversation:** Kimi gets the MCP read tools only; numbers verbatim from tool output, shown beside the narrative; working memory for "that customer" from `CONTEXT.md`; never a confirm tool.
3. **Instructions from the conversation** into `processTranscript`, the human still confirms in the app; add an idempotency key (F-17).
4. **Onboarding and troubleshooting, suggestions from real capabilities, personalities, multilingual:** each separately measured.
