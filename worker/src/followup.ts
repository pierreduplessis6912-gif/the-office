// Spoken follow-ups on an open analysis (BI slice 4). THE PRINCIPLE (LOOKUP_ROUTING_ARCHITECTURE.md): the language side only decides WHAT is being asked; code resolves it and calculates; no model ever composes the answer. This module is deterministic and PRECISION-FIRST: it only ever acts when the app has said an analysis is on screen (workspace context, room "analysis"), and only on a small, finite set of clear phrasings:
//   why_changed        "why did it drop?"        -> the analysis of the open topic and period: what changed, from the report's own figures
//   top_drivers        "which customers caused most of that?" -> the biggest movers by customer (or category), from the same analysis
//   customer_invoices  "show me their outstanding invoices" / "what does Jenny owe?" -> that customer's receivables (CALCULATED: payments are applied oldest first)
// Anything else is NOT a follow-up and returns null, so the existing pipeline handles the message exactly as before. A customer is never guessed: a name that fits more than one customer, or "their" with nothing selected, is ASKED about. Every answer is built from the existing analysis and receivables functions, authorised by the same capabilities as their routes, and says plainly that the records show what changed, not why. It never writes anything.
import { analysisData, type Topic } from "./analysis";
import type { Context } from "./context";
import { customerReceivablesData, previousPeriod } from "./reports-data";
import type { Env, ProcessResult } from "./types";

export type FollowUpClass = "why_changed" | "top_drivers" | "customer_invoices";
export interface Classified { cls: FollowUpClass; topic: Topic | null; pronoun: boolean }
export interface FollowUpOutcome { message: string; interpreted: Record<string, unknown> }

const MAX_TEXT = 200;

// ---- reading the phrase ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
const normalize = (text: string): string => text.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();   // "what's" becomes "what s" and "Jenny's" becomes "jenny s"

const CHANGE = "(?:drop|dropped|dropping|fall|fallen|fell|falling|down|dip|dipped|decrease|decreased|decline|declined|lower|less|rise|rose|risen|rising|up|increase|increased|jump|jumped|spike|spiked|higher|more|change|changed|different|worse|better|slump|slumped|tank|tanked)";
const TOPIC_WORD: Array<[RegExp, Topic]> = [[/\b(?:revenue|sales|income|turnover|takings)\b/, "revenue"], [/\b(?:expenses?|costs?|spending|spend|spent)\b/, "expenses"], [/\b(?:profit|earnings)\b/, "profit"]];
const NOT_ABOUT_THE_FIGURE = /\b(?:invoices?|quotes?|quotations?|orders?|deliver(?:y|ies)|suppliers?|tasks?|snags?|stock|prices?|price|late|cancel|cancelled|cancelled|schedule|appointment|payment|payments|paid|owe|owed|owes|owing|outstanding|unpaid|overdue)\b/;

function topicOf(t: string): { topic: Topic | null; clash: boolean } {
  const found = TOPIC_WORD.filter(([re]) => re.test(t)).map(([, topic]) => topic);
  return { topic: found[0] ?? null, clash: found.length > 1 };
}

const LEAD = "(?:(?:and|so|but|ok|okay|hmm|right|then) )*";
const WHATS = "(?:what s|whats|what is|what was|what are)";
const BARE_WHY = new RegExp(`^${LEAD}(?:why (?:did|does|is|was|has|have|are|were|would)|how come(?: (?:did|does|is|was|has|have|are|were|would))?) (?:it|that|this)(?: (?:go|get|come|move))?(?: ${CHANGE})+(?: so)?(?: (?:much|far|a lot|that much))?$`);
const BARE_WHAT = new RegExp(`^${LEAD}what (?:has |have |had )?(?:changed|happened)(?: (?:there|here|in (?:it|that|this)))?$`);
const BARE_DRIVING = new RegExp(`^${LEAD}${WHATS} (?:driving|behind|causing|caused|moving|moved) (?:it|that|this|the (?:drop|rise|fall|increase|decrease|dip|change|difference|movement))$`);
const BARE_CAUSED = new RegExp(`^${LEAD}what (?:caused|drove|moved) (?:it|that|this|the (?:drop|rise|fall|increase|decrease|dip|change|difference|movement))$`);
const THE_MOVE = /\bthe (?:drop|rise|fall|increase|decrease|dip|change|jump|difference)\b/;

