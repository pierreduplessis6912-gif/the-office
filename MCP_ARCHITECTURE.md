> **Status:** partly built. **Verified:** 2026-10-24. **Owns:** `worker/src/mcp.ts`, `worker/src/mcp-reads.ts`, `worker/src/mcp-effects.ts`, `worker/src/mcp-keys.ts`, `worker/src/mcp-key-format.ts`.

# An MCP server for The Office: the read-only adapter is BUILT (slices A to D); anything beyond it is not

**Status (corrected 2026-10-24): the read-only adapter is built and live; see "Status (2026-10-21)" at the end. The text from here to the appendix is the original 2026-10-04 proposal, kept as written.** It came from a design proposal pasted in by Pierre (the full text is in the appendix, unedited). This page keeps the proposal together with what was checked against the code the day it was pinned, so the next person does not have to rediscover it.

**The idea in one line.** Make The Office a standard MCP server, so any LLM host that speaks MCP (Claude, Cursor, ChatGPT, custom agents) can drive it, as just another client of the same API the Flutter app uses.

## Checked against the code (2026-10-04, on `main` at fb5b79a)

**Holds up:**
- **The single entry point is real.** Natural language goes in through `processTranscript` and out through the same checks as the app. The app's route for typed text today is `POST /messages/text` (the proposal calls its tool `speak`). A thin tool that wraps that path, instead of one tool per business action, is the right shape: it keeps the safety, identity and permission checks in one place.
- **Permissions are real.** `resolveCapabilities` exists and gates writes by role, so an MCP caller would be held to the same rules.
- **The confirmation loop exists.** Money and identity changes are held as pending actions and confirmed or rejected through `/actions/<id>/confirm` and `/reject`.
- **Principle 28 (retry safety) and `FEATURES.md` exist**, so the pieces it points at are there.

