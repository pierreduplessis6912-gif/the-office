// TITLES in person matching (worker/src/identity.ts, nameCore and reconcilePerson). Found live 2026-10-26: "Mr Buitendacht" was held as "could match more than one person" with nobody of that name on file, because the first WORD (the title) was what got matched. What this pins: (1) a title is not a name: two people who share a title no longer collide; (2) the title is still respected: a titled name is never AUTO-matched on a surname alone, because "Mr Nkosi" and "Mrs Nkosi" are two people; (3) everything that was exact, phonetic or whole-word before is unchanged for an untitled name.
const path = require('path'), fs = require('fs'), os = require('os'), esbuild = require('esbuild');

module.exports = async function runTitleTests({ check, srcDir }) {
  const bundle = (entry) => { const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mk-')), 'm.js'); esbuild.buildSync({ entryPoints: [path.join(srcDir, entry)], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent' }); return require(out); };
  let idn, D1;
  try { idn = bundle('identity.ts'); D1 = bundle('storage/do-d1.ts').DoD1Database; } catch (e) { check(false, 'identity.ts builds: ' + String(e.message).split('\n')[0].slice(0, 160)); return; }
  const { newDatabase } = require('./harness.js'); const plain = (r) => (r ? { ...r } : r);
  const shim = (db) => { const sql = { exec(query, ...binds) { const s = db.prepare(query); if (/^\s*(select|with|pragma|values)\b/i.test(query) || /\breturning\b/i.test(query)) { const rows = s.all(...binds).map(plain); return { toArray: () => rows, rowsRead: rows.length, rowsWritten: 0 }; } const r = s.run(...binds); return { toArray: () => [], rowsRead: 0, rowsWritten: Number(r.changes) }; } }; const storage = { transactionSync(fn) { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } } }; return new D1(sql, storage); };
  const world = (names) => { const db = newDatabase(path.join(srcDir, '..')); db.exec('PRAGMA foreign_keys = OFF'); for (const n of names) db.prepare('INSERT INTO people (name) VALUES (?)').run(n); return { db, env: { OFFICE_DB: shim(db) } }; };
  const who = async (w, name, options) => { const r = await idn.reconcilePerson(w.env, name, options); return r === null ? null : r.status + (r.candidates ? ':' + r.candidates.map((c) => c.name).sort().join('|') : r.name ? ':' + r.name : ''); };

  // ---- nameCore ----
  { const c = (n) => JSON.stringify(idn.nameCore(n));
    check(c('Mr Buitendacht') === '{"title":"Mr","core":["Buitendacht"]}' && c('Dr. Van der Walt') === '{"title":"Dr.","core":["Van","der","Walt"]}' && c('MRS pretorius') === '{"title":"MRS","core":["pretorius"]}' && c('Prof Dr Naidoo') === '{"title":"Prof Dr","core":["Naidoo"]}' && c('  Mr   Botha  ') === '{"title":"Mr","core":["Botha"]}' && c('Mnr Jansen') === '{"title":"Mnr","core":["Jansen"]}' && c('Mev. Jansen') === '{"title":"Mev.","core":["Jansen"]}', 'a leading title (any case, with or without a full stop, several in a row) is taken off, the rest is the name');
    check(c('Mr') === '{"title":null,"core":["Mr"]}' && c('Buitendacht') === '{"title":null,"core":["Buitendacht"]}' && c('Hendrik Buitendacht') === '{"title":null,"core":["Hendrik","Buitendacht"]}' && c('Jan Mr') === '{"title":null,"core":["Jan","Mr"]}' && c('Mr Mrs') === '{"title":"Mr","core":["Mrs"]}' && c('Doctor Who') === '{"title":null,"core":["Doctor","Who"]}' && c('Mrx Smith') === '{"title":null,"core":["Mrx","Smith"]}', 'a lone title stays itself, a title anywhere but the front is part of the name, and a word that only STARTS like a title is not one'); }

  // ---- (1) a title is not a name: the bug ----
  { const w = world(['Mr Botha', 'Mrs Dlamini', 'Dr Van der Walt', 'Pierre du Plessis', 'Alfons']); const out = {}; for (const n of ['Mr Buitendacht', 'Mrs Pretorius', 'Dr Smith', 'Mr Nkosi', 'Prof Naidoo', 'Mev Jansen', 'Mr. Buitendacht', 'MR BUITENDACHT', 'dr. smith', 'Prof Dr Naidoo', 'Mnr Pretorius']) out[n] = await who(w, n);
    check(Object.values(out).every((v) => v === 'new'), 'a titled name nobody on file shares is NEW, whoever else on file shares its title (found live: "Mr Buitendacht" held against "Mr ..." people): ' + JSON.stringify(out)); }

  // ---- (2) the title is still respected ----
  { const w = world(['Mrs Nkosi', 'Hendrik Buitendacht', 'Jan van Wyk', 'Dr Van der Walt']);
    const r = { a: await who(w, 'Mr Nkosi'), b: await who(w, 'Mr Buitendacht'), c: await who(w, 'Mr Van der Walt'), d: await who(w, 'Dr Nkosi'), e: await who(w, 'Mr. Nkosi') };
    check(r.a === 'ambiguous:Mrs Nkosi' && r.b === 'ambiguous:Hendrik Buitendacht' && r.d === 'ambiguous:Mrs Nkosi' && r.e === 'ambiguous:Mrs Nkosi' && r.c.startsWith('ambiguous:') && r.c.includes('Dr Van der Walt'), 'a titled name that shares its SURNAME with someone on file is held for a human, never auto-matched ("Mr Nkosi" is not "Mrs Nkosi"): ' + JSON.stringify(r)); }
  { const w = world(['Hendrik Buitendacht']); const a = await who(w, 'Buitendacht'), b = await who(w, 'Mr Buitendacht');
    check(a === 'matched:Hendrik Buitendacht' && b === 'ambiguous:Hendrik Buitendacht', 'an UNTITLED long unique surname still matches as it always did, while the titled one is asked about'); }

  // ---- (3) exact and untitled behaviour unchanged ----
  { const w = world(['Mr Botha', 'Sipho Dube', 'Jan van Wyk', 'Alfons', 'Pierre du Plessis']);
    const r = { exact: await who(w, 'Mr Botha'), lower: await who(w, 'mr botha'), upper: await who(w, 'ALFONS'), short: await who(w, 'Jan'), phon: await who(w, 'Sepo'), none: await who(w, 'Thandeka'), full: await who(w, 'Pierre du Plessis'), sipho: await who(w, 'Sipho') };
    check(r.exact === 'matched:Mr Botha' && r.lower === 'matched:Mr Botha' && r.upper === 'matched:Alfons' && r.short === 'ambiguous:Jan van Wyk' && r.phon === 'ambiguous:Sipho Dube' && r.none === 'new' && r.full === 'matched:Pierre du Plessis' && r.sipho === 'ambiguous:Sipho Dube', 'an exact name (any case), a short first name, a sound-alike and a new name behave exactly as before: ' + JSON.stringify(r)); }

  // ---- phonetic, with titles ----
  { const w = world(['Mr Sipho', 'Mr Botha']); const r = { sound: await who(w, 'Mr Sepo'), sound2: await who(w, 'Mrs Sepo'), other: await who(w, 'Mr Smith'), plain: await who(w, 'Sepo') };
    check(r.sound === 'ambiguous:Mr Sipho' && r.sound2 === 'ambiguous:Mr Sipho' && r.plain === 'ambiguous:Mr Sipho' && r.other === 'new', 'the sound-alike pass compares the NAMES, not the titles: "Mr Sepo" is asked about "Mr Sipho", but "Mr Smith" is not "Mr Botha": ' + JSON.stringify(r)); }
  { const w = world(['Mr Mortimer', 'Mr Botha']); const r = await who(w, 'Mr Mortimer'), t = await who(w, 'Mr Marais');
    check(r === 'matched:Mr Mortimer' && t === 'new', 'two names that begin with the same letter as "Mr" are not confused with it'); }

  // ---- a lone title ----
  { const w = world(['Mr Botha']); let r; try { r = await who(w, 'Mr'); } catch (e) { r = 'threw: ' + e.message; }
    check(!String(r).startsWith('threw'), 'a lone "Mr" does not crash it (' + r + ')'); }

  // ---- suppliers only ----
  { const w = world(['Mr Botha', 'Mr Smith']); const cols = w.db.prepare("PRAGMA table_info(characters)").all().map((c) => c.name);
    const r = await who(w, 'Mr Buitendacht', { relationship: 'supplier' });
    check(r === 'new', 'the suppliers-only match understands titles too');
    check(cols.length > 0, 'the characters table exists for the suppliers-only match'); }
};
