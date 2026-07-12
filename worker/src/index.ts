import { Env, Extraction, HistoryTurn, LineItemWithTotal, ProcessResult } from "./types";
import { answerFromMemory, arrayBufferToBase64, classifyBusinessTopic, describeImage, embedText, extractIntent, extractLineItems, extractScopePricing, extractWorkObservation, rerank, resolveFollowUpEntity, storeUnscopedMemory, transcribe } from "./ai";
import { findExistingEntityByName, getCurrentSelection, looksLikeAQuestion, reconcileCharacter, reconcileCustomer, setSelection } from "./identity";
import { completeTask, createTask, getCompletedToday, getEmberCounts, getOpenTasks, getTodaysSchedule, nowInBusinessTimezone, recordWorkObservation, resolveTaskCompletion } from "./scheduler";
import { appendCharacterNote, appendCustomerNote, appendLifeEvent, applyStructuredFact, getCharacterNotes, getCustomerNotes, getRecentLifeEvents, logCapture, runConsolidation, updateCaptureHint, updateCaptureText } from "./memory";
import { buildDocumentResponse, convertQuoteToInvoice, findLatestJobScope, findLatestOpenQuotation, generateAgedDebtorsPdf, generateDocumentPdf, generateStatementPdf, getAgedDebtorsSummary, getCustomerFinancialSummary, getExpenseSummary, getFinancialSnapshot, getJobProfitability, getOutstandingInvoices, getQuotationsSummary, holdForConfirmation, recordExpense, recordInvoice, recordPayment, recordQuotation } from "./finance";

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


