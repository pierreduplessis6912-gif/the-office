// Putting the name typed at signup into the business's OWN profile (the single row that quotes and invoices carry). Until 2026-10-17 it lived only in the directory, so an owner who had just typed it was asked for it again by the journey's
// first step, and their invoices had no business name until they dictated one. Runs INSIDE the business's object, called by the Worker (signup.ts) over the privileged route /debug/seed-business-name. It sets the name only when there is
// none (or it is blank), so a retry, or a name the owner has since changed, is never overwritten; and it touches nothing else in the row (the journey's profile step also needs the address, so this does not make it look done).
import { validateBusinessName } from "./signup";
import type { Env } from "./types";

export async function seedBusinessName(env: Env, raw: unknown): Promise<{ ok: true; seeded: boolean; name: string } | { ok: false; error: string }> {
  const named = validateBusinessName(raw);
  if (!named.ok) return { ok: false, error: named.error };
  try {
    await env.OFFICE_DB.prepare("INSERT INTO business_profile (id, name) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, updated_at = datetime('now') WHERE name IS NULL OR TRIM(name) = ''").bind(named.name).run();
    const row = await env.OFFICE_DB.prepare("SELECT name FROM business_profile WHERE id = 1").first<{ name: string | null }>();
    return { ok: true, seeded: row?.name === named.name, name: named.name };
  } catch (error) {
    return { ok: false, error: String((error as { message?: string } | null)?.message ?? error).slice(0, 200) };
  }
}
