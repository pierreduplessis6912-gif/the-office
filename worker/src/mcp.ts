// The read-only MCP endpoint: POST /mcp (MCP_ARCHITECTURE.md, "Decisions made, and the design"). A hand-written, minimal, STATELESS Streamable HTTP server: JSON-RPC 2.0 over POST, plain JSON replies, no stream held open, no session, no packages. It lets an outside assistant READ a business's figures as ONE member, and nothing else.
// THE RULES (each held by a test that fails if it is removed, tools/mcp-endpoint-breakage.js): (1) a key is the only way in: no key, a malformed key, a wrong, revoked or another business's key, an inactive member and a lapsed business are ALL the same 401, and a session alone is refused at the gate; (2) NOTHING here writes business data: the eleven tools only read (the first five through the same functions the routes use; the stage 1 lists, stock and document link are owner only, queries in mcp-reads.ts);
// (3) every tool is authorised by the SAME rule table as the route it mirrors, against the member's role NOW, and a tool the member may not use returns no data; (4) each key has a rate limit (30 a minute, 500 a day) and every tool call is audited ("via MCP, key <id>", the member, the tool, the outcome and the time: never the arguments or the result); (5) the kill switch (the Worker variable MCP set to "off") answers 503 before anything is read;
// (6) bounded: a request body over 64 KB, a batch, malformed JSON and an oversized result are refused. The protocol surface is: initialize, ping, notifications (202), tools/list and tools/call. Resources, prompts and sessions are not declared, so a client must not call them.
import { challengeHeader } from "./mcp-oauth";
import { businessLapsed } from "./access";
import { analysisData, parseAnalysisParams } from "./analysis";
import { ROUTE_RULES, signDocumentPath } from "./auth";
import { MAX_PAGE, customersData, documentExists, invoicesData, jobsData, parseId, parsePage, parseRange, parseSearch, quotesData, stockData } from "./mcp-reads";
import { parseHistoryParams, readHistory, resolveScope } from "./history";
import { bearerKey } from "./mcp-key-format";
import { CONFIRMABLE, findLink, linkHeld } from "./mcp-pending";
import { EDIT_KINDS, editCreated, scheduleJob } from "./mcp-changes";
import { TRACKED_TABLES, taggingEnv, type TagSink, type TrackedTable } from "./mcp-tags";
import { SCOPE_WRITE, authenticateKey, type McpScope } from "./mcp-keys";
import { agedDebtorsData, customerReceivablesData, parseCustomerParam, parsePeriodParams, profitAndLossData } from "./reports-data";
import type { Env } from "./types";

const PROTOCOLS = ["2025-06-18", "2025-03-26"];
const MAX_BODY_BYTES = 65_536;
const MAX_RESULT_CHARS = 200_000;
export const PER_MINUTE = 30;
export const PER_DAY = 500;
const INSTRUCTIONS = "Access to one business's figures in The Office, as the member this key was issued for. Amounts are in South African rand. Periods are by the date a record was entered. Figures marked calculated are arithmetic on the records, never a cause. Every tool only reads, except tell_the_office, which is listed only for a key that was given permission to create things: it records what you tell it the way the owner's own typed message would be recorded, and everything it creates is tagged with this key.";
export const CREATES_PER_HOUR = 20, CREATES_PER_DAY = 100, FLAG_OVER = 50_000;   // stage 2: caps on what a write key may create, and the invoice or quote amount above which a create is FLAGGED (never blocked)
const MAX_TELL_CHARS = 1000;

type Who = { keyId: string; email: string; role: string; capabilities: string[]; scope: McpScope };
/** What the Worker lends the endpoint: the same pipeline the owner's typed messages go through (index.ts). It is passed in, not imported, so this module never depends on the pipeline. */
export interface McpHost { act: (kind: "confirm" | "reject", actionId: number, who: { email: string }) => Promise<{ status: number; body: unknown }>; tell: (text: string, who: { email: string; capabilities: string[] }, sink: TagSink) => Promise<{ message: string; pendingActionIds: number[]; captureId: number | null }> }
type ToolOutput = { ok: true; data: unknown } | { ok: false; message: string; outcome: "invalid" | "not_found" | "error" | "limited" };
interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  needsWrite?: boolean;   // stage 2: only a key whose scope is mcp:write may see or call it, owner or not
  ownerOnly?: boolean;   // stage 1 tools: only the owner, whatever the route table says (the installer's own-jobs scoping is not reproduced here)
  route: { method: string; path: string } | null;   // the route whose authorization this tool mirrors; null = open to any active member (own history only)
  run: (env: Env, args: Record<string, unknown>, who: Who, origin: string, host: McpHost | null) => Promise<ToolOutput>;
}

