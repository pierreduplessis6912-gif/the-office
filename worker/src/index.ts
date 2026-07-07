export interface Env {
  OFFICE_DB: D1Database;
  OFFICE_VAULT: R2Bucket;
  AI: Ai;
  MEMORY: VectorizeIndex;
}

interface Extraction {
  customer_name: string | null;
  intent: "payment" | "lookup" | "reminder" | "note" | "other";
  amount: number | null;
}

interface ProcessResult {
  extraction: Extraction | null;
  extractionRaw: unknown;
  extractionRawText: string | null;
  customer: { id: number; name: string; matched: boolean } | null;
  pendingActionId: number | null;
  message: string;
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

// Kimi, not the small "fast" model — proven head-to-head: 5/5 correct
// with only the plain rule and zero curated examples, versus the small
// model getting 4/5 wrong on the same input even with few-shot
// examples and temperature 0. Genuine understanding beats pattern-
// matching against a list we could never make complete. thinking must
// stay disabled or Kimi burns its whole token budget on internal
// reasoning before ever answering; temperature 0 for determinism.
async function extractIntent(env: Env, transcript: string): Promise<{ extraction: Extraction | null; raw: unknown; rawText: string | null }> {
  let rawText: string | null = null;
  let result: unknown = null;
  try {
    result = await env.AI.run("@cf/moonshotai/kimi-k2.6", {
      temperature: 0,
      chat_template_kwargs: { thinking: false },
      messages: [
        {
          role: "system",
          content:
            "Extract structured facts from a tradesperson's message. " +
            'customer_name is the specific customer mentioned, exactly as spoken or typed, or null if none. ' +
            'intent is "payment" ONLY if the message explicitly describes money already being received from ' +
            'a customer — not if the customer is merely mentioned, looked up, or asked about. ' +
            "amount is a plain number in the currency's major unit (e.g. rand, not cents) if a specific " +
            "amount was stated, exactly as given — never estimate or calculate, only use a number " +
            "that was actually stated, or null if none was. Return ONLY JSON, no markdown, no explanation: " +
            '{"customer_name": string or null, "intent": "payment" or "lookup" or "reminder" or "note" or "other", "amount": number or null}',
        },
        { role: "user", content: transcript },
      ],
    });
    const r = result as { choices?: Array<{ message?: { content?: string } }> };
    rawText = r.choices?.[0]?.message?.content ?? null;
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
// Pronouns and other generic words are not names. Kimi has now
// produced "her" and, earlier today, a garbled typo ("jonh") as if
// they were real customer names — and reconciliation created permanent
// junk records from both, with zero validation standing in the way.
// This is the same category of mistake we guard against for money:
// an LLM's raw output becoming a permanent write with nothing
// deterministic checking it first. Creating a new customer deserves
// the same discipline.
const NOT_A_NAME = new Set([
  "her", "him", "he", "she", "it", "they", "them", "we", "us", "you",
  "i", "me", "this", "that", "someone", "somebody", "who", "customer", "client",
]);

function looksLikeAName(name: string): boolean {
  const trimmed = name.trim().toLowerCase();
  if (trimmed.length < 2) return false;
  if (NOT_A_NAME.has(trimmed)) return false;
  return true;
}

async function reconcileCustomer(env: Env, spokenName: string): Promise<{ id: number; name: string; matched: boolean } | null> {
  if (!looksLikeAName(spokenName)) {
    return null;
  }

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
// confirm endpoint — never directly from the message pipeline. That's
// the whole point of guard(): the path from "extracted" to "written"
// always has a mandatory stop in the middle.
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
// — everything pauses, regardless of amount or confidence.
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

// --- Memory: color, not ground truth. Never used for money or ------
// anything with real-world consequence — only for recalling what was
// said (an address, a preference, a note) when nothing structured
// exists to answer from instead.

async function embedText(env: Env, text: string): Promise<number[]> {
  const result = await env.AI.run("@cf/baai/bge-base-en-v1.5", { text });
  return (result as { data: number[][] }).data[0];
}

// Fire-and-forget from the caller's point of view via ctx.waitUntil —
// "thrown in a pot, indexed in the background." Never blocks the
// response, and a failure here never breaks the request that
// triggered it; at worst, one fact doesn't get remembered.
async function storeMemory(env: Env, text: string, customerId: number | null): Promise<void> {
  try {
    const vector = await embedText(env, text);
    await env.MEMORY.upsert([
      {
        id: crypto.randomUUID(),
        values: vector,
        metadata: {
          customerId: customerId != null ? String(customerId) : "",
          text,
          createdAt: new Date().toISOString(),
        },
      },
    ]);
  } catch (err) {
    // This runs in ctx.waitUntil — there is no response left to attach
    // an error to, so silently swallowing it (as before) means genuine
    // failures are indistinguishable from "nothing was ever said."
    // Log it somewhere durable instead, so a real failure is at least
    // findable after the fact rather than invisible forever.
    try {
      await env.OFFICE_DB.prepare(
        "INSERT INTO memory_errors (customer_id, text, error) VALUES (?, ?, ?)"
      )
        .bind(customerId, text, err instanceof Error ? err.message : String(err))
        .run();
    } catch {
      // If even the error log fails, there's nothing further to do.
    }
  }
}

// Reranking replaces the hand-tuned raw-cosine threshold with an
// actual cross-encoder relevance judgment — the same technique
// Cloudflare's own AI Search product uses (and its own default
// threshold, 0.4, happens to match the number we landed on earlier
// today by trial and error). Degrades gracefully to the raw
// candidates if the reranker call itself fails, rather than losing
// everything.
async function rerank(env: Env, query: string, candidates: string[]): Promise<string[]> {
  if (candidates.length === 0) return [];
  try {
    const result = await env.AI.run("@cf/baai/bge-reranker-base", {
      query,
      contexts: candidates.map((text) => ({ text })),
    });
    // Shape not yet verified empirically against the direct binding —
    // handle a couple of plausible envelopes rather than assume, same
    // lesson as every other model call today.
    const scored =
      (result as { response?: Array<{ id: number; score: number }> }).response ??
      (result as unknown as Array<{ id: number; score: number }>) ??
      [];
    return scored
      .filter((s) => s.score > 0.4)
      .sort((a, b) => b.score - a.score)
      .map((s) => candidates[s.id])
      .filter((t): t is string => !!t);
  } catch {
    return candidates;
  }
}

async function searchMemory(env: Env, query: string, customerId: number | null): Promise<string[]> {
  try {
    const vector = await embedText(env, query);
    const results = await env.MEMORY.query(vector, {
      topK: 8,
      returnMetadata: true,
      filter: customerId != null ? { customerId: String(customerId) } : undefined,
    });
    const candidates = (results.matches ?? [])
      .map((m) => (m.metadata as { text?: string } | undefined)?.text)
      .filter((t): t is string => !!t);
    return await rerank(env, query, candidates);
  } catch {
    return [];
  }
}

// Synthesizes a real answer from retrieved memory, rather than a
// templated "Found existing customer" line. If nothing relevant comes
// back, says so honestly rather than guessing.
async function answerFromMemory(env: Env, question: string, facts: string[]): Promise<string> {
  if (facts.length === 0) {
    return "I don't have anything on file for that yet.";
  }
  try {
    const result = await env.AI.run("@cf/meta/llama-3.1-8b-instruct-fast", {
      messages: [
        {
          role: "system",
          content:
            "Answer the tradesperson's question using only the facts below. Be brief, one sentence. " +
            "If the facts don't actually answer the question, say you don't have that on file.\n\n" +
            `Facts:\n${facts.map((f) => `- ${f}`).join("\n")}`,
        },
        { role: "user", content: question },
      ],
    });
    const answer = (result as { response?: unknown }).response;
    return typeof answer === "string" && answer.trim() ? answer.trim() : facts[0];
  } catch {
    return facts[0];
  }
}

// Shared by both /files/audio (after transcription) and /messages/text
// (directly on typed input) — same extraction, reconciliation, guard(),
// and memory logic either way. A transcript is a transcript, whether
// it came from Whisper or a keyboard.
interface HistoryTurn {
  role: "user" | "office";
  text: string;
}

// Query rewriting: the established fix for pronoun/reference
// resolution in conversational retrieval — not a Durable Object, not
// hoping an unscoped search gets lucky. Turns "what did we invoice
// her?" into a fully self-contained question using recent context,
// BEFORE extraction or retrieval ever sees it. Falls back to the
// original message unchanged if there's no history, or if rewriting
// itself fails for any reason.
async function rewriteQuery(env: Env, history: HistoryTurn[], message: string): Promise<string> {
  if (history.length === 0) return message;
  try {
    const historyText = history.map((h) => `${h.role === "user" ? "Peter" : "Office"}: ${h.text}`).join("\n");
    const result = await env.AI.run("@cf/meta/llama-3.1-8b-instruct-fast", {
      temperature: 0,
      messages: [
        {
          role: "system",
          content:
            "Rewrite the new message to be fully self-contained, replacing any pronouns or vague " +
            "references (her, him, that, it, the invoice, etc.) with the specific name or thing they " +
            "refer to, using the conversation history for context. If the message is already " +
            "self-contained, return it completely unchanged. Return ONLY the rewritten message, " +
            "nothing else — no explanation, no quotes.\n\nConversation history:\n" +
            historyText,
        },
        { role: "user", content: message },
      ],
    });
    const r = result as { choices?: Array<{ message?: { content?: string } }> };
    const rewritten = r.choices?.[0]?.message?.content?.trim();
    return rewritten && rewritten.length > 0 ? rewritten : message;
  } catch {
    return message;
  }
}

async function processTranscript(
  env: Env,
  transcript: string,
  ctx: ExecutionContext,
  history: HistoryTurn[] = []
): Promise<ProcessResult> {
  const rewritten = await rewriteQuery(env, history, transcript);

  let extraction: Extraction | null = null;
  let extractionRaw: unknown = null;
  let extractionRawText: string | null = null;
  let customer: { id: number; name: string; matched: boolean } | null = null;
  let pendingActionId: number | null = null;

  const result = await extractIntent(env, rewritten);
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

  // Store the ORIGINAL words, not the rewritten version — the
  // rewrite exists purely to correctly resolve intent and retrieval,
  // never to replace what was actually said in the permanent record.
  if (extraction?.intent !== "lookup") {
    ctx.waitUntil(storeMemory(env, transcript, customer?.id ?? null));
  }

  let message: string;
  if (pendingActionId) {
    message = `Payment noted for ${customer!.name}${extraction!.amount ? ` of R${extraction!.amount}` : ""} — needs your confirmation (action #${pendingActionId}) before it's recorded.`;
  } else if (extraction?.intent === "lookup") {
    const memoryFacts = await searchMemory(env, rewritten, customer?.id ?? null);
    const facts = customer ? [`${customer.name} is a known customer.`, ...memoryFacts] : memoryFacts;
    message = await answerFromMemory(env, rewritten, facts);
  } else if (customer) {
    message = customer.matched ? `Found existing customer: ${customer.name}.` : `New customer noted: ${customer.name}.`;
  } else {
    message = "Got it.";
  }

  return { extraction, extractionRaw, extractionRawText, customer, pendingActionId, message };
}

async function handleRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/health") {
      return Response.json({ status: "ok", service: "office-api" });
    }

    if (url.pathname.startsWith("/auth")) {
      return new Response("auth: reserved, not yet implemented", { status: 501 });
    }

    // --- Debug routes. Left in deliberately during this experimentation
    // phase. Strip these before anything resembling real customer data
    // goes through.
    if (url.pathname === "/debug/list-audio" && request.method === "GET") {
      const listed = await env.OFFICE_VAULT.list({ prefix: "voice-notes/" });
      return Response.json({
        objects: listed.objects.map((o) => ({ key: o.key, size: o.size, uploaded: o.uploaded })),
      });
    }

    if (url.pathname === "/debug/reprocess" && request.method === "GET") {
      const key = url.searchParams.get("key");
      if (!key) return Response.json({ error: "missing ?key=" }, { status: 400 });
      const object = await env.OFFICE_VAULT.get(key);
      if (!object) return Response.json({ error: "key not found in R2" }, { status: 404 });
      const audioBuffer = await object.arrayBuffer();

      const { transcript, transcriptionError } = await transcribe(env, audioBuffer);
      const processed = transcript ? await processTranscript(env, transcript, ctx) : null;

      return Response.json({ key, transcript, transcriptionError, ...processed });
    }
    if (url.pathname === "/debug/search-memory" && request.method === "GET") {
      const text = url.searchParams.get("text");
      const customerId = url.searchParams.get("customerId");
      if (!text) return Response.json({ error: "missing ?text=" }, { status: 400 });

      const vector = await embedText(env, text);
      const results = await env.MEMORY.query(vector, {
        topK: 10,
        returnMetadata: true,
        filter: customerId ? { customerId } : undefined,
      });

      return Response.json({
        text,
        customerId,
        matches: (results.matches ?? []).map((m) => ({
          score: m.score,
          text: (m.metadata as { text?: string } | undefined)?.text,
          createdAt: (m.metadata as { createdAt?: string } | undefined)?.createdAt,
        })),
      });
    }

    if (url.pathname === "/debug/memory-errors" && request.method === "GET") {
      const { results } = await env.OFFICE_DB.prepare(
        "SELECT id, customer_id, text, error, created_at FROM memory_errors ORDER BY created_at DESC LIMIT 20"
      ).all();
      return Response.json({ errors: results });
    }

    // Standing health check — reusable going forward, not just for
    // this test. If the gap between now and processedUpToDatetime ever
    // exceeds Cloudflare's own stated p99 (2 minutes), that's a real
    // signal something's stuck, not normal lag.
    if (url.pathname === "/debug/memory-health" && request.method === "GET") {
      try {
        const info = await env.MEMORY.describe();
        const processedAt = new Date((info as { processedUpToDatetime: string }).processedUpToDatetime);
        const gapSeconds = (Date.now() - processedAt.getTime()) / 1000;
        return Response.json({
          vectorCount: (info as { vectorCount: number }).vectorCount,
          processedUpToDatetime: (info as { processedUpToDatetime: string }).processedUpToDatetime,
          gapSeconds,
          likelyStuck: gapSeconds > 120,
        });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
      }
    }

    // Isolated stress test: N individual, concurrent, single-vector
    // upserts — deliberately the exact pattern Cloudflare's own docs
    // flag as inefficient for write-heavy workloads. Bypasses the LLM
    // pipeline entirely so this only tests Vectorize's write behavior,
    // not extraction variability. Simulates "many clients writing at
    // once" without needing many real clients.
    if (url.pathname === "/debug/stress-memory" && request.method === "GET") {
      const count = Number(url.searchParams.get("count") ?? "20");
      try {
        const before = await env.MEMORY.describe();
        const writes = Array.from({ length: count }, (_, i) =>
          storeMemory(env, `stress test entry number ${i} at ${Date.now()}`, null)
        );
        await Promise.all(writes);
        const after = await env.MEMORY.describe();
        return Response.json({
          requested: count,
          before: { vectorCount: (before as { vectorCount: number }).vectorCount, processedUpToDatetime: (before as { processedUpToDatetime: string }).processedUpToDatetime },
          after: { vectorCount: (after as { vectorCount: number }).vectorCount, processedUpToDatetime: (after as { processedUpToDatetime: string }).processedUpToDatetime },
        });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
      }
    }

    // --- end debug routes ---

    // List everything still waiting on a human decision.
    if (url.pathname === "/actions/pending" && request.method === "GET") {
      const { results } = await env.OFFICE_DB.prepare(
        "SELECT id, type, payload, source_transcript, created_at FROM pending_actions WHERE status = 'pending' ORDER BY created_at DESC"
      ).all();
      return Response.json({ pending: results });
    }

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

    // "Talk" mode. Full pipeline: store audio, transcribe, extract,
    // reconcile, guard, remember.
    if (url.pathname === "/files/audio" && request.method === "POST") {
      const formData = await request.formData();
      const audio = formData.get("audio");
      const historyRaw = formData.get("history");
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

      const processed = transcript
        ? await processTranscript(env, transcript, ctx, history)
        : {
            extraction: null,
            extractionRaw: null,
            extractionRawText: null,
            customer: null,
            pendingActionId: null,
            message: "Voice note received (transcription unavailable).",
          };

      return Response.json({ status: "stored", key, transcript, transcriptionError, ...processed });
    }

    // "Type" mode. Same pipeline, no transcription step needed since
    // the text is already text.
    if (url.pathname === "/messages/text" && request.method === "POST") {
      const body = (await request.json()) as { text?: string; history?: HistoryTurn[] };
      const text = body.text?.trim();
      const history = Array.isArray(body.history) ? body.history : [];

      if (!text) {
        return Response.json({ error: "missing text" }, { status: 400 });
      }

      const processed = await processTranscript(env, text, ctx, history);
      return Response.json({ status: "processed", transcript: text, ...processed });
    }

    if (url.pathname.startsWith("/files")) {
      return new Response("files: reserved, not yet implemented", { status: 501 });
    }

    return new Response("not found", { status: 404 });
}

// CORS wrapper. Browsers enforce this; native apps and curl never did,
// which is exactly why this was never needed until testing moved to
// the web preview. Allowing all origins is fine here since there's no
// cookie-based auth to protect — every route is either public or will
// get its own real auth later, not relying on origin-checking for
// security.
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const response = await handleRequest(request, env, ctx);
    const newHeaders = new Headers(response.headers);
    for (const [key, value] of Object.entries(CORS_HEADERS)) {
      newHeaders.set(key, value);
    }
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: newHeaders,
    });
  },
};











