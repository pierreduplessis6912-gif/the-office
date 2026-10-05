// The Identity primitive — everything about who someone is: customers,
// characters (never billed, structurally separate on purpose), the
// execution register (the "current selection," Principle 16). If
// something resolves to a person or an entity, it belongs here.

import type { Env } from "./types";

// Real, shared helper, per direct instruction after a real, confirmed
// bug found live: "Andre" (a bare, single-token name) incorrectly
// matched "Juandre Lotriet" - a completely different, unrelated real
// customer - because "Juandre" genuinely, literally contains the
// substring "andre". The same naive `name LIKE '%token%'` pattern was
// repeated across every reconciliation function below - a real,
// dangerous false-positive risk that's existed the whole time, not
// something new. Matches a token as a genuine, whole word within a
// name - never as a substring buried inside a different, longer word.
// Independently tested against the exact confirmed bug and legitimate
// cases (a name where the token IS the whole first name, the whole
// last name, or the entire name) before being placed here.
function wholeWordClause(column: string): string {
  // Real bug found live 2026-10-02: "Alfons" and "alfons" became two
  // separate customers. SQLite's LIKE ignores ASCII case but plain `=`
  // does not, and a single-word name can only ever match through the
  // `=` branch (the LIKE patterns all need a space) — so a one-word
  // name that differed only in capitalisation never matched, and a
  // duplicate got created. The speech recogniser capitalises the same
  // spoken name inconsistently, so this was reachable by ordinary use.
  // COLLATE NOCASE makes `=` agree with the LIKE branches.
  return `(${column} = ? COLLATE NOCASE OR ${column} LIKE ? OR ${column} LIKE ? OR ${column} LIKE ?)`;
}
function wholeWordBindings(token: string): [string, string, string, string] {
  return [token, `${token} %`, `% ${token}`, `% ${token} %`];
}

// Real, deterministic phonetic pass, per direct instruction after a
// real, confirmed bug: the on-device speech recognizer (the app's
// speech_to_text package, confirmed to have no vocabulary/biasing
// option in its own public API) produced three different literal
// strings for the same real spoken name across one session — "Sipo,"
// "sipo," "Sepo" — none of which share a whole-word match with each
// other or with the existing "Sipho" records. Standard Soundex,
// verified by hand before writing this: "Sipho," "Sipo," and "Sepo"
// all encode to S100 — the exact real cluster this needs to catch.
// Confirmed NOT to reopen the earlier Andre/Juandre bug: those encode
// to A536 and J536 respectively — different first letters, different
// codes, so they stay correctly distinct. Deliberately never given
// authority to auto-match on its own, only ever used as reconcilePerson's
// last resort before returning "new" — same "hold and ask" discipline
// as every other ambiguous case in this file.
function soundex(name: string): string {
  const cleaned = name.toUpperCase().replace(/[^A-Z]/g, "");
  if (!cleaned) return "";
  const codes: Record<string, string> = {
    B: "1", F: "1", P: "1", V: "1",
    C: "2", G: "2", J: "2", K: "2", Q: "2", S: "2", X: "2", Z: "2",
    D: "3", T: "3",
    L: "4",
    M: "5", N: "5",
    R: "6",
  };
  let result = cleaned[0];
  let lastCode = codes[cleaned[0]] ?? "";
  for (let i = 1; i < cleaned.length && result.length < 4; i++) {
    const code = codes[cleaned[i]] ?? "";
    if (code && code !== lastCode) {
      result += code;
    }
    if (cleaned[i] !== "H" && cleaned[i] !== "W") {
      lastCode = code;
    }
  }
  return (result + "000").slice(0, 4);
}

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

