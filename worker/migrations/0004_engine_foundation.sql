-- 0004: the engine foundation (branch engine-phase1). Additive only, applied to every business's object like any other step; a business that never uses the engine keeps these tables empty and inert.
-- The engine's FACTS are recorded once and never edited: documents, document lines, money movements, allocations, reversals and events. A mistake is corrected by a new fact that reverses the old one
-- (eng_reversal), never by changing it. The database cannot enforce "never edited" itself (this runner takes no multi-statement hooks), so the engine writes facts through one path that only inserts and
-- an integrity verifier re-derives every invariant (worker/src/engine). What the database DOES enforce is below: whole-number money and quantities, real foreign keys, enumerations, uniqueness.
-- Money is integer minor units (cents) with a currency; quantities are integer thousandths; tax is integer basis points. SQLite stores 1.5 or '100' in an INTEGER column without complaint, hence typeof().
-- Nothing here points at itself or in a circle: a restore refills tables parents-first.

CREATE TABLE IF NOT EXISTS eng_config (
  key TEXT PRIMARY KEY CHECK (length(key) > 0),
  value_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS eng_event (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL CHECK (length(type) > 0),
  occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  actor_email TEXT,
  capture_id INTEGER REFERENCES captures(id),
  proposal_id INTEGER REFERENCES pending_actions(id),
  approved_by TEXT,
  contract TEXT,
  contract_version INTEGER,
  reason TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}'
);
-- an approved proposal executes at most once: its single 'operation.executed' event is unique (the facts it recorded may be several: one payment can settle two invoices)
CREATE UNIQUE INDEX IF NOT EXISTS eng_event_one_execution ON eng_event (proposal_id) WHERE proposal_id IS NOT NULL AND type = 'operation.executed';
CREATE INDEX IF NOT EXISTS eng_event_type ON eng_event (type, id);

CREATE TABLE IF NOT EXISTS eng_party (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('person', 'organisation')),
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  event_id INTEGER NOT NULL REFERENCES eng_event(id)
);

CREATE TABLE IF NOT EXISTS eng_party_role (
  party_id INTEGER NOT NULL REFERENCES eng_party(id),
  role TEXT NOT NULL CHECK (length(trim(role)) > 0),
  event_id INTEGER NOT NULL REFERENCES eng_event(id),
  PRIMARY KEY (party_id, role)
);

