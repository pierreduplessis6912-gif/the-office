// The shared layer's directory: which email belongs to which business.
//
// Architecture stage 2b, 2026-10-12 (DECISIONS.md, "Database architecture"). Each business's private data lives in its own Durable Object; the only thing every business shares is this
// directory, held in the Worker's own D1 database (in object mode that database holds NO business data, so it is free to be the shared layer). It maps an email address to the business
// that member signs in to, so a sign-in can find the right object, and nothing else: roles, memberships and everything else about a member stay inside the business's object.
// It is read once per SIGN-IN (not per request: the session carries the business id), and written by admin routes only.
import { LAPSED_SQL } from "./access";
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
  // An owner's invitation to an address that has no business yet: it waits here (the directory is the only place that can be asked at sign-in, before the person belongs to anything) until they accept. UNIQUE (email, business_id):
  // inviting the same person again refreshes the one row.
  "CREATE TABLE IF NOT EXISTS invitations (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, business_id TEXT NOT NULL, role TEXT NOT NULL, invited_by TEXT, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL DEFAULT (datetime('now')), expires_at TEXT NOT NULL, person_name TEXT, UNIQUE (email, business_id))",
  "CREATE INDEX IF NOT EXISTS idx_invitations_email ON invitations (email, status)",
];

// Columns added after the table's first version (trial support, 2026-10-17): when a business's free trial ends, and whether an operator or the owner themselves created it. SQLite has no "ADD COLUMN IF NOT EXISTS", so look first.
// This runs from the WRITERS (ensureDirectory), never from a read: every read below tolerates the columns not being there yet, so a deploy that precedes the first write breaks nothing.
async function ensureBusinessColumns(env: Env): Promise<void> {
  const { results } = await env.OFFICE_DB.prepare("PRAGMA table_info(businesses)").all<{ name: string }>();
  const have = new Set((results ?? []).map((r) => r.name));
  if (!have.has("trial_ends_at")) await env.OFFICE_DB.prepare("ALTER TABLE businesses ADD COLUMN trial_ends_at TEXT").run();
  if (!have.has("source")) await env.OFFICE_DB.prepare("ALTER TABLE businesses ADD COLUMN source TEXT NOT NULL DEFAULT 'admin'").run();
  // Where the owner of a business that was CLOSED in the empty-business handover went: the only record that it happened (signup.ts, emptiness.ts).
  if (!have.has("closed_into")) await env.OFFICE_DB.prepare("ALTER TABLE businesses ADD COLUMN closed_into TEXT").run();
  // How many seats a business has paid for (billing): a Team or Enterprise plan is priced and capped per seat. Null means none recorded (no limit).
  if (!have.has("seats")) await env.OFFICE_DB.prepare("ALTER TABLE businesses ADD COLUMN seats INTEGER").run();
}

// The name an owner gave an invitation (the person record is made or linked when the invitation is accepted). Added to a table that already exists the same way the business columns are: by the writers, never by a read.
async function ensureInvitationColumns(env: Env): Promise<void> {
  const { results } = await env.OFFICE_DB.prepare("PRAGMA table_info(invitations)").all<{ name: string }>();
  if (!(results ?? []).some((r) => r.name === "person_name")) await env.OFFICE_DB.prepare("ALTER TABLE invitations ADD COLUMN person_name TEXT").run();
}

export async function ensureDirectory(env: Env): Promise<void> {
  for (const statement of DDL) await env.OFFICE_DB.prepare(statement).run();
  await ensureBusinessColumns(env);
  await ensureInvitationColumns(env);
}

const missingTable = (error: unknown): boolean => /no such table/i.test(String((error as { message?: string } | null)?.message ?? error));
const missingColumn = (error: unknown): boolean => /no such column/i.test(String((error as { message?: string } | null)?.message ?? error));

// Which business does this email sign in to? Null when it is in none (or the directory does not exist yet): a read never creates anything.
export async function lookupBusinessForEmail(env: Env, email: string): Promise<string | null> {
  return (await lookupAccessForEmail(env, email))?.businessId ?? null;
}

