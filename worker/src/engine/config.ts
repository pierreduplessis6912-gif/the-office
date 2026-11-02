// The engine's per-business configuration (eng_config): data, never code. Today only which document kinds are settled by money: a customer owes for the kinds in receivableKinds, a supplier is owed for
// payableKinds. A quotation or an order is not a debt, and the engine must not know that by name, so it is configuration with a default.
import type { Env } from "../types";

export interface EngineConfig {
  receivableKinds: string[];
  payableKinds: string[];
}

const DEFAULTS: EngineConfig = { receivableKinds: ["invoice"], payableKinds: ["supplier_invoice"] };

function textList(value: unknown, fallback: string[]): string[] {
  return Array.isArray(value) && value.every((x) => typeof x === "string" && x.trim().length > 0) ? (value as string[]) : fallback;
}

export async function readConfig(env: Env): Promise<EngineConfig> {
  const rows = ((await env.OFFICE_DB.prepare("SELECT key, value_json FROM eng_config").all<{ key: string; value_json: string }>()).results ?? []);
  const byKey: Record<string, unknown> = {};
  for (const r of rows) {
    try { byKey[r.key] = JSON.parse(r.value_json); } catch { /* a value that is not JSON is ignored, the default stands */ }
  }
  return { receivableKinds: textList(byKey.receivable_kinds, DEFAULTS.receivableKinds), payableKinds: textList(byKey.payable_kinds, DEFAULTS.payableKinds) };
}
