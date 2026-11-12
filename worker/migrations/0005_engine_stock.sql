-- 0005: the engine's STOCK ledger (docs/decisions/inventory.md and inventory-integration.md, Pierre waived the restore-drill gate for additive engine tables on 2026-11-11).
-- ADDITIVE ONLY: three new tables and their indexes, no existing table changes shape (the foundation STOP RULE). Like the foundation tables these are FACTS: rows are inserted once, with the event that explains them, and never updated or deleted
-- (worker/src/engine/tables.ts declares them, tools/engine-ledger.test.js scans the source for any write that is not an insert). Mutable attributes of an item or a location (its name, reorder level, active flag) are EVENTS, derived, as a party's profile is.
-- The quantity is in thousandths (flooring and blinds are sold by the metre and the square metre), value is in minor units (cents) and is the AUTHORITATIVE value moved: stock on hand is the sum of signed quantities, stock value the sum of signed values, so
-- zero quantity is exactly zero value. The kind gives the sign, a transfer carries no value (it moves quantity between locations, not worth).

CREATE TABLE IF NOT EXISTS eng_item (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sku TEXT NOT NULL UNIQUE CHECK (length(trim(sku)) > 0 AND length(sku) <= 40),
  name TEXT NOT NULL CHECK (length(trim(name)) > 0 AND length(name) <= 120),
  unit TEXT NOT NULL CHECK (length(trim(unit)) > 0 AND length(unit) <= 20),
  event_id INTEGER NOT NULL REFERENCES eng_event(id)
);

CREATE TABLE IF NOT EXISTS eng_location (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE CHECK (length(trim(name)) > 0 AND length(name) <= 80),
  kind TEXT NOT NULL CHECK (kind IN ('warehouse', 'vehicle', 'site', 'in_transit')),
  event_id INTEGER NOT NULL REFERENCES eng_event(id)
);

CREATE TABLE IF NOT EXISTS eng_stock_move (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES eng_item(id),
  location_id INTEGER NOT NULL REFERENCES eng_location(id),
  kind TEXT NOT NULL CHECK (kind IN ('receive', 'issue', 'transfer_in', 'transfer_out', 'adjust_in', 'adjust_out', 'reversal_in', 'reversal_out')),
  quantity_milli INTEGER NOT NULL CHECK (typeof(quantity_milli) = 'integer' AND quantity_milli > 0),
  value_minor INTEGER NOT NULL CHECK (typeof(value_minor) = 'integer' AND value_minor >= 0),
  occurred_on TEXT NOT NULL CHECK (length(occurred_on) = 10),
  source_document_id INTEGER REFERENCES eng_document(id),
  source_line_no INTEGER CHECK (source_line_no IS NULL OR (typeof(source_line_no) = 'integer' AND source_line_no > 0)),
  reason TEXT,
  job_ref TEXT,
  -- pair_id: a transfer_in points at its transfer_out. reverses_move_id: a reversal points at the move it reverses, and a move can be reversed once.
  -- Neither declares REFERENCES: restore orders tables parents-first and refuses a table that points at itself, so the integrity verifier checks them instead.
  pair_id INTEGER,
  reverses_move_id INTEGER UNIQUE,
  event_id INTEGER NOT NULL REFERENCES eng_event(id),
  CHECK (kind NOT IN ('transfer_in', 'transfer_out') OR value_minor = 0),
  CHECK ((reverses_move_id IS NOT NULL) = (kind IN ('reversal_in', 'reversal_out')))
);

CREATE INDEX IF NOT EXISTS idx_eng_stock_move_item ON eng_stock_move(item_id, location_id);
CREATE INDEX IF NOT EXISTS idx_eng_stock_move_source ON eng_stock_move(source_document_id, source_line_no);
CREATE INDEX IF NOT EXISTS idx_eng_stock_move_event ON eng_stock_move(event_id);
