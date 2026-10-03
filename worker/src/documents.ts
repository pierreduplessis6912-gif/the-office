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
