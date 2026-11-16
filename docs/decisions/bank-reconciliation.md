> **Status:** approved 2026-11-16 (Pierre: one bank account plus cash); G5a, G5b and G5c built. **Verified:** not yet. **Owns:** none.

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

## G5a as built (2026-11-16): statement import
- Migration 0007 (additive): `eng_bank_statement`, `eng_bank_line` (insert-only facts; unique fingerprint). `worker/src/engine/bank.ts`: parsing (CSV with several layouts, amounts and dates read by the ENGINE), checks, duplicate plan, integrity check `bank_statement_inconsistent`; the insert is `facts.importStatement` (event `bank_statement.imported`).
- Capability `bank_statement.import` (held type `engine.bank_statement.import`, permission business.manage, so the owner). Payload: period, opening and closing in cents, and either `lines` or `csv`. Refused whole when opening + lines is not closing, a line is outside the period, an amount is nothing or a fraction, or nothing in the file is new.
- A line is a duplicate when its date, amount, description and place among identical lines in the file match one already stored; overlapping statements add only the new lines and count the skipped.
- Writes nothing to the ledger. Tests: tools/engine-bank.test.js (23) plus 8 breakages. Umbrella 11557/11557.
- Not yet: any read of statements, any HTTP route beyond the generic proposal route, matching (G5b), the reconciliation and cash-flow reads, sentences and the app room (G5c).

## G5b as built (2026-11-16): matching
- Migration 0008 (additive): `eng_bank_match` (bank line, ledger entry on the bank account, optional `reverses_match_id`, event). A match is a fact; unmatching inserts reversal rows. The table cannot point at itself under the restore, so `reverses_match_id` is a plain number the verifier checks.
- The books' side is the BANK ACCOUNT's journal lines (payments in and out, refunds, a manual journal for a fee), signed like the statement. So a fee posted by a manual journal matches the same way as a payment.
- Read `ledger.bank_suggestions` (GET /engine/ledger/bank-suggestions, permission ledger.read): STRONG = one entry with the same amount within 5 days whose party name is in the description; WEAK = one fit, no name; AMBIGUOUS = several, or two lines wanting one entry; UNEXPLAINED = nothing fits. Nothing is matched by the read.
- Capabilities `bank_match.confirm` (a batch; each match checked against the facts as they are: entries on the bank account, unmatched, adding up to the line; a lump sum is several entries) and `bank_match.undo` (needs a reason, releases the whole group). Both owner-only (business.manage). Matching writes nothing to the ledger.
- Integrity `bank_match_inconsistent`: dangling rows, reversals that do not mirror, an entry actively matched twice, a line whose entries do not add up.
- Limits: the party name used is the one first recorded (later renames are not followed); a voided payment's contra entry stays open on the bank account until explained; weak and ambiguous cases are for a person to decide, there is no automatic matching.
- Tests: tools/engine-bank-match.test.js (25) plus 8 breakages. Umbrella 11582/11582.
- Not yet: the bank reconciliation and cash-flow reads, interpreter sentences and the app Bank room (G5c).

## G5c as built (2026-11-16): reads, sentences, the Bank room
- Reads (permission ledger.read, same as the other books): `ledger.bank_reconciliation` (GET /engine/ledger/bank-reconciliation, optional asOf; the latest statement at or before it) and `ledger.cash_flow` (GET /engine/ledger/cash-flow?from&to, or ?period=this_month|last_month dated by the ENGINE).
- Reconciliation: the books' bank balance at the statement's end date, the statement's closing balance, the entries not yet on the statement, the statement lines not yet in the books, and UNEXPLAINED = books less (statement + entries not on it - lines not in the books). `agrees` means nothing is unexplained; `reconciled` also needs both open lists empty. A statement that opened with money the books never saw leaves an unexplained difference, which is reported.
- Cash flow: direct method on the bank and cash accounts, grouped by cause (received from customers, paid to suppliers and for expenses, refunds, journals, corrections); opening + net = closing is checked.
- Sentences: "cash flow this month / last month" (the engine dates it) and "is the bank reconciled" (no arguments).
- App: read-only "The bank" room under More (reconciliation with open items on each side, and this month's cash flow). Matching is approved through the assistant, not in the room. CI "App compile check" is the proof for the Dart; no recorded fixtures for these answers yet.
- Limits: the indirect cash-flow method needs closed years and is not built; one bank account plus cash; entries dated before the first statement's period show as open until matched or explained.
- Tests: tools/engine-bank-reports.test.js (14), sentences in engine-interpret-books.test.js, 5 breakages. Umbrella 11600/11600.
