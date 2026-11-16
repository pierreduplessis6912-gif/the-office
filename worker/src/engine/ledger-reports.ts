// The general ledger's READS (docs/decisions/general-ledger.md, increment G4): trial balance, an account's ledger, profit and loss, balance sheet, the suspense report and the reconciliation of control accounts to their sub-ledgers. Nothing
// here writes anything. Every figure is a sum of journal lines in whole cents, so a report can always be traced to the entries, and each entry to the fact that caused it.
import type { Env } from "../types";
import { allBills } from "./bills";
import { accountForRole, type AccountType } from "./journal";
import { outstandingForParty, unappliedCreditForParty } from "./ledger";
import { valuationAsAt } from "./stock";

const one = <T>(env: Env, sql: string, ...binds: unknown[]) => env.OFFICE_DB.prepare(sql).bind(...binds).first<T>();
const many = async <T>(env: Env, sql: string, ...binds: unknown[]): Promise<T[]> => ((await env.OFFICE_DB.prepare(sql).bind(...binds).all<T>()).results ?? []);

export interface Balance { code: string; name: string; type: AccountType; debitMinor: number; creditMinor: number }
// Debits and credits per account for entries dated within [from, to] (either may be omitted).
async function sums(env: Env, from: string | null, to: string | null): Promise<Balance[]> {
  const rows = await many<{ code: string; name: string; type: AccountType; d: number; c: number }>(env,
    "SELECT a.code, a.name, a.type, COALESCE(SUM(l.debit_minor), 0) AS d, COALESCE(SUM(l.credit_minor), 0) AS c FROM eng_account a LEFT JOIN (SELECT jl.account_id, jl.debit_minor, jl.credit_minor FROM eng_journal_line jl JOIN eng_journal_entry je ON je.id = jl.entry_id WHERE (? IS NULL OR je.entry_date >= ?) AND (? IS NULL OR je.entry_date <= ?)) l ON l.account_id = a.id GROUP BY a.id ORDER BY a.code",
    from, from, to, to);
  return rows.map((r) => ({ code: r.code, name: r.name, type: r.type, debitMinor: Number(r.d), creditMinor: Number(r.c) }));
}

// Every account with its debits and credits to a date, and whether the books agree with themselves (the two totals).
export async function trialBalanceAsAt(env: Env, asOf: string | null) {
  const rows = (await sums(env, null, asOf)).filter((r) => r.debitMinor !== 0 || r.creditMinor !== 0);
  const totalDebitMinor = rows.reduce((s, r) => s + r.debitMinor, 0), totalCreditMinor = rows.reduce((s, r) => s + r.creditMinor, 0);
  return { asOf, rows: rows.map((r) => ({ ...r, balanceMinor: r.debitMinor - r.creditMinor })), totalDebitMinor, totalCreditMinor, balanced: totalDebitMinor === totalCreditMinor };
}

// One account's lines in date order with a running balance (debits less credits), starting from what it stood at before `from`.
export async function accountLedger(env: Env, code: string, from: string | null, to: string | null) {
  const acct = await one<{ id: number; code: string; name: string; type: AccountType }>(env, "SELECT id, code, name, type FROM eng_account WHERE code = ?", code);
  if (!acct) return null;
  const opening = from === null ? 0 : Number((await one<{ b: number | null }>(env, "SELECT COALESCE(SUM(l.debit_minor - l.credit_minor), 0) AS b FROM eng_journal_line l JOIN eng_journal_entry e ON e.id = l.entry_id WHERE l.account_id = ? AND e.entry_date < ?", acct.id, from))?.b ?? 0);
  const lines = await many<{ entry_id: number; entry_date: string; memo: string | null; source_kind: string; source_id: number; reverses_entry_id: number | null; debit_minor: number; credit_minor: number }>(env,
    "SELECT e.id AS entry_id, e.entry_date, e.memo, e.source_kind, e.source_id, e.reverses_entry_id, l.debit_minor, l.credit_minor FROM eng_journal_line l JOIN eng_journal_entry e ON e.id = l.entry_id WHERE l.account_id = ? AND (? IS NULL OR e.entry_date >= ?) AND (? IS NULL OR e.entry_date <= ?) ORDER BY e.entry_date, e.id, l.line_no",
    acct.id, from, from, to, to);
  let running = opening;
  const out = lines.map((l) => { running += Number(l.debit_minor) - Number(l.credit_minor); return { entryId: Number(l.entry_id), date: l.entry_date, memo: l.memo, source: { kind: l.source_kind, id: Number(l.source_id) }, reversal: l.reverses_entry_id !== null, debitMinor: Number(l.debit_minor), creditMinor: Number(l.credit_minor), runningMinor: running }; });
  return { account: { code: acct.code, name: acct.name, type: acct.type }, from, to, openingMinor: opening, lines: out, closingMinor: running };
}

