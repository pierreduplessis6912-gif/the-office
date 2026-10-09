// Order management by voice: cancel an order, reopen a cancelled one, link an existing order to the customer it was for (each a HELD action that
// names the order and never guesses between several), and, recorded directly, a supplier's statement and a unit conversion.
//
// Rewrite Phase 3, step 2 (2026-10-04). The first intent group moved out of processOneExtraction. Moved unchanged, not rewritten: the same branches,
// the same messages, the same order. Two handlers because the pieces ran at two different places in that function, and the order of database writes
// must not change: handleOrderHolds ran early (the held actions), handleOrderRecords later (the two that write immediately). Each returns the
// finished reply (and, for a held action, its number and type), or null when the sentence is not one of its intents.
import type { Env } from "../types";
import type { Extraction } from "../types";
import { extractUnitConversion } from "../ai";
import { describeCancelledOrder, describeConversion, describeOpenOrder, describeOrderForLinking, forgetUnitConversions, getCancelledOrdersForSupplier, getOpenOrdersForSupplier, getOrderForLinking, getOutstandingBalanceForSupplier, getUnlinkedOrdersForSupplier, holdForConfirmation, normalizeUnit, parseOrderNumber, recordSupplierStatement, setUnitConversion, statementDifferenceNote, type CancelledOrder, type OpenOrder, type OrderForLinking, unitPlural } from "../finance";

export interface OrderHoldsResult {
  message: string;
  pendingActionId: number | null;
  pendingActionType: string | null;
}

const ORDER_HOLD_INTENTS = new Set(["cancel_order", "reopen_order", "link_order"]);

