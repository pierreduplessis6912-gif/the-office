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
import { planExpense, planExpenseVoid, type ExpenseInput } from "./expenses";
import { planCancel, planOrder, planReceipt, type ReceiptLineInput } from "./purchasing";
import { checkWriteDownInput, planWriteDown, type WriteDownInput } from "./stock";
import { planPrice, planReturn, type PriceInput, type ReturnInput } from "./stock";
import { planDelivery, planLineItems, type DeliveryInput, type OrderLineItem } from "./stock";
import { planCount, planRelease, planReserve, type CountInput, type ReleaseInput, type ReserveInput } from "./stock";
import { planAdjust, planIssue, planItem, planItemRevision, planLocation, planReceive, planReverse, planTransfer, type AdjustInput, type IssueInput, type ItemInput, type ItemRevision, type LocationInput, type ReceiveInput, type StockReverseInput, type TransferInput } from "./stock";
import { planBill, planBillVoid, planSupplierPayment, type BillInput, type PaymentInput } from "./bills";
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

// An EXPENSE is a paid purchase: ONE expense document (direction buy, from a supplier) and the money-out movement that paid it, tied by an expense.recorded event. No payable and no allocation. The VAT claim date is fixed
// here (the invoice date, or the first open day after the tax lock). expenses.ts has the rules and derives the input tax.
export async function recordExpense(env: Env, input: ExpenseInput, ctx: Ctx): Promise<{ documentId: number; number: number; movementId: number; eventId: number; totals: Totals; claimDate: string }> {
  return inTransaction(env, async (tx) => {
    const plan = await planExpense(tx, input);
    const doc = await recordDocument(tx, { kind: "expense", direction: "buy", partyId: input.supplierId, currency: input.currency, reference: input.supplierInvoiceNumber ?? null, issuedOn: input.incurredOn, terms: { category: input.category, taxInvoiceHeld: input.taxInvoiceHeld, capital: input.capital === true, amountsIncludeTax: input.amountsIncludeTax, ...(input.receiptRef ? { receiptRef: input.receiptRef } : {}) }, lines: plan.docLines }, ctx);
    const mv = await insertMovement(tx, { direction: "out", partyId: input.supplierId, amountMinor: input.amountPaidMinor, currency: input.currency, occurredOn: plan.paidOn, method: input.method }, ctx);
    const eventId = await appendEvent(tx, "expense.recorded", ctx, { documentId: doc.id, movementId: mv.id, supplierId: input.supplierId, category: input.category, amountPaidMinor: input.amountPaidMinor, paidOn: plan.paidOn, method: input.method, incurredOn: input.incurredOn, claimDate: plan.claimDate, taxInvoiceHeld: input.taxInvoiceHeld, supplierInvoiceNumber: input.supplierInvoiceNumber ?? null, receiptRef: input.receiptRef ?? null, capital: input.capital === true });
    return { documentId: doc.id, number: doc.number, movementId: mv.id, eventId, totals: doc.totals, claimDate: plan.claimDate };
  });
}
// VOID an expense: reverse the money-out movement and then the document, and record expense.voided. Nothing is deleted. Refused if its claimed input tax is in a locked tax period.
export async function voidExpense(env: Env, input: { expenseId: number; reason: string; voidedOn: string }, ctx: Ctx): Promise<{ eventId: number; reversalIds: number[] }> {
  const expenseId = id(input.expenseId, "expense");
  return inTransaction(env, async (tx) => {
    const plan = await planExpenseVoid(tx, { ...input, expenseId });
    const m = await reverse(tx, { movementId: plan.movementId, reason: plan.reason }, ctx);
    const d = await reverse(tx, { documentId: expenseId, reason: plan.reason }, ctx);
    const eventId = await appendEvent(tx, "expense.voided", ctx, { documentId: expenseId, movementId: plan.movementId, reason: plan.reason, voidedOn: plan.voidedOn }, plan.reason);
    return { eventId, reversalIds: [m.id, d.id] };
  });
}

