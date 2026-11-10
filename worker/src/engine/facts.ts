// THE ONE WRITE PATH for the engine's facts (that no OTHER code writes these tables is observed by code inspection, not yet pinned by a test: the static ownership-boundary test is outstanding). Everything that records a party, a document, a payment, an allocation or a reversal comes through here, and every function here only INSERTS: no function
// updates, deletes or replaces a fact (tools/engine-ledger.test.js scans this folder for it), so a mistake is corrected by a new fact that reverses the old one, never by changing it. Each operation is
// ONE transaction (it all happens or none of it does; an operation called from inside another joins it), and each records an EVENT carrying who did it, under which contract version, from which
// capture and approval, plus a snapshot of the fact, which the integrity verifier compares for payments, allocations and documents (partial detection after the fact; integrity.ts says what it does and does not cover). Rules about what a document KIND means are not here: they belong to
// the capability that issues it. What IS here is structural: whole-number money, real relationships, conservation (a payment is never over-allocated, a document is never over-paid).
import type { Env } from "../types";
import { atomically } from "../atomic";
import { EngineError } from "./errors";
import { documentTotals as sumTotals, positiveMinor, wholeNumber, type Totals } from "./money";
import { readConfig } from "./config";
import { isEffective, outstandingForDocument, unallocatedForMovement } from "./ledger";
import { applyRevision, checkContact, checkName, checkRoles, partyProfile } from "./parties";
import { planQuotationAcceptance, planQuotationRevision } from "./quotations";
import { planCreditApplication, planCreditNote, planDebitNote, planPaymentAllocation, planPaymentRefund, planRefund, planVoid, refundMovementOrThrow, checkReason, type CreditLineInput } from "./credits";
import { applyProfile, businessProfile, checkProfileChange, taxLockDate, type ProfileChange } from "./business";
import { checkDate } from "./quotations";

export interface Ctx {
  actorEmail?: string | null;
  captureId?: number | null;
  proposalId?: number | null;
  approvedBy?: string | null;
  contract?: string | null;
  contractVersion?: number | null;
}

const one = <T>(env: Env, sql: string, ...binds: unknown[]) => env.OFFICE_DB.prepare(sql).bind(...binds).first<T>();
const many = async <T>(env: Env, sql: string, ...binds: unknown[]): Promise<T[]> => ((await env.OFFICE_DB.prepare(sql).bind(...binds).all<T>()).results ?? []);
const run = (env: Env, sql: string, ...binds: unknown[]) => env.OFFICE_DB.prepare(sql).bind(...binds).run();

// One transaction; an operation called from inside another joins it.
async function inTransaction<T>(env: Env, body: (env: Env) => Promise<T>): Promise<T> {
  if ((env as unknown as { __atomic?: boolean }).__atomic) return body(env);
  return atomically(env, body);
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new EngineError("invalid_input", `${label} is required`);
  return value.trim();
}
function oneOf<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) throw new EngineError("invalid_input", `${label} must be one of ${allowed.join(", ")}`);
  return value as T;
}
function date(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new EngineError("invalid_input", `${label} must be a calendar date (YYYY-MM-DD)`);
  const d = new Date(value + "T00:00:00Z");
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) throw new EngineError("invalid_input", `${label} is not a real calendar date`);
  return value;
}
function currencyCode(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Z]{3}$/.test(value)) throw new EngineError("invalid_input", "currency must be a 3-letter code such as ZAR");
  return value;
}
function id(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new EngineError("invalid_input", `${label} must be a record number`);
  return value;
}

async function appendEvent(env: Env, type: string, ctx: Ctx, payload: Record<string, unknown>, reason: string | null = null): Promise<number> {
  const row = await one<{ id: number }>(env,
    "INSERT INTO eng_event (type, actor_email, capture_id, proposal_id, approved_by, contract, contract_version, reason, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
    type, ctx.actorEmail ?? null, ctx.captureId ?? null, ctx.proposalId ?? null, ctx.approvedBy ?? null, ctx.contract ?? null, ctx.contractVersion ?? null, reason, JSON.stringify(payload));
  return Number(row!.id);
}

async function requireParty(env: Env, partyId: number): Promise<void> {
  if (!(await one(env, "SELECT 1 AS ok FROM eng_party WHERE id = ?", partyId))) throw new EngineError("not_found", `party ${partyId} does not exist in this business`);
}

