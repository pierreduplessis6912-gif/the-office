// The engine's own HTTP routes (/engine/*), a thin skin over the operation boundary: the route parses the request and calls the SAME function a test or an outside assistant would, then maps the answer to a status.
// Authentication and the role gate have already run (auth.ts), the mode gate has already refused a legacy business (boundary.ts), and the member's permissions are the engine's, not the route's.
import type { Env } from "../types";
import { invokeRead, proposeCapabilityAs, type Member } from "./operations";

export function statusFor(code: string): number {
  if (code === "not_permitted") return 403;
  if (code === "not_found" || code === "unknown_capability") return 404;
  if (code === "invalid_payload" || code === "invalid_input" || code === "invalid_amount" || code === "amount_out_of_range") return 422;
  return 409;
}
const answer = (o: { status: string; result?: unknown; candidates?: unknown; code?: string; message?: string }): Response => {
  if (o.status === "ok") return Response.json({ status: "ok", result: o.result });
  if (o.status === "ambiguous") return Response.json({ status: "ambiguous", candidates: o.candidates });
  return Response.json({ error: o.code, message: o.message }, { status: statusFor(o.code ?? "") });
};

export async function handleEngineRoute(request: Request, env: Env, url: URL, member: Member): Promise<Response> {
  const path = url.pathname;
  if (request.method === "GET" && path === "/engine/receivables") {
    const party = url.searchParams.get("party") ?? "";
    return answer(await invokeRead(env, member, "receivables.query", /^\d+$/.test(party) ? { partyId: Number(party) } : party ? { partyName: party } : {}));
  }
  const rec = path.match(/^\/engine\/records\/([a-z]+)\/(\d+)$/);
  if (request.method === "GET" && rec) return answer(await invokeRead(env, member, "records.get", { kind: rec[1], id: Number(rec[2]) }));
  if (request.method === "POST" && path === "/engine/proposals") {
    const body = (await request.json().catch(() => null)) as { capability?: unknown; payload?: unknown; transcript?: unknown } | null;
    if (!body || typeof body !== "object") return Response.json({ error: "invalid_payload", message: "the request must be a JSON object" }, { status: 422 });
    const transcript = typeof body.transcript === "string" && body.transcript.trim() ? body.transcript : `(proposed from the app) ${String(body.capability)}`;
    const r = await proposeCapabilityAs(env, member, { capability: body.capability, payload: body.payload, transcript, source: "app" });
    return r.status === "held" ? Response.json({ status: "held", actionId: r.actionId, message: r.message }) : Response.json({ error: r.code, message: r.message }, { status: statusFor(r.code) });
  }
  return Response.json({ error: "not_found", message: "There is no such engine route." }, { status: 404 });
}
