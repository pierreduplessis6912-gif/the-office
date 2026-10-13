// The migration runner: copies one business's data from a SOURCE deployment into a business object on a TARGET deployment over HTTP, then proves it arrived by comparing fingerprints from both
// sides. It drives the privileged /admin/migration routes (worker/src/migration-routes.ts). It never writes to the source. Every step is idempotent, so an interrupted run is simply run again.
//
//   migrate({ source: {base, adminKey, confirmKey}, target: {base, adminKey, confirmKey, business}, include, vectors, force, log, fetchImpl })
//
// It refuses to copy into a target that already holds data unless `force` is set (a half-finished earlier run is the usual reason).
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Two metadata objects are the same if they hold the same content, whatever order their keys come back in.
const canonicalJson = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));

// The same comparison as worker/src/migration.ts (a test pins that the two agree).
export function compareFingerprints(source, target) {
  const out = [];
  for (const [name, s] of Object.entries(source.tables)) {
    const t = target.tables[name];
    if (!t) out.push(`table ${name}: missing in the target`);
    else if (t.count !== s.count) out.push(`table ${name}: ${s.count} rows in the source, ${t.count} in the target`);
    else if (t.hash !== s.hash) out.push(`table ${name}: same row count (${s.count}) but the contents differ`);
  }
  for (const [name, seq] of Object.entries(source.sequences)) if ((target.sequences[name] ?? 0) < seq) out.push(`id counter ${name}: ${seq} in the source, ${target.sequences[name] ?? 0} in the target`);
  for (const kind of ['notes', 'files']) {
    if (source[kind].count !== target[kind].count) out.push(`${kind}: ${source[kind].count} in the source, ${target[kind].count} in the target`);
    else if (source[kind].hash !== target[kind].hash) out.push(`${kind}: same count (${source[kind].count}) but the contents differ`);
  }
  return out;
}

// Parents before children, so a table is copied after the tables it references.
export function copyOrder(tables) {
  const byName = new Map(tables.map((t) => [t.name, t]));
  const done = new Set(), order = [];
  const visit = (name, trail = []) => {
    if (done.has(name) || trail.includes(name)) return;
    for (const p of byName.get(name)?.parents ?? []) if (byName.has(p) && p !== name) visit(p, [...trail, name]);
    done.add(name); order.push(name);
  };
  for (const t of tables) visit(t.name);
  return order;
}

