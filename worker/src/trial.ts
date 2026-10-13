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
interface ModelProbe {
  chars?: number;      // pad the instructions with this many characters of filler, to see how latency grows with the size of the prompt
  affinity?: string;   // send this as the x-session-affinity header (Cloudflare's prompt caching routes by it)
  salt?: string;       // put this at the very START of the padding, so a measurement begins from a prefix no earlier call has warmed
}
async function askModel(env: Env, n: number, probe: ModelProbe = {}): Promise<{ callsMs: number[]; usage: unknown[] }> {
  const ai = env.AI as unknown as { run: (model: string, input: unknown, options?: unknown) => Promise<{ usage?: unknown }> };
  // The padding comes FIRST and is identical on every call: prompt caching matches the exact token sequence from the start of the prompt.
  const filler = probe.chars ? `${probe.salt ? `[${probe.salt}] ` : ""}${"The Office keeps business records for tradespeople. ".repeat(Math.ceil(probe.chars / 51))}`.slice(0, probe.chars) : "";
  const times: number[] = [];
  const usage: unknown[] = [];
  for (let i = 0; i < n; i++) {
    const started = Date.now();
    const answer = await ai.run(
      "@cf/moonshotai/kimi-k2.6",
      {
        temperature: 0,
        max_tokens: 5,
        chat_template_kwargs: { thinking: false },
        messages: [
          { role: "system", content: `${filler}\nAnswer with one word.` },
          { role: "user", content: "Say ok." },
        ],
      },
      probe.affinity ? { extraHeaders: { "x-session-affinity": probe.affinity } } : undefined
    );
    times.push(Date.now() - started);
    usage.push(answer?.usage ?? null);
  }
  return { callsMs: times, usage };
}

export class TrialObject {
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/ai") {
      return Response.json(await askModel(this.env, clamp(url.searchParams.get("n"), 1, 10, 3), { chars: clamp(url.searchParams.get("chars"), 0, 60000, 0), affinity: url.searchParams.get("affinity") || undefined, salt: (url.searchParams.get("salt") ?? "").replace(/[^\w-]/g, "").slice(0, 40) || undefined }));
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
  const chars = clamp(url.searchParams.get("chars"), 0, 60000, 0);
  const affinity = (url.searchParams.get("affinity") ?? "").replace(/[^\w-]/g, "").slice(0, 64) || undefined;
  const salt = (url.searchParams.get("salt") ?? "").replace(/[^\w-]/g, "").slice(0, 40) || undefined;
  const where = url.searchParams.get("where") === "object" ? "object" : "worker";
  let result: { callsMs: number[]; usage: unknown[] };
  if (where === "worker") {
    result = await askModel(env, n, { chars, affinity, salt });
  } else {
    const hintParam = url.searchParams.get("hint") ?? "weur";
    if (hintParam !== "auto" && !(HINTS as readonly string[]).includes(hintParam)) return Response.json({ error: `hint must be auto or one of ${HINTS.join(", ")}` }, { status: 400 });
    const id = env.TRIAL.idFromName("ai-trial");
    const stub = hintParam === "auto" ? env.TRIAL.get(id) : env.TRIAL.get(id, { locationHint: hintParam as Hint });
    const query = new URLSearchParams({ n: String(n), chars: String(chars), ...(affinity ? { affinity } : {}), ...(salt ? { salt } : {}) });
    result = (await (await stub.fetch(`https://trial/ai?${query}`)).json()) as { callsMs: number[]; usage: unknown[] };
  }
  const sorted = [...result.callsMs].sort((a, b) => a - b);
  return Response.json({ where, calls: n, promptPaddingChars: chars, affinity: affinity ?? null, salt: salt ?? null, callsMs: result.callsMs, medianMs: sorted[Math.floor(sorted.length / 2)], usage: result.usage, note: "a five-token answer from the main model: with no padding this is mostly the cost of reaching and starting the model; with padding it shows what a bigger prompt costs, and what the affinity header does for repeats" });
}
