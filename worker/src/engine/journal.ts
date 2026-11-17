// The GENERAL LEDGER (docs/decisions/general-ledger.md, increment G1: the selling side): the RULES (what each financial fact posts), the READS and the integrity check. Every financial fact the engine records also writes its
// balanced journal entry, in the SAME transaction, so a fact and its entry exist together or not at all; the INSERTS live in facts.ts (the one write path: this file never writes). Entries are only ever inserted: a mistake is a
// CONTRA entry that turns the original round, never an edit. The engine
// posts to ROLES (receivables control, sales, VAT output, bank, cash, ...); the business maps each role to an account (eng_account_role), so an account can be renamed or re-mapped without breaking a posting. The chart is DATA:
// CHART_TEMPLATE below, seeded on the business's first posting. Whole cents only; no floating point.
// What this file does NOT do yet (G2 and later): purchases, expenses, stock, periods, manual journals, foreign exchange. A fact in another currency than the ledger's is NOT posted and is REPORTED by the integrity verifier.
import type { Env } from "../types";
import { EngineError } from "./errors";
import { EXPENSE_CATEGORIES } from "./expenses";
import { readConfig } from "./config";
import { documentTotals } from "./ledger";
import { checkDate } from "./quotations";

const one = <T>(env: Env, sql: string, ...binds: unknown[]) => env.OFFICE_DB.prepare(sql).bind(...binds).first<T>();
const many = async <T>(env: Env, sql: string, ...binds: unknown[]): Promise<T[]> => ((await env.OFFICE_DB.prepare(sql).bind(...binds).all<T>()).results ?? []);

export type AccountType = "asset" | "liability" | "equity" | "income" | "cost_of_sales" | "expense";
export interface TemplateAccount { code: string; name: string; type: AccountType; roles: string[] }

const titled = (s: string) => s.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

// A small-business chart, as DATA. The roles are what the engine posts to; every role has exactly one account.
export const CHART_TEMPLATE: TemplateAccount[] = [
  { code: "1000", name: "Bank", type: "asset", roles: ["bank"] },
  { code: "1010", name: "Cash on hand", type: "asset", roles: ["cash"] },
  { code: "1100", name: "Accounts receivable", type: "asset", roles: ["receivables_control"] },
  { code: "1200", name: "Inventory", type: "asset", roles: ["inventory"] },
  { code: "1300", name: "VAT input", type: "asset", roles: ["vat_input"] },
  { code: "1900", name: "Suspense", type: "asset", roles: ["suspense"] },
  { code: "2000", name: "Accounts payable", type: "liability", roles: ["payables_control"] },
  { code: "2100", name: "VAT output", type: "liability", roles: ["vat_output"] },
  { code: "2200", name: "Goods received not invoiced", type: "liability", roles: ["goods_received_not_invoiced"] },
  { code: "3000", name: "Owner's equity", type: "equity", roles: [] },
  { code: "3100", name: "Retained earnings", type: "equity", roles: ["retained_earnings"] },
  { code: "4000", name: "Sales", type: "income", roles: ["sales"] },
  { code: "5000", name: "Cost of sales", type: "cost_of_sales", roles: ["cost_of_sales"] },
  { code: "5100", name: "Stock adjustments and write-downs", type: "cost_of_sales", roles: ["stock_adjustments"] },
  { code: "5200", name: "Purchase price variances", type: "cost_of_sales", roles: ["purchase_variance"] },
  { code: "6900", name: "Rounding", type: "expense", roles: ["rounding"] },
  ...EXPENSE_CATEGORIES.map((c, i): TemplateAccount => ({ code: `6${String(i + 1).padStart(3, "0")}`, name: titled(c), type: "expense", roles: [`expense:${c}`] })),
];

// The ledger's own currency (one per business to start). A fact in another currency is not posted.
export async function ledgerCurrency(env: Env): Promise<string> {
  const row = await one<{ value_json: string }>(env, "SELECT value_json FROM eng_config WHERE key = 'currency'");
  try { const v = row ? JSON.parse(row.value_json) : null; if (typeof v === "string" && /^[A-Z]{3}$/.test(v)) return v; } catch { /* the default stands */ }
  return "ZAR";
}