// The business an email may sign in to RIGHT NOW, and when its free trial ends (null for a business that is not on a trial). A business whose trial has ended is not returned at all: the next sign-in finds nothing, and a session
// already issued dies at the trial's end (auth.ts signSession), so no request needs a status check.
export async function lookupAccessForEmail(env: Env, email: string): Promise<{ businessId: string; trialEndsAt: string | null; selfStarted: boolean } | null> {
  const base = "SELECT m.business_id AS business_id";
  const from = " FROM directory_members m JOIN businesses b ON b.id = m.business_id WHERE m.email = ? AND b.status = 'active'";
  const run = (sql: string) => env.OFFICE_DB.prepare(sql).bind(normaliseEmail(email)).first<{ business_id: string; trial_ends_at?: string | null; source?: string }>();
  try {
    let row: { business_id: string; trial_ends_at?: string | null; source?: string } | null;
    const trialRule = "AND (b.trial_ends_at IS NULL OR b.trial_ends_at > datetime('now'))";
    try {
      row = await run(`${base}, b.trial_ends_at AS trial_ends_at, b.source AS source${from} ${trialRule} AND NOT ${LAPSED_SQL}`);   // a business that has stopped paying (access.ts) is not let in
    } catch (error) {
      if (!missingColumn(error)) throw error;
      try {
        row = await run(`${base}, b.trial_ends_at AS trial_ends_at, b.source AS source${from} ${trialRule}`);   // from before the billing columns: only the trial rule can apply, and it MUST still apply
      } catch (again) {
        if (!missingColumn(again)) throw again;
        row = await run(`${base}${from}`);   // the directory predates trials: no business has one
      }
    }
    return row && isBusinessId(row.business_id) ? { businessId: row.business_id, trialEndsAt: row.trial_ends_at ?? null, selfStarted: row.source === "signup" } : null;
  } catch (error) {
    if (missingTable(error)) return null;
    throw error;
  }
}

// An email whose business had a trial that has now ENDED (so the sign-in can say so, instead of "you are not set up").
export async function findEndedTrialForEmail(env: Env, email: string): Promise<{ businessId: string; name: string; endedAt: string } | null> {
  try {
    const row = await env.OFFICE_DB.prepare(
      "SELECT b.id AS id, b.name AS name, b.trial_ends_at AS ended FROM directory_members m JOIN businesses b ON b.id = m.business_id WHERE m.email = ? AND b.trial_ends_at IS NOT NULL AND b.trial_ends_at <= datetime('now')"
    )
      .bind(normaliseEmail(email))
      .first<{ id: string; name: string; ended: string }>();
    return row && isBusinessId(row.id) ? { businessId: row.id, name: row.name, endedAt: row.ended } : null;
  } catch (error) {
    if (missingTable(error) || missingColumn(error)) return null;
    throw error;
  }
}

// An email whose business can no longer be signed into, and why: its trial ended, a payment failed and its grace period is over, or its subscription was cancelled and the period it paid for is over. So a sign-in can say so.
export async function findEndedAccessForEmail(env: Env, email: string): Promise<{ businessId: string; name: string; endedAt: string; reason: "trial" | "payment" | "cancelled" } | null> {
  const trial = await findEndedTrialForEmail(env, email);
  if (trial) return { ...trial, reason: "trial" };
  try {
    const row = await env.OFFICE_DB.prepare(
      `SELECT b.id AS id, b.name AS name, b.billing_status AS billing_status, b.grace_until AS grace_until, b.period_end AS period_end FROM directory_members m JOIN businesses b ON b.id = m.business_id WHERE m.email = ? AND b.status = 'active' AND ${LAPSED_SQL} LIMIT 1`,
    )
      .bind(normaliseEmail(email))
      .first<{ id: string; name: string; billing_status: string; grace_until: string | null; period_end: string | null }>();
    if (!row || !isBusinessId(row.id)) return null;
    const payment = row.billing_status === "past_due";
    return { businessId: row.id, name: row.name, endedAt: (payment ? row.grace_until : row.period_end) ?? "", reason: payment ? "payment" : "cancelled" };
  } catch (error) {
    if (missingTable(error) || missingColumn(error)) return null;
    throw error;
  }
}

export interface DirectoryListing {
  businesses: { id: string; name: string; status: string; plan: string; members: number; trial_ends_at?: string | null; source?: string }[];
}

export async function listDirectory(env: Env): Promise<DirectoryListing> {
  try {
    const members = "(SELECT COUNT(*) FROM directory_members m WHERE m.business_id = b.id) AS members FROM businesses b ORDER BY b.created_at, b.id";
    type Row = { id: string; name: string; status: string; plan: string; members: number; trial_ends_at?: string | null; source?: string };
    try {
      const { results } = await env.OFFICE_DB.prepare(`SELECT b.id AS id, b.name AS name, b.status AS status, b.plan AS plan, b.trial_ends_at AS trial_ends_at, b.source AS source, ${members}`).all<Row>();
      return { businesses: results ?? [] };
    } catch (error) {
      if (!missingColumn(error)) throw error;
      const { results } = await env.OFFICE_DB.prepare(`SELECT b.id AS id, b.name AS name, b.status AS status, b.plan AS plan, ${members}`).all<Row>();
      return { businesses: results ?? [] };
    }
  } catch (error) {
    if (missingTable(error)) return { businesses: [] };
    throw error;
  }
}

