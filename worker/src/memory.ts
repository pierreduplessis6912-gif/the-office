// The Memory primitive — anything remembered: captures (the receptacle,
// nothing said is ever lost), customer/character notes, life events,
// structured facts, and Vectorize consolidation. Read-heavy, append-heavy,
// never the source of business decisions on its own.

import { parsePhoneNumberFromString } from "libphonenumber-js";
import type { Env, CustomerNote, LifeEntry, HistoryTurn } from "./types";
import { embedText } from "./ai";
import { holdForConfirmation } from "./finance";


// Fields already promoted to real columns go straight there. Anything
// else goes into the middle-tier holding table — structured, but not
// yet proven common enough across customers to earn its own column.
// This function never promotes a field itself; it can only write to
// the holding table. Promotion only ever happens via a human running
// an actual migration, prompted by the breadth-check below.
export async function applyStructuredFact(
  env: Env,
  customerId: number,
  key: string,
  value: string,
  sourceTranscript: string
): Promise<void> {
  const normalizedKey = key.trim().toLowerCase().replace(/\s+/g, "_");
  try {
    if (normalizedKey === "address") {
      await env.OFFICE_DB.prepare("UPDATE customers SET address = ? WHERE id = ?").bind(value, customerId).run();
      return;
    }

    // Real normalization, always in code — never left to the model's
    // own formatting. Defaults to South Africa since that's the
    // business's actual market; a number already carrying a country
    // code (e.g. "+44...") is respected as given.
    let normalizedValue = value;
    if (normalizedKey === "phone_number") {
      const parsed = parsePhoneNumberFromString(value, "ZA");
      if (parsed?.isValid()) {
        normalizedValue = parsed.formatInternational();
      }
    } else if (normalizedKey === "email") {
      normalizedValue = value.trim().toLowerCase();
    }

    await env.OFFICE_DB.prepare(
      "INSERT INTO customer_facts (customer_id, key, value, source_transcript) VALUES (?, ?, ?, ?)"
    )
      .bind(customerId, normalizedKey, normalizedValue, sourceTranscript)
      .run();
  } catch (err) {
    // This runs in ctx.waitUntil — there is no response left to attach
    // an error to. Log it durably instead of letting it vanish, same
    // discipline as appendCustomerNote and storeUnscopedMemory below.
    try {
      await env.OFFICE_DB.prepare("INSERT INTO memory_errors (customer_id, text, error) VALUES (?, ?, ?)")
        .bind(customerId, `structured fact: ${normalizedKey}=${value}`, err instanceof Error ? err.message : String(err))
        .run();
    } catch {
      // Nothing further to do if even the error log fails.
    }
  }
}

// The primary read path for per-customer lookups now. Instant KV
// read, no async indexing delay — this is what "give me Jenny's
// address" actually reads from moments after it was said.
export async function getCustomerNotes(env: Env, customerId: number): Promise<string[]> {
  try {
    const raw = await env.CUSTOMER_NOTES.get(`customer:${customerId}`);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { facts: CustomerNote[] };
    return parsed.facts.map((f) => f.text);
  } catch {
    return [];
  }
}

// The primary write path now. Instant, per-customer, no async
// indexing delay standing between "Peter said it" and "Peter can ask
// about it." Also queues the same fact into pending_memory_flush for
// later batch consolidation into Vectorize — that side stays
// intentionally slower, since it only serves cross-customer search
// and an unscoped fallback, never same-session recall.
export async function appendCustomerNote(env: Env, customerId: number, text: string): Promise<void> {
  try {
    const key = `customer:${customerId}`;
    const raw = await env.CUSTOMER_NOTES.get(key);
    const existing: { facts: CustomerNote[] } = raw ? JSON.parse(raw) : { facts: [] };
    existing.facts.push({ text, storedAt: new Date().toISOString() });
    await env.CUSTOMER_NOTES.put(key, JSON.stringify(existing));

    await env.OFFICE_DB.prepare("INSERT INTO pending_memory_flush (customer_id, text) VALUES (?, ?)")
      .bind(customerId, text)
      .run();
  } catch (err) {
    try {
      await env.OFFICE_DB.prepare("INSERT INTO memory_errors (customer_id, text, error) VALUES (?, ?, ?)")
        .bind(customerId, text, err instanceof Error ? err.message : String(err))
        .run();
    } catch {
      // Nothing further to do if even the error log fails.
    }
  }
}

