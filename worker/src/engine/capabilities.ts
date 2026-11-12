// The engine's capabilities: two READS (receivables.query, records.get) and three held WRITES (payment.record, payment.correct, invoice.issue). Each declares what it needs in the ENGINE's permission vocabulary,
// validates its input strictly (a field nobody declared is refused, text is never coerced), and says what "valid now" means for it. A write is held for approval and carries the version of the facts it was proposed
// against (and, for a payment, the EXACT allocations the approver is approving): at confirm the check runs again inside the transaction, so an approval is only ever for what it showed.
// What a document KIND means is not decided here; whether a kind is settled by money is the business's configuration (config.ts).
import type { Env } from "../types";
import type { CapabilityContract } from "../capability-contract";
import { EngineError } from "./errors";
import * as facts from "./facts";
import { isEffective, outstandingForDocument, outstandingForParty } from "./ledger";
import { issueDraft, readDraft } from "./drafts";
import { RECORD_KINDS, recordView, versionOf, type RecordKind, type ViewerContext } from "./records";
import type { EnginePermission } from "./permissions";
import { unappliedCreditForParty } from "./ledger";
import { allQuotations, checkDate, checkLines, checkReference, planQuotationAcceptance, planQuotationRevision, type QuoteLine } from "./quotations";
import { documentTotals as sumTotals } from "./money";
import { applyProfile, businessProfile, checkProfileChange, taxLockDate, vatSummary, type ProfileChange } from "./business";
import { movementAvailable, planPaymentAllocation, planPaymentRefund, refundMovementOrThrow } from "./credits";
import { checkPriceInput, checkReturnInput, fulfilment, marginReport, planPrice, planReturn, priceHistory, priceInForce, type PriceInput, type ReturnInput } from "./stock";
import { checkDeliveryInput, checkLineItems, planDelivery, planLineItems, type DeliveryInput, type OrderLineItem } from "./stock";
import { goodsUnbilled } from "./bills";
import { allReservations, checkCountInput, checkReleaseInput, checkReserveInput, planCount, planRelease, planReserve, reorderSuggestions, reservationDocument, type CountInput, type ReleaseInput, type ReserveInput } from "./stock";
import { ADJUST_REASONS, allItemIds, allLocations, checkAdjustInput, checkIssueInput, checkItemInput, checkItemRevision, checkLocationInput, checkReceiveInput, checkReverseInput as checkStockReverse, checkTransferInput, itemProfile, planAdjust, planIssue, planItem, planItemRevision, planLocation, planReceive, planReverse, planTransfer, stockLedger, stockReport, type AdjustInput, type IssueInput, type ItemInput, type ItemRevision, type LocationInput, type ReceiveInput, type StockReverseInput, type TransferInput } from "./stock";
import { history as recordHistory } from "./records";
import { allBills, checkBillInput, planBill, planBillVoid, planSupplierPayment, type BillInput } from "./bills";
import { allOrders, checkReceiptLines, checkShortText, planCancel, planOrder, planReceipt, type ReceiptLineInput } from "./purchasing";
import { allExpenses, checkExpenseInput, EXPENSE_CATEGORIES, planExpense, planExpenseVoid, type ExpenseInput } from "./expenses";
import { creditAvailable, debitsOf, planCreditApplication, planDebitNote, planRefund, planVoid } from "./credits";
import { checkCreditLines, checkReason, planCreditNote, type CreditLineInput } from "./credits";
import { allProfiles, applyRevision, checkContact, checkName, checkRoles, holderOfName, partyProfile, PARTY_ROLES, sameName } from "./parties";

type Checked<T> = { ok: true; value: T } | { ok: false; reason: string };
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const whole = (v: unknown, min = 1): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= min;
const isDate = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && new Date(v + "T00:00:00Z").toISOString().slice(0, 10) === v;
const stray = (o: Record<string, unknown>, allowed: readonly string[]): string | undefined => Object.keys(o).find((k) => o[k] !== undefined && !allowed.includes(k));
const one = <T>(env: Env, sql: string, ...binds: unknown[]) => env.OFFICE_DB.prepare(sql).bind(...binds).first<T>();
const many = async <T>(env: Env, sql: string, ...binds: unknown[]): Promise<T[]> => ((await env.OFFICE_DB.prepare(sql).bind(...binds).all<T>()).results ?? []);

// ---- reads -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
export class Ambiguous extends Error {
  readonly candidates: Array<{ id: number; name: string }>;
  constructor(candidates: Array<{ id: number; name: string }>) { super("more than one match"); this.candidates = candidates; }
}
export interface ReadCapability<P> {
  id: string;
  label: string;
  permissions: readonly EnginePermission[];
  validate(params: unknown): Checked<P>;
  run(env: Env, viewer: ViewerContext, value: P): Promise<unknown>;
}

export const receivablesQuery: ReadCapability<{ partyId?: number; partyName?: string }> = {
  id: "receivables.query",
  label: "Reading what a customer owes",
  permissions: ["receivables.read"],
  validate(params) {
    if (!isObj(params)) return { ok: false, reason: "the request must be an object" };
    const s = stray(params, ["partyId", "partyName"]);
    if (s) return { ok: false, reason: `${s} is not a field of this request` };
    const hasId = params.partyId !== undefined, hasName = params.partyName !== undefined;
    if (hasId === hasName) return { ok: false, reason: "give either partyId or partyName" };
    if (hasId) return whole(params.partyId) ? { ok: true, value: { partyId: params.partyId } } : { ok: false, reason: "partyId must be a record number" };
    return typeof params.partyName === "string" && params.partyName.trim() ? { ok: true, value: { partyName: params.partyName.trim() } } : { ok: false, reason: "partyName must be text" };
  },
  async run(env, _viewer, value) {
    let party: { id: number; name: string } | null;
    if (value.partyId !== undefined) { const p = await partyProfile(env, value.partyId); party = p ? { id: p.id, name: p.name } : null; }
    else {
      const rows = (await allProfiles(env)).filter((p) => sameName(p.name, value.partyName!)).map((p) => ({ id: p.id, name: p.name }));
      if (rows.length > 1) throw new Ambiguous(rows);
      party = rows[0] ?? null;
    }
    if (!party) throw new EngineError("not_found", "There is no such customer.");
    const acct = await outstandingForParty(env, party.id);
    const currency = acct.documents[0] ? (await one<{ currency: string }>(env, "SELECT currency FROM eng_document WHERE id = ?", acct.documents[0].id))?.currency ?? null : null;
    return {
      party: { id: party.id, name: party.name }, currency, totalMinor: acct.totalMinor, unappliedCreditMinor: await unappliedCreditForParty(env, party.id),
      documents: acct.documents.map((d) => ({ ref: { kind: "document", id: d.id }, number: d.number, kind: d.kind, issuedOn: d.issuedOn, grossMinor: d.grossMinor, allocatedMinor: d.allocatedMinor, outstandingMinor: d.outstandingMinor })),
      version: await versionOf(env, { kind: "party", id: party.id }), derivedBy: "ledger.outstandingForParty",
    };
  },
};

export const recordsGet: ReadCapability<{ kind: RecordKind; id: number }> = {
  id: "records.get",
  label: "Opening a record",
  permissions: [],   // any member may ASK; what each kind of record shows, and to whom, is decided per kind (a record not visible to the member answers exactly as one that does not exist)
  validate(params) {
    if (!isObj(params)) return { ok: false, reason: "the request must be an object" };
    const s = stray(params, ["kind", "id"]);
    if (s) return { ok: false, reason: `${s} is not a field of this request` };
    if (typeof params.kind !== "string" || !(RECORD_KINDS as readonly string[]).includes(params.kind)) return { ok: false, reason: `kind must be one of ${RECORD_KINDS.join(", ")}` };
    if (!whole(params.id)) return { ok: false, reason: "id must be a record number" };
    return { ok: true, value: { kind: params.kind as RecordKind, id: params.id } };
  },
  async run(env, viewer, value) {
    const view = await recordView(env, viewer, { kind: value.kind, id: value.id });
    if (!view) throw new EngineError("not_found", "There is no such record.");
    return view;
  },
};
// Finding customers and suppliers: by part of the current name, by role, or both; with neither it lists them all (up to 50, and says when there are more).
export const partiesFind: ReadCapability<{ name?: string; role?: string }> = {
  id: "parties.find",
  label: "Finding customers and suppliers",
  permissions: ["party.read"],
  validate(params) {
    if (!isObj(params)) return { ok: false, reason: "the request must be an object" };
    const s = stray(params, ["name", "role"]);
    if (s) return { ok: false, reason: `${s} is not a field of this request` };
    const out: { name?: string; role?: string } = {};
    if (params.name !== undefined) { if (typeof params.name !== "string" || !params.name.trim()) return { ok: false, reason: "name must be text" }; out.name = params.name.trim(); }
    if (params.role !== undefined) { if (typeof params.role !== "string" || !(PARTY_ROLES as readonly string[]).includes(params.role)) return { ok: false, reason: `role must be ${PARTY_ROLES.join(" or ")}` }; out.role = params.role; }
    return { ok: true, value: out };
  },
  async run(env, _viewer, value) {
    const needle = value.name ? value.name.toLowerCase() : null;
    const hits = (await allProfiles(env)).filter((p) => (!needle || p.name.toLowerCase().includes(needle)) && (!value.role || p.roles.includes(value.role)));
    return {
      parties: hits.slice(0, 50).map((p) => ({ ref: { kind: "party", id: p.id }, id: p.id, name: p.name, kind: p.kind, roles: p.roles, contact: p.contact })),
      count: hits.length, truncated: hits.length > 50, derivedBy: "parties.allProfiles",
    };
  },
};


// ---- writes ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
const ctxOf = (c: { actionId: number; actorEmail: string | null; captureId?: number | null }, id: string) => ({ actorEmail: c.actorEmail, approvedBy: c.actorEmail, captureId: c.captureId ?? null, proposalId: c.actionId, contract: id, contractVersion: 1 });
type Allocation = { documentId: number; amountMinor: number };
const allocationsOf = (raw: unknown): Checked<Allocation[]> => {
  if (!Array.isArray(raw)) return { ok: false, reason: "allocations must be a list" };
  const out: Allocation[] = [];
  for (const a of raw) {
    if (!isObj(a) || stray(a, ["documentId", "amountMinor"]) || !whole(a.documentId) || !whole(a.amountMinor)) return { ok: false, reason: "each allocation needs a documentId and a whole amountMinor of at least 1" };
    out.push({ documentId: a.documentId, amountMinor: a.amountMinor });
  }
  return { ok: true, value: out };
};

interface PaymentRecord { partyId: number; amountMinor: number; currency: string; occurredOn: string; method?: string | null; allocations?: Allocation[]; allocate?: "oldest_first"; basedOn?: { partyVersion: number } }
export const paymentRecord: CapabilityContract<PaymentRecord> = {
  id: "payment.record", heldType: "engine.payment.record", label: "Recording a payment", requires: [], permissions: ["payment.record"], version: 1, recordsExecution: true,
  validate(payload) {
    if (!isObj(payload)) return { ok: false, reason: "the payment must be an object" };
    const s = stray(payload, ["partyId", "amountMinor", "currency", "occurredOn", "method", "allocations", "allocate", "basedOn"]);
    if (s) return { ok: false, reason: `${s} is not a field of a payment` };
    if (!whole(payload.partyId)) return { ok: false, reason: "partyId must be a record number" };
    if (!whole(payload.amountMinor)) return { ok: false, reason: "amountMinor must be a whole number of at least 1" };
    if (typeof payload.currency !== "string" || !/^[A-Z]{3}$/.test(payload.currency)) return { ok: false, reason: "currency must be a 3-letter code" };
    if (!isDate(payload.occurredOn)) return { ok: false, reason: "occurredOn must be a calendar date" };
    if (payload.method !== undefined && payload.method !== null && typeof payload.method !== "string") return { ok: false, reason: "method must be text" };
    if (payload.allocate !== undefined && payload.allocate !== "oldest_first") return { ok: false, reason: "allocate can only be oldest_first" };
    if (payload.allocate !== undefined && payload.allocations !== undefined) return { ok: false, reason: "give allocations or allocate, not both" };
    let allocations: Allocation[] | undefined;
    if (payload.allocations !== undefined) { const a = allocationsOf(payload.allocations); if (!a.ok) return a; allocations = a.value; }
    let basedOn: { partyVersion: number } | undefined;
    if (payload.basedOn !== undefined) { if (!isObj(payload.basedOn) || stray(payload.basedOn, ["partyVersion"]) || !whole(payload.basedOn.partyVersion, 0)) return { ok: false, reason: "basedOn must name the version it was proposed against" }; basedOn = { partyVersion: payload.basedOn.partyVersion as number }; }
    return { ok: true, value: { partyId: payload.partyId, amountMinor: payload.amountMinor, currency: payload.currency, occurredOn: payload.occurredOn, ...(payload.method !== undefined ? { method: payload.method as string | null } : {}), ...(allocations ? { allocations } : {}), ...(payload.allocate ? { allocate: "oldest_first" as const } : {}), ...(basedOn ? { basedOn } : {}) } };
  },
  // At the door: turn an instruction ("oldest first") into the EXACT allocations the approver will be approving, and note the version of the account they are based on.
  async stamp(env, value) {
    if (!(await one(env, "SELECT 1 AS ok FROM eng_party WHERE id = ?", value.partyId))) throw new EngineError("not_found", "There is no such customer.");
    let allocations = value.allocations;
    if (value.allocate === "oldest_first") {
      allocations = [];
      let left = value.amountMinor;
      for (const d of (await outstandingForParty(env, value.partyId)).documents) {
        if (left <= 0) break;
        if (d.outstandingMinor <= 0) continue;
        if ((await one<{ currency: string }>(env, "SELECT currency FROM eng_document WHERE id = ?", d.id))?.currency !== value.currency) continue;
        const take = Math.min(left, d.outstandingMinor);
        allocations.push({ documentId: d.id, amountMinor: take });
        left -= take;
      }
    }
    const { allocate: _instruction, ...rest } = value;
    return { ...rest, allocations: allocations ?? [], basedOn: { partyVersion: await versionOf(env, { kind: "party", id: value.partyId }) } };
  },
  async check(env, value) {
    if (!(await one(env, "SELECT 1 AS ok FROM eng_party WHERE id = ?", value.partyId))) throw new EngineError("not_found", "There is no such customer.");
    if (value.basedOn && (await versionOf(env, { kind: "party", id: value.partyId })) !== value.basedOn.partyVersion) throw new EngineError("stale", "The account changed after this was proposed, so it needs to be proposed again.");
    let total = 0;
    for (const a of value.allocations ?? []) {
      total += a.amountMinor;
      const doc = await one<{ party_id: number; currency: string }>(env, "SELECT party_id, currency FROM eng_document WHERE id = ?", a.documentId);
      if (!doc) throw new EngineError("not_found", `Document ${a.documentId} does not exist.`);
      if (!(await isEffective(env, "document", a.documentId))) throw new EngineError("not_effective", `Document ${a.documentId} has been reversed.`);
      if (doc.party_id !== value.partyId) throw new EngineError("invalid_state", "A payment can only settle its own customer's invoices.");
      if (doc.currency !== value.currency) throw new EngineError("currency_mismatch", "That payment is in a different currency from the invoice.");
      if (a.amountMinor > (await outstandingForDocument(env, a.documentId))) throw new EngineError("over_allocated", `That is more than document ${a.documentId} still owes.`);
    }
    if (total > value.amountMinor) throw new EngineError("over_allocated", "The allocations add up to more than the payment.");
  },
  async execute(env, v, c) {
    const r = await facts.recordPayment(env, { direction: "in", partyId: v.partyId, amountMinor: v.amountMinor, currency: v.currency, occurredOn: v.occurredOn, method: v.method ?? null, allocations: v.allocations ?? [] }, ctxOf(c, "payment.record"));
    return { movementId: r.movementId, allocationIds: r.allocationIds };
  },
};

