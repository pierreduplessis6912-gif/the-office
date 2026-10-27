// The wider READ-ONLY data the MCP tools return (MCP capabilities roadmap, stage 1): customers, jobs, invoices, quotes, stock. Every function here only SELECTs, takes already-validated arguments, and is bounded (a page of at most MAX_PAGE rows).
// Who may call them is decided in mcp.ts (these tools are OWNER ONLY for now: none mirrors a rule that a lesser role could pass, and the installer's own-jobs scoping is not reproduced here). Amounts are South African rand.
import type { Env } from "./types";
import { kindOfHeld, summarise } from "./mcp-pending";

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

// ---- the ledger reads: expenses, payments and held actions (so an assistant can check what it created). SELECT only, owner only, bounded; the stored transcript and the raw payload are never returned.

/** Which of these records a connection created and has not had undone. Reads a table that may not exist (a business nothing was ever created through): then none were. */
async function createdThroughConnection(env: Env, table: "expenses" | "payments", ids: number[]): Promise<Set<number>> {
  const out = new Set<number>();
  if (ids.length === 0) return out;
  try {
    const { results } = await env.OFFICE_DB.prepare(`SELECT rec_id FROM mcp_created_records WHERE tbl = ? AND undone_at IS NULL AND rec_id IN (${ids.map(() => "?").join(",")})`).bind(table, ...ids).all<{ rec_id: number }>();
    for (const r of results ?? []) out.add(r.rec_id);
  } catch { /* no such table: nothing was created through a connection */ }
  return out;
}

export async function expensesData(env: Env, page: Page, range: Range, customerId: number | null) {
  const { results } = await env.OFFICE_DB.prepare(
    `SELECT e.id, e.amount, e.description, e.category, e.customer_id, c.name AS customer_name, e.created_at
       FROM expenses e LEFT JOIN customers c ON c.id = e.customer_id
      WHERE (?1 IS NULL OR e.customer_id = ?1) AND (?2 IS NULL OR date(e.created_at) >= ?2) AND (?3 IS NULL OR date(e.created_at) <= ?3)
      ORDER BY e.created_at DESC, e.id DESC LIMIT ?4 OFFSET ?5`
  ).bind(customerId, range.from, range.to, page.limit, page.offset).all<{ id: number }>();
  const rows = results ?? [], made = await createdThroughConnection(env, "expenses", rows.map((r) => r.id));
  return { report: "expenses", currency: "ZAR", note: "Periods are by the date the expense was entered. via_connection is true when a connected assistant created it (and it has not been undone).", limit: page.limit, offset: page.offset, items: rows.map((r) => ({ ...r, via_connection: made.has(r.id) })) };
}

export async function paymentsData(env: Env, page: Page, range: Range, customerId: number | null) {
  const { results } = await env.OFFICE_DB.prepare(
    `SELECT p.id, p.customer_id, c.name AS customer_name, p.amount, p.invoice_id, p.created_at
       FROM payments p LEFT JOIN customers c ON c.id = p.customer_id
      WHERE (?1 IS NULL OR p.customer_id = ?1) AND (?2 IS NULL OR date(p.created_at) >= ?2) AND (?3 IS NULL OR date(p.created_at) <= ?3)
      ORDER BY p.created_at DESC, p.id DESC LIMIT ?4 OFFSET ?5`
  ).bind(customerId, range.from, range.to, page.limit, page.offset).all<{ id: number }>();
  const rows = results ?? [], made = await createdThroughConnection(env, "payments", rows.map((r) => r.id));
  return { report: "payments", currency: "ZAR", note: "Customer payments, by the date entered. They are applied to the oldest invoices first, not matched to an invoice: invoice_id is set only when the payment named one. via_connection is true when a connected assistant created it (and it has not been undone).", limit: page.limit, offset: page.offset, items: rows.map((r) => ({ ...r, via_connection: made.has(r.id) })) };
}

export const HELD_STATES = ["pending", "processing", "confirmed", "rejected"] as const;
export function parseHeldState(value: unknown): { ok: true; state: string | null } | { ok: false; error: string } {
  if (value === undefined) return { ok: true, state: null };
  if (typeof value !== "string" || !(HELD_STATES as readonly string[]).includes(value)) return { ok: false, error: `state must be one of ${HELD_STATES.join(", ")}.` };
  return { ok: true, state: value };
}

/** Held actions: every money action waits here until it is confirmed or rejected. Only the kind, state, times and the short safe summary come back (never the payload or the transcript). */
export async function heldActionsData(env: Env, page: Page, state: string | null) {
  const { results } = await env.OFFICE_DB.prepare(
    "SELECT id, type, status, payload, created_at, resolved_at FROM pending_actions WHERE (?1 IS NULL OR status = ?1) ORDER BY created_at DESC, id DESC LIMIT ?2 OFFSET ?3"
  ).bind(state, page.limit, page.offset).all<{ id: number; type: string; status: string; payload: string | null; created_at: string; resolved_at: string | null }>();
  const rows = results ?? [], proposed = new Map<number, string | null>();
  if (rows.length > 0) {
    try {
      const { results: links } = await env.OFFICE_DB.prepare(`SELECT l.pending_id, k.label FROM mcp_pending_links l LEFT JOIN mcp_keys k ON k.id = l.key_id WHERE l.pending_id IN (${rows.map(() => "?").join(",")})`).bind(...rows.map((r) => r.id)).all<{ pending_id: number; label: string | null }>();
      for (const l of links ?? []) proposed.set(l.pending_id, l.label ?? null);
    } catch { /* no such table: nothing was proposed through a connection */ }
  }
  return { report: "held_actions", note: "A money action waits here until it is confirmed or rejected. state is pending, processing, confirmed or rejected. proposed_by_connection is true when a connected assistant proposed it; connection names which one.", limit: page.limit, offset: page.offset,
    items: rows.map((r) => ({ id: r.id, kind: kindOfHeld(r.type), state: r.status, summary: summarise(r.payload), created_at: r.created_at, resolved_at: r.resolved_at ?? null, proposed_by_connection: proposed.has(r.id), connection: proposed.get(r.id) ?? null })) };
}
