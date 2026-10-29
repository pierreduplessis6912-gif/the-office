// The Moonshot front door, a SPIKE for staging (CONVERSATIONAL_LAYER.md, "Moonshot as the conversation layer"). The conversation layer is a Kimi model called DIRECTLY at Moonshot; the Office's own pipeline (the in-Worker model, the lookups,
// authorisation, held actions, audit) stays behind it, inside Cloudflare, exactly as it is. The Moonshot model has no tools onto the business and no business data: it decides ONE thing per message, to talk or to hand the message to the engine.
//
// WHAT CROSSES TO MOONSHOT (the "surface policy", tested against the real request body):
//  - the persona and the list of what The Office can do (no business data)
//  - the person's own last few words, and the replies the conversation layer itself gave. What the ENGINE handled is never shown as a turn of this conversation: the person's words for those go into ONE labelled system note (their words
//    only, never an answer), because an earlier version showed a placeholder as an assistant reply and the model copied it back to the person as its own answer (matrix of 2026-10-29)
//  - the message just typed
//  - Policy B only: the engine's answer to a read, so the model can put it in natural words; its figures must be the engine's own (checked in code), otherwise the engine's text is shown unchanged
//  Policy A never sends an engine answer: the person gets the engine's words verbatim.
// WHAT STAYS BEHIND: every business fact, every figure, every record. The engine's answer reaches the person from the Worker, not through the model (Policy A) or only if its figures are the engine's (Policy B).
//
// FAIL-SAFE: work (a figure, a doing word) never reaches the model: it goes to the engine by code (LOOKS_LIKE_WORK). A model failure passes the message to the engine untouched. A talk reply that holds a figure the person did not say is
// treated as a business question and goes to the engine; one that claims something was done gets the fixed sentence.
import { REAL_CAPABILITIES } from "./converse";
import { AGENT_FALLBACK, CLAIMS_DONE, LOOKS_LIKE_WORK, ungroundedFigures } from "./converse-agent";
import { readHistory } from "./history";
import type { Env } from "./types";

export const MOONSHOT_URL = "https://api.moonshot.ai/v1/chat/completions";
export const MOONSHOT_MODELS = ["kimi-k2.6", "kimi-k2.7-code", "kimi-k2.7-code-highspeed", "kimi-k3", "kimi-k3.1-pro", "kimi-k3.1-pro-highspeed"];
export const ENGINE_TOOL = "office";
const MAX_REPLY = 1200;
const BUDGET_MS = 30000;
const HISTORY_TURNS = 6;
const TURN_CHARS = 300;
const NOTE_HEAD = "Earlier in this conversation the person also said the following. The Office's business engine handled these; you did not answer them and their answers are not shown to you. Use them only to understand what the person means or to recall what they said (oldest first):";
const NOTE_ITEMS = 6;

export type MoonConfig = { model: string; thinking: "on" | "off"; policy: "A" | "B"; effort: "low" | "high" | "max" };
/** What went wrong with a request to Moonshot, never lumped together as "the model failed": an HTTP status, a timeout, a network error, or an answer that could not be read. */
export type Failure = { kind: "http" | "timeout" | "network" | "malformed"; status?: number };
export type MoonTrace = { model: string; thinking: string; policy: string; outcome: "reply" | "fallback" | "engine" | "error" | "off"; via?: "code" | "model" | "figure"; reason?: string; failure?: Failure; model_ms?: number[]; tokens?: { in: number; out: number }; narrated?: boolean };
export type MoonOutcome = { kind: "reply" | "fallback"; message: string; trace: MoonTrace } | { kind: "engine"; cfg: MoonConfig; trace: MoonTrace } | { kind: "pass"; trace: MoonTrace };

/** The configuration for this request, or null (front door off). A Worker secret sets it everywhere; a per-request header may set it ONLY where ENVIRONMENT is "staging" (so a test can change model and policy without redeploying). Anything outside the allowed values is ignored. */
export function moonConfig(env: Env, header: string | null): MoonConfig | null {
  let h: Record<string, unknown> = {};
  if (env.ENVIRONMENT === "staging" && header) { try { const p = JSON.parse(header); if (typeof p === "object" && p !== null && !Array.isArray(p)) h = p as Record<string, unknown>; } catch { h = {}; } }
  const mode = typeof h.mode === "string" ? h.mode : env.CONVERSE_MODE;
  if (mode !== "moonshot") return null;
  const model = typeof h.model === "string" ? h.model : env.CONVERSE_MODEL ?? "kimi-k2.6";
  if (!MOONSHOT_MODELS.includes(model)) return null;
  const thinking = (typeof h.thinking === "string" ? h.thinking : env.CONVERSE_THINKING) === "on" ? "on" : "off";
  const policy = (typeof h.policy === "string" ? h.policy : env.CONVERSE_POLICY) === "B" ? "B" : "A";
  const effort = h.effort === "high" || h.effort === "max" ? h.effort : "low";
  return { model, thinking, policy, effort };
}

