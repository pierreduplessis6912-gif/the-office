// Credit notes: how an INVOICE is credited. A credit note is a DOCUMENT of kind "credit_note" (a fact, never edited) that credits an invoice line by line, for a stated reason; it is applied to the invoice as a NON-CASH movement
// (method "credit", direction "in") up to what is still owed on it, and any excess stays as an unapplied credit on the customer. A credit_note.issued event ties the three facts together (the credit note, the movement, the
// invoice); what has been credited, applied and left over is DERIVED from those events, so nothing is updated and no schema changes (the same doctrine as parties.ts and quotations.ts). Best practice built in (docs/decisions/credit-notes.md):
// each credited line points at an invoice line and INHERITS its tax rate (never chosen again); a line can never be credited for more than it was worth, across all earlier credit notes; a reason is required; only an invoice can be credited.
// This file only READS and validates; facts.ts is the one write path, and the same rules serve the contract and the fact layer.
import type { Env } from "../types";
import { readConfig } from "./config";
import { EngineError } from "./errors";
import { documentTotals, isEffective, outstandingForDocument } from "./ledger";
import { documentTotals as sumLines, lineNetMinor, type Totals } from "./money";
import { checkDate } from "./quotations";

export interface CreditLineInput { invoiceLineNo: number; quantityMilli: number; unitPriceMinor: number }
export interface CreditLink { eventId: number; documentId: number; invoiceId: number; movementId: number; appliedMinor: number; unappliedMinor: number; reason: string; lines: CreditLineInput[] }
type Checked<T> = { ok: true; value: T } | { ok: false; reason: string };
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const whole = (v: unknown, min: number, max: number): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max;
const many = async <T>(env: Env, sql: string, ...binds: unknown[]): Promise<T[]> => ((await env.OFFICE_DB.prepare(sql).bind(...binds).all<T>()).results ?? []);
const parse = (s: string): Record<string, unknown> => { try { const v = JSON.parse(s); return isObj(v) ? v : {}; } catch { return {}; } };

// ---- validation (pure) -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------
export function checkReason(v: unknown): Checked<string> {
  if (typeof v !== "string" || !v.trim()) return { ok: false, reason: "a credit note needs a reason" };
  const r = v.trim().replace(/\s+/g, " ");
  return r.length > 200 ? { ok: false, reason: "reason must be at most 200 characters" } : { ok: true, value: r };
}
export function checkCreditLines(v: unknown): Checked<CreditLineInput[]> {
  if (!Array.isArray(v) || v.length === 0) return { ok: false, reason: "a credit note needs at least one line" };
  if (v.length > 100) return { ok: false, reason: "a credit note may have at most 100 lines" };
  const out: CreditLineInput[] = [];
  for (const [i, l] of v.entries()) {
    const at = `line ${i + 1}`;
    if (!isObj(l)) return { ok: false, reason: `${at} must be an object` };
    const stray = Object.keys(l).find((k) => !["invoiceLineNo", "quantityMilli", "unitPriceMinor"].includes(k));
    if (stray) return { ok: false, reason: `${at}: ${stray} is not a field of a credit line (the tax rate is taken from the invoice line, never chosen again)` };
    if (!whole(l.invoiceLineNo, 1, 100000)) return { ok: false, reason: `${at}: invoiceLineNo must be the number of a line on the invoice` };
    if (!whole(l.quantityMilli, 1, 1_000_000_000)) return { ok: false, reason: `${at}: quantityMilli must be a whole number of thousandths, at least 1` };
    if (!whole(l.unitPriceMinor, 0, 1_000_000_000_000)) return { ok: false, reason: `${at}: unitPriceMinor must be a whole number of cents, not negative` };
    out.push({ invoiceLineNo: l.invoiceLineNo, quantityMilli: l.quantityMilli, unitPriceMinor: l.unitPriceMinor });
  }
  if (new Set(out.map((l) => l.invoiceLineNo)).size !== out.length) return { ok: false, reason: "the same invoice line is credited twice; use one credit line per invoice line" };
  return { ok: true, value: out };
}

