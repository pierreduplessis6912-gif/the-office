// THE RECORD CONTRACT: one view of a business record that every consumer reads (the screen, the conversation, an outside assistant, an export), so none of them computes a figure of its own and they cannot disagree.
// A view carries its identity and VERSION (the latest event that touched the record or anything hanging off it: an approval is only for the version it showed), its fields (each derived figure says which derivation
// produced it), its collections (lines, allocations, the account), its relations (what to follow next), the actions THIS member may take now (each with whether it is valid), and its history. What a member may not see
// is INDISTINGUISHABLE from what does not exist: recordView returns null for both. Exports (PDF, a share link) arrive with phase 3 and are listed as not yet available.
import type { Env } from "../types";
import { allocatedToDocument, documentTotals, isEffective, outstandingForDocument, outstandingForParty, unallocatedForMovement } from "./ledger";
import { readConfig } from "./config";
import { readDraft } from "./drafts";
import type { EnginePermission } from "./permissions";

export type RecordKind = "party" | "document" | "movement" | "draft";
export interface RecordRef { kind: RecordKind; id: number }
export interface RecordField { key: string; label: string; value: string | number | boolean | null; derivedBy?: string }
export interface RecordAction { capability: string; label: string; valid: boolean; reason: string | null }
export interface RecordView {
  ref: RecordRef;
  version: number;
  title: string;
  fields: RecordField[];
  collections: Record<string, Array<Record<string, unknown>>>;
  relations: Array<{ role: string; ref: RecordRef; label: string }>;
  actions: RecordAction[];
  // captureId, proposalId, approvedBy, contract and contractVersion are the provenance (invariant 6): null where the fact was written without a proposal (a seeded or system-generated record), never invented.
  history: Array<{ eventId: number; type: string; at: string; actor: string | null; reason: string | null; captureId: number | null; proposalId: number | null; approvedBy: string | null; contract: string | null; contractVersion: number | null; interpretationId: number | null; interpreter: string | null }>;
  exports: Array<{ kind: string; available: boolean }>;
}
export const RECORD_KINDS: readonly RecordKind[] = ["party", "document", "movement", "draft"];

const one = <T>(env: Env, sql: string, ...binds: unknown[]) => env.OFFICE_DB.prepare(sql).bind(...binds).first<T>();
const many = async <T>(env: Env, sql: string, ...binds: unknown[]): Promise<T[]> => ((await env.OFFICE_DB.prepare(sql).bind(...binds).all<T>()).results ?? []);

// The version of a record: the latest event that touched it or anything hanging off it.
export async function versionOf(env: Env, ref: RecordRef): Promise<number> {
  const id = ref.id;
  if (ref.kind === "draft") return Number((await one<{ v: number }>(env, "SELECT version AS v FROM eng_draft WHERE id = ?", id))?.v ?? 0);
  let sql = "", n = 0;
  if (ref.kind === "party") {
    n = 9;
    sql = `SELECT MAX(v) AS v FROM (
      SELECT MAX(event_id) AS v FROM eng_document WHERE party_id = ?
      UNION ALL SELECT MAX(event_id) FROM eng_money_movement WHERE party_id = ?
      UNION ALL SELECT MAX(a.event_id) FROM eng_allocation a JOIN eng_document d ON d.id = a.document_id WHERE d.party_id = ?
      UNION ALL SELECT MAX(a.event_id) FROM eng_allocation a JOIN eng_money_movement m ON m.id = a.movement_id WHERE m.party_id = ?
      UNION ALL SELECT MAX(r.event_id) FROM eng_reversal r JOIN eng_document d ON d.id = r.document_id WHERE d.party_id = ?
      UNION ALL SELECT MAX(r.event_id) FROM eng_reversal r JOIN eng_money_movement m ON m.id = r.movement_id WHERE m.party_id = ?
      UNION ALL SELECT MAX(r.event_id) FROM eng_reversal r JOIN eng_allocation a ON a.id = r.allocation_id JOIN eng_document d ON d.id = a.document_id WHERE d.party_id = ?
      UNION ALL SELECT MAX(r.event_id) FROM eng_reversal r JOIN eng_allocation a ON a.id = r.allocation_id JOIN eng_money_movement m ON m.id = a.movement_id WHERE m.party_id = ?
      UNION ALL SELECT event_id FROM eng_party WHERE id = ?)`;
  } else if (ref.kind === "document") {
    n = 5;
    sql = `SELECT MAX(v) AS v FROM (
      SELECT event_id AS v FROM eng_document WHERE id = ?
      UNION ALL SELECT MAX(event_id) FROM eng_allocation WHERE document_id = ?
      UNION ALL SELECT MAX(event_id) FROM eng_reversal WHERE document_id = ?
      UNION ALL SELECT MAX(r.event_id) FROM eng_reversal r JOIN eng_allocation a ON a.id = r.allocation_id WHERE a.document_id = ?
      UNION ALL SELECT MAX(r.event_id) FROM eng_reversal r JOIN eng_allocation a ON a.movement_id = r.movement_id WHERE a.document_id = ?)`;
  } else {
    n = 4;
    sql = `SELECT MAX(v) AS v FROM (
      SELECT event_id AS v FROM eng_money_movement WHERE id = ?
      UNION ALL SELECT MAX(event_id) FROM eng_allocation WHERE movement_id = ?
      UNION ALL SELECT MAX(event_id) FROM eng_reversal WHERE movement_id = ?
      UNION ALL SELECT MAX(r.event_id) FROM eng_reversal r JOIN eng_allocation a ON a.id = r.allocation_id WHERE a.movement_id = ?)`;
  }
  return Number((await one<{ v: number | null }>(env, sql, ...Array(n).fill(id)))?.v ?? 0);
}

