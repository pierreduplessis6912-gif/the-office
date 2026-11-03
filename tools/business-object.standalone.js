// Runs tools/business-object.test.js on its own (it normally runs only inside the role-matrix umbrella), so tools/engine-breakage.js can use it as the suite that must fail when the object's identity check is removed.
let pass = 0, fail = 0;
const check = (ok, msg) => { if (ok) pass++; else { fail++; console.log('FAIL ' + String(msg).slice(0, 300)); } };
require('./business-object.test.js')({ check, srcDir: require('path').join(__dirname, '..', 'worker', 'src') })
  .then(() => { console.log(`${pass}/${pass + fail} correct, ${fail} failing`); process.exit(fail ? 1 : 0); })
  .catch((e) => { console.log('CRASH ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e)); process.exit(2); });
