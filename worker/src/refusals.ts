// Structured refusals (envelope contract version 2, ENVELOPE.md). A role refusal used to reach the app only as words inside `message`. The places that refuse now ALSO say so
// in a closed vocabulary, so the envelope can report a refusal without anyone guessing from text. This module is pure data and types: it imports nothing and reads nothing.
// Every `topic` names WHAT was withheld or not recorded (never a person, an amount or a record): there is no free text in a refusal.
export const CANNOT_RECORD_TOPICS = ["money", "leads", "statements", "stock"] as const;
export const CANNOT_SEE_TOPICS = ["material_prices", "open_orders", "supplier_statements", "unit_conversions", "delivery_exceptions", "financial_overview", "debtors", "financial_analysis"] as const;
export type Refusal =
  | { reason: "role_cannot_record"; topic: (typeof CANNOT_RECORD_TOPICS)[number] }
  | { reason: "role_cannot_see"; topic: (typeof CANNOT_SEE_TOPICS)[number] };
export const cannotSee = (topic: (typeof CANNOT_SEE_TOPICS)[number]): Refusal => ({ reason: "role_cannot_see", topic });
export const cannotRecord = (topic: (typeof CANNOT_RECORD_TOPICS)[number]): Refusal => ({ reason: "role_cannot_record", topic });
// Used by the envelope to accept only what this vocabulary allows, whatever a reply carries.
export function isRefusal(value: unknown): value is Refusal {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (v.reason === "role_cannot_record") return (CANNOT_RECORD_TOPICS as readonly unknown[]).includes(v.topic);
  if (v.reason === "role_cannot_see") return (CANNOT_SEE_TOPICS as readonly unknown[]).includes(v.topic);
  return false;
}
