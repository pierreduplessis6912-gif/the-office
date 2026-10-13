// A READ-ONLY inventory of a deployment's business data: how much there is, so a migration can be sized and planned. It uses only GET requests to the privileged /admin/migration routes and has no code
// that can write (there is no POST, PUT or DELETE anywhere in this file; a test checks that). It never asks for a fingerprint (that reads and hashes everything in one request, which is not something to do
// to a live production Worker). The report holds COUNTS and SIZES only: no names, no emails, no values.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Rough rates from the real rehearsal on Cloudflare (a sequential runner over the network): seconds per unit of work. They are a guide, not a promise.
export const RATES = { perTable: 0.8, perRowPage: 1.5, perNote: 0.16, perFile: 1.0, perVectorBatch: 3, vectorWait: 150, fingerprintBase: 40, fingerprintPerThousandRows: 4 };

export function estimate({ rows, tables, notes, files, vectors, pageSize = 200 }) {
  const seconds = tables * RATES.perTable + Math.ceil(rows / pageSize) * RATES.perRowPage + notes * RATES.perNote + files * RATES.perFile + Math.ceil(vectors / 20) * RATES.perVectorBatch + (vectors ? RATES.vectorWait : 0) + RATES.fingerprintBase + (rows / 1000) * RATES.fingerprintPerThousandRows;
  return { sequentialSecondsExpected: Math.round(seconds), sequentialSecondsLow: Math.round(seconds * 0.5), sequentialSecondsHigh: Math.round(seconds * 2) };
}

export async function inventory({ source, vectorCount = 0, pageSize = 200, fetchImpl = fetch }) {
  const started = Date.now();
  const report = { ok: false, readOnly: true, requests: 0 };
  async function get(path, query = {}) {
    const url = new URL(path, source.base);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
    let last;
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        report.requests++;
        const res = await fetchImpl(url.toString(), { method: 'GET', headers: { 'X-Admin-Key': source.adminKey, 'X-Admin-Confirm': source.confirmKey, ...(source.business ? { 'X-Target-Business': source.business } : {}) } });
        if (res.status >= 500 && attempt < 4) { last = new Error(`GET ${path} -> ${res.status}`); await sleep(400 * attempt); continue; }
        if (!res.ok) { const e = new Error(`GET ${path} -> ${res.status} ${(await res.text()).slice(0, 200)}`); e.fatal = true; throw e; }
        return await res.json();
      } catch (e) {
        if (e.fatal || attempt === 4) throw e;
        last = e; await sleep(400 * attempt);
      }
    }
    throw last;
  }
  try {
    const manifest = await get('/admin/migration/manifest');
    const perTable = manifest.tables.map((t) => ({ name: t.name, rows: t.count })).sort((a, b) => b.rows - a.rows);
    const rows = perTable.reduce((n, t) => n + t.rows, 0);
    report.database = { tables: perTable.length, rows, autoincrementCounters: manifest.sequences.length, emptyTables: perTable.filter((t) => t.rows === 0).length, largestTables: perTable.slice(0, 12) };

    // The team, by role and status only (the addresses are read and discarded, never kept).
    if (manifest.tables.some((t) => t.name === 'memberships')) {
      const team = { active: {}, other: 0 };
      for (let after = 0; ;) {
        const page = await get('/admin/migration/rows', { table: 'memberships', after, limit: pageSize });
        if (!page.rows.length) break;
        for (const m of page.rows) { if (m.status === 'active') team.active[m.role] = (team.active[m.role] ?? 0) + 1; else team.other++; }
        after = page.last;
      }
      report.team = { activeByRole: team.active, activeTotal: Object.values(team.active).reduce((a, b) => a + b, 0), notActive: team.other };
    }

    let notes = 0, noteBytes = 0, cursor = null;
    do {
      const page = await get('/admin/migration/notes', cursor ? { cursor } : {});
      for (const e of page.entries) { notes++; noteBytes += new TextEncoder().encode(e.value).length; }
      cursor = page.cursor;
    } while (cursor);
    report.notes = { count: notes, bytes: noteBytes };

    let files = 0, fileBytes = 0, fcursor = null; const byFolder = {};
    do {
      const page = await get('/admin/migration/files', fcursor ? { cursor: fcursor } : {});
      for (const o of page.objects) { files++; fileBytes += o.size; const folder = o.key.split('/')[0]; byFolder[folder] ??= { count: 0, bytes: 0 }; byFolder[folder].count++; byFolder[folder].bytes += o.size; }
      fcursor = page.cursor;
    } while (fcursor);
    report.files = { count: files, bytes: fileBytes, largestFile: null, byFolder };
    report.memories = { count: vectorCount };
    report.estimate = { ...estimate({ rows, tables: perTable.length, notes, files, vectors: vectorCount, pageSize }), note: 'sequential, from the rehearsal rates; a guide only. The copy can be made concurrent; the final copy needs the freeze for about this long unless it is.' };
    report.ok = true;
  } catch (e) {
    report.error = String(e && e.message ? e.message : e).slice(0, 500);
  }
  report.seconds = Math.round((Date.now() - started) / 1000);
  return report;
}
