-- 0007: BANK STATEMENTS, increment G5a (docs/decisions/bank-reconciliation.md, Pierre chose one bank account plus cash on 2026-11-16). ADDITIVE ONLY: two new tables and nothing else. Like every engine
-- table these are FACTS: inserted once with the event that caused them, never updated or deleted (worker/src/engine/tables.ts declares them). A statement says what the bank says; it never changes the
-- books by itself. A line already imported (same date, amount, description and place among identical lines) is skipped, so bringing the same statement in twice changes nothing: the database
-- itself refuses a second copy through the unique fingerprint. The statement keeps what the FILE said (its total and line count) so the check "opening + lines = closing" can be repeated later even
-- when some of the file's lines were skipped as already imported.

CREATE TABLE IF NOT EXISTS eng_bank_statement (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  period_from TEXT NOT NULL CHECK (length(period_from) = 10),
  period_to TEXT NOT NULL CHECK (length(period_to) = 10 AND period_to >= period_from),
  opening_minor INTEGER NOT NULL CHECK (typeof(opening_minor) = 'integer'),
  closing_minor INTEGER NOT NULL CHECK (typeof(closing_minor) = 'integer'),
  file_total_minor INTEGER NOT NULL CHECK (typeof(file_total_minor) = 'integer'),
  file_line_count INTEGER NOT NULL CHECK (typeof(file_line_count) = 'integer' AND file_line_count > 0),
  skipped_count INTEGER NOT NULL CHECK (typeof(skipped_count) = 'integer' AND skipped_count >= 0),
  source_name TEXT CHECK (source_name IS NULL OR length(source_name) <= 200),
  event_id INTEGER NOT NULL REFERENCES eng_event(id)
);

CREATE TABLE IF NOT EXISTS eng_bank_line (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  statement_id INTEGER NOT NULL REFERENCES eng_bank_statement(id),
  line_no INTEGER NOT NULL CHECK (typeof(line_no) = 'integer' AND line_no > 0),
  line_date TEXT NOT NULL CHECK (length(line_date) = 10),
  description TEXT NOT NULL CHECK (length(trim(description)) > 0 AND length(description) <= 200),
  amount_minor INTEGER NOT NULL CHECK (typeof(amount_minor) = 'integer' AND amount_minor <> 0),
  balance_minor INTEGER CHECK (balance_minor IS NULL OR typeof(balance_minor) = 'integer'),
  fingerprint TEXT NOT NULL UNIQUE,
  event_id INTEGER NOT NULL REFERENCES eng_event(id)
);
CREATE INDEX IF NOT EXISTS idx_eng_bank_line_statement ON eng_bank_line(statement_id, line_no);
CREATE INDEX IF NOT EXISTS idx_eng_bank_line_date ON eng_bank_line(line_date);
