// Backup and restore of a business's data, from inside its own object.
//
// Added 2026-10-13, right after the cutover, because the real business now lives in ONE place (its object) and the old database is stale. A SNAPSHOT is every table (as compressed JSON lines), the id counters,
// the notes, an inventory of the files, and a fingerprint of all of it, stored in a SEPARATE bucket (`BACKUPS`) under the business's own folder. Each part is checksummed, and the manifest is written LAST, so a
// snapshot that did not finish has no manifest and is never mistaken for a good one. Files are mirrored INCREMENTALLY (they never change once written), so deleting one by accident is not permanent.
// RESTORE verifies the snapshot's checksums BEFORE it touches anything, first takes a safety snapshot of the current state (so the restore is itself reversible), locks the business to admins while it runs,
// rebuilds from the snapshot, and then compares the result with the fingerprint recorded at snapshot time. The memory index (derived data held by Cloudflare) is not covered.
import { compareFingerprints, fingerprint, listFiles, listTables, readNotes, readRows, sequences, tableInfo, writeNotes, writeRows, ensureSchema, type ColumnInfo, type Fingerprint } from "./migration";
import type { Env } from "./types";

export const KEEP_SNAPSHOTS = 14;
export const SNAPSHOT_NAME = /^\d{8}T\d{6}Z(-pre-restore)?$/;

interface Part {
  key: string;
  bytes: number;
  sha256: string;
}
export interface Manifest {
  version: 1;
  business: string;
  name: string;
  startedAt: string;
  finishedAt: string;
  complete: true;
  tables: { name: string; sql: string; columns: ColumnInfo[]; rows: number; part: Part }[];
  sequences: { name: string; seq: number }[];
  notes: { count: number; part: Part };
  files: { count: number; bytes: number; inventory: Part; mirroredNow: number };
  fingerprint: Fingerprint;
}

