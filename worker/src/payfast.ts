// PayFast: the pure rules (signing a payment request, checking a notification, exact amounts). Nothing here touches a database or the network except the one confirmation call, which is handed its fetch.
// Written to PayFast's own documentation, which says a payment request must be SIGNED, and a notification (ITN) must be checked four ways: a valid signature, a source that belongs to PayFast, an amount that matches the order, and
// PayFast's own confirmation (/eng/query/validate). The signature is an MD5 of the fields URL-encoded THE WAY PHP'S urlencode DOES IT (a space is "+", and ! ' ( ) * ~ are escaped; encodeURIComponent does neither, so a signature
// built with it would reject a genuine notification containing a space), then the passphrase. For a payment REQUEST empty fields are left out and values trimmed; for a NOTIFICATION every posted field is used, empty ones included, exactly as
// posted and never trimmed. Amounts are exact: cents in, "399.00" out, never through floating point. Pinned in tools/payfast.test.js. What this cannot prove is that PayFast's own sandbox accepts a signature we make: only a real sandbox
// payment does (SHIP_CHECKLIST.md, billing).

// ---- MD5 (plain code: the same everywhere, and testable against Node's own) ------------------------------------------------------------------------------------------------------------------------------------
const S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
const K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0);

export function md5Hex(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const total = (((bytes.length + 8) >>> 6) + 1) * 64;
  const data = new Uint8Array(total);
  data.set(bytes);
  data[bytes.length] = 0x80;
  const view = new DataView(data.buffer);
  view.setUint32(total - 8, (bytes.length * 8) >>> 0, true);
  view.setUint32(total - 4, Math.floor(bytes.length / 0x20000000), true);
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  for (let offset = 0; offset < total; offset += 64) {
    const m = Array.from({ length: 16 }, (_, i) => view.getUint32(offset + i * 4, true));
    let a = a0, b = b0, c = c0, d = d0;
    for (let i = 0; i < 64; i++) {
      let f: number, g: number;
      if (i < 16) { f = (b & c) | (~b & d); g = i; }
      else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16; }
      else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16; }
      else { f = c ^ (b | ~d); g = (7 * i) % 16; }
      f = (f + a + K[i] + m[g]) >>> 0;
      a = d; d = c; c = b;
      b = (b + (((f << S[i]) | (f >>> (32 - S[i]))) >>> 0)) >>> 0;
    }
    a0 = (a0 + a) >>> 0; b0 = (b0 + b) >>> 0; c0 = (c0 + c) >>> 0; d0 = (d0 + d) >>> 0;
  }
  const out = new DataView(new ArrayBuffer(16));
  out.setUint32(0, a0, true); out.setUint32(4, b0, true); out.setUint32(8, c0, true); out.setUint32(12, d0, true);
  return Array.from(new Uint8Array(out.buffer), (x) => x.toString(16).padStart(2, "0")).join("");
}

// ---- PHP's urlencode: everything but letters, digits and - _ . is escaped (UTF-8, upper-case hex), and a space is "+" -----------------------------------------------------------------------------
export function phpUrlencode(value: string): string {
  let out = "";
  for (const byte of new TextEncoder().encode(value)) {
    const ch = String.fromCharCode(byte);
    if (/[A-Za-z0-9\-_.]/.test(ch)) out += ch;
    else if (byte === 0x20) out += "+";
    else out += "%" + byte.toString(16).toUpperCase().padStart(2, "0");
  }
  return out;
}

// ---- amounts: exact ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
export function centsToRand(cents: number): string {
  if (!Number.isInteger(cents) || cents < 0) throw new Error("cents must be a whole number of at least 0");
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}
export function randToCents(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const m = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!m) return null;
  return parseInt(m[1], 10) * 100 + parseInt((m[2] ?? "").padEnd(2, "0") || "0", 10);
}

// ---- signing a payment REQUEST -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
export type Pair = [string, string];
export function checkoutSignature(fields: Pair[], passphrase: string | null | undefined): string {
  const body = fields.filter(([, v]) => v.trim() !== "").map(([k, v]) => `${k}=${phpUrlencode(v.trim())}`).join("&");
  const pass = (passphrase ?? "").trim();
  return md5Hex(pass ? `${body}&passphrase=${phpUrlencode(pass)}` : body);
}

