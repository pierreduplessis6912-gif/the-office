// The HTTP face of backup.ts: admin routes, handled INSIDE a business's object (an admin call names the business with X-Target-Business). Called from debug.ts; returns null for any other path.
// status and list only read; run takes a snapshot now; restore and unlock are privileged (both admin keys).
import { KEEP_SNAPSHOTS, listSnapshots, readBackupMeta, recordBackupResult, restoreSnapshot, takeSnapshot, unlockBusiness } from "./backup";
import type { Env } from "./types";

const bad = (message: string, status = 400): Response => Response.json({ error: message }, { status });

export async function backupRoute(request: Request, env: Env, url: URL): Promise<Response | null> {
  if (!url.pathname.startsWith("/admin/backup/")) return null;
  if (!env.BUSINESS_ID) return bad("backups are per business: name one with X-Target-Business", 400);
  const route = `${request.method} ${url.pathname.slice("/admin/backup".length)}`;
  try {
    switch (route) {
      case "GET /status": {
        const meta = await readBackupMeta(env);
        const snapshots = env.BACKUPS ? await listSnapshots(env) : [];
        const newest = snapshots.filter((s) => s.complete).slice(-1)[0] ?? null;
        return Response.json({ business: env.BUSINESS_ID, backupBucketConfigured: Boolean(env.BACKUPS), keep: KEEP_SNAPSHOTS, ...meta, snapshots: snapshots.length, complete: snapshots.filter((s) => s.complete).length, newest, newestAgeHours: newest?.finishedAt ? Math.round(((Date.now() - Date.parse(newest.finishedAt)) / 3_600_000) * 10) / 10 : null });
      }
      case "GET /list":
        return Response.json({ snapshots: await listSnapshots(env) });
      case "POST /run": {
        const started = Date.now();
        try {
          const m = await takeSnapshot(env);
          await recordBackupResult(env, null);
          return Response.json({ snapshot: m.name, tables: m.tables.length, rows: m.tables.reduce((n, t) => n + t.rows, 0), notes: m.notes.count, files: m.files.count, filesMirroredNow: m.files.mirroredNow, ms: Date.now() - started });
        } catch (error) {
          await recordBackupResult(env, String((error as { message?: string }).message ?? error).slice(0, 300));
          throw error;
        }
      }
      case "POST /restore": {
        const body = (await request.json()) as { snapshot?: string; confirm?: string };
        if (!body.snapshot || !body.confirm) return bad('send {"snapshot": "<name>", "confirm": "<this business\'s id>"}');
        return Response.json(await restoreSnapshot(env, body.snapshot, body.confirm));
      }
      case "POST /unlock":
        await unlockBusiness(env);
        return Response.json({ unlocked: true });
      default:
        return bad(`no such backup route: ${route}`, 404);
    }
  } catch (error) {
    return bad(String((error as { message?: string }).message ?? error));
  }
}
