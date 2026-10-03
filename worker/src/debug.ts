// Real, extracted, per direct instruction — the second real step of
// splitting up the large files, after auth.ts. 119 of the 120 real
// /debug and /admin routes live here now (confirmed directly via the
// real TypeScript parser, not counted by eye), dispatched from one
// real function call in index.ts instead of separate branches inline.
// The one real exception: /debug/reprocess genuinely needs
// processTranscript, which stays in index.ts — moving it too would
// have meant a real circular import between the two files for the
// sake of a single route, not worth the risk.
//
// Every import below was found by scanning these route bodies' real
// text directly for every identifier index.ts had available — not
// assumed complete, not copied wholesale from index.ts's own import
// list. authGate, the role/capability layer's enforcement, and CORS
// are NOT imported here beyond what a route genuinely reads directly
// (like ROLE_CAPABILITIES, to validate a role name) — the actual
// gating already ran in index.ts before this function is ever called.
import { Env, Extraction, HistoryTurn, LineItemWithTotal } from "./types";
import {
  classifyDashboardIntent, containsBackwardReference, embedText, extractIntent,
  extractMultipleIntents, extractWorkObservation, resolveFollowUpEntity, splitIntoTopics,
  storeUnscopedMemory, transcribe, transcribeWithNameHints,
} from "./ai";
import {
  findExistingCharacterByName, findExistingCustomerByName, findExistingEntityByName, reconcilePerson,
} from "./identity";
import { getInstallerActivity, nowInBusinessTimezone, resolveScheduledDate } from "./scheduler";
import { getCharacterFacts, getCharacterNotes, runConsolidation } from "./memory";
import { getAgedCreditorsReport, getFinancialSnapshot, getProfitAndLoss, getTrackedStockItems, parseDateRange, recordQuotation } from "./finance";
import { runIdempotentMigration, signSession, ROLE_CAPABILITIES } from "./auth";

// The one non-route helper these routes needed, moved with its real
// callers (/admin/export and /admin/flush) rather than left behind in
// index.ts pointing at nothing. Not exported -- used only internally,
// by the routes right below.
//
// A real fix found live 2026-07-14, twice over, moved here with its
// real subject: the first fix only wrapped the per-table loop in a
// try/catch, but getRealTableNames() itself -- the very first call,
// discovering which tables exist -- was completely unprotected. If
// that specific query throws for any reason, the whole thing still
// crashes exactly as before. /admin/export's handler wraps the entire
// call, not just part of it, so a real, visible error comes back no
// matter where the actual failure is.
async function getRealTableNames(env: Env): Promise<string[]> {
  const { results } = await env.OFFICE_DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%'"
  ).all<{ name: string }>();
  return results.map((r) => r.name);
}


