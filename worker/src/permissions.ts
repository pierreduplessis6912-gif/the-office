// The permission grid's handlers (2026-10-04). The catalog, the guard rails and the loader live in auth.ts, next to the
// table they override; this file is the owner-only read and write side. See the long comment above CAPABILITY_CATALOG.
import { CAPABILITY_CATALOG, EDITABLE_ROLES, INHERITED_FROM, ROLE_CAPABILITIES, getRoleCapabilities, isEditableCapability, readOverrides, CAPABILITY_BY_KEY } from "./auth";
import type { Env } from "./types";

const ROLE_LABELS: Record<string, string> = { accountant: "Accountant", installer: "Installer" };
const roleLabel = (role: string): string => ROLE_LABELS[role] ?? role.charAt(0).toUpperCase() + role.slice(1);

export interface PermissionRow {
  key: string;
  label: string;
  description: string;
  inUse: boolean;
  ownerOnly: boolean;
  editable: boolean;
  granted: boolean;
  default: boolean;
  changed: boolean;
}
export interface RolePermissions {
  role: string;
  label: string;
  capabilities: PermissionRow[];
}

export async function getRolePermissions(env: Env, role: string): Promise<RolePermissions> {
  const effective = new Set(await getRoleCapabilities(env, role));
  const defaults = new Set(ROLE_CAPABILITIES[role] ?? []);
  return {
    role,
    label: roleLabel(role),
    capabilities: CAPABILITY_CATALOG.map((c) => ({
      key: c.key,
      label: c.label,
      description: c.description,
      inUse: c.inUse,
      ownerOnly: c.ownerOnly,
      editable: isEditableCapability(c.key),
      granted: effective.has(c.key),
      default: defaults.has(c.key),
      changed: effective.has(c.key) !== defaults.has(c.key),
    })),
  };
}

export async function listPermissions(env: Env): Promise<{ roles: RolePermissions[] }> {
  const roles: RolePermissions[] = [];
  for (const role of EDITABLE_ROLES) roles.push(await getRolePermissions(env, role));
  return { roles };
}

export type PermissionChange = { ok: true; changed: boolean; role: RolePermissions } | { ok: false; status: number; error: string };

const now = (): string => new Date().toISOString();

export async function setPermission(env: Env, role: unknown, capability: unknown, granted: unknown, changedBy: string | null): Promise<PermissionChange> {
  if (role === "owner") return { ok: false, status: 400, error: "The owner's permissions cannot be changed." };
  if (typeof role !== "string" || !EDITABLE_ROLES.includes(role)) return { ok: false, status: 400, error: `Unknown role. The roles that can be changed are: ${EDITABLE_ROLES.join(", ")}.` };
  if (typeof capability !== "string" || !CAPABILITY_BY_KEY[capability]) return { ok: false, status: 400, error: "Unknown permission." };
  const info = CAPABILITY_BY_KEY[capability];
  if (info.ownerOnly) return { ok: false, status: 400, error: `"${info.label}" is owner only and cannot be given to another role.` };
  if (!info.inUse) return { ok: false, status: 400, error: `"${info.label}" is not used by anything yet, so it cannot be switched.` };
  if (typeof granted !== "boolean") return { ok: false, status: 400, error: "granted must be true or false." };

  const effectiveNow = await getRoleCapabilities(env, role);
  const current = effectiveNow.includes(capability);
  // What the switch is when nothing is set on it. For one that FOLLOWS another (expense totals and supplier balances follow "Money in and out",
  // decided 2026-10-04) that is whatever the other currently says; for the rest it is the standard default. Comparing a following switch with its
  // static default was a bug: with money taken away, switching expense totals ON equalled the default, so it deleted the very setting meant to
  // keep it on, and it fell straight back to following money.
  const parent = INHERITED_FROM[capability];
  const isDefault = parent ? effectiveNow.includes(parent) : (ROLE_CAPABILITIES[role] ?? []).includes(capability);
  if (granted === current) return { ok: true, changed: false, role: await getRolePermissions(env, role) };

  // Only a difference from what it would be anyway is stored. Switching something back to that removes the override.
  if (granted === isDefault) {
    await env.OFFICE_DB.prepare("DELETE FROM role_capability_overrides WHERE role = ? AND capability = ?").bind(role, capability).run();
  } else {
    await env.OFFICE_DB.prepare(
      "INSERT INTO role_capability_overrides (role, capability, granted, updated_by, updated_at) VALUES (?, ?, ?, ?, ?) " +
        "ON CONFLICT(role, capability) DO UPDATE SET granted = excluded.granted, updated_by = excluded.updated_by, updated_at = excluded.updated_at"
    )
      .bind(role, capability, granted ? 1 : 0, changedBy, now())
      .run();
  }
  await env.OFFICE_DB.prepare("INSERT INTO permission_audit (changed_by, role, capability, old_granted, new_granted, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(changedBy, role, capability, current ? 1 : 0, granted ? 1 : 0, now())
    .run();
  return { ok: true, changed: true, role: await getRolePermissions(env, role) };
}

export async function resetRole(env: Env, role: unknown, changedBy: string | null): Promise<PermissionChange & { reverted?: number }> {
  if (role === "owner") return { ok: false, status: 400, error: "The owner's permissions cannot be changed." };
  if (typeof role !== "string" || !EDITABLE_ROLES.includes(role)) return { ok: false, status: 400, error: `Unknown role. The roles that can be changed are: ${EDITABLE_ROLES.join(", ")}.` };
  const before = new Set(await getRoleCapabilities(env, role));
  const overrides = await readOverrides(env, role);
  await env.OFFICE_DB.prepare("DELETE FROM role_capability_overrides WHERE role = ?").bind(role).run();
  let reverted = 0;
  for (const capability of CAPABILITY_CATALOG.map((c) => c.key)) {
    if (!overrides.some((o) => o.capability === capability)) continue;
    const wasGranted = before.has(capability);
    const isDefault = (ROLE_CAPABILITIES[role] ?? []).includes(capability);
    if (wasGranted === isDefault) continue;
    await env.OFFICE_DB.prepare("INSERT INTO permission_audit (changed_by, role, capability, old_granted, new_granted, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(changedBy, role, capability, wasGranted ? 1 : 0, isDefault ? 1 : 0, now())
      .run();
    reverted++;
  }
  return { ok: true, changed: reverted > 0, reverted, role: await getRolePermissions(env, role) };
}

export async function listAudit(env: Env, limit: number): Promise<{ changes: Array<{ id: number; changedBy: string | null; role: string; roleLabel: string; capability: string; label: string; from: boolean; to: boolean; at: string | null }> }> {
  let rows: Array<{ id: number; changed_by: string | null; role: string; capability: string; old_granted: number; new_granted: number; created_at: string | null }> = [];
  try {
    const { results } = await env.OFFICE_DB.prepare("SELECT id, changed_by, role, capability, old_granted, new_granted, created_at FROM permission_audit ORDER BY id DESC LIMIT ?")
      .bind(Math.max(1, Math.min(200, Math.floor(limit) || 20)))
      .all<typeof rows[number]>();
    rows = results ?? [];
  } catch (err) {
    if (!/no such table/i.test(err instanceof Error ? err.message : String(err))) throw err;
  }
  return {
    changes: rows.map((r) => ({
      id: r.id,
      changedBy: r.changed_by,
      role: r.role,
      roleLabel: roleLabel(r.role),
      capability: r.capability,
      label: CAPABILITY_BY_KEY[r.capability]?.label ?? r.capability,
      from: Boolean(r.old_granted),
      to: Boolean(r.new_granted),
      at: r.created_at,
    })),
  };
}
