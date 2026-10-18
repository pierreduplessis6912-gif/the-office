// An owner managing their own team from the app (SHIP_CHECKLIST.md item 15; decided with Pierre 2026-10-17). Until now only an operator, by workflow, could add a person. An owner adds people by email and role; the person signs in with
// that Google account and lands in the business. Runs INSIDE the business's own object (its memberships) and reaches the shared directory (which email belongs to which business) through SHARED_DB.
//
// Adding a person is a SIGN-IN GRANT, so: an address that belongs to ANOTHER business is refused (one email, one business; the refusal never says which); the roles an owner may give are fixed here; and the protections that keep a business
// from losing its owner are structural: an owner is never changed, deactivated or reactivated through the app (only the operator can), nobody changes or deactivates themselves, and so a co-owner can never lock the first owner out.
// The directory and the business cannot share a transaction, so the order is: check, write the membership, write the directory entry; a retry finishes a half-done add (it never leaves a stuck state). No cap on the team (Pierre).
// Both ways to add someone exist: directly (here) and by invitation the person accepts (below). The roles are those in ROLE_CAPABILITIES except that no role outside this list can be given.
import { addDirectoryMember, findDirectoryConflicts, listInvitationsFor, normaliseEmail, revokeInvitation, upsertInvitation, type Invitation } from "./directory";
import { listTeamActivity, readSignIns, recordTeamEvent, type TeamEvent } from "./team-log";
import type { Env } from "./types";

export const ASSIGNABLE_ROLES = ["owner", "admin", "accountant", "sales", "installer"];
const EMAIL_OK = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export type TeamMember = { id: number; email: string; role: string; status: string; invitedBy: string | null; createdAt: string };
type Row = { id: number; google_email: string; role: string; status: string; invited_by: string | null; created_at: string };
type Failed = { ok: false; error: string; status: number };

const fail = (status: number, error: string): Failed => ({ ok: false, error, status });
const toMember = (r: Row): TeamMember => ({ id: r.id, email: r.google_email, role: r.role, status: r.status, invitedBy: r.invited_by, createdAt: r.created_at });
const shared = (env: Env): Env => ({ ...env, OFFICE_DB: (env.SHARED_DB ?? env.OFFICE_DB) as D1Database });
const COLUMNS = "id, google_email, role, status, invited_by, created_at";

function validEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const address = normaliseEmail(raw);
  return address.length <= 254 && address.split("@")[0].length <= 64 && EMAIL_OK.test(address) ? address : null;
}
const validRole = (raw: unknown): string | null => (typeof raw === "string" && ASSIGNABLE_ROLES.includes(raw) ? raw : null);
const validId = (raw: unknown): number | null => {
  const n = typeof raw === "number" ? raw : typeof raw === "string" && /^\d{1,9}$/.test(raw) ? Number(raw) : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
};

export async function listTeam(env: Env): Promise<{ members: TeamMember[]; invitations: Invitation[]; activity: TeamEvent[]; roles: string[] }> {
  const { results } = await env.OFFICE_DB.prepare(`SELECT ${COLUMNS} FROM memberships ORDER BY id`).all<Row>();
  const stamps = await readSignIns(env);
  const activity = await listTeamActivity(env, 30);
  let invitations: Invitation[] = [];
  try { if (env.BUSINESS_ID) invitations = await listInvitationsFor(shared(env), env.BUSINESS_ID); } catch { /* the directory could not be read: the members still show */ }
  // "Never signed in" is lastSignInAt null: someone added who has not signed in once is what an owner needs to notice (a mistyped address). It is the last GOOGLE SIGN-IN (a session lasts 30 days), not "last seen".
  const members = (results ?? []).map((row) => {
    const stamp = stamps.get(normaliseEmail(row.google_email));
    return { ...toMember(row), firstSignInAt: stamp?.firstAt ?? null, lastSignInAt: stamp?.lastAt ?? null, signInCount: stamp?.count ?? 0 };
  });
  return { members, invitations, activity, roles: ASSIGNABLE_ROLES };
}

