// The Identity primitive — everything about who someone is: customers,
// characters (never billed, structurally separate on purpose), the
// execution register (the "current selection," Principle 16). If
// something resolves to a person or an entity, it belongs here.

import type { Env } from "./types";

// Crude first-pass reconciliation: match on the first token of the
// spoken name (usually the first name) against existing customers.
// Pronouns and other generic words are not names — reconciliation
// rejects them before ever creating a record, the same discipline as
// guarding money against an LLM's raw output becoming a permanent
// write with nothing deterministic checking it first.
export const NOT_A_NAME = new Set([
  "her", "him", "he", "she", "it", "they", "them", "we", "us", "you",
  "i", "me", "this", "that", "someone", "somebody", "who", "customer", "client",
]);

export function looksLikeAName(name: string): boolean {
  const trimmed = name.trim().toLowerCase();
  if (trimmed.length < 2) return false;
  if (NOT_A_NAME.has(trimmed)) return false;
  return true;
}

// Second layer of defense against storing questions as facts — never
// trust intent classification alone for this, since it's been
// observed to misfire twice now, in two different storage paths
// (customer notes yesterday, life events today). A dumb, deterministic
// check can't be talked out of being right by an off day from the
// model. Not a replacement for the intent check — an extra one.
const QUESTION_STARTERS = [
  "what", "who", "when", "where", "why", "how", "do ", "does ", "did ",
  "is ", "are ", "was ", "were ", "can ", "could ", "would ", "should ",
];

export function looksLikeAQuestion(text: string): boolean {
  const trimmed = text.trim().toLowerCase();
  if (trimmed.endsWith("?")) return true;
  return QUESTION_STARTERS.some((starter) => trimmed.startsWith(starter));
}

export async function reconcileCustomer(env: Env, spokenName: string): Promise<{ id: number; name: string; matched: boolean } | null> {
  if (!looksLikeAName(spokenName)) {
    return null;
  }

  const tokens = spokenName.trim().split(/\s+/);

  // If a full name (first + last) was given, the match must account
  // for BOTH parts — matching on the first name alone silently
  // conflates any two people who happen to share it. Confirmed real:
  // "John Wilkins" matched an unrelated existing "John Titlestadt" on
  // first-token-only matching. Only fall back to a looser, first-name
  // -only match when genuinely just one name was given — the best
  // that can honestly be done with that little information.
  if (tokens.length >= 2) {
    const firstName = tokens[0];
    const lastName = tokens[tokens.length - 1];
    const existingFull = await env.OFFICE_DB.prepare(
      "SELECT id, name FROM customers WHERE name LIKE ? AND name LIKE ? LIMIT 1"
    )
      .bind(`%${firstName}%`, `%${lastName}%`)
      .first<{ id: number; name: string }>();

    if (existingFull) {
      return { id: existingFull.id, name: existingFull.name, matched: true };
    }

    const insertedFull = await env.OFFICE_DB.prepare("INSERT INTO customers (name) VALUES (?) RETURNING id, name")
      .bind(spokenName)
      .first<{ id: number; name: string }>();

    return { id: insertedFull!.id, name: insertedFull!.name, matched: false };
  }

  const firstToken = tokens[0];
  const existing = await env.OFFICE_DB.prepare("SELECT id, name FROM customers WHERE name LIKE ? LIMIT 1")
    .bind(`%${firstToken}%`)
    .first<{ id: number; name: string }>();

  if (existing) {
    return { id: existing.id, name: existing.name, matched: true };
  }

  const inserted = await env.OFFICE_DB.prepare("INSERT INTO customers (name) VALUES (?) RETURNING id, name")
    .bind(spokenName)
    .first<{ id: number; name: string }>();

  return { id: inserted!.id, name: inserted!.name, matched: false };
}

// A character is a personal relation — wife, nanny, family — never a
// business customer. Same reconciliation discipline as customers
// (full-name matching, pronoun rejection), against a genuinely
// separate table that guard(), invoices, and "who owes me money" can
// never see. Relationship is only ever stored once, at creation —
// there is no guarded update path here, since nothing here carries
// financial consequence the way a customer's address does.
export async function reconcileCharacter(
  env: Env,
  spokenName: string,
  relationship: string | null
): Promise<{ id: number; name: string; matched: boolean } | null> {
  if (!looksLikeAName(spokenName)) {
    return null;
  }

  const tokens = spokenName.trim().split(/\s+/);

  if (tokens.length >= 2) {
    const firstName = tokens[0];
    const lastName = tokens[tokens.length - 1];
    const existingFull = await env.OFFICE_DB.prepare(
      "SELECT id, name FROM characters WHERE name LIKE ? AND name LIKE ? LIMIT 1"
    )
      .bind(`%${firstName}%`, `%${lastName}%`)
      .first<{ id: number; name: string }>();

    if (existingFull) {
      return { id: existingFull.id, name: existingFull.name, matched: true };
    }

    const insertedFull = await env.OFFICE_DB.prepare(
      "INSERT INTO characters (name, relationship) VALUES (?, ?) RETURNING id, name"
    )
      .bind(spokenName, relationship)
      .first<{ id: number; name: string }>();

    return { id: insertedFull!.id, name: insertedFull!.name, matched: false };
  }

  const existing = await env.OFFICE_DB.prepare("SELECT id, name FROM characters WHERE name LIKE ? LIMIT 1")
    .bind(`%${tokens[0]}%`)
    .first<{ id: number; name: string }>();

  if (existing) {
    return { id: existing.id, name: existing.name, matched: true };
  }

  const inserted = await env.OFFICE_DB.prepare(
    "INSERT INTO characters (name, relationship) VALUES (?, ?) RETURNING id, name"
  )
    .bind(spokenName, relationship)
    .first<{ id: number; name: string }>();

  return { id: inserted!.id, name: inserted!.name, matched: false };
}

