// Expenses: a PAID purchase. One `expense` document (direction buy, from a supplier) plus the money-out movement that paid it, tied by an expense.recorded event; there is no payable and no allocation (an unpaid supplier invoice is a
// bill, the procurement row). Everything here is DERIVED from those facts and events, never stored, so nothing is edited and no schema changes (the doctrine of parties.ts and quotations.ts). Research and decisions: docs/decisions/expenses.md.
// Input tax claimability is derived with its reasons (VAT Act s16(2) valid tax invoice, s17(2) denied categories, a VAT registered business, a vendor supplier), and the VAT claim date is fixed WHEN THE EXPENSE IS RECORDED (the invoice date, or
// the first open day after the tax lock), so locking a period later never moves an old claim. This file only READS and validates; facts.ts is the one write path.
import type { Env } from "../types";
import { businessProfile, taxLockDate } from "./business";
import { EngineError } from "./errors";
import { documentTotals, isEffective } from "./ledger";
import { documentTotals as sumLines, type Totals } from "./money";
import { partyProfile } from "./parties";
import { checkDate } from "./quotations";

export const EXPENSE_CATEGORIES = ["advertising", "bank_charges", "cleaning", "consumables", "entertainment", "fuel", "insurance", "materials", "motor_car", "office_supplies", "professional_fees", "rent", "repairs", "stationery", "subscriptions", "club_subscription", "telephone", "tools", "travel", "utilities", "other"] as const;
export const DENIED_CATEGORIES: readonly string[] = ["entertainment", "motor_car", "club_subscription"];   // VAT Act s17(2)
export const EXPENSE_METHODS = ["eft", "cash", "card", "cheque", "other"] as const;
export const SMALL_PURCHASE_MINOR = 5000;                                                               // R50.00: the receipt is enough proof
export interface ExpenseLineInput { description: string; amountMinor: number; taxBp: number }
export interface ExpenseInput { supplierId: number; incurredOn: string; paidOn?: string; method: string; category: string; currency: string; amountsIncludeTax: boolean; lines: ExpenseLineInput[]; amountPaidMinor: number; taxInvoiceHeld: boolean; supplierInvoiceNumber?: string; receiptRef?: string; capital?: boolean }
type Checked<T> = { ok: true; value: T } | { ok: false; reason: string };
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const whole = (v: unknown, min: number, max: number): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max;
const many = async <T>(env: Env, sql: string, ...binds: unknown[]): Promise<T[]> => ((await env.OFFICE_DB.prepare(sql).bind(...binds).all<T>()).results ?? []);
const parse = (s: string): Record<string, unknown> => { try { const v = JSON.parse(s); return isObj(v) ? v : {}; } catch { return {}; } };

