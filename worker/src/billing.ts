// The payment flow (billing slice 2). An owner chooses a plan; we make an ORDER whose amount is fixed by OUR price table (never by the payer), send them to PayFast with a signed subscription, and PayFast reports the result in a notification (ITN).
// The notification handler is where money is decided. Its order: not configured (503), a signature that does not verify (400), PayFast's own confirmation (400 unless exactly "VALID"), and ONLY THEN anything is read or written. Then: the same payment
// is never applied twice (a unique PayFast payment id); a notification must name the order's own business; the amount must equal the order EXACTLY; a renewal must carry the subscription's own token; a refused notification is recorded as
// rejected and changes nothing (and still answers 200, so PayFast stops retrying). The source address is recorded but advisory (PayFast can change its ranges, and a wrong list would silently reject real payments). The ledger holds no names or
// email addresses. A fault here must never touch a business that has not paid. Pinned in tools/billing.test.js; what it cannot prove is that PayFast's own sandbox accepts our signature (a real sandbox payment does).
import { clearPlanCache, listOffers } from "./limits";
import { buildCheckout, confirmWithPayFastDetailed, ipAllowed, parseItnBody, randToCents, verifyItnSignature, type Pair } from "./payfast";
import { callApi, reasonOf, shownFacts } from "./payfast-api";
import { lapseOf } from "./access";
import type { Env } from "./types";

// ---- configuration ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
export interface PayFastConfig { sandbox: boolean; merchantId: string; merchantKey: string; passphrase: string; skipConfirm: boolean }
// SANDBOX unless PAYFAST_MODE is exactly "live", so no real money can move by accident. Live never borrows the sandbox merchant, and the confirmation-skipping test seam is ignored in live mode.
export function payfastConfig(env: Env): PayFastConfig | null {
  const sandbox = env.PAYFAST_MODE !== "live";
  const merchantId = (sandbox ? env.PAYFAST_SANDBOX_MERCHANT_ID : env.PAYFAST_MERCHANT_ID) ?? "";
  const merchantKey = (sandbox ? env.PAYFAST_SANDBOX_MERCHANT_KEY : env.PAYFAST_MERCHANT_KEY) ?? "";
  if (!merchantId.trim() || !merchantKey.trim()) return null;
  return { sandbox, merchantId: merchantId.trim(), merchantKey: merchantKey.trim(), passphrase: ((sandbox ? env.PAYFAST_SANDBOX_PASSPHRASE : env.PAYFAST_PASSPHRASE) ?? "").trim(), skipConfirm: sandbox && env.PAYFAST_SKIP_CONFIRM === "1" };
}

// ---- tables (created by the writers; the directory's other billing columns too) -----------------------------------------------------------------------------------------------------------------------------
const DDL = [
  "CREATE TABLE IF NOT EXISTS billing_orders (id TEXT PRIMARY KEY, business_id TEXT NOT NULL, plan TEXT NOT NULL, interval TEXT NOT NULL, seats INTEGER NOT NULL, amount_cents INTEGER NOT NULL, item_name TEXT NOT NULL, payer_email TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL DEFAULT (datetime('now')), completed_at TEXT)",
  "CREATE INDEX IF NOT EXISTS idx_billing_orders_business ON billing_orders (business_id, status)",
  "CREATE TABLE IF NOT EXISTS billing_payments (id INTEGER PRIMARY KEY AUTOINCREMENT, pf_payment_id TEXT NOT NULL UNIQUE, order_id TEXT, business_id TEXT, token TEXT, status TEXT NOT NULL, amount_gross_cents INTEGER, amount_fee_cents INTEGER, confirmed INTEGER NOT NULL DEFAULT 0, ip_ok INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')))",
];
// Everything the payment step reads or writes on a business. seats and trial_ends_at are ALSO made by the directory's own setup, but the notification path never runs that, so a shared layer that had not yet been through it made the first real
// notification on production fail with a 500 (staging always had them). The payment step makes what it needs itself.
const BUSINESS_COLUMNS: Array<[string, string]> = [["trial_ends_at", "TEXT"], ["seats", "INTEGER"], ["billing_status", "TEXT"], ["billing_interval", "TEXT"], ["pf_token", "TEXT"], ["period_end", "TEXT"], ["grace_until", "TEXT"]];
export async function ensureBilling(env: Env): Promise<void> {
  for (const sql of DDL) await env.OFFICE_DB.prepare(sql).run();
  const { results } = await env.OFFICE_DB.prepare("PRAGMA table_info(businesses)").all<{ name: string }>();
  const have = new Set((results ?? []).map((r) => r.name));
  for (const [name, type] of BUSINESS_COLUMNS) if (!have.has(name)) await env.OFFICE_DB.prepare(`ALTER TABLE businesses ADD COLUMN ${name} ${type}`).run();
  const orders = await env.OFFICE_DB.prepare("PRAGMA table_info(billing_orders)").all<{ name: string }>();
  const haveOrder = new Set((orders.results ?? []).map((r) => r.name));
  for (const name of ["last_notice", "last_notice_at"]) if (!haveOrder.has(name)) await env.OFFICE_DB.prepare(`ALTER TABLE billing_orders ADD COLUMN ${name} TEXT`).run();
}

