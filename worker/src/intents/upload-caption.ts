// What an upload's caption says about who the file is for, shared by POST /files/document and POST /files/photo.
//
// Rewrite Phase 3, step 1b (2026-10-04). This block (39 lines: read the caption, find or create the customer or supplier it names, subject to the
// SAME permission check as dictation, then record the text and the hint on the capture) existed twice in index.ts, identical except for the label
// put in front of the file's description: "Document" or "Photo description" (verified line by line before it was moved). It is moved here unchanged,
// and that label is now the `label` parameter. A file is never given a subject by guessing from the file itself, only from something actually said.
import type { Env } from "../types";
import { extractIntent } from "../ai";
import { intentCreationRefusal, resolveCapabilities } from "../auth";
import { findExistingCharacterByName, findExistingCustomerByName, reconcileCharacter, reconcileCustomer } from "../identity";
import { updateCaptureHint, updateCaptureText } from "../memory";

export interface UploadCaptionSubject {
  subjectHint: string | null;
  subjectCustomerId: number | null;
  subjectCharacterId: number | null;
  captionIntent: string | null;
  captionRefusal: string | null;
  rawText: string;
}

export async function resolveUploadCaption(
  request: Request,
  env: Env,
  input: { caption: File | string | null; description: string; captureId: number | null; label: "Document" | "Photo description" }
): Promise<UploadCaptionSubject> {
  const { caption, description, captureId, label } = input;
  let subjectHint: string | null = null;
  let subjectCustomerId: number | null = null;
  let subjectCharacterId: number | null = null;
  let captionIntent: string | null = null;
  let captionRefusal: string | null = null;
  let rawText = description;
  if (typeof caption === "string" && caption.trim().length > 0) {
    const captionText = caption.trim();
    rawText = `${captionText}\n\n[${label}: ${description}]`;
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
  return { subjectHint, subjectCustomerId, subjectCharacterId, captionIntent, captionRefusal, rawText };
}
