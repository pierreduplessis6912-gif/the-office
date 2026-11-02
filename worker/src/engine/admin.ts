// Two admin routes so the engine's migration can be REHEARSED on real Cloudflare objects (branch engine-phase1). Called from debug.ts, handled INSIDE a business's object (an admin call names the business with
// X-Target-Business), exactly like the backup routes. Deliberately narrow:
//   GET  /admin/engine/status            tier read: the engine's state in one answer: mode, availability, a row count AND a content hash per engine table, and the integrity verifier's verdict. Read-only.
//   POST /admin/engine/provision-sample  tier PRIVILEGED (both admin secrets): puts an engine-EMPTY business into engine mode with a small known sample. It exists only where ENGINE_REHEARSAL=1 (a variable the
//                                        staging deployment sets and production does not have), needs the business id as confirmation, and refuses a business that already has engine data: it cannot top up or overwrite.
// The hashes are what the rehearsal compares before and after a restore, so they are a function of the rows only (tools/engine-admin.test.js proves they are stable, sensitive, and survive a restore).
import type { Env } from "../types";
import { setEngineMode, isEngineMode } from "./boundary";
import { availabilityOf } from "./availability";
import { CAPABILITY_IDS } from "./capabilities";
import { createDraft, saveDraft } from "./drafts";
import * as facts from "./facts";
import { verifyIntegrity } from "./integrity";
import { FACT_TABLES, MUTABLE_TABLES } from "./tables";

const bad = (message: string, status = 400): Response => Response.json({ error: message }, { status });

async function sha256(text: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function engineStatus(env: Env): Promise<Record<string, unknown>> {
  const tables: Record<string, number> = {};
  const hashes: Record<string, string> = {};
  let rows = 0;
  for (const t of [...FACT_TABLES, ...MUTABLE_TABLES]) {
    const all = ((await env.OFFICE_DB.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all<Record<string, unknown>>()).results ?? []);
    tables[t] = all.length;
    hashes[t] = await sha256(JSON.stringify(all));
    rows += all.length;
  }
  return { business: env.BUSINESS_ID ?? null, mode: (await isEngineMode(env)) ? "engine" : "legacy", available: await availabilityOf(env), rows, tables, hashes, integrity: await verifyIntegrity(env) };
}

// The known sample: two customers, two invoices, a payment recorded against the WRONG customer and corrected (so there are reversals), one open draft, one observation.
async function provisionSample(env: Env): Promise<void> {
  const ctx = { actorEmail: "engine-rehearsal@example.com", contract: "rehearsal", contractVersion: 1 };
  await setEngineMode(env, true);
  await env.OFFICE_DB.prepare("INSERT INTO eng_config (key, value_json) VALUES ('available', ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json").bind(JSON.stringify(CAPABILITY_IDS)).run();
  const a = (await facts.recordParty(env, { kind: "person", name: "Mokoena", roles: ["customer"] }, ctx)).id;
  const b = (await facts.recordParty(env, { kind: "organisation", name: "Patel Builders", roles: ["customer"] }, ctx)).id;
  const lines = (price: number, description: string) => [{ description, quantityMilli: 2000, unit: "m2", unitPriceMinor: price, taxBp: 1500 }];
  const i1 = await facts.recordDocument(env, { kind: "invoice", direction: "sell", partyId: a, currency: "ZAR", issuedOn: "2026-10-01", lines: lines(50000, "Vinyl plank") }, ctx);
  await facts.recordDocument(env, { kind: "invoice", direction: "sell", partyId: b, currency: "ZAR", issuedOn: "2026-10-02", lines: lines(20000, "Skirting") }, ctx);
  const wrong = await facts.recordPayment(env, { direction: "in", partyId: b, amountMinor: 30000, currency: "ZAR", occurredOn: "2026-10-20", allocations: [{ documentId: i1.id, amountMinor: 30000 }] }, ctx);
  await facts.correctMovement(env, { movementId: wrong.movementId, reason: "recorded against the wrong customer", replacement: { partyId: a, allocations: [{ documentId: i1.id, amountMinor: 30000 }] } }, ctx);
  const d = await createDraft(env, { kind: "invoice", direction: "sell", partyId: a }, ctx);
  await saveDraft(env, d.id, { expectedVersion: 1, payload: { currency: "ZAR", issuedOn: "2026-11-01", lines: lines(10000, "Fitting") } }, ctx);
  const capture = await env.OFFICE_DB.prepare("INSERT INTO captures (raw_text, source) VALUES ('can you book a skip?', 'text') RETURNING id").first<{ id: number }>();
  await env.OFFICE_DB.prepare("INSERT INTO eng_observation (capture_id, kind, note) VALUES (?, 'unsupported', 'book a skip')").bind(capture!.id).run();
}

export async function engineAdminRoute(request: Request, env: Env, url: URL): Promise<Response | null> {
  if (!url.pathname.startsWith("/admin/engine/")) return null;
  if (!env.BUSINESS_ID) return bad("the engine is per business: name one with X-Target-Business", 400);
  const route = `${request.method} ${url.pathname.slice("/admin/engine".length)}`;
  try {
    switch (route) {
      case "GET /status":
        return Response.json(await engineStatus(env));
      case "POST /provision-sample": {
        if (env.ENGINE_REHEARSAL !== "1") return bad("this route exists only on a rehearsal deployment", 404);
        const body = (await request.json().catch(() => null)) as { confirm?: string } | null;
        if (!body || body.confirm !== env.BUSINESS_ID) return bad("confirm must be the business id", 400);
        const now = await engineStatus(env);
        if ((now.rows as number) > 0 || now.mode !== "legacy") return bad("this business already has engine data, so nothing was done", 409);
        await provisionSample(env);
        return Response.json(await engineStatus(env));
      }
      default:
        return bad("no such engine admin route", 404);
    }
  } catch (error) {
    return bad(String((error as { message?: string }).message ?? error).slice(0, 300), 500);
  }
}
