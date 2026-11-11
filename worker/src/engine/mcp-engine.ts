// THE OUTSIDE-ASSISTANT (MCP) DOOR FOR AN ENGINE BUSINESS (docs/decisions/engine-mcp.md). It is the SAME door a member uses, not a copy: a read goes through invokeRead and a proposal through proposeCapabilityAs, with the key's own member, so the
// engine's permission, availability and validation rules answer exactly as they do in the app. Three generic tools carry every capability, so nothing is re-implemented and a new capability needs no new tool: list_capabilities (what THIS member
// may do here, with the shape of each request), read (a read capability) and propose (a write capability, HELD). There is no approve tool and no legacy tool: an outside assistant can only propose, and a person approves in The Office as ever.
// A tool is offered only if at least one capability it carries is available in this business AND permitted to this member, so a business that has switched nothing on (or a member who may do nothing) is offered nothing.
import type { Env } from "../types";
import { isAvailable } from "../capability-contract";
import { withEngineAvailability } from "./availability";
import { ENGINE_CONTRACTS, READS } from "./capabilities";
import { invokeRead, proposeCapabilityAs, type Member } from "./operations";
import { permissionsFor } from "./permissions";

type ToolOutput = { ok: true; data: unknown } | { ok: false; message: string; outcome: "invalid" | "not_found" | "error" | "limited" };
interface WhoLike { keyId: string; email: string; role: string; capabilities: string[]; scope: string }
export interface EngineMcpTool {
  name: string; description: string; inputSchema: Record<string, unknown>; needsWrite?: boolean; ownerOnly?: boolean; route: null;
  run: (env: Env, args: Record<string, unknown>, who: WhoLike, origin: string, host: unknown) => Promise<ToolOutput>;
}

const MAX_PARAMS_CHARS = 20_000, MAX_NOTE = 1000;
const bad = (message: string): ToolOutput => ({ ok: false, message, outcome: "invalid" });
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const outcomeOf = (code: string): "invalid" | "not_found" | "error" => (code === "not_found" ? "not_found" : code === "error" ? "error" : "invalid");
const memberOf = (who: WhoLike): Member => ({ email: who.email, caps: who.capabilities });