// Same instant KV pattern as customer notes, distinct key prefix.
// Deliberately no staging-queue entry for Vectorize consolidation —
// that machinery exists to support cross-customer business search,
// which characters should never appear in.
export async function getCharacterNotes(env: Env, characterId: number): Promise<string[]> {
  try {
    const raw = await env.CUSTOMER_NOTES.get(`character:${characterId}`);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { facts: CustomerNote[] };
    return parsed.facts.map((f) => f.text);
  } catch {
    return [];
  }
}

export async function appendCharacterNote(env: Env, characterId: number, text: string): Promise<void> {
  try {
    const key = `character:${characterId}`;
    const raw = await env.CUSTOMER_NOTES.get(key);
    const existing: { facts: CustomerNote[] } = raw ? JSON.parse(raw) : { facts: [] };
    existing.facts.push({ text, storedAt: new Date().toISOString() });
    await env.CUSTOMER_NOTES.put(key, JSON.stringify(existing));
  } catch (err) {
    try {
      await env.OFFICE_DB.prepare("INSERT INTO memory_errors (customer_id, text, error) VALUES (NULL, ?, ?)")
        .bind(text, err instanceof Error ? err.message : String(err))
        .run();
    } catch {
      // Nothing further to do.
    }
  }
}

// Peter's own life — not a customer, not a job, just a person
// thinking out loud in the truck. Date-keyed, same instant-write
// pattern as customer notes, so "what do I need to do today" is a
// direct KV read, not a search. This is the actual gap named last
// night: the pipeline could hear "Jenny lives at X" perfectly and had
// nowhere at all to put "picking up the wife at 15:30."
export async function appendLifeEvent(env: Env, text: string): Promise<void> {
  try {
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const key = `life:${today}`;
    const raw = await env.CUSTOMER_NOTES.get(key);
    const existing: { facts: LifeEntry[] } = raw ? JSON.parse(raw) : { facts: [] };
    existing.facts.push({ text, storedAt: new Date().toISOString() });
    await env.CUSTOMER_NOTES.put(key, JSON.stringify(existing));
  } catch (err) {
    try {
      await env.OFFICE_DB.prepare("INSERT INTO memory_errors (customer_id, text, error) VALUES (NULL, ?, ?)")
        .bind(text, err instanceof Error ? err.message : String(err))
        .run();
    } catch {
      // Nothing further to do.
    }
  }
}

// Reads the last N days of life events, each tagged with its date so
// the synthesis step can reason about "today" versus "this week"
// correctly rather than treating everything as equally recent.
export async function getRecentLifeEvents(env: Env, days: number): Promise<string[]> {
  const entries: string[] = [];
  const now = new Date();
  for (let i = 0; i < days; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    try {
      const raw = await env.CUSTOMER_NOTES.get(`life:${dateStr}`);
      if (raw) {
        const parsed = JSON.parse(raw) as { facts: LifeEntry[] };
        entries.push(...parsed.facts.map((f) => `[${dateStr}] ${f.text}`));
      }
    } catch {
      // Skip this day on error rather than fail the whole read.
    }
  }
  return entries;
}

// Shared by both /files/audio (after transcription) and /messages/text
// (directly on typed input) — same extraction, reconciliation, guard(),
// and memory logic either way. A transcript is a transcript, whether
// it came from Whisper or a keyboard.
// The receptacle. Every single message lands here, unconditionally,
// the instant it arrives — before extraction even runs, and
// regardless of what extraction later manages or fails to structure
// from it. This is what would have saved Dwayne's measurements: even
// when extraction only pulls out a phone number, the entire real
// sentence still exists verbatim, findable later. Nothing said is
// ever truly lost — it's just not yet understood.
export async function logCapture(env: Env, rawText: string, source: string, r2Key: string | null = null): Promise<number | null> {
  try {
    const inserted = await env.OFFICE_DB.prepare(
      "INSERT INTO captures (raw_text, source, r2_key) VALUES (?, ?, ?) RETURNING id"
    )
      .bind(rawText, source, r2Key)
      .first<{ id: number }>();
    return inserted!.id;
  } catch (err) {
    try {
      await env.OFFICE_DB.prepare("INSERT INTO memory_errors (customer_id, text, error) VALUES (NULL, ?, ?)")
        .bind(`logCapture failed: ${rawText}`, err instanceof Error ? err.message : String(err))
        .run();
    } catch {
      // Nothing further to do.
    }
    return null;
  }
}