// A PURCHASE ORDER is a document of kind purchase_order (a commitment: no payable, not a tax document, no money); a GOODS RECEIPT is a document of kind goods_receipt tied to ONE order by a goods.received event; a CANCELLATION of the
// remainder is a purchase_order.cancelled event. Nothing is edited: what state an order is in is derived (purchasing.ts). The receipt takes the order's own price and tax rate for each line, never a new one.
export async function recordPurchaseOrder(env: Env, input: { supplierId: number; orderedOn: string; currency: string; expectedOn?: string; reference?: string | null; lines: DocumentLineInput[]; lineItems?: OrderLineItem[] }, ctx: Ctx): Promise<{ documentId: number; number: number; eventId: number; totals: Totals }> {
  const supplierId = id(input.supplierId, "supplier");
  return inTransaction(env, async (tx) => {
    await planOrder(tx, { supplierId, orderedOn: input.orderedOn, expectedOn: input.expectedOn });
    if (input.lineItems) await planLineItems(tx, input.lineItems, input.lines.map((l) => ({ unit: l.unit ?? null })));
    const doc = await recordDocument(tx, { kind: "purchase_order", direction: "buy", partyId: supplierId, currency: input.currency, reference: input.reference ?? null, issuedOn: input.orderedOn, terms: { ...(input.expectedOn ? { expectedOn: input.expectedOn } : {}), ...(input.lineItems ? { lineItems: input.lineItems } : {}) }, lines: input.lines }, ctx);
    return { documentId: doc.id, number: doc.number, eventId: doc.eventId, totals: doc.totals };
  });
}
export async function receiveGoods(env: Env, input: { orderId: number; receivedOn: string; lines: ReceiptLineInput[]; deliveryNote?: string | null; note?: string | null }, ctx: Ctx): Promise<{ documentId: number; number: number; eventId: number }> {
  const orderId = id(input.orderId, "order");
  return inTransaction(env, async (tx) => {
    const plan = await planReceipt(tx, { ...input, orderId });
    const doc = await recordDocument(tx, { kind: "goods_receipt", direction: "buy", partyId: plan.partyId, currency: plan.currency, reference: input.deliveryNote ?? null, issuedOn: plan.receivedOn, terms: { orderId, ...(input.note ? { note: input.note } : {}) }, lines: plan.docLines }, ctx);
    const eventId = await appendEvent(tx, "goods.received", ctx, { documentId: doc.id, orderId, receivedOn: plan.receivedOn, lines: plan.eventLines, ...(input.deliveryNote ? { deliveryNote: input.deliveryNote } : {}), ...(input.note ? { note: input.note } : {}) });
    return { documentId: doc.id, number: doc.number, eventId };
  });
}
export async function cancelPurchaseOrder(env: Env, input: { orderId: number; reason: string; cancelledOn: string }, ctx: Ctx): Promise<{ eventId: number }> {
  const orderId = id(input.orderId, "order");
  return inTransaction(env, async (tx) => {
    const plan = await planCancel(tx, { ...input, orderId });
    return { eventId: await appendEvent(tx, "purchase_order.cancelled", ctx, { documentId: orderId, reason: plan.reason, cancelledOn: plan.cancelledOn, receivedValueMinor: plan.receivedValueMinor }, plan.reason) };
  });
}

