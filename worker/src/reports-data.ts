// Reports as data: profit and loss, aged debtors and aged creditors as JSON, so a workspace can show them and update them in place (a period, a comparison, a re-sort) without a PDF. Pinned in tools/reports-data.test.js.
// THE RULES: (1) the figures are EXACTLY the ones the PDFs use: this module contains no SQL and no calculation of its own beyond rounding, a comparison and sums; it calls the same finance functions the PDFs call. (2) Every report states its basis, its
// currency and that its figures are calculated, including the existing caveat that periods are by the date a record was ENTERED, not a business date. (3) The routes are authorised exactly like their PDFs (auth.ts). (4) It only reads.
import { getAgedCreditorsReport, getAgedDebtorsReport, getCustomerReceivables, getProfitAndLoss, type DateRange } from "./finance";
import type { Env } from "./types";

const DAY_MS = 86_400_000;
const round2 = (value: number): number => Math.round(value * 100) / 100;

// ---- the period -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
function isRealDate(value: string | null): value is string {
  if (value === null || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}
const shift = (date: string, days: number): string => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
const daysIn = (from: string, to: string): number => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;

// The period of the SAME LENGTH that ends the day before this one starts (30 days from 1 September is 2 to 31 August).
export function previousPeriod(from: string, to: string): { from: string; to: string } {
  const end = shift(from, -1);
  return { from: shift(end, -(daysIn(from, to) - 1)), to: end };
}

export type PeriodParams = { ok: true; period: { from: string; to: string } | null; compare: { from: string; to: string } | null } | { ok: false; error: string };

// A period is BOTH a from and a to date, each a real calendar date written YYYY-MM-DD, the start not after the end. A comparison is `compare=previous` or an explicit compare_from and compare_to, and needs a period. Anything else is refused with a short message.
export function parsePeriodParams(search: URLSearchParams): PeriodParams {
  const from = search.get("from"), to = search.get("to");
  let period: { from: string; to: string } | null = null;
  if (from !== null || to !== null) {
    if (from === null || to === null) return { ok: false, error: "Give both a from and a to date (YYYY-MM-DD), or neither." };
    if (!isRealDate(from) || !isRealDate(to)) return { ok: false, error: "Dates must be real calendar dates written YYYY-MM-DD." };
    if (from > to) return { ok: false, error: "The start date must not be after the end date." };
    period = { from, to };
  }
  const mode = search.get("compare"), compareFrom = search.get("compare_from"), compareTo = search.get("compare_to");
  if (mode !== null && mode !== "none" && mode !== "previous") return { ok: false, error: "compare must be previous or none." };
  const explicit = compareFrom !== null || compareTo !== null;
  if (mode === "previous" && explicit) return { ok: false, error: "Use compare=previous or explicit comparison dates, not both." };
  if (mode === "previous" || explicit) {
    if (period === null) return { ok: false, error: "A comparison needs a period (from and to)." };
    if (mode === "previous") return { ok: true, period, compare: previousPeriod(period.from, period.to) };
    if (compareFrom === null || compareTo === null) return { ok: false, error: "Give both compare_from and compare_to, or neither." };
    if (!isRealDate(compareFrom) || !isRealDate(compareTo)) return { ok: false, error: "Comparison dates must be real calendar dates written YYYY-MM-DD." };
    if (compareFrom > compareTo) return { ok: false, error: "The comparison start date must not be after its end date." };
    return { ok: true, period, compare: { from: compareFrom, to: compareTo } };
  }
  return { ok: true, period, compare: null };
}

// The change from the previous figure: the amount and the percent of the previous figure's size. With nothing before it the percent is null (not infinity, not zero).
export function change(current: number, previous: number): { amount: number; percent: number | null } {
  return { amount: round2(current - previous), percent: previous === 0 ? null : round2(((current - previous) / Math.abs(previous)) * 100) };
}

// ---- profit and loss --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
const FIGURES = ["revenue", "costOfSales", "grossProfit", "operatingExpenses", "netProfit"] as const;
type Figures = Record<(typeof FIGURES)[number], number> & { categoryBreakdown: Record<string, number> };
const figuresOf = (report: Figures): Figures => ({
  revenue: round2(report.revenue), costOfSales: round2(report.costOfSales), grossProfit: round2(report.grossProfit), operatingExpenses: round2(report.operatingExpenses), netProfit: round2(report.netProfit),
  categoryBreakdown: Object.fromEntries(Object.entries(report.categoryBreakdown).map(([category, amount]) => [category, round2(amount)])),
});

export async function profitAndLossData(env: Env, params: { period: DateRange | null; compare: DateRange | null }) {
  const figures = figuresOf(await getProfitAndLoss(env, params.period ?? undefined));
  let compare: null | { period: DateRange; figures: Figures; change: Record<string, { amount: number; percent: number | null }>; categoryChange: Record<string, { amount: number; percent: number | null }> } = null;
  if (params.compare) {
    const before = figuresOf(await getProfitAndLoss(env, params.compare));
    const categories = new Set([...Object.keys(figures.categoryBreakdown), ...Object.keys(before.categoryBreakdown)]);
    compare = {
      period: params.compare,
      figures: before,
      change: Object.fromEntries(FIGURES.map((key) => [key, change(figures[key], before[key])])),
      categoryChange: Object.fromEntries([...categories].map((category) => [category, change(figures.categoryBreakdown[category] ?? 0, before.categoryBreakdown[category] ?? 0)])),
    };
  }
  return {
    report: "profit_and_loss", version: 1, certainty: "calculated", currency: "ZAR",
    basis: {
      revenue: "Accrual: real invoiced amounts, not cash received.",
      period: "Periods are by the date each record was entered into the system, not a separately recorded business date.",
      timezone: "Africa/Johannesburg (UTC+2); a period runs from the start of its first local day to the end of its last.",
    },
    period: params.period, figures, compare,
  };
}

// ---- aged debtors and creditors (as at the day they are run) ------------------------------------------------------------------------------------------------------------------------------------------------------------------
const roundRow = <T extends object>(row: T): T => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, typeof value === "number" && !/Id$/.test(key) ? round2(value) : value])) as T;
function agedReport(report: "aged_debtors" | "aged_creditors", rawRows: Array<Record<string, number | string>>, allocation: string, now: Date) {
  const rows = rawRows.map(roundRow);
  const sum = (key: string): number => round2(rows.reduce((total, row) => total + (row[key] as number), 0));
  return {
    report, version: 1, certainty: "calculated", currency: "ZAR", asAt: now.toISOString().slice(0, 10),
    basis: { aging: "Age counts from the date each record was entered into the system; buckets are current (up to 30 days), 30-60, 60-90 and 90+ days.", allocation },
    buckets: { current: sum("current"), days30: sum("days30"), days60: sum("days60"), days90Plus: sum("days90Plus"), total: sum("total") },
    count: rows.length, rows,
  };
}
export async function agedDebtorsData(env: Env, now: Date = new Date()) {
  return agedReport("aged_debtors", (await getAgedDebtorsReport(env)) as unknown as Array<Record<string, number | string>>, "Payments are applied to the oldest invoices first, not matched to specific invoices.", now);
}
// One customer's receivables, the drill-down from the aged debtors report (GET /reports/aged-debtors?customer=<id>): their OUTSTANDING invoices, oldest first, and how their payments were applied. Authorised exactly like the aged debtors report (same route). Amount, date and description are read from the invoice; `applied`, `outstanding`, `ageDays` and `bucket` are CALCULATED, because payments are recorded per customer and applied to the oldest invoices first, never matched to an invoice. The buckets are the SAME derivation as the report's row for this customer (one function), so they add up to it.
const RECEIVABLE_INVOICES_CAP = 100;
export function parseCustomerParam(raw: string | null): { ok: true; id: number } | { ok: false; error: string } {
  if (raw === null || !/^[1-9]\d{0,9}$/.test(raw)) return { ok: false, error: "customer must be a positive whole number." };
  return { ok: true, id: Number(raw) };
}
export async function customerReceivablesData(env: Env, customerId: number, now: Date = new Date()) {
  const found = await getCustomerReceivables(env, customerId, now.getTime());
  if (found === null) return null;
  const a = found.allocation;
  const invoices = a.invoices.slice(0, RECEIVABLE_INVOICES_CAP).map((i) => ({ id: i.id, date: i.date, description: i.description.slice(0, 200), amount: round2(i.amount), applied: round2(i.applied), outstanding: round2(i.outstanding), ageDays: i.ageDays, bucket: i.bucket }));
  const buckets = { current: round2(a.current), days30: round2(a.days30), days60: round2(a.days60), days90Plus: round2(a.days90Plus), total: round2(a.total) };
  return {
    report: "customer_receivables" as const, version: 1 as const, certainty: "calculated" as const, currency: "ZAR", asAt: now.toISOString().slice(0, 10),
    customer: { id: found.customer.id, name: found.customer.name },
    basis: { aging: "Age counts from the date each invoice was entered into the system; buckets are current (up to 30 days), 30-60, 60-90 and 90+ days.", allocation: "Payments are recorded per customer and applied to the oldest invoices first, so which invoice a payment settled is a calculation, not a record." },
    facts: ["id", "date", "description", "amount"], calculated: ["applied", "outstanding", "ageDays", "bucket"],
    buckets, payments: { total: round2(found.payments.total), count: found.payments.count }, unappliedPayments: round2(a.unapplied),
    invoiceCount: found.invoiceCount, outstandingCount: a.invoices.length, truncated: a.invoices.length > RECEIVABLE_INVOICES_CAP,
    reconciles: round2(a.invoices.reduce((t, i) => t + i.outstanding, 0)) === buckets.total,
    invoices,
    notEstablished: ["payment_to_invoice_match", "business_date"],
  };
}
export async function agedCreditorsData(env: Env, now: Date = new Date()) {
  return agedReport("aged_creditors", (await getAgedCreditorsReport(env)) as unknown as Array<Record<string, number | string>>, "Payments and credits are applied to the oldest expenses first, not matched to specific expenses.", now);
}
