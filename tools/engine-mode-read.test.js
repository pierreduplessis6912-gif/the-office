// The app must be able to ask which mode the signed-in business is in (docs/decisions/app-connection.md, decision 2, approved by Pierre 2026-11-14). TESTS FIRST.
// GET /auth/me (already answered in both modes, no business data) carries `mode`: "engine" or "legacy". A signed-out caller learns nothing about the mode. Nothing is written.
const kit = require('./engine-kit.js');

module.exports = kit.guard('engine mode read', async ({ check }) => {
  const asEngine = await kit.route({ method: 'GET', path: '/auth/me', role: 'owner', seed: kit.asEngineBusiness() });
  check(asEngine.result && asEngine.result.status === 200 && asEngine.result.body.signedIn === true, `signed in on an engine business: 200 signedIn (got ${asEngine.result && asEngine.result.status})`);
  check(asEngine.result && asEngine.result.body.mode === 'engine', `an engine business says mode "engine" (got ${asEngine.result && JSON.stringify(asEngine.result.body.mode)})`);
  const asLegacy = await kit.route({ method: 'GET', path: '/auth/me', role: 'owner' });
  check(asLegacy.result && asLegacy.result.body.signedIn === true && asLegacy.result.body.mode === 'legacy', `a legacy business says mode "legacy" (got ${asLegacy.result && JSON.stringify(asLegacy.result.body.mode)})`);
  check(asLegacy.result && asLegacy.result.body.email && asLegacy.result.body.role, 'the existing fields (email, role) are unchanged');
  check(!(asEngine.writes && Object.keys(asEngine.writes).length) && !(asLegacy.writes && Object.keys(asLegacy.writes).length), 'reading the mode writes nothing');
  const out = await kit.route({ method: 'GET', path: '/auth/me', noSession: true, seed: kit.asEngineBusiness() });
  check(out.result && out.result.body.signedIn === false && !('mode' in out.result.body), `a signed-out caller is told nothing about the mode (got ${out.result && JSON.stringify(out.result.body)})`);
});

if (require.main === module) kit.standalone(module.exports);
