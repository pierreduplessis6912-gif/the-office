// The engine's own HTTP routes (/engine/*), a thin skin over the operation boundary: the route parses the request and calls the SAME function a test or an outside assistant would, then maps the answer to a status.
// Authentication and the role gate have already run (auth.ts), the mode gate has already refused a legacy business (boundary.ts), and the member's permissions are the engine's, not the route's.
import type { Env } from "../types";
import { invokeRead, proposeCapabilityAs, type Member } from "./operations";
import { interpretSentence } from "./interpret";

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
  try {
    return await route(request, env, url, member);
  } catch (e) {
    // Found 2026-11-09: every member engine read on the real staging-two object answered the front door's generic 500, which says nothing about what failed (by design). On a REHEARSAL deployment (ENGINE_REHEARSAL=1: staging has it, production does not)
    // an unexpected exception inside an engine route says what it was (its name and message, never a stack, and never anything about another business), so a staging run can show why. Anywhere else it reaches the front door's generic answer, as before.
    if (env.ENGINE_REHEARSAL !== "1") throw e;
    const failure = e instanceof Error ? e : new Error(String(e));
    return Response.json({ error: "engine_route_failed", message: "An engine route failed on this rehearsal deployment.", detail: `${failure.name}: ${failure.message}`.slice(0, 300) }, { status: 500 });
  }
}

