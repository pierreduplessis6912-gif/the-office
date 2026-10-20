// The credential core for the read-only MCP adapter (MCP_ARCHITECTURE.md, "Decisions made, and the design"). A key lets an outside assistant READ a business's figures as one member and never more: it is issued by the owner, shown ONCE, stored only as a hash, revocable at once, and re-checked against the member's CURRENT role on every use. This module holds the credential only (issue, list, revoke, authenticate); the routes and the /mcp endpoint that use it come in later slices.
// FORMAT  omk.<businessId>.<keyId>.<secret>   The business id lets the Worker route a request to the right business object without a shared lookup (it only peeks; the object verifies, exactly as for signed links). keyId is 16 hex characters and public. The secret is 32 random bytes, base64url (43 characters): high-entropy, so a plain SHA-256 is enough and a slow password hash is not needed. Only the hash is ever stored.
// THE RULES (each is held by a test that fails if it is removed, tools/mcp-keys-breakage.js): (1) the key is returned once and never stored or listed; (2) a wrong secret, an unknown key, a revoked key, a key for another business, a malformed key and a member who is no longer active ALL fail, and fail the same way to the caller; (3) a missing key costs the same comparison as a wrong one, so existence is not leaked by timing; (4) the capabilities are those of the member's role NOW, so a demoted member loses access at once; (5) a malformed string never reaches the database or wakes an object; (6) a business can hold at most 10 active keys.
import { safeEqual } from "./admin-gate";
import { getRoleCapabilities } from "./auth";
import { isBusinessId } from "./directory";
import { KEY_ID_PATTERN, KEY_PREFIX, parseKey } from "./mcp-key-format";
import type { Env } from "./types";

const MAX_LABEL = 60;
export const MAX_ACTIVE_KEYS = 10;
const NO_HASH = "0".repeat(64);   // what a missing key is compared against, so it costs the same as a wrong secret

const hex = (bytes: Uint8Array): string => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
const base64Url = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
async function sha256Hex(text: string): Promise<string> { return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))); }

// The key FORMAT (parseKey, peekBusinessFromKey, bearerKey) lives in mcp-key-format.ts so the gate and the router can use it without this module; it is re-exported here.
export { bearerKey, parseKey, peekBusinessFromKey, type ParsedKey } from "./mcp-key-format";

async function ensureTable(env: Env): Promise<void> {
  await env.OFFICE_DB.prepare("CREATE TABLE IF NOT EXISTS mcp_keys (id TEXT PRIMARY KEY, label TEXT NOT NULL, email TEXT NOT NULL, hash TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), created_by TEXT NOT NULL, last_used_at TEXT, revoked_at TEXT, uses INTEGER NOT NULL DEFAULT 0)").run();
}

const tidy = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return email.length <= 254 && /^[^\s@]+@[^\s@]+$/.test(email) ? email : null;
};

export type IssueResult = { ok: true; id: string; key: string; label: string; email: string } | { ok: false; error: string };

/** Issues a read-only key for an ACTIVE member. The key is in the result once and nowhere else: only its hash is stored. */
export async function issueKey(env: Env, input: { businessId: string; email: unknown; label: unknown; createdBy: unknown }): Promise<IssueResult> {
  if (!isBusinessId(input.businessId)) return { ok: false, error: "that is not a valid business." };
  const label = typeof input.label === "string" ? input.label.trim() : "";
  if (label.length < 1 || label.length > MAX_LABEL || /[\u0000-\u001f\u007f]/.test(label)) return { ok: false, error: "the label must be 1 to 60 plain characters." };
  const email = tidy(input.email), createdBy = tidy(input.createdBy);
  if (email === null || createdBy === null) return { ok: false, error: "an email address is needed." };
  await ensureTable(env);
  const member = await env.OFFICE_DB.prepare("SELECT status FROM memberships WHERE google_email = ?").bind(email).first<{ status: string }>();
  if (!member || member.status !== "active") return { ok: false, error: "that address is not an active member." };
  const active = await env.OFFICE_DB.prepare("SELECT COUNT(*) AS n FROM mcp_keys WHERE revoked_at IS NULL").first<{ n: number }>();
  if ((active?.n ?? 0) >= MAX_ACTIVE_KEYS) return { ok: false, error: `there are already ${MAX_ACTIVE_KEYS} active keys: revoke one first.` };
  const id = hex(crypto.getRandomValues(new Uint8Array(8)));
  const secret = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  await env.OFFICE_DB.prepare("INSERT INTO mcp_keys (id, label, email, hash, created_by) VALUES (?, ?, ?, ?, ?)").bind(id, label, email, await sha256Hex(secret), createdBy).run();
  return { ok: true, id, key: `${KEY_PREFIX}.${input.businessId}.${id}.${secret}`, label, email };
}

