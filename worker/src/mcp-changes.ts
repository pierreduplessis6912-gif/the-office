// STAGE 3 of the connector (MCP_ARCHITECTURE.md): scheduling a job, and editing a record a connection itself created. Both are STRUCTURED (a record and a value, no model reading free text), both keep the OLD value so the owner can revert them in the app, and both are held to the same per-key caps and audit as tell_the_office (mcp.ts).
// THE RULES (each held by a test that fails if it is removed, tools/mcp-changes-breakage.js): (1) an edit reaches only a record that was TAGGED to a connection (mcp-tags.ts) and not undone: the app's own records can only be changed in the app; (2) only a short list of fields, each checked (a description, an amount, a category, done), and anything else is refused; (3) only what is untouched: an invoice with a payment, void, with line items or retention, a quote that is not a draft, turned into an invoice or with line items, is REFUSED with the reason and nothing changes; (4) every change records the old and new value BEFORE the row changes, so it can be reverted, and a revert only happens if the field still holds the value the change set; (5) a job is only ever scheduled for today or later and only on a job that exists; (6) nothing is deleted.
import { nowInBusinessTimezone } from "./scheduler";
import type { Env } from "./types";

export type EditKind = "invoice" | "quote" | "expense" | "task" | "job";
const TABLE: Record<EditKind, string> = { invoice: "invoices", quote: "quotations", expense: "expenses", task: "tasks", job: "job_scopes" };
const FIELDS: Record<EditKind, string[]> = { invoice: ["description", "amount"], quote: ["description", "amount"], expense: ["description", "amount", "category"], task: ["description", "done"], job: ["description"] };
export const EDIT_KINDS = Object.keys(TABLE) as EditKind[];
export const MAX_AMOUNT = 100_000_000;

export type ChangeResult = { ok: true; data: Record<string, unknown> } | { ok: false; message: string; outcome: "invalid" | "not_found" | "error" };
const refuse = (message: string, outcome: "invalid" | "not_found" | "error" = "invalid"): ChangeResult => ({ ok: false, message, outcome });

export async function ensureChanges(env: Env): Promise<void> {
  await env.OFFICE_DB.prepare("CREATE TABLE IF NOT EXISTS mcp_changes (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL DEFAULT (datetime('now')), key_id TEXT NOT NULL, tbl TEXT NOT NULL, rec_id INTEGER NOT NULL, field TEXT NOT NULL, old_value TEXT, new_value TEXT, flagged INTEGER NOT NULL DEFAULT 0, reverted_at TEXT, reverted_by TEXT)").run();
  await env.OFFICE_DB.prepare("CREATE INDEX IF NOT EXISTS idx_mcp_changes_key ON mcp_changes (key_id, created_at)").run();
}

const count = async (env: Env, sql: string, ...binds: unknown[]): Promise<number> => {
  try { return (await env.OFFICE_DB.prepare(sql).bind(...binds).first<{ n: number }>())?.n ?? 0; } catch { return 0; }
};
const plainText = (v: unknown, max: number): string | null => {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length >= 1 && t.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(t) ? t : null;
};
const cents = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v > 0 && v <= MAX_AMOUNT ? Math.round(v * 100) / 100 : null);

/** Validates and normalises the asked-for fields. Unknown or badly shaped fields are refused whole: nothing is changed. */
function readChanges(kind: EditKind, raw: unknown): { ok: true; values: Record<string, string | number> } | { ok: false; message: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, message: "changes must be an object." };
  const keys = Object.keys(raw as object);
  if (keys.length < 1 || keys.length > FIELDS[kind].length) return { ok: false, message: `give at least one of: ${FIELDS[kind].join(", ")}.` };
  const values: Record<string, string | number> = {};
  for (const key of keys) {
    const v = (raw as Record<string, unknown>)[key];
    if (!FIELDS[kind].includes(key)) return { ok: false, message: `a ${kind} cannot have its ${key.slice(0, 40)} changed here (only: ${FIELDS[kind].join(", ")}).` };
    if (key === "description") { const t = plainText(v, 500); if (t === null) return { ok: false, message: "description must be 1 to 500 characters of plain text." }; values.description = t; }
    else if (key === "category") { const t = plainText(v, 60); if (t === null) return { ok: false, message: "category must be 1 to 60 characters of plain text." }; values.category = t; }
    else if (key === "amount") { const c = cents(v); if (c === null) return { ok: false, message: "amount must be a positive number of rand, at most 100,000,000." }; values.amount = c; }
    else if (key === "done") { if (typeof v !== "boolean") return { ok: false, message: "done must be true or false." }; values.done = v ? 1 : 0; }
  }
  return { ok: true, values };
}

