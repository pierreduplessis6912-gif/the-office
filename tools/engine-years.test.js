// Financial years, step P1 (docs/decisions/year-end-close.md): where the year ends, and which year a date is in.
//   setting   a recorded event (owner only), February until one is set; no table; the same month again is refused
//   dates     a year is the twelve months ending on the last day of the year-end month; leap years; December and January year-ends
//   read      the current and previous year as dates, worked out by the ENGINE from the date it is given (the app never does)
const kit = require('./engine-kit.js');

module.exports = kit.guard('engine financial years (P1)', async ({ check }) => {
  const eng = kit.loadEngine();
  const { facts, capabilities, periods, verifyIntegrity } = eng;
  const CTX = { actorEmail: 'owner@example.com', contract: 'test', contractVersion: 1 };
  const codeOf = async (fn) => { try { await fn(); return null; } catch (e) { return e && e.code ? e.code : 'threw:' + String(e && e.message).slice(0, 80); } };

  // ---- the dates ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const fy = periods.financialYearOf;
  check(JSON.stringify(fy('2026-11-16', 2)) === JSON.stringify({ start: '2026-03-01', end: '2027-02-28' }), 'with a February year-end, 16 November 2026 is in the year 1 March 2026 to 28 February 2027');
  check(JSON.stringify(fy('2026-02-10', 2)) === JSON.stringify({ start: '2025-03-01', end: '2026-02-28' }) && JSON.stringify(fy('2026-03-01', 2)) === JSON.stringify({ start: '2026-03-01', end: '2027-02-28' }), 'the last day of February is in the old year and the first of March starts the new one');
  check(fy('2027-06-01', 2).end === '2028-02-29' && fy('2028-02-29', 2).end === '2028-02-29' && fy('2028-02-29', 2).start === '2027-03-01', 'a leap-year February ends on the 29th');
  check(JSON.stringify(fy('2026-11-16', 12)) === JSON.stringify({ start: '2026-01-01', end: '2026-12-31' }) && JSON.stringify(fy('2026-01-01', 12)) === JSON.stringify({ start: '2026-01-01', end: '2026-12-31' }), 'a December year-end is the calendar year');
  check(JSON.stringify(fy('2026-11-16', 1)) === JSON.stringify({ start: '2026-02-01', end: '2027-01-31' }) && JSON.stringify(fy('2026-01-31', 1)) === JSON.stringify({ start: '2025-02-01', end: '2026-01-31' }), 'a January year-end begins on 1 February');
  check(JSON.stringify(periods.previousYear(fy('2026-11-16', 2), 2)) === JSON.stringify({ start: '2025-03-01', end: '2026-02-28' }), 'the previous year ends the day before this one starts');
  let ok = true; for (let m = 1; m <= 12; m++) for (const d of ['2024-01-01', '2024-02-29', '2025-06-15', '2026-12-31', '2027-03-01']) { const y = fy(d, m); const p = periods.previousYear(y, m); if (!(y.start <= d && d <= y.end) || new Date(new Date(y.start + 'T00:00:00Z').getTime() - 86400000).toISOString().slice(0, 10) !== p.end) ok = false; }
  check(ok, 'for every year-end month and a spread of dates: the date is inside its year and the years join end to start with no gap or overlap');

  // ---- the setting -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const w = kit.makeWorld(); w.configure({ currency: 'ZAR' });
  let v = await periods.yearsView(w.env, '2026-11-16');
  check(v.yearEndMonth === 2 && v.yearEndMonthName === 'February' && v.isDefault === true && v.current.end === '2027-02-28' && v.previous.end === '2026-02-28' && v.closed.length === 0, 'until the owner sets it the year ends in February, and the view says so');
  const r = await facts.setYearEnd(w.env, { month: 6, reason: 'we report to the end of June' }, CTX);
  const ev = w.db.prepare('SELECT type, actor_email, reason FROM eng_event WHERE id = ?').get(r.eventId);
  v = await periods.yearsView(w.env, '2026-11-16');
  check(ev.type === 'year_end.set' && ev.actor_email === 'owner@example.com' && ev.reason === 'we report to the end of June' && v.yearEndMonth === 6 && v.isDefault === false && v.current.start === '2026-07-01' && v.current.end === '2027-06-30', 'setting it is one event with who and why, there is no table, and the view follows it');
  const before = JSON.stringify(w.counts());
  check(await codeOf(() => facts.setYearEnd(w.env, { month: 6, reason: null }, CTX)) === 'invalid_state' && JSON.stringify(w.counts()) === before, 'setting the month it already is refused, and writes nothing');
  await facts.setYearEnd(w.env, { month: 2, reason: null }, CTX);
  check((await periods.yearsView(w.env, '2026-11-16')).yearEndMonth === 2 && (await verifyIntegrity(w.env)).ok === true, 'it can be changed back, the latest event is the setting, and the verifier is content');
  const w2 = kit.makeWorld();
  check(await codeOf(() => facts.setYearEnd(w2.env, { month: 2, reason: null }, CTX)) === null, 'choosing February explicitly on a business still on the default is allowed (it makes the choice a recorded fact)');

  // ---- the contract ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const c = capabilities.yearEndSet;
  check(c.validate({ month: 2 }).ok && c.validate({ month: 12, reason: 'x' }).ok && [0, 13, 1.5, '2', null, undefined].every((m) => c.validate({ month: m }).ok === false) && c.validate({ month: 2, extra: 1 }).ok === false && c.validate({ month: 2, reason: 5 }).ok === false && c.validate('Feb').ok === false, 'the contract takes a whole month 1 to 12 and an optional reason, and nothing else');
  check(c.permissions.join() === 'business.manage' && c.heldType === 'engine.year_end.set', 'setting the year-end needs the permission to manage the business, like locking the books');
  const rd = capabilities.ledgerYears;
  check(rd.permissions[0] === 'ledger.read' && rd.validate({ asOf: '2026-11-16' }).ok === true && rd.validate({}).ok === false && rd.validate({ asOf: 'soon' }).ok === false && rd.validate({ asOf: '2026-11-16', x: 1 }).ok === false, 'the years read is for whoever may read the books and needs a real date');
  const AV = ['ledger.years'];
  const via = (role, path) => kit.route({ env: {}, seed: kit.seedReceivables(AV), method: 'GET', path, role });
  const a = await via('accountant', '/engine/ledger/years'), b = await via('sales', '/engine/ledger/years'), d = await via('accountant', '/engine/ledger/years?asOf=2027-03-05');
  check(a.result.status === 200 && a.result.body.result.yearEndMonth === 2 && /^\d{4}-\d{2}-\d{2}$/.test(a.result.body.result.current.start) && b.result.status === 403 && d.result.body.result.current.start === '2027-03-01', 'over HTTP: the engine uses today when no date is given, an explicit date is honoured, and a salesperson is refused');
});

if (require.main === module) kit.standalone(module.exports);
