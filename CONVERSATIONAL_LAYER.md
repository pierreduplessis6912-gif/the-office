> **Status:** partly built. **Verified:** 2026-10-28. **Owns:** `worker/src/converse.ts`, `tools/converse.test.js`, `tools/converse-breakage.js`.

# The conversational layer

Phase 1 is built on branch `converse-layer` and is **not merged and not deployed**: it waits for Pierre's approval of the doctrine wording below and an explicit yes to merge (HANDOVER rule 11). Phases 2 to 4 are proposed only; each needs its own chat and his yes.

## Why
The app feels transactional; the MCP feels conversational. A message with nothing to act on ("hello", "I want to have a conversation with you") ended as "I didn't catch anything there I could act on." The layer answers such a message in words, using Kimi (already in the stack). No new model, no agent framework, no schema change.

## Doctrine change (WORDING AWAITING PIERRE'S APPROVAL; `OFFICE_CONSTITUTION.md` is not edited until he approves)
Old: "LLM routes, never composes answers." Proposed: **Kimi may converse and narrate. Every business fact or number it states must come verbatim from a deterministic read tool. It never calculates, never confirms, and never claims a record exists until the backend confirms it.** In Phase 1 there is no read tool, so the model gets no business data and may state no figure at all.

## What Phase 1 does (`tryConverse`)
- **When:** only if the whole reply is the old failure text (`NO_INTENT_MESSAGE`), the intent was "other", and nothing was found, held or refused. A business instruction, a lookup, a follow-up or an upload never reaches it: its path and its records are byte-identical (the test runs one instruction with the layer on and off and compares the reply and every write).
- **What the model gets:** a short Office persona, the capabilities from `REAL_CAPABILITIES` (one per built section of `FEATURES.md`, filtered by the member's permissions), the member's own last six turns (`readHistory`, scope "own", their own business's database), and what they just said. No tools, no business data.
- **What may be shown:** a reply with a digit (any figure, amount, date or count), or a claim that something was recorded, saved, created, sent, confirmed and the like, is dropped and the old message stands. So does an empty or over-long reply, and any failure of the model or the history.
- **Reply:** only `message` changes; envelope version 1, so old APKs work. Typed and voice routes both. Switch: `CONVERSE=off` restores the old behaviour exactly.

## Proof
`tools/converse.test.js` (44 checks, part of the backend suite) and `tools/converse-breakage.js` (24 deliberate breakages, each must fail a test; the first makes a model reply reach a held action). Fragments of one sentence sent in three pieces: each piece is answered as conversation (none gets the failure text), and the third is answered with the first two in view.

## Not verified
Latency (one extra Kimi call, no thinking; to be measured once from the timing history after deploy, not optimised); how real Kimi words its answers (the tests script the model, so the digit and claim check is what is proven, not the tone); how the app shows the reply on a device.

## Later phases (do not build without a new chat and Pierre's yes)
2. **Read-only conversation:** Kimi gets the MCP read tools only; numbers verbatim from tool output, shown beside the narrative; working memory for "that customer" from `CONTEXT.md`; never a confirm tool.
3. **Instructions from the conversation** into `processTranscript`, the human still confirms in the app; add an idempotency key (F-17).
4. **Onboarding and troubleshooting, suggestions from real capabilities, personalities, multilingual:** each separately measured.
