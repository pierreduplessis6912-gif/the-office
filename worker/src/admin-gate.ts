// The gate for /admin and /debug routes (the ones the admin key opens).
//
// Added 2026-10-11 (hardening, SHIP_CHECKLIST.md item 2). It replaces a plain comparison of one shared key, which had no limit on wrong guesses, no record
// of who called what, and opened everything. Now: wrong guesses are throttled; the key is compared in constant time; every route has a tier (admin-routes.ts);
// a "privileged" route also needs a second secret (ADMIN_CONFIRM_KEY), and is switched OFF while that secret is not set; and every call is recorded.
import { ADMIN_ROUTE_TIERS, type AdminTier } from "./admin-routes";
import type { Env } from "./types";

export const MAX_FAILED_ATTEMPTS = 5;
export const LOCKOUT_MINUTES = 15;

const encoder = new TextEncoder();
async function digest(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
}

// Compares two secrets without the time taken depending on where they first differ: both are hashed to the same length first, then every byte is compared.
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([digest(a), digest(b)]);
  let difference = 0;
  for (let i = 0; i < x.length; i++) difference |= x[i] ^ y[i];
  return difference === 0;
}

export function adminTierOf(method: string, path: string): AdminTier | null {
  return ADMIN_ROUTE_TIERS[`${method} ${path}`] ?? null;
}

// Who is calling, as a short hash: enough to throttle one source and to see in the record that two calls came from the same place, never the address itself.
export async function hashSource(env: Env, request: Request): Promise<string> {
  const address = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const hashed = await digest(`${env.SESSION_SECRET}|admin-source|${address}`);
  return [...hashed.slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function recentFailures(env: Env, source: string): Promise<number> {
  try {
    const row = await env.OFFICE_DB.prepare("SELECT COUNT(*) AS n FROM admin_audit WHERE source = ? AND status IN (401, 403) AND created_at >= datetime('now', ?)")
      .bind(source, `-${LOCKOUT_MINUTES} minutes`)
      .first<{ n: number }>();
    return row?.n ?? 0;
  } catch (error) {
    if (/no such table/i.test(String((error as { message?: string } | null)?.message ?? error))) return 0;   // nothing has ever been recorded
    throw error;
  }
}

// Returns null when the call may go ahead, or the refusal to send. Order matters: the throttle comes FIRST, so even a correct key is refused while a source is
// locked out (a guesser who hits the right key during the lockout gets nothing); then the key; then the route's tier; then, for a privileged route, the second secret.
export async function authorizeAdmin(request: Request, env: Env, path: string): Promise<Response | null> {
  const source = await hashSource(env, request);
  if ((await recentFailures(env, source)) >= MAX_FAILED_ATTEMPTS) {
    return Response.json({ error: "too many failed attempts, try again later" }, { status: 429, headers: { "Retry-After": String(LOCKOUT_MINUTES * 60) } });
  }
  const given = request.headers.get("X-Admin-Key");
  if (!given || !env.ADMIN_KEY || !(await safeEqual(given, env.ADMIN_KEY))) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const tier = adminTierOf(request.method, path);
  if (tier === null) return Response.json({ error: "no such admin route" }, { status: 403 });
  if (tier === "privileged") {
    if (!env.ADMIN_CONFIRM_KEY) {
      return Response.json({ error: "privileged admin routes are switched off until ADMIN_CONFIRM_KEY is set" }, { status: 403 });
    }
    const confirm = request.headers.get("X-Admin-Confirm");
    if (!confirm || !(await safeEqual(confirm, env.ADMIN_CONFIRM_KEY))) {
      return Response.json({ error: "this route needs the confirmation key (X-Admin-Confirm)" }, { status: 403 });
    }
  }
  return null;
}

const AUDIT_DDL =
  "CREATE TABLE IF NOT EXISTS admin_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL DEFAULT (datetime('now')), method TEXT NOT NULL, path TEXT NOT NULL, tier TEXT, status INTEGER NOT NULL, source TEXT NOT NULL)";

// One row per admin call, allowed or refused: the route (never the query string or the body), the tier, the outcome and the hashed source. Never the key.
// A call that was refused because the source is locked out is NOT recorded, so a flood of guesses cannot fill the table.
export async function recordAdminCall(env: Env, row: { method: string; path: string; tier: AdminTier | null; status: number; source: string }): Promise<void> {
  await env.OFFICE_DB.prepare(AUDIT_DDL).run();
  await env.OFFICE_DB.prepare("INSERT INTO admin_audit (method, path, tier, status, source) VALUES (?, ?, ?, ?, ?)").bind(row.method, row.path, row.tier, row.status, row.source).run();
}