// ---- parties -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
export async function recordParty(env: Env, input: { kind: string; name: string; roles?: string[]; contact?: Record<string, string> }, ctx: Ctx): Promise<{ id: number; eventId: number }> {
  const kind = oneOf(input.kind, ["person", "organisation"] as const, "kind");
  const name = text(input.name, "name");
  const roles = (input.roles ?? []).map((r) => text(r, "role"));
  let contact: Record<string, string | null> | undefined;
  if (input.contact !== undefined) { const c = checkContact(input.contact, false); if (!c.ok) throw new EngineError("invalid_input", c.reason); contact = c.value; }
  return inTransaction(env, async (tx) => {
    const eventId = await appendEvent(tx, "party.created", ctx, { kind, name, roles, ...(contact && Object.keys(contact).length ? { contact } : {}) });
    const row = await one<{ id: number }>(tx, "INSERT INTO eng_party (kind, name, event_id) VALUES (?, ?, ?) RETURNING id", kind, name, eventId);
    for (const role of roles) await run(tx, "INSERT INTO eng_party_role (party_id, role, event_id) VALUES (?, ?, ?)", row!.id, role, eventId);
    return { id: Number(row!.id), eventId };
  });
}

// An EDIT to a party is a NEW FACT, never an update: the party's rows stay as they were created, and a party.revised event carries only what changed. What the party is now is derived from both (parties.ts).
export async function reviseParty(env: Env, input: { partyId: number; name?: string; addRoles?: string[]; removeRoles?: string[]; contact?: Record<string, string | null> }, ctx: Ctx): Promise<{ eventId: number }> {
  const partyId = id(input.partyId, "party");
  const change: { name?: string; addRoles?: string[]; removeRoles?: string[]; contact?: Record<string, string | null> } = {};
  if (input.name !== undefined) { const n = checkName(input.name); if (!n.ok) throw new EngineError("invalid_input", n.reason); change.name = n.value; }
  if (input.addRoles !== undefined) { const r = checkRoles(input.addRoles, "addRoles", 1); if (!r.ok) throw new EngineError("invalid_input", r.reason); change.addRoles = r.value; }
  if (input.removeRoles !== undefined) { const r = checkRoles(input.removeRoles, "removeRoles", 1); if (!r.ok) throw new EngineError("invalid_input", r.reason); change.removeRoles = r.value; }
  if (input.contact !== undefined) { const c = checkContact(input.contact, true); if (!c.ok) throw new EngineError("invalid_input", c.reason); change.contact = c.value; }
  return inTransaction(env, async (tx) => {
    await requireParty(tx, partyId);
    const now = await partyProfile(tx, partyId);
    const plan = applyRevision(now!, change);
    if (!plan.ok) throw new EngineError(plan.code, plan.reason);
    const eventId = await appendEvent(tx, "party.revised", ctx, { partyId, ...change });
    return { eventId };
  });
}

// ---- documents ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
export interface DocumentLineInput { description: string; quantityMilli: number; unit?: string | null; unitPriceMinor: number; taxBp: number }
export interface DocumentInput { kind: string; direction: string; partyId: number; currency: string; reference?: string | null; issuedOn: string; terms?: Record<string, unknown>; lines: DocumentLineInput[] }

export async function recordDocument(env: Env, input: DocumentInput, ctx: Ctx): Promise<{ id: number; number: number; eventId: number; totals: Totals }> {
  const kind = text(input.kind, "kind");
  const direction = oneOf(input.direction, ["sell", "buy"] as const, "direction");
  const partyId = id(input.partyId, "party");
  const currency = currencyCode(input.currency);
  const issuedOn = date(input.issuedOn, "issue date");
  if (!Array.isArray(input.lines) || input.lines.length === 0) throw new EngineError("invalid_input", "a document needs at least one line");
  const lines = input.lines.map((l) => ({
    description: text(l.description, "line description"),
    quantityMilli: wholeNumber(l.quantityMilli, "quantity", 1),
    unit: l.unit ?? null,
    unitPriceMinor: wholeNumber(l.unitPriceMinor, "unit price", 0),
    taxBp: wholeNumber(l.taxBp, "tax rate", 0, 10000),
  }));
  const totals = sumTotals(lines);   // refuses what cannot be held exactly, before anything is written
  return inTransaction(env, async (tx) => {
    await requireParty(tx, partyId);
    const eventId = await appendEvent(tx, "document.issued", ctx, { kind, direction, partyId, currency, issuedOn, reference: input.reference ?? null, lines, totals });
    const doc = await one<{ id: number }>(tx, "INSERT INTO eng_document (kind, direction, party_id, currency, reference, issued_on, terms_json, event_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
      kind, direction, partyId, currency, input.reference ?? null, issuedOn, JSON.stringify(input.terms ?? {}), eventId);
    let no = 0;
    for (const l of lines) {
      no += 1;
      await run(tx, "INSERT INTO eng_document_line (document_id, line_no, description, quantity_milli, unit, unit_price_minor, tax_bp) VALUES (?, ?, ?, ?, ?, ?, ?)", doc!.id, no, l.description, l.quantityMilli, l.unit, l.unitPriceMinor, l.taxBp);
    }
    const next = await one<{ n: number }>(tx, "SELECT COALESCE(MAX(number), 0) + 1 AS n FROM eng_document_number WHERE kind = ?", kind);
    await run(tx, "INSERT INTO eng_document_number (kind, number, document_id) VALUES (?, ?, ?)", kind, Number(next!.n), doc!.id);
    return { id: Number(doc!.id), number: Number(next!.n), eventId, totals };
  });
}

