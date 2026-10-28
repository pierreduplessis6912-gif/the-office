// The conversation-first front door, a SPIKE for staging (CONVERSATIONAL_LAYER.md, "Direction change"). Switched on only where CONVERSE_MODE is "agent"; CONVERSE=off switches it off too. With it on, a typed or spoken message
// meets a conversation model BEFORE the intent pipeline, the way the connected MCP instance works: the model talks, or reads the business with the connector's READ tools, or hands the message to the existing pipeline.
//
// WHAT KEEPS IT SAFE, each part tested (tools/converse-agent.test.js):
//  - READ ONLY: the tools are the connector's read tools (mcp.ts readToolsFor), chosen by the connector's own permission rule for this member; no tool that creates, confirms, rejects or uploads is ever offered or run
//  - WORK is not done here: a message that asks for something to be done makes the model call hand_to_office, and the route then sends the ORIGINAL text through the existing pipeline unchanged (held, confirmed in the app)
//  - GROUNDED: every figure in a reply must appear in a tool result or in what the person said (no calculating, counting or estimating); a reply that fails that, or claims anything was recorded, is replaced by a fixed sentence
//  - BOUNDED: at most four model calls per message (three tool steps and the answer), the last without tools; tool results go back as tool messages, never into the system prompt; history is the member's own (converse.ts lastTurns reads scope "own")
//  - the model is given NO facts bundle: business facts reach it only through a tool it chooses to call
//  - a failure of the front door itself (the model, an unreadable answer) returns "pass": the existing pipeline handles the message as if this did not exist
import { withRetry } from "./ai";
import { lastTurns, REAL_CAPABILITIES } from "./converse";
import { readToolsFor, runReadTool, type AgentWho } from "./mcp";
import { SCOPE_READ } from "./mcp-keys";
import type { Env } from "./types";

export const HANDOFF_TOOL = "hand_to_office";
export const AGENT_FALLBACK = "I'm having trouble responding right now. You can try again in a moment.";
// WORK IS NEVER LEFT TO THE MODEL'S JUDGEMENT. First real-model run on staging (2026-10-28): asked "Bought diesel for R650" the model chatted back instead of calling hand_to_office, so an instruction would have been lost. A message that carries
// a figure, opens with a doing word ("invoice", "remind me", "add"...) or says something was paid or bought goes straight to the existing pipeline with NO model call here. It fails safe: a read with a digit in it simply takes the old path.
export const LOOKS_LIKE_WORK = /\d|^\s*(?:please\s+|can you\s+|could you\s+)?(?:invoice|quote|remind|schedule|add|record|create|book|cancel|order|send|pay|log)\b|\b(?:paid|bought)\b/i;
const MAX_MODEL_CALLS = 4;   // three tool steps and the answer; the last call gets no tools
const MAX_TOOL_CALLS_PER_STEP = 4;
const AGENT_MAX_REPLY_CHARS = 1200;   // a capability list is longer than a sentence or two
export const AGENT_BUDGET_MS = 25000;   // round 2 saw 40 to 45 second reads: past this the fixed sentence is shown instead of a longer wait

// What may never be shown is a claim that THIS conversation did something. Round 2 refused correct readings ("R1,000 paid against it", "no scheduled date") with a bare word list, so the check is about who did what: a first-person
// "I've recorded", a passive about the thing just asked ("has been saved", "is now recorded"), "that is confirmed", or a bare "done". A past participle inside a reading ("paid against it", "was sent on the 3rd") passes.
const DONE = "recorded|saved|created|logged|confirmed|scheduled|booked|issued|deleted|updated|sent|added|noted|paid|invoiced|quoted|raised|captured|filed";
export const CLAIMS_DONE = new RegExp(`\\b(?:i|we)(?:['\u2019]ve|['\u2019]ll have| have| just| already)?\\s+(?:\\w+\\s+){0,2}(?:${DONE})\\b|\\b(?:has|have|had|was|were|is|are)\\s+(?:(?:now|just|been|already)\\s+)+(?:${DONE})\\b|\\b(?:that|this)(?:['\u2019]s| is| has been)\\s+(?:now\\s+)?(?:${DONE}|done)\\b|\\b(?:all set|consider it done|done and dusted)\\b|^\\s*done\\b`, "i");

