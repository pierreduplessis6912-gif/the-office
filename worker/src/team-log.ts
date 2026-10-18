// The team log and the sign-in stamp (SHIP_CHECKLIST.md item 15). Two things an owner needs and did not have: WHO added, invited, changed and removed WHOM and when, and when each person last signed in (the nearest thing to catching
// a mistyped address: someone added who has "never signed in" is not who the owner thinks it is).
// Both live in tables that create themselves the first time they are written (the precedent of permission_audit: no migration step to run by hand), are written AFTER the change they describe, and a failure to write either is logged and
// swallowed: an audit that could stop the business working would be worse than the gap. Reads tolerate a business that has never written either. "Last signed in" is the last GOOGLE SIGN-IN (a session lasts 30 days), not "last seen".
import { normaliseEmail } from "./directory";
import type { Env } from "./types";

const TABLES = [
  "CREATE TABLE IF NOT EXISTS team_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL DEFAULT (datetime('now')), actor TEXT, action TEXT NOT NULL, target TEXT, detail TEXT)",
  "CREATE TABLE IF NOT EXISTS member_sign_ins (email TEXT PRIMARY KEY, first_at TEXT NOT NULL, last_at TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 1)",
];

export type TeamAction = "added" | "invited" | "invitation_withdrawn" | "role_changed" | "deactivated" | "reactivated" | "joined" | "named" | "renamed" | "profile_updated";
export interface TeamEvent { id: number; at: string; actor: string | null; action: string; target: string | null; detail: Record<string, unknown> }
export interface SignInStamp { firstAt: string; lastAt: string; count: number }

async function ensure(env: Env): Promise<void> {
  for (const sql of TABLES) await env.OFFICE_DB.prepare(sql).run();
}
const logFailure = (what: string, error: unknown): void => console.error(JSON.stringify({ event: "team_log_failed", what, message: error instanceof Error ? error.message : String(error) }));

export async function recordTeamEvent(env: Env, actor: string | null, action: TeamAction, target: string | null, detail?: Record<string, unknown>): Promise<void> {
  try {
    await ensure(env);
    await env.OFFICE_DB.prepare("INSERT INTO team_audit (actor, action, target, detail) VALUES (?, ?, ?, ?)")
      .bind(actor ? normaliseEmail(actor) : null, action, target ? normaliseEmail(target) : null, detail ? JSON.stringify(detail) : null)
      .run();
  } catch (error) {
    logFailure(action, error);
  }
}

// Only for an address that IS on the team: a sign-in for anyone else records nothing.
export async function recordSignIn(env: Env, email: string): Promise<void> {
  try {
    await ensure(env);
    const address = normaliseEmail(email ?? "");
    await env.OFFICE_DB.prepare(
      "INSERT INTO member_sign_ins (email, first_at, last_at, count) SELECT ?, datetime('now'), datetime('now'), 1 WHERE EXISTS (SELECT 1 FROM memberships WHERE google_email = ?) " +
        "ON CONFLICT(email) DO UPDATE SET last_at = datetime('now'), count = count + 1"
    )
      .bind(address, address)
      .run();
  } catch (error) {
    logFailure("sign_in", error);
  }
}

export async function listTeamActivity(env: Env, limit = 30): Promise<TeamEvent[]> {
  try {
    const { results } = await env.OFFICE_DB.prepare("SELECT id, created_at, actor, action, target, detail FROM team_audit ORDER BY id DESC LIMIT ?").bind(limit).all<{ id: number; created_at: string; actor: string | null; action: string; target: string | null; detail: string | null }>();
    return (results ?? []).map((r) => {
      let detail: Record<string, unknown> = {};
      try { if (r.detail) detail = JSON.parse(r.detail) as Record<string, unknown>; } catch { /* a detail that is not JSON shows as empty */ }
      return { id: r.id, at: r.created_at, actor: r.actor, action: r.action, target: r.target, detail };
    });
  } catch {
    return [];   // the table does not exist yet (nothing has ever been logged), or could not be read: the team still lists
  }
}

export async function readSignIns(env: Env): Promise<Map<string, SignInStamp>> {
  const out = new Map<string, SignInStamp>();
  try {
    const { results } = await env.OFFICE_DB.prepare("SELECT email, first_at, last_at, count FROM member_sign_ins").all<{ email: string; first_at: string; last_at: string; count: number }>();
    for (const r of results ?? []) out.set(normaliseEmail(r.email), { firstAt: r.first_at, lastAt: r.last_at, count: Number(r.count) });
  } catch { /* none recorded yet */ }
  return out;
}
