// (File name: freetrial.ts; trial.ts is the older architecture-trial module.) What an operator can do with a business on a free trial (SHIP_CHECKLIST.md item 15; found missing 2026-10-17: once a trial's end passed, the address found no business, and nothing could bring it back, even after its plan was changed,
// because the end date stayed set). Two moves, both on an ACTIVE business that HAS a trial: CONVERT it to a real plan (the trial is cleared, so the owner signs in as a normal member), or EXTEND it (days are counted from the later of now
// and its current end, so an ended trial comes back to life for exactly that long). Nothing is ever deleted, and the plan cache is cleared so a change takes effect at once. The workflow that calls these is prod-trial.yml (a guard, one write).
import { isBusinessId } from "./directory";
import { clearPlanCache, listPlans } from "./limits";
import type { Env } from "./types";

export const MAX_EXTEND_DAYS = 90;
export const sqlTime = (ms: number): string => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
export const fromSqlTime = (text: string): number => Date.parse(`${text.replace(" ", "T")}Z`);

type Failed = { ok: false; error: string; status: number };
type Row = { status: string; plan: string; trial_ends_at: string | null };

async function trialBusiness(env: Env, businessId: unknown): Promise<{ ok: true; id: string; row: Row } | Failed> {
  if (!isBusinessId(businessId)) return { ok: false, error: "send a valid business id", status: 400 };
  let row: Row | null;
  try {
    row = await env.OFFICE_DB.prepare("SELECT status, plan, trial_ends_at FROM businesses WHERE id = ?").bind(businessId).first<Row>();
  } catch {
    return { ok: false, error: "the directory has no trial information yet (no business has been started from the app)", status: 409 };   // no such table, or the columns are not there yet
  }
  if (!row) return { ok: false, error: `no such business: ${businessId}`, status: 404 };
  if (row.status !== "active") return { ok: false, error: `that business is ${row.status}, not active: only an active business can be moved off its trial`, status: 409 };
  if (!row.trial_ends_at) return { ok: false, error: "that business is not on a free trial: there is nothing to convert or extend", status: 409 };
  return { ok: true, id: businessId, row };
}

export async function convertTrial(env: Env, businessId: unknown, plan: unknown): Promise<{ ok: true; business: string; plan: string; wasEndingAt: string } | Failed> {
  if (typeof plan !== "string" || !plan) return { ok: false, error: "send the plan to move the business to", status: 400 };
  if (plan === "trial") return { ok: false, error: "the trial plan is not a plan to convert TO: choose the plan the business pays for", status: 400 };
  const found = await trialBusiness(env, businessId);
  if (!found.ok) return found;
  if (!(await listPlans(env)).some((p) => p.name === plan)) return { ok: false, error: `no such plan: ${plan}`, status: 404 };
  await env.OFFICE_DB.prepare("UPDATE businesses SET plan = ?, trial_ends_at = NULL WHERE id = ? AND status = 'active'").bind(plan, found.id).run();
  clearPlanCache();
  return { ok: true, business: found.id, plan, wasEndingAt: found.row.trial_ends_at as string };
}

export async function extendTrial(env: Env, businessId: unknown, days: unknown, now: number = Date.now()): Promise<{ ok: true; business: string; trialEndsAt: string; wasEndingAt: string } | Failed> {
  if (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > MAX_EXTEND_DAYS) return { ok: false, error: `days is a whole number from 1 to ${MAX_EXTEND_DAYS}`, status: 400 };
  const found = await trialBusiness(env, businessId);
  if (!found.ok) return found;
  const from = Math.max(now, fromSqlTime(found.row.trial_ends_at as string));
  const trialEndsAt = sqlTime(from + days * 86_400_000);
  await env.OFFICE_DB.prepare("UPDATE businesses SET trial_ends_at = ? WHERE id = ? AND status = 'active'").bind(trialEndsAt, found.id).run();
  clearPlanCache();
  return { ok: true, business: found.id, trialEndsAt, wasEndingAt: found.row.trial_ends_at as string };
}