**Does not exist, so the proposal under-states the work:**
- **There are no member API keys.** Today a request is authenticated by a signed-in session (Google sign-in) or, for admin routes only, the shared `ADMIN_KEY`. The proposal's "API key scoped to a membership" and its `OFFICE_API_KEY` for a local adapter would be **new**: a way to issue, scope, rotate and revoke a credential per membership. That is the largest piece of real work, and the security-sensitive one.
- **There is no `/mcp` route and no request-level idempotency key** (the proposal's `idempotency_key`). Retry safety today is by content (Principle 28), not by a key the caller supplies. Whether a caller-supplied key is needed is open.
- **Its example reply is illustrative, not real.** The app returns one line per part of a message (for example "Job scope #76 updated — scheduled for Sat 17 Oct."), not a single merged sentence.
- **The proposal calls the user "Peter"** in two places; it is Pierre. (It is left as written in the appendix.)

**Not checked here, check before building:** the Cloudflare packages and calls it names (`@modelcontextprotocol/server`, `createMcpHandler`, `workers-oauth-provider`) and the claim that they are "well-supported" in 2026. They could not be looked up from here; read Cloudflare's current MCP documentation first.

## Concerns to settle before anyone builds it

1. **`confirm_action` must not be something the model can call on its own.** The proposal says the model may "ask the human to confirm or, if the host supports it, call confirm_action". If an LLM can confirm its own invoice, a payment or an identity link, then **nobody has confirmed it**: the one rule that makes The Office safe (money and identity are confirmed by a human) would be defeated, and a prompt hidden in a document or web page the model reads could trigger it. Safer shapes: expose only `list_pending` and `reject_action` to the model and leave confirming to the app, or require a separate human-held step (for example a one-time link the person opens).
2. **A write-capable door for any LLM host needs its own limits:** a per-credential rate limit and cost cap (every message costs a model call on the business's own account), a way to see which credential did what (the audit trail must say "via MCP, credential X", not just the person's name), and a kill switch per credential.
3. **Prompt injection.** A host model that reads untrusted text (an email, a web page) and then calls `speak` is relaying text the owner never wrote. The confirmation step is the main defence, which is why concern 1 matters.
4. **The "no anonymous fallback" line must hold for `/mcp` too**, and a credential must carry exactly one membership, so the role (installer, accountant, owner) limits what it can do.

## Decisions needed (none made)

- **Is it wanted at all, and for whom?** The owner's own use from a chat assistant, or other businesses' agents (the "sell it as a package" question)?
- **Where does it live?** (A) inside the existing `office-api` Worker; (B) a separate `office-mcp` Worker sharing the database; (C) a local stdio program that forwards to the live API. The proposal does not recommend one; it asks.
- **Credentials:** a long-lived per-membership key for non-interactive hosts, or "the person signs in with Google once and the session carries the membership"? The second needs no new credential type but suits only interactive hosts.
- **Confirming:** which of the shapes in concern 1.

## Appendix: the proposal, as pasted

Yes — this fits The Office unusually well. The system is already designed so **any client** (Flutter, WhatsApp, PWA, voice) is just a client of the API. An MCP server is simply another client, and because MCP is a standard, it becomes the “works in any LLM” entry point.

Here’s a concrete design that respects the Constitution and the existing architecture.

---

## Design principle

**Do not explode into 40 structured tools.**

The Office already has one real ingestion path:

```text
natural language → processTranscript → extraction → guard() → writes
```

That path is where all the safety, idempotency, identity resolution, and capability checks live. An MCP that reimplements “create_invoice” as a structured tool would bypass that and fight the design.

So the MCP surface should be:

| Kind | What | Why |
|------|------|-----|
| **Primary tool** | `speak` / `send_message` | Natural language in → Office pipeline → structured reply out |
| **Control tools** | `list_pending`, `confirm_action`, `reject_action` | Money/identity always needs explicit confirmation |
| **Read tools** | A small set of precise lookups | When the model needs data without re-narrating |
| **Resources** | Pending actions, recent captures, feature map | Context the model can pull on demand |
| **Prompts** | “Talk like Peter”, “Morning brief”, etc. | Optional, for consistent UX |

This keeps Principle 28 (retry safety), `guard()`, and capability checks intact.

---

## Recommended shape

### 1. Remote MCP on the existing Worker (primary)

Host it on Cloudflare next to `office-api`, e.g.:

```text
https://office.websitehub.co.za/mcp
```

or a dedicated Worker `office-mcp` that talks to the same D1/bindings / internal process path.

**Why remote first**
- Any LLM host that supports remote MCP (Claude, Cursor, ChatGPT, custom agents, Grok tooling, etc.) can connect with a URL + auth
- No local install required for the business owner
- Auth can reuse / extend the existing Google OAuth + session model

Cloudflare’s current path (2026) is well-supported:

- `@modelcontextprotocol/server` + `createMcpHandler` (stateless, Streamable HTTP)
- Optional `workers-oauth-provider` for proper MCP OAuth

### 2. Optional local stdio adapter

A thin Node process for Claude Desktop / Cursor local config:

```json
{
  "mcpServers": {
    "the-office": {
      "command": "npx",
      "args": ["@the-office/mcp-stdio"],
      "env": { "OFFICE_API_KEY": "..." }
    }
  }
}
```

That adapter just forwards tool calls to the remote API. One codebase, two transports.

---

## Minimal tool set (v1)

### Core

```ts
// 1. The main entry — everything flows through the real pipeline
speak({
  text: string,           // what Peter (or the agent) said
  history?: HistoryTurn[], // optional conversation context
  idempotency_key?: string
})
→ { status, reply, pending_actions?, effects? }

// 2. Confirmation loop (money / identity never auto-commits)
list_pending()
confirm_action({ id: number, edits?: Record<string, unknown> })
reject_action({ id: number, reason?: string })
```

### Lightweight reads (only what models actually need as tools)

```ts
lookup({ query: string })           // "what does Jenny owe", "open orders", etc.
                                    // can just call speak() under the hood
list_customers({ q?: string })
list_open_orders({ supplier?: string })
get_customer({ name_or_id: string })
```

Everything else stays inside `speak` so extraction + `guard()` remain the single source of truth.

### Resources (read-only context)

- `office://pending` — current pending actions
- `office://capabilities` — what this session’s role can do
- `office://features` — short map of departments (from FEATURES.md)
- `office://status` — high-level “what’s live” summary

### Auth

Every tool call must run under a real membership:

- **Remote:** Bearer token (session or API key scoped to a membership) or full MCP OAuth
- **No anonymous full-access fallback** (matches the security checklist you already closed)

Capabilities (`can_manage_invoices`, etc.) still gate writes exactly as they do today.

---

## How it sits in the codebase

```text
worker/
  src/
    index.ts          # existing HTTP routes
    mcp/
      server.ts       # create McpServer + register tools
      tools/
        speak.ts      # thin wrapper → processTranscript
        actions.ts    # list / confirm / reject
        lookup.ts
      auth.ts         # resolve membership from MCP request
    ...
```

Or a sibling Worker that imports/shares the same process primitives. Sharing `processTranscript` / `processOneExtraction` is important — don’t duplicate the pipeline.

---

## Example user experience in any LLM

User (or agent):

> “Invoice Jenny for R3 200 for carpet repair and schedule for the 17th.”

Model calls:

```json
speak({ "text": "Invoice Jenny for R3200 for carpet repair and schedule for the 17th" })
```

Office returns something like:

```json
{
  "reply": "Invoice noted for Jenny of R3,200 — needs your confirmation. Job scope scheduled for Sat 17 Oct.",
  "pending_actions": [{ "id": 8841, "type": "invoice", ... }]
}
```

Model then either asks the human to confirm or, if the host supports it, calls:

```json
confirm_action({ "id": 8841 })
```

Same safety model as the Flutter app and any future WhatsApp channel.

---

## Implementation order (practical)

1. **Spike** – one tool (`speak`) on a `/mcp` route, hard-coded test membership, Streamable HTTP  
2. **Auth** – real session/API key → `resolveCapabilities`  
3. **Confirm loop** – `list_pending` / `confirm` / `reject`  
4. **Resources + a couple of lookup tools**  
5. **stdio adapter** for local clients  
6. **Docs** – short “Connect any LLM” section in README + client config snippets  

This stays faithful to:

- “The API is the Office”
- Words must not return empty
- Money/identity always confirmed
- Capabilities are real, not decorative

---

## Want me to build the first cut?

I can scaffold:

1. `worker/src/mcp/server.ts` with `speak` + `list_pending` + `confirm_action` / `reject_action`
2. Wire it into the Worker’s `fetch` handler at `/mcp`
3. A minimal auth path (API key → existing membership)
4. A one-page connect guide (Claude Desktop / Cursor / remote URL)

Tell me which you prefer:

- **A)** Add MCP routes inside the existing `office-api` Worker  
- **B)** Separate `office-mcp` Worker that calls the same DB/bindings  
- **C)** Start with a local stdio-only server that proxies to `https://office.websitehub.co.za`

