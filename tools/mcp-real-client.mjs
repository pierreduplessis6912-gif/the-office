// A REAL MCP client (the official SDK, not hand-written requests) against the read-only endpoint (worker/src/mcp.ts; MCP_ARCHITECTURE.md).
// Run by the staging rehearsal against the real staging objects. Usage: BASE=https://host KEY=omk... OUT=file.json node tools/mcp-real-client.mjs
// Only true or false is written to OUT (never the key, never a figure); the script exits 0 even when a check fails, so the rehearsal's verdict decides.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { writeFileSync } from "node:fs";

const { BASE, KEY, OUT } = process.env;
const r = { connected: false, server_named: false, tools_listed: false, tool_names_match: false, debtors_read: false, profit_and_loss_read: false, unknown_tool_refused: false, bad_key_refused: false, closed_cleanly: false };
const EXPECTED = ["get_profit_and_loss", "get_aged_debtors", "get_customer_receivables", "analyse", "get_recent_history", "list_customers", "list_jobs", "list_invoices", "list_quotes", "get_stock", "get_document_link", "list_expenses", "list_payments", "list_held_actions"];
const open = async (key) => {
  const client = new Client({ name: "office-rehearsal-client", version: "1" });
  const transport = new StreamableHTTPClientTransport(new URL(BASE.replace(/\/$/, "") + "/mcp"), { requestInit: { headers: { Authorization: "Bearer " + key } } });
  await client.connect(transport);
  return client;
};
const body = (res) => { try { return JSON.parse(res.content[0].text); } catch { return {}; } };
const step = async (name, fn) => { try { await fn(); } catch { /* the check stays false */ } };

let client;
await step("connect", async () => { client = await open(KEY); r.connected = true; r.server_named = (client.getServerVersion() || {}).name === "The Office"; });
if (client) {
  await step("list", async () => { const t = await client.listTools(); r.tools_listed = t.tools.length > 0; r.tool_names_match = JSON.stringify(t.tools.map((x) => x.name)) === JSON.stringify(EXPECTED); });
  await step("debtors", async () => { const x = await client.callTool({ name: "get_aged_debtors", arguments: {} }); r.debtors_read = x.isError !== true && body(x).report === "aged_debtors"; });
  await step("pl", async () => { const x = await client.callTool({ name: "get_profit_and_loss", arguments: { from: "2026-10-01", to: "2026-10-31" } }); r.profit_and_loss_read = x.isError !== true && body(x).report === "profit_and_loss"; });
  await step("unknown", async () => { try { const x = await client.callTool({ name: "erase_everything", arguments: {} }); r.unknown_tool_refused = x.isError === true; } catch { r.unknown_tool_refused = true; } });
  await step("close", async () => { await client.close(); r.closed_cleanly = true; });
}
await step("bad", async () => { try { const c = await open("omk.rehearsal.0123456789abcdef.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"); await c.close(); r.bad_key_refused = false; } catch { r.bad_key_refused = true; } });
writeFileSync(OUT, JSON.stringify(r));
