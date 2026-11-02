// The engine's refusals. Each has a stable CODE: the code is what callers, tests and the conversation layer branch on, the message is for people. A refusal never changes anything.
export type EngineErrorCode =
  | "invalid_input"          // the request is malformed: a missing field, a date that is not a date, a blank reason
  | "invalid_amount"         // money, a quantity or a rate that is not a whole number in the allowed range (floats and text are refused, never coerced)
  | "amount_out_of_range"    // a result that cannot be held exactly (beyond 2^53): refused, never rounded
  | "not_found"              // the record it points at does not exist in this business
  | "not_effective"          // the record exists but has been reversed (or hangs off something that has been)
  | "already_reversed"       // it was reversed already: nothing is reversed twice
  | "has_dependents"         // it still has effective records hanging off it; reverse those first
  | "over_allocated"         // more than the payment still has, or more than the document still owes
  | "currency_mismatch";     // a payment in one currency is never allocated to a document in another

export class EngineError extends Error {
  readonly code: EngineErrorCode;
  constructor(code: EngineErrorCode, message: string) {
    super(message);
    this.name = "EngineError";
    this.code = code;
  }
}
