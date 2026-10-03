// Real, extracted, per direct instruction — the auth/security layer,
// pulled out of index.ts as the first real step of splitting up the
// large files. Everything here is about one thing: is this request
// allowed, and is this link genuinely the one it claims to be —
// identity (sessions, cookies, bearer tokens), roles and capabilities,
// document-link signing, idempotency, safe migrations, and CORS.
//
// Verified to have moved cleanly, not just relocated: nothing in this
// file depends on anything else in index.ts beyond the Env type and
// standard Web APIs (checked directly, not assumed), and the existing
// test suite (the 165-case role matrix, the PDF-signing round-trip,
// the CORS allowlist test, and the live-bug regression test) all
// re-extract from this file now and still pass.
import { Env, Extraction } from "./types";

// Real feature 2026-07-14 — session signing/verification, step 1 of
// the phased auth scope (Constitution Principles 25-27). A session
// needs to be verifiable on every request without re-running the
// OAuth dance each time, and tamper-evident without needing a server-
// side session store — a signed token carries its own proof.
export function base64UrlEncode(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
  let str = "";
  for (const byte of arr) str += String.fromCharCode(byte);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function base64UrlDecode(str: string): Uint8Array {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((str.length + 3) % 4);
  const bin = atob(padded);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}
async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}
export async function signSession(env: Env, email: string): Promise<string> {
  const payload = JSON.stringify({ email, exp: Date.now() + 30 * 24 * 60 * 60 * 1000 }); // 30 real days
  const payloadB64 = base64UrlEncode(new TextEncoder().encode(payload));
  const key = await hmacKey(env.SESSION_SECRET);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payloadB64));
  return `${payloadB64}.${base64UrlEncode(signature)}`;
}
// Real, new, per direct instruction — stage 2. Every PDF link is
// exposed to a real audience that a session cookie cannot reach: a
// customer who has never signed in, and — a real finding, not
// assumed — the owner's own in-app taps too, since launchUrl opens an
// external browser tab that carries no session at all. A signature
// tied to the exact path, not a bare secret query param, is what stops
// copying one document's link onto another id. Reuses SESSION_SECRET
// and hmacKey rather than a new secret needing its own Cloudflare setup.
export async function signDocumentPath(env: Env, path: string, ttlMs: number): Promise<string> {
  const payload = JSON.stringify({ path, exp: Date.now() + ttlMs });
  const payloadB64 = base64UrlEncode(new TextEncoder().encode(payload));
  const key = await hmacKey(env.SESSION_SECRET);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payloadB64));
  return `${payloadB64}.${base64UrlEncode(signature)}`;
}

async function verifyDocumentToken(env: Env, path: string, token: string | null): Promise<boolean> {
  if (!token) return false;
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const [payloadB64, sigB64] = parts;
  try {
    const key = await hmacKey(env.SESSION_SECRET);
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      base64UrlDecode(sigB64),
      new TextEncoder().encode(payloadB64)
    );
    if (!valid) return false;
    const decoded = JSON.parse(new TextDecoder().decode(base64UrlDecode(payloadB64))) as { path: string; exp: number };
    if (Date.now() > decoded.exp) return false;
    // Tied to the exact request path — a valid signature for invoice 3
    // must never also open invoice 4.
    return decoded.path === path;
  } catch {
    return false; // malformed token — never trust something that fails to parse cleanly
  }
}