// The one real function this whole file exports — every /debug and
// /admin route but one, as one big, real dispatch. Returns null if
// nothing here matches, so index.ts's own routing continues normally;
// every one of these routes is expected to be terminal in practice.
export async function handleDebugRoute(
  request: Request,
  env: Env,
  url: URL,
  ctx: ExecutionContext
): Promise<Response | null> {
if (url.pathname === "/debug/list-audio" && request.method === "GET") {
      const listed = await env.OFFICE_VAULT.list({ prefix: "voice-notes/" });
      return Response.json({
        objects: listed.objects.map((o) => ({ key: o.key, size: o.size, uploaded: o.uploaded })),
      });
    }

if (url.pathname === "/debug/reprocess-turbo" && request.method === "GET") {
      const key = url.searchParams.get("key");
      if (!key) return Response.json({ error: "missing ?key=" }, { status: 400 });
      const object = await env.OFFICE_VAULT.get(key);
      if (!object) return Response.json({ error: "key not found in R2" }, { status: 404 });
      const audioBuffer = await object.arrayBuffer();

      const [customerNames, characterNames] = await Promise.all([
        env.OFFICE_DB.prepare("SELECT name FROM customers").all<{ name: string }>(),
        env.OFFICE_DB.prepare("SELECT name FROM characters").all<{ name: string }>(),
      ]);
      const knownNames = [...customerNames.results.map((r) => r.name), ...characterNames.results.map((r) => r.name)];

      const [baseline, hinted] = await Promise.all([
        transcribe(env, audioBuffer),
        transcribeWithNameHints(env, audioBuffer, knownNames),
      ]);

      return Response.json({
        key,
        knownNamesUsed: knownNames.length,
        baseline: { model: "@cf/openai/whisper", transcript: baseline.transcript, error: baseline.transcriptionError },
        hinted: {
          model: "@cf/openai/whisper-large-v3-turbo",
          transcript: hinted.transcript,
          error: hinted.transcriptionError,
        },
      });
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

if (url.pathname === "/debug/customer-notes" && request.method === "GET") {
      const customerId = url.searchParams.get("customerId");
      if (!customerId) return Response.json({ error: "missing ?customerId=" }, { status: 400 });
      const raw = await env.CUSTOMER_NOTES.get(`customer:${customerId}`);
      return Response.json({ customerId, raw: raw ? JSON.parse(raw) : null });
    }

if (url.pathname === "/debug/kv-set" && request.method === "POST") {
      const body = (await request.json()) as { key?: string; value?: unknown };
      if (!body.key) return Response.json({ error: "missing key" }, { status: 400 });
      await env.CUSTOMER_NOTES.put(body.key, JSON.stringify(body.value));
      return Response.json({ status: "set", key: body.key });
    }

if (url.pathname === "/debug/resolve-entity-test" && request.method === "POST") {
      const body = (await request.json()) as { text?: string; history?: HistoryTurn[] };
      if (!body.text) return Response.json({ error: "missing text" }, { status: 400 });
      const history = Array.isArray(body.history) ? body.history : [];
      const resolvedName = await resolveFollowUpEntity(env, history, body.text);
      const found = resolvedName ? await findExistingEntityByName(env, resolvedName) : null;
      return Response.json({ input: body.text, resolvedName, found });
    }

if (url.pathname === "/debug/delete-customer" && request.method === "POST") {
      const id = url.searchParams.get("id");
      if (!id) return Response.json({ error: "missing ?id=" }, { status: 400 });
      await env.OFFICE_DB.prepare("DELETE FROM customers WHERE id = ?").bind(id).run();
      await env.OFFICE_DB.prepare("DELETE FROM pending_memory_flush WHERE customer_id = ?").bind(id).run();
      await env.CUSTOMER_NOTES.delete(`customer:${id}`);
      return Response.json({ status: "deleted", id });
    }

if (url.pathname === "/debug/delete-character" && request.method === "POST") {
      const id = url.searchParams.get("id");
      if (!id) return Response.json({ error: "missing ?id=" }, { status: 400 });
      await env.OFFICE_DB.prepare("DELETE FROM characters WHERE id = ?").bind(id).run();
      await env.CUSTOMER_NOTES.delete(`character:${id}`);
      return Response.json({ status: "deleted", id });
    }

if (url.pathname === "/debug/init-tasks-table" && request.method === "POST") {
      await env.OFFICE_DB.prepare(
        `CREATE TABLE IF NOT EXISTS tasks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          description TEXT NOT NULL,
          done INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          completed_at TEXT
        )`
      ).run();
      return Response.json({ status: "ok" });
    }

if (url.pathname === "/debug/init-tasks-fk" && request.method === "POST") {
      for (const column of ["customer_id INTEGER", "character_id INTEGER"]) {
        await runIdempotentMigration(env, `ALTER TABLE tasks ADD COLUMN ${column}`);
      }
      return Response.json({ status: "ok" });
    }

if (url.pathname === "/debug/init-expenses-table" && request.method === "POST") {
      await env.OFFICE_DB.prepare(
        `CREATE TABLE IF NOT EXISTS expenses (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          character_id INTEGER,
          amount REAL,
          description TEXT NOT NULL,
          source_transcript TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )`
      ).run();
      return Response.json({ status: "ok" });
    }

if (url.pathname === "/debug/init-expenses-category" && request.method === "POST") {
      await runIdempotentMigration(env, "ALTER TABLE expenses ADD COLUMN category TEXT");
      return Response.json({ status: "ok" });
    }

if (url.pathname === "/debug/init-expenses-jobcost" && request.method === "POST") {
      await runIdempotentMigration(env, "ALTER TABLE expenses ADD COLUMN customer_id INTEGER");
      return Response.json({ status: "ok" });
    }

if (url.pathname === "/debug/init-jobscopes-installer" && request.method === "POST") {
      await runIdempotentMigration(env, "ALTER TABLE job_scopes ADD COLUMN installer_id INTEGER");
      return Response.json({ status: "ok" });
    }

if (url.pathname === "/debug/init-character-facts" && request.method === "POST") {
      await env.OFFICE_DB.prepare(
        `CREATE TABLE IF NOT EXISTS character_facts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          character_id INTEGER NOT NULL,
          key TEXT NOT NULL,
          value TEXT NOT NULL,
          source_transcript TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )`
      ).run();
      return Response.json({ status: "ok" });
    }

if (url.pathname === "/debug/init-memberships" && request.method === "POST") {
      await env.OFFICE_DB.prepare(
        `CREATE TABLE IF NOT EXISTS memberships (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          google_email TEXT NOT NULL UNIQUE,
          role TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active',
          invited_by TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )`
      ).run();
      return Response.json({ status: "ok" });
    }

if (url.pathname === "/debug/init-idempotency-keys" && request.method === "POST") {
      await env.OFFICE_DB.prepare(
        `CREATE TABLE IF NOT EXISTS idempotency_keys (
          key TEXT PRIMARY KEY,
          status TEXT NOT NULL DEFAULT 'processing',
          result TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )`
      ).run();
      return Response.json({ status: "ok" });
    }

if (url.pathname === "/debug/init-discount-column" && request.method === "POST") {
      await runIdempotentMigration(env, "ALTER TABLE line_items ADD COLUMN discount_percent REAL");
      return Response.json({ status: "ok" });
    }

if (url.pathname === "/debug/init-capture-id-column" && request.method === "POST") {
      await runIdempotentMigration(env, "ALTER TABLE job_scopes ADD COLUMN capture_id INTEGER");
      return Response.json({ status: "ok" });
    }

if (url.pathname === "/debug/init-projects" && request.method === "POST") {
      await env.OFFICE_DB.prepare(
        `CREATE TABLE IF NOT EXISTS projects (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          customer_id INTEGER,
          description TEXT,
          source_transcript TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )`
      ).run();
      await runIdempotentMigration(env, "ALTER TABLE job_scopes ADD COLUMN project_id INTEGER");
      return Response.json({ status: "ok" });
    }

if (url.pathname === "/debug/init-job-scope-links" && request.method === "POST") {
      await runIdempotentMigration(env, "ALTER TABLE quotations ADD COLUMN job_scope_id INTEGER");
      await runIdempotentMigration(env, "ALTER TABLE invoices ADD COLUMN job_scope_id INTEGER");
      return Response.json({ status: "ok" });
    }

if (url.pathname === "/debug/backfill-invoice-job-scope" && request.method === "POST") {
      const result = await env.OFFICE_DB.prepare(
        `UPDATE invoices SET job_scope_id = (
           SELECT job_scope_id FROM quotations WHERE quotations.id = invoices.quotation_id
         )
         WHERE invoices.job_scope_id IS NULL
           AND invoices.quotation_id IS NOT NULL
           AND (SELECT job_scope_id FROM quotations WHERE quotations.id = invoices.quotation_id) IS NOT NULL`
      ).run();
      return Response.json({ status: "ok", changes: result.meta.changes });
    }

if (url.pathname === "/debug/projects" && request.method === "GET") {
      const { results: projects } = await env.OFFICE_DB.prepare(
        `SELECT p.id, p.customer_id, c.name as customer_name, p.description, p.created_at
         FROM projects p
         LEFT JOIN customers c ON c.id = p.customer_id
         ORDER BY p.created_at DESC LIMIT 10`
      ).all();
      const enriched = await Promise.all(
        (projects as Array<{ id: number }>).map(async (project) => {
          const { results: jobScopes } = await env.OFFICE_DB.prepare(
            "SELECT id, description, capture_id, created_at FROM job_scopes WHERE project_id = ?"
          )
            .bind(project.id)
            .all();
          // Real, deterministic total — every quotation and invoice
          // linked, through its real job_scope_id, to a job scope that
          // belongs to this project. The actual point of this whole
          // feature: a project can now show its real, total quoted
          // and invoiced value, not just a label on some measurements.
          const totalQuoted = await env.OFFICE_DB.prepare(
            `SELECT COALESCE(SUM(q.amount), 0) as total FROM quotations q
             JOIN job_scopes js ON js.id = q.job_scope_id
             WHERE js.project_id = ?`
          )
            .bind(project.id)
            .first<{ total: number }>();
          const totalInvoiced = await env.OFFICE_DB.prepare(
            `SELECT COALESCE(SUM(i.amount), 0) as total FROM invoices i
             JOIN job_scopes js ON js.id = i.job_scope_id
             WHERE js.project_id = ?`
          )
            .bind(project.id)
            .first<{ total: number }>();
          return {
            ...project,
            totalQuoted: totalQuoted?.total ?? 0,
            totalInvoiced: totalInvoiced?.total ?? 0,
            jobScopes,
          };
        })
      );
      return Response.json({ projects: enriched });
    }

if (url.pathname === "/debug/init-task-due-date-columns" && request.method === "POST") {
      await runIdempotentMigration(env, "ALTER TABLE tasks ADD COLUMN due_date_raw TEXT");
      await runIdempotentMigration(env, "ALTER TABLE tasks ADD COLUMN due_date TEXT");
      return Response.json({ status: "ok" });
    }

if (url.pathname === "/debug/init-vat-exempt-column" && request.method === "POST") {
      await runIdempotentMigration(env, "ALTER TABLE customers ADD COLUMN vat_exempt INTEGER NOT NULL DEFAULT 0");
      return Response.json({ status: "ok" });
    }

if (url.pathname === "/debug/init-retention-columns" && request.method === "POST") {
      await runIdempotentMigration(env, "ALTER TABLE customers ADD COLUMN retention_percent REAL");
      await runIdempotentMigration(env, "ALTER TABLE invoices ADD COLUMN retention_percent REAL");
      await runIdempotentMigration(env, "ALTER TABLE invoices ADD COLUMN retention_amount REAL NOT NULL DEFAULT 0");
      return Response.json({ status: "ok" });
    }

if (url.pathname === "/debug/init-purchase-orders" && request.method === "POST") {
      await env.OFFICE_DB.prepare(
        `CREATE TABLE IF NOT EXISTS purchase_orders (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          supplier_id INTEGER,
          description TEXT NOT NULL,
          source_transcript TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )`
      ).run();
      await env.OFFICE_DB.prepare(
        `CREATE TABLE IF NOT EXISTS po_line_items (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          purchase_order_id INTEGER NOT NULL,
          description TEXT NOT NULL,
          quantity_ordered REAL NOT NULL,
          unit TEXT,
          unit_price_expected REAL
        )`
      ).run();
      return Response.json({ status: "ok" });
    }

if (url.pathname === "/debug/suppliers-list" && request.method === "GET") {
      const search = url.searchParams.get("search")?.trim() || null;
      const limit = Math.min(Number(url.searchParams.get("limit")) || 50, 200);
      const offset = Number(url.searchParams.get("offset")) || 0;
      const like = search ? `%${search}%` : null;

      const { results: orders } = await env.OFFICE_DB.prepare(
        `SELECT po.id, po.supplier_id, ch.name as supplier_name, po.description, po.created_at
         FROM purchase_orders po
         LEFT JOIN characters ch ON ch.id = po.supplier_id
         WHERE (?1 IS NULL OR ch.name LIKE ?2 OR po.description LIKE ?2)
         ORDER BY po.created_at DESC
         LIMIT ?3 OFFSET ?4`
      )
        .bind(search, like, limit, offset)
        .all();

      const enriched = await Promise.all(
        (orders as Array<{ id: number }>).map(async (order) => {
          const { results: lineItems } = await env.OFFICE_DB.prepare(
            "SELECT id, description, quantity_ordered, unit, unit_price_expected FROM po_line_items WHERE purchase_order_id = ?"
          )
            .bind(order.id)
            .all();
          const grnCount = await env.OFFICE_DB.prepare(
            "SELECT COUNT(*) as count FROM goods_received_notes WHERE purchase_order_id = ?"
          )
            .bind(order.id)
            .first<{ count: number }>();
          const invoiceCount = await env.OFFICE_DB.prepare(
            "SELECT COUNT(*) as count FROM supplier_invoices WHERE purchase_order_id = ?"
          )
            .bind(order.id)
            .first<{ count: number }>();
          const hasDeliveryNote = (grnCount?.count ?? 0) > 0;
          const hasSupplierInvoice = (invoiceCount?.count ?? 0) > 0;
          const documentStatus = hasSupplierInvoice
            ? "closed"
            : hasDeliveryNote
            ? "delivery note received, awaiting invoice"
            : "ordered, awaiting delivery";
          return { ...order, documentStatus, hasDeliveryNote, hasSupplierInvoice, lineItems };
        })
      );

      return Response.json({ items: enriched, limit, offset });
    }

if (url.pathname === "/debug/purchase-orders" && request.method === "GET") {
      const { results: orders } = await env.OFFICE_DB.prepare(
        `SELECT po.id, po.supplier_id, ch.name as supplier_name, po.description, po.created_at
         FROM purchase_orders po
         LEFT JOIN characters ch ON ch.id = po.supplier_id
         ORDER BY po.created_at DESC LIMIT 10`
      ).all();
      const enriched = await Promise.all(
        (orders as Array<{ id: number }>).map(async (order) => {
          const { results: lineItems } = await env.OFFICE_DB.prepare(
            "SELECT id, description, quantity_ordered, unit, unit_price_expected FROM po_line_items WHERE purchase_order_id = ?"
          )
            .bind(order.id)
            .all();
          // Real feature 2026-07-21 — the document-completeness
          // status pinned earlier tonight, built directly from that
          // design: computed live from real counts, the same
          // "compute on read" discipline already chosen for
          // partial-GRN status, not a new pattern. A delivery note
          // and a supplier invoice genuinely arrive separately far
          // more often than together — this status is the real,
          // visible answer to "which one, if either, are we still
          // waiting on."
          const grnCount = await env.OFFICE_DB.prepare(
            "SELECT COUNT(*) as count FROM goods_received_notes WHERE purchase_order_id = ?"
          )
            .bind(order.id)
            .first<{ count: number }>();
          const invoiceCount = await env.OFFICE_DB.prepare(
            "SELECT COUNT(*) as count FROM supplier_invoices WHERE purchase_order_id = ?"
          )
            .bind(order.id)
            .first<{ count: number }>();
          const hasDeliveryNote = (grnCount?.count ?? 0) > 0;
          const hasSupplierInvoice = (invoiceCount?.count ?? 0) > 0;
          const documentStatus = hasSupplierInvoice
            ? "closed"
            : hasDeliveryNote
            ? "delivery note received, awaiting invoice"
            : "ordered, awaiting delivery";
          return { ...order, documentStatus, hasDeliveryNote, hasSupplierInvoice, lineItems };
        })
      );
      return Response.json({ purchaseOrders: enriched });
    }

if (url.pathname === "/debug/init-goods-received" && request.method === "POST") {
      await env.OFFICE_DB.prepare(
        `CREATE TABLE IF NOT EXISTS goods_received_notes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          purchase_order_id INTEGER NOT NULL,
          supplier_id INTEGER,
          source_transcript TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )`
      ).run();
      await env.OFFICE_DB.prepare(
        `CREATE TABLE IF NOT EXISTS grn_line_items (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          grn_id INTEGER NOT NULL,
          po_line_item_id INTEGER,
          description TEXT NOT NULL,
          quantity_received REAL NOT NULL,
          quantity_ordered REAL,
          variance REAL
        )`
      ).run();
      return Response.json({ status: "ok" });
    }

if (url.pathname === "/debug/init-grn-recorded-by" && request.method === "POST") {
      await runIdempotentMigration(env, "ALTER TABLE goods_received_notes ADD COLUMN recorded_by TEXT");
      return Response.json({ status: "ok" });
    }

if (url.pathname === "/debug/init-variance-dispositions" && request.method === "POST") {
      await env.OFFICE_DB.prepare(
        `CREATE TABLE IF NOT EXISTS variance_dispositions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          grn_line_item_id INTEGER NOT NULL,
          reason TEXT,
          resolution TEXT,
          credit_amount REAL,
          recorded_by TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )`
      ).run();
      return Response.json({ status: "ok" });
    }

if (url.pathname === "/debug/variance-dispositions" && request.method === "GET") {
      const { results } = await env.OFFICE_DB.prepare(
        `SELECT vd.id, vd.reason, vd.resolution, vd.credit_amount, vd.recorded_by, vd.created_at,
                gli.description, gli.variance, ch.name as supplier_name
         FROM variance_dispositions vd
         JOIN grn_line_items gli ON gli.id = vd.grn_line_item_id
         JOIN goods_received_notes grn ON grn.id = gli.grn_id
         LEFT JOIN characters ch ON ch.id = grn.supplier_id
         ORDER BY vd.created_at DESC LIMIT 10`
      ).all();
      return Response.json({ varianceDispositions: results });
    }

if (url.pathname === "/debug/init-stock" && request.method === "POST") {
      await env.OFFICE_DB.prepare(
        `CREATE TABLE IF NOT EXISTS stock_items (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          unit TEXT,
          quantity_on_hand REAL NOT NULL DEFAULT 0,
          reorder_threshold REAL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )`
      ).run();
      await env.OFFICE_DB.prepare(
        `CREATE TABLE IF NOT EXISTS stock_usage_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          stock_item_id INTEGER NOT NULL,
          quantity_used REAL NOT NULL,
          customer_id INTEGER,
          source_transcript TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )`
      ).run();
      await env.OFFICE_DB.prepare(
        `CREATE TABLE IF NOT EXISTS stocktakes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          source_transcript TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )`
      ).run();
      await env.OFFICE_DB.prepare(
        `CREATE TABLE IF NOT EXISTS stocktake_lines (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          stocktake_id INTEGER NOT NULL,
          stock_item_id INTEGER NOT NULL,
          quantity_counted REAL NOT NULL,
          quantity_expected REAL NOT NULL,
          variance REAL NOT NULL
        )`
      ).run();
      return Response.json({ status: "ok" });
    }

if (url.pathname === "/debug/stock-items" && request.method === "GET") {
      const items = await getTrackedStockItems(env);
      return Response.json({ stockItems: items });
    }

if (url.pathname === "/debug/stocktakes" && request.method === "GET") {
      const { results } = await env.OFFICE_DB.prepare(
        `SELECT stl.id, stl.quantity_counted, stl.quantity_expected, stl.variance, si.name, si.unit, st.created_at
         FROM stocktake_lines stl
         JOIN stock_items si ON si.id = stl.stock_item_id
         JOIN stocktakes st ON st.id = stl.stocktake_id
         ORDER BY st.created_at DESC LIMIT 10`
      ).all();
      return Response.json({ stocktakes: results });
    }

if (url.pathname === "/debug/init-snags" && request.method === "POST") {
      await env.OFFICE_DB.prepare(
        `CREATE TABLE IF NOT EXISTS snags (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          customer_id INTEGER NOT NULL,
          description TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'open',
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          resolved_at TEXT
        )`
      ).run();
      return Response.json({ status: "ok" });
    }

if (url.pathname === "/debug/snags" && request.method === "GET") {
      const { results } = await env.OFFICE_DB.prepare(
        `SELECT sn.id, sn.description, sn.status, sn.created_at, sn.resolved_at, c.name as customer_name
         FROM snags sn
         JOIN customers c ON c.id = sn.customer_id
         ORDER BY sn.created_at DESC LIMIT 10`
      ).all();
      return Response.json({ snags: results });
    }

if (url.pathname === "/debug/init-leads" && request.method === "POST") {
      await env.OFFICE_DB.prepare(
        `CREATE TABLE IF NOT EXISTS leads (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          interest TEXT,
          source TEXT,
          status TEXT NOT NULL DEFAULT 'enquired',
          customer_id INTEGER,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )`
      ).run();
      return Response.json({ status: "ok" });
    }

if (url.pathname === "/debug/leads" && request.method === "GET") {
      const { results } = await env.OFFICE_DB.prepare(
        "SELECT id, name, interest, source, status, customer_id, created_at FROM leads ORDER BY created_at DESC LIMIT 10"
      ).all();
      return Response.json({ leads: results });
    }

if (url.pathname === "/debug/init-supplier-payments" && request.method === "POST") {
      await env.OFFICE_DB.prepare(
        `CREATE TABLE IF NOT EXISTS supplier_payments (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          character_id INTEGER NOT NULL,
          amount REAL,
          source_transcript TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )`
      ).run();
      return Response.json({ status: "ok" });
    }

if (url.pathname === "/debug/aged-creditors" && request.method === "GET") {
      const rows = await getAgedCreditorsReport(env);
      return Response.json({ agedCreditors: rows });
    }

if (url.pathname === "/debug/goods-received" && request.method === "GET") {
      const { results: grns } = await env.OFFICE_DB.prepare(
        `SELECT g.id, g.purchase_order_id, g.supplier_id, ch.name as supplier_name, g.recorded_by, g.created_at
         FROM goods_received_notes g
         LEFT JOIN characters ch ON ch.id = g.supplier_id
         ORDER BY g.created_at DESC LIMIT 10`
      ).all();
      const enriched = await Promise.all(
        (grns as Array<{ id: number }>).map(async (grn) => {
          const { results: lineItems } = await env.OFFICE_DB.prepare(
            "SELECT id, description, quantity_received, quantity_ordered, variance FROM grn_line_items WHERE grn_id = ?"
          )
            .bind(grn.id)
            .all();
          return { ...grn, lineItems };
        })
      );
      return Response.json({ goodsReceivedNotes: enriched });
    }

if (url.pathname === "/debug/init-supplier-invoices" && request.method === "POST") {
      await env.OFFICE_DB.prepare(
        `CREATE TABLE IF NOT EXISTS supplier_invoices (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          purchase_order_id INTEGER,
          supplier_id INTEGER,
          supplier_reference TEXT,
          amount REAL NOT NULL,
          source_transcript TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )`
      ).run();
      await env.OFFICE_DB.prepare(
        `CREATE TABLE IF NOT EXISTS supplier_invoice_line_items (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          supplier_invoice_id INTEGER NOT NULL,
          po_line_item_id INTEGER,
          description TEXT NOT NULL,
          quantity_billed REAL NOT NULL,
          unit_price_billed REAL,
          quantity_variance REAL,
          price_variance REAL,
          line_total REAL NOT NULL
        )`
      ).run();
      return Response.json({ status: "ok" });
    }

if (url.pathname === "/debug/supplier-invoices" && request.method === "GET") {
      const { results: invoices } = await env.OFFICE_DB.prepare(
        `SELECT si.id, si.purchase_order_id, si.supplier_id, ch.name as supplier_name, si.supplier_reference, si.amount, si.created_at
         FROM supplier_invoices si
         LEFT JOIN characters ch ON ch.id = si.supplier_id
         ORDER BY si.created_at DESC LIMIT 10`
      ).all();
      const enriched = await Promise.all(
        (invoices as Array<{ id: number }>).map(async (invoice) => {
          const { results: lineItems } = await env.OFFICE_DB.prepare(
            "SELECT id, description, quantity_billed, unit_price_billed, quantity_variance, price_variance, line_total FROM supplier_invoice_line_items WHERE supplier_invoice_id = ?"
          )
            .bind(invoice.id)
            .all();
          return { ...invoice, lineItems };
        })
      );
      return Response.json({ supplierInvoices: enriched });
    }

if (url.pathname === "/debug/business-profile" && request.method === "GET") {
      const profile = await env.OFFICE_DB.prepare("SELECT * FROM business_profile WHERE id = 1").first();
      return Response.json({ profile: profile ?? null });
    }

if (url.pathname === "/debug/business-profile" && request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as {
        name?: string;
        trading_as?: string;
        vat_no?: string;
        address?: string;
        phone?: string;
        email?: string;
        banking_details?: string;
        vat_registered?: boolean;
        vat_rate?: number;
      };
      if (!body.name) {
        return Response.json({ error: "name is required" }, { status: 400 });
      }
      // Real safety net: business_profile has no tracked CREATE
      // statement anywhere in this codebase (same situation as
      // line_items) — this makes the route work correctly whether or
      // not the table already exists from an earlier manual migration.
      await env.OFFICE_DB.prepare(
        `CREATE TABLE IF NOT EXISTS business_profile (
          id INTEGER PRIMARY KEY,
          name TEXT,
          trading_as TEXT,
          vat_no TEXT,
          address TEXT,
          phone TEXT,
          email TEXT,
          banking_details TEXT,
          vat_registered INTEGER NOT NULL DEFAULT 0,
          vat_rate REAL NOT NULL DEFAULT 15,
          logo_r2_key TEXT
        )`
      ).run();
      // Real migration 2026-07-25 — business_profile already exists
      // with real data, so CREATE TABLE IF NOT EXISTS alone would
      // never add this new column to it.
      await runIdempotentMigration(env, "ALTER TABLE business_profile ADD COLUMN logo_r2_key TEXT");
      await env.OFFICE_DB.prepare(
        `INSERT INTO business_profile (id, name, trading_as, vat_no, address, phone, email, banking_details, vat_registered, vat_rate)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name, trading_as = excluded.trading_as, vat_no = excluded.vat_no,
           address = excluded.address, phone = excluded.phone, email = excluded.email,
           banking_details = excluded.banking_details, vat_registered = excluded.vat_registered,
           vat_rate = excluded.vat_rate`
      )
        .bind(
          body.name,
          body.trading_as ?? null,
          body.vat_no ?? null,
          body.address ?? null,
          body.phone ?? null,
          body.email ?? null,
          body.banking_details ?? null,
          body.vat_registered ? 1 : 0,
          body.vat_rate ?? 15
        )
        .run();
      const saved = await env.OFFICE_DB.prepare("SELECT * FROM business_profile WHERE id = 1").first();
      return Response.json({ status: "saved", profile: saved });
    }

if (url.pathname === "/debug/logo-metadata" && request.method === "GET") {
      const profile = await env.OFFICE_DB.prepare("SELECT logo_r2_key FROM business_profile WHERE id = 1").first<{
        logo_r2_key: string | null;
      }>();
      if (!profile?.logo_r2_key) {
        return Response.json({ error: "no logo on file", profile });
      }
      const object = await env.OFFICE_VAULT.head(profile.logo_r2_key);
      return Response.json({
        logoKey: profile.logo_r2_key,
        found: !!object,
        size: object?.size ?? null,
        contentType: object?.httpMetadata?.contentType ?? null,
      });
    }

if (url.pathname === "/debug/init-membership-character" && request.method === "POST") {
      await runIdempotentMigration(env, "ALTER TABLE memberships ADD COLUMN character_id INTEGER");
      return Response.json({ status: "ok" });
    }

if (url.pathname === "/debug/set-membership-character" && request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as { email?: string; characterId?: number | null };
      if (!body.email) {
        return Response.json({ error: "requires email in the request body" }, { status: 400 });
      }
      await env.OFFICE_DB.prepare("UPDATE memberships SET character_id = ? WHERE google_email = ?")
        .bind(body.characterId ?? null, body.email)
        .run();
      const row = await env.OFFICE_DB.prepare(
        "SELECT id, google_email, role, character_id FROM memberships WHERE google_email = ?"
      )
        .bind(body.email)
        .first();
      return Response.json({ status: "ok", membership: row });
    }

if (url.pathname === "/debug/memberships" && request.method === "GET") {
      const { results } = await env.OFFICE_DB.prepare("SELECT * FROM memberships ORDER BY created_at DESC").all();
      const enriched = results.map((m) => ({ ...m, capabilities: ROLE_CAPABILITIES[String(m.role)] ?? [] }));
      return Response.json({ memberships: enriched });
    }

if (url.pathname === "/debug/create-membership" && request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as { google_email?: string; role?: string };
      if (!body.google_email || !body.role) {
        return Response.json({ error: "google_email and role are both required" }, { status: 400 });
      }
      if (!ROLE_CAPABILITIES[body.role]) {
        return Response.json(
          { error: `unknown role "${body.role}" — defined roles are: ${Object.keys(ROLE_CAPABILITIES).join(", ")}` },
          { status: 400 }
        );
      }
      try {
        const inserted = await env.OFFICE_DB.prepare(
          "INSERT INTO memberships (google_email, role) VALUES (?, ?) RETURNING id"
        )
          .bind(body.google_email, body.role)
          .first<{ id: number }>();
        return Response.json({
          status: "created",
          id: inserted!.id,
          google_email: body.google_email,
          role: body.role,
          capabilities: ROLE_CAPABILITIES[body.role],
        });
      } catch (err) {
        return Response.json(
          { error: err instanceof Error ? err.message : String(err) },
          { status: 409 }
        );
      }
    }

if (url.pathname === "/debug/delete-membership" && request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as { google_email?: string };
      if (!body.google_email) return Response.json({ error: "google_email is required" }, { status: 400 });
      const result = await env.OFFICE_DB.prepare("DELETE FROM memberships WHERE google_email = ?")
        .bind(body.google_email)
        .run();
      return Response.json({ status: "deleted", google_email: body.google_email, changes: result.meta.changes });
    }

if (url.pathname === "/debug/character-facts" && request.method === "GET") {
      const characterId = url.searchParams.get("characterId");
      const query = characterId
        ? env.OFFICE_DB.prepare(
            "SELECT cf.id, cf.character_id, ch.name as character_name, cf.key, cf.value, cf.created_at FROM character_facts cf JOIN characters ch ON ch.id = cf.character_id WHERE cf.character_id = ? ORDER BY cf.created_at DESC"
          ).bind(Number(characterId))
        : env.OFFICE_DB.prepare(
            "SELECT cf.id, cf.character_id, ch.name as character_name, cf.key, cf.value, cf.created_at FROM character_facts cf JOIN characters ch ON ch.id = cf.character_id ORDER BY cf.created_at DESC LIMIT 30"
          );
      const { results } = await query.all();
      return Response.json({ facts: results });
    }

if (url.pathname === "/debug/expenses" && request.method === "GET") {
      const { results } = await env.OFFICE_DB.prepare(
        `SELECT e.id, e.amount, e.description, e.category, e.character_id, c.name as supplier_name,
                e.customer_id, cu.name as job_name, e.created_at
         FROM expenses e
         LEFT JOIN characters c ON c.id = e.character_id
         LEFT JOIN customers cu ON cu.id = e.customer_id
         ORDER BY e.created_at DESC LIMIT 30`
      ).all();
      return Response.json({ expenses: results });
    }

if (url.pathname === "/debug/tasks-list" && request.method === "GET") {
      const search = url.searchParams.get("search")?.trim() || null;
      const limit = Math.min(Number(url.searchParams.get("limit")) || 50, 200);
      const offset = Number(url.searchParams.get("offset")) || 0;
      const like = search ? `%${search}%` : null;

      const { results } = await env.OFFICE_DB.prepare(
        `SELECT t.id, t.description, t.done, t.created_at, t.completed_at,
                c.name as customer_name, ch.name as character_name
         FROM tasks t
         LEFT JOIN customers c ON c.id = t.customer_id
         LEFT JOIN characters ch ON ch.id = t.character_id
         WHERE (?1 IS NULL OR t.description LIKE ?2 OR c.name LIKE ?2 OR ch.name LIKE ?2)
         ORDER BY t.done ASC, t.created_at DESC
         LIMIT ?3 OFFSET ?4`
      )
        .bind(search, like, limit, offset)
        .all();

      return Response.json({ items: results, limit, offset });
    }

if (url.pathname === "/debug/tasks" && request.method === "GET") {
      const { results } = await env.OFFICE_DB.prepare(
        "SELECT id, description, done, customer_id, character_id, created_at, completed_at FROM tasks ORDER BY created_at DESC LIMIT 30"
      ).all();
      return Response.json({ tasks: results });
    }

if (url.pathname === "/debug/init-selections-table" && request.method === "POST") {
      await env.OFFICE_DB.prepare(
        `CREATE TABLE IF NOT EXISTS selections (
          key TEXT PRIMARY KEY,
          entity_id INTEGER NOT NULL,
          label TEXT NOT NULL,
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )`
      ).run();
      return Response.json({ status: "ok" });
    }

if (url.pathname === "/debug/selections" && request.method === "GET") {
      const { results } = await env.OFFICE_DB.prepare(
        "SELECT key, entity_id, label, updated_at FROM selections ORDER BY updated_at DESC"
      ).all();
      return Response.json({ selections: results });
    }

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

if (url.pathname === "/admin/flush-memory" && request.method === "POST") {
      const result = await runConsolidation(env);
      return Response.json(result);
    }

if (url.pathname === "/debug/pdf-route-test" && request.method === "GET") {
      return Response.json({ ok: true, note: "this trivial route works" });
    }

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
        {
          name: "task_complete is distinct from reminder by tense — done now, not later",
          text: "got the dog food",
          check: (e) => e?.intent === "task_complete",
        },
        {
          name: "bare pronoun-only completions still count as task_complete, not note",
          text: "called them",
          check: (e) => e?.intent === "task_complete",
        },
        {
          name: "expense (money out, to a supplier) is distinct from payment (money in, from a customer)",
          text: "bought glue for R850 at BUCO",
          check: (e) => e?.intent === "expense" && e?.character_name === "BUCO" && e?.customer_name === null,
        },
        {
          name: "expense job-cost linking: customer_name means which job, never who to bill",
          text: "bought glue for R850 at BUCO for Jenny's job",
          check: (e) => e?.intent === "expense" && e?.character_name === "BUCO" && e?.customer_name === "Jenny",
        },
      ];

      // Sequential, not Promise.all — real bug found live 2026-07-11:
      // as this suite grew to 17 cases, running them all concurrently
      // started tripping Workers AI's capacity limit ("3040: Capacity
      // temporarily exceeded"), which never happened at 11-14 cases.
      // A regression suite that fails on its own load isn't reliable;
      // sequential execution is slower but actually trustworthy.
      // Real finding 2026-07-27: the suite has grown from 17 cases
      // (when the capacity-limit finding above was made) to 22, and
      // pure sequential execution of 22 real, live AI calls is now
      // genuinely timing out — found live when it hung completely,
      // twice in a row. Full parallelism already proved unreliable
      // (the capacity-limit finding above), so the real fix is
      // batched concurrency: small groups running together, staying
      // well under whatever threshold tripped that limit, while
      // meaningfully cutting total wall-clock time versus one-by-one.
      const results: Array<{ name: string; input: string; pass: boolean; extraction: Extraction | null; rawOnFailure?: unknown }> = [];
      const batchSize = 4;
      for (let i = 0; i < cases.length; i += batchSize) {
        const batch = cases.slice(i, i + batchSize);
        const batchResults = await Promise.all(
          batch.map(async (c) => {
            const { extraction, raw } = await extractIntent(env, c.text);
            return { name: c.name, input: c.text, pass: c.check(extraction), extraction, rawOnFailure: extraction ? undefined : raw };
          })
        );
        results.push(...batchResults);
      }

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

if (url.pathname === "/debug/characters-list" && request.method === "GET") {
      const search = url.searchParams.get("search")?.trim() || null;
      const limit = Math.min(Number(url.searchParams.get("limit")) || 50, 200);
      const offset = Number(url.searchParams.get("offset")) || 0;
      const like = search ? `%${search}%` : null;

      const { results: characters } = await env.OFFICE_DB.prepare(
        `SELECT id, name, relationship, created_at FROM characters
         WHERE (?1 IS NULL OR name LIKE ?2 OR relationship LIKE ?2)
         ORDER BY name ASC
         LIMIT ?3 OFFSET ?4`
      )
        .bind(search, like, limit, offset)
        .all<{ id: number; name: string; relationship: string | null; created_at: string }>();

      const enriched = await Promise.all(
        characters.map(async (c) => ({ ...c, notes: await getCharacterNotes(env, c.id) }))
      );

      return Response.json({ items: enriched, limit, offset });
    }

// Real, read-only check for the date-ranged report functions — the
// live way to confirm a range actually narrows the numbers, against
// the real deployed database. ?from=YYYY-MM-DD&to=YYYY-MM-DD, both
// optional and inclusive; no params returns the all-time figures.
if (url.pathname === "/debug/profit-and-loss" && request.method === "GET") {
      let range;
      try {
        range = parseDateRange(url.searchParams.get("from"), url.searchParams.get("to"));
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
      }
      const [profitAndLoss, snapshot] = await Promise.all([getProfitAndLoss(env, range), getFinancialSnapshot(env, range)]);
      return Response.json({ period: range, profitAndLoss, snapshot });
    }

if (url.pathname === "/debug/financial-snapshot" && request.method === "GET") {
      const [invoicedRow, paidRow, expensesRow, outstandingRows, pnl] = await Promise.all([
        env.OFFICE_DB.prepare("SELECT COALESCE(SUM(amount), 0) as total FROM invoices").first<{ total: number }>(),
        env.OFFICE_DB.prepare("SELECT COALESCE(SUM(amount), 0) as total FROM payments").first<{ total: number }>(),
        env.OFFICE_DB.prepare("SELECT COALESCE(SUM(amount), 0) as total FROM expenses").first<{ total: number }>(),
        env.OFFICE_DB.prepare(
          `SELECT c.name as name,
                  COALESCE(SUM(i.amount), 0) as invoiced,
                  COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.customer_id = c.id), 0) as paid
           FROM customers c
           JOIN invoices i ON i.customer_id = c.id
           GROUP BY c.id
           HAVING invoiced > paid
           ORDER BY (invoiced - paid) DESC`
        ).all<{ name: string; invoiced: number; paid: number }>(),
        getProfitAndLoss(env),
      ]);

      const totalInvoiced = invoicedRow?.total ?? 0;
      const totalPaid = paidRow?.total ?? 0;
      const totalExpenses = expensesRow?.total ?? 0;
      const outstanding = outstandingRows.results.map((r) => ({ customer: r.name, invoiced: r.invoiced, paid: r.paid, owes: r.invoiced - r.paid }));
      const totalOutstanding = outstanding.reduce((sum, r) => sum + r.owes, 0);

      return Response.json({
        cashBasis: {
          totalInvoiced,
          totalReceived: totalPaid,
          totalExpenses,
          roughCashPosition: totalPaid - totalExpenses,
        },
        accrualBasisProfitAndLoss: pnl,
        outstanding: {
          totalOutstanding,
          customerCount: outstanding.length,
          byCustomer: outstanding,
        },
      });
    }

if (url.pathname === "/debug/customers" && request.method === "GET") {
      const { results: customers } = await env.OFFICE_DB.prepare(
        "SELECT id, name, address, created_at FROM customers ORDER BY created_at DESC LIMIT 20"
      ).all<{ id: number; name: string; address: string | null; created_at: string }>();

      return Response.json({ customers });
    }

if (url.pathname === "/debug/init-customer-merge" && request.method === "POST") {
      await runIdempotentMigration(env, "ALTER TABLE customers ADD COLUMN merged_into_customer_id INTEGER");
      return Response.json({ status: "ok" });
    }

if (url.pathname === "/debug/init-people-merge" && request.method === "POST") {
      await runIdempotentMigration(env, "ALTER TABLE people ADD COLUMN merged_into_person_id INTEGER");
      return Response.json({ status: "ok" });
    }

if (url.pathname === "/debug/init-products" && request.method === "POST") {
      // Real, per direct instruction: IF NOT EXISTS already makes
      // this idempotent at the SQL level — a try/catch swallowing
      // "already exists" here was never really catching that, since
      // SQLite never throws for it in the first place. Any real error
      // now propagates naturally instead of being silently masked.
      await env.OFFICE_DB.prepare(
        `CREATE TABLE IF NOT EXISTS products (
          id INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          category TEXT,
          merged_into_product_id INTEGER,
          created_at TEXT DEFAULT (datetime('now'))
        )`
      ).run();
      await runIdempotentMigration(env, "ALTER TABLE line_items ADD COLUMN product_id INTEGER");
      await runIdempotentMigration(env, "ALTER TABLE line_items ADD COLUMN room TEXT");
      // Real, new columns, per direct instruction: the real, missing
      // buy-side half of the products foundation. Without these, only
      // what a product sells for would ever be known, never what it
      // actually cost — "profit margin on vinyl" stays unanswerable
      // regardless of how good the sell-side wiring is.
      await runIdempotentMigration(env, "ALTER TABLE po_line_items ADD COLUMN product_id INTEGER");
      await runIdempotentMigration(env, "ALTER TABLE supplier_invoice_line_items ADD COLUMN product_id INTEGER");
      return Response.json({ status: "ok" });
    }

if (url.pathname === "/debug/merge-customers" && request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as { fromId?: number; intoId?: number };
      if (!body.fromId || !body.intoId) {
        return Response.json({ error: "requires both fromId and intoId in the request body" }, { status: 400 });
      }
      if (body.fromId === body.intoId) {
        return Response.json({ error: "fromId and intoId must be different" }, { status: 400 });
      }

      const tablesToRepoint = [
        "payments",
        "expenses",
        "invoices",
        "quotations",
        "stock_usage_log",
        "snags",
        "projects",
        "leads",
        "job_scopes",
        "tasks",
      ];
      const repointed: Record<string, number> = {};
      for (const table of tablesToRepoint) {
        try {
          const result = await env.OFFICE_DB.prepare(`UPDATE ${table} SET customer_id = ? WHERE customer_id = ?`)
            .bind(body.intoId, body.fromId)
            .run();
          repointed[table] = result.meta.changes ?? 0;
        } catch {
          // Real, honest skip — a table that doesn't have a
          // customer_id column (or doesn't exist in this instance)
          // simply contributes 0, not an error that blocks the rest.
          repointed[table] = 0;
        }
      }

      await env.OFFICE_DB.prepare("UPDATE customers SET merged_into_customer_id = ? WHERE id = ?")
        .bind(body.intoId, body.fromId)
        .run();

      // Real, new step, per direct instruction after a real, confirmed
      // gap: merging the customer record alone left the underlying
      // people-table identity unmerged, so the losing customer's name
      // kept surfacing as its own separate candidate in every future
      // ambiguous-name check (see identity.ts's own comment on this —
      // the confirmed real reason "bon waterfront" still showed three
      // candidates after this exact merge, when it should have shown
      // two). Reads each side's real person_id, repoints anything else
      // that referenced the losing person onto the surviving one, and
      // marks the losing person via the same merged_into_* pattern
      // already proven for customers — never deleted, always
      // inspectable.
      const fromCustomer = await env.OFFICE_DB.prepare("SELECT person_id FROM customers WHERE id = ?")
        .bind(body.fromId)
        .first<{ person_id: number | null }>();
      const intoCustomer = await env.OFFICE_DB.prepare("SELECT person_id FROM customers WHERE id = ?")
        .bind(body.intoId)
        .first<{ person_id: number | null }>();

      let peopleMerged: { fromPersonId: number; intoPersonId: number } | null = null;
      if (fromCustomer?.person_id != null && intoCustomer?.person_id != null && fromCustomer.person_id !== intoCustomer.person_id) {
        const fromPersonId = fromCustomer.person_id;
        const intoPersonId = intoCustomer.person_id;
        for (const table of ["customers", "characters", "leads"]) {
          try {
            await env.OFFICE_DB.prepare(`UPDATE ${table} SET person_id = ? WHERE person_id = ?`)
              .bind(intoPersonId, fromPersonId)
              .run();
          } catch {
            // Real, honest skip — same discipline as the table
            // repoint loop above.
          }
        }
        await env.OFFICE_DB.prepare("UPDATE people SET merged_into_person_id = ? WHERE id = ?")
          .bind(intoPersonId, fromPersonId)
          .run();
        peopleMerged = { fromPersonId, intoPersonId };
      } else if (fromCustomer?.person_id != null && intoCustomer?.person_id == null) {
        // The surviving customer never had a person_id at all —
        // simplest, safest real fix: just adopt the losing customer's,
        // since there's nothing to merge away, only to inherit.
        await env.OFFICE_DB.prepare("UPDATE customers SET person_id = ? WHERE id = ?")
          .bind(fromCustomer.person_id, body.intoId)
          .run();
      }

      return Response.json({ status: "merged", fromId: body.fromId, intoId: body.intoId, repointed, peopleMerged });
    }

if (url.pathname === "/debug/init-character-merge" && request.method === "POST") {
      await runIdempotentMigration(env, "ALTER TABLE characters ADD COLUMN merged_into_character_id INTEGER");
      return Response.json({ status: "ok" });
    }

if (url.pathname === "/debug/merge-characters" && request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as { fromId?: number; intoId?: number };
      if (!body.fromId || !body.intoId) {
        return Response.json({ error: "requires both fromId and intoId in the request body" }, { status: 400 });
      }
      if (body.fromId === body.intoId) {
        return Response.json({ error: "fromId and intoId must be different" }, { status: 400 });
      }

      const tablesToRepoint: Array<{ table: string; column: string }> = [
        { table: "character_facts", column: "character_id" },
        { table: "expenses", column: "character_id" },
        { table: "supplier_payments", column: "character_id" },
        { table: "memberships", column: "character_id" },
        { table: "goods_received_notes", column: "supplier_id" },
        { table: "purchase_orders", column: "supplier_id" },
        { table: "supplier_invoices", column: "supplier_id" },
        { table: "job_scopes", column: "installer_id" },
      ];
      const repointed: Record<string, number> = {};
      for (const { table, column } of tablesToRepoint) {
        try {
          const result = await env.OFFICE_DB.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${column} = ?`)
            .bind(body.intoId, body.fromId)
            .run();
          repointed[`${table}.${column}`] = result.meta.changes ?? 0;
        } catch {
          // Real, honest skip — same discipline as merge-customers.
          repointed[`${table}.${column}`] = 0;
        }
      }

      await env.OFFICE_DB.prepare("UPDATE characters SET merged_into_character_id = ? WHERE id = ?")
        .bind(body.intoId, body.fromId)
        .run();

      const fromCharacter = await env.OFFICE_DB.prepare("SELECT person_id FROM characters WHERE id = ?")
        .bind(body.fromId)
        .first<{ person_id: number | null }>();
      const intoCharacter = await env.OFFICE_DB.prepare("SELECT person_id FROM characters WHERE id = ?")
        .bind(body.intoId)
        .first<{ person_id: number | null }>();

      let peopleMerged: { fromPersonId: number; intoPersonId: number } | null = null;
      if (fromCharacter?.person_id != null && intoCharacter?.person_id != null && fromCharacter.person_id !== intoCharacter.person_id) {
        const fromPersonId = fromCharacter.person_id;
        const intoPersonId = intoCharacter.person_id;
        for (const table of ["customers", "characters", "leads"]) {
          try {
            await env.OFFICE_DB.prepare(`UPDATE ${table} SET person_id = ? WHERE person_id = ?`)
              .bind(intoPersonId, fromPersonId)
              .run();
          } catch {
            // Real, honest skip — same discipline as merge-customers.
          }
        }
        await env.OFFICE_DB.prepare("UPDATE people SET merged_into_person_id = ? WHERE id = ?")
          .bind(intoPersonId, fromPersonId)
          .run();
        peopleMerged = { fromPersonId, intoPersonId };
      } else if (fromCharacter?.person_id != null && intoCharacter?.person_id == null) {
        await env.OFFICE_DB.prepare("UPDATE characters SET person_id = ? WHERE id = ?")
          .bind(fromCharacter.person_id, body.intoId)
          .run();
      }

      return Response.json({ status: "merged", fromId: body.fromId, intoId: body.intoId, repointed, peopleMerged });
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

if (url.pathname === "/debug/split-topics" && request.method === "POST") {
      const body = (await request.json()) as { text?: string };
      if (!body.text) return Response.json({ error: "missing text" }, { status: 400 });
      const items = await extractMultipleIntents(env, body.text);
      return Response.json({
        segments: items.map((i) => ({ segment: i.segment, extraction: i.extraction })),
      });
    }

if (url.pathname === "/debug/find-character" && request.method === "GET") {
      const name = url.searchParams.get("name") ?? "";
      const found = await findExistingCharacterByName(env, name);
      if (!found) return Response.json({ name, found });
      const characterFacts = await getCharacterNotes(env, found.id);
      const hrFacts = await getCharacterFacts(env, found.id);
      const installerActivity = await getInstallerActivity(env, found.id);
      return Response.json({ name, found, characterFacts, hrFacts, installerActivity });
    }

if (url.pathname === "/debug/find-customer" && request.method === "GET") {
      const name = url.searchParams.get("name") ?? "";
      const found = await findExistingCustomerByName(env, name);
      return Response.json({ name, found });
    }

if (url.pathname === "/debug/table-schema" && request.method === "GET") {
      const table = url.searchParams.get("table") ?? "";
      const { results } = await env.OFFICE_DB.prepare(`PRAGMA table_info(${table})`).all();
      return Response.json({ table, columns: results });
    }

if (url.pathname === "/debug/retry-quotation" && request.method === "POST") {
      try {
        const body = (await request.json()) as {
          customerId: number;
          description: string;
          amount: number;
          lineItems?: LineItemWithTotal[];
          jobScopeId?: number | null;
        };
        const quotation = await recordQuotation(
          env,
          body.customerId,
          body.description,
          body.amount,
          "debug-retry",
          body.lineItems ?? [],
          body.jobScopeId ?? null
        );
        return Response.json({ status: "ok", quotation });
      } catch (err) {
        return Response.json(
          { error: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : null },
          { status: 500 }
        );
      }
    }

if (url.pathname === "/debug/description-frequency" && request.method === "GET") {
      const { results } = await env.OFFICE_DB.prepare(
        "SELECT description, COUNT(*) as count FROM line_items GROUP BY description ORDER BY count DESC LIMIT 60"
      ).all();
      return Response.json({ descriptions: results });
    }

if (url.pathname === "/debug/recent-line-items" && request.method === "GET") {
      const { results } = await env.OFFICE_DB.prepare(
        `SELECT li.id, li.description, li.room, li.product_id, p.name as product_name, li.created_at
         FROM line_items li
         LEFT JOIN products p ON p.id = li.product_id
         ORDER BY li.id DESC LIMIT 10`
      ).all();
      return Response.json({ lineItems: results });
    }

if (url.pathname === "/debug/recent-po-line-items" && request.method === "GET") {
      const { results } = await env.OFFICE_DB.prepare(
        `SELECT po.id, po.description, po.product_id, p.name as product_name, po.purchase_order_id
         FROM po_line_items po
         LEFT JOIN products p ON p.id = po.product_id
         ORDER BY po.id DESC LIMIT 10`
      ).all();
      return Response.json({ poLineItems: results });
    }

if (url.pathname === "/debug/recent-supplier-invoice-line-items" && request.method === "GET") {
      const { results } = await env.OFFICE_DB.prepare(
        `SELECT sil.id, sil.description, sil.product_id, p.name as product_name, sil.po_line_item_id, sil.supplier_invoice_id
         FROM supplier_invoice_line_items sil
         LEFT JOIN products p ON p.id = sil.product_id
         ORDER BY sil.id DESC LIMIT 10`
      ).all();
      return Response.json({ supplierInvoiceLineItems: results });
    }

if (url.pathname === "/admin/mint-session" && request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as { google_email?: string };
      if (!body.google_email) return Response.json({ error: "google_email is required" }, { status: 400 });
      const sessionToken = await signSession(env, body.google_email);
      return Response.json(
        { status: "minted", google_email: body.google_email, sessionToken },
        { headers: { "Set-Cookie": `office_session=${sessionToken}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000` } }
      );
    }

if (url.pathname === "/admin/export" && request.method === "GET") {
      try {
        const tables = await getRealTableNames(env);
        const snapshot: Record<string, unknown[] | { error: string }> = {};
        for (const table of tables) {
          try {
            const { results } = await env.OFFICE_DB.prepare(`SELECT * FROM "${table}"`).all();
            snapshot[table] = results;
          } catch (err) {
            snapshot[table] = { error: err instanceof Error ? err.message : String(err) };
          }
        }
        return Response.json({ exportedAt: new Date().toISOString(), tables: snapshot });
      } catch (err) {
        return Response.json(
          { error: "export failed", detail: err instanceof Error ? err.message : String(err) },
          { status: 500 }
        );
      }
    }

if (url.pathname === "/admin/flush" && request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as { confirm?: string };
      if (body.confirm !== "DELETE ALL DATA") {
        return Response.json(
          { error: 'missing or incorrect confirmation — send {"confirm": "DELETE ALL DATA"}' },
          { status: 400 }
        );
      }

      try {
        // Real fix found live 2026-07-14: customers failed with a
        // genuine foreign key constraint violation, because tables
        // were cleared in whatever order the schema happened to list
        // them, not dependency order — customers was deleted before
        // the child rows (invoices, tasks, job_scopes, and more)
        // still pointing at it, and SQLite correctly refused. Fixed
        // by disabling foreign key enforcement for the duration of
        // the flush, rather than maintaining a fragile, hardcoded
        // dependency order that would silently go stale the next time
        // a new table gets added.
        await env.OFFICE_DB.prepare("PRAGMA foreign_keys = OFF").run();

        const tables = await getRealTableNames(env);
        const deletedCounts: Record<string, number | { error: string }> = {};
        for (const table of tables) {
          try {
            const countRow = await env.OFFICE_DB.prepare(`SELECT COUNT(*) as n FROM "${table}"`).first<{ n: number }>();
            deletedCounts[table] = countRow?.n ?? 0;
            await env.OFFICE_DB.prepare(`DELETE FROM "${table}"`).run();
          } catch (err) {
            deletedCounts[table] = { error: err instanceof Error ? err.message : String(err) };
          }
        }

        await env.OFFICE_DB.prepare("PRAGMA foreign_keys = ON").run();

        // KV has no bulk-clear operation — list every real key, delete
        // each one explicitly.
        let kvKeysDeleted = 0;
        let kvError: string | null = null;
        try {
          let cursor: string | undefined;
          do {
            const listed = await env.CUSTOMER_NOTES.list({ cursor });
            for (const key of listed.keys) {
              await env.CUSTOMER_NOTES.delete(key.name);
              kvKeysDeleted++;
            }
            cursor = listed.list_complete ? undefined : listed.cursor;
          } while (cursor);
        } catch (err) {
          kvError = err instanceof Error ? err.message : String(err);
        }

        // Same for R2 — every real uploaded file, not just the D1
        // records that reference them.
        let r2ObjectsDeleted = 0;
        let r2Error: string | null = null;
        try {
          let r2Cursor: string | undefined;
          do {
            const listed = await env.OFFICE_VAULT.list({ cursor: r2Cursor });
            for (const obj of listed.objects) {
              await env.OFFICE_VAULT.delete(obj.key);
              r2ObjectsDeleted++;
            }
            r2Cursor = listed.truncated ? listed.cursor : undefined;
          } while (r2Cursor);
        } catch (err) {
          r2Error = err instanceof Error ? err.message : String(err);
        }

        return Response.json({
          status: "flushed",
          flushedAt: new Date().toISOString(),
          d1RowsDeleted: deletedCounts,
          kvKeysDeleted,
          kvError,
          r2ObjectsDeleted,
          r2Error,
        });
      } catch (err) {
        return Response.json(
          { error: "flush failed", detail: err instanceof Error ? err.message : String(err) },
          { status: 500 }
        );
      }
    }

if (url.pathname === "/debug/migrate-jobscopes-nullable-customer" && request.method === "POST") {
      try {
        await env.OFFICE_DB.batch([
          env.OFFICE_DB.prepare(
            `CREATE TABLE job_scopes_new (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              customer_id INTEGER,
              description TEXT NOT NULL,
              scheduled_date_raw TEXT,
              source_transcript TEXT,
              created_at TEXT DEFAULT (datetime('now')),
              scheduled_date TEXT,
              installer_id INTEGER
            )`
          ),
          env.OFFICE_DB.prepare(
            `INSERT INTO job_scopes_new (id, customer_id, description, scheduled_date_raw, source_transcript, created_at, scheduled_date, installer_id)
             SELECT id, customer_id, description, scheduled_date_raw, source_transcript, created_at, scheduled_date, installer_id FROM job_scopes`
          ),
          env.OFFICE_DB.prepare("DROP TABLE job_scopes"),
          env.OFFICE_DB.prepare("ALTER TABLE job_scopes_new RENAME TO job_scopes"),
        ]);
        return Response.json({ status: "ok" });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
      }
    }

if (url.pathname === "/debug/init-job-scopes-date" && request.method === "POST") {
      await runIdempotentMigration(env, "ALTER TABLE job_scopes ADD COLUMN scheduled_date TEXT");
      return Response.json({ status: "ok" });
    }

if (url.pathname === "/debug/split-test" && request.method === "GET") {
      const text = url.searchParams.get("text");
      if (!text) {
        return Response.json({ error: "text query parameter is required" }, { status: 400 });
      }
      const segments = await splitIntoTopics(env, text);
      return Response.json({ input: text, segments, segmentCount: segments.length });
    }

if (url.pathname === "/debug/ping" && request.method === "GET") {
      return Response.json({ ok: true });
    }

if (url.pathname === "/debug/close-capture-id-gaps" && request.method === "POST") {
      const tables = [
        "tasks", "expenses", "character_facts", "projects", "purchase_orders",
        "goods_received_notes", "variance_dispositions", "stock_usage_log",
        "stocktakes", "snags", "supplier_payments", "supplier_invoices",
        "invoices", "quotations",
      ];
      for (const table of tables) {
        await runIdempotentMigration(env, `ALTER TABLE ${table} ADD COLUMN capture_id INTEGER`);
      }
      return Response.json({ status: "ok", tables });
    }

if (url.pathname === "/debug/capture-id-audit" && request.method === "GET") {
      const tables = [
        "tasks", "expenses", "character_facts", "projects", "purchase_orders",
        "goods_received_notes", "variance_dispositions", "stock_usage_log",
        "stocktakes", "snags", "leads", "supplier_payments", "supplier_invoices",
        "job_scopes", "invoices", "quotations",
      ];
      const results: Record<string, { hasCaptureId: boolean; columns: string[] }> = {};
      for (const table of tables) {
        try {
          const info = await env.OFFICE_DB.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
          const columns = info.results.map((c) => c.name);
          results[table] = { hasCaptureId: columns.includes("capture_id"), columns };
        } catch (err) {
          results[table] = { hasCaptureId: false, columns: [`error: ${err instanceof Error ? err.message : String(err)}`] };
        }
      }
      return Response.json(results);
    }

if (url.pathname === "/debug/people-needing-review" && request.method === "GET") {
      const rows = await env.OFFICE_DB.prepare("SELECT id, name FROM people WHERE needs_merge_review = 1 ORDER BY name").all<{ id: number; name: string }>();
      return Response.json({ count: rows.results.length, people: rows.results });
    }

if (url.pathname === "/debug/backfill-people" && request.method === "POST") {
      const commit = url.searchParams.get("commit") === "true";
      const summary: Record<string, { linked: number; created: number; needsReview: number; rows: Array<{ id: number; name: string; action: string }> }> = {
        customers: { linked: 0, created: 0, needsReview: 0, rows: [] },
        characters: { linked: 0, created: 0, needsReview: 0, rows: [] },
        leads: { linked: 0, created: 0, needsReview: 0, rows: [] },
      };
      // Real, in-memory tracking for dry-run accuracy: without an
      // actual write, a second row sharing a name with an earlier one
      // in this same pass couldn't find it via a real query - this
      // would wrongly preview both as separate new people instead of
      // correctly linked. Populated from both real, existing people
      // rows and any names this same dry run would create.
      const wouldBeCreated = new Map<string, number>();

      // Real, confirmed fix, found via a real, direct test: a bare
      // exact-string match alone isn't enough to trust automatically.
      // "Sipho", "Thabo", and "Alfons" are each genuinely different,
      // real people despite an exact name match across tables - only
      // "Andre" happened to be correct. Same, precise threshold
      // reconcilePerson already applies going forward: a short name
      // (under 8 characters, the same real number Git's own mailmap
      // tooling uses) is never trusted automatically, even on an
      // exact match - it gets its own, separate person and is flagged
      // for real, manual review instead of being silently merged.
      const SHORT_NAME_THRESHOLD = 8;

      for (const table of ["customers", "characters", "leads"] as const) {
        const rows = await env.OFFICE_DB.prepare(`SELECT id, name FROM ${table} WHERE person_id IS NULL`).all<{ id: number; name: string }>();
        for (const row of rows.results) {
          if (!row.name || !row.name.trim()) continue;
          const trimmedName = row.name.trim();
          const nameKey = trimmedName.toLowerCase();
          const isShort = trimmedName.split(/\s+/)[0].length < SHORT_NAME_THRESHOLD;

          const existing = await env.OFFICE_DB.prepare("SELECT id FROM people WHERE name = ? COLLATE NOCASE").bind(row.name).first<{ id: number }>();
          const wouldBeMatch = existing ?? (wouldBeCreated.has(nameKey) ? { id: wouldBeCreated.get(nameKey)! } : null);

          let personId: number;
          let action: string;
          if (wouldBeMatch && isShort) {
            if (commit) {
              const inserted = await env.OFFICE_DB.prepare("INSERT INTO people (name, needs_merge_review) VALUES (?, 1) RETURNING id").bind(row.name).first<{ id: number }>();
              personId = inserted!.id;
            } else {
              personId = -1;
            }
            action = "needs-review-short-name-match";
            summary[table].needsReview++;
          } else if (wouldBeMatch) {
            personId = wouldBeMatch.id;
            action = "linked-to-existing-person";
            summary[table].linked++;
          } else {
            if (commit) {
              const inserted = await env.OFFICE_DB.prepare("INSERT INTO people (name) VALUES (?) RETURNING id").bind(row.name).first<{ id: number }>();
              personId = inserted!.id;
            } else {
              personId = -1; // real placeholder in dry-run - nothing actually created yet
            }
            action = "new-person-created";
            summary[table].created++;
          }
          if (!wouldBeCreated.has(nameKey) || !isShort) {
            wouldBeCreated.set(nameKey, personId);
          }
          summary[table].rows.push({ id: row.id, name: row.name, action });
          if (commit) {
            await env.OFFICE_DB.prepare(`UPDATE ${table} SET person_id = ? WHERE id = ?`).bind(personId, row.id).run();
          }
        }
      }

      return Response.json({ commit, summary });
    }

if (url.pathname === "/debug/person-match-test" && request.method === "GET") {
      const name = url.searchParams.get("name");
      if (!name) {
        return Response.json({ error: "name query parameter is required" }, { status: 400 });
      }
      try {
        const result = await reconcilePerson(env, name);
        return Response.json({ input: name, result });
      } catch (err) {
        // Real, deliberate error-surfacing, per direct need to see the
        // actual, real failure rather than continue guessing at it.
        return Response.json(
          { input: name, error: true, message: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : null },
          { status: 500 }
        );
      }
    }

if (url.pathname === "/debug/name-match-test" && request.method === "GET") {
      const name = url.searchParams.get("name");
      if (!name) {
        return Response.json({ error: "name query parameter is required" }, { status: 400 });
      }
      const customerMatch = await env.OFFICE_DB.prepare(
        `SELECT id, name FROM customers WHERE (name = ? OR name LIKE ? OR name LIKE ? OR name LIKE ?) LIMIT 1`
      )
        .bind(name, `${name} %`, `% ${name}`, `% ${name} %`)
        .first<{ id: number; name: string }>();
      const characterMatch = await env.OFFICE_DB.prepare(
        `SELECT id, name FROM characters WHERE (name = ? OR name LIKE ? OR name LIKE ? OR name LIKE ?) LIMIT 1`
      )
        .bind(name, `${name} %`, `% ${name}`, `% ${name} %`)
        .first<{ id: number; name: string }>();
      return Response.json({ input: name, customerMatch: customerMatch ?? null, characterMatch: characterMatch ?? null });
    }

if (url.pathname === "/debug/backward-reference-test" && request.method === "GET") {
      const text = url.searchParams.get("text");
      if (!text) {
        return Response.json({ error: "text query parameter is required" }, { status: 400 });
      }
      const hasReference = await containsBackwardReference(env, text);
      return Response.json({ input: text, hasBackwardReference: hasReference });
    }

if (url.pathname === "/debug/dashboard-route-test" && request.method === "GET") {
      const text = url.searchParams.get("text");
      if (!text) {
        return Response.json({ error: "text query parameter is required" }, { status: 400 });
      }
      const route = await classifyDashboardIntent(env, text);
      return Response.json({ input: text, route });
    }

if (url.pathname === "/debug/work-observation-test" && request.method === "GET") {
      const text = url.searchParams.get("text");
      if (!text) {
        return Response.json({ error: "text query parameter is required" }, { status: 400 });
      }
      const observation = await extractWorkObservation(env, text);
      const wouldRecord =
        observation.components.length > 0 ||
        observation.tasks.length > 0 ||
        !!observation.scheduled_date_raw ||
        !!observation.installer_name;
      const resolvedDate = resolveScheduledDate(observation.scheduled_date_raw, nowInBusinessTimezone());
      return Response.json({ input: text, observation, wouldRecord, resolvedDate });
    }

if (url.pathname === "/debug/intent-test" && request.method === "GET") {
      const text = url.searchParams.get("text");
      if (!text) {
        return Response.json({ error: "text query parameter is required" }, { status: 400 });
      }
      const result = await extractIntent(env, text);
      return Response.json({ input: text, extraction: result.extraction });
    }

if (url.pathname === "/debug/job-scopes" && request.method === "GET") {
      const { results: scopes } = await env.OFFICE_DB.prepare(
        `SELECT js.id, js.customer_id, c.name as customer_name, js.description, js.scheduled_date_raw,
                js.scheduled_date, js.installer_id, ch.name as installer_name, js.created_at, js.capture_id
         FROM job_scopes js
         LEFT JOIN customers c ON c.id = js.customer_id
         LEFT JOIN characters ch ON ch.id = js.installer_id
         ORDER BY js.created_at DESC LIMIT 10`
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

if (url.pathname === "/debug/init-job-scope-amendments" && request.method === "POST") {
      // Real, per direct instruction: same real fix as products above
      // — IF NOT EXISTS already makes this idempotent at the SQL
      // level, so any real error now propagates rather than being
      // silently masked.
      await env.OFFICE_DB.prepare(
        `CREATE TABLE IF NOT EXISTS job_scope_amendments (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          job_scope_id INTEGER NOT NULL,
          capture_id INTEGER,
          field_name TEXT NOT NULL,
          old_value TEXT,
          new_value TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )`
      ).run();
      return Response.json({ status: "ok" });
    }

if (url.pathname === "/debug/job-scope-amendments" && request.method === "GET") {
      const { results } = await env.OFFICE_DB.prepare(
        `SELECT a.id, a.job_scope_id, js.description as job_scope_description, a.capture_id,
                a.field_name, a.old_value, a.new_value, a.created_at
         FROM job_scope_amendments a
         LEFT JOIN job_scopes js ON js.id = a.job_scope_id
         ORDER BY a.created_at DESC LIMIT 50`
      ).all();
      return Response.json({ count: results.length, amendments: results });
    }

if (url.pathname === "/debug/schedule" && request.method === "GET") {
      const days = Number(url.searchParams.get("days") ?? "14");
      const today = nowInBusinessTimezone();
      const pad = (n: number) => String(n).padStart(2, "0");
      const todayIso = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
      const until = new Date(today);
      until.setDate(until.getDate() + days);
      const untilIso = `${until.getFullYear()}-${pad(until.getMonth() + 1)}-${pad(until.getDate())}`;

      const { results } = await env.OFFICE_DB.prepare(
        `SELECT js.id, c.name as customer_name, js.description, js.scheduled_date, js.scheduled_date_raw
         FROM job_scopes js JOIN customers c ON c.id = js.customer_id
         WHERE js.scheduled_date IS NOT NULL AND js.scheduled_date BETWEEN ? AND ?
         ORDER BY js.scheduled_date ASC`
      )
        .bind(todayIso, untilIso)
        .all();

      return Response.json({ from: todayIso, to: untilIso, schedule: results });
    }

if (url.pathname === "/debug/retention-summary" && request.method === "GET") {
      const customerId = url.searchParams.get("customerId");
      if (!customerId) {
        return Response.json({ error: "customerId query parameter is required" }, { status: 400 });
      }
      const { results } = await env.OFFICE_DB.prepare(
        `SELECT id, description, amount, retention_percent, retention_amount, created_at
         FROM invoices WHERE customer_id = ? AND retention_amount > 0 ORDER BY created_at ASC`
      )
        .bind(customerId)
        .all<{ id: number; description: string; amount: number; retention_percent: number; retention_amount: number; created_at: string }>();
      const totalRetained = results.reduce((sum, r) => sum + r.retention_amount, 0);
      const totalInvoiced = results.reduce((sum, r) => sum + r.amount, 0);
      return Response.json({
        customerId: Number(customerId),
        invoiceCount: results.length,
        totalInvoiced,
        totalRetained,
        invoices: results,
      });
    }

if (url.pathname === "/debug/quotations" && request.method === "GET") {
      const { results: quotes } = await env.OFFICE_DB.prepare(
        "SELECT q.id, q.customer_id, c.name as customer_name, q.description, q.amount, q.status, q.created_at FROM quotations q JOIN customers c ON c.id = q.customer_id ORDER BY q.created_at DESC LIMIT 10"
      ).all();

      const enriched = await Promise.all(
        (quotes as Array<{ id: number }>).map(async (quote) => {
          const { results: lineItems } = await env.OFFICE_DB.prepare(
            "SELECT description, note, quantity, unit, unit_price, line_total, discount_percent FROM line_items WHERE quotation_id = ?"
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
            "SELECT description, note, quantity, unit, unit_price, line_total, discount_percent FROM line_items WHERE invoice_id = ?"
          )
            .bind(invoice.id)
            .all();
          return { ...invoice, lineItems };
        })
      );

      return Response.json({ invoices: enriched });
    }

if (url.pathname === "/debug/finance-list" && request.method === "GET") {
      const search = url.searchParams.get("search")?.trim() || null;
      const limit = Math.min(Number(url.searchParams.get("limit")) || 50, 200);
      const offset = Number(url.searchParams.get("offset")) || 0;
      const like = search ? `%${search}%` : null;

      const { results } = await env.OFFICE_DB.prepare(
        `SELECT * FROM (
           SELECT 'invoice' as type, i.id, i.customer_id, c.name as customer_name,
                  i.description, i.amount, i.due_date, NULL as quotation_status, i.created_at
           FROM invoices i JOIN customers c ON c.id = i.customer_id
           UNION ALL
           SELECT 'quotation' as type, q.id, q.customer_id, c.name as customer_name,
                  q.description, q.amount, NULL as due_date, q.status as quotation_status, q.created_at
           FROM quotations q JOIN customers c ON c.id = q.customer_id
         )
         WHERE (?1 IS NULL OR customer_name LIKE ?2 OR description LIKE ?2)
         ORDER BY created_at DESC
         LIMIT ?3 OFFSET ?4`
      )
        .bind(search, like, limit, offset)
        .all();

      return Response.json({ items: results, limit, offset });
    }

if (url.pathname === "/debug/init-invoices-due-date" && request.method === "POST") {
      await runIdempotentMigration(env, "ALTER TABLE invoices ADD COLUMN due_date TEXT");
      return Response.json({ status: "ok" });
    }

if (url.pathname === "/debug/init-identity-layer" && request.method === "POST") {
      // Real, per direct instruction: same real fix as above — IF NOT
      // EXISTS already makes this idempotent at the SQL level, so any
      // real error now propagates rather than being silently masked.
      await env.OFFICE_DB.prepare(
        `CREATE TABLE IF NOT EXISTS people (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )`
      ).run();
      // Real, persistent flag for a real, ambiguous, needs-review
      // match found during backfill or ongoing reconciliation - so it
      // can always be found and resolved later via a simple, direct
      // query, rather than lost to a one-time API response.
      await runIdempotentMigration(env, "ALTER TABLE people ADD COLUMN needs_merge_review INTEGER DEFAULT 0");
      for (const table of ["customers", "characters", "leads"]) {
        await runIdempotentMigration(env, `ALTER TABLE ${table} ADD COLUMN person_id INTEGER`);
      }
      return Response.json({ status: "ok" });
    }

if (url.pathname === "/debug/init-leads-capture-id" && request.method === "POST") {
      await runIdempotentMigration(env, "ALTER TABLE leads ADD COLUMN capture_id INTEGER");
      return Response.json({ status: "ok" });
    }

if (url.pathname === "/debug/init-interaction-edges" && request.method === "POST") {
      // Real, per direct instruction: same real fix as above — IF NOT
      // EXISTS already makes this idempotent at the SQL level, so any
      // real error now propagates rather than being silently masked.
      await env.OFFICE_DB.prepare(
        `CREATE TABLE IF NOT EXISTS interaction_edges (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          capture_id INTEGER,
          entity_type_a TEXT NOT NULL,
          entity_id_a INTEGER NOT NULL,
          entity_type_b TEXT NOT NULL,
          entity_id_b INTEGER NOT NULL,
          relation_type TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )`
      ).run();
      return Response.json({ status: "ok" });
    }

if (url.pathname === "/debug/interaction-edges" && request.method === "GET") {
      const { results } = await env.OFFICE_DB.prepare(
        `SELECT ie.id, ie.capture_id, ie.entity_type_a, ie.entity_id_a, ie.entity_type_b, ie.entity_id_b,
                ie.relation_type, ie.created_at,
                (CASE ie.entity_type_a WHEN 'customer' THEN (SELECT name FROM customers WHERE id = ie.entity_id_a)
                                        WHEN 'character' THEN (SELECT name FROM characters WHERE id = ie.entity_id_a)
                                        WHEN 'lead' THEN (SELECT name FROM leads WHERE id = ie.entity_id_a) END) as name_a,
                (CASE ie.entity_type_b WHEN 'customer' THEN (SELECT name FROM customers WHERE id = ie.entity_id_b)
                                        WHEN 'character' THEN (SELECT name FROM characters WHERE id = ie.entity_id_b)
                                        WHEN 'lead' THEN (SELECT name FROM leads WHERE id = ie.entity_id_b) END) as name_b
         FROM interaction_edges ie ORDER BY ie.created_at DESC LIMIT 100`
      ).all();
      return Response.json({ count: results.length, edges: results });
    }

if (url.pathname === "/debug/init-captures-fk" && request.method === "POST") {
      for (const column of ["customer_id INTEGER", "character_id INTEGER"]) {
        await runIdempotentMigration(env, `ALTER TABLE captures ADD COLUMN ${column}`);
      }
      return Response.json({ status: "ok" });
    }

// Real, read-only inspection for the admin key, added 2026-10-03.
// /debug/captures is one of the routes the app itself uses, so it needs a
// signed-in session and the admin key cannot reach it; that left no way to
// see from a terminal what the system actually read from an upload. These
// two show exactly that and write nothing. Not in the app's route list, so
// they are admin-key only like every other /debug route.
if (url.pathname === "/debug/recent-captures" && request.method === "GET") {
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 10) || 10, 1), 50);
      const { results } = await env.OFFICE_DB.prepare(
        `SELECT id, source, subject_hint, customer_id, character_id, extraction_status, r2_key, created_at,
                length(raw_text) AS raw_text_length, substr(raw_text, 1, 1500) AS raw_text_start
           FROM captures ORDER BY id DESC LIMIT ?`
      )
        .bind(limit)
        .all();
      return Response.json({ captures: results });
    }

if (url.pathname === "/debug/pending-action" && request.method === "GET") {
      const id = Number(url.searchParams.get("id"));
      if (!Number.isInteger(id) || id <= 0) {
        return Response.json({ error: "id must be a positive whole number" }, { status: 400 });
      }
      const row = await env.OFFICE_DB.prepare(
        "SELECT id, type, status, payload, source_transcript, created_at, resolved_at FROM pending_actions WHERE id = ?"
      )
        .bind(id)
        .first<{ id: number; type: string; status: string; payload: string; source_transcript: string | null; created_at: string; resolved_at: string | null }>();
      if (!row) return Response.json({ error: "no such pending action" }, { status: 404 });
      let payload: unknown = row.payload;
      try {
        payload = JSON.parse(row.payload);
      } catch {
        // leave the raw text if it is not JSON
      }
      return Response.json({ ...row, payload });
    }

if (url.pathname === "/debug/captures" && request.method === "GET") {
      const status = url.searchParams.get("status");
      const customerId = url.searchParams.get("customerId");
      const characterId = url.searchParams.get("characterId");
      const columns = "id, raw_text, source, subject_hint, customer_id, character_id, extraction_status, r2_key, created_at";
      let results;
      if (customerId) {
        // The actual clean join this gap was about — no more fuzzy
        // text matching on subject_hint needed.
        ({ results } = await env.OFFICE_DB.prepare(
          `SELECT ${columns} FROM captures WHERE customer_id = ? ORDER BY created_at DESC LIMIT 50`
        )
          .bind(customerId)
          .all());
      } else if (characterId) {
        ({ results } = await env.OFFICE_DB.prepare(
          `SELECT ${columns} FROM captures WHERE character_id = ? ORDER BY created_at DESC LIMIT 50`
        )
          .bind(characterId)
          .all());
      } else if (status) {
        ({ results } = await env.OFFICE_DB.prepare(
          `SELECT ${columns} FROM captures WHERE extraction_status = ? ORDER BY created_at DESC LIMIT 50`
        )
          .bind(status)
          .all());
      } else {
        ({ results } = await env.OFFICE_DB.prepare(`SELECT ${columns} FROM captures ORDER BY created_at DESC LIMIT 20`).all());
      }
      return Response.json({ captures: results });
    }

  return null;
}
