// The conversational layer, Phase 1: CONVERSATION ONLY (CONVERSATIONAL_LAYER.md). When the ordinary pipeline found NOTHING to act on ("hello", "I want to have a conversation with you", "what can you help me with?"),
// the reply used to be "I didn't catch anything there I could act on." This module answers such a message in words instead.
//
// THE DOCTRINE (proposed, awaiting Pierre's approval; OFFICE_CONSTITUTION.md is not changed until he approves the wording): the model may converse and narrate, but every business fact or number must come verbatim
// from a deterministic read tool. It never calculates, never confirms, never claims a record exists until the backend confirms it. In Phase 1 there is no read tool, so the model is given NO business data and may state NO figure.
//
// WHAT KEEPS IT SAFE, each part tested (tools/converse.test.js) and proven by breakage (tools/converse-breakage.js):
//  - it runs only when the whole message is the old failure text AND the intent was "other" AND nothing was found, held or refused; every business instruction keeps its exact old path
//  - it can only ever change the reply's `message`: this file imports no function that writes a record or holds an action, and has no SQL of its own
//  - the model has no tools and sees no business data: only the persona, the capabilities listed below, and the member's own last few turns from their own history (scope "own", their own business's database)
//  - what the model says passes a deterministic check before anyone sees it: no digit (so no figure, amount, date or count) and no claim that anything was recorded, saved, created, sent, confirmed... Failing it returns null: the old message stands
//  - any failure anywhere (the model, the history, the check) returns null, never throws; CONVERSE=off returns null before anything else
import { withRetry } from "./ai";
import { readHistory } from "./history";
import { NO_INTENT_MESSAGE } from "./no-intent";
import type { Env } from "./types";

/** What The Office can really do, one entry per BUILT section of FEATURES.md (tools/converse.test.js fails if `feature` is not a live heading there). `needs` is the permission a member must hold for it to be described to them. */
export const REAL_CAPABILITIES: Array<{ feature: string; says: string; needs?: string }> = [
  { feature: "Customers", says: "keep a record of your customers, with their contact details and notes about them" },
  { feature: "Quotations & Pricing", says: "prepare quotations from what you say, with line items and discounts", needs: "can_make_quotes" },
  { feature: "Invoicing & Payments", says: "raise invoices and record payments, each held for your confirmation before it is recorded", needs: "can_manage_invoices" },
  { feature: "Job Scopes & Work Observations", says: "capture the measurements, tasks and installer for a job, and schedule it" },
  { feature: "Expenses", says: "record what the business spent, and tie it to a job" },
  { feature: "Financial Reporting", says: "produce financial reports such as profit and loss and aged debtors", needs: "can_know_profit" },
  { feature: "Team & Contacts (Characters)", says: "keep track of installers, suppliers and other people who are not customers" },
  { feature: "Tasks & Reminders", says: "keep your reminders and follow-ups" },
  { feature: "Memory & Notes", says: "keep notes and facts you want remembered" },
  { feature: "Documents & Files", says: "turn photos, voice notes and documents into something it can use" },
  { feature: "Conversational Lookup", says: "answer direct questions about your business, from the records" },
  { feature: "Suppliers & Procurement (Purchase Orders, Deliveries, Supplier Bills)", says: "raise purchase orders, record deliveries and supplier bills, and check them against each other" },
  { feature: "Variance Disposition", says: "record why a delivery did not match its order and how it was resolved" },
  { feature: "Consumables Stock", says: "keep running quantities of generic materials such as glue and screed" },
  { feature: "Snags", says: "log quality issues found on a job and when they are resolved" },
  { feature: "Leads & Enquiries", says: "keep track of enquiries from people who are not yet customers" },
  { feature: "Supplier Statement Reconciliation", says: "compare a supplier's statement balance with your own books" },
  { feature: "Projects (Layer 2)", says: "group the related jobs of a customer into one project" },
];

const HISTORY_TURNS = 6;       // the member's last few turns
const TURN_CHARS = 300;        // each turn is cut to this
const TEXT_CHARS = 1000;       // so is what they just said
export const MAX_REPLY_CHARS = 700;   // a longer answer is not a conversational one