export async function createBusiness(env: Env, id: string, name: string, plan = "standard", options: { status?: string; trialEndsAt?: string | null; source?: string } = {}): Promise<{ created: boolean }> {
  if (!isBusinessId(id)) throw new Error("a business id is 3 to 40 lower-case letters, digits and hyphens, not starting or ending with a hyphen");
  if (!name.trim()) throw new Error("a business needs a name");
  await ensureDirectory(env);
  const existing = await env.OFFICE_DB.prepare("SELECT id FROM businesses WHERE id = ?").bind(id).first();
  if (existing) return { created: false };
  await env.OFFICE_DB.prepare("INSERT INTO businesses (id, name, plan, status, trial_ends_at, source) VALUES (?, ?, ?, ?, ?, ?)").bind(id, name.trim(), plan, options.status ?? "active", options.trialEndsAt ?? null, options.source ?? "admin").run();
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
    // An address bound only to a CLOSED business (the empty-business handover closed it) is free: it MOVES, so it is still in exactly one business.
    const old = await env.OFFICE_DB.prepare("SELECT status FROM businesses WHERE id = ?").bind(existing.business_id).first<{ status: string }>();
    if (old?.status !== "closed") throw new Error("that email already belongs to another business");
    await env.OFFICE_DB.prepare("UPDATE directory_members SET business_id = ? WHERE email = ?").bind(businessId, address).run();
    return { added: true };
  }
  await env.OFFICE_DB.prepare("INSERT INTO directory_members (email, business_id) VALUES (?, ?)").bind(address, businessId).run();
  return { added: true };
}

// Before a migration copies anything: which of these team emails already belong to a DIFFERENT business? (An email is never moved between businesses, so the migration must find out first,
// not after everything has been copied. Found on the first real rehearsal, which copied everything and then stopped at the directory.)
export async function findDirectoryConflicts(env: Env, emails: string[], businessId: string): Promise<{ email: string; business_id: string }[]> {
  const conflicts: { email: string; business_id: string }[] = [];
  try {
    for (const raw of emails) {
      const email = normaliseEmail(raw);
      // A CLOSED business (the empty-business handover) conflicts with nothing: its owner has moved on.
      const row = await env.OFFICE_DB.prepare("SELECT m.business_id AS business_id FROM directory_members m LEFT JOIN businesses b ON b.id = m.business_id WHERE m.email = ? AND COALESCE(b.status, '') != 'closed'").bind(email).first<{ business_id: string }>();
      if (row && row.business_id !== businessId) conflicts.push({ email, business_id: row.business_id });
    }
    return conflicts;
  } catch (error) {
    if (missingTable(error)) return [];
    throw error;
  }
}

// ---- invitations --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
export const INVITATION_DAYS = 30;
export interface Invitation { id: number; email: string; businessId: string; role: string; invitedBy: string | null; createdAt: string; expiresAt: string; personName: string | null }
type InvitationRow = { id: number; email: string; business_id: string; role: string; invited_by: string | null; created_at: string; expires_at: string; business_name?: string; trial_ends_at?: string | null; person_name?: string | null };
const toInvitation = (r: InvitationRow): Invitation => ({ id: r.id, email: r.email, businessId: r.business_id, role: r.role, invitedBy: r.invited_by, createdAt: r.created_at, expiresAt: r.expires_at, personName: r.person_name ?? null });

// Invite an address to a business, or REFRESH the invitation it already has (a new role, a new 30 days, pending again).
export async function upsertInvitation(env: Env, email: string, businessId: string, role: string, invitedBy: string | null, personName: string | null = null): Promise<{ id: number; created: boolean }> {
  if (!isBusinessId(businessId)) throw new Error("not a valid business id");
  const address = normaliseEmail(email);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) throw new Error("not a valid email address");
  await ensureDirectory(env);
  const existing = await env.OFFICE_DB.prepare("SELECT id FROM invitations WHERE email = ? AND business_id = ?").bind(address, businessId).first<{ id: number }>();
  if (existing) {
    await env.OFFICE_DB.prepare(`UPDATE invitations SET role = ?, invited_by = ?, person_name = ?, status = 'pending', created_at = datetime('now'), expires_at = datetime('now', '+${INVITATION_DAYS} days') WHERE id = ?`).bind(role, invitedBy, personName, existing.id).run();
    return { id: existing.id, created: false };
  }
  const row = await env.OFFICE_DB.prepare(`INSERT INTO invitations (email, business_id, role, invited_by, person_name, expires_at) VALUES (?, ?, ?, ?, ?, datetime('now', '+${INVITATION_DAYS} days')) RETURNING id`).bind(address, businessId, role, invitedBy, personName).first<{ id: number }>();
  return { id: (row as { id: number }).id, created: true };
}

