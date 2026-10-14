// Several operations write to more than one place: an invoice and its lines, a delivery and its stock updates, a merge. Until 2026-10-14 each statement ran after the last, so a failure part-way stranded a parent
// without its lines, or stock updated for a delivery that was never recorded (SHIP_CHECKLIST.md item 9: "one atomic batch in the whole Worker"). `atomically` runs such an operation as ONE transaction: it
// all happens or none of it does.
//
// What was MEASURED first, on a real SQLite-backed Durable Object (ops/staging-last-run.json, transaction_experiment): the async storage.transaction() exists and rolls back an async body that throws
// after an await; a plain BEGIN or SAVEPOINT is refused; last_insert_rowid() moves after every insert (so a batch cannot give several lines the parent's id); a child can use the parent's id from
// RETURNING inside a transaction. So the existing async code is simply wrapped, nothing rewritten.
//
// The rules. (1) The body touches the database ONLY: any other binding (the model, the notes store, the memory index, files, backups) throws a clear error if it is used inside, because holding a
// transaction open across them is wrong. (2) An operation called from inside another JOINS it. (3) A database that cannot do transactions (the single-business D1 deployment, a test's fake) runs the body
// exactly as before. (4) A wrapped function re-enters itself: the first call (outside a transaction) calls itself again inside one, and that inner call does the work; `env.__atomic` is how it knows.
import type { Env } from "./types";

const OUTSIDE = ["AI", "MEMORY", "CUSTOMER_NOTES", "OFFICE_VAULT", "BACKUPS", "SHARED_DB"] as const;

// The environment as the body sees it: the database as it is, and every other binding a trap that explains itself when touched.
export function insideATransaction(env: Env): Env {
  const out = { ...env, __atomic: true } as Record<string, unknown>;
  for (const name of OUTSIDE) {
    if (out[name]) {
      out[name] = new Proxy({}, {
        get(_target, property) {
          throw new Error(`${name}.${String(property)} was used inside a transaction: only the database may be touched while one is open, so do that before or after`);
        },
      });
    }
  }
  return out as unknown as Env;
}

export async function atomically<T>(env: Env, body: (env: Env) => Promise<T>): Promise<T> {
  const db = env.OFFICE_DB as unknown as { transaction?: <R>(run: () => Promise<R>) => Promise<R> };
  if (typeof db.transaction !== "function") return body({ ...env, __atomic: true } as Env);   // no transactions here: run as it always did
  return db.transaction(() => body(insideATransaction(env)));
}