function whyChanged(t: string): { topic: Topic | null } | null {
  const words = t.split(" ").length;
  if (BARE_WHY.test(t) || BARE_WHAT.test(t) || BARE_DRIVING.test(t) || BARE_CAUSED.test(t)) return { topic: null };
  const { topic, clash } = topicOf(t);
  if (clash || topic === null || words > 14 || NOT_ABOUT_THE_FIGURE.test(t)) return null;
  // "why did revenue drop", "why is profit down", "why are expenses up": the question word, the figure and a change word, and nothing about a particular record
  if (/\b(?:why|how come)\b/.test(t) && new RegExp(`\\b${CHANGE}\\b`).test(t)) return { topic };
  if (new RegExp(`^${LEAD}(?:what s|whats|what is|what was|what has|what have) (?:driving|behind|changed|moved)`).test(t)) return { topic };
  return null;
}

const DIMENSION = "(?:customers?|clients?|categories|category|accounts?|people|ones|lines|parts)";
const DRIVER = "(?:caused|cause|drove|driven|driving|behind|responsible|biggest|largest|top|main|most of|contributed|contributing|contributors?|movers?|drivers?|account(?:s|ed)? for)";
function topDrivers(t: string): { topic: Topic | null } | null {
  if (NOT_ABOUT_THE_FIGURE.test(t) || t.split(" ").length > 14) return null;
  const { topic, clash } = topicOf(t);
  if (clash) return null;
  const refers = /\b(?:that|it|this)\b/.test(t) || THE_MOVE.test(t) || new RegExp(`\\b(?:biggest|largest|top|main) (?:${"contributors?|movers?|drivers?"})\\b`).test(t);
  // "which customers caused that": the question names WHAT kind of thing moved it. A bare "what is driving that" is the why_changed question, not this one.
  if (new RegExp(`^${LEAD}(?:which|what) ${DIMENSION} ?(?:are |is |were |was |did |do |does |have |has )?(?:the )?${DRIVER}`).test(t) && refers) return { topic };
  if (new RegExp(`^${LEAD}(?:which|what) ${DIMENSION} .*${DRIVER}`).test(t) && refers) return { topic };
  if (new RegExp(`^${LEAD}who (?:drove|caused|is behind|was behind|s behind|moved) (?:that|it|this)$`).test(t)) return { topic };
  if (new RegExp(`^${LEAD}(?:(?:what are|what s|whats|show me|give me) )?(?:the )?(?:biggest|largest|top|main) (?:contributors|movers|drivers)$`).test(t)) return { topic };
  return null;
}

const SHOW = "(?:show|list|give|open|pull up|see|what|whats|how much|which)";
function customerInvoices(t: string): { pronoun: boolean } | null {
  if (t.split(" ").length > 14) return null;
  // a general question about WHO owes money belongs to the existing aged debtors route: never taken here
  if (/\b(?:who|which (?:customers?|clients?|people)|everyone|everybody|all (?:my |our )?(?:customers?|clients?|debtors))\b.*\b(?:owe|owes|owing|owed|outstanding|unpaid|overdue)\b/.test(t) && !/\b(?:their|them|they|that customer|this customer)\b/.test(t)) return null;
  const owed = /\b(?:outstanding|unpaid|owing|owed|owe|owes|overdue)\b/.test(t);
  const thing = /\b(?:invoices?|balance|amount|account|statement)\b/.test(t) || /\b(?:do|does) \S+(?: \S+)? owe\b/.test(t) || /\bowe\b/.test(t);
  if (!owed || !thing) return null;
  if (!new RegExp(`^(?:(?:and|so|but|ok|okay|hmm|right|then|please|can you|could you) )*${SHOW}\\b`).test(t) && !/\b(?:do|does) \S+(?: \S+)? owe\b/.test(t)) return null;
  return { pronoun: /\b(?:their|them|they|that customer|this customer)\b/.test(t) };
}

/** What, if anything, a phrase asks of the open analysis. Null means "not a follow-up": the message goes to the ordinary pipeline untouched. */
export function classifyFollowUp(text: string): Classified | null {
  if (typeof text !== "string" || text.length === 0 || text.length > MAX_TEXT) return null;
  const t = normalize(text);
  if (t === "") return null;
  const ci = customerInvoices(t);
  if (ci) return { cls: "customer_invoices", topic: null, pronoun: ci.pronoun };
  const td = topDrivers(t);
  if (td) return { cls: "top_drivers", topic: td.topic, pronoun: false };
  const wc = whyChanged(t);
  if (wc) return { cls: "why_changed", topic: wc.topic, pronoun: false };
  return null;
}