// A REVISION of a quotation is a NEW document (its own number) plus a quotation.revised event saying which one it replaces; the old document is never touched. Customer, currency and direction stay as they were.
export async function reviseQuotation(env: Env, input: { quotationId: number; lines?: DocumentLineInput[]; validUntil?: string | null; reference?: string | null; issuedOn?: string }, ctx: Ctx): Promise<{ documentId: number; number: number; eventId: number; totals: Totals }> {
  const quotationId = id(input.quotationId, "quotation");
  return inTransaction(env, async (tx) => {
    const plan = await planQuotationRevision(tx, { ...input, quotationId });
    const doc = await recordDocument(tx, { kind: "quotation", direction: plan.direction, partyId: plan.old.partyId, currency: plan.old.currency, reference: plan.reference, issuedOn: plan.issuedOn, terms: plan.validUntil ? { validUntil: plan.validUntil } : {}, lines: plan.lines }, ctx);
    const eventId = await appendEvent(tx, "quotation.revised", ctx, { documentId: doc.id, supersedes: quotationId });
    return { documentId: doc.id, number: doc.number, eventId, totals: doc.totals };
  });
}

// ACCEPTANCE is an event about the current revision: no fact row, nothing edited. What state a quotation is in is derived (quotations.ts).
export async function acceptQuotation(env: Env, input: { quotationId: number }, ctx: Ctx): Promise<{ eventId: number }> {
  const quotationId = id(input.quotationId, "quotation");
  return inTransaction(env, async (tx) => {
    await planQuotationAcceptance(tx, quotationId);
    return { eventId: await appendEvent(tx, "quotation.accepted", ctx, { documentId: quotationId }) };
  });
}

// A CREDIT NOTE credits an invoice (credits.ts has the rules). It records four facts in ONE transaction: the credit_note document, a non-cash "in" movement (method "credit") for its total, an allocation of the part that is
// still owed on the invoice (the rest stays UNAPPLIED on the customer; nothing is refunded here), and a credit_note.issued event that ties them to the invoice. The invoice itself is never touched.
export async function issueCreditNote(env: Env, input: { invoiceId: number; reason: string; issuedOn: string; lines: CreditLineInput[] }, ctx: Ctx): Promise<{ documentId: number; number: number; movementId: number; appliedMinor: number; unappliedMinor: number; eventId: number; totals: Totals }> {
  const invoiceId = id(input.invoiceId, "invoice");
  return inTransaction(env, async (tx) => {
    const plan = await planCreditNote(tx, { ...input, invoiceId });
    const doc = await recordDocument(tx, { kind: "credit_note", direction: "sell", partyId: plan.partyId, currency: plan.currency, reference: plan.invoiceNumber !== null ? `Credit for invoice #${plan.invoiceNumber}` : "Credit note", issuedOn: plan.issuedOn, terms: { creditsDocumentId: invoiceId, reason: plan.reason }, lines: plan.docLines }, ctx);
    const pay = await recordPayment(tx, { direction: "in", partyId: plan.partyId, amountMinor: doc.totals.grossMinor, currency: plan.currency, occurredOn: plan.issuedOn, method: "credit", allocations: plan.appliedMinor > 0 ? [{ documentId: invoiceId, amountMinor: plan.appliedMinor }] : [] }, ctx);
    const eventId = await appendEvent(tx, "credit_note.issued", ctx, { documentId: doc.id, invoiceId, movementId: pay.movementId, appliedMinor: plan.appliedMinor, unappliedMinor: plan.unappliedMinor, reason: plan.reason, lines: plan.eventLines }, plan.reason);
    return { documentId: doc.id, number: doc.number, movementId: pay.movementId, appliedMinor: plan.appliedMinor, unappliedMinor: plan.unappliedMinor, eventId, totals: doc.totals };
  });
}

