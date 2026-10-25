// The OAuth sign-in for assistants (worker/src/mcp-oauth-routes.ts; MCP_ARCHITECTURE.md, "OAuth for connectors") driven by the official MCP SDK's own OAuth client functions, against the real staging Worker.
// What it covers: discovery, self-registration, the start of authorization, and the refusals. What it CANNOT cover: the owner's Google sign-in and the consent button (a runner cannot log in as the owner): that is checked by Pierre when he connects claude.ai.
// Usage: BASE=https://host OUT=file.json node tools/mcp-oauth-client.mjs. Only true or false is written to OUT (never a client id, a code or a key); the script exits 0 even when a check fails, so the rehearsal's verdict decides.
import { discoverOAuthProtectedResourceMetadata, discoverAuthorizationServerMetadata, registerClient, startAuthorization } from "@modelcontextprotocol/sdk/client/auth.js";
import { writeFileSync } from "node:fs";

const { BASE: RAW, OUT } = process.env;
const BASE = RAW.replace(/\/$/, "");
const CALLBACK = "https://claude.ai/api/mcp/auth_callback";
const r = { challenge_points_at_discovery: false, protected_resource_found: false, authorization_server_found: false, only_s256_and_code_offered: false, registered: false, stranger_return_address_refused_at_registration: false, authorize_goes_to_google_sign_in: false, authorize_cookie_is_http_only_and_no_session_issued: false, bad_return_address_not_redirected: false, unknown_code_refused_at_token: false, token_refuses_wrong_grant_type: false };
const step = async (fn) => { try { await fn(); } catch { /* the check stays false */ } };

await step(async () => {
  const res = await fetch(BASE + "/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
  r.challenge_points_at_discovery = res.status === 401 && (res.headers.get("www-authenticate") || "").includes(`resource_metadata="${BASE}/.well-known/oauth-protected-resource"`);
});
let resource, server, client;
await step(async () => { resource = await discoverOAuthProtectedResourceMetadata(BASE + "/mcp"); r.protected_resource_found = resource.resource === BASE + "/mcp" && (resource.authorization_servers || []).includes(BASE); });
await step(async () => {
  server = await discoverAuthorizationServerMetadata(new URL(BASE));
  r.authorization_server_found = server.issuer === BASE && server.authorization_endpoint === BASE + "/oauth/authorize" && server.token_endpoint === BASE + "/oauth/token" && server.registration_endpoint === BASE + "/oauth/register";
  r.only_s256_and_code_offered = JSON.stringify(server.code_challenge_methods_supported) === '["S256"]' && JSON.stringify(server.response_types_supported) === '["code"]' && JSON.stringify(server.grant_types_supported) === '["authorization_code"]';
});
await step(async () => { client = await registerClient(BASE, { metadata: server, clientMetadata: { client_name: "Office rehearsal", redirect_uris: [CALLBACK], token_endpoint_auth_method: "none", grant_types: ["authorization_code"], response_types: ["code"] } }); r.registered = typeof client.client_id === "string" && client.client_id.length > 0; });
await step(async () => { try { await registerClient(BASE, { metadata: server, clientMetadata: { client_name: "Stranger", redirect_uris: ["https://evil.example/cb"], token_endpoint_auth_method: "none" } }); } catch { r.stranger_return_address_refused_at_registration = true; } });
let started;
await step(async () => { started = await startAuthorization(BASE, { metadata: server, clientInformation: client, redirectUrl: CALLBACK, scope: "mcp:read", state: "rehearsal-state" }); });
await step(async () => {
  const res = await fetch(started.authorizationUrl, { redirect: "manual" });
  const cookies = res.headers.getSetCookie();
  r.authorize_goes_to_google_sign_in = res.status === 302 && res.headers.get("location") === "/auth/google/login?mcp=1" && cookies.some((c) => c.startsWith("oauth_mcp="));
  r.authorize_cookie_is_http_only_and_no_session_issued = cookies.some((c) => c.startsWith("oauth_mcp=") && /HttpOnly/i.test(c) && /Secure/i.test(c)) && !cookies.some((c) => c.startsWith("office_session="));
});
await step(async () => {
  const url = new URL(started.authorizationUrl); url.searchParams.set("redirect_uri", "https://evil.example/cb");
  const res = await fetch(url, { redirect: "manual" });
  r.bad_return_address_not_redirected = res.status === 400 && !res.headers.get("location") && res.headers.getSetCookie().length === 0;
});
await step(async () => {
  const post = (fields) => fetch(BASE + "/oauth/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() });
  const junk = await post({ grant_type: "authorization_code", code: "junk.junk", client_id: client.client_id, redirect_uri: CALLBACK, code_verifier: started.codeVerifier });
  r.unknown_code_refused_at_token = junk.status === 400 && (await junk.json()).error === "invalid_grant";
  const wrong = await post({ grant_type: "password", username: "x", password: "y" });
  r.token_refuses_wrong_grant_type = wrong.status === 400 && (await wrong.json()).error === "unsupported_grant_type";
});

writeFileSync(OUT, JSON.stringify(r));