async function history(env: Env, eventIds: number[]): Promise<RecordView["history"]> {
  const ids = [...new Set(eventIds.filter((x) => Number.isInteger(x)))].sort((a, b) => a - b).slice(-50);
  if (ids.length === 0) return [];
  const rows = await many<{ id: number; type: string; occurred_at: string; actor_email: string | null; reason: string | null; capture_id: number | null; proposal_id: number | null; approved_by: string | null; contract: string | null; contract_version: number | null }>(env, `SELECT id, type, occurred_at, actor_email, reason, capture_id, proposal_id, approved_by, contract, contract_version FROM eng_event WHERE id IN (${ids.map(() => "?").join(",")}) ORDER BY id`, ...ids);
  // What was understood: the interpretation that linked the capture to the proposal this fact was recorded from (it names the held action in its payload), and who interpreted. Null for a fact written without a proposal.
  const understood = new Map<number, { id: number; interpreter: string }>();
  for (const proposalId of [...new Set(rows.map((r) => r.proposal_id).filter((x): x is number => Number.isInteger(x)))]) {
    const found = await one<{ id: number; interpreter: string }>(env, "SELECT id, interpreter FROM eng_interpretation WHERE json_extract(payload_json, '$.actionId') = ? ORDER BY id DESC LIMIT 1", proposalId);
    if (found) understood.set(proposalId, found);
  }
  return rows.map((r) => ({ eventId: r.id, type: r.type, at: r.occurred_at, actor: r.actor_email, reason: r.reason, captureId: r.capture_id, proposalId: r.proposal_id, approvedBy: r.approved_by, contract: r.contract, contractVersion: r.contract_version, interpretationId: r.proposal_id === null ? null : (understood.get(r.proposal_id)?.id ?? null), interpreter: r.proposal_id === null ? null : (understood.get(r.proposal_id)?.interpreter ?? null) }));
}

const EXPORTS = [{ kind: "pdf", available: false }, { kind: "share", available: false }];

export interface ViewerContext { perms: ReadonlySet<EnginePermission>; available: ReadonlySet<string> }
const may = (v: ViewerContext, capability: string, permission: EnginePermission) => v.available.has(capability) && v.perms.has(permission);

