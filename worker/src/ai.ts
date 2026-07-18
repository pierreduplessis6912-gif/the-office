// The AI primitive (Principle 2, "AI Is a Translator") — every place a model
// is actually called: extraction, narration, rewriting, vision, embeddings,
// reranking. Nothing here writes to D1 except read-only lookups feeding a
// prompt. No business logic, no decisions — extract and narrate, per the
// Constitution.

import type {
  Env,
  Extraction,
  LineItemExtraction,
  ScopePricingItem,
  WorkObservationExtraction,
  HistoryTurn,
} from "./types";


// Real evidence today: multiple genuine, transient AI-call failures,
// every single one succeeding cleanly on a plain retry seconds later.
// Wrapping every real model call in a couple of quick, automatic
// retries means Peter should rarely if ever see one of these at all
// — the existing per-function fallback behavior (empty results, a
// logged error) is still there as a backstop if every attempt
// genuinely fails, this just makes reaching that backstop far less
// likely.
export async function withRetry<T>(fn: () => Promise<T>, maxAttempts: number = 3, baseDelayMs: number = 300): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, baseDelayMs * 2 ** (attempt - 1)));
      }
    }
  }
  throw lastError;
}

export async function transcribe(env: Env, audioBuffer: ArrayBuffer): Promise<{ transcript: string | null; transcriptionError: string | null }> {
  try {
    const result = await withRetry(() =>
      env.AI.run("@cf/openai/whisper", {
        audio: [...new Uint8Array(audioBuffer)],
      })
    );
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
// Real feature 2026-07-13 — the multi-intent split, built the safe
// way: rather than duplicate extractIntent's large, carefully-tuned
// prompt into a parallel "extract many things" version (real risk of
// the two drifting out of sync on the next bug fix), this is a small,
// focused new step — find genuinely separate topics, then call the
// existing, unchanged extractIntent once per segment. Real, honest
// tradeoff, named directly rather than hidden: this adds one real AI
// call to every message, even single-topic ones, since the split
// check has to run before anything else.
export async function splitIntoTopics(env: Env, transcript: string): Promise<string[]> {
  try {
    const result = await withRetry(() =>
      env.AI.run("@cf/moonshotai/kimi-k2.6", {
        temperature: 0,
        chat_template_kwargs: { thinking: false },
        messages: [
          {
            role: "system",
            content:
              "A tradesperson sometimes says several genuinely separate things in one message — " +
              "different topics that each need to be recorded separately (a job note, an expense, a " +
              "reminder, a fact about a person, an invoice). Find genuinely SEPARATE topics and split " +
              "them into self-contained segments, each with enough context to stand alone. Do NOT split " +
              "a single continuous thought into pieces just because it's long — only split when the " +
              "message moves to a genuinely different subject or type of information. The word \"and\" " +
              "does NOT by itself mean a new topic — most sentences use \"and\" to continue the SAME " +
              "thought. Real bug found live 2026-07-13: \"Sipho is measuring the hospital and theatre " +
              "one is three by two\" was wrongly split into two pieces at the word \"and\", separating a " +
              "measurement from the job observation it's actually part of — a room name and its " +
              "dimensions belong to the SAME observation as who's doing the measuring, never a separate " +
              "topic, no matter how the sentence is joined. If the whole message is about ONE topic, " +
              "return it as a single segment, unchanged. Rewrite a segment only to carry over context it " +
              "would otherwise lose by being separated (e.g. an implied subject) — never add information " +
              "that wasn't actually stated. Return ONLY a JSON array of strings.\n\n" +
              "Examples:\n" +
              '"create an invoice for Jenny for R3200, Sipho is measuring the hospital and theatre one ' +
              'is three by two, remember to buy dog food, and John has lost his work boots, we need to ' +
              'get him some new work boots" -> ["create an invoice for Jenny for R3200", "Sipho is ' +
              'measuring the hospital and theatre one is three by two", "remember to buy dog food", ' +
              '"John has lost his work boots, we need to get him some new work boots"]\n' +
              '"Sipho is measuring the hospital and theatre one is three by two" -> ["Sipho is ' +
              'measuring the hospital and theatre one is three by two"]\n' +
              '"bought glue for R850 at BUCO" -> ["bought glue for R850 at BUCO"]\n' +
              '"Jenny paid R500" -> ["Jenny paid R500"]',
          },
          { role: "user", content: transcript },
        ],
      })
    );
    const r = result as { choices?: Array<{ message?: { content?: string } }> };
    const rawText = r.choices?.[0]?.message?.content ?? "";
    const cleaned = rawText.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed) && parsed.length > 0 && parsed.every((s) => typeof s === "string")) {
      return parsed;
    }
    return [transcript];
  } catch {
    // Real failure mode kept deliberately safe: if the split itself
    // fails for any reason, fall back to treating the whole message
    // as one topic — exactly today's proven behavior, never worse.
    return [transcript];
  }
}

export async function extractMultipleIntents(
  env: Env,
  transcript: string
): Promise<Array<{ segment: string; extraction: Extraction | null; raw: unknown; rawText: string | null }>> {
  const segments = await splitIntoTopics(env, transcript);
  const results: Array<{ segment: string; extraction: Extraction | null; raw: unknown; rawText: string | null }> = [];
  for (const segment of segments) {
    const result = await extractIntent(env, segment);
    results.push({ segment, ...result });
  }
  return results;
}

