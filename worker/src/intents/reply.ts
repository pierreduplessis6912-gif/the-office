// What the person is told: the reply to a dictated sentence, composed from everything the earlier steps decided.
//
// Rewrite Phase 3, step 13 (2026-10-04), the last piece of processOneExtraction. The reply chain, 234 lines, moved here unchanged and not rewritten: the
// same branches in the same order, including the "complete a task" branch (which reads the open tasks and completes one) and the closing notes about
// sensitive facts and notes that were kept out. Checked before the move: the chain is a PURE function of what it is given. It reads 28 values, assigns
// NO outer variable (it declares only `message`), has no early return and no background work; and the function's final return needs nothing from inside
// it. Its inputs are the results the other steps produced, grouped as they were produced (the handlers' results, the four facts-and-notes values, the ten
// job-pricing values), and destructured back to their ORIGINAL names so the chain itself did not change. The function that called it is now only an
// orchestrator: it opens the sentence, runs each step, asks this module what to say, and returns.
import { cannotRecordPart, type Refusal } from "../refusals";
import type { Env } from "../types";
import type { Extraction, HistoryTurn } from "../types";
import { answerLookup } from "./lookup";
import type { JobPricingState } from "./job-pricing";
import type { handleOrderHolds, handleOrderRecords } from "./order-admin";
import type { handleProcurement } from "./procurement";
import type { handleSnagsAndLeads } from "./snags-leads";
import type { handleStock } from "./stock";
import { completeTask, describeDate, getOpenTasks, resolveTaskCompletion } from "../scheduler";
import type { sensitiveFactKind } from "../memory";
import { NO_INTENT_MESSAGE } from "../no-intent";

export interface ReplyInput {
  extraction: Extraction | null;
  transcript: string;
  history: HistoryTurn[];
  capabilities: string[];
  customer: { id: number; name: string; matched: boolean } | null;
  character: { id: number; name: string; matched: boolean } | null;
  pendingActionId: number | null;
  pendingActionType: string | null;
  supplierPaymentNoSupplier: boolean;
  facts: { factPendingActionId: number | null; sensitiveKind: ReturnType<typeof sensitiveFactKind> | null; sensitiveFactRefused: boolean; sensitiveNoteKeptOut: boolean };
  jobPricing: JobPricingState;
  orderHoldsResult: Awaited<ReturnType<typeof handleOrderHolds>>;
  procurementResult: Awaited<ReturnType<typeof handleProcurement>>;
  stockResult: Awaited<ReturnType<typeof handleStock>>;
  orderRecordsResult: Awaited<ReturnType<typeof handleOrderRecords>>;
  snagsLeadsResult: Awaited<ReturnType<typeof handleSnagsAndLeads>>;
  refusals: Refusal[];
}