// ---- dates (UTC, whole days; a month that is shorter clamps: 31 January plus a month is 28 February) ---------------------------------------------------------------------------------------------------
const ymd = (d: Date): string => d.toISOString().slice(0, 10);
export function addMonths(date: string, months: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const total = y * 12 + (m - 1) + months, year = Math.floor(total / 12), month = total % 12;
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return ymd(new Date(Date.UTC(year, month, Math.min(d, last))));
}
const addDays = (date: string, days: number): string => ymd(new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000));
const GRACE_DAYS = 7;

// ---- an order -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
export interface Order { id: string; businessId: string; plan: string; interval: "monthly" | "annual"; seats: number; amountCents: number; itemName: string; payerEmail: string }
export type OrderResult = { ok: true; order: Order } | { ok: false; status: number; error: string };
type OrderRow = { id: string; business_id: string; plan: string; interval: "monthly" | "annual"; seats: number; amount_cents: number; item_name: string; payer_email: string; status: string };
const toOrder = (r: OrderRow): Order => ({ id: r.id, businessId: r.business_id, plan: r.plan, interval: r.interval, seats: r.seats, amountCents: r.amount_cents, itemName: r.item_name, payerEmail: r.payer_email });
const MAX_SEATS = 1000;
const OPEN_ORDERS_PER_DAY = 20;

// The amount is the plan's price in OUR table, per seat for a per-seat plan, times the seats: the payer never supplies it. A plan that is not public, has no price for that interval, or is the trial cannot be bought online.
export async function createOrder(env: Env, input: { businessId: unknown; payerEmail: unknown; plan: unknown; interval: unknown; seats: unknown }): Promise<OrderResult> {
  if (input.interval !== "monthly" && input.interval !== "annual") return { ok: false, status: 400, error: "Choose monthly or annual billing." };
  const email = typeof input.payerEmail === "string" ? input.payerEmail.trim().toLowerCase() : "";
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, status: 400, error: "We need the owner's email address to take payment." };
  if (typeof input.businessId !== "string" || typeof input.plan !== "string") return { ok: false, status: 400, error: "Choose a plan." };
  if (!payfastConfig(env)) return { ok: false, status: 503, error: "Payments are not set up yet." };
  const offer = (await listOffers(env)).find((o) => o.name === input.plan && o.public);
  const price = offer ? (input.interval === "monthly" ? offer.monthlyCents : offer.annualCents) : null;
  if (!offer || price === null) return { ok: false, status: 400, error: "That plan cannot be bought online." };
  let seats = 1;
  if (offer.perSeat) {
    if (typeof input.seats !== "number" || !Number.isInteger(input.seats) || input.seats < offer.minSeats || input.seats > MAX_SEATS) return { ok: false, status: 400, error: `Choose between ${offer.minSeats} and ${MAX_SEATS} seats.` };
    seats = input.seats;
  }
  const business = await env.OFFICE_DB.prepare("SELECT status FROM businesses WHERE id = ?").bind(input.businessId).first<{ status: string }>();
  if (!business) return { ok: false, status: 404, error: "There is no such business." };
  if (business.status !== "active") return { ok: false, status: 409, error: "This business cannot be changed right now." };
  if (await isSubscribed(env, input.businessId)) return { ok: false, status: 409, error: "This business already has a subscription. Ask us to change or cancel it." };
  await ensureBilling(env);
  // A link that leaked (or a script) must not be able to open orders without limit: at most OPEN_ORDERS_PER_DAY pending orders for a business in a day, after which it is told to use one it already has.
  const open = await env.OFFICE_DB.prepare("SELECT COUNT(*) AS n FROM billing_orders WHERE business_id = ? AND status = 'pending' AND created_at > datetime('now', '-1 day')").bind(input.businessId).first<{ n: number }>();
  if ((open?.n ?? 0) >= OPEN_ORDERS_PER_DAY) return { ok: false, status: 429, error: "This business already has several open orders. Please use one of those, or try again tomorrow." };
  const id = crypto.randomUUID();
  const amountCents = price * seats;
  const itemName = `The Office ${offer.label}${offer.perSeat ? ` (${seats} seat${seats === 1 ? "" : "s"})` : ""}`;
  await env.OFFICE_DB.prepare("INSERT INTO billing_orders (id, business_id, plan, interval, seats, amount_cents, item_name, payer_email) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(id, input.businessId, offer.name, input.interval, seats, amountCents, itemName, email).run();
  return { ok: true, order: { id, businessId: input.businessId, plan: offer.name, interval: input.interval, seats, amountCents, itemName, payerEmail: email } };
}

