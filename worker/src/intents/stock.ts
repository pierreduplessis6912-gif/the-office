// Stock by voice: register an item to track, record stock used on a job, and record a stocktake count.
//
// Rewrite Phase 3, step 4 (2026-10-04). The second intent group moved out of processOneExtraction, unchanged and not rewritten: the same branches, the
// same messages. These three intents read only the sentence and write nothing back to the caller but the reply; every variable used here was
// private to these pieces (checked before the move). A sentence has exactly one intent, so one handler at the position of the first branch keeps the
// order of writes identical. Returns the finished reply, or null when the sentence is not one of these intents.
import type { Env } from "../types";
import type { Extraction } from "../types";
import { extractStockItemRegistration, extractStockUsage, extractStocktake } from "../ai";
import { checkStockUnit, getTrackedStockItems, recordStockUsage, recordStocktake, registerStockItem } from "../finance";
import { reconcileCustomer } from "../identity";

const STOCK_INTENTS = new Set(["register_stock_item", "stock_usage", "stocktake"]);

export async function handleStock(
  env: Env,
  input: { extraction: Extraction | null; transcript: string }
): Promise<{ message: string } | null> {
  const { extraction, transcript } = input;
  if (!extraction || !STOCK_INTENTS.has(extraction.intent ?? "")) return null;
  // Real feature 2026-07-25 — Consumables Stock, the idea-tank
  // review's first real, unlocked item. All three intents here stay
  // deliberately unguarded — quantity-only, no money moving, matching
  // GRN's own precedent exactly.
  let stockRegistrationResult: { id: number; name: string; unit: string | null; existed: boolean } | null = null;
  if (extraction?.intent === "register_stock_item") {
    const reg = await extractStockItemRegistration(env, transcript);
    if (reg.name) {
      const recorded = await registerStockItem(env, reg.name, reg.unit);
      stockRegistrationResult = { id: recorded.id, name: reg.name, unit: reg.unit, existed: recorded.existed };
    }
  }

  let stockUsageResult: { itemName: string; quantityUsed: number; newQuantityOnHand: number } | null = null;
  let stockUsageNoMatch = false;
  let stockUnitQuestion: string | null = null;
  let stockUnitNote = "";
  if (extraction?.intent === "stock_usage") {
    const trackedItems = await getTrackedStockItems(env);
    if (trackedItems.length > 0) {
      const usage = await extractStockUsage(env, transcript, trackedItems);
      const matchedItem = usage.matched_item_name
        ? trackedItems.find((i) => i.name.toLowerCase() === usage.matched_item_name!.toLowerCase())
        : null;
      // Decided by Pierre 2026-10-04: a quantity said in another unit from the one the item is kept in ("3 boxes" of an item kept in sqm) is
      // converted when a conversion is known, and when it is not nothing is recorded and the person is asked for it once.
      const usageUnit = matchedItem && usage.quantity_used != null ? await checkStockUnit(env, matchedItem, usage.unit, usage.quantity_used) : null;
      if (usageUnit && !usageUnit.ok) {
        stockUnitQuestion = usageUnit.question;
      } else if (matchedItem && usage.quantity_used != null && usageUnit && usageUnit.ok) {
        const usageCustomerId = usage.job_customer_name ? (await reconcileCustomer(env, usage.job_customer_name))?.id ?? null : null;
        const recorded = await recordStockUsage(env, matchedItem.id, usageUnit.quantity, usageCustomerId, transcript);
        stockUnitNote = usageUnit.note;
        stockUsageResult = { itemName: matchedItem.name, quantityUsed: usageUnit.quantity, newQuantityOnHand: recorded.newQuantityOnHand };
      } else {
        stockUsageNoMatch = true;
      }
    } else {
      stockUsageNoMatch = true;
    }
  }

  let stocktakeResult: { itemName: string; quantityCounted: number; quantityExpected: number; variance: number } | null = null;
  let stocktakeNoMatch = false;
  if (extraction?.intent === "stocktake") {
    const trackedItems = await getTrackedStockItems(env);
    if (trackedItems.length > 0) {
      const st = await extractStocktake(env, transcript, trackedItems);
      const matchedItem = st.matched_item_name
        ? trackedItems.find((i) => i.name.toLowerCase() === st.matched_item_name!.toLowerCase())
        : null;
      const countUnit = matchedItem && st.quantity_counted != null ? await checkStockUnit(env, matchedItem, st.unit, st.quantity_counted) : null;
      if (countUnit && !countUnit.ok) {
        stockUnitQuestion = countUnit.question;
      } else if (matchedItem && st.quantity_counted != null && countUnit && countUnit.ok) {
        const recorded = await recordStocktake(env, matchedItem.id, countUnit.quantity, transcript);
        stockUnitNote = countUnit.note;
        stocktakeResult = {
          itemName: matchedItem.name,
          quantityCounted: countUnit.quantity,
          quantityExpected: recorded.quantityExpected,
          variance: recorded.variance,
        };
      } else {
        stocktakeNoMatch = true;
      }
    } else {
      stocktakeNoMatch = true;
    }
  }

  let message: string | null = null;
  if (extraction?.intent === "register_stock_item" && stockRegistrationResult) {
    message = `${stockRegistrationResult.existed ? "Already tracking" : "Now tracking"} ${stockRegistrationResult.name}${stockRegistrationResult.unit ? ` (${stockRegistrationResult.unit})` : ""} as real, running stock.`;
  } else if (extraction?.intent === "register_stock_item") {
    message = "Recognized a request to start tracking stock, but no real material name was given — try naming it.";
  } else if ((extraction?.intent === "stock_usage" || extraction?.intent === "stocktake") && stockUnitQuestion) {
    message = stockUnitQuestion;
  } else if (extraction?.intent === "stock_usage" && stockUsageResult) {
    message = `Recorded ${stockUsageResult.quantityUsed} used of ${stockUsageResult.itemName} — ${stockUsageResult.newQuantityOnHand} remaining.${stockUnitNote}`;
    // Decided by Pierre 2026-10-04: using more than is on hand is still recorded (the usage happened, the count was wrong),
    // but the reply now says the count looks off instead of quietly reporting a negative number.
    if (stockUsageResult.newQuantityOnHand < 0) {
      message += ` That is more than the ${stockUsageResult.newQuantityOnHand + stockUsageResult.quantityUsed} on hand, so the count looks off. A stock count will put it right.`;
    }
  } else if (extraction?.intent === "stock_usage" && stockUsageNoMatch) {
    message = "Recognized real stock usage, but couldn't match it to anything currently being tracked — try naming the exact item, or track it first.";
  } else if (extraction?.intent === "stocktake" && stocktakeResult) {
    const varianceText = stocktakeResult.variance === 0 ? "matches exactly, no variance" : `variance ${stocktakeResult.variance > 0 ? "+" : ""}${stocktakeResult.variance} vs the expected ${stocktakeResult.quantityExpected}`;
    message = `Stocktake recorded for ${stocktakeResult.itemName}: counted ${stocktakeResult.quantityCounted}, ${varianceText}.${stockUnitNote}`;
  } else if (extraction?.intent === "stocktake" && stocktakeNoMatch) {
    message = "Recognized a stocktake, but couldn't match it to anything currently being tracked — try naming the exact item, or track it first.";
  }
  if (message === null) return null;
  return { message };
}
