// The analysis layer (backend wrap-up point 2): "why did expenses change?" and "why did profit change?" answered from the SAME figures the profit and loss report uses, with the records behind them. Pinned in tools/analysis.test.js.
// THE RULES: (1) every number comes from the existing report (profitAndLossData); this module adds no second calculation of a business figure, only differences, shares and sums of those figures. (2) A finding is a FACT (read from a record) or
// CALCULATED (arithmetic on report figures); it is NEVER a cause: nothing here says why a change happened. (3) What it cannot know is listed in `notEstablished`, not guessed: expense records carry no supplier, so no supplier is ever named, and the cause
// of a change and whether it is one-off are not established. (4) Evidence records come through the same date filter as the report and carry a `reconciled` flag saying whether they add up to the report's own figure. (5) It is stateless and read-only, so
// the open report is never touched. (6) It is authorised exactly like the profit and loss (can_know_profit).
import { getExpenseEvidence, getInvoiceEvidence, type DateRange, type EvidenceSet } from "./finance";
import { change, parsePeriodParams, previousPeriod, profitAndLossData } from "./reports-data";
import type { Env } from "./types";

export type Topic = "expenses" | "profit";
type Range = { from: string; to: string };
type Change = { amount: number; percent: number | null };
type ReportData = Awaited<ReturnType<typeof profitAndLossData>>;
export type EvidenceSpec = { source: "expenses" | "invoices"; which: "current" | "compare"; category?: string; range: DateRange | null; limit: number };
export type EvidenceProvider = (spec: EvidenceSpec) => Promise<EvidenceSet & { source: string }>;

const EVIDENCE_PER_CONTRIBUTOR = 5, CONTRIBUTORS_WITH_EVIDENCE = 3, MAX_DESCRIPTION = 200;
const round2 = (value: number): number => Math.round(value * 100) / 100;
const cents = (value: number): number => Math.round(value * 100);
const rand = (value: number): string => { const [whole, rest] = Math.abs(value).toFixed(2).split("."); return `R${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${rest}`; };
const direction = (amount: number): "up" | "down" | "unchanged" => (amount > 0 ? "up" : amount < 0 ? "down" : "unchanged");
const percentText = (c: Change): string => (c.percent === null ? "" : ` (${Math.abs(c.percent)}%)`);

export type Finding = { statement: string; certainty: "fact" | "calculated"; basis: string[] };
export type Evidence = { source: string; which: "current" | "compare"; count: number; total: number; reconciled: boolean; truncated: boolean; records: Array<{ id: number; date: string; amount: number; description: string; customerId: number | null }> };