export async function migrate({ source, target, include = {}, vectors = null, force = false, pageSize = 200, log = () => {}, fetchImpl = fetch, pollMs = 5000 }) {
  const want = { db: true, notes: true, files: true, ...include };
  const started = Date.now();
  const report = { ok: false, steps: [], mismatches: [] };
  let lastTick = Date.now();
  const step = (name, detail = {}) => { const now = Date.now(); report.steps.push({ name, ...detail, ms: now - lastTick }); lastTick = now; log(`${name} ${JSON.stringify(detail)}`); };

  async function call(side, method, path, { query = {}, json, body, type, raw = false, workerLevel = false } = {}) {
    const url = new URL(path, side.base);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
    const headers = { 'X-Admin-Key': side.adminKey, 'X-Admin-Confirm': side.confirmKey };
    if (side.business && !workerLevel) headers['X-Target-Business'] = side.business;
    if (json !== undefined) headers['Content-Type'] = 'application/json'; else if (type) headers['Content-Type'] = type;
    let last;
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        const res = await fetchImpl(url.toString(), { method, headers, body: json !== undefined ? JSON.stringify(json) : body });
        if (res.status >= 500 && attempt < 4) { last = new Error(`${method} ${path} -> ${res.status}`); await sleep(400 * attempt); continue; }
        if (!res.ok) { const e = new Error(`${method} ${path} -> ${res.status} ${(await res.text()).slice(0, 240)}`); e.fatal = true; throw e; }
        return raw ? res : await res.json();
      } catch (e) {
        if (e.fatal || attempt === 4) throw e;   // a 4xx is an answer, not a glitch
        last = e; await sleep(400 * attempt);
      }
    }
    throw last;
  }

  // Whatever goes wrong, the caller gets back what was done, how far it got and the error: a failure must never lose the report (the first real rehearsal crashed and printed nothing).
  try {
    // ---- pre-flight ---------------------------------------------------------------------------------------------------------------------------------------------------------
    // Before a single byte is copied: what are the two ends? If the source and the target are really the SAME deployment (a target that ignores the business it was asked for), the copy would write a
    // database onto itself. So each end must say what it is, and it must be what the caller expects.
    const sourceIs = await call(source, 'GET', '/admin/migration/whoami'), targetIs = await call(target, 'GET', '/admin/migration/whoami');
    const wrongSource = (source.business ?? null) !== sourceIs.businessId, wrongTarget = (target.business ?? null) !== targetIs.businessId;
    step('who is who', { source: sourceIs.businessId ?? 'the single-business deployment', target: targetIs.businessId ?? 'the single-business deployment' });
    if (wrongSource || wrongTarget || (sourceIs.businessId === null && targetIs.businessId === null)) {
      report.mismatches.push(`refusing to copy: the ${wrongSource ? 'source' : 'target'} is not what was asked for (source answered as ${sourceIs.businessId ?? 'the single-business deployment'}, target answered as ${targetIs.businessId ?? 'the single-business deployment'}). Nothing was copied.`);
      report.durationMs = Date.now() - started;
      return report;
    }
    const manifest = await call(source, 'GET', '/admin/migration/manifest');
    step('source manifest', { tables: manifest.tables.length, rows: manifest.tables.reduce((n, t) => n + t.count, 0), counters: manifest.sequences.length });
    const before = await call(target, 'GET', '/admin/migration/fingerprint');
    const occupied = Object.entries(before.tables).filter(([, t]) => t.count > 0).map(([n, t]) => `${n} (${t.count})`);
    if ((occupied.length || before.notes.count || before.files.count) && !force) {
      step('target is not empty', { occupied, notes: before.notes.count, files: before.files.count });
      report.mismatches.push('the target business already holds data; refusing to mix (use force to copy over it)');
      report.durationMs = Date.now() - started;
      return report;
    }
    // The team must be able to sign in afterwards, and an email is never moved between businesses: so find out NOW, before anything is copied, whether any active member already belongs elsewhere.
    if (want.db && manifest.tables.some((t) => t.name === 'memberships')) {
      const team = [];
      for (let after = 0; ;) {
        const page = await call(source, 'GET', '/admin/migration/rows', { query: { table: 'memberships', after, limit: pageSize } });
        if (!page.rows.length) break;
        team.push(...page.rows.filter((m) => m.status === 'active' && m.google_email)); after = page.last;
      }
      if (team.length) {
        const check = await call(target, 'POST', '/debug/directory/check-members', { json: { business_id: target.business, emails: team.map((m) => m.google_email) }, workerLevel: true });
        step('team check', { activeMembers: team.length, alreadyInAnotherBusiness: check.conflicts.length });
        if (check.conflicts.length) {
          report.mismatches.push(`${check.conflicts.length} active team member(s) already belong to another business, so they could not be registered to this one: ${check.conflicts.map((c) => `${c.email} (in ${c.business_id})`).join(', ')}. NOTHING was copied.`);
          report.durationMs = Date.now() - started;
          return report;
        }
      }
    }
    const order = copyOrder(manifest.tables);

    // ---- the database ---------------------------------------------------------------------------------------------------------------------------------------------------------
    const memberships = [];
    if (want.db) {
      const schema = await call(target, 'POST', '/admin/migration/schema', { json: { tables: order.map((n) => manifest.tables.find((t) => t.name === n)).map(({ name, sql, columns }) => ({ name, sql, columns })) } });
      step('schema', { created: schema.created, columnsAdded: schema.columnsAdded });
      let total = 0;
      for (const name of order) {
        let after = 0, n = 0;
        for (;;) {
          const page = await call(source, 'GET', '/admin/migration/rows', { query: { table: name, after, limit: pageSize } });
          if (!page.rows.length) break;
          await call(target, 'POST', '/admin/migration/rows', { json: { table: name, rows: page.rows } });
          if (name === 'memberships') memberships.push(...page.rows);
          n += page.rows.length; after = page.last;
        }
        total += n;
        if (n) step(`rows ${name}`, { copied: n });
      }
      const seq = await call(target, 'POST', '/admin/migration/sequences', { json: { sequences: manifest.sequences } });
      step('id counters', { carried: seq.set });
      step('database done', { rows: total });
    }

    // ---- notes ------------------------------------------------------------------------------------------------------------------------------------------------------------------
    if (want.notes) {
      let cursor = null, n = 0;
      do {
        const page = await call(source, 'GET', '/admin/migration/notes', { query: cursor ? { cursor } : {} });
        if (page.entries.length) await call(target, 'POST', '/admin/migration/notes', { json: { entries: page.entries } });
        n += page.entries.length; cursor = page.cursor;
      } while (cursor);
      step('notes', { copied: n });
    }

    // ---- files ------------------------------------------------------------------------------------------------------------------------------------------------------------------
    if (want.files) {
      let cursor = null, n = 0, bytes = 0;
      do {
        const page = await call(source, 'GET', '/admin/migration/files', { query: cursor ? { cursor } : {} });
        for (const o of page.objects) {
          const res = await call(source, 'GET', '/admin/migration/file', { query: { key: o.key }, raw: true });
          const data = new Uint8Array(await res.arrayBuffer());
          await call(target, 'POST', '/admin/migration/file', { query: { key: o.key, type: res.headers.get('content-type') ?? 'application/octet-stream' }, body: data });
          n++; bytes += data.length;
        }
        cursor = page.cursor;
      } while (cursor);
      step('files', { copied: n, bytes });
    }

    // ---- memories (through Cloudflare's API: the Worker cannot list a Vectorize index) -------------------------------------------------------------------------
    if (vectors) {
      const api = (path) => fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${vectors.accountId}/vectorize/v2/indexes/${vectors.indexName}${path}`, { headers: { Authorization: `Bearer ${vectors.apiToken}` } }).then((r) => r.json());
      const ids = []; let cursor = null;
      do { const r = await api(`/list?count=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`); if (!r.success) throw new Error(`could not list the memory index: ${JSON.stringify(r.errors)}`); ids.push(...r.result.vectors.map((v) => v.id)); cursor = r.result.isTruncated ? r.result.nextCursor : null; } while (cursor);
      // Vectorize applies a write ASYNCHRONOUSLY (found on the real index: about 100 seconds for two vectors), so reading back straight after writing would report false differences. Every write
      // returns a mutation id; Cloudflare's index info says how far it has processed (processedUpToMutation). Wait for the LAST write, then read everything back and compare.
      let copied = 0, differ = 0, lastMutation = null;
      const copiedVectors = [];
      for (let i = 0; i < ids.length; i += 20) {
        const chunk = ids.slice(i, i + 20);
        const got = await call(source, 'POST', '/admin/migration/vectors-by-ids', { json: { ids: chunk } });
        const written = await call(target, 'POST', '/admin/migration/vectors', { json: { vectors: got.vectors } });
        if (written.mutationId) lastMutation = written.mutationId;
        copiedVectors.push(...got.vectors); copied += got.vectors.length;
      }
      let waitedMs = 0, processed = lastMutation === null;
      if (lastMutation && vectors.targetIndexName) {
        const infoUrl = `https://api.cloudflare.com/client/v4/accounts/${vectors.accountId}/vectorize/v2/indexes/${vectors.targetIndexName}/info`;
        const limit = vectors.maxWaitMs ?? 600000;
        while (waitedMs <= limit) {
          const info = await fetchImpl(infoUrl, { headers: { Authorization: `Bearer ${vectors.apiToken}` } }).then((r) => r.json());
          if (info.success && info.result?.processedUpToMutation === lastMutation) { processed = true; break; }
          await sleep(pollMs); waitedMs += pollMs;
        }
      }
      if (!processed) report.mismatches.push(`memories: the target index had not processed the writes after ${Math.round(waitedMs / 1000)} s, so they could not be verified`);
      // Reading back right after Cloudflare says a write is processed can still show OLD state (found on the real index: after a 120 s wait 25 of 45 read back differently, after a 160 s wait none did).
      // So only the memories that differ are checked AGAIN, repeatedly, for a bounded time; a difference that persists to the end is a real one.
      const differing = async (vs) => {
        const bad = [];
        for (let i = 0; i < vs.length; i += 20) {
          const chunk = vs.slice(i, i + 20);
          const back = await call(target, 'POST', '/admin/migration/vectors-by-ids', { json: { ids: chunk.map((v) => v.id) } });
          const byId = new Map(back.vectors.map((v) => [v.id, v]));
          for (const v of chunk) { const b = byId.get(v.id); if (!b || canonicalJson(b.metadata) !== canonicalJson(v.metadata) || b.values.length !== v.values.length || b.values.some((x, j) => Math.abs(x - v.values[j]) > 1e-6)) bad.push(v); }
        }
        return bad;
      };
      let pending = await differing(copiedVectors), verifyWaitedMs = 0;
      const firstPassDiffered = pending.length;
      const verifyLimit = vectors.verifyMaxMs ?? 240000;
      // (If the target never processed the writes there is nothing to wait for: that is already reported above, and re-checking would only burn the whole time limit.)
      while (processed && pending.length && verifyWaitedMs < verifyLimit) { await sleep(pollMs); verifyWaitedMs += pollMs; pending = await differing(pending); }
      differ = pending.length;
      step('memories', { listed: ids.length, copied, differ, firstPassDiffered, readLagSeconds: Math.round(verifyWaitedMs / 1000), waitedSeconds: Math.round(waitedMs / 1000), processed });
      if (differ || copied !== ids.length) report.mismatches.push(`memories: ${ids.length} listed, ${copied} copied, ${differ} differ after being read back`);
    }

    // ---- the team can sign in: register each ACTIVE member in the directory -------------------------------------------------------------------------
    if (want.db && memberships.length) {
      const registered = [], skipped = [];
      for (const m of memberships) {
        if (m.status !== 'active') { skipped.push(m.status); continue; }
        await call(target, 'POST', '/debug/directory/add-member', { json: { email: m.google_email, business_id: target.business, role: m.role, skip_membership: true }, workerLevel: true });
        registered.push(m.role);
      }
      step('directory', { registered: registered.length, notActive: skipped.length });
    }
    const indexes = await call(target, 'POST', '/debug/init-indexes');
    step('indexes', { created: indexes.created.length, failed: indexes.failed.length });

    // ---- the proof --------------------------------------------------------------------------------------------------------------------------------------------------------------
    const fs = await call(source, 'GET', '/admin/migration/fingerprint');
    const ft = await call(target, 'GET', '/admin/migration/fingerprint');
    const diff = compareFingerprints(fs, ft);
    report.mismatches.push(...diff);
    step('fingerprints compared', { tables: Object.keys(fs.tables).length, notes: fs.notes.count, files: fs.files.count, differences: diff.length });

    report.ok = report.mismatches.length === 0;
  } catch (e) {
    report.ok = false;
    report.error = String(e && e.message ? e.message : e).slice(0, 700);
    report.failedAfter = report.steps.length ? report.steps[report.steps.length - 1].name : 'the start';
  }
  report.durationMs = Date.now() - started;
  return report;
}
