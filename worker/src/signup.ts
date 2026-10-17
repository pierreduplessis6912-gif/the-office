// Starting a business from the app (SHIP_CHECKLIST.md item 15; decided with Pierre 2026-10-17: open to anyone, a 14-day free trial with small limits). Until now only an operator could create a business, so a genuinely new customer
// who installed the app signed in with Google, was nobody's member, and met a raw error. The sign-in itself is now the front door, and the app needs no change: it already receives its session from the browser tab that
// Google's sign-in opens, and that tab now ends the same way for a new owner as for a returning one.
//
//   1. They pick their main Google account. Google proves the address (email_verified), so nobody types, or mistypes, an email.
//   2. If the address belongs to no business, the tab shows a page (not the JSON): "Start my business" (a name and a tick) or "I work for a business" (ask your owner to add this address).
//   3. Start: their address becomes the OWNER of a new business on the `trial` plan, and the tab finishes as it always does: the app opens signed in to a blank business, ready for the onboarding journey.
//
// Safe enough because: only a Google-verified address, proven by a short-lived signed token the page carries; one email can belong to one business (enforced by the directory); a cap on new businesses per day (everyone) and per
// network address; a small trial limit (limits.ts TRIAL_PLAN); and a session that dies when the trial does. Not solved here: billing after the trial (a business stays inactive until an operator moves it to a paid plan).
import { readSignupToken, signSignupToken } from "./auth";
import { addDirectoryMember, createBusiness, ensureDirectory, findEndedTrialForEmail, lookupAccessForEmail, normaliseEmail } from "./directory";
import { ensureTrialPlan, TRIAL_PLAN } from "./limits";
import { callBusiness } from "./routing";
import { signedInRedirect } from "./signin";
import { fromSqlTime, sqlTime } from "./freetrial";
import type { Env } from "./types";

export const TRIAL_DAYS = 14;
const DAY_MS = 86_400_000;
const DEFAULT_DAILY_CAP = 50;
const DEFAULT_IP_DAILY_CAP = 10;

export const escapeHtml = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export function validateBusinessName(raw: unknown): { ok: true; name: string } | { ok: false; error: string } {
  if (typeof raw !== "string") return { ok: false, error: "Please type your business's name." };
  const name = raw.replace(/\s+/g, " ").trim();
  if (name.length < 2 || name.length > 80) return { ok: false, error: "A business name is 2 to 80 characters." };
  if (/[\u0000-\u001f\u007f]/.test(name) || /[<>]/.test(name)) return { ok: false, error: "Please leave out the characters < and > from the name." };
  return { ok: true, name };
}

// "Acme Floors & Blinds (Pty) Ltd" -> "acme-floors-blinds-pty-ltd", at most 28 characters, letters and digits only; a name with none (another script) becomes "business".
export function slugify(name: string): string {
  const ascii = name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 28).replace(/-+$/g, "");
  return ascii.length >= 2 ? ascii : "business";
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// The id is the name's slug plus six characters of a hash of the OWNER'S EMAIL: the same person starting the same business again (a retry after a half-finished attempt, a double tap) gets the SAME id, so it resumes instead of
// leaving an orphan behind, and no one can ever collide with someone else's business. At most 28 + 1 + 6 = 35 characters, inside the directory's 3 to 40.
export async function businessIdFor(name: string, email: string): Promise<string> {
  return `${slugify(name)}-${(await sha256Hex(normaliseEmail(email))).slice(0, 6)}`;
}


// ---- pages ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
const STYLE =
  "body{font-family:system-ui,sans-serif;margin:0;background:#f6f5f2;color:#1b1b1b}main{max-width:30rem;margin:0 auto;padding:1.5rem 1.25rem 3rem}h1{font-size:1.5rem}h2{font-size:1.15rem;margin-top:1.75rem}" +
  "label{display:block;margin:1rem 0 .35rem;font-weight:600}input[type=text]{width:100%;box-sizing:border-box;padding:.8rem;font-size:1rem;border:1px solid #888;border-radius:.5rem}" +
  ".check{display:flex;gap:.6rem;font-weight:400;align-items:flex-start}.check input{margin-top:.25rem}button{width:100%;margin-top:1.25rem;padding:1rem;font-size:1.05rem;font-weight:700;border:0;border-radius:.6rem;background:#1b1b1b;color:#fff}" +
  ".small{color:#555;font-size:.9rem}.error{background:#fde8e8;border:1px solid #d33;padding:.7rem .9rem;border-radius:.5rem}details{margin-top:1.75rem;padding:.9rem;background:#fff;border-radius:.6rem}summary{font-weight:700}";