// ---- validation (pure) -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------
export function checkExpenseInput(v: unknown): Checked<ExpenseInput> {
  if (!isObj(v)) return { ok: false, reason: "the expense must be an object" };
  const stray = Object.keys(v).find((k) => !["supplierId", "incurredOn", "paidOn", "method", "category", "currency", "amountsIncludeTax", "lines", "amountPaidMinor", "taxInvoiceHeld", "supplierInvoiceNumber", "receiptRef", "capital", "totals"].includes(k));
  if (stray) return { ok: false, reason: `${stray} is not a field of an expense` };
  if (!whole(v.supplierId, 1, Number.MAX_SAFE_INTEGER)) return { ok: false, reason: "supplierId must be a record number" };
  const inc = checkDate(v.incurredOn, "incurredOn"); if (!inc.ok) return inc;
  let paidOn: string | undefined;
  if (v.paidOn !== undefined) { const p = checkDate(v.paidOn, "paidOn"); if (!p.ok) return p; paidOn = p.value; }
  if (typeof v.method !== "string" || !(EXPENSE_METHODS as readonly string[]).includes(v.method)) return { ok: false, reason: `method must be one of ${EXPENSE_METHODS.join(", ")}` };
  if (typeof v.category !== "string" || !(EXPENSE_CATEGORIES as readonly string[]).includes(v.category)) return { ok: false, reason: `category must be one of ${EXPENSE_CATEGORIES.join(", ")}` };
  if (typeof v.currency !== "string" || !/^[A-Z]{3}$/.test(v.currency)) return { ok: false, reason: "currency must be a 3-letter code such as ZAR" };
  if (typeof v.amountsIncludeTax !== "boolean") return { ok: false, reason: "amountsIncludeTax must be true or false: say whether the amounts entered include tax (it is never assumed)" };
  if (typeof v.taxInvoiceHeld !== "boolean") return { ok: false, reason: "taxInvoiceHeld must be true or false" };
  if (v.capital !== undefined && typeof v.capital !== "boolean") return { ok: false, reason: "capital must be true or false" };
  if (!whole(v.amountPaidMinor, 1, 1_000_000_000_000)) return { ok: false, reason: "amountPaidMinor must be a whole number of cents, at least 1" };
  let inv: string | undefined, rc: string | undefined;
  if (v.supplierInvoiceNumber !== undefined) { if (typeof v.supplierInvoiceNumber !== "string" || !v.supplierInvoiceNumber.trim() || v.supplierInvoiceNumber.trim().length > 60) return { ok: false, reason: "supplierInvoiceNumber must be 1 to 60 characters" }; inv = v.supplierInvoiceNumber.trim(); }
  if (v.receiptRef !== undefined) { if (typeof v.receiptRef !== "string" || !v.receiptRef.trim() || v.receiptRef.trim().length > 200) return { ok: false, reason: "receiptRef must be 1 to 200 characters" }; rc = v.receiptRef.trim(); }
  if (!Array.isArray(v.lines) || v.lines.length === 0) return { ok: false, reason: "an expense needs at least one line" };
  if (v.lines.length > 100) return { ok: false, reason: "an expense may have at most 100 lines" };
  const lines: ExpenseLineInput[] = [];
  for (const [i, l] of v.lines.entries()) {
    const at = `line ${i + 1}`;
    if (!isObj(l)) return { ok: false, reason: `${at} must be an object` };
    const s = Object.keys(l).find((k) => !["description", "amountMinor", "taxBp"].includes(k));
    if (s) return { ok: false, reason: `${at}: ${s} is not a field of a line` };
    if (typeof l.description !== "string" || !l.description.trim() || l.description.trim().length > 200) return { ok: false, reason: `${at}: description must be 1 to 200 characters` };
    if (!whole(l.amountMinor, 1, 1_000_000_000_000)) return { ok: false, reason: `${at}: amountMinor must be a whole number of cents, at least 1` };
    if (!whole(l.taxBp, 0, 10000)) return { ok: false, reason: `${at}: taxBp is required: the tax rate in basis points, 0 to 10000 (VAT is never assumed)` };
    lines.push({ description: l.description.trim(), amountMinor: l.amountMinor, taxBp: l.taxBp });
  }
  return { ok: true, value: { supplierId: v.supplierId, incurredOn: inc.value, ...(paidOn ? { paidOn } : {}), method: v.method, category: v.category, currency: v.currency, amountsIncludeTax: v.amountsIncludeTax, lines, amountPaidMinor: v.amountPaidMinor, taxInvoiceHeld: v.taxInvoiceHeld, ...(inv ? { supplierInvoiceNumber: inv } : {}), ...(rc ? { receiptRef: rc } : {}), ...(v.capital !== undefined ? { capital: v.capital as boolean } : {}) } };
}

// A receipt's line becomes a document line of one unit at the NET price: when the amount includes tax, the tax is the tax fraction of it (rate / (100 + rate)).
export function docLinesOf(input: ExpenseInput) {
  return input.lines.map((l) => {
    const tax = input.amountsIncludeTax ? Math.round((l.amountMinor * l.taxBp) / (10000 + l.taxBp)) : 0;
    return { description: l.description, quantityMilli: 1000, unit: null as string | null, unitPriceMinor: input.amountsIncludeTax ? l.amountMinor - tax : l.amountMinor, taxBp: l.taxBp };
  });
}
export const nextDay = (d: string): string => { const x = new Date(d + "T00:00:00Z"); x.setUTCDate(x.getUTCDate() + 1); return x.toISOString().slice(0, 10); };

