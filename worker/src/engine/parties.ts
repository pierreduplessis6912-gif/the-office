// Customers and suppliers: what a party IS NOW. A party row (eng_party, eng_party_role) is a FACT and is never updated, so a change to a name, a role or a contact detail is a NEW fact: a party.revised event (facts.reviseParty).
// The current profile is derived here, by folding the party.created event's details and then each revision in the order it was recorded, so nothing is ever lost and the integrity verifier still compares the original rows with the
// event that created them. This file only READS; facts.ts is the one write path. The same rules (what a valid name, role or contact detail is, and what an edit may do) serve the capability contracts and the fact layer, so they cannot disagree.
import type { Env } from "../types";

export const PARTY_ROLES = ["customer", "supplier"] as const;
export type PartyRole = (typeof PARTY_ROLES)[number];
export interface Contact { email?: string; phone?: string; address?: string }
export const CONTACT_FIELDS = ["email", "phone", "address"] as const;
export interface PartyProfile { id: number; kind: string; name: string; roles: string[]; contact: Contact; revisionEventIds: number[] }
export interface Revision { name?: string; addRoles?: string[]; removeRoles?: string[]; contact?: Record<string, string | null> }

type Checked<T> = { ok: true; value: T } | { ok: false; reason: string };
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const many = async <T>(env: Env, sql: string, ...binds: unknown[]): Promise<T[]> => ((await env.OFFICE_DB.prepare(sql).bind(...binds).all<T>()).results ?? []);

// ---- validation (pure) -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------
export const squash = (s: string): string => s.trim().replace(/\s+/g, " ");
export const sameName = (a: string, b: string): boolean => squash(a).toLowerCase() === squash(b).toLowerCase();

export function checkName(v: unknown): Checked<string> {
  if (typeof v !== "string" || !squash(v)) return { ok: false, reason: "name must be text" };
  const n = squash(v);
  return n.length > 120 ? { ok: false, reason: "name must be at most 120 characters" } : { ok: true, value: n };
}
export function checkRoles(v: unknown, label: string, min: number): Checked<string[]> {
  if (!Array.isArray(v)) return { ok: false, reason: `${label} must be a list` };
  if (v.length < min) return { ok: false, reason: `${label} needs at least ${min}` };
  if (!v.every((r) => typeof r === "string" && (PARTY_ROLES as readonly string[]).includes(r))) return { ok: false, reason: `${label} may only be ${PARTY_ROLES.join(" or ")}` };
  if (new Set(v as string[]).size !== v.length) return { ok: false, reason: `${label} names the same role twice` };
  return { ok: true, value: v as string[] };
}
const CHECKS: Record<(typeof CONTACT_FIELDS)[number], (s: string) => string | null> = {
  email: (s) => (s.length <= 120 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? null : "email must look like name@example.com"),
  phone: (s) => (/^\+?[0-9][0-9 ()-]{3,28}[0-9]$/.test(s) ? null : "phone must be a phone number"),
  address: (s) => (s.length <= 300 ? null : "address must be at most 300 characters"),
};
// allowNull: an EDIT may clear a field (null); a CREATE may not.
export function checkContact(v: unknown, allowNull: boolean): Checked<Record<string, string | null>> {
  if (!isObj(v)) return { ok: false, reason: "contact must be an object" };
  const stray = Object.keys(v).find((k) => !(CONTACT_FIELDS as readonly string[]).includes(k));
  if (stray) return { ok: false, reason: `${stray} is not a contact field (email, phone, address)` };
  const out: Record<string, string | null> = {};
  for (const k of CONTACT_FIELDS) {
    const x = v[k];
    if (x === undefined) continue;
    if (x === null) { if (!allowNull) return { ok: false, reason: `${k} must be text` }; out[k] = null; continue; }
    if (typeof x !== "string" || !squash(x)) return { ok: false, reason: `${k} must be text` };
    const bad = CHECKS[k](squash(x));
    if (bad) return { ok: false, reason: bad };
    out[k] = squash(x);
  }
  return { ok: true, value: out };
}

// What an edit does to a profile, or why it cannot: the one place the rules live.
export function applyRevision(p: PartyProfile, r: Revision): { ok: true; next: PartyProfile } | { ok: false; code: "invalid_input" | "invalid_state"; reason: string } {
  const roles = new Set(p.roles);
  for (const x of r.addRoles ?? []) { if (roles.has(x)) return { ok: false, code: "invalid_state", reason: `This party is already a ${x}.` }; roles.add(x); }
  for (const x of r.removeRoles ?? []) { if (!roles.has(x)) return { ok: false, code: "invalid_state", reason: `This party is not a ${x}, so that role cannot be removed.` }; roles.delete(x); }
  if (roles.size === 0) return { ok: false, code: "invalid_state", reason: "A party must stay a customer or a supplier." };
  const contact: Contact = { ...p.contact };
  for (const [k, v] of Object.entries(r.contact ?? {})) { if (v === null) delete (contact as Record<string, string>)[k]; else (contact as Record<string, string>)[k] = v; }
  const next: PartyProfile = { ...p, name: r.name ?? p.name, roles: [...roles].sort(), contact };
  if (JSON.stringify([next.name, next.roles, next.contact]) === JSON.stringify([p.name, [...p.roles].sort(), p.contact])) return { ok: false, code: "invalid_input", reason: "That would change nothing." };
  return { ok: true, next };
}

