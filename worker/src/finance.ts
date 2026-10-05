// The Finance primitive — the revenue chain (quotations -> invoices ->
// payments) and the expense side (Principle 22's accounting-capability
// roadmap), guard()'d the same way for both directions of money. Document
// generation (real PDFs, real share messages) lives here too, since it's
// downstream of the same records.

import { PDFDocument, PDFPage, StandardFonts, rgb, PDFString } from "pdf-lib";
import type { Env, LineItemExtraction, LineItemWithTotal, PurchaseOrderLineItem } from "./types";
import { reconcileProduct, setSelection } from "./identity";
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

// Real feature 2026-07-24 — the real prerequisite for a reliable Aged
// Creditors report, mirroring recordPayment exactly. Built in certain
// anticipation of a real, recurring need — a supplier statement
// arrives every month, for every active supplier relationship, a
// guaranteed event, not a speculative one — distinct from unearned
// enterprise completeness. Same guard() discipline as every other
// real financial write.
export async function recordSupplierPayment(
  env: Env,
  characterId: number,
  amount: number | null,
  sourceTranscript: string
): Promise<{ id: number; characterId: number; amount: number | null }> {
  const inserted = await env.OFFICE_DB.prepare(
    "INSERT INTO supplier_payments (character_id, amount, source_transcript) VALUES (?, ?, ?) RETURNING id"
  )
    .bind(characterId, amount, sourceTranscript)
    .first<{ id: number }>();

  return { id: inserted!.id, characterId, amount };
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
  lineItems: LineItemWithTotal[] = [],
  jobScopeId: number | null = null
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

  // Real, deliberately narrow addition - a real due_date, 30 days
  // from creation. No stated-term extraction yet (a real, separate
  // future refinement) - just an honest, simple default so "is this
  // actually overdue" becomes a real, answerable question.
  const dueDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

  // Real feature 2026-07-22 — Layer 2 (Project): the real, missing
  // link back to the job scope this invoice was actually priced from,
  // per the design pinned in DECISIONS.md.
  const inserted = await env.OFFICE_DB.prepare(
    "INSERT INTO invoices (customer_id, description, amount, source_transcript, retention_percent, retention_amount, job_scope_id, due_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id"
  )
    .bind(customerId, description, amount, sourceTranscript, retentionPercent, retentionAmount, jobScopeId, dueDate)
    .first<{ id: number }>();

  const invoiceId = inserted!.id;

  for (const item of lineItems) {
    const productId = await resolveProductId(env, item.product);
    await env.OFFICE_DB.prepare(
      "INSERT INTO line_items (invoice_id, description, note, quantity, unit, unit_price, line_total, discount_percent, product_id, room) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
      .bind(invoiceId, item.description, item.note, item.quantity, item.unit, item.unit_price, item.line_total, item.discount_percent ?? null, productId, item.room ?? null)
      .run();
  }

  return { id: invoiceId, customerId, amount, retentionAmount };
}

// Real, new helper, per direct instruction: resolves a real product_id
// for a line item, using reconcileProduct's exact same real, proven
// resolution — exact match, then whole-word, then phonetic. On a
// genuine match, uses that real id. On "new", creates a real product
// row. On "ambiguous", deliberately leaves this line item unlinked
// rather than guessing — no real evidence yet that product-name
// collisions are a live problem the way people's names were, so this
// stays the safe default until real evidence says otherwise.
async function resolveProductId(env: Env, productName: string | null | undefined): Promise<number | null> {
  if (!productName) return null;
  const result = await reconcileProduct(env, productName);
  if (!result) return null;
  if (result.status === "matched") return result.id;
  if (result.status === "new") {
    const inserted = await env.OFFICE_DB.prepare("INSERT INTO products (name) VALUES (?) RETURNING id")
      .bind(productName.trim())
      .first<{ id: number }>();
    return inserted?.id ?? null;
  }
  return null;
}

export async function recordQuotation(
  env: Env,
  customerId: number,
  description: string,
  amount: number,
  sourceTranscript: string,
  lineItems: LineItemWithTotal[] = [],
  jobScopeId: number | null = null
): Promise<{ id: number; customerId: number; amount: number }> {
  // Real feature 2026-07-22 — Layer 2 (Project): the real, missing
  // link back to the job scope this quotation was actually priced
  // from, per the design pinned in DECISIONS.md.
  const inserted = await env.OFFICE_DB.prepare(
    "INSERT INTO quotations (customer_id, description, amount, source_transcript, job_scope_id) VALUES (?, ?, ?, ?, ?) RETURNING id"
  )
    .bind(customerId, description, amount, sourceTranscript, jobScopeId)
    .first<{ id: number }>();

  const quotationId = inserted!.id;

  for (const item of lineItems) {
    const productId = await resolveProductId(env, item.product);
    await env.OFFICE_DB.prepare(
      "INSERT INTO line_items (quotation_id, description, note, quantity, unit, unit_price, line_total, discount_percent, product_id, room) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
      .bind(quotationId, item.description, item.note, item.quantity, item.unit, item.unit_price, item.line_total, item.discount_percent ?? null, productId, item.room ?? null)
      .run();
  }

  // Real feature 2026-07-25 — the lead/enquiry stage's real point:
  // converting into a real customer and quotation once priced. A
  // safe no-op when no matching open lead exists for this exact
  // name — the common, unrelated case for most real quotations.
  const customerRow = await env.OFFICE_DB.prepare("SELECT name FROM customers WHERE id = ?")
    .bind(customerId)
    .first<{ name: string }>();
  if (customerRow?.name) {
    await transitionLeadToQuoted(env, customerRow.name, customerId);
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
    const productId = await resolveProductId(env, item.product);
    await env.OFFICE_DB.prepare(
      "INSERT INTO po_line_items (purchase_order_id, description, quantity_ordered, unit, unit_price_expected, product_id) VALUES (?, ?, ?, ?, ?, ?)"
    )
      .bind(purchaseOrderId, item.description, item.quantity_ordered, item.unit, item.unit_price_expected, productId)
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
  await ensureCancellationTable(env);
  const result = await env.OFFICE_DB.prepare(
    "SELECT id, description FROM purchase_orders WHERE supplier_id = ? AND id NOT IN (SELECT purchase_order_id FROM purchase_order_cancellations) ORDER BY created_at DESC LIMIT 1"
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
): Promise<
  Array<{
    id: number;
    description: string;
    quantity_ordered: number;
    unit: string | null;
    unit_price_expected: number | null;
    product_id: number | null;
  }>
> {
  const { results } = await env.OFFICE_DB.prepare(
    "SELECT id, description, quantity_ordered, unit, unit_price_expected, product_id FROM po_line_items WHERE purchase_order_id = ?"
  )
    .bind(purchaseOrderId)
    .all<{
      id: number;
      description: string;
      quantity_ordered: number;
      unit: string | null;
      unit_price_expected: number | null;
      product_id: number | null;
    }>();
  return results ?? [];
}

// Decided 2026-10-03 (Pierre): a delivery note for items that were never
// ordered is RECEIVED and treated as an exception report, not refused.
// History: a confirmed delivery that matched nothing on the order was once
// recorded as a single line called "unmatched item", quantity 2, with the real
// item's name lost (the model rightly answered matched_description:null, and
// callers only checked that SOME line existed). The fix is not to drop such
// lines but to keep them WITH their real name, and to label them.
//
// matched    — the model's name is non-null AND actually on the order
//              (case-insensitive, as recording does it).
// exceptions — not on the order, but the delivery itself names the item and
//              gives a real positive quantity. These are recorded as
//              exception lines, using the item's name as printed.
// dropped    — anything unusable (no name to record, or no sensible
//              quantity). Never recorded; a line with no identity is noise.
export function classifyGoodsReceivedLines<
  T extends { matched_description: string | null; quantity_received: number; item_description?: string | null; unit?: string | null }
>(lines: T[], poLineItems: Array<{ description: string }>): { matched: T[]; exceptions: T[]; dropped: T[] } {
  const onOrder = new Set(poLineItems.map((p) => p.description.toLowerCase()));
  const matched: T[] = [];
  const exceptions: T[] = [];
  const dropped: T[] = [];
  for (const line of lines) {
    const qty = Number(line.quantity_received);
    const onTheOrder = Boolean(line.matched_description) && onOrder.has(line.matched_description!.toLowerCase());
    if (onTheOrder && Number.isFinite(qty) && qty >= 0) {
      matched.push(line);
      continue;
    }
    const name = (line.item_description ?? "").trim() || (line.matched_description ?? "").trim();
    if (name && Number.isFinite(qty) && qty > 0) {
      exceptions.push({ ...line, item_description: name, matched_description: null });
    } else {
      dropped.push(line);
    }
  }
  return { matched, exceptions, dropped };
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
  lineItems: Array<{ matched_description: string | null; quantity_received: number; item_description?: string | null; unit?: string | null }>,
  recordedByEmail: string | null = null
): Promise<{
  grnId: number;
  variances: Array<{ description: string; ordered: number; received: number; variance: number }>;
  exceptions: Array<{ grnLineItemId: number; description: string; quantity: number }>;
}> {
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
  const exceptions: Array<{ grnLineItemId: number; description: string; quantity: number }> = [];

  for (const item of lineItems) {
    const matchedPoLine = item.matched_description
      ? poLineItems.find((p) => p.description.toLowerCase() === item.matched_description!.toLowerCase())
      : null;
    // Decided 2026-10-03: a delivered item that is not on the order is an
    // exception line, not an anonymous "unmatched item". It keeps the name
    // the delivery gave it and is recorded with an ordered quantity of 0, so
    // its variance equals what arrived and it shows up as an open discrepancy
    // everywhere discrepancies already do (the per-supplier list, the spoken
    // disposition flow) and in the delivery exception report. A line with no
    // name at all (an older held action) is recorded the old way.
    const exceptionName = !matchedPoLine ? (item.item_description ?? "").trim() : "";
    const isException = exceptionName.length > 0;
    const orderedQty = matchedPoLine?.quantity_ordered ?? (isException ? 0 : null);
    // The real, deterministic point of this whole feature — a
    // quantity variance, computed here, in code, never asked of the
    // model.
    const variance = orderedQty != null ? item.quantity_received - orderedQty : null;
    // The name this line is recorded (and reported) under.
    const recordedDescription =
      matchedPoLine?.description ??
      (isException ? `${exceptionName}${item.unit ? ` [${item.unit}]` : ""}` : item.matched_description ?? "unmatched item");
    const insertedLine = await env.OFFICE_DB.prepare(
      "INSERT INTO grn_line_items (grn_id, po_line_item_id, description, quantity_received, quantity_ordered, variance) VALUES (?, ?, ?, ?, ?, ?) RETURNING id"
    )
      .bind(
        grnId,
        matchedPoLine?.id ?? null,
        recordedDescription,
        item.quantity_received,
        orderedQty,
        variance
      )
      .first<{ id: number }>();
    if (isException) {
      exceptions.push({ grnLineItemId: insertedLine!.id, description: exceptionName, quantity: item.quantity_received });
    }
    if (orderedQty != null && variance != null) {
      variances.push({
        description: recordedDescription,
        ordered: orderedQty,
        received: item.quantity_received,
        variance,
      });
    }
    // Real feature 2026-07-25 — Consumables Stock, the idea-tank
    // review's first real, unlocked item. A confirmed GRN increments
    // a real, tracked stock item only when its exact, real name
    // already matches one Peter deliberately registered — never
    // guessed by the system deciding on its own that a delivered
    // material "sounds generic enough" to be stock. A job-specific
    // material (carpet, tile) simply has no matching stock_items row
    // and is correctly left untouched here.
    const matchedStockItem = await env.OFFICE_DB.prepare(
      "SELECT id FROM stock_items WHERE name = ? COLLATE NOCASE"
    )
      .bind(matchedPoLine?.description ?? (isException ? exceptionName : item.matched_description) ?? "")
      .first<{ id: number }>();
    if (matchedStockItem) {
      await env.OFFICE_DB.prepare("UPDATE stock_items SET quantity_on_hand = quantity_on_hand + ? WHERE id = ?")
        .bind(item.quantity_received, matchedStockItem.id)
        .run();
    }
  }

  return { grnId, variances, exceptions };
}

// ---------------------------------------------------------------------------
// Receiving against ALL of a supplier's outstanding orders (decided 2026-10-03,
// Pierre: "best match across all outstanding orders from that supplier").
//
// Until now a delivery was matched against the supplier's single MOST RECENT
// order, whether or not it had already been delivered, and every delivery was
// compared with the FULL ordered quantity: 20 ordered, 15 then 5 arriving gave
// a shortage of 5 and then a second, false shortage of 15. Both are fixed by
// the same idea, already used by supplier-invoice reconciliation ("a real
// delivery can arrive in more than one shipment"): what a line still expects
// is what was ordered minus everything received against it so far.
// ---------------------------------------------------------------------------
const round4 = (n: number): number => Math.round(n * 10000) / 10000;

export interface OutstandingLine {
  poId: number;
  poLineId: number;
  description: string;
  ordered: number;
  received: number;
  // Shortfalls the supplier has formally written off with a credit (variance disposition with resolution
  // "credit"). A credited shortfall is not coming, so it stops counting as outstanding; a back order, or a
  // reason with no resolution, does not: only an explicit credit closes the remainder.
  writtenOff: number;
  outstanding: number;
  unit: string | null;
}

// Every order line of this supplier that still has something outstanding, oldest
// order first (so a delivery fills the oldest order before the next).
export async function getOutstandingOrderLines(env: Env, supplierId: number): Promise<OutstandingLine[]> {
  await ensureCancellationTable(env);
  const { results } = await env.OFFICE_DB.prepare(
    `SELECT pl.id AS po_line_id, pl.purchase_order_id AS po_id, pl.description AS description,
            pl.quantity_ordered AS ordered, pl.unit AS unit,
            COALESCE((SELECT SUM(g.quantity_received) FROM grn_line_items g WHERE g.po_line_item_id = pl.id), 0) AS received,
            COALESCE((SELECT SUM(-g.variance) FROM grn_line_items g
                       WHERE g.po_line_item_id = pl.id AND g.variance < 0
                         AND EXISTS (SELECT 1 FROM variance_dispositions vd WHERE vd.grn_line_item_id = g.id AND vd.resolution = 'credit')), 0) AS written_off
       FROM po_line_items pl
       JOIN purchase_orders po ON po.id = pl.purchase_order_id
      WHERE po.supplier_id = ?
        AND po.id NOT IN (SELECT purchase_order_id FROM purchase_order_cancellations)
      ORDER BY po.created_at ASC, po.id ASC, pl.id ASC`
  )
    .bind(supplierId)
    .all<{ po_line_id: number; po_id: number; description: string; ordered: number; unit: string | null; received: number; written_off?: number }>();
  return (results ?? [])
    .map((r) => ({
      poId: r.po_id,
      poLineId: r.po_line_id,
      description: r.description,
      ordered: r.ordered,
      received: r.received,
      writtenOff: r.written_off ?? 0,
      outstanding: round4(r.ordered - r.received - (r.written_off ?? 0)),
      unit: r.unit,
    }))
    .filter((l) => l.outstanding > 0);
}

// What the extractor is shown to match a delivery against: one entry per distinct
// item (case-insensitive), carrying the total still outstanding across orders.
// ---------------------------------------------------------------------------------------------------------------------------
// Cancelling an order. Decided by Pierre 2026-10-04: an order used to finish only by being delivered or credited, so an
// abandoned one stayed outstanding for ever and kept attracting deliveries. A cancellation is its own small row (orders have
// no status column), created the first time it is needed so there is no migration to run by hand. A cancelled order is no
// longer outstanding, is no longer "the latest open order", and its open shortages are closed with it, because the rest is
// no longer expected.
// ---------------------------------------------------------------------------------------------------------------------------
const cancellationTableReady = new WeakSet<object>();

export async function ensureCancellationTable(env: Env): Promise<void> {
  // Remembered per database handle, never per process: a different database (a test's, a fresh one) has not got the table.
  if (cancellationTableReady.has(env.OFFICE_DB as unknown as object)) return;
  await env.OFFICE_DB.prepare(
    "CREATE TABLE IF NOT EXISTS purchase_order_cancellations (purchase_order_id INTEGER PRIMARY KEY, cancelled_by TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))"
  ).run();
  cancellationTableReady.add(env.OFFICE_DB as unknown as object);
}

export interface OpenOrder {
  id: number;
  description: string;
  lines: Array<{ description: string; outstanding: number; unit: string | null }>;
}

// The supplier's orders that still have something outstanding, oldest first.
export async function getOpenOrdersForSupplier(env: Env, supplierId: number): Promise<OpenOrder[]> {
  const lines = await getOutstandingOrderLines(env, supplierId);
  const ids = [...new Set(lines.map((l) => l.poId))];
  if (ids.length === 0) return [];
  const { results } = await env.OFFICE_DB.prepare(
    `SELECT id, description FROM purchase_orders WHERE id IN (${ids.map(() => "?").join(",")})`
  )
    .bind(...ids)
    .all<{ id: number; description: string }>();
  const description = new Map((results ?? []).map((r) => [r.id, r.description]));
  return ids.map((id) => ({
    id,
    description: description.get(id) ?? "",
    lines: lines.filter((l) => l.poId === id).map((l) => ({ description: l.description, outstanding: l.outstanding, unit: l.unit })),
  }));
}

export function describeOpenOrder(order: OpenOrder): string {
  const left = order.lines.map((l) => `${l.outstanding}${l.unit ? ` ${l.unit}` : ""} ${l.description}`).join(", ");
  return `#${order.id} ${order.description} (${left} not yet received)`;
}

// "cancel order 3", "cancel PO #3", "scrap order number 3". A number that is really a quantity ("cancel the order of 50
// sqm vinyl") is not an order number, so a number followed by a unit is ignored. Whatever is read, the person is shown the
// order before anything is cancelled, so a wrong reading is visible and can be rejected.
export function parseOrderNumber(text: string): number | null {
  const unit = "(?!\\s*(?:sqm|m2|m²|square|sq|metres?|meters?|bags?|rolls?|boxes|box|lengths?|tiles?|pcs|pieces|units|litres?|l\\b|kg))";
  const named = text.match(new RegExp(`\\b(?:order|po|p\\.o\\.)\\s*(?:number|no\\.?|#)?\\s*#?\\s*(\\d{1,6})\\b${unit}`, "i"));
  if (named) return Number(named[1]);
  const hashed = text.match(new RegExp(`#\\s*(\\d{1,6})\\b${unit}`));
  return hashed ? Number(hashed[1]) : null;
}

export async function cancelPurchaseOrder(
  env: Env,
  purchaseOrderId: number,
  cancelledBy: string | null
): Promise<{ alreadyCancelled: boolean; closedShortages: number }> {
  await ensureCancellationTable(env);
  const already = await env.OFFICE_DB.prepare("SELECT purchase_order_id FROM purchase_order_cancellations WHERE purchase_order_id = ?")
    .bind(purchaseOrderId)
    .first<{ purchase_order_id: number }>();
  if (already) return { alreadyCancelled: true, closedShortages: 0 };
  await env.OFFICE_DB.prepare("INSERT INTO purchase_order_cancellations (purchase_order_id, cancelled_by) VALUES (?, ?)")
    .bind(purchaseOrderId, cancelledBy)
    .run();
  // A short delivery on an order that is now cancelled is no longer an exception: close each open shortage with the order.
  const { results } = await env.OFFICE_DB.prepare(
    `SELECT g.id AS id
       FROM grn_line_items g
       JOIN goods_received_notes n ON n.id = g.grn_id
      WHERE n.purchase_order_id = ? AND g.variance < 0
        AND NOT EXISTS (SELECT 1 FROM variance_dispositions vd WHERE vd.grn_line_item_id = g.id)`
  )
    .bind(purchaseOrderId)
    .all<{ id: number }>();
  for (const row of results ?? []) {
    await env.OFFICE_DB.prepare(
      "INSERT INTO variance_dispositions (grn_line_item_id, reason, resolution, recorded_by) VALUES (?, 'order cancelled', 'cancelled', ?)"
    )
      .bind(row.id, cancelledBy)
      .run();
  }
  return { alreadyCancelled: false, closedShortages: (results ?? []).length };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Units and per-item conversions. Decided by Pierre 2026-10-04: a delivery counted in boxes against an order placed in square
// metres was compared number to number (10 boxes against 22 sqm looked like a big shortage), and stock was added in whatever
// unit the delivery happened to use. A conversion is set once, per item, by saying it ("a box of laminate is 2.2 square
// metres"), and is used from then on.
//
// Two rules keep this from getting in the way. First, only units this table RECOGNISES are ever treated as different; a unit
// it does not know is compared as before, so a word it has never seen cannot block a delivery. Second, when two recognised
// units differ and no conversion is known, nothing is guessed and nothing is recorded: the person is asked for the conversion
// once, then says the delivery again.
// ---------------------------------------------------------------------------------------------------------------------------
const UNIT_FORMS: Record<string, string[]> = {
  sqm: ["sqm", "sq m", "sq metre", "sq metres", "sq meter", "sq meters", "square metre", "square metres", "square meter", "square meters", "square m", "m2", "m²", "sqmt"],
  box: ["box", "boxes", "carton", "cartons", "ctn", "ctns"],
  bag: ["bag", "bags"],
  roll: ["roll", "rolls"],
  length: ["length", "lengths", "len", "lens"],
  tile: ["tile", "tiles"],
  sheet: ["sheet", "sheets", "board", "boards"],
  litre: ["l", "lt", "litre", "litres", "liter", "liters"],
  kg: ["kg", "kgs", "kilogram", "kilograms", "kilo", "kilos"],
  tube: ["tube", "tubes"],
  tin: ["tin", "tins", "can", "cans"],
  pack: ["pack", "packs", "packet", "packets"],
  pallet: ["pallet", "pallets"],
  metre: ["m", "metre", "metres", "meter", "meters", "lm", "linear metre", "linear metres", "linear meter", "linear meters"],
  each: ["each", "ea", "unit", "units", "piece", "pieces", "pc", "pcs"],
};
const UNIT_LOOKUP = new Map<string, string>();
for (const [canonical, forms] of Object.entries(UNIT_FORMS)) for (const f of forms) UNIT_LOOKUP.set(f, canonical);

// The canonical unit for what was said or written, or null when it is not one this table recognises.
export function normalizeUnit(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const cleaned = String(raw).toLowerCase().replace(/\./g, "").replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  return UNIT_LOOKUP.get(cleaned) ?? null;
}

// Two units are DIFFERENT only when both are recognised and not the same one. "square metres" and "sqm" are the same;
// "bundle" against "sqm" is not known to differ, so it is compared as before.
export function unitsDiffer(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = normalizeUnit(a);
  const y = normalizeUnit(b);
  return x !== null && y !== null && x !== y;
}

export function unitItemKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

const unitConversionTableReady = new WeakSet<object>();
export async function ensureUnitConversionTable(env: Env): Promise<void> {
  // Remembered per database handle, never per process (a second database has not got the table).
  if (unitConversionTableReady.has(env.OFFICE_DB as unknown as object)) return;
  await env.OFFICE_DB.prepare(
    "CREATE TABLE IF NOT EXISTS unit_conversions (item_key TEXT NOT NULL, from_unit TEXT NOT NULL, to_unit TEXT NOT NULL, factor REAL NOT NULL, set_by TEXT, updated_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (item_key, from_unit, to_unit))"
  ).run();
  unitConversionTableReady.add(env.OFFICE_DB as unknown as object);
}

// "1 box of laminate = 2.2 sqm". Saying it again changes it. A conversion the other way round for the same item is removed,
// so the two can never contradict each other.
export async function setUnitConversion(
  env: Env,
  itemName: string,
  fromUnit: string,
  toUnit: string,
  factor: number,
  setBy: string | null
): Promise<{ item: string; from: string; to: string; factor: number; replaced: number | null }> {
  await ensureUnitConversionTable(env);
  const from = normalizeUnit(fromUnit)!;
  const to = normalizeUnit(toUnit)!;
  const key = unitItemKey(itemName);
  const previous = await env.OFFICE_DB.prepare("SELECT factor FROM unit_conversions WHERE item_key = ? AND from_unit = ? AND to_unit = ?")
    .bind(key, from, to)
    .first<{ factor: number }>();
  await env.OFFICE_DB.prepare("DELETE FROM unit_conversions WHERE item_key = ? AND from_unit = ? AND to_unit = ?").bind(key, to, from).run();
  await env.OFFICE_DB.prepare(
    "INSERT INTO unit_conversions (item_key, from_unit, to_unit, factor, set_by) VALUES (?, ?, ?, ?, ?) ON CONFLICT (item_key, from_unit, to_unit) DO UPDATE SET factor = excluded.factor, set_by = excluded.set_by, updated_at = datetime('now')"
  )
    .bind(key, from, to, factor, setBy)
    .run();
  return { item: itemName.trim(), from, to, factor, replaced: previous?.factor ?? null };
}

// Converts a quantity of an item between two units using the conversion set for that item (in either direction). The item is
// matched by its whole name first, then by a conversion whose name is contained in it ("laminate" for "Quickstep laminate"),
// choosing the longest such name.
export async function convertQuantity(
  env: Env,
  itemName: string,
  quantity: number,
  fromUnit: string | null | undefined,
  toUnit: string | null | undefined
): Promise<{ ok: true; quantity: number; factor: number | null } | { ok: false }> {
  const from = normalizeUnit(fromUnit);
  const to = normalizeUnit(toUnit);
  if (from === null || to === null || from === to) return { ok: true, quantity, factor: null };
  await ensureUnitConversionTable(env);
  const { results } = await env.OFFICE_DB.prepare(
    "SELECT item_key, from_unit, to_unit, factor FROM unit_conversions WHERE (from_unit = ? AND to_unit = ?) OR (from_unit = ? AND to_unit = ?)"
  )
    .bind(from, to, to, from)
    .all<{ item_key: string; from_unit: string; to_unit: string; factor: number }>();
  const key = unitItemKey(itemName);
  const words = new Set(key.split(" "));
  const fits = (results ?? []).filter((r) => r.item_key === key || r.item_key.split(" ").every((w) => words.has(w)));
  if (fits.length === 0) return { ok: false };
  const best = fits.sort((a, b) => b.item_key.length - a.item_key.length)[0];
  const forward = best.from_unit === from;
  const factor = forward ? best.factor : 1 / best.factor;
  return { ok: true, quantity: round4(quantity * factor), factor };
}

// ---- Seeing and removing conversions (decided by Pierre 2026-10-04) ----------------------------------------------------------
export interface SavedConversion {
  item: string;
  from: string;
  to: string;
  factor: number;
}

function conversionMatchesItem(rowKey: string, asked: string): boolean {
  const a = new Set(unitItemKey(asked).split(" "));
  const r = rowKey.split(" ");
  return rowKey === unitItemKey(asked) || r.every((w) => a.has(w)) || [...a].every((w) => r.includes(w));
}

export async function listUnitConversions(env: Env, item?: string | null): Promise<SavedConversion[]> {
  await ensureUnitConversionTable(env);
  const { results } = await env.OFFICE_DB.prepare("SELECT item_key, from_unit, to_unit, factor FROM unit_conversions ORDER BY item_key, from_unit, to_unit")
    .all<{ item_key: string; from_unit: string; to_unit: string; factor: number }>();
  return (results ?? [])
    .filter((r) => !item || conversionMatchesItem(r.item_key, item))
    .map((r) => ({ item: r.item_key, from: r.from_unit, to: r.to_unit, factor: r.factor }));
}

// Forgets the conversion(s) saved for EXACTLY this item (never a looser match: a wrong guess would delete the wrong one). When there
// is none, what is saved for similar names is returned so the person can be shown it.
export async function forgetUnitConversions(env: Env, itemName: string): Promise<{ forgotten: SavedConversion[]; similar: SavedConversion[] }> {
  await ensureUnitConversionTable(env);
  const key = unitItemKey(itemName);
  const { results } = await env.OFFICE_DB.prepare("SELECT item_key, from_unit, to_unit, factor FROM unit_conversions WHERE item_key = ? ORDER BY from_unit, to_unit")
    .bind(key)
    .all<{ item_key: string; from_unit: string; to_unit: string; factor: number }>();
  const forgotten = (results ?? []).map((r) => ({ item: r.item_key, from: r.from_unit, to: r.to_unit, factor: r.factor }));
  if (forgotten.length > 0) {
    await env.OFFICE_DB.prepare("DELETE FROM unit_conversions WHERE item_key = ?").bind(key).run();
    return { forgotten, similar: [] };
  }
  return { forgotten: [], similar: await listUnitConversions(env, itemName) };
}

export function describeConversion(c: SavedConversion): string {
  return `1 ${c.from} of ${c.item} = ${c.factor} ${c.to}`;
}

export function unitConversionsAnswer(rows: SavedConversion[], asked: string | null): string {
  if (rows.length === 0) {
    return asked
      ? `No unit conversion is saved for ${asked}. Say, for example, "a box of ${asked} is 2.2 square metres".`
      : `No unit conversions are saved yet. Say, for example, "a box of laminate is 2.2 square metres".`;
  }
  return `Unit conversions${asked ? ` for ${asked}` : ""}: ${rows.map(describeConversion).join("; ")}.`;
}

// A quantity SAID in one unit about an item KEPT in another (decided by Pierre 2026-10-04): converted when a conversion is known, and when it
// is not, nothing is recorded and the person is asked for it once. A unit that was not said, or not recognised, passes through untouched.
export async function checkStockUnit(
  env: Env,
  item: { name: string; unit: string | null },
  said: string | null | undefined,
  quantity: number
): Promise<{ ok: true; quantity: number; note: string } | { ok: false; question: string }> {
  if (!unitsDiffer(said, item.unit)) return { ok: true, quantity, note: "" };
  const converted = await convertQuantity(env, item.name, quantity, said, item.unit);
  if (converted.ok) return { ok: true, quantity: converted.quantity, note: ` (${quantity} ${String(said).trim()} of ${item.name} counted as ${converted.quantity} ${item.unit}.)` };
  const from = normalizeUnit(said)!;
  const to = normalizeUnit(item.unit)!;
  return {
    ok: false,
    question: `Nothing was recorded. ${item.name} is kept in ${unitPlural(to)} but you said ${unitPlural(from)}, and I don't know how many ${unitPlural(to)} are in a ${from}. Say, for example, "a ${from} of ${item.name} is 2.2 ${unitPlural(to)}" (with the real number). Then say it again.`,
  };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Supplier statements have a home. Decided by Pierre 2026-10-04: a statement (a supplier's claim of what is owed) was compared with the
// books and then forgotten, and a SPOKEN one ("Floornet says we owe them R12,000") did nothing at all. Each one, spoken or uploaded, is now
// recorded with the books' balance at that moment and the difference, and the history can be asked for. The table is created the first
// time it is needed, so there is no migration to run.
// ---------------------------------------------------------------------------------------------------------------------------
const round2 = (n: number): number => Math.round(n * 100) / 100;
const supplierStatementTableReady = new WeakSet<object>();
export async function ensureSupplierStatementTable(env: Env): Promise<void> {
  if (supplierStatementTableReady.has(env.OFFICE_DB as unknown as object)) return;
  await env.OFFICE_DB.prepare(
    "CREATE TABLE IF NOT EXISTS supplier_statements (id INTEGER PRIMARY KEY AUTOINCREMENT, supplier_id INTEGER NOT NULL, claimed_balance REAL NOT NULL, books_balance REAL NOT NULL, difference REAL NOT NULL, source TEXT NOT NULL, source_text TEXT, recorded_by TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))"
  ).run();
  supplierStatementTableReady.add(env.OFFICE_DB as unknown as object);
}

export async function recordSupplierStatement(
  env: Env,
  supplierId: number,
  claimed: number,
  books: number,
  source: "spoken" | "document" | "photo",
  sourceText: string | null,
  recordedBy: string | null
): Promise<{ id: number; difference: number }> {
  await ensureSupplierStatementTable(env);
  const difference = round2(claimed - books);
  const row = await env.OFFICE_DB.prepare(
    "INSERT INTO supplier_statements (supplier_id, claimed_balance, books_balance, difference, source, source_text, recorded_by) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id"
  )
    .bind(supplierId, claimed, books, difference, source, sourceText, recordedBy)
    .first<{ id: number }>();
  return { id: row!.id, difference };
}

// What the difference means, in a sentence: nothing when they agree, and which way round when they do not.
export function statementDifferenceNote(difference: number): string {
  if (difference === 0) return " That matches our records.";
  return difference > 0 ? ` They claim R${difference} more than our records.` : ` They claim R${Math.abs(difference)} less than our records.`;
}

export interface SavedStatement {
  supplier: string | null;
  date: string;
  claimed: number;
  books: number;
  difference: number;
  source: string;
}

export async function listSupplierStatements(env: Env, supplierId: number | null, limit = 5): Promise<SavedStatement[]> {
  await ensureSupplierStatementTable(env);
  const { results } = await env.OFFICE_DB.prepare(
    `SELECT c.name AS supplier, s.created_at AS created_at, s.claimed_balance AS claimed, s.books_balance AS books, s.difference AS difference, s.source AS source
       FROM supplier_statements s LEFT JOIN characters c ON c.id = s.supplier_id
      WHERE (? IS NULL OR s.supplier_id = ?)
      ORDER BY s.id DESC LIMIT ?`
  )
    .bind(supplierId, supplierId, limit)
    .all<{ supplier: string | null; created_at: string; claimed: number; books: number; difference: number; source: string }>();
  return (results ?? []).map((r) => ({ supplier: r.supplier, date: String(r.created_at).slice(0, 10), claimed: r.claimed, books: r.books, difference: r.difference, source: r.source }));
}

export function supplierStatementsAnswer(rows: SavedStatement[], asked: string | null): string {
  if (rows.length === 0) return asked ? `No statements from ${asked} have been recorded yet.` : "No supplier statements have been recorded yet.";
  const part = (r: SavedStatement) =>
    `${asked ? "" : `${r.supplier ?? "a supplier"}, `}${r.date}: claimed R${r.claimed}, our records R${r.books}${r.difference === 0 ? " (matched)" : r.difference > 0 ? ` (R${r.difference} more)` : ` (R${Math.abs(r.difference)} less)`}`;
  return `Statements${asked ? ` from ${asked}` : ""}: ${rows.map(part).join("; ")}.`;
}

export interface DeliveryUnitCheck<T> {
  lines: T[];
  converted: Array<{ item: string; quantity: number; from: string; to: string; result: number }>;
  unconverted: Array<{ item: string; deliveredUnit: string; orderedUnit: string }>;
}

// For each delivered line that matches an order line: if its unit is a recognised unit that differs from the order's, convert
// it into the order's unit when a conversion is known, and report it as unconverted when none is. Lines whose units match, or
// are not recognised, pass through untouched. Lines that are not on the order have no unit to match and are left alone.
export async function checkDeliveryUnits<T extends { matched_description: string | null; quantity_received: number; unit?: string | null }>(
  env: Env,
  outstanding: OutstandingLine[],
  lines: T[]
): Promise<DeliveryUnitCheck<T>> {
  const out: T[] = [];
  const converted: DeliveryUnitCheck<T>["converted"] = [];
  const unconverted: DeliveryUnitCheck<T>["unconverted"] = [];
  for (const line of lines) {
    const name = (line.matched_description ?? "").toLowerCase();
    const orderLine = name ? outstanding.find((o) => o.description.toLowerCase() === name) : undefined;
    if (!orderLine || !unitsDiffer(line.unit, orderLine.unit)) {
      out.push(line);
      continue;
    }
    const result = await convertQuantity(env, orderLine.description, Number(line.quantity_received), line.unit, orderLine.unit);
    if (result.ok) {
      out.push({ ...line, quantity_received: result.quantity, unit: orderLine.unit });
      converted.push({ item: orderLine.description, quantity: Number(line.quantity_received), from: String(line.unit), to: String(orderLine.unit), result: result.quantity });
    } else {
      out.push(line);
      if (!unconverted.some((u) => u.item.toLowerCase() === orderLine.description.toLowerCase())) {
        unconverted.push({ item: orderLine.description, deliveredUnit: normalizeUnit(line.unit)!, orderedUnit: normalizeUnit(orderLine.unit)! });
      }
    }
  }
  return { lines: out, converted, unconverted };
}

// How a canonical unit reads after "in" ("in boxes", "in sqm").
export function unitPlural(canonical: string): string {
  const plural: Record<string, string> = { box: "boxes", bag: "bags", roll: "rolls", length: "lengths", tile: "tiles", sheet: "sheets", litre: "litres", tube: "tubes", tin: "tins", pack: "packs", pallet: "pallets", metre: "metres" };
  return plural[canonical] ?? canonical;
}

// What to say when a delivery cannot be matched because the units differ and no conversion is known. Nothing was recorded.
export function deliveryUnitQuestion(supplier: string, unconverted: DeliveryUnitCheck<unknown>["unconverted"], then = "say the delivery again"): string {
  const parts = unconverted.map(
    (u) =>
      `${u.item} was ordered in ${unitPlural(u.orderedUnit)} but this delivery is in ${unitPlural(u.deliveredUnit)}, and I don't know how many ${unitPlural(u.orderedUnit)} are in a ${u.deliveredUnit}. Say, for example, "a ${u.deliveredUnit} of ${u.item} is 2.2 ${unitPlural(u.orderedUnit)}" (with the real number).`
  );
  return `Nothing was recorded from ${supplier}. ${parts.join(" ")} Then ${then}.`;
}

export function conversionNote(converted: DeliveryUnitCheck<unknown>["converted"]): string {
  if (converted.length === 0) return "";
  return ` (${converted.map((c) => `${c.quantity} ${c.from} of ${c.item} counted as ${c.result} ${c.to}`).join("; ")}.)`;
}

export function candidateOrderLines(
  outstanding: OutstandingLine[]
): Array<{ description: string; quantity_ordered: number; unit: string | null }> {
  const byName = new Map<string, { description: string; quantity_ordered: number; unit: string | null }>();
  for (const l of outstanding) {
    const key = l.description.toLowerCase();
    const existing = byName.get(key);
    if (existing) existing.quantity_ordered = round4(existing.quantity_ordered + l.outstanding);
    else byName.set(key, { description: l.description, quantity_ordered: l.outstanding, unit: l.unit });
  }
  return [...byName.values()];
}

// An order's delivery status, worked out on read from its lines (the "compute on read" choice from the
// original design). Separate from the document status (delivery note / invoice present), which is
// about which paperwork has arrived, not about quantities.
export function orderDeliveryStatus(
  lines: Array<{ ordered: number; received: number; writtenOff?: number }>
): "awaiting delivery" | "partially delivered" | "fully delivered" {
  if (lines.length === 0 || lines.every((l) => l.received <= 0 && (l.writtenOff ?? 0) <= 0)) return "awaiting delivery";
  return lines.every((l) => round4(l.ordered - l.received - (l.writtenOff ?? 0)) <= 0) ? "fully delivered" : "partially delivered";
}

export interface DeliveryAllocation {
  poId: number;
  poLineId: number;
  description: string;
  unit: string | null;
  ordered: number; // the line's full ordered quantity
  expected: number; // what this line still expected just before this delivery
  quantity: number; // what this delivery put against it
  variance: number; // quantity - expected: negative is short, positive is over
}

// Pure. Puts each matched delivery line against the supplier's outstanding lines for that item, oldest
// order first. Everything before the last allocation for an item is filled exactly, so only the last can
// be short; anything beyond the total outstanding is over-delivery on the last line. A matched line of
// quantity 0 is a real shortage, recorded against the first line that still expects something.
export function allocateDelivery<T extends { matched_description: string | null; quantity_received: number }>(
  matched: T[],
  outstanding: OutstandingLine[]
): DeliveryAllocation[] {
  const left = new Map<number, number>(outstanding.map((l) => [l.poLineId, l.outstanding]));
  const result: DeliveryAllocation[] = [];
  for (const line of matched) {
    const name = (line.matched_description ?? "").toLowerCase();
    const candidates = outstanding.filter((l) => l.description.toLowerCase() === name);
    if (candidates.length === 0) continue;
    let remaining = round4(line.quantity_received);
    const mine: DeliveryAllocation[] = [];
    const make = (c: OutstandingLine, quantity: number, expected: number): DeliveryAllocation => ({
      poId: c.poId,
      poLineId: c.poLineId,
      description: c.description,
      unit: c.unit,
      ordered: c.ordered,
      expected,
      quantity,
      variance: round4(quantity - expected),
    });
    if (remaining === 0) {
      const first = candidates.find((c) => (left.get(c.poLineId) ?? 0) > 0) ?? candidates[0];
      result.push(make(first, 0, left.get(first.poLineId) ?? 0));
      continue;
    }
    for (const c of candidates) {
      if (remaining <= 0) break;
      const expected = left.get(c.poLineId) ?? 0;
      if (expected <= 0) continue;
      const take = Math.min(remaining, expected);
      mine.push(make(c, take, expected));
      left.set(c.poLineId, round4(expected - take));
      remaining = round4(remaining - take);
    }
    if (mine.length === 0) {
      // Everything for this item was already filled earlier in this same delivery: it is all over-delivery.
      mine.push(make(candidates[candidates.length - 1], remaining, 0));
    } else if (remaining > 0) {
      const last = mine[mine.length - 1];
      last.quantity = round4(last.quantity + remaining);
      last.variance = round4(last.quantity - last.expected);
    }
    result.push(...mine);
  }
  return result;
}

// Records a delivery against the supplier's outstanding orders. One goods-received note per order touched;
// items that were on no outstanding order become exception lines on the supplier's most recent outstanding
// order (or on order 0 when it has none). The allocation is worked out HERE, when the delivery is recorded,
// not when it was held for confirmation: another delivery may have been confirmed in between.
export async function recordDelivery(
  env: Env,
  supplierId: number,
  sourceTranscript: string,
  lines: Array<{ matched_description: string | null; quantity_received: number; item_description?: string | null; unit?: string | null }>,
  recordedByEmail: string | null = null
): Promise<{
  grnId: number;
  grnIds: number[];
  variances: Array<{ description: string; expected: number; received: number; variance: number }>;
  exceptions: Array<{ grnLineItemId: number; description: string; quantity: number }>;
  shortCount: number;
  overCount: number;
  // Items that arrived and are not a registered stock item (so nothing was added to stock). The caller
  // asks whether to add them (decided 2026-10-03, Pierre: ask on delivery).
  notInStock: Array<{ name: string; unit: string | null; quantity: number }>;
}> {
  const outstanding = await getOutstandingOrderLines(env, supplierId);
  // Lines held before a conversion was known are converted here, at the moment they are recorded. A line whose units differ with
  // no conversion known is recorded as it always was (number against number): the question is asked when the delivery is first
  // said, so a held action never gets stranded here.
  const unitCheck = await checkDeliveryUnits(env, outstanding, lines);
  const classified = classifyGoodsReceivedLines(unitCheck.lines, candidateOrderLines(outstanding));
  const allocations = allocateDelivery(classified.matched, outstanding);
  const contextPoId = allocations[0]?.poId ?? (outstanding.length > 0 ? outstanding[outstanding.length - 1].poId : 0);

  const headers = new Map<number, number>();
  const headerFor = async (poId: number): Promise<number> => {
    const existing = headers.get(poId);
    if (existing != null) return existing;
    const inserted = await env.OFFICE_DB.prepare(
      "INSERT INTO goods_received_notes (purchase_order_id, supplier_id, source_transcript, recorded_by) VALUES (?, ?, ?, ?) RETURNING id"
    )
      .bind(poId, supplierId, sourceTranscript, recordedByEmail)
      .first<{ id: number }>();
    headers.set(poId, inserted!.id);
    return inserted!.id;
  };
  const notInStock = new Map<string, { name: string; unit: string | null; quantity: number }>();
  const addStock = async (name: string, quantity: number, unit: string | null) => {
    // Same exact-name rule as before: only a stock item deliberately registered under this name
    // gains stock automatically. Anything else is reported back, so the person can be asked.
    const stockItem = await env.OFFICE_DB.prepare("SELECT id FROM stock_items WHERE name = ? COLLATE NOCASE")
      .bind(name)
      .first<{ id: number }>();
    if (quantity <= 0) return;
    if (stockItem) {
      // Added in the stock item's OWN unit: a delivery in boxes of an item kept in square metres is converted first, when a
      // conversion is known (otherwise added as it always was).
      let toAdd = quantity;
      if (unit) {
        const stockUnit = await env.OFFICE_DB.prepare("SELECT unit FROM stock_items WHERE id = ?").bind(stockItem.id).first<{ unit: string | null }>();
        if (stockUnit && unitsDiffer(unit, stockUnit.unit)) {
          const converted = await convertQuantity(env, name, quantity, unit, stockUnit.unit);
          if (converted.ok) toAdd = converted.quantity;
        }
      }
      await env.OFFICE_DB.prepare("UPDATE stock_items SET quantity_on_hand = quantity_on_hand + ? WHERE id = ?")
        .bind(toAdd, stockItem.id)
        .run();
    } else {
      const key = name.toLowerCase();
      const existing = notInStock.get(key);
      if (existing) existing.quantity = round4(existing.quantity + quantity);
      else notInStock.set(key, { name, unit, quantity });
    }
  };

  const variances: Array<{ description: string; expected: number; received: number; variance: number }> = [];
  const exceptions: Array<{ grnLineItemId: number; description: string; quantity: number }> = [];

  for (const a of allocations) {
    const grnId = await headerFor(a.poId);
    await env.OFFICE_DB.prepare(
      "INSERT INTO grn_line_items (grn_id, po_line_item_id, description, quantity_received, quantity_ordered, variance) VALUES (?, ?, ?, ?, ?, ?) RETURNING id"
    )
      .bind(grnId, a.poLineId, a.description, a.quantity, a.ordered, a.variance)
      .first<{ id: number }>();
    variances.push({ description: a.description, expected: a.expected, received: a.quantity, variance: a.variance });
    await addStock(a.description, a.quantity, a.unit);
  }

  for (const e of classified.exceptions) {
    const name = (e.item_description ?? "").trim();
    const grnId = await headerFor(contextPoId);
    const inserted = await env.OFFICE_DB.prepare(
      "INSERT INTO grn_line_items (grn_id, po_line_item_id, description, quantity_received, quantity_ordered, variance) VALUES (?, ?, ?, ?, ?, ?) RETURNING id"
    )
      .bind(grnId, null, `${name}${e.unit ? ` [${e.unit}]` : ""}`, e.quantity_received, 0, e.quantity_received)
      .first<{ id: number }>();
    exceptions.push({ grnLineItemId: inserted!.id, description: name, quantity: e.quantity_received });
    await addStock(name, e.quantity_received, e.unit ?? null);
  }

  const grnIds = [...headers.values()];
  return {
    grnId: grnIds[0] ?? 0,
    grnIds,
    variances,
    exceptions,
    shortCount: allocations.filter((a) => a.variance < 0).length,
    overCount: allocations.filter((a) => a.variance > 0).length,
    notInStock: [...notInStock.values()],
  };
}

// ---------------------------------------------------------------------------
// "Add this delivery to stock?" (decided 2026-10-03, Pierre: ask on delivery).
// Stock items are still only ever created deliberately: a delivery never registers one by itself.
// What changed is that the person is asked, with one tap, instead of having to register the item
// first with a name that matches the order line exactly. One question per delivery, covering every
// item that arrived and is not already stock. An item is not asked about again once it has been
// declined (a rejected question stays on record) or while a question about it is still waiting.
// ---------------------------------------------------------------------------
export async function proposeStockAdditions(
  env: Env,
  items: Array<{ name: string; unit: string | null; quantity: number }>,
  supplierName: string | null
): Promise<{ id: number; message: string } | null> {
  const fresh: Array<{ name: string; unit: string | null; quantity: number }> = [];
  for (const item of items) {
    if (!item.name.trim() || !(item.quantity > 0)) continue;
    const seen = await env.OFFICE_DB.prepare(
      `SELECT 1 AS hit FROM pending_actions pa, json_each(pa.payload, '$.items') je
        WHERE pa.type = 'stock_add' AND pa.status IN ('pending', 'rejected')
          AND lower(json_extract(je.value, '$.name')) = lower(?)
        LIMIT 1`
    )
      .bind(item.name)
      .first<{ hit: number }>();
    if (!seen) fresh.push(item);
  }
  if (fresh.length === 0) return null;
  const list = fresh.map((i) => `${i.name} (${i.quantity}${i.unit ? ` ${i.unit}` : ""})`).join(", ");
  const question = `Add to stock? ${list}`;
  // The question itself is stored as the action's text, because that is what the Pending room shows.
  const held = await holdForConfirmation(env, "stock_add", { items: fresh, supplierName }, question);
  return { id: held.id, message: `${question} (action #${held.id}).` };
}

// Confirming the question: registers each item that is not yet stock and adds what arrived. If it was
// registered in the meantime, this delivery's quantity is still added, because it was not counted.
export async function addDeliveredItemsToStock(
  env: Env,
  items: Array<{ name: string; unit: string | null; quantity: number }>
): Promise<Array<{ name: string; unit: string | null; quantity: number }>> {
  const added: Array<{ name: string; unit: string | null; quantity: number }> = [];
  for (const item of items) {
    const name = typeof item.name === "string" ? item.name.trim() : "";
    const quantity = Number(item.quantity);
    const unit = typeof item.unit === "string" && item.unit.trim() ? item.unit.trim().slice(0, 20) : null;
    if (!name || !Number.isFinite(quantity) || quantity <= 0) continue;
    const existing = await env.OFFICE_DB.prepare("SELECT id FROM stock_items WHERE name = ? COLLATE NOCASE")
      .bind(name)
      .first<{ id: number }>();
    const id = existing?.id ?? (await registerStockItem(env, name, unit)).id;
    await env.OFFICE_DB.prepare("UPDATE stock_items SET quantity_on_hand = quantity_on_hand + ? WHERE id = ?")
      .bind(quantity, id)
      .run();
    added.push({ name, unit, quantity });
  }
  return added;
}

// The delivery exception report (decided 2026-10-03, Pierre): every way a delivery differed from what
// was ordered, across all suppliers, newest first. Three kinds, all stored as goods-received lines:
//   unordered — the item was on no order (no order line, ordered quantity 0)
//   short     — less arrived than was still outstanding (negative variance)
//   over      — more arrived than was still outstanding (positive variance on an order line)
// "Open" means no variance disposition has been raised for it yet, so resolving one uses exactly the same
// routes and spoken flow as any other discrepancy, and a shortage STAYS open until it is resolved
// (Pierre's choice), even if a later delivery completes the order. purchase_order_id 0 means the supplier
// had no outstanding order at all. "expected" is what the line still expected just before this delivery
// (received minus variance), which is what the variance was measured against.
export async function getDeliveryExceptions(
  env: Env,
  status: "open" | "all" = "open",
  limit: number = 100
): Promise<
  Array<{
    grnLineItemId: number;
    grnId: number;
    kind: "unordered" | "short" | "over";
    supplierId: number | null;
    supplierName: string | null;
    description: string;
    quantityReceived: number;
    expected: number;
    variance: number;
    hadOpenOrder: boolean;
    recordedBy: string | null;
    receivedAt: string;
    status: "open" | "resolved";
    reason: string | null;
    resolution: string | null;
  }>
> {
  const { results } = await env.OFFICE_DB.prepare(
    `SELECT gli.id AS grn_line_item_id, grn.id AS grn_id, grn.supplier_id AS supplier_id, ch.name AS supplier_name,
            gli.description AS description, gli.quantity_received AS quantity_received, gli.quantity_ordered AS quantity_ordered,
            gli.variance AS variance, gli.po_line_item_id AS po_line_item_id,
            grn.purchase_order_id AS purchase_order_id, grn.recorded_by AS recorded_by, grn.created_at AS created_at,
            vd.id AS disposition_id, vd.reason AS reason, vd.resolution AS resolution
       FROM grn_line_items gli
       JOIN goods_received_notes grn ON grn.id = gli.grn_id
       LEFT JOIN characters ch ON ch.id = grn.supplier_id
       LEFT JOIN variance_dispositions vd ON vd.grn_line_item_id = gli.id
      WHERE ((gli.po_line_item_id IS NULL AND gli.quantity_ordered = 0)
             OR (gli.po_line_item_id IS NOT NULL AND gli.variance IS NOT NULL AND gli.variance != 0))
        AND (? = 'all' OR vd.id IS NULL)
      ORDER BY grn.created_at DESC, gli.id DESC
      LIMIT ?`
  )
    .bind(status, Math.min(Math.max(limit, 1), 500))
    .all<{
      grn_line_item_id: number;
      grn_id: number;
      supplier_id: number | null;
      supplier_name: string | null;
      description: string;
      quantity_received: number;
      quantity_ordered: number | null;
      variance: number | null;
      po_line_item_id: number | null;
      purchase_order_id: number;
      recorded_by: string | null;
      created_at: string;
      disposition_id: number | null;
      reason: string | null;
      resolution: string | null;
    }>();
  return (results ?? []).map((r) => {
    const unordered = r.po_line_item_id == null;
    const variance = unordered ? r.quantity_received : r.variance ?? 0;
    return {
      grnLineItemId: r.grn_line_item_id,
      grnId: r.grn_id,
      kind: unordered ? ("unordered" as const) : variance < 0 ? ("short" as const) : ("over" as const),
      supplierId: r.supplier_id,
      supplierName: r.supplier_name,
      description: r.description,
      quantityReceived: r.quantity_received,
      expected: round4(r.quantity_received - variance),
      variance,
      hadOpenOrder: r.purchase_order_id !== 0,
      recordedBy: r.recorded_by,
      receivedAt: r.created_at,
      status: r.disposition_id != null ? ("resolved" as const) : ("open" as const),
      reason: r.reason,
      resolution: r.resolution,
    };
  });
}

// Real feature 2026-07-25 — Consumables Stock, the idea-tank review's
// first real, unlocked item, sequenced explicitly after PO/GRN in the
// original design and built now that PO/GRN is real and proven.
export async function registerStockItem(env: Env, name: string, unit: string | null): Promise<{ id: number; existed: boolean }> {
  // Found by the characterization recordings 2026-10-03: registering an item that was already tracked inserted a
  // SECOND row with the same name. Deliveries then added to the first, usage matched the first, and the second sat
  // at zero forever, shown as a duplicate line on the stock screen. The same name (ignoring case) is the same item.
  const existing = await env.OFFICE_DB.prepare("SELECT id FROM stock_items WHERE name = ? COLLATE NOCASE ORDER BY id LIMIT 1")
    .bind(name)
    .first<{ id: number }>();
  if (existing) return { id: existing.id, existed: true };
  const inserted = await env.OFFICE_DB.prepare(
    "INSERT INTO stock_items (name, unit, quantity_on_hand) VALUES (?, ?, 0) RETURNING id"
  )
    .bind(name, unit)
    .first<{ id: number }>();
  return { id: inserted!.id, existed: false };
}

export async function getTrackedStockItems(env: Env): Promise<Array<{ id: number; name: string; unit: string | null; quantity_on_hand: number }>> {
  const { results } = await env.OFFICE_DB.prepare("SELECT id, name, unit, quantity_on_hand FROM stock_items").all<{
    id: number;
    name: string;
    unit: string | null;
    quantity_on_hand: number;
  }>();
  return results ?? [];
}

// Real, deterministic decrement — the exact quantity stated, never
// estimated, linking a real drawdown to the real job it was consumed
// on when one is stated.
export async function recordStockUsage(
  env: Env,
  stockItemId: number,
  quantityUsed: number,
  customerId: number | null,
  sourceTranscript: string
): Promise<{ newQuantityOnHand: number }> {
  await env.OFFICE_DB.prepare("UPDATE stock_items SET quantity_on_hand = quantity_on_hand - ? WHERE id = ?")
    .bind(quantityUsed, stockItemId)
    .run();
  await env.OFFICE_DB.prepare(
    "INSERT INTO stock_usage_log (stock_item_id, quantity_used, customer_id, source_transcript) VALUES (?, ?, ?, ?)"
  )
    .bind(stockItemId, quantityUsed, customerId, sourceTranscript)
    .run();
  const updated = await env.OFFICE_DB.prepare("SELECT quantity_on_hand FROM stock_items WHERE id = ?")
    .bind(stockItemId)
    .first<{ quantity_on_hand: number }>();
  return { newQuantityOnHand: updated?.quantity_on_hand ?? 0 };
}

// Real feature 2026-07-25 — a real, physical stocktake, the exact
// same reconciliation philosophy as PO/GRN/Supplier Invoice — a real,
// computed variance stated as a fact, never judged. The physical
// count is real ground truth, so quantity_on_hand is corrected to
// match it here, the same way a real bank reconciliation corrects a
// ledger to match a real, physical statement.
export async function recordStocktake(
  env: Env,
  stockItemId: number,
  quantityCounted: number,
  sourceTranscript: string
): Promise<{ stocktakeId: number; quantityExpected: number; variance: number }> {
  const before = await env.OFFICE_DB.prepare("SELECT quantity_on_hand FROM stock_items WHERE id = ?")
    .bind(stockItemId)
    .first<{ quantity_on_hand: number }>();
  const quantityExpected = before?.quantity_on_hand ?? 0;
  const variance = quantityCounted - quantityExpected;

  const stocktake = await env.OFFICE_DB.prepare(
    "INSERT INTO stocktakes (source_transcript) VALUES (?) RETURNING id"
  )
    .bind(sourceTranscript)
    .first<{ id: number }>();
  const stocktakeId = stocktake!.id;

  await env.OFFICE_DB.prepare(
    "INSERT INTO stocktake_lines (stocktake_id, stock_item_id, quantity_counted, quantity_expected, variance) VALUES (?, ?, ?, ?, ?)"
  )
    .bind(stocktakeId, stockItemId, quantityCounted, quantityExpected, variance)
    .run();

  await env.OFFICE_DB.prepare("UPDATE stock_items SET quantity_on_hand = ? WHERE id = ?")
    .bind(quantityCounted, stockItemId)
    .run();

  return { stocktakeId, quantityExpected, variance };
}

// Real feature 2026-07-24 — Variance Disposition, what happens after
// a real, computed GRN discrepancy is found. Needed by the caller to
// give extractVarianceDisposition the real, known discrepancies to
// match against — the same reason extractGoodsReceived and
// extractSupplierInvoice need the real, given line items passed in.
// Only real, unresolved discrepancies (a non-zero variance with no
// disposition raised yet) are ever returned.
export async function getOpenDiscrepanciesForSupplier(
  env: Env,
  supplierId: number
): Promise<Array<{ grnLineItemId: number; description: string; variance: number }>> {
  const { results } = await env.OFFICE_DB.prepare(
    `SELECT gli.id, gli.description, gli.variance
     FROM grn_line_items gli
     JOIN goods_received_notes grn ON grn.id = gli.grn_id
     LEFT JOIN variance_dispositions vd ON vd.grn_line_item_id = gli.id
     WHERE grn.supplier_id = ? AND gli.variance IS NOT NULL AND gli.variance != 0 AND vd.id IS NULL
     ORDER BY grn.created_at DESC`
  )
    .bind(supplierId)
    .all<{ id: number; description: string; variance: number }>();
  return (results ?? []).map((r) => ({ grnLineItemId: r.id, description: r.description, variance: r.variance }));
}

// Real feature 2026-07-24 — Variance Disposition, the real, first
// piece: raising a reason. Deliberately unguarded but traceable,
// matching GRN's own precedent exactly — naming why a discrepancy
// happened is documentation, not money moving. Records the real
// reason, resolution, and any stated credit amount as data. The
// actual financial write-off this credit_amount implies (a real
// expense reduction against what's owed to the supplier) is
// deliberately deferred as its own, separate next step — not built
// here, so as not to conflate "naming why" with "actually adjusting
// the money," matching the scoped, one-domino-at-a-time discipline
// already proven for every other multi-stage feature tonight.
export async function recordVarianceDisposition(
  env: Env,
  grnLineItemId: number,
  reason: string | null,
  resolution: string | null,
  creditAmount: number | null,
  recordedByEmail: string | null = null
): Promise<{ dispositionId: number; expenseId: number | null }> {
  const inserted = await env.OFFICE_DB.prepare(
    "INSERT INTO variance_dispositions (grn_line_item_id, reason, resolution, credit_amount, recorded_by) VALUES (?, ?, ?, ?, ?) RETURNING id"
  )
    .bind(grnLineItemId, reason, resolution, creditAmount, recordedByEmail)
    .first<{ id: number }>();
  const dispositionId = inserted!.id;

  // Real feature 2026-07-24 — the real, second half of Variance
  // Disposition, deliberately built as its own step after the first
  // was proven: a "credit" resolution with a real, stated amount now
  // creates the real financial write-off it implies — a negative
  // expense against the same supplier, reducing what's actually owed
  // to them, the exact same deterministic reasoning already proven
  // for every other real rand figure in this project.
  let expenseId: number | null = null;
  if (resolution === "credit" && creditAmount != null && creditAmount > 0) {
    const chain = await env.OFFICE_DB.prepare(
      `SELECT gli.description, grn.supplier_id
       FROM grn_line_items gli
       JOIN goods_received_notes grn ON grn.id = gli.grn_id
       WHERE gli.id = ?`
    )
      .bind(grnLineItemId)
      .first<{ description: string; supplier_id: number | null }>();
    if (chain?.supplier_id != null) {
      const expense = await recordExpense(
        env,
        chain.supplier_id,
        -creditAmount,
        `Credit for ${chain.description} (${reason ?? "discrepancy"})`,
        `variance disposition #${dispositionId}`
      );
      expenseId = expense.id;
    }
  }

  return { dispositionId, expenseId };
}

// Real feature 2026-07-21 — Supplier Invoices, the third and final
// stage of the real, three-way design pinned in DECISIONS.md. This is
// where real money moves, and where both real reconciliations this
// whole arc exists for actually happen — quantity billed against
// quantity ordered, and price billed against price expected, both
// computed here, in code, never asked of the model. Creates a real
// expense on confirmation, linked back to the supplier, the same way
// every other real cost in this project is recorded.
// ---------------------------------------------------------------------------------------------------------------------------
// Matching a supplier invoice across ALL the supplier's open orders. Decided by Pierre 2026-10-04: an invoice used to be matched
// against the supplier's latest order only, so a bill that covered two orders (or the older of two) was checked against the wrong
// one, while deliveries already matched across every outstanding order, oldest first. Now the same rule applies to invoices.
// "Open" for an invoice means an order line with quantity not yet invoiced. When every order has been invoiced in full, the
// latest order is used as before, so nothing that worked is lost.
// ---------------------------------------------------------------------------------------------------------------------------
export interface InvoiceMatchLine {
  poId: number;
  poLineId: number;
  description: string;
  ordered: number;
  unbilled: number;
  unit: string | null;
  unitPriceExpected: number | null;
}

export async function getInvoiceMatchLines(env: Env, supplierId: number, latestPoId: number): Promise<InvoiceMatchLine[]> {
  await ensureCancellationTable(env);
  const { results } = await env.OFFICE_DB.prepare(
    `SELECT po.id AS po_id, pl.id AS po_line_id, pl.description AS description, pl.quantity_ordered AS ordered, pl.unit AS unit,
            pl.unit_price_expected AS unit_price_expected,
            COALESCE((SELECT SUM(sl.quantity_billed) FROM supplier_invoice_line_items sl WHERE sl.po_line_item_id = pl.id), 0) AS billed
       FROM po_line_items pl
       JOIN purchase_orders po ON po.id = pl.purchase_order_id
      WHERE po.supplier_id = ?
        AND po.id NOT IN (SELECT purchase_order_id FROM purchase_order_cancellations)
      ORDER BY po.created_at ASC, po.id ASC, pl.id ASC`
  )
    .bind(supplierId)
    .all<{ po_id: number; po_line_id: number; description: string; ordered: number; unit: string | null; unit_price_expected: number | null; billed: number }>();
  const rows: InvoiceMatchLine[] = (results ?? []).map((r) => ({
    poId: r.po_id,
    poLineId: r.po_line_id,
    description: r.description,
    ordered: r.ordered,
    unbilled: round4(r.ordered - r.billed),
    unit: r.unit,
    unitPriceExpected: r.unit_price_expected,
  }));
  const open = rows.filter((r) => r.unbilled > 0);
  if (open.length > 0) return open;
  return rows.filter((r) => r.poId === latestPoId).map((r) => ({ ...r, unbilled: r.ordered }));
}

// The billed lines, each placed against the oldest order line with something unbilled, spilling into the next when it does not
// fit; anything billed beyond everything ordered stays on the last line it reached (so it still shows as a variance). A billed
// line that is not on any open order stays unmatched. When the invoice touches MORE THAN ONE order each placed line names its
// own order line (po_line_item_id); when it touches one, nothing is added, so a single-order invoice is exactly what it always was.
export function allocateInvoiceLines<T extends { matched_description: string | null; quantity_billed: number }>(
  lines: T[],
  pool: InvoiceMatchLine[]
): { lines: Array<T & { po_line_item_id?: number }>; orderIds: number[]; primaryPoId: number | null } {
  const left = new Map<number, number>(pool.map((l) => [l.poLineId, l.unbilled]));
  const placed: Array<{ line: T; target: InvoiceMatchLine | null }> = [];
  const touched = new Set<number>();
  for (const line of lines) {
    const name = (line.matched_description ?? "").toLowerCase();
    const candidates = name ? pool.filter((c) => c.description.toLowerCase() === name) : [];
    if (candidates.length === 0) {
      placed.push({ line, target: null });
      continue;
    }
    let remaining = round4(Number(line.quantity_billed));
    const parts: Array<{ c: InvoiceMatchLine; qty: number }> = [];
    for (const c of candidates) {
      if (remaining <= 0) break;
      const capacity = left.get(c.poLineId) ?? 0;
      if (capacity <= 0) continue;
      const take = Math.min(remaining, capacity);
      parts.push({ c, qty: take });
      left.set(c.poLineId, round4(capacity - take));
      remaining = round4(remaining - take);
    }
    // Nothing could be placed. Excess with no capacity left stays on the last order; a line with nothing to place at all goes to the oldest.
    if (parts.length === 0) parts.push({ c: remaining > 0 ? candidates[candidates.length - 1] : candidates[0], qty: remaining });
    else if (remaining > 0) parts[parts.length - 1].qty = round4(parts[parts.length - 1].qty + remaining);
    for (const part of parts) {
      const unchanged = parts.length === 1 && part.qty === Number(line.quantity_billed);
      placed.push({ line: unchanged ? line : { ...line, quantity_billed: part.qty }, target: part.c });
      touched.add(part.c.poId);
    }
  }
  const explicit = touched.size > 1;
  return {
    lines: placed.map(({ line, target }) => (explicit && target ? { ...line, po_line_item_id: target.poLineId } : line)),
    orderIds: pool.map((p) => p.poId).filter((id, i, all) => touched.has(id) && all.indexOf(id) === i),
    primaryPoId: pool.find((p) => touched.has(p.poId))?.poId ?? null,
  };
}

// What the invoice reader is shown: each distinct item on any open order once (it only needs the names, to match what was billed).
export function invoiceCandidatesForReader(pool: InvoiceMatchLine[]): Array<{ description: string; quantity_ordered: number; unit: string | null; unit_price_expected: number | null }> {
  const seen = new Set<string>();
  const out: Array<{ description: string; quantity_ordered: number; unit: string | null; unit_price_expected: number | null }> = [];
  for (const l of pool) {
    const key = l.description.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ description: l.description, quantity_ordered: l.ordered, unit: l.unit, unit_price_expected: l.unitPriceExpected });
  }
  return out;
}

// " Matched across orders #1 and #3." when one invoice spans several orders, and nothing when it does not.
export function invoiceOrdersNote(orderIds: number[]): string {
  if (orderIds.length < 2) return "";
  const names = orderIds.map((id) => `#${id}`);
  return ` Matched across orders ${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}.`;
}

// ---------------------------------------------------------------------------------------------------------------------------
// The same supplier invoice said twice. Decided by Pierre 2026-10-04: nothing checked an invoice's reference, so saying the same
// invoice twice recorded it twice. An invoice whose reference is already RECORDED for that supplier, or already WAITING for
// confirmation, is not recorded or held again, and the reply says so. A reference is compared ignoring case and extra spaces, and
// only for the same supplier (two suppliers can both have an INV-001). An invoice with no reference stated cannot be checked.
// ---------------------------------------------------------------------------------------------------------------------------
export function normalizeInvoiceReference(reference: string | null | undefined): string | null {
  const r = (reference ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  return r.length > 0 ? r : null;
}

export async function findDuplicateSupplierInvoice(
  env: Env,
  supplierId: number,
  reference: string | null | undefined
): Promise<{ kind: "recorded"; amount: number; date: string } | { kind: "waiting"; actionId: number } | null> {
  const wanted = normalizeInvoiceReference(reference);
  if (wanted === null) return null;
  const { results: recorded } = await env.OFFICE_DB.prepare(
    "SELECT supplier_reference, amount, created_at FROM supplier_invoices WHERE supplier_id = ? AND supplier_reference IS NOT NULL ORDER BY id"
  )
    .bind(supplierId)
    .all<{ supplier_reference: string; amount: number; created_at: string }>();
  const hit = (recorded ?? []).find((r) => normalizeInvoiceReference(r.supplier_reference) === wanted);
  if (hit) return { kind: "recorded", amount: hit.amount, date: String(hit.created_at).slice(0, 10) };
  const { results: waiting } = await env.OFFICE_DB.prepare(
    "SELECT id, payload FROM pending_actions WHERE type = 'supplier_invoice' AND status IN ('pending', 'processing') ORDER BY id"
  ).all<{ id: number; payload: string }>();
  for (const w of waiting ?? []) {
    try {
      const payload = JSON.parse(w.payload) as { supplierId?: number | null; supplierReference?: string | null };
      if (payload.supplierId === supplierId && normalizeInvoiceReference(payload.supplierReference) === wanted) return { kind: "waiting", actionId: w.id };
    } catch {
      /* a payload that cannot be read cannot be a duplicate */
    }
  }
  return null;
}

export function duplicateInvoiceMessage(
  supplier: string,
  reference: string,
  duplicate: { kind: "recorded"; amount: number; date: string } | { kind: "waiting"; actionId: number }
): string {
  reference = reference.replace(/\s+/g, " ").trim();
  return duplicate.kind === "recorded"
    ? `Invoice ${reference} from ${supplier} is already recorded (R${duplicate.amount} on ${duplicate.date}), so nothing was recorded again.`
    : `Invoice ${reference} from ${supplier} is already waiting for your confirmation (action #${duplicate.actionId}), so nothing new was held.`;
}

export async function recordSupplierInvoice(
  env: Env,
  purchaseOrderId: number | null,
  supplierId: number | null,
  supplierReference: string | null,
  sourceTranscript: string,
  lineItems: Array<{ matched_description: string | null; quantity_billed: number; unit_price_billed: number | null; po_line_item_id?: number | null }>
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
    // Real, new field, per direct instruction: the real, missing
    // buy-side half of the products foundation. Inherited directly
    // from the matched PO line item — a supplier invoice line never
    // needs its own separate product resolution, since it's always
    // reconciled against a PO line that already has this real, once
    // it's been ordered through recordPurchaseOrder.
    productId: number | null;
  }> = [];

  for (const item of lineItems) {
    // A line that names its own order line (an invoice that spans orders) is matched to exactly that line; otherwise by name against
    // the invoice's order, as it always was.
    const matchedPoLine =
      item.po_line_item_id != null
        ? ((await env.OFFICE_DB.prepare(
            "SELECT id, description, quantity_ordered, unit, unit_price_expected, product_id FROM po_line_items WHERE id = ?"
          )
            .bind(item.po_line_item_id)
            .first<(typeof poLineItems)[number]>()) ?? null)
        : item.matched_description
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
      productId: matchedPoLine?.product_id ?? null,
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
      "INSERT INTO supplier_invoice_line_items (supplier_invoice_id, po_line_item_id, description, quantity_billed, unit_price_billed, quantity_variance, price_variance, line_total, product_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
      .bind(
        supplierInvoiceId,
        item.poLineItemId,
        item.description,
        item.quantityBilled,
        item.unitPriceBilled,
        item.quantityVariance,
        item.priceVariance,
        item.lineTotal,
        item.productId
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

// Real feature 2026-07-25 — GRN-informed pricing, pinned earlier the
// same night as a real opportunity unlocked by the PO/GRN/Supplier
// Invoice arc: real, dated material cost history now exists that
// never did before. Grounds Peter's own pricing judgment with a real
// fact he can ask for — never replaces it, never suggests a rate on
// its own. A partial, case-insensitive match against real supplier
// invoice line items, most recent first — the same deterministic
// lookup discipline as every other real query in this project.
export async function getLastPricePaid(
  env: Env,
  materialName: string,
  supplierId: number | null = null
): Promise<{ description: string; unitPrice: number; supplierName: string | null; date: string } | null> {
  const supplierFilter = supplierId != null ? "AND si.supplier_id = ?" : "";
  const bindings: (string | number)[] = [`%${materialName}%`];
  if (supplierId != null) bindings.push(supplierId);

  const row = await env.OFFICE_DB.prepare(
    `SELECT sili.description, sili.unit_price_billed, ch.name as supplier_name, si.created_at
     FROM supplier_invoice_line_items sili
     JOIN supplier_invoices si ON si.id = sili.supplier_invoice_id
     LEFT JOIN characters ch ON ch.id = si.supplier_id
     WHERE sili.description LIKE ? COLLATE NOCASE AND sili.unit_price_billed IS NOT NULL ${supplierFilter}
     ORDER BY si.created_at DESC
     LIMIT 1`
  )
    .bind(...bindings)
    .first<{ description: string; unit_price_billed: number; supplier_name: string | null; created_at: string }>();

  if (!row) return null;
  return {
    description: row.description,
    unitPrice: row.unit_price_billed,
    supplierName: row.supplier_name,
    date: row.created_at,
  };
}

// Real feature 2026-07-25 — Snags, the smallest, most immediately
// useful piece of the job-completion/warranty/snags design. Raising
// and resolving stays deliberately unguarded but traceable — a
// quality note, not money moving, matching GRN's own precedent.
export async function recordSnag(env: Env, customerId: number, description: string): Promise<{ id: number }> {
  const inserted = await env.OFFICE_DB.prepare(
    "INSERT INTO snags (customer_id, description, status) VALUES (?, ?, 'open') RETURNING id"
  )
    .bind(customerId, description)
    .first<{ id: number }>();
  return { id: inserted!.id };
}

export async function getOpenSnagsForCustomer(env: Env, customerId: number): Promise<Array<{ id: number; description: string }>> {
  const { results } = await env.OFFICE_DB.prepare(
    "SELECT id, description FROM snags WHERE customer_id = ? AND status = 'open'"
  )
    .bind(customerId)
    .all<{ id: number; description: string }>();
  return results ?? [];
}

// Real feature 2026-07-25 — resolving a snag, and surfacing the real,
// valuable connection to retention as an informational fact only —
// never an automatic financial write. If this customer has a real
// retention arrangement and this was genuinely the last open snag,
// that's worth telling Peter directly, so he can decide to release it
// himself, the same real, deliberate action every other financial
// write in this project already requires.
export async function resolveSnag(
  env: Env,
  snagId: number,
  customerId: number
): Promise<{ retentionReleasable: boolean; retentionAmount: number | null }> {
  await env.OFFICE_DB.prepare("UPDATE snags SET status = 'resolved', resolved_at = datetime('now') WHERE id = ?")
    .bind(snagId)
    .run();

  const remainingOpen = await env.OFFICE_DB.prepare(
    "SELECT COUNT(*) as count FROM snags WHERE customer_id = ? AND status = 'open'"
  )
    .bind(customerId)
    .first<{ count: number }>();

  const customer = await env.OFFICE_DB.prepare("SELECT retention_percent FROM customers WHERE id = ?")
    .bind(customerId)
    .first<{ retention_percent: number | null }>();

  const noOpenSnagsLeft = (remainingOpen?.count ?? 0) === 0;
  const hasRetention = customer?.retention_percent != null && customer.retention_percent > 0;

  if (noOpenSnagsLeft && hasRetention) {
    const retentionTotal = await env.OFFICE_DB.prepare(
      "SELECT COALESCE(SUM(retention_amount), 0) as total FROM invoices WHERE customer_id = ?"
    )
      .bind(customerId)
      .first<{ total: number }>();
    return { retentionReleasable: true, retentionAmount: retentionTotal?.total ?? null };
  }

  return { retentionReleasable: false, retentionAmount: null };
}

// Real feature 2026-07-25 — the lead/enquiry stage, the fourth real
// gap named from the full lead-to-warranty lifecycle walk. Raising
// stays deliberately unguarded but traceable — a real note about
// interest, not money moving.
export async function recordLead(
  env: Env,
  name: string,
  interest: string | null,
  source: string | null,
  captureId: number | null
): Promise<{ id: number }> {
  const inserted = await env.OFFICE_DB.prepare(
    "INSERT INTO leads (name, interest, source, status, capture_id) VALUES (?, ?, ?, 'enquired', ?) RETURNING id"
  )
    .bind(name, interest, source, captureId)
    .first<{ id: number }>();
  return { id: inserted!.id };
}

export async function getOpenLeads(env: Env): Promise<Array<{ id: number; name: string }>> {
  const { results } = await env.OFFICE_DB.prepare(
    "SELECT id, name FROM leads WHERE status IN ('enquired', 'quoted')"
  ).all<{ id: number; name: string }>();
  return results ?? [];
}

export async function markLeadLost(env: Env, leadId: number): Promise<void> {
  await env.OFFICE_DB.prepare("UPDATE leads SET status = 'lost' WHERE id = ?").bind(leadId).run();
}

// Real feature 2026-07-25 — the automatic "quoted" transition, the
// real point of this whole design: converts into a real customer and
// quotation once priced, reusing existing machinery rather than
// duplicating data. Called from the same, already-proven quotation-
// recording path — never a separate mechanism. Only ever matches an
// exact name still genuinely enquired (not already quoted, won, or
// lost), so a second, unrelated quotation for the same name later
// doesn't incorrectly re-trigger this.
export async function transitionLeadToQuoted(env: Env, customerName: string, customerId: number): Promise<void> {
  await env.OFFICE_DB.prepare(
    "UPDATE leads SET status = 'quoted', customer_id = ? WHERE name = ? COLLATE NOCASE AND status = 'enquired'"
  )
    .bind(customerId, customerName)
    .run();
}

// Real feature 2026-07-25 — the automatic "won" transition, hooked
// into the same, already-proven quote-to-invoice conversion — the
// real moment a job is actually won, not a separate, new decision.
export async function transitionLeadToWon(env: Env, customerId: number): Promise<void> {
  await env.OFFICE_DB.prepare(
    "UPDATE leads SET status = 'won' WHERE customer_id = ? AND status = 'quoted'"
  )
    .bind(customerId)
    .run();
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
// Real fix 2026-07-22 — found live via Layer 2 testing: once a
// customer genuinely has multiple job scopes (now that same-breath
// assembly correctly groups them), "the customer's most recent job
// scope" stopped being a safe assumption. Peter asked to price the
// screed job specifically; this silently matched the carpet job
// instead, since it happened to be newer — a real, wrong quotation
// would have gone out. Fixed by matching against what was actually
// named in the transcript first (a real, deterministic substring
// check against each job scope's own description, component names,
// and task descriptions — never an AI judgment call), falling back to
// "most recent" only when nothing in the transcript matches any real,
// existing job scope at all.
export async function findLatestJobScope(
  env: Env,
  customerId: number,
  transcript: string = ""
): Promise<{
  id: number;
  description: string;
  components: Array<{ id: number; name: string; area_sqm: number | null }>;
  tasks: Array<{ id: number; description: string; component_id: number | null }>;
} | null> {
  const { results: candidates } = await env.OFFICE_DB.prepare(
    "SELECT id, description FROM job_scopes WHERE customer_id = ? ORDER BY created_at DESC"
  )
    .bind(customerId)
    .all<{ id: number; description: string }>();

  if (!candidates || candidates.length === 0) return null;

  let scope: { id: number; description: string } | undefined;

  if (candidates.length > 1 && transcript) {
    // Real fix, found live: the customer's own name is a real word
    // that would otherwise "match" every one of their job scopes
    // equally, since components are routinely named with the
    // customer's name as a prefix ("Thabo downstairs", "Thabo
    // upstairs") — an artifact of how components get named, not a
    // real distinguishing signal. Excluded here so only genuinely
    // distinguishing words (like "screed" vs "carpet") ever decide a
    // match.
    const customer = await env.OFFICE_DB.prepare("SELECT name FROM customers WHERE id = ?")
      .bind(customerId)
      .first<{ name: string }>();
    const customerNameLower = customer?.name?.toLowerCase() ?? "";

    const lowerTranscript = transcript.toLowerCase();
    for (const candidate of candidates) {
      const { results: candidateComponents } = await env.OFFICE_DB.prepare(
        "SELECT name FROM scope_components WHERE job_scope_id = ?"
      )
        .bind(candidate.id)
        .all<{ name: string }>();
      const { results: candidateTasks } = await env.OFFICE_DB.prepare(
        "SELECT description FROM scope_tasks WHERE job_scope_id = ?"
      )
        .bind(candidate.id)
        .all<{ description: string }>();
      const realWords = [
        candidate.description,
        ...(candidateComponents ?? []).map((c) => c.name),
        ...(candidateTasks ?? []).map((t) => t.description),
      ]
        .join(" ")
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 3 && w !== customerNameLower); // skip short, generic words, and the customer's own name
      if (realWords.some((word) => lowerTranscript.includes(word))) {
        scope = candidate;
        break;
      }
    }
  }

  // Falls back to the original, existing behavior — most recent —
  // only when nothing in the transcript actually matched a real job
  // scope, preserving every case this already worked correctly for.
  if (!scope) {
    scope = candidates[0];
  }

  const { results: components } = await env.OFFICE_DB.prepare(
    "SELECT id, name, area_sqm FROM scope_components WHERE job_scope_id = ?"
  )
    .bind(scope.id)
    .all<{ id: number; name: string; area_sqm: number | null }>();

  const { results: tasks } = await env.OFFICE_DB.prepare(
    "SELECT id, description, component_id FROM scope_tasks WHERE job_scope_id = ?"
  )
    .bind(scope.id)
    .all<{ id: number; description: string; component_id: number | null }>();

  return { id: scope.id, description: scope.description, components: components ?? [], tasks: tasks ?? [] };
}

// Real, shared check, per direct instruction after a real, confirmed
// bug: recordWorkObservation always created a new job scope
// unconditionally, with no check for whether a message describing a
// schedule/installer change was actually about a job that already
// exists. Built once here and called from every real site that can
// produce a pure-logistics observation, rather than patched into one
// call site at a time — the same "fix the pipeline, not the instance"
// discipline already insisted on tonight. Deliberately narrow,
// grounded in the real case that exposed this: only ever considered
// when this message has no new components or tasks of its own — a
// genuinely new job almost always comes with real measurements
// attached; a message that's purely a date/installer change, with
// nothing new being measured, is the actual real signal. Reuses
// findLatestJobScope exactly as-is for recall — the same real,
// deterministic transcript-matching already proven for pricing
// (2026-07-22). Only ever a second opinion, held for a human to
// confirm — never auto-applied, same guard() discipline as every
// other consequential write.
export async function checkForJobScopeAmendment(
  env: Env,
  customerId: number | null,
  observation: { components: unknown[]; tasks: unknown[]; scheduled_date_raw: string | null },
  installerId: number | null,
  // Real, new parameter, per direct instruction: the actual typed
  // installer name, not just its resolved id — needed so the real,
  // human-readable value ("Liam") can be shown and tap-to-edited,
  // rather than a raw database id no one would recognize.
  installerName: string | null,
  transcript: string,
  captureId: number | null
): Promise<{
  pendingActionId: number;
  message: string;
  changes: Array<{ field: string; label: string; displayValue: string }>;
} | null> {
  if (customerId === null) return null;
  if (observation.components.length !== 0 || observation.tasks.length !== 0) return null;
  if (!observation.scheduled_date_raw && installerId === null) return null;

  const existingJobScope = await findLatestJobScope(env, customerId, transcript);
  if (!existingJobScope) return null;

  const currentFields = await env.OFFICE_DB.prepare("SELECT scheduled_date_raw, installer_id FROM job_scopes WHERE id = ?")
    .bind(existingJobScope.id)
    .first<{ scheduled_date_raw: string | null; installer_id: number | null }>();

  const changes: Array<{ field: string; oldValue: string | null; newValue: string | null }> = [];
  // Real, new companion array, per direct instruction: the same real
  // changes, in human-readable form — a label a person would
  // recognize, and the actual typed value rather than a raw id. This
  // is what the client shows and lets someone tap-to-edit; `changes`
  // above stays the exact real audit shape already proven and logged.
  const displayChanges: Array<{ field: string; label: string; displayValue: string }> = [];
  if (observation.scheduled_date_raw) {
    changes.push({ field: "scheduled_date_raw", oldValue: currentFields?.scheduled_date_raw ?? null, newValue: observation.scheduled_date_raw });
    displayChanges.push({ field: "scheduled_date_raw", label: "Date", displayValue: observation.scheduled_date_raw });
  }
  if (installerId !== null && installerId !== currentFields?.installer_id) {
    changes.push({ field: "installer_id", oldValue: currentFields?.installer_id != null ? String(currentFields.installer_id) : null, newValue: String(installerId) });
    displayChanges.push({ field: "installer_id", label: "Installer", displayValue: installerName ?? String(installerId) });
  }
  if (changes.length === 0) return null;

  const held = await holdForConfirmation(
    env,
    "job_scope_amendment",
    { jobScopeId: existingJobScope.id, jobScopeDescription: existingJobScope.description, changes, customerId, observation, installerId, transcript, captureId },
    transcript
  );
  return {
    pendingActionId: held.id,
    message: `Job #${existingJobScope.id} ("${existingJobScope.description}") — update it, or create this as a separate new job?`,
    changes: displayChanges,
  };
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

  // Real fix 2026-07-24 — found live via the job-completion test: a
  // converted invoice never carried forward the source quotation's
  // real job_scope_id, so it silently dropped out of a project's real
  // totals the moment it was converted, even though the quotation
  // itself was correctly linked. Copied forward here, deterministically.
  const sourceQuotation = await env.OFFICE_DB.prepare("SELECT job_scope_id FROM quotations WHERE id = ?")
    .bind(quotationId)
    .first<{ job_scope_id: number | null }>();
  const jobScopeId = sourceQuotation?.job_scope_id ?? null;

  // Real, deliberately narrow addition - a real due_date, 30 days
  // from creation, same honest default as the direct-invoice path.
  const dueDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

  const inserted = await env.OFFICE_DB.prepare(
    "INSERT INTO invoices (customer_id, description, amount, source_transcript, quotation_id, retention_percent, retention_amount, job_scope_id, due_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id"
  )
    .bind(customerId, description, remainingBalance, sourceTranscript, quotationId, retentionPercent, retentionAmount, jobScopeId, dueDate)
    .first<{ id: number }>();

  const invoiceId = inserted!.id;

  await env.OFFICE_DB.prepare(
    "INSERT INTO line_items (invoice_id, description, quantity, unit_price, line_total) VALUES (?, ?, 1, ?, ?)"
  )
    .bind(invoiceId, description, remainingBalance, remainingBalance)
    .run();

  await env.OFFICE_DB.prepare("UPDATE quotations SET status = 'converted' WHERE id = ?").bind(quotationId).run();

  // Real feature 2026-07-25 — the lead/enquiry stage's "won"
  // transition, hooked into the same, already-proven quote-to-invoice
  // conversion — the real moment a job is actually won. A safe
  // no-op when no matching quoted lead exists for this customer.
  await transitionLeadToWon(env, customerId);

  return { invoiceId };
}

// Real feature — date-ranging for the report functions. Until now every
// report here was all-time only, which made "compare April to March"
// literally unanswerable (see CONVERSATIONAL_BI_ARCHITECTURE.md, first
// real prerequisite). Deliberately small and additive: every ranged
// function takes an OPTIONAL range, and with none supplied behaves
// exactly as it always did, so no existing caller changes.
//
// Dates are South African LOCAL calendar dates (YYYY-MM-DD), both ends
// INCLUSIVE ("2026-03-01" to "2026-03-31" is the whole of March).
// created_at is stored in UTC (SQLite datetime('now')), and South Africa
// is a fixed UTC+2 with no daylight saving, so a local day is converted
// to an exact, half-open UTC window [start, next-day-start). That way a
// record made at 23:30 local on 31 March counts as March, not April.
// Ranges apply to when a record was ENTERED (created_at) — the only date
// every one of these tables genuinely has.
export interface DateRange {
  from?: string;
  to?: string;
}

const SA_UTC_OFFSET_HOURS = 2;

function isRealDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function localDayStartUtc(value: string, addDays = 0): string {
  const [y, m, d] = value.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + addDays, -SA_UTC_OFFSET_HOURS));
  return dt.toISOString().slice(0, 19).replace("T", " ");
}

// Validates raw query-string style input. Throws a plain, readable Error
// on anything malformed rather than silently ignoring it — a mistyped
// date quietly falling back to all-time would produce a plausible,
// wrong report, which is worse than a visible failure.
export function parseDateRange(from: string | null | undefined, to: string | null | undefined): DateRange {
  const range: DateRange = {};
  if (from) {
    if (!isRealDate(from)) throw new Error(`Invalid 'from' date "${from}" — expected a real date as YYYY-MM-DD.`);
    range.from = from;
  }
  if (to) {
    if (!isRealDate(to)) throw new Error(`Invalid 'to' date "${to}" — expected a real date as YYYY-MM-DD.`);
    range.to = to;
  }
  if (range.from && range.to && range.from > range.to) {
    throw new Error(`'from' (${range.from}) must not be after 'to' (${range.to}).`);
  }
  return range;
}

export function describeRange(range?: DateRange): string | null {
  if (!range?.from && !range?.to) return null;
  if (range.from && range.to) return `from ${range.from} to ${range.to}`;
  if (range.from) return `from ${range.from} onward`;
  return `up to ${range.to}`;
}

function dateFilter(
  range: DateRange | undefined,
  column: string,
  keyword: "WHERE" | "AND"
): { sql: string; binds: string[] } {
  const parts: string[] = [];
  const binds: string[] = [];
  if (range?.from) {
    parts.push(`${column} >= ?`);
    binds.push(localDayStartUtc(range.from));
  }
  if (range?.to) {
    parts.push(`${column} < ?`);
    binds.push(localDayStartUtc(range.to, 1));
  }
  return { sql: parts.length ? ` ${keyword} ${parts.join(" AND ")}` : "", binds };
}

function withBinds(stmt: D1PreparedStatement, binds: string[]): D1PreparedStatement {
  return binds.length ? stmt.bind(...binds) : stmt;
}

const RANGE_BASIS_NOTE =
  "Periods are by the date each record was entered into the system, not a separately recorded business date.";

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
export async function getQuotationsSummary(env: Env, range?: DateRange): Promise<string[]> {
  const period = describeRange(range);
  const filter = dateFilter(range, "q.created_at", "WHERE");
  const { results } = await withBinds(
    env.OFFICE_DB.prepare(
      `SELECT c.name as name, q.amount as amount, q.status as status
     FROM quotations q JOIN customers c ON c.id = q.customer_id${filter.sql}
     ORDER BY q.created_at DESC`
    ),
    filter.binds
  ).all<{ name: string; amount: number; status: string }>();

  if (results.length === 0) return [period ? `No quotations on file ${period}.` : "No quotations on file."];

  const total = results.reduce((sum, r) => sum + r.amount, 0);
  const openCount = results.filter((r) => r.status !== "converted").length;
  const summary = `There ${results.length === 1 ? "is" : "are"} ${results.length} ${results.length === 1 ? "quotation" : "quotations"} on file${period ? ` ${period}` : ""}, totaling R${total}. ${openCount} still open, not yet converted to an invoice.`;
  const perQuotation = results.map((r) => `${r.name}: R${r.amount} (${r.status}).`);
  return period ? [summary, RANGE_BASIS_NOTE, ...perQuotation] : [summary, ...perQuotation];
}

// Real feature 2026-07-12 — the second concrete piece of the expense
// side of the accounting-capability roadmap, mirroring
// getQuotationsSummary's exact shape for consistency. Real, deterministic
// SQL aggregate, same as every other business-summary function here —
// never an AI attempting to recall or total these from memory.
export async function getExpenseSummary(env: Env, range?: DateRange): Promise<string[]> {
  const period = describeRange(range);
  const filter = dateFilter(range, "e.created_at", "WHERE");
  const { results } = await withBinds(
    env.OFFICE_DB.prepare(
      `SELECT COALESCE(c.name, 'an unnamed supplier') as name, e.amount as amount, e.description as description,
            COALESCE(e.category, 'uncategorized') as category
     FROM expenses e LEFT JOIN characters c ON c.id = e.character_id${filter.sql}
     ORDER BY e.created_at DESC`
    ),
    filter.binds
  ).all<{ name: string; amount: number | null; description: string; category: string }>();

  if (results.length === 0) return [period ? `No expenses on file ${period}.` : "No expenses on file."];

  const total = results.reduce((sum, r) => sum + (r.amount ?? 0), 0);
  const summary = `There ${results.length === 1 ? "is" : "are"} ${results.length} ${results.length === 1 ? "expense" : "expenses"} on file${period ? ` ${period}` : ""}, totaling R${total}.`;

  const byCategory = new Map<string, number>();
  for (const r of results) {
    byCategory.set(r.category, (byCategory.get(r.category) ?? 0) + (r.amount ?? 0));
  }
  const categoryBreakdown = `By category: ${Array.from(byCategory.entries())
    .map(([cat, amt]) => `${cat} R${amt}`)
    .join(", ")}.`;

  const perExpense = results.map((r) => `${r.name}: R${r.amount ?? 0} — ${r.description} (${r.category}).`);
  return period ? [summary, RANGE_BASIS_NOTE, categoryBreakdown, ...perExpense] : [summary, categoryBreakdown, ...perExpense];
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
export async function getFinancialSnapshot(env: Env, range?: DateRange): Promise<string[]> {
  const period = describeRange(range);
  const filter = dateFilter(range, "created_at", "WHERE");
  const [invoicedRow, paidRow, expensesRow] = await Promise.all([
    withBinds(
      env.OFFICE_DB.prepare(`SELECT COALESCE(SUM(amount), 0) as total FROM invoices${filter.sql}`),
      filter.binds
    ).first<{ total: number }>(),
    withBinds(
      env.OFFICE_DB.prepare(`SELECT COALESCE(SUM(amount), 0) as total FROM payments${filter.sql}`),
      filter.binds
    ).first<{ total: number }>(),
    withBinds(
      env.OFFICE_DB.prepare(`SELECT COALESCE(SUM(amount), 0) as total FROM expenses${filter.sql}`),
      filter.binds
    ).first<{ total: number }>(),
  ]);

  const totalInvoiced = invoicedRow?.total ?? 0;
  const totalPaid = paidRow?.total ?? 0;
  const totalExpenses = expensesRow?.total ?? 0;
  const roughPosition = totalPaid - totalExpenses;

  const invoicedLabel = period ? `Total invoiced ${period}` : "Total invoiced to date";
  const periodNote = period ? [RANGE_BASIS_NOTE] : [];

  return [
    `${invoicedLabel}: R${totalInvoiced}.`,
    `Total actually received${period ? ` ${period}` : ""}: R${totalPaid}.`,
    `Total spent on expenses${period ? ` ${period}` : ""}: R${totalExpenses}.`,
    // Real fix 2026-07-12: this caveat had gone stale — expense
    // categories and job-cost linking both exist now. This is still
    // deliberately a cash-basis snapshot (received minus spent), not
    // the formal, accrual-based P&L below — different questions,
    // both real.
    `Rough cash position (received minus spent): R${roughPosition}. This is a cash-basis snapshot, not the formal profit and loss — see getProfitAndLoss for that.`,
    ...periodNote,
  ];
}

export interface ProfitAndLossReport {
  revenue: number;
  costOfSales: number;
  grossProfit: number;
  operatingExpenses: number;
  netProfit: number;
  categoryBreakdown: Record<string, number>;
  // Only present when a range was requested — all-time reports keep
  // exactly the shape they always had.
  period?: DateRange;
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
export async function getProfitAndLoss(env: Env, range?: DateRange): Promise<ProfitAndLossReport> {
  const filter = dateFilter(range, "created_at", "WHERE");
  const revenueRow = await withBinds(
    env.OFFICE_DB.prepare(`SELECT COALESCE(SUM(amount), 0) as total FROM invoices${filter.sql}`),
    filter.binds
  ).first<{
    total: number;
  }>();
  const revenue = revenueRow?.total ?? 0;

  const { results: categoryRows } = await withBinds(
    env.OFFICE_DB.prepare(
      `SELECT COALESCE(category, 'other') as category, COALESCE(SUM(amount), 0) as total FROM expenses${filter.sql} GROUP BY COALESCE(category, 'other')`
    ),
    filter.binds
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

  const report: ProfitAndLossReport = { revenue, costOfSales, grossProfit, operatingExpenses, netProfit, categoryBreakdown };
  if (describeRange(range)) report.period = { ...range };
  return report;
}

export async function getProfitAndLossSummary(env: Env, range?: DateRange): Promise<string[]> {
  const report = await getProfitAndLoss(env, range);
  const period = describeRange(range);
  const categoryLines = Object.entries(report.categoryBreakdown).map(([cat, amt]) => `${cat}: R${amt}`);

  return [
    ...(period ? [`Profit and loss ${period}.`, RANGE_BASIS_NOTE] : []),
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

export interface AgedCreditorRow {
  supplierId: number;
  supplierName: string;
  current: number;
  days30: number;
  days60: number;
  days90Plus: number;
  total: number;
}

// Real feature 2026-07-24 — Aged Creditors, the real prerequisite
// (supplier_payments) now in place. Mirrors getAgedDebtorsReport
// exactly — real expenses played oldest-first against real supplier
// payments, the same FIFO convention already proven, applied to the
// opposite direction of money. Built in certain anticipation of a
// real, recurring need (a monthly supplier statement), not
// speculative completeness.
export async function getAgedCreditorsReport(env: Env): Promise<AgedCreditorRow[]> {
  const { results: suppliers } = await env.OFFICE_DB.prepare(
    "SELECT DISTINCT ch.id, ch.name FROM characters ch JOIN expenses e ON e.character_id = ch.id"
  ).all<{ id: number; name: string }>();

  const now = Date.now();
  const rows: AgedCreditorRow[] = [];

  for (const supplier of suppliers) {
    const { results: expenseRows } = await env.OFFICE_DB.prepare(
      "SELECT amount, created_at FROM expenses WHERE character_id = ? ORDER BY created_at ASC"
    )
      .bind(supplier.id)
      .all<{ amount: number; created_at: string }>();

    const paidRow = await env.OFFICE_DB.prepare(
      "SELECT COALESCE(SUM(amount), 0) as total FROM supplier_payments WHERE character_id = ?"
    )
      .bind(supplier.id)
      .first<{ total: number }>();

    // Real fix 2026-07-24, found live: a credit (a negative expense,
    // e.g. Variance Disposition's own credit resolution) is a real
    // reduction in what's owed — the same real effect as a payment,
    // just recorded on the expense side rather than a separate table.
    // Folded into the same payment pool here, applied FIFO
    // oldest-first, the same convention already proven for real
    // payments — never skipped the way the debtors-side check would
    // have done, since Aged Debtors never has a negative invoice to
    // begin with and this exact scenario never arose there.
    const creditTotal = expenseRows.filter((e) => e.amount < 0).reduce((sum, e) => sum - e.amount, 0);
    const realExpenses = expenseRows.filter((e) => e.amount >= 0);

    let remainingPayment = (paidRow?.total ?? 0) + creditTotal;
    let current = 0;
    let days30 = 0;
    let days60 = 0;
    let days90Plus = 0;

    for (const exp of realExpenses) {
      let owed = exp.amount;
      if (remainingPayment > 0) {
        const applied = Math.min(remainingPayment, owed);
        owed -= applied;
        remainingPayment -= applied;
      }
      if (owed <= 0) continue;

      const ageDays = Math.floor((now - new Date(exp.created_at).getTime()) / 86400000);
      if (ageDays <= 30) current += owed;
      else if (ageDays <= 60) days30 += owed;
      else if (ageDays <= 90) days60 += owed;
      else days90Plus += owed;
    }

    const total = current + days30 + days60 + days90Plus;
    if (total > 0) {
      rows.push({ supplierId: supplier.id, supplierName: supplier.name, current, days30, days60, days90Plus, total });
    }
  }

  return rows.sort((a, b) => b.total - a.total);
}

// Real feature 2026-07-25 — Supplier Statement Reconciliation, the
// real prerequisite: a real, internal outstanding balance for one
// specific supplier, to compare against a real, claimed statement
// balance. Reuses getAgedCreditorsReport's own, already-proven output
// rather than duplicating its FIFO logic — the exact same real fact,
// just for one supplier instead of all of them.
export async function getOutstandingBalanceForSupplier(env: Env, supplierId: number): Promise<number> {
  const rows = await getAgedCreditorsReport(env);
  const row = rows.find((r) => r.supplierId === supplierId);
  return row?.total ?? 0;
}

export async function getAgedCreditorsSummary(env: Env): Promise<string[]> {
  const rows = await getAgedCreditorsReport(env);
  if (rows.length === 0) return ["No outstanding creditors on file."];

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
    `Aged creditors: current R${totals.current}, 30-60 days R${totals.days30}, ` +
    `60-90 days R${totals.days60}, 90+ days R${totals.days90Plus}. ` +
    `Payments are allocated oldest-expense-first (FIFO), since payments aren't linked to a specific expense.`;

  const perSupplier = rows.map(
    (r) =>
      `${r.supplierName}: R${r.total} total outstanding (current R${r.current}, 30-60d R${r.days30}, 60-90d R${r.days60}, 90+d R${r.days90Plus}).`
  );

  return [summary, ...perSupplier];
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

// Real feature 2026-07-22 — Layer 2 (Project), cross-capture
// attachment. The real, simple answer to "what makes a project open,"
// following Pierre's own bureaucracy correction: paid in full, no
// open complaint, is what actually constitutes completion for most
// real jobs — not a formal certificate. A project is open if it has
// no real invoice yet at all, or has one that isn't yet fully covered
// by the customer's real payments. Reuses the exact same FIFO
// allocation logic already proven for Aged Debtors (oldest invoice
// paid first — the standard, defensible convention whenever payments
// aren't explicitly tied to a specific invoice), applied across the
// customer's real invoices to determine which ones remain genuinely
// unpaid, then checked per-project.
export async function getOpenProjectsForCustomer(
  env: Env,
  customerId: number
): Promise<Array<{ id: number; description: string | null }>> {
  const { results: projects } = await env.OFFICE_DB.prepare(
    "SELECT id, description FROM projects WHERE customer_id = ? ORDER BY created_at DESC"
  )
    .bind(customerId)
    .all<{ id: number; description: string | null }>();

  if (!projects || projects.length === 0) return [];

  const { results: invoices } = await env.OFFICE_DB.prepare(
    `SELECT i.amount, i.created_at, js.project_id
     FROM invoices i
     LEFT JOIN job_scopes js ON js.id = i.job_scope_id
     WHERE i.customer_id = ?
     ORDER BY i.created_at ASC`
  )
    .bind(customerId)
    .all<{ amount: number; created_at: string; project_id: number | null }>();

  const paidRow = await env.OFFICE_DB.prepare("SELECT COALESCE(SUM(amount), 0) as total FROM payments WHERE customer_id = ?")
    .bind(customerId)
    .first<{ total: number }>();

  let remainingPayment = paidRow?.total ?? 0;
  const unpaidProjectIds = new Set<number>();
  const projectIdsWithAnyInvoice = new Set<number>();

  for (const inv of invoices ?? []) {
    if (inv.project_id != null) projectIdsWithAnyInvoice.add(inv.project_id);
    let owed = inv.amount;
    if (remainingPayment > 0) {
      const applied = Math.min(remainingPayment, owed);
      owed -= applied;
      remainingPayment -= applied;
    }
    if (owed > 0 && inv.project_id != null) {
      unpaidProjectIds.add(inv.project_id);
    }
  }

  return projects.filter(
    (p) => !projectIdsWithAnyInvoice.has(p.id) || unpaidProjectIds.has(p.id)
  );
}

// Real fix 2026-07-25, found live: cross-capture attachment used to
// live inside recordWorkObservation, which only ever sees one segment
// of a message at a time — it genuinely couldn't tell "this job scope
// is standalone" apart from "this is the first segment of a
// multi-segment message whose real sibling hasn't been created yet."
// A real, live test proved this wrong: two genuinely separate jobs
// silently merged into one, because the first segment found exactly
// one open project before its own sibling ever existed to correct it.
// This now runs as its own, separate step — called only after every
// segment of the whole message has been processed and same-breath
// assembly has already had its full, complete chance to group
// whatever it's going to group. Only ever called for a job scope that
// is still genuinely undecided (project_id null) at that point.
export async function resolveCrossCaptureAttachment(
  env: Env,
  jobScopeId: number,
  customerId: number
): Promise<{ pendingProjectChoice: { pendingActionId: number; candidates: string[] } | null }> {
  const openProjects = await getOpenProjectsForCustomer(env, customerId);
  if (openProjects.length === 1) {
    await env.OFFICE_DB.prepare("UPDATE job_scopes SET project_id = ? WHERE id = ?")
      .bind(openProjects[0].id, jobScopeId)
      .run();
    return { pendingProjectChoice: null };
  }
  if (openProjects.length >= 2) {
    const held = await holdForConfirmation(
      env,
      "project_ambiguity",
      {
        jobScopeId,
        candidates: openProjects.map((p) => ({ id: p.id, description: p.description })),
      },
      `resolving project attachment for job scope #${jobScopeId}`
    );
    return {
      pendingProjectChoice: {
        pendingActionId: held.id,
        candidates: openProjects.map((p) => p.description ?? "untitled"),
      },
    };
  }
  // Zero open projects — stays standalone, honestly, since there is
  // genuinely nothing to attach to yet.
  return { pendingProjectChoice: null };
}

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

// Real feature 2026-07-22 — Layer 2 (Project), the actual point of
// building same-breath assembly and job_scope_id linking earlier
// tonight: a customer's real, grouped project, with its real, computed
// total quoted and invoiced value, surfaced in conversation rather
// than only living in a debug route. Every figure summed directly
// from real, stored quotations and invoices via the real
// job_scope_id -> project_id join — never estimated, never asked of
// the model.
export async function getCustomerProjectSummary(env: Env, customerId: number): Promise<string[]> {
  const { results: projects } = await env.OFFICE_DB.prepare(
    "SELECT id, description FROM projects WHERE customer_id = ? ORDER BY created_at DESC"
  )
    .bind(customerId)
    .all<{ id: number; description: string | null }>();

  if (!projects || projects.length === 0) return [];

  // Real feature 2026-07-24 — job completion, the simple, honest
  // default per the bureaucracy correction pinned earlier: paid in
  // full, no open complaint. Complaint-tracking doesn't exist yet
  // (snags remain a real, pinned, unbuilt design), so this covers the
  // financial half only for now — reuses the exact same, already-
  // proven FIFO check from getOpenProjectsForCustomer, never a
  // separate, parallel computation of the same real fact.
  const openProjects = await getOpenProjectsForCustomer(env, customerId);
  const openProjectIds = new Set(openProjects.map((p) => p.id));

  const facts: string[] = [];
  for (const project of projects) {
    const status = openProjectIds.has(project.id) ? "open" : "closed (paid in full)";
    // Real feature 2026-07-24 — the real, missing connection Pierre
    // pointed out directly: scheduled_date has always been captured
    // correctly on every job scope (verified live tonight), but
    // nothing in Layer 2 ever surfaced it. Each phase now shows its
    // real scheduled date when one exists, closing the gap between
    // "captured" and "actually useful."
    const { results: jobScopes } = await env.OFFICE_DB.prepare(
      "SELECT description, scheduled_date FROM job_scopes WHERE project_id = ?"
    )
      .bind(project.id)
      .all<{ description: string; scheduled_date: string | null }>();
    const totalQuoted = await env.OFFICE_DB.prepare(
      `SELECT COALESCE(SUM(q.amount), 0) as total FROM quotations q
       JOIN job_scopes js ON js.id = q.job_scope_id
       WHERE js.project_id = ?`
    )
      .bind(project.id)
      .first<{ total: number }>();
    const totalInvoiced = await env.OFFICE_DB.prepare(
      `SELECT COALESCE(SUM(i.amount), 0) as total FROM invoices i
       JOIN job_scopes js ON js.id = i.job_scope_id
       WHERE js.project_id = ?`
    )
      .bind(project.id)
      .first<{ total: number }>();
    const phases = (jobScopes ?? [])
      .map((js) => (js.scheduled_date ? `${js.description} (scheduled ${js.scheduled_date})` : js.description))
      .join(", ");
    facts.push(
      `Project "${project.description ?? "untitled"}" — status: ${status}. Phases: ${phases || "none recorded"}. Total quoted so far: R${totalQuoted?.total ?? 0}. Total invoiced so far: R${totalInvoiced?.total ?? 0}.`
    );
  }
  return facts;
}

export interface StatementLine {
  date: string;
  type: "invoice" | "payment";
  description: string;
  amount: number;
  runningBalance: number;
  // Real, small addition - the invoice's own ID was already being
  // fetched below, just never preserved separately from the
  // description text it got embedded into. Carries through what
  // was already available, no new query.
  invoiceId?: number;
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

  type RawEntry = { date: string; type: "invoice" | "payment"; description: string; amount: number; invoiceId?: number };
  const entries: RawEntry[] = [
    ...invoiceRows.map((r) => ({
      date: r.created_at,
      type: "invoice" as const,
      description: `Invoice #${r.id} — ${r.description}`,
      amount: r.amount,
      invoiceId: r.id,
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
  amount: number,
  // Real, new, per direct instruction — stage 2. Passed in from
  // index.ts rather than imported, deliberately: signDocumentPath
  // lives in index.ts, which already imports heavily from this file,
  // so importing back the other way would be a real circular
  // dependency. A customer-facing link needs a long expiry (a
  // customer may reasonably open theirs weeks later) — different from
  // the short one the app's own interactive taps use via
  // /documents/sign, so this is never routed through that endpoint.
  signPath: (path: string) => Promise<string>
): Promise<{ pdfUrl: string; shareMessage: string | null }> {
  const documentPath = `/${kind}s/${documentId}/pdf`;
  const pdfUrl = `${origin}${documentPath}?sig=${await signPath(documentPath)}`;
  const shareMessage = customerName ? await generateShareMessage(env, kind, customerName, amount, pdfUrl) : null;
  const label = customerName ? `${kind} for ${customerName} (${formatRand(amount)})` : `${kind} (${formatRand(amount)})`;
  await setSelection(env, kind, documentId, label);
  return { pdfUrl, shareMessage };
}

// Real, shared helper, per direct instruction after a real, confirmed
// gap: the logo was uploaded and stored correctly, and served back
// correctly, but no document generator ever actually drew it onto
// anything — the "ready to appear on generated PDFs" claim in
// FEATURES.md was simply wrong, found by testing the claim directly
// rather than trusting the write-up. Built once here and called from
// every real document generator, not duplicated four times.
//
// Returns whether a logo was actually drawn, per direct instruction:
// the business name text is genuinely redundant once a real logo
// exists (the logo already carries the business's own name as part
// of its own design), so every real caller uses this to decide
// whether to skip drawing that separate line and reclaim its real
// vertical space for a larger logo instead — while still falling
// back to the plain name text whenever no logo is on file, so a
// business with no logo yet never loses its own name off a document.
// Deliberately silent on any failure — a missing or malformed logo
// must never block a real, needed document from generating.
async function drawLogoIfPresent(env: Env, pdfDoc: PDFDocument, page: PDFPage, y: number): Promise<{ y: number; drew: boolean }> {
  try {
    const profile = await env.OFFICE_DB.prepare("SELECT logo_r2_key FROM business_profile WHERE id = 1").first<{
      logo_r2_key: string | null;
    }>();
    if (!profile?.logo_r2_key) return { y, drew: false };

    const object = await env.OFFICE_VAULT.get(profile.logo_r2_key);
    if (!object) return { y, drew: false };

    const bytes = await object.arrayBuffer();
    const contentType = object.httpMetadata?.contentType ?? "image/png";
    const image = contentType.includes("png") ? await pdfDoc.embedPng(bytes) : await pdfDoc.embedJpg(bytes);

    // Real, deliberate scaling — never distort the real logo's aspect
    // ratio, only ever shrink to fit within the real space available.
    // Enlarged a third time per direct instruction, with a real photo
    // of the actual generated document circled to show the intended
    // size. Both bounds raised substantially — real business logos
    // are often wide, short lockups (mark + name + address/phone in
    // one horizontal band), so width was very likely the binding
    // constraint capping the rendered size well under the real height
    // room available, not height itself.
    const maxWidth = 300;
    const maxHeight = 85;
    const scale = Math.min(maxWidth / image.width, maxHeight / image.height, 1);
    const width = image.width * scale;
    const height = image.height * scale;
    // Real, corrected position, per direct instruction after a real,
    // confirmed bug found on a real generated document: top-left, not
    // top-right (every one of these documents already puts the
    // *recipient's* details there). `top` sits close to the true page
    // edge (841.89), leaving a small real margin, so a taller logo has
    // real room to grow into rather than being capped at the old
    // text's own height.
    const top = 836;
    const bottom = top - height;
    page.drawImage(image, { x: 50, y: bottom, width, height });
    // Real gap before whatever line comes next, same role `y -= 18`
    // played for the text this replaces.
    return { y: bottom - 10, drew: true };
  } catch {
    return { y, drew: false };
  }
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

  const logoResult = await drawLogoIfPresent(env, pdfDoc, page, y);
  y = logoResult.y;
  if (!logoResult.drew) {
    page.drawText(business?.name ?? "[Business name not set]", { x: left, y, size: 14, font: bold });
    y -= 18;
  }
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

  const drawHeader = async () => {
    const logoResult = await drawLogoIfPresent(env, pdfDoc, page, y);
    y = logoResult.y;
    if (!logoResult.drew) {
      page.drawText(business?.name ?? "[Business name not set]", { x: left, y, size: 14, font: bold });
      y -= 18;
    }
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

  await drawHeader();

  if (lines.length === 0) {
    page.drawText("No transactions on file for this customer.", { x: left, y, size: 10, font, color: grey });
  }

  for (const line of lines) {
    // Basic pagination — a real customer with many transactions
    // shouldn't run off the bottom of one page.
    if (y < 80) {
      page = pdfDoc.addPage([pageWidth, pageHeight]);
      y = 792;
      await drawHeader();
    }
    const dateOnly = line.date.slice(0, 10);
    const signedAmount = line.type === "invoice" ? line.amount : -line.amount;
    page.drawText(dateOnly, { x: left, y, size: 9, font });
    // Real, deep link to the specific invoice's own PDF - confirmed
    // working via direct, independent testing (generated, re-parsed,
    // and rendered with a completely separate PDF engine) before
    // this was added to live code. Font is Helvetica specifically so
    // widthOfTextAtSize below matches what's actually drawn.
    if (line.invoiceId != null) {
      page.drawText(line.description, { x: 130, y, size: 9, font, maxWidth: 280, color: rgb(0.15, 0.25, 0.75) });
      const textWidth = Math.min(font.widthOfTextAtSize(line.description, 9), 280);
      const context = pdfDoc.context;
      const actionDict = context.obj({
        Type: "Action",
        S: "URI",
        URI: PDFString.of(`https://office.websitehub.co.za/invoices/${line.invoiceId}/pdf`),
      });
      const linkAnnotDict = context.obj({
        Type: "Annot",
        Subtype: "Link",
        Rect: [130, y - 3, 130 + textWidth, y + 10],
        Border: [0, 0, 0],
        A: actionDict,
      });
      page.node.addAnnot(context.register(linkAnnotDict));
    } else {
      page.drawText(line.description, { x: 130, y, size: 9, font, maxWidth: 280 });
    }
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

  const drawHeader = async () => {
    const logoResult = await drawLogoIfPresent(env, pdfDoc, page, y);
    y = logoResult.y;
    if (!logoResult.drew) {
      page.drawText(business?.name ?? "[Business name not set]", { x: left, y, size: 14, font: bold });
      y -= 18;
    }
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

  await drawHeader();

  if (rows.length === 0) {
    page.drawText("No outstanding debtors on file.", { x: left, y, size: 10, font, color: grey });
  }

  const totals = { current: 0, days30: 0, days60: 0, days90Plus: 0, total: 0 };

  for (const row of rows) {
    if (y < 80) {
      page = pdfDoc.addPage([pageWidth, pageHeight]);
      y = 792;
      await drawHeader();
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

// Real, new function, per direct instruction, part of the real
// discoverability-plus-audit pass: getAgedCreditorsReport has real,
// proven data (including a real fix for negative-expense credits) but
// no PDF generator at all, despite generateAgedDebtorsPdf existing for
// the opposite direction of money since 2026-07-12. A faithful mirror
// of that function — same real visual family, same FIFO convention,
// same page layout — for suppliers instead of customers.
export async function generateAgedCreditorsPdf(env: Env): Promise<Uint8Array> {
  const business = await env.OFFICE_DB.prepare("SELECT name, trading_as, vat_no, address FROM business_profile WHERE id = 1").first<{
    name: string | null;
    trading_as: string | null;
    vat_no: string | null;
    address: string | null;
  }>();

  const rows = await getAgedCreditorsReport(env);

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

  const drawHeader = async () => {
    const logoResult = await drawLogoIfPresent(env, pdfDoc, page, y);
    y = logoResult.y;
    if (!logoResult.drew) {
      page.drawText(business?.name ?? "[Business name not set]", { x: left, y, size: 14, font: bold });
      y -= 18;
    }
    if (business?.trading_as) {
      page.drawText(`T/A ${business.trading_as}`, { x: left, y, size: 10, font });
      y -= 14;
    }
    y -= 16;
    page.drawText("AGED CREDITORS ANALYSIS", { x: left, y, size: 16, font: bold });
    y -= 16;
    page.drawText(
      "Payments are allocated oldest-expense-first (FIFO) — payments aren't linked to a specific expense in this system.",
      { x: left, y, size: 8, font, color: grey, maxWidth: 495 }
    );
    y -= 26;

    page.drawText("SUPPLIER", { x: left, y, size: 9, font: bold, color: grey });
    page.drawText("CURRENT", { x: 230, y, size: 9, font: bold, color: grey });
    page.drawText("30-60", { x: 300, y, size: 9, font: bold, color: grey });
    page.drawText("60-90", { x: 360, y, size: 9, font: bold, color: grey });
    page.drawText("90+", { x: 420, y, size: 9, font: bold, color: grey });
    page.drawText("TOTAL", { x: 480, y, size: 9, font: bold, color: grey });
    y -= 8;
    page.drawLine({ start: { x: left, y }, end: { x: 545, y }, thickness: 1, color: grey });
    y -= 18;
  };

  await drawHeader();

  if (rows.length === 0) {
    page.drawText("No outstanding creditors on file.", { x: left, y, size: 10, font, color: grey });
  }

  const totals = { current: 0, days30: 0, days60: 0, days90Plus: 0, total: 0 };

  for (const row of rows) {
    if (y < 80) {
      page = pdfDoc.addPage([pageWidth, pageHeight]);
      y = 792;
      await drawHeader();
    }
    page.drawText(row.supplierName, { x: left, y, size: 9, font, maxWidth: 175 });
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

  const logoResult = await drawLogoIfPresent(env, pdfDoc, page, y);
  y = logoResult.y;
  if (!logoResult.drew) {
    page.drawText(business?.name ?? "[Business name not set]", { x: left, y, size: 14, font: bold });
    y -= 18;
  }
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
