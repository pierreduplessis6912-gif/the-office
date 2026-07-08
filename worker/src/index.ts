export interface Env {
  OFFICE_DB: D1Database;
  OFFICE_VAULT: R2Bucket;
  AI: Ai;
  MEMORY: VectorizeIndex;
  CUSTOMER_NOTES: KVNamespace;
}

interface Extraction {
  customer_name: string | null;
  intent: "payment" | "invoice" | "quotation" | "convert_quote" | "lookup" | "reminder" | "note" | "other";
  amount: number | null;
  fact_key: string | null;
  fact_value: string | null;
  personal_note: string | null;
  query_scope: "customer" | "personal" | "business" | null;
  deposit_percent: number | null;
}

interface ProcessResult {
  extraction: Extraction | null;
  extractionRaw: unknown;
  extractionRawText: string | null;
  customer: { id: number; name: string; matched: boolean } | null;
  pendingActionId: number | null;
  message: string;
  rewrittenQuery: string;
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
            'intent is "lookup" for ANY question, including questions with no customer at all — such as ' +
            'the tradesperson asking about their own day, week, tasks, or schedule, or asking a business-wide ' +
            'financial question like "who owes me money". ' +
            'intent is "payment" ONLY if the message explicitly describes money already being RECEIVED from ' +
            'a customer — not if the customer is merely mentioned, looked up, or asked about. ' +
            'intent is "invoice" if the message describes money being BILLED for work already done — ' +
            'the job is complete or underway and the customer now owes for it. "the total invoice amount ' +
            'is R39000" or "we invoiced Jenny R850" is invoice, never payment or quotation. ' +
            'intent is "quotation" if the message describes a PROPOSED price for work NOT YET done or not ' +
            'yet agreed — an estimate, a quote given to the customer before starting. "we quoted Jenny ' +
            'R39000 for the carpets" or "gave her a quote of R5000" is quotation, never invoice — nothing ' +
            'has been billed yet, only proposed. The tense and framing matter: "quoted"/"quote"/"estimate" ' +
            '-> quotation; "invoiced"/"invoice"/"the total is" (for completed or in-progress work) -> ' +
            'invoice; "paid" -> payment. ' +
            'intent is "convert_quote" if the message asks to turn an existing quotation into an invoice — ' +
            'typically mentioning a completed job and/or a deposit already paid. "convert Jenny\'s quote to ' +
            'an invoice, she paid an 80% deposit" or "find the quote for this job and convert it, ' +
            'remaining balance is 20%" is convert_quote. ' +
            "amount is a plain number in the currency's major unit (e.g. rand, not cents) if a specific " +
            "amount was stated, exactly as given — never estimate or calculate, only use a number " +
            "that was actually stated, or null if none was. " +
            "fact_key and fact_value: if the message states a clear, structured attribute about the " +
            "customer that could apply to any customer (address, phone_number, email, etc.), extract it " +
            'as a short snake_case key and its value — e.g. fact_key: "address", fact_value: "12 Golf ' +
            'Way, Eco Estate, Eshowe". If the message is a general note that does not cleanly reduce to ' +
            "one key and value, set both to null. " +
            "personal_note: real speech often mixes a customer-related part with something that is " +
            "actually about the tradesperson's own life, not the customer — an errand, a reminder, a " +
            "family task. If the message contains such a fragment ALONGSIDE a customer reference, " +
            "extract just that personal fragment as personal_note, in its own words. If there is no " +
            "such mixed-in personal fragment, set it to null. " +
            'query_scope: ONLY set when intent is "lookup". "customer" if a specific customer_name was ' +
            'given. "personal" if it is about the tradesperson\'s own day, week, tasks, or schedule with ' +
            'no customer named. "business" if it is a business-wide question with no single customer named ' +
            '— asking about money owed across customers, totals, counts, or anything spanning more than one ' +
            'customer (e.g. "who owes me money", "how many customers do I have"). If intent is not ' +
            "lookup, set query_scope to null. " +
            'deposit_percent: ONLY set when intent is "convert_quote" — if a deposit percentage already ' +
            'paid was stated (e.g. "80% deposit"), extract it as a plain number (80, not 0.8). Null if no ' +
            "percentage was stated or intent is not convert_quote.\n\n" +
            "Examples:\n" +
            '"what do I need to do today?" -> {"customer_name":null,"intent":"lookup","amount":null,"fact_key":null,"fact_value":null,"personal_note":null,"query_scope":"personal","deposit_percent":null}\n' +
            '"who owes me money?" -> {"customer_name":null,"intent":"lookup","amount":null,"fact_key":null,"fact_value":null,"personal_note":null,"query_scope":"business","deposit_percent":null}\n' +
            '"what does Jenny owe?" -> {"customer_name":"Jenny","intent":"lookup","amount":null,"fact_key":null,"fact_value":null,"personal_note":null,"query_scope":"customer","deposit_percent":null}\n' +
            '"the total invoice for the carpets is R39000" -> {"customer_name":null,"intent":"invoice","amount":39000,"fact_key":null,"fact_value":null,"personal_note":null,"query_scope":null,"deposit_percent":null}\n' +
            '"we quoted Jenny R39000 for the carpets" -> {"customer_name":"Jenny","intent":"quotation","amount":39000,"fact_key":null,"fact_value":null,"personal_note":null,"query_scope":null,"deposit_percent":null}\n' +
            '"Jenny paid R850" -> {"customer_name":"Jenny","intent":"payment","amount":850,"fact_key":null,"fact_value":null,"personal_note":null,"query_scope":null,"deposit_percent":null}\n' +
            '"dropped the wife at work, need dog food later" -> {"customer_name":null,"intent":"note","amount":null,"fact_key":null,"fact_value":null,"personal_note":null,"query_scope":null,"deposit_percent":null}\n' +
            '"heading to jenny\'s job now, remind me to get dog food after" -> {"customer_name":"jenny","intent":"reminder","amount":null,"fact_key":null,"fact_value":null,"personal_note":"remind me to get dog food after","query_scope":null,"deposit_percent":null}\n' +
            '"we completed Jenny\'s installation, she paid an 80% deposit, convert the quote to an invoice for the remaining balance" -> {"customer_name":"Jenny","intent":"convert_quote","amount":null,"fact_key":null,"fact_value":null,"personal_note":null,"query_scope":null,"deposit_percent":80}\n\n' +
            "Return ONLY JSON, no markdown, no explanation: " +
            '{"customer_name": string or null, "intent": "payment" or "invoice" or "quotation" or ' +
            '"convert_quote" or "lookup" or "reminder" or "note" or "other", "amount": number or null, ' +
            '"fact_key": string or null, "fact_value": string or null, "personal_note": string or null, ' +
            '"query_scope": "customer" or "personal" or "business" or null, "deposit_percent": number or null}',
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

interface LineItemExtraction {
  description: string;
  note: string | null;
  quantity: number;
  unit: string | null;
  unit_price: number;
}

// A quotation or invoice is often more than one flat number — real
// speech describes multiple distinct lines ("carpet for the main
// bedroom at R18,700, plus uplift and restretch at R15,120"). This is
// a separate, focused call rather than folded into the main
// classifier — same reasoning as rewriteQuery and answerFromMemory
// being their own steps: one job per call, easier to get right, easier
// to test in isolation. Never asks the model to calculate anything —
// only to extract the numbers actually stated; the actual line total
// is always computed deterministically afterward, in code.
async function extractLineItems(env: Env, transcript: string): Promise<LineItemExtraction[]> {
  try {
    const result = await env.AI.run("@cf/moonshotai/kimi-k2.6", {
      temperature: 0,
      chat_template_kwargs: { thinking: false },
      messages: [
        {
          role: "system",
          content:
            "Extract every distinct line item from a tradesperson's quotation or invoice description. " +
            "Each line item has: description (what the work or material is), note (an informal aside or " +
            "preference mentioned alongside it, e.g. a colour preference — or null if none), quantity " +
            "(a plain number, default 1 if not stated), unit (e.g. 'sqm', 'meter', 'each', 'hour', or " +
            "null if not stated), and unit_price (the rand amount per unit, or the flat amount if " +
            "quantity is 1 and no per-unit rate was given). Never calculate a total yourself — only " +
            'extract numbers actually stated. Return ONLY JSON: {"line_items": [{"description": ' +
            'string, "note": string or null, "quantity": number, "unit": string or null, "unit_price": ' +
            "number}]}\n\n" +
            "Example:\n" +
            '"carpet for the main bedroom at R18700, plus uplift and restretch for R15120" -> ' +
            '{"line_items": [' +
            '{"description":"Supply and install carpet, main bedroom","note":null,"quantity":1,"unit":null,"unit_price":18700},' +
            '{"description":"Uplift carpet, uplift tile, rescreed and restretch carpet","note":null,"quantity":1,"unit":null,"unit_price":15120}' +
            "]}",
        },
        { role: "user", content: transcript },
      ],
    });
    const r2 = result as { choices?: Array<{ message?: { content?: string } }> };
    const rawText2 = r2.choices?.[0]?.message?.content ?? "";
    const cleaned2 = rawText2.replace(/```json|```/g, "").trim();
    const parsed2 = JSON.parse(cleaned2) as { line_items: LineItemExtraction[] };
    return parsed2.line_items ?? [];
  } catch {
    return [];
  }
}

// Crude first-pass reconciliation: match on the first token of the
// spoken name (usually the first name) against existing customers.
// Pronouns and other generic words are not names — reconciliation
// rejects them before ever creating a record, the same discipline as
// guarding money against an LLM's raw output becoming a permanent
// write with nothing deterministic checking it first.
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

// Second layer of defense against storing questions as facts — never
// trust intent classification alone for this, since it's been
// observed to misfire twice now, in two different storage paths
// (customer notes yesterday, life events today). A dumb, deterministic
// check can't be talked out of being right by an off day from the
// model. Not a replacement for the intent check — an extra one.
const QUESTION_STARTERS = [
  "what", "who", "when", "where", "why", "how", "do ", "does ", "did ",
  "is ", "are ", "was ", "were ", "can ", "could ", "would ", "should ",
];

function looksLikeAQuestion(text: string): boolean {
  const trimmed = text.trim().toLowerCase();
  if (trimmed.endsWith("?")) return true;
  return QUESTION_STARTERS.some((starter) => trimmed.startsWith(starter));
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

// Same discipline as recordPayment — the ground-truth write, only
// ever called from the confirm endpoint. Money billed deserves the
// same guard as money received, even though nothing physically moved
// yet: a wrong customer or a wrong amount here is just as real a
// mistake as a wrong payment would be.
async function recordInvoice(
  env: Env,
  customerId: number,
  description: string,
  amount: number,
  sourceTranscript: string
): Promise<{ id: number; customerId: number; amount: number }> {
  const inserted = await env.OFFICE_DB.prepare(
    "INSERT INTO invoices (customer_id, description, amount, source_transcript) VALUES (?, ?, ?, ?) RETURNING id"
  )
    .bind(customerId, description, amount, sourceTranscript)
    .first<{ id: number }>();

  return { id: inserted!.id, customerId, amount };
}

// Same guarded pattern again — a quotation is a real, standing figure
// Peter's given a customer, and getting it wrong (wrong amount, wrong
// customer) is exactly as consequential as getting a payment wrong,
// even though no money has moved yet.
interface LineItemWithTotal extends LineItemExtraction {
  line_total: number;
}

async function recordQuotation(
  env: Env,
  customerId: number,
  description: string,
  amount: number,
  sourceTranscript: string,
  lineItems: LineItemWithTotal[] = []
): Promise<{ id: number; customerId: number; amount: number }> {
  const inserted = await env.OFFICE_DB.prepare(
    "INSERT INTO quotations (customer_id, description, amount, source_transcript) VALUES (?, ?, ?, ?) RETURNING id"
  )
    .bind(customerId, description, amount, sourceTranscript)
    .first<{ id: number }>();

  const quotationId = inserted!.id;

  for (const item of lineItems) {
    await env.OFFICE_DB.prepare(
      "INSERT INTO line_items (quotation_id, description, note, quantity, unit, unit_price, line_total) VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
      .bind(quotationId, item.description, item.note, item.quantity, item.unit, item.unit_price, item.line_total)
      .run();
  }

  return { id: quotationId, customerId, amount };
}

// No reference-number system exists yet — with one customer generally
// having at most one open quote at a time, "their most recent
// not-yet-converted quote" is honest and sufficient for now. A real
// reference-number lookup is a reasonable refinement once someone
// actually has multiple simultaneous open quotes — not needed yet.
async function findLatestOpenQuotation(
  env: Env,
  customerId: number
): Promise<{ id: number; amount: number; description: string } | null> {
  const row = await env.OFFICE_DB.prepare(
    "SELECT id, amount, description FROM quotations WHERE customer_id = ? AND status != 'converted' ORDER BY created_at DESC LIMIT 1"
  )
    .bind(customerId)
    .first<{ id: number; amount: number; description: string }>();
  return row ?? null;
}

// The actual, guarded conversion. total/depositAmount/remainingBalance
// are computed once, in processTranscript, before this is ever held
// for confirmation — this function only ever writes numbers that were
// already decided, the same pattern as recordInvoice and
// recordQuotation. The deposit math itself is never something Kimi
// calculates — it identifies that a deposit was mentioned and what
// percentage; the multiplication and subtraction happen here, in code.
async function convertQuoteToInvoice(
  env: Env,
  quotationId: number,
  customerId: number,
  description: string,
  remainingBalance: number,
  sourceTranscript: string
): Promise<{ invoiceId: number }> {
  const inserted = await env.OFFICE_DB.prepare(
    "INSERT INTO invoices (customer_id, description, amount, source_transcript, quotation_id) VALUES (?, ?, ?, ?, ?) RETURNING id"
  )
    .bind(customerId, description, remainingBalance, sourceTranscript, quotationId)
    .first<{ id: number }>();

  const invoiceId = inserted!.id;

  await env.OFFICE_DB.prepare(
    "INSERT INTO line_items (invoice_id, description, quantity, unit_price, line_total) VALUES (?, ?, 1, ?, ?)"
  )
    .bind(invoiceId, description, remainingBalance, remainingBalance)
    .run();

  await env.OFFICE_DB.prepare("UPDATE quotations SET status = 'converted' WHERE id = ?").bind(quotationId).run();

  return { invoiceId };
}

// The real answer to "who owes me money" — a provable SQL aggregate,
// not an LLM's guess at what a sentence meant. Simplest honest first
// version: total invoiced per customer minus total paid per customer,
// not matched to specific invoices. Good enough for a real answer
// today; per-invoice reconciliation is a harder problem for later,
// once there's evidence it's actually needed.
async function getOutstandingInvoices(env: Env): Promise<string[]> {
  const { results } = await env.OFFICE_DB.prepare(
    `SELECT c.name as name,
            COALESCE(SUM(i.amount), 0) as invoiced,
            COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.customer_id = c.id), 0) as paid
     FROM customers c
     JOIN invoices i ON i.customer_id = c.id
     GROUP BY c.id
     HAVING invoiced > paid`
  ).all<{ name: string; invoiced: number; paid: number }>();

  return results.map((r) => `${r.name} owes R${r.invoiced - r.paid} (invoiced R${r.invoiced}, paid R${r.paid}).`);
}

// guard(): every money-touching intent lands here, not in the real
// ledger, until it's explicitly confirmed. Also reused for
// schema-candidate suggestions below — same mechanism, same
// discipline: the system proposes, a human decides, nothing
// consequential happens automatically.
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

// Fields already promoted to real columns go straight there. Anything
// else goes into the middle-tier holding table — structured, but not
// yet proven common enough across customers to earn its own column.
// This function never promotes a field itself; it can only write to
// the holding table. Promotion only ever happens via a human running
// an actual migration, prompted by the breadth-check below.
async function applyStructuredFact(
  env: Env,
  customerId: number,
  key: string,
  value: string,
  sourceTranscript: string
): Promise<void> {
  const normalizedKey = key.trim().toLowerCase().replace(/\s+/g, "_");
  try {
    if (normalizedKey === "address") {
      await env.OFFICE_DB.prepare("UPDATE customers SET address = ? WHERE id = ?").bind(value, customerId).run();
      return;
    }

    await env.OFFICE_DB.prepare(
      "INSERT INTO customer_facts (customer_id, key, value, source_transcript) VALUES (?, ?, ?, ?)"
    )
      .bind(customerId, normalizedKey, value, sourceTranscript)
      .run();
  } catch (err) {
    // This runs in ctx.waitUntil — there is no response left to attach
    // an error to. Log it durably instead of letting it vanish, same
    // discipline as appendCustomerNote and storeUnscopedMemory below.
    try {
      await env.OFFICE_DB.prepare("INSERT INTO memory_errors (customer_id, text, error) VALUES (?, ?, ?)")
        .bind(customerId, `structured fact: ${normalizedKey}=${value}`, err instanceof Error ? err.message : String(err))
        .run();
    } catch {
      // Nothing further to do if even the error log fails.
    }
  }
}

// --- Memory: color, not ground truth. Never used for money or ------
// anything with real-world consequence — only for recalling what was
// said (a preference, a note) when nothing structured exists to
// answer from instead.

async function embedText(env: Env, text: string): Promise<number[]> {
  const result = await env.AI.run("@cf/baai/bge-base-en-v1.5", { text });
  return (result as { data: number[][] }).data[0];
}

interface CustomerNote {
  text: string;
  storedAt: string;
}

// The primary read path for per-customer lookups now. Instant KV
// read, no async indexing delay — this is what "give me Jenny's
// address" actually reads from moments after it was said.
async function getCustomerNotes(env: Env, customerId: number): Promise<string[]> {
  try {
    const raw = await env.CUSTOMER_NOTES.get(`customer:${customerId}`);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { facts: CustomerNote[] };
    return parsed.facts.map((f) => f.text);
  } catch {
    return [];
  }
}

// The primary write path now. Instant, per-customer, no async
// indexing delay standing between "Peter said it" and "Peter can ask
// about it." Also queues the same fact into pending_memory_flush for
// later batch consolidation into Vectorize — that side stays
// intentionally slower, since it only serves cross-customer search
// and an unscoped fallback, never same-session recall.
async function appendCustomerNote(env: Env, customerId: number, text: string): Promise<void> {
  try {
    const key = `customer:${customerId}`;
    const raw = await env.CUSTOMER_NOTES.get(key);
    const existing: { facts: CustomerNote[] } = raw ? JSON.parse(raw) : { facts: [] };
    existing.facts.push({ text, storedAt: new Date().toISOString() });
    await env.CUSTOMER_NOTES.put(key, JSON.stringify(existing));

    await env.OFFICE_DB.prepare("INSERT INTO pending_memory_flush (customer_id, text) VALUES (?, ?)")
      .bind(customerId, text)
      .run();
  } catch (err) {
    try {
      await env.OFFICE_DB.prepare("INSERT INTO memory_errors (customer_id, text, error) VALUES (?, ?, ?)")
        .bind(customerId, text, err instanceof Error ? err.message : String(err))
        .run();
    } catch {
      // Nothing further to do if even the error log fails.
    }
  }
}

interface LifeEntry {
  text: string;
  storedAt: string;
}

// Peter's own life — not a customer, not a job, just a person
// thinking out loud in the truck. Date-keyed, same instant-write
// pattern as customer notes, so "what do I need to do today" is a
// direct KV read, not a search. This is the actual gap named last
// night: the pipeline could hear "Jenny lives at X" perfectly and had
// nowhere at all to put "picking up the wife at 15:30."
async function appendLifeEvent(env: Env, text: string): Promise<void> {
  try {
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const key = `life:${today}`;
    const raw = await env.CUSTOMER_NOTES.get(key);
    const existing: { facts: LifeEntry[] } = raw ? JSON.parse(raw) : { facts: [] };
    existing.facts.push({ text, storedAt: new Date().toISOString() });
    await env.CUSTOMER_NOTES.put(key, JSON.stringify(existing));
  } catch (err) {
    try {
      await env.OFFICE_DB.prepare("INSERT INTO memory_errors (customer_id, text, error) VALUES (NULL, ?, ?)")
        .bind(text, err instanceof Error ? err.message : String(err))
        .run();
    } catch {
      // Nothing further to do.
    }
  }
}

// Reads the last N days of life events, each tagged with its date so
// the synthesis step can reason about "today" versus "this week"
// correctly rather than treating everything as equally recent.
async function getRecentLifeEvents(env: Env, days: number): Promise<string[]> {
  const entries: string[] = [];
  const now = new Date();
  for (let i = 0; i < days; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    try {
      const raw = await env.CUSTOMER_NOTES.get(`life:${dateStr}`);
      if (raw) {
        const parsed = JSON.parse(raw) as { facts: LifeEntry[] };
        entries.push(...parsed.facts.map((f) => `[${dateStr}] ${f.text}`));
      }
    } catch {
      // Skip this day on error rather than fail the whole read.
    }
  }
  return entries;
}

// Fallback only, for the rare case a note has no identifiable
// customer to scope it to — writes straight to Vectorize since there
// is no KV key to append it under. Kept deliberately separate from
// the batched consolidation path below; this one write is genuinely
// one-off, not part of a queue.
async function storeUnscopedMemory(env: Env, text: string): Promise<void> {
  try {
    const vector = await embedText(env, text);
    await env.MEMORY.upsert([
      {
        id: crypto.randomUUID(),
        values: vector,
        metadata: { customerId: "", text, createdAt: new Date().toISOString() },
      },
    ]);
  } catch (err) {
    try {
      await env.OFFICE_DB.prepare("INSERT INTO memory_errors (customer_id, text, error) VALUES (NULL, ?, ?)")
        .bind(text, err instanceof Error ? err.message : String(err))
        .run();
    } catch {
      // Nothing further to do.
    }
  }
}

// Reranking replaces the hand-tuned raw-cosine threshold with an
// actual cross-encoder relevance judgment. Real observed data: the
// model's raw scores were ~0.0005 and ~0.00008 for a correct vs. an
// unrelated match — nowhere near a 0-1 range. What IS meaningful:
// relative ranking. So: sort by score, take the top few, and let the
// LLM synthesis step decide actual relevance.
async function rerank(env: Env, query: string, candidates: string[]): Promise<string[]> {
  if (candidates.length === 0) return [];
  try {
    const result = await env.AI.run("@cf/baai/bge-reranker-base", {
      query,
      contexts: candidates.map((text) => ({ text })),
    });
    const scored =
      (result as { response?: Array<{ id: number; score: number }> }).response ??
      (result as unknown as Array<{ id: number; score: number }>) ??
      [];
    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map((s) => candidates[s.id])
      .filter((t): t is string => !!t);
  } catch {
    return candidates;
  }
}

// Direct Vectorize search — now only used as a fallback when no
// customer has been identified at all (nothing in KV to read
// instead), and by the cross-customer debug tooling below.
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
    const result = await env.AI.run("@cf/moonshotai/kimi-k2.6", {
      temperature: 0,
      chat_template_kwargs: { thinking: false },
      messages: [
        {
          role: "system",
          content:
            "Answer the tradesperson's question using only the facts below. Be brief, one sentence, " +
            "but ALWAYS include any specific numbers, amounts, or figures from the facts — never " +
            "summarize a number away into a vague statement. " +
            "If the facts don't actually answer the question, say you don't have that on file.\n\n" +
            `Facts:\n${facts.map((f) => `- ${f}`).join("\n")}`,
        },
        { role: "user", content: question },
      ],
    });
    const r = result as { choices?: Array<{ message?: { content?: string } }> };
    const answer = r.choices?.[0]?.message?.content;
    return typeof answer === "string" && answer.trim() ? answer.trim() : facts[0];
  } catch {
    return facts[0];
  }
}

interface HistoryTurn {
  role: "user" | "office";
  text: string;
}

// Query rewriting: the established fix for pronoun/reference
// resolution in conversational retrieval. Turns "what did we invoice
// her?" into a fully self-contained question using recent context,
// BEFORE extraction or retrieval ever sees it. Runs on Kimi, not the
// small model — proven: the small model kept quietly answering the
// question instead of just resolving references, twice, even after
// explicit prompt constraints; Kimi got it right first try.
async function rewriteQuery(env: Env, history: HistoryTurn[], message: string): Promise<string> {
  if (history.length === 0) return message;
  try {
    const historyText = history.map((h) => `${h.role === "user" ? "Peter" : "Office"}: ${h.text}`).join("\n");
    const result = await env.AI.run("@cf/moonshotai/kimi-k2.6", {
      chat_template_kwargs: { thinking: false },
      temperature: 0,
      messages: [
        {
          role: "system",
          content:
            "Rewrite the new message to be fully self-contained, replacing any pronouns or vague " +
            "references (her, him, that, it, the invoice, etc.) with the specific name or thing they " +
            "refer to, using the conversation history for context. Do NOT answer the message, add new " +
            "information, or change its type — a question must stay phrased as a question, a statement " +
            "stays a statement. Only resolve what the ambiguous words refer to. If the message is " +
            "already self-contained, return it completely unchanged. Return ONLY the rewritten message, " +
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

// Shared by both /files/audio (after transcription) and /messages/text
// (directly on typed input) — same extraction, reconciliation, guard(),
// and memory logic either way. A transcript is a transcript, whether
// it came from Whisper or a keyboard.
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

  if (extraction?.intent === "invoice" && customer && extraction.amount) {
    const held = await holdForConfirmation(
      env,
      "invoice",
      { customerId: customer.id, customerName: customer.name, description: transcript, amount: extraction.amount },
      transcript
    );
    pendingActionId = held.id;
  }

  let quotationLineItems: LineItemWithTotal[] = [];
  if (extraction?.intent === "quotation" && customer) {
    const rawLineItems = await extractLineItems(env, transcript);
    // Line total is always computed here, in code — never asked of
    // the model. Same discipline as every rand figure all day.
    quotationLineItems = rawLineItems.map((item) => ({
      ...item,
      line_total: item.quantity * item.unit_price,
    }));
    const total =
      quotationLineItems.length > 0
        ? quotationLineItems.reduce((sum, item) => sum + item.line_total, 0)
        : extraction.amount ?? 0;

    if (total > 0) {
      const held = await holdForConfirmation(
        env,
        "quotation",
        {
          customerId: customer.id,
          customerName: customer.name,
          description: transcript,
          amount: total,
          lineItems: quotationLineItems,
        },
        transcript
      );
      pendingActionId = held.id;
    }
  }

  let convertQuoteFound: { quotationId: number; total: number; depositAmount: number; remainingBalance: number } | null = null;
  if (extraction?.intent === "convert_quote" && customer) {
    const quotation = await findLatestOpenQuotation(env, customer.id);
    if (quotation) {
      const total = quotation.amount;
      // Deposit math computed once, here, deterministically — this is
      // the actual number that gets held for confirmation and, later,
      // written verbatim. Kimi only ever identifies the percentage
      // stated; it never touches this arithmetic.
      const depositAmount = extraction.deposit_percent ? total * (extraction.deposit_percent / 100) : 0;
      const remainingBalance = total - depositAmount;
      convertQuoteFound = { quotationId: quotation.id, total, depositAmount, remainingBalance };

      const held = await holdForConfirmation(
        env,
        "convert_quote",
        {
          quotationId: quotation.id,
          customerId: customer.id,
          customerName: customer.name,
          description: `Balance due — ${quotation.description}`,
          remainingBalance,
          total,
          depositAmount,
          depositPercent: extraction.deposit_percent,
        },
        transcript
      );
      pendingActionId = held.id;
    }
  }

  // A promoted field (address) or a candidate for the holding table —
  // written immediately either way, independent of whether this also
  // gets stored as a narrative note below.
  if (extraction?.fact_key && extraction?.fact_value && customer) {
    ctx.waitUntil(applyStructuredFact(env, customer.id, extraction.fact_key, extraction.fact_value, transcript));
  }

  // A personal fragment riding alongside a customer message gets its
  // own life event, independent of whatever happens to the customer
  // part below. This is what stops "remind me to get dog food" from
  // silently vanishing into a stranger's customer file.
  if (extraction?.personal_note) {
    ctx.waitUntil(appendLifeEvent(env, extraction.personal_note));
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
  const isQuestion = extraction?.intent === "lookup" || looksLikeAQuestion(transcript);
  if (!isQuestion) {
    if (customer) {
      ctx.waitUntil(appendCustomerNote(env, customer.id, transcript));
    } else if (!extraction?.personal_note) {
      // Only fall back to storing the whole transcript as a life
      // event if personal_note didn't already capture the relevant
      // fragment above — avoids storing the same thing twice.
      ctx.waitUntil(appendLifeEvent(env, transcript));
    }
  }

  let message: string;
  if (extraction?.intent === "convert_quote" && !pendingActionId) {
    // Intent recognized, but no open quotation exists for this
    // customer to convert — say so honestly rather than silently
    // falling through to a generic message.
    message = customer
      ? `I don't have an open quotation on file for ${customer.name} to convert.`
      : "I don't have anything on file for that yet.";
  } else if (pendingActionId && extraction?.intent === "convert_quote" && convertQuoteFound) {
    const { total, depositAmount, remainingBalance, quotationId } = convertQuoteFound;
    const depositNote = extraction.deposit_percent
      ? ` ${extraction.deposit_percent}% deposit (R${depositAmount}) already paid —`
      : "";
    message = `Found quotation #${quotationId} for ${customer!.name} (R${total} total).${depositNote} remaining balance R${remainingBalance}. Needs your confirmation (action #${pendingActionId}) to convert to invoice.`;
  } else if (pendingActionId) {
    const kind = extraction?.intent === "invoice" ? "Invoice" : extraction?.intent === "quotation" ? "Quotation" : "Payment";
    const displayAmount =
      extraction?.intent === "quotation" && quotationLineItems.length > 0
        ? quotationLineItems.reduce((sum, item) => sum + item.line_total, 0)
        : extraction!.amount;
    const lineItemNote =
      quotationLineItems.length > 0
        ? ` (${quotationLineItems.length} line item${quotationLineItems.length > 1 ? "s" : ""})`
        : "";
    message = `${kind} noted for ${customer!.name}${displayAmount ? ` of R${displayAmount}` : ""}${lineItemNote} — needs your confirmation (action #${pendingActionId}) before it's recorded.`;
  } else if (extraction?.intent === "lookup") {
    if (extraction?.query_scope === "business") {
      // No single customer — a business-wide financial question,
      // answered from a real SQL aggregate, not a guess from a
      // sentence. This is the actual fix for "who owes me money."
      const outstandingFacts = await getOutstandingInvoices(env);
      message = await answerFromMemory(env, rewritten, outstandingFacts);
    } else if (customer) {
      const memoryFacts = await getCustomerNotes(env, customer.id);
      const facts = [`${customer.name} is a known customer.`, ...memoryFacts];
      message = await answerFromMemory(env, rewritten, facts);
    } else {
      // No customer named, not a business question — a question
      // about Peter's own day or week. Read straight from the
      // date-keyed life-event store, not an unscoped Vectorize search.
      const lifeFacts = await getRecentLifeEvents(env, 7);
      message = await answerFromMemory(env, rewritten, lifeFacts);
    }
  } else if (customer) {
    message = customer.matched ? `Found existing customer: ${customer.name}.` : `New customer noted: ${customer.name}.`;
    if (extraction?.personal_note) {
      message += ` Also noted: ${extraction.personal_note}.`;
    }
  } else {
    message = "Got it.";
  }

  return { extraction, extractionRaw, extractionRawText, customer, pendingActionId, message, rewrittenQuery: rewritten };
}

// Consolidation: drains pending_memory_flush into Vectorize in ONE
// batched upsert instead of many individual ones — the pattern
// Cloudflare's own docs recommend for write-heavy workloads. Also
// runs the schema-candidate breadth-check in the same pass. Shared by
// the real hourly cron and a manual debug trigger for testing today.
async function runConsolidation(env: Env): Promise<{ flushed: number; schemaCandidates: string[] }> {
  const { results } = await env.OFFICE_DB.prepare(
    "SELECT id, customer_id, text FROM pending_memory_flush ORDER BY id LIMIT 500"
  ).all<{ id: number; customer_id: number | null; text: string }>();

  let flushed = 0;
  if (results.length > 0) {
    try {
      const vectors = await Promise.all(
        results.map(async (row) => ({
          id: crypto.randomUUID(),
          values: await embedText(env, row.text),
          metadata: {
            customerId: row.customer_id != null ? String(row.customer_id) : "",
            text: row.text,
            createdAt: new Date().toISOString(),
          },
        }))
      );
      await env.MEMORY.upsert(vectors);
      flushed = vectors.length;

      const ids = results.map((r) => r.id);
      await env.OFFICE_DB.prepare(`DELETE FROM pending_memory_flush WHERE id IN (${ids.map(() => "?").join(",")})`)
        .bind(...ids)
        .run();
    } catch (err) {
      await env.OFFICE_DB.prepare("INSERT INTO memory_errors (customer_id, text, error) VALUES (NULL, ?, ?)")
        .bind(`consolidation batch of ${results.length}`, err instanceof Error ? err.message : String(err))
        .run();
    }
  }

  // Breadth-check: any key in the holding table now common enough
  // across distinct customers to be worth a real column? This never
  // executes a migration — only proposes, via the same pending_action
  // mechanism as a payment, so a human always makes the actual call.
  const schemaCandidates: string[] = [];
  const { results: breadthResults } = await env.OFFICE_DB.prepare(
    "SELECT key, COUNT(DISTINCT customer_id) as breadth FROM customer_facts GROUP BY key HAVING breadth >= 5"
  ).all<{ key: string; breadth: number }>();

  for (const row of breadthResults) {
    const existingCandidate = await env.OFFICE_DB.prepare(
      "SELECT id FROM pending_actions WHERE type = 'schema_candidate' AND json_extract(payload, '$.key') = ? AND status = 'pending'"
    )
      .bind(row.key)
      .first();

    if (!existingCandidate) {
      await holdForConfirmation(
        env,
        "schema_candidate",
        { key: row.key, breadth: row.breadth },
        `Auto-detected: "${row.key}" now recorded for ${row.breadth} distinct customers — worth its own column?`
      );
      schemaCandidates.push(row.key);
    }
  }

  return { flushed, schemaCandidates };
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

    // Inspect the actual primary memory now — the KV blob for one
    // customer, not Vectorize (which lags behind, batched, on cron).
    if (url.pathname === "/debug/customer-notes" && request.method === "GET") {
      const customerId = url.searchParams.get("customerId");
      if (!customerId) return Response.json({ error: "missing ?customerId=" }, { status: 400 });
      const raw = await env.CUSTOMER_NOTES.get(`customer:${customerId}`);
      return Response.json({ customerId, raw: raw ? JSON.parse(raw) : null });
    }

    // Inspect a given day's life events directly — defaults to today.
    if (url.pathname === "/debug/life-events" && request.method === "GET") {
      const date = url.searchParams.get("date") ?? new Date().toISOString().slice(0, 10);
      const raw = await env.CUSTOMER_NOTES.get(`life:${date}`);
      return Response.json({ date, raw: raw ? JSON.parse(raw) : null });
    }

    if (url.pathname === "/debug/memory-errors" && request.method === "GET") {
      const { results } = await env.OFFICE_DB.prepare(
        "SELECT id, customer_id, text, error, created_at FROM memory_errors ORDER BY created_at DESC LIMIT 20"
      ).all();
      return Response.json({ errors: results });
    }

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

    if (url.pathname === "/debug/stress-memory" && request.method === "GET") {
      const count = Number(url.searchParams.get("count") ?? "20");
      try {
        const before = await env.MEMORY.describe();
        const writes = Array.from({ length: count }, (_, i) =>
          storeUnscopedMemory(env, `stress test entry number ${i} at ${Date.now()}`)
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

    if (url.pathname === "/debug/rerank-raw" && request.method === "GET") {
      const query = url.searchParams.get("query") ?? "what is Jenny's address?";
      const customerId = url.searchParams.get("customerId") ?? "1";
      try {
        const vector = await embedText(env, query);
        const vecResults = await env.MEMORY.query(vector, {
          topK: 8,
          returnMetadata: true,
          filter: { customerId },
        });
        const candidates = (vecResults.matches ?? [])
          .map((m) => (m.metadata as { text?: string } | undefined)?.text)
          .filter((t): t is string => !!t);

        const rerankResult = await env.AI.run("@cf/baai/bge-reranker-base", {
          query,
          contexts: candidates.map((text) => ({ text })),
        });

        return Response.json({ query, candidates, rerankResultRaw: rerankResult });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
      }
    }

    // Manual trigger for the same job the hourly cron runs — lets us
    // test consolidation and schema-candidate detection today instead
    // of waiting for the clock.
    if (url.pathname === "/admin/flush-memory" && request.method === "POST") {
      const result = await runConsolidation(env);
      return Response.json(result);
    }

    // Regression smoke test — zero side effects, tests extraction
    // classification alone (the piece that's actually broken most
    // often today), not the full write pipeline. Safe to rerun after
    // every future change without polluting KV or D1 with test data,
    // the exact mistake that broke retrieval twice yesterday.
    if (url.pathname === "/debug/smoke-test" && request.method === "GET") {
      const cases: Array<{ name: string; text: string; check: (e: Extraction | null) => boolean }> = [
        {
          name: "mixed customer+personal message splits correctly",
          text: "heading to jenny's job now, remind me to get dog food after",
          check: (e) => e?.customer_name?.toLowerCase() === "jenny" && !!e?.personal_note,
        },
        {
          name: "self-directed question classifies as personal lookup",
          text: "what do I need to do today?",
          check: (e) => e?.intent === "lookup" && e?.query_scope === "personal",
        },
        {
          name: "business financial question classifies as business lookup",
          text: "who owes me money?",
          check: (e) => e?.intent === "lookup" && e?.query_scope === "business",
        },
        {
          name: "plain customer lookup classifies correctly",
          text: "what is Jenny's address?",
          check: (e) => e?.intent === "lookup" && e?.query_scope === "customer",
        },
        {
          name: "payment classifies correctly, not invoice",
          text: "Jenny paid R500",
          check: (e) => e?.intent === "payment",
        },
        {
          name: "invoice classifies correctly, not payment",
          text: "we invoiced Jenny R2000 for materials",
          check: (e) => e?.intent === "invoice",
        },
        {
          name: "quotation classifies correctly, not invoice",
          text: "we quoted Jenny R6000 for the new blinds",
          check: (e) => e?.intent === "quotation",
        },
        {
          name: "convert_quote classifies correctly with deposit percent",
          text: "we completed Jenny's installation, she paid an 80% deposit, convert the quote to an invoice for the remaining balance",
          check: (e) => e?.intent === "convert_quote" && e?.deposit_percent === 80,
        },
        {
          name: "a stated fact is not misread as a question",
          text: "jenny lives at 5 Ocean View, Eshowe",
          check: (e) => e?.intent !== "lookup",
        },
      ];

      const results = await Promise.all(
        cases.map(async (c) => {
          const { extraction } = await extractIntent(env, c.text);
          return { name: c.name, input: c.text, pass: c.check(extraction), extraction };
        })
      );

      return Response.json({ allPassed: results.every((r) => r.pass), results });
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
      try {
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

        if (action.type === "invoice") {
          const payload = JSON.parse(action.payload) as {
            customerId: number;
            description: string;
            amount: number;
          };
          const invoice = await recordInvoice(env, payload.customerId, payload.description, payload.amount, action.source_transcript);
          await env.OFFICE_DB.prepare(
            "UPDATE pending_actions SET status = 'confirmed', resolved_at = datetime('now') WHERE id = ?"
          )
            .bind(id)
            .run();
          return Response.json({ status: "confirmed", invoice });
        }

        if (action.type === "quotation") {
          const payload = JSON.parse(action.payload) as {
            customerId: number;
            description: string;
            amount: number;
            lineItems?: LineItemWithTotal[];
          };
          const quotation = await recordQuotation(
            env,
            payload.customerId,
            payload.description,
            payload.amount,
            action.source_transcript,
            payload.lineItems ?? []
          );
          await env.OFFICE_DB.prepare(
            "UPDATE pending_actions SET status = 'confirmed', resolved_at = datetime('now') WHERE id = ?"
          )
            .bind(id)
            .run();
          return Response.json({ status: "confirmed", quotation });
        }

        if (action.type === "convert_quote") {
          const payload = JSON.parse(action.payload) as {
            quotationId: number;
            customerId: number;
            description: string;
            remainingBalance: number;
          };
          const result = await convertQuoteToInvoice(
            env,
            payload.quotationId,
            payload.customerId,
            payload.description,
            payload.remainingBalance,
            action.source_transcript
          );
          await env.OFFICE_DB.prepare(
            "UPDATE pending_actions SET status = 'confirmed', resolved_at = datetime('now') WHERE id = ?"
          )
            .bind(id)
            .run();
          return Response.json({ status: "confirmed", invoice: result });
        }

        if (action.type === "schema_candidate") {
          // Acknowledged only — this never runs a migration itself. The
          // actual ALTER TABLE / CREATE TABLE stays a deliberate, manual
          // step, the same way it has been all day.
          await env.OFFICE_DB.prepare(
            "UPDATE pending_actions SET status = 'confirmed', resolved_at = datetime('now') WHERE id = ?"
          )
            .bind(id)
            .run();
          return Response.json({
            status: "acknowledged",
            note: "No migration was run. Add the column or table yourself when ready.",
            payload: JSON.parse(action.payload),
          });
        }

        return Response.json({ error: `unknown pending action type: ${action.type}` }, { status: 400 });
      } catch (err) {
        // This handler never had error handling wrapped around it at
        // all — an uncaught exception here just produced Cloudflare's
        // generic crash page, with no way to see what actually broke.
        return Response.json(
          { error: "confirm handler threw", detail: err instanceof Error ? err.message : String(err) },
          { status: 500 }
        );
      }
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
            rewrittenQuery: "",
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

  // The real hourly consolidation — same job the manual
  // /admin/flush-memory debug route triggers, running on its own
  // schedule now (see [triggers] in wrangler.toml).
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runConsolidation(env).then(() => undefined));
  },
};