export interface AccountRef { id: number; code: string; name: string; type: AccountType }
export async function accountForRole(env: Env, role: string): Promise<AccountRef | null> {
  const row = await one<AccountRef>(env, "SELECT a.id, a.code, a.name, a.type FROM eng_account_role r JOIN eng_account a ON a.id = r.account_id WHERE r.role = ? ORDER BY r.id DESC LIMIT 1", role);
  return row ? { id: Number(row.id), code: row.code, name: row.name, type: row.type } : null;
}

export interface PostLine { role: string; accountId?: number; debitMinor?: number; creditMinor?: number }

// A line of nothing is never written; an entry with no lines (a fact worth nothing) is not written at all; the rest must be whole cents and must balance.
export function checkedLines(lines: PostLine[]): PostLine[] {
  const kept = lines.filter((l) => (l.debitMinor ?? 0) > 0 || (l.creditMinor ?? 0) > 0);
  let debit = 0, credit = 0;
  for (const l of kept) {
    for (const v of [l.debitMinor ?? 0, l.creditMinor ?? 0]) if (!Number.isSafeInteger(v) || v < 0) throw new EngineError("invalid_amount", "a ledger line must be a whole number of cents, never negative");
    debit += l.debitMinor ?? 0; credit += l.creditMinor ?? 0;
  }
  if (debit !== credit) throw new EngineError("ledger_unbalanced", `the entry does not balance (debits ${debit}, credits ${credit})`);
  return kept;
}

// The contra of a reversed fact: the original entry's lines turned round, or null when the fact wrote none (a credit note's non-cash movement, a fact in another currency, anything before the ledger started).
export async function planContra(env: Env, sourceKind: "document" | "movement" | "stock_move" | "manual", sourceId: number): Promise<{ originalId: number; lines: Array<{ accountId: number; debitMinor: number; creditMinor: number }> } | null> {
  const original = await one<{ id: number }>(env, "SELECT id FROM eng_journal_entry WHERE source_kind = ? AND source_id = ? AND reverses_entry_id IS NULL", sourceKind, sourceId);
  if (!original) return null;
  const lines = await many<{ account_id: number; debit_minor: number; credit_minor: number }>(env, "SELECT account_id, debit_minor, credit_minor FROM eng_journal_line WHERE entry_id = ? ORDER BY line_no", original.id);
  return { originalId: Number(original.id), lines: lines.map((l) => ({ accountId: Number(l.account_id), debitMinor: Number(l.credit_minor), creditMinor: Number(l.debit_minor) })) };
}

// ---- the posting rules (selling side) --------------------------------------------------------------------------------------------------------------------------------------------------------------------
export type DocumentPosting = "sale" | "credit" | "expense" | "bill" | null;
// Which way a document posts: a customer-owed kind (invoice, debit note) is a SALE, a credit-note kind turns one round; anything else (a quotation, an order) is not a financial event. A fact in another currency is not posted.
export async function documentPosting(env: Env, kind: string, direction: string, currency: string): Promise<DocumentPosting> {
  if (currency !== (await ledgerCurrency(env))) return null;
  if (direction === "buy") return kind === "expense" ? "expense" : kind === "supplier_invoice" ? "bill" : null;   // an order and a goods receipt are not financial events (what was received is in stock, G2b)
  if (direction !== "sell") return null;
  const cfg = await readConfig(env);
  if (cfg.receivableKinds.includes(kind)) return "sale";
  if (cfg.creditNoteKinds.includes(kind)) return "credit";
  return null;
}

