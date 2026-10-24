// Coverage guard for structured refusals (ENVELOPE.md, version 2). Every place in the Worker that tells a person, in words, that their ROLE stops them must ALSO say so in
// structure (worker/src/refusals.ts), or the envelope would say nothing while the words refuse. This test scans the source: any refusal wording that is not beside a structured
// refusal, and is not one of the named exceptions below, fails. "Beside" is strict: on the SAME line for a fact inside a composed answer or a returned object, and within 4 lines only
// where the sentence is a plain `message = "..."` assignment or a branch of the ternary that sets it (the structured push sits next to the assignment). So a new refusal sentence cannot be added without its structured twin.
const fs = require('fs'), path = require('path');
const PHRASE = /restricted for (your|this member's) role|available for your role/;
const NEAR = /cannotSee\(|cannotSeePart\(|cannotRecordPart\(|cannotRecord\(|withheld\(|refusals|refusalFromCreationMessage|intentCreationRefusalInfo/;
// Named exceptions, each with the reason it is not a spoken or uploaded reply (and is already structured by other means):
const EXCEPT = [
  { file: 'auth.ts', has: /^const [A-Z_]*REFUSAL =|^\s*"(Recording|Managing|Checking|Recording stock)[^"]* available for your role/, why: 'the four creation-refusal sentences are DEFINED here; refusalFromCreationMessage() turns each into its structured twin (checked below)' },
  { file: 'auth.ts', has: /error: "not available for your role"/, why: 'an HTTP 403 on a route: structured by its status, and not a message in a reply envelope' },
  { file: 'mcp.ts', has: /restricted for this member's role/, why: 'the MCP endpoint answers in its own protocol, not the reply envelope' },
];
function walk(dir, out) { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p, out); else if (e.name.endsWith('.ts')) out.push(p); } return out; }
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, '')).split('\n').map((l) => l.replace(/^\s*\/\/.*$/, ''));

module.exports = async function runRefusalCoverageTests({ check, srcDir }) {
  const problems = [];
  let found = 0;
  for (const file of walk(srcDir, [])) {
    const lines = code(fs.readFileSync(file, 'utf8')), base = path.basename(file);
    lines.forEach((line, i) => {
      if (!PHRASE.test(line)) return;
      found++;
      if (EXCEPT.some((x) => x.file === base && x.has.test(line.trim()))) return;
      const loose = /^\s*(message = |[?:] )["`]/.test(line), reach = loose ? 4 : 0;
      const around = lines.slice(Math.max(0, i - reach), i + reach + 1).join('\n');
      if (!NEAR.test(around)) problems.push(`${path.relative(srcDir, file)}:${i + 1}`);
    });
  }
  check(found >= 20, `the scan found the refusal wording it is meant to guard (${found} lines)`);
  check(problems.length === 0, `every refusal sentence is beside a structured refusal (unstructured: ${problems.join(', ') || 'none'})`);
  // the four creation-refusal sentences each map to their own topic, and the default is money
  const auth = fs.readFileSync(path.join(srcDir, 'auth.ts'), 'utf8');
  const fn = (auth.match(/export function refusalFromCreationMessage[\s\S]*?\n\}/) || [''])[0];
  for (const [c, topic] of [['LEADS_REFUSAL', 'leads'], ['STATEMENT_REFUSAL', 'statements'], ['STOCK_REFUSAL', 'stock']]) check(fn.includes(c) && fn.includes(`"${topic}"`), `${c} maps to the "${topic}" topic`);
  check(fn.includes('"money"') && /const MONEY_REFUSAL =/.test(auth), 'any other creation refusal is "money"');
  const sentences = [...auth.matchAll(/^const ([A-Z_]*REFUSAL) =/gm)].map((m) => m[1]);
  check(sentences.length === 4 && sentences.every((s) => s === 'MONEY_REFUSAL' || fn.includes(s)), `every creation-refusal sentence is accounted for (${sentences.join(', ')})`);
};
