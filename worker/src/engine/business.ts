// The business's own particulars and its tax period lock. A business profile (legal name, address, VAT registration, company registration number) and a TAX LOCK DATE are kept as events (business.profile.set and tax_lock.set),
// never as edited rows: the current profile is the earlier ones folded in order, and the lock is the latest date, so history is kept and no schema changes (the doctrine of parties.ts and quotations.ts). Research and decisions:
// docs/decisions/credit-note-follow-ups.md. Two rules matter most. (1) The tax lock only moves FORWARD, and invoices and credit notes must be dated AFTER it (Xero's behaviour, chosen over Odoo's silent re-dating because South African
// law dates a credit note's adjustment by its issue date and re-dating would falsify the document). (2) The completeness check FLAGS what a tax document still lacks (the vendor's name, address and VAT number; the recipient's address above
// R5,000); it never blocks issuing, and it is the gate for any future send. This file only READS and validates; facts.ts is the one write path.
import type { Env } from "../types";
import { EngineError } from "./errors";
import { creditOf } from "./credits";
import { documentTotals } from "./ledger";
import { partyProfile } from "./parties";
import { checkDate } from "./quotations";

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