// Real feature 2026-07-25 — Identity Collision, the real, deterministic
// alternative to teaching the model every possible ambiguous phrasing,
// given directly by Pierre earlier in this project. This was never a
// language-understanding problem — Thabo already has an established
// identity in one table; the question is only ever whether this
// message's role assignment for that name conflicts with what's
// already on file. A direct database lookup, not a model judgment
// call, the same "code decides, model only transcribes" discipline
// already proven everywhere else in this project. Only checks for an
// EXACT name match — a real, deliberate choice, safer and simpler
// than fuzzy matching, which risks flagging collisions that were
// never real ones. Only fires when the name doesn't already exist in
// its own, intended table — a real, repeat match there (the common,
// frictionless case — "Thabo measure X" when Thabo is already a known
// installer) is never a collision at all.
// Real, first piece of IDENTITY_ARCHITECTURE.md's matching threshold,
// per direct instruction to build it. Deliberately not yet wired into
// any live reconciliation path - the architecture document's own
// migration sequencing puts backfill first; wiring this in before
// existing customers/characters/leads rows are linked to a real
// person would make every already-known real person look brand new
// the next time they're mentioned, the exact fragmentation this whole
// effort exists to fix.
//
// The real, precise threshold, confirmed directly against Git's own
// .mailmap tooling: an exact, full-string match reconciles
// automatically. No match at all is genuinely new. Anything weaker -
// a short token (under 8 characters, the same real number a current
// mailmap-checking tool uses "to reduce false positives") even with
// only one candidate, or more than one real candidate at any length -
// is never guessed. Returned as ambiguous for the caller to hold and
// ask, the same real judgment already proven tonight for role
// collisions, extended here to name collisions between two different
// real people.
export async function reconcilePerson(
  env: Env,
  spokenName: string
): Promise<
  | { status: "matched"; id: number; name: string }
  | { status: "ambiguous"; candidates: Array<{ id: number; name: string }> }
  | { status: "new" }
  | null
> {
  if (!looksLikeAName(spokenName)) return null;

  // Real, deliberate exclusion, per direct instruction after a real,
  // confirmed gap: a customer-level merge (see merge-customers) never
  // touched the underlying people table, so a merged duplicate's name
  // kept surfacing as its own separate candidate in every match below
  // — confirmed directly as the real reason "bon waterfront" still
  // showed three candidates after the Bon Hotel Waterfront merge,
  // when it should have shown two. merged_into_person_id IS NULL on
  // every real query here means a merged person is treated as
  // genuinely gone for future matching, not just renamed elsewhere.
  const exact = await env.OFFICE_DB.prepare(
    "SELECT id, name FROM people WHERE name = ? COLLATE NOCASE AND merged_into_person_id IS NULL"
  )
    .bind(spokenName)
    .all<{ id: number; name: string }>();
  if (exact.results.length === 1) {
    return { status: "matched", id: exact.results[0].id, name: exact.results[0].name };
  }
  if (exact.results.length > 1) {
    return { status: "ambiguous", candidates: exact.results };
  }

  const firstToken = spokenName.trim().split(/\s+/)[0];
  const weak = await env.OFFICE_DB.prepare(
    `SELECT id, name FROM people WHERE ${wholeWordClause("name")} AND merged_into_person_id IS NULL`
  )
    .bind(...wholeWordBindings(firstToken))
    .all<{ id: number; name: string }>();

  if (weak.results.length === 0) {
    // Real phonetic pass, reached only when no exact or whole-word
    // match exists at all — see soundex()'s own comment above for the
    // real, confirmed evidence behind this. A full scan computed in
    // JS, not D1/SQLite's optional soundex() extension — the people
    // table is small at this business's real current scale, and this
    // avoids depending on an unconfirmed build-time extension. Never
    // auto-matched — a phonetic hit only ever becomes "ambiguous" for
    // a human to resolve, same as every other real candidate list in
    // this function.
    const allPeople = await env.OFFICE_DB.prepare(
      "SELECT id, name FROM people WHERE merged_into_person_id IS NULL"
    ).all<{ id: number; name: string }>();
    const targetCode = soundex(firstToken);
    const phoneticMatches = allPeople.results.filter((p) => soundex(p.name.trim().split(/\s+/)[0]) === targetCode);
    if (phoneticMatches.length > 0) {
      return { status: "ambiguous", candidates: phoneticMatches };
    }
    return { status: "new" };
  }
  if (firstToken.length < 8) {
    return { status: "ambiguous", candidates: weak.results };
  }
  if (weak.results.length === 1) {
    return { status: "matched", id: weak.results[0].id, name: weak.results[0].name };
  }
  return { status: "ambiguous", candidates: weak.results };
}