// ---- answering ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
const round2 = (value: number): number => Math.round(value * 100) / 100;
const rand = (value: number): string => { const [whole, rest] = Math.abs(value).toFixed(2).split("."); return `R${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${rest}`; };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function span(range: { from: string; to: string }): string {
  const a = new Date(`${range.from}T00:00:00Z`), b = new Date(`${range.to}T00:00:00Z`);
  const left = `${a.getUTCDate()} ${MONTHS[a.getUTCMonth()]}${a.getUTCFullYear() === b.getUTCFullYear() ? "" : ` ${a.getUTCFullYear()}`}`;
  return `${left} to ${b.getUTCDate()} ${MONTHS[b.getUTCMonth()]} ${b.getUTCFullYear()}`;
}
const NOT_WHY = "The records show what changed, not why it happened.";

interface AnalysisLike {
  summary: { change: { amount: number; percent: number | null }; direction: string };
  contributors: Array<{ name: string; label?: string; part: string; change: { amount: number; percent: number | null }; shareOfChange: number | null }>;
  findings: Array<{ statement: string }>;
  period: { from: string; to: string };
  compare: { from: string; to: string };
}

const TOPICS: Topic[] = ["revenue", "expenses", "profit"];
const topicFromContext = (context: Context): Topic | null => { const t = context.filters?.topic; return typeof t === "string" && (TOPICS as string[]).includes(t) ? (t as Topic) : null; };

function explain(topic: Topic, a: AnalysisLike): string {
  const head = a.findings[0]?.statement ?? "There is nothing to compare.";
  const driver = a.findings.find((f) => / accounts for /.test(f.statement))?.statement;
  const hint = topic === "revenue" ? " You can ask which customers drove it." : "";
  return `For ${span(a.period)} against ${span(a.compare)}: ${head}${driver ? ` ${driver}` : ""} ${NOT_WHY}${hint}`;
}

function movers(topic: Topic, a: AnalysisLike): string {
  const kind = topic === "revenue" ? "customer" : topic === "expenses" ? "category" : "line";
  const drivers = a.contributors.filter((c) => c.part === "driver").slice(0, 3);
  if (drivers.length === 0) return `Nothing moved enough to name by ${kind} between ${span(a.period)} and ${span(a.compare)}: there was no net change. ${NOT_WHY}`;
  const list = drivers.map((c) => `${c.label ?? c.name} ${c.change.amount > 0 ? "up" : "down"} ${rand(c.change.amount)}${c.shareOfChange === null ? "" : ` (${c.shareOfChange}% of the change)`}`);
  const last = list.pop();
  return `The biggest movers by ${kind}, for ${span(a.period)} against ${span(a.compare)}, were ${list.length ? `${list.join(", ")} and ` : ""}${last}. ${NOT_WHY}`;
}

// ---- which customer ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
const STOP = new Set(["the", "and", "for", "show", "list", "give", "open", "pull", "see", "what", "whats", "how", "much", "does", "did", "owe", "owed", "owes", "owing", "outstanding", "unpaid", "overdue", "invoices", "invoice", "balance", "amount", "account", "statement", "their", "them", "they", "that", "this", "customer", "please", "can", "could", "you", "all", "any", "now", "from", "with", "about", "which", "who", "are", "has", "have", "his", "her"]);
type Found = { kind: "one"; id: number; name: string } | { kind: "many"; names: string[] } | { kind: "none" };
function findCustomer(t: string, customers: Array<{ id: number; name: string }>): Found {
  const padded = ` ${t} `;
  const full = customers.filter((c) => { const n = normalize(c.name); return n.length >= 2 && padded.includes(` ${n} `); });
  const longest = full.filter((c) => !full.some((o) => o !== c && normalize(o.name).length > normalize(c.name).length && ` ${normalize(o.name)} `.includes(` ${normalize(c.name)} `)));
  if (longest.length === 1) return { kind: "one", id: longest[0].id, name: longest[0].name };
  if (longest.length > 1) return { kind: "many", names: longest.map((c) => c.name) };
  const words = new Set(t.split(" ").filter((w) => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w)));
  const partial = customers.filter((c) => normalize(c.name).split(" ").some((w) => w.length >= 3 && words.has(w)));
  if (partial.length === 1) return { kind: "one", id: partial[0].id, name: partial[0].name };
  if (partial.length > 1) return { kind: "many", names: partial.map((c) => c.name) };
  return { kind: "none" };
}

function receivablesMessage(d: NonNullable<Awaited<ReturnType<typeof customerReceivablesData>>>): string {
  const name = d.customer.name;
  const credit = d.unappliedPayments > 0 ? ` ${rand(d.unappliedPayments)} of their payments is not applied to any invoice.` : "";
  if (d.invoices.length === 0) return `Nothing is outstanding for ${name}.${credit}`;
  const first = d.invoices[0];
  const many = d.outstandingCount === 1 ? "1 invoice" : `${d.outstandingCount} invoices`;
  return `${name} has ${rand(d.buckets.total)} outstanding across ${many}. The oldest is ${rand(first.outstanding)} from ${first.date}, ${first.ageDays === 1 ? "1 day" : `${first.ageDays} days`} old.${credit} These figures are calculated: payments are applied to the oldest invoices first, not matched to specific invoices.`;
}

