// The database's indexes, in one place.
//
// Added 2026-10-12 (the pre-staging audit, DECISIONS.md). Until now the database had NO explicit indexes at all: asked of SQLite on the real schema, 115 of the 235 distinct
// statements the application runs, and 31 of the 48 that a single message runs, scanned a whole table (every customer and person lookup by name, jobs and projects by
// customer, payments by customer, the four count queries that run on EVERY message, the purchase-order and delivery lookups). That is harmless while tables are small, but
// rows read are billed, time grows with table size, and inside a Durable Object a long scan holds up every other request for that business.
//
// Rules, so an index can never change what the application answers: single-column only (an index entry is ordered by its column and then by row id, which is exactly the order
// a table scan returns, so a query with no ORDER BY gives the same rows in the same order), with two deliberate exceptions that are not about ordering: a NOCASE index
// (the lookups ask `name = ? COLLATE NOCASE`, and an index is used only if declared the same way) and one partial index for open tasks.
// The indexes are created by applyIndexes(), idempotently, only for tables that exist (many tables are created on first use, so an index for one that does not exist yet is
// skipped and made on the next run). It is run by POST /debug/init-indexes, and will be run when a business's object is created.
import type { Env } from "./types";

export interface IndexDef {
  name: string;
  table: string;
  columns: string;
  where?: string;
}

export const INDEXES: readonly IndexDef[] = [
  // who is this? (every message)
  { name: "idx_customers_name", table: "customers", columns: "name COLLATE NOCASE" },
  { name: "idx_customers_person", table: "customers", columns: "person_id" },
  { name: "idx_people_name", table: "people", columns: "name COLLATE NOCASE" },
  { name: "idx_characters_name", table: "characters", columns: "name COLLATE NOCASE" },
  { name: "idx_characters_person", table: "characters", columns: "person_id" },
  { name: "idx_products_name", table: "products", columns: "name COLLATE NOCASE" },
  // jobs, projects and their parts
  { name: "idx_job_scopes_customer", table: "job_scopes", columns: "customer_id" },
  { name: "idx_job_scopes_capture", table: "job_scopes", columns: "capture_id" },
  { name: "idx_job_scopes_scheduled", table: "job_scopes", columns: "scheduled_date" },
  { name: "idx_job_scopes_project", table: "job_scopes", columns: "project_id" },
  { name: "idx_job_scopes_installer", table: "job_scopes", columns: "installer_id" },
  { name: "idx_projects_customer", table: "projects", columns: "customer_id" },
  { name: "idx_scope_tasks_scope", table: "scope_tasks", columns: "job_scope_id" },
  { name: "idx_scope_components_scope", table: "scope_components", columns: "job_scope_id" },
  // money
  { name: "idx_invoices_customer", table: "invoices", columns: "customer_id" },
  { name: "idx_invoices_scope", table: "invoices", columns: "job_scope_id" },
  { name: "idx_payments_customer", table: "payments", columns: "customer_id" },
  { name: "idx_payments_invoice", table: "payments", columns: "invoice_id" },
  { name: "idx_expenses_customer", table: "expenses", columns: "customer_id" },
  { name: "idx_expenses_character", table: "expenses", columns: "character_id" },
  { name: "idx_expenses_day", table: "expenses", columns: "date(created_at)" },   // the count of today's expenses asks `date(created_at) = ?`; an index must be on that same expression
  { name: "idx_quotations_customer", table: "quotations", columns: "customer_id" },
  // open tasks (the count that runs on every message): only the open ones are indexed, so it stays small as done tasks pile up
  { name: "idx_tasks_open", table: "tasks", columns: "id", where: "done = 0" },
  { name: "idx_leads_capture", table: "leads", columns: "capture_id" },
  // procurement
  { name: "idx_purchase_orders_supplier", table: "purchase_orders", columns: "supplier_id" },
  { name: "idx_po_lines_order", table: "po_line_items", columns: "purchase_order_id" },
  { name: "idx_po_customers_customer", table: "purchase_order_customers", columns: "customer_id" },
  { name: "idx_po_cancellations_order", table: "purchase_order_cancellations", columns: "purchase_order_id" },
  { name: "idx_supplier_invoices_supplier", table: "supplier_invoices", columns: "supplier_id" },
  { name: "idx_supplier_invoices_order", table: "supplier_invoices", columns: "purchase_order_id" },
  { name: "idx_grn_order", table: "goods_received_notes", columns: "purchase_order_id" },
  { name: "idx_grn_supplier", table: "goods_received_notes", columns: "supplier_id" },
  { name: "idx_grn_lines_grn", table: "grn_line_items", columns: "grn_id" },
  { name: "idx_grn_lines_po_line", table: "grn_line_items", columns: "po_line_item_id" },
  { name: "idx_variance_grn_line", table: "variance_dispositions", columns: "grn_line_item_id" },
  // held actions
  { name: "idx_pending_actions_status", table: "pending_actions", columns: "status" },
];

export const createIndexSql = (ix: IndexDef): string => `CREATE INDEX IF NOT EXISTS ${ix.name} ON ${ix.table} (${ix.columns})${ix.where ? ` WHERE ${ix.where}` : ""}`;

export interface IndexReport {
  created: string[];
  alreadyThere: string[];
  tableNotYetCreated: string[];
  failed: { name: string; error: string }[];
}

export async function applyIndexes(env: Env): Promise<IndexReport> {
  const names = async (type: string): Promise<Set<string>> =>
    new Set(((await env.OFFICE_DB.prepare("SELECT name FROM sqlite_master WHERE type = ?").bind(type).all<{ name: string }>()).results ?? []).map((r) => r.name));
  const tables = await names("table");
  const existing = await names("index");
  const report: IndexReport = { created: [], alreadyThere: [], tableNotYetCreated: [], failed: [] };
  for (const ix of INDEXES) {
    if (!tables.has(ix.table)) {
      report.tableNotYetCreated.push(ix.name);
      continue;
    }
    if (existing.has(ix.name)) {
      report.alreadyThere.push(ix.name);
      continue;
    }
    try {
      await env.OFFICE_DB.prepare(createIndexSql(ix)).run();
      report.created.push(ix.name);
    } catch (error) {
      report.failed.push({ name: ix.name, error: String((error as { message?: string } | null)?.message ?? error).slice(0, 120) });
    }
  }
  return report;
}
