// THE MODEL ROUTER (docs/MODEL_ROUTES.md). Every chat-model call in the Worker goes through chat(env, "<route>", ...). A route has a PRIMARY model and a FALLBACK, both named from the CATALOGUE below; each catalogue entry knows its own
// provider and its own settings (that is the part that differs between providers: Kimi at Moonshot turns thinking off with `thinking: { type: "disabled" }`, DeepSeek on Cloudflare with `reasoning_effort: "none"`).
// Why this exists: Cloudflare retired its own Kimi on 2026-11-20 (HTTP 410, code 5028) and the name was written in about 30 places. Now a change like that is a one-line switch.
//
// THE SWITCH: the Worker variable MODEL_ROUTES (JSON), set from the "Staging model secrets" workflow. Keys are a route ("interpret"), a prefix of dotted routes ("extract" covers "extract.intent"), or "*" (everything); the most specific wins.
// A value is a catalogue name ("deepseek": that model first, the other one as the fallback) or an array ["deepseek", "kimi"] / ["deepseek", null] (null = no fallback). An entry the router does not understand is ignored, never fatal: a bad
// override can only fall back to the default, never break a call.
//
// WHAT CROSSES TO A PROVIDER is exactly the messages the caller gives; the Moonshot key is only ever in the Authorization header, and no reason text ever holds it.
import type { Env } from "./types";

export type Provider = "moonshot" | "cloudflare";
export interface ModelEntry { provider: Provider; id: string; via: string }
/** The catalogue: every model a route may name. Adding a model is one entry here (and its name in the workflow's choices, which a test pins). */
export const MODELS: Record<string, ModelEntry> = {
  kimi: { provider: "moonshot", id: "kimi-k2.6", via: "moonshot:kimi-k2.6" },
  deepseek: { provider: "cloudflare", id: "@cf/deepseek-ai/deepseek-v4.1-flash-1017", via: "cloudflare:deepseek-v4.1-flash-1017" },
};
export interface Route { primary: string; fallback: string | null }
/** Kimi at Moonshot first (the credits are there), DeepSeek on Cloudflare if it fails in any way. */
export const DEFAULT_ROUTE: Route = { primary: "kimi", fallback: "deepseek" };
const OTHER: Record<string, string> = { kimi: "deepseek", deepseek: "kimi" };   // a lone model in an override gets the other one as its fallback

export interface ChatRequest { messages: unknown[]; temperature?: number; maxTokens?: number; timeoutMs?: number }
export type ChatResult = { content: string; why: null; via: string } | { content: null; why: string; via: null };

const known = (v: unknown): v is string => typeof v === "string" && Object.prototype.hasOwnProperty.call(MODELS, v);
function parseOverride(raw: unknown): Record<string, Route> {
  const out: Record<string, Route> = {};
  if (typeof raw !== "string" || !raw.trim()) return out;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return out; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return out;
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!key.trim()) continue;
    if (known(value)) out[key] = { primary: value, fallback: OTHER[value] ?? null };
    else if (Array.isArray(value) && value.length === 2 && known(value[0]) && (value[1] === null || known(value[1]))) out[key] = { primary: value[0], fallback: value[1] as string | null };
  }
  return out;
}

/** The route's primary and fallback: the exact route, else the longest dotted prefix, else "*", else the default. */
export function resolveRoute(env: Pick<Env, "MODEL_ROUTES">, route: string): Route {
  const overrides = parseOverride(env.MODEL_ROUTES);
  if (overrides[route]) return overrides[route];
  let best: string | null = null;
  for (const key of Object.keys(overrides)) if (key !== "*" && route.startsWith(key + ".") && (best === null || key.length > best.length)) best = key;
  if (best !== null) return overrides[best];
  return overrides["*"] ?? DEFAULT_ROUTE;
}

const cut = (e: unknown, n: number): string => { const err = e as { name?: unknown; message?: unknown } | null; return `${String(err?.name ?? "Error")}: ${String(err?.message ?? e)}`.slice(0, n); };
type Asked = { content: string } | { content: null; why: string } | { skipped: true };
const DEFAULT_TIMEOUT_MS = 20_000;

async function askMoonshot(env: Env, entry: ModelEntry, req: ChatRequest): Promise<Asked> {
  if (!env.MOONSHOT_API_KEY) return { skipped: true };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), req.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    // no temperature on purpose: Kimi K2.6 fixes its own
    const body: Record<string, unknown> = { model: entry.id, messages: req.messages, thinking: { type: "disabled" } };
    if (req.maxTokens !== undefined) body.max_completion_tokens = req.maxTokens;
    const response = await fetch("https://api.moonshot.ai/v1/chat/completions", { method: "POST", signal: controller.signal, headers: { Authorization: `Bearer ${env.MOONSHOT_API_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!response.ok) return { content: null, why: `HTTP ${response.status}` };
    const data = (await response.json()) as { choices?: Array<{ message?: { content?: unknown } }> };
    const content = data?.choices?.[0]?.message?.content;
    return typeof content === "string" && content.trim() ? { content } : { content: null, why: "no text in the answer" };
  } catch (e) {
    return { content: null, why: cut(e, 100) };
  } finally {
    clearTimeout(timer);
  }
}

async function askCloudflare(env: Env, entry: ModelEntry, req: ChatRequest): Promise<Asked> {
  const ai = (env as unknown as { AI?: { run?: unknown } }).AI;
  if (!ai || typeof ai.run !== "function") return { content: null, why: "no AI binding on this business object" };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const input: Record<string, unknown> = { temperature: req.temperature ?? 0, reasoning_effort: "none", messages: req.messages };
    if (req.maxTokens !== undefined) input.max_completion_tokens = req.maxTokens;
    const call = Promise.resolve().then(() => (env.AI as unknown as { run: (m: string, i: unknown) => Promise<unknown> }).run(entry.id, input));
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("model timeout")), req.timeoutMs ?? DEFAULT_TIMEOUT_MS); });
    const reply = (await Promise.race([call, timeout])) as { choices?: Array<{ message?: { content?: unknown } }>; response?: unknown };
    const content = reply?.choices?.[0]?.message?.content ?? reply?.response;
    return typeof content === "string" ? { content } : { content: null, why: "the model answered without text" };
  } catch (e) {
    return { content: null, why: cut(e, 120) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The model's text and WHICH model gave it, or null with the REASONS it gave none (a rehearsal shows them; a production answer never does). The primary first, then the fallback if there is one and it differs. */
export async function chat(env: Env, route: string, req: ChatRequest): Promise<ChatResult> {
  const { primary, fallback } = resolveRoute(env, route);
  const order = fallback && fallback !== primary ? [primary, fallback] : [primary];
  const reasons: string[] = [];
  for (const name of order) {
    const entry = MODELS[name];
    const asked = entry.provider === "moonshot" ? await askMoonshot(env, entry, req) : await askCloudflare(env, entry, req);
    if ("skipped" in asked) continue;
    if (asked.content !== null) return { content: asked.content, why: null, via: entry.via };
    reasons.push(`${entry.provider}: ${asked.why}`);
  }
  return { content: null, why: reasons.length ? reasons.join("; ") : "no model is available for this route (no Moonshot key)", via: null };
}
