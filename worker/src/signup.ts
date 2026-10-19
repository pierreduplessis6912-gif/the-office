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
import { readSignupToken, signBillingToken, signSignupToken } from "./auth";
import { acceptInvitation, addDirectoryMember, closeBusiness, countDirectoryMembers, createBusiness, declineInvitation, ensureDirectory, findDirectoryConflicts, findEndedAccessForEmail, lookupAccessForEmail, normaliseEmail, pendingInvitationsForEmail } from "./directory";
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
export function page(title: string, body: string, status = 200): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'" } }
  );
}

const ROLE_LABELS: Record<string, string> = { owner: "an owner", accountant: "an accountant", installer: "an installer" };

// The invitations an address may accept, shown ABOVE the option to start its own business (an invitation is an offer, not a trap). Each has its own form so accepting names exactly one invitation.
function invitationsSection(token: string, invites: Array<{ id: number; businessName: string; role: string }>): string {
  if (invites.length === 0) return "";
  const forms = invites
    .map((i) => `<form method="post" action="/auth/join">
<input type="hidden" name="token" value="${escapeHtml(token)}">
<input type="hidden" name="invitation" value="${i.id}">
<p><strong>${escapeHtml(i.businessName)}</strong> has invited you to join as <strong>${escapeHtml(ROLE_LABELS[i.role] ?? i.role)}</strong>.</p>
<button type="submit">Join ${escapeHtml(i.businessName)}</button>
</form>`)
    .join("\n");
  return `<h2>You have been invited</h2>\n${forms}\n<p class="small">Not expecting this? You can ignore it, or start your own business below.</p>`;
}

