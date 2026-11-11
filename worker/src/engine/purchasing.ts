// Purchase orders and goods received (docs/decisions/purchase-orders.md). An order is a DOCUMENT of kind purchase_order (a commitment: no payable, not a tax document, no money); a goods receipt is a document of kind goods_receipt tied to ONE
// order by a goods.received event; cancelling the remainder is a purchase_order.cancelled event. What state an order is in (open, part_received, received, cancelled, closed) and how much of each line has arrived is DERIVED from those events, never
// stored, so nothing is edited and no schema changes (the doctrine of parties.ts, quotations.ts and expenses.ts). This file only READS and validates; facts.ts is the one write path, and the same rules serve the contracts and the fact layer.
import type { Env } from "../types";
import { EngineError } from "./errors";
import { documentTotals, isEffective } from "./ledger";
import { lineNetMinor } from "./money";
import { partyProfile } from "./parties";
import { checkDate } from "./quotations";

export type OrderStatus = "open" | "part_received" | "received" | "cancelled" | "closed";
export interface LineProgress { lineNo: number; description: string; unit: string | null; unitPriceMinor: number; taxBp: number; orderedMilli: number; receivedMilli: number; remainingMilli: number }
export interface PurchaseOrderSummary {
  id: number; number: number | null; supplierId: number; currency: string; orderedOn: string; expectedOn: string | null; reference: string | null;
  netMinor: number; taxMinor: number; grossMinor: number; status: OrderStatus; receivedValueMinor: number; outstandingValueMinor: number; receipts: number[]; cancelled: boolean;
}
export interface ReceiptLineInput { lineNo: number; quantityMilli: number }
type Checked<T> = { ok: true; value: T } | { ok: false; reason: string };
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const whole = (v: unknown, min: number, max: number): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max;
const many = async <T>(env: Env, sql: string, ...binds: unknown[]): Promise<T[]> => ((await env.OFFICE_DB.prepare(sql).bind(...binds).all<T>()).results ?? []);
const parse = (s: string): Record<string, unknown> => { try { const v = JSON.parse(s); return isObj(v) ? v : {}; } catch { return {}; } };

// ---- validation (pure) -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------
export function checkReceiptLines(v: unknown): Checked<ReceiptLineInput[]> {
  if (!Array.isArray(v) || v.length === 0) return { ok: false, reason: "a receipt needs at least one line" };
  if (v.length > 100) return { ok: false, reason: "a receipt may have at most 100 lines" };
  const out: ReceiptLineInput[] = [];
  for (const [i, l] of v.entries()) {
    const at = `line ${i + 1}`;
    if (!isObj(l)) return { ok: false, reason: `${at} must be an object` };
    const stray = Object.keys(l).find((k) => k !== "lineNo" && k !== "quantityMilli");
    if (stray) return { ok: false, reason: `${at}: ${stray} is not a field of a receipt line (a receipt takes the order's price, never a new one)` };
    if (!whole(l.lineNo, 1, 100000)) return { ok: false, reason: `${at}: lineNo must be the number of a line on the order` };
    if (!whole(l.quantityMilli, 1, 1_000_000_000)) return { ok: false, reason: `${at}: quantityMilli must be a whole number of thousandths, at least 1` };
    out.push({ lineNo: l.lineNo, quantityMilli: l.quantityMilli });
  }
  if (new Set(out.map((l) => l.lineNo)).size !== out.length) return { ok: false, reason: "the same order line is received twice; use one receipt line per order line" };
  return { ok: true, value: out };
}
export function checkShortText(v: unknown, label: string, max: number): Checked<string> {
  if (typeof v !== "string" || !v.trim() || v.trim().length > max) return { ok: false, reason: `${label} must be 1 to ${max} characters` };
  return { ok: true, value: v.trim().replace(/\s+/g, " ") };
}
export { checkDate };

