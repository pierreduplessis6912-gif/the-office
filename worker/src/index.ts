export interface Env {
  OFFICE_DB: D1Database;
  OFFICE_VAULT: R2Bucket;
  AI: Ai;
}

interface Extraction {
  customer_name: string | null;
  intent: "payment" | "lookup" | "reminder" | "note" | "other";
  amount: number | null;
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

// Deliberately a small, fast model, not a frontier one — this is a
// three-field extraction from one short sentence, not a reasoning
// task. JSON Mode enforces the schema server-side instead of us
// asking nicely and hoping, which is both faster and more reliable
// than prompt-based JSON on a smaller model.
async function extractIntent(env: Env, transcript: string): Promise<{ extraction: Extraction | null; raw: unknown; rawText: string | null }> {
  let rawText: string | null = null;
  let result: unknown = null;
  try {
    result = await env.AI.run("@cf/meta/llama-3.1-8b-instruct-fast", {
      messages: [
        {
          role: "system",
          content:
            "Extract structured facts from a tradesperson's voice note transcript. " +
            'customer_name is the specific customer mentioned, exactly as spoken, or null if none. ' +
            'intent is "payment" only if the transcript describes money being received from a customer. ' +
            "amount is a plain number in the currency's major unit (e.g. rand, not cents) if a specific " +
            "amount was stated, exactly as heard — never estimate or calculate, only transcribe a number " +
            "that was actually said, or null if none was.",
        },
        { role: "user", content: transcript },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          type: "object",
          properties: {
            customer_name: { type: ["string", "null"] },
            intent: { type: "string", enum: ["payment", "lookup", "reminder", "note", "other"] },
            amount: { type: ["number", "null"] },
          },
          required: ["customer_name", "intent", "amount"],
        },
      },
    });

    const r = result as { response?: unknown };
    if (r.response && typeof r.response === "object") {
      rawText = JSON.stringify(r.response);
      return { extraction: r.response as Extraction, raw: result, rawText };
    }
    rawText = typeof r.response === "string" ? r.response : null;
    const cleaned = (rawText ?? "").replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(cleaned) as Extraction;
    return { extraction: parsed, raw: result, rawText };
  } catch (err) {
    return { extraction: null, raw: result ?? (err instanceof Error ? err.message : String(err)), rawText };
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

// The actual real ground-truth write. Only ever called from the
// confirm endpoint below — never directly from /files/audio anymore.
// That's the whole point of guard(): the path from "extracted" to
// "written" now has a mandatory stop in the middle.
async function recordPayment(
  env: Env,
  customerId: number,
  amount: number | null,
  sourceTranscript: string
): Promise<{ id: number; customerId: number; amount: number | null }> {
  const inserted = await env.OFFICE_DB.prepare(
    "INSERT INTO payments (customer_id, amount, source_transcript) VALUES (?, ?, ?) RETURNING id"
  )
    .bind(customerId, amount, sourceTranscript)
    .first<{ id: number }>();

  return { id: inserted!.id, customerId, amount };
}

// guard(): every money-touching intent lands here, not in the real
// ledger, until it's explicitly confirmed. Deliberately blunt for now
// — everything pauses, regardless of amount or confidence — rather
// than trying to guess a threshold before there's any real usage data
// to base one on.
async function holdForConfirmation(
  env: Env,
  type: string,
  payload: Record<string, unknown>,
  sourceTranscript: string
): Promise<{ id: number }> {
  const inserted = await env.OFFICE_DB.prepare(
    "INSERT INTO pending_actions (type, payload, source_transcript) VALUES (?, ?, ?) RETURNING id"
  )
    .bind(type, JSON.stringify(payload), sourceTranscript)
    .first<{ id: number }>();

  return { id: inserted!.id };
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

    // List everything still waiting on a human decision.
    if (url.pathname === "/actions/pending" && request.method === "GET") {
      const { results } = await env.OFFICE_DB.prepare(
        "SELECT id, type, payload, source_transcript, created_at FROM pending_actions WHERE status = 'pending' ORDER BY created_at DESC"
      ).all();
      return Response.json({ pending: results });
    }

    // The only path that turns a held payment intent into a real,
    // ground-truth payments row.
    if (url.pathname.match(/^\/actions\/\d+\/confirm$/) && request.method === "POST") {
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

      return Response.json({ error: `unknown pending action type: ${action.type}` }, { status: 400 });
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

    if (url.pathname === "/files/audio" && request.method === "POST") {
      const formData = await request.formData();
      const audio = formData.get("audio");

      if (!(audio instanceof File)) {
        return Response.json({ error: "missing audio file" }, { status: 400 });
      }

      const audioBuffer = await audio.arrayBuffer();
      const key = `voice-notes/${Date.now()}-${crypto.randomUUID()}.m4a`;

      const [, { transcript, transcriptionError }] = await Promise.all([
        env.OFFICE_VAULT.put(key, audioBuffer),
        transcribe(env, audioBuffer),
      ]);

      let extraction: Extraction | null = null;
      let extractionRaw: unknown = null;
      let extractionRawText: string | null = null;
      let customer: { id: number; name: string; matched: boolean } | null = null;
      let pendingActionId: number | null = null;

      if (transcript) {
        const result = await extractIntent(env, transcript);
        extraction = result.extraction;
        extractionRaw = result.raw;
        extractionRawText = result.rawText;

        if (extraction?.customer_name) {
          customer = await reconcileCustomer(env, extraction.customer_name);
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
      }

      const message = pendingActionId
        ? `Payment noted for ${customer!.name}${extraction!.amount ? ` of R${extraction!.amount}` : ""} — needs your confirmation (action #${pendingActionId}) before it's recorded.`
        : customer
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
        extractionRaw,
        extractionRawText,
        customer,
        pendingActionId,
        message,
      });
    }

    if (url.pathname.startsWith("/files")) {
      return new Response("files: reserved, not yet implemented", { status: 501 });
    }

    return new Response("not found", { status: 404 });
  },
};
