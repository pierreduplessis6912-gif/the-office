// REVERSIBLE DECISIONS (MCP_ARCHITECTURE.md, "Claude confirms more kinds"). A held action a connection proposed that does not create a tracked record (mcp-tags.ts) but CHANGES something (stock added, a fact saved about a customer) may be confirmed by the assistant only because the owner can put it back. This module does both halves: before the app's own confirm route runs it takes a small copy of what that decision is about to touch (captureBefore), after it succeeds it works out exactly what changed (captureAfter, kept as the tag's snapshot), and undoEffect reverses exactly that, refusing, and changing nothing, if the thing was changed again since.
// THE RULES (each held by a test that fails if it is removed, tools/mcp-effects-breakage.js): (1) only what the decision itself changed is reversed, never a bare id or anything else about the same customer or item; (2) an undo is REFUSED, writing nothing, when what it would put back has been changed since (stock used or counted, a fact changed again); (3) an undo is one transaction: all of it or none; (4) reading before and after never writes, and a failure to read leaves the confirmation as it was (nothing is tagged, so nothing claims an undo that is not there).
import { atomically } from "./atomic";
import type { Env } from "./types";

export const EFFECT_KINDS = ["stock_add", "customer_fact"] as const;
export type EffectKind = (typeof EFFECT_KINDS)[number];
export const isEffectKind = (type: string): type is EffectKind => (EFFECT_KINDS as readonly string[]).includes(type);
export const EFFECT_LABEL: Record<EffectKind, string> = { stock_add: "stock add", customer_fact: "customer fact" };

type Row = Record<string, unknown>;
export interface Before { kind: EffectKind; data: Row }
export type EffectUndo = { ok: true } | { ok: false; reason: "blocked" | "gone" | "error"; message: string };

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const parse = (text: string | null): Row | null => { try { const v = JSON.parse(text ?? ""); return v && typeof v === "object" && !Array.isArray(v) ? (v as Row) : null; } catch { return null; } };
const cleanName = (v: unknown): string => (typeof v === "string" ? v.trim().slice(0, 120) : "");

async function stockByName(env: Env, name: string): Promise<{ id: number; quantity_on_hand: number } | null> {
  return (await env.OFFICE_DB.prepare("SELECT id, quantity_on_hand FROM stock_items WHERE name = ? COLLATE NOCASE ORDER BY id LIMIT 1").bind(name).first<{ id: number; quantity_on_hand: number }>()) ?? null;
}

/** What the decision is about to touch. Null when it cannot be read: the caller then tags nothing. Reads only. */
export async function captureBefore(env: Env, type: string, payloadText: string | null): Promise<Before | null> {
  if (!isEffectKind(type)) return null;
  const payload = parse(payloadText);
  if (!payload) return null;
  try {
    if (type === "stock_add") {
      const items = Array.isArray(payload.items) ? payload.items : [];
      const seen: Array<{ name: string; id: number | null; quantity: number | null }> = [];
      for (const raw of items.slice(0, 50)) {
        const name = cleanName((raw as Row)?.name);
        if (!name || seen.some((s) => s.name.toLowerCase() === name.toLowerCase())) continue;
        const found = await stockByName(env, name);
        seen.push({ name, id: found?.id ?? null, quantity: found?.quantity_on_hand ?? null });
      }
      return { kind: type, data: { items: seen } };
    }
    const customerId = payload.customerId;
    if (typeof customerId !== "number" || !Number.isInteger(customerId) || customerId < 1) return null;
    const row = await env.OFFICE_DB.prepare("SELECT * FROM customers WHERE id = ?").bind(customerId).first<Row>();
    if (!row) return null;
    const facts = await env.OFFICE_DB.prepare("SELECT id FROM customer_facts WHERE customer_id = ?").bind(customerId).all<{ id: number }>();
    return { kind: type, data: { customerId, row, factIds: (facts.results ?? []).map((f) => f.id) } };
  } catch { return null; }
}

/** Exactly what the confirmation changed, or null when it changed nothing (then there is nothing to undo and nothing is tagged). `answer` is the confirm route's own reply. Reads only. */
export async function captureAfter(env: Env, before: Before, answer: unknown): Promise<Row | null> {
  try {
    if (before.kind === "stock_add") {
      const added = Array.isArray((answer as Row | null)?.addedToStock) ? ((answer as Row).addedToStock as Row[]) : [];
      const was = (before.data.items as Array<{ name: string; id: number | null }>) ?? [];
      const items: Row[] = [];
      for (const a of added.slice(0, 50)) {
        const name = cleanName(a.name), quantity = Number(a.quantity);
        if (!name || !Number.isFinite(quantity) || quantity <= 0) continue;
        const now = await stockByName(env, name);
        if (!now) continue;
        const prior = was.find((w) => w.name.toLowerCase() === name.toLowerCase());
        items.push({ stockItemId: now.id, name, added: quantity, created: !prior || prior.id === null, quantityAfter: now.quantity_on_hand });
      }
      return items.length > 0 ? { effect: "stock_add", items } : null;
    }
    const customerId = before.data.customerId as number, row = before.data.row as Row;
    const now = await env.OFFICE_DB.prepare("SELECT * FROM customers WHERE id = ?").bind(customerId).first<Row>();
    const facts = await env.OFFICE_DB.prepare("SELECT id FROM customer_facts WHERE customer_id = ?").bind(customerId).all<{ id: number }>();
    if (!now) return null;
    const changes = Object.keys(now).filter((k) => !same(row[k], now[k])).map((column) => ({ column, before: row[column] ?? null, after: now[column] ?? null }));
    const known = new Set(before.data.factIds as number[]);
    const newFactIds = (facts.results ?? []).map((f) => f.id).filter((id) => !known.has(id));
    return changes.length > 0 || newFactIds.length > 0 ? { effect: "customer_fact", customerId, changes, newFactIds } : null;
  } catch { return null; }
}

