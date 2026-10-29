// The read layer: the app's door to the same read-only data the MCP tools return (Pierre, 2026-10-29: "the MCP is the benchmark"), answering in WORDS built by code. Found missing by the Office read baseline: the answer path had no today's date, saw
// only jobs scheduled for exactly today, gathered tasks without their due dates, and could not answer for quotes, stock or a customer's jobs (they fell to a financial clarifying question or "I don't have that on file").
//
// GUARDS, identical to the MCP: every MCP list tool is ownerOnly (mcp.ts), so this answers the OWNER only; any other role, or none, gets null and the ordinary pipeline answers exactly as before. READ_LAYER=off switches it off.
// It is READ ONLY (SELECTs through the shared data functions in mcp-reads.ts, nothing else), makes NO model call (so no figure is composed by a model and the answer is instant), and takes only a question about the date, the schedule, quotes or
// stock: a message must OPEN like a question (what, which, when, how many, do we, show me ...), so an instruction ("invoice", "remind me", "add", "schedule" ...), a greeting or a bare word returns null and reaches the pipeline untouched.
//
// JUDGMENT, in code (Pierre): "today" is today plus anything overdue; "tomorrow" is tomorrow; "this week" runs to Sunday; "coming up" is the next 14 days, soonest first, with what has no date kept apart; something far off (a January gala) is NOT
// volunteered and shows only when a month is asked for; a done task and a past job never appear. The business's own clock decides what today is.
import { customersData, jobsData, quotesData, stockData } from "./mcp-reads";
import { getOpenTasks, nowInBusinessTimezone } from "./scheduler";
import type { Env } from "./types";

export type ReadKind = "date" | "schedule" | "quotes" | "stock" | "customer_jobs";
export type ReadAnswer = { kind: ReadKind; message: string };

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const AHEAD_DAYS = 14;
const PAGE = { limit: 100, offset: 0 };
const NO_RANGE = { from: null, to: null };

const pad = (n: number) => String(n).padStart(2, "0");
const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (d: Date, n: number) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const parseIso = (s: string) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const short = (s: string) => { const d = parseIso(s); return `${DAYS_SHORT[d.getDay()]} ${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}`; };
const rand = (n: number) => `R${Number.isInteger(n) ? n : n.toFixed(2)}`;

const STARTER = /^(?:what(?:'s|s| is| are| do| did)?|which|when(?:'s| is| are)?|how many|how much|do (?:i|we)|am i|have i|is there|are there|any(?:thing)?|show me|show|list|tell me|give me|can you (?:show|tell|list|give)(?: me)?)\b/;
const MONEY = /\b(?:owe|owes|owed|paid|invoice|invoices|expense|expenses|spent|spend|profit|revenue|debtors?|financial|income|balance)\b/;
const SCHEDULE_WORD = /\b(?:coming up|upcoming|what's next|planned|scheduled|booked|lined up|jobs?|tasks?|reminders?|to do|need to do|have to do|appointments?|agenda|diary|calendar|(?:have|got|is|'s) on|on for|on today|on tomorrow|on this week|on next week)\b/;
const MONTH_WORD = /\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/;

const normalise = (text: string) => text.toLowerCase().replace(/[\u2019]/g, "'").replace(/[?!.]+$/, "").replace(/\s+/g, " ").trim();

