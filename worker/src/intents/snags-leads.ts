// Snags and leads by voice: raise a snag against a customer's job, resolve one (and say whether retention can now be released), raise a lead, and
// mark a lead lost.
//
// Rewrite Phase 3, step 5 (2026-10-04). The third intent group moved out of processOneExtraction, unchanged and not rewritten: the same branches and the
// same messages. These four intents read only the sentence, the customer and the capture, and write nothing back to the caller but the reply; every
// variable used here was private to these pieces (checked before the move). The one lead-specific line in the function's opening step (a lead's
// name must not be matched as a customer) stays there. Returns the finished reply, or null when the sentence is not one of these intents.
import type { Env } from "../types";
import type { Extraction } from "../types";
import { extractLead, extractLeadLost, extractSnag, extractSnagResolution } from "../ai";
import { getOpenLeads, getOpenSnagsForCustomer, markLeadLost, recordLead, recordSnag, resolveSnag } from "../finance";

const SNAG_AND_LEAD_INTENTS = new Set(["raise_snag", "resolve_snag", "raise_lead", "lose_lead"]);

export async function handleSnagsAndLeads(
  env: Env,
  input: {
    extraction: Extraction | null;
    transcript: string;
    customer: { id: number; name: string } | null;
    captureId: number | null;
  }
): Promise<{ message: string } | null> {
  const { extraction, transcript, customer, captureId } = input;
  if (!extraction || !SNAG_AND_LEAD_INTENTS.has(extraction.intent ?? "")) return null;
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

  let message: string | null = null;
  if (extraction?.intent === "raise_snag" && snagResult) {
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
  }
  if (message === null) return null;
  return { message };
}
