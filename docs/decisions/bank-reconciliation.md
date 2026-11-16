> **Status:** proposed. **Verified:** not yet. **Owns:** none.

# DECISIONS: bank-reconciliation (G5)

Written 2026-11-16 by the build chat after G1 to G4 (general ledger) went green. A DESIGN FOR APPROVAL: it authorises no code. Evidence labels as in general-ledger.md.

## Why
The ledger says what the bank balance SHOULD be (from the engine's own facts). The bank statement says what it IS. Until the two are compared, nobody knows about a missed payment, a bank fee, a double payment or a wrong date. Cash flow is the other half: where the money actually came from and went.

## Decision 1. Statement lines are facts, never edits
- A statement is brought in as insert-only facts: `eng_bank_statement` (account, period, opening and closing balance in cents, who brought it, from what file) and `eng_bank_line` (date, description, amount in cents, positive in, negative out, running balance if the bank gives it). Same one write path, same event with who and which contract.
- Ways in, easiest first: a pasted or uploaded CSV; later a photo or PDF read by the model (words only; the engine parses amounts and dates, as in the interpreter rule).
- The same statement imported twice changes nothing (a line already there, same date, amount, description and position, is skipped and counted).

## Decision 2. Matching: the engine proposes, a person decides
- For each unmatched line the engine looks for ledger bank/cash lines (money in, money out, refunds) with the same amount, a date within a few days, and a reference or party name in the description. Exact amount + date + reference = a strong match; amount + date only = a weak one that is asked about, never assumed ("when uncertain, ask").
- Strong matches are proposed as one held batch the owner approves with one yes; weak ones are asked one at a time. Nothing is matched silently.
- A match is a fact (`eng_bank_match`: line, journal line, who approved). Unmatching is a reversal fact. One bank line may match several movements (a lump-sum EFT paying three invoices) and one movement at most one line.

## Decision 3. Lines with no movement behind them
Bank charges, interest, an unknown deposit: the person says what it is and the engine uses the paths that already exist, no new posting rule:
- a fee or interest becomes an expense or a manual journal (`journal.post`, owner only) against the bank account;
- an unknown receipt becomes a customer payment (existing receipt path) or, if it is not a sale, a manual journal;
- unexplained lines stay visibly unmatched and are listed, never hidden or auto-booked to suspense.

## Decision 4. The reconciliation read
`ledger.bank_reconciliation(account, asOf)`: ledger balance of the account; statement closing balance; matched total; unmatched statement lines (not yet in the books); ledger lines not on the statement (outstanding, e.g. a payment made today that has not cleared); and the difference, which must equal those two lists netted, else it is flagged as a finding. Read only, permission `ledger.read`. The integrity verifier gains checks: a match points at a real line and a real journal line, amounts equal, no line matched twice.

## Decision 5. Cash flow is a read, not new storage
Direct method from the bank and cash account lines for a period, grouped by what caused them (customer receipts, supplier and expense payments, refunds, manual journals, opening). Opening balance + in - out = closing balance, checked. The indirect method (profit adjusted for working capital) is NOT in G5; it needs the books closed year by year, which is deferred.

## Decision 6. One bank account or several? (needs Pierre's choice)
Today there is one `bank` role and one `cash` role. Recommended for G5: keep one bank account and cash, and reconcile that bank account only. Several accounts (current, savings, card) means mapping payment methods to accounts and a statement per account; that is a small, additive extension afterwards, not a rewrite.

## Steps (each tested, umbrella green, one push)
- G5a: migration 0007 (additive), statement import, duplicate skip, tests and breakages.
- G5b: matching proposals, approval, unmatch, "no movement behind it" paths, verifier checks.
- G5c: reconciliation and cash-flow reads, interpreter sentences ("is the bank reconciled", "cash flow this month"), app "Bank" room (read, plus approve the proposed matches).

## Limits to state plainly
Foreign-currency accounts are not reconciled (as with the ledger). No live bank feed: statements come in by file. Statement dates and balances are taken as the bank states them; the engine only checks they are consistent with themselves (opening + lines = closing).
