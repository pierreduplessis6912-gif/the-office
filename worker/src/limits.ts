// Cost caps: how much a member and a business may use the model in a day.
//
// Added 2026-10-14 (SHIP_CHECKLIST.md item 6), on top of the metering (usage.ts) that says what the model costs. The limits live as DATA in the shared layer (a `plans` table; a business's plan is
// `businesses.plan`), so they can be changed without a deploy and differ by plan. The agreed starting point: 100 messages a day per member, and a spend ceiling per business, in WARN mode: the
// limit is checked and recorded and shown in the health report, but nobody is stopped. In ENFORCE mode a member or business over the limit is turned away with a clear 429 BEFORE the model is called.
//
// The rule that matters most: a failure in this file must NEVER stop anyone working. Every read of the limits is fail-open (any error, a missing table or a nonsense value gives the default plan, which
// warns and never blocks), and counting happens after the response has gone and cannot reach the person.
import { verifySession, getSessionToken } from "./auth";
import type { Env } from "./types";
import { utcDay } from "./usage";

export type CapMode = "warn" | "enforce";
export interface Plan {
  name: string;
  messagesPerMemberPerDay: number;
  neuronsPerBusinessPerDay: number;
  mode: CapMode;
}
// Placeholders to tune against real use (one real sentence cost about 939 neurons, so 100 messages is up to about 94,000 neurons, roughly a dollar, for a heavy member).
export const DEFAULT_PLAN: Plan = { name: "standard", messagesPerMemberPerDay: 100, neuronsPerBusinessPerDay: 400_000, mode: "warn" };
export const CAP_ROUTES = new Set(["POST /messages/text", "POST /files/audio"]);

const PLANS_DDL = "CREATE TABLE IF NOT EXISTS plans (name TEXT PRIMARY KEY, messages_per_member_per_day INTEGER NOT NULL, neurons_per_business_per_day INTEGER NOT NULL, mode TEXT NOT NULL DEFAULT 'warn', updated_at TEXT NOT NULL DEFAULT (datetime('now')))";
const USAGE_DDL = "CREATE TABLE IF NOT EXISTS member_usage (day TEXT NOT NULL, member TEXT NOT NULL, messages INTEGER NOT NULL DEFAULT 0, over_limit INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, member))";

const isCount = (x: unknown, max: number): x is number => typeof x === "number" && Number.isInteger(x) && x >= 1 && x <= max;
export const MAX_MESSAGES = 100_000;
export const MAX_NEURONS = 100_000_000;

// A member is counted by a short hash of their address, so the day's counts hold no readable address (and nothing built from them can leak one).
export async function memberKey(email: string): Promise<string> {
  const bytes = new TextEncoder().encode(email.trim().toLowerCase());
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].slice(0, 6).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---- reading the plan (fail-open, briefly cached) --------------------------------------------------------------------------------------------------------------------------------------------------
const cache = new Map<string, { plan: Plan; at: number }>();
export function clearPlanCache(): void {
  cache.clear();
}
const sharedOf = (env: Env): D1Database => (env.SHARED_DB ?? env.OFFICE_DB) as D1Database;

function validPlan(row: { name?: unknown; messages_per_member_per_day?: unknown; neurons_per_business_per_day?: unknown; mode?: unknown } | null): Plan | null {
  if (!row || typeof row.name !== "string") return null;
  if (!isCount(row.messages_per_member_per_day, MAX_MESSAGES) || !isCount(row.neurons_per_business_per_day, MAX_NEURONS)) return null;
  if (row.mode !== "warn" && row.mode !== "enforce") return null;
  return { name: row.name, messagesPerMemberPerDay: row.messages_per_member_per_day, neuronsPerBusinessPerDay: row.neurons_per_business_per_day, mode: row.mode };
}

export async function readPlan(env: Env, now: number = Date.now()): Promise<Plan> {
  const business = env.BUSINESS_ID ?? "";
  const ttl = Math.max(0, Number(env.PLAN_CACHE_SECONDS ?? 300)) * 1000;
  const hit = cache.get(business);
  if (hit && ttl > 0 && now - hit.at < ttl) return hit.plan;
  let plan = DEFAULT_PLAN;
  try {
    const row = await sharedOf(env)
      .prepare("SELECT p.name AS name, p.messages_per_member_per_day AS messages_per_member_per_day, p.neurons_per_business_per_day AS neurons_per_business_per_day, p.mode AS mode FROM businesses b JOIN plans p ON p.name = b.plan WHERE b.id = ?")
      .bind(business)
      .first<{ name: string; messages_per_member_per_day: number; neurons_per_business_per_day: number; mode: string }>();
    plan = validPlan(row) ?? DEFAULT_PLAN;
  } catch {
    plan = DEFAULT_PLAN;   // no shared tables, no row, any error: the default warns and never blocks
  }
  cache.set(business, { plan, at: now });
  return plan;
}