export async function verifySession(env: Env, token: string | null): Promise<{ email: string } | null> {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payloadB64, sigB64] = parts;
  try {
    const key = await hmacKey(env.SESSION_SECRET);
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      base64UrlDecode(sigB64),
      new TextEncoder().encode(payloadB64)
    );
    if (!valid) return null;
    const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(payloadB64))) as {
      email: string;
      exp: number;
    };
    if (Date.now() > payload.exp) return null; // real expiry, not just a signature check
    return { email: payload.email };
  } catch {
    return null; // malformed token — never trust something that fails to parse cleanly
  }
}
// Real, deliberately incomplete role-capability map — only Owner and
// Installer are defined, because those are the only two roles anyone
// has actually specified a concrete capability list for. Extensible
// when a real third role is needed, not enumerated in advance for
// roles nobody has asked for yet (Principle 22). Module scope, shared
// by the membership debug routes and real capability resolution below
// — one single source of truth, never duplicated.
export const ROLE_CAPABILITIES: Record<string, string[]> = {
  owner: [
    "can_know_profit",
    "can_know_debtors",
    "can_know_payroll",
    "can_know_banking",
    "can_manage_invoices",
    "can_know_jobs",
    "can_know_measurements",
    "can_know_materials",
    "can_invite_members",
    "can_delete_data",
    "can_manage_settings",
  ],
  installer: ["can_know_jobs", "can_know_measurements", "can_capture_voice_notes", "can_know_materials"],
  // Real feature 2026-07-15 — added the moment a real person was
  // actually named for this role, not enumerated speculatively.
  // Proposed default, not yet reviewed against a concrete example the
  // way Owner and Installer were: financial visibility and invoice
  // management, explicitly excluding operational capabilities (jobs,
  // measurements) that aren't an accountant's concern, and
  // administrative ones (invite, delete, settings) that stay
  // Owner-only regardless of role.
  accountant: ["can_know_profit", "can_know_debtors", "can_know_payroll", "can_know_banking", "can_manage_invoices", "can_know_materials"],
};

// Real, new, per direct instruction — the first real item on
// SECURITY_AND_OPERATIONAL_READINESS.md's urgent tier, confirmed against
// the live code: 118 of 161 routes are /debug or /admin with no auth
// check at all, and only 2 of the other 43 had one. The fix is one
// central, default-deny gate rather than 37 separate edits — which is
// also the fix for the *class* of mistake, not just the instances:
// every endpoint added since has been open by default, including six
// added in a single session. Anything not on PUBLIC_ROUTES now needs a
// valid session with an active membership.
//
// Deliberately staged, and deliberately off until switched on:
//   Stage 1 (this) — every app-facing JSON route.
//   Stage 2 — /.../pdf routes, exempted below because they open in an
//     external viewer via launchUrl and cannot send an Authorization
//     header; they need short-lived signed links, a real second step.
//   Stage 3 — /debug/* and /admin/*, exempted below because gating
//     them today would break the curl workflow used to run this whole
//     system; they need a separate admin secret first.
// Flipping this constant is a one-line change through the same deploy
// pipeline, and so is reverting it — neither depends on the app being
// able to reach the backend, so a lockout can never trap the fix.
const ENFORCE_APP_AUTH = true;

const PUBLIC_ROUTES = new Set([
  "/",
  "/health",
  "/auth/google/login",
  "/auth/google/callback",
  "/auth/logout",
  "/auth/me",
]);

// Real, new, per direct instruction — stage 3. The app itself depends on
// exactly these 7 /debug routes (found by grepping main.dart, not
// assumed), so they cannot get the blanket /debug exemption below —
// they need real session + role rules like any other route, added to
// ROUTE_RULES. Everything else under /debug or /admin instead needs the
// existing X-Admin-Key check further down, the same real mechanism
// already protecting /admin since 13 July, now reused rather than
// duplicated with a second secret.
const APP_DEBUG_ROUTES = new Set([
  "/debug/financial-snapshot",
  "/debug/schedule",
  "/debug/captures",
  "/debug/tasks-list",
  "/debug/suppliers-list",
  "/debug/finance-list",
  "/debug/characters-list",
]);

// Real, new, per direct instruction — the second layer. The gate above
// proves *who* someone is; this decides *what they may do*, and it is
// what makes a restricted role real: the message path already enforced
// roles per write, but every REST route checked nothing, and the app
// itself only displays the role — it hides no rooms. Same discipline as
// the gate: deployed off, switched on deliberately.
//
// Two rules do most of the work. The owner always passes, checked by role
// rather than by capability list (the owner's list deliberately lacks
// can_capture_voice_notes, so a capability-only check could lock the
// owner out). And anything a restricted role is not explicitly allowed is
// denied by default, so an endpoint added later is owner-only until
// someone decides otherwise — the same default-deny that fixed the
// original problem, one layer down.
export const ENFORCE_CAPABILITIES = true;