// ---- reading (derived) -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------
const parse = (s: string): Record<string, unknown> => { try { const v = JSON.parse(s); return isObj(v) ? v : {}; } catch { return {}; } };
function fold(base: PartyProfile, created: Record<string, unknown>, revisions: Array<{ id: number; payload: Record<string, unknown> }>): PartyProfile {
  let p: PartyProfile = { ...base, roles: [...base.roles].sort(), contact: isObj(created.contact) ? (Object.fromEntries(Object.entries(created.contact).filter(([, v]) => typeof v === "string")) as Contact) : {}, revisionEventIds: [] };
  for (const rev of revisions) {
    const r = rev.payload;
    const step = applyRevision(p, { name: typeof r.name === "string" ? r.name : undefined, addRoles: Array.isArray(r.addRoles) ? (r.addRoles as string[]) : undefined, removeRoles: Array.isArray(r.removeRoles) ? (r.removeRoles as string[]) : undefined, contact: isObj(r.contact) ? (r.contact as Record<string, string | null>) : undefined });
    p = step.ok ? { ...step.next, revisionEventIds: [...p.revisionEventIds, rev.id] } : { ...p, revisionEventIds: [...p.revisionEventIds, rev.id] };
  }
  return p;
}

export async function allProfiles(env: Env): Promise<PartyProfile[]> {
  const parties = await many<{ id: number; kind: string; name: string; event_id: number }>(env, "SELECT id, kind, name, event_id FROM eng_party ORDER BY id");
  if (parties.length === 0) return [];
  const roles = await many<{ party_id: number; role: string }>(env, "SELECT party_id, role FROM eng_party_role");
  const created = new Map((await many<{ id: number; payload_json: string }>(env, "SELECT id, payload_json FROM eng_event WHERE type = 'party.created'")).map((e) => [e.id, parse(e.payload_json)]));
  const byParty = new Map<number, Array<{ id: number; payload: Record<string, unknown> }>>();
  for (const e of await many<{ id: number; payload_json: string }>(env, "SELECT id, payload_json FROM eng_event WHERE type = 'party.revised' ORDER BY id")) {
    const payload = parse(e.payload_json);
    const pid = Number(payload.partyId);
    byParty.set(pid, [...(byParty.get(pid) ?? []), { id: e.id, payload }]);
  }
  return parties.map((p) => fold({ id: p.id, kind: p.kind, name: p.name, roles: roles.filter((r) => r.party_id === p.id).map((r) => r.role), contact: {}, revisionEventIds: [] }, created.get(p.event_id) ?? {}, byParty.get(p.id) ?? []));
}

export async function partyProfile(env: Env, id: number): Promise<PartyProfile | null> {
  const p = await env.OFFICE_DB.prepare("SELECT id, kind, name, event_id FROM eng_party WHERE id = ?").bind(id).first<{ id: number; kind: string; name: string; event_id: number }>();
  if (!p) return null;
  const roles = (await many<{ role: string }>(env, "SELECT role FROM eng_party_role WHERE party_id = ?", id)).map((r) => r.role);
  const created = await env.OFFICE_DB.prepare("SELECT payload_json FROM eng_event WHERE id = ?").bind(p.event_id).first<{ payload_json: string }>();
  const revisions = (await many<{ id: number; payload_json: string }>(env, "SELECT id, payload_json FROM eng_event WHERE type = 'party.revised' AND json_extract(payload_json, '$.partyId') = ? ORDER BY id", id)).map((e) => ({ id: e.id, payload: parse(e.payload_json) }));
  return fold({ id: p.id, kind: p.kind, name: p.name, roles, contact: {}, revisionEventIds: [] }, created ? parse(created.payload_json) : {}, revisions);
}

// Another party that already has this name NOW (ignoring case and spacing), or null.
export async function holderOfName(env: Env, name: string, exceptId?: number): Promise<{ id: number; name: string } | null> {
  const hit = (await allProfiles(env)).find((p) => p.id !== exceptId && sameName(p.name, name));
  return hit ? { id: hit.id, name: hit.name } : null;
}
