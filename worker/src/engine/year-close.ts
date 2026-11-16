// CLOSING A FINANCIAL YEAR (docs/decisions/year-end-close.md, P2): the RULES and PLANS. The inserts live in facts.ts (the one write path). Closing posts ONE closing journal dated the last day of the year
// (every income, cost-of-sales and expense account brought to nothing, the profit or loss to retained earnings), moves the books lock to that day, and records the year; reopening reverses the closing
// journal with a contra entry and moves the lock back. Nothing is edited or deleted. The closing and reopening entries do not go through the lock check on purpose: closing is the one deliberate
// act that writes into a period the books are being locked against.
import type { Env } from "../types";
import { EngineError } from "./errors";
import { accountForRole } from "./journal";
import { verifyIntegrity } from "./integrity";
import { checkDate } from "./quotations";
import { CLOSING_ENTRY, MONTH_NAMES, closedYears, dayAfter, financialYearOf, yearEndMonth } from "./periods";

type Checked<T> = { ok: true; value: T } | { ok: false; reason: string };
const one = <T>(env: Env, sql: string, ...binds: unknown[]) => env.OFFICE_DB.prepare(sql).bind(...binds).first<T>();
const many = async <T>(env: Env, sql: string, ...binds: unknown[]): Promise<T[]> => ((await env.OFFICE_DB.prepare(sql).bind(...binds).all<T>()).results ?? []);

export interface CloseInput { yearEnd: string; reason: string | null }
export interface ReopenInput { yearEnd: string; reason: string }
const obj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function checkCloseInput(payload: unknown): Checked<CloseInput> {
  if (!obj(payload)) return { ok: false, reason: "the request must be an object" };
  const stray = Object.keys(payload).find((k) => k !== "yearEnd" && k !== "reason"); if (stray) return { ok: false, reason: `${stray} is not a field of this request` };
  const d = checkDate(payload.yearEnd, "yearEnd"); if (!d.ok) return d;
  if (payload.reason !== undefined && (typeof payload.reason !== "string" || payload.reason.length > 300)) return { ok: false, reason: "reason must be text of at most 300 characters" };
  return { ok: true, value: { yearEnd: d.value, reason: typeof payload.reason === "string" && payload.reason.trim() ? payload.reason.trim() : null } };
}
export function checkReopenInput(payload: unknown): Checked<ReopenInput> {
  if (!obj(payload)) return { ok: false, reason: "the request must be an object" };
  const stray = Object.keys(payload).find((k) => k !== "yearEnd" && k !== "reason"); if (stray) return { ok: false, reason: `${stray} is not a field of this request` };
  const d = checkDate(payload.yearEnd, "yearEnd"); if (!d.ok) return d;
  if (typeof payload.reason !== "string" || payload.reason.trim().length < 5 || payload.reason.length > 300) return { ok: false, reason: "reopening a closed year needs a reason of 5 to 300 characters" };
  return { ok: true, value: { yearEnd: d.value, reason: payload.reason.trim() } };
}

export interface ClosePlan { start: string; end: string; profitMinor: number; lines: Array<{ accountId: number; debitMinor: number; creditMinor: number }>; lockBefore: string | null }
const today = () => new Date().toISOString().slice(0, 10);

