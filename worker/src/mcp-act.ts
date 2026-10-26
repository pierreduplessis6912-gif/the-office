// How an assistant's confirm or reject reaches the app's own route (MCP_ARCHITECTURE.md). It goes through the front door as the MEMBER the key belongs to, with a ONE-MINUTE session made here and never shown to anyone, so the app's own gate (who may confirm what), its atomic write and its decision log all apply, and nothing of the confirm logic is copied. Kept out of index.ts, which must not build sessions itself.
import { signSession } from "./auth";
import type { Env } from "./types";

export async function actThroughApp(env: Env, serve: (request: Request) => Promise<Response>, requestUrl: string, kind: "confirm" | "reject", actionId: number, who: { email: string }): Promise<{ status: number; body: unknown }> {
  if (!Number.isInteger(actionId) || actionId < 1) return { status: 400, body: { error: "bad action id" } };
  const token = await signSession(env, who.email, env.BUSINESS_ID, Date.now() + 60_000);
  const inner = await serve(new Request(new URL(`/actions/${actionId}/${kind}`, requestUrl), { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: "{}" }));
  let body: unknown = null; try { body = await inner.json(); } catch { body = null; }
  return { status: inner.status, body };
}
