// The FORMAT of a read-only MCP key, and nothing else: pure functions with no database, so the gate (auth.ts) and the router (routing.ts) can read a key without importing the credential code (mcp-keys.ts) and creating an import cycle.
// FORMAT  omk.<businessId>.<keyId>.<secret>  (see mcp-keys.ts and MCP_ARCHITECTURE.md). A malformed string is never read any further.
import { isBusinessId } from "./directory";

export const KEY_PREFIX = "omk";
const MAX_KEY_CHARS = 200;
export const KEY_ID_PATTERN = /^[0-9a-f]{16}$/;
const SECRET = /^[A-Za-z0-9_-]{43}$/;

export interface ParsedKey { businessId: string; keyId: string; secret: string }

/** Reads a key string. Null unless it is EXACTLY the format: a malformed string never goes further. */
export function parseKey(raw: unknown): ParsedKey | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_KEY_CHARS) return null;
  const parts = raw.split(".");
  if (parts.length !== 4 || parts[0] !== KEY_PREFIX) return null;
  const [, businessId, keyId, secret] = parts;
  if (!isBusinessId(businessId) || !KEY_ID_PATTERN.test(keyId) || !SECRET.test(secret)) return null;
  return { businessId, keyId, secret };
}

/** The business a key names, read WITHOUT verifying it, only so the Worker can hand the request to that business's object (which verifies). Null for anything malformed. */
export function peekBusinessFromKey(raw: unknown): string | null {
  const parsed = parseKey(raw);
  return parsed === null ? null : parsed.businessId;
}

/** The key from an `Authorization: Bearer <key>` header, or null. */
export function bearerKey(request: Request): string | null {
  const header = request.headers.get("Authorization");
  if (header === null) return null;
  const match = /^Bearer ([^\s]+)$/i.exec(header.trim());
  return match === null ? null : match[1];
}