export interface KeySummary { id: string; label: string; email: string; created_at: string; created_by: string; last_used_at: string | null; revoked_at: string | null; uses: number }

/** The keys, newest first, WITHOUT their hashes: the hash and the secret are never read back out. */
export async function listKeys(env: Env): Promise<KeySummary[]> {
  await ensureTable(env);
  const { results } = await env.OFFICE_DB.prepare("SELECT id, label, email, created_at, created_by, last_used_at, revoked_at, uses FROM mcp_keys ORDER BY created_at DESC, id").all<KeySummary>();
  return results;
}

/** Revokes a key at once. Idempotent. `found` is false only for an id that does not exist. */
export async function revokeKey(env: Env, id: unknown): Promise<{ found: boolean }> {
  if (typeof id !== "string" || !KEY_ID_PATTERN.test(id)) return { found: false };
  await ensureTable(env);
  const row = await env.OFFICE_DB.prepare("SELECT id FROM mcp_keys WHERE id = ?").bind(id).first<{ id: string }>();
  if (!row) return { found: false };
  await env.OFFICE_DB.prepare("UPDATE mcp_keys SET revoked_at = datetime('now') WHERE id = ? AND revoked_at IS NULL").bind(id).run();
  return { found: true };
}

export type AuthResult = { ok: true; keyId: string; email: string; role: string; capabilities: string[] } | { ok: false; reason: "malformed" | "wrong_business" | "unknown_or_bad_key" | "revoked" | "member_inactive" };

/** Checks a presented key. The reason is for the audit and the tests: a caller is only ever told "unauthorized". On success the capabilities are the member's role's NOW. */
export async function authenticateKey(env: Env, raw: unknown): Promise<AuthResult> {
  const key = parseKey(raw);
  if (key === null) return { ok: false, reason: "malformed" };
  if (env.BUSINESS_MODE === "object" && (!env.BUSINESS_ID || key.businessId !== env.BUSINESS_ID)) return { ok: false, reason: "wrong_business" };
  let row: { id: string; email: string; hash: string; revoked_at: string | null } | null = null;
  try { row = await env.OFFICE_DB.prepare("SELECT id, email, hash, revoked_at FROM mcp_keys WHERE id = ?").bind(key.keyId).first(); } catch { row = null; }   // no table yet: no keys
  const same = await safeEqual(await sha256Hex(key.secret), row?.hash ?? NO_HASH);
  if (row === null || !same) return { ok: false, reason: "unknown_or_bad_key" };
  if (row.revoked_at !== null) return { ok: false, reason: "revoked" };
  const member = await env.OFFICE_DB.prepare("SELECT role, status FROM memberships WHERE google_email = ?").bind(row.email).first<{ role: string; status: string }>();
  if (!member || member.status !== "active") return { ok: false, reason: "member_inactive" };
  const capabilities = await getRoleCapabilities(env, member.role);
  try { await env.OFFICE_DB.prepare("UPDATE mcp_keys SET last_used_at = datetime('now'), uses = uses + 1 WHERE id = ?").bind(row.id).run(); } catch { /* a failed note of use never refuses a valid key */ }
  return { ok: true, keyId: row.id, email: row.email, role: member.role, capabilities };
}
