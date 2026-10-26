// THE UPLOAD LINK (MCP stage 4; MCP_ARCHITECTURE.md). An assistant cannot pass a photo's bytes through a tool call, so it asks for a LINK (get_upload_link, mcp.ts) and the OWNER opens it on their phone, picks a photo or a PDF and sends it. The file then goes through the app's OWN photo and document routes (as the member, with a one-minute session, exactly as the confirm tool does: mcp-act.ts), so everything the app already does with a document applies unchanged: the image is stored, read, told apart (a supplier invoice, a delivery note, a statement) and anything that touches money is HELD for a confirmation. Nothing of that pipeline is copied here.
// THE RULES (each held by a test that fails if it is removed, tools/mcp-upload-breakage.js): (1) the page and the upload are opened only by a link that carries a valid, unexpired signature for THIS ticket's exact path (auth.ts), and ALSO by a ticket that is still open: not used up, not older than 10 minutes, its key not revoked, its member still an active owner; (2) a ticket takes at most 5 files, each use claimed BEFORE the file is read, so two sends at once cannot get a sixth; (3) the file is judged by its CONTENT, not by what the browser says it is: a JPEG, a PNG or a PDF, not empty, at most 8 MB, and nothing else is passed on; (4) it is handed to the app's route as the member and as nothing else, the held actions it produces are LINKED to the key that asked for the link (so the owner sees them, and what Claude may do with them is the same as for anything else it proposed); (5) a page shown to the person never repeats anything but the app's own plain message, escaped.
import { signDocumentPath, signSession } from "./auth";
import { collector, linkHeld } from "./mcp-pending";
import type { TagSink } from "./mcp-tags";
import { escapeHtml, page } from "./signup";
import type { Env } from "./types";

export const UPLOAD_TTL_MINUTES = 10, MAX_FILES = 5, MAX_BYTES = 8 * 1024 * 1024;

export async function ensureTickets(env: Env): Promise<void> {
  await env.OFFICE_DB.prepare("CREATE TABLE IF NOT EXISTS mcp_upload_tickets (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL DEFAULT (datetime('now')), key_id TEXT NOT NULL, email TEXT NOT NULL, create_id INTEGER NOT NULL, used_count INTEGER NOT NULL DEFAULT 0, max_uses INTEGER NOT NULL DEFAULT 5, results TEXT)").run();
}

/** A new ticket for a key. `createId` is the write place the request used (so what it produces is tied to that request). */
export async function issueTicket(env: Env, who: { keyId: string; email: string }, createId: number): Promise<number | null> {
  await ensureTickets(env);
  const made = await env.OFFICE_DB.prepare("INSERT INTO mcp_upload_tickets (key_id, email, create_id, max_uses) VALUES (?, ?, ?, ?)").bind(who.keyId, who.email, createId, MAX_FILES).run();
  const id = made.meta?.last_row_id;
  return typeof id === "number" && Number.isInteger(id) && id > 0 ? id : null;
}

/** The link the owner opens. Its signature covers the exact path /upload/<id> and ends in ten minutes; the ticket is checked again on every use. */
export async function linkFor(env: Env, origin: string, ticketId: number): Promise<string> {
  const path = `/upload/${ticketId}`;
  return `${origin}${path}?sig=${encodeURIComponent(await signDocumentPath(env, path, UPLOAD_TTL_MINUTES * 60_000))}`;
}

interface Ticket { id: number; key_id: string; email: string; create_id: number; used_count: number; max_uses: number; results: string | null }
type Opened = { ok: true; ticket: Ticket } | { ok: false; reason: "gone" | "expired" | "used" | "revoked" | "notowner" };

/** Is this ticket still good, RIGHT NOW (not when the link was made)? */
export async function openTicket(env: Env, id: number): Promise<Opened> {
  if (!Number.isInteger(id) || id < 1) return { ok: false, reason: "gone" };
  let t: (Ticket & { fresh: number }) | null = null;
  try { t = await env.OFFICE_DB.prepare(`SELECT id, key_id, email, create_id, used_count, max_uses, results, (created_at >= datetime('now', '-${UPLOAD_TTL_MINUTES} minutes')) AS fresh FROM mcp_upload_tickets WHERE id = ?`).bind(id).first<Ticket & { fresh: number }>(); } catch { t = null; }
  if (!t) return { ok: false, reason: "gone" };
  if (!t.fresh) return { ok: false, reason: "expired" };
  if (t.used_count >= t.max_uses) return { ok: false, reason: "used" };
  let key: { revoked_at: string | null } | null = null;
  try { key = await env.OFFICE_DB.prepare("SELECT revoked_at FROM mcp_keys WHERE id = ?").bind(t.key_id).first<{ revoked_at: string | null }>(); } catch { key = null; }
  if (!key || key.revoked_at !== null) return { ok: false, reason: "revoked" };
  let member: { role: string; status: string } | null = null;
  try { member = await env.OFFICE_DB.prepare("SELECT role, status FROM memberships WHERE google_email = ?").bind(t.email).first<{ role: string; status: string }>(); } catch { member = null; }
  if (!member || member.status !== "active" || member.role !== "owner") return { ok: false, reason: "notowner" };
  return { ok: true, ticket: t };
}

