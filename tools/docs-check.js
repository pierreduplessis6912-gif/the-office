#!/usr/bin/env node
// Docs gate. Fails on: a missing or malformed status banner, an unknown status,
// an Owns path that does not exist, a broken relative link. Warns on: Verified older
// than 30 days or "not yet", and on every document still "unaudited".
// Banner (first non-empty line of every root .md and docs/**/*.md):
//   > **Status:** <real|partly built|proposed|principle|archived|unaudited>. **Verified:** <YYYY-MM-DD|not yet>. **Owns:** `path`, `path` | none.
const fs = require('fs'), path = require('path');
const root = path.resolve(__dirname, '..');
const STATUSES = ['real', 'partly built', 'proposed', 'principle', 'archived', 'unaudited'];
const STALE_DAYS = 30;
function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (['node_modules', '.git'].includes(e.name)) continue; if (dir === root && e.name !== 'docs') continue; walk(p, out); }
    else if (e.name.endsWith('.md')) out.push(p);
  }
  return out;
}
const files = walk(root, []).sort();
const errors = [], warnings = [];
const today = new Date(process.env.DOCS_CHECK_TODAY || Date.now());
let unaudited = 0, notYet = 0;
for (const f of files) {
  const rel = path.relative(root, f);
  const text = fs.readFileSync(f, 'utf8');
  const first = text.split('\n').find(l => l.trim() !== '') || '';
  const m = first.match(/^> \*\*Status:\*\* ([a-z ]+?)\. \*\*Verified:\*\* (\d{4}-\d{2}-\d{2}|not yet)[^*]*\. \*\*Owns:\*\* (.+?)\.?\s*$/);
  if (!m) { errors.push(`${rel}: first line is not a status banner`); continue; }
  const [, status, verified, owns] = m;
  if (!STATUSES.includes(status)) errors.push(`${rel}: unknown status "${status}"`);
  if (status === 'unaudited') unaudited++;
  if (verified === 'not yet') { notYet++; }
  else if (status !== 'archived' && (today - new Date(verified)) / 864e5 > STALE_DAYS) warnings.push(`${rel}: verified ${verified}, older than ${STALE_DAYS} days`);
  if (owns.trim() !== 'none') {
    for (const p of [...owns.matchAll(/`([^`]+)`/g)].map(x => x[1])) {
      if (!fs.existsSync(path.join(root, p))) errors.push(`${rel}: Owns path missing: ${p}`);
    }
  }
  const stripped = text.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
  for (const l of stripped.matchAll(/\]\(([^)#\s]+\.md)(#[^)]*)?\)/g)) {
    if (/^https?:/.test(l[1])) continue;
    if (!fs.existsSync(path.resolve(path.dirname(f), l[1]))) errors.push(`${rel}: broken link ${l[1]}`);
  }
}
// The two logs are indexes over part files: every "## " heading in a part must be listed in the index, under that part's own file.
for (const [idxName, dir] of [['DECISIONS.md', 'docs/decisions'], ['RUNBOOK.md', 'docs/runbook']]) {
  const idxPath = path.join(root, idxName), dirPath = path.join(root, dir);
  if (!fs.existsSync(idxPath) || !fs.existsSync(dirPath)) continue;
  const idxText = fs.readFileSync(idxPath, 'utf8');
  for (const pf of fs.readdirSync(dirPath).filter(n => n.endsWith('.md'))) {
    for (const line of fs.readFileSync(path.join(dirPath, pf), 'utf8').split('\n')) {
      if (!line.startsWith('## ')) continue;
      if (!idxText.includes(`- [${line.slice(3)}](${dir}/${pf})`)) errors.push(`${idxName}: heading not listed under ${dir}/${pf}: ${line.slice(3, 70)}`);
    }
  }
}
for (const w of warnings) console.log('warn  ' + w);
console.log(`docs: ${files.length} checked, ${unaudited} unaudited, ${notYet} not yet verified, ${warnings.length} stale, ${errors.length} errors`);
for (const e of errors) console.log('ERROR ' + e);
process.exit(errors.length ? 1 : 0);
