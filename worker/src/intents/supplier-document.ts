// The supplier-document decision, shared by POST /files/document and POST /files/photo.
//
// Rewrite Phase 3, step 1 (2026-10-04). This was 199 lines that existed TWICE in index.ts, once in each upload handler, identical except for one word:
// whether a saved supplier statement is recorded as coming from a "document" or a "photo" (verified byte for byte before it was moved). It is moved
// here unchanged, and that one word is now the `source` parameter, so the two handlers can no longer drift apart. The body is the original code,
// not a rewrite; every recorded case for both handlers must pass exactly as before.
//
// What it does, in order: refuses by role; reads who issued a document that names no supplier (inferDocumentSupplier); then, for a known supplier,
// compares a statement with the books, holds a priced supplier invoice for confirmation, or reconciles a delivery note against open orders.
import type { Env } from "../types";
import { extractDocumentIdentity, extractGoodsReceived, extractSupplierInvoice, extractSupplierStatement } from "../ai";
import { intentCreationRefusal, resolveCapabilities } from "../auth";
import { DOCUMENT_KIND_LABEL, deliveryHadExceptions, deliveryHeldMessage, deliveryRecordedMessage, inferDocumentSupplier, planDelivery } from "../documents";
import { allocateInvoiceLines, candidateOrderLines, checkDeliveryUnits, checkInvoiceUnits, classifyGoodsReceivedLines, conversionNote, deliveryUnitQuestion, duplicateInvoiceMessage, findDuplicateSupplierInvoice, findLatestOpenPurchaseOrder, getInvoiceMatchLines, getOutstandingBalanceForSupplier, getOutstandingOrderLines, holdForConfirmation, invoiceCandidatesForReader, invoiceOrdersNote, proposeStockAdditions, recordDelivery, recordSupplierStatement, statementDifferenceNote } from "../finance";

export interface SupplierDocumentDecision {
  uploadRefusal: string | null;
  uploadMessage: string | null;
  uploadHeldActionId: number | null;
  inferredFromDocument: boolean;
  documentKindLabel: string;
  documentKind: "delivery_note" | "supplier_invoice" | "supplier_statement" | "other";
  supplierInvoiceAction: { pendingActionId: number; supplierName: string } | null;
  goodsReceivedAction: { grnId: number; supplierName: string } | null;
  supplierStatementAction: { supplierName: string; claimedBalance: number; realBalance: number; difference: number } | null;
  subjectCharacterId: number | null;
  subjectHint: string | null;
  rawText: string;
  captionIntent: string | null;
}

