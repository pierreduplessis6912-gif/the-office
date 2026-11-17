// JOBS (docs/decisions/jobs-and-scheduling.md, J1): work for a customer, and the calendar. RULES and READS live here; the INSERTS live in facts.ts (the one write path).
// A job is a row in eng_job (who it is for) made by one job.created event. Its description, site, reference, date and person assigned start in that event; the date and the person can be changed by later
// job.scheduled and job.assigned events, and a job.cancelled event closes it. Nothing is ever edited: the current state is DERIVED by folding the events in order, so a job's history is its provenance.
// Decision 50 (the same work said twice makes no new job): an open job for the same customer with the same description is refused. A completion certificate is never required (J3 derives "done").
import type { Env } from "../types";
import { EngineError } from "./errors";
import { allProfiles, partyProfile } from "./parties";
import { allQuotations, checkDate } from "./quotations";
import { allocatedToDocument, documentTotals, isEffective } from "./ledger";

const one = <T>(env: Env, sql: string, ...binds: unknown[]) => env.OFFICE_DB.prepare(sql).bind(...binds).first<T>();
const many = async <T>(env: Env, sql: string, ...binds: unknown[]): Promise<T[]> => ((await env.OFFICE_DB.prepare(sql).bind(...binds).all<T>()).results ?? []);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const whole = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 1;
type Checked<T> = { ok: true; value: T } | { ok: false; reason: string };

export interface JobInput { partyId: number; description: string; siteAddress?: string; scheduledOn?: string; assigneeId?: number; reference?: string }
export const JOB_EVENTS = ["job.created", "job.scheduled", "job.assigned", "job.cancelled", "job.linked"] as const;

const text = (v: unknown, label: string, max: number): Checked<string> => {
  if (typeof v !== "string" || !v.trim()) return { ok: false, reason: `${label} must be text` };
  const t = v.trim().replace(/\s+/g, " ");
  return t.length > max ? { ok: false, reason: `${label} must be at most ${max} characters` } : { ok: true, value: t };
};

export function checkJobInput(v: unknown): Checked<JobInput> {
  if (!isObj(v)) return { ok: false, reason: "the job must be an object" };
  const stray = Object.keys(v).find((k) => !["partyId", "description", "siteAddress", "scheduledOn", "assigneeId", "reference"].includes(k));
  if (stray) return { ok: false, reason: `${stray} is not a field of a job` };
  if (!whole(v.partyId)) return { ok: false, reason: "partyId must be a record number" };
  const d = text(v.description, "description", 200); if (!d.ok) return d;
  const out: JobInput = { partyId: v.partyId, description: d.value };
  if (v.siteAddress !== undefined) { const s = text(v.siteAddress, "siteAddress", 200); if (!s.ok) return s; out.siteAddress = s.value; }
  if (v.reference !== undefined) { const r = text(v.reference, "reference", 60); if (!r.ok) return r; out.reference = r.value; }
  if (v.scheduledOn !== undefined) { const s = checkDate(v.scheduledOn, "scheduledOn"); if (!s.ok) return s; out.scheduledOn = s.value; }
  if (v.assigneeId !== undefined) { if (!whole(v.assigneeId)) return { ok: false, reason: "assigneeId must be a record number" }; out.assigneeId = v.assigneeId; }
  return { ok: true, value: out };
}

export function checkScheduleInput(v: unknown): Checked<{ jobId: number; scheduledOn: string | null }> {
  if (!isObj(v)) return { ok: false, reason: "the request must be an object" };
  const stray = Object.keys(v).find((k) => !["jobId", "scheduledOn"].includes(k));
  if (stray) return { ok: false, reason: `${stray} is not a field of this request` };
  if (!whole(v.jobId)) return { ok: false, reason: "jobId must be a record number" };
  if (v.scheduledOn === null) return { ok: true, value: { jobId: v.jobId, scheduledOn: null } };
  const d = checkDate(v.scheduledOn, "scheduledOn"); if (!d.ok) return d;
  return { ok: true, value: { jobId: v.jobId, scheduledOn: d.value } };
}