// The shape of each request, in a sentence: money is in cents (...Minor), tax rates in basis points (1500 = 15%), dates YYYY-MM-DD. The engine's own validation is the authority; these only help an assistant ask correctly.
const HINTS: Record<string, string> = {
  "receivables.query": "params {partyName: the customer's name} or {partyId: number}: how much a customer owes.",
  "records.get": "params {kind: party | document | movement, id: number}: opens a record with its figures and its history.",
  "parties.find": "params {name?: part of a name, role?: customer | supplier}: customers and suppliers.",
  "quotations.find": "params {partyId?: number, status?: open | accepted | superseded | any}: quotations (current ones by default).",
  "expenses.find": "params {from?, to?: dates, category?, supplierId?: number, status?: recorded | voided | any}: expenses.",
  "vat.summary": "params {from, to: dates YYYY-MM-DD}: the VAT position for a period (output tax, input tax from recorded expenses, net).",
  "credits.find": "params {partyId?: number}: credit notes and overpayments that still have credit to apply or refund.",
  "business.get": "params {}: the business's own details and its tax lock date.",
  "payment.record": "payload {partyId, amountMinor, currency, occurredOn, allocate: 'oldest_first'}: a payment a customer made.",
  "payment.correct": "payload: reverse a payment and record the corrected one (see the app for the shape).",
  "invoice.issue": "payload: issue a prepared draft invoice (see the app for the shape).",
  "party.create": "payload {kind: person | organisation, name, roles: ['customer' and/or 'supplier'], contact?: {email?, phone?, address?, vatNumber?}}: a new customer or supplier.",
  "party.edit": "payload {partyId, name?, addRoles?, removeRoles?, contact?: {email?, phone?, address?, vatNumber? (null clears one)}}: change a customer or supplier.",
  "quotation.create": "payload {partyId, issuedOn, currency, validUntil?, reference?, lines: [{description, quantityMilli (1000 = one), unit?, unitPriceMinor, taxBp (required)}]}: a quotation for a customer.",
  "quotation.revise": "payload {quotationId, lines?, validUntil?, reference?, issuedOn?}: a new revision of the current quotation.",
  "quotation.accept": "payload {quotationId}: the customer accepted the current quotation.",
  "credit_note.issue": "payload {invoiceId, reason, issuedOn, lines: [{invoiceLineNo, quantityMilli, unitPriceMinor}]}: credit an invoice (the tax rate comes from the invoice line).",
  "credit.apply": "payload {creditNoteId, invoiceId, amountMinor, appliedOn}: apply leftover credit to another invoice of the same customer.",
  "refund.record": "payload {creditNoteId, amountMinor, refundedOn, method: eft | cash | card | cheque | other}: pay leftover credit back.",
  "credit_note.void": "payload {creditNoteId, reason, voidedOn}: void a credit note that nothing has been spent from.",
  "debit_note.issue": "payload {invoiceId, reason, issuedOn, lines: [{invoiceLineNo, quantityMilli, unitPriceMinor}]}: add to an invoice already issued.",
  "allocation.remove": "payload {allocationId, reason}: undo an allocation of a payment or credit.",
  "refund.void": "payload {movementId, reason}: void a refund.",
  "payment.allocate": "payload {paymentId, invoiceId, amountMinor, allocatedOn}: allocate an unapplied payment to an invoice.",
  "payment.refund": "payload {paymentId, amountMinor, refundedOn, method}: refund an unapplied payment.",
  "expense.record": "payload {supplierId, incurredOn, method: eft | cash | card | cheque | other, category, currency, amountsIncludeTax: true | false, lines: [{description, amountMinor, taxBp}], amountPaidMinor, taxInvoiceHeld: true | false, supplierInvoiceNumber?, receiptRef?, capital?}: something bought and already paid.",
  "expense.void": "payload {expenseId, reason, voidedOn}: void an expense.",
  "purchase_orders.find": "params {supplierId?: number, status?: open | part_received | received | cancelled | closed | outstanding | any}: purchase orders with what has arrived and what is still to receive (outstanding orders by default).",
  "purchase_order.create": "payload {supplierId, orderedOn, currency, expectedOn?, reference?, lines: [{description, quantityMilli (1000 = one), unit?, unitPriceMinor, taxBp (required)}]}: an order placed with a supplier (a commitment, not a debt).",
  "purchase_order.cancel": "payload {orderId, reason, cancelledOn}: cancel what has not yet arrived on an order (closes it short if part arrived).",
  "goods.receive": "payload {orderId, receivedOn, lines: [{lineNo, quantityMilli}], deliveryNote?, note?}: goods that arrived against an order (never more than remains; a person with a money role approves it).",
  "business.profile.set": "payload {legalName?, tradingName?, address?, vatRegistered?, vatNumber?, companyRegistrationNumber?}: the business's own details.",
  "tax_lock.set": "payload {lockDate}: lock the tax period up to a date (it only moves forward).",
};

async function scopeOf(env: Env, who: WhoLike) {
  const scoped = await withEngineAvailability(env);
  const perms = permissionsFor(who.capabilities);
  const readable = READS.filter((r) => isAvailable(scoped, r.id) && r.permissions.every((p) => perms.has(p)));
  const writable = ENGINE_CONTRACTS.filter((c) => isAvailable(scoped, c.id) && (c.permissions ?? []).every((p) => perms.has(p)));
  return { readable, writable };
}

const listTool: EngineMcpTool = {
  name: "list_capabilities", route: null,
  description: "What this member may do in this business through The Office's engine: each capability with its kind (read or write), what it does and the shape of the request. Reads are answered; writes are only ever PROPOSED (a person approves them in The Office).",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  async run(env, args, who) {
    if (Object.keys(args).length > 0) return bad(`unknown argument: ${Object.keys(args)[0].slice(0, 40)}`);
    const { readable, writable } = await scopeOf(env, who);
    return { ok: true, data: { capabilities: [...readable.map((r) => ({ id: r.id, kind: "read", label: r.label, hint: HINTS[r.id] ?? r.label })), ...writable.map((c) => ({ id: c.id, kind: "write", label: c.label, hint: HINTS[c.id] ?? c.label }))] } };
  },
};

