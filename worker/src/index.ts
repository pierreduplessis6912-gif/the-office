import { Env, Extraction, HistoryTurn, LineItemWithTotal, ProcessResult, WorkObservationExtraction } from "./types";
import { answerFromMemory, arrayBufferToBase64, classifyBusinessTopic, classifyDashboardIntent, containsBackwardReference, describeImage, embedText, extractDocumentIdentity, extractGoodsReceived, extractIntent, extractLead, extractLeadLost, extractLineItems, extractMultipleIntents, extractPurchaseOrder, extractScopePricing, extractSnag, extractSnagResolution, extractStockItemRegistration, extractStockUsage, extractStocktake, extractSupplierInvoice, extractSupplierStatement, extractVarianceDisposition, extractWorkObservation, rerank, resolveFollowUpEntity, splitIntoTopics, storeUnscopedMemory, transcribe, transcribeWithNameHints } from "./ai";
import { listAudit, listPermissions, resetRole, setPermission } from "./permissions";
import { checkCrossRoleCollision, findExistingCharacterByName, findExistingCustomerByName, findExistingEntityByName, getCurrentSelection, logInteractionEdge, looksLikeAQuestion, reconcileCharacter, reconcileCustomer, reconcilePerson, setSelection, withArticle } from "./identity";
import { attachToSiblingJobScope, completeTask, createTask, getCompletedToday, getEmberCounts, getInstallerActivity, getOpenTasks, getTodaysSchedule, nowInBusinessTimezone, recordWorkObservation, resolveScheduledDate, resolveTaskCompletion } from "./scheduler";
import { appendCharacterNote, appendCustomerNote, appendLifeEvent, applyCharacterFact, applyStructuredFact, getCharacterFacts, getCharacterNotes, getCustomerNotes, getRecentLifeEvents, logCapture, runConsolidation, updateCaptureHint, updateCaptureText } from "./memory";
import {
  authGate, checkIdempotencyKey, completeIdempotencyKey, runIdempotentMigration, corsHeadersFor,
  signDocumentPath, resolveCapabilities, getMemberContext, getJobScope, denyForRole, signSession,
  verifySession, getSessionToken, getCookie, base64UrlEncode, ROLE_CAPABILITIES, ENFORCE_CAPABILITIES,
  ACTION_TYPE_CAPABILITY, ROUTE_RULES, SIGNABLE_DOCUMENT_PATHS, canResolveActionType, intentCreationRefusal, intentKeepsOutOfNotes,
} from "./auth";
import { buildDocumentResponse, checkForJobScopeAmendment, convertQuoteToInvoice, findLatestJobScope, findLatestOpenPurchaseOrder, findLatestOpenQuotation, generateAgedCreditorsPdf, generateAgedDebtorsPdf, generateDocumentPdf, generateProfitAndLossPdf, generateStatementPdf, getAgedCreditorsReport, getAgedCreditorsSummary, getAgedDebtorsSummary, getCustomerFinancialSummary, getCustomerProjectSummary, getExpenseSummary, getFinancialSnapshot, getJobProfitability, getLastPricePaid, getOpenDiscrepanciesForSupplier, getOpenLeads, getOpenSnagsForCustomer, getOutstandingBalanceForSupplier, getOutstandingInvoices, getProfitAndLoss, getProfitAndLossSummary, getPurchaseOrderLineItems, getQuotationsSummary, getTrackedStockItems, holdForConfirmation, markLeadLost, recordExpense, addDeliveredItemsToStock, candidateOrderLines, classifyGoodsReceivedLines, getDeliveryExceptions, getOutstandingOrderLines, proposeStockAdditions, recordDelivery, recordGoodsReceived, recordInvoice, recordLead, recordPayment, recordPurchaseOrder, recordQuotation, recordSnag, recordStocktake, recordStockUsage, recordSupplierInvoice, recordSupplierPayment, recordVarianceDisposition, registerStockItem, resolveCrossCaptureAttachment, resolveSnag, cancelPurchaseOrder, describeOpenOrder, getOpenOrdersForSupplier, parseOrderNumber, type OpenOrder, } from "./finance";
import { resolvePDFJS } from "pdfjs-serverless";
import { handleDebugRoute } from "./debug";
import { DOCUMENT_KIND_LABEL, asksAboutDeliveryExceptions, deliveryExceptionAnswer, deliveryHadExceptions, deliveryHeldMessage, deliveryRecordedMessage, inferDocumentSupplier, planDelivery } from "./documents";

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

