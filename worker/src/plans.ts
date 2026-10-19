// A customer starts a payment on their own. The page shows OUR price table's public plans (Enterprise reads "Talk to us"); the OWNER chooses a plan, monthly or annual, and seats; the form creates an order (billing.ts) and sends them on to the signed PayFast
// page. Protected, and pinned in tools/plans-page.test.js: only the owner can do it, and that is re-checked at EVERY step (the page and the form), not just when the link was made, so a link made while someone was the owner does not outlive that; the order is
// for the business and the address in the SIGNED link, never anything the form says (the form carries only plan, interval, seats and the link); the amount comes from our price table; and anything a stranger can reach costs a refusal.
import { readBillingToken } from "./auth";
import { createOrder, isSubscribed, payfastConfig } from "./billing";
import { listOffers, type Offer } from "./limits";
import { escapeHtml, memberRole, page } from "./signup";
import type { Env } from "./types";

export interface Deps { roleOf?: (env: Env, businessId: string, email: string) => Promise<string | null> }

// R399, R3,990, R315.50: whole rand with thousands separators, and cents only when there are some.
export function rand(cents: number): string {
  const whole = Math.floor(cents / 100), rest = cents % 100;
  return `R${String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${rest ? `.${String(rest).padStart(2, "0")}` : ""}`;
}

const expiredPage = (): Response => page("Start again", "<h1>That link has expired</h1><p>For your safety the link to choose a plan only lasts a short while. Please go back to the app, or sign in again, and choose a plan from there.</p>", 400);
const notOwnerPage = (): Response => page("Owner only", "<h1>Only the owner can choose a plan</h1><p>Please ask the owner of the business to do this.</p>", 403);
const alreadyPage = (name: string, status = 200): Response => page("Already subscribed", `<h1>Already subscribed</h1><p><strong>${escapeHtml(name)}</strong> already has a subscription. To change or cancel it, please contact us.</p>`, status);

async function resolve(request: Request, env: Env, rawToken: string | null, deps: Deps): Promise<{ ok: true; email: string; businessId: string; name: string } | { ok: false; response: Response }> {
  const proof = await readBillingToken(env, rawToken);
  if (!proof) return { ok: false, response: expiredPage() };
  const business = await env.OFFICE_DB.prepare("SELECT name, status FROM businesses WHERE id = ?").bind(proof.businessId).first<{ name: string; status: string }>().catch(() => null);
  if (!business || business.status !== "active") return { ok: false, response: page("Not found", "<h1>We could not find that business</h1>", 404) };
  const role = await (deps.roleOf ?? memberRole)(env, proof.businessId, proof.email);   // checked NOW, not when the link was made
  if (role !== "owner") return { ok: false, response: notOwnerPage() };
  return { ok: true, email: proof.email, businessId: proof.businessId, name: business.name };
}

function plansForm(name: string, email: string, token: string, offers: Offer[], contact: string | undefined, message?: string): string {
  const buyable = offers.filter((o) => o.public && (o.monthlyCents !== null || o.annualCents !== null));
  const rows = buyable.map((o, i) => {
    const monthly = o.monthlyCents !== null ? `${rand(o.monthlyCents)}${o.perSeat ? " per seat" : ""} a month` : "";
    const annual = o.annualCents !== null ? `${rand(o.annualCents)}${o.perSeat ? " per seat" : ""} a year` : "";
    const minimum = o.perSeat && o.minSeats > 1 ? ` <span class="small">(minimum of ${o.minSeats} seats)</span>` : "";
    return `<p><label><input type="radio" name="plan" value="${escapeHtml(o.name)}"${i === 0 ? " checked" : ""}> <strong>${escapeHtml(o.label)}</strong>${minimum}<br>${[monthly, annual].filter(Boolean).join(" or ")}</label></p>`;
  }).join("");
  const seats = buyable.some((o) => o.perSeat) ? `<p><label>Seats (Team plan)<br><input type="number" name="seats" value="${Math.max(...buyable.filter((o) => o.perSeat).map((o) => o.minSeats), 1)}" min="1" max="1000" inputmode="numeric"></label></p>` : "";
  const contactLine = contact ? `, ${escapeHtml(contact)}` : ", please contact us";
  return `<h1>Choose a plan</h1><p>For <strong>${escapeHtml(name)}</strong>. You are paying as ${escapeHtml(email)}.</p>${message ? `<p class="error">${escapeHtml(message)}</p>` : ""}<form method="post" action="/billing/start"><input type="hidden" name="t" value="${escapeHtml(token)}">${rows}<p>Billing<br><label><input type="radio" name="interval" value="monthly" checked> Monthly</label> <label><input type="radio" name="interval" value="annual"> Annual</label></p>${seats}<p><button type="submit">Continue to payment</button></p></form><p class="small">Enterprise: custom pricing for larger businesses. To discuss it${contactLine}.</p>`;
}