// Profit and loss for a period: income less cost of sales is the gross profit; less expenses is the profit. Income is shown as a positive amount (credits less debits), costs likewise (debits less credits).
export async function profitAndLoss(env: Env, from: string, to: string) {
  const rows = await sums(env, from, to);
  const pick = (type: AccountType, sign: 1 | -1) => rows.filter((r) => r.type === type && (r.debitMinor !== 0 || r.creditMinor !== 0)).map((r) => ({ code: r.code, name: r.name, amountMinor: sign * (r.debitMinor - r.creditMinor) }));
  const income = pick("income", -1), costOfSales = pick("cost_of_sales", 1), expenses = pick("expense", 1);
  const sum = (l: Array<{ amountMinor: number }>) => l.reduce((s, r) => s + r.amountMinor, 0);
  const incomeMinor = sum(income), costOfSalesMinor = sum(costOfSales), expensesMinor = sum(expenses);
  return { from, to, income, costOfSales, expenses, totals: { incomeMinor, costOfSalesMinor, grossProfitMinor: incomeMinor - costOfSalesMinor, expensesMinor, profitMinor: incomeMinor - costOfSalesMinor - expensesMinor } };
}

// Balance sheet at a date: assets, liabilities, equity, and the profit earned so far (the books are not closed off year by year yet, so all earnings to the date sit here). Assets equal liabilities plus equity plus earnings.
export async function balanceSheet(env: Env, asOf: string) {
  const rows = await sums(env, null, asOf);
  const live = rows.filter((r) => r.debitMinor !== 0 || r.creditMinor !== 0);
  const side = (type: AccountType, sign: 1 | -1) => live.filter((r) => r.type === type).map((r) => ({ code: r.code, name: r.name, amountMinor: sign * (r.debitMinor - r.creditMinor) }));
  const assets = side("asset", 1), liabilities = side("liability", -1), equity = side("equity", -1);
  const sum = (l: Array<{ amountMinor: number }>) => l.reduce((s, r) => s + r.amountMinor, 0);
  const earningsMinor = -live.filter((r) => r.type === "income" || r.type === "cost_of_sales" || r.type === "expense").reduce((s, r) => s + r.debitMinor - r.creditMinor, 0);
  const assetsMinor = sum(assets), liabilitiesMinor = sum(liabilities), equityMinor = sum(equity);
  return { asOf, assets, liabilities, equity, earningsMinor, totals: { assetsMinor, liabilitiesMinor, equityMinor, liabilitiesAndEquityMinor: liabilitiesMinor + equityMinor + earningsMinor }, balanced: assetsMinor === liabilitiesMinor + equityMinor + earningsMinor };
}

// What sits in SUSPENSE: things the engine could not place (stock received with no document behind it, until it is journalled to where it belongs). A balance here is a visible defect, never a hidden one.
export async function suspenseReport(env: Env) {
  const a = await accountForRole(env, "suspense");
  if (!a) return { balanceMinor: 0, lines: [] as unknown[] };
  const l = (await accountLedger(env, a.code, null, null))!;
  return { balanceMinor: l.closingMinor, lines: l.lines };
}

// The control accounts against what the sub-ledgers say. A difference is a finding, not an error to hide: it means the books and the records disagree, and it names by how much.
export async function reconciliation(env: Env) {
  const bal = async (role: string) => { const a = await accountForRole(env, role); if (!a) return 0; return Number((await one<{ b: number | null }>(env, "SELECT COALESCE(SUM(debit_minor - credit_minor), 0) AS b FROM eng_journal_line WHERE account_id = ?", a.id))?.b ?? 0); };
  let owed = 0;
  for (const p of await many<{ id: number }>(env, "SELECT id FROM eng_party ORDER BY id")) owed += (await outstandingForParty(env, Number(p.id))).totalMinor - (await unappliedCreditForParty(env, Number(p.id)));
  const billsOwed = (await allBills(env)).reduce((s, b) => s + (b.status === "voided" ? 0 : b.outstandingMinor), 0);
  const stockValue = (await valuationAsAt(env, "9999-12-31")).reduce((s, r) => s + r.valueMinor, 0);
  const lines = [
    { account: "receivables_control", label: "Accounts receivable against what customers owe", ledgerMinor: await bal("receivables_control"), recordsMinor: owed },
    { account: "payables_control", label: "Accounts payable against what supplier bills still owe", ledgerMinor: -(await bal("payables_control")), recordsMinor: billsOwed },
    { account: "inventory", label: "Inventory against the value of stock on hand", ledgerMinor: await bal("inventory"), recordsMinor: stockValue },
  ].map((l) => ({ ...l, differenceMinor: l.ledgerMinor - l.recordsMinor }));
  return { lines, agrees: lines.every((l) => l.differenceMinor === 0) };
}
