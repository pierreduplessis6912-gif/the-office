> **Status:** plan (2026-11-10), written on Pierre's instruction: "complete what we start and build progressively to a full stack". **Verified:** from `docs/CAPABILITY_MAP.md` and the committed CI and staging records. **Owns:** the ORDER in which the boxes of "done" are closed for what is already built; the board itself stays `docs/CAPABILITY_MAP.md`.

# Completing the stack for what is built, before adding rows

## Where it stands (engine and CI-tested, everything since the first slice)
| Group | Engine + CI | Real platform (staging) | Conversation (model) | App | MCP |
| --- | --- | --- | --- | --- | --- |
| Receivables, records, payments, invoices (the first slice) | ✓ | ✓ / partial | ✓ for read and payment | partial (recorded answers) | - |
| Customers and suppliers | ✓ | ✓ (`parties-proof`, 13 of 13) | - | - | - |
| Quotations | ✓ | ✓ (`quotations-proof`, 14 of 14) | - | - | - |
| Credit notes and follow-ups (apply, refund, undo, void, debit notes, business profile, tax lock, VAT summary) | ✓ | ✓ (`stack-proof` run 5, 23 of 23; overpayment actions not covered) | - | - | - |
| Expenses (and the VAT input side) | ✓ | ✓ (same run) | - | - | - |

## The order (each step is one increment, tests first, map and HANDOFF.md updated in the same commit)
1. **Real platform for the credit-note and expense groups.** The staging mode `stack-proof` (own business `staging-stack`, every figure read back from the object, owner / accountant / installer sessions) is written and pinned by the gate tests. **It runs only on Pierre's explicit word, each time.** First run (2026-11-10, run 42903057444, on his word): it crashed part-way and wrote an empty record, so it proved nothing; the script now always writes a partial record (checks reached, response samples, crash trace). The second run (42917338482) showed why: every call got Cloudflare error 1010 (the default Python user agent is refused at the edge), so nothing was proven; fixed with a curl user agent. Run 3 (42962629257) is the first real result: **21 of 23 passed on a real Durable Object**; the two failures were the script's own mistake (it assumed the sample's invoice 2 is Mokoena's; the engine correctly refused a cross-customer application), now fixed. Run 4 (42970712819) reused the business with run 3's data and failed 3 checks on leftover state (credit totals accumulate; the tax lock only moves forward): the script was not re-runnable and now uses a fresh business each run. **Run 5 (42977535953, a fresh business) passed 23 of 23: step 1 is done for the credit-note and expense groups** (not covered on a real object: payment.allocate, payment.refund, the VAT summary's credit-note offset). A failure on a real object is information (the harness has accepted things a real Durable Object refused before), so the fixes are part of the increment.
2. **Conversation.** (Offline half BUILT 2026-11-10: `docs/decisions/interpreter-stack.md`, scripted-model tests, written pass rule. **Run 1 on the real model (42980816181) did NOT pass: understanding 11 of 14, safety 8 of 9, all invariants held.** Prompt fixes and diagnostics are in; run 2 needs Pierre's word.) Teach the engine's interpreter the built capabilities (find a party, create or edit one, quote, credit, record an expense, read the VAT summary) with a written pass rule per capability and offline tests first; then ONE real model run on staging, judged against the rule (Pierre's word for that run too). The interpreter must keep proposing only: a person approves every write.
3. **Outside assistants (MCP).** The same capabilities through the same door (`invokeRead` and the proposals route), so nothing is re-implemented; test that an MCP caller gets exactly what a member gets, including the refusals.
4. **App.** Rooms that use the real client for what the engine offers (customers, quotes, credit, expenses, the VAT summary), replacing recorded answers; this needs Pierre's approval to connect and the Dart CI to stay green.
5. **Recovery.** Snapshot and restore with the new events and larger histories (the table-size limit is known: about 18 MB per table).
6. **Then new rows**, in the map's order (procurement next), each carried through the same boxes before the next starts.

## Rules that keep it honest
- A capability is not "done" until its row shows every box; the map shows dashes, never optimism.
- Staging and model runs are Pierre's call, each time. Writing a proof mode or an interpreter change is not running it.
- A CI result is checked before it is reported (the typecheck failure on three pushes on 2026-11-10 was missed because I reported before checking).
