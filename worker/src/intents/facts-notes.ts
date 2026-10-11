// Facts, notes and reminders: what a sentence leaves behind besides its main effect. A fact about a customer or a supplier (held for confirmation, and
// refused for a role that may not handle pay or bank details), a personal note, a reminder, and filing the sentence itself as a note against whoever it
// was about (unless it was a question, an errand, something that already has a structured home, or a pay or bank detail that must be kept out).
//
// Rewrite Phase 3, step 11 (2026-10-04). Moved out of processOneExtraction unchanged and not rewritten: 112 lines, the same statements in the same
// order. Checked before the move: it reads seven things (the extraction, the sentence, the member's permissions, the customer, the supplier, the
// environment and the execution context), assigns back NO outer variable, and has no early return. Of the eight variables it declares, exactly four are used
// by the reply code afterwards, so exactly those four are returned. It creates up to two held actions (a customer fact, a supplier fact) and queues up to
// five background writes, which is why it takes the execution context.
import type { Env } from "../types";
import type { Extraction } from "../types";
import { intentKeepsOutOfNotes } from "../auth";
import { holdForConfirmation } from "../finance";
import { looksLikeAQuestion } from "../identity";
import { appendCharacterNote, appendCustomerNote, appendLifeEvent, looksLikePayOrBankDetail, mayHandleSensitiveFact, sensitiveFactKind } from "../memory";
import { createTask } from "../scheduler";

export async function handleFactsAndNotes(
  env: Env,
  ctx: ExecutionContext,
  input: {
    extraction: Extraction | null;
    transcript: string;
    capabilities: string[];
    customer: { id: number; name: string; matched: boolean } | null;
    character: { id: number; name: string; matched: boolean } | null;
  }
) {
  const { extraction, transcript, capabilities, customer, character } = input;
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
  // Decided by Pierre 2026-10-04: a payroll detail (a day rate, a salary) or a banking detail (an account, a branch code) needs the matching
  // permission to be SAVED, as to be read: a role that could never read it back is told so instead of being left to hold it.
  const sensitiveKind = extraction?.fact_key ? sensitiveFactKind(extraction.fact_key) : null;
  const sensitiveFactRefused = Boolean(extraction?.fact_key && extraction?.fact_value && character && !mayHandleSensitiveFact(sensitiveKind, capabilities));
  if (extraction?.fact_key && extraction?.fact_value && character && !sensitiveFactRefused) {
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
  // Found by an independent review of the round 12 fix 2026-10-04: the sentence detector guarded the transcript path but NOT the model's own
  // personal_note field, so "remember my account number is 62012345678" was written to the life notes while the reply said it had not been
  // kept. The same detector now guards this path too, on the note AND on what was said, and the reply flag below agrees with what was done.
  const personalNoteIsSensitive = Boolean(extraction?.personal_note) && (looksLikePayOrBankDetail(extraction!.personal_note!) || looksLikePayOrBankDetail(transcript));
  if (extraction?.personal_note && !personalNoteIsSensitive) {
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
  // Decided by Pierre 2026-10-04: a sentence that says a pay or bank detail is kept out of free-text notes (which every role can read), as money
  // sentences are, and the reply says so instead of dropping it silently.
  const sensitiveNoteKeptOut = (!isQuestion && !isPersonalErrand && !hasStructuredHomeAlready && looksLikePayOrBankDetail(transcript)) || personalNoteIsSensitive;
  if (!isQuestion && !isPersonalErrand && !hasStructuredHomeAlready && !sensitiveNoteKeptOut) {
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
  return { factPendingActionId, sensitiveKind, sensitiveFactRefused, sensitiveNoteKeptOut };
}