// The business's own particulars and its tax lock are EVENTS, never edited rows (business.ts derives the current profile and lock from them). The lock only moves FORWARD.
export async function setBusinessProfile(env: Env, change: ProfileChange, ctx: Ctx): Promise<{ eventId: number }> {
  const c = checkProfileChange(change); if (!c.ok) throw new EngineError("invalid_input", c.reason);
  return inTransaction(env, async (tx) => {
    const a = applyProfile(await businessProfile(tx), c.value);
    if (!a.ok) throw new EngineError("invalid_state", a.reason);
    return { eventId: await appendEvent(tx, "business.profile_set", ctx, c.value) };
  });
}
export async function setTaxLock(env: Env, input: { lockDate: string }, ctx: Ctx): Promise<{ eventId: number }> {
  const d = checkDate(input.lockDate, "lockDate"); if (!d.ok) throw new EngineError("invalid_input", d.reason);
  return inTransaction(env, async (tx) => {
    const now = await taxLockDate(tx);
    if (now !== null && d.value <= now) throw new EngineError("invalid_state", `The tax lock is already at ${now}; it can only move forward.`);
    return { eventId: await appendEvent(tx, "tax_lock.set", ctx, { lockDate: d.value }) };
  });
}

// APPLY a leftover credit to another invoice of the same customer: ONE allocation of the credit note's movement to the invoice, plus a credit.allocated event. No new money, no new document. It carries its own date and is not
// blocked by the tax lock (it changes no VAT). credits.ts has the rules.
export async function applyCredit(env: Env, input: { creditNoteId: number; invoiceId: number; amountMinor: number; appliedOn: string }, ctx: Ctx): Promise<{ allocationId: number; eventId: number }> {
  const creditNoteId = id(input.creditNoteId, "credit note"), invoiceId = id(input.invoiceId, "invoice");
  return inTransaction(env, async (tx) => {
    const plan = await planCreditApplication(tx, { ...input, creditNoteId, invoiceId });
    const al = await insertAllocation(tx, { movementId: plan.movementId, documentId: invoiceId, amountMinor: plan.amountMinor }, ctx);
    const eventId = await appendEvent(tx, "credit.allocated", ctx, { creditNoteId, movementId: plan.movementId, invoiceId, allocationId: al.id, amountMinor: plan.amountMinor, appliedOn: plan.appliedOn });
    return { allocationId: al.id, eventId };
  });
}

// REFUND a leftover credit: a separate money-OUT movement to the customer (nothing is allocated) plus a credit.refunded event naming the credit's movement, so the credit left (credits.ts) and the customer's account fall by it.
export async function refundCredit(env: Env, input: { creditNoteId: number; amountMinor: number; refundedOn: string; method: string }, ctx: Ctx): Promise<{ movementId: number; eventId: number }> {
  const creditNoteId = id(input.creditNoteId, "credit note");
  return inTransaction(env, async (tx) => {
    const plan = await planRefund(tx, { ...input, creditNoteId });
    const mv = await insertMovement(tx, { direction: "out", partyId: plan.partyId, amountMinor: plan.amountMinor, currency: plan.currency, occurredOn: plan.refundedOn, method: plan.method }, ctx);
    const eventId = await appendEvent(tx, "credit.refunded", ctx, { creditNoteId, movementId: plan.movementId, refundMovementId: mv.id, amountMinor: plan.amountMinor, refundedOn: plan.refundedOn, method: plan.method });
    return { movementId: mv.id, eventId };
  });
}

// VOID a credit note: reverse its movement (which reverses its allocation) and then the document itself, and record a credit_note.voided event. Refused once any of its credit has been applied elsewhere or refunded, and once it
// falls in a locked tax period. Nothing is deleted: the reversals are new facts, and a voided credit note simply stops being effective.
export async function voidCreditNote(env: Env, input: { creditNoteId: number; reason: string; voidedOn: string }, ctx: Ctx): Promise<{ eventId: number; reversalIds: number[] }> {
  const creditNoteId = id(input.creditNoteId, "credit note");
  return inTransaction(env, async (tx) => {
    const plan = await planVoid(tx, { ...input, creditNoteId });
    const m = await reverse(tx, { movementId: plan.movementId, reason: plan.reason }, ctx);
    const d = await reverse(tx, { documentId: creditNoteId, reason: plan.reason }, ctx);
    const eventId = await appendEvent(tx, "credit_note.voided", ctx, { documentId: creditNoteId, invoiceId: plan.invoiceId, reason: plan.reason, voidedOn: plan.voidedOn }, plan.reason);
    return { eventId, reversalIds: [m.id, d.id] };
  });
}