const readTool: EngineMcpTool = {
  name: "read", route: null,
  description: "Ask a read capability a question (see list_capabilities for the ones this member may use and the parameters of each). The answer is the engine's own figure, exactly as the app shows it; nothing is changed.",
  inputSchema: { type: "object", properties: { capability: { type: "string", description: "A read capability from list_capabilities." }, params: { type: "object", description: "Its parameters, as in its hint." } }, required: ["capability"], additionalProperties: false },
  async run(env, args, who) {
    for (const k of Object.keys(args)) if (k !== "capability" && k !== "params") return bad(`unknown argument: ${k.slice(0, 40)}`);
    if (typeof args.capability !== "string") return bad("capability must be text.");
    const params = args.params === undefined ? {} : args.params;
    if (!isObj(params)) return bad("params must be an object.");
    if (JSON.stringify(params).length > MAX_PARAMS_CHARS) return bad("params are too large.");
    const { readable } = await scopeOf(env, who);
    if (!readable.some((r) => r.id === args.capability)) return bad("That is not a read capability this member can use here (see list_capabilities).");
    const r = await invokeRead(env, memberOf(who), args.capability, params);
    if (r.status === "ok") return { ok: true, data: { status: "ok", result: r.result } };
    if (r.status === "ambiguous") return { ok: true, data: { status: "ambiguous", candidates: r.candidates } };
    return { ok: false, message: r.message, outcome: outcomeOf(r.code) };
  },
};

const proposeTool: EngineMcpTool = {
  name: "propose", route: null, needsWrite: true,
  description: "Propose a change (a write capability from list_capabilities). It is only PROPOSED and HELD: an assistant can never approve, and nothing is recorded until a person approves it in The Office. The engine checks the request exactly as it does in the app and says why if it refuses. Money is in cents (...Minor), tax rates in basis points (1500 = 15%), dates are YYYY-MM-DD.",
  inputSchema: { type: "object", properties: { capability: { type: "string", description: "A write capability from list_capabilities." }, payload: { type: "object", description: "Its request, as in its hint." }, note: { type: "string", maxLength: MAX_NOTE, description: "Optional: what you were asked or what you read, in your own words; it is kept with the proposal." } }, required: ["capability", "payload"], additionalProperties: false },
  async run(env, args, who) {
    for (const k of Object.keys(args)) if (k !== "capability" && k !== "payload" && k !== "note") return bad(`unknown argument: ${k.slice(0, 40)}`);
    if (typeof args.capability !== "string") return bad("capability must be text.");
    if (!isObj(args.payload)) return bad("payload must be an object.");
    if (JSON.stringify(args.payload).length > MAX_PARAMS_CHARS) return bad("payload is too large.");
    if (args.note !== undefined && (typeof args.note !== "string" || args.note.length > MAX_NOTE)) return bad(`note must be text of up to ${MAX_NOTE} characters.`);
    if (!ENGINE_CONTRACTS.some((c) => c.id === args.capability)) return bad("That is not a write capability (see list_capabilities).");
    const transcript = typeof args.note === "string" && args.note.trim() ? `(an outside assistant) ${args.note.trim()}` : `(an outside assistant proposed ${args.capability})`;
    const r = await proposeCapabilityAs(env, memberOf(who), { capability: args.capability, payload: args.payload, transcript, source: "mcp", interpreter: "model" });
    if (r.status === "held") return { ok: true, data: { status: "held", actionId: r.actionId, message: `${r.message} A person approves it in The Office; nothing is recorded until then.` } };
    return { ok: false, message: r.message, outcome: outcomeOf(r.code) };
  },
};

/** The engine tools this key may be offered: none unless a capability is available in this business and permitted to this member. */
export async function engineMcpTools(env: Env, who: WhoLike): Promise<EngineMcpTool[]> {
  const { readable, writable } = await scopeOf(env, who);
  const out: EngineMcpTool[] = [];
  // a capability with no permission of its own (records.get answers per record) is not a reason to offer tools to a member who may do nothing else: an installer is offered nothing
  if (![...readable, ...writable].some((c) => (c.permissions ?? []).length > 0)) return out;
  if (readable.length + writable.length > 0) out.push(listTool);
  if (readable.length > 0) out.push(readTool);
  if (writable.length > 0) out.push(proposeTool);
  return out;
}
