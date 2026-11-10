> **Status:** plan (2026-11-10), written on Pierre's instruction: "complete what we start and build progressively to a full stack". **Verified:** from `docs/CAPABILITY_MAP.md` and the committed CI and staging records. **Owns:** the ORDER in which the boxes of "done" are closed for what is already built; the board itself stays `docs/CAPABILITY_MAP.md`.

# Completing the stack for what is built, before adding rows

## Where it stands (engine and CI-tested, everything since the first slice)
| Group | Engine + CI | Real platform (staging) | Conversation (model) | App | MCP |
| --- | --- | --- | --- | --- | --- |
| Receivables, records, payments, invoices (the first slice) | ✓ | ✓ / partial | ✓ for read and payment | partial (recorded answers) | - |
| Customers and suppliers | ✓ | ✓ (`parties-proof`, 13 of 13) | - | - | - |
| Quotations | ✓ | ✓ (`quotations-proof`, 14 of 14) | - | - | - |
| Credit notes and follow-ups (apply, refund, undo, void, debit notes, business profile, tax lock, VAT summary) | ✓ | **not yet** (`stack-proof` is written, not run) | - | - | - |
| Expenses (and the VAT input side) | ✓ | **not yet** (same mode) | - | - | - |

## The order (each step is one increment, tests first, map and HANDOFF.md updated in the same commit)
1. **Real platform for the credit-note and expense groups.** The staging mode `stack-proof` (own business `staging-stack`, every figure read back from the object, owner / accountant / installer sessions) is written and pinned by the gate tests. **It runs only on Pierre's explicit word, each time.** A failure on a real object is information (the harness has accepted things a real Durable Object refused before), so the fixes are part of the increment.
2. **Conversation.** Teach the engine's interpreter the built capabilities (find a party, create or edit one, quote, credit, record an expense, read the VAT summary) with a written pass rule per capability and offline tests first; then ONE real model run on staging, judged against the rule (Pierre's word for that run too). The interpreter must keep proposing only: a person approves every write.
3. **Outside assistants (MCP).** The same capabilities through the same door (`invokeRead` and the proposals route), so nothing is re-implemented; test that an MCP caller gets exactly what a member gets, including the refusals.
4. **App.** Rooms that use the real client for what the engine offers (customers, quotes, credit, expenses, the VAT summary), replacing recorded answers; this needs Pierre's approval to connect and the Dart CI to stay green.
5. **Recovery.** Snapshot and restore with the new events and larger histories (the table-size limit is known: about 18 MB per table).
6. **Then new rows**, in the map's order (procurement next), each carried through the same boxes before the next starts.

## Rules that keep it honest
- A capability is not "done" until its row shows every box; the map shows dashes, never optimism.
- Staging and model runs are Pierre's call, each time. Writing a proof mode or an interpreter change is not running it.
- A CI result is checked before it is reported (the typecheck failure on three pushes on 2026-11-10 was missed because I reported before checking).