/** Why this tagged record cannot be edited, or null. */
async function blocker(env: Env, kind: EditKind, id: number, row: Record<string, unknown>, fields: string[]): Promise<string | null> {
  const money = fields.includes("amount");
  if (kind === "invoice") {
    if (row.status === "void") return "That invoice is void.";
    if ((await count(env, "SELECT COUNT(*) AS n FROM payments WHERE invoice_id = ?", id)) > 0) return "A payment has been recorded against that invoice, so it can only be changed in the app.";
    if (money && (await count(env, "SELECT COUNT(*) AS n FROM line_items WHERE invoice_id = ?", id)) > 0) return "That invoice has line items, so its amount can only be changed in the app.";
    if (money && Number(row.retention_percent ?? 0) > 0) return "That invoice has retention, so its amount can only be changed in the app.";
  } else if (kind === "quote") {
    if (row.status !== "draft") return "That quote is no longer a draft, so it can only be changed in the app.";
    if ((await count(env, "SELECT COUNT(*) AS n FROM invoices WHERE quotation_id = ?", id)) > 0) return "That quote has been turned into an invoice.";
    if (money && (await count(env, "SELECT COUNT(*) AS n FROM line_items WHERE quotation_id = ?", id)) > 0) return "That quote has line items, so its amount can only be changed in the app.";
  }
  return null;
}

const asText = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

/** Edits fields of ONE tagged record. Records every change (old and new) before the row is touched. */
export async function editCreated(env: Env, keyId: string, input: { kind: unknown; id: unknown; changes: unknown }, flagOver: number): Promise<ChangeResult> {
  if (typeof input.kind !== "string" || !EDIT_KINDS.includes(input.kind as EditKind)) return refuse(`kind must be one of: ${EDIT_KINDS.join(", ")}.`);
  if (typeof input.id !== "number" || !Number.isInteger(input.id) || input.id < 1) return refuse("id must be a whole number.");
  const kind = input.kind as EditKind, table = TABLE[kind], id = input.id;
  const read = readChanges(kind, input.changes);
  if (!read.ok) return refuse(read.message);
  let tagged: { id: number } | null = null;
  try { tagged = await env.OFFICE_DB.prepare("SELECT id FROM mcp_created_records WHERE tbl = ? AND rec_id = ? AND undone_at IS NULL").bind(table, id).first<{ id: number }>(); } catch { tagged = null; }
  const row = tagged ? await env.OFFICE_DB.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(id).first<Record<string, unknown>>() : null;
  if (!tagged || !row) return refuse(`That ${kind} was not created by a connected assistant, so it can only be changed in the app.`, "not_found");
  const fields = Object.keys(read.values);
  const why = await blocker(env, kind, id, row, fields);
  if (why) return refuse(why);
  const changed = fields.filter((f) => asText(row[f]) !== asText(read.values[f]));
  if (changed.length === 0) return { ok: true, data: { kind, id, changed: [], note: "Nothing needed changing." } };
  await ensureChanges(env);
  const flagged = (kind === "invoice" || kind === "quote") && typeof read.values.amount === "number" && read.values.amount > flagOver;   // as for creating: an invoice or quote amount (an expense is not flagged)
  try {
    // (4) the old and new values first, one row per field
    for (const f of changed) await env.OFFICE_DB.prepare("INSERT INTO mcp_changes (key_id, tbl, rec_id, field, old_value, new_value, flagged) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(keyId, table, id, f, asText(row[f]), asText(read.values[f]), f === "amount" && flagged ? 1 : 0).run();
    for (const f of changed) await env.OFFICE_DB.prepare(`UPDATE ${table} SET ${f} = ? WHERE id = ?`).bind(read.values[f], id).run();   // the field names come only from the FIELDS list above
  } catch { return refuse("That could not be changed.", "error"); }
  return { ok: true, data: { kind, id, changed, flagged, ...(flagged ? { flagNote: `An amount above R${flagOver.toLocaleString("en-ZA")} was set. It was recorded, and the owner can see it flagged.` } : {}), note: "The owner can revert this in the app." } };
}

/** Schedules a job for a date (today or later). Writes the same amendment record the app writes, then the date. */
export async function scheduleJob(env: Env, keyId: string, input: { job_id: unknown; date: unknown }): Promise<ChangeResult> {
  if (typeof input.job_id !== "number" || !Number.isInteger(input.job_id) || input.job_id < 1) return refuse("job_id must be a whole number.");
  const date = input.date;
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) return refuse("date must be a real date, YYYY-MM-DD.");
  const now = nowInBusinessTimezone();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  if (date < today) return refuse("A job cannot be scheduled in the past.");
  if (date > `${now.getFullYear() + 2}-12-31`) return refuse("That date is too far ahead.");
  const job = await env.OFFICE_DB.prepare("SELECT id, scheduled_date, scheduled_date_raw FROM job_scopes WHERE id = ?").bind(input.job_id).first<{ id: number; scheduled_date: string | null; scheduled_date_raw: string | null }>();
  if (!job) return refuse("That job was not found.", "not_found");
  if (job.scheduled_date === date) return { ok: true, data: { jobId: job.id, scheduledDate: date, note: "It was already scheduled for that date." } };
  await ensureChanges(env);
  try {
    await env.OFFICE_DB.prepare("INSERT INTO mcp_changes (key_id, tbl, rec_id, field, old_value, new_value) VALUES (?, 'job_scopes', ?, 'scheduled_date', ?, ?)").bind(keyId, job.id, job.scheduled_date, date).run();
    await env.OFFICE_DB.prepare("INSERT INTO job_scope_amendments (job_scope_id, capture_id, field_name, old_value, new_value) VALUES (?, NULL, 'scheduled_date', ?, ?)").bind(job.id, job.scheduled_date, date).run();
    await env.OFFICE_DB.prepare("UPDATE job_scopes SET scheduled_date_raw = ?, scheduled_date = ? WHERE id = ?").bind(date, date, job.id).run();
  } catch { return refuse("That could not be scheduled.", "error"); }
  return { ok: true, data: { jobId: job.id, scheduledDate: date, previousDate: job.scheduled_date, note: "The owner can revert this in the app." } };
}

