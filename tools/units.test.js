// Tests for per-item unit conversion (decided 2026-10-04): the unit normaliser, the conversion store and its maths run against a
// REAL SQLite database, the delivery check, and a guard that the test seeds create the same table the code does.
module.exports = async function runUnitTests({ check, bundleTo, srcDir, fs, path, sameJson }) {
  const { normalizeUnit, unitsDiffer, unitPlural, setUnitConversion, convertQuantity, checkDeliveryUnits, deliveryUnitQuestion, conversionNote, listUnitConversions, forgetUnitConversions, describeConversion, unitConversionsAnswer, checkStockUnit } = bundleTo('finance.ts', 'rm-units-finance.js');
  const { newDatabase, d1 } = require('./harness.js');
  const workerDir = path.join(srcDir, '..');

  // ---- 1. What counts as a unit, and what counts as two different units ------------------------------------
  const same = [['sqm', 'sqm'], ['Square Metres', 'sqm'], ['square meter', 'sqm'], ['m2', 'sqm'], ['m\u00b2', 'sqm'], ['sq. m', 'sqm'], ['sq metres', 'sqm'], ['  Square   metres ', 'sqm'], ['boxes', 'box'], ['Box', 'box'], ['ctn', 'box'], ['carton', 'box'], ['bags', 'bag'], ['rolls', 'roll'], ['lengths', 'length'], ['litres', 'litre'], ['L', 'litre'], ['kilograms', 'kg'], ['tins', 'tin'], ['packets', 'pack'], ['pallets', 'pallet'], ['linear metres', 'metre'], ['m', 'metre'], ['pcs', 'each']];
  for (const [raw, canonical] of same) check(normalizeUnit(raw) === canonical, `the unit "${raw}" reads as "${canonical}" (got ${normalizeUnit(raw)})`);
  for (const raw of ['bundle', 'tonne', 'whatever', '', '   ', null, undefined]) check(normalizeUnit(raw) === null, `${JSON.stringify(raw)} is not a unit this table recognises`);
  const differs = [['sqm', 'square metres', false], ['box', 'sqm', true], ['boxes', 'bags', true], ['sqm', 'm2', false], ['m', 'sqm', true], ['bundle', 'sqm', false], [null, 'sqm', false], ['box', null, false], ['bundle', 'tonne', false]];
  for (const [a, b, e] of differs) check(unitsDiffer(a, b) === e, `units "${a}" and "${b}": ${e ? 'different' : 'not known to differ'} (an unrecognised or missing unit never blocks a delivery)`);
  check(unitPlural('box') === 'boxes' && unitPlural('sqm') === 'sqm' && unitPlural('kg') === 'kg' && unitPlural('metre') === 'metres', 'a unit reads correctly after "in" ("in boxes", "in sqm")');

  // ---- 2. The conversion store and its maths, against a real database ----------------------------------------
  const fresh = () => ({ OFFICE_DB: d1(newDatabase(workerDir)) });
  let env = fresh();
  const first = await setUnitConversion(env, 'Laminate', 'boxes', 'square metres', 2.2, 'owner@example.com');
  check(first.from === 'box' && first.to === 'sqm' && first.factor === 2.2 && first.replaced === null, 'setting a conversion normalises both units and reports nothing replaced the first time');
  let r = await convertQuantity(env, 'laminate', 10, 'boxes', 'sqm');
  check(r.ok && r.quantity === 22 && r.factor === 2.2, '10 boxes of laminate are 22 sqm');
  r = await convertQuantity(env, 'Laminate', 22, 'sqm', 'box');
  check(r.ok && r.quantity === 10, 'and the same conversion works the other way round (22 sqm are 10 boxes)');
  r = await convertQuantity(env, 'laminate', 7, 'Square Metres', 'sqm');
  check(r.ok && r.quantity === 7 && r.factor === null, 'the same unit written two ways needs no conversion at all');
  r = await convertQuantity(env, 'laminate', 3, 'bundle', 'sqm');
  check(r.ok && r.quantity === 3, 'a unit that is not recognised passes through unchanged instead of failing');
  r = await convertQuantity(env, 'grout', 10, 'box', 'sqm');
  check(r.ok === false, 'an item with no conversion cannot be converted (it is reported, never guessed)');
  r = await convertQuantity(env, 'laminate', 5, 'bag', 'sqm');
  check(r.ok === false, 'and a conversion between a different pair of units is not borrowed');
  const again = await setUnitConversion(env, 'laminate', 'box', 'sqm', 2.4, 'accountant@example.com');
  check(again.replaced === 2.2, 'saying it again reports what it replaced');
  r = await convertQuantity(env, 'laminate', 10, 'box', 'sqm');
  check(r.ok && r.quantity === 24, 'and the new number is the one used');
  await setUnitConversion(env, 'laminate', 'sqm', 'box', 0.5, null);
  const left = await env.OFFICE_DB.prepare("SELECT from_unit, to_unit, factor FROM unit_conversions WHERE item_key = 'laminate'").all();
  check(left.results.length === 1 && left.results[0].from_unit === 'sqm' && left.results[0].factor === 0.5, 'a conversion the other way round replaces the opposite one, so the two can never contradict each other');
  r = await convertQuantity(env, 'laminate', 10, 'sqm', 'box');
  check(r.ok && r.quantity === 5, 'and the survivor is the one used');
  env = fresh();
  await setUnitConversion(env, 'laminate', 'box', 'sqm', 2.2, null);
  await setUnitConversion(env, 'quickstep laminate', 'box', 'sqm', 3, null);
  r = await convertQuantity(env, 'Quickstep laminate', 10, 'box', 'sqm');
  check(r.ok && r.quantity === 30, 'a conversion for the whole name beats one for a word inside it');
  r = await convertQuantity(env, 'Pergo laminate', 10, 'box', 'sqm');
  check(r.ok && r.quantity === 22, 'a conversion for "laminate" applies to "Pergo laminate"');
  r = await convertQuantity(env, 'laminated board', 10, 'box', 'sqm');
  check(r.ok === false, '...but not to a different word that merely starts the same ("laminated")');
  r = await convertQuantity(env, 'Quickstep', 10, 'box', 'sqm');
  check(r.ok === false, '...and a shorter name does not borrow a longer name\'s conversion');
  env = fresh();
  await setUnitConversion(env, 'vinyl', 'box', 'sqm', 3, null);
  r = await convertQuantity(env, 'vinyl', 0.1, 'box', 'sqm');
  check(r.ok && r.quantity === 0.3, 'a fraction of a box converts without floating-point noise');
  r = await convertQuantity(env, 'vinyl', 1, 'sqm', 'box');
  check(r.ok && Math.abs(r.quantity - 0.3333) < 1e-9, 'a third of a box is rounded to four places');

  // ---- 3. The delivery check -----------------------------------------------------------------------------------
  env = fresh();
  await setUnitConversion(env, 'vinyl', 'box', 'sqm', 2.5, null);
  const outstanding = [
    { poId: 1, poLineId: 1, description: 'Vinyl', ordered: 50, received: 0, writtenOff: 0, outstanding: 50, unit: 'sqm' },
    { poId: 1, poLineId: 2, description: 'Underlay', ordered: 100, received: 0, writtenOff: 0, outstanding: 100, unit: 'sqm' },
    { poId: 1, poLineId: 3, description: 'Adhesive', ordered: 5, received: 0, writtenOff: 0, outstanding: 5, unit: null },
  ];
  const lines = [
    { matched_description: 'Vinyl', item_description: 'vinyl', unit: 'boxes', quantity_received: 20 },
    { matched_description: 'Underlay', item_description: 'underlay', unit: 'square metres', quantity_received: 40 },
    { matched_description: 'Adhesive', item_description: 'adhesive', unit: 'tubes', quantity_received: 3 },
    { matched_description: null, item_description: 'grout', unit: 'bags', quantity_received: 4 },
  ];
  let chk = await checkDeliveryUnits(env, outstanding, lines);
  check(chk.unconverted.length === 0 && chk.converted.length === 1, 'one line is converted; same-unit, no-order-unit and not-on-the-order lines are left alone and nothing is unconverted');
  check(chk.lines[0].quantity_received === 50 && chk.lines[0].unit === 'sqm', 'the converted line carries the order\'s unit and the converted quantity');
  check(chk.lines[1].quantity_received === 40 && chk.lines[2].unit === 'tubes' && chk.lines[3].unit === 'bags', 'the other lines pass through untouched');
  check(lines[0].quantity_received === 20 && lines[0].unit === 'boxes', 'the caller\'s own lines are never modified');
  chk = await checkDeliveryUnits(env, outstanding, [{ matched_description: 'Underlay', item_description: 'underlay', unit: 'rolls', quantity_received: 8 }, { matched_description: 'underlay', item_description: 'underlay', unit: 'rolls', quantity_received: 2 }]);
  check(chk.unconverted.length === 1 && chk.unconverted[0].item === 'Underlay' && chk.unconverted[0].deliveredUnit === 'roll' && chk.unconverted[0].orderedUnit === 'sqm', 'an item with no conversion is reported once, however many lines mention it');
  const q = deliveryUnitQuestion('Floornet', chk.unconverted);
  check(/Nothing was recorded from Floornet/.test(q) && /ordered in sqm but this delivery is in rolls/.test(q) && /a roll of Underlay is 2\.2 sqm/.test(q), 'the question says nothing was recorded, names both units, and shows how to answer');
  check(/20 boxes of Vinyl counted as 50 sqm/.test(conversionNote([{ item: 'Vinyl', quantity: 20, from: 'boxes', to: 'sqm', result: 50 }])) && conversionNote([]) === '', 'the note says what was counted as what, and nothing when nothing was converted');

  // ---- 3b. Seeing and removing conversions (decided 2026-10-04) --------------------------------------------------
  env = fresh();
  check(sameJson(await listUnitConversions(env), []), 'with nothing saved the list is empty (and the table is created on first look)');
  await setUnitConversion(env, 'Laminate', 'box', 'sqm', 2.2, null);
  await setUnitConversion(env, 'Quickstep laminate', 'box', 'sqm', 3, null);
  await setUnitConversion(env, 'Underlay', 'roll', 'sqm', 15, null);
  let all = await listUnitConversions(env);
  check(all.length === 3 && sameJson(all.map((c) => c.item), ['laminate', 'quickstep laminate', 'underlay']), 'the list is every saved conversion, in order of item name');
  check(sameJson((await listUnitConversions(env, 'laminate')).map((c) => c.item), ['laminate', 'quickstep laminate']), 'asking about "laminate" shows both the laminate and the quickstep laminate conversions');
  check(sameJson((await listUnitConversions(env, 'Quickstep laminate')).map((c) => c.item), ['laminate', 'quickstep laminate']), 'and asking about "Quickstep laminate" shows the plain laminate conversion that would apply to it too');
  check((await listUnitConversions(env, 'grout')).length === 0, 'a material with no conversion lists nothing');
  check(describeConversion(all[2]) === '1 roll of underlay = 15 sqm', 'a conversion reads as "1 roll of underlay = 15 sqm"');
  check(unitConversionsAnswer(all, null) === 'Unit conversions: 1 box of laminate = 2.2 sqm; 1 box of quickstep laminate = 3 sqm; 1 roll of underlay = 15 sqm.', 'the answer lists them all');
  check(/No unit conversions are saved yet/.test(unitConversionsAnswer([], null)) && /No unit conversion is saved for grout/.test(unitConversionsAnswer([], 'grout')), 'and says how to save one when there are none');
  let gone = await forgetUnitConversions(env, 'Laminate');
  check(gone.forgotten.length === 1 && gone.forgotten[0].item === 'laminate' && gone.similar.length === 0, 'forgetting "Laminate" forgets exactly the laminate conversion (case does not matter)');
  all = await listUnitConversions(env);
  check(sameJson(all.map((c) => c.item), ['quickstep laminate', 'underlay']), 'and does NOT touch "quickstep laminate", which merely contains the word');
  gone = await forgetUnitConversions(env, 'laminate');
  check(gone.forgotten.length === 0 && sameJson(gone.similar.map((c) => c.item), ['quickstep laminate']), 'forgetting a name that is not saved deletes nothing and shows what is saved under similar names');
  gone = await forgetUnitConversions(env, 'grout');
  check(gone.forgotten.length === 0 && gone.similar.length === 0, 'forgetting something never saved deletes nothing and finds nothing similar');
  r = await convertQuantity(env, 'laminate', 10, 'box', 'sqm');
  check(r.ok === false, 'once forgotten, a delivery of that item has no conversion again (it asks, as it did before one was saved)');

  // ---- 3c. A quantity said in another unit about stock kept in one (decided 2026-10-04) --------------------------------
  env = fresh();
  await setUnitConversion(env, 'laminate', 'box', 'sqm', 2.2, null);
  const lam = { name: 'Laminate', unit: 'sqm' };
  let su = await checkStockUnit(env, lam, 'boxes', 3);
  check(su.ok && su.quantity === 6.6 && /3 boxes of Laminate counted as 6\.6 sqm/.test(su.note), '3 boxes of laminate kept in sqm are 6.6 sqm, and the note says what was counted as what');
  su = await checkStockUnit(env, lam, 'square metres', 5);
  check(su.ok && su.quantity === 5 && su.note === '', 'the same unit written another way needs no conversion and no note');
  su = await checkStockUnit(env, lam, null, 5);
  check(su.ok && su.quantity === 5 && su.note === '', 'no unit said passes through untouched');
  su = await checkStockUnit(env, lam, 'bundles', 2);
  check(su.ok && su.quantity === 2 && su.note === '', 'a unit that is not recognised passes through untouched (it can never block a count)');
  su = await checkStockUnit(env, { name: 'Laminate', unit: null }, 'boxes', 4);
  check(su.ok && su.quantity === 4, 'an item kept with no unit has nothing to convert to');
  su = await checkStockUnit(env, { name: 'Grout', unit: 'bag' }, 'boxes', 4);
  check(su.ok === false && /Nothing was recorded\. Grout is kept in bags but you said boxes, and I don't know how many bags are in a box/.test(su.question) && /a box of Grout is 2\.2 bags/.test(su.question), 'with no conversion known it records nothing, names both units, and says how to answer');
  su = await checkStockUnit(env, lam, 'boxes', 0.5);
  check(su.ok && su.quantity === 1.1, 'a fraction of a box converts');

  // ---- 4. The table the seeds create is the table the code creates ----------------------------------------------
  const norm = (x) => x.replace(/\s+/g, ' ').replace(/\s*;\s*$/, '').trim();
  const code = fs.readFileSync(path.join(srcDir, 'finance.ts'), 'utf8').match(/"(CREATE TABLE IF NOT EXISTS unit_conversions [^"]*)"/);
  check(Boolean(code), 'the code creates the unit_conversions table');
  for (const f of ['stock', 'procurement', 'actions', 'uploads', 'lookups']) {
    const seed = fs.readFileSync(path.join(__dirname, 'cases', f + '.js'), 'utf8').match(/"(CREATE TABLE IF NOT EXISTS unit_conversions [^"]*)"/);
    check(Boolean(seed) && Boolean(code) && norm(seed[1]) === norm(code[1]), `the table the ${f} cases create must be exactly the table the code creates (a drifted seed would test a table the product never has)`);
  }
  // ---- 5. Recording applies the conversion too, so a conversion learned after a hold still counts ---------------
  const finSrc = fs.readFileSync(path.join(srcDir, 'finance.ts'), 'utf8');
  check(/const unitCheck = await checkDeliveryUnits\(env, outstanding, lines\);\s*const classified = classifyGoodsReceivedLines\(unitCheck\.lines/.test(finSrc), 'recordDelivery converts its lines before it classifies them');
};
