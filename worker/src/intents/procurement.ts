// Procurement by dictation: place a purchase order, record goods received against open orders, hold a supplier invoice for confirmation, and record
// what a supplier said about a delivery discrepancy (a credit, an acceptance, a reason).
//
// Rewrite Phase 3, step 6 (2026-10-04). The fourth intent group moved out of processOneExtraction, unchanged and not rewritten: the same branches, the
// same messages, in the same order. Every variable used here was private to these pieces (checked before the move: 24 function-level variables, none
// referenced anywhere else in the function). This group HOLDS actions, so, unlike the earlier moves, the handler returns the held action's number and
// type even when none of its reply branches matched, and the caller uses the reply only when there is one; otherwise a held action could be lost.
import type { Env } from "../types";
import type { Extraction } from "../types";
import { extractGoodsReceived, extractPurchaseOrder, extractSupplierInvoice, extractVarianceDisposition } from "../ai";
import { deliveryHeldMessage, planDelivery } from "../documents";
import { allocateInvoiceLines, candidateOrderLines, checkDeliveryUnits, checkInvoiceUnits, classifyGoodsReceivedLines, conversionNote, deliveryUnitQuestion, duplicateInvoiceMessage, findDuplicateSupplierInvoice, findLatestOpenPurchaseOrder, getInvoiceMatchLines, getOpenDiscrepanciesForSupplier, getOutstandingOrderLines, holdForConfirmation, invoiceCandidatesForReader, invoiceOrdersNote, linkPurchaseOrderToCustomer, recordPurchaseOrder, recordVarianceDisposition } from "../finance";
import { findExistingCharacterByName } from "../identity";

const PROCUREMENT_INTENTS = new Set(["purchase_order", "goods_received", "supplier_invoice", "variance_disposition"]);

export interface ProcurementResult {
  message: string | null;
  pendingActionId: number | null;
  pendingActionType: string | null;
}

