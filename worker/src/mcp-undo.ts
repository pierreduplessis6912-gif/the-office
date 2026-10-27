// UNDO of what an assistant's key created (MCP stage 2 undo; MCP_ARCHITECTURE.md). The owner, in the app, can undo any record a call tagged (mcp-tags.ts): an invoice is VOIDED (it keeps its number; its amount goes to nothing so every figure that adds invoices up ignores it, and the original is kept), and a quote, job, expense, task or payment is REMOVED with a saved copy of the row. This is the OWNER's own action in the app, never a tool the assistant has.
// THE RULES (each held by a test that fails if it is removed, tools/mcp-undo-breakage.js): (1) only a record that was TAGGED to a key can be undone here, by its tag, never by a bare id; (2) only what is still untouched: an invoice with a payment against it, a quote that became an invoice or a job, a job that has an invoice, quote, measurements or tasks hanging off it are REFUSED with the reason, nothing changes; (3) a copy of the row is saved BEFORE anything changes, and the tag is marked undone only after the change was made; (4) a record is undone once (a second time is refused); (5) nothing but the tagged record (and, for a quote, its own line items) is touched; (6) an invoice is never deleted: its number is never reused or left as a gap.
import type { Env } from "./types";
import { TRACKED_TABLES, type TrackedTable } from "./mcp-tags";
import { EFFECT_LABEL, describeEffect, isEffectKind, undoEffect, type EffectKind } from "./mcp-effects";

const LABEL: Record<TrackedTable, string> = { invoices: "invoice", quotations: "quote", expenses: "expense", tasks: "task", job_scopes: "job", payments: "payment" };
export type UndoResult = { ok: true; action: "voided" | "removed" | "reversed"; kind: string; recordId: number } | { ok: false; reason: "not_found" | "already_undone" | "blocked" | "gone" | "error"; message: string };
interface Tag { id: number; create_id: number; key_id: string; tbl: string; rec_id: number; undone_at: string | null }

const count = async (env: Env, sql: string, ...binds: unknown[]): Promise<number> => {
  try { return (await env.OFFICE_DB.prepare(sql).bind(...binds).first<{ n: number }>())?.n ?? 0; } catch { return 0; }   // a table this business never created has nothing hanging off the record
};

/** Why this record cannot be undone, or null when it can. Reads only. */
async function blocker(env: Env, table: TrackedTable, id: number): Promise<string | null> {
  if (table === "invoices") {
    if ((await count(env, "SELECT COUNT(*) AS n FROM payments WHERE invoice_id = ?", id)) > 0) return "A payment has been recorded against this invoice. Remove the payment first.";
  } else if (table === "quotations") {
    if ((await count(env, "SELECT COUNT(*) AS n FROM invoices WHERE quotation_id = ?", id)) > 0) return "This quote has been turned into an invoice.";
    if ((await count(env, "SELECT COUNT(*) AS n FROM jobs WHERE quotation_id = ?", id)) > 0) return "This quote has a job made from it.";
  } else if (table === "job_scopes") {
    if ((await count(env, "SELECT COUNT(*) AS n FROM invoices WHERE job_scope_id = ?", id)) > 0) return "An invoice is linked to this job.";
    if ((await count(env, "SELECT COUNT(*) AS n FROM quotations WHERE job_scope_id = ?", id)) > 0) return "A quote is linked to this job.";
    for (const t of ["scope_components", "scope_tasks", "job_scope_amendments"]) if ((await count(env, `SELECT COUNT(*) AS n FROM ${t} WHERE job_scope_id = ?`, id)) > 0) return "This job already has measurements, tasks or changes recorded against it.";
  }
  return null;
}

