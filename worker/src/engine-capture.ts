// VOICE CAPTURE INTO AN ENGINE BUSINESS (docs/decisions/engine-capture.md, approved by Pierre 2026-11-14): POST /engine/capture/audio, multipart {audio, idempotency_key?}.
// RECEPTACLE FIRST: the file goes to R2 and a capture row points at it BEFORE anything is understood, so nothing said is lost when hearing or reading fails. THEN the transcript goes through the SAME interpreter as typed text
// (engine/interpret.ts): a read is answered, a write is HELD for a person, nothing is approved and nothing is recorded as money here. This file lives outside the engine folder on purpose: the engine imports no legacy module
// (tools/engine-ownership.test.js R3), and hearing (ai.ts), the retry guard (auth.ts) and capture rows (memory.ts) are legacy modules.
import type { Env } from "./types";
import { describeImage, transcribe } from "./ai";
import { checkIdempotencyKey, completeIdempotencyKey } from "./auth";
import { logCapture } from "./memory";
import { interpretSentence } from "./engine/interpret";
import { interpretAnswer } from "./engine/routes";

export const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const PENDING = "[voice note — not yet heard]";
const UNHEARD = "[voice note — could not be heard]";

const refuse = (status: number, error: string, message: string): Response => Response.json({ error, message }, { status });

export async function engineCaptureAudio(request: Request, env: Env, member: { email: string | null; caps: readonly string[] }): Promise<Response> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return refuse(422, "invalid_payload", "The upload must be a form with an audio file.");
  }
  const audio = form.get("audio") as unknown as { size: number; type: string; arrayBuffer(): Promise<ArrayBuffer> } | string | null;   // a File; typed by shape because the build environment's FormData typing lacks File
  if (!audio || typeof audio === "string") return refuse(422, "invalid_payload", "No audio file was sent, so nothing was done.");
  if (audio.size === 0) return refuse(422, "invalid_payload", "The audio file is empty, so nothing was done.");
  if (audio.size > MAX_AUDIO_BYTES) return refuse(413, "too_large", "The voice note is too long (over 10 MB), so nothing was done.");
  if (!/^audio\//.test(audio.type)) return refuse(415, "unsupported_type", "That is not an audio file, so nothing was done.");
  const rawKey = form.get("idempotency_key");
  const idempotencyKey = typeof rawKey === "string" && rawKey.length > 0 && rawKey.length <= 100 ? rawKey : null;
  const replay = await checkIdempotencyKey(env, idempotencyKey);   // a dropped network cannot capture the same note twice
  if (replay) return replay;
  const release = async (): Promise<void> => { if (idempotencyKey) await env.OFFICE_DB.prepare("DELETE FROM idempotency_keys WHERE key = ?").bind(idempotencyKey).run(); };
  const finish = async (status: number, body: Record<string, unknown>): Promise<Response> => {
    const text = JSON.stringify(body);
    if (status < 500) await completeIdempotencyKey(env, idempotencyKey, text); else await release();   // a failure that may pass is not replayed forever
    return new Response(text, { status, headers: { "Content-Type": "application/json" } });
  };

  const bytes = await audio.arrayBuffer();
  const key = `engine-captures/voice/${Date.now()}-${crypto.randomUUID()}.m4a`;
  await env.OFFICE_VAULT.put(key, bytes);
  const captureId = await logCapture(env, PENDING, "voice", key);
  if (captureId === null) return await finish(500, { error: "capture_failed", message: "The voice note could not be kept, so nothing was done. Please try again." });

  const { transcript } = await transcribe(env, bytes);
  const text = typeof transcript === "string" ? transcript.trim() : "";
  if (!text) {
    await env.OFFICE_DB.prepare("UPDATE captures SET raw_text = ? WHERE id = ?").bind(UNHEARD, captureId).run();
    return await finish(200, { status: "captured", captureId, transcript: null, message: "Your voice note was saved, but it could not be heard, so nothing was done." });
  }
  await env.OFFICE_DB.prepare("UPDATE captures SET raw_text = ? WHERE id = ?").bind(text, captureId).run();   // the capture row now holds what was said
  const r = await interpretSentence(env, { ...member, captureId }, text, new Date().toISOString().slice(0, 10));
  const answer = interpretAnswer(r, (env as unknown as { ENGINE_REHEARSAL?: string }).ENGINE_REHEARSAL === "1");
  return await finish(answer.status, { ...answer.body, transcript: text, captureId });
}

