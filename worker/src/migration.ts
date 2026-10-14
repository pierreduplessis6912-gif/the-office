// Moving a business's data into (or out of) a business object, and proving it arrived intact.
//
// Architecture migration tooling, 2026-10-12 (DECISIONS.md). A business's data lives in four places and all four must move: the DATABASE rows (and the autoincrement id counters, or a deleted
// customer's id could be reused and inherit that customer's old notes), the NOTES store, the FILE storage, and the MEMORY index. The functions here are the Worker's half; a runner
// (tools/migrate-lib.mjs) drives them over HTTP and compares FINGERPRINTS from both sides. Everything is idempotent (INSERT OR REPLACE, create-if-missing), so an interrupted run is simply run again.
//
// They run against whatever `env` they are given. Inside a business's object that env is already scoped (scoped-bindings.ts), so an IMPORT lands under the business's own prefixes and namespace and an
// EXPORT can only ever return that business's data. Table names are never taken on trust: they must exist in the database, and column names must exist in the table.
import type { Env } from "./types";

// Telemetry and the shared layer's own tables are not a business's data and are never moved.
// `d1_migrations` is wrangler's own record of which schema files it has applied to a D1 database (found on the first real rehearsal: it was being copied as if it were business data).
export const SKIP_TABLES = new Set(["request_timings", "model_usage", "member_usage", "admin_audit", "object_meta", "idempotency_keys", "businesses", "directory_members", "sqlite_sequence", "d1_migrations"]);

// Every business's object keeps its notes under `b:<id>:` and its files under `b/<id>/` in the SAME notes store and bucket the single-business deployment uses (scoped-bindings.ts). The single-business
// deployment sees those stores UNSCOPED, so it would see the business's copies as if they were its own originals: the first real production copy reported double the notes and files, and a re-run would have
// copied the copies. These prefixes are reserved: an unscoped listing never includes them. (No original key starts with either.)
const RESERVED_NOTE_PREFIX = "b:";
const RESERVED_FILE_PREFIX = "b/";

export interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  dflt: string | null;
  pk: number;
}
export interface TableInfo {
  name: string;
  sql: string;
  columns: ColumnInfo[];
  rowidAlias: boolean;   // a single INTEGER PRIMARY KEY column IS the rowid, so the rowid must not also be written
  count: number;
  parents: string[];     // tables this one references (foreign keys), so a runner can copy parents first
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

export async function listTables(env: Env): Promise<string[]> {
  const { results } = await env.OFFICE_DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all<{ name: string }>();
  return (results ?? []).map((r) => r.name).filter((n) => !n.startsWith("sqlite_") && !n.startsWith("_cf_") && !SKIP_TABLES.has(n) && IDENT.test(n));
}

// A table name is only ever used after it has been found in the database itself.
async function knownTable(env: Env, name: string): Promise<string> {
  if (!IDENT.test(name) || !(await listTables(env)).includes(name)) throw new Error(`no such table: ${name}`);
  return name;
}

async function columnsOf(env: Env, table: string): Promise<ColumnInfo[]> {
  const { results } = await env.OFFICE_DB.prepare(`PRAGMA table_info("${table}")`).all<{ name: string; type: string; notnull: number; dflt_value: string | null; pk: number }>();
  return (results ?? []).map((c) => ({ name: c.name, type: c.type ?? "", notnull: c.notnull, dflt: c.dflt_value, pk: c.pk }));
}

export async function tableInfo(env: Env, name: string): Promise<TableInfo> {
  const table = await knownTable(env, name);
  const sqlRow = await env.OFFICE_DB.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").bind(table).first<{ sql: string }>();
  const columns = await columnsOf(env, table);
  const pks = columns.filter((c) => c.pk > 0);
  const count = (await env.OFFICE_DB.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).first<{ n: number }>())?.n ?? 0;
  const fks = await env.OFFICE_DB.prepare(`PRAGMA foreign_key_list("${table}")`).all<{ table: string }>();
  return {
    name: table,
    sql: sqlRow?.sql ?? "",
    columns,
    rowidAlias: pks.length === 1 && /^INTEGER$/i.test(pks[0].type),
    count,
    parents: [...new Set((fks.results ?? []).map((f) => f.table))],
  };
}

