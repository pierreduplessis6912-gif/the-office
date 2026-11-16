> **Status:** proposed 2026-11-16, waiting for Pierre's go. **Verified:** not yet. **Owns:** none.

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
