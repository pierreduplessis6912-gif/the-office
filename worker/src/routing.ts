// The Worker's router (object mode): which business's object should serve this request, or should the Worker answer itself?
//
// Architecture stage 2b, 2026-10-12. A request is routed with NO database lookup: a signed-in member's session carries the business id (`b`), a customer's signed link carries it, and an
// administrator names it in a header. The router verifies the signature before it trusts a session, and what it finds is only a ROUTING hint: every object independently refuses a session
// or a link made for another business (auth.ts), so a mistake here can send a request to the wrong object but can never show it another business's data.
import { getSessionToken, isAdminPath, peekBusinessFromToken, peekIsLegacyLink, readSessionPayload } from "./auth";
import { safeEqual } from "./admin-gate";
import { isBusinessId, objectNameFor } from "./directory";
import type { Env } from "./types";

export type Route = { kind: "worker" } | { kind: "business"; businessId: string } | { kind: "refuse"; status: number; error: string };

// Public routes that need no business: the Worker answers them itself. (A sign-in finds the business in the directory; it does not need one to start.)
const WORKER_ONLY = new Set(["/", "/health", "/auth/google/login", "/auth/google/callback", "/auth/signup", "/auth/logout"]);
// Admin routes the Worker answers itself: they work on the shared layer or on the Worker's own bindings, not on a business's data. The two memory routes report on the WHOLE shared index (its total
// vector count and indexing lag), which belongs to the platform; a business's own scoped view of the index cannot describe it (scoped-bindings.ts).
const WORKER_ADMIN = new Set(["/debug/trial-d1", "/debug/trial-do", "/debug/trial-tx", "/debug/trial-ai", "/debug/memory-health", "/debug/stress-memory"]);   // /debug/timings is NOT here: the model-versus-database split lives inside each business's object

export async function routeRequest(request: Request, env: Env): Promise<Route> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (WORKER_ONLY.has(path)) return { kind: "worker" };
  if (isAdminPath(path)) {
    if (path === "/debug/directory" || path.startsWith("/debug/directory/") || WORKER_ADMIN.has(path)) return { kind: "worker" };
    const key = request.headers.get("X-Admin-Key");
    // Only a caller who already holds the admin key may name a business. A wrong or missing key is left to the Worker's own admin gate, which refuses it and records the attempt.
    if (key && env.ADMIN_KEY && (await safeEqual(key, env.ADMIN_KEY))) {
      const target = request.headers.get("X-Target-Business");
      if (!target) return { kind: "refuse", status: 400, error: "name the business this admin call is for: send X-Target-Business" };
      if (!isBusinessId(target)) return { kind: "refuse", status: 400, error: "X-Target-Business is not a valid business id" };
      return { kind: "business", businessId: target };
    }
    return { kind: "worker" };
  }
  if (path.endsWith("/pdf")) {
    const business = peekBusinessFromToken(url.searchParams.get("sig"));
    if (business) return { kind: "business", businessId: business };
    // A link issued before the move carries no business: it belongs to the one business designated for such links (that object verifies the signature itself); with none designated, the Worker's gate refuses it.
    return isBusinessId(env.LEGACY_LINK_BUSINESS) && peekIsLegacyLink(url.searchParams.get("sig")) ? { kind: "business", businessId: env.LEGACY_LINK_BUSINESS } : { kind: "worker" };
  }
  const session = await readSessionPayload(env, getSessionToken(request));
  if (session?.b) return { kind: "business", businessId: session.b };
  return { kind: "worker" };   // no usable session: the Worker's gate answers 401, and no object is woken
}

// Hands a request to a business's object. The hint only matters when the object is first created: Western Europe, next to the shared layer and the best placement Cloudflare offers.
// A client-supplied business header is overwritten, and the one used to NAME a business for an admin call is removed, so neither can reach the object.
export async function forwardToBusiness(request: Request, env: Env, businessId: string): Promise<Response> {
  const namespace = env.BUSINESS as DurableObjectNamespace;
  const headers = new Headers(request.headers);
  headers.delete("X-Target-Business");
  headers.set("X-Business-Id", businessId);
  return namespace.get(namespace.idFromName(objectNameFor(businessId)), { locationHint: "weur" }).fetch(new Request(request, { headers }));
}

// An internal call from the Worker to a business's object, with the admin keys it holds itself (used to create a business's owner and to check a membership at sign-in).
export async function callBusiness(env: Env, businessId: string, method: string, path: string, body?: unknown): Promise<Response> {
  const namespace = env.BUSINESS;
  if (!namespace) throw new Error("business objects are not enabled here");
  const headers: Record<string, string> = { "X-Business-Id": businessId, "X-Admin-Key": env.ADMIN_KEY };
  if (env.ADMIN_CONFIRM_KEY) headers["X-Admin-Confirm"] = env.ADMIN_CONFIRM_KEY;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const stub = namespace.get(namespace.idFromName(objectNameFor(businessId)), { locationHint: "weur" });
  return stub.fetch(`https://business${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

// BEFORE a cutover, the Worker still serves from its own database (default mode), but an administrator must be able to reach a business's object to copy data into it and to check it. This answers, for that
// one case only: an ADMIN route, with the admin key, naming a business, on a deployment that has business objects. Nothing else is ever routed to an object in default mode (a session's business is ignored there).
export async function adminTargetBusiness(request: Request, env: Env): Promise<string | null> {
  if (!env.BUSINESS) return null;
  const target = request.headers.get("X-Target-Business");
  if (!target || !isBusinessId(target)) return null;
  const path = new URL(request.url).pathname;
  if (!isAdminPath(path) || path === "/debug/directory" || path.startsWith("/debug/directory/") || WORKER_ADMIN.has(path)) return null;
  const key = request.headers.get("X-Admin-Key");
  return key && env.ADMIN_KEY && (await safeEqual(key, env.ADMIN_KEY)) ? target : null;
}
