// Supplier invoices (bills), the three-way match, supplier payment and a bill's input tax (docs/decisions/supplier-invoices.md). A bill is a DOCUMENT of kind supplier_invoice (a payable); a supplier_invoice.recorded event keeps what the document cannot (the
// order it bills, the match result at the time it was recorded, whether a variance was accepted, the category, the claim date); a payment is a money-out movement allocated to bills, tied by a supplier_payment.recorded event. A bill's status, whether it is
// payable and what it owes are DERIVED from those and the ledger, never stored (the doctrine of parties.ts, expenses.ts and purchasing.ts); no schema changes. The three-way match is strict (no tolerance) and is worked out AT THE TIME OF RECORDING, never taken
// from a proposal. This file only READS and validates; facts.ts is the one write path.
import type { Env } from "../types";
import { taxLockDate } from "./business";
import { EXPENSE_CATEGORIES, EXPENSE_METHODS, inputTaxWith, nextDay, type InputTax } from "./expenses";
import { EngineError } from "./errors";
import { documentTotals, isEffective, outstandingForDocument } from "./ledger";
import { documentTotals as sumLines, type Totals } from "./money";
import { partyProfile } from "./parties";
import { orderProgress, orderSummary } from "./purchasing";
import { checkDate } from "./quotations";

export type MatchStatus = "matched" | "variance" | "no_order";
export interface BillLineInput { orderLineNo?: number; description: string; quantityMilli: number; unit: string | null; unitPriceMinor: number; taxBp: number }
export interface BillInput { supplierId: number; invoicedOn: string; dueOn?: string; currency: string; supplierInvoiceNumber: string; orderId?: number; category: string; taxInvoiceHeld: boolean; capital?: boolean; varianceAccepted?: boolean; lines: BillLineInput[] }
export interface MatchLine { lineNo: number; orderLineNo: number | null; quantityMilli: number; variances: string[] }
export interface Match { status: MatchStatus; lines: MatchLine[] }
type Checked<T> = { ok: true; value: T } | { ok: false; reason: string };
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const whole = (v: unknown, min: number, max: number): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max;
const many = async <T>(env: Env, sql: string, ...binds: unknown[]): Promise<T[]> => ((await env.OFFICE_DB.prepare(sql).bind(...binds).all<T>()).results ?? []);
const parse = (s: string): Record<string, unknown> => { try { const v = JSON.parse(s); return isObj(v) ? v : {}; } catch { return {}; } };

