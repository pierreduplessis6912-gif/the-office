// The wider READ-ONLY data the MCP tools return (MCP capabilities roadmap, stage 1): customers, jobs, invoices, quotes, stock. Every function here only SELECTs, takes already-validated arguments, and is bounded (a page of at most MAX_PAGE rows).
// Who may call them is decided in mcp.ts (these tools are OWNER ONLY for now: none mirrors a rule that a lesser role could pass, and the installer's own-jobs scoping is not reproduced here). Amounts are South African rand.
import type { Env } from "./types";

export const MAX_PAGE = 100;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export type Page = { limit: number; offset: number };
export type Range = { from: string | null; to: string | null };

export function parsePage(args: Record<string, unknown>): { ok: true; page: Page } | { ok: false; error: string } {
  const limit = args.limit === undefined ? 25 : args.limit;
  const offset = args.offset === undefined ? 0 : args.offset;
  if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE) return { ok: false, error: `limit must be a whole number from 1 to ${MAX_PAGE}.` };
  if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0 || offset > 100_000) return { ok: false, error: "offset must be a whole number, 0 or more." };
  return { ok: true, page: { limit, offset } };
}

export function parseRange(args: Record<string, unknown>): { ok: true; range: Range } | { ok: false; error: string } {
  const out: Range = { from: null, to: null };
  for (const key of ["from", "to"] as const) {
    const v = args[key];
    if (v === undefined) continue;
    if (typeof v !== "string" || !DATE_RE.test(v) || Number.isNaN(Date.parse(v + "T00:00:00Z"))) return { ok: false, error: `${key} must be a date, YYYY-MM-DD.` };
    out[key] = v;
  }
  if (out.from && out.to && out.from > out.to) return { ok: false, error: "from must not be after to." };
  return { ok: true, range: out };
}

export function parseId(value: unknown, name: string): { ok: true; id: number | null } | { ok: false; error: string } {
  if (value === undefined) return { ok: true, id: null };
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) return { ok: false, error: `${name} must be a whole number, 1 or more.` };
  return { ok: true, id: value };
}

export function parseSearch(value: unknown): { ok: true; search: string | null } | { ok: false; error: string } {
  if (value === undefined) return { ok: true, search: null };
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 60) return { ok: false, error: "search must be text of up to 60 characters." };
  return { ok: true, search: value.trim() };
}

// A LIKE pattern from the person's text, with the wildcard characters made literal.
const likeOf = (s: string): string => "%" + s.replace(/[\\%_]/g, (c) => "\\" + c) + "%";

export async function customersData(env: Env, page: Page, search: string | null) {
  const like = search ? likeOf(search) : null;
  const { results } = await env.OFFICE_DB.prepare(
    `SELECT id, name, address, phone, email, created_at FROM customers WHERE merged_into_customer_id IS NULL AND (?1 IS NULL OR name LIKE ?2 ESCAPE '\\' OR address LIKE ?2 ESCAPE '\\' OR phone LIKE ?2 ESCAPE '\\' OR email LIKE ?2 ESCAPE '\\') ORDER BY name ASC LIMIT ?3 OFFSET ?4`
  ).bind(search, like, page.limit, page.offset).all<{ id: number; name: string; address: string | null; created_at: string }>();
  return { report: "customers", limit: page.limit, offset: page.offset, items: results ?? [] };
}

export async function jobsData(env: Env, page: Page, range: Range, customerId: number | null) {
  const { results } = await env.OFFICE_DB.prepare(
    `SELECT js.id, js.customer_id, c.name AS customer_name, js.description, js.scheduled_date, js.project_id, js.created_at
       FROM job_scopes js LEFT JOIN customers c ON c.id = js.customer_id
      WHERE (?1 IS NULL OR js.customer_id = ?1) AND (?2 IS NULL OR date(js.scheduled_date) >= ?2) AND (?3 IS NULL OR date(js.scheduled_date) <= ?3)
      ORDER BY (js.scheduled_date IS NULL), js.scheduled_date ASC, js.id ASC LIMIT ?4 OFFSET ?5`
  ).bind(customerId, range.from, range.to, page.limit, page.offset).all();
  return { report: "jobs", note: "Each item is a job scope; scheduled_date is empty when no date is set. Filters on from and to use the scheduled date.", limit: page.limit, offset: page.offset, items: results ?? [] };
}

export async function invoicesData(env: Env, page: Page, range: Range, customerId: number | null) {
  const { results } = await env.OFFICE_DB.prepare(
    `SELECT i.id, i.customer_id, c.name AS customer_name, i.description, i.amount, i.status, i.created_at, i.due_date
       FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id
      WHERE (?1 IS NULL OR i.customer_id = ?1) AND (?2 IS NULL OR date(i.created_at) >= ?2) AND (?3 IS NULL OR date(i.created_at) <= ?3)
      ORDER BY i.created_at DESC, i.id DESC LIMIT ?4 OFFSET ?5`
  ).bind(customerId, range.from, range.to, page.limit, page.offset).all();
  return { report: "invoices", currency: "ZAR", note: "Periods are by the date the invoice was entered. Use get_customer_receivables for what is still owed.", limit: page.limit, offset: page.offset, items: results ?? [] };
}

export async function quotesData(env: Env, page: Page, range: Range, customerId: number | null) {
  const { results } = await env.OFFICE_DB.prepare(
    `SELECT q.id, q.customer_id, c.name AS customer_name, q.description, q.amount, q.status, q.created_at
       FROM quotations q LEFT JOIN customers c ON c.id = q.customer_id
      WHERE (?1 IS NULL OR q.customer_id = ?1) AND (?2 IS NULL OR date(q.created_at) >= ?2) AND (?3 IS NULL OR date(q.created_at) <= ?3)
      ORDER BY q.created_at DESC, q.id DESC LIMIT ?4 OFFSET ?5`
  ).bind(customerId, range.from, range.to, page.limit, page.offset).all();
  return { report: "quotes", currency: "ZAR", limit: page.limit, offset: page.offset, items: results ?? [] };
}

export async function stockData(env: Env, page: Page) {
  const { results } = await env.OFFICE_DB.prepare(
    "SELECT id, name, unit, quantity_on_hand, reorder_threshold FROM stock_items ORDER BY name ASC LIMIT ?1 OFFSET ?2"
  ).bind(page.limit, page.offset).all<{ id: number; name: string; unit: string | null; quantity_on_hand: number; reorder_threshold: number | null }>();
  const items = (results ?? []).map((r) => ({ ...r, below_reorder: r.reorder_threshold !== null && r.quantity_on_hand <= r.reorder_threshold }));
  return { report: "stock", limit: page.limit, offset: page.offset, items };
}

/** Whether the record a document link would point at exists (the link is never made for a record that is not there). */
export async function documentExists(env: Env, kind: "invoice" | "quote" | "statement", id: number): Promise<boolean> {
  const table = kind === "invoice" ? "invoices" : kind === "quote" ? "quotations" : "customers";
  // A VOIDED invoice (the owner's undo, mcp-undo.ts) has no document to hand out.
  const row = await env.OFFICE_DB.prepare(`SELECT id FROM ${table} WHERE id = ?${kind === "invoice" ? " AND status IS NOT 'void'" : ""}`).bind(id).first<{ id: number }>();
  return row !== null && row !== undefined;
}