// ---- before the model: check, and count afterwards -----------------------------------------------------------------------------------------------------------------------------------------
export interface CapCheck {
  countable: boolean;
  member: string | null;
  used: number;
  plan: Plan;
  over: "messages" | "spend" | null;
  block: Response | null;
}
const nothing = (): CapCheck => ({ countable: false, member: null, used: 0, plan: DEFAULT_PLAN, over: null, block: null });
const secondsToMidnightUtc = (now: Date): number => Math.max(1, Math.ceil((Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1) - now.getTime()) / 1000));

export async function capBefore(env: Env, request: Request, now: Date = new Date()): Promise<CapCheck> {
  try {
    const url = new URL(request.url);
    if (!CAP_ROUTES.has(`${request.method} ${url.pathname}`)) return nothing();
    const session = await verifySession(env, getSessionToken(request));
    if (!session) return nothing();   // not signed in: the front door answers that, not this
    const plan = await readPlan(env, now.getTime());
    const member = await memberKey(session.email);
    const day = utcDay(now);
    let used = 0;
    try {
      used = Number((await env.OFFICE_DB.prepare("SELECT messages FROM member_usage WHERE day = ? AND member = ?").bind(day, member).first<{ messages: number }>())?.messages ?? 0);
    } catch {
      used = 0;   // the table does not exist until the first message is counted
    }
    let neurons = 0;
    try {
      neurons = Number((await env.OFFICE_DB.prepare("SELECT neurons FROM model_usage WHERE day = ?").bind(day).first<{ neurons: number }>())?.neurons ?? 0);
    } catch {
      neurons = 0;
    }
    const over: CapCheck["over"] = used >= plan.messagesPerMemberPerDay ? "messages" : neurons >= plan.neuronsPerBusinessPerDay ? "spend" : null;
    let block: Response | null = null;
    if (over && plan.mode === "enforce") {
      const seconds = secondsToMidnightUtc(now);
      block = Response.json(
        {
          error: over === "messages" ? `You have reached today's limit of ${plan.messagesPerMemberPerDay} messages. It resets at midnight UTC.` : "This business has reached today's usage limit. It resets at midnight UTC.",
          capped: true, reason: over, limit: over === "messages" ? plan.messagesPerMemberPerDay : plan.neuronsPerBusinessPerDay, used: over === "messages" ? used : Math.round(neurons), resetsInSeconds: seconds,
        },
        { status: 429, headers: { "Retry-After": String(seconds) } }
      );
    }
    return { countable: true, member, used, plan, over, block };
  } catch {
    return nothing();   // fail-open: nothing here may ever stop anyone working
  }
}

// Only a message that really ran counts: a success, and not a retry answered from the stored result.
export const isCountable = (response: Response): boolean => response.status >= 200 && response.status < 300 && !response.headers.has("X-Idempotent-Replay");

export async function capAfter(env: Env, check: CapCheck, now: Date = new Date()): Promise<void> {
  if (!check.countable || !check.member) return;
  await env.OFFICE_DB.prepare(USAGE_DDL).run();
  const over = check.used >= check.plan.messagesPerMemberPerDay ? 1 : 0;
  await env.OFFICE_DB.prepare("INSERT INTO member_usage (day, member, messages, over_limit) VALUES (?, ?, 1, ?) ON CONFLICT(day, member) DO UPDATE SET messages = messages + 1, over_limit = over_limit + excluded.over_limit")
    .bind(utcDay(now), check.member, over)
    .run();
  await env.OFFICE_DB.prepare("DELETE FROM member_usage WHERE day < ?").bind(utcDay(new Date(now.getTime() - 30 * 86_400_000))).run();
}

