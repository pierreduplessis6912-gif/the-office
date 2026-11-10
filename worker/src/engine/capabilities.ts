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

export const READS: readonly ReadCapability<any>[] = [receivablesQuery, recordsGet, partiesFind, quotationsFind, businessGet, creditsFind, vatSummaryRead];

// Provenance (invariant 6): every engine contract records what was understood at the door (an interpretation naming the capture and the held action) and finds the capture again at the confirm.
const withProvenance = <P>(c: CapabilityContract<P>): CapabilityContract<P> => ({
  ...c,
  recordUnderstood: async (env, info) => { await facts.recordInterpretation(env, { captureId: info.captureId, interpreter: info.interpreter, capability: c.id, actionId: info.actionId }); },
  captureOf: async (env, actionId) => (await env.OFFICE_DB.prepare("SELECT capture_id FROM eng_interpretation WHERE json_extract(payload_json, '$.actionId') = ? AND capability = ? ORDER BY id DESC LIMIT 1").bind(actionId, c.id).first<{ capture_id: number }>())?.capture_id ?? null,
});
export const ENGINE_CONTRACTS: readonly CapabilityContract<any>[] = ([paymentRecord, paymentCorrect, invoiceIssue, partyCreate, partyEdit, quotationCreate, quotationRevise, quotationAccept, creditNoteIssue, businessProfileSet, taxLockSet, creditApply, refundRecord, creditNoteVoid, debitNoteIssue, allocationRemove, refundVoid, paymentAllocate, paymentRefund] as CapabilityContract<any>[]).map((c) => withProvenance(c));
export const CAPABILITY_IDS: readonly string[] = [...READS.map((r) => r.id), ...ENGINE_CONTRACTS.map((c) => c.id)];