// No `form-action` in the policy on purpose: Chrome applies it to the redirect a form POST ends in, and this form's POST ends in a redirect to the app's own address (theoffice://), which `form-action 'self'` would refuse.
function page(title: string, body: string, status = 200): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'" } }
  );
}

export function startBusinessPage(email: string, token: string, options: { error?: string; name?: string; status?: number } = {}): Response {
  const error = options.error ? `<p class="error">${escapeHtml(options.error)}</p>` : "";
  return page(
    "Welcome to The Office",
    `<h1>Welcome to The Office</h1>
<p>You are signed in with <strong>${escapeHtml(email)}</strong>, which is not set up yet.</p>${error}
<form method="post" action="/auth/signup">
<input type="hidden" name="token" value="${escapeHtml(token)}">
<h2>Start my business</h2>
<label for="business_name">Your business's name</label>
<input type="text" id="business_name" name="business_name" required minlength="2" maxlength="80" autocomplete="organization" value="${escapeHtml(options.name ?? "")}">
<label class="check"><input type="checkbox" name="agree" required> <span>I agree that The Office stores my business's information to run the service for me.</span></label>
<button type="submit">Start my ${TRIAL_DAYS}-day free trial</button>
<p class="small">The trial has small daily limits. No card needed.</p>
</form>
<details><summary>I work for a business</summary><p>Ask your owner to add <strong>${escapeHtml(email)}</strong> in The Office. When they have, close this page and sign in again.</p></details>
<p class="small">Wrong account? Close this page and choose a different Google account.</p>`,
    options.status ?? 200
  );
}

const trialEndedPage = (name: string, contact: string | undefined): Response =>
  page("Your trial has ended", `<h1>Your free trial has ended</h1><p>The ${TRIAL_DAYS}-day trial for <strong>${escapeHtml(name)}</strong> is over. Your information is safe and has not been deleted.</p><p>${contact ? `To keep using The Office, ${escapeHtml(contact)}.` : "To keep using The Office, please contact us."}</p>`, 403);
const notActivePage = (email: string): Response =>
  page("Not active", `<h1>This account is not active</h1><p><strong>${escapeHtml(email)}</strong> belongs to a business, but its membership is not active. Ask the owner of the business to check it.</p>`, 403);
const fullPage = (): Response => page("Try again tomorrow", "<h1>We are full for today</h1><p>We can only open so many new businesses a day. Please try again tomorrow.</p>", 429);
const expiredPage = (): Response => page("Start again", "<h1>That took too long</h1><p>For your safety the sign-in page only lasts a few minutes. Please close this page and sign in again.</p>", 400);
const errorPage = (): Response => page("Something went wrong", "<h1>Something went wrong</h1><p>We could not finish setting up. Nothing is lost: please close this page, wait a minute and try again.</p>", 500);

// What a browser sees when Google has verified an address that is not (or no longer) a member of any business. Called from the callback, for requests that ask for a web page; anything else keeps the JSON refusal.
export async function handleUnknownAccount(request: Request, env: Env, email: string): Promise<Response> {
  const address = normaliseEmail(email);
  const ended = await findEndedTrialForEmail(env, address);
  if (ended) return trialEndedPage(ended.name, env.SUPPORT_CONTACT);
  if (await lookupAccessForEmail(env, address)) return notActivePage(address);
  return startBusinessPage(address, await signSignupToken(env, address));
}

// ---- caps ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
const cap = (value: string | undefined, fallback: number): number => {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
};

