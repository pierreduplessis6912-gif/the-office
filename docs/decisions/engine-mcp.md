> **Status:** built and CI-tested on branch `engine-phase1` (2026-11-10): `tools/engine-mcp.test.js` (61 checks) and twelve deliberate breakages. **Not run with a real MCP client on staging**, and no real outside assistant has used it. **Owns:** how an outside assistant (an MCP client such as Claude Desktop) uses an engine business. Box 7 of "done" in `docs/CAPABILITY_MAP.md`.

# The outside-assistant (MCP) door for an engine business

## The rule
An outside assistant uses the engine through **the same door a member uses**, never a copy of it: a read goes through `invokeRead` and a proposal through `proposeCapabilityAs`, with the MCP key's own member (so the engine's permission, availability and validation rules answer exactly as they do in the app, with the same reasons). An assistant can **propose, never approve**: a proposal is HELD, a person approves it in The Office, and over MCP there is **no approve tool and no legacy tool** (an engine business still offers none of the legacy ones, which would read empty legacy tables and be wrong).

## What is offered
Three generic tools carry every capability, so nothing is re-implemented and a new capability needs no new tool (`worker/src/engine/mcp-engine.ts`):
- **`list_capabilities`** (read): what THIS member may do in THIS business: each capability with its kind (read or write), its label and a hint about the shape of the request (money in cents, tax in basis points, dates YYYY-MM-DD).
- **`read`** `{capability, params}` (read): any read capability the member may use: receivables, records, finding parties, quotations, expenses, credits, the VAT summary, the business details. The answer is the engine's own figure, the same one the app gets.
- **`propose`** `{capability, payload, note?}` (a **write-scope key only**): any write capability the member may use. Held for a person; the assistant's own words (`note`) are kept with the proposal; the trail records `source: mcp` and that an outside model interpreted it.

A tool is offered only if at least one capability it carries is **available in this business and permitted to this member**: a business that has switched nothing on offers nothing (as before), an installer is offered nothing, a salesperson sees only the quote capabilities, an accountant sees the money capabilities but not the owner-only business settings or the tax lock, and the owner sees everything. A read-only key never sees `propose` and cannot run it.

## Decisions (open to Pierre)
1. **Generic tools, not one tool per capability.** The engine has more than thirty capabilities and grows; a tool each would be a second copy of every contract. The cost is that an assistant must read `list_capabilities` for the shape of a request (the hints are one sentence each, and the engine's refusal says what is wrong); the benefit is that every capability is reachable the day it exists, with the same rules. A purpose-built tool for one or two very common requests can be added later if real use shows a need.
2. **An outside assistant proposes only.** Approving over MCP is not offered, even to an owner's write key. This differs from the legacy MCP, which had a confirm tool; the engine keeps approval with a person in The Office, as everywhere else.
3. **The key's scope still decides read versus write** (`mcp:read` or `mcp:write`, as on the legacy MCP); the member's role decides WHICH capabilities, through the engine's own permissions.
4. **Limits and audit are the existing MCP ones** (30 calls a minute, 500 a day, every call audited); requests and notes are size-limited (20,000 characters of parameters, 1,000 of note).
5. **The model-supplied note is evidence, not instruction**: it is stored as what was said, never executed.

## Evidence (labelled)
- **Test** (route harness with MCP keys): what is offered per key and role and per switched-on capability; the legacy tools still unknown in an engine business; `list_capabilities` per role; reads return exactly the figures the app returns (receivables, VAT summary, a record); every refusal (unknown or wrong-kind capability, not permitted, not available, invalid parameters, oversize, extra arguments, wrong types) writes nothing but bookkeeping; a proposal is held and writes only the capture, the interpretation and the held action (no fact), keeps the assistant's note, records the source and interpreter, and a person approving it in the app is the only way the party exists; an invalid proposal gets the SAME reason over MCP as in the app; a read key cannot propose.
- **Test** (deliberate breakage): twelve mutations (a read key offered propose, a member with nothing offered tools, read or propose accepting the wrong kind, the trail losing its source, interpreter or note, the answer not saying a person must approve, every key treated as all-powerful, the list ignoring permission or availability, no size limit).
- **Reviewed coupling:** `mcp.ts` now imports one name from one engine file (`engineMcpTools`), added to the reviewed list in `tools/engine-ownership.test.js` (R5).
- **Unknown / not done:** no real MCP client (Claude Desktop or another) has connected to a staging engine business; the legacy `confirm` and `reject` tools are deliberately not offered; MCP keys are issued by the existing key route (not changed); uploads and document links (legacy tools) have no engine equivalent yet.

## Next for this box
1. A staging proof with a real MCP key (Pierre's word): list, read, propose and approve in the app.
2. Purpose-built tools only if real use shows the generic ones are clumsy.