interface PaymentCorrect { movementId: number; reason: string; replacement: { partyId: number; amountMinor?: number; occurredOn?: string; method?: string | null; allocations?: Allocation[] }; basedOn?: { movementVersion: number } }
export const paymentCorrect: CapabilityContract<PaymentCorrect> = {
  id: "payment.correct", heldType: "engine.payment.correct", label: "Correcting a payment", requires: [], permissions: ["payment.correct"], version: 1, recordsExecution: true,
  validate(payload) {
    if (!isObj(payload)) return { ok: false, reason: "the correction must be an object" };
    const s = stray(payload, ["movementId", "reason", "replacement", "basedOn"]);
    if (s) return { ok: false, reason: `${s} is not a field of a correction` };
    if (!whole(payload.movementId)) return { ok: false, reason: "movementId must be a record number" };
    if (typeof payload.reason !== "string" || !payload.reason.trim()) return { ok: false, reason: "a reason is required" };
    const r = payload.replacement;
    if (!isObj(r) || stray(r, ["partyId", "amountMinor", "occurredOn", "method", "allocations"]) || !whole(r.partyId)) return { ok: false, reason: "the replacement needs a partyId and may only carry amountMinor, occurredOn, method and allocations" };
    if (r.amountMinor !== undefined && !whole(r.amountMinor)) return { ok: false, reason: "amountMinor must be a whole number of at least 1" };
    if (r.occurredOn !== undefined && !isDate(r.occurredOn)) return { ok: false, reason: "occurredOn must be a calendar date" };
    let allocations: Allocation[] | undefined;
    if (r.allocations !== undefined) { const a = allocationsOf(r.allocations); if (!a.ok) return a; allocations = a.value; }
    let basedOn: { movementVersion: number } | undefined;
    if (payload.basedOn !== undefined) { if (!isObj(payload.basedOn) || stray(payload.basedOn, ["movementVersion"]) || !whole(payload.basedOn.movementVersion, 0)) return { ok: false, reason: "basedOn must name the version it was proposed against" }; basedOn = { movementVersion: payload.basedOn.movementVersion as number }; }
    return { ok: true, value: { movementId: payload.movementId, reason: payload.reason.trim(), replacement: { partyId: r.partyId, ...(r.amountMinor !== undefined ? { amountMinor: r.amountMinor as number } : {}), ...(r.occurredOn !== undefined ? { occurredOn: r.occurredOn as string } : {}), ...(r.method !== undefined ? { method: r.method as string | null } : {}), ...(allocations ? { allocations } : {}) }, ...(basedOn ? { basedOn } : {}) } };
  },
  async stamp(env, value) { return { ...value, basedOn: { movementVersion: await versionOf(env, { kind: "movement", id: value.movementId }) } }; },
  async check(env, value) {
    if (!(await one(env, "SELECT 1 AS ok FROM eng_money_movement WHERE id = ?", value.movementId))) throw new EngineError("not_found", "There is no such payment.");
    if (value.basedOn && (await versionOf(env, { kind: "movement", id: value.movementId })) !== value.basedOn.movementVersion) throw new EngineError("stale", "That payment changed after this was proposed, so it needs to be proposed again.");
    if (!(await isEffective(env, "movement", value.movementId))) throw new EngineError("not_effective", "That payment has already been reversed.");
  },
  async execute(env, v, c) {
    const r = await facts.correctMovement(env, { movementId: v.movementId, reason: v.reason, replacement: v.replacement }, ctxOf(c, "payment.correct"));
    return { reversalId: r.reversalId, replacementMovementId: r.replacementMovementId, allocationIds: r.allocationIds };
  },
};

interface InvoiceIssue { draftId: number; expectedVersion: number }
export const invoiceIssue: CapabilityContract<InvoiceIssue> = {
  id: "invoice.issue", heldType: "engine.invoice.issue", label: "Issuing an invoice", requires: [], permissions: ["invoice.issue"], version: 1, recordsExecution: true,
  validate(payload) {
    if (!isObj(payload)) return { ok: false, reason: "the request must be an object" };
    const s = stray(payload, ["draftId", "expectedVersion"]);
    if (s) return { ok: false, reason: `${s} is not a field of this request` };
    if (!whole(payload.draftId)) return { ok: false, reason: "draftId must be a record number" };
    if (!whole(payload.expectedVersion)) return { ok: false, reason: "expectedVersion must be the version of the draft that was approved" };
    return { ok: true, value: { draftId: payload.draftId, expectedVersion: payload.expectedVersion } };
  },
  async check(env, value) {
    const d = await readDraft(env, value.draftId);
    if (d.issuedDocumentId !== null) throw new EngineError("invalid_state", "That draft has already been issued.");
    if (d.version !== value.expectedVersion) throw new EngineError("stale", "The draft changed after it was approved, so it needs to be approved again.");
    if (!d.validation.ok) throw new EngineError("invalid_state", "The draft is not ready to issue.");
    // the items the lines name must exist, be active and be in the line's unit (the same rules the order lines follow), so a bad one is refused here and not at the approval
    const lines = (d.payload.lines as Array<{ unit?: unknown; itemId?: unknown }>) ?? [];
    const named = lines.flatMap((l, i) => (typeof l.itemId === "number" ? [{ lineNo: i + 1, itemId: l.itemId }] : []));
    if (named.length) await planLineItems(env, named, lines.map((l) => ({ unit: typeof l.unit === "string" ? l.unit : null })));
  },
  async execute(env, v, c) {
    const r = await issueDraft(env, v.draftId, { expectedVersion: v.expectedVersion }, ctxOf(c, "invoice.issue"));
    return { documentId: r.documentId, number: r.number };
  },
};

// ---- customers and suppliers -------------------------------------------------------------------------------------------------------------------------------------------------------------------
const nameTaken = async (env: Env, name: string, exceptId?: number) => {
  const h = await holderOfName(env, name, exceptId);
  if (h) throw new EngineError("duplicate", `There is already a customer or supplier called ${h.name}. Add the role to that record instead of making a second one.`);
};

interface PartyCreate { kind: "person" | "organisation"; name: string; roles: string[]; contact?: Record<string, string> }
export const partyCreate: CapabilityContract<PartyCreate> = {
  id: "party.create", heldType: "engine.party.create", label: "Adding a customer or supplier", requires: [], permissions: ["party.manage"], version: 1, recordsExecution: true,
  validate(payload) {
    if (!isObj(payload)) return { ok: false, reason: "the party must be an object" };
    const s = stray(payload, ["kind", "name", "roles", "contact"]);
    if (s) return { ok: false, reason: `${s} is not a field of a party` };
    if (payload.kind !== "person" && payload.kind !== "organisation") return { ok: false, reason: "kind must be person or organisation" };
    const name = checkName(payload.name); if (!name.ok) return name;
    const roles = checkRoles(payload.roles, "roles", 1); if (!roles.ok) return roles;
    let contact: Record<string, string> | undefined;
    if (payload.contact !== undefined) { const c = checkContact(payload.contact, false); if (!c.ok) return c; contact = c.value as Record<string, string>; }
    return { ok: true, value: { kind: payload.kind, name: name.value, roles: roles.value, ...(contact && Object.keys(contact).length ? { contact } : {}) } };
  },
  async check(env, value) { await nameTaken(env, value.name); },
  async execute(env, v, c) {
    const r = await facts.recordParty(env, { kind: v.kind, name: v.name, roles: v.roles, ...(v.contact ? { contact: v.contact } : {}) }, ctxOf(c, "party.create"));
    return { partyId: r.id, eventId: r.eventId };
  },
};

interface PartyEdit { partyId: number; name?: string; addRoles?: string[]; removeRoles?: string[]; contact?: Record<string, string | null>; basedOn?: { partyVersion: number } }
export const partyEdit: CapabilityContract<PartyEdit> = {
  id: "party.edit", heldType: "engine.party.edit", label: "Changing a customer or supplier", requires: [], permissions: ["party.manage"], version: 1, recordsExecution: true,
  validate(payload) {
    if (!isObj(payload)) return { ok: false, reason: "the change must be an object" };
    const s = stray(payload, ["partyId", "name", "addRoles", "removeRoles", "contact", "basedOn"]);
    if (s) return { ok: false, reason: `${s} is not a field of a change` };
    if (!whole(payload.partyId)) return { ok: false, reason: "partyId must be a record number" };
    const out: PartyEdit = { partyId: payload.partyId };
    if (payload.name !== undefined) { const n = checkName(payload.name); if (!n.ok) return n; out.name = n.value; }
    if (payload.addRoles !== undefined) { const r = checkRoles(payload.addRoles, "addRoles", 1); if (!r.ok) return r; out.addRoles = r.value; }
    if (payload.removeRoles !== undefined) { const r = checkRoles(payload.removeRoles, "removeRoles", 1); if (!r.ok) return r; out.removeRoles = r.value; }
    if (payload.contact !== undefined) { const c = checkContact(payload.contact, true); if (!c.ok) return c; out.contact = c.value; }
    if (out.name === undefined && out.addRoles === undefined && out.removeRoles === undefined && (out.contact === undefined || Object.keys(out.contact).length === 0)) return { ok: false, reason: "say what to change: a name, a role or a contact detail" };
    if (payload.basedOn !== undefined) { if (!isObj(payload.basedOn) || stray(payload.basedOn, ["partyVersion"]) || !whole(payload.basedOn.partyVersion, 0)) return { ok: false, reason: "basedOn must name the version it was proposed against" }; out.basedOn = { partyVersion: payload.basedOn.partyVersion as number }; }
    return { ok: true, value: out };
  },
  async stamp(env, value) {
    if (!(await partyProfile(env, value.partyId))) throw new EngineError("not_found", "There is no such customer or supplier.");
    return { ...value, basedOn: { partyVersion: await versionOf(env, { kind: "party", id: value.partyId }) } };
  },
  async check(env, value) {
    const now = await partyProfile(env, value.partyId);
    if (!now) throw new EngineError("not_found", "There is no such customer or supplier.");
    if (value.basedOn && (await versionOf(env, { kind: "party", id: value.partyId })) !== value.basedOn.partyVersion) throw new EngineError("stale", "That record changed after this was proposed, so it needs to be proposed again.");
    const plan = applyRevision(now, { name: value.name, addRoles: value.addRoles, removeRoles: value.removeRoles, contact: value.contact });
    if (!plan.ok) throw new EngineError(plan.code, plan.reason);
    if (value.name !== undefined) await nameTaken(env, value.name, value.partyId);
  },
  async execute(env, v, c) {
    const r = await facts.reviseParty(env, { partyId: v.partyId, name: v.name, addRoles: v.addRoles, removeRoles: v.removeRoles, contact: v.contact }, ctxOf(c, "party.edit"));
    return { partyId: v.partyId, eventId: r.eventId };
  },
};

// ---- quotations --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// A quotation is a document of kind "quotation" for a customer. Creating, revising and accepting are held writes a person approves; the approval is shown the exact total the engine worked out. A quotation is not a debt:
// no money or allocation is ever touched. VAT is never assumed: every line carries its own explicit tax rate.
const QUOTE_STATUS = ["open", "accepted", "superseded", "any"] as const;
const totalsOf = (lines: QuoteLine[]) => sumTotals(lines.map((l) => ({ description: l.description, quantityMilli: l.quantityMilli, unit: l.unit, unitPriceMinor: l.unitPriceMinor, taxBp: l.taxBp })));