// A business's own PENDING, unexpired invitations (what its owner sees and can revoke). Tolerates a directory that predates the person_name column (a read can happen before any write adds it).
export async function listInvitationsFor(env: Env, businessId: string): Promise<Invitation[]> {
  const run = async (columns: string) => ((await env.OFFICE_DB.prepare(`SELECT ${columns} FROM invitations WHERE business_id = ? AND status = 'pending' AND expires_at > datetime('now') ORDER BY id`).bind(businessId).all<InvitationRow>()).results ?? []).map(toInvitation);
  try {
    try {
      return await run("id, email, business_id, role, invited_by, created_at, expires_at, person_name");
    } catch (error) {
      if (!missingColumn(error)) throw error;
      return await run("id, email, business_id, role, invited_by, created_at, expires_at");
    }
  } catch (error) {
    if (missingTable(error)) return [];
    throw error;
  }
}

// What an ADDRESS may accept right now: pending, unexpired, and for a business that is active and not past its trial. Carries the business's name (to show), trial end (for the session) and the name the owner gave the person (so
// accepting makes or links their person record). Joining is only ever offered through this. Tolerates a directory that predates the trial columns AND the person_name column.
export async function pendingInvitationsForEmail(env: Env, email: string): Promise<Array<Invitation & { businessName: string; trialEndsAt: string | null }>> {
  const attempt = async (withPerson: boolean) => {
    const base = `SELECT i.id AS id, i.email AS email, i.business_id AS business_id, i.role AS role, i.invited_by AS invited_by, i.created_at AS created_at, i.expires_at AS expires_at, b.name AS business_name${withPerson ? ", i.person_name AS person_name" : ""}`;
    const from = " FROM invitations i JOIN businesses b ON b.id = i.business_id WHERE i.email = ? AND i.status = 'pending' AND i.expires_at > datetime('now') AND b.status = 'active'";
    const run = async (sql: string) => (await env.OFFICE_DB.prepare(sql).bind(normaliseEmail(email)).all<InvitationRow>()).results ?? [];
    let rows: InvitationRow[];
    try {
      rows = await run(`${base}, b.trial_ends_at AS trial_ends_at${from} AND (b.trial_ends_at IS NULL OR b.trial_ends_at > datetime('now')) ORDER BY i.id`);
    } catch (error) {
      if (!missingColumn(error)) throw error;
      rows = await run(`${base}${from} ORDER BY i.id`);   // the directory predates trials
    }
    return rows.map((r) => ({ ...toInvitation(r), businessName: r.business_name ?? "", trialEndsAt: r.trial_ends_at ?? null }));
  };
  try {
    try {
      return await attempt(true);
    } catch (error) {
      if (!missingColumn(error)) throw error;
      return await attempt(false);   // the directory predates person_name
    }
  } catch (error) {
    if (missingTable(error)) return [];
    throw error;
  }
}

// Revoke one of THIS business's pending invitations. Another business's invitation looks like it does not exist.
export async function revokeInvitation(env: Env, businessId: string, id: number): Promise<boolean> {
  const row = await env.OFFICE_DB.prepare("SELECT id FROM invitations WHERE id = ? AND business_id = ? AND status = 'pending'").bind(id, businessId).first<{ id: number }>();
  if (!row) return false;
  await env.OFFICE_DB.prepare("UPDATE invitations SET status = 'revoked' WHERE id = ?").bind(id).run();
  return true;
}

export async function acceptInvitation(env: Env, id: number): Promise<void> {
  await env.OFFICE_DB.prepare("UPDATE invitations SET status = 'accepted' WHERE id = ?").bind(id).run();
}

// ---- the empty-business handover (signup.ts) ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// How many addresses are bound to a business (the handover needs exactly one: the person leaving it).
export async function countDirectoryMembers(env: Env, businessId: string): Promise<number> {
  try {
    return Number((await env.OFFICE_DB.prepare("SELECT COUNT(*) AS n FROM directory_members WHERE business_id = ?").bind(businessId).first<{ n: number }>())?.n ?? 0);
  } catch (error) {
    if (missingTable(error)) return 0;
    throw error;
  }
}

// CLOSE a business that a person started from the app and has now left for another (never deletes: the business is verified empty first, and it is marked closed with where its owner went). Only an ACTIVE, self-started business can be
// closed this way: an operator's business never is.
export async function closeBusiness(env: Env, businessId: string, into: string): Promise<void> {
  await ensureDirectory(env);
  await env.OFFICE_DB.prepare("UPDATE businesses SET status = 'closed', closed_into = ? WHERE id = ? AND source = 'signup' AND status = 'active'").bind(into, businessId).run();
}

// An invitation the person chose NOT to take ("keep my own business"): only THEIR OWN pending invitation, so they are not asked again.
export async function declineInvitation(env: Env, id: number, email: string): Promise<void> {
  await env.OFFICE_DB.prepare("UPDATE invitations SET status = 'declined' WHERE id = ? AND email = ? AND status = 'pending'").bind(id, normaliseEmail(email)).run();
}

