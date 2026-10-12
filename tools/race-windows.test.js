// Race windows (architecture stage 2, 2026-10-12). Inside a business's Durable Object, a run of database calls cannot be interleaved with another request (storage is synchronous), but
// a wait on an OUTSIDE call can: the model, the notes store, memory search, file storage. The dangerous pattern is: a table is READ, then an outside call waits, then the SAME table
// is WRITTEN, because the write may rest on something another request has since changed. Every recorded message-level case is examined (the harness logs each statement and each
// outside call in order, with the function that made it), and every such window must be in tools/golden/race-windows.json with a written reason it is safe. A NEW window fails the
// build until somebody reviews it. Bookkeeping tables that are written on every request and never decide anything are ignored (listed in the golden file, not hidden here).
const fs = require('fs'), path = require('path');
const harness = require('./harness.js');

const READ = /^\s*(select|with|pragma)\b/i, WRITE = /^\s*(insert|update|delete|replace)\b/i, TABLE = /\b(?:from|join|into|update)\s+([a-z_][a-z0-9_]*)/gi;

function observedWindows(log, ignore) {
  const tablesOf = (sql) => new Set([...sql.matchAll(TABLE)].map((m) => m[1].toLowerCase()).filter((t) => !ignore.has(t)));
  const found = new Map();
  for (const c of log) {
    if (c.kind !== 'runTranscriptCase' && c.kind !== 'runCase') continue;   // whole messages (a route case is not one request's pipeline)
    const ev = c.ev;
    for (let p = 0; p < ev.length; p++) {
      if (ev[p].k !== 'io') continue;
      const readBefore = new Set();
      for (let i = 0; i < p; i++) if (ev[i].k === 'sql' && READ.test(ev[i].s)) for (const t of tablesOf(ev[i].s)) readBefore.add(t);
      for (let q = p + 1; q < ev.length; q++) {
        if (ev[q].k !== 'sql' || !WRITE.test(ev[q].s)) continue;
        for (const t of tablesOf(ev[q].s)) if (readBefore.has(t)) { const key = `${ev[p].kind}|${ev[p].fn}|${t}|${ev[q].fn}`; if (!found.has(key)) found.set(key, new Set()); found.get(key).add(c.n); }
      }
    }
  }
  return found;
}

module.exports = function runRaceWindowTests({ check }) {
  const golden = JSON.parse(fs.readFileSync(path.join(__dirname, 'golden', 'race-windows.json'), 'utf8'));
  const log = harness.raceLog();
  const observed = observedWindows(log, new Set(golden.ignoredTables));
  if (process.env.RACE_PRINT === '1') console.log('RACE_WINDOWS ' + JSON.stringify([...observed.keys()].sort()));
  const messageCases = log.filter((c) => c.kind === 'runTranscriptCase' || c.kind === 'runCase').length;
  const calls = log.reduce((n, c) => n + c.ev.filter((e) => e.k === 'io').length, 0);
  check(messageCases >= 400 && calls >= 500, `the audit examined ${messageCases} message-level cases and ${calls} outside calls (it must examine them all, or it proves nothing)`);
  const fresh = [...observed.keys()].filter((k) => !golden.windows[k]).sort();
  check(fresh.length === 0, `no NEW place where a table is read, an outside call waits, and the same table is then written (review it, then add it to tools/golden/race-windows.json with the reason it is safe). New: ${fresh.join(' ; ')}`);
  const gone = Object.keys(golden.windows).filter((k) => !observed.has(k));
  check(gone.length === 0, `every reviewed window is still observed (good news if one is gone: remove it from the golden file). Gone: ${gone.join(' ; ')}`);
  check(Object.values(golden.windows).every((w) => w && w.verdict && ['safe', 'accepted'].includes(w.verdict) && typeof w.reason === 'string' && w.reason.length >= 40), 'every reviewed window carries a verdict (safe or accepted) and a real reason');
  check(Object.entries(golden.windows).every(([k, w]) => w.verdict !== 'accepted' || /risk/i.test(w.reason)), 'a window that is only "accepted" (not safe by construction) states the risk it accepts');
  const callers = new Set([...observed.keys()].map((k) => k.split('|')[1]));
  const kvOrVec = [...observed.keys()].filter((k) => /^(kv|vec|r2)\|/.test(k));
  check(kvOrVec.length === 0, `no window exists around the notes store, memory search or file storage (found: ${kvOrVec.join(' ; ') || 'none'})`);
  check(!callers.has('?'), 'every outside call in a window is attributed to a named function (an unnamed one could not be reviewed)');
};