interface QuotationCreate { partyId: number; issuedOn: string; currency: string; validUntil?: string; reference?: string; lines: QuoteLine[]; totals?: { netMinor: number; taxMinor: number; grossMinor: number } }
export const quotationCreate: CapabilityContract<QuotationCreate> = {
  id: "quotation.create", heldType: "engine.quotation.create", label: "Making a quotation", requires: [], permissions: ["quotation.manage"], version: 1, recordsExecution: true,
  validate(payload) {
    if (!isObj(payload)) return { ok: false, reason: "the quotation must be an object" };
    const s = stray(payload, ["partyId", "issuedOn", "currency", "validUntil", "reference", "lines", "totals"]);
    if (s) return { ok: false, reason: `${s} is not a field of a quotation` };
    if (!whole(payload.partyId)) return { ok: false, reason: "partyId must be a record number" };
    const issued = checkDate(payload.issuedOn, "issuedOn"); if (!issued.ok) return issued;
    if (typeof payload.currency !== "string" || !/^[A-Z]{3}$/.test(payload.currency)) return { ok: false, reason: "currency must be a 3-letter code such as ZAR" };
    const out: QuotationCreate = { partyId: payload.partyId, issuedOn: issued.value, currency: payload.currency, lines: [] };
    if (payload.validUntil !== undefined) { const v = checkDate(payload.validUntil, "validUntil"); if (!v.ok) return v; if (v.value < issued.value) return { ok: false, reason: "validUntil cannot be before the issue date" }; out.validUntil = v.value; }
    if (payload.reference !== undefined) { const r = checkReference(payload.reference); if (!r.ok) return r; out.reference = r.value; }
    const lines = checkLines(payload.lines); if (!lines.ok) return lines; out.lines = lines.value;
    if (payload.totals !== undefined) { const t = payload.totals; if (!isObj(t) || !whole(t.netMinor, 0) || !whole(t.taxMinor, 0) || !whole(t.grossMinor, 0)) return { ok: false, reason: "totals must be the engine's worked-out totals" }; out.totals = { netMinor: t.netMinor, taxMinor: t.taxMinor, grossMinor: t.grossMinor }; }
    return { ok: true, value: out };
  },
  async stamp(_env, value) { return { ...value, totals: totalsOf(value.lines) }; },
  async check(env, value) {
    const p = await partyProfile(env, value.partyId);
    if (!p) throw new EngineError("not_found", "There is no such customer.");
    if (!p.roles.includes("customer")) throw new EngineError("invalid_state", `${p.name} is not a customer, so they cannot be quoted.`);
    if (value.totals && JSON.stringify(value.totals) !== JSON.stringify(totalsOf(value.lines))) throw new EngineError("invalid_state", "The totals shown do not match the lines, so this needs to be proposed again.");
  },
  async execute(env, v, c) {
    const r = await facts.recordDocument(env, { kind: "quotation", direction: "sell", partyId: v.partyId, currency: v.currency, reference: v.reference ?? null, issuedOn: v.issuedOn, terms: v.validUntil ? { validUntil: v.validUntil } : {}, lines: v.lines }, ctxOf(c, "quotation.create"));
    return { documentId: r.id, number: r.number, eventId: r.eventId };
  },
};

interface QuotationRevise { quotationId: number; lines?: QuoteLine[]; validUntil?: string | null; reference?: string | null; issuedOn?: string; basedOn?: { quotationVersion: number }; totals?: { netMinor: number; taxMinor: number; grossMinor: number } }
export const quotationRevise: CapabilityContract<QuotationRevise> = {
  id: "quotation.revise", heldType: "engine.quotation.revise", label: "Revising a quotation", requires: [], permissions: ["quotation.manage"], version: 1, recordsExecution: true,
  validate(payload) {
    if (!isObj(payload)) return { ok: false, reason: "the revision must be an object" };
    const s = stray(payload, ["quotationId", "lines", "validUntil", "reference", "issuedOn", "basedOn", "totals"]);
    if (s) return { ok: false, reason: `${s} is not a field of a revision` };
    if (!whole(payload.quotationId)) return { ok: false, reason: "quotationId must be a record number" };
    const out: QuotationRevise = { quotationId: payload.quotationId };
    if (payload.lines !== undefined) { const l = checkLines(payload.lines); if (!l.ok) return l; out.lines = l.value; }
    if (payload.validUntil !== undefined) { if (payload.validUntil === null) out.validUntil = null; else { const v = checkDate(payload.validUntil, "validUntil"); if (!v.ok) return v; out.validUntil = v.value; } }
    if (payload.reference !== undefined) { if (payload.reference === null) out.reference = null; else { const r = checkReference(payload.reference); if (!r.ok) return r; out.reference = r.value; } }
    if (payload.issuedOn !== undefined) { const d = checkDate(payload.issuedOn, "issuedOn"); if (!d.ok) return d; out.issuedOn = d.value; }
    if (out.lines === undefined && out.validUntil === undefined && out.reference === undefined && out.issuedOn === undefined) return { ok: false, reason: "say what to change: the lines, the validity, the reference or the date" };
    if (payload.basedOn !== undefined) { if (!isObj(payload.basedOn) || stray(payload.basedOn, ["quotationVersion"]) || !whole(payload.basedOn.quotationVersion, 0)) return { ok: false, reason: "basedOn must name the version it was proposed against" }; out.basedOn = { quotationVersion: payload.basedOn.quotationVersion as number }; }
    if (payload.totals !== undefined) { const t = payload.totals; if (!isObj(t) || !whole(t.netMinor, 0) || !whole(t.taxMinor, 0) || !whole(t.grossMinor, 0)) return { ok: false, reason: "totals must be the engine's worked-out totals" }; out.totals = { netMinor: t.netMinor, taxMinor: t.taxMinor, grossMinor: t.grossMinor }; }
    return { ok: true, value: out };
  },
  async stamp(env, value) {
    const plan = await planQuotationRevision(env, value);   // refuses a quotation that is missing, replaced, accepted or unchanged BEFORE anything is held
    return { ...value, totals: totalsOf(plan.lines), basedOn: { quotationVersion: await versionOf(env, { kind: "document", id: value.quotationId }) } };
  },
  async check(env, value) {
    if (value.basedOn && (await versionOf(env, { kind: "document", id: value.quotationId })) !== value.basedOn.quotationVersion) throw new EngineError("stale", "That quotation changed after this was proposed, so it needs to be proposed again.");
    const plan = await planQuotationRevision(env, value);
    if (value.totals && JSON.stringify(value.totals) !== JSON.stringify(totalsOf(plan.lines))) throw new EngineError("invalid_state", "The totals shown do not match the lines, so this needs to be proposed again.");
  },
  async execute(env, v, c) {
    const r = await facts.reviseQuotation(env, { quotationId: v.quotationId, lines: v.lines, validUntil: v.validUntil, reference: v.reference, issuedOn: v.issuedOn }, ctxOf(c, "quotation.revise"));
    return { documentId: r.documentId, number: r.number, eventId: r.eventId };
  },
};

interface QuotationAccept { quotationId: number; basedOn?: { quotationVersion: number } }
export const quotationAccept: CapabilityContract<QuotationAccept> = {
  id: "quotation.accept", heldType: "engine.quotation.accept", label: "Recording that a quotation was accepted", requires: [], permissions: ["quotation.manage"], version: 1, recordsExecution: true,
  validate(payload) {
    if (!isObj(payload)) return { ok: false, reason: "the request must be an object" };
    const s = stray(payload, ["quotationId", "basedOn"]);
    if (s) return { ok: false, reason: `${s} is not a field of this request` };
    if (!whole(payload.quotationId)) return { ok: false, reason: "quotationId must be a record number" };
    const out: QuotationAccept = { quotationId: payload.quotationId };
    if (payload.basedOn !== undefined) { if (!isObj(payload.basedOn) || stray(payload.basedOn, ["quotationVersion"]) || !whole(payload.basedOn.quotationVersion, 0)) return { ok: false, reason: "basedOn must name the version it was proposed against" }; out.basedOn = { quotationVersion: payload.basedOn.quotationVersion as number }; }
    return { ok: true, value: out };
  },
  async stamp(env, value) {
    await planQuotationAcceptance(env, value.quotationId);
    return { ...value, basedOn: { quotationVersion: await versionOf(env, { kind: "document", id: value.quotationId }) } };
  },
  async check(env, value) {
    if (value.basedOn && (await versionOf(env, { kind: "document", id: value.quotationId })) !== value.basedOn.quotationVersion) throw new EngineError("stale", "That quotation changed after this was proposed, so it needs to be proposed again.");
    await planQuotationAcceptance(env, value.quotationId);
  },
  async execute(env, v, c) {
    const r = await facts.acceptQuotation(env, { quotationId: v.quotationId }, ctxOf(c, "quotation.accept"));
    return { documentId: v.quotationId, eventId: r.eventId };
  },
};

// Finding quotations: for one customer or all; by default only the CURRENT ones (not those a revision replaced); status "any" lists the whole history.
export const quotationsFind: ReadCapability<{ partyId?: number; status?: string }> = {
  id: "quotations.find",
  label: "Finding quotations",
  permissions: ["quotation.read"],
  validate(params) {
    if (!isObj(params)) return { ok: false, reason: "the request must be an object" };
    const s = stray(params, ["partyId", "status"]);
    if (s) return { ok: false, reason: `${s} is not a field of this request` };
    const out: { partyId?: number; status?: string } = {};
    if (params.partyId !== undefined) { if (!whole(params.partyId)) return { ok: false, reason: "partyId must be a record number" }; out.partyId = params.partyId; }
    if (params.status !== undefined) { if (typeof params.status !== "string" || !(QUOTE_STATUS as readonly string[]).includes(params.status)) return { ok: false, reason: `status must be ${QUOTE_STATUS.join(", ")}` }; out.status = params.status; }
    return { ok: true, value: out };
  },
  async run(env, _viewer, value) {
    const names = new Map((await allProfiles(env)).map((p) => [p.id, p.name]));
    const hits = (await allQuotations(env, value.partyId !== undefined ? { partyId: value.partyId } : {})).filter((q) => (value.status === undefined ? q.status !== "superseded" : value.status === "any" || q.status === value.status));
    return {
      quotations: hits.slice(0, 50).map((q) => ({ ref: { kind: "document", id: q.id }, id: q.id, number: q.number, partyId: q.partyId, partyName: names.get(q.partyId) ?? null, currency: q.currency, issuedOn: q.issuedOn, validUntil: q.validUntil, reference: q.reference, netMinor: q.netMinor, taxMinor: q.taxMinor, grossMinor: q.grossMinor, status: q.status, supersedes: q.supersedes, supersededBy: q.supersededBy })),
      count: hits.length, truncated: hits.length > 50, derivedBy: "quotations.allQuotations",
    };
  },
};

// ---- credit notes -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Crediting an invoice, line by line, for a stated reason (credits.ts has the rules and docs/decisions/credit-notes.md the decisions). The approval is shown the exact credit the engine worked out, and how much of it will be
// applied to the invoice now. Tax is never chosen here: every credited line inherits its invoice line's rate.
interface CreditNoteIssue { invoiceId: number; reason: string; issuedOn: string; lines: CreditLineInput[]; basedOn?: { invoiceVersion: number }; totals?: { netMinor: number; taxMinor: number; grossMinor: number } }
export const creditNoteIssue: CapabilityContract<CreditNoteIssue> = {
  id: "credit_note.issue", heldType: "engine.credit_note.issue", label: "Issuing a credit note", requires: [], permissions: ["credit_note.issue"], version: 1, recordsExecution: true,
  validate(payload) {
    if (!isObj(payload)) return { ok: false, reason: "the credit note must be an object" };
    const s = stray(payload, ["invoiceId", "reason", "issuedOn", "lines", "basedOn", "totals"]);
    if (s) return { ok: false, reason: `${s} is not a field of a credit note` };
    if (!whole(payload.invoiceId)) return { ok: false, reason: "invoiceId must be a record number" };
    const reason = checkReason(payload.reason); if (!reason.ok) return reason;
    const issued = checkDate(payload.issuedOn, "issuedOn"); if (!issued.ok) return issued;
    const lines = checkCreditLines(payload.lines); if (!lines.ok) return lines;
    const out: CreditNoteIssue = { invoiceId: payload.invoiceId, reason: reason.value, issuedOn: issued.value, lines: lines.value };
    if (payload.basedOn !== undefined) { if (!isObj(payload.basedOn) || stray(payload.basedOn, ["invoiceVersion"]) || !whole(payload.basedOn.invoiceVersion, 0)) return { ok: false, reason: "basedOn must name the version it was proposed against" }; out.basedOn = { invoiceVersion: payload.basedOn.invoiceVersion as number }; }
    if (payload.totals !== undefined) { const t = payload.totals; if (!isObj(t) || !whole(t.netMinor, 0) || !whole(t.taxMinor, 0) || !whole(t.grossMinor, 0)) return { ok: false, reason: "totals must be the engine's worked-out totals" }; out.totals = { netMinor: t.netMinor, taxMinor: t.taxMinor, grossMinor: t.grossMinor }; }
    return { ok: true, value: out };
  },
  async stamp(env, value) {
    const plan = await planCreditNote(env, value);   // refuses a missing invoice, a non-invoice, an over-credit and the rest BEFORE anything is held
    return { ...value, totals: plan.totals, basedOn: { invoiceVersion: await versionOf(env, { kind: "document", id: value.invoiceId }) } };
  },
  async check(env, value) {
    if (value.basedOn && (await versionOf(env, { kind: "document", id: value.invoiceId })) !== value.basedOn.invoiceVersion) throw new EngineError("stale", "That invoice changed after this was proposed, so it needs to be proposed again.");
    const plan = await planCreditNote(env, value);
    if (value.totals && JSON.stringify(value.totals) !== JSON.stringify(plan.totals)) throw new EngineError("invalid_state", "The totals shown do not match the credit, so this needs to be proposed again.");
  },
  async execute(env, v, c) {
    const r = await facts.issueCreditNote(env, { invoiceId: v.invoiceId, reason: v.reason, issuedOn: v.issuedOn, lines: v.lines }, ctxOf(c, "credit_note.issue"));
    return { documentId: r.documentId, number: r.number, appliedMinor: r.appliedMinor, unappliedMinor: r.unappliedMinor, eventId: r.eventId };
  },
};

