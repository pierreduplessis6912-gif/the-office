-- 0008: BANK MATCHING, increment G5b (docs/decisions/bank-reconciliation.md). ADDITIVE ONLY: one new table. A match says "this bank statement line IS these entries on the bank account". It is a FACT:
-- inserted once with the event that caused it (a person approved it), never updated or deleted. Undoing a match is a second fact that points at the first (reverses_match_id), so history stays.
-- A bank line is matched as a GROUP (a lump-sum EFT paying three invoices is three rows with one event); the group is confirmed and undone as a whole, so the rows of one event always add up to
-- the bank line. (A table may not point at itself under the restore, so reverses_match_id is a plain number and the integrity verifier checks that it names a real match.) That a bank line and a journal line are each matched at most once at a time, and that the amounts agree, is checked by the engine and by the integrity verifier.

CREATE TABLE IF NOT EXISTS eng_bank_match (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bank_line_id INTEGER NOT NULL REFERENCES eng_bank_line(id),
  journal_line_id INTEGER NOT NULL REFERENCES eng_journal_line(id),
  reverses_match_id INTEGER UNIQUE CHECK (reverses_match_id IS NULL OR (typeof(reverses_match_id) = 'integer' AND reverses_match_id > 0)),
  event_id INTEGER NOT NULL REFERENCES eng_event(id)
);
CREATE INDEX IF NOT EXISTS idx_eng_bank_match_bank ON eng_bank_match(bank_line_id);
CREATE INDEX IF NOT EXISTS idx_eng_bank_match_journal ON eng_bank_match(journal_line_id);
