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
    if (value.partyId !== undefined) party = await one<{ id: number; name: string }>(env, "SELECT id, name FROM eng_party WHERE id = ?", value.partyId);
    else {
      const rows = await many<{ id: number; name: string }>(env, "SELECT id, name FROM eng_party WHERE lower(name) = lower(?) ORDER BY id", value.partyName);
      if (rows.length > 1) throw new Ambiguous(rows);
      party = rows[0] ?? null;
    }
    if (!party) throw new EngineError("not_found", "There is no such customer.");
    const acct = await outstandingForParty(env, party.id);
    const currency = acct.documents[0] ? (await one<{ currency: string }>(env, "SELECT currency FROM eng_document WHERE id = ?", acct.documents[0].id))?.currency ?? null : null;
    return {
      party: { id: party.id, name: party.name }, currency, totalMinor: acct.totalMinor,
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
export const READS: readonly ReadCapability<any>[] = [receivablesQuery, recordsGet];

// ---- writes ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
const ctxOf = (c: { actionId: number; actorEmail: string | null }, id: string) => ({ actorEmail: c.actorEmail, approvedBy: c.actorEmail, proposalId: c.actionId, contract: id, contractVersion: 1 });
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

export const ENGINE_CONTRACTS: readonly CapabilityContract<any>[] = [paymentRecord, paymentCorrect, invoiceIssue];
export const CAPABILITY_IDS: readonly string[] = [...READS.map((r) => r.id), ...ENGINE_CONTRACTS.map((c) => c.id)];