export function documentLines(posting: "sale" | "credit", totals: { grossMinor: number; netMinor: number; taxMinor: number }): PostLine[] {
  const sale = posting === "sale";
  return [
    sale ? { role: "receivables_control", debitMinor: totals.grossMinor } : { role: "receivables_control", creditMinor: totals.grossMinor },
    sale ? { role: "sales", creditMinor: totals.netMinor } : { role: "sales", debitMinor: totals.netMinor },
    sale ? { role: "vat_output", creditMinor: totals.taxMinor } : { role: "vat_output", debitMinor: totals.taxMinor },
  ];
}

// A PURCHASE (an expense or a supplier's bill): Dr the category's expense account (the net, plus any VAT that cannot be claimed back), Dr VAT input (only the VAT that can), Cr payables control. An expense is paid at once, but its payment is its
// own money-out movement (Dr payables control, Cr bank), so the payable nets to nothing, and each fact is balanced and reversed by itself.
export function purchaseLines(category: string, totals: { grossMinor: number; netMinor: number; taxMinor: number }, claimable: boolean, grniMinor = 0): PostLine[] {
  return [
    { role: "goods_received_not_invoiced", debitMinor: grniMinor },   // goods already received into stock: the bill clears what receiving credited, instead of counting the cost a second time
    { role: `expense:${category}`, debitMinor: totals.netMinor - grniMinor + (claimable ? 0 : totals.taxMinor) },
    { role: "vat_input", debitMinor: claimable ? totals.taxMinor : 0 },
    { role: "payables_control", creditMinor: totals.grossMinor },
  ];
}
// What a bill for an ORDER may clear from "goods received not invoiced": the value stocked from that order's goods receipts (less any reversed), less what earlier bills for the same order have already cleared. Never negative.
export async function grniAvailable(env: Env, orderId: number): Promise<number> {
  const received = await one<{ v: number | null }>(env, "SELECT COALESCE(SUM(m.value_minor), 0) AS v FROM eng_stock_move m JOIN eng_document d ON d.id = m.source_document_id WHERE m.kind = 'receive' AND d.kind = 'goods_receipt' AND json_extract(d.terms_json, '$.orderId') = ? AND NOT EXISTS (SELECT 1 FROM eng_stock_move r WHERE r.reverses_move_id = m.id)", orderId);
  const cleared = await one<{ v: number | null }>(env, "SELECT COALESCE(SUM(l.debit_minor - l.credit_minor), 0) AS v FROM eng_journal_line l JOIN eng_journal_entry e ON e.id = l.entry_id JOIN eng_document d ON e.source_kind = 'document' AND e.source_id = d.id JOIN eng_account_role ar ON ar.account_id = l.account_id AND ar.role = 'goods_received_not_invoiced' WHERE d.kind = 'supplier_invoice' AND json_extract(d.terms_json, '$.orderId') = ?", orderId);
  return Math.max(0, Number(received?.v ?? 0) - Number(cleared?.v ?? 0));
}

// ---- the posting rules (stock). Every stock fact is ONE move, so the rule is by the move's kind. Value is the move's own stamped value (the engine's moving average cost), never recomputed.
// receive: Dr inventory, Cr goods received not invoiced (from a goods receipt); a receipt with no document behind it cannot be placed, so it goes to suspense, which a report lists.
// issue: Dr cost of sales, Cr inventory. A customer return puts the cost back. Any other adjustment, a count variance or a write-down goes through stock adjustments. A transfer posts nothing (the inventory total is unchanged).
export function stockMoveLines(kind: string, reason: string | null, hasSource: boolean, valueMinor: number): PostLine[] | null {
  switch (kind) {
    case "receive": return [{ role: "inventory", debitMinor: valueMinor }, { role: hasSource ? "goods_received_not_invoiced" : "suspense", creditMinor: valueMinor }];
    case "issue": return [{ role: "cost_of_sales", debitMinor: valueMinor }, { role: "inventory", creditMinor: valueMinor }];
    case "adjust_in": return [{ role: "inventory", debitMinor: valueMinor }, { role: reason === "customer return" ? "cost_of_sales" : "stock_adjustments", creditMinor: valueMinor }];
    case "adjust_out": return [{ role: "stock_adjustments", debitMinor: valueMinor }, { role: "inventory", creditMinor: valueMinor }];
    default: return null;   // transfer_in, transfer_out: nothing; reversal_in, reversal_out: a contra of the original's entry (facts.ts)
  }
}

