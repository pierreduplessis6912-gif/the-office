// Job pricing by dictation: an invoice and the work in the same sentence, a quotation or a price for a scope, converting a quote to an invoice, and a
// spoken job observation (rooms, tasks, an installer, a date).
//
// Rewrite Phase 3, step 8 (2026-10-04). The fifth intent group moved out of processOneExtraction, unchanged and not rewritten: the same 368 lines, in
// the same order. Unlike the four before it, this group is not only reading and replying, so the handler returns a STATE BAG instead of a single
// reply, and the function keeps its reply code exactly where it was:
//   * it can finish the whole result early (the "update that job, or a separate new one?" question): `terminal` is that result, and the caller
//     returns it at once. At that point later variables do not exist yet, so `state` is null;
//   * it can find a customer the sentence did not name (a spoken observation takes the customer from a sibling job in the same message), and it
//     can create a held action: both are handed back (`customer`, `pendingActionId`, `pendingActionType`);
//   * otherwise it hands back the ten values the reply code reads, under their original names (`state`).
// Checked before the move: the region is one contiguous block; it reads nine things and assigns back exactly three (the three above); and all ten
// variables declared in it are used by the reply code after it, so each is returned.
import type { Env } from "../types";
import type { Extraction } from "../types";
import type { LegacyProcessResult } from "./result";
import { extractLineItems, extractScopePricing, extractWorkObservation } from "../ai";
import { checkForJobScopeAmendment, convertQuoteToInvoice, findLatestJobScope, findLatestOpenQuotation, findOpenJobWithSameWork, holdForConfirmation } from "../finance";
import { reconcileCharacter } from "../identity";
import { attachToSiblingJobScope, findSiblingCustomer, hasSiblingToAttach, nowInBusinessTimezone, recordWorkObservation, resolveScheduledDate } from "../scheduler";
import { LineItemWithTotal } from "../types";

export interface JobPricingState {
  convertQuoteFound: { quotationId: number; total: number; depositAmount: number; remainingBalance: number } | null;
  invoiceJobPartNotRead: boolean;
  invoiceMatchedJob: { id: number; description: string } | null;
  jobScopeIdForPricing: number | null;
  priceScopeNotFound: boolean;
  quotationLineItems: LineItemWithTotal[];
  workObservationAskCustomer: { installer: string | null; date: string | null; rooms: number; tasks: number } | null;
  workObservationNothingObserved: boolean;
  workObservationPricingNotMade: boolean;
  workObservationResult: { jobScopeId: number; componentCount: number; taskCount: number; installerConflict: { description: string; customerName: string | null } | null; scheduledDate: string | null; attached?: boolean; } | null;
}

export interface JobPricingOutcome {
  terminal: LegacyProcessResult | null;
  customer: { id: number; name: string; matched: boolean } | null;
  pendingActionId: number | null;
  pendingActionType: string | null;
  state: JobPricingState | null;
}