// ---- the business profile and the tax lock ---------------------------------------------------------------------------------------------------------------------------------------------------
// The owner sets the business's own particulars and moves the tax lock forward (docs/decisions/credit-note-follow-ups.md, points 1 and 2). Both are held writes; the lock can never move backward.
export const businessProfileSet: CapabilityContract<ProfileChange> = {
  id: "business.profile.set", heldType: "engine.business.profile.set", label: "Setting the business details", requires: [], permissions: ["business.manage"], version: 1, recordsExecution: true,
  validate(payload) { return checkProfileChange(payload); },
  async check(env, value) {
    const a = applyProfile(await businessProfile(env), value);
    if (!a.ok) throw new EngineError("invalid_state", a.reason);
  },
  async execute(env, v, c) { const r = await facts.setBusinessProfile(env, v, ctxOf(c, "business.profile.set")); return { eventId: r.eventId }; },
};

interface TaxLockSet { lockDate: string }
export const taxLockSet: CapabilityContract<TaxLockSet> = {
  id: "tax_lock.set", heldType: "engine.tax_lock.set", label: "Locking the tax period", requires: [], permissions: ["business.manage"], version: 1, recordsExecution: true,
  validate(payload) {
    if (!isObj(payload)) return { ok: false, reason: "the request must be an object" };
    const s = stray(payload, ["lockDate"]);
    if (s) return { ok: false, reason: `${s} is not a field of this request` };
    const d = checkDate(payload.lockDate, "lockDate"); if (!d.ok) return d;
    return { ok: true, value: { lockDate: d.value } };
  },
  async check(env, value) {
    const now = await taxLockDate(env);
    if (now !== null && value.lockDate <= now) throw new EngineError("invalid_state", `The tax lock is already at ${now}; it can only move forward.`);
  },
  async execute(env, v, c) { const r = await facts.setTaxLock(env, v, ctxOf(c, "tax_lock.set")); return { eventId: r.eventId }; },
};

export const businessGet: ReadCapability<Record<string, never>> = {
  id: "business.get", label: "Reading the business details", permissions: ["business.manage"],
  validate(params) { return isObj(params) && Object.keys(params).length === 0 ? { ok: true, value: {} } : { ok: false, reason: "this request takes no parameters" }; },
  async run(env) { return { profile: await businessProfile(env), taxLockDate: await taxLockDate(env), derivedBy: "business.businessProfile" }; },
};

// ---- what can happen to a credit note's leftover credit, and debit notes -----------------------------------------------------------------------------------------------------------------------------
// apply, refund and void a credit note, and issue a debit note (docs/decisions/credit-note-follow-ups.md, point 4). All held writes for the money roles; each is stamped with the versions of what it was proposed against.
const verOf = (env: Env, id: number) => versionOf(env, { kind: "document", id });
const stampOk = (v: unknown, key: string): v is Record<string, number> => isObj(v) && !stray(v, [key, "invoiceVersion"]) && whole((v as Record<string, unknown>)[key], 0);
const nowMinor = (v: unknown) => whole(v) && (v as number) >= 1;

interface CreditApply { creditNoteId: number; invoiceId: number; amountMinor: number; appliedOn: string; basedOn?: { creditVersion: number; invoiceVersion: number } }
export const creditApply: CapabilityContract<CreditApply> = {
  id: "credit.apply", heldType: "engine.credit.apply", label: "Applying a credit to an invoice", requires: [], permissions: ["credit.apply"], version: 1, recordsExecution: true,
  validate(payload) {
    if (!isObj(payload)) return { ok: false, reason: "the request must be an object" };
    const s = stray(payload, ["creditNoteId", "invoiceId", "amountMinor", "appliedOn", "basedOn"]);
    if (s) return { ok: false, reason: `${s} is not a field of this request` };
    if (!whole(payload.creditNoteId) || !whole(payload.invoiceId)) return { ok: false, reason: "creditNoteId and invoiceId must be record numbers" };
    if (!nowMinor(payload.amountMinor)) return { ok: false, reason: "amountMinor must be a whole number of cents, at least 1" };
    const d = checkDate(payload.appliedOn, "appliedOn"); if (!d.ok) return d;
    const out: CreditApply = { creditNoteId: payload.creditNoteId, invoiceId: payload.invoiceId, amountMinor: payload.amountMinor as number, appliedOn: d.value };
    if (payload.basedOn !== undefined) { const b = payload.basedOn; if (!isObj(b) || stray(b, ["creditVersion", "invoiceVersion"]) || !whole(b.creditVersion, 0) || !whole(b.invoiceVersion, 0)) return { ok: false, reason: "basedOn must name the versions it was proposed against" }; out.basedOn = { creditVersion: b.creditVersion as number, invoiceVersion: b.invoiceVersion as number }; }
    return { ok: true, value: out };
  },
  async stamp(env, value) { await planCreditApplication(env, value); return { ...value, basedOn: { creditVersion: await verOf(env, value.creditNoteId), invoiceVersion: await verOf(env, value.invoiceId) } }; },
  async check(env, value) {
    if (value.basedOn && ((await verOf(env, value.creditNoteId)) !== value.basedOn.creditVersion || (await verOf(env, value.invoiceId)) !== value.basedOn.invoiceVersion)) throw new EngineError("stale", "The credit or the invoice changed after this was proposed, so it needs to be proposed again.");
    await planCreditApplication(env, value);
  },
  async execute(env, v, c) { const r = await facts.applyCredit(env, { creditNoteId: v.creditNoteId, invoiceId: v.invoiceId, amountMinor: v.amountMinor, appliedOn: v.appliedOn }, ctxOf(c, "credit.apply")); return { allocationId: r.allocationId, eventId: r.eventId }; },
};

interface RefundRecord { creditNoteId: number; amountMinor: number; refundedOn: string; method: string; basedOn?: { creditVersion: number } }
export const refundRecord: CapabilityContract<RefundRecord> = {
  id: "refund.record", heldType: "engine.refund.record", label: "Recording a refund of credit", requires: [], permissions: ["refund.record"], version: 1, recordsExecution: true,
  validate(payload) {
    if (!isObj(payload)) return { ok: false, reason: "the request must be an object" };
    const s = stray(payload, ["creditNoteId", "amountMinor", "refundedOn", "method", "basedOn"]);
    if (s) return { ok: false, reason: `${s} is not a field of this request` };
    if (!whole(payload.creditNoteId)) return { ok: false, reason: "creditNoteId must be a record number" };
    if (!nowMinor(payload.amountMinor)) return { ok: false, reason: "amountMinor must be a whole number of cents, at least 1" };
    if (typeof payload.method !== "string" || !["eft", "cash", "card", "cheque", "other"].includes(payload.method)) return { ok: false, reason: "method must be eft, cash, card, cheque or other" };
    const d = checkDate(payload.refundedOn, "refundedOn"); if (!d.ok) return d;
    const out: RefundRecord = { creditNoteId: payload.creditNoteId, amountMinor: payload.amountMinor as number, refundedOn: d.value, method: payload.method };
    if (payload.basedOn !== undefined) { if (!stampOk(payload.basedOn, "creditVersion")) return { ok: false, reason: "basedOn must name the version it was proposed against" }; out.basedOn = { creditVersion: (payload.basedOn as Record<string, number>).creditVersion }; }
    return { ok: true, value: out };
  },
  async stamp(env, value) { await planRefund(env, value); return { ...value, basedOn: { creditVersion: await verOf(env, value.creditNoteId) } }; },
  async check(env, value) {
    if (value.basedOn && (await verOf(env, value.creditNoteId)) !== value.basedOn.creditVersion) throw new EngineError("stale", "That credit changed after this was proposed, so it needs to be proposed again.");
    await planRefund(env, value);
  },
  async execute(env, v, c) { const r = await facts.refundCredit(env, { creditNoteId: v.creditNoteId, amountMinor: v.amountMinor, refundedOn: v.refundedOn, method: v.method }, ctxOf(c, "refund.record")); return { movementId: r.movementId, eventId: r.eventId }; },
};

interface CreditNoteVoid { creditNoteId: number; reason: string; voidedOn: string; basedOn?: { creditVersion: number } }
export const creditNoteVoid: CapabilityContract<CreditNoteVoid> = {
  id: "credit_note.void", heldType: "engine.credit_note.void", label: "Voiding a credit note", requires: [], permissions: ["credit_note.void"], version: 1, recordsExecution: true,
  validate(payload) {
    if (!isObj(payload)) return { ok: false, reason: "the request must be an object" };
    const s = stray(payload, ["creditNoteId", "reason", "voidedOn", "basedOn"]);
    if (s) return { ok: false, reason: `${s} is not a field of this request` };
    if (!whole(payload.creditNoteId)) return { ok: false, reason: "creditNoteId must be a record number" };
    const r = checkReason(payload.reason, "void"); if (!r.ok) return r;
    const d = checkDate(payload.voidedOn, "voidedOn"); if (!d.ok) return d;
    const out: CreditNoteVoid = { creditNoteId: payload.creditNoteId, reason: r.value, voidedOn: d.value };
    if (payload.basedOn !== undefined) { if (!stampOk(payload.basedOn, "creditVersion")) return { ok: false, reason: "basedOn must name the version it was proposed against" }; out.basedOn = { creditVersion: (payload.basedOn as Record<string, number>).creditVersion }; }
    return { ok: true, value: out };
  },
  async stamp(env, value) { await planVoid(env, value); return { ...value, basedOn: { creditVersion: await verOf(env, value.creditNoteId) } }; },
  async check(env, value) {
    if (value.basedOn && (await verOf(env, value.creditNoteId)) !== value.basedOn.creditVersion) throw new EngineError("stale", "That credit note changed after this was proposed, so it needs to be proposed again.");
    await planVoid(env, value);
  },
  async execute(env, v, c) { const r = await facts.voidCreditNote(env, { creditNoteId: v.creditNoteId, reason: v.reason, voidedOn: v.voidedOn }, ctxOf(c, "credit_note.void")); return { eventId: r.eventId, reversalIds: r.reversalIds }; },
};

interface DebitNoteIssue { invoiceId: number; reason: string; issuedOn: string; lines: CreditLineInput[]; basedOn?: { invoiceVersion: number }; totals?: { netMinor: number; taxMinor: number; grossMinor: number } }
export const debitNoteIssue: CapabilityContract<DebitNoteIssue> = {
  id: "debit_note.issue", heldType: "engine.debit_note.issue", label: "Issuing a debit note", requires: [], permissions: ["debit_note.issue"], version: 1, recordsExecution: true,
  validate(payload) {
    if (!isObj(payload)) return { ok: false, reason: "the debit note must be an object" };
    const s = stray(payload, ["invoiceId", "reason", "issuedOn", "lines", "basedOn", "totals"]);
    if (s) return { ok: false, reason: `${s} is not a field of a debit note` };
    if (!whole(payload.invoiceId)) return { ok: false, reason: "invoiceId must be a record number" };
    const reason = checkReason(payload.reason, "debit note"); if (!reason.ok) return reason;
    const issued = checkDate(payload.issuedOn, "issuedOn"); if (!issued.ok) return issued;
    const lines = checkCreditLines(payload.lines, "debit note"); if (!lines.ok) return lines;
    const out: DebitNoteIssue = { invoiceId: payload.invoiceId, reason: reason.value, issuedOn: issued.value, lines: lines.value };
    if (payload.basedOn !== undefined) { if (!stampOk(payload.basedOn, "invoiceVersion")) return { ok: false, reason: "basedOn must name the version it was proposed against" }; out.basedOn = { invoiceVersion: (payload.basedOn as Record<string, number>).invoiceVersion }; }
    if (payload.totals !== undefined) { const t = payload.totals; if (!isObj(t) || !whole(t.netMinor, 0) || !whole(t.taxMinor, 0) || !whole(t.grossMinor, 0)) return { ok: false, reason: "totals must be the engine's worked-out totals" }; out.totals = { netMinor: t.netMinor, taxMinor: t.taxMinor, grossMinor: t.grossMinor }; }
    return { ok: true, value: out };
  },
  async stamp(env, value) { const plan = await planDebitNote(env, value); return { ...value, totals: plan.totals, basedOn: { invoiceVersion: await verOf(env, value.invoiceId) } }; },
  async check(env, value) {
    if (value.basedOn && (await verOf(env, value.invoiceId)) !== value.basedOn.invoiceVersion) throw new EngineError("stale", "That invoice changed after this was proposed, so it needs to be proposed again.");
    const plan = await planDebitNote(env, value);
    if (value.totals && JSON.stringify(value.totals) !== JSON.stringify(plan.totals)) throw new EngineError("invalid_state", "The totals shown do not match the debit, so this needs to be proposed again.");
  },
  async execute(env, v, c) { const r = await facts.issueDebitNote(env, { invoiceId: v.invoiceId, reason: v.reason, issuedOn: v.issuedOn, lines: v.lines }, ctxOf(c, "debit_note.issue")); return { documentId: r.documentId, number: r.number, eventId: r.eventId }; },
};

