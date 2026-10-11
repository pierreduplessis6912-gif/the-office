// Where does the time go? A per-request breakdown of time spent waiting on the model, the database and the other stores.
//
// Added 2026-10-04 after Pierre noticed latency in phone tests. Measured then (DECISIONS.md, "Performance check"): the work of that session added no model
// calls and about 0.9% more database calls, so it could not honestly be blamed, and the real cause was unknown. This is how it gets found: every request
// is timed per kind of call, the totals go into the existing "request end" log line, and a short rolling history is kept so GET /debug/timings (admin key)
// can say, per route, how long requests take and how much of that is the model versus the database.
//
// Safe by construction. It is OFF unless the variable RECORD_TIMINGS is "1" (set in wrangler.toml), so the tests and any other environment run exactly as
// before. It only ever OBSERVES: a wrapper times a call and returns exactly what the call returned or threw. The history is written after the response
// has gone (ctx.waitUntil), so it cannot slow a request, and only for requests that change something (a message, a file, a confirmation), never for the
// app's constant reading. Times are SUMMED across calls, so calls that overlap can add up to more than the request took.
import type { Env } from "./types";

export type Kind = "ai" | "db" | "kv" | "vec" | "r2";
export type Tally = Record<Kind, { n: number; ms: number }>;

export function newTally(): Tally {
  return { ai: { n: 0, ms: 0 }, db: { n: 0, ms: 0 }, kv: { n: 0, ms: 0 }, vec: { n: 0, ms: 0 }, r2: { n: 0, ms: 0 } };
}

// Wraps a binding so each awaited call is counted and timed. `prepare` and `bind` build a statement and do no work, so they are wrapped but not counted;
// the call that actually goes to the database (first, all, run, raw, batch, exec) is the one that is.
function timed<T extends object>(target: T, kind: Kind, tally: Tally): T {
  return new Proxy(target, {
    get(t, key) {
      const value = Reflect.get(t, key, t);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const started = Date.now();
        const result = (value as (...a: unknown[]) => unknown).apply(t, args);
        if (result && typeof (result as { then?: unknown }).then === "function") {
          const done = () => {
            tally[kind].n += 1;
            tally[kind].ms += Date.now() - started;
          };
          return (result as Promise<unknown>).then(
            (v) => {
              done();
              return v;
            },
            (e) => {
              done();
              throw e;
            }
          );
        }
        if (result && typeof result === "object" && (key === "prepare" || key === "bind")) return timed(result as object, kind, tally);
        return result;
      };
    },
  });
}

export function instrumentEnv(env: Env, tally: Tally): Env {
  return {
    ...env,
    AI: timed(env.AI, "ai", tally),
    OFFICE_DB: timed(env.OFFICE_DB, "db", tally),
    CUSTOMER_NOTES: timed(env.CUSTOMER_NOTES, "kv", tally),
    MEMORY: timed(env.MEMORY, "vec", tally),
    OFFICE_VAULT: timed(env.OFFICE_VAULT, "r2", tally),
  };
}

export function breakdown(tally: Tally): Record<string, number> {
  return {
    aiCalls: tally.ai.n,
    aiMs: tally.ai.ms,
    dbCalls: tally.db.n,
    dbMs: tally.db.ms,
    kvCalls: tally.kv.n,
    kvMs: tally.kv.ms,
    vecCalls: tally.vec.n,
    vecMs: tally.vec.ms,
    r2Calls: tally.r2.n,
    r2Ms: tally.r2.ms,
  };
}

// Only requests that change something are kept: a message, a file, a confirmation. Never the app's constant reading, and never this route itself.
export function shouldRecordTiming(method: string, pathname: string): boolean {
  if (pathname === "/debug/timings") return false;
  return method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
}

// /actions/123/confirm and /actions/456/confirm are the same route.
export function normalizeTimingPath(pathname: string): string {
  return pathname.replace(/\/\d+(?=\/|$)/g, "/:id");
}

const TIMINGS_DDL =
  "CREATE TABLE IF NOT EXISTS request_timings (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL DEFAULT (datetime('now')), method TEXT NOT NULL, path TEXT NOT NULL, status INTEGER NOT NULL, total_ms INTEGER NOT NULL, ai_n INTEGER NOT NULL, ai_ms INTEGER NOT NULL, db_n INTEGER NOT NULL, db_ms INTEGER NOT NULL, kv_n INTEGER NOT NULL, kv_ms INTEGER NOT NULL, vec_n INTEGER NOT NULL, vec_ms INTEGER NOT NULL, r2_n INTEGER NOT NULL, r2_ms INTEGER NOT NULL)";