// ---- the reply -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
/** A reply in the shape every message route returns, carrying only words: nothing is held, nothing is written. */
export function followUpReply(text: string, message: string): ProcessResult {
  return { extraction: null, extractionRaw: null, extractionRawText: null, customer: null, pendingActionId: null, pendingActionIds: [], factPendingActionId: null, message, rewrittenQuery: text, embers: { tasks: 0, scheduler: 0, finance: 0, expenses: 0 }, pendingCandidates: null, pendingActionType: null, pendingChanges: null, pendingActions: [] };
}

/** Tries to answer a message as a follow-up on the open analysis. Null when it is not one (no analysis on screen, a different phrase, or switched off): then nothing here has had any effect. Never throws. */
export async function tryFollowUp(env: Env, text: string, context: Context | null, capabilities: string[]): Promise<FollowUpOutcome | null> {
  try {
    if ((env as { FOLLOWUPS?: string }).FOLLOWUPS === "off") return null;
    if (context === null || context.room !== "analysis") return null;
    const asked = classifyFollowUp(text);
    if (asked === null) return null;
    const note = (outcome: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ followUp: asked.cls, outcome, ...extra });

    if (asked.cls === "customer_invoices") {
      const { results: customers } = await env.OFFICE_DB.prepare("SELECT id, name FROM customers ORDER BY id LIMIT 1000").all<{ id: number; name: string }>();
      const selected = context.selection?.find((s) => s.type === "customer");
      let target: Found = { kind: "none" };
      if (asked.pronoun && selected) {
        const c = customers.find((x) => x.id === selected.id);
        if (c) target = { kind: "one", id: c.id, name: c.name };
      } else {
        target = findCustomer(normalize(text), customers);
      }
      // No customer named and nobody to mean by "their": a general question about unpaid invoices, which the existing routes already answer. Not a follow-up.
      if (target.kind === "none" && !asked.pronoun) return null;
      if (!capabilities.includes("can_know_debtors")) return { message: "Who owes what is restricted for your role.", interpreted: note("restricted") };
      if (target.kind === "none") {
        // "their" with nothing selected: ask, naming the biggest movers when an analysis is open
        let names: string[] = [];
        if (context.period && capabilities.includes("can_know_profit")) {
          const a = (await analysisData(env, "revenue", { period: context.period, compare: context.compare ?? previousPeriod(context.period.from, context.period.to) })) as unknown as AnalysisLike | null;
          names = (a?.contributors ?? []).filter((c) => c.part === "driver").slice(0, 3).map((c) => c.label ?? c.name);
        }
        return { message: names.length ? `Which customer do you mean? The biggest movers were ${names.join(", ")}.` : "Which customer do you mean? Tap one in the analysis, or say their name.", interpreted: note("asked", { reason: "no_customer_selected" }) };
      }
      if (target.kind === "many") return { message: `More than one customer fits: ${target.names.slice(0, 5).join(", ")}. Which one do you mean?`, interpreted: note("asked", { reason: "more_than_one_customer" }) };
      const detail = await customerReceivablesData(env, target.id);
      if (detail === null) return { message: "I couldn't find that customer.", interpreted: note("asked", { reason: "customer_not_found" }) };
      return { message: receivablesMessage(detail), interpreted: note("answered", { customerId: target.id }) };
    }

    // why_changed and top_drivers need the analysis the person is looking at: its topic and its period
    if (!capabilities.includes("can_know_profit")) return { message: "The financial analysis is restricted for your role.", interpreted: note("restricted") };
    const topic = asked.topic ?? topicFromContext(context);
    if (topic === null) return { message: "Which would you like to look at: revenue, expenses or profit?", interpreted: note("asked", { reason: "no_topic" }) };
    if (!context.period) return { message: "Open the analysis and pick a period first, then ask again.", interpreted: note("asked", { reason: "no_period" }) };
    const compare = context.compare ?? previousPeriod(context.period.from, context.period.to);
    const a = (await analysisData(env, topic, { period: context.period, compare })) as unknown as AnalysisLike | null;
    if (a === null) return { message: "There is nothing to compare for that period.", interpreted: note("asked", { reason: "no_comparison" }) };
    return { message: asked.cls === "why_changed" ? explain(topic, a) : movers(topic, a), interpreted: note("answered", { topic, period: context.period, compare }) };
  } catch {
    return null;   // never a failure of its own: the ordinary pipeline answers
  }
}
