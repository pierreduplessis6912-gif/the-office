// What this business HAS (as opposed to what the engine understands, what a member may use, and what is valid now). A business's available capabilities are configuration, never code: eng_config key 'available', a
// list of capability ids. The capability contract asks only isAvailable(env, id) and reads only env.CAPABILITY_CONFIG, so this module folds the business's own configuration into that shape and leaves the contract's
// checks, and their tests, exactly as they were. Also here: the OBSERVATION, the engine's honest record of a request it could not or would not act on (a possible unmet need, never an invented operation).
import type { Env } from "../types";

export async function availabilityOf(env: Env): Promise<string[]> {
  try {
    const row = await env.OFFICE_DB.prepare("SELECT value_json FROM eng_config WHERE key = 'available'").first<{ value_json: string }>();
    const list = row ? JSON.parse(row.value_json) : [];
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];   // no engine tables (an older object) or a value that is not a list: nothing is available
  }
}

// The environment as the contract sees it: this business's own availability merged into the explicit configuration (which still wins for what it names).
export async function withEngineAvailability(env: Env): Promise<Env> {
  const own = await availabilityOf(env);
  if (own.length === 0) return env;
  const e = env as unknown as { BUSINESS_ID?: string; CAPABILITY_CONFIG?: Record<string, { available?: unknown } | undefined> };
  const id = typeof e.BUSINESS_ID === "string" ? e.BUSINESS_ID : "__this_business__";
  const config = { ...(e.CAPABILITY_CONFIG ?? {}) };
  const existing = Array.isArray(config[id]?.available) ? (config[id]!.available as unknown[]) : [];
  config[id] = { ...(config[id] ?? {}), available: [...new Set([...existing, ...own])] };
  return { ...env, BUSINESS_ID: id, CAPABILITY_CONFIG: config } as unknown as Env;
}

export async function observe(env: Env, input: { transcript: string; kind: "unsupported" | "unavailable" | "ambiguous"; note: string }): Promise<void> {
  try {
    const capture = await env.OFFICE_DB.prepare("SELECT id FROM captures WHERE raw_text = ? ORDER BY id DESC LIMIT 1").bind(input.transcript).first<{ id: number }>();
    if (!capture) return;   // an observation points at the capture that holds what was said; without one there is nothing to point at
    await env.OFFICE_DB.prepare("INSERT INTO eng_observation (capture_id, kind, note) VALUES (?, ?, ?)").bind(capture.id, input.kind, input.note).run();
  } catch {
    /* a business without the engine tables records no observation; the request is still answered honestly */
  }
}
