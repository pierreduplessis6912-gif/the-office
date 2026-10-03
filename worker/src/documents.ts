// Document-first identification for uploads (2026-10-03).
//
// A supplier document says what it is and who issued it, so an upload no
// longer needs a typed caption to be understood. This file is the thin glue:
// the AI reads the printed kind and issuer (ai.ts), and plain code decides
// whether that issuer is a supplier we already have (identity.ts). Nothing
// here writes anything. The caller treats the result as a CLAIM: a matched
// supplier is acted on only through confirmation, never recorded directly, and
// a document that matches nothing is simply stored with an honest explanation.
import type { Env } from "./types";
import { DocumentKind, extractDocumentIdentity } from "./ai";
import { IssuerMatch, SupplierCandidate, matchIssuerToSuppliers } from "./identity";

export const DOCUMENT_KIND_LABEL: Record<Exclude<DocumentKind, "other">, string> = {
  delivery_note: "a delivery note",
  supplier_invoice: "a supplier invoice",
  supplier_statement: "a supplier statement",
};

// A supplier is a character we have ordered from (a purchase order names them)
// or one explicitly filed as a supplier. Merged duplicates are excluded.
export async function getSupplierCandidates(env: Env): Promise<SupplierCandidate[]> {
  const { results } = await env.OFFICE_DB.prepare(
    `SELECT ch.id AS id, ch.name AS name
       FROM characters ch
      WHERE ch.merged_into_character_id IS NULL
        AND (LOWER(COALESCE(ch.relationship, '')) LIKE '%supplier%'
             OR EXISTS (SELECT 1 FROM purchase_orders po WHERE po.supplier_id = ch.id))`
  ).all<SupplierCandidate>();
  return results ?? [];
}

export interface InferredDocument {
  kind: DocumentKind;
  issuer: string | null;
  match: IssuerMatch | null;
}

export async function inferDocumentSupplier(env: Env, documentText: string): Promise<InferredDocument> {
  const identity = await extractDocumentIdentity(env, documentText);
  if (identity.document_type === "other") return { kind: "other", issuer: null, match: null };
  if (!identity.issuer_name) return { kind: identity.document_type, issuer: null, match: null };
  const suppliers = await getSupplierCandidates(env);
  return { kind: identity.document_type, issuer: identity.issuer_name, match: matchIssuerToSuppliers(suppliers, identity.issuer_name) };
}

// ---------------------------------------------------------------------------
// Delivery planning (decided 2026-10-03, Pierre): a delivery note for items
// that were never ordered is RECEIVED and reported as an exception, not
// refused. These two functions are pure, so every branch of the decision is
// tested without a database or a model; the three callers (document upload,
// photo upload, spoken) only execute the plan.
// ---------------------------------------------------------------------------
export interface DeliveryPlan<T> {
  action: "refuse" | "hold" | "record" | "none";
  lines: T[];
  matchedCount: number;
  exceptionCount: number;
}

// mustHold — the supplier was read or heard rather than stated with a typed
//            caption, so the delivery is held for one-tap confirmation
//            instead of being recorded directly (a spoken delivery always is).
// refused  — the caller may not record deliveries.
export function planDelivery<T>(
  classified: { matched: T[]; exceptions: T[] },
  opts: { mustHold: boolean; refused: boolean }
): DeliveryPlan<T> {
  const lines = [...classified.matched, ...classified.exceptions];
  const base = { lines, matchedCount: classified.matched.length, exceptionCount: classified.exceptions.length };
  if (lines.length === 0) return { ...base, action: "none" };
  if (opts.refused) return { ...base, action: "refuse" };
  return { ...base, action: opts.mustHold ? "hold" : "record" };
}

export function deliveryHeldMessage(
  plan: { matchedCount: number; exceptionCount: number },
  supplier: string,
  readFromDocument: boolean,
  actionId: number,
  hadOpenOrder: boolean
): string {
  const how = readFromDocument ? " (read from the document)" : "";
  const exceptions =
    plan.exceptionCount > 0 && plan.matchedCount > 0
      ? ` ${plan.exceptionCount} item(s) aren't on the order and will be logged as delivery exceptions.`
      : "";
  if (plan.matchedCount > 0) {
    return `Delivery noted from ${supplier}${how} — needs your confirmation (action #${actionId}) before it's recorded.${exceptions}`;
  }
  if (hadOpenOrder) {
    return `Delivery from ${supplier}${how} has nothing that's on their open order — needs your confirmation (action #${actionId}) to log it as a delivery exception.`;
  }
  return `Delivery from ${supplier}${how}: they have no open order, so it will be logged as a delivery exception once you confirm (action #${actionId}).`;
}

// What is said back once a delivery has been recorded (decided 2026-10-03): which notes were created and,
// in words, every way it differed from what was outstanding. Anything that differed is also on the
// delivery exception report.
export function deliveryRecordedMessage(r: { grnIds: number[]; exceptions: unknown[]; shortCount: number; overCount: number }): string {
  const ids = r.grnIds.map((i) => `#${i}`).join(", ");
  let msg = r.grnIds.length === 0 ? "Delivery recorded." : `Delivery recorded (GRN${r.grnIds.length > 1 ? "s" : ""} ${ids}).`;
  if (r.exceptions.length > 0) msg += ` ${r.exceptions.length} item(s) weren't on any order and were logged as delivery exceptions.`;
  if (r.shortCount > 0) msg += ` ${r.shortCount} item(s) came in short and were logged as delivery exceptions.`;
  if (r.overCount > 0) msg += ` ${r.overCount} item(s) came in over what was outstanding and were logged as delivery exceptions.`;
  return msg;
}

// True when a recorded delivery differed from the order in any way worth telling the person about.
export function deliveryHadExceptions(r: { exceptions: unknown[]; shortCount: number; overCount: number }): boolean {
  return r.exceptions.length + r.shortCount + r.overCount > 0;
}