// Money paid OUT to a supplier (or for an expense): Dr payables control, Cr bank or cash. (A refund to a customer is also money out, but it posts its own entry against receivables.)
export async function paymentOutPosts(env: Env, direction: string, currency: string): Promise<boolean> { return direction === "out" && currency === (await ledgerCurrency(env)); }
export const paymentOutLines = (method: string | null, amountMinor: number, bankAccountId?: number | null): PostLine[] => [{ role: "payables_control", debitMinor: amountMinor }, { role: method === "cash" ? "cash" : "bank", ...(method !== "cash" && bankAccountId ? { accountId: bankAccountId } : {}), creditMinor: amountMinor }];

// A payment RECEIVED from a customer. method "credit" is a credit note's non-cash movement and posts nothing (the credit note already did). Cash goes to the cash account; every other method (and none stated) to the bank.
export async function receiptPosts(env: Env, direction: string, method: string | null | undefined, currency: string): Promise<boolean> {
  return direction === "in" && method !== "credit" && currency === (await ledgerCurrency(env));
}
export const receiptLines = (method: string | null, amountMinor: number, bankAccountId?: number | null): PostLine[] => [{ role: method === "cash" ? "cash" : "bank", ...(method !== "cash" && bankAccountId ? { accountId: bankAccountId } : {}), debitMinor: amountMinor }, { role: "receivables_control", creditMinor: amountMinor }];
// Money paid BACK to a customer (a refund of leftover credit or of an overpayment).
export async function refundPosts(env: Env, currency: string): Promise<boolean> { return currency === (await ledgerCurrency(env)); }
export const refundLines = (method: string | null, amountMinor: number, bankAccountId?: number | null): PostLine[] => [{ role: "receivables_control", debitMinor: amountMinor }, { role: method === "cash" ? "cash" : "bank", ...(method !== "cash" && bankAccountId ? { accountId: bankAccountId } : {}), creditMinor: amountMinor }];

// ---- the books lock and manual journals (G3) ----------------------------------------------------------------------------------------------------------------------------------------------------------
// ONE date: nothing is posted on or before it. It is a recorded fact like any other (`books_lock.set`), it can be moved either way (moving it back is "unlocking", needs a reason and is itself approved and on the record), and the
// current one is the latest event. The tax lock (business.ts) stays separate: it protects VAT returns already filed.
export async function booksLockDate(env: Env): Promise<string | null> {
  const e = await one<{ payload_json: string }>(env, "SELECT payload_json FROM eng_event WHERE type = 'books_lock.set' ORDER BY id DESC LIMIT 1");
  if (!e) return null;
  try { const d = (JSON.parse(e.payload_json) as { lockDate?: unknown }).lockDate; return typeof d === "string" ? d : null; } catch { return null; }
}
export async function assertBooksOpen(env: Env, date: string): Promise<void> {
  const lock = await booksLockDate(env);
  if (lock !== null && date <= lock) throw new EngineError("period_locked", `The books are locked up to ${lock}, so nothing can be posted on ${date}. Use a date after ${lock}, or have the lock moved back first.`);
}

// Accounts the engine keeps from the facts themselves (what customers owe, what is owed to suppliers, stock, goods received not invoiced, VAT): a person cannot journal into them, because they would then disagree with their sub-ledger.
// The way to change one is to record the fact (an invoice, a bill, a stock count).
export const ENGINE_KEPT_ROLES = ["receivables_control", "payables_control", "inventory", "goods_received_not_invoiced", "vat_output", "vat_input"] as const;

