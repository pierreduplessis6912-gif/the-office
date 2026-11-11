// The business's own particulars and its tax period lock. A business profile (legal name, address, VAT registration, company registration number) and a TAX LOCK DATE are kept as events (business.profile.set and tax_lock.set),
// never as edited rows: the current profile is the earlier ones folded in order, and the lock is the latest date, so history is kept and no schema changes (the doctrine of parties.ts and quotations.ts). Research and decisions:
// docs/decisions/credit-note-follow-ups.md. Two rules matter most. (1) The tax lock only moves FORWARD, and invoices and credit notes must be dated AFTER it (Xero's behaviour, chosen over Odoo's silent re-dating because South African
// law dates a credit note's adjustment by its issue date and re-dating would falsify the document). (2) The completeness check FLAGS what a tax document still lacks (the vendor's name, address and VAT number; the recipient's address above
// R5,000); it never blocks issuing, and it is the gate for any future send. This file only READS and validates; facts.ts is the one write path.
import type { Env } from "../types";
import { EngineError } from "./errors";
import { creditOf } from "./credits";
import { documentTotals, isEffective } from "./ledger";
import { documentTotals as sumLines } from "./money";
import { partyProfile } from "./parties";
import { checkDate } from "./quotations";
import { allExpenses } from "./expenses";
import { allBills } from "./bills";

export interface BusinessProfile { legalName?: string; tradingName?: string; address?: string; vatRegistered?: boolean; vatNumber?: string; companyRegistrationNumber?: string }
export type ProfileChange = { [K in keyof BusinessProfile]?: BusinessProfile[K] | null };
type Checked<T> = { ok: true; value: T } | { ok: false; reason: string };
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const many = async <T>(env: Env, sql: string, ...binds: unknown[]): Promise<T[]> => ((await env.OFFICE_DB.prepare(sql).bind(...binds).all<T>()).results ?? []);
const parse = (s: string): Record<string, unknown> => { try { const v = JSON.parse(s); return isObj(v) ? v : {}; } catch { return {}; } };

export const PROFILE_FIELDS = ["legalName", "tradingName", "address", "vatRegistered", "vatNumber", "companyRegistrationNumber"] as const;
export const ABRIDGED_LIMIT_MINOR = 500000;   // R5,000.00 VAT-inclusive: above it a full tax document needs the recipient's details

// ---- validation (pure) -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------
const TEXT: Record<string, number> = { legalName: 120, tradingName: 120, address: 300 };
export function checkProfileChange(v: unknown): Checked<ProfileChange> {
  if (!isObj(v)) return { ok: false, reason: "the profile must be an object" };
  const stray = Object.keys(v).find((k) => !(PROFILE_FIELDS as readonly string[]).includes(k));
  if (stray) return { ok: false, reason: `${stray} is not a field of the business profile` };
  const out: ProfileChange = {};
  for (const k of PROFILE_FIELDS) {
    const x = v[k];
    if (x === undefined) continue;
    if (k === "vatRegistered") { if (typeof x !== "boolean") return { ok: false, reason: "vatRegistered must be true or false" }; out.vatRegistered = x; continue; }
    if (x === null) { (out as Record<string, unknown>)[k] = null; continue; }
    if (typeof x !== "string" || !x.trim()) return { ok: false, reason: `${k} must be text` };
    const t = x.trim().replace(/\s+/g, " ");
    if (k in TEXT && t.length > TEXT[k]) return { ok: false, reason: `${k} must be at most ${TEXT[k]} characters` };
    if (k === "vatNumber" && !/^4\d{9}$/.test(t)) return { ok: false, reason: "vatNumber must be 10 digits beginning with 4 (a South African VAT registration number)" };
    if (k === "companyRegistrationNumber" && !/^\d{4}\/\d{6}\/\d{2}$/.test(t)) return { ok: false, reason: "companyRegistrationNumber must look like 2019/123456/07" };
    (out as Record<string, unknown>)[k] = t;
  }
  if (Object.keys(out).length === 0) return { ok: false, reason: "say what to change in the business profile" };
  return { ok: true, value: out };
}
// What a change does to the current profile, or why it cannot: a business cannot be VAT registered without a VAT number.
export function applyProfile(current: BusinessProfile, change: ProfileChange): { ok: true; next: BusinessProfile } | { ok: false; reason: string } {
  const next: Record<string, unknown> = { ...current };
  for (const [k, v] of Object.entries(change)) { if (v === null) delete next[k]; else next[k] = v; }
  if (next.vatRegistered === true && !next.vatNumber) return { ok: false, reason: "A VAT registered business needs its VAT number." };
  return { ok: true, next: next as BusinessProfile };
}

