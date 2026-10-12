// The shared directory (worker/src/directory.ts), architecture stage 2b: which email belongs to which business. It is the only data every business shares, so it must be strict: one business per
// email, never silently moved, validated names, and a READ never creates anything.
const path = require('path'), fs = require('fs'), os = require('os'), esbuild = require('esbuild');
const { DatabaseSync } = require('node:sqlite');

module.exports = async function runDirectoryTests({ check, srcDir }) {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dir-')), 'directory.js');
  esbuild.buildSync({ entryPoints: [path.join(srcDir, 'directory.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent' });
  const d = require(out);
  const db = new DatabaseSync(':memory:');
  const env = { OFFICE_DB: { prepare: (sql) => { const st = (binds) => ({ bind: (...b) => st(b), first: async () => db.prepare(sql).get(...binds) ?? null, all: async () => ({ results: db.prepare(sql).all(...binds) }), run: async () => db.prepare(sql).run(...binds) }); return st([]); } } };
  const tables = () => db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);

  check(['alpha-co', 'a1b', 'zulu-flooring-and-blinds'].every(d.isBusinessId) && ['ab', '-abc', 'abc-', 'ABC', 'a b c', 'a'.repeat(41), '', null, undefined, 42, 'x/../y'].every((v) => !d.isBusinessId(v)), 'a business id is 3 to 40 lower-case letters, digits and hyphens, not starting or ending with a hyphen (it becomes part of an object\'s name, so it is validated everywhere)');
  check(d.objectNameFor('alpha-co') === 'business-alpha-co' && d.normaliseEmail('  A@X.Co ') === 'a@x.co', 'an object is named from its business, and emails are compared lower-case');
  check((await d.lookupBusinessForEmail(env, 'a@x.co')) === null && (await d.listDirectory(env)).businesses.length === 0 && tables().length === 0, 'with no directory yet, a lookup finds nothing and a READ creates nothing');

  check((await d.createBusiness(env, 'alpha-co', 'Alpha Flooring')).created === true && (await d.createBusiness(env, 'alpha-co', 'Alpha Flooring')).created === false, 'a business is created once; creating it again is a harmless no-op');
  const bad = async (fn) => { try { await fn(); return null; } catch (e) { return String(e.message); } };
  check(/3 to 40/.test(await bad(() => d.createBusiness(env, 'Bad Id!', 'x'))) && /needs a name/.test(await bad(() => d.createBusiness(env, 'gamma-co', '   '))), 'an invalid id or a missing name is refused');
  await d.createBusiness(env, 'beta-co', 'Beta Blinds');
  check((await d.addDirectoryMember(env, 'Owner@Alpha.CO', 'alpha-co')).added === true && (await d.lookupBusinessForEmail(env, 'owner@alpha.co')) === 'alpha-co' && (await d.lookupBusinessForEmail(env, ' OWNER@ALPHA.CO ')) === 'alpha-co', 'a member is added, and found whatever the case or spacing of the email');
  check((await d.addDirectoryMember(env, 'owner@alpha.co', 'alpha-co')).added === false, 'adding the same member to the same business again is a no-op');
  check(/already belongs to another business/.test(await bad(() => d.addDirectoryMember(env, 'owner@alpha.co', 'beta-co'))) && (await d.lookupBusinessForEmail(env, 'owner@alpha.co')) === 'alpha-co', 'an email already in one business is NEVER moved to another (that would hand one business\'s member to a different business)');
  check(/no such business/.test(await bad(() => d.addDirectoryMember(env, 'x@y.co', 'nobody-co'))) && /valid email/.test(await bad(() => d.addDirectoryMember(env, 'not-an-email', 'alpha-co'))) && /valid business id/.test(await bad(() => d.addDirectoryMember(env, 'x@y.co', 'Bad Id'))), 'a member can only be added to a business that exists, with a real email');
  await d.addDirectoryMember(env, 'sipho@alpha.co', 'alpha-co'); await d.addDirectoryMember(env, 'ben@beta.co', 'beta-co');
  const listing = await d.listDirectory(env);
  check(listing.businesses.length === 2 && listing.businesses.find((b) => b.id === 'alpha-co').members === 2 && listing.businesses.find((b) => b.id === 'beta-co').members === 1 && !JSON.stringify(listing).includes('@'), 'the listing counts members per business and never shows an email address');
  check((await d.lookupBusinessForEmail(env, 'ben@beta.co')) === 'beta-co' && (await d.lookupBusinessForEmail(env, 'stranger@nowhere.co')) === null, 'each member finds their own business, and a stranger finds none');
  db.prepare("UPDATE businesses SET status = 'suspended' WHERE id = 'beta-co'").run();
  check((await d.lookupBusinessForEmail(env, 'ben@beta.co')) === null && (await d.lookupBusinessForEmail(env, 'owner@alpha.co')) === 'alpha-co', 'a suspended business cannot be signed in to, and the others are unaffected');
  check(/PRIMARY KEY/i.test(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'directory_members'").get().sql) && /email TEXT PRIMARY KEY/i.test(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'directory_members'").get().sql), 'the database itself enforces one business per email (the email is the primary key), not just the code');
};
