// Quotations: what a quotation IS NOW. A quotation is a DOCUMENT of kind "quotation" (a fact, never edited). A revision is a NEW document plus a quotation.revised event saying which one it replaces; acceptance is a
// quotation.accepted event about the current revision. Whether a quotation is open, accepted or superseded is DERIVED here from those events, never stored, so nothing is updated and no schema changes (the same doctrine as
// parties.ts). This file only READS and validates; facts.ts is the one write path. The rules (what a valid line, date or reference is, and what a revision or an acceptance may do) serve the contracts and the fact layer
// alike, so they cannot disagree. VAT is never assumed: every line must carry its own explicit tax rate.
import type { Env } from "../types";
import { EngineError } from "./errors";
import { documentTotals } from "./ledger";

export interface QuoteLine { description: string; quantityMilli: number; unit: string | null; unitPriceMinor: number; taxBp: number }
export type QuotationStatus = "open" | "accepted" | "superseded";
export interface QuotationSummary {
  id: number; number: number | null; partyId: number; currency: string; issuedOn: string; validUntil: string | null; reference: string | null;
  netMinor: number; taxMinor: number; grossMinor: number; status: QuotationStatus; supersedes: number | null; supersededBy: number | null;
}

type Checked<T> = { ok: true; value: T } | { ok: false; reason: string };
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const whole = (v: unknown, min: number, max: number): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max;
const many = async <T>(env: Env, sql: string, ...binds: unknown[]): Promise<T[]> => ((await env.OFFICE_DB.prepare(sql).bind(...binds).all<T>()).results ?? []);

// ---- validation (pure) -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------
export function checkDate(v: unknown, label: string): Checked<string> {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return { ok: false, reason: `${label} must be a calendar date (YYYY-MM-DD)` };
  const d = new Date(v + "T00:00:00Z");
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v ? { ok: false, reason: `${label} is not a real calendar date` } : { ok: true, value: v };
}
export function checkReference(v: unknown): Checked<string> {
  if (typeof v !== "string" || !v.trim()) return { ok: false, reason: "reference must be text" };
  const r = v.trim().replace(/\s+/g, " ");
  return r.length > 120 ? { ok: false, reason: "reference must be at most 120 characters" } : { ok: true, value: r };
}
export function checkLines(v: unknown): Checked<QuoteLine[]> {
  if (!Array.isArray(v) || v.length === 0) return { ok: false, reason: "a quotation needs at least one line" };
  if (v.length > 100) return { ok: false, reason: "a quotation may have at most 100 lines" };
  const out: QuoteLine[] = [];
  for (const [i, l] of v.entries()) {
    const at = `line ${i + 1}`;
    if (!isObj(l)) return { ok: false, reason: `${at} must be an object` };
    const stray = Object.keys(l).find((k) => !["description", "quantityMilli", "unit", "unitPriceMinor", "taxBp"].includes(k));
    if (stray) return { ok: false, reason: `${at}: ${stray} is not a field of a line` };
    if (typeof l.description !== "string" || !l.description.trim() || l.description.trim().length > 200) return { ok: false, reason: `${at}: description must be 1 to 200 characters` };
    if (!whole(l.quantityMilli, 1, 1_000_000_000)) return { ok: false, reason: `${at}: quantityMilli must be a whole number of thousandths, at least 1` };
    if (!whole(l.unitPriceMinor, 0, 1_000_000_000_000)) return { ok: false, reason: `${at}: unitPriceMinor must be a whole number of cents, not negative` };
    if (!whole(l.taxBp, 0, 10000)) return { ok: false, reason: `${at}: taxBp is required: the tax rate in basis points, 0 to 10000 (VAT is never assumed)` };
    if (l.unit !== undefined && l.unit !== null && (typeof l.unit !== "string" || l.unit.length > 20)) return { ok: false, reason: `${at}: unit must be at most 20 characters` };
    out.push({ description: l.description.trim(), quantityMilli: l.quantityMilli, unit: (l.unit as string | null | undefined) ?? null, unitPriceMinor: l.unitPriceMinor, taxBp: l.taxBp });
  }
  return { ok: true, value: out };
}

// ---- reading (derived) -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------
const parse = (s: string): Record<string, unknown> => { try { const v = JSON.parse(s); return isObj(v) ? v : {}; } catch { return {}; } };

