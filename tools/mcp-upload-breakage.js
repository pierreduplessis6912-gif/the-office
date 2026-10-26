// Proof that the upload link tests are not decorative (the link is opened WITHOUT a sign-in). For each guard in worker/src/mcp-upload.ts, the gate in auth.ts and the router in routing.ts it takes a COPY of the worker source, REMOVES that one guard, runs tools/mcp-changes.test.js against the copy and requires at least one check to FAIL.
// Run: NODE_PATH=worker/node_modules node --no-warnings tools/mcp-upload-breakage.js
const fs = require('fs'), os = require('os'), path = require('path');
const root = path.join(__dirname, '..'), workerDir = path.join(root, 'worker');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mup-')), copy = path.join(tmp, 'worker');
fs.cpSync(workerDir, copy, { recursive: true, filter: (src) => !src.split(path.sep).includes('node_modules') });
fs.symlinkSync(path.join(workerDir, 'node_modules'), path.join(copy, 'node_modules'));   // the real packages, read only: the copy needs them to build
const files = { upload: path.join(copy, 'src', 'mcp-upload.ts'), auth: path.join(copy, 'src', 'auth.ts'), routing: path.join(copy, 'src', 'routing.ts') };
const originals = Object.fromEntries(Object.entries(files).map(([k, f]) => [k, fs.readFileSync(f, 'utf8')]));
const run = require('./mcp-upload.test.js');
const MUTATIONS = [
  // the ticket (mcp-upload.ts)
  ['upload', 'a ticket never runs out of time', 'if (!t.fresh) return { ok: false, reason: "expired" };', ''],
  ['upload', 'a used-up ticket still works', 'if (t.used_count >= t.max_uses) return { ok: false, reason: "used" };', ''],
  ['upload', 'a stopped key still works', 'if (!key || key.revoked_at !== null) return { ok: false, reason: "revoked" };', ''],
  ['upload', 'a member who is no longer an owner can still upload', 'if (!member || member.status !== "active" || member.role !== "owner") return', 'if (!member) return'],
  ['upload', 'a member who is no longer active can still upload', 'member.status !== "active" || member.role', 'member.role'],
  ['upload', 'a use is not limited when it is claimed (a burst takes more than five)', 'WHERE id = ? AND used_count < max_uses").bind(t.id)', 'WHERE id = ?").bind(t.id)'],
  ['upload', 'the use is claimed after the file is read, not before', 'if (claimed !== 1) return closed("used");', ''],
  ['upload', 'a ticket takes more than five files', 'export const UPLOAD_TTL_MINUTES = 10, MAX_FILES = 5,', 'export const UPLOAD_TTL_MINUTES = 10, MAX_FILES = 500,'],
  ['upload', 'the ticket lasts an hour', 'export const UPLOAD_TTL_MINUTES = 10,', 'export const UPLOAD_TTL_MINUTES = 60,'],
  // what is passed on
  ['upload', 'anything is passed on whatever its content', 'if (!kind) return fail("Only a photo (JPEG or PNG) or a PDF can be sent.", 415);', 'if (!kind) { /* x */ }'],
  ['upload', 'a file of any size is passed on', 'if (file.size > MAX_BYTES) return fail("That file is too big. The most is 8 MB.", 413);', ''],
  ['upload', 'an empty file is passed on', 'if (file.size < 1) return fail("That file is empty.");', ''],
  ['upload', 'a PDF is sent to the photo route', '`${origin}${kind.kind === "pdf" ? "/files/document" : "/files/photo"}`', '`${origin}/files/photo`'],
  ['upload', 'the upload is sent as a different member', 'signSession(env, t.email, env.BUSINESS_ID,', 'signSession(env, "someone@else.co", env.BUSINESS_ID,'],
  ['upload', 'the one-minute session lasts a month', 'env.BUSINESS_ID, Date.now() + 60_000);\n  const inner', 'env.BUSINESS_ID);\n  const inner'],
  ['upload', 'the held action is not linked to the key', 'await linkHeld(env, t.key_id, t.create_id, [answer.body.pendingActionId as number])', '[]'],
  ['upload', 'a failed pass-on is recorded as received', 'const ok = answer.status >= 200 && answer.status < 300;', 'const ok = true;'],
  ['upload', 'the retry-safe key is not sent', 'inner.set("idempotency_key", `mcp-upload-${t.id}-${n}`);', ''],
  ['upload', 'a note is not cleaned', '.replace(/[\\u0000-\\u001f\\u007f]/g, " ")', ''],
  // what the person sees, and what the assistant can see
  ['upload', 'the app\'s message is shown unescaped', '${escapeHtml(message ?? "Your file was received.")}', '${message ?? "Your file was received."}'],
  ['upload', 'the form address is not escaped', 'action="${escapeHtml(action)}"', 'action="${action}"'],
  ['upload', 'any key can see any ticket\'s outcome', 'FROM mcp_upload_tickets WHERE id = ? AND key_id = ?`).bind(ticketId, keyId)', 'FROM mcp_upload_tickets WHERE id = ? AND ? IS NOT NULL`).bind(ticketId, keyId)'],
  ['upload', 'the link\'s signature covers any path', 'await signDocumentPath(env, path, UPLOAD_TTL_MINUTES * 60_000)', 'await signDocumentPath(env, "/invoices/3/pdf", UPLOAD_TTL_MINUTES * 60_000)'],
  // a file that was only stored is said plainly
  ['upload', 'a file that was only stored is reported as received with nothing said', ': "It was stored, but the Office did not recognise it as a supplier invoice, a delivery note or a statement, so nothing was recorded. If it is one, send it again with the supplier\'s name in the box.");', ': null);'],
  ['upload', 'a PDF with no readable text is described as merely not recognised', '(unreadable ? "The Office could not read', '(false ? "The Office could not read'],
  ['upload', 'every file is reported as recognised', 'const recognised = ok && (appMessage !== null || held.length > 0);', 'const recognised = true;'],
  ['upload', 'a failure is reported as recognised', 'const recognised = ok && (', 'const recognised = ('],
  ['upload', 'what the Office read is not passed on', '...(read ? { read } : {}),', ''],
  ['upload', 'what the Office read is passed on whole', '.trim().slice(0, max) : null)', '.trim() : null)'],
  ['upload', 'the page does not ask who the document is from', 'Who is it from? (optional)', 'A note, if you want one'],
  // the gate (auth.ts)
  ['auth', 'the gate does not check the signature', 'return (await verifyDocumentToken(env, path, url.searchParams.get("sig"))) ? null : Response.json({ error: "this link is missing or has expired" }, { status: 403 });\n  }\n\n  if (path.endsWith("/pdf"))', 'return null;\n  }\n\n  if (path.endsWith("/pdf"))'],
  ['auth', 'the gate allows any method', 'if (request.method !== "GET" && request.method !== "POST") return Response.json({ error: "method not allowed" }, { status: 405 });', ''],
  ['auth', 'the gate opens anything under /upload/', 'if (/^\\/upload\\/\\d+$/.test(path)) {', 'if (/^\\/upload\\//.test(path)) {'],
  // the router (routing.ts)
  ['routing', 'the router does not send an upload link to its business', 'if (path.endsWith("/pdf") || /^\\/upload\\/\\d+$/.test(path)) {', 'if (path.endsWith("/pdf")) {'],
];
(async () => {
  let missed = 0;
  const collect = () => { const list = []; return { list, check: (ok, label) => { if (!ok) list.push(label); } }; };
  const reset = () => { for (const [k, f] of Object.entries(files)) fs.writeFileSync(f, originals[k]); };
  { reset(); const c = collect(); await run({ check: c.check, srcDir: path.join(copy, 'src') }); console.log(`baseline (nothing removed): ${c.list.length} failing checks (must be 0)`); if (c.list.length) { missed++; console.log(c.list.join('\n')); } }
  for (const [k, name, from, to] of MUTATIONS) {
    reset();
    if (!originals[k].includes(from)) { console.log(`NOT APPLIED  ${name}: the text to remove was not found in ${k} (update this script)`); missed++; continue; }
    fs.writeFileSync(files[k], originals[k].replace(from, to));
    const c = collect();
    try { await run({ check: c.check, srcDir: path.join(copy, 'src') }); } catch (e) { c.list.push('threw: ' + String(e.message).slice(0, 100)); }
    if (c.list.length === 0) { missed++; console.log(`NOT CAUGHT   ${name}`); } else console.log(`caught (${String(c.list.length).padStart(2)})  ${name}`);
  }
  reset();
  console.log(missed === 0 ? `\nall ${MUTATIONS.length} upload link guards are held by a test that fails when the guard is removed` : `\n${missed} problem(s): see above`);
  process.exit(missed === 0 ? 0 : 1);
})();