const enc = new TextEncoder();
async function sha256(bytes: Uint8Array): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function gzip(text: string): Promise<Uint8Array> {
  return new Uint8Array(await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
}
async function gunzip(bytes: Uint8Array): Promise<string> {
  return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
}
export const snapshotName = (when: Date, suffix = ""): string => when.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z") + suffix;

function bucketOf(env: Env): R2Bucket {
  if (!env.BACKUPS) throw new Error("no backup bucket is configured (BACKUPS)");
  return env.BACKUPS;
}
function businessOf(env: Env): string {
  if (!env.BUSINESS_ID) throw new Error("backups are per business: this is not a business's object");
  return env.BUSINESS_ID;
}
const keyOf = (business: string, name: string, rest: string): string => `${business}/${name}/${rest}`;

async function putPart(bucket: R2Bucket, key: string, text: string): Promise<Part> {
  const bytes = await gzip(text);
  await bucket.put(key, bytes, { httpMetadata: { contentType: "application/gzip" } });
  return { key, bytes: bytes.length, sha256: await sha256(bytes) };
}
async function getPart(bucket: R2Bucket, part: Part): Promise<string> {
  const object = await bucket.get(part.key);
  if (!object) throw new Error(`a part of the snapshot is missing: ${part.key}`);
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (bytes.length !== part.bytes || (await sha256(bytes)) !== part.sha256) throw new Error(`a part of the snapshot is damaged (its checksum does not match): ${part.key}`);
  return gunzip(bytes);
}

// ---- taking a snapshot -----------------------------------------------------------------------------------------------------------------------------------------------------------
export async function takeSnapshot(env: Env, now: Date = new Date(), suffix = ""): Promise<Manifest> {
  const bucket = bucketOf(env), business = businessOf(env);
  const name = snapshotName(now, suffix);
  const startedAt = new Date().toISOString();
  const tables: Manifest["tables"] = [];
  for (const table of await listTables(env)) {
    const info = await tableInfo(env, table);
    const lines: string[] = [];
    for (let after = 0; ;) {
      const page = await readRows(env, table, after, 500);
      if (page.last === null) break;
      for (const row of page.rows) lines.push(JSON.stringify(row));
      after = page.last;
    }
    tables.push({ name: table, sql: info.sql, columns: info.columns, rows: lines.length, part: await putPart(bucket, keyOf(business, name, `tables/${table}.jsonl.gz`), lines.join("\n")) });
  }
  const noteLines: string[] = [];
  for (let cursor: string | null = null; ;) {
    const page = await readNotes(env, cursor);
    for (const e of page.entries) noteLines.push(JSON.stringify(e));
    cursor = page.cursor;
    if (!cursor) break;
  }
  const notes = { count: noteLines.length, part: await putPart(bucket, keyOf(business, name, "notes.jsonl.gz"), noteLines.join("\n")) };

  // Files never change once written, so they are MIRRORED (only the ones not yet in the backup bucket), and the snapshot records an inventory of them.
  const inventory: { key: string; size: number }[] = [];
  let mirroredNow = 0;
  for (let cursor: string | null = null; ;) {
    const page = await listFiles(env, cursor);
    for (const o of page.objects) {
      inventory.push(o);
      const mirror = `${business}/files/${o.key}`;
      if (!(await bucket.head(mirror))) {
        const file = await env.OFFICE_VAULT.get(o.key);
        if (file) { await bucket.put(mirror, await file.arrayBuffer(), { httpMetadata: { contentType: file.httpMetadata?.contentType ?? "application/octet-stream" } }); mirroredNow++; }
      }
    }
    cursor = page.cursor;
    if (!cursor) break;
  }
  const manifest: Manifest = {
    version: 1, business, name, startedAt, finishedAt: "", complete: true, tables, sequences: await sequences(env), notes,
    files: { count: inventory.length, bytes: inventory.reduce((n, f) => n + f.size, 0), inventory: await putPart(bucket, keyOf(business, name, "files-inventory.json.gz"), JSON.stringify(inventory)), mirroredNow },
    fingerprint: await fingerprint(env),
  };
  manifest.finishedAt = new Date().toISOString();
  await bucket.put(keyOf(business, name, "manifest.json"), JSON.stringify(manifest), { httpMetadata: { contentType: "application/json" } });   // written LAST: no manifest, no snapshot
  await applyRetention(env);
  return manifest;
}

export async function listSnapshotNames(env: Env): Promise<string[]> {
  const bucket = bucketOf(env), business = businessOf(env);
  const names: string[] = [];
  for (let cursor: string | undefined; ;) {
    const page = await bucket.list({ prefix: `${business}/`, delimiter: "/", ...(cursor ? { cursor } : {}) });
    for (const p of page.delimitedPrefixes ?? []) { const n = p.slice(business.length + 1, -1); if (SNAPSHOT_NAME.test(n)) names.push(n); }
    if (!page.truncated) break;
    cursor = (page as unknown as { cursor?: string }).cursor;
  }
  return names.sort();
}

export async function readManifest(env: Env, name: string): Promise<Manifest | null> {
  if (!SNAPSHOT_NAME.test(name)) throw new Error("not a snapshot name");
  const object = await bucketOf(env).get(keyOf(businessOf(env), name, "manifest.json"));
  if (!object) return null;
  const manifest = JSON.parse(await object.text()) as Manifest;
  return manifest.complete === true && manifest.business === businessOf(env) && manifest.name === name ? manifest : null;
}

export async function listSnapshots(env: Env): Promise<{ name: string; complete: boolean; finishedAt: string | null; tables: number; rows: number; notes: number; files: number }[]> {
  const out = [];
  for (const name of await listSnapshotNames(env)) {
    const m = await readManifest(env, name);
    out.push({ name, complete: m !== null, finishedAt: m?.finishedAt ?? null, tables: m?.tables.length ?? 0, rows: m?.tables.reduce((n, t) => n + t.rows, 0) ?? 0, notes: m?.notes.count ?? 0, files: m?.files.count ?? 0 });
  }
  return out;
}

// Keep the newest KEEP_SNAPSHOTS; delete everything under the older ones (and only under this business's own folder).
export async function applyRetention(env: Env, keep: number = KEEP_SNAPSHOTS): Promise<string[]> {
  const bucket = bucketOf(env), business = businessOf(env);
  const old = (await listSnapshotNames(env)).slice(0, Math.max(0, (await listSnapshotNames(env)).length - keep));
  for (const name of old) {
    for (let cursor: string | undefined; ;) {
      const page = await bucket.list({ prefix: `${business}/${name}/`, ...(cursor ? { cursor } : {}) });
      if (page.objects.length) await bucket.delete(page.objects.map((o) => o.key));
      if (!page.truncated) break;
      cursor = (page as unknown as { cursor?: string }).cursor;
    }
  }
  return old;
}

// ---- restoring ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------
export interface RestoreReport {
  ok: boolean;
  snapshot: string;
  safetySnapshot: string | null;
  tablesRestored: number;
  rowsRestored: number;
  notesRestored: number;
  filesRestoredFromMirror: number;
  filesMissingEverywhere: string[];
  differences: string[];
}

async function setMeta(env: Env, key: string, value: string): Promise<void> {
  await env.OFFICE_DB.prepare("INSERT INTO object_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(key, value).run();
}

export async function restoreSnapshot(env: Env, name: string, confirm: string): Promise<RestoreReport> {
  const bucket = bucketOf(env), business = businessOf(env);
  if (confirm !== business) throw new Error(`to restore, confirm by sending this business's id (${business}) as "confirm"`);
  const manifest = await readManifest(env, name);
  if (!manifest) throw new Error("no complete snapshot of that name (a snapshot without its manifest never finished)");

  // 1. Everything the snapshot holds is read and CHECKSUMMED before anything is changed: a damaged snapshot must never be half-applied.
  const tableText = new Map<string, string>();
  for (const t of manifest.tables) tableText.set(t.name, await getPart(bucket, t.part));
  const notesText = await getPart(bucket, manifest.notes.part);
  const inventory = JSON.parse(await getPart(bucket, manifest.files.inventory)) as { key: string; size: number }[];

  // 2. A safety snapshot of the current state, so the restore itself can be undone.
  const safety = await takeSnapshot(env, new Date(), "-pre-restore");

  // 3. The business is locked to admins while the data is replaced (business-object.ts refuses everything else with a 503).
  await setMeta(env, "restoring", "1");
  try {
    await ensureSchema(env, manifest.tables.map((t) => ({ name: t.name, sql: t.sql, columns: t.columns })));
    for (const table of await listTables(env)) await env.OFFICE_DB.prepare(`DELETE FROM "${table}"`).run();
    let rows = 0;
    for (const t of manifest.tables) {
      const parsed = (tableText.get(t.name) ?? "").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
      for (let i = 0; i < parsed.length; i += 200) rows += await writeRows(env, t.name, parsed.slice(i, i + 200));
    }
    for (const s of manifest.sequences) {
      const done = await env.OFFICE_DB.prepare("UPDATE sqlite_sequence SET seq = ? WHERE name = ?").bind(s.seq, s.name).run();   // EXACT, not the highest of the two: the old counters may be ahead of the snapshot's
      if (!done.meta.changes) await env.OFFICE_DB.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)").bind(s.name, s.seq).run();
    }
    // notes: the business's notes are replaced by the snapshot's
    for (let cursor: string | null = null; ;) {
      const page = await readNotes(env, cursor);
      for (const e of page.entries) await env.CUSTOMER_NOTES.delete(e.key);
      cursor = page.cursor;
      if (!cursor) break;
    }
    const notes = notesText.split("\n").filter(Boolean).map((l) => JSON.parse(l) as { key: string; value: string });
    await writeNotes(env, notes);
    // files: nothing is deleted; any file the snapshot lists that is missing now is copied back from the mirror
    const present = new Set<string>();
    for (let cursor: string | null = null; ;) {
      const page = await listFiles(env, cursor);
      for (const o of page.objects) present.add(o.key);
      cursor = page.cursor;
      if (!cursor) break;
    }
    let fromMirror = 0;
    const missing: string[] = [];
    for (const f of inventory) {
      if (present.has(f.key)) continue;
      const mirror = await bucket.get(`${business}/files/${f.key}`);
      if (!mirror) { missing.push(f.key); continue; }
      await env.OFFICE_VAULT.put(f.key, await mirror.arrayBuffer(), { httpMetadata: { contentType: mirror.httpMetadata?.contentType ?? "application/octet-stream" } });
      fromMirror++;
    }
    // 4. Compare with what the snapshot recorded about itself.
    // (A restore deletes no file, so files ADDED since the snapshot are expected: the file comparison is left out and replaced by the explicit "missing from both" check above.)
    const differences = compareFingerprints(manifest.fingerprint, await fingerprint(env)).filter((d) => !d.startsWith("files:"));
    return { ok: differences.length === 0 && missing.length === 0, snapshot: name, safetySnapshot: safety.name, tablesRestored: manifest.tables.length, rowsRestored: rows, notesRestored: notes.length, filesRestoredFromMirror: fromMirror, filesMissingEverywhere: missing, differences };
  } finally {
    await setMeta(env, "restoring", "0");
  }
}

// What the daily job last did, kept in the object so it can be asked (and so an alert can tell a quiet failure from a healthy night).
export interface BackupMeta {
  lastSuccessAt: string | null;
  lastAttemptOk: boolean | null;
  lastError: string | null;
}
export async function readBackupMeta(env: Env): Promise<BackupMeta> {
  const get = async (key: string): Promise<string | null> => (await env.OFFICE_DB.prepare("SELECT value FROM object_meta WHERE key = ?").bind(key).first<{ value: string }>())?.value ?? null;
  const ok = await get("last_backup_ok");
  return { lastSuccessAt: (await get("last_backup_success_at")) || null, lastAttemptOk: ok === null ? null : ok === "1", lastError: (await get("last_backup_error")) || null };
}
export async function recordBackupResult(env: Env, error: string | null): Promise<void> {
  await setMeta(env, "last_backup_ok", error === null ? "1" : "0");
  await setMeta(env, "last_backup_error", error ?? "");
  if (error === null) await setMeta(env, "last_backup_success_at", new Date().toISOString());
}
export async function unlockBusiness(env: Env): Promise<void> {
  await setMeta(env, "restoring", "0");
}
