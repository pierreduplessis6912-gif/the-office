// The operation boundary for READS and the door for proposals, with the five conditions kept apart: UNDERSTOOD (unknown_capability), AVAILABLE (capability_unavailable), PERMITTED (not_permitted), VALID (invalid_payload,
// not_found, and the state codes), and EXECUTED (only through the confirm, in capability-contract.ts). Every interface (the app's routes, an outside assistant, a test) calls THESE functions, so the same operation
// gives the same result and the same refusal whichever way it was asked. A refusal never reveals the figure it protects.
import type { Env } from "../types";
import { isAvailable, proposeCapability, type ProposeResult } from "../capability-contract";
import { withEngineAvailability } from "./availability";
import { EngineError } from "./errors";
import { permissionsFor } from "./permissions";
import { Ambiguous, CAPABILITY_IDS, READS } from "./capabilities";

export interface Member { email: string | null; caps: readonly string[]; captureId?: number }   // captureId: a capture row that already holds what was said (a voice note), so the door does not make a second one
export type ReadOutcome =
  | { status: "ok"; result: unknown }
  | { status: "ambiguous"; candidates: Array<{ id: number; name: string }> }
  | { status: "refused"; code: string; message: string };

const refused = (code: string, message: string): ReadOutcome => ({ status: "refused", code, message });

export async function invokeRead(env: Env, member: Member, capability: unknown, params: unknown): Promise<ReadOutcome> {
  const cap = typeof capability === "string" ? READS.find((r) => r.id === capability) : undefined;
  if (!cap) return refused("unknown_capability", "There is no such capability, so nothing was done.");
  const scoped = await withEngineAvailability(env);
  if (!isAvailable(scoped, cap.id)) return refused("capability_unavailable", `${cap.label} is not available for this business.`);
  const perms = permissionsFor(member.caps);
  if (!cap.permissions.every((p) => perms.has(p))) return refused("not_permitted", `${cap.label} needs permission this member does not have.`);
  const checked = cap.validate(params);
  if (!checked.ok) return refused("invalid_payload", `${checked.reason}.`);
  const available = new Set(CAPABILITY_IDS.filter((id) => isAvailable(scoped, id)));
  try {
    return { status: "ok", result: await cap.run(env, { perms, available }, checked.value) };
  } catch (e) {
    if (e instanceof Ambiguous) return { status: "ambiguous", candidates: e.candidates };
    if (e instanceof EngineError) return refused(e.code, e.message);
    throw e;
  }
}

// A proposal from a member: what was said is kept first, then the request is answered honestly (see capability-contract.ts).
export function proposeCapabilityAs(env: Env, member: Member, request: { capability: unknown; payload: unknown; transcript: string; source?: string; interpreter?: string }): Promise<ProposeResult> {
  return proposeCapability(env, { ...request, member });
}
export { availabilityOf, observe, withEngineAvailability } from "./availability";