// Finding credit that can still be applied or refunded.
export const creditsFind: ReadCapability<{ partyId?: number }> = {
  id: "credits.find", label: "Finding credit and overpayments to apply", permissions: ["credit.apply"],
  validate(params) {
    if (!isObj(params)) return { ok: false, reason: "the request must be an object" };
    const s = stray(params, ["partyId"]);
    if (s) return { ok: false, reason: `${s} is not a field of this request` };
    if (params.partyId !== undefined && !whole(params.partyId)) return { ok: false, reason: "partyId must be a record number" };
    return { ok: true, value: params.partyId !== undefined ? { partyId: params.partyId as number } : {} };
  },
  async run(env, _viewer, value) {
    const names = new Map((await allProfiles(env)).map((p) => [p.id, p.name]));
    const rows = await env.OFFICE_DB.prepare("SELECT d.id, d.party_id, d.currency, d.issued_on, n.number AS number FROM eng_document d LEFT JOIN eng_document_number n ON n.document_id = d.id WHERE d.kind = 'credit_note' ORDER BY d.id").all<{ id: number; party_id: number; currency: string; issued_on: string; number: number | null }>();
    const out: Array<Record<string, unknown>> = [];
    for (const d of rows.results ?? []) {
      if (value.partyId !== undefined && d.party_id !== value.partyId) continue;
      const available = await creditAvailable(env, d.id);
      if (available > 0) out.push({ ref: { kind: "document", id: d.id }, id: d.id, number: d.number, partyId: d.party_id, partyName: names.get(d.party_id) ?? null, currency: d.currency, issuedOn: d.issued_on, availableMinor: available });
    }
    const payments: Array<Record<string, unknown>> = [];
    const mrows = await env.OFFICE_DB.prepare("SELECT id, party_id, currency, occurred_on FROM eng_money_movement WHERE direction = 'in' AND (method IS NULL OR method != 'credit') ORDER BY id").all<{ id: number; party_id: number; currency: string; occurred_on: string }>();
    for (const m of mrows.results ?? []) {
      if (value.partyId !== undefined && m.party_id !== value.partyId) continue;
      const available = await movementAvailable(env, m.id);
      if (available > 0) payments.push({ ref: { kind: "movement", id: m.id }, id: m.id, partyId: m.party_id, partyName: names.get(m.party_id) ?? null, currency: m.currency, receivedOn: m.occurred_on, availableMinor: available });
    }
    return { credits: out.slice(0, 50), payments: payments.slice(0, 50), count: out.length + payments.length, truncated: out.length > 50 || payments.length > 50, derivedBy: "credits.creditAvailable" };
  },
};

// ---- undo, overpayments and the VAT summary (docs/decisions/credit-note-follow-ups.md, "The last four") -----------------------------------------------------------------------------------------------------
// Removing an allocation and voiding a refund are held writes that record REVERSALS (new facts); an unapplied overpayment is allocated or refunded exactly like a credit.
interface AllocationRemove { allocationId: number; reason: string }
export const allocationRemove: CapabilityContract<AllocationRemove> = {
  id: "allocation.remove", heldType: "engine.allocation.remove", label: "Removing an allocation", requires: [], permissions: ["allocation.remove"], version: 1, recordsExecution: true,
  validate(payload) {
    if (!isObj(payload)) return { ok: false, reason: "the request must be an object" };
    const s = stray(payload, ["allocationId", "reason"]);
    if (s) return { ok: false, reason: `${s} is not a field of this request` };
    if (!whole(payload.allocationId)) return { ok: false, reason: "allocationId must be a record number" };
    const r = checkReason(payload.reason, "removal"); if (!r.ok) return r;
    return { ok: true, value: { allocationId: payload.allocationId, reason: r.value } };
  },
  async check(env, value) {
    const a = await one(env, "SELECT id FROM eng_allocation WHERE id = ?", value.allocationId);
    if (!a) throw new EngineError("not_found", "There is no such allocation.");
    if (!(await isEffective(env, "allocation", value.allocationId))) throw new EngineError("not_effective", "That allocation has already been removed.");
  },
  async execute(env, v, c) { const r = await facts.removeAllocation(env, v, ctxOf(c, "allocation.remove")); return { reversalId: r.reversalId }; },
};

interface RefundVoid { movementId: number; reason: string }
export const refundVoid: CapabilityContract<RefundVoid> = {
  id: "refund.void", heldType: "engine.refund.void", label: "Voiding a refund", requires: [], permissions: ["refund.void"], version: 1, recordsExecution: true,
  validate(payload) {
    if (!isObj(payload)) return { ok: false, reason: "the request must be an object" };
    const s = stray(payload, ["movementId", "reason"]);
    if (s) return { ok: false, reason: `${s} is not a field of this request` };
    if (!whole(payload.movementId)) return { ok: false, reason: "movementId must be a record number" };
    const r = checkReason(payload.reason, "void"); if (!r.ok) return r;
    return { ok: true, value: { movementId: payload.movementId, reason: r.value } };
  },
  async check(env, value) { await refundMovementOrThrow(env, value.movementId); },
  async execute(env, v, c) { const r = await facts.voidRefund(env, v, ctxOf(c, "refund.void")); return { reversalId: r.reversalId }; },
};

interface PaymentAllocate { paymentId: number; invoiceId: number; amountMinor: number; allocatedOn: string; basedOn?: { paymentVersion: number; invoiceVersion: number } }
export const paymentAllocate: CapabilityContract<PaymentAllocate> = {
  id: "payment.allocate", heldType: "engine.payment.allocate", label: "Allocating an overpayment to an invoice", requires: [], permissions: ["payment.allocate"], version: 1, recordsExecution: true,
  validate(payload) {
    if (!isObj(payload)) return { ok: false, reason: "the request must be an object" };
    const s = stray(payload, ["paymentId", "invoiceId", "amountMinor", "allocatedOn", "basedOn"]);
    if (s) return { ok: false, reason: `${s} is not a field of this request` };
    if (!whole(payload.paymentId) || !whole(payload.invoiceId)) return { ok: false, reason: "paymentId and invoiceId must be record numbers" };
    if (!nowMinor(payload.amountMinor)) return { ok: false, reason: "amountMinor must be a whole number of cents, at least 1" };
    const d = checkDate(payload.allocatedOn, "allocatedOn"); if (!d.ok) return d;
    const out: PaymentAllocate = { paymentId: payload.paymentId, invoiceId: payload.invoiceId, amountMinor: payload.amountMinor as number, allocatedOn: d.value };
    if (payload.basedOn !== undefined) { const b = payload.basedOn; if (!isObj(b) || stray(b, ["paymentVersion", "invoiceVersion"]) || !whole(b.paymentVersion, 0) || !whole(b.invoiceVersion, 0)) return { ok: false, reason: "basedOn must name the versions it was proposed against" }; out.basedOn = { paymentVersion: b.paymentVersion as number, invoiceVersion: b.invoiceVersion as number }; }
    return { ok: true, value: out };
  },
  async stamp(env, value) { await planPaymentAllocation(env, value); return { ...value, basedOn: { paymentVersion: await versionOf(env, { kind: "movement", id: value.paymentId }), invoiceVersion: await verOf(env, value.invoiceId) } }; },
  async check(env, value) {
    if (value.basedOn && ((await versionOf(env, { kind: "movement", id: value.paymentId })) !== value.basedOn.paymentVersion || (await verOf(env, value.invoiceId)) !== value.basedOn.invoiceVersion)) throw new EngineError("stale", "The payment or the invoice changed after this was proposed, so it needs to be proposed again.");
    await planPaymentAllocation(env, value);
  },
  async execute(env, v, c) { const r = await facts.allocatePayment(env, { paymentId: v.paymentId, invoiceId: v.invoiceId, amountMinor: v.amountMinor, allocatedOn: v.allocatedOn }, ctxOf(c, "payment.allocate")); return { allocationId: r.allocationId, eventId: r.eventId }; },
};

interface PaymentRefund { paymentId: number; amountMinor: number; refundedOn: string; method: string; basedOn?: { paymentVersion: number } }
export const paymentRefund: CapabilityContract<PaymentRefund> = {
  id: "payment.refund", heldType: "engine.payment.refund", label: "Refunding an overpayment", requires: [], permissions: ["payment.refund"], version: 1, recordsExecution: true,
  validate(payload) {
    if (!isObj(payload)) return { ok: false, reason: "the request must be an object" };
    const s = stray(payload, ["paymentId", "amountMinor", "refundedOn", "method", "basedOn"]);
    if (s) return { ok: false, reason: `${s} is not a field of this request` };
    if (!whole(payload.paymentId)) return { ok: false, reason: "paymentId must be a record number" };
    if (!nowMinor(payload.amountMinor)) return { ok: false, reason: "amountMinor must be a whole number of cents, at least 1" };
    if (typeof payload.method !== "string" || !["eft", "cash", "card", "cheque", "other"].includes(payload.method)) return { ok: false, reason: "method must be eft, cash, card, cheque or other" };
    const d = checkDate(payload.refundedOn, "refundedOn"); if (!d.ok) return d;
    const out: PaymentRefund = { paymentId: payload.paymentId, amountMinor: payload.amountMinor as number, refundedOn: d.value, method: payload.method };
    if (payload.basedOn !== undefined) { if (!stampOk(payload.basedOn, "paymentVersion")) return { ok: false, reason: "basedOn must name the version it was proposed against" }; out.basedOn = { paymentVersion: (payload.basedOn as Record<string, number>).paymentVersion }; }
    return { ok: true, value: out };
  },
  async stamp(env, value) { await planPaymentRefund(env, value); return { ...value, basedOn: { paymentVersion: await versionOf(env, { kind: "movement", id: value.paymentId }) } }; },
  async check(env, value) {
    if (value.basedOn && (await versionOf(env, { kind: "movement", id: value.paymentId })) !== value.basedOn.paymentVersion) throw new EngineError("stale", "That payment changed after this was proposed, so it needs to be proposed again.");
    await planPaymentRefund(env, value);
  },
  async execute(env, v, c) { const r = await facts.refundPayment(env, { paymentId: v.paymentId, amountMinor: v.amountMinor, refundedOn: v.refundedOn, method: v.method }, ctxOf(c, "payment.refund")); return { movementId: r.movementId, eventId: r.eventId }; },
};

export const vatSummaryRead: ReadCapability<{ from: string; to: string }> = {
  id: "vat.summary", label: "The VAT summary for a period", permissions: ["vat.read"],
  validate(params) {
    if (!isObj(params)) return { ok: false, reason: "the request must be an object" };
    const s = stray(params, ["from", "to"]);
    if (s) return { ok: false, reason: `${s} is not a field of this request` };
    const f = checkDate(params.from, "from"); if (!f.ok) return f;
    const t = checkDate(params.to, "to"); if (!t.ok) return t;
    if (t.value < f.value) return { ok: false, reason: "to cannot be before from" };
    return { ok: true, value: { from: f.value, to: t.value } };
  },
  async run(env, _viewer, value) { return { ...(await vatSummary(env, value)), derivedBy: "business.vatSummary" }; },
};

// ---- expenses ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// A PAID purchase: record it (one held write: the expense document and the money-out movement that paid it), void it, find them (docs/decisions/expenses.md). Input tax is derived with its reasons, never typed.
interface ExpenseRecordPayload extends ExpenseInput { totals?: { netMinor: number; taxMinor: number; grossMinor: number } }
export const expenseRecord: CapabilityContract<ExpenseRecordPayload> = {
  id: "expense.record", heldType: "engine.expense.record", label: "Recording an expense", requires: [], permissions: ["expense.record"], version: 1, recordsExecution: true,
  validate(payload) {
    const c = checkExpenseInput(payload); if (!c.ok) return c;
    const out: ExpenseRecordPayload = { ...c.value };
    const t = (payload as Record<string, unknown>).totals;
    if (t !== undefined) { if (!isObj(t) || !whole(t.netMinor, 0) || !whole(t.taxMinor, 0) || !whole(t.grossMinor, 0)) return { ok: false, reason: "totals must be the engine's worked-out totals" }; out.totals = { netMinor: t.netMinor, taxMinor: t.taxMinor, grossMinor: t.grossMinor }; }
    return { ok: true, value: out };
  },
  async stamp(env, value) { const plan = await planExpense(env, value); return { ...value, totals: plan.totals }; },
  async check(env, value) {
    const plan = await planExpense(env, value);
    if (value.totals && JSON.stringify(value.totals) !== JSON.stringify(plan.totals)) throw new EngineError("invalid_state", "The totals shown do not match the lines, so this needs to be proposed again.");
  },
  async execute(env, v, c) {
    const { totals: _shown, ...input } = v;
    const r = await facts.recordExpense(env, input, ctxOf(c, "expense.record"));
    return { documentId: r.documentId, number: r.number, movementId: r.movementId, eventId: r.eventId };
  },
};

interface ExpenseVoidPayload { expenseId: number; reason: string; voidedOn: string }
export const expenseVoid: CapabilityContract<ExpenseVoidPayload> = {
  id: "expense.void", heldType: "engine.expense.void", label: "Voiding an expense", requires: [], permissions: ["expense.void"], version: 1, recordsExecution: true,
  validate(payload) {
    if (!isObj(payload)) return { ok: false, reason: "the request must be an object" };
    const s = stray(payload, ["expenseId", "reason", "voidedOn"]);
    if (s) return { ok: false, reason: `${s} is not a field of this request` };
    if (!whole(payload.expenseId)) return { ok: false, reason: "expenseId must be a record number" };
    const r = checkReason(payload.reason, "void"); if (!r.ok) return r;
    const d = checkDate(payload.voidedOn, "voidedOn"); if (!d.ok) return d;
    return { ok: true, value: { expenseId: payload.expenseId, reason: r.value, voidedOn: d.value } };
  },
  async check(env, value) { await planExpenseVoid(env, value); },
  async execute(env, v, c) { const r = await facts.voidExpense(env, v, ctxOf(c, "expense.void")); return { eventId: r.eventId, reversalIds: r.reversalIds }; },
};

export const expensesFind: ReadCapability<{ from?: string; to?: string; category?: string; supplierId?: number; status?: string }> = {
  id: "expenses.find", label: "Finding expenses", permissions: ["expense.read"],
  validate(params) {
    if (!isObj(params)) return { ok: false, reason: "the request must be an object" };
    const s = stray(params, ["from", "to", "category", "supplierId", "status"]);
    if (s) return { ok: false, reason: `${s} is not a field of this request` };
    const out: { from?: string; to?: string; category?: string; supplierId?: number; status?: string } = {};
    if (params.from !== undefined) { const d = checkDate(params.from, "from"); if (!d.ok) return d; out.from = d.value; }
    if (params.to !== undefined) { const d = checkDate(params.to, "to"); if (!d.ok) return d; out.to = d.value; }
    if (out.from !== undefined && out.to !== undefined && out.to < out.from) return { ok: false, reason: "to cannot be before from" };
    if (params.category !== undefined) { if (typeof params.category !== "string" || !(EXPENSE_CATEGORIES as readonly string[]).includes(params.category)) return { ok: false, reason: `category must be one of ${EXPENSE_CATEGORIES.join(", ")}` }; out.category = params.category; }
    if (params.supplierId !== undefined) { if (!whole(params.supplierId)) return { ok: false, reason: "supplierId must be a record number" }; out.supplierId = params.supplierId; }
    if (params.status !== undefined) { if (typeof params.status !== "string" || !["recorded", "voided", "any"].includes(params.status)) return { ok: false, reason: "status must be recorded, voided or any" }; out.status = params.status; }
    return { ok: true, value: out };
  },
  async run(env, _viewer, value) {
    const all = await allExpenses(env, value);
    return { expenses: all.slice(0, 100), count: all.length, truncated: all.length > 100, categories: [...new Set(all.map((x) => x.category))].sort(), derivedBy: "expenses.allExpenses" };
  },
};