// An INVITATION: nothing about the team changes until the person signs in with that Google account and accepts (signup.ts handleJoinPost). It waits in the shared directory for 30 days, an owner can revoke it, and inviting the same
// person again refreshes the one invitation. The same refusals as adding directly: already on the team, or an address that belongs to another business (never named).
export async function inviteTeamMember(env: Env, actorEmail: string, rawEmail: unknown, rawRole: unknown): Promise<{ ok: true; status: number; invitation: Invitation } | Failed> {
  const businessId = env.BUSINESS_ID;
  if (!businessId) return fail(500, "Team changes can only be made inside a business.");
  const email = validEmail(rawEmail);
  if (!email) return fail(400, "Send a valid email address: the Google account they will sign in with.");
  const role = validRole(rawRole);
  if (!role) return fail(400, `The role must be one of: ${ASSIGNABLE_ROLES.join(", ")}.`);
  try {
    const existing = await env.OFFICE_DB.prepare(`SELECT ${COLUMNS} FROM memberships WHERE google_email = ?`).bind(email).first<Row>();
    if (existing) return existing.status === "active" ? fail(409, `${email} is already on your team (as ${existing.role}).`) : fail(409, `${email} is already on your team but deactivated: reactivate them instead.`);
    // NEUTRAL on purpose: an address in another business is invited exactly like any other, and the owner learns nothing about it either way. (Refusing it used to reveal that the person already has an account.) The invitation is only
    // ever shown to someone with no business, or to an employee in their own EMPTY self-started trial business, who may then choose to join (signup.ts); for anyone else it just waits and expires.
    const { id, created } = await upsertInvitation(shared(env), email, businessId, role, actorEmail || null);
    const invitation = (await listInvitationsFor(shared(env), businessId)).find((i) => i.id === id);
    await recordTeamEvent(env, actorEmail, "invited", email, { role, refreshed: !created });
    return { ok: true, status: created ? 201 : 200, invitation: invitation as Invitation };
  } catch {
    return fail(500, "We could not send the invitation just now. Please try again in a minute.");
  }
}

export async function revokeTeamInvitation(env: Env, actorEmail: string, rawId: unknown): Promise<{ ok: true; status: number } | Failed> {
  const businessId = env.BUSINESS_ID;
  if (!businessId) return fail(500, "Team changes can only be made inside a business.");
  const id = validId(rawId);
  if (id === null) return fail(400, "Send a valid invitation.");
  try {
    const waiting = (await listInvitationsFor(shared(env), businessId)).find((i) => i.id === id);   // so the log can say WHO it was, not an id
    if (!(await revokeInvitation(shared(env), businessId, id))) return fail(404, "There is no such pending invitation.");
    await recordTeamEvent(env, actorEmail, "invitation_withdrawn", waiting?.email ?? null, { role: waiting?.role ?? null });
    return { ok: true, status: 200 };
  } catch {
    return fail(500, "We could not revoke that just now. Please try again in a minute.");
  }
}

