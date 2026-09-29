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
- Gets applied by hand for now (there's no automated runner yet), the
  same way a `/debug/init-*` route already was — the real difference
  is the change lives in a real, committed, versioned file instead of
  a route that has to be found and remembered later.
- Never edits `0001_baseline.sql` or any earlier file. History stays
  history.
