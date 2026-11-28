> **Status:** unaudited. **Verified:** not yet. **Owns:** none.

> **Status:** approved 2026-11-16 (Pierre: year-end is a setting defaulting to February; reopening allowed with a reason); P1, P2 and P3 built. **Verified:** not yet. **Owns:** none.

# DECISIONS: year-end-close (periods)

Written 2026-11-16 by the build chat after the general ledger (G1 to G4) and bank reconciliation (G5) went green. A DESIGN FOR APPROVAL: it authorises no code. Evidence labels as in general-ledger.md.

## Why
Today the balance sheet shows "earned so far": every profit and loss since the business began sits in one figure, because no year is ever closed [C: `balanceSheet` in ledger-reports.ts]. Profit and loss is correct for any period, but a balance sheet from three years ago, a tax-year figure, and an indirect cash flow (profit adjusted for what moved in receivables, payables and stock) all need the profit of each finished year moved into equity, and that year protected from change. The chart already has a `retained_earnings` role (3100) that nothing posts to yet [C: journal.ts].

## What already exists [C]
- A books LOCK date (one date; nothing posts on or before it; moving it back needs a reason). A manual journal (owner-only, balanced, with a reason) and its reversal. Contra entries. A trial balance and profit and loss for any date range.

## Decision 1. What "closing a year" is
Closing a financial year is ONE recorded fact (an event, `year.closed`, owner only) that does three things in one transaction:
1. Posts a CLOSING JOURNAL dated the last day of the year: every income, cost-of-sales and expense account is brought to nothing and the net (profit or loss) is posted to retained earnings. It is an ordinary balanced entry (source "manual", carried by the closing event), so every report and the verifier treat it like any other.
2. Moves the books lock to the last day of the year (so the year cannot change), in the same transaction.
3. Records the year (start, end, profit in cents, closing entry) so it can be listed and so a reopen has something to undo.

Nothing is deleted or edited. The year's earlier entries stay exactly as posted.

## Decision 2. Reports must not be fooled by the closing entry
Profit and loss for the closed year must still show the year's real income and costs, not nothing. Rule: reports that measure a period (profit and loss, cash flow) EXCLUDE the closing entry; reports that measure a position (trial balance, balance sheet) INCLUDE it. After the close the balance sheet has no "earned so far" for that year: it is in retained earnings, and "earned so far" shows only the current year. The closing entry is identified by its event type, not by a flag a person could set.

## Decision 3. Reopening
A closed year can be reopened by the owner with a reason (at least 5 characters, as unlocking already requires). Reopening REVERSES the closing journal with a contra entry (history stays) and moves the lock back to the end of the previous closed year. A year cannot be reopened while a LATER year is closed (reopen the later one first), so retained earnings never rests on a gap.

## Decision 4. Where the financial year starts (needs Pierre's choice)
The engine has no financial-year setting. Recommended: a business setting `yearEndMonth` (1 to 12, default 2 = end of February, the South African individual tax year; the owner sets it once, as a recorded fact with a reason like the other business settings). A year is the twelve months ending on the last day of that month. Alternative: the owner names the end date each time they close, with no setting. The setting is recommended because it lets the assistant say "close last year" and lets reports offer "this financial year".

## Decision 5. What may be closed
- Only a year that has ended (its last day is before today), and only the year right after the last closed one (no gaps, no skipping).
- Refused if the verifier finds a problem at that moment (an unbalanced entry, a bank statement that does not add up), so a broken book is not frozen.
- Refused if any foreign-currency fact in the year is unposted (the existing warning becomes a blocker for closing, not for daily work), so the closed year is complete.
- Unmatched bank lines and unexplained reconciliation differences do NOT block closing (they are findings, reported on the closing record), because a bank statement can lag the books.

## Decision 6. The indirect cash flow
With years closed, the indirect cash flow for a period becomes a read: profit, plus or minus the movement in receivables, payables, inventory, VAT and goods-received-not-invoiced, equals the net movement in cash, and is CHECKED against the direct cash flow from G5 (a difference is a finding). Built after closing, as its own step.

## Steps (each tested, umbrella green, one push)
- P1: the `yearEndMonth` setting and the year list read (no posting yet).
- P2: close and reopen (the closing journal, the lock, the verifier checks: a closed year's profit and loss accounts net to nothing in the closing entry, retained earnings agrees with the closed years, the lock is at least the last closed year's end), reports that exclude or include the closing entry.
- P3: the indirect cash flow, sentences ("close last year", "profit this financial year") and a read-only app view of the years.

