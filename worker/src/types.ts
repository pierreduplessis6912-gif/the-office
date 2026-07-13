// Shared types across every module — Env (Cloudflare bindings) and every
// extraction/data shape used by more than one primitive. No logic here,
// deliberately — this file only ever grows by adding a shape, never a function.


export interface Env {
  OFFICE_DB: D1Database;
  OFFICE_VAULT: R2Bucket;
  AI: Ai;
  MEMORY: VectorizeIndex;
  CUSTOMER_NOTES: KVNamespace;
  // Real feature 2026-07-13 — the minimal, immediate protection layer
  // for admin routes (export, flush) before the full Google-auth
  // system exists. A genuine deletion capability, unprotected, would
  // be a real security exposure the moment it existed — this doesn't
  // wait for the larger auth build, it's the smallest correct
  // safeguard available now, checked on every admin request.
  ADMIN_KEY: string;
}

export interface Extraction {
  customer_name: string | null;
  character_name: string | null;
  character_relationship: string | null;
  intent: "payment" | "invoice" | "quotation" | "convert_quote" | "price_scope" | "work_observation" | "lookup" | "reminder" | "task_complete" | "expense" | "note" | "other";
  amount: number | null;
  fact_key: string | null;
  fact_value: string | null;
  personal_note: string | null;
  query_scope: "customer" | "personal" | "business" | "character" | null;
  deposit_percent: number | null;
  scope_document_type: "quotation" | "invoice" | null;
}

export interface ProcessResult {
  extraction: Extraction | null;
  extractionRaw: unknown;
  extractionRawText: string | null;
  customer: { id: number; name: string; matched: boolean } | null;
  pendingActionId: number | null;
  // Real feature 2026-07-13 — a compound message can hold more than
  // one item needing guard() confirmation (e.g. an invoice AND a
  // separate expense in the same message). pendingActionId above
  // stays for backward compatibility (the first one, or null); this
  // is the real, complete list.
  pendingActionIds: number[];
  factPendingActionId: number | null;
  message: string;
  rewrittenQuery: string;
  embers: { tasks: number; scheduler: number; finance: number; expenses: number };
}

export interface LineItemExtraction {
  description: string;
  note: string | null;
  quantity: number;
  unit: string | null;
  unit_price: number;
}

export interface ScopePricingItem {
  matched_name: string | null; // must match a given component/task name exactly, or null if it doesn't
  description: string;
  pricing_type: "per_sqm" | "flat";
  rate: number;
}

export interface WorkComponent {
  name: string;
  width: number | null;
  length: number | null;
  unit: "mm" | "m" | null; // the model's job: recognize the unit; conversion always happens in code
}

export interface WorkTask {
  description: string;
  component_name: string | null; // e.g. "Theatre 2" — null if it applies to the whole job, not one part
}

export interface WorkObservationExtraction {
  job_description: string;
  components: WorkComponent[];
  tasks: WorkTask[];
  scheduled_date_raw: string | null;
  installer_name: string | null; // who's assigned to actually do this job — e.g. "Sipho is doing Jenny's install"
}

// Same guarded pattern again — a quotation is a real, standing figure
// Peter's given a customer, and getting it wrong (wrong amount, wrong
// customer) is exactly as consequential as getting a payment wrong,
// even though no money has moved yet.
export interface LineItemWithTotal extends LineItemExtraction {
  line_total: number;
}

export interface CustomerNote {
  text: string;
  storedAt: string;
}

export interface LifeEntry {
  text: string;
  storedAt: string;
}

export interface HistoryTurn {
  role: "user" | "office";
  text: string;
}