export async function handleOrderHolds(
  env: Env,
  input: {
    extraction: Extraction | null;
    transcript: string;
    character: { id: number; name: string } | null;
    customer: { id: number; name: string } | null;
  }
): Promise<OrderHoldsResult | null> {
  const { extraction, transcript, character, customer } = input;
  if (!extraction || !ORDER_HOLD_INTENTS.has(extraction.intent ?? "")) return null;
  let pendingActionId: number | null = null;
  let pendingActionType: string | null = null;
  // Cancelling an order (decided by Pierre 2026-10-04). A held action, never a direct write: cancelling is destructive, so it
  // asks first and shows which order. The supplier must already be on file (the opening step only finds, never creates, for
  // this intent). With several open orders nothing is guessed: the person names one ("cancel order 3").
  let cancelOrderHold: { id: number; summary: string; supplierName: string } | null = null;
  let cancelOrderNoSupplier = false;
  let cancelOrderUnknownSupplier: string | null = null;
  let cancelOrderNone = false;
  let cancelOrderWhich: OpenOrder[] | null = null;
  let cancelOrderNumberNotOpen: { wanted: number; open: OpenOrder[] } | null = null;
  if (extraction?.intent === "cancel_order") {
    if (!extraction.character_name) {
      cancelOrderNoSupplier = true;
    } else if (!character) {
      cancelOrderUnknownSupplier = extraction.character_name;
    } else {
      const open = await getOpenOrdersForSupplier(env, character.id);
      const wanted = parseOrderNumber(transcript);
      const target = open.length === 0 ? null : wanted !== null ? open.find((o) => o.id === wanted) ?? null : open.length === 1 ? open[0] : null;
      if (open.length === 0) {
        cancelOrderNone = true;
      } else if (target) {
        const held = await holdForConfirmation(env, "cancel_order", { purchaseOrderId: target.id, supplierId: character.id, supplierName: character.name }, transcript);
        pendingActionId = held.id;
        pendingActionType = "cancel_order";
        cancelOrderHold = { id: held.id, summary: describeOpenOrder(target), supplierName: character.name };
      } else if (wanted !== null) {
        cancelOrderNumberNotOpen = { wanted, open };
      } else {
        cancelOrderWhich = open;
      }
    }
  }

  // Reopening a cancelled order (decided by Pierre 2026-10-04): the mirror of cancelling. A held action that names the order, never guesses
  // between several (say "reopen order 3"), and needs the supplier to be on file already.
  let reopenOrderHold: { id: number; summary: string; supplierName: string } | null = null;
  let reopenOrderNoSupplier = false;
  let reopenOrderUnknownSupplier: string | null = null;
  let reopenOrderNone = false;
  let reopenOrderWhich: CancelledOrder[] | null = null;
  let reopenOrderNumberNotCancelled: { wanted: number; cancelled: CancelledOrder[] } | null = null;
  if (extraction?.intent === "reopen_order") {
    if (!extraction.character_name) {
      reopenOrderNoSupplier = true;
    } else if (!character) {
      reopenOrderUnknownSupplier = extraction.character_name;
    } else {
      const cancelled = await getCancelledOrdersForSupplier(env, character.id);
      const wanted = parseOrderNumber(transcript);
      const target = cancelled.length === 0 ? null : wanted !== null ? cancelled.find((o) => o.id === wanted) ?? null : cancelled.length === 1 ? cancelled[0] : null;
      if (cancelled.length === 0) {
        reopenOrderNone = true;
      } else if (target) {
        const held = await holdForConfirmation(env, "reopen_order", { purchaseOrderId: target.id, supplierId: character.id, supplierName: character.name }, transcript);
        pendingActionId = held.id;
        pendingActionType = "reopen_order";
        reopenOrderHold = { id: held.id, summary: describeCancelledOrder(target), supplierName: character.name };
      } else if (wanted !== null) {
        reopenOrderNumberNotCancelled = { wanted, cancelled };
      } else {
        reopenOrderWhich = cancelled;
      }
    }
  }

  // Linking an EXISTING order to the customer it was for (decided by Pierre 2026-10-04): "link order 12 to Jenny", or "that Floornet order was for
  // Jenny". A held action (it moves costs between jobs). The customer must already exist, the order is named by number or is the supplier's only
  // unlinked one, and nothing is ever guessed between several.
  let linkOrderHold: { id: number; summary: string; customerName: string; supplier: string | null; movesFrom: string | null } | null = null;
  let linkOrderNoCustomer = false;
  let linkOrderUnknownCustomer: string | null = null;
  let linkOrderNumberUnknown: number | null = null;
  let linkOrderCancelled: OrderForLinking | null = null;
  let linkOrderNone: string | null = null;
  let linkOrderWhich: OrderForLinking[] | null = null;
  let linkOrderNoOrder = false;
  if (extraction?.intent === "link_order") {
    if (!extraction.customer_name) {
      linkOrderNoCustomer = true;
    } else if (!customer) {
      linkOrderUnknownCustomer = extraction.customer_name;
    } else {
      const wanted = parseOrderNumber(transcript);
      let target: OrderForLinking | null = null;
      if (wanted !== null) {
        target = await getOrderForLinking(env, wanted);
        if (!target) linkOrderNumberUnknown = wanted;
        else if (target.cancelled) {
          linkOrderCancelled = target;
          target = null;
        }
      } else if (character) {
        const unlinked = await getUnlinkedOrdersForSupplier(env, character.id);
        if (unlinked.length === 1) target = unlinked[0];
        else if (unlinked.length === 0) linkOrderNone = character.name;
        else linkOrderWhich = unlinked;
      } else {
        linkOrderNoOrder = true;
      }
      if (target) {
        const held = await holdForConfirmation(
          env,
          "link_order",
          { purchaseOrderId: target.id, customerId: customer.id, customerName: customer.name, supplierName: target.supplier },
          transcript
        );
        pendingActionId = held.id;
        pendingActionType = "link_order";
        linkOrderHold = { id: held.id, summary: describeOrderForLinking(target), customerName: customer.name, supplier: target.supplier, movesFrom: target.linkedTo && target.linkedTo !== customer.name ? target.linkedTo : null };
      }
    }
  }

  let message: string | null = null;
  if (extraction?.intent === "link_order" && linkOrderHold) {
    message = `Link ${linkOrderHold.supplier ? `${linkOrderHold.supplier} ` : ""}order ${linkOrderHold.summary} to ${linkOrderHold.customerName}'s job? Needs your confirmation (action #${linkOrderHold.id}) before it's linked.${linkOrderHold.movesFrom ? ` It is currently linked to ${linkOrderHold.movesFrom}'s job; this will move it, and its costs, to ${linkOrderHold.customerName}.` : ""}`;
  } else if (extraction?.intent === "link_order" && linkOrderNoCustomer) {
    message = "I heard you want to link an order to a customer, but no customer name came through — which customer is it for?";
  } else if (extraction?.intent === "link_order" && linkOrderUnknownCustomer) {
    message = `I don't have ${linkOrderUnknownCustomer} as a customer, so there is nothing to link the order to.`;
  } else if (extraction?.intent === "link_order" && linkOrderNumberUnknown !== null) {
    message = `I have no order #${linkOrderNumberUnknown}.`;
  } else if (extraction?.intent === "link_order" && linkOrderCancelled) {
    message = `Order #${linkOrderCancelled.id} was cancelled, so there is nothing to link. Reopen it first if it is back on.`;
  } else if (extraction?.intent === "link_order" && linkOrderNone) {
    message = `${linkOrderNone} has no orders waiting to be linked to a customer.`;
  } else if (extraction?.intent === "link_order" && linkOrderWhich) {
    message = `${character!.name} has ${linkOrderWhich.length} orders not linked to a customer: ${linkOrderWhich.map(describeOrderForLinking).join("; ")}. Say "link order" and its number to pick one.`;
  } else if (extraction?.intent === "link_order" && linkOrderNoOrder) {
    message = "I heard you want to link an order, but not which one. Say its number (\"link order 12 to Jenny\") or the supplier (\"the Floornet order was for Jenny\").";
  } else if (extraction?.intent === "reopen_order" && reopenOrderHold) {
    message = `Reopen ${reopenOrderHold.supplierName} order ${reopenOrderHold.summary}? Needs your confirmation (action #${reopenOrderHold.id}) before it's reopened.`;
  } else if (extraction?.intent === "reopen_order" && reopenOrderNoSupplier) {
    message = "I heard you want to reopen an order, but no supplier name came through — which supplier is it with?";
  } else if (extraction?.intent === "reopen_order" && reopenOrderUnknownSupplier) {
    message = `I don't have ${reopenOrderUnknownSupplier} as a supplier, so there is no order to reopen.`;
  } else if (extraction?.intent === "reopen_order" && reopenOrderNone) {
    message = `${character!.name} has no cancelled orders to reopen.`;
  } else if (extraction?.intent === "reopen_order" && reopenOrderNumberNotCancelled) {
    message = `${character!.name} has no cancelled order #${reopenOrderNumberNotCancelled.wanted}. Cancelled orders: ${reopenOrderNumberNotCancelled.cancelled.map(describeCancelledOrder).join("; ")}.`;
  } else if (extraction?.intent === "reopen_order" && reopenOrderWhich) {
    message = `${character!.name} has ${reopenOrderWhich.length} cancelled orders: ${reopenOrderWhich.map(describeCancelledOrder).join("; ")}. Say "reopen order" and its number to pick one.`;
  } else if (extraction?.intent === "cancel_order" && cancelOrderHold) {
    message = `Cancel ${cancelOrderHold.supplierName} order ${cancelOrderHold.summary}? Needs your confirmation (action #${cancelOrderHold.id}) before it's cancelled.`;
  } else if (extraction?.intent === "cancel_order" && cancelOrderNoSupplier) {
    message = "I heard you want to cancel an order, but no supplier name came through — which supplier is it with?";
  } else if (extraction?.intent === "cancel_order" && cancelOrderUnknownSupplier) {
    message = `I don't have ${cancelOrderUnknownSupplier} as a supplier, so there is no order to cancel.`;
  } else if (extraction?.intent === "cancel_order" && cancelOrderNone) {
    message = `${character!.name} has no open orders to cancel.`;
  } else if (extraction?.intent === "cancel_order" && cancelOrderNumberNotOpen) {
    message = `${character!.name} has no open order #${cancelOrderNumberNotOpen.wanted}. Open orders: ${cancelOrderNumberNotOpen.open.map(describeOpenOrder).join("; ")}.`;
  } else if (extraction?.intent === "cancel_order" && cancelOrderWhich) {
    message = `${character!.name} has ${cancelOrderWhich.length} open orders: ${cancelOrderWhich.map(describeOpenOrder).join("; ")}. Say "cancel order" and its number to pick one.`;
  }
  if (message === null) return null;
  return { message, pendingActionId, pendingActionType };
}

