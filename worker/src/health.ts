// One read-only health report for a business: is the work that must happen on its own (the hourly memory job, the daily backup) happening, is anything piling up, what is the model costing, and are requests
// failing. Added 2026-10-14 (SHIP_CHECKLIST.md item 7). A scheduled GitHub check judges it and goes red when something is wrong, so a failing job tells Pierre instead of staying silent.
import { ensureLocation } from "./location";
import { SCHEMA_STEPS } from "./schema-steps";
import { memberUsageToday } from "./limits";
import { readBackupMeta } from "./backup";
import type { Env } from "./types";
import { usageSummary } from "./usage";

async function meta(env: Env, key: string): Promise<string | null> {
  try {
    return (await env.OFFICE_DB.prepare("SELECT value FROM object_meta WHERE key = ?").bind(key).first<{ value: string }>())?.value ?? null;
  } catch {
    return null;   // no bookkeeping table: not a business's object
  }
}
const minutesSince = (iso: string | null, now: number): number | null => {
  const t = iso ? Date.parse(iso.includes("T") ? iso : iso.replace(" ", "T") + "Z") : NaN;
  return Number.isFinite(t) ? Math.max(0, Math.round((now - t) / 60_000)) : null;
};

// Which schema steps this business has applied, which are still pending, and the last failure (schema.ts). A pending step or a failure means the business is being refused until it is fixed.
async function schemaHealth(env: Env): Promise<Record<string, unknown>> {
  const latest = SCHEMA_STEPS[SCHEMA_STEPS.length - 1].version;
  let appliedVersions: number[] = [];
  try {
    appliedVersions = ((await env.OFFICE_DB.prepare("SELECT version FROM schema_steps").all<{ version: number }>()).results ?? []).map((r) => Number(r.version));
  } catch {
    // no steps table: not a business's object
  }
  const parse = (text: string | null): unknown => {
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      return null;
    }
  };
  return {
    latestKnownStep: latest,
    appliedSteps: appliedVersions.length,
    pending: SCHEMA_STEPS.filter((st) => !appliedVersions.includes(st.version)).map((st) => st.name),
    unknownApplied: appliedVersions.filter((v) => !SCHEMA_STEPS.some((st) => st.version === v)).length,
    error: parse(await meta(env, "schema_error")),
    lastMigration: parse(await meta(env, "last_schema_migration")),
  };
}

export async function healthReport(env: Env, now: Date = new Date()): Promise<Record<string, unknown>> {
  const nowMs = now.getTime();
  const lastJobAt = await meta(env, "last_job_at");
  const backup = await readBackupMeta(env).catch(() => ({ lastSuccessAt: null, lastAttemptOk: null, lastError: null }));
  let backlog = { count: 0, oldestMinutes: null as number | null };
  try {
    const row = await env.OFFICE_DB.prepare("SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM pending_memory_flush").first<{ n: number; oldest: string | null }>();
    backlog = { count: Number(row?.n ?? 0), oldestMinutes: minutesSince(row?.oldest ?? null, nowMs) };
  } catch {
    // no queue table yet
  }
  let requests = { recent: 0, serverErrors: 0 };
  try {
    const row = await env.OFFICE_DB.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN status >= 500 THEN 1 ELSE 0 END), 0) AS errors FROM (SELECT status FROM request_timings ORDER BY id DESC LIMIT 200)").first<{ n: number; errors: number }>();
    requests = { recent: Number(row?.n ?? 0), serverErrors: Number(row?.errors ?? 0) };
  } catch {
    // timings are off, or nothing has been recorded yet
  }
  const usage = await usageSummary(env, 7, now);
  return {
    business: env.BUSINESS_ID ?? null,
    generatedAt: now.toISOString(),
    hourlyJob: { lastRunAt: lastJobAt, minutesSinceLastRun: minutesSince(lastJobAt, nowMs), lastOk: (await meta(env, "last_job_ok")) === null ? null : (await meta(env, "last_job_ok")) === "1", lastError: (await meta(env, "last_job_error")) || null, lastMs: Number((await meta(env, "last_job_ms")) ?? "") || null, nextAlarmAt: await meta(env, "next_alarm_at") },
    backup: { ...backup, newestAgeHours: backup.lastSuccessAt ? Math.round(((nowMs - Date.parse(backup.lastSuccessAt)) / 3_600_000) * 10) / 10 : null },
    memoryQueue: { pending: backlog.count, oldestPendingMinutes: backlog.oldestMinutes },
    requests: { ...requests, errorRate: requests.recent ? Math.round((requests.serverErrors / requests.recent) * 1000) / 1000 : 0, note: "the last 200 requests that changed something (timings must be on)" },
    model: usage,
    limits: await memberUsageToday(env, now),
    // Where this business's object runs (location.ts): answered on the first reading if it has never been asked. A business whose members are far from it pays a long hop on every request.
    location: await ensureLocation(env).catch(() => ({ colo: null, country: null, checkedAt: null, error: "the location could not be read" })),
    schema: await schemaHealth(env),
  };
}