export async function extractIntent(env: Env, transcript: string): Promise<{ extraction: Extraction | null; raw: unknown; rawText: string | null }> {
  let rawText: string | null = null;
  let result: unknown = null;
  try {
    result = await withRetry(() =>
      env.AI.run("@cf/moonshotai/kimi-k2.6", {
        temperature: 0,
        chat_template_kwargs: { thinking: false },
        messages: [
          {
            role: "system",
            content:
              "Extract structured facts from a tradesperson's message. " +
            "The real invariant that decides customer_name vs character_name is whether the tradesperson " +
            "BILLS this entity — quotes, invoices, jobs, or payments FROM them TO this entity — never " +
            "whether the relationship is personal or business. " +
            'customer_name is the specific entity the tradesperson bills — the one who owes money for ' +
            "work or goods the tradesperson provides. Exactly as spoken or typed, or null if none. " +
            'character_name is ANYONE mentioned who is NOT billed by the tradesperson — this covers both ' +
            "personal relations (spouse, family, staff, friends) AND business relations the tradesperson " +
            "does NOT invoice, most importantly suppliers, subcontractors, or referral partners (someone " +
            "the tradesperson buys FROM or pays, not someone who owes the tradesperson). A supplier is " +
            "never customer_name, even though the relationship is business, not personal — the " +
            "tradesperson doesn't bill their supplier, so the same protection from ever being " +
            "accidentally quoted or invoiced that a personal relation gets applies here too. Real bug " +
            "found live 2026-07-13: \"Sipho is measuring the hospital\" — naming only an installer doing " +
            "the work, no separate customer ever stated — had the installer's name forced into " +
            "customer_name since it was the only name available, creating a job record linked to the " +
            "wrong entity. The person DOING or PERFORMING work (measuring, installing, delivering, " +
            "fetching) is character_name (relationship \"installer\" or \"staff\"), never customer_name — " +
            "even when no other name is mentioned at all. customer_name is only ever who the job is FOR " +
            "or who gets billed; if that's genuinely not named in the message, leave customer_name null " +
            "rather than substituting whichever name happens to be available. " +
            "character_relationship is the stated relationship if given (e.g. \"wife\", \"nanny\", " +
            '"son", "supplier", "subcontractor"), or a reasonable short label inferred from context ' +
            '(e.g. "supplier" for a company the tradesperson clearly buys materials from), or null if ' +
            "genuinely unclear. Only one of customer_name or character_name should be set per message. " +
            "CRITICAL — when a message mentions more than one name, customer_name/character_name must be " +
            "whichever one the message is actually ABOUT — the entity performing or experiencing what's " +
            "described — never a different name mentioned only as incidental context. For example, " +
            '"ProSupply was late delivering the tiles for Jenny\'s job" is ABOUT ProSupply\'s lateness; ' +
            "Jenny is only mentioned as which job was affected, not who or what the message is actually " +
            "describing — character_name here is \"ProSupply\" (a supplier), not \"Jenny\". Always ask: " +
            "who or what is this sentence fundamentally reporting on, not just which names appear in it. " +
            "A second, related trap: when a message names an INDIVIDUAL PERSON only as a staff member or " +
            "contact AT a company (e.g. \"Sarah in dispatch\" at ProSupply, \"their rep\", \"the guy at " +
            "Company X\"), the note is really about the COMPANY relationship, not a new standalone person " +
            "— character_name must stay the company (e.g. \"ProSupply\"), never the individual's first " +
            "name alone. Splitting a supplier relationship across a separate record for every staff " +
            "member mentioned in passing scatters the same relationship across multiple untraceable " +
            "entities. Only extract a person as their own character_name when they're referenced " +
            "independently of any company context (a personal relation, or someone with no stated employer " +
            'in the message). "called ProSupply about the March delay, spoke to Sarah in dispatch, she ' +
            'was rude about it" is about the ProSupply relationship — character_name is "ProSupply", not ' +
            '"Sarah"; Sarah\'s rudeness is a detail worth keeping in the note text itself, not a reason to ' +
            "fork off a new entity. " +
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
            'intent is "price_scope" if the message states prices or rates to apply to a job that was ' +
            "already measured and scoped earlier (an existing job_scope with components and/or tasks), " +
            "turning that unpriced observation into a real priced document — either a quotation or an " +
            'invoice. This differs from plain "quotation"/"invoice" — those are a fresh price given ' +
            "directly for described work with no prior measurement step; price_scope specifically " +
            'references pricing up something already measured (e.g. "price up Dwayne\'s job", "R450 a ' +
            'square meter for the reception area", "R3500 flat for the repair work"). Prefer price_scope ' +
            "whenever a rate is being applied per named component or area rather than one flat total " +
            "invented fresh for the whole job. " +
            'When intent is "price_scope", also set scope_document_type using the EXACT SAME tense rule ' +
            'as quotation vs invoice above: "quote"/"quoted"/"estimate"/"price up" -> "quotation" (a ' +
            'proposed price, nothing billed yet); "invoice"/"invoiced"/"bill"/"invoice out" -> "invoice" ' +
            "(work is done or being billed now, not merely proposed). If genuinely ambiguous with no " +
            'clear signal either way, default to "quotation" — proposing a price is less consequential ' +
            "than billing one, so the safer default when unsure is the earlier, less committal document. " +
            'scope_document_type is null whenever intent is not "price_scope". ' +
            'intent is "expense" if the message describes money going OUT to a supplier for something ' +
            'bought — materials, fuel, tools, supplies. "bought glue for R850 at BUCO" or "paid FinFloor ' +
            'R18450 for vinyl" is expense. This is the OPPOSITE direction from "payment" — payment is ' +
            'money coming IN from a customer; expense is money going OUT to a supplier. Use character_name ' +
            '(with character_relationship "supplier") for who was PAID. If the message ALSO names which ' +
            "job or customer this cost was FOR (job-costing) — \"bought glue for R850 at BUCO for Jenny's " +
            'job" or "that vinyl was for the Thanda job" — set customer_name to that job/customer. This is ' +
            "a genuinely different meaning from every other intent's use of customer_name (who to bill) — " +
            "an expense never bills anyone, so there's no ambiguity: customer_name on an expense always " +
            "means \"which job this cost belongs to,\" never \"who owes money.\" Leave customer_name null " +
            "if no job/customer context was stated at all — never guess one. " +
            'intent is "task_complete" if the message reports a personal errand or reminder as DONE — ' +
            '"got the dog food", "picked up the kids", "phoned my mother" — past tense, something ' +
            'finished, not a new request. This includes bare, pronoun-only completions with no concrete ' +
            'object stated — "did that", "called them", "sorted", "done" — these still count as ' +
            "task_complete even without naming what was done; exactly WHICH open task it completes is " +
            "resolved separately, later, against the real list of open tasks — your only job here is " +
            "recognizing that a completion is being reported at all, however vaguely phrased. This is " +
            'different from "reminder", which is asking for something to be remembered for LATER, not ' +
            "reporting it done now. " +
            'intent is "work_observation" if the message describes measuring, scoping, or inspecting a job ' +
            '— components, measurements, or tasks — with NO price stated at all. This is earlier than a ' +
            'quotation: the tradesperson is recording what they observed, not proposing a cost. If any ' +
            'rand amount is mentioned, it is NOT work_observation — use quotation, invoice, price_scope, ' +
            "or payment instead. " +
            "amount is a plain number in the currency's major unit (e.g. rand, not cents) if a specific " +
            "amount was stated, exactly as given — never estimate or calculate, only use a number " +
            "that was actually stated, or null if none was. " +
            "fact_key and fact_value: if the message states a clear, structured attribute about the " +
            "customer OR about a character (a real, non-billed person — a staff member, installer, " +
            "supplier), extract it as a short snake_case key and its value, the same way either way — " +
            "just note which one it's about via customer_name/character_name as already extracted. For " +
            "a phone number, email, or address specifically, ALWAYS use exactly these keys — " +
            '"phone_number", "email", or "address" — never a variant like "cell", "mobile", or ' +
            '"contact_number", so the same kind of fact is always named the same way. For structured ' +
            "attributes about a character specifically — a role, a skill, a qualification, a license, a " +
            "site permit — use a clear snake_case key (e.g. \"role\", \"skill\", \"license\", " +
            '"site_permit"). For anything else genuinely specific to this trade or job (e.g. a circuit ' +
            'rating, a paint colour, a fabric type), invent a short, clear snake_case key as before — ' +
            'e.g. fact_key: "address", fact_value: "12 Golf Way, Eco Estate, Eshowe". Extract the value ' +
            "exactly as stated — never reformat, normalize, or convert it yourself, that always happens " +
            "afterward, in code. If the message is a general note that does not cleanly reduce to one " +
            "key and value, set both to null. " +
            "personal_note: real speech often mixes a customer-related part with something that is " +
            "actually about the tradesperson's own life, not the customer — an errand, a reminder, a " +
            "family task. If the message contains such a fragment ALONGSIDE a customer reference, " +
            "extract just that personal fragment as personal_note, in its own words. If there is no " +
            "such mixed-in personal fragment, set it to null. " +
            'query_scope: ONLY set when intent is "lookup". "customer" if a specific customer_name was ' +
            'given. "character" if a specific character_name was given instead — asking about anyone the ' +
            'tradesperson does not bill, personal or a supplier (e.g. "how is my wife doing", "why don\'t ' +
            'we buy from ProSupply anymore"). "personal" if it is about the ' +
            "tradesperson's own day, week, tasks, or schedule with no customer or character named. " +
            '"business" if it is a business-wide question with no single customer named — asking about ' +
            "money owed across customers, totals, counts, or anything spanning more than one customer " +
            '(e.g. "who owes me money", "how many customers do I have"). If intent is not lookup, set ' +
            "query_scope to null. " +
            'deposit_percent: ONLY set when intent is "convert_quote" — if a deposit percentage already ' +
            'paid was stated (e.g. "80% deposit"), extract it as a plain number (80, not 0.8). Null if no ' +
            "percentage was stated or intent is not convert_quote.\n\n" +
            "Examples:\n" +
            '"what do I need to do today?" -> {"customer_name":null,"character_name":null,"character_relationship":null,"intent":"lookup","amount":null,"fact_key":null,"fact_value":null,"personal_note":null,"query_scope":"personal","deposit_percent":null,"scope_document_type":null}\n' +
            '"who owes me money?" -> {"customer_name":null,"character_name":null,"character_relationship":null,"intent":"lookup","amount":null,"fact_key":null,"fact_value":null,"personal_note":null,"query_scope":"business","deposit_percent":null,"scope_document_type":null}\n' +
            '"what does Jenny owe?" -> {"customer_name":"Jenny","character_name":null,"character_relationship":null,"intent":"lookup","amount":null,"fact_key":null,"fact_value":null,"personal_note":null,"query_scope":"customer","deposit_percent":null,"scope_document_type":null}\n' +
            '"the total invoice for the carpets is R39000" -> {"customer_name":null,"character_name":null,"character_relationship":null,"intent":"invoice","amount":39000,"fact_key":null,"fact_value":null,"personal_note":null,"query_scope":null,"deposit_percent":null,"scope_document_type":null}\n' +
            '"we quoted Jenny R39000 for the carpets" -> {"customer_name":"Jenny","character_name":null,"character_relationship":null,"intent":"quotation","amount":39000,"fact_key":null,"fact_value":null,"personal_note":null,"query_scope":null,"deposit_percent":null,"scope_document_type":null}\n' +
            '"Jenny paid R850" -> {"customer_name":"Jenny","character_name":null,"character_relationship":null,"intent":"payment","amount":850,"fact_key":null,"fact_value":null,"personal_note":null,"query_scope":null,"deposit_percent":null,"scope_document_type":null}\n' +
            '"bought glue for R850 at BUCO" -> {"customer_name":null,"character_name":"BUCO","character_relationship":"supplier","intent":"expense","amount":850,"fact_key":null,"fact_value":null,"personal_note":null,"query_scope":null,"deposit_percent":null,"scope_document_type":null}\n' +
            '"bought glue for R850 at BUCO for Jenny\'s job" -> {"customer_name":"Jenny","character_name":"BUCO","character_relationship":"supplier","intent":"expense","amount":850,"fact_key":null,"fact_value":null,"personal_note":null,"query_scope":null,"deposit_percent":null,"scope_document_type":null}\n' +
            '"Sipho has a driver\'s license" -> {"customer_name":null,"character_name":"Sipho","character_relationship":"installer","intent":"note","amount":null,"fact_key":"license","fact_value":"driver\'s license","personal_note":null,"query_scope":null,"deposit_percent":null,"scope_document_type":null}\n' +
            '"picked up my wife from work, she\'s annoyed about the kitchen guy not showing" -> {"customer_name":null,"character_name":"wife","character_relationship":"wife","intent":"note","amount":null,"fact_key":null,"fact_value":null,"personal_note":null,"query_scope":null,"deposit_percent":null,"scope_document_type":null}\n' +
            '"how is my wife doing?" -> {"customer_name":null,"character_name":"wife","character_relationship":null,"intent":"lookup","amount":null,"fact_key":null,"fact_value":null,"personal_note":null,"query_scope":"character","deposit_percent":null,"scope_document_type":null}\n' +
            '"heading to jenny\'s job now, remind me to get dog food after" -> {"customer_name":"jenny","character_name":null,"character_relationship":null,"intent":"reminder","amount":null,"fact_key":null,"fact_value":null,"personal_note":"remind me to get dog food after","query_scope":null,"deposit_percent":null,"scope_document_type":null}\n' +
            '"got the dog food" -> {"customer_name":null,"character_name":null,"character_relationship":null,"intent":"task_complete","amount":null,"fact_key":null,"fact_value":null,"personal_note":"got the dog food","query_scope":null,"deposit_percent":null,"scope_document_type":null}\n' +
            '"called them" -> {"customer_name":null,"character_name":null,"character_relationship":null,"intent":"task_complete","amount":null,"fact_key":null,"fact_value":null,"personal_note":"called them","query_scope":null,"deposit_percent":null,"scope_document_type":null}\n' +
            '"we completed Jenny\'s installation, she paid an 80% deposit, convert the quote to an invoice for the remaining balance" -> {"customer_name":"Jenny","character_name":null,"character_relationship":null,"intent":"convert_quote","amount":null,"fact_key":null,"fact_value":null,"personal_note":null,"query_scope":null,"deposit_percent":80,"scope_document_type":null}\n' +
            '"Dwayne is a new customer, I measured the reception area at 6600 by 4100, we also need repair work" -> {"customer_name":"Dwayne","character_name":null,"character_relationship":null,"intent":"work_observation","amount":null,"fact_key":null,"fact_value":null,"personal_note":null,"query_scope":null,"deposit_percent":null,"scope_document_type":null}\n' +
            '"Sipho is measuring the hospital and theatre one is three by two" -> {"customer_name":null,"character_name":"Sipho","character_relationship":"installer","intent":"work_observation","amount":null,"fact_key":null,"fact_value":null,"personal_note":null,"query_scope":null,"deposit_percent":null,"scope_document_type":null}\n' +
            '"price up Dwayne\'s job, R450 a square meter for the reception area and office, flat R3500 for the repair work" -> {"customer_name":"Dwayne","character_name":null,"character_relationship":null,"intent":"price_scope","amount":null,"fact_key":null,"fact_value":null,"personal_note":null,"query_scope":null,"deposit_percent":null,"scope_document_type":"quotation"}\n' +
            '"invoice out Dwayne\'s job, R450 a square meter for the reception area and office, the job\'s already done" -> {"customer_name":"Dwayne","character_name":null,"character_relationship":null,"intent":"price_scope","amount":null,"fact_key":null,"fact_value":null,"personal_note":null,"query_scope":null,"deposit_percent":null,"scope_document_type":"invoice"}\n' +
            '"ProSupply was late delivering the tiles for Jenny\'s job back in March, held us up by four days" -> {"customer_name":null,"character_name":"ProSupply","character_relationship":"supplier","intent":"note","amount":null,"fact_key":null,"fact_value":null,"personal_note":null,"query_scope":null,"deposit_percent":null,"scope_document_type":null}\n' +
            '"called ProSupply about the March delay, spoke to Sarah in dispatch, she was really rude about it" -> {"customer_name":null,"character_name":"ProSupply","character_relationship":"supplier","intent":"note","amount":null,"fact_key":null,"fact_value":null,"personal_note":null,"query_scope":null,"deposit_percent":null,"scope_document_type":null}\n\n' +
            "Return ONLY JSON, no markdown, no explanation: " +
            '{"customer_name": string or null, "character_name": string or null, "character_relationship": ' +
            'string or null, "intent": "payment" or "invoice" or "quotation" or "convert_quote" or ' +
            '"price_scope" or "work_observation" or "lookup" or "reminder" or "task_complete" or "expense" or "note" or "other", "amount": number or null, ' +
            '"fact_key": string or null, "fact_value": string or null, "personal_note": string or null, ' +
            '"query_scope": "customer" or "character" or "personal" or "business" or null, "deposit_percent": ' +
            'number or null, "scope_document_type": "quotation" or "invoice" or null}',
        },
        { role: "user", content: transcript },
      ],
    }));
    const r = result as { choices?: Array<{ message?: { content?: string } }> };
    rawText = r.choices?.[0]?.message?.content ?? null;
    const cleaned = (rawText ?? "").replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(cleaned) as Extraction;
    return { extraction: parsed, raw: result, rawText };
  } catch (err) {
    return { extraction: null, raw: result ?? (err instanceof Error ? err.message : String(err)), rawText };
  }
}

