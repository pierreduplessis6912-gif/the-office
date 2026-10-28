#!/usr/bin/env node
// Docs gate. Fails on: a missing or malformed status banner, an unknown status,
// an Owns path that does not exist, a broken relative link. Warns on: Verified older
// than 30 days or "not yet", and on every document still "unaudited". It also FAILS when HANDOVER.md names an older production commit than ops/production-signup-check-last.json reports (tools/docs-state.js).
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
let unaudited = 0, notYet = 0, logParts = 0;
const owners = [];   // [doc, owned code paths] for the code-with-docs check below
const isLog = (rel) => rel.startsWith('docs/decisions/') || rel.startsWith('docs/runbook/');   // append-only dated history: what was true on the day of each entry; claims about today live in the owning documents
for (const f of files) {
  const rel = path.relative(root, f);
  const text = fs.readFileSync(f, 'utf8');
  const first = text.split('\n').find(l => l.trim() !== '') || '';
  const m = first.match(/^> \*\*Status:\*\* ([a-z ]+?)\. \*\*Verified:\*\* (\d{4}-\d{2}-\d{2}|not yet)[^*]*\. \*\*Owns:\*\* (.+?)\.?\s*$/);
  if (!m) { errors.push(`${rel}: first line is not a status banner`); continue; }
  const [, status, verified, owns] = m;
  if (!STATUSES.includes(status)) errors.push(`${rel}: unknown status "${status}"`);
  if (status === 'unaudited') unaudited++;
  if (isLog(rel)) logParts++;
  else if (verified === 'not yet') { notYet++; }
  else if (status !== 'archived' && (today - new Date(verified)) / 864e5 > STALE_DAYS) warnings.push(`${rel}: verified ${verified}, older than ${STALE_DAYS} days`);
  if (owns.trim() !== 'none') {
    const paths = [...owns.matchAll(/`([^`]+)`/g)].map(x => x[1]);
    for (const p of paths) {
      if (!fs.existsSync(path.join(root, p))) errors.push(`${rel}: Owns path missing: ${p}`);
    }
    if (status !== 'archived') owners.push([rel, paths]);
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
// CODE AND DOCS MOVE TOGETHER: a document names the code it owns (Owns:). When a push changes an owned code file (worker/src or app/lib) and does NOT touch the owning document, that is a warning; for the security-sensitive files it is an ERROR. INDEX.md and HANDOVER.md list code but do not describe it, so they are not asked to follow it. The base is DOCS_CHECK_BASE (CI passes the push's "before" commit), else the branch against origin/main, else the last commit; with none of those it says so and skips.
const SENSITIVE = /^worker\/src\/(auth|admin-gate|routing|access|billing|payfast[\w-]*|mcp|mcp-keys|mcp-key-format|refusals)\.ts$/;
const NOT_ASKED = new Set(['INDEX.md', 'HANDOVER.md']);
function changedFiles() {
  const { execSync } = require('child_process');
  const base = process.env.DOCS_CHECK_BASE;
  const tries = base && !/^0+$/.test(base) ? [`git diff --name-only ${base} HEAD`] : ['git diff --name-only origin/main...HEAD', 'git diff --name-only HEAD~1 HEAD'];
  for (const cmd of tries) { try { const out = execSync(cmd, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); return out ? out.split('\n') : []; } catch { /* try the next */ } }
  return null;
}
const changed = changedFiles();
let coupled = 0, uncoupled = 0;
if (changed === null) console.log('note  code-with-docs check skipped: no base commit to compare with');
else {
  const touched = new Set(changed);
  for (const [rel, paths] of owners) {
    if (NOT_ASKED.has(rel)) continue;
    for (const p of paths.filter((x) => /^(worker\/src|app\/lib)\//.test(x) && touched.has(x))) {
      if (touched.has(rel)) { coupled++; continue; }
      uncoupled++;
      (SENSITIVE.test(p) ? errors : warnings).push(`${rel}: owns ${p}, which changed, but the document was not touched in the same push${SENSITIVE.test(p) ? ' (security-sensitive: update it)' : ''}`);
    }
  }
}
// The handover must name the commit production runs (tools/docs-state.js).
{
  const { productionCommitCheck } = require('./docs-state.js'), { spawnSync } = require('child_process');
  const git = (args) => { const r = spawnSync('git', args, { cwd: root }); return r.error ? null : r.status; };
  let record = null; try { record = JSON.parse(fs.readFileSync(path.join(root, 'ops', 'production-signup-check-last.json'), 'utf8')).running_commit || null; } catch { /* no record */ }
  let handover = ''; try { handover = fs.readFileSync(path.join(root, 'HANDOVER.md'), 'utf8'); } catch { /* none */ }
  const r = productionCommitCheck({ handover, recordCommit: record,
    exists: (c) => { const st = git(['cat-file', '-e', c + '^{commit}']); return st === 0 ? true : st === 128 || st === 1 ? false : null; },
    isAncestor: (a, b) => { const st = git(['merge-base', '--is-ancestor', a, b]); return st === 0 ? true : st === 1 ? false : null; } });
  errors.push(...r.errors); warnings.push(...r.warnings);
}
for (const w of warnings) console.log('warn  ' + w);
console.log(`docs: ${files.length} checked (${logParts} are dated logs), ${unaudited} unaudited, ${notYet} not yet verified, ${warnings.length} warnings, ${errors.length} errors; code-with-docs: ${coupled} owned code files changed with their document, ${uncoupled} without`);
for (const e of errors) console.log('ERROR ' + e);
process.exit(errors.length ? 1 : 0);
