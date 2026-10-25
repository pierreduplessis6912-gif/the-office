// The business's half of the OAuth token exchange (mcp-oauth.ts, mcp-oauth-routes.ts; MCP_ARCHITECTURE.md, "OAuth for connectors"). The Worker has already verified the signed code; this runs INSIDE the business's own object, where two things can be enforced that the Worker cannot: a code works ONCE (its `jti` is a primary key, so a second insert fails), and the key is issued only for a member who is STILL an active owner right now. The key it returns is an ordinary read-only key (mcp-keys.ts): nothing here widens what an assistant can read. SECURITY-SENSITIVE.
import { getRoleCapabilities } from "./auth";
import { isBusinessId } from "./directory";
import { issueKey } from "./mcp-keys";
import type { Env } from "./types";

export type IssueOutcome = { ok: true; key: string } | { ok: false; status: 400 | 403 | 409; reason: "replayed" | "limit" | "not_owner" | "other" };
const JTI = /^[A-Za-z0-9_-]{22}$/;   // 16 random bytes, base64url (mcp-oauth.ts grant)
const refuse = (status: 400 | 403 | 409, reason: "replayed" | "limit" | "not_owner" | "other"): IssueOutcome => ({ ok: false, status, reason });

export async function issueForCode(env: Env, input: { email?: unknown; label?: unknown; jti?: unknown; scope?: unknown }): Promise<IssueOutcome> {
  if (env.MCP === "off") return refuse(409, "other");
  if (!isBusinessId(env.BUSINESS_ID) || typeof input.jti !== "string" || !JTI.test(input.jti) || typeof input.email !== "string") return refuse(400, "other");
  const email = input.email.trim().toLowerCase();
  const member = await env.OFFICE_DB.prepare("SELECT role, status FROM memberships WHERE google_email = ?").bind(email).first<{ role: string; status: string }>();
  // The owner only, as for the app's own key routes (can_invite_members can never be held by another role).
  if (!member || member.status !== "active" || !(await getRoleCapabilities(env, member.role)).includes("can_invite_members")) return refuse(403, "not_owner");
  await env.OFFICE_DB.prepare("CREATE TABLE IF NOT EXISTS mcp_oauth_codes (jti TEXT PRIMARY KEY, used_at TEXT NOT NULL DEFAULT (datetime('now')))").run();
  // A code lives five minutes, so a marker older than an hour can never matter again: this keeps the table small without a scheduled job.
  await env.OFFICE_DB.prepare("DELETE FROM mcp_oauth_codes WHERE used_at < datetime('now', '-1 hour')").run();
  try {
    await env.OFFICE_DB.prepare("INSERT INTO mcp_oauth_codes (jti) VALUES (?)").bind(input.jti).run();
  } catch (error) {
    return /unique|constraint|primary/i.test(String((error as Error)?.message ?? error)) ? refuse(400, "replayed") : refuse(409, "other");
  }
  const made = await issueKey(env, { businessId: env.BUSINESS_ID, email, label: input.label, createdBy: email, scope: input.scope === "mcp:write" ? "mcp:write" : "mcp:read" });
  if (made.ok) return { ok: true, key: made.key };
  return /already .* active keys/.test(made.error) ? refuse(409, "limit") : refuse(409, "other");
}