// ---- validation (pure) -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------
export function checkBillInput(v: unknown): Checked<BillInput> {
  if (!isObj(v)) return { ok: false, reason: "the bill must be an object" };
  const stray = Object.keys(v).find((k) => !["supplierId", "invoicedOn", "dueOn", "currency", "supplierInvoiceNumber", "orderId", "category", "taxInvoiceHeld", "capital", "varianceAccepted", "lines", "totals", "match"].includes(k));
  if (stray) return { ok: false, reason: `${stray} is not a field of a bill` };
  if (!whole(v.supplierId, 1, Number.MAX_SAFE_INTEGER)) return { ok: false, reason: "supplierId must be a record number" };
  const inv = checkDate(v.invoicedOn, "invoicedOn"); if (!inv.ok) return inv;
  let dueOn: string | undefined;
  if (v.dueOn !== undefined) { const d = checkDate(v.dueOn, "dueOn"); if (!d.ok) return d; if (d.value < inv.value) return { ok: false, reason: "dueOn cannot be before the invoice date" }; dueOn = d.value; }
  if (typeof v.currency !== "string" || !/^[A-Z]{3}$/.test(v.currency)) return { ok: false, reason: "currency must be a 3-letter code such as ZAR" };
  if (typeof v.supplierInvoiceNumber !== "string" || !v.supplierInvoiceNumber.trim() || v.supplierInvoiceNumber.trim().length > 60) return { ok: false, reason: "supplierInvoiceNumber is required: the supplier's own invoice number, 1 to 60 characters" };
  if (v.orderId !== undefined && !whole(v.orderId, 1, Number.MAX_SAFE_INTEGER)) return { ok: false, reason: "orderId must be a record number" };
  if (typeof v.category !== "string" || !(EXPENSE_CATEGORIES as readonly string[]).includes(v.category)) return { ok: false, reason: `category must be one of ${EXPENSE_CATEGORIES.join(", ")}` };
  if (typeof v.taxInvoiceHeld !== "boolean") return { ok: false, reason: "taxInvoiceHeld must be true or false" };
  if (v.capital !== undefined && typeof v.capital !== "boolean") return { ok: false, reason: "capital must be true or false" };
  if (v.varianceAccepted !== undefined && typeof v.varianceAccepted !== "boolean") return { ok: false, reason: "varianceAccepted must be true or false" };
  if (!Array.isArray(v.lines) || v.lines.length === 0) return { ok: false, reason: "a bill needs at least one line" };
  if (v.lines.length > 100) return { ok: false, reason: "a bill may have at most 100 lines" };
  const lines: BillLineInput[] = [];
  for (const [i, l] of v.lines.entries()) {
    const at = `line ${i + 1}`;
    if (!isObj(l)) return { ok: false, reason: `${at} must be an object` };
    const s = Object.keys(l).find((k) => !["orderLineNo", "description", "quantityMilli", "unit", "unitPriceMinor", "taxBp"].includes(k));
    if (s) return { ok: false, reason: `${at}: ${s} is not a field of a line` };
    if (l.orderLineNo !== undefined && !whole(l.orderLineNo, 1, 100000)) return { ok: false, reason: `${at}: orderLineNo must be the number of a line on the order` };
    if (typeof l.description !== "string" || !l.description.trim() || l.description.trim().length > 200) return { ok: false, reason: `${at}: description must be 1 to 200 characters` };
    if (!whole(l.quantityMilli, 1, 1_000_000_000)) return { ok: false, reason: `${at}: quantityMilli must be a whole number of thousandths, at least 1` };
    if (!whole(l.unitPriceMinor, 0, 1_000_000_000_000)) return { ok: false, reason: `${at}: unitPriceMinor must be a whole number of cents, not negative` };
    if (!whole(l.taxBp, 0, 10000)) return { ok: false, reason: `${at}: taxBp is required: the tax rate in basis points, 0 to 10000 (VAT is never assumed)` };
    if (l.unit !== undefined && l.unit !== null && (typeof l.unit !== "string" || l.unit.length > 20)) return { ok: false, reason: `${at}: unit must be at most 20 characters` };
    lines.push({ ...(l.orderLineNo !== undefined ? { orderLineNo: l.orderLineNo as number } : {}), description: l.description.trim(), quantityMilli: l.quantityMilli, unit: (l.unit as string | null | undefined) ?? null, unitPriceMinor: l.unitPriceMinor, taxBp: l.taxBp });
  }
  return { ok: true, value: { supplierId: v.supplierId, invoicedOn: inv.value, ...(dueOn ? { dueOn } : {}), currency: v.currency, supplierInvoiceNumber: v.supplierInvoiceNumber.trim(), ...(v.orderId !== undefined ? { orderId: v.orderId as number } : {}), category: v.category, taxInvoiceHeld: v.taxInvoiceHeld, ...(v.capital !== undefined ? { capital: v.capital as boolean } : {}), ...(v.varianceAccepted !== undefined ? { varianceAccepted: v.varianceAccepted as boolean } : {}), lines } };
}

