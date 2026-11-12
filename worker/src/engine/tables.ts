// Which engine tables hold FACTS and which hold working state. A fact is recorded once and never edited, so the engine's only write path (facts.ts) inserts into these and nothing in this folder
// updates, deletes or replaces one (tools/engine-ledger.test.js scans the source for it). The migration cannot enforce that itself (its runner takes no multi-statement hooks), so the declaration
// lives here, is tested, and is what the integrity verifier checks against.
export const FACT_TABLES = [
  "eng_event", "eng_party", "eng_party_role", "eng_document", "eng_document_line", "eng_document_number",
  "eng_money_movement", "eng_allocation", "eng_reversal", "eng_interpretation",
  "eng_item", "eng_location", "eng_stock_move",   // 0005_engine_stock.sql (stock: items, locations and the movement ledger)
] as const;

// Working state: configuration, drafts (a draft is not a business fact: issuing it creates one) and observations (a worklist).
export const MUTABLE_TABLES = ["eng_config", "eng_draft", "eng_observation"] as const;