## Limits to state plainly
No multi-year comparison reports yet. One legal entity, one currency. A year can only be closed in order. Closing does not issue annual financial statements or tax returns; it makes the figures they need stable.

## Decisions for Pierre
1. Year-end: a business setting, default end of February (recommended), or named each time?
2. Reopening a closed year allowed with a reason (recommended), or never?

## P1 as built (2026-11-16): the year-end setting and the years read
- No migration. `worker/src/engine/periods.ts`: `yearEndMonth` (the latest `year_end.set` event, else February, like the books lock), `financialYearOf`, `previousYear`, `yearsView`. Capability `year_end.set` (held type `engine.year_end.set`, owner, business.manage; the same month again is refused; choosing February explicitly on the default is allowed so it is a recorded fact). Read `ledger.years` (GET /engine/ledger/years, optional asOf; the ENGINE uses today when none is given) returns the month, this year, last year and `closed` (always empty until P2).
- Tests: tools/engine-years.test.js (16), 6 breakages. Umbrella 11616/11616.
- Next: P2 (close and reopen).

## P2 as built (2026-11-16): close and reopen
- No migration. `worker/src/engine/year-close.ts` (rules and plans), `periods.ts` (`closedYears` replayed from events, `verifyYears`, `CLOSING_ENTRY`), inserts in facts.ts (`closeYear`, `reopenYear`). Capabilities `year.close {yearEnd, reason?}` and `year.reopen {yearEnd, reason}` (held types `engine.year.close` / `engine.year.reopen`, owner, business.manage).
- Closing: one `year.closed` event; one closing journal dated the last day of the year (source "manual", carried by the closing event; none when the year has nothing in it); and a `books_lock.set` event moving the lock to that day when it was earlier. All in one transaction. Refused unless: the date is a real year-end; the year has ended; it is the year right after the last closed one (the first close must be the year of the earliest entry); the verifier has no problems; nothing in another currency is unposted. Unmatched bank lines do not block.
- Reopening: only the latest closed year, with a reason (5 to 300 characters): a `year.reopened` event, a contra entry dated the year-end (the closing entry stays), and the lock moved back to the end of the year before (or off when none is closed). The closing and the contra deliberately skip the lock check (closing is the act that writes into the period being locked).
- Reports: profit and loss (a period report) leaves the closing entries out, so a closed year shows what it earned; trial balance and balance sheet (position reports) keep them, so the profit sits in retained earnings and "earned so far" is only the open year. Cash flow is unaffected (the closing entry never touches cash).
- The year-end month cannot be changed while a year is closed.
- `ledger.years` now lists the closed years and `nextToClose`. Verifier code `year_close_inconsistent` (closing entry missing or changed, a profit and loss account not netting to nothing over a closed year, the recorded profit differing from the books, years not contiguous, the lock before a closed year's end). The journal verifier accepts a year reopening as the reversal of a closing entry.
- Limits: reopening moves the lock back to the previous closed year's end even if the owner had locked later for other reasons; closing writes no annual statements.
- Tests: tools/engine-year-close.test.js (34), 13 breakages. Umbrella 11650/11650.
- Next: P3 (the indirect cash flow, sentences, a read-only years view in the app).

## P3 as built (2026-11-16): indirect cash flow, sentences, years view
- `periodRange` (periods.ts): this_month, last_month, this_financial_year, last_financial_year turned into dates by the engine; used by profit and loss, cash flow and the new read. Anything else: 422.
- `indirectCashFlow` (ledger-reports.ts), read `ledger.cash_flow_indirect` (GET /engine/ledger/cash-flow-indirect): starts from profit, adjusts for money customers owe, stock, goods received not yet billed, money owed to suppliers, VAT and other assets/liabilities, adds the owner's money in and out. Closing entries are left out. It must agree with the direct cash flow (`agrees`).
- Sentences: "profit this financial year", cash flow via periodRange, and "close last year" (held `year.close`; the sentence must say close/closing, args exactly last_financial_year).
- App: read-only financial years section in the Books room (year-end month, this year, closed years with profit, next to close).
- Umbrella 11674/11674.
