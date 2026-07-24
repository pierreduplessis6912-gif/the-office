import { Env, Extraction, HistoryTurn, LineItemWithTotal, ProcessResult } from "./types";
import { answerFromMemory, arrayBufferToBase64, classifyBusinessTopic, describeImage, embedText, extractGoodsReceived, extractIntent, extractLineItems, extractMultipleIntents, extractPurchaseOrder, extractScopePricing, extractSupplierInvoice, extractWorkObservation, rerank, resolveFollowUpEntity, storeUnscopedMemory, transcribe } from "./ai";
import { findExistingCharacterByName, findExistingCustomerByName, findExistingEntityByName, getCurrentSelection, looksLikeAQuestion, reconcileCharacter, reconcileCustomer, setSelection } from "./identity";
import { completeTask, createTask, getCompletedToday, getEmberCounts, getInstallerActivity, getOpenTasks, getTodaysSchedule, nowInBusinessTimezone, recordWorkObservation, resolveTaskCompletion } from "./scheduler";
import { appendCharacterNote, appendCustomerNote, appendLifeEvent, applyCharacterFact, applyStructuredFact, getCharacterFacts, getCharacterNotes, getCustomerNotes, getRecentLifeEvents, logCapture, runConsolidation, updateCaptureHint, updateCaptureText } from "./memory";
import { buildDocumentResponse, convertQuoteToInvoice, findLatestJobScope, findLatestOpenPurchaseOrder, findLatestOpenQuotation, generateAgedDebtorsPdf, generateDocumentPdf, generateProfitAndLossPdf, generateStatementPdf, getAgedDebtorsSummary, getCustomerFinancialSummary, getCustomerProjectSummary, getExpenseSummary, getFinancialSnapshot, getJobProfitability, getOutstandingInvoices, getProfitAndLossSummary, getPurchaseOrderLineItems, getQuotationsSummary, holdForConfirmation, recordExpense, recordGoodsReceived, recordInvoice, recordPayment, recordPurchaseOrder, recordQuotation, recordSupplierInvoice } from "./finance";
import { resolvePDFJS } from "pdfjs-serverless";

// Second layer of defense against storing questions as facts — never
// trust intent classification alone for this, since it's been
// observed to misfire twice now, in two different storage paths
// (customer notes yesterday, life events today). A dumb, deterministic
// check can't be talked out of being right by an off day from the
// model. Not a replacement for the intent check — an extra one.
const QUESTION_STARTERS = [
  "what", "who", "when", "where", "why", "how", "do ", "does ", "did ",
  "is ", "are ", "was ", "were ", "can ", "could ", "would ", "should ",
];


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

