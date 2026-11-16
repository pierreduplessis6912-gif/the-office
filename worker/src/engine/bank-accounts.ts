// SEVERAL BANK ACCOUNTS (docs/decisions/bank-accounts.md): which ledger accounts are bank accounts. RULES and READS live here; the INSERTS live in facts.ts (the one write path).
// A bank account is an ordinary asset account in the chart. The account that holds the `bank` role is the DEFAULT and is not stored again; every other one is a row in eng_bank_account, added once with its event.
// A payment or a statement that names no account belongs to the default, so everything recorded before several accounts existed is unchanged.
import type { Env } from "../types";
import { EngineError } from "./errors";
import { accountForRole } from "./journal";

const one = <T>(env: Env, sql: string, ...binds: unknown[]) => env.OFFICE_DB.prepare(sql).bind(...binds).first<T>();
const many = async <T>(env: Env, sql: string, ...binds: unknown[]): Promise<T[]> => ((await env.OFFICE_DB.prepare(sql).bind(...binds).all<T>()).results ?? []);

export interface BankAccountView { id: number; code: string; name: string; isDefault: boolean }

// The default first, then the others in the order they were added. `id` is the ledger account's id: that is what a payment or a statement names.
export async function bankAccounts(env: Env): Promise<BankAccountView[]> {
  const out: BankAccountView[] = [];
  const def = await accountForRole(env, "bank");
  if (def) out.push({ id: def.id, code: def.code, name: def.name, isDefault: true });
  for (const r of await many<{ id: number; code: string; name: string }>(env, "SELECT a.id, a.code, a.name FROM eng_bank_account b JOIN eng_account a ON a.id = b.account_id ORDER BY b.id")) out.push({ id: Number(r.id), code: r.code, name: r.name, isDefault: false });
  return out;
}

// A payment's or statement's account: nothing stated is the default (null); otherwise it must be one of the business's bank accounts. Cash and a credit note's non-cash movement are not in a bank account.
export async function checkedBankAccount(env: Env, value: unknown, method?: string | null): Promise<number | null> {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new EngineError("invalid_input", "bankAccountId must be a record number");
  if (method === "cash" || method === "credit") throw new EngineError("invalid_input", method === "cash" ? "cash is not paid into a bank account; leave the bank account out" : "a credit is not money in a bank account");
  if (!(await bankAccounts(env)).some((a) => a.id === value)) throw new EngineError("not_found", "That is not one of the business's bank accounts.");
  return value;
}

export function checkAddInput(input: unknown): { ok: true; value: { name: string } } | { ok: false; reason: string } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return { ok: false, reason: "the bank account must be an object" };
  const o = input as Record<string, unknown>;
  for (const k of Object.keys(o)) if (k !== "name") return { ok: false, reason: `${k} is not a field of a bank account` };
  if (typeof o.name !== "string" || o.name.trim().length < 2 || o.name.trim().length > 60) return { ok: false, reason: "name must be 2 to 60 characters" };
  return { ok: true, value: { name: o.name.trim() } };
}

// What adding one would record, or why it cannot be added: a name already used by any account is refused, and the next free code from 1020 to 1099 is chosen by the engine.
export async function planAdd(env: Env, input: { name: string }): Promise<{ name: string; code: string }> {
  const c = checkAddInput(input); if (!c.ok) throw new EngineError("invalid_input", c.reason);
  const name = c.value.name;
  if (await one(env, "SELECT 1 AS ok FROM eng_account WHERE lower(name) = lower(?)", name)) throw new EngineError("invalid_state", "An account with that name already exists.");
  const used = new Set((await many<{ code: string }>(env, "SELECT code FROM eng_account")).map((r) => r.code));
  for (let n = 1020; n <= 1099; n++) if (!used.has(String(n))) return { name, code: String(n) };
  throw new EngineError("invalid_state", "There is no room for another bank account in the chart.");
}