// A quotation or invoice is often more than one flat number — real
// speech describes multiple distinct lines ("carpet for the main
// bedroom at R18,700, plus uplift and restretch at R15,120"). This is
// a separate, focused call rather than folded into the main
// classifier — same reasoning as resolveFollowUpEntity and
// answerFromMemory being their own steps: one job per call, easier to
// get right, easier to test in isolation. Never asks the model to
// calculate anything — only to extract the numbers actually stated;
// the actual line total is always computed deterministically
// afterward, in code.
export async function extractLineItems(env: Env, transcript: string): Promise<LineItemExtraction[]> {
  try {
    const result = await withRetry(() =>
      env.AI.run("@cf/moonshotai/kimi-k2.6", {
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
            "null if not stated), unit_price (the rand amount per unit, or the flat amount if " +
            "quantity is 1 and no per-unit rate was given), and discount_percent (a stated percentage " +
            "discount applying to this specific line item, e.g. \"give them 10% off the carpet\" — " +
            "extract exactly the number stated, or null if no discount was mentioned for this item). " +
            "Never calculate a total or a discounted amount yourself — only " +
            'extract numbers actually stated. Return ONLY JSON: {"line_items": [{"description": ' +
            'string, "note": string or null, "quantity": number, "unit": string or null, "unit_price": ' +
            'number, "discount_percent": number or null}]}\n\n' +
            "Example:\n" +
            '"carpet for the main bedroom at R18700, give them 10% off that, plus uplift and restretch for R15120" -> ' +
            '{"line_items": [' +
            '{"description":"Supply and install carpet, main bedroom","note":null,"quantity":1,"unit":null,"unit_price":18700,"discount_percent":10},' +
            '{"description":"Uplift carpet, uplift tile, rescreed and restretch carpet","note":null,"quantity":1,"unit":null,"unit_price":15120,"discount_percent":null}' +
            "]}",
        },
        { role: "user", content: transcript },
      ],
    }));
    const r2 = result as { choices?: Array<{ message?: { content?: string } }> };
    const rawText2 = r2.choices?.[0]?.message?.content ?? "";
    const cleaned2 = rawText2.replace(/```json|```/g, "").trim();
    const parsed2 = JSON.parse(cleaned2) as { line_items: LineItemExtraction[] };
    return parsed2.line_items ?? [];
  } catch {
    return [];
  }
}

