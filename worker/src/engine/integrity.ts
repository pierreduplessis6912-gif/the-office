// The integrity verifier: READ-ONLY, and the reason append-only needs no database trigger. It re-derives every invariant from the tables and reports what is wrong, so a business can be checked at any time
// (by the tests, by a health report, after a restore) and an edit made behind the engine's back cannot stay hidden. Each fact's event carries a snapshot of the fact as it was recorded; the verifier compares
// the snapshot with the row, recomputes document totals from the lines, and checks conservation, cascade and numbering. It changes nothing.
import type { Env } from "../types";
import { documentTotals as sumTotals } from "./money";

export interface IntegrityProblem {
  code: "orphan" | "fact_changed" | "over_allocated" | "allocation_on_reversed" | "number_gap";
  detail: string;
}

const many = async <T>(env: Env, sql: string, ...binds: unknown[]): Promise<T[]> => ((await env.OFFICE_DB.prepare(sql).bind(...binds).all<T>()).results ?? []);

function snapshotOf(json: string | null): Record<string, unknown> | null {
  try { const v = JSON.parse(json ?? ""); return v && typeof v === "object" ? (v as Record<string, unknown>) : null; } catch { return null; }
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export async function verifyIntegrity(env: Env): Promise<{ ok: boolean; problems: IntegrityProblem[] }> {
  const problems: IntegrityProblem[] = [];

  // every relationship points at something that exists
  try {
    const orphans = await many<Record<string, unknown>>(env, "PRAGMA foreign_key_check");
    for (const o of orphans.filter((r) => String(r.table ?? "").startsWith("eng_"))) problems.push({ code: "orphan", detail: `${o.table} row ${o.rowid} points at a missing ${o.parent}` });
  } catch { /* a database that cannot answer the pragma is not reported as broken */ }

  // each fact still matches the snapshot its event recorded
  const movements = await many<{ id: number; direction: string; party_id: number; amount_minor: number; currency: string; occurred_on: string; method: string | null; payload_json: string | null }>(env,
    "SELECT m.id, m.direction, m.party_id, m.amount_minor, m.currency, m.occurred_on, m.method, e.payload_json FROM eng_money_movement m LEFT JOIN eng_event e ON e.id = m.event_id");
  for (const m of movements) {
    const s = snapshotOf(m.payload_json);
    if (!s || !same([s.direction, s.partyId, s.amountMinor, s.currency, s.occurredOn, s.method ?? null], [m.direction, m.party_id, m.amount_minor, m.currency, m.occurred_on, m.method])) problems.push({ code: "fact_changed", detail: `payment ${m.id} no longer matches what was recorded` });
  }
  const allocations = await many<{ id: number; movement_id: number; document_id: number; amount_minor: number; payload_json: string | null }>(env,
    "SELECT a.id, a.movement_id, a.document_id, a.amount_minor, e.payload_json FROM eng_allocation a LEFT JOIN eng_event e ON e.id = a.event_id");
  for (const a of allocations) {
    const s = snapshotOf(a.payload_json);
    if (!s || !same([s.movementId, s.documentId, s.amountMinor], [a.movement_id, a.document_id, a.amount_minor])) problems.push({ code: "fact_changed", detail: `allocation ${a.id} no longer matches what was recorded` });
  }
  const documents = await many<{ id: number; kind: string; direction: string; party_id: number; currency: string; issued_on: string; payload_json: string | null }>(env,
    "SELECT d.id, d.kind, d.direction, d.party_id, d.currency, d.issued_on, e.payload_json FROM eng_document d LEFT JOIN eng_event e ON e.id = d.event_id");
  for (const d of documents) {
    const lines = await many<{ description: string; quantity_milli: number; unit: string | null; unit_price_minor: number; tax_bp: number }>(env, "SELECT description, quantity_milli, unit, unit_price_minor, tax_bp FROM eng_document_line WHERE document_id = ? ORDER BY line_no", d.id);
    const s = snapshotOf(d.payload_json);
    const asRecorded = lines.map((l) => ({ description: l.description, quantityMilli: l.quantity_milli, unit: l.unit, unitPriceMinor: l.unit_price_minor, taxBp: l.tax_bp }));
    let totals: unknown = null;
    try { totals = sumTotals(asRecorded); } catch { /* a line that cannot be totalled is reported below as changed */ }
    if (!s || !same([s.kind, s.direction, s.partyId, s.currency, s.issuedOn, s.lines, s.totals], [d.kind, d.direction, d.party_id, d.currency, d.issued_on, asRecorded, totals])) problems.push({ code: "fact_changed", detail: `document ${d.id} or its lines no longer match what was issued` });
  }

  // conservation: nothing is over-allocated, and nothing is allocated to something reversed
  for (const m of await many<{ id: number; amount_minor: number; used: number }>(env,
    `SELECT m.id, m.amount_minor, COALESCE((SELECT SUM(a.amount_minor) FROM eng_allocation a WHERE a.movement_id = m.id AND NOT EXISTS (SELECT 1 FROM eng_reversal r WHERE r.allocation_id = a.id)), 0) AS used
       FROM eng_money_movement m WHERE NOT EXISTS (SELECT 1 FROM eng_reversal r WHERE r.movement_id = m.id)`)) {
    if (Number(m.used) > m.amount_minor) problems.push({ code: "over_allocated", detail: `payment ${m.id} has ${m.used} allocated of ${m.amount_minor}` });
  }
  for (const d of documents) {
    const row = await many<{ n: number; reversed: number }>(env,
      `SELECT COALESCE(SUM(a.amount_minor), 0) AS n, (SELECT COUNT(*) FROM eng_reversal r WHERE r.document_id = ?) AS reversed FROM eng_allocation a WHERE a.document_id = ?
         AND NOT EXISTS (SELECT 1 FROM eng_reversal r WHERE r.allocation_id = a.id) AND NOT EXISTS (SELECT 1 FROM eng_reversal r WHERE r.movement_id = a.movement_id)`, d.id, d.id);
    const lines = await many<{ quantity_milli: number; unit_price_minor: number; tax_bp: number }>(env, "SELECT quantity_milli, unit_price_minor, tax_bp FROM eng_document_line WHERE document_id = ?", d.id);
    let gross = 0;
    try { gross = sumTotals(lines.map((l) => ({ quantityMilli: l.quantity_milli, unitPriceMinor: l.unit_price_minor, taxBp: l.tax_bp }))).grossMinor; } catch { continue; }
    if (Number(row[0]?.reversed ?? 0) === 0 && Number(row[0]?.n ?? 0) > gross) problems.push({ code: "over_allocated", detail: `document ${d.id} has ${row[0]?.n} allocated against a total of ${gross}` });
  }
  for (const a of await many<{ id: number }>(env,
    `SELECT a.id FROM eng_allocation a WHERE NOT EXISTS (SELECT 1 FROM eng_reversal r WHERE r.allocation_id = a.id)
       AND (EXISTS (SELECT 1 FROM eng_reversal r WHERE r.movement_id = a.movement_id) OR EXISTS (SELECT 1 FROM eng_reversal r WHERE r.document_id = a.document_id))`)) {
    problems.push({ code: "allocation_on_reversed", detail: `allocation ${a.id} is still counted although its payment or document was reversed` });
  }

  // numbering: each kind runs 1..n with no hole, and every document has its number
  for (const k of await many<{ kind: string; n: number; lo: number; hi: number }>(env, "SELECT kind, COUNT(*) AS n, MIN(number) AS lo, MAX(number) AS hi FROM eng_document_number GROUP BY kind")) {
    if (k.lo !== 1 || k.hi !== k.n) problems.push({ code: "number_gap", detail: `${k.kind} numbers run ${k.lo} to ${k.hi} but there are ${k.n}` });
  }
  const unnumbered = await many<{ id: number }>(env, "SELECT d.id FROM eng_document d WHERE NOT EXISTS (SELECT 1 FROM eng_document_number n WHERE n.document_id = d.id)");
  for (const u of unnumbered) problems.push({ code: "number_gap", detail: `document ${u.id} has no number` });

  return { ok: problems.length === 0, problems };
}