Also: do you already have (or want) a long-lived API key / service-account style credential for non-interactive LLM hosts, or should v1 stick to “human completes Google OAuth once, then the MCP session carries that membership”?

## Decisions made, and the design (2026-10-20, Pierre: "Yes" to the recommended shape)

**Decisions.** (1) For whom: the owner's own use, from a chat assistant (Claude, Cursor and the like), FIRST; other members and other businesses are not in scope until the owner use has been lived with. (2) Where: INSIDE the existing Worker (option A): a `POST /mcp` route, routed to the business's object, so authentication, roles, the database and the audit are reused, not duplicated. (3) Credentials: a READ-ONLY key per membership, issued by the owner, stored hashed, revocable, rate-limited, and every use recorded as "via MCP". (4) Confirming: does not apply in version 1, because there are NO writes: concerns 1 and 3 above (a model confirming its own action; prompt injection reaching a write) cannot arise until writes exist, and writes are a separate, later decision.

**Protocol (checked 2026-10-20 against public MCP documentation; no packages, nothing unverified).** A minimal STATELESS Streamable HTTP server: `POST /mcp`, JSON-RPC 2.0, plain JSON replies (no stream held open). Methods: `initialize` (answers with a protocol version the server supports, `2025-06-18` or `2025-03-26`, the `tools` capability and the server name), `notifications/initialized` and any notification (no `id`: HTTP 202, no body), `ping`, `tools/list`, `tools/call`. Errors follow JSON-RPC (-32700 malformed JSON, -32600 invalid request, -32601 method not found, -32602 invalid params); a tool failure is a normal result with `isError: true`; a missing or bad key is HTTP 401. `resources`, `prompts` and sessions are not declared, so a client must not call them.

**The credential, designed (not built).** Format `omk.<businessId>.<keyId>.<secret>`: the business id lets the Worker route the request to the right object WITHOUT a shared lookup (the same way signed links carry it; the Worker only peeks, the object verifies); `keyId` is public and random; `secret` is 32 random bytes, base64url. Only a SHA-256 hash of the secret is stored (the secret is high-entropy random, so a slow password hash is not needed), compared in constant time; the key is shown ONCE, at issue. Table `mcp_keys` in the business's own database: id, label, member address, hash, created_at, created_by, last_used_at, revoked_at, uses. On EVERY call: the key must exist and not be revoked; the membership must still be active; the capabilities are those of the member's CURRENT role (a demoted or deactivated member loses access at once), and the tools are a fixed read-only allowlist on top of that, so a key can never do more than its member could, nor more than read. No anonymous fallback: no key, a malformed key, another business's key, a revoked key or an inactive member is 401, and nothing is woken that need not be. A per-key rate limit and daily cap, because every call costs the business, and a kill switch (the Worker variable `MCP` set to `off`). The audit trail says "via MCP, key <id>" beside the member.

**Version 1 tools (all read-only, thin wrappers over what exists, each authorised by the route's own capability):** profit and loss for a period and comparison; aged debtors; a customer's receivables; the analysis (revenue, expenses, profit) for a period; recent history. No tool writes, confirms or rejects anything.

**The slices, in order, each tested before the next.** A) The credential core and its tests (issue, hash, verify, revoke, the adversarial cases). B) Owner-only routes to issue, list and revoke keys, their route policy and rehearsal. C) The `/mcp` endpoint and the five tools, with the rate limit and the "via MCP" audit. D) The app screen where the owner creates and revokes keys (until then a key is issued by an owner-only admin workflow, and never printed in a log). The credential slices are SECURITY-SENSITIVE: they get the deliberate-breakage tests (each guard is removed in turn and a test must catch it), a staging rehearsal on the real objects, and the diff shown to Pierre before they deploy.

