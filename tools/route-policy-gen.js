// Regenerates tools/route-policy.json and ROUTE_POLICY.md from the real gate. Run after a deliberate change to who may call what, then review the diff.
const path = require('path'), fs = require('fs');
const lib = require('./route-policy-lib.js');
const srcDir = path.join(__dirname, '..', 'worker', 'src'), workerDir = path.join(srcDir, '..');
lib.observe(srcDir, workerDir).then((rows) => {
  fs.writeFileSync(path.join(__dirname, 'route-policy.json'), JSON.stringify(rows, null, 1) + '\n');
  fs.writeFileSync(path.join(__dirname, '..', 'ROUTE_POLICY.md'), lib.toMarkdown(rows));
  console.log(`wrote ${rows.length} routes`);
}).catch((e) => { console.error(e); process.exit(1); });