export async function sequences(env: Env): Promise<{ name: string; seq: number }[]> {
  try {
    const { results } = await env.OFFICE_DB.prepare("SELECT name, seq FROM sqlite_sequence ORDER BY name").all<{ name: string; seq: number }>();
    const tables = new Set(await listTables(env));
    return (results ?? []).filter((r) => tables.has(r.name));
  } catch (error) {
    if (/no such table/i.test(String((error as { message?: string }).message ?? error))) return [];   // no autoincrement table has been written yet
    throw error;
  }
}

export async function manifest(env: Env): Promise<{ tables: TableInfo[]; sequences: { name: string; seq: number }[] }> {
  const tables: TableInfo[] = [];
  for (const name of await listTables(env)) tables.push(await tableInfo(env, name));
  return { tables, sequences: await sequences(env) };
}

// ---- rows -------------------------------------------------------------------------------------------------------------------------------------------------------------
export async function readRows(env: Env, name: string, afterRowid: number, limit: number): Promise<{ rows: Record<string, unknown>[]; last: number | null }> {
  const table = await knownTable(env, name);
  const n = Math.max(1, Math.min(1000, Math.floor(limit) || 200));
  const { results } = await env.OFFICE_DB.prepare(`SELECT rowid AS "__rowid", * FROM "${table}" WHERE rowid > ? ORDER BY rowid LIMIT ?`).bind(Number(afterRowid) || 0, n).all<Record<string, unknown>>();
  const rows = results ?? [];
  return { rows, last: rows.length ? Number(rows[rows.length - 1].__rowid) : null };
}

// Creates a missing table (only from a plain CREATE TABLE statement for that very table) and adds any column the source has that this table lacks (a column added by a lazy ALTER).
export async function ensureSchema(env: Env, tables: { name: string; sql: string; columns: ColumnInfo[] }[]): Promise<{ created: string[]; columnsAdded: { table: string; column: string }[] }> {
  const created: string[] = [];
  const columnsAdded: { table: string; column: string }[] = [];
  const have = new Set(await listTables(env));
  for (const t of tables) {
    if (!IDENT.test(t.name) || SKIP_TABLES.has(t.name)) throw new Error(`not a table a migration may create: ${t.name}`);
    if (!have.has(t.name)) {
      const statement = t.sql.replace(/^\s*CREATE\s+TABLE\s+/i, "CREATE TABLE IF NOT EXISTS ");
      if (!new RegExp(`^CREATE TABLE IF NOT EXISTS\\s+"?${t.name}"?\\s*\\(`, "i").test(statement) || statement.includes(";")) throw new Error(`refusing to run this as the schema of ${t.name}`);
      await env.OFFICE_DB.prepare(statement).run();
      created.push(t.name);
      continue;
    }
    const existing = new Set((await columnsOf(env, t.name)).map((c) => c.name));
    for (const c of t.columns) {
      if (existing.has(c.name)) continue;
      if (!IDENT.test(c.name) || !/^[A-Za-z ]*$/.test(c.type)) throw new Error(`refusing to add column ${c.name} to ${t.name}`);
      await env.OFFICE_DB.prepare(`ALTER TABLE "${t.name}" ADD COLUMN "${c.name}" ${c.type}`).run();   // nullable: every imported row supplies its value
      columnsAdded.push({ table: t.name, column: c.name });
    }
  }
  return { created, columnsAdded };
}

// The order tables must be FILLED in (a parent before every table that points at it); EMPTY them in the reverse. Worked out from the schema's own foreign keys. A table that points at itself, or tables that point at each
// other in a circle, have no such order: that is an error here (raised before anything is changed), never a failure half way through. The schema has one foreign key today (payments -> customers).
export async function tablesParentsFirst(env: Env, tables: string[]): Promise<string[]> {
  const wanted = new Set(tables);
  const parents = new Map<string, string[]>();
  for (const t of tables) {
    const { results } = await env.OFFICE_DB.prepare(`PRAGMA foreign_key_list("${t}")`).all<{ table: string }>();
    parents.set(t, [...new Set((results ?? []).map((r) => r.table).filter((p) => wanted.has(p)))]);
  }
  const done = new Set<string>(), visiting = new Set<string>(), order: string[] = [];
  const visit = (t: string, path: string[]): void => {
    if (done.has(t)) return;
    if (visiting.has(t)) throw new Error(`tables point at each other in a circle (${[...path, t].join(" -> ")}): there is no order to restore them in`);
    visiting.add(t);
    for (const p of parents.get(t) ?? []) visit(p, [...path, t]);
    visiting.delete(t);
    done.add(t);
    order.push(t);
  };
  for (const t of tables) visit(t, []);
  return order;
}

