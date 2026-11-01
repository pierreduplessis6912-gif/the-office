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

export type RefusalCode = "unknown_capability" | "capability_unavailable" | "invalid_payload" | "not_permitted";

export interface ContractContext {
  actionId: number;
  actorEmail: string | null;
}

export interface CapabilityContract<P = unknown> {
  id: string;
  heldType: string;
  label: string;
  // The capabilities the confirming member must hold (all of them), checked by the contract itself.
  requires: readonly string[];
  validate(payload: unknown): { ok: true; value: P } | { ok: false; reason: string };
  // Runs INSIDE the confirm transaction: it may touch the database only (see atomic.ts).
  execute(env: Env, value: P, context: ContractContext): Promise<Record<string, unknown>>;
}

// The declared contracts. One, for the proof.
const DECLARED: readonly CapabilityContract<any>[] = [logVisit];

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
  | { status: "refused"; code: Exclude<RefusalCode, "not_permitted">; message: string };

export async function proposeCapability(
  env: Env,
  request: { capability: unknown; payload: unknown; transcript: string; source?: string }
): Promise<ProposeResult> {
  // 1. What was said is kept FIRST, whatever happens next. It is a capture, not a business record.
  await logCapture(env, request.transcript, request.source || "text");
  // 2. Then the request is answered honestly. Nothing below writes anything until it is held.
  const contract = typeof request.capability === "string" ? contractById(request.capability) : null;
  if (!contract) return { status: "refused", code: "unknown_capability", message: "There is no such capability, so nothing was done." };
  if (!isAvailable(env, contract.id)) return { status: "refused", code: "capability_unavailable", message: `${contract.label} is not available for this business, so nothing was done.` };
  const checked = contract.validate(request.payload);
  if (!checked.ok) return { status: "refused", code: "invalid_payload", message: `${checked.reason}, so nothing was done.` };
  const held = await holdForConfirmation(env, contract.heldType, checked.value as Record<string, unknown>, request.transcript);
  return { status: "held", actionId: held.id, message: `${contract.label} is held for confirmation.` };
}

export interface ContractOutcome {
  status: number;
  body: Record<string, unknown>;
}

const refusal = (status: number, code: RefusalCode, message: string): ContractOutcome => ({ status, body: { error: code, message } });

// Called by the confirm route AFTER it has claimed the held action. A refusal writes nothing (the route puts the claim back); an execution is one atomic unit with the confirmation.
export async function executeThroughContract(
  env: Env,
  contract: CapabilityContract<any>,
  action: { id: number; payload: string },
  member: { email: string | null; caps: readonly string[] }
): Promise<ContractOutcome> {
  // 1. The contract's OWN permission, whatever the legacy confirm-permission map allowed through.
  if (!contract.requires.every((c) => member.caps.includes(c))) return refusal(403, "not_permitted", `Confirming ${contract.label.toLowerCase()} needs permission this member does not have.`);
  // 2. Available to THIS business.
  if (!isAvailable(env, contract.id)) return refusal(409, "capability_unavailable", `${contract.label} is not available for this business.`);
  // 3. The payload, checked again: a held action can be written by any code, not only by the door.
  let raw: unknown;
  try { raw = JSON.parse(action.payload); } catch { raw = undefined; }
  const checked = contract.validate(raw);
  if (!checked.ok) return refusal(422, "invalid_payload", checked.reason);
  // 4. Execution and confirmation are one unit: all of it happens or none of it does.
  const outcome = await atomically(env, async (tx) => {
    const result = await contract.execute(tx, checked.value, { actionId: action.id, actorEmail: member.email });
    await tx.OFFICE_DB.prepare("UPDATE pending_actions SET status = 'confirmed', resolved_at = datetime('now') WHERE id = ?").bind(action.id).run();
    return result;
  });
  return { status: 200, body: { status: "confirmed", capability: contract.id, outcome } };
}
