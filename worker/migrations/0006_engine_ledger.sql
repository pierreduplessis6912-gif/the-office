-- 0006: the engine's GENERAL LEDGER, increment G1 (docs/decisions/general-ledger.md, Pierre approved storing the journal and posting it atomically on 2026-11-15). ADDITIVE ONLY: four new tables and their indexes, no existing
-- table changes shape. Like every other engine table these are FACTS: rows are inserted once, with the event that caused them, and never updated or deleted (worker/src/engine/tables.ts declares them, tools/engine-ledger.test.js scans
-- the source for any write that is not an insert). A mistake is a contra entry, never an edit. Money is whole cents. An entry's lines must balance; that is checked by the ledger code and by the integrity verifier (a CHECK cannot
-- sum across rows). The database itself refuses a line that is not exactly one of debit or credit, and a second original entry for the same source.
-- ACCOUNTS and the ROLE mapping are facts too: the engine posts to a ROLE (receivables control, sales, VAT output, bank, cash, ...) and the business maps each role to an account, so an account can be renamed or re-mapped later
-- without breaking a posting. The current mapping of a role is its latest row.

CREATE TABLE IF NOT EXISTS eng_account (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE CHECK (length(trim(code)) > 0 AND length(code) <= 20),
  name TEXT NOT NULL CHECK (length(trim(name)) > 0 AND length(name) <= 120),
  type TEXT NOT NULL CHECK (type IN ('asset', 'liability', 'equity', 'income', 'cost_of_sales', 'expense')),
  event_id INTEGER NOT NULL REFERENCES eng_event(id)
);

CREATE TABLE IF NOT EXISTS eng_account_role (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL CHECK (length(trim(role)) > 0 AND length(role) <= 60),
  account_id INTEGER NOT NULL REFERENCES eng_account(id),
  event_id INTEGER NOT NULL REFERENCES eng_event(id)
);
CREATE INDEX IF NOT EXISTS idx_eng_account_role_role ON eng_account_role(role, id);

-- One entry per financial fact (source_kind document or movement). A contra entry points at the entry it reverses (reverses_entry_id, unique: an entry is reversed once; no REFERENCES, because restore orders tables
-- parents-first and refuses a table that points at itself, so the integrity verifier checks it instead).
CREATE TABLE IF NOT EXISTS eng_journal_entry (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_date TEXT NOT NULL CHECK (length(entry_date) = 10),
  source_kind TEXT NOT NULL CHECK (source_kind IN ('document', 'movement')),
  source_id INTEGER NOT NULL CHECK (typeof(source_id) = 'integer' AND source_id > 0),
  memo TEXT,
  reverses_entry_id INTEGER UNIQUE CHECK (reverses_entry_id IS NULL OR (typeof(reverses_entry_id) = 'integer' AND reverses_entry_id > 0)),
  event_id INTEGER NOT NULL REFERENCES eng_event(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS eng_journal_one_original ON eng_journal_entry (source_kind, source_id) WHERE reverses_entry_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_eng_journal_entry_source ON eng_journal_entry(source_kind, source_id);
CREATE INDEX IF NOT EXISTS idx_eng_journal_entry_date ON eng_journal_entry(entry_date);

CREATE TABLE IF NOT EXISTS eng_journal_line (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id INTEGER NOT NULL REFERENCES eng_journal_entry(id),
  line_no INTEGER NOT NULL CHECK (typeof(line_no) = 'integer' AND line_no > 0),
  account_id INTEGER NOT NULL REFERENCES eng_account(id),
  debit_minor INTEGER NOT NULL CHECK (typeof(debit_minor) = 'integer' AND debit_minor >= 0),
  credit_minor INTEGER NOT NULL CHECK (typeof(credit_minor) = 'integer' AND credit_minor >= 0),
  CHECK ((debit_minor > 0) <> (credit_minor > 0)),
  UNIQUE (entry_id, line_no)
);
CREATE INDEX IF NOT EXISTS idx_eng_journal_line_account ON eng_journal_line(account_id);
