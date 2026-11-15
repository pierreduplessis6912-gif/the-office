> **Status:** proposed. **Verified:** not yet. **Owns:** none.

# DECISIONS: general-ledger

Written 2026-11-15 by the build chat, at Pierre's word ("the idea is a general full-stack ERP", then "yes" to designing the ledger first). A DESIGN FOR APPROVAL: it authorises no code. Evidence labels: [C] code read, [T] test, [D] a document in the repository, [I] inference, [U] unknown.

## Why this first
The engine records business facts well (parties, documents and lines, money movements, allocations, reversals, stock moves, each with an event) but has no general ledger: no chart of accounts, no journal, no double entry [C: nothing of the kind in `worker/src/engine/`; the 2026-11-02 blueprint says the same, `docs/audit/DOMAIN_BLUEPRINT_2026-11-02.md` row 4]. What exists is sub-ledger arithmetic: what a customer owes, what a bill owes, what stock is worth, each derived in `ledger.ts` and `stock.ts` [C]. A general ERP needs one place where every financial fact lands as balanced debits and credits, because the balance sheet, the profit and loss, VAT returns, bank reconciliation, period close and cash flow are all views of it. Retrofitting it after more capabilities exist means touching all of them again, so the cost is lowest now. There is also NO real engine business yet (only staging samples [D: coexistence scoping]), so nothing has to be migrated.

## What the engine already gives the ledger [C]
- ONE write path for facts (`facts.ts`): every operation is one transaction, only inserts, and records an event with who, which contract and which approval. A mistake is corrected by a reversal fact, never an edit.
- Money is whole cents, quantities thousandths, tax basis points; no floating point (`money.ts`).
- A business-wide tax lock date exists (`setTaxLock`).
- A read-only integrity verifier (`integrity.ts`) with a model of events and facts, which this design extends.
- Stock moves carry a value (moving average cost), expenses carry whether input VAT is claimable.

## Decision 1. Stored or derived? (recommended: stored, written in the same transaction)
| Option | What it is | For | Against |
|---|---|---|---|
| A. Derived on read | The journal is a pure function of the facts, computed when asked | One source of truth; cannot disagree with the facts | A posting-rule change rewrites history; a closed period can silently change; every report re-derives everything (cost grows with the business); no stable thing to audit or lock |
| B. Stored, posted atomically (recommended) | Each fact operation also INSERTS its balanced journal entry in the SAME transaction; entries are never edited, reversed by a contra entry | History stays as it was posted; periods can really close; reports read one indexed table; auditors get a stable record | Two things must agree (facts and entries): that is checked, below |
B is how accounting systems are expected to behave: what was posted stays posted. The risk of two sources is handled by making the agreement a CHECKED INVARIANT, not a hope (Decision 6).

## Decision 2. The chart of accounts
- Per business, configured, seeded from one standard template for small businesses (assets, liabilities, equity, income, cost of sales, expenses). The template is data, not code, so it can be changed without a deploy.
- **System roles.** The engine never posts to an account by name or number. It posts to a ROLE (receivables control, payables control, VAT output, VAT input, inventory, goods received not invoiced, cost of sales, sales, bank, cash, stock adjustments, rounding, suspense, retained earnings, one expense role per existing expense category). The business maps each role to an account. The owner can rename or renumber accounts without breaking any posting.
- Accounts and mappings are append-only facts with a revision history (same rule as parties). An account that has been posted to can be deactivated, never deleted.
- Payment methods map to a bank or cash account per method (EFT and card to a bank account, cash to the cash account, configurable).