// ---- reading (derived) -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------
export interface BillInfo { documentId: number; supplierId: number; orderId: number | null; supplierInvoiceNumber: string; invoicedOn: string; dueOn: string | null; category: string; taxInvoiceHeld: boolean; capital: boolean; claimDate: string; matchStatus: MatchStatus; varianceAccepted: boolean; lines: MatchLine[]; eventId: number }
const infoOf = (e: { id: number; payload_json: string }): BillInfo => {
  const p = parse(e.payload_json);
  return { documentId: Number(p.documentId), supplierId: Number(p.supplierId), orderId: typeof p.orderId === "number" ? p.orderId : null, supplierInvoiceNumber: String(p.supplierInvoiceNumber ?? ""), invoicedOn: String(p.invoicedOn ?? ""), dueOn: typeof p.dueOn === "string" ? p.dueOn : null, category: String(p.category ?? ""), taxInvoiceHeld: p.taxInvoiceHeld === true, capital: p.capital === true, claimDate: String(p.claimDate ?? p.invoicedOn ?? ""), matchStatus: (p.matchStatus === "matched" || p.matchStatus === "variance" ? p.matchStatus : "no_order") as MatchStatus, varianceAccepted: p.varianceAccepted === true, lines: Array.isArray(p.lines) ? (p.lines as MatchLine[]) : [], eventId: e.id };
};
export async function billInfo(env: Env, documentId: number): Promise<BillInfo | null> {
  const r = await many<{ id: number; payload_json: string }>(env, "SELECT id, payload_json FROM eng_event WHERE type = 'supplier_invoice.recorded' AND json_extract(payload_json, '$.documentId') = ? ORDER BY id LIMIT 1", documentId);
  return r[0] ? infoOf(r[0]) : null;
}
export async function billEventIds(env: Env, documentId: number): Promise<number[]> {
  return (await many<{ id: number }>(env, "SELECT id FROM eng_event WHERE type IN ('supplier_invoice.recorded', 'supplier_invoice.voided') AND json_extract(payload_json, '$.documentId') = ? ORDER BY id", documentId)).map((e) => e.id);
}
export async function billInputTax(env: Env, documentId: number): Promise<InputTax | null> {
  const info = await billInfo(env, documentId);
  return info ? inputTaxWith(env, documentId, { supplierId: info.supplierId, taxInvoiceHeld: info.taxInvoiceHeld, category: info.category, claimDate: info.claimDate, capital: info.capital }) : null;
}
const isPayable = (i: BillInfo) => i.matchStatus !== "variance" || i.varianceAccepted;
export type BillStatus = "unpaid" | "part_paid" | "paid" | "voided";
export interface BillSummary { ref: { kind: "document"; id: number }; id: number; number: number | null; supplierId: number; supplierName: string | null; supplierInvoiceNumber: string; invoicedOn: string; dueOn: string | null; orderId: number | null; category: string; netMinor: number; taxMinor: number; grossMinor: number; outstandingMinor: number; status: BillStatus; matchStatus: MatchStatus; varianceAccepted: boolean; payable: boolean; taxInvoiceHeld: boolean; capital: boolean; claimDate: string; inputTaxClaimable: boolean; inputTaxMinor: number; inputTaxReasons: string[] }
export async function allBills(env: Env, f: { supplierId?: number; status?: string } = {}): Promise<BillSummary[]> {
  const docs = await many<{ id: number; number: number | null }>(env, "SELECT d.id, n.number AS number FROM eng_document d LEFT JOIN eng_document_number n ON n.document_id = d.id WHERE d.kind = 'supplier_invoice' AND d.direction = 'buy' ORDER BY d.id");
  const out: BillSummary[] = [];
  for (const d of docs) {
    const info = await billInfo(env, d.id);
    if (!info) continue;
    if (f.supplierId !== undefined && info.supplierId !== f.supplierId) continue;
    const effective = await isEffective(env, "document", d.id);
    const t = await documentTotals(env, d.id);
    const owed = effective ? Math.max(0, await outstandingForDocument(env, d.id)) : 0;
    const status: BillStatus = !effective ? "voided" : owed === 0 ? "paid" : owed < t.grossMinor ? "part_paid" : "unpaid";
    const want = f.status ?? "outstanding";
    if (want === "outstanding" ? !(status === "unpaid" || status === "part_paid") : want !== "any" && want !== status) continue;
    const it = (await billInputTax(env, d.id))!;
    const sup = await partyProfile(env, info.supplierId);
    out.push({ ref: { kind: "document", id: d.id }, id: d.id, number: d.number, supplierId: info.supplierId, supplierName: sup ? sup.name : null, supplierInvoiceNumber: info.supplierInvoiceNumber, invoicedOn: info.invoicedOn, dueOn: info.dueOn, orderId: info.orderId, category: info.category, netMinor: t.netMinor, taxMinor: t.taxMinor, grossMinor: t.grossMinor, outstandingMinor: owed, status, matchStatus: info.matchStatus, varianceAccepted: info.varianceAccepted, payable: effective && isPayable(info), taxInvoiceHeld: info.taxInvoiceHeld, capital: info.capital, claimDate: info.claimDate, inputTaxClaimable: it.claimable, inputTaxMinor: it.claimable ? it.taxMinor : 0, inputTaxReasons: it.reasons });
  }
  return out;
}

