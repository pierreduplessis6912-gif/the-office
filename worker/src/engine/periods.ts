// FINANCIAL YEARS (docs/decisions/year-end-close.md, P1): where a business's year ends, and which year a date falls in. The year-end MONTH is a recorded fact (`year_end.set`, an event like the books
// lock) and defaults to February, the South African individual tax year. A year is the twelve months ending on the last day of that month. This file holds the RULES and the READ; the insert
// (the event) lives in facts.ts, the one write path. Closing a year (P2) is not here yet: `closed` is always empty in P1.
import type { Env } from "../types";

type Checked<T> = { ok: true; value: T } | { ok: false; reason: string };
const one = <T>(env: Env, sql: string, ...binds: unknown[]) => env.OFFICE_DB.prepare(sql).bind(...binds).first<T>();

export const DEFAULT_YEAR_END_MONTH = 2;
export const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"] as const;

export function checkYearEnd(payload: unknown): Checked<{ month: number; reason: string | null }> {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return { ok: false, reason: "the request must be an object" };
  const p = payload as Record<string, unknown>;
  const stray = Object.keys(p).find((k) => k !== "month" && k !== "reason"); if (stray) return { ok: false, reason: `${stray} is not a field of this request` };
  if (!Number.isInteger(p.month) || (p.month as number) < 1 || (p.month as number) > 12) return { ok: false, reason: "month must be a whole number from 1 (January) to 12 (December)" };
  if (p.reason !== undefined && (typeof p.reason !== "string" || p.reason.length > 300)) return { ok: false, reason: "reason must be text of at most 300 characters" };
  return { ok: true, value: { month: p.month as number, reason: typeof p.reason === "string" && p.reason.trim() ? p.reason.trim() : null } };
}

// The month the year ends in: the latest recorded setting, else February. (The event is the only record; there is no table.)
export async function yearEndMonth(env: Env): Promise<{ month: number; isDefault: boolean }> {
  const e = await one<{ payload_json: string }>(env, "SELECT payload_json FROM eng_event WHERE type = 'year_end.set' ORDER BY id DESC LIMIT 1");
  if (!e) return { month: DEFAULT_YEAR_END_MONTH, isDefault: true };
  try { const m = Number((JSON.parse(e.payload_json) as { month?: unknown }).month); if (Number.isInteger(m) && m >= 1 && m <= 12) return { month: m, isDefault: false }; } catch { /* fall through */ }
  return { month: DEFAULT_YEAR_END_MONTH, isDefault: true };
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
// The financial year a date falls in: it ends on the last day of `month` and begins the day after the previous year ended.
export function financialYearOf(date: string, month: number): { start: string; end: string } {
  const d = new Date(date + "T00:00:00Z"), y = d.getUTCFullYear(), m = d.getUTCMonth() + 1;
  const endYear = m <= month ? y : y + 1;
  const end = new Date(Date.UTC(endYear, month, 0));              // day 0 of the next month is the last day of `month`
  const start = new Date(Date.UTC(endYear - 1, month, 1));        // the first day after last year's end
  return { start: iso(start), end: iso(end) };
}
export function previousYear(year: { start: string; end: string }, month: number): { start: string; end: string } {
  const before = new Date(new Date(year.start + "T00:00:00Z").getTime() - 86_400_000);
  return financialYearOf(iso(before), month);
}

// What the owner and the assistant read: where the year ends, this year, last year, and (from P2) the years already closed.
export async function yearsView(env: Env, asOf: string) {
  const { month, isDefault } = await yearEndMonth(env);
  const current = financialYearOf(asOf, month);
  return { yearEndMonth: month, yearEndMonthName: MONTH_NAMES[month - 1], isDefault, asOf, current, previous: previousYear(current, month), closed: [] as Array<{ start: string; end: string; profitMinor: number }> };
}
