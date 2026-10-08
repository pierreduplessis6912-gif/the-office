# An MCP server for The Office: PROPOSED, pinned 2026-10-04, not built

**Status: an idea, pinned for later. Nothing here is built, and nothing here is decided.** It came from a design proposal pasted in by Pierre (the full text is in the appendix, unedited). This page keeps the proposal together with what was checked against the code the day it was pinned, so the next person does not have to rediscover it.

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