export function checkAssignInput(v: unknown): Checked<{ jobId: number; assigneeId: number | null }> {
  if (!isObj(v)) return { ok: false, reason: "the request must be an object" };
  const stray = Object.keys(v).find((k) => !["jobId", "assigneeId"].includes(k));
  if (stray) return { ok: false, reason: `${stray} is not a field of this request` };
  if (!whole(v.jobId)) return { ok: false, reason: "jobId must be a record number" };
  if (v.assigneeId === null) return { ok: true, value: { jobId: v.jobId, assigneeId: null } };
  if (!whole(v.assigneeId)) return { ok: false, reason: "assigneeId must be a record number, or null to take the person off" };
  return { ok: true, value: { jobId: v.jobId, assigneeId: v.assigneeId } };
}

export function checkCancelInput(v: unknown): Checked<{ jobId: number; reason: string }> {
  if (!isObj(v)) return { ok: false, reason: "the request must be an object" };
  const stray = Object.keys(v).find((k) => !["jobId", "reason"].includes(k));
  if (stray) return { ok: false, reason: `${stray} is not a field of this request` };
  if (!whole(v.jobId)) return { ok: false, reason: "jobId must be a record number" };
  const r = text(v.reason, "reason", 200); if (!r.ok) return { ok: false, reason: "a job needs a reason to be cancelled" };
  return { ok: true, value: { jobId: v.jobId, reason: r.value } };
}

// ---- the state of a job, derived ------------------------------------------------------------------------------------------------------------------------------------------------------------------------
export interface JobView {
  id: number; partyId: number; partyName: string; description: string; siteAddress: string | null; reference: string | null;
  scheduledOn: string | null; assigneeId: number | null; assigneeName: string | null; status: "open" | "cancelled"; cancelledReason: string | null; overdue: boolean;
  money: JobMoney;
}
// What the money tied to a job adds up to, DERIVED from its links: the quotation that stands (not superseded, not reversed), the invoices still in force, what has been allocated to those invoices (payments received),
// and the expenses still in force. Gross figures (VAT included) throughout, as the documents show them. leftOverMinor is paid less spent: what has actually come in less what has actually gone out for the job.
export interface JobMoney { quotedMinor: number; invoicedMinor: number; paidMinor: number; spentMinor: number; leftOverMinor: number; linked: number }
interface Folded { id: number; partyId: number; description: string; siteAddress: string | null; reference: string | null; scheduledOn: string | null; assigneeId: number | null; cancelled: boolean; reason: string | null }

async function foldAll(env: Env): Promise<Folded[]> {
  const jobs = await many<{ id: number; party_id: number; event_id: number }>(env, "SELECT id, party_id, event_id FROM eng_job ORDER BY id");
  if (jobs.length === 0) return [];
  const byCreate = new Map<number, Folded>();
  const byId = new Map<number, Folded>();
  const events = await many<{ id: number; type: string; reason: string | null; payload_json: string }>(env, `SELECT id, type, reason, payload_json FROM eng_event WHERE type IN (${JOB_EVENTS.map(() => "?").join(", ")}) ORDER BY id`, ...JOB_EVENTS);
  const parse = (s: string): Record<string, unknown> => { try { const p = JSON.parse(s); return isObj(p) ? p : {}; } catch { return {}; } };
  for (const j of jobs) byCreate.set(j.event_id, { id: j.id, partyId: j.party_id, description: "", siteAddress: null, reference: null, scheduledOn: null, assigneeId: null, cancelled: false, reason: null });
  for (const e of events) {
    const p = parse(e.payload_json);
    if (e.type === "job.created") {
      const f = byCreate.get(e.id); if (!f) continue;
      f.description = typeof p.description === "string" ? p.description : "";
      f.siteAddress = typeof p.siteAddress === "string" ? p.siteAddress : null;
      f.reference = typeof p.reference === "string" ? p.reference : null;
      f.scheduledOn = typeof p.scheduledOn === "string" ? p.scheduledOn : null;
      f.assigneeId = typeof p.assigneeId === "number" ? p.assigneeId : null;
      byId.set(f.id, f);
      continue;
    }
    const f = typeof p.jobId === "number" ? byId.get(p.jobId) : undefined;
    if (!f) continue;
    if (e.type === "job.scheduled") f.scheduledOn = typeof p.scheduledOn === "string" ? p.scheduledOn : null;
    else if (e.type === "job.assigned") f.assigneeId = typeof p.assigneeId === "number" ? p.assigneeId : null;
    else if (e.type === "job.cancelled") { f.cancelled = true; f.reason = e.reason; }
  }
  return [...byCreate.values()].sort((a, b) => a.id - b.id);
}

