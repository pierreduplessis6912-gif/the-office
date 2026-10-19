// The history and audit record (backend wrap-up point 3). Pinned in tools/history.test.js. Doctrine: conversation history is a RECORD, not the main experience, and a transcript alone does not establish what happened: a spoken request, an interpreted
// intent, a proposed action, a decision on it, an executed record and the reply are DIFFERENT things, so they are kept as different things here. (1) Recording a turn can NEVER change, delay or fail a reply: every write is swallowed. (2) "Heard" is the
// recorded speech and stays in `captures` (it is read from there, not copied); what The Office GENERATED (interpretation, reply, mode) is kept apart from it. (3) "Executed" is TRACED at read time through the capture_id that 18 business tables already
// carry, not guessed. (4) A decision on a held action (confirm, reject, edit-field) is recorded with who and the outcome, including refused attempts, from the response STATUS alone (the body is never read). (5) A member reads only their OWN turns; only an owner
// (can_manage_settings) may ask for everyone's. (6) Only an allowlist of the reply is stored: no capabilities, tokens or addresses beyond the actor. (7) Reading is read-only and bounded; the record is append-only. Nothing here deletes anything.
import { buildExperience } from "./experience";
import type { Env } from "./types";

const MAX_REPLY = 4000, MAX_INTERPRETED = 2000, MAX_EMAIL = 254, MAX_LIMIT = 100, DEFAULT_LIMIT = 20;
// The business tables that carry a capture_id: a record in any of them was written from that utterance.
const TRACED_TABLES = ["character_facts", "expenses", "goods_received_notes", "interaction_edges", "invoices", "job_scope_amendments", "job_scopes", "leads", "projects", "purchase_orders", "quotations", "snags", "stock_usage_log", "stocktakes", "supplier_invoices", "supplier_payments", "tasks", "variance_dispositions"];

const made = new WeakSet<object>();
async function ensureTables(env: Env): Promise<void> {
  const db = env.OFFICE_DB as unknown as object;
  if (made.has(db)) return;
  await env.OFFICE_DB.prepare("CREATE TABLE IF NOT EXISTS interaction_log (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL DEFAULT (datetime('now')), actor_email TEXT, source TEXT NOT NULL, capture_id INTEGER, interpreted TEXT, proposed TEXT, replied TEXT, mode TEXT)").run();
  await env.OFFICE_DB.prepare("CREATE INDEX IF NOT EXISTS idx_interaction_actor ON interaction_log (actor_email, id)").run();
  await env.OFFICE_DB.prepare("CREATE TABLE IF NOT EXISTS action_events (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL DEFAULT (datetime('now')), action_id INTEGER NOT NULL, kind TEXT NOT NULL, actor_email TEXT, outcome TEXT)").run();
  await env.OFFICE_DB.prepare("CREATE INDEX IF NOT EXISTS idx_action_events_action ON action_events (action_id, id)").run();
  made.add(db);
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const tidyEmail = (value: unknown): string | null => (typeof value === "string" && value.length <= MAX_EMAIL && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value.trim()) ? value.trim().toLowerCase() : null);