export async function handleJobPricing(
  env: Env,
  input: {
    extraction: Extraction | null;
    transcript: string;
    customer: { id: number; name: string; matched: boolean } | null;
    character: { id: number; name: string; matched: boolean } | null;
    captureId: number | null;
    canManageInvoicesForWrites: boolean;
    pendingActionId: number | null;
    pendingActionType: string | null;
  }
): Promise<JobPricingOutcome> {
  const { extraction, transcript, character, captureId, canManageInvoicesForWrites } = input;
  let customer = input.customer;
  let pendingActionId = input.pendingActionId;
  let pendingActionType = input.pendingActionType;
  // Real fix 2026-08-09 — moved earlier so the invoice block below can
  // populate this too. Confirmed live via /debug/job-scopes: "invoiced
  // a job for Mr Stevenson for 2 rooms laminate and Jabulani to
  // install next week Monday" recorded the invoice and discarded
  // everything else — no job scope, no installer, no date, not
  // resolved wrong, never even attempted. "invoice" had no equivalent
  // of the fallback quotation/price_scope already had for exactly
  // this same-breath situation.
  let workObservationResult: {
    jobScopeId: number;
    componentCount: number;
    taskCount: number;
    installerConflict: { description: string; customerName: string | null } | null;
    scheduledDate: string | null;
    attached?: boolean;
  } | null = null;

  let invoiceJobPartNotRead = false;
  let invoiceMatchedJob: { id: number; description: string } | null = null;
  if (extraction?.intent === "invoice" && customer) {
    // Real bug, found live a second time: this used to require
    // extraction.amount for the whole block, including the extraction
    // below — meaning a message with no explicit rand figure stated
    // ("2 rooms laminate and Jabulani to install next week Monday")
    // never reached the job-scope recording at all, even after the
    // first fix. The invoice confirmation genuinely does need a real
    // amount to mean anything; the job/installer/schedule capture
    // does not, and now runs regardless.
    if (extraction.amount) {
      const held = await holdForConfirmation(
        env,
        "invoice",
        { customerId: customer.id, customerName: customer.name, description: transcript, amount: extraction.amount },
        transcript
      );
      pendingActionId = held.id;
      pendingActionType = "invoice";
    }

    // Mirrors the quotation/price_scope fallback exactly (same
    // extraction, same recording call) — and does the real installer
    // reconciliation that fallback still doesn't do, rather than
    // repeating the same gap a second place.
    const observation = await extractWorkObservation(env, transcript);
    // Decided by Pierre 2026-10-04: say so when the part of the sentence about the job could not be read, instead of holding
    // the invoice and silently dropping the installer, date and measurements.
    if (observation.readFailed) invoiceJobPartNotRead = true;
    // Real bug fix, found live via a direct, reported failure: "schedule
    // the Premier Hotel to be installed tomorrow" - a named customer, a
    // real date, no measurements or task text - was silently skipped
    // entirely, since this gate only ever checked for components or
    // tasks. resolveScheduledDate and recordWorkObservation below both
    // already handle a date-only or installer-only observation
    // correctly; they just were never being reached for one.
    if (observation.components.length > 0 || observation.tasks.length > 0 || observation.scheduled_date_raw || observation.installer_name) {
      let installerId: number | null = null;
      if (observation.installer_name) {
        const installer = await reconcileCharacter(env, observation.installer_name, "installer");
        installerId = installer?.id ?? null;
      }

      // Real, shared check — see checkForJobScopeAmendment's own
      // comment in finance.ts. Built once, called from every real
      // site that can produce a pure-logistics observation, not
      // patched into this one call site alone.
      // Decided by Pierre 2026-10-04: the same work said again (an invoice for "carpet repair" when the customer already has an open "carpet repair") does
      // NOT make a new job. Only the tasks are matched; a date or installer in the same sentence still goes to the "update that job?" question.
      const sameWork = await findOpenJobWithSameWork(env, customer.id, observation);
      const effectiveObservation = sameWork ? { ...observation, components: [], tasks: [] } : observation;
      const amendment = await checkForJobScopeAmendment(env, customer.id, effectiveObservation, installerId, observation.installer_name, transcript, captureId);
      if (amendment) {
        return { terminal: jobAmendmentReturn({ customer, character, amendment, pendingActionId, pendingActionType, amount: extraction?.amount }), customer, pendingActionId, pendingActionType, state: null };
      }

      if (sameWork) {
        invoiceMatchedJob = sameWork;
      } else {
        const recorded = await recordWorkObservation(env, customer.id, observation, transcript, installerId, captureId);
        workObservationResult = recordedObservationResult(recorded, observation);
      }
    }
  }

  let quotationLineItems: LineItemWithTotal[] = [];
  // Real feature 2026-07-22 — Layer 2 (Project), linking quotations
  // and invoices back to the real job scope they're actually priced
  // from. This is the missing edge the Fable 5 design review correctly
  // identified in tonight's own pinned document — a quotation reaching
  // its project only ever through a lookup at creation time, never a
  // persisted one. Captured here, at the one real point pricing
  // actually happens, from both paths that produce it.
  let jobScopeIdForPricing: number | null = null;
  // price_scope found a customer but no recorded job_scope to price —
  // tracked separately so the message branch below can say so
  // honestly, the same pattern as convertQuoteFound/convertQuoteToInvoice
  // distinguishing "recognized intent, nothing to act on" from silence.
  let priceScopeNotFound = false;
  if ((extraction?.intent === "quotation" || extraction?.intent === "price_scope") && customer) {
    if (extraction.intent === "price_scope") {
      // The job_scopes -> quotation link. Grounded entirely in the
      // real, already-measured job — extraction is only ever told the
      // real component names and areas that exist, never asked to
      // invent structure that isn't already there.
      const jobScope = await findLatestJobScope(env, customer.id, transcript);
      if (jobScope) {
        const pricedItems = await extractScopePricing(env, transcript, jobScope.components, jobScope.tasks);
        const tasksWithComponentNames = jobScope.tasks.map((t) => ({
          description: t.description,
          component_name: t.component_id != null ? jobScope.components.find((c) => c.id === t.component_id)?.name ?? null : null,
        }));
        quotationLineItems = buildQuotationLineItems(pricedItems, jobScope.components, tasksWithComponentNames);
        jobScopeIdForPricing = jobScope.id;
      } else {
        // Real, symmetric fix 2026-07-16 — Layer 1 (Constitution
        // Principle 28): found live — the classifier can pick
        // price_scope OR work_observation for very similarly
        // structured sentences that state a measurement and a rate
        // together, and giving up here whenever price_scope happens
        // to win, with no existing job scope on file, was silently
        // discarding a measurement sitting right there in the same
        // message. Checked here now, mirroring the work_observation
        // path exactly — same recording, same shared pricing helper —
        // so the outcome converges regardless of which intent the
        // classifier happened to choose.
        const observation = await extractWorkObservation(env, transcript);
        if (observation.components.length > 0 || observation.tasks.length > 0) {
          const recorded = await recordWorkObservation(env, customer.id, observation, transcript, null, captureId);
          jobScopeIdForPricing = recorded.jobScopeId;
          if (transcriptMentionsPricing(transcript)) {
            const pricedItems = await extractScopePricing(env, transcript, recorded.computedComponents, observation.tasks);
            quotationLineItems = buildQuotationLineItems(pricedItems, recorded.computedComponents, recorded.computedTasks);
          }
        }
        if (quotationLineItems.length === 0) {
          priceScopeNotFound = true;
        }
      }
    } else {
      const rawLineItems = await extractLineItems(env, transcript);
      // Line total is always computed here, in code — never asked of
      // the model. Same discipline as every rand figure all day.
      quotationLineItems = rawLineItems.map((item) => ({
        ...item,
        // Real feature 2026-07-17 (Constitution Principle 1): a
        // stated discount is applied here, deterministically — the
        // only arithmetic happening is a real percentage reduction on
        // a real, already-known subtotal, never asked of the model.
        line_total:
          item.quantity * item.unit_price * (1 - (item.discount_percent ?? 0) / 100),
      }));
    }

    const total =
      quotationLineItems.length > 0
        ? quotationLineItems.reduce((sum, item) => sum + item.line_total, 0)
        : extraction.amount ?? 0;

    if (total > 0) {
      // A clean, readable description derived from the actual line
      // items — not the raw spoken sentence. This is what shows up
      // on any document generated from this quotation later, and on
      // any invoice converted from it, so it's worth getting right
      // once, at the source, rather than patching each place it's
      // displayed downstream.
      const cleanDescription =
        quotationLineItems.length > 0
          ? quotationLineItems.map((item) => item.description).join("; ")
          : transcript;

      // price_scope has two possible destinations, not one — the same
      // measured job can become a proposed price OR a real invoice,
      // decided by the exact same tense signal ("quote" vs "invoice")
      // already proven for the plain, un-scoped quotation/invoice
      // intents. A plain "quotation" intent always lands here too,
      // since it never had an invoice-flavored sibling to begin with.
      const isScopeInvoice = extraction.intent === "price_scope" && extraction.scope_document_type === "invoice";

      const held = await holdForConfirmation(
        env,
        isScopeInvoice ? "invoice" : "quotation",
        {
          customerId: customer.id,
          customerName: customer.name,
          description: cleanDescription,
          amount: total,
          lineItems: quotationLineItems,
          jobScopeId: jobScopeIdForPricing,
        },
        transcript
      );
      pendingActionId = held.id;
      pendingActionType = isScopeInvoice ? "invoice" : "quotation";
    }
  }

  let convertQuoteFound: { quotationId: number; total: number; depositAmount: number; remainingBalance: number } | null = null;
  if (extraction?.intent === "convert_quote" && customer) {
    const quotation = await findLatestOpenQuotation(env, customer.id);
    if (quotation) {
      const total = quotation.amount;
      // Deposit math computed once, here, deterministically — this is
      // the actual number that gets held for confirmation and, later,
      // written verbatim. Kimi only ever identifies the percentage
      // stated; it never touches this arithmetic.
      const depositAmount = extraction.deposit_percent ? total * (extraction.deposit_percent / 100) : 0;
      const remainingBalance = total - depositAmount;
      convertQuoteFound = { quotationId: quotation.id, total, depositAmount, remainingBalance };

      const held = await holdForConfirmation(
        env,
        "convert_quote",
        {
          quotationId: quotation.id,
          customerId: customer.id,
          customerName: customer.name,
          description: `Balance due — ${quotation.description}`,
          remainingBalance,
          total,
          depositAmount,
          depositPercent: extraction.deposit_percent,
        },
        transcript
      );
      pendingActionId = held.id;
      pendingActionType = "convert_quote";
    }
  }

  let workObservationNothingObserved = false;
  let workObservationAskCustomer: { installer: string | null; date: string | null; rooms: number; tasks: number } | null = null;
  let workObservationPricingNotMade = false;
  if (extraction?.intent === "work_observation") {
    const observation = await extractWorkObservation(env, transcript);
    // Decided by Pierre 2026-10-04: a sentence with only an installer or a date, no customer, and no job or lead from the same capture to
    // attach it to used to be recorded as a customer-less job, findable only by its installer or date. It now asks which customer it is for
    // and records nothing. Decided BEFORE the installer is resolved, so a sentence that is about to be asked about creates no installer.
    // Decided by Pierre 2026-10-04 (extended from the installer-or-date-only case to EVERY case): a job with no customer named and nothing in the
    // same message to supply one asks which customer it is for and records nothing. What supplies one: for a measured room or a task, a job
    // already recorded earlier in the same capture that has a customer (that customer is used); for an installer or a date alone, a job or lead
    // from the same capture to attach to (as before).
    const measuredHere = observation.components.length > 0 || observation.tasks.length > 0;
    if (!customer && measuredHere) {
      const supplied = await findSiblingCustomer(env, captureId);
      if (supplied) customer = { id: supplied.id, name: supplied.name, matched: true };
    }
    const askWhichCustomer =
      !customer &&
      (measuredHere || (Boolean(observation.scheduled_date_raw || observation.installer_name) && !(await hasSiblingToAttach(env, captureId))));
    // Real feature 2026-07-12 — the smallest real first domino toward
    // team support: an installer is reconciled as a real character
    // (same as a supplier — a real, non-billed person), never
    // invented, only linked when genuinely named.
    let installerId: number | null = null;
    if (observation.installer_name && !askWhichCustomer) {
      const installer = await reconcileCharacter(env, observation.installer_name, "installer");
      installerId = installer?.id ?? null;
    }

    // Real fix 2026-08-09 — found live via /debug/split-test: a
    // segment like "schedule Jabulani to install next Monday" (split
    // away from the sentence that actually named the customer and
    // room) has no customer and no measurable component or task of
    // its own here. Creating a fresh, customer-less job scope for it
    // would silently orphan real information instead of losing it
    // outright — no better an outcome. Tried first: attach this
    // installer/date to the most recent sibling job scope from the
    // exact same capture, the segment that described the actual job a
    // moment earlier in the same breath. Falls through to the
    // existing, unchanged behavior whenever this doesn't apply or no
    // sibling exists yet. Deliberately does NOT return early — that
    // would risk silently discarding a real character/customer value
    // already resolved earlier in this same function; workObservationResult
    // is populated here and the function's own existing, natural flow
    // builds the final message exactly as it already does today.
    // Real, second fix, found by direct testing (a real, live
    // ReferenceError, not a style note): declared here, at the scope
    // that actually contains both branches below, rather than inside
    // the else branch alone — the later pricing check needed it too,
    // and was unconditionally out of scope before this, regardless of
    // which branch ran. null in the "attached to a sibling" branch is
    // correct, not a gap: that path has no fresh computedComponents to
    // price against, so "nothing to price here" is the honest answer.
    // Found by the characterization recordings 2026-10-03: when the model found nothing, or failed, a job scope was
    // recorded anyway, with no measurements, no tasks, no date and no installer. As the customer's most recent job it
    // then became what a later pricing request tries to price. The invoice branch has always had this guard; this one
    // did not. Nothing observed is not a job.
    const observedSomething =
      observation.components.length > 0 || observation.tasks.length > 0 || Boolean(observation.scheduled_date_raw) || Boolean(observation.installer_name);
    if (!observedSomething) {
      workObservationNothingObserved = true;
    } else if (askWhichCustomer) {
      workObservationAskCustomer = { installer: observation.installer_name ?? null, date: observation.scheduled_date_raw ?? null, rooms: observation.components.length, tasks: observation.tasks.length };
    } else {
    let recorded: Awaited<ReturnType<typeof recordWorkObservation>> | null = null;
    const scheduledDateForAttach = resolveScheduledDate(observation.scheduled_date_raw, nowInBusinessTimezone());
    const attached =
      !customer && observation.components.length === 0 && observation.tasks.length === 0
        ? await attachToSiblingJobScope(env, captureId, installerId, scheduledDateForAttach, observation.scheduled_date_raw)
        : null;

    if (attached) {
      workObservationResult = {
        jobScopeId: attached.jobScopeId,
        componentCount: 0,
        taskCount: 0,
        scheduledDate: scheduledDateForAttach,
        attached: true,
        // Real, deliberate scope limit: the double-booking check this
        // fix doesn't also extend to the attach path — a separate,
        // smaller gap, not what today's real report was about.
        installerConflict: null,
      };
    } else {
      // Real fix 2026-07-13: no longer gated behind customer being
      // resolved — a job with a real installer but no yet-known
      // customer should still be recorded, not silently dropped.
      // Real, shared amendment check, added here too — this branch
      // (no explicit customer name restated in this message, relying
      // on the current selection) was the actual real gap: a message
      // like "Richards Hotel job, let's schedule that for next
      // Wednesday" lands here, not the customer_name-driven block
      // above, and was never checked before this.
      const amendment = await checkForJobScopeAmendment(env, customer?.id ?? null, observation, installerId, observation.installer_name, transcript, captureId);
      if (amendment) {
        return { terminal: jobAmendmentReturn({ customer, character, amendment, pendingActionId, pendingActionType, amount: extraction?.amount }), customer, pendingActionId, pendingActionType, state: null };
      }

      recorded = await recordWorkObservation(env, customer?.id ?? null, observation, transcript, installerId, captureId);
      workObservationResult = recordedObservationResult(recorded, observation);
    }

    // Real fix 2026-07-15 — Layer 1 (Constitution Principle 28): a
    // rate stated in the same breath as the work it describes used to
    // reach nowhere, since work_observation winning as the segment's
    // top-level intent meant price_scope's extraction never ran at
    // all — the pricing sat in the transcript but nothing looked for
    // it. Checked here, immediately, against the real, just-computed
    // component areas, reusing the exact same, already-proven
    // extraction and quotation-building logic the price_scope path
    // already uses below — not a parallel, duplicated implementation.
    // Gated the same as every other financial write: the measurement
    // itself still records regardless of role, but the nested
    // quotation this pricing produces requires can_manage_invoices.
    if (recorded && customer && canManageInvoicesForWrites && transcriptMentionsPricing(transcript)) {
      // Decided by Pierre 2026-10-04: when prices were mentioned and no quotation came of it (the pricing reader failed, or found
      // no priced item, or the total was nothing), say so instead of recording the job and silently making no quote.
      let quotationMade = false;
      const pricedItems = await extractScopePricing(env, transcript, recorded.computedComponents, observation.tasks);
      if (pricedItems.length > 0) {
        const lineItems = buildQuotationLineItems(pricedItems, recorded.computedComponents, recorded.computedTasks);
        const total = lineItems.reduce((sum, item) => sum + item.line_total, 0);
        if (total > 0) {
          const cleanDescription = lineItems.map((item) => item.description).join("; ");
          const held = await holdForConfirmation(
            env,
            "quotation",
            { customerId: customer.id, customerName: customer.name, description: cleanDescription, amount: total, lineItems, jobScopeId: recorded.jobScopeId },
            transcript
          );
          pendingActionId = held.id;
          pendingActionType = "quotation";
          quotationMade = true;
        }
      }
      if (!quotationMade) workObservationPricingNotMade = true;
    }
    }
  }
  return { terminal: null, customer, pendingActionId, pendingActionType, state: { convertQuoteFound, invoiceJobPartNotRead, invoiceMatchedJob, jobScopeIdForPricing, priceScopeNotFound, quotationLineItems, workObservationAskCustomer, workObservationNothingObserved, workObservationPricingNotMade, workObservationResult } };
}