export type RevertResult = { ok: true; field: string; kind: string } | { ok: false; reason: "not_found" | "already_reverted" | "changed_since" | "gone" | "error"; message: string };
const KIND_OF: Record<string, string> = Object.fromEntries(Object.entries(TABLE).map(([k, t]) => [t, k]));

/** Puts one change back, but only if the field still holds what the change set (so nothing made since is lost). */
export async function revertChange(env: Env, changeId: unknown, by: string): Promise<RevertResult> {
  if (typeof changeId !== "number" || !Number.isInteger(changeId) || changeId < 1) return { ok: false, reason: "not_found", message: "That is not a change an assistant made." };
  let ch: { id: number; tbl: string; rec_id: number; field: string; old_value: string | null; new_value: string | null; reverted_at: string | null } | null = null;
  try { ch = await env.OFFICE_DB.prepare("SELECT id, tbl, rec_id, field, old_value, new_value, reverted_at FROM mcp_changes WHERE id = ?").bind(changeId).first(); } catch { ch = null; }
  const kind = ch ? KIND_OF[ch.tbl] : undefined;
  const allowed = kind === undefined ? [] : [...FIELDS[kind as EditKind], ...(ch!.tbl === "job_scopes" ? ["scheduled_date"] : [])];
  if (!ch || kind === undefined || !allowed.includes(ch.field)) return { ok: false, reason: "not_found", message: "That is not a change an assistant made." };
  if (ch.reverted_at !== null) return { ok: false, reason: "already_reverted", message: "That was already reverted." };
  const row = await env.OFFICE_DB.prepare(`SELECT * FROM ${ch.tbl} WHERE id = ?`).bind(ch.rec_id).first<Record<string, unknown>>();
  if (!row) return { ok: false, reason: "gone", message: `This ${kind} no longer exists.` };
  if (asText(row[ch.field]) !== ch.new_value) return { ok: false, reason: "changed_since", message: "That was changed again since, so it was left as it is." };
  try {
    await env.OFFICE_DB.prepare(`UPDATE ${ch.tbl} SET ${ch.field} = ? WHERE id = ?`).bind(ch.old_value, ch.rec_id).run();
    if (ch.field === "scheduled_date") {
      await env.OFFICE_DB.prepare("UPDATE job_scopes SET scheduled_date_raw = ? WHERE id = ?").bind(ch.old_value, ch.rec_id).run();
      await env.OFFICE_DB.prepare("INSERT INTO job_scope_amendments (job_scope_id, capture_id, field_name, old_value, new_value) VALUES (?, NULL, 'scheduled_date', ?, ?)").bind(ch.rec_id, ch.new_value, ch.old_value).run();
    }
    await env.OFFICE_DB.prepare("UPDATE mcp_changes SET reverted_at = datetime('now'), reverted_by = ? WHERE id = ? AND reverted_at IS NULL").bind(by.slice(0, 254), ch.id).run();
  } catch { return { ok: false, reason: "error", message: "That could not be reverted." }; }
  return { ok: true, field: ch.field, kind };
}

/** What assistants changed, newest first, for the owner's list. */
export async function listChanges(env: Env, limit: number): Promise<Array<Record<string, unknown>>> {
  try {
    const { results } = await env.OFFICE_DB.prepare("SELECT c.id, c.created_at, c.tbl, c.rec_id, c.field, c.old_value, c.new_value, c.flagged, c.reverted_at, k.label AS label FROM mcp_changes c LEFT JOIN mcp_keys k ON k.id = c.key_id ORDER BY c.id DESC LIMIT ?").bind(Math.min(Math.max(Math.floor(limit) || 50, 1), 200)).all<Record<string, unknown>>();
    return results.filter((r) => typeof r.tbl === "string" && KIND_OF[r.tbl as string]).map((r) => ({ id: r.id, createdAt: r.created_at, connection: r.label ?? "a connected assistant", kind: KIND_OF[r.tbl as string], recordId: r.rec_id, field: r.field, oldValue: r.old_value, newValue: r.new_value, flagged: r.flagged === 1, state: r.reverted_at ? "reverted" : "active" }));
  } catch { return []; }
}