// A business SUBSCRIBES while its subscription is active or past due (a cancelled one has ended, so it may subscribe again). A shared layer from before the billing columns has nothing to be subscribed to. One subscription per business: otherwise a
// second payment would overwrite the first subscription's token and leave the first billing with nothing pointing at it.
export async function isSubscribed(env: Env, businessId: string): Promise<boolean> {
  try {
    const row = await env.OFFICE_DB.prepare("SELECT billing_status, pf_token FROM businesses WHERE id = ?").bind(businessId).first<{ billing_status: string | null; pf_token: string | null }>();
    return !!row && !!row.pf_token && (row.billing_status === "active" || row.billing_status === "past_due");
  } catch {
    return false;
  }
}

// ---- the signed checkout and the page that sends the payer to PayFast ----------------------------------------------------------------------------------------------------------------------------------------
export function checkoutFor(env: Env, order: Order, origin: string, today: string): { url: string; fields: Pair[] } {
  const config = payfastConfig(env);
  if (!config) throw new Error("PayFast is not configured");
  return buildCheckout({
    merchantId: config.merchantId, merchantKey: config.merchantKey, passphrase: config.passphrase, sandbox: config.sandbox,
    orderId: order.id, amountCents: order.amountCents, itemName: order.itemName, itemDescription: order.interval === "monthly" ? "Monthly subscription" : "Annual subscription",
    frequency: order.interval, email: order.payerEmail, businessId: order.businessId, customStr2: `${order.plan}:${order.interval}:${order.seats}`,
    returnUrl: `${origin}/billing/return`, cancelUrl: `${origin}/billing/cancelled`, notifyUrl: `${origin}/billing/payfast/notify`, today,
  });
}

