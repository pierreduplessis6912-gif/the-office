// THE RECORD CONTRACT: one view of a business record that every consumer reads (the screen, the conversation, an outside assistant, an export), so none of them computes a figure of its own and they cannot disagree.
// A view carries its identity and VERSION (the latest event that touched the record or anything hanging off it: an approval is only for the version it showed), its fields (each derived figure says which derivation
// produced it), its collections (lines, allocations, the account), its relations (what to follow next), the actions THIS member may take now (each with whether it is valid), and its history. What a member may not see
// is INDISTINGUISHABLE from what does not exist: recordView returns null for both. Exports (PDF, a share link) arrive with phase 3 and are listed as not yet available.
import type { Env } from "../types";
import { allocatedToDocument, documentTotals, isEffective, outstandingForDocument, outstandingForParty, unallocatedForMovement, unappliedCreditForParty } from "./ledger";
import { readConfig } from "./config";
import { readDraft } from "./drafts";
import type { EnginePermission } from "./permissions";
import { partyProfile } from "./parties";
import { quotationEventIds, quotationSummary } from "./quotations";
import { appliedToInvoiceIds, creditAvailable, creditedGross, creditOf, creditsOf, creditStoryIds, debitOf, debitsOf } from "./credits";
import { documentParticulars } from "./business";
import { expenseEventIds, expenseInfo, inputTaxOf } from "./expenses";
import { billEventIds, billInfo, billInputTax } from "./bills";
import { cancellationOf, orderEventIds, orderProgress, orderSummary, receiptInfo } from "./purchasing";

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

// The version of a record: the latest event that touched it or anything hanging off it. Each value is its OWN small query and the largest is taken here: a real Durable Object's SQLite allows only a few terms in one compound SELECT, and the first version of this chained nine
// of them with UNION ALL, which answered "too many terms in compound SELECT" for every read of a customer on the real staging object (found 2026-11-09; the harness's SQLite allows 500 and could not show it). The ownership rule R7 now bans compound SELECT in the engine.
const VERSION_QUERIES: Record<"party" | "document" | "movement", readonly string[]> = {
  party: [
    "SELECT MAX(event_id) AS v FROM eng_document WHERE party_id = ?",
    "SELECT MAX(event_id) AS v FROM eng_money_movement WHERE party_id = ?",
    "SELECT MAX(a.event_id) AS v FROM eng_allocation a JOIN eng_document d ON d.id = a.document_id WHERE d.party_id = ?",
    "SELECT MAX(a.event_id) AS v FROM eng_allocation a JOIN eng_money_movement m ON m.id = a.movement_id WHERE m.party_id = ?",
    "SELECT MAX(r.event_id) AS v FROM eng_reversal r JOIN eng_document d ON d.id = r.document_id WHERE d.party_id = ?",
    "SELECT MAX(r.event_id) AS v FROM eng_reversal r JOIN eng_money_movement m ON m.id = r.movement_id WHERE m.party_id = ?",
    "SELECT MAX(r.event_id) AS v FROM eng_reversal r JOIN eng_allocation a ON a.id = r.allocation_id JOIN eng_document d ON d.id = a.document_id WHERE d.party_id = ?",
    "SELECT MAX(r.event_id) AS v FROM eng_reversal r JOIN eng_allocation a ON a.id = r.allocation_id JOIN eng_money_movement m ON m.id = a.movement_id WHERE m.party_id = ?",
    "SELECT event_id AS v FROM eng_party WHERE id = ?",
    "SELECT MAX(id) AS v FROM eng_event WHERE type = 'party.revised' AND json_extract(payload_json, '$.partyId') = ?",
  ],
  document: [
    "SELECT MAX(id) AS v FROM eng_event WHERE type IN ('goods.received', 'purchase_order.cancelled') AND json_extract(payload_json, '$.orderId') = ?",
    "SELECT MAX(id) AS v FROM eng_event WHERE type = 'purchase_order.cancelled' AND json_extract(payload_json, '$.documentId') = ?",
    "SELECT MAX(id) AS v FROM eng_event WHERE type IN ('credit.allocated', 'credit.refunded', 'credit_note.voided') AND json_extract(payload_json, '$.creditNoteId') = ?",
    "SELECT MAX(id) AS v FROM eng_event WHERE type IN ('credit.allocated', 'debit_note.issued') AND json_extract(payload_json, '$.invoiceId') = ?",
    "SELECT MAX(id) AS v FROM eng_event WHERE type = 'credit_note.issued' AND json_extract(payload_json, '$.invoiceId') = ?",
    "SELECT MAX(id) AS v FROM eng_event WHERE type IN ('quotation.revised', 'quotation.accepted') AND json_extract(payload_json, '$.documentId') = ?",
    "SELECT MAX(id) AS v FROM eng_event WHERE type = 'quotation.revised' AND json_extract(payload_json, '$.supersedes') = ?",
    "SELECT event_id AS v FROM eng_document WHERE id = ?",
    "SELECT MAX(event_id) AS v FROM eng_allocation WHERE document_id = ?",
    "SELECT MAX(event_id) AS v FROM eng_reversal WHERE document_id = ?",
    "SELECT MAX(r.event_id) AS v FROM eng_reversal r JOIN eng_allocation a ON a.id = r.allocation_id WHERE a.document_id = ?",
    "SELECT MAX(r.event_id) AS v FROM eng_reversal r JOIN eng_allocation a ON a.movement_id = r.movement_id WHERE a.document_id = ?",
  ],
  movement: [
    "SELECT event_id AS v FROM eng_money_movement WHERE id = ?",
    "SELECT MAX(event_id) AS v FROM eng_allocation WHERE movement_id = ?",
    "SELECT MAX(event_id) AS v FROM eng_reversal WHERE movement_id = ?",
    "SELECT MAX(r.event_id) AS v FROM eng_reversal r JOIN eng_allocation a ON a.id = r.allocation_id WHERE a.movement_id = ?",
  ],
};