// The integrity check: every listed bank account is a real asset account, none is the default, and every payment or statement that names an account names a bank account.
export async function verifyAccounts(env: Env, report: (code: string, detail: string) => void): Promise<void> {
  const def = await accountForRole(env, "bank");
  for (const b of await many<{ id: number; account_id: number; type: string | null }>(env, "SELECT b.id, b.account_id, a.type FROM eng_bank_account b LEFT JOIN eng_account a ON a.id = b.account_id")) {
    if (b.type !== "asset") report("bank_account_inconsistent", `bank account ${b.id} is not an asset account in the chart`);
    if (def && Number(b.account_id) === def.id) report("bank_account_inconsistent", `bank account ${b.id} is the default account, which is not stored again`);
  }
  const known = new Set((await bankAccounts(env)).map((a) => a.id));
  for (const m of await many<{ id: number; bank_account_id: number }>(env, "SELECT id, bank_account_id FROM eng_money_movement WHERE bank_account_id IS NOT NULL")) if (!known.has(Number(m.bank_account_id))) report("bank_account_inconsistent", `payment ${m.id} names an account that is not a bank account`);
  for (const s of await many<{ id: number; bank_account_id: number }>(env, "SELECT id, bank_account_id FROM eng_bank_statement WHERE bank_account_id IS NOT NULL")) if (!known.has(Number(s.bank_account_id))) report("bank_account_inconsistent", `statement ${s.id} names an account that is not a bank account`);
  // the money leg of a payment that names an account is in that account
  for (const m of await many<{ id: number; direction: string; bank_account_id: number }>(env, "SELECT id, direction, bank_account_id FROM eng_money_movement WHERE bank_account_id IS NOT NULL AND (method IS NULL OR method NOT IN ('cash', 'credit'))")) {
    const e = await one<{ id: number }>(env, "SELECT id FROM eng_journal_entry WHERE source_kind = 'movement' AND source_id = ? AND reverses_entry_id IS NULL", m.id);
    if (!e) continue;   // the journal's own check reports a missing entry
    const hit = await one(env, `SELECT 1 AS ok FROM eng_journal_line WHERE entry_id = ? AND account_id = ? AND ${m.direction === "in" ? "debit_minor" : "credit_minor"} > 0`, e.id, m.bank_account_id);
    if (!hit) report("bank_account_inconsistent", `payment ${m.id} names an account but its entry does not touch that account`);
  }
}

// ---- a transfer between two of the business's bank accounts -------------------------------------------------------------------------------------------------------------------------------------------
// Moving money between accounts is ONE balanced manual journal (debit where it goes, credit where it came from), posted like any other (so it can be reversed like any other). Neither side is invented and the total of
// all the bank accounts does not change; cash flow treats it as no movement of cash.
export interface BankTransferInput { fromAccountId: number; toAccountId: number; amountMinor: number; date: string; note?: string }
export function checkBankTransferInput(payload: unknown): { ok: true; value: BankTransferInput } | { ok: false; reason: string } {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return { ok: false, reason: "the transfer must be an object" };
  const o = payload as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!["fromAccountId", "toAccountId", "amountMinor", "date", "note"].includes(k)) return { ok: false, reason: `${k} is not a field of a transfer` };
  const whole = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
  if (!whole(o.fromAccountId) || !whole(o.toAccountId)) return { ok: false, reason: "fromAccountId and toAccountId must be record numbers" };
  if (o.fromAccountId === o.toAccountId) return { ok: false, reason: "a transfer needs two different accounts" };
  if (!whole(o.amountMinor)) return { ok: false, reason: "amountMinor must be a whole number of cents, at least 1" };
  if (typeof o.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(o.date) || Number.isNaN(Date.parse(o.date + "T00:00:00Z"))) return { ok: false, reason: "date must be a real date written YYYY-MM-DD" };
  if (o.note !== undefined && (typeof o.note !== "string" || o.note.trim().length === 0 || o.note.length > 120)) return { ok: false, reason: "note must be 1 to 120 characters" };
  return { ok: true, value: { fromAccountId: o.fromAccountId, toAccountId: o.toAccountId, amountMinor: o.amountMinor, date: o.date, ...(o.note !== undefined ? { note: (o.note as string).trim() } : {}) } };
}
export async function planBankTransfer(env: Env, input: BankTransferInput): Promise<{ from: BankAccountView; to: BankAccountView; reason: string }> {
  const accounts = await bankAccounts(env);
  const from = accounts.find((a) => a.id === input.fromAccountId), to = accounts.find((a) => a.id === input.toAccountId);
  if (!from || !to) throw new EngineError("not_found", "A transfer is between two of the business's bank accounts.");
  return { from, to, reason: `Transfer from ${from.name} to ${to.name}${input.note ? `: ${input.note}` : ""}` };
}

// Which account the words name ("savings", "the main account"): by name, case aside; "main" or "default" is the default account. Null when none or more than one fits.
export async function accountNamed(env: Env, words: string): Promise<BankAccountView | null> {
  const w = words.trim().toLowerCase();
  const all = await bankAccounts(env);
  if (["main", "default", "main account", "the main account", "bank"].includes(w)) return all.find((a) => a.isDefault) ?? null;
  const hits = all.filter((a) => a.name.toLowerCase() === w);
  return hits.length === 1 ? hits[0] : null;
}
