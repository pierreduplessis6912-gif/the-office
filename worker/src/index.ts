export interface Env {
  OFFICE_DB: D1Database;
  OFFICE_VAULT: R2Bucket;
  AI: Ai;
}

interface Extraction {
  customer_name: string | null;
  intent: "lookup" | "note" | "reminder" | "other";
}

async function transcribe(env: Env, audioBuffer: ArrayBuffer): Promise<{ transcript: string | null; transcriptionError: string | null }> {
  try {
    const result = await env.AI.run("@cf/openai/whisper", {
      audio: [...new Uint8Array(audioBuffer)],
    });
    return { transcript: (result as { text?: string }).text ?? null, transcriptionError: null };
  } catch (err) {
    return { transcript: null, transcriptionError: err instanceof Error ? err.message : String(err) };
  }
}

// Extraction is best-effort and never blocks the response — a failed
// or malformed extraction just means no structured fact this time,
// not a broken request. The transcript itself is always preserved
// regardless of what this returns.
async function extractIntent(env: Env, transcript: string): Promise<{ extraction: Extraction | null; raw: unknown }> {
  try {
    const result = await env.AI.run("@cf/moonshotai/kimi-k2.6", {
      messages: [
        {
          role: "system",
          content:
            'Extract structured facts from a tradesperson\'s voice note transcript. Return ONLY JSON, no markdown, no explanation: {"customer_name": string or null, "intent": "lookup" or "note" or "reminder" or "other"}. customer_name is the specific customer mentioned, exactly as spoken, or null if none.',
        },
        { role: "user", content: transcript },
      ],
    });
    const rawText = (result as { response?: string }).response ?? "";
    const cleaned = rawText.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(cleaned) as Extraction;
    return { extraction: parsed, raw: result };
  } catch (err) {
    return { extraction: null, raw: err instanceof Error ? err.message : String(err) };
  }
}

// Crude first-pass reconciliation: match on the first token of the
// spoken name (usually the first name) against existing customers.
// This is deliberately the simplest thing that could work — it will
// catch "Jenny Hawkins" vs "Jenny Hoax" vs "Jenny Hawks" since they
// share "Jenny", but it is not real fuzzy matching and won't help if
// the first name itself is misheard. Good enough to prove the pattern;
// not the final algorithm.
async function reconcileCustomer(env: Env, spokenName: string): Promise<{ id: number; name: string; matched: boolean }> {
  const firstToken = spokenName.trim().split(/\s+/)[0];
  const existing = await env.OFFICE_DB.prepare("SELECT id, name FROM customers WHERE name LIKE ? LIMIT 1")
    .bind(`%${firstToken}%`)
    .first<{ id: number; name: string }>();

  if (existing) {
    return { id: existing.id, name: existing.name, matched: true };
  }

  const inserted = await env.OFFICE_DB.prepare("INSERT INTO customers (name) VALUES (?) RETURNING id, name")
    .bind(spokenName)
    .first<{ id: number; name: string }>();

  return { id: inserted!.id, name: inserted!.name, matched: false };
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

    if (url.pathname === "/files/audio" && request.method === "POST") {
      const formData = await request.formData();
      const audio = formData.get("audio");

      if (!(audio instanceof File)) {
        return Response.json({ error: "missing audio file" }, { status: 400 });
      }

      const audioBuffer = await audio.arrayBuffer();
      const key = `voice-notes/${Date.now()}-${crypto.randomUUID()}.m4a`;
      await env.OFFICE_VAULT.put(key, audioBuffer);

      const { transcript, transcriptionError } = await transcribe(env, audioBuffer);

      let extraction: Extraction | null = null;
      let kimiRaw: unknown = null;
      let customer: { id: number; name: string; matched: boolean } | null = null;

      if (transcript) {
        const result = await extractIntent(env, transcript);
        extraction = result.extraction;
        kimiRaw = result.raw;

        if (extraction?.customer_name) {
          customer = await reconcileCustomer(env, extraction.customer_name);
        }
      }

      const message = customer
        ? customer.matched
          ? `Found existing customer: ${customer.name}.`
          : `New customer noted: ${customer.name}.`
        : transcript ?? "Voice note received (transcription unavailable).";

      return Response.json({
        status: "stored",
        key,
        transcript,
        transcriptionError,
        extraction,
        kimiRaw,
        customer,
        message,
      });
    }

    if (url.pathname.startsWith("/files")) {
      return new Response("files: reserved, not yet implemented", { status: 501 });
    }

    return new Response("not found", { status: 404 });
  },
};