// Read-only counterpart to reconcileCustomer/reconcileCharacter —
// used only for resolving a follow-up question to an EXISTING entity,
// never allowed to create one. A mere lookup accidentally creating a
// customer or character row would be a real, silent data-integrity
// bug, the same class of thing guard() and reconciliation discipline
// exist to prevent everywhere else.
export async function findExistingEntityByName(
  env: Env,
  name: string
): Promise<{ type: "customer" | "character"; id: number; name: string } | null> {
  if (!looksLikeAName(name)) return null;
  const tokens = name.trim().split(/\s+/);
  const firstToken = tokens[0];
  const lastToken = tokens[tokens.length - 1];

  const customerRow =
    tokens.length >= 2
      ? await env.OFFICE_DB.prepare("SELECT id, name FROM customers WHERE name LIKE ? AND name LIKE ? LIMIT 1")
          .bind(`%${firstToken}%`, `%${lastToken}%`)
          .first<{ id: number; name: string }>()
      : await env.OFFICE_DB.prepare("SELECT id, name FROM customers WHERE name LIKE ? LIMIT 1")
          .bind(`%${firstToken}%`)
          .first<{ id: number; name: string }>();
  if (customerRow) return { type: "customer", id: customerRow.id, name: customerRow.name };

  const characterRow =
    tokens.length >= 2
      ? await env.OFFICE_DB.prepare("SELECT id, name FROM characters WHERE name LIKE ? AND name LIKE ? LIMIT 1")
          .bind(`%${firstToken}%`, `%${lastToken}%`)
          .first<{ id: number; name: string }>()
      : await env.OFFICE_DB.prepare("SELECT id, name FROM characters WHERE name LIKE ? LIMIT 1")
          .bind(`%${firstToken}%`)
          .first<{ id: number; name: string }>();
  if (characterRow) return { type: "character", id: characterRow.id, name: characterRow.name };

  return null;
}

// The execution register — rung 1 of the Execution Ladder (see
// OFFICE_CONSTITUTION.md). Peter's own words ARE the selection event,
// the same way a click is in a desktop UI: "show me Jenny" makes
// Jenny the current customer selection, overwritten the moment
// something else is explicitly named. No decay policy needed — there
// is no ephemeral state to go stale, just "whichever was named most
// recently." Generic key/value on purpose (Git's mutable-pointer
// pattern, Principle 16) rather than fixed columns per entity type,
// so a future department (marketing, tender, cybersecurity) doesn't
// need a schema migration just to get a selection slot.
export async function setSelection(env: Env, key: string, entityId: number, label: string): Promise<void> {
  await env.OFFICE_DB.prepare(
    `INSERT INTO selections (key, entity_id, label, updated_at) VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET entity_id = excluded.entity_id, label = excluded.label, updated_at = excluded.updated_at`
  )
    .bind(key, entityId, label)
    .run();
}

export async function getSelection(
  env: Env,
  key: string
): Promise<{ entityId: number; label: string; updatedAt: string } | null> {
  const row = await env.OFFICE_DB.prepare("SELECT entity_id, label, updated_at FROM selections WHERE key = ?")
    .bind(key)
    .first<{ entity_id: number; label: string; updated_at: string }>();
  return row ? { entityId: row.entity_id, label: row.label, updatedAt: row.updated_at } : null;
}

// The actual read side of the register — checked BEFORE any AI-based
// resolution is attempted, per Principle 1 (Deterministic Before AI).
// Whichever of customer/character was named most recently wins, same
// "last thing selected" simplicity as a desktop file selection.
// The register's untyped read strategy — for genuinely type-agnostic
// references ("it", "them", "that"), as opposed to getSelection()'s
// typed read strategy for when Peter names a specific kind of thing
// ("the quote", "the invoice"). The property that makes this an
// actual primitive, not just a shape that happens to fit two types
// today: adding a third, fourth, or tenth selection type later means
// only inserting rows under a new key — this function never changes.
// No type names appear anywhere in it on purpose.
export async function getCurrentSelection(env: Env): Promise<{ type: string; id: number; name: string } | null> {
  const row = await env.OFFICE_DB.prepare("SELECT key, entity_id, label FROM selections ORDER BY updated_at DESC LIMIT 1").first<{
    key: string;
    entity_id: number;
    label: string;
  }>();
  return row ? { type: row.key, id: row.entity_id, name: row.label } : null;
}