// A DEBIT NOTE increases an invoice already issued: a document of kind debit_note (owed by the customer like an invoice) whose lines inherit the tax rate of the invoice line they add to, and a debit_note.issued event.
export async function issueDebitNote(env: Env, input: { invoiceId: number; reason: string; issuedOn: string; lines: CreditLineInput[] }, ctx: Ctx): Promise<{ documentId: number; number: number; eventId: number; totals: Totals }> {
  const invoiceId = id(input.invoiceId, "invoice");
  return inTransaction(env, async (tx) => {
    const plan = await planDebitNote(tx, { ...input, invoiceId });
    const doc = await recordDocument(tx, { kind: "debit_note", direction: "sell", partyId: plan.partyId, currency: plan.currency, reference: plan.invoiceNumber !== null ? `Debit for invoice #${plan.invoiceNumber}` : "Debit note", issuedOn: plan.issuedOn, terms: { debitsDocumentId: invoiceId, reason: plan.reason }, lines: plan.docLines }, ctx);
    const eventId = await appendEvent(tx, "debit_note.issued", ctx, { documentId: doc.id, invoiceId, reason: plan.reason, lines: plan.eventLines }, plan.reason);
    return { documentId: doc.id, number: doc.number, eventId, totals: doc.totals };
  });
}

// UNDO is a new fact, never an edit: removing an allocation or voiding a refund records a reversal, and every derived figure (the credit left, the credit owed back, whether a credit note can be voided) honours it. Neither changes VAT,
// so neither is blocked by the tax lock.
export async function removeAllocation(env: Env, input: { allocationId: number; reason: string }, ctx: Ctx): Promise<{ reversalId: number }> {
  const allocationId = id(input.allocationId, "allocation");
  const reason = checkReason(input.reason, "removal"); if (!reason.ok) throw new EngineError("invalid_input", reason.reason);
  return inTransaction(env, async (tx) => ({ reversalId: (await reverse(tx, { allocationId, reason: reason.value }, ctx)).id }));
}
export async function voidRefund(env: Env, input: { movementId: number; reason: string }, ctx: Ctx): Promise<{ reversalId: number }> {
  const movementId = id(input.movementId, "refund");
  const reason = checkReason(input.reason, "void"); if (!reason.ok) throw new EngineError("invalid_input", reason.reason);
  return inTransaction(env, async (tx) => { await refundMovementOrThrow(tx, movementId); return { reversalId: (await reverse(tx, { movementId, reason: reason.value }, ctx)).id }; });
}
// An unapplied OVERPAYMENT is allocated to another invoice of the same customer, or refunded, exactly as a credit is (credits.ts).
export async function allocatePayment(env: Env, input: { paymentId: number; invoiceId: number; amountMinor: number; allocatedOn: string }, ctx: Ctx): Promise<{ allocationId: number; eventId: number }> {
  const paymentId = id(input.paymentId, "payment"), invoiceId = id(input.invoiceId, "invoice");
  return inTransaction(env, async (tx) => {
    const plan = await planPaymentAllocation(tx, { ...input, paymentId, invoiceId });
    const al = await insertAllocation(tx, { movementId: paymentId, documentId: invoiceId, amountMinor: plan.amountMinor }, ctx);
    const eventId = await appendEvent(tx, "overpayment.allocated", ctx, { movementId: paymentId, invoiceId, allocationId: al.id, amountMinor: plan.amountMinor, allocatedOn: plan.allocatedOn });
    return { allocationId: al.id, eventId };
  });
}
export async function refundPayment(env: Env, input: { paymentId: number; amountMinor: number; refundedOn: string; method: string }, ctx: Ctx): Promise<{ movementId: number; eventId: number }> {
  const paymentId = id(input.paymentId, "payment");
  return inTransaction(env, async (tx) => {
    const plan = await planPaymentRefund(tx, { ...input, paymentId });
    const mv = await insertMovement(tx, { direction: "out", partyId: plan.partyId, amountMinor: plan.amountMinor, currency: plan.currency, occurredOn: plan.refundedOn, method: plan.method }, ctx);
    const eventId = await appendEvent(tx, "overpayment.refunded", ctx, { movementId: paymentId, refundMovementId: mv.id, amountMinor: plan.amountMinor, refundedOn: plan.refundedOn, method: plan.method });
    return { movementId: mv.id, eventId };
  });
}