export async function versionOf(env: Env, ref: RecordRef): Promise<number> {
  const id = ref.id;
  if (ref.kind === "draft") return Number((await one<{ v: number }>(env, "SELECT version AS v FROM eng_draft WHERE id = ?", id))?.v ?? 0);
  let latest = 0;
  for (const sql of VERSION_QUERIES[ref.kind as "party" | "document" | "movement"]) {
    const v = Number((await one<{ v: number | null }>(env, sql, id))?.v ?? 0);
    if (v > latest) latest = v;
  }
  return latest;
}

export async function history(env: Env, eventIds: number[]): Promise<RecordView["history"]> {
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
  const seesMoney = viewer.perms.has("receivables.read");
  if (!seesMoney && ref.kind !== "document") return null;
  const cfg = await readConfig(env);

  if (ref.kind === "document") {
    const d = await one<{ id: number; kind: string; direction: string; party_id: number; currency: string; issued_on: string; event_id: number }>(env, "SELECT id, kind, direction, party_id, currency, issued_on, event_id FROM eng_document WHERE id = ?", ref.id);
    if (!d) return null;
    if (!(d.kind === "quotation" ? viewer.perms.has("quotation.read") : d.kind === "purchase_order" || d.kind === "goods_receipt" ? viewer.perms.has("purchase.read") : d.kind === "supplier_invoice" ? viewer.perms.has("bill.read") : seesMoney)) return null;   // a quotation is seen by those who make quotes; money documents by those who may see money
    const qs = d.kind === "quotation" ? await quotationSummary(env, d.id) : null;
    const po = d.kind === "purchase_order" ? await orderSummary(env, d.id) : null;      // an order's own story (its status and what has arrived)
    const bi = d.kind === "supplier_invoice" ? await billInfo(env, d.id) : null;          // a bill's own story (the order it bills, its match, whether it may be paid)
    const bt = bi ? await billInputTax(env, d.id) : null;
    const gr = d.kind === "goods_receipt" ? await receiptInfo(env, d.id) : null;
    const xi = d.kind === "expense" ? await expenseInfo(env, d.id) : null;           // the expense's own story (how it was paid, its category, its input tax)
    const xt = xi ? await inputTaxOf(env, d.id) : null;
    const pt = !qs && !xi && !po && !gr && !bi ? await documentParticulars(env, d.id) : null;                     // what a tax document still lacks (flags only)
    const cl = d.kind === "credit_note" ? await creditOf(env, d.id) : null;           // the credit note's own story (what it credited, applied and left over)
    const dl = d.kind === "debit_note" ? await debitOf(env, d.id) : null;           // the debit note's own story (what it debits)
    const debits = !qs && !cl && !dl ? await debitsOf(env, d.id) : [];               // the debit notes that add to THIS document (an invoice)
    const credits = !qs && !cl && !dl ? await creditsOf(env, d.id) : [];                    // the credit notes that credit THIS document (an invoice)
    const n = await one<{ number: number }>(env, "SELECT number FROM eng_document_number WHERE document_id = ?", d.id);
    const totals = await documentTotals(env, d.id);
    const allocated = await allocatedToDocument(env, d.id);
    const effective = await isEffective(env, "document", d.id);
    const outstanding = await outstandingForDocument(env, d.id);
    const party = await partyProfile(env, d.party_id);
    const lines = await many<{ line_no: number; description: string; quantity_milli: number; unit: string | null; unit_price_minor: number; tax_bp: number }>(env, "SELECT line_no, description, quantity_milli, unit, unit_price_minor, tax_bp FROM eng_document_line WHERE document_id = ? ORDER BY line_no", d.id);
    const allocs = await many<{ id: number; movement_id: number; amount_minor: number; event_id: number }>(env, "SELECT id, movement_id, amount_minor, event_id FROM eng_allocation WHERE document_id = ? ORDER BY id", d.id);
    const effAllocs: Array<{ id: number; movement_id: number; amount_minor: number; event_id: number; effective: boolean }> = [];
    for (const a of allocs) effAllocs.push({ ...a, effective: await isEffective(env, "allocation", a.id) });
    const reversals = await many<{ event_id: number }>(env, "SELECT event_id FROM eng_reversal WHERE document_id = ? OR allocation_id IN (SELECT id FROM eng_allocation WHERE document_id = ?)", d.id, d.id);
    const status = qs ? qs.status : po ? po.status : bi && !effective ? "voided" : gr ? "received" : xi ? (effective ? "recorded" : "voided") : cl ? (effective ? "issued" : "voided") : !effective ? "reversed" : outstanding === 0 ? "paid" : allocated > 0 ? "part_paid" : "unpaid";
    const settled = (d.direction === "sell" ? cfg.receivableKinds : cfg.payableKinds).includes(d.kind);
    return {
      ref, version: await versionOf(env, ref), title: `${d.kind[0].toUpperCase()}${d.kind.slice(1).replace(/_/g, " ")} ${n ? "#" + n.number : ""}`.trim(),
      fields: [
        { key: "kind", label: "Kind", value: d.kind }, { key: "number", label: "Number", value: n ? n.number : null }, { key: "status", label: "Status", value: status, derivedBy: qs ? "quotations.allQuotations" : "ledger.outstandingForDocument" }, ...(pt && pt.applicable ? [{ key: "particularsComplete", label: "Tax particulars complete", value: pt.complete, derivedBy: "business.documentParticulars" }, { key: "particularsMissing", label: "Tax particulars missing", value: pt.missing.join(", "), derivedBy: "business.documentParticulars" }] : []),
        { key: "issuedOn", label: "Issued", value: d.issued_on }, { key: "currency", label: "Currency", value: d.currency },
        { key: "netMinor", label: "Net", value: totals.netMinor, derivedBy: "ledger.documentTotals" }, { key: "taxMinor", label: "Tax", value: totals.taxMinor, derivedBy: "ledger.documentTotals" }, { key: "grossMinor", label: "Total", value: totals.grossMinor, derivedBy: "ledger.documentTotals" },
        ...(bi && bt ? [{ key: "supplier", label: "Supplier", value: (await partyProfile(env, bi.supplierId))?.name ?? null }, { key: "supplierInvoiceNumber", label: "Supplier invoice", value: bi.supplierInvoiceNumber }, { key: "dueOn", label: "Due on", value: bi.dueOn }, { key: "category", label: "Category", value: bi.category }, { key: "matchStatus", label: "Match", value: bi.matchStatus }, { key: "varianceAccepted", label: "Variance accepted", value: bi.varianceAccepted }, { key: "payable", label: "May be paid", value: effective && (bi.matchStatus !== "variance" || bi.varianceAccepted), derivedBy: "bills.allBills" }, { key: "taxInvoiceHeld", label: "Tax invoice held", value: bi.taxInvoiceHeld }, { key: "capital", label: "Capital", value: bi.capital }, { key: "inputTaxClaimable", label: "Input tax claimable", value: bt.claimable, derivedBy: "expenses.inputTaxWith" }, { key: "inputTaxMinor", label: "Input tax", value: bt.claimable ? bt.taxMinor : 0, derivedBy: "expenses.inputTaxWith" }, { key: "inputTaxReasons", label: "Why not claimable", value: bt.reasons.join("; "), derivedBy: "expenses.inputTaxWith" }, { key: "claimDate", label: "Claimed on", value: bi.claimDate }] : []), ...(po ? [{ key: "supplier", label: "Supplier", value: (await partyProfile(env, po.supplierId))?.name ?? null }, { key: "expectedOn", label: "Expected on", value: po.expectedOn }, { key: "reference", label: "Reference", value: po.reference }, { key: "receivedValueMinor", label: "Received (before tax)", value: po.receivedValueMinor, derivedBy: "purchasing.orderSummary" }, { key: "outstandingValueMinor", label: "Still to receive (before tax)", value: po.outstandingValueMinor, derivedBy: "purchasing.orderSummary" }, { key: "allocatedMinor", label: "Paid", value: null }, { key: "outstandingMinor", label: "Outstanding", value: null }] : gr ? [{ key: "receivedOn", label: "Received on", value: gr.receivedOn }, { key: "deliveryNote", label: "Delivery note", value: gr.deliveryNote }, { key: "note", label: "Note", value: gr.note }, { key: "allocatedMinor", label: "Paid", value: null }, { key: "outstandingMinor", label: "Outstanding", value: null }] : []), ...(xi && xt ? [{ key: "category", label: "Category", value: xi.category }, { key: "supplier", label: "Supplier", value: (await partyProfile(env, xi.supplierId))?.name ?? null }, { key: "amountPaidMinor", label: "Paid", value: xi.amountPaidMinor }, { key: "method", label: "Paid by", value: xi.method }, { key: "paidOn", label: "Paid on", value: xi.paidOn }, { key: "taxInvoiceHeld", label: "Tax invoice held", value: xi.taxInvoiceHeld }, { key: "supplierInvoiceNumber", label: "Supplier invoice", value: xi.supplierInvoiceNumber }, { key: "receiptRef", label: "Receipt", value: xi.receiptRef }, { key: "capital", label: "Capital", value: xi.capital }, { key: "inputTaxClaimable", label: "Input tax claimable", value: xt.claimable, derivedBy: "expenses.inputTaxOf" }, { key: "inputTaxMinor", label: "Input tax", value: xt.claimable ? xt.taxMinor : 0, derivedBy: "expenses.inputTaxOf" }, { key: "inputTaxReasons", label: "Why not claimable", value: xt.reasons.join("; "), derivedBy: "expenses.inputTaxOf" }, { key: "claimDate", label: "Claimed on", value: xi.claimDate }, { key: "allocatedMinor", label: "Allocated", value: null }, { key: "outstandingMinor", label: "Outstanding", value: null }] : []), ...(qs ? [{ key: "validUntil", label: "Valid until", value: qs.validUntil }, { key: "reference", label: "Reference", value: qs.reference }, { key: "allocatedMinor", label: "Paid", value: null }, { key: "outstandingMinor", label: "Outstanding", value: null }] : cl ? [{ key: "reason", label: "Reason", value: cl.reason }, { key: "appliedMinor", label: "Applied to the invoice", value: cl.appliedMinor }, { key: "unappliedMinor", label: "Left unapplied", value: cl.unappliedMinor }, { key: "availableMinor", label: "Credit available", value: await creditAvailable(env, d.id), derivedBy: "credits.creditAvailable" }, { key: "allocatedMinor", label: "Paid", value: null }, { key: "outstandingMinor", label: "Outstanding", value: null }] : xi || po || gr ? [] : [{ key: "allocatedMinor", label: "Paid", value: allocated, derivedBy: "ledger.allocatedToDocument" }, { key: "outstandingMinor", label: "Outstanding", value: outstanding, derivedBy: "ledger.outstandingForDocument" }, { key: "creditedMinor", label: "Credited", value: await creditedGross(env, d.id), derivedBy: "credits.creditedGross" }]),
      ],
      collections: {
        lines: lines.map((l) => ({ lineNo: l.line_no, description: l.description, quantityMilli: l.quantity_milli, unit: l.unit, unitPriceMinor: l.unit_price_minor, taxBp: l.tax_bp })),
        allocations: effAllocs.map((a) => ({ id: a.id, movementId: a.movement_id, amountMinor: a.amount_minor, effective: a.effective })),
        ...(bi ? { match: bi.lines.map((m) => ({ lineNo: m.lineNo, orderLineNo: m.orderLineNo, quantityMilli: m.quantityMilli, variances: m.variances })) } : {}), ...(po ? { progress: (await orderProgress(env, d.id)).map((l) => ({ lineNo: l.lineNo, description: l.description, orderedMilli: l.orderedMilli, receivedMilli: l.receivedMilli, remainingMilli: l.remainingMilli, itemId: l.itemId, stockedMilli: l.stockedMilli })) } : {}),
      },
      relations: [...(bi && bi.orderId !== null ? [{ role: "bills_order", ref: { kind: "document" as const, id: bi.orderId }, label: "Bills order" }] : []), ...(po ? po.receipts.map((rid) => ({ role: "receipt", ref: { kind: "document" as const, id: rid }, label: "Goods receipt" })) : []), ...(gr ? [{ role: "receives", ref: { kind: "document" as const, id: gr.orderId }, label: "Goods against order" }] : []), ...(dl ? [{ role: "debits", ref: { kind: "document" as const, id: dl.invoiceId }, label: "Debits invoice" }] : []), ...debits.map((x) => ({ role: "debit_note", ref: { kind: "document" as const, id: x.documentId }, label: "Debit note" })), ...(cl ? [{ role: "credits", ref: { kind: "document" as const, id: cl.invoiceId }, label: "Credits invoice" }] : []), ...credits.map((c) => ({ role: "credit_note", ref: { kind: "document" as const, id: c.documentId }, label: "Credit note" })), ...(qs ? [...(qs.supersededBy ? [{ role: "superseded_by", ref: { kind: "document" as const, id: qs.supersededBy }, label: "Replaced by" }] : []), ...(qs.supersedes ? [{ role: "revises", ref: { kind: "document" as const, id: qs.supersedes }, label: "Revises" }] : [])] : []), { role: d.direction === "sell" ? "customer" : "supplier", ref: { kind: "party", id: d.party_id }, label: party ? party.name : "Party" }, ...effAllocs.filter((a) => a.effective).map((a) => ({ role: "payment", ref: { kind: "movement" as const, id: a.movement_id }, label: `Payment ${a.movement_id}` }))],
      actions: cl || xi || po || gr ? [] : qs ? (qs.status === "open" ? [...(may(viewer, "quotation.revise", "quotation.manage") ? [{ capability: "quotation.revise", label: "Revise this quotation", valid: true, reason: null }] : []), ...(may(viewer, "quotation.accept", "quotation.manage") ? [{ capability: "quotation.accept", label: "Record that it was accepted", valid: true, reason: null }] : [])] : []) : settled && effective && may(viewer, "payment.record", "payment.record") ? [{ capability: "payment.record", label: "Record a payment", valid: outstanding > 0, reason: outstanding > 0 ? null : "nothing is outstanding" }] : [],
      history: await history(env, [d.event_id, ...allocs.map((a) => a.event_id), ...reversals.map((r) => r.event_id), ...(qs ? await quotationEventIds(env, d.id) : []), ...(xi ? await expenseEventIds(env, d.id) : []), ...(po ? await orderEventIds(env, d.id) : []), ...(bi ? await billEventIds(env, d.id) : []), ...(gr ? [gr.eventId] : []), ...(cl ? [cl.eventId, ...(await creditStoryIds(env, d.id))] : []), ...credits.map((c) => c.eventId), ...(dl ? [dl.eventId] : []), ...(!qs && !cl && !dl ? await appliedToInvoiceIds(env, d.id) : [])]), exports: EXPORTS,
    };
  }

  if (ref.kind === "party") {
    const p = await partyProfile(env, ref.id);
    if (!p) return null;
    const roles = p.roles;
    const acct = await outstandingForParty(env, p.id);
    const moves = await many<{ id: number; direction: string; amount_minor: number; occurred_on: string; event_id: number }>(env, "SELECT id, direction, amount_minor, occurred_on, event_id FROM eng_money_movement WHERE party_id = ? ORDER BY id", p.id);
    const payments: Array<Record<string, unknown>> = [];
    for (const m of moves) payments.push({ id: m.id, direction: m.direction, amountMinor: m.amount_minor, occurredOn: m.occurred_on, unallocatedMinor: await unallocatedForMovement(env, m.id), effective: await isEffective(env, "movement", m.id) });
    return {
      ref, version: await versionOf(env, ref), title: p.name,
      fields: [{ key: "name", label: "Name", value: p.name }, { key: "kind", label: "Kind", value: p.kind }, { key: "roles", label: "Roles", value: roles.join(", ") }, { key: "email", label: "Email", value: p.contact.email ?? null }, { key: "phone", label: "Phone", value: p.contact.phone ?? null }, { key: "address", label: "Address", value: p.contact.address ?? null }, { key: "vatNumber", label: "VAT number", value: p.contact.vatNumber ?? null }, { key: "outstandingMinor", label: "Outstanding", value: acct.totalMinor, derivedBy: "ledger.outstandingForParty" }, { key: "unappliedCreditMinor", label: "Credit owed back", value: await unappliedCreditForParty(env, p.id), derivedBy: "ledger.unappliedCreditForParty" }],
      collections: { documents: acct.documents.map((d) => ({ ...d })), payments },
      relations: [...acct.documents.map((d) => ({ role: "invoice", ref: { kind: "document" as const, id: d.id }, label: `${d.kind} ${d.number ?? ""}`.trim() })), ...moves.map((m) => ({ role: "payment", ref: { kind: "movement" as const, id: m.id }, label: `Payment ${m.id}` }))],
      actions: [...(may(viewer, "party.edit", "party.manage") ? [{ capability: "party.edit", label: "Change this " + (roles.includes("supplier") && !roles.includes("customer") ? "supplier" : "customer"), valid: true, reason: null }] : []), ...(may(viewer, "payment.record", "payment.record") ? [{ capability: "payment.record", label: "Record a payment", valid: true, reason: null }] : [])],
      history: await history(env, [(await one<{ event_id: number }>(env, "SELECT event_id FROM eng_party WHERE id = ?", p.id))!.event_id, ...p.revisionEventIds, ...moves.map((m) => m.event_id)]), exports: EXPORTS,
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