// Who may confirm, reject or edit a held action, by its type. Creating a
// held action is harmless — that is why uploads are open to every member
// — executing one is what needs a role. Derived from the 17 types the
// confirm handler dispatches on. Deliberately absent, so owner-only:
// character_fact (staff and supplier details), imported_invoice, and
// schema_candidate — and any type added in future, until classified.
export const ACTION_TYPE_CAPABILITY: Record<string, string[]> = {
  invoice: ["can_manage_invoices"],
  quotation: ["can_manage_invoices"],
  convert_quote: ["can_manage_invoices"],
  payment: ["can_manage_invoices"],
  expense: ["can_manage_invoices"],
  supplier_invoice: ["can_manage_invoices"],
  supplier_payment: ["can_manage_invoices"],
  variance_disposition: ["can_manage_invoices"],
  // Installers receive deliveries on site; accountants reconcile them.
  goods_received: ["can_manage_invoices", "can_know_materials"],
  // "Add this delivery to stock?" (decided 2026-10-03, Pierre: ask on delivery). Anyone who may know
  // materials may answer it, since stock is gated by can_know_materials everywhere else too.
  stock_add: ["can_know_materials"],
  job_scope_amendment: ["can_know_jobs"],
  project_ambiguity: ["can_know_jobs"],
  // Identity questions can come up in either role's dictation.
  ambiguous_person: ["can_know_jobs", "can_manage_invoices"],
  identity_collision: ["can_know_jobs", "can_manage_invoices"],
  customer_fact: ["can_know_jobs", "can_manage_invoices"],
};

// Who may DICTATE (create) each intent — the creation-time counterpart to
// ACTION_TYPE_CAPABILITY above, which says who may CONFIRM a held action.
// Until now creation was gated by a hand-kept list in index.ts that was
// open by default: an intent nobody remembered to list was silently
// allowed, which is exactly how five real financial intents went
// ungated until they were audited by hand (see
// PROCESS_ONE_EXTRACTION_REWRITE.md, validation results, Step 3).
//
// This table is exhaustive by construction. It is typed
// Record<intent, ...>, so adding a value to the intent union in
// types.ts without a row here is a compile error, and
// tools/role-matrix.test.js (which loads this very file) asserts the
// same at test time. "Open" is therefore always a written-down choice,
// never an omission.
//
//   produces — the held action types this intent can create ([] means it
//              records directly, or only reads). Nested outputs count.
//   create   — any-of capabilities, or "open" (deliberately ungated).
//   refusal  — what a refused role is told.
//   reason   — REQUIRED whenever create and confirm disagree for a role
//              (a role that can create but never confirm, or confirm but
//              not create); the test enforces this, so a disagreement is
//              always a recorded decision rather than an accident.
//
// The upload handlers (/files/document, /files/photo) use the same rows,
// keyed by what the upload would do: supplier_invoice (a held money action),
// goods_received (a direct stock write) and supplier_statement (a money
// read). They decide by the supplier an upload resolves to, not by a spoken
// intent, so they call intentCreationRefusal with those three keys.
//
// A value that is not an intent at all (null, or something the model
// invented) is not gated here: nothing handles it, so there is nothing
// to protect; that is the same behaviour as before this table existed.
export interface IntentRule {
  produces: string[];
  create: string[] | "open";
  refusal?: string;
  reason?: string;
}

const MONEY_REFUSAL =
  "Recording payments, invoices, quotations, or supplier transactions isn't available for your role — let someone with that permission know.";
const LEADS_REFUSAL = "Managing leads isn't available for your role — let someone with that permission know.";
const STATEMENT_REFUSAL = "Checking supplier statements isn't available for your role — let someone with that permission know.";
const STOCK_REFUSAL = "Recording stock isn't available for your role — let someone with that permission know.";