export async function plansPage(request: Request, env: Env, deps: Deps = {}): Promise<Response> {
  const token = new URL(request.url).searchParams.get("t");
  const who = await resolve(request, env, token, deps);
  if (!who.ok) return who.response;
  if (await isSubscribed(env, who.businessId)) return alreadyPage(who.name);
  return page("Choose a plan", plansForm(who.name, who.email, token as string, await listOffers(env), env.SUPPORT_CONTACT));
}

export async function startPost(request: Request, env: Env, deps: Deps = {}): Promise<Response> {
  let form: FormData;
  try { form = await request.formData(); } catch { return page("Try again", "<h1>That did not work</h1><p>Please go back and try again.</p>", 400); }
  const token = String(form.get("t") ?? "");
  const who = await resolve(request, env, token, deps);
  if (!who.ok) return who.response;
  const seatsText = String(form.get("seats") ?? "");
  const made = await createOrder(env, {
    businessId: who.businessId,   // from the SIGNED link, never from the form
    payerEmail: who.email,        // likewise
    plan: form.get("plan"),
    interval: form.get("interval"),
    seats: /^\d{1,4}$/.test(seatsText) ? Number(seatsText) : undefined,
  });
  if (made.ok) return Response.redirect(`${new URL(request.url).origin}/billing/pay?order=${made.order.id}`, 303);
  if (made.status === 409) return alreadyPage(who.name, 409);
  const again = page("Choose a plan", plansForm(who.name, who.email, token, await listOffers(env), env.SUPPORT_CONTACT, made.error), made.status);
  return again;
}

export const paymentsConfigured = (env: Env): boolean => payfastConfig(env) !== null;

// ---- updating the card on a failed subscription -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// PayFast hosts this page itself: {live host}/eng/recurring/update/{subscription token}?return={our page} (the address comes from PayFast's own SDK source, which also refuses to build it in SANDBOX, so it cannot be tested against the sandbox and is UNPROVEN until
// a real card is used live). Only the verified OWNER of a PAST-DUE business is sent there; the subscription token is used only if it is exactly the shape of a PayFast subscription token and appears nowhere except in that one redirect.
export async function cardUpdatePage(request: Request, env: Env, deps: Deps = {}): Promise<Response> {
  const url = new URL(request.url);
  const who = await resolve(request, env, url.searchParams.get("t"), deps);
  if (!who.ok) return who.response;
  const row = await env.OFFICE_DB.prepare("SELECT billing_status, pf_token FROM businesses WHERE id = ?").bind(who.businessId).first<{ billing_status: string | null; pf_token: string | null }>().catch(() => null);
  if (!row || row.billing_status !== "past_due") return page("Nothing to update", "<h1>There is no card to update here</h1><p>Your payments are up to date, or there is no failed payment. If something looks wrong, please contact us.</p>", 409);
  if (!row.pf_token || !/^[0-9a-f-]{36}$/i.test(row.pf_token)) return page("Please contact us", "<h1>Please contact us</h1><p>We could not find the subscription to update. Please contact us and we will sort it out.</p>", 409);
  const config = payfastConfig(env);
  if (!config) return page("Not set up", "<h1>Payments are not set up yet</h1><p>Please try again later.</p>", 503);
  if (config.sandbox) return page("Test mode", "<h1>Card updates are not available in test mode</h1><p>PayFast only offers this on the live account.</p>");
  return Response.redirect(`https://www.payfast.co.za/eng/recurring/update/${row.pf_token}?return=${url.origin}/billing/card-updated`, 303);
}

export const cardUpdatedPage = (): Response =>
  page("Card updated", "<h1>Thank you</h1><p>Your card details were sent to PayFast. We will try the payment again. If your access does not come back within a day, please contact us.</p>");