async function processTranscript(
  env: Env,
  transcript: string,
  ctx: ExecutionContext,
  history: HistoryTurn[] = [],
  source: string = "text",
  r2Key: string | null = null
): Promise<ProcessResult> {
  const captureId = await logCapture(env, transcript, source, r2Key);

  let extraction: Extraction | null = null;
  let extractionRaw: unknown = null;
  let extractionRawText: string | null = null;
  let customer: { id: number; name: string; matched: boolean } | null = null;
  let character: { id: number; name: string; matched: boolean } | null = null;
  let pendingActionId: number | null = null;

  // Extraction always runs on the real, original words — never a
  // rewritten version. extractIntent already resolves customer_name/
  // character_name directly and reliably for the vast majority of
  // messages, which name who they're about outright.
  const result = await extractIntent(env, transcript);
  extraction = result.extraction;
  extractionRaw = result.raw;
  extractionRawText = result.rawText;

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
      const found = await findExistingEntityByName(env, extraction.customer_name);
      if (found?.type === "customer") {
        customer = { id: found.id, name: found.name, matched: true };
      }
    } else {
      customer = await reconcileCustomer(env, extraction.customer_name);
    }
  }

  if (extraction?.character_name) {
    if (extraction.intent === "lookup") {
      const found = await findExistingEntityByName(env, extraction.character_name);
      if (found?.type === "character") {
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
      const jobScope = await findLatestJobScope(env, customer.id);
      if (!jobScope) {
        priceScopeNotFound = true;
      } else {
        const pricedItems = await extractScopePricing(env, transcript, jobScope.components, jobScope.tasks);
        quotationLineItems = pricedItems.map((item) => {
          const component = item.matched_name
            ? jobScope.components.find((c) => c.name.toLowerCase() === item.matched_name!.toLowerCase())
            : undefined;
          // The only real arithmetic in this whole step — rate x real
          // measured area — always happens here, in code. The model's
          // job was only ever matching a name and recognizing whether
          // the stated rate was per-sqm or flat.
          if (item.pricing_type === "per_sqm" && component?.area_sqm != null) {
            const lineTotal = Math.round(component.area_sqm * item.rate * 100) / 100;
            return {
              description: component.name,
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
    } else {
      const rawLineItems = await extractLineItems(env, transcript);
      // Line total is always computed here, in code — never asked of
      // the model. Same discipline as every rand figure all day.
      quotationLineItems = rawLineItems.map((item) => ({
        ...item,
        line_total: item.quantity * item.unit_price,
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
  if (extraction?.intent === "work_observation" && customer) {
    const observation = await extractWorkObservation(env, transcript);
    const recorded = await recordWorkObservation(env, customer.id, observation, transcript);
    workObservationResult = {
      jobScopeId: recorded.jobScopeId,
      componentCount: observation.components.length,
      taskCount: observation.tasks.length,
    };
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
    ctx.waitUntil(createTask(env, extraction.personal_note ?? transcript, customer?.id ?? null, character?.id ?? null));
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
  if (!isQuestion && !isPersonalErrand) {
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
    message = `Job scope #${jobScopeId} recorded for ${customer!.name}${parts.length ? ` — ${parts.join(", ")}` : ""}.`;
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
      const outstandingFacts = topic === "quotations" || topic === "expenses" ? [] : await getOutstandingInvoices(env);
      const quotationFacts = topic === "invoices" || topic === "expenses" ? [] : await getQuotationsSummary(env);
      const expenseFacts = topic === "quotations" || topic === "invoices" ? [] : await getExpenseSummary(env);
      // Real feature 2026-07-12: the combined snapshot (reading both
      // revenue and expenses) only for genuinely general questions —
      // a topic-specific follow-up about just quotations, just
      // invoices, or just expenses shouldn't have the combined
      // position dragged in alongside it, same discipline as every
      // other topic exclusion here.
      const snapshotFacts = topic === "general" ? await getFinancialSnapshot(env) : [];
      // Aged debtors is fundamentally about receivables — relevant
      // whenever invoices specifically or the business overall is
      // being asked about, excluded only when the topic is narrowly
      // quotations or expenses.
      const agedFacts = topic === "quotations" || topic === "expenses" ? [] : await getAgedDebtorsSummary(env);
      message = await answerFromMemory(env, transcript, [...outstandingFacts, ...quotationFacts, ...expenseFacts, ...snapshotFacts, ...agedFacts]);
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
      const alreadyAskedForAging = /\b(aged|aging|overdue|breakdown)\b/i.test(transcript);
      if (outstandingFacts.length > 0 && !alreadyAskedForAging && topic !== "quotations" && topic !== "expenses") {
        message += "\n\nA more detailed aged breakdown is also available if useful.";
      }
    } else if (character) {
      const characterFacts = await getCharacterNotes(env, character.id);
      const facts = [`${character.name} is a known contact.`, ...characterFacts];
      message = await answerFromMemory(env, transcript, facts);
    } else if (customer) {
      const memoryFacts = await getCustomerNotes(env, customer.id);
      const financialSummary = await getCustomerFinancialSummary(env, customer.id);
      // Real feature 2026-07-12 — the real payoff of job-cost linking:
      // if any expenses were ever explicitly linked to this customer's
      // job, this surfaces real profitability alongside the balance.
      // Real fix 2026-07-12: the caveat is appended deterministically
      // after synthesis, never handed to the model as a droppable
      // fact — it was reliably stripped out twice in a row when it
      // was.
      const profitability = await getJobProfitability(env, customer.id);
      const facts = [
        `${customer.name} is a known customer.`,
        ...(financialSummary ? [`${customer.name}: ${financialSummary}`] : []),
        ...(profitability ? [`Job profitability for ${customer.name}: ${profitability.fact}`] : []),
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

  const embers = await getEmberCounts(env);
  return { extraction, extractionRaw, extractionRawText, customer, pendingActionId, factPendingActionId, message, rewrittenQuery: transcript, embers };
}

async function handleRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/health") {
      return Response.json({ status: "ok", service: "office-api" });
    }

    if (url.pathname.startsWith("/auth")) {
      return new Response("auth: reserved, not yet implemented", { status: 501 });
    }

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
        "SELECT js.id, js.customer_id, c.name as customer_name, js.description, js.scheduled_date_raw, js.scheduled_date, js.created_at FROM job_scopes js JOIN customers c ON c.id = js.customer_id ORDER BY js.created_at DESC LIMIT 10"
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

    if (url.pathname === "/debug/quotations" && request.method === "GET") {
      const { results: quotes } = await env.OFFICE_DB.prepare(
        "SELECT q.id, q.customer_id, c.name as customer_name, q.description, q.amount, q.status, q.created_at FROM quotations q JOIN customers c ON c.id = q.customer_id ORDER BY q.created_at DESC LIMIT 10"
      ).all();

      const enriched = await Promise.all(
        (quotes as Array<{ id: number }>).map(async (quote) => {
          const { results: lineItems } = await env.OFFICE_DB.prepare(
            "SELECT description, note, quantity, unit, unit_price, line_total FROM line_items WHERE quotation_id = ?"
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
            "SELECT description, note, quantity, unit, unit_price, line_total FROM line_items WHERE invoice_id = ?"
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

        if (action.type === "invoice") {
          const payload = JSON.parse(action.payload) as {
            customerId: number;
            customerName?: string;
            description: string;
            amount: number;
            lineItems?: LineItemWithTotal[];
          };
          const invoice = await recordInvoice(
            env,
            payload.customerId,
            payload.description,
            payload.amount,
            action.source_transcript,
            payload.lineItems ?? []
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
          };
          const quotation = await recordQuotation(
            env,
            payload.customerId,
            payload.description,
            payload.amount,
            action.source_transcript,
            payload.lineItems ?? []
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

      const processed = transcript
        ? await processTranscript(env, transcript, ctx, history, "voice", key)
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
        // Honest placeholder — the file itself is safely stored and
        // fully retrievable (r2Key on the capture, same as any
        // photo), it just isn't searchable by content yet.
        description = `PDF document uploaded (${document.name || "untitled"}, ${docBuffer.byteLength} bytes) — text content not yet extracted.`;
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

      return Response.json({ status: "stored", key, captureId, description, subjectHint });
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

      return Response.json({ status: "stored", key, captureId, description, subjectHint });
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
      const { results } = await env.OFFICE_DB.prepare(
        `SELECT js.id, js.description, c.name as customer_name FROM job_scopes js
         JOIN customers c ON c.id = js.customer_id WHERE js.scheduled_date = ?`
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
      const body = (await request.json()) as { text?: string; history?: HistoryTurn[] };
      const text = body.text?.trim();
      const history = Array.isArray(body.history) ? body.history : [];

      if (!text) {
        return Response.json({ error: "missing text" }, { status: 400 });
      }

      const processed = await processTranscript(env, text, ctx, history, "text");
      return Response.json({ status: "processed", transcript: text, ...processed });
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

































