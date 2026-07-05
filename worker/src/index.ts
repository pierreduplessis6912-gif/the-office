export interface Env {
  OFFICE_DB: D1Database;
  OFFICE_VAULT: R2Bucket;
  AI: Ai;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/health") {
      return Response.json({ status: "ok", service: "office-api" });
    }

    if (url.pathname.startsWith("/auth")) {
      return new Response("auth: reserved, not yet implemented", { status: 501 });
    }

    // /files/audio: store first, transcribe second. The voice note is
    // never at risk of being lost just because transcription had a bad
    // day — R2 write happens before the AI call, and a transcription
    // failure degrades to a clear fallback message rather than losing
    // the whole request. Still no D1 write, no intent, no action here —
    // that's the next step, once there's a transcript worth acting on.
    if (url.pathname === "/files/audio" && request.method === "POST") {
      const formData = await request.formData();
      const audio = formData.get("audio");

      if (!(audio instanceof File)) {
        return Response.json({ error: "missing audio file" }, { status: 400 });
      }

      const audioBuffer = await audio.arrayBuffer();
      const key = `voice-notes/${Date.now()}-${crypto.randomUUID()}.m4a`;
      await env.OFFICE_VAULT.put(key, audioBuffer);

      let transcript: string | null = null;
      // Diagnostic only, while we're still confirming Whisper accepts
      // this audio format — never silently swallow the real reason.
      let transcriptionError: string | null = null;
      try {
        const result = await env.AI.run("@cf/openai/whisper-large-v3-turbo", {
          audio: [...new Uint8Array(audioBuffer)],
        });
        transcript = (result as { text?: string }).text ?? null;
      } catch (err) {
        transcriptionError = err instanceof Error ? err.message : String(err);
      }

      return Response.json({
        status: "stored",
        key,
        transcript,
        transcriptionError,
        message: transcript ?? "Voice note received (transcription unavailable).",
      });
    }

    if (url.pathname.startsWith("/files")) {
      return new Response("files: reserved, not yet implemented", { status: 501 });
    }

    return new Response("not found", { status: 404 });
  },
};

