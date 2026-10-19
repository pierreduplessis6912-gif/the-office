// Workspace context (backend wrap-up point 4; contract for the front end in CONTEXT.md; pinned in tools/context.test.js). The app MAY say what the user is looking at, so a follow-up such as "compare that to August" can later be understood.
// THE RULES: (1) the context is an UNTRUSTED HINT. It is validated against allowlists and can never carry or grant anything: a field that is not on the list (capabilities, role, token, address, ...) is DROPPED and its name reported, never kept.
// (2) A bad field never costs the message: valid parts are kept, invalid parts are dropped and their NAMES (never their values) are reported, so a rejected value can never carry injected text anywhere. (3) This is a pure function: it never throws, imports
// nothing, reads no database and checks no capability; authorization stays exactly where it was, in the session. (4) In this phase the context is ACCEPTED, VALIDATED and RECORDED with the turn, but it is NOT used to interpret speech (no consumer exists yet),
// so no reply can change because of it.

type Range = { from: string; to: string };
export interface Context {
  version?: 1; room?: string; report?: string; period?: Range; compare?: Range;
  filters?: Record<string, string | number | boolean>; sort?: string; selection?: Array<{ type: string; id: number }>;
}
export interface ParsedContext { context: Context | null; rejected: string[] }

// Only the reports this server really has. A room is only checked for SHAPE: the app owns its own room names and the server does not pretend to know them.
const REPORTS = new Set(["profit_and_loss", "aged_debtors", "aged_creditors"]);
const SLUG = /^[a-z][a-z0-9_]{0,31}$/;
const MAX_CONTEXT_CHARS = 4000, MAX_HEADER_CHARS = 5000, MAX_FILTERS = 10, MAX_FILTER_KEYS_READ = 50, MAX_SELECTION = 5, MAX_PERIOD_DAYS = 3660;
const NOTE = "The context is checked and recorded with the turn, but it is not used to interpret speech yet.";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const hasOnly = (value: Record<string, unknown>, keys: string[]): boolean => { const own = Object.keys(value); return own.length === keys.length && keys.every((k) => own.includes(k)); };
const realDate = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const days = (value: string): number => Date.parse(`${value}T00:00:00Z`) / 86_400_000;

function readRange(value: unknown): Range | null {
  if (!isRecord(value) || !hasOnly(value, ["from", "to"]) || !realDate(value.from) || !realDate(value.to)) return null;
  const length = days(value.to) - days(value.from);
  return length >= 0 && length < MAX_PERIOD_DAYS ? { from: value.from, to: value.to } : null;
}
const plainText = (value: unknown): value is string => typeof value === "string" && value.length <= 40 && /^[A-Za-z0-9 _.,'-]*$/.test(value);

export function parseContext(raw: unknown): ParsedContext {
  if (raw === undefined || raw === null) return { context: null, rejected: [] };
  try {
    if (!isRecord(raw)) return { context: null, rejected: ["context_malformed"] };
    try { if (JSON.stringify(raw).length > MAX_CONTEXT_CHARS) return { context: null, rejected: ["context_too_large"] }; } catch { /* cannot be measured (for example a circular object): fall through, every field is bounded on its own */ }
    const out: Context = {}, rejected: string[] = [];
    const has = (key: string): boolean => Object.prototype.hasOwnProperty.call(raw, key);

    if (has("version")) { if (raw.version === 1) out.version = 1; else rejected.push("version"); }
    if (has("room")) { if (typeof raw.room === "string" && SLUG.test(raw.room)) out.room = raw.room; else rejected.push("room"); }
    if (has("report")) { if (typeof raw.report === "string" && REPORTS.has(raw.report)) out.report = raw.report; else rejected.push("report"); }
    if (has("period")) { const range = readRange(raw.period); if (range) out.period = range; else rejected.push("period"); }
    if (has("compare")) { const range = readRange(raw.compare); if (range && out.period) out.compare = range; else rejected.push("compare"); }   // a comparison only makes sense beside a valid period
    if (has("filters")) {
      const value = raw.filters;
      if (!isRecord(value) || Object.keys(value).length > MAX_FILTER_KEYS_READ) rejected.push("filters");
      else {
        const kept: Record<string, string | number | boolean> = {};
        let keyProblem = false;
        for (const key of Object.keys(value)) {
          const entry = value[key];
          if (!SLUG.test(key)) { keyProblem = true; continue; }
          if (plainText(entry) || (typeof entry === "number" && Number.isFinite(entry)) || typeof entry === "boolean") kept[key] = entry as string | number | boolean;
          else rejected.push(`filters.${key}`);
        }
        if (keyProblem) rejected.push("filters.key_invalid");
        if (Object.keys(kept).length > MAX_FILTERS) rejected.push("filters");
        else out.filters = kept;
      }
    }
    if (has("sort")) { if (typeof raw.sort === "string" && SLUG.test(raw.sort)) out.sort = raw.sort; else rejected.push("sort"); }
    if (has("selection")) {
      const value = raw.selection;
      if (!Array.isArray(value) || value.length > MAX_SELECTION) rejected.push("selection");
      else {
        const kept: Array<{ type: string; id: number }> = [];
        for (const entry of value) if (isRecord(entry) && hasOnly(entry, ["type", "id"]) && typeof entry.type === "string" && SLUG.test(entry.type) && typeof entry.id === "number" && Number.isSafeInteger(entry.id) && entry.id > 0) kept.push({ type: entry.type, id: entry.id });
        if (kept.length !== value.length) rejected.push("selection");
        if (kept.length > 0) out.selection = kept;
      }
    }
    const allowed = new Set(["version", "room", "report", "period", "compare", "filters", "sort", "selection"]);
    for (const key of Object.keys(raw)) if (!allowed.has(key)) rejected.push(/^[A-Za-z0-9_]{1,32}$/.test(key) ? `unknown:${key}` : "unknown:other");
    // A fixed key order, so the same context always serialises the same way.
    const ordered: Context = {};
    for (const key of ["version", "room", "report", "period", "compare", "filters", "sort", "selection"] as const) if (key in out) (ordered as Record<string, unknown>)[key] = out[key];
    return { context: ordered, rejected };
  } catch {
    return { context: null, rejected: ["context_malformed"] };
  }
}

// The voice route cannot carry a JSON body (the body is the audio), so the context travels in the X-Office-Context header as base64url JSON.
export function contextFromHeader(value: string | null | undefined): ParsedContext {
  if (value === undefined || value === null || value === "") return { context: null, rejected: [] };
  if (typeof value !== "string" || value.length > MAX_HEADER_CHARS) return { context: null, rejected: ["context_header_too_large"] };
  try {
    const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
    const parsed: unknown = JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0))));
    return isRecord(parsed) ? parseContext(parsed) : { context: null, rejected: ["context_header_invalid"] };
  } catch {
    return { context: null, rejected: ["context_header_invalid"] };
  }
}

// The dry run a front end can call while it is being built: what WOULD be kept and what would be dropped. Changes nothing.
export function checkContextRequest(body: unknown): { status: number; body: Record<string, unknown> } {
  if (!isRecord(body) || !("context" in body)) return { status: 400, body: { error: 'Send a JSON body like {"context": {...}}.' } };
  const parsed = parseContext(body.context);
  return { status: 200, body: { context: parsed.context, rejected: parsed.rejected, used: false, note: NOTE } };
}