CREATE TABLE IF NOT EXISTS eng_document (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (length(trim(kind)) > 0),
  direction TEXT NOT NULL CHECK (direction IN ('sell', 'buy')),
  party_id INTEGER NOT NULL REFERENCES eng_party(id),
  currency TEXT NOT NULL CHECK (length(currency) = 3 AND currency = upper(currency)),
  reference TEXT,
  issued_on TEXT NOT NULL CHECK (issued_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  terms_json TEXT NOT NULL DEFAULT '{}',
  event_id INTEGER NOT NULL REFERENCES eng_event(id)
);
CREATE INDEX IF NOT EXISTS eng_document_party ON eng_document (party_id, kind, id);

CREATE TABLE IF NOT EXISTS eng_document_line (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id INTEGER NOT NULL REFERENCES eng_document(id),
  line_no INTEGER NOT NULL CHECK (typeof(line_no) = 'integer' AND line_no > 0),
  description TEXT NOT NULL CHECK (length(trim(description)) > 0),
  quantity_milli INTEGER NOT NULL CHECK (typeof(quantity_milli) = 'integer' AND quantity_milli > 0),
  unit TEXT,
  unit_price_minor INTEGER NOT NULL CHECK (typeof(unit_price_minor) = 'integer' AND unit_price_minor >= 0),
  tax_bp INTEGER NOT NULL DEFAULT 0 CHECK (typeof(tax_bp) = 'integer' AND tax_bp >= 0 AND tax_bp <= 10000),
  UNIQUE (document_id, line_no)
);

-- a gapless number per kind, given at issue inside the issuing transaction
CREATE TABLE IF NOT EXISTS eng_document_number (
  kind TEXT NOT NULL CHECK (length(trim(kind)) > 0),
  number INTEGER NOT NULL CHECK (typeof(number) = 'integer' AND number > 0),
  document_id INTEGER NOT NULL UNIQUE REFERENCES eng_document(id),
  PRIMARY KEY (kind, number)
);

CREATE TABLE IF NOT EXISTS eng_money_movement (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  party_id INTEGER NOT NULL REFERENCES eng_party(id),
  amount_minor INTEGER NOT NULL CHECK (typeof(amount_minor) = 'integer' AND amount_minor > 0),
  currency TEXT NOT NULL CHECK (length(currency) = 3 AND currency = upper(currency)),
  occurred_on TEXT NOT NULL CHECK (occurred_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  method TEXT,
  event_id INTEGER NOT NULL REFERENCES eng_event(id)
);
CREATE INDEX IF NOT EXISTS eng_money_movement_party ON eng_money_movement (party_id, id);

CREATE TABLE IF NOT EXISTS eng_allocation (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  movement_id INTEGER NOT NULL REFERENCES eng_money_movement(id),
  document_id INTEGER NOT NULL REFERENCES eng_document(id),
  amount_minor INTEGER NOT NULL CHECK (typeof(amount_minor) = 'integer' AND amount_minor > 0),
  event_id INTEGER NOT NULL REFERENCES eng_event(id)
);
CREATE INDEX IF NOT EXISTS eng_allocation_movement ON eng_allocation (movement_id);
CREATE INDEX IF NOT EXISTS eng_allocation_document ON eng_allocation (document_id);

-- a correction: exactly one thing is reversed, once, with a reason; the replacement (if any) is a new fact recorded in the same transaction
CREATE TABLE IF NOT EXISTS eng_reversal (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  movement_id INTEGER REFERENCES eng_money_movement(id),
  allocation_id INTEGER REFERENCES eng_allocation(id),
  document_id INTEGER REFERENCES eng_document(id),
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  replaced_by_movement_id INTEGER REFERENCES eng_money_movement(id),
  event_id INTEGER NOT NULL REFERENCES eng_event(id),
  CHECK ((movement_id IS NOT NULL) + (allocation_id IS NOT NULL) + (document_id IS NOT NULL) = 1)
);
CREATE UNIQUE INDEX IF NOT EXISTS eng_reversal_once_movement ON eng_reversal (movement_id) WHERE movement_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS eng_reversal_once_allocation ON eng_reversal (allocation_id) WHERE allocation_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS eng_reversal_once_document ON eng_reversal (document_id) WHERE document_id IS NOT NULL;

-- a working copy: the one mutable thing. It is not a business fact; issuing it creates the document and closes the draft.
CREATE TABLE IF NOT EXISTS eng_draft (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (length(trim(kind)) > 0),
  direction TEXT NOT NULL CHECK (direction IN ('sell', 'buy')),
  party_id INTEGER REFERENCES eng_party(id),
  payload_json TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (typeof(version) = 'integer' AND version > 0),
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  issued_document_id INTEGER REFERENCES eng_document(id)
);

-- what was understood from a capture: a proposal, a refusal, or "the engine cannot do that". Never business truth.
CREATE TABLE IF NOT EXISTS eng_interpretation (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  capture_id INTEGER NOT NULL REFERENCES captures(id),
  interpreter TEXT NOT NULL CHECK (interpreter IN ('script', 'model')),
  capability TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL CHECK (status IN ('proposed', 'refused', 'unsupported')),
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- a request the engine could not or would not act on, kept and answered honestly: a possible unmet need, never an invented operation
CREATE TABLE IF NOT EXISTS eng_observation (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  capture_id INTEGER NOT NULL REFERENCES captures(id),
  kind TEXT NOT NULL CHECK (kind IN ('unsupported', 'unavailable', 'ambiguous')),
  note TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'addressed', 'dismissed')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