export async function handleProcurement(
  env: Env,
  input: {
    extraction: Extraction | null;
    transcript: string;
    character: { id: number; name: string } | null;
    customer: { id: number; name: string } | null;
    recordingUserEmail: string | null;
  }
): Promise<ProcurementResult | null> {
  const { extraction, transcript, character, customer, recordingUserEmail } = input;
  if (!extraction || !PROCUREMENT_INTENTS.has(extraction.intent ?? "")) return null;
  let pendingActionId: number | null = null;
  let pendingActionType: string | null = null;
  // Real feature 2026-07-21 — Purchase Orders, built incrementally
  // per the real, three-way design pinned in DECISIONS.md.
  // Deliberately unguarded, the same precedent already established
  // for job scopes — a real commitment, not yet a transaction.
  let purchaseOrderResult: { purchaseOrderId: number; lineItemCount: number } | null = null;
  let purchaseOrderNoSupplier = false;

  let purchaseOrderNoItems = false;
  // Found by the second real phone test 2026-10-04 ("order 10 boxes of laminate FOR zztest"): a name after "for" is who an order is for, not who it is
  // from. Orders carry no customer or job, so it cannot be kept, and it must never CREATE a customer (an order sentence is now find-only for customers).
  // When it is said instead of a supplier we ask rather than guess (an order is written straight away, so a wrong guess would be a wrong order).
  let purchaseOrderForName: string | null = null;
  let purchaseOrderSuggestedSupplier: string | null = null;
  let purchaseOrderLinkedTo: string | null = null;
  if (extraction?.intent === "purchase_order") {
    purchaseOrderForName = extraction.customer_name?.trim() || null;
    if (character) {
      const poExtraction = await extractPurchaseOrder(env, transcript);
      if (poExtraction.line_items.length === 0) {
        // Found by the characterization recordings 2026-10-03: when the model failed or found no items, an order
        // with zero lines was recorded anyway, and as the supplier's most recent order it then became what a later
        // supplier invoice is checked against, which matches nothing. Nothing usable is not an order.
        purchaseOrderNoItems = true;
      } else {
        const recorded = await recordPurchaseOrder(env, character.id, poExtraction.description, transcript, poExtraction.line_items);
        purchaseOrderResult = { purchaseOrderId: recorded.purchaseOrderId, lineItemCount: poExtraction.line_items.length };
        // Decided by Pierre 2026-10-04: "order 10 boxes of laminate for Jenny from Floornet" links the order to the customer it is FOR (found by name only: an
        // order never creates a customer), so what the supplier later invoices for it counts against that customer's job.
        if (purchaseOrderForName && customer) {
          await linkPurchaseOrderToCustomer(env, recorded.purchaseOrderId, customer.id);
          purchaseOrderLinkedTo = customer.name;
        }
      }
    } else {
      if (purchaseOrderForName) purchaseOrderSuggestedSupplier = (await findExistingCharacterByName(env, purchaseOrderForName))?.name ?? null;
      // Honest, not silent — the same discipline as every other
      // recognized-but-nothing-to-act-on case in this project.
      purchaseOrderNoSupplier = true;
    }
  }

  // Real feature 2026-07-21 — Goods Received Notes, the second stage.
  // Guard()'d, matching the original design's own distinction — real
  // stock changes hands here, unlike the PO itself.
  let goodsReceivedNoSupplier = false;
  let goodsReceivedNoItems = false;
  let goodsReceivedMessage: string | null = null;
  let goodsReceivedUnitQuestion: string | null = null;
  let goodsReceivedSupplierName: string | null = null;
  if (extraction?.intent === "goods_received") {
    if (character) {
      // Decided 2026-10-03 (Pierre): a delivery of items that were never
      // ordered is RECEIVED and reported as a delivery exception, and a delivery is
      // matched against ALL of the supplier's orders that still have items
      // outstanding (oldest first), not just the most recent one. A spoken delivery
      // is always held for confirmation.
      const outstanding = await getOutstandingOrderLines(env, character.id);
      const candidates = candidateOrderLines(outstanding);
      const grnExtraction = await extractGoodsReceived(env, transcript, candidates);
      // Decided by Pierre 2026-10-04: a delivery in a different unit from the order (boxes against square metres) is converted
      // when a conversion is known, and when it is not, NOTHING is held or recorded: the person is asked for the conversion once.
      const unitCheck = await checkDeliveryUnits(env, outstanding, grnExtraction.line_items);
      const grnPlan = planDelivery(classifyGoodsReceivedLines(unitCheck.lines, candidates), {
        mustHold: true,
        refused: false,
      });
      if (unitCheck.unconverted.length > 0) {
        goodsReceivedUnitQuestion = deliveryUnitQuestion(character.name, unitCheck.unconverted);
      } else if (grnPlan.action === "hold") {
        const held = await holdForConfirmation(
          env,
          "goods_received",
          {
            purchaseOrderId: outstanding.length > 0 ? outstanding[outstanding.length - 1].poId : 0,
            supplierId: character.id,
            supplierName: character.name,
            allocate: true,
            lineItems: grnPlan.lines,
          },
          transcript
        );
        pendingActionId = held.id;
        pendingActionType = "goods_received";
        goodsReceivedSupplierName = character.name;
        goodsReceivedMessage = deliveryHeldMessage(grnPlan, character.name, false, held.id, outstanding.length > 0) + conversionNote(unitCheck.converted);
      } else {
        goodsReceivedNoItems = true;
      }
    } else {
      goodsReceivedNoSupplier = true;
    }
  }

  // Real feature 2026-07-21 — Supplier Invoices, the third and final
  // stage. This is where real money moves, guard()'d the same as
  // every other financial write in this project.
  let supplierInvoiceNoSupplier = false;
  let supplierInvoiceNoItems = false;
  let supplierInvoiceNoOpenPo = false;
  let supplierInvoiceSupplierName: string | null = null;
  let supplierInvoiceOrderIds: number[] = [];
  let supplierInvoiceDuplicate: string | null = null;
  let supplierInvoiceUnitQuestion: string | null = null;
  let supplierInvoiceConverted: Array<{ item: string; quantity: number; from: string; to: string; result: number }> = [];
  if (extraction?.intent === "supplier_invoice") {
    if (character) {
      const openPo = await findLatestOpenPurchaseOrder(env, character.id);
      if (openPo) {
        // Decided by Pierre 2026-10-04: the invoice is matched across ALL the supplier's open orders, oldest first (it used to be the
        // latest order only), exactly as deliveries are.
        const invoicePool = await getInvoiceMatchLines(env, character.id, openPo.id);
        const siExtraction = await extractSupplierInvoice(env, transcript, invoiceCandidatesForReader(invoicePool));
        const duplicateInvoice =
          siExtraction.line_items.length > 0 && siExtraction.supplier_reference ? await findDuplicateSupplierInvoice(env, character.id, siExtraction.supplier_reference) : null;
        // Decided by Pierre 2026-10-04: a billed unit that differs from the order's (boxes against square metres) is converted, quantity AND
        // price per unit, when a conversion is known; when it is not, nothing is held and the question is asked.
        const invoiceUnits = await checkInvoiceUnits(env, invoicePool, siExtraction.line_items);
        if (siExtraction.line_items.length === 0) {
          // Found by the characterization recordings 2026-10-03: with the model down, or nothing readable, an invoice
          // with no lines was held for confirmation, which would have recorded an invoice of nothing.
          supplierInvoiceNoItems = true;
        } else if (duplicateInvoice) {
          // Decided by Pierre 2026-10-04: the same invoice (same supplier, same reference) is not recorded or held a second time.
          supplierInvoiceDuplicate = duplicateInvoiceMessage(character.name, siExtraction.supplier_reference!, duplicateInvoice);
        } else if (invoiceUnits.unconverted.length > 0) {
          supplierInvoiceUnitQuestion = deliveryUnitQuestion(character.name, invoiceUnits.unconverted, "say the invoice again", "invoice");
        } else {
        const allocatedInvoice = allocateInvoiceLines(invoiceUnits.lines, invoicePool);
        supplierInvoiceConverted = invoiceUnits.converted;
        supplierInvoiceOrderIds = allocatedInvoice.orderIds;
        const held = await holdForConfirmation(
          env,
          "supplier_invoice",
          {
            purchaseOrderId: allocatedInvoice.primaryPoId ?? openPo.id,
            supplierId: character.id,
            supplierName: character.name,
            supplierReference: siExtraction.supplier_reference,
            lineItems: allocatedInvoice.lines,
          },
          transcript
        );
        pendingActionId = held.id;
        pendingActionType = "supplier_invoice";
        supplierInvoiceSupplierName = character.name;
        }
      } else {
        supplierInvoiceNoOpenPo = true;
      }
    } else {
      supplierInvoiceNoSupplier = true;
    }
  }

  // Real feature 2026-07-24 — Variance Disposition. Raising a reason
  // stays deliberately unguarded but traceable, matching GRN's own
  // precedent — naming why a discrepancy happened is documentation,
  // not money moving. A "credit" resolution with a real, stated
  // amount is different — real money is about to move, so it holds
  // for confirmation instead, the same discipline as every other
  // financial write in this project.
  let dispositionNoSupplier = false;
  let dispositionNothingSaid = false;
  let dispositionNoOpenDiscrepancy = false;
  let dispositionResult: { dispositionId: number; description: string; reason: string | null; resolution: string | null } | null = null;
  let dispositionPendingSupplierName: string | null = null;
  if (extraction?.intent === "variance_disposition") {
    if (character) {
      const discrepancies = await getOpenDiscrepanciesForSupplier(env, character.id);
      if (discrepancies.length > 0) {
        const vdExtraction = await extractVarianceDisposition(env, transcript, discrepancies);
        const matched = vdExtraction.matched_description
          ? discrepancies.find((d) => d.description.toLowerCase() === vdExtraction.matched_description!.toLowerCase())
          : discrepancies.length === 1
          ? discrepancies[0]
          : null;
        if (matched && !vdExtraction.reason && !vdExtraction.resolution) {
          // Found by the characterization recordings 2026-10-03: with the model down, a disposition row with no
          // reason, no resolution and no credit was written for the shortage. Any disposition counts as resolved,
          // so the shortage silently left the open list and the exception report with nothing actually recorded.
          // Nothing said is not a resolution.
          dispositionNothingSaid = true;
        } else if (matched) {
          const isRealCredit = vdExtraction.resolution === "credit" && vdExtraction.credit_amount != null && vdExtraction.credit_amount > 0;
          if (isRealCredit) {
            const held = await holdForConfirmation(
              env,
              "variance_disposition",
              {
                grnLineItemId: matched.grnLineItemId,
                description: matched.description,
                reason: vdExtraction.reason,
                resolution: vdExtraction.resolution,
                creditAmount: vdExtraction.credit_amount,
              },
              transcript
            );
            pendingActionId = held.id;
            pendingActionType = "variance_disposition";
            dispositionPendingSupplierName = character.name;
          } else {
            const recordedByEmail = recordingUserEmail;
            const recorded = await recordVarianceDisposition(
              env,
              matched.grnLineItemId,
              vdExtraction.reason,
              vdExtraction.resolution,
              vdExtraction.credit_amount,
              recordedByEmail
            );
            dispositionResult = {
              dispositionId: recorded.dispositionId,
              description: matched.description,
              reason: vdExtraction.reason,
              resolution: vdExtraction.resolution,
            };
          }
        } else {
          dispositionNoOpenDiscrepancy = true;
        }
      } else {
        dispositionNoOpenDiscrepancy = true;
      }
    } else {
      dispositionNoSupplier = true;
    }
  }

  let message: string | null = null;
  if (extraction?.intent === "purchase_order" && purchaseOrderResult) {
    message = `Purchase order #${purchaseOrderResult.purchaseOrderId} recorded for ${character!.name} — ${purchaseOrderResult.lineItemCount} item(s)${purchaseOrderLinkedTo ? `, for ${purchaseOrderLinkedTo}'s job` : ""}.${purchaseOrderLinkedTo ? "" : purchaseOrderForName ? ` I heard "for ${purchaseOrderForName}", but that isn't a customer I have, so the order isn't linked to a job.` : ""}`;
  } else if (extraction?.intent === "purchase_order" && purchaseOrderNoItems) {
    message = `I heard an order for ${character!.name}, but couldn't make out any items on it, so nothing was recorded.`;
  } else if (extraction?.intent === "purchase_order" && purchaseOrderNoSupplier) {
    // Honest, not silent — the same discipline as every other
    // recognized-but-nothing-to-act-on case in this project.
    message = purchaseOrderForName
      ? purchaseOrderSuggestedSupplier
        ? `I heard an order "for ${purchaseOrderForName}", but orders are placed from a supplier. ${purchaseOrderSuggestedSupplier} is a supplier: did you mean "from ${purchaseOrderSuggestedSupplier}"? Nothing was recorded.`
        : `I heard an order "for ${purchaseOrderForName}", but orders are placed from a supplier and no supplier name came through, so nothing was recorded. Which supplier is it from?`
      : "Recognized a purchase order, but no supplier was named — try naming who it's from.";
  } else if (extraction?.intent === "goods_received" && goodsReceivedUnitQuestion) {
    message = goodsReceivedUnitQuestion;
  } else if (pendingActionId && extraction?.intent === "goods_received" && goodsReceivedSupplierName) {
    message = goodsReceivedMessage ?? `Delivery noted from ${goodsReceivedSupplierName} — needs your confirmation (action #${pendingActionId}) before it's recorded.`;
  } else if (extraction?.intent === "goods_received" && goodsReceivedNoSupplier) {
    message = "Recognized a delivery, but no supplier was named — try naming who it's from.";
  } else if (extraction?.intent === "goods_received" && goodsReceivedNoItems) {
    message = `I heard a delivery from ${character!.name}, but couldn't make out any items in it, so nothing was noted.`;
  } else if (pendingActionId && extraction?.intent === "supplier_invoice" && supplierInvoiceSupplierName) {
    message = `Supplier invoice noted from ${supplierInvoiceSupplierName} — needs your confirmation (action #${pendingActionId}) before it's recorded.${invoiceOrdersNote(supplierInvoiceOrderIds)}${conversionNote(supplierInvoiceConverted)}`;
  } else if (extraction?.intent === "supplier_invoice" && supplierInvoiceNoItems) {
    message = `I heard a supplier invoice from ${character!.name}, but couldn't make out any items on it, so nothing was noted.`;
  } else if (extraction?.intent === "supplier_invoice" && supplierInvoiceDuplicate) {
    message = supplierInvoiceDuplicate;
  } else if (extraction?.intent === "supplier_invoice" && supplierInvoiceUnitQuestion) {
    message = supplierInvoiceUnitQuestion;
  } else if (extraction?.intent === "supplier_invoice" && supplierInvoiceNoSupplier) {
    message = "Recognized a supplier invoice, but no supplier was named — try naming who it's from.";
  } else if (extraction?.intent === "supplier_invoice" && supplierInvoiceNoOpenPo) {
    message = `I don't have an open purchase order on file for ${character!.name} to bill this invoice against.`;
  } else if (pendingActionId && extraction?.intent === "variance_disposition" && dispositionPendingSupplierName) {
    message = `Credit noted for ${dispositionPendingSupplierName} — needs your confirmation (action #${pendingActionId}) before it's recorded.`;
  } else if (extraction?.intent === "variance_disposition" && dispositionResult) {
    const reasonText = dispositionResult.reason ? dispositionResult.reason.replace(/_/g, " ") : "no reason stated";
    const resolutionText = dispositionResult.resolution ? `, resolution: ${dispositionResult.resolution.replace(/_/g, " ")}` : "";
    message = `Noted for ${dispositionResult.description} — ${reasonText}${resolutionText}.`;
  } else if (extraction?.intent === "variance_disposition" && dispositionNoSupplier) {
    message = "Recognized a discrepancy discussion, but no supplier was named — try naming who it's from.";
  } else if (extraction?.intent === "variance_disposition" && dispositionNothingSaid) {
    message = `I couldn't tell what happened with that shortage on ${character!.name}'s order. Say why it happened (short delivered, damaged and so on) or whether it is a back order or a credit, and I'll note it.`;
  } else if (extraction?.intent === "variance_disposition" && dispositionNoOpenDiscrepancy) {
    message = `I don't have an open, unresolved discrepancy on file for ${character!.name} to attach this to.`;
  }
  return { message, pendingActionId, pendingActionType };
}