export const INTENT_RULES: Record<Extraction["intent"], IntentRule> = {
  // Money.
  payment: { produces: ["payment"], create: ["can_manage_invoices"], refusal: MONEY_REFUSAL },
  expense: { produces: ["expense"], create: ["can_manage_invoices"], refusal: MONEY_REFUSAL },
  invoice: {
    produces: ["invoice", "job_scope_amendment"],
    create: ["can_manage_invoices"],
    refusal: MONEY_REFUSAL,
    reason:
      "The invoice branch also records a job scope and can raise a job_scope_amendment, which installers may confirm; only the invoice itself needs can_manage_invoices.",
  },
  quotation: { produces: ["quotation"], create: ["can_manage_invoices"], refusal: MONEY_REFUSAL },
  price_scope: { produces: ["invoice", "quotation"], create: ["can_manage_invoices"], refusal: MONEY_REFUSAL },
  convert_quote: { produces: ["convert_quote"], create: ["can_manage_invoices"], refusal: MONEY_REFUSAL },
  supplier_invoice: { produces: ["supplier_invoice"], create: ["can_manage_invoices"], refusal: MONEY_REFUSAL },
  supplier_payment: { produces: ["supplier_payment"], create: ["can_manage_invoices"], refusal: MONEY_REFUSAL },
  variance_disposition: { produces: ["variance_disposition"], create: ["can_manage_invoices"], refusal: MONEY_REFUSAL },
  // A direct write with no held action: this creation gate is its ONLY gate.
  purchase_order: { produces: [], create: ["can_manage_invoices"], refusal: MONEY_REFUSAL },
  // Decision recorded 2026-10-02 (Pierre): installers may dictate goods
  // received. They already confirm deliveries on site, and the upload path
  // already lets any member record a delivery note, so refusing dictation
  // alone protected nothing. Creation now uses the same any-of set as
  // confirmation (can_manage_invoices OR can_know_materials).
  goods_received: {
    produces: ["goods_received"],
    create: ["can_manage_invoices", "can_know_materials"],
    refusal: MONEY_REFUSAL,
  },
  // Decision recorded 2026-10-02 (Pierre): gate creation for money and
  // stock only. Stock movements are direct writes, so they are gated here
  // with can_know_materials, the capability the REST layer already uses for
  // /stock. Owner, accountant and installer all hold it, so today this
  // changes nothing for them; it makes the rule explicit and keeps a future
  // role with no materials access from writing stock by dictation.
  register_stock_item: { produces: [], create: ["can_know_materials"], refusal: STOCK_REFUSAL },
  stock_usage: { produces: [], create: ["can_know_materials"], refusal: STOCK_REFUSAL },
  stocktake: { produces: [], create: ["can_know_materials"], refusal: STOCK_REFUSAL },
  // Decision recorded 2026-10-02 (Pierre): money is gated. A supplier
  // statement upload compares the supplier's claimed balance with the real
  // amount owed and RETURNS both, so reading it is a money read; installers
  // cannot see supplier balances anywhere else (/embers/suppliers needs
  // can_manage_invoices), so they must not get them through an upload.
  supplier_statement: { produces: [], create: ["can_manage_invoices"], refusal: STATEMENT_REFUSAL },
  // Owner-only, matching the REST layer (leads need can_manage_settings).
  lose_lead: { produces: [], create: ["can_manage_settings"], refusal: LEADS_REFUSAL },

  // Deliberately open today. Each is a direct write or a read, not a held action.
  work_observation: {
    produces: ["quotation", "job_scope_amendment"],
    create: "open",
    reason:
      "A measurement records regardless of role; the quotation it can nest is gated inline on can_manage_invoices, and an amendment hold is confirmed by can_know_jobs.",
  },
  raise_snag: { produces: [], create: "open" },
  resolve_snag: { produces: [], create: "open" },
  raise_lead: { produces: [], create: "open" },
  lookup: { produces: [], create: "open", reason: "Read-only; read access is gated per fact set inside the lookup itself." },
  reminder: { produces: [], create: "open" },
  task_complete: { produces: [], create: "open" },
  note: { produces: [], create: "open" },
  forget_last: { produces: [], create: "open" },
  other: { produces: [], create: "open" },
};

// The refusal message for a role that may not create this intent, or null
// if it may. Anything that is not a known intent is allowed through (see above).
export function intentCreationRefusal(intent: string | null | undefined, capabilities: string[]): string | null {
  const key = intent ?? "";
  if (!Object.prototype.hasOwnProperty.call(INTENT_RULES, key)) return null;
  const rule = INTENT_RULES[key as Extraction["intent"]];
  if (rule.create === "open") return null;
  if (rule.create.some((c) => capabilities.includes(c))) return null;
  return rule.refusal ?? MONEY_REFUSAL;
}

// Any active member, whatever their role. Uploads are safe here because
// they only ever create a held action; the confirmation is what is
// checked, by type, below.
const MEMBER_OPEN_ROUTES: Array<{ method: string; path: RegExp }> = [
  { method: "POST", path: /^\/messages\/text$/ },
  // Voice is the same input as text, and the message path already checks
  // capabilities per write, so it is open to every member exactly as text is.
  { method: "POST", path: /^\/files\/(audio|photo|document)$/ },
  { method: "GET", path: /^\/actions\/pending$/ },
  { method: "GET", path: /^\/embers\/pending$/ },
  { method: "GET", path: /^\/business-profile\/logo$/ },
];