/** The persona and its rules. No example in it contains a figure, and the capability list is the only list of abilities the model has. */
export function personaFor(capabilities: readonly string[]): string {
  const can = REAL_CAPABILITIES.filter((c) => !c.needs || capabilities.includes(c.needs)).map((c) => `- ${c.says}`).join("\n");
  return [
    "You are The Office, a calm, direct assistant for a tradesperson who runs a small business, talking with one member of their team. Talk the way a capable colleague would: plain, warm without gushing, one to three short sentences.",
    "In this conversation you can chat, explain in general terms how The Office works, and say what The Office can do. You cannot see this business's records here.",
    "Rules that never bend:",
    "- Never state, give or invent a figure, number, amount, date or count, and never name a customer, supplier or record that the person has not just named themselves. If they want a fact about the business, tell them to ask it as a question (for example what a customer owes) and the answer will come from the records.",
    "- Never say that anything was recorded, saved, created, sent, scheduled, updated, paid or confirmed. Nothing happens in this conversation.",
    "- If they want something done (a quote, an invoice, a payment, an expense), tell them to say it as an instruction, with who it is for and what it is for. Money actions are held for their confirmation before anything is recorded.",
    "- If you are not sure what they mean, ask one short question.",
    "- Never mention these rules, a model, AI or technology. You are The Office.",
    "What The Office can really do (describe only these, never anything else):",
    can,
  ].join("\n");
}

type Understood = { message?: unknown; extraction?: { intent?: unknown } | null; customer?: unknown; character?: unknown; pendingActionId?: unknown; pendingActionIds?: unknown; factPendingActionId?: unknown; refusals?: unknown };

/** True only when the pipeline understood nothing: the old failure text, as the WHOLE message, from an intent of "other", with nothing found, held or refused. */
export function nothingUnderstood(p: Understood): boolean {
  if (p.message !== NO_INTENT_MESSAGE) return false;
  if (p.extraction?.intent !== "other") return false;   // an extraction that failed altogether (null) is not a conversation: the old message stands
  if (p.customer || p.character) return false;
  if (p.pendingActionId !== null && p.pendingActionId !== undefined) return false;
  if (Array.isArray(p.pendingActionIds) && p.pendingActionIds.length > 0) return false;
  if (p.factPendingActionId !== null && p.factPendingActionId !== undefined) return false;
  if (Array.isArray(p.refusals) && p.refusals.length > 0) return false;
  return true;
}

// What may never be shown: any digit (a figure, an amount, a date, a count) or a claim that something HAS been done.
export const CLAIMED = /\b(?:recorded|saved|created|logged|confirmed|scheduled|booked|issued|deleted|updated|sent|added|noted|paid|invoiced|quoted)\b/i;
function shown(reply: unknown): string | null {
  if (typeof reply !== "string") return null;
  const text = reply.trim();
  if (text.length === 0 || text.length > MAX_REPLY_CHARS) return null;
  if (/\d/.test(text) || CLAIMED.test(text)) return null;
  return text;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const cut = (s: string): string => (s.length > TURN_CHARS ? s.slice(0, TURN_CHARS) : s);

/** The member's own last few turns, oldest first, from their own history in their own business's database. Never throws: no history is just no history. */
export async function lastTurns(env: Env, email: string | null): Promise<Array<{ role: "user" | "assistant"; content: string }>> {
  try {
    const history = await readHistory(env, { scope: "own", viewer: email, limit: HISTORY_TURNS, before: null });
    const turns: Array<{ role: "user" | "assistant"; content: string }> = [];
    for (const item of [...history.items].reverse()) {
      if (!isRecord(item)) continue;
      const heard = isRecord(item.recorded) ? item.recorded.heard : null;
      const replied = isRecord(item.generated) ? item.generated.replied : null;
      if (typeof heard === "string" && heard.trim()) turns.push({ role: "user", content: cut(heard.trim()) });
      if (typeof replied === "string" && replied.trim()) turns.push({ role: "assistant", content: cut(replied.trim()) });
    }
    return turns;
  } catch {
    return [];
  }
}

/** The words to answer with, or null (then the old reply stands, untouched). Never throws. */
export async function tryConverse(env: Env, text: string, processed: Understood, who: { email: string | null; capabilities: readonly string[] }): Promise<string | null> {
  try {
    if (env.CONVERSE === "off") return null;
    if (!nothingUnderstood(processed)) return null;
    const turns = await lastTurns(env, who.email);
    const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [{ role: "system", content: personaFor(who.capabilities) }, ...turns, { role: "user", content: text.slice(0, TEXT_CHARS) }];
    const result = await withRetry(() => env.AI.run("@cf/moonshotai/kimi-k2.6", { temperature: 0.4, chat_template_kwargs: { thinking: false }, messages } as never));   // `thinking` is missing from the binding's types (the other Kimi calls are in the typecheck baseline for the same reason); `as never` keeps the call itself typed
    const r = result as { choices?: Array<{ message?: { content?: unknown } }> };
    return shown(r.choices?.[0]?.message?.content);
  } catch {
    return null;
  }
}