// The job_scopes -> quotation link. Grounded in the real, already-
// measured components and tasks for this job — the model is given
// their exact names and told to match against them, never to invent
// new ones. It only ever identifies which named part a rate applies
// to and whether that rate is per-square-meter or a flat amount; the
// actual multiplication against a component's real area_sqm always
// happens afterward, in code, the same discipline as every other
// number in this system.
export async function extractScopePricing(
  env: Env,
  transcript: string,
  components: Array<{ name: string; area_sqm: number | null }>,
  tasks: Array<{ description: string }>
): Promise<ScopePricingItem[]> {
  try {
    const componentList = components.map((c) => `${c.name}${c.area_sqm != null ? ` (${c.area_sqm} sqm)` : ""}`).join(", ") || "none";
    const taskList = tasks.map((t) => t.description).join(", ") || "none";
    const result = await withRetry(() =>
      env.AI.run("@cf/moonshotai/kimi-k2.6", {
        temperature: 0,
        chat_template_kwargs: { thinking: false },
        messages: [
          {
            role: "system",
            content:
              "A tradesperson is stating prices to apply to a job that was already measured. You are " +
              "given the exact real components (named parts, some with a real measured area in square " +
              "meters) and tasks (described work with no measurement) that exist for this job. Match " +
              "what the tradesperson says to these exact given names — never invent a new component or " +
              "task name. For each priced item extract: matched_name (copied EXACTLY from the given " +
              "component or task list) or null if it genuinely doesn't match anything given, description " +
              "(a short label — the matched name if matched, otherwise describe what was priced), " +
              "pricing_type ('per_sqm' if a rate is given per square meter, meant to be multiplied by " +
              "that component's real area; 'flat' if a single flat amount was stated for that item), and " +
              "rate (the plain number stated — the per-sqm rate or the flat amount, exactly as said, " +
              "never a total you calculate yourself). Return ONLY JSON: " +
              '{"priced_items": [{"matched_name": string or null, "description": string, "pricing_type": ' +
              '"per_sqm" or "flat", "rate": number}]}\n\n' +
              "Example:\n" +
              'Components: "Reception area (27.06 sqm), Office (12.87 sqm)". Tasks: "repair work, screeding". ' +
              'Tradesperson said: "R450 a square meter for the reception and the office, flat R3500 for the repair work and screeding" -> ' +
              '{"priced_items": [' +
              '{"matched_name":"Reception area","description":"Reception area","pricing_type":"per_sqm","rate":450},' +
              '{"matched_name":"Office","description":"Office","pricing_type":"per_sqm","rate":450},' +
              '{"matched_name":null,"description":"Repair work and screeding","pricing_type":"flat","rate":3500}' +
              "]}",
          },
          {
            role: "user",
            content: `Components: ${componentList}. Tasks: ${taskList}.\n\nTradesperson said: "${transcript}"`,
          },
        ],
      })
    );
    const r = result as { choices?: Array<{ message?: { content?: string } }> };
    const rawText = r.choices?.[0]?.message?.content ?? "";
    const cleaned = rawText.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(cleaned) as { priced_items: ScopePricingItem[] };
    return parsed.priced_items ?? [];
  } catch {
    return [];
  }
}

