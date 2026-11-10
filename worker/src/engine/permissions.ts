// The engine's OWN permission vocabulary, and the adapter from today's capability names to it. The existing capability names (can_know_debtors, can_manage_invoices) are useful evidence and a sensible compatibility
// starting point, but they are not the engine's permanent vocabulary: contracts declare ENGINE permissions, and this adapter says which legacy capabilities grant them. When the permission model improves, only this
// file changes; no contract does. A legacy capability the adapter has never heard of grants nothing, and a test fails when a new legacy capability appears that nobody has decided about.
export type EnginePermission = "receivables.read" | "records.read" | "payment.record" | "payment.correct" | "invoice.issue" | "drafts.edit" | "party.read" | "party.manage" | "quotation.read" | "quotation.manage" | "credit_note.issue" | "business.manage" | "credit.apply" | "refund.record" | "credit_note.void" | "debit_note.issue";

// What each legacy capability grants in the engine.
export const MAP: Record<string, readonly EnginePermission[]> = {
  can_know_debtors: ["receivables.read", "records.read", "party.read"],
  can_make_quotes: ["quotation.read", "quotation.manage"],
  can_manage_settings: ["business.manage"],
  can_manage_invoices: ["payment.record", "payment.correct", "invoice.issue", "drafts.edit", "party.manage", "quotation.read", "quotation.manage", "credit_note.issue", "credit.apply", "refund.record", "credit_note.void", "debit_note.issue"],
};

// Legacy capabilities that are deliberately NOT an engine concern yet: each is decided, none is forgotten.
export const UNMAPPED: readonly string[] = [
  "can_capture_voice_notes", "can_delete_data", "can_invite_members", "can_know_banking", "can_know_expense_totals", "can_know_jobs", "can_know_material_prices",
  "can_know_materials", "can_know_measurements", "can_know_payroll", "can_know_profit", "can_know_supplier_balances",
];

export function permissionsFor(caps: readonly string[]): Set<EnginePermission> {
  const out = new Set<EnginePermission>();
  for (const c of caps) for (const p of MAP[c] ?? []) out.add(p);
  return out;
}
