// STOCK (docs/decisions/inventory.md and inventory-integration.md). Items, locations and one immutable movement ledger (eng_item, eng_location, eng_stock_move, migration 0005). A movement's QUANTITY is in thousandths and its VALUE in minor units is the
// authoritative value moved: stock on hand is the sum of signed quantities and stock value the sum of signed values, so zero quantity is exactly zero value. Cost is WEIGHTED AVERAGE, company-wide per item, STAMPED when a movement is recorded and never
// changed after (an issue carries the average at that moment); LIFO is never offered (IAS 2 and the South African courts). Stock can never go negative, per item and per location; a mistake is corrected by a reversing movement, never an edit. Everything else
// (an item's current name and reorder level, what is on hand, its average cost) is DERIVED. This file only READS and validates; facts.ts is the one write path. All money arithmetic uses BigInt: quantity times value overflows a double.
import type { Env } from "../types";
import { EngineError } from "./errors";
import { checkDate } from "./quotations";
import { partyProfile } from "./parties";
import { quotationSummary } from "./quotations";
import { onOrderByItem, orderLineItems, receiptLineSource } from "./purchasing";
import { lineNetMinor } from "./money";
import { isEffective } from "./ledger";

export const LOCATION_KINDS = ["warehouse", "vehicle", "site", "in_transit"] as const;
export const ADJUST_REASONS = ["damage", "loss", "theft", "found", "correction", "write_off"] as const;
export const ISSUE_REASONS = ["job", "sale", "use", "returned_to_supplier", "other"] as const;
export const IN_KINDS = ["receive", "transfer_in", "adjust_in", "reversal_in"] as const;
type Checked<T> = { ok: true; value: T } | { ok: false; reason: string };
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const whole = (v: unknown, min: number, max: number): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max;
const many = async <T>(env: Env, sql: string, ...binds: unknown[]): Promise<T[]> => ((await env.OFFICE_DB.prepare(sql).bind(...binds).all<T>()).results ?? []);
const one = async <T>(env: Env, sql: string, ...binds: unknown[]): Promise<T | null> => (await env.OFFICE_DB.prepare(sql).bind(...binds).first<T>()) ?? null;
const parse = (s: string): Record<string, unknown> => { try { const v = JSON.parse(s); return isObj(v) ? v : {}; } catch { return {}; } };
const MAX_QTY = 1_000_000_000_000, MAX_COST = 1_000_000_000_000;
const SIGN_SQL = "CASE WHEN kind IN ('receive', 'transfer_in', 'adjust_in', 'reversal_in') THEN 1 ELSE -1 END";

/** round(a * b / c) half up, exactly (BigInt): a quantity (thousandths) times a value can pass 2^53. */
export function mulDiv(a: number, b: number, c: number): number {
  if (c === 0) throw new EngineError("invalid_state", "Cannot divide by zero.");
  const n = BigInt(a) * BigInt(b), d = BigInt(c);
  return Number((2n * n + d) / (2n * d));
}
/** the value of `quantityMilli` units at `unitCostMinor` each */
export const valueOf = (quantityMilli: number, unitCostMinor: number): number => {
  const v = mulDiv(quantityMilli, unitCostMinor, 1000);
  if (!Number.isSafeInteger(v)) throw new EngineError("invalid_input", "That quantity at that cost comes to more than can be recorded exactly.");
  return v;
};

// ---- validation (pure) -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------
const text = (v: unknown, label: string, max: number): Checked<string> => (typeof v === "string" && v.trim() && v.trim().length <= max ? { ok: true, value: v.trim().replace(/\s+/g, " ") } : { ok: false, reason: `${label} must be 1 to ${max} characters` });
const strayOf = (o: Record<string, unknown>, allowed: string[]) => Object.keys(o).find((k) => !allowed.includes(k));
const qty = (v: unknown, label: string): Checked<number> => (whole(v, 1, MAX_QTY) ? { ok: true, value: v } : { ok: false, reason: `${label} must be a whole number of thousandths, at least 1` });

