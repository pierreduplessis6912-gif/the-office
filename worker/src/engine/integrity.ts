// The integrity verifier: READ-ONLY, and PARTIAL detection after the fact, not prevention. It reports violations of the invariants listed below, and nothing else.
//
// WHAT A CLEAN RESULT MEANS: no violation was found among THE INVARIANTS THIS VERIFIER CHECKS. It is NOT proof that the data is authentic, unaltered or complete. Neither a fact nor its event is independently protected
// (no hash chain, no external copy), so these are NOT detected, and tools/engine-integrity.test.js PINS each one: a COORDINATED edit of a fact and its event; the deletion of a fact AND its event; a swap of two documents'
// numbers (the number is not in the event, and a swap leaves no gap); an edit to a document's terms (not recorded in the event).
// It runs only when called (today: the admin status route, engine/admin.ts); nothing runs it automatically, and a failed check only REPORTS: it blocks nothing, repairs nothing, restores nothing.
//
// THE EVENT MODEL (EVENT_MODEL, below, derived from what facts.ts and capability-contract.ts actually write). Eight event types each create EXACTLY ONE fact row, carried by that row's event_id (party.created also creates
// the party's roles); operation.executed creates NO fact; any other type is NOT MODELLED and is reported as a WARNING, never a violation (it may come from newer code that was rolled back, or from a type nobody modelled
// yet: tools/engine-integrity.test.js fails if the engine writes an event type that is not in the model). Both directions are checked.
//
// THE INVARIANTS, and the code each violation is reported under:
//   event_without_fact      a modelled fact-creating event has no fact row (the fact was deleted while its event survived)
//   event_multiple_facts    a modelled fact-creating event has more than one fact row
//   fact_wrong_event        a fact's event does not exist, or is not the kind of event that creates that kind of fact (a payment's direction must match payment.recorded / payment.made)
//   fact_changed            a party, party role set, payment, allocation or document (header, reference, lines, recomputed totals) differs from the snapshot its event recorded
//   reversal_mismatch       a reversal row's target, reason or replacement differs from what its event recorded
//   over_allocated          a payment, or a document, has more allocated against it than it holds or owes (reversed things excluded)
//   allocation_on_reversed  an allocation is still counted although its payment or document was reversed
//   number_gap              an invoice-style sequence does not run 1..n, or a document has no number
//   orphan                  a foreign key points at nothing (PRAGMA foreign_key_check, engine tables only)
//   event_payload_malformed an event's payload is not a JSON object
// NOT checked at all: eng_interpretation, and the working-state tables (eng_config, eng_draft, eng_observation).
import type { Env } from "../types";
import { documentTotals as sumTotals } from "./money";
import { documentTotals as docTotals } from "./ledger";

export interface IntegrityProblem {
  code: "orphan" | "fact_changed" | "over_allocated" | "allocation_on_reversed" | "number_gap" | "event_without_fact" | "event_multiple_facts" | "fact_wrong_event" | "reversal_mismatch" | "stock_invariant" | "event_payload_malformed";
  detail: string;
}
export interface IntegrityWarning { code: "event_type_not_modelled"; detail: string }

