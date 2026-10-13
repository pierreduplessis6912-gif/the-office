// The HTTP face of migration.ts: privileged admin routes (both admin keys) that export a business's data and import it into another. The same routes serve both directions: a deployment is the
// SOURCE when they are read from it, and the TARGET when they are written to it. Called from debug.ts; returns null for any other path.
import { vectorPrefix } from "./scoped-bindings";
import { fingerprint, listFiles, manifest, readNotes, readRows, ensureSchema, writeNotes, writeRows, writeSequences, type ColumnInfo } from "./migration";
import type { Env } from "./types";

const bad = (message: string, status = 400): Response => Response.json({ error: message }, { status });

export async function migrationRoute(request: Request, env: Env, url: URL): Promise<Response | null> {
  const path = url.pathname;
  if (!path.startsWith("/admin/migration/")) return null;
  const route = `${request.method} ${path.slice("/admin/migration".length)}`;
  try {
    switch (route) {
      // What am I? A business's object says which business; the single-business deployment says none. The runner asks BOTH ends before copying a byte, so a source and a target that are really the same
      // deployment (which would copy a database onto itself) can never be mistaken for two.
      case "GET /whoami":
        return Response.json({ businessId: env.BUSINESS_ID ?? null, objectMode: Boolean(env.BUSINESS_ID), vectorPrefix: env.BUSINESS_ID ? vectorPrefix(env.BUSINESS_ID) : null });
      case "GET /manifest":
        return Response.json(await manifest(env));
      case "GET /rows":
        return Response.json(await readRows(env, url.searchParams.get("table") ?? "", Number(url.searchParams.get("after") ?? 0), Number(url.searchParams.get("limit") ?? 200)));
      case "GET /notes":
        return Response.json(await readNotes(env, url.searchParams.get("cursor")));
      case "GET /files":
        return Response.json(await listFiles(env, url.searchParams.get("cursor")));
      case "GET /file": {
        const key = url.searchParams.get("key");
        if (!key) return bad("missing key");
        const object = await env.OFFICE_VAULT.get(key);
        if (!object) return bad("no such file", 404);
        return new Response(object.body, { headers: { "Content-Type": object.httpMetadata?.contentType ?? "application/octet-stream" } });
      }
      case "GET /fingerprint":
        return Response.json(await fingerprint(env));
      case "POST /schema": {
        const body = (await request.json()) as { tables?: { name: string; sql: string; columns: ColumnInfo[] }[] };
        if (!Array.isArray(body.tables)) return bad("missing tables");
        return Response.json(await ensureSchema(env, body.tables));
      }
      case "POST /rows": {
        const body = (await request.json()) as { table?: string; rows?: Record<string, unknown>[] };
        if (!body.table || !Array.isArray(body.rows)) return bad("missing table or rows");
        return Response.json({ written: await writeRows(env, body.table, body.rows) });
      }
      case "POST /sequences": {
        const body = (await request.json()) as { sequences?: { name: string; seq: number }[] };
        if (!Array.isArray(body.sequences)) return bad("missing sequences");
        return Response.json({ set: await writeSequences(env, body.sequences) });
      }
      case "POST /notes": {
        const body = (await request.json()) as { entries?: { key: string; value: string }[] };
        if (!Array.isArray(body.entries)) return bad("missing entries");
        return Response.json({ written: await writeNotes(env, body.entries) });
      }
      case "POST /file": {
        const key = url.searchParams.get("key");
        if (!key) return bad("missing key");
        await env.OFFICE_VAULT.put(key, await request.arrayBuffer(), { httpMetadata: { contentType: url.searchParams.get("type") ?? "application/octet-stream" } });
        return Response.json({ stored: key });
      }
      case "POST /vectors": {
        const body = (await request.json()) as { vectors?: { id: string; values: number[]; metadata?: Record<string, unknown> }[] };
        if (!Array.isArray(body.vectors)) return bad("missing vectors");
        // Vectorize applies a write asynchronously: the mutation id lets a caller wait until THAT write has been processed.
        const queued = body.vectors.length ? await env.MEMORY.upsert(body.vectors.map((v) => ({ id: v.id, values: v.values, metadata: v.metadata as Record<string, string | number | boolean> | undefined }))) : null;
        return Response.json({ written: body.vectors.length, mutationId: (queued as { mutationId?: string } | null)?.mutationId ?? null });
      }
      case "POST /vectors-by-ids": {
        const body = (await request.json()) as { ids?: string[] };
        if (!Array.isArray(body.ids)) return bad("missing ids");
        const found = await env.MEMORY.getByIds(body.ids);
        return Response.json({ vectors: found.map((v) => ({ id: v.id, values: Array.from(v.values as ArrayLike<number>), metadata: v.metadata ?? null })) });
      }
      // A diagnostic: search the memory index from THIS business's scoped view, so the isolation between businesses can be observed on the real index.
      case "POST /vectors-query": {
        const body = (await request.json()) as { vector?: number[]; topK?: number };
        if (!Array.isArray(body.vector)) return bad("missing vector");
        const found = await env.MEMORY.query(body.vector, { topK: Math.max(1, Math.min(20, Math.floor(body.topK ?? 5))), returnMetadata: "all" });
        return Response.json({ matches: found.matches.map((m) => ({ id: m.id, score: m.score, metadata: m.metadata ?? null })) });
      }
      default:
        return bad(`no such migration route: ${route}`, 404);
    }
  } catch (error) {
    return bad(String((error as { message?: string }).message ?? error));
  }
}