// What the health report shows about today's use against the limits (no member is identified).
export async function memberUsageToday(env: Env, now: Date = new Date()): Promise<{ plan: Plan; activeMembers: number; messages: number; topMemberMessages: number; membersAtOrOverLimit: number }> {
  const plan = await readPlan(env, now.getTime());
  try {
    const row = await env.OFFICE_DB.prepare("SELECT COUNT(*) AS members, COALESCE(SUM(messages), 0) AS messages, COALESCE(MAX(messages), 0) AS top, COALESCE(SUM(CASE WHEN messages >= ? THEN 1 ELSE 0 END), 0) AS atlimit FROM member_usage WHERE day = ?")
      .bind(plan.messagesPerMemberPerDay, utcDay(now))
      .first<{ members: number; messages: number; top: number; atlimit: number }>();
    return { plan, activeMembers: Number(row?.members ?? 0), messages: Number(row?.messages ?? 0), topMemberMessages: Number(row?.top ?? 0), membersAtOrOverLimit: Number(row?.atlimit ?? 0) };
  } catch {
    return { plan, activeMembers: 0, messages: 0, topMemberMessages: 0, membersAtOrOverLimit: 0 };
  }
}

// ---- the limits as DATA: read and change them in the shared layer -----------------------------------------------------------------------------------------------------------------------------
export async function listPlans(env: Env): Promise<Plan[]> {
  const db = env.OFFICE_DB;
  await db.prepare(PLANS_DDL).run();
  await db.prepare("INSERT OR IGNORE INTO plans (name, messages_per_member_per_day, neurons_per_business_per_day, mode) VALUES (?, ?, ?, ?)").bind(DEFAULT_PLAN.name, DEFAULT_PLAN.messagesPerMemberPerDay, DEFAULT_PLAN.neuronsPerBusinessPerDay, DEFAULT_PLAN.mode).run();
  const { results } = await db.prepare("SELECT name, messages_per_member_per_day, neurons_per_business_per_day, mode FROM plans ORDER BY name").all<{ name: string; messages_per_member_per_day: number; neurons_per_business_per_day: number; mode: string }>();
  return (results ?? []).map((r) => validPlan(r)).filter((p): p is Plan => p !== null);
}

export async function setPlan(env: Env, input: { name?: unknown; messagesPerMemberPerDay?: unknown; neuronsPerBusinessPerDay?: unknown; mode?: unknown }): Promise<{ ok: true; plan: Plan } | { ok: false; error: string }> {
  if (typeof input.name !== "string" || !/^[a-z][a-z0-9-]{1,30}$/.test(input.name)) return { ok: false, error: "name must be 2 to 31 characters: lowercase letters, digits and hyphens, starting with a letter" };
  if (!isCount(input.messagesPerMemberPerDay, MAX_MESSAGES)) return { ok: false, error: `messagesPerMemberPerDay must be a whole number from 1 to ${MAX_MESSAGES}` };
  if (!isCount(input.neuronsPerBusinessPerDay, MAX_NEURONS)) return { ok: false, error: `neuronsPerBusinessPerDay must be a whole number from 1 to ${MAX_NEURONS}` };
  if (input.mode !== "warn" && input.mode !== "enforce") return { ok: false, error: 'mode must be "warn" or "enforce"' };
  await env.OFFICE_DB.prepare(PLANS_DDL).run();
  await env.OFFICE_DB.prepare("INSERT INTO plans (name, messages_per_member_per_day, neurons_per_business_per_day, mode) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET messages_per_member_per_day = excluded.messages_per_member_per_day, neurons_per_business_per_day = excluded.neurons_per_business_per_day, mode = excluded.mode, updated_at = datetime('now')")
    .bind(input.name, input.messagesPerMemberPerDay, input.neuronsPerBusinessPerDay, input.mode)
    .run();
  clearPlanCache();
  return { ok: true, plan: { name: input.name, messagesPerMemberPerDay: input.messagesPerMemberPerDay, neuronsPerBusinessPerDay: input.neuronsPerBusinessPerDay, mode: input.mode } };
}

export async function assignPlan(env: Env, businessId: unknown, plan: unknown): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
  if (typeof businessId !== "string" || typeof plan !== "string") return { ok: false, error: "send a business and a plan", status: 400 };
  const known = (await listPlans(env)).some((p) => p.name === plan);
  if (!known) return { ok: false, error: `no such plan: ${plan}`, status: 404 };
  const done = await env.OFFICE_DB.prepare("UPDATE businesses SET plan = ? WHERE id = ?").bind(plan, businessId).run();
  if (!done.meta.changes) return { ok: false, error: `no such business: ${businessId}`, status: 404 };
  clearPlanCache();
  return { ok: true };
}
