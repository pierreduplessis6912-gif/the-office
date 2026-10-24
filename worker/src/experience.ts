// The reply envelope, contract version 1 (written up in ENVELOPE.md at the repository root; pinned in tools/experience.test.js).
// THE PRINCIPLE: the intelligence thinks, the envelope projects. It reports what the reply has ALREADY established and recommends how a front end might present it. It is NOT an intent engine, NOT business logic and NOT an authorization mechanism: it
// grants nothing, decides nothing and executes nothing. This module is a pure function: it imports only the refusal vocabulary (types and a validator from refusals.ts), reads no database and calls nothing. The four parts are kept apart on purpose:
//   established     facts copied (validated, bounded) from fields the reply already carries; nothing is inferred
//   recommendation  a suggestion about presentation, never an instruction
//   unknown         an explicit list of what is NOT established
//   mustStillPass   what must still go through the existing trusted routes (confirmation, authorization, validation)

import { isRefusal, type Refusal } from "./refusals";

export interface HeldAction { id: number; type: string | null }
export interface Candidate { id: number; name: string }
export interface Change { field: string; label: string; displayValue: string }
// Contract version 2 (2026-10-24) adds two things, and ONLY a reply that uses one of them is stamped version 2 (every other reply is exactly as in version 1, so a client that reads only version 1 loses nothing):
//   open_room  the reply carries a recognised open-this-screen command naming one of ROOMS (established.room; recommendation.mode "open_room")
//   refuse     the reply carries structured refusals from refusals.ts (established.refusals); mode "refuse" only when EVERY part of the reply was refused ("whole")
export interface Experience {
  version: 1 | 2;
  established: { from: string[]; heldActions: HeldAction[]; candidates: Candidate[] | null; changes: Change[] | null; room?: string; refusals?: { scope: "whole" | "part"; items: Refusal[] } };
  recommendation: { mode: "speak" | "confirm" | "clarify" | "open_room" | "refuse"; speak: string | null; room?: string };
  unknown: string[];
  mustStillPass: { confirmationRequired: boolean; through: string | null; authorization: string };
}

const MAX_ITEMS = 50, MAX_TEXT = 200, MAX_SPEAK = 2000;
const AUTHORIZATION = "Authorization is enforced server-side on every action; this envelope grants nothing and decides nothing.";
const THROUGH = "Only the existing pending-action routes (confirm, reject, edit-field), which re-check authorization and validation on every call.";
// What Phase 1 never establishes: nothing in today's reply supports any of these, so none is invented.
// The screens an app command may name (what lookup.ts can ask the app to open). Anything else stays an unrecognised command, as in version 1.
const ROOMS = ["financial_snapshot", "aged_debtors"];
const MAX_REFUSALS = 10;
const NOT_ESTABLISHED = ["intent_class", "room", "workspace", "evidence", "certainty", "refusal_reason"];

// An in-band instruction to the app that rides inside `message` (today: "__OPEN_DASHBOARD__:financial_snapshot"). It is a command for one client, not words to say or show, so it is never offered as speech and is never stored as what The Office said. The reply itself is untouched: today's app still reads the marker from `message`.
const APP_COMMAND = /^__([A-Z][A-Z_]{0,39})__:([a-z0-9_]{0,40})$/;
export const isAppCommand = (message: unknown): boolean => typeof message === "string" && APP_COMMAND.test(message);
// A plain description of an app command for a record, e.g. "Opened financial snapshot"; null when the message is not a command.
export function appCommandText(message: unknown): string | null {
  if (typeof message !== "string") return null;
  const match = APP_COMMAND.exec(message);
  if (match === null) return null;
  return match[1] === "OPEN_DASHBOARD" && match[2] !== "" ? `Opened ${match[2].replace(/_/g, " ")}` : "(an instruction to the app)";
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const wholeId = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const cut = (value: string): string => (value.length > MAX_TEXT ? value.slice(0, MAX_TEXT) : value);

// Copies a list the reply carries, keeping only well-formed items. A field that is not a list, or holds a bad item, is named as malformed; a list longer than the cap is named as truncated. Returns null when the reply does not carry the field at all.
function readList<T>(reply: Record<string, unknown>, field: string, unknown: string[], from: string[], pick: (item: unknown) => T | null): T[] | null {
  const raw = reply[field];
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw)) { unknown.push(`reply_field_malformed:${field}`); return null; }
  const kept: T[] = [];
  let bad = false;
  for (const item of raw) { const picked = pick(item); if (picked === null) bad = true; else kept.push(picked); }
  if (bad) unknown.push(`reply_field_malformed:${field}`);
  if (kept.length > MAX_ITEMS) { unknown.push(`reply_field_truncated:${field}`); kept.length = MAX_ITEMS; }
  if (kept.length > 0) from.push(field);
  return kept;
}