const ORDER_RECORD_INTENTS = new Set(["supplier_statement", "forget_unit_conversion", "set_unit_conversion"]);

export async function handleOrderRecords(
  env: Env,
  input: {
    extraction: Extraction | null;
    transcript: string;
    character: { id: number; name: string } | null;
    recordingUserEmail: string | null;
  }
): Promise<{ message: string } | null> {
  const { extraction, transcript, character, recordingUserEmail } = input;
  if (!extraction || !ORDER_RECORD_INTENTS.has(extraction.intent ?? "")) return null;
  // Decided by Pierre 2026-10-04: "a box of laminate is 2.2 square metres". A direct write (it is a fact about a material, no money
  // moves), gated like the rest of stock, and said again to change it. The reply always says what was understood or why not.
  // Decided by Pierre 2026-10-04: a SPOKEN supplier statement ("Floornet says we owe them R12,000") used to do nothing but say "Found existing:
  // Floornet". It is now compared with the books exactly as an uploaded one is, and recorded, so it has a home. The supplier must already be
  // on file (a statement for a name nobody has heard of cannot create a supplier). A role that may not check statements is refused earlier.
  let supplierStatementReply: string | null = null;
  if (extraction?.intent === "supplier_statement") {
    if (!extraction.character_name) {
      supplierStatementReply = "I heard a supplier statement, but no supplier name came through — which supplier is it from?";
    } else if (!character) {
      supplierStatementReply = `I don't have ${extraction.character_name} as a supplier, so there is no account to compare a statement with.`;
    } else if (extraction.amount == null) {
      supplierStatementReply = `I heard a statement from ${character.name}, but no balance came through — what do they say is owed?`;
    } else {
      const booksBalance = await getOutstandingBalanceForSupplier(env, character.id);
      const savedStatement = await recordSupplierStatement(env, character.id, extraction.amount, booksBalance, "spoken", transcript, recordingUserEmail);
      supplierStatementReply = `Statement from ${character.name}: they claim R${extraction.amount}, our records show R${booksBalance}.${statementDifferenceNote(savedStatement.difference)}`;
    }
  }

  let unitConversionMessage: string | null = null;
  if (extraction?.intent === "forget_unit_conversion") {
    // Decided by Pierre 2026-10-04: "forget the laminate conversion". Exactly that item's conversion(s), never a looser match.
    const material = extraction.fact_value?.trim();
    if (!material) {
      unitConversionMessage = `Which material's conversion should I forget? Say, for example, "forget the laminate conversion".`;
    } else {
      const result = await forgetUnitConversions(env, material);
      unitConversionMessage =
        result.forgotten.length > 0
          ? `Forgot the ${material} conversion (${result.forgotten.map((c) => `1 ${c.from} = ${c.factor} ${c.to}`).join("; ")}).`
          : result.similar.length > 0
          ? `I have no conversion saved for "${material}". I do have: ${result.similar.map(describeConversion).join("; ")}. Say the name exactly to forget one.`
          : `I have no conversion saved for "${material}".`;
    }
  }
  if (extraction?.intent === "set_unit_conversion") {
    const conv = await extractUnitConversion(env, transcript);
    const from = normalizeUnit(conv.from_unit);
    const to = normalizeUnit(conv.to_unit);
    if (!conv.item_name || !conv.from_unit || !conv.to_unit || conv.factor === null) {
      unitConversionMessage = `I couldn't make out the material, the two units and how many are in each. Say it like "a box of laminate is 2.2 square metres".`;
    } else if (!from || !to) {
      const unknown = !from ? conv.from_unit : conv.to_unit;
      unitConversionMessage = `I don't recognise the unit "${unknown}". I know square metres, boxes, bags, rolls, lengths, tiles, sheets, litres, kilograms, tubes, tins, packs, pallets, metres and each.`;
    } else if (from === to) {
      unitConversionMessage = `Both of those are ${unitPlural(from)}, so there is nothing to convert.`;
    } else {
      const saved = await setUnitConversion(env, conv.item_name, from, to, conv.factor, recordingUserEmail);
      unitConversionMessage = `Noted: 1 ${saved.from} of ${saved.item} = ${saved.factor} ${saved.to}. I'll use that when a delivery comes in ${unitPlural(saved.from)} against an order in ${unitPlural(saved.to)}.${saved.replaced !== null ? ` (It was ${saved.replaced}.)` : ""}`;
    }
  }

  let message: string | null = null;
  if (extraction?.intent === "supplier_statement" && supplierStatementReply) {
    message = supplierStatementReply;
  } else if ((extraction?.intent === "set_unit_conversion" || extraction?.intent === "forget_unit_conversion") && unitConversionMessage) {
    message = unitConversionMessage;
  }
  if (message === null) return null;
  return { message };
}