export async function planClose(env: Env, input: CloseInput): Promise<ClosePlan> {
  const { month } = await yearEndMonth(env);
  const fy = financialYearOf(input.yearEnd, month);
  if (fy.end !== input.yearEnd) throw new EngineError("invalid_input", `${input.yearEnd} is not the last day of a financial year: the year ends on the last day of ${MONTH_NAMES[month - 1]}, so ${fy.end} is the year-end nearest.`);
  if (!(input.yearEnd < today())) throw new EngineError("invalid_state", `The year ending ${input.yearEnd} has not ended yet, so it cannot be closed.`);
  const closed = await closedYears(env), last = closed[closed.length - 1];
  if (closed.some((y) => y.end === input.yearEnd)) throw new EngineError("invalid_state", `The year ending ${input.yearEnd} is already closed.`);
  if (last) {
    if (fy.start !== dayAfter(last.end)) throw new EngineError("invalid_state", `Years are closed in order: the next to close is the one ending ${financialYearOf(dayAfter(last.end), month).end}.`);
  } else {
    const earlier = await one<{ d: string | null }>(env, "SELECT MIN(je.entry_date) AS d FROM eng_journal_entry je WHERE je.entry_date < ? AND NOT " + CLOSING_ENTRY, fy.start);
    if (earlier?.d) throw new EngineError("invalid_state", `There are entries before that year (the earliest is ${earlier.d}): close the year ending ${financialYearOf(earlier.d, month).end} first.`);
  }
  const report = await verifyIntegrity(env);
  if (report.problems.length > 0) throw new EngineError("invalid_state", `The books have ${report.problems.length} integrity problem(s) (the first: ${report.problems[0].detail}), so the year is not closed: fix them first.`);
  if (report.warnings.some((w) => w.code === "unposted_foreign_currency")) throw new EngineError("invalid_state", "Something in another currency is not in the books yet, so the year cannot be closed: it would not be complete.");
  const rows = await many<{ id: number; net: number }>(env, "SELECT a.id, SUM(l.debit_minor - l.credit_minor) AS net FROM eng_journal_line l JOIN eng_journal_entry je ON je.id = l.entry_id JOIN eng_account a ON a.id = l.account_id WHERE a.type IN ('income', 'cost_of_sales', 'expense') AND je.entry_date >= ? AND je.entry_date <= ? AND NOT " + CLOSING_ENTRY + " GROUP BY a.id HAVING net <> 0 ORDER BY a.id", fy.start, fy.end);
  const lines = rows.map((r) => Number(r.net) > 0 ? { accountId: Number(r.id), debitMinor: 0, creditMinor: Number(r.net) } : { accountId: Number(r.id), debitMinor: -Number(r.net), creditMinor: 0 });
  const profit = -rows.reduce((s, r) => s + Number(r.net), 0);
  if (lines.length > 0) {
    const retained = await accountForRole(env, "retained_earnings");
    if (!retained) throw new EngineError("ledger_unmapped", "There is no retained earnings account to close the year into.");
    lines.push(profit >= 0 ? { accountId: retained.id, debitMinor: 0, creditMinor: profit } : { accountId: retained.id, debitMinor: -profit, creditMinor: 0 });
  }
  const lockRow = await one<{ payload_json: string }>(env, "SELECT payload_json FROM eng_event WHERE type = 'books_lock.set' ORDER BY id DESC LIMIT 1");
  let lockBefore: string | null = null; try { const d = lockRow ? (JSON.parse(lockRow.payload_json) as { lockDate?: unknown }).lockDate : null; lockBefore = typeof d === "string" ? d : null; } catch { /* none */ }
  return { start: fy.start, end: fy.end, profitMinor: profit, lines, lockBefore };
}

export interface ReopenPlan { closedEventId: number; start: string; end: string; entryWritten: boolean; previousEnd: string | null; originalEntryId: number | null; lines: Array<{ accountId: number; debitMinor: number; creditMinor: number }> }
export async function planReopen(env: Env, input: ReopenInput): Promise<ReopenPlan> {
  const closed = await closedYears(env), idx = closed.findIndex((y) => y.end === input.yearEnd);
  if (idx < 0) throw new EngineError("invalid_state", `The year ending ${input.yearEnd} is not closed.`);
  if (idx !== closed.length - 1) throw new EngineError("invalid_state", `A later year (ending ${closed[closed.length - 1].end}) is closed: reopen that one first.`);
  const y = closed[idx];
  const orig = y.entryWritten ? await one<{ id: number }>(env, "SELECT id FROM eng_journal_entry WHERE source_kind = 'manual' AND source_id = ? AND reverses_entry_id IS NULL", y.closedEventId) : null;
  const lines = orig ? (await many<{ account_id: number; debit_minor: number; credit_minor: number }>(env, "SELECT account_id, debit_minor, credit_minor FROM eng_journal_line WHERE entry_id = ? ORDER BY line_no", orig.id)).map((l) => ({ accountId: Number(l.account_id), debitMinor: Number(l.credit_minor), creditMinor: Number(l.debit_minor) })) : [];
  if (y.entryWritten && !orig) throw new EngineError("invalid_state", "The closing entry of that year cannot be found.");
  return { closedEventId: y.closedEventId, start: y.start, end: y.end, entryWritten: y.entryWritten, previousEnd: idx > 0 ? closed[idx - 1].end : null, originalEntryId: orig ? Number(orig.id) : null, lines };
}