// Real, new function, per direct instruction: the exact same real,
// proven structure as reconcilePerson right above — exact match,
// then whole-word, then phonetic, holding for a human the moment
// confidence runs out — applied to a real entity this project never
// had until now: the product or material itself. "Vinyl" said today
// and "vinyl flooring" said next month need to resolve to the same
// real thing before any real business intelligence about materials
// is possible, the same real fragmentation risk already confirmed
// and solved for people's names, just for a different category of
// entity. Deliberately not reusing looksLikeAName — that's a
// people-specific heuristic (capitalized, proper-noun-shaped); a
// product name like "vinyl" or "screed" is an ordinary common noun
// and would fail that check incorrectly.
export async function reconcileProduct(
  env: Env,
  spokenName: string
): Promise<
  | { status: "matched"; id: number; name: string }
  | { status: "ambiguous"; candidates: Array<{ id: number; name: string }> }
  | { status: "new" }
  | null
> {
  const trimmed = spokenName.trim();
  if (trimmed.length === 0) return null;

  const exact = await env.OFFICE_DB.prepare(
    "SELECT id, name FROM products WHERE name = ? COLLATE NOCASE AND merged_into_product_id IS NULL"
  )
    .bind(trimmed)
    .all<{ id: number; name: string }>();
  if (exact.results.length === 1) {
    return { status: "matched", id: exact.results[0].id, name: exact.results[0].name };
  }
  if (exact.results.length > 1) {
    return { status: "ambiguous", candidates: exact.results };
  }

  const firstToken = trimmed.split(/\s+/)[0];
  const weak = await env.OFFICE_DB.prepare(
    `SELECT id, name FROM products WHERE ${wholeWordClause("name")} AND merged_into_product_id IS NULL`
  )
    .bind(...wholeWordBindings(firstToken))
    .all<{ id: number; name: string }>();

  if (weak.results.length === 0) {
    // Real phonetic pass, same real reasoning as reconcilePerson's own
    // — computed in JS over a real, small table, not a build-time
    // SQLite extension. Never auto-matched — a phonetic hit only ever
    // becomes "ambiguous" for a human to resolve.
    const allProducts = await env.OFFICE_DB.prepare(
      "SELECT id, name FROM products WHERE merged_into_product_id IS NULL"
    ).all<{ id: number; name: string }>();
    const targetCode = soundex(firstToken);
    const phoneticMatches = allProducts.results.filter((p) => soundex(p.name.trim().split(/\s+/)[0]) === targetCode);
    if (phoneticMatches.length > 0) {
      return { status: "ambiguous", candidates: phoneticMatches };
    }
    return { status: "new" };
  }
  if (firstToken.length < 8) {
    return { status: "ambiguous", candidates: weak.results };
  }
  if (weak.results.length === 1) {
    return { status: "matched", id: weak.results[0].id, name: weak.results[0].name };
  }
  return { status: "ambiguous", candidates: weak.results };
}

export async function checkCrossRoleCollision(
  env: Env,
  name: string,
  intendedRole: "customer" | "character"
): Promise<{ id: number; name: string; existingRole: "customer" | "character"; existingLabel: string } | null> {
  const ownTable = intendedRole === "customer" ? "customers" : "characters";
  const otherTable = intendedRole === "customer" ? "characters" : "customers";
  // Real, deliberate exclusion, matching reconcilePerson's own —
  // Real, updated, per direct instruction: characters now has a real
  // merge column too (merged_into_character_id), matching customers,
  // so both sides get their own real exclusion instead of the
  // customers-only special case this used to be.
  const mergeColumn = (table: string) => (table === "customers" ? "merged_into_customer_id" : "merged_into_character_id");
  const ownMergeFilter = ` AND ${mergeColumn(ownTable)} IS NULL`;
  const otherMergeFilter = ` AND ${mergeColumn(otherTable)} IS NULL`;

  const existsInOwnTable = await env.OFFICE_DB.prepare(
    `SELECT id FROM ${ownTable} WHERE name = ? COLLATE NOCASE${ownMergeFilter}`
  )
    .bind(name)
    .first();
  if (existsInOwnTable) return null;

  const collision = await env.OFFICE_DB.prepare(
    `SELECT id, name${otherTable === "characters" ? ", relationship" : ""} FROM ${otherTable} WHERE name = ? COLLATE NOCASE${otherMergeFilter}`
  )
    .bind(name)
    .first<{ id: number; name: string; relationship?: string | null }>();
  if (!collision) return null;

  return {
    id: collision.id,
    name: collision.name,
    existingRole: intendedRole === "customer" ? "character" : "customer",
    // What to call them when asking the person. "character" is the system's own word for anyone who is not a customer;
    // the question used to say "already on file as a character", when it knew they were an installer or a supplier.
    existingLabel: intendedRole === "customer" ? collision.relationship?.trim() || "contact" : "customer",
  };
}