export const ROUTE_RULES: Array<{ method: string; path: RegExp; anyOf: string[] }> = [
  // Money — accountant and owner.
  { method: "GET", path: /^\/customers\/\d+\/profitability$/, anyOf: ["can_know_profit"] },
  { method: "PATCH", path: /^\/(invoices|quotations|customers)\/\d+$/, anyOf: ["can_manage_invoices"] },
  { method: "GET", path: /^\/suppliers\/\d+\/discrepancies$/, anyOf: ["can_manage_invoices"] },
  { method: "GET", path: /^\/delivery-exceptions$/, anyOf: ["can_manage_invoices"] },
  { method: "POST", path: /^\/suppliers\/discrepancies\/\d+\/resolve$/, anyOf: ["can_manage_invoices"] },
  { method: "GET", path: /^\/embers\/finance$/, anyOf: ["can_know_debtors", "can_know_profit"] },
  { method: "GET", path: /^\/embers\/expenses$/, anyOf: ["can_know_profit", "can_manage_invoices"] },
  { method: "GET", path: /^\/embers\/suppliers$/, anyOf: ["can_manage_invoices"] },
  // Jobs — installer and owner. The handlers further scope these to the
  // installer's own jobs.
  { method: "GET", path: /^\/projects$/, anyOf: ["can_know_jobs"] },
  { method: "GET", path: /^\/snags$/, anyOf: ["can_know_jobs"] },
  { method: "POST", path: /^\/snags\/\d+\/resolve$/, anyOf: ["can_know_jobs"] },
  { method: "POST", path: /^\/tasks\/\d+\/done$/, anyOf: ["can_know_jobs"] },
  { method: "GET", path: /^\/embers\/(tasks|scheduler)$/, anyOf: ["can_know_jobs"] },
  // Materials.
  { method: "GET", path: /^\/stock$/, anyOf: ["can_know_materials"] },
  // The customer list: both roles genuinely need it, but an installer's
  // is scoped in the handler to customers on their own jobs.
  { method: "GET", path: /^\/customers$/, anyOf: ["can_know_jobs", "can_manage_invoices"] },
  // Stage 3 — the app's own 7 debug routes. /debug/captures is
  // deliberately absent: it is the raw, unfiltered dictation history
  // for every member, so it stays Owner-only by default-deny, per
  // direct instruction, rather than guessed at.
  { method: "GET", path: /^\/debug\/financial-snapshot$/, anyOf: ["can_know_profit", "can_know_debtors"] },
  { method: "GET", path: /^\/debug\/suppliers-list$/, anyOf: ["can_manage_invoices"] },
  { method: "GET", path: /^\/debug\/finance-list$/, anyOf: ["can_manage_invoices"] },
  { method: "GET", path: /^\/debug\/schedule$/, anyOf: ["can_know_jobs"] },
  { method: "GET", path: /^\/debug\/tasks-list$/, anyOf: ["can_know_jobs"] },
  { method: "GET", path: /^\/debug\/characters-list$/, anyOf: ["can_know_jobs", "can_manage_invoices"] },
  // Owner only: nothing a restricted role holds includes can_manage_settings.
  { method: "GET", path: /^\/leads$/, anyOf: ["can_manage_settings"] },
  { method: "POST", path: /^\/leads\/\d+\/mark-lost$/, anyOf: ["can_manage_settings"] },
  { method: "POST", path: /^\/business-profile\/logo$/, anyOf: ["can_manage_settings"] },
  { method: "POST", path: /^\/files\/(customers|invoices)-csv-import$/, anyOf: ["can_manage_settings"] },
];

const ACTION_ROUTE = /^\/actions\/(\d+)\/(confirm|reject|edit-field)$/;

// Real, new, per direct instruction: the allowlist for /documents/sign.
// Every real PDF route in this project, matched to whichever
// capability already governs the equivalent JSON data elsewhere —
// money documents need can_manage_invoices or can_know_profit/debtors,
// same as the REST routes for the same underlying data.
export const SIGNABLE_DOCUMENT_PATHS: Array<{ pattern: RegExp; anyOf: string[] }> = [
  { pattern: /^\/invoices\/\d+\/pdf$/, anyOf: ["can_manage_invoices"] },
  { pattern: /^\/quotations\/\d+\/pdf$/, anyOf: ["can_manage_invoices"] },
  { pattern: /^\/customers\/\d+\/statement\/pdf$/, anyOf: ["can_manage_invoices", "can_know_profit"] },
  { pattern: /^\/reports\/aged-debtors\/pdf$/, anyOf: ["can_know_debtors", "can_know_profit"] },
  { pattern: /^\/reports\/aged-creditors\/pdf$/, anyOf: ["can_manage_invoices"] },
  { pattern: /^\/reports\/profit-and-loss\/pdf$/, anyOf: ["can_know_profit"] },
];