// ---- planning (reads) ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
export async function planExpense(env: Env, input: ExpenseInput) {
  const supplier = await partyProfile(env, input.supplierId);
  if (!supplier) throw new EngineError("not_found", "There is no such supplier.");
  if (!supplier.roles.includes("supplier")) throw new EngineError("invalid_state", `${supplier.name} is not a supplier, so an expense cannot be recorded against them.`);
  const c = checkExpenseInput(input); if (!c.ok) throw new EngineError("invalid_input", c.reason);
  const paidOn = input.paidOn ?? input.incurredOn;
  if (paidOn < input.incurredOn) throw new EngineError("invalid_input", "An expense cannot be paid before it was incurred.");
  const docLines = docLinesOf(input);
  const totals: Totals = sumLines(docLines);
  if (Math.abs(totals.grossMinor - input.amountPaidMinor) > input.lines.length) throw new EngineError("invalid_input", `The lines come to ${totals.grossMinor} but ${input.amountPaidMinor} was paid: they must agree to within a cent a line (check the amounts and the tax).`);
  if (input.supplierInvoiceNumber) {
    const dup = await many<{ id: number }>(env, "SELECT id FROM eng_document WHERE kind = 'expense' AND party_id = ? AND reference = ?", input.supplierId, input.supplierInvoiceNumber);
    for (const d of dup) if (await isEffective(env, "document", d.id)) throw new EngineError("duplicate", `Supplier invoice ${input.supplierInvoiceNumber} from ${supplier.name} has already been recorded.`);
  }
  const lock = await taxLockDate(env);
  const claimDate = lock !== null && input.incurredOn <= lock ? nextDay(lock) : input.incurredOn;   // fixed NOW: locking a period later never moves an old claim
  return { supplier, paidOn, docLines, totals, claimDate };
}

export interface ExpenseInfo { documentId: number; movementId: number; supplierId: number; category: string; amountPaidMinor: number; paidOn: string; method: string; incurredOn: string; claimDate: string; taxInvoiceHeld: boolean; supplierInvoiceNumber: string | null; receiptRef: string | null; capital: boolean; eventId: number }
const infoOf = (e: { id: number; payload_json: string }): ExpenseInfo => {
  const p = parse(e.payload_json);
  return { documentId: Number(p.documentId), movementId: Number(p.movementId), supplierId: Number(p.supplierId), category: String(p.category ?? ""), amountPaidMinor: Number(p.amountPaidMinor), paidOn: String(p.paidOn ?? ""), method: String(p.method ?? ""), incurredOn: String(p.incurredOn ?? ""), claimDate: String(p.claimDate ?? p.incurredOn ?? ""), taxInvoiceHeld: p.taxInvoiceHeld === true, supplierInvoiceNumber: typeof p.supplierInvoiceNumber === "string" ? p.supplierInvoiceNumber : null, receiptRef: typeof p.receiptRef === "string" ? p.receiptRef : null, capital: p.capital === true, eventId: e.id };
};
export async function expenseInfo(env: Env, documentId: number): Promise<ExpenseInfo | null> {
  const r = await many<{ id: number; payload_json: string }>(env, "SELECT id, payload_json FROM eng_event WHERE type = 'expense.recorded' AND json_extract(payload_json, '$.documentId') = ? ORDER BY id LIMIT 1", documentId);
  return r[0] ? infoOf(r[0]) : null;
}
export async function expenseEventIds(env: Env, documentId: number): Promise<number[]> {
  return (await many<{ id: number }>(env, "SELECT id FROM eng_event WHERE type IN ('expense.recorded', 'expense.voided') AND json_extract(payload_json, '$.documentId') = ? ORDER BY id", documentId)).map((e) => e.id);
}

export interface InputTax { claimable: boolean; taxMinor: number; reasons: string[]; advisory: string[]; claimDate: string; capital: boolean }
// Whether the input tax on an expense can be claimed, and if not exactly why (docs/decisions/expenses.md, decision 4).
export async function inputTaxOf(env: Env, documentId: number): Promise<InputTax | null> {
  const info = await expenseInfo(env, documentId);
  if (!info) return null;
  const totals = await documentTotals(env, documentId);
  const reasons: string[] = [], advisory: string[] = [];
  if (!(await isEffective(env, "document", documentId))) reasons.push("the expense has been voided");
  if (totals.taxMinor <= 0) reasons.push("there is no tax on this purchase");
  const profile = await businessProfile(env);
  if (profile.vatRegistered !== true) reasons.push("the business is not recorded as VAT registered");
  const supplier = await partyProfile(env, info.supplierId);
  if (!supplier || !/^4\d{9}$/.test(supplier.contact.vatNumber ?? "")) reasons.push("the supplier has no VAT number on record, so is not known to be a vendor (VAT on their invoice would be invalid)");
  if (!info.taxInvoiceHeld && totals.grossMinor > SMALL_PURCHASE_MINOR) reasons.push("no valid tax invoice is held (required above R50)");
  if (DENIED_CATEGORIES.includes(info.category)) reasons.push("input tax is denied on this kind of expense (VAT Act s17(2))");
  if (info.category === "other") advisory.push('category "other": an accountant should classify it');
  return { claimable: reasons.length === 0, taxMinor: totals.taxMinor, reasons, advisory, claimDate: info.claimDate, capital: info.capital };
}