export interface JobFilter { partyId?: number; assigneeId?: number; status?: "open" | "cancelled" | "any"; from?: string; to?: string }

// Dated jobs first (earliest first), then the ones with no date yet; cancelled jobs only when asked for. `today` is the business's own date: an open job dated before it is overdue (nothing is moved silently).
export async function allJobs(env: Env, filter: JobFilter, today: string): Promise<JobView[]> {
  const profiles = new Map((await allProfiles(env)).map((p) => [p.id, p.name]));
  const want = filter.status ?? "open";
  const out: JobView[] = [];
  for (const f of await foldAll(env)) {
    if (filter.partyId !== undefined && f.partyId !== filter.partyId) continue;
    if (filter.assigneeId !== undefined && f.assigneeId !== filter.assigneeId) continue;
    if (want === "open" && f.cancelled) continue;
    if (want === "cancelled" && !f.cancelled) continue;
    if ((filter.from !== undefined || filter.to !== undefined) && f.scheduledOn === null) continue;
    if (filter.from !== undefined && f.scheduledOn !== null && f.scheduledOn < filter.from) continue;
    if (filter.to !== undefined && f.scheduledOn !== null && f.scheduledOn > filter.to) continue;
    out.push({ id: f.id, partyId: f.partyId, partyName: profiles.get(f.partyId) ?? `Customer #${f.partyId}`, description: f.description, siteAddress: f.siteAddress, reference: f.reference, scheduledOn: f.scheduledOn, assigneeId: f.assigneeId, assigneeName: f.assigneeId === null ? null : profiles.get(f.assigneeId) ?? `Person #${f.assigneeId}`, status: f.cancelled ? "cancelled" : "open", cancelledReason: f.reason, overdue: !f.cancelled && f.scheduledOn !== null && f.scheduledOn < today, money: await moneyFor(env, f.id) });
  }
  return out.sort((a, b) => (a.scheduledOn === null ? 1 : 0) - (b.scheduledOn === null ? 1 : 0) || (a.scheduledOn ?? "").localeCompare(b.scheduledOn ?? "") || a.id - b.id);
}

export async function moneyFor(env: Env, jobId: number): Promise<JobMoney> {
  const docs = await many<{ document_id: number; kind: string }>(env, "SELECT l.document_id, d.kind FROM eng_job_link l JOIN eng_document d ON d.id = l.document_id WHERE l.job_id = ? ORDER BY l.id", jobId);
  const standing = new Map((await allQuotations(env)).map((q) => [q.id, q.status]));
  let quoted = 0, invoiced = 0, paid = 0, spent = 0, linked = 0;
  for (const d of docs) {
    if (!(await isEffective(env, "document", d.document_id))) continue;
    linked += 1;
    const gross = (await documentTotals(env, d.document_id)).grossMinor;
    if (d.kind === "quotation") { if (standing.get(d.document_id) !== "superseded") quoted += gross; }
    else if (d.kind === "invoice") { invoiced += gross; paid += await allocatedToDocument(env, d.document_id); }
    else if (d.kind === "expense") spent += gross;
  }
  return { quotedMinor: quoted, invoicedMinor: invoiced, paidMinor: paid, spentMinor: spent, leftOverMinor: paid - spent, linked };
}