// ---- purchase orders and goods received (docs/decisions/purchase-orders.md) ---------------------------------------------------------------------------------------------------------------------------
interface OrderCreatePayload { supplierId: number; orderedOn: string; currency: string; expectedOn?: string; reference?: string; lines: QuoteLine[]; lineItems?: OrderLineItem[]; totals?: { netMinor: number; taxMinor: number; grossMinor: number } }
export const purchaseOrderCreate: CapabilityContract<OrderCreatePayload> = {
  id: "purchase_order.create", heldType: "engine.purchase_order.create", label: "Placing a purchase order", requires: [], permissions: ["purchase.manage"], version: 1, recordsExecution: true,
  validate(payload) {
    if (!isObj(payload)) return { ok: false, reason: "the order must be an object" };
    const s = stray(payload, ["supplierId", "orderedOn", "currency", "expectedOn", "reference", "lines", "lineItems", "totals"]);
    if (s) return { ok: false, reason: `${s} is not a field of an order` };
    if (!whole(payload.supplierId)) return { ok: false, reason: "supplierId must be a record number" };
    const on = checkDate(payload.orderedOn, "orderedOn"); if (!on.ok) return on;
    if (typeof payload.currency !== "string" || !/^[A-Z]{3}$/.test(payload.currency)) return { ok: false, reason: "currency must be a 3-letter code such as ZAR" };
    const out: OrderCreatePayload = { supplierId: payload.supplierId, orderedOn: on.value, currency: payload.currency, lines: [] };
    if (payload.expectedOn !== undefined) { const e = checkDate(payload.expectedOn, "expectedOn"); if (!e.ok) return e; if (e.value < on.value) return { ok: false, reason: "expectedOn cannot be before the order date" }; out.expectedOn = e.value; }
    if (payload.reference !== undefined) { const r = checkReference(payload.reference); if (!r.ok) return r; out.reference = r.value; }
    const lines = checkLines(payload.lines); if (!lines.ok) return lines; out.lines = lines.value;
    if (payload.lineItems !== undefined) { const li = checkLineItems(payload.lineItems, lines.value.length); if (!li.ok) return li; out.lineItems = li.value; }
    if (payload.totals !== undefined) { const t = payload.totals; if (!isObj(t) || !whole(t.netMinor, 0) || !whole(t.taxMinor, 0) || !whole(t.grossMinor, 0)) return { ok: false, reason: "totals must be the engine's worked-out totals" }; out.totals = { netMinor: t.netMinor, taxMinor: t.taxMinor, grossMinor: t.grossMinor }; }
    return { ok: true, value: out };
  },
  async stamp(_env, value) { return { ...value, totals: totalsOf(value.lines) }; },
  async check(env, value) {
    await planOrder(env, value);
    if (value.lineItems) await planLineItems(env, value.lineItems, value.lines);
    if (value.totals && JSON.stringify(value.totals) !== JSON.stringify(totalsOf(value.lines))) throw new EngineError("invalid_state", "The totals shown do not match the lines, so this needs to be proposed again.");
  },
  async execute(env, v, c) {
    const r = await facts.recordPurchaseOrder(env, { supplierId: v.supplierId, orderedOn: v.orderedOn, currency: v.currency, expectedOn: v.expectedOn, reference: v.reference ?? null, lines: v.lines, lineItems: v.lineItems }, ctxOf(c, "purchase_order.create"));
    return { documentId: r.documentId, number: r.number, eventId: r.eventId };
  },
};

interface GoodsReceivePayload { orderId: number; receivedOn: string; lines: ReceiptLineInput[]; deliveryNote?: string; note?: string; basedOn?: { orderVersion: number } }
export const goodsReceive: CapabilityContract<GoodsReceivePayload> = {
  id: "goods.receive", heldType: "engine.goods.receive", label: "Receiving goods", requires: [], permissions: ["goods.receive"], version: 1, recordsExecution: true,
  validate(payload) {
    if (!isObj(payload)) return { ok: false, reason: "the receipt must be an object" };
    const s = stray(payload, ["orderId", "receivedOn", "lines", "deliveryNote", "note", "basedOn"]);
    if (s) return { ok: false, reason: `${s} is not a field of a receipt` };
    if (!whole(payload.orderId)) return { ok: false, reason: "orderId must be a record number" };
    const d = checkDate(payload.receivedOn, "receivedOn"); if (!d.ok) return d;
    const lines = checkReceiptLines(payload.lines); if (!lines.ok) return lines;
    const out: GoodsReceivePayload = { orderId: payload.orderId, receivedOn: d.value, lines: lines.value };
    if (payload.deliveryNote !== undefined) { const n = checkShortText(payload.deliveryNote, "deliveryNote", 60); if (!n.ok) return n; out.deliveryNote = n.value; }
    if (payload.note !== undefined) { const n = checkShortText(payload.note, "note", 200); if (!n.ok) return n; out.note = n.value; }
    if (payload.basedOn !== undefined) { if (!stampOk(payload.basedOn, "orderVersion")) return { ok: false, reason: "basedOn must name the version it was proposed against" }; out.basedOn = { orderVersion: (payload.basedOn as Record<string, number>).orderVersion }; }
    return { ok: true, value: out };
  },
  async stamp(env, value) { await planReceipt(env, value); return { ...value, basedOn: { orderVersion: await verOf(env, value.orderId) } }; },
  async check(env, value) {
    if (value.basedOn && (await verOf(env, value.orderId)) !== value.basedOn.orderVersion) throw new EngineError("stale", "That order changed after this was proposed, so it needs to be proposed again.");
    await planReceipt(env, value);
  },
  async execute(env, v, c) { const r = await facts.receiveGoods(env, { orderId: v.orderId, receivedOn: v.receivedOn, lines: v.lines, deliveryNote: v.deliveryNote, note: v.note }, ctxOf(c, "goods.receive")); return { documentId: r.documentId, number: r.number, eventId: r.eventId }; },
};

interface OrderCancelPayload { orderId: number; reason: string; cancelledOn: string; basedOn?: { orderVersion: number } }
export const purchaseOrderCancel: CapabilityContract<OrderCancelPayload> = {
  id: "purchase_order.cancel", heldType: "engine.purchase_order.cancel", label: "Cancelling a purchase order", requires: [], permissions: ["purchase.manage"], version: 1, recordsExecution: true,
  validate(payload) {
    if (!isObj(payload)) return { ok: false, reason: "the request must be an object" };
    const s = stray(payload, ["orderId", "reason", "cancelledOn", "basedOn"]);
    if (s) return { ok: false, reason: `${s} is not a field of this request` };
    if (!whole(payload.orderId)) return { ok: false, reason: "orderId must be a record number" };
    const r = checkShortText(payload.reason, "reason", 200); if (!r.ok) return r;
    const d = checkDate(payload.cancelledOn, "cancelledOn"); if (!d.ok) return d;
    const out: OrderCancelPayload = { orderId: payload.orderId, reason: r.value, cancelledOn: d.value };
    if (payload.basedOn !== undefined) { if (!stampOk(payload.basedOn, "orderVersion")) return { ok: false, reason: "basedOn must name the version it was proposed against" }; out.basedOn = { orderVersion: (payload.basedOn as Record<string, number>).orderVersion }; }
    return { ok: true, value: out };
  },
  async stamp(env, value) { await planCancel(env, value); return { ...value, basedOn: { orderVersion: await verOf(env, value.orderId) } }; },
  async check(env, value) {
    if (value.basedOn && (await verOf(env, value.orderId)) !== value.basedOn.orderVersion) throw new EngineError("stale", "That order changed after this was proposed, so it needs to be proposed again.");
    await planCancel(env, value);
  },
  async execute(env, v, c) { const r = await facts.cancelPurchaseOrder(env, { orderId: v.orderId, reason: v.reason, cancelledOn: v.cancelledOn }, ctxOf(c, "purchase_order.cancel")); return { eventId: r.eventId }; },
};

export const purchaseOrdersFind: ReadCapability<{ supplierId?: number; status?: string }> = {
  id: "purchase_orders.find", label: "Finding purchase orders", permissions: ["purchase.read"],
  validate(params) {
    if (!isObj(params)) return { ok: false, reason: "the request must be an object" };
    const s = stray(params, ["supplierId", "status"]);
    if (s) return { ok: false, reason: `${s} is not a field of this request` };
    const out: { supplierId?: number; status?: string } = {};
    if (params.supplierId !== undefined) { if (!whole(params.supplierId)) return { ok: false, reason: "supplierId must be a record number" }; out.supplierId = params.supplierId; }
    if (params.status !== undefined) { if (typeof params.status !== "string" || !["open", "part_received", "received", "cancelled", "closed", "outstanding", "any"].includes(params.status)) return { ok: false, reason: "status must be open, part_received, received, cancelled, closed, outstanding or any" }; out.status = params.status; }
    return { ok: true, value: out };
  },
  async run(env, _viewer, value) {
    const names = new Map((await allProfiles(env)).map((p) => [p.id, p.name]));
    const all = await allOrders(env, value);
    return { orders: all.slice(0, 100).map((o) => ({ ref: { kind: "document", id: o.id }, id: o.id, number: o.number, supplierId: o.supplierId, supplierName: names.get(o.supplierId) ?? null, currency: o.currency, orderedOn: o.orderedOn, expectedOn: o.expectedOn, reference: o.reference, netMinor: o.netMinor, taxMinor: o.taxMinor, grossMinor: o.grossMinor, status: o.status, receivedValueMinor: o.receivedValueMinor, outstandingValueMinor: o.outstandingValueMinor })), count: all.length, truncated: all.length > 100, derivedBy: "purchasing.allOrders" };
  },
};

// ---- supplier invoices, the three-way match and supplier payment (docs/decisions/supplier-invoices.md) ---------------------------------------------------------------------------------------------------
interface BillRecordPayload extends BillInput { totals?: { netMinor: number; taxMinor: number; grossMinor: number }; match?: unknown }
export const supplierInvoiceRecord: CapabilityContract<BillRecordPayload> = {
  id: "supplier_invoice.record", heldType: "engine.supplier_invoice.record", label: "Recording a supplier invoice", requires: [], permissions: ["bill.manage"], version: 1, recordsExecution: true,
  validate(payload) {
    const c = checkBillInput(payload); if (!c.ok) return c;
    const out: BillRecordPayload = { ...c.value };
    const raw = payload as Record<string, unknown>;
    if (raw.totals !== undefined) { const t = raw.totals; if (!isObj(t) || !whole(t.netMinor, 0) || !whole(t.taxMinor, 0) || !whole(t.grossMinor, 0)) return { ok: false, reason: "totals must be the engine's worked-out totals" }; out.totals = { netMinor: t.netMinor, taxMinor: t.taxMinor, grossMinor: t.grossMinor }; }
    if (raw.match !== undefined) out.match = raw.match;   // shown to the approver; never trusted: the match is worked out again when the bill is recorded
    return { ok: true, value: out };
  },
  async stamp(env, value) { const plan = await planBill(env, value); return { ...value, totals: plan.totals, match: plan.match }; },
  async check(env, value) {
    const plan = await planBill(env, value);
    if (value.totals && JSON.stringify(value.totals) !== JSON.stringify(plan.totals)) throw new EngineError("invalid_state", "The totals shown do not match the lines, so this needs to be proposed again.");
  },
  async execute(env, v, c) {
    const { totals: _t, match: _m, ...input } = v;
    const r = await facts.recordSupplierInvoice(env, input, ctxOf(c, "supplier_invoice.record"));
    return { documentId: r.documentId, number: r.number, matchStatus: r.matchStatus, eventId: r.eventId };
  },
};

interface BillVoidPayload { billId: number; reason: string; voidedOn: string }
export const supplierInvoiceVoid: CapabilityContract<BillVoidPayload> = {
  id: "supplier_invoice.void", heldType: "engine.supplier_invoice.void", label: "Voiding a supplier invoice", requires: [], permissions: ["bill.manage"], version: 1, recordsExecution: true,
  validate(payload) {
    if (!isObj(payload)) return { ok: false, reason: "the request must be an object" };
    const s = stray(payload, ["billId", "reason", "voidedOn"]);
    if (s) return { ok: false, reason: `${s} is not a field of this request` };
    if (!whole(payload.billId)) return { ok: false, reason: "billId must be a record number" };
    const r = checkReason(payload.reason, "void"); if (!r.ok) return r;
    const d = checkDate(payload.voidedOn, "voidedOn"); if (!d.ok) return d;
    return { ok: true, value: { billId: payload.billId, reason: r.value, voidedOn: d.value } };
  },
  async check(env, value) { await planBillVoid(env, value); },
  async execute(env, v, c) { const r = await facts.voidSupplierInvoice(env, v, ctxOf(c, "supplier_invoice.void")); return { eventId: r.eventId, reversalId: r.reversalId }; },
};