export async function composeReply(env: Env, input: ReplyInput): Promise<string> {
  const { extraction, transcript, history, capabilities, customer, character, pendingActionId, pendingActionType, supplierPaymentNoSupplier, orderHoldsResult, procurementResult, stockResult, orderRecordsResult, snagsLeadsResult } = input;
  const { factPendingActionId, sensitiveKind, sensitiveFactRefused, sensitiveNoteKeptOut } = input.facts;
  const { convertQuoteFound, invoiceJobPartNotRead, invoiceMatchedJob, priceScopeNotFound, quotationLineItems, workObservationAskCustomer, workObservationNothingObserved, workObservationPricingNotMade, workObservationResult } = input.jobPricing;
  let message: string;
  if (extraction?.intent === "task_complete") {
    // Deterministic matching now — no AI call at all in the matching
    // step itself (see resolveTaskCompletion). Completing a task is
    // immediate, no guard() needed — a personal errand is low-stakes,
    // same reasoning as unguarded work observations (cheap to fix if
    // wrong), unlike money or identity.
    const completionPhrase = extraction.personal_note ?? transcript;
    const openTasks = await getOpenTasks(env);
    const { matched, candidates } = resolveTaskCompletion(completionPhrase, openTasks);
    if (matched) {
      await completeTask(env, matched.id);
      message = `Marked done: ${matched.description}.`;
    } else if (candidates.length > 0) {
      // Plain string joining, not reasoning — the AI never picks
      // between these, it never even sees them; this is the "ask
      // Peter" step of the ladder, phrased directly in code.
      message = `Did you mean ${candidates.map((c) => c.description).join(" or ")}?`;
    } else {
      message = "I don't have an open task matching that.";
    }
  } else if (extraction?.intent === "convert_quote" && !pendingActionId) {
    // Intent recognized, but no open quotation exists for this
    // customer to convert — say so honestly rather than silently
    // falling through to a generic message.
    message = customer
      ? `I don't have an open quotation on file for ${customer.name} to convert.`
      : "I don't have anything on file for that yet.";
  } else if (extraction?.intent === "price_scope" && priceScopeNotFound) {
    // Same honesty as the convert_quote case above — intent was
    // recognized, but there's no recorded job_scope for this customer
    // to price up.
    message = customer
      ? `I don't have a job scope on file for ${customer.name} to price.`
      : "I don't have anything on file for that yet.";
  } else if (extraction?.intent === "price_scope" && customer && !pendingActionId) {
    // A job scope was found, but nothing spoken matched a real
    // component/task or produced a positive total — say so rather
    // than silently doing nothing. (Needs a customer: with none named, this branch used to be reached anyway and
    // crashed on customer!.name; found by the characterization recordings 2026-10-03. The no-customer reply is below.)
    message = `Found a job scope for ${customer.name}, but couldn't match any priced item to it — try naming the component or task exactly as measured.`;
  } else if (extraction?.intent === "invoice" && customer && !pendingActionId && !workObservationResult) {
    // Found by the characterization recordings 2026-10-03: an invoice with a named customer but no amount and nothing
    // to record fell through to the generic "Found existing customer" reply, as if it had been a lookup.
    message = `I heard an invoice for ${customer.name}, but no amount came through — how much is it for?${invoiceMatchedJob ? ` This is the same work as job #${invoiceMatchedJob.id} ("${invoiceMatchedJob.description}"), so no new job was created.` : ""}${invoiceJobPartNotRead ? " I couldn't read any job details from that either, so say those again too." : ""}`;
  } else if (extraction?.intent === "payment" && customer && !pendingActionId) {
    message = `I heard a payment from ${customer.name}, but no amount came through — how much was it?`;
  } else if (extraction?.intent === "quotation" && customer && !pendingActionId) {
    // Same: a quotation with no readable items and no amount answered as a lookup.
    message = `I heard a quotation for ${customer.name}, but couldn't make out any items or an amount.`;
  } else if (orderHoldsResult) {
    message = orderHoldsResult.message;
  } else if (procurementResult && procurementResult.message !== null) {
    message = procurementResult.message;
  } else if (orderRecordsResult) {
    message = orderRecordsResult.message;
  } else if (stockResult) {
    message = stockResult.message;
  } else if (snagsLeadsResult) {
    message = snagsLeadsResult.message;
  } else if (pendingActionId && extraction?.intent === "convert_quote" && convertQuoteFound) {
    const { total, depositAmount, remainingBalance, quotationId } = convertQuoteFound;
    const depositNote = extraction.deposit_percent
      ? ` ${extraction.deposit_percent}% deposit (R${depositAmount}) already paid —`
      : "";
    message = `Found quotation #${quotationId} for ${customer!.name} (R${total} total).${depositNote} remaining balance R${remainingBalance}. Needs your confirmation (action #${pendingActionId}) to convert to invoice.`;
  } else if (extraction?.intent === "expense" && pendingActionId) {
    // Real crash found live 2026-07-11: the generic pendingActionId
    // branch below assumes `customer` is always set (`customer!.name`,
    // a non-null assertion that held at compile time but broke at
    // runtime) — expense is the first guard()'d intent keyed to
    // `character` (a supplier) instead of `customer`, and fell through
    // into that assertion, throwing on every real expense message.
    // Given its own branch here, same as task_complete and
    // convert_quote before it.
    message = `Expense noted${character ? ` for ${character.name}` : ""}${extraction.amount ? ` of R${extraction.amount}` : ""} — needs your confirmation (action #${pendingActionId}) before it's recorded.`;
  } else if (extraction?.intent === "supplier_payment" && pendingActionId) {
    // Same real crash risk as expense above — character-keyed, not
    // customer-keyed, so this needs its own branch too.
    message = `Supplier payment noted for ${character!.name} of R${extraction.amount} — needs your confirmation (action #${pendingActionId}) before it's recorded.`;
  } else if (extraction?.intent === "supplier_payment" && supplierPaymentNoSupplier) {
    message = "Recognized a supplier payment, but no supplier was named — try naming who it's to.";
  } else if (
    (extraction?.intent === "invoice" ||
      extraction?.intent === "quotation" ||
      extraction?.intent === "payment" ||
      extraction?.intent === "price_scope") &&
    !customer &&
    !pendingActionId
  ) {
    // Real gap found live 2026-10-02: "invoice site service R5000 for
    // repairs" (lower case, an existing customer "Site Services") came
    // back with extraction intent=invoice, amount=5000, but
    // customer_name=null — confirmed directly via /debug/intent-test.
    // These three intents all require a resolved customer, and with
    // none, no branch above or below matched, so a correctly
    // understood R5000 invoice fell through to the generic "didn't
    // catch anything" message — the same silent-loss shape the
    // supplier intents already avoid with their own "no supplier was
    // named" branches. Said honestly now: what was heard, and what is
    // missing.
    const heard =
      extraction.intent === "invoice"
        ? "an invoice"
        : extraction.intent === "quotation"
        ? "a quotation"
        : extraction.intent === "price_scope"
        ? "a price for a job"
        : "a payment";
    message = `I heard ${heard}${extraction.amount ? ` for R${extraction.amount}` : ""}, but no customer name came through — who is it for?`;
  } else if (pendingActionId) {
    // price_scope's actual destination document depends on
    // scope_document_type, decided the same tense-based way as the
    // plain quotation/invoice split — not always "Quotation" anymore.
    const isScopeInvoice = extraction?.intent === "price_scope" && extraction?.scope_document_type === "invoice";
    const isQuotationLike =
      extraction?.intent === "quotation" || (extraction?.intent === "price_scope" && !isScopeInvoice);
    // The noun comes from what was actually held. It used to be guessed from the intent, so a spoken job observation
    // that also priced the job (a quotation is held) was announced as "Payment noted for ..." (found by the
    // characterization recordings 2026-10-03).
    const kind = pendingActionType === "invoice" ? "Invoice" : pendingActionType === "quotation" ? "Quotation" : "Payment";
    const displayAmount =
      (isQuotationLike || isScopeInvoice) && quotationLineItems.length > 0
        ? quotationLineItems.reduce((sum, item) => sum + item.line_total, 0)
        : extraction!.amount;
    const lineItemNote =
      quotationLineItems.length > 0
        ? ` (${quotationLineItems.length} line item${quotationLineItems.length > 1 ? "s" : ""})`
        : "";
    message = `${kind} noted for ${customer!.name}${displayAmount ? ` of R${displayAmount}` : ""}${lineItemNote} — needs your confirmation (action #${pendingActionId}) before it's recorded.`;
    // Real fix 2026-08-09 — this branch and the workObservationResult
    // one below are mutually exclusive (if/else-if), so an invoice
    // that also recorded a job scope needs its own note appended
    // right here, not a separate branch that would never be reached.
    if (extraction?.intent === "invoice" && invoiceMatchedJob) {
      message += ` This is the same work as job #${invoiceMatchedJob.id} ("${invoiceMatchedJob.description}"), so no new job was created.`;
    }
    if (extraction?.intent === "invoice" && invoiceJobPartNotRead && !workObservationResult) {
      message += " I couldn't read any job details (measurements, an installer or a date) from that, so only the invoice was noted. Say the job part again if you want it recorded.";
    }
    if (workObservationResult) {
      const jobParts: string[] = [];
      if (workObservationResult.componentCount > 0) jobParts.push(`${workObservationResult.componentCount} component${workObservationResult.componentCount > 1 ? "s" : ""} measured`);
      if (workObservationResult.taskCount > 0) jobParts.push(`${workObservationResult.taskCount} task${workObservationResult.taskCount > 1 ? "s" : ""} noted`);
      if (workObservationResult.scheduledDate) jobParts.push(`scheduled for ${describeDate(workObservationResult.scheduledDate)}`);
      message += ` Job scope #${workObservationResult.jobScopeId} also recorded${jobParts.length ? ` — ${jobParts.join(", ")}` : ""}.`;
      if (workObservationResult.installerConflict) {
        const conflict = workObservationResult.installerConflict;
        const who = conflict.customerName ? `${conflict.customerName}: ${conflict.description}` : conflict.description;
        message += ` Heads up — the same installer is already booked that day (${who}).`;
      }
    }
  } else if (extraction?.intent === "work_observation" && workObservationAskCustomer) {
    message = `I heard a job${workObservationAskCustomer.installer ? ` with ${workObservationAskCustomer.installer}` : ""}${workObservationAskCustomer.date ? ` for ${workObservationAskCustomer.date}` : ""}${
      workObservationAskCustomer.rooms + workObservationAskCustomer.tasks > 0
        ? ` (${[workObservationAskCustomer.rooms > 0 ? `${workObservationAskCustomer.rooms} room${workObservationAskCustomer.rooms === 1 ? "" : "s"} measured` : "", workObservationAskCustomer.tasks > 0 ? `${workObservationAskCustomer.tasks} task${workObservationAskCustomer.tasks === 1 ? "" : "s"} noted` : ""].filter(Boolean).join(", ")})`
        : ""
    }, but no customer came through — which customer is it for? Nothing was recorded.`;
  } else if (extraction?.intent === "work_observation" && workObservationNothingObserved) {
    message = customer
      ? `I heard a job observation for ${customer.name}, but couldn't make out any measurements, tasks, date or installer, so nothing was recorded.`
      : "I heard a job observation, but couldn't make out any measurements, tasks, date or installer, so nothing was recorded.";
  } else if (workObservationResult) {
    const { jobScopeId, componentCount, taskCount, installerConflict } = workObservationResult;
    const parts: string[] = [];
    if (componentCount > 0) parts.push(`${componentCount} component${componentCount > 1 ? "s" : ""} measured`);
    if (taskCount > 0) parts.push(`${taskCount} task${taskCount > 1 ? "s" : ""} noted`);
    if (workObservationResult.scheduledDate) parts.push(`scheduled for ${describeDate(workObservationResult.scheduledDate)}`);
    // Real fix 2026-07-13: customer!.name would throw now that a work
    // observation can genuinely record without a customer resolved —
    // caught before shipping, same pattern as the earlier expense-
    // message fix (character ? ... : "").
    message = `Job scope #${jobScopeId} ${workObservationResult.attached ? "updated" : "recorded"}${customer ? ` for ${customer.name}` : ""}${parts.length ? ` — ${parts.join(", ")}` : ""}.`;
    // Real feature 2026-08-08 — installer double-booking, surfaced as
    // a plain warning appended to the same message, never a separate
    // confirmation or a block. "Are we even free to do it" deserves an
    // honest heads-up, not the system silently deciding it's fine, or
    // refusing to book a legitimate double-up on Peter's behalf.
    if (installerConflict) {
      const who = installerConflict.customerName
        ? `${installerConflict.customerName}: ${installerConflict.description}`
        : installerConflict.description;
      message += ` Heads up — the same installer is already booked that day (${who}).`;
    }
    if (workObservationPricingNotMade) {
      message += " You mentioned prices, but I couldn't make out a priced item, so no quotation was made. Say the prices again against the job.";
    }
    // Real fix 2026-07-25 — cross-capture attachment (Layer 2's
    // ask-when-2-plus rung) is no longer decided per-segment here; it
    // runs as its own, separate step in processTranscript, only after
    // every segment of the whole message has been processed and
    // same-breath assembly has had its full, complete chance to run.
  } else if (extraction?.intent === "lookup") {
    // Rewrite Phase 3, step 10: answering a question (every lookup scope) lives in intents/lookup.ts. The condition stays here, so the chain's order is unchanged.
    message = await answerLookup(env, { extraction, transcript, history, capabilities, customer, character, refusals: input.refusals });
  } else if (customer) {
    message = customer.matched ? `Found existing customer: ${customer.name}.` : `New customer noted: ${customer.name}.`;
    if (extraction?.personal_note) {
      message += ` Also noted: ${extraction.personal_note}.`;
    }
  } else if (character) {
    // Real fix for a real, confirmed bug: this exact case — a
    // character resolved, nothing else matched — was silently
    // falling through to the same generic "Got it." as genuine
    // total failure below. Less visible than the Baptist Church
    // case (a real character WAS found or created here), but the
    // same underlying honesty problem — a specific, true outcome
    // deserves a specific, true message.
    message = character.matched ? `Found existing: ${character.name}.` : `Noted: ${character.name}.`;
    if (extraction?.personal_note) {
      message += ` Also noted: ${extraction.personal_note}.`;
    }
  } else {
    // Real fix for a real, confirmed bug, found live: "for the
    // Baptist church in eshawi" — no customer, no character, no
    // intent matched anything above — landed here and said "Got it."
    // with exactly the same confidence as a genuine success, even
    // though nothing was actually captured or acted on. This is the
    // TRUE nothing-happened case now, and it says so honestly instead
    // of pretending otherwise.
    message = NO_INTENT_MESSAGE;
  }

  // Said only when the sentence was kept out of notes AND went nowhere else: a saved detail, or a refusal with its own reason, already says what happened.
  if (sensitiveNoteKeptOut && !factPendingActionId && !sensitiveFactRefused) {
    message += ` It looks like a pay or bank detail, so it was not kept in the notes. To save it, say it as a detail (for example "Sipho's day rate is R600 a day").`;
  }
  if (sensitiveFactRefused) {
    input.refusals.push(cannotRecordPart("sensitive_details"));
    message += ` Nothing was saved: ${sensitiveKind === "payroll" ? "pay details like a day rate or salary can only be saved by someone with payroll access" : "bank details can only be saved by someone with banking access"}.`;
  }
  if (factPendingActionId) {
    message += ` ${extraction!.fact_key} noted (${extraction!.fact_value}) — needs your confirmation (action #${factPendingActionId}) before it's saved.`;
  }
  return message;
}