// Real, careful, hand-rolled CSV parser - deterministic, no AI
// inference. Independently verified against 6 real edge cases (plain
// fields, a comma inside a quoted field, an escaped quote inside a
// quoted field, no trailing newline, an empty trailing field, CRLF
// line endings) before being placed here - a naive split(",") would
// have broken on the first two of those.
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += char;
      i++;
      continue;
    }
    if (char === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (char === ",") {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (char === "\r") {
      i++;
      continue;
    }
    if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
      continue;
    }
    field += char;
    i++;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// Real, deterministic parser for Invoice Simple's "Payment details"
// column: "amount; date; method" per payment, multiple payments
// separated by |. Independently verified against every one of 295
// real rows in the actual uploaded export - the parsed sum matched
// the file's own "Paid" column exactly, with zero mismatches - before
// being placed here.
function parsePaymentDetails(raw: string): Array<{ amount: number; date: string | null; method: string | null }> {
  if (!raw || !raw.trim()) return [];
  return raw
    .split("|")
    .map((entry) => {
      const parts = entry.split(";").map((p) => p.trim());
      const amount = parseFloat(parts[0]);
      return { amount, date: parts[1] || null, method: parts[2] || null };
    })
    .filter((p) => !isNaN(p.amount));
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
  capabilities: string[],
  recordingUserEmail: string | null = null
): Promise<{
  customer: { id: number; name: string; matched: boolean } | null;
  character: { id: number; name: string; matched: boolean } | null;
  pendingActionId: number | null;
  factPendingActionId: number | null;
  message: string;
  jobScopeIdForProjectResolution: number | null;
  // Real, new field, per direct instruction: the raw candidate list
  // for a genuinely multi-candidate ambiguous_person hold, so the
  // client can render a real picker instead of the names only ever
  // existing inside a prose sentence. null everywhere except the two
  // real ambiguous_person branches below.
  pendingCandidates: Array<{ id: number; name: string }> | null;
  pendingActionType: string | null;
  // Real, new field, per direct instruction: the real, structured
  // list of changed fields for a job_scope_amendment hold, so the
  // client has something concrete to show and tap-to-edit instead of
  // the values only ever existing inside prose. null for every other
  // type — the one type actually reviewed and given this treatment.
  // The real shape, as produced by checkForJobScopeAmendment. This used to be declared as { field, oldValue, newValue },
  // which is not what the function returns, and two "tolerated" type errors were exactly that disagreement.
  pendingChanges: Array<{ field: string; label: string; displayValue: string }> | null;
  // Present only where a segment creates TWO holds (an invoice held, then an amendment question returned instead): the
  // earlier one, which has no field of its own above. Absent everywhere else, so no other result is touched.
  alsoPending?: Array<{ id: number; type: string }>;
}> {
  let customer: { id: number; name: string; matched: boolean } | null = null;
  let character: { id: number; name: string; matched: boolean } | null = null;
  let pendingActionId: number | null = null;
  // Real, new variable, per direct instruction: tracks the real
  // pending_actions type string alongside pendingActionId, at every
  // real site that sets it — so the client can grade its own
  // confirm/reject gesture by real stakes (hold by default; a tap
  // only for the one type actually reviewed and confirmed low-stakes,
  // job_scope_amendment) instead of guessing from prose or treating
  // every pending action identically.
  let pendingActionType: string | null = null;

  // Real, new intent, per direct instruction: reasoned through as
  // what a real listener actually does with "forget that last one" —
  // not erase a memory, just stop treating it as live. Clears the
  // register (selections) so the next thing said isn't assumed to
  // still be about whoever/whatever was just active, and abandons the
  // most recent still-open pending action so nothing half-decided
  // keeps waiting. Deliberately NOT routed through reject, which has
  // real, different, type-specific side effects (creating a new
  // person, a new job) that "forget" should never trigger — this is a
  // genuinely new pending_actions status, zero side effects of its
  // own. Captures are never touched — the immutable record of what
  // was actually said stays exactly that; this changes what happens
  // next, not what already happened. Response stays minimal on
  // purpose — a real listener doesn't narrate everything they just
  // let go of.
  if (extraction?.intent === "forget_last") {
    await env.OFFICE_DB.prepare("DELETE FROM selections").run();

    // Only a pending action this caller could resolve through the normal confirm and reject routes. It used to be the
    // newest pending action of anyone's, so an installer saying "forget that" abandoned the owner's pending invoice.
    const { results: pendingNewestFirst } = await env.OFFICE_DB.prepare(
      "SELECT id, type FROM pending_actions WHERE status = 'pending' ORDER BY created_at DESC, id DESC"
    ).all<{ id: number; type: string }>();
    const mostRecentPending = (pendingNewestFirst ?? []).find((p) => canResolveActionType(p.type, capabilities)) ?? null;
    if (mostRecentPending) {
      await env.OFFICE_DB.prepare(
        "UPDATE pending_actions SET status = 'abandoned', resolved_at = datetime('now') WHERE id = ?"
      )
        .bind(mostRecentPending.id)
        .run();
    }

    return {
      customer: null,
      character: null,
      pendingActionId: null,
      factPendingActionId: null,
      message: "Okay.",
      jobScopeIdForProjectResolution: null,
      pendingCandidates: null,
      pendingActionType: null,
      pendingChanges: null,
    };
  }

  // Creation-time permission check, driven by INTENT_RULES in auth.ts.
  // Deliberately BEFORE any name is looked up or created. It used to run
  // after the preamble below, and the preamble can write: reconcileCustomer
  // inserts a customer row for an unknown name, and the identity checks can
  // raise held actions. So a role that was about to be refused still left a
  // real customer row behind first (found by tracing the order, recorded
  // in PROCESS_ONE_EXTRACTION_REWRITE.md, Step 3 item 8; moved on Pierre's
  // decision 2026-10-02). A refused role now causes no writes at all.
  // customer and character are null in the refusal because nothing has
  // been resolved yet, which is the point.
  const creationRefusal = intentCreationRefusal(extraction?.intent, capabilities);
  if (creationRefusal) {
    return {
      customer: null,
      character: null,
      pendingActionId: null,
      factPendingActionId: null,
      message: creationRefusal,
      jobScopeIdForProjectResolution: null,
      pendingCandidates: null,
      pendingActionType: null,
      pendingChanges: null,
    };
  }

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
    if (extraction.intent === "lookup" || extraction.intent === "cancel_order") {
      const found = await findExistingCustomerByName(env, extraction.customer_name);
      if (found) {
        customer = { id: found.id, name: found.name, matched: true };
      }
    } else if (extraction.intent === "raise_lead" || extraction.intent === "lose_lead") {
      // Real feature 2026-07-25 — the lead/enquiry stage's real point:
      // this name is a lead, not yet a customer, and must never
      // trigger reconcileCustomer or the identity collision check —
      // doing so would immediately create a real customer record for
      // someone who hasn't been quoted yet, the exact duplication the
      // whole design exists to avoid. Handled entirely separately,
      // below, against the real leads table instead.
    } else {
      // Real feature 2026-07-25 — Identity Collision, given directly
      // by Pierre. A real, deterministic check — before ever
      // silently creating a new customer, verify this exact name
      // isn't already a known character (an installer, a supplier)
      // under a genuinely conflicting role. Only fires here, since
      // this is the one place a wrongly-assigned identity could
      // actually get created.
      const collision = await checkCrossRoleCollision(env, extraction.customer_name, "customer");
      if (collision) {
        // Real, deterministic check, per direct instruction after a
        // real, confirmed extraction bug: "let's schedule stylish for
        // the bon waterfront installation" extracted customer_name:
        // "Stylish" (an existing installer), character_name: null —
        // the real customer ("bon waterfront") was never captured as
        // any field at all, not just mislabeled. A field swap can't
        // recover data that was never extracted in the first place.
        // When a work_observation message names someone already on
        // file as a character, with no character_name of its own,
        // that's real, strong evidence the extraction dropped the
        // real customer — asking the generic "is this a role change"
        // question here would be asking the wrong thing about a
        // broken extraction. Honest instead: say so, and let a clean
        // re-say recover it, the same way it already worked twice
        // earlier tonight once the sentence named the installer
        // explicitly ("...to install for...").
        if (extraction.intent === "work_observation" && !extraction.character_name) {
          return {
            customer: null,
            character: null,
            pendingActionId: null,
            factPendingActionId: null,
            message: `"${extraction.customer_name}" is already on file as someone who does the work, not a customer — that might not have come through fully. Try saying it again?`,
            jobScopeIdForProjectResolution: null,
            pendingCandidates: null,
            pendingActionType: null,
            pendingChanges: null,
          };
        }
        const held = await holdForConfirmation(
          env,
          "identity_collision",
          { name: extraction.customer_name, intendedRole: "customer", extraction, transcript, captureId },
          transcript
        );
        return {
          customer: null,
          character: null,
          pendingActionId: held.id,
          factPendingActionId: null,
          message: `${collision.name} is already on file as ${withArticle(collision.existingLabel)} — is this the same ${collision.name}, now acting as a customer too, or did you mean someone else? (action #${held.id})`,
          jobScopeIdForProjectResolution: null,
          pendingCandidates: null,
          pendingActionType: "identity_collision",
          pendingChanges: null,
        };
      }
      // Real, deliberate guard, per direct instruction after a real,
      // confirmed design gap found live: without this, a name that's
      // already been resolved once (a real customer row genuinely
      // exists under this exact spoken name) would still re-trigger
      // this same ambiguous hold on every future mention, forever,
      // since reconcilePerson checks `people`, never `customers`
      // directly. Same discipline checkCrossRoleCollision already
      // uses for its own case — only ever ask when this exact name
      // genuinely doesn't already exist in its own intended table.
      const alreadyKnownCustomer = extraction.customer_name
        ? await env.OFFICE_DB.prepare("SELECT id FROM customers WHERE name = ? COLLATE NOCASE").bind(extraction.customer_name).first()
        : null;
      if (!alreadyKnownCustomer) {
        const personCheck = await reconcilePerson(env, extraction.customer_name);
        if (personCheck?.status === "ambiguous") {
          const held = await holdForConfirmation(
            env,
            "ambiguous_person",
            { name: extraction.customer_name, intendedRole: "customer", candidates: personCheck.candidates, extraction, transcript, captureId },
            transcript
          );
          // Real, honest split, per direct instruction after a real
          // UX bug: a single real candidate is genuinely a yes/no
          // question — CONFIRM and REJECT can answer it correctly.
          // Two or more is genuinely multiple-choice — now a real
          // picker (see pendingCandidates below and the client side),
          // not prose listing every name inline.
          const message =
            personCheck.candidates.length === 1
              ? `"${extraction.customer_name}" sounds like an existing customer, "${personCheck.candidates[0].name}" — is this the same one? (action #${held.id})`
              : `"${extraction.customer_name}" could be more than one person already on file — which one is this? (action #${held.id})`;
          return {
            customer: null,
            character: null,
            pendingActionId: held.id,
            factPendingActionId: null,
            message,
            jobScopeIdForProjectResolution: null,
            pendingCandidates: personCheck.candidates,
            pendingActionType: "ambiguous_person",
            pendingChanges: null,
          };
        }
      }
      customer = await reconcileCustomer(env, extraction.customer_name);
    }
  }

  if (extraction?.character_name) {
    if (extraction.intent === "lookup" || extraction.intent === "cancel_order") {
      const found = await findExistingCharacterByName(env, extraction.character_name);
      if (found) {
        character = { id: found.id, name: found.name, matched: true };
      }
    } else {
      const collision = await checkCrossRoleCollision(env, extraction.character_name, "character");
      if (collision) {
        const held = await holdForConfirmation(
          env,
          "identity_collision",
          { name: extraction.character_name, intendedRole: "character", extraction, transcript, captureId },
          transcript
        );
        return {
          customer: null,
          character: null,
          pendingActionId: held.id,
          factPendingActionId: null,
          message: `${collision.name} is already on file as ${withArticle(collision.existingLabel)} — is this the same ${collision.name}, now acting as ${withArticle(extraction.character_relationship ?? "contact")} too, or did you mean someone else? (action #${held.id})`,
          jobScopeIdForProjectResolution: null,
          pendingCandidates: null,
          pendingActionType: "identity_collision",
          pendingChanges: null,
        };
      }
      // Same real guard and honest single/multi-candidate split as the
      // customer block above — see its comment for the full reasoning.
      const alreadyKnownCharacter = extraction.character_name
        ? await env.OFFICE_DB.prepare("SELECT id FROM characters WHERE name = ? COLLATE NOCASE").bind(extraction.character_name).first()
        : null;
      if (!alreadyKnownCharacter) {
        const personCheck = await reconcilePerson(env, extraction.character_name);
        if (personCheck?.status === "ambiguous") {
          const held = await holdForConfirmation(
            env,
            "ambiguous_person",
            { name: extraction.character_name, intendedRole: "character", candidates: personCheck.candidates, extraction, transcript, captureId },
            transcript
          );
          const message =
            personCheck.candidates.length === 1
              ? `"${extraction.character_name}" sounds like an existing person, "${personCheck.candidates[0].name}" — is this the same one? (action #${held.id})`
              : `"${extraction.character_name}" could be more than one person already on file — which one is this? (action #${held.id})`;
          return {
            customer: null,
            character: null,
            pendingActionId: held.id,
            factPendingActionId: null,
            message,
            jobScopeIdForProjectResolution: null,
            pendingCandidates: personCheck.candidates,
            pendingActionType: "ambiguous_person",
            pendingChanges: null,
          };
        }
      }
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
  // be a follow-up to.
  // Real bug found live tonight, this history-length proxy's own real
  // gap: "who owes me money" — a genuinely standalone question, with
  // real, nonzero history present (several unrelated questions asked
  // earlier) — still got silently resolved to Jenny, the register's
  // most recently touched selection, because "any history exists" was
  // never the same thing as "this specific message is actually a
  // follow-up". The register lives in D1, not conversation memory —
  // it persists indefinitely, with no sense of staleness, until
  // something else explicitly overwrites it. Fixed with the real,
  // same linguistic judgment already proven in splitIntoTopics' own
  // pronoun-detection language, applied here instead of a length
  // check: does this specific message contain a genuine backward
  // reference at all? A confident "no" excludes the register outright,
  // regardless of how much history exists; the proven ProSupply case
  // ("those instances" — a real, genuine reference) stays correctly
  // eligible either way.
  const needsBackwardReferenceCheck = extraction?.query_scope === "business";
  const hasBackwardReference = needsBackwardReferenceCheck ? await containsBackwardReference(env, transcript) : true;
  const scopeCouldBeEntity =
    extraction?.query_scope !== "personal" &&
    extraction?.query_scope !== "material_price" &&
    !(extraction?.query_scope === "business" && !hasBackwardReference);
  // Real, precise fix, found live: a real, explicit name that was
  // genuinely given but honestly not found (findExistingCustomerByName
  // correctly returning nothing for someone who isn't yet a customer)
  // was being treated identically to a vague, nameless follow-up -
  // "!customer && !character" is true either way, with nothing asking
  // why. That silently fell back to the register's stale selection
  // instead of the honest, correct "not on file" answer. The register
  // exists for exactly one real case - a message with no name at all
  // - never for a name that was given and genuinely didn't match.
  const noNameWasGiven = !extraction?.customer_name && !extraction?.character_name;
  if (extraction?.intent === "lookup" && !customer && !character && scopeCouldBeEntity && noNameWasGiven) {
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

  // RELATIONAL_IDENTITY_ARCHITECTURE.md Stage 1 — passive logging
  // only, zero behavior change. The one real, unambiguous relation
  // available at this exact point: a customer and a character were
  // both named in the same real capture. Nothing here reads this
  // signal back yet — Stage 2 (the ambiguous-case tiebreaker) is a
  // separate, later addition, not wired in by this change.
  if (captureId !== null && customer && character) {
    ctx.waitUntil(logInteractionEdge(env, "customer", customer.id, "character", character.id, "co_captured", captureId));
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
  // Still needed below: the nested pricing inside work_observation is a
  // financial write inside an intent that is otherwise open to every role.
  const canManageInvoicesForWrites = capabilities.includes("can_manage_invoices");

  if (extraction?.intent === "payment" && customer) {
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

  // Real feature 2026-07-21 — Purchase Orders, built incrementally
  // per the real, three-way design pinned in DECISIONS.md.
  // Deliberately unguarded, the same precedent already established
  // for job scopes — a real commitment, not yet a transaction.
  let purchaseOrderResult: { purchaseOrderId: number; lineItemCount: number } | null = null;
  let purchaseOrderNoSupplier = false;
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

  let purchaseOrderNoItems = false;
  if (extraction?.intent === "purchase_order") {
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
      }
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
  let goodsReceivedNoItems = false;
  let goodsReceivedMessage: string | null = null;
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
      const grnPlan = planDelivery(classifyGoodsReceivedLines(grnExtraction.line_items, candidates), {
        mustHold: true,
        refused: false,
      });
      if (grnPlan.action === "hold") {
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
        goodsReceivedMessage = deliveryHeldMessage(grnPlan, character.name, false, held.id, outstanding.length > 0);
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
  if (extraction?.intent === "supplier_invoice") {
    if (character) {
      const openPo = await findLatestOpenPurchaseOrder(env, character.id);
      if (openPo) {
        const poLineItems = await getPurchaseOrderLineItems(env, openPo.id);
        const siExtraction = await extractSupplierInvoice(env, transcript, poLineItems);
        if (siExtraction.line_items.length === 0) {
          // Found by the characterization recordings 2026-10-03: with the model down, or nothing readable, an invoice
          // with no lines was held for confirmation, which would have recorded an invoice of nothing.
          supplierInvoiceNoItems = true;
        } else {
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
  if (extraction?.intent === "stock_usage") {
    const trackedItems = await getTrackedStockItems(env);
    if (trackedItems.length > 0) {
      const usage = await extractStockUsage(env, transcript, trackedItems);
      const matchedItem = usage.matched_item_name
        ? trackedItems.find((i) => i.name.toLowerCase() === usage.matched_item_name!.toLowerCase())
        : null;
      if (matchedItem && usage.quantity_used != null) {
        const usageCustomerId = usage.job_customer_name ? (await reconcileCustomer(env, usage.job_customer_name))?.id ?? null : null;
        const recorded = await recordStockUsage(env, matchedItem.id, usage.quantity_used, usageCustomerId, transcript);
        stockUsageResult = { itemName: matchedItem.name, quantityUsed: usage.quantity_used, newQuantityOnHand: recorded.newQuantityOnHand };
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
      if (matchedItem && st.quantity_counted != null) {
        const recorded = await recordStocktake(env, matchedItem.id, st.quantity_counted, transcript);
        stocktakeResult = {
          itemName: matchedItem.name,
          quantityCounted: st.quantity_counted,
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

  // Real feature 2026-07-25 — Snags, the smallest, most immediately
  // useful piece of the job-completion/warranty/snags design.
  // Deliberately unguarded but traceable, matching GRN's own
  // precedent — a quality note, not money moving.
  let snagResult: { id: number; description: string } | null = null;
  let snagNoCustomer = false;
  if (extraction?.intent === "raise_snag") {
    if (customer) {
      const snag = await extractSnag(env, transcript);
      if (snag.description) {
        const recorded = await recordSnag(env, customer.id, snag.description);
        snagResult = { id: recorded.id, description: snag.description };
      }
    } else {
      snagNoCustomer = true;
    }
  }

  let snagResolutionResult: { description: string; retentionReleasable: boolean; retentionAmount: number | null } | null = null;
  let snagResolutionNoMatch = false;
  if (extraction?.intent === "resolve_snag") {
    if (customer) {
      const openSnags = await getOpenSnagsForCustomer(env, customer.id);
      if (openSnags.length > 0) {
        const res = await extractSnagResolution(env, transcript, openSnags);
        const matched = res.matched_description
          ? openSnags.find((s) => s.description.toLowerCase() === res.matched_description!.toLowerCase())
          : openSnags.length === 1
          ? openSnags[0]
          : null;
        if (matched) {
          const resolved = await resolveSnag(env, matched.id, customer.id);
          snagResolutionResult = {
            description: matched.description,
            retentionReleasable: resolved.retentionReleasable,
            retentionAmount: resolved.retentionAmount,
          };
        } else {
          snagResolutionNoMatch = true;
        }
      } else {
        snagResolutionNoMatch = true;
      }
    } else {
      snagNoCustomer = true;
    }
  }

  // Real feature 2026-07-25 — the lead/enquiry stage, the fourth real
  // gap named from the full lead-to-warranty lifecycle walk.
  // Deliberately unguarded but traceable, matching every other
  // quality/status note in this project. customer stays null here on
  // purpose (see the exclusion above) — extraction.customer_name is
  // used directly, since this name is a real lead, not yet a
  // customer.
  let leadResult: { id: number; name: string } | null = null;
  let leadNoName = false;
  if (extraction?.intent === "raise_lead") {
    if (extraction.customer_name) {
      const lead = await extractLead(env, transcript);
      if (lead.name) {
        const recorded = await recordLead(env, lead.name, lead.interest, lead.source, captureId);
        leadResult = { id: recorded.id, name: lead.name };
      } else {
        leadNoName = true;
      }
    } else {
      leadNoName = true;
    }
  }

  let leadLostResult: { name: string } | null = null;
  let leadLostNoMatch = false;
  if (extraction?.intent === "lose_lead") {
    const openLeads = await getOpenLeads(env);
    if (openLeads.length > 0) {
      const res = await extractLeadLost(env, transcript, openLeads);
      const matched = res.matched_name
        ? openLeads.find((l) => l.name.toLowerCase() === res.matched_name!.toLowerCase())
        : openLeads.length === 1
        ? openLeads[0]
        : null;
      if (matched) {
        await markLeadLost(env, matched.id);
        leadLostResult = { name: matched.name };
      } else {
        leadLostNoMatch = true;
      }
    } else {
      leadLostNoMatch = true;
    }
  }

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
  } | null = null;

  let invoiceJobPartNotRead = false;
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
      const amendment = await checkForJobScopeAmendment(env, customer.id, observation, installerId, observation.installer_name, transcript, captureId);
      if (amendment) {
        return {
          customer,
          character,
          pendingActionId: amendment.pendingActionId,
          factPendingActionId: null,
          // Found by the characterization recordings 2026-10-03: with an amount in the sentence, the invoice hold was
          // created above and then this returned only the amendment question, so a pending invoice existed that the
          // reply never mentioned (and the app only offered buttons for the amendment). The hold is still the
          // second thing waiting; the reply now says so, with its number.
          message:
            amendment.message +
            (pendingActionId !== null && extraction?.amount
              ? ` Your invoice for ${customer?.name ?? "the customer"} of R${extraction.amount} is also waiting for confirmation (action #${pendingActionId}).`
              : ""),
          jobScopeIdForProjectResolution: null,
          pendingCandidates: null,
          pendingActionType: "job_scope_amendment",
          pendingChanges: amendment.changes,
          ...(pendingActionId !== null && pendingActionType ? { alsoPending: [{ id: pendingActionId, type: pendingActionType }] } : {}),
        };
      }

      const recorded = await recordWorkObservation(env, customer.id, observation, transcript, installerId, captureId);
      workObservationResult = {
        jobScopeId: recorded.jobScopeId,
        componentCount: observation.components.length,
        taskCount: observation.tasks.length,
        installerConflict: recorded.installerConflict,
      };
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
  let workObservationPricingNotMade = false;
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
        return {
          customer,
          character,
          pendingActionId: amendment.pendingActionId,
          factPendingActionId: null,
          // Found by the characterization recordings 2026-10-03: with an amount in the sentence, the invoice hold was
          // created above and then this returned only the amendment question, so a pending invoice existed that the
          // reply never mentioned (and the app only offered buttons for the amendment). The hold is still the
          // second thing waiting; the reply now says so, with its number.
          message:
            amendment.message +
            (pendingActionId !== null && extraction?.amount
              ? ` Your invoice for ${customer?.name ?? "the customer"} of R${extraction.amount} is also waiting for confirmation (action #${pendingActionId}).`
              : ""),
          jobScopeIdForProjectResolution: null,
          pendingCandidates: null,
          pendingActionType: "job_scope_amendment",
          pendingChanges: amendment.changes,
          ...(pendingActionId !== null && pendingActionType ? { alsoPending: [{ id: pendingActionId, type: pendingActionType }] } : {}),
        };
      }

      recorded = await recordWorkObservation(env, customer?.id ?? null, observation, transcript, installerId, captureId);
      workObservationResult = {
        jobScopeId: recorded.jobScopeId,
        componentCount: observation.components.length,
        taskCount: observation.tasks.length,
        installerConflict: recorded.installerConflict,
      };
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
  // Real fix found live 2026-07-17, via direct testing (Constitution Principle 26): any intent with real,
  // structured storage of its own was also having its raw transcript duplicated into this ungated note, purely
  // redundant since the real data is already properly captured elsewhere, and a genuine leak, since that
  // duplicate note bypassed every capability gate entirely. Proven directly: an Installer session was correctly
  // refused the structured financial summary, then handed the same fact anyway, "Jenny paid R500", verbatim
  // from this exact note. The fallback only fires for genuinely narrative facts that have no other structured
  // home to live in.
  //
  // That fix was a hand-kept list of six intents, and the money intents added later were never added to it
  // (a supplier payment's note was reproduced on 2026-10-03). The answer now comes from INTENT_RULES in
  // auth.ts, so it cannot drift from what is gated again.
  const hasStructuredHomeAlready = intentKeepsOutOfNotes(extraction?.intent);
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
  } else if (extraction?.intent === "price_scope" && customer && !pendingActionId) {
    // A job scope was found, but nothing spoken matched a real
    // component/task or produced a positive total — say so rather
    // than silently doing nothing. (Needs a customer: with none named, this branch used to be reached anyway and
    // crashed on customer!.name; found by the characterization recordings 2026-10-03. The no-customer reply is below.)
    message = `Found a job scope for ${customer.name}, but couldn't match any priced item to it — try naming the component or task exactly as measured.`;
  } else if (extraction?.intent === "purchase_order" && purchaseOrderResult) {
    message = `Purchase order #${purchaseOrderResult.purchaseOrderId} recorded for ${character!.name} — ${purchaseOrderResult.lineItemCount} item(s).`;
  } else if (extraction?.intent === "invoice" && customer && !pendingActionId && !workObservationResult) {
    // Found by the characterization recordings 2026-10-03: an invoice with a named customer but no amount and nothing
    // to record fell through to the generic "Found existing customer" reply, as if it had been a lookup.
    message = `I heard an invoice for ${customer.name}, but no amount came through — how much is it for?${invoiceJobPartNotRead ? " I couldn't read any job details from that either, so say those again too." : ""}`;
  } else if (extraction?.intent === "quotation" && customer && !pendingActionId) {
    // Same: a quotation with no readable items and no amount answered as a lookup.
    message = `I heard a quotation for ${customer.name}, but couldn't make out any items or an amount.`;
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
  } else if (extraction?.intent === "purchase_order" && purchaseOrderNoItems) {
    message = `I heard an order for ${character!.name}, but couldn't make out any items on it, so nothing was recorded.`;
  } else if (extraction?.intent === "purchase_order" && purchaseOrderNoSupplier) {
    // Honest, not silent — the same discipline as every other
    // recognized-but-nothing-to-act-on case in this project.
    message = "Recognized a purchase order, but no supplier was named — try naming who it's from.";
  } else if (pendingActionId && extraction?.intent === "goods_received" && goodsReceivedSupplierName) {
    message = goodsReceivedMessage ?? `Delivery noted from ${goodsReceivedSupplierName} — needs your confirmation (action #${pendingActionId}) before it's recorded.`;
  } else if (extraction?.intent === "goods_received" && goodsReceivedNoSupplier) {
    message = "Recognized a delivery, but no supplier was named — try naming who it's from.";
  } else if (extraction?.intent === "goods_received" && goodsReceivedNoItems) {
    message = `I heard a delivery from ${character!.name}, but couldn't make out any items in it, so nothing was noted.`;
  } else if (pendingActionId && extraction?.intent === "supplier_invoice" && supplierInvoiceSupplierName) {
    message = `Supplier invoice noted from ${supplierInvoiceSupplierName} — needs your confirmation (action #${pendingActionId}) before it's recorded.`;
  } else if (extraction?.intent === "supplier_invoice" && supplierInvoiceNoItems) {
    message = `I heard a supplier invoice from ${character!.name}, but couldn't make out any items on it, so nothing was noted.`;
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
  } else if (extraction?.intent === "register_stock_item" && stockRegistrationResult) {
    message = `${stockRegistrationResult.existed ? "Already tracking" : "Now tracking"} ${stockRegistrationResult.name}${stockRegistrationResult.unit ? ` (${stockRegistrationResult.unit})` : ""} as real, running stock.`;
  } else if (extraction?.intent === "register_stock_item") {
    message = "Recognized a request to start tracking stock, but no real material name was given — try naming it.";
  } else if (extraction?.intent === "stock_usage" && stockUsageResult) {
    message = `Recorded ${stockUsageResult.quantityUsed} used of ${stockUsageResult.itemName} — ${stockUsageResult.newQuantityOnHand} remaining.`;
  } else if (extraction?.intent === "stock_usage" && stockUsageNoMatch) {
    message = "Recognized real stock usage, but couldn't match it to anything currently being tracked — try naming the exact item, or track it first.";
  } else if (extraction?.intent === "stocktake" && stocktakeResult) {
    const varianceText = stocktakeResult.variance === 0 ? "matches exactly, no variance" : `variance ${stocktakeResult.variance > 0 ? "+" : ""}${stocktakeResult.variance} vs the expected ${stocktakeResult.quantityExpected}`;
    message = `Stocktake recorded for ${stocktakeResult.itemName}: counted ${stocktakeResult.quantityCounted}, ${varianceText}.`;
  } else if (extraction?.intent === "stocktake" && stocktakeNoMatch) {
    message = "Recognized a stocktake, but couldn't match it to anything currently being tracked — try naming the exact item, or track it first.";
  } else if (extraction?.intent === "raise_snag" && snagResult) {
    message = `Snag #${snagResult.id} noted for ${customer!.name}: ${snagResult.description}.`;
  } else if (extraction?.intent === "raise_snag" && snagNoCustomer) {
    message = "Recognized a snag, but no customer was named — try naming whose job this is.";
  } else if (extraction?.intent === "raise_snag") {
    message = "Recognized a snag report, but couldn't make out the actual issue — try describing it.";
  } else if (extraction?.intent === "resolve_snag" && snagResolutionResult) {
    const retentionNote = snagResolutionResult.retentionReleasable
      ? ` All snags resolved — a real retention of R${snagResolutionResult.retentionAmount} may now be releasable for ${customer!.name}.`
      : "";
    message = `Snag resolved for ${customer!.name}: ${snagResolutionResult.description}.${retentionNote}`;
  } else if (extraction?.intent === "resolve_snag" && snagResolutionNoMatch) {
    message = `I don't have an open snag on file for ${customer!.name} to match this to.`;
  } else if (extraction?.intent === "resolve_snag" && snagNoCustomer) {
    message = "Recognized a snag resolution, but no customer was named — try naming whose job this is.";
  } else if (extraction?.intent === "raise_lead" && leadResult) {
    message = `Lead #${leadResult.id} noted for ${leadResult.name}.`;
  } else if (extraction?.intent === "raise_lead" && leadNoName) {
    message = "Recognized a new enquiry, but couldn't make out who it's from — try naming them.";
  } else if (extraction?.intent === "lose_lead" && leadLostResult) {
    message = `Marked the ${leadLostResult.name} enquiry as lost.`;
  } else if (extraction?.intent === "lose_lead" && leadLostNoMatch) {
    message = "I don't have an open enquiry on file to match this to.";
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
    if (extraction?.intent === "invoice" && invoiceJobPartNotRead && !workObservationResult) {
      message += " I couldn't read any job details (measurements, an installer or a date) from that, so only the invoice was noted. Say the job part again if you want it recorded.";
    }
    if (workObservationResult) {
      const jobParts: string[] = [];
      if (workObservationResult.componentCount > 0) jobParts.push(`${workObservationResult.componentCount} component${workObservationResult.componentCount > 1 ? "s" : ""} measured`);
      if (workObservationResult.taskCount > 0) jobParts.push(`${workObservationResult.taskCount} task${workObservationResult.taskCount > 1 ? "s" : ""} noted`);
      message += ` Job scope #${workObservationResult.jobScopeId} also recorded${jobParts.length ? ` — ${jobParts.join(", ")}` : ""}.`;
      if (workObservationResult.installerConflict) {
        const conflict = workObservationResult.installerConflict;
        const who = conflict.customerName ? `${conflict.customerName}: ${conflict.description}` : conflict.description;
        message += ` Heads up — the same installer is already booked that day (${who}).`;
      }
    }
  } else if (extraction?.intent === "work_observation" && workObservationNothingObserved) {
    message = customer
      ? `I heard a job observation for ${customer.name}, but couldn't make out any measurements, tasks, date or installer, so nothing was recorded.`
      : "I heard a job observation, but couldn't make out any measurements, tasks, date or installer, so nothing was recorded.";
  } else if (workObservationResult) {
    const { jobScopeId, componentCount, taskCount, installerConflict } = workObservationResult;
    const parts: string[] = [];
    if (componentCount > 0) parts.push(`${componentCount} component${componentCount > 1 ? "s" : ""} measured`);
    if (taskCount > 0) parts.push(`${taskCount} task${taskCount > 1 ? "s" : ""} noted`);
    // Real fix 2026-07-13: customer!.name would throw now that a work
    // observation can genuinely record without a customer resolved —
    // caught before shipping, same pattern as the earlier expense-
    // message fix (character ? ... : "").
    message = `Job scope #${jobScopeId} recorded${customer ? ` for ${customer.name}` : ""}${parts.length ? ` — ${parts.join(", ")}` : ""}.`;
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
    // Real feature 2026-07-25 — GRN-informed pricing. A real,
    // historical fact, answered directly from real supplier invoice
    // data — never a suggested rate, never replacing Peter's own
    // pricing judgment.
    if (extraction?.query_scope === "material_price" && extraction.fact_value) {
      const priceInfo = await getLastPricePaid(env, extraction.fact_value);
      if (priceInfo) {
        message = `The last real price paid for ${priceInfo.description} was R${priceInfo.unitPrice}${priceInfo.supplierName ? ` (from ${priceInfo.supplierName}` : ""}${priceInfo.supplierName ? `, ${priceInfo.date.split(" ")[0]})` : `, ${priceInfo.date.split(" ")[0]}`}.`;
      } else {
        message = `No real supplier invoice on file yet mentions "${extraction.fact_value}" — nothing to base a price on.`;
      }
    } else if (!customer && !character && asksAboutDeliveryExceptions(transcript)) {
      // Decided 2026-10-03 (Pierre): the delivery exception report, asked for in words. It had only
      // existed as a route and the app has no screen for it. Same permission as the report route
      // (can_manage_invoices), checked here before anything is read. Answered in code, not
      // paraphrased by a model, so the list is always complete and exact. Deliberately ahead of the
      // general business branch, which would otherwise spend a classification call and answer from
      // unrelated financial facts.
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
      if (dashboardRoute === "financial_snapshot" || dashboardRoute === "aged_debtors") {
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
              : ["Outstanding balances exist for this business but are restricted for your role."],
          topic === "invoices" || topic === "expenses"
            ? []
            : canManageInvoicesHere
              ? getQuotationsSummary(env)
              : ["Quotation activity exists for this business but is restricted for your role."],
          topic === "quotations" || topic === "invoices"
            ? []
            : canManageInvoicesHere
              ? getExpenseSummary(env)
              : ["Expense activity exists for this business but is restricted for your role."],
          topic !== "general" ? [] : canKnowProfit ? getFinancialSnapshot(env) : ["Financial performance data exists for this business but is restricted for your role."],
          topic === "general" && canKnowProfit ? getProfitAndLossSummary(env) : [],
          topic === "quotations" || topic === "expenses"
            ? []
            : canKnowDebtors
              ? getAgedDebtorsSummary(env)
              : ["Outstanding balances exist for this business but are restricted for your role."],
          topic === "quotations" || topic === "invoices"
            ? []
            : canManageInvoicesHere
              ? getAgedCreditorsSummary(env)
              : ["Outstanding supplier balances exist for this business but are restricted for your role."],
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
    message = "I didn't catch anything there I could act on.";
  }

  if (factPendingActionId) {
    message += ` ${extraction!.fact_key} noted (${extraction!.fact_value}) — needs your confirmation (action #${factPendingActionId}) before it's saved.`;
  }

  return {
    customer,
    character,
    pendingActionId,
    factPendingActionId,
    message,
    jobScopeIdForProjectResolution: workObservationResult?.jobScopeId ?? jobScopeIdForPricing ?? null,
    pendingCandidates: null,
    pendingActionType: pendingActionType,
    pendingChanges: null,
  };
}
// through processOneExtraction, same result. The only real difference
// for a single-topic message is the one extra split-check call.
// A held action that REPLAYS its original dictation (a name that collides with someone who does the work, or that sounds like
// someone already on file) is answered later by whoever opens it, and the replay runs with THAT person's permissions. If they
// could not have dictated the original, the old behaviour was to consume the question, create the customer or person, and
// let the replay be refused, so the owner's payment was silently lost (found by the characterization recordings 2026-10-04).
// Now the question is put back untouched and the answerer is told why.
async function refuseReplayIfNotPermitted(
  request: Request,
  env: Env,
  actionId: number,
  extraction: Extraction | null
): Promise<Response | null> {
  const { capabilities } = await resolveCapabilities(request, env);
  const refusal = intentCreationRefusal(extraction?.intent, capabilities);
  if (!refusal) return null;
  await env.OFFICE_DB.prepare("UPDATE pending_actions SET status = 'pending' WHERE id = ?").bind(actionId).run();
  return Response.json(
    { error: refusal, detail: "This question holds something you may not record, so it was left for someone who can answer it." },
    { status: 403 }
  );
}

// A claimed action (marked 'processing' so two taps cannot both run) must go back to 'pending' on every early return that did
// not complete it. A missing or invalid choice used to return a 400 without doing so, which left the question 'processing' for
// ever: the next answer, even a correct one, was told "action already processing" (found 2026-10-04).
async function releaseClaim(env: Env, actionId: number): Promise<void> {
  await env.OFFICE_DB.prepare("UPDATE pending_actions SET status = 'pending' WHERE id = ?").bind(actionId).run();
}

async function processTranscript(
  env: Env,
  transcript: string,
  ctx: ExecutionContext,
  history: HistoryTurn[] = [],
  source: string = "text",
  r2Key: string | null = null,
  capabilities: string[] = ROLE_CAPABILITIES.owner,
  recordingUserEmail: string | null = null
): Promise<ProcessResult> {
  const captureId = await logCapture(env, transcript, source, r2Key);

  const items = await extractMultipleIntents(env, transcript);

  const results: Array<{
    customer: { id: number; name: string; matched: boolean } | null;
    character: { id: number; name: string; matched: boolean } | null;
    pendingActionId: number | null;
    factPendingActionId: number | null;
    message: string;
    jobScopeIdForProjectResolution: number | null;
    pendingCandidates: Array<{ id: number; name: string }> | null;
    pendingActionType: string | null;
    pendingChanges: Array<{ field: string; label: string; displayValue: string }> | null;
    alsoPending?: Array<{ id: number; type: string }>;
  }> = [];

  for (const item of items) {
    const outcome = await processOneExtraction(env, item.segment, item.extraction, history, ctx, captureId, capabilities, recordingUserEmail);
    results.push(outcome);
  }

  // Real fix 2026-07-25, found live — Layer 2's cross-capture
  // attachment (the ask-when-2-plus rung included) is deliberately
  // resolved here, only now that every real segment of this whole
  // message has been processed and same-breath assembly has already
  // had its full, complete chance to group whatever it's going to
  // group. Doing this per-segment, inside recordWorkObservation
  // itself, was the real bug: the first segment of a multi-segment
  // message could find an open project and attach to it before its
  // own real sibling — which should have formed a brand new project
  // together with it — ever existed to correct that. Only job scopes
  // that are still genuinely undecided (project_id null) at this
  // point get resolved; anything same-breath assembly already handled
  // is left untouched.
  const jobScopeIdsToResolve = [
    ...new Set(results.map((r) => r.jobScopeIdForProjectResolution).filter((id): id is number => id !== null)),
  ];
  const projectResolutionMessages: string[] = [];
  const projectResolutionActionIds: number[] = [];
  for (const jsId of jobScopeIdsToResolve) {
    const scope = await env.OFFICE_DB.prepare("SELECT project_id, customer_id FROM job_scopes WHERE id = ?")
      .bind(jsId)
      .first<{ project_id: number | null; customer_id: number | null }>();
    if (scope && scope.project_id === null && scope.customer_id !== null) {
      const resolved = await resolveCrossCaptureAttachment(env, jsId, scope.customer_id);
      if (resolved.pendingProjectChoice) {
        const { pendingActionId: ppId, candidates } = resolved.pendingProjectChoice;
        projectResolutionMessages.push(
          `This customer has ${candidates.length} open projects (${candidates.join(", ")}) — which one is job scope #${jsId}? (action #${ppId})`
        );
        projectResolutionActionIds.push(ppId);
      }
    }
  }

  // Real, deterministic merge — never another AI call to summarize,
  // which would just reintroduce the exact relevance-judgment risk
  // Principle 24 already had to correct once tonight. Each segment's
  // own message already says the real, complete thing that happened
  // to it; multiple segments just get joined, not resynthesized.
  const message =
    (results.length === 1
      ? results[0].message
      : results.map((r) => `- ${r.message}`).join("\n")) +
    (projectResolutionMessages.length > 0 ? "\n" + projectResolutionMessages.join("\n") : "");

  const pendingActions: Array<{ id: number; type: string | null }> = [
    ...results.flatMap((r) => (r.pendingActionId !== null ? [{ id: r.pendingActionId, type: r.pendingActionType }] : [])),
    ...results.flatMap((r) => r.alsoPending ?? []),
    ...projectResolutionActionIds.map((id) => ({ id, type: "project_ambiguity" as string | null })),
  ];
  const pendingActionIds = pendingActions.map((a) => a.id);
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
    pendingActions,
    factPendingActionId: factPendingActionIds[0] ?? null,
    message,
    rewrittenQuery: transcript,
    embers,
    // Real, new field, per direct instruction: the raw candidate list
    // for a genuinely multi-candidate ambiguous_person hold, so the
    // client can render a real picker. Same "primary result" pattern
    // already used for customer above — the common real case is one
    // ambiguous hold in an otherwise simple message, not several.
    pendingCandidates: primary?.pendingCandidates ?? null,
    // Real, new field, per direct instruction: the real pending_actions
    // type string, same "primary result" pattern as customer and
    // pendingCandidates above — so the client can grade its own
    // confirm/reject gesture by real stakes.
    pendingActionType: primary?.pendingActionType ?? null,
    // Real, new field, per direct instruction: the real, structured
    // changed-field list for a job_scope_amendment hold, same
    // "primary result" pattern as everything else above.
    pendingChanges: primary?.pendingChanges ?? null,
  };
}

// Real, new, per direct instruction — structured logging with a real
// request correlation ID. Cloudflare's live log stream already exists
// (used directly, by hand, many times tonight to debug a live issue as
// it happened) — this doesn't replace that, it makes it genuinely
// searchable afterward instead of only useful if someone happened to
// be watching at the exact moment something broke. One real JSON shape
// per line, not an ad-hoc string, specifically so a real log platform
// (or a plain text search) can filter by requestId and see every line
// from one real request together, even when Cloudflare interleaves
// many concurrent requests in the same stream.
function log(level: "info" | "error", requestId: string, message: string, fields?: Record<string, unknown>): void {
  const line = { timestamp: new Date().toISOString(), level, requestId, message, ...fields };
  if (level === "error") {
    console.error(JSON.stringify(line));
  } else {
    console.log(JSON.stringify(line));
  }
}

async function handleRequest(request: Request, env: Env, ctx: ExecutionContext, requestId: string): Promise<Response> {
    const url = new URL(request.url);

    // Inside handleRequest, not the outer fetch wrapper, so a 401/403
    // still passes through the wrapper and picks up CORS headers — the
    // web preview shows a readable "sign in required" instead of an
    // opaque blocked-by-CORS failure.
    const gate = await authGate(request, env, url);
    if (gate) return gate;

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
        // Every /debug and /admin route but one (119 of 120 -- the
    // one exception, /debug/reprocess, genuinely needs
    // processTranscript, which stays here; moving it too would
    // have meant a real circular import between this file and
    // debug.ts for the sake of one route, not worth the risk)
    // now lives in debug.ts, dispatched from one real function
    // call here instead of separate branches inline.
    const debugResponse = await handleDebugRoute(request, env, url, ctx);
    if (debugResponse) return debugResponse;


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

    // Real, read-only comparison, per direct instruction, before
    // committing anything about the live transcription path. Never
    // calls processTranscript — this must never be able to create or
    // touch a real record, the same discipline findExistingEntityByName
    // already follows for lookups. Runs the real, currently-live
    // base model and the untested whisper-large-v3-turbo +
    // initial_prompt path side by side against the same real, already-
    // stored audio, so the two can be judged on real evidence rather
    // than assumed. knownNames pulled fresh from D1 each call, not
    // hardcoded — a real, current list, same discipline as everything
    // else in this codebase that refuses to guess where a database
    // already has the answer.
    

    

    // Inspect the actual primary memory now — the KV blob for one
    // customer, not Vectorize (which lags behind, batched, on cron).
    

    // The write-back counterpart to /debug/customer-notes GET — for
    // correcting a KV entry directly (e.g. removing a fact that got
    // filed under the wrong entity) without needing wrangler access.
    // Deliberately generic (any key, any JSON value) rather than one
    // narrow "remove a fact" endpoint — the same reasoning as every
    // other debug tool here: general enough to be useful again, not
    // custom-built for one cleanup.
    

    // Debug counterpart to resolveFollowUpEntity, the closed-form
    // replacement for the abandoned prose-rewriting approach (see the
    // 2026-07-10 bug log in STATUS.md for why). Takes the same
    // {history, text} shape as /messages/text so a real drill-down
    // conversation can be replayed exactly.
    

    // Scoped cleanup for a customer row created in error (e.g. a
    // supplier that should have been a character) — removes the D1
    // row, its KV notes, and any pending_memory_flush entries so
    // nothing dangling gets embedded into Vectorize afterward. Not a
    // general SQL executor on purpose — this only ever does exactly
    // these three deletes, scoped to one customer id.
    

    // Same shape as delete-customer, for a character created in error
    // — e.g. a staff contact that fragmented off a supplier
    // relationship instead of staying attached to it. No
    // pending_memory_flush cleanup needed here: characters never
    // queue into Vectorize consolidation in the first place.
    

    // One-time schema init for the new tasks table (2026-07-10) — real,
    // demonstrated need: a checkable personal errand needs a done state
    // that the narrative life-event log never had, and guard()-confirmed
    // items already have their own done state (pending_actions.status)
    // that this deliberately doesn't duplicate. IF NOT EXISTS makes this
    // safe to call more than once.
    

    // Real feature 2026-07-11: the actual prerequisite for a future
    // [Call] ember action — tasks linked to a real customer/character
    // record, not just a loose name in text. Same idempotent ALTER
    // pattern as the captures FK migration.
    

    // Real feature 2026-07-11 — the first concrete piece of the
    // expense side of the accounting-capability roadmap. Deliberately
    // minimal: a bare table, no category, no VAT, no job linking yet.
    

    // Real feature 2026-07-12 — the real prerequisite for eventually
    // distinguishing cost of sales from operating expenses in a
    // formal P&L. Idempotent, same pattern as every other ALTER here.
    

    // Real feature 2026-07-12 — the real prerequisite for job
    // profitability (getJobProfitability). Idempotent, same pattern
    // as every other ALTER here.
    

    // Real feature 2026-07-12 — the real prerequisite for team
    // support: linking a job to who's actually assigned to do it.
    // Idempotent, same pattern as every other ALTER here.
    

    // Real feature 2026-07-13 — the operational HR primitive's real
    // schema, scoped deliberately: role, skill, qualification,
    // license, site permit. Medical records and disciplinary history
    // are explicitly not here — regulated, need real consent/access
    // thinking first, pinned separately in STATUS.md.
    

    // Real feature 2026-07-14 — step 2 of the phased auth scope
    // (Constitution Principles 25-27): Membership as a real, separate
    // entity, proven on this single existing instance before any
    // multi-instance routing exists. One membership per real Google
    // account per Office (UNIQUE on google_email) — Office x Person x
    // Role, exactly as designed, nothing inferred from an HR fact.
    

    // Real feature 2026-07-15 — Layer 1, Stage 0 (Constitution
    // Principle 28): the schema for real retry safety. key is the
    // primary key deliberately — it's what makes a genuine race
    // between two near-simultaneous requests with the same key safe,
    // since the database itself rejects the second INSERT rather than
    // needing an application-level lock.
    

    // Real feature 2026-07-17 (Constitution Principle 28's own
    // sequencing) — deliberately deferred until basic multi-line
    // totaling was proven correct, which it now is. SQLite has no
    // ADD COLUMN IF NOT EXISTS, so this is wrapped to stay safe to
    // re-run rather than fail if it's ever called twice.
    

    // Real feature 2026-07-20 (Layer 2 / Project design, verified via
    // the Fable 5 design pass): the concrete first step toward
    // same-breath Project assembly — a real, deterministic signal that
    // turned out not to exist in stored data despite the
    // infrastructure (captureId) already flowing through the whole
    // processing pipeline. This is the honest prerequisite, not the
    // whole design.
    

    // Real feature 2026-07-22 — Layer 2 (Project), same-breath
    // assembly. The first, fully-specified piece of the design pinned
    // in DECISIONS.md, built directly on the Fable 5 design pass
    // (verified and corrected the same night) and tonight's own
    // capture_id prerequisite.
    

    // Real feature 2026-07-22 — Layer 2 (Project): the real, missing
    // link back to the job scope a quotation or invoice was actually
    // priced from, closing the exact gap the Fable 5 design review
    // correctly identified in the Layer 2 design pin.
    

    // Real fix 2026-07-24 — found live: an invoice created via
    // convertQuoteToInvoice before this fix never carried forward its
    // source quotation's real job_scope_id, so it silently dropped
    // out of a project's real totals. A real, safe backfill — only
    // touches invoices genuinely missing the link but able to
    // recover it from their own quotation, idempotent and safe to
    // re-run.
    

    

    // Real, new endpoint, per direct instruction, part of the real
    // discoverability-plus-audit pass, third and final domain: projects
    // has been a real, working feature since 2026-07-22 (job scopes
    // linked through project_id, with a real total quoted/invoiced
    // value already computed) with no discoverable surface anywhere in
    // the app. Same real enriched shape as /debug/projects just above,
    // without the debug-only LIMIT — this is a real, production
    // endpoint, not a debug one. Read-only, deliberately: there's no
    // real "resolve" or "complete" action for a project anywhere in
    // this backend to wire up, unlike Snags or Leads — a project's own
    // completeness is implied by its job scopes', not tracked
    // separately, so building a UI action here would be inventing
    // capability that doesn't actually exist server-side.
    if (url.pathname === "/projects" && request.method === "GET") {
      const jobScope = await getJobScope(request, env);
      const { results: projects } = await env.OFFICE_DB.prepare(
        `SELECT p.id, p.customer_id, c.name as customer_name, p.description, p.created_at
         FROM projects p
         LEFT JOIN customers c ON c.id = p.customer_id
         WHERE (?2 = 0 OR p.customer_id IN (SELECT customer_id FROM job_scopes WHERE installer_id = ?1))
         ORDER BY p.created_at DESC`
      )
        .bind(jobScope.characterId, jobScope.scoped ? 1 : 0)
        .all();
      const enriched = await Promise.all(
        (projects as Array<{ id: number }>).map(async (project) => {
          const { results: jobScopes } = await env.OFFICE_DB.prepare(
            "SELECT id, description, capture_id, created_at FROM job_scopes WHERE project_id = ?"
          )
            .bind(project.id)
            .all();
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
    

    // Real feature 2026-07-21 — closing a real, known gap with real,
    // concrete evidence behind it (Zululand Flooring genuinely
    // operates with VAT for some clients, not others), not
    // speculative. A customer's own standing exempt status now
    // overrides the business-wide VAT default entirely for their
    // documents.
    

    // Real feature 2026-07-21 — a real, urgent need: an active
    // two-year contract in its final stage, needing historical
    // reconciliation soon. A customer's real, standing retention
    // rate, plus the real, computed withheld amount stored on every
    // invoice it applies to.
    

    // Real feature 2026-07-21 — Purchase Orders, the first stage of
    // the real, three-way PO/GRN/Supplier Invoice design already
    // pinned in DECISIONS.md, built incrementally. supplier_id
    // references characters (suppliers), never customers — the same
    // isolation already proven for every other supplier relationship
    // in this project.
    

    // Real, new list endpoint for ERP mode's Suppliers module, per
    // ERP_MODE_ARCHITECTURE.md: same real search/pagination shape as
    // /debug/finance-list. Reuses the exact, already-proven document-
    // completeness status and line-item enrichment already verified
    // working in /debug/purchase-orders above - no new status logic
    // invented, just made searchable and paginated.
    

    

    // Real feature 2026-07-21 — Goods Received Notes, the second
    // stage of the real, three-way PO/GRN/Supplier Invoice design
    // pinned in DECISIONS.md.
    

    // Real feature 2026-07-21 — a separate migration since the table
    // already exists from earlier tonight; CREATE TABLE IF NOT EXISTS
    // alone won't add a new column to a table that's already there.
    // Real design decision: who actually recorded a delivery is now a
    // real, permanent, traceable fact.
    

    // Real feature 2026-07-24 — Variance Disposition, the real, first
    // piece of the design pinned in DECISIONS.md, reason codes
    // validated against real ERP research before being finalized.
    

    

    // Real feature 2026-07-25 — Consumables Stock, the idea-tank
    // review's first real, unlocked item, sequenced explicitly after
    // PO/GRN in the original design and built now that PO/GRN is real
    // and proven.
    

    

    // Real, new endpoint, per direct instruction, part of the real
    // discoverability-plus-audit pass — Stock, the fifth real domain.
    // Deliberately scoped to current levels only: the related
    // discrepancy-resolution piece (getOpenDiscrepanciesForSupplier,
    // recordVarianceDisposition) is naturally per-supplier, so it
    // belongs as a real extension of the existing Suppliers room, not
    // folded into this one — a separate, later piece of real work,
    // not built here. Reuses getTrackedStockItems directly, the exact
    // same function the debug endpoint above already calls.
    if (url.pathname === "/stock" && request.method === "GET") {
      const items = await getTrackedStockItems(env);
      return Response.json({ stockItems: items });
    }

    

    // Real feature 2026-07-25 — Snags, the smallest, most immediately
    // useful piece of the job-completion/warranty/snags design.
    if (url.pathname.match(/^\/debug\/pending-action\/\d+$/) && request.method === "GET") {
      const id = Number(url.pathname.split("/")[3]);
      const action = await env.OFFICE_DB.prepare(
        "SELECT id, type, payload, source_transcript, status FROM pending_actions WHERE id = ?"
      )
        .bind(id)
        .first();
      return Response.json({ action });
    }

    

    

    // Real, new endpoints, per direct instruction, part of the real
    // discoverability-plus-audit pass: snags has been a real, working
    // feature since 2026-07-25 (voice-only raise_snag/resolve_snag,
    // already tied into real retention release) with no discoverable
    // surface anywhere in the app — the exact class of gap named
    // earlier tonight. Reuses resolveSnag directly rather than
    // duplicating its logic — one real resolution path, whether it's
    // reached by voice or by a tap here.
    if (url.pathname === "/snags" && request.method === "GET") {
      const jobScope = await getJobScope(request, env);
      const { results } = await env.OFFICE_DB.prepare(
        `SELECT sn.id, sn.description, sn.status, sn.created_at, sn.resolved_at, sn.customer_id, c.name as customer_name
         FROM snags sn
         JOIN customers c ON c.id = sn.customer_id
         WHERE (?2 = 0 OR sn.customer_id IN (SELECT customer_id FROM job_scopes WHERE installer_id = ?1))
         ORDER BY (sn.status = 'open') DESC, sn.created_at DESC`
      )
        .bind(jobScope.characterId, jobScope.scoped ? 1 : 0)
        .all();
      return Response.json({ snags: results });
    }

    if (url.pathname.match(/^\/snags\/\d+\/resolve$/) && request.method === "POST") {
      const id = Number(url.pathname.split("/")[2]);
      const snag = await env.OFFICE_DB.prepare("SELECT customer_id, status FROM snags WHERE id = ?")
        .bind(id)
        .first<{ customer_id: number; status: string }>();
      if (!snag) {
        return Response.json({ error: "no such snag" }, { status: 404 });
      }
      if (snag.status === "resolved") {
        return Response.json({ error: "already resolved" }, { status: 400 });
      }
      const jobScope = await getJobScope(request, env);
      if (jobScope.scoped) {
        const ownsJob = await env.OFFICE_DB.prepare(
          "SELECT 1 FROM job_scopes WHERE installer_id = ? AND customer_id = ? LIMIT 1"
        )
          .bind(jobScope.characterId, snag.customer_id)
          .first();
        if (!ownsJob) return denyForRole();
      }
      const result = await resolveSnag(env, id, snag.customer_id);
      return Response.json({ status: "resolved", ...result });
    }

    // Real feature 2026-07-25 — the lead/enquiry stage, the fourth
    // real gap named from the full lead-to-warranty lifecycle walk.
    

    

    // Real, new endpoints, per direct instruction, part of the real
    // discoverability-plus-audit pass: leads has been a real, working
    // feature since 2026-07-25 (voice-only, with a real, automatic
    // enquired -> quoted transition once a real quotation is recorded
    // for the same name) with no discoverable surface anywhere in the
    // app. Reuses markLeadLost directly rather than duplicating its
    // logic — one real path, whether it's reached by voice or a tap.
    if (url.pathname === "/leads" && request.method === "GET") {
      const { results } = await env.OFFICE_DB.prepare(
        `SELECT id, name, interest, source, status, customer_id, created_at FROM leads
         ORDER BY (status IN ('enquired', 'quoted')) DESC, created_at DESC`
      ).all();
      return Response.json({ leads: results });
    }

    if (url.pathname.match(/^\/leads\/\d+\/mark-lost$/) && request.method === "POST") {
      const id = Number(url.pathname.split("/")[2]);
      const lead = await env.OFFICE_DB.prepare("SELECT status FROM leads WHERE id = ?").bind(id).first<{ status: string }>();
      if (!lead) {
        return Response.json({ error: "no such lead" }, { status: 404 });
      }
      if (lead.status === "lost") {
        return Response.json({ error: "already marked lost" }, { status: 400 });
      }
      await markLeadLost(env, id);
      return Response.json({ status: "lost" });
    }

    // The permission grid (2026-10-04, per direct instruction): the owner switches a role's capabilities on and off.
    // Owner only, by ROUTE_RULES in auth.ts (nothing a restricted role holds includes can_manage_settings). PATCH, not PUT,
    // to match every other update here and the allowed methods in the CORS headers.
    if (url.pathname === "/settings/permissions" && request.method === "GET") {
      return Response.json(await listPermissions(env));
    }
    if (url.pathname === "/settings/permissions" && request.method === "PATCH") {
      const body = (await request.json().catch(() => null)) as { role?: unknown; capability?: unknown; granted?: unknown } | null;
      if (!body || typeof body !== "object") return Response.json({ error: "Send a role, a permission and true or false." }, { status: 400 });
      const { email } = await resolveCapabilities(request, env);
      const result = await setPermission(env, body?.role, body?.capability, body?.granted, email);
      return result.ok ? Response.json({ changed: result.changed, role: result.role }) : Response.json({ error: result.error }, { status: result.status });
    }
    if (url.pathname === "/settings/permissions/reset" && request.method === "POST") {
      const body = (await request.json().catch(() => null)) as { role?: unknown } | null;
      if (!body || typeof body !== "object") return Response.json({ error: "Send the role to reset." }, { status: 400 });
      const { email } = await resolveCapabilities(request, env);
      const result = await resetRole(env, body?.role, email);
      return result.ok ? Response.json({ changed: result.changed, reverted: result.reverted ?? 0, role: result.role }) : Response.json({ error: result.error }, { status: result.status });
    }
    if (url.pathname === "/settings/permissions/audit" && request.method === "GET") {
      return Response.json(await listAudit(env, Number(url.searchParams.get("limit") ?? 20)));
    }

    // Real feature 2026-07-24 — the real prerequisite for Aged
    // Creditors, mirroring the payments table exactly, just for
    // suppliers. Built in certain anticipation of a real, recurring
    // need (a monthly supplier statement), not speculative
    // completeness.
    

    

    

    // Real feature 2026-07-21 — Supplier Invoices, the third and
    // final stage of the real, three-way PO/GRN/Supplier Invoice
    // design pinned in DECISIONS.md.
    

    

    // Real fix 2026-07-21 — closing a real gap found incidentally
    // during PDF extraction testing: every PDF generator has always
    // expected a real business_profile row (id=1), and none ever
    // existed — every generated document silently showed "[Business
    // name not set]" instead. No route existed anywhere to actually
    // set it. A real UPSERT, keyed on the fixed singleton id every
    // other query already assumes.
    

    

    // Real feature 2026-07-25 — Corporate Stationary, the grounded
    // core: a real business logo, captured via photo upload during
    // onboarding rather than typed in by hand. Reuses the exact same
    // R2 storage pattern already proven for every other photo
    // ingested tonight — no new mechanism, just a new, dedicated use
    // of one already working.
    if (url.pathname === "/business-profile/logo" && request.method === "POST") {
      // Real fix, found live: the ALTER TABLE migration for this
      // column lived only inside the separate /debug/business-profile
      // route, which was never called again after the schema change —
      // the column genuinely didn't exist yet here, causing a real
      // SQL error on the UPDATE below. Run here too, idempotent and
      // safe to re-run, so this route never depends on another one
      // having been called first.
      await runIdempotentMigration(env, "ALTER TABLE business_profile ADD COLUMN logo_r2_key TEXT");
      const formData = await request.formData();
      const logo = formData.get("logo");
      if (!(logo instanceof File)) {
        return Response.json({ error: "missing logo file" }, { status: 400 });
      }
      const logoBuffer = await logo.arrayBuffer();
      const mimeType = logo.type || "image/png";
      const extension = mimeType.includes("jpeg") || mimeType.includes("jpg") ? "jpg" : "png";
      const key = `logos/business-logo-${Date.now()}.${extension}`;
      await env.OFFICE_VAULT.put(key, logoBuffer, { httpMetadata: { contentType: mimeType } });
      await env.OFFICE_DB.prepare(
        "INSERT INTO business_profile (id, logo_r2_key) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET logo_r2_key = excluded.logo_r2_key"
      )
        .bind(key)
        .run();
      return Response.json({ status: "saved", logoKey: key });
    }

    if (url.pathname === "/business-profile/logo" && request.method === "GET") {
      const profile = await env.OFFICE_DB.prepare("SELECT logo_r2_key FROM business_profile WHERE id = 1").first<{
        logo_r2_key: string | null;
      }>();
      if (!profile?.logo_r2_key) {
        return Response.json({ error: "no logo on file" }, { status: 404 });
      }
      const object = await env.OFFICE_VAULT.get(profile.logo_r2_key);
      if (!object) {
        return Response.json({ error: "logo file missing from storage" }, { status: 404 });
      }
      const buffer = await object.arrayBuffer();
      return new Response(buffer, {
        headers: { "Content-Type": object.httpMetadata?.contentType ?? "image/png" },
      });
    }

    // Real, safe debug route — checks the real R2 object's own
    // metadata (size, etc.) without serving the full body, to
    // diagnose whether a 0-byte result is an upload-side problem
    // (empty buffer stored) or a retrieve-side problem (stream not
    // returned correctly).
    

    // Real, new, per direct instruction: linking a login to the installer
    // it actually is. A membership was only ever a Google email and a
    // role; "installers see their own jobs" needs to know that this login
    // is Liam.
    

    

    

    // Real, manual seed route until OAuth exists to create memberships
    // naturally through a real invite flow. Deliberately simple —
    // this is scaffolding to prove the schema and role map work, not
    // the real invite UX (which needs a real signed-in owner to
    // trigger it, matching the "Invite Sarah as our accountant"
    // conversational flow already designed, not yet built).
    

    // Real, needed now: a placeholder email used for early schema
    // testing needs correcting to a real, working Google account.
    

    

    

    // Real, new list endpoint for ERP mode's Tasks module. Same real
    // search/pagination shape as finance-list/suppliers-list. Tasks
    // link to either a customer or a character (never both, per the
    // real, existing schema) - joins whichever is actually set so the
    // list shows who/what a task relates to, not just its bare text.
    

    // Real, scoped action - marking a task done is a direct, human-
    // initiated action, not an edit to a financial record, so no
    // guard() question applies here the way it did for invoices.
    if (url.pathname.match(/^\/tasks\/\d+\/done$/) && request.method === "POST") {
      const taskId = Number(url.pathname.split("/")[2]);
      await env.OFFICE_DB.prepare("UPDATE tasks SET done = 1, completed_at = datetime('now') WHERE id = ?").bind(taskId).run();
      return Response.json({ status: "ok", id: taskId });
    }

    

    // The execution register's schema — see OFFICE_CONSTITUTION.md
    // Principle 16. Generic key/value on purpose: a future selection
    // type (quotation, invoice, task, a future department) never
    // needs a schema migration, just a new key.
    

    

    // Direct, tappable completion — no natural-language matching
    // needed. This is the real endpoint a future "tap to complete"
    // ember list would call.
    if (url.pathname.match(/^\/debug\/complete-task\/\d+$/) && request.method === "POST") {
      const id = Number(url.pathname.split("/")[3]);
      await completeTask(env, id);
      return Response.json({ status: "completed", id });
    }

    // Inspect a given day's life events directly — defaults to today.
    

    

    

    

    

    // Manual trigger for the same job the hourly cron runs — lets us
    // test consolidation and schema-candidate detection today instead
    // of waiting for the clock.
    

    

    // Real, scoped edit endpoint, per the real, reasoned decision:
    // voice remains the only way a document is born; this is purely
    // for editing a record that already exists. The human's
    // deliberate PATCH request is itself the guard() checkpoint - the
    // same real principle that already governs recordPayment/
    // recordInvoice, just satisfied by a direct human edit instead of
    // an AI-extracted confirm. Deliberately narrow: document-level
    // fields only (description, due_date, amount, retention_percent)
    // - not line items, a genuinely more complex, separate piece of
    // work given line_items is its own, normalized table.
    if (url.pathname.match(/^\/invoices\/\d+$/) && request.method === "PATCH") {
      const invoiceId = Number(url.pathname.split("/")[2]);
      try {
        const body = (await request.json()) as Record<string, unknown>;
        const existing = await env.OFFICE_DB.prepare("SELECT customer_id, amount, retention_percent FROM invoices WHERE id = ?")
          .bind(invoiceId)
          .first<{ customer_id: number; amount: number; retention_percent: number | null }>();
        if (!existing) {
          return Response.json({ error: "Invoice not found" }, { status: 404 });
        }

        const description = typeof body.description === "string" ? body.description : undefined;
        const amount = typeof body.amount === "number" ? body.amount : undefined;
        const dueDate = typeof body.due_date === "string" ? body.due_date : undefined;
        const retentionPercent = typeof body.retention_percent === "number" ? body.retention_percent : existing.retention_percent;

        // Real, deterministic re-derivation - the exact same formula
        // already proven in recordInvoice, never re-guessed by an AI.
        const effectiveAmount = amount ?? existing.amount;
        const retentionAmount = retentionPercent ? Math.round(effectiveAmount * (retentionPercent / 100) * 100) / 100 : 0;

        await env.OFFICE_DB.prepare(
          `UPDATE invoices SET
             description = COALESCE(?, description),
             amount = COALESCE(?, amount),
             due_date = COALESCE(?, due_date),
             retention_percent = ?,
             retention_amount = ?
           WHERE id = ?`
        )
          .bind(description ?? null, amount ?? null, dueDate ?? null, retentionPercent, retentionAmount, invoiceId)
          .run();

        return Response.json({ status: "ok", id: invoiceId });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
      }
    }

    if (url.pathname.match(/^\/quotations\/\d+$/) && request.method === "PATCH") {
      const quotationId = Number(url.pathname.split("/")[2]);
      try {
        const body = (await request.json()) as Record<string, unknown>;
        const existing = await env.OFFICE_DB.prepare("SELECT id FROM quotations WHERE id = ?").bind(quotationId).first();
        if (!existing) {
          return Response.json({ error: "Quotation not found" }, { status: 404 });
        }

        const description = typeof body.description === "string" ? body.description : undefined;
        const amount = typeof body.amount === "number" ? body.amount : undefined;

        await env.OFFICE_DB.prepare(
          `UPDATE quotations SET
             description = COALESCE(?, description),
             amount = COALESCE(?, amount)
           WHERE id = ?`
        )
          .bind(description ?? null, amount ?? null, quotationId)
          .run();

        return Response.json({ status: "ok", id: quotationId });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
      }
    }

    // Real, scoped edit endpoint - same principle as invoices/
    // quotations: a customer record already exists once voice
    // creates it (customers only ever gets a name at creation, per
    // the real, confirmed insert), so editing it is genuinely
    // different from creating one from nothing. Deliberately narrow
    // to the two fields confirmed to actually exist in the schema
    // (name, address, per generateStatementPdf's own real query) -
    // no phone/email, since no evidence those columns exist; adding
    // them would need a real, separate migration, not assumed here.
    if (url.pathname.match(/^\/customers\/\d+$/) && request.method === "PATCH") {
      const customerId = Number(url.pathname.split("/")[2]);
      try {
        const body = (await request.json()) as Record<string, unknown>;
        const existing = await env.OFFICE_DB.prepare("SELECT id FROM customers WHERE id = ?").bind(customerId).first();
        if (!existing) {
          return Response.json({ error: "Customer not found" }, { status: 404 });
        }

        const name = typeof body.name === "string" ? body.name : undefined;
        const address = typeof body.address === "string" ? body.address : undefined;

        await env.OFFICE_DB.prepare(
          `UPDATE customers SET
             name = COALESCE(?, name),
             address = COALESCE(?, address)
           WHERE id = ?`
        )
          .bind(name ?? null, address ?? null, customerId)
          .run();

        return Response.json({ status: "ok", id: customerId });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
      }
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

    // Real, new route, per direct instruction, part of the real
    // discoverability-plus-audit pass — the fourth real domain, Aged
    // Creditors, the direct mirror of the route right above.
    if (url.pathname === "/reports/aged-creditors/pdf" && request.method === "GET") {
      try {
        const pdfBytes = await generateAgedCreditorsPdf(env);
        return new Response(pdfBytes, {
          headers: {
            "Content-Type": "application/pdf",
            "Content-Disposition": `inline; filename="aged-creditors.pdf"`,
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
    

    

    // Real, new list endpoint for ERP mode's People module, per
    // direct instruction: People becomes a real, searchable/indexed
    // room, the same pattern as every other module - no more
    // bubbles/orbs. Same real search/pagination shape as
    // finance-list/suppliers-list/tasks-list.
    

    // Real, new diagnostic endpoint, added directly in response to a
    // real, immediate need: customers had no visibility anywhere in
    // the system - not in the app's UI, not in any existing
    // diagnostic endpoint - confirmed by checking directly rather
    // than assumed. Same, exact proven pattern as /debug/characters.
    // Real, new diagnostic endpoint, added directly in response to a
    // real, direct request: separate whether the pipeline and output
    // actually work from whether the current data is coherent - the
    // data can always be reset later; the machinery needs verifying
    // now. Deterministic, structured, zero AI involved - reuses the
    // exact, already-existing, already-working SQL logic (the same
    // real functions already powering voice lookups), just exposed
    // directly as real numbers instead of formatted sentences fed to
    // a model.
    

    

    // Real, new endpoint, per direct instruction, part of the real
    // discoverability-plus-audit pass: customers had no real,
    // discoverable list anywhere in the app — confirmed directly, the
    // same real finding the comment above already made once for the
    // debug version. Same real search/pagination pattern as
    // /debug/characters-list, and the same real merged_into_customer_id
    // exclusion already proven in reconcileCustomer and
    // checkCrossRoleCollision — a merged, defunct duplicate should
    // never appear in a real list either, for the same real reason.
    if (url.pathname === "/customers" && request.method === "GET") {
      const search = url.searchParams.get("search")?.trim() || null;
      const limit = Math.min(Number(url.searchParams.get("limit")) || 50, 200);
      const offset = Number(url.searchParams.get("offset")) || 0;
      const like = search ? `%${search}%` : null;

      const jobScope = await getJobScope(request, env);
      const { results: customers } = await env.OFFICE_DB.prepare(
        `SELECT id, name, address, created_at FROM customers
         WHERE merged_into_customer_id IS NULL AND (?1 IS NULL OR name LIKE ?2 OR address LIKE ?2)
           AND (?6 = 0 OR id IN (SELECT customer_id FROM job_scopes WHERE installer_id = ?5))
         ORDER BY name ASC
         LIMIT ?3 OFFSET ?4`
      )
        .bind(search, like, limit, offset, jobScope.characterId, jobScope.scoped ? 1 : 0)
        .all<{ id: number; name: string; address: string | null; created_at: string }>();

      return Response.json({ items: customers, limit, offset });
    }

    // Real, new endpoint, per direct instruction: getJobProfitability
    // has been real, working data since 2026-07-22, only ever
    // surfaced as the answer to one specific spoken business question
    // — never browsable for a given customer. Reuses it directly.
    // Real, second phase, per direct instruction: getCustomerFinancialSummary
    // folded into this same response rather than a second round-trip
    // — the natural, direct extension of the same real customer detail
    // this endpoint already serves.
    if (url.pathname.match(/^\/customers\/\d+\/profitability$/) && request.method === "GET") {
      const id = Number(url.pathname.split("/")[2]);
      const result = await getJobProfitability(env, id);
      const financialSummary = await getCustomerFinancialSummary(env, id);
      return Response.json({ profitability: result, financialSummary });
    }

    // Real, new endpoints, per direct instruction, real phase 2 of the
    // discoverability-plus-audit pass: the stock-discrepancy piece
    // deliberately deferred out of the new Stock room earlier tonight
    // — naturally per-supplier, so it belongs as a real extension of
    // the existing Suppliers room instead. Reuses
    // getOpenDiscrepanciesForSupplier and recordVarianceDisposition
    // directly, the exact same functions the voice intent already
    // calls — one real resolution path, not two.
    // The delivery exception report, decided 2026-10-03 (Pierre): every delivered item
    // that was not on an order, across suppliers. Gated in ROUTE_RULES.
    if (url.pathname === "/delivery-exceptions" && request.method === "GET") {
      const status = url.searchParams.get("status") === "all" ? "all" : "open";
      return Response.json({ exceptions: await getDeliveryExceptions(env, status) });
    }

    if (url.pathname.match(/^\/suppliers\/\d+\/discrepancies$/) && request.method === "GET") {
      const supplierId = Number(url.pathname.split("/")[2]);
      const discrepancies = await getOpenDiscrepanciesForSupplier(env, supplierId);
      return Response.json({ discrepancies });
    }

    if (url.pathname.match(/^\/suppliers\/discrepancies\/\d+\/resolve$/) && request.method === "POST") {
      const grnLineItemId = Number(url.pathname.split("/")[3]);
      const body = (await request.json().catch(() => ({}))) as {
        reason?: string;
        resolution?: string;
        creditAmount?: number;
      };
      if (!body.resolution) {
        return Response.json({ error: "requires resolution in the request body" }, { status: 400 });
      }
      const result = await recordVarianceDisposition(
        env,
        grnLineItemId,
        body.reason ?? null,
        body.resolution,
        body.creditAmount ?? null
      );
      return Response.json({ status: "resolved", ...result });
    }

    // Real, idempotent migration, per direct instruction after a
    // real, live fragmentation: one real business split into three
    // separate customer records in a single evening, because
    // REJECT-creates-new was the only usable path for a multi-
    // candidate ambiguous_person hold before this. Nullable — most
    // customers will never have this set.
    

    // Real, companion migration, per direct instruction after a real,
    // confirmed gap: customers.merged_into_customer_id alone wasn't
    // enough — the underlying people-table identity needed the exact
    // same treatment. Nullable, same as its customer-level twin.
    

    // Real, new migration, per direct instruction: the real products
    // entity for the BI-readiness audit, built the same real way as
    // every other identity-bearing table in this project — a name and
    // a merged_into column, ready for the same real merge tooling
    // already proven for customers and people, once real evidence
    // ever demands it. category is deliberately loose (a plain string,
    // not an enum) until real use shows what categories actually
    // matter — the same "don't invent structure ahead of evidence"
    // discipline as everything else built tonight.
    

    // Real, reusable merge, per direct instruction — not a one-off
    // fix for this specific case, since the underlying cause (no way
    // to resolve an already-created duplicate back into the real
    // record) will happen again. Repoints every real, live-state
    // table that references customer_id — payments, expenses,
    // invoices, quotations, stock_usage_log, snags, projects, leads,
    // job_scopes, tasks — from the losing id onto the surviving one.
    // Deliberately does NOT touch captures.customer_id: a capture is
    // the immutable record of what was actually believed true at the
    // time it was made, same discipline as everywhere else in this
    // project that refuses to rewrite raw history. The losing
    // customer row is never deleted — only marked via
    // merged_into_customer_id, so the fact a merge happened, and into
    // what, stays real and inspectable rather than silently erased.
    

    // Real, new migration, per direct instruction: the real, missing
    // merge column for characters — confirmed live duplicates exist
    // under different capitalisation (Jabulani/jabulani, Stylish/
    // stylish, Sipo/sipo), the same real fragmentation risk already
    // solved for customers, just never closed on this side.
    

    // Real, new, per direct instruction: the exact same real merge
    // mirrored for characters — a duplicate installer or supplier is
    // exactly as real a case as a duplicate customer, and this project
    // already knows how to do this properly: repoint every real table,
    // mark the loser via merged_into_*, never delete, and merge the
    // underlying people row too, the same real lesson learned the hard
    // way on the customer side (a customer-level merge alone left the
    // people-table identity behind, so the losing name kept surfacing
    // as its own candidate in future ambiguous-name checks).
    

    

    // Real diagnostic 2026-07-12 — isolating whether a name-lookup
    // bug lives in the lookup function itself or downstream in how
    // the result gets used, without going through the whole
    // extraction pipeline.
    // Real diagnostic 2026-07-13 — seeing exactly what the multi-
    // intent split produced for a real message, without guessing.
    

    

    

    // Real diagnostic 2026-07-13 — the exact live schema for a table,
    // via SQLite's own authoritative source, before writing any
    // migration that touches a constraint. Guessing at a schema from
    // memory of the code that reads it is exactly how a table
    // recreation migration could silently lose a real column.
// Real, new, per direct instruction — stage 2. The app calls this,
    // already signed in normally, right before opening any PDF link;
    // the signature it hands back is what actually lets that external-
    // browser tap through. A small allowlist of real, known document
    // paths, each with the capability that already governs it
    // elsewhere — never an open "sign anything" endpoint. Owner
    // always passes, same as ROUTE_RULES.
    if (url.pathname === "/documents/sign" && request.method === "GET") {
      const target = url.searchParams.get("path");
      if (!target) {
        return Response.json({ error: "requires path" }, { status: 400 });
      }
      const rule = SIGNABLE_DOCUMENT_PATHS.find((r) => r.pattern.test(target));
      if (!rule) {
        return Response.json({ error: "not a real, signable document path" }, { status: 400 });
      }
      if (ENFORCE_CAPABILITIES) {
        const ctx = await getMemberContext(request, env);
        if (!ctx) {
          return Response.json({ error: "sign in required" }, { status: 401 });
        }
        if (ctx.role !== "owner" && !rule.anyOf.some((c) => ctx.caps.includes(c))) {
          return denyForRole();
        }
      }
      // 10 minutes — this is for an immediate, interactive tap, not a
      // link meant to be reopened later. Customer-facing links (built
      // server-side when a quote or invoice is confirmed) sign with a
      // long expiry instead, in finance.ts, never through this route.
      const signed = await signDocumentPath(env, target, 10 * 60 * 1000);
      return Response.json({ url: `${url.origin}${target}?sig=${signed}` });
    }

    

    // Real, temporary diagnostic, per direct instruction: action #129
    // failed to confirm with only a generic "could not confirm" error
    // surfaced to the client — this calls recordQuotation directly,
    // with the exact same real payload, and returns the actual
    // underlying error instead of swallowing it, so the real cause can
    // be seen rather than guessed at.
    

    // Real, temporary diagnostic, per direct instruction, for a real
    // BI-readiness audit: checking whether line_items.description has
    // the same free-text fragmentation risk already confirmed and
    // solved for people's names ("Sipho"/"Sipo"/"Sepo") — here for
    // products instead. Real evidence before any aggregate (a "most
    // common product" query) gets built on top of this column.
    

    // Real, temporary diagnostic, per direct instruction: seeing the
    // actual product_id/room values on real, individual rows — not
    // just confirming the columns exist — to complete the real smoke
    // test for the product/room wiring.
    

    // Real, temporary diagnostic, per direct instruction: the same
    // real row-level check as /debug/recent-line-items, for the buy
    // side — real proof the two halves of the products foundation
    // actually connect, not just that the columns exist.
    

    

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

      // Real feature 2026-07-27 — remembering which kind of client
      // asked, so the callback can build the real, correct redirect
      // target. flutter_web_auth_2's web implementation requires the
      // redirect to land on the exact same origin the app is running
      // on (its own postMessage security model) — genuinely
      // different from the native theoffice:// scheme. The app
      // itself is the only thing that knows its own real origin, so
      // it's passed here, not assumed.
      const platform = url.searchParams.get("platform");
      const redirectOrigin = url.searchParams.get("redirect_origin");
      const headers = new Headers({ Location: googleUrl.toString() });
      headers.append("Set-Cookie", `oauth_state=${state}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`);
      if (platform) {
        headers.append("Set-Cookie", `oauth_platform=${encodeURIComponent(platform)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`);
      }
      if (redirectOrigin) {
        headers.append("Set-Cookie", `oauth_redirect_origin=${encodeURIComponent(redirectOrigin)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`);
      }
      return new Response(null, { status: 302, headers });
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
      // Real, final form 2026-07-27 — the redirect target is now
      // platform-aware. flutter_web_auth_2's web implementation
      // requires landing on the exact same origin the app is running
      // on (its own postMessage security model) — genuinely
      // different from native, which uses the theoffice:// scheme.
      // Falls back to native if no platform/origin was remembered
      // from /auth/google/login, since that's always been the real,
      // working path.
      const platform = getCookie(request, "oauth_platform");
      const redirectOrigin = getCookie(request, "oauth_redirect_origin");
      const callbackUrl =
        platform === "web" && redirectOrigin
          ? new URL(`${redirectOrigin}/auth-callback.html`)
          : new URL("theoffice://auth-callback");
      callbackUrl.searchParams.set("token", sessionToken);
      callbackUrl.searchParams.set("email", claims.email);
      callbackUrl.searchParams.set("role", membership.role);
      return new Response(null, {
        status: 302,
        headers: {
          Location: callbackUrl.toString(),
          "Set-Cookie": `office_session=${sessionToken}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`,
        },
      });
    }

    if (url.pathname === "/auth/me" && request.method === "GET") {
      const session = await verifySession(env, getSessionToken(request));
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

    // Real testing tool 2026-07-14 — admin-gated, since minting a
    // valid session for any email is real access, not a cosmetic
    // debug convenience. Needed precisely because a real membership
    // (like the sipho.test placeholder) doesn't necessarily have a
    // real, controllable Google account to actually sign in with —
    // this lets that membership's real, restricted behavior be
    // genuinely verified end to end anyway.
    

    // Real tables discovered from the actual live schema, never a
    // manually-typed list — the exact discipline that caught the
    // job_scopes migration issue earlier tonight, applied here so a
    // real table is never silently missed from export or flush.

    // A genuine safety snapshot before anything irreversible happens
    // — costs nothing to have, even if never needed.
    // Real fix found live 2026-07-14, twice over: the first fix only
    // wrapped the per-table loop in a try/catch, but
    // which tables exist — was completely unprotected. If that
    // specific query throws for any reason, the whole thing still
    // crashes exactly as before. Wrapping the entire handler this
    // time, not just part of it, so a real, visible error comes back
    // no matter where the actual failure is, instead of another
    // blind guess at the exact cause.
    

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
    

    // One-time schema migration for the new real, queryable date —
    // scheduled_date_raw has always been a free phrase; this is the
    // actual resolved calendar date. Same idempotent ALTER pattern as
    // every other schema-init route here.
    

    // Real feature 2026-08-09 — a genuine gap this whole debugging arc
    // ran into repeatedly: no way to see how a phrase actually gets
    // split into segments before intent classification runs, only the
    // final stored result several steps downstream. Read-only, calls
    // the real splitIntoTopics unchanged, touches no data at all —
    // meant to end guessing about this step, not just for tonight.
    

    // Real feature 2026-08-09 — the direct companion to split-test,
    // same real gap: no way to see what extractIntent actually returns
    // for a given segment, only the final downstream effect. Read-only,
    // calls the real extractIntent unchanged, touches no data.
    // Real, new diagnostic tool, added directly in response to
    // tonight's real, reported bug (a pure scheduling voice note being
    // silently discarded). The direct companion to intent-test/
    // split-test - same real gap those closed for extractIntent, now
    // closed for extractWorkObservation and the gate deciding whether
    // it actually gets recorded: no way to see either without writing
    // real data. Read-only, touches no D1 tables - safe to rerun after
    // every future change to this area, the same real, proven design
    // already established for the other diagnostic tools.
    // Real, new diagnostic tool, built per direct commitment in
    // LOOKUP_ROUTING_ARCHITECTURE.md: this classifier does not go live
    // in the real message pipeline without the same, proven,
    // zero-side-effect live-testing discipline as intent-test and
    // work-observation-test before it. Read-only, calls the real
    // classifyDashboardIntent unchanged, touches no data.
    // Real, new diagnostic tool, built before containsBackwardReference
    // ever touches the live register logic - same, proven,
    // zero-side-effect discipline as every other classifier tonight.
    // Real, new diagnostic tool, built specifically to test the real
    // identity-matching fix directly and safely: reconcileCustomer
    // itself has a real side effect (it inserts a new customer when
    // no match is found), so calling it directly here would risk
    // creating real, unwanted test data in the live database. This
    // runs only the real, now-fixed matching query itself - read-only,
    // no insert, ever.
    // Real, new diagnostic tool for reconcilePerson - genuinely
    // zero-side-effect since the function itself only ever reads,
    // never inserts. Calls the real function directly rather than
    // reimplementing its logic, so this is a true test of the actual
    // code path, not a simulation of it.
    // Real, minimal diagnostic - zero logic, no database call, no
    // function call. Built specifically to isolate whether a problem
    // affecting a brand-new route is specific to reconcilePerson/the
    // people table, or something structural affecting any new route
    // added right now.
    

    // Real backfill step from IDENTITY_ARCHITECTURE.md, per direct
    // instruction to build it. Deliberately conservative: only an
    // exact, case-insensitive full-name match links across tables;
    // anything else gets its own, separate people row rather than
    // guessing a merge - the same discipline as reconcilePerson
    // itself. Defaults to a real, safe dry-run mode (?commit=true to
    // actually write), per the architecture document's own explicit
    // caution: "run once, reviewed, not assumed correct silently."
    // Processes customers, then characters, then leads, in that
    // order, so an earlier table's newly-created person can be
    // correctly found and reused by an exact match in a later one.
    // Real, simple, direct way to find every flagged record later,
    // per direct instruction that this needs to persist rather than
    // be lost to a one-time API response.
    // Real, live schema audit, per direct instruction to continue the
    // capture_id audit - checks the actual, current database schema
    // via SQLite's own PRAGMA table_info, not static code, since many
    // real columns (leads.capture_id itself, tonight) were added via
    // separate ALTER TABLE migrations that the original CREATE TABLE
    // statements no longer reflect. Read-only.
    // Real, closing step of the capture_id audit named in tonight's
    // gameplan, per direct instruction to continue. Adds capture_id
    // to every real table the live schema audit confirmed missing it
    // - purely additive and nullable, the same low-risk, proven
    // pattern as every other migration tonight. Closes the same,
    // real structural gap leads had until tonight's fix, across every
    // other table that captures something from a live conversation.
    

    

    

    

    

    

    

    

    

    

    

    // Real, new migration, per direct instruction, matching the same
    // idempotent CREATE TABLE IF NOT EXISTS pattern already proven all
    // night. job_scopes itself stays "current truth" — every real
    // field-level change lives here permanently instead, tied to the
    // exact capture that caused it, per the amendment design just
    // logic'd out and now being built.
    

    // Real, read-only counterpart to the amendment log above — added
    // before any real amendment has happened, same "test before
    // trusting" discipline as interaction-edges' own read endpoint.
    

    // The actual calendar query — real, queryable dates, no cron
    // snapshot, no pre-computed briefing. Computed live, on request,
    // same "smallest honest version" discipline already applied to
    // the weekly-briefing gap. Defaults to the next 14 days.
    

    // Real feature 2026-07-21 — the actual, urgent need behind this
    // whole feature: reconciling retention withheld across an active,
    // two-year contract now in its final stage. Real, deterministic
    // totals — every figure summed directly from stored, real
    // invoices, never estimated.
    

    

    

    // One-time schema migration for the real captures FK columns —
    // real fix 2026-07-11, closing the gap named since day one
    // ("subject_hint is a loose text string, not a real foreign
    // key"). SQLite's ADD COLUMN has no IF NOT EXISTS, so each is
    // wrapped individually to stay safe to call more than once, same
    // as every other schema-init route here.
    // Real, deliberately narrow addition - a due_date on invoices,
    // per direct instruction: distinct in scope from payment-to-
    // invoice linking (a real business-logic decision, not attempted
    // here). This is just a real fact recorded once at creation, no
    // inference needed - makes "is this actually overdue" a real,
    // answerable question without fabricating per-invoice paid/unpaid
    // status the backend genuinely can't support yet.
    // Real, new list endpoint for ERP mode's Finance module, per
    // ERP_MODE_ARCHITECTURE.md: "one flat, searchable list per
    // module, not tabs per data type." Blends invoices and
    // quotations into one, real, searchable, paginated list -
    // replacing the old /debug/invoices and /debug/quotations'
    // arbitrary LIMIT 10 with real search and real pagination.
    // Deliberately honest about status: quotations.status is real and
    // meaningfully set (draft/converted); invoices never got a
    // meaningful status written anywhere, so due_date (now real,
    // added above) is surfaced instead of a fabricated paid/overdue
    // badge - a real, per-invoice fact, not an invented one.
    

    

    // Real, new migration, per direct instruction after a real,
    // confirmed bug: a scheduling segment ("Stylish and Charles will
    // install Monday") split away from an earlier segment that
    // created a real lead ("a call from Andre... 25m² of vinyl") had
    // no sibling job scope to attach to, since the lead never created
    // one - and no way to even find the lead, since job_scopes has
    // always had capture_id but leads never did. Same, exact proven
    // pattern as the due_date migration above.
    // Real, first, deliberately narrow step of IDENTITY_ARCHITECTURE.md,
    // per direct instruction to start building it. Purely additive -
    // creates a new, empty people table and adds nullable person_id
    // columns to customers/characters/leads. Nothing existing is
    // touched, read, or altered by this step - the real, safe
    // migration discipline already proven all night (due_date,
    // vat_exempt, leads.capture_id), applied to the identity layer's
    // own foundation before any reconciliation logic changes at all.
    

    

    // Real, first, deliberately narrow step of
    // RELATIONAL_IDENTITY_ARCHITECTURE.md, per direct instruction to
    // start building it. Stage 1 only — purely additive, creates a
    // new, empty interaction_edges table. Nothing existing is
    // touched, read, or altered by this step, the same safe migration
    // discipline already proven all night on the identity layer
    // itself. Not linked to any reconciliation decision yet — see
    // logInteractionEdge's own comment in identity.ts for why it's
    // deliberately entity-type/id based rather than person_id based.
    

    // Real, read-only counterpart to the write side above — added
    // before any real test data was fed in, per the project's own
    // "test before trusting" discipline. Joins back to customers and
    // characters by name only for readability; never writes, never
    // used by any reconciliation path.
    

    

    

    // --- end debug routes ---

    // List everything still waiting on a human decision.
    if (url.pathname === "/actions/pending" && request.method === "GET") {
      const { results } = await env.OFFICE_DB.prepare(
        "SELECT id, type, payload, source_transcript, created_at FROM pending_actions WHERE status = 'pending' ORDER BY created_at DESC"
      ).all();
      // A restricted member only sees the held actions they could act on.
      let visible = results;
      if (ENFORCE_CAPABILITIES) {
        const ctx = await getMemberContext(request, env);
        if (ctx && ctx.role !== "owner") {
          visible = results.filter((a) => {
            const needed = ACTION_TYPE_CAPABILITY[(a as { type: string }).type];
            return needed !== undefined && needed.some((c) => ctx.caps.includes(c));
          });
        }
      }
      return Response.json({ pending: visible });
    }

    // Real, new endpoint, per direct instruction: "tap and edit,"
    // not "send a new message." Deliberately scoped to
    // job_scope_amendment only, the one type actually reviewed
    // tonight — same default-deny discipline as gesture grading.
    // The real guarantee this whole endpoint exists to hold: an edit
    // can NEVER create a new pending action. It only ever updates the
    // one you're already looking at, in place, same id throughout.
    // The one bounded exception — a corrected name that's itself
    // ambiguous — is handled as a single, self-contained pick
    // (candidates returned directly in this response, resolved by a
    // second call to this same endpoint with a real personId), never
    // by spawning a second, separate pending action stacked on the
    // first.
    if (url.pathname.match(/^\/actions\/\d+\/edit-field$/) && request.method === "POST") {
      const id = Number(url.pathname.split("/")[2]);
      const body = (await request.json().catch(() => ({}))) as { field?: string; value?: string; personId?: number };
      if (!body.field || (body.value == null && body.personId == null)) {
        return Response.json({ error: "requires field, and either value or personId, in the request body" }, { status: 400 });
      }

      const action = await env.OFFICE_DB.prepare("SELECT id, type, payload, status FROM pending_actions WHERE id = ?")
        .bind(id)
        .first<{ id: number; type: string; payload: string; status: string }>();
      if (!action || action.status !== "pending") {
        return Response.json({ error: "no pending action with that id" }, { status: 404 });
      }
      if (action.type !== "job_scope_amendment") {
        return Response.json({ error: "editing isn't available for this action type yet" }, { status: 400 });
      }

      const payload = JSON.parse(action.payload) as {
        jobScopeId: number;
        jobScopeDescription: string;
        changes: Array<{ field: string; oldValue: string | null; newValue: string | null }>;
        customerId: number;
        observation: WorkObservationExtraction;
        installerId: number | null;
        transcript: string;
        captureId: number | null;
      };

      if (body.field === "scheduled_date_raw" && body.value) {
        // Real, deliberate simplicity: the client sends an exact date
        // from a real native date picker, not more natural language
        // to re-parse — nothing ambiguous here, so this updates
        // directly, no re-resolution needed.
        payload.observation.scheduled_date_raw = body.value;
        const existing = payload.changes.find((c) => c.field === "scheduled_date_raw");
        if (existing) {
          existing.newValue = body.value;
        } else {
          payload.changes.push({ field: "scheduled_date_raw", oldValue: null, newValue: body.value });
        }
        // Real, new, per direct instruction — edit-field's own real
        // race, a different shape from confirm/reject's: this route is
        // genuinely meant to be called more than once, editing
        // different fields before an eventual confirm, so the same
        // atomic-claim pattern doesn't fit here — it would refuse a
        // second, legitimate edit just as readily as a genuine race.
        // The real risk is a lost update: two edits reading the same
        // payload, each writing their own change, whichever writes
        // last silently erasing the other's. The original payload text
        // itself, read above, is the optimistic lock — this write only
        // succeeds if nothing else changed it in between.
        const result = await env.OFFICE_DB.prepare("UPDATE pending_actions SET payload = ? WHERE id = ? AND payload = ?")
          .bind(JSON.stringify(payload), id, action.payload)
          .run();
        if (result.meta.changes !== 1) {
          return Response.json({ error: "this action was edited by someone else just now — reload it and try again" }, { status: 409 });
        }
        return Response.json({
          status: "edited",
          field: "scheduled_date_raw",
          changes: [{ field: "scheduled_date_raw", label: "Date", displayValue: body.value }],
        });
      }

      if (body.field === "installer_id") {
        let resolvedId: number;
        let resolvedName: string;

        if (body.personId != null) {
          // Real, direct resolution: a specific candidate was already
          // picked (the bounded second step below), not a name to
          // re-check — skip straight to linking it, the same real
          // "does a real row already exist for this person" pattern
          // already used in the ambiguous_person CONFIRM handler.
          const existingCharacter = await env.OFFICE_DB.prepare("SELECT id, name FROM characters WHERE person_id = ?")
            .bind(body.personId)
            .first<{ id: number; name: string }>();
          if (existingCharacter) {
            resolvedId = existingCharacter.id;
            resolvedName = existingCharacter.name;
          } else {
            const person = await env.OFFICE_DB.prepare("SELECT name FROM people WHERE id = ?")
              .bind(body.personId)
              .first<{ name: string }>();
            const inserted = await env.OFFICE_DB.prepare(
              "INSERT INTO characters (name, relationship, person_id) VALUES (?, ?, ?) RETURNING id"
            )
              .bind(person?.name ?? "installer", "installer", body.personId)
              .first<{ id: number }>();
            resolvedId = inserted!.id;
            resolvedName = person?.name ?? "installer";
          }
        } else {
          // Real re-resolution, per direct instruction: a typed
          // correction to a name must go through the same real
          // reconciliation as anywhere else in this system, never
          // trusted at face value. If this is itself ambiguous, it's
          // returned here, bounded, on this same action id — never
          // spawning a new pending action of its own.
          const personCheck = await reconcilePerson(env, body.value!);
          if (personCheck?.status === "ambiguous") {
            return Response.json({ status: "ambiguous", field: "installer_id", candidates: personCheck.candidates });
          }
          const installer = await reconcileCharacter(env, body.value!, "installer");
          if (!installer) {
            return Response.json({ error: "couldn't resolve that name" }, { status: 400 });
          }
          resolvedId = installer.id;
          resolvedName = installer.name;
        }

        payload.installerId = resolvedId;
        payload.observation.installer_name = resolvedName;
        const existing = payload.changes.find((c) => c.field === "installer_id");
        if (existing) {
          existing.newValue = String(resolvedId);
        } else {
          payload.changes.push({ field: "installer_id", oldValue: null, newValue: String(resolvedId) });
        }
        // Real, new, per direct instruction — the same real, lost-update
        // protection as the scheduled_date_raw branch above, for the
        // same real reason: the original payload text read at the top
        // of this handler is the optimistic lock, so a concurrent edit
        // to a different field never gets silently erased by this one.
        const result = await env.OFFICE_DB.prepare("UPDATE pending_actions SET payload = ? WHERE id = ? AND payload = ?")
          .bind(JSON.stringify(payload), id, action.payload)
          .run();
        if (result.meta.changes !== 1) {
          return Response.json({ error: "this action was edited by someone else just now — reload it and try again" }, { status: 409 });
        }
        return Response.json({
          status: "edited",
          field: "installer_id",
          changes: [{ field: "installer_id", label: "Installer", displayValue: resolvedName }],
        });
      }

      return Response.json({ error: "unknown field" }, { status: 400 });
    }

    if (url.pathname.match(/^\/actions\/\d+\/confirm$/) && request.method === "POST") {
      // Real fix, found by the typecheck catching it before this ever
      // deployed: id was declared with const inside the try block,
      // genuinely out of scope in the catch block below where the new
      // error log needed it — the same category of scoping mistake
      // already caught once tonight elsewhere. Declared here instead,
      // in the scope both blocks actually share.
      const id = Number(url.pathname.split("/")[2]);
      try {
        const action = await env.OFFICE_DB.prepare(
          "SELECT id, type, payload, source_transcript, status FROM pending_actions WHERE id = ?"
        )
          .bind(id)
          .first<{ id: number; type: string; payload: string; source_transcript: string; status: string }>();

        if (!action) return Response.json({ error: "no such pending action" }, { status: 404 });
        if (action.status !== "pending") {
          return Response.json({ error: `action already ${action.status}` }, { status: 409 });
        }

        // Real, new, per direct instruction — the real, named gap from
        // earlier tonight: the status check above only protects against
        // a retry arriving AFTER the original fully completed, not two
        // near-simultaneous requests racing DURING processing, before
        // either has updated the status yet. An atomic claim closes
        // that gap precisely: this UPDATE can only ever genuinely
        // affect one row for one real request, even if two requests for
        // the same id reach this exact point at the same instant — the
        // second one to actually execute finds status is no longer
        // 'pending' and claims nothing. Every one of the 17 real action
        // types below keeps its own existing 'confirmed' transition
        // unchanged; it already works correctly from 'processing' the
        // same as it always did from 'pending'.
        const claim = await env.OFFICE_DB.prepare(
          "UPDATE pending_actions SET status = 'processing' WHERE id = ? AND status = 'pending'"
        )
          .bind(id)
          .run();
        if (claim.meta.changes !== 1) {
          return Response.json({ error: "already being processed" }, { status: 409 });
        }

        if (action.type === "identity_collision") {
          const payload = JSON.parse(action.payload) as {
            name: string;
            intendedRole: "customer" | "character";
            extraction: Extraction;
            transcript: string;
            captureId: number | null;
          };
          const replayRefused = await refuseReplayIfNotPermitted(request, env, id, payload.extraction);
          if (replayRefused) return replayRefused;
          // Real feature 2026-07-25 — Identity Collision, given
          // directly by Pierre. Confirming means the name genuinely
          // needs a real, new record in its intended table — an
          // installer can also, separately, become a real customer.
          // Creating that record here means the original extraction
          // can simply be reprocessed: the collision check naturally
          // won't fire a second time, since the name now exists in
          // its own, intended table, and reconcileCustomer/
          // reconcileCharacter finds it normally from here on.
          // Decided by Pierre 2026-10-04: "is this the same person, now acting as a customer too?" and the answer yes means the SAME
          // person, so the new record is linked to the person the existing one already has, exactly as the near-match answer links
          // its record. It used to insert an unlinked record, leaving one human as two unrelated entries. If the existing record has
          // no person yet, one is created and linked to both.
          const existingEntity =
            payload.intendedRole === "customer"
              ? await env.OFFICE_DB.prepare("SELECT id, person_id FROM characters WHERE name = ? COLLATE NOCASE AND merged_into_character_id IS NULL ORDER BY id LIMIT 1")
                  .bind(payload.name)
                  .first<{ id: number; person_id: number | null }>()
              : await env.OFFICE_DB.prepare("SELECT id, person_id FROM customers WHERE name = ? COLLATE NOCASE AND merged_into_customer_id IS NULL ORDER BY id LIMIT 1")
                  .bind(payload.name)
                  .first<{ id: number; person_id: number | null }>();
          let samePersonId: number | null = existingEntity?.person_id ?? null;
          if (existingEntity && samePersonId === null) {
            const created = await env.OFFICE_DB.prepare("INSERT INTO people (name) VALUES (?) RETURNING id").bind(payload.name).first<{ id: number }>();
            samePersonId = created?.id ?? null;
            if (samePersonId !== null) {
              await env.OFFICE_DB.prepare(payload.intendedRole === "customer" ? "UPDATE characters SET person_id = ? WHERE id = ?" : "UPDATE customers SET person_id = ? WHERE id = ?")
                .bind(samePersonId, existingEntity.id)
                .run();
            }
          }
          if (payload.intendedRole === "customer") {
            await env.OFFICE_DB.prepare("INSERT INTO customers (name, person_id) VALUES (?, ?)").bind(payload.name, samePersonId).run();
          } else {
            await env.OFFICE_DB.prepare("INSERT INTO characters (name, relationship, person_id) VALUES (?, ?, ?)")
              .bind(payload.name, payload.extraction.character_relationship ?? null, samePersonId)
              .run();
          }
          await env.OFFICE_DB.prepare(
            "UPDATE pending_actions SET status = 'confirmed', resolved_at = datetime('now') WHERE id = ?"
          )
            .bind(id)
            .run();
          const { capabilities: reprocessCapabilities, email: reprocessEmail } = await resolveCapabilities(request, env);
          const outcome = await processOneExtraction(
            env,
            payload.transcript,
            payload.extraction,
            [],
            ctx,
            payload.captureId,
            reprocessCapabilities,
            reprocessEmail
          );
          return Response.json({ status: "confirmed", ...outcome });
        }

        // Real, new handler, per direct instruction after a real,
        // live UX bug: the message asks a genuine yes/no question
        // only when there's exactly one real candidate — enforced
        // here too, not just at hold-time, since a request could
        // still arrive for a genuinely multi-candidate action this
        // app has no picker UI for yet (same real gap project_ambiguity
        // already has). "Yes, same person" means creating a real, new
        // row under the AS-SPOKEN name, linked to the confirmed
        // person's id — the same real pattern identity_collision
        // already uses above, so this exact spoken name resolves by
        // literal match on every future mention, without ever
        // re-triggering this same ambiguous check again.
        if (action.type === "ambiguous_person") {
          const payload = JSON.parse(action.payload) as {
            name: string;
            intendedRole: "customer" | "character";
            candidates: Array<{ id: number; name: string }>;
            extraction: Extraction;
            transcript: string;
            captureId: number | null;
          };

          // Real, new extension, per direct instruction after real,
          // live fragmentation: REJECT-creates-new was the only real
          // way to resolve a multi-candidate case, and using it
          // repeatedly split one real business across three separate
          // customer records in a single evening. personId, optional,
          // in the request body, lets CONFIRM specify exactly which
          // real candidate was meant — usable today via a direct call
          // even with no picker UI yet, and it's the same real
          // mechanism a picker would call once built. The
          // single-candidate case keeps its exact previous behavior,
          // unchanged, when no personId is sent.
          const replayRefused = await refuseReplayIfNotPermitted(request, env, id, payload.extraction);
          if (replayRefused) return replayRefused;

          const body = (await request.json().catch(() => ({}))) as { personId?: number };

          let chosenPersonId: number;
          if (body.personId != null && payload.candidates.some((c) => c.id === body.personId)) {
            chosenPersonId = body.personId;
          } else if (payload.candidates.length === 1) {
            chosenPersonId = payload.candidates[0].id;
          } else {
            await releaseClaim(env, id);
            return Response.json(
              {
                error: "More than one real candidate — pass personId in the request body to specify which one.",
                candidates: payload.candidates,
              },
              { status: 400 }
            );
          }

          if (payload.intendedRole === "customer") {
            await env.OFFICE_DB.prepare("INSERT INTO customers (name, person_id) VALUES (?, ?)").bind(payload.name, chosenPersonId).run();
          } else {
            await env.OFFICE_DB.prepare("INSERT INTO characters (name, relationship, person_id) VALUES (?, ?, ?)")
              .bind(payload.name, payload.extraction.character_relationship ?? null, chosenPersonId)
              .run();
          }

          await env.OFFICE_DB.prepare(
            "UPDATE pending_actions SET status = 'confirmed', resolved_at = datetime('now') WHERE id = ?"
          )
            .bind(id)
            .run();

          const { capabilities: reprocessCapabilities, email: reprocessEmail } = await resolveCapabilities(request, env);
          const outcome = await processOneExtraction(
            env,
            payload.transcript,
            payload.extraction,
            [],
            ctx,
            payload.captureId,
            reprocessCapabilities,
            reprocessEmail
          );
          return Response.json({ status: "confirmed", linkedToPersonId: chosenPersonId, ...outcome });
        }

        // Real, new handler, per direct instruction: "yes, update the
        // existing job" writes one real, permanent audit row per
        // field that actually changes — job_scope_id, capture_id,
        // field_name, old_value, new_value — before touching
        // job_scopes itself, so the full real history survives
        // regardless of what happens next. Only ever the two real
        // fields that have actually come up so far (scheduled_date/
        // scheduled_date_raw, installer_id) — no speculative fields
        // for changes that haven't happened yet.
        if (action.type === "job_scope_amendment") {
          const payload = JSON.parse(action.payload) as {
            jobScopeId: number;
            jobScopeDescription: string;
            changes: Array<{ field: string; oldValue: string | null; newValue: string | null }>;
            customerId: number;
            observation: WorkObservationExtraction;
            installerId: number | null;
            transcript: string;
            captureId: number | null;
          };

          for (const change of payload.changes) {
            await env.OFFICE_DB.prepare(
              "INSERT INTO job_scope_amendments (job_scope_id, capture_id, field_name, old_value, new_value) VALUES (?, ?, ?, ?, ?)"
            )
              .bind(payload.jobScopeId, payload.captureId, change.field, change.oldValue, change.newValue)
              .run();
          }

          if (payload.observation.scheduled_date_raw) {
            const scheduledDate = resolveScheduledDate(payload.observation.scheduled_date_raw, nowInBusinessTimezone());
            await env.OFFICE_DB.prepare("UPDATE job_scopes SET scheduled_date_raw = ?, scheduled_date = ? WHERE id = ?")
              .bind(payload.observation.scheduled_date_raw, scheduledDate, payload.jobScopeId)
              .run();
          }
          if (payload.installerId !== null) {
            await env.OFFICE_DB.prepare("UPDATE job_scopes SET installer_id = ? WHERE id = ?")
              .bind(payload.installerId, payload.jobScopeId)
              .run();
          }

          await env.OFFICE_DB.prepare(
            "UPDATE pending_actions SET status = 'confirmed', resolved_at = datetime('now') WHERE id = ?"
          )
            .bind(id)
            .run();

          return Response.json({ status: "confirmed", amendedJobScopeId: payload.jobScopeId, changes: payload.changes });
        }

        // Real feature 2026-07-25 — Layer 2 (Project), the
        // ask-when-2-plus rung. Unlike every other confirmation in
        // this project, this one genuinely needs a choice among
        // several real options, not a simple yes — the real project
        // id must be given in the request body.
        if (action.type === "project_ambiguity") {
          const payload = JSON.parse(action.payload) as {
            jobScopeId: number;
            candidates: Array<{ id: number; description: string | null }>;
          };
          const body = (await request.json().catch(() => ({}))) as { projectId?: number };
          const chosen = payload.candidates.find((c) => c.id === body.projectId);
          if (!chosen) {
            await releaseClaim(env, id);
            return Response.json(
              {
                error: "a real projectId matching one of the candidates must be given",
                candidates: payload.candidates,
              },
              { status: 400 }
            );
          }
          await env.OFFICE_DB.prepare("UPDATE job_scopes SET project_id = ? WHERE id = ?")
            .bind(chosen.id, payload.jobScopeId)
            .run();
          await env.OFFICE_DB.prepare(
            "UPDATE pending_actions SET status = 'confirmed', resolved_at = datetime('now') WHERE id = ?"
          )
            .bind(id)
            .run();
          return Response.json({ status: "confirmed", jobScopeId: payload.jobScopeId, attachedToProject: chosen });
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

        // Real branch, per direct reasoning worked through with real,
        // verified CSV data: a genuinely still-outstanding, imported
        // historical invoice - the one case from a bulk import that
        // actually changes a customer's live, current balance. Only
        // created here, on explicit confirmation - never written
        // directly by the CSV import itself.
        if (action.type === "imported_invoice") {
          const payload = JSON.parse(action.payload) as {
            customerId: number;
            description: string;
            amount: number;
            date: string | null;
            payments: Array<{ amount: number; date: string | null; method: string | null }>;
          };
          await env.OFFICE_DB.prepare(
            "INSERT INTO invoices (customer_id, description, amount, source_transcript) VALUES (?, ?, ?, ?)"
          )
            .bind(payload.customerId, payload.description, payload.amount, action.source_transcript)
            .run();
          for (const payment of payload.payments) {
            await env.OFFICE_DB.prepare("INSERT INTO payments (customer_id, amount, source_transcript) VALUES (?, ?, ?)")
              .bind(payload.customerId, payment.amount, `${action.source_transcript}, paid ${payment.date ?? ""} via ${payment.method ?? "unknown"}`)
              .run();
          }
          await env.OFFICE_DB.prepare(
            "UPDATE pending_actions SET status = 'confirmed', resolved_at = datetime('now') WHERE id = ?"
          )
            .bind(id)
            .run();
          return Response.json({ status: "confirmed" });
        }

        // Real feature 2026-07-24 — the real prerequisite for Aged
        // Creditors, mirroring the real, guard()d payment write
        // exactly, just for the supplier side of money moving.
        if (action.type === "supplier_payment") {
          const payload = JSON.parse(action.payload) as {
            characterId: number;
            characterName?: string;
            amount: number | null;
          };
          const supplierPayment = await recordSupplierPayment(env, payload.characterId, payload.amount, action.source_transcript);
          await env.OFFICE_DB.prepare(
            "UPDATE pending_actions SET status = 'confirmed', resolved_at = datetime('now') WHERE id = ?"
          )
            .bind(id)
            .run();
          return Response.json({ status: "confirmed", supplierPayment });
        }

        // Real feature 2026-07-21 — Goods Received Notes, the second
        // stage of the real, three-way PO/GRN/Supplier Invoice design
        // pinned in DECISIONS.md. The real point of confirming this:
        // a real, deterministic quantity variance, computed in
        // recordGoodsReceived, returned here so Peter sees it
        // immediately, not buried in a debug route.
        if (action.type === "cancel_order") {
          const payload = JSON.parse(action.payload) as { purchaseOrderId: number; supplierName?: string };
          const { email: cancelledBy } = await resolveCapabilities(request, env);
          const cancelled = await cancelPurchaseOrder(env, payload.purchaseOrderId, cancelledBy);
          await env.OFFICE_DB.prepare(
            "UPDATE pending_actions SET status = 'confirmed', resolved_at = datetime('now') WHERE id = ?"
          )
            .bind(id)
            .run();
          return Response.json({
            status: "confirmed",
            cancelled,
            message: cancelled.alreadyCancelled
              ? `${payload.supplierName ?? "That"} order #${payload.purchaseOrderId} was already cancelled.`
              : `Cancelled ${payload.supplierName ?? "the"} order #${payload.purchaseOrderId}.${cancelled.closedShortages > 0 ? ` ${cancelled.closedShortages} open shortage${cancelled.closedShortages === 1 ? "" : "s"} on it closed with it.` : ""}`,
          });
        }

        if (action.type === "stock_add") {
          // Decided 2026-10-03 (Pierre): "Add to stock?" on delivery. Confirming registers each item
          // that is not yet stock and adds what arrived; rejecting just leaves the question on record
          // as declined, which is what stops it being asked again.
          const payload = JSON.parse(action.payload) as { items?: Array<{ name: string; unit: string | null; quantity: number }> };
          const added = await addDeliveredItemsToStock(env, Array.isArray(payload.items) ? payload.items : []);
          await env.OFFICE_DB.prepare(
            "UPDATE pending_actions SET status = 'confirmed', resolved_at = datetime('now') WHERE id = ?"
          )
            .bind(id)
            .run();
          return Response.json({
            status: "confirmed",
            addedToStock: added,
            message:
              added.length > 0
                ? `Added to stock: ${added.map((a) => `${a.name} (${a.quantity}${a.unit ? ` ${a.unit}` : ""})`).join(", ")}.`
                : "Nothing to add to stock.",
          });
        }

        if (action.type === "goods_received") {
          const payload = JSON.parse(action.payload) as {
            purchaseOrderId: number;
            supplierId: number | null;
            supplierName?: string;
            // Set on every hold made since 2026-10-03: the lines are placed against the supplier's
            // outstanding orders when confirmed. Older held actions lack it and are recorded the old way.
            allocate?: boolean;
            lineItems: Array<{ matched_description: string | null; quantity_received: number; item_description?: string | null; unit?: string | null }>;
          };
          // Real design decision 2026-07-21 — GRN capture stays open
          // to anyone in the organisation on purpose (quantity-only,
          // no money involved), but who actually recorded it is a
          // real, permanent fact, not an anonymous action.
          const { email: recordedByEmail } = await resolveCapabilities(request, env);
          if (payload.allocate && payload.supplierId != null) {
            const delivered = await recordDelivery(env, payload.supplierId, action.source_transcript, payload.lineItems, recordedByEmail);
            await env.OFFICE_DB.prepare(
              "UPDATE pending_actions SET status = 'confirmed', resolved_at = datetime('now') WHERE id = ?"
            )
              .bind(id)
              .run();
            // Decided 2026-10-03 (Pierre): items that arrived and are not stock are asked about, once, with
            // a tap. Asked only after the delivery is safely recorded, and never allowed to undo it.
            let stockAsk: { id: number; message: string } | null = null;
            try {
              stockAsk = await proposeStockAdditions(env, delivered.notInStock, payload.supplierName ?? null);
            } catch {
              // The delivery itself is already recorded; a failed question is not a failed delivery.
            }
            return Response.json({
              status: "confirmed",
              goodsReceived: delivered,
              message: stockAsk ? `${deliveryRecordedMessage(delivered)} ${stockAsk.message}` : deliveryRecordedMessage(delivered),
              pendingActionId: stockAsk ? stockAsk.id : null,
              pendingActionType: stockAsk ? "stock_add" : null,
            });
          }
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
          return Response.json({
            status: "confirmed",
            goodsReceived: recorded,
            // Said in words so the app can show it (decided 2026-10-03): what was
            // received, and that anything not on the order was logged as an exception.
            message: `Delivery recorded (GRN #${recorded.grnId}).${
              recorded.exceptions.length > 0
                ? ` ${recorded.exceptions.length} item(s) weren't on the order and were logged as delivery exceptions.`
                : ""
            }`,
          });
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

        // Real feature 2026-07-24 — Variance Disposition, the real,
        // second half: a credit resolution's real financial write-off,
        // confirmed here since real money is moving. The confirming
        // user's identity is resolved directly here — the real,
        // guarded moment this matters, unlike raising a plain reason.
        if (action.type === "variance_disposition") {
          const payload = JSON.parse(action.payload) as {
            grnLineItemId: number;
            description: string;
            reason: string | null;
            resolution: string | null;
            creditAmount: number | null;
          };
          const { email: confirmedByEmail } = await resolveCapabilities(request, env);
          const recorded = await recordVarianceDisposition(
            env,
            payload.grnLineItemId,
            payload.reason,
            payload.resolution,
            payload.creditAmount,
            confirmedByEmail
          );
          await env.OFFICE_DB.prepare(
            "UPDATE pending_actions SET status = 'confirmed', resolved_at = datetime('now') WHERE id = ?"
          )
            .bind(id)
            .run();
          return Response.json({ status: "confirmed", disposition: recorded });
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
            invoice.amount,
            (p) => signDocumentPath(env, p, 365 * 24 * 60 * 60 * 1000)
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
            quotation.amount,
            (p) => signDocumentPath(env, p, 365 * 24 * 60 * 60 * 1000)
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
            payload.remainingBalance,
            (p) => signDocumentPath(env, p, 365 * 24 * 60 * 60 * 1000)
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

        // Real, new, per direct instruction: this action was genuinely
        // claimed above (now 'processing'), but no real type matched,
        // so nothing actually happened — reverted back to 'pending'
        // rather than left stuck, so a future, correct confirm attempt
        // (after a real code fix adds support for this type, say)
        // isn't permanently blocked by a claim that did no real work.
        await env.OFFICE_DB.prepare("UPDATE pending_actions SET status = 'pending' WHERE id = ?").bind(id).run();
        return Response.json({ error: `unknown pending action type: ${action.type}` }, { status: 400 });
      } catch (err) {
        // This handler never had error handling wrapped around it at
        // all — an uncaught exception here just produced Cloudflare's
        // generic crash page, with no way to see what actually broke.
        // Real, added tonight: also logged with the same requestId as
        // the request that triggered it, searchable afterward, not
        // only visible if someone happened to be watching the live
        // stream at the exact moment this specific confirm broke.
        //
        // Also reverted back to 'pending' here, per direct instruction
        // — a genuine failure partway through real work must not
        // leave the action permanently stuck at 'processing', unable
        // to ever be confirmed or retried again. Best-effort: if even
        // this revert fails, there's nothing further to do beyond
        // what's already logged above.
        const detail = err instanceof Error ? err.message : String(err);
        log("error", requestId, "confirm handler threw", { actionId: id, detail });
        try {
          await env.OFFICE_DB.prepare("UPDATE pending_actions SET status = 'pending' WHERE id = ?").bind(id).run();
        } catch {
          // Nothing further to do if even the revert fails.
        }
        return Response.json({ error: "confirm handler threw", detail }, { status: 500 });
      }
    }

    if (url.pathname.match(/^\/actions\/\d+\/reject$/) && request.method === "POST") {
      const id = Number(url.pathname.split("/")[2]);
      try {
        // Real, deliberate difference from every other action type's
        // reject, per direct instruction after a real, live UX bug:
        // "no, it's a different person" must still complete the real
        // message it came from — discarding it entirely, this action
        // type's only behavior until now, would silently lose "Sepo
        // doing the install" along with the identity question, not just
        // decline the match. Every other action type keeps the real,
        // original discard-only behavior below, unchanged.
        const action = await env.OFFICE_DB.prepare(
          "SELECT id, type, payload, status FROM pending_actions WHERE id = ?"
        )
          .bind(id)
          .first<{ id: number; type: string; payload: string; status: string }>();

        if (!action) return Response.json({ error: "no such pending action" }, { status: 404 });
        if (action.status !== "pending") {
          return Response.json({ error: `action already ${action.status}` }, { status: 409 });
        }

        // Real, new, per direct instruction — the same real gap as
        // confirm, found and fixed in the same pass: ambiguous_person
        // and job_scope_amendment below both do real, consequential
        // work (creating a real person/customer/character row, or a
        // real job scope) after only a non-atomic read of status, the
        // exact shape that let two near-simultaneous requests both
        // pass the check before either updated it. The plain fallback
        // path further down was already safe on its own (a direct
        // UPDATE ... WHERE status = 'pending'), but claiming here
        // first, for all three paths alike, is simpler and more
        // consistent than reasoning about two different protections
        // for two different shapes.
        const claim = await env.OFFICE_DB.prepare(
          "UPDATE pending_actions SET status = 'processing' WHERE id = ? AND status = 'pending'"
        )
          .bind(id)
          .run();
        if (claim.meta.changes !== 1) {
          return Response.json({ error: "already being processed" }, { status: 409 });
        }

        if (action.type === "ambiguous_person") {
          const payload = JSON.parse(action.payload) as {
            name: string;
            intendedRole: "customer" | "character";
            extraction: Extraction;
            transcript: string;
            captureId: number | null;
          };

          const replayRefused = await refuseReplayIfNotPermitted(request, env, id, payload.extraction);
          if (replayRefused) return replayRefused;

          const insertedPerson = await env.OFFICE_DB.prepare("INSERT INTO people (name) VALUES (?) RETURNING id")
            .bind(payload.name)
            .first<{ id: number }>();
          const newPersonId = insertedPerson!.id;

          if (payload.intendedRole === "customer") {
            await env.OFFICE_DB.prepare("INSERT INTO customers (name, person_id) VALUES (?, ?)").bind(payload.name, newPersonId).run();
          } else {
            await env.OFFICE_DB.prepare("INSERT INTO characters (name, relationship, person_id) VALUES (?, ?, ?)")
              .bind(payload.name, payload.extraction.character_relationship ?? null, newPersonId)
              .run();
          }

          await env.OFFICE_DB.prepare(
            "UPDATE pending_actions SET status = 'rejected', resolved_at = datetime('now') WHERE id = ?"
          )
            .bind(id)
            .run();

          const { capabilities: reprocessCapabilities, email: reprocessEmail } = await resolveCapabilities(request, env);
          const outcome = await processOneExtraction(
            env,
            payload.transcript,
            payload.extraction,
            [],
            ctx,
            payload.captureId,
            reprocessCapabilities,
            reprocessEmail
          );
          return Response.json({ status: "rejected_as_new_person", newPersonId, ...outcome });
        }

        // Real, new branch, per direct instruction: "no, it's a separate
        // new job" must actually create that job — exactly what would
        // have happened had the amendment check never fired — not just
        // discard the real content of the message the way this
        // action type's reject would otherwise do.
        if (action.type === "job_scope_amendment") {
          const payload = JSON.parse(action.payload) as {
            customerId: number;
            observation: WorkObservationExtraction;
            installerId: number | null;
            transcript: string;
            captureId: number | null;
          };

          const recorded = await recordWorkObservation(
            env,
            payload.customerId,
            payload.observation,
            payload.transcript,
            payload.installerId,
            payload.captureId
          );

          await env.OFFICE_DB.prepare(
            "UPDATE pending_actions SET status = 'rejected', resolved_at = datetime('now') WHERE id = ?"
          )
            .bind(id)
            .run();

          return Response.json({ status: "rejected_as_new_job", newJobScopeId: recorded.jobScopeId });
        }

        await env.OFFICE_DB.prepare(
          "UPDATE pending_actions SET status = 'rejected', resolved_at = datetime('now') WHERE id = ?"
        )
          .bind(id)
          .run();
        if (action.type === "identity_collision") {
          // Decided by Pierre 2026-10-04: "no, someone else was meant" used to drop what was said without a word, and the person
          // had to notice and say it all again. Now the reply says what was not recorded.
          let said = "";
          try {
            said = String((JSON.parse(action.payload) as { transcript?: string }).transcript ?? "").trim();
          } catch {
            said = "";
          }
          const shown = said.length > 120 ? `${said.slice(0, 117)}...` : said;
          return Response.json({
            status: "rejected",
            id,
            message: shown
              ? `Okay, nothing was recorded. I didn't act on "${shown}". Say it again with the name you meant.`
              : "Okay, nothing was recorded. Say it again with the name you meant.",
          });
        }
        return Response.json({ status: "rejected", id });
      } catch (err) {
        // Real, new, per direct instruction — the same real gap as
        // confirm, fixed the same way: this handler never had error
        // handling wrapped around it at all before now. Logged with
        // the same requestId as the request that triggered it, and
        // reverted back to 'pending' rather than left stuck at
        // 'processing' forever if a genuine failure happens partway
        // through real work (creating the new person, recording the
        // new job scope).
        const detail = err instanceof Error ? err.message : String(err);
        log("error", requestId, "reject handler threw", { actionId: id, detail });
        try {
          await env.OFFICE_DB.prepare("UPDATE pending_actions SET status = 'pending' WHERE id = ?").bind(id).run();
        } catch {
          // Nothing further to do if even the revert fails.
        }
        return Response.json({ error: "reject handler threw", detail }, { status: 500 });
      }
    }

    // "Talk" mode. Full pipeline: store audio, transcribe, extract,
    // reconcile, guard, remember.
    if (url.pathname === "/files/audio" && request.method === "POST") {
      const formData = await request.formData();
      const audio = formData.get("audio");
      const historyRaw = formData.get("history");
      // Real, per direct instruction — extending the same real
      // idempotency protection to the upload path: a real network drop
      // after the server has already stored the file and done real
      // work, but before the response reaches the client, looks
      // identical to total failure from the app's side — without this,
      // the same audio/photo/document would be captured and processed
      // twice.
      const idempotencyKey = (formData.get("idempotency_key") as string | null) ?? null;
      const idempotencyResult = await checkIdempotencyKey(env, idempotencyKey);
      if (idempotencyResult) return idempotencyResult;
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
      const { capabilities: voiceCapabilities, email: voiceEmail } = await resolveCapabilities(request, env);
      // Found by the characterization recordings 2026-10-04: when the transcription failed or came back empty, the audio was
      // stored but NOTHING was written to the database, so no record pointed at the file and it could never be found or
      // retried, while the person was told it had been received. Documents and photos have always logged a capture before
      // anything else; audio only did so inside a successful transcription.
      if (!transcript) await logCapture(env, "[voice note — transcription unavailable]", "voice", key);
      const processed = transcript
        ? await processTranscript(env, transcript, ctx, history, "voice", key, voiceCapabilities, voiceEmail)
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

      const audioResponseBody = JSON.stringify({ status: "stored", key, transcript, transcriptionError, ...processed });
      await completeIdempotencyKey(env, idempotencyKey, audioResponseBody);
      return new Response(audioResponseBody, { headers: { "Content-Type": "application/json" } });
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
    // Real, separate, deterministic path for bulk customer
    // onboarding, per direct reasoning: a CSV has real, structured
    // columns - no AI inference needed, unlike a PDF's raw text. This
    // is genuinely different from - and does not touch - the existing
    // voice-first pipeline. Reuses reconcileCustomer directly, the
    // same, proven dedupe logic voice capture already uses, not
    // reinvented. V1 scope, deliberately narrow: customers only (name,
    // address) - no money, no guard() question, the simplest real
    // table to get right first.
    // Real, second half of bulk onboarding, per direct reasoning
    // worked through against the actual, real, uploaded file - not
    // assumed. Every row becomes a real invoice + its real payment
    // history unconditionally, since these are historical records,
    // not new financial decisions. But rows with a real, positive
    // balance due - genuinely still outstanding today, confirmed 24
    // of 295 real rows via direct verification against the real file
    // - are held via the same, already-proven guard()/pending
    // mechanism rather than silently, immediately changing a
    // customer's current balance. Reuses reconcileCustomer directly,
    // the same dedupe logic already proven for the customer import.
    if (url.pathname === "/files/invoices-csv-import" && request.method === "POST") {
      const formData = await request.formData();
      const csvFile = formData.get("csv");
      if (!(csvFile instanceof File)) {
        return Response.json({ error: "missing csv file" }, { status: 400 });
      }

      const text = await csvFile.text();
      const rows = parseCsv(text);
      if (rows.length < 2) {
        return Response.json({ error: "CSV has no data rows" }, { status: 400 });
      }

      const header = rows[0].map((h) => h.trim());
      const idx = (name: string) => header.indexOf(name);
      const invoiceIdx = idx("Invoice");
      const dateIdx = idx("Date");
      const clientIdx = idx("Client");
      const totalIdx = idx("Total");
      const paidIdx = idx("Paid");
      const balanceIdx = idx("Balance due");
      const detailsIdx = idx("Payment details");

      if (invoiceIdx === -1 || clientIdx === -1 || totalIdx === -1) {
        return Response.json({ error: "This doesn't look like an Invoice Simple export - missing Invoice, Client, or Total column" }, { status: 400 });
      }

      let imported = 0;
      let heldForConfirmation = 0;
      let skipped = 0;
      const skippedRows: number[] = [];

      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        const invoiceNumber = row[invoiceIdx]?.trim();
        const clientName = row[clientIdx]?.trim();
        const total = parseFloat(row[totalIdx]);

        if (!invoiceNumber || !clientName || isNaN(total)) {
          skipped++;
          skippedRows.push(i + 1);
          continue;
        }

        const customer = await reconcileCustomer(env, clientName);
        if (!customer) {
          skipped++;
          skippedRows.push(i + 1);
          continue;
        }

        const balance = balanceIdx !== -1 ? parseFloat(row[balanceIdx]) || 0 : 0;
        const payments = detailsIdx !== -1 ? parsePaymentDetails(row[detailsIdx]) : [];
        const description = `Imported invoice ${invoiceNumber} (Invoice Simple)`;
        const sourceNote = `CSV import: ${invoiceNumber}, ${clientName}`;

        if (balance > 0.01) {
          // Real, genuinely still-outstanding invoice - held, not
          // written directly, per the real reasoning that this is the
          // one case that actually changes a customer's live balance.
          await holdForConfirmation(
            env,
            "imported_invoice",
            { customerId: customer.id, description, amount: total, date: row[dateIdx] || null, payments },
            sourceNote
          );
          heldForConfirmation++;
        } else {
          // Fully settled historical record - real, unconditional
          // import. Net effect on the live balance is zero either
          // way, so this is recordkeeping, not a new financial
          // decision requiring confirmation.
          await env.OFFICE_DB.prepare(
            "INSERT INTO invoices (customer_id, description, amount, source_transcript) VALUES (?, ?, ?, ?)"
          )
            .bind(customer.id, description, total, sourceNote)
            .run();
          for (const payment of payments) {
            await env.OFFICE_DB.prepare("INSERT INTO payments (customer_id, amount, source_transcript) VALUES (?, ?, ?)")
              .bind(customer.id, payment.amount, `${sourceNote}, paid ${payment.date ?? ""} via ${payment.method ?? "unknown"}`)
              .run();
          }
          imported++;
        }
      }

      return Response.json({ status: "ok", totalRows: rows.length - 1, imported, heldForConfirmation, skipped, skippedRows });
    }

    if (url.pathname === "/files/customers-csv-import" && request.method === "POST") {
      const formData = await request.formData();
      const csvFile = formData.get("csv");
      if (!(csvFile instanceof File)) {
        return Response.json({ error: "missing csv file" }, { status: 400 });
      }

      const text = await csvFile.text();
      const rows = parseCsv(text);
      if (rows.length < 2) {
        return Response.json({ error: "CSV has no data rows" }, { status: 400 });
      }

      // Real, deterministic header mapping - matching known aliases,
      // never inferred. A column that doesn't match any known alias
      // is simply ignored, not guessed at.
      const header = rows[0].map((h) => h.trim().toLowerCase());
      const nameIndex = header.findIndex((h) => ["name", "customer", "customer name", "client", "client name"].includes(h));
      const addressIndex = header.findIndex((h) => ["address", "customer address"].includes(h));

      if (nameIndex === -1) {
        return Response.json({ error: "No recognizable name column found in the CSV header" }, { status: 400 });
      }

      let created = 0;
      let matched = 0;
      let skipped = 0;
      const skippedRows: number[] = [];

      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        const rawName = row[nameIndex]?.trim();
        if (!rawName) {
          skipped++;
          skippedRows.push(i + 1);
          continue;
        }

        const customer = await reconcileCustomer(env, rawName);
        if (!customer) {
          skipped++;
          skippedRows.push(i + 1);
          continue;
        }

        if (customer.matched) {
          matched++;
        } else {
          created++;
        }

        const address = addressIndex !== -1 ? row[addressIndex]?.trim() : undefined;
        if (address) {
          await env.OFFICE_DB.prepare("UPDATE customers SET address = COALESCE(address, ?) WHERE id = ?")
            .bind(address, customer.id)
            .run();
        }
      }

      return Response.json({ status: "ok", totalRows: rows.length - 1, created, matched, skipped, skippedRows });
    }

    if (url.pathname === "/files/document" && request.method === "POST") {
      const formData = await request.formData();
      const document = formData.get("document");
      const caption = formData.get("caption");
      // Real, per direct instruction — same real protection as audio:
      // a network drop after real work is already done but before the
      // response arrives looks identical to total failure client-side.
      const idempotencyKey = (formData.get("idempotency_key") as string | null) ?? null;
      const idempotencyResult = await checkIdempotencyKey(env, idempotencyKey);
      if (idempotencyResult) return idempotencyResult;

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
      let captionIntent: string | null = null;
      let captionRefusal: string | null = null;
      let rawText = description;
      if (typeof caption === "string" && caption.trim().length > 0) {
        const captionText = caption.trim();
        rawText = `${captionText}\n\n[Document: ${description}]`;
        const { extraction } = await extractIntent(env, captionText);
        captionIntent = extraction?.intent ?? null;
        // Decided by Pierre 2026-10-04: the caption gets the same permission check as dictation, before anyone is created.
        // It used to create the customer or supplier it named for ANY member, however little they were allowed to record
        // (an installer's "Brand New Person lounge quote" created a customer before any check). A refused role can still
        // have the file linked to someone who is already on file (finding is harmless) but can no longer create anyone, and
        // the response says why the caption was not acted on.
        const { capabilities: captionCapabilities } = await resolveCapabilities(request, env);
        captionRefusal = intentCreationRefusal(captionIntent, captionCapabilities);
        if (extraction?.customer_name) {
          const customer = captionRefusal
            ? await findExistingCustomerByName(env, extraction.customer_name)
            : await reconcileCustomer(env, extraction.customer_name);
          subjectHint = customer?.name ?? null;
          subjectCustomerId = customer?.id ?? null;
        } else if (extraction?.character_name) {
          const character = captionRefusal
            ? await findExistingCharacterByName(env, extraction.character_name)
            : await reconcileCharacter(env, extraction.character_name, extraction.character_relationship);
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
      // Real fix 2026-07-25, found live via a genuinely poor-quality
      // real photo test: this always assumed a photographed supplier
      // document was an invoice. A real delivery note has no pricing
      // at all — extractSupplierInvoice correctly refused to invent a
      // price (every unit_price_billed came back null), but the
      // result still got held as a real "supplier_invoice" action,
      // which would have created an invalid expense if confirmed.
      // Checked here now: if every matched line item has no real
      // price at all, this is a delivery note, not an invoice — GRN
      // is the correct, real path, unguarded and recorded directly,
      // matching GRN's own precedent exactly (quantity-only, no money
      // moving, traceable rather than gated).
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
        const classified = classifyGoodsReceivedLines(grnExtraction.line_items, candidates);
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
          uploadMessage = deliveryHeldMessage(plan, supplierLabel, inferredFromDocument, heldGrn.id, outstanding.length > 0);
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
            uploadMessage = `${deliveryRecordedMessage(recorded)} ${stockAsk.message}`;
          } else if (deliveryHadExceptions(recorded)) {
            uploadMessage = deliveryRecordedMessage(recorded);
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
          uploadMessage = `Statement from ${subjectHint ?? "the supplier"}${inferredFromDocument ? " (read from the document)" : ""}: they claim R${stmtExtraction.claimed_closing_balance}, our records show R${realBalance}.`;
        } else {
          uploadMessage = `I couldn't find a closing balance on this statement from ${subjectHint ?? "the supplier"}, so nothing was compared.`;
        }
      } else if (subjectCharacterId) {
        const openPo = await findLatestOpenPurchaseOrder(env, subjectCharacterId);
        if (openPo) {
          const poLineItems = await getPurchaseOrderLineItems(env, openPo.id);
          const siExtraction = await extractSupplierInvoice(env, description, poLineItems);
          const hasRealPricing = siExtraction.line_items.some((li) => li.unit_price_billed != null);
          if (siExtraction.line_items.length > 0 && hasRealPricing && supplierInvoiceRefusal) {
            uploadRefusal = supplierInvoiceRefusal;
          } else if (siExtraction.line_items.length > 0 && hasRealPricing) {
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
            uploadHeldActionId = held.id;
            uploadMessage = `Supplier invoice noted from ${subjectHint ?? "the supplier"}${inferredFromDocument ? " (read from the document)" : ""} — needs your confirmation (action #${held.id}) before it's recorded.`;
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

      const docResponseBody = JSON.stringify({ status: "stored", refusal: uploadRefusal, message: uploadRefusal ?? uploadMessage, pendingActionId: uploadHeldActionId, key, captureId, description, subjectHint, supplierInvoiceAction, goodsReceivedAction, supplierStatementAction });
      await completeIdempotencyKey(env, idempotencyKey, docResponseBody);
      return new Response(docResponseBody, { headers: { "Content-Type": "application/json" } });
    }

    if (url.pathname === "/files/photo" && request.method === "POST") {
      const formData = await request.formData();
      const photo = formData.get("photo");
      const caption = formData.get("caption");
      // Real, per direct instruction — same real protection as audio:
      // a network drop after real work is already done but before the
      // response arrives looks identical to total failure client-side.
      const idempotencyKey = (formData.get("idempotency_key") as string | null) ?? null;
      const idempotencyResult = await checkIdempotencyKey(env, idempotencyKey);
      if (idempotencyResult) return idempotencyResult;

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
      let captionIntent: string | null = null;
      let captionRefusal: string | null = null;
      let rawText = description;
      if (typeof caption === "string" && caption.trim().length > 0) {
        const captionText = caption.trim();
        rawText = `${captionText}\n\n[Photo description: ${description}]`;
        const { extraction } = await extractIntent(env, captionText);
        captionIntent = extraction?.intent ?? null;
        // Decided by Pierre 2026-10-04: the caption gets the same permission check as dictation, before anyone is created.
        // It used to create the customer or supplier it named for ANY member, however little they were allowed to record
        // (an installer's "Brand New Person lounge quote" created a customer before any check). A refused role can still
        // have the file linked to someone who is already on file (finding is harmless) but can no longer create anyone, and
        // the response says why the caption was not acted on.
        const { capabilities: captionCapabilities } = await resolveCapabilities(request, env);
        captionRefusal = intentCreationRefusal(captionIntent, captionCapabilities);
        if (extraction?.customer_name) {
          const customer = captionRefusal
            ? await findExistingCustomerByName(env, extraction.customer_name)
            : await reconcileCustomer(env, extraction.customer_name);
          subjectHint = customer?.name ?? null;
          subjectCustomerId = customer?.id ?? null;
        } else if (extraction?.character_name) {
          const character = captionRefusal
            ? await findExistingCharacterByName(env, extraction.character_name)
            : await reconcileCharacter(env, extraction.character_name, extraction.character_relationship);
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
      // Real fix 2026-07-25, found live via a genuinely poor-quality
      // real photo test: a real delivery note has no pricing at all,
      // and this always assumed a photographed supplier document was
      // an invoice. Checked here now: no real, non-null pricing on
      // any matched line item means this is a delivery note, not an
      // invoice — GRN is the correct, real path, unguarded and
      // recorded directly, matching GRN's own precedent exactly.
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
        const classified = classifyGoodsReceivedLines(grnExtraction.line_items, candidates);
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
          uploadMessage = deliveryHeldMessage(plan, supplierLabel, inferredFromDocument, heldGrn.id, outstanding.length > 0);
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
            uploadMessage = `${deliveryRecordedMessage(recorded)} ${stockAsk.message}`;
          } else if (deliveryHadExceptions(recorded)) {
            uploadMessage = deliveryRecordedMessage(recorded);
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
          uploadMessage = `Statement from ${subjectHint ?? "the supplier"}${inferredFromDocument ? " (read from the document)" : ""}: they claim R${stmtExtraction.claimed_closing_balance}, our records show R${realBalance}.`;
        } else {
          uploadMessage = `I couldn't find a closing balance on this statement from ${subjectHint ?? "the supplier"}, so nothing was compared.`;
        }
      } else if (subjectCharacterId) {
        const openPo = await findLatestOpenPurchaseOrder(env, subjectCharacterId);
        if (openPo) {
          const poLineItems = await getPurchaseOrderLineItems(env, openPo.id);
          const siExtraction = await extractSupplierInvoice(env, description, poLineItems);
          const hasRealPricing = siExtraction.line_items.some((li) => li.unit_price_billed != null);
          if (siExtraction.line_items.length > 0 && hasRealPricing && supplierInvoiceRefusal) {
            uploadRefusal = supplierInvoiceRefusal;
          } else if (siExtraction.line_items.length > 0 && hasRealPricing) {
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
            uploadHeldActionId = held.id;
            uploadMessage = `Supplier invoice noted from ${subjectHint ?? "the supplier"}${inferredFromDocument ? " (read from the document)" : ""} — needs your confirmation (action #${held.id}) before it's recorded.`;
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

      const photoResponseBody = JSON.stringify({ status: "stored", refusal: uploadRefusal, message: uploadRefusal ?? uploadMessage, pendingActionId: uploadHeldActionId, key, captureId, description, subjectHint, supplierInvoiceAction, goodsReceivedAction, supplierStatementAction });
      await completeIdempotencyKey(env, idempotencyKey, photoResponseBody);
      return new Response(photoResponseBody, { headers: { "Content-Type": "application/json" } });
    }

    // Real, permanent production routes — not debug — behind each
    // ember. Tapping one should show the actual real register: what's
    // really open, really scheduled, really outstanding. No Weather
    // route exists because no external weather API exists anywhere
    // in this project yet — deliberately not stubbed.
    if (url.pathname === "/embers/tasks" && request.method === "GET") {
      const openTasks = await getOpenTasks(env);
      // Real feature 2026-07-26 — Tasks folds in Snags per the agreed
      // five-ember scheme (both a real, open thing to do), broadened
      // without adding a sixth ember to the masthead.
      const snagCountRow = await env.OFFICE_DB.prepare(
        "SELECT COUNT(*) as count FROM snags WHERE status = 'open'"
      ).first<{ count: number }>();
      return Response.json({ tasks: openTasks, openSnagsCount: snagCountRow?.count ?? 0 });
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
      // Real feature 2026-07-26 — Scheduler folds in Projects per the
      // agreed five-ember scheme, since a project is just grouped job
      // scopes, the same underlying entity. No real "open/closed"
      // status exists on projects themselves yet, so this is honestly
      // a simple, total count for now rather than an invented status.
      const projectCountRow = await env.OFFICE_DB.prepare("SELECT COUNT(*) as count FROM projects").first<{
        count: number;
      }>();
      return Response.json({ scheduledToday: results, projectsCount: projectCountRow?.count ?? 0 });
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

    // Real feature 2026-07-26 — Suppliers, broadening Expenses per the
    // agreed five-ember scheme to cover everything money-going-out:
    // today's real expenses plus the real, aged-creditors outstanding
    // balance, mirroring Finance exactly on the opposite direction of
    // money.
    if (url.pathname === "/embers/suppliers" && request.method === "GET") {
      const pad = (n: number) => String(n).padStart(2, "0");
      const now = nowInBusinessTimezone();
      const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
      const { results: todaysExpenses } = await env.OFFICE_DB.prepare(
        `SELECT e.id, e.amount, e.description, e.category, c.name as supplier_name, e.created_at
         FROM expenses e LEFT JOIN characters c ON c.id = e.character_id
         WHERE date(e.created_at) = ?
         ORDER BY e.created_at DESC`
      )
        .bind(today)
        .all();
      const agedCreditors = await getAgedCreditorsReport(env);
      return Response.json({ todaysExpenses, agedCreditors });
    }

    // Real feature 2026-07-26 — Pending, a genuinely new ember: the
    // real, direct fulfillment of the original 2026-07-10 "actions
    // needed" ember concept (DECISIONS.md) — proposed then, never
    // actually wired into a UI until now. A real, deterministic count
    // of every guard()-held action genuinely still awaiting Peter's
    // own confirm or reject, across every domain.
    if (url.pathname === "/embers/pending" && request.method === "GET") {
      const { results } = await env.OFFICE_DB.prepare(
        "SELECT id, type, source_transcript, created_at FROM pending_actions WHERE status = 'pending' ORDER BY created_at DESC"
      ).all();
      return Response.json({ pending: results });
    }

    // "Type" mode. Same pipeline, no transcription step needed since
    // the text is already text.
    if (url.pathname === "/messages/text" && request.method === "POST") {
      const body = (await request.json()) as { text?: string; history?: HistoryTurn[]; idempotency_key?: string };
      const text = body.text?.trim();
      const history = Array.isArray(body.history) ? body.history : [];
      const idempotencyKey = body.idempotency_key ?? null;

      if (!text) {
        return Response.json({ error: "missing text" }, { status: 400 });
      }

      // Real fix — Layer 1, Stage 0 (Constitution Principle 28): retry
      // safety. Found live 2026-07-15 — a request that looked like it
      // had failed to the client (a blank response) had actually kept
      // running server-side and written real data; retrying on the
      // assumption of failure silently duplicated it. Refactored to
      // the shared checkIdempotencyKey/completeIdempotencyKey helpers
      // (found by a later audit: no client anywhere actually sent this
      // key, for this route or any other, so this protection had been
      // sitting dormant, unused, since it was written) — same real
      // logic, now reusable for every other retryable write.
      const idempotencyResult = await checkIdempotencyKey(env, idempotencyKey);
      if (idempotencyResult) return idempotencyResult;

      const { capabilities, email: textEmail } = await resolveCapabilities(request, env);
      const processed = await processTranscript(env, text, ctx, history, "text", null, capabilities, textEmail);
      const responseBody = JSON.stringify({ status: "processed", transcript: text, ...processed });

      await completeIdempotencyKey(env, idempotencyKey, responseBody);
      return new Response(responseBody, { headers: { "Content-Type": "application/json" } });
    }

    if (url.pathname.startsWith("/files")) {
      return new Response("files: reserved, not yet implemented", { status: 501 });
    }

    return new Response("not found", { status: 404 });
}


export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const corsHeaders = corsHeadersFor(request);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // Real, new, per direct instruction: one real ID per request,
    // generated here — the one place every real request genuinely
    // passes through — and threaded into handleRequest so any deeper
    // logging (the confirm handler's own real error log, for one) can
    // tie back to the exact same request without re-deriving anything.
    const requestId = crypto.randomUUID();
    const startedAt = Date.now();
    const url = new URL(request.url);
    log("info", requestId, "request start", { method: request.method, path: url.pathname });

    const response = await handleRequest(request, env, ctx, requestId);
    log("info", requestId, "request end", { status: response.status, durationMs: Date.now() - startedAt });

    const newHeaders = new Headers(response.headers);
    for (const [key, value] of Object.entries(corsHeaders)) {
      newHeaders.set(key, value);
    }
    // Real fix, found live via the logo-retrieval feature: streaming
    // response.body directly here silently truncated every binary
    // response to 0 bytes, even though the inner route already read
    // its own full buffer correctly — the headers (including a
    // correct Content-Length) came through fine, but the body itself
    // never did. Never surfaced before, since every prior response in
    // this Worker was JSON; this is the first binary response ever
    // produced. Reading the full buffer here, at the one real place
    // that wraps every response, is the correct, permanent fix.
    const bodyBuffer = await response.arrayBuffer();
    return new Response(bodyBuffer, {
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

































