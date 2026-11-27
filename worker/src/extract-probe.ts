// The staging extraction probe (docs/decisions/extract-model-run.md): POST /debug/extract-probe calls ONE allowed function of ai.ts with the given inputs
// and returns what it returned, with which model answered and why none did. It writes nothing (no rows, no memory, no files): the functions listed here
// are the pure model calls, and the ones that touch memory or files are not listed. Admin key only, like every /debug route.
import type { Env } from "./types";
import * as ai from "./ai";

type Call = (env: Env, a: any) => Promise<unknown>;

// One entry per allowed function: how the JSON the caller sent becomes the function's arguments. Anything not listed is refused.
const ALLOWED: Record<string, Call> = {
  splitIntoTopics: (env, a) => ai.splitIntoTopics(env, String(a.text ?? "")),
  extractIntent: (env, a) => ai.extractIntent(env, String(a.text ?? "")),
  extractLineItems: (env, a) => ai.extractLineItems(env, String(a.text ?? "")),
  extractGoodsReceived: (env, a) => ai.extractGoodsReceived(env, String(a.text ?? ""), Array.isArray(a.poLineItems) ? a.poLineItems : []),
  extractStockUsage: (env, a) => ai.extractStockUsage(env, String(a.text ?? ""), Array.isArray(a.stockItems) ? a.stockItems : []),
  extractStocktake: (env, a) => ai.extractStocktake(env, String(a.text ?? ""), Array.isArray(a.stockItems) ? a.stockItems : []),
  extractSnag: (env, a) => ai.extractSnag(env, String(a.text ?? "")),
  extractLead: (env, a) => ai.extractLead(env, String(a.text ?? "")),
  extractLeadLost: (env, a) => ai.extractLeadLost(env, String(a.text ?? ""), Array.isArray(a.openLeads) ? a.openLeads : []),
  classifyExpenseCategory: (env, a) => ai.classifyExpenseCategory(env, String(a.text ?? "")),
  classifyDashboardIntent: (env, a) => ai.classifyDashboardIntent(env, String(a.text ?? "")),
  containsBackwardReference: (env, a) => ai.containsBackwardReference(env, String(a.text ?? "")),
  answerFromMemory: (env, a) => ai.answerFromMemory(env, String(a.text ?? ""), Array.isArray(a.facts) ? a.facts.map(String) : []),
  resolveFollowUpEntity: (env, a) => ai.resolveFollowUpEntity(env, Array.isArray(a.history) ? a.history : [], String(a.text ?? "")),
};

export const EXTRACT_PROBE_FUNCTIONS = Object.keys(ALLOWED);

export async function extractProbe(request: Request, env: Env): Promise<Response> {
  let body: { fn?: unknown; args?: unknown } | null = null;
  try { body = (await request.json()) as { fn?: unknown; args?: unknown }; } catch { body = null; }
  const fn = typeof body?.fn === "string" ? body.fn : "";
  if (!Object.prototype.hasOwnProperty.call(ALLOWED, fn)) {
    return Response.json({ error: "unknown_function", allowed: EXTRACT_PROBE_FUNCTIONS }, { status: 422 });
  }
  const args = body && typeof body.args === "object" && body.args !== null ? body.args : {};
  const started = Date.now();
  // The functions swallow a model failure and return their own empty answer, so the reason is read from the router's note of its last call.
  const before = ai.lastModelCall;
  let result: unknown = null, threw: string | null = null;
  try { result = await ALLOWED[fn](env, args); } catch (e) { threw = String((e as Error)?.message ?? e).slice(0, 200); }
  const after = ai.lastModelCall;
  const called = after !== before ? after : null;   // null when the function never asked a model (for example, nothing to ask about)
  return Response.json({ fn, result, threw, route: called?.route ?? null, via: called?.via ?? null, why: called?.why ?? null, ms: Date.now() - started });
}