// The "update that job, or make a separate new one?" question as the function's whole result. Found by the characterization recordings 2026-10-03:
// with an amount in the sentence, the invoice hold was created and then this returned only the amendment question, so a pending invoice existed that
// the reply never mentioned (and the app only offered buttons for the amendment). The hold is still the second thing waiting; the reply now says so,
// with its number.
function jobAmendmentReturn(input: {
  customer: { id: number; name: string; matched: boolean } | null;
  character: { id: number; name: string; matched: boolean } | null;
  amendment: NonNullable<Awaited<ReturnType<typeof checkForJobScopeAmendment>>>;
  pendingActionId: number | null;
  pendingActionType: string | null;
  amount: number | null | undefined;
}): LegacyProcessResult {
  const { customer, character, amendment, pendingActionId, pendingActionType, amount } = input;
  return {
    customer,
    character,
    pendingActionId: amendment.pendingActionId,
    factPendingActionId: null,
    message:
      amendment.message +
      (pendingActionId !== null && amount
        ? ` Your invoice for ${customer?.name ?? "the customer"} of R${amount} is also waiting for confirmation (action #${pendingActionId}).`
        : ""),
    jobScopeIdForProjectResolution: null,
    pendingCandidates: null,
    pendingActionType: "job_scope_amendment",
    pendingChanges: amendment.changes,
    ...(pendingActionId !== null && pendingActionType ? { alsoPending: [{ id: pendingActionId, type: pendingActionType }] } : {}),
  };
}