export async function addTeamMember(env: Env, actorEmail: string, rawEmail: unknown, rawRole: unknown): Promise<{ ok: true; status: number; member: TeamMember; healed?: boolean } | Failed> {
  const businessId = env.BUSINESS_ID;
  if (!businessId) return fail(500, "Team changes can only be made inside a business.");
  const email = validEmail(rawEmail);
  if (!email) return fail(400, "Send a valid email address: the Google account they will sign in with.");
  const role = validRole(rawRole);
  if (!role) return fail(400, `The role must be one of: ${ASSIGNABLE_ROLES.join(", ")}.`);
  try {
    const existing = await env.OFFICE_DB.prepare(`SELECT ${COLUMNS} FROM memberships WHERE google_email = ?`).bind(email).first<Row>();
    if (existing) {
      // Already on the team. If an earlier add stopped before the directory was written, finish it now (so they can sign in); that is a success, not an error.
      let added = false;
      try { added = (await addDirectoryMember(shared(env), email, businessId)).added; } catch { /* the directory says no or is unreachable: the answer below still stands */ }
      if (added && existing.status === "active") return { ok: true, status: 200, member: toMember(existing), healed: true };
      return existing.status === "active" ? fail(409, `${email} is already on your team (as ${existing.role}).`) : fail(409, `${email} is already on your team but deactivated: reactivate them instead.`);
    }
    if ((await findDirectoryConflicts(shared(env), [email], businessId)).length > 0) return fail(409, "That email address already belongs to another business. Ask them to sign in with a different Google account, or send them an invitation instead.");
    await env.OFFICE_DB.prepare("INSERT INTO memberships (google_email, role, status, invited_by) VALUES (?, ?, 'active', ?)").bind(email, role, actorEmail || null).run();
    try {
      await addDirectoryMember(shared(env), email, businessId);
    } catch {
      return fail(500, "We could not finish adding them. Nothing is lost: please try again in a minute.");   // the membership exists; the same add, repeated, completes it
    }
    const row = await env.OFFICE_DB.prepare(`SELECT ${COLUMNS} FROM memberships WHERE google_email = ?`).bind(email).first<Row>();
    await recordTeamEvent(env, actorEmail, "added", email, { role });
    return { ok: true, status: 201, member: toMember(row as Row) };
  } catch {
    return fail(500, "We could not add them just now. Please try again in a minute.");
  }
}

async function guardedTarget(env: Env, actorEmail: string, rawId: unknown, verb: string): Promise<{ ok: true; row: Row } | Failed> {
  const id = validId(rawId);
  if (id === null) return fail(400, "Send a valid member.");
  const row = await env.OFFICE_DB.prepare(`SELECT ${COLUMNS} FROM memberships WHERE id = ?`).bind(id).first<Row>();
  if (!row) return fail(404, "There is no such member on your team.");
  if (row.google_email === normaliseEmail(actorEmail || "")) return fail(403, `You cannot ${verb} your own membership.`);
  if (row.role === "owner") return fail(403, "An owner can only be changed by the operator, never through the app: that is what stops a business losing its owner.");
  return { ok: true, row };
}

export async function changeTeamRole(env: Env, actorEmail: string, rawId: unknown, rawRole: unknown): Promise<{ ok: true; status: number; member: TeamMember } | Failed> {
  if (validId(rawId) === null) return fail(400, "Send a valid member.");
  const role = validRole(rawRole);
  if (!role) return fail(400, `The role must be one of: ${ASSIGNABLE_ROLES.join(", ")}.`);
  const target = await guardedTarget(env, actorEmail, rawId, "change");
  if (!target.ok) return target;
  if (target.row.role === role) return { ok: true, status: 200, member: toMember(target.row) };   // nothing changes, so nothing is logged
  await env.OFFICE_DB.prepare("UPDATE memberships SET role = ? WHERE id = ?").bind(role, target.row.id).run();
  await recordTeamEvent(env, actorEmail, "role_changed", target.row.google_email, { from: target.row.role, to: role });
  return { ok: true, status: 200, member: toMember({ ...target.row, role }) };
}

export async function setTeamMemberStatus(env: Env, actorEmail: string, rawId: unknown, active: boolean): Promise<{ ok: true; status: number; member: TeamMember } | Failed> {
  const target = await guardedTarget(env, actorEmail, rawId, active ? "reactivate" : "deactivate");
  if (!target.ok) return target;
  const status = active ? "active" : "inactive";
  if (target.row.status === status) return { ok: true, status: 200, member: toMember(target.row) };   // already so: nothing is logged
  await env.OFFICE_DB.prepare("UPDATE memberships SET status = ? WHERE id = ?").bind(status, target.row.id).run();
  await recordTeamEvent(env, actorEmail, active ? "reactivated" : "deactivated", target.row.google_email, {});
  return { ok: true, status: 200, member: toMember({ ...target.row, status }) };
}
