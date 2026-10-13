// The per-business scoping of the shared notes store, file storage and memory index (worker/src/scoped-bindings.ts). Found 2026-10-12, before any real data moved: every business's object shares
// ONE of each, and the application keys them with per-business counters (`customer:1`), so two businesses' customer 1 would have collided and read each other's notes and memories.
const path = require('path'), fs = require('fs'), os = require('os'), esbuild = require('esbuild');

module.exports = async function runScopedBindingTests({ check, srcDir }) {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-')), 'm.js');
  esbuild.buildSync({ entryPoints: [path.join(srcDir, 'scoped-bindings.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent' });
  const sb = require(out);

  // ---- stand-ins for the three shared stores (they keep the physical keys, so the tests can see exactly what was stored) -------------------------------------
  const kvStore = new Map();
  const kv = { get: async (k) => kvStore.get(k) ?? null, getWithMetadata: async (k) => ({ value: kvStore.get(k) ?? null, metadata: null }), put: async (k, v) => { kvStore.set(k, v); }, delete: async (k) => { kvStore.delete(k); }, list: async ({ prefix = '' } = {}) => ({ keys: [...kvStore.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }), someOtherMethod: async () => 'unscoped' };
  const r2Store = new Map();
  const r2 = { get: async (k) => (r2Store.has(k) ? { key: k, body: r2Store.get(k) } : null), head: async (k) => (r2Store.has(k) ? { key: k } : null), put: async (k, v) => { r2Store.set(k, v); }, delete: async (k) => { for (const x of [].concat(k)) r2Store.delete(x); }, list: async ({ prefix = '' } = {}) => ({ objects: [...r2Store.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })), truncated: false }), createMultipartUpload: async () => 'unscoped' };
  const vecStore = [];
  const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
  const vec = {
    upsert: async (vs) => { for (const v of vs) { const i = vecStore.findIndex((x) => x.id === v.id); if (i >= 0) vecStore[i] = v; else vecStore.push(v); } return { count: vs.length }; },
    insert: async (vs) => { for (const v of vs) if (!vecStore.some((x) => x.id === v.id)) vecStore.push(v); return { count: vs.length }; },
    query: async (q, o = {}) => ({ matches: vecStore.filter((v) => (o.namespace === undefined || v.namespace === o.namespace) && (!o.filter || Object.entries(o.filter).every(([k, val]) => v.metadata?.[k] === val))).map((v) => ({ id: v.id, score: dot(q, v.values), metadata: v.metadata })).sort((a, b) => b.score - a.score).slice(0, o.topK ?? 5) }),
    getByIds: async (ids) => vecStore.filter((v) => ids.includes(v.id)), deleteByIds: async (ids) => { for (const id of ids) { const i = vecStore.findIndex((x) => x.id === id); if (i >= 0) vecStore.splice(i, 1); } return { count: ids.length }; },
    describe: async () => ({ unscoped: true }),
  };
  const env = { CUSTOMER_NOTES: kv, OFFICE_VAULT: r2, MEMORY: vec, ADMIN_KEY: 'k' };
  const A = sb.scopeBindings(env, 'alpha-co'), B = sb.scopeBindings(env, 'beta-co');

  // ---- the notes store ------------------------------------------------------------------------------------------------------------------------------------------
  await A.CUSTOMER_NOTES.put('customer:1', 'ALPHA notes'); await B.CUSTOMER_NOTES.put('customer:1', 'BETA notes');
  check((await A.CUSTOMER_NOTES.get('customer:1')) === 'ALPHA notes' && (await B.CUSTOMER_NOTES.get('customer:1')) === 'BETA notes', 'two businesses using the SAME key (customer:1) each read their own notes: they no longer collide');
  check([...kvStore.keys()].sort().join(',') === 'b:alpha-co:customer:1,b:beta-co:customer:1', 'physically the keys are separate, each under its own business');
  await A.CUSTOMER_NOTES.put('life:2026-10-12', 'a'); await A.CUSTOMER_NOTES.put('character:7', 'c');
  const listed = await A.CUSTOMER_NOTES.list({ prefix: 'customer:' });
  check(listed.keys.map((k) => k.name).join(',') === 'customer:1' && !JSON.stringify(listed).includes('beta'), 'listing shows only the business\'s own keys, with the business prefix removed');
  await A.CUSTOMER_NOTES.delete('customer:1');
  check((await A.CUSTOMER_NOTES.get('customer:1')) === null && (await B.CUSTOMER_NOTES.get('customer:1')) === 'BETA notes', 'deleting in one business never touches the other\'s');
  check((await A.CUSTOMER_NOTES.get('b:beta-co:customer:1')) === null, 'a business cannot reach the other\'s notes by writing the other\'s prefix into the key (the business\'s own prefix is always added)');
  check((await A.CUSTOMER_NOTES.getWithMetadata('character:7')).value === 'c', 'getWithMetadata is scoped too');
  let threw = ''; try { await A.CUSTOMER_NOTES.someOtherMethod(); } catch (e) { threw = String(e.message); }
  check(/not available to a business/.test(threw), 'a method that was never scoped is NOT offered: it fails loudly instead of quietly touching the shared store');

  // ---- the file storage -----------------------------------------------------------------------------------------------------------------------------------------
  await A.OFFICE_VAULT.put('logos/business-logo-1.png', 'ALPHA-LOGO'); await B.OFFICE_VAULT.put('logos/business-logo-1.png', 'BETA-LOGO');
  check((await A.OFFICE_VAULT.get('logos/business-logo-1.png')).body === 'ALPHA-LOGO' && (await B.OFFICE_VAULT.get('logos/business-logo-1.png')).body === 'BETA-LOGO' && [...r2Store.keys()].sort().join(',') === 'b/alpha-co/logos/business-logo-1.png,b/beta-co/logos/business-logo-1.png', 'files with the same name in two businesses are kept apart');
  await B.OFFICE_VAULT.put('voice-notes/1.m4a', 'beta-voice');
  check((await A.OFFICE_VAULT.get('voice-notes/1.m4a')) === null && (await A.OFFICE_VAULT.get('b/beta-co/voice-notes/1.m4a')) === null && (await A.OFFICE_VAULT.head('b/beta-co/voice-notes/1.m4a')) === null, 'a business asking for ANOTHER business\'s file (the file route reads whatever key it is given) gets nothing, even naming the other\'s physical key');
  const files = await A.OFFICE_VAULT.list({ prefix: 'voice-notes/' }); const filesB = await B.OFFICE_VAULT.list({ prefix: 'voice-notes/' });
  check(files.objects.length === 0 && filesB.objects.map((o) => o.key).join(',') === 'voice-notes/1.m4a', 'listing files shows only the business\'s own, without the prefix');
  await A.OFFICE_VAULT.delete('logos/business-logo-1.png');
  check((await A.OFFICE_VAULT.head('logos/business-logo-1.png')) === null && (await B.OFFICE_VAULT.head('logos/business-logo-1.png')) !== null, 'deleting a file in one business never touches the other\'s');
  threw = ''; try { await A.OFFICE_VAULT.createMultipartUpload('x'); } catch (e) { threw = String(e.message); }
  check(/not available to a business/.test(threw), 'an unscoped file-storage method is not offered either');

  // ---- the memory index -------------------------------------------------------------------------------------------------------------------------------------------
  await A.MEMORY.upsert([{ id: 'pmf-1-2026', values: [1, 0], metadata: { customerId: '1', text: 'ALPHA customer 1 memory' } }]);
  await B.MEMORY.upsert([{ id: 'pmf-1-2026', values: [1, 0], metadata: { customerId: '1', text: 'BETA customer 1 memory' } }]);
  check(vecStore.length === 2 && vecStore.every((v) => v.namespace && v.id.startsWith(sb.vectorPrefix(v.namespace))), 'the same vector id in two businesses no longer overwrites: each is stored in its own namespace with a prefixed id');
  const qa = await A.MEMORY.query([1, 0], { topK: 8, returnMetadata: true, filter: { customerId: '1' } });
  check(qa.matches.length === 1 && qa.matches[0].metadata.text === 'ALPHA customer 1 memory' && qa.matches[0].id === 'pmf-1-2026', 'a memory search for customer 1 returns ONLY that business\'s customer 1 (before: business B\'s memories too), and the ids come back as the application knows them');
  const qb = await B.MEMORY.query([1, 0], { topK: 8, namespace: 'alpha-co' });
  check(qb.matches.length === 1 && qb.matches[0].metadata.text === 'BETA customer 1 memory', 'a business asking for ANOTHER business\'s namespace is overwritten with its own: it cannot read across');
  const none = await A.MEMORY.query([1, 0], { topK: 8 });
  check(none.matches.length === 1 && !JSON.stringify(none).includes('BETA'), 'a search with no filter at all still sees only the business\'s own memories');
  await A.MEMORY.deleteByIds(['pmf-1-2026']);
  check((await B.MEMORY.getByIds(['pmf-1-2026']))[0].id === 'pmf-1-2026', 'reading a memory back by id returns the id the application knows, not the stored prefixed one (found on the real index: the migration read-back compares by id)');
  check(vecStore.length === 1 && vecStore[0].namespace === 'beta-co' && (await B.MEMORY.getByIds(['pmf-1-2026'])).length === 1, 'deleting a memory by id in one business never deletes the other\'s');
  threw = ''; try { await A.MEMORY.describe(); } catch (e) { threw = String(e.message); }
  check(/not available to a business/.test(threw), 'an unscoped memory-index method is not offered either');

  // ---- a memory's id may be at most 64 bytes, whatever the business is called ------------------------------------------------------------------------------------------
  const longName = 'a'.repeat(40), L = sb.scopeBindings(env, longName);
  check(sb.vectorPrefix('alpha-co').length === 9 && /^[0-9a-f]{8}~$/.test(sb.vectorPrefix('alpha-co')) && sb.vectorPrefix(longName).length === 9 && sb.vectorPrefix('alpha-co') === sb.vectorPrefix('alpha-co') && sb.vectorPrefix('alpha-co') !== sb.vectorPrefix('beta-co'), 'the prefix is SHORT and FIXED-SIZE (8 hex characters of a hash, then ~: 9 characters) however long the business\'s name is, deterministic, and different between businesses');
  const fifty = 'x'.repeat(55);   // 55 + 9 = 64, exactly the limit
  await L.MEMORY.upsert([{ id: fifty, values: [1, 0], metadata: {} }]);
  check(vecStore.some((v) => v.id === sb.vectorPrefix(longName) + fifty && Buffer.byteLength(v.id) === 64), 'a 55-byte id in a business with a 40-character name still fits: the stored id is exactly 64 bytes (the first real copy failed here: the business NAME was the prefix and one id came to 65)');
  let tooLong = ''; try { await L.MEMORY.upsert([{ id: 'y'.repeat(56), values: [1, 0], metadata: {} }]); } catch (e) { tooLong = String(e.message); }
  check(/at most 64 bytes/.test(tooLong) && /too long/.test(tooLong), 'an id that WOULD exceed 64 bytes is refused with a clear message (not Cloudflare\'s opaque one), naming the limit');
  check((await L.MEMORY.query([1, 0], { topK: 3 })).matches.every((m) => !m.id.includes('~')), 'and what comes back from a search never carries the prefix');
  let getLong = ''; try { await L.MEMORY.getByIds(['z'.repeat(60)]); } catch (e) { getLong = String(e.message); }
  check(/at most 64 bytes/.test(getLong), 'reading and deleting by id are bounded the same way');

  // ---- what is left alone ---------------------------------------------------------------------------------------------------------------------------------------
  const bare = sb.scopeBindings({ ADMIN_KEY: 'k' }, 'alpha-co');
  check(bare.CUSTOMER_NOTES === undefined && bare.OFFICE_VAULT === undefined && bare.MEMORY === undefined && bare.ADMIN_KEY === 'k' && A.ADMIN_KEY === 'k', 'a store that is not bound is left as it is, and every other binding passes through');

  // ---- every call the application makes is one the scoping covers ---------------------------------------------------------------------------------------
  const files2 = [...fs.readdirSync(srcDir).filter((f) => f.endsWith('.ts')).map((f) => path.join(srcDir, f)), ...fs.readdirSync(path.join(srcDir, 'intents')).map((f) => path.join(srcDir, 'intents', f))];
  const skip = new Set(['scoped-bindings.ts', 'timing.ts', 'types.ts', 'business-object.ts']);
  const used = { CUSTOMER_NOTES: new Set(), OFFICE_VAULT: new Set(), MEMORY: new Set() }; const bareUses = [];
  for (const f of files2) {
    if (skip.has(path.basename(f))) continue;
    const text = fs.readFileSync(f, 'utf8').replace(/^\s*\/\/.*$/gm, '');
    for (const name of Object.keys(used)) {
      // `if (env.X)` only asks whether a store is bound (it touches nothing), so it is not a use; any other use without a call is.
      const presenceChecks = (text.match(new RegExp(`if \\(env\\.${name}\\)`, 'g')) || []).length;
      let bare = 0;
      for (const m of text.matchAll(new RegExp(`env\\.${name}\\b(\\??\\.(\\w+)\\()?`, 'g'))) { if (m[2]) used[name].add(m[2]); else bare++; }
      if (bare > presenceChecks) bareUses.push(`${path.basename(f)}: env.${name} used without a method call`);
    }
  }
  // `describe` reports on the WHOLE shared index, so it is deliberately NOT offered to a business: it is used only by two platform health routes, which the Worker (not an object) answers.
  const routingSrc = fs.readFileSync(path.join(srcDir, 'routing.ts'), 'utf8');
  const platformOnly = { 'MEMORY.describe': ['/debug/memory-health', '/debug/stress-memory'] };
  const platformOk = Object.entries(platformOnly).every(([, paths]) => paths.every((p) => new RegExp(`WORKER_ADMIN = new Set\\([^)]*"${p}"`).test(routingSrc)));
  check(platformOk && !sb.SCOPED_VECTOR_METHODS.includes('describe'), 'the one call a business\'s view does not offer (describe, which reports on the whole shared index) is used only by two platform health routes that the Worker answers itself');
  const notCovered = [...used.CUSTOMER_NOTES].filter((m) => !sb.SCOPED_KV_METHODS.includes(m)).map((m) => 'CUSTOMER_NOTES.' + m).concat([...used.OFFICE_VAULT].filter((m) => !sb.SCOPED_R2_METHODS.includes(m)).map((m) => 'OFFICE_VAULT.' + m), [...used.MEMORY].filter((m) => !sb.SCOPED_VECTOR_METHODS.includes(m) && !(platformOnly['MEMORY.' + m] && platformOk)).map((m) => 'MEMORY.' + m));
  check(notCovered.length === 0 && bareUses.length === 0 && used.CUSTOMER_NOTES.size > 0 && used.OFFICE_VAULT.size > 0 && used.MEMORY.size > 0, `every call the application makes to the notes store, the file storage and the memory index is one the scoping covers (uncovered: ${notCovered.join(', ') || 'none'}; passed on without a call: ${bareUses.join(', ') || 'none'}; seen: KV ${[...used.CUSTOMER_NOTES].join('/')}, files ${[...used.OFFICE_VAULT].join('/')}, memory ${[...used.MEMORY].join('/')})`);
  const objSrc = fs.readFileSync(path.join(srcDir, 'business-object.ts'), 'utf8'), idxSrc = fs.readFileSync(path.join(srcDir, 'index.ts'), 'utf8');
  check(/scopeBindings\(\{ \.\.\.this\.env, OFFICE_DB: this\.db as unknown as D1Database, BUSINESS_ID: claimed \} as Env, claimed\)/.test(objSrc), 'every request a business\'s object serves runs with the three shared stores confined to that business');
  check(!/scopeBindings/.test(idxSrc), 'the Worker\'s own pipeline is not scoped (without objects nothing changes)');
};