// ---- reading (derived) -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------
async function orderLines(env: Env, orderId: number) {
  return (await many<{ line_no: number; description: string; quantity_milli: number; unit: string | null; unit_price_minor: number; tax_bp: number }>(env, "SELECT line_no, description, quantity_milli, unit, unit_price_minor, tax_bp FROM eng_document_line WHERE document_id = ? ORDER BY line_no", orderId));
}
export async function receiptsOf(env: Env, orderId: number): Promise<Array<{ eventId: number; documentId: number; receivedOn: string; lines: ReceiptLineInput[] }>> {
  const out = [];
  for (const e of await many<{ id: number; payload_json: string }>(env, "SELECT id, payload_json FROM eng_event WHERE type = 'goods.received' AND json_extract(payload_json, '$.orderId') = ? ORDER BY id", orderId)) {
    const p = parse(e.payload_json);
    const documentId = Number(p.documentId);
    if (!(await isEffective(env, "document", documentId))) continue;
    out.push({ eventId: e.id, documentId, receivedOn: String(p.receivedOn ?? ""), lines: Array.isArray(p.lines) ? (p.lines as ReceiptLineInput[]) : [] });
  }
  return out;
}
export async function cancellationOf(env: Env, orderId: number): Promise<{ eventId: number; reason: string; cancelledOn: string } | null> {
  const r = await many<{ id: number; payload_json: string }>(env, "SELECT id, payload_json FROM eng_event WHERE type = 'purchase_order.cancelled' AND json_extract(payload_json, '$.documentId') = ? ORDER BY id LIMIT 1", orderId);
  if (!r[0]) return null;
  const p = parse(r[0].payload_json);
  return { eventId: r[0].id, reason: String(p.reason ?? ""), cancelledOn: String(p.cancelledOn ?? "") };
}
export async function orderProgress(env: Env, orderId: number): Promise<LineProgress[]> {
  const received = new Map<number, number>();
  for (const r of await receiptsOf(env, orderId)) for (const l of r.lines) received.set(l.lineNo, (received.get(l.lineNo) ?? 0) + l.quantityMilli);
  return (await orderLines(env, orderId)).map((l) => { const got = received.get(l.line_no) ?? 0; return { lineNo: l.line_no, description: l.description, unit: l.unit, unitPriceMinor: l.unit_price_minor, taxBp: l.tax_bp, orderedMilli: l.quantity_milli, receivedMilli: got, remainingMilli: Math.max(0, l.quantity_milli - got) }; });
}
export async function orderSummary(env: Env, id: number): Promise<PurchaseOrderSummary | null> {
  const d = await env.OFFICE_DB.prepare("SELECT d.id, d.party_id, d.currency, d.issued_on, d.reference, d.terms_json, n.number AS number FROM eng_document d LEFT JOIN eng_document_number n ON n.document_id = d.id WHERE d.id = ? AND d.kind = 'purchase_order'").bind(id).first<{ id: number; party_id: number; currency: string; issued_on: string; reference: string | null; terms_json: string; number: number | null }>();
  if (!d) return null;
  const progress = await orderProgress(env, id);
  const receipts = await receiptsOf(env, id);
  const cancelled = (await cancellationOf(env, id)) !== null;
  const receivedAny = progress.some((l) => l.receivedMilli > 0), remaining = progress.some((l) => l.remainingMilli > 0);
  const status: OrderStatus = cancelled ? (receivedAny ? "closed" : "cancelled") : !receivedAny ? "open" : remaining ? "part_received" : "received";
  const t = await documentTotals(env, id);
  const exp = parse(d.terms_json).expectedOn;
  return {
    id: d.id, number: d.number, supplierId: d.party_id, currency: d.currency, orderedOn: d.issued_on, expectedOn: typeof exp === "string" ? exp : null, reference: d.reference,
    netMinor: t.netMinor, taxMinor: t.taxMinor, grossMinor: t.grossMinor, status, receipts: receipts.map((r) => r.documentId), cancelled,
    receivedValueMinor: progress.reduce((s, l) => s + lineNetMinor(l.receivedMilli, l.unitPriceMinor), 0),
    outstandingValueMinor: cancelled ? 0 : progress.reduce((s, l) => s + lineNetMinor(l.remainingMilli, l.unitPriceMinor), 0),
  };
}
export async function allOrders(env: Env, f: { supplierId?: number; status?: string } = {}): Promise<PurchaseOrderSummary[]> {
  const ids = await many<{ id: number }>(env, "SELECT id FROM eng_document WHERE kind = 'purchase_order' ORDER BY id");
  const out: PurchaseOrderSummary[] = [];
  for (const { id } of ids) {
    const s = await orderSummary(env, id);
    if (!s || !(await isEffective(env, "document", id))) continue;
    if (f.supplierId !== undefined && s.supplierId !== f.supplierId) continue;
    const want = f.status ?? "outstanding";
    if (want === "outstanding" ? !(s.status === "open" || s.status === "part_received") : want !== "any" && want !== s.status) continue;
    out.push(s);
  }
  return out;
}
export async function receiptInfo(env: Env, receiptId: number): Promise<{ eventId: number; orderId: number; receivedOn: string; deliveryNote: string | null; note: string | null } | null> {
  const r = await many<{ id: number; payload_json: string }>(env, "SELECT id, payload_json FROM eng_event WHERE type = 'goods.received' AND json_extract(payload_json, '$.documentId') = ? ORDER BY id LIMIT 1", receiptId);
  if (!r[0]) return null;
  const p = parse(r[0].payload_json);
  return { eventId: r[0].id, orderId: Number(p.orderId), receivedOn: String(p.receivedOn ?? ""), deliveryNote: typeof p.deliveryNote === "string" ? p.deliveryNote : null, note: typeof p.note === "string" ? p.note : null };
}
export async function orderEventIds(env: Env, orderId: number): Promise<number[]> {
  const rows = await many<{ id: number; payload_json: string }>(env, "SELECT id, payload_json FROM eng_event WHERE type IN ('goods.received', 'purchase_order.cancelled') ORDER BY id");
  return rows.filter((e) => { const p = parse(e.payload_json); return Number(p.orderId) === orderId || Number(p.documentId) === orderId; }).map((e) => e.id);
}