const WHY: Record<string, string> = {
  gone: "That upload link is not valid.",
  expired: "That upload link has expired. Ask Claude for a new one.",
  used: "That upload link has been used up. Ask Claude for a new one.",
  revoked: "That connection has been stopped, so the link no longer works.",
  notowner: "Only the owner can send files this way.",
};
const closed = (reason: string): Response => page("Upload", `<h1>Cannot upload</h1><p>${escapeHtml(WHY[reason] ?? WHY.gone)}</p>`, reason === "gone" ? 404 : 403);

/** The page: one file, one optional note, one button. Plain HTML, no script. The form posts back to the very same address, signature and all. */
export async function uploadPage(env: Env, ticketId: number, action: string): Promise<Response> {
  const opened = await openTicket(env, ticketId);
  if (!opened.ok) return closed(opened.reason);
  const left = opened.ticket.max_uses - opened.ticket.used_count;
  return page("Send a photo or PDF", `<h1>Send a photo or PDF to your Office</h1><p>Pick a photo (of a supplier invoice, a delivery note, a receipt) or a PDF. It is read the same way as one sent from the app, and anything that touches money waits for your confirmation.</p><form method="post" action="${escapeHtml(action)}" enctype="multipart/form-data"><p><input type="file" name="file" accept="image/*,application/pdf" required></p><p><label>Who is it from? (optional)<br><input type="text" name="caption" maxlength="200"></label><br><span class="small">Type the supplier's name: that is what lets the Office treat it as a supplier invoice, a delivery note or a statement. Without a name it is only stored.</span></p><p><button type="submit">Send</button></p></form><p class="small">You can send up to ${left} more file${left === 1 ? "" : "s"} with this link, for the next ${UPLOAD_TTL_MINUTES} minutes.</p>`);
}

/** What kind of file this really is, from its first bytes. Anything else is not passed on. */
export function sniff(bytes: Uint8Array): { kind: "photo" | "pdf"; mime: string } | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { kind: "photo", mime: "image/jpeg" };
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return { kind: "photo", mime: "image/png" };
  if (bytes.length >= 5 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d) return { kind: "pdf", mime: "application/pdf" };
  return null;
}

const text = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() ? v.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max) : null);

