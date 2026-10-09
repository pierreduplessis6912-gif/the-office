// Tests for the processOneExtraction rewrite scaffold (Phase 1). Run from role-matrix.test.js, which is the
// one test step CI executes, so these need no pipeline change. Everything here is about the CONTRACT:
// the adapters, the invariants the real function obeys, and guards that stop the scaffold drifting from it.
module.exports = async function runIntentTests({ check, bundleTo, srcDir, fs, path, indexSrc, sameJson }) {
  const result = bundleTo('intents/result.ts', 'rm-intent-result.js');
  const dispatcher = bundleTo('intents/dispatcher.ts', 'rm-intent-dispatcher.js');
  const { toProcessingResult, toLegacyResult, legacyResultIssues, MalformedLegacyResult } = result;
  const { adaptLegacyProcessor, INTENT_GROUP, handlerGroupFor } = dispatcher;

  // ---- 1. The adapter is lossless over every well-formed legacy result ------------------------------
  const customers = [null, { id: 1, name: 'Jenny', matched: true }, { id: 2, name: 'New Person', matched: false }];
  const characters = [null, { id: 9, name: 'Floornet', matched: true }];
  const helds = [
    { id: null, type: null, cand: null, chg: null },
    { id: 5, type: 'payment', cand: null, chg: null },
    { id: 6, type: 'identity_collision', cand: null, chg: null },
    { id: 7, type: 'ambiguous_person', cand: [{ id: 1, name: 'A' }, { id: 2, name: 'B' }], chg: null },
    { id: 8, type: 'job_scope_amendment', cand: null, chg: [{ field: 'installer_id', label: 'Installer', displayValue: 'Sepo' }, { field: 'scheduled_date_raw', label: 'Date', displayValue: 'next Monday' }] },
    { id: 9, type: 'ambiguous_person', cand: [], chg: null },
  ];
  const facts = [null, 12];
  const scopes = [null, 3];
  const messages = ['', 'Got it.', 'two\nlines, R5000 \u2014 \u201cquoted\u201d'];
  let cases = 0, roundTripOk = 0, newSideOk = 0;
  for (const customer of customers) for (const character of characters) for (const h of helds) for (const fact of facts) for (const scope of scopes) for (const message of messages) {
    const legacy = { customer, character, pendingActionId: h.id, factPendingActionId: fact, message, jobScopeIdForProjectResolution: scope, pendingCandidates: h.cand, pendingActionType: h.type, pendingChanges: h.chg };
    const before = JSON.stringify(legacy);
    cases++;
    if (legacyResultIssues(legacy).length !== 0) continue;
    const forward = toProcessingResult(legacy);
    if (sameJson(toLegacyResult(forward), legacy) && JSON.stringify(legacy) === before) roundTripOk++;
    // and the other way: a new-style result survives the trip to the old shape and back
    if (sameJson(toProcessingResult(toLegacyResult(forward)), forward)) newSideOk++;
  }
  check(cases === 432 && roundTripOk === 432 && newSideOk === 432, `legacy -> new -> legacy must be the identity for every well-formed result, and new -> legacy -> new too (432 cases; got ${roundTripOk} and ${newSideOk} of ${cases})`);
  // The optional second hold (an invoice held, then an amendment asked) survives the trip in both directions, and a result
  // without it round-trips to a result without the key at all (not an empty list), so existing results are untouched.
  const alsoLegacy = { customer: null, character: null, pendingActionId: 2, factPendingActionId: null, message: 'm', jobScopeIdForProjectResolution: null, pendingCandidates: null, pendingActionType: 'job_scope_amendment', pendingChanges: [{ field: 'f', label: 'F', displayValue: 'x' }], alsoPending: [{ id: 1, type: 'invoice' }] };
  const alsoNew = toProcessingResult(alsoLegacy);
  check(sameJson(alsoNew.alsoHeld, [{ id: 1, type: 'invoice' }]) && sameJson(toLegacyResult(alsoNew), alsoLegacy), 'a result that carries a second waiting action keeps it through the adapters, both ways');
  check(!('alsoPending' in toLegacyResult(toProcessingResult({ ...alsoLegacy, alsoPending: undefined }))) && toProcessingResult({ ...alsoLegacy, alsoPending: undefined }).alsoHeld.length === 0, 'a result without a second waiting action round-trips without the key, not with an empty list');
  const mapped = toProcessingResult({ customer: null, character: null, pendingActionId: 8, factPendingActionId: 12, message: 'm', jobScopeIdForProjectResolution: 3, pendingCandidates: null, pendingActionType: 'job_scope_amendment', pendingChanges: [{ field: 'f', label: 'F', displayValue: 'x' }] });
  check(mapped.held.id === 8 && mapped.held.type === 'job_scope_amendment' && mapped.held.changes.length === 1 && mapped.factHeldId === 12 && sameJson(mapped.recorded, [{ kind: 'job_scope', id: 3 }]), 'the new shape carries the held action, the fact hold and the recorded job scope separately');
  const none = toProcessingResult({ customer: null, character: null, pendingActionId: null, factPendingActionId: null, message: 'x', jobScopeIdForProjectResolution: null, pendingCandidates: null, pendingActionType: null, pendingChanges: null });
  check(none.held === null && none.recorded.length === 0 && none.factHeldId === null, 'a result with nothing held and nothing recorded maps to nothing held and nothing recorded');
  check(sameJson(toLegacyResult({ customer: null, character: null, held: null, factHeldId: null, recorded: [], alsoHeld: [], message: 'x' }).pendingActionId, null) && toLegacyResult({ customer: null, character: null, held: null, factHeldId: null, recorded: [], alsoHeld: [], message: 'x' }).pendingCandidates === null, 'a new-style result with nothing held maps to all-null pending fields');

  // ---- 2. Anything outside the real function's rules is refused loudly -----------------------------
  const base = { customer: null, character: null, pendingActionId: null, factPendingActionId: null, message: '', jobScopeIdForProjectResolution: null, pendingCandidates: null, pendingActionType: null, pendingChanges: null };
  const malformed = [
    ['an action id with no type', { ...base, pendingActionId: 5 }],
    ['a type with no action id', { ...base, pendingActionType: 'payment' }],
    ['candidates with no action id', { ...base, pendingCandidates: [{ id: 1, name: 'A' }] }],
    ['changes with no action id', { ...base, pendingChanges: [{ field: 'f', label: 'F', displayValue: 'x' }] }],
    ['candidates on a hold that is not ambiguous_person', { ...base, pendingActionId: 5, pendingActionType: 'payment', pendingCandidates: [{ id: 1, name: 'A' }] }],
    ['changes on a hold that is not job_scope_amendment', { ...base, pendingActionId: 5, pendingActionType: 'payment', pendingChanges: [{ field: 'f', label: 'F', displayValue: 'x' }] }],
  ];
  for (const [name, bad] of malformed) {
    let threw = null;
    try { toProcessingResult(bad); } catch (e) { threw = e; }
    check(threw && threw.name === 'MalformedLegacyResult' && Array.isArray(threw.issues) && threw.issues.length >= 1 && legacyResultIssues(bad).length >= 1, `a legacy result with ${name} must be refused, not quietly converted`);
  }
  check(legacyResultIssues({ ...base, pendingActionId: 5, pendingActionType: 'payment' }).length === 0 && legacyResultIssues({ ...base, pendingActionId: 7, pendingActionType: 'ambiguous_person', pendingCandidates: [] }).length === 0, 'a well-formed result has no issues, including an empty candidate list on an ambiguous_person hold');
  check(legacyResultIssues({ ...base, pendingActionId: 5, pendingCandidates: [{ id: 1, name: 'A' }], pendingChanges: [{ field: 'f', label: 'F', displayValue: 'x' }] }).length >= 3, 'every broken rule is reported, not just the first');

  // ---- 3. The rules the adapter relies on really are obeyed at every return site of the real function ---
  const fnStart = indexSrc.indexOf('async function processOneExtraction(');
  const lines = indexSrc.slice(fnStart).split('\n');
  const sites = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^\s+return \{\s*$/.test(lines[i])) {
      const ind = lines[i].length - lines[i].trimStart().length;
      let j = i; while (j < lines.length && !(lines[j].length - lines[j].trimStart().length === ind && lines[j].trim().startsWith('};'))) j++;
      const block = lines.slice(i, j + 1);
      const val = (k) => { for (const l of block) { const m = l.match(new RegExp('^\\s+' + k + '(?::\\s*(.*?))?,?\\s*$')); if (m) return (m[1] || k).replace(/,$/, ''); } return '?'; };
      sites.push({ id: val('pendingActionId'), type: val('pendingActionType'), cand: val('pendingCandidates'), chg: val('pendingChanges'), fact: val('factPendingActionId'), js: val('jobScopeIdForProjectResolution') });
    }
    if (/^}\s*$/.test(lines[i]) && i > 5) break;   // end of the function
  }
  check(sites.length === 10, `processOneExtraction has 10 multi-line return sites (9 early, 1 final); it now has ${sites.length}, so the adapter's rules must be re-checked against the new site before this number is changed`);
  sites.forEach((s, n) => {
    const where = `return site ${n + 1} of ${sites.length}`;
    if (s.id === 'null') check(s.type === 'null' && s.cand === 'null' && s.chg === 'null', `${where}: with no action id, the type, candidates and changes must all be null`);
    else check(s.type !== 'null' && s.type !== '?', `${where}: an action id must always come with its type`);
    if (s.cand !== 'null') check(s.type === '"ambiguous_person"', `${where}: candidates only ever accompany an ambiguous_person hold`);
    if (s.chg !== 'null') check(s.type === '"job_scope_amendment"', `${where}: changes only ever accompany a job_scope_amendment hold`);
    if (n < sites.length - 1) check(s.fact === 'null' && s.js === 'null', `${where}: only the final return carries a fact hold or a recorded job scope`);
  });
  const fnBody = indexSrc.slice(fnStart, fnStart + lines.slice(0, lines.findIndex((l, i) => /^}\s*$/.test(l) && i > 5)).join('\n').length);
  // Every object-literal return in the function is a result site (no inner closure returns one), so counting
  // them in ANY formatting catches a new site written on one line, which the multi-line parse above cannot see.
  const anyReturns = (fnBody.match(/\breturn\s*\{/g) || []).length;
  check(anyReturns === 10 && anyReturns === sites.length, `every object-literal return in processOneExtraction must be a result site the adapter's rules were checked against (found ${anyReturns} in any formatting, ${sites.length} multi-line)`);
  const idWrites = (fnBody.match(/^\s+pendingActionId = /gm) || []).length, typeWrites = (fnBody.match(/^\s+pendingActionType = /gm) || []).length;
  check(idWrites > 0 && idWrites === typeWrites, `every assignment of pendingActionId must be paired with one of pendingActionType (found ${idWrites} and ${typeWrites}), which is what lets the final return be well-formed`);

  // ---- 4. The scaffold cannot drift from the live function -----------------------------------------
  const sig = indexSrc.slice(fnStart, indexSrc.indexOf('): Promise<{', fnStart));
  const liveParams = [...sig.matchAll(/^\s+(\w+)\??:/gm)].map((m) => m[1]);
  const dispSrc = fs.readFileSync(path.join(srcDir, 'intents', 'dispatcher.ts'), 'utf8');
  const legacyType = dispSrc.slice(dispSrc.indexOf('export type LegacyProcessor = ('), dispSrc.indexOf('=> Promise<LegacyProcessResult>;'));
  const adapterParams = [...legacyType.matchAll(/^\s+(\w+)\??:/gm)].map((m) => m[1]);
  check(liveParams.length === 8 && sameJson(liveParams, adapterParams), `the adapter's parameter list must match processOneExtraction's, in order (live: ${liveParams.join(',')}; adapter: ${adapterParams.join(',')})`);
  // Semicolons inside an inline object type ({ id: number; name: string }) are not field separators.
  const flatten = (s) => { let depth = 0; let out = ''; for (const c of s) { if (c === '{') depth++; if (c === '}') depth--; out += c === ';' && depth > 0 ? ',' : c; } return out; };
  const retStart = indexSrc.indexOf('): Promise<{', fnStart) + '): Promise<{'.length;
  const retBody = flatten(indexSrc.slice(retStart, indexSrc.indexOf('}> {', retStart)).split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n'));
  const liveFields = [...retBody.matchAll(/^\s+(\w+)(\??):\s*([^;]*);/gm)].map((m) => [m[1] + m[2], /\|\s*null\s*$/.test(m[3].trim())]);
  const resSrc = fs.readFileSync(path.join(srcDir, 'intents', 'result.ts'), 'utf8');
  const blockBody = (src, marker) => { const open = src.indexOf(marker) + marker.length; let depth = 1, i = open; while (depth > 0 && i < src.length) { if (src[i] === '{') depth++; if (src[i] === '}') depth--; i++; } return src.slice(open, i - 1); };
  const legBlock = blockBody(resSrc, 'export interface LegacyProcessResult {');
  const legFields = [...flatten(legBlock).matchAll(/^\s+(\w+)(\??):\s*([^;]*);/gm)].map((m) => [m[1] + m[2], /\|\s*null\s*$/.test(m[3].trim())]);
  check(liveFields.length === 10 && sameJson(liveFields, legFields), `LegacyProcessResult must have exactly processOneExtraction's return fields, in order, with the same nullability (live ${liveFields.map((f) => f[0]).join(',')}; scaffold ${legFields.map((f) => f[0]).join(',')})`);

  // The NESTED shapes, not just the field names (the first scaffold copied a wrong declaration for pendingChanges and
  // this guard could not tell, because it only compared top-level names). Compared three ways: the scaffold, the
  // function's declared return type, and the code that actually builds the value.
  const nested = (src, after, open) => { const a = src.indexOf(after); const b = src.indexOf(open, a) + open.length; let depth = 1, i = b; while (depth > 0 && i < src.length) { if (src[i] === '{') depth++; if (src[i] === '}') depth--; i++; } return [...src.slice(b, i - 1).matchAll(/(\w+):\s*([^;,}]+)/g)].map((m) => `${m[1]}:${m[2].trim()}`).join(','); };
  const scaffoldChange = nested(resSrc, 'export interface PendingChange {', '{');
  const declaredChange = (retBody.match(/pendingChanges:\s*Array<\{([^}]*)\}>/) || [])[1];
  const producedChange = (fs.readFileSync(path.join(srcDir, 'finance.ts'), 'utf8').match(/changes:\s*Array<\{([^}]*)\}>/) || [])[1];
  const norm = (x) => (x || '').split(/[;,]/).map((y) => y.replace(/\s+/g, '')).filter(Boolean).join(',');
  check(norm(declaredChange) === norm(producedChange) && scaffoldChange === norm(producedChange), `pendingChanges must have the same shape in the scaffold (${scaffoldChange}), in processOneExtraction's declared return type (${norm(declaredChange)}) and in the code that builds it (${norm(producedChange)})`);
  const candidates = (resSrc.match(/export interface PendingCandidate \{([^}]*)\}/) || [])[1];
  check(norm(candidates).replace(/\s/g, '') === 'id:number,name:string' && /pendingCandidates: Array<\{ id: number; name: string \}> \| null;/.test(indexSrc), 'pendingCandidates must be { id, name } in both the scaffold and the function');

  // ---- 5. The adapter calls the live function correctly and does not hide its failures --------------
  let seen = null;
  const input = { env: { tag: 'env' }, transcript: 'T', extraction: { intent: 'payment' }, history: [{ role: 'user' }], ctx: { tag: 'ctx' }, captureId: 77, capabilities: ['can_manage_invoices'], recordingUserEmail: 'p@x.com' };
  const okLegacy = async (...args) => { seen = args; return { ...base, message: 'done', pendingActionId: 5, pendingActionType: 'payment' }; };
  const out = await adaptLegacyProcessor(okLegacy)(input);
  check(seen && seen.length === 8 && seen[0] === input.env && seen[1] === 'T' && seen[2] === input.extraction && seen[3] === input.history && seen[4] === input.ctx && seen[5] === 77 && seen[6] === input.capabilities && seen[7] === 'p@x.com', 'the adapter passes every input to the live function in the live order');
  check(out.message === 'done' && out.held.id === 5 && out.held.type === 'payment', 'the adapter returns the new shape');
  let rejected = null; try { await adaptLegacyProcessor(async () => ({ ...base, pendingActionId: 5 }))(input); } catch (e) { rejected = e; }
  check(rejected && rejected.name === 'MalformedLegacyResult', 'a malformed result from the live function is an error, not a plausible answer');
  let propagated = null; try { await adaptLegacyProcessor(async () => { throw new Error('db down'); })(input); } catch (e) { propagated = e; }
  check(propagated && propagated.message === 'db down', "a failure inside the live function is passed on, never swallowed");

  // ---- 6. The planned grouping is exhaustive and says what the validation found ---------------------
  const typesSrc = fs.readFileSync(path.join(srcDir, 'types.ts'), 'utf8');
  const unionIntents = typesSrc.match(/intent:\s*((?:"[a-z_]+"\s*\|?\s*)+);/)[1].match(/"([a-z_]+)"/g).map((x) => x.replace(/"/g, ''));
  for (const i of unionIntents) check(Object.prototype.hasOwnProperty.call(INTENT_GROUP, i), `intent "${i}" must be placed in a handler group`);
  for (const i of Object.keys(INTENT_GROUP)) check(unionIntents.includes(i), `INTENT_GROUP has "${i}", which is not in the intent union`);
  const groups = new Set(Object.values(INTENT_GROUP));
  check(groups.size === 8, `every one of the 8 planned handler groups must be used (found ${groups.size})`);
  check(INTENT_GROUP.invoice === 'job_pricing' && INTENT_GROUP.price_scope === 'job_pricing' && INTENT_GROUP.work_observation === 'job_pricing', 'invoice, price_scope and work_observation share one group: they each carry their own copy of the same observation-recording logic');
  check(['register_stock_item', 'stock_usage', 'stocktake'].every((i) => INTENT_GROUP[i] === 'stock'), 'the stock intents have a home, which the original plan lacked');
  check(['raise_snag', 'resolve_snag', 'raise_lead', 'lose_lead'].every((i) => INTENT_GROUP[i] === 'snags_leads') && INTENT_GROUP.lookup === 'lookup', 'snags and leads cohere together; lookup is its own group');
  check(['payment', 'expense', 'supplier_payment'].every((i) => INTENT_GROUP[i] === 'payments') && ['purchase_order', 'goods_received', 'supplier_invoice', 'variance_disposition'].every((i) => INTENT_GROUP[i] === 'procurement'), 'payments and procurement are grouped as planned');
  check(handlerGroupFor('goods_received') === 'procurement' && handlerGroupFor('note') === 'notes', 'handlerGroupFor reads the table');

  // ---- 7. The scaffold is unreachable, and the build actually checks it -----------------------------
  const srcFiles = fs.readdirSync(srcDir).filter((f) => f.endsWith('.ts'));
  // Phase 3 has begun: the first REAL handler, supplier-document, is imported by index.ts. The rest of the scaffold (the result shape and the
  // dispatcher table) must still be unreachable from outside src/intents, and only index.ts may import the handler.
  const importsOf = (name) => srcFiles.filter((f) => new RegExp('from\\s+["\']\\./intents/' + name + '["\']').test(fs.readFileSync(path.join(srcDir, f), 'utf8')));
  check(importsOf('result').length === 0 && importsOf('dispatcher').length === 0, `nothing outside src/intents may import the unfinished scaffold (result: ${importsOf('result').join(', ') || 'none'}; dispatcher: ${importsOf('dispatcher').join(', ') || 'none'})`);
  check(sameJson(importsOf('snags-leads'), ['index.ts']), `only index.ts may import the snags-and-leads handler (imported by: ${importsOf('snags-leads').join(', ') || 'none'})`);
  check(sameJson(importsOf('stock'), ['index.ts']), `only index.ts may import the stock handler (imported by: ${importsOf('stock').join(', ') || 'none'})`);
  check(sameJson(importsOf('order-admin'), ['index.ts']), `only index.ts may import the order-admin handler (imported by: ${importsOf('order-admin').join(', ') || 'none'})`);
  check(sameJson(importsOf('upload-caption'), ['index.ts']), `only index.ts may import the upload-caption handler (imported by: ${importsOf('upload-caption').join(', ') || 'none'})`);
  check(sameJson(importsOf('supplier-document'), ['index.ts']), `only index.ts may import the supplier-document handler (imported by: ${importsOf('supplier-document').join(', ') || 'none'})`);
  const anyIntentsImport = srcFiles.filter((f) => /from\s+["']\.\/intents\//.test(fs.readFileSync(path.join(srcDir, f), 'utf8')));
  check(anyIntentsImport.every((f) => f === 'index.ts'), `only index.ts may import anything from src/intents (imported by: ${anyIntentsImport.join(', ') || 'none'})`);
  const tsconfig = fs.readFileSync(path.join(srcDir, '..', 'tsconfig.json'), 'utf8');
  check(/"include":\s*\[\s*"src\/\*\*\/\*\.ts"\s*\]/.test(tsconfig), 'tsconfig must include src/**/*.ts, or the typecheck silently skips everything in src/intents');
  check(!/Date\.now|Math\.random|fetch\(|env\.OFFICE_DB|env\.AI/.test(resSrc), 'the contract module is pure: no clock, randomness, network or database');
};