// ---- reading (derived) -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------
export async function businessProfile(env: Env): Promise<BusinessProfile> {
  let p: BusinessProfile = {};
  for (const e of await many<{ payload_json: string }>(env, "SELECT payload_json FROM eng_event WHERE type = 'business.profile_set' ORDER BY id")) {
    const c = checkProfileChange(parse(e.payload_json));
    if (c.ok) { const a = applyProfile(p, c.value); if (a.ok) p = a.next; }
  }
  return p;
}
export async function taxLockDate(env: Env): Promise<string | null> {
  let lock: string | null = null;
  for (const e of await many<{ payload_json: string }>(env, "SELECT payload_json FROM eng_event WHERE type = 'tax_lock.set' ORDER BY id")) {
    const d = parse(e.payload_json).lockDate;
    if (typeof d === "string" && (lock === null || d > lock)) lock = d;
  }
  return lock;
}
// A tax document (an invoice or a credit note) must be dated AFTER the tax lock date; the message says which date to use.
export async function requireOpenTaxPeriod(env: Env, date: string, what = "A tax document"): Promise<void> {
  const lock = await taxLockDate(env);
  if (lock !== null && date <= lock) throw new EngineError("period_locked", `${what} cannot be dated ${date}: the tax period up to ${lock} is locked. Date it after ${lock}, in the open period.`);
}

const TAX_KINDS = ["invoice", "credit_note", "debit_note"];
export interface Particulars { applicable: boolean; complete: boolean; missing: string[]; advisory: string[] }
// What a tax document still lacks (VAT Act s20(4) and s21(3)(a)): flags only, never blocks. null if the document does not exist.
export async function documentParticulars(env: Env, documentId: number): Promise<Particulars | null> {
  const d = await env.OFFICE_DB.prepare("SELECT kind, direction, party_id FROM eng_document WHERE id = ?").bind(documentId).first<{ kind: string; direction: string; party_id: number }>();
  if (!d) return null;
  if (d.direction !== "sell" || !TAX_KINDS.includes(d.kind)) return { applicable: false, complete: true, missing: [], advisory: [] };
  const p = await businessProfile(env);
  const missing: string[] = [], advisory: string[] = [];
  if (!p.legalName) missing.push("vendor name");
  if (!p.address) missing.push("vendor address");
  if (p.vatRegistered === false) missing.push("vendor VAT registration");
  else if (!p.vatNumber) missing.push("vendor VAT number");
  // a credit note relates to the supply it credits: recipient particulars are needed when THAT supply exceeded R5,000
  let basis = (await documentTotals(env, documentId)).grossMinor;
  if (d.kind === "credit_note") { const c = await creditOf(env, documentId); if (c) basis = (await documentTotals(env, c.invoiceId)).grossMinor; }
  if (basis > ABRIDGED_LIMIT_MINOR) {
    const party = await partyProfile(env, d.party_id);
    if (!party || !party.contact.address) missing.push("recipient address");
    if (!party || !party.contact.vatNumber) advisory.push("recipient VAT number (required if the recipient is a VAT vendor; none on record)");
  }
  return { applicable: true, complete: missing.length === 0, missing, advisory };
}

export { checkDate };

