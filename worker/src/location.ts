// WHERE in the world a business's Durable Object is running. A Durable Object lives in ONE place and is placed when it is first created (an optional location hint can steer that, and only then); every request
// a member makes goes to it. A business whose members are in South Africa and whose object lives in North America pays a long hop on every request, and no server-side timing shows it (the load test runs from
// the same side of the world as staging's objects). So the object asks, once a day, where it is: Cloudflare's trace endpoint answers with the data centre (`colo`) and country (`loc`) of whoever asks, and
// an object that fetches it is asking from where IT runs. The answer is kept in the object's own metadata and shown in the health report (SHIP_CHECKLIST.md item 13).
//
// It is bookkeeping, never a dependency: a failed check is RECORDED (with the last good answer kept) and nothing else is touched; it never throws, never waits more than a few seconds, and never runs inside a
// transaction. Only a fixed Cloudflare address is asked, and nothing about the business or its members is sent.
import type { Env } from "./types";

export const TRACE_URL = "https://www.cloudflare.com/cdn-cgi/trace";
export const TRACE_TIMEOUT_MS = 5000;
export const LOCATION_RECHECK_MS = 24 * 3_600_000;   // a settled answer is re-checked daily (an object does not move)
export const LOCATION_RETRY_MS = 55 * 60_000;        // a check that found nothing is retried at the next hourly alarm

export interface ObjectLocation {
  colo: string | null;       // the data centre, e.g. "DFW" (Dallas) or "JNB" (Johannesburg)
  country: string | null;    // the country it is in, e.g. "US" or "ZA"
  checkedAt: string | null;  // when the last check ran (ok or not)
  error: string | null;      // why the last check found nothing, if it did
}

const EMPTY: ObjectLocation = { colo: null, country: null, checkedAt: null, error: null };

// The trace is plain text, one key=value per line. Only a three-letter data centre and a two-letter country are accepted: anything else is not an answer.
export function parseTrace(text: string): { colo: string | null; country: string | null } {
  const fields: Record<string, string> = {};
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const i = line.indexOf("=");
    if (i > 0) fields[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  const colo = /^[A-Z]{3}$/.test(fields.colo ?? "") ? fields.colo : null;
  const country = /^[A-Z]{2}$/.test(fields.loc ?? "") ? fields.loc : null;
  return { colo, country };
}

async function readMeta(env: Env): Promise<string | null> {
  try {
    return (await env.OFFICE_DB.prepare("SELECT value FROM object_meta WHERE key = 'location'").first<{ value: string }>())?.value ?? null;
  } catch {
    return null;   // not a business's object: no bookkeeping table
  }
}

export async function readLocation(env: Env): Promise<ObjectLocation> {
  const raw = await readMeta(env);
  if (!raw) return { ...EMPTY };
  try {
    const p = JSON.parse(raw) as Partial<ObjectLocation>;
    return { colo: typeof p.colo === "string" ? p.colo : null, country: typeof p.country === "string" ? p.country : null, checkedAt: typeof p.checkedAt === "string" ? p.checkedAt : null, error: typeof p.error === "string" ? p.error : null };
  } catch {
    return { ...EMPTY };
  }
}

// A settled answer is stale after a day; no answer (never checked, or the last check found nothing) is stale after the retry interval.
export function locationIsStale(location: ObjectLocation, nowMs: number): boolean {
  const at = location.checkedAt ? Date.parse(location.checkedAt) : NaN;
  if (!Number.isFinite(at)) return true;
  return nowMs - at >= (location.colo ? LOCATION_RECHECK_MS : LOCATION_RETRY_MS);
}

// Asks, records, and returns what is now on record. NEVER throws.
export async function recordLocation(env: Env, fetchFn: typeof fetch = fetch, now: Date = new Date()): Promise<ObjectLocation> {
  let previous: ObjectLocation = { ...EMPTY };
  try { previous = await readLocation(env); } catch { /* start empty */ }
  let next: ObjectLocation;
  try {
    const response = await fetchFn(TRACE_URL, { method: "GET", signal: AbortSignal.timeout(TRACE_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`the trace answered ${response.status}`);
    const { colo, country } = parseTrace(await response.text());
    if (!colo) throw new Error("the trace did not name a data centre");
    next = { colo, country, checkedAt: now.toISOString(), error: null };
  } catch (error) {
    // keep the last good answer: a failed check must not erase what is known
    next = { colo: previous.colo, country: previous.country, checkedAt: now.toISOString(), error: String((error as { message?: string } | null)?.message ?? error).slice(0, 200) };
  }
  try {
    await env.OFFICE_DB.prepare("INSERT INTO object_meta (key, value) VALUES ('location', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(JSON.stringify(next)).run();
  } catch {
    // recording is bookkeeping: if it cannot be saved the answer is still returned
  }
  return next;
}

// Used by the health report: answers straight away the first time (an object that has never been asked), without waiting for an hourly alarm.
export async function ensureLocation(env: Env, fetchFn: typeof fetch = fetch, now: Date = new Date()): Promise<ObjectLocation> {
  const known = await readLocation(env);
  return known.checkedAt ? known : recordLocation(env, fetchFn, now);
}