export const TIMINGS_KEEP = 1000;

// Called with the ORIGINAL env (never the timed one, so recording does not time itself) and only through ctx.waitUntil, after the response has gone.
export async function recordTiming(
  env: Env,
  row: { method: string; pathname: string; status: number; totalMs: number; tally: Tally },
  keep: number = TIMINGS_KEEP
): Promise<void> {
  await env.OFFICE_DB.prepare(TIMINGS_DDL).run();
  const t = row.tally;
  await env.OFFICE_DB.prepare(
    "INSERT INTO request_timings (method, path, status, total_ms, ai_n, ai_ms, db_n, db_ms, kv_n, kv_ms, vec_n, vec_ms, r2_n, r2_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  )
    .bind(row.method, normalizeTimingPath(row.pathname), row.status, row.totalMs, t.ai.n, t.ai.ms, t.db.n, t.db.ms, t.kv.n, t.kv.ms, t.vec.n, t.vec.ms, t.r2.n, t.r2.ms)
    .run();
  await env.OFFICE_DB.prepare("DELETE FROM request_timings WHERE id <= (SELECT MAX(id) FROM request_timings) - ?").bind(keep).run();
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}
const mean = (xs: number[]): number => (xs.length === 0 ? 0 : Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10);

interface TimingRow {
  created_at: string;
  method: string;
  path: string;
  status: number;
  total_ms: number;
  ai_n: number;
  ai_ms: number;
  db_n: number;
  db_ms: number;
  kv_ms: number;
  vec_ms: number;
  r2_ms: number;
}

export async function timingsSummary(env: Env, limit = 300): Promise<Record<string, unknown>> {
  let rows: TimingRow[] = [];
  try {
    const { results } = await env.OFFICE_DB.prepare(
      "SELECT created_at, method, path, status, total_ms, ai_n, ai_ms, db_n, db_ms, kv_ms, vec_ms, r2_ms FROM request_timings ORDER BY id DESC LIMIT ?"
    )
      .bind(limit)
      .all<TimingRow>();
    rows = results ?? [];
  } catch (error) {
    if (!/no such table/i.test(String((error as { message?: string } | null)?.message ?? error))) throw error;   // nothing recorded yet
  }
  const byPath = new Map<string, TimingRow[]>();
  for (const r of rows) byPath.set(`${r.method} ${r.path}`, [...(byPath.get(`${r.method} ${r.path}`) ?? []), r]);
  return {
    enabled: env.RECORD_TIMINGS === "1",
    requests: rows.length,
    from: rows.length ? rows[rows.length - 1].created_at : null,
    to: rows.length ? rows[0].created_at : null,
    note: "Times are in milliseconds and SUMMED across calls, so calls that overlap can add up to more than the request took. 'other' is notes store, memory search and file storage.",
    byPath: [...byPath.entries()]
      .map(([route, rs]) => {
        const totals = rs.map((r) => r.total_ms).sort((a, b) => a - b);
        return {
          route,
          n: rs.length,
          p50Ms: percentile(totals, 0.5),
          p95Ms: percentile(totals, 0.95),
          meanAiMs: mean(rs.map((r) => r.ai_ms)),
          meanAiCalls: mean(rs.map((r) => r.ai_n)),
          meanDbMs: mean(rs.map((r) => r.db_ms)),
          meanDbCalls: mean(rs.map((r) => r.db_n)),
          meanOtherMs: mean(rs.map((r) => r.kv_ms + r.vec_ms + r.r2_ms)),
        };
      })
      .sort((a, b) => b.p95Ms - a.p95Ms),
    slowest: [...rows]
      .sort((a, b) => b.total_ms - a.total_ms)
      .slice(0, 10)
      .map((r) => ({ at: r.created_at, route: `${r.method} ${r.path}`, status: r.status, totalMs: r.total_ms, aiMs: r.ai_ms, aiCalls: r.ai_n, dbMs: r.db_ms, dbCalls: r.db_n })),
  };
}