// Real feature 2026-07-13 — the reusable core of what used to be the
// whole of processTranscript, now callable once per item in a
// multi-intent message instead of once per raw message. Internal
// logic is otherwise UNCHANGED from the single-intent version proven
// correct all session — this is a wrapping change, not a rewrite, to
// keep the real risk of this refactor as small as it can be.
async function processOneExtraction(
  env: Env,
  transcript: string,
  extraction: Extraction | null,
  history: HistoryTurn[],
  ctx: ExecutionContext,
  captureId: number | null,
  capabilities: string[]
): Promise<{
  customer: { id: number; name: string; matched: boolean } | null;
  character: { id: number; name: string; matched: boolean } | null;
  pendingActionId: number | null;
  factPendingActionId: number | null;
  message: string;
}> {
  let customer: { id: number; name: string; matched: boolean } | null = null;
  let character: { id: number; name: string; matched: boolean } | null = null;
  let pendingActionId: number | null = null;

  // Real bug found via external review 2026-07-11, confirmed against
  // the actual code: reconcileCustomer/reconcileCharacter create a
  // new row on no-match, and were being called unconditionally for
  // EVERY intent, including "lookup" — so "what's Jenny's address?"
  // for a Jenny who doesn't exist silently created her, then
  // correctly said "I don't have anything on file." Not corrupted
  // data, but a real violation of Principle 1: a lookup should be
  // pure resolution, never a write. Fixed by routing lookup intent
  // through the already-existing read-only findExistingEntityByName
  // instead of the create-or-find reconcile functions.
  if (extraction?.customer_name) {
    if (extraction.intent === "lookup") {
      const found = await findExistingCustomerByName(env, extraction.customer_name);
      if (found) {
        customer = { id: found.id, name: found.name, matched: true };
      }
    } else {
      customer = await reconcileCustomer(env, extraction.customer_name);
    }
  }

  if (extraction?.character_name) {
    if (extraction.intent === "lookup") {
      const found = await findExistingCharacterByName(env, extraction.character_name);
      if (found) {
        character = { id: found.id, name: found.name, matched: true };
      }
    } else {
      character = await reconcileCharacter(env, extraction.character_name, extraction.character_relationship);
    }
  }

  // Only for the genuinely ambiguous case — a lookup with no name in
  // the message itself, AND the model didn't already confidently
  // decide this has nothing to do with any specific entity. Real bug
  // found live 2026-07-11: "what's up for today?" correctly classified
  // as query_scope "personal" by the model, but the register still
  // fired (intent=lookup, no name given) and silently overrode it to
  // "customer" — answering about whichever customer was most recently
  // touched instead of Peter's actual question, because nothing
  // checked whether the model had already ruled out an entity being
  // involved at all. The register check below needs no history at
  // all (it reads real, persisted D1 state); only the AI-based
  // fallback further down genuinely needs history text to scan.
  // Real bug found live 2026-07-12: "what have we spent on expenses?"
  // — a completely standalone, self-contained business question, sent
  // with zero history — got silently rewritten from query_scope
  // "business" to "character", because BUCO happened to be the most
  // recently touched register selection. That's meaningfully
  // different from the proven ProSupply case ("who did we deal with
  // in those instances?"), which only correctly resolves to a
  // specific entity because real history exists for it to genuinely
  // be a follow-up to. A "business"-scoped question arriving with NO
  // history at all has nothing to be a follow-up of — the register
  // should never touch it. "personal" stays excluded outright (same
  // as before); "business" is now only eligible when there's real
  // history to justify treating it as a possible follow-up.
  const scopeCouldBeEntity =
    extraction?.query_scope !== "personal" && !(extraction?.query_scope === "business" && history.length === 0);
  if (extraction?.intent === "lookup" && !customer && !character && scopeCouldBeEntity) {
    // Register first — rung 1 of the Execution Ladder, zero AI calls.
    // Peter's own words already established this selection on a prior
    // turn ("show me Jenny"); a later vague reference ("show me the
    // quote") should read that real, already-known answer before ever
    // falling back to AI-based history scanning. Real bug found live
    // 2026-07-11: this check was originally gated behind
    // `history.length > 0`, inherited unchanged from the old
    // AI-only fallback — but the register lives in D1, not in
    // conversation history, so a test that deliberately sent no
    // history skipped it entirely. Fixed: unconditional now.
    const current = await getCurrentSelection(env);
    if (current?.type === "customer") {
      customer = { id: current.id, name: current.name, matched: true };
      extraction = { ...extraction, query_scope: "customer" };
    } else if (current?.type === "character") {
      character = { id: current.id, name: current.name, matched: true };
      extraction = { ...extraction, query_scope: "character" };
    } else if (history.length > 0) {
      // Register genuinely empty, and there's real history to scan —
      // only now does AI-based resolution get invoked at all.
      const resolvedName = await resolveFollowUpEntity(env, history, transcript);
      if (resolvedName) {
        const found = await findExistingEntityByName(env, resolvedName);
        if (found?.type === "customer") {
          customer = { id: found.id, name: found.name, matched: true };
          extraction = { ...extraction, query_scope: "customer" };
        } else if (found?.type === "character") {
          character = { id: found.id, name: found.name, matched: true };
          extraction = { ...extraction, query_scope: "character" };
        }
      }
    }
  }

  // Write-back — whichever of customer/character was just resolved,
  // by any path (direct name, or the register/AI fallback above),
  // becomes the new current selection, overwriting whatever was there
  // before. This is what makes the NEXT vague reference resolvable
  // without any AI call at all.
  if (customer) {
    ctx.waitUntil(setSelection(env, "customer", customer.id, customer.name));
  }
  if (character) {
    ctx.waitUntil(setSelection(env, "character", character.id, character.name));
  }

  if (captureId !== null) {
    const hint = customer?.name ?? character?.name ?? null;
    ctx.waitUntil(updateCaptureHint(env, captureId, hint, customer?.id ?? null, character?.id ?? null));
  }

  // Real feature 2026-07-17 — extending Principle 26 to the write
  // side, not just reads. Everything gated so far this session
  // controlled who can SEE existing financial data; nothing yet
  // controlled who can CREATE it. can_manage_invoices already exists
  // specifically to distinguish who manages financial documents
  // (Owner and Accountant have it, Installer doesn't) — the natural,
  // already-established capability to gate this with, not a new
  // policy invented on the spot. A restricted role gets an honest,
  // clear refusal instead of silently being allowed to trigger a real
  // financial write that only Peter's own confirmation happens to
  // catch later.
  const canManageInvoicesForWrites = capabilities.includes("can_manage_invoices");
  const FINANCIAL_WRITE_INTENTS = ["payment", "expense", "invoice", "quotation", "price_scope", "convert_quote"];
  if (FINANCIAL_WRITE_INTENTS.includes(extraction?.intent ?? "") && !canManageInvoicesForWrites) {
    return {
      customer,
      character,
      pendingActionId: null,
      factPendingActionId: null,
      message: "Recording payments, invoices, quotations, or expenses isn't available for your role — let someone with that permission know.",
    };
  }

  if (extraction?.intent === "payment" && customer) {
    const held = await holdForConfirmation(
      env,
      "payment",
      { customerId: customer.id, customerName: customer.name, amount: extraction.amount },
      transcript
    );
    pendingActionId = held.id;
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
  }

  // Real feature 2026-07-21 — Purchase Orders, built incrementally
  // per the real, three-way design pinned in DECISIONS.md.
  // Deliberately unguarded, the same precedent already established
  // for job scopes — a real commitment, not yet a transaction.
  let purchaseOrderResult: { purchaseOrderId: number; lineItemCount: number } | null = null;
  let purchaseOrderNoSupplier = false;
  if (extraction?.intent === "purchase_order") {
    if (character) {
      const poExtraction = await extractPurchaseOrder(env, transcript);
      const recorded = await recordPurchaseOrder(env, character.id, poExtraction.description, transcript, poExtraction.line_items);
      purchaseOrderResult = { purchaseOrderId: recorded.purchaseOrderId, lineItemCount: poExtraction.line_items.length };
    } else {
      // Honest, not silent — the same discipline as every other
      // recognized-but-nothing-to-act-on case in this project.
      purchaseOrderNoSupplier = true;
    }
  }

  // Real feature 2026-07-21 — Goods Received Notes, the second stage.
  // Guard()'d, matching the original design's own distinction — real
  // stock changes hands here, unlike the PO itself.
  let goodsReceivedNoSupplier = false;
  let goodsReceivedNoOpenPo = false;
  let goodsReceivedSupplierName: string | null = null;
  if (extraction?.intent === "goods_received") {
    if (character) {
      const openPo = await findLatestOpenPurchaseOrder(env, character.id);
      if (openPo) {
        const poLineItems = await getPurchaseOrderLineItems(env, openPo.id);
        const grnExtraction = await extractGoodsReceived(env, transcript, poLineItems);
        const held = await holdForConfirmation(
          env,
          "goods_received",
          {
            purchaseOrderId: openPo.id,
            supplierId: character.id,
            supplierName: character.name,
            lineItems: grnExtraction.line_items,
          },
          transcript
        );
        pendingActionId = held.id;
        goodsReceivedSupplierName = character.name;
      } else {
        goodsReceivedNoOpenPo = true;
      }
    } else {
      goodsReceivedNoSupplier = true;
    }
  }

  // Real feature 2026-07-21 — Supplier Invoices, the third and final
  // stage. This is where real money moves, guard()'d the same as
  // every other financial write in this project.
  let supplierInvoiceNoSupplier = false;
  let supplierInvoiceNoOpenPo = false;
  let supplierInvoiceSupplierName: string | null = null;
  if (extraction?.intent === "supplier_invoice") {
    if (character) {
      const openPo = await findLatestOpenPurchaseOrder(env, character.id);
      if (openPo) {
        const poLineItems = await getPurchaseOrderLineItems(env, openPo.id);
        const siExtraction = await extractSupplierInvoice(env, transcript, poLineItems);
        const held = await holdForConfirmation(
          env,
          "supplier_invoice",
          {
            purchaseOrderId: openPo.id,
            supplierId: character.id,
            supplierName: character.name,
            supplierReference: siExtraction.supplier_reference,
            lineItems: siExtraction.line_items,
          },
          transcript
        );
        pendingActionId = held.id;
        supplierInvoiceSupplierName = character.name;
      } else {
        supplierInvoiceNoOpenPo = true;
      }
    } else {
      supplierInvoiceNoSupplier = true;
    }
  }

  if (extraction?.intent === "invoice" && customer && extraction.amount) {
    const held = await holdForConfirmation(
      env,
      "invoice",
      { customerId: customer.id, customerName: customer.name, description: transcript, amount: extraction.amount },
      transcript
    );
    pendingActionId = held.id;
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
    }
  }

  let workObservationResult: { jobScopeId: number; componentCount: number; taskCount: number } | null = null;
  if (extraction?.intent === "work_observation") {
    const observation = await extractWorkObservation(env, transcript);
    // Real feature 2026-07-12 — the smallest real first domino toward
    // team support: an installer is reconciled as a real character
    // (same as a supplier — a real, non-billed person), never
    // invented, only linked when genuinely named.
    let installerId: number | null = null;
    if (observation.installer_name) {
      const installer = await reconcileCharacter(env, observation.installer_name, "installer");
      installerId = installer?.id ?? null;
    }
    // Real fix 2026-07-13: no longer gated behind customer being
    // resolved — a job with a real installer but no yet-known
    // customer should still be recorded, not silently dropped.
    const recorded = await recordWorkObservation(env, customer?.id ?? null, observation, transcript, installerId, captureId);
    workObservationResult = {
      jobScopeId: recorded.jobScopeId,
      componentCount: observation.components.length,
      taskCount: observation.tasks.length,
    };

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
    if (customer && canManageInvoicesForWrites && transcriptMentionsPricing(transcript)) {
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
        }
      }
    }
  }

  // Holds for confirmation instead of writing immediately. Real
  // evidence today: a misreconciled customer had this fire before
  // anyone ever saw a pending action to reject, silently overwriting
  // a different real person's address. Same discipline as money now
  // — a wrong reconciliation can no longer cause silent damage before
  // a human gets a chance to catch it.
  let factPendingActionId: number | null = null;
  if (extraction?.fact_key && extraction?.fact_value && customer) {
    const held = await holdForConfirmation(
      env,
      "customer_fact",
      { customerId: customer.id, customerName: customer.name, key: extraction.fact_key, value: extraction.fact_value },
      transcript
    );
    factPendingActionId = held.id;
  }

  // Real feature 2026-07-13 — the HR primitive's real recording
  // wiring, mirroring the customer_fact guard exactly. customer_name
  // and character_name are mutually exclusive per extraction's own
  // rule, so this never double-fires alongside the customer_fact
  // guard above for the same message.
  if (extraction?.fact_key && extraction?.fact_value && character) {
    const held = await holdForConfirmation(
      env,
      "character_fact",
      { characterId: character.id, characterName: character.name, key: extraction.fact_key, value: extraction.fact_value },
      transcript
    );
    factPendingActionId = held.id;
  }

  // A personal fragment riding alongside a customer message gets its
  // own life event, independent of whatever happens to the customer
  // part below. This is what stops "remind me to get dog food" from
  // silently vanishing into a stranger's customer file.
  if (extraction?.personal_note) {
    ctx.waitUntil(appendLifeEvent(env, extraction.personal_note));
  }
  // Real bug found live 2026-07-11: "remind me to phone my mother"
  // correctly recognized "mother" as a character and intent as
  // "reminder", but left personal_note null — the model treated the
  // WHOLE message as being about that character rather than a mixed
  // customer/character-plus-personal split, since there was no
  // separate customer to split away from. Task creation used to be
  // gated on personal_note being set, so this silently created no
  // task at all, while still replying "Got it." — exactly the kind
  // of silent failure the receptacle exists to prevent. Fixed by
  // decoupling: a reminder ALWAYS creates a task, using personal_note
  // when there genuinely was a mixed message to split, falling back
  // to the full transcript when the reminder was never mixed with
  // anything else to begin with.
  if (extraction?.intent === "reminder") {
    ctx.waitUntil(createTask(env, extraction.personal_note ?? transcript, customer?.id ?? null, character?.id ?? null, extraction.due_date_raw));
  }

  // Store the ORIGINAL words, not the rewritten version — the
  // rewrite exists purely to correctly resolve intent and retrieval,
  // never to replace what was actually said in the permanent record.
  // Never store questions — a lookup is a question, not a fact.
  // Two independent checks, not one: intent classification (has
  // misfired before) AND a dumb, deterministic question-shape check
  // that can't be talked out of it. Either one flagging it is enough
  // to skip storage.
  // No customer mentioned isn't "nowhere to put this" anymore — it's
  // Peter's own day: the actual gap named last night, now closed.
  // Real bug found live 2026-07-10: a "reminder" message's
  // customer_name is timing/location context for the reminder
  // ("after Jenny's job"), not a fact ABOUT the customer — the same
  // subject-attribution principle already applied to ProSupply. The
  // raw transcript (dog food and all) was still being stored verbatim
  // into the customer's own file even though personal_note above
  // already captured the whole thing correctly and separately —
  // "remind me to get dog food" doesn't belong in Jenny's notes just
  // because her job happened to be the reminder's trigger.
  const isQuestion = extraction?.intent === "lookup" || looksLikeAQuestion(transcript);
  const isPersonalErrand = extraction?.intent === "reminder" || extraction?.intent === "task_complete";
  // Real fix found live 2026-07-17, via direct testing (Constitution
  // Principle 26): any intent with real, structured storage of its
  // own — payment, invoice, quotation, price_scope, expense,
  // work_observation — was also having its raw transcript duplicated
  // into this ungated note, purely redundant since the real data is
  // already properly captured elsewhere, and a genuine leak, since
  // that duplicate note bypassed every capability gate entirely.
  // Proven directly: an Installer session was correctly refused the
  // structured financial summary, then handed the same fact anyway —
  // "Jenny paid R500" — verbatim from this exact note. The fallback
  // now only fires for genuinely narrative facts that have no other
  // structured home to live in.
  const hasStructuredHomeAlready = [
    "payment",
    "invoice",
    "quotation",
    "price_scope",
    "expense",
    "work_observation",
  ].includes(extraction?.intent ?? "");
  if (!isQuestion && !isPersonalErrand && !hasStructuredHomeAlready) {
    if (customer) {
      ctx.waitUntil(appendCustomerNote(env, customer.id, transcript));
    } else if (character) {
      ctx.waitUntil(appendCharacterNote(env, character.id, transcript));
    } else if (!extraction?.personal_note) {
      // Only fall back to storing the whole transcript as a life
      // event if personal_note didn't already capture the relevant
      // fragment above — avoids storing the same thing twice.
      ctx.waitUntil(appendLifeEvent(env, transcript));
    }
  }

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
  } else if (extraction?.intent === "price_scope" && !pendingActionId) {
    // A job scope was found, but nothing spoken matched a real
    // component/task or produced a positive total — say so rather
    // than silently doing nothing.
    message = `Found a job scope for ${customer!.name}, but couldn't match any priced item to it — try naming the component or task exactly as measured.`;
  } else if (extraction?.intent === "purchase_order" && purchaseOrderResult) {
    message = `Purchase order #${purchaseOrderResult.purchaseOrderId} recorded for ${character!.name} — ${purchaseOrderResult.lineItemCount} item(s).`;
  } else if (extraction?.intent === "purchase_order" && purchaseOrderNoSupplier) {
    // Honest, not silent — the same discipline as every other
    // recognized-but-nothing-to-act-on case in this project.
    message = "Recognized a purchase order, but no supplier was named — try naming who it's from.";
  } else if (pendingActionId && extraction?.intent === "goods_received" && goodsReceivedSupplierName) {
    message = `Delivery noted from ${goodsReceivedSupplierName} — needs your confirmation (action #${pendingActionId}) before it's recorded.`;
  } else if (extraction?.intent === "goods_received" && goodsReceivedNoSupplier) {
    message = "Recognized a delivery, but no supplier was named — try naming who it's from.";
  } else if (extraction?.intent === "goods_received" && goodsReceivedNoOpenPo) {
    message = `I don't have an open purchase order on file for ${character!.name} to match this delivery against.`;
  } else if (pendingActionId && extraction?.intent === "supplier_invoice" && supplierInvoiceSupplierName) {
    message = `Supplier invoice noted from ${supplierInvoiceSupplierName} — needs your confirmation (action #${pendingActionId}) before it's recorded.`;
  } else if (extraction?.intent === "supplier_invoice" && supplierInvoiceNoSupplier) {
    message = "Recognized a supplier invoice, but no supplier was named — try naming who it's from.";
  } else if (extraction?.intent === "supplier_invoice" && supplierInvoiceNoOpenPo) {
    message = `I don't have an open purchase order on file for ${character!.name} to bill this invoice against.`;
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
  } else if (pendingActionId) {
    // price_scope's actual destination document depends on
    // scope_document_type, decided the same tense-based way as the
    // plain quotation/invoice split — not always "Quotation" anymore.
    const isScopeInvoice = extraction?.intent === "price_scope" && extraction?.scope_document_type === "invoice";
    const isQuotationLike =
      extraction?.intent === "quotation" || (extraction?.intent === "price_scope" && !isScopeInvoice);
    const kind = extraction?.intent === "invoice" || isScopeInvoice ? "Invoice" : isQuotationLike ? "Quotation" : "Payment";
    const displayAmount =
      (isQuotationLike || isScopeInvoice) && quotationLineItems.length > 0
        ? quotationLineItems.reduce((sum, item) => sum + item.line_total, 0)
        : extraction!.amount;
    const lineItemNote =
      quotationLineItems.length > 0
        ? ` (${quotationLineItems.length} line item${quotationLineItems.length > 1 ? "s" : ""})`
        : "";
    message = `${kind} noted for ${customer!.name}${displayAmount ? ` of R${displayAmount}` : ""}${lineItemNote} — needs your confirmation (action #${pendingActionId}) before it's recorded.`;
  } else if (workObservationResult) {
    const { jobScopeId, componentCount, taskCount } = workObservationResult;
    const parts: string[] = [];
    if (componentCount > 0) parts.push(`${componentCount} component${componentCount > 1 ? "s" : ""} measured`);
    if (taskCount > 0) parts.push(`${taskCount} task${taskCount > 1 ? "s" : ""} noted`);
    // Real fix 2026-07-13: customer!.name would throw now that a work
    // observation can genuinely record without a customer resolved —
    // caught before shipping, same pattern as the earlier expense-
    // message fix (character ? ... : "").
    message = `Job scope #${jobScopeId} recorded${customer ? ` for ${customer.name}` : ""}${parts.length ? ` — ${parts.join(", ")}` : ""}.`;
  } else if (extraction?.intent === "lookup") {
    if (extraction?.query_scope === "business") {
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
      const topic = await classifyBusinessTopic(env, history, transcript);
      // Real feature 2026-07-14 — step 4 of the phased auth scope
      // (Constitution Principle 26): the financial lookup, permission-
      // aware at last, exactly the example used in every design
      // discussion tonight. Checked here, at fact-gathering, before
      // synthesis — never generated in full and filtered afterward. A
      // neutral, valueless marker replaces the real facts when not
      // permitted, so the model can give an honest "restricted"
      // answer rather than a misleading "I don't know."
      const canKnowProfit = capabilities.includes("can_know_profit");
      const canKnowDebtors = capabilities.includes("can_know_debtors");
      // Outstanding invoices is literally who owes money — the same
      // debtors category as the aged breakdown below, gated the same
      // way. A real gap caught before it shipped: it's easy to gate
      // the obviously-named "aged debtors" fact and overlook that
      // "outstanding invoices" is the identical category of
      // information under a different name.
      const outstandingFacts =
        topic === "quotations" || topic === "expenses"
          ? []
          : canKnowDebtors
            ? await getOutstandingInvoices(env)
            : ["Outstanding balances exist for this business but are restricted for your role."];
      const canManageInvoicesHere = capabilities.includes("can_manage_invoices");
      const canKnowMaterialsHere = capabilities.includes("can_know_materials");
      const quotationFacts =
        topic === "invoices" || topic === "expenses"
          ? []
          : canManageInvoicesHere
            ? await getQuotationsSummary(env)
            : ["Quotation activity exists for this business but is restricted for your role."];
      const expenseFacts =
        topic === "quotations" || topic === "invoices"
          ? []
          : canKnowMaterialsHere
            ? await getExpenseSummary(env)
            : ["Expense activity exists for this business but is restricted for your role."];
      // Real feature 2026-07-12: the combined snapshot (reading both
      // revenue and expenses) only for genuinely general questions —
      // a topic-specific follow-up about just quotations, just
      // invoices, or just expenses shouldn't have the combined
      // position dragged in alongside it, same discipline as every
      // other topic exclusion here.
      const snapshotFacts =
        topic !== "general" ? [] : canKnowProfit ? await getFinancialSnapshot(env) : ["Financial performance data exists for this business but is restricted for your role."];
      // Real feature 2026-07-12 — the final piece: the formal,
      // accrual-based P&L, alongside the cash-basis snapshot above.
      // Genuinely different questions, both real, same "general only"
      // scoping as the snapshot.
      const pnlFacts = topic === "general" && canKnowProfit ? await getProfitAndLossSummary(env) : [];
      // Aged debtors is fundamentally about receivables — relevant
      // whenever invoices specifically or the business overall is
      // being asked about, excluded only when the topic is narrowly
      // quotations or expenses.
      const agedFacts =
        topic === "quotations" || topic === "expenses"
          ? []
          : canKnowDebtors
            ? await getAgedDebtorsSummary(env)
            : ["Outstanding balances exist for this business but are restricted for your role."];
      message = await answerFromMemory(env, transcript, [...outstandingFacts, ...quotationFacts, ...expenseFacts, ...snapshotFacts, ...pnlFacts, ...agedFacts]);
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
      const alreadyAskedForAging = /\b(aged|aging|overdue|breakdown)\b/i.test(transcript);
      if (canKnowDebtors && outstandingFacts.length > 0 && !alreadyAskedForAging && topic !== "quotations" && topic !== "expenses") {
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
      const hrFacts = await getCharacterFacts(env, character.id);
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
        ...(!canKnowJobsHere ? [`${character.name}'s job activity exists but is restricted for your role.`] : []),
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
        ...(!canKnowDebtorsHere ? [`${customer.name}'s financial balance exists but is restricted for your role.`] : []),
        ...(profitability ? [`Job profitability for ${customer.name}: ${profitability.fact}`] : []),
        ...(!canKnowProfitHere ? [`Job profitability for ${customer.name} exists but is restricted for your role.`] : []),
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
  } else if (customer) {
    message = customer.matched ? `Found existing customer: ${customer.name}.` : `New customer noted: ${customer.name}.`;
    if (extraction?.personal_note) {
      message += ` Also noted: ${extraction.personal_note}.`;
    }
  } else {
    message = "Got it.";
  }

  if (factPendingActionId) {
    message += ` ${extraction!.fact_key} noted (${extraction!.fact_value}) — needs your confirmation (action #${factPendingActionId}) before it's saved.`;
  }

  return { customer, character, pendingActionId, factPendingActionId, message };
}
// through processOneExtraction, same result. The only real difference
// for a single-topic message is the one extra split-check call.
async function processTranscript(
  env: Env,
  transcript: string,
  ctx: ExecutionContext,
  history: HistoryTurn[] = [],
  source: string = "text",
  r2Key: string | null = null,
  capabilities: string[] = ROLE_CAPABILITIES.owner
): Promise<ProcessResult> {
  const captureId = await logCapture(env, transcript, source, r2Key);

  const items = await extractMultipleIntents(env, transcript);

  const results: Array<{
    customer: { id: number; name: string; matched: boolean } | null;
    character: { id: number; name: string; matched: boolean } | null;
    pendingActionId: number | null;
    factPendingActionId: number | null;
    message: string;
  }> = [];

  for (const item of items) {
    const outcome = await processOneExtraction(env, item.segment, item.extraction, history, ctx, captureId, capabilities);
    results.push(outcome);
  }

  // Real, deterministic merge — never another AI call to summarize,
  // which would just reintroduce the exact relevance-judgment risk
  // Principle 24 already had to correct once tonight. Each segment's
  // own message already says the real, complete thing that happened
  // to it; multiple segments just get joined, not resynthesized.
  const message =
    results.length === 1
      ? results[0].message
      : results.map((r) => `- ${r.message}`).join("\n");

  const pendingActionIds = results.map((r) => r.pendingActionId).filter((id): id is number => id !== null);
  const factPendingActionIds = results.map((r) => r.factPendingActionId).filter((id): id is number => id !== null);
  const primary = results[0];

  const embers = await getEmberCounts(env);
  return {
    extraction: items[0]?.extraction ?? null,
    extractionRaw: items[0]?.raw ?? null,
    extractionRawText: items[0]?.rawText ?? null,
    customer: results.find((r) => r.customer)?.customer ?? primary?.customer ?? null,
    pendingActionId: pendingActionIds[0] ?? null,
    pendingActionIds,
    factPendingActionId: factPendingActionIds[0] ?? null,
    message,
    rewrittenQuery: transcript,
    embers,
  };
}

// Real feature 2026-07-14 — session signing/verification, step 1 of
// the phased auth scope (Constitution Principles 25-27). A session
// needs to be verifiable on every request without re-running the
// OAuth dance each time, and tamper-evident without needing a server-
// side session store — a signed token carries its own proof.
function base64UrlEncode(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
  let str = "";
  for (const byte of arr) str += String.fromCharCode(byte);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function base64UrlDecode(str: string): Uint8Array {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((str.length + 3) % 4);
  const bin = atob(padded);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}
async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}
async function signSession(env: Env, email: string): Promise<string> {
  const payload = JSON.stringify({ email, exp: Date.now() + 30 * 24 * 60 * 60 * 1000 }); // 30 real days
  const payloadB64 = base64UrlEncode(new TextEncoder().encode(payload));
  const key = await hmacKey(env.SESSION_SECRET);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payloadB64));
  return `${payloadB64}.${base64UrlEncode(signature)}`;
}
async function verifySession(env: Env, token: string | null): Promise<{ email: string } | null> {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payloadB64, sigB64] = parts;
  try {
    const key = await hmacKey(env.SESSION_SECRET);
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      base64UrlDecode(sigB64),
      new TextEncoder().encode(payloadB64)
    );
    if (!valid) return null;
    const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(payloadB64))) as {
      email: string;
      exp: number;
    };
    if (Date.now() > payload.exp) return null; // real expiry, not just a signature check
    return { email: payload.email };
  } catch {
    return null; // malformed token — never trust something that fails to parse cleanly
  }
}
// Real, deliberately incomplete role-capability map — only Owner and
// Installer are defined, because those are the only two roles anyone
// has actually specified a concrete capability list for. Extensible
// when a real third role is needed, not enumerated in advance for
// roles nobody has asked for yet (Principle 22). Module scope, shared
// by the membership debug routes and real capability resolution below
// — one single source of truth, never duplicated.
const ROLE_CAPABILITIES: Record<string, string[]> = {
  owner: [
    "can_know_profit",
    "can_know_debtors",
    "can_know_payroll",
    "can_know_banking",
    "can_manage_invoices",
    "can_know_jobs",
    "can_know_measurements",
    "can_know_materials",
    "can_invite_members",
    "can_delete_data",
    "can_manage_settings",
  ],
  installer: ["can_know_jobs", "can_know_measurements", "can_capture_voice_notes", "can_know_materials"],
  // Real feature 2026-07-15 — added the moment a real person was
  // actually named for this role, not enumerated speculatively.
  // Proposed default, not yet reviewed against a concrete example the
  // way Owner and Installer were: financial visibility and invoice
  // management, explicitly excluding operational capabilities (jobs,
  // measurements) that aren't an accountant's concern, and
  // administrative ones (invite, delete, settings) that stay
  // Owner-only regardless of role.
  accountant: ["can_know_profit", "can_know_debtors", "can_know_payroll", "can_know_banking", "can_manage_invoices", "can_know_materials"],
};

