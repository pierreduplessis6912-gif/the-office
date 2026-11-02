// The engine / legacy BOUNDARY. A business is either an ENGINE business or a LEGACY one, stored once (eng_config key 'mode' = "engine"; absent means legacy), and the two never write the same business's records:
// the legacy domain code writes the legacy tables, the engine writes the eng_ tables, and nothing is both. The boundary is not one check at one route. Every way in is classified here and tested against the
// real request handler (tools/engine-boundary.test.js): the HTTP routes (inventoried against ROUTE_POLICY.md, so a new write route cannot exist unclassified), the held-action lifecycle (an action of the
// other kind is refused before it is claimed), and the MCP tool list (mcp.ts asks isEngineMode). Background work (the cron consolidation, the object's alarm) writes only infrastructure and is checked too.
import type { Env } from "../types";

export type RouteClass =
  | "business_write"      // changes the business's records through the LEGACY domain path: refused in an engine business
  | "shared_lifecycle"    // the held-action lifecycle (confirm, reject, edit): shared by both, decided by the action's TYPE
  | "platform_write"      // the platform: team, settings, billing, keys, onboarding: works in both
  | "public"              // no session: sign-in, sign-up, payment notification
  | "mcp"                 // the outside-assistant endpoint: its tool list depends on the mode
  | "engine"              // /engine/*: the engine's own routes: refused in a legacy business
  | "other";              // reads and everything else: not a business write

type Rule = [method: string, path: RegExp, cls: RouteClass];

// Order matters: the first match wins.
const RULES: Rule[] = [
  ["POST", /^\/files\/team-csv-import$/, "platform_write"],          // writes memberships, not business records
  ["POST", /^\/files\/[^/]+$/, "business_write"],                    // audio, document, photo and every other CSV import
  ["PATCH", /^\/customers\/\d+$/, "business_write"],
  ["PATCH", /^\/invoices\/\d+$/, "business_write"],
  ["PATCH", /^\/quotations\/\d+$/, "business_write"],
  ["POST", /^\/leads\/\d+\/mark-lost$/, "business_write"],
  ["POST", /^\/snags\/\d+\/resolve$/, "business_write"],
  ["POST", /^\/suppliers\/discrepancies\/\d+\/resolve$/, "business_write"],
  ["POST", /^\/tasks\/\d+\/done$/, "business_write"],
  ["POST", /^\/upload\/[^/]+$/, "business_write"],                   // a file sent through a signed link
  ["POST", /^\/messages\/text$/, "business_write"],                  // conversation into the legacy pipeline
  ["POST", /^\/mcp-created\/undo$/, "business_write"],               // undo of legacy records an assistant created
  ["POST", /^\/actions\/\d+\/correct$/, "business_write"],           // correcting a LEGACY held action
  ["POST", /^\/actions\/\d+\/(confirm|reject|edit-field)$/, "shared_lifecycle"],
  ["POST", /^\/mcp$/, "mcp"],
  ["PATCH", /^\/settings\/permissions$/, "platform_write"],
  ["POST", /^\/settings\/permissions\/reset$/, "platform_write"],
  ["PATCH", /^\/team\/\d+(\/profile)?$/, "platform_write"],
  ["POST", /^\/team(\/invite|\/\d+\/(deactivate|reactivate)|\/invitations\/\d+\/revoke)?$/, "platform_write"],
  ["POST", /^\/billing\/(checkout|plans-link)$/, "platform_write"],
  ["POST", /^\/business-profile\/logo$/, "platform_write"],
  ["POST", /^\/context\/check$/, "platform_write"],                  // validates a context's shape, writes nothing
  ["POST", /^\/mcp-keys(\/revoke)?$/, "platform_write"],
  ["POST", /^\/onboarding\/step$/, "platform_write"],
  ["POST", /^\/$/, "public"],
  ["POST", /^\/auth\/(join|logout|signup)$/, "public"],
  ["POST", /^\/billing\/(start|payfast\/notify)$/, "public"],
];

export function classify(method: string, pathname: string): RouteClass {
  if (pathname === "/engine" || pathname.startsWith("/engine/")) return "engine";
  for (const [m, re, cls] of RULES) if (m === method && re.test(pathname)) return cls;
  return "other";
}

export async function isEngineMode(env: Env): Promise<boolean> {
  try {
    const row = await env.OFFICE_DB.prepare("SELECT value_json FROM eng_config WHERE key = 'mode'").first<{ value_json: string }>();
    return row?.value_json === '"engine"';
  } catch {
    return false;   // a database without the engine tables (an older object, a test's fake) is a legacy business
  }
}

export async function setEngineMode(env: Env, on: boolean): Promise<void> {
  if (on) await env.OFFICE_DB.prepare("INSERT INTO eng_config (key, value_json) VALUES ('mode', '\"engine\"') ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json").run();
  else await env.OFFICE_DB.prepare("DELETE FROM eng_config WHERE key = 'mode'").run();
}

const refuse = (status: number, error: "engine_mode" | "not_engine_mode", message: string): Response => Response.json({ error, message }, { status });

// Called right after authentication, before any route runs. A legacy business write in an engine business, and an engine route in a legacy business, are refused here and nothing is written.
export async function engineModeGate(request: Request, env: Env, url: URL): Promise<Response | null> {
  const cls = classify(request.method, url.pathname);
  if (cls !== "business_write" && cls !== "engine") return null;
  const engine = await isEngineMode(env);
  if (cls === "engine") return engine ? null : refuse(409, "not_engine_mode", "This business does not use the engine, so nothing was done.");
  return engine ? refuse(409, "engine_mode", "This business uses the engine: that part of the older system is not available for it, so nothing was done.") : null;
}

// A held action is an engine action when its type says so. One of the other kind is refused before it is claimed, confirmed, rejected or edited.
export async function actionModeRefusal(env: Env, actionType: string): Promise<Response | null> {
  const isEngineAction = actionType.startsWith("engine.");
  const engine = await isEngineMode(env);
  if (isEngineAction === engine) return null;
  return isEngineAction ? refuse(409, "not_engine_mode", "That action belongs to the engine, and this business does not use it, so nothing was done.") : refuse(409, "engine_mode", "That action belongs to the older system, and this business uses the engine, so nothing was done.");
}
