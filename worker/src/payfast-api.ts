// PayFast's subscription API, called from the Worker (api.payfast.co.za). Its request signing was PROVED against PayFast's own sandbox: its ping answered 200 with this scheme and 401 "Merchant authorization failed" with a wrong signature. A request carries the
// merchant id, the API version, a timestamp and a signature; the signature is the MD5 of those values (plus the passphrase when there is one), keys in alphabetical order, values URL-encoded the PHP way. The passphrase and merchant key are NEVER sent.
// Pinned in tools/payfast-api.test.js. The functions an operator uses (billing.ts) build on callApi; nothing here logs.
import { md5Hex, phpUrlencode } from "./payfast";

// PayFast asks for South African time (UTC+2, no daylight saving), written YYYY-MM-DDTHH:MM:SS+02:00.
export function apiTimestamp(now: Date): string {
  return `${new Date(now.getTime() + 2 * 3_600_000).toISOString().slice(0, 19)}+02:00`;
}

export function apiSignature(fields: { merchantId: string; passphrase: string; timestamp: string; version: string }): string {
  const data: Record<string, string> = { "merchant-id": fields.merchantId, timestamp: fields.timestamp, version: fields.version };
  if (fields.passphrase) data.passphrase = fields.passphrase;   // an empty passphrase is left out, as PayFast requires
  return md5Hex(Object.keys(data).sort().map((key) => `${key}=${phpUrlencode(data[key])}`).join("&"));
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>;
export interface ApiAnswer { reached: boolean; httpStatus: number; json: unknown }

// One call to PayFast. Sandbox adds ?testing=true. A network failure is `reached: false`; anything PayFast answers is returned as it came.
export async function callApi(config: { sandbox: boolean; merchantId: string; passphrase: string }, method: "GET" | "PUT", path: string, fetchFn: Fetch, now: Date): Promise<ApiAnswer> {
  const timestamp = apiTimestamp(now);
  const headers: Record<string, string> = { "merchant-id": config.merchantId, version: "v1", timestamp, signature: apiSignature({ merchantId: config.merchantId, passphrase: config.passphrase, timestamp, version: "v1" }) };
  try {
    const response = await fetchFn(`https://api.payfast.co.za${path}${config.sandbox ? "?testing=true" : ""}`, { method, headers });
    const text = await response.text();
    let json: unknown = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { reached: true, httpStatus: response.status, json };
  } catch {
    return { reached: false, httpStatus: 0, json: null };
  }
}

// PayFast's short reason for a refusal (data.response), cleaned and shortened; empty when there is none.
export function reasonOf(json: unknown): string {
  const data = (json as { data?: { response?: unknown } } | null)?.data;
  return typeof data?.response === "string" ? data.response.replace(/[^\x20-\x7e]/g, "?").slice(0, 80) : "";
}

// Only these facts about a subscription are ever passed on. An allowlist, not a blocklist: the subscription token (which can charge or cancel a customer), the buyer's name and address and anything PayFast adds later never get through.
const SHOWN = ["status", "amount", "cycles", "cycles_complete", "frequency", "run_date", "billing_date", "date_created", "paused", "cancelled"];
export function shownFacts(json: unknown): Record<string, string | number | boolean> {
  const response = (json as { data?: { response?: unknown } } | null)?.data?.response;
  const out: Record<string, string | number | boolean> = {};
  if (response && typeof response === "object") for (const key of SHOWN) { const value = (response as Record<string, unknown>)[key]; if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") out[key] = typeof value === "string" ? value.slice(0, 40) : value; }
  return out;
}
