> **Status:** approved 2026-11-16 (Pierre: "Yes"); B1 and B2 built. **Verified:** not yet. **Owns:** none.

# Several bank accounts (current, savings, card)

## Today
One ledger account holds the `bank` role (1000 Bank) and one holds `cash`. Every card, EFT or cheque payment posts to the bank role; one statement is reconciled against it. A business with a second account cannot keep its books true.

## Recommendation
1. **Accounts are ledger accounts.** A bank account is a normal asset account the owner names ("Savings", "Credit card"). A new held capability `bank_account.add` creates it and records it as a bank account (an event, no edit of anything). The existing "Bank" account stays the default.
2. **A payment names its account.** `payment.record` gains an optional `bankAccountId`; left out, it goes to the default account, so every existing sentence and screen keeps working. Cash stays cash.
3. **A statement belongs to one account.** Import names the account (default if left out). Duplicate skipping, matching and reconciliation work per account; each account has its own "is it reconciled".
4. **Moving money between accounts** is one held `bank.transfer` (debit one, credit the other, one journal entry), so the total never changes and neither side is invented.
5. **Reports:** the balance sheet and trial balance already list every account. Cash flow counts all bank accounts and treats a transfer between them as no cash movement.
6. **Verifier:** every payment and statement points at a real bank account; a transfer nets to nothing across the bank accounts.

## Cost
One additive migration (a table for bank accounts, the account id on payment and statement links), the per-account change in bank.ts and the reconciliation reads, one new capability and one for transfers. No existing record is rewritten.

## Not in this step
Foreign-currency accounts, automatic bank feeds, per-account opening balances beyond a normal opening journal.

## B1 as built (2026-11-16): accounts and payments
- Migration 0009 (additive): `eng_bank_account` (account_id UNIQUE, event_id) and a nullable `bank_account_id` on `eng_money_movement` and `eng_bank_statement` (the statement column is for B2).
- `worker/src/engine/bank-accounts.ts`: `bankAccounts` (the default first, then added ones; `id` is the ledger account id), `checkedBankAccount`, `checkAddInput`, `planAdd` (next free code from 1020 to 1099; 1010 is cash), `verifyAccounts`.
- Capability `bank_account.add` (held, `engine.bank_account.add`, owner, business.manage). Read `ledger.bank_accounts` (GET /engine/ledger/bank-accounts): each account with its ledger balance.
- `payment.record`, `supplier_payment.record` and `expense.record` take an optional `bankAccountId`; the entry's bank leg goes to that account. Cash and credit refuse one. `payment.correct` keeps the original's account. Refunds keep using the default (not in B1).
- Verifier: `bank_account_inconsistent` (a listed account that is not an asset or is the default; a payment or statement naming a non-bank account; a payment whose entry misses its account).
- Umbrella 11717/11717.
- Next: B2 (a statement per account, reconciliation per account), B3 (transfers, cash flow, sentences, app).

## B2 as built (2026-11-16): statements and reconciliation per account
- `bank_statement.import` takes an optional `bankAccountId`; none (or the default) means the default account, and a default statement keeps `bank_account_id` empty so everything before is unchanged. The event names the account only when it is not the default.
- Duplicate skipping is per account: lines of another account carry an `a<id>|` fingerprint prefix, so identical lines on two accounts are not duplicates; the same file twice on one account still is.
- Open lines and open entries carry their account; `suggestMatches` and `ledger.bank_suggestions` take `bankAccountId`; a match across accounts is refused when confirmed and found by the verifier.
- `ledger.bank_reconciliation` takes `bankAccountId`: the latest statement of that account against that account's ledger balance. An account with no statement says so and is never "reconciled"; one account's statement never answers for another.
- Umbrella 11740/11740. Next: B3 (transfers between accounts, cash flow across all accounts, sentences, app).