type FactKind = "party" | "document" | "movement" | "allocation" | "reversal" | "item" | "location" | "stock_move";
// Every event type the engine writes. `creates` is the kind of fact the event requires (exactly one); null means the event creates none.
export const EVENT_MODEL: Record<string, { creates: FactKind | null; note: string }> = {
  "party.created": { creates: "party", note: "one eng_party, plus one eng_party_role per role in the payload" },
  "document.issued": { creates: "document", note: "one eng_document (its lines and number are written with it)" },
  "payment.recorded": { creates: "movement", note: "one eng_money_movement with direction in" },
  "payment.made": { creates: "movement", note: "one eng_money_movement with direction out" },
  "payment.allocated": { creates: "allocation", note: "one eng_allocation" },
  "payment.reversed": { creates: "reversal", note: "one eng_reversal whose target is a payment" },
  "payment.allocation_reversed": { creates: "reversal", note: "one eng_reversal whose target is an allocation" },
  "document.reversed": { creates: "reversal", note: "one eng_reversal whose target is a document" },
  "party.revised": { creates: null, note: "a change to a party's name, roles or contact details; it creates no fact row, because the current profile is DERIVED from the party and its revisions (parties.ts)" },
  "quotation.revised": { creates: null, note: "a new quotation document replaces an older one; the event says which, and creates no fact row of its own (the new document is created by the document.issued event beside it)" },
  "quotation.accepted": { creates: null, note: "a quotation is accepted; state is derived from the event, nothing is stored (quotations.ts)" },
  "credit_note.issued": { creates: null, note: "an invoice is credited: ties the credit note document, its non-cash movement and the invoice together; the document, movement and allocation are created by their own events beside it" },
  "business.profile_set": { creates: null, note: "the business's own particulars change; the current profile is derived from the events (business.ts)" },
  "tax_lock.set": { creates: null, note: "the tax lock date moves forward; the current lock is derived (business.ts)" },
  "credit.allocated": { creates: null, note: "part of a credit note's credit is allocated to another invoice; the allocation is created by its own event beside it" },
  "credit.refunded": { creates: null, note: "part of a credit note's credit is paid back to the customer; the money-out movement is created by its own event beside it" },
  "credit_note.voided": { creates: null, note: "a credit note is voided; the reversals are created by their own events beside it" },
  "debit_note.issued": { creates: null, note: "an invoice is debited: ties the debit note document to the invoice; the document is created by its own event beside it" },
  "overpayment.allocated": { creates: null, note: "part of an unapplied payment (an overpayment) is allocated to another invoice; the allocation is created by its own event beside it" },
  "overpayment.refunded": { creates: null, note: "part of an unapplied payment is paid back to the customer; the money-out movement is created by its own event beside it" },
  "expense.recorded": { creates: null, note: "a paid expense: ties the expense document to the money-out movement that paid it; the document and the movement are created by their own events beside it" },
  "expense.voided": { creates: null, note: "an expense is voided; the reversals are created by their own events beside it" },
  "goods.received": { creates: null, note: "goods arrive against a purchase order: ties the goods_receipt document to its order; the document is created by its own event beside it" },
  "purchase_order.cancelled": { creates: null, note: "the remainder of a purchase order is cancelled; its state is derived (purchasing.ts)" },
  "supplier_invoice.recorded": { creates: null, note: "a supplier bill: keeps what its document cannot (the order it bills, the match at the time, the claim date); the document is created by its own event beside it" },
  "supplier_invoice.voided": { creates: null, note: "a supplier bill is voided; the reversal is created by its own event beside it" },
  "supplier_payment.recorded": { creates: null, note: "a supplier is paid: ties the money-out movement to the bills it was allocated to; the movement and allocations are created by their own events beside it" },
  "item.created": { creates: "item", note: "one eng_item (its reorder level and preferred supplier live in this event and in later item.revised events)" },
  "item.revised": { creates: null, note: "a change to an item's name, reorder level, preferred supplier or active flag; creates no fact row, because the current profile is DERIVED (stock.ts)" },
  "location.created": { creates: "location", note: "one eng_location" },
  "stock.received": { creates: "stock_move", note: "one eng_stock_move of kind receive" },
  "stock.issued": { creates: "stock_move", note: "one eng_stock_move of kind issue, with the weighted average cost stamped at that moment" },
  "stock.transferred_out": { creates: "stock_move", note: "one eng_stock_move of kind transfer_out (the first leg of a transfer; it moves quantity, not value)" },
  "stock.transferred_in": { creates: "stock_move", note: "one eng_stock_move of kind transfer_in, paired with its transfer_out" },
  "stock.adjusted": { creates: "stock_move", note: "one eng_stock_move of kind adjust_in or adjust_out, always with a reason" },
  "stock.move_reversed": { creates: "stock_move", note: "one eng_stock_move of kind reversal_in or reversal_out that mirrors the movement it reverses" },
  "operation.executed": { creates: null, note: "the record that an approved proposal executed; it creates no fact" },
};
const FACT_TABLE: Record<FactKind, string> = { party: "eng_party", document: "eng_document", movement: "eng_money_movement", allocation: "eng_allocation", reversal: "eng_reversal", item: "eng_item", location: "eng_location", stock_move: "eng_stock_move" };

const many = async <T>(env: Env, sql: string, ...binds: unknown[]): Promise<T[]> => ((await env.OFFICE_DB.prepare(sql).bind(...binds).all<T>()).results ?? []);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const sortedRoles = (v: unknown): string[] | null => (Array.isArray(v) && v.every((r) => typeof r === "string") ? [...(v as string[])].sort() : null);

