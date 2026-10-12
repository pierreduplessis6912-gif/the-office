// Architecture trial, 2026-10-12 (DECISIONS.md, "Database architecture"): does running the application NEXT TO its data, in a Durable Object with its own SQLite, remove
// the cost of the database being far away? Today every statement is a network trip to a D1 database in Western Europe (about 190 ms from South Africa, 20 per message).
//
// Two admin-only routes make that measurable from a phone, and touch NO business data:
//   GET /debug/trial-d1?n=20                                  n sequential "SELECT 1" trips to the production database: today's cost, measured.
//   GET /debug/trial-do?n=20&hint=weur&name=a[&shared=1]      the same n statements, run INSIDE a Durable Object that has its own SQLite. `hint` places it (auto, weur, eeur,
//                                                             enam...); `name` picks WHICH object (each name is a separate, isolated database); `shared=k` adds k trips from inside the object
//                                                             to the shared layer (modelled here by the production D1), to show what touching shared data costs.
// The object keeps only a scratch table of its own, which is why it is safe to run in production.
import type { Env } from "./types";

const HINTS = ["wnam", "enam", "sam", "weur", "eeur", "apac", "oc", "afr", "me"] as const;
type Hint = (typeof HINTS)[number];
const clamp = (value: unknown, low: number, high: number, fallback: number): number => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(high, Math.max(low, Math.floor(n))) : fallback;
};

export class TrialObject {
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const n = clamp(url.searchParams.get("n"), 1, 200, 20);
    const shared = clamp(url.searchParams.get("shared"), 0, 10, 0);
    const sql = this.ctx.storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS trial (id INTEGER PRIMARY KEY AUTOINCREMENT, note TEXT, created_at TEXT DEFAULT (datetime('now')))");
    // n statements in a row, about a third of them writes, like a real message.
    const started = Date.now();
    for (let i = 0; i < n; i++) {
      if (i % 3 === 0) sql.exec("INSERT INTO trial (note) VALUES (?)", `statement ${i}`);
      else sql.exec("SELECT COUNT(*) AS c FROM trial").toArray();
    }
    const insideMs = Date.now() - started;   // a Worker's clock only advances while waiting on something, so a purely local run can read 0: that IS the point
    let sharedMs: number | null = null;
    if (shared > 0) {
      const s0 = Date.now();
      for (let i = 0; i < shared; i++) await this.env.OFFICE_DB.prepare("SELECT 1 AS one").first();
      sharedMs = Date.now() - s0;
    }
    let colo: string | null = null;
    try {
      const trace = await (await fetch("https://cloudflare.com/cdn-cgi/trace")).text();
      colo = /^colo=(\w+)$/m.exec(trace)?.[1] ?? null;   // the data centre this object is actually running in
    } catch {
      colo = null;
    }
    const rows = (sql.exec("SELECT COUNT(*) AS c FROM trial").toArray()[0] as { c: number }).c;
    return Response.json({ statements: n, insideTheObjectMs: insideMs, sharedTrips: shared, sharedMs, objectColo: colo, rowsInThisObjectsOwnTable: rows });
  }
}

export async function trialDo(env: Env, url: URL): Promise<Response> {
  const name = (url.searchParams.get("name") ?? "trial-a").replace(/[^\w-]/g, "").slice(0, 40) || "trial-a";
  const hintParam = url.searchParams.get("hint") ?? "auto";
  if (hintParam !== "auto" && !(HINTS as readonly string[]).includes(hintParam)) return Response.json({ error: `hint must be auto or one of ${HINTS.join(", ")}` }, { status: 400 });
  const id = env.TRIAL.idFromName(name);
  const stub = hintParam === "auto" ? env.TRIAL.get(id) : env.TRIAL.get(id, { locationHint: hintParam as Hint });
  const params = new URLSearchParams({ n: String(clamp(url.searchParams.get("n"), 1, 200, 20)), shared: String(clamp(url.searchParams.get("shared"), 0, 10, 0)) });
  const started = Date.now();
  const inner = (await (await stub.fetch(`https://trial/work?${params}`)).json()) as Record<string, unknown>;
  return Response.json({ ...inner, object: name, hint: hintParam, workerToObjectAndBackMs: Date.now() - started });
}

export async function trialD1(env: Env, url: URL): Promise<Response> {
  const n = clamp(url.searchParams.get("n"), 1, 200, 20);
  const started = Date.now();
  for (let i = 0; i < n; i++) await env.OFFICE_DB.prepare("SELECT 1 AS one").first();
  const totalMs = Date.now() - started;
  return Response.json({ statements: n, totalMs, perStatementMs: Math.round((totalMs / n) * 10) / 10, note: "SELECT 1 against the production database: reads no data" });
}