export interface ItemInput { sku: string; name: string; unit: string; reorderLevelMilli?: number; reorderQtyMilli?: number; preferredSupplierId?: number }
export function checkItemInput(v: unknown): Checked<ItemInput> {
  if (!isObj(v)) return { ok: false, reason: "the item must be an object" };
  const s = strayOf(v, ["sku", "name", "unit", "reorderLevelMilli", "reorderQtyMilli", "preferredSupplierId"]); if (s) return { ok: false, reason: `${s} is not a field of an item` };
  const sku = text(v.sku, "sku", 40); if (!sku.ok) return sku; const name = text(v.name, "name", 120); if (!name.ok) return name; const unit = text(v.unit, "unit", 20); if (!unit.ok) return unit;
  const out: ItemInput = { sku: sku.value, name: name.value, unit: unit.value };
  if (v.reorderLevelMilli !== undefined) { if (!whole(v.reorderLevelMilli, 0, MAX_QTY)) return { ok: false, reason: "reorderLevelMilli must be a whole number of thousandths, 0 or more" }; out.reorderLevelMilli = v.reorderLevelMilli; }
  if (v.reorderQtyMilli !== undefined) { if (!whole(v.reorderQtyMilli, 1, MAX_QTY)) return { ok: false, reason: "reorderQtyMilli must be a whole number of thousandths, at least 1" }; out.reorderQtyMilli = v.reorderQtyMilli; }
  if (v.preferredSupplierId !== undefined) { if (!whole(v.preferredSupplierId, 1, Number.MAX_SAFE_INTEGER)) return { ok: false, reason: "preferredSupplierId must be a record number" }; out.preferredSupplierId = v.preferredSupplierId; }
  return { ok: true, value: out };
}
export interface ItemRevision { itemId: number; name?: string; reorderLevelMilli?: number; reorderQtyMilli?: number; preferredSupplierId?: number | null; active?: boolean }
export function checkItemRevision(v: unknown): Checked<ItemRevision> {
  if (!isObj(v)) return { ok: false, reason: "the request must be an object" };
  const s = strayOf(v, ["itemId", "name", "reorderLevelMilli", "reorderQtyMilli", "preferredSupplierId", "active"]); if (s) return { ok: false, reason: `${s} is not a field of this request` };
  if (!whole(v.itemId, 1, Number.MAX_SAFE_INTEGER)) return { ok: false, reason: "itemId must be a record number" };
  const out: ItemRevision = { itemId: v.itemId };
  if (v.name !== undefined) { const n = text(v.name, "name", 120); if (!n.ok) return n; out.name = n.value; }
  if (v.reorderLevelMilli !== undefined) { if (!whole(v.reorderLevelMilli, 0, MAX_QTY)) return { ok: false, reason: "reorderLevelMilli must be a whole number of thousandths, 0 or more" }; out.reorderLevelMilli = v.reorderLevelMilli; }
  if (v.reorderQtyMilli !== undefined) { if (!whole(v.reorderQtyMilli, 1, MAX_QTY)) return { ok: false, reason: "reorderQtyMilli must be a whole number of thousandths, at least 1" }; out.reorderQtyMilli = v.reorderQtyMilli; }
  if (v.preferredSupplierId !== undefined) { if (v.preferredSupplierId !== null && !whole(v.preferredSupplierId, 1, Number.MAX_SAFE_INTEGER)) return { ok: false, reason: "preferredSupplierId must be a record number, or null to clear it" }; out.preferredSupplierId = v.preferredSupplierId as number | null; }
  if (v.active !== undefined) { if (typeof v.active !== "boolean") return { ok: false, reason: "active must be true or false" }; out.active = v.active; }
  if (Object.keys(out).length === 1) return { ok: false, reason: "nothing to change: say what about the item changes" };
  return { ok: true, value: out };
}
export interface LocationInput { name: string; kind: string }
export function checkLocationInput(v: unknown): Checked<LocationInput> {
  if (!isObj(v)) return { ok: false, reason: "the location must be an object" };
  const s = strayOf(v, ["name", "kind"]); if (s) return { ok: false, reason: `${s} is not a field of a location` };
  const name = text(v.name, "name", 80); if (!name.ok) return name;
  if (typeof v.kind !== "string" || !(LOCATION_KINDS as readonly string[]).includes(v.kind)) return { ok: false, reason: `kind must be one of ${LOCATION_KINDS.join(", ")}` };
  return { ok: true, value: { name: name.value, kind: v.kind } };
}
export interface ReceiveInput { valueMinor?: number; itemId: number; locationId: number; quantityMilli: number; receivedOn: string; unitCostMinor?: number; receipt?: { documentId: number; lineNo: number } }
export function checkReceiveInput(v: unknown): Checked<ReceiveInput> {
  if (!isObj(v)) return { ok: false, reason: "the receipt must be an object" };
  const s = strayOf(v, ["itemId", "locationId", "quantityMilli", "receivedOn", "unitCostMinor", "receipt", "valueMinor"]); if (s) return { ok: false, reason: `${s} is not a field of a stock receipt` };
  if (!whole(v.itemId, 1, Number.MAX_SAFE_INTEGER) || !whole(v.locationId, 1, Number.MAX_SAFE_INTEGER)) return { ok: false, reason: "itemId and locationId must be record numbers" };
  const q = qty(v.quantityMilli, "quantityMilli"); if (!q.ok) return q; const d = checkDate(v.receivedOn, "receivedOn"); if (!d.ok) return d;
  const out: ReceiveInput = { itemId: v.itemId, locationId: v.locationId, quantityMilli: q.value, receivedOn: d.value };
  if (v.unitCostMinor !== undefined) { if (!whole(v.unitCostMinor, 0, MAX_COST)) return { ok: false, reason: "unitCostMinor must be a whole number of cents, 0 or more" }; out.unitCostMinor = v.unitCostMinor; }
  if (v.receipt !== undefined) {
    if (!isObj(v.receipt) || strayOf(v.receipt, ["documentId", "lineNo"]) || !whole(v.receipt.documentId, 1, Number.MAX_SAFE_INTEGER) || !whole(v.receipt.lineNo, 1, 100000)) return { ok: false, reason: "receipt must be {documentId, lineNo}: the goods receipt and the line the stock arrived on" };
    out.receipt = { documentId: v.receipt.documentId, lineNo: v.receipt.lineNo };
  }
  if (v.valueMinor !== undefined) { if (!whole(v.valueMinor, 0, Number.MAX_SAFE_INTEGER)) return { ok: false, reason: "valueMinor must be the value the engine worked out" }; out.valueMinor = v.valueMinor; }
  if (out.receipt && out.unitCostMinor !== undefined) return { ok: false, reason: "a receipt from a goods receipt takes its cost from that line: do not also give a cost" };
  if (!out.receipt && out.unitCostMinor === undefined) return { ok: false, reason: "give the cost of each unit (unitCostMinor), or the goods receipt line the stock arrived on" };
  return { ok: true, value: out };
}
export interface IssueInput { valueMinor?: number; itemId: number; locationId: number; quantityMilli: number; issuedOn: string; reason: string; jobRef?: string; documentId?: number; lineNo?: number; reservationId?: number }
export function checkIssueInput(v: unknown): Checked<IssueInput> {
  if (!isObj(v)) return { ok: false, reason: "the issue must be an object" };
  const s = strayOf(v, ["itemId", "locationId", "quantityMilli", "issuedOn", "reason", "jobRef", "documentId", "lineNo", "valueMinor", "reservationId"]); if (s) return { ok: false, reason: `${s} is not a field of a stock issue` };
  if (!whole(v.itemId, 1, Number.MAX_SAFE_INTEGER) || !whole(v.locationId, 1, Number.MAX_SAFE_INTEGER)) return { ok: false, reason: "itemId and locationId must be record numbers" };
  const q = qty(v.quantityMilli, "quantityMilli"); if (!q.ok) return q; const d = checkDate(v.issuedOn, "issuedOn"); if (!d.ok) return d;
  if (typeof v.reason !== "string" || !(ISSUE_REASONS as readonly string[]).includes(v.reason)) return { ok: false, reason: `reason must be one of ${ISSUE_REASONS.join(", ")}` };
  const out: IssueInput = { itemId: v.itemId, locationId: v.locationId, quantityMilli: q.value, issuedOn: d.value, reason: v.reason };
  if (v.jobRef !== undefined) { const j = text(v.jobRef, "jobRef", 60); if (!j.ok) return j; out.jobRef = j.value; }
  if (v.reason === "job" && out.jobRef === undefined) return { ok: false, reason: "an issue for a job names the job (jobRef)" };
  if (v.valueMinor !== undefined) { if (!whole(v.valueMinor, 0, Number.MAX_SAFE_INTEGER)) return { ok: false, reason: "valueMinor must be the value the engine worked out" }; out.valueMinor = v.valueMinor; }
  if (v.reservationId !== undefined) { if (!whole(v.reservationId, 1, Number.MAX_SAFE_INTEGER)) return { ok: false, reason: "reservationId must be a record number" }; out.reservationId = v.reservationId; }
  if ((v.documentId === undefined) !== (v.lineNo === undefined)) return { ok: false, reason: "name both the document and its line (documentId and lineNo), or neither" };
  if (v.documentId !== undefined) { if (!whole(v.documentId, 1, Number.MAX_SAFE_INTEGER) || !whole(v.lineNo, 1, 100000)) return { ok: false, reason: "documentId and lineNo must be record and line numbers" }; out.documentId = v.documentId; out.lineNo = v.lineNo as number; }
  return { ok: true, value: out };
}
export interface TransferInput { itemId: number; fromLocationId: number; toLocationId: number; quantityMilli: number; movedOn: string }
export function checkTransferInput(v: unknown): Checked<TransferInput> {
  if (!isObj(v)) return { ok: false, reason: "the transfer must be an object" };
  const s = strayOf(v, ["itemId", "fromLocationId", "toLocationId", "quantityMilli", "movedOn"]); if (s) return { ok: false, reason: `${s} is not a field of a transfer` };
  if (!whole(v.itemId, 1, Number.MAX_SAFE_INTEGER) || !whole(v.fromLocationId, 1, Number.MAX_SAFE_INTEGER) || !whole(v.toLocationId, 1, Number.MAX_SAFE_INTEGER)) return { ok: false, reason: "itemId, fromLocationId and toLocationId must be record numbers" };
  if (v.fromLocationId === v.toLocationId) return { ok: false, reason: "a transfer must go to a different location" };
  const q = qty(v.quantityMilli, "quantityMilli"); if (!q.ok) return q; const d = checkDate(v.movedOn, "movedOn"); if (!d.ok) return d;
  return { ok: true, value: { itemId: v.itemId, fromLocationId: v.fromLocationId, toLocationId: v.toLocationId, quantityMilli: q.value, movedOn: d.value } };
}
export interface AdjustInput { valueMinor?: number; itemId: number; locationId: number; direction: "in" | "out"; quantityMilli: number; adjustedOn: string; reason: string; note?: string; unitCostMinor?: number }
export function checkAdjustInput(v: unknown): Checked<AdjustInput> {
  if (!isObj(v)) return { ok: false, reason: "the adjustment must be an object" };
  const s = strayOf(v, ["itemId", "locationId", "direction", "quantityMilli", "adjustedOn", "reason", "note", "unitCostMinor", "valueMinor"]); if (s) return { ok: false, reason: `${s} is not a field of an adjustment` };
  if (!whole(v.itemId, 1, Number.MAX_SAFE_INTEGER) || !whole(v.locationId, 1, Number.MAX_SAFE_INTEGER)) return { ok: false, reason: "itemId and locationId must be record numbers" };
  if (v.direction !== "in" && v.direction !== "out") return { ok: false, reason: "direction must be in or out" };
  const q = qty(v.quantityMilli, "quantityMilli"); if (!q.ok) return q; const d = checkDate(v.adjustedOn, "adjustedOn"); if (!d.ok) return d;
  if (typeof v.reason !== "string" || !(ADJUST_REASONS as readonly string[]).includes(v.reason)) return { ok: false, reason: `reason must be one of ${ADJUST_REASONS.join(", ")} (an adjustment is always explained)` };
  const out: AdjustInput = { itemId: v.itemId, locationId: v.locationId, direction: v.direction, quantityMilli: q.value, adjustedOn: d.value, reason: v.reason };
  if (v.note !== undefined) { const n = text(v.note, "note", 200); if (!n.ok) return n; out.note = n.value; }
  if (v.valueMinor !== undefined) { if (!whole(v.valueMinor, 0, Number.MAX_SAFE_INTEGER)) return { ok: false, reason: "valueMinor must be the value the engine worked out" }; out.valueMinor = v.valueMinor; }
  if (v.unitCostMinor !== undefined) { if (!whole(v.unitCostMinor, 0, MAX_COST)) return { ok: false, reason: "unitCostMinor must be a whole number of cents, 0 or more" }; if (v.direction === "out") return { ok: false, reason: "stock going out leaves at its average cost: do not give a cost" }; out.unitCostMinor = v.unitCostMinor; }
  return { ok: true, value: out };
}
export interface StockReverseInput { moveId: number; reason: string; reversedOn: string }
export function checkReverseInput(v: unknown): Checked<StockReverseInput> {
  if (!isObj(v)) return { ok: false, reason: "the request must be an object" };
  const s = strayOf(v, ["moveId", "reason", "reversedOn"]); if (s) return { ok: false, reason: `${s} is not a field of this request` };
  if (!whole(v.moveId, 1, Number.MAX_SAFE_INTEGER)) return { ok: false, reason: "moveId must be a record number" };
  const r = text(v.reason, "reason", 200); if (!r.ok) return r; const d = checkDate(v.reversedOn, "reversedOn"); if (!d.ok) return d;
  return { ok: true, value: { moveId: v.moveId, reason: r.value, reversedOn: d.value } };
}

export interface ReserveInput { itemId: number; quantityMilli: number; reservedOn: string; locationId?: number; forDocumentId?: number; forRef?: string; note?: string }
export function checkReserveInput(v: unknown): Checked<ReserveInput> {
  if (!isObj(v)) return { ok: false, reason: "the reservation must be an object" };
  const s = strayOf(v, ["itemId", "quantityMilli", "reservedOn", "locationId", "forDocumentId", "forRef", "note"]); if (s) return { ok: false, reason: `${s} is not a field of a reservation` };
  if (!whole(v.itemId, 1, Number.MAX_SAFE_INTEGER)) return { ok: false, reason: "itemId must be a record number" };
  const q = qty(v.quantityMilli, "quantityMilli"); if (!q.ok) return q; const d = checkDate(v.reservedOn, "reservedOn"); if (!d.ok) return d;
  const out: ReserveInput = { itemId: v.itemId, quantityMilli: q.value, reservedOn: d.value };
  if (v.locationId !== undefined) { if (!whole(v.locationId, 1, Number.MAX_SAFE_INTEGER)) return { ok: false, reason: "locationId must be a record number" }; out.locationId = v.locationId; }
  if (v.forDocumentId !== undefined) { if (!whole(v.forDocumentId, 1, Number.MAX_SAFE_INTEGER)) return { ok: false, reason: "forDocumentId must be a record number" }; out.forDocumentId = v.forDocumentId; }
  if (v.forRef !== undefined) { const r = text(v.forRef, "forRef", 60); if (!r.ok) return r; out.forRef = r.value; }
  if (v.note !== undefined) { const n = text(v.note, "note", 200); if (!n.ok) return n; out.note = n.value; }
  if (out.forDocumentId === undefined && out.forRef === undefined) return { ok: false, reason: "say what the stock is held for: a quotation or invoice (forDocumentId) or a named job (forRef)" };
  return { ok: true, value: out };
}
export interface ReleaseInput { reservationId: number; reason: string; releasedOn: string }
export function checkReleaseInput(v: unknown): Checked<ReleaseInput> {
  if (!isObj(v)) return { ok: false, reason: "the request must be an object" };
  const s = strayOf(v, ["reservationId", "reason", "releasedOn"]); if (s) return { ok: false, reason: `${s} is not a field of this request` };
  if (!whole(v.reservationId, 1, Number.MAX_SAFE_INTEGER)) return { ok: false, reason: "reservationId must be a record number" };
  const r = text(v.reason, "reason", 200); if (!r.ok) return r; const d = checkDate(v.releasedOn, "releasedOn"); if (!d.ok) return d;
  return { ok: true, value: { reservationId: v.reservationId, reason: r.value, releasedOn: d.value } };
}
export interface CountLine { itemId: number; countedMilli: number; unitCostMinor?: number }
export interface CountInput { locationId: number; countedOn: string; complete?: boolean; note?: string; lines: CountLine[]; variances?: unknown }
export function checkCountInput(v: unknown): Checked<CountInput> {
  if (!isObj(v)) return { ok: false, reason: "the count must be an object" };
  const s = strayOf(v, ["locationId", "countedOn", "complete", "note", "lines", "variances"]); if (s) return { ok: false, reason: `${s} is not a field of a count` };
  if (!whole(v.locationId, 1, Number.MAX_SAFE_INTEGER)) return { ok: false, reason: "locationId must be a record number" };
  const d = checkDate(v.countedOn, "countedOn"); if (!d.ok) return d;
  if (v.complete !== undefined && typeof v.complete !== "boolean") return { ok: false, reason: "complete must be true or false" };
  if (!Array.isArray(v.lines) || v.lines.length === 0) return { ok: false, reason: "a count needs at least one line" };
  if (v.lines.length > 500) return { ok: false, reason: "a count may have at most 500 lines" };
  const lines: CountLine[] = [];
  for (const [i, l] of v.lines.entries()) {
    const at = `line ${i + 1}`;
    if (!isObj(l)) return { ok: false, reason: `${at} must be an object` };
    const st = strayOf(l, ["itemId", "countedMilli", "unitCostMinor"]); if (st) return { ok: false, reason: `${at}: ${st} is not a field of a count line` };
    if (!whole(l.itemId, 1, Number.MAX_SAFE_INTEGER)) return { ok: false, reason: `${at}: itemId must be a record number` };
    if (!whole(l.countedMilli, 0, MAX_QTY)) return { ok: false, reason: `${at}: countedMilli must be a whole number of thousandths, 0 or more` };
    const cl: CountLine = { itemId: l.itemId, countedMilli: l.countedMilli };
    if (l.unitCostMinor !== undefined) { if (!whole(l.unitCostMinor, 0, MAX_COST)) return { ok: false, reason: `${at}: unitCostMinor must be a whole number of cents, 0 or more` }; cl.unitCostMinor = l.unitCostMinor; }
    lines.push(cl);
  }
  if (new Set(lines.map((l) => l.itemId)).size !== lines.length) return { ok: false, reason: "the same item is counted twice: one line per item" };
  const out: CountInput = { locationId: v.locationId, countedOn: d.value, lines };
  if (v.complete !== undefined) out.complete = v.complete as boolean;
  if (v.note !== undefined) { const n = text(v.note, "note", 200); if (!n.ok) return n; out.note = n.value; }
  if (v.variances !== undefined) out.variances = v.variances;   // shown to the approver, never trusted: the variance is worked out again at approval
  return { ok: true, value: out };
}