export interface JournalLineInput { account: string; debitMinor?: number; creditMinor?: number }
export interface JournalInput { date: string; kind: "manual" | "opening"; reason: string; lines: JournalLineInput[] }
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const cents = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
export function checkJournalInput(v: unknown): { ok: true; value: JournalInput } | { ok: false; reason: string } {
  if (!isObj(v)) return { ok: false, reason: "the journal must be an object" };
  const bad = Object.keys(v).find((k) => !["date", "kind", "reason", "lines"].includes(k));
  if (bad) return { ok: false, reason: `${bad} is not a field of a journal` };
  const d = checkDate(v.date, "date"); if (!d.ok) return d;
  if (v.kind !== "manual" && v.kind !== "opening") return { ok: false, reason: 'kind must be "manual" or "opening"' };
  if (typeof v.reason !== "string" || v.reason.trim().length < 5 || v.reason.length > 300) return { ok: false, reason: "a journal needs a reason of 5 to 300 characters: why it is being made" };
  if (!Array.isArray(v.lines) || v.lines.length < 2 || v.lines.length > 50) return { ok: false, reason: "a journal needs between 2 and 50 lines" };
  const lines: JournalLineInput[] = [];
  for (const [i, l] of v.lines.entries()) {
    if (!isObj(l)) return { ok: false, reason: `line ${i + 1} must be an object` };
    const stray = Object.keys(l).find((k) => !["account", "debitMinor", "creditMinor"].includes(k));
    if (stray) return { ok: false, reason: `line ${i + 1}: ${stray} is not a field of a journal line` };
    if (typeof l.account !== "string" || !/^[0-9]{4}$/.test(l.account)) return { ok: false, reason: `line ${i + 1}: account must be an account code such as 6010` };
    const debit: unknown = l.debitMinor === undefined ? 0 : l.debitMinor, credit: unknown = l.creditMinor === undefined ? 0 : l.creditMinor;
    if (!cents(debit) || !cents(credit)) return { ok: false, reason: `line ${i + 1}: amounts must be whole cents, never negative` };
    if ((debit > 0) === (credit > 0)) return { ok: false, reason: `line ${i + 1}: a line is either a debit or a credit, never both and never neither` };
    lines.push({ account: l.account, ...(debit > 0 ? { debitMinor: debit } : { creditMinor: credit }) });
  }
  const dr = lines.reduce((s, l) => s + (l.debitMinor ?? 0), 0), cr = lines.reduce((s, l) => s + (l.creditMinor ?? 0), 0);
  if (dr !== cr) return { ok: false, reason: `the journal does not balance (debits ${dr}, credits ${cr})` };
  return { ok: true, value: { date: d.value, kind: v.kind, reason: v.reason.trim(), lines } };
}
// Everything that needs the database: the date is open, the accounts exist and are ones a person may journal into, and there is only one opening journal.
export async function planJournal(env: Env, input: JournalInput): Promise<Array<{ accountId: number; code: string; debitMinor: number; creditMinor: number }>> {
  await assertBooksOpen(env, input.date);
  const seeded = Boolean(await one(env, "SELECT 1 AS ok FROM eng_account LIMIT 1"));
  if (!seeded) {   // a business that has posted nothing yet (the chart is seeded on the first posting): judge the codes against the template, so a proposal can be checked before anything exists
    for (const l of input.lines) {
      const t = CHART_TEMPLATE.find((a) => a.code === l.account);
      if (!t) throw new EngineError("invalid_input", `There is no account ${l.account} in the chart.`);
      if (t.roles.some((r) => (ENGINE_KEPT_ROLES as readonly string[]).includes(r))) throw new EngineError("invalid_state", `${t.name} (${l.account}) is kept by the engine from invoices, bills and stock, so it cannot be journalled into. Record the invoice, bill or stock count that changes it.`);
    }
    return input.lines.map((l) => ({ accountId: 0, code: l.account, debitMinor: l.debitMinor ?? 0, creditMinor: l.creditMinor ?? 0 }));
  }
  const kept = new Set<number>();
  for (const r of ENGINE_KEPT_ROLES) { const a = await accountForRole(env, r); if (a) kept.add(a.id); }
  const out: Array<{ accountId: number; code: string; debitMinor: number; creditMinor: number }> = [];
  for (const l of input.lines) {
    const a = await one<{ id: number; name: string }>(env, "SELECT id, name FROM eng_account WHERE code = ?", l.account);
    if (!a) throw new EngineError("invalid_input", `There is no account ${l.account} in the chart.`);
    if (kept.has(Number(a.id))) throw new EngineError("invalid_state", `${a.name} (${l.account}) is kept by the engine from invoices, bills and stock, so it cannot be journalled into. Record the invoice, bill or stock count that changes it.`);
    out.push({ accountId: Number(a.id), code: l.account, debitMinor: l.debitMinor ?? 0, creditMinor: l.creditMinor ?? 0 });
  }
  if (input.kind === "opening") {
    const open = await one<{ id: number }>(env, "SELECT e.id FROM eng_event e WHERE e.type = 'journal.posted' AND json_extract(e.payload_json, '$.kind') = 'opening' AND NOT EXISTS (SELECT 1 FROM eng_event r WHERE r.type = 'journal.reversed' AND json_extract(r.payload_json, '$.journalEventId') = e.id) LIMIT 1");
    if (open) throw new EngineError("invalid_state", "The opening balances have already been posted. Reverse that journal first if they must be redone.");
  }
  return out;
}
export async function planJournalReversal(env: Env, input: { journalEventId: number; date: string }): Promise<{ originalId: number; lines: Array<{ accountId: number; debitMinor: number; creditMinor: number }> }> {
  const ev = await one<{ id: number }>(env, "SELECT id FROM eng_event WHERE id = ? AND type = 'journal.posted'", input.journalEventId);
  if (!ev) throw new EngineError("not_found", "There is no such journal.");
  if (await one(env, "SELECT 1 AS ok FROM eng_event WHERE type = 'journal.reversed' AND json_extract(payload_json, '$.journalEventId') = ?", input.journalEventId)) throw new EngineError("invalid_state", "That journal has already been reversed.");
  await assertBooksOpen(env, input.date);
  const plan = await planContra(env, "manual", input.journalEventId);
  if (!plan) throw new EngineError("invalid_state", "That journal wrote no entry.");
  return plan;
}

