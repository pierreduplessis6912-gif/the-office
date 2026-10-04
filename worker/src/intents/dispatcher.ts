// Phase 1 of the processOneExtraction rewrite: the dispatcher's contract, and, for now, nothing more.
// NOTHING CALLS THIS YET (a test asserts index.ts does not import it). The live function is not edited.
//
// Two things live here:
//  1. An adapter that wraps the live function (passed in, never imported, so this module can never form
//     an import cycle with index.ts) and returns the new ProcessingResult. This is what Phase 2's shadow
//     mode builds on: the old path still runs, and its result is what the new code is compared against.
//  2. The planned grouping of intents into handler groups, as data, so the plan is checked rather than
//     remembered (it is exhaustive over the intent union at compile time and again in a test).
import type { Env, Extraction, HistoryTurn } from "../types";
import {
  type Intent,
  type LegacyProcessResult,
  type ProcessingResult,
  type ResolvedEntity,
  toProcessingResult,
} from "./result";

// Everything processOneExtraction takes, as one named object instead of eight positional arguments.
export interface ProcessingInput {
  env: Env;
  transcript: string;
  extraction: Extraction | null;
  history: HistoryTurn[];
  ctx: ExecutionContext;
  captureId: number | null;
  capabilities: string[];
  recordingUserEmail: string | null;
}

// What the shared preamble (customer and character resolution) will compute once and hand to a handler,
// so no handler reads a variable some other branch happened to set earlier in a shared scope.
export interface ResolvedExtraction extends ProcessingInput {
  customer: ResolvedEntity | null;
  character: ResolvedEntity | null;
}

export type IntentHandler = (resolved: ResolvedExtraction) => Promise<ProcessingResult>;

// The live function's own signature, positional, in its real order. A test compares this order with the
// parameter list in index.ts, so a change there cannot slip past the adapter.
export type LegacyProcessor = (
  env: Env,
  transcript: string,
  extraction: Extraction | null,
  history: HistoryTurn[],
  ctx: ExecutionContext,
  captureId: number | null,
  capabilities: string[],
  recordingUserEmail?: string | null
) => Promise<LegacyProcessResult>;

export function adaptLegacyProcessor(legacy: LegacyProcessor): (input: ProcessingInput) => Promise<ProcessingResult> {
  return async (input) =>
    toProcessingResult(
      await legacy(
        input.env,
        input.transcript,
        input.extraction,
        input.history,
        input.ctx,
        input.captureId,
        input.capabilities,
        input.recordingUserEmail
      )
    );
}

// The planned handler groups. This is the corrected plan from the validation results, not the original
// six: invoice, price_scope and work_observation each carry their own differently-behaving copy of "record
// the observation, maybe price it", so they are one group built on one shared observation sub-module;
// stock and lookup had no home in the original plan; snags and leads cohere with each other and not with
// the observation work. Typed as a Record over the intent union, so adding an intent without placing it
// is a compile error.
export type HandlerGroup =
  | "payments"
  | "procurement"
  | "job_pricing"
  | "snags_leads"
  | "stock"
  | "lookup"
  | "memory"
  | "notes";

export const INTENT_GROUP: Record<Intent, HandlerGroup> = {
  payment: "payments",
  expense: "payments",
  supplier_payment: "payments",
  purchase_order: "procurement",
  goods_received: "procurement",
  supplier_invoice: "procurement",
  variance_disposition: "procurement",
  cancel_order: "procurement",
  supplier_statement: "procurement",
  invoice: "job_pricing",
  quotation: "job_pricing",
  price_scope: "job_pricing",
  convert_quote: "job_pricing",
  work_observation: "job_pricing",
  raise_snag: "snags_leads",
  resolve_snag: "snags_leads",
  raise_lead: "snags_leads",
  lose_lead: "snags_leads",
  register_stock_item: "stock",
  stock_usage: "stock",
  stocktake: "stock",
  lookup: "lookup",
  reminder: "memory",
  task_complete: "memory",
  forget_last: "memory",
  note: "notes",
  other: "notes",
};

export function handlerGroupFor(intent: Intent): HandlerGroup {
  return INTENT_GROUP[intent];
}