// A generalization of "areas" — a named component of a job, which
// SOMETIMES has dimensions and sometimes doesn't ("reception area" vs
// "circuit 1" vs "repair work"). Deliberately not trade-specific.
// Never asked to calculate anything — area_sqm is always computed
// afterward, in code, from raw width/length, the same discipline as
// every rand figure. scheduled_date_raw is extracted exactly as
// spoken ("next Thursday") and deliberately left unresolved — turning
// that into a real calendar date is genuine future work, not
// something to fake here.
export async function extractWorkObservation(env: Env, transcript: string): Promise<WorkObservationExtraction> {
  const empty: WorkObservationExtraction = {
    job_description: transcript,
    components: [],
    tasks: [],
    scheduled_date_raw: null,
    installer_name: null,
  };
  try {
    const result = await withRetry(() =>
      env.AI.run("@cf/moonshotai/kimi-k2.6", {
        temperature: 0,
        chat_template_kwargs: { thinking: false },
        messages: [
          {
            role: "system",
            content:
              "Extract the structure of a tradesperson's job observation. job_description is a short " +
            "summary of the overall job (e.g. 'vinyl flooring installation'). components is every " +
            "distinct named part of the job that was measured or identified — a room, an area, a " +
            "circuit, a fixture — each with a name and, if stated, EITHER width, length, and unit, OR " +
            "a direct total area_sqm if the area was given as one whole number rather than a " +
            "width-by-length breakdown (e.g. \"around a hundred and sixty square meters of carpet " +
            "tile\" — no width or length was stated, only a total; extract area_sqm: 160, leave width " +
            "and length null). Never invent a width/length breakdown for a component that was only " +
            "ever given as a single total area, and never invent a total for one only given as " +
            "width-by-length — extract exactly the shape that was actually stated, in either direction. " +
            "unit is " +
            "'mm' or 'm' — recognize which was meant from context and magnitude, never guess randomly: " +
            "numbers like 6600 or 4100 with no stated unit are almost always millimeters (a laser " +
            "measure's native output); numbers like 8, 6, 7, or 5.5 with no stated unit, especially for " +
            "a room or building, are almost always meters. If dimensions were stated with an explicit " +
            "unit, use that. Only extract the number and unit exactly as implied — NEVER convert or " +
            "calculate anything yourself, that always happens afterward, in code — this applies equally " +
            "to a direct area_sqm figure, which must be copied exactly as stated, never computed from " +
            "anything else. Set width/length/area_sqm to " +
            "null for whichever of these genuinely wasn't given for that component; never invent " +
            "dimensions or a total. tasks is " +
            "every piece of described work that is NOT a measured component — repair work, screeding, " +
            "moisture testing, skirting removal — each with a description and, if the task was clearly " +
            "said about ONE specific named component (e.g. 'Theatre 2 needs moisture testing'), " +
            "component_name matching that component's name exactly; null if the task applies to the " +
            "whole job rather than one specific part. scheduled_date_raw is any date or timeframe " +
            "mentioned, extracted exactly as said (e.g. 'next Thursday') — never resolve it into an " +
            "actual date yourself, just extract the phrase, or null if none was mentioned. " +
            "installer_name is who is assigned to actually DO this job, if a real person was named for " +
            "that purpose (e.g. 'Sipho is doing Jenny's install' or 'assign this to Sipho') — this is " +
            "genuinely different from the customer (who the job is FOR); leave null if no installer was " +
            "named, never guess one. Return ONLY " +
            'JSON: {"job_description": string, "components": [{"name": string, "width": number or ' +
            'null, "length": number or null, "unit": "mm" or "m" or null, "area_sqm": number or null}], "tasks": [{"description": ' +
            'string, "component_name": string or null}], "scheduled_date_raw": string or null, ' +
            '"installer_name": string or null}\n\n' +
            "Examples:\n" +
            '"I measured the reception area at 6600 by 4100 and the office at 3300 by 3900, we also need repair work and screeding" -> ' +
            '{"job_description":"vinyl flooring installation","components":[{"name":"reception area","width":6600,"length":4100,"unit":"mm","area_sqm":null},{"name":"office","width":3300,"length":3900,"unit":"mm","area_sqm":null}],"tasks":[{"description":"repair work","component_name":null},{"description":"screeding","component_name":null}],"scheduled_date_raw":null,"installer_name":null}\n' +
            '"Theatre 2 is 8 by 6, Theatre 3 is 7 by 5.5, vinyl throughout. Theatre 2 needs moisture testing. Theatre 3 needs skirting removed first." -> ' +
            '{"job_description":"vinyl flooring installation","components":[{"name":"Theatre 2","width":8,"length":6,"unit":"m","area_sqm":null},{"name":"Theatre 3","width":7,"length":5.5,"unit":"m","area_sqm":null}],"tasks":[{"description":"moisture testing","component_name":"Theatre 2"},{"description":"skirting removed first","component_name":"Theatre 3"}],"scheduled_date_raw":null,"installer_name":null}\n' +
            '"Sipho is doing Jenny\'s carpet install next Thursday" -> ' +
            '{"job_description":"carpet installation","components":[],"tasks":[],"scheduled_date_raw":"next Thursday","installer_name":"Sipho"}\n' +
            '"We are looking at around a hundred and sixty square meters of carpet tile downstairs, and fifty six square meters of stretch carpet upstairs" -> ' +
            '{"job_description":"carpet installation","components":[{"name":"downstairs","width":null,"length":null,"unit":null,"area_sqm":160},{"name":"upstairs","width":null,"length":null,"unit":null,"area_sqm":56}],"tasks":[],"scheduled_date_raw":null,"installer_name":null}',
        },
        { role: "user", content: transcript },
      ],
    }));
    const r = result as { choices?: Array<{ message?: { content?: string } }> };
    const rawText = r.choices?.[0]?.message?.content ?? "";
    const cleaned = rawText.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(cleaned) as WorkObservationExtraction;
    return {
      job_description: parsed.job_description || transcript,
      components: parsed.components ?? [],
      tasks: parsed.tasks ?? [],
      scheduled_date_raw: parsed.scheduled_date_raw ?? null,
      installer_name: parsed.installer_name ?? null,
    };
  } catch {
    return empty;
  }
}

