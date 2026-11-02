// Money, quantities and tax, in whole numbers only. Money is integer minor units (cents), quantities are integer thousandths, tax is integer basis points (1500 = 15%). No floating point is used for
// any amount: a product that could pass 2^53 is computed with BigInt, rounded half up, and refused (amount_out_of_range) if the result cannot be held exactly. Tax is rounded per line and then added,
// so a document's total is the sum of its lines' totals and does not depend on how the lines are grouped. What a rate IS (15%, exempt) is business configuration, never a rule here.
import { EngineError } from "./errors";

const MAX = BigInt(Number.MAX_SAFE_INTEGER);

// A whole number in range. Text is refused even when it looks like a number: SQLite would coerce '1000' to 1000 on the way in, so the engine refuses it before it gets there.
export function wholeNumber(value: unknown, label: string, min: number, max?: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || (max !== undefined && value > max)) {
    throw new EngineError("invalid_amount", `${label} must be a whole number ${max !== undefined ? `from ${min} to ${max}` : `of at least ${min}`}`);
  }
  return value;
}

// Round half up for non-negative integers: floor((2n + d) / 2d).
function halfUp(numerator: bigint, denominator: bigint): bigint {
  return (numerator * BigInt(2) + denominator) / (denominator * BigInt(2));
}

function exact(value: bigint, label: string): number {
  if (value > MAX) throw new EngineError("amount_out_of_range", `${label} is too large to hold exactly`);
  return Number(value);
}

// A positive amount of money, in whole minor units.
export function positiveMinor(value: unknown, label: string): number {
  return wholeNumber(value, label, 1);
}

// quantity (thousandths) x unit price (minor units) / 1000, rounded half up
export function lineNetMinor(quantityMilli: unknown, unitPriceMinor: unknown): number {
  const q = wholeNumber(quantityMilli, "quantity", 0);
  const p = wholeNumber(unitPriceMinor, "unit price", 0);
  return exact(halfUp(BigInt(q) * BigInt(p), BigInt(1000)), "line total");
}

// net x rate (basis points) / 10,000, rounded half up
export function lineTaxMinor(netMinor: unknown, taxBp: unknown): number {
  const n = wholeNumber(netMinor, "net amount", 0);
  const r = wholeNumber(taxBp, "tax rate", 0, 10000);
  return exact(halfUp(BigInt(n) * BigInt(r), BigInt(10000)), "tax");
}

export interface LineInput { quantityMilli: number; unitPriceMinor: number; taxBp: number }
export interface Totals { netMinor: number; taxMinor: number; grossMinor: number }

export function lineTotals(line: LineInput): Totals {
  const netMinor = lineNetMinor(line.quantityMilli, line.unitPriceMinor);
  const taxMinor = lineTaxMinor(netMinor, line.taxBp);
  return { netMinor, taxMinor, grossMinor: netMinor + taxMinor };
}

export function documentTotals(lines: LineInput[]): Totals {
  let net = BigInt(0), tax = BigInt(0);
  for (const line of lines) {
    const t = lineTotals(line);
    net += BigInt(t.netMinor);
    tax += BigInt(t.taxMinor);
  }
  return { netMinor: exact(net, "document net"), taxMinor: exact(tax, "document tax"), grossMinor: exact(net + tax, "document total") };
}
