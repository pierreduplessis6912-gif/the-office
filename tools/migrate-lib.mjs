// The migration runner: copies one business's data from a SOURCE deployment into a business object on a TARGET deployment over HTTP, then proves it arrived by comparing fingerprints from both
// sides. It drives the privileged /admin/migration routes (worker/src/migration-routes.ts). It never writes to the source. Every step is idempotent, so an interrupted run is simply run again.
//
//   migrate({ source: {base, adminKey, confirmKey}, target: {base, adminKey, confirmKey, business}, include, vectors, force, log, fetchImpl })
//
// It refuses to copy into a target that already holds data unless `force` is set (a half-finished earlier run is the usual reason).
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

export async function migrate({ source, target, include = {}, vectors = null, force = false, pageSize = 200, log = () => {}, fetchImpl = fetch }) {
  const want = { db: true, notes: true, files: true, ...include };
  const started = Date.now();
  const report = { ok: false, steps: [], mismatches: [] };
  const step = (name, detail = {}) => { report.steps.push({ name, ...detail }); log(`${name} ${JSON.stringify(detail)}`); };

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

  // ---- pre-flight ---------------------------------------------------------------------------------------------------------------------------------------------------------
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
    let copied = 0, differ = 0;
    for (let i = 0; i < ids.length; i += 20) {
      const chunk = ids.slice(i, i + 20);
      const got = await call(source, 'POST', '/admin/migration/vectors-by-ids', { json: { ids: chunk } });
      await call(target, 'POST', '/admin/migration/vectors', { json: { vectors: got.vectors } });
      const back = await call(target, 'POST', '/admin/migration/vectors-by-ids', { json: { ids: chunk } });
      const byId = new Map(back.vectors.map((v) => [v.id, v]));
      for (const v of got.vectors) { const b = byId.get(v.id); if (!b || JSON.stringify(b.metadata) !== JSON.stringify(v.metadata) || b.values.length !== v.values.length || b.values.some((x, j) => Math.abs(x - v.values[j]) > 1e-6)) differ++; }
      copied += got.vectors.length;
    }
    step('memories', { listed: ids.length, copied, differ });
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
  report.durationMs = Date.now() - started;
  return report;
}
