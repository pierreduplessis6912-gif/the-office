// The shared layer's directory: which email belongs to which business.
//
// Architecture stage 2b, 2026-10-12 (DECISIONS.md, "Database architecture"). Each business's private data lives in its own Durable Object; the only thing every business shares is this
// directory, held in the Worker's own D1 database (in object mode that database holds NO business data, so it is free to be the shared layer). It maps an email address to the business
// that member signs in to, so a sign-in can find the right object, and nothing else: roles, memberships and everything else about a member stay inside the business's object.
// It is read once per SIGN-IN (not per request: the session carries the business id), and written by admin routes only.
import type { Env } from "./types";

// A business id is a short, lower-case, URL-safe name. It becomes part of an object's name, so it is validated everywhere it is read.
export const BUSINESS_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
export const isBusinessId = (value: unknown): value is string => typeof value === "string" && BUSINESS_ID_PATTERN.test(value);
export const objectNameFor = (businessId: string): string => `business-${businessId}`;
export const normaliseEmail = (email: string): string => email.trim().toLowerCase();

const DDL = [
  "CREATE TABLE IF NOT EXISTS businesses (id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', plan TEXT NOT NULL DEFAULT 'standard', created_at TEXT NOT NULL DEFAULT (datetime('now')))",
  "CREATE TABLE IF NOT EXISTS directory_members (email TEXT PRIMARY KEY, business_id TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')))",
  "CREATE INDEX IF NOT EXISTS idx_directory_members_business ON directory_members (business_id)",
];

export async function ensureDirectory(env: Env): Promise<void> {
  for (const statement of DDL) await env.OFFICE_DB.prepare(statement).run();
}

const missingTable = (error: unknown): boolean => /no such table/i.test(String((error as { message?: string } | null)?.message ?? error));

// Which business does this email sign in to? Null when it is in none (or the directory does not exist yet): a read never creates anything.
export async function lookupBusinessForEmail(env: Env, email: string): Promise<string | null> {
  try {
    const row = await env.OFFICE_DB.prepare(
      "SELECT m.business_id AS business_id FROM directory_members m JOIN businesses b ON b.id = m.business_id WHERE m.email = ? AND b.status = 'active'"
    )
      .bind(normaliseEmail(email))
      .first<{ business_id: string }>();
    return row && isBusinessId(row.business_id) ? row.business_id : null;
  } catch (error) {
    if (missingTable(error)) return null;
    throw error;
  }
}

export interface DirectoryListing {
  businesses: { id: string; name: string; status: string; plan: string; members: number }[];
}

export async function listDirectory(env: Env): Promise<DirectoryListing> {
  try {
    const { results } = await env.OFFICE_DB.prepare(
      "SELECT b.id AS id, b.name AS name, b.status AS status, b.plan AS plan, (SELECT COUNT(*) FROM directory_members m WHERE m.business_id = b.id) AS members FROM businesses b ORDER BY b.created_at, b.id"
    ).all<{ id: string; name: string; status: string; plan: string; members: number }>();
    return { businesses: results ?? [] };
  } catch (error) {
    if (missingTable(error)) return { businesses: [] };
    throw error;
  }
}

export async function createBusiness(env: Env, id: string, name: string, plan = "standard"): Promise<{ created: boolean }> {
  if (!isBusinessId(id)) throw new Error("a business id is 3 to 40 lower-case letters, digits and hyphens, not starting or ending with a hyphen");
  if (!name.trim()) throw new Error("a business needs a name");
  await ensureDirectory(env);
  const existing = await env.OFFICE_DB.prepare("SELECT id FROM businesses WHERE id = ?").bind(id).first();
  if (existing) return { created: false };
  await env.OFFICE_DB.prepare("INSERT INTO businesses (id, name, plan) VALUES (?, ?, ?)").bind(id, name.trim(), plan).run();
  return { created: true };
}

// An email belongs to exactly one business. Adding it again to the SAME business is a no-op; to a DIFFERENT one is refused (never silently moved: that would hand one business's
// member to another).
export async function addDirectoryMember(env: Env, email: string, businessId: string): Promise<{ added: boolean }> {
  if (!isBusinessId(businessId)) throw new Error("not a valid business id");
  const address = normaliseEmail(email);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) throw new Error("not a valid email address");
  await ensureDirectory(env);
  const business = await env.OFFICE_DB.prepare("SELECT id FROM businesses WHERE id = ?").bind(businessId).first();
  if (!business) throw new Error("no such business");
  const existing = await env.OFFICE_DB.prepare("SELECT business_id FROM directory_members WHERE email = ?").bind(address).first<{ business_id: string }>();
  if (existing) {
    if (existing.business_id === businessId) return { added: false };
    throw new Error("that email already belongs to another business");
  }
  await env.OFFICE_DB.prepare("INSERT INTO directory_members (email, business_id) VALUES (?, ?)").bind(address, businessId).run();
  return { added: true };
}
