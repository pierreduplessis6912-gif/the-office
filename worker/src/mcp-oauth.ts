// The OAuth core for assistants that cannot send a static key (claude.ai connectors): discovery documents, client registration, PKCE, the consent ticket and the single-use code. PURE: no routes, no storage, no clock of its own, so every rule here is testable on its own. SECURITY-SENSITIVE (MCP_ARCHITECTURE.md, "OAuth").
// The access token it ends in is an ordinary read-only key (mcp-keys.ts), so scope, routing, rate limits, revocation in the Assistants screen and the audit are exactly what a pasted key already has. Nothing here widens what an assistant can read.
// Everything that must survive between steps is a SIGNED value (HMAC with SESSION_SECRET, one purpose label per kind so a value of one kind can never stand in for another): the client id, the consent ticket, the code. The one thing that needs memory, "a code works once", is enforced by the caller inside the business's own database.
import type { Env } from "./types";

export const SCOPE = "mcp:read";
export const SCOPE_CREATE = "mcp:write";
/** What the owner chose on the consent page. Only the exact word "write" grants create; anything else, or nothing, is read only. */
export const scopeFromChoice = (choice: unknown): string => (choice === "write" ? SCOPE_CREATE : SCOPE);
/** Every path the OAuth routes answer, public by design (no session exists yet). Lives here, with no imports, so the gate (auth.ts) and the router (routing.ts) can read it without a cycle. */
export const OAUTH_PUBLIC_PATHS: readonly string[] = ["/oauth/register", "/oauth/authorize", "/oauth/consent", "/oauth/token", "/.well-known/oauth-protected-resource", "/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-authorization-server/mcp"];
export const TICKET_TTL_MS = 10 * 60 * 1000;
export const CODE_TTL_MS = 5 * 60 * 1000;
const MAX_REDIRECTS = 5;
const MAX_NAME = 60;

