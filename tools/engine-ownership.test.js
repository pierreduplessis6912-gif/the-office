// Engine OWNERSHIP BOUNDARY, Task 3 (branch engine-phase1). A STATIC test: it reads the source (with TypeScript's own parser, so comments never count) and pins who may touch what.
// WHAT THIS PROVES: an ARCHITECTURAL boundary in the source as it stands. WHAT IT DOES NOT PROVE: runtime isolation (tools/engine-isolation.test.js is the executable proof), and it CANNOT see SQL built at run time, access reached
// indirectly through a function the engine calls (the two legacy modules it may import are pinned by name below, but their own behaviour is not analysed here), or what backup, restore and migration do, which treat every table generically
// and name none. Static inspection is a tripwire for coupling, not a security boundary.
// THE RULES, each independent and each with an allowlist that is INTENTIONAL: a new engine dependency or a new legacy-to-engine coupling FAILS here until a person adds it, with a reason, in this file.
//   R1  engine SQL names only engine tables (the 13 migration 0004 creates) plus ONE infrastructure table, captures, in named files; never a legacy domain table.
//   R2  engine code references only the environment fields it needs, per file; no shared binding (SHARED_DB, the notes, vault, memory index, backups, AI, the object namespace, ...).
//   R3  engine code imports from outside its folder only ../types, ../atomic and ../capability-contract, and from those only the names pinned here; no package, no other module.
//   R4  outside the engine, only capability-contract.ts names an eng_ table (the operation.executed event); the generated schema steps are the other, excluded as generated.
//   R5  every legacy file that imports the engine, and exactly what it imports, is pinned (the integration points).
//   R6  who WRITES each engine table is pinned: fact tables are INSERT-ONLY everywhere in the source (no UPDATE, no DELETE), written only by engine/facts.ts, plus the ONE operation.executed insert in capability-contract.ts.
// The tests that prove these checks can fail are in tools/engine-breakage.js (add a shared binding, a legacy table, a stray write, an unpinned import: each must fail the rule that owns it).
const fs = require('fs'), path = require('path');
const kit = require('./engine-kit.js');
const ts = require(require.resolve('typescript', { paths: [kit.workerDir, path.join(kit.workerDir, 'node_modules')] }));

