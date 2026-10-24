// Structured refusals (envelope contract version 2, ENVELOPE.md). A role refusal used to reach the app only as words inside `message`. The places that refuse now ALSO say so
// in a closed vocabulary, so the envelope can report a refusal without anyone guessing from text. This module is pure data and types: it imports nothing and reads nothing.
// Every `topic` names WHAT was withheld or not recorded (never a person, an amount or a record): there is no free text in a refusal.
export const CANNOT_RECORD_TOPICS = ["money", "leads", "statements", "stock"] as const;
// A PART refusal: the reply is a real answer with something withheld inside it (a restricted fact in a composed answer, a detail not saved). It never makes the whole reply a refusal.
export const WITHHELD_SEE_TOPICS = ["outstanding_balances", "quotation_activity", "expense_activity", "financial_performance", "supplier_balances", "job_activity", "customer_balance", "job_profitability"] as const;
export const WITHHELD_RECORD_TOPICS = ["sensitive_details"] as const;
export const CANNOT_SEE_TOPICS = ["material_prices", "open_orders", "supplier_statements", "unit_conversions", "delivery_exceptions", "financial_overview", "debtors", "financial_analysis"] as const;
export type Refusal =
  | { reason: "role_cannot_record"; topic: (typeof CANNOT_RECORD_TOPICS)[number] }
  | { reason: "role_cannot_see"; topic: (typeof CANNOT_SEE_TOPICS)[number] }
  | { reason: "role_cannot_see_part"; topic: (typeof WITHHELD_SEE_TOPICS)[number] }
  | { reason: "role_cannot_record_part"; topic: (typeof WITHHELD_RECORD_TOPICS)[number] };
export const cannotSee = (topic: (typeof CANNOT_SEE_TOPICS)[number]): Refusal => ({ reason: "role_cannot_see", topic });
export const cannotRecord = (topic: (typeof CANNOT_RECORD_TOPICS)[number]): Refusal => ({ reason: "role_cannot_record", topic });
export const cannotSeePart = (topic: (typeof WITHHELD_SEE_TOPICS)[number]): Refusal => ({ reason: "role_cannot_see_part", topic });
export const cannotRecordPart = (topic: (typeof WITHHELD_RECORD_TOPICS)[number]): Refusal => ({ reason: "role_cannot_record_part", topic });
// True when this refusal is the WHOLE answer (as opposed to something withheld inside a real answer).
export const isWholeRefusal = (r: Refusal): boolean => r.reason === "role_cannot_record" || r.reason === "role_cannot_see";
// Used by the envelope to accept only what this vocabulary allows, whatever a reply carries.
export function isRefusal(value: unknown): value is Refusal {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (v.reason === "role_cannot_record") return (CANNOT_RECORD_TOPICS as readonly unknown[]).includes(v.topic);
  if (v.reason === "role_cannot_see") return (CANNOT_SEE_TOPICS as readonly unknown[]).includes(v.topic);
  if (v.reason === "role_cannot_see_part") return (WITHHELD_SEE_TOPICS as readonly unknown[]).includes(v.topic);
  if (v.reason === "role_cannot_record_part") return (WITHHELD_RECORD_TOPICS as readonly unknown[]).includes(v.topic);
  return false;
}
