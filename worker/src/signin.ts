// How a successful sign-in ends, shared by the Google callback and by starting a business from the app (signup.ts): the session is cookie-ed AND handed to the app by a redirect, to its own address (`theoffice://` on a phone, the
// web origin remembered from /auth/google/login on the web). Moved out of index.ts unchanged in behaviour so the two paths cannot drift apart.
import { getCookie, signSession } from "./auth";
import type { Env } from "./types";

export async function signedInRedirect(
  request: Request,
  env: Env,
  who: { sessionEmail: string; displayEmail: string; role: string; businessId?: string; notAfterMs?: number },
  status = 302
): Promise<Response> {
  const sessionToken = await signSession(env, who.sessionEmail, who.businessId, who.notAfterMs);
  // The redirect target is platform-aware (2026-07-27): flutter_web_auth_2's web implementation must land on the exact origin the app runs on, while native uses the theoffice:// scheme. With no platform
  // remembered from /auth/google/login it falls back to native, which has always been the working path.
  const platform = getCookie(request, "oauth_platform");
  const redirectOrigin = getCookie(request, "oauth_redirect_origin");
  const callbackUrl = platform === "web" && redirectOrigin ? new URL(`${redirectOrigin}/auth-callback.html`) : new URL("theoffice://auth-callback");
  callbackUrl.searchParams.set("token", sessionToken);
  callbackUrl.searchParams.set("email", who.displayEmail);
  callbackUrl.searchParams.set("role", who.role);
  return new Response(null, {
    status,
    headers: {
      Location: callbackUrl.toString(),
      "Set-Cookie": `office_session=${sessionToken}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`,
    },
  });
}