// ---- reservations (events, derived) ------------------------------------------------------------------------------------------------------------------------------------------------------------------
export type ReservationStatus = "open" | "part_consumed" | "consumed" | "released";
export interface Reservation { id: number; eventId: number; itemId: number; locationId: number | null; quantityMilli: number; reservedOn: string; forDocumentId: number | null; forRef: string | null; note: string | null; consumedMilli: number; releasedMilli: number; remainingMilli: number; status: ReservationStatus }
/** Every reservation as it stands: what was held, what issues drew on it, what was released, what remains. A reservation's number is the id of the event that made it. */
export async function allReservations(env: Env, f: { itemId?: number; status?: string } = {}): Promise<Reservation[]> {
  const consumed = new Map<number, number>(), released = new Map<number, number>();
  for (const e of await many<{ payload_json: string }>(env, "SELECT payload_json FROM eng_event WHERE type = 'stock.issued' AND json_extract(payload_json, '$.reservationId') IS NOT NULL")) { const p = parse(e.payload_json); consumed.set(Number(p.reservationId), (consumed.get(Number(p.reservationId)) ?? 0) + (Number(p.quantityMilli) || 0)); }
  for (const e of await many<{ payload_json: string }>(env, "SELECT payload_json FROM eng_event WHERE type = 'stock.released'")) { const p = parse(e.payload_json); released.set(Number(p.reservationId), (released.get(Number(p.reservationId)) ?? 0) + (Number(p.quantityMilli) || 0)); }
  const out: Reservation[] = [];
  for (const e of await many<{ id: number; payload_json: string }>(env, "SELECT id, payload_json FROM eng_event WHERE type = 'stock.reserved' ORDER BY id")) {
    const p = parse(e.payload_json); const c = consumed.get(e.id) ?? 0, r = released.get(e.id) ?? 0, q = Number(p.quantityMilli) || 0, remaining = Math.max(0, q - c - r);
    const status: ReservationStatus = remaining > 0 ? (c > 0 ? "part_consumed" : "open") : r > 0 ? "released" : "consumed";
    const res: Reservation = { id: e.id, eventId: e.id, itemId: Number(p.itemId), locationId: typeof p.locationId === "number" ? p.locationId : null, quantityMilli: q, reservedOn: String(p.reservedOn ?? ""), forDocumentId: typeof p.forDocumentId === "number" ? p.forDocumentId : null, forRef: typeof p.forRef === "string" ? p.forRef : null, note: typeof p.note === "string" ? p.note : null, consumedMilli: c, releasedMilli: r, remainingMilli: remaining, status };
    if (f.itemId !== undefined && res.itemId !== f.itemId) continue;
    const want = f.status ?? "outstanding";
    if (want === "outstanding" ? remaining === 0 : want !== "any" && want !== status) continue;
    out.push(res);
  }
  return out;
}
export async function reservationDocument(env: Env, documentId: number): Promise<{ kind: string; status: string | null } | null> {
  const d = await one<{ kind: string }>(env, "SELECT kind FROM eng_document WHERE id = ?", documentId);
  if (!d) return null;
  if (d.kind === "quotation") return { kind: "quotation", status: (await quotationSummary(env, documentId))?.status ?? null };
  return { kind: d.kind, status: null };
}
export async function reservedFor(env: Env, itemId: number, locationId?: number): Promise<number> {
  return (await allReservations(env, { itemId })).filter((r) => locationId === undefined || r.locationId === locationId).reduce((s, r) => s + r.remainingMilli, 0);
}

export interface OrderLineItem { lineNo: number; itemId: number }
export function checkLineItems(v: unknown, lineCount: number): Checked<OrderLineItem[]> {
  if (!Array.isArray(v) || v.length === 0) return { ok: false, reason: "lineItems must be a list of {lineNo, itemId}, or left out" };
  const out: OrderLineItem[] = [];
  for (const [i, e] of v.entries()) {
    if (!isObj(e) || strayOf(e, ["lineNo", "itemId"])) return { ok: false, reason: `lineItems entry ${i + 1} must be {lineNo, itemId}` };
    if (!whole(e.lineNo, 1, lineCount)) return { ok: false, reason: `lineItems entry ${i + 1}: lineNo must be one of the order's ${lineCount} line(s)` };
    if (!whole(e.itemId, 1, Number.MAX_SAFE_INTEGER)) return { ok: false, reason: `lineItems entry ${i + 1}: itemId must be a record number` };
    out.push({ lineNo: e.lineNo, itemId: e.itemId });
  }
  if (new Set(out.map((x) => x.lineNo)).size !== out.length) return { ok: false, reason: "the same order line is named twice in lineItems" };
  return { ok: true, value: out };
}
/** Every named item must exist and be active, and its unit must be the unit of the line it is named on. */
export async function planLineItems(env: Env, items: OrderLineItem[], lines: Array<{ unit: string | null }>) {
  for (const e of items) {
    const item = await requireItem(env, e.itemId);
    const u = lines[e.lineNo - 1]?.unit ?? null;
    if (u !== null && u !== item.unit) throw new EngineError("invalid_input", `Line ${e.lineNo} is in ${u} but ${item.name} is stocked in ${item.unit}.`);
  }
}
export interface DeliveryInput { receiptId: number; locationId: number; receivedOn: string; lines?: Array<{ lineNo: number; quantityMilli: number }>; plan?: unknown }
export function checkDeliveryInput(v: unknown): Checked<DeliveryInput> {
  if (!isObj(v)) return { ok: false, reason: "the delivery must be an object" };
  const s = strayOf(v, ["receiptId", "locationId", "receivedOn", "lines", "plan"]); if (s) return { ok: false, reason: `${s} is not a field of a delivery` };
  if (!whole(v.receiptId, 1, Number.MAX_SAFE_INTEGER) || !whole(v.locationId, 1, Number.MAX_SAFE_INTEGER)) return { ok: false, reason: "receiptId and locationId must be record numbers" };
  const d = checkDate(v.receivedOn, "receivedOn"); if (!d.ok) return d;
  const out: DeliveryInput = { receiptId: v.receiptId, locationId: v.locationId, receivedOn: d.value };
  if (v.lines !== undefined) {
    if (!Array.isArray(v.lines) || v.lines.length === 0) return { ok: false, reason: "lines must be a list of {lineNo, quantityMilli}, or left out to put in everything that is left" };
    const ls: Array<{ lineNo: number; quantityMilli: number }> = [];
    for (const [i, l] of v.lines.entries()) { if (!isObj(l) || strayOf(l, ["lineNo", "quantityMilli"]) || !whole(l.lineNo, 1, 100000) || !whole(l.quantityMilli, 1, MAX_QTY)) return { ok: false, reason: `line ${i + 1} must be {lineNo, quantityMilli} with whole numbers, at least 1` }; ls.push({ lineNo: l.lineNo, quantityMilli: l.quantityMilli }); }
    if (new Set(ls.map((l) => l.lineNo)).size !== ls.length) return { ok: false, reason: "the same goods receipt line is named twice" };
    out.lines = ls;
  }
  if (v.plan !== undefined) out.plan = v.plan;   // shown to the approver, never trusted: it is worked out again at approval
  return { ok: true, value: out };
}
/** The lines of a delivery that can go into stock: those whose order line names an item, up to what the receipt line brought in less what is already stocked (or the quantities the person named). */
export async function planDelivery(env: Env, input: DeliveryInput) {
  await requireLocation(env, input.locationId);
  const d = await one<{ id: number; kind: string; issued_on: string }>(env, "SELECT id, kind, issued_on FROM eng_document WHERE id = ?", input.receiptId);
  if (!d) throw new EngineError("not_found", "There is no such goods receipt.");
  if (d.kind !== "goods_receipt") throw new EngineError("invalid_state", "That document is not a goods receipt.");
  if (input.receivedOn < d.issued_on) throw new EngineError("invalid_input", `Stock cannot be received before the goods arrived (${d.issued_on}).`);
  const rows = await many<{ line_no: number; quantity_milli: number; unit_price_minor: number }>(env, "SELECT line_no, quantity_milli, unit_price_minor FROM eng_document_line WHERE document_id = ? ORDER BY line_no", d.id);
  if (input.lines) for (const l of input.lines) if (!rows.some((r) => r.line_no === l.lineNo)) throw new EngineError("invalid_input", `That goods receipt has no line ${l.lineNo}.`);
  const lines: Array<{ lineNo: number; itemId: number; itemName: string; quantityMilli: number; unitCostMinor: number; valueMinor: number }> = [];
  let namedAnyItem = false;
  for (const r of rows) {
    const named = input.lines?.find((l) => l.lineNo === r.line_no);
    if (input.lines && !named) continue;
    const src = await receiptLineSource(env, d.id, r.line_no);
    if (!src || src.itemId === null) { if (named) throw new EngineError("invalid_state", `Line ${r.line_no} of that goods receipt names no item on its order, so it cannot be put into stock this way: receive it as a chosen item instead.`); continue; }
    namedAnyItem = true;
    const item = await requireItem(env, src.itemId);
    const stocked = await one<{ q: number | null }>(env, "SELECT SUM(CASE WHEN kind = 'receive' THEN quantity_milli ELSE -quantity_milli END) AS q FROM eng_stock_move WHERE source_document_id = ? AND source_line_no = ? AND kind IN ('receive', 'reversal_out')", d.id, r.line_no);
    const left = r.quantity_milli - Number(stocked?.q ?? 0);
    const qty1 = named ? named.quantityMilli : left;
    if (named && qty1 > left) throw new EngineError("invalid_state", `Line ${r.line_no} (${item.name}) brought in ${milli(r.quantity_milli)} and ${milli(Number(stocked?.q ?? 0))} has already been put into stock, so only ${milli(left)} can be.`);
    if (qty1 <= 0) continue;
    lines.push({ lineNo: r.line_no, itemId: item.id, itemName: item.name, quantityMilli: qty1, unitCostMinor: r.unit_price_minor, valueMinor: valueOf(qty1, r.unit_price_minor) });
  }
  if (lines.length === 0) throw new EngineError("invalid_state", namedAnyItem ? "Everything on that goods receipt that names an item has already been put into stock: nothing is left to put in." : "No line of that goods receipt names an item on its order, so nothing can be put into stock this way.");
  return { lines };
}

