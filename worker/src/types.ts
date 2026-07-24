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
  // Real feature 2026-07-14 — step 1 of the phased auth scope
  // (Constitution Principles 25-27). Google handles identity; these
  // are what the Worker needs to verify a real sign-in actually
  // happened and complete the token exchange.
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  // A session needs its own secret, separate from the OAuth client
  // secret — this one signs the session cookie itself, so a session
  // can be verified on every subsequent request without re-running
  // the OAuth dance each time.
  SESSION_SECRET: string;
}

export interface Extraction {
  customer_name: string | null;
  character_name: string | null;
  character_relationship: string | null;
  intent: "payment" | "invoice" | "quotation" | "convert_quote" | "price_scope" | "work_observation" | "lookup" | "reminder" | "task_complete" | "expense" | "note" | "purchase_order" | "goods_received" | "supplier_invoice" | "variance_disposition" | "other";
  amount: number | null;
  fact_key: string | null;
  fact_value: string | null;
  personal_note: string | null;
  query_scope: "customer" | "personal" | "business" | "character" | null;
  deposit_percent: number | null;
  scope_document_type: "quotation" | "invoice" | null;
  // Real feature 2026-07-21 - a real, stated due time for a reminder
  // ("remind me by Friday", "tomorrow"), extracted exactly as said -
  // never resolved into an actual date by the model, the same
  // discipline already proven for job_scopes.scheduled_date_raw.
  due_date_raw: string | null;
}

// Real feature 2026-07-21 — Purchase Orders, Goods Received Notes,
// and Supplier Invoices, built incrementally starting with POs, per
// the real, three-way design already pinned in DECISIONS.md. A PO is
// a real commitment, not yet a transaction — the mirror image of a
// Quotation, Peter → Supplier instead of Peter → Customer.
export interface PurchaseOrderLineItem {
  description: string;
  quantity_ordered: number;
  unit: string | null;
  unit_price_expected: number | null;
}

export interface PurchaseOrderExtraction {
  supplier_name: string | null;
  description: string;
  line_items: PurchaseOrderLineItem[];
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
  // Real feature 2026-07-17 — deliberately deferred until basic
  // multi-line totaling was proven, which it now is (a real R9,000
  // quotation, correctly calculated, confirmed live). A stated
  // discount rate, extracted directly since recognizing "10% off"
  // already said aloud is transcription, not arithmetic — the actual
  // discounted total is always computed afterward, in code, never by
  // the model. Optional, not required — line items built by other
  // paths (the price_scope/work_observation pricing flow) have no
  // discount concept at all and shouldn't be forced to set one.
  discount_percent?: number | null;
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
  // Real fix 2026-07-15 — Layer 1 (Constitution Principle 28): a
  // directly-stated total area ("160 square meters", no width/length
  // breakdown) had nowhere to go before this — every prior success
  // required width-by-length. Extracting the number here is
  // transcription, not arithmetic — the model never calculates an
  // area, it only recognizes when one was already stated whole.
  area_sqm: number | null;
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

// Real feature 2026-07-21 — Goods Received Notes, the second stage of
// the real, three-way PO/GRN/Supplier Invoice design pinned in
// DECISIONS.md. A GRN is a distinct, separate event from the PO it
// fulfills — the delivery actually arriving, reconciled against real,
// already-ordered quantities. Reuses the same matched_name pattern
// already proven for extractScopePricing — the model's only job is
// recognizing which given PO line item a delivered quantity belongs
// to, never inventing one.
export interface GoodsReceivedLineItem {
  matched_description: string | null;
  quantity_received: number;
}

export interface GoodsReceivedExtraction {
  supplier_name: string | null;
  line_items: GoodsReceivedLineItem[];
}

// Real feature 2026-07-21 — Supplier Invoices, the third and final
// stage of the real, three-way design pinned in DECISIONS.md. This is
// where real money moves, and where both real reconciliations this
// whole arc was built for actually happen: quantity billed against
// quantity received, and price billed against price expected. Unlike
// PO and GRN, this stage also needs to work from a real, uploaded
// document's text (a PDF or a photo of a paper invoice), not just a
// spoken transcript — supplier invoices very often arrive that way,
// not narrated.
export interface SupplierInvoiceLineItem {
  matched_description: string | null;
  quantity_billed: number;
  unit_price_billed: number | null;
}

export interface SupplierInvoiceExtraction {
  supplier_name: string | null;
  supplier_reference: string | null;
  line_items: SupplierInvoiceLineItem[];
}

// Real feature 2026-07-24 — Variance Disposition, what happens after a
// real, computed GRN discrepancy is found. Reason codes validated
// against real ERP research (SAP's own quantity/price split, Oracle's
// established reason-code taxonomy) before being finalized. Two
// genuinely different resolution paths, not one problem with two
// names — back order (still owed, expected later) and credit (a real
// financial write-off).
export interface VarianceDispositionExtraction {
  matched_description: string | null;
  reason: "short_delivered" | "incorrectly_dispatched" | "damaged" | "over_receipt" | null;
  resolution: "back_order" | "credit" | null;
  credit_amount: number | null;
}