// ---- planning --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
export async function billedSoFar(env: Env, orderId: number): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  for (const e of await many<{ id: number; payload_json: string }>(env, "SELECT id, payload_json FROM eng_event WHERE type = 'supplier_invoice.recorded' AND json_extract(payload_json, '$.orderId') = ? ORDER BY id", orderId)) {
    const i = infoOf(e);
    if (!(await isEffective(env, "document", i.documentId))) continue;
    for (const l of i.lines) if (l.orderLineNo !== null && l.orderLineNo !== undefined) out.set(l.orderLineNo, (out.get(l.orderLineNo) ?? 0) + l.quantityMilli);
  }
  return out;
}
export async function planBill(env: Env, input: BillInput) {
  const supplier = await partyProfile(env, input.supplierId);
  if (!supplier) throw new EngineError("not_found", "There is no such supplier.");
  if (!supplier.roles.includes("supplier")) throw new EngineError("invalid_state", `${supplier.name} is not a supplier, so a bill cannot be recorded from them.`);
  const dup = await many<{ id: number }>(env, "SELECT id FROM eng_document WHERE kind = 'supplier_invoice' AND party_id = ? AND reference = ?", input.supplierId, input.supplierInvoiceNumber);
  for (const d of dup) if (await isEffective(env, "document", d.id)) throw new EngineError("duplicate", `Supplier invoice ${input.supplierInvoiceNumber} from ${supplier.name} has already been recorded.`);
  const docLines = input.lines.map((l) => ({ description: l.description, quantityMilli: l.quantityMilli, unit: l.unit, unitPriceMinor: l.unitPriceMinor, taxBp: l.taxBp }));
  const totals: Totals = sumLines(docLines);
  const matchLines: MatchLine[] = input.lines.map((l, i) => ({ lineNo: i + 1, orderLineNo: l.orderLineNo ?? null, quantityMilli: l.quantityMilli, variances: [] }));
  let status: MatchStatus = "no_order";
  if (input.orderId !== undefined) {
    const order = await env.OFFICE_DB.prepare("SELECT id, kind, party_id FROM eng_document WHERE id = ?").bind(input.orderId).first<{ id: number; kind: string; party_id: number }>();
    if (!order) throw new EngineError("not_found", "There is no such purchase order.");
    if (order.kind !== "purchase_order") throw new EngineError("invalid_state", "That document is not a purchase order.");
    if (order.party_id !== input.supplierId) throw new EngineError("invalid_state", "That order is with another supplier.");
    const progress = await orderProgress(env, input.orderId);
    const billed = await billedSoFar(env, input.orderId);
    const running = new Map<number, number>();
    for (const [i, l] of input.lines.entries()) {
      if (l.orderLineNo === undefined) { matchLines[i].variances.push("not_on_order"); continue; }
      const p = progress.find((x) => x.lineNo === l.orderLineNo);
      if (!p) throw new EngineError("invalid_input", `The order has no line ${l.orderLineNo}.`);
      if (l.unitPriceMinor !== p.unitPriceMinor) matchLines[i].variances.push("price");
      if (l.taxBp !== p.taxBp) matchLines[i].variances.push("tax_rate");
      const total = (billed.get(l.orderLineNo) ?? 0) + (running.get(l.orderLineNo) ?? 0) + l.quantityMilli;
      running.set(l.orderLineNo, (running.get(l.orderLineNo) ?? 0) + l.quantityMilli);
      if (total > p.receivedMilli) matchLines[i].variances.push("quantity");
    }
    status = matchLines.some((m) => m.variances.length > 0) ? "variance" : "matched";
  }
  const lock = await taxLockDate(env);
  const claimDate = lock !== null && input.invoicedOn <= lock ? nextDay(lock) : input.invoicedOn;   // fixed NOW: locking a period later never moves an old claim
  return { supplier, docLines, totals, match: { status, lines: matchLines } as Match, claimDate };
}