// ---- money -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
export interface MovementInput { direction: string; partyId: number; amountMinor: number; currency: string; occurredOn: string; method?: string | null }

async function insertMovement(tx: Env, input: MovementInput, ctx: Ctx): Promise<{ id: number; eventId: number }> {
  const direction = oneOf(input.direction, ["in", "out"] as const, "direction");
  const partyId = id(input.partyId, "party");
  const amountMinor = positiveMinor(input.amountMinor, "amount");
  const currency = currencyCode(input.currency);
  const occurredOn = date(input.occurredOn, "date");
  await requireParty(tx, partyId);
  const eventId = await appendEvent(tx, direction === "in" ? "payment.recorded" : "payment.made", ctx, { direction, partyId, amountMinor, currency, occurredOn, method: input.method ?? null });
  const row = await one<{ id: number }>(tx, "INSERT INTO eng_money_movement (direction, party_id, amount_minor, currency, occurred_on, method, event_id) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id", direction, partyId, amountMinor, currency, occurredOn, input.method ?? null, eventId);
  return { id: Number(row!.id), eventId };
}

export async function recordMovement(env: Env, input: MovementInput, ctx: Ctx): Promise<{ id: number; eventId: number }> {
  // validated before a transaction is opened, so a malformed request costs nothing
  oneOf(input.direction, ["in", "out"] as const, "direction"); positiveMinor(input.amountMinor, "amount"); currencyCode(input.currency); date(input.occurredOn, "date");
  return inTransaction(env, (tx) => insertMovement(tx, input, ctx));
}

async function insertAllocation(tx: Env, input: { movementId: number; documentId: number; amountMinor: number }, ctx: Ctx): Promise<{ id: number; eventId: number }> {
  const movementId = id(input.movementId, "payment");
  const documentId = id(input.documentId, "document");
  const amountMinor = positiveMinor(input.amountMinor, "amount");
  const mv = await one<{ direction: string; currency: string }>(tx, "SELECT direction, currency FROM eng_money_movement WHERE id = ?", movementId);
  if (!mv) throw new EngineError("not_found", `payment ${movementId} does not exist in this business`);
  const dc = await one<{ kind: string; direction: string; currency: string }>(tx, "SELECT kind, direction, currency FROM eng_document WHERE id = ?", documentId);
  if (!dc) throw new EngineError("not_found", `document ${documentId} does not exist in this business`);
  if (!(await isEffective(tx, "movement", movementId))) throw new EngineError("not_effective", "that payment has been reversed");
  if (!(await isEffective(tx, "document", documentId))) throw new EngineError("not_effective", "that document has been reversed");
  if (mv.currency !== dc.currency) throw new EngineError("currency_mismatch", `a ${mv.currency} payment cannot settle a ${dc.currency} document`);
  if ((mv.direction === "in") !== (dc.direction === "sell")) throw new EngineError("invalid_input", "money in settles what customers owe, money out settles what is owed to suppliers");
  const cfg = await readConfig(tx);
  if (!(dc.direction === "sell" ? cfg.receivableKinds : cfg.payableKinds).includes(dc.kind)) throw new EngineError("invalid_input", `a ${dc.kind} is not settled by payments in this business`);
  if (amountMinor > (await unallocatedForMovement(tx, movementId))) throw new EngineError("over_allocated", "that is more than the payment has left to allocate");
  if (amountMinor > (await outstandingForDocument(tx, documentId))) throw new EngineError("over_allocated", "that is more than the document still owes");
  const eventId = await appendEvent(tx, "payment.allocated", ctx, { movementId, documentId, amountMinor });
  const row = await one<{ id: number }>(tx, "INSERT INTO eng_allocation (movement_id, document_id, amount_minor, event_id) VALUES (?, ?, ?, ?) RETURNING id", movementId, documentId, amountMinor, eventId);
  return { id: Number(row!.id), eventId };
}

export async function allocate(env: Env, input: { movementId: number; documentId: number; amountMinor: number }, ctx: Ctx): Promise<{ id: number; eventId: number }> {
  positiveMinor(input.amountMinor, "amount");
  return inTransaction(env, (tx) => insertAllocation(tx, input, ctx));
}