module.exports = kit.guard('engine ownership', async ({ check }) => {
  const SRC = path.join(kit.workerDir, 'src');
  const listTs = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? listTs(path.join(dir, e.name)) : e.name.endsWith('.ts') ? [path.join(dir, e.name)] : []));
  const rel = (p) => path.relative(SRC, p).split(path.sep).join('/');
  const GENERATED = new Set(['schema-steps.ts', 'baseline-sql.ts']);   // built from the migration files, not written by hand
  const facts = {};   // file -> { strings, identifiers, imports: { module: [names] } }
  for (const file of listTs(SRC)) {
    const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const f = { strings: [], identifiers: new Set(), imports: {}, dynamic: 0 };
    const visit = (n) => {
      if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) f.strings.push(n.text);
      if (ts.isRegularExpressionLiteral(n)) f.strings.push(n.text);   // a regex that names an eng_ table is a coupling as much as a string is
      if (ts.isIdentifier(n)) f.identifiers.add(n.text);
      if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
        const mod = n.moduleSpecifier.text, names = (f.imports[mod] = f.imports[mod] || []);
        const clause = ts.isImportDeclaration(n) ? n.importClause : n.exportClause;
        if (!clause) names.push('(side effect)');
        else {
          if (clause.name) names.push('default');
          const bindings = clause.namedBindings || (ts.isNamedExports && ts.isNamedExports(clause) ? clause : null);
          if (bindings && ts.isNamespaceImport(bindings)) names.push('*');
          else if (bindings && bindings.elements) for (const el of bindings.elements) names.push((el.propertyName || el.name).text);
        }
      }
      if (ts.isCallExpression(n) && ((n.expression.kind === ts.SyntaxKind.ImportKeyword) || (ts.isIdentifier(n.expression) && n.expression.text === 'require'))) f.dynamic++;
      ts.forEachChild(n, visit);
    };
    visit(sf);
    facts[rel(file)] = f;
  }
  const engineFiles = Object.keys(facts).filter((k) => k.startsWith('engine/'));
  const nonEngine = Object.keys(facts).filter((k) => !k.startsWith('engine/') && !GENERATED.has(k));
  const mig = fs.readFileSync(path.join(kit.workerDir, 'migrations', '0004_engine_foundation.sql'), 'utf8');
  const ENGINE_TABLES = new Set([...mig.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?(eng_[a-z_]+)/g)].map((m) => m[1]));
  check(engineFiles.length >= 14 && ENGINE_TABLES.size === 13, `FIXTURE: ${engineFiles.length} engine files scanned, ${nonEngine.length} other source files, migration 0004 creates ${ENGINE_TABLES.size} tables`);
  const FACT = new Set(['eng_event', 'eng_party', 'eng_party_role', 'eng_document', 'eng_document_line', 'eng_document_number', 'eng_money_movement', 'eng_allocation', 'eng_reversal', 'eng_interpretation']);
  const MUTABLE = new Set(['eng_config', 'eng_draft', 'eng_observation']);
  check([...FACT, ...MUTABLE].length === 13 && [...FACT, ...MUTABLE].every((t) => ENGINE_TABLES.has(t)), 'FIXTURE: the ten fact tables and three mutable tables named here are exactly the thirteen the migration creates');
  const canon = (o) => JSON.stringify(o, (_k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v));
  const sqlTables = (strings) => { const out = new Set(); for (const s of strings) for (const m of s.matchAll(/\b(?:FROM|JOIN|INTO|UPDATE|REFERENCES)\s+([a-z_][a-z0-9_]*)/g)) out.add(m[1]); return out; };

  // ---- R1: engine SQL names only engine tables, plus captures in named files ------------------------------------------------------------------------------------------------------------------------------------------
  const INFRA = { captures: ['engine/admin.ts', 'engine/availability.ts'] };   // the engine records the capture of a request and links an observation to it; only these may name it
  const r1bad = [];
  for (const file of engineFiles) for (const t of sqlTables(facts[file].strings)) { if (ENGINE_TABLES.has(t)) continue; if (INFRA[t] && INFRA[t].includes(file)) continue; if (['json_each', 'json_extract'].includes(t)) continue; r1bad.push(`${file}: ${t}`); }
  const r1stale = Object.entries(INFRA).flatMap(([t, fs_]) => fs_.filter((file) => !sqlTables(facts[file] ? facts[file].strings : []).has(t)).map((file) => `${file} no longer names ${t}`));
  check(r1stale.length === 0, `R1: every allowance is still needed (an allowlist entry that no file uses would silently widen the rule)${r1stale.length ? ' [STALE: ' + r1stale.join('; ') + ']' : ''}`);
  check(r1bad.length === 0, `R1: engine SQL names only engine tables, plus captures where allowed; never a legacy domain table${r1bad.length ? ' [VIOLATIONS: ' + r1bad.join('; ') + ']' : ''}`);

  // ---- R2: environment fields, per file -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const typesSf = ts.createSourceFile('types.ts', fs.readFileSync(path.join(SRC, 'types.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
  let ENV_FIELDS = []; typesSf.forEachChild((n) => { if (ts.isInterfaceDeclaration(n) && n.name.text === 'Env') ENV_FIELDS = n.members.map((m) => m.name && m.name.text).filter(Boolean); });
  const ENV_SEEN = [...ENV_FIELDS, 'CAPABILITY_CONFIG'];   // CAPABILITY_CONFIG is read through a cast type in availability.ts, not declared in Env
  // __atomic is the transaction helper's boolean re-entry flag (atomic.ts: a wrapped function re-enters itself inside a transaction and checks it); it carries no data and is no binding. Inside that transaction atomic.ts also THROWS if code touches
  // AI, MEMORY, CUSTOMER_NOTES, OFFICE_VAULT, BACKUPS or SHARED_DB (atomic.ts:14), a runtime reinforcement of this rule for every engine write that runs atomically.
  const R2_ALLOWED = { 'engine/admin.ts': ['OFFICE_DB', 'BUSINESS_ID', 'ENGINE_REHEARSAL'], 'engine/availability.ts': ['BUSINESS_ID', 'CAPABILITY_CONFIG'], 'engine/facts.ts': ['__atomic'], 'engine/drafts.ts': ['__atomic'] };   // everything else: OFFICE_DB only (the business's OWN database)
  const r2bad = [];
  for (const file of engineFiles) {
    const used = ENV_SEEN.filter((n) => facts[file].identifiers.has(n)), allowed = new Set(['OFFICE_DB', ...(R2_ALLOWED[file] || [])]);
    for (const n of used) if (!allowed.has(n)) r2bad.push(`${file}: ${n}`);
  }
  check(ENV_FIELDS.length >= 40 && ENV_FIELDS.includes('SHARED_DB') && r2bad.length === 0, `R2: no engine file references any environment field outside its allowance (${ENV_FIELDS.length} fields exist, including SHARED_DB, the notes, vault, memory index, backups, AI and the object namespace)${r2bad.length ? ' [VIOLATIONS: ' + r2bad.join('; ') + ']' : ''}`);

  // ---- R3: imports leaving the engine ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const R3_ALLOWED = { '../types': null, '../atomic': null, '../capability-contract': null };   // null = names are pinned below
  const r3bad = [], outside = {};
  for (const file of engineFiles) {
    if (facts[file].dynamic) r3bad.push(`${file}: dynamic import or require`);
    for (const [mod, names] of Object.entries(facts[file].imports)) {
      if (mod.startsWith('./')) continue;
      if (!(mod in R3_ALLOWED)) { r3bad.push(`${file}: ${mod}`); continue; }
      (outside[mod] = outside[mod] || new Set()); for (const n of names) outside[mod].add(n);
    }
  }
  check(r3bad.length === 0, `R3: engine files import from outside the engine only ../types, ../atomic and ../capability-contract, never a package or any other module${r3bad.length ? ' [VIOLATIONS: ' + r3bad.join('; ') + ']' : ''}`);
  const PINNED_OUT = { '../atomic': ['atomically'], '../capability-contract': ['CapabilityContract', 'CapabilityRequest', 'CapabilityResult', 'ConfirmedAction'], '../types': ['Env'] };
  const got = Object.fromEntries(Object.entries(outside).map(([m, s]) => [m, [...s].sort()]));
  check(JSON.stringify(Object.keys(got).sort()) === JSON.stringify(Object.keys(PINNED_OUT).sort()), `R3: the legacy modules the engine depends on are exactly ${Object.keys(PINNED_OUT).join(', ')} [seen: ${JSON.stringify(got)}]`);

  // ---- R4: outside the engine, only capability-contract.ts names an eng_ table ----------------------------------------------------------------------------------------------------------------------------------------
  const r4 = {}; for (const file of nonEngine) { const n = facts[file].strings.filter((s) => /\beng_[a-z_]+/.test(s)).length; if (n) r4[file] = n; }
  check(JSON.stringify(r4) === JSON.stringify({ 'capability-contract.ts': 2 }), `R4: outside the engine folder only capability-contract.ts names an eng_ table, twice (the operation.executed insert and the matching UNIQUE-violation message); no backup, auth, finance or route file does [seen: ${JSON.stringify(r4)}]`);

  // ---- R5: the integration points, pinned ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const R5 = { 'mcp.ts': { './engine/boundary': ['isEngineMode'] }, 'index.ts': { './engine/boundary': ['actionModeRefusal', 'engineModeGate'], './engine/routes': ['handleEngineRoute'] }, 'debug.ts': { './engine/admin': ['engineAdminRoute'] }, 'capability-contract.ts': { './engine/errors': ['EngineError', 'EngineErrorCode'], './engine/permissions': ['EnginePermission', 'permissionsFor'], './engine/availability': ['observe', 'withEngineAvailability'], './engine/capabilities': ['ENGINE_CONTRACTS'] } };
  const r5 = {}; for (const file of nonEngine) { const m = {}; for (const [mod, names] of Object.entries(facts[file].imports)) if (/^\.\/engine(\/|$)/.test(mod)) m[mod] = [...new Set(names)].sort(); if (Object.keys(m).length) r5[file] = m; if (facts[file].dynamic && /engine/.test(JSON.stringify(facts[file].strings))) r5[file + ' (dynamic)'] = 1; }
  const want = Object.fromEntries(Object.entries(R5).map(([f, m]) => [f, Object.fromEntries(Object.entries(m).map(([k, v]) => [k, [...v].sort()]))]));
  check(canon(r5) === canon(want), `R5: exactly four legacy files import the engine, and exactly these names: a new coupling fails until reviewed [seen: ${JSON.stringify(r5).slice(0, 400)}]`);

  // ---- R6: who writes each engine table ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const writers = {};
  for (const file of Object.keys(facts).filter((k) => !GENERATED.has(k))) for (const s of facts[file].strings) for (const m of s.matchAll(/\b(INSERT(?: OR [A-Z]+)? INTO|UPDATE|DELETE FROM)\s+(eng_[a-z_]+)/g)) { const verb = m[1].startsWith('INSERT') ? 'INSERT' : m[1] === 'UPDATE' ? 'UPDATE' : 'DELETE'; (writers[m[2]] = writers[m[2]] || new Set()).add(`${file} ${verb}`); }
  const W = Object.fromEntries(Object.entries(writers).map(([t, s]) => [t, [...s].sort()]));
  const EXPECT = {
    eng_event: ['capability-contract.ts INSERT', 'engine/facts.ts INSERT'],   // facts.ts for every fact; capability-contract.ts for the single operation.executed record
    eng_party: ['engine/facts.ts INSERT'], eng_party_role: ['engine/facts.ts INSERT'], eng_document: ['engine/facts.ts INSERT'], eng_document_line: ['engine/facts.ts INSERT'], eng_document_number: ['engine/facts.ts INSERT'],
    eng_money_movement: ['engine/facts.ts INSERT'], eng_allocation: ['engine/facts.ts INSERT'], eng_reversal: ['engine/facts.ts INSERT'], eng_interpretation: ['engine/facts.ts INSERT'],
    eng_config: ['engine/admin.ts INSERT', 'engine/boundary.ts DELETE', 'engine/boundary.ts INSERT'], eng_draft: ['engine/drafts.ts INSERT', 'engine/drafts.ts UPDATE'], eng_observation: ['engine/admin.ts INSERT', 'engine/availability.ts INSERT'],
  };
  const factVerbs = Object.entries(W).filter(([t]) => FACT.has(t)).flatMap(([t, v]) => v.filter((x) => !x.endsWith(' INSERT')).map((x) => `${t}: ${x}`));
  check(factVerbs.length === 0, `R6: the ten FACT tables are INSERT-ONLY everywhere in the source: there is no UPDATE and no DELETE of any of them${factVerbs.length ? ' [VIOLATIONS: ' + factVerbs.join('; ') + ']' : ''}`);
  const factWriters = Object.entries(W).filter(([t]) => FACT.has(t)).flatMap(([t, v]) => v.map((x) => `${t}: ${x}`)).filter((x) => !x.includes('engine/facts.ts') && !x.startsWith('eng_event: capability-contract.ts'));
  check(factWriters.length === 0, `R6: fact rows are written only by engine/facts.ts, with the one exception of capability-contract.ts recording operation.executed in eng_event${factWriters.length ? ' [VIOLATIONS: ' + factWriters.join('; ') + ']' : ''}`);
  check(JSON.stringify(W.eng_interpretation) === JSON.stringify(['engine/facts.ts INSERT']), 'R6: eng_interpretation has exactly one writer, engine/facts.ts, and it only inserts (the door records what was understood from a capture)');
  check(canon(W) === canon(Object.fromEntries(Object.entries(EXPECT).map(([t, v]) => [t, [...v].sort()]))), `R6: the full map of who writes which engine table is exactly the pinned one, so a new writer anywhere fails until reviewed [seen: ${canon(W).slice(0, 700)}]`);
});

if (require.main === module) kit.standalone(module.exports);
