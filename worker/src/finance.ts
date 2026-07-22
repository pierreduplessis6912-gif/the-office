// The Finance primitive — the revenue chain (quotations -> invoices ->
// payments) and the expense side (Principle 22's accounting-capability
// roadmap), guard()'d the same way for both directions of money. Document
// generation (real PDFs, real share messages) lives here too, since it's
// downstream of the same records.

import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import type { Env, LineItemExtraction, LineItemWithTotal, PurchaseOrderLineItem } from "./types";
import { setSelection } from "./identity";
import { classifyExpenseCategory } from "./ai";

// Real fix found live 2026-07-19, testing reports against real data
// (Constitution Principle 28's own discipline, applied to presentation
// rather than calculation): a negative amount was rendering as
// "R-500" — the minus sign landing after the currency symbol, reading
// like a typo, not a real credit. Every currency figure on every
// generated PDF goes through this one helper now, so a negative value
// anywhere always reads correctly, not just wherever this was first
// found.
function formatRand(amount: number): string {
  const sign = amount < 0 ? "-" : "";
  return `${sign}R${Math.abs(amount).toLocaleString()}`;
}

// The actual real ground-truth write. Only ever called from the
// confirm endpoint — never directly from the message pipeline. That's
// the whole point of guard(): the path from "extracted" to "written"
// always has a mandatory stop in the middle.
export async function recordPayment(
  env: Env,
  customerId: number,
  amount: number | null,
  sourceTranscript: string
): Promise<{ id: number; customerId: number; amount: number | null }> {
  const inserted = await env.OFFICE_DB.prepare(
    "INSERT INTO payments (customer_id, amount, source_transcript) VALUES (?, ?, ?) RETURNING id"
  )
    .bind(customerId, amount, sourceTranscript)
    .first<{ id: number }>();

  return { id: inserted!.id, customerId, amount };
}

// Real feature 2026-07-11 — the first concrete piece of the expense
// side of the accounting-capability roadmap pinned in STATUS.md.
// Deliberately the smallest possible first domino, same discipline as
// `tasks`: a bare table and one real intent, no receipt-photo
// extraction, no VAT parsing, no job-cost linking yet. Same guard()
// discipline as recordPayment — money moving is money moving,
// regardless of direction.
// Real feature 2026-07-12 — categorized at confirm time, right before
// the write. Categorization doesn't affect guard()'s validation and
// has no bearing on whether the expense itself is correct, so it
// doesn't need to block or slow the initial confirmation response —
// it only needs to be real by the time the row is actually written.
// Real feature 2026-07-12 — job-cost linking, the real prerequisite
// for "how profitable was this job" (getJobProfitability below).
// customerId here means "which job/customer this cost is FOR" —
// genuinely distinct from characterId (who was paid) — and is nullable,
// since most expenses today won't have job context stated at all.
export async function recordExpense(
  env: Env,
  characterId: number | null,
  amount: number | null,
  description: string,
  sourceTranscript: string,
  customerId: number | null = null
): Promise<{ id: number; characterId: number | null; customerId: number | null; amount: number | null; category: string }> {
  const category = await classifyExpenseCategory(env, description);
  const inserted = await env.OFFICE_DB.prepare(
    "INSERT INTO expenses (character_id, customer_id, amount, description, category, source_transcript) VALUES (?, ?, ?, ?, ?, ?) RETURNING id"
  )
    .bind(characterId, customerId, amount, description, category, sourceTranscript)
    .first<{ id: number }>();

  return { id: inserted!.id, characterId, customerId, amount, category };
}

