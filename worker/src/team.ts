// An owner managing their own team from the app (SHIP_CHECKLIST.md item 15; decided with Pierre 2026-10-17). Until now only an operator, by workflow, could add a person. An owner adds people by email and role; the person signs in with
// that Google account and lands in the business. Runs INSIDE the business's own object (its memberships) and reaches the shared directory (which email belongs to which business) through SHARED_DB.
//
// Adding a person is a SIGN-IN GRANT, so: an address that belongs to ANOTHER business is refused (one email, one business; the refusal never says which); the roles an owner may give are fixed here; and the protections that keep a business
// from losing its owner are structural: an owner is never changed, deactivated or reactivated through the app (only the operator can), nobody changes or deactivates themselves, and so a co-owner can never lock the first owner out.
// The directory and the business cannot share a transaction, so the order is: check, write the membership, write the directory entry; a retry finishes a half-done add (it never leaves a stuck state). No cap on the team (Pierre).
// Both ways to add someone exist: directly (here) and by invitation the person accepts (below). The roles are those in ROLE_CAPABILITIES except that no role outside this list can be given.
import { addDirectoryMember, findDirectoryConflicts, listInvitationsFor, normaliseEmail, revokeInvitation, upsertInvitation, type Invitation } from "./directory";
import { listTeamActivity, readSignIns, recordTeamEvent, type TeamEvent } from "./team-log";
import { checkSeat } from "./seats";
import { ensureTeamPerson, parsePersonName, parseProfile, readProfiles, writeProfile, TEAM_RELATIONSHIPS, type PersonProfile } from "./team-people";
import type { Env } from "./types";

export const ASSIGNABLE_ROLES = ["owner", "admin", "accountant", "sales", "installer"];
const EMAIL_OK = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export type TeamMember = { id: number; email: string; role: string; status: string; invitedBy: string | null; createdAt: string; characterId: number | null };
type Row = { id: number; google_email: string; role: string; status: string; invited_by: string | null; created_at: string; character_id: number | null };
type Failed = { ok: false; error: string; status: number };

const fail = (status: number, error: string): Failed => ({ ok: false, error, status });
const toMember = (r: Row): TeamMember => ({ id: r.id, email: r.google_email, role: r.role, status: r.status, invitedBy: r.invited_by, createdAt: r.created_at, characterId: r.character_id ?? null });
// The name for an add or an invitation: {firstName, surname} from the request body.
function personFrom(raw: unknown): ReturnType<typeof parsePersonName> {
  const body = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return parsePersonName(body.firstName, body.surname);
}

const shared = (env: Env): Env => ({ ...env, OFFICE_DB: (env.SHARED_DB ?? env.OFFICE_DB) as D1Database });
const COLUMNS = "id, google_email, role, status, invited_by, created_at, character_id";

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

export async function listTeam(env: Env): Promise<{ members: Array<TeamMember & { firstSignInAt: string | null; lastSignInAt: string | null; signInCount: number; person: PersonProfile | null }>; invitations: Invitation[]; activity: Array<TeamEvent & { actorName: string | null; targetName: string | null }>; roles: string[] }> {
  const { results } = await env.OFFICE_DB.prepare(`SELECT ${COLUMNS} FROM memberships ORDER BY id`).all<Row>();
  const stamps = await readSignIns(env);
  const activity = await listTeamActivity(env, 30);
  let invitations: Invitation[] = [];
  try { if (env.BUSINESS_ID) invitations = await listInvitationsFor(shared(env), env.BUSINESS_ID); } catch { /* the directory could not be read: the members still show */ }
  // "Never signed in" is lastSignInAt null: someone added who has not signed in once is what an owner needs to notice (a mistyped address). It is the last GOOGLE SIGN-IN (a session lasts 30 days), not "last seen".
  // Each member is a LOGIN that may be tied to a PERSON (name, nickname, phone, strengths). `person: null` means no name has been given yet: for an installer that also means they cannot see any job, because their jobs are found through the person.
  let profiles = new Map<number, PersonProfile>();
  try { profiles = await readProfiles(env, (results ?? []).map((r) => r.character_id).filter((n): n is number => typeof n === "number")); } catch { /* the people could not be read: the members still show */ }
  const members = (results ?? []).map((row) => {
    const stamp = stamps.get(normaliseEmail(row.google_email));
    return { ...toMember(row), firstSignInAt: stamp?.firstAt ?? null, lastSignInAt: stamp?.lastAt ?? null, signInCount: stamp?.count ?? 0, person: (row.character_id !== null && row.character_id !== undefined ? profiles.get(row.character_id) : undefined) ?? null };
  });
  const nameOf = new Map(members.filter((m) => m.person).map((m) => [normaliseEmail(m.email), (m.person as PersonProfile).name]));
  const named = activity.map((a) => ({ ...a, actorName: a.actor ? nameOf.get(normaliseEmail(a.actor)) ?? null : null, targetName: a.target ? nameOf.get(normaliseEmail(a.target)) ?? null : null }));
  return { members, invitations, activity: named, roles: ASSIGNABLE_ROLES };
}