// What a recorded job observation reports back to the reply.
function recordedObservationResult(
  recorded: Awaited<ReturnType<typeof recordWorkObservation>>,
  observation: Awaited<ReturnType<typeof extractWorkObservation>>
) {
  return {
    jobScopeId: recorded.jobScopeId,
    componentCount: observation.components.length,
    taskCount: observation.tasks.length,
    installerConflict: recorded.installerConflict,
    scheduledDate: recorded.scheduledDate,
  };
}

// ---- helpers used only by this group (they lived in index.ts and nothing else referenced them) ----------------------------------------------

// Real fix 2026-07-21 — a serious bug found live: extractScopePricing
// was being called unconditionally on every work_observation message,
// and hallucinated a real R625 quotation from a message that only
// stated an area ("twenty five square meters"), never a price — the
// model mistook the area, already given back to it in the component
// list, for a stated rate. Fixed with a real, deterministic gate: the
// pricing extraction is never even attempted unless the transcript
// itself contains real price language. Deliberately inclusive rather
// than narrow — an unnecessary check costs nothing; a missed real
// price silently dropped is the failure mode that actually matters.
function transcriptMentionsPricing(transcript: string): boolean {
  return /\brand\b|\bR\s?\d|\bprice\b|\brate\b|\bcost\b|\bcharge\b|\bquote\b|\bdiscount\b|per\s+(sq|square|m2|metre|meter)/i.test(
    transcript
  );
}

