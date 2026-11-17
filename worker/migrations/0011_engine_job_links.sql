-- 0011: TYING MONEY TO A JOB (docs/decisions/jobs-and-scheduling.md, J2). ADDITIVE ONLY: one new table. A link says "this quotation, invoice or expense is for that job". It is a FACT, inserted once with the job.linked
-- event that made it, never updated or deleted; the document itself is untouched. A document is tied to at most one job. What a job has quoted, invoiced, been paid and spent is DERIVED from the links (jobs.ts).

CREATE TABLE IF NOT EXISTS eng_job_link (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES eng_job(id),
  document_id INTEGER NOT NULL UNIQUE REFERENCES eng_document(id),
  event_id INTEGER NOT NULL REFERENCES eng_event(id)
);
CREATE INDEX IF NOT EXISTS idx_eng_job_link_job ON eng_job_link(job_id);