const DATE = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "A date, YYYY-MM-DD." };
const bad = (message: string): ToolOutput => ({ ok: false, message, outcome: "invalid" });

// Only the listed arguments are accepted, and strings are read as strings: anything else is refused with a reason, never coerced.
function readArgs(args: Record<string, unknown>, allowed: string[], strings: string[]): { ok: true; q: URLSearchParams } | { ok: false; message: string } {
  for (const key of Object.keys(args)) if (!allowed.includes(key)) return { ok: false, message: `unknown argument: ${key.slice(0, 40)}` };
  const q = new URLSearchParams();
  for (const key of strings) {
    const value = args[key];
    if (value === undefined) continue;
    if (typeof value !== "string" || value.length > 40) return { ok: false, message: `${key} must be text.` };
    q.set(key, value);
  }
  return { ok: true, q };
}

const TOOLS: Tool[] = [
  {
    name: "get_profit_and_loss",
    description: "The profit and loss report as data: revenue, cost of sales, gross profit, operating expenses and net profit, with a category breakdown. Give from and to (YYYY-MM-DD) for a period, and compare_from and compare_to to compare it with another; leave all out for everything to date.",
    inputSchema: { type: "object", properties: { from: DATE, to: DATE, compare_from: DATE, compare_to: DATE }, additionalProperties: false },
    route: { method: "GET", path: "/reports/profit-and-loss" },
    async run(env, args) {
      const read = readArgs(args, ["from", "to", "compare_from", "compare_to"], ["from", "to", "compare_from", "compare_to"]);
      if (!read.ok) return bad(read.message);
      const parsed = parsePeriodParams(read.q);
      if (!parsed.ok) return bad(parsed.error);
      return { ok: true, data: await profitAndLossData(env, parsed) };
    },
  },
  {
    name: "get_aged_debtors",
    description: "Who owes the business money, by customer, in age buckets: current (up to 30 days), 30 to 60, 60 to 90 and over 90 days. Payments are applied to the oldest invoices first, not matched to invoices.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    route: { method: "GET", path: "/reports/aged-debtors" },
    async run(env, args) {
      const read = readArgs(args, [], []);
      if (!read.ok) return bad(read.message);
      return { ok: true, data: await agedDebtorsData(env) };
    },
  },
  {
    name: "get_customer_receivables",
    description: "One customer's outstanding invoices, oldest first, and how their payments were applied. What was applied and what is outstanding are CALCULATED: payments are recorded per customer and applied to the oldest invoices first, not matched to invoices. The customer_id comes from get_aged_debtors.",
    inputSchema: { type: "object", properties: { customer_id: { type: "integer", minimum: 1 } }, required: ["customer_id"], additionalProperties: false },
    route: { method: "GET", path: "/reports/aged-debtors" },
    async run(env, args) {
      for (const key of Object.keys(args)) if (key !== "customer_id") return bad(`unknown argument: ${key.slice(0, 40)}`);
      const id = args.customer_id;
      const parsed = parseCustomerParam(typeof id === "number" && Number.isSafeInteger(id) ? String(id) : null);
      if (!parsed.ok) return bad(parsed.error);
      const data = await customerReceivablesData(env, parsed.id);
      return data === null ? { ok: false, message: "That customer was not found.", outcome: "not_found" } : { ok: true, data };
    },
  },
  {
    name: "analyse",
    description: "WHY a figure changed between two periods, from the profit and loss report's own numbers: topic is revenue (by customer), expenses (by category) or profit. Every finding is a fact (read from a record) or calculated, never a cause; what cannot be known is listed. Give from and to; the comparison defaults to the previous period of the same length.",
    inputSchema: { type: "object", properties: { topic: { type: "string", enum: ["revenue", "expenses", "profit"] }, from: DATE, to: DATE, compare_from: DATE, compare_to: DATE }, required: ["topic", "from", "to"], additionalProperties: false },
    route: { method: "GET", path: "/reports/analysis" },
    async run(env, args) {
      const read = readArgs(args, ["topic", "from", "to", "compare_from", "compare_to"], ["topic", "from", "to", "compare_from", "compare_to"]);
      if (!read.ok) return bad(read.message);
      const parsed = parseAnalysisParams(read.q);
      if (!parsed.ok) return bad(parsed.error);
      return { ok: true, data: await analysisData(env, parsed.topic, { period: parsed.period, compare: parsed.compare }) };
    },
  },
  {
    name: "get_recent_history",
    description: "The member's own recent conversation turns with The Office, newest first: what was heard, what was said back, what was held, decided and written. Only this member's own turns.",
    inputSchema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 50, default: 10 } }, additionalProperties: false },
    route: null,
    async run(env, args, who) {
      for (const key of Object.keys(args)) if (key !== "limit") return bad(`unknown argument: ${key.slice(0, 40)}`);
      const limit = args.limit === undefined ? 10 : args.limit;
      if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) return bad("limit must be a whole number from 1 to 50.");
      const parsed = parseHistoryParams(new URLSearchParams({ who: "me", limit: String(limit) }));
      if (!parsed.ok) return bad(parsed.error);
      const scope = resolveScope(parsed.who, who.capabilities);
      if (!scope.ok) return bad(scope.error);
      return { ok: true, data: await readHistory(env, { scope: scope.scope, viewer: who.email, limit: parsed.limit, before: parsed.before }) };
    },
  },
];