// ---- the price list (events, derived) -----------------------------------------------------------------------------------------------------------------------------------------------------------------
export interface PriceInput { itemId: number; unitPriceMinor: number; currency: string; effectiveFrom: string; note?: string }
export function checkPriceInput(v: unknown): Checked<PriceInput> {
  if (!isObj(v)) return { ok: false, reason: "the price must be an object" };
  const s = strayOf(v, ["itemId", "unitPriceMinor", "currency", "effectiveFrom", "note"]); if (s) return { ok: false, reason: `${s} is not a field of a price` };
  if (!whole(v.itemId, 1, Number.MAX_SAFE_INTEGER)) return { ok: false, reason: "itemId must be a record number" };
  if (!whole(v.unitPriceMinor, 0, MAX_COST)) return { ok: false, reason: "unitPriceMinor must be a whole number of cents, 0 or more" };
  if (typeof v.currency !== "string" || !/^[A-Z]{3}$/.test(v.currency)) return { ok: false, reason: "currency must be a 3-letter code such as ZAR" };
  const d = checkDate(v.effectiveFrom, "effectiveFrom"); if (!d.ok) return d;
  const out: PriceInput = { itemId: v.itemId, unitPriceMinor: v.unitPriceMinor, currency: v.currency, effectiveFrom: d.value };
  if (v.note !== undefined) { const n = text(v.note, "note", 200); if (!n.ok) return n; out.note = n.value; }
  return { ok: true, value: out };
}
export interface PricePoint { eventId: number; unitPriceMinor: number; currency: string; effectiveFrom: string; note: string | null }
export async function priceHistory(env: Env, itemId: number): Promise<PricePoint[]> {
  return (await many<{ id: number; payload_json: string }>(env, "SELECT id, payload_json FROM eng_event WHERE type = 'item.priced' AND json_extract(payload_json, '$.itemId') = ? ORDER BY id", itemId)).map((e) => { const p = parse(e.payload_json); return { eventId: e.id, unitPriceMinor: Number(p.unitPriceMinor), currency: String(p.currency ?? ""), effectiveFrom: String(p.effectiveFrom ?? ""), note: typeof p.note === "string" ? p.note : null }; });
}
/** The price in force: the latest effective date not after `asOf` (or the latest of all), and for the same date the later decision. */
export function priceInForce(history: PricePoint[], asOf?: string): PricePoint | null {
  const eligible = history.filter((h) => asOf === undefined || h.effectiveFrom <= asOf);
  return eligible.reduce<PricePoint | null>((best, h) => (best === null || h.effectiveFrom > best.effectiveFrom || (h.effectiveFrom === best.effectiveFrom && h.eventId > best.eventId) ? h : best), null);
}
export async function planPrice(env: Env, input: PriceInput) { await requireItem(env, input.itemId, false); }