// ---- planning (reads that decide whether a write may happen) ---------------------------------------------------------------------------------------------------------------------------------------
export async function planOrder(env: Env, input: { supplierId: number; orderedOn: string; expectedOn?: string }) {
  const s = await partyProfile(env, input.supplierId);
  if (!s) throw new EngineError("not_found", "There is no such supplier.");
  if (!s.roles.includes("supplier")) throw new EngineError("invalid_state", `${s.name} is not a supplier, so an order cannot be placed with them.`);
  if (input.expectedOn !== undefined && input.expectedOn < input.orderedOn) throw new EngineError("invalid_input", "The expected date cannot be before the order date.");
  return { supplier: s };
}
async function requireOrder(env: Env, id: number) {
  const d = await env.OFFICE_DB.prepare("SELECT id, kind, party_id, currency, issued_on FROM eng_document WHERE id = ?").bind(id).first<{ id: number; kind: string; party_id: number; currency: string; issued_on: string }>();
  if (!d) throw new EngineError("not_found", "There is no such purchase order.");
  if (d.kind !== "purchase_order") throw new EngineError("invalid_state", "That document is not a purchase order.");
  const s = (await orderSummary(env, id))!;
  return { d, s };
}
const milli = (n: number) => (n / 1000).toString();
export async function planReceipt(env: Env, input: { orderId: number; receivedOn: unknown; lines: unknown }) {
  const { d, s } = await requireOrder(env, input.orderId);
  if (s.status === "received") throw new EngineError("invalid_state", "That order has already been received in full.");
  if (s.status === "cancelled" || s.status === "closed") throw new EngineError("invalid_state", "That order has been cancelled or closed, so goods cannot be received on it.");
  const date = checkDate(input.receivedOn, "The receipt date"); if (!date.ok) throw new EngineError("invalid_input", date.reason);
  if (date.value < d.issued_on) throw new EngineError("invalid_input", `A receipt cannot be dated before its order (${d.issued_on}).`);
  const lines = checkReceiptLines(input.lines); if (!lines.ok) throw new EngineError("invalid_input", lines.reason);
  const progress = await orderProgress(env, input.orderId);
  const docLines: Array<{ description: string; quantityMilli: number; unit: string | null; unitPriceMinor: number; taxBp: number }> = [];
  for (const l of lines.value) {
    const p = progress.find((x) => x.lineNo === l.lineNo);
    if (!p) throw new EngineError("invalid_input", `The order has no line ${l.lineNo}.`);
    if (l.quantityMilli > p.remainingMilli) throw new EngineError("invalid_state", `Line ${l.lineNo} (${p.description}) was ordered ${milli(p.orderedMilli)} and ${milli(p.receivedMilli)} has arrived, so only ${milli(p.remainingMilli)} remains to receive (${p.remainingMilli} thousandths).`);
    docLines.push({ description: p.description, quantityMilli: l.quantityMilli, unit: p.unit, unitPriceMinor: p.unitPriceMinor, taxBp: p.taxBp });
  }
  return { orderId: input.orderId, partyId: d.party_id, currency: d.currency, receivedOn: date.value, docLines, eventLines: lines.value };
}
export async function planCancel(env: Env, input: { orderId: number; reason: unknown; cancelledOn: unknown }) {
  const { d, s } = await requireOrder(env, input.orderId);
  if (s.status === "received") throw new EngineError("invalid_state", "That order has been received in full, so there is nothing left to cancel.");
  if (s.status === "cancelled" || s.status === "closed") throw new EngineError("invalid_state", "That order has already been cancelled or closed.");
  const reason = checkShortText(input.reason, "A cancellation reason", 200); if (!reason.ok) throw new EngineError("invalid_input", reason.reason);
  const date = checkDate(input.cancelledOn, "The cancellation date"); if (!date.ok) throw new EngineError("invalid_input", date.reason);
  if (date.value < d.issued_on) throw new EngineError("invalid_input", `A cancellation cannot be dated before its order (${d.issued_on}).`);
  return { orderId: input.orderId, reason: reason.value, cancelledOn: date.value, receivedValueMinor: s.receivedValueMinor };
}