// Real feature 2026-07-15 — Layer 1 (Constitution Principle 28):
// factored out so the price_scope path and the new work_observation
// pricing path (pricing stated in the same breath as the work it
// describes) share one single implementation, never two copies of
// the same real-money arithmetic drifting apart from each other.
function buildQuotationLineItems(
  pricedItems: Array<{ matched_name: string | null; description: string; pricing_type: "per_sqm" | "flat"; rate: number }>,
  components: Array<{ name: string; area_sqm: number | null }>,
  tasks: Array<{ description: string; component_name: string | null }> = []
): LineItemWithTotal[] {
  return pricedItems.map((item) => {
    let component = item.matched_name
      ? components.find((c) => c.name.toLowerCase() === item.matched_name!.toLowerCase())
      : undefined;
    // Real fix 2026-07-22, found live: a per-sqm rate matched against
    // a task name (e.g. "screed") has nowhere to price against
    // directly — a task itself has no area, only its linked
    // component does. Resolved here, deterministically, by following
    // the task's own real link back to the component it belongs to —
    // never asked of the model, which only ever matched a name.
    if (!component && item.matched_name) {
      const matchedTask = tasks.find((t) => t.description.toLowerCase() === item.matched_name!.toLowerCase());
      if (matchedTask?.component_name) {
        component = components.find((c) => c.name.toLowerCase() === matchedTask.component_name!.toLowerCase());
      }
    }
    // The only real arithmetic in this whole step — rate x real
    // measured area — always happens here, in code. The model's job
    // was only ever matching a name and recognizing whether the
    // stated rate was per-sqm or flat.
    if (item.pricing_type === "per_sqm" && component?.area_sqm != null) {
      const lineTotal = Math.round(component.area_sqm * item.rate * 100) / 100;
      return {
        description: item.description,
        note: null,
        quantity: component.area_sqm,
        unit: "sqm",
        unit_price: item.rate,
        line_total: lineTotal,
      };
    }
    return {
      description: component?.name ?? item.description,
      note: null,
      quantity: 1,
      unit: null,
      unit_price: item.rate,
      line_total: item.rate,
    };
  });
}