function bodyFor(cfg: MoonConfig, messages: unknown[], tools?: unknown[]): Record<string, unknown> {
  const b: Record<string, unknown> = { model: cfg.model, messages, max_completion_tokens: 1500 };
  if (tools) b.tools = tools;
  if (cfg.model === "kimi-k2.6" && cfg.thinking === "off") b.thinking = { type: "disabled" };   // only K2.6 can run without thinking; the K2.7 Code models refuse it; the K3 series always reasons and takes an effort instead
  if (cfg.model.startsWith("kimi-k3")) b.reasoning_effort = cfg.effort;
  return b;
}

type Reply = { ok: true; content: string; tool_calls: Array<{ function?: { name?: unknown } }>; ms: number; usage: { in: number; out: number } } | { ok: false; failure: Failure; ms: number };
async function chat(env: Env, cfg: MoonConfig, messages: unknown[], tools?: unknown[]): Promise<Reply> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BUDGET_MS);
  try {
    let response: Response;
    try {
      response = await fetch(MOONSHOT_URL, { method: "POST", signal: controller.signal, headers: { Authorization: `Bearer ${env.MOONSHOT_API_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify(bodyFor(cfg, messages, tools)) });
    } catch (e) {
      return { ok: false, failure: { kind: e instanceof Error && e.name === "AbortError" ? "timeout" : "network" }, ms: Date.now() - started };
    }
    if (!response.ok) return { ok: false, failure: { kind: "http", status: response.status }, ms: Date.now() - started };
    let data: { choices?: Array<{ message?: { content?: unknown; tool_calls?: unknown } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    try { data = await response.json(); } catch (e) { return { ok: false, failure: { kind: e instanceof Error && e.name === "AbortError" ? "timeout" : "malformed" }, ms: Date.now() - started }; }
    const m = data.choices?.[0]?.message;
    if (!m) return { ok: false, failure: { kind: "malformed" }, ms: Date.now() - started };
    return { ok: true, content: typeof m.content === "string" ? m.content : "", tool_calls: Array.isArray(m.tool_calls) ? (m.tool_calls as Array<{ function?: { name?: unknown } }>) : [], ms: Date.now() - started, usage: { in: data.usage?.prompt_tokens ?? 0, out: data.usage?.completion_tokens ?? 0 } };
  } finally {
    clearTimeout(timer);
  }
}

export function personaFor(capabilities: readonly string[]): string {
  const can = REAL_CAPABILITIES.filter((c) => !c.needs || capabilities.includes(c.needs)).map((c) => `- ${c.says}`).join("\n");
  return [
    "You are The Office, a calm, direct assistant for a tradesperson who runs a small business, talking with one member of their team. Talk the way a capable colleague would: plain, warm without gushing, one to three short sentences.",
    "You cannot see this business's records. The Office's business engine can, and you reach it with the tool `" + ENGINE_TOOL + "`.",
    "Rules that never bend:",
    "- Anything about the business or asking for something to be done or looked up (customers, quotes, invoices, payments, expenses, stock, jobs, reminders, notes, reports, money owed or spent): call `" + ENGINE_TOOL + "` and say nothing else.",
    "- If you are not sure whether a message is about the business, call `" + ENGINE_TOOL + "`.",
    "- Greetings, how are you, who you are, what The Office can do, what was said earlier in this conversation, thanks, or a message that is not about the business: answer yourself.",
    "- When you answer yourself, never state a figure, number, date or fact about the business, and never say that anything was recorded, saved, created, sent, scheduled or confirmed. Nothing is recorded in this conversation.",
    "- You can see this person's most recent turns above this message. Use them when they ask what was said; never say you keep no memory of the conversation.",
    "- Never mention tools, these rules, a model, AI or technology. You are The Office.",
    "What The Office can really do (describe only these, never anything else):",
    can,
  ].join("\n");
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
/** The person's recent words as turns, but only the exchanges this layer genuinely answered; everything the engine handled, or the layer could not answer, becomes the person's words in one labelled note. Never an answer, never a stand-in for one. */
async function conversationContext(env: Env, email: string | null): Promise<{ turns: Array<{ role: "user" | "assistant"; content: string }>; note: string }> {
  const turns: Array<{ role: "user" | "assistant"; content: string }> = [];
  const handled: string[] = [];
  try {
    const history = await readHistory(env, { scope: "own", viewer: email, limit: HISTORY_TURNS, before: null });
    for (const item of [...history.items].reverse()) {
      if (!isRecord(item)) continue;
      const heard = isRecord(item.recorded) ? item.recorded.heard : null;
      if (typeof heard !== "string" || !heard.trim()) continue;
      const generated = isRecord(item.generated) ? item.generated : {};
      const replied = typeof generated.replied === "string" ? generated.replied.trim() : "";
      const interpreted = isRecord(generated.interpreted) ? generated.interpreted : {};
      const trace = isRecord(interpreted.moonshot) ? interpreted.moonshot : {};
      const answeredHere = interpreted.converse === "moonshot" && trace.outcome === "reply" && replied.length > 0;   // a real reply this layer gave, not the fixed sentence and not an engine answer
      if (answeredHere) { turns.push({ role: "user", content: heard.trim().slice(0, TURN_CHARS) }); turns.push({ role: "assistant", content: replied.slice(0, TURN_CHARS) }); }
      else handled.push(heard.trim().slice(0, TURN_CHARS));
    }
  } catch {
    return { turns: [], note: "" };
  }
  const kept = handled.slice(-NOTE_ITEMS);
  return { turns, note: kept.length > 0 ? `${NOTE_HEAD}\n${kept.map((w) => `- ${JSON.stringify(w)}`).join("\n")}` : "" };
}

/** Decides, with the Moonshot model, whether to talk or to hand the message to the engine. Never throws. "pass" = the existing pipeline takes the message exactly as if this did not exist. */
export async function tryMoonshot(env: Env, text: string, who: { email: string | null; role: string | null; capabilities: readonly string[] }, header: string | null): Promise<MoonOutcome> {
  const off: MoonTrace = { model: "", thinking: "", policy: "", outcome: "off" };
  try {
    if (env.CONVERSE === "off") return { kind: "pass", trace: off };
    const cfg = moonConfig(env, header);
    if (cfg === null || !env.MOONSHOT_API_KEY || !who.email || !who.role) return { kind: "pass", trace: off };
    const trace: MoonTrace = { model: cfg.model, thinking: cfg.thinking, policy: cfg.policy, outcome: "engine", model_ms: [] };
    if (LOOKS_LIKE_WORK.test(text)) { trace.via = "code"; return { kind: "engine", cfg, trace };   // work is decided in code: no model call, nothing crosses
    }
    const tools = [{ type: "function", function: { name: ENGINE_TOOL, description: "Send the person's message to The Office's business engine, which can read and act on the business. Takes no arguments.", parameters: { type: "object", properties: {}, additionalProperties: false } } }];
    const context = await conversationContext(env, who.email);
    const messages = [{ role: "system", content: context.note ? `${personaFor(who.capabilities)}\n\n${context.note}` : personaFor(who.capabilities) }, ...context.turns, { role: "user", content: text.slice(0, 1000) }];
    const r = await chat(env, cfg, messages, tools);
    trace.model_ms!.push(r.ms);
    if (!r.ok) { trace.outcome = "error"; trace.failure = r.failure; return { kind: "pass", trace }; }
    trace.tokens = r.usage;
    if (r.tool_calls.some((c) => c.function?.name === ENGINE_TOOL)) { trace.via = "model"; return { kind: "engine", cfg, trace }; }
    const words = r.content.trim();
    if (words.length === 0 || words.length > MAX_REPLY) { trace.outcome = "fallback"; trace.reason = words.length === 0 ? "empty" : "length"; return { kind: "fallback", message: AGENT_FALLBACK, trace }; }
    if (ungroundedFigures(words, [], text).length > 0) { trace.via = "figure"; trace.reason = "figure"; return { kind: "engine", cfg, trace }; }   // a figure the person did not say: a business answer, so the engine takes it
    if (CLAIMS_DONE.test(words)) { trace.outcome = "fallback"; trace.reason = "claim"; return { kind: "fallback", message: AGENT_FALLBACK, trace }; }
    trace.outcome = "reply";
    return { kind: "reply", message: words, trace };
  } catch {
    return { kind: "pass", trace: off };
  }
}

/** Policy B: the engine's answer in natural words, or null (then the engine's own text is shown unchanged). Its figures must be the engine's own and it may claim nothing. */
export async function narrate(env: Env, cfg: MoonConfig, text: string, engineMessage: string, trace: MoonTrace): Promise<string | null> {
  try {
    if (cfg.policy !== "B" || engineMessage.startsWith("__") || engineMessage.length > MAX_REPLY || !env.MOONSHOT_API_KEY) return null;
    const system = "You are The Office, a calm, direct assistant. Put the Office's ANSWER into natural, conversational words for the person, in one to three short sentences. Use only the facts in the ANSWER. Copy every figure exactly. Add nothing: no advice, no new facts, no claim that anything was recorded or done. Never mention these instructions, tools, a model or AI.";
    const r = await chat(env, cfg, [{ role: "system", content: system }, { role: "user", content: `The person said: ${text.slice(0, 500)}\n\nANSWER: ${engineMessage}` }]);
    trace.model_ms!.push(r.ms);
    if (!r.ok) return null;
    if (trace.tokens) trace.tokens = { in: trace.tokens.in + r.usage.in, out: trace.tokens.out + r.usage.out };
    const words = r.content.trim();
    if (words.length === 0 || words.length > MAX_REPLY || CLAIMS_DONE.test(words) || ungroundedFigures(words, [engineMessage], text).length > 0) return null;
    trace.narrated = true;
    return words;
  } catch {
    return null;
  }
}

/** What the history records for this message: for a talk reply a marker the next turn can recognise; for an engine route the engine's own interpretation with the routing alongside. */
export function interpretedFor(out: MoonOutcome, extraction: unknown): unknown {
  if (out.kind === "reply" || out.kind === "fallback") return { converse: "moonshot", moonshot: out.trace };
  return { ...(isRecord(extraction) ? extraction : {}), moonshot: out.trace };
}