export function denyForRole(): Response {
  return Response.json({ error: "not available for your role" }, { status: 403 });
}

async function authorizeRestrictedMember(request: Request, env: Env, url: URL, role: string): Promise<Response | null> {
  if (!ENFORCE_CAPABILITIES || role === "owner") return null;
  const caps = ROLE_CAPABILITIES[role] ?? [];
  const method = request.method;
  const path = url.pathname;

  if (MEMBER_OPEN_ROUTES.some((r) => r.method === method && r.path.test(path))) return null;

  const rule = ROUTE_RULES.find((r) => r.method === method && r.path.test(path));
  if (rule) return rule.anyOf.some((c) => caps.includes(c)) ? null : denyForRole();

  const actionMatch = path.match(ACTION_ROUTE);
  if (actionMatch && method === "POST") {
    const row = await env.OFFICE_DB.prepare("SELECT type FROM pending_actions WHERE id = ?")
      .bind(Number(actionMatch[1]))
      .first<{ type: string }>();
    const needed = row ? ACTION_TYPE_CAPABILITY[row.type] : undefined;
    return needed && needed.some((c) => caps.includes(c)) ? null : denyForRole();
  }

  return denyForRole();
}

// The signed-in member, or null. Used by handlers that need to know more
// than "is this allowed" — which installer this login is.
export async function getMemberContext(
  request: Request,
  env: Env
): Promise<{ email: string; role: string; caps: string[]; characterId: number | null } | null> {
  const session = await verifySession(env, getSessionToken(request));
  if (!session) return null;
  const membership = await env.OFFICE_DB.prepare("SELECT role, status FROM memberships WHERE google_email = ?")
    .bind(session.email)
    .first<{ role: string; status: string }>();
  if (!membership || membership.status !== "active") return null;
  let characterId: number | null = null;
  try {
    const link = await env.OFFICE_DB.prepare("SELECT character_id FROM memberships WHERE google_email = ?")
      .bind(session.email)
      .first<{ character_id: number | null }>();
    characterId = link?.character_id ?? null;
  } catch {
    // Safe to swallow, and deliberately fails closed: if the column has
    // not been migrated yet, an installer resolves to no linked
    // installer, which the scoped queries turn into "no jobs" — never
    // into "all jobs".
  }
  return { email: session.email, role: membership.role, caps: ROLE_CAPABILITIES[membership.role] ?? [], characterId };
}

// "Installers see their own jobs only." Returns a no-op scope whenever
// enforcement is off, so with the switch off there are no extra queries
// and no change in behavior at all.
export async function getJobScope(request: Request, env: Env): Promise<{ scoped: boolean; characterId: number | null }> {
  if (!ENFORCE_CAPABILITIES) return { scoped: false, characterId: null };
  const ctx = await getMemberContext(request, env);
  if (!ctx || ctx.role !== "installer") return { scoped: false, characterId: null };
  return { scoped: true, characterId: ctx.characterId };
}

// Real, extracted, per direct instruction: the exact same logic that
// already protected /messages/text since 2026-07-15, made reusable.
// Found by a real audit, not assumed already sufficient: no client
// anywhere ever actually sent this key, for this route or any other —
// the protection had been sitting dormant, unused, in production. This
// is the shared half of making it real everywhere it is needed.
// Real, new, per direct instruction: a real audit found roughly 20
// migration catch blocks across this file swallowing ANY error under
// a comment that only ever meant "already exists" — some of them
// wrapping CREATE TABLE IF NOT EXISTS, which SQLite's own IF NOT
// EXISTS clause already makes idempotent on its own, so a catch there
// was never really about "already exists" at all; it was silently
// masking whatever genuinely unexpected error actually occurred
// instead. Checked directly against the real, live error text before
// writing this — a genuine duplicate-column ALTER on this project's
// own D1 database returns exactly "D1_ERROR: duplicate column name:
// ...: SQLITE_ERROR" — so that specific, real case is the only one
// treated as safe; anything else is a real, unexpected failure and is
// never silently reported as "ok".
export async function runIdempotentMigration(env: Env, sql: string): Promise<void> {
  try {
    await env.OFFICE_DB.prepare(sql).run();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/duplicate column/i.test(message)) {
      return; // Genuinely already exists — the one real, expected case.
    }
    throw err; // Anything else is real and unexpected — never silently ok.
  }
}

