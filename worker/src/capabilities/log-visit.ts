// The ONE synthetic capability of the contract proof (branch claim/proof-1): log a visit to a client, with its length in minutes. It exists to be declared, available to some
// businesses and not others, validated, permitted, approved and executed through tools/capability-contract.test.js. It is NOT wired to any live route, and its table (proof_visits)
// is created by the test: a real table would need a migration, which the restore gate still forbids. Because nothing sets the configuration in production, it is never available there.
import type { CapabilityContract } from "../capability-contract";

export interface VisitPayload {
  client: string;
  minutes: number;
  note?: string;
}

const FIELDS = ["client", "minutes", "note"];

export const logVisit: CapabilityContract<VisitPayload> = {
  id: "log_visit",
  heldType: "log_visit",
  label: "Logging a visit",
  requires: ["can_make_quotes"],
  validate(payload) {
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return { ok: false, reason: "A visit needs a client and a number of minutes" };
    const p = payload as Record<string, unknown>;
    const stray = Object.keys(p).find((k) => !FIELDS.includes(k));
    if (stray !== undefined) return { ok: false, reason: `A visit has no field called ${stray}` };
    if (typeof p.client !== "string" || p.client.trim().length === 0 || p.client.trim().length > 80) return { ok: false, reason: "A visit needs a client of 1 to 80 characters" };
    if (typeof p.minutes !== "number" || !Number.isInteger(p.minutes) || p.minutes < 1 || p.minutes > 1440) return { ok: false, reason: "A visit's minutes must be a whole number from 1 to 1440" };
    if (p.note !== undefined && (typeof p.note !== "string" || p.note.length > 500)) return { ok: false, reason: "A visit's note must be text of at most 500 characters" };
    return { ok: true, value: { client: p.client.trim(), minutes: p.minutes, ...(p.note !== undefined ? { note: p.note as string } : {}) } };
  },
  async execute(env, value, context) {
    const inserted = await env.OFFICE_DB.prepare("INSERT INTO proof_visits (client, minutes, note, pending_action_id) VALUES (?, ?, ?, ?) RETURNING id")
      .bind(value.client, value.minutes, value.note ?? null, context.actionId)
      .first<{ id: number }>();
    return { visitId: inserted!.id, client: value.client, minutes: value.minutes };
  },
};