// "an installer", "a supplier": the right article for a role named in a question.
export function withArticle(label: string): string {
  return `${/^[aeiou]/i.test(label.trim()) ? "an" : "a"} ${label.trim()}`;
}

export async function reconcileCustomer(env: Env, spokenName: string): Promise<{ id: number; name: string; matched: boolean } | null> {
  if (!looksLikeAName(spokenName)) {
    return null;
  }

  // Real, new shortcut, per direct instruction to continue wiring the
  // identity layer into live reconciliation. Checked first: if the
  // canonical people layer already has a confident match, genuinely
  // linked to a real customer (via the backfill run tonight, or a
  // future one), use it directly - the same, precise threshold
  // already proven in reconcilePerson itself, now benefiting the
  // exact function that caused tonight's most serious bug. Every
  // other real case - no match, ambiguous, or a matched person not
  // yet linked to any customer - falls through completely unchanged
  // to the existing, proven logic below. Nothing about that logic is
  // touched.
  const personResult = await reconcilePerson(env, spokenName);
  if (personResult?.status === "matched") {
    const linkedCustomer = await env.OFFICE_DB.prepare("SELECT id, name FROM customers WHERE person_id = ? LIMIT 1")
      .bind(personResult.id)
      .first<{ id: number; name: string }>();
    if (linkedCustomer) {
      return { id: linkedCustomer.id, name: linkedCustomer.name, matched: true };
    }
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
      "SELECT id, name FROM customers WHERE name LIKE ? AND name LIKE ? AND merged_into_customer_id IS NULL LIMIT 1"
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
  const existing = await env.OFFICE_DB.prepare(
    `SELECT id, name FROM customers WHERE ${wholeWordClause("name")} AND merged_into_customer_id IS NULL LIMIT 1`
  )
    .bind(...wholeWordBindings(firstToken))
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
      "SELECT id, name FROM characters WHERE name LIKE ? AND name LIKE ? AND merged_into_character_id IS NULL LIMIT 1"
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

  const existing = await env.OFFICE_DB.prepare(`SELECT id, name FROM characters WHERE ${wholeWordClause("name")} AND merged_into_character_id IS NULL LIMIT 1`)
    .bind(...wholeWordBindings(tokens[0]))
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

// Real bug found live 2026-07-12: "Sipho" existed as both a customer
// (id 12, an unrelated earlier test) and a character (id 7, today's
// installer). A lookup for character_name="Sipho" used the ambiguous
// findExistingEntityByName below, which checks customers first,
// found the customer match, correctly rejected it as the wrong type
// — and then had nothing left to fall back to, leaving `character`
// silently unset even though the right character genuinely existed.
// That's the actual design mistake: findExistingEntityByName is
// correct for the register/AI-fallback path, where the type truly
// isn't known in advance — but the moment extraction already tells
// us which field a name came from (customer_name vs character_name),
// searching the OTHER table at all is the bug, not a safety net.
// These two functions search only their own real table.
export async function findExistingCustomerByName(
  env: Env,
  name: string
): Promise<{ id: number; name: string } | null> {
  if (!looksLikeAName(name)) return null;
  const tokens = name.trim().split(/\s+/);
  const firstToken = tokens[0];
  const lastToken = tokens[tokens.length - 1];
  const row =
    tokens.length >= 2
      ? await env.OFFICE_DB.prepare("SELECT id, name FROM customers WHERE name LIKE ? AND name LIKE ? LIMIT 1")
          .bind(`%${firstToken}%`, `%${lastToken}%`)
          .first<{ id: number; name: string }>()
      : await env.OFFICE_DB.prepare(`SELECT id, name FROM customers WHERE ${wholeWordClause("name")} LIMIT 1`)
          .bind(...wholeWordBindings(firstToken))
          .first<{ id: number; name: string }>();
  return row ?? null;
}

export async function findExistingCharacterByName(
  env: Env,
  name: string
): Promise<{ id: number; name: string } | null> {
  if (!looksLikeAName(name)) return null;
  const tokens = name.trim().split(/\s+/);
  const firstToken = tokens[0];
  const lastToken = tokens[tokens.length - 1];
  const row =
    tokens.length >= 2
      ? await env.OFFICE_DB.prepare("SELECT id, name FROM characters WHERE name LIKE ? AND name LIKE ? AND merged_into_character_id IS NULL LIMIT 1")
          .bind(`%${firstToken}%`, `%${lastToken}%`)
          .first<{ id: number; name: string }>()
      : await env.OFFICE_DB.prepare(`SELECT id, name FROM characters WHERE ${wholeWordClause("name")} AND merged_into_character_id IS NULL LIMIT 1`)
          .bind(...wholeWordBindings(firstToken))
          .first<{ id: number; name: string }>();
  return row ?? null;
}

// Read-only counterpart to reconcileCustomer/reconcileCharacter —
// used only for resolving a follow-up question to an EXISTING entity,
// never allowed to create one. A mere lookup accidentally creating a
// customer or character row would be a real, silent data-integrity
// bug, the same class of thing guard() and reconciliation discipline
// exist to prevent everywhere else. Genuinely still the right tool
// for its own real use — the register/AI-fallback path in index.ts,
// where the type truly isn't known in advance — not for a lookup
// where extraction already told us which field the name came from.
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
      : await env.OFFICE_DB.prepare(`SELECT id, name FROM customers WHERE ${wholeWordClause("name")} LIMIT 1`)
          .bind(...wholeWordBindings(firstToken))
          .first<{ id: number; name: string }>();
  if (customerRow) return { type: "customer", id: customerRow.id, name: customerRow.name };

  const characterRow =
    tokens.length >= 2
      ? await env.OFFICE_DB.prepare("SELECT id, name FROM characters WHERE name LIKE ? AND name LIKE ? AND merged_into_character_id IS NULL LIMIT 1")
          .bind(`%${firstToken}%`, `%${lastToken}%`)
          .first<{ id: number; name: string }>()
      : await env.OFFICE_DB.prepare(`SELECT id, name FROM characters WHERE ${wholeWordClause("name")} AND merged_into_character_id IS NULL LIMIT 1`)
          .bind(...wholeWordBindings(firstToken))
          .first<{ id: number; name: string }>();
  if (characterRow) return { type: "character", id: characterRow.id, name: characterRow.name };

  return null;
}

// Real, first, deliberately narrow step of
// RELATIONAL_IDENTITY_ARCHITECTURE.md — Stage 1 only. Passive
// logging, zero behavior change. Records that two entities were
// named together in the same real capture — nothing stronger is
// claimed than that. Deliberately does not require either side to
// already be linked to the canonical `people` table via person_id:
// requiring that would be circular, since resolving an ambiguous
// person is exactly the problem this signal exists to help with
// later, in a Stage 2 not yet wired in. Fire-and-forget by design
// (see call site) — a failure here must never be able to affect
// reconciliation, which stays entirely unchanged by this addition.
export async function logInteractionEdge(
  env: Env,
  entityTypeA: "customer" | "character" | "lead",
  entityIdA: number,
  entityTypeB: "customer" | "character" | "lead",
  entityIdB: number,
  relationType: string,
  captureId: number | null
): Promise<void> {
  try {
    await env.OFFICE_DB.prepare(
      `INSERT INTO interaction_edges
        (capture_id, entity_type_a, entity_id_a, entity_type_b, entity_id_b, relation_type, created_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`
    )
      .bind(captureId, entityTypeA, entityIdA, entityTypeB, entityIdB, relationType)
      .run();
  } catch {
    // Real, deliberate swallow — this is a passive, auxiliary signal
    // per RELATIONAL_IDENTITY_ARCHITECTURE.md's own explicit ordering.
    // Nothing about reconciliation may ever depend on this succeeding.
  }
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
// Decided by Pierre 2026-10-04: "her", "him" and "and her balance" refer to the CURRENT SELECTION, and it used to be one setting for the whole
// business (a leftover from when the app had one user), so one person's lookups changed what another person's "her" meant and "forget
// that" cleared it for everyone. It is now one selection per signed-in member, in a table created the first time it is needed (the old
// shared one is left alone and no longer read). A person with no known email shares one anonymous selection.
const memberSelectionTableReady = new WeakSet<object>();
export async function ensureMemberSelectionTable(env: Env): Promise<void> {
  if (memberSelectionTableReady.has(env.OFFICE_DB as unknown as object)) return;
  await env.OFFICE_DB.prepare(
    "CREATE TABLE IF NOT EXISTS member_selections (member TEXT NOT NULL, key TEXT NOT NULL, entity_id INTEGER NOT NULL, label TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (member, key))"
  ).run();
  memberSelectionTableReady.add(env.OFFICE_DB as unknown as object);
}
const memberKey = (member: string | null | undefined): string => (member ?? "").trim().toLowerCase();

export async function setSelection(env: Env, key: string, entityId: number, label: string, member: string | null = null): Promise<void> {
  await ensureMemberSelectionTable(env);
  await env.OFFICE_DB.prepare(
    `INSERT INTO member_selections (member, key, entity_id, label, updated_at) VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(member, key) DO UPDATE SET entity_id = excluded.entity_id, label = excluded.label, updated_at = excluded.updated_at`
  )
    .bind(memberKey(member), key, entityId, label)
    .run();
}

export async function getSelection(
  env: Env,
  key: string,
  member: string | null = null
): Promise<{ entityId: number; label: string; updatedAt: string } | null> {
  await ensureMemberSelectionTable(env);
  const row = await env.OFFICE_DB.prepare("SELECT entity_id, label, updated_at FROM member_selections WHERE member = ? AND key = ?")
    .bind(memberKey(member), key)
    .first<{ entity_id: number; label: string; updated_at: string }>();
  return row ? { entityId: row.entity_id, label: row.label, updatedAt: row.updated_at } : null;
}

export async function getCurrentSelection(env: Env, member: string | null = null): Promise<{ type: string; id: number; name: string } | null> {
  await ensureMemberSelectionTable(env);
  const row = await env.OFFICE_DB.prepare("SELECT key, entity_id, label FROM member_selections WHERE member = ? ORDER BY updated_at DESC LIMIT 1")
    .bind(memberKey(member))
    .first<{ key: string; entity_id: number; label: string }>();
  return row ? { type: row.key, id: row.entity_id, name: row.label } : null;
}

// "forget that" clears THIS person's selection, and nobody else's.
export async function clearSelections(env: Env, member: string | null = null): Promise<void> {
  await ensureMemberSelectionTable(env);
  await env.OFFICE_DB.prepare("DELETE FROM member_selections WHERE member = ?").bind(memberKey(member)).run();
}

// Real feature 2026-10-03 — matching the business a document says it came
// from to a supplier that ALREADY EXISTS. Pure and deterministic on purpose
// (no AI, no database writes), so it can be tested exhaustively: the AI only
// reads the printed name; whether that name is one of our suppliers is decided
// here, in code. It never creates anything. Legal suffixes and punctuation are
// ignored ("Floornet (Pty) Ltd" is "Floornet"), case is ignored, and a match is
// "exact" when the remaining words are the same set, or "partial" when one
// side's words are wholly contained in the other's. Exact matches win over
// partial ones; more than one candidate at the winning level is reported as
// ambiguous rather than picked.
export interface SupplierCandidate {
  id: number;
  name: string;
}
export type IssuerMatch =
  | { kind: "one"; supplier: SupplierCandidate; strength: "exact" | "partial" }
  | { kind: "many"; suppliers: SupplierCandidate[] }
  | { kind: "none" };

const BUSINESS_NOISE_WORDS = new Set(["pty", "ltd", "limited", "cc", "inc", "incorporated", "proprietary", "co", "company", "the", "and", "of", "sa", "za", "trading", "as"]);

export function businessNameWords(name: string): string[] {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !BUSINESS_NOISE_WORDS.has(w));
}

export function matchIssuerToSuppliers(suppliers: SupplierCandidate[], issuer: string): IssuerMatch {
  const issuerWords = new Set(businessNameWords(issuer));
  if (issuerWords.size === 0) return { kind: "none" };
  const exact: SupplierCandidate[] = [];
  const partial: SupplierCandidate[] = [];
  for (const supplier of suppliers) {
    const words = new Set(businessNameWords(supplier.name));
    if (words.size === 0) continue;
    const sameSize = words.size === issuerWords.size;
    const supplierInIssuer = [...words].every((w) => issuerWords.has(w));
    const issuerInSupplier = [...issuerWords].every((w) => words.has(w));
    if (sameSize && supplierInIssuer) exact.push(supplier);
    else if (supplierInIssuer || issuerInSupplier) partial.push(supplier);
  }
  const pool = exact.length > 0 ? exact : partial;
  if (pool.length === 0) return { kind: "none" };
  if (pool.length > 1) return { kind: "many", suppliers: pool };
  return { kind: "one", supplier: pool[0], strength: exact.length > 0 ? "exact" : "partial" };
}
