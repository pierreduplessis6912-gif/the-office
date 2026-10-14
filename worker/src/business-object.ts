// A business's own Durable Object: the application running NEXT TO that business's data.
//
// Architecture stage 1, 2026-10-12 (DECISIONS.md, "Database architecture"). The object holds one business's private data in its own SQLite and runs the application's real request
// pipeline (the same `serveRequest` the Worker runs today: front door, timing, admin audit, CORS, every route) with the database swapped for this object's storage, through the
// D1-compatible adapter. Every query is then local, which is where the latency win measured in the trial comes from. Nothing here is a second copy of the application.
//
// On its first wake the object creates its tables from the baseline schema; on EVERY wake it applies the indexes (idempotent, and it picks up tables that were created on first use
// since the last wake). The Worker forwards to an object only when BUSINESS_MODE is "object" and the object exists; otherwise nothing changes.
import { isAdminPath } from "./auth";
import { readBackupMeta, recordBackupResult } from "./backup";
import { scopeBindings } from "./scoped-bindings";
import { isBusinessId } from "./directory";
import { BASELINE_SQL } from "./baseline-sql";
import { applyIndexes, type IndexReport } from "./indexes";
import { DoD1Database, type SqlStorageLike, type StorageLike } from "./storage/do-d1";
import type { Env } from "./types";

// Bump when the baseline (or a later schema step added here) changes, so existing objects pick it up on their next wake.
export const SCHEMA_VERSION = 1;

// The baseline is a list of CREATE TABLE IF NOT EXISTS statements with no triggers and no semicolons inside strings, so splitting on ";" is safe (a test pins that).
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

export interface SchemaReport {
  appliedBaseline: boolean;
  indexes: IndexReport;
}

