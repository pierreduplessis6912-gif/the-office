// HELD ACTIONS PROPOSED THROUGH A CONNECTION (MCP_ARCHITECTURE.md). Every money action (an invoice, a quote, an expense, a payment) is HELD by the pipeline as a pending action and only becomes a record when it is confirmed (POST /actions/:id/confirm). When an assistant tells the Office something, what comes back is therefore usually a held action, not a record. Two things follow, and this module does both: (1) the held action is LINKED to the key that proposed it, so that whoever confirms it (the owner in the app, or the assistant through confirm_pending_action) the record that is then created is TAGGED to that key, shows in the owner's list and can be undone; (2) the assistant may confirm or reject ONLY an action its own key proposed, of a kind that needs no answer (CONFIRMABLE), once.
// A confirmed record is tagged EXACTLY (mcp-tags.ts wraps the database of that one confirm request), never by guessing.
import type { Env } from "./types";
import { TRACKED_TABLES, taggingEnv, type TagSink, type TrackedTable } from "./mcp-tags";
import { captureAfter, captureBefore, isEffectKind } from "./mcp-effects";

/** The held actions an assistant may confirm or reject itself: the ones that only need a yes AND that the owner can put back (a record the owner can undo, or a decision mcp-effects.ts can reverse). Anything that needs an answer (which person, which project) or changes what exists is left to the owner in the app. */
export const CONFIRMABLE = new Set(["expense", "payment", "invoice", "quotation", "stock_add", "customer_fact", "link_order"]);
const KIND: Record<string, string> = { expense: "expense", payment: "payment", invoice: "invoice", quotation: "quote" };
export const kindOfHeld = (type: string): string => KIND[type] ?? type.replace(/_/g, " ").slice(0, 40);

/** The held actions one tell produced: the money and order actions the pipeline lists, AND the fact actions it keeps in a separate list (a detail about a customer waits for a yes like any other). Without the fact ones those were never linked to the key, so the assistant that proposed them was told to send the owner to the app. Whole positive numbers only, each once, in order. */
export function heldIdsOf(ids: unknown, factIds: unknown): number[] {
  const out: number[] = [];
  for (const list of [ids, factIds]) if (Array.isArray(list)) for (const n of list) if (typeof n === "number" && Number.isInteger(n) && n > 0 && !out.includes(n)) out.push(n);
  return out;
}

export interface PendingLink { id: number; pending_id: number; key_id: string; create_id: number; type: string; status: string }

export async function ensurePending(env: Env): Promise<void> {
  await env.OFFICE_DB.prepare("CREATE TABLE IF NOT EXISTS mcp_pending_links (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL DEFAULT (datetime('now')), pending_id INTEGER NOT NULL UNIQUE, key_id TEXT NOT NULL, create_id INTEGER NOT NULL, type TEXT NOT NULL, summary TEXT, status TEXT NOT NULL DEFAULT 'waiting', resolved_at TEXT, resolved_by TEXT)").run();
}

const clean = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() ? v.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max) : null);

/** A short, safe description of a held action for the owner's list and the assistant's answer: only the amount, a description and a name, read out of the stored payload. */
export function summarise(payload: string | null): string | null {
  try {
    const p = JSON.parse(payload ?? "") as Record<string, unknown>;
    const parts: string[] = [];
    if (typeof p.amount === "number" && Number.isFinite(p.amount)) parts.push(`R${p.amount.toLocaleString("en-ZA")}`);
    const what = clean(p.description, 80) ?? clean(p.note, 80);
    if (what) parts.push(what);
    if (Array.isArray(p.items) && p.amount === undefined) { const names = (p.items as Array<Record<string, unknown>>).slice(0, 5).map((i) => (clean(i?.name, 40) ? `${clean(i.name, 40)}${typeof i.quantity === "number" ? ` (${i.quantity})` : ""}` : null)).filter(Boolean); if (names.length) parts.push(names.join(", ")); }
    if (typeof p.key === "string" && typeof p.value === "string") { const k = clean(p.key, 30), v = clean(p.value, 50); if (k && v) parts.push(`${k}: ${v}`); }
    const who = clean(p.customerName, 60) ?? clean(p.characterName, 60);
    if (who) parts.push(`for ${who}`);
    return parts.length ? parts.join(", ") : null;
  } catch { return null; }
}

/** After a tell: links every held action that call produced to the key. Returns what was held (kind, summary, whether the assistant may confirm it). */
export async function linkHeld(env: Env, keyId: string, createId: number, pendingIds: number[]): Promise<Array<{ actionId: number; kind: string; summary: string | null; canConfirmHere: boolean }>> {
  const out: Array<{ actionId: number; kind: string; summary: string | null; canConfirmHere: boolean }> = [];
  const ids = [...new Set(pendingIds.filter((n) => Number.isInteger(n) && n > 0))].slice(0, 20);
  if (ids.length === 0) return out;
  await ensurePending(env);
  let rows: Array<{ id: number; type: string; payload: string | null; status: string }> = [];
  try { rows = (await env.OFFICE_DB.prepare(`SELECT id, type, payload, status FROM pending_actions WHERE id IN (${ids.map(() => "?").join(",")})`).bind(...ids).all<{ id: number; type: string; payload: string | null; status: string }>()).results; } catch { rows = []; }
  for (const r of rows) {
    if (r.status !== "pending") continue;
    const summary = summarise(r.payload);
    try { await env.OFFICE_DB.prepare("INSERT OR IGNORE INTO mcp_pending_links (pending_id, key_id, create_id, type, summary) VALUES (?, ?, ?, ?, ?)").bind(r.id, keyId, createId, r.type, summary).run(); } catch { continue; }
    out.push({ actionId: r.id, kind: kindOfHeld(r.type), summary, canConfirmHere: CONFIRMABLE.has(r.type) });
  }
  return out;
}

