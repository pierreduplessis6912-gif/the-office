// A read-only freeze, for the final copy of a migration (READ_ONLY = "1").
//
// Cutover 2026-10-13. A migration copies a live business over minutes; for the LAST copy nothing may change underneath it, or the copy would miss it. While READ_ONLY is "1", every request that would
// CHANGE something is refused with a clear 503 (the app shows it; a retry after the window works), while reading carries on. Not frozen: reads (GET, HEAD, OPTIONS), the admin and debug routes (the
// migration itself needs them, and they are behind the admin keys), and sign-in and sign-out. Off unless the variable is exactly "1".
import { isAdminPath } from "./auth";
import type { Env } from "./types";

export function readOnlyRefusal(request: Request, env: Env): Response | null {
  if (env.READ_ONLY !== "1") return null;
  if (request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS") return null;
  const path = new URL(request.url).pathname;
  if (isAdminPath(path) || path.startsWith("/auth/")) return null;
  return Response.json(
    { error: "The Office is being moved to its new home and is read-only for a few minutes. Please try again shortly.", readOnly: true, retryAfterSeconds: 120 },
    { status: 503, headers: { "Retry-After": "120" } }
  );
}