// An INVITATION: nothing about the team changes until the person signs in with that Google account and accepts (signup.ts handleJoinPost). It waits in the shared directory for 30 days, an owner can revoke it, and inviting the same
// person again refreshes the one invitation. The same refusals as adding directly: already on the team, or an address that belongs to another business (never named).
export async function inviteTeamMember(env: Env, actorEmail: string, rawEmail: unknown, rawRole: unknown, rawPerson?: unknown): Promise<{ ok: true; status: number; invitation: Invitation } | Failed> {
  const businessId = env.BUSINESS_ID;
  if (!businessId) return fail(500, "Team changes can only be made inside a business.");
  const email = validEmail(rawEmail);
  if (!email) return fail(400, "Send a valid email address: the Google account they will sign in with.");
  const role = validRole(rawRole);
  if (!role) return fail(400, `The role must be one of: ${ASSIGNABLE_ROLES.join(", ")}.`);
  const name = personFrom(rawPerson);   // every invitation names the person: they are made or linked as a person when they accept
  if (!name.ok) return fail(400, name.error);
  try {
    const existing = await env.OFFICE_DB.prepare(`SELECT ${COLUMNS} FROM memberships WHERE google_email = ?`).bind(email).first<Row>();
    if (existing) return existing.status === "active" ? fail(409, `${email} is already on your team (as ${existing.role}).`) : fail(409, `${email} is already on your team but deactivated: reactivate them instead.`);
    // NEUTRAL on purpose: an address in another business is invited exactly like any other, and the owner learns nothing about it either way. (Refusing it used to reveal that the person already has an account.) The invitation is only
    // ever shown to someone with no business, or to an employee in their own EMPTY self-started trial business, who may then choose to join (signup.ts); for anyone else it just waits and expires.
    const seat = await checkSeat(env, { adding: 1, ignoreInvitationFor: email });   // a waiting invitation uses a seat; inviting the SAME address again does not use another
    if (!seat.ok) return fail(seat.status, seat.error);
    const { id, created } = await upsertInvitation(shared(env), email, businessId, role, actorEmail || null, name.full);
    const invitation = (await listInvitationsFor(shared(env), businessId)).find((i) => i.id === id);
    await recordTeamEvent(env, actorEmail, "invited", email, { role, name: name.full, refreshed: !created });
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

export async function addTeamMember(env: Env, actorEmail: string, rawEmail: unknown, rawRole: unknown, rawPerson?: unknown): Promise<{ ok: true; status: number; member: TeamMember; healed?: boolean } | Failed> {
  const businessId = env.BUSINESS_ID;
  if (!businessId) return fail(500, "Team changes can only be made inside a business.");
  const email = validEmail(rawEmail);
  if (!email) return fail(400, "Send a valid email address: the Google account they will sign in with.");
  const role = validRole(rawRole);
  if (!role) return fail(400, `The role must be one of: ${ASSIGNABLE_ROLES.join(", ")}.`);
  const name = personFrom(rawPerson);   // a name is required: the login is tied to a person (an installer without one sees no jobs)
  if (!name.ok) return fail(400, name.error);
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
    // A plan with a seat limit (Single user, a Team or Enterprise plan's seats) refuses to add beyond it, before anything is written.
    const seat = await checkSeat(env, { adding: 1 });
    if (!seat.ok) return fail(seat.status, seat.error);
    // The person first (a refusal here leaves nothing behind; an add that stops after this is retried and finds the same person), then the membership WITH the link.
    const person = await ensureTeamPerson(env, name.full, role, email);
    if (!person.ok) return fail(person.status, person.error);
    await env.OFFICE_DB.prepare("INSERT INTO memberships (google_email, role, status, invited_by, character_id) VALUES (?, ?, 'active', ?, ?)").bind(email, role, actorEmail || null, person.characterId).run();
    try {
      await addDirectoryMember(shared(env), email, businessId);
    } catch {
      return fail(500, "We could not finish adding them. Nothing is lost: please try again in a minute.");   // the membership exists; the same add, repeated, completes it
    }
    const row = await env.OFFICE_DB.prepare(`SELECT ${COLUMNS} FROM memberships WHERE google_email = ?`).bind(email).first<Row>();
    await recordTeamEvent(env, actorEmail, "added", email, { role, name: name.full, linkedExisting: !person.created });
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
  if (active) {
    const seat = await checkSeat(env, { adding: 1 });   // bringing someone back uses a seat again
    if (!seat.ok) return fail(seat.status, seat.error);
  }
  await env.OFFICE_DB.prepare("UPDATE memberships SET status = ? WHERE id = ?").bind(status, target.row.id).run();
  await recordTeamEvent(env, actorEmail, active ? "reactivated" : "deactivated", target.row.google_email, {});
  return { ok: true, status: 200, member: toMember({ ...target.row, status }) };
}

// The owner updates a member's PERSON: first name and surname (both, or neither), and the profile: nickname, phone, strengths (a blank clears one; one not sent is left alone). Any member, including the owner and the owner themselves: this
// changes no access. Naming a member who has no person yet makes or links one (exact name, team people only, never one that is tied to another login); renaming renames the person everywhere (it is the same person), refused if someone
// else on the team already has that exact name. For an installer, giving a name is what makes their own jobs appear.
export async function updateTeamProfile(env: Env, actorEmail: string, rawId: unknown, rawBody: unknown): Promise<{ ok: true; status: number; member: TeamMember & { person: PersonProfile | null } } | Failed> {
  const id = validId(rawId);
  if (id === null) return fail(400, "Send a valid member.");
  const body = rawBody && typeof rawBody === "object" ? (rawBody as Record<string, unknown>) : {};
  const hasFirst = "firstName" in body, hasSurname = "surname" in body;
  if (hasFirst !== hasSurname) return fail(400, "Send both the first name and the surname, or neither.");
  const name = hasFirst ? parsePersonName(body.firstName, body.surname) : null;
  if (name && !name.ok) return fail(400, name.error);
  const profile = parseProfile(body);
  if (!profile.ok) return fail(400, profile.error);
  const fields = Object.keys(profile.set);
  if (!name && fields.length === 0) return fail(400, "There is nothing to change.");
  try {
    const row = await env.OFFICE_DB.prepare(`SELECT ${COLUMNS} FROM memberships WHERE id = ?`).bind(id).first<Row>();
    if (!row) return fail(404, "There is no such member on your team.");
    let characterId = row.character_id ?? null;
    if (name && name.ok) {
      if (characterId !== null) {
        const current = await env.OFFICE_DB.prepare("SELECT name FROM characters WHERE id = ?").bind(characterId).first<{ name: string }>();
        if (current && current.name.trim().toLowerCase() !== name.full.toLowerCase()) {
          const marks = TEAM_RELATIONSHIPS.map(() => "?").join(", ");
          const clash = await env.OFFICE_DB.prepare(`SELECT id FROM characters WHERE lower(trim(name)) = lower(?) AND id != ? AND merged_into_character_id IS NULL AND relationship IN (${marks}) LIMIT 1`).bind(name.full, characterId, ...TEAM_RELATIONSHIPS).first<{ id: number }>();
          if (clash) return fail(409, "Someone else on your team already has that name.");
          await env.OFFICE_DB.prepare("UPDATE characters SET name = ? WHERE id = ?").bind(name.full, characterId).run();
          await recordTeamEvent(env, actorEmail, "renamed", row.google_email, { from: current.name, to: name.full });
        }
      } else {
        const person = await ensureTeamPerson(env, name.full, row.role, row.google_email);
        if (!person.ok) return fail(person.status, person.error);
        await env.OFFICE_DB.prepare("UPDATE memberships SET character_id = ? WHERE id = ?").bind(person.characterId, row.id).run();
        characterId = person.characterId;
        await recordTeamEvent(env, actorEmail, "named", row.google_email, { name: name.full, linkedExisting: !person.created });
      }
    }
    if (fields.length > 0) {
      if (characterId === null) return fail(400, "Give them a first name and surname first.");
      await writeProfile(env, characterId, profile.set);
      await recordTeamEvent(env, actorEmail, "profile_updated", row.google_email, { fields });
    }
    const fresh = await env.OFFICE_DB.prepare(`SELECT ${COLUMNS} FROM memberships WHERE id = ?`).bind(id).first<Row>();
    const person = fresh && fresh.character_id !== null && fresh.character_id !== undefined ? (await readProfiles(env, [fresh.character_id])).get(fresh.character_id) ?? null : null;
    return { ok: true, status: 200, member: { ...toMember(fresh as Row), person } };
  } catch {
    return fail(500, "We could not save that just now. Please try again in a minute.");
  }
}

