// What the model costs, per business, per day.
//
// Added 2026-10-14 (SHIP_CHECKLIST.md items 6 and 7). The model is the only real cost of running a business on this system, and until now what it reported using (timing.ts addUsage) was thrown away, so
// nothing could say what a business cost or stop a runaway. Each business's object keeps a small durable total per UTC day: requests that used the model, model calls, tokens in and out, cached tokens and
// NEURONS (Cloudflare's billing unit). The table is operational telemetry, so it is left out of migrations and backups (migration.ts SKIP_TABLES): restoring yesterday's total must never lower today's spend.
import type { Env } from "./types";
import type { Tally } from "./timing";

// Cloudflare's price: $0.011 per 1,000 neurons above 10,000 a day (that allowance is shared by the WHOLE account, so a business's own figure is its gross cost, before any allowance).
export const NEURON_PRICE_USD = 0.011 / 1000;
export const FREE_NEURONS_PER_DAY = 10_000;
export const USAGE_KEEP_DAYS = 90;

const DDL = "CREATE TABLE IF NOT EXISTS model_usage (day TEXT PRIMARY KEY, requests INTEGER NOT NULL DEFAULT 0, model_calls INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0, prompt_tokens INTEGER NOT NULL DEFAULT 0, completion_tokens INTEGER NOT NULL DEFAULT 0, cached_tokens INTEGER NOT NULL DEFAULT 0, neurons REAL NOT NULL DEFAULT 0)";

export const utcDay = (when: Date = new Date()): string => when.toISOString().slice(0, 10);
export const dollars = (neurons: number): number => Math.round(neurons * NEURON_PRICE_USD * 10000) / 10000;

// Called after the response has gone (ctx.waitUntil), with the ORIGINAL env, and only for a request that actually used the model.
export async function recordModelUsage(env: Env, tally: Tally, now: Date = new Date()): Promise<void> {
  if (tally.ai.n === 0) return;
  const u = tally.usage;
  await env.OFFICE_DB.prepare(DDL).run();
  await env.OFFICE_DB.prepare(
    "INSERT INTO model_usage (day, requests, model_calls, failures, prompt_tokens, completion_tokens, cached_tokens, neurons) VALUES (?, 1, ?, ?, ?, ?, ?, ?) ON CONFLICT(day) DO UPDATE SET requests = requests + 1, model_calls = model_calls + excluded.model_calls, failures = failures + excluded.failures, prompt_tokens = prompt_tokens + excluded.prompt_tokens, completion_tokens = completion_tokens + excluded.completion_tokens, cached_tokens = cached_tokens + excluded.cached_tokens, neurons = neurons + excluded.neurons"
  )
    .bind(utcDay(now), tally.ai.n, u.failures, u.prompt, u.completion, u.cached, u.neurons)
    .run();
  const oldest = new Date(now.getTime() - USAGE_KEEP_DAYS * 86_400_000);
  await env.OFFICE_DB.prepare("DELETE FROM model_usage WHERE day < ?").bind(utcDay(oldest)).run();
}

export interface UsageDay {
  day: string;
  requests: number;
  modelCalls: number;
  failures: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  neurons: number;
  estimatedUsd: number;
}
const zero = (day: string): UsageDay => ({ day, requests: 0, modelCalls: 0, failures: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, neurons: 0, estimatedUsd: 0 });

export async function usageSummary(env: Env, days = 7, now: Date = new Date()): Promise<{ today: UsageDay; recent: UsageDay[]; totalNeurons: number; totalEstimatedUsd: number }> {
  const today = utcDay(now);
  let rows: Record<string, number | string>[] = [];
  try {
    const since = utcDay(new Date(now.getTime() - (days - 1) * 86_400_000));
    rows = (await env.OFFICE_DB.prepare("SELECT day, requests, model_calls, failures, prompt_tokens, completion_tokens, cached_tokens, neurons FROM model_usage WHERE day >= ? ORDER BY day DESC").bind(since).all<Record<string, number | string>>()).results ?? [];
  } catch {
    rows = [];   // the table does not exist until the model is first used
  }
  const recent = rows.map((r) => ({ day: String(r.day), requests: Number(r.requests), modelCalls: Number(r.model_calls), failures: Number(r.failures), promptTokens: Number(r.prompt_tokens), completionTokens: Number(r.completion_tokens), cachedTokens: Number(r.cached_tokens), neurons: Math.round(Number(r.neurons) * 10) / 10, estimatedUsd: dollars(Number(r.neurons)) }));
  const totalNeurons = Math.round(recent.reduce((n, d) => n + d.neurons, 0) * 10) / 10;
  return { today: recent.find((d) => d.day === today) ?? zero(today), recent, totalNeurons, totalEstimatedUsd: dollars(totalNeurons) };
}