export async function decideSupplierDocument(
  request: Request,
  env: Env,
  input: {
    subjectCharacterId: number | null;
    subjectCustomerId: number | null;
    subjectHint: string | null;
    description: string;
    rawText: string;
    captionIntent: string | null;
    captionRefusal: string | null;
  },
  source: "document" | "photo"
): Promise<SupplierDocumentDecision> {
  let { subjectCharacterId, subjectHint, rawText, captionIntent } = input;
  const { subjectCustomerId, description, captionRefusal } = input;
  // Decision recorded 2026-10-02 (Pierre): money and stock are gated at
  // creation, here as well as for dictation, from the same INTENT_RULES
  // table. Uploads stay open to every member for storing the file and
  // the capture; what a role may NOT trigger is: a held supplier invoice
  // (money), a supplier statement reconciliation (a money read that
  // returns the real balance owed), or a recorded goods-received note
  // unless they hold can_manage_invoices or can_know_materials (stock;
  // installers do). A refused upload still stores the file, and the
  // response carries `refusal` so a client can say why nothing happened.
  const { capabilities: uploadCapabilities } = await resolveCapabilities(request, env);
  const statementRefusal = intentCreationRefusal("supplier_statement", uploadCapabilities);
  const supplierInvoiceRefusal = intentCreationRefusal("supplier_invoice", uploadCapabilities);
  const goodsReceivedRefusal = intentCreationRefusal("goods_received", uploadCapabilities);
  let uploadRefusal: string | null = captionRefusal;
  let uploadMessage: string | null = null;
  let uploadHeldActionId: number | null = null;

  // Document-first identification, per Pierre 2026-10-03. A delivery note
  // already says it is one and who issued it, so a caption is no longer
  // needed to understand a supplier document (the app could not send one
  // at all). This replaces the old rule of never reading a subject from
  // the file, which was right for site photos and wrong for business
  // documents. What is kept of that rule: a file with a stated subject
  // (a caption that resolved a customer or supplier) is never second-
  // guessed; anything that is not clearly a supplier document does
  // nothing, exactly as before; the issuer is matched only against
  // suppliers that ALREADY EXIST and never creates one; and because the
  // supplier here was READ, not stated, a delivery note is held for
  // confirmation instead of being recorded directly.
  let inferredFromDocument = false;
  let documentKindLabel = "this document";
  let documentKind: "delivery_note" | "supplier_invoice" | "supplier_statement" | "other" = "other";
  if (!subjectCharacterId && !subjectCustomerId) {
    const inferred = await inferDocumentSupplier(env, description);
    if (inferred.kind !== "other") {
      documentKindLabel = DOCUMENT_KIND_LABEL[inferred.kind];
      documentKind = inferred.kind;
      if (!inferred.issuer) {
        uploadMessage = `This looks like ${documentKindLabel}, but I couldn't tell who issued it, so I've only stored it.`;
      } else if (inferred.match?.kind === "one") {
        subjectCharacterId = inferred.match.supplier.id;
        subjectHint = inferred.match.supplier.name;
        inferredFromDocument = true;
        if (inferred.kind === "supplier_statement") captionIntent = "supplier_statement";
        rawText = `[Read from the document, not stated by anyone: ${documentKindLabel} issued by "${inferred.issuer}", matched to supplier ${inferred.match.supplier.name}]\n\n${rawText}`;
      } else if (inferred.match?.kind === "many") {
        uploadMessage = `I read ${documentKindLabel} from "${inferred.issuer}", which could be ${inferred.match.suppliers.map((sp) => sp.name).join(" or ")}, so nothing was recorded.`;
      } else {
        uploadMessage = `I read ${documentKindLabel} from "${inferred.issuer}", but I don't have them as a supplier, so nothing was recorded.`;
      }
    }
  }
  let supplierInvoiceAction: { pendingActionId: number; supplierName: string } | null = null;
  let goodsReceivedAction: { grnId: number; supplierName: string } | null = null;
  let supplierStatementAction: { supplierName: string; claimedBalance: number; realBalance: number; difference: number } | null = null;
  // Receives a delivery note against an order, or against no order at all.
  // Decided 2026-10-03 (Pierre): items that were never ordered are RECEIVED
  // and reported as delivery exceptions; they are not refused. What is held
  // vs recorded, and what is told back, is decided by the pure planDelivery
  // (tested without a database); this only carries the plan out.
  const reconcileDelivery = async (supplierId: number) => {
    // Decided 2026-10-03 (Pierre): a delivery is matched against ALL of the supplier's orders
    // that still have items outstanding, oldest first, not just the most recent order; and what a
    // line expects is what is still outstanding, so a delivery that arrives in two parts is not
    // flagged twice. A shortage stays on the exception report until it is resolved.
    const outstanding = await getOutstandingOrderLines(env, supplierId);
    const candidates = candidateOrderLines(outstanding);
    const grnExtraction = await extractGoodsReceived(env, description, candidates);
    // A unit that differs from the order's is converted when a conversion is known; when it is not, nothing is held or recorded
    // and the question is asked (decided by Pierre 2026-10-04). Identical in the document and photo handlers.
    const unitCheck = await checkDeliveryUnits(env, outstanding, grnExtraction.line_items);
    if (unitCheck.unconverted.length > 0) {
      uploadMessage = deliveryUnitQuestion(subjectHint ?? "the supplier", unitCheck.unconverted);
      return;
    }
    const classified = classifyGoodsReceivedLines(unitCheck.lines, candidates);
    const plan = planDelivery(classified, { mustHold: inferredFromDocument, refused: Boolean(goodsReceivedRefusal) });
    const supplierLabel = subjectHint ?? "the supplier";
    if (plan.action === "refuse") {
      uploadRefusal = goodsReceivedRefusal;
    } else if (plan.action === "hold") {
      // The supplier was read from the document, not stated, so this is held
      // for one-tap confirmation rather than written directly.
      const heldGrn = await holdForConfirmation(
        env,
        "goods_received",
        {
          purchaseOrderId: outstanding.length > 0 ? outstanding[outstanding.length - 1].poId : 0,
          supplierId,
          supplierName: subjectHint,
          allocate: true,
          lineItems: plan.lines,
        },
        rawText
      );
      uploadHeldActionId = heldGrn.id;
      uploadMessage = deliveryHeldMessage(plan, supplierLabel, inferredFromDocument, heldGrn.id, outstanding.length > 0) + conversionNote(unitCheck.converted);
    } else if (plan.action === "record") {
      const recorded = await recordDelivery(env, supplierId, rawText, plan.lines);
      goodsReceivedAction = { grnId: recorded.grnId, supplierName: supplierLabel };
      // Decided 2026-10-03 (Pierre): ask whether items that are not stock should be added.
      let stockAsk: { id: number; message: string } | null = null;
      try {
        stockAsk = await proposeStockAdditions(env, recorded.notInStock, subjectHint);
      } catch {
        // The delivery is already recorded; a failed question is not a failed delivery.
      }
      if (stockAsk) {
        uploadHeldActionId = stockAsk.id;
        uploadMessage = `${deliveryRecordedMessage(recorded)}${conversionNote(unitCheck.converted)} ${stockAsk.message}`;
      } else if (deliveryHadExceptions(recorded) || unitCheck.converted.length > 0) {
        uploadMessage = `${deliveryRecordedMessage(recorded)}${conversionNote(unitCheck.converted)}`;
      }
    } else {
      uploadMessage = `I read ${documentKindLabel} from ${supplierLabel}, but couldn't make out any items on it, so nothing was recorded.`;
    }
  };
  if (subjectCharacterId && captionIntent === "supplier_statement" && statementRefusal) {
    uploadRefusal = statementRefusal;
  } else if (subjectCharacterId && captionIntent === "supplier_statement") {
    // Real feature 2026-07-25 — Supplier Statement Reconciliation,
    // the real, buildable version of the original ERP research
    // example. A statement covers the whole real account, not one
    // delivery — genuinely no single PO to check against, unlike
    // supplier_invoice and GRN above. Compares the real, claimed
    // closing balance directly against the real, internal
    // outstanding balance already computed for Aged Creditors.
    const stmtExtraction = await extractSupplierStatement(env, description);
    if (stmtExtraction.claimed_closing_balance != null) {
      const realBalance = await getOutstandingBalanceForSupplier(env, subjectCharacterId);
      supplierStatementAction = {
        supplierName: subjectHint ?? "supplier",
        claimedBalance: stmtExtraction.claimed_closing_balance,
        realBalance,
        difference: Math.round((stmtExtraction.claimed_closing_balance - realBalance) * 100) / 100,
      };
      {
        const savedStatement = await recordSupplierStatement(env, subjectCharacterId, stmtExtraction.claimed_closing_balance, realBalance, source, description, null);
        uploadMessage = `Statement from ${subjectHint ?? "the supplier"}${inferredFromDocument ? " (read from the document)" : ""}: they claim R${stmtExtraction.claimed_closing_balance}, our records show R${realBalance}.${statementDifferenceNote(savedStatement.difference)}`;
      }
    } else {
      uploadMessage = `I couldn't find a closing balance on this statement from ${subjectHint ?? "the supplier"}, so nothing was compared.`;
    }
  } else if (subjectCharacterId) {
    const openPo = await findLatestOpenPurchaseOrder(env, subjectCharacterId);
    if (openPo) {
      // Matched across all the supplier's open orders, oldest first (decided by Pierre 2026-10-04). Identical in the document and
      // photo handlers.
      const invoicePool = await getInvoiceMatchLines(env, subjectCharacterId, openPo.id);
      const siExtraction = await extractSupplierInvoice(env, description, invoiceCandidatesForReader(invoicePool));
      const hasRealPricing = siExtraction.line_items.some((li) => li.unit_price_billed != null);
      const duplicateInvoice =
        siExtraction.line_items.length > 0 && hasRealPricing && siExtraction.supplier_reference
          ? await findDuplicateSupplierInvoice(env, subjectCharacterId, siExtraction.supplier_reference)
          : null;
      const invoiceUnits = siExtraction.line_items.length > 0 && hasRealPricing ? await checkInvoiceUnits(env, invoicePool, siExtraction.line_items) : null;
      if (siExtraction.line_items.length > 0 && hasRealPricing && supplierInvoiceRefusal) {
        uploadRefusal = supplierInvoiceRefusal;
      } else if (duplicateInvoice) {
        // The same invoice (same supplier, same reference) is not recorded or held a second time (decided by Pierre 2026-10-04).
        uploadMessage = duplicateInvoiceMessage(subjectHint ?? "the supplier", siExtraction.supplier_reference!, duplicateInvoice);
      } else if (invoiceUnits && invoiceUnits.unconverted.length > 0) {
        uploadMessage = deliveryUnitQuestion(subjectHint ?? "the supplier", invoiceUnits.unconverted, "send the invoice again", "invoice");
      } else if (siExtraction.line_items.length > 0 && hasRealPricing) {
        const allocatedInvoice = allocateInvoiceLines(invoiceUnits ? invoiceUnits.lines : siExtraction.line_items, invoicePool);
        const held = await holdForConfirmation(
          env,
          "supplier_invoice",
          {
            purchaseOrderId: allocatedInvoice.primaryPoId ?? openPo.id,
            supplierId: subjectCharacterId,
            supplierName: subjectHint,
            supplierReference: siExtraction.supplier_reference,
            lineItems: allocatedInvoice.lines,
          },
          rawText
        );
        supplierInvoiceAction = { pendingActionId: held.id, supplierName: subjectHint ?? "supplier" };
        uploadHeldActionId = held.id;
        uploadMessage = `Supplier invoice noted from ${subjectHint ?? "the supplier"}${inferredFromDocument ? " (read from the document)" : ""} — needs your confirmation (action #${held.id}) before it's recorded.${invoiceOrdersNote(allocatedInvoice.orderIds)}${conversionNote(invoiceUnits ? invoiceUnits.converted : [])}`;
      } else {
        await reconcileDelivery(subjectCharacterId);
      }
    } else {
      // No open order. A delivery note for items that were never ordered is
      // still received (decided 2026-10-03) and reported as an exception.
      // Anything else, an invoice or a statement, still needs an order to
      // be checked against.
      const isDeliveryNote = inferredFromDocument
        ? documentKind === "delivery_note"
        : (await extractDocumentIdentity(env, description)).document_type === "delivery_note";
      if (isDeliveryNote) {
        await reconcileDelivery(subjectCharacterId);
      } else {
        uploadMessage = `I read ${documentKindLabel} from ${subjectHint ?? "the supplier"}, but there's no open order for them, so nothing was recorded.`;
      }
    }
  }
  return {
    uploadRefusal,
    uploadMessage,
    uploadHeldActionId,
    inferredFromDocument,
    documentKindLabel,
    documentKind,
    supplierInvoiceAction,
    goodsReceivedAction,
    supplierStatementAction,
    subjectCharacterId,
    subjectHint,
    rawText,
    captionIntent,
  };
}