export async function allQuotations(env: Env, filter: { partyId?: number } = {}): Promise<QuotationSummary[]> {
  const docs = await many<{ id: number; party_id: number; currency: string; issued_on: string; reference: string | null; terms_json: string; number: number | null }>(env,
    "SELECT d.id, d.party_id, d.currency, d.issued_on, d.reference, d.terms_json, n.number AS number FROM eng_document d LEFT JOIN eng_document_number n ON n.document_id = d.id WHERE d.kind = 'quotation' ORDER BY d.id");
  const revised = (await many<{ payload_json: string }>(env, "SELECT payload_json FROM eng_event WHERE type = 'quotation.revised' ORDER BY id")).map((e) => parse(e.payload_json));
  const accepted = new Set((await many<{ payload_json: string }>(env, "SELECT payload_json FROM eng_event WHERE type = 'quotation.accepted'")).map((e) => Number(parse(e.payload_json).documentId)));
  const out: QuotationSummary[] = [];
  for (const d of docs) {
    if (filter.partyId !== undefined && d.party_id !== filter.partyId) continue;
    const by = revised.find((r) => Number(r.supersedes) === d.id);
    const from = revised.find((r) => Number(r.documentId) === d.id);
    const t = await documentTotals(env, d.id);
    const vu = parse(d.terms_json).validUntil;
    out.push({ id: d.id, number: d.number, partyId: d.party_id, currency: d.currency, issuedOn: d.issued_on, validUntil: typeof vu === "string" ? vu : null, reference: d.reference, netMinor: t.netMinor, taxMinor: t.taxMinor, grossMinor: t.grossMinor,
      status: by ? "superseded" : accepted.has(d.id) ? "accepted" : "open", supersedes: from ? Number(from.supersedes) : null, supersededBy: by ? Number(by.documentId) : null });
  }
  return out;
}

export async function quotationSummary(env: Env, id: number): Promise<QuotationSummary | null> {
  return (await allQuotations(env)).find((q) => q.id === id) ?? null;
}
export async function quotationLines(env: Env, id: number): Promise<QuoteLine[]> {
  return (await many<{ description: string; quantity_milli: number; unit: string | null; unit_price_minor: number; tax_bp: number }>(env, "SELECT description, quantity_milli, unit, unit_price_minor, tax_bp FROM eng_document_line WHERE document_id = ? ORDER BY line_no", id))
    .map((l) => ({ description: l.description, quantityMilli: l.quantity_milli, unit: l.unit, unitPriceMinor: l.unit_price_minor, taxBp: l.tax_bp }));
}
// The event ids that belong to a quotation's own story (its revisions and its acceptance), for the record's history.
export async function quotationEventIds(env: Env, id: number): Promise<number[]> {
  const rows = await many<{ id: number; payload_json: string }>(env, "SELECT id, payload_json FROM eng_event WHERE type IN ('quotation.revised', 'quotation.accepted') ORDER BY id");
  return rows.filter((e) => { const p = parse(e.payload_json); return Number(p.documentId) === id || Number(p.supersedes) === id; }).map((e) => e.id);
}

async function requireQuotation(env: Env, id: number): Promise<QuotationSummary> {
  const doc = await env.OFFICE_DB.prepare("SELECT kind FROM eng_document WHERE id = ?").bind(id).first<{ kind: string }>();
  if (!doc) throw new EngineError("not_found", "There is no such quotation.");
  if (doc.kind !== "quotation") throw new EngineError("invalid_state", "That document is not a quotation.");
  return (await quotationSummary(env, id))!;
}

// What a revision would record, or why it cannot be made: the one place the rules live (the fact layer and the contract both call it).
export async function planQuotationRevision(env: Env, input: { quotationId: number; lines?: unknown; validUntil?: string | null; reference?: string | null; issuedOn?: string }) {
  const old = await requireQuotation(env, input.quotationId);
  if (old.status === "superseded") throw new EngineError("invalid_state", "That quotation has already been replaced; revise the current one.");
  if (old.status === "accepted") throw new EngineError("invalid_state", "That quotation has been accepted and is final; make a new quotation instead.");
  const doc = (await env.OFFICE_DB.prepare("SELECT direction FROM eng_document WHERE id = ?").bind(old.id).first<{ direction: string }>())!;
  let lines = await quotationLines(env, old.id);
  if (input.lines !== undefined) { const c = checkLines(input.lines); if (!c.ok) throw new EngineError("invalid_input", c.reason); lines = c.value; }
  const issuedOn = input.issuedOn !== undefined ? (() => { const c = checkDate(input.issuedOn, "issue date"); if (!c.ok) throw new EngineError("invalid_input", c.reason); return c.value; })() : old.issuedOn;
  const validUntil = input.validUntil === undefined ? old.validUntil : input.validUntil === null ? null : (() => { const c = checkDate(input.validUntil, "validUntil"); if (!c.ok) throw new EngineError("invalid_input", c.reason); return c.value; })();
  const reference = input.reference === undefined ? old.reference : input.reference === null ? null : (() => { const c = checkReference(input.reference); if (!c.ok) throw new EngineError("invalid_input", c.reason); return c.value; })();
  if (validUntil !== null && validUntil < issuedOn) throw new EngineError("invalid_input", "validUntil cannot be before the issue date.");
  const same = JSON.stringify([lines, validUntil, reference, issuedOn]) === JSON.stringify([await quotationLines(env, old.id), old.validUntil, old.reference, old.issuedOn]);
  if (same) throw new EngineError("invalid_input", "That would change nothing.");
  return { old, direction: doc.direction, lines, validUntil, reference, issuedOn };
}

export async function planQuotationAcceptance(env: Env, quotationId: number): Promise<QuotationSummary> {
  const q = await requireQuotation(env, quotationId);
  if (q.status === "superseded") throw new EngineError("invalid_state", "That quotation has been replaced; accept the current one.");
  if (q.status === "accepted") throw new EngineError("invalid_state", "That quotation has already been accepted.");
  return q;
}