// A BILL is a supplier_invoice document (a payable) plus a supplier_invoice.recorded event that keeps what the document cannot: the order it bills, the three-way match result AT THE TIME OF RECORDING (never taken from the proposal), whether a
// variance was accepted, the category and the claim date. Paying it is a money-out movement allocated to bills. Nothing is edited (bills.ts derives status, payable and what is owed).
export async function recordSupplierInvoice(env: Env, input: BillInput, ctx: Ctx): Promise<{ documentId: number; number: number; eventId: number; totals: Totals; matchStatus: string; claimDate: string }> {
  return inTransaction(env, async (tx) => {
    const plan = await planBill(tx, input);
    const doc = await recordDocument(tx, { kind: "supplier_invoice", direction: "buy", partyId: input.supplierId, currency: input.currency, reference: input.supplierInvoiceNumber, issuedOn: input.invoicedOn, terms: { ...(input.dueOn ? { dueOn: input.dueOn } : {}), ...(input.orderId !== undefined ? { orderId: input.orderId } : {}), category: input.category, taxInvoiceHeld: input.taxInvoiceHeld, capital: input.capital === true }, lines: plan.docLines }, ctx);
    const eventId = await appendEvent(tx, "supplier_invoice.recorded", ctx, { documentId: doc.id, supplierId: input.supplierId, ...(input.orderId !== undefined ? { orderId: input.orderId } : {}), supplierInvoiceNumber: input.supplierInvoiceNumber, invoicedOn: input.invoicedOn, ...(input.dueOn ? { dueOn: input.dueOn } : {}), category: input.category, taxInvoiceHeld: input.taxInvoiceHeld, capital: input.capital === true, claimDate: plan.claimDate, matchStatus: plan.match.status, varianceAccepted: input.varianceAccepted === true, lines: plan.match.lines });
    return { documentId: doc.id, number: doc.number, eventId, totals: doc.totals, matchStatus: plan.match.status, claimDate: plan.claimDate };
  });
}
export async function voidSupplierInvoice(env: Env, input: { billId: number; reason: string; voidedOn: string }, ctx: Ctx): Promise<{ eventId: number; reversalId: number }> {
  const billId = id(input.billId, "bill");
  return inTransaction(env, async (tx) => {
    const plan = await planBillVoid(tx, { ...input, billId });
    const d = await reverse(tx, { documentId: billId, reason: plan.reason }, ctx);
    const eventId = await appendEvent(tx, "supplier_invoice.voided", ctx, { documentId: billId, reason: plan.reason, voidedOn: plan.voidedOn }, plan.reason);
    return { eventId, reversalId: d.id };
  });
}
// PAY a supplier: a money-out movement allocated IN FULL to the supplier's payable bills (no overpayment, no unapplied supplier credit), plus a supplier_payment.recorded event.
export async function recordSupplierPayment(env: Env, input: PaymentInput, ctx: Ctx): Promise<{ movementId: number; allocationIds: number[]; eventId: number }> {
  const supplierId = id(input.supplierId, "supplier");
  return inTransaction(env, async (tx) => {
    const plan = await planSupplierPayment(tx, { ...input, supplierId });
    const pay = await recordPayment(tx, { direction: "out", partyId: supplierId, amountMinor: input.amountMinor, currency: input.currency, occurredOn: plan.paidOn, method: input.method, allocations: plan.allocations.map((a) => ({ documentId: a.billId, amountMinor: a.amountMinor })) }, ctx);
    const eventId = await appendEvent(tx, "supplier_payment.recorded", ctx, { movementId: pay.movementId, supplierId, paidOn: plan.paidOn, method: input.method, allocations: plan.allocations });
    return { movementId: pay.movementId, allocationIds: pay.allocationIds, eventId };
  });
}

