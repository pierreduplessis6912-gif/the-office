// What is true now, DERIVED from the recorded facts in ONE place. A fact is EFFECTIVE unless it has been reversed (eng_reversal), and what hangs off a reversed fact is not effective either: an allocation
// is effective only while it, its payment and its document all are. Every screen, answer, report and export reads these functions; none computes a balance of its own, so they cannot disagree.
import type { Env } from "../types";
import { documentTotals as sumTotals, type Totals } from "./money";
import { readConfig } from "./config";

const one = <T>(env: Env, sql: string, ...binds: unknown[]) => env.OFFICE_DB.prepare(sql).bind(...binds).first<T>();
const many = async <T>(env: Env, sql: string, ...binds: unknown[]): Promise<T[]> => ((await env.OFFICE_DB.prepare(sql).bind(...binds).all<T>()).results ?? []);

export type EffectiveKind = "movement" | "allocation" | "document";

export async function isEffective(env: Env, kind: EffectiveKind, id: number): Promise<boolean> {
  const sql = kind === "movement"
    ? "SELECT 1 AS ok FROM eng_money_movement m WHERE m.id = ? AND NOT EXISTS (SELECT 1 FROM eng_reversal r WHERE r.movement_id = m.id)"
    : kind === "document"
      ? "SELECT 1 AS ok FROM eng_document d WHERE d.id = ? AND NOT EXISTS (SELECT 1 FROM eng_reversal r WHERE r.document_id = d.id)"
      : `SELECT 1 AS ok FROM eng_allocation a WHERE a.id = ?
           AND NOT EXISTS (SELECT 1 FROM eng_reversal r WHERE r.allocation_id = a.id)
           AND NOT EXISTS (SELECT 1 FROM eng_reversal r WHERE r.movement_id = a.movement_id)
           AND NOT EXISTS (SELECT 1 FROM eng_reversal r WHERE r.document_id = a.document_id)`;
  return Boolean(await one<{ ok: number }>(env, sql, id));
}

// A document's total, from its lines (the lines are the only place an amount lives).
export async function documentTotals(env: Env, documentId: number): Promise<Totals> {
  const lines = await many<{ quantity_milli: number; unit_price_minor: number; tax_bp: number }>(env, "SELECT quantity_milli, unit_price_minor, tax_bp FROM eng_document_line WHERE document_id = ? ORDER BY line_no", documentId);
  return sumTotals(lines.map((l) => ({ quantityMilli: l.quantity_milli, unitPriceMinor: l.unit_price_minor, taxBp: l.tax_bp })));
}

// What has been allocated to a document by allocations that are effective.
export async function allocatedToDocument(env: Env, documentId: number): Promise<number> {
  const row = await one<{ n: number }>(env,
    `SELECT COALESCE(SUM(a.amount_minor), 0) AS n FROM eng_allocation a WHERE a.document_id = ?
       AND NOT EXISTS (SELECT 1 FROM eng_reversal r WHERE r.allocation_id = a.id)
       AND NOT EXISTS (SELECT 1 FROM eng_reversal r WHERE r.movement_id = a.movement_id)`, documentId);
  return Number(row?.n ?? 0);
}

// What a document still owes. A document that has been reversed owes nothing.
export async function outstandingForDocument(env: Env, documentId: number): Promise<number> {
  if (!(await isEffective(env, "document", documentId))) return 0;
  const totals = await documentTotals(env, documentId);
  return totals.grossMinor - (await allocatedToDocument(env, documentId));
}

// What a payment still has to allocate. A payment that has been reversed has nothing.
export async function unallocatedForMovement(env: Env, movementId: number): Promise<number> {
  const m = await one<{ amount_minor: number }>(env, "SELECT amount_minor FROM eng_money_movement WHERE id = ?", movementId);
  if (!m || !(await isEffective(env, "movement", movementId))) return 0;
  const used = await one<{ n: number }>(env, "SELECT COALESCE(SUM(a.amount_minor), 0) AS n FROM eng_allocation a WHERE a.movement_id = ? AND NOT EXISTS (SELECT 1 FROM eng_reversal r WHERE r.allocation_id = a.id)", movementId);
  return m.amount_minor - Number(used?.n ?? 0);
}

export interface AccountLine { id: number; number: number | null; kind: string; issuedOn: string; grossMinor: number; allocatedMinor: number; outstandingMinor: number }

// A party's account: the effective documents it owes for (the kinds the business settles by money), each with what has been allocated and what is outstanding, and the total.
export async function outstandingForParty(env: Env, partyId: number): Promise<{ totalMinor: number; documents: AccountLine[] }> {
  const kinds = (await readConfig(env)).receivableKinds;
  if (kinds.length === 0) return { totalMinor: 0, documents: [] };
  const docs = await many<{ id: number; kind: string; issued_on: string; number: number | null }>(env,
    `SELECT d.id, d.kind, d.issued_on, n.number AS number FROM eng_document d LEFT JOIN eng_document_number n ON n.document_id = d.id
      WHERE d.party_id = ? AND d.direction = 'sell' AND d.kind IN (${kinds.map(() => "?").join(", ")})
        AND NOT EXISTS (SELECT 1 FROM eng_reversal r WHERE r.document_id = d.id) ORDER BY d.id`, partyId, ...kinds);
  const documents: AccountLine[] = [];
  let totalMinor = 0;
  for (const d of docs) {
    const grossMinor = (await documentTotals(env, d.id)).grossMinor;
    const allocatedMinor = await allocatedToDocument(env, d.id);
    documents.push({ id: d.id, number: d.number, kind: d.kind, issuedOn: d.issued_on, grossMinor, allocatedMinor, outstandingMinor: grossMinor - allocatedMinor });
    totalMinor += grossMinor - allocatedMinor;
  }
  return { totalMinor, documents };
}
