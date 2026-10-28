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
// What the model REPORTS it used (Workers AI returns `usage` on a chat call, including `neurons`, Cloudflare's billing unit: $0.011 per 1,000 above 10,000 a day for the whole account). Until 2026-10-14 this
// was thrown away. `calls` counts the calls that reported usage (an embedding call reports none); `failures` counts calls that threw.
export interface ModelUsage {
  calls: number;
  failures: number;
  prompt: number;
  completion: number;
  cached: number;
  neurons: number;
}
// One model call, for the per-call detail: which prompt (the first words of its fixed system prompt, never any message text), when it started and ended (ms from the request's first call
// timing), and whether it threw. A retry shows as a second call with the same prompt after a failed one.
export interface AiCallDetail { p: string; s: number; e: number; ok: boolean }
export type Tally = Record<Kind, { n: number; ms: number }> & { usage: ModelUsage; aiCalls: AiCallDetail[]; t0: number };
const MAX_CALL_DETAIL = 12;
const SYSTEM_ROLE = "system";
const promptOf = (inputs: unknown): string => {
  try {
    const messages = (inputs as { messages?: Array<{ role?: string; content?: unknown }> } | null)?.messages ?? [];
    const system = messages.find((m) => m?.role === SYSTEM_ROLE);
    return typeof system?.content === "string" ? system.content.replace(/\s+/g, " ").slice(0, 48) : "(no system prompt)";
  } catch { return "(unreadable)"; }
};

export function newTally(): Tally {
  return { ai: { n: 0, ms: 0 }, db: { n: 0, ms: 0 }, kv: { n: 0, ms: 0 }, vec: { n: 0, ms: 0 }, r2: { n: 0, ms: 0 }, usage: { calls: 0, failures: 0, prompt: 0, completion: 0, cached: 0, neurons: 0 }, aiCalls: [], t0: Date.now() };
}