function shapeEvidence(set: EvidenceSet & { source: string }, which: "current" | "compare", figure: number): Evidence {
  return { source: set.source, which, count: set.count, total: round2(set.total), reconciled: cents(set.total) === cents(figure), truncated: set.count > set.records.length, records: set.records.map((r) => ({ id: r.id, date: r.date, amount: r.amount, description: String(r.description).slice(0, MAX_DESCRIPTION), customerId: r.customerId })) };
}
const reconciliationFinding = (name: string, evidence: Evidence, figure: number): Finding => ({ statement: `The records listed for ${name} do not add up to the report's figure (${rand(evidence.total)} against ${rand(figure)}), so treat them as incomplete evidence.`, certainty: "calculated", basis: [`${evidence.source}:${name}`] });
const quote = (text: string): string => text.replace(/"/g, "'");

export function parseAnalysisParams(search: URLSearchParams): { ok: true; topic: Topic; period: Range; compare: Range } | { ok: false; error: string } {
  const topic = search.get("topic");
  if (topic !== "expenses" && topic !== "profit") return { ok: false, error: "topic must be exactly expenses or profit." };
  const parsed = parsePeriodParams(search);
  if (!parsed.ok) return parsed;
  if (parsed.period === null) return { ok: false, error: "An analysis needs a period (from and to, YYYY-MM-DD)." };
  if (search.get("compare") === "none") return { ok: false, error: "An analysis needs a comparison: leave it out for the previous period, or give compare_from and compare_to." };
  return { ok: true, topic, period: parsed.period, compare: parsed.compare ?? previousPeriod(parsed.period.from, parsed.period.to) };
}

// ---- why expenses changed ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
async function expensesAnalysis(data: ReportData & { compare: NonNullable<ReportData["compare"]> }, evidence: EvidenceProvider) {
  const now = data.figures.categoryBreakdown, before = data.compare.figures.categoryBreakdown;
  const sum = (breakdown: Record<string, number>): number => round2(Object.values(breakdown).reduce((total, value) => total + value, 0));
  const current = sum(now), previous = sum(before), total = change(current, previous), way = direction(total.amount);
  const rank = { driver: 0, offset: 1, none: 2 } as const;
  const contributors = Object.entries(data.compare.categoryChange).map(([name, c]) => {
    const part = c.amount === 0 ? "none" : way !== "unchanged" && Math.sign(c.amount) === (way === "up" ? 1 : -1) ? "driver" : "offset";
    const flags: string[] = [];
    const cur = now[name] ?? 0, prev = before[name] ?? 0;
    if (prev === 0 && cur > 0) flags.push("new_in_period");
    if (cur === 0 && prev > 0) flags.push("absent_in_period");
    return { name, kind: "category" as const, current: cur, previous: prev, change: c, shareOfChange: total.amount === 0 ? null : round2((c.amount / total.amount) * 100), part: part as "driver" | "offset" | "none", flags, evidence: null as Evidence | null };
  }).sort((a, b) => rank[a.part] - rank[b.part] || Math.abs(b.change.amount) - Math.abs(a.change.amount) || a.name.localeCompare(b.name));

  const which = way === "down" ? "compare" : "current";   // when expenses fell, the drivers are what was there BEFORE
  const findings: Finding[] = [];
  findings.push(way === "unchanged"
    ? { statement: `There is no net change in total expenses between the two periods (${rand(current)} in each).`, certainty: "calculated", basis: ["profit_and_loss.figures.categoryBreakdown"] }
    : { statement: `Total expenses ${way === "up" ? "rose" : "fell"} by ${rand(total.amount)}${percentText(total)}, from ${rand(previous)} to ${rand(current)}.${total.percent === null ? " There is no percentage because the comparison period has no recorded expenses." : ""}`, certainty: "calculated", basis: ["profit_and_loss.figures.categoryBreakdown", "profit_and_loss.compare.figures.categoryBreakdown"] });

  for (const c of contributors.filter((x) => x.part === "driver").slice(0, CONTRIBUTORS_WITH_EVIDENCE)) {
    const figure = which === "current" ? c.current : c.previous;
    const set = await evidence({ source: "expenses", which, category: c.name, range: which === "current" ? data.period : data.compare.period, limit: EVIDENCE_PER_CONTRIBUTOR });
    c.evidence = shapeEvidence(set, which, figure);
    findings.push({ statement: `${c.name} accounts for ${rand(c.change.amount)} of the change${c.shareOfChange === null ? "" : ` (${c.shareOfChange}% of it)`}.`, certainty: "calculated", basis: [`profit_and_loss.compare.categoryChange.${c.name}`] });
    const top = c.evidence.records[0];
    if (top) findings.push({ statement: `The largest ${c.name} record ${which === "current" ? "in the period" : "in the comparison period"} is ${rand(top.amount)} on ${top.date}: "${quote(top.description)}".`, certainty: "fact", basis: [`expenses:${top.id}`] });
    if (!c.evidence.reconciled) findings.push(reconciliationFinding(c.name, c.evidence, figure));
  }
  for (const c of contributors) {
    if (c.flags.includes("new_in_period")) findings.push({ statement: `${c.name} had no recorded expenses in the comparison period.`, certainty: "calculated", basis: [`profit_and_loss.compare.categoryChange.${c.name}`] });
    if (c.flags.includes("absent_in_period")) findings.push({ statement: `${c.name} has no recorded expenses in this period.`, certainty: "calculated", basis: [`profit_and_loss.compare.categoryChange.${c.name}`] });
  }
  return {
    analysis: "expenses" as const, version: 1 as const, certainty: "calculated" as const, currency: "ZAR", period: data.period, compare: data.compare.period, basis: data.basis,
    summary: { metric: "total_expenses", current, previous, change: total, direction: way },
    contributors, findings,
    notEstablished: ["cause_of_the_change", "recurring_or_one_off", "supplier", "business_date"],
    limits: { evidenceRecordsPerContributor: EVIDENCE_PER_CONTRIBUTOR, contributorsWithEvidence: CONTRIBUTORS_WITH_EVIDENCE },
  };
}

// ---- why profit changed ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
async function profitAnalysis(data: ReportData & { compare: NonNullable<ReportData["compare"]> }, evidence: EvidenceProvider) {
  const c = data.compare.change, net = c.netProfit, way = direction(net.amount);
  const parts = [
    { name: "revenue", kind: "revenue" as const, label: "Revenue", current: data.figures.revenue, previous: data.compare.figures.revenue, change: c.revenue, effectOnProfit: round2(c.revenue.amount) },
    { name: "cost of sales", kind: "cost_of_sales" as const, label: "Cost of sales", current: data.figures.costOfSales, previous: data.compare.figures.costOfSales, change: c.costOfSales, effectOnProfit: round2(-c.costOfSales.amount) },
    { name: "operating expenses", kind: "operating_expenses" as const, label: "Operating expenses", current: data.figures.operatingExpenses, previous: data.compare.figures.operatingExpenses, change: c.operatingExpenses, effectOnProfit: round2(-c.operatingExpenses.amount) },
  ];
  const reconciles = cents(parts.reduce((total, p) => total + p.effectOnProfit, 0)) === cents(net.amount);
  const contributors = parts.map((p) => {
    const part = p.effectOnProfit === 0 ? "none" : way !== "unchanged" && Math.sign(p.effectOnProfit) === (way === "up" ? 1 : -1) ? "driver" : "offset";
    return { ...p, part: part as "driver" | "offset" | "none", shareOfChange: net.amount === 0 ? null : round2((p.effectOnProfit / net.amount) * 100), flags: [] as string[], evidence: null as Evidence | null, ...(p.kind !== "revenue" && p.change.amount !== 0 ? { drillDown: { topic: "expenses" as const } } : {}) };
  });
  const findings: Finding[] = [];
  findings.push(way === "unchanged"
    ? { statement: `There is no net change in net profit between the two periods (${rand(data.figures.netProfit)} in each).`, certainty: "calculated", basis: ["profit_and_loss.figures.netProfit"] }
    : { statement: `Net profit ${way === "up" ? "rose" : "fell"} by ${rand(net.amount)}${percentText(net)}, from ${rand(data.compare.figures.netProfit)} to ${rand(data.figures.netProfit)}.${net.percent === null ? " There is no percentage because the comparison period's net profit is zero." : ""}`, certainty: "calculated", basis: ["profit_and_loss.figures.netProfit", "profit_and_loss.compare.figures.netProfit"] });
  if (!reconciles) findings.push({ statement: `The report's figures do not add up: revenue, cost of sales and operating expenses account for ${rand(parts.reduce((t, p) => t + p.effectOnProfit, 0))} of the change but net profit changed by ${rand(net.amount)}, so this breakdown cannot be relied on.`, certainty: "calculated", basis: ["profit_and_loss.compare.change"] });
  for (const p of contributors) {
    if (p.change.amount === 0) continue;
    findings.push({ statement: `${p.label} ${p.change.amount > 0 ? "rose" : "fell"} by ${rand(p.change.amount)}, which ${p.effectOnProfit > 0 ? "raises" : "lowers"} profit by ${rand(p.effectOnProfit)}.`, certainty: "calculated", basis: [`profit_and_loss.compare.change.${p.kind === "revenue" ? "revenue" : p.kind === "cost_of_sales" ? "costOfSales" : "operatingExpenses"}`] });
  }
  const revenue = contributors.find((p) => p.kind === "revenue");
  if (revenue && revenue.part === "driver") {
    const which = way === "down" ? "compare" : "current";
    const set = await evidence({ source: "invoices", which, range: which === "current" ? data.period : data.compare.period, limit: EVIDENCE_PER_CONTRIBUTOR });
    revenue.evidence = shapeEvidence(set, which, which === "current" ? revenue.current : revenue.previous);
    if (!revenue.evidence.reconciled) findings.push(reconciliationFinding("revenue", revenue.evidence, which === "current" ? revenue.current : revenue.previous));
  }
  return {
    analysis: "profit" as const, version: 1 as const, certainty: "calculated" as const, currency: "ZAR", period: data.period, compare: data.compare.period, basis: data.basis,
    summary: { metric: "net_profit", current: data.figures.netProfit, previous: data.compare.figures.netProfit, change: net, direction: way, reconciles },
    contributors, findings,
    notEstablished: ["cause_of_the_change", "recurring_or_one_off", "business_date", "cash_received"],
    limits: { evidenceRecordsPerContributor: EVIDENCE_PER_CONTRIBUTOR, contributorsWithEvidence: CONTRIBUTORS_WITH_EVIDENCE },
  };
}

// The pure part: builds an analysis from report data and an evidence provider. A report with no comparison gives null (nothing to analyse, never a guess); an unsupported topic is refused.
export async function buildAnalysis(topic: string, data: ReportData, evidence: EvidenceProvider) {
  if (topic !== "expenses" && topic !== "profit") throw new Error("unsupported analysis topic");
  if (!data.compare) return null;
  const withCompare = data as ReportData & { compare: NonNullable<ReportData["compare"]> };
  return topic === "expenses" ? expensesAnalysis(withCompare, evidence) : profitAnalysis(withCompare, evidence);
}

// Against the database: the report's own figures, and evidence read through the report's own date filter.
export async function analysisData(env: Env, topic: Topic, params: { period: Range | null; compare: Range | null }) {
  if (!params.compare) return null;
  const data = await profitAndLossData(env, params);
  return buildAnalysis(topic, data, async (spec) => {
    const range = spec.range ?? undefined;
    const set = spec.source === "expenses" ? await getExpenseEvidence(env, range, spec.category ?? "other", spec.limit) : await getInvoiceEvidence(env, range, spec.limit);
    return { ...set, source: spec.source };
  });
}