// Real feature 2026-07-14 — step 4 of the phased auth scope
// (Constitution Principle 26): resolving what the asker's membership
// actually permits, before any synthesis happens. Real, honest gap
// documented rather than hidden: no valid session currently defaults
// to full (owner-equivalent) capabilities, since every existing route
// and the UI prototype predate real auth and don't send a session
// cookie yet. Safe for a single-instance system only Peter currently
// uses; this default MUST be revisited the moment a real second
// person with genuinely restricted access exists — capability
// enforcement without a required session is not real enforcement.
async function resolveCapabilities(request: Request, env: Env): Promise<{ email: string | null; role: string | null; capabilities: string[] }> {
  const session = await verifySession(env, getCookie(request, "office_session"));
  if (!session) {
    return { email: null, role: null, capabilities: ROLE_CAPABILITIES.owner };
  }
  const membership = await env.OFFICE_DB.prepare("SELECT role, status FROM memberships WHERE google_email = ?")
    .bind(session.email)
    .first<{ role: string; status: string }>();
  if (!membership || membership.status !== "active") {
    return { email: session.email, role: null, capabilities: [] };
  }
  return { email: session.email, role: membership.role, capabilities: ROLE_CAPABILITIES[membership.role] ?? [] };
}

function getCookie(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie");
  if (!header) return null;
  const match = header.split(";").map((c) => c.trim()).find((c) => c.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}

async function handleRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/health") {
      return Response.json({ status: "ok", service: "office-api" });
    }

    // Real, complete auth routes are implemented further down
    // (/auth/google/login, /auth/google/callback, /auth/me,
    // /auth/logout) — the placeholder that used to catch every
    // /auth/* path here has been removed; it was shadowing them.

    // --- Debug routes. Left in deliberately during this experimentation
    // phase. Strip these before anything resembling real customer data
    // goes through.
    if (url.pathname === "/debug/list-audio" && request.method === "GET") {
      const listed = await env.OFFICE_VAULT.list({ prefix: "voice-notes/" });
      return Response.json({
        objects: listed.objects.map((o) => ({ key: o.key, size: o.size, uploaded: o.uploaded })),
      });
    }

    if (url.pathname === "/debug/reprocess" && request.method === "GET") {
      const key = url.searchParams.get("key");
      if (!key) return Response.json({ error: "missing ?key=" }, { status: 400 });
      const object = await env.OFFICE_VAULT.get(key);
      if (!object) return Response.json({ error: "key not found in R2" }, { status: 404 });
      const audioBuffer = await object.arrayBuffer();

      const { transcript, transcriptionError } = await transcribe(env, audioBuffer);
      const processed = transcript ? await processTranscript(env, transcript, ctx, [], "voice", key) : null;

      return Response.json({ key, transcript, transcriptionError, ...processed });
    }

    if (url.pathname === "/debug/search-memory" && request.method === "GET") {
      const text = url.searchParams.get("text");
      const customerId = url.searchParams.get("customerId");
      if (!text) return Response.json({ error: "missing ?text=" }, { status: 400 });

      const vector = await embedText(env, text);
      const results = await env.MEMORY.query(vector, {
        topK: 10,
        returnMetadata: true,
        filter: customerId ? { customerId } : undefined,
      });

      return Response.json({
        text,
        customerId,
        matches: (results.matches ?? []).map((m) => ({
          score: m.score,
          text: (m.metadata as { text?: string } | undefined)?.text,
          createdAt: (m.metadata as { createdAt?: string } | undefined)?.createdAt,
        })),
      });
    }

    // Inspect the actual primary memory now — the KV blob for one
    // customer, not Vectorize (which lags behind, batched, on cron).
    if (url.pathname === "/debug/customer-notes" && request.method === "GET") {
      const customerId = url.searchParams.get("customerId");
      if (!customerId) return Response.json({ error: "missing ?customerId=" }, { status: 400 });
      const raw = await env.CUSTOMER_NOTES.get(`customer:${customerId}`);
      return Response.json({ customerId, raw: raw ? JSON.parse(raw) : null });
    }

    // The write-back counterpart to /debug/customer-notes GET — for
    // correcting a KV entry directly (e.g. removing a fact that got
    // filed under the wrong entity) without needing wrangler access.
    // Deliberately generic (any key, any JSON value) rather than one
    // narrow "remove a fact" endpoint — the same reasoning as every
    // other debug tool here: general enough to be useful again, not
    // custom-built for one cleanup.
    if (url.pathname === "/debug/kv-set" && request.method === "POST") {
      const body = (await request.json()) as { key?: string; value?: unknown };
      if (!body.key) return Response.json({ error: "missing key" }, { status: 400 });
      await env.CUSTOMER_NOTES.put(body.key, JSON.stringify(body.value));
      return Response.json({ status: "set", key: body.key });
    }

    // Debug counterpart to resolveFollowUpEntity, the closed-form
    // replacement for the abandoned prose-rewriting approach (see the
    // 2026-07-10 bug log in STATUS.md for why). Takes the same
    // {history, text} shape as /messages/text so a real drill-down
    // conversation can be replayed exactly.
    if (url.pathname === "/debug/resolve-entity-test" && request.method === "POST") {
      const body = (await request.json()) as { text?: string; history?: HistoryTurn[] };
      if (!body.text) return Response.json({ error: "missing text" }, { status: 400 });
      const history = Array.isArray(body.history) ? body.history : [];
      const resolvedName = await resolveFollowUpEntity(env, history, body.text);
      const found = resolvedName ? await findExistingEntityByName(env, resolvedName) : null;
      return Response.json({ input: body.text, resolvedName, found });
    }

    // Scoped cleanup for a customer row created in error (e.g. a
    // supplier that should have been a character) — removes the D1
    // row, its KV notes, and any pending_memory_flush entries so
    // nothing dangling gets embedded into Vectorize afterward. Not a
    // general SQL executor on purpose — this only ever does exactly
    // these three deletes, scoped to one customer id.
    if (url.pathname === "/debug/delete-customer" && request.method === "POST") {
      const id = url.searchParams.get("id");
      if (!id) return Response.json({ error: "missing ?id=" }, { status: 400 });
      await env.OFFICE_DB.prepare("DELETE FROM customers WHERE id = ?").bind(id).run();
      await env.OFFICE_DB.prepare("DELETE FROM pending_memory_flush WHERE customer_id = ?").bind(id).run();
      await env.CUSTOMER_NOTES.delete(`customer:${id}`);
      return Response.json({ status: "deleted", id });
    }

    // Same shape as delete-customer, for a character created in error
    // — e.g. a staff contact that fragmented off a supplier
    // relationship instead of staying attached to it. No
    // pending_memory_flush cleanup needed here: characters never
    // queue into Vectorize consolidation in the first place.
    if (url.pathname === "/debug/delete-character" && request.method === "POST") {
      const id = url.searchParams.get("id");
      if (!id) return Response.json({ error: "missing ?id=" }, { status: 400 });
      await env.OFFICE_DB.prepare("DELETE FROM characters WHERE id = ?").bind(id).run();
      await env.CUSTOMER_NOTES.delete(`character:${id}`);
      return Response.json({ status: "deleted", id });
    }

    // One-time schema init for the new tasks table (2026-07-10) — real,
    // demonstrated need: a checkable personal errand needs a done state
    // that the narrative life-event log never had, and guard()-confirmed
    // items already have their own done state (pending_actions.status)
    // that this deliberately doesn't duplicate. IF NOT EXISTS makes this
    // safe to call more than once.
    if (url.pathname === "/debug/init-tasks-table" && request.method === "POST") {
      await env.OFFICE_DB.prepare(
        `CREATE TABLE IF NOT EXISTS tasks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          description TEXT NOT NULL,
          done INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          completed_at TEXT
        )`
      ).run();
      return Response.json({ status: "ok" });
    }

    // Real feature 2026-07-11: the actual prerequisite for a future
    // [Call] ember action — tasks linked to a real customer/character
    // record, not just a loose name in text. Same idempotent ALTER
    // pattern as the captures FK migration.
    if (url.pathname === "/debug/init-tasks-fk" && request.method === "POST") {
      for (const column of ["customer_id INTEGER", "character_id INTEGER"]) {
        try {
          await env.OFFICE_DB.prepare(`ALTER TABLE tasks ADD COLUMN ${column}`).run();
        } catch {
          // Already exists — fine, that's what makes this idempotent.
        }
      }
      return Response.json({ status: "ok" });
    }

    // Real feature 2026-07-11 — the first concrete piece of the
    // expense side of the accounting-capability roadmap. Deliberately
    // minimal: a bare table, no category, no VAT, no job linking yet.
    if (url.pathname === "/debug/init-expenses-table" && request.method === "POST") {
      await env.OFFICE_DB.prepare(
        `CREATE TABLE IF NOT EXISTS expenses (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          character_id INTEGER,
          amount REAL,
          description TEXT NOT NULL,
          source_transcript TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )`
      ).run();
      return Response.json({ status: "ok" });
    }

    // Real feature 2026-07-12 — the real prerequisite for eventually
    // distinguishing cost of sales from operating expenses in a
    // formal P&L. Idempotent, same pattern as every other ALTER here.
    if (url.pathname === "/debug/init-expenses-category" && request.method === "POST") {
      try {
        await env.OFFICE_DB.prepare("ALTER TABLE expenses ADD COLUMN category TEXT").run();
      } catch {
        // Already exists — fine, that's what makes this idempotent.
      }
      return Response.json({ status: "ok" });
    }

    // Real feature 2026-07-12 — the real prerequisite for job
    // profitability (getJobProfitability). Idempotent, same pattern
    // as every other ALTER here.
    if (url.pathname === "/debug/init-expenses-jobcost" && request.method === "POST") {
      try {
        await env.OFFICE_DB.prepare("ALTER TABLE expenses ADD COLUMN customer_id INTEGER").run();
      } catch {
        // Already exists — fine, that's what makes this idempotent.
      }
      return Response.json({ status: "ok" });
    }

    // Real feature 2026-07-12 — the real prerequisite for team
    // support: linking a job to who's actually assigned to do it.
    // Idempotent, same pattern as every other ALTER here.
    if (url.pathname === "/debug/init-jobscopes-installer" && request.method === "POST") {
      try {
        await env.OFFICE_DB.prepare("ALTER TABLE job_scopes ADD COLUMN installer_id INTEGER").run();
      } catch {
        // Already exists — fine, that's what makes this idempotent.
      }
      return Response.json({ status: "ok" });
    }

    // Real feature 2026-07-13 — the operational HR primitive's real
    // schema, scoped deliberately: role, skill, qualification,
    // license, site permit. Medical records and disciplinary history
    // are explicitly not here — regulated, need real consent/access
    // thinking first, pinned separately in STATUS.md.
    if (url.pathname === "/debug/init-character-facts" && request.method === "POST") {
      await env.OFFICE_DB.prepare(
        `CREATE TABLE IF NOT EXISTS character_facts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          character_id INTEGER NOT NULL,
          key TEXT NOT NULL,
          value TEXT NOT NULL,
          source_transcript TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )`
      ).run();
      return Response.json({ status: "ok" });
    }

    // Real feature 2026-07-14 — step 2 of the phased auth scope
    // (Constitution Principles 25-27): Membership as a real, separate
    // entity, proven on this single existing instance before any
    // multi-instance routing exists. One membership per real Google
    // account per Office (UNIQUE on google_email) — Office x Person x
    // Role, exactly as designed, nothing inferred from an HR fact.
    if (url.pathname === "/debug/init-memberships" && request.method === "POST") {
      await env.OFFICE_DB.prepare(
        `CREATE TABLE IF NOT EXISTS memberships (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          google_email TEXT NOT NULL UNIQUE,
          role TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active',
          invited_by TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )`
      ).run();
      return Response.json({ status: "ok" });
    }

    // Real feature 2026-07-15 — Layer 1, Stage 0 (Constitution
    // Principle 28): the schema for real retry safety. key is the
    // primary key deliberately — it's what makes a genuine race
    // between two near-simultaneous requests with the same key safe,
    // since the database itself rejects the second INSERT rather than
    // needing an application-level lock.
    if (url.pathname === "/debug/init-idempotency-keys" && request.method === "POST") {
      await env.OFFICE_DB.prepare(
        `CREATE TABLE IF NOT EXISTS idempotency_keys (
          key TEXT PRIMARY KEY,
          status TEXT NOT NULL DEFAULT 'processing',
          result TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )`
      ).run();
      return Response.json({ status: "ok" });
    }

    // Real feature 2026-07-17 (Constitution Principle 28's own
    // sequencing) — deliberately deferred until basic multi-line
    // totaling was proven correct, which it now is. SQLite has no
    // ADD COLUMN IF NOT EXISTS, so this is wrapped to stay safe to
    // re-run rather than fail if it's ever called twice.
    if (url.pathname === "/debug/init-discount-column" && request.method === "POST") {
      try {
        await env.OFFICE_DB.prepare("ALTER TABLE line_items ADD COLUMN discount_percent REAL").run();
        return Response.json({ status: "ok", added: true });
      } catch (err) {
        return Response.json({ status: "ok", added: false, note: "column likely already exists", detail: err instanceof Error ? err.message : String(err) });
      }
    }

    // Real feature 2026-07-20 (Layer 2 / Project design, verified via
    // the Fable 5 design pass): the concrete first step toward
    // same-breath Project assembly — a real, deterministic signal that
    // turned out not to exist in stored data despite the
    // infrastructure (captureId) already flowing through the whole
    // processing pipeline. This is the honest prerequisite, not the
    // whole design.
    if (url.pathname === "/debug/init-capture-id-column" && request.method === "POST") {
      try {
        await env.OFFICE_DB.prepare("ALTER TABLE job_scopes ADD COLUMN capture_id INTEGER").run();
        return Response.json({ status: "ok", added: true });
      } catch (err) {
        return Response.json({ status: "ok", added: false, note: "column likely already exists", detail: err instanceof Error ? err.message : String(err) });
      }
    }

    // Real feature 2026-07-22 — Layer 2 (Project), same-breath
    // assembly. The first, fully-specified piece of the design pinned
    // in DECISIONS.md, built directly on the Fable 5 design pass
    // (verified and corrected the same night) and tonight's own
    // capture_id prerequisite.
    if (url.pathname === "/debug/init-projects" && request.method === "POST") {
      await env.OFFICE_DB.prepare(
        `CREATE TABLE IF NOT EXISTS projects (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          customer_id INTEGER,
          description TEXT,
          source_transcript TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )`
      ).run();
      try {
        await env.OFFICE_DB.prepare("ALTER TABLE job_scopes ADD COLUMN project_id INTEGER").run();
      } catch (err) {
        // Likely already exists — safe to re-run.
      }
      return Response.json({ status: "ok" });
    }

    // Real feature 2026-07-22 — Layer 2 (Project): the real, missing
    // link back to the job scope a quotation or invoice was actually
    // priced from, closing the exact gap the Fable 5 design review
    // correctly identified in the Layer 2 design pin.
    if (url.pathname === "/debug/init-job-scope-links" && request.method === "POST") {
      try {
        await env.OFFICE_DB.prepare("ALTER TABLE quotations ADD COLUMN job_scope_id INTEGER").run();
      } catch (err) {
        // Likely already exists — safe to re-run.
      }
      try {
        await env.OFFICE_DB.prepare("ALTER TABLE invoices ADD COLUMN job_scope_id INTEGER").run();
      } catch (err) {
        // Same.
      }
      return Response.json({ status: "ok" });
    }

    if (url.pathname === "/debug/projects" && request.method === "GET") {
      const { results: projects } = await env.OFFICE_DB.prepare(
        `SELECT p.id, p.customer_id, c.name as customer_name, p.description, p.created_at
         FROM projects p
         LEFT JOIN customers c ON c.id = p.customer_id
         ORDER BY p.created_at DESC LIMIT 10`
      ).all();
      const enriched = await Promise.all(
        (projects as Array<{ id: number }>).map(async (project) => {
          const { results: jobScopes } = await env.OFFICE_DB.prepare(
            "SELECT id, description, capture_id, created_at FROM job_scopes WHERE project_id = ?"
          )
            .bind(project.id)
            .all();
          // Real, deterministic total — every quotation and invoice
          // linked, through its real job_scope_id, to a job scope that
          // belongs to this project. The actual point of this whole
          // feature: a project can now show its real, total quoted
          // and invoiced value, not just a label on some measurements.
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
          return {
            ...project,
            totalQuoted: totalQuoted?.total ?? 0,
            totalInvoiced: totalInvoiced?.total ?? 0,
            jobScopes,
          };
        })
      );
      return Response.json({ projects: enriched });
    }

    // Real feature 2026-07-21 — closing a real, verified gap: tasks
    // only ever had open/done, no due time at all. Same
    // scheduled_date_raw/scheduled_date pattern already proven for
    // job_scopes, reused here rather than inventing a new one.
    if (url.pathname === "/debug/init-task-due-date-columns" && request.method === "POST") {
      try {
        await env.OFFICE_DB.prepare("ALTER TABLE tasks ADD COLUMN due_date_raw TEXT").run();
      } catch (err) {
        // Likely already exists — continue to the second column
        // regardless, since each ALTER is independent.
      }
      try {
        await env.OFFICE_DB.prepare("ALTER TABLE tasks ADD COLUMN due_date TEXT").run();
      } catch (err) {
        // Same — safe to re-run.
      }
      return Response.json({ status: "ok" });
    }

    // Real feature 2026-07-21 — closing a real, known gap with real,
    // concrete evidence behind it (Zululand Flooring genuinely
    // operates with VAT for some clients, not others), not
    // speculative. A customer's own standing exempt status now
    // overrides the business-wide VAT default entirely for their
    // documents.
    if (url.pathname === "/debug/init-vat-exempt-column" && request.method === "POST") {
      try {
        await env.OFFICE_DB.prepare("ALTER TABLE customers ADD COLUMN vat_exempt INTEGER NOT NULL DEFAULT 0").run();
        return Response.json({ status: "ok", added: true });
      } catch (err) {
        return Response.json({ status: "ok", added: false, note: "column likely already exists", detail: err instanceof Error ? err.message : String(err) });
      }
    }

    // Real feature 2026-07-21 — a real, urgent need: an active
    // two-year contract in its final stage, needing historical
    // reconciliation soon. A customer's real, standing retention
    // rate, plus the real, computed withheld amount stored on every
    // invoice it applies to.
    if (url.pathname === "/debug/init-retention-columns" && request.method === "POST") {
      try {
        await env.OFFICE_DB.prepare("ALTER TABLE customers ADD COLUMN retention_percent REAL").run();
      } catch (err) {
        // Likely already exists — continue regardless, each ALTER is
        // independent.
      }
      try {
        await env.OFFICE_DB.prepare("ALTER TABLE invoices ADD COLUMN retention_percent REAL").run();
      } catch (err) {
        // Same — safe to re-run.
      }
      try {
        await env.OFFICE_DB.prepare("ALTER TABLE invoices ADD COLUMN retention_amount REAL NOT NULL DEFAULT 0").run();
      } catch (err) {
        // Same.
      }
      return Response.json({ status: "ok" });
    }

    // Real feature 2026-07-21 — Purchase Orders, the first stage of
    // the real, three-way PO/GRN/Supplier Invoice design already
    // pinned in DECISIONS.md, built incrementally. supplier_id
    // references characters (suppliers), never customers — the same
    // isolation already proven for every other supplier relationship
    // in this project.
    if (url.pathname === "/debug/init-purchase-orders" && request.method === "POST") {
      await env.OFFICE_DB.prepare(
        `CREATE TABLE IF NOT EXISTS purchase_orders (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          supplier_id INTEGER,
          description TEXT NOT NULL,
          source_transcript TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )`
      ).run();
      await env.OFFICE_DB.prepare(
        `CREATE TABLE IF NOT EXISTS po_line_items (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          purchase_order_id INTEGER NOT NULL,
          description TEXT NOT NULL,
          quantity_ordered REAL NOT NULL,
          unit TEXT,
          unit_price_expected REAL
        )`
      ).run();
      return Response.json({ status: "ok" });
    }

    if (url.pathname === "/debug/purchase-orders" && request.method === "GET") {
      const { results: orders } = await env.OFFICE_DB.prepare(
        `SELECT po.id, po.supplier_id, ch.name as supplier_name, po.description, po.created_at
         FROM purchase_orders po
         LEFT JOIN characters ch ON ch.id = po.supplier_id
         ORDER BY po.created_at DESC LIMIT 10`
      ).all();
      const enriched = await Promise.all(
        (orders as Array<{ id: number }>).map(async (order) => {
          const { results: lineItems } = await env.OFFICE_DB.prepare(
            "SELECT id, description, quantity_ordered, unit, unit_price_expected FROM po_line_items WHERE purchase_order_id = ?"
          )
            .bind(order.id)
            .all();
          // Real feature 2026-07-21 — the document-completeness
          // status pinned earlier tonight, built directly from that
          // design: computed live from real counts, the same
          // "compute on read" discipline already chosen for
          // partial-GRN status, not a new pattern. A delivery note
          // and a supplier invoice genuinely arrive separately far
          // more often than together — this status is the real,
          // visible answer to "which one, if either, are we still
          // waiting on."
          const grnCount = await env.OFFICE_DB.prepare(
            "SELECT COUNT(*) as count FROM goods_received_notes WHERE purchase_order_id = ?"
          )
            .bind(order.id)
            .first<{ count: number }>();
          const invoiceCount = await env.OFFICE_DB.prepare(
            "SELECT COUNT(*) as count FROM supplier_invoices WHERE purchase_order_id = ?"
          )
            .bind(order.id)
            .first<{ count: number }>();
          const hasDeliveryNote = (grnCount?.count ?? 0) > 0;
          const hasSupplierInvoice = (invoiceCount?.count ?? 0) > 0;
          const documentStatus = hasSupplierInvoice
            ? "closed"
            : hasDeliveryNote
            ? "delivery note received, awaiting invoice"
            : "ordered, awaiting delivery";
          return { ...order, documentStatus, hasDeliveryNote, hasSupplierInvoice, lineItems };
        })
      );
      return Response.json({ purchaseOrders: enriched });
    }

    // Real feature 2026-07-21 — Goods Received Notes, the second
    // stage of the real, three-way PO/GRN/Supplier Invoice design
    // pinned in DECISIONS.md.
    if (url.pathname === "/debug/init-goods-received" && request.method === "POST") {
      await env.OFFICE_DB.prepare(
        `CREATE TABLE IF NOT EXISTS goods_received_notes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          purchase_order_id INTEGER NOT NULL,
          supplier_id INTEGER,
          source_transcript TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )`
      ).run();
      await env.OFFICE_DB.prepare(
        `CREATE TABLE IF NOT EXISTS grn_line_items (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          grn_id INTEGER NOT NULL,
          po_line_item_id INTEGER,
          description TEXT NOT NULL,
          quantity_received REAL NOT NULL,
          quantity_ordered REAL,
          variance REAL
        )`
      ).run();
      return Response.json({ status: "ok" });
    }

    // Real feature 2026-07-21 — a separate migration since the table
    // already exists from earlier tonight; CREATE TABLE IF NOT EXISTS
    // alone won't add a new column to a table that's already there.
    // Real design decision: who actually recorded a delivery is now a
    // real, permanent, traceable fact.
    if (url.pathname === "/debug/init-grn-recorded-by" && request.method === "POST") {
      try {
        await env.OFFICE_DB.prepare("ALTER TABLE goods_received_notes ADD COLUMN recorded_by TEXT").run();
        return Response.json({ status: "ok", added: true });
      } catch (err) {
        return Response.json({ status: "ok", added: false, note: "column likely already exists", detail: err instanceof Error ? err.message : String(err) });
      }
    }

    if (url.pathname === "/debug/goods-received" && request.method === "GET") {
      const { results: grns } = await env.OFFICE_DB.prepare(
        `SELECT g.id, g.purchase_order_id, g.supplier_id, ch.name as supplier_name, g.recorded_by, g.created_at
         FROM goods_received_notes g
         LEFT JOIN characters ch ON ch.id = g.supplier_id
         ORDER BY g.created_at DESC LIMIT 10`
      ).all();
      const enriched = await Promise.all(
        (grns as Array<{ id: number }>).map(async (grn) => {
          const { results: lineItems } = await env.OFFICE_DB.prepare(
            "SELECT id, description, quantity_received, quantity_ordered, variance FROM grn_line_items WHERE grn_id = ?"
          )
            .bind(grn.id)
            .all();
          return { ...grn, lineItems };
        })
      );
      return Response.json({ goodsReceivedNotes: enriched });
    }

    // Real feature 2026-07-21 — Supplier Invoices, the third and
    // final stage of the real, three-way PO/GRN/Supplier Invoice
    // design pinned in DECISIONS.md.
    if (url.pathname === "/debug/init-supplier-invoices" && request.method === "POST") {
      await env.OFFICE_DB.prepare(
        `CREATE TABLE IF NOT EXISTS supplier_invoices (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          purchase_order_id INTEGER,
          supplier_id INTEGER,
          supplier_reference TEXT,
          amount REAL NOT NULL,
          source_transcript TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )`
      ).run();
      await env.OFFICE_DB.prepare(
        `CREATE TABLE IF NOT EXISTS supplier_invoice_line_items (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          supplier_invoice_id INTEGER NOT NULL,
          po_line_item_id INTEGER,
          description TEXT NOT NULL,
          quantity_billed REAL NOT NULL,
          unit_price_billed REAL,
          quantity_variance REAL,
          price_variance REAL,
          line_total REAL NOT NULL
        )`
      ).run();
      return Response.json({ status: "ok" });
    }

    if (url.pathname === "/debug/supplier-invoices" && request.method === "GET") {
      const { results: invoices } = await env.OFFICE_DB.prepare(
        `SELECT si.id, si.purchase_order_id, si.supplier_id, ch.name as supplier_name, si.supplier_reference, si.amount, si.created_at
         FROM supplier_invoices si
         LEFT JOIN characters ch ON ch.id = si.supplier_id
         ORDER BY si.created_at DESC LIMIT 10`
      ).all();
      const enriched = await Promise.all(
        (invoices as Array<{ id: number }>).map(async (invoice) => {
          const { results: lineItems } = await env.OFFICE_DB.prepare(
            "SELECT id, description, quantity_billed, unit_price_billed, quantity_variance, price_variance, line_total FROM supplier_invoice_line_items WHERE supplier_invoice_id = ?"
          )
            .bind(invoice.id)
            .all();
          return { ...invoice, lineItems };
        })
      );
      return Response.json({ supplierInvoices: enriched });
    }

    // Real fix 2026-07-21 — closing a real gap found incidentally
    // during PDF extraction testing: every PDF generator has always
    // expected a real business_profile row (id=1), and none ever
    // existed — every generated document silently showed "[Business
    // name not set]" instead. No route existed anywhere to actually
    // set it. A real UPSERT, keyed on the fixed singleton id every
    // other query already assumes.
    if (url.pathname === "/debug/business-profile" && request.method === "GET") {
      const profile = await env.OFFICE_DB.prepare("SELECT * FROM business_profile WHERE id = 1").first();
      return Response.json({ profile: profile ?? null });
    }

    if (url.pathname === "/debug/business-profile" && request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as {
        name?: string;
        trading_as?: string;
        vat_no?: string;
        address?: string;
        phone?: string;
        email?: string;
        banking_details?: string;
        vat_registered?: boolean;
        vat_rate?: number;
      };
      if (!body.name) {
        return Response.json({ error: "name is required" }, { status: 400 });
      }
      // Real safety net: business_profile has no tracked CREATE
      // statement anywhere in this codebase (same situation as
      // line_items) — this makes the route work correctly whether or
      // not the table already exists from an earlier manual migration.
      await env.OFFICE_DB.prepare(
        `CREATE TABLE IF NOT EXISTS business_profile (
          id INTEGER PRIMARY KEY,
          name TEXT,
          trading_as TEXT,
          vat_no TEXT,
          address TEXT,
          phone TEXT,
          email TEXT,
          banking_details TEXT,
          vat_registered INTEGER NOT NULL DEFAULT 0,
          vat_rate REAL NOT NULL DEFAULT 15
        )`
      ).run();
      await env.OFFICE_DB.prepare(
        `INSERT INTO business_profile (id, name, trading_as, vat_no, address, phone, email, banking_details, vat_registered, vat_rate)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name, trading_as = excluded.trading_as, vat_no = excluded.vat_no,
           address = excluded.address, phone = excluded.phone, email = excluded.email,
           banking_details = excluded.banking_details, vat_registered = excluded.vat_registered,
           vat_rate = excluded.vat_rate`
      )
        .bind(
          body.name,
          body.trading_as ?? null,
          body.vat_no ?? null,
          body.address ?? null,
          body.phone ?? null,
          body.email ?? null,
          body.banking_details ?? null,
          body.vat_registered ? 1 : 0,
          body.vat_rate ?? 15
        )
        .run();
      const saved = await env.OFFICE_DB.prepare("SELECT * FROM business_profile WHERE id = 1").first();
      return Response.json({ status: "saved", profile: saved });
    }

    if (url.pathname === "/debug/memberships" && request.method === "GET") {
      const { results } = await env.OFFICE_DB.prepare("SELECT * FROM memberships ORDER BY created_at DESC").all();
      const enriched = results.map((m) => ({ ...m, capabilities: ROLE_CAPABILITIES[String(m.role)] ?? [] }));
      return Response.json({ memberships: enriched });
    }

    // Real, manual seed route until OAuth exists to create memberships
    // naturally through a real invite flow. Deliberately simple —
    // this is scaffolding to prove the schema and role map work, not
    // the real invite UX (which needs a real signed-in owner to
    // trigger it, matching the "Invite Sarah as our accountant"
    // conversational flow already designed, not yet built).
    if (url.pathname === "/debug/create-membership" && request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as { google_email?: string; role?: string };
      if (!body.google_email || !body.role) {
        return Response.json({ error: "google_email and role are both required" }, { status: 400 });
      }
      if (!ROLE_CAPABILITIES[body.role]) {
        return Response.json(
          { error: `unknown role "${body.role}" — defined roles are: ${Object.keys(ROLE_CAPABILITIES).join(", ")}` },
          { status: 400 }
        );
      }
      try {
        const inserted = await env.OFFICE_DB.prepare(
          "INSERT INTO memberships (google_email, role) VALUES (?, ?) RETURNING id"
        )
          .bind(body.google_email, body.role)
          .first<{ id: number }>();
        return Response.json({
          status: "created",
          id: inserted!.id,
          google_email: body.google_email,
          role: body.role,
          capabilities: ROLE_CAPABILITIES[body.role],
        });
      } catch (err) {
        return Response.json(
          { error: err instanceof Error ? err.message : String(err) },
          { status: 409 }
        );
      }
    }

    // Real, needed now: a placeholder email used for early schema
    // testing needs correcting to a real, working Google account.
    if (url.pathname === "/debug/delete-membership" && request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as { google_email?: string };
      if (!body.google_email) return Response.json({ error: "google_email is required" }, { status: 400 });
      const result = await env.OFFICE_DB.prepare("DELETE FROM memberships WHERE google_email = ?")
        .bind(body.google_email)
        .run();
      return Response.json({ status: "deleted", google_email: body.google_email, changes: result.meta.changes });
    }

    if (url.pathname === "/debug/character-facts" && request.method === "GET") {
      const characterId = url.searchParams.get("characterId");
      const query = characterId
        ? env.OFFICE_DB.prepare(
            "SELECT cf.id, cf.character_id, ch.name as character_name, cf.key, cf.value, cf.created_at FROM character_facts cf JOIN characters ch ON ch.id = cf.character_id WHERE cf.character_id = ? ORDER BY cf.created_at DESC"
          ).bind(Number(characterId))
        : env.OFFICE_DB.prepare(
            "SELECT cf.id, cf.character_id, ch.name as character_name, cf.key, cf.value, cf.created_at FROM character_facts cf JOIN characters ch ON ch.id = cf.character_id ORDER BY cf.created_at DESC LIMIT 30"
          );
      const { results } = await query.all();
      return Response.json({ facts: results });
    }

    if (url.pathname === "/debug/expenses" && request.method === "GET") {
      const { results } = await env.OFFICE_DB.prepare(
        `SELECT e.id, e.amount, e.description, e.category, e.character_id, c.name as supplier_name,
                e.customer_id, cu.name as job_name, e.created_at
         FROM expenses e
         LEFT JOIN characters c ON c.id = e.character_id
         LEFT JOIN customers cu ON cu.id = e.customer_id
         ORDER BY e.created_at DESC LIMIT 30`
      ).all();
      return Response.json({ expenses: results });
    }

    if (url.pathname === "/debug/tasks" && request.method === "GET") {
      const { results } = await env.OFFICE_DB.prepare(
        "SELECT id, description, done, customer_id, character_id, created_at, completed_at FROM tasks ORDER BY created_at DESC LIMIT 30"
      ).all();
      return Response.json({ tasks: results });
    }

    // The execution register's schema — see OFFICE_CONSTITUTION.md
    // Principle 16. Generic key/value on purpose: a future selection
    // type (quotation, invoice, task, a future department) never
    // needs a schema migration, just a new key.
    if (url.pathname === "/debug/init-selections-table" && request.method === "POST") {
      await env.OFFICE_DB.prepare(
        `CREATE TABLE IF NOT EXISTS selections (
          key TEXT PRIMARY KEY,
          entity_id INTEGER NOT NULL,
          label TEXT NOT NULL,
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )`
      ).run();
      return Response.json({ status: "ok" });
    }

    if (url.pathname === "/debug/selections" && request.method === "GET") {
      const { results } = await env.OFFICE_DB.prepare(
        "SELECT key, entity_id, label, updated_at FROM selections ORDER BY updated_at DESC"
      ).all();
      return Response.json({ selections: results });
    }

    // Direct, tappable completion — no natural-language matching
    // needed. This is the real endpoint a future "tap to complete"
    // ember list would call.
    if (url.pathname.match(/^\/debug\/complete-task\/\d+$/) && request.method === "POST") {
      const id = Number(url.pathname.split("/")[3]);
      await completeTask(env, id);
      return Response.json({ status: "completed", id });
    }

    // Inspect a given day's life events directly — defaults to today.
    if (url.pathname === "/debug/life-events" && request.method === "GET") {
      const date = url.searchParams.get("date") ?? new Date().toISOString().slice(0, 10);
      const raw = await env.CUSTOMER_NOTES.get(`life:${date}`);
      return Response.json({ date, raw: raw ? JSON.parse(raw) : null });
    }

    if (url.pathname === "/debug/memory-errors" && request.method === "GET") {
      const { results } = await env.OFFICE_DB.prepare(
        "SELECT id, customer_id, text, error, created_at FROM memory_errors ORDER BY created_at DESC LIMIT 20"
      ).all();
      return Response.json({ errors: results });
    }

    if (url.pathname === "/debug/memory-health" && request.method === "GET") {
      try {
        const info = await env.MEMORY.describe();
        const processedAt = new Date((info as { processedUpToDatetime: string }).processedUpToDatetime);
        const gapSeconds = (Date.now() - processedAt.getTime()) / 1000;
        return Response.json({
          vectorCount: (info as { vectorCount: number }).vectorCount,
          processedUpToDatetime: (info as { processedUpToDatetime: string }).processedUpToDatetime,
          gapSeconds,
          likelyStuck: gapSeconds > 120,
        });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
      }
    }

    if (url.pathname === "/debug/stress-memory" && request.method === "GET") {
      const count = Number(url.searchParams.get("count") ?? "20");
      try {
        const before = await env.MEMORY.describe();
        const writes = Array.from({ length: count }, (_, i) =>
          storeUnscopedMemory(env, `stress test entry number ${i} at ${Date.now()}`)
        );
        await Promise.all(writes);
        const after = await env.MEMORY.describe();
        return Response.json({
          requested: count,
          before: { vectorCount: (before as { vectorCount: number }).vectorCount, processedUpToDatetime: (before as { processedUpToDatetime: string }).processedUpToDatetime },
          after: { vectorCount: (after as { vectorCount: number }).vectorCount, processedUpToDatetime: (after as { processedUpToDatetime: string }).processedUpToDatetime },
        });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
      }
    }

    if (url.pathname === "/debug/rerank-raw" && request.method === "GET") {
      const query = url.searchParams.get("query") ?? "what is Jenny's address?";
      const customerId = url.searchParams.get("customerId") ?? "1";
      try {
        const vector = await embedText(env, query);
        const vecResults = await env.MEMORY.query(vector, {
          topK: 8,
          returnMetadata: true,
          filter: { customerId },
        });
        const candidates = (vecResults.matches ?? [])
          .map((m) => (m.metadata as { text?: string } | undefined)?.text)
          .filter((t): t is string => !!t);

        const rerankResult = await env.AI.run("@cf/baai/bge-reranker-base", {
          query,
          contexts: candidates.map((text) => ({ text })),
        });

        return Response.json({ query, candidates, rerankResultRaw: rerankResult });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
      }
    }

    // Manual trigger for the same job the hourly cron runs — lets us
    // test consolidation and schema-candidate detection today instead
    // of waiting for the clock.
    if (url.pathname === "/admin/flush-memory" && request.method === "POST") {
      const result = await runConsolidation(env);
      return Response.json(result);
    }

    if (url.pathname === "/debug/pdf-route-test" && request.method === "GET") {
      return Response.json({ ok: true, note: "this trivial route works" });
    }

    if (url.pathname.match(/^\/invoices\/\d+\/pdf$/) && request.method === "GET") {
      const invoiceId = Number(url.pathname.split("/")[2]);
      try {
        const pdfBytes = await generateDocumentPdf(env, invoiceId, "invoice");
        return new Response(pdfBytes, {
          headers: {
            "Content-Type": "application/pdf",
            "Content-Disposition": `inline; filename="invoice-${invoiceId}.pdf"`,
          },
        });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
      }
    }

    // Quotations never had a PDF route at all until now — found live
    // 2026-07-10 when asked for a real quotation document that simply
    // didn't exist yet, despite quotations having worked correctly
    // end to end (price_scope, plain quotations, line items) all
    // along. Same generator as invoices, just the other document type.
    if (url.pathname.match(/^\/quotations\/\d+\/pdf$/) && request.method === "GET") {
      const quotationId = Number(url.pathname.split("/")[2]);
      try {
        const pdfBytes = await generateDocumentPdf(env, quotationId, "quotation");
        return new Response(pdfBytes, {
          headers: {
            "Content-Type": "application/pdf",
            "Content-Disposition": `inline; filename="quotation-${quotationId}.pdf"`,
          },
        });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
      }
    }

    // Real feature 2026-07-12 — the first exportable report beyond a
    // single quotation/invoice, per the accounting-capability roadmap.
    // Real chronological transaction history with a real running
    // balance, same PDF pattern as invoices/quotations.
    if (url.pathname.match(/^\/customers\/\d+\/statement\/pdf$/) && request.method === "GET") {
      const customerId = Number(url.pathname.split("/")[2]);
      try {
        const pdfBytes = await generateStatementPdf(env, customerId);
        return new Response(pdfBytes, {
          headers: {
            "Content-Type": "application/pdf",
            "Content-Disposition": `inline; filename="statement-${customerId}.pdf"`,
          },
        });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
      }
    }

    // Real feature 2026-07-12 — the aged debtors report, exportable.
    // Real FIFO allocation, disclosed directly on the page since
    // payments aren't linked to a specific invoice in this schema.
    if (url.pathname === "/reports/aged-debtors/pdf" && request.method === "GET") {
      try {
        const pdfBytes = await generateAgedDebtorsPdf(env);
        return new Response(pdfBytes, {
          headers: {
            "Content-Type": "application/pdf",
            "Content-Disposition": `inline; filename="aged-debtors.pdf"`,
          },
        });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
      }
    }

    // Real feature 2026-07-12 — the final report of the accounting-
    // capability roadmap. A formal, business-wide profit and loss,
    // built entirely from real data already sitting in real tables.
    if (url.pathname === "/reports/profit-and-loss/pdf" && request.method === "GET") {
      try {
        const pdfBytes = await generateProfitAndLossPdf(env);
        return new Response(pdfBytes, {
          headers: {
            "Content-Type": "application/pdf",
            "Content-Disposition": `inline; filename="profit-and-loss.pdf"`,
          },
        });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
      }
    }

    // Regression smoke test — zero side effects, tests extraction
    // classification alone (the piece that's actually broken most
    // often today), not the full write pipeline. Safe to rerun after
    // every future change without polluting KV or D1 with test data,
    // the exact mistake that broke retrieval twice yesterday.
    if (url.pathname === "/debug/smoke-test" && request.method === "GET") {
      const cases: Array<{ name: string; text: string; check: (e: Extraction | null) => boolean }> = [
        {
          name: "mixed customer+personal message splits correctly",
          text: "heading to jenny's job now, remind me to get dog food after",
          check: (e) => e?.customer_name?.toLowerCase() === "jenny" && !!e?.personal_note,
        },
        {
          name: "self-directed question classifies as personal lookup",
          text: "what do I need to do today?",
          check: (e) => e?.intent === "lookup" && e?.query_scope === "personal",
        },
        {
          name: "business financial question classifies as business lookup",
          text: "who owes me money?",
          check: (e) => e?.intent === "lookup" && e?.query_scope === "business",
        },
        {
          name: "plain customer lookup classifies correctly",
          text: "what is Jenny's address?",
          check: (e) => e?.intent === "lookup" && e?.query_scope === "customer",
        },
        {
          name: "payment classifies correctly, not invoice",
          text: "Jenny paid R500",
          check: (e) => e?.intent === "payment",
        },
        {
          name: "invoice classifies correctly, not payment",
          text: "we invoiced Jenny R2000 for materials",
          check: (e) => e?.intent === "invoice",
        },
        {
          name: "quotation classifies correctly, not invoice",
          text: "we quoted Jenny R6000 for the new blinds",
          check: (e) => e?.intent === "quotation",
        },
        {
          name: "convert_quote classifies correctly with deposit percent",
          text: "we completed Jenny's installation, she paid an 80% deposit, convert the quote to an invoice for the remaining balance",
          check: (e) => e?.intent === "convert_quote" && e?.deposit_percent === 80,
        },
        {
          name: "work_observation classifies correctly, no price stated",
          text: "Dwayne is a new customer, I measured the reception area at 6600 by 4100 for vinyl flooring, we also need repair work",
          check: (e) => e?.intent === "work_observation" && e?.amount === null,
        },
        {
          name: "price_scope classifies correctly, distinct from a plain quotation",
          text: "price up Dwayne's job, R450 a square meter for the reception area and office, flat R3500 for the repair work",
          check: (e) => e?.intent === "price_scope" && e?.scope_document_type === "quotation",
        },
        {
          name: "price_scope recognizes invoice framing, not just quotation",
          text: "invoice out Dwayne's job, R450 a square meter for the reception area and office, the job's already done",
          check: (e) => e?.intent === "price_scope" && e?.scope_document_type === "invoice",
        },
        {
          name: "a stated fact is not misread as a question",
          text: "jenny lives at 5 Ocean View, Eshowe",
          check: (e) => e?.intent !== "lookup",
        },
        {
          name: "a personal relation is classified as a character, not a customer",
          text: "picked up my wife from work, she's annoyed about the kitchen guy not showing",
          check: (e) => e?.character_name === "wife" && !e?.customer_name,
        },
        {
          name: "a supplier is classified as a character (not billed), and the real subject wins over an incidental customer mention",
          text: "ProSupply was late delivering the tiles for Jenny's job back in March, held us up by four days",
          check: (e) => e?.character_name === "ProSupply" && !e?.customer_name,
        },
        {
          name: "a named staff contact at a supplier doesn't fork off its own entity",
          text: "called ProSupply about the March delay, spoke to Sarah in dispatch, she was really rude about it",
          check: (e) => e?.character_name === "ProSupply",
        },
        {
          name: "task_complete is distinct from reminder by tense — done now, not later",
          text: "got the dog food",
          check: (e) => e?.intent === "task_complete",
        },
        {
          name: "bare pronoun-only completions still count as task_complete, not note",
          text: "called them",
          check: (e) => e?.intent === "task_complete",
        },
        {
          name: "expense (money out, to a supplier) is distinct from payment (money in, from a customer)",
          text: "bought glue for R850 at BUCO",
          check: (e) => e?.intent === "expense" && e?.character_name === "BUCO" && e?.customer_name === null,
        },
        {
          name: "expense job-cost linking: customer_name means which job, never who to bill",
          text: "bought glue for R850 at BUCO for Jenny's job",
          check: (e) => e?.intent === "expense" && e?.character_name === "BUCO" && e?.customer_name === "Jenny",
        },
      ];

      // Sequential, not Promise.all — real bug found live 2026-07-11:
      // as this suite grew to 17 cases, running them all concurrently
      // started tripping Workers AI's capacity limit ("3040: Capacity
      // temporarily exceeded"), which never happened at 11-14 cases.
      // A regression suite that fails on its own load isn't reliable;
      // sequential execution is slower but actually trustworthy.
      const results: Array<{ name: string; input: string; pass: boolean; extraction: Extraction | null; rawOnFailure?: unknown }> = [];
      for (const c of cases) {
        const { extraction, raw } = await extractIntent(env, c.text);
        results.push({ name: c.name, input: c.text, pass: c.check(extraction), extraction, rawOnFailure: extraction ? undefined : raw });
      }

      return Response.json({ allPassed: results.every((r) => r.pass), results });
    }

    if (url.pathname === "/debug/rewrite-thinking-test" && request.method === "GET") {
      const historyText =
        "Peter: we quoted Sarah Bennett R8000 for tiling the bathroom\n" +
        "Office: Quotation noted for Sarah Bennett of R8000 (1 line item) — needs your confirmation (action #9) before it's recorded.\n" +
        "Peter: jenny paid R500\n" +
        "Office: Payment noted for Jenny Hawke of R500 — needs your confirmation (action #10) before it's recorded.";
      const message = "whats her balance?";
      const systemPrompt =
        "Rewrite the new message to be fully self-contained, replacing any pronouns or vague " +
        "references (her, him, that, it, the invoice, etc.) with the specific name or thing they " +
        "refer to, using the conversation history for context. When more than one person or thing " +
        "could match, ALWAYS resolve to whichever was mentioned MOST RECENTLY in the history, never " +
        "whichever was mentioned most often — recency wins over frequency, always. Do NOT answer " +
        "the message, add new information, or change its type — a question must stay phrased as a " +
        "question, a statement stays a statement. Only resolve what the ambiguous words refer to. " +
        "If the message is already self-contained, return it completely unchanged. Return ONLY the " +
        "rewritten message, nothing else — no explanation, no quotes.\n\nConversation history:\n" +
        historyText;

      const runOnce = async (thinking: boolean) => {
        const result = await env.AI.run("@cf/moonshotai/kimi-k2.6", {
          chat_template_kwargs: { thinking },
          temperature: 0,
          max_tokens: thinking ? 600 : undefined,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: message },
          ],
        });
        const r = result as { choices?: Array<{ message?: { content?: string; reasoning_content?: string } }> };
        return {
          content: r.choices?.[0]?.message?.content ?? null,
          reasoning: r.choices?.[0]?.message?.reasoning_content ?? null,
        };
      };

      const [thinkingOff, thinkingOn] = await Promise.all([runOnce(false), runOnce(true)]);
      return Response.json({ thinkingOff, thinkingOn });
    }

    if (url.pathname === "/debug/characters" && request.method === "GET") {
      const { results: characters } = await env.OFFICE_DB.prepare(
        "SELECT id, name, relationship, created_at FROM characters ORDER BY created_at DESC LIMIT 20"
      ).all<{ id: number; name: string; relationship: string | null; created_at: string }>();

      const enriched = await Promise.all(
        characters.map(async (c) => ({ ...c, notes: await getCharacterNotes(env, c.id) }))
      );

      return Response.json({ characters: enriched });
    }

    // Real diagnostic 2026-07-12 — isolating whether a name-lookup
    // bug lives in the lookup function itself or downstream in how
    // the result gets used, without going through the whole
    // extraction pipeline.
    // Real diagnostic 2026-07-13 — seeing exactly what the multi-
    // intent split produced for a real message, without guessing.
    if (url.pathname === "/debug/split-topics" && request.method === "POST") {
      const body = (await request.json()) as { text?: string };
      if (!body.text) return Response.json({ error: "missing text" }, { status: 400 });
      const items = await extractMultipleIntents(env, body.text);
      return Response.json({
        segments: items.map((i) => ({ segment: i.segment, extraction: i.extraction })),
      });
    }

    if (url.pathname === "/debug/find-character" && request.method === "GET") {
      const name = url.searchParams.get("name") ?? "";
      const found = await findExistingCharacterByName(env, name);
      if (!found) return Response.json({ name, found });
      const characterFacts = await getCharacterNotes(env, found.id);
      const hrFacts = await getCharacterFacts(env, found.id);
      const installerActivity = await getInstallerActivity(env, found.id);
      return Response.json({ name, found, characterFacts, hrFacts, installerActivity });
    }

    if (url.pathname === "/debug/find-customer" && request.method === "GET") {
      const name = url.searchParams.get("name") ?? "";
      const found = await findExistingCustomerByName(env, name);
      return Response.json({ name, found });
    }

    // Real diagnostic 2026-07-13 — the exact live schema for a table,
    // via SQLite's own authoritative source, before writing any
    // migration that touches a constraint. Guessing at a schema from
    // memory of the code that reads it is exactly how a table
    // recreation migration could silently lose a real column.
    if (url.pathname === "/debug/table-schema" && request.method === "GET") {
      const table = url.searchParams.get("table") ?? "";
      const { results } = await env.OFFICE_DB.prepare(`PRAGMA table_info(${table})`).all();
      return Response.json({ table, columns: results });
    }

    // Real feature 2026-07-14 — step 1 of the phased auth scope
    // (Constitution Principles 25-27): real Google sign-in on the
    // existing instance. Google verifies who someone is; this Worker
    // only ever trusts an ID token it has independently verified with
    // Google itself, never anything the client claims on its own.
    if (url.pathname === "/auth/google/login" && request.method === "GET") {
      const state = base64UrlEncode(crypto.getRandomValues(new Uint8Array(24)));
      const redirectUri = `${url.origin}/auth/google/callback`;
      const googleUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      googleUrl.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
      googleUrl.searchParams.set("redirect_uri", redirectUri);
      googleUrl.searchParams.set("response_type", "code");
      googleUrl.searchParams.set("scope", "openid email profile");
      googleUrl.searchParams.set("state", state);
      return new Response(null, {
        status: 302,
        headers: {
          Location: googleUrl.toString(),
          // Short-lived, HttpOnly — real CSRF protection, compared
          // against Google's own returned state on the callback.
          "Set-Cookie": `oauth_state=${state}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`,
        },
      });
    }

    if (url.pathname === "/auth/google/callback" && request.method === "GET") {
      const code = url.searchParams.get("code");
      const returnedState = url.searchParams.get("state");
      const expectedState = getCookie(request, "oauth_state");
      if (!code || !returnedState || !expectedState || returnedState !== expectedState) {
        return Response.json({ error: "invalid or missing OAuth state — possible CSRF, or the login link expired" }, { status: 400 });
      }

      const redirectUri = `${url.origin}/auth/google/callback`;
      const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: env.GOOGLE_CLIENT_ID,
          client_secret: env.GOOGLE_CLIENT_SECRET,
          redirect_uri: redirectUri,
          grant_type: "authorization_code",
        }),
      });
      if (!tokenRes.ok) {
        return Response.json({ error: "token exchange with Google failed", detail: await tokenRes.text() }, { status: 502 });
      }
      const tokenData = (await tokenRes.json()) as { id_token?: string };
      if (!tokenData.id_token) {
        return Response.json({ error: "Google did not return an ID token" }, { status: 502 });
      }

      // Never trust a decoded JWT payload on its own — verify it
      // against Google directly, the same distrust-by-default
      // discipline this system applies everywhere else.
      const verifyRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${tokenData.id_token}`);
      if (!verifyRes.ok) {
        return Response.json({ error: "Google could not verify the ID token" }, { status: 502 });
      }
      const claims = (await verifyRes.json()) as { email?: string; email_verified?: string; aud?: string };
      if (claims.aud !== env.GOOGLE_CLIENT_ID) {
        return Response.json({ error: "token audience mismatch — refusing to trust it" }, { status: 401 });
      }
      if (claims.email_verified !== "true" || !claims.email) {
        return Response.json({ error: "Google account email is not verified" }, { status: 401 });
      }

      const membership = await env.OFFICE_DB.prepare("SELECT * FROM memberships WHERE google_email = ?")
        .bind(claims.email)
        .first<{ id: number; google_email: string; role: string; status: string }>();

      if (!membership || membership.status !== "active") {
        return Response.json(
          { error: "no active membership for this Google account", email: claims.email },
          { status: 403 }
        );
      }

      const sessionToken = await signSession(env, claims.email);
      return Response.json(
        { status: "signed in", email: claims.email, role: membership.role },
        {
          headers: {
            "Set-Cookie": `office_session=${sessionToken}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`,
          },
        }
      );
    }

    if (url.pathname === "/auth/me" && request.method === "GET") {
      const session = await verifySession(env, getCookie(request, "office_session"));
      if (!session) return Response.json({ signedIn: false });
      const membership = await env.OFFICE_DB.prepare("SELECT * FROM memberships WHERE google_email = ?")
        .bind(session.email)
        .first<{ role: string; status: string }>();
      return Response.json({ signedIn: true, email: session.email, role: membership?.role ?? null });
    }

    if (url.pathname === "/auth/logout" && request.method === "POST") {
      return new Response(null, {
        status: 200,
        headers: { "Set-Cookie": "office_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0" },
      });
    }

    // Real admin tooling 2026-07-13 — genuine, reusable capability,
    // not a one-off debug hack. The minimal, immediate protection
    // layer (a real admin key, checked here) before the full
    // Google-auth system exists — a deletion capability this
    // consequential can't wait for that larger build to be safe.
    if (url.pathname.startsWith("/admin/")) {
      const providedKey = request.headers.get("X-Admin-Key");
      if (!providedKey || providedKey !== env.ADMIN_KEY) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
    }

    // Real testing tool 2026-07-14 — admin-gated, since minting a
    // valid session for any email is real access, not a cosmetic
    // debug convenience. Needed precisely because a real membership
    // (like the sipho.test placeholder) doesn't necessarily have a
    // real, controllable Google account to actually sign in with —
    // this lets that membership's real, restricted behavior be
    // genuinely verified end to end anyway.
    if (url.pathname === "/admin/mint-session" && request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as { google_email?: string };
      if (!body.google_email) return Response.json({ error: "google_email is required" }, { status: 400 });
      const sessionToken = await signSession(env, body.google_email);
      return Response.json(
        { status: "minted", google_email: body.google_email },
        { headers: { "Set-Cookie": `office_session=${sessionToken}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000` } }
      );
    }

    // Real tables discovered from the actual live schema, never a
    // manually-typed list — the exact discipline that caught the
    // job_scopes migration issue earlier tonight, applied here so a
    // real table is never silently missed from export or flush.
    async function getRealTableNames(): Promise<string[]> {
      const { results } = await env.OFFICE_DB.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%'"
      ).all<{ name: string }>();
      return results.map((r) => r.name);
    }

    // A genuine safety snapshot before anything irreversible happens
    // — costs nothing to have, even if never needed.
    // Real fix found live 2026-07-14, twice over: the first fix only
    // wrapped the per-table loop in a try/catch, but
    // getRealTableNames() itself — the very first call, discovering
    // which tables exist — was completely unprotected. If that
    // specific query throws for any reason, the whole thing still
    // crashes exactly as before. Wrapping the entire handler this
    // time, not just part of it, so a real, visible error comes back
    // no matter where the actual failure is, instead of another
    // blind guess at the exact cause.
    if (url.pathname === "/admin/export" && request.method === "GET") {
      try {
        const tables = await getRealTableNames();
        const snapshot: Record<string, unknown[] | { error: string }> = {};
        for (const table of tables) {
          try {
            const { results } = await env.OFFICE_DB.prepare(`SELECT * FROM "${table}"`).all();
            snapshot[table] = results;
          } catch (err) {
            snapshot[table] = { error: err instanceof Error ? err.message : String(err) };
          }
        }
        return Response.json({ exportedAt: new Date().toISOString(), tables: snapshot });
      } catch (err) {
        return Response.json(
          { error: "export failed", detail: err instanceof Error ? err.message : String(err) },
          { status: 500 }
        );
      }
    }

    // Real, guarded deletion — the same two-factor discipline guard()
    // already applies to money and identity, now applied to erasure:
    // both a real admin key AND an explicit, exact confirmation
    // phrase are required, so this can never fire by accident. Clears
    // D1 (every real table, dynamically discovered), KV (customer and
    // character notes, life events), and R2 (every uploaded file) —
    // a genuine, complete flush, not a partial one that leaves real
    // data quietly behind.
    // Real fix applied before ever running this live 2026-07-14: the
    // export route's first fix only protected part of its code path
    // and missed the actual point of failure — applying that lesson
    // here before flush ever runs for real, since it's irreversible
    // and a partial, unclear failure state here would be a genuinely
    // worse outcome than the same class of bug in export was.
    if (url.pathname === "/admin/flush" && request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as { confirm?: string };
      if (body.confirm !== "DELETE ALL DATA") {
        return Response.json(
          { error: 'missing or incorrect confirmation — send {"confirm": "DELETE ALL DATA"}' },
          { status: 400 }
        );
      }

      try {
        // Real fix found live 2026-07-14: customers failed with a
        // genuine foreign key constraint violation, because tables
        // were cleared in whatever order the schema happened to list
        // them, not dependency order — customers was deleted before
        // the child rows (invoices, tasks, job_scopes, and more)
        // still pointing at it, and SQLite correctly refused. Fixed
        // by disabling foreign key enforcement for the duration of
        // the flush, rather than maintaining a fragile, hardcoded
        // dependency order that would silently go stale the next time
        // a new table gets added.
        await env.OFFICE_DB.prepare("PRAGMA foreign_keys = OFF").run();

        const tables = await getRealTableNames();
        const deletedCounts: Record<string, number | { error: string }> = {};
        for (const table of tables) {
          try {
            const countRow = await env.OFFICE_DB.prepare(`SELECT COUNT(*) as n FROM "${table}"`).first<{ n: number }>();
            deletedCounts[table] = countRow?.n ?? 0;
            await env.OFFICE_DB.prepare(`DELETE FROM "${table}"`).run();
          } catch (err) {
            deletedCounts[table] = { error: err instanceof Error ? err.message : String(err) };
          }
        }

        await env.OFFICE_DB.prepare("PRAGMA foreign_keys = ON").run();

        // KV has no bulk-clear operation — list every real key, delete
        // each one explicitly.
        let kvKeysDeleted = 0;
        let kvError: string | null = null;
        try {
          let cursor: string | undefined;
          do {
            const listed = await env.CUSTOMER_NOTES.list({ cursor });
            for (const key of listed.keys) {
              await env.CUSTOMER_NOTES.delete(key.name);
              kvKeysDeleted++;
            }
            cursor = listed.list_complete ? undefined : listed.cursor;
          } while (cursor);
        } catch (err) {
          kvError = err instanceof Error ? err.message : String(err);
        }

        // Same for R2 — every real uploaded file, not just the D1
        // records that reference them.
        let r2ObjectsDeleted = 0;
        let r2Error: string | null = null;
        try {
          let r2Cursor: string | undefined;
          do {
            const listed = await env.OFFICE_VAULT.list({ cursor: r2Cursor });
            for (const obj of listed.objects) {
              await env.OFFICE_VAULT.delete(obj.key);
              r2ObjectsDeleted++;
            }
            r2Cursor = listed.truncated ? listed.cursor : undefined;
          } while (r2Cursor);
        } catch (err) {
          r2Error = err instanceof Error ? err.message : String(err);
        }

        return Response.json({
          status: "flushed",
          flushedAt: new Date().toISOString(),
          d1RowsDeleted: deletedCounts,
          kvKeysDeleted,
          kvError,
          r2ObjectsDeleted,
          r2Error,
        });
      } catch (err) {
        return Response.json(
          { error: "flush failed", detail: err instanceof Error ? err.message : String(err) },
          { status: 500 }
        );
      }
    }

    // Real, careful migration 2026-07-13 — relaxing job_scopes.
    // customer_id's NOT NULL constraint, the confirmed real cause of
    // a live crash (a job with a real installer but no yet-known
    // customer must be recordable, not silently dropped nor crashing
    // outright). SQLite cannot relax a NOT NULL constraint via a
    // simple ALTER — this recreates the table with every real column
    // preserved exactly, verified first against the live schema via
    // /debug/table-schema rather than reconstructed from memory of
    // the code that reads it. IDs are preserved exactly (explicit
    // column list, not SELECT *) since job_scopes.id is referenced by
    // scope_components and scope_tasks. Idempotent: if the migration
    // already ran, job_scopes_new won't exist to conflict with, and
    // this can be safely re-run.
    if (url.pathname === "/debug/migrate-jobscopes-nullable-customer" && request.method === "POST") {
      try {
        await env.OFFICE_DB.batch([
          env.OFFICE_DB.prepare(
            `CREATE TABLE job_scopes_new (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              customer_id INTEGER,
              description TEXT NOT NULL,
              scheduled_date_raw TEXT,
              source_transcript TEXT,
              created_at TEXT DEFAULT (datetime('now')),
              scheduled_date TEXT,
              installer_id INTEGER
            )`
          ),
          env.OFFICE_DB.prepare(
            `INSERT INTO job_scopes_new (id, customer_id, description, scheduled_date_raw, source_transcript, created_at, scheduled_date, installer_id)
             SELECT id, customer_id, description, scheduled_date_raw, source_transcript, created_at, scheduled_date, installer_id FROM job_scopes`
          ),
          env.OFFICE_DB.prepare("DROP TABLE job_scopes"),
          env.OFFICE_DB.prepare("ALTER TABLE job_scopes_new RENAME TO job_scopes"),
        ]);
        return Response.json({ status: "ok" });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
      }
    }

    // One-time schema migration for the new real, queryable date —
    // scheduled_date_raw has always been a free phrase; this is the
    // actual resolved calendar date. Same idempotent ALTER pattern as
    // every other schema-init route here.
    if (url.pathname === "/debug/init-job-scopes-date" && request.method === "POST") {
      try {
        await env.OFFICE_DB.prepare("ALTER TABLE job_scopes ADD COLUMN scheduled_date TEXT").run();
      } catch {
        // Already exists — fine, that's what makes this idempotent.
      }
      return Response.json({ status: "ok" });
    }

    if (url.pathname === "/debug/job-scopes" && request.method === "GET") {
      const { results: scopes } = await env.OFFICE_DB.prepare(
        `SELECT js.id, js.customer_id, c.name as customer_name, js.description, js.scheduled_date_raw,
                js.scheduled_date, js.installer_id, ch.name as installer_name, js.created_at, js.capture_id
         FROM job_scopes js
         LEFT JOIN customers c ON c.id = js.customer_id
         LEFT JOIN characters ch ON ch.id = js.installer_id
         ORDER BY js.created_at DESC LIMIT 10`
      ).all();

      const enriched = await Promise.all(
        (scopes as Array<{ id: number }>).map(async (scope) => {
          const { results: components } = await env.OFFICE_DB.prepare(
            "SELECT name, width_mm, length_mm, area_sqm FROM scope_components WHERE job_scope_id = ?"
          )
            .bind(scope.id)
            .all();
          const { results: tasks } = await env.OFFICE_DB.prepare(
            "SELECT description, component_id FROM scope_tasks WHERE job_scope_id = ?"
          )
            .bind(scope.id)
            .all();
          return { ...scope, components, tasks };
        })
      );

      return Response.json({ jobScopes: enriched });
    }

    // The actual calendar query — real, queryable dates, no cron
    // snapshot, no pre-computed briefing. Computed live, on request,
    // same "smallest honest version" discipline already applied to
    // the weekly-briefing gap. Defaults to the next 14 days.
    if (url.pathname === "/debug/schedule" && request.method === "GET") {
      const days = Number(url.searchParams.get("days") ?? "14");
      const today = nowInBusinessTimezone();
      const pad = (n: number) => String(n).padStart(2, "0");
      const todayIso = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
      const until = new Date(today);
      until.setDate(until.getDate() + days);
      const untilIso = `${until.getFullYear()}-${pad(until.getMonth() + 1)}-${pad(until.getDate())}`;

      const { results } = await env.OFFICE_DB.prepare(
        `SELECT js.id, c.name as customer_name, js.description, js.scheduled_date, js.scheduled_date_raw
         FROM job_scopes js JOIN customers c ON c.id = js.customer_id
         WHERE js.scheduled_date IS NOT NULL AND js.scheduled_date BETWEEN ? AND ?
         ORDER BY js.scheduled_date ASC`
      )
        .bind(todayIso, untilIso)
        .all();

      return Response.json({ from: todayIso, to: untilIso, schedule: results });
    }

    // Real feature 2026-07-21 — the actual, urgent need behind this
    // whole feature: reconciling retention withheld across an active,
    // two-year contract now in its final stage. Real, deterministic
    // totals — every figure summed directly from stored, real
    // invoices, never estimated.
    if (url.pathname === "/debug/retention-summary" && request.method === "GET") {
      const customerId = url.searchParams.get("customerId");
      if (!customerId) {
        return Response.json({ error: "customerId query parameter is required" }, { status: 400 });
      }
      const { results } = await env.OFFICE_DB.prepare(
        `SELECT id, description, amount, retention_percent, retention_amount, created_at
         FROM invoices WHERE customer_id = ? AND retention_amount > 0 ORDER BY created_at ASC`
      )
        .bind(customerId)
        .all<{ id: number; description: string; amount: number; retention_percent: number; retention_amount: number; created_at: string }>();
      const totalRetained = results.reduce((sum, r) => sum + r.retention_amount, 0);
      const totalInvoiced = results.reduce((sum, r) => sum + r.amount, 0);
      return Response.json({
        customerId: Number(customerId),
        invoiceCount: results.length,
        totalInvoiced,
        totalRetained,
        invoices: results,
      });
    }

    if (url.pathname === "/debug/quotations" && request.method === "GET") {
      const { results: quotes } = await env.OFFICE_DB.prepare(
        "SELECT q.id, q.customer_id, c.name as customer_name, q.description, q.amount, q.status, q.created_at FROM quotations q JOIN customers c ON c.id = q.customer_id ORDER BY q.created_at DESC LIMIT 10"
      ).all();

      const enriched = await Promise.all(
        (quotes as Array<{ id: number }>).map(async (quote) => {
          const { results: lineItems } = await env.OFFICE_DB.prepare(
            "SELECT description, note, quantity, unit, unit_price, line_total, discount_percent FROM line_items WHERE quotation_id = ?"
          )
            .bind(quote.id)
            .all();
          return { ...quote, lineItems };
        })
      );

      return Response.json({ quotations: enriched });
    }

    if (url.pathname === "/debug/invoices" && request.method === "GET") {
      const { results: invoices } = await env.OFFICE_DB.prepare(
        "SELECT i.id, i.customer_id, c.name as customer_name, i.description, i.amount, i.status, i.quotation_id, i.created_at FROM invoices i JOIN customers c ON c.id = i.customer_id ORDER BY i.created_at DESC LIMIT 10"
      ).all();

      const enriched = await Promise.all(
        (invoices as Array<{ id: number }>).map(async (invoice) => {
          const { results: lineItems } = await env.OFFICE_DB.prepare(
            "SELECT description, note, quantity, unit, unit_price, line_total, discount_percent FROM line_items WHERE invoice_id = ?"
          )
            .bind(invoice.id)
            .all();
          return { ...invoice, lineItems };
        })
      );

      return Response.json({ invoices: enriched });
    }

    // One-time schema migration for the real captures FK columns —
    // real fix 2026-07-11, closing the gap named since day one
    // ("subject_hint is a loose text string, not a real foreign
    // key"). SQLite's ADD COLUMN has no IF NOT EXISTS, so each is
    // wrapped individually to stay safe to call more than once, same
    // as every other schema-init route here.
    if (url.pathname === "/debug/init-captures-fk" && request.method === "POST") {
      for (const column of ["customer_id INTEGER", "character_id INTEGER"]) {
        try {
          await env.OFFICE_DB.prepare(`ALTER TABLE captures ADD COLUMN ${column}`).run();
        } catch {
          // Already exists — fine, that's what makes this idempotent.
        }
      }
      return Response.json({ status: "ok" });
    }

    if (url.pathname === "/debug/captures" && request.method === "GET") {
      const status = url.searchParams.get("status");
      const customerId = url.searchParams.get("customerId");
      const characterId = url.searchParams.get("characterId");
      const columns = "id, raw_text, source, subject_hint, customer_id, character_id, extraction_status, r2_key, created_at";
      let results;
      if (customerId) {
        // The actual clean join this gap was about — no more fuzzy
        // text matching on subject_hint needed.
        ({ results } = await env.OFFICE_DB.prepare(
          `SELECT ${columns} FROM captures WHERE customer_id = ? ORDER BY created_at DESC LIMIT 50`
        )
          .bind(customerId)
          .all());
      } else if (characterId) {
        ({ results } = await env.OFFICE_DB.prepare(
          `SELECT ${columns} FROM captures WHERE character_id = ? ORDER BY created_at DESC LIMIT 50`
        )
          .bind(characterId)
          .all());
      } else if (status) {
        ({ results } = await env.OFFICE_DB.prepare(
          `SELECT ${columns} FROM captures WHERE extraction_status = ? ORDER BY created_at DESC LIMIT 50`
        )
          .bind(status)
          .all());
      } else {
        ({ results } = await env.OFFICE_DB.prepare(`SELECT ${columns} FROM captures ORDER BY created_at DESC LIMIT 20`).all());
      }
      return Response.json({ captures: results });
    }

    // --- end debug routes ---

    // List everything still waiting on a human decision.
    if (url.pathname === "/actions/pending" && request.method === "GET") {
      const { results } = await env.OFFICE_DB.prepare(
        "SELECT id, type, payload, source_transcript, created_at FROM pending_actions WHERE status = 'pending' ORDER BY created_at DESC"
      ).all();
      return Response.json({ pending: results });
    }

    if (url.pathname.match(/^\/actions\/\d+\/confirm$/) && request.method === "POST") {
      try {
        const id = Number(url.pathname.split("/")[2]);
        const action = await env.OFFICE_DB.prepare(
          "SELECT id, type, payload, source_transcript, status FROM pending_actions WHERE id = ?"
        )
          .bind(id)
          .first<{ id: number; type: string; payload: string; source_transcript: string; status: string }>();

        if (!action) return Response.json({ error: "no such pending action" }, { status: 404 });
        if (action.status !== "pending") {
          return Response.json({ error: `action already ${action.status}` }, { status: 409 });
        }

        if (action.type === "payment") {
          const payload = JSON.parse(action.payload) as { customerId: number; amount: number | null };
          const payment = await recordPayment(env, payload.customerId, payload.amount, action.source_transcript);
          await env.OFFICE_DB.prepare(
            "UPDATE pending_actions SET status = 'confirmed', resolved_at = datetime('now') WHERE id = ?"
          )
            .bind(id)
            .run();
          return Response.json({ status: "confirmed", payment });
        }

        if (action.type === "expense") {
          const payload = JSON.parse(action.payload) as {
            characterId: number | null;
            characterName?: string;
            customerId: number | null;
            customerName?: string;
            amount: number | null;
            description: string;
          };
          const expense = await recordExpense(
            env,
            payload.characterId,
            payload.amount,
            payload.description,
            action.source_transcript,
            payload.customerId
          );
          await env.OFFICE_DB.prepare(
            "UPDATE pending_actions SET status = 'confirmed', resolved_at = datetime('now') WHERE id = ?"
          )
            .bind(id)
            .run();
          return Response.json({ status: "confirmed", expense });
        }

        // Real feature 2026-07-21 — Goods Received Notes, the second
        // stage of the real, three-way PO/GRN/Supplier Invoice design
        // pinned in DECISIONS.md. The real point of confirming this:
        // a real, deterministic quantity variance, computed in
        // recordGoodsReceived, returned here so Peter sees it
        // immediately, not buried in a debug route.
        if (action.type === "goods_received") {
          const payload = JSON.parse(action.payload) as {
            purchaseOrderId: number;
            supplierId: number | null;
            supplierName?: string;
            lineItems: Array<{ matched_description: string | null; quantity_received: number }>;
          };
          // Real design decision 2026-07-21 — GRN capture stays open
          // to anyone in the organisation on purpose (quantity-only,
          // no money involved), but who actually recorded it is a
          // real, permanent fact, not an anonymous action.
          const { email: recordedByEmail } = await resolveCapabilities(request, env);
          const recorded = await recordGoodsReceived(
            env,
            payload.purchaseOrderId,
            payload.supplierId,
            action.source_transcript,
            payload.lineItems,
            recordedByEmail
          );
          await env.OFFICE_DB.prepare(
            "UPDATE pending_actions SET status = 'confirmed', resolved_at = datetime('now') WHERE id = ?"
          )
            .bind(id)
            .run();
          return Response.json({ status: "confirmed", goodsReceived: recorded });
        }

        // Real feature 2026-07-21 — Supplier Invoices, the third and
        // final stage of the real, three-way PO/GRN/Supplier Invoice
        // design pinned in DECISIONS.md. Creates a real expense here,
        // on confirmation, and returns both real, computed
        // reconciliations — quantity and price — directly, not buried
        // in a debug route.
        if (action.type === "supplier_invoice") {
          const payload = JSON.parse(action.payload) as {
            purchaseOrderId: number | null;
            supplierId: number | null;
            supplierName?: string;
            supplierReference: string | null;
            lineItems: Array<{ matched_description: string | null; quantity_billed: number; unit_price_billed: number | null }>;
          };
          const recorded = await recordSupplierInvoice(
            env,
            payload.purchaseOrderId,
            payload.supplierId,
            payload.supplierReference,
            action.source_transcript,
            payload.lineItems
          );
          await env.OFFICE_DB.prepare(
            "UPDATE pending_actions SET status = 'confirmed', resolved_at = datetime('now') WHERE id = ?"
          )
            .bind(id)
            .run();
          return Response.json({ status: "confirmed", supplierInvoice: recorded });
        }

        if (action.type === "invoice") {
          const payload = JSON.parse(action.payload) as {
            customerId: number;
            customerName?: string;
            description: string;
            amount: number;
            lineItems?: LineItemWithTotal[];
            jobScopeId?: number | null;
          };
          const invoice = await recordInvoice(
            env,
            payload.customerId,
            payload.description,
            payload.amount,
            action.source_transcript,
            payload.lineItems ?? [],
            payload.jobScopeId ?? null
          );
          await env.OFFICE_DB.prepare(
            "UPDATE pending_actions SET status = 'confirmed', resolved_at = datetime('now') WHERE id = ?"
          )
            .bind(id)
            .run();
          const { pdfUrl, shareMessage } = await buildDocumentResponse(
            env,
            url.origin,
            "invoice",
            invoice.id,
            payload.customerName,
            invoice.amount
          );
          return Response.json({ status: "confirmed", invoice, pdfUrl, shareMessage });
        }

        if (action.type === "quotation") {
          const payload = JSON.parse(action.payload) as {
            customerId: number;
            customerName?: string;
            description: string;
            amount: number;
            lineItems?: LineItemWithTotal[];
            jobScopeId?: number | null;
          };
          const quotation = await recordQuotation(
            env,
            payload.customerId,
            payload.description,
            payload.amount,
            action.source_transcript,
            payload.lineItems ?? [],
            payload.jobScopeId ?? null
          );
          await env.OFFICE_DB.prepare(
            "UPDATE pending_actions SET status = 'confirmed', resolved_at = datetime('now') WHERE id = ?"
          )
            .bind(id)
            .run();
          const { pdfUrl, shareMessage } = await buildDocumentResponse(
            env,
            url.origin,
            "quotation",
            quotation.id,
            payload.customerName,
            quotation.amount
          );
          return Response.json({ status: "confirmed", quotation, pdfUrl, shareMessage });
        }

        if (action.type === "convert_quote") {
          const payload = JSON.parse(action.payload) as {
            quotationId: number;
            customerId: number;
            customerName?: string;
            description: string;
            remainingBalance: number;
          };
          const result = await convertQuoteToInvoice(
            env,
            payload.quotationId,
            payload.customerId,
            payload.description,
            payload.remainingBalance,
            action.source_transcript
          );
          await env.OFFICE_DB.prepare(
            "UPDATE pending_actions SET status = 'confirmed', resolved_at = datetime('now') WHERE id = ?"
          )
            .bind(id)
            .run();
          // This path produces a real invoice too — often the more
          // meaningful message of the three ("your job is done, here's
          // the final balance") — same shared helper as the other two,
          // since it reports the same KIND of result (a document).
          const { pdfUrl, shareMessage } = await buildDocumentResponse(
            env,
            url.origin,
            "invoice",
            result.invoiceId,
            payload.customerName,
            payload.remainingBalance
          );
          return Response.json({ status: "confirmed", invoice: result, pdfUrl, shareMessage });
        }

        if (action.type === "customer_fact") {
          const payload = JSON.parse(action.payload) as {
            customerId: number;
            key: string;
            value: string;
          };
          await applyStructuredFact(env, payload.customerId, payload.key, payload.value, action.source_transcript);
          await env.OFFICE_DB.prepare(
            "UPDATE pending_actions SET status = 'confirmed', resolved_at = datetime('now') WHERE id = ?"
          )
            .bind(id)
            .run();
          return Response.json({ status: "confirmed", key: payload.key, value: payload.value });
        }

        if (action.type === "character_fact") {
          const payload = JSON.parse(action.payload) as {
            characterId: number;
            key: string;
            value: string;
          };
          await applyCharacterFact(env, payload.characterId, payload.key, payload.value, action.source_transcript);
          await env.OFFICE_DB.prepare(
            "UPDATE pending_actions SET status = 'confirmed', resolved_at = datetime('now') WHERE id = ?"
          )
            .bind(id)
            .run();
          return Response.json({ status: "confirmed", key: payload.key, value: payload.value });
        }

        if (action.type === "schema_candidate") {
          // Acknowledged only — this never runs a migration itself. The
          // actual ALTER TABLE / CREATE TABLE stays a deliberate, manual
          // step, the same way it has been all day.
          await env.OFFICE_DB.prepare(
            "UPDATE pending_actions SET status = 'confirmed', resolved_at = datetime('now') WHERE id = ?"
          )
            .bind(id)
            .run();
          return Response.json({
            status: "acknowledged",
            note: "No migration was run. Add the column or table yourself when ready.",
            payload: JSON.parse(action.payload),
          });
        }

        return Response.json({ error: `unknown pending action type: ${action.type}` }, { status: 400 });
      } catch (err) {
        // This handler never had error handling wrapped around it at
        // all — an uncaught exception here just produced Cloudflare's
        // generic crash page, with no way to see what actually broke.
        return Response.json(
          { error: "confirm handler threw", detail: err instanceof Error ? err.message : String(err) },
          { status: 500 }
        );
      }
    }

    if (url.pathname.match(/^\/actions\/\d+\/reject$/) && request.method === "POST") {
      const id = Number(url.pathname.split("/")[2]);
      await env.OFFICE_DB.prepare(
        "UPDATE pending_actions SET status = 'rejected', resolved_at = datetime('now') WHERE id = ? AND status = 'pending'"
      )
        .bind(id)
        .run();
      return Response.json({ status: "rejected", id });
    }

    // "Talk" mode. Full pipeline: store audio, transcribe, extract,
    // reconcile, guard, remember.
    if (url.pathname === "/files/audio" && request.method === "POST") {
      const formData = await request.formData();
      const audio = formData.get("audio");
      const historyRaw = formData.get("history");
      let history: HistoryTurn[] = [];
      if (typeof historyRaw === "string") {
        try {
          history = JSON.parse(historyRaw);
        } catch {
          history = [];
        }
      }

      if (!(audio instanceof File)) {
        return Response.json({ error: "missing audio file" }, { status: 400 });
      }

      const audioBuffer = await audio.arrayBuffer();
      const key = `voice-notes/${Date.now()}-${crypto.randomUUID()}.m4a`;

      const [, { transcript, transcriptionError }] = await Promise.all([
        env.OFFICE_VAULT.put(key, audioBuffer),
        transcribe(env, audioBuffer),
      ]);

      // Real feature 2026-07-17 — extending Principle 26 to the last
      // real, live entry point that didn't have it: voice upload was
      // still using the default (full-access) capabilities, unlike
      // /messages/text, which already resolves the real session.
      const { capabilities: voiceCapabilities } = await resolveCapabilities(request, env);
      const processed = transcript
        ? await processTranscript(env, transcript, ctx, history, "voice", key, voiceCapabilities)
        : {
            extraction: null,
            extractionRaw: null,
            extractionRawText: null,
            customer: null,
            pendingActionId: null,
            factPendingActionId: null,
            message: "Voice note received (transcription unavailable).",
            rewrittenQuery: "",
          };

      return Response.json({ status: "stored", key, transcript, transcriptionError, ...processed });
    }

    // Photo capture. The raw image itself is what was actually
    // captured — same role a transcript plays for voice — so the
    // capture row and its real R2 key exist the instant it arrives,
    // before Kimi's vision description ever runs.
    // The third "sense" alongside voice and photos — a supplier
    // quote, an existing invoice, a scanned form. Same receptacle-
    // first discipline: the raw file is stored reliably before any
    // understanding is attempted, mirroring /files/photo exactly.
    // Honest limitation, not silently overclaimed: an image gets the
    // same real vision description photos already get; a genuine PDF
    // is captured and stored reliably but its text isn't extracted
    // yet — no PDF-parsing capability exists in this environment
    // today, and pdf-lib (already a dependency) is a generation/
    // manipulation library, not a text-extraction one. Named as a
    // real, explicit gap rather than pretended solved.
    if (url.pathname === "/files/document" && request.method === "POST") {
      const formData = await request.formData();
      const document = formData.get("document");
      const caption = formData.get("caption");

      if (!(document instanceof File)) {
        return Response.json({ error: "missing document file" }, { status: 400 });
      }

      const docBuffer = await document.arrayBuffer();
      const mimeType = document.type || "application/octet-stream";
      const isImage = mimeType.startsWith("image/");
      const isPdf = mimeType === "application/pdf";
      const extension = isPdf ? "pdf" : mimeType.includes("png") ? "png" : mimeType.includes("jpeg") || mimeType.includes("jpg") ? "jpg" : "bin";
      const key = `documents/${Date.now()}-${crypto.randomUUID()}.${extension}`;

      await env.OFFICE_VAULT.put(key, docBuffer);
      const captureId = await logCapture(env, "[document — description pending]", "document", key);

      let description: string;
      if (isImage) {
        const base64 = arrayBufferToBase64(docBuffer);
        description = await describeImage(env, base64, mimeType);
      } else if (isPdf) {
        // Real feature 2026-07-19 — replacing unpdf's own wrapper,
        // which failed at runtime with "Serverless PDF.js bundle
        // could not be resolved" despite type-checking and bundling
        // cleanly — a genuinely runtime-only failure that local
        // type-checking couldn't have caught. Using pdfjs-serverless
        // directly instead, the lower-level package unpdf itself
        // wraps, avoiding whatever dynamic resolution step inside
        // unpdf's own layer was failing. Two genuinely different
        // failure modes handled distinctly: a real parse failure
        // (corrupted file) versus a PDF that parses fine but has no
        // real text layer at all (a scanned document with no OCR).
        try {
          const { getDocument } = await resolvePDFJS();
          const doc = await getDocument({ data: new Uint8Array(docBuffer) }).promise;
          const pageTexts: string[] = [];
          for (let i = 1; i <= doc.numPages; i++) {
            const page = await doc.getPage(i);
            const textContent = await page.getTextContent();
            const pageText = textContent.items.map((item) => ("str" in item ? item.str : "")).join(" ");
            pageTexts.push(pageText);
          }
          const trimmed = pageTexts.join("\n").trim();
          description =
            trimmed.length > 0
              ? trimmed
              : `PDF document uploaded (${document.name || "untitled"}) — no extractable text layer found (likely a scanned document with no OCR).`;
        } catch (err) {
          description = `PDF document uploaded (${document.name || "untitled"}, ${docBuffer.byteLength} bytes) — text extraction failed: ${err instanceof Error ? err.message : String(err)}.`;
        }
      } else {
        description = `File uploaded (${document.name || "untitled"}, ${mimeType}, ${docBuffer.byteLength} bytes).`;
      }

      // Same caption-based subject-hint logic as /files/photo, same
      // reasoning: never guess a subject from the file itself, only
      // ever from something actually said about it.
      let subjectHint: string | null = null;
      let subjectCustomerId: number | null = null;
      let subjectCharacterId: number | null = null;
      let rawText = description;
      if (typeof caption === "string" && caption.trim().length > 0) {
        const captionText = caption.trim();
        rawText = `${captionText}\n\n[Document: ${description}]`;
        const { extraction } = await extractIntent(env, captionText);
        if (extraction?.customer_name) {
          const customer = await reconcileCustomer(env, extraction.customer_name);
          subjectHint = customer?.name ?? null;
          subjectCustomerId = customer?.id ?? null;
        } else if (extraction?.character_name) {
          const character = await reconcileCharacter(env, extraction.character_name, extraction.character_relationship);
          subjectHint = character?.name ?? null;
          subjectCharacterId = character?.id ?? null;
        }
      }

      if (captureId !== null) {
        await updateCaptureText(env, captureId, rawText);
        if (subjectHint) {
          await updateCaptureHint(env, captureId, subjectHint, subjectCustomerId, subjectCharacterId);
        }
      }

      // Real feature 2026-07-21 — Supplier Invoices, real document
      // ingestion. A supplier invoice very often arrives as a real
      // PDF, not narrated — the caption naming the supplier is the
      // same trigger already proven above; if that supplier has a
      // real, open PO, the document's own real, extracted text (not
      // the caption) is run through the exact same extraction and
      // guard()'d confirmation as the spoken path.
      let supplierInvoiceAction: { pendingActionId: number; supplierName: string } | null = null;
      if (subjectCharacterId) {
        const openPo = await findLatestOpenPurchaseOrder(env, subjectCharacterId);
        if (openPo) {
          const poLineItems = await getPurchaseOrderLineItems(env, openPo.id);
          const siExtraction = await extractSupplierInvoice(env, description, poLineItems);
          if (siExtraction.line_items.length > 0) {
            const held = await holdForConfirmation(
              env,
              "supplier_invoice",
              {
                purchaseOrderId: openPo.id,
                supplierId: subjectCharacterId,
                supplierName: subjectHint,
                supplierReference: siExtraction.supplier_reference,
                lineItems: siExtraction.line_items,
              },
              rawText
            );
            supplierInvoiceAction = { pendingActionId: held.id, supplierName: subjectHint ?? "supplier" };
          }
        }
      }

      return Response.json({ status: "stored", key, captureId, description, subjectHint, supplierInvoiceAction });
    }

    if (url.pathname === "/files/photo" && request.method === "POST") {
      const formData = await request.formData();
      const photo = formData.get("photo");
      const caption = formData.get("caption");

      if (!(photo instanceof File)) {
        return Response.json({ error: "missing photo file" }, { status: 400 });
      }

      const photoBuffer = await photo.arrayBuffer();
      const mimeType = photo.type || "image/jpeg";
      const extension = mimeType.includes("png") ? "png" : "jpg";
      const key = `photos/${Date.now()}-${crypto.randomUUID()}.${extension}`;

      await env.OFFICE_VAULT.put(key, photoBuffer);
      const captureId = await logCapture(env, "[photo — description pending]", "photo", key);

      const base64 = arrayBufferToBase64(photoBuffer);
      const description = await describeImage(env, base64, mimeType);

      // A caption is optional — never invented, never guessed from the
      // image itself. If given, it's just a spoken or typed sentence
      // like any other, so it reuses the exact same extraction and
      // reconciliation already proven for text and voice, rather than
      // inventing a separate subject-detection path for photos.
      let subjectHint: string | null = null;
      let subjectCustomerId: number | null = null;
      let subjectCharacterId: number | null = null;
      let rawText = description;
      if (typeof caption === "string" && caption.trim().length > 0) {
        const captionText = caption.trim();
        rawText = `${captionText}\n\n[Photo description: ${description}]`;
        const { extraction } = await extractIntent(env, captionText);
        if (extraction?.customer_name) {
          const customer = await reconcileCustomer(env, extraction.customer_name);
          subjectHint = customer?.name ?? null;
          subjectCustomerId = customer?.id ?? null;
        } else if (extraction?.character_name) {
          const character = await reconcileCharacter(env, extraction.character_name, extraction.character_relationship);
          subjectHint = character?.name ?? null;
          subjectCharacterId = character?.id ?? null;
        }
      }

      if (captureId !== null) {
        await updateCaptureText(env, captureId, rawText);
        if (subjectHint) {
          await updateCaptureHint(env, captureId, subjectHint, subjectCustomerId, subjectCharacterId);
        }
      }

      // Real feature 2026-07-21 — Supplier Invoices, real document
      // ingestion. A photo of a paper invoice is just as real a case
      // as an uploaded PDF — same trigger, same guard()'d confirmation.
      let supplierInvoiceAction: { pendingActionId: number; supplierName: string } | null = null;
      if (subjectCharacterId) {
        const openPo = await findLatestOpenPurchaseOrder(env, subjectCharacterId);
        if (openPo) {
          const poLineItems = await getPurchaseOrderLineItems(env, openPo.id);
          const siExtraction = await extractSupplierInvoice(env, description, poLineItems);
          if (siExtraction.line_items.length > 0) {
            const held = await holdForConfirmation(
              env,
              "supplier_invoice",
              {
                purchaseOrderId: openPo.id,
                supplierId: subjectCharacterId,
                supplierName: subjectHint,
                supplierReference: siExtraction.supplier_reference,
                lineItems: siExtraction.line_items,
              },
              rawText
            );
            supplierInvoiceAction = { pendingActionId: held.id, supplierName: subjectHint ?? "supplier" };
          }
        }
      }

      return Response.json({ status: "stored", key, captureId, description, subjectHint, supplierInvoiceAction });
    }

    // Real, permanent production routes — not debug — behind each
    // ember. Tapping one should show the actual real register: what's
    // really open, really scheduled, really outstanding. No Weather
    // route exists because no external weather API exists anywhere
    // in this project yet — deliberately not stubbed.
    if (url.pathname === "/embers/tasks" && request.method === "GET") {
      const openTasks = await getOpenTasks(env);
      return Response.json({ tasks: openTasks });
    }

    if (url.pathname === "/embers/scheduler" && request.method === "GET") {
      const pad = (n: number) => String(n).padStart(2, "0");
      const now = nowInBusinessTimezone();
      const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
      // Real feature 2026-07-24 — connecting the scheduler ember to
      // real project context, the missing link Pierre pointed out
      // directly: scheduling has always been captured correctly on
      // every job scope, but nothing in Layer 2 ever touched it.
      // Added additively — project_id/project_description are new
      // fields alongside the existing ones, so any existing consumer
      // of this route keeps working exactly as before.
      const { results } = await env.OFFICE_DB.prepare(
        `SELECT js.id, js.description, c.name as customer_name, js.project_id, p.description as project_description
         FROM job_scopes js
         JOIN customers c ON c.id = js.customer_id
         LEFT JOIN projects p ON p.id = js.project_id
         WHERE js.scheduled_date = ?`
      )
        .bind(today)
        .all();
      return Response.json({ scheduledToday: results });
    }

    if (url.pathname === "/embers/finance" && request.method === "GET") {
      const { results } = await env.OFFICE_DB.prepare(
        `SELECT c.id, c.name,
                COALESCE(SUM(i.amount), 0) as invoiced,
                COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.customer_id = c.id), 0) as paid
         FROM customers c JOIN invoices i ON i.customer_id = c.id
         GROUP BY c.id HAVING invoiced > paid
         ORDER BY (invoiced - paid) DESC`
      ).all();
      return Response.json({ outstanding: results });
    }

    // Real feature 2026-07-12 — the actual register behind the new
    // expenses ember. Today's real spend, not folded into Finance —
    // opposite direction of money, same as getEmberCounts keeps them
    // separate. Uses the same SAST-computed "today" as every other
    // today query here, not SQLite's own date('now') (which is raw
    // UTC) — that exact inconsistency was already found and fixed
    // once for getCompletedToday; not repeating it here.
    if (url.pathname === "/embers/expenses" && request.method === "GET") {
      const pad = (n: number) => String(n).padStart(2, "0");
      const now = nowInBusinessTimezone();
      const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
      const { results } = await env.OFFICE_DB.prepare(
        `SELECT e.id, e.amount, e.description, e.category, c.name as supplier_name, e.created_at
         FROM expenses e LEFT JOIN characters c ON c.id = e.character_id
         WHERE date(e.created_at) = ?
         ORDER BY e.created_at DESC`
      )
        .bind(today)
        .all();
      return Response.json({ todaysExpenses: results });
    }

    // "Type" mode. Same pipeline, no transcription step needed since
    // the text is already text.
    if (url.pathname === "/messages/text" && request.method === "POST") {
      const body = (await request.json()) as { text?: string; history?: HistoryTurn[]; idempotency_key?: string };
      const text = body.text?.trim();
      const history = Array.isArray(body.history) ? body.history : [];
      const idempotencyKey = body.idempotency_key;

      if (!text) {
        return Response.json({ error: "missing text" }, { status: 400 });
      }

      // Real fix — Layer 1, Stage 0 (Constitution Principle 28): retry
      // safety. Found live 2026-07-15 — a request that looked like it
      // had failed to the client (a blank response) had actually kept
      // running server-side and written real data; retrying on the
      // assumption of failure silently duplicated it. Checked before
      // any real work starts, not after, using a stable key the
      // caller reuses across a genuine retry of the same action.
      if (idempotencyKey) {
        const existing = await env.OFFICE_DB.prepare("SELECT status, result FROM idempotency_keys WHERE key = ?")
          .bind(idempotencyKey)
          .first<{ status: string; result: string | null }>();
        if (existing) {
          if (existing.status === "completed" && existing.result) {
            // The exact same result as the original — never
            // reprocessed, whether this is a genuine retry or a
            // duplicate request arriving late.
            return new Response(existing.result, { headers: { "Content-Type": "application/json" } });
          }
          // Still processing — either a genuinely concurrent
          // duplicate, or the original attempt is still running
          // server-side even though the client gave up on it. Never
          // start a second copy of the same work.
          return Response.json(
            {
              status: "still_processing",
              message: "This exact request is already being processed. Wait and check again rather than resubmitting.",
            },
            { status: 409 }
          );
        }
        try {
          // Marked processing BEFORE any real work starts — a
          // genuinely concurrent request with the same key will fail
          // this INSERT on the primary key constraint itself, caught
          // below, rather than both proceeding.
          await env.OFFICE_DB.prepare("INSERT INTO idempotency_keys (key, status) VALUES (?, 'processing')")
            .bind(idempotencyKey)
            .run();
        } catch {
          return Response.json(
            {
              status: "still_processing",
              message: "This exact request is already being processed. Wait and check again rather than resubmitting.",
            },
            { status: 409 }
          );
        }
      }

      const { capabilities } = await resolveCapabilities(request, env);
      const processed = await processTranscript(env, text, ctx, history, "text", null, capabilities);
      const responseBody = JSON.stringify({ status: "processed", transcript: text, ...processed });

      if (idempotencyKey) {
        await env.OFFICE_DB.prepare("UPDATE idempotency_keys SET status = 'completed', result = ? WHERE key = ?")
          .bind(responseBody, idempotencyKey)
          .run();
      }

      return new Response(responseBody, { headers: { "Content-Type": "application/json" } });
    }

    if (url.pathname.startsWith("/files")) {
      return new Response("files: reserved, not yet implemented", { status: 501 });
    }

    return new Response("not found", { status: 404 });
}

// CORS wrapper. Browsers enforce this; native apps and curl never did,
// which is exactly why this was never needed until testing moved to
// the web preview. Allowing all origins is fine here since there's no
// cookie-based auth to protect — every route is either public or will
// get its own real auth later, not relying on origin-checking for
// security.
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const response = await handleRequest(request, env, ctx);
    const newHeaders = new Headers(response.headers);
    for (const [key, value] of Object.entries(CORS_HEADERS)) {
      newHeaders.set(key, value);
    }
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: newHeaders,
    });
  },

  // The real hourly consolidation — same job the manual
  // /admin/flush-memory debug route triggers, running on its own
  // schedule now (see [triggers] in wrangler.toml).
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runConsolidation(env).then(() => undefined));
  },
};

