export async function recordView(env: Env, viewer: ViewerContext, ref: RecordRef): Promise<RecordView | null> {
  if (ref.kind === "draft") {
    if (!viewer.perms.has("drafts.edit")) return null;
    let d; try { d = await readDraft(env, ref.id); } catch { return null; }
    const lines = Array.isArray(d.payload.lines) ? (d.payload.lines as Array<Record<string, unknown>>) : [];
    return {
      ref, version: d.version, title: `Draft ${d.kind}`,
      fields: [{ key: "kind", label: "Kind", value: d.kind }, { key: "ready", label: "Ready to issue", value: d.validation.ok && d.issuedDocumentId === null }, { key: "grossMinor", label: "Total", value: d.validation.totals ? d.validation.totals.grossMinor : null, derivedBy: "drafts.validateDraft" }],
      collections: { lines, problems: d.validation.errors },
      relations: [...(d.partyId ? [{ role: "party", ref: { kind: "party" as const, id: d.partyId }, label: "Party" }] : []), ...(d.issuedDocumentId ? [{ role: "issued", ref: { kind: "document" as const, id: d.issuedDocumentId }, label: "Issued as" }] : [])],
      actions: may(viewer, "invoice.issue", "invoice.issue") ? [{ capability: "invoice.issue", label: "Issue", valid: d.validation.ok && d.issuedDocumentId === null, reason: d.issuedDocumentId !== null ? "already issued" : d.validation.ok ? null : "the draft is not ready" }] : [],
      history: [], exports: EXPORTS,
    };
  }
  if (!viewer.perms.has("receivables.read")) return null;
  const cfg = await readConfig(env);

  if (ref.kind === "document") {
    const d = await one<{ id: number; kind: string; direction: string; party_id: number; currency: string; issued_on: string; event_id: number }>(env, "SELECT id, kind, direction, party_id, currency, issued_on, event_id FROM eng_document WHERE id = ?", ref.id);
    if (!d) return null;
    const n = await one<{ number: number }>(env, "SELECT number FROM eng_document_number WHERE document_id = ?", d.id);
    const totals = await documentTotals(env, d.id);
    const allocated = await allocatedToDocument(env, d.id);
    const effective = await isEffective(env, "document", d.id);
    const outstanding = await outstandingForDocument(env, d.id);
    const party = await one<{ name: string }>(env, "SELECT name FROM eng_party WHERE id = ?", d.party_id);
    const lines = await many<{ line_no: number; description: string; quantity_milli: number; unit: string | null; unit_price_minor: number; tax_bp: number }>(env, "SELECT line_no, description, quantity_milli, unit, unit_price_minor, tax_bp FROM eng_document_line WHERE document_id = ? ORDER BY line_no", d.id);
    const allocs = await many<{ id: number; movement_id: number; amount_minor: number; event_id: number }>(env, "SELECT id, movement_id, amount_minor, event_id FROM eng_allocation WHERE document_id = ? ORDER BY id", d.id);
    const effAllocs: Array<{ id: number; movement_id: number; amount_minor: number; event_id: number; effective: boolean }> = [];
    for (const a of allocs) effAllocs.push({ ...a, effective: await isEffective(env, "allocation", a.id) });
    const reversals = await many<{ event_id: number }>(env, "SELECT event_id FROM eng_reversal WHERE document_id = ? OR allocation_id IN (SELECT id FROM eng_allocation WHERE document_id = ?)", d.id, d.id);
    const status = !effective ? "reversed" : outstanding === 0 ? "paid" : allocated > 0 ? "part_paid" : "unpaid";
    const settled = (d.direction === "sell" ? cfg.receivableKinds : cfg.payableKinds).includes(d.kind);
    return {
      ref, version: await versionOf(env, ref), title: `${d.kind[0].toUpperCase()}${d.kind.slice(1)} ${n ? "#" + n.number : ""}`.trim(),
      fields: [
        { key: "kind", label: "Kind", value: d.kind }, { key: "number", label: "Number", value: n ? n.number : null }, { key: "status", label: "Status", value: status, derivedBy: "ledger.outstandingForDocument" },
        { key: "issuedOn", label: "Issued", value: d.issued_on }, { key: "currency", label: "Currency", value: d.currency },
        { key: "netMinor", label: "Net", value: totals.netMinor, derivedBy: "ledger.documentTotals" }, { key: "taxMinor", label: "Tax", value: totals.taxMinor, derivedBy: "ledger.documentTotals" }, { key: "grossMinor", label: "Total", value: totals.grossMinor, derivedBy: "ledger.documentTotals" },
        { key: "allocatedMinor", label: "Paid", value: allocated, derivedBy: "ledger.allocatedToDocument" }, { key: "outstandingMinor", label: "Outstanding", value: outstanding, derivedBy: "ledger.outstandingForDocument" },
      ],
      collections: {
        lines: lines.map((l) => ({ lineNo: l.line_no, description: l.description, quantityMilli: l.quantity_milli, unit: l.unit, unitPriceMinor: l.unit_price_minor, taxBp: l.tax_bp })),
        allocations: effAllocs.map((a) => ({ id: a.id, movementId: a.movement_id, amountMinor: a.amount_minor, effective: a.effective })),
      },
      relations: [{ role: d.direction === "sell" ? "customer" : "supplier", ref: { kind: "party", id: d.party_id }, label: party ? party.name : "Party" }, ...effAllocs.filter((a) => a.effective).map((a) => ({ role: "payment", ref: { kind: "movement" as const, id: a.movement_id }, label: `Payment ${a.movement_id}` }))],
      actions: settled && effective && may(viewer, "payment.record", "payment.record") ? [{ capability: "payment.record", label: "Record a payment", valid: outstanding > 0, reason: outstanding > 0 ? null : "nothing is outstanding" }] : [],
      history: await history(env, [d.event_id, ...allocs.map((a) => a.event_id), ...reversals.map((r) => r.event_id)]), exports: EXPORTS,
    };
  }

  if (ref.kind === "party") {
    const p = await one<{ id: number; kind: string; name: string; event_id: number }>(env, "SELECT id, kind, name, event_id FROM eng_party WHERE id = ?", ref.id);
    if (!p) return null;
    const roles = (await many<{ role: string }>(env, "SELECT role FROM eng_party_role WHERE party_id = ? ORDER BY role", p.id)).map((r) => r.role);
    const acct = await outstandingForParty(env, p.id);
    const moves = await many<{ id: number; direction: string; amount_minor: number; occurred_on: string; event_id: number }>(env, "SELECT id, direction, amount_minor, occurred_on, event_id FROM eng_money_movement WHERE party_id = ? ORDER BY id", p.id);
    const payments: Array<Record<string, unknown>> = [];
    for (const m of moves) payments.push({ id: m.id, direction: m.direction, amountMinor: m.amount_minor, occurredOn: m.occurred_on, unallocatedMinor: await unallocatedForMovement(env, m.id), effective: await isEffective(env, "movement", m.id) });
    return {
      ref, version: await versionOf(env, ref), title: p.name,
      fields: [{ key: "name", label: "Name", value: p.name }, { key: "kind", label: "Kind", value: p.kind }, { key: "roles", label: "Roles", value: roles.join(", ") }, { key: "outstandingMinor", label: "Outstanding", value: acct.totalMinor, derivedBy: "ledger.outstandingForParty" }],
      collections: { documents: acct.documents.map((d) => ({ ...d })), payments },
      relations: [...acct.documents.map((d) => ({ role: "invoice", ref: { kind: "document" as const, id: d.id }, label: `${d.kind} ${d.number ?? ""}`.trim() })), ...moves.map((m) => ({ role: "payment", ref: { kind: "movement" as const, id: m.id }, label: `Payment ${m.id}` }))],
      actions: may(viewer, "payment.record", "payment.record") ? [{ capability: "payment.record", label: "Record a payment", valid: true, reason: null }] : [],
      history: await history(env, [p.event_id, ...moves.map((m) => m.event_id)]), exports: EXPORTS,
    };
  }

  const m = await one<{ id: number; direction: string; party_id: number; amount_minor: number; currency: string; occurred_on: string; method: string | null; event_id: number }>(env, "SELECT id, direction, party_id, amount_minor, currency, occurred_on, method, event_id FROM eng_money_movement WHERE id = ?", ref.id);
  if (!m) return null;
  const effective = await isEffective(env, "movement", m.id);
  const allocs = await many<{ id: number; document_id: number; amount_minor: number; event_id: number }>(env, "SELECT id, document_id, amount_minor, event_id FROM eng_allocation WHERE movement_id = ? ORDER BY id", m.id);
  const rows: Array<Record<string, unknown>> = [];
  for (const a of allocs) rows.push({ id: a.id, documentId: a.document_id, amountMinor: a.amount_minor, effective: await isEffective(env, "allocation", a.id) });
  const reversals = await many<{ event_id: number }>(env, "SELECT event_id FROM eng_reversal WHERE movement_id = ? OR allocation_id IN (SELECT id FROM eng_allocation WHERE movement_id = ?)", m.id, m.id);
  return {
    ref, version: await versionOf(env, ref), title: `Payment ${m.id}`,
    fields: [{ key: "direction", label: "Direction", value: m.direction }, { key: "amountMinor", label: "Amount", value: m.amount_minor }, { key: "currency", label: "Currency", value: m.currency }, { key: "occurredOn", label: "Date", value: m.occurred_on }, { key: "method", label: "Method", value: m.method }, { key: "status", label: "Status", value: effective ? "recorded" : "reversed" }, { key: "unallocatedMinor", label: "Unallocated", value: await unallocatedForMovement(env, m.id), derivedBy: "ledger.unallocatedForMovement" }],
    collections: { allocations: rows },
    relations: [{ role: "party", ref: { kind: "party", id: m.party_id }, label: "Party" }, ...allocs.map((a) => ({ role: "invoice", ref: { kind: "document" as const, id: a.document_id }, label: `Document ${a.document_id}` }))],
    actions: effective && may(viewer, "payment.correct", "payment.correct") ? [{ capability: "payment.correct", label: "Correct this payment", valid: true, reason: null }] : [],
    history: await history(env, [m.event_id, ...allocs.map((a) => a.event_id), ...reversals.map((r) => r.event_id)]), exports: EXPORTS,
  };
}