// Reads what a model call says it used. Anything that is not a plain non-negative number counts as nothing, and a response with no `usage` (an embedding) adds nothing.
function addUsage(total: ModelUsage, response: unknown): void {
  const u = (response as { usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; neurons?: unknown; prompt_tokens_details?: { cached_tokens?: unknown } } } | null | undefined)?.usage;
  if (!u || typeof u !== "object") return;
  const num = (x: unknown): number => (typeof x === "number" && Number.isFinite(x) && x >= 0 ? x : 0);
  total.calls += 1;
  total.prompt += num(u.prompt_tokens);
  total.completion += num(u.completion_tokens);
  total.cached += num(u.prompt_tokens_details?.cached_tokens);
  total.neurons += num(u.neurons);
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
          const prompt = kind === "ai" && key === "run" && tally.aiCalls.length < MAX_CALL_DETAIL ? promptOf(args[1]) : null;
          const done = (ok: boolean = true) => {
            tally[kind].n += 1;
            tally[kind].ms += Date.now() - started;
            if (prompt !== null) tally.aiCalls.push({ p: prompt, s: started - tally.t0, e: Date.now() - tally.t0, ok });
          };
          return (result as Promise<unknown>).then(
            (v) => {
              done();
              if (kind === "ai") addUsage(tally.usage, v);
              return v;
            },
            (e) => {
              done(false);
              if (kind === "ai") tally.usage.failures += 1;
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

export function instrumentEnv(env: Env, tally: Tally, only?: Kind): Env {
  // A binding that is not there (a local run without the model or the memory index, a deployment that does not use one) is left as it is. Found 2026-10-12 by the first end-to-end run of
  // a business object: wrapping an absent binding made EVERY request fail, so timing could take a whole Worker down.
  // `only` wraps just one kind of binding (usage metering needs only the model; the full timing wraps them all).
  const wrap = <T extends object>(binding: T, kind: Kind): T => (binding && (!only || only === kind) ? timed(binding, kind, tally) : binding);
  return {
    ...env,
    AI: wrap(env.AI, "ai"),
    OFFICE_DB: wrap(env.OFFICE_DB, "db"),
    CUSTOMER_NOTES: wrap(env.CUSTOMER_NOTES, "kv"),
    MEMORY: wrap(env.MEMORY, "vec"),
    OFFICE_VAULT: wrap(env.OFFICE_VAULT, "r2"),
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
  "CREATE TABLE IF NOT EXISTS request_timings (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL DEFAULT (datetime('now')), method TEXT NOT NULL, path TEXT NOT NULL, status INTEGER NOT NULL, total_ms INTEGER NOT NULL, ai_n INTEGER NOT NULL, ai_ms INTEGER NOT NULL, db_n INTEGER NOT NULL, db_ms INTEGER NOT NULL, kv_n INTEGER NOT NULL, kv_ms INTEGER NOT NULL, vec_n INTEGER NOT NULL, vec_ms INTEGER NOT NULL, r2_n INTEGER NOT NULL, r2_ms INTEGER NOT NULL, ai_calls TEXT)";
// A table made before per-call detail has no column for it: added once per process (a repeated attempt is harmless: the error is swallowed).
let aiCallsColumnChecked = false;
async function ensureAiCallsColumn(env: Env): Promise<void> {
  if (aiCallsColumnChecked) return;
  try { await env.OFFICE_DB.prepare("ALTER TABLE request_timings ADD COLUMN ai_calls TEXT").run(); aiCallsColumnChecked = true; }
  catch (error) { if (/duplicate column/i.test(String((error as { message?: string } | null)?.message ?? error))) aiCallsColumnChecked = true; }   // any other failure (no table yet, a hiccup) is tried again next time
}
export const TIMINGS_KEEP = 1000;

// Called with the ORIGINAL env (never the timed one, so recording does not time itself) and only through ctx.waitUntil, after the response has gone.
export async function recordTiming(
  env: Env,
  row: { method: string; pathname: string; status: number; totalMs: number; tally: Tally },
  keep: number = TIMINGS_KEEP
): Promise<void> {
  await env.OFFICE_DB.prepare(TIMINGS_DDL).run();
  await ensureAiCallsColumn(env);
  const t = row.tally;
  await env.OFFICE_DB.prepare(
    "INSERT INTO request_timings (method, path, status, total_ms, ai_n, ai_ms, db_n, db_ms, kv_n, kv_ms, vec_n, vec_ms, r2_n, r2_ms, ai_calls) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  )
    .bind(row.method, normalizeTimingPath(row.pathname), row.status, row.totalMs, t.ai.n, t.ai.ms, t.db.n, t.db.ms, t.kv.n, t.kv.ms, t.vec.n, t.vec.ms, t.r2.n, t.r2.ms, t.aiCalls.length ? JSON.stringify(t.aiCalls) : null)
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
  ai_calls: string | null;
}

const callsOf = (r: TimingRow): AiCallDetail[] => {
  try { const v = r.ai_calls ? JSON.parse(r.ai_calls) : []; return Array.isArray(v) ? v.filter((c) => c && typeof c.p === "string" && Number.isFinite(c.s) && Number.isFinite(c.e)) : []; } catch { return []; }
};
// How long the model calls took as the clock on the wall saw it (first start to last end), and whether any two overlapped. Compare with the SUMMED model time: the gap is the overlap.
const wallOf = (calls: AiCallDetail[]): { wallMs: number; overlapped: boolean } => {
  if (calls.length === 0) return { wallMs: 0, overlapped: false };
  const sorted = [...calls].sort((a, b) => a.s - b.s);
  return { wallMs: Math.max(...sorted.map((c) => c.e)) - sorted[0].s, overlapped: sorted.some((c, k) => k > 0 && c.s < sorted[k - 1].e) };
};

// Per model prompt over the recent requests: how many calls, mean and slowest duration, how many threw. Retries are calls that follow a failed call with the same prompt.
function byPromptOf(rows: TimingRow[]): Array<{ prompt: string; calls: number; meanMs: number; maxMs: number; failures: number }> {
  const by = new Map<string, number[]>(); const failed = new Map<string, number>();
  for (const r of rows) for (const c of callsOf(r)) { by.set(c.p, [...(by.get(c.p) ?? []), c.e - c.s]); if (!c.ok) failed.set(c.p, (failed.get(c.p) ?? 0) + 1); }
  return [...by.entries()].map(([prompt, ms]) => ({ prompt, calls: ms.length, meanMs: mean(ms), maxMs: Math.max(...ms), failures: failed.get(prompt) ?? 0 })).sort((a, b) => b.meanMs * b.calls - a.meanMs * a.calls);
}

export async function timingsSummary(env: Env, limit = 300): Promise<Record<string, unknown>> {
  let rows: TimingRow[] = [];
  try {
    await ensureAiCallsColumn(env).catch(() => undefined);
    const { results } = await env.OFFICE_DB.prepare(
      "SELECT created_at, method, path, status, total_ms, ai_n, ai_ms, db_n, db_ms, kv_ms, vec_ms, r2_ms, ai_calls FROM request_timings ORDER BY id DESC LIMIT ?"
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
          meanAiWallMs: mean(rs.map((r) => wallOf(callsOf(r)).wallMs)),
          requestsWithOverlappingModelCalls: rs.filter((r) => wallOf(callsOf(r)).overlapped).length,
          requestsWithAFailedModelCall: rs.filter((r) => callsOf(r).some((c) => !c.ok)).length,
        };
      })
      .sort((a, b) => b.p95Ms - a.p95Ms),
    slowest: [...rows]
      .sort((a, b) => b.total_ms - a.total_ms)
      .slice(0, 10)
      .map((r) => ({ at: r.created_at, route: `${r.method} ${r.path}`, status: r.status, totalMs: r.total_ms, aiMs: r.ai_ms, aiCalls: r.ai_n, dbMs: r.db_ms, dbCalls: r.db_n, modelCalls: callsOf(r).map((c) => ({ prompt: c.p, startMs: c.s, endMs: c.e, ok: c.ok })) })),
    byPrompt: byPromptOf(rows),
  };
}

// The MCP connector's traffic is all POST /mcp, so reads and writes would blend into one row. A tool call is labelled with the tool's NAME ("/mcp:tell_the_office"). Only the name, and only if it
// is a plain tool name: never an argument, never any text of the call. Anything else (a malformed body, another JSON-RPC method) stays "/mcp".
export function mcpTimingPath(body: string | null | undefined): string {
  try {
    const parsed = JSON.parse(body ?? "") as { method?: unknown; params?: { name?: unknown } } | null;
    const name = parsed?.method === "tools/call" ? parsed?.params?.name : undefined;
    return typeof name === "string" && /^[a-z][a-z0-9_]{0,39}$/.test(name) ? `/mcp:${name}` : "/mcp";
  } catch { return "/mcp"; }
}