// ---- reads -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
export interface EntryLine { code: string; name: string; type: AccountType; debitMinor: number; creditMinor: number }
export interface EntryView { id: number; entryDate: string; memo: string | null; reversesEntryId: number | null; eventId: number; lines: EntryLine[] }
export async function entriesFor(env: Env, sourceKind: "document" | "movement", sourceId: number): Promise<EntryView[]> {
  const out: EntryView[] = [];
  for (const e of await many<{ id: number; entry_date: string; memo: string | null; reverses_entry_id: number | null; event_id: number }>(env, "SELECT id, entry_date, memo, reverses_entry_id, event_id FROM eng_journal_entry WHERE source_kind = ? AND source_id = ? ORDER BY id", sourceKind, sourceId)) {
    const lines = await many<{ code: string; name: string; type: AccountType; debit_minor: number; credit_minor: number }>(env, "SELECT a.code, a.name, a.type, l.debit_minor, l.credit_minor FROM eng_journal_line l JOIN eng_account a ON a.id = l.account_id WHERE l.entry_id = ? ORDER BY l.line_no", e.id);
    out.push({ id: Number(e.id), entryDate: e.entry_date, memo: e.memo, reversesEntryId: e.reverses_entry_id === null ? null : Number(e.reverses_entry_id), eventId: Number(e.event_id), lines: lines.map((l) => ({ code: l.code, name: l.name, type: l.type, debitMinor: Number(l.debit_minor), creditMinor: Number(l.credit_minor) })) });
  }
  return out;
}

