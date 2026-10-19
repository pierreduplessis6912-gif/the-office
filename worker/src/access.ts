// When a business stops paying, its access ends. Two lapses, both decided by DATE and only after PayFast has told us (billing.ts records the state):
//   past_due   a payment failed: the business keeps working through its grace period (a date, last day inclusive) and is refused after it
//   cancelled  the subscription was cancelled: the business keeps working through the period it already paid for (a date, last day inclusive) and is refused after it
// An ACTIVE subscription is never cut by a date: renewals move it, and a lost notification must not lock out a customer who is paying. Every other state, a missing or unreadable date, a missing column and a database fault all mean NOT lapsed: the
// check fails OPEN, because locking out someone who has paid is far worse than a day's grace for someone who has not. It runs at sign-in (a clear page, in directory.ts) and on EVERY request (here), so a session issued weeks ago cannot outlive the lapse.
// Pinned in tools/access.test.js.
import type { Env } from "./types";

export type Lapse = "payment" | "cancelled" | null;

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const isDate = (value: unknown): value is string => typeof value === "string" && YMD.test(value) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

// `today` is a UTC date (YYYY-MM-DD). Comparing dates as text is exact for this format.
export function lapseOf(row: { billing_status?: string | null; grace_until?: string | null; period_end?: string | null }, today: string): Lapse {
  try {
    if (row.billing_status === "past_due" && isDate(row.grace_until) && row.grace_until < today) return "payment";
    if (row.billing_status === "cancelled" && isDate(row.period_end) && row.period_end < today) return "cancelled";
  } catch { /* an unreadable date is not a lapse */ }
  return null;
}

// The same rule as SQL, for the directory's sign-in queries (every operand is made non-null first, so a missing value can never turn the whole condition into NULL and refuse someone by accident).
const DATE_SHAPE = "'[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'";
export const LAPSED_SQL =
  `((COALESCE(b.billing_status, '') = 'past_due' AND COALESCE(b.grace_until, '') GLOB ${DATE_SHAPE} AND b.grace_until < date('now'))` +
  ` OR (COALESCE(b.billing_status, '') = 'cancelled' AND COALESCE(b.period_end, '') GLOB ${DATE_SHAPE} AND b.period_end < date('now')))`;

// The per-request question. One directory read, remembered for ACCESS_CACHE_SECONDS (default 60; 0 turns the memory off) per database binding, so a busy business costs one read a minute, not one a request. A fault is not remembered.
const memory = new WeakMap<object, Map<string, { at: number; lapse: Lapse }>>();
export async function businessLapsed(env: Env, now: number = Date.now()): Promise<Lapse> {
  const id = env.BUSINESS_ID, db = env.SHARED_DB;
  if (!id || !db) return null;   // the original single-business mode has no directory: nothing to check
  const seconds = Number(env.ACCESS_CACHE_SECONDS ?? 60), ttl = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
  let perDb = memory.get(db as object);
  const seen = perDb?.get(id);
  if (ttl > 0 && seen && now - seen.at < ttl) return seen.lapse;
  try {
    const row = await db.prepare("SELECT billing_status, grace_until, period_end FROM businesses WHERE id = ?").bind(id).first<{ billing_status: string | null; grace_until: string | null; period_end: string | null }>();
    const lapse = row ? lapseOf(row, new Date(now).toISOString().slice(0, 10)) : null;
    if (ttl > 0) { if (!perDb) { perDb = new Map(); memory.set(db as object, perDb); } perDb.set(id, { at: now, lapse }); }
    return lapse;
  } catch {
    return null;   // a missing column, a missing table or a fault: not lapsed
  }
}
