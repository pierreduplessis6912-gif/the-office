// A person for every login. The app already keeps PEOPLE (`characters`: the Sipho that dictation talks about) and already ties a login to one (`memberships.character_id`), but only an operator route could set the link, so an installer added
// through the Team screen had no person and the installer's "only my jobs" query (installer_id = NULL) matched NOTHING: they saw no jobs at all. Now every add or invitation carries a first name and surname, which becomes (or is linked to)
// that person; the owner can then keep a small PROFILE for them (nickname, phone, strengths).
// The rules, each pinned in tools/team-people.test.js: EXACT names only (ignoring case and spacing), the rule the imports already follow and never the loose matching that serves dictation; only TEAM-type people (installer,
// subcontractor, employee, staff) are ever linked, never a customer or supplier who happens to share the name; a person already tied to another login is never taken (one person, one login); two matches refuse rather than guess.
// The profile is a FIXED, work-related set stored as facts about the person (memory.ts: operational facts only; medical, disciplinary and banking details are regulated under POPIA and are not part of this), and a write REPLACES the
// previous value, because facts are an append-only log and every row is fed back into the AI's context: an update that only appended would leave old phone numbers there.
import { normaliseEmail } from "./directory";
import type { Env } from "./types";

export const TEAM_RELATIONSHIPS = ["installer", "subcontractor", "employee", "staff"];
export const relationshipForRole = (role: string): string => (role === "installer" ? "installer" : "staff");

