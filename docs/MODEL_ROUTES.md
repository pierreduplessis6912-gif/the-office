# Model routes: every place The Office calls a model (inventory of 2026-11-27)

Why this exists: Cloudflare retired `@cf/moonshotai/kimi-k2.6` on 2026-11-20 (HTTP 410, code 5028) and the name was written in about 30 places. This is the index, and the plan to make a change like that a one-line switch. Status column: **moved** = goes through the new route (Kimi at Moonshot first, Cloudflare's DeepSeek as fallback); **retired** = still names the retired Cloudflare Kimi and fails today; **ok** = a model that is not on Cloudflare's retirement list.

## Chat models (26 + 4 call sites on the retired model)
| Route (proposed name) | Where | What it does | Status |
|---|---|---|---|
| `interpret` | engine/interpret.ts | reads one sentence into one capability | **moved** (Moonshot kimi-k2.6, fallback Cloudflare deepseek-v4.1-flash-1017) |
| `converse.front_door` | converse-moonshot.ts | the conversation layer, at Moonshot directly (needs MOONSHOT_API_KEY, CONVERSE_MODE) | ok (Moonshot, its own path) |
| `converse.reply` | converse.ts:114 | the in-Worker chat reply (temperature 0.4) | retired |
| `split.topics` | ai.ts splitIntoTopics | splits a message into separate topics | retired |
| `extract.intent` | ai.ts extractIntent, extractMultipleIntents | what the person means (the big one) | retired |
| `extract.line_items` / `scope_pricing` / `purchase_order` | ai.ts | quotation and order lines | retired |
| `extract.goods_received` / `supplier_invoice` / `supplier_statement` / `variance_disposition` | ai.ts | procurement | retired |
| `extract.stock_*` (item registration, unit conversion, usage, stocktake) | ai.ts | stock | retired |
| `extract.snag` / `snag_resolution` / `lead` / `lead_lost` / `work_observation` / `document_identity` | ai.ts | jobs, leads, documents | retired |
| `classify.*` (business topic, expense category, dashboard intent, backward reference) and `resolve.follow_up` | ai.ts | short classifiers (max_tokens 10) and follow-up resolution | retired |
| `memory.answer` | ai.ts answerFromMemory | answers from remembered facts | retired |
| `vision.describe` | ai.ts describeImage | describes a photo | retired |
| `debug.diag` | debug.ts:1544 | an admin diagnostic | retired |
| `trial.probe` | trial.ts | a timing probe | retired |

## Other models (not on the retirement list)
| Route | Model | Where |
|---|---|---|
| `speech.to_text` | `@cf/openai/whisper`, `@cf/openai/whisper-large-v3-turbo` | ai.ts transcribe, transcribeWithNameHints; debug.ts |
| `embed` | `@cf/baai/bge-base-en-v1.5` | ai.ts embedText |
| `rerank` | `@cf/baai/bge-reranker-base` | ai.ts rerank; debug.ts |

## Shape of the calls (why one function can serve them all)
Of the 26 `ai.ts` chat calls, 21 are `{ temperature: 0, chat_template_kwargs: { thinking: false }, messages }`, 1 is the same with the keys swapped, and 4 add `max_tokens: 10`; every one reads `choices[0].message.content`. `chat_template_kwargs` is Kimi-on-Cloudflare only: DeepSeek on Cloudflare uses `reasoning_effort: "none"`, and Kimi at Moonshot uses `thinking: { type: "disabled" }`. That difference is exactly what a router hides.

## How it works now (built 2026-11-27)
- **One door:** `worker/src/model-routes.ts`. `chat(env, "<route>", { messages, temperature?, maxTokens?, timeoutMs? })` returns the text, which model gave it (`via`) or the reasons it failed.
- **One catalogue:** `kimi` (Kimi `kimi-k2.6` at Moonshot, thinking disabled, needs the Worker secret `MOONSHOT_API_KEY`) and `deepseek` (`@cf/deepseek-ai/deepseek-v4.1-flash-1017` on Cloudflare, `reasoning_effort: "none"`). Adding a model is one entry there plus its name in the workflow.
- **One default:** Kimi first, DeepSeek as the fallback on ANY failure (network, 20-second timeout, HTTP error such as 402 for no credit, an empty answer). Without the Moonshot key it goes straight to DeepSeek.
- **One switch:** the Worker secret `MODEL_ROUTES`, set from the **Model route** workflow (GitHub, Actions, run by hand: `action` set or clear, `routes` JSON). Keys are a route, a dotted prefix, or `*`; the most specific wins. `{"*":"deepseek"}` puts everything on DeepSeek; `{"interpret":["kimi",null]}` is Kimi alone for one route. The workflow refuses anything the router would not understand; the Worker ignores a bad entry rather than failing. **STAGING only**: a production version waits for Pierre's word. It takes effect at the next staging deploy.
- **The index cannot go stale:** `tools/model-routes.test.js` fails if any file but the router names a chat model or Moonshot, apart from the not-yet-moved list below, which can only shrink. Of the engine files only the interpreter may import the router.

## Moved
| Route | Status |
|---|---|
| `interpret` | on the router; real-model run 6 passed (10/10, 13/13) |

## Not yet moved (the ledger in the test: `UNMOVED`)
`ai.ts` (26 chat calls, plus whisper, bge embedding and rerank which are not retired), `converse.ts`, `debug.ts`, `trial.ts`, and the Moonshot front door `converse-moonshot.ts` (its own path, pinned to one fetch). Each moves to a named route, then comes off the ledger, with a real-model run on staging after each area.
