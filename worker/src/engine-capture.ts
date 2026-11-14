// VOICE CAPTURE INTO AN ENGINE BUSINESS (docs/decisions/engine-capture.md, approved by Pierre 2026-11-14): POST /engine/capture/audio, multipart {audio, idempotency_key?}.
// RECEPTACLE FIRST: the file goes to R2 and a capture row points at it BEFORE anything is understood, so nothing said is lost when hearing or reading fails. THEN the transcript goes through the SAME interpreter as typed text
// (engine/interpret.ts): a read is answered, a write is HELD for a person, nothing is approved and nothing is recorded as money here. This file lives outside the engine folder on purpose: the engine imports no legacy module
// (tools/engine-ownership.test.js R3), and hearing (ai.ts), the retry guard (auth.ts) and capture rows (memory.ts) are legacy modules.
import type { Env } from "./types";
import { transcribe } from "./ai";
import { checkIdempotencyKey, completeIdempotencyKey } from "./auth";
import { logCapture } from "./memory";
import { interpretSentence } from "./engine/interpret";
import { interpretAnswer } from "./engine/routes";

export const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
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
