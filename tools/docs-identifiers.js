#!/usr/bin/env node
// Triage for the docs audit (a diagnostic, not a CI gate): for each document, pull the backticked file paths, routes, tables, functions and variables out of it and check each still exists in the code. A document full of missing names is probably stale; a document whose names all exist still needs its built-versus-proposed claims read, but the evidence of the names is real.
// Usage: node tools/docs-identifiers.js [file.md ...]   (default: every root .md)   Output per document: names checked, missing, and the missing ones.
const fs = require('fs'), path = require('path');
const root = path.resolve(__dirname, '..');
const SRC = ['worker/src', 'app/lib', 'app/test', 'tools', '.github/workflows', 'worker/wrangler.toml', 'worker/migrations'];
let corpus = '';
(function walk(p) { const full = path.join(root, p); if (!fs.existsSync(full)) return; const st = fs.statSync(full); if (st.isDirectory()) { if (['node_modules', '.git', 'golden'].includes(path.basename(full))) return; for (const e of fs.readdirSync(full)) walk(path.join(p, e)); } else if (/\.(ts|js|dart|yml|yaml|toml|sql|json)$/.test(full) && st.size < 3e6) corpus += '\n' + fs.readFileSync(full, 'utf8'); })(''); for (const s of SRC) { /* corpus built from the whole repo below */ }
const files = process.argv.length > 2 ? process.argv.slice(2) : fs.readdirSync(root).filter((f) => f.endsWith('.md'));
const PATHLIKE = /^[\w.\-\/]+\.(ts|js|dart|md|json|yml|yaml|toml|sql|html)$/;
const ROUTE = /^(GET|POST|PATCH|PUT|DELETE) (\/[\w\-\/:.?=&{}<>*]*)$/;
const IDENT = /^[A-Za-z_][A-Za-z0-9_]{3,}$/;
const SKIP = new Set(['null', 'true', 'false', 'undefined', 'string', 'number', 'boolean', 'object', 'array', 'type', 'name', 'data', 'text', 'email', 'status', 'error', 'message', 'result', 'value', 'items', 'label', 'version', 'mode', 'None', 'Yes', 'real']);
function check(tok) {
  if (/^[0-9a-f]{7}$/.test(tok)) return 'skip';   // a commit hash: history, not code
  if (PATHLIKE.test(tok)) return ['', 'docs', 'worker', 'worker/src', 'worker/scripts', 'app', 'app/lib', 'tools', '.github/workflows'].some((d) => fs.existsSync(path.join(root, d, tok))) ? 'ok' : 'missing';
  const r = ROUTE.exec(tok); if (r) { const segs = r[2].split('?')[0].split('/').filter((x) => x && !/^(:\w+|\{[^}]*\}|<[^>]*>)$/.test(x)); return segs.every((x) => corpus.includes(x)) ? 'ok' : 'missing'; }   // every fixed part of the route must exist somewhere in the code
  if (tok.includes(' ') || SKIP.has(tok)) return 'skip';
  if (IDENT.test(tok)) { return corpus.includes(tok) ? 'ok' : 'missing'; }
  return 'skip';
}
for (const f of files) {
  const text = fs.readFileSync(path.join(root, f), 'utf8').replace(/```[\s\S]*?```/g, '');
  const toks = [...new Set([...text.matchAll(/`([^`\n]{2,80})`/g)].map((m) => m[1].trim()))];
  const res = toks.map((t) => [t, check(t)]).filter(([, s]) => s !== 'skip');
  const missing = res.filter(([, s]) => s === 'missing').map(([t]) => t);
  const banner = (text.match(/\*\*Status:\*\* ([a-z ]+)\./) || [])[1] || '?';
  console.log(`${f.padEnd(44)} ${banner.padEnd(13)} names ${String(res.length).padStart(3)}  missing ${String(missing.length).padStart(3)}  ${missing.slice(0, 7).join(' | ').slice(0, 170)}`);
}