interface SupplierPaymentPayload { supplierId: number; amountMinor: number; currency: string; paidOn: string; method: string; allocations?: Array<{ billId: number; amountMinor: number }>; allocate?: "oldest_first" }
export const supplierPaymentRecord: CapabilityContract<SupplierPaymentPayload> = {
  id: "supplier_payment.record", heldType: "engine.supplier_payment.record", label: "Paying a supplier", requires: [], permissions: ["supplier_payment.record"], version: 1, recordsExecution: true,
  validate(payload) {
    if (!isObj(payload)) return { ok: false, reason: "the payment must be an object" };
    const s = stray(payload, ["supplierId", "amountMinor", "currency", "paidOn", "method", "allocations", "allocate"]);
    if (s) return { ok: false, reason: `${s} is not a field of a supplier payment` };
    if (!whole(payload.supplierId)) return { ok: false, reason: "supplierId must be a record number" };
    if (!nowMinor(payload.amountMinor)) return { ok: false, reason: "amountMinor must be a whole number of cents, at least 1" };
    if (typeof payload.currency !== "string" || !/^[A-Z]{3}$/.test(payload.currency)) return { ok: false, reason: "currency must be a 3-letter code such as ZAR" };
    const d = checkDate(payload.paidOn, "paidOn"); if (!d.ok) return d;
    if (typeof payload.method !== "string" || !["eft", "cash", "card", "cheque", "other"].includes(payload.method)) return { ok: false, reason: "method must be eft, cash, card, cheque or other" };
    const out: SupplierPaymentPayload = { supplierId: payload.supplierId, amountMinor: payload.amountMinor as number, currency: payload.currency, paidOn: d.value, method: payload.method };
    const hasAlloc = payload.allocations !== undefined && !(Array.isArray(payload.allocations) && payload.allocations.length === 0), wantsOldest = payload.allocate !== undefined;
    if (hasAlloc && wantsOldest) return { ok: false, reason: "name the bills to pay, or say oldest_first, not both" };
    if (wantsOldest) { if (payload.allocate !== "oldest_first") return { ok: false, reason: "allocate must be oldest_first" }; out.allocate = "oldest_first"; return { ok: true, value: out }; }
    if (!hasAlloc || !Array.isArray(payload.allocations)) return { ok: false, reason: "name the bills to pay (allocations), or say oldest_first" };
    const seen = new Set<number>(); const allocs: Array<{ billId: number; amountMinor: number }> = [];
    for (const [i, a] of payload.allocations.entries()) {
      if (!isObj(a) || stray(a, ["billId", "amountMinor"]) || !whole(a.billId) || !nowMinor(a.amountMinor)) return { ok: false, reason: `allocation ${i + 1} must be {billId, amountMinor} with whole numbers, at least 1` };
      if (seen.has(a.billId)) return { ok: false, reason: "the same bill is named twice; use one allocation per bill" };
      seen.add(a.billId); allocs.push({ billId: a.billId, amountMinor: a.amountMinor as number });
    }
    out.allocations = allocs;
    return { ok: true, value: out };
  },
  async check(env, value) { await planSupplierPayment(env, value); },
  async execute(env, v, c) { const r = await facts.recordSupplierPayment(env, v, ctxOf(c, "supplier_payment.record")); return { movementId: r.movementId, allocationIds: r.allocationIds, eventId: r.eventId }; },
};

export const supplierInvoicesFind: ReadCapability<{ supplierId?: number; status?: string }> = {
  id: "supplier_invoices.find", label: "Finding supplier invoices", permissions: ["bill.read"],
  validate(params) {
    if (!isObj(params)) return { ok: false, reason: "the request must be an object" };
    const s = stray(params, ["supplierId", "status"]);
    if (s) return { ok: false, reason: `${s} is not a field of this request` };
    const out: { supplierId?: number; status?: string } = {};
    if (params.supplierId !== undefined) { if (!whole(params.supplierId)) return { ok: false, reason: "supplierId must be a record number" }; out.supplierId = params.supplierId; }
    if (params.status !== undefined) { if (typeof params.status !== "string" || !["unpaid", "part_paid", "paid", "voided", "outstanding", "any"].includes(params.status)) return { ok: false, reason: "status must be unpaid, part_paid, paid, voided, outstanding or any" }; out.status = params.status; }
    return { ok: true, value: out };
  },
  async run(env, _viewer, value) {
    const all = await allBills(env, value);
    return { bills: all.slice(0, 100), count: all.length, truncated: all.length > 100, derivedBy: "bills.allBills" };
  },
};

// ---- stock: items, locations and the movement ledger (docs/decisions/inventory.md, inventory-integration.md) -------------------------------------------------------------------------------------------
// A stock movement that carries a VALUE (a receipt, an issue, a write-off) has the value the ENGINE worked out stamped on the proposal, so the approver sees what is being approved; at approval it is worked out again and a proposal whose value has since changed
// (another receipt moved the average) is refused as stale rather than approved at a different cost than the one that was shown.
const stockContract = <P extends object>(id: string, label: string, perm: "stock.manage" | "stock.move", check1: (v: unknown) => { ok: true; value: P } | { ok: false; reason: string }, plan: (env: Env, v: P) => Promise<unknown>, run: (env: Env, v: P, c: Parameters<CapabilityContract<P>["execute"]>[2]) => Promise<Record<string, unknown>>): CapabilityContract<P> => ({
  id, heldType: `engine.${id}`, label, requires: [], permissions: [perm], version: 1, recordsExecution: true,
  validate: (payload) => check1(payload),
  async stamp(env, value) { const p = (await plan(env, value)) as { valueMinor?: number } | undefined; return p && typeof p.valueMinor === "number" ? { ...value, valueMinor: p.valueMinor } : value; },
  async check(env, value) {
    const p = (await plan(env, value)) as { valueMinor?: number } | undefined;
    const shown = (value as { valueMinor?: number }).valueMinor;
    if (p && typeof p.valueMinor === "number" && shown !== undefined && shown !== p.valueMinor) throw new EngineError("stale", `The value of this has changed since it was proposed (it was ${shown}, it is now ${p.valueMinor}), so it needs to be proposed again.`);
  },
  async execute(env, v, c) { const { valueMinor: _shown, ...rest } = v as P & { valueMinor?: number }; return run(env, rest as unknown as P, c); },
});
export const itemCreate = stockContract<ItemInput>("item.create", "Adding a stock item", "stock.manage", checkItemInput, (e, v) => planItem(e, v), async (e, v, c) => { const r = await facts.createItem(e, v, ctxOf(c, "item.create")); return { itemId: r.itemId, eventId: r.eventId }; });
export const itemRevise = stockContract<ItemRevision>("item.revise", "Changing a stock item", "stock.manage", checkItemRevision, (e, v) => planItemRevision(e, v), async (e, v, c) => { const r = await facts.reviseItem(e, v, ctxOf(c, "item.revise")); return { eventId: r.eventId }; });
export const locationCreate = stockContract<LocationInput>("location.create", "Adding a stock location", "stock.manage", checkLocationInput, (e, v) => planLocation(e, v), async (e, v, c) => { const r = await facts.createLocation(e, v, ctxOf(c, "location.create")); return { locationId: r.locationId, eventId: r.eventId }; });
export const stockReceive = stockContract<ReceiveInput>("stock.receive", "Putting goods into stock", "stock.manage", checkReceiveInput, (e, v) => planReceive(e, v), async (e, v, c) => { const r = await facts.receiveStock(e, v, ctxOf(c, "stock.receive")); return { moveId: r.moveId, valueMinor: r.valueMinor, eventId: r.eventId }; });
export const stockIssue = stockContract<IssueInput>("stock.issue", "Issuing stock", "stock.move", checkIssueInput, (e, v) => planIssue(e, v), async (e, v, c) => { const r = await facts.issueStock(e, v, ctxOf(c, "stock.issue")); return { moveId: r.moveId, valueMinor: r.valueMinor, eventId: r.eventId }; });
export const stockTransfer = stockContract<TransferInput>("stock.transfer", "Moving stock between locations", "stock.move", checkTransferInput, (e, v) => planTransfer(e, v), async (e, v, c) => { const r = await facts.transferStock(e, v, ctxOf(c, "stock.transfer")); return { outMoveId: r.outMoveId, inMoveId: r.inMoveId }; });
export const stockAdjust = stockContract<AdjustInput>("stock.adjust", "Adjusting stock", "stock.manage", checkAdjustInput, (e, v) => planAdjust(e, v), async (e, v, c) => { const r = await facts.adjustStock(e, v, ctxOf(c, "stock.adjust")); return { moveId: r.moveId, valueMinor: r.valueMinor, eventId: r.eventId }; });
export const stockReverse = stockContract<StockReverseInput>("stock.reverse", "Reversing a stock movement", "stock.manage", checkStockReverse, (e, v) => planReverse(e, v), async (e, v, c) => { const r = await facts.reverseStockMove(e, v, ctxOf(c, "stock.reverse")); return { moveId: r.moveId, eventId: r.eventId }; });

const showValue = (viewer: { perms: ReadonlySet<string> | Set<string> }) => viewer.perms.has("stock.value");
export const itemsFind: ReadCapability<{ name?: string; sku?: string; active?: boolean; belowReorder?: boolean }> = {
  id: "items.find", label: "Finding stock items", permissions: ["stock.read"],
  validate(params) {
    if (!isObj(params)) return { ok: false, reason: "the request must be an object" };
    const s = stray(params, ["name", "sku", "active", "belowReorder"]); if (s) return { ok: false, reason: `${s} is not a field of this request` };
    const out: { name?: string; sku?: string; active?: boolean; belowReorder?: boolean } = {};
    for (const k of ["name", "sku"] as const) if (params[k] !== undefined) { if (typeof params[k] !== "string" || !(params[k] as string).trim() || (params[k] as string).length > 120) return { ok: false, reason: `${k} must be 1 to 120 characters` }; out[k] = (params[k] as string).trim(); }
    for (const k of ["active", "belowReorder"] as const) if (params[k] !== undefined) { if (typeof params[k] !== "boolean") return { ok: false, reason: `${k} must be true or false` }; out[k] = params[k] as boolean; }
    return { ok: true, value: out };
  },
  async run(env, viewer, v) {
    const rows = (await stockReport(env)).filter((r) => (v.name === undefined || r.name.toLowerCase().includes(v.name.toLowerCase())) && (v.sku === undefined || r.sku.toLowerCase() === v.sku.toLowerCase()) && (v.active === undefined || r.active === v.active) && (v.belowReorder === undefined || r.belowReorder === v.belowReorder));
    const money = showValue(viewer);
    return { items: rows.slice(0, 200).map((r) => ({ ref: { kind: "item", id: r.itemId }, id: r.itemId, sku: r.sku, name: r.name, unit: r.unit, active: r.active, quantityMilli: r.quantityMilli, reservedMilli: r.reservedMilli, availableMilli: r.availableMilli, reorderLevelMilli: r.reorderLevelMilli, belowReorder: r.belowReorder, valueMinor: money ? r.valueMinor : null, averageCostMinor: money ? r.averageCostMinor : null, locations: r.locations })), count: rows.length, truncated: rows.length > 200, derivedBy: "stock.stockReport" };
  },
};
export const stockOnHand: ReadCapability<{ itemId?: number; locationId?: number }> = {
  id: "stock.on_hand", label: "Stock on hand", permissions: ["stock.read"],
  validate(params) {
    if (!isObj(params)) return { ok: false, reason: "the request must be an object" };
    const s = stray(params, ["itemId", "locationId"]); if (s) return { ok: false, reason: `${s} is not a field of this request` };
    const out: { itemId?: number; locationId?: number } = {};
    for (const k of ["itemId", "locationId"] as const) if (params[k] !== undefined) { if (!whole(params[k])) return { ok: false, reason: `${k} must be a record number` }; out[k] = params[k] as number; }
    return { ok: true, value: out };
  },
  async run(env, viewer, v) {
    if (v.itemId !== undefined && !(await itemProfile(env, v.itemId))) throw new EngineError("not_found", "There is no such item.");
    const rows = await stockReport(env, v); const money = showValue(viewer);
    return { stock: rows.map((r) => ({ itemId: r.itemId, sku: r.sku, name: r.name, unit: r.unit, quantityMilli: r.quantityMilli, reservedMilli: r.reservedMilli, availableMilli: r.availableMilli, shortfallMilli: r.shortfallMilli, belowReorder: r.belowReorder, valueMinor: money ? r.valueMinor : null, averageCostMinor: money ? r.averageCostMinor : null, locations: r.locations })), locations: await allLocations(env), totalValueMinor: money ? rows.reduce((s, r) => s + r.valueMinor, 0) : null, derivedBy: "stock.stockReport" };
  },
};
export const stockLedgerRead: ReadCapability<{ itemId: number; from?: string; to?: string }> = {
  id: "stock.ledger", label: "The movements of a stock item", permissions: ["stock.read"],
  validate(params) {
    if (!isObj(params)) return { ok: false, reason: "the request must be an object" };
    const s = stray(params, ["itemId", "from", "to"]); if (s) return { ok: false, reason: `${s} is not a field of this request` };
    if (!whole(params.itemId)) return { ok: false, reason: "itemId must be a record number" };
    const out: { itemId: number; from?: string; to?: string } = { itemId: params.itemId };
    if (params.from !== undefined) { const d = checkDate(params.from, "from"); if (!d.ok) return d; out.from = d.value; }
    if (params.to !== undefined) { const d = checkDate(params.to, "to"); if (!d.ok) return d; out.to = d.value; }
    if (out.from !== undefined && out.to !== undefined && out.to < out.from) return { ok: false, reason: "to cannot be before from" };
    return { ok: true, value: out };
  },
  async run(env, viewer, v) {
    const item = await itemProfile(env, v.itemId); if (!item) throw new EngineError("not_found", "There is no such item.");
    const rows = await stockLedger(env, v.itemId, v); const money = showValue(viewer);
    const explained = await recordHistory(env, rows.map((r) => r.eventId));
    return { item: { id: item.id, sku: item.sku, name: item.name, unit: item.unit }, moves: rows.slice(-200).map((r) => ({ ...r, valueMinor: money ? r.valueMinor : null, explained: explained.find((h) => h.eventId === r.eventId) ?? null })), count: rows.length, truncated: rows.length > 200, derivedBy: "stock.stockLedger" };
  },
};