## Decision 3. Posting rules (which event posts what)
Plain statements, each becomes tests before code. "Dr" is debit, "Cr" credit.
| Fact | Entry |
|---|---|
| Invoice issued | Dr receivables control (gross); Cr sales (net); Cr VAT output (tax) |
| Credit note issued | the invoice entry reversed for the credited lines |
| Debit note issued | as an invoice |
| Payment received | Dr bank or cash (by method); Cr receivables control |
| Allocation of a payment to an invoice | no entry (it moves nothing between accounts; it only matches) |
| Refund | Dr receivables control; Cr bank or cash |
| Expense recorded (paid) | Dr the category's expense account (net, plus any non-claimable VAT); Dr VAT input (claimable VAT only); Cr bank or cash |
| Goods received | Dr inventory (value received); Cr goods received not invoiced |
| Supplier bill recorded | Dr goods received not invoiced (up to what was received); Dr expense or inventory for any difference; Dr VAT input (claimable); Cr payables control |
| Three-way match variance accepted | the difference goes to a variance account, never hidden in inventory |
| Supplier payment | Dr payables control; Cr bank or cash |
| Stock issued or sold | Dr cost of sales; Cr inventory (at the engine's moving average cost) |
| Stock count variance, write-down | Dr stock adjustments (or write-down); Cr inventory |
| Stock transfer between locations | no entry (inventory total is unchanged) |
| Any reversal fact | the original entry reversed by a contra entry dated as the reversal says |
| Quotation, purchase order, reservation | no entry (not financial events) |
Anything the engine cannot place goes to a **suspense** role that a report lists, rather than failing the business's work or being guessed. A suspense balance is a visible defect, not a hidden one.

## Decision 4. Periods and manual journals
- One **books locked up to** date, generalising the existing tax lock: posting into a locked period is refused and the message says which date to use instead. Unlocking is itself a recorded, approved fact.
- **Manual journals** exist (accruals, prepayments, depreciation until fixed assets exist) but are HELD PROPOSALS like everything else: a reason is required, the person approves, they must balance, they are never edited, and a mistake is a reversing journal. A new permission, `journal.post`, kept apart from the others.
- Opening balances for a business starting on the engine are one dated, approved opening journal.

## Decision 5. Currency (recommended: one currency per business to start)
Documents carry a currency [C]. Version one posts only in the business's own currency; a foreign-currency document is refused at posting with a plain message. Foreign exchange (rates, revaluation, realised and unrealised gains) is its own design later. This is a deliberate limit, said out loud.

## Decision 6. What must always be true (the invariants, each with a deliberate breakage)
1. Every entry balances: the sum of debits equals the sum of credits, in whole cents. Entry lines are positive; a line is either a debit or a credit, never both.
2. Every entry points at the one event that caused it, and every financial fact operation has exactly its expected entry (none missing, none twice).
3. The trial balance sums to zero at any date.
4. **Control accounts equal the sub-ledgers:** receivables control equals the sum of what customers owe (`ledger.ts`); payables control equals the sum of supplier bills outstanding; inventory equals stock valuation; VAT output and input equal the existing VAT summary. If the two ever differ, the integrity verifier reports it by account.
5. The bank and cash accounts equal the sum of the money movements by method.
6. No entry is edited or deleted; the existing scan that forbids `UPDATE` and `DELETE` of facts covers the new table.
7. Nothing posts into a locked period.
8. Posting rules are tested against the facts' own totals, so the ledger cannot quietly disagree with an invoice's printed total.
These extend `integrity.ts` and the role-matrix umbrella, and each gets a deliberate breakage in `tools/engine-breakage.js`, as every other capability did.

## Decision 7. What the person sees and can ask
- Reads (all derived from the journal, all through the existing read door and permissions): trial balance, an account's ledger, balance sheet, profit and loss, VAT control, cash and bank position, and a suspense report.
- A new read permission, kept narrower than receivables read.
- The assistant and the app get these as read-only rooms and sentences ("What is my profit this month?", "Show the trial balance"), after the backend is proven. No figure is computed in the app.
- The profit and loss and VAT figures must agree with what the engine already reports (invariant 4 covers VAT; a new test pins profit and loss against the expense and invoice reads).

## What this deliberately does not do (said so nothing is assumed)
Bank feeds and statement matching (a later design: reconciliation needs this ledger first), fixed assets and depreciation, budgets, multiple currencies, consolidation of several businesses, payroll posting, and cost centres or analytic dimensions (the entry line will have room for one optional dimension later, left empty now).

## Size and recovery [I, U]
A journal roughly doubles the rows written per financial fact. The snapshot edge is per table (`snapshot-size-scoping.md`), the journal is its own table, and entries are small, so the first likely table to reach the edge is still the stock move table, not the journal [I]. To be measured on the real object during staging, not assumed [U]. Backup and restore must include the new tables and keep passing.

## Proposed build order (each step tests first, deliberate breakages, then a staging proof)
1. **G1, the core.** Tables (accounts, role mapping, entries, lines), the posting function inside the one write path, the chart template, invoices, credit and debit notes, payments, refunds. Invariants 1 to 3, 6 and 8 for those.
2. **G2, purchases and stock.** Expenses, goods received, supplier bills with the match and variances, supplier payments, stock issues, adjustments and write-downs. Invariants 4 and 5 live.
3. **G3, periods and journals.** The lock, manual journals as held proposals, opening balances. Invariant 7.
4. **G4, the reads.** Trial balance, account ledger, balance sheet, profit and loss, suspense report, with the assistant sentences and read-only app rooms.
5. **G5 (separate design).** Bank reconciliation and cash flow.
After G2, a real-model run to check the sentences for the new reads is a separate step, and only on Pierre's explicit word, as before.

## Questions for Pierre
1. Is stored-and-posted-atomically (Option B) right, rather than deriving the ledger on read?
2. One currency per business to start: agreed?
3. Is the standard small-business chart template enough to start, with the owner mapping roles, or do you want a South African chart (by SARS and common practice) built as the template? I would build the simple template first.
4. Should the books lock be one date for everything (as the tax lock is today), or separate dates for tax and for the books?

## G1 as built (2026-11-15) and where it differs from the design
- Built: migration 0006 (eng_account, eng_account_role, eng_journal_entry, eng_journal_line), journal.ts (rules and reads), writes only in facts.ts, integrity checks (journal_unbalanced, journal_contra_mismatch, journal_missing). Covers invoices, debit notes, credit notes, payments received, refunds and their reversals (contra entries). Suite: tools/engine-gl.test.js (44 checks) and 8 deliberate breakages ("ledger:" in engine-breakage.js).
- The chart is seeded ONCE, by one `ledger.chart_seeded` event on the business's first posting (not one event per account as first drafted).
- DEVIATION: a fact in another currency than the ledger's is NOT refused; it is left unposted and the verifier reports the warning `unposted_foreign_currency`, so no existing capability stops working. Revisit with multi-currency.
- Not yet: purchases, expenses, stock (G2); periods, manual journals, opening balances (G3); trial balance and statements as reads, assistant sentences, app rooms (G4).

## G2a as built (2026-11-15): expenses, supplier bills, money paid out
- Purchase posting lives in `recordDocument` (category and VAT facts travel in the document's terms; an older document with no category falls into "other"). Expense and bill: Dr the category's expense account (net, plus VAT that cannot be claimed), Dr VAT input (claimable VAT only), Cr payables control.
- DEVIATION from the rule table: an expense does not credit the bank directly. The document credits payables and its payment (its own money-out movement) debits payables and credits bank or cash, so each fact balances and reverses by itself and payables control still equals what the bills owe.
- Every money-out movement posts Dr payables control, Cr bank or cash, except a refund to a customer, which posts against receivables. Capital purchases post to their category's expense account (no fixed-asset account yet).
- Tests: tools/engine-gl-purchases.test.js (25 checks) and 7 more deliberate breakages. Still to do in G2: goods received, bill matching against goods received (GRNI and variances), stock issue, adjust, write-down (G2b).

## G2b as built (2026-11-15): stock and goods received
- One rule per stock move kind, at the move's own stamped value (insertMove in facts.ts): receive from a goods receipt Dr inventory, Cr goods received not invoiced; receive with no document behind it Dr inventory, Cr SUSPENSE (cannot be placed, so it is visible); issue Dr cost of sales, Cr inventory; customer return Dr inventory, Cr cost of sales; any other adjustment, count variance or write-down through stock adjustments; transfer (value 0) nothing; reversal = contra of the original's entry, dated as the reversal says. Entries use source kind `stock_move` (migration 0006 edited in place: it had never been deployed anywhere).
- A bill for an order clears goods received not invoiced up to what was stocked from that order's receipts (less what earlier bills cleared), the rest is expense. No double count; a part bill leaves the rest in received-not-invoiced, which is the list of what is received but not yet billed.
- DEVIATIONS / LIMITS: purchase price variances are NOT split out (the `purchase_variance` account exists but is unused): a bill priced differently from the receipt leaves the difference in received-not-invoiced (bill lower) or in expense (bill higher). Goods receipts that are never put into stock post nothing. Opening stock entered by hand sits in suspense until G3 opening balances.
- Invariant live: inventory account = value of stock on hand. Tests: tools/engine-gl-stock.test.js (24 checks) and 8 more breakages.