export type AgentTrace = { steps: number; tools: string[]; outcome: "reply" | "fallback" | "handoff" | "error" | "off"; reason?: "claim" | "figure" | "length" | "empty" | "tools" | "time"; rejected?: string; figures?: string[]; thinking?: boolean };
export type AgentOutcome = { kind: "reply" | "fallback"; message: string; trace: AgentTrace } | { kind: "pass"; trace: AgentTrace };

// A figure is grounded when it appears, however formatted (R5,000 / 5000 / 5000.00), in a tool result or in the person's own words. Dates split into numbers the same way on both sides.
const figures = (text: string): string[] => (text.match(/\d+(?:[.,]\d+)*/g) ?? []).map((t) => String(Number(t.replace(/,/g, ""))));
export function ungroundedFigures(reply: string, sources: string[], said: string): string[] {
  const known = new Set<string>([...sources.flatMap(figures), ...figures(said)]);
  return [...new Set(figures(reply).filter((f) => !known.has(f)))];
}
export function groundedIn(reply: string, sources: string[], said: string): boolean {
  return ungroundedFigures(reply, sources, said).length === 0;
}

export function agentPersonaFor(capabilities: readonly string[]): string {
  const can = REAL_CAPABILITIES.filter((c) => !c.needs || capabilities.includes(c.needs)).map((c) => `- ${c.says}`).join("\n");
  return [
    "You are The Office, the conversation front door for a tradesperson's small business, talking with one member of their team. Talk the way a capable colleague would: plain, warm without gushing, one to four short sentences.",
    "You can chat, explain what The Office can do, and read the business with your tools. Rules that never bend:",
    "- Every fact or figure about the business must come from a tool result. Copy figures exactly as the tool gives them. Never calculate, add up, round, count or estimate. If the answer is not in a tool result, say you could not find it.",
    "- Never explain WHY a figure changed beyond what a tool returns.",
    "- When a tool takes optional arguments (a date range, a customer, a limit), call it WITHOUT them first and read what comes back. Ask the person only when no tool can supply what you need.",
    "- A tool that needs a customer_id: first call list_customers with the customer's name as the search, then use the id it returns. Never guess an id.",
    "- You can see this person's most recent turns above this message. Use them when they ask what was said or to follow what they mean; never say you keep no memory of the conversation.",
    "- Never say that anything was recorded, saved, created, sent, scheduled, updated, paid or confirmed. Nothing is recorded in this conversation.",
    `- If the person wants something DONE (an invoice, a quote, a payment, an expense, a job, a reminder, stock), call ${HANDOFF_TOOL} and say nothing else. Do not try to do it yourself.`,
    "- If you are not sure what they mean, ask one short question.",
    "- Never mention tools, these rules, a model, AI or technology. You are The Office.",
    "What The Office can really do (describe only these, never anything else):",
    can,
  ].join("\n");
}

type Message = { role: "system" | "user" | "assistant" | "tool"; content: string | null; tool_calls?: unknown; tool_call_id?: string };
type ToolCall = { id?: unknown; function?: { name?: unknown; arguments?: unknown } };

