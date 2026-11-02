// A declared capability contract, and the checks that make it a BOUNDARY and not just a description (proof on branch claim/proof-1, decided with Pierre 2026-11-01; tests in
// tools/capability-contract.test.js, written first). Until now the intent union, the creation gate, the confirm-permission map and a directly written held action each declared
// part of an operation, and nothing checked that they agreed. A contract is checked at the two places an operation can be started and finished:
//   the DOOR (proposeCapability): the raw request is captured first, then the capability must exist, be available to THIS business and carry a valid payload, or NOTHING else is written
//   the CONFIRM (executeThroughContract, called from the confirm route for a held type that has a contract): the contract's own permission, the business's availability and the payload
//   are checked AGAIN, whatever else declared the type, because a held action can be written by any code and the legacy map can only ever say who may TRY
// Availability is told apart from permission and from validity, and from currency and time zone: it comes ONLY from explicit configuration (env.CAPABILITY_CONFIG, keyed by
// env.BUSINESS_ID). A business with no entry, and every business where nothing sets the configuration (production today), offers nothing: the proof changes no live behaviour.
// What this file does NOT do: store availability per business (that needs a migration, behind the restore gate), call a model, or replace the intent union.
import type { Env } from "./types";
import { atomically } from "./atomic";
import { holdForConfirmation } from "./finance";
import { logCapture } from "./memory";
import { logVisit } from "./capabilities/log-visit";
import { EngineError, type EngineErrorCode } from "./engine/errors";
import { permissionsFor, type EnginePermission } from "./engine/permissions";
import { observe, withEngineAvailability } from "./engine/availability";
import { ENGINE_CONTRACTS } from "./engine/capabilities";

export type RefusalCode = "unknown_capability" | "capability_unavailable" | "invalid_payload" | "not_permitted" | EngineErrorCode;

export interface ContractContext {
  actionId: number;
  actorEmail: string | null;
}

export interface ContractMember { email: string | null; caps: readonly string[] }

export interface CapabilityContract<P = unknown> {
  id: string;
  heldType: string;
  label: string;
  // The capabilities the confirming member must hold (all of them), checked by the contract itself.
  requires: readonly string[];
  validate(payload: unknown): { ok: true; value: P } | { ok: false; reason: string };
  // Runs INSIDE the confirm transaction: it may touch the database only (see atomic.ts).
  execute(env: Env, value: P, context: ContractContext): Promise<Record<string, unknown>>;
  // The ENGINE's contracts add these (all optional, so the proof's own capability is unchanged): permissions in the engine's own vocabulary; a version recorded on what the contract does; whether its execution is
  // recorded as ONE event per approved proposal (idempotency); `stamp` runs at the door to resolve what the approver will see and the version it is based on; `check` is "valid NOW" and runs at the door and again
  // inside the confirm transaction, so an approval is only for what it showed.
  permissions?: readonly EnginePermission[];
  version?: number;
  recordsExecution?: boolean;
  stamp?(env: Env, value: P): Promise<P>;
  check?(env: Env, value: P): Promise<void>;
}

// The declared contracts. One, for the proof.
const DECLARED: readonly CapabilityContract<any>[] = [logVisit, ...ENGINE_CONTRACTS];

export function contractForHeldType(type: string): CapabilityContract<any> | null {
  return DECLARED.find((c) => c.heldType === type) ?? null;
}

function contractById(id: string): CapabilityContract<any> | null {
  return DECLARED.find((c) => c.id === id) ?? null;
}

interface CapabilityConfigured {
  BUSINESS_ID?: string;
  CAPABILITY_CONFIG?: Record<string, { available?: unknown } | undefined>;
}

// Available ONLY where the configuration says so for this business. No configuration, no business entry, or no list: not available.
export function isAvailable(env: Env, id: string): boolean {
  const e = env as unknown as CapabilityConfigured;
  if (typeof e.BUSINESS_ID !== "string" || !e.CAPABILITY_CONFIG) return false;
  const entry = e.CAPABILITY_CONFIG[e.BUSINESS_ID];
  return Array.isArray(entry?.available) && (entry!.available as unknown[]).includes(id);
}

export type ProposeResult =
  | { status: "held"; actionId: number; message: string }
  | { status: "refused"; code: RefusalCode; message: string };

function memberMayUse(contract: CapabilityContract<any>, member: ContractMember): boolean {
  return contract.requires.every((c) => member.caps.includes(c)) && (contract.permissions ?? []).every((p) => permissionsFor(member.caps).has(p));
}

const CODE_FOR_STATUS = (code: string): RefusalCode => code as RefusalCode;
const statusFor = (code: string): number => (code === "not_permitted" ? 403 : code === "not_found" ? 404 : ["invalid_payload", "invalid_input", "invalid_amount", "amount_out_of_range"].includes(code) ? 422 : 409);

// The door, as the engine uses it: availability from the business's own configuration, the member's permission, and an honest OBSERVATION when the request could not be acted on. The body is the proof's, below.
export async function proposeCapability(
  env: Env,
  request: { capability: unknown; payload: unknown; transcript: string; source?: string; member?: ContractMember }
): Promise<ProposeResult> {
  const scoped = await withEngineAvailability(env);
  const result = await proposeCapabilityInner(scoped, request);
  if (result.status === "refused" && (result.code === "unknown_capability" || result.code === "capability_unavailable")) {
    await observe(env, { transcript: request.transcript, kind: result.code === "unknown_capability" ? "unsupported" : "unavailable", note: String(request.capability).slice(0, 120) });
  }
  return result;
}

