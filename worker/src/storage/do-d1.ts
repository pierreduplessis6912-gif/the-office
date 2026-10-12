// A D1-compatible database over a Durable Object's own SQLite storage (ctx.storage.sql).
//
// Architecture trial, 2026-10-12 (see DECISIONS.md, "Database architecture"). The Worker's code talks to its database through a very small surface (prepare,
// bind, run, all, first, one batch). This class offers exactly that surface on top of the SQLite that lives INSIDE a Durable Object, so the whole application can run
// next to its data (local queries, no network round trip per statement) without rewriting the 488 queries. It is as strict as D1: binding undefined or a boolean
// throws. A Durable Object's storage is synchronous, so each method does its work at once and merely returns a promise.
export interface SqlCursorLike {
  toArray(): Record<string, unknown>[];
  readonly rowsRead: number;
  readonly rowsWritten: number;
}
export interface SqlStorageLike {
  exec(query: string, ...bindings: unknown[]): SqlCursorLike;
}
export interface StorageLike {
  transactionSync<T>(closure: () => T): T;
}

export interface DoMeta {
  changes: number;
  last_row_id: number;
  rows_read: number;
  rows_written: number;
  duration: number;
}
export interface DoResult {
  results: Record<string, unknown>[];
  success: true;
  meta: DoMeta;
}

const WRITES = /^\s*(insert|update|delete|replace)\b/i;

function checkBindings(values: unknown[]): (string | number | null | ArrayBuffer)[] {
  return values.map((v, i) => {
    if (v === undefined) throw new TypeError(`D1_TYPE_ERROR: Type 'undefined' not supported for value 'undefined' (parameter ${i + 1})`);
    if (typeof v === "boolean") throw new TypeError(`D1_TYPE_ERROR: Type 'boolean' not supported for value '${v}' (parameter ${i + 1})`);
    return v as string | number | null | ArrayBuffer;
  });
}

export class DoStatement {
  constructor(
    private readonly db: DoD1Database,
    readonly query: string,
    private readonly values: unknown[] = []
  ) {}

  bind(...values: unknown[]): DoStatement {
    return new DoStatement(this.db, this.query, values);
  }

  // Runs the statement now and returns its rows and metadata. Used by the async methods and by batch().
  runSync(): DoResult {
    const cursor = this.db.sql.exec(this.query, ...checkBindings(this.values));
    const results = cursor.toArray();
    const meta: DoMeta = { changes: 0, last_row_id: 0, rows_read: cursor.rowsRead, rows_written: cursor.rowsWritten, duration: 0 };
    if (WRITES.test(this.query)) {
      // The count of rows a write changed, and the id it inserted, are asked of the database straight after: a local call, not a network trip.
      const after = this.db.sql.exec("SELECT changes() AS changes, last_insert_rowid() AS last_row_id").toArray()[0];
      meta.changes = Number(after?.changes ?? 0);
      meta.last_row_id = Number(after?.last_row_id ?? 0);
    }
    return { results, success: true, meta };
  }

  async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
    const row = this.runSync().results[0] ?? null;
    if (column && row) return (row as Record<string, unknown>)[column] as T;
    return row as T | null;
  }
  async all<T = Record<string, unknown>>(): Promise<{ results: T[]; success: true; meta: DoMeta }> {
    const r = this.runSync();
    return { results: r.results as T[], success: true, meta: r.meta };
  }
  async run(): Promise<{ success: true; meta: DoMeta; results: [] }> {
    const r = this.runSync();
    return { success: true, meta: r.meta, results: [] };
  }
  async raw(): Promise<unknown[][]> {
    return this.runSync().results.map((row) => Object.values(row));
  }
}

export class DoD1Database {
  constructor(
    readonly sql: SqlStorageLike,
    private readonly storage: StorageLike
  ) {}

  prepare(query: string): DoStatement {
    return new DoStatement(this, query);
  }

  // D1 runs a batch as one transaction: if any statement fails, none of it happened. transactionSync gives the same guarantee here.
  async batch(statements: DoStatement[]): Promise<DoResult[]> {
    return this.storage.transactionSync(() => statements.map((s) => s.runSync()));
  }

  async exec(query: string): Promise<{ count: number; duration: number }> {
    this.sql.exec(query);
    return { count: 1, duration: 0 };
  }
}