async function route(request: Request, env: Env, url: URL, member: Member): Promise<Response> {
  const path = url.pathname;
  if (request.method === "GET" && path === "/engine/receivables") {
    const party = url.searchParams.get("party") ?? "";
    return answer(await invokeRead(env, member, "receivables.query", /^\d+$/.test(party) ? { partyId: Number(party) } : party ? { partyName: party } : {}));
  }
  if (request.method === "GET" && path === "/engine/parties") {
    const name = url.searchParams.get("name"), role = url.searchParams.get("role");
    return answer(await invokeRead(env, member, "parties.find", { ...(name !== null ? { name } : {}), ...(role !== null ? { role } : {}) }));
  }
  if (request.method === "GET" && path === "/engine/quotations") {
    const pid = url.searchParams.get("partyId"), st = url.searchParams.get("status");
    return answer(await invokeRead(env, member, "quotations.find", { ...(pid !== null ? { partyId: /^\d+$/.test(pid) ? Number(pid) : pid } : {}), ...(st !== null ? { status: st } : {}) }));
  }
  if (request.method === "GET" && path === "/engine/business") return answer(await invokeRead(env, member, "business.get", {}));
  if (request.method === "GET" && path === "/engine/credits") {
    const pid = url.searchParams.get("partyId");
    return answer(await invokeRead(env, member, "credits.find", pid !== null ? { partyId: /^\d+$/.test(pid) ? Number(pid) : pid } : {}));
  }
  if (request.method === "GET" && path === "/engine/vat") {
    const from = url.searchParams.get("from"), to = url.searchParams.get("to");
    return answer(await invokeRead(env, member, "vat.summary", { ...(from !== null ? { from } : {}), ...(to !== null ? { to } : {}) }));
  }
  if (request.method === "GET" && path === "/engine/expenses") {
    const q = (k: string) => url.searchParams.get(k);
    const sid = q("supplierId");
    return answer(await invokeRead(env, member, "expenses.find", { ...(q("from") !== null ? { from: q("from") } : {}), ...(q("to") !== null ? { to: q("to") } : {}), ...(q("category") !== null ? { category: q("category") } : {}), ...(sid !== null ? { supplierId: /^\d+$/.test(sid) ? Number(sid) : sid } : {}), ...(q("status") !== null ? { status: q("status") } : {}) }));
  }
  if (request.method === "GET" && path === "/engine/purchase-orders") {
    const q = (k: string) => url.searchParams.get(k);
    const sid = q("supplierId");
    return answer(await invokeRead(env, member, "purchase_orders.find", { ...(sid !== null ? { supplierId: /^\d+$/.test(sid) ? Number(sid) : sid } : {}), ...(q("status") !== null ? { status: q("status") } : {}) }));
  }
  if (request.method === "GET" && path === "/engine/supplier-invoices") {
    const q = (k: string) => url.searchParams.get(k);
    const sid = q("supplierId");
    return answer(await invokeRead(env, member, "supplier_invoices.find", { ...(sid !== null ? { supplierId: /^\d+$/.test(sid) ? Number(sid) : sid } : {}), ...(q("status") !== null ? { status: q("status") } : {}) }));
  }
  if (request.method === "GET" && path === "/engine/items") {
    const q = (k: string) => url.searchParams.get(k);
    const flag = (k: string) => (q(k) === "true" ? true : q(k) === "false" ? false : q(k) === null ? undefined : q(k));
    return answer(await invokeRead(env, member, "items.find", { ...(q("name") !== null ? { name: q("name") } : {}), ...(q("sku") !== null ? { sku: q("sku") } : {}), ...(flag("active") !== undefined ? { active: flag("active") } : {}), ...(flag("belowReorder") !== undefined ? { belowReorder: flag("belowReorder") } : {}) }));
  }
  if (request.method === "GET" && path === "/engine/stock") {
    const q = (k: string) => url.searchParams.get(k);
    const num = (k: string) => { const v = q(k); return v === null ? undefined : /^\d+$/.test(v) ? Number(v) : v; };
    return answer(await invokeRead(env, member, "stock.on_hand", { ...(num("itemId") !== undefined ? { itemId: num("itemId") } : {}), ...(num("locationId") !== undefined ? { locationId: num("locationId") } : {}) }));
  }
  if (request.method === "GET" && path === "/engine/stock/ledger") {
    const q = (k: string) => url.searchParams.get(k);
    const iid = q("itemId");
    return answer(await invokeRead(env, member, "stock.ledger", { ...(iid !== null ? { itemId: /^\d+$/.test(iid) ? Number(iid) : iid } : {}), ...(q("from") !== null ? { from: q("from") } : {}), ...(q("to") !== null ? { to: q("to") } : {}) }));
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
  if (request.method === "POST" && path === "/engine/interpret") {
    // A model as one more interpreter (engine/interpret.ts): the sentence goes to the model, and what it understood goes through the same door as every other client; nothing here approves anything.
    const body = (await request.json().catch(() => null)) as { text?: unknown } | null;
    if (!body || typeof body !== "object") return Response.json({ error: "invalid_payload", message: "the request must be a JSON object" }, { status: 422 });
    const r = await interpretSentence(env, member, body.text, new Date().toISOString().slice(0, 10));
    if (r.kind === "held") return Response.json({ status: "held", actionId: r.actionId, message: r.message, understood: r.understood });
    if (r.kind === "read") return r.outcome.status === "ok" ? Response.json({ status: "ok", result: r.outcome.result, understood: r.understood }) : r.outcome.status === "ambiguous" ? Response.json({ status: "ambiguous", candidates: r.outcome.candidates, understood: r.understood }) : Response.json({ error: r.outcome.code, message: r.outcome.message }, { status: statusFor(r.outcome.code) });
    const rehearsal = (env as unknown as { ENGINE_REHEARSAL?: string }).ENGINE_REHEARSAL === "1";                       // the model's own reply is shown ONLY in a rehearsal, never to a business
    if (r.kind === "refused") return Response.json({ error: r.code, message: r.message, ...(rehearsal && r.debug ? { debug: { modelReply: r.debug } } : {}) }, { status: statusFor(r.code) });
    if (r.kind === "not_understood") return Response.json({ error: "not_understood", message: r.message, ...(rehearsal && r.debug ? { debug: { modelReply: r.debug } } : {}) }, { status: 422 });
    return Response.json({ error: "model_unavailable", message: r.message }, { status: 503 });
  }
  return Response.json({ error: "not_found", message: "There is no such engine route." }, { status: 404 });
}
