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

// The same tiny question put to the main model n times in a row, each call timed. Written exactly like the application's own calls (Kimi, thinking off) but with a five-token
// answer, so it costs a fraction of a cent. Called with a cast because the binding's own types do not know every option the model accepts (the application's calls are the same).
async function askModel(env: Env, n: number): Promise<number[]> {
  const ai = env.AI as unknown as { run: (model: string, input: unknown) => Promise<unknown> };
  const times: number[] = [];
  for (let i = 0; i < n; i++) {
    const started = Date.now();
    await ai.run("@cf/moonshotai/kimi-k2.6", {
      temperature: 0,
      max_tokens: 5,
      chat_template_kwargs: { thinking: false },
      messages: [
        { role: "system", content: "Answer with one word." },
        { role: "user", content: "Say ok." },
      ],
    });
    times.push(Date.now() - started);
  }
  return times;
}

export class TrialObject {
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/ai") {
      const times = await askModel(this.env, clamp(url.searchParams.get("n"), 1, 10, 3));
      return Response.json({ callsMs: times });
    }
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
    // Which data centre is this object in? Asked only when `trace=1`, because it is a network trip of its own and must never be inside a measurement.
    let colo: string | null = null;
    if (url.searchParams.get("trace") === "1") {
      try {
        const trace = await (await fetch("https://cloudflare.com/cdn-cgi/trace")).text();
        colo = /^colo=(\w+)$/m.exec(trace)?.[1] ?? null;
      } catch {
        colo = null;
      }
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
  const params = new URLSearchParams({
    n: String(clamp(url.searchParams.get("n"), 1, 200, 20)),
    shared: String(clamp(url.searchParams.get("shared"), 0, 10, 0)),
    trace: url.searchParams.get("trace") === "1" ? "1" : "0",
  });
  // `repeat` calls the object several times in a row and times each call on its own: the FIRST call includes creating and placing the object, the rest are what a
  // real message pays. (A lookup of the object's location, `trace=1`, adds a network trip to every call, so leave it off when measuring.)
  const repeat = clamp(url.searchParams.get("repeat"), 1, 10, 1);
  const callsMs: number[] = [];
  let inner: Record<string, unknown> = {};
  for (let i = 0; i < repeat; i++) {
    const started = Date.now();
    inner = (await (await stub.fetch(`https://trial/work?${params}`)).json()) as Record<string, unknown>;
    callsMs.push(Date.now() - started);
  }
  const warm = callsMs.slice(1).sort((a, b) => a - b);
  return Response.json({
    ...inner,
    object: name,
    hint: hintParam,
    callsMs,
    firstCallMs: callsMs[0],
    warmCallsMedianMs: warm.length ? warm[Math.floor(warm.length / 2)] : null,
    workerToObjectAndBackMs: callsMs[callsMs.length - 1],
  });
}

export async function trialD1(env: Env, url: URL): Promise<Response> {
  const n = clamp(url.searchParams.get("n"), 1, 200, 20);
  const started = Date.now();
  for (let i = 0; i < n; i++) await env.OFFICE_DB.prepare("SELECT 1 AS one").first();
  const totalMs = Date.now() - started;
  return Response.json({ statements: n, totalMs, perStatementMs: Math.round((totalMs / n) * 10) / 10, note: "SELECT 1 against the production database: reads no data" });
}

// Where is the model slower or faster from? `where=worker` asks it from the Worker that serves the request today (a South African data centre for a South African phone);
// `where=object` asks it from INSIDE the Durable Object (placed with `hint`, London by default), which is where the business's logic would run.
export async function trialAi(env: Env, url: URL): Promise<Response> {
  const n = clamp(url.searchParams.get("n"), 1, 10, 3);
  const where = url.searchParams.get("where") === "object" ? "object" : "worker";
  let times: number[];
  if (where === "worker") {
    times = await askModel(env, n);
  } else {
    const hintParam = url.searchParams.get("hint") ?? "weur";
    if (hintParam !== "auto" && !(HINTS as readonly string[]).includes(hintParam)) return Response.json({ error: `hint must be auto or one of ${HINTS.join(", ")}` }, { status: 400 });
    const id = env.TRIAL.idFromName("ai-trial");
    const stub = hintParam === "auto" ? env.TRIAL.get(id) : env.TRIAL.get(id, { locationHint: hintParam as Hint });
    times = ((await (await stub.fetch(`https://trial/ai?n=${n}`)).json()) as { callsMs: number[] }).callsMs;
  }
  const sorted = [...times].sort((a, b) => a - b);
  return Response.json({ where, calls: n, callsMs: times, medianMs: sorted[Math.floor(sorted.length / 2)], note: "a five-token answer from the main model: this is mostly the cost of reaching and starting the model, not of generating text" });
}
