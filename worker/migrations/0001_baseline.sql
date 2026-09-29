-- Baseline schema, captured directly from the real, live database via
-- sqlite_master (not reconstructed from source, which would have missed
-- every column added by a later ALTER TABLE) -- this is the true,
-- current schema as it stood on 2026-09-29, the moment migrations
-- as real files began. Every CREATE TABLE below is exactly what
-- SQLite itself reports as the live definition.
--
-- This file is the one-time bridge from years of /debug/init-* routes
-- to a real, versioned migration history. It is not meant to be
-- edited retroactively to "clean up" history -- a fresh database
-- bootstrapped from this file should end up with the exact same
-- schema a real one, built up through all those routes over time,
-- actually has. Every migration from 0002 onward is real, new work,
-- not a rewrite of this one.
--
-- Safe to run any number of times -- every statement is IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS business_profile (id INTEGER PRIMARY KEY CHECK (id = 1), name TEXT, trading_as TEXT, vat_no TEXT, address TEXT, phone TEXT, email TEXT, website TEXT, banking_details TEXT, vat_registered INTEGER DEFAULT 0, vat_rate REAL DEFAULT 15, updated_at TEXT DEFAULT (datetime('now')), analytics_opt_in INTEGER DEFAULT 0, logo_r2_key TEXT);

CREATE TABLE IF NOT EXISTS captures (id INTEGER PRIMARY KEY AUTOINCREMENT, raw_text TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'voice', subject_hint TEXT, extraction_status TEXT DEFAULT 'unprocessed', created_at TEXT DEFAULT (datetime('now')), r2_key TEXT, customer_id INTEGER, character_id INTEGER);

CREATE TABLE IF NOT EXISTS character_facts (id INTEGER PRIMARY KEY AUTOINCREMENT, character_id INTEGER NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, source_transcript TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), capture_id INTEGER);

CREATE TABLE IF NOT EXISTS characters (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, relationship TEXT, created_at TEXT DEFAULT (datetime('now')), person_id INTEGER, merged_into_character_id INTEGER);

CREATE TABLE IF NOT EXISTS customer_facts (id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, source_transcript TEXT, created_at TEXT DEFAULT (datetime('now')));

CREATE TABLE IF NOT EXISTS customers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')), address TEXT, vat_exempt INTEGER NOT NULL DEFAULT 0, retention_percent REAL, person_id INTEGER, merged_into_customer_id INTEGER);

CREATE TABLE IF NOT EXISTS expenses (id INTEGER PRIMARY KEY AUTOINCREMENT, character_id INTEGER, amount REAL, description TEXT NOT NULL, source_transcript TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), category TEXT, customer_id INTEGER, capture_id INTEGER);

CREATE TABLE IF NOT EXISTS goods_received_notes (id INTEGER PRIMARY KEY AUTOINCREMENT, purchase_order_id INTEGER NOT NULL, supplier_id INTEGER, source_transcript TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), recorded_by TEXT, capture_id INTEGER);

CREATE TABLE IF NOT EXISTS grn_line_items (id INTEGER PRIMARY KEY AUTOINCREMENT, grn_id INTEGER NOT NULL, po_line_item_id INTEGER, description TEXT NOT NULL, quantity_received REAL NOT NULL, quantity_ordered REAL, variance REAL);

CREATE TABLE IF NOT EXISTS idempotency_keys (key TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'processing', result TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));

CREATE TABLE IF NOT EXISTS interaction_edges (id INTEGER PRIMARY KEY AUTOINCREMENT, capture_id INTEGER, entity_type_a TEXT NOT NULL, entity_id_a INTEGER NOT NULL, entity_type_b TEXT NOT NULL, entity_id_b INTEGER NOT NULL, relation_type TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));

CREATE TABLE IF NOT EXISTS invoices (id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER NOT NULL, description TEXT NOT NULL, amount REAL NOT NULL, status TEXT DEFAULT 'issued', source_transcript TEXT, created_at TEXT DEFAULT (datetime('now')), quotation_id INTEGER, retention_percent REAL, retention_amount REAL NOT NULL DEFAULT 0, job_scope_id INTEGER, due_date TEXT, capture_id INTEGER);

CREATE TABLE IF NOT EXISTS job_scope_amendments (id INTEGER PRIMARY KEY AUTOINCREMENT, job_scope_id INTEGER NOT NULL, capture_id INTEGER, field_name TEXT NOT NULL, old_value TEXT, new_value TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));

CREATE TABLE IF NOT EXISTS job_scopes (id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER, description TEXT NOT NULL, scheduled_date_raw TEXT, source_transcript TEXT, created_at TEXT DEFAULT (datetime('now')), scheduled_date TEXT, installer_id INTEGER, capture_id INTEGER, project_id INTEGER);

CREATE TABLE IF NOT EXISTS jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER NOT NULL, description TEXT NOT NULL, amount REAL, source_transcript TEXT, created_at TEXT DEFAULT (datetime('now')), quotation_id INTEGER, status TEXT DEFAULT 'scheduled');