// Real evidence 2026-07-10: the previous approach — asking the model
// to REWRITE a follow-up into a fluent, self-contained sentence —
// looped repeatedly under thinking:true, no matter how the prompt was
// tuned, because open-ended prose generation has no natural stopping
// point. This replaces it entirely: the model's only job is to name
// which EXISTING entity a vague follow-up refers to — a closed,
// structured extraction, the exact same shape as extractIntent's
// customer_name/character_name fields, which have never once looped
// across this whole build. Code does everything else: the real
// lookup, the real facts, the real answer — the original question
// text goes straight to answerFromMemory unmodified, no rewritten
// sentence ever generated.
export async function resolveFollowUpEntity(env: Env, history: HistoryTurn[], message: string): Promise<string | null> {
  if (history.length === 0) return null;
  try {
    const historyText = history.map((h) => `${h.role === "user" ? "Peter" : "Office"}: ${h.text}`).join("\n");
    const result = await withRetry(() =>
      env.AI.run("@cf/moonshotai/kimi-k2.6", {
        chat_template_kwargs: { thinking: false },
        temperature: 0,
        messages: [
          {
            role: "system",
            content:
              "The new message may refer back to the STANDING TOPIC of the conversation below, without " +
              'naming it again ("who did we deal with", "what\'s her balance", "tell me more"). The ' +
              "standing topic is normally who or what Peter's own most recent question was about — not " +
              "just any name that happens to appear in the Office's reply (a reply often mentions other " +
              "people or jobs as supporting detail, not as a new topic). If the new message clearly asks " +
              "about one of those other names specifically, use that instead. Return the exact name of " +
              "the standing topic as it appears below, or null if the new message already names someone " +
              'itself or there is no standing topic to refer back to. Return ONLY JSON: {"name": string ' +
              'or null}\n\n' +
              "Conversation:\n" +
              historyText,
          },
          { role: "user", content: message },
        ],
      })
    );
    const r = result as { choices?: Array<{ message?: { content?: string } }> };
    const rawText = r.choices?.[0]?.message?.content ?? "";
    const cleaned = rawText.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(cleaned) as { name: string | null };
    return parsed.name ?? null;
  } catch {
    return null;
  }
}

