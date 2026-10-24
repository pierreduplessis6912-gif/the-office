// Answering a question (intent "lookup"): every kind of thing a person can ask the business, answered from what the system knows.
//
// Rewrite Phase 3, step 10 (2026-10-04). The lookup branch of processOneExtraction's reply chain, 275 lines, moved here unchanged and not rewritten: the
// same scopes (a customer, a supplier, the whole business, delivery exceptions, price history, open orders, supplier statements, unit conversions, ...),
// the same permission refusals, the same answers. Checked before the move: the body reads six things (the extraction, the sentence, the conversation,
// the member's permissions, and the customer and the supplier), assigns back exactly ONE (the message), has no early return and
// no background work, and declares nothing that the code after it uses. So this is a plain function that returns the answer, and the branch's CONDITION
// stays in the reply chain where it was, which means nothing about which reply wins can have changed.
import { cannotSee, cannotSeePart, WITHHELD_SEE_TOPICS, type Refusal } from "../refusals";
import type { Env } from "../types";
import type { Extraction } from "../types";
import { answerFromMemory, classifyBusinessTopic, classifyDashboardIntent, resolveFollowUpEntity } from "../ai";
import { intentCreationRefusal } from "../auth";
import { asksAboutDeliveryExceptions, deliveryExceptionAnswer } from "../documents";
import { getAgedCreditorsSummary, getAgedDebtorsSummary, getCustomerFinancialSummary, getCustomerProjectSummary, getDeliveryExceptions, getExpenseSummary, getFinancialSnapshot, getJobProfitability, getLastPricePaid, getOpenOrdersAcrossSuppliers, getOutstandingInvoices, getProfitAndLossSummary, getQuotationsSummary, listSupplierStatements, listUnitConversions, openOrdersAnswer, supplierStatementsAnswer, unitConversionsAnswer } from "../finance";
import { getCharacterFacts, getCharacterNotes, getCustomerNotes, getRecentLifeEvents } from "../memory";
import { getCompletedToday, getInstallerActivity, getTodaysSchedule } from "../scheduler";
import { HistoryTurn } from "../types";

