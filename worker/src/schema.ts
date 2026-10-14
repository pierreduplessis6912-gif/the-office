// Changing a business's database over time: ordered schema steps, each applied ONCE.
//
// Added 2026-10-14 (SHIP_CHECKLIST.md item 8). A business's object used to create its tables from the baseline on first wake and re-apply the baseline when a version number was bumped, which can never ADD A
// COLUMN to a table that already exists (CREATE TABLE IF NOT EXISTS does nothing for it); the README of worker/migrations said so plainly: "applied by hand for now (there's no automated runner yet)". This
// is that runner. With many businesses, every future change to the schema has to reach every object, once, in order, and a failure has to be VISIBLE.
//
// How it works. The steps are the files in worker/migrations (the single source of truth; the single-business deployment applies the same files with wrangler), generated into schema-steps.ts. Each object
// records every step it has applied in its own `schema_steps` table, and on every wake applies the steps it has not yet applied, in order. A STEP IS ATOMIC: its statements and the record that it was applied
// go in one transaction, so a step that fails leaves nothing half-done. A failure is REPORTED, not thrown (an exception in the constructor would crash-loop the object): the object records the error, refuses
// everything but admin calls with a clear 503, and retries every hour and on demand. An `ALTER TABLE ... ADD COLUMN` for a column that already exists (the application used to add columns lazily at request
// time) is skipped, not an error. Steps must be ADDITIVE (a test refuses DROP, DELETE, TRUNCATE and RENAME), so a deploy can be rolled back to older code while objects are on newer steps.
import type { DoD1Database } from "./storage/do-d1";

export interface SchemaStep {
  version: number;
  name: string;
  sql: string;
}
export interface SchemaOutcome {
  applied: string[];      // steps applied by THIS run
  pending: string[];      // steps still not applied (because of an error)
  unknownApplied: number; // steps this object has applied that this code does not know (a deploy rolled back to older code)
  legacySeeded: boolean;  // an object from before this runner, recognised as already having step 1
  error: { name: string; message: string } | null;
}

// The steps are plain statements with no triggers and no semicolons inside strings, so splitting on ";" is safe (a test pins that).
export function splitStatements(sql: string): string[] {
  const withoutComments = sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
  return withoutComments
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

const ADD_COLUMN = /^ALTER\s+TABLE\s+"?([A-Za-z_][A-Za-z0-9_]*)"?\s+ADD\s+COLUMN\s+"?([A-Za-z_][A-Za-z0-9_]*)"?/i;
const messageOf = (error: unknown): string => String((error as { message?: string } | null)?.message ?? error).slice(0, 300);

// A column that is already there (added lazily by the application before this runner existed) makes the statement a no-op, not a failure.
async function alreadyDone(db: DoD1Database, statement: string): Promise<boolean> {
  const match = ADD_COLUMN.exec(statement);
  if (!match) return false;
  const { results } = await db.prepare(`PRAGMA table_info("${match[1]}")`).all<{ name: string }>();
  return (results ?? []).some((c) => c.name.toLowerCase() === match[2].toLowerCase());
}

export async function migrateSchema(db: DoD1Database, steps: SchemaStep[], now: Date = new Date()): Promise<SchemaOutcome> {
  const outcome: SchemaOutcome = { applied: [], pending: [], unknownApplied: 0, legacySeeded: false, error: null };
  const ordered = [...steps].sort((a, b) => a.version - b.version);
  try {
    await db.exec("CREATE TABLE IF NOT EXISTS object_meta (key TEXT PRIMARY KEY, value TEXT)");
    await db.exec("CREATE TABLE IF NOT EXISTS schema_steps (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
    const have = new Set(((await db.prepare("SELECT version FROM schema_steps").all<{ version: number }>()).results ?? []).map((r) => Number(r.version)));
    // An object from before this runner has only `schema_version` in its bookkeeping: that number meant "the baseline is applied".
    if (have.size === 0) {
      const legacy = Number((await db.prepare("SELECT value FROM object_meta WHERE key = 'schema_version'").first<{ value: string }>())?.value ?? 0);
      const baseline = ordered.find((s) => s.version === 1);
      if (legacy >= 1 && baseline) {
        await db.prepare("INSERT INTO schema_steps (version, name, applied_at) VALUES (1, ?, ?)").bind(baseline.name, now.toISOString()).run();
        have.add(1);
        outcome.legacySeeded = true;
      }
    }
    outcome.unknownApplied = [...have].filter((v) => !ordered.some((s) => s.version === v)).length;
    const todo = ordered.filter((s) => !have.has(s.version));
    for (let i = 0; i < todo.length; i++) {
      const step = todo[i];
      try {
        const statements = [];
        for (const sql of splitStatements(step.sql)) if (!(await alreadyDone(db, sql))) statements.push(db.prepare(sql));
        statements.push(db.prepare("INSERT INTO schema_steps (version, name, applied_at) VALUES (?, ?, ?)").bind(step.version, step.name, now.toISOString()));
        await db.batch(statements);   // ONE transaction: the step and the record that it was applied
        outcome.applied.push(step.name);
      } catch (error) {
        outcome.error = { name: step.name, message: messageOf(error) };
        outcome.pending = todo.slice(i).map((s) => s.name);
        break;
      }
    }
  } catch (error) {
    outcome.error = { name: "schema runner", message: messageOf(error) };
    outcome.pending = ordered.map((s) => s.name);
  }
  return outcome;
}
