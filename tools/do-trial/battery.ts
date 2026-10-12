import { DoD1Database } from "../../worker/src/storage/do-d1";
export async function battery(db: DoD1Database): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const attempt = async (name: string, fn: () => Promise<unknown>) => {
    try { out[name] = await fn(); } catch (e) { out[name] = { threw: String((e as Error).message).replace(/^.*?(no such table|duplicate column|UNIQUE constraint|not supported)/i, "$1").slice(0, 60) }; }
  };
  await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, qty REAL, created_at TEXT DEFAULT (datetime('now')))");
  await attempt("insert", async () => (await db.prepare("INSERT INTO t (name, qty) VALUES (?, ?)").bind("a", 1.5).run()).meta);
  await attempt("insert returning", () => db.prepare("INSERT INTO t (name, qty) VALUES (?, ?) RETURNING id, name").bind("b", 2).first());
  await attempt("first column", () => db.prepare("SELECT qty FROM t WHERE name = ?").bind("a").first("qty"));
  await attempt("first none", () => db.prepare("SELECT * FROM t WHERE name = ?").bind("zzz").first());
  await attempt("all", async () => (await db.prepare("SELECT id, name FROM t ORDER BY id").all()).results);
  await attempt("raw", () => db.prepare("SELECT id, name FROM t ORDER BY id").raw());
  await attempt("update changes", async () => (await db.prepare("UPDATE t SET qty = qty + 1 WHERE qty > ?").bind(0).run()).meta.changes);
  await attempt("delete nothing", async () => (await db.prepare("DELETE FROM t WHERE name = ?").bind("nope").run()).meta.changes);
  await attempt("unique violation", () => db.prepare("INSERT INTO t (name) VALUES (?)").bind("a").run());
  await attempt("missing table", () => db.prepare("SELECT * FROM nope").all());
  await attempt("duplicate column", () => db.prepare("ALTER TABLE t ADD COLUMN qty REAL").run());
  await attempt("bind undefined", () => db.prepare("SELECT ? AS v").bind(undefined).first());
  await attempt("bind boolean", () => db.prepare("SELECT ? AS v").bind(true).first());
  await attempt("bind null", () => db.prepare("SELECT ? AS v").bind(null).first());
  await attempt("bind number and text", () => db.prepare("SELECT ? AS n, ? AS s").bind(7, "x y").first());
  await attempt("batch ok", async () => (await db.batch([db.prepare("INSERT INTO t (name) VALUES ('c')"), db.prepare("INSERT INTO t (name) VALUES ('d')")])).map((r) => r.meta.changes));
  const before = await db.prepare("SELECT COUNT(*) AS n FROM t").first("n");
  await attempt("batch fails halfway", () => db.batch([db.prepare("INSERT INTO t (name) VALUES ('e')"), db.prepare("INSERT INTO t (name) VALUES ('a')")]));
  out["rows before and after the failed batch"] = [before, await db.prepare("SELECT COUNT(*) AS n FROM t").first("n")];
  await attempt("collate nocase", () => db.prepare("SELECT id FROM t WHERE name = ? COLLATE NOCASE").bind("A").first("id"));
  await attempt("like", () => db.prepare("SELECT COUNT(*) AS n FROM t WHERE name LIKE ?").bind("%").first("n"));
  await attempt("aggregate and group", async () => (await db.prepare("SELECT COUNT(*) AS n, SUM(qty) AS q FROM t").all()).results);
  await attempt("comment and newline in sql", () => db.prepare("SELECT 1 AS one -- a comment\n").first("one"));
  await attempt("default datetime is text", async () => typeof (await db.prepare("SELECT created_at FROM t WHERE name = 'a'").first("created_at")));
  await attempt("large text round trip", async () => { const big = "x".repeat(200000); await db.prepare("INSERT INTO t (name) VALUES (?)").bind(big).run(); return (await db.prepare("SELECT LENGTH(name) AS n FROM t WHERE LENGTH(name) > 1000").first("n")); });
  return out;
}
