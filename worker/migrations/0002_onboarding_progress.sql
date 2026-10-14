-- Onboarding progress (SHIP_CHECKLIST.md item 15, ONBOARDING_JOURNEY.md). One row per step the owner has EXPLICITLY marked: 'done' (they say it is done) or 'skipped' (do it later). A step with no row is pending.
-- Most steps are "done" because the data exists (customers imported, a first sentence said); that is worked out when it is asked, never stored, so this table holds only choices, and cannot go stale.
-- Additive only: nothing here changes or removes anything that exists.
CREATE TABLE IF NOT EXISTS onboarding_progress (step TEXT PRIMARY KEY, status TEXT NOT NULL CHECK (status IN ('done', 'skipped')), updated_at TEXT NOT NULL DEFAULT (datetime('now')), updated_by TEXT);
