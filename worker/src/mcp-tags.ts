// EXACT tagging of what an assistant's call creates (MCP stage 2 undo; MCP_ARCHITECTURE.md). Stage 2 first tagged a call's records by "ids above the highest before the call", which could tag someone else's record made at the same moment. This does it exactly: the pipeline is handed a copy of the environment whose database reports every row it INSERTS into one of the tracked tables, and only that call's own statements pass through it, so a record made by anyone else can never be tagged. Nothing in the pipeline changes: it still calls env.OFFICE_DB.prepare(...).
// WHAT IS TRACKED: the records an owner would want to undo (an invoice, a quote, a job, an expense, a task, a payment received). A customer, a stock item or a note the call also made is not tracked and is not undone.
// HOW AN ID IS LEARNED: from a statement's RETURNING id (first/all), or from the write's last row id (run), the two ways the pipeline inserts. A tracked insert whose id cannot be learned is COUNTED (untraced), never silently dropped, so the answer can say an undo may be incomplete.
import type { Env } from "./types";

export const TRACKED_TABLES = ["invoices", "quotations", "expenses", "tasks", "job_scopes", "payments"] as const;
export type TrackedTable = (typeof TRACKED_TABLES)[number];
const INSERT = /^\s*INSERT\s+(?:OR\s+\w+\s+)?INTO\s+"?(invoices|quotations|expenses|tasks|job_scopes|payments)"?\s*[\s(]/i;

export interface TagSink { record: (table: TrackedTable, id: number) => void; untraced: () => void }

const idOf = (value: unknown): number | null => (typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null);

function wrapStatement(statement: any, table: TrackedTable | null, sink: TagSink, returning: boolean): any {
  return new Proxy(statement, {
    get(target, prop) {
      if (prop === "bind") return (...values: unknown[]) => wrapStatement(target.bind(...values), table, sink, returning);
      if (table !== null && (prop === "run" || prop === "first" || prop === "all")) {
        return async (...args: unknown[]) => {
          const result = await target[prop](...args);
          try {
            let ids: Array<number | null> = [];
            if (prop === "first") ids = result === null || result === undefined ? [] : [idOf((result as { id?: unknown }).id)];
            else if (prop === "all") ids = ((result as { results?: Array<{ id?: unknown }> })?.results ?? []).map((r) => idOf(r?.id));
            else { if ((result as { meta?: { changes?: number } })?.meta?.changes === 0) return result; ids = [idOf((result as { meta?: { last_row_id?: unknown } })?.meta?.last_row_id)]; }
            // With RETURNING, no row back means nothing was written (an ignored insert). Without it, no row back says nothing about whether a row was written, so it is counted as untraced rather than assumed to be nothing.
            if (ids.length === 0) { if (!returning) sink.untraced(); return result; }
            for (const id of ids) { if (id === null) sink.untraced(); else sink.record(table, id); }
          } catch { sink.untraced(); }
          return result;
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** A copy of `env` whose database reports the tracked rows it inserts to `sink`. Everything else behaves as the real database. */
export function taggingEnv(env: Env, sink: TagSink): Env {
  const db = env.OFFICE_DB as any;
  const wrapped = new Proxy(db, {
    get(target, prop) {
      if (prop === "prepare") return (sql: string) => { const m = typeof sql === "string" ? INSERT.exec(sql) : null; return wrapStatement(target.prepare(sql), m ? (m[1].toLowerCase() as TrackedTable) : null, sink, typeof sql === "string" && /\bRETURNING\b/i.test(sql)); };
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { ...env, OFFICE_DB: wrapped } as Env;
}
