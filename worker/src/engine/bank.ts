// BANK STATEMENTS (docs/decisions/bank-reconciliation.md, G5a): bringing in what the bank says. RULES, PARSING and the integrity check live here; the INSERTS live in facts.ts (the one write path).
// A statement is facts: lines are inserted once and never edited. Importing the same statement twice changes nothing (a line already there is skipped). Whole cents only; no floating point. The engine
// parses the file: a model never supplies an amount or a date. Nothing here touches the ledger: matching a line to a payment is G5b.
import type { Env } from "../types";
import { EngineError } from "./errors";
import { checkDate } from "./quotations";

type Checked<T> = { ok: true; value: T } | { ok: false; reason: string };
const one = <T>(env: Env, sql: string, ...binds: unknown[]) => env.OFFICE_DB.prepare(sql).bind(...binds).first<T>();
const many = async <T>(env: Env, sql: string, ...binds: unknown[]): Promise<T[]> => ((await env.OFFICE_DB.prepare(sql).bind(...binds).all<T>()).results ?? []);

export const MAX_STATEMENT_LINES = 500;
export interface StatementLine { date: string; description: string; amountMinor: number; balanceMinor: number | null }
export interface StatementInput { periodFrom: string; periodTo: string; openingMinor: number; closingMinor: number; sourceName: string | null; lines: StatementLine[] }

const SAFE = Number.MAX_SAFE_INTEGER;
const wholeCents = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && Math.abs(v) <= SAFE;

// "1 234,50", "1,234.50", "(120.00)", "-R 45.10", "R45" to whole cents, or null when it is not an amount.
export function amountToMinor(raw: string): number | null {
  let s = raw.replace(/\s/g, "").replace(/R(?=\d|-|\()/gi, "");
  let negative = false;
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1); }
  if (/-$/.test(s)) { negative = !negative; s = s.slice(0, -1); }
  if (s.startsWith("-")) { negative = !negative; s = s.slice(1); } else if (s.startsWith("+")) s = s.slice(1);
  if (!s) return null;
  const lastDot = s.lastIndexOf("."), lastComma = s.lastIndexOf(",");
  if (lastDot >= 0 && lastComma >= 0) { const dec = lastDot > lastComma ? "." : ","; const th = dec === "." ? "," : "."; s = s.split(th).join("").replace(dec, "."); }
  else if (lastComma >= 0) s = /,\d{1,2}$/.test(s) && s.indexOf(",") === lastComma ? s.replace(",", ".") : s.split(",").join("");
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [whole, frac = ""] = s.split(".");
  const minor = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  if (!Number.isSafeInteger(minor)) return null;
  return negative ? -minor : minor;
}