export async function ensureObjectSchema(db: DoD1Database, env: Env): Promise<SchemaReport> {
  await db.exec("CREATE TABLE IF NOT EXISTS object_meta (key TEXT PRIMARY KEY, value TEXT)");
  const row = await db.prepare("SELECT value FROM object_meta WHERE key = 'schema_version'").first<{ value: string }>();
  let appliedBaseline = false;
  if (Number(row?.value ?? 0) < SCHEMA_VERSION) {
    for (const statement of splitStatements(BASELINE_SQL)) await db.prepare(statement).run();   // each is CREATE TABLE IF NOT EXISTS, so safe to repeat
    await db.prepare("INSERT INTO object_meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(String(SCHEMA_VERSION)).run();
    appliedBaseline = true;
  }
  const indexes = await applyIndexes({ ...env, OFFICE_DB: db as unknown as D1Database } as Env);
  return { appliedBaseline, indexes };
}

type Serve = (request: Request, env: Env, ctx: ExecutionContext) => Promise<Response>;
// What a business's object does by itself, once an hour (the application's own consolidation: flushing pending memories into the memory index). Handed in by the entry module, like the pipeline.
export interface BusinessJobs {
  consolidate: (env: Env) => Promise<unknown>;
  // The daily snapshot (backup.ts). Run from the hourly alarm when more than BACKUP_EVERY_MS have passed since the last success.
  backup?: (env: Env) => Promise<unknown>;
}

export const BACKUP_EVERY_MS = 20 * 3_600_000;

const HOUR_MS = 3_600_000;
// Each business's hourly job is spread across the hour by its name, so a thousand businesses do not all wake at the same minute.
export const jitterMs = (businessId: string): number => {
  let h = 0;
  for (const c of businessId) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return (h % 3000) * 1000;
};

// Takes the application's request pipeline so this file never imports the (huge) entry module: the entry module hands its own pipeline in.
export function makeBusinessObject(serve: Serve, jobs?: BusinessJobs) {
  return class BusinessObject {
    db: DoD1Database;
    env: Env;
    state: DurableObjectState;
    ready: Promise<void>;
    businessId: string | null = null;
    alarmChecked = false;

    constructor(state: DurableObjectState, env: Env) {
      this.state = state;
      this.env = env;
      this.db = new DoD1Database(state.storage.sql as unknown as SqlStorageLike, state.storage as unknown as StorageLike);
      // Nothing is served until the tables exist: blockConcurrencyWhile holds every incoming request until this finishes.
      this.ready = state.blockConcurrencyWhile(async () => {
        await ensureObjectSchema(this.db, env);
      });
    }

    // Runs the application's hourly job INSIDE this business's object: its own database, and the memory index and notes store confined to this business. Whatever happens, the next alarm is armed, so one
    // failure cannot stop a business's memories for good (and a failing job cannot retry in a tight loop).
    async alarm(): Promise<void> {
      await this.ready;
      // The hourly job's outcome is RECORDED in the object (health.ts reads it), so a job that fails or stops is visible, not silent.
      const jobStarted = Date.now();
      let jobRan = false;
      let jobError: string | null = null;
      try {
        const named = this.businessId ?? (await this.db.prepare("SELECT value FROM object_meta WHERE key = 'business_id'").first<{ value: string }>())?.value ?? null;
        if (jobs && isBusinessId(named)) {
          jobRan = true;
          await jobs.consolidate(scopeBindings({ ...this.env, OFFICE_DB: this.db as unknown as D1Database, BUSINESS_ID: named } as Env, named));
        }
      } catch (error) {
        jobError = String((error as { message?: string } | null)?.message ?? error).slice(0, 300);
        console.error(JSON.stringify({ level: "error", message: "a business's hourly job failed", error: String((error as { message?: string } | null)?.message ?? error) }));
      }
      if (jobRan) {
        try {
          await this.setMeta("last_job_at", new Date().toISOString());
          await this.setMeta("last_job_ok", jobError === null ? "1" : "0");
          await this.setMeta("last_job_error", jobError ?? "");
          await this.setMeta("last_job_ms", String(Date.now() - jobStarted));
        } catch {
          // recording must never stop the job or the next alarm
        }
      }
      // The daily backup is separate from the hourly job: neither can stop the other, and a failed backup is RECORDED (so an alert can see it) and tried again next hour.
      try {
        const named = this.businessId;
        if (jobs?.backup && this.env.BACKUPS && isBusinessId(named)) {
          const last = Date.parse((await readBackupMeta({ ...this.env, OFFICE_DB: this.db as unknown as D1Database } as Env)).lastSuccessAt ?? "");
          if (!Number.isFinite(last) || Date.now() - last >= BACKUP_EVERY_MS) {
            const env = scopeBindings({ ...this.env, OFFICE_DB: this.db as unknown as D1Database, BUSINESS_ID: named } as Env, named);
            try { await jobs.backup(env); await recordBackupResult(env, null); } catch (error) { await recordBackupResult(env, String((error as { message?: string } | null)?.message ?? error).slice(0, 300)); throw error; }
          }
        }
      } catch (error) {
        console.error(JSON.stringify({ level: "error", message: "a business's daily backup failed", error: String((error as { message?: string } | null)?.message ?? error) }));
      } finally {
        const next = Date.now() + HOUR_MS;
        await this.state.storage.setAlarm(next);
        await this.setMeta("next_alarm_at", new Date(next).toISOString()).catch(() => undefined);
      }
    }

    private async setMeta(key: string, value: string): Promise<void> {
      await this.db.prepare("INSERT INTO object_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(key, value).run();
    }

    async fetch(request: Request): Promise<Response> {
      await this.ready;
      // The Worker names the business on every request it forwards (and overwrites anything a client sent). An object belongs to exactly ONE business: the first name it is given is
      // remembered, and a request naming any other is refused, so even a routing mistake in the Worker cannot make an object serve the wrong business.
      const claimed = request.headers.get("X-Business-Id");
      if (!isBusinessId(claimed)) return Response.json({ error: "no business named" }, { status: 400 });
      if (this.businessId === null) {
        const known = (await this.db.prepare("SELECT value FROM object_meta WHERE key = 'business_id'").first<{ value: string }>())?.value ?? null;
        if (known === null) await this.db.prepare("INSERT INTO object_meta (key, value) VALUES ('business_id', ?)").bind(claimed).run();
        this.businessId = known ?? claimed;
      }
      if (this.businessId !== claimed) return Response.json({ error: "this object belongs to another business" }, { status: 403 });
      // While a restore is running, everyone but an administrator is turned away: a half-replaced business must not be read or written.
      if (!isAdminPath(new URL(request.url).pathname) && (await this.db.prepare("SELECT value FROM object_meta WHERE key = 'restoring'").first<{ value: string }>())?.value === "1") {
        return Response.json({ error: "This business is being restored from a backup and is unavailable for a few minutes. Please try again shortly.", restoring: true, retryAfterSeconds: 60 }, { status: 503, headers: { "Retry-After": "60" } });
      }
      // The hourly job: an object that has been named arms its own alarm once (nothing runs for a business nobody has used).
      if (jobs && !this.alarmChecked) {
        const existing = await this.state.storage.getAlarm();
        if (existing === null) {
          const first = Date.now() + jitterMs(claimed) + 60_000;
          await this.state.storage.setAlarm(first);
          await this.setMeta("next_alarm_at", new Date(first).toISOString()).catch(() => undefined);
        } else {
          // An alarm armed BEFORE this was recorded (an object that was already running) is recorded now, so the health report can see when it will run. Found by the first real staging run.
          await this.setMeta("next_alarm_at", new Date(existing).toISOString()).catch(() => undefined);
        }
        this.alarmChecked = true;
      }
      // The notes store, the file storage and the memory index are shared by every business, so each is confined to this business (scoped-bindings.ts).
      const objectEnv = scopeBindings({ ...this.env, OFFICE_DB: this.db as unknown as D1Database, SHARED_DB: this.env.OFFICE_DB, BUSINESS_ID: claimed } as Env, claimed);
      const ctx = { waitUntil: (p: Promise<unknown>) => this.state.waitUntil(p), passThroughOnException: () => undefined } as unknown as ExecutionContext;
      return serve(request, objectEnv, ctx);
    }
  };
}