// The statements that write these rows (INSERT OR REPLACE, one per row), not yet run: writeRows runs them as one batch; a restore runs them one by one inside its own transaction.
export async function rowStatements(env: Env, name: string, rows: Record<string, unknown>[]): Promise<D1PreparedStatement[]> {
  const table = await knownTable(env, name);
  if (!rows.length) return [];
  const cols = await columnsOf(env, table);
  const allowed = new Set(cols.map((c) => c.name));
  const pks = cols.filter((c) => c.pk > 0);
  const rowidAlias = pks.length === 1 && /^INTEGER$/i.test(pks[0].type);
  const statements: D1PreparedStatement[] = [];
  for (const row of rows) {
    const names = Object.keys(row).filter((k) => k !== "__rowid");
    for (const k of names) if (!allowed.has(k)) throw new Error(`${table} has no column ${k}`);
    const columns = rowidAlias ? names : ["rowid", ...names];
    const values = rowidAlias ? names.map((k) => row[k]) : [row.__rowid, ...names.map((k) => row[k])];
    statements.push(env.OFFICE_DB.prepare(`INSERT OR REPLACE INTO "${table}" (${columns.map((c) => `"${c}"`).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).bind(...values));
  }
  return statements;
}

export async function writeRows(env: Env, name: string, rows: Record<string, unknown>[]): Promise<number> {
  const statements = await rowStatements(env, name, rows);
  if (!statements.length) return 0;
  await env.OFFICE_DB.batch([env.OFFICE_DB.prepare("PRAGMA defer_foreign_keys = ON"), ...statements]);   // one transaction per page: a page is all in or all out
  return rows.length;
}

// The autoincrement counters. Without them a row deleted at the top of a table would have its id handed out again, and a new record would inherit the old one's notes (keyed by id).
export async function writeSequences(env: Env, seqs: { name: string; seq: number }[]): Promise<number> {
  const tables = new Set(await listTables(env));
  let set = 0;
  for (const s of seqs) {
    if (!tables.has(s.name) || !Number.isFinite(s.seq)) throw new Error(`not a table with a counter: ${s.name}`);
    const updated = await env.OFFICE_DB.prepare("UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name = ?").bind(s.seq, s.name).run();
    if (!updated.meta.changes) await env.OFFICE_DB.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)").bind(s.name, s.seq).run();
    set++;
  }
  return set;
}

// ---- notes ------------------------------------------------------------------------------------------------------------------------------------------------------------
export async function readNotes(env: Env, cursor: string | null): Promise<{ entries: { key: string; value: string }[]; cursor: string | null; complete: boolean }> {
  const listed = await env.CUSTOMER_NOTES.list({ limit: 100, ...(cursor ? { cursor } : {}) });
  const entries: { key: string; value: string }[] = [];
  for (const k of listed.keys) {
    if (!env.BUSINESS_ID && k.name.startsWith(RESERVED_NOTE_PREFIX)) continue;   // a business's own copy, not an original
    const value = await env.CUSTOMER_NOTES.get(k.name);
    if (value !== null) entries.push({ key: k.name, value });
  }
  return { entries, cursor: listed.list_complete ? null : (listed as unknown as { cursor: string }).cursor, complete: listed.list_complete };
}

export async function writeNotes(env: Env, entries: { key: string; value: string }[]): Promise<number> {
  for (const e of entries) {
    if (typeof e.key !== "string" || !e.key || typeof e.value !== "string") throw new Error("a note needs a key and a text value");
    await env.CUSTOMER_NOTES.put(e.key, e.value);
  }
  return entries.length;
}

// ---- files ------------------------------------------------------------------------------------------------------------------------------------------------------------
export async function listFiles(env: Env, cursor: string | null): Promise<{ objects: { key: string; size: number }[]; cursor: string | null; truncated: boolean }> {
  const listed = await env.OFFICE_VAULT.list({ limit: 100, ...(cursor ? { cursor } : {}) });
  return { objects: listed.objects.filter((o) => env.BUSINESS_ID || !o.key.startsWith(RESERVED_FILE_PREFIX)).map((o) => ({ key: o.key, size: o.size })), cursor: listed.truncated ? (listed as unknown as { cursor: string }).cursor : null, truncated: listed.truncated };
}

// ---- fingerprints -----------------------------------------------------------------------------------------------------------------------------------------------------
// A fingerprint is a count and an ORDER-INDEPENDENT sum of per-item SHA-256 prefixes, so it does not matter in what order, or on what page, things arrived. A single changed cell, a missing
// row or an extra row changes it.
const MASK = (1n << 64n) - 1n;
async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function foldHash(acc: bigint, data: string | Uint8Array): Promise<bigint> {
  return (acc + BigInt("0x" + (await sha256Hex(data)).slice(0, 16))) & MASK;
}
const hex64 = (n: bigint): string => n.toString(16).padStart(16, "0");
const canonical = (row: Record<string, unknown>): string => JSON.stringify(Object.fromEntries(Object.entries(row).filter(([k]) => k !== "__rowid").sort(([a], [b]) => (a < b ? -1 : 1))));

export interface Fingerprint {
  tables: Record<string, { count: number; hash: string }>;
  sequences: Record<string, number>;
  notes: { count: number; hash: string };
  files: { count: number; hash: string };
}

export async function fingerprint(env: Env): Promise<Fingerprint> {
  const tables: Fingerprint["tables"] = {};
  for (const name of await listTables(env)) {
    let acc = 0n, count = 0, after = 0;
    for (;;) {
      const page = await readRows(env, name, after, 500);
      for (const row of page.rows) { acc = await foldHash(acc, canonical(row)); count++; }
      if (page.last === null) break;
      after = page.last;
    }
    tables[name] = { count, hash: hex64(acc) };
  }
  const seqs: Record<string, number> = {};
  for (const s of await sequences(env)) seqs[s.name] = s.seq;
  let nAcc = 0n, nCount = 0, cursor: string | null = null;
  if (env.CUSTOMER_NOTES) {
    do {
      const page = await readNotes(env, cursor);
      for (const e of page.entries) { nAcc = await foldHash(nAcc, `${e.key}\u0000${e.value}`); nCount++; }
      cursor = page.cursor;
    } while (cursor);
  }
  let fAcc = 0n, fCount = 0, fCursor: string | null = null;
  if (env.OFFICE_VAULT) {
    do {
      const page = await listFiles(env, fCursor);
      for (const o of page.objects) {
        const body = await env.OFFICE_VAULT.get(o.key);
        const bytes = body ? new Uint8Array(await body.arrayBuffer()) : new Uint8Array();
        fAcc = await foldHash(fAcc, `${o.key}\u0000${bytes.length}\u0000${await sha256Hex(bytes)}`);
        fCount++;
      }
      fCursor = page.cursor;
    } while (fCursor);
  }
  return { tables, sequences: seqs, notes: { count: nCount, hash: hex64(nAcc) }, files: { count: fCount, hash: hex64(fAcc) } };
}

// What differs between two fingerprints (empty means identical). Telemetry and shared-layer tables never appear, and a table only in the target is not a difference.
export function compareFingerprints(source: Fingerprint, target: Fingerprint): string[] {
  const out: string[] = [];
  for (const [name, s] of Object.entries(source.tables)) {
    const t = target.tables[name];
    if (!t) out.push(`table ${name}: missing in the target`);
    else if (t.count !== s.count) out.push(`table ${name}: ${s.count} rows in the source, ${t.count} in the target`);
    else if (t.hash !== s.hash) out.push(`table ${name}: same row count (${s.count}) but the contents differ`);
  }
  for (const [name, seq] of Object.entries(source.sequences)) if ((target.sequences[name] ?? 0) < seq) out.push(`id counter ${name}: ${seq} in the source, ${target.sequences[name] ?? 0} in the target`);
  for (const kind of ["notes", "files"] as const) {
    if (source[kind].count !== target[kind].count) out.push(`${kind}: ${source[kind].count} in the source, ${target[kind].count} in the target`);
    else if (source[kind].hash !== target[kind].hash) out.push(`${kind}: same count (${source[kind].count}) but the contents differ`);
  }
  return out;
}