// STOCK (stock.ts): items, locations and one immutable movement ledger. Every write is one transaction: the event, then the row that carries it. Cost is stamped here, once, and never changes. The same plan functions that the contracts check with
// decide here, so the fact layer cannot be used to record what the door would refuse.
async function insertMove(tx: Env, m: { itemId: number; locationId: number; kind: string; quantityMilli: number; valueMinor: number; occurredOn: string; sourceDocumentId?: number | null; sourceLineNo?: number | null; reason?: string | null; jobRef?: string | null; pairId?: number | null; reversesMoveId?: number | null; eventId: number }): Promise<number> {
  const row = await one<{ id: number }>(tx, "INSERT INTO eng_stock_move (item_id, location_id, kind, quantity_milli, value_minor, occurred_on, source_document_id, source_line_no, reason, job_ref, pair_id, reverses_move_id, event_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id", m.itemId, m.locationId, m.kind, m.quantityMilli, m.valueMinor, m.occurredOn, m.sourceDocumentId ?? null, m.sourceLineNo ?? null, m.reason ?? null, m.jobRef ?? null, m.pairId ?? null, m.reversesMoveId ?? null, m.eventId);
  return Number(row!.id);
}
export async function createItem(env: Env, input: ItemInput, ctx: Ctx): Promise<{ itemId: number; eventId: number }> {
  return inTransaction(env, async (tx) => {
    await planItem(tx, input);
    const eventId = await appendEvent(tx, "item.created", ctx, { sku: input.sku, name: input.name, unit: input.unit, ...(input.reorderLevelMilli !== undefined ? { reorderLevelMilli: input.reorderLevelMilli } : {}), ...(input.reorderQtyMilli !== undefined ? { reorderQtyMilli: input.reorderQtyMilli } : {}), ...(input.preferredSupplierId !== undefined ? { preferredSupplierId: input.preferredSupplierId } : {}) });
    const row = await one<{ id: number }>(tx, "INSERT INTO eng_item (sku, name, unit, event_id) VALUES (?, ?, ?, ?) RETURNING id", input.sku, input.name, input.unit, eventId);
    return { itemId: Number(row!.id), eventId };
  });
}
export async function reviseItem(env: Env, input: ItemRevision, ctx: Ctx): Promise<{ eventId: number }> {
  return inTransaction(env, async (tx) => {
    await planItemRevision(tx, input);
    return { eventId: await appendEvent(tx, "item.revised", ctx, { ...input }) };
  });
}
export async function createLocation(env: Env, input: LocationInput, ctx: Ctx): Promise<{ locationId: number; eventId: number }> {
  return inTransaction(env, async (tx) => {
    await planLocation(tx, input);
    const eventId = await appendEvent(tx, "location.created", ctx, { name: input.name, kind: input.kind });
    const row = await one<{ id: number }>(tx, "INSERT INTO eng_location (name, kind, event_id) VALUES (?, ?, ?) RETURNING id", input.name, input.kind, eventId);
    return { locationId: Number(row!.id), eventId };
  });
}
export async function receiveStock(env: Env, input: ReceiveInput, ctx: Ctx): Promise<{ moveId: number; valueMinor: number; eventId: number }> {
  return inTransaction(env, async (tx) => {
    const plan = await planReceive(tx, input);
    const eventId = await appendEvent(tx, "stock.received", ctx, { itemId: input.itemId, locationId: input.locationId, quantityMilli: input.quantityMilli, valueMinor: plan.valueMinor, occurredOn: input.receivedOn, ...(plan.source ? { receipt: plan.source } : { unitCostMinor: plan.unitCostMinor }) });
    const moveId = await insertMove(tx, { itemId: input.itemId, locationId: input.locationId, kind: "receive", quantityMilli: input.quantityMilli, valueMinor: plan.valueMinor, occurredOn: input.receivedOn, sourceDocumentId: plan.source?.documentId, sourceLineNo: plan.source?.lineNo, reason: plan.source ? "goods receipt" : "received", eventId });
    return { moveId, valueMinor: plan.valueMinor, eventId };
  });
}
export async function issueStock(env: Env, input: IssueInput, ctx: Ctx): Promise<{ moveId: number; valueMinor: number; eventId: number }> {
  return inTransaction(env, async (tx) => {
    const plan = await planIssue(tx, input);
    const eventId = await appendEvent(tx, "stock.issued", ctx, { itemId: input.itemId, locationId: input.locationId, quantityMilli: input.quantityMilli, valueMinor: plan.valueMinor, occurredOn: input.issuedOn, reason: input.reason, ...(input.jobRef ? { jobRef: input.jobRef } : {}), ...(input.documentId !== undefined ? { documentId: input.documentId, lineNo: input.lineNo } : {}), ...(input.reservationId !== undefined ? { reservationId: input.reservationId } : {}) });
    const moveId = await insertMove(tx, { itemId: input.itemId, locationId: input.locationId, kind: "issue", quantityMilli: input.quantityMilli, valueMinor: plan.valueMinor, occurredOn: input.issuedOn, sourceDocumentId: input.documentId, sourceLineNo: input.lineNo, reason: input.reason, jobRef: input.jobRef, eventId });
    return { moveId, valueMinor: plan.valueMinor, eventId };
  });
}
export async function transferStock(env: Env, input: TransferInput, ctx: Ctx): Promise<{ outMoveId: number; inMoveId: number }> {
  return inTransaction(env, async (tx) => {
    await planTransfer(tx, input);
    const outEvent = await appendEvent(tx, "stock.transferred_out", ctx, { itemId: input.itemId, locationId: input.fromLocationId, toLocationId: input.toLocationId, quantityMilli: input.quantityMilli, valueMinor: 0, occurredOn: input.movedOn });
    const outMoveId = await insertMove(tx, { itemId: input.itemId, locationId: input.fromLocationId, kind: "transfer_out", quantityMilli: input.quantityMilli, valueMinor: 0, occurredOn: input.movedOn, reason: "transfer", eventId: outEvent });
    const inEvent = await appendEvent(tx, "stock.transferred_in", ctx, { itemId: input.itemId, locationId: input.toLocationId, fromLocationId: input.fromLocationId, quantityMilli: input.quantityMilli, valueMinor: 0, occurredOn: input.movedOn, outMoveId });
    const inMoveId = await insertMove(tx, { itemId: input.itemId, locationId: input.toLocationId, kind: "transfer_in", quantityMilli: input.quantityMilli, valueMinor: 0, occurredOn: input.movedOn, reason: "transfer", pairId: outMoveId, eventId: inEvent });
    return { outMoveId, inMoveId };
  });
}
export async function adjustStock(env: Env, input: AdjustInput, ctx: Ctx): Promise<{ moveId: number; valueMinor: number; eventId: number }> {
  return inTransaction(env, async (tx) => {
    const plan = await planAdjust(tx, input);
    const eventId = await appendEvent(tx, "stock.adjusted", ctx, { itemId: input.itemId, locationId: input.locationId, direction: input.direction, quantityMilli: input.quantityMilli, valueMinor: plan.valueMinor, occurredOn: input.adjustedOn, reason: input.reason, ...(input.note ? { note: input.note } : {}) }, input.note ?? input.reason);
    const moveId = await insertMove(tx, { itemId: input.itemId, locationId: input.locationId, kind: input.direction === "in" ? "adjust_in" : "adjust_out", quantityMilli: input.quantityMilli, valueMinor: plan.valueMinor, occurredOn: input.adjustedOn, reason: input.reason, eventId });
    return { moveId, valueMinor: plan.valueMinor, eventId };
  });
}
export async function reverseStockMove(env: Env, input: StockReverseInput, ctx: Ctx): Promise<{ moveId: number; eventId: number }> {
  return inTransaction(env, async (tx) => {
    const plan = await planReverse(tx, input);
    const m = plan.move;
    const eventId = await appendEvent(tx, "stock.move_reversed", ctx, { itemId: m.item_id, locationId: m.location_id, quantityMilli: m.quantity_milli, valueMinor: m.value_minor, occurredOn: input.reversedOn, reversesMoveId: m.id, reason: input.reason, direction: plan.kind === "reversal_in" ? "in" : "out" }, input.reason);
    const moveId = await insertMove(tx, { itemId: m.item_id, locationId: m.location_id, kind: plan.kind, quantityMilli: m.quantity_milli, valueMinor: m.value_minor, occurredOn: input.reversedOn, reason: input.reason, reversesMoveId: m.id, eventId });
    return { moveId, eventId };
  });
}

