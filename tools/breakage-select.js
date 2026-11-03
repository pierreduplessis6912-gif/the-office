// Which mutations the breakage runner (tools/engine-breakage.js) runs. Pure, so it is tested without running anything (tools/breakage-runner.test.js).
//   --only <text>   keep mutations whose name, suite or file contains the text (case-insensitive); repeatable (a union)
//   --since <ref>   keep mutations whose target file (or an extra file of a compound mutation) changed since the git ref, or whose suite's TEST file changed (those tests must still catch them)
//   --list          print the selection and run nothing
//   --keep          keep the isolated copy afterwards (to look at it)
// --only and --since together narrow (an intersection). No filter selects everything. Each selected mutation keeps its ORIGINAL number.
function parseArgs(argv) {
  const o = { only: [], since: null, list: false, keep: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], value = () => { if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw new Error(`${a} needs a value`); return argv[++i]; };
    if (a === '--only') o.only.push(value());
    else if (a === '--since') o.since = value();
    else if (a === '--list') o.list = true;
    else if (a === '--keep') o.keep = true;
    else throw new Error(`unknown option ${a} (use --only <text>, --since <git ref>, --list, --keep)`);
  }
  return o;
}
function select(mutations, opts, changed = []) {
  const files = new Set(changed.map((f) => f.replace(/\\/g, '/')));
  return mutations.map((mutation, index) => ({ mutation, index })).filter(({ mutation: m }) => {
    const text = `${m.name}\n${m.suite}\n${m.file}`.toLowerCase();
    if (opts.only.length && !opts.only.some((t) => text.includes(t.toLowerCase()))) return false;
    if (opts.since) {
      const touched = [m.file, ...(m.also || []).map((e) => e.file)].some((f) => files.has(f)) || files.has(`tools/${m.suite}`);
      if (!touched) return false;
    }
    return true;
  });
}
module.exports = { parseArgs, select };