// ---- the name -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
const NAME_PART = /^\p{L}[\p{L} .'’–-]*$/u;
export function parsePersonName(first: unknown, surname: unknown): { ok: true; full: string } | { ok: false; error: string } {
  const bad = { ok: false as const, error: "Add their first name and surname (letters only, as they write them)." };
  if (typeof first !== "string" || typeof surname !== "string") return bad;
  const tidy = (s: string): string => s.trim().replace(/ {2,}/g, " ");
  const a = tidy(first), b = tidy(surname);
  if (!a || !b || a.length > 60 || b.length > 60) return bad;
  if (/[\u0000-\u001f\u007f]/.test(a + b) || !NAME_PART.test(a) || !NAME_PART.test(b)) return bad;
  return { ok: true, full: `${a} ${b}` };
}

// A name that was already tidied and checked when an owner typed it (it travels with an invitation), checked again where it is used.
export function validFullName(name: unknown): name is string {
  return typeof name === "string" && name.length > 0 && name.length <= 121 && !/ {2}/.test(name) && !/[\u0000-\u001f\u007f]/.test(name) && name.split(" ").every((part) => part.length > 0 && NAME_PART.test(part));
}

// ---- linking or creating ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
export type PersonResult = { ok: true; characterId: number; created: boolean } | { ok: false; status: 409; error: string };

// Finds the team person with exactly this name for this login, or creates one. Writes only the new person (never the membership: the caller does that, so a refusal leaves nothing behind, and an add that stops after creating the person
// and is retried simply finds it again).
export async function ensureTeamPerson(env: Env, rawName: string, role: string, email: string): Promise<PersonResult> {
  const full = rawName.trim().replace(/\s+/g, " ");   // tidied here as well, so this never depends on the caller having done it
  const login = normaliseEmail(email);
  const marks = TEAM_RELATIONSHIPS.map(() => "?").join(", ");
  const { results } = await env.OFFICE_DB.prepare(`SELECT id FROM characters WHERE lower(trim(name)) = lower(?) AND merged_into_character_id IS NULL AND relationship IN (${marks}) ORDER BY id`)
    .bind(full, ...TEAM_RELATIONSHIPS)
    .all<{ id: number }>();
  const found = results ?? [];
  if (found.length > 1) return { ok: false, status: 409, error: "Two people on your team already have that name. Merge them first, or add a middle initial to tell them apart." };
  if (found.length === 1) {
    const tied = await env.OFFICE_DB.prepare("SELECT google_email FROM memberships WHERE character_id = ? LIMIT 1").bind(found[0].id).first<{ google_email: string }>();
    if (tied && normaliseEmail(tied.google_email) !== login) return { ok: false, status: 409, error: "That person is already linked to another login on your team." };
    return { ok: true, characterId: found[0].id, created: false };
  }
  const row = await env.OFFICE_DB.prepare("INSERT INTO characters (name, relationship) VALUES (?, ?) RETURNING id").bind(full, relationshipForRole(role)).first<{ id: number }>();
  return { ok: true, characterId: (row as { id: number }).id, created: true };
}

// ---- the profile -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
export const PROFILE_FIELDS = ["nickname", "phone", "strengths"] as const;
export type ProfileField = (typeof PROFILE_FIELDS)[number];
export interface PersonProfile { id: number; name: string; nickname: string | null; phone: string | null; strengths: string | null }

const LIMITS: Record<ProfileField, number> = { nickname: 40, phone: 25, strengths: 300 };
const LABELS: Record<ProfileField, string> = { nickname: "The nickname", phone: "The phone number", strengths: "The strengths" };

// A field that is sent is set (a blank or null CLEARS it); a field not sent is left alone; anything that is not one of the three is ignored. Line breaks and runs of spaces collapse, so a value can never break out of the "key: value" line
// the AI is shown.
export function parseProfile(body: unknown): { ok: true; set: Partial<Record<ProfileField, string | null>> } | { ok: false; error: string } {
  const set: Partial<Record<ProfileField, string | null>> = {};
  if (!body || typeof body !== "object") return { ok: true, set };
  const input = body as Record<string, unknown>;
  for (const field of PROFILE_FIELDS) {
    if (!(field in input)) continue;
    const raw = input[field];
    if (raw === null || raw === undefined) { set[field] = null; continue; }
    if (typeof raw !== "string") return { ok: false, error: `${LABELS[field]} must be text.` };
    const value = raw.replace(/\s+/g, " ").trim();
    if (!value) { set[field] = null; continue; }
    if (value.length > LIMITS[field]) return { ok: false, error: `${LABELS[field]} is too long (at most ${LIMITS[field]} characters).` };
    if (field === "phone" && (!/^[0-9+().\s-]+$/.test(value) || value.replace(/\D/g, "").length < 7)) return { ok: false, error: "The phone number must be digits (with + ( ) - . or spaces), at least 7 of them." };
    set[field] = value;
  }
  return { ok: true, set };
}

// REPLACES: the new value goes in first and every older row of that key goes after it (a failure between the two leaves a harmless duplicate, never a lost value); null removes the field. Other facts about the person (a licence
// somebody dictated) are never touched.
export async function writeProfile(env: Env, characterId: number, set: Partial<Record<ProfileField, string | null>>): Promise<void> {
  for (const field of PROFILE_FIELDS) {
    if (!(field in set)) continue;
    const value = set[field];
    if (value === null || value === undefined) {
      await env.OFFICE_DB.prepare("DELETE FROM character_facts WHERE character_id = ? AND key = ?").bind(characterId, field).run();
      continue;
    }
    const row = await env.OFFICE_DB.prepare("INSERT INTO character_facts (character_id, key, value, source_transcript) VALUES (?, ?, ?, 'team profile') RETURNING id").bind(characterId, field, value).first<{ id: number }>();
    await env.OFFICE_DB.prepare("DELETE FROM character_facts WHERE character_id = ? AND key = ? AND id != ?").bind(characterId, field, (row as { id: number }).id).run();
  }
}

// Many people at once (the team list). The latest row of each field wins, so a legacy duplicate reads as one value.
export async function readProfiles(env: Env, characterIds: number[]): Promise<Map<number, PersonProfile>> {
  const out = new Map<number, PersonProfile>();
  const ids = [...new Set(characterIds.filter((n) => Number.isInteger(n)))];
  if (ids.length === 0) return out;
  const marks = ids.map(() => "?").join(", ");
  const people = await env.OFFICE_DB.prepare(`SELECT id, name FROM characters WHERE id IN (${marks})`).bind(...ids).all<{ id: number; name: string }>();
  for (const p of people.results ?? []) out.set(p.id, { id: p.id, name: p.name, nickname: null, phone: null, strengths: null });
  const facts = await env.OFFICE_DB.prepare(`SELECT character_id, key, value FROM character_facts WHERE character_id IN (${marks}) AND key IN ('nickname', 'phone', 'strengths') ORDER BY id ASC`).bind(...ids).all<{ character_id: number; key: ProfileField; value: string }>();
  for (const f of facts.results ?? []) {
    const person = out.get(f.character_id);
    if (person) person[f.key] = f.value;
  }
  return out;
}
