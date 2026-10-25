// The Worker's OAuth routes for assistants that cannot send a static key (claude.ai connectors). The rules live in mcp-oauth.ts (pure, tested on their own); this file only connects them to requests, cookies and the business's object. SECURITY-SENSITIVE (MCP_ARCHITECTURE.md, "OAuth for connectors"). Owner only, read-only scope; the token is an ordinary read-only key.
// THE FLOW: /oauth/authorize checks the request and parks it in a sealed cookie, then sends the browser to the existing Google sign-in (/auth/google/login?mcp=1). The Google callback calls continueOAuthSignIn: only an ACTIVE OWNER reaches the consent page (anyone else is sent back to the assistant as "access_denied"); the page's Allow button posts a signed ticket to /oauth/consent, which returns a single-use code; /oauth/token trades that code (with the PKCE verifier) for a key, issued inside the business's object (mcp-oauth-issue.ts), which is where "a code works once" is enforced.
// Nothing here opens when MCP is switched off, when the deployment has no business objects, or when SESSION_SECRET is missing: every path answers 404.
import { getCookie } from "./auth";
import { safeEqual } from "./admin-gate";
import { isBusinessId } from "./directory";
import * as oauth from "./mcp-oauth";
import { callBusiness } from "./routing";
import type { Env } from "./types";

const WELL_KNOWN = ["/.well-known/oauth-protected-resource", "/.well-known/oauth-authorization-server"];
const isOAuthPath = (path: string): boolean => oauth.OAUTH_PUBLIC_PATHS.includes(path);
const MAX_BODY = 8192;
const COOKIE_REQUEST = "oauth_mcp", COOKIE_NONCE = "oauth_mcp_nonce";
const CORS: Record<string, string> = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization, MCP-Protocol-Version", "Access-Control-Max-Age": "600" };   // no cookies are ever allowed cross-origin: these answers carry nothing a browser session could abuse
const enabled = (env: Env): boolean => env.MCP !== "off" && env.BUSINESS_MODE === "object" && typeof env.SESSION_SECRET === "string" && env.SESSION_SECRET.length > 0;
const randomNonce = (): string => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(18)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const esc = (text: string): string => text.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch] as string));

