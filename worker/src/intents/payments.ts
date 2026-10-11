// Money that changes hands, said out loud: a customer paid, an expense, a payment to a supplier. Each is HELD for confirmation, never written at once.
//
// Rewrite Phase 3, step 12 (2026-10-04). Moved out of processOneExtraction unchanged and not rewritten: three small blocks, the same statements in the
// same order. Checked before the move: nothing unrelated sits between the blocks; it reads five things (the extraction, the sentence, the customer, the
// supplier and the environment); the only variable it declares (whether a supplier payment had no supplier named) is used by the reply code, so it is
// returned; and it assigns back the held action's number and type, which are handed back too. A sentence has exactly one intent, so only one block runs.
import type { Env } from "../types";
import type { Extraction } from "../types";
import { holdForConfirmation, recordExpense } from "../finance";

export async function handlePayments(
  env: Env,
  input: {
    extraction: Extraction | null;
    transcript: string;
    customer: { id: number; name: string; matched: boolean } | null;
    character: { id: number; name: string; matched: boolean } | null;
    pendingActionId: number | null;
    pendingActionType: string | null;
  }
) {
  const { extraction, transcript, customer, character } = input;
  let pendingActionId = input.pendingActionId;
  let pendingActionType = input.pendingActionType;
  // Decided by Pierre 2026-10-04: a payment with no amount is no longer held with the amount blank for you to confirm without a number. It
  // asks "how much?" and holds nothing, as an invoice with no amount already does.
  if (extraction?.intent === "payment" && customer && extraction.amount) {
    const held = await holdForConfirmation(
      env,
      "payment",
      { customerId: customer.id, customerName: customer.name, amount: extraction.amount },
      transcript
    );
    pendingActionId = held.id;
    pendingActionType = "payment";
  }

  // Real bug found live 2026-07-12: this required a named supplier
  // (character) to exist before an expense would even be held for
  // confirmation. A genuine, common case — "filled up the bakkie with
  // diesel for R650," no supplier named at all — silently vanished
  // with no record, no pending action, and no error, exactly the
  // silent-loss failure mode the receptacle exists to prevent.
  // recordExpense already correctly supports a null characterId;
  // the guard just shouldn't have required one to exist. Fixed to
  // require only a real amount, same pattern as invoice below.
  if (extraction?.intent === "expense" && extraction.amount) {
    const held = await holdForConfirmation(
      env,
      "expense",
      {
        characterId: character?.id ?? null,
        characterName: character?.name,
        customerId: customer?.id ?? null,
        customerName: customer?.name,
        amount: extraction.amount,
        description: transcript,
      },
      transcript
    );
    pendingActionId = held.id;
    pendingActionType = "expense";
  }

  // Real feature 2026-07-24 — the real prerequisite for Aged
  // Creditors, guard()d the same as every other real financial write.
  // Built in certain anticipation of a real, recurring need (a
  // monthly supplier statement), not speculative completeness.
  let supplierPaymentNoSupplier = false;
  if (extraction?.intent === "supplier_payment" && extraction.amount) {
    if (character) {
      const held = await holdForConfirmation(
        env,
        "supplier_payment",
        { characterId: character.id, characterName: character.name, amount: extraction.amount },
        transcript
      );
      pendingActionId = held.id;
      pendingActionType = "supplier_payment";
    } else {
      supplierPaymentNoSupplier = true;
    }
  }
  return { pendingActionId, pendingActionType, supplierPaymentNoSupplier };
}