export async function checkIdempotencyKey(env: Env, key: string | null): Promise<Response | null> {
  if (!key) return null;
  const existing = await env.OFFICE_DB.prepare("SELECT status, result FROM idempotency_keys WHERE key = ?")
    .bind(key)
    .first<{ status: string; result: string | null }>();
  if (existing) {
    if (existing.status === "completed" && existing.result) {
      // The exact same result as the original — never reprocessed,
      // whether this is a genuine retry or a duplicate request
      // arriving late.
      return new Response(existing.result, { headers: { "Content-Type": "application/json" } });
    }
    // Still processing — either a genuinely concurrent duplicate, or
    // the original attempt is still running server-side even though
    // the client gave up on it. Never start a second copy of the same
    // work.
    return Response.json(
      { status: "still_processing", message: "This exact request is already being processed. Wait and check again rather than resubmitting." },
      { status: 409 }
    );
  }
  try {
    // Marked processing BEFORE any real work starts — a genuinely
    // concurrent request with the same key will fail this INSERT on
    // the primary key constraint itself, caught below, rather than
    // both proceeding.
    await env.OFFICE_DB.prepare("INSERT INTO idempotency_keys (key, status) VALUES (?, 'processing')").bind(key).run();
  } catch {
    return Response.json(
      { status: "still_processing", message: "This exact request is already being processed. Wait and check again rather than resubmitting." },
      { status: 409 }
    );
  }
  return null; // Genuinely new — the caller proceeds with the real work.
}

export async function completeIdempotencyKey(env: Env, key: string | null, responseBody: string): Promise<void> {
  if (!key) return;
  await env.OFFICE_DB.prepare("UPDATE idempotency_keys SET status = 'completed', result = ? WHERE key = ?")
    .bind(responseBody, key)
    .run();
}

export async function authGate(request: Request, env: Env, url: URL): Promise<Response | null> {
  const path = url.pathname;

  // Real, moved here after a real bug found live: this used to sit as
  // a separate check further down in handleRequest's sequential
  // if-chain, which only protects whichever routes happen to be
  // defined AFTER it in the file — 88 of 120 debug/admin routes were
  // defined earlier and returned before ever reaching it, completely
  // unprotected. authGate is the one place guaranteed to run first,
  // for every request, regardless of where a route's own handler
  // sits in the file. Deliberately independent of ENFORCE_APP_AUTH —
  // this is the same real protection that has covered /admin since
  // 13 July, and it must keep working even while stage 1 is off.
  if ((path.startsWith("/admin/") || path.startsWith("/debug/")) && !APP_DEBUG_ROUTES.has(path)) {
    const providedKey = request.headers.get("X-Admin-Key");
    if (!providedKey || providedKey !== env.ADMIN_KEY) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    return null; // admin-key holders bypass session/role entirely, same as /admin/ always has.
  }

  // Stage 2, real, per direct instruction: also deliberately
  // independent of ENFORCE_APP_AUTH, same real reasoning as the
  // admin-key check above — this must keep refusing an unsigned or
  // wrong-path link even if stage 1 is ever switched off, not quietly
  // stop being checked along with it. A signed link, verified against
  // this exact path, is required instead of a blanket exemption — a
  // customer link and the owner's own in-app tap (via launchUrl, which
  // carries no session at all) both rely on this, not on being signed in.
  if (path.endsWith("/pdf")) {
    const sig = url.searchParams.get("sig");
    const ok = await verifyDocumentToken(env, path, sig);
    return ok ? null : Response.json({ error: "this link is missing or has expired" }, { status: 403 });
  }

  if (!ENFORCE_APP_AUTH) return null;
  if (PUBLIC_ROUTES.has(path)) return null;

  const session = await verifySession(env, getSessionToken(request));
  if (!session) {
    return Response.json({ error: "sign in required" }, { status: 401 });
  }
  const membership = await env.OFFICE_DB.prepare("SELECT role, status FROM memberships WHERE google_email = ?")
    .bind(session.email)
    .first<{ role: string; status: string }>();
  if (!membership || membership.status !== "active") {
    return Response.json({ error: "no active membership" }, { status: 403 });
  }
  return authorizeRestrictedMember(request, env, url, membership.role);
}