// Same discipline as recordPayment — the ground-truth write, only
// ever called from the confirm endpoint. Money billed deserves the
// same guard as money received, even though nothing physically moved
// yet: a wrong customer or a wrong amount here is just as real a
// mistake as a wrong payment would be. lineItems is optional and new
// — line_items already supported invoice_id via its CHECK constraint
// (exactly one of quotation_id/invoice_id, never both), it just had
// no real writer until price_scope needed to produce invoices as
// naturally as quotations, not just flat single-amount ones.
export async function recordInvoice(
  env: Env,
  customerId: number,
  description: string,
  amount: number,
  sourceTranscript: string,
  lineItems: LineItemWithTotal[] = []
): Promise<{ id: number; customerId: number; amount: number; retentionAmount: number }> {
  // Real feature 2026-07-21 — a real, urgent need: an active
  // two-year contract in its final stage, needing historical
  // reconciliation soon. Retention is modeled as a real, standing
  // rate on the customer — agreed once for the life of a contract,
  // not restated on every invoice — the same pattern already proven
  // for vat_exempt. Looked up and applied here, deterministically, at
  // the moment of creation; never asked of the model.
  const customer = await env.OFFICE_DB.prepare("SELECT retention_percent FROM customers WHERE id = ?")
    .bind(customerId)
    .first<{ retention_percent: number | null }>();
  const retentionPercent = customer?.retention_percent ?? null;
  const retentionAmount = retentionPercent ? Math.round(amount * (retentionPercent / 100) * 100) / 100 : 0;

  const inserted = await env.OFFICE_DB.prepare(
    "INSERT INTO invoices (customer_id, description, amount, source_transcript, retention_percent, retention_amount) VALUES (?, ?, ?, ?, ?, ?) RETURNING id"
  )
    .bind(customerId, description, amount, sourceTranscript, retentionPercent, retentionAmount)
    .first<{ id: number }>();

  const invoiceId = inserted!.id;

  for (const item of lineItems) {
    await env.OFFICE_DB.prepare(
      "INSERT INTO line_items (invoice_id, description, note, quantity, unit, unit_price, line_total, discount_percent) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    )
      .bind(invoiceId, item.description, item.note, item.quantity, item.unit, item.unit_price, item.line_total, item.discount_percent ?? null)
      .run();
  }

  return { id: invoiceId, customerId, amount, retentionAmount };
}

export async function recordQuotation(
  env: Env,
  customerId: number,
  description: string,
  amount: number,
  sourceTranscript: string,
  lineItems: LineItemWithTotal[] = []
): Promise<{ id: number; customerId: number; amount: number }> {
  const inserted = await env.OFFICE_DB.prepare(
    "INSERT INTO quotations (customer_id, description, amount, source_transcript) VALUES (?, ?, ?, ?) RETURNING id"
  )
    .bind(customerId, description, amount, sourceTranscript)
    .first<{ id: number }>();

  const quotationId = inserted!.id;

  for (const item of lineItems) {
    await env.OFFICE_DB.prepare(
      "INSERT INTO line_items (quotation_id, description, note, quantity, unit, unit_price, line_total, discount_percent) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    )
      .bind(quotationId, item.description, item.note, item.quantity, item.unit, item.unit_price, item.line_total, item.discount_percent ?? null)
      .run();
  }

  return { id: quotationId, customerId, amount };
}

// Real feature 2026-07-21 — Purchase Orders, built incrementally per
// the real, three-way design pinned in DECISIONS.md. Deliberately
// unguarded — a PO is a real commitment, not yet a transaction, no
// money has moved and no goods have arrived — the exact same
// precedent already established for job scopes (a mistake here is
// cheap to correct, unlike money). The consequential confirmations in
// this arc are the Goods Received Note and the Supplier Invoice,
// still to come.
export async function recordPurchaseOrder(
  env: Env,
  supplierId: number | null,
  description: string,
  sourceTranscript: string,
  lineItems: PurchaseOrderLineItem[]
): Promise<{ purchaseOrderId: number }> {
  const inserted = await env.OFFICE_DB.prepare(
    "INSERT INTO purchase_orders (supplier_id, description, source_transcript) VALUES (?, ?, ?) RETURNING id"
  )
    .bind(supplierId, description, sourceTranscript)
    .first<{ id: number }>();

  const purchaseOrderId = inserted!.id;

  for (const item of lineItems) {
    await env.OFFICE_DB.prepare(
      "INSERT INTO po_line_items (purchase_order_id, description, quantity_ordered, unit, unit_price_expected) VALUES (?, ?, ?, ?, ?)"
    )
      .bind(purchaseOrderId, item.description, item.quantity_ordered, item.unit, item.unit_price_expected)
      .run();
  }

  return { purchaseOrderId };
}

// The mirror image of findLatestJobScope, for the same reason: a GRN
// or Supplier Invoice referring back to "the order" needs a real way
// to find which one, without asking Peter to repeat a PO number he
// likely never wrote down anywhere.
export async function findLatestOpenPurchaseOrder(
  env: Env,
  supplierId: number
): Promise<{ id: number; description: string } | null> {
  const result = await env.OFFICE_DB.prepare(
    "SELECT id, description FROM purchase_orders WHERE supplier_id = ? ORDER BY created_at DESC LIMIT 1"
  )
    .bind(supplierId)
    .first<{ id: number; description: string }>();
  return result ?? null;
}

// Real, needed by the caller to give extractGoodsReceived the real,
// given line items to match against — the same reason extractScopePricing
// needs the real components/tasks list passed in.
export async function getPurchaseOrderLineItems(
  env: Env,
  purchaseOrderId: number
): Promise<Array<{ id: number; description: string; quantity_ordered: number; unit: string | null; unit_price_expected: number | null }>> {
  const { results } = await env.OFFICE_DB.prepare(
    "SELECT id, description, quantity_ordered, unit, unit_price_expected FROM po_line_items WHERE purchase_order_id = ?"
  )
    .bind(purchaseOrderId)
    .all<{ id: number; description: string; quantity_ordered: number; unit: string | null; unit_price_expected: number | null }>();
  return results ?? [];
}

// Real feature 2026-07-21 — Goods Received Notes, the second stage
// of the real, three-way design pinned in DECISIONS.md. Guard()'d —
// unlike the PO itself, this is where real stock actually changes
// hands, matching the original design's own distinction. The real
// point of this whole arc: a quantity variance, computed here,
// deterministically, in code — never an AI's impression of "seems
// about right."
export async function recordGoodsReceived(
  env: Env,
  purchaseOrderId: number,
  supplierId: number | null,
  sourceTranscript: string,
  lineItems: Array<{ matched_description: string | null; quantity_received: number }>,
  recordedByEmail: string | null = null
): Promise<{ grnId: number; variances: Array<{ description: string; ordered: number; received: number; variance: number }> }> {
  const poLineItems = await getPurchaseOrderLineItems(env, purchaseOrderId);

  // Real design decision 2026-07-21 — GRN capture stays open to
  // literally anyone in the organisation, on purpose: an installer on
  // site or a warehouse clerk, quantity-only, no money involved.
  // What makes this safe isn't restriction, it's accountability — who
  // actually recorded it is now a real, permanent fact.
  const inserted = await env.OFFICE_DB.prepare(
    "INSERT INTO goods_received_notes (purchase_order_id, supplier_id, source_transcript, recorded_by) VALUES (?, ?, ?, ?) RETURNING id"
  )
    .bind(purchaseOrderId, supplierId, sourceTranscript, recordedByEmail)
    .first<{ id: number }>();

  const grnId = inserted!.id;
  const variances: Array<{ description: string; ordered: number; received: number; variance: number }> = [];

  for (const item of lineItems) {
    const matchedPoLine = item.matched_description
      ? poLineItems.find((p) => p.description.toLowerCase() === item.matched_description!.toLowerCase())
      : null;
    const orderedQty = matchedPoLine?.quantity_ordered ?? null;
    // The real, deterministic point of this whole feature — a
    // quantity variance, computed here, in code, never asked of the
    // model.
    const variance = orderedQty != null ? item.quantity_received - orderedQty : null;
    await env.OFFICE_DB.prepare(
      "INSERT INTO grn_line_items (grn_id, po_line_item_id, description, quantity_received, quantity_ordered, variance) VALUES (?, ?, ?, ?, ?, ?)"
    )
      .bind(
        grnId,
        matchedPoLine?.id ?? null,
        matchedPoLine?.description ?? item.matched_description ?? "unmatched item",
        item.quantity_received,
        orderedQty,
        variance
      )
      .run();
    if (orderedQty != null && variance != null) {
      variances.push({
        description: matchedPoLine!.description,
        ordered: orderedQty,
        received: item.quantity_received,
        variance,
      });
    }
  }

  return { grnId, variances };
}

// Real feature 2026-07-21 — Supplier Invoices, the third and final
// stage of the real, three-way design pinned in DECISIONS.md. This is
// where real money moves, and where both real reconciliations this
// whole arc exists for actually happen — quantity billed against
// quantity ordered, and price billed against price expected, both
// computed here, in code, never asked of the model. Creates a real
// expense on confirmation, linked back to the supplier, the same way
// every other real cost in this project is recorded.
export async function recordSupplierInvoice(
  env: Env,
  purchaseOrderId: number | null,
  supplierId: number | null,
  supplierReference: string | null,
  sourceTranscript: string,
  lineItems: Array<{ matched_description: string | null; quantity_billed: number; unit_price_billed: number | null }>
): Promise<{
  supplierInvoiceId: number;
  totalAmount: number;
  expenseId: number;
  variances: Array<{
    description: string;
    quantityVariance: number | null;
    quantityVarianceVsOrdered: number | null;
    priceVariance: number | null;
  }>;
}> {
  const poLineItems = purchaseOrderId ? await getPurchaseOrderLineItems(env, purchaseOrderId) : [];

  let totalAmount = 0;
  const resolvedLineItems: Array<{
    poLineItemId: number | null;
    description: string;
    quantityBilled: number;
    unitPriceBilled: number | null;
    quantityVariance: number | null;
    quantityVarianceVsOrdered: number | null;
    priceVariance: number | null;
    lineTotal: number;
  }> = [];

  for (const item of lineItems) {
    const matchedPoLine = item.matched_description
      ? poLineItems.find((p) => p.description.toLowerCase() === item.matched_description!.toLowerCase())
      : null;
    // Real fix 2026-07-22, per the design refinement pinned the same
    // night: the primary quantity check is against what was actually
    // RECEIVED (the GRN), not just what was ordered (the PO). If a
    // supplier delivers 28 but bills for the 30 ordered, comparing
    // only against the PO shows zero variance and misses the real
    // problem — comparing against the GRN catches it. Summed across
    // every GRN line item for this PO line, since a real delivery can
    // arrive in more than one shipment. Falls back to the PO
    // comparison only when no GRN exists for this line at all (the
    // invoice arrived with no delivery note on file yet) - an honest,
    // different case, not silently treated the same.
    let totalReceived: number | null = null;
    if (matchedPoLine) {
      const received = await env.OFFICE_DB.prepare(
        "SELECT COALESCE(SUM(quantity_received), 0) as total FROM grn_line_items WHERE po_line_item_id = ?"
      )
        .bind(matchedPoLine.id)
        .first<{ total: number }>();
      // A real GRN might exist for this PO with zero rows matching
      // THIS specific line item — treated as "no GRN data for this
      // line" (null), not "received zero" (0), which would wrongly
      // flag every unbilled line as a full shortage.
      const hasAnyGrnForThisLine = await env.OFFICE_DB.prepare(
        "SELECT COUNT(*) as count FROM grn_line_items WHERE po_line_item_id = ?"
      )
        .bind(matchedPoLine.id)
        .first<{ count: number }>();
      totalReceived = (hasAnyGrnForThisLine?.count ?? 0) > 0 ? received?.total ?? 0 : null;
    }
    const quantityVarianceVsOrdered = matchedPoLine ? item.quantity_billed - matchedPoLine.quantity_ordered : null;
    const quantityVariance = totalReceived != null ? item.quantity_billed - totalReceived : quantityVarianceVsOrdered;
    const priceVariance =
      matchedPoLine && item.unit_price_billed != null && matchedPoLine.unit_price_expected != null
        ? item.unit_price_billed - matchedPoLine.unit_price_expected
        : null;
    // Real, effective rate for computing a genuine total even when a
    // specific line has no billed price — falls back to the PO's
    // expected rate, never invents one from nothing.
    const effectiveRate = item.unit_price_billed ?? matchedPoLine?.unit_price_expected ?? 0;
    const lineTotal = item.quantity_billed * effectiveRate;
    totalAmount += lineTotal;
    resolvedLineItems.push({
      poLineItemId: matchedPoLine?.id ?? null,
      description: matchedPoLine?.description ?? item.matched_description ?? "unmatched item",
      quantityBilled: item.quantity_billed,
      unitPriceBilled: item.unit_price_billed,
      quantityVariance,
      quantityVarianceVsOrdered,
      priceVariance,
      lineTotal,
    });
  }

  const insertedInvoice = await env.OFFICE_DB.prepare(
    "INSERT INTO supplier_invoices (purchase_order_id, supplier_id, supplier_reference, amount, source_transcript) VALUES (?, ?, ?, ?, ?) RETURNING id"
  )
    .bind(purchaseOrderId, supplierId, supplierReference, totalAmount, sourceTranscript)
    .first<{ id: number }>();

  const supplierInvoiceId = insertedInvoice!.id;

  for (const item of resolvedLineItems) {
    await env.OFFICE_DB.prepare(
      "INSERT INTO supplier_invoice_line_items (supplier_invoice_id, po_line_item_id, description, quantity_billed, unit_price_billed, quantity_variance, price_variance, line_total) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    )
      .bind(
        supplierInvoiceId,
        item.poLineItemId,
        item.description,
        item.quantityBilled,
        item.unitPriceBilled,
        item.quantityVariance,
        item.priceVariance,
        item.lineTotal
      )
      .run();
  }

  // Real expense created here, on confirmation - the same real cost
  // recording every other supplier payment in this project already
  // goes through, not a parallel, competing system.
  const expense = await recordExpense(
    env,
    supplierId,
    totalAmount,
    supplierReference ? `Supplier invoice ${supplierReference}` : "Supplier invoice",
    sourceTranscript
  );

  return {
    supplierInvoiceId,
    totalAmount,
    expenseId: expense.id,
    variances: resolvedLineItems
      .filter((i) => i.quantityVariance != null || i.priceVariance != null)
      .map((i) => ({
        description: i.description,
        quantityVariance: i.quantityVariance,
        quantityVarianceVsOrdered: i.quantityVarianceVsOrdered,
        priceVariance: i.priceVariance,
      })),
  };
}

// No reference-number system exists yet — with one customer generally
// having at most one open quote at a time, "their most recent
// not-yet-converted quote" is honest and sufficient for now. A real
// reference-number lookup is a reasonable refinement once someone
// actually has multiple simultaneous open quotes — not needed yet.
export async function findLatestOpenQuotation(
  env: Env,
  customerId: number
): Promise<{ id: number; amount: number; description: string } | null> {
  const row = await env.OFFICE_DB.prepare(
    "SELECT id, amount, description FROM quotations WHERE customer_id = ? AND status != 'converted' ORDER BY created_at DESC LIMIT 1"
  )
    .bind(customerId)
    .first<{ id: number; amount: number; description: string }>();
  return row ?? null;
}

// The read side of the job_scopes -> quotation link. No status column
// on job_scopes yet and no reference-number system — same honest
// simplification as findLatestOpenQuotation above: "their most recent
// recorded job scope" is sufficient while one customer generally has
// at most one open, unpriced job at a time. Returns the real
// components and tasks so extractScopePricing has real names to match
// spoken rates against, never invented ones.
export async function findLatestJobScope(
  env: Env,
  customerId: number
): Promise<{
  id: number;
  description: string;
  components: Array<{ id: number; name: string; area_sqm: number | null }>;
  tasks: Array<{ id: number; description: string }>;
} | null> {
  const scope = await env.OFFICE_DB.prepare(
    "SELECT id, description FROM job_scopes WHERE customer_id = ? ORDER BY created_at DESC LIMIT 1"
  )
    .bind(customerId)
    .first<{ id: number; description: string }>();
  if (!scope) return null;

  const { results: components } = await env.OFFICE_DB.prepare(
    "SELECT id, name, area_sqm FROM scope_components WHERE job_scope_id = ?"
  )
    .bind(scope.id)
    .all<{ id: number; name: string; area_sqm: number | null }>();

  const { results: tasks } = await env.OFFICE_DB.prepare(
    "SELECT id, description FROM scope_tasks WHERE job_scope_id = ?"
  )
    .bind(scope.id)
    .all<{ id: number; description: string }>();

  return { id: scope.id, description: scope.description, components: components ?? [], tasks: tasks ?? [] };
}

// The actual, guarded conversion. total/depositAmount/remainingBalance
// are computed once, in processTranscript, before this is ever held
// for confirmation — this function only ever writes numbers that were
// already decided, the same pattern as recordInvoice and
// recordQuotation. The deposit math itself is never something Kimi
// calculates — it identifies that a deposit was mentioned and what
// percentage; the multiplication and subtraction happen here, in code.
export async function convertQuoteToInvoice(
  env: Env,
  quotationId: number,
  customerId: number,
  description: string,
  remainingBalance: number,
  sourceTranscript: string
): Promise<{ invoiceId: number }> {
  // Same real, deterministic retention lookup as recordInvoice - a
  // real invoice created via conversion deserves the same treatment
  // as one created directly, for the same customer's standing rate.
  const customer = await env.OFFICE_DB.prepare("SELECT retention_percent FROM customers WHERE id = ?")
    .bind(customerId)
    .first<{ retention_percent: number | null }>();
  const retentionPercent = customer?.retention_percent ?? null;
  const retentionAmount = retentionPercent ? Math.round(remainingBalance * (retentionPercent / 100) * 100) / 100 : 0;

  const inserted = await env.OFFICE_DB.prepare(
    "INSERT INTO invoices (customer_id, description, amount, source_transcript, quotation_id, retention_percent, retention_amount) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id"
  )
    .bind(customerId, description, remainingBalance, sourceTranscript, quotationId, retentionPercent, retentionAmount)
    .first<{ id: number }>();

  const invoiceId = inserted!.id;

  await env.OFFICE_DB.prepare(
    "INSERT INTO line_items (invoice_id, description, quantity, unit_price, line_total) VALUES (?, ?, 1, ?, ?)"
  )
    .bind(invoiceId, description, remainingBalance, remainingBalance)
    .run();

  await env.OFFICE_DB.prepare("UPDATE quotations SET status = 'converted' WHERE id = ?").bind(quotationId).run();

  return { invoiceId };
}

// The real answer to "who owes me money" — a provable SQL aggregate,
// not an LLM's guess at what a sentence meant. Simplest honest first
// version: total invoiced per customer minus total paid per customer,
// not matched to specific invoices. Good enough for a real answer
// today; per-invoice reconciliation is a harder problem for later,
// once there's evidence it's actually needed.
export async function getOutstandingInvoices(env: Env): Promise<string[]> {
  const { results } = await env.OFFICE_DB.prepare(
    `SELECT c.name as name,
            COALESCE(SUM(i.amount), 0) as invoiced,
            COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.customer_id = c.id), 0) as paid
     FROM customers c
     JOIN invoices i ON i.customer_id = c.id
     GROUP BY c.id
     HAVING invoiced > paid`
  ).all<{ name: string; invoiced: number; paid: number }>();

  return results.map((r) => `${r.name} owes R${r.invoiced - r.paid} (invoiced R${r.invoiced}, paid R${r.paid}).`);
}

// Real gap found live 2026-07-10: business-scope lookups only ever
// fetched outstanding invoices — "how many quotations do we have"
// got fed nothing about quotations at all and honestly (but wrongly)
// said "I don't have that on file," despite six real quotations
// existing. Same class of bug as getCustomerFinancialSummary above,
// one level up: real data existed, nothing ever queried it for this
// scope of question.
export async function getQuotationsSummary(env: Env): Promise<string[]> {
  const { results } = await env.OFFICE_DB.prepare(
    `SELECT c.name as name, q.amount as amount, q.status as status
     FROM quotations q JOIN customers c ON c.id = q.customer_id
     ORDER BY q.created_at DESC`
  ).all<{ name: string; amount: number; status: string }>();

  if (results.length === 0) return ["No quotations on file."];

  const total = results.reduce((sum, r) => sum + r.amount, 0);
  const openCount = results.filter((r) => r.status !== "converted").length;
  const summary = `There are ${results.length} quotations on file, totaling R${total}. ${openCount} still open, not yet converted to an invoice.`;
  const perQuotation = results.map((r) => `${r.name}: R${r.amount} (${r.status}).`);
  return [summary, ...perQuotation];
}

// Real feature 2026-07-12 — the second concrete piece of the expense
// side of the accounting-capability roadmap, mirroring
// getQuotationsSummary's exact shape for consistency. Real, deterministic
// SQL aggregate, same as every other business-summary function here —
// never an AI attempting to recall or total these from memory.
export async function getExpenseSummary(env: Env): Promise<string[]> {
  const { results } = await env.OFFICE_DB.prepare(
    `SELECT COALESCE(c.name, 'an unnamed supplier') as name, e.amount as amount, e.description as description,
            COALESCE(e.category, 'uncategorized') as category
     FROM expenses e LEFT JOIN characters c ON c.id = e.character_id
     ORDER BY e.created_at DESC`
  ).all<{ name: string; amount: number | null; description: string; category: string }>();

  if (results.length === 0) return ["No expenses on file."];

  const total = results.reduce((sum, r) => sum + (r.amount ?? 0), 0);
  const summary = `There are ${results.length} expenses on file, totaling R${total}.`;

  const byCategory = new Map<string, number>();
  for (const r of results) {
    byCategory.set(r.category, (byCategory.get(r.category) ?? 0) + (r.amount ?? 0));
  }
  const categoryBreakdown = `By category: ${Array.from(byCategory.entries())
    .map(([cat, amt]) => `${cat} R${amt}`)
    .join(", ")}.`;

  const perExpense = results.map((r) => `${r.name}: R${r.amount ?? 0} — ${r.description} (${r.category}).`);
  return [summary, categoryBreakdown, ...perExpense];
}

// Real feature 2026-07-12 — the first real view reading BOTH sides of
// the accounting-capability roadmap (Principle 22) in one place.
// Deliberately, honestly NOT a P&L: no expense categories, no job-cost
// linking, no distinction between capital and operating spend exist
// yet — calling this "gross profit" or "net profit" would overclaim
// what's actually being computed. "Rough position" is cash-basis
// (paid, not merely invoiced) since that's the most concretely real
// number available — money that has actually moved, not what's owed
// on paper.
export async function getFinancialSnapshot(env: Env): Promise<string[]> {
  const [invoicedRow, paidRow, expensesRow] = await Promise.all([
    env.OFFICE_DB.prepare("SELECT COALESCE(SUM(amount), 0) as total FROM invoices").first<{ total: number }>(),
    env.OFFICE_DB.prepare("SELECT COALESCE(SUM(amount), 0) as total FROM payments").first<{ total: number }>(),
    env.OFFICE_DB.prepare("SELECT COALESCE(SUM(amount), 0) as total FROM expenses").first<{ total: number }>(),
  ]);

  const totalInvoiced = invoicedRow?.total ?? 0;
  const totalPaid = paidRow?.total ?? 0;
  const totalExpenses = expensesRow?.total ?? 0;
  const roughPosition = totalPaid - totalExpenses;

  return [
    `Total invoiced to date: R${totalInvoiced}.`,
    `Total actually received: R${totalPaid}.`,
    `Total spent on expenses: R${totalExpenses}.`,
    // Real fix 2026-07-12: this caveat had gone stale — expense
    // categories and job-cost linking both exist now. This is still
    // deliberately a cash-basis snapshot (received minus spent), not
    // the formal, accrual-based P&L below — different questions,
    // both real.
    `Rough cash position (received minus spent): R${roughPosition}. This is a cash-basis snapshot, not the formal profit and loss — see getProfitAndLoss for that.`,
  ];
}

export interface ProfitAndLossReport {
  revenue: number;
  costOfSales: number;
  grossProfit: number;
  operatingExpenses: number;
  netProfit: number;
  categoryBreakdown: Record<string, number>;
}

// Real feature 2026-07-12 — the final piece of the accounting-
// capability roadmap: a formal, business-wide profit-and-loss
// statement, built entirely from real data already sitting in real
// tables — nothing here is estimated or narrated by the model.
// Two real, explicit decisions worth naming rather than burying:
// (1) Revenue is ACCRUAL-based (real invoiced amounts), not cash —
// a P&L conventionally recognizes revenue when earned/billed, not
// when cash lands. That's genuinely different from
// getFinancialSnapshot's cash-basis "rough position" above — two
// real, different questions, not a contradiction between them.
// (2) Cost of Sales vs Operating Expenses is a real categorization
// convention, stated explicitly, not an infallible standard:
// materials and subcontractor costs are treated as Cost of Sales
// (directly tied to delivering the work); fuel, tools, other, and
// anything uncategorized are treated as Operating Expenses (running
// the business generally). Reasonable, not definitive — easily
// revisited later if real use shows a different split fits better.
export async function getProfitAndLoss(env: Env): Promise<ProfitAndLossReport> {
  const revenueRow = await env.OFFICE_DB.prepare("SELECT COALESCE(SUM(amount), 0) as total FROM invoices").first<{
    total: number;
  }>();
  const revenue = revenueRow?.total ?? 0;

  const { results: categoryRows } = await env.OFFICE_DB.prepare(
    "SELECT COALESCE(category, 'other') as category, COALESCE(SUM(amount), 0) as total FROM expenses GROUP BY COALESCE(category, 'other')"
  ).all<{ category: string; total: number }>();

  const categoryBreakdown: Record<string, number> = {};
  let costOfSales = 0;
  let operatingExpenses = 0;
  for (const row of categoryRows) {
    categoryBreakdown[row.category] = row.total;
    if (row.category === "materials" || row.category === "subcontractor") {
      costOfSales += row.total;
    } else {
      operatingExpenses += row.total;
    }
  }

  const grossProfit = revenue - costOfSales;
  const netProfit = grossProfit - operatingExpenses;

  return { revenue, costOfSales, grossProfit, operatingExpenses, netProfit, categoryBreakdown };
}

export async function getProfitAndLossSummary(env: Env): Promise<string[]> {
  const report = await getProfitAndLoss(env);
  const categoryLines = Object.entries(report.categoryBreakdown).map(([cat, amt]) => `${cat}: R${amt}`);

  return [
    `Revenue: R${report.revenue}.`,
    `Cost of Sales (materials, subcontractor): R${report.costOfSales}.`,
    `Gross Profit: R${report.grossProfit}.`,
    `Operating Expenses (fuel, tools, other): R${report.operatingExpenses}.`,
    `Net Profit: R${report.netProfit}.`,
    `Expense breakdown by category: ${categoryLines.join(", ")}.`,
    "Revenue here is accrual-based (real invoiced amounts), not cash received — a different measure from the cash-position snapshot.",
  ];
}

export interface AgedDebtorRow {
  customerId: number;
  customerName: string;
  current: number;
  days30: number;
  days60: number;
  days90Plus: number;
  total: number;
}

// Real feature 2026-07-12 — aged debtors analysis, the classic
// accounts-receivable report. Real, honest limitation disclosed
// rather than silently assumed away: payments in this schema link
// only to a customer, never to a specific invoice, so there's no way
// to know with certainty which invoice a given payment actually
// settled. FIFO allocation (oldest invoice paid first) is the
// standard, defensible convention every small-business system uses
// when payments aren't explicitly tied to invoices — applied here in
// code, deterministically, never left to the model to estimate.
// Bucketed by real invoice age in days: current (0-30), 30-60, 60-90,
// 90+.
export async function getAgedDebtorsReport(env: Env): Promise<AgedDebtorRow[]> {
  const { results: customers } = await env.OFFICE_DB.prepare(
    "SELECT DISTINCT c.id, c.name FROM customers c JOIN invoices i ON i.customer_id = c.id"
  ).all<{ id: number; name: string }>();

  const now = Date.now();
  const rows: AgedDebtorRow[] = [];

  for (const customer of customers) {
    const { results: invoices } = await env.OFFICE_DB.prepare(
      "SELECT amount, created_at FROM invoices WHERE customer_id = ? ORDER BY created_at ASC"
    )
      .bind(customer.id)
      .all<{ amount: number; created_at: string }>();

    const paidRow = await env.OFFICE_DB.prepare("SELECT COALESCE(SUM(amount), 0) as total FROM payments WHERE customer_id = ?")
      .bind(customer.id)
      .first<{ total: number }>();

    let remainingPayment = paidRow?.total ?? 0;
    let current = 0;
    let days30 = 0;
    let days60 = 0;
    let days90Plus = 0;

    for (const inv of invoices) {
      let owed = inv.amount;
      if (remainingPayment > 0) {
        const applied = Math.min(remainingPayment, owed);
        owed -= applied;
        remainingPayment -= applied;
      }
      if (owed <= 0) continue;

      const ageDays = Math.floor((now - new Date(inv.created_at).getTime()) / 86400000);
      if (ageDays <= 30) current += owed;
      else if (ageDays <= 60) days30 += owed;
      else if (ageDays <= 90) days60 += owed;
      else days90Plus += owed;
    }

    const total = current + days30 + days60 + days90Plus;
    if (total > 0) {
      rows.push({ customerId: customer.id, customerName: customer.name, current, days30, days60, days90Plus, total });
    }
  }

  return rows.sort((a, b) => b.total - a.total);
}

export async function getAgedDebtorsSummary(env: Env): Promise<string[]> {
  const rows = await getAgedDebtorsReport(env);
  if (rows.length === 0) return ["No outstanding debtors on file."];

  const totals = rows.reduce(
    (acc, r) => ({
      current: acc.current + r.current,
      days30: acc.days30 + r.days30,
      days60: acc.days60 + r.days60,
      days90Plus: acc.days90Plus + r.days90Plus,
    }),
    { current: 0, days30: 0, days60: 0, days90Plus: 0 }
  );

  const summary =
    `Aged debtors: current R${totals.current}, 30-60 days R${totals.days30}, ` +
    `60-90 days R${totals.days60}, 90+ days R${totals.days90Plus}. ` +
    `Payments are allocated oldest-invoice-first (FIFO), since payments aren't linked to a specific invoice.`;

  const perCustomer = rows.map(
    (r) =>
      `${r.customerName}: R${r.total} total overdue (current R${r.current}, 30-60d R${r.days30}, 60-90d R${r.days60}, 90+d R${r.days90Plus}).`
  );

  return [summary, ...perCustomer];
}

// The real fix for "what's Sarah's balance" answering wrong — a
// single customer's balance was only ever being searched for in
// narrative notes, never computed from the actual invoices/payments
// tables the way the business-wide "who owes me money" query already
// does. Honest about the case where payments exist with no invoice
// (Sarah paid R500 with nothing invoiced against her) rather than
// fabricating a balance-owed figure that doesn't cleanly apply.
export async function getCustomerFinancialSummary(env: Env, customerId: number): Promise<string | null> {
  const row = await env.OFFICE_DB.prepare(
    `SELECT
       COALESCE((SELECT SUM(amount) FROM invoices WHERE customer_id = ?), 0) as invoiced,
       COALESCE((SELECT SUM(amount) FROM payments WHERE customer_id = ?), 0) as paid`
  )
    .bind(customerId, customerId)
    .first<{ invoiced: number; paid: number }>();

  if (!row || (row.invoiced === 0 && row.paid === 0)) return null;

  const balance = row.invoiced - row.paid;
  if (row.invoiced === 0) {
    return `No invoices on file, but R${row.paid} in payments recorded — nothing currently invoiced to balance against.`;
  }
  if (balance > 0) return `Owes R${balance} (invoiced R${row.invoiced}, paid R${row.paid}).`;
  if (balance < 0) return `Has paid R${-balance} more than invoiced (invoiced R${row.invoiced}, paid R${row.paid}).`;
  return `Fully paid up (invoiced R${row.invoiced}, paid R${row.paid}).`;
}

// Real feature 2026-07-12 — the actual payoff of job-cost linking:
// real revenue invoiced against this customer minus real expenses
// explicitly linked to this job. Deliberately honest about its own
// limitation: only expenses that had job context stated at the time
// ("...for Jenny's job") are counted here — an expense recorded
// without that context contributes to the business-wide totals
// (getFinancialSnapshot) but not to any specific job's profitability,
// since there's nothing here to guess which job it was really for.
// Real fix 2026-07-12: the caveat used to be baked into one combined
// string handed to the model as a "fact" — and the model's own
// relevance-filtering reliably stripped it out during synthesis,
// twice in a row, live. The caveat is a necessary qualifier on the
// number itself, not extraneous context to weigh and possibly drop —
// split apart so the caller can append it deterministically, same
// fix pattern as the aged-debtors capability hint.
export async function getJobProfitability(
  env: Env,
  customerId: number
): Promise<{ fact: string; caveat: string } | null> {
  const row = await env.OFFICE_DB.prepare(
    `SELECT
       COALESCE((SELECT SUM(amount) FROM invoices WHERE customer_id = ?), 0) as revenue,
       COALESCE((SELECT SUM(amount) FROM expenses WHERE customer_id = ?), 0) as cost`
  )
    .bind(customerId, customerId)
    .first<{ revenue: number; cost: number }>();

  if (!row || (row.revenue === 0 && row.cost === 0)) return null;

  const profit = row.revenue - row.cost;
  return {
    fact: `Revenue R${row.revenue}, costs linked to this job R${row.cost}, profit R${profit}.`,
    caveat:
      "Only expenses explicitly linked to this job are counted — an expense recorded without job context isn't included, since there's no way to know which job it was really for.",
  };
}

export interface StatementLine {
  date: string;
  type: "invoice" | "payment";
  description: string;
  amount: number;
  runningBalance: number;
}

// Real feature 2026-07-12 — the foundational piece the rest of the
// financial-reporting roadmap (aged analysis, exports) builds on: a
// real, chronological transaction history for one customer, with a
// running balance computed deterministically in code, never asked of
// the model. Every invoice adds to the balance; every payment
// subtracts — the same arithmetic already governing every other real
// number in this system.
export async function getCustomerStatementData(env: Env, customerId: number): Promise<StatementLine[]> {
  const { results: invoiceRows } = await env.OFFICE_DB.prepare(
    "SELECT id, description, amount, created_at FROM invoices WHERE customer_id = ? ORDER BY created_at"
  )
    .bind(customerId)
    .all<{ id: number; description: string; amount: number; created_at: string }>();

  const { results: paymentRows } = await env.OFFICE_DB.prepare(
    "SELECT id, amount, created_at FROM payments WHERE customer_id = ? ORDER BY created_at"
  )
    .bind(customerId)
    .all<{ id: number; amount: number | null; created_at: string }>();

  type RawEntry = { date: string; type: "invoice" | "payment"; description: string; amount: number };
  const entries: RawEntry[] = [
    ...invoiceRows.map((r) => ({
      date: r.created_at,
      type: "invoice" as const,
      description: `Invoice #${r.id} — ${r.description}`,
      amount: r.amount,
    })),
    ...paymentRows.map((r) => ({
      date: r.created_at,
      type: "payment" as const,
      description: `Payment received`,
      amount: r.amount ?? 0,
    })),
  ];

  entries.sort((a, b) => a.date.localeCompare(b.date));

  let balance = 0;
  return entries.map((e) => {
    balance += e.type === "invoice" ? e.amount : -e.amount;
    return { ...e, runningBalance: balance };
  });
}

// guard(): every money-touching intent lands here, not in the real
// ledger, until it's explicitly confirmed. Also reused for
// schema-candidate suggestions below — same mechanism, same
// discipline: the system proposes, a human decides, nothing
// consequential happens automatically.
export async function holdForConfirmation(
  env: Env,
  type: string,
  payload: Record<string, unknown>,
  sourceTranscript: string
): Promise<{ id: number }> {
  const inserted = await env.OFFICE_DB.prepare(
    "INSERT INTO pending_actions (type, payload, source_transcript) VALUES (?, ?, ?) RETURNING id"
  )
    .bind(type, JSON.stringify(payload), sourceTranscript)
    .first<{ id: number }>();

  return { id: inserted!.id };
}

// Real, structured data becomes a real PDF — same reasoning as the
// docx approach already proven elsewhere: pure JS, no native deps,
// runs directly in the Workers isolate. Subtotal is recomputed fresh
// from line_items here, not read from invoices.amount — the line
// items are the actual ground truth; a cached total is a convenience,
// Real feature 2026-07-11 — the actual missing piece underneath "Peter
// taps Send via WhatsApp" (Principle 20, One Office, Many Doors): a
// real, natural message a human would send, not just a raw pdfUrl.
// Deliberately deterministic, not an AI call — this is genuinely a
// narration task, but a reliably template-able one with real data
// already on hand (customer name, business name, amount, document
// type), so there's nothing here that actually needs language
// flexibility. First name only, for the same warmth a real person
// would use texting a customer, not a formal full-name greeting.
export async function generateShareMessage(
  env: Env,
  kind: "invoice" | "quotation",
  customerName: string,
  amount: number,
  pdfUrl: string
): Promise<string> {
  const business = await env.OFFICE_DB.prepare("SELECT name, trading_as FROM business_profile WHERE id = 1").first<{
    name: string | null;
    trading_as: string | null;
  }>();
  const businessName = business?.trading_as ?? business?.name ?? "us";
  const firstName = customerName.trim().split(/\s+/)[0];
  const label = kind === "invoice" ? "invoice" : "quote";
  return `Hi ${firstName}, here's your ${label} from ${businessName} — ${formatRand(amount)}. View it here: ${pdfUrl}`;
}

// Principle 21's explicitly-legitimate exception, not a step toward
// collapsing the three document-producing confirm branches into one
// executor: invoice, quotation, and convert_quote all report the SAME
// KIND of result (a real document), so they share the one small piece
// of code that shapes that result. The three capabilities otherwise
// stay completely independent — their execute() steps (recordInvoice,
// recordQuotation, convertQuoteToInvoice) remain separate on purpose.
// Real feature 2026-07-11: this is also where the execution register
// gets written for documents — proving the register generalizes to a
// third and fourth selection type (quotation, invoice) exactly as
// designed (Principle 16), using the exact same setSelection function
// already proven for customer/character, no new code needed there at
// all. Register writing belongs in the report stage, the same reason
// it already happens for customer/character in processTranscript.
export async function buildDocumentResponse(
  env: Env,
  origin: string,
  kind: "invoice" | "quotation",
  documentId: number,
  customerName: string | undefined,
  amount: number
): Promise<{ pdfUrl: string; shareMessage: string | null }> {
  const pdfUrl = `${origin}/${kind}s/${documentId}/pdf`;
  const shareMessage = customerName ? await generateShareMessage(env, kind, customerName, amount, pdfUrl) : null;
  const label = customerName ? `${kind} for ${customerName} (${formatRand(amount)})` : `${kind} (${formatRand(amount)})`;
  await setSelection(env, kind, documentId, label);
  return { pdfUrl, shareMessage };
}

// not the source of it. VAT applies from the business's current
// default; a genuine per-invoice override is a real refinement for
// later, once there's evidence it's actually needed.
// Generalized from the original invoice-only version — quotations
// never had PDF support at all, discovered live 2026-07-10 when asked
// for a real quotation document that simply didn't exist yet. Same
// business header, same line-item table, same subtotal/VAT/total math
// either way; only the title, document number, and source table
// differ.
export async function generateDocumentPdf(env: Env, id: number, kind: "invoice" | "quotation"): Promise<Uint8Array> {
  const business = await env.OFFICE_DB.prepare("SELECT * FROM business_profile WHERE id = 1").first<{
    name: string | null;
    trading_as: string | null;
    vat_no: string | null;
    address: string | null;
    phone: string | null;
    email: string | null;
    banking_details: string | null;
    vat_registered: number;
    vat_rate: number;
  }>();

  const table = kind === "invoice" ? "invoices" : "quotations";
  const lineItemColumn = kind === "invoice" ? "invoice_id" : "quotation_id";
  // Real feature 2026-07-21 - retention only exists on invoices, not
  // quotations (it's withheld from a billed amount, never a proposed
  // one) - selected conditionally since this query shares one dynamic
  // table name between both document kinds.
  const retentionColumn = kind === "invoice" ? ", d.retention_amount" : ", NULL as retention_amount";

  const doc = await env.OFFICE_DB.prepare(
    `SELECT d.id, d.description, d.status, d.created_at, d.amount, c.name as customer_name, c.address as customer_address, c.vat_exempt${retentionColumn} FROM ${table} d JOIN customers c ON c.id = d.customer_id WHERE d.id = ?`
  )
    .bind(id)
    .first<{
      id: number;
      description: string;
      status: string;
      created_at: string;
      amount: number;
      customer_name: string;
      customer_address: string | null;
      vat_exempt: number | null;
      retention_amount: number | null;
    }>();

  if (!doc) {
    throw new Error(`no such ${kind}: ${id}`);
  }

  const { results: lineItems } = await env.OFFICE_DB.prepare(
    `SELECT description, quantity, unit_price, line_total, discount_percent FROM line_items WHERE ${lineItemColumn} = ?`
  )
    .bind(id)
    .all<{ description: string; quantity: number; unit_price: number; line_total: number; discount_percent: number | null }>();

  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([595.28, 841.89]); // A4
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const grey = rgb(0.45, 0.45, 0.45);
  const black = rgb(0, 0, 0);

  let y = 792;
  const left = 50;
  const right = 400;

  page.drawText(business?.name ?? "[Business name not set]", { x: left, y, size: 14, font: bold });
  y -= 18;
  if (business?.trading_as) {
    page.drawText(`T/A ${business.trading_as}`, { x: left, y, size: 10, font });
    y -= 14;
  }
  if (business?.vat_no) {
    page.drawText(`VAT No: ${business.vat_no}`, { x: left, y, size: 10, font });
    y -= 14;
  }
  if (business?.address) {
    page.drawText(business.address, { x: left, y, size: 10, font });
    y -= 14;
  }
  if (business?.phone) {
    page.drawText(business.phone, { x: left, y, size: 10, font });
    y -= 14;
  }
  if (business?.email) {
    page.drawText(business.email, { x: left, y, size: 10, font });
    y -= 14;
  }
  const leftEndY = y;

  let yRight = 792;
  page.drawText("BILL TO", { x: right, y: yRight, size: 9, font: bold, color: grey });
  yRight -= 14;
  page.drawText(doc.customer_name, { x: right, y: yRight, size: 12, font: bold });
  yRight -= 14;
  if (doc.customer_address) {
    page.drawText(doc.customer_address, { x: right, y: yRight, size: 10, font });
    yRight -= 14;
  }

  y = Math.min(leftEndY, yRight) - 30;

  const title = kind === "invoice" ? "TAX INVOICE" : "QUOTATION";
  const label = kind === "invoice" ? "Invoice" : "Quotation";
  page.drawText(title, { x: left, y, size: 16, font: bold });
  page.drawText(`${label} #${doc.id}`, { x: right, y, size: 10, font, color: grey });
  y -= 30;

  page.drawText("DESCRIPTION", { x: left, y, size: 9, font: bold, color: grey });
  page.drawText("QTY", { x: 340, y, size: 9, font: bold, color: grey });
  page.drawText("RATE", { x: 400, y, size: 9, font: bold, color: grey });
  page.drawText("AMOUNT", { x: 480, y, size: 9, font: bold, color: grey });
  y -= 8;
  page.drawLine({ start: { x: left, y }, end: { x: 545, y }, thickness: 1, color: grey });
  y -= 18;

  let subtotal = 0;
  for (const item of lineItems) {
    // Real feature 2026-07-17: shown as a clear annotation next to
    // the description rather than a new column, to avoid reworking
    // the whole layout's fixed column positions for what's still a
    // relatively rare case.
    const descriptionWithDiscount =
      item.discount_percent != null ? `${item.description} (${item.discount_percent}% off)` : item.description;
    page.drawText(descriptionWithDiscount, { x: left, y, size: 10, font, maxWidth: 270 });
    page.drawText(String(item.quantity), { x: 340, y, size: 10, font });
    page.drawText(`${formatRand(item.unit_price)}`, { x: 400, y, size: 10, font });
    page.drawText(`${formatRand(item.line_total)}`, { x: 480, y, size: 10, font });
    subtotal += item.line_total;
    y -= 22;
  }

  // Real fix 2026-07-21 — a serious, pre-existing bug surfaced by
  // retention testing: a flat, single-amount document (no itemized
  // breakdown, e.g. "invoice Jenny for R3200") had no line items at
  // all, and subtotal — computed purely by summing them — silently
  // showed R0 regardless of the document's real, stored amount. Every
  // flat invoice or quotation has shown this wrong figure since before
  // today; nobody had generated and actually read one closely enough
  // to notice, since every prior real test used line-item-based
  // pricing. Falls back to the document's own real, stored amount as
  // a single implicit line when no real line items exist.
  if (lineItems.length === 0 && doc.amount > 0) {
    page.drawText(doc.description, { x: left, y, size: 10, font, maxWidth: 270 });
    page.drawText(`${formatRand(doc.amount)}`, { x: 480, y, size: 10, font });
    subtotal = doc.amount;
    y -= 22;
  }

  y -= 8;
  page.drawLine({ start: { x: 380, y: y + 12 }, end: { x: 545, y: y + 12 }, thickness: 0.5, color: grey });

  page.drawText("SUBTOTAL", { x: 400, y, size: 10, font: bold });
  page.drawText(`${formatRand(subtotal)}`, { x: 480, y, size: 10, font });
  y -= 16;

  let vatAmount = 0;
  // Real feature 2026-07-21 - a customer's real, standing vat_exempt
  // status overrides the business-wide default entirely for their own
  // documents - concrete, real evidence behind this one: Zululand
  // Flooring genuinely operates with VAT for some clients, not others.
  const customerIsExempt = doc.vat_exempt === 1;
  if (business?.vat_registered && !customerIsExempt) {
    vatAmount = subtotal * ((business.vat_rate ?? 15) / 100);
    page.drawText(`VAT (${business.vat_rate}%)`, { x: 400, y, size: 10, font });
    // Real fix, caught while adding this feature: this line used
    // .toFixed(2) directly rather than the formatRand helper already
    // proven for every other currency figure - missed by the earlier
    // fix since that regex only matched .toLocaleString() patterns.
    page.drawText(`${formatRand(vatAmount)}`, { x: 480, y, size: 10, font });
    y -= 16;
  }

  const total = subtotal + vatAmount;
  page.drawText("TOTAL", { x: 400, y, size: 12, font: bold });
  // Real fix, caught while adding this feature - the same missed spot
  // as the VAT line: .toFixed(2) directly instead of the formatRand
  // helper already proven for every other currency figure.
  page.drawText(`${formatRand(total)}`, { x: 480, y, size: 12, font: bold, color: black });
  y -= 20;

  // Real feature 2026-07-21 - a real, urgent need: an active
  // two-year contract in its final stage. Standard, industry-correct
  // presentation - the full total stays the full total; retention is
  // shown as a real, separate deduction, with a distinct "amount due
  // now" line for what's actually payable today. The withheld amount
  // itself is never lost - it's a real, tracked figure, still owed,
  // just not due yet.
  const retentionAmount = doc.retention_amount ?? 0;
  if (kind === "invoice" && retentionAmount > 0) {
    page.drawText("RETENTION WITHHELD", { x: 400, y, size: 10, font, color: grey });
    page.drawText(`-${formatRand(retentionAmount)}`, { x: 480, y, size: 10, font, color: grey });
    y -= 16;
    page.drawText("AMOUNT DUE NOW", { x: 400, y, size: 12, font: bold });
    page.drawText(`${formatRand(total - retentionAmount)}`, { x: 480, y, size: 12, font: bold, color: black });
    y -= 20;
  }
  y -= 20;

  if (kind === "quotation") {
    page.drawText("Quote valid for 7 days unless otherwise specified.", { x: left, y, size: 9, font, color: grey });
    y -= 20;
  }

  if (business?.banking_details) {
    page.drawText("Payment Info", { x: left, y, size: 11, font: bold });
    y -= 16;
    page.drawText(business.banking_details, { x: left, y, size: 9, font, maxWidth: 300 });
  }

  return await pdfDoc.save();
}

// Real feature 2026-07-12 — the first exportable report beyond a
// single quotation/invoice: a real statement of account, every
// transaction for one customer, chronological, with the running
// balance already computed by getCustomerStatementData. Mirrors
// generateDocumentPdf's exact visual style deliberately, so Peter's
// documents look like they came from the same business — genuine
// duplication of the header-drawing code accepted for now rather than
// a premature shared-helper abstraction; worth revisiting only if a
// third document type reveals the same repeated pattern.
export async function generateStatementPdf(env: Env, customerId: number): Promise<Uint8Array> {
  const business = await env.OFFICE_DB.prepare("SELECT * FROM business_profile WHERE id = 1").first<{
    name: string | null;
    trading_as: string | null;
    vat_no: string | null;
    address: string | null;
    phone: string | null;
    email: string | null;
    banking_details: string | null;
  }>();

  const customer = await env.OFFICE_DB.prepare("SELECT name, address FROM customers WHERE id = ?")
    .bind(customerId)
    .first<{ name: string; address: string | null }>();

  if (!customer) {
    throw new Error(`no such customer: ${customerId}`);
  }

  const lines = await getCustomerStatementData(env, customerId);

  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const grey = rgb(0.45, 0.45, 0.45);
  const black = rgb(0, 0, 0);

  const pageWidth = 595.28;
  const pageHeight = 841.89;
  const left = 50;
  const right = 400;

  let page = pdfDoc.addPage([pageWidth, pageHeight]);
  let y = 792;

  const drawHeader = () => {
    page.drawText(business?.name ?? "[Business name not set]", { x: left, y, size: 14, font: bold });
    y -= 18;
    if (business?.trading_as) {
      page.drawText(`T/A ${business.trading_as}`, { x: left, y, size: 10, font });
      y -= 14;
    }
    if (business?.vat_no) {
      page.drawText(`VAT No: ${business.vat_no}`, { x: left, y, size: 10, font });
      y -= 14;
    }
    if (business?.address) {
      page.drawText(business.address, { x: left, y, size: 10, font });
      y -= 14;
    }
    const leftEndY = y;

    let yRight = 792;
    page.drawText("STATEMENT FOR", { x: right, y: yRight, size: 9, font: bold, color: grey });
    yRight -= 14;
    page.drawText(customer.name, { x: right, y: yRight, size: 12, font: bold });
    yRight -= 14;
    if (customer.address) {
      page.drawText(customer.address, { x: right, y: yRight, size: 10, font });
      yRight -= 14;
    }

    y = Math.min(leftEndY, yRight) - 30;
    page.drawText("STATEMENT OF ACCOUNT", { x: left, y, size: 16, font: bold });
    y -= 30;

    page.drawText("DATE", { x: left, y, size: 9, font: bold, color: grey });
    page.drawText("DESCRIPTION", { x: 130, y, size: 9, font: bold, color: grey });
    page.drawText("AMOUNT", { x: 420, y, size: 9, font: bold, color: grey });
    page.drawText("BALANCE", { x: 490, y, size: 9, font: bold, color: grey });
    y -= 8;
    page.drawLine({ start: { x: left, y }, end: { x: 545, y }, thickness: 1, color: grey });
    y -= 18;
  };

  drawHeader();

  if (lines.length === 0) {
    page.drawText("No transactions on file for this customer.", { x: left, y, size: 10, font, color: grey });
  }

  for (const line of lines) {
    // Basic pagination — a real customer with many transactions
    // shouldn't run off the bottom of one page.
    if (y < 80) {
      page = pdfDoc.addPage([pageWidth, pageHeight]);
      y = 792;
      drawHeader();
    }
    const dateOnly = line.date.slice(0, 10);
    const signedAmount = line.type === "invoice" ? line.amount : -line.amount;
    page.drawText(dateOnly, { x: left, y, size: 9, font });
    page.drawText(line.description, { x: 130, y, size: 9, font, maxWidth: 280 });
    page.drawText(`${formatRand(signedAmount)}`, { x: 420, y, size: 9, font });
    page.drawText(`${formatRand(line.runningBalance)}`, { x: 490, y, size: 9, font, color: black });
    y -= 20;
  }

  y -= 10;
  page.drawLine({ start: { x: 420, y: y + 12 }, end: { x: 545, y: y + 12 }, thickness: 0.5, color: grey });
  const closingBalance = lines.length > 0 ? lines[lines.length - 1].runningBalance : 0;
  // Real fix found live 2026-07-19, testing this report against real
  // data: "BALANCE DUE" is nonsensical when the figure is negative —
  // a customer can't be "due" a negative amount. When payments exceed
  // invoiced amounts, that's a real credit, stated plainly, showing
  // the absolute value rather than a confusing negative under a label
  // that assumes the opposite case.
  const isCredit = closingBalance < 0;
  page.drawText(isCredit ? "CREDIT BALANCE" : "BALANCE DUE", { x: 420, y, size: 11, font: bold });
  page.drawText(`${formatRand(Math.abs(closingBalance))}`, { x: 490, y, size: 11, font: bold, color: black });

  return await pdfDoc.save();
}

// Real feature 2026-07-12 — the aged debtors report, exportable, same
// visual family as the other two document generators. Real FIFO
// allocation disclosed directly on the page itself, not buried in a
// footnote — anyone reading this report should know exactly what
// assumption produced these numbers.
export async function generateAgedDebtorsPdf(env: Env): Promise<Uint8Array> {
  const business = await env.OFFICE_DB.prepare("SELECT name, trading_as, vat_no, address FROM business_profile WHERE id = 1").first<{
    name: string | null;
    trading_as: string | null;
    vat_no: string | null;
    address: string | null;
  }>();

  const rows = await getAgedDebtorsReport(env);

  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const grey = rgb(0.45, 0.45, 0.45);
  const black = rgb(0, 0, 0);

  const pageWidth = 595.28;
  const pageHeight = 841.89;
  const left = 50;

  let page = pdfDoc.addPage([pageWidth, pageHeight]);
  let y = 792;

  const drawHeader = () => {
    page.drawText(business?.name ?? "[Business name not set]", { x: left, y, size: 14, font: bold });
    y -= 18;
    if (business?.trading_as) {
      page.drawText(`T/A ${business.trading_as}`, { x: left, y, size: 10, font });
      y -= 14;
    }
    y -= 16;
    page.drawText("AGED DEBTORS ANALYSIS", { x: left, y, size: 16, font: bold });
    y -= 16;
    page.drawText(
      "Payments are allocated oldest-invoice-first (FIFO) — payments aren't linked to a specific invoice in this system.",
      { x: left, y, size: 8, font, color: grey, maxWidth: 495 }
    );
    y -= 26;

    page.drawText("CUSTOMER", { x: left, y, size: 9, font: bold, color: grey });
    page.drawText("CURRENT", { x: 230, y, size: 9, font: bold, color: grey });
    page.drawText("30-60", { x: 300, y, size: 9, font: bold, color: grey });
    page.drawText("60-90", { x: 360, y, size: 9, font: bold, color: grey });
    page.drawText("90+", { x: 420, y, size: 9, font: bold, color: grey });
    page.drawText("TOTAL", { x: 480, y, size: 9, font: bold, color: grey });
    y -= 8;
    page.drawLine({ start: { x: left, y }, end: { x: 545, y }, thickness: 1, color: grey });
    y -= 18;
  };

  drawHeader();

  if (rows.length === 0) {
    page.drawText("No outstanding debtors on file.", { x: left, y, size: 10, font, color: grey });
  }

  const totals = { current: 0, days30: 0, days60: 0, days90Plus: 0, total: 0 };

  for (const row of rows) {
    if (y < 80) {
      page = pdfDoc.addPage([pageWidth, pageHeight]);
      y = 792;
      drawHeader();
    }
    page.drawText(row.customerName, { x: left, y, size: 9, font, maxWidth: 175 });
    page.drawText(`${formatRand(row.current)}`, { x: 230, y, size: 9, font });
    page.drawText(`${formatRand(row.days30)}`, { x: 300, y, size: 9, font });
    page.drawText(`${formatRand(row.days60)}`, { x: 360, y, size: 9, font });
    page.drawText(`${formatRand(row.days90Plus)}`, { x: 420, y, size: 9, font });
    page.drawText(`${formatRand(row.total)}`, { x: 480, y, size: 9, font: bold, color: black });
    y -= 20;

    totals.current += row.current;
    totals.days30 += row.days30;
    totals.days60 += row.days60;
    totals.days90Plus += row.days90Plus;
    totals.total += row.total;
  }

  y -= 8;
  page.drawLine({ start: { x: left, y: y + 12 }, end: { x: 545, y: y + 12 }, thickness: 0.5, color: grey });
  page.drawText("TOTAL", { x: left, y, size: 10, font: bold });
  page.drawText(`${formatRand(totals.current)}`, { x: 230, y, size: 10, font: bold });
  page.drawText(`${formatRand(totals.days30)}`, { x: 300, y, size: 10, font: bold });
  page.drawText(`${formatRand(totals.days60)}`, { x: 360, y, size: 10, font: bold });
  page.drawText(`${formatRand(totals.days90Plus)}`, { x: 420, y, size: 10, font: bold });
  page.drawText(`${formatRand(totals.total)}`, { x: 480, y, size: 10, font: bold, color: black });

  return await pdfDoc.save();
}

// Real feature 2026-07-12 — the final report of the accounting-
// capability roadmap. Same visual family as the other three. Real
// conventions stated directly on the page, not buried in a footnote —
// accrual-basis revenue, and the materials/subcontractor vs
// fuel/tools/other categorization split.
export async function generateProfitAndLossPdf(env: Env): Promise<Uint8Array> {
  const business = await env.OFFICE_DB.prepare("SELECT name, trading_as FROM business_profile WHERE id = 1").first<{
    name: string | null;
    trading_as: string | null;
  }>();

  const report = await getProfitAndLoss(env);

  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([595.28, 841.89]);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const grey = rgb(0.45, 0.45, 0.45);
  const black = rgb(0, 0, 0);

  const left = 50;
  let y = 792;

  page.drawText(business?.name ?? "[Business name not set]", { x: left, y, size: 14, font: bold });
  y -= 18;
  if (business?.trading_as) {
    page.drawText(`T/A ${business.trading_as}`, { x: left, y, size: 10, font });
    y -= 14;
  }
  y -= 16;
  page.drawText("PROFIT AND LOSS STATEMENT", { x: left, y, size: 16, font: bold });
  y -= 16;
  page.drawText(
    "Revenue is accrual-based (real invoiced amounts), not cash received. Cost of Sales includes materials and subcontractor costs; Operating Expenses includes fuel, tools, and other.",
    { x: left, y, size: 8, font, color: grey, maxWidth: 495 }
  );
  y -= 30;

  const row = (label: string, amount: number, boldRow = false) => {
    page.drawText(label, { x: left, y, size: 11, font: boldRow ? bold : font });
    page.drawText(`${formatRand(amount)}`, { x: 480, y, size: 11, font: boldRow ? bold : font, color: black });
    y -= 20;
  };

  row("Revenue", report.revenue);
  y -= 6;
  row("Cost of Sales", report.costOfSales);
  page.drawLine({ start: { x: left, y: y + 12 }, end: { x: 545, y: y + 12 }, thickness: 0.5, color: grey });
  y -= 6;
  row("Gross Profit", report.grossProfit, true);
  y -= 14;
  row("Operating Expenses", report.operatingExpenses);
  page.drawLine({ start: { x: left, y: y + 12 }, end: { x: 545, y: y + 12 }, thickness: 0.5, color: grey });
  y -= 6;
  row("NET PROFIT", report.netProfit, true);
  y -= 30;

  page.drawText("Expense breakdown by category", { x: left, y, size: 11, font: bold });
  y -= 20;
  for (const [category, amount] of Object.entries(report.categoryBreakdown)) {
    page.drawText(category, { x: left, y, size: 10, font });
    page.drawText(`${formatRand(amount)}`, { x: 480, y, size: 10, font });
    y -= 18;
  }

  return await pdfDoc.save();
}
