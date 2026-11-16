// FINANCIAL YEARS (docs/decisions/year-end-close.md, P1): where a business's year ends, and which year a date falls in. The year-end MONTH is a recorded fact (`year_end.set`, an event like the books
// lock) and defaults to February, the South African individual tax year. A year is the twelve months ending on the last day of that month. This file holds the RULES and the READ; the insert
// (the event) lives in facts.ts, the one write path. Closing a year (P2) is not here yet: `closed` is always empty in P1.
import type { Env } from "../types";
import { accountForRole, booksLockDate } from "./journal";

type Checked<T> = { ok: true; value: T } | { ok: false; reason: string };
const one = <T>(env: Env, sql: string, ...binds: unknown[]) => env.OFFICE_DB.prepare(sql).bind(...binds).first<T>();
const many = async <T>(env: Env, sql: string, ...binds: unknown[]): Promise<T[]> => ((await env.OFFICE_DB.prepare(sql).bind(...binds).all<T>()).results ?? []);

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

// The entries a year-end close writes (and the contra entries of reopening it) carry the closing EVENT as their source. Reports that measure a PERIOD leave them out, so a closed year still shows what it
// earned; reports that measure a POSITION keep them. They are identified by that event, not by a flag anyone could set.
export const CLOSING_ENTRY = "(je.source_kind = 'manual' AND je.source_id IN (SELECT ce.id FROM eng_event ce WHERE ce.type = 'year.closed'))";

export interface ClosedYear { start: string; end: string; profitMinor: number; closedEventId: number; entryWritten: boolean }
// The years closed and not since reopened, in order (replayed from the events: a reopen undoes the latest close).
export async function closedYears(env: Env): Promise<ClosedYear[]> {
  const out: ClosedYear[] = [];
  for (const e of await many<{ id: number; type: string; payload_json: string }>(env, "SELECT id, type, payload_json FROM eng_event WHERE type IN ('year.closed', 'year.reopened') ORDER BY id")) {
    let p: Record<string, unknown> = {}; try { p = JSON.parse(e.payload_json) as Record<string, unknown>; } catch { /* a malformed payload is the verifier's to report */ }
    if (e.type === "year.closed") out.push({ start: String(p.start), end: String(p.end), profitMinor: Number(p.profitMinor), closedEventId: Number(e.id), entryWritten: p.entryWritten === true });
    else { const i = out.findIndex((y) => y.closedEventId === Number(p.closedEventId)); if (i >= 0) out.splice(i, 1); }
  }
  return out;
}
const dayAfter = (d: string) => iso(new Date(new Date(d + "T00:00:00Z").getTime() + 86_400_000));
export { dayAfter };

// The next year that may be closed: the one right after the last closed year, or (when none is closed) the year of the earliest entry in the books. Null when there is nothing to close.
export async function nextToClose(env: Env, month: number, closed: ClosedYear[], today: string): Promise<{ start: string; end: string; ended: boolean } | null> {
  let year: { start: string; end: string } | null = null;
  if (closed.length > 0) year = financialYearOf(dayAfter(closed[closed.length - 1].end), month);
  else {
    const first = await one<{ d: string | null }>(env, "SELECT MIN(je.entry_date) AS d FROM eng_journal_entry je WHERE NOT " + CLOSING_ENTRY);
    if (first?.d) year = financialYearOf(first.d, month);
  }
  return year ? { ...year, ended: year.end < today } : null;
}

// What the owner and the assistant read: where the year ends, this year, last year, the years already closed, and the next one that may be closed.
export async function yearsView(env: Env, asOf: string) {
  const { month, isDefault } = await yearEndMonth(env);
  const current = financialYearOf(asOf, month), closed = await closedYears(env);
  return { yearEndMonth: month, yearEndMonthName: MONTH_NAMES[month - 1], isDefault, asOf, current, previous: previousYear(current, month),
    closed: closed.map((y) => ({ start: y.start, end: y.end, profitMinor: y.profitMinor })), nextToClose: await nextToClose(env, month, closed, asOf) };
}