// A payment and its allocations as ONE operation: the payment, then each allocation, all or nothing. Allocating more than the payment holds, or more than a document owes, refuses the whole thing.
export async function recordPayment(env: Env, input: MovementInput & { allocations?: Array<{ documentId: number; amountMinor: number }> }, ctx: Ctx): Promise<{ movementId: number; allocationIds: number[]; eventIds: number[] }> {
  oneOf(input.direction, ["in", "out"] as const, "direction"); positiveMinor(input.amountMinor, "amount"); currencyCode(input.currency); date(input.occurredOn, "date");
  for (const a of input.allocations ?? []) positiveMinor(a.amountMinor, "allocation amount");
  return inTransaction(env, async (tx) => {
    const mv = await insertMovement(tx, input, ctx);
    const allocationIds: number[] = [];
    const eventIds = [mv.eventId];
    for (const a of input.allocations ?? []) {
      const al = await insertAllocation(tx, { movementId: mv.id, documentId: a.documentId, amountMinor: a.amountMinor }, ctx);
      allocationIds.push(al.id);
      eventIds.push(al.eventId);
    }
    return { movementId: mv.id, allocationIds, eventIds };
  });
}

// ---- corrections -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
export interface ReverseInput { movementId?: number; allocationId?: number; documentId?: number; reason: string; replacedByMovementId?: number | null }

// Reverse ONE thing, once, with a reason. Nothing is edited or removed: the reversal is a new fact, and from then on the reversed fact is simply not effective. Reversing a payment reverses its allocations
// with it (they are part of it); an allocation can be reversed alone; a document that still has effective allocations cannot be reversed until they are.
export async function reverse(env: Env, input: ReverseInput, ctx: Ctx): Promise<{ id: number; eventId: number; reversedAllocationIds: number[] }> {
  const targets = [input.movementId, input.allocationId, input.documentId].filter((x) => x !== undefined && x !== null);
  if (targets.length !== 1) throw new EngineError("invalid_input", "reverse exactly one thing: a payment, an allocation or a document");
  const reason = text(input.reason, "reason");
  return inTransaction(env, async (tx) => {
    const alreadyReversed = (column: string, target: number) => one(tx, `SELECT 1 AS ok FROM eng_reversal WHERE ${column} = ?`, target);
    if (input.movementId !== undefined && input.movementId !== null) {
      const movementId = id(input.movementId, "payment");
      if (!(await one(tx, "SELECT 1 AS ok FROM eng_money_movement WHERE id = ?", movementId))) throw new EngineError("not_found", `payment ${movementId} does not exist in this business`);
      if (await alreadyReversed("movement_id", movementId)) throw new EngineError("already_reversed", "that payment has already been reversed");
      const allocations = await many<{ id: number }>(tx, "SELECT a.id FROM eng_allocation a WHERE a.movement_id = ? AND NOT EXISTS (SELECT 1 FROM eng_reversal r WHERE r.allocation_id = a.id) ORDER BY a.id", movementId);
      const eventId = await appendEvent(tx, "payment.reversed", ctx, { movementId, reason, replacedByMovementId: input.replacedByMovementId ?? null }, reason);
      const row = await one<{ id: number }>(tx, "INSERT INTO eng_reversal (movement_id, reason, replaced_by_movement_id, event_id) VALUES (?, ?, ?, ?) RETURNING id", movementId, reason, input.replacedByMovementId ?? null, eventId);
      for (const a of allocations) {
        const aEvent = await appendEvent(tx, "payment.allocation_reversed", ctx, { allocationId: a.id, movementId, reason }, reason);
        await run(tx, "INSERT INTO eng_reversal (allocation_id, reason, event_id) VALUES (?, ?, ?)", a.id, reason, aEvent);
      }
      return { id: Number(row!.id), eventId, reversedAllocationIds: allocations.map((a) => a.id) };
    }
    if (input.allocationId !== undefined && input.allocationId !== null) {
      const allocationId = id(input.allocationId, "allocation");
      if (!(await one(tx, "SELECT 1 AS ok FROM eng_allocation WHERE id = ?", allocationId))) throw new EngineError("not_found", `allocation ${allocationId} does not exist in this business`);
      if (await alreadyReversed("allocation_id", allocationId)) throw new EngineError("already_reversed", "that allocation has already been reversed");
      if (!(await isEffective(tx, "allocation", allocationId))) throw new EngineError("not_effective", "that allocation already stopped counting because its payment or document was reversed");
      const eventId = await appendEvent(tx, "payment.allocation_reversed", ctx, { allocationId, reason }, reason);
      const row = await one<{ id: number }>(tx, "INSERT INTO eng_reversal (allocation_id, reason, event_id) VALUES (?, ?, ?) RETURNING id", allocationId, reason, eventId);
      return { id: Number(row!.id), eventId, reversedAllocationIds: [allocationId] };
    }
    const documentId = id(input.documentId, "document");
    if (!(await one(tx, "SELECT 1 AS ok FROM eng_document WHERE id = ?", documentId))) throw new EngineError("not_found", `document ${documentId} does not exist in this business`);
    if (await alreadyReversed("document_id", documentId)) throw new EngineError("already_reversed", "that document has already been reversed");
    const live = await one<{ n: number }>(tx, `SELECT COUNT(*) AS n FROM eng_allocation a WHERE a.document_id = ?
       AND NOT EXISTS (SELECT 1 FROM eng_reversal r WHERE r.allocation_id = a.id) AND NOT EXISTS (SELECT 1 FROM eng_reversal r WHERE r.movement_id = a.movement_id)`, documentId);
    if (Number(live?.n ?? 0) > 0) throw new EngineError("has_dependents", "that document still has payments allocated to it; reverse those first");
    const eventId = await appendEvent(tx, "document.reversed", ctx, { documentId, reason }, reason);
    const row = await one<{ id: number }>(tx, "INSERT INTO eng_reversal (document_id, reason, event_id) VALUES (?, ?, ?) RETURNING id", documentId, reason, eventId);
    return { id: Number(row!.id), eventId, reversedAllocationIds: [] };
  });
}