const PAGE_PROPS = { limit: { type: "integer", minimum: 1, maximum: MAX_PAGE, default: 25 }, offset: { type: "integer", minimum: 0, default: 0 } };
const RANGE_PROPS = { from: DATE, to: DATE };
function listTool(name: string, description: string, extra: Record<string, unknown>, allowed: string[], read: (env: Env, args: Record<string, unknown>) => Promise<ToolOutput>): Tool {
  return { name, description, ownerOnly: true, route: null, inputSchema: { type: "object", properties: { ...extra, ...PAGE_PROPS }, additionalProperties: false },
    async run(env, args) { for (const key of Object.keys(args)) if (!allowed.includes(key)) return bad(`unknown argument: ${key.slice(0, 40)}`); return read(env, args); } };
}
const WIDER_TOOLS: Tool[] = [
  listTool("list_customers", "The business's customers (merged duplicates left out), by name. search matches the name or address.", { search: { type: "string", maxLength: 60 } }, ["search", "limit", "offset"], async (env, a) => {
    const p = parsePage(a), s = parseSearch(a.search); if (!p.ok) return bad(p.error); if (!s.ok) return bad(s.error);
    return { ok: true, data: await customersData(env, p.page, s.search) };
  }),
  listTool("list_jobs", "Jobs (job scopes) with their scheduled date, soonest first; undated jobs come last. from and to filter on the scheduled date.", { customer_id: { type: "integer", minimum: 1 }, ...RANGE_PROPS }, ["customer_id", "from", "to", "limit", "offset"], async (env, a) => {
    const p = parsePage(a), r = parseRange(a), c = parseId(a.customer_id, "customer_id"); if (!p.ok) return bad(p.error); if (!r.ok) return bad(r.error); if (!c.ok) return bad(c.error);
    return { ok: true, data: await jobsData(env, p.page, r.range, c.id) };
  }),
  listTool("list_invoices", "Invoices, newest first, with customer, amount, status and due date. from and to filter on the date entered. Not what is still owed: use get_customer_receivables for that.", { customer_id: { type: "integer", minimum: 1 }, ...RANGE_PROPS }, ["customer_id", "from", "to", "limit", "offset"], async (env, a) => {
    const p = parsePage(a), r = parseRange(a), c = parseId(a.customer_id, "customer_id"); if (!p.ok) return bad(p.error); if (!r.ok) return bad(r.error); if (!c.ok) return bad(c.error);
    return { ok: true, data: await invoicesData(env, p.page, r.range, c.id) };
  }),
  listTool("list_quotes", "Quotations, newest first, with customer, amount and status. from and to filter on the date entered.", { customer_id: { type: "integer", minimum: 1 }, ...RANGE_PROPS }, ["customer_id", "from", "to", "limit", "offset"], async (env, a) => {
    const p = parsePage(a), r = parseRange(a), c = parseId(a.customer_id, "customer_id"); if (!p.ok) return bad(p.error); if (!r.ok) return bad(r.error); if (!c.ok) return bad(c.error);
    return { ok: true, data: await quotesData(env, p.page, r.range, c.id) };
  }),
  listTool("get_stock", "Tracked stock: quantity on hand, unit and reorder threshold, with a flag for items at or below it.", {}, ["limit", "offset"], async (env, a) => {
    const p = parsePage(a); if (!p.ok) return bad(p.error);
    return { ok: true, data: await stockData(env, p.page) };
  }),
  {
    name: "get_document_link",
    description: "A short-lived link (10 minutes) to the PDF of one invoice, quotation or customer statement. kind is invoice, quote or statement; id is the invoice or quotation id, or the customer id for a statement. The link opens the document without signing in, so treat it like the document itself and do not share it.",
    inputSchema: { type: "object", properties: { kind: { type: "string", enum: ["invoice", "quote", "statement"] }, id: { type: "integer", minimum: 1 } }, required: ["kind", "id"], additionalProperties: false },
    ownerOnly: true,
    route: null,
    async run(env, args, _who, origin) {
      for (const key of Object.keys(args)) if (key !== "kind" && key !== "id") return bad(`unknown argument: ${key.slice(0, 40)}`);
      const kind = args.kind;
      if (kind !== "invoice" && kind !== "quote" && kind !== "statement") return bad("kind must be invoice, quote or statement.");
      const id = parseId(args.id, "id");
      if (!id.ok || id.id === null) return bad(id.ok ? "id is required." : id.error);
      if (!(await documentExists(env, kind, id.id))) return { ok: false, message: "That record was not found.", outcome: "not_found" };
      const path = kind === "invoice" ? `/invoices/${id.id}/pdf` : kind === "quote" ? `/quotations/${id.id}/pdf` : `/customers/${id.id}/statement/pdf`;
      const sig = await signDocumentPath(env, path, 10 * 60 * 1000);
      return { ok: true, data: { kind, id: id.id, url: `${origin}${path}?sig=${sig}`, expiresInMinutes: 10 } };
    },
  },
];
TOOLS.push(...WIDER_TOOLS);