// ---- selling: issuing against an invoice line, returns, fulfilment and margin ------------------------------------------------------------------------------------------------------------------------------
/** What has been issued against an invoice line, net of issues that were reversed. */
export async function issuedAgainst(env: Env, documentId: number, lineNo: number): Promise<number> {
  // two plain queries added in code: a real Durable Object's SQLite allows only a few terms in a compound SELECT, so the engine never uses UNION
  const out = await one<{ q: number | null }>(env, "SELECT SUM(quantity_milli) AS q FROM eng_stock_move WHERE kind = 'issue' AND source_document_id = ? AND source_line_no = ?", documentId, lineNo);
  const back = await one<{ q: number | null }>(env, "SELECT SUM(r.quantity_milli) AS q FROM eng_stock_move r JOIN eng_stock_move i ON i.id = r.reverses_move_id WHERE r.kind = 'reversal_in' AND i.kind = 'issue' AND i.source_document_id = ? AND i.source_line_no = ?", documentId, lineNo);
  return Number(out?.q ?? 0) - Number(back?.q ?? 0);
}
async function returnedOf(env: Env, issueMoveId: number): Promise<{ quantityMilli: number; valueMinor: number }> {
  const r = await one<{ q: number | null; v: number | null }>(env, "SELECT SUM(json_extract(payload_json, '$.quantityMilli')) AS q, SUM(json_extract(payload_json, '$.valueMinor')) AS v FROM eng_event WHERE type = 'stock.returned' AND json_extract(payload_json, '$.returnsMoveId') = ?", issueMoveId);
  return { quantityMilli: Number(r?.q ?? 0), valueMinor: Number(r?.v ?? 0) };
}
export interface ReturnInput { issueMoveId: number; quantityMilli: number; locationId: number; returnedOn: string; creditNoteId?: number; note?: string }
export function checkReturnInput(v: unknown): Checked<ReturnInput> {
  if (!isObj(v)) return { ok: false, reason: "the return must be an object" };
  const s = strayOf(v, ["issueMoveId", "quantityMilli", "locationId", "returnedOn", "creditNoteId", "note", "valueMinor"]); if (s) return { ok: false, reason: `${s} is not a field of a return` };
  if (!whole(v.issueMoveId, 1, Number.MAX_SAFE_INTEGER) || !whole(v.locationId, 1, Number.MAX_SAFE_INTEGER)) return { ok: false, reason: "issueMoveId and locationId must be record numbers" };
  const q = qty(v.quantityMilli, "quantityMilli"); if (!q.ok) return q; const d = checkDate(v.returnedOn, "returnedOn"); if (!d.ok) return d;
  const out: ReturnInput & { valueMinor?: number } = { issueMoveId: v.issueMoveId, quantityMilli: q.value, locationId: v.locationId, returnedOn: d.value };
  if (v.creditNoteId !== undefined) { if (!whole(v.creditNoteId, 1, Number.MAX_SAFE_INTEGER)) return { ok: false, reason: "creditNoteId must be a record number" }; out.creditNoteId = v.creditNoteId; }
  if (v.note !== undefined) { const n = text(v.note, "note", 200); if (!n.ok) return n; out.note = n.value; }
  if (v.valueMinor !== undefined) { if (!whole(v.valueMinor, 0, Number.MAX_SAFE_INTEGER)) return { ok: false, reason: "valueMinor must be the value the engine worked out" }; out.valueMinor = v.valueMinor; }
  return { ok: true, value: out };
}
/** A return puts stock back at the ORIGINAL cost of the issue it reverses (never today's average), never more than was issued; returning everything restores the issue's value exactly. */
export async function planReturn(env: Env, input: ReturnInput) {
  const m = await one<{ id: number; item_id: number; kind: string; quantity_milli: number; value_minor: number; occurred_on: string }>(env, "SELECT id, item_id, kind, quantity_milli, value_minor, occurred_on FROM eng_stock_move WHERE id = ?", input.issueMoveId);
  if (!m) throw new EngineError("not_found", "There is no such stock movement.");
  if (m.kind !== "issue") throw new EngineError("invalid_state", "Only stock that was issued can be returned: that movement is not an issue.");
  if (await one(env, "SELECT id FROM eng_stock_move WHERE reverses_move_id = ?", m.id)) throw new EngineError("invalid_state", "That issue has itself been reversed, so there is nothing left to return.");
  await requireLocation(env, input.locationId);
  if (input.returnedOn < m.occurred_on) throw new EngineError("invalid_input", `A return cannot be dated before the issue (${m.occurred_on}).`);
  if (input.creditNoteId !== undefined) {
    const c = await one<{ kind: string }>(env, "SELECT kind FROM eng_document WHERE id = ?", input.creditNoteId);
    if (!c) throw new EngineError("not_found", "There is no such credit note.");
    if (c.kind !== "credit_note") throw new EngineError("invalid_state", "That document is not a credit note.");
  }
  const item = await requireItem(env, m.item_id, false);
  const back = await returnedOf(env, m.id), left = m.quantity_milli - back.quantityMilli;
  if (input.quantityMilli > left) throw new EngineError("invalid_state", `That issue was of ${milli(m.quantity_milli)} ${item.unit} of ${item.name} and ${milli(back.quantityMilli)} has already been returned, so only ${milli(left)} more can be.`);
  const valueMinor = input.quantityMilli === left ? m.value_minor - back.valueMinor : mulDiv(m.value_minor, input.quantityMilli, m.quantity_milli);
  return { item, move: m, valueMinor };
}
export interface FulfilmentLine { invoiceId: number; invoiceNumber: number | null; customerId: number; customerName: string | null; lineNo: number; description: string; itemId: number; itemName: string | null; invoicedMilli: number; issuedMilli: number; unfulfilledMilli: number; availableMilli: number; shortMilli: number }
export async function fulfilment(env: Env, f: { customerId?: number } = {}): Promise<FulfilmentLine[]> {
  const out: FulfilmentLine[] = [];
  for (const d of await many<{ id: number; party_id: number; number: number | null }>(env, "SELECT d.id, d.party_id, n.number AS number FROM eng_document d LEFT JOIN eng_document_number n ON n.document_id = d.id WHERE d.kind = 'invoice' AND d.direction = 'sell' ORDER BY d.id")) {
    if (f.customerId !== undefined && d.party_id !== f.customerId) continue;
    const named = await orderLineItems(env, d.id); if (named.size === 0 || !(await isEffective(env, "document", d.id))) continue;
    const cust = await partyProfile(env, d.party_id);
    for (const l of await many<{ line_no: number; description: string; quantity_milli: number }>(env, "SELECT line_no, description, quantity_milli FROM eng_document_line WHERE document_id = ? ORDER BY line_no", d.id)) {
      const itemId = named.get(l.line_no); if (itemId === undefined) continue;
      const issued = await issuedAgainst(env, d.id, l.line_no), un = l.quantity_milli - issued; if (un <= 0) continue;
      const item = await itemProfile(env, itemId), avail = (await onHand(env, itemId)).quantityMilli - (await reservedFor(env, itemId));
      out.push({ invoiceId: d.id, invoiceNumber: d.number, customerId: d.party_id, customerName: cust ? cust.name : null, lineNo: l.line_no, description: l.description, itemId, itemName: item ? item.name : null, invoicedMilli: l.quantity_milli, issuedMilli: issued, unfulfilledMilli: un, availableMilli: avail, shortMilli: Math.max(0, un - Math.max(0, avail)) });
    }
  }
  return out;
}
export interface MarginLine { invoiceId: number; invoiceNumber: number | null; customerId: number; issuedOn: string; lineNo: number; description: string; itemId: number | null; quantityMilli: number; netMinor: number; issuedMilli: number; costMinor: number; marginMinor: number | null; marginBp: number | null; costed: "full" | "partial" | "none" }
/** Revenue, cost of sales and margin per invoice line, for invoices that have any stock link. Cost = the value of what was issued against the line, less issues reversed and goods returned. Margin only for lines issued in full: a part-issued line would show a false one. */
export async function marginReport(env: Env, f: { from?: string; to?: string; customerId?: number; invoiceId?: number } = {}): Promise<MarginLine[]> {
  const out: MarginLine[] = [];
  for (const d of await many<{ id: number; party_id: number; number: number | null; issued_on: string }>(env, "SELECT d.id, d.party_id, n.number AS number, d.issued_on FROM eng_document d LEFT JOIN eng_document_number n ON n.document_id = d.id WHERE d.kind = 'invoice' AND d.direction = 'sell' ORDER BY d.id")) {
    if ((f.customerId !== undefined && d.party_id !== f.customerId) || (f.invoiceId !== undefined && d.id !== f.invoiceId) || (f.from !== undefined && d.issued_on < f.from) || (f.to !== undefined && d.issued_on > f.to)) continue;
    if (!(await isEffective(env, "document", d.id))) continue;
    const named = await orderLineItems(env, d.id);
    const linked = await one(env, "SELECT id FROM eng_stock_move WHERE source_document_id = ? AND kind = 'issue' LIMIT 1", d.id);
    if (named.size === 0 && !linked) continue;
    for (const l of await many<{ line_no: number; description: string; quantity_milli: number; unit_price_minor: number }>(env, "SELECT line_no, description, quantity_milli, unit_price_minor FROM eng_document_line WHERE document_id = ? ORDER BY line_no", d.id)) {
      const issued = await issuedAgainst(env, d.id, l.line_no);
      const issues = await many<{ id: number; value_minor: number }>(env, "SELECT id, value_minor FROM eng_stock_move WHERE kind = 'issue' AND source_document_id = ? AND source_line_no = ?", d.id, l.line_no);
      let cost = 0;
      for (const i of issues) {
        const rev = await one<{ v: number | null }>(env, "SELECT SUM(value_minor) AS v FROM eng_stock_move WHERE reverses_move_id = ? AND kind = 'reversal_in'", i.id);
        cost += i.value_minor - Number(rev?.v ?? 0) - (await returnedOf(env, i.id)).valueMinor;
      }
      const net = lineNetMinor(l.quantity_milli, l.unit_price_minor);
      const costed = issued <= 0 ? "none" : issued >= l.quantity_milli ? "full" : "partial";
      out.push({ invoiceId: d.id, invoiceNumber: d.number, customerId: d.party_id, issuedOn: d.issued_on, lineNo: l.line_no, description: l.description, itemId: named.get(l.line_no) ?? null, quantityMilli: l.quantity_milli, netMinor: net, issuedMilli: issued, costMinor: costed === "none" ? 0 : cost, marginMinor: costed === "full" ? net - cost : null, marginBp: costed === "full" && net > 0 ? mulDiv(net - cost, 10000, net) : null, costed });
    }
  }
  return out;
}

