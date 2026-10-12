// A business's own Durable Object: the application running NEXT TO that business's data.
//
// Architecture stage 1, 2026-10-12 (DECISIONS.md, "Database architecture"). The object holds one business's private data in its own SQLite and runs the application's real request
// pipeline (the same `serveRequest` the Worker runs today: front door, timing, admin audit, CORS, every route) with the database swapped for this object's storage, through the
// D1-compatible adapter. Every query is then local, which is where the latency win measured in the trial comes from. Nothing here is a second copy of the application.
//
// On its first wake the object creates its tables from the baseline schema; on EVERY wake it applies the indexes (idempotent, and it picks up tables that were created on first use
// since the last wake). The Worker forwards to an object only when BUSINESS_MODE is "object" and the object exists; otherwise nothing changes.
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

// Takes the application's request pipeline so this file never imports the (huge) entry module: the entry module hands its own pipeline in.
export function makeBusinessObject(serve: Serve) {
  return class BusinessObject {
    db: DoD1Database;
    env: Env;
    state: DurableObjectState;
    ready: Promise<void>;
    businessId: string | null = null;

    constructor(state: DurableObjectState, env: Env) {
      this.state = state;
      this.env = env;
      this.db = new DoD1Database(state.storage.sql as unknown as SqlStorageLike, state.storage as unknown as StorageLike);
      // Nothing is served until the tables exist: blockConcurrencyWhile holds every incoming request until this finishes.
      this.ready = state.blockConcurrencyWhile(async () => {
        await ensureObjectSchema(this.db, env);
      });
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
      // The notes store, the file storage and the memory index are shared by every business, so each is confined to this business (scoped-bindings.ts).
      const objectEnv = scopeBindings({ ...this.env, OFFICE_DB: this.db as unknown as D1Database, BUSINESS_ID: claimed } as Env, claimed);
      const ctx = { waitUntil: (p: Promise<unknown>) => this.state.waitUntil(p), passThroughOnException: () => undefined } as unknown as ExecutionContext;
      return serve(request, objectEnv, ctx);
    }
  };
}