CREATE TABLE IF NOT EXISTS leads (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, interest TEXT, source TEXT, status TEXT NOT NULL DEFAULT 'enquired', customer_id INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')), capture_id INTEGER, person_id INTEGER);

CREATE TABLE IF NOT EXISTS line_items (id INTEGER PRIMARY KEY AUTOINCREMENT, quotation_id INTEGER, invoice_id INTEGER, description TEXT NOT NULL, note TEXT, quantity REAL NOT NULL DEFAULT 1, unit TEXT, unit_price REAL NOT NULL, line_total REAL NOT NULL, created_at TEXT DEFAULT (datetime('now')), discount_percent REAL, product_id INTEGER, room TEXT, CHECK ((quotation_id IS NOT NULL AND invoice_id IS NULL) OR (quotation_id IS NULL AND invoice_id IS NOT NULL)));

CREATE TABLE IF NOT EXISTS memberships (id INTEGER PRIMARY KEY AUTOINCREMENT, google_email TEXT NOT NULL UNIQUE, role TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', invited_by TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), character_id INTEGER);

CREATE TABLE IF NOT EXISTS memory_errors (id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER, text TEXT, error TEXT, created_at TEXT DEFAULT (datetime('now')));

CREATE TABLE IF NOT EXISTS payments (id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER NOT NULL, amount REAL, source_transcript TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')), invoice_id INTEGER, FOREIGN KEY (customer_id) REFERENCES customers(id));

CREATE TABLE IF NOT EXISTS pending_actions (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', source_transcript TEXT, created_at TEXT DEFAULT (datetime('now')), resolved_at TEXT);

CREATE TABLE IF NOT EXISTS pending_memory_flush (id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER, text TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')));

CREATE TABLE IF NOT EXISTS people (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), needs_merge_review INTEGER DEFAULT 0, merged_into_person_id INTEGER);

CREATE TABLE IF NOT EXISTS po_line_items (id INTEGER PRIMARY KEY AUTOINCREMENT, purchase_order_id INTEGER NOT NULL, description TEXT NOT NULL, quantity_ordered REAL NOT NULL, unit TEXT, unit_price_expected REAL, product_id INTEGER);

CREATE TABLE IF NOT EXISTS products (id INTEGER PRIMARY KEY, name TEXT NOT NULL, category TEXT, merged_into_product_id INTEGER, created_at TEXT DEFAULT (datetime('now')));

CREATE TABLE IF NOT EXISTS projects (id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER, description TEXT, source_transcript TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), capture_id INTEGER);

CREATE TABLE IF NOT EXISTS purchase_orders (id INTEGER PRIMARY KEY AUTOINCREMENT, supplier_id INTEGER, description TEXT NOT NULL, source_transcript TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), capture_id INTEGER);

CREATE TABLE IF NOT EXISTS quotations (id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER NOT NULL, description TEXT NOT NULL, amount REAL NOT NULL, status TEXT DEFAULT 'draft', source_transcript TEXT, created_at TEXT DEFAULT (datetime('now')), job_scope_id INTEGER, capture_id INTEGER);

CREATE TABLE IF NOT EXISTS scope_components (id INTEGER PRIMARY KEY AUTOINCREMENT, job_scope_id INTEGER NOT NULL, name TEXT NOT NULL, width_mm REAL, length_mm REAL, area_sqm REAL, created_at TEXT DEFAULT (datetime('now')));

CREATE TABLE IF NOT EXISTS scope_tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, job_scope_id INTEGER NOT NULL, description TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')), component_id INTEGER);

CREATE TABLE IF NOT EXISTS selections (key TEXT PRIMARY KEY, entity_id INTEGER NOT NULL, label TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')));

CREATE TABLE IF NOT EXISTS snags (id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER NOT NULL, description TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL DEFAULT (datetime('now')), resolved_at TEXT, capture_id INTEGER);

CREATE TABLE IF NOT EXISTS stock_items (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, unit TEXT, quantity_on_hand REAL NOT NULL DEFAULT 0, reorder_threshold REAL, created_at TEXT NOT NULL DEFAULT (datetime('now')));

CREATE TABLE IF NOT EXISTS stock_usage_log (id INTEGER PRIMARY KEY AUTOINCREMENT, stock_item_id INTEGER NOT NULL, quantity_used REAL NOT NULL, customer_id INTEGER, source_transcript TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), capture_id INTEGER);

CREATE TABLE IF NOT EXISTS stocktake_lines (id INTEGER PRIMARY KEY AUTOINCREMENT, stocktake_id INTEGER NOT NULL, stock_item_id INTEGER NOT NULL, quantity_counted REAL NOT NULL, quantity_expected REAL NOT NULL, variance REAL NOT NULL);

CREATE TABLE IF NOT EXISTS stocktakes (id INTEGER PRIMARY KEY AUTOINCREMENT, source_transcript TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), capture_id INTEGER);

CREATE TABLE IF NOT EXISTS supplier_invoice_line_items (id INTEGER PRIMARY KEY AUTOINCREMENT, supplier_invoice_id INTEGER NOT NULL, po_line_item_id INTEGER, description TEXT NOT NULL, quantity_billed REAL NOT NULL, unit_price_billed REAL, quantity_variance REAL, price_variance REAL, line_total REAL NOT NULL, product_id INTEGER);

CREATE TABLE IF NOT EXISTS supplier_invoices (id INTEGER PRIMARY KEY AUTOINCREMENT, purchase_order_id INTEGER, supplier_id INTEGER, supplier_reference TEXT, amount REAL NOT NULL, source_transcript TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), capture_id INTEGER);

CREATE TABLE IF NOT EXISTS supplier_payments (id INTEGER PRIMARY KEY AUTOINCREMENT, character_id INTEGER NOT NULL, amount REAL, source_transcript TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), capture_id INTEGER);

CREATE TABLE IF NOT EXISTS tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, description TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')), completed_at TEXT, customer_id INTEGER, character_id INTEGER, due_date_raw TEXT, due_date TEXT, capture_id INTEGER);

CREATE TABLE IF NOT EXISTS variance_dispositions (id INTEGER PRIMARY KEY AUTOINCREMENT, grn_line_item_id INTEGER NOT NULL, reason TEXT, resolution TEXT, credit_amount REAL, recorded_by TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), capture_id INTEGER);