// 2026-11-03, 2026/11/03 or 03/11/2026 (day first, as South African banks write it) to YYYY-MM-DD, or null.
export function dateToIso(raw: string): string | null {
  const s = raw.trim();
  let m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(s);
  let y: string, mo: string, d: string;
  if (m) [, y, mo, d] = m; else { m = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/.exec(s); if (!m) return null; [, d, mo, y] = m; }
  const iso = `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
  return checkDate(iso, "date").ok ? iso : null;
}

function splitRow(line: string, delim: string): string[] {
  const out: string[] = []; let cur = "", quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else quoted = false; } else cur += ch; }
    else if (ch === '"') quoted = true;
    else if (ch === delim) { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

// A pasted or uploaded CSV: a header row naming a date column, a description column, and either one amount column (money out negative) or money in and money out columns; a balance column is optional.
export function parseStatementCsv(text: string): Checked<StatementLine[]> {
  const rows = text.replace(/^﻿/, "").split(/\r?\n/).filter((r) => r.trim().length > 0);
  if (rows.length < 2) return { ok: false, reason: "the statement needs a header row and at least one line" };
  const delim = (rows[0].match(/;/g) ?? []).length > (rows[0].match(/,/g) ?? []).length ? ";" : (rows[0].includes("\t") ? "\t" : ",");
  const head = splitRow(rows[0], delim).map((h) => h.toLowerCase());
  const find = (...names: string[]) => head.findIndex((h) => names.some((n) => h === n || h.startsWith(n)));
  const iDate = find("date"), iDesc = find("description", "details", "narrative", "reference", "transaction"), iAmt = find("amount"), iIn = find("credit", "money in", "deposit"), iOut = find("debit", "money out", "withdrawal"), iBal = find("balance");
  if (iDate < 0 || iDesc < 0 || (iAmt < 0 && (iIn < 0 || iOut < 0))) return { ok: false, reason: "the header row must name a date, a description and either an amount or money in and money out columns" };
  const lines: StatementLine[] = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = splitRow(rows[r], delim), at = `line ${r}`;
    const date = dateToIso(cells[iDate] ?? ""); if (!date) return { ok: false, reason: `${at}: "${cells[iDate] ?? ""}" is not a date I can read` };
    let amount: number | null;
    if (iAmt >= 0) amount = amountToMinor(cells[iAmt] ?? "");
    else { const i = (cells[iIn] ?? "").trim() === "" ? 0 : amountToMinor(cells[iIn]), o = (cells[iOut] ?? "").trim() === "" ? 0 : amountToMinor(cells[iOut]); amount = i === null || o === null ? null : Math.abs(i) - Math.abs(o); }
    if (amount === null) return { ok: false, reason: `${at}: the amount is not one I can read` };
    let balance: number | null = null;
    if (iBal >= 0 && (cells[iBal] ?? "").trim() !== "") { balance = amountToMinor(cells[iBal]); if (balance === null) return { ok: false, reason: `${at}: the balance is not one I can read` }; }
    lines.push({ date, description: cells[iDesc] ?? "", amountMinor: amount, balanceMinor: balance });
  }
  return { ok: true, value: lines };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function checkStatementInput(payload: unknown): Checked<StatementInput> {
  if (!isObj(payload)) return { ok: false, reason: "the request must be an object" };
  const allowed = ["periodFrom", "periodTo", "openingMinor", "closingMinor", "sourceName", "lines", "csv"];
  const stray = Object.keys(payload).find((k) => !allowed.includes(k)); if (stray) return { ok: false, reason: `${stray} is not a field of this request` };
  const from = checkDate(payload.periodFrom, "periodFrom"); if (!from.ok) return from;
  const to = checkDate(payload.periodTo, "periodTo"); if (!to.ok) return to;
  if (to.value < from.value) return { ok: false, reason: "periodTo is before periodFrom" };
  if (!wholeCents(payload.openingMinor) || !wholeCents(payload.closingMinor)) return { ok: false, reason: "openingMinor and closingMinor must be whole numbers of cents" };
  if (payload.sourceName !== undefined && (typeof payload.sourceName !== "string" || payload.sourceName.length > 200)) return { ok: false, reason: "sourceName must be text of at most 200 characters" };
  if ((payload.lines === undefined) === (payload.csv === undefined)) return { ok: false, reason: "give the statement either as lines or as csv text, not both and not neither" };
  let lines: StatementLine[];
  if (payload.csv !== undefined) {
    if (typeof payload.csv !== "string" || payload.csv.length > 200_000) return { ok: false, reason: "csv must be text of at most 200000 characters" };
    const p = parseStatementCsv(payload.csv); if (!p.ok) return p;
    lines = p.value;
  } else {
    if (!Array.isArray(payload.lines)) return { ok: false, reason: "lines must be a list" };
    lines = [];
    for (const [i, raw] of payload.lines.entries()) {
      if (!isObj(raw)) return { ok: false, reason: `line ${i + 1} must be an object` };
      const d = checkDate(raw.date, `line ${i + 1} date`); if (!d.ok) return d;
      if (typeof raw.description !== "string") return { ok: false, reason: `line ${i + 1} needs a description` };
      if (!wholeCents(raw.amountMinor)) return { ok: false, reason: `line ${i + 1} amountMinor must be a whole number of cents` };
      if (raw.balanceMinor !== undefined && raw.balanceMinor !== null && !wholeCents(raw.balanceMinor)) return { ok: false, reason: `line ${i + 1} balanceMinor must be a whole number of cents` };
      lines.push({ date: d.value, description: raw.description, amountMinor: raw.amountMinor, balanceMinor: (raw.balanceMinor as number | null | undefined) ?? null });
    }
  }
  if (lines.length === 0) return { ok: false, reason: "the statement has no lines" };
  if (lines.length > MAX_STATEMENT_LINES) return { ok: false, reason: `a statement can bring in at most ${MAX_STATEMENT_LINES} lines at a time` };
  const clean: StatementLine[] = [];
  for (const [i, l] of lines.entries()) {
    const description = l.description.replace(/\s+/g, " ").trim();
    if (!description || description.length > 200) return { ok: false, reason: `line ${i + 1} needs a description of 1 to 200 characters` };
    if (l.amountMinor === 0) return { ok: false, reason: `line ${i + 1} has an amount of nothing` };
    if (l.date < from.value || l.date > to.value) return { ok: false, reason: `line ${i + 1} is dated ${l.date}, outside the statement period ${from.value} to ${to.value}` };
    clean.push({ ...l, description });
  }
  const total = clean.reduce((s, l) => s + l.amountMinor, 0);
  if (payload.openingMinor + total !== payload.closingMinor) return { ok: false, reason: `the opening balance plus the lines (${payload.openingMinor + total}) is not the closing balance (${payload.closingMinor}); in cents` };
  return { ok: true, value: { periodFrom: from.value, periodTo: to.value, openingMinor: payload.openingMinor, closingMinor: payload.closingMinor, sourceName: (payload.sourceName as string | undefined) ?? null, lines: clean } };
}

// The identity of a line: date, amount, description and which one it is among identical lines IN THE FILE (two real R50.00 fees on one day are two lines, not a duplicate).
export function fingerprints(lines: StatementLine[]): string[] {
  const seen = new Map<string, number>();
  return lines.map((l) => { const base = `${l.date}|${l.amountMinor}|${l.description.toLowerCase()}`; const n = (seen.get(base) ?? 0) + 1; seen.set(base, n); return `${base}|${n}`; });
}

export interface StatementPlan { fresh: Array<StatementLine & { fingerprint: string; lineNo: number }>; skipped: number; fileTotalMinor: number }
export async function planStatement(env: Env, input: StatementInput): Promise<StatementPlan> {
  const prints = fingerprints(input.lines);
  const fresh: StatementPlan["fresh"] = []; let skipped = 0;
  for (const [i, l] of input.lines.entries()) {
    const have = await one<{ id: number }>(env, "SELECT id FROM eng_bank_line WHERE fingerprint = ?", prints[i]);
    if (have) skipped += 1; else fresh.push({ ...l, fingerprint: prints[i], lineNo: i + 1 });
  }
  if (fresh.length === 0) throw new EngineError("invalid_state", `Every one of the ${input.lines.length} lines in this statement is already imported, so nothing was added.`);
  return { fresh, skipped, fileTotalMinor: input.lines.reduce((s, l) => s + l.amountMinor, 0) };
}

// Integrity: each statement's opening plus what its file said equals its closing; what is stored is what the event says was added; every line is in its period and has its event.
export async function verifyBank(env: Env, report: (code: string, detail: string) => void): Promise<void> {
  for (const s of await many<{ id: number; period_from: string; period_to: string; opening_minor: number; closing_minor: number; file_total_minor: number; file_line_count: number; skipped_count: number; event_id: number; n: number | null; t: number | null; bad: number | null }>(env,
    "SELECT s.*, (SELECT COUNT(*) FROM eng_bank_line l WHERE l.statement_id = s.id) AS n, (SELECT COALESCE(SUM(l.amount_minor), 0) FROM eng_bank_line l WHERE l.statement_id = s.id) AS t, (SELECT COUNT(*) FROM eng_bank_line l WHERE l.statement_id = s.id AND (l.line_date < s.period_from OR l.line_date > s.period_to OR l.event_id <> s.event_id)) AS bad FROM eng_bank_statement s ORDER BY s.id")) {
    if (Number(s.opening_minor) + Number(s.file_total_minor) !== Number(s.closing_minor)) report("bank_statement_inconsistent", `statement ${s.id}: opening ${s.opening_minor} plus the file's lines ${s.file_total_minor} is not the closing balance ${s.closing_minor}`);
    if (Number(s.n) + Number(s.skipped_count) !== Number(s.file_line_count)) report("bank_statement_inconsistent", `statement ${s.id}: ${s.n} lines stored and ${s.skipped_count} skipped is not the ${s.file_line_count} the file had`);
    if (Number(s.n) > 0 && Number(s.skipped_count) === 0 && Number(s.t) !== Number(s.file_total_minor)) report("bank_statement_inconsistent", `statement ${s.id}: the stored lines add up to ${s.t}, not the ${s.file_total_minor} the file had`);
    if (Number(s.bad) > 0) report("bank_statement_inconsistent", `statement ${s.id}: ${s.bad} line(s) are outside the period or belong to another event`);
  }
}
