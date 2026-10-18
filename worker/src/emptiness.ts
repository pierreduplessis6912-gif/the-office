// Is this business EMPTY? (SHIP_CHECKLIST.md item 15, the empty-business handover.) An employee who signed up for their own trial by mistake can, if THEY agree, move into the business that invited them, and the one they leave is closed.
// Nothing is merged and nothing is deleted, so this question must be STRICT: it is the only thing standing between "closing a business nobody has used" and closing one that has data.
// Measured, not guessed: a business database has 42 tables, and right after signup exactly TWO hold a row: `memberships` (the owner) and `business_profile` (the name). So a business is empty when every OTHER table has no rows, its
// only member is the person asked about (an active owner), and its profile holds nothing but a name. Two bookkeeping tables carry rows in every real object and are ignored; every other table counts, including any a future feature adds
// (an unknown table with rows is NOT empty), so this can only ever err on the safe side. It only READS.
import { normaliseEmail } from "./directory";
import type { Env } from "./types";

const BOOKKEEPING = new Set(["object_meta", "schema_steps"]);
// What a profile holds once the owner has started setting it up (a name alone is what signup leaves, and is still empty).
const PROFILE_TOUCHED = ["trading_as", "vat_no", "address", "phone", "email", "website", "banking_details", "logo_r2_key"];

export async function businessIsEmpty(env: Env, ownerEmail: string): Promise<{ empty: boolean; why?: string }> {
  const owner = normaliseEmail(ownerEmail ?? "");
  const { results } = await env.OFFICE_DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' ORDER BY name").all<{ name: string }>();
  for (const { name } of results ?? []) {
    if (BOOKKEEPING.has(name)) continue;
    const quoted = `"${name.replace(/"/g, '""')}"`;
    if (name === "memberships") {
      const { results: members } = await env.OFFICE_DB.prepare(`SELECT google_email, role, status FROM ${quoted}`).all<{ google_email: string; role: string; status: string }>();
      const only = members ?? [];
      if (only.length !== 1 || normaliseEmail(only[0].google_email) !== owner || only[0].role !== "owner" || only[0].status !== "active") return { empty: false, why: "the team is not just this one owner" };
      continue;
    }
    if (name === "business_profile") {
      const row = await env.OFFICE_DB.prepare(`SELECT * FROM ${quoted} LIMIT 1`).first<Record<string, unknown>>();
      if (!row) continue;
      if (PROFILE_TOUCHED.some((c) => typeof row[c] === "string" && (row[c] as string).trim() !== "") || Number(row.vat_registered ?? 0) !== 0 || Number(row.analytics_opt_in ?? 0) !== 0) return { empty: false, why: "the profile has been filled in" };
      continue;
    }
    const count = (await env.OFFICE_DB.prepare(`SELECT COUNT(*) AS n FROM ${quoted}`).first<{ n: number }>())?.n ?? 0;
    if (count > 0) return { empty: false, why: `${name} has data` };
  }
  return { empty: true };
}