/** A short line for the owner's list. */
export function describeEffect(snapshotText: string | null): string | null {
  const s = parse(snapshotText);
  if (!s) return null;
  if (s.effect === "stock_add" && Array.isArray(s.items)) return `Added to stock: ${(s.items as Row[]).map((i) => `${String(i.name).slice(0, 60)} (${Number(i.added)})`).join(", ")}`.slice(0, 200);
  if (s.effect === "customer_fact") {
    const cols = Array.isArray(s.changes) ? (s.changes as Row[]).map((c) => String(c.column)).join(", ") : "";
    return `Customer ${Number(s.customerId)}: ${cols || "a saved fact"}`.slice(0, 200);
  }
  return null;
}

/** Puts back exactly what that decision changed, or refuses and writes nothing. */
export async function undoEffect(env: Env, snapshotText: string | null): Promise<EffectUndo> {
  const s = parse(snapshotText);
  if (!s) return { ok: false, reason: "error", message: "There is no record of what this changed, so it cannot be undone." };
  try {
    if (s.effect === "stock_add" && Array.isArray(s.items)) {
      const items = s.items as Array<{ stockItemId: number; added: number; created: boolean; quantityAfter: number }>;
      for (const it of items) {
        const row = await env.OFFICE_DB.prepare("SELECT id, quantity_on_hand FROM stock_items WHERE id = ?").bind(it.stockItemId).first<{ id: number; quantity_on_hand: number }>();
        if (!row) return { ok: false, reason: "gone", message: "That stock item no longer exists, so there is nothing to put back." };
        if (row.quantity_on_hand !== it.quantityAfter) return { ok: false, reason: "blocked", message: "That stock has been used or counted since it was added, so it was not changed." };
        if (it.created) for (const [table, col] of [["stock_usage_log", "stock_item_id"], ["stocktake_lines", "stock_item_id"]] as const) {
          const n = await env.OFFICE_DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${col} = ?`).bind(it.stockItemId).first<{ n: number }>().catch(() => null);
          if ((n?.n ?? 0) > 0) return { ok: false, reason: "blocked", message: "That stock item has been used or counted since, so it was not removed." };
        }
      }
      await atomically(env, async (tx) => {
        for (const it of items) {
          if (it.created) await tx.OFFICE_DB.prepare("DELETE FROM stock_items WHERE id = ? AND quantity_on_hand = ?").bind(it.stockItemId, it.quantityAfter).run();
          else await tx.OFFICE_DB.prepare("UPDATE stock_items SET quantity_on_hand = quantity_on_hand - ? WHERE id = ? AND quantity_on_hand = ?").bind(it.added, it.stockItemId, it.quantityAfter).run();
        }
      });
      return { ok: true };
    }
    if (s.effect === "customer_fact") {
      const customerId = s.customerId as number, changes = (Array.isArray(s.changes) ? s.changes : []) as Array<{ column: string; before: unknown; after: unknown }>, newFactIds = (Array.isArray(s.newFactIds) ? s.newFactIds : []) as number[];
      const now = await env.OFFICE_DB.prepare("SELECT * FROM customers WHERE id = ?").bind(customerId).first<Row>();
      if (!now) return { ok: false, reason: "gone", message: "That customer no longer exists, so there is nothing to put back." };
      for (const c of changes) {
        if (!/^[a-z_]+$/.test(c.column) || !(c.column in now)) return { ok: false, reason: "error", message: "That change cannot be undone." };
        if (!same(now[c.column], c.after)) return { ok: false, reason: "blocked", message: "That detail has been changed again since, so it was not changed back." };
      }
      await atomically(env, async (tx) => {
        for (const c of changes) await tx.OFFICE_DB.prepare(`UPDATE customers SET ${c.column} = ? WHERE id = ?`).bind(c.before ?? null, customerId).run();
        for (const id of newFactIds) await tx.OFFICE_DB.prepare("DELETE FROM customer_facts WHERE id = ? AND customer_id = ?").bind(id, customerId).run();
      });
      return { ok: true };
    }
    return { ok: false, reason: "error", message: "That cannot be undone." };
  } catch { return { ok: false, reason: "error", message: "That could not be undone. Nothing was changed." }; }
}