// PHOTOS AND DOCUMENTS (docs/decisions/engine-capture-image.md, slice 1). Same receptacle-first shape as a voice note, with one more rule: WHAT A PICTURE SHOWS IS A READING, NEVER A COMMAND.
// The reading is kept on the capture row and shown back; it is never given to the interpreter, so words inside a photograph cannot make a held action. Only a caption actually TYPED with the file goes through the interpreter,
// exactly as typed text (the legacy caption rule: a subject comes only from something said, never guessed from the file). A PDF is kept and said to be not yet read (reading one is a later step).
const bytesToBase64 = (buf: ArrayBuffer): string => { const u = new Uint8Array(buf); let bin = ""; for (let i = 0; i < u.length; i += 0x8000) bin += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(bin); };
const NOT_READ = /^\[(image description failed|could not describe image)/;

export async function engineCaptureImage(request: Request, env: Env, member: { email: string | null; caps: readonly string[] }, kind: "photo" | "document"): Promise<Response> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return refuse(422, "invalid_payload", `The upload must be a form with a ${kind} file.`);
  }
  const file = form.get(kind) as unknown as { size: number; type: string; arrayBuffer(): Promise<ArrayBuffer> } | string | null;
  if (!file || typeof file === "string") return refuse(422, "invalid_payload", `No ${kind} file was sent, so nothing was done.`);
  if (file.size === 0) return refuse(422, "invalid_payload", `The ${kind} file is empty, so nothing was done.`);
  if (file.size > MAX_IMAGE_BYTES) return refuse(413, "too_large", `The ${kind} is too large (over 10 MB), so nothing was done.`);
  const isImage = /^image\//.test(file.type), isPdf = file.type === "application/pdf";
  if (!(isImage || (kind === "document" && isPdf))) return refuse(415, "unsupported_type", kind === "photo" ? "That is not an image, so nothing was done." : "That is not an image or a PDF, so nothing was done.");
  const rawKey = form.get("idempotency_key");
  const idempotencyKey = typeof rawKey === "string" && rawKey.length > 0 && rawKey.length <= 100 ? rawKey : null;
  const rawIntent = form.get("intent");
  const intent = typeof rawIntent === "string" ? rawIntent.trim() : "";
  if (intent && intent !== "expense" && intent !== "supplier_bill") return refuse(422, "invalid_payload", "That is not something a picture can be recorded as here, so nothing was done.");   // the person's own words, checked before anything is stored
  const rawCaption = form.get("caption");
  const caption = typeof rawCaption === "string" ? rawCaption.trim().slice(0, 2000) : "";
  const replay = await checkIdempotencyKey(env, idempotencyKey);
  if (replay) return replay;
  const release = async (): Promise<void> => { if (idempotencyKey) await env.OFFICE_DB.prepare("DELETE FROM idempotency_keys WHERE key = ?").bind(idempotencyKey).run(); };
  const finish = async (status: number, body: Record<string, unknown>): Promise<Response> => {
    const text = JSON.stringify(body);
    if (status < 500) await completeIdempotencyKey(env, idempotencyKey, text); else await release();
    return new Response(text, { status, headers: { "Content-Type": "application/json" } });
  };

  const bytes = await file.arrayBuffer();
  const ext = isPdf ? "pdf" : file.type.includes("png") ? "png" : "jpg";
  const key = `engine-captures/${kind}/${Date.now()}-${crypto.randomUUID()}.${ext}`;
  await env.OFFICE_VAULT.put(key, bytes);
  const captureId = await logCapture(env, `[${kind} — not yet read]`, kind, key);
  if (captureId === null) return await finish(500, { error: "capture_failed", message: `The ${kind} could not be kept, so nothing was done. Please try again.` });

  let description: string | null = null;
  if (isImage) {
    const d = await describeImage(env, bytesToBase64(bytes), file.type).catch(() => "");
    description = d && !NOT_READ.test(d) ? d : null;
  }
  const label = description ? `[${kind} shows: ${description}]` : `[${kind} — not yet read]`;
  await env.OFFICE_DB.prepare("UPDATE captures SET raw_text = ? WHERE id = ?").bind(caption ? `${caption}\n${label}` : label, captureId).run();
  if (intent === "expense" || intent === "supplier_bill") {
    // The person SAID what this is (a button, not the picture). What it shows is data: only that ONE capability is offered to the interpreter, so words inside a photograph cannot make anything else.
    if (!description) return await finish(200, { status: "captured", captureId, description, message: `Your ${kind} was saved, but it was not read, so nothing was done.` });
    const text = `Read from a photograph of ${intent === "expense" ? "a receipt" : "a supplier bill"}:\n${description.slice(0, 3000)}${caption ? `\nThe person added: ${caption}` : ""}`;
    const r = await interpretSentence(env, { ...member, captureId }, text, new Date().toISOString().slice(0, 10), { only: [intent === "expense" ? "expense.record" : "supplier_invoice.record"], fromReading: true });
    const answer = interpretAnswer(r, (env as unknown as { ENGINE_REHEARSAL?: string }).ENGINE_REHEARSAL === "1");
    return await finish(answer.status, { ...answer.body, description, captureId });
  }
  if (!caption) return await finish(200, { status: "captured", captureId, description, message: description ? `Your ${kind} was saved and read. Nothing was done with it: say what it is for and it can be acted on.` : `Your ${kind} was saved, but it was not read, so nothing was done.` });
  const today = new Date().toISOString().slice(0, 10), rehearsal = (env as unknown as { ENGINE_REHEARSAL?: string }).ENGINE_REHEARSAL === "1";
  const r = await interpretSentence(env, { ...member, captureId }, caption, today);
  const answer = interpretAnswer(r, rehearsal);
  return await finish(answer.status, { ...answer.body, description, captureId });
}