export async function verifyIntegrity(env: Env): Promise<{ ok: boolean; problems: IntegrityProblem[]; warnings: IntegrityWarning[] }> {
  const problems: IntegrityProblem[] = [];
  const warnings: IntegrityWarning[] = [];

  // every relationship points at something that exists
  try {
    const orphans = await many<Record<string, unknown>>(env, "PRAGMA foreign_key_check");
    for (const o of orphans.filter((r) => String(r.table ?? "").startsWith("eng_"))) problems.push({ code: "orphan", detail: `${o.table} row ${o.rowid} points at a missing ${o.parent}` });
  } catch { /* a database that cannot answer the pragma is not reported as broken */ }

  // ---- the events: each is parsed once; an unmodelled type is a warning, a payload that is not a JSON object is a violation -------------------------------------------------------------------------------------
  const events = new Map<number, { type: string; payload: Record<string, unknown> | null }>();
  for (const e of await many<{ id: number; type: string; payload_json: string | null }>(env, "SELECT id, type, payload_json FROM eng_event ORDER BY id")) {
    let payload: Record<string, unknown> | null = null;
    try { const v = JSON.parse(e.payload_json ?? ""); if (v && typeof v === "object" && !Array.isArray(v)) payload = v as Record<string, unknown>; } catch { /* malformed: reported next */ }
    if (payload === null) problems.push({ code: "event_payload_malformed", detail: `event ${e.id} (${e.type}) has a payload that is not a JSON object` });
    if (!(e.type in EVENT_MODEL)) warnings.push({ code: "event_type_not_modelled", detail: `event ${e.id} has type ${e.type}, which the integrity model does not know` });
    events.set(e.id, { type: e.type, payload });
  }

  // ---- event to fact: a modelled fact-creating event needs EXACTLY ONE fact row ----------------------------------------------------------------------------------------------------------------------------------------
  const counts = new Map<FactKind, Map<number, number>>();
  for (const kind of Object.keys(FACT_TABLE) as FactKind[]) {
    const m = new Map<number, number>();
    for (const r of await many<{ e: number; n: number }>(env, `SELECT event_id AS e, COUNT(*) AS n FROM ${FACT_TABLE[kind]} GROUP BY event_id`)) m.set(Number(r.e), Number(r.n));
    counts.set(kind, m);
  }
  for (const [id, ev] of events) {
    const model = EVENT_MODEL[ev.type];
    if (!model || model.creates === null) continue;
    const n = counts.get(model.creates)?.get(id) ?? 0;
    if (n === 0) problems.push({ code: "event_without_fact", detail: `event ${id} (${ev.type}) has no ${FACT_TABLE[model.creates]} row: the fact was deleted or never written` });
    else if (n > 1) problems.push({ code: "event_multiple_facts", detail: `event ${id} (${ev.type}) has ${n} ${FACT_TABLE[model.creates]} rows, expected exactly one` });
  }
  // fact to event: the event must exist and be the kind that creates this kind of fact
  const wrongEvent = (kind: string, id: number, eventId: number, expected: string[]) => {
    const ev = events.get(eventId);
    if (!ev) { problems.push({ code: "fact_wrong_event", detail: `${kind} ${id} points at event ${eventId}, which does not exist` }); return null; }
    if (!expected.includes(ev.type)) { problems.push({ code: "fact_wrong_event", detail: `${kind} ${id} points at event ${eventId} of type ${ev.type}, expected ${expected.join(" or ")}` }); return null; }
    return ev;
  };

  // parties and their roles
  const parties = await many<{ id: number; kind: string; name: string; event_id: number }>(env, "SELECT id, kind, name, event_id FROM eng_party");
  const roleRows = await many<{ party_id: number; role: string; event_id: number }>(env, "SELECT party_id, role, event_id FROM eng_party_role");
  for (const p of parties) {
    const ev = wrongEvent("party", p.id, p.event_id, ["party.created"]);
    if (!ev) continue;
    const s = ev.payload;
    if (!s || !same([s.kind, s.name], [p.kind, p.name])) problems.push({ code: "fact_changed", detail: `party ${p.id} no longer matches what was recorded` });
    const recorded = sortedRoles(s?.roles), actual = roleRows.filter((r) => r.party_id === p.id && r.event_id === p.event_id).map((r) => r.role).sort();
    if (recorded === null || !same(recorded, actual)) problems.push({ code: "fact_changed", detail: `party ${p.id}'s roles no longer match what was recorded` });
  }
  for (const r of roleRows) {
    wrongEvent("party role", r.party_id, r.event_id, ["party.created"]);
    if (!parties.some((p) => p.id === r.party_id && p.event_id === r.event_id)) problems.push({ code: "fact_wrong_event", detail: `role ${r.role} of party ${r.party_id} is not carried by the event that created that party` });
  }

  // payments
  const movements = await many<{ id: number; direction: string; party_id: number; amount_minor: number; currency: string; occurred_on: string; method: string | null; event_id: number }>(env,
    "SELECT id, direction, party_id, amount_minor, currency, occurred_on, method, event_id FROM eng_money_movement");
  for (const m of movements) {
    const ev = wrongEvent("payment", m.id, m.event_id, [m.direction === "in" ? "payment.recorded" : "payment.made"]);
    if (!ev) continue;
    const s = ev.payload;
    if (!s || !same([s.direction, s.partyId, s.amountMinor, s.currency, s.occurredOn, s.method ?? null], [m.direction, m.party_id, m.amount_minor, m.currency, m.occurred_on, m.method])) problems.push({ code: "fact_changed", detail: `payment ${m.id} no longer matches what was recorded` });
  }

  // allocations
  const allocations = await many<{ id: number; movement_id: number; document_id: number; amount_minor: number; event_id: number }>(env, "SELECT id, movement_id, document_id, amount_minor, event_id FROM eng_allocation");
  for (const a of allocations) {
    const ev = wrongEvent("allocation", a.id, a.event_id, ["payment.allocated"]);
    if (!ev) continue;
    const s = ev.payload;
    if (!s || !same([s.movementId, s.documentId, s.amountMinor], [a.movement_id, a.document_id, a.amount_minor])) problems.push({ code: "fact_changed", detail: `allocation ${a.id} no longer matches what was recorded` });
  }

  // documents, with their lines
  const documents = await many<{ id: number; kind: string; direction: string; party_id: number; currency: string; reference: string | null; issued_on: string; event_id: number }>(env,
    "SELECT id, kind, direction, party_id, currency, reference, issued_on, event_id FROM eng_document");
  for (const d of documents) {
    const lines = await many<{ description: string; quantity_milli: number; unit: string | null; unit_price_minor: number; tax_bp: number }>(env, "SELECT description, quantity_milli, unit, unit_price_minor, tax_bp FROM eng_document_line WHERE document_id = ? ORDER BY line_no", d.id);
    const ev = wrongEvent("document", d.id, d.event_id, ["document.issued"]);
    if (!ev) continue;
    const s = ev.payload;
    const asRecorded = lines.map((l) => ({ description: l.description, quantityMilli: l.quantity_milli, unit: l.unit, unitPriceMinor: l.unit_price_minor, taxBp: l.tax_bp }));
    let totals: unknown = null;
    try { totals = sumTotals(asRecorded); } catch { /* a line that cannot be totalled is reported below as changed */ }
    if (!s || !same([s.kind, s.direction, s.partyId, s.currency, s.issuedOn, s.reference ?? null, s.lines, s.totals], [d.kind, d.direction, d.party_id, d.currency, d.issued_on, d.reference ?? null, asRecorded, totals])) problems.push({ code: "fact_changed", detail: `document ${d.id} or its lines no longer match what was issued` });
  }

  // reversals: each row must be the kind its event says, and say what its event says
  const reversals = await many<{ id: number; movement_id: number | null; allocation_id: number | null; document_id: number | null; reason: string; replaced_by_movement_id: number | null; event_id: number }>(env,
    "SELECT id, movement_id, allocation_id, document_id, reason, replaced_by_movement_id, event_id FROM eng_reversal");
  for (const r of reversals) {
    const kindOf = r.movement_id !== null ? "payment.reversed" : r.allocation_id !== null ? "payment.allocation_reversed" : "document.reversed";
    const ev = wrongEvent("reversal", r.id, r.event_id, [kindOf]);
    if (!ev) continue;
    const s = ev.payload;
    const matches = !!s && s.reason === r.reason && (kindOf === "payment.reversed" ? s.movementId === r.movement_id && (s.replacedByMovementId ?? null) === (r.replaced_by_movement_id ?? null) : kindOf === "payment.allocation_reversed" ? s.allocationId === r.allocation_id : s.documentId === r.document_id);
    if (!matches) problems.push({ code: "reversal_mismatch", detail: `reversal ${r.id} (${kindOf}) no longer says what its event recorded` });
  }

  // ---- conservation: nothing is over-allocated, and nothing is allocated to something reversed -----------------------------------------------------------------------------------------------------------------------------
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

  // ---- numbering: each kind runs 1..n with no hole, and every document has its number -----------------------------------------------------------------------------------------------------------------------------------
  for (const k of await many<{ kind: string; n: number; lo: number; hi: number }>(env, "SELECT kind, COUNT(*) AS n, MIN(number) AS lo, MAX(number) AS hi FROM eng_document_number GROUP BY kind")) {
    if (k.lo !== 1 || k.hi !== k.n) problems.push({ code: "number_gap", detail: `${k.kind} numbers run ${k.lo} to ${k.hi} but there are ${k.n}` });
  }
  const unnumbered = await many<{ id: number }>(env, "SELECT d.id FROM eng_document d WHERE NOT EXISTS (SELECT 1 FROM eng_document_number n WHERE n.document_id = d.id)");
  for (const u of unnumbered) problems.push({ code: "number_gap", detail: `document ${u.id} has no number` });

  // revisions: a party.revised event creates no fact, but it must point at a party that exists
  const known = new Set((await many<{ id: number }>(env, "SELECT id FROM eng_party")).map((p) => p.id));
  for (const e of await many<{ id: number; payload_json: string }>(env, "SELECT id, payload_json FROM eng_event WHERE type = 'party.revised'")) {
    let pid: unknown = null;
    try { pid = JSON.parse(e.payload_json)?.partyId; } catch { /* a malformed payload is reported by the payload check */ }
    if (typeof pid !== "number" || !known.has(pid)) problems.push({ code: "orphan", detail: `event ${e.id} revises party ${String(pid)}, which does not exist` });
  }

  // quotations: a revision or acceptance must point at quotation documents that exist, and a quotation may be replaced only once (no forked chain)
  const quoteIds = new Set((await many<{ id: number }>(env, "SELECT id FROM eng_document WHERE kind = 'quotation'")).map((d) => d.id));
  const replaced = new Map<number, number>();
  for (const e of await many<{ id: number; type: string; payload_json: string }>(env, "SELECT id, type, payload_json FROM eng_event WHERE type IN ('quotation.revised', 'quotation.accepted') ORDER BY id")) {
    let p: { documentId?: unknown; supersedes?: unknown } = {};
    try { p = JSON.parse(e.payload_json) ?? {}; } catch { /* a malformed payload is reported by the payload check */ }
    const refs = e.type === "quotation.revised" ? [p.documentId, p.supersedes] : [p.documentId];
    for (const ref of refs) if (typeof ref !== "number" || !quoteIds.has(ref)) problems.push({ code: "orphan", detail: `event ${e.id} (${e.type}) points at quotation ${String(ref)}, which does not exist` });
    if (e.type === "quotation.revised" && typeof p.supersedes === "number") {
      if (replaced.has(p.supersedes)) problems.push({ code: "orphan", detail: `quotation ${p.supersedes} is replaced more than once (events ${replaced.get(p.supersedes)} and ${e.id}): a forked chain` });
      else replaced.set(p.supersedes, e.id);
    }
  }

  // credit notes: the event must point at a credit_note document, an existing invoice and an existing movement, and what was applied plus what stays unapplied must equal the credit note's total and the movement
  const creditDocs = new Set((await many<{ id: number }>(env, "SELECT id FROM eng_document WHERE kind = 'credit_note'")).map((d) => d.id));
  const allDocs = new Set((await many<{ id: number }>(env, "SELECT id FROM eng_document")).map((d) => d.id));
  const creditMovements = new Map((await many<{ id: number; amount_minor: number }>(env, "SELECT id, amount_minor FROM eng_money_movement")).map((m) => [m.id, m.amount_minor]));
  for (const e of await many<{ id: number; payload_json: string }>(env, "SELECT id, payload_json FROM eng_event WHERE type = 'credit_note.issued' ORDER BY id")) {
    let p: { documentId?: unknown; invoiceId?: unknown; movementId?: unknown; appliedMinor?: unknown; unappliedMinor?: unknown } = {};
    try { p = JSON.parse(e.payload_json) ?? {}; } catch { /* a malformed payload is reported by the payload check */ }
    let ok = true;
    if (typeof p.documentId !== "number" || !creditDocs.has(p.documentId)) { problems.push({ code: "orphan", detail: `event ${e.id} (credit_note.issued) points at credit note ${String(p.documentId)}, which does not exist` }); ok = false; }
    if (typeof p.invoiceId !== "number" || !allDocs.has(p.invoiceId)) { problems.push({ code: "orphan", detail: `event ${e.id} (credit_note.issued) credits invoice ${String(p.invoiceId)}, which does not exist` }); ok = false; }
    if (typeof p.movementId !== "number" || !creditMovements.has(p.movementId)) { problems.push({ code: "orphan", detail: `event ${e.id} (credit_note.issued) points at movement ${String(p.movementId)}, which does not exist` }); ok = false; }
    if (ok) {
      const gross = (await docTotals(env, p.documentId as number)).grossMinor;
      if (Number(p.appliedMinor) + Number(p.unappliedMinor) !== gross || creditMovements.get(p.movementId as number) !== gross) problems.push({ code: "orphan", detail: `credit note ${p.documentId}: the applied and unapplied amounts do not add up to its total ${gross} and its movement` });
    }
  }

  // the tax lock only moves forward
  let lockSeen: string | null = null;
  for (const e of await many<{ id: number; payload_json: string }>(env, "SELECT id, payload_json FROM eng_event WHERE type = 'tax_lock.set' ORDER BY id")) {
    let d: unknown = null;
    try { d = JSON.parse(e.payload_json)?.lockDate; } catch { /* a malformed payload is reported by the payload check */ }
    if (typeof d !== "string") { problems.push({ code: "orphan", detail: `event ${e.id} (tax_lock.set) has no lock date` }); continue; }
    if (lockSeen !== null && d <= lockSeen) problems.push({ code: "orphan", detail: `event ${e.id}: the tax lock moved from ${lockSeen} to ${d}, which is not forward (a lock only moves forward)` });
    else lockSeen = d;
  }

  // credit applications, refunds and voids, and debit notes: references must exist, and a credit note's credit can never be spent more than once
  const spent = new Map<number, number>();
  const allocs = new Set((await many<{ id: number }>(env, "SELECT id FROM eng_allocation")).map((a) => a.id));
  const reversed = new Set((await many<{ document_id: number | null }>(env, "SELECT document_id FROM eng_reversal WHERE document_id IS NOT NULL")).map((r) => Number(r.document_id)));
  const reversedAllocs = new Set((await many<{ allocation_id: number | null }>(env, "SELECT allocation_id FROM eng_reversal WHERE allocation_id IS NOT NULL")).map((r) => Number(r.allocation_id)));
  const reversedMovs = new Set((await many<{ movement_id: number | null }>(env, "SELECT movement_id FROM eng_reversal WHERE movement_id IS NOT NULL")).map((r) => Number(r.movement_id)));
  for (const e of await many<{ id: number; type: string; payload_json: string }>(env, "SELECT id, type, payload_json FROM eng_event WHERE type IN ('credit.allocated', 'credit.refunded', 'credit_note.voided', 'debit_note.issued') ORDER BY id")) {
    let p: Record<string, unknown> = {};
    try { p = JSON.parse(e.payload_json) ?? {}; } catch { /* a malformed payload is reported by the payload check */ }
    const missing = (what: string, v: unknown) => problems.push({ code: "orphan", detail: `event ${e.id} (${e.type}) points at ${what} ${String(v)}, which does not exist` });
    if (e.type === "debit_note.issued") {
      if (typeof p.documentId !== "number" || !allDocs.has(p.documentId)) missing("debit note", p.documentId);
      if (typeof p.invoiceId !== "number" || !allDocs.has(p.invoiceId)) missing("invoice", p.invoiceId);
      continue;
    }
    const cnKey = e.type === "credit_note.voided" ? p.documentId : p.creditNoteId;
    if (typeof cnKey !== "number" || !creditDocs.has(cnKey)) { missing("credit note", cnKey); continue; }
    if (e.type === "credit.allocated") {
      if (typeof p.invoiceId !== "number" || !allDocs.has(p.invoiceId)) missing("invoice", p.invoiceId);
      if (typeof p.allocationId !== "number" || !allocs.has(p.allocationId)) missing("allocation", p.allocationId);
      if (!reversedAllocs.has(Number(p.allocationId))) spent.set(cnKey, (spent.get(cnKey) ?? 0) + (Number(p.amountMinor) || 0));
    } else if (e.type === "credit.refunded") {
      if (typeof p.refundMovementId !== "number" || !creditMovements.has(p.refundMovementId)) missing("refund movement", p.refundMovementId);
      if (!reversedMovs.has(Number(p.refundMovementId))) spent.set(cnKey, (spent.get(cnKey) ?? 0) + (Number(p.amountMinor) || 0));
    } else if (!reversed.has(cnKey)) problems.push({ code: "orphan", detail: `event ${e.id} (credit_note.voided): credit note ${cnKey} is not reversed` });
  }
  for (const [cnId, amount] of spent) { const g = (await docTotals(env, cnId)).grossMinor; if (amount > g) problems.push({ code: "orphan", detail: `credit note ${cnId}: applications and refunds together (${amount}) spend more than the credit note's total ${g}` }); }

  // payments (overpayments): an allocation or refund must point at a payment, invoice, allocation or refund movement that exists, and together they can never spend more than the payment, counting only what is still in force
  const payAlloc = new Map<number, number>();
  for (const e of await many<{ id: number; type: string; payload_json: string }>(env, "SELECT id, type, payload_json FROM eng_event WHERE type IN ('overpayment.allocated', 'overpayment.refunded') ORDER BY id")) {
    let p: Record<string, unknown> = {};
    try { p = JSON.parse(e.payload_json) ?? {}; } catch { /* a malformed payload is reported by the payload check */ }
    const gone = (what: string, v: unknown) => problems.push({ code: "orphan", detail: `event ${e.id} (${e.type}) points at ${what} ${String(v)}, which does not exist` });
    if (typeof p.movementId !== "number" || !creditMovements.has(p.movementId)) { gone("payment", p.movementId); continue; }
    if (e.type === "overpayment.allocated") {
      if (typeof p.invoiceId !== "number" || !allDocs.has(p.invoiceId)) gone("invoice", p.invoiceId);
      if (typeof p.allocationId !== "number" || !allocs.has(p.allocationId)) gone("allocation", p.allocationId);
      if (!reversedAllocs.has(Number(p.allocationId))) payAlloc.set(p.movementId, (payAlloc.get(p.movementId) ?? 0) + (Number(p.amountMinor) || 0));
    } else {
      if (typeof p.refundMovementId !== "number" || !creditMovements.has(p.refundMovementId)) gone("refund movement", p.refundMovementId);
      if (!reversedMovs.has(Number(p.refundMovementId))) payAlloc.set(p.movementId, (payAlloc.get(p.movementId) ?? 0) + (Number(p.amountMinor) || 0));
    }
  }
  for (const [mvId, amount] of payAlloc) { const total = creditMovements.get(mvId) ?? 0; if (amount > total) problems.push({ code: "orphan", detail: `payment ${mvId}: allocations and refunds together (${amount}) spend more than the payment's ${total}` }); }

  // expenses: an expense must point at an expense document, an existing supplier and a money-out movement that is exactly what was paid; a void must point at an expense that really was reversed
  const expenseDocs = new Set((await many<{ id: number }>(env, "SELECT id FROM eng_document WHERE kind = 'expense'")).map((d) => d.id));
  for (const e of await many<{ id: number; type: string; payload_json: string }>(env, "SELECT id, type, payload_json FROM eng_event WHERE type IN ('expense.recorded', 'expense.voided') ORDER BY id")) {
    let p: Record<string, unknown> = {};
    try { p = JSON.parse(e.payload_json) ?? {}; } catch { /* a malformed payload is reported by the payload check */ }
    if (typeof p.documentId !== "number" || !expenseDocs.has(p.documentId)) { problems.push({ code: "orphan", detail: `event ${e.id} (${e.type}) points at expense ${String(p.documentId)}, which does not exist` }); continue; }
    if (e.type === "expense.recorded") {
      if (typeof p.supplierId !== "number" || !known.has(p.supplierId)) problems.push({ code: "orphan", detail: `event ${e.id} (expense.recorded) points at supplier ${String(p.supplierId)}, which does not exist` });
      if (typeof p.movementId !== "number" || !creditMovements.has(p.movementId)) problems.push({ code: "orphan", detail: `event ${e.id} (expense.recorded) points at movement ${String(p.movementId)}, which does not exist` });
      else if (creditMovements.get(p.movementId) !== Number(p.amountPaidMinor)) problems.push({ code: "orphan", detail: `expense ${p.documentId}: the amount paid (${String(p.amountPaidMinor)}) does not match its money-out movement (${creditMovements.get(p.movementId)})` });
    } else if (!reversed.has(p.documentId)) problems.push({ code: "orphan", detail: `event ${e.id} (expense.voided): expense ${p.documentId} is not reversed` });
  }

  // purchasing: a receipt or cancellation must point at a purchase order that exists, receipts can never add up to more than a line ordered, nothing is received after a cancellation, and an order is cancelled once
  const orderDocs = new Map((await many<{ id: number; party_id: number }>(env, "SELECT id, party_id FROM eng_document WHERE kind = 'purchase_order'")).map((d) => [d.id, d.party_id]));
  const receiptDocs = new Set((await many<{ id: number }>(env, "SELECT id FROM eng_document WHERE kind = 'goods_receipt'")).map((d) => d.id));
  const orderedQty = new Map<string, number>();
  for (const l of await many<{ document_id: number; line_no: number; quantity_milli: number }>(env, "SELECT document_id, line_no, quantity_milli FROM eng_document_line")) if (orderDocs.has(l.document_id)) orderedQty.set(`${l.document_id}:${l.line_no}`, l.quantity_milli);
  const gotQty = new Map<string, number>(); const cancelledAt = new Map<number, number>();
  for (const e of await many<{ id: number; type: string; payload_json: string }>(env, "SELECT id, type, payload_json FROM eng_event WHERE type IN ('goods.received', 'purchase_order.cancelled') ORDER BY id")) {
    let p: Record<string, unknown> = {};
    try { p = JSON.parse(e.payload_json) ?? {}; } catch { /* a malformed payload is reported by the payload check */ }
    const orderKey = e.type === "goods.received" ? p.orderId : p.documentId;
    if (typeof orderKey !== "number" || !orderDocs.has(orderKey)) { problems.push({ code: "orphan", detail: `event ${e.id} (${e.type}) points at purchase order ${String(orderKey)}, which does not exist` }); continue; }
    if (e.type === "purchase_order.cancelled") {
      if (cancelledAt.has(orderKey)) problems.push({ code: "orphan", detail: `purchase order ${orderKey} is cancelled more than once (events ${cancelledAt.get(orderKey)} and ${e.id})` });
      else cancelledAt.set(orderKey, e.id);
      continue;
    }
    if (typeof p.documentId !== "number" || !receiptDocs.has(p.documentId)) { problems.push({ code: "orphan", detail: `event ${e.id} (goods.received) points at receipt ${String(p.documentId)}, which does not exist` }); continue; }
    if (cancelledAt.has(orderKey)) problems.push({ code: "orphan", detail: `goods were received on purchase order ${orderKey} after it was cancelled (event ${e.id})` });
    for (const l of Array.isArray(p.lines) ? (p.lines as Array<{ lineNo?: number; quantityMilli?: number }>) : []) {
      const k = `${orderKey}:${l.lineNo}`;
      gotQty.set(k, (gotQty.get(k) ?? 0) + (Number(l.quantityMilli) || 0));
      if ((gotQty.get(k) ?? 0) > (orderedQty.get(k) ?? 0)) problems.push({ code: "orphan", detail: `purchase order ${orderKey} line ${l.lineNo}: receipts add up to more than was ordered (${gotQty.get(k)} against ${orderedQty.get(k) ?? 0})` });
    }
  }

  // supplier bills and payments: a bill event must point at a supplier_invoice document, a supplier and (if any) an order that exist; a void at a bill that exists and is reversed; a supplier payment at a movement that exists and whose allocations add up to it
  const billDocs = new Set((await many<{ id: number }>(env, "SELECT id FROM eng_document WHERE kind = 'supplier_invoice'")).map((d) => d.id));
  for (const e of await many<{ id: number; type: string; payload_json: string }>(env, "SELECT id, type, payload_json FROM eng_event WHERE type IN ('supplier_invoice.recorded', 'supplier_invoice.voided', 'supplier_payment.recorded') ORDER BY id")) {
    let p: Record<string, unknown> = {};
    try { p = JSON.parse(e.payload_json) ?? {}; } catch { /* a malformed payload is reported by the payload check */ }
    const gone = (what: string, v: unknown) => problems.push({ code: "orphan", detail: `event ${e.id} (${e.type}) points at ${what} ${String(v)}, which does not exist` });
    if (e.type === "supplier_payment.recorded") {
      if (typeof p.movementId !== "number" || !creditMovements.has(p.movementId)) { gone("money movement", p.movementId); continue; }
      let sum = 0;
      for (const a of Array.isArray(p.allocations) ? (p.allocations as Array<{ billId?: unknown; amountMinor?: unknown }>) : []) { if (typeof a.billId !== "number" || !billDocs.has(a.billId)) gone("bill", a.billId); sum += Number(a.amountMinor) || 0; }
      if (sum !== creditMovements.get(p.movementId)) problems.push({ code: "orphan", detail: `event ${e.id} (supplier_payment.recorded): its allocations (${sum}) do not add up to the money-out movement (${creditMovements.get(p.movementId)})` });
      continue;
    }
    if (typeof p.documentId !== "number" || !billDocs.has(p.documentId)) { gone("bill", p.documentId); continue; }
    if (e.type === "supplier_invoice.recorded") {
      if (typeof p.supplierId !== "number" || !known.has(p.supplierId)) gone("supplier", p.supplierId);
      if (p.orderId !== undefined && (typeof p.orderId !== "number" || !orderDocs.has(p.orderId))) gone("purchase order", p.orderId);
    } else if (!reversed.has(p.documentId)) problems.push({ code: "orphan", detail: `event ${e.id} (supplier_invoice.voided): bill ${p.documentId} is not reversed` });
  }

  // stock: every item, location and movement carries an event of the right kind that says what the row says; and the invariants of the ledger (docs/decisions/inventory.md section 5)
  const stockEventFor: Record<string, string[]> = { receive: ["stock.received"], issue: ["stock.issued"], transfer_out: ["stock.transferred_out"], transfer_in: ["stock.transferred_in"], adjust_in: ["stock.adjusted"], adjust_out: ["stock.adjusted"], reversal_in: ["stock.move_reversed"], reversal_out: ["stock.move_reversed"] };
  for (const it of await many<{ id: number; sku: string; name: string; unit: string; event_id: number }>(env, "SELECT id, sku, name, unit, event_id FROM eng_item")) {
    const ev = wrongEvent("item", it.id, it.event_id, ["item.created"]);
    if (ev && (!ev.payload || !same([ev.payload.sku, ev.payload.name, ev.payload.unit], [it.sku, it.name, it.unit]))) problems.push({ code: "fact_changed", detail: `item ${it.id} no longer matches what was recorded` });
  }
  for (const l of await many<{ id: number; name: string; kind: string; event_id: number }>(env, "SELECT id, name, kind, event_id FROM eng_location")) {
    const ev = wrongEvent("location", l.id, l.event_id, ["location.created"]);
    if (ev && (!ev.payload || !same([ev.payload.name, ev.payload.kind], [l.name, l.kind]))) problems.push({ code: "fact_changed", detail: `location ${l.id} no longer matches what was recorded` });
  }
  const moves = await many<{ id: number; item_id: number; location_id: number; kind: string; quantity_milli: number; value_minor: number; occurred_on: string; source_document_id: number | null; source_line_no: number | null; pair_id: number | null; reverses_move_id: number | null; event_id: number }>(env, "SELECT id, item_id, location_id, kind, quantity_milli, value_minor, occurred_on, source_document_id, source_line_no, pair_id, reverses_move_id, event_id FROM eng_stock_move ORDER BY id");
  const byId = new Map(moves.map((m) => [m.id, m]));
  const inKinds = new Set(["receive", "transfer_in", "adjust_in", "reversal_in"]);
  const runningQty = new Map<string, number>(), itemQty = new Map<number, number>(), itemVal = new Map<number, number>();
  const stockedFromLine = new Map<string, number>(); const transferIn = new Map<number, number>();
  for (const m of moves) {
    const ev = wrongEvent("stock movement", m.id, m.event_id, stockEventFor[m.kind] ?? []);
    if (ev && (!ev.payload || !same([ev.payload.itemId, ev.payload.locationId, ev.payload.quantityMilli, ev.payload.valueMinor, ev.payload.occurredOn], [m.item_id, m.location_id, m.quantity_milli, m.value_minor, m.occurred_on]))) problems.push({ code: "fact_changed", detail: `stock movement ${m.id} no longer matches what was recorded` });
    const sign = inKinds.has(m.kind) ? 1 : -1, key = `${m.item_id}:${m.location_id}`;
    const q = (runningQty.get(key) ?? 0) + sign * m.quantity_milli; runningQty.set(key, q);
    if (q < 0) problems.push({ code: "stock_invariant", detail: `item ${m.item_id} goes negative (${q} thousandths) at location ${m.location_id} on movement ${m.id}` });
    const tq = (itemQty.get(m.item_id) ?? 0) + sign * m.quantity_milli, tv = (itemVal.get(m.item_id) ?? 0) + sign * m.value_minor; itemQty.set(m.item_id, tq); itemVal.set(m.item_id, tv);
    if (tv < 0) problems.push({ code: "stock_invariant", detail: `item ${m.item_id} has negative value (${tv}) after movement ${m.id}` });
    if (tq === 0 && tv !== 0) problems.push({ code: "stock_invariant", detail: `item ${m.item_id} has no stock but value ${tv} left after movement ${m.id}: value must reach exactly zero with the quantity` });
    if (m.kind === "reversal_in" || m.kind === "reversal_out") {
      const o = m.reverses_move_id === null ? undefined : byId.get(m.reverses_move_id);
      if (!o) problems.push({ code: "reversal_mismatch", detail: `stock movement ${m.id} reverses movement ${String(m.reverses_move_id)}, which does not exist` });
      else if (o.item_id !== m.item_id || o.location_id !== m.location_id || o.quantity_milli !== m.quantity_milli || o.value_minor !== m.value_minor || inKinds.has(o.kind) === inKinds.has(m.kind) || o.kind.startsWith("transfer") || o.kind.startsWith("reversal")) problems.push({ code: "reversal_mismatch", detail: `stock movement ${m.id} does not mirror the movement ${o.id} it reverses` });
    }
    if (m.kind === "transfer_in") {
      const o = m.pair_id === null ? undefined : byId.get(m.pair_id);
      if (!o || o.kind !== "transfer_out" || o.item_id !== m.item_id || o.quantity_milli !== m.quantity_milli || o.location_id === m.location_id) problems.push({ code: "stock_invariant", detail: `transfer movement ${m.id} is not paired with a matching transfer out` });
      else transferIn.set(o.id, (transferIn.get(o.id) ?? 0) + 1);
    }
    if (m.source_document_id !== null && m.source_line_no !== null && (m.kind === "receive" || m.kind === "reversal_out")) { const k = `${m.source_document_id}:${m.source_line_no}`; stockedFromLine.set(k, (stockedFromLine.get(k) ?? 0) + (m.kind === "receive" ? m.quantity_milli : -m.quantity_milli)); }
  }
  for (const m of moves) if (m.kind === "transfer_out" && (transferIn.get(m.id) ?? 0) !== 1) problems.push({ code: "stock_invariant", detail: `transfer out ${m.id} has ${transferIn.get(m.id) ?? 0} matching transfers in, expected exactly one` });
  for (const [k, n] of stockedFromLine) { const [d, l] = k.split(":").map(Number); const line = (await many<{ quantity_milli: number }>(env, "SELECT quantity_milli FROM eng_document_line WHERE document_id = ? AND line_no = ?", d, l))[0]; if (!line || n > line.quantity_milli) problems.push({ code: "stock_invariant", detail: `goods receipt ${d} line ${l}: more was put into stock (${n}) than the line received (${line?.quantity_milli ?? 0})` }); }

  return { ok: problems.length === 0, problems, warnings };
}