export interface ExpenseSummary { ref: { kind: "document"; id: number }; id: number; number: number | null; supplierId: number; supplierName: string | null; category: string; incurredOn: string; paidOn: string; method: string; netMinor: number; taxMinor: number; grossMinor: number; amountPaidMinor: number; supplierInvoiceNumber: string | null; receiptRef: string | null; taxInvoiceHeld: boolean; capital: boolean; status: "recorded" | "voided"; inputTaxClaimable: boolean; inputTaxMinor: number; inputTaxReasons: string[]; claimDate: string }
export async function allExpenses(env: Env, f: { from?: string; to?: string; category?: string; supplierId?: number; status?: string } = {}): Promise<ExpenseSummary[]> {
  const docs = await many<{ id: number; party_id: number; number: number | null }>(env, "SELECT d.id, d.party_id, n.number AS number FROM eng_document d LEFT JOIN eng_document_number n ON n.document_id = d.id WHERE d.kind = 'expense' AND d.direction = 'buy' ORDER BY d.id");
  const out: ExpenseSummary[] = [];
  for (const d of docs) {
    const info = await expenseInfo(env, d.id);
    if (!info) continue;
    const status = (await isEffective(env, "document", d.id)) ? "recorded" : "voided";
    const want = f.status ?? "recorded";
    if (want !== "any" && want !== status) continue;
    if (f.from !== undefined && info.incurredOn < f.from) continue;
    if (f.to !== undefined && info.incurredOn > f.to) continue;
    if (f.category !== undefined && info.category !== f.category) continue;
    if (f.supplierId !== undefined && info.supplierId !== f.supplierId) continue;
    const t = await documentTotals(env, d.id);
    const it = (await inputTaxOf(env, d.id))!;
    const sup = await partyProfile(env, info.supplierId);
    out.push({ ref: { kind: "document", id: d.id }, id: d.id, number: d.number, supplierId: info.supplierId, supplierName: sup ? sup.name : null, category: info.category, incurredOn: info.incurredOn, paidOn: info.paidOn, method: info.method, netMinor: t.netMinor, taxMinor: t.taxMinor, grossMinor: t.grossMinor, amountPaidMinor: info.amountPaidMinor, supplierInvoiceNumber: info.supplierInvoiceNumber, receiptRef: info.receiptRef, taxInvoiceHeld: info.taxInvoiceHeld, capital: info.capital, status, inputTaxClaimable: it.claimable, inputTaxMinor: it.claimable ? it.taxMinor : 0, inputTaxReasons: it.reasons, claimDate: info.claimDate });
  }
  return out;
}

export async function planExpenseVoid(env: Env, input: { expenseId: number; reason: unknown; voidedOn: unknown }) {
  const d = await env.OFFICE_DB.prepare("SELECT id, kind FROM eng_document WHERE id = ?").bind(input.expenseId).first<{ id: number; kind: string }>();
  if (!d) throw new EngineError("not_found", "There is no such expense.");
  if (d.kind !== "expense") throw new EngineError("invalid_state", "That document is not an expense.");
  const info = await expenseInfo(env, d.id);
  if (!info) throw new EngineError("invalid_state", "That expense has no record of how it was paid.");
  if (!(await isEffective(env, "document", d.id))) throw new EngineError("invalid_state", "That expense has already been voided.");
  if (typeof input.reason !== "string" || !input.reason.trim() || input.reason.trim().length > 200) throw new EngineError("invalid_input", "A void needs a reason of up to 200 characters.");
  const v = checkDate(input.voidedOn, "The void date"); if (!v.ok) throw new EngineError("invalid_input", v.reason);
  if (v.value < info.incurredOn) throw new EngineError("invalid_input", "A void cannot be dated before the expense.");
  const it = (await inputTaxOf(env, d.id))!;
  const lock = await taxLockDate(env);
  if (it.claimable && lock !== null && info.claimDate <= lock) throw new EngineError("period_locked", `The input tax on that expense was claimed on ${info.claimDate}, in a tax period that is locked (up to ${lock}); voiding it would change a filed return.`);
  return { expenseId: d.id, movementId: info.movementId, supplierId: info.supplierId, reason: input.reason.trim().replace(/\s+/g, " "), voidedOn: v.value };
}
