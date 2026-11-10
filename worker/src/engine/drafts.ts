// A DRAFT is a working copy, the one mutable thing in a document's life, and it is not a business fact. It can be saved incomplete, is validated on EVERY save (the totals are recalculated by the engine, never
// supplied), and carries a version so nobody overwrites what they have not seen. ISSUING it is an operation: the draft is validated strictly, the immutable document is created (and numbered) through the one
// write path, and the draft is closed, all as one transaction. After that the document changes only through corrections.
import { requireOpenTaxPeriod } from "./business";
import type { Env } from "../types";
import { atomically } from "../atomic";
import { EngineError } from "./errors";
import { documentTotals, wholeNumber, type Totals } from "./money";
import { recordDocument, type Ctx } from "./facts";

export interface DraftLine { description?: unknown; quantityMilli?: unknown; unit?: unknown; unitPriceMinor?: unknown; taxBp?: unknown }
export interface DraftPayload { currency?: unknown; issuedOn?: unknown; reference?: unknown; terms?: unknown; lines?: unknown }
export interface DraftValidation { ok: boolean; errors: Array<{ field: string; message: string }>; totals: Totals | null }

const one = <T>(env: Env, sql: string, ...binds: unknown[]) => env.OFFICE_DB.prepare(sql).bind(...binds).first<T>();
async function inTransaction<T>(env: Env, body: (env: Env) => Promise<T>): Promise<T> {
  if ((env as unknown as { __atomic?: boolean }).__atomic) return body(env);
  return atomically(env, body);
}
const isDate = (v: unknown): boolean => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && new Date(v + "T00:00:00Z").toISOString().slice(0, 10) === v;

// Pure: what is wrong with a draft, field by field, and its total when every line is sound.
export function validateDraft(partyId: number | null, payload: DraftPayload): DraftValidation {
  const errors: Array<{ field: string; message: string }> = [];
  if (partyId === null) errors.push({ field: "partyId", message: "choose the customer or supplier" });
  if (typeof payload.currency !== "string" || !/^[A-Z]{3}$/.test(payload.currency)) errors.push({ field: "currency", message: "a 3-letter currency such as ZAR is needed" });
  if (!isDate(payload.issuedOn)) errors.push({ field: "issuedOn", message: "an issue date is needed" });
  const raw = Array.isArray(payload.lines) ? (payload.lines as DraftLine[]) : [];
  if (raw.length === 0) errors.push({ field: "lines", message: "add at least one line" });
  const sound: Array<{ quantityMilli: number; unitPriceMinor: number; taxBp: number }> = [];
  raw.forEach((l, i) => {
    let bad = false;
    const need = (ok: boolean, field: string, message: string) => { if (!ok) { errors.push({ field: `lines[${i}].${field}`, message }); bad = true; } };
    need(typeof l.description === "string" && l.description.trim().length > 0, "description", "describe the line");
    const whole = (v: unknown, min: number, max?: number) => { try { wholeNumber(v, "x", min, max); return true; } catch { return false; } };
    need(whole(l.quantityMilli, 1), "quantityMilli", "a whole number of thousandths, at least 1");
    need(whole(l.unitPriceMinor, 0), "unitPriceMinor", "a whole number of cents, not negative");
    need(whole(l.taxBp, 0, 10000), "taxBp", "a rate from 0 to 10,000 basis points");
    if (!bad) sound.push({ quantityMilli: l.quantityMilli as number, unitPriceMinor: l.unitPriceMinor as number, taxBp: l.taxBp as number });
  });
  let totals: Totals | null = null;
  if (raw.length > 0 && sound.length === raw.length) {
    try { totals = documentTotals(sound); } catch (e) { errors.push({ field: "lines", message: e instanceof EngineError ? e.message : "the total cannot be held exactly" }); }
  }
  return { ok: errors.length === 0, errors, totals };
}

interface DraftRow { id: number; kind: string; direction: string; party_id: number | null; payload_json: string; version: number; issued_document_id: number | null }
const load = (env: Env, id: number) => one<DraftRow>(env, "SELECT id, kind, direction, party_id, payload_json, version, issued_document_id FROM eng_draft WHERE id = ?", id);
const parse = (json: string): DraftPayload => { try { const v = JSON.parse(json); return v && typeof v === "object" ? v : {}; } catch { return {}; } };

