-- 0009: SEVERAL BANK ACCOUNTS (docs/decisions/bank-accounts.md). ADDITIVE ONLY: one new table and two columns. A bank account is an ordinary ledger account (eng_account) that the owner has said is a bank account;
-- the account that holds the `bank` role stays the default and is not listed here. The table is a FACT, inserted once with the event that caused it, never updated or deleted.
-- A payment (eng_money_movement) and a statement (eng_bank_statement) may name the bank account they belong to; left empty they belong to the default account, so everything recorded before this step is unchanged.

CREATE TABLE IF NOT EXISTS eng_bank_account (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL UNIQUE REFERENCES eng_account(id),
  event_id INTEGER NOT NULL REFERENCES eng_event(id)
);

ALTER TABLE eng_money_movement ADD COLUMN bank_account_id INTEGER REFERENCES eng_account(id);
ALTER TABLE eng_bank_statement ADD COLUMN bank_account_id INTEGER REFERENCES eng_account(id);
