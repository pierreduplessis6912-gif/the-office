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
export async function recordParty(env: Env, input: { kind: string; name: string; roles?: string[] }, ctx: Ctx): Promise<{ id: number; eventId: number }> {
  const kind = oneOf(input.kind, ["person", "organisation"] as const, "kind");
  const name = text(input.name, "name");
  const roles = (input.roles ?? []).map((r) => text(r, "role"));
  return inTransaction(env, async (tx) => {
    const eventId = await appendEvent(tx, "party.created", ctx, { kind, name, roles });
    const row = await one<{ id: number }>(tx, "INSERT INTO eng_party (kind, name, event_id) VALUES (?, ?, ?) RETURNING id", kind, name, eventId);
    for (const role of roles) await run(tx, "INSERT INTO eng_party_role (party_id, role, event_id) VALUES (?, ?, ?)", row!.id, role, eventId);
    return { id: Number(row!.id), eventId };
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