export async function createDraft(env: Env, input: { kind: string; direction: string; partyId?: number | null }, _ctx: Ctx): Promise<{ id: number; version: number }> {
  if (!input.kind || typeof input.kind !== "string" || !["sell", "buy"].includes(input.direction)) throw new EngineError("invalid_input", "a draft needs a kind and a direction (sell or buy)");
  const row = await one<{ id: number }>(env, "INSERT INTO eng_draft (kind, direction, party_id, payload_json, created_by) VALUES (?, ?, ?, ?, ?) RETURNING id", input.kind, input.direction, input.partyId ?? null, JSON.stringify({ lines: [] }), _ctx.actorEmail ?? null);
  return { id: Number(row!.id), version: 1 };
}

export async function readDraft(env: Env, id: number): Promise<{ id: number; kind: string; direction: string; partyId: number | null; payload: DraftPayload; version: number; issuedDocumentId: number | null; validation: DraftValidation }> {
  const d = await load(env, id);
  if (!d) throw new EngineError("not_found", "there is no such draft");
  const payload = parse(d.payload_json);
  return { id: d.id, kind: d.kind, direction: d.direction, partyId: d.party_id, payload, version: d.version, issuedDocumentId: d.issued_document_id, validation: validateDraft(d.party_id, payload) };
}

export async function saveDraft(env: Env, id: number, input: { expectedVersion: number; partyId?: number | null; payload: DraftPayload }, _ctx: Ctx): Promise<{ version: number; validation: DraftValidation }> {
  wholeNumber(input.expectedVersion, "version", 1);
  return inTransaction(env, async (tx) => {
    const d = await load(tx, id);
    if (!d) throw new EngineError("not_found", "there is no such draft");
    if (d.issued_document_id !== null) throw new EngineError("invalid_state", "that draft has been issued and is closed");
    if (d.version !== input.expectedVersion) throw new EngineError("stale", "that draft changed since it was opened");
    const partyId = input.partyId === undefined ? d.party_id : input.partyId;
    await tx.OFFICE_DB.prepare("UPDATE eng_draft SET party_id = ?, payload_json = ?, version = version + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").bind(partyId, JSON.stringify(input.payload), id).run();
    return { version: d.version + 1, validation: validateDraft(partyId, input.payload) };
  });
}

// Issue a draft: validated strictly, the document created through the one write path and numbered, the draft closed. One transaction.
export async function issueDraft(env: Env, id: number, input: { expectedVersion: number }, ctx: Ctx): Promise<{ documentId: number; number: number; eventId: number; totals: Totals }> {
  wholeNumber(input.expectedVersion, "version", 1);
  return inTransaction(env, async (tx) => {
    const d = await load(tx, id);
    if (!d) throw new EngineError("not_found", "there is no such draft");
    if (d.issued_document_id !== null) throw new EngineError("invalid_state", "that draft has already been issued");
    if (d.version !== input.expectedVersion) throw new EngineError("stale", "that draft changed since it was opened");
    const payload = parse(d.payload_json);
    const v = validateDraft(d.party_id, payload);
    if (v.ok && typeof payload.issuedOn === "string") await requireOpenTaxPeriod(tx, payload.issuedOn, "An invoice");   // the tax lock: invoices must be dated in the open period
    if (!v.ok) throw new EngineError("invalid_state", "the draft is not ready: " + v.errors.map((e) => `${e.field} ${e.message}`).join("; "));
    const lines = (payload.lines as DraftLine[]).map((l) => ({ description: String(l.description), quantityMilli: l.quantityMilli as number, unit: typeof l.unit === "string" ? l.unit : null, unitPriceMinor: l.unitPriceMinor as number, taxBp: l.taxBp as number }));
    const doc = await recordDocument(tx, { kind: d.kind, direction: d.direction, partyId: d.party_id as number, currency: payload.currency as string, reference: typeof payload.reference === "string" ? payload.reference : null, issuedOn: payload.issuedOn as string, terms: (payload.terms && typeof payload.terms === "object" ? payload.terms : {}) as Record<string, unknown>, lines }, ctx);
    await tx.OFFICE_DB.prepare("UPDATE eng_draft SET issued_document_id = ?, version = version + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").bind(doc.id, id).run();
    return { documentId: doc.id, number: doc.number, eventId: doc.eventId, totals: doc.totals };
  });
}