async function overCaps(env: Env, request: Request): Promise<boolean> {
  const db = env.OFFICE_DB;
  const today = await db.prepare("SELECT COUNT(*) AS n FROM businesses WHERE source = 'signup' AND created_at >= date('now')").first<{ n: number }>();
  if (Number(today?.n ?? 0) >= cap(env.SIGNUP_DAILY_CAP, DEFAULT_DAILY_CAP)) return true;
  await db.prepare("CREATE TABLE IF NOT EXISTS signup_ips (day TEXT NOT NULL, ip TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, ip))").run();
  const ip = (await sha256Hex(request.headers.get("CF-Connecting-IP") ?? "unknown")).slice(0, 16);
  await db.prepare("INSERT INTO signup_ips (day, ip, n) VALUES (date('now'), ?, 1) ON CONFLICT(day, ip) DO UPDATE SET n = n + 1").bind(ip).run();
  const mine = await db.prepare("SELECT n FROM signup_ips WHERE day = date('now') AND ip = ?").bind(ip).first<{ n: number }>();
  return Number(mine?.n ?? 0) > cap(env.SIGNUP_IP_DAILY_CAP, DEFAULT_IP_DAILY_CAP);
}

// ---- the form comes back -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
export async function handleSignupPost(request: Request, env: Env): Promise<Response> {
  if (!env.BUSINESS) return Response.json({ error: "starting a business is not available here" }, { status: 404 });
  const form = await request.formData().catch(() => null);
  if (!form) return expiredPage();
  const token = String(form.get("token") ?? "");
  const proof = await readSignupToken(env, token);
  if (!proof) return expiredPage();
  const email = normaliseEmail(proof.email);

  // Already a member of a business (a double tap, or the page left open): just sign them in.
  const existing = await lookupAccessForEmail(env, email);
  if (existing) {
    const role = await memberRole(env, existing.businessId, email);
    if (!role) return notActivePage(email);
    return signedInRedirect(request, env, { sessionEmail: email, displayEmail: email, role, businessId: existing.businessId, notAfterMs: existing.trialEndsAt ? fromSqlTime(existing.trialEndsAt) : undefined }, 303);
  }
  const ended = await findEndedTrialForEmail(env, email);
  if (ended) return trialEndedPage(ended.name, env.SUPPORT_CONTACT);

  const named = validateBusinessName(form.get("business_name"));
  const typed = typeof form.get("business_name") === "string" ? String(form.get("business_name")) : "";
  if (!named.ok) return startBusinessPage(email, token, { error: named.error, name: typed, status: 400 });
  if (form.get("agree") !== "on") return startBusinessPage(email, token, { error: "Please tick the box to continue.", name: named.name, status: 400 });

  try {
    await ensureDirectory(env);
    await ensureTrialPlan(env);
    const id = await businessIdFor(named.name, email);
    const resume = await env.OFFICE_DB.prepare("SELECT status, source, trial_ends_at FROM businesses WHERE id = ?").bind(id).first<{ status: string; source: string; trial_ends_at: string | null }>();
    // A new business counts against the caps; finishing one this person already started does not.
    if (!resume && (await overCaps(env, request))) return fullPage();
    if (resume && !(resume.source === "signup" && resume.status === "pending")) return errorPage();   // an id this person did not start: never touch it
    const trialEnd = resume?.trial_ends_at ? fromSqlTime(resume.trial_ends_at) : Date.now() + TRIAL_DAYS * DAY_MS;
    if (!resume) await createBusiness(env, id, named.name, TRIAL_PLAN.name, { status: "pending", trialEndsAt: sqlTime(trialEnd), source: "signup" });
    // The owner's membership inside the business's own object (this also creates the object). Then the sign-in entry, then the business goes live: until the last step nobody can sign in to it, so a failure part way is
    // retried from the top by the same person and picks up where it stopped.
    if (!(await memberRole(env, id, email))) {
      const made = await callBusiness(env, id, "POST", "/debug/create-membership", { google_email: email, role: "owner" });
      if (!made.ok) throw new Error(`the owner's membership could not be created (${made.status})`);
    }
    await addDirectoryMember(env, email, id);
    await env.OFFICE_DB.prepare("UPDATE businesses SET status = 'active' WHERE id = ? AND status = 'pending'").bind(id).run();
    return signedInRedirect(request, env, { sessionEmail: email, displayEmail: email, role: "owner", businessId: id, notAfterMs: trialEnd }, 303);
  } catch {
    return errorPage();
  }
}

async function memberRole(env: Env, businessId: string, email: string): Promise<string | null> {
  try {
    const reply = await callBusiness(env, businessId, "GET", `/debug/membership-check?email=${encodeURIComponent(email)}`);
    if (!reply.ok) return null;
    const found = (await reply.json()) as { found?: boolean; role?: string | null; status?: string | null };
    return found.found && found.role && found.status === "active" ? found.role : null;
  } catch {
    return null;
  }
}