// ---- stage 2: the one tool that creates things ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
async function ensureCreates(env: Env): Promise<void> {
  await env.OFFICE_DB.prepare("CREATE TABLE IF NOT EXISTS mcp_creates (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL DEFAULT (datetime('now')), key_id TEXT NOT NULL, email TEXT NOT NULL, capture_id INTEGER, created TEXT, flagged INTEGER NOT NULL DEFAULT 0, pending INTEGER NOT NULL DEFAULT 0)").run();
  await env.OFFICE_DB.prepare("CREATE INDEX IF NOT EXISTS idx_mcp_creates_key ON mcp_creates (key_id, created_at)").run();
}
async function ensureRecords(env: Env): Promise<void> {
  await ensureCreates(env);   // first, so the column added below has a table to be added to
  await env.OFFICE_DB.prepare("CREATE TABLE IF NOT EXISTS mcp_created_records (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL DEFAULT (datetime('now')), create_id INTEGER NOT NULL, key_id TEXT NOT NULL, tbl TEXT NOT NULL, rec_id INTEGER NOT NULL, undone_at TEXT, undone_by TEXT, snapshot TEXT, UNIQUE (tbl, rec_id))").run();
  await env.OFFICE_DB.prepare("CREATE INDEX IF NOT EXISTS idx_mcp_created_records_key ON mcp_created_records (key_id, created_at)").run();
  try { await env.OFFICE_DB.prepare("ALTER TABLE mcp_creates ADD COLUMN untraced INTEGER NOT NULL DEFAULT 0").run(); } catch { /* already there */ }
}
// Is any invoice, quote or payment this call recorded over the flag threshold? (flag only, never a block)
async function anyOverThreshold(env: Env, tagged: Array<{ table: TrackedTable; id: number }>): Promise<boolean> {
  for (const [table, name] of [["invoices", "invoices"], ["quotations", "quotations"], ["payments", "payments"]] as const) {
    const ids = tagged.filter((t) => t.table === name).map((t) => t.id).slice(0, 50);
    if (ids.length === 0) continue;
    try {
      const row = await env.OFFICE_DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE id IN (${ids.map(() => "?").join(",")}) AND amount > ?`).bind(...ids, FLAG_OVER).first<{ n: number }>();
      if ((row?.n ?? 0) > 0) return true;
    } catch { /* a table this business does not have yet */ }
  }
  return false;
}
/** Every WRITE a key makes (telling the Office, scheduling, editing) is counted here BEFORE it runs, against the same limits: 20 an hour and 100 a day per key. Over the limit nothing runs. */
async function reserveWrite(env: Env, who: Who): Promise<{ ok: true; slotId: number } | { ok: false; refusal: ToolOutput }> {
  await ensureCreates(env);
  const hour = await env.OFFICE_DB.prepare("SELECT COUNT(*) AS n FROM mcp_creates WHERE key_id = ? AND created_at >= datetime('now', '-1 hour')").bind(who.keyId).first<{ n: number }>();
  const day = await env.OFFICE_DB.prepare("SELECT COUNT(*) AS n FROM mcp_creates WHERE key_id = ? AND created_at >= datetime('now', '-1 day')").bind(who.keyId).first<{ n: number }>();
  if ((hour?.n ?? 0) >= CREATES_PER_HOUR || (day?.n ?? 0) >= CREATES_PER_DAY) return { ok: false, refusal: { ok: false, message: `This key has reached its limit for making changes (${CREATES_PER_HOUR} an hour, ${CREATES_PER_DAY} a day). Nothing was recorded. Try later.`, outcome: "limited" } };
  const slot = await env.OFFICE_DB.prepare("INSERT INTO mcp_creates (key_id, email) VALUES (?, ?) RETURNING id").bind(who.keyId, who.email).first<{ id: number }>();
  return { ok: true, slotId: slot?.id ?? 0 };
}
const tellTool: Tool = {
  name: "tell_the_office",
  description: "Tell The Office something to record, in plain words, exactly as the owner would type it: an invoice, a quote, a job, an expense, a task. It goes through the same checks as a typed message. It creates only; it deletes nothing and moves no money. If it needs an answer (which customer, which project) it says so and the owner answers in the app. Everything it creates (invoices, quotes, jobs, expenses, tasks and payments received) is tagged with this key and the owner can undo it in the app, and there is a limit on how many times it can be used an hour and a day.",
  inputSchema: { type: "object", properties: { text: { type: "string", minLength: 1, maxLength: MAX_TELL_CHARS } }, required: ["text"], additionalProperties: false },
  needsWrite: true, ownerOnly: true, route: null,
  async run(env, args, who, _origin, host) {
    for (const key of Object.keys(args)) if (key !== "text") return bad(`unknown argument: ${key.slice(0, 40)}`);
    const text = typeof args.text === "string" ? args.text.trim() : "";
    if (text.length < 1 || text.length > MAX_TELL_CHARS || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) return bad(`text must be 1 to ${MAX_TELL_CHARS} characters of plain text.`);
    if (host === null) return { ok: false, message: "Creating is not available here.", outcome: "error" };
    await ensureRecords(env);
    const reserved = await reserveWrite(env, who);
    if (!reserved.ok) return reserved.refusal;
    const slot = { id: reserved.slotId };
    const tagged: Array<{ table: TrackedTable; id: number }> = []; let untraced = 0;
    const sink: TagSink = { record: (table, id) => { if (TRACKED_TABLES.includes(table) && !tagged.some((t) => t.table === table && t.id === id)) tagged.push({ table, id }); }, untraced: () => { untraced++; } };
    let told: { message: string; pendingActionIds: number[]; captureId: number | null };
    try { told = await host.tell(text, { email: who.email, capabilities: who.capabilities }, sink); } catch { return { ok: false, message: "That could not be recorded.", outcome: "error" }; }
    const created: Record<string, number[]> = {};
    for (const t of tagged) (created[t.table] ??= []).push(t.id);
    const flagged = await anyOverThreshold(env, tagged);
    const pending = told.pendingActionIds.length;
    const held = await linkHeld(env, who.keyId, slot?.id ?? 0, told.pendingActionIds);
    const confirmable = held.filter((h) => h.canConfirmHere).length;
    try { await env.OFFICE_DB.prepare("UPDATE mcp_creates SET capture_id = ?, created = ?, flagged = ?, pending = ?, untraced = ? WHERE id = ?").bind(told.captureId, JSON.stringify(created), flagged ? 1 : 0, pending, untraced, slot?.id ?? 0).run();
      for (const t of tagged) await env.OFFICE_DB.prepare("INSERT OR IGNORE INTO mcp_created_records (create_id, key_id, tbl, rec_id) VALUES (?, ?, ?, ?)").bind(slot?.id ?? 0, who.keyId, t.table, t.id).run();
    } catch { /* the tag never undoes the create */ }
    return { ok: true, data: { message: told.message.slice(0, 2000), created, needsAnswerInApp: Math.max(0, pending - confirmable), ...(held.length > 0 ? { held, holdNote: held.some((h) => h.canConfirmHere) ? "These were HELD for confirmation, not recorded yet. Confirm one with confirm_pending_action (or reject it with reject_pending_action) using its actionId, or confirm it in the app." : "These were HELD and need an answer in the app." } : {}), flagged, ...(untraced > 0 ? { untracedNote: "Something this call recorded could not be tagged, so undoing it in the app may be incomplete." } : {}), ...(flagged ? { flagNote: `An invoice or quote above R${FLAG_OVER.toLocaleString("en-ZA")} was created. It was recorded, and the owner can see it flagged.` } : {}), taggedWithKey: who.keyId } };
  },
};
TOOLS.push(tellTool);

const jobId = { type: "integer", minimum: 1, description: "The job's id, from list_jobs." };
const scheduleTool: Tool = {
  name: "schedule_job",
  description: "Schedule a job (a job scope from list_jobs) for a date, today or later. It changes only the date, and the owner can revert it in the app. There is a limit on how many changes a key can make an hour and a day.",
  inputSchema: { type: "object", properties: { job_id: jobId, date: DATE }, required: ["job_id", "date"], additionalProperties: false },
  needsWrite: true, ownerOnly: true, route: null,
  async run(env, args, who) {
    for (const key of Object.keys(args)) if (key !== "job_id" && key !== "date") return bad(`unknown argument: ${key.slice(0, 40)}`);
    if (typeof args.job_id !== "number" || typeof args.date !== "string") return bad("job_id must be a whole number and date a YYYY-MM-DD text.");
    const reserved = await reserveWrite(env, who);
    if (!reserved.ok) return reserved.refusal;
    return scheduleJob(env, who.keyId, { job_id: args.job_id, date: args.date });
  },
};
const editTool: Tool = {
  name: "edit_created_record",
  description: "Change a record that a connected assistant created (it must have been created through a connection, and still be untouched): an invoice's or quote's description or amount, an expense's description, amount or category, a task's description or done, a job's description. Give the kind, the id and only the fields to change. Anything the owner made in the app can only be changed in the app. The owner can revert each change in the app, and there is a limit on how many changes a key can make an hour and a day.",
  inputSchema: { type: "object", properties: { kind: { type: "string", enum: EDIT_KINDS }, id: { type: "integer", minimum: 1 }, changes: { type: "object", properties: { description: { type: "string", maxLength: 500 }, amount: { type: "number", exclusiveMinimum: 0, maximum: 100000000 }, category: { type: "string", maxLength: 60 }, done: { type: "boolean" } }, additionalProperties: false, minProperties: 1 } }, required: ["kind", "id", "changes"], additionalProperties: false },
  needsWrite: true, ownerOnly: true, route: null,
  async run(env, args, who) {
    for (const key of Object.keys(args)) if (key !== "kind" && key !== "id" && key !== "changes") return bad(`unknown argument: ${key.slice(0, 40)}`);
    const reserved = await reserveWrite(env, who);
    if (!reserved.ok) return reserved.refusal;
    return editCreated(env, who.keyId, { kind: args.kind, id: args.id, changes: args.changes }, FLAG_OVER);
  },
};
TOOLS.push(scheduleTool, editTool);

const actionId = { type: "integer", minimum: 1, description: "The actionId of a held action that tell_the_office returned." };
async function decideHeld(kind: "confirm" | "reject", env: Env, args: Record<string, unknown>, who: Who, host: McpHost | null): Promise<ToolOutput> {
  for (const key of Object.keys(args)) if (key !== "action_id") return bad(`unknown argument: ${key.slice(0, 40)}`);
  if (typeof args.action_id !== "number" || !Number.isInteger(args.action_id) || args.action_id < 1) return bad("action_id must be a whole number.");
  if (host === null) return { ok: false, message: "That is not available here.", outcome: "error" };
  await ensureRecords(env);
  const reserved = await reserveWrite(env, who);
  if (!reserved.ok) return reserved.refusal;
  const id = args.action_id;
  // Only an action THIS key proposed, still waiting, of a kind that needs only a yes.
  const link = await findLink(env, id);
  if (!link || link.key_id !== who.keyId) return { ok: false, message: "That action was not held by this connection, so it can only be decided in the app.", outcome: "not_found" };
  if (!CONFIRMABLE.has(link.type)) return { ok: false, message: "That action needs an answer, not just a yes, so it can only be decided in the app.", outcome: "invalid" };
  let result: { status: number; body: unknown };
  try { result = await host.act(kind, id, { email: who.email }); } catch { return { ok: false, message: `That could not be ${kind === "confirm" ? "confirmed" : "rejected"}.`, outcome: "error" }; }
  const reason = typeof (result.body as { error?: unknown } | null)?.error === "string" ? String((result.body as { error: string }).error).slice(0, 200) : null;
  if (result.status < 200 || result.status >= 300) return { ok: false, message: reason ?? `That could not be ${kind === "confirm" ? "confirmed" : "rejected"}.`, outcome: "error" };
  try { await env.OFFICE_DB.prepare("UPDATE mcp_pending_links SET resolved_by = 'claude' WHERE pending_id = ? AND resolved_by = 'app'").bind(id).run(); } catch { /* a label only */ }
  if (kind === "reject") return { ok: true, data: { actionId: id, status: "rejected" } };
  const made = await env.OFFICE_DB.prepare("SELECT tbl, rec_id FROM mcp_created_records WHERE create_id = ? AND key_id = ?").bind(link.create_id, who.keyId).all<{ tbl: string; rec_id: number }>().catch(() => ({ results: [] as Array<{ tbl: string; rec_id: number }> }));
  const created: Record<string, number[]> = {}; const tagged: Array<{ table: TrackedTable; id: number }> = [];
  for (const r of made.results) { (created[r.tbl] ??= []).push(r.rec_id); tagged.push({ table: r.tbl as TrackedTable, id: r.rec_id }); }
  const flagged = await anyOverThreshold(env, tagged);
  return { ok: true, data: { actionId: id, status: "confirmed", created, flagged, ...(flagged ? { flagNote: `An amount above R${FLAG_OVER.toLocaleString("en-ZA")} was recorded. It was recorded, and the owner can see it flagged.` } : {}), note: "The owner can undo this in the app." } };
}
const confirmTool: Tool = {
  name: "confirm_pending_action",
  description: "Confirm a held action that this connection proposed through tell_the_office (an expense, payment, invoice or quote waiting for a yes). It becomes a real record, tagged with this key, and the owner can undo it in the app. Only an action this connection proposed, still waiting, can be confirmed here; anything that needs an answer is decided in the app. It counts against the key's limit like any change.",
  inputSchema: { type: "object", properties: { action_id: actionId }, required: ["action_id"], additionalProperties: false },
  needsWrite: true, ownerOnly: true, route: null,
  run: (env, args, who, _origin, host) => decideHeld("confirm", env, args, who, host),
};
const rejectTool: Tool = {
  name: "reject_pending_action",
  description: "Reject a held action that this connection proposed through tell_the_office, so it is never recorded. Only an action this connection proposed, still waiting, can be rejected here.",
  inputSchema: { type: "object", properties: { action_id: actionId }, required: ["action_id"], additionalProperties: false },
  needsWrite: true, ownerOnly: true, route: null,
  run: (env, args, who, _origin, host) => decideHeld("reject", env, args, who, host),
};
TOOLS.push(confirmTool, rejectTool);

// A tool may be used only as the gate would let this member use the route it mirrors (auth.ts, authorizeRestrictedMember): the OWNER is always allowed, any other role only through a rule in the very table the gate uses, and no rule is no access (that is how the report routes are "owner only"). The history tool mirrors no route because every active member may read their own turns.
function permitted(tool: Tool, who: { role: string; capabilities: string[]; scope: McpScope }): boolean {
  if (tool.needsWrite && who.scope !== SCOPE_WRITE) return false;   // a read key never sees or runs a creating tool, whoever the member is
  if (who.role === "owner") return true;
  if (tool.ownerOnly) return false;
  if (tool.route === null) return true;
  const { method, path } = tool.route;
  const rule = ROUTE_RULES.find((r) => r.method === method && r.path.test(path));
  return rule !== undefined && rule.anyOf.some((c) => who.capabilities.includes(c));
}

// ---- the audit and the limit: one table ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
async function ensureCalls(env: Env): Promise<void> {
  await env.OFFICE_DB.prepare("CREATE TABLE IF NOT EXISTS mcp_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL DEFAULT (datetime('now')), key_id TEXT NOT NULL, email TEXT NOT NULL, tool TEXT NOT NULL, outcome TEXT NOT NULL, ms INTEGER NOT NULL DEFAULT 0)").run();
  await env.OFFICE_DB.prepare("CREATE INDEX IF NOT EXISTS idx_mcp_calls_key ON mcp_calls (key_id, created_at)").run();
}
async function overLimit(env: Env, keyId: string): Promise<boolean> {
  const minute = await env.OFFICE_DB.prepare("SELECT COUNT(*) AS n FROM mcp_calls WHERE key_id = ? AND created_at >= datetime('now', '-1 minute')").bind(keyId).first<{ n: number }>();
  if ((minute?.n ?? 0) >= PER_MINUTE) return true;
  const day = await env.OFFICE_DB.prepare("SELECT COUNT(*) AS n FROM mcp_calls WHERE key_id = ? AND created_at >= datetime('now', '-1 day')").bind(keyId).first<{ n: number }>();
  return (day?.n ?? 0) >= PER_DAY;
}
async function audit(env: Env, who: Who, tool: string, outcome: string, ms: number): Promise<void> {
  try {
    await env.OFFICE_DB.prepare("INSERT INTO mcp_calls (key_id, email, tool, outcome, ms) VALUES (?, ?, ?, ?, ?)").bind(who.keyId, who.email, tool.slice(0, 60), outcome, ms).run();
    await env.OFFICE_DB.prepare("DELETE FROM mcp_calls WHERE created_at < datetime('now', '-90 days')").run();
  } catch { /* the record of a call never refuses it */ }
}

// ---- JSON-RPC --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
const JSON_HEADERS = { "Content-Type": "application/json", "Cache-Control": "no-store" };
const reply = (id: unknown, result: unknown): Response => Response.json({ jsonrpc: "2.0", id, result }, { headers: JSON_HEADERS });
const failure = (id: unknown, code: number, message: string, status = 200): Response => Response.json({ jsonrpc: "2.0", id, error: { code, message } }, { status, headers: JSON_HEADERS });
const unauthorized = (request: Request): Response => Response.json({ error: "unauthorized" }, { status: 401, headers: { "WWW-Authenticate": challengeHeader(new URL(request.url).origin), "Cache-Control": "no-store" } });

/** Answers one MCP request. The key is verified here on EVERY call; the gate in auth.ts has only checked that one was presented. */
export async function handleMcp(request: Request, env: Env, host: McpHost | null = null): Promise<Response> {
  if (env.MCP === "off") return Response.json({ error: "MCP is switched off." }, { status: 503, headers: { "Cache-Control": "no-store" } });
  const auth = await authenticateKey(env, bearerKey(request));
  if (!auth.ok) return unauthorized(request);   // the reason is for the audit: a caller only ever learns "unauthorized"
  if (await businessLapsed(env)) return unauthorized(request);
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST", "Cache-Control": "no-store" } });
  const origin = new URL(request.url).origin;
  const who: Who = { keyId: auth.keyId, email: auth.email, role: auth.role, capabilities: auth.capabilities, scope: auth.scope };

  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) return failure(null, -32600, "The request is too large.", 413);
  let message: unknown;
  try { message = JSON.parse(text); } catch { return failure(null, -32700, "Parse error.", 400); }
  if (Array.isArray(message)) return failure(null, -32600, "Batches are not supported.", 400);
  if (typeof message !== "object" || message === null) return failure(null, -32600, "Invalid request.", 400);
  const m = message as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
  if (m.jsonrpc !== "2.0" || typeof m.method !== "string") return failure(typeof m.id === "string" || typeof m.id === "number" ? m.id : null, -32600, "Invalid request.", 400);
  const hasId = "id" in m && (typeof m.id === "string" || typeof m.id === "number");
  if (!hasId) return new Response(null, { status: 202, headers: { "Cache-Control": "no-store" } });   // a notification (initialized, cancelled and the like): no answer
  const id = m.id;
  const params = typeof m.params === "object" && m.params !== null && !Array.isArray(m.params) ? (m.params as Record<string, unknown>) : {};

  if (m.method === "initialize") {
    const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
    return reply(id, { protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0], capabilities: { tools: { listChanged: false } }, serverInfo: { name: "The Office", version: "1" }, instructions: INSTRUCTIONS });
  }
  if (m.method === "ping") return reply(id, {});
  if (m.method === "tools/list") {
    return reply(id, { tools: TOOLS.filter((t) => permitted(t, who)).map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, annotations: { readOnlyHint: !t.needsWrite, destructiveHint: false, idempotentHint: !t.needsWrite, openWorldHint: false } })) });
  }
  if (m.method === "tools/call") {
    const name = typeof params.name === "string" ? params.name : "";
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) return failure(id, -32602, "Unknown tool.");
    const args = params.arguments === undefined ? {} : params.arguments;
    if (typeof args !== "object" || args === null || Array.isArray(args)) return failure(id, -32602, "arguments must be an object.");
    await ensureCalls(env);
    if (await overLimit(env, who.keyId)) return Response.json({ error: "Too many calls. Try again shortly." }, { status: 429, headers: { "Retry-After": "60", "Cache-Control": "no-store" } });
    const started = Date.now();
    let outcome = "ok";
    let content: { type: "text"; text: string }[];
    let isError = false;
    if (!permitted(tool, who)) {
      outcome = "denied"; isError = true; content = [{ type: "text", text: "That is restricted for this member's role." }];
    } else {
      let out: ToolOutput;
      try { out = await tool.run(env, args as Record<string, unknown>, who, origin, host); } catch { out = { ok: false, message: "That could not be built.", outcome: "error" }; }
      if (out.ok) {
        const body = JSON.stringify(out.data);
        if (body.length > MAX_RESULT_CHARS) { outcome = "error"; isError = true; content = [{ type: "text", text: "That result is too large to return." }]; }
        else content = [{ type: "text", text: body }];
      } else { outcome = out.outcome; isError = true; content = [{ type: "text", text: out.message }]; }
    }
    await audit(env, who, tool.name, outcome, Date.now() - started);
    return reply(id, { content, isError });
  }
  return failure(id, -32601, "Method not found.");
}

/** The tool names and the routes they mirror, for the tests that hold them to the rule table. */
export const TOOL_ROUTES = TOOLS.map((t) => ({ name: t.name, route: t.route }));
