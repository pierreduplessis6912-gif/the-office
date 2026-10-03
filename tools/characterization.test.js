// Characterization tests for processOneExtraction (rewrite Phase 2). Run from role-matrix.test.js, the one CI test step.
//
// Every case in tools/cases/*.js is run through the REAL function (see tools/harness.js) and what it returns, which
// rows it wrote, and which notes/files/vectors it touched are compared with the recording in tools/golden/<group>.json.
// This is the equivalence matrix the rewritten handlers must reproduce. When behaviour is changed ON PURPOSE:
//     GOLDEN_UPDATE=1 node tools/role-matrix.test.js
// regenerates the recordings, and the diff of the golden file in the commit IS the review of the behaviour change.
module.exports = async function runCharacterization({ check, bundleTo, srcDir, fs, path, sameJson }) {
  const { loadProcessor, runCase } = require('./harness.js');
  const workerDir = path.join(srcDir, '..');
  const casesDir = path.join(__dirname, 'cases');
  const goldenDir = path.join(__dirname, 'golden');
  const update = process.env.GOLDEN_UPDATE === '1';
  const auth = bundleTo('auth.ts', 'rm-char-auth.js');
  const caps = { owner: auth.ROLE_CAPABILITIES.owner, accountant: auth.ROLE_CAPABILITIES.accountant, installer: auth.ROLE_CAPABILITIES.installer, stranger: [] };
  const processOne = await loadProcessor(workerDir);

  const firstDifference = (a, b, where = '') => {
    if (JSON.stringify(a) === JSON.stringify(b)) return null;
    if (a && b && typeof a === 'object' && typeof b === 'object') {
      for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
        const d = firstDifference(a[k], b[k], `${where}.${k}`);
        if (d) return d;
      }
    }
    return `${where}: recorded ${JSON.stringify(b)?.slice(0, 120)} but now ${JSON.stringify(a)?.slice(0, 120)}`;
  };

  const groups = fs.readdirSync(casesDir).filter((f) => f.endsWith('.js')).sort().map((f) => f.replace(/\.js$/, ''));
  check(groups.length >= 1, 'there must be at least one characterization group');
  for (const group of groups) {
    const specs = require(path.join(casesDir, group + '.js'))(caps);
    const actual = {};
    for (const spec of specs) {
      const r = await runCase(processOne, workerDir, spec);
      actual[spec.name] = { result: r.result, threw: r.threw, aiCalls: r.aiCalls, backgroundErrors: r.backgroundErrors, writes: r.writes, effects: r.effects };
    }
    const file = path.join(goldenDir, group + '.json');
    if (update) {
      fs.mkdirSync(goldenDir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(actual, null, 1) + '\n');
      console.log(`GOLDEN_UPDATE: wrote ${path.relative(path.join(__dirname, '..'), file)} (${specs.length} cases)`);
      continue;
    }
    check(fs.existsSync(file), `no recording for group "${group}": run GOLDEN_UPDATE=1 node tools/role-matrix.test.js, review the file, and commit it`);
    if (!fs.existsSync(file)) continue;
    const golden = JSON.parse(fs.readFileSync(file, 'utf8'));
    check(sameJson(Object.keys(actual).sort(), Object.keys(golden).sort()), `group "${group}": the cases run and the cases recorded must be the same set`);
    for (const spec of specs) {
      const a = actual[spec.name], g = golden[spec.name];
      check(a.threw === null, `${group} / ${spec.name}: the function must not throw (it threw: ${a.threw})`);
      check(a.backgroundErrors.length === 0, `${group} / ${spec.name}: no background task may fail (${a.backgroundErrors.join('; ')})`);
      const d = g ? firstDifference(a, g) : 'no recording for this case';
      check(d === null, `${group} / ${spec.name}: behaviour changed from the recording at ${d}`);
    }
  }
};