// ---- write-downs, the valuation as at a date and the roll-forward (docs/decisions/inventory.md, increment 5) ----------------------------------------------------------------------------------------------
export const WRITE_DOWN_REASONS = ["damaged", "obsolete", "slow_moving", "market_decline", "other"] as const;
export interface WriteDownInput { itemId: number; amountMinor: number; reason: string; evidence: string; writtenDownOn: string; plan?: unknown }
export function checkWriteDownInput(v: unknown): Checked<WriteDownInput> {
  if (!isObj(v)) return { ok: false, reason: "the write-down must be an object" };
  const s = strayOf(v, ["itemId", "amountMinor", "reason", "evidence", "writtenDownOn", "plan"]); if (s) return { ok: false, reason: `${s} is not a field of a write-down (a write-down is of the whole item, at every place that holds it)` };
  if (!whole(v.itemId, 1, Number.MAX_SAFE_INTEGER)) return { ok: false, reason: "itemId must be a record number" };
  if (!whole(v.amountMinor, 1, MAX_COST)) return { ok: false, reason: "amountMinor must be a whole number of cents, at least 1: the amount the stock is written down BY" };
  if (typeof v.reason !== "string" || !(WRITE_DOWN_REASONS as readonly string[]).includes(v.reason)) return { ok: false, reason: `reason must be one of ${WRITE_DOWN_REASONS.join(", ")}` };
  if (typeof v.evidence !== "string" || v.evidence.trim().length < 10 || v.evidence.trim().length > 200) return { ok: false, reason: "evidence must be 10 to 200 characters: what shows the stock is worth less (a diminution without a note of the evidence is not accepted)" };
  const d = checkDate(v.writtenDownOn, "writtenDownOn"); if (!d.ok) return d;
  const out: WriteDownInput = { itemId: v.itemId, amountMinor: v.amountMinor, reason: v.reason, evidence: v.evidence.trim().replace(/\s+/g, " "), writtenDownOn: d.value };
  if (v.plan !== undefined) out.plan = v.plan;   // shown to the approver, never trusted: worked out again at approval
  return { ok: true, value: out };
}
/** A write-down lowers what ALL the stock of an item is carried at, by an amount, without moving a unit. Stock value is kept per item (one weighted average), so the diminution belongs to every unit; it is recorded as a pair of movements at each place that holds the item, the value and the amount shared by quantity in location order with the last place taking the remainder, so the parts add up to the whole to the cent. */
export interface WriteDownPart { locationId: number; quantityMilli: number; carriedFromMinor: number; shareMinor: number; carriedToMinor: number }
export async function planWriteDown(env: Env, input: WriteDownInput) {
  const item = await requireItem(env, input.itemId, false);
  const total = await onHand(env, input.itemId);
  if (total.quantityMilli <= 0) throw new EngineError("invalid_state", `There is no ${item.name} on hand to write down.`);
  const first = await one<{ d: string | null }>(env, "SELECT MIN(occurred_on) AS d FROM eng_stock_move WHERE item_id = ?", input.itemId);
  if (first?.d && input.writtenDownOn < first.d) throw new EngineError("invalid_input", `A write-down cannot be dated before the stock was received (${first.d}).`);
  if (input.amountMinor > total.valueMinor) throw new EngineError("invalid_state", `That stock is only carried at ${total.valueMinor}, so it cannot be written down by ${input.amountMinor}.`);
  const parts: WriteDownPart[] = []; let qRem = total.quantityMilli, vRem = total.valueMinor, aRem = input.amountMinor;
  for (const l of (await allLocations(env)).slice().sort((x, y) => x.id - y.id)) {
    const q = (await onHand(env, input.itemId, l.id)).quantityMilli; if (q <= 0) continue;
    const carried = mulDiv(vRem, q, qRem), share = mulDiv(aRem, q, qRem);   // monotone in the numerator, so a share can never exceed what its place is carried at
    parts.push({ locationId: l.id, quantityMilli: q, carriedFromMinor: carried, shareMinor: share, carriedToMinor: carried - share });
    qRem -= q; vRem -= carried; aRem -= share;
  }
  return { item, quantityMilli: total.quantityMilli, carriedFromMinor: total.valueMinor, carriedToMinor: total.valueMinor - input.amountMinor, parts };
}
export interface WriteDownRow { eventId: number; itemId: number; sku: string | null; name: string | null; quantityMilli: number; amountMinor: number; reason: string; evidence: string; writtenDownOn: string; carriedFromMinor: number; carriedToMinor: number; locations: Array<{ locationId: number; locationName: string | null; quantityMilli: number; carriedFromMinor: number; carriedToMinor: number; shareMinor: number }> }
/** One row per write-down (its number is the id of its first event), however many places it touched. */
export async function allWriteDowns(env: Env, f: { itemId?: number; from?: string; to?: string } = {}): Promise<WriteDownRow[]> {
  const locs = new Map((await allLocations(env)).map((l) => [l.id, l.name])); const groups = new Map<number, WriteDownRow>();
  for (const e of await many<{ id: number; payload_json: string }>(env, "SELECT id, payload_json FROM eng_event WHERE type = 'stock.written_down' AND json_extract(payload_json, '$.part') = 'in' ORDER BY id")) {
    const p = parse(e.payload_json); const itemId = Number(p.itemId), on = String(p.occurredOn ?? ""), head = Number(p.groupEventId);
    if ((f.itemId !== undefined && itemId !== f.itemId) || (f.from !== undefined && on < f.from) || (f.to !== undefined && on > f.to)) continue;
    const outEv = await one<{ payload_json: string }>(env, "SELECT payload_json FROM eng_event WHERE id = ?", Number(p.outEventId)), po = parse(outEv?.payload_json ?? "{}");
    const part = { locationId: Number(p.locationId), locationName: locs.get(Number(p.locationId)) ?? null, quantityMilli: Number(p.quantityMilli), carriedFromMinor: Number(po.valueMinor), carriedToMinor: Number(p.valueMinor), shareMinor: Number(p.amountMinor) };
    const g = groups.get(head);
    if (g) { g.quantityMilli += part.quantityMilli; g.carriedFromMinor += part.carriedFromMinor; g.carriedToMinor += part.carriedToMinor; g.locations.push(part); continue; }
    const it = await itemProfile(env, itemId);
    groups.set(head, { eventId: head, itemId, sku: it?.sku ?? null, name: it?.name ?? null, quantityMilli: part.quantityMilli, amountMinor: Number(p.totalAmountMinor), reason: String(p.reason ?? ""), evidence: String(p.evidence ?? ""), writtenDownOn: on, carriedFromMinor: part.carriedFromMinor, carriedToMinor: part.carriedToMinor, locations: [part] });
  }
  return [...groups.values()];
}
export interface ValuationRow { itemId: number; sku: string; name: string; unit: string; quantityMilli: number; valueMinor: number; averageCostMinor: number | null; writtenDownMinor: number }
/** What the stock was, as at a date: every movement dated on or before it (as we now know the books), cost less the diminution recorded. */
export async function valuationAsAt(env: Env, asOf: string, itemId?: number): Promise<ValuationRow[]> {
  const out: ValuationRow[] = []; const wds = await allWriteDowns(env, { to: asOf });
  for (const id of itemId !== undefined ? [itemId] : await allItemIds(env)) {
    const p = await itemProfile(env, id); if (!p) continue;
    const r = await one<{ q: number | null; v: number | null }>(env, `SELECT SUM(${SIGN_SQL} * quantity_milli) AS q, SUM(${SIGN_SQL} * value_minor) AS v FROM eng_stock_move WHERE item_id = ? AND occurred_on <= ?`, id, asOf);
    const q = Number(r?.q ?? 0), v = Number(r?.v ?? 0); if (q === 0 && v === 0) continue;
    out.push({ itemId: id, sku: p.sku, name: p.name, unit: p.unit, quantityMilli: q, valueMinor: v, averageCostMinor: averageCostMinor(q, v), writtenDownMinor: wds.filter((w) => w.itemId === id).reduce((a, w) => a + w.amountMinor, 0) });
  }
  return out;
}
export interface Rollforward { from: string; to: string; openingMinor: number; categories: Record<string, number>; closingMinor: number; computedClosingMinor: number; reconciles: boolean; differenceMinor: number }
/** Opening + the value of every kind of movement = closing, where closing is ALSO the valuation at the end: two derivations that must agree. */
export async function rollforward(env: Env, from: string, to: string): Promise<Rollforward> {
  const sum = async (cond: string, ...b: unknown[]) => Number((await one<{ v: number | null }>(env, `SELECT SUM(${SIGN_SQL} * value_minor) AS v FROM eng_stock_move WHERE ${cond}`, ...b))?.v ?? 0);
  const opening = await sum("occurred_on < ?", from), closing = await sum("occurred_on <= ?", to);
  const cats: Record<string, number> = { receipts: 0, issues: 0, returns: 0, counts: 0, adjustments: 0, writeDowns: 0, reversals: 0, transfers: 0 };
  for (const m of await many<{ kind: string; reason: string | null; value_minor: number; etype: string }>(env, "SELECT m.kind, m.reason, m.value_minor, e.type AS etype FROM eng_stock_move m JOIN eng_event e ON e.id = m.event_id WHERE m.occurred_on >= ? AND m.occurred_on <= ?", from, to)) {
    const signed = ((IN_KINDS as readonly string[]).includes(m.kind) ? 1 : -1) * m.value_minor;
    const k = m.kind.startsWith("transfer") ? "transfers" : m.kind === "receive" ? "receipts" : m.kind === "issue" ? "issues" : m.kind.startsWith("reversal") ? "reversals" : m.etype === "stock.written_down" ? "writeDowns" : m.etype === "stock.returned" ? "returns" : m.reason === "stocktake" ? "counts" : "adjustments";
    cats[k] += signed;
  }
  const computed = opening + Object.values(cats).reduce((a, b) => a + b, 0);
  return { from, to, openingMinor: opening, categories: cats, closingMinor: closing, computedClosingMinor: computed, reconciles: computed === closing, differenceMinor: closing - computed };
}

// ---- reading (derived) -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------
export interface ItemProfile { id: number; sku: string; name: string; unit: string; reorderLevelMilli: number | null; reorderQtyMilli: number | null; preferredSupplierId: number | null; active: boolean; eventId: number }
/** An item as it is NOW: the row it was created as, with its creating event's attributes, then every item.revised event in order. */
export async function itemProfile(env: Env, itemId: number): Promise<ItemProfile | null> {
  const row = await one<{ id: number; sku: string; name: string; unit: string; event_id: number }>(env, "SELECT id, sku, name, unit, event_id FROM eng_item WHERE id = ?", itemId);
  if (!row) return null;
  const created = await one<{ payload_json: string }>(env, "SELECT payload_json FROM eng_event WHERE id = ?", row.event_id);
  const c = parse(created?.payload_json ?? "{}");
  const p: ItemProfile = { id: row.id, sku: row.sku, name: row.name, unit: row.unit, reorderLevelMilli: typeof c.reorderLevelMilli === "number" ? c.reorderLevelMilli : null, reorderQtyMilli: typeof c.reorderQtyMilli === "number" ? c.reorderQtyMilli : null, preferredSupplierId: typeof c.preferredSupplierId === "number" ? c.preferredSupplierId : null, active: true, eventId: row.event_id };
  for (const e of await many<{ payload_json: string }>(env, "SELECT payload_json FROM eng_event WHERE type = 'item.revised' AND json_extract(payload_json, '$.itemId') = ? ORDER BY id", itemId)) {
    const r = parse(e.payload_json);
    if (typeof r.name === "string") p.name = r.name;
    if (typeof r.reorderLevelMilli === "number") p.reorderLevelMilli = r.reorderLevelMilli;
    if (typeof r.reorderQtyMilli === "number") p.reorderQtyMilli = r.reorderQtyMilli;
    if (r.preferredSupplierId === null || typeof r.preferredSupplierId === "number") p.preferredSupplierId = r.preferredSupplierId as number | null;
    if (typeof r.active === "boolean") p.active = r.active;
  }
  return p;
}
export async function allItemIds(env: Env): Promise<number[]> { return (await many<{ id: number }>(env, "SELECT id FROM eng_item ORDER BY id")).map((r) => r.id); }
export async function allLocations(env: Env): Promise<Array<{ id: number; name: string; kind: string }>> { return many(env, "SELECT id, name, kind FROM eng_location ORDER BY id"); }

/** Quantity and value on hand. Quantity can be asked per location; VALUE exists per item (company-wide weighted average), never per location. */
export async function onHand(env: Env, itemId: number, locationId?: number): Promise<{ quantityMilli: number; valueMinor: number }> {
  const r = locationId === undefined
    ? await one<{ q: number | null; v: number | null }>(env, `SELECT SUM(${SIGN_SQL} * quantity_milli) AS q, SUM(${SIGN_SQL} * value_minor) AS v FROM eng_stock_move WHERE item_id = ?`, itemId)
    : await one<{ q: number | null; v: number | null }>(env, `SELECT SUM(${SIGN_SQL} * quantity_milli) AS q, 0 AS v FROM eng_stock_move WHERE item_id = ? AND location_id = ?`, itemId, locationId);
  return { quantityMilli: Number(r?.q ?? 0), valueMinor: Number(r?.v ?? 0) };
}
export const averageCostMinor = (quantityMilli: number, valueMinor: number): number | null => (quantityMilli > 0 ? mulDiv(valueMinor, 1000, quantityMilli) : null);

