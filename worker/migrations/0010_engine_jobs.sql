-- 0010: JOBS (docs/decisions/jobs-and-scheduling.md, J1). ADDITIVE ONLY: one new table. A job is a record of work for a customer. The table is a FACT, inserted once with the job.created event that made it, never updated
-- or deleted. Everything that can change (the date, the person assigned, cancelled or not) is a later event and is DERIVED (worker/src/engine/jobs.ts); nothing here is edited.

CREATE TABLE IF NOT EXISTS eng_job (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  party_id INTEGER NOT NULL REFERENCES eng_party(id),
  event_id INTEGER NOT NULL REFERENCES eng_event(id)
);
CREATE INDEX IF NOT EXISTS idx_eng_job_party ON eng_job(party_id);