const enc = new TextEncoder();
const b64u = (bytes: Uint8Array): string => { let s = ""; for (const b of bytes) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
const unb64u = (text: string): Uint8Array => { const s = atob(text.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(text.length / 4) * 4, "=")); return Uint8Array.from(s, (c) => c.charCodeAt(0)); };
const hmacKey = (env: Env, purpose: string) => crypto.subtle.importKey("raw", enc.encode(`mcp-oauth|${purpose}|${env.SESSION_SECRET}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);

export type Purpose = "client" | "ticket" | "code" | "authreq";
/** A signed, self-describing value. `exp` (ms) is added when a ttl is given. */
export async function seal(env: Env, purpose: Purpose, payload: Record<string, unknown>, now: number, ttlMs?: number): Promise<string> {
  const body = b64u(enc.encode(JSON.stringify(ttlMs ? { ...payload, exp: now + ttlMs } : payload)));
  return `${body}.${b64u(new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(env, purpose), enc.encode(body))))}`;
}
/** The payload, or null: wrong shape, wrong purpose, tampered, or expired. Never throws. */
export async function open<T extends Record<string, unknown>>(env: Env, purpose: Purpose, token: unknown, now: number): Promise<T | null> {
  if (typeof token !== "string" || token.length > 4096) return null;
  const [body, sig, extra] = token.split(".");
  if (!body || !sig || extra !== undefined) return null;
  try {
    if (!(await crypto.subtle.verify("HMAC", await hmacKey(env, purpose), unb64u(sig), enc.encode(body)))) return null;
    const payload = JSON.parse(new TextDecoder().decode(unb64u(body))) as T;
    if (typeof payload !== "object" || payload === null) return null;
    if ("exp" in payload && !(typeof payload.exp === "number" && payload.exp > now)) return null;
    return payload;
  } catch { return null; }
}

// ---- discovery (RFC 9728 and RFC 8414) ----
export const protectedResourceMetadata = (origin: string) => ({ resource: `${origin}/mcp`, authorization_servers: [origin], bearer_methods_supported: ["header"], scopes_supported: [SCOPE] });
export const authorizationServerMetadata = (origin: string) => ({
  issuer: origin, authorization_endpoint: `${origin}/oauth/authorize`, token_endpoint: `${origin}/oauth/token`, registration_endpoint: `${origin}/oauth/register`,
  response_types_supported: ["code"], grant_types_supported: ["authorization_code"], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"], scopes_supported: [SCOPE],
});
/** The header an unauthenticated call to /mcp is answered with, so a client can find the sign-in. */
export const challengeHeader = (origin: string): string => `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`;

// ---- which redirects a client may ask for ----
// The assistants' own callbacks, exactly, and a loopback address for a tool running on the owner's own machine. Nothing else: a registered client can only ever send the owner's browser (and a code) to one of these.
const EXACT_REDIRECTS = new Set(["https://claude.ai/api/mcp/auth_callback", "https://claude.com/api/mcp/auth_callback"]);
const LOOPBACK = /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?\/[A-Za-z0-9\-._~\/%]*(\?[A-Za-z0-9\-._~%=&]*)?$/;
export const redirectAllowed = (uri: unknown): uri is string => typeof uri === "string" && uri.length <= 300 && (EXACT_REDIRECTS.has(uri) || LOOPBACK.test(uri));
const plainName = (value: unknown): string | null => (typeof value === "string" && value.trim().length >= 1 && value.trim().length <= MAX_NAME && !/[\u0000-\u001f\u007f<>]/.test(value) ? value.trim() : null);

export type Registered = { name: string; redirect_uris: string[] };
type Fail = { ok: false; status: number; error: string; description: string };
const fail = (status: number, error: string, description: string): Fail => ({ ok: false, status, error, description });

/** Dynamic client registration (RFC 7591). Stateless: the client id IS the signed registration, so registering stores nothing and cannot be used to fill a table. */
export async function registerClient(env: Env, body: unknown, now: number): Promise<{ ok: true; status: 201; body: Record<string, unknown> } | Fail> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return fail(400, "invalid_client_metadata", "The registration must be a JSON object.");
  const b = body as Record<string, unknown>;
  const name = plainName(b.client_name);
  if (name === null) return fail(400, "invalid_client_metadata", "client_name must be 1 to 60 plain characters.");
  const uris = b.redirect_uris;
  if (!Array.isArray(uris) || uris.length < 1 || uris.length > MAX_REDIRECTS) return fail(400, "invalid_redirect_uri", "Between 1 and 5 redirect_uris are needed.");
  if (!uris.every(redirectAllowed)) return fail(400, "invalid_redirect_uri", "That redirect address is not one this server will send a person to.");
  const redirect_uris = [...new Set(uris as string[])];
  const client_id = await seal(env, "client", { name, redirect_uris }, now);
  return { ok: true, status: 201, body: { client_id, client_name: name, redirect_uris, token_endpoint_auth_method: "none", grant_types: ["authorization_code"], response_types: ["code"], scope: SCOPE } };
}

// ---- PKCE (RFC 7636): only S256 ----
const VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/;
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
export async function pkceMatches(verifier: unknown, challenge: string): Promise<boolean> {
  if (typeof verifier !== "string" || !VERIFIER.test(verifier) || !CHALLENGE.test(challenge)) return false;
  const made = b64u(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(verifier))));
  let diff = made.length ^ challenge.length;
  for (let i = 0; i < made.length && i < challenge.length; i++) diff |= made.charCodeAt(i) ^ challenge.charCodeAt(i);
  return diff === 0;
}

export interface AuthorizeRequest { client_id: string; client_name: string; redirect_uri: string; challenge: string; state: string | null }
/** The authorize request, checked. A request that fails is NEVER redirected anywhere: the person gets a plain page (RFC 6749 section 4.1.2.1), because the address it would go to is not yet trusted. */
export async function parseAuthorize(env: Env, params: URLSearchParams, now: number): Promise<{ ok: true; request: AuthorizeRequest } | Fail> {
  const client_id = params.get("client_id") ?? "";
  const client = await open<Registered & Record<string, unknown>>(env, "client", client_id, now);
  if (!client || typeof client.name !== "string" || !Array.isArray(client.redirect_uris)) return fail(400, "invalid_client", "This assistant is not registered here.");
  const redirect_uri = params.get("redirect_uri") ?? "";
  if (!client.redirect_uris.includes(redirect_uri) || !redirectAllowed(redirect_uri)) return fail(400, "invalid_request", "That return address does not match the one this assistant registered.");
  if (params.get("response_type") !== "code") return fail(400, "unsupported_response_type", "Only response_type=code is supported.");
  const challenge = params.get("code_challenge") ?? "";
  if (params.get("code_challenge_method") !== "S256" || !CHALLENGE.test(challenge)) return fail(400, "invalid_request", "A PKCE S256 code_challenge is required.");
  const scope = params.get("scope");
  if (scope && scope.split(/\s+/).some((s) => s !== SCOPE)) return fail(400, "invalid_scope", `Only ${SCOPE} is available.`);
  const state = params.get("state");
  if (state !== null && (state.length > 512 || /[\u0000-\u001f\u007f]/.test(state))) return fail(400, "invalid_request", "That state value is not acceptable.");
  return { ok: true, request: { client_id, client_name: client.name, redirect_uri, challenge, state } };
}

/** The authorize request, kept in a short-lived cookie while the owner signs in with Google. Only the client id and what the client asked for are sealed; the name and the allowed return addresses are read again from the client id when it is opened, so a changed rule or a tampered cookie can never send the browser anywhere new. */
export const makeAuthRequest = (env: Env, request: AuthorizeRequest, now: number): Promise<string> => seal(env, "authreq", { client_id: request.client_id, redirect_uri: request.redirect_uri, challenge: request.challenge, state: request.state }, now, TICKET_TTL_MS);
export async function openAuthRequest(env: Env, token: unknown, now: number): Promise<AuthorizeRequest | null> {
  const p = await open<{ client_id: string; redirect_uri: string; challenge: string; state: string | null } & Record<string, unknown>>(env, "authreq", token, now);
  if (!p || typeof p.client_id !== "string" || typeof p.redirect_uri !== "string" || typeof p.challenge !== "string" || !CHALLENGE.test(p.challenge) || !(p.state === null || typeof p.state === "string")) return null;
  const client = await open<Registered & Record<string, unknown>>(env, "client", p.client_id, now);
  if (!client || typeof client.name !== "string" || !Array.isArray(client.redirect_uris) || !client.redirect_uris.includes(p.redirect_uri) || !redirectAllowed(p.redirect_uri)) return null;
  return { client_id: p.client_id, client_name: client.name, redirect_uri: p.redirect_uri, challenge: p.challenge, state: p.state };
}

export interface Who { email: string; businessId: string }
export interface TicketPayload extends AuthorizeRequest, Who { nonce: string }
/** What the consent page carries to its own button: who signed in (Google, verified), for which business, asking what. */
export const makeTicket = (env: Env, request: AuthorizeRequest, who: Who, nonce: string, now: number): Promise<string> => seal(env, "ticket", { ...request, ...who, nonce }, now, TICKET_TTL_MS);
export const openTicket = (env: Env, ticket: unknown, now: number) => open<TicketPayload & Record<string, unknown>>(env, "ticket", ticket, now);

/** After the owner says Allow (and only then): where to send the browser, with a code that lasts five minutes and works once. */
export async function grant(env: Env, ticket: TicketPayload, now: number, scope: string = SCOPE): Promise<string> {
  const jti = b64u(crypto.getRandomValues(new Uint8Array(16)));
  const code = await seal(env, "code", { jti, client_id: ticket.client_id, client_name: ticket.client_name, redirect_uri: ticket.redirect_uri, challenge: ticket.challenge, email: ticket.email, businessId: ticket.businessId, scope: scope === SCOPE_CREATE ? SCOPE_CREATE : SCOPE }, now, CODE_TTL_MS);
  return redirectWith(ticket.redirect_uri, { code, state: ticket.state });
}
/** Where a refusal goes: back to the assistant, saying no. */
export const deny = (ticket: Pick<AuthorizeRequest, "redirect_uri" | "state">): string => redirectWith(ticket.redirect_uri, { error: "access_denied", state: ticket.state });
function redirectWith(base: string, values: Record<string, string | null>): string {
  const url = new URL(base);
  for (const [k, v] of Object.entries(values)) if (v !== null) url.searchParams.set(k, v);
  return url.toString();
}

/** Issues the key. Supplied by the caller (it runs in the business's own database, where `jti` is recorded so a code can never be used twice). */
export type Issue = (who: Who & { label: string; jti: string; scope: string }) => Promise<{ ok: true; key: string } | { ok: false; reason: "replayed" | "limit" | "not_owner" | "other" }>;
export type TokenResult = { status: 200; body: { access_token: string; token_type: "Bearer"; scope: string } } | { status: 400 | 503; body: { error: string; error_description: string } };
const bad = (status: 400 | 503, error: string, error_description: string): TokenResult => ({ status, body: { error, error_description } });

/** The token endpoint: a valid, unexpired, unused code, from the same client, to the same address, with the verifier that matches. */
export async function exchangeCode(env: Env, form: URLSearchParams, issue: Issue, now: number): Promise<TokenResult> {
  if (form.get("grant_type") !== "authorization_code") return bad(400, "unsupported_grant_type", "Only authorization_code is supported.");
  const c = await open<{ jti: string; client_id: string; client_name: string; redirect_uri: string; challenge: string; email: string; businessId: string; scope?: string } & Record<string, unknown>>(env, "code", form.get("code"), now);
  if (!c || typeof c.jti !== "string") return bad(400, "invalid_grant", "That code is not valid or has expired.");
  if (form.get("client_id") !== c.client_id || form.get("redirect_uri") !== c.redirect_uri) return bad(400, "invalid_grant", "That code was not issued to this assistant.");
  if (!(await pkceMatches(form.get("code_verifier"), c.challenge))) return bad(400, "invalid_grant", "The code verifier does not match.");
  const label = `Claude connector: ${c.client_name}`.slice(0, MAX_NAME);
  const granted = c.scope === SCOPE_CREATE ? SCOPE_CREATE : SCOPE;   // a code with no scope, or any other, is read only
  const made = await issue({ email: c.email, businessId: c.businessId, label, jti: c.jti, scope: granted });
  if (made.ok) return { status: 200, body: { access_token: made.key, token_type: "Bearer", scope: granted } };
  if (made.reason === "replayed") return bad(400, "invalid_grant", "That code has already been used.");
  if (made.reason === "limit") return bad(400, "invalid_grant", "There are already too many active keys: revoke one in the app first.");
  if (made.reason === "not_owner") return bad(400, "invalid_grant", "Only the owner can connect an assistant.");
  return bad(503, "server_error", "The key could not be issued. Nothing was granted.");
}

const esc = (text: string): string => text.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch] as string));
/** The one screen a person sees. It names the assistant, the business and the account, says what is and is not possible, and has exactly two buttons. */
export function consentPage(input: { clientName: string; businessId: string; email: string; ticket: string }): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><title>Connect an assistant</title><style>body{font:16px system-ui,sans-serif;margin:0;padding:24px;background:#14110f;color:#f1ebe3}main{max-width:30rem;margin:0 auto}h1{font-size:1.3rem}p,li{line-height:1.5}button{font:inherit;padding:.8rem 1.2rem;border-radius:.6rem;border:0;margin:.4rem .4rem 0 0}.go{background:#d9a05b;color:#14110f}.no{background:#2b2622;color:#f1ebe3}</style></head><body><main><h1>Let ${esc(input.clientName)} connect to your Office?</h1><p>You are signed in as <b>${esc(input.email)}</b> for <b>${esc(input.businessId)}</b>.</p><p>Either way it can <b>read</b> your reports and records: profit and loss, who owes you, customers, jobs, invoices, quotes, stock and recent history. It can never delete anything, move money or change who has access.</p><form method="post" action="/oauth/consent"><input type="hidden" name="ticket" value="${esc(input.ticket)}"><p><label><input type="radio" name="access" value="read" checked> <b>Read only</b></label><br><label><input type="radio" name="access" value="write"> <b>Read and create</b></label>: it can also record invoices, quotes, jobs, expenses, tasks and payments received as if you had typed them, schedule jobs, and change what it created. Each is tagged with this connection, it is limited to 20 changes an hour and 100 a day, and an invoice or quote amount over R50,000 is flagged. You can undo any of it in the app.</p><p>You can stop it at any time from the Assistants screen in the app.</p><button class="go" name="decision" value="allow">Allow</button><button class="no" name="decision" value="deny">Cancel</button></form></main></body></html>`;
}