// ---- stock control: counts, reservations and reorder suggestions (docs/decisions/inventory.md, increment 2) -----------------------------------------------------------------------------------------------------
export const stockReserve = stockContract<ReserveInput>("stock.reserve", "Holding stock", "stock.move", checkReserveInput, (e, v) => planReserve(e, v), async (e, v, c) => { const r = await facts.reserveStock(e, v, ctxOf(c, "stock.reserve")); return { reservationId: r.reservationId, eventId: r.eventId }; });
export const stockRelease = stockContract<ReleaseInput>("stock.release", "Releasing held stock", "stock.move", checkReleaseInput, (e, v) => planRelease(e, v), async (e, v, c) => { const r = await facts.releaseReservation(e, v, ctxOf(c, "stock.release")); return { eventId: r.eventId }; });
// A count is valid only for the book it was made against: the variance is worked out and stamped on the proposal, and worked out again at approval; if it differs, the approval is refused as stale.
export const stockCount: CapabilityContract<CountInput> = {
  id: "stock.count", heldType: "engine.stock.count", label: "Counting stock", requires: [], permissions: ["stock.move"], version: 1, recordsExecution: true,
  validate: (payload) => checkCountInput(payload),
  async stamp(env, value) { const plan = await planCount(env, value); return { ...value, variances: plan.variances }; },
  async check(env, value) {
    const plan = await planCount(env, value);
    if (value.variances !== undefined && JSON.stringify(value.variances) !== JSON.stringify(plan.variances)) throw new EngineError("stale", "The stock changed after this count was made (the book is no longer what it was counted against), so it needs to be counted again.");
  },
  async execute(env, v, c) { const { variances: _shown, ...input } = v; const r = await facts.countStock(env, input, ctxOf(c, "stock.count")); return { countEventId: r.countEventId, moveIds: r.moveIds }; },
};
export const stockReservationsFind: ReadCapability<{ itemId?: number; status?: string }> = {
  id: "stock.reservations", label: "Stock held for quotations and jobs", permissions: ["stock.read"],
  validate(params) {
    if (!isObj(params)) return { ok: false, reason: "the request must be an object" };
    const s = stray(params, ["itemId", "status"]); if (s) return { ok: false, reason: `${s} is not a field of this request` };
    const out: { itemId?: number; status?: string } = {};
    if (params.itemId !== undefined) { if (!whole(params.itemId)) return { ok: false, reason: "itemId must be a record number" }; out.itemId = params.itemId; }
    if (params.status !== undefined) { if (typeof params.status !== "string" || !["open", "part_consumed", "consumed", "released", "outstanding", "any"].includes(params.status)) return { ok: false, reason: "status must be open, part_consumed, consumed, released, outstanding or any" }; out.status = params.status; }
    return { ok: true, value: out };
  },
  async run(env, _viewer, v) {
    if (v.itemId !== undefined && !(await itemProfile(env, v.itemId))) throw new EngineError("not_found", "There is no such item.");
    const list = await allReservations(env, v); const locs = new Map((await allLocations(env)).map((l) => [l.id, l.name]));
    const explained = await recordHistory(env, list.map((r) => r.eventId));
    const rows = [];
    for (const r of list.slice(0, 200)) { const it = await itemProfile(env, r.itemId); rows.push({ ...r, sku: it?.sku ?? null, name: it?.name ?? null, unit: it?.unit ?? null, locationName: r.locationId === null ? null : locs.get(r.locationId) ?? null, forDocument: r.forDocumentId === null ? null : await reservationDocument(env, r.forDocumentId), explained: explained.find((h) => h.eventId === r.eventId) ?? null }); }
    return { reservations: rows, count: list.length, truncated: list.length > 200, derivedBy: "stock.allReservations" };
  },
};
export const stockReorderRead: ReadCapability<Record<string, never>> = {
  id: "stock.reorder_suggestions", label: "Stock to reorder", permissions: ["stock.read"],
  validate(params) { if (!isObj(params)) return { ok: false, reason: "the request must be an object" }; const s = Object.keys(params)[0]; return s ? { ok: false, reason: `${s} is not a field of this request` } : { ok: true, value: {} }; },
  async run(env) {
    const list = await reorderSuggestions(env);
    return { suggestions: list, count: list.length, notes: ["Available stock is what is on hand less what is reserved. Stock still on order is added before deciding: for items named on purchase-order lines, what was ordered (or, once the rest is cancelled, what arrived) less what has been put into stock. Orders that do not name an item are not seen, so check them before ordering."], derivedBy: "stock.reorderSuggestions" };
  },
};

// ---- the procurement link (docs/decisions/inventory-integration.md): a delivery into stock and what has arrived but not been billed -------------------------------------------------------------------------------
export const stockReceiveDelivery: CapabilityContract<DeliveryInput> = {
  id: "stock.receive_delivery", heldType: "engine.stock.receive_delivery", label: "Putting a delivery into stock", requires: [], permissions: ["stock.manage"], version: 1, recordsExecution: true,
  validate: (payload) => checkDeliveryInput(payload),
  async stamp(env, value) { const p = await planDelivery(env, value); return { ...value, plan: p.lines }; },
  async check(env, value) { await planDelivery(env, value); },
  async execute(env, v, c) { const { plan: _shown, ...input } = v; const r = await facts.receiveDelivery(env, input, ctxOf(c, "stock.receive_delivery")); return { moveIds: r.moveIds, eventIds: r.eventIds }; },
};
export const goodsUnbilledRead: ReadCapability<{ supplierId?: number }> = {
  id: "goods.unbilled", label: "Goods received and not yet invoiced", permissions: ["bill.read"],
  validate(params) {
    if (!isObj(params)) return { ok: false, reason: "the request must be an object" };
    const s = stray(params, ["supplierId"]); if (s) return { ok: false, reason: `${s} is not a field of this request` };
    if (params.supplierId !== undefined && !whole(params.supplierId)) return { ok: false, reason: "supplierId must be a record number" };
    return { ok: true, value: params.supplierId === undefined ? {} : { supplierId: params.supplierId as number } };
  },
  async run(env, _viewer, v) {
    const lines = await goodsUnbilled(env, v);
    return { lines: lines.slice(0, 500), count: lines.length, totalValueMinor: lines.reduce((s, l) => s + l.valueMinor, 0), truncated: lines.length > 500, notes: ["Values are at the order's own price, before tax. Goods that arrived are listed even if the rest of the order was cancelled: the supplier will still invoice them."], derivedBy: "bills.goodsUnbilled" };
  },
};

// ---- the sales link: prices, returns, what is left to fulfil, and margin (docs/decisions/inventory.md, increment 4) -------------------------------------------------------------------------------------------------
export const itemPrice = stockContract<PriceInput>("item.price", "Setting a selling price", "price.manage" as never, checkPriceInput, (e, v) => planPrice(e, v), async (e, v, c) => { const r = await facts.setItemPrice(e, v, ctxOf(c, "item.price")); return { eventId: r.eventId }; });
export const stockReturn = stockContract<ReturnInput>("stock.return", "Taking returned goods back into stock", "stock.move", checkReturnInput, (e, v) => planReturn(e, v), async (e, v, c) => { const r = await facts.returnStock(e, v, ctxOf(c, "stock.return")); return { moveId: r.moveId, valueMinor: r.valueMinor, eventId: r.eventId }; });
export const pricesFind: ReadCapability<{ itemId?: number; asOf?: string }> = {
  id: "prices.find", label: "The price list", permissions: ["price.read"],
  validate(params) {
    if (!isObj(params)) return { ok: false, reason: "the request must be an object" };
    const s = stray(params, ["itemId", "asOf"]); if (s) return { ok: false, reason: `${s} is not a field of this request` };
    const out: { itemId?: number; asOf?: string } = {};
    if (params.itemId !== undefined) { if (!whole(params.itemId)) return { ok: false, reason: "itemId must be a record number" }; out.itemId = params.itemId; }
    if (params.asOf !== undefined) { const d = checkDate(params.asOf, "asOf"); if (!d.ok) return d; out.asOf = d.value; }
    return { ok: true, value: out };
  },
  async run(env, _viewer, v) {
    if (v.itemId !== undefined && !(await itemProfile(env, v.itemId))) throw new EngineError("not_found", "There is no such item.");
    const rows = [];
    for (const id of v.itemId !== undefined ? [v.itemId] : await allItemIds(env)) {
      const it = await itemProfile(env, id); if (!it) continue;
      const hist = await priceHistory(env, id), latest = priceInForce(hist), at = v.asOf === undefined ? null : priceInForce(hist, v.asOf);
      const explained = await recordHistory(env, hist.map((h) => h.eventId));
      rows.push({ itemId: id, sku: it.sku, name: it.name, unit: it.unit, currency: latest ? latest.currency : null, latestPriceMinor: latest ? latest.unitPriceMinor : null, effectiveFrom: latest ? latest.effectiveFrom : null, priceAsOfMinor: at ? at.unitPriceMinor : null, history: hist.map((h) => ({ ...h, explained: explained.find((e) => e.eventId === h.eventId) ?? null })) });
    }
    return { prices: rows, derivedBy: "stock.priceInForce" };
  },
};
export const stockFulfilmentRead: ReadCapability<{ customerId?: number }> = {
  id: "stock.fulfilment", label: "Invoiced stock still to issue", permissions: ["stock.read"],
  validate(params) {
    if (!isObj(params)) return { ok: false, reason: "the request must be an object" };
    const s = stray(params, ["customerId"]); if (s) return { ok: false, reason: `${s} is not a field of this request` };
    if (params.customerId !== undefined && !whole(params.customerId)) return { ok: false, reason: "customerId must be a record number" };
    return { ok: true, value: params.customerId === undefined ? {} : { customerId: params.customerId as number } };
  },
  async run(env, _viewer, v) { const lines = await fulfilment(env, v); return { lines: lines.slice(0, 500), count: lines.length, truncated: lines.length > 500, derivedBy: "stock.fulfilment" }; },
};
export const salesMarginRead: ReadCapability<{ from?: string; to?: string; customerId?: number; invoiceId?: number }> = {
  id: "sales.margin", label: "Margin on invoice lines", permissions: ["stock.value"],
  validate(params) {
    if (!isObj(params)) return { ok: false, reason: "the request must be an object" };
    const s = stray(params, ["from", "to", "customerId", "invoiceId"]); if (s) return { ok: false, reason: `${s} is not a field of this request` };
    const out: { from?: string; to?: string; customerId?: number; invoiceId?: number } = {};
    if (params.from !== undefined) { const d = checkDate(params.from, "from"); if (!d.ok) return d; out.from = d.value; }
    if (params.to !== undefined) { const d = checkDate(params.to, "to"); if (!d.ok) return d; out.to = d.value; }
    if (out.from !== undefined && out.to !== undefined && out.to < out.from) return { ok: false, reason: "to cannot be before from" };
    for (const k of ["customerId", "invoiceId"] as const) if (params[k] !== undefined) { if (!whole(params[k])) return { ok: false, reason: `${k} must be a record number` }; out[k] = params[k] as number; }
    return { ok: true, value: out };
  },
  async run(env, _viewer, v) {
    const lines = await marginReport(env, v), full = lines.filter((l) => l.costed === "full");
    return { lines: lines.slice(0, 500), count: lines.length, truncated: lines.length > 500, totals: { netMinor: full.reduce((a, l) => a + l.netMinor, 0), costMinor: full.reduce((a, l) => a + l.costMinor, 0), marginMinor: full.reduce((a, l) => a + (l.marginMinor ?? 0), 0) }, notes: ["Margin is shown only for lines issued in full: a part-issued line would show a false one. Revenue is the invoiced net price; credit notes are NOT netted off it, they are shown separately. Cost is the value of what was issued against the line, less issues reversed and goods returned."], derivedBy: "stock.marginReport" };
  },
};

export const READS: readonly ReadCapability<any>[] = [receivablesQuery, recordsGet, partiesFind, quotationsFind, businessGet, creditsFind, vatSummaryRead, expensesFind, purchaseOrdersFind, supplierInvoicesFind, itemsFind, stockOnHand, stockLedgerRead, stockReservationsFind, stockReorderRead, goodsUnbilledRead, pricesFind, stockFulfilmentRead, salesMarginRead];

// Provenance (invariant 6): every engine contract records what was understood at the door (an interpretation naming the capture and the held action) and finds the capture again at the confirm.
const withProvenance = <P>(c: CapabilityContract<P>): CapabilityContract<P> => ({
  ...c,
  recordUnderstood: async (env, info) => { await facts.recordInterpretation(env, { captureId: info.captureId, interpreter: info.interpreter, capability: c.id, actionId: info.actionId }); },
  captureOf: async (env, actionId) => (await env.OFFICE_DB.prepare("SELECT capture_id FROM eng_interpretation WHERE json_extract(payload_json, '$.actionId') = ? AND capability = ? ORDER BY id DESC LIMIT 1").bind(actionId, c.id).first<{ capture_id: number }>())?.capture_id ?? null,
});
export const ENGINE_CONTRACTS: readonly CapabilityContract<any>[] = ([paymentRecord, paymentCorrect, invoiceIssue, partyCreate, partyEdit, quotationCreate, quotationRevise, quotationAccept, creditNoteIssue, businessProfileSet, taxLockSet, creditApply, refundRecord, creditNoteVoid, debitNoteIssue, allocationRemove, refundVoid, paymentAllocate, paymentRefund, expenseRecord, expenseVoid, purchaseOrderCreate, goodsReceive, purchaseOrderCancel, supplierInvoiceRecord, supplierInvoiceVoid, supplierPaymentRecord, itemCreate, itemRevise, locationCreate, stockReceive, stockIssue, stockTransfer, stockAdjust, stockReverse, stockReserve, stockRelease, stockCount, stockReceiveDelivery, itemPrice, stockReturn] as CapabilityContract<any>[]).map((c) => withProvenance(c));
export const CAPABILITY_IDS: readonly string[] = [...READS.map((r) => r.id), ...ENGINE_CONTRACTS.map((c) => c.id)];
