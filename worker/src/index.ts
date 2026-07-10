import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { parsePhoneNumberFromString } from "libphonenumber-js";

export interface Env {
  OFFICE_DB: D1Database;
  OFFICE_VAULT: R2Bucket;
  AI: Ai;
  MEMORY: VectorizeIndex;
  CUSTOMER_NOTES: KVNamespace;
}

interface Extraction {
  customer_name: string | null;
  character_name: string | null;
  character_relationship: string | null;
  intent: "payment" | "invoice" | "quotation" | "convert_quote" | "price_scope" | "work_observation" | "lookup" | "reminder" | "note" | "other";
  amount: number | null;
  fact_key: string | null;
  fact_value: string | null;
  personal_note: string | null;
  query_scope: "customer" | "personal" | "business" | "character" | null;
  deposit_percent: number | null;
  scope_document_type: "quotation" | "invoice" | null;
}

interface ProcessResult {
  extraction: Extraction | null;
  extractionRaw: unknown;
  extractionRawText: string | null;
  customer: { id: number; name: string; matched: boolean } | null;
  pendingActionId: number | null;
  factPendingActionId: number | null;
  message: string;
  rewrittenQuery: string;
}

// Real evidence today: multiple genuine, transient AI-call failures,
// every single one succeeding cleanly on a plain retry seconds later.
// Wrapping every real model call in a couple of quick, automatic
// retries means Peter should rarely if ever see one of these at all
// — the existing per-function fallback behavior (empty results, a
// logged error) is still there as a backstop if every attempt
// genuinely fails, this just makes reaching that backstop far less
// likely.
async function withRetry<T>(fn: () => Promise<T>, maxAttempts: number = 3, baseDelayMs: number = 300): Promise<T> {
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

async function transcribe(env: Env, audioBuffer: ArrayBuffer): Promise<{ transcript: string | null; transcriptionError: string | null }> {
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
async function extractIntent(env: Env, transcript: string): Promise<{ extraction: Extraction | null; raw: unknown; rawText: string | null }> {
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
            "accidentally quoted or invoiced that a personal relation gets applies here too. " +
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
            'intent is "work_observation" if the message describes measuring, scoping, or inspecting a job ' +
            '— components, measurements, or tasks — with NO price stated at all. This is earlier than a ' +
            'quotation: the tradesperson is recording what they observed, not proposing a cost. If any ' +
            'rand amount is mentioned, it is NOT work_observation — use quotation, invoice, price_scope, ' +
            "or payment instead. " +
            "amount is a plain number in the currency's major unit (e.g. rand, not cents) if a specific " +
            "amount was stated, exactly as given — never estimate or calculate, only use a number " +
            "that was actually stated, or null if none was. " +
            "fact_key and fact_value: if the message states a clear, structured attribute about the " +
            "customer, extract it as a short snake_case key and its value. For a phone number, email, " +
            "or address specifically, ALWAYS use exactly these keys — \"phone_number\", \"email\", or " +
            '"address" — never a variant like "cell", "mobile", or "contact_number", so the same kind ' +
            "of fact is always named the same way. For anything else genuinely specific to this trade " +
            "or job (e.g. a circuit rating, a paint colour, a fabric type), invent a short, clear " +
            'snake_case key as before — e.g. fact_key: "address", fact_value: "12 Golf Way, Eco Estate, ' +
            'Eshowe". Extract the value exactly as stated — never reformat, normalize, or convert it ' +
            "yourself, that always happens afterward, in code. If the message is a general note that " +
            "does not cleanly reduce to one key and value, set both to null. " +
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
            '"picked up my wife from work, she\'s annoyed about the kitchen guy not showing" -> {"customer_name":null,"character_name":"wife","character_relationship":"wife","intent":"note","amount":null,"fact_key":null,"fact_value":null,"personal_note":null,"query_scope":null,"deposit_percent":null,"scope_document_type":null}\n' +
            '"how is my wife doing?" -> {"customer_name":null,"character_name":"wife","character_relationship":null,"intent":"lookup","amount":null,"fact_key":null,"fact_value":null,"personal_note":null,"query_scope":"character","deposit_percent":null,"scope_document_type":null}\n' +
            '"heading to jenny\'s job now, remind me to get dog food after" -> {"customer_name":"jenny","character_name":null,"character_relationship":null,"intent":"reminder","amount":null,"fact_key":null,"fact_value":null,"personal_note":"remind me to get dog food after","query_scope":null,"deposit_percent":null,"scope_document_type":null}\n' +
            '"we completed Jenny\'s installation, she paid an 80% deposit, convert the quote to an invoice for the remaining balance" -> {"customer_name":"Jenny","character_name":null,"character_relationship":null,"intent":"convert_quote","amount":null,"fact_key":null,"fact_value":null,"personal_note":null,"query_scope":null,"deposit_percent":80,"scope_document_type":null}\n' +
            '"Dwayne is a new customer, I measured the reception area at 6600 by 4100, we also need repair work" -> {"customer_name":"Dwayne","character_name":null,"character_relationship":null,"intent":"work_observation","amount":null,"fact_key":null,"fact_value":null,"personal_note":null,"query_scope":null,"deposit_percent":null,"scope_document_type":null}\n' +
            '"price up Dwayne\'s job, R450 a square meter for the reception area and office, flat R3500 for the repair work" -> {"customer_name":"Dwayne","character_name":null,"character_relationship":null,"intent":"price_scope","amount":null,"fact_key":null,"fact_value":null,"personal_note":null,"query_scope":null,"deposit_percent":null,"scope_document_type":"quotation"}\n' +
            '"invoice out Dwayne\'s job, R450 a square meter for the reception area and office, the job\'s already done" -> {"customer_name":"Dwayne","character_name":null,"character_relationship":null,"intent":"price_scope","amount":null,"fact_key":null,"fact_value":null,"personal_note":null,"query_scope":null,"deposit_percent":null,"scope_document_type":"invoice"}\n' +
            '"ProSupply was late delivering the tiles for Jenny\'s job back in March, held us up by four days" -> {"customer_name":null,"character_name":"ProSupply","character_relationship":"supplier","intent":"note","amount":null,"fact_key":null,"fact_value":null,"personal_note":null,"query_scope":null,"deposit_percent":null,"scope_document_type":null}\n' +
            '"called ProSupply about the March delay, spoke to Sarah in dispatch, she was really rude about it" -> {"customer_name":null,"character_name":"ProSupply","character_relationship":"supplier","intent":"note","amount":null,"fact_key":null,"fact_value":null,"personal_note":null,"query_scope":null,"deposit_percent":null,"scope_document_type":null}\n\n' +
            "Return ONLY JSON, no markdown, no explanation: " +
            '{"customer_name": string or null, "character_name": string or null, "character_relationship": ' +
            'string or null, "intent": "payment" or "invoice" or "quotation" or "convert_quote" or ' +
            '"price_scope" or "work_observation" or "lookup" or "reminder" or "note" or "other", "amount": number or null, ' +
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

interface ScopePricingItem {
  matched_name: string | null; // must match a given component/task name exactly, or null if it doesn't
  description: string;
  pricing_type: "per_sqm" | "flat";
  rate: number;
}

// The job_scopes -> quotation link. Grounded in the real, already-
// measured components and tasks for this job — the model is given
// their exact names and told to match against them, never to invent
// new ones. It only ever identifies which named part a rate applies
// to and whether that rate is per-square-meter or a flat amount; the
// actual multiplication against a component's real area_sqm always
// happens afterward, in code, the same discipline as every other
// number in this system.
async function extractScopePricing(
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

interface WorkComponent {
  name: string;
  width: number | null;
  length: number | null;
  unit: "mm" | "m" | null; // the model's job: recognize the unit; conversion always happens in code
}

interface WorkTask {
  description: string;
  component_name: string | null; // e.g. "Theatre 2" — null if it applies to the whole job, not one part
}

interface WorkObservationExtraction {
  job_description: string;
  components: WorkComponent[];
  tasks: WorkTask[];
  scheduled_date_raw: string | null;
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
async function extractWorkObservation(env: Env, transcript: string): Promise<WorkObservationExtraction> {
  const empty: WorkObservationExtraction = {
    job_description: transcript,
    components: [],
    tasks: [],
    scheduled_date_raw: null,
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
            "circuit, a fixture — each with a name and, if stated, width, length, and unit. unit is " +
            "'mm' or 'm' — recognize which was meant from context and magnitude, never guess randomly: " +
            "numbers like 6600 or 4100 with no stated unit are almost always millimeters (a laser " +
            "measure's native output); numbers like 8, 6, 7, or 5.5 with no stated unit, especially for " +
            "a room or building, are almost always meters. If dimensions were stated with an explicit " +
            "unit, use that. Only extract the number and unit exactly as implied — NEVER convert or " +
            "calculate anything yourself, that always happens afterward, in code. Set width/length to " +
            "null if no dimensions were given for that component; never invent dimensions. tasks is " +
            "every piece of described work that is NOT a measured component — repair work, screeding, " +
            "moisture testing, skirting removal — each with a description and, if the task was clearly " +
            "said about ONE specific named component (e.g. 'Theatre 2 needs moisture testing'), " +
            "component_name matching that component's name exactly; null if the task applies to the " +
            "whole job rather than one specific part. scheduled_date_raw is any date or timeframe " +
            "mentioned, extracted exactly as said (e.g. 'next Thursday') — never resolve it into an " +
            "actual date yourself, just extract the phrase, or null if none was mentioned. Return ONLY " +
            'JSON: {"job_description": string, "components": [{"name": string, "width": number or ' +
            'null, "length": number or null, "unit": "mm" or "m" or null}], "tasks": [{"description": ' +
            'string, "component_name": string or null}], "scheduled_date_raw": string or null}\n\n' +
            "Examples:\n" +
            '"I measured the reception area at 6600 by 4100 and the office at 3300 by 3900, we also need repair work and screeding" -> ' +
            '{"job_description":"vinyl flooring installation","components":[{"name":"reception area","width":6600,"length":4100,"unit":"mm"},{"name":"office","width":3300,"length":3900,"unit":"mm"}],"tasks":[{"description":"repair work","component_name":null},{"description":"screeding","component_name":null}],"scheduled_date_raw":null}\n' +
            '"Theatre 2 is 8 by 6, Theatre 3 is 7 by 5.5, vinyl throughout. Theatre 2 needs moisture testing. Theatre 3 needs skirting removed first." -> ' +
            '{"job_description":"vinyl flooring installation","components":[{"name":"Theatre 2","width":8,"length":6,"unit":"m"},{"name":"Theatre 3","width":7,"length":5.5,"unit":"m"}],"tasks":[{"description":"moisture testing","component_name":"Theatre 2"},{"description":"skirting removed first","component_name":"Theatre 3"}],"scheduled_date_raw":null}',
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
    };
  } catch {
    return empty;
  }
}

// Unguarded, deliberately — same reasoning already applied to
// characters and life events. Nothing here touches money or the
// outside world; a wrong measurement is a cheap, easily corrected
// mistake, not the category of consequence guard() exists for. Area
// is always computed here, in code, from raw dimensions — never asked
// of the model.
async function recordWorkObservation(
  env: Env,
  customerId: number,
  observation: WorkObservationExtraction,
  sourceTranscript: string
): Promise<{ jobScopeId: number }> {
  const inserted = await env.OFFICE_DB.prepare(
    "INSERT INTO job_scopes (customer_id, description, scheduled_date_raw, source_transcript) VALUES (?, ?, ?, ?) RETURNING id"
  )
    .bind(customerId, observation.job_description, observation.scheduled_date_raw, sourceTranscript)
    .first<{ id: number }>();

  const jobScopeId = inserted!.id;

  // Maps a component's name back to its real D1 id, so a task naming
  // "Theatre 2" can be linked to the actual row just inserted for it.
  const componentIdByName = new Map<string, number>();

  for (const component of observation.components) {
    // Unit conversion — the one piece of arithmetic in this whole
    // step — always happens here, in code. The model's only job was
    // recognizing which unit was meant; multiplying by 1000 is never
    // something it does itself.
    const widthMm = component.width != null ? (component.unit === "m" ? component.width * 1000 : component.width) : null;
    const lengthMm =
      component.length != null ? (component.unit === "m" ? component.length * 1000 : component.length) : null;
    const areaSqm = widthMm != null && lengthMm != null ? (widthMm * lengthMm) / 1_000_000 : null;

    const insertedComponent = await env.OFFICE_DB.prepare(
      "INSERT INTO scope_components (job_scope_id, name, width_mm, length_mm, area_sqm) VALUES (?, ?, ?, ?, ?) RETURNING id"
    )
      .bind(jobScopeId, component.name, widthMm, lengthMm, areaSqm)
      .first<{ id: number }>();

    componentIdByName.set(component.name.toLowerCase(), insertedComponent!.id);
  }

  for (const task of observation.tasks) {
    const componentId = task.component_name ? componentIdByName.get(task.component_name.toLowerCase()) ?? null : null;
    await env.OFFICE_DB.prepare(
      "INSERT INTO scope_tasks (job_scope_id, description, component_id) VALUES (?, ?, ?)"
    )
      .bind(jobScopeId, task.description, componentId)
      .run();
  }

  return { jobScopeId };
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

  const tokens = spokenName.trim().split(/\s+/);

  // If a full name (first + last) was given, the match must account
  // for BOTH parts — matching on the first name alone silently
  // conflates any two people who happen to share it. Confirmed real:
  // "John Wilkins" matched an unrelated existing "John Titlestadt" on
  // first-token-only matching. Only fall back to a looser, first-name
  // -only match when genuinely just one name was given — the best
  // that can honestly be done with that little information.
  if (tokens.length >= 2) {
    const firstName = tokens[0];
    const lastName = tokens[tokens.length - 1];
    const existingFull = await env.OFFICE_DB.prepare(
      "SELECT id, name FROM customers WHERE name LIKE ? AND name LIKE ? LIMIT 1"
    )
      .bind(`%${firstName}%`, `%${lastName}%`)
      .first<{ id: number; name: string }>();

    if (existingFull) {
      return { id: existingFull.id, name: existingFull.name, matched: true };
    }

    const insertedFull = await env.OFFICE_DB.prepare("INSERT INTO customers (name) VALUES (?) RETURNING id, name")
      .bind(spokenName)
      .first<{ id: number; name: string }>();

    return { id: insertedFull!.id, name: insertedFull!.name, matched: false };
  }

  const firstToken = tokens[0];
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

// A character is a personal relation — wife, nanny, family — never a
// business customer. Same reconciliation discipline as customers
// (full-name matching, pronoun rejection), against a genuinely
// separate table that guard(), invoices, and "who owes me money" can
// never see. Relationship is only ever stored once, at creation —
// there is no guarded update path here, since nothing here carries
// financial consequence the way a customer's address does.
async function reconcileCharacter(
  env: Env,
  spokenName: string,
  relationship: string | null
): Promise<{ id: number; name: string; matched: boolean } | null> {
  if (!looksLikeAName(spokenName)) {
    return null;
  }

  const tokens = spokenName.trim().split(/\s+/);

  if (tokens.length >= 2) {
    const firstName = tokens[0];
    const lastName = tokens[tokens.length - 1];
    const existingFull = await env.OFFICE_DB.prepare(
      "SELECT id, name FROM characters WHERE name LIKE ? AND name LIKE ? LIMIT 1"
    )
      .bind(`%${firstName}%`, `%${lastName}%`)
      .first<{ id: number; name: string }>();

    if (existingFull) {
      return { id: existingFull.id, name: existingFull.name, matched: true };
    }

    const insertedFull = await env.OFFICE_DB.prepare(
      "INSERT INTO characters (name, relationship) VALUES (?, ?) RETURNING id, name"
    )
      .bind(spokenName, relationship)
      .first<{ id: number; name: string }>();

    return { id: insertedFull!.id, name: insertedFull!.name, matched: false };
  }

  const existing = await env.OFFICE_DB.prepare("SELECT id, name FROM characters WHERE name LIKE ? LIMIT 1")
    .bind(`%${tokens[0]}%`)
    .first<{ id: number; name: string }>();

  if (existing) {
    return { id: existing.id, name: existing.name, matched: true };
  }

  const inserted = await env.OFFICE_DB.prepare(
    "INSERT INTO characters (name, relationship) VALUES (?, ?) RETURNING id, name"
  )
    .bind(spokenName, relationship)
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
// mistake as a wrong payment would be. lineItems is optional and new
// — line_items already supported invoice_id via its CHECK constraint
// (exactly one of quotation_id/invoice_id, never both), it just had
// no real writer until price_scope needed to produce invoices as
// naturally as quotations, not just flat single-amount ones.
async function recordInvoice(
  env: Env,
  customerId: number,
  description: string,
  amount: number,
  sourceTranscript: string,
  lineItems: LineItemWithTotal[] = []
): Promise<{ id: number; customerId: number; amount: number }> {
  const inserted = await env.OFFICE_DB.prepare(
    "INSERT INTO invoices (customer_id, description, amount, source_transcript) VALUES (?, ?, ?, ?) RETURNING id"
  )
    .bind(customerId, description, amount, sourceTranscript)
    .first<{ id: number }>();

  const invoiceId = inserted!.id;

  for (const item of lineItems) {
    await env.OFFICE_DB.prepare(
      "INSERT INTO line_items (invoice_id, description, note, quantity, unit, unit_price, line_total) VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
      .bind(invoiceId, item.description, item.note, item.quantity, item.unit, item.unit_price, item.line_total)
      .run();
  }

  return { id: invoiceId, customerId, amount };
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

// The read side of the job_scopes -> quotation link. No status column
// on job_scopes yet and no reference-number system — same honest
// simplification as findLatestOpenQuotation above: "their most recent
// recorded job scope" is sufficient while one customer generally has
// at most one open, unpriced job at a time. Returns the real
// components and tasks so extractScopePricing has real names to match
// spoken rates against, never invented ones.
async function findLatestJobScope(
  env: Env,
  customerId: number
): Promise<{
  id: number;
  description: string;
  components: Array<{ id: number; name: string; area_sqm: number | null }>;
  tasks: Array<{ id: number; description: string }>;
} | null> {
  const scope = await env.OFFICE_DB.prepare(
    "SELECT id, description FROM job_scopes WHERE customer_id = ? ORDER BY created_at DESC LIMIT 1"
  )
    .bind(customerId)
    .first<{ id: number; description: string }>();
  if (!scope) return null;

  const { results: components } = await env.OFFICE_DB.prepare(
    "SELECT id, name, area_sqm FROM scope_components WHERE job_scope_id = ?"
  )
    .bind(scope.id)
    .all<{ id: number; name: string; area_sqm: number | null }>();

  const { results: tasks } = await env.OFFICE_DB.prepare(
    "SELECT id, description FROM scope_tasks WHERE job_scope_id = ?"
  )
    .bind(scope.id)
    .all<{ id: number; description: string }>();

  return { id: scope.id, description: scope.description, components: components ?? [], tasks: tasks ?? [] };
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

// The real fix for "what's Sarah's balance" answering wrong — a
// single customer's balance was only ever being searched for in
// narrative notes, never computed from the actual invoices/payments
// tables the way the business-wide "who owes me money" query already
// does. Honest about the case where payments exist with no invoice
// (Sarah paid R500 with nothing invoiced against her) rather than
// fabricating a balance-owed figure that doesn't cleanly apply.
async function getCustomerFinancialSummary(env: Env, customerId: number): Promise<string | null> {
  const row = await env.OFFICE_DB.prepare(
    `SELECT
       COALESCE((SELECT SUM(amount) FROM invoices WHERE customer_id = ?), 0) as invoiced,
       COALESCE((SELECT SUM(amount) FROM payments WHERE customer_id = ?), 0) as paid`
  )
    .bind(customerId, customerId)
    .first<{ invoiced: number; paid: number }>();

  if (!row || (row.invoiced === 0 && row.paid === 0)) return null;

  const balance = row.invoiced - row.paid;
  if (row.invoiced === 0) {
    return `No invoices on file, but R${row.paid} in payments recorded — nothing currently invoiced to balance against.`;
  }
  if (balance > 0) return `Owes R${balance} (invoiced R${row.invoiced}, paid R${row.paid}).`;
  if (balance < 0) return `Has paid R${-balance} more than invoiced (invoiced R${row.invoiced}, paid R${row.paid}).`;
  return `Fully paid up (invoiced R${row.invoiced}, paid R${row.paid}).`;
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

    // Real normalization, always in code — never left to the model's
    // own formatting. Defaults to South Africa since that's the
    // business's actual market; a number already carrying a country
    // code (e.g. "+44...") is respected as given.
    let normalizedValue = value;
    if (normalizedKey === "phone_number") {
      const parsed = parsePhoneNumberFromString(value, "ZA");
      if (parsed?.isValid()) {
        normalizedValue = parsed.formatInternational();
      }
    } else if (normalizedKey === "email") {
      normalizedValue = value.trim().toLowerCase();
    }

    await env.OFFICE_DB.prepare(
      "INSERT INTO customer_facts (customer_id, key, value, source_transcript) VALUES (?, ?, ?, ?)"
    )
      .bind(customerId, normalizedKey, normalizedValue, sourceTranscript)
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
  const result = await withRetry(() => env.AI.run("@cf/baai/bge-base-en-v1.5", { text }));
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

// Same instant KV pattern as customer notes, distinct key prefix.
// Deliberately no staging-queue entry for Vectorize consolidation —
// that machinery exists to support cross-customer business search,
// which characters should never appear in.
async function getCharacterNotes(env: Env, characterId: number): Promise<string[]> {
  try {
    const raw = await env.CUSTOMER_NOTES.get(`character:${characterId}`);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { facts: CustomerNote[] };
    return parsed.facts.map((f) => f.text);
  } catch {
    return [];
  }
}

async function appendCharacterNote(env: Env, characterId: number, text: string): Promise<void> {
  try {
    const key = `character:${characterId}`;
    const raw = await env.CUSTOMER_NOTES.get(key);
    const existing: { facts: CustomerNote[] } = raw ? JSON.parse(raw) : { facts: [] };
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
    const result = await withRetry(() =>
      env.AI.run("@cf/moonshotai/kimi-k2.6", {
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
    }));
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
    // thinking enabled here specifically — proven necessary by a real
    // side-by-side test: resolving a pronoun among MULTIPLE plausible
    // candidates against an explicit tie-break rule (recency over
    // frequency) genuinely requires reasoning, unlike simple
    // classification where thinking:false was proven sufficient.
    const result = await withRetry(() =>
      env.AI.run("@cf/moonshotai/kimi-k2.6", {
        chat_template_kwargs: { thinking: true },
        temperature: 0,
        max_tokens: 600,
        messages: [
          {
            role: "system",
            content:
            "Rewrite the new message to be fully self-contained, replacing any pronouns or vague " +
            "references (her, him, that, it, the invoice, etc.) with the specific name or thing they " +
            "refer to, using the conversation history for context. When more than one person or thing " +
            "could match, ALWAYS resolve to whichever was mentioned MOST RECENTLY in the history, never " +
            "whichever was mentioned most often — recency wins over frequency, always. " +
            "References aren't always to a single name — a phrase can also point at a WHOLE SET of facts " +
            "or events the office just described (\"those instances\", \"that situation\", \"all of " +
            "that\", \"what happened there\"). Resolve these the same way: replace the vague phrase with a " +
            "concrete, specific description of what was actually just discussed, grounded in exactly what " +
            "the history says — name the real entity involved and briefly what the facts actually were. " +
            "Never invent a fact that wasn't in the history; only make an existing vague reference " +
            "concrete. If a drill-down question stays vague because the model can't find anything in the " +
            "history to ground it in, leave it as close to the original as possible rather than guessing " +
            "at an entity that was never mentioned. " +
            "Do NOT answer the message, add new information, or change its type — a question must stay " +
            "phrased as a question, a statement stays a statement. Only resolve what the ambiguous words " +
            "refer to. If the message is already self-contained, return it completely unchanged. Return " +
            "ONLY the rewritten message, nothing else — no explanation, no quotes.\n\n" +
            "Example:\nPeter: why don't we buy from ProSupply anymore\n" +
            "Office: We don't buy from ProSupply anymore because they were late delivering tiles for " +
            "Jenny's job in March, their pricing has gone up 15 percent since January, and Sarah in " +
            "dispatch was rude when we called about the delay.\n" +
            'New message: "who did we deal with in those instances?" -> "who did we deal with regarding ' +
            'ProSupply\'s late delivery, price increase, and rude staff member?"\n\n' +
            "Conversation history:\n" +
            historyText,
        },
        { role: "user", content: message },
      ],
    }));
    const r = result as { choices?: Array<{ message?: { content?: string } }> };
    const rewritten = r.choices?.[0]?.message?.content?.trim();
    return rewritten && rewritten.length > 0 ? rewritten : message;
  } catch (err) {
    try {
      await env.OFFICE_DB.prepare("INSERT INTO memory_errors (customer_id, text, error) VALUES (NULL, ?, ?)")
        .bind(`rewriteQuery failed for: ${message}`, err instanceof Error ? err.message : String(err))
        .run();
    } catch {
      // Nothing further to do.
    }
    return message;
  }
}

// Shared by both /files/audio (after transcription) and /messages/text
// (directly on typed input) — same extraction, reconciliation, guard(),
// and memory logic either way. A transcript is a transcript, whether
// it came from Whisper or a keyboard.
// The receptacle. Every single message lands here, unconditionally,
// the instant it arrives — before extraction even runs, and
// regardless of what extraction later manages or fails to structure
// from it. This is what would have saved Dwayne's measurements: even
// when extraction only pulls out a phone number, the entire real
// sentence still exists verbatim, findable later. Nothing said is
// ever truly lost — it's just not yet understood.
async function logCapture(env: Env, rawText: string, source: string, r2Key: string | null = null): Promise<number | null> {
  try {
    const inserted = await env.OFFICE_DB.prepare(
      "INSERT INTO captures (raw_text, source, r2_key) VALUES (?, ?, ?) RETURNING id"
    )
      .bind(rawText, source, r2Key)
      .first<{ id: number }>();
    return inserted!.id;
  } catch (err) {
    try {
      await env.OFFICE_DB.prepare("INSERT INTO memory_errors (customer_id, text, error) VALUES (NULL, ?, ?)")
        .bind(`logCapture failed: ${rawText}`, err instanceof Error ? err.message : String(err))
        .run();
    } catch {
      // Nothing further to do.
    }
    return null;
  }
}

// Fills in the real content once it's known — for a photo, the raw
// image itself is what was actually captured (same role a transcript
// plays for voice); the description is already an interpretation, so
// it's enrichment, arriving after, exactly like subject_hint does.
async function updateCaptureText(env: Env, captureId: number, rawText: string): Promise<void> {
  try {
    await env.OFFICE_DB.prepare("UPDATE captures SET raw_text = ?, extraction_status = 'processed' WHERE id = ?")
      .bind(rawText, captureId)
      .run();
  } catch {
    // Best effort — the row and the real R2 image already exist
    // regardless, which is what actually matters.
  }
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
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
async function describeImage(env: Env, base64: string, mimeType: string): Promise<string> {
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

// Enriches the raw capture with a loose hint once extraction knows who
// it was about — never required at capture time, only added after.
async function updateCaptureHint(env: Env, captureId: number, subjectHint: string | null): Promise<void> {
  try {
    await env.OFFICE_DB.prepare(
      "UPDATE captures SET subject_hint = ?, extraction_status = 'processed' WHERE id = ?"
    )
      .bind(subjectHint, captureId)
      .run();
  } catch {
    // Best-effort enrichment — the raw capture already exists
    // regardless, which is the part that actually matters.
  }
}

async function processTranscript(
  env: Env,
  transcript: string,
  ctx: ExecutionContext,
  history: HistoryTurn[] = [],
  source: string = "text",
  r2Key: string | null = null
): Promise<ProcessResult> {
  const captureId = await logCapture(env, transcript, source, r2Key);

  const rewritten = await rewriteQuery(env, history, transcript);

  let extraction: Extraction | null = null;
  let extractionRaw: unknown = null;
  let extractionRawText: string | null = null;
  let customer: { id: number; name: string; matched: boolean } | null = null;
  let character: { id: number; name: string; matched: boolean } | null = null;
  let pendingActionId: number | null = null;

  const result = await extractIntent(env, rewritten);
  extraction = result.extraction;
  extractionRaw = result.raw;
  extractionRawText = result.rawText;

  if (extraction?.customer_name) {
    customer = await reconcileCustomer(env, extraction.customer_name);
  }

  if (extraction?.character_name) {
    character = await reconcileCharacter(env, extraction.character_name, extraction.character_relationship);
  }

  if (captureId !== null) {
    const hint = customer?.name ?? character?.name ?? null;
    ctx.waitUntil(updateCaptureHint(env, captureId, hint));
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
  // price_scope found a customer but no recorded job_scope to price —
  // tracked separately so the message branch below can say so
  // honestly, the same pattern as convertQuoteFound/convertQuoteToInvoice
  // distinguishing "recognized intent, nothing to act on" from silence.
  let priceScopeNotFound = false;
  if ((extraction?.intent === "quotation" || extraction?.intent === "price_scope") && customer) {
    if (extraction.intent === "price_scope") {
      // The job_scopes -> quotation link. Grounded entirely in the
      // real, already-measured job — extraction is only ever told the
      // real component names and areas that exist, never asked to
      // invent structure that isn't already there.
      const jobScope = await findLatestJobScope(env, customer.id);
      if (!jobScope) {
        priceScopeNotFound = true;
      } else {
        const pricedItems = await extractScopePricing(env, transcript, jobScope.components, jobScope.tasks);
        quotationLineItems = pricedItems.map((item) => {
          const component = item.matched_name
            ? jobScope.components.find((c) => c.name.toLowerCase() === item.matched_name!.toLowerCase())
            : undefined;
          // The only real arithmetic in this whole step — rate x real
          // measured area — always happens here, in code. The model's
          // job was only ever matching a name and recognizing whether
          // the stated rate was per-sqm or flat.
          if (item.pricing_type === "per_sqm" && component?.area_sqm != null) {
            const lineTotal = Math.round(component.area_sqm * item.rate * 100) / 100;
            return {
              description: component.name,
              note: null,
              quantity: component.area_sqm,
              unit: "sqm",
              unit_price: item.rate,
              line_total: lineTotal,
            };
          }
          return {
            description: component?.name ?? item.description,
            note: null,
            quantity: 1,
            unit: null,
            unit_price: item.rate,
            line_total: item.rate,
          };
        });
      }
    } else {
      const rawLineItems = await extractLineItems(env, transcript);
      // Line total is always computed here, in code — never asked of
      // the model. Same discipline as every rand figure all day.
      quotationLineItems = rawLineItems.map((item) => ({
        ...item,
        line_total: item.quantity * item.unit_price,
      }));
    }

    const total =
      quotationLineItems.length > 0
        ? quotationLineItems.reduce((sum, item) => sum + item.line_total, 0)
        : extraction.amount ?? 0;

    if (total > 0) {
      // A clean, readable description derived from the actual line
      // items — not the raw spoken sentence. This is what shows up
      // on any document generated from this quotation later, and on
      // any invoice converted from it, so it's worth getting right
      // once, at the source, rather than patching each place it's
      // displayed downstream.
      const cleanDescription =
        quotationLineItems.length > 0
          ? quotationLineItems.map((item) => item.description).join("; ")
          : transcript;

      // price_scope has two possible destinations, not one — the same
      // measured job can become a proposed price OR a real invoice,
      // decided by the exact same tense signal ("quote" vs "invoice")
      // already proven for the plain, un-scoped quotation/invoice
      // intents. A plain "quotation" intent always lands here too,
      // since it never had an invoice-flavored sibling to begin with.
      const isScopeInvoice = extraction.intent === "price_scope" && extraction.scope_document_type === "invoice";

      const held = await holdForConfirmation(
        env,
        isScopeInvoice ? "invoice" : "quotation",
        {
          customerId: customer.id,
          customerName: customer.name,
          description: cleanDescription,
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

  let workObservationResult: { jobScopeId: number; componentCount: number; taskCount: number } | null = null;
  if (extraction?.intent === "work_observation" && customer) {
    const observation = await extractWorkObservation(env, transcript);
    const recorded = await recordWorkObservation(env, customer.id, observation, transcript);
    workObservationResult = {
      jobScopeId: recorded.jobScopeId,
      componentCount: observation.components.length,
      taskCount: observation.tasks.length,
    };
  }

  // Holds for confirmation instead of writing immediately. Real
  // evidence today: a misreconciled customer had this fire before
  // anyone ever saw a pending action to reject, silently overwriting
  // a different real person's address. Same discipline as money now
  // — a wrong reconciliation can no longer cause silent damage before
  // a human gets a chance to catch it.
  let factPendingActionId: number | null = null;
  if (extraction?.fact_key && extraction?.fact_value && customer) {
    const held = await holdForConfirmation(
      env,
      "customer_fact",
      { customerId: customer.id, customerName: customer.name, key: extraction.fact_key, value: extraction.fact_value },
      transcript
    );
    factPendingActionId = held.id;
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
    } else if (character) {
      ctx.waitUntil(appendCharacterNote(env, character.id, transcript));
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
  } else if (extraction?.intent === "price_scope" && priceScopeNotFound) {
    // Same honesty as the convert_quote case above — intent was
    // recognized, but there's no recorded job_scope for this customer
    // to price up.
    message = customer
      ? `I don't have a job scope on file for ${customer.name} to price.`
      : "I don't have anything on file for that yet.";
  } else if (extraction?.intent === "price_scope" && !pendingActionId) {
    // A job scope was found, but nothing spoken matched a real
    // component/task or produced a positive total — say so rather
    // than silently doing nothing.
    message = `Found a job scope for ${customer!.name}, but couldn't match any priced item to it — try naming the component or task exactly as measured.`;
  } else if (pendingActionId && extraction?.intent === "convert_quote" && convertQuoteFound) {
    const { total, depositAmount, remainingBalance, quotationId } = convertQuoteFound;
    const depositNote = extraction.deposit_percent
      ? ` ${extraction.deposit_percent}% deposit (R${depositAmount}) already paid —`
      : "";
    message = `Found quotation #${quotationId} for ${customer!.name} (R${total} total).${depositNote} remaining balance R${remainingBalance}. Needs your confirmation (action #${pendingActionId}) to convert to invoice.`;
  } else if (pendingActionId) {
    // price_scope's actual destination document depends on
    // scope_document_type, decided the same tense-based way as the
    // plain quotation/invoice split — not always "Quotation" anymore.
    const isScopeInvoice = extraction?.intent === "price_scope" && extraction?.scope_document_type === "invoice";
    const isQuotationLike =
      extraction?.intent === "quotation" || (extraction?.intent === "price_scope" && !isScopeInvoice);
    const kind = extraction?.intent === "invoice" || isScopeInvoice ? "Invoice" : isQuotationLike ? "Quotation" : "Payment";
    const displayAmount =
      (isQuotationLike || isScopeInvoice) && quotationLineItems.length > 0
        ? quotationLineItems.reduce((sum, item) => sum + item.line_total, 0)
        : extraction!.amount;
    const lineItemNote =
      quotationLineItems.length > 0
        ? ` (${quotationLineItems.length} line item${quotationLineItems.length > 1 ? "s" : ""})`
        : "";
    message = `${kind} noted for ${customer!.name}${displayAmount ? ` of R${displayAmount}` : ""}${lineItemNote} — needs your confirmation (action #${pendingActionId}) before it's recorded.`;
  } else if (workObservationResult) {
    const { jobScopeId, componentCount, taskCount } = workObservationResult;
    const parts: string[] = [];
    if (componentCount > 0) parts.push(`${componentCount} component${componentCount > 1 ? "s" : ""} measured`);
    if (taskCount > 0) parts.push(`${taskCount} task${taskCount > 1 ? "s" : ""} noted`);
    message = `Job scope #${jobScopeId} recorded for ${customer!.name}${parts.length ? ` — ${parts.join(", ")}` : ""}.`;
  } else if (extraction?.intent === "lookup") {
    if (extraction?.query_scope === "business") {
      // No single customer — a business-wide financial question,
      // answered from a real SQL aggregate, not a guess from a
      // sentence. This is the actual fix for "who owes me money."
      const outstandingFacts = await getOutstandingInvoices(env);
      message = await answerFromMemory(env, rewritten, outstandingFacts);
    } else if (character) {
      const characterFacts = await getCharacterNotes(env, character.id);
      const facts = [`${character.name} is a known contact.`, ...characterFacts];
      message = await answerFromMemory(env, rewritten, facts);
    } else if (customer) {
      const memoryFacts = await getCustomerNotes(env, customer.id);
      const financialSummary = await getCustomerFinancialSummary(env, customer.id);
      const facts = [
        `${customer.name} is a known customer.`,
        ...(financialSummary ? [`${customer.name}: ${financialSummary}`] : []),
        ...memoryFacts,
      ];
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

  if (factPendingActionId) {
    message += ` ${extraction!.fact_key} noted (${extraction!.fact_value}) — needs your confirmation (action #${factPendingActionId}) before it's saved.`;
  }

  return { extraction, extractionRaw, extractionRawText, customer, pendingActionId, factPendingActionId, message, rewrittenQuery: rewritten };
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

// Real, structured data becomes a real PDF — same reasoning as the
// docx approach already proven elsewhere: pure JS, no native deps,
// runs directly in the Workers isolate. Subtotal is recomputed fresh
// from line_items here, not read from invoices.amount — the line
// items are the actual ground truth; a cached total is a convenience,
// not the source of it. VAT applies from the business's current
// default; a genuine per-invoice override is a real refinement for
// later, once there's evidence it's actually needed.
async function generateInvoicePdf(env: Env, invoiceId: number): Promise<Uint8Array> {
  const business = await env.OFFICE_DB.prepare("SELECT * FROM business_profile WHERE id = 1").first<{
    name: string | null;
    trading_as: string | null;
    vat_no: string | null;
    address: string | null;
    phone: string | null;
    email: string | null;
    banking_details: string | null;
    vat_registered: number;
    vat_rate: number;
  }>();

  const invoice = await env.OFFICE_DB.prepare(
    "SELECT i.id, i.description, i.status, i.created_at, c.name as customer_name, c.address as customer_address FROM invoices i JOIN customers c ON c.id = i.customer_id WHERE i.id = ?"
  )
    .bind(invoiceId)
    .first<{
      id: number;
      description: string;
      status: string;
      created_at: string;
      customer_name: string;
      customer_address: string | null;
    }>();

  if (!invoice) {
    throw new Error(`no such invoice: ${invoiceId}`);
  }

  const { results: lineItems } = await env.OFFICE_DB.prepare(
    "SELECT description, quantity, unit_price, line_total FROM line_items WHERE invoice_id = ?"
  )
    .bind(invoiceId)
    .all<{ description: string; quantity: number; unit_price: number; line_total: number }>();

  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([595.28, 841.89]); // A4
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const grey = rgb(0.45, 0.45, 0.45);
  const black = rgb(0, 0, 0);

  let y = 792;
  const left = 50;
  const right = 400;

  page.drawText(business?.name ?? "[Business name not set]", { x: left, y, size: 14, font: bold });
  y -= 18;
  if (business?.trading_as) {
    page.drawText(`T/A ${business.trading_as}`, { x: left, y, size: 10, font });
    y -= 14;
  }
  if (business?.vat_no) {
    page.drawText(`VAT No: ${business.vat_no}`, { x: left, y, size: 10, font });
    y -= 14;
  }
  if (business?.address) {
    page.drawText(business.address, { x: left, y, size: 10, font });
    y -= 14;
  }
  if (business?.phone) {
    page.drawText(business.phone, { x: left, y, size: 10, font });
    y -= 14;
  }
  if (business?.email) {
    page.drawText(business.email, { x: left, y, size: 10, font });
    y -= 14;
  }
  const leftEndY = y;

  let yRight = 792;
  page.drawText("BILL TO", { x: right, y: yRight, size: 9, font: bold, color: grey });
  yRight -= 14;
  page.drawText(invoice.customer_name, { x: right, y: yRight, size: 12, font: bold });
  yRight -= 14;
  if (invoice.customer_address) {
    page.drawText(invoice.customer_address, { x: right, y: yRight, size: 10, font });
    yRight -= 14;
  }

  y = Math.min(leftEndY, yRight) - 30;

  page.drawText("TAX INVOICE", { x: left, y, size: 16, font: bold });
  page.drawText(`Invoice #${invoice.id}`, { x: right, y, size: 10, font, color: grey });
  y -= 30;

  page.drawText("DESCRIPTION", { x: left, y, size: 9, font: bold, color: grey });
  page.drawText("QTY", { x: 340, y, size: 9, font: bold, color: grey });
  page.drawText("RATE", { x: 400, y, size: 9, font: bold, color: grey });
  page.drawText("AMOUNT", { x: 480, y, size: 9, font: bold, color: grey });
  y -= 8;
  page.drawLine({ start: { x: left, y }, end: { x: 545, y }, thickness: 1, color: grey });
  y -= 18;

  let subtotal = 0;
  for (const item of lineItems) {
    page.drawText(item.description, { x: left, y, size: 10, font, maxWidth: 270 });
    page.drawText(String(item.quantity), { x: 340, y, size: 10, font });
    page.drawText(`R${item.unit_price.toLocaleString()}`, { x: 400, y, size: 10, font });
    page.drawText(`R${item.line_total.toLocaleString()}`, { x: 480, y, size: 10, font });
    subtotal += item.line_total;
    y -= 22;
  }

  y -= 8;
  page.drawLine({ start: { x: 380, y: y + 12 }, end: { x: 545, y: y + 12 }, thickness: 0.5, color: grey });

  page.drawText("SUBTOTAL", { x: 400, y, size: 10, font: bold });
  page.drawText(`R${subtotal.toLocaleString()}`, { x: 480, y, size: 10, font });
  y -= 16;

  let vatAmount = 0;
  if (business?.vat_registered) {
    vatAmount = subtotal * ((business.vat_rate ?? 15) / 100);
    page.drawText(`VAT (${business.vat_rate}%)`, { x: 400, y, size: 10, font });
    page.drawText(`R${vatAmount.toFixed(2)}`, { x: 480, y, size: 10, font });
    y -= 16;
  }

  const total = subtotal + vatAmount;
  page.drawText("TOTAL", { x: 400, y, size: 12, font: bold });
  page.drawText(`R${total.toFixed(2)}`, { x: 480, y, size: 12, font: bold, color: black });
  y -= 40;

  if (business?.banking_details) {
    page.drawText("Payment Info", { x: left, y, size: 11, font: bold });
    y -= 16;
    page.drawText(business.banking_details, { x: left, y, size: 9, font, maxWidth: 300 });
  }

  return await pdfDoc.save();
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
      const processed = transcript ? await processTranscript(env, transcript, ctx, [], "voice", key) : null;

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

    // The write-back counterpart to /debug/customer-notes GET — for
    // correcting a KV entry directly (e.g. removing a fact that got
    // filed under the wrong entity) without needing wrangler access.
    // Deliberately generic (any key, any JSON value) rather than one
    // narrow "remove a fact" endpoint — the same reasoning as every
    // other debug tool here: general enough to be useful again, not
    // custom-built for one cleanup.
    if (url.pathname === "/debug/kv-set" && request.method === "POST") {
      const body = (await request.json()) as { key?: string; value?: unknown };
      if (!body.key) return Response.json({ error: "missing key" }, { status: 400 });
      await env.CUSTOMER_NOTES.put(body.key, JSON.stringify(body.value));
      return Response.json({ status: "set", key: body.key });
    }

    // Scoped cleanup for a customer row created in error (e.g. a
    // supplier that should have been a character) — removes the D1
    // row, its KV notes, and any pending_memory_flush entries so
    // nothing dangling gets embedded into Vectorize afterward. Not a
    // general SQL executor on purpose — this only ever does exactly
    // these three deletes, scoped to one customer id.
    if (url.pathname === "/debug/delete-customer" && request.method === "POST") {
      const id = url.searchParams.get("id");
      if (!id) return Response.json({ error: "missing ?id=" }, { status: 400 });
      await env.OFFICE_DB.prepare("DELETE FROM customers WHERE id = ?").bind(id).run();
      await env.OFFICE_DB.prepare("DELETE FROM pending_memory_flush WHERE customer_id = ?").bind(id).run();
      await env.CUSTOMER_NOTES.delete(`customer:${id}`);
      return Response.json({ status: "deleted", id });
    }

    // Same shape as delete-customer, for a character created in error
    // — e.g. a staff contact that fragmented off a supplier
    // relationship instead of staying attached to it. No
    // pending_memory_flush cleanup needed here: characters never
    // queue into Vectorize consolidation in the first place.
    if (url.pathname === "/debug/delete-character" && request.method === "POST") {
      const id = url.searchParams.get("id");
      if (!id) return Response.json({ error: "missing ?id=" }, { status: 400 });
      await env.OFFICE_DB.prepare("DELETE FROM characters WHERE id = ?").bind(id).run();
      await env.CUSTOMER_NOTES.delete(`character:${id}`);
      return Response.json({ status: "deleted", id });
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

    if (url.pathname === "/debug/pdf-route-test" && request.method === "GET") {
      return Response.json({ ok: true, note: "this trivial route works" });
    }

    if (url.pathname.match(/^\/invoices\/\d+\/pdf$/) && request.method === "GET") {
      const invoiceId = Number(url.pathname.split("/")[2]);
      try {
        const pdfBytes = await generateInvoicePdf(env, invoiceId);
        return new Response(pdfBytes, {
          headers: {
            "Content-Type": "application/pdf",
            "Content-Disposition": `inline; filename="invoice-${invoiceId}.pdf"`,
          },
        });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
      }
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
          name: "work_observation classifies correctly, no price stated",
          text: "Dwayne is a new customer, I measured the reception area at 6600 by 4100 for vinyl flooring, we also need repair work",
          check: (e) => e?.intent === "work_observation" && e?.amount === null,
        },
        {
          name: "price_scope classifies correctly, distinct from a plain quotation",
          text: "price up Dwayne's job, R450 a square meter for the reception area and office, flat R3500 for the repair work",
          check: (e) => e?.intent === "price_scope" && e?.scope_document_type === "quotation",
        },
        {
          name: "price_scope recognizes invoice framing, not just quotation",
          text: "invoice out Dwayne's job, R450 a square meter for the reception area and office, the job's already done",
          check: (e) => e?.intent === "price_scope" && e?.scope_document_type === "invoice",
        },
        {
          name: "a stated fact is not misread as a question",
          text: "jenny lives at 5 Ocean View, Eshowe",
          check: (e) => e?.intent !== "lookup",
        },
        {
          name: "a personal relation is classified as a character, not a customer",
          text: "picked up my wife from work, she's annoyed about the kitchen guy not showing",
          check: (e) => e?.character_name === "wife" && !e?.customer_name,
        },
        {
          name: "a supplier is classified as a character (not billed), and the real subject wins over an incidental customer mention",
          text: "ProSupply was late delivering the tiles for Jenny's job back in March, held us up by four days",
          check: (e) => e?.character_name === "ProSupply" && !e?.customer_name,
        },
        {
          name: "a named staff contact at a supplier doesn't fork off its own entity",
          text: "called ProSupply about the March delay, spoke to Sarah in dispatch, she was really rude about it",
          check: (e) => e?.character_name === "ProSupply",
        },
      ];

      const results = await Promise.all(
        cases.map(async (c) => {
          const { extraction, raw } = await extractIntent(env, c.text);
          return { name: c.name, input: c.text, pass: c.check(extraction), extraction, rawOnFailure: extraction ? undefined : raw };
        })
      );

      return Response.json({ allPassed: results.every((r) => r.pass), results });
    }

    if (url.pathname === "/debug/rewrite-thinking-test" && request.method === "GET") {
      const historyText =
        "Peter: we quoted Sarah Bennett R8000 for tiling the bathroom\n" +
        "Office: Quotation noted for Sarah Bennett of R8000 (1 line item) — needs your confirmation (action #9) before it's recorded.\n" +
        "Peter: jenny paid R500\n" +
        "Office: Payment noted for Jenny Hawke of R500 — needs your confirmation (action #10) before it's recorded.";
      const message = "whats her balance?";
      const systemPrompt =
        "Rewrite the new message to be fully self-contained, replacing any pronouns or vague " +
        "references (her, him, that, it, the invoice, etc.) with the specific name or thing they " +
        "refer to, using the conversation history for context. When more than one person or thing " +
        "could match, ALWAYS resolve to whichever was mentioned MOST RECENTLY in the history, never " +
        "whichever was mentioned most often — recency wins over frequency, always. Do NOT answer " +
        "the message, add new information, or change its type — a question must stay phrased as a " +
        "question, a statement stays a statement. Only resolve what the ambiguous words refer to. " +
        "If the message is already self-contained, return it completely unchanged. Return ONLY the " +
        "rewritten message, nothing else — no explanation, no quotes.\n\nConversation history:\n" +
        historyText;

      const runOnce = async (thinking: boolean) => {
        const result = await env.AI.run("@cf/moonshotai/kimi-k2.6", {
          chat_template_kwargs: { thinking },
          temperature: 0,
          max_tokens: thinking ? 600 : undefined,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: message },
          ],
        });
        const r = result as { choices?: Array<{ message?: { content?: string; reasoning_content?: string } }> };
        return {
          content: r.choices?.[0]?.message?.content ?? null,
          reasoning: r.choices?.[0]?.message?.reasoning_content ?? null,
        };
      };

      const [thinkingOff, thinkingOn] = await Promise.all([runOnce(false), runOnce(true)]);
      return Response.json({ thinkingOff, thinkingOn });
    }

    if (url.pathname === "/debug/characters" && request.method === "GET") {
      const { results: characters } = await env.OFFICE_DB.prepare(
        "SELECT id, name, relationship, created_at FROM characters ORDER BY created_at DESC LIMIT 20"
      ).all<{ id: number; name: string; relationship: string | null; created_at: string }>();

      const enriched = await Promise.all(
        characters.map(async (c) => ({ ...c, notes: await getCharacterNotes(env, c.id) }))
      );

      return Response.json({ characters: enriched });
    }

    if (url.pathname === "/debug/job-scopes" && request.method === "GET") {
      const { results: scopes } = await env.OFFICE_DB.prepare(
        "SELECT js.id, js.customer_id, c.name as customer_name, js.description, js.scheduled_date_raw, js.created_at FROM job_scopes js JOIN customers c ON c.id = js.customer_id ORDER BY js.created_at DESC LIMIT 10"
      ).all();

      const enriched = await Promise.all(
        (scopes as Array<{ id: number }>).map(async (scope) => {
          const { results: components } = await env.OFFICE_DB.prepare(
            "SELECT name, width_mm, length_mm, area_sqm FROM scope_components WHERE job_scope_id = ?"
          )
            .bind(scope.id)
            .all();
          const { results: tasks } = await env.OFFICE_DB.prepare(
            "SELECT description, component_id FROM scope_tasks WHERE job_scope_id = ?"
          )
            .bind(scope.id)
            .all();
          return { ...scope, components, tasks };
        })
      );

      return Response.json({ jobScopes: enriched });
    }

    if (url.pathname === "/debug/quotations" && request.method === "GET") {
      const { results: quotes } = await env.OFFICE_DB.prepare(
        "SELECT q.id, q.customer_id, c.name as customer_name, q.description, q.amount, q.status, q.created_at FROM quotations q JOIN customers c ON c.id = q.customer_id ORDER BY q.created_at DESC LIMIT 10"
      ).all();

      const enriched = await Promise.all(
        (quotes as Array<{ id: number }>).map(async (quote) => {
          const { results: lineItems } = await env.OFFICE_DB.prepare(
            "SELECT description, note, quantity, unit, unit_price, line_total FROM line_items WHERE quotation_id = ?"
          )
            .bind(quote.id)
            .all();
          return { ...quote, lineItems };
        })
      );

      return Response.json({ quotations: enriched });
    }

    if (url.pathname === "/debug/invoices" && request.method === "GET") {
      const { results: invoices } = await env.OFFICE_DB.prepare(
        "SELECT i.id, i.customer_id, c.name as customer_name, i.description, i.amount, i.status, i.quotation_id, i.created_at FROM invoices i JOIN customers c ON c.id = i.customer_id ORDER BY i.created_at DESC LIMIT 10"
      ).all();

      const enriched = await Promise.all(
        (invoices as Array<{ id: number }>).map(async (invoice) => {
          const { results: lineItems } = await env.OFFICE_DB.prepare(
            "SELECT description, note, quantity, unit, unit_price, line_total FROM line_items WHERE invoice_id = ?"
          )
            .bind(invoice.id)
            .all();
          return { ...invoice, lineItems };
        })
      );

      return Response.json({ invoices: enriched });
    }

    if (url.pathname === "/debug/captures" && request.method === "GET") {
      const status = url.searchParams.get("status");
      const { results } = status
        ? await env.OFFICE_DB.prepare(
            "SELECT id, raw_text, source, subject_hint, extraction_status, r2_key, created_at FROM captures WHERE extraction_status = ? ORDER BY created_at DESC LIMIT 50"
          )
            .bind(status)
            .all()
        : await env.OFFICE_DB.prepare(
            "SELECT id, raw_text, source, subject_hint, extraction_status, r2_key, created_at FROM captures ORDER BY created_at DESC LIMIT 20"
          ).all();
      return Response.json({ captures: results });
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
            lineItems?: LineItemWithTotal[];
          };
          const invoice = await recordInvoice(
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
          return Response.json({
            status: "confirmed",
            invoice,
            pdfUrl: `${url.origin}/invoices/${invoice.id}/pdf`,
          });
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
          return Response.json({
            status: "confirmed",
            invoice: result,
            pdfUrl: `${url.origin}/invoices/${result.invoiceId}/pdf`,
          });
        }

        if (action.type === "customer_fact") {
          const payload = JSON.parse(action.payload) as {
            customerId: number;
            key: string;
            value: string;
          };
          await applyStructuredFact(env, payload.customerId, payload.key, payload.value, action.source_transcript);
          await env.OFFICE_DB.prepare(
            "UPDATE pending_actions SET status = 'confirmed', resolved_at = datetime('now') WHERE id = ?"
          )
            .bind(id)
            .run();
          return Response.json({ status: "confirmed", key: payload.key, value: payload.value });
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
        ? await processTranscript(env, transcript, ctx, history, "voice", key)
        : {
            extraction: null,
            extractionRaw: null,
            extractionRawText: null,
            customer: null,
            pendingActionId: null,
            factPendingActionId: null,
            message: "Voice note received (transcription unavailable).",
            rewrittenQuery: "",
          };

      return Response.json({ status: "stored", key, transcript, transcriptionError, ...processed });
    }

    // Photo capture. The raw image itself is what was actually
    // captured — same role a transcript plays for voice — so the
    // capture row and its real R2 key exist the instant it arrives,
    // before Kimi's vision description ever runs.
    if (url.pathname === "/files/photo" && request.method === "POST") {
      const formData = await request.formData();
      const photo = formData.get("photo");
      const caption = formData.get("caption");

      if (!(photo instanceof File)) {
        return Response.json({ error: "missing photo file" }, { status: 400 });
      }

      const photoBuffer = await photo.arrayBuffer();
      const mimeType = photo.type || "image/jpeg";
      const extension = mimeType.includes("png") ? "png" : "jpg";
      const key = `photos/${Date.now()}-${crypto.randomUUID()}.${extension}`;

      await env.OFFICE_VAULT.put(key, photoBuffer);
      const captureId = await logCapture(env, "[photo — description pending]", "photo", key);

      const base64 = arrayBufferToBase64(photoBuffer);
      const description = await describeImage(env, base64, mimeType);

      // A caption is optional — never invented, never guessed from the
      // image itself. If given, it's just a spoken or typed sentence
      // like any other, so it reuses the exact same extraction and
      // reconciliation already proven for text and voice, rather than
      // inventing a separate subject-detection path for photos.
      let subjectHint: string | null = null;
      let rawText = description;
      if (typeof caption === "string" && caption.trim().length > 0) {
        const captionText = caption.trim();
        rawText = `${captionText}\n\n[Photo description: ${description}]`;
        const { extraction } = await extractIntent(env, captionText);
        if (extraction?.customer_name) {
          const customer = await reconcileCustomer(env, extraction.customer_name);
          subjectHint = customer?.name ?? null;
        } else if (extraction?.character_name) {
          const character = await reconcileCharacter(env, extraction.character_name, extraction.character_relationship);
          subjectHint = character?.name ?? null;
        }
      }

      if (captureId !== null) {
        await updateCaptureText(env, captureId, rawText);
        if (subjectHint) {
          await updateCaptureHint(env, captureId, subjectHint);
        }
      }

      return Response.json({ status: "stored", key, captureId, description, subjectHint });
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

      const processed = await processTranscript(env, text, ctx, history, "text");
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

































