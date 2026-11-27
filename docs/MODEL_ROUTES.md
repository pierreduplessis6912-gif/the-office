# Model routes: every place The Office calls a model

Why this exists: Cloudflare retired `@cf/moonshotai/kimi-k2.6` on 2026-11-20 (HTTP 410, code 5028) and the name was written in about 30 places. Now every chat-model call goes through ONE door, and changing a model is a switch, not a hunt. `tools/model-routes.test.js` fails if a route the code asks for is missing from this page, or if any file other than the router names a chat model.

## How it works (built 2026-11-27)
- **One door:** `worker/src/model-routes.ts`. `chat(env, "<route>", { messages, temperature?, maxTokens?, timeoutMs? })` returns the text, which model gave it (`via`), or the reasons it failed. `ai.ts` reaches it through `askChat`, which answers in the shape its callers always read and throws when no model answered, so retries and every caller's catch behave as before.
- **One catalogue:** `kimi` (Kimi `kimi-k2.6` at Moonshot, thinking disabled, needs the Worker secret `MOONSHOT_API_KEY`) and `deepseek` (`@cf/deepseek-ai/deepseek-v4.1-flash-1017` on Cloudflare, `reasoning_effort: "none"`). Adding a model is one entry there plus its name in the workflow.
- **One default:** Kimi first, DeepSeek as the fallback on ANY failure (network, 20-second timeout, HTTP error such as 402 for no credit, an empty answer). Without the Moonshot key it goes straight to DeepSeek.
- **One switch:** the Worker secret `MODEL_ROUTES`, set from the **Staging model secrets** workflow (GitHub, Actions, run by hand: `action` = `route-set` or `route-clear`, `routes` = JSON; it lives in the existing staging-secrets workflow because a new workflow file cannot be started until it is on `main`). Keys are a route, a dotted prefix, or `*`; the most specific wins. `{"*":"deepseek"}` puts everything on DeepSeek; `{"interpret":["kimi",null]}` is Kimi alone for one route. The workflow refuses anything the router would not understand; the Worker ignores a bad entry rather than failing. **STAGING only**: a production version waits for Pierre's word. It takes effect at the next staging deploy.

## What may go to Moonshot (decided 2026-11-27)
Pierre agreed that **the person's own sentences** may go to Moonshot. He has not agreed to anything else. So the routes below marked **records** send more than the person's own words (stored records, uploaded documents, the conversation's history, which holds what The Office answered, or a photo) and stay on Cloudflare by default: DeepSeek, with NO fallback to Moonshot. Neither `*` nor a prefix override can move them; only an override that names the route exactly can (`{"memory.answer":"kimi"}`). A change to this list needs Pierre's word.

## The routes (27)
| Route | Where | What it does | Goes to |
|---|---|---|---|
| `interpret` | engine/interpret.ts | reads one sentence into one capability | own words: Kimi, then DeepSeek |
| `split.topics` | ai.ts splitIntoTopics | splits a message into separate topics | own words |
| `extract.intent` | ai.ts extractIntent | what the person means (the big one) | own words |
| `extract.line_items` | ai.ts extractLineItems | quotation and invoice lines | own words |
| `extract.stock_item` | ai.ts extractStockItemRegistration | registers a stock item | own words |
| `extract.unit_conversion` | ai.ts extractUnitConversion | a stock unit conversion | own words |
| `extract.snag` | ai.ts extractSnag | a defect on a job | own words |
| `extract.lead` | ai.ts extractLead | a new lead | own words |
| `extract.work_observation` | ai.ts extractWorkObservation | something seen on a job | own words |
| `extract.purchase_order` | ai.ts extractPurchaseOrder | a purchase order | own words |
| `classify.expense_category` | ai.ts classifyExpenseCategory | the category of an expense | own words |
| `classify.dashboard_intent` | ai.ts classifyDashboardIntent | which dashboard a question is about | own words |
| `classify.backward_reference` | ai.ts containsBackwardReference | whether a message refers back | own words |
| `extract.scope_pricing` | ai.ts extractScopePricing | prices a scope against the job's components and tasks | **records** |
| `extract.goods_received` | ai.ts extractGoodsReceived | goods received against the order's lines | **records** |
| `extract.supplier_invoice` | ai.ts extractSupplierInvoice | a supplier invoice against the order's lines and expected prices | **records** |
| `extract.variance_disposition` | ai.ts extractVarianceDisposition | what to do about a variance | **records** |
| `extract.stock_usage` | ai.ts extractStockUsage | stock used, against the stock list | **records** |
| `extract.stocktake` | ai.ts extractStocktake | a stocktake, against the stock list | **records** |
| `extract.snag_resolution` | ai.ts extractSnagResolution | a snag fixed, against the open snags | **records** |
| `extract.lead_lost` | ai.ts extractLeadLost | a lead lost, against the open leads | **records** |
| `extract.supplier_statement` | ai.ts extractSupplierStatement | an uploaded supplier statement | **records** (a document) |
| `extract.document_identity` | ai.ts extractDocumentIdentity | who an uploaded document is from | **records** (a document) |
| `resolve.follow_up` | ai.ts resolveFollowUpEntity | who a follow-up message is about | **records** (history) |
| `classify.topic` | ai.ts classifyBusinessTopic | the standing topic of a conversation | **records** (history) |
| `memory.answer` | ai.ts answerFromMemory | answers from remembered facts | **records** (stored facts) |
| `vision.describe` | ai.ts describeImage | describes a photo | **records** (a photo) |

## Not on the router yet (the ledger in the test: `UNMOVED`)
`converse.ts` (the in-Worker reply), `debug.ts` (an admin diagnostic), `trial.ts` (a timing probe): each still names the retired Cloudflare Kimi and fails today. The Moonshot front door `converse-moonshot.ts` calls Moonshot directly on its own path (its own tests pin its one fetch). The speech and search models, `@cf/openai/whisper`, `@cf/openai/whisper-large-v3-turbo`, `@cf/baai/bge-base-en-v1.5` and `@cf/baai/bge-reranker-base`, are not chat models and are not on Cloudflare's retirement list; they are called directly.

## Proven on staging (2026-11-27)
- The attention sentences through the `interpret` route, default (run 46036545010): 23 of 23 read by `moonshot:kimi-k2.6`, passed 10/10 and 13/13.
- Flipped with `route-set {"*":"deepseek"}` (run 46037824906): 23 of 23 read by `cloudflare:deepseek-v4.1-flash-1017`, passed 10/10 and 13/13. The switch works end to end. Cleared with `route-clear`.
- Still to prove: the `ai.ts` routes, area by area, with the existing staging model runs (stock, procurement, jobs, the stack run and the general run).

## Proving the `ai.ts` routes on staging
`POST /debug/extract-probe` (admin key, writes nothing; `worker/src/extract-probe.ts`) calls one allowed `ai.ts` function and reports which model answered. Staging mode `extract-model-run` asks 14 cases through it; the pass rule is `docs/decisions/extract-model-run.md`, written before the run. Record: `ops/staging-extract-model-run-last.json`. Not yet run (waiting for Pierre's word).