// ---- recording -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Records one turn. Returns whether it was written; NEVER throws.
export async function recordInteraction(env: Env, turn: { actorEmail: unknown; source: unknown; captureId: number | null; processed: unknown }): Promise<boolean> {
  try {
    await ensureTables(env);
    const experience = buildExperience(turn.processed);   // the held actions and the recommended mode come from the envelope's own function: one derivation
    let interpreted: string | null = null;
    let replied: string | null = null;
    if (isRecord(turn.processed)) {
      try {
        const extraction = turn.processed.extraction;
        if (extraction !== undefined && extraction !== null) { const json = JSON.stringify(extraction); interpreted = json.length > MAX_INTERPRETED ? JSON.stringify({ truncated: true, text: json.slice(0, MAX_INTERPRETED - 100) }) : json; }
      } catch { interpreted = null; }
      try { const message = turn.processed.message; if (typeof message === "string") replied = message.slice(0, MAX_REPLY); } catch { replied = null; }
    }
    const source = typeof turn.source === "string" && turn.source.length <= 20 ? turn.source : "text";
    const captureId = typeof turn.captureId === "number" && Number.isSafeInteger(turn.captureId) && turn.captureId > 0 ? turn.captureId : null;
    await env.OFFICE_DB.prepare("INSERT INTO interaction_log (actor_email, source, capture_id, interpreted, proposed, replied, mode) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(tidyEmail(turn.actorEmail), source, captureId, interpreted, JSON.stringify(experience.established.heldActions), replied, experience.recommendation.mode).run();
    return true;
  } catch {
    return false;
  }
}

const KINDS: Record<string, "confirmed" | "rejected" | "edited"> = { confirm: "confirmed", reject: "rejected", "edit-field": "edited" };
// A POST to /actions/<id>/confirm, /reject or /edit-field is a decision on a held action; anything else is not.
export function decisionOf(method: string, pathname: string): { actionId: number; kind: "confirmed" | "rejected" | "edited" } | null {
  if (method !== "POST") return null;
  const match = /^\/actions\/(\d+)\/(confirm|reject|edit-field)$/.exec(pathname);
  if (!match) return null;
  const actionId = Number(match[1]);
  return Number.isSafeInteger(actionId) && actionId > 0 ? { actionId, kind: KINDS[match[2]] } : null;
}

// Records a decision with who and the outcome (done, or refused with its status). Uses ONLY the response status, never its body. NEVER throws.
export async function recordDecision(env: Env, event: { method: string; pathname: string; status: number; actorEmail: unknown }): Promise<boolean> {
  try {
    const decision = decisionOf(event.method, event.pathname);
    if (!decision) return false;
    await ensureTables(env);
    const outcome = event.status >= 200 && event.status < 300 ? "done" : `refused:${event.status}`;
    await env.OFFICE_DB.prepare("INSERT INTO action_events (action_id, kind, actor_email, outcome) VALUES (?, ?, ?, ?)").bind(decision.actionId, decision.kind, tidyEmail(event.actorEmail), outcome).run();
    return true;
  } catch {
    return false;
  }
}

// ---- the request ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
export function parseHistoryParams(search: URLSearchParams): { ok: true; who: "me" | "all"; limit: number; before: number | null } | { ok: false; error: string } {
  const who = search.get("who") ?? "me";
  if (who !== "me" && who !== "all") return { ok: false, error: "who must be exactly me or all." };
  const rawLimit = search.get("limit");
  if (rawLimit !== null && !/^\d+$/.test(rawLimit)) return { ok: false, error: `limit must be a whole number from 1 to ${MAX_LIMIT}.` };
  const limit = rawLimit === null ? DEFAULT_LIMIT : Number(rawLimit);
  if (limit < 1 || limit > MAX_LIMIT) return { ok: false, error: `limit must be a whole number from 1 to ${MAX_LIMIT}.` };
  const rawBefore = search.get("before");
  if (rawBefore !== null && (!/^\d+$/.test(rawBefore) || !Number.isSafeInteger(Number(rawBefore)) || Number(rawBefore) < 1)) return { ok: false, error: "before must be a positive whole number (the next value from the previous page)." };
  return { ok: true, who, limit, before: rawBefore === null ? null : Number(rawBefore) };
}

// Everyone's history is the owner's; a member only ever reads their own.
export function resolveScope(who: "me" | "all", capabilities: readonly string[]): { ok: true; scope: "own" | "all" } | { ok: false; status: number; error: string } {
  if (who === "me") return { ok: true, scope: "own" };
  return capabilities.includes("can_manage_settings") ? { ok: true, scope: "all" } : { ok: false, status: 403, error: "Only the owner can read everyone's history." };
}

// ---- reading (read-only, bounded) ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
type Row = { id: number; at: string; actor_email: string | null; source: string; capture_id: number | null; interpreted: string | null; proposed: string | null; replied: string | null; mode: string | null; heard: string | null };
const parseJson = (text: string | null): unknown => { if (text === null) return null; try { return JSON.parse(text); } catch { return null; } };
const marks = (count: number): string => Array.from({ length: count }, () => "?").join(", ");

export async function readHistory(env: Env, query: { scope: "own" | "all"; viewer: string | null; limit: number; before: number | null }) {
  const empty = { version: 1 as const, scope: query.scope, items: [] as unknown[], next: null as number | null };
  const viewer = tidyEmail(query.viewer);
  let rows: Row[];
  try {
    const result = await env.OFFICE_DB.prepare(
      "SELECT l.id AS id, l.created_at AS at, l.actor_email AS actor_email, l.source AS source, l.capture_id AS capture_id, l.interpreted AS interpreted, l.proposed AS proposed, l.replied AS replied, l.mode AS mode, c.raw_text AS heard FROM interaction_log l LEFT JOIN captures c ON c.id = l.capture_id WHERE (? = 1 OR l.actor_email = ?) AND (? IS NULL OR l.id < ?) ORDER BY l.id DESC LIMIT ?",
    ).bind(query.scope === "all" ? 1 : 0, viewer, query.before, query.before, query.limit + 1).all<Row>();
    rows = result.results ?? [];
  } catch {
    return empty;   // the tables do not exist yet: nothing has been recorded
  }
  const page = rows.slice(0, query.limit);
  const next = rows.length > query.limit && page.length > 0 ? page[page.length - 1].id : null;
  if (page.length === 0) return { ...empty, next };

  const proposed = new Map<number, Array<{ id: number; type: string | null }>>();
  const actionIds = new Set<number>();
  for (const row of page) {
    const list = parseJson(row.proposed);
    const items = Array.isArray(list) ? list.filter((a): a is { id: number; type: string | null } => isRecord(a) && typeof a.id === "number") : [];
    proposed.set(row.id, items);
    for (const a of items) actionIds.add(a.id);
  }
  const ids = [...actionIds];
  const status = new Map<number, string>(), decisions = new Map<number, Array<{ at: string; action: number; kind: string; outcome: string | null; by: string | null }>>();
  if (ids.length > 0) {
    try { for (const r of (await env.OFFICE_DB.prepare(`SELECT id, status FROM pending_actions WHERE id IN (${marks(ids.length)})`).bind(...ids).all<{ id: number; status: string }>()).results ?? []) status.set(r.id, r.status); } catch { /* no pending actions table */ }
    try {
      for (const r of (await env.OFFICE_DB.prepare(`SELECT action_id, kind, actor_email, outcome, created_at AS at FROM action_events WHERE action_id IN (${marks(ids.length)}) ORDER BY id`).bind(...ids).all<{ action_id: number; kind: string; actor_email: string | null; outcome: string | null; at: string }>()).results ?? []) {
        const by = query.scope === "all" ? r.actor_email : r.actor_email !== null && r.actor_email === viewer ? "you" : "another member";
        const list = decisions.get(r.action_id) ?? [];
        list.push({ at: r.at, action: r.action_id, kind: r.kind, outcome: r.outcome, by });
        decisions.set(r.action_id, list);
      }
    } catch { /* no events yet */ }
  }
  const captureIds = [...new Set(page.map((r) => r.capture_id).filter((v): v is number => v !== null))];
  const written = new Map<number, Array<{ table: string; id: number }>>();
  if (captureIds.length > 0) {
    for (const table of TRACED_TABLES) {
      try {
        for (const r of (await env.OFFICE_DB.prepare(`SELECT id, capture_id FROM ${table} WHERE capture_id IN (${marks(captureIds.length)}) ORDER BY id`).bind(...captureIds).all<{ id: number; capture_id: number }>()).results ?? []) {
          const list = written.get(r.capture_id) ?? [];
          list.push({ table, id: r.id });
          written.set(r.capture_id, list);
        }
      } catch { /* a table an older database does not have */ }
    }
  }
  const items = page.map((row) => {
    const mine = proposed.get(row.id) ?? [];
    const item = {
      id: row.id, at: row.at, source: row.source,
      recorded: { heard: row.heard },   // what was actually said or typed: recorded speech
      generated: { interpreted: parseJson(row.interpreted), replied: row.replied, mode: row.mode },   // what The Office produced: system-generated
      proposed: mine.map((a) => ({ id: a.id, type: a.type, status: status.get(a.id) ?? null })),
      decisions: mine.flatMap((a) => decisions.get(a.id) ?? []),
      recordsWritten: row.capture_id === null ? [] : written.get(row.capture_id) ?? [],
    };
    return query.scope === "all" ? { ...item, actor: row.actor_email } : item;
  });
  return { version: 1 as const, scope: query.scope, items, next };
}