export async function jobOrThrow(env: Env, jobId: number): Promise<Folded> {
  if (!(await one(env, "SELECT 1 AS ok FROM eng_job WHERE id = ?", jobId))) throw new EngineError("not_found", "There is no such job.");
  const f = (await foldAll(env)).find((x) => x.id === jobId);
  if (!f) throw new EngineError("not_found", "There is no such job.");
  return f;
}

// ---- plans: the rules, run when a proposal is made and again when it is approved ------------------------------------------------------------------------------------------------------------------------------
async function assigneeChecked(env: Env, assigneeId: number): Promise<void> {
  const p = await partyProfile(env, assigneeId);
  if (!p) throw new EngineError("not_found", "There is no such person to assign.");
  if (!p.roles.includes("installer")) throw new EngineError("invalid_state", `${p.name} is not an installer, so they cannot be assigned to a job. Add the role installer to their record first.`);
}

export async function planJob(env: Env, input: JobInput): Promise<JobInput> {
  const c = checkJobInput(input); if (!c.ok) throw new EngineError("invalid_input", c.reason);
  const v = c.value;
  const p = await partyProfile(env, v.partyId);
  if (!p) throw new EngineError("not_found", "There is no such customer.");
  if (!p.roles.includes("customer")) throw new EngineError("invalid_state", `${p.name} is not a customer, so a job cannot be made for them.`);
  if (v.assigneeId !== undefined) await assigneeChecked(env, v.assigneeId);
  const same = (await foldAll(env)).find((f) => !f.cancelled && f.partyId === v.partyId && f.description.toLowerCase() === v.description.toLowerCase());
  if (same) throw new EngineError("duplicate", `There is already an open job like that for ${p.name} (job ${same.id}). Nothing was added.`);
  return v;
}

export async function planSchedule(env: Env, input: { jobId: number; scheduledOn: string | null }): Promise<{ jobId: number; scheduledOn: string | null; previousOn: string | null }> {
  const c = checkScheduleInput(input); if (!c.ok) throw new EngineError("invalid_input", c.reason);
  const f = await jobOrThrow(env, c.value.jobId);
  if (f.cancelled) throw new EngineError("invalid_state", "That job was cancelled, so it cannot be scheduled.");
  if (f.scheduledOn === c.value.scheduledOn) throw new EngineError("invalid_state", c.value.scheduledOn === null ? "That job has no date already." : `That job is already on ${c.value.scheduledOn}. Nothing was changed.`);
  return { jobId: f.id, scheduledOn: c.value.scheduledOn, previousOn: f.scheduledOn };
}

export async function planAssign(env: Env, input: { jobId: number; assigneeId: number | null }): Promise<{ jobId: number; assigneeId: number | null; previousId: number | null }> {
  const c = checkAssignInput(input); if (!c.ok) throw new EngineError("invalid_input", c.reason);
  const f = await jobOrThrow(env, c.value.jobId);
  if (f.cancelled) throw new EngineError("invalid_state", "That job was cancelled, so nobody can be assigned to it.");
  if (c.value.assigneeId !== null) await assigneeChecked(env, c.value.assigneeId);
  if (f.assigneeId === c.value.assigneeId) throw new EngineError("invalid_state", c.value.assigneeId === null ? "Nobody is assigned to that job already." : "That person is already on that job. Nothing was changed.");
  return { jobId: f.id, assigneeId: c.value.assigneeId, previousId: f.assigneeId };
}