// The business-scope sibling of resolveFollowUpEntity, same reasoning
// applied to a topic instead of a named entity. Real bug found live
// 2026-07-10: "how many quotations are pending" -> "names and
// amounts" pulled in unrelated outstanding-invoice facts too, because
// business-scope lookups always fetched both fact sets regardless of
// which one the conversation was actually about. thinking:false,
// closed-form, same proven shape as everything else in this file that
// has never looped.
export async function classifyBusinessTopic(
  env: Env,
  history: HistoryTurn[],
  message: string
): Promise<"quotations" | "invoices" | "expenses" | "general"> {
  if (history.length === 0) return "general";
  try {
    const historyText = history.map((h) => `${h.role === "user" ? "Peter" : "Office"}: ${h.text}`).join("\n");
    const result = await withRetry(() =>
      env.AI.run("@cf/moonshotai/kimi-k2.6", {
        chat_template_kwargs: { thinking: false },
        temperature: 0,
        max_tokens: 10,
        messages: [
          {
            role: "system",
            content:
              "Is the new message specifically about QUOTATIONS, specifically about INVOICES/money owed, " +
              "specifically about EXPENSES/money spent on suppliers, or a GENERAL business question — " +
              "based on the standing topic of the conversation below (what Peter's own most recent " +
              'question was actually about, not just any word that appears). Answer with exactly one ' +
              'word: "QUOTATIONS", "INVOICES", "EXPENSES", or "GENERAL".\n\n' +
              "Conversation:\n" +
              historyText,
          },
          { role: "user", content: message },
        ],
      })
    );
    const r = result as { choices?: Array<{ message?: { content?: string } }> };
    const answer = r.choices?.[0]?.message?.content?.trim().toUpperCase() ?? "";
    if (answer.includes("QUOTATION")) return "quotations";
    if (answer.includes("EXPENSE")) return "expenses";
    if (answer.includes("INVOICE")) return "invoices";
    return "general";
  } catch {
    return "general";
  }
}

// Real feature 2026-07-12 — the real prerequisite for eventually
// distinguishing cost of sales from operating expenses in a formal
// P&L. Same shape as classifyBusinessTopic above, deliberately: a
// small, closed set, low stakes if imperfect (easily corrected later,
// nothing destructive happens from a wrong category), which is
// exactly the class of judgment call Principle 2 treats as legitimate
// narration/understanding rather than a business decision that needs
// deterministic code. Never used for the expense amount or supplier
// itself — those stay exactly as extracted, unguessed.
export async function classifyExpenseCategory(
  env: Env,
  description: string
): Promise<"materials" | "fuel" | "tools" | "subcontractor" | "other"> {
  try {
    const result = await withRetry(() =>
      env.AI.run("@cf/moonshotai/kimi-k2.6", {
        chat_template_kwargs: { thinking: false },
        temperature: 0,
        max_tokens: 10,
        messages: [
          {
            role: "system",
            content:
              "Categorize this business expense into exactly one of: MATERIALS (stock, supplies, product " +
              "used on a job — tiles, vinyl, glue, carpet), FUEL (fuel, diesel, petrol, vehicle running " +
              "costs), TOOLS (tools, equipment, machinery), SUBCONTRACTOR (paying another person or " +
              "business for labor on a job), or OTHER (anything that doesn't clearly fit the above — " +
              "rent, insurance, admin, wages). Answer with exactly one word.",
          },
          { role: "user", content: description },
        ],
      })
    );
    const r = result as { choices?: Array<{ message?: { content?: string } }> };
    const answer = r.choices?.[0]?.message?.content?.trim().toUpperCase() ?? "";
    if (answer.includes("MATERIAL")) return "materials";
    if (answer.includes("FUEL")) return "fuel";
    if (answer.includes("TOOL")) return "tools";
    if (answer.includes("SUBCONTRACTOR")) return "subcontractor";
    return "other";
  } catch {
    return "other";
  }
}