export async function reserveStock(env: Env, input: ReserveInput, ctx: Ctx): Promise<{ reservationId: number; eventId: number }> {
  return inTransaction(env, async (tx) => {
    await planReserve(tx, input);
    const eventId = await appendEvent(tx, "stock.reserved", ctx, { itemId: input.itemId, quantityMilli: input.quantityMilli, reservedOn: input.reservedOn, ...(input.locationId !== undefined ? { locationId: input.locationId } : {}), ...(input.forDocumentId !== undefined ? { forDocumentId: input.forDocumentId } : {}), ...(input.forRef ? { forRef: input.forRef } : {}), ...(input.note ? { note: input.note } : {}) });
    return { reservationId: eventId, eventId };
  });
}
export async function releaseReservation(env: Env, input: ReleaseInput, ctx: Ctx): Promise<{ eventId: number }> {
  return inTransaction(env, async (tx) => {
    const plan = await planRelease(tx, input);
    return { eventId: await appendEvent(tx, "stock.released", ctx, { reservationId: input.reservationId, itemId: plan.reservation.itemId, quantityMilli: plan.reservation.remainingMilli, reason: input.reason, releasedOn: input.releasedOn }, input.reason) };
  });
}
// A COUNT: ONE stock.counted event for the whole count (every line, including those with no difference), then an ordinary adjustment movement (reason stocktake) for each line that differs, each pointing back at the count.
export async function countStock(env: Env, input: CountInput, ctx: Ctx): Promise<{ countEventId: number; moveIds: number[]; variances: Array<{ itemId: number; differenceMilli: number }> }> {
  return inTransaction(env, async (tx) => {
    const plan = await planCount(tx, input);
    const countEventId = await appendEvent(tx, "stock.counted", ctx, { locationId: input.locationId, countedOn: input.countedOn, complete: input.complete === true, ...(input.note ? { note: input.note } : {}), lines: plan.variances.map((v) => ({ itemId: v.itemId, bookMilli: v.bookMilli, countedMilli: v.countedMilli, differenceMilli: v.differenceMilli, valueMinor: v.valueMinor })) }, input.note ?? "stocktake");
    const moveIds: number[] = [];
    for (const m of plan.moves) {
      const eventId = await appendEvent(tx, "stock.adjusted", ctx, { itemId: m.itemId, locationId: input.locationId, direction: m.direction, quantityMilli: m.quantityMilli, valueMinor: m.valueMinor, occurredOn: input.countedOn, reason: "stocktake", countEventId });
      moveIds.push(await insertMove(tx, { itemId: m.itemId, locationId: input.locationId, kind: m.direction === "in" ? "adjust_in" : "adjust_out", quantityMilli: m.quantityMilli, valueMinor: m.valueMinor, occurredOn: input.countedOn, reason: "stocktake", eventId }));
    }
    return { countEventId, moveIds, variances: plan.variances.map((v) => ({ itemId: v.itemId, differenceMilli: v.differenceMilli })) };
  });
}