export async function planJobCancel(env: Env, input: { jobId: number; reason: string }): Promise<{ jobId: number; reason: string }> {
  const c = checkCancelInput(input); if (!c.ok) throw new EngineError("invalid_input", c.reason);
  const f = await jobOrThrow(env, c.value.jobId);
  if (f.cancelled) throw new EngineError("invalid_state", "That job is already cancelled.");
  if ((await moneyFor(env, f.id)).linked > 0) throw new EngineError("invalid_state", "That job has quotations, invoices or expenses tied to it, so it cannot be cancelled. Void or credit them first, or leave the job open.");
  return { jobId: f.id, reason: c.value.reason };
}

export function checkLinkInput(v: unknown): Checked<{ jobId: number; documentId: number }> {
  if (!isObj(v)) return { ok: false, reason: "the request must be an object" };
  const stray = Object.keys(v).find((k) => !["jobId", "documentId"].includes(k));
  if (stray) return { ok: false, reason: `${stray} is not a field of this request` };
  if (!whole(v.jobId)) return { ok: false, reason: "jobId must be a record number" };
  if (!whole(v.documentId)) return { ok: false, reason: "documentId must be a record number" };
  return { ok: true, value: { jobId: v.jobId, documentId: v.documentId } };
}

// Tie an existing quotation, invoice or expense to an open job. A quotation or invoice must be for the job's own customer; one document is tied to at most one job; a voided one cannot be tied.
export async function planLink(env: Env, input: { jobId: number; documentId: number }): Promise<{ jobId: number; documentId: number; kind: string }> {
  const c = checkLinkInput(input); if (!c.ok) throw new EngineError("invalid_input", c.reason);
  const f = await jobOrThrow(env, c.value.jobId);
  if (f.cancelled) throw new EngineError("invalid_state", "That job was cancelled, so nothing can be tied to it.");
  const d = await one<{ id: number; kind: string; party_id: number }>(env, "SELECT id, kind, party_id FROM eng_document WHERE id = ?", c.value.documentId);
  if (!d || !["quotation", "invoice", "expense"].includes(d.kind)) throw new EngineError("not_found", "There is no such quotation, invoice or expense.");
  const have = await one<{ job_id: number }>(env, "SELECT job_id FROM eng_job_link WHERE document_id = ?", d.id);
  if (have) throw new EngineError("duplicate", have.job_id === f.id ? "That is already tied to this job. Nothing was changed." : `That is already tied to job ${have.job_id}.`);
  if (!(await isEffective(env, "document", d.id))) throw new EngineError("invalid_state", "That document has been voided, so it cannot be tied to a job.");
  if (d.kind !== "expense" && d.party_id !== f.partyId) throw new EngineError("invalid_state", "That document is for a different customer than the job.");
  return { jobId: f.id, documentId: d.id, kind: d.kind };
}

// The integrity check: every job is for a party that exists and has the customer role as far as the fact goes (roles can change later, so only existence is a violation), and every job event names a real job.
export async function verifyJobs(env: Env, report: (code: string, detail: string) => void): Promise<void> {
  const ids = new Set((await many<{ id: number }>(env, "SELECT id FROM eng_job")).map((r) => Number(r.id)));
  for (const e of await many<{ id: number; type: string; payload_json: string }>(env, "SELECT id, type, payload_json FROM eng_event WHERE type IN ('job.scheduled', 'job.assigned', 'job.cancelled', 'job.linked')")) {
    let p: Record<string, unknown> = {}; try { const x = JSON.parse(e.payload_json); if (isObj(x)) p = x; } catch { /* reported as a malformed payload elsewhere */ }
    if (typeof p.jobId !== "number" || !ids.has(p.jobId)) report("job_inconsistent", `event ${e.id} (${e.type}) names a job that does not exist`);
  }
  for (const l of await many<{ id: number; job_id: number; document_id: number }>(env, "SELECT l.id, l.job_id, d.id AS document_id FROM eng_job_link l LEFT JOIN eng_document d ON d.id = l.document_id")) {
    if (!ids.has(Number(l.job_id))) report("job_inconsistent", `link ${l.id} names a job that does not exist`);
  }
}