export interface TrialBalanceRow { code: string; name: string; type: AccountType; debitMinor: number; creditMinor: number }
export async function trialBalance(env: Env): Promise<{ rows: TrialBalanceRow[]; totalDebitMinor: number; totalCreditMinor: number }> {
  const rows = (await many<{ code: string; name: string; type: AccountType; d: number; c: number }>(env, "SELECT a.code, a.name, a.type, COALESCE(SUM(l.debit_minor), 0) AS d, COALESCE(SUM(l.credit_minor), 0) AS c FROM eng_account a LEFT JOIN eng_journal_line l ON l.account_id = a.id GROUP BY a.id ORDER BY a.code")).map((r) => ({ code: r.code, name: r.name, type: r.type, debitMinor: Number(r.d), creditMinor: Number(r.c) }));
  return { rows, totalDebitMinor: rows.reduce((s, r) => s + r.debitMinor, 0), totalCreditMinor: rows.reduce((s, r) => s + r.creditMinor, 0) };
}
// The balance of the account a role is mapped to: debits less credits (a receivable is positive, VAT output is negative).
export async function balanceOfRole(env: Env, role: string): Promise<number> {
  const a = await accountForRole(env, role);
  if (!a) return 0;
  const r = await one<{ n: number }>(env, "SELECT COALESCE(SUM(debit_minor), 0) - COALESCE(SUM(credit_minor), 0) AS n FROM eng_journal_line WHERE account_id = ?", a.id);
  return Number(r?.n ?? 0);
}