// Correct a payment: record the REPLACEMENT first (so the reversal can point at it), reverse the original (and with it its allocations), then allocate the replacement. One transaction.
export async function correctMovement(env: Env, input: { movementId: number; reason: string; replacement: { partyId: number; amountMinor?: number; occurredOn?: string; method?: string | null; allocations?: Array<{ documentId: number; amountMinor: number }> } }, ctx: Ctx): Promise<{ reversalId: number; replacementMovementId: number; allocationIds: number[]; eventIds: number[] }> {
  const reason = text(input.reason, "reason");
  return inTransaction(env, async (tx) => {
    const orig = await one<{ direction: string; amount_minor: number; currency: string; occurred_on: string; method: string | null }>(tx, "SELECT direction, amount_minor, currency, occurred_on, method FROM eng_money_movement WHERE id = ?", id(input.movementId, "payment"));
    if (!orig) throw new EngineError("not_found", `payment ${input.movementId} does not exist in this business`);
    if (!(await isEffective(tx, "movement", input.movementId))) throw new EngineError("already_reversed", "that payment has already been reversed");
    const repl = await insertMovement(tx, { direction: orig.direction, partyId: input.replacement.partyId, amountMinor: input.replacement.amountMinor ?? orig.amount_minor, currency: orig.currency, occurredOn: input.replacement.occurredOn ?? orig.occurred_on, method: input.replacement.method === undefined ? orig.method : input.replacement.method }, ctx);
    const rev = await reverse(tx, { movementId: input.movementId, reason, replacedByMovementId: repl.id }, ctx);
    const allocationIds: number[] = [];
    const eventIds = [repl.eventId, rev.eventId];
    for (const a of input.replacement.allocations ?? []) {
      const al = await insertAllocation(tx, { movementId: repl.id, documentId: a.documentId, amountMinor: a.amountMinor }, ctx);
      allocationIds.push(al.id);
      eventIds.push(al.eventId);
    }
    return { reversalId: rev.id, replacementMovementId: repl.id, allocationIds, eventIds };
  });
}

/**
 * What an interpreter understood from a capture: a proposal, never business truth. The door writes it for an engine held type, so the trail runs capture, interpretation, proposal, approval, execution
 * (docs/decisions/first-slice.md part E, invariant 6), and the confirm step finds the capture again through it. The interpreter is 'script' unless the caller says 'model': today the only interpreter is the app's scripted one.
 */
export async function recordInterpretation(env: Env, input: { captureId: number; interpreter: "script" | "model"; capability: string; actionId: number }): Promise<{ id: number }> {
  const row = await env.OFFICE_DB.prepare("INSERT INTO eng_interpretation (capture_id, interpreter, capability, payload_json, status) VALUES (?, ?, ?, ?, 'proposed') RETURNING id")
    .bind(input.captureId, input.interpreter, input.capability, JSON.stringify({ actionId: input.actionId }))
    .first<{ id: number }>();
  return { id: row!.id };
}