const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
const html = (body: string, status = 200): Response => new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>The Office</title><style>body{font-family:system-ui,sans-serif;max-width:30rem;margin:3rem auto;padding:0 1rem;color:#111}button{font-size:1rem;padding:.8rem 1.2rem}</style></head><body>${body}</body></html>`, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });

export async function payPage(env: Env, orderId: string, origin: string, now: Date = new Date()): Promise<Response> {
  if (!/^[0-9a-f-]{36}$/i.test(orderId)) return html("<h1>Not found</h1>", 404);
  const row = await env.OFFICE_DB.prepare("SELECT id, business_id, plan, interval, seats, amount_cents, item_name, payer_email, status FROM billing_orders WHERE id = ?").bind(orderId).first<OrderRow>();
  if (!row) return html("<h1>Not found</h1>", 404);
  if (row.status === "completed") return html("<h1>Already paid</h1><p>This order has been paid. You can return to the app.</p>");
  if (row.status !== "pending") return html("<h1>This order cannot be paid</h1><p>It is no longer available. You can return to the app.</p>", 409);
  if (!payfastConfig(env)) return html("<h1>Payments are not set up yet</h1><p>Please try again later.</p>", 503);
  const checkout = checkoutFor(env, toOrder(row), origin, ymd(now));
  const inputs = checkout.fields.map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`).join("\n");
  return html(`<h1>Taking you to PayFast</h1><p>${escapeHtml(row.item_name)}: R${(row.amount_cents / 100).toFixed(2)} ${row.interval === "monthly" ? "a month" : "a year"}.</p><form method="post" action="${escapeHtml(checkout.url)}" id="pf">\n${inputs}\n<button type="submit">Continue to PayFast</button>\n</form><script>document.getElementById("pf").submit();</script>`);
}

// ---- the notification ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
export interface NotifyResult { status: number; outcome: string }
type Fetch = (url: string, init: RequestInit) => Promise<Response>;

// What happened to a notification is kept on the order it NAMES, newest first, the latest five (an operator reads it in the billing view): the outcome, and for a refusal why. Only names and PayFast's own verdict are ever written, never a value,
// a signature, an address or a token. It is written ONLY when the notification looks like PayFast's (it has a payment id) and names an order that exists, so a stranger cannot fill the table; any failure to write is swallowed (a note must never
// change what a notification does).
const NOTICES_KEPT = 5;
async function noteNotice(env: Env, orderId: string, now: Date, notice: string): Promise<void> {
  if (!/^[0-9a-f-]{36}$/i.test(orderId)) return;
  try {
    await ensureBilling(env);
    const row = await env.OFFICE_DB.prepare("SELECT last_notice FROM billing_orders WHERE id = ?").bind(orderId).first<{ last_notice: string | null }>();
    if (!row) return;
    const line = `${now.toISOString().slice(0, 19).replace("T", " ")} ${notice.replace(/[\r\n]+/g, " ").slice(0, 300)}`;
    const kept = [line, ...(row.last_notice ? row.last_notice.split("\n") : [])].slice(0, NOTICES_KEPT).join("\n");
    await env.OFFICE_DB.prepare("UPDATE billing_orders SET last_notice = ?, last_notice_at = datetime('now') WHERE id = ?").bind(kept, orderId).run();
  } catch { /* a note is never allowed to change the outcome */ }
}

export async function handleNotification(env: Env, rawBody: string, ip: string | null, fetchFn: Fetch, now: Date = new Date()): Promise<NotifyResult> {
  const config = payfastConfig(env);
  if (!config) return { status: 503, outcome: "not_configured" };
  const pairs = parseItnBody(rawBody);
  const field = (name: string): string => [...pairs].reverse().find(([k]) => k === name)?.[1] ?? "";
  const pfPaymentId = field("pf_payment_id");
  const note = async (notice: string): Promise<void> => { if (pfPaymentId) await noteNotice(env, field("m_payment_id"), now, notice); };
  if (pairs.length === 0 || !verifyItnSignature(pairs, config.passphrase)) {
    await note(`bad_signature; fields: ${pairs.map(([k]) => k).join(",")}`);
    return { status: 400, outcome: "bad_signature" };
  }
  if (!config.skipConfirm) {
    const confirmed = await confirmWithPayFastDetailed(fetchFn, config.sandbox, pairs);
    if (!confirmed.ok) { await note(`not_confirmed: ${confirmed.detail}`); return { status: 400, outcome: "not_confirmed" }; }
  }
  if (!pfPaymentId) return { status: 400, outcome: "bad_body" };
  try {
    await ensureBilling(env);
    const result = await decide(env, config, field, pfPaymentId, ip, ymd(now));
    await note(result.outcome);
    return result;
  } catch (error) {
    await note(`error: ${error instanceof Error ? error.message : String(error)}`);
    // PayFast retries a non-200: nothing was half-applied that a retry cannot finish. This is only reachable AFTER the signature and PayFast's own confirmation, so only PayFast (and the merchant, on PayFast's dashboard) ever sees the answer. In SANDBOX the
    // reason is given, because "error" alone cost a round trip to find out what had failed; live says just "error".
    return { status: 500, outcome: config.sandbox ? `error: ${error instanceof Error ? error.message : String(error)}`.slice(0, 200) : "error" };
  }
}

async function decide(env: Env, _config: PayFastConfig, field: (n: string) => string, pfPaymentId: string, ip: string | null, today: string): Promise<NotifyResult> {
  const db = env.OFFICE_DB;
  const status = field("payment_status"), token = field("token") || null, orderId = field("m_payment_id"), claimedBusiness = field("custom_str1");
  const gross = randToCents(field("amount_gross")), fee = randToCents(field("amount_fee").replace(/^-/, ""));
  const ipOk = ipAllowed(ip) ? 1 : 0;
  if (status !== "COMPLETE" && status !== "FAILED" && status !== "CANCELLED") return { status: 200, outcome: "ignored" };

  const seen = await db.prepare("SELECT status FROM billing_payments WHERE pf_payment_id = ?").bind(pfPaymentId).first<{ status: string }>();
  if (seen && !(status === "COMPLETE" && (seen.status === "failed" || seen.status === "cancelled"))) return { status: 200, outcome: "duplicate" };   // a payment PayFast first reported as failed may later complete: that is not a replay
  if (seen) await db.prepare("DELETE FROM billing_payments WHERE pf_payment_id = ?").bind(pfPaymentId).run();

  const record = async (paymentStatus: string, order: OrderRow | null, confirmed: number): Promise<void> => {
    await db.prepare("INSERT INTO billing_payments (pf_payment_id, order_id, business_id, token, status, amount_gross_cents, amount_fee_cents, confirmed, ip_ok) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(pfPaymentId, order?.id ?? null, order?.business_id ?? (claimedBusiness || null), token, paymentStatus, gross, fee, confirmed, ipOk).run();
  };

  let order = orderId ? await db.prepare("SELECT * FROM billing_orders WHERE id = ?").bind(orderId).first<OrderRow>() : null;
  if (!order && token) {   // a renewal may not carry our order id: find the subscription by its token
    order = await db.prepare("SELECT o.* FROM billing_orders o JOIN businesses b ON b.id = o.business_id WHERE b.pf_token = ? AND o.status = 'completed' ORDER BY o.completed_at DESC LIMIT 1").bind(token).first<OrderRow>();
  }
  if (!order) { await record("rejected", null, 1); return { status: 200, outcome: "unknown_order" }; }
  if (claimedBusiness && claimedBusiness !== order.business_id) { await record("rejected", order, 1); return { status: 200, outcome: "order_mismatch" }; }

  const business = await db.prepare("SELECT id, status, pf_token, period_end FROM businesses WHERE id = ?").bind(order.business_id).first<{ id: string; status: string; pf_token: string | null; period_end: string | null }>();
  if (!business || business.status !== "active") { await record("rejected", order, 1); return { status: 200, outcome: "unknown_business" }; }
  const subscribed = order.status === "completed";
  if (subscribed && business.pf_token && token && business.pf_token !== token) { await record("rejected", order, 1); return { status: 200, outcome: "token_mismatch" }; }

  if (status === "CANCELLED") {
    if (subscribed) await db.prepare("UPDATE businesses SET billing_status = 'cancelled' WHERE id = ?").bind(order.business_id).run();
    await record("cancelled", order, 1);
    return { status: 200, outcome: "cancelled" };
  }
  if (status === "FAILED") {
    if (subscribed) await db.prepare("UPDATE businesses SET billing_status = 'past_due', grace_until = ? WHERE id = ?").bind(addDays(today, GRACE_DAYS), order.business_id).run();
    await record("failed", order, 1);
    return { status: 200, outcome: "failed" };
  }

  // COMPLETE: the amount must equal the order EXACTLY
  if (gross === null || gross !== order.amount_cents) { await record("rejected", order, 1); return { status: 200, outcome: "amount_mismatch" }; }
  const months = order.interval === "annual" ? 12 : 1;
  if (!subscribed) {
    if (order.status !== "pending") { await record("rejected", order, 1); return { status: 200, outcome: "order_closed" }; }
    // Money has been taken for a SECOND subscription. Do not apply it over the first (that would orphan the first subscription's token); record it as needing REVIEW so an operator can refund it and cancel that subscription.
    if (await isSubscribed(env, order.business_id)) {
      await db.prepare("UPDATE billing_orders SET status = 'review' WHERE id = ?").bind(order.id).run();
      await record("review", order, 1);
      return { status: 200, outcome: "already_subscribed" };
    }
    await db.prepare("UPDATE businesses SET plan = ?, seats = ?, billing_status = 'active', billing_interval = ?, pf_token = ?, period_end = ?, grace_until = NULL, trial_ends_at = NULL WHERE id = ?")
      .bind(order.plan, order.seats, order.interval, token, addMonths(today, months), order.business_id).run();
    await db.prepare("UPDATE billing_orders SET status = 'completed', completed_at = datetime('now') WHERE id = ?").bind(order.id).run();
    await record("complete", order, 1);
    clearPlanCache();
    return { status: 200, outcome: "applied" };
  }
  const from = business.period_end && business.period_end >= today ? business.period_end : business.period_end ?? today;
  await db.prepare("UPDATE businesses SET billing_status = 'active', grace_until = NULL, period_end = ? WHERE id = ?").bind(addMonths(from, months), order.business_id).run();
  await record("complete", order, 1);
  return { status: 200, outcome: "renewed" };
}

// The pages PayFast sends the payer back to. They promise nothing: the payment is only real once PayFast's notification has been confirmed, which can arrive a moment after the payer lands here.
export const returnPage = (): Response => html("<h1>Thank you</h1><p>Your payment is being confirmed. You can return to the app now: your plan will be active in a moment.</p>");
export const cancelledPage = (): Response => html("<h1>Payment cancelled</h1><p>Nothing was charged. You can return to the app and choose a plan whenever you are ready.</p>");

// ---- the operator's view of a business's billing (read-only) ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// What an operator needs to see after a payment: the plan and seats, the subscription state and paid-until date, whether a subscription EXISTS (never its token), and the latest orders and payments (amounts, ids and states, no names or addresses).
// It only reads, and it works on a shared layer from before the billing tables and columns existed: a read never needs them.
export interface BillingStatus {
  business: { id: string; name: string; plan: string; status: string; seats: number | null; billingStatus: string | null; billingInterval: string | null; periodEnd: string | null; graceUntil: string | null; hasSubscription: boolean };
  orders: Array<{ id: string; plan: string; interval: string; seats: number; amountCents: number; status: string; createdAt: string; completedAt: string | null; notices: string[] }>;
  payments: Array<{ pfPaymentId: string; status: string; amountCents: number | null; confirmed: boolean; ipKnown: boolean; createdAt: string }>;
}
export async function billingStatus(env: Env, businessId: string): Promise<BillingStatus | null> {
  const db = env.OFFICE_DB;
  type Row = { id: string; name: string; plan: string; status: string; seats?: number | null; billing_status?: string | null; billing_interval?: string | null; period_end?: string | null; grace_until?: string | null; has_token?: number };
  let row: Row | null;
  try {
    row = await db.prepare("SELECT id, name, plan, status, seats, billing_status, billing_interval, period_end, grace_until, (pf_token IS NOT NULL) AS has_token FROM businesses WHERE id = ?").bind(businessId).first<Row>();
  } catch {
    row = await db.prepare("SELECT id, name, plan, status FROM businesses WHERE id = ?").bind(businessId).first<Row>();   // from before the billing (and seats) columns
  }
  if (!row) return null;
  const rows = async <T,>(sql: string): Promise<T[]> => {
    try { return ((await db.prepare(sql).bind(businessId).all<T>()).results ?? []) as T[]; } catch { return []; }   // no billing tables yet: nothing ordered
  };
  type OrderOut = { id: string; plan: string; interval: string; seats: number; amount_cents: number; status: string; created_at: string; completed_at: string | null; last_notice?: string | null };
  let orders = await rows<OrderOut>("SELECT id, plan, interval, seats, amount_cents, status, created_at, completed_at, last_notice FROM billing_orders WHERE business_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 5");
  if (orders.length === 0) orders = await rows<OrderOut>("SELECT id, plan, interval, seats, amount_cents, status, created_at, completed_at FROM billing_orders WHERE business_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 5");   // a table from before the trail existed
  const payments = await rows<{ pf_payment_id: string; status: string; amount_gross_cents: number | null; confirmed: number; ip_ok: number; created_at: string }>("SELECT pf_payment_id, status, amount_gross_cents, confirmed, ip_ok, created_at FROM billing_payments WHERE business_id = ? ORDER BY id DESC LIMIT 10");
  return {
    business: { id: row.id, name: row.name, plan: row.plan, status: row.status, seats: row.seats ?? null, billingStatus: row.billing_status ?? null, billingInterval: row.billing_interval ?? null, periodEnd: row.period_end ?? null, graceUntil: row.grace_until ?? null, hasSubscription: row.has_token === 1 },
    orders: orders.map((o) => ({ id: o.id, plan: o.plan, interval: o.interval, seats: o.seats, amountCents: o.amount_cents, status: o.status, createdAt: o.created_at, completedAt: o.completed_at, notices: o.last_notice ? o.last_notice.split("\n") : [] })),
    payments: payments.map((p) => ({ pfPaymentId: p.pf_payment_id, status: p.status, amountCents: p.amount_gross_cents, confirmed: p.confirmed === 1, ipKnown: p.ip_ok === 1, createdAt: p.created_at })),
  };
}

// ---- an operator sets a business's subscription state ------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// To correct a state, grant a free month, or rehearse a lapse without waiting weeks. Strict: the state is one of three words, a date is a real calendar date (YYYY-MM-DD) or null to clear it, only the fields GIVEN change, and nothing else about the
// business (plan, seats, subscription token) is touched. Setting 'active' with a date in the future is how a business is let back in; access.ts decides what a state means.
const STATES = new Set(["active", "past_due", "cancelled"]);
const realDate = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
export async function setBillingState(env: Env, input: { business: unknown; billingStatus?: unknown; periodEnd?: unknown; graceUntil?: unknown }): Promise<{ ok: true; status: BillingStatus } | { ok: false; status: number; error: string }> {
  const sets: string[] = [], binds: Array<string | null> = [];
  if (input.billingStatus !== undefined) {
    if (typeof input.billingStatus !== "string" || !STATES.has(input.billingStatus)) return { ok: false, status: 400, error: "billingStatus must be exactly one of: active, past_due, cancelled." };
    sets.push("billing_status = ?"); binds.push(input.billingStatus);
  }
  for (const [key, column] of [["periodEnd", "period_end"], ["graceUntil", "grace_until"]] as const) {
    const value = input[key];
    if (value === undefined) continue;
    if (value !== null && !realDate(value)) return { ok: false, status: 400, error: `${key} must be a real date written YYYY-MM-DD, or null to clear it.` };
    sets.push(`${column} = ?`); binds.push(value);
  }
  if (sets.length === 0) return { ok: false, status: 400, error: "Give at least one of billingStatus, periodEnd, graceUntil." };
  if (typeof input.business !== "string" || !(await env.OFFICE_DB.prepare("SELECT id FROM businesses WHERE id = ?").bind(input.business).first())) return { ok: false, status: 404, error: "There is no such business." };
  await ensureBilling(env);
  await env.OFFICE_DB.prepare(`UPDATE businesses SET ${sets.join(", ")} WHERE id = ?`).bind(...binds, input.business).run();
  const status = await billingStatus(env, input.business);
  return status ? { ok: true, status } : { ok: false, status: 404, error: "There is no such business." };
}

// ---- an operator works with a business's subscription AT PayFast ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// Inspect it, pause it, resume it, or cancel it (a failing subscription is locked by PayFast after five failed attempts and needs the merchant to reactivate it). The subscription token is read from OUR record and put in the address only if it is exactly the shape
// of a PayFast subscription token; it is never returned. Only an allowlist of facts comes back (payfast-api.ts). And these actions NEVER change OUR record of the business: our state moves only when PayFast's own notification arrives (or an operator sets it).
const API_ACTIONS: Record<string, "GET" | "PUT"> = { fetch: "GET", pause: "PUT", unpause: "PUT", cancel: "PUT" };
type ApiFetch = (url: string, init: RequestInit) => Promise<Response>;
const apiFailure = (answer: { reached: boolean; httpStatus: number; json: unknown }): { ok: false; status: number; error: string } => {
  if (!answer.reached) return { ok: false, status: 502, error: "PayFast could not be reached." };
  const reason = reasonOf(answer.json);
  return { ok: false, status: 502, error: `PayFast answered ${answer.httpStatus}${reason ? `: ${reason}` : ""}` };
};
const apiSucceeded = (answer: { httpStatus: number; json: unknown }): boolean => answer.httpStatus === 200 && answer.json !== null && (typeof answer.json === "string" || (typeof answer.json === "object" && (answer.json as { status?: unknown }).status !== "failed"));

export async function pingPayFast(env: Env, fetchFn: ApiFetch, now: Date = new Date()): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const config = payfastConfig(env);
  if (!config) return { ok: false, status: 503, error: "Payments are not set up yet." };
  const answer = await callApi(config, "GET", "/ping", fetchFn, now);
  return apiSucceeded(answer) ? { ok: true } : apiFailure(answer);
}

export async function subscriptionAction(env: Env, businessId: unknown, action: unknown, fetchFn: ApiFetch, now: Date = new Date()): Promise<{ ok: true; result: Record<string, string | number | boolean> } | { ok: false; status: number; error: string }> {
  if (typeof action !== "string" || !Object.prototype.hasOwnProperty.call(API_ACTIONS, action)) return { ok: false, status: 400, error: "action must be exactly one of: fetch, pause, unpause, cancel." };
  const config = payfastConfig(env);
  if (!config) return { ok: false, status: 503, error: "Payments are not set up yet." };
  const row = typeof businessId === "string" ? await env.OFFICE_DB.prepare("SELECT pf_token FROM businesses WHERE id = ?").bind(businessId).first<{ pf_token: string | null }>().catch(() => null) : null;
  if (!row || !row.pf_token) return { ok: false, status: 404, error: "That business has no subscription." };
  if (!/^[0-9a-f-]{36}$/i.test(row.pf_token)) return { ok: false, status: 409, error: "The stored subscription reference is not a PayFast subscription." };
  const answer = await callApi(config, API_ACTIONS[action], `/subscriptions/${row.pf_token}/${action}`, fetchFn, now);
  if (!apiSucceeded(answer) || (typeof answer.json === "string")) return apiFailure(answer);
  return { ok: true, result: action === "fetch" ? shownFacts(answer.json) : { done: true } };
}

// ---- the billing health check: is MONEY STUCK? ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Read-only. Two lists. PROBLEMS are page-worthy because money may have been taken and not applied, or applying it failed: a payment notification that failed to apply in the last 24 hours, a notification refused for an order that is still unpaid, and a payment
// recorded as rejected or review (a second subscription, a wrong amount) in the last 7 days. WATCH is information, never an alarm: a past-due business whose grace period ends within 2 days, and businesses that have lapsed. A missing table or column means "nothing
// to report", but a database that cannot be READ is itself a problem: a silent monitor is worse than a noisy one. It shows no payer address, token or secret, and every detail is at most 120 characters. A scheduled workflow calls it and goes red on a problem.
export interface HealthItem { code: string; detail: string; business?: string; order?: string }
export interface BillingHealth { ok: boolean; checkedAt: string; problems: HealthItem[]; watch: HealthItem[]; counts: { problemsTotal: number; watchTotal: number; ordersPending: number; businessesPastDue: number }; notes: string[] }
const HEALTH_NOTICE_HOURS = 24, HEALTH_PAYMENT_DAYS = 7, HEALTH_MAX_LISTED = 50, HEALTH_DETAIL_MAX = 120, HEALTH_GRACE_WARNING_DAYS = 2;
const isMissingThing = (error: unknown): boolean => /no such (table|column)/i.test(error instanceof Error ? error.message : String(error));
const sqlStamp = (ms: number): string => new Date(ms).toISOString().slice(0, 19).replace("T", " ");

export async function billingHealth(env: Env, now: Date = new Date()): Promise<BillingHealth> {
  const problems: HealthItem[] = [], watch: HealthItem[] = [], notes: string[] = [];
  const clip = (text: string): string => text.replace(/[^\x20-\x7e]/g, "?").slice(0, HEALTH_DETAIL_MAX);
  const db = env.OFFICE_DB, today = ymd(now);
  const since = sqlStamp(now.getTime() - HEALTH_NOTICE_HOURS * 3_600_000), sinceDays = sqlStamp(now.getTime() - HEALTH_PAYMENT_DAYS * 86_400_000);
  let ordersPending = 0, businessesPastDue = 0;
  try {
    try {   // a notification that failed to apply, or was refused for an order still unpaid
      const { results } = await db.prepare("SELECT id, business_id, status, last_notice FROM billing_orders WHERE last_notice IS NOT NULL ORDER BY created_at DESC LIMIT 500").all<{ id: string; business_id: string; status: string; last_notice: string }>();
      for (const row of results ?? []) {
        for (const line of String(row.last_notice).split("\n")) {
          const parts = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) (.*)$/.exec(line);
          if (!parts || parts[1] < since) continue;
          if (parts[2].startsWith("error:")) { problems.push({ code: "notification_error", business: row.business_id, order: row.id.slice(0, 8), detail: clip(parts[2].slice(6).trim() || "a payment notification failed to apply") }); break; }
          if (row.status === "pending" && (parts[2].startsWith("bad_signature") || parts[2].startsWith("not_confirmed"))) { problems.push({ code: "notification_refused", business: row.business_id, order: row.id.slice(0, 8), detail: clip(parts[2]) }); break; }
        }
      }
    } catch (error) { if (!isMissingThing(error)) throw error; notes.push("no notification trail yet"); }
    try {   // money taken but not applied
      const { results } = await db.prepare("SELECT business_id, status, amount_gross_cents FROM billing_payments WHERE status IN ('rejected', 'review') AND created_at >= ? ORDER BY id DESC LIMIT 500").bind(sinceDays).all<{ business_id: string | null; status: string; amount_gross_cents: number | null }>();
      for (const row of results ?? []) problems.push({ code: "payment_needs_review", ...(row.business_id ? { business: row.business_id } : {}), detail: clip(`${row.amount_gross_cents === null ? "a payment" : `R${(row.amount_gross_cents / 100).toFixed(2)}`} was recorded as ${row.status} and not applied`) });
    } catch (error) { if (!isMissingThing(error)) throw error; notes.push("no billing tables yet"); }
    try { ordersPending = (await db.prepare("SELECT COUNT(*) AS n FROM billing_orders WHERE status = 'pending'").first<{ n: number }>())?.n ?? 0; } catch (error) { if (!isMissingThing(error)) throw error; }
    try {   // information: a grace period ending soon, a business now lapsed
      const { results } = await db.prepare("SELECT id, billing_status, grace_until, period_end FROM businesses WHERE billing_status IN ('past_due', 'cancelled')").all<{ id: string; billing_status: string; grace_until: string | null; period_end: string | null }>();
      for (const row of results ?? []) {
        if (row.billing_status === "past_due") businessesPastDue++;
        if (lapseOf(row, today)) watch.push({ code: "lapsed_now", business: row.id, detail: row.billing_status === "past_due" ? "payment overdue and the grace period is over" : "subscription cancelled and the paid period is over" });
        else if (row.billing_status === "past_due" && row.grace_until && row.grace_until >= today && row.grace_until <= addDays(today, HEALTH_GRACE_WARNING_DAYS)) watch.push({ code: "grace_ending_soon", business: row.id, detail: clip(`grace period ends ${row.grace_until}: the owner needs to update their card`) });
      }
    } catch (error) { if (!isMissingThing(error)) throw error; }
  } catch (error) {
    problems.unshift({ code: "health_check_failed", detail: clip(`the database could not be read: ${error instanceof Error ? error.message : String(error)}`) });
  }
  return { ok: problems.length === 0, checkedAt: now.toISOString(), problems: problems.slice(0, HEALTH_MAX_LISTED), watch: watch.slice(0, HEALTH_MAX_LISTED), counts: { problemsTotal: problems.length, watchTotal: watch.length, ordersPending, businessesPastDue }, notes };
}