export async function planBillVoid(env: Env, input: { billId: number; reason: unknown; voidedOn: unknown }) {
  const d = await env.OFFICE_DB.prepare("SELECT id, kind FROM eng_document WHERE id = ?").bind(input.billId).first<{ id: number; kind: string }>();
  if (!d) throw new EngineError("not_found", "There is no such bill.");
  if (d.kind !== "supplier_invoice") throw new EngineError("invalid_state", "That document is not a supplier invoice.");
  const info = await billInfo(env, d.id);
  if (!info) throw new EngineError("invalid_state", "That bill has no record of how it was entered.");
  if (!(await isEffective(env, "document", d.id))) throw new EngineError("invalid_state", "That bill has already been voided.");
  const live = await many<{ id: number }>(env, "SELECT id FROM eng_allocation WHERE document_id = ?", d.id);
  for (const a of live) if (await isEffective(env, "allocation", a.id)) throw new EngineError("invalid_state", "A payment has been allocated to that bill, so it cannot be voided: remove the allocation first.");
  if (typeof input.reason !== "string" || !input.reason.trim() || input.reason.trim().length > 200) throw new EngineError("invalid_input", "A void needs a reason of up to 200 characters.");
  const v = checkDate(input.voidedOn, "The void date"); if (!v.ok) throw new EngineError("invalid_input", v.reason);
  if (v.value < info.invoicedOn) throw new EngineError("invalid_input", "A void cannot be dated before the bill.");
  const it = (await billInputTax(env, d.id))!;
  const lock = await taxLockDate(env);
  if (it.claimable && lock !== null && info.claimDate <= lock) throw new EngineError("period_locked", `The input tax on that bill was claimed on ${info.claimDate}, in a tax period that is locked (up to ${lock}); voiding it would change a filed return.`);
  return { billId: d.id, reason: input.reason.trim().replace(/\s+/g, " "), voidedOn: v.value, supplierId: info.supplierId };
}