// ---- the VAT period summary (OUTPUT side only) ------------------------------------------------------------------------------------------------------------------------------------------------------
// Follows the VAT201 (https://www.sars.gov.za/guide-to-completing-the-value-added-tax-vat201-return/ and docs/decisions/credit-note-follow-ups.md): field 1 is the value of standard-rated supplies INCLUDING VAT, credit notes issued in the
// period are offset against it, field 4 is output tax by the TAX FRACTION on field 1, and field 2 is zero-rated supplies. A document counts in the period of its own issue date. The input side needs purchases, which the engine does
// not have yet, so it says so. Exempt supplies are not told apart from zero-rated ones (both are 0%), and any rate that is neither 15% nor 0% is listed apart for the accountant instead of being guessed.
export const STANDARD_RATE_BP = 1500;
export interface VatSummary {
  period: { from: string; to: string }; locked: boolean; lockDate: string | null; standardRateBp: number;
  field1Minor: number; field4Minor: number; taxPerDocumentsMinor: number; differenceMinor: number; field2Minor: number;
  otherRates: Array<{ taxBp: number; netMinor: number; taxMinor: number }>;
  documents: Array<{ ref: { kind: "document"; id: number }; kind: string; number: number | null; issuedOn: string; sign: 1 | -1; netMinor: number; taxMinor: number; grossMinor: number; complete: boolean }>;
  incompleteDocuments: number; outputOnly: boolean; field14Minor: number; field15Minor: number; inputTaxMinor: number; netVatMinor: number;
  inputExcluded: Array<{ ref: { kind: "document"; id: number }; number: number | null; taxMinor: number; reasons: string[] }>; notes: string[];
}
export async function vatSummary(env: Env, period: { from: string; to: string }): Promise<VatSummary> {
  const docs = await many<{ id: number; kind: string; issued_on: string; number: number | null }>(env,
    "SELECT d.id, d.kind, d.issued_on, n.number AS number FROM eng_document d LEFT JOIN eng_document_number n ON n.document_id = d.id WHERE d.direction = 'sell' AND d.kind IN ('invoice', 'credit_note', 'debit_note') AND d.issued_on >= ? AND d.issued_on <= ? ORDER BY d.issued_on, d.id", period.from, period.to);
  let std = 0, zero = 0, stdTax = 0, incomplete = 0;
  const other = new Map<number, { netMinor: number; taxMinor: number }>();
  const out: VatSummary["documents"] = [];
  for (const d of docs) {
    if (!(await isEffective(env, "document", d.id))) continue;     // a voided credit note, or a reversed invoice, no longer counts
    const sign: 1 | -1 = d.kind === "credit_note" ? -1 : 1;
    const lines = await many<{ description: string; quantity_milli: number; unit: string | null; unit_price_minor: number; tax_bp: number }>(env, "SELECT description, quantity_milli, unit, unit_price_minor, tax_bp FROM eng_document_line WHERE document_id = ? ORDER BY line_no", d.id);
    for (const l of lines) {
      const t = sumLines([{ quantityMilli: l.quantity_milli, unitPriceMinor: l.unit_price_minor, taxBp: l.tax_bp }]);
      if (l.tax_bp === STANDARD_RATE_BP) { std += sign * t.grossMinor; stdTax += sign * t.taxMinor; }
      else if (l.tax_bp === 0) zero += sign * t.netMinor;
      else { const o = other.get(l.tax_bp) ?? { netMinor: 0, taxMinor: 0 }; o.netMinor += sign * t.netMinor; o.taxMinor += sign * t.taxMinor; other.set(l.tax_bp, o); }
    }
    const totals = await documentTotals(env, d.id);
    const p = await documentParticulars(env, d.id);
    if (p && p.applicable && !p.complete) incomplete++;
    out.push({ ref: { kind: "document", id: d.id }, kind: d.kind, number: d.number, issuedOn: d.issued_on, sign, netMinor: sign * totals.netMinor, taxMinor: sign * totals.taxMinor, grossMinor: sign * totals.grossMinor, complete: !p || !p.applicable || p.complete });
  }
  // the input side: recorded expenses whose VAT CLAIM DATE falls in the period (fixed when each was recorded): capital goods are field 14, everything else field 15; expenses with tax that cannot be claimed are listed with their reasons
  let f14 = 0, f15 = 0; const excluded: VatSummary["inputExcluded"] = [];
  for (const x of await allExpenses(env, { status: "recorded" })) {
    if (x.claimDate < period.from || x.claimDate > period.to) continue;
    if (x.inputTaxClaimable) { if (x.capital) f14 += x.inputTaxMinor; else f15 += x.inputTaxMinor; }
    else if (x.taxMinor > 0) excluded.push({ ref: x.ref, number: x.number, taxMinor: x.taxMinor, reasons: x.inputTaxReasons });
  }
  for (const b of await allBills(env, { status: "any" })) {
    if (b.status === "voided" || b.claimDate < period.from || b.claimDate > period.to) continue;
    if (b.inputTaxClaimable) { if (b.capital) f14 += b.inputTaxMinor; else f15 += b.inputTaxMinor; }
    else if (b.taxMinor > 0) excluded.push({ ref: b.ref, number: b.number, taxMinor: b.taxMinor, reasons: b.inputTaxReasons });
  }
  const field4 = Math.round(std * STANDARD_RATE_BP / (10000 + STANDARD_RATE_BP));   // the tax fraction: r / (100 + r)
  const lock = await taxLockDate(env);
  return {
    period, locked: lock !== null && period.to <= lock, lockDate: lock, standardRateBp: STANDARD_RATE_BP,
    field1Minor: std, field4Minor: field4, taxPerDocumentsMinor: stdTax, differenceMinor: field4 - stdTax, field2Minor: zero,
    otherRates: [...other.entries()].sort((a, b) => a[0] - b[0]).map(([taxBp, v]) => ({ taxBp, ...v })),
    documents: out.slice(0, 200), incompleteDocuments: incomplete, outputOnly: false, field14Minor: f14, field15Minor: f15, inputTaxMinor: f14 + f15, netVatMinor: field4 - (f14 + f15), inputExcluded: excluded,
    notes: [
      "Input tax covers recorded EXPENSES and supplier BILLS (fields 14 and 15, claimed on the date fixed when each was recorded): imported services (field 16), supplier credit notes and adjustments are not in it yet, so this is still not a complete VAT201.",
      "Exempt supplies are not told apart from zero-rated ones (both are 0%): all 0% lines are shown as zero-rated, and an accountant must classify them.",
      "A document counts in the period of its own issue date (time-of-supply rules are not applied); credit notes reduce the period they are issued in.",
      "Field 4 is output tax by the tax fraction on field 1; the difference from the sum of per-document tax is per-line rounding and is shown, not hidden.",
    ],
  };
}