/** Undoes ONE tagged record. `tagId` is the tag's own id (mcp_created_records.id), never a record id. */
export async function undoTagged(env: Env, tagId: unknown, by: string): Promise<UndoResult> {
  if (typeof tagId !== "number" || !Number.isInteger(tagId) || tagId < 1) return { ok: false, reason: "not_found", message: "That is not something a connected assistant created." };
  let tag: Tag | null = null;
  try { tag = await env.OFFICE_DB.prepare("SELECT id, create_id, key_id, tbl, rec_id, undone_at FROM mcp_created_records WHERE id = ?").bind(tagId).first<Tag>(); } catch { tag = null; }
  if (tag && isEffectKind(tag.tbl)) {
    // a confirmed decision that changed stock or a customer's details (mcp-effects.ts): put back exactly what it changed, or refuse and change nothing
    if (tag.undone_at !== null) return { ok: false, reason: "already_undone", message: "That was already undone." };
    let snapshot: string | null = null;
    try { snapshot = (await env.OFFICE_DB.prepare("SELECT snapshot FROM mcp_created_records WHERE id = ?").bind(tag.id).first<{ snapshot: string | null }>())?.snapshot ?? null; } catch { snapshot = null; }
    const done = await undoEffect(env, snapshot);
    if (!done.ok) return { ok: false, reason: done.reason, message: done.message };
    try { await env.OFFICE_DB.prepare("UPDATE mcp_created_records SET undone_at = datetime('now'), undone_by = ? WHERE id = ? AND undone_at IS NULL").bind(by.slice(0, 254), tag.id).run(); } catch { /* the change is already put back; the label is only a record */ }
    return { ok: true, action: "reversed", kind: EFFECT_LABEL[tag.tbl], recordId: tag.rec_id };
  }
  if (!tag || !(TRACKED_TABLES as readonly string[]).includes(tag.tbl)) return { ok: false, reason: "not_found", message: "That is not something a connected assistant created." };
  if (tag.undone_at !== null) return { ok: false, reason: "already_undone", message: "That was already undone." };
  const table = tag.tbl as TrackedTable, kind = LABEL[table];
  const row = await env.OFFICE_DB.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(tag.rec_id).first<Record<string, unknown>>();
  if (!row) return { ok: false, reason: "gone", message: `This ${kind} no longer exists, so there is nothing to undo.` };
  if (table === "invoices" && row.status === "void") return { ok: false, reason: "already_undone", message: "That invoice is already void." };
  const why = await blocker(env, table, tag.rec_id);
  if (why) return { ok: false, reason: "blocked", message: why };
  try {
    // (3) the copy first. For a quote it includes its own line items, which go with it.
    const snapshot: Record<string, unknown> = { row };
    if (table === "quotations") snapshot.line_items = (await env.OFFICE_DB.prepare("SELECT * FROM line_items WHERE quotation_id = ?").bind(tag.rec_id).all()).results;
    await env.OFFICE_DB.prepare("UPDATE mcp_created_records SET snapshot = ? WHERE id = ?").bind(JSON.stringify(snapshot), tag.id).run();
    if (table === "invoices") {
      await env.OFFICE_DB.prepare("UPDATE invoices SET status = 'void', amount = 0, retention_amount = 0, description = ? WHERE id = ? AND status IS NOT 'void'").bind(`VOID: ${String(row.description ?? "").replace(/^VOID: /, "")}`.slice(0, 500), tag.rec_id).run();
    } else {
      if (table === "quotations") await env.OFFICE_DB.prepare("DELETE FROM line_items WHERE quotation_id = ?").bind(tag.rec_id).run();
      await env.OFFICE_DB.prepare(`DELETE FROM ${table} WHERE id = ?`).bind(tag.rec_id).run();
    }
    await env.OFFICE_DB.prepare("UPDATE mcp_created_records SET undone_at = datetime('now'), undone_by = ? WHERE id = ? AND undone_at IS NULL").bind(by.slice(0, 254), tag.id).run();
  } catch {
    return { ok: false, reason: "error", message: "That could not be undone. Nothing was lost: a copy was saved first." };
  }
  return { ok: true, action: table === "invoices" ? "voided" : "removed", kind, recordId: tag.rec_id };
}

/** Undoes everything one call created, one record at a time (newest first, so a payment goes before the invoice it was against). Reports each result; a refusal on one never stops the rest. */
export async function undoCall(env: Env, createId: unknown, by: string): Promise<{ found: boolean; results: Array<{ tagId: number; kind: string; recordId: number; result: UndoResult }> }> {
  if (typeof createId !== "number" || !Number.isInteger(createId) || createId < 1) return { found: false, results: [] };
  let tags: Array<{ id: number; tbl: string; rec_id: number }> = [];
  try { tags = (await env.OFFICE_DB.prepare("SELECT id, tbl, rec_id FROM mcp_created_records WHERE create_id = ? AND undone_at IS NULL ORDER BY id DESC").bind(createId).all<{ id: number; tbl: string; rec_id: number }>()).results; } catch { tags = []; }
  const results = [];
  for (const t of tags) results.push({ tagId: t.id, kind: LABEL[t.tbl as TrackedTable] ?? EFFECT_LABEL[t.tbl as EffectKind] ?? t.tbl, recordId: t.rec_id, result: await undoTagged(env, t.id, by) });
  return { found: tags.length > 0, results };
}

/** What the connected assistants created, newest first, for the owner's list. `state` says whether it can still be undone. */
export async function listCreated(env: Env, limit: number): Promise<Array<Record<string, unknown>>> {
  let tags: Array<Tag & { created_at: string; label: string | null; undone_by: string | null; snapshot: string | null }> = [];
  try {
    tags = (await env.OFFICE_DB.prepare("SELECT r.id, r.create_id, r.key_id, r.tbl, r.rec_id, r.undone_at, r.undone_by, r.created_at, r.snapshot AS snapshot, k.label AS label FROM mcp_created_records r LEFT JOIN mcp_keys k ON k.id = r.key_id ORDER BY r.id DESC LIMIT ?").bind(Math.min(Math.max(Math.floor(limit) || 50, 1), 200)).all<Tag & { created_at: string; label: string | null; undone_by: string | null; snapshot: string | null }>()).results;
  } catch { return []; }
  const out: Array<Record<string, unknown>> = [];
  for (const t of tags) {
    if (isEffectKind(t.tbl)) { out.push({ id: t.id, callId: t.create_id, keyId: t.key_id, connection: t.label ?? "a connected assistant", kind: EFFECT_LABEL[t.tbl], recordId: t.rec_id, createdAt: t.created_at, state: t.undone_at !== null ? "undone" : "active", undoneAt: t.undone_at, summary: { description: describeEffect(t.snapshot) } }); continue; }
    const table = t.tbl as TrackedTable; if (!(TRACKED_TABLES as readonly string[]).includes(t.tbl)) continue;
    let summary: Record<string, unknown> | null = null;
    try { summary = await env.OFFICE_DB.prepare(`SELECT ${table === "tasks" ? "description" : table === "payments" ? "amount" : "description, amount"}${table === "invoices" ? ", status" : ""}${table === "quotations" ? ", status" : ""} FROM ${table} WHERE id = ?`).bind(t.rec_id).first(); } catch { summary = null; }
    const state = t.undone_at !== null ? "undone" : summary === null ? "gone" : summary.status === "void" ? "void" : "active";
    out.push({ id: t.id, callId: t.create_id, keyId: t.key_id, connection: t.label ?? "a connected assistant", kind: LABEL[table], recordId: t.rec_id, createdAt: t.created_at, state, undoneAt: t.undone_at, summary });
  }
  return out;
}
