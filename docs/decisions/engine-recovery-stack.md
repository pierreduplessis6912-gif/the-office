> **Status:** proven on the HARNESS (2026-11-10): `tools/engine-restore-stack.test.js` (16 checks) and three deliberate breakages. **Not** rehearsed on the real platform. **Owns:** box 8 of "done" (`docs/CAPABILITY_MAP.md`): snapshot and restore still pass with everything built since the first slice.

# Recovery with everything built since the first slice

## The risk
Nothing built since the first slice added a table or a column: it all went into the existing fact tables and into new EVENT types, and everything else (a party's current name and roles, the business profile and tax lock, a quotation's state, the credit left on a credit note, what a customer is owed back, an expense's input tax and claim date, the whole VAT summary) is DERIVED from those facts and events. So a restore that brought the tables back but left any derived answer different would be a silent loss. `tools/engine-restore.test.js` already proves the first slice's tables come back exactly; it could not show this.

## What the test does
It builds a business with a history through every capability since the first slice (party revisions, the business profile and tax lock, quotation revision and acceptance, credit notes, application, undo, refund, refund void and credit note void, a debit note, an overpayment allocated and refunded, expenses recorded and voided, a late expense claimed after a lock), takes a snapshot, **damages the business** (deletes movements, allocations, reversals and the new events, edits a fact, adds junk events), restores, and checks:
- the damage was real (the verifier reports it, the tables differ, and the derived answers differ too: so the equality below means something);
- every engine table is back **exactly** (rows, ids, relationships, order) and the **id sequences** are back exactly;
- **every derived answer is identical**: profile, tax lock, parties with their revisions, quotations and their states, the VAT summary for October and November (output and input sides), the expenses (recorded and voided), what the customer owes and is owed, the credit left on each credit note, and each document's tax particulars;
- the verifier is clean with no unmodelled-event warning, no relationship points at nothing, and the business carries on (the next expense continues the numbering, a recorded supplier invoice is still a duplicate, the tax lock still only moves forward).

## Result
**It passed first time: no code change was needed.** This is the expected payoff of the doctrine (facts and events are the only stored truth; everything else is derived): a restore of the tables restores every answer. The three breakages (children refilled before parents, the event table left out of a snapshot, the id sequences forgotten) each make the suite fail; the last one first survived and exposed a weak check (SQLite re-uses the next id after the highest one, so the ids continued anyway), which is why the test now compares the sequences themselves.

## Unknown / not done
- **The real platform:** a snapshot and restore on a real Durable Object with this history has not been rehearsed (the earlier rehearsals, `ops/staging-last-run.json`, predate these capabilities and the engine rehearsal step has a known problem with a used object); it needs Pierre's word.
- **Size:** the known limit stands (about 18 MB per table in a snapshot, `docs/decisions/snapshot-size-scoping.md`); a business with a very large history is not covered by this test.
- **Pre-migration rollback:** unchanged and covered by `engine-restore.test.js`; nothing here changes a table, so no new migration question arises.