## Status (2026-10-21): built, in production, and what is not verified

Slices A to D are built and live: the credential core, the owner's routes to issue, list and revoke keys, the `/mcp` endpoint with its five read-only tools, and the app's Assistants screen. The backend is proven by tests, by deliberate-breakage scripts (every guard removed in turn is caught: 16 + 9 + 15), on the real staging objects, and by the production probe. NOT verified: the app screen on a device and any real MCP client against production. To connect an assistant: in the app open Assistants, make a key, then give the assistant the address (the API address plus `/mcp`) and the key as a bearer token (`Authorization: Bearer <key>`). Hosts that let you set a header on a remote MCP server should work; hosts that only support OAuth for remote servers will not (OAuth would be new work). Writes remain a separate, later decision.


**A real client (2026-10-25, open item 3, in progress).** `tools/mcp-real-client.mjs` drives the endpoint with the official MCP SDK (1.32.1, pinned) instead of hand-written requests: connect with the issued key, list the five tools, read aged debtors and profit and loss, be refused an unknown tool and a bad key, close. It runs inside the staging rehearsal (before the key is revoked) and the verdict records only true or false. Proven so far: its mechanics against a stand-in server, and the backend suite (8,008/8,008). NOT yet proven: the real run on the staging objects, and any desktop or phone assistant on production.

**Production proof (2026-10-25).** The same SDK client, run by `prod-mcp-check.yml` with an owner-issued key (held as a temporary repo secret, since deleted), passed all nine checks against production: `ops/prod-mcp-check-last.json`. That key appeared in a chat and should be revoked. NOT proven: any assistant used day to day, claude.ai connectors (they need OAuth), and the Assistants screen on a device.