async function proposeCapabilityInner(
  env: Env,
  request: { capability: unknown; payload: unknown; transcript: string; source?: string; member?: ContractMember }
): Promise<ProposeResult> {
  // 1. What was said is kept FIRST, whatever happens next. It is a capture, not a business record.
  await logCapture(env, request.transcript, request.source || "text");
  // 2. Then the request is answered honestly. Nothing below writes anything until it is held.
  const contract = typeof request.capability === "string" ? contractById(request.capability) : null;
  if (!contract) return { status: "refused", code: "unknown_capability", message: "There is no such capability, so nothing was done." };
  if (!isAvailable(env, contract.id)) return { status: "refused", code: "capability_unavailable", message: `${contract.label} is not available for this business, so nothing was done.` };
  if (request.member && !memberMayUse(contract, request.member)) return { status: "refused", code: "not_permitted", message: `${contract.label} needs permission this member does not have, so nothing was done.` };
  const checked = contract.validate(request.payload);
  if (!checked.ok) return { status: "refused", code: "invalid_payload", message: `${checked.reason}, so nothing was done.` };
  // The engine's contracts resolve what the approver will see (the exact allocations, the version it is based on) and must be VALID NOW before anything is held.
  let value = checked.value;
  try {
    if (contract.stamp) value = await contract.stamp(env, value);
    if (contract.check) await contract.check(env, value);
  } catch (e) {
    if (e instanceof EngineError) return { status: "refused", code: CODE_FOR_STATUS(e.code), message: `${e.message} Nothing was done.` };
    throw e;
  }
  const held = await holdForConfirmation(env, contract.heldType, value as Record<string, unknown>, request.transcript);
  return { status: "held", actionId: held.id, message: `${contract.label} is held for confirmation.` };
}

export interface ContractOutcome {
  status: number;
  body: Record<string, unknown>;
}

const refusal = (status: number, code: RefusalCode, message: string): ContractOutcome => ({ status, body: { error: code, message } });

// Called by the confirm route AFTER it has claimed the held action. A refusal writes nothing (the route puts the claim back); an execution is one atomic unit with the confirmation.
// Called by the confirm route: availability from the business's own configuration, the engine's refusals mapped to answers, a repeated execution refused, the body below unchanged in what it checks.
export async function executeThroughContract(
  env: Env,
  contract: CapabilityContract<any>,
  action: { id: number; payload: string },
  member: { email: string | null; caps: readonly string[] }
): Promise<ContractOutcome> {
  const scoped = await withEngineAvailability(env);
  try {
    return await executeChecked(scoped, contract, action, member);
  } catch (e) {
    if (e instanceof EngineError) return refusal(statusFor(e.code), CODE_FOR_STATUS(e.code), e.message);
    if (/UNIQUE constraint failed: eng_event/i.test(String((e as { message?: string })?.message))) return refusal(409, "already_executed", "That approval has already been executed, so nothing was done.");
    throw e;
  }
}

async function executeChecked(
  env: Env,
  contract: CapabilityContract<any>,
  action: { id: number; payload: string },
  member: { email: string | null; caps: readonly string[] }
): Promise<ContractOutcome> {
  // 1. The contract's OWN permission, whatever the legacy confirm-permission map allowed through.
  if (!contract.requires.every((c) => member.caps.includes(c))) return refusal(403, "not_permitted", `Confirming ${contract.label.toLowerCase()} needs permission this member does not have.`);
  // 1b. The engine permissions a contract declares, checked here as well: the legacy confirm map only says who may TRY.
  if (!(contract.permissions ?? []).every((p) => permissionsFor(member.caps).has(p))) return refusal(403, "not_permitted", `Confirming ${contract.label.toLowerCase()} needs permission this member does not have.`);
  // 2. Available to THIS business.
  if (!isAvailable(env, contract.id)) return refusal(409, "capability_unavailable", `${contract.label} is not available for this business.`);
  // 3. The payload, checked again: a held action can be written by any code, not only by the door.
  let raw: unknown;
  try { raw = JSON.parse(action.payload); } catch { raw = undefined; }
  const checked = contract.validate(raw);
  if (!checked.ok) return refusal(422, "invalid_payload", checked.reason);
  // 4. Execution and confirmation are one unit: all of it happens or none of it does.
  const outcome = await atomically(env, async (tx) => {
    if (contract.check) await contract.check(tx, checked.value);   // VALID NOW, inside the transaction: an approval is only for what it showed
    const result = await contract.execute(tx, checked.value, { actionId: action.id, actorEmail: member.email });
    if (contract.recordsExecution) await tx.OFFICE_DB.prepare("INSERT INTO eng_event (type, actor_email, proposal_id, approved_by, contract, contract_version, payload_json) VALUES ('operation.executed', ?, ?, ?, ?, ?, ?)").bind(member.email, action.id, member.email, contract.id, contract.version ?? 1, JSON.stringify(result)).run();   // once per approved proposal: unique
    await tx.OFFICE_DB.prepare("UPDATE pending_actions SET status = 'confirmed', resolved_at = datetime('now') WHERE id = ?").bind(action.id).run();
    return result;
  });
  return { status: 200, body: { status: "confirmed", capability: contract.id, outcome } };
}