/** The link for a held action, if a connection proposed it and it is still waiting. Null for everything the app made (nearly all of it). */
export async function findLink(env: Env, pendingId: number): Promise<PendingLink | null> {
  try { return (await env.OFFICE_DB.prepare("SELECT id, pending_id, key_id, create_id, type, status FROM mcp_pending_links WHERE pending_id = ? AND status = 'waiting'").bind(pendingId).first<PendingLink>()) ?? null; } catch { return null; }
}

/** Records how a linked held action ended, and tags the records its confirmation created. */
export async function finishLink(env: Env, link: PendingLink, outcome: "confirmed" | "rejected", by: "app" | "claude", tagged: Array<{ table: TrackedTable; id: number }>, effect?: { tbl: string; snapshot: string }): Promise<void> {
  try {
    await env.OFFICE_DB.prepare("UPDATE mcp_pending_links SET status = ?, resolved_at = datetime('now'), resolved_by = ? WHERE id = ? AND status = 'waiting'").bind(outcome, by, link.id).run();
    for (const t of tagged) if ((TRACKED_TABLES as readonly string[]).includes(t.table)) await env.OFFICE_DB.prepare("INSERT OR IGNORE INTO mcp_created_records (create_id, key_id, tbl, rec_id) VALUES (?, ?, ?, ?)").bind(link.create_id, link.key_id, t.table, t.id).run();
    if (effect && outcome === "confirmed") await env.OFFICE_DB.prepare("INSERT OR IGNORE INTO mcp_created_records (create_id, key_id, tbl, rec_id, snapshot) VALUES (?, ?, ?, ?, ?)").bind(link.create_id, link.key_id, effect.tbl, link.pending_id, effect.snapshot).run();
  } catch { /* the tag never undoes a confirmation */ }
}

/** A sink that collects what a confirm request created. */
export function collector(): { sink: TagSink; tagged: Array<{ table: TrackedTable; id: number }>; untraced: () => number } {
  const tagged: Array<{ table: TrackedTable; id: number }> = []; let lost = 0;
  return { sink: { record: (table, id) => { if (!tagged.some((t) => t.table === table && t.id === id)) tagged.push({ table, id }); }, untraced: () => { lost++; } }, tagged, untraced: () => lost };
}

/** For the owner's list: what connections proposed, newest first, and how each ended. */
export async function listHeld(env: Env, limit: number): Promise<Array<Record<string, unknown>>> {
  try {
    const { results } = await env.OFFICE_DB.prepare("SELECT l.pending_id, l.type, l.summary, l.status, l.created_at, l.resolved_by, k.label AS label FROM mcp_pending_links l LEFT JOIN mcp_keys k ON k.id = l.key_id ORDER BY l.id DESC LIMIT ?").bind(Math.min(Math.max(Math.floor(limit) || 50, 1), 200)).all<Record<string, unknown>>();
    return results.map((r) => ({ actionId: r.pending_id, kind: kindOfHeld(String(r.type)), summary: r.summary ?? null, state: r.status === "confirmed" ? "confirmed" : r.status === "rejected" ? "rejected" : "waiting", connection: r.label ?? "a connected assistant", createdAt: r.created_at, resolvedBy: r.resolved_by ?? null }));
  } catch { return []; }
}

/** For the front door (index.ts serveRequest): when this request is a decision on a held action a CONNECTION proposed, the environment to run it with (its database reports what the confirmation creates) and what to do with the answer. Null for everything else, which is nearly every request. The tagging happens only if the decision SUCCEEDED, so a refused or failed one tags nothing. */
export async function mcpDecision(request: Request, env: Env): Promise<{ env: Env; finish: (response: Response) => Promise<void> } | null> {
  if (request.method !== "POST") return null;
  let path = ""; try { path = new URL(request.url).pathname; } catch { return null; }
  const m = /^\/actions\/(\d+)\/(confirm|reject)$/.exec(path);
  if (!m) return null;
  const link = await findLink(env, Number(m[1]));
  if (!link) return null;
  const seen = collector(); const confirm = m[2] === "confirm";
  // a decision that changes something other than a tracked record (stock, a customer's details): a copy of what it is about to touch, so that exactly that can be put back (mcp-effects.ts)
  let before: Awaited<ReturnType<typeof captureBefore>> = null;
  if (confirm && isEffectKind(link.type)) { try { const row = await env.OFFICE_DB.prepare("SELECT payload FROM pending_actions WHERE id = ?").bind(link.pending_id).first<{ payload: string | null }>(); before = await captureBefore(env, link.type, row?.payload ?? null); } catch { before = null; } }
  return { env: taggingEnv(env, seen.sink), finish: async (response) => {
    if (!response.ok) return;
    let effect: { tbl: string; snapshot: string } | undefined;
    if (confirm && before) { try { const answer = await response.clone().json().catch(() => null); const snap = await captureAfter(env, before, answer); if (snap) effect = { tbl: link.type, snapshot: JSON.stringify(snap) }; } catch { effect = undefined; } }
    await finishLink(env, link, confirm ? "confirmed" : "rejected", "app", confirm ? seen.tagged : [], effect);
  } };
}