**OAuth for connectors (2026-10-25, open item 3b, slices 1 and 2 of 4: the core, and the routes on a branch, not merged or deployed).** claude.ai connectors cannot send a static key, so the Worker will act as its own OAuth server (the MCP spec's authorization flow) and the access token it issues will be an ordinary read-only key (`mcp-keys.ts`): scope, routing, rate limits, the audit and revocation in the Assistants screen stay exactly as they are. DESIGN, decided with Pierre: Google sign-in (the existing callback, so nothing changes in Google's console) then a consent page naming the assistant, business and account; OWNER only; read-only scope `mcp:read`; no refresh token (a key lives until revoked); PKCE S256 only; clients register themselves (RFC 7591) but only with the assistants' own return addresses (claude.ai and claude.com callbacks, or a loopback address); the client id, the consent ticket and the code are signed values (HMAC, SESSION_SECRET, one purpose label per kind), so nothing is stored but a used-code marker in the business's own database, which makes a code work once. SLICE 1, BUILT: `worker/src/mcp-oauth.ts` (pure functions) and `tools/mcp-oauth.test.js` (62 checks; ten deliberate breakages each caught). SLICE 2, BUILT (branch `mcp-oauth-2`, not merged): `worker/src/mcp-oauth-routes.ts` (the six public routes plus `/.well-known/` variants, and `continueOAuthSignIn`, called from the Google callback when a sealed `oauth_mcp` cookie is present: an active owner sees the consent page, anyone else is sent back as `access_denied`, no session is issued), `worker/src/mcp-oauth-issue.ts` (inside the business: owner re-checked, the code's `jti` recorded in `mcp_oauth_codes` so it works once, then an ordinary read-only key), the internal route `POST /debug/mcp-oauth-issue` (privileged), the `WWW-Authenticate` discovery header on `/mcp`, and the public-path lists (`auth.ts`, `routing.ts`, both read `OAUTH_PUBLIC_PATHS` from `mcp-oauth.ts`). The consent button needs the signed ticket and the nonce cookie of the same browser, and refuses a form from another site (a foreign `Origin`, or `Sec-Fetch-Site: cross-site`; `Origin: null`, which Chrome sends from this no-referrer page, is accepted when the browser does not say cross-site: found on Pierre's phone 2026-10-25); the page cannot be framed. Tests: `tools/mcp-oauth-routes.test.js` (38), breakage proof `tools/mcp-oauth-routes-breakage.js` (18 guards). The `index.ts` wiring is exercised on staging by `tools/mcp-oauth-client.mjs` (the SDK's OAuth client functions: discovery, registration, the authorize redirect, the refusals; booleans only, run by `staging.yml`). NOT covered by any automated check: the owner's Google sign-in and the consent button, which a runner cannot do; Pierre checks them live (slice 4). SLICES TO COME: 3 staging proof with the SDK's own OAuth client, 4 the live connector on claude.ai. Known trade-offs: the token does not expire; registration is open (stateless, so it cannot fill anything).

**Stage 1 of the capabilities roadmap, BUILT (2026-10-25, branch `claim/mcp-stage1-reads`, not yet merged or deployed):** six more READ-ONLY tools, eleven in all: `list_customers`, `list_jobs`, `list_invoices`, `list_quotes`, `get_stock` (paged, at most 100 rows, optional date and customer filters; the queries are in `worker/src/mcp-reads.ts`) and `get_document_link` (a signed link, 10 minutes, to ONE invoice, quotation or customer statement PDF that exists, made with the same `signDocumentPath` as the app's `/documents/sign`). All six are OWNER ONLY (a `ownerOnly` flag on the tool, checked in `permitted`): the installer's own-jobs scoping is not reproduced here, so no lesser role is offered them; widening that is a later, deliberate step. Still nothing here writes. Tests: `tools/mcp-endpoint.test.js` (34 checks); breakage proof `tools/mcp-endpoint-breakage.js` (25 guards; two older mutation targets had gone stale when OAuth changed `unauthorized()` and are repaired). Not verified: a real client calling the new tools on staging or production.

**Stage 2, the scope model and the creating tool (2026-10-26, branch `mcp-stage2-scope`, not merged or deployed).** Every key has a scope in `mcp_keys.scope`: `mcp:read` (every existing key, and the default) or `mcp:write`; anything that is not exactly `mcp:write` reads as read (an unknown value is refused at issue, an odd stored value is read, an old table with no column keeps working as read only). The owner chooses on the OAuth consent page, "Read only" ticked by default or "Read and create"; the choice rides the signed code to the key, and only the exact word `write` grants create. The app's key route accepts `scope` too, but the Assistants screen does not send it, so app-issued keys stay read only. ONE new tool, `tell_the_office` (`worker/src/mcp.ts`), listed and runnable only for a write key held by the OWNER: it runs the text through the same pipeline as a typed message (`processTranscript`, lent to the endpoint by `index.ts`), with the member's own capabilities; it creates only (no delete, payment or access change). Caps per key: 20 an hour and 100 a day, counted BEFORE the attempt runs (`mcp_creates`); over a cap nothing runs. FLAG, not block (Pierre, 2026-10-26): an invoice or quote over R50,000 is recorded and flagged in the answer and in `mcp_creates.flagged`. TAG: each call records the key, the capture and the ids the call created (`mcp_creates.created`). LIMIT OF THE TAG: ids are those above the highest before the call, so a record created by someone else at the same moment could be tagged to the key; treat the tag as advisory and do not build a bulk undo on it without exact tagging. Held questions are returned as `needsAnswerInApp`: the assistant cannot answer them. NOT built: the app's undo or void of what a key created, the Assistants screen's scope choice, edits and scheduling (stage 3), imports (stage 4). Tests: `tools/mcp-keys.test.js` (28), `tools/mcp-endpoint.test.js` (46), `tools/mcp-oauth.test.js` (64), `tools/mcp-oauth-routes.test.js` (40); breakage proofs 22 + 37 + 25 guards; backend 8,144/8,144 on both backends.

**Undo of what a connection created (2026-10-26, branch `mcp-undo-void`; backend only, not merged or deployed).** EXACT tagging (`worker/src/mcp-tags.ts`) replaces the earlier "ids above the highest" approach, which could tag someone else's record: the pipeline is handed a per-call copy of the environment whose database reports every INSERT into invoices, quotations, expenses, tasks, job_scopes and payments (by RETURNING id or last row id) and nothing else; `mcp.ts` writes them to `mcp_created_records` (one row per record, unique per table and id). A tracked insert whose id cannot be learned is counted (`mcp_creates.untraced`) and the answer says the undo may be incomplete. CORRECTION: `tell_the_office` CAN record a payment received (the typed-message pipeline does); it was described as unable to take payments, meaning it cannot move money. Pierre chose (2026-10-26) to allow it and make it undoable. THE UNDO (`worker/src/mcp-undo.ts`, routes `GET /mcp-created` and `POST /mcp-created/undo` with `{id}` (a tag's id) or `{call_id}`; owner only; works when MCP is off): an invoice is VOIDED, never deleted (Pierre, 2026-10-26: keep the number): status `void`, amount and retention amount to nothing so every figure that adds invoices up ignores it, description prefixed `VOID:`, the original saved. A quote (and its own line items), job, expense, task or payment is REMOVED after a copy of the row is saved in `mcp_created_records.snapshot`. Refused, with the reason and no change: an invoice with a payment against it; a quote turned into an invoice or a job; a job with an invoice, quote, measurements, tasks or recorded changes. A record is undone once; a whole call is undone newest first, one refusal never stopping the rest. A voided invoice has no document link (`get_document_link` says not found). KNOWN LIMITS: a voided invoice's PDF would still list its line items; a customer the call created is not removed; no redo (the copy is kept for a manual restore); the app screen for this is not built yet. Tests: `tools/mcp-tags.test.js` (8), `tools/mcp-undo.test.js` (28), `tools/mcp-created-routes.test.js` (9), endpoint 50; breakage proofs 10 + 22 + 39 guards; backend 8,193/8,193 on both backends.

