// The database's indexes (worker/src/indexes.ts), pre-staging audit 2026-10-12. Before them there were NO explicit indexes: 115 of the 235 distinct statements the application
// runs scanned a whole table. Here: the list is valid on the real schema, applying it is idempotent, and the statements it was written to fix still use an index.
// The schema is built from the baseline migration PLUS every CREATE TABLE and ADD COLUMN found in the source (many tables are created on first use).
const path = require('path'), fs = require('fs'), os = require('os'), esbuild = require('esbuild');
const { DatabaseSync } = require('node:sqlite');

function balanced(text, open) {   // from the "(" at `open`, the text up to its matching ")"
  let depth = 0;
  for (let i = open; i < text.length; i++) { if (text[i] === '(') depth++; else if (text[i] === ')') { depth--; if (depth === 0) return text.slice(open, i + 1); } }
  return null;
}
module.exports = async function runIndexTests({ check, srcDir }) {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'idx-')), 'indexes.js');
  esbuild.buildSync({ entryPoints: [path.join(srcDir, 'indexes.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent' });
  const { INDEXES, createIndexSql, applyIndexes } = require(out);
  const files = [...fs.readdirSync(srcDir).filter((f) => f.endsWith('.ts')).map((f) => path.join(srcDir, f)), ...fs.readdirSync(path.join(srcDir, 'intents')).map((f) => path.join(srcDir, 'intents', f))];
  const sourceText = files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  const norm = (s) => s.replace(/\s+/g, ' ').trim();
  const normSource = norm(sourceText);

  // ---- the schema, built from the source ------------------------------------------------------------------------------------------------
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(path.join(srcDir, '..', 'migrations', '0001_baseline.sql'), 'utf8'));
  const creates = [];
  for (const m of sourceText.matchAll(/CREATE TABLE IF NOT EXISTS\s+(\w+)\s*(?=\()/g)) { const body = balanced(sourceText, m.index + m[0].length); if (body) creates.push(`CREATE TABLE IF NOT EXISTS ${m[1]} ${body}`); }
  let made = 0; for (const c of creates) { try { db.exec(c); made++; } catch (e) {} }
  for (const m of sourceText.matchAll(/ALTER TABLE\s+(\w+)\s+ADD COLUMN\s+([^"`;]+)/g)) { try { db.exec(`ALTER TABLE ${m[1]} ADD COLUMN ${m[2].trim()}`); } catch (e) {} }
  check(creates.length >= 35 && made >= 35, `the schema is built from the baseline plus the ${creates.length} tables the application creates on first use`);

  // ---- the list is valid on the real schema, and applying it is safe to repeat -------------------------------------------------------
  const fakeEnv = { OFFICE_DB: { prepare: (sql) => { const stmt = (binds) => ({ bind: (...b) => stmt(b), all: async () => ({ results: db.prepare(sql).all(...binds) }), run: async () => db.prepare(sql).run(...binds) }); return stmt([]); } } };
  const first = await applyIndexes(fakeEnv);
  check(first.failed.length === 0 && first.tableNotYetCreated.length === 0 && first.created.length === INDEXES.length, `every index in the list can be created on the real schema (created ${first.created.length} of ${INDEXES.length}; failed: ${first.failed.map((f) => f.name + ' ' + f.error).join(', ') || 'none'}; table missing: ${first.tableNotYetCreated.join(', ') || 'none'})`);
  const second = await applyIndexes(fakeEnv);
  check(second.created.length === 0 && second.alreadyThere.length === INDEXES.length && second.failed.length === 0, 'applying the indexes a second time changes nothing (safe to run any time)');
  const partial = await applyIndexes({ OFFICE_DB: { prepare: (sql) => ({ bind: () => ({ all: async () => ({ results: [{ name: 'customers' }] }) }), all: async () => ({ results: [] }), run: async () => ({}) }) } });
  check(partial.tableNotYetCreated.length === INDEXES.length - INDEXES.filter((i) => i.table === 'customers').length, 'an index for a table that does not exist yet is skipped and reported, not an error (the table may be created on first use)');

  // ---- the rules that keep an index from changing an answer ---------------------------------------------------------------------------
  const multi = INDEXES.filter((i) => i.columns.includes(','));
  check(multi.length === 0, `indexes are single-column, so a query with no ORDER BY returns rows in the same order as a table scan (multi-column: ${multi.map((i) => i.name).join(', ') || 'none'})`);
  const special = INDEXES.filter((i) => i.where).map((i) => i.name);
  check(JSON.stringify(special) === JSON.stringify(['idx_tasks_open']), 'the only partial index is the one for open tasks');
  check(new Set(INDEXES.map((i) => i.name)).size === INDEXES.length && INDEXES.every((i) => /^idx_[a-z0-9_]+$/.test(i.name)), 'index names are unique and follow one pattern');
  const nocase = INDEXES.filter((i) => i.columns.includes('COLLATE NOCASE')).map((i) => i.table).sort();
  check(JSON.stringify(nocase) === JSON.stringify(['characters', 'customers', 'people', 'products']), 'the name lookups that ask COLLATE NOCASE have an index declared the same way (otherwise it would not be used)');

  // ---- the statements the indexes were written to fix still use them ---------------------------------------------------------------------
  const golden = JSON.parse(fs.readFileSync(path.join(__dirname, 'golden', 'index-plans.json'), 'utf8'));
  const inSource = golden.fixed.filter((s) => normSource.includes(s));
  check(inSource.length >= 40, `at least 40 of the statements the indexes fix are the application's own text (found verbatim in the source: ${inSource.length} of ${golden.fixed.length}; the rest are built at run time)`);
  const scans = (s) => db.prepare('EXPLAIN QUERY PLAN ' + s).all().map((p) => p.detail).filter((d) => /^SCAN /.test(d) && !/USING (COVERING )?INDEX/.test(d) && !/CONSTANT ROW/.test(d));
  const stillScan = []; for (const s of inSource) { try { if (scans(s).length) stillScan.push(s.slice(0, 70)); } catch (e) { stillScan.push('(cannot plan) ' + s.slice(0, 50)); } }
  check(stillScan.length === 0, `every one of those statements now uses an index instead of scanning the table (still scanning: ${stillScan.slice(0, 3).join(' | ') || 'none'})`);
  const hot = ['SELECT COUNT(*) as n FROM tasks WHERE done = 0', 'SELECT COUNT(*) as n FROM job_scopes WHERE scheduled_date >= ? AND scheduled_date <= ?', 'SELECT COUNT(*) as n FROM expenses WHERE date(created_at) = ?', 'SELECT id FROM customers WHERE name = ? COLLATE NOCASE'];
  check(hot.every((s) => normSource.includes(s) && scans(s).length === 0), 'the count queries that run on EVERY message (open tasks, scheduled jobs, today\'s expenses) and the customer lookup by name are all index lookups now');
  const remaining = golden.remaining.map((r) => r.sql);
  check(remaining.some((s) => /GROUP BY c\.id HAVING balance > 0/.test(s)), 'KNOWN GAP, recorded: the debtors count that also runs on every message still scans (it aggregates every invoice; an index cannot fix that, it needs a cached or maintained count)');
  const route = fs.readFileSync(path.join(srcDir, 'debug.ts'), 'utf8');
  check(/pathname === "\/debug\/init-indexes" && request\.method === "POST"/.test(route) && /applyIndexes\(env\)/.test(route), 'POST /debug/init-indexes exists to apply the indexes to the live database');
};