function json(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: { ...CORS, "Cache-Control": "no-store", Pragma: "no-cache" } });
}
/** A page for a person's browser. Never framed (the Allow button must not be clickable from another site) and nothing but its own styles may load. */
function page(status: number, html: string, cookies: string[] = []): Response {
  const headers = new Headers({ "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'" });
  for (const c of cookies) headers.append("Set-Cookie", c);
  return new Response(html, { status, headers });
}
function go(location: string, cookies: string[] = []): Response {
  const headers = new Headers({ Location: location, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
  for (const c of cookies) headers.append("Set-Cookie", c);
  return new Response(null, { status: 302, headers });
}
const notice = (title: string, text: string): string => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title><style>body{font:16px system-ui,sans-serif;margin:0;padding:24px;background:#14110f;color:#f1ebe3}main{max-width:30rem;margin:0 auto}</style></head><body><main><h1>${esc(title)}</h1><p>${esc(text)}</p></main></body></html>`;
const clearRequest = `${COOKIE_REQUEST}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
const clearNonce = `${COOKIE_NONCE}=; HttpOnly; Secure; SameSite=Strict; Path=/oauth/consent; Max-Age=0`;

async function readBody(request: Request): Promise<string | null> {
  const text = await request.text().catch(() => null);
  return text !== null && text.length <= MAX_BODY ? text : null;
}

type Call = typeof callBusiness;

/** Answers an OAuth route, or null when the path is not one of them. `call` and `now` exist so the tests can drive the whole flow without a network. */
export async function handleOAuthRoute(request: Request, env: Env, call: Call = callBusiness, now: number = Date.now()): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (!isOAuthPath(path)) return null;
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (!enabled(env)) return json(404, { error: "not_found" });

  if (WELL_KNOWN.some((p) => path === p || path === `${p}/mcp`)) {
    if (request.method !== "GET") return json(405, { error: "method_not_allowed" });
    return json(200, path.startsWith(WELL_KNOWN[0]) ? oauth.protectedResourceMetadata(url.origin) : oauth.authorizationServerMetadata(url.origin));
  }

  if (path === "/oauth/register") {
    if (request.method !== "POST") return json(405, { error: "method_not_allowed" });
    const text = await readBody(request);
    let body: unknown = null;
    try { body = text === null ? null : JSON.parse(text); } catch { body = null; }
    const made = await oauth.registerClient(env, body, now);
    return made.ok ? json(made.status, made.body) : json(made.status, { error: made.error, error_description: made.description });
  }

  if (path === "/oauth/authorize") {
    if (request.method !== "GET") return json(405, { error: "method_not_allowed" });
    const parsed = await oauth.parseAuthorize(env, url.searchParams, now);
    // A request that fails is NEVER redirected to the assistant: its return address is not yet trusted (RFC 6749 4.1.2.1). The person sees a plain page.
    if (!parsed.ok) return page(parsed.status, notice("This assistant cannot be connected", parsed.description));
    const sealed = await oauth.makeAuthRequest(env, parsed.request, now);
    return go("/auth/google/login?mcp=1", [`${COOKIE_REQUEST}=${sealed}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`]);
  }

  if (path === "/oauth/consent") {
    if (request.method !== "POST") return json(405, { error: "method_not_allowed" });
    // A form posted from another site is refused outright. A browser may send "Origin: null" for a same-site post (this page sets no-referrer, and Chrome then sends null), so null is not read as another site: the browser's own Sec-Fetch-Site must not say cross-site, and the nonce cookie below (SameSite=Strict) is what really binds this page to this browser.
    const origin = request.headers.get("Origin");
    if ((origin && origin !== "null" && origin !== url.origin) || request.headers.get("Sec-Fetch-Site") === "cross-site") return page(403, notice("Not allowed", "This page can only be used from here."));
    const text = await readBody(request);
    const form = new URLSearchParams(text ?? "");
    const ticket = await oauth.openTicket(env, form.get("ticket"), now);
    const nonce = getCookie(request, COOKIE_NONCE);
    if (!ticket || !nonce || typeof ticket.nonce !== "string" || !(await safeEqual(nonce, ticket.nonce)) || !oauth.redirectAllowed(ticket.redirect_uri)) {
      return page(400, notice("This page has expired", "Start again from the assistant."), [clearNonce]);
    }
    if (form.get("decision") === "allow") return go(await oauth.grant(env, ticket, now), [clearNonce]);
    return go(oauth.deny(ticket), [clearNonce]);
  }

  // /oauth/token
  if (request.method !== "POST") return json(405, { error: "method_not_allowed" });
  const text = await readBody(request);
  if (text === null) return json(400, { error: "invalid_request", error_description: "That request is too large." });
  const issue: oauth.Issue = async ({ email, businessId, label, jti }) => {
    if (!isBusinessId(businessId)) return { ok: false, reason: "other" };
    try {
      const reply = await call(env, businessId, "POST", "/debug/mcp-oauth-issue", { email, label, jti });
      const answer = (await reply.json().catch(() => null)) as { key?: unknown; reason?: unknown } | null;
      if (reply.ok && typeof answer?.key === "string") return { ok: true, key: answer.key };
      return { ok: false, reason: answer?.reason === "replayed" || answer?.reason === "limit" || answer?.reason === "not_owner" ? answer.reason : "other" };
    } catch {
      return { ok: false, reason: "other" };
    }
  };
  const result = await oauth.exchangeCode(env, new URLSearchParams(text), issue, now);
  return json(result.status, result.body);
}

/** Called by the Google callback once Google has verified who signed in. Returns null when this sign-in is not for an assistant (no sealed request cookie), so the normal app sign-in carries on untouched. Otherwise it ALWAYS answers: the consent page for an active owner, or "access_denied" sent back to the assistant for anyone else. A normal session is never issued here. */
export async function continueOAuthSignIn(request: Request, env: Env, who: { email: string; businessId?: string; role: string | null; active: boolean }, now: number = Date.now()): Promise<Response | null> {
  const raw = getCookie(request, COOKIE_REQUEST);
  if (!raw) return null;
  if (!enabled(env)) return page(404, notice("Not available", "Connecting assistants is switched off."), [clearRequest]);
  const asked = await oauth.openAuthRequest(env, raw, now);
  if (!asked) return page(400, notice("This request has expired", "Start again from the assistant."), [clearRequest]);
  if (!who.businessId || !who.active || who.role !== "owner") return go(oauth.deny(asked), [clearRequest]);
  const nonce = randomNonce();
  const ticket = await oauth.makeTicket(env, asked, { email: who.email, businessId: who.businessId }, nonce, now);
  return page(200, oauth.consentPage({ clientName: asked.client_name, businessId: who.businessId, email: who.email, ticket }), [clearRequest, `${COOKIE_NONCE}=${nonce}; HttpOnly; Secure; SameSite=Strict; Path=/oauth/consent; Max-Age=600`]);
}
