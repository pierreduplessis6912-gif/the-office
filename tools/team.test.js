// An owner managing their own team from the app (worker/src/team.ts and the /team routes; SHIP_CHECKLIST.md item 15). Until now only an operator, by workflow, could add a person. Decided with Pierre 2026-10-17: an owner adds people by
// email (direct add first; invite-and-accept comes next), can give any role including a co-owner, and there is no team-size cap on a trial. Adding a person is a SIGN-IN grant, so every way it must say no is tested: the rules on real SQLite
// (one database for the business's memberships, one for the shared directory), then the routes as each role.
const path = require('path'), fs = require('fs'), os = require('os'), esbuild = require('esbuild');
const { DatabaseSync } = require('node:sqlite');

module.exports = async function runTeamTests(context) {
  const standIn = global.Response;
  if (global.__RealResponse) global.Response = global.__RealResponse;
  try { await teamTests(context); } finally { global.Response = standIn; }
};

async function teamTests({ check, srcDir }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-')), entry = path.join(dir, 'entry.ts'), out = path.join(dir, 'team.js'), at = (f) => JSON.stringify(path.join(srcDir, f));
  fs.writeFileSync(entry, `export * from ${at('team')};\nexport { ensureDirectory, createBusiness, addDirectoryMember, lookupBusinessForEmail, upsertInvitation, listInvitationsFor, pendingInvitationsForEmail } from ${at('directory')};\nexport * from ${at('team-log')};\n`);
  try { esbuild.buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent' }); } catch (e) { check(false, 'team.ts exists and builds: ' + String(e.message).split('\n')[0].slice(0, 160)); return; }
  const t = require(out), src = (f) => fs.readFileSync(path.join(srcDir, f), 'utf8');
  const shim = (db) => ({ prepare: (sql) => { const st = (binds) => ({ bind: (...b) => st(b), first: async () => db.prepare(sql).get(...binds) ?? null, all: async () => ({ results: db.prepare(sql).all(...binds) }), run: async () => db.prepare(sql).run(...binds) }); return st([]); } });

  // A business 'acme-co' with its owner, and another business 'other-co' that already has someone. obj = the business's own memberships; shared = the directory.
  const world = async (extra = {}) => {
    const obj = new DatabaseSync(':memory:'), shared = new DatabaseSync(':memory:');
    obj.exec("CREATE TABLE memberships (id INTEGER PRIMARY KEY AUTOINCREMENT, google_email TEXT NOT NULL UNIQUE, role TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', invited_by TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), character_id INTEGER)");
    const env = { OFFICE_DB: shim(obj), SHARED_DB: shim(shared), BUSINESS_ID: 'acme-co', ...extra }, sh = { OFFICE_DB: env.SHARED_DB };
    await t.ensureDirectory(sh); await t.createBusiness(sh, 'acme-co', 'Acme Co'); await t.createBusiness(sh, 'other-co', 'Other Co');
    obj.prepare("INSERT INTO memberships (google_email, role, status) VALUES ('boss@acme.co', 'owner', 'active')").run(); await t.addDirectoryMember(sh, 'boss@acme.co', 'acme-co');
    await t.addDirectoryMember(sh, 'elsewhere@other.co', 'other-co');
    return { obj, shared, env, sh, members: () => obj.prepare('SELECT id, google_email, role, status, invited_by FROM memberships ORDER BY id').all(), dir: (e) => shared.prepare('SELECT business_id FROM directory_members WHERE email = ?').get(e)?.business_id ?? null };
  };
  const BOSS = 'boss@acme.co';

  // ---- listing ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  { const w = await world(); const l = await t.listTeam(w.env); check(l.members.length === 1 && l.members[0].email === BOSS && l.members[0].role === 'owner' && l.members[0].status === 'active' && JSON.stringify(l.roles) === JSON.stringify(t.ASSIGNABLE_ROLES), 'the team list shows each member (email, role, status) and the roles an owner may give'); }
  check(JSON.stringify(t.ASSIGNABLE_ROLES) === JSON.stringify(['owner', 'admin', 'accountant', 'sales', 'installer']), 'the roles an owner may give are owner (a co-owner), admin, accountant, sales and installer');

  // ---- adding a person ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  {
    const w = await world(); const r = await t.addTeamMember(w.env, BOSS, '  Sipho.Dlamini@Gmail.com ', 'installer');
    check(r.ok === true && r.status === 201 && r.member.email === 'sipho.dlamini@gmail.com' && r.member.role === 'installer' && r.member.status === 'active', 'an owner adds someone by email and role: the address is tidied, the member is active');
    const row = w.members()[1];
    check(w.members().length === 2 && row.google_email === 'sipho.dlamini@gmail.com' && row.invited_by === BOSS && w.dir('sipho.dlamini@gmail.com') === 'acme-co', 'the membership records WHO added them, and the directory sends that address to THIS business: they can sign in');
    check((await t.lookupBusinessForEmail(w.sh, 'Sipho.Dlamini@gmail.com')) === 'acme-co', 'and the sign-in lookup finds it whatever the case');
    const co = await t.addTeamMember(w.env, BOSS, 'partner@acme.co', 'owner'); check(co.ok === true && co.member.role === 'owner', 'an owner can add a CO-OWNER (decided with Pierre)');
    for (const role of ['accountant', 'installer', 'admin', 'sales']) check((await t.addTeamMember(w.env, BOSS, `${role}@acme.co`, role)).ok === true, `a ${role} can be added`);
    check((await t.addTeamMember(w.env, BOSS, 'six@acme.co', 'installer')).ok && (await t.addTeamMember(w.env, BOSS, 'seven@acme.co', 'installer')).ok && (await t.addTeamMember(w.env, BOSS, 'eight@acme.co', 'installer')).ok && w.members().length === 10, 'there is NO cap on the team (decided with Pierre: none on a trial)');
  }
  {
    const w = await world(); const before = JSON.stringify(w.members());
    for (const [label, email, role] of [['no email', undefined, 'installer'], ['an empty email', '', 'installer'], ['no @', 'sipho.acme.co', 'installer'], ['two @', 'a@b@acme.co', 'installer'], ['no dot in the domain', 'sipho@acme', 'installer'], ['a space inside', 'si pho@acme.co', 'installer'], ['255 characters', 'a'.repeat(64) + '@' + 'b'.repeat(186) + '.com', 'installer'], ['a 65-character local part', 'a'.repeat(65) + '@acme.co', 'installer'], ['an email that is not text', 42, 'installer'], ['an email that is a list', ['a@b.co'], 'installer']]) { const r = await t.addTeamMember(w.env, BOSS, email, role); check(r.ok === false && r.status === 400 && /email/i.test(r.error), `refused (400): ${label}`); }
    for (const [label, role] of [['no role', undefined], ['an empty role', ''], ['one that does not exist', 'superadmin'], ['in capitals', 'OWNER'], ['plural', 'installers'], ['a command', 'owner;rm'], ['not text', 7]]) { const r = await t.addTeamMember(w.env, BOSS, 'new@acme.co', role); check(r.ok === false && r.status === 400 && /role/i.test(r.error), `refused (400): the role ${label}`); }
    check(JSON.stringify(w.members()) === before && w.dir('new@acme.co') === null, 'and none of those refusals wrote anything');
    const noBiz = await world({ BUSINESS_ID: undefined }); const nb = await t.addTeamMember(noBiz.env, BOSS, 'new@acme.co', 'installer'); check(nb.ok === false && nb.status === 500 && noBiz.members().length === 1, 'outside a business\'s own object (no business id) nothing is added, and it says so plainly');
  }
  {
    const w = await world(); await t.addTeamMember(w.env, BOSS, 'sam@acme.co', 'accountant');
    const dup = await t.addTeamMember(w.env, BOSS, 'SAM@acme.co', 'installer');
    check(dup.ok === false && dup.status === 409 && /already on your team/.test(dup.error) && /accountant/.test(dup.error) && w.members().length === 2 && w.members()[1].role === 'accountant', 'someone already on the team is refused (409), with their role, and their role is NOT changed by a second add');
    w.obj.prepare("UPDATE memberships SET status = 'inactive' WHERE google_email = 'sam@acme.co'").run();
    const back = await t.addTeamMember(w.env, BOSS, 'sam@acme.co', 'accountant'); check(back.ok === false && back.status === 409 && /deactivated/.test(back.error) && /reactivate/i.test(back.error), 'someone who was DEACTIVATED is told so, and pointed at reactivating them');
    const taken = await t.addTeamMember(w.env, BOSS, 'elsewhere@other.co', 'installer');
    check(taken.ok === false && taken.status === 409 && /belongs to another business/.test(taken.error) && !/other-co|Other Co/.test(JSON.stringify(taken)) && w.members().length === 2 && w.dir('elsewhere@other.co') === 'other-co', 'an address that belongs to ANOTHER business is refused (409) without saying which, and nothing is written or moved');
  }
  {
    // a failure writing the directory part way: the membership exists, and a retry completes it (no orphan, no stuck state)
    const w = await world(); let armed = true; const real = w.env.SHARED_DB.prepare;
    w.env.SHARED_DB = { prepare: (sql) => { if (armed && /INSERT INTO directory_members/.test(sql)) { armed = false; throw new Error('the directory could not be written'); } return real(sql); } };
    const first = await t.addTeamMember(w.env, BOSS, 'retry@acme.co', 'installer');
    check(first.ok === false && first.status === 500 && !/directory could not/.test(first.error) && w.dir('retry@acme.co') === null, 'when the directory cannot be written the owner sees a plain refusal (no internals), and the person cannot sign in yet');
    const second = await t.addTeamMember(w.env, BOSS, 'retry@acme.co', 'installer');
    check((second.ok === true || (second.status === 409 && /already on your team/.test(second.error))) && w.dir('retry@acme.co') === 'acme-co' && w.members().filter((m) => m.google_email === 'retry@acme.co').length === 1, 'the RETRY completes it: exactly one membership, and the directory now sends them here');
  }

  // ---- changing a role -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  {
    const w = await world(); const a = await t.addTeamMember(w.env, BOSS, 'sam@acme.co', 'installer'); const id = a.member.id;
    const c = await t.changeTeamRole(w.env, BOSS, id, 'accountant'); check(c.ok === true && c.member.role === 'accountant' && w.members()[1].role === 'accountant', 'an owner can change a member\'s role');
    check((await t.changeTeamRole(w.env, BOSS, id, 'accountant')).ok === true && (await t.changeTeamRole(w.env, BOSS, id, 'owner')).ok === true && w.members()[1].role === 'owner', 'changing to the same role is harmless, and a member can be made a co-owner');
    const bossRow = w.members()[0];
    for (const [label, call, status, why] of [['an owner by the app', () => t.changeTeamRole(w.env, 'partner@acme.co', bossRow.id, 'installer'), 403, /owner/i], ['yourself', () => t.changeTeamRole(w.env, 'sam@acme.co', id, 'installer'), 403, /your own/i], ['someone who is not there', () => t.changeTeamRole(w.env, BOSS, 9999, 'installer'), 404, /no such/i], ['to a role that does not exist', () => t.changeTeamRole(w.env, BOSS, id, 'superadmin'), 400, /role/i], ['with an id that is not a number', () => t.changeTeamRole(w.env, BOSS, 'x', 'installer'), 400, /member/i], ['with no role', () => t.changeTeamRole(w.env, BOSS, id, undefined), 400, /role/i]]) { const r = await call(); check(r.ok === false && r.status === status && why.test(r.error), `refused (${status}): changing ${label}`); }
    check(w.members()[0].role === 'owner', 'an owner\'s role is never changed through the app (only the operator can: a co-owner cannot demote or remove the owner who started the business)');
  }

  // ---- deactivating and reactivating --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  {
    const w = await world(); const a = await t.addTeamMember(w.env, BOSS, 'sam@acme.co', 'installer'), id = a.member.id;
    const d = await t.setTeamMemberStatus(w.env, BOSS, id, false); check(d.ok === true && d.member.status === 'inactive' && w.members()[1].status === 'inactive' && w.dir('sam@acme.co') === 'acme-co', 'an owner deactivates a member: the membership is inactive (they cannot act) and the directory still holds their address (it stays bound to this business)');
    check((await t.setTeamMemberStatus(w.env, BOSS, id, false)).ok === true, 'deactivating twice is harmless');
    const r = await t.setTeamMemberStatus(w.env, BOSS, id, true); check(r.ok === true && r.member.status === 'active' && w.members()[1].status === 'active', 'and reactivating brings them back');
    const bossId = w.members()[0].id, co = (await t.addTeamMember(w.env, BOSS, 'partner@acme.co', 'owner')).member.id;
    for (const [label, call, status] of [['an owner', () => t.setTeamMemberStatus(w.env, 'partner@acme.co', bossId, false), 403], ['yourself', () => t.setTeamMemberStatus(w.env, BOSS, bossId, false), 403], ['a co-owner', () => t.setTeamMemberStatus(w.env, BOSS, co, false), 403], ['someone who is not there', () => t.setTeamMemberStatus(w.env, BOSS, 9999, false), 404], ['with an id that is not a number', () => t.setTeamMemberStatus(w.env, BOSS, 'x', false), 400]]) { const x = await call(); check(x.ok === false && x.status === status, `refused (${status}): deactivating ${label}`); }
    check(w.members().filter((m) => m.role === 'owner').every((m) => m.status === 'active'), 'owners can never be deactivated through the app, so a business can never be left with no owner, and a co-owner cannot lock the first one out');
  }

  // ---- invitations: the owner's side (the person accepts on sign-in: signup.test.js) ------------------------------------------------------------------------------------------------------------------------------------------------
  // "Both modes" (Pierre): adding directly gives access at once; an INVITATION waits in the shared directory until the person signs in with that Google account and accepts. Nothing about the team changes until they do.
  {
    const w = await world(); const r = await t.inviteTeamMember(w.env, BOSS, '  Thandi@Gmail.com ', 'accountant');
    const inv = w.shared.prepare('SELECT email, business_id, role, invited_by, status, expires_at FROM invitations').all();
    check(r.ok === true && r.status === 201 && r.invitation.email === 'thandi@gmail.com' && r.invitation.role === 'accountant' && r.invitation.invitedBy === BOSS && inv.length === 1 && inv[0].status === 'pending' && inv[0].business_id === 'acme-co', 'an owner invites someone by email and role: the address is tidied and a PENDING invitation for THIS business waits in the shared directory');
    const days = (Date.parse(inv[0].expires_at.replace(' ', 'T') + 'Z') - Date.now()) / 86400000; check(days > 29.9 && days < 30.1, 'it expires in 30 days');
    check(w.members().length === 1 && w.dir('thandi@gmail.com') === null, 'and NOTHING about the team changes yet: no membership, no directory entry, so the person cannot get in until they accept');
    const again = await t.inviteTeamMember(w.env, BOSS, 'thandi@gmail.com', 'installer');
    check(again.ok === true && again.status === 200 && w.shared.prepare('SELECT COUNT(*) n FROM invitations').get().n === 1 && w.shared.prepare('SELECT role FROM invitations').get().role === 'installer', 're-inviting the same person REFRESHES the one invitation (a new role, a new 30 days) instead of piling up another');
    const l = await t.listTeam(w.env); check(l.invitations.length === 1 && l.invitations[0].email === 'thandi@gmail.com' && l.invitations[0].role === 'installer' && typeof l.invitations[0].id === 'number' && typeof l.invitations[0].expiresAt === 'string', 'the team list shows the pending invitation (who, role, when it expires), so an owner can see a mistyped address and revoke it');
    const other = await world(); await t.upsertInvitation({ OFFICE_DB: other.env.SHARED_DB }, 'x@y.co', 'other-co', 'installer', 'someone'); check((await t.listTeam(other.env)).invitations.length === 0, 'and a business sees ONLY its own invitations');
    const rev = await t.revokeTeamInvitation(w.env, BOSS, l.invitations[0].id); check(rev.ok === true && (await t.listTeam(w.env)).invitations.length === 0 && (await t.pendingInvitationsForEmail({ OFFICE_DB: w.env.SHARED_DB }, 'thandi@gmail.com')).length === 0, 'an owner REVOKES an invitation: it disappears from the list and the person can no longer accept it');
  }
  {
    const w = await world(); const before = () => JSON.stringify([w.members(), w.shared.prepare('SELECT COUNT(*) n FROM invitations').get().n]);
    await t.addTeamMember(w.env, BOSS, 'sam@acme.co', 'installer'); const b0 = before();
    for (const [label, email, role, status, why] of [['no email', undefined, 'installer', 400, /email/i], ['a bad email', 'nope', 'installer', 400, /email/i], ['no role', 'a@b.co', undefined, 400, /role/i], ['a role that does not exist', 'a@b.co', 'superadmin', 400, /role/i], ['someone already on the team', 'SAM@acme.co', 'installer', 409, /already on your team/]]) { const r = await t.inviteTeamMember(w.env, BOSS, email, role); check(r.ok === false && r.status === status && why.test(r.error), `an invitation is refused (${status}): ${label}`); }
    check(before() === b0, 'and none of those refusals wrote anything');
    // NEUTRAL: an address that belongs to ANOTHER business is invited exactly like any other, and the owner learns nothing about it either way (refusing it used to reveal that the person already has an account)
    const free = await t.inviteTeamMember(w.env, BOSS, 'free.person@gmail.com', 'installer'), bound = await t.inviteTeamMember(w.env, BOSS, 'elsewhere@other.co', 'installer');
    const shape = (r) => JSON.stringify(Object.keys(r.invitation).sort()) + r.status + r.ok;
    check(free.ok === true && bound.ok === true && shape(free) === shape(bound) && !/other-co|Other Co|another business|belongs/i.test(JSON.stringify(bound)) && w.shared.prepare("SELECT COUNT(*) n FROM invitations WHERE email = 'elsewhere@other.co'").get().n === 1, 'an address in ANOTHER business is invited NEUTRALLY: the same answer as for any free address (nothing about it is revealed), and it is only ever shown to them if they are eligible to take it');
    check(w.dir('elsewhere@other.co') === 'other-co' && w.members().length === 2, 'and the invitation changes nothing: that address stays bound to its business, and the team is unchanged');
    const direct = await t.addTeamMember(w.env, BOSS, 'elsewhere@other.co', 'installer'); check(direct.ok === false && direct.status === 409 && /belongs to another business/.test(direct.error) && /invitation/i.test(direct.error), 'a DIRECT add of that address is still refused, and now points at inviting them instead');
    w.obj.prepare("UPDATE memberships SET status = 'inactive' WHERE google_email = 'sam@acme.co'").run(); const d = await t.inviteTeamMember(w.env, BOSS, 'sam@acme.co', 'installer'); check(d.ok === false && d.status === 409 && /deactivated/.test(d.error), 'someone who was DEACTIVATED is told to reactivate them, not invited again');
    const nb = await world({ BUSINESS_ID: undefined }); check((await t.inviteTeamMember(nb.env, BOSS, 'a@b.co', 'installer')).status === 500, 'outside a business\'s own object nothing is invited');
    const taken = await t.inviteTeamMember(w.env, BOSS, 'elsewhere@other.co', 'installer'); check(!/other-co|Other Co/.test(JSON.stringify(taken)), 'and the refusal never says which business holds the address');
    for (const [label, id, status] of [['an id that is not a number', 'x', 400], ['an unknown invitation', 9999, 404]]) { const r = await t.revokeTeamInvitation(w.env, BOSS, id); check(r.ok === false && r.status === status, `revoking ${label} is refused (${status})`); }
    // both businesses' invitations in the SAME directory: the only situation where the business check matters
    const oi = await t.upsertInvitation(w.sh, 'z@y.co', 'other-co', 'installer', 'x');
    check((await t.revokeTeamInvitation(w.env, BOSS, oi.id)).status === 404 && w.shared.prepare("SELECT status FROM invitations WHERE id = ?").get(oi.id).status === 'pending', 'one business can NEVER revoke another business\'s invitation, even in the same directory (it looks like it does not exist, and stays pending)');
  }
  {
    const w = await world(); const sh = { OFFICE_DB: w.env.SHARED_DB }; await t.upsertInvitation(sh, 'old@y.co', 'acme-co', 'installer', BOSS); w.shared.prepare("UPDATE invitations SET expires_at = datetime('now', '-1 minute')").run();
    check((await t.listTeam(w.env)).invitations.length === 0 && (await t.pendingInvitationsForEmail(sh, 'old@y.co')).length === 0, 'an EXPIRED invitation is not listed and cannot be accepted');
    const re = await t.inviteTeamMember(w.env, BOSS, 'old@y.co', 'installer'); const days = (Date.parse(w.shared.prepare('SELECT expires_at FROM invitations').get().expires_at.replace(' ', 'T') + 'Z') - Date.now()) / 86400000; check(re.ok && days > 29.9, 'and inviting them again gives them a fresh 30 days');
  }

  // ---- the TEAM LOG and the SIGN-IN stamp (worker/src/team-log.ts) ------------------------------------------------------------------------------------------------------------------------------------------------------------
  // Who added, invited, changed and removed whom, and when each person last signed in. Both live in tables that create themselves on first use (the precedent of permission_audit), written AFTER the change they describe, and a failure to
  // write one never fails the owner's action. An action that is REFUSED leaves no trace, so the log only ever says what actually happened.
  const audit = (w) => w.obj.prepare('SELECT actor, action, target, detail FROM team_audit ORDER BY id').all();
  {
    const w = await world(); check((await t.listTeam(w.env)).activity.length === 0 && (await t.listTeam(w.env)).members.every((m) => m.lastSignInAt === null && m.signInCount === 0), 'a business that has never logged anything lists an empty activity and "never signed in" for everyone, without crashing (the tables do not exist yet)');
    check(w.obj.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name IN ('team_audit', 'member_sign_ins')").get().n === 0, 'and READING never creates the tables');
    const add = await t.addTeamMember(w.env, BOSS, 'sam@acme.co', 'installer'); const id = add.member.id;
    await t.inviteTeamMember(w.env, BOSS, 'invitee@gmail.com', 'accountant'); const inv = (await t.listTeam(w.env)).invitations[0].id;
    await t.changeTeamRole(w.env, BOSS, id, 'sales'); await t.setTeamMemberStatus(w.env, BOSS, id, false); await t.setTeamMemberStatus(w.env, BOSS, id, true); await t.revokeTeamInvitation(w.env, BOSS, inv);
    check(JSON.stringify(audit(w).map((r) => [r.actor, r.action, r.target])) === JSON.stringify([[BOSS, 'added', 'sam@acme.co'], [BOSS, 'invited', 'invitee@gmail.com'], [BOSS, 'role_changed', 'sam@acme.co'], [BOSS, 'deactivated', 'sam@acme.co'], [BOSS, 'reactivated', 'sam@acme.co'], [BOSS, 'invitation_withdrawn', 'invitee@gmail.com']]), 'every change is logged in order with WHO did it and to WHOM: added, invited, role changed, deactivated, reactivated, invitation withdrawn (the withdrawn one names the person, not an id)');
    const d = audit(w); check(JSON.parse(d[0].detail).role === 'installer' && JSON.parse(d[1].detail).role === 'accountant' && JSON.parse(d[2].detail).from === 'installer' && JSON.parse(d[2].detail).to === 'sales', 'with the role given, and for a role change what it was and what it became');
    const l = await t.listTeam(w.env); check(l.activity.length === 6 && l.activity[0].action === 'invitation_withdrawn' && l.activity[5].action === 'added' && typeof l.activity[0].at === 'string' && l.activity[0].actor === BOSS && l.activity[0].target === 'invitee@gmail.com' && l.activity[3].action === 'role_changed' && l.activity[3].detail.from === 'installer' && l.activity[3].detail.to === 'sales', 'the team list carries the activity NEWEST FIRST with when, who, what and to whom');
    check(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(l.activity[0].at) && l.activity[0].id > l.activity[5].id && typeof l.activity[3].detail === 'object', 'each entry has a time (UTC, to the second) and its detail already parsed');
  }
  {
    const w = await world(); await t.addTeamMember(w.env, BOSS, 'sam@acme.co', 'installer'); const before = JSON.stringify(audit(w)), id = (await t.listTeam(w.env)).members[1].id;
    for (const r of [await t.addTeamMember(w.env, BOSS, 'sam@acme.co', 'installer'), await t.addTeamMember(w.env, BOSS, 'nope', 'installer'), await t.addTeamMember(w.env, BOSS, 'x@y.co', 'superadmin'), await t.inviteTeamMember(w.env, BOSS, 'sam@acme.co', 'installer'), await t.inviteTeamMember(w.env, BOSS, 'bad', 'installer'), await t.changeTeamRole(w.env, BOSS, 1, 'installer'), await t.changeTeamRole(w.env, BOSS, 9999, 'installer'), await t.changeTeamRole(w.env, BOSS, id, 'superadmin'), await t.setTeamMemberStatus(w.env, BOSS, 1, false), await t.setTeamMemberStatus(w.env, BOSS, 9999, false), await t.revokeTeamInvitation(w.env, BOSS, 9999), await t.revokeTeamInvitation(w.env, BOSS, 'x')]) check(r.ok === false, 'a refused action returns a refusal (setup for the next check)');
    check(JSON.stringify(audit(w)) === before, 'and NONE of the refused actions left a trace: the log only says what actually happened');
    const noop = await t.changeTeamRole(w.env, BOSS, id, 'installer'); check(JSON.stringify(audit(w)) === before || audit(w).length === 1, 'changing a role to the one it already is is not logged as a change');
    const heal = await t.addTeamMember(w.env, BOSS, 'sam@acme.co', 'installer'); check(audit(w).filter((r) => r.action === 'added').length === 1, 'and adding someone who is already there (even finishing a half-done add) is not logged twice');
  }
  {
    const w = await world(); let fail = true; const real = w.env.OFFICE_DB.prepare; w.env.OFFICE_DB = { ...w.env.OFFICE_DB, prepare: (sql) => { if (fail && /team_audit/.test(sql) && /INSERT/.test(sql)) throw new Error('the log could not be written'); return real(sql); } };
    const r = await t.addTeamMember(w.env, BOSS, 'sam@acme.co', 'installer'); check(r.ok === true && w.members().length === 2, 'if the log cannot be written the owner\'s action STILL succeeds (an audit failure must never stop the business working)'); fail = false;
  }
  {
    const w = await world(); await t.recordSignIn(w.env, '  Boss@Acme.co '); const a = (await t.listTeam(w.env)).members[0];
    check(a.lastSignInAt && a.signInCount === 1 && a.firstSignInAt === a.lastSignInAt, 'a sign-in is recorded against the member (the address is tidied): first and last are the same, and the count is one');
    w.obj.prepare("UPDATE member_sign_ins SET first_at = '2026-01-01 08:00:00', last_at = '2026-01-01 08:00:00'").run(); await t.recordSignIn(w.env, BOSS); const b = (await t.listTeam(w.env)).members[0];
    check(b.signInCount === 2 && b.firstSignInAt === '2026-01-01 08:00:00' && b.lastSignInAt !== '2026-01-01 08:00:00', 'signing in again moves LAST and counts it, and never touches FIRST');
    await t.addTeamMember(w.env, BOSS, 'sam@acme.co', 'installer'); const l = await t.listTeam(w.env); check(l.members.find((m) => m.email === 'sam@acme.co').lastSignInAt === null && l.members.find((m) => m.email === 'sam@acme.co').signInCount === 0, 'someone added who has NEVER signed in shows exactly that: no time, count zero (what an owner needs to spot a mistyped address)');
    await t.recordSignIn(w.env, 'stranger@nowhere.co'); check((await t.listTeam(w.env)).members.length === 2 && w.obj.prepare("SELECT COUNT(*) n FROM member_sign_ins WHERE email = 'stranger@nowhere.co'").get().n === 0, 'a sign-in for an address that is not on the team records NOTHING (no row, and it never adds anyone)');
    let threw = false; try { await t.recordSignIn({ OFFICE_DB: { prepare: () => { throw new Error('no database'); } } }, BOSS); } catch { threw = true; } check(threw === false, 'a sign-in that cannot be recorded never throws (it must never block signing in)');
  }
  {
    const w = await world(); for (let i = 0; i < 40; i++) w.obj.exec(`CREATE TABLE IF NOT EXISTS team_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL DEFAULT (datetime('now')), actor TEXT, action TEXT NOT NULL, target TEXT, detail TEXT); INSERT INTO team_audit (actor, action, target) VALUES ('boss@acme.co', 'added', 'p${i}@x.co')`);
    const l = await t.listTeam(w.env); check(l.activity.length === 30 && l.activity[0].target === 'p39@x.co', 'the team list carries the latest 30 events, newest first');
  }

  // ---- the routes, as each role ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const harness = require('./harness.js'), workerDir = path.join(srcDir, '..'), fns = await harness.loadFunctions(workerDir);
  // Each route case gets its OWN shared directory (as production has: a separate database) that already knows the business, so adding a person works as it does there.
  const route = async (spec) => { const sharedDb = new DatabaseSync(':memory:'), sh = { OFFICE_DB: shim(sharedDb) }; await t.ensureDirectory(sh); await t.createBusiness(sh, 'acme-co', 'Acme Co'); for (const e of ['owner@example.com', ...(spec.dirMembers || [])]) await t.addDirectoryMember(sh, e, 'acme-co'); return harness.runRouteCase(fns, workerDir, { kind: 'route', env: { BUSINESS_ID: 'acme-co', SHARED_DB: sh.OFFICE_DB }, ...spec }); };
  const roles = ['owner', 'accountant', 'installer'], calls = [['GET', '/team', undefined], ['POST', '/team', { email: 'x@y.co', role: 'installer' }], ['PATCH', '/team/1', { role: 'installer' }], ['POST', '/team/1/deactivate', {}], ['POST', '/team/1/reactivate', {}], ['POST', '/team/invite', { email: 'x@y.co', role: 'installer' }], ['POST', '/team/invitations/1/revoke', {}]];
  for (const [method, p, body] of calls) for (const role of ['accountant', 'installer', 'sales', 'admin']) { const r = await route({ name: `${method} ${p} as ${role}`, method, path: p, body, role }); check(r.result.status === 403, `${method} ${p} is refused to an ${role} (403): team management is for owners only`); }
  const noSession = await route({ name: 'no session', method: 'GET', path: '/team', noSession: true }); check(noSession.result.status === 401, 'and to someone not signed in (401)');
  const list = await route({ name: 'owner lists', method: 'GET', path: '/team', role: 'owner' });
  check(list.result.status === 200 && list.result.body.members.some((m) => m.email === 'owner@example.com' && m.role === 'owner') && JSON.stringify(list.result.body.roles) === JSON.stringify(t.ASSIGNABLE_ROLES), 'the owner reads the team list over the route');
  const add = await route({ name: 'owner adds', method: 'POST', path: '/team', body: { email: 'New.Person@Gmail.com', role: 'accountant' }, role: 'owner' });
  check(add.result.status === 201 && add.result.body.member.email === 'new.person@gmail.com' && add.result.body.member.role === 'accountant' && add.result.body.member.invitedBy === 'owner@example.com', 'the owner adds a person over the route (201), and the membership records WHO added them (the session\'s address)');
  check((await route({ name: 'bad email', method: 'POST', path: '/team', body: { email: 'nope', role: 'installer' }, role: 'owner' })).result.status === 400 && (await route({ name: 'no body', method: 'POST', path: '/team', role: 'owner' })).result.status === 400, 'a bad email, or no body at all, is a 400, never a crash');
  const dup = await route({ name: 'add an existing member', method: 'POST', path: '/team', body: { email: 'accountant@example.com', role: 'installer' }, role: 'owner', dirMembers: ['accountant@example.com'] }); check(dup.result.status === 409, 'adding someone already on the team is a 409 over the route');
  const healed = await route({ name: 'complete a half-done add', method: 'POST', path: '/team', body: { email: 'accountant@example.com', role: 'accountant' }, role: 'owner' }); check(healed.result.status === 200 && healed.result.body.healed === true && healed.result.body.member.email === 'accountant@example.com', 'a member whose directory entry is MISSING (an earlier add stopped part way) is completed by adding them again: 200 with healed true, not an error');
  const deact = await route({ name: 'deactivate', method: 'POST', path: '/team/3/deactivate', body: {}, role: 'owner' }); check(deact.result.status === 200 && deact.result.body.member.status === 'inactive', 'the owner deactivates a member over the route');
  const roleChange = await route({ name: 'change role', method: 'PATCH', path: '/team/3', body: { role: 'accountant' }, role: 'owner' }); check(roleChange.result.status === 200 && roleChange.result.body.member.role === 'accountant', 'and changes a role over the route');
  const self = await route({ name: 'deactivate self', method: 'POST', path: '/team/1/deactivate', body: {}, role: 'owner' }); check(self.result.status === 403, 'but cannot deactivate themselves over the route (403; over the route that is always an owner, who is protected as an owner too, so the "yourself" rule itself is proved in the module tests above)');
  const bad = await route({ name: 'bad id', method: 'PATCH', path: '/team/99999', body: { role: 'installer' }, role: 'owner' }); check(bad.result.status === 404, 'an unknown member is a 404');
  const invite = await route({ name: 'owner invites', method: 'POST', path: '/team/invite', body: { email: 'Invited.Person@Gmail.com', role: 'installer' }, role: 'owner' });
  check(invite.result.status === 201 && invite.result.body.invitation.email === 'invited.person@gmail.com' && invite.result.body.invitation.invitedBy === 'owner@example.com', 'the owner invites a person over the route (201), and the invitation records who invited them');
  check((await route({ name: 'invite bad', method: 'POST', path: '/team/invite', body: { email: 'nope', role: 'installer' }, role: 'owner' })).result.status === 400 && (await route({ name: 'invite no body', method: 'POST', path: '/team/invite', role: 'owner' })).result.status === 400, 'a bad email, or no body, is a 400 over the invite route');
  const listed = await route({ name: 'list shows invitations', method: 'GET', path: '/team', role: 'owner', before: [{ route: true, method: 'POST', path: '/team/invite', body: { email: 'listed@gmail.com', role: 'accountant' }, role: 'owner' }] });
  check(listed.result.status === 200 && Array.isArray(listed.result.body.invitations), 'the team list carries an invitations list');
  check((await route({ name: 'revoke unknown', method: 'POST', path: '/team/invitations/9999/revoke', body: {}, role: 'owner' })).result.status === 404, 'revoking an unknown invitation over the route is a 404');


  // ---- how it is wired ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const auth = src('auth.ts'), idx = src('index.ts');
  check(/\{ method: "POST", path: \/\^\\\/team\\\/invite\$\/, anyOf: \["can_invite_members"\] \}/.test(auth) && /\{ method: "POST", path: \/\^\\\/team\\\/invitations\\\/\\d\+\\\/revoke\$\/, anyOf: \["can_invite_members"\] \}/.test(auth), 'both invitation routes are gated by can_invite_members (owner only)');
  check(/\{ method: "GET", path: \/\^\\\/team\$\/, anyOf: \["can_invite_members"\] \}/.test(auth) && /\{ method: "POST", path: \/\^\\\/team\$\/, anyOf: \["can_invite_members"\] \}/.test(auth) && /\{ method: "PATCH", path: \/\^\\\/team\\\/\\d\+\$\/, anyOf: \["can_invite_members"\] \}/.test(auth) && /\\\/team\\\/\\d\+\\\/\(deactivate\|reactivate\)/.test(auth), 'every team route is gated by can_invite_members, which only an owner holds and which can never be granted to another role');
  check(/key: "can_invite_members", label: "Invite members", description: "Owner only\.", inUse: true, ownerOnly: true/.test(auth), 'and that capability is now marked IN USE (the codebase requires a capability the code checks to be marked, deliberately); its description is unchanged and it stays owner only and not editable');
  check(/url\.pathname === "\/team" && request\.method === "GET"/.test(idx) && /resolveCapabilities\(request, env\)/.test(idx.slice(idx.indexOf('url.pathname === "/team" && request.method === "POST"'), idx.indexOf('url.pathname === "/team" && request.method === "POST"') + 600)), 'the handlers learn WHO is acting from the session (so "yourself" and "who invited them" are real)');
};