// --- Memory: color, not ground truth. Never used for money or ------
// anything with real-world consequence — only for recalling what was
// said (a preference, a note) when nothing structured exists to
// answer from instead.

export async function embedText(env: Env, text: string): Promise<number[]> {
  const result = await withRetry(() => env.AI.run("@cf/baai/bge-base-en-v1.5", { text }));
  return (result as { data: number[][] }).data[0];
}

// Fallback only, for the rare case a note has no identifiable
// customer to scope it to — writes straight to Vectorize since there
// is no KV key to append it under. Kept deliberately separate from
// the batched consolidation path below; this one write is genuinely
// one-off, not part of a queue.
export async function storeUnscopedMemory(env: Env, text: string): Promise<void> {
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
export async function rerank(env: Env, query: string, candidates: string[]): Promise<string[]> {
  if (candidates.length === 0) return [];
  try {
    const result = await withRetry(() =>
      env.AI.run("@cf/baai/bge-reranker-base", {
        query,
        contexts: candidates.map((text) => ({ text })),
      })
    );
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
export async function searchMemory(env: Env, query: string, customerId: number | null): Promise<string[]> {
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
export async function answerFromMemory(env: Env, question: string, facts: string[]): Promise<string> {
  if (facts.length === 0) {
    return "I don't have anything on file for that yet.";
  }
  try {
    const result = await withRetry(() =>
      env.AI.run("@cf/moonshotai/kimi-k2.6", {
        temperature: 0,
        chat_template_kwargs: { thinking: false },
        messages: [
          {
            role: "system",
            content:
              // Real bug found live 2026-07-11: as the fact list grew
              // long (real life events accumulating from a full day of
              // testing), the model started echoing facts back nearly
              // verbatim in order rather than reasoning about which
              // ones actually answer the question, and cut off before
              // reaching facts appended later in the list. The earlier
              // fix (cover every relevant fact) was correct but
              // ambiguous about "relevant" — tightened to make
              // filtering an explicit, separate step from coverage.
              "Answer the tradesperson's question using only the facts below. First decide which facts " +
              "actually answer THIS question — ignore any that are unrelated context, even if they're in " +
              "the list. Then cover every one of those relevant facts — never silently drop one just to " +
              "stay brief. If only one fact is relevant, answer in one plain sentence. If several are " +
              "relevant, list them briefly, each in a short phrase. Do not simply repeat the facts back " +
              "in the order given — decide relevance first. Always include any specific numbers, amounts, " +
              "or figures from the facts you do use — never summarize a number away into a vague " +
              "statement. Real correction 2026-07-12: a question phrased generally about a person (\"how's " +
              "Sipho doing?\") is genuinely ambiguous — it could mean their wellbeing or their current work " +
              "status, and there's no reliable way to know which was meant from wording alone. Don't try to " +
              "guess which one it is. Instead: if the facts include real, current activity about that " +
              "person (a job they're assigned to, a schedule, a status), share it plainly — real, known " +
              "information about someone is worth sharing regardless of the exact literal question, and the " +
              "person asking can always say if that wasn't what they meant. Withholding real facts on a " +
              "technicality of wording is worse than sharing something slightly off-target. If none of the " +
              "facts say anything real about what's being asked, say you don't have that on file.\n\n" +
              `Facts:\n${facts.map((f) => `- ${f}`).join("\n")}`,
          },
          { role: "user", content: question },
      ],
    }));
    const r = result as { choices?: Array<{ message?: { content?: string } }> };
    const answer = r.choices?.[0]?.message?.content;
    return typeof answer === "string" && answer.trim() ? answer.trim() : facts[0];
  } catch {
    return facts[0];
  }
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 8192; // avoid call-stack limits on large images
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

// Reuses Kimi K2.6 — the same model already proven for extraction,
// rewriting, and synthesis — rather than reaching for a separate
// vision model before there's evidence this one isn't enough. Asked
// to be literal, not creative: this is a raw record of what a
// tradesperson photographed, not a caption for a gallery.
export async function describeImage(env: Env, base64: string, mimeType: string): Promise<string> {
  try {
    const result = await withRetry(() =>
      env.AI.run("@cf/moonshotai/kimi-k2.6", {
        temperature: 0,
        chat_template_kwargs: { thinking: false },
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text:
                  "Describe exactly what is shown in this photo, including any visible text, numbers, or " +
                  "measurements — read them precisely if legible. Be literal and specific, not creative: " +
                  "this is a raw record of what a tradesperson photographed on a job.",
              },
              { type: "image_url", image_url: { url: `data:${mimeType};base64,${base64}` } },
            ],
          },
      ],
    }));
    const r = result as { choices?: Array<{ message?: { content?: string } }> };
    return r.choices?.[0]?.message?.content?.trim() || "[could not describe image]";
  } catch (err) {
    return `[image description failed: ${err instanceof Error ? err.message : String(err)}]`;
  }
}