// Fills in the real content once it's known — for a photo, the raw
// image itself is what was actually captured (same role a transcript
// plays for voice); the description is already an interpretation, so
// it's enrichment, arriving after, exactly like subject_hint does.
export async function updateCaptureText(env: Env, captureId: number, rawText: string): Promise<void> {
  try {
    await env.OFFICE_DB.prepare("UPDATE captures SET raw_text = ?, extraction_status = 'processed' WHERE id = ?")
      .bind(rawText, captureId)
      .run();
  } catch {
    // Best effort — the row and the real R2 image already exist
    // regardless, which is what actually matters.
  }
}

// Enriches the raw capture with a hint once extraction knows who it
// was about — never required at capture time, only added after. Real
// fix 2026-07-11: this used to store only a loose text string (the
// entity's name), which meant "show me every capture about Jenny"
// needed a fuzzy LIKE match, not a clean join. Now stores the real
// customer_id/character_id alongside the text (kept for quick
// display without a join) — exactly one of the two is ever set, same
// discipline as line_items' quotation_id/invoice_id CHECK constraint.
export async function updateCaptureHint(
  env: Env,
  captureId: number,
  subjectHint: string | null,
  customerId: number | null = null,
  characterId: number | null = null
): Promise<void> {
  try {
    await env.OFFICE_DB.prepare(
      "UPDATE captures SET subject_hint = ?, customer_id = ?, character_id = ?, extraction_status = 'processed' WHERE id = ?"
    )
      .bind(subjectHint, customerId, characterId, captureId)
      .run();
  } catch {
    // Best-effort enrichment — the raw capture already exists
    // regardless, which is the part that actually matters.
  }
}

// Consolidation: drains pending_memory_flush into Vectorize in ONE
// batched upsert instead of many individual ones — the pattern
// Cloudflare's own docs recommend for write-heavy workloads. Also
// runs the schema-candidate breadth-check in the same pass. Shared by
// the real hourly cron and a manual debug trigger for testing today.
export async function runConsolidation(env: Env): Promise<{ flushed: number; schemaCandidates: string[] }> {
  const { results } = await env.OFFICE_DB.prepare(
    "SELECT id, customer_id, text FROM pending_memory_flush ORDER BY id LIMIT 500"
  ).all<{ id: number; customer_id: number | null; text: string }>();

  let flushed = 0;
  if (results.length > 0) {
    try {
      const vectors = await Promise.all(
        results.map(async (row) => ({
          id: crypto.randomUUID(),
          values: await embedText(env, row.text),
          metadata: {
            customerId: row.customer_id != null ? String(row.customer_id) : "",
            text: row.text,
            createdAt: new Date().toISOString(),
          },
        }))
      );
      await env.MEMORY.upsert(vectors);
      flushed = vectors.length;

      const ids = results.map((r) => r.id);
      await env.OFFICE_DB.prepare(`DELETE FROM pending_memory_flush WHERE id IN (${ids.map(() => "?").join(",")})`)
        .bind(...ids)
        .run();
    } catch (err) {
      await env.OFFICE_DB.prepare("INSERT INTO memory_errors (customer_id, text, error) VALUES (NULL, ?, ?)")
        .bind(`consolidation batch of ${results.length}`, err instanceof Error ? err.message : String(err))
        .run();
    }
  }

  // Breadth-check: any key in the holding table now common enough
  // across distinct customers to be worth a real column? This never
  // executes a migration — only proposes, via the same pending_action
  // mechanism as a payment, so a human always makes the actual call.
  const schemaCandidates: string[] = [];
  const { results: breadthResults } = await env.OFFICE_DB.prepare(
    "SELECT key, COUNT(DISTINCT customer_id) as breadth FROM customer_facts GROUP BY key HAVING breadth >= 5"
  ).all<{ key: string; breadth: number }>();

  for (const row of breadthResults) {
    const existingCandidate = await env.OFFICE_DB.prepare(
      "SELECT id FROM pending_actions WHERE type = 'schema_candidate' AND json_extract(payload, '$.key') = ? AND status = 'pending'"
    )
      .bind(row.key)
      .first();

    if (!existingCandidate) {
      await holdForConfirmation(
        env,
        "schema_candidate",
        { key: row.key, breadth: row.breadth },
        `Auto-detected: "${row.key}" now recorded for ${row.breadth} distinct customers — worth its own column?`
      );
      schemaCandidates.push(row.key);
    }
  }

  return { flushed, schemaCandidates };
}
