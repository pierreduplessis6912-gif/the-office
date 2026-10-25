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
import { authenticateKey } from "./mcp-keys";
import { agedDebtorsData, customerReceivablesData, parseCustomerParam, parsePeriodParams, profitAndLossData } from "./reports-data";
import type { Env } from "./types";

const PROTOCOLS = ["2025-06-18", "2025-03-26"];
const MAX_BODY_BYTES = 65_536;
const MAX_RESULT_CHARS = 200_000;
export const PER_MINUTE = 30;
export const PER_DAY = 500;
const INSTRUCTIONS = "Read-only access to one business's figures in The Office, as the member this key was issued for. Amounts are in South African rand. Periods are by the date a record was entered. Figures marked calculated are arithmetic on the records, never a cause. Nothing here can change anything.";

type Who = { keyId: string; email: string; role: string; capabilities: string[] };
type ToolOutput = { ok: true; data: unknown } | { ok: false; message: string; outcome: "invalid" | "not_found" | "error" };
interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  ownerOnly?: boolean;   // stage 1 tools: only the owner, whatever the route table says (the installer's own-jobs scoping is not reproduced here)
  route: { method: string; path: string } | null;   // the route whose authorization this tool mirrors; null = open to any active member (own history only)
  run: (env: Env, args: Record<string, unknown>, who: Who, origin: string) => Promise<ToolOutput>;
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

// A tool may be used only as the gate would let this member use the route it mirrors (auth.ts, authorizeRestrictedMember): the OWNER is always allowed, any other role only through a rule in the very table the gate uses, and no rule is no access (that is how the report routes are "owner only"). The history tool mirrors no route because every active member may read their own turns.
function permitted(tool: Tool, who: { role: string; capabilities: string[] }): boolean {
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
export async function handleMcp(request: Request, env: Env): Promise<Response> {
  if (env.MCP === "off") return Response.json({ error: "MCP is switched off." }, { status: 503, headers: { "Cache-Control": "no-store" } });
  const auth = await authenticateKey(env, bearerKey(request));
  if (!auth.ok) return unauthorized(request);   // the reason is for the audit: a caller only ever learns "unauthorized"
  if (await businessLapsed(env)) return unauthorized(request);
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST", "Cache-Control": "no-store" } });
  const origin = new URL(request.url).origin;
  const who: Who = { keyId: auth.keyId, email: auth.email, role: auth.role, capabilities: auth.capabilities };

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
    return reply(id, { tools: TOOLS.filter((t) => permitted(t, who)).map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } })) });
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
      try { out = await tool.run(env, args as Record<string, unknown>, who, origin); } catch { out = { ok: false, message: "That could not be built.", outcome: "error" }; }
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