// ---- reading (derived) -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------
const toLink = (e: { id: number; payload_json: string }): CreditLink => {
  const p = parse(e.payload_json);
  return { eventId: e.id, documentId: Number(p.documentId), invoiceId: Number(p.invoiceId), movementId: Number(p.movementId), appliedMinor: Number(p.appliedMinor), unappliedMinor: Number(p.unappliedMinor), reason: typeof p.reason === "string" ? p.reason : "", lines: Array.isArray(p.lines) ? (p.lines as CreditLineInput[]) : [] };
};
export async function creditsOf(env: Env, invoiceId: number): Promise<CreditLink[]> {
  return (await many<{ id: number; payload_json: string }>(env, "SELECT id, payload_json FROM eng_event WHERE type = 'credit_note.issued' AND json_extract(payload_json, '$.invoiceId') = ? ORDER BY id", invoiceId)).map(toLink);
}
export async function creditOf(env: Env, creditNoteId: number): Promise<CreditLink | null> {
  const rows = await many<{ id: number; payload_json: string }>(env, "SELECT id, payload_json FROM eng_event WHERE type = 'credit_note.issued' AND json_extract(payload_json, '$.documentId') = ? ORDER BY id LIMIT 1", creditNoteId);
  return rows[0] ? toLink(rows[0]) : null;
}
export async function creditedGross(env: Env, invoiceId: number): Promise<number> {
  let sum = 0;
  for (const c of await creditsOf(env, invoiceId)) sum += (await documentTotals(env, c.documentId)).grossMinor;
  return sum;
}

// What a credit note would record, or why it cannot be issued: the one place the rules live (the fact layer and the contract both call it).
export async function planCreditNote(env: Env, input: { invoiceId: number; reason: unknown; issuedOn: unknown; lines: unknown }) {
  const inv = await env.OFFICE_DB.prepare("SELECT id, kind, direction, party_id, currency, issued_on FROM eng_document WHERE id = ?").bind(input.invoiceId).first<{ id: number; kind: string; direction: string; party_id: number; currency: string; issued_on: string }>();
  if (!inv) throw new EngineError("not_found", "There is no such invoice.");
  const cfg = await readConfig(env);
  if (inv.direction !== "sell" || !cfg.receivableKinds.includes(inv.kind)) throw new EngineError("invalid_state", "Only an invoice can be credited.");
  if (!(await isEffective(env, "document", inv.id))) throw new EngineError("invalid_state", "That invoice has been reversed, so it cannot be credited.");
  const reason = checkReason(input.reason); if (!reason.ok) throw new EngineError("invalid_input", reason.reason);
  const date = checkDate(input.issuedOn, "issue date"); if (!date.ok) throw new EngineError("invalid_input", date.reason);
  if (date.value < inv.issued_on) throw new EngineError("invalid_input", "A credit note cannot be dated before the invoice it credits.");
  const lines = checkCreditLines(input.lines); if (!lines.ok) throw new EngineError("invalid_input", lines.reason);
  const num = await env.OFFICE_DB.prepare("SELECT number FROM eng_document_number WHERE document_id = ?").bind(inv.id).first<{ number: number }>();
  const orig = await many<{ line_no: number; description: string; quantity_milli: number; unit: string | null; unit_price_minor: number; tax_bp: number }>(env, "SELECT line_no, description, quantity_milli, unit, unit_price_minor, tax_bp FROM eng_document_line WHERE document_id = ? ORDER BY line_no", inv.id);
  const before = new Map<number, number>();
  for (const c of await creditsOf(env, inv.id)) for (const l of c.lines) before.set(l.invoiceLineNo, (before.get(l.invoiceLineNo) ?? 0) + lineNetMinor(l.quantityMilli, l.unitPriceMinor));
  const docLines: Array<{ description: string; quantityMilli: number; unit: string | null; unitPriceMinor: number; taxBp: number }> = [];
  for (const l of lines.value) {
    const o = orig.find((x) => x.line_no === l.invoiceLineNo);
    if (!o) throw new EngineError("invalid_input", `The invoice has no line ${l.invoiceLineNo}.`);
    if (l.unitPriceMinor > o.unit_price_minor) throw new EngineError("invalid_input", `Line ${l.invoiceLineNo} was charged at ${o.unit_price_minor} a unit; a credit cannot be at a higher price.`);
    const net = lineNetMinor(l.quantityMilli, l.unitPriceMinor);
    if (net === 0) throw new EngineError("invalid_input", `Line ${l.invoiceLineNo}: that credits nothing.`);
    if ((before.get(l.invoiceLineNo) ?? 0) + net > lineNetMinor(o.quantity_milli, o.unit_price_minor)) throw new EngineError("invalid_state", `Line ${l.invoiceLineNo} cannot be credited for more than it was worth, counting the credit notes already issued.`);
    docLines.push({ description: `Credit: ${o.description}`.slice(0, 200), quantityMilli: l.quantityMilli, unit: o.unit, unitPriceMinor: l.unitPriceMinor, taxBp: o.tax_bp });
  }
  const totals: Totals = sumLines(docLines);
  const owed = await outstandingForDocument(env, inv.id);
  const appliedMinor = Math.min(totals.grossMinor, Math.max(0, owed));
  return { invoiceId: inv.id, invoiceNumber: num ? num.number : null, partyId: inv.party_id, currency: inv.currency, reason: reason.value, issuedOn: date.value, docLines, eventLines: lines.value, totals, appliedMinor, unappliedMinor: totals.grossMinor - appliedMinor };
}