// A DELIVERY into stock: every line of a goods receipt whose order line names an item goes into stock at that line's cost, as one transaction of ordinary stock.received movements, each pointing back at the receipt line it came from.
export async function receiveDelivery(env: Env, input: DeliveryInput, ctx: Ctx): Promise<{ moveIds: number[]; eventIds: number[] }> {
  return inTransaction(env, async (tx) => {
    const plan = await planDelivery(tx, input);
    const moveIds: number[] = [], eventIds: number[] = [];
    for (const l of plan.lines) {
      const eventId = await appendEvent(tx, "stock.received", ctx, { itemId: l.itemId, locationId: input.locationId, quantityMilli: l.quantityMilli, valueMinor: l.valueMinor, occurredOn: input.receivedOn, receipt: { documentId: input.receiptId, lineNo: l.lineNo } });
      eventIds.push(eventId);
      moveIds.push(await insertMove(tx, { itemId: l.itemId, locationId: input.locationId, kind: "receive", quantityMilli: l.quantityMilli, valueMinor: l.valueMinor, occurredOn: input.receivedOn, sourceDocumentId: input.receiptId, sourceLineNo: l.lineNo, reason: "goods receipt", eventId }));
    }
    return { moveIds, eventIds };
  });
}

// A PRICE is an event only (item.priced): the price list is derived, every change is explained, and the one in force is the latest effective date (the later decision for the same date).
export async function setItemPrice(env: Env, input: PriceInput, ctx: Ctx): Promise<{ eventId: number }> {
  return inTransaction(env, async (tx) => {
    await planPrice(tx, input);
    return { eventId: await appendEvent(tx, "item.priced", ctx, { itemId: input.itemId, unitPriceMinor: input.unitPriceMinor, currency: input.currency, effectiveFrom: input.effectiveFrom, ...(input.note ? { note: input.note } : {}) }, input.note ?? null) };
  });
}
// A customer RETURN: stock comes back at the ORIGINAL cost of the issue it reverses (an adjust_in movement with the reason customer return), tied to that issue by a stock.returned event.
export async function returnStock(env: Env, input: ReturnInput, ctx: Ctx): Promise<{ moveId: number; valueMinor: number; eventId: number }> {
  return inTransaction(env, async (tx) => {
    const plan = await planReturn(tx, input);
    const eventId = await appendEvent(tx, "stock.returned", ctx, { itemId: plan.move.item_id, locationId: input.locationId, quantityMilli: input.quantityMilli, valueMinor: plan.valueMinor, occurredOn: input.returnedOn, returnsMoveId: input.issueMoveId, ...(input.creditNoteId !== undefined ? { creditNoteId: input.creditNoteId } : {}), ...(input.note ? { note: input.note } : {}) }, input.note ?? "customer return");
    const moveId = await insertMove(tx, { itemId: plan.move.item_id, locationId: input.locationId, kind: "adjust_in", quantityMilli: input.quantityMilli, valueMinor: plan.valueMinor, occurredOn: input.returnedOn, reason: "customer return", eventId });
    return { moveId, valueMinor: plan.valueMinor, eventId };
  });
}

