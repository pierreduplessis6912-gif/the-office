// WHAT NEEDS ATTENTION (docs/decisions/needs-attention.md): ONE list, DERIVED on every read from what the engine already knows, that a person would otherwise have to remember to look for. It writes nothing and stores nothing:
// every item names the record it came from and says in plain words why it is there. A section is included only for a viewer who may read what it is made from (and only where that read is available to the business).
// The only rule that is not a recorded fact is the 30 days given to a customer invoice: invoices carry no due date yet, so one still owing 30 days after it was issued is listed, and the item SAYS that is the rule it used.
import type { Env } from "../types";
import { allBills } from "./bills";
import { allJobs } from "./jobs";
import { allQuotations } from "./quotations";
import { outstandingForParty } from "./ledger";
import { allProfiles } from "./parties";
import { reorderSuggestions } from "./stock";
import type { ViewerContext } from "./records";

export const INVOICE_GRACE_DAYS = 30;
export const BILL_SOON_DAYS = 7;
export type AttentionKind = "invoice_late" | "bill_overdue" | "bill_due_soon" | "job_overdue" | "job_snag" | "quote_expired" | "stock_low";
export interface AttentionItem { kind: AttentionKind; title: string; detail: string; ref: { kind: string; id: number } | null; dueOn: string | null; amountMinor: number | null }

const addDays = (iso: string, n: number): string => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const daysBetween = (from: string, to: string): number => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
const rand = (minor: number): string => `R${(minor / 100).toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).replace(/ /g, " ")}`;
// the order a person should look in: money owed to the business or by it first, then work, then the rest
const ORDER: AttentionKind[] = ["bill_overdue", "invoice_late", "job_overdue", "job_snag", "bill_due_soon", "quote_expired", "stock_low"];

// The due date an invoice was issued with (its terms), or null when none was recorded.
async function recordedDueOn(env: Env, documentId: number): Promise<string | null> {
  const row = await env.OFFICE_DB.prepare("SELECT terms_json FROM eng_document WHERE id = ?").bind(documentId).first<{ terms_json: string }>();
  try { const due = (JSON.parse(row?.terms_json ?? "{}") as { dueOn?: unknown }).dueOn; return typeof due === "string" && /^\d{4}-\d{2}-\d{2}$/.test(due) ? due : null; } catch { return null; }
}

export async function attentionItems(env: Env, viewer: ViewerContext, today: string): Promise<AttentionItem[]> {
  const may = (capability: string, permission: string) => viewer.available.has(capability) && (viewer.perms as ReadonlySet<string>).has(permission);
  const out: AttentionItem[] = [];

  if (may("invoices.find", "receivables.read")) {
    for (const p of await allProfiles(env)) {
      for (const d of (await outstandingForParty(env, p.id)).documents) {
        if (d.kind !== "invoice" || d.outstandingMinor <= 0) continue;
        const recorded = await recordedDueOn(env, d.id);
        const dueOn = recorded ?? addDays(d.issuedOn, INVOICE_GRACE_DAYS);
        if (dueOn >= today) continue;
        const name = `Invoice${d.number === null ? "" : ` #${d.number}`}`;
        const detail = recorded !== null
          ? `${name} was due ${recorded}, ${daysBetween(recorded, today)} days ago.`
          : `${name} was issued ${d.issuedOn}, ${daysBetween(d.issuedOn, today)} days ago. No due date was recorded, so ${INVOICE_GRACE_DAYS} days after issue is used.`;
        out.push({ kind: "invoice_late", title: `${p.name} still owes ${rand(d.outstandingMinor)}`, detail, ref: { kind: "document", id: d.id }, dueOn, amountMinor: d.outstandingMinor });
      }
    }
  }

  if (may("supplier_invoices.find", "bill.read")) {
    for (const b of await allBills(env, { status: "outstanding" })) {
      if (b.dueOn === null || b.outstandingMinor <= 0) continue;
      const who = b.supplierName ?? `Supplier #${b.supplierId}`;
      if (b.dueOn < today) out.push({ kind: "bill_overdue", title: `${who}'s bill is overdue: ${rand(b.outstandingMinor)}`, detail: `Bill ${b.supplierInvoiceNumber} was due ${b.dueOn}, ${daysBetween(b.dueOn, today)} days ago.`, ref: b.ref, dueOn: b.dueOn, amountMinor: b.outstandingMinor });
      else if (b.dueOn <= addDays(today, BILL_SOON_DAYS)) out.push({ kind: "bill_due_soon", title: `${who}'s bill is due ${b.dueOn}: ${rand(b.outstandingMinor)}`, detail: `Bill ${b.supplierInvoiceNumber} falls due within ${BILL_SOON_DAYS} days.`, ref: b.ref, dueOn: b.dueOn, amountMinor: b.outstandingMinor });
    }
  }

  if (may("jobs.find", "job.read")) {
    for (const j of await allJobs(env, { status: "any" }, today)) {
      if (j.status === "cancelled") continue;
      if (j.overdue) out.push({ kind: "job_overdue", title: `${j.partyName}: ${j.description} is overdue`, detail: `It was set for ${j.scheduledOn}, ${daysBetween(j.scheduledOn as string, today)} days ago, and is not done.`, ref: { kind: "job", id: j.id }, dueOn: j.scheduledOn, amountMinor: null });
      for (const s of j.snags) if (s.open) out.push({ kind: "job_snag", title: `${j.partyName}: ${j.description} has a snag`, detail: s.note, ref: { kind: "job", id: j.id }, dueOn: null, amountMinor: null });
    }
  }

  if (may("quotations.find", "quotation.read")) {
    for (const q of await allQuotations(env)) {
      if (q.status !== "open" || q.validUntil === null || q.validUntil >= today) continue;
      out.push({ kind: "quote_expired", title: `Quotation${q.number === null ? "" : ` #${q.number}`} ran out without an answer: ${rand(q.grossMinor)}`, detail: `It was valid until ${q.validUntil} and has not been accepted.`, ref: { kind: "document", id: q.id }, dueOn: q.validUntil, amountMinor: q.grossMinor });
    }
  }

  if (may("stock.reorder_suggestions", "stock.read")) {
    for (const s of await reorderSuggestions(env)) {
      out.push({ kind: "stock_low", title: `${s.name} is below its reorder level`, detail: `Position ${s.positionMilli / 1000} ${s.unit} against a level of ${s.reorderLevelMilli / 1000}.`, ref: { kind: "item", id: s.itemId }, dueOn: null, amountMinor: null });
    }
  }

  return out.sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind) || (a.dueOn ?? "9999").localeCompare(b.dueOn ?? "9999") || (b.amountMinor ?? 0) - (a.amountMinor ?? 0));
}