export interface PaymentInput { supplierId: number; amountMinor: number; currency: string; paidOn: string; method: string; allocations?: Array<{ billId: number; amountMinor: number }>; allocate?: "oldest_first" }
export { EXPENSE_METHODS };
export async function planSupplierPayment(env: Env, input: PaymentInput) {
  const supplier = await partyProfile(env, input.supplierId);
  if (!supplier) throw new EngineError("not_found", "There is no such supplier.");
  if (!supplier.roles.includes("supplier")) throw new EngineError("invalid_state", `${supplier.name} is not a supplier, so they cannot be paid.`);
  const date = checkDate(input.paidOn, "The payment date"); if (!date.ok) throw new EngineError("invalid_input", date.reason);
  if (!(EXPENSE_METHODS as readonly string[]).includes(input.method)) throw new EngineError("invalid_input", `method must be one of ${EXPENSE_METHODS.join(", ")}.`);
  if (!whole(input.amountMinor, 1, 1_000_000_000_000)) throw new EngineError("invalid_input", "The amount must be a whole number of cents, at least 1.");
  const allocations: Array<{ billId: number; amountMinor: number }> = [];
  const check1 = async (billId: number, amount: number) => {
    const d = await env.OFFICE_DB.prepare("SELECT id, kind, party_id, issued_on, currency FROM eng_document WHERE id = ?").bind(billId).first<{ id: number; kind: string; party_id: number; issued_on: string; currency: string }>();
    if (!d) throw new EngineError("not_found", `There is no such bill (${billId}).`);
    if (d.kind !== "supplier_invoice") throw new EngineError("invalid_state", "That document is not a supplier invoice.");
    if (d.party_id !== input.supplierId) throw new EngineError("invalid_state", "That bill belongs to another supplier.");
    const info = await billInfo(env, d.id);
    if (!info || !(await isEffective(env, "document", d.id))) throw new EngineError("invalid_state", "That bill has been voided, so it cannot be paid.");
    if (!isPayable(info)) throw new EngineError("invalid_state", "That bill has an unaccepted variance against its order, so it cannot be paid until the variance is accepted.");
    if (date.value < d.issued_on) throw new EngineError("invalid_input", `A payment cannot be dated before the bill it pays (${d.issued_on}).`);
    if (d.currency !== input.currency) throw new EngineError("invalid_input", `That bill is in ${d.currency}.`);
    const owed = await outstandingForDocument(env, d.id);
    if (amount > owed) throw new EngineError("invalid_state", `That bill only owes ${Math.max(0, owed)}.`);
  };
  if (input.allocate === "oldest_first") {
    let left = input.amountMinor;
    for (const b of (await allBills(env, { supplierId: input.supplierId, status: "outstanding" })).filter((x) => x.payable)) {
      if (left <= 0) break;
      const take = Math.min(left, b.outstandingMinor);
      await check1(b.id, take);
      allocations.push({ billId: b.id, amountMinor: take }); left -= take;
    }
    if (left > 0) throw new EngineError("invalid_state", `Only ${input.amountMinor - left} is payable to this supplier right now; ${left} would be left over.`);
  } else {
    for (const a of input.allocations ?? []) { await check1(a.billId, a.amountMinor); allocations.push(a); }
    const sum = allocations.reduce((s, a) => s + a.amountMinor, 0);
    if (sum !== input.amountMinor) throw new EngineError("invalid_input", `The allocations add up to ${sum} but ${input.amountMinor} is being paid: they must agree (a supplier is not overpaid).`);
  }
  return { supplier, paidOn: date.value, allocations };
}
export { orderSummary };

export interface UnbilledLine { orderId: number; orderNumber: number | null; supplierId: number; supplierName: string | null; lineNo: number; description: string; unit: string | null; receivedMilli: number; billedMilli: number; unbilledMilli: number; unitPriceMinor: number; valueMinor: number }
/** Goods received and not yet invoiced, by order line: what has arrived less what bills have billed, at the order's own price (before tax). The supplier will still invoice goods that arrived, even if the rest of the order was cancelled. */
export async function goodsUnbilled(env: Env, f: { supplierId?: number } = {}): Promise<UnbilledLine[]> {
  const out: UnbilledLine[] = [];
  for (const o of await many<{ id: number; party_id: number; number: number | null }>(env, "SELECT d.id, d.party_id, n.number AS number FROM eng_document d LEFT JOIN eng_document_number n ON n.document_id = d.id WHERE d.kind = 'purchase_order' ORDER BY d.id")) {
    if (f.supplierId !== undefined && o.party_id !== f.supplierId) continue;
    if (!(await isEffective(env, "document", o.id))) continue;
    const billed = await billedSoFar(env, o.id), sup = await partyProfile(env, o.party_id);
    for (const l of await orderProgress(env, o.id)) {
      const b = billed.get(l.lineNo) ?? 0, un = l.receivedMilli - b;
      if (un > 0) out.push({ orderId: o.id, orderNumber: o.number, supplierId: o.party_id, supplierName: sup ? sup.name : null, lineNo: l.lineNo, description: l.description, unit: l.unit, receivedMilli: l.receivedMilli, billedMilli: b, unbilledMilli: un, unitPriceMinor: l.unitPriceMinor, valueMinor: Math.round((un * l.unitPriceMinor) / 1000) });
    }
  }
  return out;
}