export interface StockRow { itemId: number; sku: string; name: string; unit: string; active: boolean; quantityMilli: number; valueMinor: number; averageCostMinor: number | null; reorderLevelMilli: number | null; belowReorder: boolean; reservedMilli: number; availableMilli: number; shortfallMilli: number; locations: Array<{ locationId: number; locationName: string; quantityMilli: number }> }
export async function stockReport(env: Env, f: { itemId?: number; locationId?: number } = {}): Promise<StockRow[]> {
  const locs = await allLocations(env);
  const out: StockRow[] = [];
  for (const id of f.itemId !== undefined ? [f.itemId] : await allItemIds(env)) {
    const p = await itemProfile(env, id); if (!p) continue;
    const total = await onHand(env, id);
    const per: StockRow["locations"] = [];
    for (const l of locs) { const q = (await onHand(env, id, l.id)).quantityMilli; if (q !== 0) per.push({ locationId: l.id, locationName: l.name, quantityMilli: q }); }
    if (f.locationId !== undefined && !per.some((x) => x.locationId === f.locationId)) continue;
    const held = await reservedFor(env, id); const avail = total.quantityMilli - held;
    out.push({ itemId: id, sku: p.sku, name: p.name, unit: p.unit, active: p.active, quantityMilli: f.locationId !== undefined ? (per.find((x) => x.locationId === f.locationId)?.quantityMilli ?? 0) : total.quantityMilli, valueMinor: total.valueMinor, averageCostMinor: averageCostMinor(total.quantityMilli, total.valueMinor), reorderLevelMilli: p.reorderLevelMilli, belowReorder: p.reorderLevelMilli !== null && avail <= p.reorderLevelMilli, reservedMilli: held, availableMilli: avail, shortfallMilli: Math.max(0, held - total.quantityMilli), locations: per });
  }
  return out;
}
export interface LedgerRow { id: number; eventId: number; kind: string; quantityMilli: number; valueMinor: number; direction: "in" | "out"; locationId: number; locationName: string; occurredOn: string; sourceDocumentId: number | null; sourceLineNo: number | null; reason: string | null; jobRef: string | null; pairId: number | null; reversesMoveId: number | null; reversedByMoveId: number | null }
export async function stockLedger(env: Env, itemId: number, f: { from?: string; to?: string } = {}): Promise<LedgerRow[]> {
  const rows = await many<{ id: number; event_id: number; kind: string; quantity_milli: number; value_minor: number; location_id: number; location_name: string; occurred_on: string; source_document_id: number | null; source_line_no: number | null; reason: string | null; job_ref: string | null; pair_id: number | null; reverses_move_id: number | null }>(env, "SELECT m.id, m.event_id, m.kind, m.quantity_milli, m.value_minor, m.location_id, l.name AS location_name, m.occurred_on, m.source_document_id, m.source_line_no, m.reason, m.job_ref, m.pair_id, m.reverses_move_id FROM eng_stock_move m JOIN eng_location l ON l.id = m.location_id WHERE m.item_id = ? ORDER BY m.id", itemId);
  const reversedBy = new Map<number, number>();
  for (const r of rows) if (r.reverses_move_id !== null) reversedBy.set(r.reverses_move_id, r.id);
  return rows.filter((r) => (f.from === undefined || r.occurred_on >= f.from) && (f.to === undefined || r.occurred_on <= f.to)).map((r) => ({ id: r.id, eventId: r.event_id, kind: r.kind, quantityMilli: r.quantity_milli, valueMinor: r.value_minor, direction: (IN_KINDS as readonly string[]).includes(r.kind) ? "in" as const : "out" as const, locationId: r.location_id, locationName: r.location_name, occurredOn: r.occurred_on, sourceDocumentId: r.source_document_id, sourceLineNo: r.source_line_no, reason: r.reason, jobRef: r.job_ref, pairId: r.pair_id, reversesMoveId: r.reverses_move_id, reversedByMoveId: reversedBy.get(r.id) ?? null }));
}

// ---- planning (reads that decide whether a write may happen) ---------------------------------------------------------------------------------------------------------------------------------------
async function requireItem(env: Env, itemId: number, mustBeActive = true): Promise<ItemProfile> {
  const p = await itemProfile(env, itemId);
  if (!p) throw new EngineError("not_found", "There is no such item.");
  if (mustBeActive && !p.active) throw new EngineError("invalid_state", `${p.name} is no longer active, so stock cannot be moved for it.`);
  return p;
}
async function requireLocation(env: Env, locationId: number) {
  const l = await one<{ id: number; name: string; kind: string }>(env, "SELECT id, name, kind FROM eng_location WHERE id = ?", locationId);
  if (!l) throw new EngineError("not_found", "There is no such location.");
  return l;
}
const milli = (n: number) => (n / 1000).toString();
export async function planItem(env: Env, input: { sku: string; preferredSupplierId?: number }) {
  if (await one(env, "SELECT id FROM eng_item WHERE sku = ?", input.sku)) throw new EngineError("duplicate", `There is already an item with the code ${input.sku}.`);
  if (input.preferredSupplierId !== undefined) { const p = await partyProfile(env, input.preferredSupplierId); if (!p) throw new EngineError("not_found", "There is no such supplier."); if (!p.roles.includes("supplier")) throw new EngineError("invalid_state", `${p.name} is not a supplier.`); }
}
export async function planItemRevision(env: Env, input: ItemRevision) {
  await requireItem(env, input.itemId, false);
  if (input.preferredSupplierId) { const p = await partyProfile(env, input.preferredSupplierId); if (!p) throw new EngineError("not_found", "There is no such supplier."); if (!p.roles.includes("supplier")) throw new EngineError("invalid_state", `${p.name} is not a supplier.`); }
}
export async function planLocation(env: Env, input: LocationInput) {
  if (await one(env, "SELECT id FROM eng_location WHERE lower(name) = lower(?)", input.name)) throw new EngineError("duplicate", `There is already a location called ${input.name}.`);
}
/** Value of taking `quantityMilli` out of an item at its weighted average; taking ALL of it takes exactly all its value (no residue). */
function outValue(total: { quantityMilli: number; valueMinor: number }, quantityMilli: number): number {
  return quantityMilli === total.quantityMilli ? total.valueMinor : mulDiv(total.valueMinor, quantityMilli, total.quantityMilli);
}
async function requireOnHand(env: Env, item: ItemProfile, locationId: number, quantityMilli: number, verb: string) {
  const here = (await onHand(env, item.id, locationId)).quantityMilli;
  if (quantityMilli > here) throw new EngineError("invalid_state", `Only ${milli(here)} ${item.unit} of ${item.name} is at that location, so ${milli(quantityMilli)} cannot be ${verb}.`);
}
export async function planReceive(env: Env, input: ReceiveInput) {
  const item = await requireItem(env, input.itemId); const loc = await requireLocation(env, input.locationId);
  let unitCost = input.unitCostMinor ?? 0; let source: { documentId: number; lineNo: number } | null = null;
  if (input.receipt) {
    const d = await one<{ id: number; kind: string; issued_on: string }>(env, "SELECT id, kind, issued_on FROM eng_document WHERE id = ?", input.receipt.documentId);
    if (!d) throw new EngineError("not_found", "There is no such goods receipt.");
    if (d.kind !== "goods_receipt") throw new EngineError("invalid_state", "That document is not a goods receipt.");
    const line = await one<{ quantity_milli: number; unit: string | null; unit_price_minor: number }>(env, "SELECT quantity_milli, unit, unit_price_minor FROM eng_document_line WHERE document_id = ? AND line_no = ?", d.id, input.receipt.lineNo);
    if (!line) throw new EngineError("invalid_input", `That goods receipt has no line ${input.receipt.lineNo}.`);
    if (line.unit !== null && line.unit !== item.unit) throw new EngineError("invalid_input", `That line is in ${line.unit} but ${item.name} is stocked in ${item.unit}.`);
    if (input.receivedOn < d.issued_on) throw new EngineError("invalid_input", `Stock cannot be received before the goods arrived (${d.issued_on}).`);
    const stocked = await one<{ q: number | null }>(env, "SELECT SUM(CASE WHEN kind = 'receive' THEN quantity_milli ELSE -quantity_milli END) AS q FROM eng_stock_move WHERE source_document_id = ? AND source_line_no = ? AND kind IN ('receive', 'reversal_out')", d.id, input.receipt.lineNo);
    const left = line.quantity_milli - Number(stocked?.q ?? 0);
    if (input.quantityMilli > left) throw new EngineError("invalid_state", `That goods receipt line brought in ${milli(line.quantity_milli)} and ${milli(Number(stocked?.q ?? 0))} has already been put into stock, so only ${milli(left)} can be.`);
    const src = await receiptLineSource(env, d.id, input.receipt.lineNo);
    if (src && src.itemId !== null && src.itemId !== item.id) { const named = await itemProfile(env, src.itemId); throw new EngineError("invalid_input", `That line is for ${named ? named.name : "another item"}, so it cannot be put into stock as ${item.name}.`); }
    unitCost = line.unit_price_minor; source = input.receipt;
  }
  return { item, location: loc, unitCostMinor: unitCost, valueMinor: valueOf(input.quantityMilli, unitCost), source };
}
export async function planIssue(env: Env, input: IssueInput) {
  const item = await requireItem(env, input.itemId); const loc = await requireLocation(env, input.locationId);
  await requireOnHand(env, item, input.locationId, input.quantityMilli, "issued");
  if (input.reservationId !== undefined) {
    const r = (await allReservations(env, { status: "any" })).find((x) => x.id === input.reservationId);
    if (!r) throw new EngineError("not_found", "There is no such reservation.");
    if (r.itemId !== input.itemId) throw new EngineError("invalid_state", "That reservation is for a different item.");
    if (r.remainingMilli === 0) throw new EngineError("invalid_state", "That reservation has already been used or released.");
    if (r.locationId !== null && r.locationId !== input.locationId) throw new EngineError("invalid_state", "That reservation is held at a different location.");
    if (input.quantityMilli > r.remainingMilli) throw new EngineError("invalid_state", `That reservation only has ${milli(r.remainingMilli)} left, so ${milli(input.quantityMilli)} cannot be drawn on it.`);
  } else {
    const held = await reservedFor(env, input.itemId), total = (await onHand(env, input.itemId)).quantityMilli;
    if (input.quantityMilli > total - held) throw new EngineError("invalid_state", `${milli(held)} ${item.unit} of ${item.name} is reserved, so only ${milli(Math.max(0, total - held))} is free to issue: release the reservation, or draw on it.`);
  }
  if (input.documentId !== undefined) {
    const d = await one<{ kind: string }>(env, "SELECT kind FROM eng_document WHERE id = ?", input.documentId);
    if (!d) throw new EngineError("not_found", "There is no such document to issue the stock for.");
    if (d.kind !== "invoice") throw new EngineError("invalid_state", "Stock is issued for an invoice line (or a job), not for that kind of document.");
    const dl = await one<{ quantity_milli: number }>(env, "SELECT quantity_milli FROM eng_document_line WHERE document_id = ? AND line_no = ?", input.documentId, input.lineNo);
    if (!dl) throw new EngineError("invalid_input", `That invoice has no line ${input.lineNo}.`);
    // a line that NAMES its item is held to it: stock issued against it is that item and never more than was invoiced (a line that names none keeps the old, unchecked behaviour)
    const forItem = (await orderLineItems(env, input.documentId)).get(input.lineNo!);
    if (forItem !== undefined) {
      if (forItem !== input.itemId) { const named = await itemProfile(env, forItem); throw new EngineError("invalid_input", `That invoice line is for ${named ? named.name : "another item"}, so stock cannot be issued against it as ${item.name}.`); }
      const issued = await issuedAgainst(env, input.documentId, input.lineNo!), left = dl.quantity_milli - issued;
      if (input.quantityMilli > left) throw new EngineError("invalid_state", `That invoice line was invoiced for ${milli(dl.quantity_milli)} and ${milli(issued)} has already been issued, so only ${milli(Math.max(0, left))} is left to issue.`);
    }
  }
  const total = await onHand(env, input.itemId);
  return { item, location: loc, valueMinor: outValue(total, input.quantityMilli) };
}
export async function planTransfer(env: Env, input: TransferInput) {
  const item = await requireItem(env, input.itemId); const from = await requireLocation(env, input.fromLocationId); const to = await requireLocation(env, input.toLocationId);
  await requireOnHand(env, item, input.fromLocationId, input.quantityMilli, "moved");
  return { item, from, to };
}
export async function planAdjust(env: Env, input: AdjustInput) {
  const item = await requireItem(env, input.itemId); const loc = await requireLocation(env, input.locationId);
  const total = await onHand(env, input.itemId);
  if (input.direction === "out") { await requireOnHand(env, item, input.locationId, input.quantityMilli, "written off"); return { item, location: loc, valueMinor: outValue(total, input.quantityMilli) }; }
  let unit = input.unitCostMinor;
  if (unit === undefined) { const avg = averageCostMinor(total.quantityMilli, total.valueMinor); if (avg === null) throw new EngineError("invalid_input", `${item.name} has no stock to take a cost from: give the cost of each unit.`); unit = avg; }
  return { item, location: loc, valueMinor: valueOf(input.quantityMilli, unit) };
}
export async function planReverse(env: Env, input: StockReverseInput) {
  const m = await one<{ id: number; item_id: number; location_id: number; kind: string; quantity_milli: number; value_minor: number; occurred_on: string }>(env, "SELECT id, item_id, location_id, kind, quantity_milli, value_minor, occurred_on FROM eng_stock_move WHERE id = ?", input.moveId);
  if (!m) throw new EngineError("not_found", "There is no such stock movement.");
  if (!["receive", "issue", "adjust_in", "adjust_out"].includes(m.kind)) throw new EngineError("invalid_state", m.kind.startsWith("transfer") ? "A transfer is corrected by transferring back, not reversed." : "That movement is itself a reversal, so it cannot be reversed again.");
  if (await one(env, "SELECT id FROM eng_stock_move WHERE reverses_move_id = ?", m.id)) throw new EngineError("invalid_state", "That movement has already been reversed.");
  if (input.reversedOn < m.occurred_on) throw new EngineError("invalid_input", `A reversal cannot be dated before the movement (${m.occurred_on}).`);
  const item = await requireItem(env, m.item_id, false);
  const ev = await one<{ type: string }>(env, "SELECT type FROM eng_event WHERE id = (SELECT event_id FROM eng_stock_move WHERE id = ?)", m.id);
  if (ev?.type === "stock.written_down") throw new EngineError("invalid_state", "Either half of a write-down cannot be reversed on its own (it would leave the stock carried wrongly): a write-down is changed by a later one.");
  if (m.kind === "issue" && (await returnedOf(env, m.id)).quantityMilli > 0) throw new EngineError("invalid_state", "Goods have been returned from that issue, so it cannot also be reversed.");
  const wasIn = m.kind === "receive" || m.kind === "adjust_in";
  if (wasIn) {
    if (await one(env, "SELECT id FROM eng_stock_move WHERE item_id = ? AND id > ? AND kind IN ('issue', 'adjust_out', 'reversal_in')", m.item_id, m.id)) throw new EngineError("invalid_state", `Later movements of ${item.name} (an issue or a write-off) were costed using that stock, so it cannot be reversed: correct it with an adjustment instead.`);
    const total = await onHand(env, m.item_id), here = (await onHand(env, m.item_id, m.location_id)).quantityMilli;
    if (m.quantity_milli > here || m.quantity_milli > total.quantityMilli) throw new EngineError("invalid_state", `Only ${milli(here)} ${item.unit} of ${item.name} is still at that location, so the ${milli(m.quantity_milli)} that came in cannot be taken back out: some of it has since been used or moved.`);
    if (total.valueMinor < m.value_minor || (total.quantityMilli === m.quantity_milli) !== (total.valueMinor === m.value_minor)) throw new EngineError("invalid_state", "The value of that stock has since changed (later movements used part of it), so it cannot be reversed exactly.");
  }
  return { move: m, item, kind: wasIn ? "reversal_out" : "reversal_in" };
}