// Real feature 2026-07-14 — step 4 of the phased auth scope
// (Constitution Principle 26): resolving what the asker's membership
// actually permits, before any synthesis happens. Real, honest gap
// documented rather than hidden: no valid session currently defaults
// to full (owner-equivalent) capabilities, since every existing route
// and the UI prototype predate real auth and don't send a session
// cookie yet. Safe for a single-instance system only Peter currently
// uses; this default MUST be revisited the moment a real second
// person with genuinely restricted access exists — capability
// enforcement without a required session is not real enforcement.
export async function resolveCapabilities(request: Request, env: Env): Promise<{ email: string | null; role: string | null; capabilities: string[] }> {
  const session = await verifySession(env, getSessionToken(request));
  if (!session) {
    // Fails closed once ENFORCE_APP_AUTH is on: the standing "no
    // session means Owner" default documented above stops being
    // reachable, instead of just being made unreachable on the routes
    // the gate happens to cover.
    return { email: null, role: null, capabilities: ENFORCE_APP_AUTH ? [] : ROLE_CAPABILITIES.owner };
  }
  const membership = await env.OFFICE_DB.prepare("SELECT role, status FROM memberships WHERE google_email = ?")
    .bind(session.email)
    .first<{ role: string; status: string }>();
  if (!membership || membership.status !== "active") {
    return { email: session.email, role: null, capabilities: [] };
  }
  return { email: session.email, role: membership.role, capabilities: ROLE_CAPABILITIES[membership.role] ?? [] };
}

export function getCookie(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie");
  if (!header) return null;
  const match = header.split(";").map((c) => c.trim()).find((c) => c.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}

// Real feature 2026-07-27 — bearer-token auth alongside the existing
// cookie flow, never replacing it. A native app has no browser-style
// cookie jar, and the existing CORS wrapper uses a wildcard origin,
// which browsers refuse to send credentialed (cookie) requests
// against anyway — so a real, explicit Authorization header is the
// robust path for an app-based client, web or native alike. Bearer
// checked first since an app that has one is being deliberate about
// using it; falls back to the cookie for every existing tested flow.
export function getSessionToken(request: Request): string | null {
  const authHeader = request.headers.get("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7).trim();
  }
  return getCookie(request, "office_session");
}

// CORS wrapper. Browsers enforce this; native apps and curl never did,
// which is exactly why this was never needed until testing moved to
// the web preview. Allowing all origins is fine here since there's no
// cookie-based auth to protect — every route is either public or will
// get its own real auth later, not relying on origin-checking for
// security.
// Real, staged, per direct instruction: deployed off first, same
// discipline as every other real security change tonight. Wildcard
// CORS only ever mattered for a browser context — the native app's
// HTTP client ignores these headers entirely, since CORS is a
// browser-enforced policy, not a server one, so tightening this can
// only affect the web preview, never the native app. Confirmed
// directly: only the-office-preview.pages.dev is real and in use; the
// AB-experiment domain is deliberately excluded, confirmed not in
// use, not an oversight.
const ENFORCE_CORS_ALLOWLIST = true;
const ALLOWED_ORIGINS = ["https://the-office-preview.pages.dev"];

const CORS_STATIC_HEADERS = {
  "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

// A request with no Origin header at all (the native app, curl, a
// server-to-server call) is never subject to CORS enforcement by any
// browser in the first place — the value returned here is harmless
// either way for those. Only a real browser, sending a real Origin,
// is actually affected by what this returns.
export function corsHeadersFor(request: Request): Record<string, string> {
  const origin = request.headers.get("Origin");
  const headers: Record<string, string> = { ...CORS_STATIC_HEADERS };
  if (!ENFORCE_CORS_ALLOWLIST) {
    headers["Access-Control-Allow-Origin"] = "*";
  } else if (origin && ALLOWED_ORIGINS.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  // Enforced and no match: the header is left unset, not set to
  // something wrong — the request itself still succeeds (this is
  // never a security boundary against the request reaching the
  // server), but a browser from an origin that isn't the real,
  // known preview can no longer read the response.
  return headers;
}