export function startBusinessPage(email: string, token: string, options: { error?: string; name?: string; status?: number; invites?: Array<{ id: number; businessName: string; role: string }> } = {}): Response {
  const error = options.error ? `<p class="error">${escapeHtml(options.error)}</p>` : "";
  return page(
    "Welcome to The Office",
    `<h1>Welcome to The Office</h1>
<p>You are signed in with <strong>${escapeHtml(email)}</strong>, which is not set up yet.</p>${error}
${invitationsSection(token, options.invites ?? [])}
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

const cardButton = (link: string | undefined): string => (link ? `<p><a href="${escapeHtml(link)}" style="display:inline-block;padding:.8rem 1.2rem;background:#111;color:#fff;border-radius:.4rem;text-decoration:none">Update card</a></p>` : "");
const planButton = (link: string | undefined): string => (link ? `<p><a href="${escapeHtml(link)}" style="display:inline-block;padding:.8rem 1.2rem;background:#111;color:#fff;border-radius:.4rem;text-decoration:none">Choose a plan</a></p>` : "");
const trialEndedPage = (name: string, contact: string | undefined, link?: string): Response =>
  page("Your trial has ended", `<h1>Your free trial has ended</h1><p>The ${TRIAL_DAYS}-day trial for <strong>${escapeHtml(name)}</strong> is over. Your information is safe and has not been deleted.</p><p>${contact ? `To keep using The Office, ${escapeHtml(contact)}.` : "To keep using The Office, please contact us."}</p>${planButton(link)}`, 403);
// The plans link for an ended business, made for THIS address (just verified) and business. Only a trial or a cancelled subscription can start a new subscription; an overdue payment already has one, so it gets no link.
async function planLinkFor(env: Env, ended: { businessId: string; reason: "trial" | "payment" | "cancelled" }, email: string): Promise<string | undefined> {
  // A failed payment already has a subscription, so it is offered the chance to update its CARD (PayFast's own page), never a new plan.
  try { return `${ended.reason === "payment" ? "/billing/update-card" : "/billing/plans"}?t=${encodeURIComponent(await signBillingToken(env, email, ended.businessId))}`; } catch { return undefined; }
}

// Why a business can no longer be signed into: its trial ended, a payment failed and the grace period is over, or its subscription was cancelled and the period it paid for is over. Same contact line as the trial page; nothing is deleted.
const endedPage = (ended: { name: string; reason: "trial" | "payment" | "cancelled" }, contact: string | undefined, link?: string): Response => {
  if (ended.reason === "trial") return trialEndedPage(ended.name, contact, link);
  const how = contact ? `To get back in, ${escapeHtml(contact)}.` : "To get back in, please contact us.";
  return ended.reason === "payment"
    ? page("Payment overdue", `<h1>Payment overdue</h1><p>The latest payment for <strong>${escapeHtml(ended.name)}</strong> did not go through, and the grace period has ended. Your information is safe and has not been deleted.</p>${cardButton(link)}<p>${how}</p>`, 403)
    : page("Subscription ended", `<h1>Your subscription has ended</h1><p>The subscription for <strong>${escapeHtml(ended.name)}</strong> has ended. Your information is safe and has not been deleted.</p>${planButton(link)}<p>${how}</p>`, 403);
};
const notActivePage = (email: string): Response =>
  page("Not active", `<h1>This account is not active</h1><p><strong>${escapeHtml(email)}</strong> belongs to a business, but its membership is not active. Ask the owner of the business to check it.</p>`, 403);
const fullPage = (): Response => page("Try again tomorrow", "<h1>We are full for today</h1><p>We can only open so many new businesses a day. Please try again tomorrow.</p>", 429);
const expiredPage = (): Response => page("Start again", "<h1>That took too long</h1><p>For your safety the sign-in page only lasts a few minutes. Please close this page and sign in again.</p>", 400);
const seatsFullPage = (): Response => page("No free seat", "<h1>This business has no free seat</h1><p>The plan it is on has all its seats in use. Ask the owner of the business to add a seat, then try again.</p>", 409);
const invitationGonePage = (): Response => page("Invitation", "<h1>That invitation is no longer valid</h1><p>It may have expired or been withdrawn. Ask the owner of the business to send it again.</p>", 400);
const errorPage = (): Response => page("Something went wrong", "<h1>Something went wrong</h1><p>We could not finish setting up. Nothing is lost: please close this page, wait a minute and try again.</p>", 500);

// What a browser sees when Google has verified an address that is not (or no longer) a member of any business. Called from the callback, for requests that ask for a web page; anything else keeps the JSON refusal.
export async function handleUnknownAccount(request: Request, env: Env, email: string): Promise<Response> {
  const address = normaliseEmail(email);
  const ended = await findEndedAccessForEmail(env, address);
  if (ended) return endedPage(ended, env.SUPPORT_CONTACT, await planLinkFor(env, ended, address));
  if (await lookupAccessForEmail(env, address)) return notActivePage(address);
  const invites = await pendingInvitationsForEmail(env, address).catch(() => []);   // an invitation that cannot be looked up must never block the page
  return startBusinessPage(address, await signSignupToken(env, address), { invites });
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
  const ended = await findEndedAccessForEmail(env, email);
  if (ended) return endedPage(ended, env.SUPPORT_CONTACT, await planLinkFor(env, ended, email));

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
    // The name they typed goes into the business's own profile too (profile-seed.ts), which is what invoices and quotes carry. Best effort and harmless to repeat: if it fails the signup still succeeds and the journey simply asks for the name.
    await callBusiness(env, id, "POST", "/debug/seed-business-name", { name: named.name }).catch(() => undefined);
    await addDirectoryMember(env, email, id);
    await env.OFFICE_DB.prepare("UPDATE businesses SET status = 'active' WHERE id = ? AND status = 'pending'").bind(id).run();
    return signedInRedirect(request, env, { sessionEmail: email, displayEmail: email, role: "owner", businessId: id, notAfterMs: trialEnd }, 303);
  } catch {
    return errorPage();
  }
}

export async function memberRole(env: Env, businessId: string, email: string): Promise<string | null> {
  try {
    const reply = await callBusiness(env, businessId, "GET", `/debug/membership-check?email=${encodeURIComponent(email)}`);
    if (!reply.ok) return null;
    const found = (await reply.json()) as { found?: boolean; role?: string | null; status?: string | null };
    return found.found && found.role && found.status === "active" ? found.role : null;
  } catch {
    return null;
  }
}

// The Join button (/auth/join): accepting ONE invitation. The same Google-verified proof as starting a business, so only the invited address can accept; and the invitation must still be pending, unexpired and for a business that is active and
// not past its trial (pendingInvitationsForEmail is the single place that decides). Someone who already belongs to a business is simply signed in to THEIR OWN (the invitation is left alone). The conflict with another business is
// found BEFORE anything is written, then the order is: the membership inside the business, the directory entry, the invitation marked accepted; a failure part way leaves the invitation pending and a retry finishes it.
export async function handleJoinPost(request: Request, env: Env): Promise<Response> {
  if (!env.BUSINESS) return Response.json({ error: "joining a business is not available here" }, { status: 404 });
  const form = await request.formData().catch(() => null);
  if (!form) return expiredPage();
  const proof = await readSignupToken(env, String(form.get("token") ?? ""));
  if (!proof) return expiredPage();
  const email = normaliseEmail(proof.email);

  const existing = await lookupAccessForEmail(env, email);
  if (existing) {
    // Someone who already belongs to a business is signed in to THEIR OWN. Two choices on the handover page land here: KEEP (decline the invitations they were shown) and JOIN-AND-CLOSE (verified again below, from scratch).
    if (form.get("keep") === "1") {
      for (const raw of form.getAll("invitation")) if (/^\d{1,9}$/.test(String(raw))) await declineInvitation(env, Number(raw), email).catch(() => undefined);
    } else if (form.get("handover") === "1") {
      const done = await performHandover(request, env, email, existing, String(form.get("invitation") ?? ""));
      if (done) return done;
    }
    const role = await memberRole(env, existing.businessId, email);
    if (!role) return notActivePage(email);
    return signedInRedirect(request, env, { sessionEmail: email, displayEmail: email, role, businessId: existing.businessId, notAfterMs: existing.trialEndsAt ? fromSqlTime(existing.trialEndsAt) : undefined }, 303);
  }
  const ended = await findEndedAccessForEmail(env, email);
  if (ended) return endedPage(ended, env.SUPPORT_CONTACT, await planLinkFor(env, ended, email));

  const rawId = String(form.get("invitation") ?? "");
  if (!/^\d{1,9}$/.test(rawId)) return invitationGonePage();
  try {
    const invite = (await pendingInvitationsForEmail(env, email)).find((i) => i.id === Number(rawId));
    if (!invite) return invitationGonePage();
    if ((await findDirectoryConflicts(env, [email], invite.businessId)).length > 0) return page("Already in a business", "<h1>This address already belongs to another business</h1><p>One Google account can belong to only one business. Ask the owner to invite a different Google account, or contact us.</p>", 409);
    if (!(await memberRole(env, invite.businessId, email))) {
      const made = await callBusiness(env, invite.businessId, "POST", "/debug/create-membership", { google_email: email, role: invite.role, invited_by: invite.invitedBy, person_name: invite.personName });
      if (made.status === 402) return seatsFullPage();   // no free seat: a clear page, and nothing is bound, accepted or closed
      if (!made.ok) throw new Error(`the membership could not be created (${made.status})`);
    }
    await addDirectoryMember(env, email, invite.businessId);
    await acceptInvitation(env, invite.id);
    return signedInRedirect(request, env, { sessionEmail: email, displayEmail: email, role: invite.role, businessId: invite.businessId, notAfterMs: invite.trialEndsAt ? fromSqlTime(invite.trialEndsAt) : undefined }, 303);
  } catch {
    return errorPage();
  }
}

// ---- the empty-business handover ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// An employee who started their own trial by mistake is invited to the business they work for. Their address is bound to their own business, so the sign-in goes straight there and they never see the invitation. If that business is
// SELF-STARTED, still on its TRIAL, has exactly ONE member (them) and is verifiably EMPTY (emptiness.ts), they are ASKED: join (their empty business is closed, nothing deleted; the audit is `closed_into`) or keep it. They must choose:
// nobody can do it for them (an owner can only invite; a direct add to an address in another business is still refused). Anything else, and the sign-in is exactly as before. Everything is re-checked when they tap, whatever the form says.
async function handoverOffer(env: Env, email: string, access: { businessId: string; trialEndsAt: string | null; selfStarted: boolean } | null) {
  if (!access || !access.selfStarted || !access.trialEndsAt) return null;
  try {
    const invites = (await pendingInvitationsForEmail(env, email)).filter((i) => i.businessId !== access.businessId);
    if (invites.length === 0) return null;
    if ((await countDirectoryMembers(env, access.businessId)) !== 1) return null;
    const reply = await callBusiness(env, access.businessId, "GET", `/debug/emptiness?email=${encodeURIComponent(email)}`);
    const answer = (await reply.json().catch(() => null)) as { empty?: boolean } | null;
    if (!reply.ok || answer?.empty !== true) return null;
    const own = await env.OFFICE_DB.prepare("SELECT name FROM businesses WHERE id = ?").bind(access.businessId).first<{ name: string }>();
    return { ownId: access.businessId, ownName: own?.name ?? "your business", invites };
  } catch {
    return null;   // never block a sign-in because the question could not be answered
  }
}

export async function maybeHandoverPage(_request: Request, env: Env, email: string, access: { businessId: string; trialEndsAt: string | null; selfStarted: boolean } | null): Promise<Response | null> {
  const address = normaliseEmail(email);
  const offer = await handoverOffer(env, address, access);
  if (!offer) return null;
  const token = await signSignupToken(env, address);
  const joins = offer.invites
    .map((i) => `<form method="post" action="/auth/join">
<input type="hidden" name="token" value="${escapeHtml(token)}">
<input type="hidden" name="invitation" value="${i.id}">
<input type="hidden" name="handover" value="1">
<p><strong>${escapeHtml(i.businessName)}</strong> has invited you to join as <strong>${escapeHtml(ROLE_LABELS[i.role] ?? i.role)}</strong>.</p>
<button type="submit">Join ${escapeHtml(i.businessName)}</button>
</form>`)
    .join("\n");
  const declines = offer.invites.map((i) => `<input type="hidden" name="invitation" value="${i.id}">`).join("");
  return page(
    "You have been invited",
    `<h1>You have been invited</h1>
<p>You are signed in with <strong>${escapeHtml(address)}</strong>. You already have your own business, <strong>${escapeHtml(offer.ownName)}</strong>, and nothing has been put in it yet.</p>
${joins}
<p class="small">If you join, <strong>${escapeHtml(offer.ownName)}</strong> is closed because it is empty. Nothing is deleted, and nothing that matters is lost.</p>
<form method="post" action="/auth/join">
<input type="hidden" name="token" value="${escapeHtml(token)}">
${declines}
<input type="hidden" name="keep" value="1">
<button type="submit">Keep my own business</button>
</form>`
  );
}

// Join-and-close. Returns a response when it handled the request (success, or a failure the person should see), or null when they are NOT eligible (anything changed, anything tampered): the caller then signs them in to their own
// business, and nothing is closed or added. The order makes a failure part way recoverable: the membership in the new business, the old business closed, the address moved (it may move off a CLOSED business), the invitation accepted;
// if it stops after the old business closed, the same person's ordinary Join finishes it.
async function performHandover(request: Request, env: Env, email: string, access: { businessId: string; trialEndsAt: string | null; selfStarted: boolean }, rawInvitation: string): Promise<Response | null> {
  if (!/^\d{1,9}$/.test(rawInvitation)) return null;
  const offer = await handoverOffer(env, email, access);
  const invite = offer?.invites.find((i) => i.id === Number(rawInvitation));
  if (!offer || !invite) return null;
  try {
    await ensureDirectory(env);
    if (!(await memberRole(env, invite.businessId, email))) {
      const made = await callBusiness(env, invite.businessId, "POST", "/debug/create-membership", { google_email: email, role: invite.role, invited_by: invite.invitedBy, person_name: invite.personName });
      if (made.status === 402) return seatsFullPage();   // no free seat: a clear page, and nothing is bound, accepted or closed
      if (!made.ok) throw new Error(`the membership could not be created (${made.status})`);
    }
    await closeBusiness(env, offer.ownId, invite.businessId);
    await addDirectoryMember(env, email, invite.businessId);
    await acceptInvitation(env, invite.id);
    return signedInRedirect(request, env, { sessionEmail: email, displayEmail: email, role: invite.role, businessId: invite.businessId, notAfterMs: invite.trialEndsAt ? fromSqlTime(invite.trialEndsAt) : undefined }, 303);
  } catch {
    return errorPage();
  }
}