/** Receives one file. `serveWith` hands the app's own route a request, with a database that reports what it creates. */
export async function receiveUpload(env: Env, request: Request, ticketId: number, serveWith: (sink: TagSink) => (request: Request) => Promise<Response>): Promise<Response> {
  const opened = await openTicket(env, ticketId);
  if (!opened.ok) return closed(opened.reason);
  const t = opened.ticket;
  // (2) the use is claimed BEFORE the file is read, in one statement, so a burst cannot take more than the ticket allows
  let claimed = 0;
  try { claimed = (await env.OFFICE_DB.prepare("UPDATE mcp_upload_tickets SET used_count = used_count + 1 WHERE id = ? AND used_count < max_uses").bind(t.id).run()).meta?.changes ?? 0; } catch { claimed = 0; }
  if (claimed !== 1) return closed("used");
  const n = t.used_count + 1;
  const fail = (message: string, status = 400): Response => page("Not sent", `<h1>That could not be sent</h1><p>${escapeHtml(message)}</p>`, status);
  const form = await request.formData().catch(() => null);
  if (!form) return fail("That was not a file upload.");
  const entry0 = form.get("file") as unknown;
  if (typeof entry0 !== "object" || entry0 === null || typeof (entry0 as { arrayBuffer?: unknown }).arrayBuffer !== "function") return fail("Choose a photo or a PDF first.");
  const file = entry0 as { size: number; arrayBuffer: () => Promise<ArrayBuffer> };
  if (file.size < 1) return fail("That file is empty.");
  if (file.size > MAX_BYTES) return fail("That file is too big. The most is 8 MB.", 413);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const kind = sniff(bytes);   // (3) by content, not by what the browser says
  if (!kind) return fail("Only a photo (JPEG or PNG) or a PDF can be sent.", 415);
  const caption = text(form.get("caption"), 200);
  // (4) handed to the app's own route as the member, with a one-minute session made here and shown to nobody
  const token = await signSession(env, t.email, env.BUSINESS_ID, Date.now() + 60_000);
  const inner = new FormData();
  inner.set(kind.kind === "pdf" ? "document" : "photo", new File([bytes], kind.kind === "pdf" ? "upload.pdf" : kind.mime === "image/png" ? "upload.png" : "upload.jpg", { type: kind.mime }));
  if (caption) inner.set("caption", caption);
  inner.set("idempotency_key", `mcp-upload-${t.id}-${n}`);
  const seen = collector();
  const origin = new URL(request.url).origin;
  let answer: { status: number; body: Record<string, unknown> | null } = { status: 500, body: null };
  try {
    const response = await serveWith(seen.sink)(new Request(`${origin}${kind.kind === "pdf" ? "/files/document" : "/files/photo"}`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: inner }));
    let body: Record<string, unknown> | null = null; try { body = (await response.json()) as Record<string, unknown>; } catch { body = null; }
    answer = { status: response.status, body };
  } catch { /* reported below */ }
  const ok = answer.status >= 200 && answer.status < 300;
  const held = ok && typeof answer.body?.pendingActionId === "number" ? await linkHeld(env, t.key_id, t.create_id, [answer.body.pendingActionId as number]) : [];
  const appMessage = ok ? (text(answer.body?.refusal, 300) ?? text(answer.body?.message, 300)) : text(answer.body?.error, 200);
  // What the Office READ, so a file that was only stored is not a mystery: the start of the text it found (or why it found none).
  const read = ok ? text(answer.body?.description, 300) : null;
  const unreadable = read !== null && /no extractable text layer|text extraction failed/i.test(read);
  const recognised = ok && (appMessage !== null || held.length > 0);
  // (5) the person and the assistant are always told what the Office did: its own message if it had one, otherwise plainly that it only stored the file
  const message = !ok ? appMessage : appMessage ?? (unreadable ? "The Office could not read any text in that PDF (it may be a scan). Send a clear photo of it instead." : "It was stored, but the Office did not recognise it as a supplier invoice, a delivery note or a statement, so nothing was recorded. If it is one, send it again with the supplier's name in the box.");
  const entry = { n, kind: kind.kind, received: ok, recognised, ...(message ? { message } : {}), ...(read ? { read } : {}), ...(typeof answer.body?.refusal === "string" && answer.body.refusal ? { refused: true } : {}), held: held.map((h) => ({ actionId: h.actionId, kind: h.kind, summary: h.summary, canConfirmHere: h.canConfirmHere })) };
  try {
    const prior = (() => { try { return JSON.parse(t.results ?? "[]") as unknown[]; } catch { return []; } })();
    await env.OFFICE_DB.prepare("UPDATE mcp_upload_tickets SET results = ? WHERE id = ?").bind(JSON.stringify([...prior, entry].slice(-MAX_FILES)), t.id).run();
  } catch { /* the file was sent; only the note of it failed */ }
  if (!ok) return fail("The Office could not read that file. Try again, or send it from the app.", 502);
  // (5) only the app's own plain message, escaped
  return page("Sent", `<h1>Sent</h1><p>${escapeHtml(message ?? "Your file was received.")}</p><p>Go back to Claude and tell it you sent it.</p>`);
}

/** What happened with a ticket, for the assistant that asked for it. Only for the key that made it. */
export async function ticketOutcome(env: Env, keyId: string, ticketId: number): Promise<{ found: false } | { found: true; state: "waiting" | "received" | "expired"; uploads: unknown[]; filesLeft: number }> {
  if (!Number.isInteger(ticketId) || ticketId < 1) return { found: false };
  let t: (Ticket & { fresh: number }) | null = null;
  try { t = await env.OFFICE_DB.prepare(`SELECT id, key_id, email, create_id, used_count, max_uses, results, (created_at >= datetime('now', '-${UPLOAD_TTL_MINUTES} minutes')) AS fresh FROM mcp_upload_tickets WHERE id = ? AND key_id = ?`).bind(ticketId, keyId).first<Ticket & { fresh: number }>(); } catch { t = null; }
  if (!t) return { found: false };
  let uploads: unknown[] = []; try { uploads = JSON.parse(t.results ?? "[]") as unknown[]; } catch { uploads = []; }
  return { found: true, state: uploads.length > 0 ? "received" : t.fresh ? "waiting" : "expired", uploads, filesLeft: t.fresh ? Math.max(0, t.max_uses - t.used_count) : 0 };
}