**Fix: the consent choice was never sent (2026-10-26, branch `fix-consent-form`).** The "Read only / Read and create" radios on the consent page sat OUTSIDE the `<form>` that Allow submits, so the browser never sent the choice and every connection became read only whatever the owner ticked (found by Pierre's screenshots: his reconnected connector still listed only the 11 read tools). The earlier tests posted the field by hand and only checked the page text, so they missed it. The radios are now inside the form, and the tests read the real page the way a browser does (`tools/mcp-oauth.test.js`, `tools/mcp-oauth-routes.test.js`: tick, press Allow, send exactly what the form holds, then check the key's scope); three new breakage guards (28 in all). The page text was also corrected: it said a connection can never "take a payment", but a create connection can RECORD a payment received (undoable); it now says it cannot move money, and lists payments, scheduling and changes.

**Stage 3, scheduling and edits (2026-10-26, branch `mcp-stage3`; not merged or deployed).** Two STRUCTURED tools (a record and a value; no model reads free text), both write scope, owner only, counted against the SAME per-key limit as `tell_the_office` (20 an hour, 100 a day, counted before they run, `reserveWrite` in `worker/src/mcp.ts`), audited, closed by `MCP=off`. `schedule_job` {job_id, date}: today or later (at most to the end of the year after next), on a job that exists, ANY job (not only ones a connection made: scheduling deletes nothing and the old date is kept). It writes the same `job_scope_amendments` row the app writes, then the date. `edit_created_record` {kind, id, changes}: only a record TAGGED to a connection and not undone (the app's own records can only be changed in the app); only description and amount (invoice, quote), description, amount and category (expense), description and done (task), description (job); an amount is positive, at most R100,000,000, rounded to the cent. Refused with the reason and no change: an invoice that is void or has a payment; an invoice or quote AMOUNT when it has line items (it would stop matching them) or an invoice has retention; a quote that is not a draft or became an invoice. An invoice or quote amount set over R50,000 is changed and FLAGGED (flag only, as for creating). Every field changed records its old and new value in `mcp_changes` BEFORE the row changes (`worker/src/mcp-changes.ts`). The owner reverts one change in the app (`GET /mcp-created` now also returns `changes`; `POST /mcp-created/undo` takes `{change_id}`): it puts the old value back ONLY if the field still holds what the change set (otherwise 409 `changed_since`, nothing lost), and a reverted schedule also writes the amendment the app would. A job that was scheduled through the connector cannot then be removed by the undo of its creation (an amendment exists), which is the intended caution. NOT built: moving a job to a different installer, editing a customer's details, redo. Tests: `tools/mcp-changes.test.js` (28), endpoint 60, routes 12; breakage proofs 36 (changes) + 46 (endpoint) guards; backend 8,234/8,234 on both backends; app CI (analyze, tests, web compile) green.

**Held actions, tagging at confirm time, and confirm and reject tools (2026-10-26, branch `mcp-confirm`, built on top of stage 3; not merged or deployed).** FINDING (Pierre, live test): the pipeline HOLDS every money action (invoice, quote, expense, payment) as a pending action until it is confirmed (`POST /actions/:id/confirm`); the record is created only then, in a different request. So `tell_the_office` mostly returns held actions, and nothing was tagged, because the tagging only watched the call itself; the earlier tests used a stand-in that created records directly and hid it. NOW: (1) each held action a call produces is LINKED to the key and call that proposed it (`mcp_pending_links`, `worker/src/mcp-pending.ts`); `tell_the_office` answers with `held` (action id, kind, a short summary, whether the assistant may decide it) and `holdNote`. (2) When a linked action is DECIDED, by whoever decides (the owner in the app, or the assistant), the front door (`serveRequest` in `index.ts`, through `mcpDecision`) runs that one request with a database that reports what the confirmation creates, so the record is TAGGED exactly to that key and call, shows in the owner's list and can be undone; a decision that fails or is refused tags nothing, and a rejection tags nothing. `GET /mcp-created` also returns `held` (waiting, confirmed, rejected) and the app lists what is waiting. (3) TWO TOOLS, `confirm_pending_action` and `reject_pending_action` {action_id} (Pierre, 2026-10-26: Claude may confirm or reject its own proposals): write scope, owner only, counted against the same per-key limit, audited, closed by `MCP=off`, an invoice or quote or payment over R50,000 flagged. They act ONLY on an action THIS key proposed, still waiting, of a kind that needs only a yes (`CONFIRMABLE`: expense, payment, invoice, quote); anything that needs an answer (which person, which project) or changes what exists is refused and left to the app. They do not copy the confirm logic: `worker/src/mcp-act.ts` sends the request through the app's own route as the member the key belongs to, with a ONE-MINUTE session made inside the Worker and never shown to anyone, so the app's own gate, atomic write and decision log all apply. THE CONTROL THAT REMAINS: in claude.ai each tool can be set to "ask each time", which is the human check; set to "always allow", nothing but the limit, the flag and the undo stands between text the assistant reads and a recorded invoice or payment. Tests: `tools/mcp-pending.test.js` (14), `tools/mcp-pending-routes.test.js` (8, through the real front door), `tools/mcp-act.test.js` (5), endpoint 72, owner routes 12; breakage proofs 23 (held actions, wrapper and session) + 56 (endpoint) guards. `tools/harness.js` can now run a case through the real front door (`frontDoor: true`).

**Stage 4a, the upload link for photos and PDFs (2026-10-26, branch `mcp-upload`; not merged or deployed).** An assistant cannot pass a photo's bytes through a tool call, so `get_upload_link` (write scope, owner only, counted against the same per-key limit, audited, closed by `MCP=off`) makes a TICKET and returns a link; the OWNER opens it on their phone, picks a photo or PDF and sends it; `check_upload` {ticket_id} then tells the assistant what came of it. THE LINK: `/upload/<ticket>?sig=…`, a signature over that exact path (`signDocumentPath`, ten minutes), admitted by the gate in `auth.ts` for GET (a plain HTML page with no script, a file field and a note) and POST (the file) only, routed to its business by the router (`routing.ts`) like an invoice link; it is a `signed link` route in `ROUTE_POLICY.md`, refused to everyone who simply asks, the owner included. The ticket (`mcp_upload_tickets`) is checked AGAIN in the business on every use: not older than 10 minutes, at most 5 files, its key not revoked, its member still an active owner. Each use is claimed in one statement BEFORE the file is read, so a burst cannot get a sixth. The file is judged by CONTENT (a JPEG, a PNG or a PDF by its first bytes, not empty, at most 8 MB), never by its name or the browser's claim. It is then handed to the app's OWN `/files/photo` or `/files/document` route as the member (`mcp-upload.ts`, one-minute session as for confirm), so the app stores it, reads it, tells a supplier invoice from a delivery note or a statement and HOLDS anything that touches money; nothing of that is copied. The held action it produces is linked to the key (`mcp_pending_links`); an assistant may confirm only a kind that needs a yes AND that the owner can undo (expense, payment, invoice, quote), so a held SUPPLIER INVOICE is left to the owner in the app. A delivery note is recorded directly by the app's own rule (goods received); that, and the stored image and the capture, are NOT tagged or undoable here. The page shows the person only the app's own message, escaped. THE RISK: a new page that accepts an upload without a sign-in; it is bounded by the single-use-ish ticket, the signature, the content check and the size limit, and by what the app's own route does with a file (hold and confirm). A leaked link can send up to five files within ten minutes to the owner's pipeline, never record money. Tests: `tools/mcp-upload.test.js` (33; the gate, router, ticket, page, content check, pass-on, limits and outcome), `tools/mcp-upload-routes.test.js` (6; through the real front door and the real photo route), endpoint 80; breakage proofs 27 (upload) + 62 (endpoint) guards. NOT built: CSV imports (stage 4b), an assistant that can see the stored image, undo of a delivery note.

**Upload link: a file that was only stored is said plainly (2026-10-26, branch `mcp-upload-clarity`, found live).** Pierre's first real upload (a PDF of his OWN sales invoice, ZF21759) came back "received" with nothing said and nothing held. The path worked: the app read it and classified it `other` with no subject (his history shows the document entry), and the app's rule is to record nothing without a supplier named in the note; but the app returns no message in that case, so the page and `check_upload` said nothing. NOW `receiveUpload` always says what the Office did: the app's own message if it had one, otherwise that the file was stored, not recognised as a supplier invoice, delivery note or statement, nothing recorded, send it again with the supplier's name; a PDF with no readable text (a scan, or one that could not be parsed) says so and suggests a clear photo. `check_upload` entries gain `recognised` (false when it only stored the file, or failed) and `read` (the start of the text the Office found, cleaned, cut to 300 characters). The page's note box is now "Who is it from?" with the reason, and `get_upload_link` tells the assistant to ask the owner for the supplier's name BEFORE giving the link. A document the owner issued himself (a sales invoice) is not a supplier document and is not recognised: reading those would be a new feature (his earlier invoices came in through the app's Invoice Simple import). Tests: `tools/mcp-upload.test.js` now 39; breakage 34 upload guards.

**Upload link: native attachments through Claude's sandbox (2026-10-26, branch `mcp-upload-attach`).** Pierre asked whether the chat's + button can be used. The attachment goes to Claude, not to a connector tool, but Claude's code sandbox holds the file and can SEND it to the upload link with curl, if the sandbox may reach the Office's address: in claude.ai Settings, Capabilities, Code execution and file creation, Allow network egress, Additional allowed domains: `office.websitehub.co.za` (an account-wide list; applies to new chats; Pierre added it). PROVEN on real data 2026-10-26: from a chat with a PDF attached, `get_upload_link` then `curl -F file=@... <url>` answered 200 "Sent", and `check_upload` returned the Office's own decision and what it read. The `get_upload_link` description now tells the assistant to do this only when the owner attached the file and asked it to send it (supplier name as the caption), to check the result, to fall back to handing over the link when the address cannot be reached, and never to upload anything nobody asked it to send. No code path changed: it is the same signed link, ticket and limits. Because the link is still the only door, the sandbox needs no key and no new route.

**Customer phone and email (2026-10-27, branch `customer-contact`; Pierre: "phone numbers are not stored in the customer profile").** FINDING: a customer record had only a name, an address, a VAT-exempt flag and a retention rate. A stated phone number or email was recognised, tidied (international form) and saved as a loose note in `customer_facts`, which nothing read, so it was kept but never shown (and not by the connector). The Office's own rule for a fact that earns a column (`memory.ts`, `applyStructuredFact`) is a deliberate migration; this is it: `worker/migrations/0003_customer_contact.sql` adds `customers.phone` and `customers.email` and backfills each customer with the LATEST phone and email already noted (never overwriting one that is there); it reaches every business within the hour (additive, runs once). A stated number is now saved to the column only if it is a real phone number (international form), an email only if it looks like one; the note is still kept, so what was said before is never lost. `GET /customers` and the connector's `list_customers` carry both and can be searched by them; `PATCH /customers/:id` sets them (checked, refused whole if either is bad) or clears them with an empty string; a customer merge carries them to the one that stays, only where it has none. The app's customer profile shows them. Tests: `tools/customer-contact.test.js` (13), `tools/customer-contact-routes.test.js` (8), endpoint 82, app `customer_contact_model_test.dart`; breakage 20 + endpoint guards. NOT built: editing them in the app's profile (they are saved by saying them, or by the PATCH route). DOCUMENTS (2026-10-27, branch `pdf-contact`, Pierre: a quotation showed the address but not the saved number, because the generators read only name and address): quotations, invoices and statements now print the phone and then the email under the address in the customer's block, only when the customer has them (`finance.ts`, `generateDocumentPdf`, `generateStatementPdf`, `drawColumnLine`); a line too wide for the column is made smaller and then cut with `...`, and a character the PDF font cannot draw becomes `?`, so what a person typed can never make a document fail; the business's own header is untouched. Tests: `tools/pdf-contact.test.js` (9, reading the text of real generated PDFs); breakage 10 guards.

**Ledger read tools (2026-10-27, branch `mcp-read-tools`; not merged or deployed).** Three owner-only READ tools in `worker/src/mcp-reads.ts`, so an assistant can check what it created: `list_expenses` and `list_payments` (newest first; from, to, customer_id; `via_connection` is true for a record a connection created and has not had undone, read from `mcp_created_records`) and `list_held_actions` (every held money action; `state` filter; kind, state, short summary, times, and whether and which connection proposed it, read from `mcp_pending_links`). Only SELECT; the stored transcript and the raw payload are never returned (the summary is the same safe one the owner's list uses); a business with neither connection table answers normally. Fourteen read tools and seven write tools, twenty-one in all. Proven by `tools/mcp-endpoint.test.js` and four deliberate breakages (owner-only removed, undone tags counted, payload leaked, state filter ignored: each fails a test). NOT verified on real data yet: see `PHONE_TEST_SCRIPT.md`.

**Claude confirms more kinds, first slice: stock add and customer detail (2026-10-27, branch `mcp-confirm-more`; not merged or deployed).** Pierre: confirmations should be done through the connection, not by sending people to the app, for every kind including ones that need an answer, but only where the owner can put it back, adding an undo as each kind is built. This slice makes `stock_add` and `customer_fact` confirmable (`CONFIRMABLE` in `worker/src/mcp-pending.ts`, now six kinds). They create no tracked record, so `worker/src/mcp-effects.ts` keeps a copy of what the decision is about to touch (stock quantities by name; the customer's row and note ids) and, once the app's own confirm succeeds, tags exactly what changed in `mcp_created_records` (tbl `stock_add` or `customer_fact`, the held action's id, the copy as the snapshot). The owner's undo (`POST /mcp-created/undo`) puts back exactly that in one transaction, and REFUSES, writing nothing, if the stock was used or counted since (the quantity is not what the add left), an item the add created has a usage or stocktake record, the customer detail was changed again, or the record of the change is unreadable. A decision that changed nothing is not tagged. The owner's list shows them as `stock add` and `customer fact`; the app reads them since the same build as this branch. Proven by `tools/mcp-effects.test.js` (19) and 17 deliberate breakages in `tools/mcp-effects-breakage.js`. The other kinds (goods received, link order, job scope amendment, convert quote; then supplier invoice, supplier payment, variance disposition, cancel and reopen order; then the three that need an answer) follow the same way, each with its own undo.