type Window = { from: string; to: string; label: string; days: boolean; overdue: boolean; undated: boolean; empty: string };
function windowFor(q: string, now: Date): Window {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const t = iso(today);
  const dow = today.getDay();
  if (/\btomorrow\b/.test(q)) { const d = iso(addDays(today, 1)); return { from: d, to: d, label: `Tomorrow, ${short(d)}`, days: false, overdue: false, undated: false, empty: "tomorrow" }; }
  if (/\bnext week\b/.test(q)) { const mon = addDays(today, (8 - dow) % 7 || 7); return { from: iso(mon), to: iso(addDays(mon, 6)), label: "Next week", days: true, overdue: false, undated: false, empty: "next week" }; }
  if (/\bthis week\b/.test(q)) return { from: t, to: iso(addDays(today, (7 - dow) % 7)), label: "This week", days: true, overdue: true, undated: false, empty: "this week" };
  if (/\bnext month\b/.test(q)) { const first = new Date(today.getFullYear(), today.getMonth() + 1, 1); return { from: iso(first), to: iso(new Date(first.getFullYear(), first.getMonth() + 1, 0)), label: `${MONTHS[first.getMonth()]} ${first.getFullYear()}`, days: true, overdue: false, undated: false, empty: "next month" }; }
  if (/\bthis month\b/.test(q)) return { from: t, to: iso(new Date(today.getFullYear(), today.getMonth() + 1, 0)), label: "This month", days: true, overdue: true, undated: false, empty: "this month" };
  const month = q.match(MONTH_WORD);
  if (month) {
    const m = MONTHS.map((x) => x.toLowerCase()).indexOf(month[1]);
    const year = m >= today.getMonth() ? today.getFullYear() : today.getFullYear() + 1;
    const first = new Date(year, m, 1);
    return { from: m === today.getMonth() && year === today.getFullYear() ? t : iso(first), to: iso(new Date(year, m + 1, 0)), label: `${MONTHS[m]} ${year}`, days: true, overdue: false, undated: false, empty: `${MONTHS[m]} ${year}` };
  }
  if (/\btoday\b/.test(q) || /\bwhat's on\b$/.test("") ) return { from: t, to: t, label: `Today, ${short(t)}`, days: false, overdue: true, undated: false, empty: "today" };
  return { from: t, to: iso(addDays(today, AHEAD_DAYS)), label: `Coming up (next ${AHEAD_DAYS} days)`, days: true, overdue: true, undated: true, empty: `in the next ${AHEAD_DAYS} days` };
}

async function customerIn(env: Env, q: string): Promise<{ id: number; name: string } | null> {
  const { items } = await customersData(env, PAGE, null);
  let best: { id: number; name: string } | null = null;
  for (const c of items) { const name = String(c.name ?? "").toLowerCase(); if (name.length >= 3 && q.includes(name) && (best === null || name.length > best.name.length)) best = { id: c.id, name: String(c.name) }; }
  return best;
}

async function schedule(env: Env, q: string, now: Date): Promise<string> {
  const w = windowFor(q, now);
  const today = iso(new Date(now.getFullYear(), now.getMonth(), now.getDate()));
  const jobsAsked = /\bjobs?\b|installation|install/.test(q), tasksAsked = /\btasks?\b|reminders?\b/.test(q);
  const wantJobs = jobsAsked || !tasksAsked, wantTasks = tasksAsked || !jobsAsked;
  const byDay = new Map<string, string[]>();
  const put = (day: string, line: string) => { const l = byDay.get(day) ?? []; l.push(line); byDay.set(day, l); };
  if (wantJobs) for (const j of (await jobsData(env, PAGE, { from: w.from, to: w.to }, null)).items as Array<{ description: string; customer_name: string | null; scheduled_date: string | null }>) if (j.scheduled_date) put(j.scheduled_date.slice(0, 10), `- ${j.description}${j.customer_name ? ` for ${j.customer_name}` : ""}`);
  const overdue: string[] = [], undated: string[] = [];
  if (wantTasks) for (const t of await getOpenTasks(env)) {
    const due = t.due_date ? t.due_date.slice(0, 10) : null;
    if (due === null) { if (w.undated) undated.push(`- ${t.description}`); }
    else if (due < today) { if (w.overdue) overdue.push(`- ${t.description} (was due ${short(due)})`); }
    else if (due >= w.from && due <= w.to) put(due, `- Reminder: ${t.description}`);
  }
  if (wantJobs && w.undated) {
    const { results } = await env.OFFICE_DB.prepare("SELECT js.description AS description, c.name AS customer_name FROM job_scopes js LEFT JOIN customers c ON c.id = js.customer_id WHERE js.scheduled_date IS NULL ORDER BY js.id DESC LIMIT 5").all<{ description: string; customer_name: string | null }>();
    for (const j of results ?? []) undated.push(`- ${j.description}${j.customer_name ? ` for ${j.customer_name}` : ""}`);
  }
  const blocks: string[] = [];
  if (overdue.length > 0) blocks.push(`Overdue:\n${overdue.join("\n")}`);
  const days = [...byDay.keys()].sort();
  for (const d of days) {
    const heading = w.days ? (d === today ? `Today, ${short(d)}` : d === iso(addDays(parseIso(today), 1)) ? `Tomorrow, ${short(d)}` : short(d)) : w.label;
    blocks.push(`${heading}:\n${byDay.get(d)!.join("\n")}`);
  }
  if (undated.length > 0) blocks.push(`Not yet scheduled:\n${undated.join("\n")}`);
  if (blocks.length === 0) return `${wantJobs && !wantTasks ? "No jobs" : wantTasks && !wantJobs ? "No tasks" : "Nothing"} scheduled ${w.empty.startsWith("in ") ? w.empty : `for ${w.empty}`}.`;
  return (w.days && days.length > 0 ? `${w.label}:\n\n` : "") + blocks.join("\n\n");
}

async function quotes(env: Env, q: string, customer: { id: number; name: string } | null): Promise<string> {
  const { items } = await quotesData(env, PAGE, NO_RANGE, customer?.id ?? null);
  const list = items as Array<{ customer_name: string | null; description: string; amount: number; status: string | null }>;
  if (customer) return list.length === 0 ? `${customer.name} has no quotes on file.` : `Quotes for ${customer.name}:\n${list.map((x) => `- ${x.description}, ${rand(x.amount)}${x.status === "converted" ? " (converted to an invoice)" : ""}`).join("\n")}`;
  const open = list.filter((x) => !["converted", "rejected", "declined", "void", "lost"].includes(String(x.status ?? "").toLowerCase()));
  return open.length === 0 ? "No open quotes." : `Open quotes:\n${open.map((x) => `- ${x.customer_name ?? "No customer"}: ${x.description}, ${rand(x.amount)}`).join("\n")}`;
}

async function stock(env: Env, q: string): Promise<string | null> {
  const { items } = await stockData(env, PAGE);
  const list = items as Array<{ name: string; unit: string | null; quantity_on_hand: number; reorder_threshold: number | null; below_reorder: boolean }>;
  const line = (s: (typeof list)[number]) => `${s.name}: ${s.quantity_on_hand} ${s.unit ?? ""}`.trim();
  const item = list.filter((s) => q.includes(s.name.toLowerCase())).sort((a, b) => b.name.length - a.name.length)[0];
  const stockWord = /\bstock\b|\bon hand\b/.test(q);
  if (item) return `${line(item)} on hand${item.below_reorder ? ` (at or below the reorder level of ${item.reorder_threshold})` : ""}.`;
  if (!stockWord) return null;
  return list.length === 0 ? "No stock items are being tracked." : `Stock on hand:\n${list.map((s) => `- ${line(s)}${s.below_reorder ? ` (at or below the reorder level of ${s.reorder_threshold})` : ""}`).join("\n")}`;
}

async function customerJobs(env: Env, customer: { id: number; name: string }, now: Date): Promise<string> {
  const today = iso(new Date(now.getFullYear(), now.getMonth(), now.getDate()));
  const { items } = await jobsData(env, PAGE, NO_RANGE, customer.id);
  const jobs = items as Array<{ description: string; scheduled_date: string | null }>;
  const lines = [...jobs.filter((j) => j.scheduled_date && j.scheduled_date.slice(0, 10) >= today).map((j) => `- ${j.description}: ${short(j.scheduled_date!.slice(0, 10))}`), ...jobs.filter((j) => !j.scheduled_date).map((j) => `- ${j.description}: not yet scheduled`)];
  return lines.length === 0 ? `${customer.name} has no upcoming jobs on file.` : `Jobs for ${customer.name}:\n${lines.join("\n")}`;
}

/** The answer for a read question from the OWNER, or null (the pipeline then handles the message exactly as before). Read only, no model call, never throws. */
export async function tryReadLayer(env: Env, text: string, who: { role: string | null }, now: Date = nowInBusinessTimezone()): Promise<ReadAnswer | null> {
  try {
    if (env.READ_LAYER === "off" || who.role !== "owner") return null;   // the MCP's list tools are owner only: so is this
    const q = normalise(text);
    if (q.length === 0 || q.length > 140 || q.split(" ").length > 16 || /\d/.test(q) || !STARTER.test(q)) return null;
    if (/^(?:what(?:'s| is) (?:today'?s|the) date(?: today)?|what date is it(?: today)?|what day is (?:it|today)|what(?:'s| is) today)$/.test(q)) return { kind: "date", message: `Today is ${DAYS[now.getDay()]} ${now.getDate()} ${MONTHS[now.getMonth()]} ${now.getFullYear()}.` };
    if (MONEY.test(q)) return null;
    const hasQuote = /\bquot(?:e|es|ations?)\b/.test(q);
    const customer = hasQuote || /\b(?:job|jobs|install|installation|scheduled|booked|when)\b/.test(q) ? await customerIn(env, q) : null;
    if (hasQuote) return { kind: "quotes", message: await quotes(env, q, customer) };
    if (/\bstock\b|\bon hand\b|\bhow many\b|\bhow much\b|\bdo we have\b|\bare there\b|\bleft\b/.test(q)) { const s = await stock(env, q); if (s !== null) return { kind: "stock", message: s }; }
    if (customer) return { kind: "customer_jobs", message: await customerJobs(env, customer, now) };
    if (SCHEDULE_WORD.test(q)) return { kind: "schedule", message: await schedule(env, q, now) };
    return null;
  } catch {
    return null;
  }
}