export async function answerLookup(
  env: Env,
  input: {
    extraction: Extraction;
    transcript: string;
    history: HistoryTurn[];
    capabilities: string[];
    customer: { id: number; name: string; matched: boolean } | null;
    character: { id: number; name: string; matched: boolean } | null;
    // Out-parameter: a whole-answer role refusal is pushed here (refusals.ts), so the reply can say so in structure and not only in words.
    refusals?: Refusal[];
  }
): Promise<string> {
  const { extraction, transcript, history, capabilities, customer, character } = input;
  // Wraps a restricted fact that is only PART of a composed answer: records that something was withheld (once per topic) and returns the facts unchanged.
  const withheld = <T,>(topic: (typeof WITHHELD_SEE_TOPICS)[number], facts: T): T => {
    if (input.refusals && !input.refusals.some((r) => r.topic === topic)) input.refusals.push(cannotSeePart(topic));
    return facts;
  };
  let message: string;
  // Real feature 2026-07-25 — GRN-informed pricing. A real,
  // historical fact, answered directly from real supplier invoice
  // data — never a suggested rate, never replacing Peter's own
  // pricing judgment.
  if (extraction?.query_scope === "material_price" && extraction.fact_value && !capabilities.includes("can_know_material_prices")) {
    // Decided by Pierre 2026-10-04: the last price paid for a material is a switch of its own (it was open to every role).
    message = "Material prices exist for this business but are restricted for your role.";
    input.refusals?.push(cannotSee("material_prices"));
  } else if (extraction?.query_scope === "material_price" && extraction.fact_value) {
    const priceInfo = await getLastPricePaid(env, extraction.fact_value);
    if (priceInfo) {
      message = `The last real price paid for ${priceInfo.description} was R${priceInfo.unitPrice}${priceInfo.supplierName ? ` (from ${priceInfo.supplierName}` : ""}${priceInfo.supplierName ? `, ${priceInfo.date.split(" ")[0]})` : `, ${priceInfo.date.split(" ")[0]}`}.`;
    } else {
      message = `No real supplier invoice on file yet mentions "${extraction.fact_value}" — nothing to base a price on.`;
    }
  } else if (extraction?.query_scope === "open_orders") {
    // Answered in code, from the same data as the Suppliers screen, and with the same permission (invoicing).
    if (!capabilities.includes("can_manage_invoices")) input.refusals?.push(cannotSee("open_orders"));
    message = capabilities.includes("can_manage_invoices")
      ? openOrdersAnswer(await getOpenOrdersAcrossSuppliers(env, character?.id ?? null), character?.name ?? null)
      : "Open orders exist for this business but are restricted for your role.";
  } else if (extraction?.query_scope === "supplier_statements") {
    // Decided by Pierre 2026-10-04: the recorded statements can be asked for ("what did Floornet claim we owe"). Answered in code. Needs the
    // same permission as checking a statement in the first place.
    if (intentCreationRefusal("supplier_statement", capabilities)) input.refusals?.push(cannotSee("supplier_statements"));
    message = intentCreationRefusal("supplier_statement", capabilities)
      ? "Supplier statements exist for this business but are restricted for your role."
      : supplierStatementsAnswer(await listSupplierStatements(env, character?.id ?? null), character?.name ?? null);
  } else if (extraction?.query_scope === "unit_conversions") {
    // Decided by Pierre 2026-10-04: the saved unit conversions can be asked for in words. Answered in code, not paraphrased by a model, so
    // the list is always exact. Materials access, like saving one.
    if (!capabilities.includes("can_know_materials")) input.refusals?.push(cannotSee("unit_conversions"));
    message = capabilities.includes("can_know_materials")
      ? unitConversionsAnswer(await listUnitConversions(env, extraction.fact_value), extraction.fact_value?.trim() || null)
      : "Unit conversions exist for this business but are restricted for your role.";
  } else if (!customer && !character && asksAboutDeliveryExceptions(transcript)) {
    // Decided 2026-10-03 (Pierre): the delivery exception report, asked for in words. It had only
    // existed as a route and the app has no screen for it. Same permission as the report route
    // (can_manage_invoices), checked here before anything is read. Answered in code, not
    // paraphrased by a model, so the list is always complete and exact. Deliberately ahead of the
    // general business branch, which would otherwise spend a classification call and answer from
    // unrelated financial facts.
    if (!capabilities.includes("can_manage_invoices")) input.refusals?.push(cannotSee("delivery_exceptions"));
    message = capabilities.includes("can_manage_invoices")
      ? deliveryExceptionAnswer(await getDeliveryExceptions(env, "open"))
      : "Delivery exception details exist for this business but are restricted for your role.";
  } else if (extraction?.query_scope === "business") {
    // Real, new routing step, per LOOKUP_ROUTING_ARCHITECTURE.md and
    // direct instruction to build it: checked first, before any of
    // the existing, real fact-gathering runs below, so a confident
    // match skips the slow AI-synthesis path entirely rather than
    // paying its full cost and discarding the result. A confident
    // match sets a real, simple marker the Flutter side recognizes
    // and opens a real room for, instead of displaying as text. An
    // unsure match asks a real, honest clarifying question rather
    // than guessing between the two. No match at all falls through
    // to the existing, unchanged logic below.
    const dashboardRoute = await classifyDashboardIntent(env, transcript);
    // Real, confirmed bug fix, found live: these three were
    // previously declared inside the else branch below, but code
    // right after this whole if/else still referenced them - a
    // genuine ReferenceError, a real 500, on every business-scope
    // question that fell through to the conversational path. Safe
    // defaults here; overwritten inside the else branch when it
    // actually runs.
    let topic: "quotations" | "invoices" | "expenses" | "general" = "general";
    let canKnowDebtors = false;
    let outstandingFacts: string[] = [];
    // Decided by Pierre 2026-10-04: a role that cannot see the financial screens is told so, instead of being sent to an empty screen (or
    // asked which of two screens it would like). Same permissions as the screens' own data routes (profit or debtors).
    const canSeeFinancialScreens = capabilities.includes("can_know_profit") || capabilities.includes("can_know_debtors");
    if ((dashboardRoute === "financial_snapshot" || dashboardRoute === "aged_debtors" || dashboardRoute === "unsure") && !canSeeFinancialScreens) {
      message = "The financial overview exists for this business but is restricted for your role.";
      input.refusals?.push(cannotSee("financial_overview"));
    } else if (dashboardRoute === "financial_snapshot" || dashboardRoute === "aged_debtors") {
      message = `__OPEN_DASHBOARD__:${dashboardRoute}`;
    } else if (dashboardRoute === "unsure") {
      message = "Did you want to see the full financial snapshot, or are you asking specifically about who owes you money?";
    } else {
      // No single customer — a business-wide financial question,
      // answered from real SQL aggregates, not a guess from a
      // sentence. Real bug found live 2026-07-10: including both
      // fact sets unconditionally meant a follow-up specifically
      // about quotations ("names and amounts") pulled in unrelated
      // invoice-balance facts too. classifyBusinessTopic anchors on
      // the conversation's actual standing topic the same way
      // resolveFollowUpEntity does for named entities — a truly
      // general question (no history, or genuinely broad) still gets
      // both fact sets; a topic-specific follow-up gets only what's
      // relevant to it.
      topic = await classifyBusinessTopic(env, history, transcript);
      // Real feature 2026-07-14 — step 4 of the phased auth scope
      // (Constitution Principle 26): the financial lookup, permission-
      // aware at last, exactly the example used in every design
      // discussion tonight. Checked here, at fact-gathering, before
      // synthesis — never generated in full and filtered afterward. A
      // neutral, valueless marker replaces the real facts when not
      // permitted, so the model can give an honest "restricted"
      // answer rather than a misleading "I don't know."
      const canKnowProfit = capabilities.includes("can_know_profit");
      canKnowDebtors = capabilities.includes("can_know_debtors");
      const canManageInvoicesHere = capabilities.includes("can_manage_invoices");
      // Decided by Pierre 2026-10-04: expense totals and supplier balances are switches of their own (they follow "Money in and out" until set).
      const canKnowExpenseTotals = capabilities.includes("can_know_expense_totals");
      const canKnowSupplierBalances = capabilities.includes("can_know_supplier_balances");
      // Decided by Pierre 2026-10-04: expense totals and what is owed to each supplier are money, so they need the
      // invoicing permission, the same strength as the supplier screen. They used to be gated by can_know_materials,
      // which let an installer read "Floornet: R1200 outstanding" through a business question.
      // Real performance fix, found live: these seven real, independent
      // database aggregates were being awaited one after another,
      // adding real, noticeable latency for a genuinely slow-feeling
      // question. None depends on another's result - only on `topic`
      // and the capability checks above, both already resolved before
      // this point. Same exact conditional logic as before, unchanged
      // - only the execution order changed, from sequential to
      // concurrent.
      let quotationFacts: string[], expenseFacts: string[], snapshotFacts: string[], pnlFacts: string[], agedFacts: string[], creditorFacts: string[];
      [outstandingFacts, quotationFacts, expenseFacts, snapshotFacts, pnlFacts, agedFacts, creditorFacts] = await Promise.all([
        topic === "quotations" || topic === "expenses"
          ? []
          : canKnowDebtors
            ? getOutstandingInvoices(env)
            : withheld("outstanding_balances", ["Outstanding balances exist for this business but are restricted for your role."]),
        topic === "invoices" || topic === "expenses"
          ? []
          : canManageInvoicesHere
            ? getQuotationsSummary(env)
            : withheld("quotation_activity", ["Quotation activity exists for this business but is restricted for your role."]),
        topic === "quotations" || topic === "invoices"
          ? []
          : canKnowExpenseTotals
            ? getExpenseSummary(env)
            : withheld("expense_activity", ["Expense activity exists for this business but is restricted for your role."]),
        topic !== "general" ? [] : canKnowProfit ? getFinancialSnapshot(env) : withheld("financial_performance", ["Financial performance data exists for this business but is restricted for your role."]),
        topic === "general" && canKnowProfit ? getProfitAndLossSummary(env) : [],
        topic === "quotations" || topic === "expenses"
          ? []
          : canKnowDebtors
            ? getAgedDebtorsSummary(env)
            : withheld("outstanding_balances", ["Outstanding balances exist for this business but are restricted for your role."]),
        topic === "quotations" || topic === "invoices"
          ? []
          : canKnowSupplierBalances
            ? getAgedCreditorsSummary(env)
            : withheld("supplier_balances", ["Outstanding supplier balances exist for this business but are restricted for your role."]),
      ]);
      message = await answerFromMemory(env, transcript, [...outstandingFacts, ...quotationFacts, ...expenseFacts, ...snapshotFacts, ...pnlFacts, ...agedFacts, ...creditorFacts]);
    }
    // Real feature 2026-07-12 — the small, real, static piece of
    // Guide (see STATUS.md's pinned entry for the full design and
    // what's deliberately NOT built yet: dissatisfaction-detection,
    // learning, confidence scores). This is deterministic — never
    // left to the model's own relevance judgment, since that
    // judgment already correctly excludes the aged breakdown from a
    // plain "who owes me money" answer as not literally asked for.
    // A short, honest, code-level mention of a real, already-built,
    // closely-related capability — not a raw fact for the model to
    // weigh, a guaranteed addendum. Skipped if aging language was
    // already used, so a genuine aged-breakdown request never gets
    // a redundant "you can also see..." tacked onto its own answer.
    // Real bug caught before shipping: outstandingFacts.length > 0
    // would trigger even when access is restricted, since the
    // restriction marker itself is a one-element array — checking
    // canKnowDebtors explicitly here too, never suggesting a deeper
    // breakdown of something this membership can't see at all.
    // Real, confirmed bug fix: also guarded on dashboardRoute ===
    // "none" now - this addendum only makes sense for the real,
    // conversational fallback path; appending it to a dashboard-
    // open marker or a clarifying question was never correct.
    const alreadyAskedForAging = /\b(aged|aging|overdue|breakdown)\b/i.test(transcript);
    if (dashboardRoute === "none" && canKnowDebtors && outstandingFacts.length > 0 && !alreadyAskedForAging && topic !== "quotations" && topic !== "expenses") {
      message += "\n\nA more detailed aged breakdown is also available if useful.";
    }
  } else if (character) {
    const characterFacts = await getCharacterNotes(env, character.id);
    // Real feature 2026-07-13 — the HR primitive's real payoff:
    // structured facts (role, skill, license, permit) surface
    // alongside notes and job activity, the same "how's Sipho
    // doing" answer now genuinely knowing more about him.
    // Real fix 2026-07-13: hrFacts used to be handed to the model
    // as regular fact-array entries, and the model dropped them
    // during synthesis for a general question like "how's Sipho
    // doing" — the exact same relevance-judgment problem Principle
    // 24 already fixed once. Fixed the same proven way: a real,
    // known fact about a person is never left to the model's own
    // judgment about literal relevance — appended deterministically
    // after synthesis instead.
    const hrFacts = await getCharacterFacts(env, character.id, capabilities);
    // Real feature 2026-07-17 — extending Principle 26: job and
    // installer activity gated behind can_know_jobs, which owner
    // and installer both have but accountant deliberately doesn't.
    // HR facts (role, skill, license) stay ungated for now — no
    // established capability line exists for HR visibility
    // specifically, and inventing one speculatively here would
    // violate Principle 22's own discipline of not enumerating
    // capabilities nobody has concretely needed yet.
    const canKnowJobsHere = capabilities.includes("can_know_jobs");
    // Real feature 2026-07-12 — the first real answer to "how's
    // Sipho doing": if this character has ever been assigned as an
    // installer on a real job, that activity surfaces here too.
    // Real, honestly scoped — only jobs assigned and their real
    // scheduled dates, not completion status or margin, since
    // neither is tracked yet.
    const installerActivity = canKnowJobsHere ? await getInstallerActivity(env, character.id) : [];
    const hasRealInstallerActivity = installerActivity[0] !== "No jobs assigned to this person yet.";
    const facts = [
      `${character.name} is a known contact.`,
      ...characterFacts,
      ...(hasRealInstallerActivity ? installerActivity : []),
      ...(!canKnowJobsHere ? withheld("job_activity", [`${character.name}'s job activity exists but is restricted for your role.`]) : []),
    ];
    message = await answerFromMemory(env, transcript, facts);
    if (hrFacts.length > 0) {
      message += `\n\n${character.name}'s details: ${hrFacts.join(", ")}.`;
    }
  } else if (customer) {
    const memoryFacts = await getCustomerNotes(env, customer.id);
    // Real feature 2026-07-17 — extending Principle 26 to the
    // customer-scope lookup, the most direct analog to the already-
    // fixed business-wide financial lookup: same sensitivity
    // (money, profitability), just scoped to one customer instead
    // of the whole business. Same neutral-marker pattern — an
    // honest refusal naming what's restricted, never a silent
    // omission that reads as "I don't know."
    const canKnowDebtorsHere = capabilities.includes("can_know_debtors");
    const canKnowProfitHere = capabilities.includes("can_know_profit");
    const financialSummary = canKnowDebtorsHere ? await getCustomerFinancialSummary(env, customer.id) : null;
    // Real feature 2026-07-12 — the real payoff of job-cost linking:
    // if any expenses were ever explicitly linked to this customer's
    // job, this surfaces real profitability alongside the balance.
    // Real fix 2026-07-12: the caveat is appended deterministically
    // after synthesis, never handed to the model as a droppable
    // fact — it was reliably stripped out twice in a row when it
    // was.
    const profitability = canKnowProfitHere ? await getJobProfitability(env, customer.id) : null;
    // Real feature 2026-07-22 — Layer 2 (Project) becomes queryable
    // in conversation, the actual point of building same-breath
    // assembly and job_scope_id linking earlier tonight, not just
    // something that lives in a debug route. Gated behind
    // can_know_jobs, the same precedent already established for
    // installer job activity in the character branch above — a
    // project is fundamentally the same kind of job information,
    // seen from the customer's side instead.
    const canKnowJobsForCustomer = capabilities.includes("can_know_jobs");
    const projectFacts = canKnowJobsForCustomer ? await getCustomerProjectSummary(env, customer.id) : [];
    const facts = [
      `${customer.name} is a known customer.`,
      ...(financialSummary ? [`${customer.name}: ${financialSummary}`] : []),
      ...(!canKnowDebtorsHere ? withheld("customer_balance", [`${customer.name}'s financial balance exists but is restricted for your role.`]) : []),
      ...(profitability ? [`Job profitability for ${customer.name}: ${profitability.fact}`] : []),
      ...(!canKnowProfitHere ? withheld("job_profitability", [`Job profitability for ${customer.name} exists but is restricted for your role.`]) : []),
      ...projectFacts,
      ...memoryFacts,
    ];
    message = await answerFromMemory(env, transcript, facts);
    if (profitability) {
      message += `\n\n${profitability.caveat}`;
    }
  } else {
    // No customer named, not a business question — a question
    // about Peter's own day or week. Read straight from the
    // date-keyed life-event store, not an unscoped Vectorize search.
    // Today's completed tasks and confirmed guard() actions are
    // included too — real evidence 2026-07-10: "what did I get done
    // today" needs both sources, not just narrative life events.
    // Real evidence 2026-07-11: "what's up today" needed a THIRD
    // source that didn't exist until now — real scheduled jobs and
    // still-open tasks, not just what already happened.
    // Real bug found live 2026-07-11: as life events accumulated
    // across real testing, this fact list grew long enough that the
    // model started echoing raw life-event facts verbatim instead
    // of synthesizing, and never even reached the schedule/task
    // facts that came after them in the array. Fixed by ordering
    // the most directly relevant facts first — schedule and
    // completed-today are exactly what "what's up today" is asking
    // about; life events are supplementary color, not the answer.
    const scheduleFacts = await getTodaysSchedule(env);
    const completedFacts = await getCompletedToday(env);
    const lifeFacts = await getRecentLifeEvents(env, 7);
    message = await answerFromMemory(env, transcript, [...scheduleFacts, ...completedFacts, ...lifeFacts]);
  }
  return message;
}
