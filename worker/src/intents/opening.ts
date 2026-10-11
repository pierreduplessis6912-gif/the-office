// The opening step of a dictated sentence: who it is about, and what may be done about them, before anything is recorded.
//
// Rewrite Phase 3, step 9 (2026-10-04). The first 410 lines of processOneExtraction moved here unchanged and not rewritten: the same statements in the
// same order. This is where a customer or a supplier is found or created, where a name that sounds like someone already on file is held as a question
// (ambiguous_person, identity_collision), where a role that may not create this kind of sentence is refused, where "forget that" and a follow-up
// ("how is she doing") are resolved from the person's own selection, and where the selection and the capture's hint are written in the background.
//
// The handler returns EITHER the finished result (seven early returns: a refusal, an identity question, forget-last, and so on), written exactly as
// it always was so the Phase 1 rules about result shapes can keep inspecting them, OR a small state object (`opening: true`) carrying what the rest
// of the function needs: the possibly-updated extraction, the customer and supplier it found, any held action, and whether this member may write
// invoices. Checked before the move: of the ten variables declared in this stretch, exactly those five are used afterwards, and the only parameter it
// reassigns is the extraction.
import type { Env } from "../types";
import type { Extraction } from "../types";
import type { LegacyProcessResult } from "./result";
import { containsBackwardReference, resolveFollowUpEntity, splitIntoTopics } from "../ai";
import { canResolveActionType, intentCreationRefusal, intentOnlyFindsCharacters, intentOnlyFindsCustomers } from "../auth";
import { holdForConfirmation } from "../finance";
import { checkCrossRoleCollision, clearSelections, findExistingCharacterByName, findExistingCustomerByName, findExistingEntityByName, getCurrentSelection, logInteractionEdge, reconcileCharacter, reconcileCustomer, reconcilePerson, setSelection, withArticle } from "../identity";
import { updateCaptureHint } from "../memory";
import { HistoryTurn } from "../types";

export interface OpeningState {
  opening: true;
  extraction: Extraction | null;
  customer: { id: number; name: string; matched: boolean } | null;
  character: { id: number; name: string; matched: boolean } | null;
  pendingActionId: number | null;
  pendingActionType: string | null;
  canManageInvoicesForWrites: boolean;
}

export async function handleOpeningStep(
  env: Env,
  ctx: ExecutionContext,
  input: {
    extraction: Extraction | null;
    transcript: string;
    history: HistoryTurn[];
    captureId: number | null;
    capabilities: string[];
    recordingUserEmail: string | null;
  }
): Promise<LegacyProcessResult | OpeningState> {
  let { extraction } = input;
  const { transcript, history, captureId, capabilities, recordingUserEmail } = input;
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
    await clearSelections(env, recordingUserEmail);

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
  // Decided by Pierre 2026-10-04: an installer's scheduling message ("Sipho installs at Jenny's on Monday") that the classifier labels "invoice"
  // was refused outright as money. When the label is "invoice" but there is NO amount in it, the role may not record invoices, and the role
  // MAY record jobs, it is read as the job it is. Anything with an amount stays refused: that is money.
  if (extraction?.intent === "invoice" && !extraction.amount && intentCreationRefusal("invoice", capabilities) && !intentCreationRefusal("work_observation", capabilities)) {
    extraction = { ...extraction, intent: "work_observation" };
  }
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
    if (intentOnlyFindsCustomers(extraction.intent)) {
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
    if (intentOnlyFindsCharacters(extraction.intent)) {
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
        const personCheck = await reconcilePerson(env, extraction.character_name, { relationship: extraction.character_relationship });
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
    extraction?.query_scope !== "unit_conversions" &&
    extraction?.query_scope !== "open_orders" &&
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
    const current = await getCurrentSelection(env, recordingUserEmail);
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
    ctx.waitUntil(setSelection(env, "customer", customer.id, customer.name, recordingUserEmail));
  }
  if (character) {
    ctx.waitUntil(setSelection(env, "character", character.id, character.name, recordingUserEmail));
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
  return { opening: true, extraction, customer, character, pendingActionId, pendingActionType, canManageInvoicesForWrites };
}