// Integrity: for each closed year the closing entry exists and touches only profit-and-loss accounts and retained earnings; those accounts net to nothing over the year; the recorded profit is what the
// books say; the years join end to start; and the books are locked at least to the last closed year's end.
export async function verifyYears(env: Env, report: (code: string, detail: string) => void): Promise<void> {
  const closed = await closedYears(env);
  const retained = await accountForRole(env, "retained_earnings");
  for (const [i, y] of closed.entries()) {
    if (i > 0 && y.start !== dayAfter(closed[i - 1].end)) report("year_close_inconsistent", `year ${y.start} to ${y.end} does not begin the day after the year before it ended`);
    const entry = await one<{ id: number; entry_date: string }>(env, "SELECT id, entry_date FROM eng_journal_entry WHERE source_kind = 'manual' AND source_id = ? AND reverses_entry_id IS NULL", y.closedEventId);
    if (y.entryWritten && !entry) report("year_close_inconsistent", `year ending ${y.end} was closed with an entry but none exists`);
    if (!y.entryWritten && entry) report("year_close_inconsistent", `year ending ${y.end} was closed with no entry but one exists`);
    if (entry) {
      if (entry.entry_date !== y.end) report("year_close_inconsistent", `the closing entry of the year ending ${y.end} is dated ${entry.entry_date}`);
      const stray = await one<{ n: number }>(env, "SELECT COUNT(*) AS n FROM eng_journal_line l JOIN eng_account a ON a.id = l.account_id WHERE l.entry_id = ? AND a.type NOT IN ('income', 'cost_of_sales', 'expense') AND a.id <> ?", entry.id, retained ? retained.id : -1);
      if (Number(stray?.n) > 0) report("year_close_inconsistent", `the closing entry of the year ending ${y.end} touches accounts other than profit and loss and retained earnings`);
    }
    for (const a of await many<{ code: string; n: number }>(env, "SELECT a.code, SUM(l.debit_minor - l.credit_minor) AS n FROM eng_journal_line l JOIN eng_journal_entry je ON je.id = l.entry_id JOIN eng_account a ON a.id = l.account_id WHERE a.type IN ('income', 'cost_of_sales', 'expense') AND je.entry_date >= ? AND je.entry_date <= ? GROUP BY a.id HAVING n <> 0", y.start, y.end))
      report("year_close_inconsistent", `account ${a.code} does not net to nothing over the closed year ending ${y.end} (${a.n} cents left)`);
    const profit = await one<{ n: number | null }>(env, "SELECT COALESCE(SUM(l.credit_minor - l.debit_minor), 0) AS n FROM eng_journal_line l JOIN eng_journal_entry je ON je.id = l.entry_id JOIN eng_account a ON a.id = l.account_id WHERE a.type IN ('income', 'cost_of_sales', 'expense') AND je.entry_date >= ? AND je.entry_date <= ? AND NOT " + CLOSING_ENTRY, y.start, y.end);
    if (Number(profit?.n ?? 0) !== y.profitMinor) report("year_close_inconsistent", `the year ending ${y.end} was closed at a profit of ${y.profitMinor} cents but the books say ${profit?.n ?? 0}`);
  }
  if (closed.length > 0) { const lock = await booksLockDate(env); if (lock === null || lock < closed[closed.length - 1].end) report("year_close_inconsistent", `the books are locked to ${lock ?? "nothing"}, before the end of the last closed year (${closed[closed.length - 1].end})`); }
}

// A period the person names in words, as dates the ENGINE works out: this_month, last_month, this_financial_year, last_financial_year. Null for anything else (nothing is guessed).
export async function periodRange(env: Env, period: string, today: string): Promise<{ from: string; to: string } | null> {
  if (period === "this_month" || period === "last_month") {
    const t = new Date(today + "T00:00:00Z"), first = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + (period === "last_month" ? -1 : 0), 1));
    return { from: iso(first), to: iso(new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0))) };
  }
  if (period === "this_financial_year" || period === "last_financial_year") {
    const { month } = await yearEndMonth(env), cur = financialYearOf(today, month), y = period === "this_financial_year" ? cur : previousYear(cur, month);
    return { from: y.start, to: y.end };
  }
  return null;
}