const pickHeld = (item: unknown): HeldAction | null => (isRecord(item) && wholeId(item.id) && (item.type === null || typeof item.type === "string") ? { id: item.id, type: item.type === null ? null : cut(item.type as string) } : null);
const pickCandidate = (item: unknown): Candidate | null => (isRecord(item) && wholeId(item.id) && typeof item.name === "string" ? { id: item.id, name: cut(item.name) } : null);
const pickChange = (item: unknown): Change | null => (isRecord(item) && typeof item.field === "string" && typeof item.label === "string" && typeof item.displayValue === "string" ? { field: cut(item.field), label: cut(item.label), displayValue: cut(item.displayValue) } : null);

function fallback(reason: string): Experience {
  return { version: 1, established: { from: [], heldActions: [], candidates: null, changes: null }, recommendation: { mode: "speak", speak: null }, unknown: [...NOT_ESTABLISHED, reason], mustStillPass: { confirmationRequired: false, through: null, authorization: AUTHORIZATION } };
}

// Builds the envelope from a reply. NEVER throws, never changes the reply, and reads only the allowlisted fields below (message, pendingActions, pendingCandidates, pendingChanges): nothing else in the reply is ever copied.
export function buildExperience(reply: unknown): Experience {
  try {
    if (!isRecord(reply)) return fallback("reply_malformed");
    const unknown = [...NOT_ESTABLISHED], from: string[] = [];
    const heldActions = readList(reply, "pendingActions", unknown, from, pickHeld) ?? [];
    const candidates = readList(reply, "pendingCandidates", unknown, from, pickCandidate);
    const changes = readList(reply, "pendingChanges", unknown, from, pickChange);
    let speak: string | null = null;
    const message = reply.message;
    if (typeof message === "string") {
      if (isAppCommand(message)) unknown.push("message_is_an_app_command");   // a command for the app, not speech: speak stays null
      else if (message.length > MAX_SPEAK) unknown.push("message_not_repeated");   // the message field is always the full text
      else if (message !== "") { speak = message; from.push("message"); }
    } else if (message !== undefined && message !== null) unknown.push("reply_field_malformed:message");
    // Version 2 parts. A room is established only from a command that names a screen in ROOMS; refusals only from items that pass the closed vocabulary.
    const command = typeof message === "string" ? APP_COMMAND.exec(message) : null;
    const room = command !== null && command[1] === "OPEN_DASHBOARD" && ROOMS.includes(command[2]) ? command[2] : null;
    let refusals: { scope: "whole" | "part"; items: Refusal[] } | null = null;
    if (reply.refusals !== undefined && reply.refusals !== null) {
      if (!Array.isArray(reply.refusals)) unknown.push("reply_field_malformed:refusals");
      else {
        const items = reply.refusals.filter(isRefusal).slice(0, MAX_REFUSALS).map((r) => ({ reason: r.reason, topic: r.topic }) as Refusal);   // only the two vocabulary fields are copied, whatever else an item carries
        if (items.length !== reply.refusals.length) unknown.push("reply_field_malformed:refusals");
        if (items.length > 0) { refusals = { scope: reply.refusalScope === "whole" ? "whole" : "part", items }; from.push("refusals"); }
      }
    }
    const held = heldActions.length > 0;
    const mode = candidates && candidates.length > 0 ? "clarify" : held ? "confirm" : room !== null ? "open_room" : refusals !== null && refusals.scope === "whole" ? "refuse" : "speak";
    const confirmationRequired = held;
    const version = room !== null || refusals !== null ? 2 : 1;
    const known = new Set<string>();
    if (room !== null) known.add("room");
    if (refusals !== null) known.add("refusal_reason");
    return {
      version,
      established: { from, heldActions, candidates, changes, ...(room !== null ? { room } : {}), ...(refusals !== null ? { refusals } : {}) },
      recommendation: { mode, speak, ...(mode === "open_room" && room !== null ? { room } : {}) },
      unknown: unknown.filter((u) => !known.has(u)),
      mustStillPass: { confirmationRequired, through: confirmationRequired ? THROUGH : null, authorization: AUTHORIZATION },
    };
  } catch {
    return fallback("envelope_error");
  }
}

// Returns the reply with the envelope added: every existing field is preserved as it is and the original is not mutated. A reply that already has an "experience" field is returned untouched. A field that cannot even be read is skipped rather than failing the request.
export function withExperience<T extends object>(reply: T): T & { experience?: Experience } {
  if (typeof reply !== "object" || reply === null || Array.isArray(reply)) return reply;   // only an object reply can carry the envelope; anything else passes through untouched
  try { if (Object.prototype.hasOwnProperty.call(reply, "experience")) return reply; } catch { return reply; }
  const experience = buildExperience(reply);
  try {
    return { ...reply, experience };
  } catch {
    const readable: Record<string, unknown> = {};
    for (const key of Object.keys(reply)) { try { readable[key] = (reply as Record<string, unknown>)[key]; } catch { /* skipped */ } }
    return { ...(readable as T), experience };
  }
}