export async function planReserve(env: Env, input: ReserveInput) {
  const item = await requireItem(env, input.itemId);
  if (input.locationId !== undefined) await requireLocation(env, input.locationId);
  if (input.forDocumentId !== undefined) {
    const d = await reservationDocument(env, input.forDocumentId);
    if (!d) throw new EngineError("not_found", "There is no such document to hold stock for.");
    if (d.kind !== "quotation" && d.kind !== "invoice") throw new EngineError("invalid_state", "Stock is held for a quotation or an invoice (or a named job), not for that kind of document.");
  }
  const total = (await onHand(env, input.itemId)).quantityMilli, held = await reservedFor(env, input.itemId);
  if (input.quantityMilli > total - held) throw new EngineError("invalid_state", `Only ${milli(Math.max(0, total - held))} ${item.unit} of ${item.name} is available (${milli(total)} on hand, ${milli(held)} already reserved), so ${milli(input.quantityMilli)} cannot be held.`);
  if (input.locationId !== undefined) {
    const here = (await onHand(env, input.itemId, input.locationId)).quantityMilli, heldHere = await reservedFor(env, input.itemId, input.locationId);
    if (input.quantityMilli > here - heldHere) throw new EngineError("invalid_state", `Only ${milli(Math.max(0, here - heldHere))} ${item.unit} of ${item.name} is available at that location, so ${milli(input.quantityMilli)} cannot be held there.`);
  }
  return { item };
}
export async function planRelease(env: Env, input: ReleaseInput) {
  const r = (await allReservations(env, { status: "any" })).find((x) => x.id === input.reservationId);
  if (!r) throw new EngineError("not_found", "There is no such reservation.");
  if (r.remainingMilli === 0) throw new EngineError("invalid_state", r.status === "released" ? "That reservation has already been released." : "That reservation has been used in full, so there is nothing left to release.");
  return { reservation: r };
}
/** A count of ONE location: each line's variance against the book is worked out here and stamped on the proposal; a COMPLETE count counts every unlisted item that has stock there as zero. */
export async function planCount(env: Env, input: CountInput) {
  await requireLocation(env, input.locationId);
  const wanted = new Map<number, CountLine>(input.lines.map((l) => [l.itemId, l]));
  if (input.complete) for (const id of await allItemIds(env)) if (!wanted.has(id) && (await onHand(env, id, input.locationId)).quantityMilli > 0) wanted.set(id, { itemId: id, countedMilli: 0 });
  const variances: Array<{ itemId: number; sku: string; name: string; unit: string; bookMilli: number; countedMilli: number; differenceMilli: number; valueMinor: number }> = [];
  const moves: Array<{ itemId: number; direction: "in" | "out"; quantityMilli: number; valueMinor: number }> = [];
  for (const itemId of [...wanted.keys()].sort((a, b) => a - b)) {
    const line = wanted.get(itemId)!;
    const item = await requireItem(env, itemId, false);
    const book = (await onHand(env, itemId, input.locationId)).quantityMilli, diff = line.countedMilli - book, total = await onHand(env, itemId);
    let value = 0;
    if (diff < 0) { value = outValue(total, -diff); moves.push({ itemId, direction: "out", quantityMilli: -diff, valueMinor: value }); }
    else if (diff > 0) {
      const unit = line.unitCostMinor ?? averageCostMinor(total.quantityMilli, total.valueMinor);
      if (unit === null) throw new EngineError("invalid_input", `${item.name} has no stock on the books to take a cost from, so the ${milli(diff)} found cannot be valued: give the cost of each unit on that line.`);
      value = valueOf(diff, unit); moves.push({ itemId, direction: "in", quantityMilli: diff, valueMinor: value });
    }
    variances.push({ itemId, sku: item.sku, name: item.name, unit: item.unit, bookMilli: book, countedMilli: line.countedMilli, differenceMilli: diff, valueMinor: value });
  }
  return { variances, moves };
}
export interface ReorderSuggestion { itemId: number; sku: string; name: string; unit: string; onHandMilli: number; reservedMilli: number; availableMilli: number; onOrderMilli: number; positionMilli: number; reorderLevelMilli: number; suggestedQtyMilli: number; shortfallMilli: number; preferredSupplierId: number | null; preferredSupplierName: string | null }
export async function reorderSuggestions(env: Env): Promise<ReorderSuggestion[]> {
  const out: ReorderSuggestion[] = []; const coming = await onOrderByItem(env);
  for (const id of await allItemIds(env)) {
    const p = await itemProfile(env, id); if (!p || !p.active || p.reorderLevelMilli === null) continue;
    const onh = (await onHand(env, id)).quantityMilli, held = await reservedFor(env, id), avail = onh - held, onOrder = coming.get(id) ?? 0, position = avail + onOrder;
    if (position > p.reorderLevelMilli) continue;
    const sup = p.preferredSupplierId === null ? null : await partyProfile(env, p.preferredSupplierId);
    out.push({ itemId: id, sku: p.sku, name: p.name, unit: p.unit, onHandMilli: onh, reservedMilli: held, availableMilli: avail, onOrderMilli: onOrder, positionMilli: position, reorderLevelMilli: p.reorderLevelMilli, suggestedQtyMilli: p.reorderQtyMilli ?? Math.max(1, p.reorderLevelMilli - position), shortfallMilli: p.reorderLevelMilli - position, preferredSupplierId: p.preferredSupplierId, preferredSupplierName: sup ? sup.name : null });
  }
  return out.sort((a, b) => b.shortfallMilli - a.shortfallMilli || a.itemId - b.itemId);
}