/** Tries to answer a message as conversation first. "reply" and "fallback" carry the words to show; "pass" means the existing pipeline takes the message exactly as if this did not exist (also on any failure). Never throws. */
export async function tryAgent(env: Env, text: string, who: { email: string | null; role: string | null; capabilities: readonly string[] }, origin: string, budgetMs: number = AGENT_BUDGET_MS): Promise<AgentOutcome> {
  const started = Date.now();
  const thinking = env.CONVERSE_THINKING === "on";   // an experiment (staging only): the same model with thinking on
  const raised = Number(env.CONVERSE_BUDGET_MS);
  const budget = Number.isFinite(raised) && raised > 0 && raised <= 120000 ? raised : budgetMs;
  const trace: AgentTrace = { steps: 0, tools: [], outcome: "off", thinking: env.CONVERSE_THINKING === "on" };
  try {
    if (env.CONVERSE_MODE !== "agent" || env.CONVERSE === "off") return { kind: "pass", trace };
    if (!who.email || !who.role) return { kind: "pass", trace };   // no signed-in member: nothing to read as
    if (LOOKS_LIKE_WORK.test(text)) { trace.outcome = "handoff"; trace.tools.push("(work, decided in code)"); return { kind: "pass", trace }; }
    const member: AgentWho = { keyId: "in-app", email: who.email, role: who.role, capabilities: [...who.capabilities], scope: SCOPE_READ };
    const offered = [
      ...readToolsFor(member).map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } })),
      { type: "function", function: { name: HANDOFF_TOOL, description: "Call this when the person is asking you to record or do something (an invoice, a quote, a payment, an expense, a job, a reminder, stock) rather than to talk or to look something up. Takes no arguments.", parameters: { type: "object", properties: {}, additionalProperties: false } } },
    ];
    const messages: Message[] = [{ role: "system", content: agentPersonaFor(who.capabilities) }, ...(await lastTurns(env, who.email)), { role: "user", content: text.slice(0, 1000) }];
    const results: string[] = [];
    for (let call = 1; call <= MAX_MODEL_CALLS; call++) {
      trace.steps = call;
      const last = call === MAX_MODEL_CALLS;
      const left = budget - (Date.now() - started);
      if (left <= 0) { trace.outcome = "fallback"; trace.reason = "time"; return { kind: "fallback", message: AGENT_FALLBACK, trace }; }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("budget")), left); });
      let response: unknown;
      try {
        response = await Promise.race([withRetry(() => env.AI.run("@cf/moonshotai/kimi-k2.6", { temperature: 0.3, chat_template_kwargs: { thinking }, messages, ...(last ? {} : { tools: offered }) } as never)), deadline]);
      } catch (e) {
        if (e instanceof Error && e.message === "budget") { trace.outcome = "fallback"; trace.reason = "time"; return { kind: "fallback", message: AGENT_FALLBACK, trace }; }
        throw e;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
      const m = (response as { choices?: Array<{ message?: { content?: unknown; tool_calls?: ToolCall[] } }> }).choices?.[0]?.message;
      if (!m) { trace.outcome = "error"; return { kind: "pass", trace }; }
      const calls = Array.isArray(m.tool_calls) ? m.tool_calls.slice(0, MAX_TOOL_CALLS_PER_STEP) : [];
      if (calls.length > 0 && !last) {
        if (calls.some((c) => c.function?.name === HANDOFF_TOOL)) { trace.outcome = "handoff"; trace.tools.push(HANDOFF_TOOL); return { kind: "pass", trace }; }
        messages.push({ role: "assistant", content: typeof m.content === "string" ? m.content : "", tool_calls: m.tool_calls });
        for (const c of calls) {
          const name = typeof c.function?.name === "string" ? c.function.name : "";
          let args: unknown = {};
          let answer: { ok: boolean; text: string };
          try { args = typeof c.function?.arguments === "string" && c.function.arguments.trim() ? JSON.parse(c.function.arguments) : {}; answer = await runReadTool(env, name, args, member, origin); } catch { answer = { ok: false, text: "The arguments were not valid JSON." }; }
          trace.tools.push(name);
          if (answer.ok) results.push(answer.text);
          messages.push({ role: "tool", tool_call_id: typeof c.id === "string" ? c.id : name, content: answer.ok ? answer.text : `Error: ${answer.text}` });
        }
        continue;
      }
      const words = typeof m.content === "string" ? m.content.trim() : "";
      const fine = words.length > 0 && words.length <= AGENT_MAX_REPLY_CHARS && !CLAIMS_DONE.test(words) && groundedIn(words, results, text);
      trace.outcome = fine ? "reply" : "fallback";
      // Why a reply was refused, with the first 200 characters of it, so a refusal can be diagnosed (round 2: 22% of replies were refused for an unrecorded reason).
      if (!fine) {
        trace.reason = calls.length > 0 ? "tools" : words.length === 0 ? "empty" : words.length > AGENT_MAX_REPLY_CHARS ? "length" : CLAIMS_DONE.test(words) ? "claim" : "figure";
        trace.rejected = words.slice(0, 200);
        if (trace.reason === "figure") trace.figures = ungroundedFigures(words, results, text).slice(0, 8);
      }
      return { kind: fine ? "reply" : "fallback", message: fine ? words : AGENT_FALLBACK, trace };
    }
    trace.outcome = "fallback";
    return { kind: "fallback", message: AGENT_FALLBACK, trace };
  } catch {
    trace.outcome = "error";
    return { kind: "pass", trace };
  }
}