// A WRITE-DOWN (diminution): ALL the stock of an item is carried at less without a unit moving. At each place that holds the item, all of its units go out at their carrying value and come back at the lower one: ordinary movements, so the average, later issues,
// the ledger and the verifier all see them. Each carries a stock.written_down event; the first event names the write-down (its number), and each second event says its share, the total amount, why and on what evidence.
export async function writeDownStock(env: Env, input: WriteDownInput, ctx: Ctx): Promise<{ moveIds: number[]; eventIds: number[] }> {
  const ok = checkWriteDownInput(input); if (!ok.ok) throw new EngineError("invalid_input", ok.reason);   // validated before a transaction is opened
  return inTransaction(env, async (tx) => {
    const plan = await planWriteDown(tx, input);
    const moveIds: number[] = [], eventIds: number[] = []; let head: number | null = null;
    for (const part of plan.parts) {
      const common = { itemId: input.itemId, locationId: part.locationId, quantityMilli: part.quantityMilli, occurredOn: input.writtenDownOn };
      const outEvent = await appendEvent(tx, "stock.written_down", ctx, { ...common, direction: "out", valueMinor: part.carriedFromMinor, part: "out", reason: input.reason, ...(head === null ? {} : { groupEventId: head }) }, input.evidence);
      if (head === null) head = outEvent;
      const outMove = await insertMove(tx, { itemId: input.itemId, locationId: part.locationId, kind: "adjust_out", quantityMilli: part.quantityMilli, valueMinor: part.carriedFromMinor, occurredOn: input.writtenDownOn, reason: "write-down", eventId: outEvent });
      const inEvent = await appendEvent(tx, "stock.written_down", ctx, { ...common, direction: "in", valueMinor: part.carriedToMinor, part: "in", outEventId: outEvent, groupEventId: head, amountMinor: part.shareMinor, totalAmountMinor: input.amountMinor, reason: input.reason, evidence: input.evidence }, input.evidence);
      const inMove = await insertMove(tx, { itemId: input.itemId, locationId: part.locationId, kind: "adjust_in", quantityMilli: part.quantityMilli, valueMinor: part.carriedToMinor, occurredOn: input.writtenDownOn, reason: "write-down", eventId: inEvent });
      moveIds.push(outMove, inMove); eventIds.push(outEvent, inEvent);
    }
    return { moveIds, eventIds };
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
