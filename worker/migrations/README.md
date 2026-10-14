# Migrations

Real, versioned schema files — replacing the `/debug/init-*` route
pattern used until 2026-09-29, per `SECURITY_AND_OPERATIONAL_READINESS.md`.

## What's here

**`0001_baseline.sql`** — the true, live schema as it stood the day this
started, captured directly from SQLite's own `sqlite_master` (not
reconstructed from source, which would have missed columns added by a
later `ALTER TABLE`). Every statement is `IF NOT EXISTS`, so it's safe
to run against a database that already has some or all of these
tables — which the real, live database does. It is a one-time bridge,
not a template to keep editing.

## Going forward

A real schema change — a new table, a new column — becomes a new file
here: `0002_whatever_it_is.sql`, `0003_...`, and so on. Each one:

- Is idempotent (`CREATE TABLE IF NOT EXISTS`, and for a column, the
  same real `runIdempotentMigration` pattern already used in
  `index.ts` — checking for the real "duplicate column" error rather
  than swallowing anything).
- Is applied AUTOMATICALLY, once, to every business's object, in order, whenever the object next wakes (worker/src/schema.ts; the hourly alarm wakes every active business, so a new
  step reaches them all within the hour). The single-business deployment applies the same files with `wrangler d1 migrations apply`. After adding a file run `node tools/gen-baseline.js`
  (a test fails if the generated steps differ from this folder).
- Must be ADDITIVE: only `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, `ALTER TABLE ... ADD COLUMN`, `INSERT OR IGNORE` and backfill `UPDATE`s. A test refuses `DROP`, `DELETE`,
  `TRUNCATE` and `RENAME`: that is what makes it safe to roll the code back while objects are already on newer steps.
- Is ATOMIC per object: a step and the record that it was applied go in one transaction. If a step fails the business is refused (a clear 503 to everyone but administrators), the failure is
  recorded and shown in the health report, the step is retried every hour and on demand (`POST /admin/schema/retry`), and the business is served again as soon as none fails.
- Never edits `0001_baseline.sql` or any earlier file. History stays
  history.

## The baseline is also a test dependency

`tools/harness.js` builds its test database from `0001_baseline.sql`, so the characterization tests of
`processOneExtraction` run against the real, live schema rather than one reconstructed from source. That is one more
reason not to edit this file retroactively: a later change belongs in a new numbered file, and the harness should apply
the new files after the baseline once there is one.