// ---- the integrity check (called by integrity.ts) --------------------------------------------------------------------------------------------------------------------------------------------------
// Reports: an entry whose debits and credits differ (or that has no lines); a contra entry that does not match a reversal of the same source; a financial fact RECORDED AFTER THE LEDGER STARTED that has no entry; and, as a
// WARNING, a fact in a foreign currency that is therefore not posted. Facts from before the ledger started are not expected to have entries.
export async function verifyJournal(env: Env, report: (code: string, detail: string) => void, warn: (code: string, detail: string) => void): Promise<void> {
  for (const e of await many<{ id: number; d: number | null; c: number | null }>(env, "SELECT e.id, SUM(l.debit_minor) AS d, SUM(l.credit_minor) AS c FROM eng_journal_entry e LEFT JOIN eng_journal_line l ON l.entry_id = e.id GROUP BY e.id HAVING d IS NULL OR d <> c")) {
    report("journal_unbalanced", `journal entry ${e.id} does not balance (debits ${e.d ?? 0}, credits ${e.c ?? 0})`);
  }
  for (const c of await many<{ id: number; source_kind: string; source_id: number; reverses_entry_id: number }>(env, "SELECT id, source_kind, source_id, reverses_entry_id FROM eng_journal_entry WHERE reverses_entry_id IS NOT NULL")) {
    const orig = await one<{ source_kind: string; source_id: number }>(env, "SELECT source_kind, source_id FROM eng_journal_entry WHERE id = ? AND reverses_entry_id IS NULL", c.reverses_entry_id);
    const reversed = await one(env, c.source_kind === "document" ? "SELECT 1 AS ok FROM eng_reversal WHERE document_id = ?" : c.source_kind === "movement" ? "SELECT 1 AS ok FROM eng_reversal WHERE movement_id = ?" : c.source_kind === "manual" ? "SELECT 1 AS ok FROM eng_event WHERE (type = 'journal.reversed' AND json_extract(payload_json, '$.journalEventId') = ?1) OR (type = 'year.reopened' AND json_extract(payload_json, '$.closedEventId') = ?1)" : "SELECT 1 AS ok FROM eng_stock_move WHERE reverses_move_id = ?", c.source_id);
    if (!orig || orig.source_kind !== c.source_kind || Number(orig.source_id) !== Number(c.source_id) || !reversed) report("journal_contra_mismatch", `contra entry ${c.id} does not reverse an entry of the same source, or its source was never reversed`);
  }
  const started = await one<{ e: number | null }>(env, "SELECT MAX(id) AS e FROM eng_event WHERE type = 'ledger.chart_seeded'");
  if (started?.e === null || started?.e === undefined) return;
  const after = Number(started.e);
  const currency = await ledgerCurrency(env);
  const cfg = await readConfig(env);
  const kinds = [...cfg.receivableKinds, ...cfg.creditNoteKinds, "expense", "supplier_invoice"];
  if (kinds.length > 0) {
    for (const d of await many<{ id: number; currency: string; kind: string }>(env, `SELECT d.id, d.currency, d.kind FROM eng_document d WHERE d.direction IN ('sell', 'buy') AND d.event_id > ? AND d.kind IN (${kinds.map(() => "?").join(", ")}) ORDER BY d.id`, after, ...kinds)) {
      if (d.currency !== currency) { warn("unposted_foreign_currency", `document ${d.id} is in ${d.currency}, not ${currency}, so it is not in the journal`); continue; }
      if ((await documentTotals(env, d.id)).grossMinor === 0) continue;
      if (!(await one(env, "SELECT 1 AS ok FROM eng_journal_entry WHERE source_kind = 'document' AND source_id = ? AND reverses_entry_id IS NULL", d.id))) report("journal_missing", `document ${d.id} has no journal entry`);
    }
  }
  for (const m of await many<{ id: number; direction: string; currency: string; method: string | null }>(env, "SELECT id, direction, currency, method FROM eng_money_movement WHERE event_id > ? ORDER BY id", after)) {
    if (!(m.direction === "out" || m.method !== "credit")) continue;   // money in by credit note is not money; every other movement posts
    if (m.currency !== currency) { warn("unposted_foreign_currency", `movement ${m.id} is in ${m.currency}, not ${currency}, so it is not in the journal`); continue; }
    if (!(await one(env, "SELECT 1 AS ok FROM eng_journal_entry WHERE source_kind = 'movement' AND source_id = ? AND reverses_entry_id IS NULL", m.id))) report("journal_missing", `movement ${m.id} has no journal entry`);
  }
  for (const m of await many<{ id: number; kind: string; value_minor: number; reverses_move_id: number | null }>(env, "SELECT id, kind, value_minor, reverses_move_id FROM eng_stock_move WHERE event_id > ? ORDER BY id", after)) {
    if (m.kind === "transfer_in" || m.kind === "transfer_out") continue;
    if (m.reverses_move_id !== null) {
      const hadEntry = await one(env, "SELECT 1 AS ok FROM eng_journal_entry WHERE source_kind = 'stock_move' AND source_id = ? AND reverses_entry_id IS NULL", m.reverses_move_id);
      if (hadEntry && !(await one(env, "SELECT 1 AS ok FROM eng_journal_entry WHERE source_kind = 'stock_move' AND source_id = ? AND reverses_entry_id IS NOT NULL", m.reverses_move_id))) report("journal_missing", `stock move ${m.id} reverses move ${m.reverses_move_id} but no contra entry was written`);
      continue;
    }
    if (Number(m.value_minor) === 0) continue;
    if (!(await one(env, "SELECT 1 AS ok FROM eng_journal_entry WHERE source_kind = 'stock_move' AND source_id = ? AND reverses_entry_id IS NULL", m.id))) report("journal_missing", `stock move ${m.id} has no journal entry`);
  }
  for (const e of await many<{ id: number }>(env, "SELECT id FROM eng_event WHERE type = 'journal.posted' ORDER BY id")) {
    if (!(await one(env, "SELECT 1 AS ok FROM eng_journal_entry WHERE source_kind = 'manual' AND source_id = ? AND reverses_entry_id IS NULL", e.id))) report("journal_missing", `journal event ${e.id} has no journal entry`);
  }
  for (const e of await many<{ payload_json: string }>(env, "SELECT payload_json FROM eng_event WHERE type = 'journal.reversed' ORDER BY id")) {
    try { const id = Number((JSON.parse(e.payload_json) as { journalEventId?: unknown }).journalEventId); if (!(await one(env, "SELECT 1 AS ok FROM eng_journal_entry WHERE source_kind = 'manual' AND source_id = ? AND reverses_entry_id IS NOT NULL", id))) report("journal_missing", `journal ${id} was reversed but has no contra entry`); } catch { /* malformed payloads are reported elsewhere */ }
  }
}