// ---- checking a NOTIFICATION ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
export function parseItnBody(body: string): Pair[] {
  if (!body) return [];
  return body.split("&").filter((part) => part.length > 0).map((part) => {
    const i = part.indexOf("=");
    const raw = i === -1 ? [part, ""] : [part.slice(0, i), part.slice(i + 1)];
    const decode = (s: string): string => { const spaced = s.replace(/\+/g, " "); try { return decodeURIComponent(spaced); } catch { return spaced; } };
    return [decode(raw[0]), decode(raw[1])] as Pair;
  });
}
// Every field but the signature, in the order PayFast sent them, empty ones included, exactly as posted. This is also what PayFast is asked to confirm.
export function itnParamString(pairs: Pair[]): string {
  return pairs.filter(([k]) => k !== "signature").map(([k, v]) => `${phpUrlencode(k)}=${phpUrlencode(v)}`).join("&");
}
function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
export function verifyItnSignature(pairs: Pair[], passphrase: string | null | undefined): boolean {
  const given = [...pairs].reverse().find(([k]) => k === "signature")?.[1] ?? "";
  if (!/^[0-9a-f]{32}$/i.test(given)) return false;
  const pass = (passphrase ?? "").trim();
  const body = itnParamString(pairs);
  return sameText(md5Hex(pass ? `${body}&passphrase=${phpUrlencode(pass)}` : body), given.toLowerCase());
}

// ---- where a notification comes from (advisory: see billing.ts for why it does not decide on its own) ------------------------------------------------------------------------------------------------
export const PAYFAST_RANGES = ["197.97.145.144/28", "41.74.179.192/27", "102.216.36.0/28", "102.216.36.128/28", "144.126.193.139"];
function ipv4(text: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text.trim());
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.some((n) => n > 255) ? null : ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}
export function ipAllowed(ip: string | null | undefined, ranges: string[] = PAYFAST_RANGES): boolean {
  const address = typeof ip === "string" ? ipv4(ip) : null;
  if (address === null) return false;
  return ranges.some((range) => {
    const [base, bits] = range.split("/");
    const start = ipv4(base);
    if (start === null) return false;
    const width = bits === undefined ? 32 : Number(bits);
    if (!Number.isInteger(width) || width < 0 || width > 32) return false;
    const mask = width === 0 ? 0 : (0xffffffff << (32 - width)) >>> 0;
    return ((address & mask) >>> 0) === ((start & mask) >>> 0);
  });
}

// ---- asking PayFast itself: anything but exactly "VALID" is NOT confirmed -------------------------------------------------------------------------------------------------------------------------------------
export async function confirmWithPayFast(fetchFn: (url: string, init: RequestInit) => Promise<Response>, sandbox: boolean, pairs: Pair[]): Promise<boolean> {
  try {
    const response = await fetchFn(`https://${sandbox ? "sandbox.payfast.co.za" : "www.payfast.co.za"}/eng/query/validate`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: itnParamString(pairs) });
    return response.ok && (await response.text()).trim() === "VALID";
  } catch {
    return false;
  }
}

// ---- the signed subscription we send the payer to ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
export interface CheckoutInput {
  merchantId: string; merchantKey: string; passphrase: string | null; sandbox: boolean;
  orderId: string; amountCents: number; itemName: string; itemDescription?: string;
  frequency: "monthly" | "annual"; email: string; firstName?: string; lastName?: string; businessId: string; customStr2?: string;
  returnUrl: string; cancelUrl: string; notifyUrl: string; today: string;
}
// The fields in PayFast's documented order, empty ones left out, values trimmed (what is posted is exactly what was signed), the signature last. A monthly plan recurs every month and an annual plan every year, from today, with no end date.
export function buildCheckout(input: CheckoutInput): { url: string; fields: Pair[] } {
  if (!Number.isInteger(input.amountCents) || input.amountCents < 1) throw new Error("the amount must be a whole number of cents, at least 1");
  if (!input.orderId) throw new Error("an order id is required");
  if (input.frequency !== "monthly" && input.frequency !== "annual") throw new Error("the frequency must be monthly or annual");
  if (!input.notifyUrl || !input.returnUrl || !input.cancelUrl) throw new Error("the return, cancel and notification addresses are required");
  const amount = centsToRand(input.amountCents);
  const raw: Pair[] = [
    ["merchant_id", input.merchantId], ["merchant_key", input.merchantKey],
    ["return_url", input.returnUrl], ["cancel_url", input.cancelUrl], ["notify_url", input.notifyUrl],
    ["name_first", input.firstName ?? ""], ["name_last", input.lastName ?? ""], ["email_address", input.email],
    ["m_payment_id", input.orderId], ["amount", amount], ["item_name", input.itemName], ["item_description", input.itemDescription ?? ""],
    ["custom_str1", input.businessId], ["custom_str2", input.customStr2 ?? ""],
    ["subscription_type", "1"], ["billing_date", input.today], ["recurring_amount", amount], ["frequency", input.frequency === "monthly" ? "3" : "6"], ["cycles", "0"],
  ];
  const fields = raw.map(([k, v]) => [k, v.trim()] as Pair).filter(([, v]) => v !== "");
  return { url: `https://${input.sandbox ? "sandbox.payfast.co.za" : "www.payfast.co.za"}/eng/process`, fields: [...fields, ["signature", checkoutSignature(fields, input.passphrase)]] };
}
